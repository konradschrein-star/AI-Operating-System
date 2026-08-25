/**
 * Run liveness — the instruments that answer "is this run's process actually
 * alive?", and the pure decisions that read them.
 *
 * WHY THIS FILE EXISTS (measured 2026-08-25).
 * `stuckWatchdogTick()` flipped `running` → `stuck` on a stale heartbeat with
 * no liveness check at all, and `heartbeat()` only writes
 * `WHERE id = $1 AND status = 'running'`. So a flip was a ONE-WAY TRAPDOOR: a
 * live turn could never revive its own row, and `completeRun`'s
 * `AND status = 'running'` guard then threw the finished turn away
 * (`completion yielded to operator status stuck`). In the retained executor
 * log window that was 46 flips, 42 discarded completions, ≥ $83.01 of
 * already-paid work — worst single loss run f874ba1b, 132 turns, $15.65.
 *
 * The executor is ONE pm2 fork-mode process, so every `heartbeat()` interval,
 * the watchdog and `projectTick()` are timers on ONE event loop sharing ONE pg
 * pool (`db/ai_os.ts`, max 5). When the loop stalls past
 * HEARTBEAT_STUCK_THRESHOLD_MS the heartbeat and the watchdog come due
 * together and race — which is why "stuck" so often means "very much alive".
 * `scripts/ops/safe-restart.sh:11-13` has said exactly that all along.
 *
 * Everything decision-shaped here is pure and synchronous so it is testable
 * without a database or a procfs (`run-liveness.test.ts`); the only I/O is the
 * single /proc walk.
 */

/**
 * Every `claude` command line currently on this host, read in ONE /proc walk.
 *
 * Reads /proc directly rather than shelling out to ps — no subprocess per
 * check, and it can't be fooled by a pattern that accidentally matches our own
 * command line (a `pkill -f "next build"` once killed the operator's own shell
 * that way).
 *
 * Split out of `sessionProcessAlive()` so the watchdog walks /proc ONCE per
 * tick instead of once per stale candidate: with the spawn cap at 10 that was
 * up to ten full procfs walks inside a tick that only fires because the event
 * loop is already stalling.
 *
 * The "claude" filter is the pre-existing behaviour of `sessionProcessAlive()`
 * and is deliberately unchanged here: agy/Gemini children are NOT recognised
 * as evidence of life, so for those runs the watchdog falls back to the
 * in-process ownership record. Widening it is a behaviour change nobody has
 * measured.
 *
 * KNOW WHAT THIS INSTRUMENT CANNOT SEE (measured 2026-08-25, live /proc).
 * A session id reaches argv only via `claude --resume <id>`. The CLI MINTS the
 * id on a first turn, so a first-turn child's command line is
 * `claude -p --output-format stream-json … --append-system-prompt …` with the
 * id nowhere in it. Checked against the only `running` row on the box: its
 * `cc_session_id` appeared in exactly ONE process's argv on the whole host, and
 * that process was a bash shell, not the engine.
 *
 * So this is a partial instrument, and `ownedInProcess` — not /proc — is the
 * load-bearing one for the case that actually lost the money: the executor is
 * awaiting the turn right now. /proc adds the executor-restarted case, and
 * only for RESUMED turns. Both are one-directional: a `true` is proof of life,
 * a `false` is merely no evidence — which is why `completeRun()`'s reclaim
 * (COMPLETABLE_STATUS_SQL) is the second half of the fix and not an optional
 * belt to this brace.
 *
 * An unreadable /proc yields an EMPTY list, i.e. "no evidence of life", which
 * is the safe direction (a dead run must still be caught) — but it must never
 * be SILENT, or a broken instrument reads exactly like a dead fleet.
 */
