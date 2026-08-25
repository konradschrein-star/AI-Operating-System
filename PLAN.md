# aios-stuck-run-is-not-a-failed-task — round 0 plan

**Recommendation first.** Two narrow changes in `executor.ts` (stop the watchdog
flipping a demonstrably-live run; let a completion reclaim the watchdog's own
flip), one new guard in `project-tick.ts` shaped exactly like R860/R870/overload
(a stuck run is resumed, never failed), and one runbook that lands the five
capped tasks as `done` without re-running a single agent. No change to
`HEARTBEAT_STUCK_THRESHOLD_MS`.

---

## 1. What the code actually says (read this shift, file:line)

| Fact | Where |
| --- | --- |
| Watchdog flips `running`→`stuck` on stale heartbeat, blind UPDATE, no liveness check | `forge-control/src/executor.ts:1410-1434` |
| Heartbeat writes `WHERE id = $1 AND status = 'running'` — the trapdoor | `forge-control/src/executor.ts:679` |
| `completeRun`'s guard `AND status = 'running'`; rowCount 0 → log + discard | `forge-control/src/executor.ts:489`, `:525-533`, `:556-564` |
| `sessionProcessAlive()` — the /proc liveness instrument, already here | `forge-control/src/executor.ts:689-711` |
| `inFlight: Map<string, Promise<void>>` — the executor's own ownership record | `forge-control/src/executor.ts:1447` |
| Watchdog and `projectTick()` run in the SAME process as every heartbeat | `forge-control/src/executor.ts:1856`, `:1864` |
| `listSettledRunningTasks` treats `stuck` as settled, and says why it believes stuck means dead | `forge-control/src/db/projects.ts:2054-2090` |
| The settled loop: `run_status !== 'completed'` → three guards → `failed` + `blocked` | `forge-control/src/lib/project-tick.ts:2670-2699` |
| The three guards to mirror | `project-tick.ts:2361`, `:2440`, `:2536` |
| Their write helpers, each carrying its precondition into SQL | `forge-control/src/db/runs.ts:845-877` (+ `requeueRunAfterUsageWall`) |
| `safe-restart.sh` already states the truth this project is fixing | `scripts/ops/safe-restart.sh:11-13` |

**Measured on the live DB this shift (read-only):**

```
pm2 jlist | jq -r '.[]|"\(.name) instances=\(.pm2_env.instances//1) mode=\(.pm2_env.exec_mode)"'
  → forge-executor instances=1 mode=fork_mode          # ONE process. Not a cluster.
psql … -c "SELECT status,count(*) FROM runs GROUP BY 1"
  → stuck 35 · running 1 · completed 986 · failed 248 · cancelled 18 · paused 2
psql … -c "SELECT stuck_signal,count(*) FROM runs WHERE status='stuck' GROUP BY 1"
  → heartbeat_stale 35        # 100% of stuck rows are the watchdog's own flip
psql … -c "SELECT p.name,pt.attempt FROM project_tasks pt JOIN projects p ON p.id=pt.project_id
            WHERE pt.status='failed' AND pt.attempt>=3"
  → 5 rows, attempt=3, all five projects status='blocked'
```

`runs.status` is `varchar(16)` with `CHECK (status IN ('queued','running','paused','stuck','completed','failed','cancelled'))`;
`stuck_signal` is `varchar(64)`, free text. `project_tasks.attempt` is the cap
counter; `MAX_TASK_ATTEMPTS = 2` (`db/projects.ts:1828`).

### The mechanism, stated exactly

The executor is a **single fork-mode process**. `heartbeat()` (every 5 s per run)
and `stuckWatchdogTick()` (the loop) are two timers on **one event loop**, both
writing through **one pg pool, `max=5`** (`db/ai_os.ts:22`). When that loop
stalls or the pool saturates for >90 s, both timers come due at once and race:

* heartbeat's UPDATE lands first → `last_heartbeat_at` refreshes → no flip. Fine.
* watchdog's UPDATE lands first → `status='stuck'` → **every subsequent heartbeat
  from the still-running turn matches 0 rows** (`AND status='running'`) → the run
  can never revive → `completeRun` is refused → the turn's output is discarded →
  `project-tick` reads `run_status='stuck'` as failure → task `failed`, project
  `blocked`.

It is a coin flip on every stall, which is why there were 46 flips and 42
discards. Note `appendThreadEntry` (`executor.ts:604-612`) has **no** status
guard, so a flipped-but-live run keeps refreshing `last_heartbeat_at` while its
status stays wrong — the timestamp already knows the truth the status denies.

