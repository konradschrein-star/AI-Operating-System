# Evidence — the fleet survives a subscription usage wall (R860)

Round 860. The engine now tells "this task is wrong" apart from "the account is full", and
recovers from the second on its own.

## The incident

2026-08-05, ~10:00–15:00 Europe/Berlin. The Claude subscription's 5-hour window filled.
Every `claude` child in flight died, `reconcileSettledTasks()` did what it does for any
failure — marked the task `failed`, flipped the project to `blocked` — and both active
projects went down inside eighty seconds of each other. The fleet then sat dead for
roughly five hours until Konrad came back and called `/unwedge` by hand.

Nothing was broken. The two rows from that window, read out of `runs.thread`:

```
a59d2cf8  failed  operator-visibility · Phase 300a       2026-08-05 09:14:17+00
  Executor failed: claude-code exit 1: You've hit your session limit · resets 1:10pm (Europe/Berlin)
8159ee4f  failed  engine-v2-research-lane · Re-review…   2026-08-05 09:14:31+00
  Executor failed: claude-code exit 1: You've hit your session limit · resets 1:10pm (Europe/Berlin)
```

The wall announces its own reset time. The engine simply was not reading it.

## The signature is stable, not a one-off

Across the whole `runs` table, the error text falls into four wordings — 41 rows on the
session wall, 56 on the weekly one:

```
You've hit your weekly limit · resets Jul 7, 2pm (Europe/Berlin)     29
You've hit your session limit · resets 8pm (Europe/Berlin)           12
You've hit your session limit · resets 1:10pm (Europe/Berlin)         2   <- the incident
You've hit your weekly limit · resets 2pm (Europe/Berlin)            27
```

`classifyUsageWall()` was then run over **every distinct error string this host has ever
written** (19 of them, dumped read-only from `runs.thread`). Perfect separation, no
hand-tuning:

| verdict | strings |
| --- | --- |
| WALL (4) | the two session wordings, the two weekly wordings |
| pass-through (15) | pool 502 timeout · per-run spend cap ×2 · daily spend cap ×5 · exit 0 · exit 143 · emergency pause · 600s timeout · `--dangerously-skip-permissions` misuse · OAuth session expired · `AI_OS_DATABASE_URL is not set` |

The negatives matter more than the positives. A false positive parks a genuinely broken
task on a timer, so a real bug goes unreported for hours and is then retried into the same
crash. That is why bare `rate limit` / `429` / `quota exceeded` are deliberately NOT
matched — those are the API's per-minute throttle, they clear in seconds, and
`account-health.ts` already owns them.

## Design

**Park the RUN, do not kill the TASK.** On the wall's signature the failed run is put back
on the queue behind `runs.wake_after` (migration 0036, which already hides a queued run
from `claimNextRun()` until its wake time). The task stays `running`, the project stays
`active`, and no new schema was needed.

Resurrecting the same row rather than spawning a replacement is what makes the recovery
free: the executor's resume path sends `trailingUserBlock(thread)` when a CC session
exists — i.e. everything appended after the last engine turn — so the agent wakes holding
its own transcript plus one sentence explaining the gap. A fresh run would have discarded
that context and paid for it again.

**Read the reset time.** A bare 15/30/60 ladder does not solve the incident. Its runs died
at 09:14 UTC against a wall that lifted at 11:10 UTC; the ladder spends its last retry at
10:59 UTC and hard-fails **eleven minutes early**, having burned three retries to arrive at
exactly the outage we started with. So `parseResetAt()` reads `"1:10pm (Europe/Berlin)"`
into an instant (IANA zone via `Intl`, DST sampled at the target instant), and the ladder
is the fallback for when it cannot. `null` is a first-class answer: no zone, an unknown
zone, or a bare integer where a time should be all return it, because guessing UTC for a
Berlin string wakes the fleet two hours early, silently.

**Two counters, kept apart.** Usage-wall retries live on the run
(`metadata.usage_wall_attempts`, cap 3), not on `project_tasks.attempt` (cap 2). `attempt`
is the budget an operator spends with `/retry` and `/unwedge` on work that actually failed.
A wall is not the task's fault — it never started — and charging the outage to that budget
would mean a night of two walls leaves the task with no operator retries for a real failure
the next morning.

**One push per outage.** Eleven tasks bounced off one wall in ninety seconds. There is no
outage ID to key on (the wall is inferred from run corpses, not reported), so the dedup is
a time window read from the `notifications` table — from the table, not a module variable,
because an executor restart would otherwise re-announce an outage the previous process
already reported. The window is exactly one maximum park (6h), so one wall can only speak
once.

