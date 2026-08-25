/**
 * Stuck-run recovery — the pure logic behind "a run flipped to `stuck` is not
 * necessarily a run that died".
 *
 * Context (measured 2026-08-25, this shift's own executor log window): 46
 * watchdog flips, 42 of them ending in `completeRun` logging "completion
 * yielded to operator status stuck" and discarding a finished turn — >= $83.01
 * of already-paid work thrown away, worst single loss run f874ba1b (132 turns,
 * $15.65). `forge-executor` is a SINGLE fork-mode process
 * (`pm2 jlist | jq '.[]|.pm2_env.exec_mode'`), so `heartbeat()` (every 5s per
 * run) and `stuckWatchdogTick()` are two timers on ONE event loop and ONE pg
 * pool (`db/ai_os.ts`, `max: 5`). When that loop stalls past
 * `HEARTBEAT_STUCK_THRESHOLD_MS` (90s), the two timers race: the watchdog's
 * blind UPDATE can land first and flip `running` -> `stuck` on a run whose
 * claude child is still very much alive and about to finish. Because
 * `heartbeat()` only ever writes `WHERE status = 'running'`
 * (`executor.ts:679`), that flip is a ONE-WAY TRAPDOOR — the live run can
 * never revive itself, and `project-tick.ts`'s settled loop
 * (`run_status !== 'completed'` -> fail the task, block the project) has no
 * way to tell "the watchdog guessed wrong" from "the run really died".
 *
 * On the live DB, ALL 35 stuck rows carried `stuck_signal = 'heartbeat_stale'`
 * — the watchdog's own marker, and a guess about liveness, not a decision.
 * That is the ONLY kind this module resumes. `scripts/ops/safe-restart.sh`
 * has said the underlying truth verbatim all along: "a run can sit in stuck
 * while its process is very much alive and working."
 *
 * Everything here is pure — no database, no `/proc`, no import from
 * `executor.ts` or `project-tick.ts`. Liveness is dependency-injected as a
 * boolean (`sessionProcessAlive()` / `inFlight.has(runId)` live in
 * `executor.ts` and are not re-implemented here). This lets the whole decision
 * table be tested without opening a pg pool or touching `/proc`. The I/O that
 * acts on this module's output lives in `db/runs.ts`
 * (`requeueRunAfterStuck`) and `lib/project-tick.ts` (`deferForStuckRun`).
 */

/**
 * What kind of `stuck_signal` a run carries.
 *
 * `heartbeat_stale` is the watchdog's own guess and the only kind this module
 * recovers. `timeout` is a REAL decision — the wall-clock path
 * (`executor.ts:~900`) — with its own manual Resume path, and it is
 * DELIBERATELY OUT OF SCOPE for this project (PLAN.md §5): widening this fix
 * to cover it would change behaviour nobody measured, and zero of the 35 live
 * stuck rows carry it. Say so here rather than let the next reader think it
 * was an oversight. `unknown` covers anything else — a future signal this
 * module has not been taught, or `null`/malformed data from a hostile or
 * partially-written row.
 */
export type StuckKind = "heartbeat_stale" | "timeout" | "unknown";

/** Read `runs.stuck_signal` (free-text `varchar(64)`) into a closed set. */
export function classifyStuck(stuckSignal: string | null): StuckKind {
  if (stuckSignal === "heartbeat_stale") return "heartbeat_stale";
  if (stuckSignal === "timeout") return "timeout";
  return "unknown";
}

/**
 * How many times ONE run may be resumed under this policy before it is
 * allowed to fail.
 *
 * Two, not one: the first resume covers the ordinary case — the watchdog
 * flipped a run whose process had, by the time project-tick got to it, also
 * genuinely exited (a race on the SAME race that caused the flip). A second
 * resume covers a run that dies for an unrelated reason immediately after
 * being resumed. Beyond that, retrying is indistinguishable from the
 * "already done" redispatch defect this project exists to stop — 7 recorded
 * instances fleet-wide — so give up and let the ordinary failure path run.
 */