export async function readEngineCmdlines(): Promise<string[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch (e) {
    console.warn(
      "[run-liveness] /proc is unreadable " +
        `(${e instanceof Error ? e.message : String(e)}) — no process can be ` +
        "proven alive this tick; every stale run will be treated as dead",
    );
    return [];
  }
  const cmdlines: string[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    if (pid === String(process.pid)) continue;
    let cmd: string;
    try {
      cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // process exited between readdir and read — normal
    }
    // cmdline is NUL-separated; `--resume <id>` therefore appears as two args.
    if (cmd.includes("claude")) cmdlines.push(cmd);
  }
  return cmdlines;
}

/** Is a `claude` process already resuming this session? Thin wrapper over the
 *  one-walk reader above, kept so `processRun`'s "never run two engine
 *  processes against one session" guard needs no change. */
export async function sessionProcessAlive(sessionId: string): Promise<boolean> {
  const cmdlines = await readEngineCmdlines();
  return cmdlines.some((cmd) => cmd.includes(sessionId));
}

/**
 * Which of these session ids has a live engine process, given ONE /proc
 * snapshot. Pure, so the matching rule is testable without a procfs.
 *
 * `null` session ids (a run that never reached `saveCcSession`) are simply
 * absent from the result — there is nothing to match on, which is not the same
 * as "proven dead"; `watchdogVerdict` is where that becomes a decision.
 */
export function liveSessionIdsAmong(
  sessionIds: readonly (string | null)[],
  cmdlines: readonly string[],
): ReadonlySet<string> {
  const live = new Set<string>();
  for (const sid of sessionIds) {
    if (!sid) continue;
    if (live.has(sid)) continue;
    if (cmdlines.some((cmd) => cmd.includes(sid))) live.add(sid);
  }
  return live;
}

export type WatchdogVerdict = "flip" | "hold";

/**
 * The watchdog's decision for ONE stale candidate.
 *
 * `hold` requires POSITIVE evidence of life, from one of exactly two
 * instruments, in this order:
 *  1. `ownedInProcess` — this executor is currently awaiting that turn
 *     (`inFlight.has(runId)` in `loop()`). Free, exact, and the dominant case
 *     for a single fork-mode executor.
 *  2. a live `claude` process carrying the run's `metadata.cc_session_id` —
 *     for a turn this process no longer owns (executor restarted, child
 *     survived).
 *
 * `flip` otherwise, INCLUDING `sessionId === null` with no in-process owner:
 * absence of evidence is the negative case the watchdog exists for, and a run
 * nobody can prove alive must still be caught. There is no timer and no grace
 * period here — liveness is re-proven on every tick, so nothing can hold a
 * dead run open.
 */
export function watchdogVerdict(input: {
  ownedInProcess: boolean;
  sessionId: string | null;
  liveSessionIds: ReadonlySet<string>;
}): WatchdogVerdict {
  if (input.ownedInProcess) return "hold";
  if (input.sessionId !== null && input.liveSessionIds.has(input.sessionId)) {
    return "hold";
  }
  return "flip";
}

/**
 * The precondition on a completion write — ONE definition, interpolated by
 * `executor.ts`'s `completeRun()` and asserted against real Postgres by the
 * dry-run harness, so the two can never drift.
 *
 * WHY 'stuck' IS COMPLETABLE, spelled out because it is the whole fix:
 * `stuck_signal = 'heartbeat_stale'` is written by exactly ONE code path — the
 * watchdog — and it is a GUESS about liveness. A completion arriving from the
 * turn that owns the run is proof the guess was wrong, so the row is reclaimed
 * rather than the work discarded.
 *
 * What still WINS the race, unchanged: every operator status (`paused`,
 * `cancelled`, `failed`, `completed`) is simply not in this predicate, and
 * neither is `stuck_signal = 'timeout'` — the wall-clock path, which is a real
 * decision with its own resume route, not a guess.
 */
export const COMPLETABLE_STATUS_SQL =
  "(status = 'running' OR (status = 'stuck' AND stuck_signal = 'heartbeat_stale'))";
