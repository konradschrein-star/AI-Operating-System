# 04 — Phases: engine-task-graph

Base commit of this corpus: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e`.

Eight phases, strictly ordered. Phase *k*'s planner is seeded at round `k*100`;
the gaps hold fix cycles. Every requirement in `01-requirements.md` maps to
exactly one phase, and §9 below restates the mapping from the phase side — if
the two tables disagree, **that is a finding**.

**Why this order.** The scheduler cannot be proved without the schema and the
fixture (1 → 2). The API cannot write edges the scheduler does not read (2 → 3).
Worktrees and consolidation both touch `db/projects.ts` and `project-tick.ts`
and must not race the scheduler work (3 → 4). Prompts describe the API that
exists (4 → 5). The plan endpoint reports edges that exist (5 → 6). The
instrument measures an engine that exists (6 → 7). The deploy is last (8),
because `operator-visibility` is live and this diff is executor-loaded.

---

## Phase 1 — Schema, fixture, replica harness
**Planner round 100.**
**Requirements: R1–R9, R18 (harness only), NF3.**

### Scope
The migration, its lint case, the committed fixture, and the *shell* of the
replay proof. No engine behaviour changes; the old code keeps running against
the new columns without noticing them.

### Files this phase writes
```
db/migrations/0040_task_graph.sql                                    (new)
forge-control/src/lib/migrations.test.ts                             (append one case)
forge-control/src/lib/fixtures/replay-operator-visibility.json       (new)
forge-control/src/lib/task-graph.ts                                  (new, signatures + legacyRoundReady)
forge-control/src/lib/task-graph-replay.test.ts                      (new, harness)
scripts/checks/check-migration-0040.sh                               (new)
docs/plan/engine-task-graph/evidence/phase1-migration.md             (new)
```

**Round 106 (fix cycle 1) added four corpus files to this set**, declared here
rather than left to be reconstructed from the diff (standing rule 5). Round
105's reviewer blocked on a divergence whose ruling had to be recorded where the
design lives, and standing rule 2 requires a gate to be amended where it is
enforced:
```
docs/plan/engine-task-graph/02-architecture.md   (§3.1 SQL, §3.2.1 new, F13, §9.2 E3)
docs/plan/engine-task-graph/01-requirements.md   (R6, R18 case f, R20, R64, R69 new, §K)
docs/plan/engine-task-graph/03-quality.md        (§3.2 phase-2 gate names case f and R69)
docs/plan/engine-task-graph/04-phases.md         (this list, phase 2 deliverables 7–8, §9)
```

### Deliverables
1. **`0040_task_graph.sql`** — three `ADD COLUMN IF NOT EXISTS`, the workstream
   CHECK in a `DO $$ … $$` guard, two `CREATE INDEX IF NOT EXISTS`, and the
   closure backfill guarded by `WHERE depends_on IS NULL`. Column comments state
   the NULL sentinel's meaning in the database itself.
2. **The fixture.** Captured **once**, by a read-only `psql` query against
   `operator-visibility` (8ea0cc08), projecting only
   `{id, round, role, title, status, created_at}`. No briefs, no run ids, no
   prompts. This is the one read of live data any build phase makes, it is
   read-only, it is a `SELECT`, and it exists so no later phase ever needs one.
3. **`legacyRoundReady()`** — today's rule extracted verbatim into
   `task-graph.ts`, with the rest of the module's signatures stubbed to `throw
   new Error("phase 2")`. Stubs that throw, never stubs that return a plausible
   default.
4. **The replay harness** — `simulate(rule)` and the five case scaffolds, each
   printing the fixture row count and `git rev-parse --short HEAD` before
   asserting. It may fail at this phase; it must **run**.
5. **`check-migration-0040.sh`** — applies 0040 twice against
   `$SCRATCH_DATABASE_URL`, refuses to run if that variable is unset or names
   `content_forge`, and asserts the second application changed zero rows.

### Acceptance criteria
- `pnpm typecheck`, `pnpm test` green (the replay cases may be `todo`, and the
  planner must say which are and why).
- `migrations.test.ts` names `0040_task_graph.sql` explicitly.
- `check-migration-0040.sh` output pasted, including the zero-row second pass and
  the index existence checks.
- The fixture has > 100 rows and no string longer than 500 characters.
- Universal gate `03-quality.md` §3.1.

### Risks
The fixture is the one live read. If 8ea0cc08's task list is still growing when
it is captured, the fixture is a snapshot — that is fine and must be **stated**
in the fixture's sibling `.md` with the capture timestamp, not left implied.

**The fixture will not match the design spec's round table, and that is
expected.** Konrad hand-renumbered roughly a dozen `pending` tasks on
`operator-visibility` during the night of 2026-08-16/17, after the measurement in
the spec §1 and in `00-vision.md` §2 was taken at 03:04 (confirmed on the record
— `02-architecture.md` §2.3.3). A fixture captured now therefore carries
post-renumber round values.

This does **not** weaken the replay proof. The proof is self-consistent by
construction: the legacy rule reads the fixture's own rounds, and the backfilled
`depends_on` is derived from those same rounds by closure, so both schedulers are
judged against one ground truth whatever the numbers are. A hand-edited fixture
is arguably the *better* input — it is what this engine's data actually looks
like.

What it does mean: **do not "correct" the fixture toward the vision document's
table**, and do not report the mismatch as a data-integrity finding. Record the
capture timestamp and note that renumbering occurred. Phase 7 owns the
consequence (see its acceptance criteria).

---

## Phase 2 — The graph scheduler
**Planner round 200.**
**Requirements: R10–R21, R69, R18 (proof), NF1, NF6.**

### Scope
`promoteReadyTasks()` and `claimReadyTasks()` read the graph. The replica proof
turns green. This is the phase that removes the barrier.

### Files this phase writes
```
forge-control/src/lib/task-graph.ts                    (the stubs of deliverable 5)
forge-control/src/lib/task-graph.test.ts               (new)
forge-control/src/lib/task-graph-replay.test.ts        (cases turn green)
forge-control/src/db/projects.ts                       (promote, claim, sweep, retry, TASK_COLS, ProjectTask)
scripts/checks/check-scheduler-sql.sh                  (new)
docs/plan/engine-task-graph/evidence/phase2-replay.md  (new)

