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

---

## Phase 2 — The graph scheduler
**Planner round 200.**
**Requirements: R10–R21, R18 (proof), NF1, NF6.**

### Scope
`promoteReadyTasks()` and `claimReadyTasks()` read the graph. The replica proof
turns green. This is the phase that removes the barrier.

### Files this phase writes
```
forge-control/src/lib/task-graph.ts                    (fill in every stub)
forge-control/src/lib/task-graph.test.ts               (new)
forge-control/src/lib/task-graph-replay.test.ts        (cases turn green)
forge-control/src/db/projects.ts                       (promote, claim, TASK_COLS, ProjectTask)
scripts/checks/check-scheduler-sql.sh                  (new)
docs/plan/engine-task-graph/evidence/phase2-replay.md  (new)
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
5. Every stub in `task-graph.ts` implemented, with `taskDepth`, `computeRound`,
   `conflicts`, `selectClaimable`, `graphReady`, `readyRule`,
   `GraphIntegrityError`.
6. `TODO(R12-retire)` at every legacy-branch site, and nowhere else.

### Acceptance criteria
- **The replay test passes, all five cases.** Output pasted.
- `check-scheduler-sql.sh` green, dangling case landing on `blocked`.
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
**Requirements: R32–R46, NF1, NF5.**

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
docs/plan/engine-task-graph/00-vision.md                   (only if the baseline corrected §2)
```

### The deploy sequence, in order

1. **Confirm the fleet is clear.** `operator-visibility` (8ea0cc08) has **no
   running and no pending tasks**. If it does: report and stop. Do not wait in a
   loop; end the task and let the next tick's planner re-seed it.
2. **Merge.** Merge `main` into the work branch first if main moved. Re-run
   `pnpm typecheck` and `pnpm test` **in the worktree** after the merge. On
   conflicts: **STOP and report the files.** Then merge to `main`.
3. **Apply the migration.** `psql -f db/migrations/0040_task_graph.sql`, twice,
   pasting both outputs. It is additive and the running old engine ignores it
   (R8), which is why it goes before the restart.
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
| 2 | R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, NF1, NF6 |
| 3 | R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, NF4 |
| 4 | R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, NF1, NF5 |
| 5 | R47, R48, R49, R50, R51, R52, R53, NF7 |
| 6 | R54, R55, R56, R57, R58 |
| 7 | R59, R60, R61, R62 |
| 8 | R63, R64, R65, R66, R67, R68, NF2, NF5 |

R1–R68 and NF1–NF7 are each defined exactly once in `01-requirements.md` and
each has exactly one **primary owner** phase here. Three entries appear in two
rows and each is deliberate, so a reader does not have to guess whether it is a
mistake:

- **R18** — phase 1 builds the replay *harness*, phase 2 makes it *pass*. Primary
  owner: phase 2. A harness that runs and reports is a phase-1 deliverable; a
  harness that is green is phase 2's, because there is nothing for it to be
  green about until the graph scheduler exists.
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
| `forge-control/src/executor.ts` | **none** — see `02-architecture.md` §1.2 |

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
