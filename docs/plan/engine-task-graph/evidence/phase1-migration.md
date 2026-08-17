# Phase 1 evidence record — `engine-task-graph`

Round 104. Written from the worktree `/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`,
branch `project/8c591d6c`. Every command below was **re-run by this task, now**,
not copied from an earlier report. `git rev-parse --short HEAD` at the start of
this task, and unchanged throughout it (this task's write_set is this file
only): **`9707713`**.

This document's job is to say NO if something fails. Nothing below was massaged
to pass; §7 states what would have made it lie and why each way is closed off.

---

## 1. `pnpm typecheck`

```
$ cd forge-control && pnpm typecheck ; echo "exit=$?"
> forge-control@0.1.0 typecheck /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control
> tsc --noEmit

exit=0
```

Ran at `9707713`. Clean — `tsc --noEmit` produced no diagnostics (NF4).

---

## 2. `pnpm test`

```
$ cd forge-control && pnpm test 2>&1 | tail -30 ; echo "exit=$?"
```

Ran at `9707713`. Full summary:

```
# tests 832
# suites 158
# pass 827
# fail 0
# cancelled 0
# skipped 0
# todo 5
# duration_ms 4728.727923
exit=0
```

**Zero skipped.** The five `todo` are exactly `task-graph-replay.test.ts`'s R18
comparison cases — see §3 below for which and why; nothing else in the suite is
`todo`. The task-graph-replay harness prints its own build identity before any
assertion, which is why it appears in the full run:

```
task-graph-replay: FIXTURE  forge-control/src/lib/fixtures/replay-operator-visibility.json
task-graph-replay: ROWS     131
task-graph-replay: SHA256   e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
task-graph-replay: RECORD   sha matches capture record
task-graph-replay: STATUS   done=120 pending=8 running=3
task-graph-replay: HEAD     9707713
task-graph-replay: DIRTY    (none — all three match HEAD)
```

`HEAD 9707713` matches this task's own `git rev-parse --short HEAD` (above),
and `DIRTY (none)` states that the fixture, `task-graph.ts` and
`task-graph-replay.test.ts` all match that commit — the instrument is reporting
on the build this document is reporting on, not on a stray edit in the
worktree.

---

## 3. `scripts/checks/check-migration-0040.sh`

Ran with `$SCRATCH_DATABASE_URL` exported exactly as the script's header
documents:

```bash
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
# forge_tg_scratch already existed from an earlier phase-1 task; CREATE DATABASE
# correctly answered "already exists" rather than silently doing nothing new
export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
bash scripts/checks/check-migration-0040.sh
```

Ran at `9707713`. Full output:

