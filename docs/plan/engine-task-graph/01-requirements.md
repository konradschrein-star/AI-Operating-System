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

**R1.** A single new migration `db/migrations/0040_task_graph.sql` adds every
column, index and backfill this project needs. No second migration file.
*How proved:* unit — `migrations.test.ts` lints it; `git ls-files db/migrations`
shows exactly one new file.

**R2.** Every statement in 0040 is re-runnable: `ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX ... IF NOT EXISTS`, and the backfill `UPDATE` guarded by a
predicate that makes a second application a zero-row no-op. There is no
migration ledger and no runner in this repo — applying a migration is a manual
`psql -f`, and the only defence against applying it twice is the statement
itself. *How proved:* unit — a new case in `migrations.test.ts` naming
`0040_task_graph.sql` explicitly, in the shape of the existing 0039 case.

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
the term that makes it one, `02-architecture.md` §3.2.1 is the reasoning, F13 is
the failure mode, and R18 case (f) is the test. Widening the backfill is *not*
an alternative — it would have to name rows that do not yet exist.
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
immediately. *How proved:* unit over the pure rule; `check` against a throwaway
Postgres for the SQL.

**R12.** `promoteReadyTasks()` retains the legacy branch: when
`depends_on IS NULL`, the task promotes under today's rule — no task of the same
project in a strictly lower round is anything other than `done`. Both branches
live in **one** statement, so a task can never satisfy neither.
*How proved:* unit + `check`.

**R69. The legacy-row term.** The graph branch additionally refuses a candidate
while **any legacy row** (`depends_on IS NULL`) of the same project in a
strictly lower round is not `done`. Without it a backfilled row, whose closure
was frozen when 0040 ran (R6), promotes straight past a row the old engine
inserted afterwards — `createFixChain`'s builder at `round + 1` and re-reviewer
at `round + 2`, both born NULL — because no frozen closure can name them. On
`operator-visibility` that chain lands at 1307/1308, below every one of its
eight `pending` rows, so the hazard is reachable on the deploy's own target.
Ruled as **E3** in `02-architecture.md` §9.2, reasoned in §3.2.1, tabled as
**F13**. On a project planned after the restart no row is NULL, the term is
vacuously true, and `round` is never consulted — it costs only where it must.
It is part of the legacy surface: **deleted in the same commit as R12's branch
and R18 case (f)**, when no NULL row remains (NF6, standing rule 4).
*How proved:* unit — R18 case (f) fails without it and passes with it, shown by
mutation test in `evidence/phase1-migration.md` §13.4; + `check` for the SQL.

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
existing field keeps its exact current validation.
*How proved:* unit over the extracted pure validator + `check` against a
locally-mounted router (the single-router probe pattern; **not** the live
service).

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
segment, no NUL, ≤ 400 chars each, ≤ 200 entries, normalised (`./` stripped,
duplicate slashes collapsed) before storage. A violation is a `400` naming the
entry. *How proved:* unit — a table of good and bad paths.

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
slash form errors.

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
*How proved:* unit (the `400`, phase 3 — `scripts/checks/check-task-api.ts`);
`check-workstream-e2e.sh` (the provisioning half, phase 4).

---

## E. Consolidation — phase 4 (must not break)

**R40.** The consolidation group key becomes `(project_id, round, workstream)`.
Two reviewers of different workstreams that happen to land on the same computed
round are two groups, not one — a single merged fix builder could only live in
one worktree and would silently drop the other workstream's findings.
*How proved:* unit — a new case in `cp2-reconciler-interaction.test.ts` with two
same-round reviewers in different workstreams yielding two independent chains.

**R41.** `chainKeys()` gains a workstream namespace **only for non-`main`
workstreams**: `main` keeps `fix:<round>:<cycle>` / `rereview:<round>:<cycle>` /
`retest:<round>:<cycle>` byte-identically, so every historical chain replays
against the row it already wrote. Other workstreams get
`fix:<workstream>:<round>:<cycle>` and so on.

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