**Not proven, and deliberately not assumed:** *why* the loop stalls past 90 s.
Zero heartbeat errors and zero pool errors in the log window, so these are
latency/event-loop stalls, not failed writes. Task T3 measures it. Nothing in
T1/T2/T5 depends on the answer.

---

## 2. The fix

### (a) executor.ts — two changes, both narrow

**a1 · The watchdog does not flip a run it can prove is alive.**
Replace the blind UPDATE with: SELECT stale candidates → decide per candidate →
guarded UPDATE for the ones that fail the liveness test.

Liveness instruments, in order, **reusing what exists**:
1. `inFlight.has(runId)` — this process is currently executing that turn. Free,
   exact, and it is precisely the dominant case (single fork-mode executor).
2. `sessionProcessAlive(cc_session_id)` — the existing /proc reader, for turns
   this process no longer owns (executor restarted, child survived).

Do **one** /proc walk per tick, not one per candidate: extract
`readEngineCmdlines()` and keep `sessionProcessAlive(id)` as a one-line wrapper
over it, so the existing caller at `executor.ts:1044` is untouched.

The decision is a pure function so it can be tested without a DB:

```ts
export type WatchdogVerdict = "flip" | "hold";
export function watchdogVerdict(input: {
  ownedInProcess: boolean;          // inFlight.has(runId)
  sessionId: string | null;         // metadata.cc_session_id
  liveSessionIds: ReadonlySet<string>;
}): WatchdogVerdict;
```

`hold` → log one line naming the run, the staleness in ms and which instrument
held it, and touch `last_heartbeat_at` so the next tick does not re-litigate it.
`flip` → today's UPDATE, unchanged, keeping `AND status='running' AND
last_heartbeat_at < threshold` in the WHERE so a heartbeat that landed during
the /proc walk wins (no TOCTOU).

`readEngineCmdlines()` returning empty because `/proc` is unreadable must **log
loudly and be treated as "no evidence of life"** (= flip). That is the existing
function's behaviour and it is the safe direction — but it must not be silent.

**a2 · `completeRun` may reclaim the watchdog's own flip.**
Widen the guard from `AND status = 'running'` to a single exported constant:

```ts
// lib/run-liveness.ts — ONE definition, interpolated by executor.ts and
// asserted against real Postgres by the dry-run harness.
export const COMPLETABLE_STATUS_SQL =
  "(status = 'running' OR (status = 'stuck' AND stuck_signal = 'heartbeat_stale'))";