```
=== check-migration-0040.sh — build identity ===================================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 9707713
  uncommitted (subj) : 0 file(s) of {migration, fixture} modified
  migration          : db/migrations/0040_task_graph.sql
  sha256(migration)  : 75492c9bd63d9c0f1da269650550aace7d43bfc00676ca386e97ac28b7db69fa
  fixture            : forge-control/src/lib/fixtures/replay-operator-visibility.json
  sha256(fixture)    : e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
  fixture rows       : 131
  scratch database   : forge_tg_scratch (local; DSN never printed)
  throwaway schema   : tg_check_0040
  schema build path  : PREFERRED — every db/migrations/*.sql below 0040, in
                       lexical order. One forced placeholder: content_jobs,
                       FK target of 0021_ai_os_tables.sql, created by no
                       migration in this repo.
  expected assertions: 36
===============================================================================
  artifacts          : /tmp/check-0040-gVLpIE

--- 2. schema + migrations ----------------------------------------------------
  applied 19 migrations below 0040 into tg_check_0040
  ok   project_tasks exists                                 = project_tasks
  ok   pre-0040: none of the 3 columns present               = 0
  ok   pre-0040: neither R7 index present                    = 0

--- 3. seed from the R9 fixture -----------------------------------------------
  seeded rows        : 131
  ok   seed rows > 0                                         131 >= 1
  ok   seed count == fixture rows                            = 131
  ok   seed: every row starts non-graph (depends_on absent)  = 0

--- 4. apply 0040, pass 1 -----------------------------------------------------
  | ALTER TABLE
  | ALTER TABLE
  | ALTER TABLE
  | COMMENT
  | COMMENT
  | COMMENT
  | DO
  | CREATE INDEX
  | CREATE INDEX
  | UPDATE 131
  ok   pass 1 backfilled every seeded row                    = UPDATE 131
  ok   depends_on type is uuid[]                             = _uuid
  ok   E2 SENTINEL: depends_on has NO column_default         =
  ok   E2 SENTINEL: no pg_attrdef entry for depends_on       = 0
  ok   E2 SENTINEL: depends_on is nullable                   = YES
  ok   depends_on COMMENT states the sentinel                contains: SENTINEL
  ok   workstream type is text                               = text
  ok   workstream defaults to 'main'                         = 'main'::text
  ok   workstream is NOT NULL                                = NO
  ok   write_set type is text[]                              = _text
  ok   write_set defaults to '{}'                            = '{}'::text[]
  ok   write_set is NOT NULL                                 = NO
  ok   workstream CHECK constraint exists                    = CHECK ((workstream ~ '^[a-z0-9][a-z0-9-]{0,39}$'::text))
  ok   workstream CHECK carries the R4 regex                 contains: ^[a-z0-9][a-z0-9-]{0,39}$
  ok   R7 index project_tasks_depends_on_gin exists          = CREATE INDEX project_tasks_depends_on_gin ON tg_check_0040.project_tasks USING gin (depends_on)
  ok   R7 depends_on index is GIN over depends_on            contains: USING gin (depends_on)
  ok   R7 index project_tasks_workstream_idx exists          = CREATE INDEX project_tasks_workstream_idx ON tg_check_0040.project_tasks USING btree (project_id, workstream, status)
  ok   R7 workstream index keys (project_id, workstream, status) contains: (project_id, workstream, status)
  ok   every backfilled row workstream='main'                = 131
  ok   every backfilled row write_set='{}'                   = 131
  ok   no row left with NULL depends_on                      = 0

--- 5. independent closure verification (R6) ----------------------------------
  | ROWS=131
  | MISMATCHES=0
  | MAXLEN=130
  | ROOTS=1
  | ORDER_SENSITIVE=yes
  ok   closure compared every seeded row                     = 131
  ok   closure: 0 rows differ from the independently computed one = 0
  ok   closure: at least one row carries a large array       130 >= 100
  ok   closure: at least one root row carries {}              1 >= 1

--- 6. snapshot ---------------------------------------------------------------
  /tmp/check-0040-gVLpIE/snap1.txt — 131 lines, 312666 bytes
  ok   snapshot 1 has one line per seeded row                = 131

--- 7. apply 0040, pass 2 (re-runnability, R2) --------------------------------
  | ALTER TABLE
  | ALTER TABLE
  | ALTER TABLE
  | COMMENT
  | COMMENT
  | COMMENT
  | DO
  | CREATE INDEX
  | CREATE INDEX
  | UPDATE 0
  ! psql:db/migrations/0040_task_graph.sql:52: NOTICE:  column "depends_on" of relation "project_tasks" already exists, skipping
  ! psql:db/migrations/0040_task_graph.sql:53: NOTICE:  column "workstream" of relation "project_tasks" already exists, skipping
  ! psql:db/migrations/0040_task_graph.sql:54: NOTICE:  column "write_set" of relation "project_tasks" already exists, skipping
  ! psql:db/migrations/0040_task_graph.sql:89: NOTICE:  relation "project_tasks_depends_on_gin" already exists, skipping
  ! psql:db/migrations/0040_task_graph.sql:92: NOTICE:  relation "project_tasks_workstream_idx" already exists, skipping
  ok   pass 2 backfill UPDATE changed zero rows               = UPDATE 0
  ok   pass 2: IF NOT EXISTS engaged on 5 objects             5 >= 5
  ok   snapshot 2 has one line per seeded row                 = 131
  ok   snapshots byte-identical across both applications      312666 bytes

second application changed 0 rows

--- 8. assertion census -------------------------------------------------------
  assertions executed: 36
  assertions defined : 36

PASS — 0040 is re-runnable (R2), its backfill is the closure (R6), both indexes exist (R7).
       git 9707713 · sha256(0040)=75492c9bd63d9c0f… · db=forge_tg_scratch · schema=tg_check_0040
exit=0
```