**R42.** Fix-chain rows created by `createFixChain()` carry the graph fields:
the fix builder `depends_on` = the gating task ids, `workstream` = the group's
workstream, `write_set` = the union of the write-sets of the tasks under review;
each re-checker `depends_on` = `[fix builder id]`, same workstream, empty
write-set. Without this the chain rows would be graph roots and would run
immediately, in parallel with the work they are meant to follow.
*How proved:* unit — a `createFixChain` shape test; `check` against a throwaway
Postgres.

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

**R46.** `unwedgeProject()` retries the earliest **failed group** rather than the
earliest failed round: earliest by `(round, workstream)` ordered by round then
workstream name, so an operator unwedging a project does not restart two
workstreams at once.
*How proved:* unit over the pure selection helper.

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
*How proved:* the file exists and its header names the script's SHA.

**Amended round 213 — the baseline lands in two parts, one instrument.** This is
a **split, not a retirement**: nothing is dropped and no gate clause is relaxed,
so standing rule 4's retire-together does not apply. R62 is discharged in two
appends to one file:

- **Part 1 — phase 7, from the committed fixture.** The round/task table of
  `00-vision.md` §2, whole-project and windowed, plus the correction of §2 and
  the discrepancy analysis. **Landed** — the file exists and its header names the
  script's self-computed `instrument-sha256`, which is what "How proved" above
  asks for and is satisfiable without a database.
- **Part 2 — phase 8, from the one authorised live read.** S1, S2, S3, run
  count, mean run duration and wall clock. They are **not derivable in phase 7**:
  the phase-1 fixture carries exactly six keys per row (assertion A3 of
  `forge-control/src/lib/fixtures/replay-operator-visibility.md`) with no
  `run_id` and no run timestamps, and `03-quality.md` §2.3 gives live reads to the
  deploy/verify task alone. `measure-schedule.ts full` exits non-zero over that
  fixture rather than printing a smaller table (R61), and that refusal is the
  mechanical form of this split. Phase 8 runs
  `measure-schedule.ts full --project 8ea0cc08-28d9-4301-9f28-c98e1c5d6838`
  against the live database **before** the after-measurement of DoD-6 and
  **appends** its output to the same file, so the before and the after are still
  produced by one instrument as this requirement requires.

The binding statement of the phase-8 obligation is erratum **E-3** in
`04-phases.md` §12, which overrides any brief it contradicts;
`evidence/baseline-8ea0cc08.md` is listed in phase 8's "Files this phase writes"
in the same commit, so the append is not an undeclared write (`03-quality.md`
§3.1 item 4).

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

**R65.** After merging, the deploy task runs **exactly**

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
```

detached, and **ends**. It never waits, polls or tails. `pm2 restart
forge-control` is allowed and is the right way to pick up the route changes.
*How proved:* live + review of the task's transcript.

**R66.** `pm2 restart forge-executor` appears nowhere in this project's diff, in
any script, brief or doc, except inside a sentence forbidding it.
*How proved:* `check` — `grep -rn "pm2 restart forge-executor"` over the diff,
with every hit inspected.

**R67.** After the restart lands, a verification task confirms against live: the
columns exist, a graph-scheduled task promotes without its round draining, a
cycle POST returns 400 with a named path, and two workstream worktrees exist on
disk with the expected branches.
*How proved:* live.

**R68.** The DoD-6 measurement is produced for a project scheduled by the new
engine and committed beside the baseline, with the comparison table.
*How proved:* the file exists; S1–S3 are stated as numbers with the script's SHA.

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
table. One new pure module, one migration, three columns.
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

**NF7. Prompt budget.** The planner prompt grows by no more than ~1500
characters net; `PARALLELISM_GUIDE`'s removal pays for most of the new text.
Every worker prompt already carries WORKTREE_POLICY + ESCALATION_POLICY +
MANAGER_COMMS, and unbounded prompt growth is a real cost per spawn.
*How proved:* unit — a length assertion on the built planner prompt, with the
budget written into the assertion message.

---

## K. Requirement → phase map

| Phase | Requirements |
|---|---|
| 1 — Schema, fixture, replica harness | R1–R9, R18 (harness only), NF3 |
| 2 — Graph scheduler | R10–R21, R69, R18 (proof), NF1, NF6 |
| 3 — Task creation, validation, cycles | R22–R31, NF4 |
| 4 — Workstream worktrees, integration, consolidation | R32–R46, R17 (warn clause), NF1, NF5 |
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
