# 01 — Requirements: engine-task-graph

Base commit of this corpus: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e`.

Every requirement is numbered, testable, and mapped to exactly one phase in
`04-phases.md`. **Cite these ids** in briefs, commits and reviews — never a bare
line number.

Legend for **How proved**: `unit` = a `node:test` case under
`forge-control/src/lib/*.test.ts`; `check` = a script under `scripts/checks/`
runnable from the worktree; `review` = a reviewer must read and state it;
`live` = provable only in the phase-8 deploy/verify task.

---

## A. Schema and migration — phase 1

**R1.** A single new migration `db/migrations/0043_task_graph.sql` adds every
column, index and backfill this project needs. No second migration file.
*How proved:* unit — `migrations.test.ts` lints it; `git ls-files db/migrations`
shows exactly one new file.

**R2.** Every statement in 0040 is re-runnable: `ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX ... IF NOT EXISTS`, and the backfill `UPDATE` guarded by a
predicate that makes a second application a zero-row no-op. There is no
migration ledger and no runner in this repo — applying a migration is a manual
`psql -f`, and the only defence against applying it twice is the statement
itself. *How proved:* unit — a new case in `migrations.test.ts` naming
`0043_task_graph.sql` explicitly, in the shape of the existing 0039 case.

**R3.** `project_tasks.depends_on uuid[]`, **nullable, default NULL**.
`NULL` means *"this task was never graph-scheduled — apply the legacy round
rule"*. A non-null array — **including the empty array** — means *"graph-scheduled;
these and only these are my predecessors"*. The distinction is load-bearing and
is the reason the default is not `'{}'`; see `02-architecture.md` §3.2 and the
deviation note in §9.
*How proved:* unit + review — the column comment in the migration states the
sentinel, and the promote-rule tests exercise NULL, `'{}'` and populated.

**R4.** `project_tasks.workstream text NOT NULL DEFAULT 'main'`, constrained to
`^[a-z0-9][a-z0-9-]{0,39}$` by a CHECK. The charset is the intersection of
"safe in a git branch name", "safe in a directory name" and "readable in a
Kanban chip". *How proved:* unit (the pure validator) + review (the CHECK exists
and matches the validator's regex character for character).

**R5.** `project_tasks.write_set text[] NOT NULL DEFAULT '{}'` — repo-relative
POSIX paths of the files a task intends to write.
*How proved:* unit — validator tests.

**R71. `project_tasks.graph_frozen boolean NOT NULL DEFAULT false`, set `true`
by the backfill UPDATE that writes the closure — the same statement, the same
transaction. ADDED ROUND 242 (E4, `02-architecture.md` §9.3).** It records the
PROVENANCE of `depends_on`: `true` on exactly the rows 0040 derived a closure
for, `false` on every row any engine wrote itself, before or after the migration.
Nothing else ever writes it.

**Why a recorded fact and not an inferred one — this is the requirement's whole
content.** R69 needs to know whether a row's `depends_on` was derived from a
round number against a snapshot or declared by a planner, because only the first
is untrustworthy against rows that did not exist when it was written. Round 223
built and measured all four ways of inferring that after the event and each
failed in its own direction (§9.3's table). A fact the process knows at the
moment it is true must be recorded then, by that process; inferring it later is
archaeology, and archaeology is what five separate defects in this project have
had in common.

*How proved:* `check` — `scripts/checks/check-migration-0040.sh` asserts the
type, the `NOT NULL DEFAULT false`, that the marker and the closure agree on
every row, that a row inserted AFTER the backfill by an INSERT not naming the
column is not frozen, and that a second application marks nothing new; unit —
`migrations.test.ts` pins the guarded ADD COLUMN and the `graph_frozen = true`
clause inside the one backfill statement.
*Retired with:* R12's legacy branch and R69, in one commit, when no frozen row
remains (NF6, standing rule 4) — it is legacy surface, not graph vocabulary.

**R6.** 0040 backfills `depends_on` for every row that exists at migration time,
per project, as **the full set of ids of every task in a strictly lower round of
the same project** (the transitive closure of today's rule, written out).
Not "the previous round" — see `02-architecture.md` §3.3 for why the
previous-round-only backfill is *not* an exact replica under retry.

**"At migration time" is load-bearing, and it is not free** (round 106). The
closure is *frozen*: it names the rows that existed at the instant 0040 ran, and
it can never learn of a row inserted afterwards. Because 0040 is applied before
the restart (R64), the old engine goes on inserting NULL-deps rows in the gap,
and none of them appear in any frozen closure. R6 alone is therefore **not** an
exact replica of today's rule for a project that straddles the deploy; R69 is
the term that restores it **for every row created under the old semantics**,
`02-architecture.md` §3.2.1 is the reasoning, F13 is the failure mode, and R18
case (f) is the test. Widening the backfill is *not* an alternative — it would
have to name rows that do not yet exist.

**NARROWED ROUND 223, RESTORED ROUND 242 (E4, `02-architecture.md` §9.3).** This
clause read *"R69 is the term that makes it one"* — one meaning an exact replica
for the whole straddling project. Under R69 as round 106 landed it that was
false: a row the NEW engine inserts after the restart carries real graph fields
(R42), so a term testing the BLOCKING row's `depends_on IS NULL` could not see
it, and a frozen row above it promoted where today's engine holds it. Measured,
not conceded: `scripts/checks/check-r69-straddle.sh` put the divergence on tick
2, on the same two rows §3.2.1 records for F13.

**R69 now keys on the CANDIDATE's `graph_frozen` (R71)**, so R6's closure plus
R69's term is again an exact replica for the whole straddling project — and that
is a measurement, not a restored adjective: probe 1b of the same script shows
the straddle matching today's engine tick for tick, and probes 1 and 1c show the
divergence returning the moment the marker is cleared or the term deleted from
the source. F14 is retired with this clause, in one commit (standing rule 4).
*How proved:* unit (R18's replay test over the committed fixture) + `check`
(`scripts/checks/check-migration-0040.sh` applies 0040 twice to a throwaway
Postgres schema seeded from the fixture and diffs the resulting rows).

**R7.** 0040 creates `CREATE INDEX IF NOT EXISTS project_tasks_depends_on_gin ON
project_tasks USING gin (depends_on)` and `CREATE INDEX IF NOT EXISTS
project_tasks_workstream_idx ON project_tasks (project_id, workstream, status)`.
*How proved:* review + the migration lint.

**R8.** 0040 is safe to apply while the **old** engine is running: purely
additive, and no statement the old engine executes names any new column.
Applying it early is therefore the correct deploy order.
*How proved:* review — a grep in the deploy brief showing the live tree's
`INSERT INTO project_tasks` statements name their columns explicitly.

**R9.** A committed fixture `forge-control/src/lib/fixtures/replay-operator-visibility.json`
carries the real task list of project `operator-visibility` (8ea0cc08):
`{id, round, role, title, status, created_at}` per task, and nothing else — no
briefs, no run ids, no secrets. It is captured **once**, in phase 1, by a
read-only query, and committed. Tests never touch the live database.
*How proved:* unit — the fixture loads and has > 100 rows; review — no brief
text present.

---

## B. Graph scheduling — phase 2

**R10.** A new pure module `forge-control/src/lib/task-graph.ts` holds every
scheduling *decision* as a synchronous function over plain objects: readiness,
depth, cycle detection, write-set contention, workstream grouping. It imports
`db/*` **type-only**, exactly as `project-reconcile.ts` does, so a value import
can never open a pg Pool in the test process.
*How proved:* unit + review — `grep -n "^import" task-graph.ts` shows only
`import type` from `../db/`.

**R11.** `promoteReadyTasks()` promotes a `pending` task to `ready` when
`depends_on IS NOT NULL` and every id in it belongs to a task with
`status = 'done'`. An empty array is trivially satisfied and promotes
immediately. **`round` is not consulted: an undrained round never holds a
graph-ready candidate.** *How proved:* unit over the pure rule; `check` against a
throwaway Postgres for the SQL.

**AMENDED ROUND 974 — R72 SUPERSEDES THE MULTI-ROOT HALF OF THIS CLAIM, and its
gate clause moved in the same commit (standing rule 4).** R11 answers *may this
row run at all*; R72 answers *how many rows of one checkout may run at once*.
Until round 972 nothing distinguished them, and `check-scheduler-sql.sh` case 1
measured both in one fixture: its candidate and the undrained lower-round row
both sat in workstream `main`, so "promotes with its round undrained" was
entangled with "two rows of one checkout promote in one tick". The lane cap ends
the second, and the case duly failed on its second assertion at `84aac00` —
found by round 973's reviewer, reproduced from a clean tree before anything here
was edited. What R11 itself claims is unchanged and is still measured: case 1's
candidate now sits in workstream `alpha` while the undrained row stays in `main`,
so the round is the only thing that could hold it, and it promotes. **Case 1b is
the retired half, stated as a requirement instead of left as a silent
regression:** two graph roots in ONE lane, exactly one promotes, the sibling is
held `pending` and promotes on the next tick once the lane frees. Within-lane
multi-root promotion is RETIRED — not merely untested. The same round separated
five other fixtures that had quietly depended on it (cases 2, 5, 5b, 6, 7); each
is named in `evidence/round974-fix-cycle-2.md` §2.

**R72. The lane cap: at most one live task per (project, workstream). SHIPPED
ROUND 972, RECORDED HERE ROUND 974.** A `pending` row is not promoted while its
own `(project_id, workstream)` already holds a row in `('ready','running')`, and
at most one row per lane is promoted by any single call. One worktree per
workstream (R32–R35) isolates LANES; it does not isolate TASKS WITHIN a lane, and
R11's rule alone will make several rows of one workstream `ready` on one tick —
all of them pointing at the same checkout, the same index and the same
`git status`. Measured live on 2026-08-19 on project `os-usable-for-work`: three
lanes each carrying two live rows, one of them a fix builder writing the tree a
reviewer was concurrently gating. That is not waste, it is a wrong answer — a
verdict written against a tree that moved under it. **Two halves, because either
alone is insufficient:** a `NOT EXISTS … status IN ('ready','running')` term for
rows that were already live when the statement started, and a
`row_number() OVER (PARTITION BY project_id, workstream ORDER BY round, created_at, id)`
tie-break for candidates of an EMPTY lane, which all satisfy the first term
against the statement's opening snapshot. The cap is keyed on the CHECKOUT, never
on `write_set`: two tasks of one lane share a branch, an index, a stash and a
`git status`, so byte-disjoint file sets do not make the checkout safe (the
rejected alternative is recorded in the `promoteReadyTasks()` doc-comment).

It caps the AUTOMATIC route only. `retryTask()` moves a whole (round, workstream)
group to `ready` by hand and is deliberately untouched — an unwedge has a human
behind it. `selectClaimable()`'s claim-time contention belt (R16/R17) is a
separate layer, one level down, and is also untouched.

**It lives in SQL rather than in `lib/task-graph.ts`, against §1.2's rule, and
that is deliberate:** `readyRule()`/`graphReady()` answer a per-row question and
are unchanged, while this is an ADMISSION CAP on a physical resource that must be
atomic with the write creating the live row. Computed in TypeScript it would be a
read-then-write with a window in it — the shape of the bug, not of its fix. A
later round wanting the pure mirror must mirror "at most one live row per lane",
not a per-row predicate.

*How proved:* `check-scheduler-sql.sh` **case 1b** — one lane's second root is
held `pending` while a different workstream's root promotes in the same tick, and
the held row promotes on the following tick once its lane frees, so the cap is
shown to be a delay and not a deadlock. The same case asserts THE MIRROR on the
held row: `graphReady()` still answers `true` for it, which is what makes "the
cap is not the ready rule" a measurement rather than a doc-comment's promise.
Plus `forge-control/src/db/projects.test.ts` against a scratch database.

**THE HOLE THIS ENTRY CLOSES, named rather than quietly filled.** Round 972
shipped the cap and cited "R72" from `db/projects.ts`, `04-phases.md` §10 and its
own commit message — but no R72 was ever defined here, so `check-corpus-map.py`
saw a contiguous R1–R71 and reported nothing, and the requirement whose gate had
just broken did not exist to be reconciled with. A requirement id that is live in
code and absent from this file is invisible to every consistency check the corpus
owns.

**R12.** `promoteReadyTasks()` retains the legacy branch: when
`depends_on IS NULL`, the task promotes under today's rule — no task of the same
project in a strictly lower round is anything other than `done`. Both branches
live in **one** statement, so a task can never satisfy neither.
*How proved:* unit + `check`.

**R69. The straddle term.** The graph branch additionally refuses a candidate
while any row of the same project in a strictly lower round is not `done`, where
"any row" means — **and the asymmetry is the requirement** — ANY such row when
the candidate itself carries `graph_frozen` (R71), and only a **legacy row**
(`depends_on IS NULL`) when it does not.

    NOT ready while ∃ o : o.round < candidate.round
                        ∧ o.status <> 'done'
                        ∧ (candidate.graph_frozen ∨ o.depends_on IS NULL)

A candidate whose closure the MIGRATION derived has no other ordering to be
judged by; a candidate that declared its dependencies has said everything it
needs to, except against a row created under the old semantics, which never got
to declare anything. **WIDENED ROUND 242 (E4, §9.3)** — through round 241 the
term read the blocking row's sentinel alone. Without it a backfilled row, whose closure
was frozen when 0040 ran (R6), promotes straight past a row the old engine
inserted afterwards — `createFixChain`'s builder at `round + 1` and re-reviewer
at `round + 2`, both born NULL — because no frozen closure can name them. On
`operator-visibility` that chain lands at 1307/1308, below every one of its
eight `pending` rows, so the hazard is reachable on the deploy's own target.
Ruled as **E3** in `02-architecture.md` §9.2, widened as **E4** in §9.3,
reasoned in §3.2.1 and §3.2.2, tabled as **F13**. On a project planned after the
restart no row is frozen and no row is NULL, both sides of the disjunct are
false, and `round` is never consulted — measured at 3 ticks / 8-wide against the
same widening ungated at 17 / 1-wide, so "it costs only where it must" is a
reading rather than a claim. It is part of the legacy surface: **deleted in the
same commit as R12's branch and R18 cases (f) and (g)**, when no NULL and no
frozen row remains (NF6, standing rule 4).
*How proved:* unit — R18 case (f) fails without the term and passes with it
(mutation transcript in `evidence/phase1-migration.md` §13.4), R18 case (g) fails
without the marker and passes with it, with a POSITIVE CONTROL in the same file
that clears `graph_frozen` and asserts the divergence returns; + `check` for the
SQL (`check-scheduler-sql.sh` cases 5 and 5b, the second carrying two candidates
identical but for the marker) and `check-r69-straddle.sh` for the schedule.

**WHAT R69 DID NOT HOLD, AND WHAT NOW HOLDS IT — round 223 bounded it, round 242
closed it (E4, `02-architecture.md` §9.3).** Through round 241 the term tested
`depends_on IS NULL`, so it saw rows the OLD engine wrote and nothing else, and a
fix chain the NEW engine creates after the restart (R42) went unseen — F14. That
was **accepted on the record, not overlooked**, for one reason: option A's
arithmetic was right and it had no implementable gate. Round 223 built and
measured all four candidates and each failed differently — the sentinel gate
silent on a straddle with no gap row and firing on one only by coincidence;
`isClosureShaped()` reading 8/8 exposed rows as frozen before the post-restart
chain exists and 0/8 after; a `created_at` horizon right on the straddle and
taking a post-restart project from 3 ticks / 8-wide to 17 / 1-wide; ungated the
same collapse.

**The gate now exists because the fact is recorded (R71).** Marking a frozen row
costs one additive column and, where nothing is frozen, exactly nothing — the
same S3 fixture that convicted every inferred gate is byte-identical under the
marker. F14 is retired with this paragraph, in the same commit as the term it
described (standing rule 4). Round 223's four measurements are kept and still
run, as the pre-242 arms of `check-r69-straddle.sh`: they are the argument for
the column, and an argument whose measurements have been deleted is an assertion.

*How the boundary is proved:* `check` —
`scripts/checks/check-r69-straddle.sh`, 14 probes, which is also the instrument
that would catch a later round quietly widening or narrowing the term. It needs
no database: it composes the SHIPPED `graphReady()` over the R9 fixture with and
without the marker, and against a copy of the module with the term deleted, and
it exits non-zero if a probe did not run.

**R13.** `promoteReadyTasks()` keeps the `AND p.status = 'active'` gate joined
from `projects`, unchanged in meaning: paused, blocked, done and cancelled
projects promote nothing, and the gate is a filter rather than a state change so
a resumed project continues exactly where it stopped.
*How proved:* unit + review; the existing behaviour is documented on
`promoteReadyTasks` in `db/projects.ts` and must survive verbatim.

**R14.** **A corrupt `depends_on` is a hard error, never a silent promotion.** If
`cardinality(depends_on)` differs from the number of `project_tasks` rows **of
the same project** whose id appears in it, the task is moved to `blocked`, the
project is set `blocked`, and a notification names the task and the offending
ids. A `NOT EXISTS (... status <> 'done')` predicate alone would read a vanished
dependency as satisfied and release the task — the silent-fallback shape this
fleet forbids.

**RESTATED IN ROUND 204, WHERE IT IS ENFORCED (standing rule 2), because as
shipped it was a guarantee with three holes in it.** Each was measured against
the shipped functions, not argued; the fixes and their negative controls are in
`evidence/phase2-fix-cycle-1.md`. The requirement now says what it must, in three
parts:

- **THE THREE SHAPES OF CORRUPTION, and the semantics for each.** A mismatch has
  exactly three possible causes, and all three are corruption: an id naming **no
  row** (the dangling dep this requirement was written for); an id naming a row
  **of another project** (R27's precondition violated — the count is
  project-scoped, so a foreign row satisfies nothing); and **the same id twice**
  (`cardinality` counts elements, the comparison counts rows). The duplicate case
  is settled here rather than left to two functions to disagree about: it is
  corruption, because nothing in this engine writes one — the R6 backfill
  aggregates over distinct rows of one project and R28 normalises before storage
  — so a duplicate in the column means an **unvalidated writer**, whose intent is
  unknown. `graphReady()` and the SQL must refuse all three **identically**;
  where the SQL distinguishes them it is only to write a truthful notification.
  `taskDepth()` is the deliberate exception and stays benign for both an absent
  id and a duplicate: it is DISPLAY code, and refusing to draw a board is an
  outage where the promotion path's refusal is a repair.
- **NO ROUTE INTO `running` MAY BYPASS IT.** There are three, and closing only
  the first is what made this a guarantee that did not hold. (i) `promote` — the
  cardinality equality in the graph branch. (ii) `retryTask()`, and therefore
  `unwedgeProject()` and `POST /api/tasks/:id/retry` — a `blocked` row whose
  `depends_on` is still corrupt is refused with a reason naming the ids, checked
  before the attempt cap and **not** overridable by `force`, because `force`
  overrides a budget and not a fact. Without this the sweep's own notification
  invited the operator to walk the row into `ready`, where a `pending`-scoped
  sweep could not see it and `claimReadyTasks()` — which re-checks contention but
  never dependency integrity — gave it a run. (iii) Any **out-of-band** write
  (`psql`, an import, a future writer) that leaves a corrupt row at `ready`: the
  sweep covers `pending` rows AND `ready` rows with no `run_id`, and runs before
  the claim in the same tick. Still never a `running` row, and never a `ready`
  row with a run attached — blocking one of those would strand a live run and
  lose its output.
- **THE LOUD HALF IS THE SWEEP, NOT A CLAIM-SIDE FILTER.** A candidate `SELECT`
  in `claimReadyTasks()` that quietly skipped a corrupt `ready` row would trade a
  silent promotion for a silent stall — the same disease in a new costume. The
  sweep blocks and notifies instead.

*How proved:* unit — `graphReady()` throws `GraphIntegrityError` on an absent id
and on a duplicated id, naming every offender of every shape. `check` —
`check-scheduler-sql.sh` cases 3/4 (dangling → `blocked`, one notification), 8
(the retry refusal, then a claim that does not claim it), 8b (a corrupt row
written straight to `ready` is still swept), 9 (a duplicate blocks, and
`graphReady()` agrees), 10 (a cross-project id resolves to nothing on both
sides). Each of the four new cases asserts **the mirror** by driving the real
`graphReady()` over the same rows, and each was observed failing against the
unfixed code.

**R15.** `claimReadyTasks()` keeps `FOR UPDATE OF pt SKIP LOCKED`, keeps the
`p.status = 'active'` join, keeps marking `running` inside the same transaction,
and keeps its `LIMIT`. Only the *ordering* and the contention filter change.
*How proved:* review + unit on the ordering helper.

**R16. Computed contention.** Within one `(project_id, workstream)`,
`claimReadyTasks()` will not claim a task whose `write_set` intersects the
`write_set` of a task of that same workstream currently `running`, or of another
task claimed in the same pass. Such a task stays `ready` and is claimed on a
later tick. Path comparison is exact string equality on normalised
repo-relative POSIX paths; a directory prefix does **not** count as an
intersection (declaring `src/` to own a subtree is out of scope — declare the
files).
*How proved:* unit — a table of write-set pairs against the pure
`conflicts(a, b)` and `selectClaimable(candidates, running)`.

**R17.** An **empty** `write_set` intersects nothing and is therefore always
claimable — this is exactly today's behaviour (all tasks share one worktree and
run in parallel). The engine logs one `console.warn` per spawn naming a
`builder`-role task with an empty write set.

**TWO CLAUSES, TWO PHASES. Amended round 202, where it is enforced (standing
rule 2), because as written it was unsatisfiable inside phase 2's declared file
ownership** — and an unsatisfiable gate disclosed-and-proceeded is what teaches
reviewers that disclose-and-proceed is normal.

- **The CONTENTION clause is phase 2's** and is discharged there: `conflicts()`
  returns `false` the moment either side is empty, and `selectClaimable()`
  therefore claims such a task unconditionally.

  **THE R18 REPLAY IS NOT ITS PROOF, and said so here until round 204.** Four
  places credited it, on the reasoning that every fixture row carries `'{}'` and
  the replay still reproduces today's order. The replay never executes the rule:
  `task-graph-replay.test.ts` imports neither `conflicts` nor `selectClaimable`,
  and its `simulate()` moves rows `pending → running` with no claim step, so no
  write-set of any shape is ever consulted. Measured before the claim was struck:
  inverting the empty-set rule to `return true` leaves all 35 replay tests green,
  including all six R18 cases. An instrument credited with a proof it does not
  perform is standing rule 3's exact failure mode, and it inflated this
  requirement's proof base in the corpus itself. The real proof is named below.
- **The WARN clause is phase 4's.** It lives in the SPAWN path, in
  `forge-control/src/lib/project-tick.ts`, a file §10 of `04-phases.md` assigns
  to phases 4 and 5 and which phase 2 does not write. Phase 2 could satisfy it
  only by writing outside its ownership; phase 4 owns the spawn path and takes
  it, as numbered deliverable 10 of Phase 4. R17 therefore appears in the phase
  4 row of §K below and of `04-phases.md` §9, as a deliberate split, exactly as
  R18 does across phases 1 and 2.

  **DELIVERED, round 222 (phase 4C).** `emptyWriteSetWarning(task, projectName)`
  in `lib/project-tick.ts` returns the message or `null`; `spawnTaskRuns()` calls
  it exactly once, immediately after the `[project-tick] spawned …` line, so the
  warning is one per SPAWN and not one per tick. It is a function rather than an
  inline `if` precisely so that this requirement's stated proof — *"the warning
  fires for `builder` and not for `scout`"* — is a unit test over the rule and
  its text rather than a regex over a source file. Both clauses of R17 have now
  landed; the requirement is complete and the split can be retired whenever R17
  itself is.

*How proved:* **contention (phase 2)** — unit: `conflicts()`'s empty-set table
cases and `selectClaimable()`'s *"empty write-sets are always claimable"* case in
`task-graph.test.ts`; `check`: case 7 of `check-scheduler-sql.sh`, which drives
the shipped `claimReadyTasks()` against a real Postgres and asserts the
empty-write-set row is claimed while a colliding sibling is deferred. That is the
whole of its proof base — **not** the R18 replay, for the reason recorded above.
**Warn (phase 4)** — unit: the warning fires for `builder` and not for `scout`.

**R18. The replica proof.** `task-graph-replay.test.ts` replays the R9 fixture through
two implementations of the promotion rule — `legacyRoundReady()` and
`graphReady()` — driving a simulated tick loop until every task is `done`, and
asserts the two produce **identical promotion order**: the same set of tasks
promoted on the same tick, for every tick. The harness prints the fixture's row
count and its own git SHA before asserting.
Divergence cases the test must include explicitly, each as its own case:
  a. the base fixture, straight through;
  b. a task in an early round retried to `ready` after a later round has
     completed (the case that breaks a previous-round-only backfill);
  c. a task inserted into an already-drained round;
  d. a project paused mid-run and resumed;
  e. a failed task that never completes — both schedulers must wedge identically;
  f. **insert-after-migrate** (added round 106) — the closure is frozen over a
     migration-time snapshot, and a fix chain is then appended carrying
     `depends_on: null` at a round *below* every non-`done` row, exactly as
     `createFixChain` would in the gap R64 opens. Cases (b) and (c) model the
     opposite order (the row existed when the backfill ran); until this case
     existed the harness could only ever see that order, and the divergence F13
     names was invisible to it. The case fails without R69 and passes with it.
*How proved:* unit. **A single divergence fails the suite.**
The harness's graph side dispatches on the `depends_on` sentinel through
`readyRule()`, so a mixed input's legacy rows are judged by the legacy branch —
the same two-branch shape as the SQL, rather than a `graphReady()` widened to
understand NULL.

**FILE NAME CORRECTED, round 202.** Through round 106 this paragraph opened
`task-graph.test.ts`. It was the **odd one out**: `03-quality.md` §2.1 and
`04-phases.md` Phase 1 both said `task-graph-replay.test.ts`, and the file
phase 1 shipped is `forge-control/src/lib/task-graph-replay.test.ts`. Round 103
recorded the discrepancy rather than resolving it silently, which was right at
the time and is no longer enough: phase 2 created `task-graph.test.ts` as a
**separate, real file** for the pure-function cases (`readyRule`, `graphReady`,
`taskDepth`, `conflicts`, `selectClaimable`), so the old prose now points at a
file that exists and does not contain the replay. That is a pin which reads as
authoritative and is wrong — the exact failure mode standing rule 1 exists to
kill — so it is corrected here rather than carried another round. The two files
are distinct by design and `03-quality.md` §2.1 says why: the replica proof is
the single most important test in the project and must be findable.

**R19. Derived depth.** `taskDepth(tasks)` in `task-graph.ts` returns the
longest-path depth from the roots for every task, in one pass over a topological
order, and is total: a task whose `depends_on` is NULL gets its `round` as its
depth so mixed projects still render. It is computed for display only and is
never written to the database.
*How proved:* unit — depth over hand-built graphs, including a diamond, a wide
fan-out, and a NULL/array mixture.

**R20.** `round` is removed from the scheduler entirely: no promotion or claim
predicate reads it except inside the explicitly-labelled **legacy surface** —
R12's legacy branch and R69's legacy-row term, which are the same surface and
retire in the same commit. **Amended round 106**: the term reads `round`, and
saying so here is the point, because a gate that forbade it would have been
unsatisfiable the moment E3 was ruled, and an unsatisfiable gate is what teaches
reviewers to disclose and proceed. R69 reads `round` only *about legacy rows*,
and only while any exist.
*How proved:* **`scripts/checks/check-r20-census.py`** — generated, not reviewed.
**Amended round 206**, replacing *"review — `grep -n "round" db/projects.ts` and
a stated justification for every surviving occurrence"*: that phrasing made the
proof a hand-written census, which rotted twice (round 205 found it 14 lines
stale) and which never actually asserted the requirement — a census that counts
admits a new predicate the moment somebody adds a row for it. The script asserts
R20 directly: every non-comment `round` line inside `promoteReadyTasks`,
`claimReadyTasks` and `sweepDanglingDependencies` must appear in
`ALLOWED_SCHEDULING_LINES` with a justification, and a new one fails by name.
The attributed census it generates into `evidence/phase2-replay.md` §7 is the
review artefact; `--self-check` calibrates the instrument against `27d300f`.

**R21.** `spawnTaskRuns()`'s TypeScript-side belt is preserved unchanged: a task
whose project stopped accepting work between claim and spawn is handed back to
`ready`, no run is spawned, and the project is not blocked.
*How proved:* review; the behaviour is documented inline in `project-tick.ts`.

---

## C. Task creation, validation, cycle detection — phase 3

**R22.** `POST /api/projects/:id/tasks` accepts three new optional body fields:
`depends_on: string[]`, `workstream: string`, `write_set: string[]`. Every
existing field keeps its exact current validation **except `round`, amended
twice by operator ruling in round 213 and stated here rather than left to the
task briefs** — see R22a.
*How proved:* unit over the extracted pure validator + `check` against a
locally-mounted router (the single-router probe pattern; **not** the live
service).

**R22a. `round`, when supplied, must be a non-negative integer ≤ 2147483647.**
Phase 3's contract table said "not a non-negative **finite** integer → 400", and
that wording refused nothing at either end: `Number.isFinite(1.5)` is true and
`Number.isInteger(2147483648)` is true, while `project_tasks.round` is declared
`round int` in `db/migrations/0030_coding_projects.sql`. Both values therefore
reached the `INSERT` and came back as **500**s — measured, `check-task-api.ts`
cases 2c and 2d: SQLSTATE `22P02` *invalid input syntax for type integer: "1.5"*
and SQLSTATE `22003` *integer out of range*, both out of `pg_strtoint32_safe`.

A 500 says *"the server is broken"* for a request that was merely malformed, and
that contradicts this phase's own error split one file away —
`GraphValidationError` = refused CALLER input = `400`, `GraphIntegrityError` =
corrupt STORED graph = `500`. A supplied `round` is caller input at both ends.
So the guard in `routes/projects.ts` reads `Number.isInteger(round)`,
`round >= 0` and `round <= MAX_ROUND`, and **the table's row 2 is amended here,
where it is enforced** (standing rule 2), because the table as written is what
made both cases ambiguous. Two spellings of one refusal, deliberately: the first
two clauses keep the pre-existing message, and the bound gets its own message
naming the limit and the offending value — `2147483648` *is* a non-negative
integer, so answering "round must be a non-negative integer" would tell the
caller something false about their own input.

**Widening the column was considered and rejected**, and the reason is R19's:
`round` is becoming a DERIVED value — `taskDepth()`'s longest-path depth from
the roots — and a dependency graph's depth cannot approach 2³¹. A `bigint` column
would be a migration, a deploy-window risk and a permanently wider column bought
to store a value this engine will never legitimately produce.

Both changes move behaviour from `500` to `400` only. Nothing that previously
succeeded starts failing, and no legitimate caller depends on receiving a `500`
for a malformed round.

**THE TYPE CLAUSE — amended round 215, third ruling on the same expression, for
round 214's phase-3 finding 1.** "A non-negative integer" is what this
requirement always said; it is not what the expression enforced. `Number()`
coerced before `Number.isInteger` judged, so every non-number that JSON can carry
arrived as a perfectly good integer. Measured end-to-end through the mounted
router at HEAD `99cb121`:

| body | before | stored round |
|---|---|---|
| `{"round":[]}` | `201` | 0 |
| `{"round":true}` | `201` | 1 |
| `{"round":"0x10"}` | `201` | 16 |
| `{"round":""}` | `201` | 0 |

Case 2a passed only by luck: `Number("abc")` is `NaN`, which `Number.isInteger`
rejects. The coercion predates this phase; **the consequence is new**, because
this phase made `round` OPTIONAL. `""` is the shape a curl template renders from
an unset shell variable, and it now makes `roundSupplied` true, so the caller
gets **round 0** instead of `computeRound(deps)` with its dependencies at round
300. Three things break at once: R24's phase-block gate is bypassed (it runs only
on a computed round); R40's consolidation group key `(project_id, round,
workstream)` names the wrong group; and while that row is `pending` at round 0,
`legacyRoundReady`'s `earlier.round < task.round AND earlier.status <> 'done'`
blocks **every legacy (NULL-`depends_on`) row of the project** — the stalled
fleet this project exists to end, reintroduced by a typo. So the guard now leads
with `typeof body.round !== "number"`, refused with the **existing** message
(unlike the bound's own message, `[]` and `"1"` genuinely are not non-negative
integers, so the sentence is true of them), **amended where it is enforced**.
Safe in the same direction as both round-213 rulings — *amended at round 240;
this sentence read that `taskCurl()`'s shipped example sends `"round": 1`, which
R53 falsified: as of `05f2842` `taskCurl()` OMITS `round` entirely and the route
computes it from `depends_on`. The reasoning survives intact, and is in fact
stronger, which is why the guard itself is unchanged:* the only caller left that
supplies a round is the goal-mode architect branch, whose prompt shows the field
as a literal JSON number (`"round": 100`, R51's phase label). Nothing in the tree
sends a quoted round, so no real caller regresses. (The twin of this sentence in
`routes/projects.ts`'s round-guard doc-comment was amended at round 239; this
copy was outside that task's write-set and is closed here.)

*How proved:* `check` — `scripts/checks/check-task-api.ts` case 2, ten probes:
`"abc"`, `-1`, `1.5`, `2147483648`, `[]`, `true`, `"0x10"`, `""` refused, and
**`2147483647` accepted**, so the bound is a gate that can be passed rather than
an off-by-one nobody notices; plus **2j**, which posts one body twice — with
`round: ""` (refused) and with `round` omitted (computed to 601 against a
dependency at 600), the assertion that states the consequence rather than the
coercion. Each refusal was observed as a `500` or a coerced `201` before its
clause existed (`evidence/phase3-api.md` §5, §7; `evidence/phase3-fix-1.md` §1).

**R23. Round is computed, not supplied.** When `round` is omitted, the engine
sets `round = 1 + max(round of the tasks named in depends_on)`, or `0` when
`depends_on` is empty or absent. When `round` **is** supplied it is honoured
unchanged — the architect legitimately seeds one phase-block number per phase
(`k*100`) and everything below inherits from it by the `+1` rule.
*How proved:* unit over the pure `computeRound(deps)`.

**R24.** A computed `round` that would leave its phase block
(`floor(base/100) != floor(round/100)`, where `base` is the block of the
shallowest dependency) is a `400` naming the task and the block. This is the
"do not exceed round+20" guidance turned into an enforced, satisfiable gate:
a phase has 99 depth levels, which no real plan uses.
*How proved:* unit — a chain of 99 tasks passes; the 100th is refused.

**R25. Cycle detection.** A `depends_on` that would close a cycle is rejected
with `400` and a body naming **the offending path** as an ordered list of
`{id, title}` from the repeated node back to itself. Table-driven test over
hand-built graphs: self-edge, 2-cycle, 3-cycle, cycle behind a diamond, a long
chain that is *not* a cycle, a wide DAG that is not a cycle.
*How proved:* unit.

**R26.** A cycle is *structurally* unreachable given R27 and R29 — dependencies
must name pre-existing tasks and are immutable, so every edge points backwards
in insert order. R25's detector is therefore a **belt**, and its test says so.
Stating this is a requirement: an undocumented belt gets deleted by the next
person who proves it never fires.
*How proved:* review — the doc-comment on the detector says it and cites R26.

**R27.** Every id in `depends_on` must name an existing `project_tasks` row **of
the same project**. A dangling id or a cross-project id is a `400` naming the
offending ids. Never a warning, never a silent drop.

**THE SQL HALF LANDED EARLY, IN PHASE 2 (round 204, red-team finding 3), and
phase 3 must not re-open it.** This requirement closes the API path; it said
nothing about the engine, and neither dependency subquery in
`promoteReadyTasks()`'s graph branch nor in `sweepDanglingDependencies()` was
correlated on `project_id`. Measured: a task naming another project's `done` row
**promoted**, and one naming another project's `pending` row sat `pending`
forever with a matching cardinality that the sweep could not see — while
`graphReady()` threw on the identical input, because its `byId` holds one
project's rows. Leaving a known silent-promotion hole open across a phase boundary
for bookkeeping reasons is the disclose-and-proceed habit this project is under
orders not to repeat, so `AND d.project_id = pt.project_id` was added to all
three subqueries in phase 2's fix cycle, with case 10 of
`check-scheduler-sql.sh` as its proof. Phase 3 still owes the `400`: the SQL now
enforces the precondition rather than trusting the write path, which is not the
same thing as telling the caller.
*How proved:* unit + `check` (the `400`, phase 3); `check-scheduler-sql.sh` case
10 (the SQL, phase 2 — done).

**R28.** `workstream` is validated against R4's regex; `write_set` entries are
validated as repo-relative POSIX paths: non-empty, no leading `/`, no `..`
segment, no NUL, ≤ 400 chars each, ≤ 200 entries, normalised (**every `.`
segment stripped — leading or interior**, duplicate slashes collapsed) before
storage. A violation is a `400` naming the entry.

**"`./` stripped" MEANT LEADING ONLY, and round 214's phase-3 finding 3 is why
it now says otherwise.** The shipped `normaliseWritePath()` stripped `^(\./)+`
and collapsed `/{2,}` and nothing else, so `src/./a.ts` returned itself.
Measured: `conflicts(["src/a.ts"], ["src/./a.ts"]) === false`. R16/R17 judge
contention by **exact string equality**, so two builders of the *same*
workstream declaring those two spellings did not conflict, were both claimable
in one round, and landed in one worktree writing one file — `03-quality.md` §6's
"contention belt too loose → two agents clobbering in one worktree", which is
the failure this belt exists to prevent. Phase 4's isolation rests on this
function being canonical. The interior `/./` collapse joins the same fixpoint
loop (one pass cannot consume `src/././a.ts`, whose matches overlap on the
shared slash), and `..` is untouched by it — `/../` contains no `/./`. A bare
`.` and a trailing `.` segment are still accepted and that is now stated at the
function rather than reasoned about at each reading.

*How proved:* unit — a table of good and bad paths, including
`src/./a.ts → src/a.ts`, `src/././a.ts → src/a.ts`, and an assertion on
`conflicts()` itself, since the string was never the point.

**R29. `depends_on` is immutable after insert.** No route, no reconciler path
and no script updates it. This is what makes the computed `round` stable, which
is what keeps the 0035 identity index and the 0039 chain-key index sound.
*How proved:* review — `grep -n "depends_on" forge-control/src` shows writes only
in `createTask`, `createFixChain` and the migration.

**R30.** The `409` idempotency contract is unchanged: identity remains
`(project_id, round, role, title)`, a repeated curl returns the existing task
with `409`, and no duplicate is created. The new fields are **not** part of
identity. *How proved:* unit + review.

**R31.** A project may carry `metadata.strict_write_sets: true`. Under it, a
`builder`- or `tester`-role task created without a non-empty `write_set` is a
`400`. New goal-mode projects created by this engine set it; existing projects
do not, so R18's replica is untouched.
*How proved:* unit — both branches.

---

## D. Workstream worktrees and integration — phase 4

**R32.** `lib/workspace.ts` gains `provisionWorkstream(project, workstream)`
returning `{ workspace_dir, work_branch }`. It is idempotent and race-safe by
the same construction as today's `provisionWorkspace`: existing worktree wins,
existing branch is adopted, a failed `worktree add` prunes and re-checks before
throwing.
*How proved:* `check` — `scripts/checks/check-workstream-e2e.sh` runs it twice
concurrently against a throwaway repo.

**R33. Branch naming — `project/<id8>-<workstream>`, not `project/<id8>/<workstream>`.**
The spec §3 writes the slash form. **It is unimplementable.** Git refuses a ref
`refs/heads/project/abc123/ui` while `refs/heads/project/abc123` exists — a
directory/file conflict in the ref store. Verified on this host, 2026-08-17:

```
$ git branch project/abc123 && git branch project/abc123/ui
fatal: cannot lock ref 'refs/heads/project/abc123/ui':
       'refs/heads/project/abc123' exists; cannot create 'refs/heads/project/abc123/ui'
$ git branch project/abc123-ui        # exit 0
```

Workstream `main` maps to the **existing** bare `project/<id8>` branch, so no
live project changes branch. Every other workstream gets
`project/<id8>-<workstream>` branched off `project/<id8>`.
*How proved:* `check` — the e2e script asserts both branches exist and that the
slash form errors; and, from round 960, `check-workstream-claim.ts` §4 asserts
`workstreamBranch()` in-process, so the form is also pinned by a check that
needs no throwaway repo and that every round can afford to run.

**THE SLASH FORM OUTLIVED ITS REFUTATION IN THE CORPUS — round 815's finding,
closed round 960.** R33 has been correct since round 212, and three documents
went on predicting `project/<id>/<workstream>` anyway: `02-architecture.md`
§4.1 (which cites the spec's form in order to refute it — correct, left alone),
`evidence/phase8-verify.md` (the finding itself — a record, left alone), and
**`scripts/deploy/payload-verify.json` item 7b, a LIVE deploy brief whose
expected observation was a branch git cannot create**. The round-815 task read
that item, could not observe it, and reported it as a finding rather than
quietly re-reading it. Round 960 corrects the payload and the verbatim copy of
its brief in `evidence/phase8-tooling.md` §7, in one commit — the same rule
`GRAPH_GUIDE` states about a constant the corpus quotes.

**R34. Sibling directories, never nested.** Workstream `main` keeps
`${PROJECT_WORKTREE_ROOT}/<project-id>` exactly as today; every other workstream
gets `${PROJECT_WORKTREE_ROOT}/<project-id>--<workstream>`. Nesting a worktree
inside the main worktree would make it untracked content in the parent's
`git status --porcelain`, which is the exact input to the reviewer cleanliness
gate and to the deploy task's pre-merge check.
*How proved:* `check` — after provisioning a second workstream, `git status
--porcelain` in the main worktree is empty.

**R35.** `removeWorkspace(project)` removes **every** workstream worktree of the
project, not just `main`, enumerated from `git worktree list --porcelain` by
directory prefix. It remains best-effort and never throws.
*How proved:* `check`.

**R36.** A run's `metadata.workspace_dir` is the worktree of **its task's
workstream**. `executor.ts` is unchanged — it already uses
`run.metadata.workspace_dir` as the child's cwd.
*How proved:* unit (the resolver) + review (no diff in `executor.ts`'s cwd
selection).

**R37.** `WORKTREE_POLICY()` is unchanged in wording and now correctly describes
a per-workstream worktree ("the directory you are already in"). The reviewer's
diff base becomes the **workstream's fork point** rather than
`project.base_branch`: `git diff $(git merge-base <project-branch> HEAD)...HEAD`.
Reviewing a workstream against `main` would show every other workstream's work
as if it were this task's.
*How proved:* unit — the reviewer prompt contains the merge-base form for a
non-`main` workstream and the existing form for `main`; review.

**R38. Integration is an explicit task with a reviewer. Never auto-merge.**
For every workstream other than `main`, the planner creates a terminal
`builder`-role **integration task** in workstream `main` that:
  a. depends on every task of that workstream;
  b. carries `write_set` = the union of that workstream's write-sets;
  c. merges `project/<id8>-<workstream>` into `project/<id8>` in the main
     worktree;
  d. **on conflict: stops, reports the conflicting files verbatim, and does not
     resolve them**;
and a `reviewer` task depending on the integration task.
There is no code path anywhere in the tree that merges a workstream branch
without a task. *How proved:* review — `grep -n "merge" forge-control/src` and a
stated justification for every hit; unit — the planner prompt requires it;
`check` — the e2e drives a real conflict and asserts a non-zero exit and named
files.

**R39.** The engine refuses to provision a new workstream worktree when the
project already has ≥ 6 (`PROJECT_MAX_WORKSTREAMS`, env-overridable). A goal
project fanning out 40 workstreams would fill the disk with full checkouts. The
refusal is a hard error naming the count and the limit at task-creation time
(`400`), not at spawn time.

**THE API HALF LANDS EARLY, IN PHASE 3 (round 212), and phase 4 must not
re-open it.** This requirement's primary owner stays phase 4 — §K above and §9
of `04-phases.md` both say so and must keep agreeing — but its own words put the
refusal *at task-creation time, not at spawn time*, and task creation is
`POST /api/projects/:id/tasks` in `forge-control/src/routes/projects.ts`, a file
`04-phases.md` §10 assigns to phase 3 **alone**. Phase 4 could satisfy the `400`
only by writing a phase-3 file, so as mapped the requirement was unsatisfiable
in its own phase; `04-phases.md` Phase 3 deliverable 2 had already noticed and
listed "R39's workstream cap" among phase 3's `400`s. Amending it where it is
enforced, rather than reinterpreting the mapping silently, is standing rule 2
(`00-vision.md` §7). So: the `400`, the distinct-workstream count and the
`PROJECT_MAX_WORKSTREAMS` constant itself land in phase 3, exported from
`routes/projects.ts`. **Phase 4 keeps the rest and must not restate the `400`:**
the provisioning refusal in `lib/workspace.ts` (R32's `provisionWorkstream`),
which reads the same exported constant rather than re-reading the environment so
the two refusals cannot disagree about the limit, and phase 4's `04-phases.md`
deliverable 8 is satisfied by *reading* the cap, not by re-implementing its
rejection. A second, differently-worded `400` for the same condition is a
finding.

**BOTH REFUSALS ARE ADVISORY, AND THE TOCTOU IS ACCEPTED. Recorded round 215,
DECIDED round 224 by phase 4's red team, which the round-215 text named as the
owner of the decision.**

*The race, in both places.* `POST /:id/tasks` calls `listTasksForProject()`
**once**, before validation, and counts distinct workstreams off that snapshot;
two concurrent POSTs each proposing a *different* new workstream both see five
present and both succeed, yielding seven. `provisionWorkstream()` reads
`git worktree list` and then runs `worktree add`, with no lock, so it has the
**identical** race.

*The measurement that replaces the earlier claim.* Round 215 recorded the API
race as tolerable on the ground that "the worktree that would actually consume
the disk cannot be created without passing" the phase-4 refusal. **That is
measurably false and is retracted.** Round 224's red team and gating reviewer
each ran two concurrent `provisionWorkstream()` calls for two different new
workstreams at a filled cap, in a throwaway repo at `HEAD=b201f22`: both
returned exit 0 and the project ended one **over** cap (4→5 in one transcript,
5→6 in the other). The disk-side check bounds **serial** excess only.

*The ruling: accept the race in both places; do NOT make the count
transactional.* The grounds are the measurement, not the earlier claim of
enforcement:
  a. **Unreachable in the deployed topology.** `provisionWorkstream()` has
     exactly two call sites, both inside `spawnTaskRuns()`'s sequential
     `for … await` loop in a single executor process. Reaching the window needs
     two executors overlapping across a deploy.
  b. **The slip is clean.** Both workstreams got a consistent branch+worktree
     pair — no orphan branch, no orphan directory, nothing half-provisioned —
     and `removeWorkspace()` enumerates from the worktree registry, so teardown
     still reaches every one of them. Checked in both directions.
  c. **A refusal writes nothing.** The cap check runs before any git write
     (e2e §12.6), so the serial path — the one that actually occurs — refuses
     cleanly.
  d. **The priced cost is one extra full checkout of disk**, never a corrupt
     workspace and never a wrong answer. Closing the race would need
     `SELECT … FOR UPDATE` over the project row (or a unique index over distinct
     workstreams) at the API, plus a lock over a git repository at provisioning
     — a real mechanism bought against a disk-space nuisance.

The overclaiming sentence is retired from `provisionWorkstream()`'s R39 comment
block in the same commit as this paragraph, which is where the rule is enforced.

*How proved:* unit (the `400`, phase 3 — `scripts/checks/check-task-api.ts`);
`check-workstream-e2e.sh` (the provisioning half, phase 4).

**R70. No project closes on an unmerged workstream branch. ADDED ROUND 222,
because the named attack SUCCEEDED against the shipped code.** `03-quality.md`
§5 briefs phase 4's red team to ask: *"a workstream whose integration task is
skipped — does the project close with the branch unmerged?"* Phase 4C read the
statement rather than guessing, and the answer was yes.
`closeFinishedProjects()` was

```sql
UPDATE projects p SET status='done' WHERE p.status='active'
  AND EXISTS (SELECT 1 FROM project_tasks WHERE project_id=p.id)
  AND NOT EXISTS (SELECT 1 FROM project_tasks WHERE project_id=p.id AND status<>'done')
```

— no git term, no workstream term. Every task of workstream W `done` means
nothing is non-done, the project closes, and `project/<id8>-W` is stranded with
all of its work on it. **R38 is a defence only while the planner REMEMBERS to
create the integration task.** Planner discipline is not a defence; that is what
this requirement is for.

**The rule.** `closeFinishedProjects()` must not close a project while some
workstream W <> `main` has at least one task and there is NO task with
workstream = `main` whose `depends_on` covers every task id of W. The refusal is
**loud, not silent** (NF1): the project stays `active` and a notification names
the project and the un-integrated workstream(s), once per crossing rather than
once per tick.

**It needs no new column, and that is why it is a requirement rather than a
hack.** `project_tasks` has no `metadata` column to flag an integration task
with — `TASK_COLS` in `db/projects.ts` is exactly id, project_id, round, role,
title, brief, status, run_id, fix_cycle, tier, attempt, chain_key, depends_on,
workstream, write_set, created_at, updated_at — and a title convention would rot.
R38 already *defines* the integration task structurally, as the one that depends
on every task of its workstream, so `depends_on` alone identifies it. Phase 1
owns migrations and 0040 has landed; no 0041 was needed and none was written.

**Membership, decided rather than left open.** The integration task and the
reviewer that follows it are tasks of `main` (R38, `02-architecture.md` §4.4):
the merge lands in the main worktree and the conflict must be visible there.
They are therefore **not** members of W and are never required to depend on
themselves — get this wrong and no project with a workstream could ever close,
which is a worse bug than the one being fixed. A covering task that lives in
another workstream integrates nothing: it would merge in the wrong worktree.

**THE RESIDUAL, STATED RATHER THAN IMPLIED AWAY. Recorded round 224 by phase
4's red team.** This rule verifies **existence and edges, never git**. An
integration task marked `done` **without its merge having happened** is caught
by *nothing* structural: the covering task exists, its `depends_on` covers W,
the term is satisfied and the project closes with the branch unmerged — the very
outcome R70 was added for, reached by a different door. The designed catch is
R38's integration **reviewer**, and a hand-edit in psql bypasses a reviewer.
That is the same operator-with-psql class as the hand-renumber R41 guards, and
it is accepted for the same reason: the engine's own paths cannot produce it, and
defending against an operator with write access to `project_tasks` would mean
verifying merges in git on every close. It is written down here because R70's
presence otherwise *implies* a completeness it does not have.

**Coverage is ⊇, not =.** An integration task routinely depends on more than W
(its planner's ordering edges, the phase's other roots), so the test is that W's
ids are a subset of what it names.

**Legacy projects are untouched, and every live project is a legacy project.**
`workstream` defaults to `main` and `depends_on` may be NULL
(`02-architecture.md` §2.2 — nullable IS the migration strategy). With every row
in `main` the term is vacuously true and the statement is the one that ran
before.

**Implemented as one extra `NOT EXISTS` term, not a pre-pass**, with the
readable definition in `unintegratedWorkstreams()` (`lib/project-tick.ts`) and
the term as its SQL mirror — the same split `promoteReadyTasks()` documents, and
for the same reason: the decision must be unit-testable without a database. The
choice of the SQL term over a TS pre-pass is what keeps the close ATOMIC; a
pre-pass would read the tasks, decide, and then update, with a window in which a
task created in between makes the decision stale. **The refusal set costs no
second copy of the rule:** `held` is the OLD condition re-run after the UPDATE,
so a project that would have closed before and did not close now was refused by
the new term and by nothing else. Both halves of the rule are written exactly
once.

*How proved:* unit — the `unintegratedWorkstreams()` table in
`project-tick.test.ts` (legacy, graph-`main`-only, the attack, the integrated
case, the MEMBERSHIP case, partial coverage, the foreign integrator, coverage as
a superset, two workstreams judged independently); `check` — **new**
`scripts/checks/check-close-gate.ts` drives the SHIPPED
`closeFinishedProjects()` against real rows in a throwaway schema, 27/27, with a
POSITIVE CONTROL that runs the pre-R70 predicate over the same rows and asserts
it *would* have closed every held project — so the refusal cannot be credited to
anything but this term. Both instruments were observed FAILING under mutation:
deleting `w.workstream <> 'main'` (10 failures), deleting `i.workstream =
'main'` (6 failures), and weakening coverage from `every` to `some` (1 unit
failure). The `i.workstream = 'main'` mutation initially SURVIVED both suites
and the fixtures were rebuilt until it did not — recorded because a mutation
that survives silently is exactly the instrument failure standing rule 3 names.

---

## E. Consolidation — phase 4 (must not break)

**R40.** The consolidation group key becomes `(project_id, round, workstream)`.
Two reviewers of different workstreams that happen to land on the same computed
round are two groups, not one — a single merged fix builder could only live in
one worktree and would silently drop the other workstream's findings.
*How proved:* unit — a new case in `cp2-reconciler-interaction.test.ts` with two
same-round reviewers in different workstreams yielding two independent chains.
**Landed round 221** — `describe("R40 — two same-round reviewers in different
workstreams are TWO chains")` in that file, plus T21/T29 in
`project-reconcile.test.ts`, plus `scripts/checks/check-fix-chain-graph.ts` §5
against real rows.

**AMENDED ROUND 221 — THE CHAIN KEY WAS NOT ENOUGH, AND R40 AS WRITTEN WOULD
HAVE BLOCKED THE PROJECT IT EXISTS TO UNBLOCK.** R40 and R41 namespace the
`chain_key`. `project_tasks_identity_idx` (migration 0035) is
`(project_id, round, role, title)` and migration 0040 **added no workstream
term** — verified against the live DDL by `check-fix-chain-graph.ts`'s
pre-flight, which reads the index's columns out of `pg_index` rather than
believing this sentence. So two groups at one round in two workstreams each
insert a fix builder at `round + 1`, role `builder`, title `Fix cycle 1`: the
SAME identity tuple. The second INSERT conflicts, `insertChainRow` correctly
classifies it `occupied`, and `consolidateVerdictGroup` **blocks the project
with that workstream's merged feedback undelivered** — R40's own motivating
failure, arriving through the other index.

**The fix, in the same commit:** `FIX_TASK_TITLE` and `RECHECK_TASK_TITLE` take
the workstream and append `" · <workstream>"` for non-`main`. `main` keeps its
titles **byte for byte** — the same replay argument as R41's, applied to the
identity tuple instead of to the key, and the reviewer wording in particular is
frozen back to pre-R850 chains. The alternative — adding `workstream` to
`project_tasks_identity_idx` — was rejected: it is a phase-1 migration this
phase does not own, it would change the meaning of idempotency for every
`createTask` caller, and it is not needed, because the title is already the
component that separates two rows the round and the role cannot.
*How proved:* unit — `T28` in `project-reconcile.test.ts` (the `main` titles
against string literals; three workstreams' titles pairwise distinct; the
40-character workstream still inside the 200-character slice) and the identity
assertion in cp2's R40 block; `check` — `check-fix-chain-graph.ts` §5, where
both builders are `created` rather than one `occupied`.

**R41.** `chainKeys()` gains a workstream namespace **only for non-`main`
workstreams**: `main` keeps `fix:<round>:<cycle>` / `rereview:<round>:<cycle>` /
`retest:<round>:<cycle>` byte-identically, so every historical chain replays
against the row it already wrote. Other workstreams get
`fix:<workstream>:<round>:<cycle>` and so on.

**LANDED ROUND 221, with one implementation decision recorded here because it is
load-bearing for R43.** The workstream parameter is **optional**, defaulting to
`MAIN_WORKSTREAM`. Not for convenience: R43 requires every existing case in
`project-reconcile.test.ts` to pass **unmodified**, and T9 calls
`chainKeys(7, 2)`. A required third parameter would fail typecheck in the very
tests that prove the historical keys did not move. The same reasoning applies to
`consolidateVerdictRound`'s fourth parameter and to the two title functions. It
is a default-for-omitted and **not** an NF1 fallback-for-invalid — the
distinction `createTask`'s `workstream ?? 'main'` already documents: nothing is
rescued, no error is swallowed, and an invalid workstream is passed through
untouched so the CHECK constraint refuses it loudly. The one production caller
passes the group's workstream explicitly, and `cp2-reconciler-interaction.test.ts`
asserts that it does.

**THE HAND-RENUMBER HAZARD, recorded round 204 (red-team finding 4) so that phase
4 owns it explicitly rather than inheriting it.** `chainKeys(round, cycle)`
embeds `round`, so an operator who renumbers a group **after** its fix chain
exists produces `fix:<new>:<cycle>`, which collides with neither
`project_tasks_chain_key_uniq` (the chain_key differs) nor
`project_tasks_identity_idx` (the round differs): `insertChainRow()`'s
`INSERT … ON CONFLICT DO NOTHING` succeeds, a **second fix chain lands**, and the
`occupied` branch never fires because it is only reached on a conflict. Found by
reading the code, not run against a chain. It is operator-only —
`grep -n "SET round"` over the tree is empty, no engine path writes `round` after
insert — and an operator did exactly that to this project's own scout task at
~03:31 on 2026-08-17. Phase 2 neither causes nor worsens it: `project-reconcile.ts`
and both reconcile test files are untouched by phase 2's diff (R43 holds).
**Phase 4's obligation:** either rebase the chain identity onto something an
operator cannot renumber (the gating task ids are immutable by R29, unlike the
round), or add a guard that makes a second chain for the same group impossible,
and record the choice **here** with its reasoning. Keeping `round` in the key and
saying nothing is not one of the options — R40's own group key keeps it, so the
hazard survives phase 4 by default unless phase 4 decides otherwise on purpose.
*How proved:* unit — the existing `chainKeys` cases pass **unmodified**, plus new
cases for a named workstream, plus (phase 4) a case that a renumbered group
cannot produce a second chain.

**THE DECISION, ROUND 221 (phase 4B): A GUARD, NOT A RE-KEYING.** The obligation
above offered two routes. Re-keying the chain onto the gating task ids is
**unavailable**, and not merely more expensive: R41's own replay property
forbids changing the `chain_key` STRING for `main`, so the identity cannot be
rebased into the key without breaking the thing the key exists for. What R42
hands over free is the immutable identity itself — the fix builder's
`depends_on` **is** the gating task ids, immutable by R29, where the round is
not. So:

> `createFixChain()` refuses to insert a fix builder whose
> `(project_id, fix_cycle, depends_on-as-a-set)` already belongs to a chain row
> carrying a **different** `chain_key`.

The rule is `duplicatesFixChain()` in `lib/project-reconcile.ts` — pure,
unit-tested, and **called** by `db/projects.ts` rather than restated in SQL, so
there is no second copy to drift. The SELECT beside it only narrows (this
project, role `builder`, `chain_key IS NOT NULL`, this cycle). It runs inside
the transaction and **before** the first INSERT, so a refusal writes nothing.

Four properties, each with a case:

1. **A renumbered group is refused.** The new `chain_key` differs and the round
   differs, so neither unique index would stop it — which is the whole hazard.
2. **Our own chain, replayed, is not refused.** An existing row carrying OUR
   chain_key returns `false` explicitly: the crash-between-COMMIT-and-mark-done
   path recomputes the same key, and `insertChainRow` must still absorb it as
   `replay`. Refusing it would turn the guard into the wedge.
3. **A later cycle of the same group is not refused** — cycle 2 over the same
   gating tasks is the legitimate next chain, and `MAX_FIX_CYCLES` bounds it.
4. **It throws rather than returning an outcome.** A second chain for one group
   is not a state the caller can reconcile, and `insertChainRow`'s three-way
   `created`/`replay`/`occupied` classification is left untouched (R44) — it is
   the net that catches a chain-key MISTAKE, and overloading it with a chain-key
   HAZARD would blunt both. `project-tick.ts`'s per-group `catch` escalates the
   throw to Konrad after `MAX_GROUP_FAILURES` consecutive ticks with the message
   quoted in the push, and the message names the offending task id, both chain
   keys and the remedy.

**THE GUARD'S STATED BOUNDARY.** A **partial** renumber — an operator moving
some members of a group and not others — changes the gating set, so the two
chains have different identities and a second chain lands. That is correct
rather than a hole: two disjoint member sets are two different dependency joins,
and nothing distinguishes that from a genuine second group. Asserted as a case
so the limit is documented rather than discovered.
*How proved:* unit — `T24` in `project-reconcile.test.ts`, seven cases including
the boundary and the subset case; `check` —
`scripts/checks/check-fix-chain-graph.ts` §6, which renumbers a real group and
asserts the refusal **plus two positive controls** that both unique indexes
would have admitted the row, so the refusal cannot be credited to an index.

**R42.** Fix-chain rows created by `createFixChain()` carry the graph fields:
the fix builder `depends_on` = the gating task ids, `workstream` = the group's
workstream, `write_set` = the union of the write-sets of the tasks under review;
each re-checker `depends_on` = `[fix builder id]`, same workstream, empty
write-set. Without this the chain rows would be graph roots and would run
immediately, in parallel with the work they are meant to follow.
*How proved:* unit — a `createFixChain` shape test; `check` against a throwaway
Postgres. **Landed round 221:** the descriptors are computed by
`fixChainGraphFields()` in `lib/project-reconcile.ts` (pure, so the shape test
needs no database) and `createFixChain` takes them as `input.graph` rather than
assembling them, so the rounds, the edges and the write-set union have one
definition. `T23` in `project-reconcile.test.ts` is the shape test;
`scripts/checks/check-fix-chain-graph.ts` §3–§4 reads the resulting rows back
out of a real `project_tasks` and asserts the replay is still absorbed.

**AMENDED ROUND 221 — WHERE `round + 1` AND `1 + max(dep.round)` DISAGREE, found
by writing the agreement test this requirement asked for.** The agreement holds
everywhere except the **last two rounds of a phase block**: R24 caps a phase at
99 depth levels, so for a group at round 99 `computeRound()` **refuses** where
the literal answers 100. The two rules therefore agree on a value over the whole
domain where `computeRound` has one, and disagree only where it has none.

**The decision: keep the literal and create the chain.** Promotion is by
`depends_on` and never by round — that is this project's whole point — so the
schedule is unaffected and only the phase LABEL moves: the fix chain of phase
0's round 99 appears under phase 1 in the Kanban's `floor(round / 100) * 100`
grouping (R55). Refusing would wedge a real fix cycle to protect a numbering
convention, leaving the group's feedback undelivered — trading a cosmetic defect
for the exact failure the reconcile module exists to prevent.

**Reachability, stated rather than hand-waved:** it takes 99 dependency levels
inside ONE phase for a group to sit at round 99. The architect seeds one planner
per phase at `k*100` (R51) and every other round is `1 + max(dep.round)`, so a
phase's depth is the longest chain its planner creates — a dozen at most in
every project this engine has run. Phase 6 owns the Kanban and should know the
label can cross; nothing else reads the number.
*How proved:* unit — `T23`'s *"THE BOUNDARY the agreement does NOT hold at"* and
*"REACHABILITY of that boundary"*, which assert `computeRound()` throwing at 99
and agreeing at every round below the block ceiling.

**R43. Every existing test in `project-reconcile.test.ts`,
`cp2-reconciler-interaction.test.ts` and `cp3-linkage.test.ts` passes
unmodified.** If one genuinely must change, the change is justified in the
commit message by requirement id and the reviewer must quote that justification.
*How proved:* `pnpm test` diffed against the base commit's result.

**R44.** The group *decision* is untouched: NEEDS_FIXES beats PASS, one fix
chain per group, one re-check per dissenting role, `chain_key` idempotency,
`MAX_FIX_CYCLES = 3`, `verdictMemberSettled`'s three-term rule and its two SQL
mirrors (`markVerdictTaskDone`, `unsettledVerdictTasks`) unchanged term for term.
*How proved:* R43 + review.

**R45.** `roundIsComplete()` and the `🏁 round N complete` notification are
restated as **group** completion — every task sharing `(project, round,
workstream)` is `done` — so a workstream's completion is not announced by
another workstream draining. *How proved:* unit.

**Landed round 221.** The SQL gains `AND workstream = $3`; the text is
`groupCompleteNotification()` in `lib/project-reconcile.ts`, **byte-identical
for `main`** and naming the workstream otherwise. The fire-exactly-once property
is what the workstream term is FOR, and it is worth spelling out: keyed on
`(project, round)` alone, workstream A's last task announces a round B is still
inside, and B's own completion then never fires at all — A spent the round's one
announcement. Both call sites pass a workstream (the group path in
consolidation, and the per-task path for non-verdict roles), and cp2 asserts
there are exactly two of them, so a third added later cannot quietly pass the
round alone. The `🔁 fix cycle opened` push gained the same treatment for the
same reason.
*How proved, precisely:* unit — `T26` in `project-reconcile.test.ts` (the `main`
string against a literal; two workstreams' texts distinct); source — cp2's
*"roundIsComplete is group completion, at BOTH of its call sites"*, which also
pins the call-site count.

**R46.** `unwedgeProject()` retries the earliest **failed group** rather than the
earliest failed round: earliest by `(round, workstream)` ordered by round then
workstream name, so an operator unwedging a project does not restart two
workstreams at once.
*How proved:* unit over the pure selection helper.

**Landed round 221.** The helper is `earliestFailedGroup()` in
`lib/project-reconcile.ts`; `unwedgeProject` reads `SELECT DISTINCT round,
workstream` and calls it, rather than asking SQL for a `MIN(round)`, so the
ordering rule is unit-testable without a database and this module still holds no
decision (`02-architecture.md` §1.2). The return value gains `workstream` so the
API can say which group moved. `localeCompare` is deliberately not used: the
selection an operator gets must not vary with the process's locale, and the
charset is `[a-z0-9-]`, on which `<` is a total order.
*How proved, precisely:* unit — `T25`, five cases including order-independence
and that the selection is returned by value; source — cp2's *"unwedgeProject
retries ONE group, chosen by the pure helper"*, which also asserts
`SELECT MIN(round)` is gone.

---

## F. Prompts — phase 5

**R47.** The planner prompt in `project-tick.ts` instructs the planner to
declare, for every task it creates: `depends_on` (task ids returned by earlier
curls), `workstream`, and `write_set`. It contains **no** instruction to choose a
round.

**A DECLARED WRITE-SET MUST NAME THE COMPANION FILES A CHANGE FORCES** — added
round 204, from a bookkeeping finding that is not only bookkeeping. Phase 2
changed a shared type (`ProjectTask` gained three columns) and that change forced
edits to two test files' object factories (`cp3-linkage.test.ts`,
`project-tick.test.ts`) which no declared write-set named. Today the consequence
is a finding; once workstreams are live it is a **clobber**, because contention is
computed from the declared set and two workstreams whose write-sets both omit the
same forced companion will be scheduled in parallel over it. The prompt must
therefore say, in these terms: when a task changes a shared type, an exported
signature, or a fixture shape, its `write_set` includes the **test factories and
call sites that change with it**, not merely the file whose behaviour is the
point. A write-set is an input to a scheduling decision, not a summary of intent.
*How proved:* unit — `project-tick.test.ts` asserts the planner prompt contains
`depends_on`, does not contain the string `Your round is`, and contains the
companion-files instruction.

**R48.** The prompt states the three fan-out rules from spec §4 explicitly:
research fans out wide and early (independent questions share no files and have
no ordering); builders fan out by file ownership; reviewers remain a genuine
join.
*How proved:* unit — prompt-content assertions.

**A WORKSTREAM IS OPENED PER CONCURRENT LANE, NOT PER FILE CONFLICT** — amended
round 960, from the first live measurement of this prompt and stated here
because this is the requirement the prompt's workstream criterion serves.

Round 815 measured the first project the new prompt planned: a well-formed DAG —
7 of 10 tasks carrying a non-empty `depends_on`, including a true join — that
executed **one task at a time**. Max concurrency 1, distinct workstreams 1, two
`ready` planners with disjoint write-sets and a 32-minute wait for the second
(`evidence/phase8-verify.md` §7c).

The cause is neither the scheduler nor the graph. `spawnTaskRuns()`'s deferred
branch — `busyWorkstreams()` + `partitionByWorkstream()`, the operator's ruling
of round 222 — defers **every** eligible task of a busy workstream and never
consults a write-set, so **the unit of parallelism is the workstream** and a
project that keeps everything in `main` runs strictly serially whatever its
graph says. The belt is correct: it is what makes one worktree per workstream
safe, and two builders in one directory is the silent clobbering this project
exists to remove. What was wrong was the guide's closing criterion, *"open a
second only when two teams truly need one file concurrently"* — a same-file test
for a belt that asks no question about files. Two teams do not need to want the
same FILE to need a second workstream; they need only to want to run AT THE SAME
TIME. The round-815 architect followed the old criterion faithfully (six phases,
disjoint files) and opened nothing.

So the prompt states: open one workstream **per lane the planner wants running
concurrently**, up to `PROJECT_MAX_WORKSTREAMS`. Everything else in that bullet
was measured true and is unchanged — the name regex, the `main` default, the cap
and its `400`, the same-file-across-workstreams property — and R38's
integration/no-auto-merge paragraph is untouched, which is what keeps the extra
lanes honest: a lane costs an integration task and its reviewer.
*How proved:* unit — `project-tick.test.ts` asserts the criterion is present,
that the retired one is **absent**, and that the bullet's other five clauses
survived; `check` — `scripts/checks/check-workstream-claim.ts` executes the
claim against `busyWorkstreams()`/`partitionByWorkstream()`/`selectClaimable()`,
because a substring gate cannot tell a true clause from a false one and the
retired criterion passed every substring gate in the repo for eight rounds.

**R49.** `PARALLELISM_GUIDE` is **replaced**, not supplemented. Its current text
("Tasks in the SAME round run in PARALLEL … Anything that could collide goes in
consecutive rounds instead") becomes actively wrong under the graph and must not
survive anywhere in the tree. Retiring it and its assertions happens in one
commit (standing rule 4).
*How proved:* review — `grep -rn "consecutive rounds" forge-control/` is empty;
unit — the old assertion is deleted, not skipped.

**R50.** `IDEMPOTENCY_NOTE` is updated to state that identity is still
`(project, round, role, title)` **and that round is now computed**, so a repeated
curl with the same `depends_on` produces the same round and therefore still
409s. A planner that believed otherwise would retry into a duplicate.
*How proved:* unit — prompt content; unit — a double-create with identical body
yields one row.

**R51.** The architect (goal-mode) prompt keeps seeding one planner per phase at
`round: k*100` — the one legitimate hand-written round in the system, a phase
label, explicitly described as such in the prompt.
*How proved:* unit.

**R52.** The builder prompt requires the task's own `write_set` to be restated in
its report and requires the builder to say so loudly if it wrote a file outside
it. A declared write-set nobody checks is a suggestion.
*How proved:* unit — prompt content; and the reviewer gate in R57.

**R53.** `taskCurl()`'s example body shows the new fields and omits `round`.
*How proved:* unit.

---

## G. Observability — phase 6

**R54.** `GET /api/chat/:id/plan` returns real edges: `PlanTask.deps` is the
task's `depends_on` when non-null, and today's synthesised "every strictly lower
round" set when NULL. The response **shape does not change** — this is the
refinement `groupPlanPhases`'s own doc-comment anticipates.
*How proved:* unit — `check-plan-store.ts` extended; review.

**R55.** `PlanTask` gains `workstream: string` and `depth: number`. The Kanban
chip shows the workstream when it is not `main`, and the phase block still
groups by `floor(round / 100) * 100`.
*How proved:* `check` — `scripts/checks/check-plan-store.ts`.

**R56.** `GET /api/projects/board` and `GET /api/projects/:id` include
`depends_on`, `workstream` and `write_set` on every task, via `TASK_COLS` and
`TASK_COLS_PT` — both lists updated together, as their existing doc-comment
requires ("a new column can never again be added to TASK_COLS and silently
forgotten in a hand-written joined SELECT").
*How proved:* review + unit.

**R57.** The reviewer prompt gains one gate: for every builder task in the group,
the files actually changed by that task's commits are compared against its
declared `write_set`, and an undeclared write is a **finding**, not a footnote.
The gate is satisfiable — it compares committed paths, which `git log --name-only`
yields for free — and it is the enforcement point for R52.
*How proved:* unit (prompt content) + review.

**R58.** Every spawn log line names the workstream and the dependency count
alongside the round, so the log Konrad follows a project from says why a task
started when it did.
*How proved:* review.

---

## H. Measurement — phase 7

**R59.** `scripts/measure-schedule.ts` reports, for one project id: the
round/task table of `00-vision.md` §2, run count, mean run duration, wall clock,
mean concurrent runs sampled per minute, the parallelism ratio (S2), and the
maximum "numbering stall" (S3 — minutes a `pending` task spent with every
dependency already `done`).
*How proved:* the script runs and prints.

**R60. The instrument declares its own identity.** The script's first output
line is its git SHA, the schema version it read (presence of `depends_on`), the
project id, and the row counts it is computing from. A measurement whose
provenance is not printed is not a measurement.
*How proved:* review — run it against the fixture and read the header.

**R61. The instrument fails loudly.** If it cannot resolve a run for a task, or
a timestamp is missing, or the project has fewer than 5 tasks, it exits non-zero
with the reason rather than printing a smaller, prettier table.
*How proved:* unit — feed it a truncated fixture and assert exit ≠ 0.

**R62.** A baseline run against `operator-visibility` (8ea0cc08) is committed at
`docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md`, produced by the same
script, so the before and after are measured by one instrument.
*How proved, amended round 217 (round 216's finding 1) and again round 811:*
`python3 docs/plan/engine-task-graph/check-instrument-identity.py` exits 0 —
every `instrument-sha256:` header pasted in that file equals
`sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum`
on disk, every pasted `instrument-files:` line equals the current digest of the
half it names, and no retired identity is
quoted anywhere in the corpus without the marker `[historical instrument]`.
*Round 811 retired the one-file form of this clause* — it named
`sha256sum scripts/measure-schedule.ts` alone, which no longer produces the
header's value and therefore could not be satisfied at all, and which never
covered `schedule-source.ts`, the half holding the SQL. Retired here, in the
commit that changed the checker, per standing rule 4. The
old wording — *"the file exists and its header names the script's SHA"* — was
satisfiable by a file naming a SHA the script no longer has, and for two rounds
that is exactly what it was satisfied by. It is replaced rather than supplemented
because it did not fail when it should have; standing rule 4's retire-together is
discharged here, in the same commit as the checker it hands the job to and as
`03-quality.md` §3.1 item 7, which runs it.

**Amended round 213 — the baseline lands in two parts, one instrument.** This is
a **split, not a retirement**: nothing is dropped and no gate clause is relaxed,
so standing rule 4's retire-together does not apply. R62 is discharged in two
appends to one file:

- **Part 1 — phase 7, from the committed fixture.** The round/task table of
  `00-vision.md` §2, whole-project and windowed, plus the correction of §2 and
  the discrepancy analysis. **Landed** — every header pasted in that file names
  the same `instrument-sha256`, and that value equals
  `sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum`
  on the commit it ships in, which is
  what *How proved* above asks for and is satisfiable without a database.
  *Round 811 widened the command from one file to both, for the reason given in
  How proved; the bullet is amended here rather than left to be found later,
  which is the failure the paragraph below records.*
  *Bullet corrected round 802 (phase 8C), where the retired wording was still
  enforced.* This bullet ended **"the file exists and its header names the
  script's self-computed `instrument-sha256`"** — the exact formulation round
  217 replaced two paragraphs above, because "names a SHA" is satisfied by a
  header naming a SHA the script no longer has, and for two rounds that is what
  it was satisfied by. R62's body was amended in round 217; **this restatement
  of it was missed**, so one requirement stood in the corpus in two versions,
  one checkable and one not, and a reader arriving at the bullet first would
  have inherited the retired one. `check-corpus-map.py` compares the three
  statements of the requirement MAP — ids, phases, counts — and cannot see a
  prose sentence disagreeing with a requirement body, so nothing mechanical was
  ever going to catch this; it was found by an operator reading, and it is
  repaired here rather than annotated elsewhere (standing rule 2: amend the gate
  where it is enforced). The surviving formulation is checked by
  `check-instrument-identity.py`, `03-quality.md` §3.1 item 7.
- **Part 2 — phase 8, from the one authorised live read.** S1, S2, S3, run
  count, mean run duration and wall clock. They are **not derivable in phase 7**:
  the phase-1 fixture carries exactly six keys per row (assertion A3 of
  `forge-control/src/lib/fixtures/replay-operator-visibility.md`) with no
  `run_id` and no run timestamps, and `03-quality.md` §2.3 gives live reads to the
  deploy/verify task alone. `measure-schedule.ts full` exits non-zero over that
  fixture rather than printing a smaller table (R61), and that refusal is the
  mechanical form of this split. Phase 8 runs
  `measure-schedule.ts full --project 8ea0cc08-28d9-4301-9f28-c98e1c5d6838`
  against the live database at **step 2b** of `04-phases.md` §8's deploy
  sequence — **BEFORE step 3 applies migration 0040**, and therefore before the
  after-measurement of DoD-6 — and **appends** its output to the same file, so
  the before and the after are still produced by one instrument as this
  requirement requires.

**Amended round 215 — the read is pinned BEFORE the migration, and the
instrument now refuses the shape.** Round 214's phase-7 review measured this: the
0040 backfill's final `UPDATE … WHERE pt.depends_on IS NULL` writes the
strictly-lower-round closure over every pre-existing row, destroying the sentinel
D7's refusal keys on, and under that closure every S3 term is 0 by construction.
Fed the literal motivating case the committed instrument printed
`S3 max numbering stall (min) 0`, `legacy-rows=0`, **exit 0** — a certified
"no numbering stall" for the project whose numbering stall is this project's
justification. R62 said only "before the after-measurement", which permitted the
read *after* the migration; that permission is now withdrawn. Two repairs, one
commit, neither replacing the other: this ordering (here, in E-3, and in
`03-quality.md` §3.2's phase-8 gate), and a durable detector — `isClosureShaped()`
in `forge-control/src/lib/schedule-metrics.ts` refuses S3 when every row matches
the closure, with `closure-shaped-rows` printed in the header in every mode.
*How proved, additionally:* `schedule-metrics.test.ts`'s
`describe("D7 — a project carrying migration 0040's backfilled closure")`,
watched failing against the pre-round-215 module.

The binding statement of the phase-8 obligation is erratum **E-3** in
`04-phases.md` §12, which overrides any brief it contradicts;
`evidence/baseline-8ea0cc08.md` is listed in phase 8's "Files this phase writes"
in the same commit, so the append is not an undeclared write (`03-quality.md`
§3.1 item 4).

**Amended round 217 — two corrections, both from round 216's re-review, neither
changing what R62 requires.**

1. **The instrument moved, and part 1 was re-run rather than left mislabelled
   (finding 1).** Round 215's phase-7 repairs edited `scripts/measure-schedule.ts`,
   moving its self-computed identity from `80ef1123…` `[historical instrument]`
   to `f6828a68…` `[historical instrument]` — retired in turn at round 802, when
   phase 8B added E-3's `--exclude-task` flag; the marker is added here, in 8C's
   own file, because 8B's write-set cannot reach this line — while eight pasted
   headers, a `00-vision.md` §2.2 heading, a
   ledger row and a `sha256sum` block still named the old value. Round 217 re-ran
   all seven of part 1's commands under the current bytes; **every round/task
   table and the run-C refusal reproduced byte for byte**, so no measurement
   moved. "One instrument" is therefore restated as something a living instrument
   can promise and a script can check: *every header pasted in that file, part 1
   and part 2, names the same `instrument-sha256`, and that value equals the
   instrument on disk in the commit it ships in.* **Round 811: "the instrument"
   is BOTH files** — `scripts/measure-schedule.ts` and
   `forge-control/src/lib/schedule-source.ts` — composited in that order. If
   either half moves again before phase
   8 appends part 2, part 1 is re-run **in the same commit as the append**
   (`04-phases.md` §12, E-3; `03-quality.md` §3.2's phase-8 gate). *Round 811
   moved both halves and re-ran part 1 at once rather than at the append, which
   §1 of that file records; the obligation is discharged, not waived.*
2. **Step 2b yields a refusal, not a number (finding 2).** The round-215
   amendment below is correct about the ordering and overstated what it buys.
   Before migration 0040 the `depends_on` column does not exist, so every row is
   a legacy row and D7's **first** arm refuses: S3 for 8ea0cc08 is NOT COMPUTABLE
   at step 2b as well, and always was. The ordering buys the **honest reason**
   (the legacy sentinel, rather than the closure *signature* that survives the
   migration), plus S1, S2, run count, mean duration and wall clock — which are
   the numbers part 2 actually owes. Nothing here licenses expecting an S3 for
   this project. *How proved:* `schedule-metrics.test.ts`'s
   `describe("D7 — the pre-0040 read at step 2b refuses on the legacy sentinel")`,
   whose rows are built by the real `taskRow()` with `hasDependsOnColumn = false`
   and which was watched failing under two mutations.

R62's **primary owner phase is unchanged: phase 7.** Phase 8 discharges part 2
under R63–R68's deploy sequence and acquires no new requirement id — §K's mapping
and `04-phases.md` §9 are untouched by this amendment.

---

## I. Deploy — phase 8

**R63.** The deploy task confirms `operator-visibility` (8ea0cc08) has **no
running and no pending tasks** before doing anything, and aborts with a report
if it does.
*How proved:* live.

**R64.** Migration 0040 is applied to the live database **before** the executor
restarts, by `psql -f`, and its re-runnability is demonstrated by applying it
twice. It is additive and the running old engine ignores it (R8).

The gap this opens between the backfill and the restart is **not** closed by
sequencing — `safe-restart.sh` is detached and self-timed, and its "quiet" is a
45-second heartbeat window a tick can fire inside. It is closed by R69, in the
engine, where no timing argument is needed. The deploy task must therefore
**not** try to be clever about when it runs `psql -f`; running it early is still
the correct order. See `02-architecture.md` §3.2.1 and §9.2.
*How proved:* live.

**Amended round 802 (phase 8C) — the migration-number collision, and the rule it
obliges. Operator ruling, on the record.** Two active projects independently
claimed number **0040** and neither could see the other: `operator-visibility`
wrote `0040_usage_hourly.sql` (which creates **`usage_hourly` AND
`app_settings`**) and `0041_ui_dismissals.sql`; this project wrote
`0040_task_graph.sql`. Round 801's merge brought both sides in and git raised no
conflict — different filenames — so `main` now carries **two files numbered
0040**. Verified by the operator: there is **no migration runner and no tracking
table** (`schema_migrations` and `migrations` are both absent), migrations are
applied by hand with `psql -f`, and `migrations.test.ts` sorts filenames without
asserting unique numbering. The collision is therefore survivable, and **no
rename is being forced**: renaming would invalidate a phase that already passed
review with `0040_task_graph.sql` pinned inside `check-migration-0040.sh` and its
evidence document. The renumber is tracked as a **post-deploy task**, seeded by
the operator. Four clauses, binding on the deploy task:

1. **Apply migrations by EXPLICIT FILENAME, one at a time. Never
   `for f in db/migrations/*.sql`.** A glob sorts `0040_task_graph.sql` before
   `0040_usage_hourly.sql` and thereby *silently decides an order nobody chose* —
   the same failure this project exists to remove from the scheduler, one layer
   down. Two files numbered 0040 are inert together (disjoint objects, no version
   ledger to collide in, no boot-time runner) but ambiguous to any number-keyed
   runner a future round adds.
2. **Confirm each table exists AFTER applying, BY NAME.** Do not infer that the
   file ran from the fact that the command returned. R2's re-runnability is a
   property of the statements; a table's existence is a property of the database
   and is read from `information_schema`.
3. **Two 0040s on `main` is EXPECTED.** It is not fixed mid-deploy and it is not
   a merge error. 8A's judgement — that renaming the migration this project
   exists to ship is a briefed decision and not a merge side-effect — is
   preserved here deliberately.
4. **Three files, not one.** The operator verified that `usage_hourly`,
   `app_settings` and `ui_dismissals` are **ALL absent** from `content_forge`.
   `/api/chat/:id/team` will `500` (the team panel will not render at all) and
   `/api/usage/series` will `500` hourly, if `forge-control` restarts before
   they exist — and step 4 of the deploy sequence restarts it. All three files
   are `IF NOT EXISTS` and re-runnable, so applying them early is safe and
   **skipping them is not**. The order and the enforcement are in
   `04-phases.md` §Phase 8 step 3.

**Resolved round 950 (post-deploy), and clause 3 retired with it.** The renumber
that this amendment tracked as a post-deploy task has been done, with the tree
quiet and both deploys landed: `git mv db/migrations/0040_task_graph.sql
db/migrations/0042_task_graph.sql` (0041 was already `0041_ui_dismissals.sql`).
*That command is quoted as it was run: the file is at `0043` since round 974,
and rewriting a transcript to match a later rename would falsify it. See the
round-974 entry below.*
The `git mv` itself changed no bytes — `sha256` read `5c0ad159911d10b6…`
immediately before and immediately after it — though the same commit then edited
the file's *comments* (a renumber-provenance paragraph and the `graph_frozen`
`COMMENT ON` wording), so the committed file hashes `5a0c9d58cef400c7…`. **No DDL
and no backfill statement was touched**, which `check-migration-0040.sh`
re-proved rather than asserted: 44/44 assertions, second application `UPDATE 0`,
both snapshots byte-identical. And **nothing was re-applied to `content_forge`**. This was a rename of a file, not a migration run: the four
`project_tasks` columns (`depends_on`, `workstream`, `write_set`, `graph_frozen`)
and both R7 indexes were read from `information_schema`/`pg_indexes` before the
`git mv` and again after the whole change, and were identical. **The migration
therefore remains applied under its ORIGINAL name `0040_task_graph.sql`**, which
is a fact about history and not a discrepancy to repair; the live
`COMMENT ON COLUMN project_tasks.graph_frozen` still carries the pre-rename
wording for the same reason, and will only change if anyone ever re-applies the
file.

- **Clause 3 above ("Two 0040s on `main` is EXPECTED") is RETIRED**, together
  with its enforcement in `04-phases.md` §Phase 8 step 3, in the same commit. It
  was a *deploy-time* instruction not to fix the collision mid-flight. The deploy
  is done and the collision is gone, so the clause now describes a repo state
  that no longer exists. It is kept above, in place, as the record of why the
  deploy proceeded with two 0040s rather than stopping. *(Round 974: still
  retired, and still correct about **0040**. `main` does continue to carry this
  file at `0040_task_graph.sql` beside `0040_usage_hourly.sql` — the round-950
  renumber has not been merged there — which is why the number chosen below had
  to be free on `main`, not merely free here.)*

**Renumbered AGAIN at round 974: `0042_task_graph.sql` → `0043_task_graph.sql`.**
The identical collision recurred through a merge. `main`'s `553fa38` added
`0042_daily_goals.sql`; round 972's merge of `main` into this lane
(`37cc974`) brought it alongside this project's `0042_task_graph.sql`, and git
raised no conflict — for the third time — because the filenames differ. It was
found by round 973's reviewer, through the guard that already existed:
`forge-control/src/db/projects.test.ts` REFUSES TO RUN on a duplicate numeric
prefix rather than letting sort order choose, so the collision presented as a
test that would not start rather than as a wrong answer. **This file moved rather
than `main`'s, on two measured grounds:** nothing named `0042` has ever been
applied to `content_forge` (this migration is applied under `0040`, above; the
daily-goals one is applied under its own name), and the next number free on
`main` as well as here is `0043`. Pure `git mv` again — `sha256` read
`497fdae6cc31d672…` immediately before and immediately after — with the same
comment-only edit to the file's own provenance paragraph in the same commit.
Nothing was applied, and the live column comment still carries the round-950
wording for the reason given above. **The guard was moved into `pnpm test` in the
same commit** (`migrations.test.ts`, "no two migrations share a numeric prefix"):
the collision arrives by MERGE, so the thing that catches it has to run on every
commit and not only when somebody has a scratch database to hand.
- **Clause 1 is NOT retired and never should be.** "Apply migrations by explicit
  filename, never a glob" is the durable rule, and it is durable precisely
  because renumbering removed the symptom without removing the cause: two
  projects can still number a migration independently, and git will still merge
  them without a conflict, because the filenames differ. This is the second time
  it has happened.
- **What the renumber touched.** Re-derived at round 950 with `grep -rn
  "0040_task_graph"` and a second sweep for bare `0040` — **23 files**, not the
  six that phase 8A enumerated. The gap is recorded as a finding in
  `evidence/round950-renumber.md`; the most consequential miss was
  `forge-control/src/lib/migrations.test.ts`, which reads the migration by
  hard-coded filename and asserts it is in the enumerated corpus, so a renumber
  that had trusted 8A's list would have gone red in `pnpm test`. Phase-evidence
  files were deliberately **not** rewritten: they record what was executed under
  the old name and rewriting them would falsify the record.

**R65.** After merging, the deploy task runs **exactly**

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
```

detached, and **ends**. It never waits, polls or tails. `pm2 restart
forge-control` is allowed and is the right way to pick up the route changes.
*How proved:* live + review of the task's transcript.

**R66.** `pm2 restart forge-executor` appears nowhere in this project's diff, in
any script, brief or doc, except inside a sentence forbidding it.
*How proved:* `check` — `03-quality.md` §4's block runs
`grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'`
with **every hit inspected**, which is the rule this requirement states. Amended
round 215 alongside that block (round 214's phase-3 finding 5): the `*.md` sweep
and the `grep -v -i "never\|forbidden\|not to deploy"` filter are gone. The
filter encoded a narrower rule than "except inside a sentence forbidding it" —
a sentence may prohibit in other words — and left twelve permanent survivors,
all of them prose prohibitions, so the gate could not be passed by any tree. §4
carries the reasoning and the expected hit count; a requirement and its gate
clause were retired together, in one commit.

**R67.** After the restart lands, a verification task confirms against live: the
columns exist, a graph-scheduled task promotes without its round draining, a
cycle POST returns 400 with a named path, and two workstream worktrees exist on
disk with the expected branches.
*How proved:* live.

**R68.** The DoD-6 measurement is produced for a project scheduled by the new
engine and committed beside the baseline, with the comparison table.
*How proved, amended round 802 (phase 8C), in the round that discharges it, and
round 811:* the file exists; **its pasted identity MATCHES the composite
`sha256sum` of BOTH instrument files on
disk**, checked by `check-instrument-identity.py` (`03-quality.md` §3.1 item 7);
and the before-file and the after-file **share one instrument** — the same
`instrument-sha256` in every header of both, per R62's surviving formulation.
S1 and S2 are stated as numbers; S3 is stated as a number **for the after-project
only**, because S3 for the 8ea0cc08 baseline is a refusal by construction and
always was (R62's round-217 amendment, `04-phases.md` §Phase 8 step 2b) — a
comparison table demanding an S3 on both sides is a gate no correct deploy can
pass.

*What was retired, and why it had to be:* the old wording read **"the file
exists; S1–S3 are stated as numbers with the script's SHA."** Both halves were
unsatisfiable-or-worthless in opposite directions. "Exists and names a SHA" is
satisfied by a file naming the **wrong** SHA — the defect round 216 found in
thirteen places on this corpus, one of them a `sha256sum` block the document
offered as an independent re-derivation and which had been **pasted rather than
executed**. And "S1–S3 as numbers" demanded of the baseline a number D7 is
designed never to produce for a legacy project. Retired here in the same commit
as the clause that replaces it and as the phase-8 gate that runs it
(`03-quality.md` §3.2), per standing rule 4.

---

## J. Non-functional

**NF1. No silent fallbacks.** Every degradation in this diff is either a hard
error or a `console.warn` naming the row. Specifically forbidden: a dangling
dependency reading as satisfied (R14); an unparseable workstream defaulting to
`main`; a write-set validation failure being dropped; a missing worktree being
recreated as the main one.
*How proved:* review — the reviewer lists every `catch`, `?? default` and
`|| fallback` added by the diff and states why each is not a swallowed error.

**NF2. Operability over elegance.** No new dependency, no new process, no new
table. One new pure module, one migration, four columns (the fourth is R71's
`graph_frozen`, added round 242 — additive, defaulted, and read by exactly one
predicate).
*How proved:* review — `git diff --stat` and `package.json` unchanged.

**NF3. Test-process purity.** No test opens a database connection, a network
socket, or a real worktree. Anything needing Postgres is a `scripts/checks/*`
script run explicitly against a throwaway schema, never part of `pnpm test`.
*How proved:* `pnpm test` passes on a host with Postgres stopped.

**NF4. Type safety.** `tsc --noEmit` is clean in `forge-control/` and
`forge-control-web/`. No `any` introduced; no `as` cast used to make a role or
status narrow — narrow by comparison, as `assertVerdictRole` does.
*How proved:* `pnpm typecheck`.

**NF5. Backwards compatibility for in-flight projects.** A project mid-run when
the new engine loads continues to completion with its round semantics via the
NULL branch. No in-flight project is re-planned, re-numbered or re-branched.
*How proved:* R18 + live observation of 8ea0cc08's successors.

**NF6. The legacy branch is retirable in one commit.** R12's NULL branch,
its tests, and the sentinel's documentation are written so that deleting them is
one commit once no `depends_on IS NULL` rows remain. A `TODO(R12-retire)` marks
each site. *How proved:* review — the marker appears at every site and nowhere
else.

**NF7. Prompt budget.** The planner prompt grows by no more than **3700**
characters net. Every worker prompt already carries WORKTREE_POLICY +
ESCALATION_POLICY + MANAGER_COMMS, and unbounded prompt growth is a real cost
per spawn.

*Amended at round 240 by the operator's ruling; this text read "~1500" and the
assertion that enforces it read 3050, so the two disagreed and **the measured
number wins**.* The original figure assumed the retired round guide's removal
would pay for most of the new text. Measured at round 239: it pays **314 of
3221**, for a net of **+2398**. 1500 is unreachable while R47's companion-files
clause and R38's integration paragraph are stated in the terms their
requirements demand — the only text that fits is text that satisfies
`.includes()` and misleads a planner, which 03-quality.md §3.2 calls a passing
gate on a broken deliverable. Round 240 spent 476 of the remaining 652 on the
withPolicy() addenda, leaving 176; round 242 spent 26 of that on naming the two
research role literals in GRAPH_GUIDE's fan-out sentence, leaving **150**. Every
character since the 5A tip is attributed to the round that declared it, by the
ledger the NF7 block enforces — an unledgered edit fails with its own size in
the message rather than borrowing an earlier round's reservation.

*Pins, re-derived at round 240 and corrected — the round-239 commit message
quotes a baseline of 9279 and a total of 11677; the second is `9279 + 2398`, a
sum rather than a measurement, and the first is 92 too high. Measured through
the maximal path (repo-backed, goal mode, manager-chat linkage): **9187** before
phase 5 (`d9858b9`), **11585** after it (`05f2842`), **12061** after phase 5B.
The itemised +2398 was exact; only the baseline pin had rotted.*

*Re-derived again at round 242, and **these are the live pins** — the three
above are superseded and kept only so this paragraph reads as the history it is.
Round 240 measured at a fixture whose project id was `"p1"`; every real project
carries a 36-character uuid, which `taskCurl()` renders **once**, so the maximal
path was understated by a flat **34** at every sha. Measured through the same
maximal path at a uuid-shaped id: **9221** before phase 5 (`d9858b9`), **11619**
after it (`05f2842`), **12095** after phase 5B (`fe14a7e`), **12121** after
round 242's GRAPH_GUIDE fix. The enforced `BASELINE` is **9221** → cap
**12271**, and the live headroom is **150**.*

*Two spends since, each measured through the same maximal path and each carried
as its own row in the NF7 ledger that `project-tick.test.ts` enforces. **Round
900**: +106 for the `write_set`-definition sentence, 12121 → **12227**, headroom
44. **Round 960**: **+19 net** for the workstream criterion — the retired clause
is 73 characters and its replacement 92 — 12227 → **12246**, headroom **25**. A
replacement is ledgered at its NET and the delivery control has two halves (new
clause present, retired clause absent), or a round that added without removing
would charge 19 for 92 and the arithmetic would go looking for the difference in
someone else's text.*

*Which way that moved the gate, since a rising cap read alone is a widening and
this one is not: **budget and tightness are both unchanged**. The +34 lands on
the baseline **and** on every measurement taken at that fixture, so the headroom
is identical at every pin — 652 at 5A, 176 after 5B — and **3050 is untouched**.
The frame moved, not the allowance. (Round 242 recorded this as "tightens by
34", which is backwards; corrected at round 244 with the measurement, in
`project-tick.test.ts`'s NF7 block and in `evidence/phase5-fix-cycle-1.md`.)*

*Amended a second time at **round 822**: **3050 → 3700**, cap **12271 → 12921**,
and unlike the two paragraphs above **this one is a widening** — 650 characters
that could not have been spent before it can be spent after it. Round 961 left
three findings that are each a NEW RULE in `GRAPH_GUIDE`, not a word swap: the
cap counts the `"main"` every project is born in (so the openable count is
`cap - 1`); a task does **not** inherit its creator's workstream, so FAN-OUT
teaches a fan-out that lands in one lane and runs one at a time; and
`depends_on` is immutable at insert (N7), so a lane opened **for** a planner can
never be integrated by whoever opened it. Headroom before the amendment: **25**.
MEASURED with `scripts/checks/measure-graph-guide-budget.ts` (round 822, new —
it parses `BASELINE`/`BUDGET`/`FIVE_A_TIP`/every `spent` out of the enforcing
test rather than copying them, and re-executes the ledger's own `assert.equal`
before reporting): a reference wording of the three rules, built by
**transforming** the live constant so all 23 gate-frozen needles survive by
construction, measures **1951 → 2515, +564 net**, projecting **12810** against a
cap of 12271. Shrinking cannot pay — round 960 spent the last retirable clause
and the reference wording retires a second (`"the cheapest parallelism there
is"`, 33 characters, which finding 4 shows is false while every researcher lands
in `"main"`) — and writing text that merely fits is the option round 239's
amendment already refused in these words: "the only text that fits is text that
satisfies `.includes()` and misleads a planner". Of the new 675 of headroom,
**650 is reserved for round 962** (564 measured + 86 of margin, so that round
phrases the rules its own way instead of inheriting a second barely-passable
gate) and **25 is the pre-existing unreserved slack**. No LEDGER row is added by
round 822: the ledger is an `assert.equal` against a live measurement, so a row
for unwritten text fails immediately — round 962 adds
`{ round: 962, spent: <measured net>, reserved: 650 }` in the commit that spends
it, exactly as round 239 reserved 652 and builder 5B added the row at round 240.
Reported to manager chat `bfd1283a` for a ruling rather than taken silently.*

***THE RULING CAME BACK, AND IT CAME BACK WITH A CONDITION — recorded here at
round 824, because a paragraph saying a ruling was REQUESTED reads, to the round
that needs it, exactly like a ruling that never arrived.*** *Round 822 could not
have written this: the ruling postdates its commit. Operator, 2026-08-18, in
manager chat `bfd1283a`, arithmetic re-checked independently before agreeing
(`9221 + 3700 = 12921`; live 12246; 675 new headroom, 650 reserved; projected
12810 fits):*

> ***OPERATOR RULING — NF7 BUDGET 3700 is CONFIRMED. Round 822's default
> stands.*** *Confirmed against the operator's own standing rule that a budget
> which rises whenever it binds is a comment and not a budget, for three stated
> reasons: **(1) it trimmed first** — round 960 spent the last retirable clause
> and 822's wording retires a second, so the round-902 precondition* trim first,
> raise second *was met rather than skipped; **(2) unsatisfiable by 22× is not
> "binding", it is impossible** — 564 needed against 25 available, and this
> project has ruled ten times that an unsatisfiable gate is a defect in the gate;
> **(3) the three rules are engine facts a planner cannot work without**, and
> compressing them into text that passes `.includes()` while misleading a planner
> is the failure this project has refused nine times.*
>
> ***THE CONDITION, and it is the point of confirming rather than
> rubber-stamping: this is the LAST widening that gets to be routine.*** *NF7 has
> now moved three times in one project — 1500 → 3050 → 3700. **Any future NF7
> increase must state, in its own commit, WHAT WAS RETIRED FIRST AND WHY IT DID
> NOT PAY, with the measurement.** A budget whose every breach is answered by
> raising it has stopped measuring anything.*

*So the sequence a round 964 owes, before it may propose a fourth number: name
the clause it retired, measure what that retirement bought with
`measure-graph-guide-budget.ts --candidate`, and show the shortfall that
survives — in the commit, not in a report. The instrument exists precisely so
that "shrinking cannot pay" is a measurement rather than an assertion; round 822
made that claim and backed it, and the condition is that every successor does
the same.*

***THE RESERVATION IS SPENT, AND IT WAS SPENT UNDER BUDGET — round 962, the
commit that closes this paragraph.*** *The 650 reserved above bought findings 3,
4 and 5 as three rules in `GRAPH_GUIDE`, and NF7's LEDGER now carries
`{ round: 962, spent: 637, reserved: 650 }`. **`BUDGET` is untouched at 3700**,
so the condition attached to the ruling — state what was retired first and why it
did not pay — did not have to be met, because there was no increase to justify.*

*The number worth keeping is the one that came from using round 822's instrument
the way it was designed to be used, **before** the edit rather than after. The
first candidate measured **+667**: inside the cap of 12921, and still 17
characters past this reservation. Answering a 17-character overrun by moving the
ceiling is exactly the reflex the ruling forbids, so the candidate was **trimmed
to +637** — four edits, none of them to a rule, each recorded with its
before/after in `evidence/round962-fix-cycle-1.md` §2. Live measurement after the
edit: **12883 against 12921, 38 of headroom**, and the shipped constant is
byte-identical to the measured candidate (sha256 `57762f7296f71ca5`), so the
figure is not re-derived from the thing it describes.*

*One divergence from round 822's reference wording, recorded because §J predicted
it and it did not happen: that wording retired* `"the cheapest parallelism there
is"` *(33 characters) on finding 4's reasoning that the phrase is false while
every researcher lands in* `"main"`. *Round 962 **kept** it. The phrase was never
false about research; it was false about research planned **without a
workstream**. Once the guide states that a task does not inherit its creator's
workstream and tells the planner to give each researcher a lane, the sentence
describes something the engine really delivers —* `check-workstream-claim.ts`
*`6.8a`/`6.8b` measure exactly that, 1 wide without the field and 4 wide with it.
Round 822 said its wording was a sizing input and not the deliverable, and that
round 962 owned the text; this is that ownership exercised rather than left for a
reviewer to discover.*

*How proved:* unit — a length assertion on the built planner prompt, with the
budget written into the assertion message.

---

## K. Requirement → phase map

| Phase | Requirements |
|---|---|
| 1 — Schema, fixture, replica harness | R1–R9, R71, R18 (harness only), NF3 |
| 2 — Graph scheduler | R10–R21, R69, R72, R18 (proof), NF1, NF6 |
| 3 — Task creation, validation, cycles | R22–R31, NF4 |
| 4 — Workstream worktrees, integration, consolidation | R32–R46, R70, R17 (warn clause), NF1, NF5 |
| 5 — Prompts | R47–R53, NF7 |
| 6 — Observability, plan API, Kanban | R54–R58 |
| 7 — Measurement instrument | R59–R62 |
| 8 — Deploy and verify | R63–R68, NF2, NF5 |

Every requirement has exactly one **primary owner** phase. Two ids appear in two
rows and each is deliberate and named where it appears: **R18** (phase 1 builds
the harness, phase 2 makes it pass) and, from round 202, **R17** (phase 2 the
contention clause, phase 4 the `console.warn` on the spawn path — see R17). NF1
and NF5 are audits performed at two phases. `04-phases.md` §9 restates the
mapping from the phase side and must agree with this table exactly; if they
disagree, **this table is a finding**, not a discrepancy to reconcile silently.
`check-corpus-map.py` in this directory enforces the agreement mechanically —
run it after editing either table.