RETROACTIVE AMENDMENT, round 204 — two files phase 2 wrote in c54f860 that this
list did not name. §3.1 item 4 makes an undeclared write a finding, and it was
reported as one. Recorded here rather than quietly tolerated, because the reason
matters beyond bookkeeping: both edits were FORCED by widening the shared
`ProjectTask` type, which is exactly the shape of omission that clobbers once
workstreams are live (see R47's companion-files clause, added in the same commit).
forge-control/src/lib/cp3-linkage.test.ts               (object factory: 3 additive fields at schema defaults)
forge-control/src/lib/project-tick.test.ts              (object factory: same)

ADDED BY THE FIX CYCLE (round 204), for the five gating findings and the four
red-team findings:
forge-control/src/routes/tasks.ts                       (the retry refusal's 409, naming the ids)
forge-control/src/routes/projects.ts                     (unwedge's warning composed per reason)
docs/plan/engine-task-graph/01-requirements.md            (R14, R17, R27, R41, R47)
docs/plan/engine-task-graph/03-quality.md                 (§2.1 phase labels, §2.2, §3.2)
docs/plan/engine-task-graph/04-phases.md                  (this list, deliverable 5, phases 4 and 5)
docs/plan/engine-task-graph/evidence/phase2-replay.md     (§7.4, §9, §10 corrections)
docs/plan/engine-task-graph/evidence/phase2-fix-cycle-1.md (new — the fix cycle's record)
docs/plan/engine-task-graph/check-corpus-map.py           (provenance: a DIRTY marker on the sha it prints)
scripts/checks/check-scheduler-sql.sh                     (cases 8, 8b, 9, 10; the mirror driver step)
forge-control/src/lib/task-graph.ts                       (R14's duplicate arm; R17's proof base)
forge-control/src/lib/task-graph.test.ts                  (four duplicate/fan-in cases)
forge-control/src/lib/task-graph-replay.test.ts            (header: what this proof does NOT cover)

ADDED BY FIX CYCLE 2 (round 206), for round 205's single documentation finding.
Declared before the fact, per R47's companion-files clause. NO ENGINE FILE IS
WRITTEN — `projects.ts`, `task-graph.ts` and both test files are untouched, which
is the finding's own instruction and is checkable as an empty `git diff`:
scripts/checks/check-r20-census.py                        (new — R20's census, generated + asserted)
docs/plan/engine-task-graph/evidence/phase2-replay.md     (§3 frozen; §7 regenerated; §7.3 restated)
docs/plan/engine-task-graph/evidence/phase2-cycle-2.md    (new — this cycle's record)
docs/plan/engine-task-graph/01-requirements.md            (R20 "How proved")
docs/plan/engine-task-graph/03-quality.md                 (§3.2 Phase 2 — the R20 gate)
docs/plan/engine-task-graph/04-phases.md                  (this list)
```

### Deliverables
1. `promoteReadyTasks()` — the two-branch statement of `02-architecture.md`
   §3.1, including the cardinality equality that stops a dangling dependency
   satisfying readiness.
2. The **dangling-dependency sweep** (R14): a second statement in the same tick
   that moves such a task to `blocked`, blocks the project, and notifies naming
   the task and the missing ids. Not promoting is not enough — a task stuck at
   `pending` forever is the failure this project exists to end.
3. `claimReadyTasks()` — unchanged transaction shape, plus `selectClaimable()`
   for computed contention within a workstream.
4. `ProjectTask`, `TASK_COLS`, `TASK_COLS_PT` carry the three new columns. Both
   column lists updated **together** — their existing doc-comment demands it.
5. The stubs this phase owns implemented: `taskDepth`, `conflicts`,
   `selectClaimable`, `graphReady`, `readyRule`, `GraphIntegrityError`.
   **`computeRound` STRUCK ROUND 204** (standing rules 2 and 4): R23 assigns it
   to phase 3, `check-corpus-map.py` agrees, and requirement ids are
   authoritative over any prose enumeration of phases (round 102). As written,
   this clause made phase 2 close with a deliverable its own plan said it had not
   completed — a gate that could not be passed inside the phase's own scope. The
   matching case block in `03-quality.md` §2.1 is relabelled in the same commit.
   `findCycle`, `normaliseWritePath`, `validateWorkstream` (phase 3) and
   `groupKey` (phase 4) are likewise not this phase's, and their throwing is not
   a defect.
6. `TODO(R12-retire)` at every legacy-branch site, and nowhere else.
7. **The legacy-row term (R69)** in the graph branch of the same statement, and
   in `graphReady()`, which its doc-comment already specifies: a graph row is
   not ready while any `depends_on IS NULL` row of the project in a strictly
   lower round is not `done`. R18 case (f) fails without it. Ruled as E3 in
   `02-architecture.md` §9.2; do not re-open the question, and do not make case
   (f) pass by widening the harness's migration-time snapshot.
8. `readyRule()` is where the sentinel is interpreted — the harness's graph side
   already dispatches through it, so a mixed project's legacy rows take the
   legacy branch rather than a `graphReady()` taught to understand NULL.

### Acceptance criteria
- **The replay test passes, all six cases (a–f).** Output pasted.
- `check-scheduler-sql.sh` green, dangling case landing on `blocked`.
- **Added round 204, from the fix cycle:** R14 holds on **every** route into
  `running`, not only the promote statement — cases 8, 8b, 9 and 10 of
  `check-scheduler-sql.sh` green, each having been observed failing against the
  unfixed code, and each asserting that `graphReady()` and the SQL agree on the
  same row.
- `grep -n "round" forge-control/src/db/projects.ts` with a justification per hit.
- The reviewer names ≥ 2 mechanisms that could have made the replay report a
  pass wrongly and shows each is impossible.
- Universal gate.

### Risks
Highest-consequence phase for correctness. A wrong readiness predicate either
stalls every project or releases work early. The replay proof is the mitigation
and the red team of §5 in `03-quality.md` attacks it.

---

## Phase 3 — Task creation, validation, cycle detection
**Planner round 300.**
**Requirements: R22–R31, NF4.**

### Scope
The write path. Planners can now declare edges; the API computes the round and
refuses a graph that can never drain.

### Files this phase writes
```
forge-control/src/routes/projects.ts                   (POST /:id/tasks validation)
forge-control/src/db/projects.ts                       (createTask signature + insert)
forge-control/src/lib/task-graph.ts                    (findCycle, validators, computeRound)
forge-control/src/lib/task-graph.test.ts               (cycle table, validator table)
scripts/checks/check-task-api.ts                       (new — single-router probe)
docs/plan/engine-task-graph/evidence/phase3-api.md     (new)
```

### Deliverables
1. `POST /api/projects/:id/tasks` accepts `depends_on`, `workstream`,
   `write_set`; `round` becomes optional and is computed when absent.
2. Four families of `400`, each **naming the offender**: cycle (with the path),
   dangling/cross-project dep ids, bad workstream, bad write-set entry. Plus
   R24's block-overflow and R39's workstream cap.
3. `createTask()` writes the new columns; identity and the `409` are unchanged.
4. `metadata.strict_write_sets` honoured (R31).
5. `check-task-api.ts` mounts **only** the projects router on a spare port
   against `$SCRATCH_DATABASE_URL`. It must not boot `src/index.ts`, which starts
   the cron, telegram and vault ticks.

### Acceptance criteria
- The seven-row cycle table green, each asserting the **path's ids in order**.
- Double-POST with an identical body → one row, `409` on the second.
- Every 400 body pasted into the review.
- R26's belt comment present and honest.
- Universal gate.

---

## Phase 4 — Workstream worktrees, integration, consolidation
**Planner round 400. Adversarial review required.**
**Requirements: R32–R46, R70, R17 (warn clause), NF1, NF5.**

### Scope
The other half of the design: teams get isolated worktrees, and the verdict
group learns about them. The riskiest phase, because it touches the reconcile
module the brief forbids breaking.

### Files this phase writes
```
forge-control/src/lib/workspace.ts                          (provisionWorkstream, removeWorkspace)
forge-control/src/lib/project-reconcile.ts                  (groupKey, chainKeys)
forge-control/src/lib/project-tick.ts                       (spawn path, group loop, log lines)
forge-control/src/db/projects.ts                            (createFixChain, listVerdictRound, unwedge, roundIsComplete)
forge-control/src/lib/project-reconcile.test.ts             (APPEND ONLY)
forge-control/src/lib/cp2-reconciler-interaction.test.ts    (APPEND ONLY)
scripts/checks/check-workstream-e2e.sh                      (new)
docs/plan/engine-task-graph/evidence/phase4-workstreams.md  (new)
```

**`project-tick.ts` is written by phase 4 and phase 5.** They are consecutive
rounds and never concurrent. Phase 4 touches the spawn path and the log lines;
phase 5 touches the prompt constants. If a planner ever wants them parallel, the
answer is no — put them in two workstreams and an integration task, or keep them
sequential. Sequential is cheaper here.

### Deliverables
1. `provisionWorkstream(project, workstream)` — `project/<id8>-<ws>` branches,
   `<project-id>--<ws>` sibling directories, `main` unchanged in both. Race-safe
   by the same construction as `provisionWorkspace`.
2. `removeWorkspace` tears down every workstream (R35).
3. Group key `(project_id, round, workstream)`; `listVerdictRound` and
   `consolidateVerdictGroup` updated; `roundIsComplete` becomes group completion.
4. `chainKeys(round, cycle, workstream)` with the `main` special case that keeps
   every historical key byte-identical.
5. `createFixChain` writes `depends_on`, `workstream`, `write_set` on the chain
   rows (R42) — without this the chain runs immediately, in parallel with the
   work it follows.
6. The reviewer's diff base becomes the workstream fork point for non-`main`
   (R37).
7. `unwedgeProject` selects the earliest failed **group** (R46).
8. `PROJECT_MAX_WORKSTREAMS = 6` enforced at task creation (R39).
9. `check-workstream-e2e.sh` — including a **real merge conflict** that exits
   non-zero and names the file, and an assertion that nothing was auto-resolved.
10. **R17's warn clause** — one `console.warn` per spawn naming a
    `builder`-role task with an empty `write_set`. Relocated here from phase 2
    in round 202 for one reason: the clause lives in the spawn path in
    `project-tick.ts`, which §10 below assigns to phases 4 and 5, so phase 2
    could not satisfy it without writing outside its declared file ownership.
    Phase 2 keeps R17's contention clause; this is the other half.
11. **The hand-renumber hazard on the chain key** (R41, recorded round 204 from
    phase 2's red team). Deliverable 4 keeps `round` in the key, so an operator
    who renumbers a group after its fix chain exists lands a SECOND chain: the new
    `chain_key` collides with neither unique index, `insertChainRow()`'s
    `ON CONFLICT DO NOTHING` succeeds, and the `occupied` branch never fires
    because it is only reached on a conflict. Either rebase the identity onto
    something immutable (the gating task ids, by R29) or add a guard that makes a
    second chain for one group impossible — and record the choice in R41 with its
    reasoning. Doing neither is a decision too, and it may not be taken silently.

12. **R70 — the close gate (ADDED ROUND 222).** The named attack in the
    acceptance criteria below is not hypothetical: phase 4C read
    `closeFinishedProjects()` and found it has no workstream term, so a project
    whose planner forgot the integration task closes with the branch stranded.
    R70 is the structural fix, and it falls out of R38's own wording — the
    integration task is detectable from `depends_on` alone, so no migration and
    no new column. Deliverable: the extra `NOT EXISTS` term, the pure mirror
    `unintegratedWorkstreams()`, NF1's loud refusal, and
    `scripts/checks/check-close-gate.ts` proving it against real rows with a
    pre-R70 positive control.
13. **One running task per (project, workstream)** — the operator's ruling of
    round 222, closing the edge phase 4A reported without choosing on. Two tasks
    of ONE workstream may not run concurrently: they share a directory, and
    declared write-sets cover source files only, so a shared `.next` is
    reachable between them (the two `next build` ENOENT deaths of 2026-08-17).
    Enforced in the spawn path — `partitionByWorkstream()` — because the
    durable gate would be a term in `selectClaimable()`, which §10 gives to
    phase 3. Asserted with a positive control that observes the constraint
    removed.

### Acceptance criteria
- `git diff main -- forge-control/src/lib/project-reconcile.test.ts
  forge-control/src/lib/cp2-reconciler-interaction.test.ts` shows **appended
  cases only**. Any modified hunk must be justified by requirement id in the
  commit message, and the reviewer quotes that justification.
- `check-workstream-e2e.sh` green; `git status --porcelain` in the main worktree
  empty with a second workstream present.
- `grep -rn "merge" forge-control/src` justified hit by hit; no auto-merge path.
- **Adversarial reviewer** per `03-quality.md` §5, including the named attack:
  *can a project close with an unmerged workstream branch?*
- **Added round 204:** a test that a renumbered group cannot produce a second fix
  chain, or R41 amended to say why the hazard is accepted and what makes it
  survivable (deliverable 11).
- Universal gate.

### Risks
- Chain-key regression → duplicate fix chains. Guarded by the `main` special
  case and by the existing tests passing unmodified.
- A project closing with work stranded on an unmerged branch. The integration
  task being a *task* is the structural defence; the red team must prove it.

---

## Phase 5 — Planner and role prompts
**Planner round 500.**
**Requirements: R47–R53, NF7.**

### Scope
Teach the fleet the new vocabulary. Delete the old one in the same commit.

### Files this phase writes
```
forge-control/src/lib/project-tick.ts                   (prompt constants + branches)
forge-control/src/lib/project-tick.test.ts              (APPEND, and delete the retired assertion)
docs/plan/engine-task-graph/evidence/phase5-prompts.md  (new)
```

### Deliverables
1. `PARALLELISM_GUIDE` **deleted** and replaced by a graph guide: declare
   `depends_on`, `workstream`, `write_set`; research fans out wide and early;
   builders fan out by file ownership; reviewers remain a genuine join;
   every workstream other than `main` ends in an integration task with a
   reviewer.
2. `IDEMPOTENCY_NOTE` updated: identity is still `(project, round, role, title)`
   **and round is now computed**, so an identical repeated curl still 409s.
3. `taskCurl()`'s example body shows the new fields and omits `round`.
4. The planner branch loses "Your round is N. Create builder tasks at round
   N+1…" entirely.
5. The architect branch keeps `round: k*100` per phase, described in the prompt
   as a **phase label**, not a schedule.
6. The builder branch restates the task's `write_set` and requires a loud report
   of any write outside it.
7. The reviewer branch gains the write-set audit (R57) and the workstream diff
   base (R37).
8. **The companion-files clause** (R47, added round 204): the planner prompt
   states that a task changing a shared type, an exported signature or a fixture
   shape must include in its `write_set` the test factories and call sites that
   change with it. Phase 2 lived the failure — widening `ProjectTask` forced edits
   to two test files' object factories that no declared write-set named — and
   under workstreams that omission is not a bookkeeping finding but the exact
   input that lets two workstreams be scheduled in parallel over one file.

### Acceptance criteria
- `grep -rn "consecutive rounds" forge-control/` **empty**.
- The retired assertion is **deleted**, not skipped; the commit message names
  R49 (standing rule 4).
- Prompt-length budget assertion green, with the budget in the failure message.
- The reviewer reads the built planner prompt end to end as a planner would and
  states whether it is followable.
- Universal gate.

---

## Phase 6 — Observability: real edges on the plan endpoint
**Planner round 600.**
**Requirements: R54–R58.**

### Scope
Make the edges visible. Small phase, shipped socket.

### Files this phase writes
```
forge-control/src/routes/chat.ts                             (PLAN_TASKS_SQL, groupPlanPhases, PlanTask)
forge-control-web/app/desktop/team/planApi.ts                (PlanTask mirror)
forge-control-web/app/desktop/team/planStore.ts              (PlanNode)
forge-control-web/app/desktop/team/PlanKanban.tsx            (workstream chip)
scripts/checks/check-plan-store.ts                           (extend)
docs/plan/engine-task-graph/evidence/phase6-plan-api.md      (new)
```

### Deliverables
1. `groupPlanPhases` reads `depends_on` when non-null and keeps today's
   synthesised set when NULL. **The response shape does not change** — its own
   doc-comment promised this refinement would not change it.
2. `PlanTask` gains `workstream` and `depth`; the hand-mirrored web types are
   updated in the same commit (they are hand-mirrored on purpose; drifting them
   is the failure mode).
3. The Kanban chip shows the workstream when it is not `main`. Phase blocks
   still group by `floor(round / 100) * 100`.
4. `check-plan-store.ts` extended: real edges in, `planEdges()` out.

### Acceptance criteria
- Response-shape diff of the `PlanTask`/`PlanPhase`/`PlanResponse` interfaces
  against the base commit: additions only.
- `check-plan-store.ts` green.
- **No new runtime dependency** — `git diff main -- forge-control-web/package.json`
  is empty (NFU8 still holds; N4 says drawing the graph is a different project).
- Universal gate.

---

## Phase 7 — The measurement instrument
**Planner round 700.**
**Requirements: R59–R62.**

### Scope
Build the thing that decides whether this project worked. It is written before
the deploy so the deploy has something to measure with, and so it is reviewed
while nobody needs its answer to be flattering.

### Files this phase writes
```
scripts/measure-schedule.ts                                          (new)
forge-control/src/lib/schedule-metrics.ts                            (new, pure)
forge-control/src/lib/schedule-metrics.test.ts                       (new)
docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md            (new)
```

### Deliverables
1. `schedule-metrics.ts` — pure functions over `{task, run}` rows: the
   round/task table, run count, mean duration, wall clock, per-minute concurrency
   samples, the parallelism ratio (S2), and the **numbering stall** (S3: minutes
   a `pending` task spent with every dependency already `done`).
2. `measure-schedule.ts` — the I/O wrapper. **First output line is its own
   provenance**: git SHA, whether the schema has `depends_on`, the project id,
   and the row counts it is computing from (R60).
3. It **exits non-zero** on an unresolvable run, a missing timestamp, or a
   project with fewer than 5 tasks (R61). It never prints a smaller table
   instead.
4. The 8ea0cc08 baseline, committed, produced by this script so before and after
   share one instrument (R62).

### Acceptance criteria
- Truncated fixture → non-zero exit. The reviewer runs this case.
- Header printed before any number.
- The baseline's numbers are compared to `00-vision.md` §2. If they differ, **the
  script wins and §2 is corrected in the same commit**, with the discrepancy
  named. A recomputed baseline that quietly disagrees with the vision document is
  exactly the instrument-lies failure.
- **A divergence is expected, and one cause is already known — do not chase it as
  a phantom.** `00-vision.md` §2's table was measured at 03:04 on 2026-08-17;
  Konrad hand-renumbered roughly a dozen `pending` tasks on `operator-visibility`
  after that (`02-architecture.md` §2.3.3, confirmed on the record). The
  round/task distribution therefore moved for a reason that has nothing to do
  with the engine. Name that cause in the correction — and, importantly, **do not
  stop there**: rule it in or out as the *whole* explanation before attributing
  the remainder to it. "Konrad renumbered some tasks" is a real cause and a very
  convenient one, which is exactly what makes it worth being sceptical of.
- The headline metrics S1 and S2 are computed from run timestamps and wall clock,
  not from the round distribution, so they are **unaffected** by the renumbering.
  Say so explicitly in the baseline document; a reader who sees the round table
  move will otherwise assume the whole measurement is soft.
- Universal gate.

---

## Phase 8 — Deploy, verify, and report the number
**Planner round 800.**
**Requirements: R63–R68, NF2, NF5.**

### Scope
The only phase that touches the live checkout, the live database, or a live
endpoint.

### Files this phase writes
```
docs/plan/engine-task-graph/evidence/phase8-deploy.md      (new)
docs/plan/engine-task-graph/evidence/after-<project-id>.md (new — the DoD-6 measurement)
docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md  (APPEND — see E-3; phase 7 wrote part 1)
docs/plan/engine-task-graph/00-vision.md                   (only if the baseline corrected §2)
```

`baseline-8ea0cc08.md` was added to this list in round 213, in the same commit
that created the file, because E-3 makes phase 8 write it. An undeclared write is
a finding under `03-quality.md` §3.1 item 4, and a phase that discovers its own
write-set by archaeology is the thing this project exists to stop.
`00-vision.md` §2 **was** corrected by the baseline, so the last line is now a
live obligation rather than a conditional one — phase 8 touches it only if its
own numbers move it further.

### The deploy sequence, in order

1. **Confirm the fleet is clear.** `operator-visibility` (8ea0cc08) has **no
   running and no pending tasks**. If it does: report and stop. Do not wait in a
   loop; end the task and let the next tick's planner re-seed it.
2. **Merge.** Merge `main` into the work branch first if main moved. Re-run
   `pnpm typecheck` and `pnpm test` **in the worktree** after the merge. On
   conflicts: **STOP and report the files.** Then merge to `main`.
2b. **Read E-3's baseline — BEFORE step 3, and this ordering is load-bearing.**
   Run E-3's `measure-schedule.ts full --project 8ea0cc08…` and append its
   output to `evidence/baseline-8ea0cc08.md` **now**, while `project_tasks`
   still carries the pre-0040 legacy sentinel on every 8ea0cc08 row. Added round
   215 for round 214's phase-7 finding 1; **amended round 217 for round 216's
   finding 2, which caught the justification below claiming more than it buys.**

   **EXPECT A REFUSAL, NOT A NUMBER. S3 is not readable at step 2b either.** At
   this point migration 0040 has not run, so `project_tasks` has no `depends_on`
   **column at all**: `readProjectRows()` asks `information_schema`, sets
   `hasDependsOnColumn = false`, and `taskRow()` leaves the key absent, so every
   row reaches `isLegacyRow()` as `undefined` and D7's **first** arm refuses.
   The pasted output will read `S3 … NOT COMPUTABLE (131 legacy rows, 0
   closure-shaped rows)` or thereabouts. **That is the correct refusal and not a
   defect** — S3 for 8ea0cc08 was never recoverable by any ordering, because the
   round integer conflated ordering, contention and phase and no column ever
   recorded which. Do not treat it as a failed step, do not redo the deploy over
   it, and do not go looking for a flag that makes it compute.

   **What the ordering buys, then, stated honestly.** Not a number — a *reason*,
   and everything else in `full` mode. Three things, none of them S3:

   - **The honest reason.** Read before the migration, the refusal names the
     LEGACY SENTINEL: these rows never recorded a dependency set. That is true,
     permanent, and the finding this whole project rests on. Read after it,
     step 3's backfill has destroyed the sentinel, `legacy-rows` reads **0**,
     and the only thing left to refuse on is `isClosureShaped()` — which 7b of
     `schedule-metrics.test.ts` and this document both call a **signature, not a
     proof**, because a strictly serial graph-scheduled project produces the
     same bytes. Same verdict, weaker ground, and a header that no longer says
     the rows were legacy.
   - **S1, S2, the run count, the mean run duration and the wall clock** — which
     are the numbers part 2 actually owes (R62), are unaffected by the
     migration, and are the ones DoD-6 compares against.
   - **The pre-migration census itself**, which is the evidence that the read
     happened when it claims to have happened — see the gate in `03-quality.md`
     §3.2 that reads `closure-shaped-rows` off the pasted header.

   Without the ordering the instrument would, before round 215, have printed
   `S3 max numbering stall (min) 0` with `legacy-rows=0` and **exit 0** —
   certifying "no numbering stall" for the very project whose numbering stall
   motivated this work (measured, round 214). Step 1 makes that worse rather
   than better: it guarantees 8ea0cc08 is *settled*, which is exactly the state
   in which the closure resolves cleanly instead of erroring. Round 215's
   detector turned that lie into a refusal; round 217's amendment stops this
   step promising a number that D7 is designed never to produce for a legacy
   project.
   *Pinned in code:* `schedule-metrics.test.ts`'s
   `describe("D7 — the pre-0040 read at step 2b refuses on the legacy sentinel")`,
   which builds its rows through the real `taskRow()` with
   `hasDependsOnColumn = false` and was watched failing under two mutations.
3. **Apply the migration.** `psql -f db/migrations/0040_task_graph.sql`, twice,
   pasting both outputs. It is additive and the running old engine ignores it
   (R8), which is why it goes before the restart. **After this statement runs,
   8ea0cc08's legacy sentinel is gone and with it the honest reason S3 refuses
   for** — see 2b, amended round 217. S3 itself was never computable for this
   project; what the migration destroys is `legacy-rows`, the header field that
   says so.
4. **Restart the API side.** `pm2 restart forge-control` — allowed, and the right
   way to pick up the route changes; nothing long-running lives there.
5. **Restart the executor, detached, and END THE TASK:**
   ```
   setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
   ```
   Launch it and return **immediately**. Never wait for it, never poll it, never
   tail the log until it finishes. The script waits for the fleet to go idle and
   restarts then; the task must return before that happens.

### Deploy guidance — verbatim, and it is in every gating reviewer's brief too

- **EXECUTOR-LOADED CODE.** If the diff touches `src/lib/project-tick.ts`,
  `src/lib/cc-runner.ts`, `src/executor.ts`, `src/db/*` or the `agents/*.md` role
  files, the executor is holding the old code in memory and a plain restart would
  kill every run in flight — including the deploy task itself.
- **NEVER `pm2 restart forge-executor`.** Not to deploy, not to test, not "just
  this once".
- Instead, after merging, run exactly:
  ```
  setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
  ```
  launch it DETACHED and END the task — never wait for it, never poll it, never
  tail the log until it finishes. The script waits for the fleet to go idle and
  restarts then; your task must return immediately.
- `pm2 restart forge-control` (the API side) remains allowed and is the right way
  to pick up route/API changes, since nothing long-running lives in that process.
- **MERGE vs PR (R17):** if the project brief says to open a PR instead of
  merging, run `scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"` and do
  NOT merge to main — the PR is the deliverable. Otherwise merge per the brief
  (merge main into the work branch first if main moved, re-run typecheck + tests
  in the worktree, then merge to main; on conflicts STOP and report the files).

### GitHub push — verbatim, in every phase's gating reviewer brief

- When a phase's gating reviewer issues `VERDICT: PASS` and the repo has an
  origin remote, run `scripts/git-sync-branch.sh <worktree-dir>` to push the work
  branch so the progress is visible on GitHub.
- Plain push only. **NEVER** force-push, never `--force`, never
  `--force-with-lease` — this branch is shared with whatever else is watching it.
- If the push fails (no origin, gh not authenticated, rejected), report the
  failure verbatim in your final message and move on. **A push failure NEVER
  changes the verdict.**

### Verification task (separate task, after the restart has landed)
- The three columns exist; the indexes exist.
- A graph-scheduled task promotes **without its round draining** — observed, not
  asserted.
- A cycle POST returns `400` with a named path, against the live API.
- Two workstream worktrees exist on disk with the expected branch names, and
  `git status --porcelain` in the main worktree is empty.
- `pm2 list` shows `forge-executor` restarted and healthy; `/tmp/safe-restart.log`
  shows the idle-wait and the restart.

### The report (DoD-6)
Run `scripts/measure-schedule.ts` against a project scheduled by the new engine
and commit the same table shape as `00-vision.md` §2 beside the baseline, with
S1, S2 and S3 as numbers and the script's SHA in the header. **The improvement is
a number or it did not happen.** If the numbers are worse, say so plainly and
name the cause — a measurement that only ever confirms is not an instrument.

### Acceptance criteria
- Every step above executed in order, each with its output pasted.
- `grep -rn "pm2 restart forge-executor"` over the diff: every hit inside a
  sentence forbidding it (R66).
- The after-measurement committed and compared.
- Universal gate, run **before** step 2.

---

## 9. Requirement coverage, from the phase side

| Phase | Requirements covered |
|---|---|
| 1 | R1, R2, R3, R4, R5, R6, R7, R8, R9, R18 (harness only), NF3 |
| 2 | R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R69, NF1, NF6 |
| 3 | R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, NF4 |
| 4 | R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, R70, R17, NF1, NF5 |
| 5 | R47, R48, R49, R50, R51, R52, R53, NF7 |
| 6 | R54, R55, R56, R57, R58 |
| 7 | R59, R60, R61, R62 |
| 8 | R63, R64, R65, R66, R67, R68, NF2, NF5 |

R1–R69 and NF1–NF7 are each defined exactly once in `01-requirements.md` and
each has exactly one **primary owner** phase here. Four entries appear in two
rows and each is deliberate, so a reader does not have to guess whether it is a
mistake:

- **R18** — phase 1 builds the replay *harness*, phase 2 makes it *pass*. Primary
  owner: phase 2. A harness that runs and reports is a phase-1 deliverable; a
  harness that is green is phase 2's, because there is nothing for it to be
  green about until the graph scheduler exists.
- **R17** *(added round 202)* — phase 2 owns the **contention** clause (an empty
  write-set intersects nothing and is always claimable, discharged by
  `conflicts()`/`selectClaimable()` and by the replay reproducing today's order);
  phase 4 owns the **warn** clause, Phase 4 deliverable 10, because it lives in
  the spawn path in `project-tick.ts` — a file this table's §10 gives to phases
  4 and 5. Primary owner: phase 2. Split rather than disclosed-and-ignored: as
  written the requirement was unsatisfiable inside phase 2's file ownership, and
  standing rule 2 says an unsatisfiable gate is amended where it is enforced.
- **NF1, NF5** — audits performed at two phases. Their *enforcement* is the
  universal gate, which every phase runs.

This table and `01-requirements.md` §K must agree exactly.
`check-corpus-map.py` in this directory checks that mechanically; run it after
editing either table. It found this very row disagreeing on R18 at round 0,
which is the only reason the discrepancy is a footnote rather than a surprise in
phase 1.

---

## 10. Cross-phase file ownership

The input to contention computation, declared rather than reconstructed. No two
phases run concurrently, so this table is documentation rather than a
constraint — but the planners of each phase must fan their **builders** out
against it.

| File | Phases that write it |
|---|---|
| `db/migrations/0040_task_graph.sql` | 1 |
| `forge-control/src/lib/task-graph.ts` | 1 (stubs), 2 (fill), 3 (validators) |
| `forge-control/src/lib/task-graph.test.ts` | 2, 3 |
| `forge-control/src/lib/task-graph-replay.test.ts` | 1, 2 |
| `forge-control/src/db/projects.ts` | 2, 3, 4 |
| `forge-control/src/routes/projects.ts` | 3 |
| `forge-control/src/lib/workspace.ts` | 4 |
| `forge-control/src/lib/project-reconcile.ts` | 4 |
| `forge-control/src/lib/project-tick.ts` | 4 (spawn/log), 5 (prompts) |
| `forge-control/src/routes/chat.ts` | 6 |
| `forge-control-web/app/desktop/team/*` | 6 |
| `scripts/measure-schedule.ts`, `lib/schedule-metrics.ts` | 7 |
| `forge-control/src/lib/schedule-source.ts` | 7 |
| `scripts/checks/check-task-api.ts` | 3 |
| `forge-control/src/lib/source-hygiene.test.ts` | 3 |
| `forge-control/src/lib/schedule-metrics.test.ts` | 7 |
| `docs/plan/engine-task-graph/check-instrument-identity.py` | 7 (created), then every phase runs it (`03-quality.md` §3.1 item 7) |
| `forge-control/src/executor.ts` | **none** — see `02-architecture.md` §1.2 |

**Writes recorded after the fact, round 215.** Each was substantively correct
and none overlapped a concurrent builder; recording them here is what lets the
next audit resolve without archaeology, in the project whose entire deliverable
is computing contention from **declared** write-sets.

| write | round | why it was not declared, and the ruling |
|---|---|---|
| `forge-control/src/routes/projects.ts` and `docs/plan/engine-task-graph/01-requirements.md`, by phase 3's builder 4 (`ba09b2a`, `3b54229`) | 213 | Both are builder 3's declared files. Required by **standing rule 2**: F2's int4 bound had to be amended *where it is enforced*, and the enforcement is in builder 3's route. Correct in substance, taken silently — round 214 phase-3 finding 4. Builders 1 and 3 also wrote outside their sets in the same phase and both disclosed it at the site; the rule is disclose, not abstain. |
| `forge-control/src/lib/schedule-source.ts`, by phase 7's builder (`b1bb731`) | 212 | Declared write_set was `measure-schedule.ts` + `schedule-truncated-4.json` + `03-quality.md`. The module had to exist because `scripts/` has no `node_modules`, so a bare `pg` specifier in a root-level script resolves nowhere — the wrapper could not have held those thirty lines. Sound code, but it is the module phase 8's live read runs entirely through and it shipped with **no test file** (round 214 phase-7 finding 4). `schedule-source.test.ts` closes the coverage half; this row closes the declaration half. |
| `forge-control/src/lib/schedule-source.test.ts`, `forge-control/src/lib/source-hygiene.test.ts` | 215 | New files created by this fix cycle, declared here in the same commit that creates them. |
| `forge-control/src/lib/project-tick.ts` (the `formatSpawnLog()` formatter and its call site in `spawnTaskRuns()`) | 231 | R58 (01-requirements.md §G; 04-phases.md §9) is a **phase-6** requirement whose only implementation site is `spawnTaskRuns()` in `project-tick.ts` — a file the ownership table above assigns to phases **4** (spawn/log) and **5** (prompts), not 6. Found by the round-221 planner: R58's requirement and R58's file were owned by different phases, a genuine gap in the table. Ruled: phase 6 writes the spawn log line at a round strictly *after* every phase-4 round including its fix cycles (phase 4's last fix-cycle round was 223, so round 231 could not collide with a live phase-4 builder), and the write is *recorded* here rather than reconstructed later — the same precedent this table already sets for round 213's and round 215's writes: disclose, not abstain. Phase 5's round-500+ prompt-constant rewrite in the same file is unaffected; `formatSpawnLog()` is not a prompt constant. |

**Round 217's write-set, declared in the commit that makes it (fix cycle 2).**
Not "recorded after the fact" — this fix cycle has one task and no concurrent
builder, so the set is stated rather than reconstructed, which is the standing
rule's whole point.

| file | why round 217 writes it |
|---|---|
| `docs/plan/engine-task-graph/check-instrument-identity.py` | **new.** The gate for round 216's finding 1 — see `03-quality.md` §3.1 item 7. |
| `docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md` | eight pasted headers re-run under the current instrument; §1 gains the re-run record; §5(3) and §7 amended. |
| `docs/plan/engine-task-graph/00-vision.md` | §2.2's heading and body named the retired identity. |
| `docs/plan/engine-task-graph/01-requirements.md` | R62's *How proved* replaced (it could be satisfied by a stale SHA); the round-217 amendment added. |
| `docs/plan/engine-task-graph/03-quality.md` | §3.1 item 7 and its command; §3.2's phase-8 gate, which called a correct pre-migration S3 refusal a redo; §4's block. |
| `docs/plan/engine-task-graph/04-phases.md` | step 2b, step 3, §12's E-3, and this table. |
| `docs/plan/engine-task-graph/evidence/phase3-fix-1.md` | §2b, round 216's advisory finding 3. |
| `forge-control/src/lib/schedule-metrics.test.ts` | section 7c — five tests pinning what step 2b actually yields. |
| `docs/plan/engine-task-graph/evidence/fix-cycle-2.md` | **new.** This round's transcript. |

**Round 222's two writes outside its declared set (phase 4C), declared in the
commit that makes them.** Phase 4C's brief names five files. Two more were
required and neither could be avoided; disclosed here rather than at the site
alone, because §10 is where the next audit looks.

| file | why phase 4C writes it |
|---|---|
| `scripts/checks/check-close-gate.ts` | **new.** R70's behavioural half. The requirement is a property of a SQL statement, and NF3 forbids the unit suite from touching a database, so the only place it can be proved is a `scripts/checks/` script — which R70's brief explicitly offers. Without it the extra `NOT EXISTS` term would ship asserted by a unit test of its MIRROR and never once executed. |
| `docs/plan/engine-task-graph/04-phases.md` | **standing rule 2 — amend the gate where it is enforced.** Adding R70 to `01-requirements.md` §K without adding it to §9 above and to Phase 4's header makes `check-corpus-map.py` exit non-zero: the three statements of the map must agree, and two of the three live in this file. Deliverables 12 and 13 and this row are the rest of that same edit. |

Within a phase, the planner splits builders so that **no two builders in the
same workstream declare the same file**. Where a split is impossible — two
changes to `db/projects.ts` that genuinely interlock — put them in one builder,
not in two rounds. One builder writing a file twice is cheaper than two builders
serialising on it.

---

## 11. What "done" looks like from here

`00-vision.md` §3's six DoD items, mapped to where each is discharged:

| DoD | Discharged by |
|---|---|
| DoD-1 engine schedules from a DAG | Phase 2 + the phase-8 live observation |
| DoD-2 same file, two workstreams, reviewed integration | Phase 4's `check-workstream-e2e.sh` + phase 8's on-disk check |
| DoD-3 replay proves the replica | Phase 2's `task-graph-replay.test.ts` |
| DoD-4 a cycle cannot be inserted | Phase 3's table + phase 8's live 400 |
| DoD-5 planners write no round numbers | Phase 5 |
| DoD-6 deployed via safe-restart, measurement reported | Phase 8 |

---

## 12. Errata — corrections to briefs already seeded

Task briefs are immutable once created (there is no update route, and re-issuing
a curl answers `409` with the existing row). Corrections therefore live here, and
**this section overrides any brief it contradicts.**

### E-1 — the phase-7 scout's output path (round 0, 2026-08-17)

The scout task `e7548096-a914-473e-9c3c-e0b96e926f04` was seeded at round 699
and is now at **round 100** — renumbered out of band, see
`02-architecture.md` §2.3.1. Two consequences, both citation rot of exactly the
kind standing rule 1 warns about, in briefs I wrote:

1. **Its own brief and its engine-generated prompt now disagree.** The brief says
   write to `docs/research/round-699-schedule-metrics.md`. The scout branch of
   `buildPrompt` in `lib/project-tick.ts` builds the path as
   `docs/research/round-<task.round>-<task.id first 8>.md`, which is now
   `docs/research/round-100-e7548096.md`. Either file may appear.
2. **Phase 7's planner brief cites the 699 path**, which may never exist.

**Correction.** Phase 7's planner must **not** open a hard-coded path. It
resolves the scout's findings by globbing
`docs/research/*schedule-metrics*.md` and `docs/research/round-100-e7548096*.md`,
and by checking the commits of task `e7548096-a914-473e-9c3c-e0b96e926f04`
directly:

```bash
ls docs/research/ | grep -Ei 'schedule|metric|e7548096'
git log --oneline --name-only --all -- 'docs/research/*'
```

If no such file exists, that is a **finding to report** — phase 7 plans against
whatever the scout actually committed, or states plainly that the recon is
missing and plans the instrument conservatively. It does not proceed quietly on
the assumption that a cited file exists. **A pin you cannot resolve is a finding
you report, not a footnote you quietly reinterpret** — including when the
architect wrote the pin.

### E-2 — the scout now runs in phase 1's round

At round 100 the scout runs concurrently with phase 1's planner rather than
ahead of phase 7. This is **harmless and slightly better**: the scout writes only
its own file under `docs/research/`, the phase-1 planner writes no files at all
(it creates tasks), so their write-sets are disjoint — and the recon lands six
phases before the phase that needs it. No action required. Recorded so a later
reader does not "fix" it back to 699.

### E-3 — the 8ea0cc08 baseline lands in two parts; phase 8 owes the second (round 213, 2026-08-17)

**R62's baseline could not be completed in phase 7, and the cause is structural
rather than an omission.** The phase-1 fixture
`forge-control/src/lib/fixtures/replay-operator-visibility.json` carries exactly
six keys per row — `{id, round, role, title, status, created_at}`, asserted as
**A3** of its sibling capture record — with **no run linkage and no run
timestamps**. Run count, mean run duration, wall clock, S1, S2 and S3 are
therefore not derivable from any artifact in this worktree, and `03-quality.md`
§2.3 gives the live read that would produce them to the deploy/verify task alone.
`measure-schedule.ts full` over that fixture exits non-zero naming
`fixture-has-no-runs` rather than printing a smaller table, which is R61 working;
the refusal is pasted in `evidence/baseline-8ea0cc08.md` §3.

Phase 7 therefore landed **part 1** — the round/task tables, the correction of
`00-vision.md` §2 and the discrepancy analysis, all from the committed fixture.

**Phase 8 owes part 2, and this is the binding statement of that obligation.**
As part of its deploy/verify sequence, at **step 2b** of "The deploy sequence, in
order" above — i.e. **BEFORE step 3 applies migration 0040**, and therefore also
before the after-measurement of DoD-6 — phase 8 runs

```bash
cd forge-control && ./node_modules/.bin/tsx ../scripts/measure-schedule.ts full \
  --project 8ea0cc08-28d9-4301-9f28-c98e1c5d6838
```

and **appends** its output — header first, as the script emits it — to
`docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md`. Appended, never
rewritten: part 1's tables and its §5 disproofs stay as they were written. The
ordering matters for one reason and it is not bookkeeping: R62 requires the
before and the after to be produced by **one instrument**, and an after-number
measured before its before-number has no instrument-identity guarantee to offer.

**What "one instrument" means, restated round 217 because as written it was
already false.** The sentence that stood here — *"Run it before, from the same
commit, and the two headers name the same `instrument-sha256`"* — assumed the
script's bytes never change. They changed in round 215 (`isClosureShaped()`,
`renderCensus()`, `printFull()`), moving the identity
from `80ef1123…` `[historical instrument]` to `f6828a68…`
while part 1's pasted headers still
named the old one; round 216's re-review found it as its finding 1. **Part 1 was
re-run under the current bytes in round 217 and every number reproduced
unchanged**, so the guarantee is repaired rather than abandoned — but it has to
be stated as something a living instrument can actually promise:

> **Every header pasted in `baseline-8ea0cc08.md`, part 1 and part 2, names the
> same `instrument-sha256`, and that value equals `sha256sum
> scripts/measure-schedule.ts` on the commit the file ships in.**

Phase 8 therefore has a concrete obligation and not a hope. Before appending part
2, run `python3 docs/plan/engine-task-graph/check-instrument-identity.py`. If it
passes, append. **If the instrument has moved since round 217, re-run part 1's
seven commands and replace their headers IN THE SAME COMMIT that appends part
2**, adding a row to the re-run record in §1 of that file — the mechanics are
already written there, and the round/task tables are expected to reproduce
byte-for-byte because they are a pure function of the committed fixture. Never
append a part 2 whose header disagrees with part 1's. The checker is in
`03-quality.md` §3.1's universal gate, so this cannot be discovered late.

**THE STRONGER ORDERING CONSTRAINT — added round 215, for round 214's phase-7
finding 1 (attack A3 succeeding through the database rather than the code).**
As originally written this erratum constrained the read only to fall *before*
DoD-6's after-measurement, which permits it after step 3. That permission is a
defect. Migration 0040's final statement — the R6 backfill — is

```sql
UPDATE project_tasks pt
   SET depends_on = COALESCE((SELECT array_agg(e.id …) FROM project_tasks e
        WHERE e.project_id = pt.project_id AND e.round < pt.round), '{}'::uuid[])
 WHERE pt.depends_on IS NULL;
```

which writes the strictly-lower-round closure over **every pre-existing 8ea0cc08
row**, destroying the `depends_on IS NULL` sentinel that D7's original refusal
keys on. Under that closure a task's dependencies all complete exactly when its
round drains, which is exactly when the old engine promoted it, so every stall
term is 0 by construction. Measured in round 214 on the literal motivating case:
`S3 max numbering stall (min) 0 (over 7 tasks with a recorded dependency set)`,
`legacy-rows=0`, **exit 0** — the instrument certifying "no numbering stall" for
the project this entire effort exists because of.

Two repairs landed together in round 215, and neither replaces the other:

- **This ordering**, pinned to step 2b above, in `03-quality.md` §3.2's phase-8
  gate and in R62's prose — one commit, per the rule that a requirement and its
  gate clause move together.
- **A durable detector**, because correctness must not rest on the order two
  deploy steps happen to run in: `isClosureShaped()` in
  `forge-control/src/lib/schedule-metrics.ts` refuses S3 when every row's
  `depends_on` equals the strictly-lower-round closure, and
  `census.closureShapedRows` prints that count in the header in every mode. The
  refusal is a **signature, not a proof** — a strictly serial graph-scheduled
  project produces the same bytes, and for it the refusal costs a true 0.

Three consequences, stated so nobody has to infer them:

1. `evidence/baseline-8ea0cc08.md` is now in phase 8's "Files this phase writes"
   list above, added in the same commit as this erratum. An undeclared write is a
   finding under `03-quality.md` §3.1 item 4.
2. `01-requirements.md` §H's R62 carries the matching amendment. R62's primary
   owner is still **phase 7** and phase 8 gains no new requirement id, so §K and
   §9 of this document are unchanged and `check-corpus-map.py` still agrees.
3. Phase 7's acceptance criterion that S1 and S2 are **unaffected** by the
   renumbering still holds and is still **unverified**. It is an argument about
   what could perturb a number — S1 and S2 read run timestamps, never
   `project_tasks.round` — not a statement of the number. Nothing licenses
   quoting an S1 or an S2 for the 8ea0cc08 baseline until this append lands.

**This section overrides any brief it contradicts**, which is why the obligation
lives here and not only in a final message a later planner may never read.
