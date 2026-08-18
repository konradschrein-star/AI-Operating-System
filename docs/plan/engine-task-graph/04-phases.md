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
**Requirements: R1–R9, R71, R18 (harness only), NF3.**

### Scope
The migration, its lint case, the committed fixture, and the *shell* of the
replay proof. No engine behaviour changes; the old code keeps running against
the new columns without noticing them.

### Files this phase writes
```
db/migrations/0042_task_graph.sql                                    (new)
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
1. **`0042_task_graph.sql`** — three `ADD COLUMN IF NOT EXISTS`, the workstream
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
- `migrations.test.ts` names `0042_task_graph.sql` explicitly.
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

ADDED BY THE FIX CYCLE (round 242), for round 241's three gating findings — the
NON-goal architect branch, NF7 measured at a fixture id no real project has, and
GRAPH_GUIDE's fan-out sentence naming no research role literal:
forge-control/src/lib/project-tick.ts                     (both architect branches; GRAPH_GUIDE)
forge-control/src/lib/project-tick.test.ts                (APPEND, + three declared in-place NF7 amendments)

ADDED BY FIX CYCLE 2 (round 244), for round 243's four findings. All four are
corpus defects left behind by the write-set directly above: it covers the two
code files and NOT the documents quoting the constants those files moved, so
`BASELINE` went 9187 -> 9221 while §J and the phase-5 record kept stating the
old numbers, and three consecutive reviews read them as authoritative. NO ENGINE
BEHAVIOUR IS CHANGED — no assertion, constant or prompt string moves, and the
maximal prompt measures 12121 before and after:
docs/plan/engine-task-graph/evidence/phase5-fix-cycle-1.md (new — round 242's record, written late)
docs/plan/engine-task-graph/01-requirements.md             (§J NF7: live uuid-frame pins; the budget trail)
docs/plan/engine-task-graph/evidence/phase5-prompts.md     (§4.3 frame banner; §4.4 note; §4.7 pointer)
forge-control/src/lib/project-tick.test.ts                 (NF7: "tightens" -> "RISES", + why)
forge-control/src/lib/project-tick.ts                      (one doc-comment: GRAPH_GUIDE's cost restated in the live frame)
docs/plan/engine-task-graph/04-phases.md                   (this list)
```

**The rule this fix cycle earned, and the reason the list above exists at all:
if a round moves a constant the corpus quotes, the documents quoting it belong
in that round's write-set.** Otherwise the fix half-lands, the stale pin reads
as authoritative rather than as stale, and every later round pays to rediscover
it. Round 242's record is written by round 244 and says so; supersession, never
rewriting, is how the earlier records keep stating what they actually measured.

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

