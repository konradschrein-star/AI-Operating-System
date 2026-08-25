# Evidence — the stuck-trapdoor dry-run harness, against a real Postgres

Round 2 of `aios-stuck-run-is-not-a-failed-task` (T6). Proves, against real SQL rather
than a TypeScript unit test, that (a) the watchdog still flips a genuinely dead run and
holds a genuinely live one, and (b) `completeRun`'s `COMPLETABLE_STATUS_SQL` guard lands a
completion arriving from a run the watchdog mistakenly flipped to `stuck`, while still
refusing a `timeout` flip and a `cancelled` run. `content_forge` was never written to.

## The throwaway database

```
DRYRUN_DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/stuck_trapdoor_dryrun
```

`stuck_trapdoor_dryrun`, created fresh for this round and **left on the box** — dropping it
needs an explicit instruction this build task does not have (same posture as
`forge_r860_dryrun` / `forge_r850_dryrun`, still parked from earlier rounds).

Its schema is the repo's own migrations, replayed in order, not a hand-written fixture:

```bash
for f in $(ls db/migrations/00{21..49}*.sql | sort); do
  psql -h 127.0.0.1 -p 5432 -U postgres -d stuck_trapdoor_dryrun -v ON_ERROR_STOP=1 -f "$f"
done
```

All 30 files applied with **zero errors** — the live CHECK constraints, defaults and
indexes on `runs`, `project_tasks` and `projects` are the real ones (`\d runs` on the
scratch db shows the `stuck_signal`, `last_heartbeat_at`, `wake_after` columns and the
`runs_stuck_idx` partial index exactly as migration `0021`/`0031`/`0036` define them).

**One exception, disclosed rather than silently worked around.** Migration
`0021_ai_os_tables.sql` declares `inbox_items.related_job_id` and
`inbox_notes.related_job_id` as `REFERENCES content_jobs(id)` — a table that belongs to
content-forge's own (undocumented-here) migration set, not to `db/migrations`, and that
this dry-run harness never touches (its six assertions only read/write `runs`). Postgres
still requires the referenced table to exist at `CREATE TABLE` time, so a **minimal
one-column stub** was created first, purely to let migration `0021` apply verbatim:

```sql
CREATE TABLE content_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
```

This is the one hand-written statement in the whole setup, it is NOT one of the tables
under test, and no assertion below reads or writes it.

## A — the harness, full raw output

```
DRYRUN_DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/stuck_trapdoor_dryrun \
  npx tsx ../docs/plan/evidence/stuck-trapdoor-dryrun.mts   # (run from forge-control/)
```

```

=== A. stale + NO in-process owner + NO live session -> flips to 'stuck' ===
  PASS  A: watchdog flips — flipped
  PASS  A: status = 'stuck' — stuck
  PASS  A: stuck_signal = 'heartbeat_stale' — heartbeat_stale

=== B. same row, held by the in-process owner predicate -> does NOT flip ===
  PASS  B: watchdog holds — held
  PASS  B: status still 'running' — running
  PASS  B: last_heartbeat_at refreshed (newer than the seeded stale value)

=== C. same row, live session id in the /proc cmdline snapshot -> does NOT flip ===
  PASS  C: watchdog holds — held
  PASS  C: status still 'running' — running

=== D. stuck/heartbeat_stale + completion -> LANDS ===
  PASS  D: rowCount 1 — 1
  PASS  D: final status 'completed' — completed
  PASS  D: assistant turn present in the thread

=== E. stuck/timeout + completion -> REFUSED ===
  PASS  E: rowCount 0 — 0
  PASS  E: row untouched — status still 'stuck' — stuck
  PASS  E: row untouched — stuck_signal still 'timeout' — timeout
  PASS  E: row untouched — no assistant turn appended

=== F. cancelled + completion -> REFUSED ===
  PASS  F: rowCount 0 — 0
  PASS  F: row untouched — status still 'cancelled' — cancelled
  PASS  F: row untouched — no assistant turn appended

ALL CHECKS PASSED
```

`EXIT=0`.

What each assertion exercises, and why it needs real Postgres rather than a unit test:
A and the flip-half of B/C run the SAME staleness `SELECT`/`UPDATE` the watchdog runs
(`executor.ts:1464-1529`), gated by the REAL, imported `watchdogVerdict()` +
`liveSessionIdsAmong()` + `readEngineCmdlines()` from `lib/run-liveness.ts` — C additionally
spawns a real `/bin/sleep` child with `argv0: "claude --resume <sid>"` so `readEngineCmdlines()`
walks a REAL `/proc` entry, not a mock. D/E/F all go through the SAME `UPDATE … WHERE …
${COMPLETABLE_STATUS_SQL}` statement, with `COMPLETABLE_STATUS_SQL` **imported** from
`lib/run-liveness.ts` rather than retyped — the one SQL precondition this whole project
exists to widen, asserted against the real CHECK-constrained `runs` table so a typo in the
guard shows up as a wrong `rowCount`, not a green TypeScript test.