export const STUCK_RECOVERY_MAX_ATTEMPTS = 2;

/**
 * What to do with a run sitting in `status = 'stuck'`.
 *
 *   - `hold`   — the process is alive. Do nothing this tick; the turn will
 *                land its own completion once `executor.ts`'s reclaim path
 *                (widening `completeRun`'s guard) exists. Failing the task
 *                now is exactly the defect this project fixes.
 *   - `resume` — the process is gone. Requeue the SAME run row (same
 *                worktree, same session) rather than starting a fresh one —
 *                the resumed agent wakes holding its own transcript and can
 *                see its own commits instead of redoing them.
 *   - `give_up` — fall through to the ordinary failure path: fail the task,
 *                 block the project. This is how the watchdog keeps doing its
 *                 job on a run that is genuinely dead.
 */
export type StuckPlan =
  | { action: "hold"; reason: string }
  | { action: "resume"; attempt: number; reason: string }
  | { action: "give_up"; reason: string };

/**
 * Pure policy: hold, resume, or give up on a run sitting in `status =
 * 'stuck'`.
 *
 * Separated from the DB write so every branch is reachable in a test. The
 * write path (`requeueRunAfterStuck`) re-checks `status = 'stuck' AND
 * stuck_signal = 'heartbeat_stale'` through its own `WHERE` clause, so this
 * being wrong cannot corrupt a row — it can only route the decision wrong,
 * which is precisely the bug being fixed.
 */
export function planStuckRecovery(input: {
  kind: StuckKind;
  processAlive: boolean;
  priorAttempts: number;
}): StuckPlan {
  if (input.kind !== "heartbeat_stale") {
    return {
      action: "give_up",
      reason: `stuck_signal is '${input.kind}', not a watchdog guess — the ordinary failure path applies`,
    };
  }

  if (input.processAlive) {
    return {
      action: "hold",
      reason:
        "process is alive: the watchdog mistook a latency stall for a dead run, the turn will land its own completion",
    };
  }

  // The counter comes from `COALESCE((metadata->>'stuck_recovery_attempts')::int, 0)`
  // — a hostile or corrupt value is not a licence to retry forever. Normalise
  // non-finite and negative values to a floor of 0, same posture as
  // api-overload.ts's priorAttempts handling.
  const prior =
    Number.isFinite(input.priorAttempts) && input.priorAttempts > 0
      ? Math.floor(input.priorAttempts)
      : 0;

  if (prior < STUCK_RECOVERY_MAX_ATTEMPTS) {
    return {
      action: "resume",
      attempt: prior + 1,
      reason: `process is gone, ${prior}/${STUCK_RECOVERY_MAX_ATTEMPTS} recovery attempts used — requeue the same run`,
    };
  }

  return {
    action: "give_up",
    reason: `already resumed ${prior}x for a stale heartbeat (max ${STUCK_RECOVERY_MAX_ATTEMPTS}) — process is still gone`,
  };
}

/**
 * `[Fleet notice]` text appended to a resumed run's thread.
 *
 * Load-bearing sentence: "check what you already committed before redoing
 * anything." This fleet has 7 recorded instances of an agent redoing work
 * that was already complete, and a resumed run wakes in the SAME worktree
 * with its own commits sitting right there — the whole point of resuming the
 * same row instead of starting a fresh one.
 */
export function stuckResumeNote(input: { attempt: number }): string {
  return (
    `[Fleet notice] Your run was flipped to 'stuck' by a false alarm, not by ` +
    `anything you did: the watchdog mistook a latency stall on the executor's ` +
    `own event loop for a dead process, while your turn kept running. Nothing ` +
    `has changed in your worktree since. This is resume attempt ` +
    `${input.attempt}/${STUCK_RECOVERY_MAX_ATTEMPTS}. Before doing anything else, ` +
    `run \`git status\` and \`git log --oneline -8\` in your worktree and check ` +
    `what you already committed — your earlier work is still there. Finish from ` +
    `where you left off; do not redo work that is already done.`
  );
}