**The full phase-8 write-set — all four tasks, both rounds, including the
cross-phase writes — is the table in §10**, added round 802 in the commit that
makes it. The four lines above are the deploy task's own share of it and are
kept here because E-3 and R62 refer to them by name. §10 is where the round-803
write-set audit (`03-quality.md` §3.1 item 4) should look, because phase 8 is
the first phase to run three builders concurrently in one worktree and the
per-task split is the thing that has to be checked.

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
2. **Merge — and there are TWO merges, which the old wording conflated.**
   **Amended round 802 (phase 8C), where the gate is enforced; acted on by round
   801, reviewed at round 803.** This step used to read, of both merges at once,
   *"On conflicts: **STOP and report the files.**"* Measured at round 800 and
   re-derived in the worktree at round 801 (`evidence/phase8-merge.md` §1):
   `main` had moved **55 commits**, and `git merge-tree --write-tree main HEAD`
   reported **three** content conflicts —
   `forge-control/src/routes/chat.ts`,
   `forge-control-web/app/desktop/team/planApi.ts`,
   `forge-control-web/app/desktop/team/PlanKanban.tsx` (six hunks; a fourth
   shared file, `forge-control-web/app/api.ts`, auto-merged). Read as covering
   both merges, STOP therefore made phase 8 **permanently undeployable**: the
   only path to a clean merge 2 is the resolution merge 1 performs, and the
   clause forbade it. Standing rule 2 — an unsatisfiable gate is amended where
   it is enforced, which is here and in `03-quality.md` §3.2's phase-8 block, in
   one commit.

   **This is a distinction, not a relaxation.** The two merges differ in
   direction, in location and in reversibility, and only one of them is
   irreversible:

   | | direction | where | on a conflict |
   |---|---|---|---|
   | **merge 1** | `main` → work branch | **the worktree** | **RESOLVE** — ordinary integration work |
   | **merge 2** | work branch → `main` | **the live checkout** | **STOP**, verbatim, unchanged |

   - **Merge 1 — `main` into the work branch, in the worktree.** Conflicts are
     **RESOLVED** by a briefed task that reads **both sides**, and the resolution
     is **reviewed before anything ships**. Never `-X ours`, never `-X theirs`:
     a strategy option resolves in favour of whoever finishes last, which is
     silent clobbering wearing a flag. Re-run `pnpm typecheck` and `pnpm test`
     **in the worktree** after the merge. Round 801's three conflicts, their six
     hunks and the reasoning for each resolution are recorded in
     `evidence/phase8-merge.md` §3, with the merged `chat.ts` driven by
     `check-plan-api.ts` in §6.6 and the phase-6 claim re-derived on the merged
     file in §5 — a resolution is not proved by compiling.
   - **Merge 2 — the work branch into `main`, in the live checkout.** **STOP and
     report the files**, unchanged and with its full force. A conflict *there*
     means the branch was not prepared — merge 1 either did not run or did not
     finish — and resolving it inside an irreversible deploy step, against the
     live checkout, with the executor about to restart, is exactly how a silent
     clobber gets shipped. Merge 1 is the preparation that makes merge 2
     conflict-free; if merge 2 conflicts, the answer is to go back to merge 1,
     not to resolve in place.
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
3. **Apply the migrations — THREE files, BY EXPLICIT FILENAME, each twice.**
   **Amended round 802 (phase 8C) on the operator's ruling; the requirement side
   is R64 in `01-requirements.md` §I, amended in the same commit.** This step
   used to name `0040_task_graph.sql` alone. Two things changed under it: round
   801's merge brought `main`'s own migrations onto this branch, and the operator
   verified that none of their tables exist yet in `content_forge`.

   ```
   psql -U postgres -d content_forge -f db/migrations/0042_task_graph.sql     # ×2
   psql -U postgres -d content_forge -f db/migrations/0040_usage_hourly.sql   # ×2
   psql -U postgres -d content_forge -f db/migrations/0041_ui_dismissals.sql  # ×2
   ```

   In that order, each applied twice with **both** outputs pasted (R2's
   re-runnability is demonstrated, not asserted). All three are additive and the
   running old engine ignores them (R8), which is why they go before the restart.

   - **NEVER `for f in db/migrations/*.sql`.** This rule stands whatever the
     numbers are, and it is the reason the collision below was survivable rather
     than a corruption: a glob silently decides an order nobody chose, and this
     repo has **no ledger table and no runner**, so the filename an operator
     types IS the version control. Name every file. R70.
   - **THE DUPLICATE 0040 IS RESOLVED — renumbered at round 950, post-deploy.**
     *History, because the command block above no longer shows it:* round 801's
     merge of `main` left `db/migrations` holding two files numbered 0040 —
     `0040_task_graph.sql` (ours) and `0040_usage_hourly.sql` (main's). Git
     merged them silently because the filenames differ and there was nothing to
     conflict on. They were inert together — disjoint objects, no version ledger
     to collide in, no boot-time runner, no `schema_migrations` and no
     `migrations` table (the operator verified both absent), and
     `migrations.test.ts` sorts filenames without asserting unique numbering —
     which is why the fix was deferred out of the deploy rather than rushed into
     it. Round 802 ran three builders concurrently in one worktree and the
     renumber touched files two of them already owned: the exact contention that
     cost this project three evidence corrections on 2026-08-17.
     **Round 950 executed it with the tree quiet:** `git mv` to
     `0042_task_graph.sql` (0041 was already taken by `0041_ui_dismissals.sql`),
     bytes unchanged, and **nothing re-applied** — the four `project_tasks`
     columns were queried on `content_forge` before and after the rename and were
     identical. The migration remains APPLIED UNDER ITS ORIGINAL NAME; that is a
     fact about history, not a discrepancy to repair.
     8A's judgement that renaming the migration this project exists to ship is a
     briefed decision rather than a merge side-effect is preserved.
   - **Why main's two files are this step's business at all.** The operator
     verified `usage_hourly`, `app_settings` and `ui_dismissals` are **ALL
     absent** from `content_forge`, and `0040_usage_hourly.sql` creates
     **`usage_hourly` AND `app_settings`** — two tables, one filename. Step 4
     restarts `forge-control`. Without them, `/api/chat/:id/team` returns `500`
     and **the team panel does not render at all**, and `/api/usage/series`
     returns `500` hourly. All three files are `IF NOT EXISTS` and re-runnable,
     so applying them early is safe and **skipping them is not**. Step 4 happens
     only after all three have been applied.
   - **Confirm each table exists AFTER applying, BY NAME** — do not assume the
     file ran because the command returned:
     ```
     SELECT tablename FROM pg_tables
      WHERE tablename IN ('usage_hourly','app_settings','ui_dismissals');
     ```
     plus the four `project_tasks` columns of R64/R71. Three rows, or the step
     is not done.

   **After `0042_task_graph.sql` runs, 8ea0cc08's legacy sentinel is gone and
   with it the honest reason S3 refuses for** — see 2b, amended round 217. S3
   itself was never computable for this project; what the migration destroys is
   `legacy-rows`, the header field that says so. This is why step 2b's read is
   pinned *before* this step and not merely before the after-measurement.
4. **Restart the API side.** `pm2 restart forge-control` — allowed, and the right
   way to pick up the route changes; nothing long-running lives there.
5. **Restart the executor, detached, and END THE TASK:**
   ```
   setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
   ```
   Launch it and return **immediately**. Never wait for it, never poll it, never
   tail the log until it finishes. The script waits for the fleet to go idle and
   restarts then; the task must return before that happens.

### The verification and report tasks CANNOT be ordinary pending rows

**Recorded round 802 (phase 8C) as a sequencing FACT, not a preference. A later
reader must not "fix" it by numbering the verification task above the deploy —
that is the intuitive arrangement and it is the broken one.**

Two mechanisms combine, and neither is negotiable from inside this project:

1. `safe-restart.sh` waits for the **WHOLE FLEET** to be quiet —
   `SELECT count(*) FROM runs WHERE last_heartbeat_at > now() - interval '45 seconds'`,
   requiring **two consecutive quiet polls**. Not this project's runs: every
   run, everywhere.
2. Any **pending** task of this project is promoted within one ~10 s tick of the
   deploy task ending.

So a verification task seeded as a pending row would (a) **run BEFORE the restart
it exists to verify**, reporting on the old engine while claiming to report on
the new one, and (b) **delay that restart by its own duration**, because its own
run is a heartbeat the quiet poll counts. The failure is silent in the worst
way: the verification passes, against code that has not shipped.

They are therefore **POSTed by a detached watcher AFTER the restart lands** —
8D's `scripts/deploy/await-and-seed.sh`, with its payloads
`payload-verify.json` and `payload-report.json`, gated by
`scripts/checks/check-await-seed.sh`. The project must also be **reactivated**
before the watcher POSTs, since a project with no live tasks settles.

*Why the wait is short in practice, measured at round 800:* `8c591d6c` is the
**only active project in the fleet**, and `8ea0cc08` is `done` at **159/159**
tasks. The restart therefore lands within roughly a minute of this project's
last run ending, rather than waiting on unrelated traffic.

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
**Every live query below runs as `psql -h 127.0.0.1 -p 5432 -U postgres -d
content_forge`** (amended round 815). A bare `psql -U postgres -d content_forge`
reaches the host's *local* cluster on port **5434**, not the containerised server
`DATABASE_URL` names — `safe-restart.sh` already pins the same host and port for
the same reason. A check that answers from 5434 is a confident, wrong PASS.

- The four columns exist (`depends_on`, `workstream`, `write_set`, and
  `graph_frozen` — R71, added round 242); the indexes exist. On the live
  database `graph_frozen` must be `true` on every row the backfill wrote and
  `false` on every row inserted after it. The census
  `SELECT graph_frozen, count(*) FROM project_tasks GROUP BY 1` is context; the
  assertion is `SELECT count(*) FROM project_tasks WHERE graph_frozen AND
  depends_on IS NULL`, which must be **0**.
  **Amended round 815 (standing rule 2), where the gate is enforced.** This
  clause used to demand `count(*) WHERE graph_frozen <> (depends_on IS NOT NULL)`
  = 0, which is **unsatisfiable on live data from the first post-migration graph
  row onward** and was measured non-zero (2) by phase 8G within four minutes of
  the restart. `graph_frozen` marks *provenance* — "0040's backfill wrote this
  row's closure" — in **one direction only**: `graph_frozen → depends_on IS NOT
  NULL`. The converse is false by construction, because a task the new engine
  creates as an explicit graph root carries `depends_on = '{}'` (non-NULL, see
  the sentinel table in the module header of `forge-control/src/db/projects.ts`)
  and no backfill provenance, so the biconditional's counter-example count equals
  the number of tasks this engine has created since the deploy and only ever
  grows. The prose beside it was always right; only the SQL disagreed with it.
  The *throwaway-schema* assertion in `scripts/checks/check-migration-0040.sh`
  keeps the biconditional deliberately — there every row is a backfilled row, and
  that script's own negative control ("a row inserted after the backfill is NOT
  frozen") is what proves this reading rather than contradicting it. Evidence:
  `evidence/phase8-verify.md` §3.2, finding 3B.
- A graph-scheduled task promotes **without its round draining** — observed, not
  asserted.
- The reachable dependency `400`s answer against the live API, each **naming the
  offending id**: (a) a `depends_on` naming an id that exists nowhere, (b) one
  naming a real task id of a *different* project.
  **Amended round 815 (standing rules 2 and 4).** This clause used to read "a
  cycle POST returns `400` with a named path". **R26** states that an insert-time
  cycle is unreachable by construction — a row that does not exist yet cannot be
  named in any other row's `depends_on`, and R29 makes `depends_on` immutable —
  so no live POST can produce that `400` and the clause could only ever be
  disclosed, never passed. R25's detector and its table-driven test are **not**
  retired: the two live probes above exercise the same validation block, and the
  cycle belt is kept for the psql-wielding operator and for the bulk-insert path
  that would reopen the door. Evidence: `evidence/phase8-verify.md` §6.
- Two workstream worktrees exist on disk with the expected branch names, and
  `git status --porcelain` in the main worktree is empty.
- `pm2 jlist` shows `forge-executor` `online` with an increased `restart_time`,
  and **`/var/log/forge-safe-restart.log`** shows the idle-wait and the restart.
  **Amended round 815 (standing rule 2).** This clause used to name
  `/tmp/safe-restart.log`. `safe-restart.sh` sets `LOG=/var/log/forge-safe-restart.log`
  and routes *every* line — its own `log()` output and both `pm2 restart`
  invocations — to `$LOG`; it writes nothing to stdout, so the `>> /tmp/…`
  redirect in the detached launch receives nothing and that path holds an
  unrelated 2026-08-05 artefact. Phase 8G found the file 0 lines long and
  thirteen days stale. Evidence: `evidence/phase8-verify.md` §1.3.

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
| 1 | R1, R2, R3, R4, R5, R6, R7, R8, R9, R71, R18 (harness only), NF3 |
| 2 | R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R69, NF1, NF6 |
| 3 | R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, NF4 |
| 4 | R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, R70, R17, NF1, NF5 |
| 5 | R47, R48, R49, R50, R51, R52, R53, NF7 |
| 6 | R54, R55, R56, R57, R58 |
| 7 | R59, R60, R61, R62 |
| 8 | R63, R64, R65, R66, R67, R68, NF2, NF5 |

R1–R71 and NF1–NF7 are each defined exactly once in `01-requirements.md` and
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
| `db/migrations/0042_task_graph.sql` | 1 |
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
| `docs/plan/engine-task-graph/04-phases.md` (the §"Verification task" bullet list of phase 8 only), by phase 8G's verification task (round 815) | 815 | Declared write_set was `evidence/phase8-verify.md` alone. **Standing rule 2 — amend the gate where it is enforced, in the same commit**: three of that bullet list's clauses could not be passed, and this file is where they are stated about *live* data. (1) The R71 pair demanded `graph_frozen <> (depends_on IS NOT NULL)` = 0, which the new engine falsifies with every task it creates — measured at 2 within four minutes of the restart, both rows correct-by-design explicit graph roots. (2) "A cycle POST returns 400" contradicts R26's own unreachability argument. (3) `/tmp/safe-restart.log` is never written by `safe-restart.sh`. Each amendment carries its reasoning inline and cites the transcript in `evidence/phase8-verify.md`. No other section of the file was touched; `git show --stat` on the round-815 commit shows two files. |
| `forge-control/src/routes/projects.ts` (one doc-comment only — the `round` guard of `POST /:id/tasks`, the "Safe:" clause) | 239 | The ownership table above assigns this file to phase **3** alone. Phase 5A wrote one comment in it and nothing else, because R53 **falsified** that comment: it justified treating an absent `round` differently from a supplied one on the premise that "`taskCurl()`'s shipped example in `project-tick.ts` sends `\"round\": 1\"`", and R53 makes `taskCurl()` omit `round`. Handed to the builder as the round-239 planner's finding F-B and confirmed at `d9858b9`. **Standing rule 2 — amend the gate where it is enforced, in the same commit**: the enforcement is phase 3's route, the premise is phase 5's prompt, and the comment is the reasoning a future reader of that guard inherits. Recorded here in the commit that makes it, per the round-213 and round-215 precedent: disclose, not abstain. No expression, message, status code or test in `routes/projects.ts` was touched — `git diff` on that file is one comment hunk. |

**Round 962's write-set — EVERY path of it undeclared, and that is the finding
rather than the excuse.** Round 961's finding 6 measured the seeding site, not
the builder: task `eb282064` was seeded with `write_set = []`, and so was round
962's. The brief's claim that this gate is "satisfiable by construction because
write-sets are declared on the task row" is false for any task whose row carries
an empty one — there is nothing to compare a commit against, so §10 is the only
place the manifest can exist. Declared here, in the commit that makes it, and
repeated in `evidence/round962-fix-cycle-1.md` §7 and in the commit message.

| file | why round 962 writes it |
|---|---|
| `forge-control/src/lib/project-tick.ts` | **the deliverable.** Round 961's findings 3, 4 and 5 as three rules in `GRAPH_GUIDE` — the cap counts the `main` every project is born in (so `cap-1` remain) plus the allocation rule a project-wide budget always needed; a task does not inherit its creator's workstream, stated in FAN-OUT where the fan-out decision is made; a lane opened for a task that creates tasks belongs to that task. Plus the doc comment recording the measurement, per this constant's own rule. |
| `forge-control/src/lib/project-tick.test.ts` | **standing rule 2 — the gate is enforced here.** NF7's LEDGER gains `{ round: 962, spent: 637, reserved: 650 }` and a delivery control per finding. `BUDGET` is **not** touched: the candidate was trimmed from +667 to +637 to fit round 822's reservation rather than answered by widening, per the operator's "last routine widening" condition. |
| `scripts/checks/check-workstream-claim.ts` | §6B's seven new checks (19 → 34), including `6.8`'s executed pair — the same four researchers spawn **1** with the workstream field omitted and **4** with a lane each. §5.6's `OPEN, task 962` label is retired in the same commit as the finding it names (standing rule 4). §3's fixture is `Math.max(6, c.lanes)`: it demanded width 9 from six rows under a lawful `PROJECT_MAX_WORKSTREAMS=9` and could not be passed — **standing rule 2, amended where it is enforced**. The census moves with it. |
| `docs/plan/engine-task-graph/03-quality.md` | **round 825's blocker.** Item 12 called `executor.ts` a would-be INERT entry; it is in gate 6's ban pattern verbatim, and listing it grants a real exemption for a file whose declared write-set in this §10 is *none*. Corrected against the script's own output. |
| `docs/plan/engine-task-graph/04-phases.md` | this disclosure, and round 962's row in the table below. |
| `docs/plan/engine-task-graph/01-requirements.md` | §J closes the 650-character reservation it opened at round 822. |
| `docs/plan/engine-task-graph/evidence/round962-fix-cycle-1.md` | **new.** This round's transcript: the sizing, the trims, the four mutation controls, the natural experiment re-counted, and why finding 1's prescribed command was not run. |
| `docs/plan/engine-task-graph/evidence/round962-candidate-graph-guide.txt` | **new.** The artefact the +637 was measured off, kept so the shipped constant can be checked against the measured text at any later date — they are byte-identical, sha256 `57762f7296f71ca5`. |

Nothing outside `docs/plan/engine-task-graph/`, `scripts/checks/` and the two
`forge-control` engine files was written. **`/opt/forge-ai-os` was not written at
all** — see `evidence/round962-fix-cycle-1.md` §6 for why round 961's prescribed
`git checkout --` was *not* executed against a tree that had since moved.

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

**Phase 8's write-set, declared in the commit that makes it (round 802).**
Same style as the rounds 213 / 215 / 222 / 231 / 239 rows above: declared, not
reconstructed. Phase 8 is the first phase in this project to run **three
builders concurrently in one worktree**, so the table below is a live
constraint rather than documentation — 8B, 8C and 8D hold **disjoint** file
sets and each declines the others' files by name.

| task | round | files it writes |
|---|---|---|
| **8A** — merge `main` into the work branch | 801 | `forge-control/src/routes/chat.ts`, `forge-control-web/app/desktop/team/planApi.ts`, `forge-control-web/app/desktop/team/PlanKanban.tsx`, `forge-control-web/app/api.ts`, `evidence/phase8-merge.md` — **plus the merge commit itself, which necessarily carries `main`'s files.** A merge commit cannot honour a write-set; that is a property of merges, not a violation, and it is declared here so the round-803 write-set audit (`03-quality.md` §3.1 item 4) resolves without archaeology. |
| **8B** — the instrument and the baseline | 802 | `scripts/measure-schedule.ts`, `forge-control/src/lib/schedule-metrics.ts`, `forge-control/src/lib/schedule-metrics.test.ts`, `evidence/baseline-8ea0cc08.md`, `00-vision.md`, `evidence/phase8-instrument.md` |
| **8C** — corpus repairs and the gates phase 8 must amend | 802 | `01-requirements.md`, `03-quality.md`, `04-phases.md`, `evidence/phase4-workstreams.md`, `evidence/phase8-corpus.md` |
| **8D** — deploy tooling and the instrument gate | 802 | `scripts/deploy/await-and-seed.sh`, `scripts/deploy/payload-verify.json`, `scripts/deploy/payload-report.json`, **`scripts/deploy/payload-review.json`** (a fourth payload, observed on disk at round 802 and recorded here rather than left to archaeology — 8D states its own reason), `scripts/checks/check-await-seed.sh`, `scripts/checks/check-instrument-typecheck.sh`, `scripts/checks/instrument-manifest.txt`, `evidence/phase8-tooling.md` |
| **the deploy task** | 810 | `evidence/baseline-8ea0cc08.md` (part 2 **append**), `evidence/phase8-deploy.md` |
| **the deploy task, RE-RUN** | 816 | `evidence/phase8-deploy-rerun.md` (**new**), `evidence/baseline-8ea0cc08.md` (part 2 **append** — the row above, discharged here), `evidence/baseline-8ea0cc08-part2-raw.txt` (**new**), this table row |
| **the merge-to-`main` task** | 811 → **820** | `evidence/phase8-deploy.md` (**append**) |
| **the watcher-seeded tasks** | after the restart | `evidence/phase8-verify.md`, `evidence/after-<project-id>.md` |

**Round 816's write-set, declared in the commit that makes it — and why it is a
row of its own rather than a second use of round 810's.** Round 810 failed at
step 2b and wrote only `evidence/phase8-deploy.md`; the part-2 append was
deliberately not taken, because a half-read pasted into that file would have been
worse than an absent one. Round 816 re-ran the whole interlock against a working
instrument and took the read, so its transcript is a **new** file rather than an
edit of round 810's — that document is the record of a refusal and rewriting it
would destroy the most valuable thing round 810 produced. Two consequences worth
declaring where the audit looks:

- **`evidence/baseline-8ea0cc08-part2-raw.txt` is a fourth file nobody planned
  for.** The read's stdout is 18,058 lines, of which 17,910 are the per-minute
  concurrency block the instrument emits *uncapped and untruncated by design*
  (`schedule-metrics.ts`: *"a module that silently dropped samples would be
  reporting a mean over a window it did not disclose"*). Pasting them into the
  markdown would bury part 1; eliding them would make S1 quotable but not
  re-derivable. The whole stdout is therefore committed verbatim beside the
  document, with its sha256 and line count printed in the prose that points at
  it. Relocated, not elided.
- **Round 811's row now reads 811 → 820.** The merge-to-`main` task moved when
  the operator re-planned off round 810's manager report; the row is corrected
  here rather than left naming a round that became the uuid-cast fix.

**Phase 7's files, written by phase 8 — the one cross-phase row, and it is
deliberate.** 8B writes `scripts/measure-schedule.ts`, `schedule-metrics.ts`,
`schedule-metrics.test.ts` and `00-vision.md`, all of which §10 above assigns to
phase **7**. Two reasons, both forced:

- **E-3's step-2b read is impossible without an `--exclude-task` flag** — D6,
  `unresolvable-run`. The instrument refuses a project whose run set it cannot
  resolve (R61, correctly), and the deploy task's own run is inside the project
  it is measuring. The flag is a change to phase 7's instrument that only phase
  8 discovers, because only phase 8 runs it against a live project.
- **Editing the instrument obliges the part-1 re-run in the same commit.**
  R62's surviving formulation requires every pasted header in
  `baseline-8ea0cc08.md` to name the instrument on disk; moving the instrument
  moves that value under eight headers, a `00-vision.md` §2.2 heading and a
  ledger row. `03-quality.md` §3.2's phase-8 block enforces exactly this, and
  `check-instrument-identity.py` fails the gate otherwise. The re-run is not an
  optional tidy-up; it is what keeps "one instrument" true.

Recorded here rather than at the site alone, per the round-213 and round-215
precedent: **disclose, not abstain.**

**8C's three writes outside its declared set, declared in the commit that makes
them (round 802).** 8C's brief names five files. Three more were required, and
the reason is a live instance of exactly what §10 exists to compute.

| file | why 8C writes it |
|---|---|
| `evidence/fix-cycle-2.md` (5 lines), `evidence/phase6-plan-api.md` (1), `evidence/phase8-merge.md` (1) | **One `[historical instrument]` marker appended per line; no recorded value altered.** Mid-round, 8B's uncommitted `--exclude-task` edit moved `scripts/measure-schedule.ts` from `f6828a68…` to `6ec72b35…`, which retired an identity quoted in **20** places and turned the **universal** gate `check-instrument-identity.py` red for the whole round. Thirteen of those are 8B's own declared files and are 8B's to close (the eight pasted headers oblige the part-1 re-run in the same commit — R62, `03-quality.md` §3.2). **Seven sat in no round-802 write-set at all**, in settled files from rounds 217, 231 and 801 with no concurrent writer. Left alone they would have handed round 803 a universal gate that no declared owner could turn green — a gate that can only be disclosed, which is the precise pathology `03-quality.md` §4 was rewritten to remove. Taken here because the risk is nil (no concurrent writer; the marker annotates the record and does not alter it) and the alternative is a red gate with no owner. |

**Round 804's write-set, declared in the commit that makes it (fix cycle 1 on
round 803's four findings).** One task, no concurrent builder, so this is stated
rather than reconstructed. Round 803's own verdict scoped it: *"all four are
small and none touches the scheduler"* — and none of these files is in 810's or
811's write-set, so the deploy tasks are unaffected.

| file | why round 804 writes it |
|---|---|
| `scripts/deploy/await-and-seed.sh` | Findings **1** and **2**. The malformed suppression directive above `read_pm2()`'s `$PM2_CMD` pipeline (SC1125) is removed and its rationale moved to plain comment lines; `notify_manager()` now branches on `$HTTP_CODE` so a non-2xx is a WARNING carrying the code and the body, not "notified". A new hazard **(f)** joins the file's own instrument-honesty list. **Finding 1 lands before 811 merges to `main`, as round 803 required** — otherwise the shipped watcher carries it permanently. |
| `scripts/checks/check-await-seed.sh` | Finding **2**'s gate. The recorder's `/message` code becomes settable (`$TMP/message-code`, default 202) and **case 7** refuses the message with the live route's bytes, asserting the WARNING and the *unchanged* exit code. 6/49 → **7/56**. Hazard **(f)** added to the harness's own list: a stub that only ever says yes cannot distinguish a handled failure from an unhandled one. |
| `docs/plan/engine-task-graph/evidence/phase8-merge.md` | Finding **3**. §4's three bare line pins (`ENGINE_EFFORT_CHOICES`, the `api.ts` breadcrumb, `quotaQuery.ts:63`) are restated by symbol, with the numbers surviving only inside a transcript pinned to the recorded SHA `674d860` — the form standing rule 1 permits. |
| `docs/plan/engine-task-graph/evidence/phase8-tooling.md` | Finding **4**, the retirement half. §6's `command -v shellcheck # ABSENT` line and the finding paragraph below it are retired — quoted, marked superseded, not deleted — and replaced by **§6.1**, the executed run over the derived 7-file list. §4's counts follow the harness to 7/56 and §4.1's red mutation is restated at 8 and re-run. |
| `docs/plan/engine-task-graph/03-quality.md` | Finding **4**, the gate half — **standing rule 4: retire a requirement and its gate clause together, in one commit.** §3.1 gains **universal gate item 10** (shell lint) and §4's block gains its line. Universal and not phase-8's for item 9's reason: any phase can add a script. |
| `docs/plan/engine-task-graph/04-phases.md` | **Standing rule 2 — declare the write-set where the audit looks.** This table. No other section of this file is touched. |

**What this round did NOT do, stated so the re-check does not go looking.** No
scheduler file, no `forge-control/src/**`, no migration, no payload under
`scripts/deploy/payload-*.json`, and no `main` merge. `pnpm test` is unchanged at
**1270 pass / 0 fail / 0 skipped** — the four fixes live in shell and markdown,
which the TS suite has no jurisdiction over, and that is precisely why each one
is proved by an executed run rather than by the suite staying green.

**Rounds 805 and 806's write-set, declared in the commit that makes it (fix
cycle 2 on round 805's one blocker).** One task, no concurrent builder. Round
805's blocker was scoped "no code change, no gate change"; the gate change below
is a second item the same reviewer raised and declined to block on, and it is
taken here for the reason standing rule 2 gives — an unsatisfiable gate is
amended where it is enforced, in the same commit, not filed for later.

| file | why rounds 805–806 write it |
|---|---|
| `docs/plan/engine-task-graph/evidence/phase8-merge.md` | **The blocker.** §4's replacement citation was a fabricated `$ grep`. `0da7415` (round 805, operator) fixed the prose and the `api.ts` line; round 806 fixes what remained — the `quotaQuery.ts` grep shown with **one** of its **ten** output lines and no elision marked, and a closing sentence counting "three numbers" against a block that no longer held three. The transcript now shows every line the commands print, an `echo $?` where one prints nothing, and a `git log` proving neither source file has moved since the SHA the block names. The conclusion is unchanged and was always true. |
| `docs/plan/engine-task-graph/evidence/phase8-tooling.md` | **§6.2, new** — the four measured cases behind the item-10 amendment, including the false start where git scored the scratch delete as a rename and the measurement tested nothing. Plus a scope correction to round 804's commit message ("zero suppression directives **anywhere** on the branch" is one file too wide; the accurate claim is the seven `*.sh` this branch touches), recorded here because a commit message cannot be amended without rewriting shared history. §6.1's own empty-sweep block gains its elision marker, so the rule this round installs holds in the file that installs it. |
| `docs/plan/engine-task-graph/03-quality.md` | **Universal gate item 10, amended where it is enforced (§3.1 and §4 both — a gate stated twice rots if only one copy is fixed).** The derived file list now names and skips paths the branch deleted. Measured: unfiltered, a branch that retires one `*.sh` exits **2** whether its surviving scripts are clean or broken, so it cannot reach 0 by any means and its verdict stops discriminating. Filtered, the delete case exits 0 with the skip disclosed, a planted SC1125 exits 1, and an all-absent list still exits 3. |
| `docs/plan/engine-task-graph/04-phases.md` | **Standing rule 2 — declare the write-set where the audit looks.** This table. No other section of this file is touched. |

**What these two rounds did NOT do.** No scheduler file, no `forge-control/src/**`,
no migration, no payload, no `main` merge, and no check script. `pnpm test` is
unchanged at **1270 pass / 0 fail / 0 skipped**, which is the expected reading
for a markdown-only diff and is therefore evidence of nothing — every claim here
rests on an executed run pasted whole.

**Round 813's write-set, declared in the commit that makes it (fix cycle 1 on
round 812's three findings).** One task, no concurrent builder. Transcripts:
`evidence/phase8-uuid-cast.md` §9.

| file | why round 813 writes it |
|---|---|
| `docs/plan/engine-task-graph/03-quality.md` | Finding **1**. §3.1 gains **universal gate item 11** — `bash scripts/check-schedule-sql.sh` exits 0 — and §4's block gains its command, the gate fixed in both places it is stated (round 805's rule). Round 811 built the only instrument that executes `schedule-source.ts`'s SQL — and the only one that provisions its own cluster — and wired it into no list, so a transposition of `RUNS_SQL`'s two `OR` arms passed every gate the corpus named — `pnpm test` 31/31, `tsc` 0 — while Postgres answered `text = uuid`, `42883`. Universal, not phase-8's: any phase can ship a statement no test parse-analyzes. |
| `forge-control/src/lib/schedule-source.test.ts` | Finding **2**. The fix's unstated premise — the `->>` arm resolves `$1` before the cast arm does — asserted at two layers: §4.1's ORDER assertion with a permutation control and a stated blind spot, §4.2's executed negative control against the transposed statement. Red-mutated in a shadow tree: 2 of 34 static tests fail, and the executed regression fails with the transposed `42883`. |
| `docs/plan/engine-task-graph/check-instrument-identity.py` | Finding **3**. `manifest_lines += 1` moves inside `if not exempt:`, so a historical manifest line no longer counts toward `MIN_MANIFEST_LINES`. Latent (26 live to 1 exempt as round 812 left the corpus, 27 live once §9's own transcript lands — the control clears 8 either way); the failure it prevents is reproduced on a synthetic corpus, where the pre-fix script exits **0** while check 1b compared nothing. |
| `docs/plan/engine-task-graph/evidence/phase8-uuid-cast.md` | §9, new — every transcript above. |
| `docs/plan/engine-task-graph/04-phases.md` | **Standing rule 2 — declare the write-set where the audit looks.** This table. No other section of this file is touched. |

**What round 813 did NOT do, stated so the re-check does not go looking.**
`forge-control/src/lib/schedule-source.ts` is **unchanged** — deliberately, so
the instrument identity `fb5a6434…` does not move and the eleven live pasted
headers stay valid; the reasoning is in `evidence/phase8-uuid-cast.md` §9.2. No
other file under `forge-control/src/**`, no migration, no payload, no check
script, no `main` merge, no deploy. `pnpm test` moves 1278 → **1281**, which is
the three new static tests and nothing else.

**And note what this row is.** The three builders of round 802 were split by
declared write-set, and the split held for every *file* — no two builders touched
one. What crossed the boundary was not a file but a **fact**: one builder's edit
to a constant retired a value quoted across seven files belonging to nobody. A
write-set models contention over bytes; it does not model contention over
**truth**. That is a limit of this project's own mechanism, found by running it,
and it is recorded here rather than smoothed over.

Within a phase, the planner splits builders so that **no two builders in the
same workstream declare the same file**. Where a split is impossible — two
changes to `db/projects.ts` that genuinely interlock — put them in one builder,
not in two rounds. One builder writing a file twice is cheaper than two builders
serialising on it.

**Round 820's write-set, declared in the commit that makes it (phase 8F, the
deploy).** The task's declared `write_set` was one file —
`evidence/phase8-deploy.md`. Three writes fell outside it, and the rule is
disclose, not abstain, so they are named here rather than reconstructed later by
grepping the diff.

| file | why round 820 writes it |
|---|---|
| `docs/plan/engine-task-graph/evidence/phase8-deploy.md` | **Declared.** Steps 3-6 appended in execution order with timestamps, because the phase-8 gate checks the ORDER and not the intent. |
| `scripts/deploy/payload-report.json` | **Undeclared, and the operator's pre-launch instruction.** New item **1b**: the after-measurement must re-derive the instrument composite `fb5a6434…` from disk rather than paste it, and must state and cite its sampling convention (PART 2 §10.1 of `evidence/baseline-8ea0cc08.md`). Amended **here** and not in `payload-verify.json` because this is *where the gate is enforced* — round 817's report task is the one that computes S1/S2/S3. Standing rule 2: a gate belongs at its enforcement site. |
| `scripts/deploy/payload-verify.json` | **Undeclared.** One sentence in item 8, marking its three fan-out figures as a SPOT OBSERVATION rather than the DoD-6 after-measurement, and pointing at `payload-report.json` item 1b. The verify task seeds the report task, so the chain — not merely one file — has to carry the obligation. |
| `docs/plan/engine-task-graph/04-phases.md` | **Standing rule 5 — disclose the undeclared write where the audit looks.** This table. No other section of this file is touched. |

**Round 960's write-set: DECLARED EMPTY, so every file below is undeclared and
is named here rather than left to the diff.** The task ("GRAPH_GUIDE: open a
workstream per concurrent lane, not per file conflict") was seeded with no
`write_set` at all — the R31/R52 half that catches this is a `400` at task
creation under `metadata.strict_write_sets`, which this project does not carry —
so there is no set to have written outside of, and the honest form is a full
manifest. Standing rule 5 is disclose, not abstain.

| file | why round 960 writes it |
|---|---|
| `forge-control/src/lib/project-tick.ts` | The deliverable: `GRAPH_GUIDE`'s workstream criterion, replaced, plus the doc-comment paragraph that records the round-815 measurement behind it. Phase 5 owns this file's prompt constants (§10 above); no code path, log line or belt was touched — `git diff` on it is two hunks, both inside a string constant and its comment. |
| `forge-control/src/lib/project-tick.test.ts` | R48's clause gate (both directions) and NF7's ledger row + its two-halved delivery control. A criterion retired without its gate clause is standing rule 4's failure. |
| `forge-control/src/lib/workspace.ts` | **One export keyword and its comment.** `workstreamBranch()` became `export function workstreamBranch()` so R33's hyphen form can be asserted in-process by the new check; no expression in this file changed. Phase 4 owns it — recorded here for the same reason round 239's one-comment write to a phase-3 file was. |
| `scripts/checks/check-workstream-claim.ts` | **New.** The prompt's claim, executed against the scheduler (03-quality.md §2.2, §4). |
| `scripts/checks/instrument-manifest.txt` | Item 9's manifest guard: a `scripts/checks/*.ts` this branch adds must be listed, or the gate fails by name. |
| `docs/plan/engine-task-graph/03-quality.md` | The registry row and the §4 command line for that check — and the correction of the neighbouring row's "the only check that executes a prompt's claim", which this commit makes false. Standing rule 4, in the same commit. |
| `docs/plan/engine-task-graph/01-requirements.md` | R48's criterion amendment (the requirement the prompt clause serves), R33's record that the slash form outlived its refutation in a live payload, and NF7's live numbers: 12227 → 12246, headroom 44 → 25. |
| `scripts/deploy/payload-verify.json` | Item 7b predicted a branch git cannot create. Amended **where it is enforced** — the brief a re-deploy would re-issue — per the round-820 precedent two rows above. |
| `docs/plan/engine-task-graph/evidence/phase8-tooling.md` | §7 claims to quote the payload briefs *verbatim*. Two of the three were stale before this round touched them (round 820's amendments never reached them, the report quote short by the whole of item 1b); all three are now byte-identical to their payloads, proved by sha256 rather than by reading. |
| `docs/plan/engine-task-graph/evidence/phase8-verify.md`, `evidence/phase5-prompts.md` | The two documents that QUOTE the retired criterion. Annotated, never rewritten: both are records of what was measured or shipped, and a record edited to match today's code is the rot this project keeps finding, one level worse. |
| `docs/plan/engine-task-graph/evidence/round960-workstream-criterion.md` | **New.** This round's transcript: the measurements, the five mutations, and the corpus sweep. |
| `docs/plan/engine-task-graph/04-phases.md` | This table. No other section of this file is touched. |

**Why an amendment to a payload was in scope for a deploy task at all.** Round
816 measured, rather than asserted, that the S1 sampling convention is
load-bearing: the same baseline rows give S1 0.29 / peak 6 under the committed
instrument's half-open **instant** convention and S1 0.30 / peak 7 under the
**overlap** convention. That gap is the same magnitude as the improvement DoD-6
exists to demonstrate, in either direction. An after-measurement taken under the
other convention would therefore manufacture or erase the result with nobody
able to tell which — **a before/after comparison across two conventions is not a
finding, it is an artefact.** Both payloads were read before launching the
watcher, as the deploy step requires; neither stated the constraint; the window
to fix that closes the moment the merge lands, because the watcher reads these
files from `/opt/forge-ai-os`. Hence: amend first, commit, then merge.

**Round 820's write-set (fix cycle 1 on round 819's review) — declared here in
the commit that makes it, and EVERY file below is outside a declared set.**
Task `3610b0fc-a2f3-4b01-a8ca-e1d7b5f0a621` was seeded with `write_set = []`,
so, exactly as round 960's row above says, there is no set to have written
outside of and the honest form is a full manifest. **The seeding is not a
lapse and cannot be fixed by a brief**: a fix-cycle row's write-set is the union
of its GATING tasks' write-sets (`fixChainGraphFields()`, R42) and its gating
tasks are reviewers, who declare none by R31's design — verified on live data
for this row and for `c527a985` (round 962), both gated by reviewers carrying
`[]`. That is now written into the gate itself, `03-quality.md` §3.1 item 4,
rather than disclosed for a third round. Standing rule 5 is disclose, not
abstain.

| file | why round 820 writes it |
|---|---|
| **the merge commit** (`main` → `project/8c591d6c`) | Round 819's finding 5. This branch had never merged `main`, so item 9 ran the **pre-round-500 manifest-scoped** gate at **8 of 43** subjects. A merge commit cannot honour a write-set — a property of merges, not a violation — and it necessarily carries `main`'s files; declared here per phase 8A's precedent above. One conflict, `scripts/checks/instrument-manifest.txt`, resolved **by reasoning and not by `-X ours`/`-X theirs`**: the file's semantics changed from inclusion list to **waiver ledger**, under which our branch's seven inclusion lines would be malformed waivers excusing failures that do not exist. Resolved to the empty ledger, which is that project's stated target state. |
| `forge-control/src/routes/projects.ts` | Round 819's finding 2 / round 961's finding 2. R39's cap decision is hoisted out of the `POST /:id/tasks` handler into an exported `workstreamCapRefusal()` that the handler calls, so the guard can be **executed** by an instrument with no database. The route still returns the same `400` with byte-identical `error` text; `check-task-api.ts` case 13 is unmodified and is the control that nothing behavioural moved. Phase 3 owns this file (§10 above) — recorded here for the same reason round 239's one-comment write to it was. |
| `scripts/checks/check-workstream-claim.ts` | The instrument that was reported inert by two consecutive reviewers. It now imports `PROJECT_MAX_WORKSTREAMS`, derives §3's lane table from it, executes `workstreamCapRefusal()` at the cap and one past it (new §5), and parses `GRAPH_GUIDE`'s advertised default against the constant (new §6.6). Both mutations that survived it are re-run and killed in `evidence/round820-fix-cycle-1.md` §2. |
| `scripts/checks/instrument-manifest.txt` | Resolved as part of the merge above, to `main`'s waiver-ledger form with **zero entries**. Round 960's row above lists this file under "item 9's manifest guard: a `scripts/checks/*.ts` this branch adds must be listed" — **that guard is retired** and the sentence is false of the gate that exists after the merge. Retiring the requirement and its gate clause together, standing rule 4. |
| `docs/plan/engine-task-graph/03-quality.md` | Two gate amendments, each **where it is enforced**: §3.2's phase-8 S3 clause, whose literal `131` the evidence measured as `156` (finding 8); and §3.1 item 4's write-set audit, unsatisfiable by construction on every fix-cycle row (finding 6). Item 9's prose needed no edit — `main`'s copy already carries the corrected glob/waiver-ledger wording, which the merge brought in. |
| `docs/plan/engine-task-graph/evidence/round960-workstream-criterion.md` | Finding 7: §5's two bare `file:NN` pin blocks gain the SHA they were measured at (`5d0e0c0`, each re-derived) plus the command to re-derive them. Its `ALL PASS — 19 checks` transcript and its §6 verdict table are **annotated as superseded, never rewritten** — that record is what round 960 really measured, and it was green for the wrong reason. |
| `docs/plan/engine-task-graph/04-phases.md` | This table. No other section of this file is touched. |
| `docs/plan/engine-task-graph/evidence/round820-fix-cycle-1.md` | **New.** This round's transcript: every gate re-run, both mutations, and the four findings round 820 does **not** close. |

**Round 822's write-set (fix cycle 2 on round 821's re-review) — declared here
in the commit that makes it, and EVERY file below is outside a declared set**,
for the identical structural reason two paragraphs above: task
`706e1d78-cf4a-44aa-a687-d116b100f47e` was seeded with `write_set = []` because
`fixChainGraphFields()` unions its GATING tasks' write-sets and its gating task
is a reviewer, who declares none by R31's design. `03-quality.md` §3.1 item 4
carries the amended audit for exactly this row shape; the honest form is a full
manifest, and this is it.

| file | why round 822 writes it |
|---|---|
| `scripts/checks/measure-graph-guide-budget.ts` | **New.** Round 821's reviewer had to hand round 962 a `GRAPH_GUIDE` budget by hand, and every round since 239 that touched that constant re-derived NF7's arithmetic in prose. `measure-prompt-baseline.sh` measures committed refs; nothing measured a **candidate**. This sizes one before it is written, printing the LEDGER row it would have to declare, and it **parses** `BASELINE`/`BUDGET`/`FIVE_A_TIP`/every `spent` out of the enforcing test rather than copying them — a cap copied into an instrument is the pin standing rule 1 names. Its own first run reported a ledger row as `round: 1` (a lazy regex reaching a task fixture); scoped to the `const LEDGER` block and negative-controlled three ways. Item 9 goes 43 → 44 subjects, glob-enumerated, nothing to declare. |
| `forge-control/src/lib/project-tick.test.ts` | NF7's `BUDGET` **3050 → 3700**, amended **where it is enforced** (standing rule 2). Round 961's findings 3, 4 and 5 are each a new RULE in `GRAPH_GUIDE`; a reference wording built by transforming the live constant measures **+564 net against 25 of headroom**, so round 962's gate could not be passed by a factor of 22. Stated in the block as what it is: **a widening**, not a re-derivation. 650 of the new 675 headroom is reserved for round 962. **No test body is modified and no LEDGER row is added** — the ledger is an `assert.equal` against a live measurement, so 962 adds its row in the commit that spends it, as 5B did at round 240. `pnpm test` 1294/1294, unchanged. |
| `docs/plan/engine-task-graph/01-requirements.md` | NF7's requirement text **3050 → 3700** with the same arithmetic, in the **same commit** as the assertion (standing rule 4). These two disagreed once, at round 239, and "the measured number wins" is the ruling that settled it — they must not be allowed to disagree a second time. |
| `forge-control/src/lib/project-tick.ts` | **Comment only, no executable text.** `GRAPH_GUIDE`'s doc-comment closes with "Headroom after: 12271 − 12246 = 25", which stops being live the moment the cap moves — standing rule 1's failure class exactly. It is **annotated, never rewritten** (12271 is what round 960 really measured against), records that 650 of the new headroom is spoken for, and names the sizing command. Measured control: the maximal planner prompt is **12246 before and 12246 after**, which is this project's standing claim that doc-comments cost the prompt nothing, measured a second time. |
| `docs/plan/engine-task-graph/evidence/round822-graph-guide-sizing.txt` | **New.** The reference wording the +564 comes off, kept as a **sizing input and explicitly not the deliverable** — round 962 owns that text. Generated by transforming the live constant edit by edit, each asserted to apply exactly once, so all 23 gate-frozen needles (R38, R47, R48, round 900) survive by construction and the retired same-file criterion is asserted absent. |
| `docs/plan/engine-task-graph/evidence/round822-fix-cycle-2.md` | **New.** This round's transcript: the measurement, the three negative controls with their hash-verified restores, the read-only re-measurement that closes finding 2, DoD-6's premise confirmed, and the handoff round 962 reads. |
| `docs/plan/engine-task-graph/03-quality.md` | §4's reviewer block gains the new instrument. An instrument nobody is obliged to run rots; this one is a **gate** with no argument (it re-executes NF7's equality from outside the suite and asserts the single-occurrence property no other check asserts) and a **tool** with `--candidate`. Added where it is enforced, in the same commit as the instrument. |
| `docs/plan/engine-task-graph/04-phases.md` | This table. No other section of this file is touched. |