## B — isolation: content_forge was never touched

```
$ PGPASSWORD=*** psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge \
    -tAc "SELECT count(*) FROM runs WHERE id::text LIKE 'dead0000%'"
0
```

Every row this harness seeds uses an id starting `dead0000-0000-4000-8000-…` (`probeId()`
in the harness) — zero of them exist on the live database.

## C — the gate bites (`gate_sh`, `scripts/checks/gates-808.sh`)

One line appended after the last existing gate (`reproduce-cleanliness`, ~line 287) and
before the summary block:

```sh
if [ -n "${DRYRUN_DATABASE_URL:-}" ]; then
  gate_sh "stuck-trapdoor-dryrun.mts — watchdog flip/hold + COMPLETABLE_STATUS_SQL reclaim, against a real Postgres" \
    "cd forge-control && ./node_modules/.bin/tsx ../docs/plan/evidence/stuck-trapdoor-dryrun.mts | tail -25"
else
  skip "stuck-trapdoor-dryrun.mts — watchdog flip/hold + COMPLETABLE_STATUS_SQL reclaim" \
    "DRYRUN_DATABASE_URL is unset; this gate needs a THROWAWAY Postgres database (never content_forge) — see docs/plan/evidence/stuck-trapdoor-proof.md"
fi
```

Same posture as the existing `check-usage-fold.ts` gate immediately above it in the file:
SKIPPED, loudly, when no throwaway database has been provisioned — never silently reported
as passing. The `| tail -25` is piped through `gate_sh`'s `bash -c "set -o pipefail; $script"`
(`gates-808.sh:85`), so a red harness still fails the gate rather than reporting `tail`'s
exit code — verified directly:

```
$ bash -c 'set -o pipefail; cd forge-control && ./node_modules/.bin/tsx ../docs/plan/evidence/stuck-trapdoor-dryrun.mts | tail -25'
... (DRYRUN_DATABASE_URL unset)
Error: DRYRUN_DATABASE_URL is not set — point it at a THROWAWAY database, never content_forge
EXIT=1
$ DRYRUN_DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/stuck_trapdoor_dryrun \
    bash -c 'set -o pipefail; cd forge-control && ./node_modules/.bin/tsx ../docs/plan/evidence/stuck-trapdoor-dryrun.mts | tail -25'
... ALL CHECKS PASSED
EXIT=0
```

### Mutation proof — `prove-it-bites.sh` (recovered, used, deleted; untracked, no commit)

```
git show e83f318:scripts/checks/prove-it-bites.sh > scripts/checks/prove-it-bites.sh
chmod +x scripts/checks/prove-it-bites.sh
```

The gate body was extracted **by name** from the live file, never hand-copied:

```
--check 'gate_sh() { bash -c "set -o pipefail; $2"; }; \
  source <(awk "/^  gate_sh \"stuck-trapdoor-dryrun\.mts/,/tail -25\"\$/" scripts/checks/gates-808.sh)'
```

Restore used `--subject-copy` (a `/tmp` byte-copy) for **both** mutations, never
`git checkout` — this is a shared worktree with siblings' work, and `git checkout --`
resets a file to `HEAD` rather than to "the state before this mutation," which is the wrong
guarantee in a worktree other tasks are also writing to.

#### Mutation 1 — `COMPLETABLE_STATUS_SQL` back to the bare `(status = 'running')`

Subject: `forge-control/src/lib/run-liveness.ts` (the ONE definition executor.ts's
`completeRun` and this harness both interpolate).

```diff
-export const COMPLETABLE_STATUS_SQL =
-  "(status = 'running' OR (status = 'stuck' AND stuck_signal = 'heartbeat_stale'))";
+export const COMPLETABLE_STATUS_SQL = "(status = 'running')";
```

**RED** (mutated — assertion D, the reclaim, fails; E/F stay correctly refused, proving
they are not vacuously passing off the same guard):

```
STEP 3 — check UNMUTATED: exit code 0, "ALL CHECKS PASSED"
STEP 5.1 — check MUTATED:
  === D. stuck/heartbeat_stale + completion -> LANDS ===
    FAIL  D: rowCount 1 — 0
    FAIL  D: final status 'completed' — stuck
    FAIL  D: assistant turn present in the thread
  === E. stuck/timeout + completion -> REFUSED ===
    PASS  E: rowCount 0 — 0
    PASS  E: row untouched — status still 'stuck' — stuck
    PASS  E: row untouched — stuck_signal still 'timeout' — timeout
    PASS  E: row untouched — no assistant turn appended
  === F. cancelled + completion -> REFUSED ===
    PASS  F: rowCount 0 — 0
    PASS  F: row untouched — status still 'cancelled' — cancelled
    PASS  F: row untouched — no assistant turn appended
  3 CHECK(S) FAILED
  exit code (mutated/1): 1
```