```

Why this is safe, spelled out: `heartbeat_stale` is written by exactly one code
path — the watchdog — and it is a **guess about liveness**. A completion
arriving from the turn that owns the run is proof the guess was wrong. Every
operator status still wins the race unchanged (`paused`, `cancelled`, `failed`,
`completed`), and `stuck_signal='timeout'` (the wall-clock path,
`executor.ts:~900`) still wins, because that stuck is a real decision with its
own resume path.

The comment at `executor.ts:536` ("rowCount 1 means the row WAS 'running'")
becomes false. The UPDATE must return the pre-image status —
`UPDATE runs SET … FROM (SELECT status AS prev FROM runs WHERE id=$1 FOR UPDATE) old
WHERE runs.id=$1 AND … RETURNING old.prev, …` — so `completionTransition` is fed
the truth and the log line can say *reclaimed a watchdog flip* rather than
pretending nothing happened. **A reclaim must be logged at warn level with the
run id.** Silent recovery is how this bug survived.

### (b) project-tick.ts — one guard, same shape as the three already there

New `deferForStuckRun(task, project): Promise<boolean>` next to its three
siblings, plus a pure policy module `lib/stuck-recovery.ts` mirroring
`lib/api-overload.ts` / `lib/engine-fallback.ts`.

Placement in the settled loop: **first** of the four, with a comment (and a test)
recording that the placement cannot matter — all three existing guards return
false unless `run_status === 'failed'`, and this one returns false unless
`run_status === 'stuck'`. Disjoint predicates.

Decision table:

| Run state | Action | Task | Project |
| --- | --- | --- | --- |
| `stuck` + `heartbeat_stale` + **process alive** | do nothing this tick; the turn will land its own completion via a2 | stays `running` | stays `active` |
| `stuck` + `heartbeat_stale` + process gone + `stuck_recovery_attempts < 2` | `requeueRunAfterStuck()` — same row, same worktree, same session, back to `queued` with a `[Fleet notice]` note | stays `running` | stays `active` |
| `stuck` + `heartbeat_stale` + process gone + attempts exhausted | fall through, return `false` | `failed` | `blocked` |
| `stuck` + `stuck_signal='timeout'` or anything else | fall through, return `false` — **out of scope, see §5** | `failed` | `blocked` |
| project not `active` | fall through, return `false` — identical to the three siblings | `failed` | `blocked` |

Resuming the **same run** is what makes this cheap and is the structural answer
to the fleet's chronic "already done" redispatch defect: the agent wakes holding
its own transcript in its own worktree, sees its work already committed, and
closes out in one turn. A fresh run would throw the context away and pay again.

Supporting edits:
* `db/projects.ts` — add `r.stuck_signal AS run_stuck_signal` and
  `COALESCE((r.metadata->>'stuck_recovery_attempts')::int,0)` to
  `listSettledRunningTasks`'s projection and to the `SettledRunningTask`
  interface. Correct the interface's docstring, which currently asserts
  "the engine process is gone or hung" — that sentence is the bug in prose.
* `db/runs.ts` — `requeueRunAfterStuck()`, modelled line-for-line on
  `requeueRunAfterApiOverload`, guarded `AND status = 'stuck' AND stuck_signal =
  'heartbeat_stale'`, returning whether the row moved so the caller falls back
  to the ordinary failure path rather than assuming a park that never happened.

### The negative case is the point of the watchdog — how it stays caught

A genuinely dead run has no `inFlight` entry and no `claude` process carrying its
session id, so `watchdogVerdict` returns `flip`, `completeRun` never fires for
it, and `deferForStuckRun` reaches the resume branch and then the exhaustion
branch. The bound is **evidence of liveness re-proven every tick**, not a timer,
so nothing can hold a dead run open indefinitely. Proof obligations in §3.

---

## 3. Evidence standard — every claim reproducible from a command in the diff

1. **Unit tests** (`node:test` + `assert/strict`, house style, under
   `forge-control/src/lib/` because `tsx --test "src/**/*.test.ts"` only reaches
   there): `watchdogVerdict` over the five input combinations, `classifyStuck` /
   `planStuckRecovery` over real `stuck_signal` values, disjointness of the four
   settled-loop guards.
2. **Dry-run harness against a throwaway Postgres**, modelled on the existing
   `docs/plan/evidence/r860-dryrun.mts` (which is how R860 was proven).
   `DRYRUN_DATABASE_URL` required, refuses to run without it, `content_forge`
   never touched. It exercises the **real SQL**, because the bug lives in SQL
   preconditions, not in TypeScript:
   * stale + no liveness → flips to `stuck`;
   * stale + `inFlight` → does **not** flip;
   * `stuck`/`heartbeat_stale` + completion → lands, status `completed`;
   * `stuck`/`timeout` + completion → **refused**;
   * `cancelled` + completion → **refused**;
   * `deferForStuckRun` on a dead exhausted run → returns false (task still fails).
3. **The gate bites.** One `gate_sh` line appended to `scripts/checks/gates-808.sh`
   before its summary block (line ~295), and proven with `prove-it-bites.sh` —
   which is **not on this branch**; recover it with
   `git show e83f318:scripts/checks/prove-it-bites.sh > scripts/checks/prove-it-bites.sh`,
   run it, delete it (it stays untracked and reaches no commit). Prove the gate
   through the `| tail -2` the convention appends: `gate_sh` runs
   `bash -c "set -o pipefail; $script"`, and a body without `pipefail` reports
   `tail`'s status and cannot fail at all.
4. **Live, in the deploy task only:** kill a live `claude` child and watch its run
   flip to `stuck` within two watchdog periods — the negative case on real
   hardware.

---

## 4. Recovery of the five capped tasks

All five have `attempt = 3` against `MAX_TASK_ATTEMPTS = 2`, their projects are
`blocked`, and their work is committed. **Retrying them re-does finished work and
re-spends the money.** There is no API route that marks a task `done` — `POST
/api/tasks/:id/retry` and `POST /api/projects/:id/unwedge` only move `failed →
ready`. So the runbook is SQL, and it must earn each write:

For each task — **verify, then write, never the reverse**:
1. Read the task's `write_set` and title from `project_tasks`.
2. In its worktree: `git status --porcelain` clean, and `git log --oneline -5`
   carries a commit matching the task title.
3. Confirm every declared path exists **by name** in the tree or in the task's
   commits. Renumbered migrations and tests consolidated into
   `forge-control/src/lib/*.test.ts` are *benign declaration drift*, not a miss —
   the test glob only reaches `src/lib`.
4. Only then: `UPDATE project_tasks SET status='done' WHERE id=…` (one id at a
   time, `RETURNING id,status`), and `POST /api/projects/:id/status
   {"status":"active"}` to unblock the project.

The script `scripts/ops/recover-stuck-task.sh` is **dry-run by default**: it runs
steps 1–3 and prints the exact SQL it *would* run. `--apply` is required to
write, and it re-runs the verification immediately before writing. It never
touches more than the task ids passed on its command line.

Whether the deploy task *executes* this against the five live tasks, or only
documents it, is Konrad's call — asked in the manager chat, default: deploy the
fix and verify it, print the commands, do not mutate four other projects' rows
without an answer.

---

## 5. Out of scope, stated rather than silently skipped

* **`HEARTBEAT_STUCK_THRESHOLD_MS` is not changed.** Raising it lowers the
  frequency and leaves the trapdoor.
* **`stuck_signal='timeout'` still fails its task.** Today that is arguably also
  wrong (a timeout is resumable by hand), but zero of the 35 current stuck rows
  carry it, and widening this fix to cover it would change behaviour nobody
  measured. Flagged to Konrad as a follow-up.
* **Pool tuning.** T3 measures; it does not tune. `max=5` moves only on evidence.

---

## 6. Task graph

Workstream `main` throughout — every write_set is disjoint, so nothing needs a
second worktree, and a second one would cost an integration task and a merge.

| # | role · tier | title | depends_on | write_set |
| --- | --- | --- | --- | --- |
| T1 | builder · standard | Close the stuck trapdoor in the executor | — | `forge-control/src/lib/run-liveness.ts`, `…run-liveness.test.ts`, `forge-control/src/executor.ts` |
| T2 | builder · junior | Stuck-recovery policy — pure classifier and planner | — | `forge-control/src/lib/stuck-recovery.ts`, `…stuck-recovery.test.ts` |
| T3 | builder · junior | Measure why heartbeats exceed 90s | — | `docs/plan/evidence/stuck-heartbeat-latency.md`, `docs/plan/evidence/heartbeat-latency-probe.mts` |
| T4 | builder · junior | Recovery runbook for the five capped tasks | — | `docs/ops/recover-stuck-capped-tasks.md`, `scripts/ops/recover-stuck-task.sh` |
| T5 | builder · standard | Teach project-tick that stuck is not failed | T1, T2 | `forge-control/src/lib/project-tick.ts`, `forge-control/src/db/projects.ts`, `forge-control/src/db/runs.ts`, `forge-control/src/lib/project-tick-stuck.test.ts` |
| T6 | builder · junior | Dry-run harness and a gate that bites | T1, T5 | `docs/plan/evidence/stuck-trapdoor-dryrun.mts`, `docs/plan/evidence/stuck-trapdoor-proof.md`, `scripts/checks/gates-808.sh` |
| T7 | reviewer · standard | Review the whole diff | T1–T6 | — |
| T8 | builder · standard | Merge to main and deploy | T7 | `docs/plan/evidence/stuck-deploy-verification.md` |

Round 0 siblings share one worktree. Iterate with
`npx tsx --test src/lib/<your-file>.test.ts`; run the full suite once at the end
and attribute any red rather than absorbing it.

Dependencies before any gate — `NODE_ENV=production` is exported into every run,
so `pnpm install --frozen-lockfile` skips devDependencies (and `tsx`) while
exiting 0:

```
cd forge-control && pnpm install --frozen-lockfile --prod=false
```

---

## Rejected alternatives

* **Raise the threshold to 10 min** — lowers frequency, keeps the trapdoor; the brief forbids it and is right.
* **Drop the `AND status='running'` guard from `heartbeat()`** — revives runs an operator paused or cancelled; the guard is load-bearing for operator verbs.
* **Revive `stuck → running` on any heartbeat** — same problem one step in, and it re-opens a run parked by the timeout path awaiting manual Resume.
* **Record the child PID in `runs` as the liveness instrument** — a new schema column and a new instrument when `sessionProcessAlive()` + `inFlight` already answer the question.
* **Have project-tick infer "work completed" from the last assistant message** — guessing from prose; the run row already carries `stuck_signal`, and resuming the same run needs no guess.
* **Mark the five capped tasks done via `POST /retry` + let them re-run** — that is the redispatch defect, seven recorded instances, and it re-spends the money this project exists to stop losing.
* **A second workstream for the docs tasks** — costs an integration task and a merge to isolate files that already do not collide.