**Round 824's write-set (fix cycle 3 on round 823's re-review) — declared here
in the commit that makes it, and EVERY file below is outside a declared set**,
for the same structural reason the two rows above give: task
`642fbcb9-ae9d-4986-a60a-fcd8a4ab4f56` was seeded with `write_set = []` because
`fixChainGraphFields()` unions its GATING tasks' write-sets and its gating task
is a reviewer, who declares none by R31's design. `03-quality.md` §3.1 item 4
carries the audit shape for exactly this row; the honest form is a full
manifest, and this is it. **Two of these files are new and two are `scripts/`
rather than corpus, so read this table before the diff.**

| file | why round 824 writes it |
|---|---|
| `scripts/checks/forbidden-file-diff.sh` | **New. Round 823's finding 1 — the blocker.** `gates-808.sh` gate 6 was UNSATISFIABLE for this project by construction: it banned any diff to `project-tick\|cc-runner\|executor.ts\|db/projects\|VaultFileList\|routes/files`, and this project's mandate is the first and the fourth, so `--strict` could not exit 0 at any sha and no PASS — including the deploy's — was reachable. The decision moves here so it can be **driven with fixtures**; its only input was previously whatever `main...HEAD` held, which is why four rounds could argue about it and none could test it. The ban pattern is unchanged and no project is named. |
| `scripts/checks/check-forbidden-file-diff.sh` | **New.** The control, 14 cases, both directions — including that the empty-allow default still refuses (the property the operator ruling requires of every other project), that `VaultFileList`, `routes/files` and `cc-runner` are still refused *under this project's own allow list*, and the live-diff mutation that proves the list is load-bearing. It **found a defect in its own subject on its first run** (8 red): a final path with no trailing newline was silently dropped, so a producer emitting an unterminated list would have had a forbidden file read as clean. Fixed and pinned by case 14. |
| `scripts/checks/gates-808.sh` | **The amendment, where it is enforced (standing rule 2), and the clause it retires, in the same commit (standing rule 4).** Gate 6 now pipes into the script above and is named for the variable it consults. The waiver comment's closing clause *"…as do all engine files"* is **retired by name** rather than edited away. **The shape is not mine**: operator ruling 2026-08-18, vault `AI OS/Operator Decisions.md` § "A gate that forbids touching a file cannot govern a project whose mandate is that file" — bind the ban to the DECLARED WRITE-SET via a caller-supplied `GATES_ENGINE_ALLOW`, defaulting to empty, never to a project name, because a name-based waiver rots the moment the project ends and nothing removes it. |
| `docs/plan/engine-task-graph/03-quality.md` | **Universal gate item 12, new**, and the §4 reviewer block that runs it. Item 12 states the allow list, ties each entry to §10 above, and makes the REVIEWER'S obligation explicit: the list must equal the branch's banned-pattern diff and every entry must be declared, run both ways so the second output names what the list buys. Added in the same commit as the gate, in both places the gate is stated — round 805's rule that a gate stated twice rots if only one copy is fixed. |
| `docs/plan/engine-task-graph/01-requirements.md` | **Round 823's finding 3.** §J closed with *"Reported to manager chat `bfd1283a` for a ruling"* — true when written, and now misleading: the ruling came back **CONFIRMED with a condition** (*any future NF7 increase must state in its own commit what was retired first and why it did not pay, with the measurement*). It lived only in a chat thread and one task brief, where round 964 would never find it. Recorded verbatim with the operator's three reasons and the sequence a fourth widening now owes. Not round 822's omission — the ruling postdates its commit. |
| `docs/plan/engine-task-graph/evidence/round822-fix-cycle-2.md` | **Round 823's finding 2.** §3's second grep was **inert**: `grep -c "so open ONE PER LANE you want running at once"` returns `0` against the worktree too, because the source splits the phrase across concatenated template literals and it appears contiguously in no file. Round 822's block is kept as the record of what it ran, marked, and superseded by a new **§3.1** that measures both trees, names which half discriminates (`"truly need one file concurrently"`, 1 live / 0 worktree — it always carried the conclusion alone), supplies a contiguous replacement (`"ONE PER LANE"`, 0 live / 1 worktree) and the constant-level check. **The failure this closes is the deploy's**, which was to re-run those greps after `safe-restart.sh` and would have read `0` and called a working deploy failed. |
| `scripts/checks/measure-graph-guide-budget.ts` | Round 823's **non-blocking note 1**. When a scalar fails to parse, `projectedHeadroom` is `NaN`, `NaN < 0` is false, and the instrument printed `VERDICT: FITS — NaN characters would remain under the cap`. It exited 1 and §5 voided every number, so rule 3's letter held — but the affirmative string is the one a grep or a pasted excerpt lifts, and a verdict line is read alone more often than in sequence. Guarded on `Number.isFinite`, with a refusal that names the cause. Reproduced by renaming `const BASELINE` and re-run: **0 occurrences of `VERDICT: FITS`, exit 1**; the test file restored and verified byte-identical by sha256. |
| `forge-control/src/lib/project-tick.test.ts` | Round 823's **non-blocking note 2**, and **the one test body this round modifies** — an assertion MESSAGE only, no expression, no fixture, no count. The reservation audit read *"do NOT widen BUDGET … the one direction rule 2 does not license"* two hundred lines below a block that widened BUDGET. The message now separates the two cases it was conflating — raising a cap AFTER the fact to cover text already written (forbidden) from amending a gate measured unsatisfiable BEFORE the work (required by rule 2) — and a doc-comment above the test states the distinction and points at §J. `pnpm test` **1294/1294, unchanged**. No prompt constant is touched, so NF7's measurement is unmoved at 12246. |
| `docs/plan/engine-task-graph/evidence/round824-fix-cycle-3.md` | **New.** This round's transcript: every gate re-run at this tip, the eight-case first run that found the subject's defect, the NaN mutation with its hash-verified restore, and the gate-6 before/after in both directions. |
| `docs/plan/engine-task-graph/04-phases.md` | This table. No other section of this file is touched. |