**Four refusals, each for its own reason.** Not `failed` (a cancellation is Konrad's
decision; a timeout has its own resume path) · no run row · not the signature · project not
`active`. That last one is the subtle one: a queued run is invisible to project status —
the executor's claim loop knows about runs, not projects — so parking one on a blocked
project would smuggle billable work straight past the gate first-night bug 2 exists to
enforce.

## A — unit suite (`src/lib/usage-wall.test.ts`, 45 tests)

`pnpm test` → **526 passed, 0 failed** across the whole suite; `npx tsc --noEmit` clean.

Two real defects were caught by writing these, both of which would have shipped silently:

1. **`"Jul 7, 2pm"` parsed as 07:00.** The time regex matched the leading `7` — the DAY —
   with no meridiem. It parses cleanly, logs plausibly, and wakes the fleet seven hours
   early. Fixed by extracting the date first and removing its text before reading the time,
   plus a guard that refuses a bare integer as a clock value (U2).
2. **`you’ve` (U+2019) did not match `you've` (U+0027).** The CLI renders either depending
   on the terminal. A regex that knows only the straight quote switches auto-recovery off
   the day a dependency changes how it prints (U1).

U4 is the file's centre: classify → parse → plan on the incident's own error string and
timestamp recovers it on the **first** retry, waking at 11:12 UTC against a wall that lifts
at 11:10. Its sibling test asserts the eleven-minute near-miss of the ladder-only path, so
the margin is a tested fact rather than a claim in a comment.

## B — end to end against a throwaway database

The pure layer cannot reach the SQL, the ordering, or the dedup. `r860-dryrun.mts` (beside
this file) exercises `deferForUsageWall()` for real.

Everything ran against `forge_r860_dryrun`, created for this round on the local Postgres
with `pg_dump --schema-only` of `runs`, `project_tasks`, `projects` and `notifications`, so
the CHECK constraints, defaults and unique indexes are the live ones. **`content_forge` was
not written to at all** — it was read (the error corpus above) and plan-checked with
`EXPLAIN`, which plans without executing; the two incident rows were re-selected afterwards
and are still `failed`.

Re-run it with:

```bash
cd forge-control
DRYRUN_DATABASE_URL=postgresql://…/forge_r860_dryrun \
  npx tsx ../docs/plan/evidence/r860-dryrun.mts
```

**ALL CHECKS PASSED.** What it proves:

*A — the incident, replayed with two projects and one wall*
- both runs surface through `listSettledRunningTasks()` carrying `last_error` (the
  EXECUTOR's message) and `usage_wall_attempts = 0`
- both are re-queued: `status = 'queued'`, `wake_after` set, attempt `1`, and a `system`
  turn appended ending in "parked automatically"
- both TASKS still `running` — **not failed**
- both PROJECTS still `active` — **not blocked**
- **exactly one** notification, `source = 'usage_wall'`

*B — the wall does not lift*
- prior 1 → parked as attempt 2 (30m, ladder) · prior 2 → attempt 3 (60m, ladder)
- prior 3 → cap reached, `false` returned, run left `failed` and untouched, so the ordinary
  path blocks the project and tells Konrad exactly as before

*C — what must not be parked*
- a daily-spend-cap failure is not a wall
- a wall on a `blocked` project is refused
- a `cancelled` run is never resurrected, and stays cancelled
- still exactly one notification after all of the above

The push Konrad actually receives:

> ⏸️ Claude 5-hour session limit hit (resets 1:10pm (Europe/Berlin)). The fleet paused
> itself — the tasks that bounced off the wall are parked, not failed, and no project was
> blocked. First retry in 6h, at 06.08.26, 07:24. Nothing for you to do; it will
> auto-resume.

(The "6h" there is the ceiling doing its job: the dry-run's wall clock is 01:24, so a
13:10 reset is nearly twelve hours out and clamps. U4 covers the incident's real timing.)

## Left for the deploy phase

The scratch database `forge_r860_dryrun` is still on the box. Dropping it needs an explicit
instruction, which this build task does not have — `DROP DATABASE forge_r860_dryrun;` when
convenient. Same for `forge_r850_dryrun` from the previous round.

Nothing here has been verified against the LIVE engine; the executor is holding the old
`project-tick.ts` in memory. The deploy phase's detached `safe-restart.sh` is what makes
this real.
