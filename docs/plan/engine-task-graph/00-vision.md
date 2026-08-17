# 00 — Vision: engine-task-graph

Project: `engine-task-graph` (8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4)
Architect round 0, 2026-08-17.
Base commit of this corpus: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e` (branch `project/8c591d6c`, off `main`).
Design of record: `/opt/obsidian-vault/AI OS/Spec - Task Graph and Workstream Worktrees.md` (Konrad, 2026-08-17 ~03:10).

---

## 1. The goal, restated precisely

The project engine schedules work by a hand-written integer. `project_tasks.round`
is chosen by an LLM planner, and `promoteReadyTasks()` releases a task only when
**every task in every lower round of that project is `done`**. That single rule
is the whole scheduler.

It is wrong in a specific, measurable way: a round number is asked to carry three
unrelated facts at once.

| Fact | Example | Is it a real dependency? |
|---|---|---|
| **Ordering** | "the reviewer must judge a settled tree" | **Yes.** |
| **File contention** | "these two both write `DesktopApp.tsx`" | No — it is a *resource* conflict. |
| **Narrative phase** | "this is phase 4 of the waterfall" | No — it is a *label*. |

Because one integer expresses all three, the strongest of the three wins every
time, and the strongest is always "wait". A reviewer that must genuinely wait
drags every unrelated task numbered above it into waiting with it.

**This project separates the three.**

- Ordering becomes `project_tasks.depends_on uuid[]` — an explicit edge list. A
  task is ready when its declared predecessors are `done`, and at no other time.
- Contention becomes `project_tasks.workstream text` + `project_tasks.write_set
  text[]` — a declared file ownership set, and a named worktree per team. Two
  tasks that write the same file either serialize (same workstream, computed
  from their write-sets) or run in isolated worktrees and merge through a
  reviewed integration task.
- Narrative phase stays `round`, demoted from a scheduler input to a label:
  the hundreds-block the Kanban already groups by, and the stable identity key
  that migrations 0035 and 0039 depend on. **It never gates anything again.**

Concurrency stops being a number a human chose. It becomes whatever the graph
permits at that instant, bounded only by the one global ceiling that should
bound it — `guardrail_rules['agent.spawn_cap']`.

## 2. The measurement that motivates it

Project `operator-visibility`, 2026-08-16 22:51 → 2026-08-17 03:04 (Konrad's
own numbers, recorded in the design spec §1):

| round | tasks | round | tasks |
|---|---|---|---|
| 1290 | 1 | 1303 | 1 |
| 1291 | 3 | 1304 | 2 |
| 1292 | 2 | 1305 | 1 |
| 1293 | 1 | 1306 | 1 |
| 1300 | 1 | 1350 | 3 |
| 1301 | 2 | | |
| 1302 | 3 | | |

- 12 rounds, ~21 runs, mean run 17 min.
- **Average 1.75 tasks per round.**
- 255 minutes of wall clock. The same work at a concurrency of 6 is ≈ 45 min.
- One 32-minute reviewer stalled seven unrelated builders numbered above it.
- Renumbering five builders by hand moved live runs from 1 → 6 **instantly**.
  Nothing in the engine required them to wait. Only the numbering did.

That last line is the whole justification. The latency was not compute, not the
spawn cap, not the model, not the account. It was an integer.

## 3. Definition of done

The project is done when **all six** of these hold, each demonstrated by an
artefact, not by an assertion:

**DoD-1 — The engine schedules from a DAG.**
`promoteReadyTasks()` releases a task when every id in its `depends_on` is
`done`, and never because a round drained. Demonstrated by: the unit tests of
`lib/task-graph.ts`, plus the live measurement in DoD-6.

**DoD-2 — Two tasks writing the same file, in different workstreams, run
concurrently and merge through a reviewed integration task.**
Demonstrated by: an end-to-end rehearsal (`scripts/checks/check-workstream-e2e.sh`)
in a throwaway repo that provisions two workstream worktrees, has both write the
same file, and drives the integration task's merge to a reported conflict rather
than a silent clobber. No auto-merge anywhere in the tree.

**DoD-3 — A replay test proves the migration preserved today's behaviour
exactly.**
`lib/task-graph.test.ts` replays the real `operator-visibility` task list —
committed as a fixture, not read from the live DB — through the old round rule
and the new graph rule, and asserts **identical promotion order**, task-for-task,
tick-for-tick, including the retry and late-insert cases. A single divergence
fails the suite.

**DoD-4 — A cycle cannot be inserted.**
`POST /api/projects/:id/tasks` answers `400` and **names the offending path**
(`a → b → c → a`, by task title and id) when `depends_on` would close a cycle.
Table-driven test over hand-built graphs. Cross-project and dangling dependency
ids are rejected the same way.

**DoD-5 — Planners no longer write a round number.**
The planner prompt in `project-tick.ts` instructs `depends_on`, `workstream` and
`write_set`, and contains no instruction to choose a round. The engine computes
`round` on insert. Guarded by a prompt-content test in `project-tick.test.ts` in
the same shape as the existing prompt assertions.

**DoD-6 — A deploy has landed via `safe-restart.sh` with the fleet quiet, and
the twelve-round measurement shape is reported for a project scheduled by the
new engine.**
Not "it feels faster". The same table as §2 — rounds, tasks per round, run
count, mean run, wall clock — produced by a committed script
(`scripts/measure-schedule.ts`) against a real project, with its own build
identity printed in the output. The improvement is a number or it did not happen.

## 4. Measurable success criteria

| # | Criterion | Measured by | Threshold |
|---|---|---|---|
| S1 | Mean concurrent live runs during a build phase | `scripts/measure-schedule.ts` | ≥ 3.5 (today: 1.75 tasks/round, and rounds do not overlap) |
| S2 | Wall-clock / (sum of run durations) — the parallelism ratio | same script | ≤ 0.45 (today: 255 min wall / ~357 min of run time = 0.71) |
| S3 | Longest stall attributable to numbering | same script: max minutes a `pending` task spent with all of its `depends_on` `done` | 0 min by construction; report it to prove it |
| S4 | Promotion-order divergence between old and new scheduler on the replay fixture | `lib/task-graph.test.ts` | exactly 0 |
| S5 | Fix-chain duplicates after the change | count of `project_tasks` rows sharing `(project_id, chain_key)` | 0, enforced by the 0039 partial unique index, re-proved for namespaced keys |
| S6 | Silent clobbers | files written by two concurrent runs in one worktree without a git conflict | 0 — enforced by the write-set contention belt, tested |

S1 and S2 are the headline. S3 is the one that says the *cause* was removed
rather than merely diluted.

**Note on S2's denominator.** 255 min wall / 21 runs × 17 min mean = 357 min of
run time gives 0.71. That is the ratio to beat, and it is computed from Konrad's
own §1 numbers. The script must recompute both sides from the DB rather than
trusting this paragraph; if the recomputed baseline differs, **the script's
number wins and this line is corrected in the same commit.**

## 5. Non-goals — explicitly out of scope

**N1. No new scheduler process, queue, or service.** The tick stays inside
`executor.ts`'s `managerLoop()`, every ~10s, deterministic code with no LLM in
the loop. This project changes one SQL predicate and adds one pure module. It
does not introduce BullMQ, a DAG engine, Temporal, Airflow, or a second daemon.

**N2. No change to the spawn cap.** `guardrail_rules['agent.spawn_cap']` remains
the single global ceiling (12 as of 2026-08-17). The graph decides what *wants*
to run; the cap decides what *may*. This project does not raise, lower, or
per-project it.

**N3. No auto-merge, ever.** Integration is an explicit task with a reviewer.
Auto-merge resolves conflicts in favour of whoever finishes last, which is
silent clobbering in a new costume. (Spec §3's open question; Konrad's stated
default, and mine. See `02-architecture.md` §7 for the escalation raised on it.)

**N4. No graph *rendering*.** This project makes the edges exist as data and
exposes them on the `/plan` endpoint the Kanban already consumes. Drawing the
node-link view described in `Spec - Manager Chat UI v3` §"Bottom zone" is a
separate project, and `planEdges()` in `forge-control-web/app/desktop/team/planStore.ts`
is already shipped and tested against that future. We feed it real edges; we do
not add `@xyflow/react` or `elkjs` (NFU8 still holds).

**N5. No change to the verdict/consolidation *decision*.** NEEDS_FIXES beats
PASS, exactly one fix chain per group, `chain_key` idempotency, cycles capped at
3. Only the *definition of the group* is restated in graph terms. Every existing
test in `project-reconcile.test.ts` must pass unmodified.

**N6. No retroactive re-planning of live projects.** `operator-visibility`
(8ea0cc08) and anything else in flight keep their round semantics to the end via
the legacy branch of the promote rule (`02-architecture.md` §3.2). This project
does not rewrite a running project's edges.

**N7. No `depends_on` mutation API.** Dependencies are declared at insert and
immutable. A re-plan creates new tasks; it never rewires old ones. This is what
makes the computed `round` stable, which is what keeps migrations 0035 and 0039
sound. (See `02-architecture.md` §2.3.)

**N8. No arbitrary-repo worktrees.** The fixed set stays `ai-os`,
`content-forge`, `scratch`.

## 6. What this unlocks that is not measurable tonight

The quiet prize from the spec's §6: **the task graph Konrad has been asking to
see cannot be drawn today because the edges have never been recorded anywhere.**
They live only in whoever chose the round numbers.

`GET /api/chat/:id/plan` already returns a `deps: string[]` per task. Read
`groupPlanPhases` in `forge-control/src/routes/chat.ts`: it synthesises those
deps as *"every task id in a strictly lower round"* and says so in its own
doc-comment —

> It is COARSE: round 306 genuinely depends on 305 (same file) but only
> bureaucratically on 101, and the edge set says both. It is nonetheless TRUE —
> no edge here is a lie, only some are uninteresting.

and then names exactly this project as the fix:

> Refining it later (file-overlap, explicit `depends_on` column) changes which
> ids appear in this array and NOTHING about the response shape.

So phase 6 is a one-function change to a shipped, tested contract. The previous
project built the socket. This one supplies the current.

## 7. Standing rules this project inherits

Binding on every task, restated here so no brief has to re-derive them:

1. **Cite by symbol or requirement id**, never a bare `file.ts:170-188`. A line
   number, if genuinely useful, is pinned to a recorded git SHA written beside
   it. **A pin you cannot resolve is a FINDING you report, not a footnote you
   quietly reinterpret.**
2. **Write gates that can be passed.** An unsatisfiable gate teaches reviewers
   that disclose-and-proceed is normal. If you find one, amend it *where it is
   enforced*, in the same commit, with the reasoning inline.
3. **Instruments lie before code does.** Before asserting a pass, ask what would
   have made your instrument report a pass *wrongly*. A harness must print its
   own build identity; a sweep whose probes miss must exit non-zero rather than
   certify itself.
4. **Retire a requirement and its gate clause together**, in one commit,
   explicitly.
5. **Every builder brief names the files it will write.** That set is now
   machine-readable input (`write_set`), not archaeology.
6. **Worktree-only during build phases.** `/opt/forge-ai-os` is never edited
   outside the explicit deploy/verify task. Never `pm2 restart forge-executor`.

## 8. The one thing that must not go wrong

`operator-visibility` (8ea0cc08) is **live right now with agents running**, and
this diff touches executor-loaded code: `lib/project-tick.ts`, `db/projects.ts`,
`lib/workspace.ts`, `executor.ts`. A plain `pm2 restart forge-executor` kills
every run in flight, including the deploy task itself.

Build, test and review in this worktree only. The deploy task (phase 8) is the
single place that touches the live checkout, and it (a) confirms 8ea0cc08 has no
running or pending tasks, then (b) launches

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
```

detached, and **ends the task**. It never waits, never polls, never tails.