**What round 824 did NOT do, stated so the re-check does not go looking.** No
migration, no scheduler code path, no prompt constant, no payload under
`scripts/deploy/`, no `main` merge, and **no deploy** — `8ea0cc08` is live and
the brief forbids it. Nothing under `/opt/forge-ai-os` was written; the two
read-only `grep -c` measurements in `round822-fix-cycle-2.md` §3.1 are reads of
a file on disk, the same act round 823's reviewer performed to re-verify the
premise, and they touch no service, endpoint or database.

**And note what this round's finding 1 is, because it is this project's own
subject matter pointed at its own toolchain.** A gate that forbids touching a
file cannot govern a project whose mandate is that file — and the reason it
survived four rounds is not that four reviewers were careless. It is that gate 6
had **one fixture**, `main...HEAD`, which no task on this branch was permitted to
vary. An assertion nobody can drive in both directions degenerates into an
opinion about whether it *should* be red, and an opinion is what gets disclosed
and walked past. The fix that matters is not the allow list; it is that gate 6
now has a control.

---

### Round 962 — fix cycle 1 against round 961, and the close of the `max_cycles` block

**This round exists because the engine had stopped seeding cycles.** The project
sat BLOCKED on `max_cycles` (cycles 1/2/3 at rounds 820, 822, 824; round 825's
re-review would have been a fourth). The operator unblocked it with an explicit
instruction: fix round 825's one-sentence blocker *here* rather than seed a
fourth cycle. `03-quality.md` §3.1 item 12's `INERT`/`UNUSED` correction is that
fix, and it is why the record shows no fourth cycle.