Ran against `forge_tg_scratch` — a scratch database, not `content_forge`. The
database already existed from an earlier phase-1 task (`02648d3`'s own report);
`CREATE DATABASE forge_tg_scratch` in the operator preamble correctly answered
`ERROR: database "forge_tg_scratch" already exists` rather than silently doing
nothing new, which is the failure mode a re-run of the preamble would otherwise
risk masking.

---

## 4. Commits and files touched, this phase

```
$ git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
```

```
9707713 feat(engine-task-graph/phase-1): task-graph-replay.test.ts — the replica harness that runs and reports
forge-control/src/lib/task-graph-replay.test.ts
02648d3 feat(engine-task-graph/phase-1): check-migration-0040.sh — the behavioural proof of R2, R6, R7
scripts/checks/check-migration-0040.sh
315d835 feat(engine-task-graph/phase-1): capture the R9 fixture — the one authorised live read
docs/plan/engine-task-graph/03-quality.md
forge-control/src/lib/fixtures/replay-operator-visibility.json
forge-control/src/lib/fixtures/replay-operator-visibility.md
7539e36 feat(engine-task-graph/phase-1): task-graph.ts — legacyRoundReady verbatim, every other export a throwing stub
forge-control/src/lib/task-graph.ts
b428722 feat(engine-task-graph/phase-1): migration 0040_task_graph and its named lint case
db/migrations/0040_task_graph.sql
forge-control/src/lib/migrations.test.ts
398319e docs(research/round-100): timing data and measurement readiness for phase 7
docs/research/round-100-e7548096.md
0ea9d28 plan(engine-task-graph): close round 0 — operator confirmation, E1/E2 settled, fixture caveat
docs/plan/engine-task-graph/02-architecture.md
docs/plan/engine-task-graph/04-phases.md
9cfb5b4 plan(engine-task-graph): record the out-of-band round renumber, and correct the briefs it rotted
docs/plan/engine-task-graph/02-architecture.md
docs/plan/engine-task-graph/03-quality.md
docs/plan/engine-task-graph/04-phases.md
9a1448d plan(engine-task-graph): make the corpus map mechanically checkable, and fix the one row it caught
docs/plan/engine-task-graph/04-phases.md
docs/plan/engine-task-graph/check-corpus-map.py
8de7b1c plan(engine-task-graph): waterfall corpus — DAG scheduler + workstream worktrees
docs/plan/engine-task-graph/00-vision.md
docs/plan/engine-task-graph/01-requirements.md
docs/plan/engine-task-graph/02-architecture.md
docs/plan/engine-task-graph/03-quality.md
docs/plan/engine-task-graph/04-phases.md
```

Ran at `9707713`. Everything from `398319e` down is round-0 planning corpus and
the phase-7 scout's research note (see `04-phases.md` §12 E-2 — it runs
concurrently with phase 1's planner and writes only its own file, disjoint from
phase 1's write-set). The five commits above it, `b428722`…`9707713`, are this
phase's five build tasks, mapped in §5 below.

---

## 5. Live checkout cleanliness

```
$ git -C /opt/forge-ai-os status --porcelain ; echo "exit=$?"
```

```
exit=0
```

Output was **empty**. Per the brief, empty output is the only pass — nothing was
hot-applied into `/opt/forge-ai-os` by this task or anything preceding it in
this phase.

---

## 6. The R9 fixture — cited, not re-captured

Per this task's brief, the fixture's numbers are cited from
`forge-control/src/lib/fixtures/replay-operator-visibility.md`, written by
round 102. No query against any live database was run by this task.

| | |
|---|---|
| Capture timestamp | `2026-08-17T05:57:21+02:00` (CEST) |
| `git rev-parse --short HEAD` at capture | `b428722` |
| Rows | **131** |
| `sha256(.json)` | `e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7` |
| Source | `content_forge` at `127.0.0.1:5432`, one read-only `SELECT` |

This document's own §2 and §3 re-derived the same sha256
(`e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7`) from the
committed `.json` twice more, independently — once via the replay harness's
banner, once via `check-migration-0040.sh`'s build-identity block — so three
separate tools agree on the fixture's identity without any of them having
re-read live data.

---

## 7. R18's five cases: `todo` at this phase, and why

All five of `task-graph-replay.test.ts`'s R18 comparison cases are `todo`:

```
not ok 1 - (a) the base fixture, straight through # TODO phase 2: graphReady() is stubbed (R18)
not ok 2 - (b) an early round retried to ready after a later round drained # TODO phase 2: graphReady() is stubbed (R18)
not ok 3 - (c) a task inserted into an already-drained round # TODO phase 2: graphReady() is stubbed (R18)
not ok 4 - (d) a project paused mid-run and resumed # TODO phase 2: graphReady() is stubbed (R18)
not ok 5 - (e) a permanently failed task — both schedulers wedge identically # TODO phase 2: graphReady() is stubbed (R18)
```

**Why.** `graphReady()` in `task-graph.ts` is one of the nine stubs phase 1
deliberately leaves throwing (`04-phases.md` Phase 1 deliverable 3: "Stubs that
throw, never stubs that return a plausible default"). Every one of the five
`not ok` bodies above failed with exactly the same diagnostic, confirmed in the
raw test output at `9707713`:

```
error: 'task-graph: graphReady() lands in phase 2 (R11, R14)'
```

This is deliberate and load-bearing, not an accident that happens to land on
the right message: each case's body asserts its **legacy-side** expectations
first — those assertions run today and passed, or the case would report a
different error — and only then calls the code path that reaches `graphReady()`
and throws. `04-phases.md` Phase 1 deliverable 4 says the harness "may
legitimately fail at this phase if phase 2 has not landed; the gate is that it
runs and reports, not that it passes" — and `03-quality.md` §3.2 Phase 1 says
the same. Both are satisfied: the harness ran, printed its build-identity
banner (§2 above) before any assertion, and reported.

**Why this does not trip `03-quality.md` §3.1's "all green, zero skipped"
gate.** `todo` and `skipped` are different `node:test` outcomes. The full
summary in §2 shows `# skipped 0` and `# todo 5` as separate counters — the
five R18 cases are the entire `todo` count, and nothing in the suite is
`skipped`. `task-graph-replay.test.ts`'s own header states this was verified
empirically, not assumed: "a failing `todo` body was verified empirically…to
leave `# fail 0` and exit 0 under node v22.22.2 + tsx." This task's own run
reproduces that: `# fail 0`, `exit=0`, with the five `todo` cases counted
separately and the run still green.

---

## 8. The E2 ruling — stated, not re-argued

`project_tasks.depends_on` is **nullable, with no default**, against the
project brief's instruction of `default '{}'`. This is settled, on the record,
by Konrad:

> "Proceed to phase 1. Nothing here needs my ruling."

— `02-architecture.md` §9.1, commit `0ea9d28`. E1 (round stays a stored,
engine-computed integer) and E2 (`depends_on` defaults to `NULL`) are both
ruled: "A later round that wants to change either must argue with §0 and §2.2,
not rediscover the question."

The migration implements E2 exactly: `db/migrations/0040_task_graph.sql` line
52 —

```sql
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS depends_on uuid[];
```

— carries no `DEFAULT` clause of any kind. `migrations.test.ts`'s named 0040
case asserts this mechanically (`assert.doesNotMatch(dependsOn, /\bDEFAULT\b/,
…)`), and `check-migration-0040.sh` §3 above asserts it three ways against a
real Postgres: `column_default` is empty, no `pg_attrdef` row exists for the
column, and `is_nullable` is `YES`. This document does not re-open E1 or E2; it
cites the ruling and shows the artefact that carries it out.

---

## 9. The renumber caveat — carried forward, not re-argued

From `04-phases.md` Phase 1 "Risks", as added in commit `0ea9d28`:

**The fixture will not match `00-vision.md` §2's round table, and that is
expected.** Konrad hand-renumbered roughly a dozen `pending` tasks on
`operator-visibility` during the night of 2026-08-16/17, **after** that table
was measured at 03:04. The fixture captured at `2026-08-17T05:57:21+02:00` is
squarely after that renumber (`02-architecture.md` §2.3.3, confirmed on the
record).

This does **not** weaken the replay proof — it is self-consistent by
construction, both schedulers being judged against the fixture's own rounds
either directly (legacy) or via their closure (graph). A later reader must
**not** "correct" the fixture toward `00-vision.md` §2's table, and must not
file the mismatch as a data-integrity finding. Phase 7 owns the consequence for
the measurement instrument, and is separately instructed to rule the renumber
in or out as the *whole* explanation before attributing any remainder to it.
This record adds nothing to that instruction; it restates it so a reader of
phase 1's evidence does not need to chase it into `04-phases.md` to learn it.

---

## 10. Findings from rounds 101–103, and what was done

This project's round-to-task mapping is not read from a ledger this task is
permitted to query (no live database access). It is reconstructed from
citations the tasks themselves made in their own commit messages —
`replay-operator-visibility.md` §1 states outright "Written by round 102";
`02648d3`'s commit body states its schema was "seeded from round 102's R9
fixture"; `b428722`'s commit body states "round 103 owns
check-migration-0040.sh," which places `b428722` itself before round 103. The
mapping below is inferred from those cross-references, not asserted as
independently verified against a task ledger — **that inference is itself
disclosed, not silently treated as fact.**

| Round (inferred) | Task / commit | Finding | What was done |
|---|---|---|---|
| 101 | `b428722` — migration 0040 | The project brief specifies `depends_on default '{}'`; round 0 had already ruled E2 against it (NULL, no default). | Implemented per the round-0 ruling (§8 above), not the brief's literal text; commit message cites `02-architecture.md` §§2.2/9.1 and commit `0ea9d28` as the reason of record. |
| 101 | `7539e36` — `task-graph.ts` stubs | The corpus does not explicitly settle whether `legacyRoundReady()` should itself gate on `pt.status = 'pending'`, or leave that to callers. | Included the `pending` gate in `legacyRoundReady()` (a function named `...Ready` that answered `true` for a `done` row would be a silent falsehood), and flagged in the commit message that phase 2's `graphReady()` must gate on `pending` identically or the harness must apply the filter on both sides. **Reported to the manager chat**, per the commit message. |
| 102 | `315d835` — fixture capture | The brief's literal connection command, `psql -U postgres -d content_forge`, does not resolve on this host — bare `psql` hits the `ai_os` instance on socket 5434 and peer auth fails for `postgres` there (confirming a round-100 finding). | Used the DSN from `/opt/ai-os/.secrets/forge-control.env` behind a shell guard that refuses any DSN not naming `content_forge`; documented in the fixture's sibling `.md` §1 "Connection note." |
| 102 | `315d835` — fixture capture | `03-quality.md` §3.2 Phase 1's gate — "the reviewer greps it for `curl`, `http`" expecting zero hits — is **not satisfiable as written**: `grep -ci 'curl\|http'` over the real fixture returns 1, on a genuine task title (row `127e1b38…`, round 904, "…live endpoint curls…"). | **Gate amended where it is enforced**, in the same commit: `03-quality.md` §3.2 Phase 1 now reads "the grep must return 0, or every matching line must be a `"title":` line already recorded in the fixture's sibling `.md` by row id." The intent (no brief text, no prompts, no run ids, no secrets) is preserved and is now carried mechanically by assertion A3 (closed six-key set) instead. The title was **not** redacted or edited — doing so to make a grep return zero would have corrupted the replay input to flatter the instrument. |
| 102 | `315d835` — fixture capture | `04-phases.md` Phase 1 "Files this phase writes" lists only the `.json` fixture; its own "Risks" paragraph mandates a sibling `.md` capture record. | Recorded as a corpus inconsistency, not silently resolved — stated explicitly in both the commit message and the sibling `.md`'s own opening section — and the `.md` was written anyway, since the Risks paragraph's mandate is the more specific instruction. |
| 103 | `02648d3` — `check-migration-0040.sh` | The brief's instruction to apply every `db/migrations/*.sql` file in lexical order is unsatisfiable against an empty schema: `0021_ai_os_tables.sql` foreign-keys to `content_jobs(id)`, and no migration in this repo creates that table (it belongs to the content-forge pipeline schema the AI OS tables were grafted onto). The brief's named fallback list is also inexact — it places the `runs` DDL in `0030`, but `runs` is created in `0021`. | Created one placeholder table, `content_jobs(id uuid primary key)`, purely to satisfy the dangling foreign key, and applied all 19 real pre-0040 migrations verbatim otherwise — so `project_tasks` and its real CHECKs/indexes are proven against the real DDL, not a hand-simplified replica. Documented in the script's header and printed in its build-identity block (visible in §3 above: "schema build path"). |
| 103 | `02648d3` — `check-migration-0040.sh` | The script's own assertion census (comparing assertions executed against assertions defined in the file) caught a miscount in the script's own first draft. | Fixed before commit; the census assertion itself was kept in the shipped script as a standing self-check (visible in §3 above: "assertion census … 36 executed / 36 defined"). |
| 103 | `9707713` — `task-graph-replay.test.ts` | `node:test`'s `assert.throws(fn, /pattern/)` matches a bare RegExp against the error's **string representation** (`"Error: task-graph: …"`), not `err.message` — so a pattern anchored with `/^task-graph:/` can never match, silently turning every stub-discipline assertion into a false failure waiting to happen. | Wrote `throwsMessageMatching()`, a validator function that asserts on `err.message` explicitly, and used it everywhere a stub's diagnostic prefix is checked — "the same gate, enforced where it is actually checkable" (commit message, invoking standing rule 2). |
| 103 | `9707713` — `task-graph-replay.test.ts` | The tick-loop's original definition of "in flight" as `{running}` only wedged R18 case (b) forever: `retryTask()` sets a task to `ready`, and a `ready` row that never independently settles blocks every higher round from ever seeing it as `done`. | `IN_FLIGHT` redefined as `{ready, running}`, with the reasoning recorded in `simulate()`'s doc-comment, including that it was "found the hard way." |
| 103 | `9707713` — `task-graph-replay.test.ts` | The brief's stub-discipline guard names nine stubs; `readyRule()` is a tenth throwing export and omitting it from the guard would have left a hole. | All ten throwing exports of `task-graph.ts` are covered by the stub-discipline test block, not nine. |

---

## 11. Requirement → artefact table

| Req | Artefact | Status |
|---|---|---|
| **R1** — single migration file, no second | `db/migrations/0040_task_graph.sql`, confirmed the only file added under `db/migrations/` between `main` and `HEAD` (§4's `git diff --name-only --diff-filter=A` run this task: exactly one path). `migrations.test.ts`'s named case asserts `FILES.includes("0040_task_graph.sql")`. | **PROVEN** |
| **R2** — every statement re-runnable | `check-migration-0040.sh` §3 above: pass 2 shows `UPDATE 0` and "IF NOT EXISTS engaged on 5 objects ≥ 5"; snapshots byte-identical across both applications. `migrations.test.ts`'s named case asserts the guarded shape statically. | **PROVEN** |
| **R3** — `depends_on` nullable, default NULL, sentinel semantics | `0040_task_graph.sql` line 52 (no `DEFAULT` clause) + `COMMENT ON COLUMN project_tasks.depends_on` stating the sentinel in the database itself. `check-migration-0040.sh` §3: "E2 SENTINEL" — no `column_default`, no `pg_attrdef` row, `is_nullable = YES`. §8 above states the ruling this discharges (E2, `0ea9d28`). | **PROVEN** |
| **R4** — `workstream text NOT NULL DEFAULT 'main'`, CHECK regex | Schema half: `0040_task_graph.sql` lines 53, 73–84 (`DO $$…$$` guard) + `check-migration-0040.sh` §3: type, default, `NOT NULL`, CHECK existence and exact regex text all asserted against real Postgres. **Validator half not yet built**: `validateWorkstream()` in `task-graph.ts` is a throwing stub (`04-phases.md` assigns it to phase 3, alongside R28). The migration's CHECK comment (line 71–72) states the obligation for phase 3 to match it character for character. | **PARTIALLY PROVEN** — schema half proven now; unit-validator half is phase 3's, by the corpus's own phase assignment (not a gap this phase introduced). |
| **R5** — `write_set text[] NOT NULL DEFAULT '{}'` | `0040_task_graph.sql` line 54 + `check-migration-0040.sh` §3: type `_text`, default `'{}'::text[]`, `NOT NULL`. Same validator-half note as R4: `normaliseWritePath()` is a throwing stub, phase 3's (R28). | **PARTIALLY PROVEN** — schema half proven now; unit-validator half is phase 3's. |
| **R6** — backfill is the full transitive closure | `check-migration-0040.sh` §5 above: 131/131 rows independently re-derived in Python and diffed against the migration's own output, 0 mismatches, widest row 130 ids, exactly 1 root with `{}`. `task-graph-replay.test.ts`'s `backfillClosure()` mirror test (membership + `(round, created_at, id)` ordering) passed as part of §2's suite run. | **PROVEN** |
| **R7** — both named indexes | `0040_task_graph.sql` lines 88–92 + `check-migration-0040.sh` §3: both indexes found by exact name and definition (`USING gin (depends_on)`; `(project_id, workstream, status)`). | **PROVEN** |
| **R8** — safe to apply while the old engine runs (purely additive) | Review: `grep -niE "drop |rename |alter column .* type|not null;" db/migrations/0040_task_graph.sql` (run this task) returns nothing — every statement is `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, a guarded `DO` block, or the backfill `UPDATE` guarded by `WHERE depends_on IS NULL`. No statement renames, drops, retypes, or adds a `NOT NULL` without a default to anything pre-existing. | **PROVEN** (review) |
| **R9** — committed fixture, 6 fields, read-only capture | Cited in full in §6 above from `replay-operator-visibility.md`, written by round 102. This task performed no live read. | **PROVEN** (by citation, per this task's explicit instruction not to re-capture) |
| **R18 (harness only)** — the harness runs and reports | §2 (full suite summary, todo=5/skipped=0) and §7 (each case's exact diagnostic, confirming the legacy-side halves ran and only `graphReady()` blocks the comparison) above. | **PROVEN** |
| **NF3** — tests never touch a database | `grep -n "^import" forge-control/src/lib/task-graph.ts` → one import, `import type { TaskStatus } from "../db/projects.ts"`. Same grep on `task-graph-replay.test.ts` → the only `../db/` import is also `import type`; every other import is a Node builtin or the local `./task-graph.ts` module (both run this task, §NF3 verification below). | **PROVEN** (structural, by import-type grep) — **NOT independently re-verified** by stopping Postgres and re-running `pnpm test` (03-quality.md §1's stated proof-of-obedience); doing so would mean stopping a shared, live Postgres instance the fleet depends on, which is outside this task's write_set and this phase's scope. The type-only-import structure is the mechanical guarantee the "Postgres stopped" run exists to confirm; nothing in this repository's `tsx --test src/lib/*.test.ts` invocation opens a Pool. |

```
$ grep -n "^import" forge-control/src/lib/task-graph.ts
39:import type { TaskStatus } from "../db/projects.ts";

$ grep -n "^import" forge-control/src/lib/task-graph-replay.test.ts
54:import { test, describe } from "node:test";
55:import assert from "node:assert/strict";
56:import { readFileSync } from "node:fs";
57:import { execFileSync } from "node:child_process";
58:import { createHash } from "node:crypto";
60:import {
   ...  (from "./task-graph.ts" — the local module under test, a value import
        of a file that itself only value-imports Node builtins)
74:import type { TaskStatus } from "../db/projects.ts";
```

---

## 12. What could have made this record wrong

Named per standing rule 3, and what closes off each:

**A command run in the live checkout instead of the worktree.** Every command
above was run from `/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`
(confirmed by `pwd` before the `pnpm` commands and by the working directory
implicit in every relative path used). §5's `git -C /opt/forge-ai-os
status --porcelain` is the one command that deliberately targets the live
checkout, and it targets it read-only, exactly as the brief specifies.

**Pasted output from a different SHA.** `git rev-parse --short HEAD` was run at
the start of this task and is `9707713`. Every subsequent proof either was run
at that same SHA with nothing committed in between (this task's write_set is
this file alone, so `HEAD` could not have moved), or is a tool that prints its
own build identity and states it inline: `check-migration-0040.sh`'s header
prints `git HEAD: 9707713` and the sha256 of both the migration and the
fixture it ran against; `task-graph-replay.test.ts`'s banner prints `HEAD
9707713` and `DIRTY (none — all three match HEAD)`. Three independently
printed identities, one commit.

**A summary line quoted without its exit code.** Every command in §§1–5 is shown
with the literal `echo "exit=$?"` this brief specifies, and the exit code is
part of the pasted block, not asserted separately from it — `exit=0` for
typecheck, `exit=0` for the test run (with the full six-line counter block
above it, not just a "PASS" string), `exit=0` for the migration check (with its
own internal assertion census, 36/36, as a second, independent check that the
script's own pass/fail bookkeeping was not miscounted), and `exit=0` for the
live-checkout status check, whose only pass condition — per the brief — is
empty output, and the output shown is empty.

**A self-certifying instrument.** `check-migration-0040.sh` computes R6's
closure **independently in Python**, not by re-running the migration's own
expression against itself (§3, "independent closure verification"), and its own
header states this is deliberate: "The independent check this function is NOT
allowed to lean on is its own output." `task-graph-replay.test.ts` withholds
`round` entirely from the graph side and `depends_on` entirely from the legacy
side (§3 of `03-quality.md`'s red-team brief names this exact attack), so a
"graph" implementation that secretly applied the round rule would diverge
loudly on tick 1 rather than pass by coincidence — this task did not need to
construct that adversarial case itself, because `task-graph-replay.test.ts`'s
own suite (`"the legacy and graph inputs are built separately from the same
rows"`, part of §2's green run) already asserts the structural separation on
every run.

**A pin that no longer resolves.** Every citation in this document to a symbol,
requirement id, or commit SHA was checked against the file it names in this
same task, not carried over from an earlier report: the migration's line
numbers for R3–R7 were read directly out of `db/migrations/0040_task_graph.sql`
in this task (§8, §11); the `throwsMessageMatching` and `IN_FLIGHT` findings in
§10 were read directly out of `task-graph-replay.test.ts` and
`task-graph.ts`'s current content, not out of memory of what a commit message
claimed. §10's round numbers are the one exception, and that exception is
disclosed in §10 itself rather than presented as resolved: they are inferred
from cross-references inside the commits' own text, because this task has no
permitted way to query a task ledger for ground truth.

---

## 13. Round 106 — fix cycle 1: the frozen-closure divergence (F13, R69, E3)

Round 105's reviewer returned `NEEDS_FIXES` on three points. All three are
addressed here; the first two are one problem and one ruling.

### 13.1 The finding, restated in one paragraph

`depends_on` is **frozen**. R6's backfill writes the closure of the rows that
exist at the instant 0040 runs; today's rule is evaluated continuously against
the current task set. R64 applies 0040 *before* the restart, and
`safe-restart.sh` may then wait up to 43200 s for a quiet fleet. Through that
window the old engine keeps inserting rows — `createFixChain` at `round + 1` and
`round + 2`, whose `INSERT INTO project_tasks` names its columns and omits
`depends_on`, so both are born `NULL` (E2). **No frozen closure can name them.**
After the restart a backfilled row promotes as soon as its frozen deps drain and
runs straight past a fix chain numbered far below it. Today's engine holds it.

The reviewer's second observation was the sharper one: the harness could not see
this, because `graphInput()` computed the closure over the *whole mutated row
list*. Cases (b) and (c) therefore modelled migrate-after-insert. Reality in the
deploy window is insert-after-migrate. All five cases could go green in phase 2
with the hazard live.

### 13.2 Reachable on the deploy's own target, from the committed fixture

Derived from `replay-operator-visibility.json` (sha `e0cb69a5…`, unchanged by
this round), not from memory:

| Quantity | Value |
|---|---|
| highest `done` reviewer round | 1306 |
| fix chain `createFixChain` would insert | **1307 / 1308** |
| rows not `done` at capture | 3 `running` @ 1350, 8 `pending` @ 1352–1870 |
| rows below 1307 that are not `done` | **0** |

So the chain lands strictly below every open row: today's rule holds all eleven
behind it, and a closure-only graph branch holds none of them.

### 13.3 The ruling — E3, option (a)

Recorded in `02-architecture.md` §9.2, reasoned in §3.2.1, tabled as **F13**,
required as **R69**: the graph branch additionally refuses a candidate while any
*legacy* row of the same project in a strictly lower round is not `done`.

The two alternatives lost on the record. Moving the backfill to a quiet fleet
was already rejected in §2.2 and cannot be rescued by a `safe-restart.sh` hook —
"quiet" is a 45-second heartbeat window and a project tick can fire inside it,
so the race shrinks but does not close. Accepting the divergence contradicts R18
and the Definition of Done on a hazard reachable on 8ea0cc08 itself.

Taken by this round under fleet escalation policy rule 3: stated as a default,
escalated to the manager chat and by reminder in the same turn, not blocked on.
Konrad may overrule it; the change would be localised to R69, §3.1's SQL, F13
and case (f).

### 13.4 THE MUTATION TEST — the term is load-bearing, and case (f) can fail

The one thing that would have made this round's work worthless is a case (f)
that passes in phase 2 whether or not R69 exists. So it was measured before it
was written down. `graphReady()` and `readyRule()` were filled in a **scratch
copy** of `task-graph.ts` (`/tmp/task-graph.stub.bak` held the committed stub;
it was restored immediately, and `git diff` over `task-graph.ts` shows only the
doc-comment changes this round declares).

**Variant A — closure-only graph branch, no legacy-row term:**

```
    ok 1 - (a) the base fixture, straight through
    ok 2 - (b) an early round retried to ready after a later round drained
    ok 3 - (c) a task inserted into an already-drained round
    ok 4 - (d) a project paused mid-run and resumed
    ok 5 - (e) a permanently failed task — both schedulers wedge identically
not ok 6 - (f) a fix chain inserted by the OLD engine AFTER 0040 was applied
  R18-f fix chain inserted after the migration: promotion order diverged —
  first divergence on tick 2: legacy promoted [], graph promoted
  [511070c9-eab0-4a51-9b1b-3583b8e4007d, 608dbecb-f59d-4745-99b3-1d5636febd1f];
  only-legacy []; only-graph [511070c9-…, 608dbecb-…]
```

The two ids are the fixture's round-1352 pair. **Five green cases, one red** —
which is precisely the reviewer's point: the original five could not see this.

**Variant B — the same, plus the legacy-row term:**

```
    ok 1 - (a) … ok 2 - (b) … ok 3 - (c) … ok 4 - (d) … ok 5 - (e) …
    ok 6 - (f) a fix chain inserted by the OLD engine AFTER 0040 was applied
```

Zero divergence, all six. The only failures in that run were
`graphReady()/readyRule() throws a task-graph: diagnostic` — the phase-1 stub
discipline correctly objecting to stubs that no longer throw, which is itself
evidence the probe was really in effect.

Both variants were produced by `/tmp/probe.py`, which rewrites the two stub
bodies by exact string replacement and nothing else. The committed tree carries
neither variant: `grep -c "lands in phase" src/lib/task-graph.ts` → **10**, all
stubs intact.

### 13.5 What the harness now does differently

- `graphInput(rows, opts)` takes an explicit **migration-time snapshot**. Rows in
  it get the closure computed over the snapshot *alone*; rows outside it get
  `depends_on: null`. Omitting the option means "everything was there", so cases
  (a)–(e) are unchanged, and they are now *labelled* migrate-after-insert rather
  than being that by accident.
- **Round withholding is decided from the output, not the option**: withheld iff
  no row came out legacy. A mixed input must carry real rounds, because R69's
  term *is* a round predicate and a withheld round would make case (f) fail for
  an artefact of the instrument. Guard 3 in the harness header is amended where
  it is enforced (standing rule 2) and the trade is stated plainly: the
  "graph side is secretly applying the round rule" guard now lives in five
  pure-graph cases instead of six. `graphInput(FIXTURE, {snapshot: <all ids>})`
  is asserted to still withhold, so the guard cannot be dropped by passing an
  option.
- `GRAPH_RULE` dispatches through `readyRule()`, mirroring the SQL's two
  branches, so a mixed project's legacy rows are judged by the legacy branch
  rather than by a `graphReady()` widened to understand NULL. Consequence to
  expect: the six `todo` cases now report `task-graph: readyRule() lands in
  phase 2 (R12)`, not `graphReady()`'s message.
- A **non-`todo`** `F13` block proves every premise R69 rests on *without*
  `graphReady()`: the chain is legacy, no frozen row names it, mixed/pure round
  handling, `graphInput()`'s two refusals, and today's rule holding all eight
  captured pending rows behind the chain.

**One claim in that block was written wrong first and the harness rejected it.**
The draft asserted that *every* captured pending row's frozen closure drains on
tick 1. It does not — a row at 1353 has 1352's pending rows inside its closure
and is genuinely held by them. The test failed with *"frozen dep 608dbecb… of
52703dc0… is 'pending'"*, and the claim was narrowed to the lowest pending
round, which is where the divergence actually lives. Recorded because an
instrument that catches its own author is the only kind worth pasting.

### 13.6 The third finding, and two the reviewer disclosed

- **`DepsField` doc-comment cited E1 for the NULL sentinel.** It is **E2**;
  fixed. E1 is the separate ruling that `round` stays stored.
- **`E7 / R8 / R13`**, which round 105 reported as inherited and non-blocking:
  the two sites in this phase's files now cite **R13** and say explicitly that
  `E7`/`R8` is `db/projects.ts`'s own lineage pin on `main` and does not resolve
  in this corpus. A pin a reader cannot resolve is now labelled as attribution
  rather than left to be followed.
- **R18 naming `task-graph.test.ts`** while §2.1 and `04-phases.md` name
  `task-graph-replay.test.ts` — left as the reviewer found it, two-to-one, and
  still recorded here.

### 13.7 Verification, this round

```
$ pnpm typecheck                     → TYPECHECK_EXIT=0
$ pnpm test                          → 1..176  # tests 838  # pass 832
                                        # fail 0  # skipped 0  # todo 6
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
    OK — R1..R69 and NF1..NF7 complete, all three statements of the map agree
```

`# todo` went 5 → 6 (case f). `# tests` went 832 → 838: case (f) plus the four
non-`todo` F13 tests, less one that was rewritten. `# fail 0`, `# skipped 0`
throughout. The corpus checker was run *because* it exists and it caught a real
omission mid-edit — R69 mapped in `01-requirements.md` §K but not yet in
`04-phases.md` §9 — which is the second instrument this round that failed
before a human did.

`scripts/checks/check-migration-0040.sh` was **not** re-run: this round changed
no SQL, and the migration's sha256 is unchanged. `db/migrations/0040_task_graph.sql`
is not in this round's diff.