**GREEN** (restored, hash-verified):

```
STEP 6.1 — restore and prove it by hash
  restore mode : copy
  md5 BEFORE   : 917f76251fa789b5ca1b732cab75785e
  md5 AFTER    : 917f76251fa789b5ca1b732cab75785e
  restore verified by hash
VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored.
```

#### Mutation 2 — the watchdog's in-process liveness hold

Same subject. `watchdogVerdict()`'s FIRST liveness instrument (`ownedInProcess`, the free,
exact one for a single fork-mode executor) stops holding:

```diff
-  if (input.ownedInProcess) return "hold";
+  if (input.ownedInProcess) return "flip";
```

**RED** (mutated — assertion B, the in-process hold, fails; C — the OTHER liveness
instrument, `sessionId`/`liveSessionIds`, untouched by this mutation — correctly still
holds, proving B and C are independent assertions and not one passing for the other's
reason):

```
STEP 3 — check UNMUTATED: exit code 0, "ALL CHECKS PASSED"
STEP 5.1 — check MUTATED:
  === B. same row, held by the in-process owner predicate -> does NOT flip ===
    FAIL  B: watchdog holds — flipped
    FAIL  B: status still 'running' — stuck
    FAIL  B: last_heartbeat_at refreshed (newer than the seeded stale value)
  === C. same row, live session id in the /proc cmdline snapshot -> does NOT flip ===
    PASS  C: watchdog holds — held
    PASS  C: status still 'running' — running
  === D/E/F: unaffected, all PASS (this mutation is scoped to the ownedInProcess branch only)
  3 CHECK(S) FAILED
  exit code (mutated/1): 1
```

**GREEN** (restored, hash-verified):

```
STEP 6.1 — restore and prove it by hash
  restore mode : copy
  md5 BEFORE   : 917f76251fa789b5ca1b732cab75785e
  md5 AFTER    : 917f76251fa789b5ca1b732cab75785e
  restore verified by hash
VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored.
```

`prove-it-bites.sh` and the two `--mutation-file` scripts (`/tmp/mutate-completable.py`,
`/tmp/mutate-watchdog.py`) were deleted after use; none reach a commit.

## D — full `gates-808.sh --strict` run, `DRYRUN_DATABASE_URL` set

```
DRYRUN_DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/stuck_trapdoor_dryrun \
  bash scripts/checks/gates-808.sh --strict
```

**29 gates: 27 EXECUTED, 2 SKIPPED (the `--browser` pair, not requested), 8 RED.**
Gate 29 — this task's new gate — is **GREEN**.

The 8 RED gates are **all inherited, none from this task's write-set**
(`docs/plan/evidence/stuck-trapdoor-dryrun.mts`, `…-proof.md`,
`scripts/checks/gates-808.sh` — the gate line only):

| # | gate | cause |
| - | --- | --- |
| 2 | `npx tsc --noEmit — forge-control-web` | `forge-control-web/node_modules/typescript` is absent on this worktree (`npx: command not found: tsc`) — a pre-existing environment gap, matches memory note `check-chat-rich-needs-web-node-modules` |
| 3 | `pnpm build — forge-control-web` | same missing `node_modules` |
| 5 | `no-raw-colours.cjs` | 53 pre-existing "KNOWN DEBT" literals the gate's own output labels as such, none in this task's write-set |
| 6 | `forbidden-file diff — three-dot main...HEAD` | **expected**, not a defect — this gate encodes round-808's OWN scope rule ("no engine files"), and THIS project's entire purpose is to change `executor.ts`, `project-tick.ts`, `db/projects.ts`. The gate is doing exactly what its one-line diff says: those three files differ from `main`, because T1/T5 changed them on purpose. |
| 10 | `check-composer-v3.ts` | `Cannot find module 'react'` — same `forge-control-web/node_modules` gap as gates 2/3 |
| 14 | `check-stop-affordance.tsx` | depends on the same forge-control-web build artifacts as 2/3/10 |
| 15 | `check-dismiss-peek.tsx` | same |
| 18 | `check-deep-link.ts` | same |

None of these read, import, or execute anything this task's write-set touches. Full
transcript: `/tmp/gates808-full.log` on this box (not committed — evidence artefacts this
large are reproducible on demand from the command above, and the repo convention is to
paste, not commit, full gate logs).

## Left for the deploy phase

`stuck_trapdoor_dryrun` stays on the box, alongside `forge_r860_dryrun` /
`forge_r850_dryrun`. Nothing here has been verified against the LIVE engine — the deploy
task's `safe-restart.sh` is what makes this real.