| file | why round 962 writes it |
|---|---|
| `forge-control/src/lib/project-tick.ts` | findings 3, 4, 5 as three rules in `GRAPH_GUIDE`; the doc comment records the measurement. |
| `forge-control/src/lib/project-tick.test.ts` | NF7's LEDGER row `{962, 637, 650}` + a delivery control per finding. **`BUDGET` unchanged at 3700.** |
| `scripts/checks/check-workstream-claim.ts` | §6B (7 checks, 19 → 34); §5.6's retired `OPEN` label; §3's unsatisfiable-at-override fixture; the census. |
| `docs/plan/engine-task-graph/03-quality.md` | round 825's blocker. |
| `docs/plan/engine-task-graph/{01-requirements,04-phases}.md` | §J's closure; §10's disclosure and this row. |
| `docs/plan/engine-task-graph/evidence/round962-fix-cycle-1.md` | **new.** The transcript. |
| `docs/plan/engine-task-graph/evidence/round962-candidate-graph-guide.txt` | **new.** The measured artefact. |

**The budget held, which is the part worth recording.** The operator confirmed
NF7's `BUDGET` at 3700 while making it *"the LAST widening that gets to be
routine"*. Round 962's first candidate measured **+667** — inside the cap, but 17
characters past the 650 round 822 reserved. It was **trimmed to +637**, four
edits, none of them to a rule. The first round in a while whose answer to a
binding budget was to spend less.

**What round 962 did NOT do, stated so the re-check does not go looking.** No
migration, no route, no scheduler behaviour, no `BUDGET` change, no deploy, no
GitHub push, and **no write to `/opt/forge-ai-os`** — round 961's prescribed
`git checkout --` was deliberately not executed, because the file it named had
since been committed (`1e0330b`, on `main`) and the tree now holds a different
project's uncommitted work. That is `evidence/round962-fix-cycle-1.md` §6, and it
is escalated to Konrad rather than resolved by a build task.

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
> scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts |
> sha256sum` on the commit the file ships in.**

**Widened round 811, and the one-file form retired with it.** The sentence above
named ONE file until round 811. That command no longer produces the header's
value — so the clause had become unsatisfiable, not merely loose — and it never
covered `forge-control/src/lib/schedule-source.ts`, which holds every line of
the instrument's SQL. Round 810 walked into the gap: a dry run from a copy with a
patched `schedule-source.ts` printed the shipped instrument's identity unchanged.
Retired here in the commit that changed the checker, together with
`01-requirements.md` §H R62 and `03-quality.md` §3.1 item 7.

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
