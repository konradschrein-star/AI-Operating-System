# 02 — Architecture: engine-task-graph

Base commit of this corpus: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e`.
All citations are by **symbol name and file path**. Where a line number would
genuinely help it is pinned to that SHA and written beside it.

---

## 0. Recommendation first

**Keep `round` as a stored, immutable integer. Strip it of scheduling
authority, not of existence. Add `depends_on` as the ordering truth, `workstream`
+ `write_set` as the contention truth, and compute `round` on insert so no
planner ever chooses one again.**

The design spec §2 says *"`round` stops being an input. It survives as a derived
value — longest-path depth from the roots."* I am implementing the intent and
departing from the mechanism, and the departure is the single most important
decision in this document, so it goes first.

**Why.** `round` is not only a scheduling input. It is load-bearing in four
other places, and two of them are unique indexes:

| Consumer | Symbol / artefact | What breaks if `round` is recomputed on read |
|---|---|---|
| Task identity | `project_tasks_identity_idx (project_id, round, role, title)` — migration 0035 | A value that changes as the graph grows cannot sit in a unique index. The 409 idempotency that stops an architect's re-issued curl from fanning out duplicate agents into one worktree dies with it. |
| Fix-chain idempotency | `chainKeys(round, cycle)` → `project_tasks_chain_key_uniq` — migration 0039 | A replayed consolidation would compute a *different* key, miss its own chain, and insert a second one. That is bug 1 of the engine's first night, reborn. |
| Fix-chain arithmetic | `createFixChain` inserts the builder at `round + 1` and re-checkers at `round + 2` | You cannot write a derived column. |
| The shipped Kanban | `groupPlanPhases` in `routes/chat.ts`, `PlanPhaseGroup` in `forge-control-web/app/desktop/team/planStore.ts` — phase blocks are `floor(round / 100) * 100` | Depth-from-roots collapses 1290…1350 into 0…12 and the entire phase view becomes one block. |

Making `round` derived means putting a recomputable value inside two unique
indexes whose whole purpose is to survive replay. That is not a refactor; it is
the removal of the property.

**The design that satisfies both.** `round` is *engine-written* and *stable*:

```
round = 1 + max(round of the tasks named in depends_on)      # deps present
round = 0                                                     # no deps
round = <as supplied>                                         # caller named it
```

Because `depends_on` may only name **already-existing** tasks (R27) and is
**immutable** (R29), the value is fully determined at insert and can never
change afterwards. It *is* depth-from-roots — measured in the units the rest of
the system already speaks, and offset by whatever block the architect seeded.
The architect still writes exactly one number per phase (`round: k*100`), which
is a **label**, not a schedule: it seeds the block so phase 2's subtree lives in
201…, phase 3's in 301…, which simultaneously keeps the Kanban's hundreds-blocks
alive and keeps `chain_key` unique across phases.

**Planners never write a round again**, which is what Konrad actually asked for.

*Rejected alternatives, one line each:*
- **Derive `round` on read** — puts a recomputable value in two unique indexes; destroys 0035 identity and 0039 replay safety.
- **Drop `round`, key identity on `(project, role, title)`** — a legitimate re-run of the same title in a later phase becomes an accidental 409, and every historical row's identity changes under it.
- **Add a fourth column `phase` and let `round` become true depth** — works, but costs a column, a migration to backfill it, four more consumers to update, and buys nothing the `k*100` block seeding does not already give.
- **Keep `round` hand-written and merely stop gating on it** — leaves the planner choosing numbers, which is the habit the whole project exists to break.

**This is a preference/design decision the brief did not settle, so it is
escalated** — see §9. The default, if Konrad does not answer, is the design
above, and it is what phases 1–8 are planned against.

---

## 1. Components

Nothing new runs. One new module, three new columns, four modified files.

```
executor.ts  managerLoop()  ── every ~10s ──▶  projectTick()          [unchanged shape]
                                                    │
        ┌───────────────────────────────────────────┼────────────────────────────┐
        ▼                       ▼                   ▼                            ▼
promoteReadyTasks()      spawnTaskRuns()   reconcileSettledTasks()     closeFinishedProjects()
   [db/projects.ts]      → claimReadyTasks()   → consolidateVerdictGroup()   [unchanged]
        │                       │                   │
        │                       │                   └── lib/project-reconcile.ts
        │                       │                        + group key gains workstream (R40)
        │                       │                        + chainKeys namespaced (R41)
        │                       │
        │                       └── lib/workspace.ts
        │                            + provisionWorkstream() (R32–R35)
        │
        └──────────────── lib/task-graph.ts  ◀── NEW, pure, no I/O
                          readiness · depth · cycles · contention · groups
```

### 1.1 `lib/task-graph.ts` — new, pure

Every scheduling **decision** as a synchronous function over plain objects. It
follows `lib/project-reconcile.ts`'s discipline exactly, including the
`import type` rule ("a value import would drag the pg pool into the test
process"). That is what lets the replay proof (R18) run under `tsx --test` on a
host with Postgres stopped.

Exported surface:

```ts
export type DepsField = string[] | null;            // null = legacy sentinel

export interface GraphTask {
  id: string;
  round: number;
  workstream: string;
  status: TaskStatus;         // import type only
  depends_on: DepsField;
  write_set: string[];
}

/** Legacy rule, extracted verbatim from today's promoteReadyTasks(). */
export function legacyRoundReady(task: GraphTask, all: readonly GraphTask[]): boolean;

/** Graph rule. Throws GraphIntegrityError on a dangling dep (R14). */
export function graphReady(task: GraphTask, byId: ReadonlyMap<string, GraphTask>): boolean;

/** Which rule applies to this row. The ONLY place the sentinel is interpreted. */
export function readyRule(task: GraphTask): "graph" | "legacy";

/** Longest path from the roots. Total: a legacy row contributes its own round. */
export function taskDepth(all: readonly GraphTask[]): Map<string, number>;

/** round = 1 + max(dep.round), or 0. Pure; the API's only round writer. */
export function computeRound(deps: readonly GraphTask[]): number;

/** null when acyclic; otherwise the offending path, oldest node first (R25). */
export function findCycle(
  candidate: { id: string; depends_on: string[] },
  byId: ReadonlyMap<string, { id: string; title: string; depends_on: DepsField }>,
): Array<{ id: string; title: string }> | null;

/** Exact-path intersection. Empty sets never conflict (R17). */
export function conflicts(a: readonly string[], b: readonly string[]): boolean;

/** Contention belt: which of `ready` may be claimed given `running` (R16). */
export function selectClaimable(
  ready: readonly GraphTask[],
  running: readonly GraphTask[],
): GraphTask[];

/* RETIRED, round 221 (phase 4B), in the commit that wrote the real function and
   deleted the stub and both census entries that named it (standing rule 4).

   `groupKey()` (R40) is NOT exported from task-graph.ts. It lives in
   `lib/project-reconcile.ts`. Round 102 found the contradiction — §10 of
   04-phases assigns R40 to project-reconcile.ts, so nobody was ever going to
   fill this stub and every caller would have met a throw — and the round-221
   planner re-checked the tree for a graph-side consumer of a group key and
   found none. The ruling: the EXPORT was the mistake, not the phase map. The
   group key is a consolidation concern and all three of its terms are already
   in project-reconcile.ts's hand; exporting it from the graph module bought a
   cross-module dependency and no caller.

   Its signature there is unchanged — `groupKey(t: Pick<GraphTask, "round" |
   "workstream">): string` — and it imports `GraphTask` as a type, so the
   dependency runs one way and no cycle is closed. */

/** Path normalisation + validation for write_set entries (R28). */
export function normaliseWritePath(raw: string): string;   // throws on violation
export function validateWorkstream(raw: string): string;   // throws on violation

export class GraphIntegrityError extends Error {}          // R14 — its own class
export class GraphValidationError extends Error {}         // R23/R24/R28 — refused caller input
```

`GraphIntegrityError` is its own class for the same reason `RoleFileParseError`
in `project-tick.ts` is: the caller must distinguish a corrupt graph from an I/O
failure, and a test must assert on the class rather than on message text.

`GraphValidationError` was **added in phase 3** (round 211, in the commit that
implemented `computeRound`, `findCycle` and the two validators) because the route
has to map two kinds of throw to two different statuses and cannot do it on
message text: a `GraphIntegrityError` means the graph already stored in the
database is corrupt (R14) and is a `500`, while refused caller input — R24's
block overflow, R28's write paths and workstream names — is a `400` naming the
offending value. One class for both would answer `400` for a corrupt stored
graph, blaming the caller for the one failure that is certainly not theirs.

### 1.2 Modified files, and what each owns

| File | Owns after this change |
|---|---|
| `db/projects.ts` | The two SQL predicates (promote, claim), the new columns in `TASK_COLS`/`TASK_COLS_PT`, `createTask`'s new fields, `createFixChain`'s graph fields, `unwedgeProject`'s group selection. **No decisions** — every decision is in `task-graph.ts` or mirrored from it, with the mirror stated in the doc-comment, exactly as `markVerdictTaskDone` mirrors `verdictMemberSettled` today. |
| `lib/workspace.ts` | Worktree and branch naming per workstream; provisioning idempotency; teardown of all workstreams. |
| `lib/project-reconcile.ts` | Group key and chain-key namespacing. **The decision logic is untouched.** |
| `lib/project-tick.ts` | Prompts; the workstream-aware spawn path; log lines. |
| `routes/projects.ts` | Request validation and the 400s. Calls `task-graph.ts` for every rule. |
| `routes/chat.ts` | `groupPlanPhases` reads real edges. |

`executor.ts` is **not modified**. It already takes the child's cwd from
`run.metadata.workspace_dir`; a workstream worktree is just a different string.
That is worth stating because the brief lists `executor.ts` among the
executor-loaded files this diff touches — after this design, it does not.

---

## 2. Data model

### 2.1 The four columns

```sql
-- db/migrations/0042_task_graph.sql
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS depends_on uuid[];              -- NULL default
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS workstream  text  NOT NULL DEFAULT 'main';
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS write_set   text[] NOT NULL DEFAULT '{}';
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS graph_frozen boolean NOT NULL DEFAULT false;
```

**THE FOURTH COLUMN JOINED IN ROUND 242 (R71, E4 §9.3).** `graph_frozen` is the
PROVENANCE of `depends_on`: `true` on exactly the rows whose closure the backfill
below wrote, set by that same `UPDATE`, and `false` — the default — on every row
any engine wrote itself. It is what lets §3.2's straddle term ask "was this
closure derived from a round number, or declared?" instead of guessing from a
shape. Round 223 measured four ways of inferring it after the event and all four
failed (§9.3); recording it costs one additive statement and, on a project
planned after the restart, exactly nothing (probe 3b of
`check-r69-straddle.sh`). It is not a second sentinel: `depends_on` still selects
the RULE, and this describes where the array came from.

`ADD COLUMN IF NOT EXISTS` on all four — required by `migrations.test.ts`'s
lint and by the fact that there is no migration ledger in this repo: applying a
migration is a manual `psql -f`, so re-application must be a no-op rather than
an error.

The workstream CHECK is added as a separate, guarded statement (Postgres has no
`ADD CONSTRAINT IF NOT EXISTS`, so it goes in a `DO $$ … $$` block that tests
`pg_constraint` first — the same shape `migrations.test.ts` already exempts
`CREATE TYPE` for).

### 2.2 `depends_on` is nullable, and that is the point

| Value | Meaning | Scheduling rule |
|---|---|---|
| `NULL` | Never graph-scheduled. Written by the **old** engine, or by any INSERT that does not name the column. | Legacy: promote when no strictly-lower round of this project holds a non-`done` task. |
| `'{}'` | Graph-scheduled, explicitly a **root**. | Promote immediately. |
| `'{a,b}'` | Graph-scheduled with predecessors. | Promote when `a` and `b` are `done`. |

The brief specifies `default '{}'`. **I am recommending `default NULL`, and the
reason is a concrete deploy race:**

Migration 0040 must be applied *before* the executor restarts (R8, R64) —
purely additive, invisible to the running old engine, exactly like 0039. But the
old engine keeps working in the gap between `psql -f` and the restart, and it
creates rows: fix chains from `createFixChain`, tasks from architect and planner
curls. Those INSERTs do not name `depends_on`, so they take the column default.

- With `default '{}'`, every such row is born a **graph root**. The moment the
  new engine loads, it promotes all of them at once, ignoring the rounds they
  were numbered into. On a live project mid-fix-cycle, that releases a re-review
  before its fix builder has run.
- With `default NULL`, every such row is born **legacy** and keeps the round
  semantics it was created under, forever, correctly, with no timing window at
  all.

The nullable default converts a deploy race into a non-event. It also makes the
retirement clean: when no `depends_on IS NULL` rows remain, the legacy branch and
its tests are deleted in one commit (NF6, standing rule 4), marked today by
`TODO(R12-retire)` at each site.

*Rejected:* `default '{}'` plus a re-run of the backfill immediately before the
restart — `safe-restart.sh` is detached and waits for an idle fleet, so there is
no moment the deploy task can sequence "after quiet, before load". The race
cannot be closed from the deploy side.

### 2.3 Why the computed `round` is stable

Three properties, together:

1. `depends_on` may only name tasks that already exist (R27, enforced at the
   API with a `400`).
2. `depends_on` is never updated after insert (R29, enforced by review and by
   there being no route that writes it).
3. `round = 1 + max(dep.round)` reads only already-frozen values.

Therefore every task's `round` is decided once, at insert, from values that can
no longer change. It is safe inside `project_tasks_identity_idx` and safe as the
input to `chainKeys()`.

The one way for the **engine** to break this is a "re-plan" feature that rewires
an existing task's dependencies. **Don't.** A re-plan creates new tasks. This is
written into N7 as a non-goal so a future project has to argue with it rather
than discover it.

#### 2.3.1 The operator with `psql` is outside all three properties — observed

Stability above is a property of the *engine*, not of the *database*. Observed
during this very planning round, 2026-08-17 ~03:31:

- The scout task `e7548096-a914-473e-9c3c-e0b96e926f04` was created by
  `POST /api/projects/:id/tasks` at **round 699** — the API answered `201` with
  that value, and a listing taken immediately afterwards showed `r699`.
- A listing minutes later showed the same task id at **round 100**.
- Its `updated_at` is byte-identical to its `created_at`.

What is **proved**: something outside the engine changed `project_tasks.round`,
and it did not set `updated_at`. `grep -n "SET round" ` over the deployed tree
at `/opt/forge-ai-os` returns nothing — **no code path in this system writes
`round` after insert.** What is **not proved**: who. A bare
`UPDATE project_tasks SET round = 100 WHERE id = …` from a psql prompt matches
every observation, and hand-renumbering is the exact operator move the design
spec §1 describes Konrad performing ("renumbering five builders by hand took
live runs from 1 → 6 instantly"). It is the most likely explanation and it is
not the only one. Recorded as an observation, not a conclusion.

Three consequences, and they are not symmetric:

1. **`round` is not immutable in practice, only in code.** §2.3's three
   properties hold against every path the engine has; they hold against nobody
   with a database client. Any argument in this corpus that leans on stability
   must lean on it only for engine-written values.
2. **A hand renumber can already fork a fix chain, today, before this project
   changes anything.** `chainKeys(round, cycle)` is computed from the round at
   consolidation time. Renumber a task after its chain exists and a replayed
   consolidation computes a *different* key, misses its own chain, and inserts a
   second one — bug 1 of the engine's first night, reachable by hand. This
   project does not create the hazard and does not fix it; it inherits it. It is
   added to phase 4's red-team attack list so it is at least *known* rather than
   discovered at 3am.
3. **After this project, renumbering stops working, which is the dangerous
   part.** Today an operator renumbers to buy concurrency and it works
   instantly. Once `round` no longer gates, the same action has **no scheduling
   effect at all** — while still silently drifting `round` away from depth,
   breaking the Kanban's hundreds-block grouping and exposing consequence 2. An
   operator who reaches for the old lever will find it disconnected and may pull
   harder.

   Mitigation, and it is deliberately documentation rather than code: this is
   the *point* of the project — after it lands there is no longer a reason to
   renumber, because the graph already grants the concurrency the renumbering
   was buying. Phase 5's prompt work and the phase-8 report both say so
   explicitly.

#### 2.3.2 Why there is no immutability trigger — the reasoning, not just the decision

Enforcing `round` immutability in the database — a trigger, a rule, a
`CHECK` — is **rejected**, and the reasoning is recorded at Konrad's explicit
request because it outlives the decision.

The invariant is already respected by every path that has an opinion. No engine
code writes `round` after insert (`grep -n "SET round"` over the deployed tree:
nothing). So a trigger would defend the invariant against exactly one actor: the
operator at a psql prompt. That actor is not the adversary. He is the person who
unwedges this system at 3am, and tonight he was using the renumber as the only
concurrency lever the engine gave him — which is the observation that produced
this whole project.

A trigger would therefore buy protection against a failure mode that has never
fired, and pay for it by removing the escape hatch the operator uses when the
engine is the thing that is broken. That is the wrong trade in a single-operator
system: **operability beats invariant purity, and a guardrail that fires only on
the human holding the fire extinguisher is a guardrail pointed the wrong way.**

The correct mitigation is that after this project there is no longer a *reason*
to renumber, because the graph grants the concurrency the renumbering was buying.
Remove the motive, not the capability.

If this is ever revisited, the argument to beat is not "round should be
immutable" — it is "the operator now has a better lever than psql, and here it
is."

#### 2.3.3 Operator confirmation and the evidence, 2026-08-17

Konrad confirmed the renumber on the record: a bare psql `UPDATE`, applied to
scout `e7548096` here and to roughly a dozen `pending` tasks on
`operator-visibility` tonight, promoting non-contending work into the live round
after grepping briefs for write-sets. (That grep is the manual version of
`write_set`; R5 exists to replace it.)

He checked the §2.3.1 consequence-2 exposure before answering rather than
assuming innocence, and the result narrows phase 4's attack usefully:

```sql
select project_id, chain_key, count(*) from project_tasks
 where chain_key is not null group by 1,2 having count(*)>1;    -- EMPTY
```

- **No duplicate chain within any project.** Collisions on `fix:1:1` /
  `rereview:1:1` exist only *across different projects*, which the partial unique
  index on `(project_id, chain_key)` permits by design — that is the index doing
  its job, not a near miss.
- `operator-visibility`'s fix chains sit at rounds 1305/1306, 808/809, 705/706,
  606/607 — **none of them in a round he touched.**
- Every renumbered task was `pending`, with no run and no chain.

So the defect is real and was not fired. **That is luck plus a habit, not a
guarantee** — which is precisely why it stays on phase 4's red-team list rather
than being closed. Konrad's ruling, recorded so a later round does not reopen it:
it is a pre-existing defect, out of this project's scope, owned by phase 4's red
team with an instruction to report the answer either way. **A later round must
not quietly fold it into a fix.** A known bug with a named owner is worth more
than an unscheduled repair.

### 2.4 `write_set`

Repo-relative POSIX paths, normalised at the API (`normaliseWritePath`), stored
sorted and de-duplicated. Exact string equality decides intersection — a
directory prefix does not count. "Declaring `src/` to own a subtree" is
deliberately unsupported: prefix semantics invite a task to declare `.` and
serialize the whole project by accident, and the failure would be silent
under-parallelism, which is the disease.

---

## 3. Scheduling

### 3.1 Readiness, in SQL

`promoteReadyTasks()` becomes one statement with two labelled branches:

```sql
UPDATE project_tasks pt
   SET status = 'ready', updated_at = now()
  FROM projects p
 WHERE p.id = pt.project_id
   AND p.status = 'active'                        -- E7/R8/R13: unchanged, load-bearing
   AND pt.status = 'pending'
   AND (
     -- GRAPH BRANCH
     (pt.depends_on IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM project_tasks d
                       WHERE d.id = ANY(pt.depends_on) AND d.status <> 'done')
      AND (SELECT count(*) FROM project_tasks d WHERE d.id = ANY(pt.depends_on))
          = cardinality(pt.depends_on)            -- R14: no dangling dep may satisfy
      AND NOT EXISTS (SELECT 1 FROM project_tasks l   -- R69, E3/E4: the straddle term
                       WHERE l.project_id = pt.project_id
                         AND (pt.graph_frozen OR l.depends_on IS NULL)  -- R71, E4
                         AND l.round < pt.round
                         AND l.status <> 'done'))  -- TODO(R12-retire)
     OR
     -- LEGACY BRANCH  TODO(R12-retire)
     (pt.depends_on IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_tasks earlier
                       WHERE earlier.project_id = pt.project_id
                         AND earlier.round < pt.round
                         AND earlier.status <> 'done'))
   )
 RETURNING pt.id
```

The cardinality equality is R14's front half: it stops a vanished dependency
from reading as satisfied. Its back half is a separate sweep in the same tick
that moves such a task to `blocked` and notifies — because a task silently stuck
at `pending` forever is the failure mode this project is trying to end, and
merely *not promoting* it would produce exactly that.

Both branches are in **one** statement so a row can never satisfy neither. Two
statements would leave a window in which a row whose `depends_on` flipped
between them is skipped by both.

The **straddle term** (R69) is the graph branch's only reference to `round`, and
it reads it only about rows whose ordering no closure could have expressed. §3.2
is why it is there. Its disjunct has two sides and they are asymmetric on
purpose:

- **`pt.graph_frozen`** — a candidate whose closure the MIGRATION derived is held
  behind any non-`done` lower-round row, whoever wrote that row. Its closure was
  computed against a snapshot, so "every dep is done" is a statement about a task
  list that no longer exists; its round is the only ordering it ever declared.
- **`l.depends_on IS NULL`** — a candidate that declared its own dependencies is
  held only behind rows created under the OLD semantics, which never had the
  chance to declare anything.

On a project planned entirely after the restart, no row is frozen and no row is
NULL, both sides are false, and `round` is never consulted — measured at 3 ticks
/ 8-wide against the same widening ungated at 17 / 1-wide (probe 3b). It is part
of the legacy surface and is deleted with R12's branch in one commit (NF6,
standing rule 4), when no NULL and no frozen row remains.

### 3.2 The legacy branch is the migration strategy

There is no flag day and no engine-version switch. The behaviour of a row is
decided by its own data — **by the semantics it was created under**. A row that
existed before the migration, or that the OLD engine wrote after it, finishes
under the old rule; a row the NEW engine creates is scheduled by the graph; and
**a project in flight when the new engine loads finishes under its original
semantics**.

**NARROWED IN ROUND 223, RESTORED IN ROUND 242, and the round trip is the
point.** Through round 222 the last clause above was asserted on a term that did
not deliver it: R69 held a frozen row behind LEGACY rows only, and a fix chain
the new engine creates after the restart is not one (§3.2.2, F14). Round 223
retired the sentence rather than leave a claim the engine did not keep, ruled
option B on measurement, and named the single change that would make the wider
claim true — *record which closures the migration wrote*. Round 242 made it:
`graph_frozen` (R71, §2.1), written by the backfill itself, gating the straddle
term. The sentence is therefore back, and it is back as a MEASUREMENT: the
shipped engine now reproduces today's schedule on the straddling fixture tick for
tick, 17 ticks, no first divergence (`check-r69-straddle.sh` probe 1b), and
clearing the marker or deleting the term brings the divergence back at tick 2 on
the two rows §3.2.1 names (probes 1 and 1c). §9.3 carries the ruling, the four
inferences that failed, and why the recorded fact beats all of them.

#### 3.2.1 A straddling project needs one more term — the frozen closure (F13, E3)

**Corrected in round 106.** This section previously ended "…and each is
correct". That was wrong, and round 105's reviewer proved it. The correction is
recorded here rather than quietly rewritten, because the claim had already been
relied on.

`depends_on` is a **frozen** value. The backfill (R6) writes the closure of the
rows that exist *at the instant 0040 runs*. Today's rule is evaluated
continuously against the *current* task set. Those are only the same thing if
the task set stops changing — and R64 applies 0040 **before** the restart, after
which `safe-restart.sh` waits up to 43200 s for a quiet fleet. Through that
whole window the old engine keeps inserting rows: `createFixChain` puts a fix
builder at `round + 1` and a re-reviewer at `round + 2`, and its `INSERT INTO
project_tasks` names its columns explicitly without `depends_on`, so both are
born `NULL` (E2, §2.2). **No frozen closure names them**, because they did not
exist when the closures were computed.

Concretely, on the deploy's own target. `operator-visibility`'s highest `done`
reviewer sits at round 1306, so a `NEEDS_FIXES` reconciled in the window puts a
chain at **1307/1308** — strictly below its three `running` rows at 1350 and all
eight `pending` rows at 1352–1870. After the restart the two `pending` rows at
1352 take the graph branch, whose frozen closure contains only rows that are
`done` or `running` at capture. Those settle in one tick, and without a further
term the pair promotes on tick 2 while the fix builder at 1307 has not run.
Today's engine holds them until the chain drains. A late-phase builder running
ahead of an early-round fix chain is the same class of failure the NULL sentinel
exists to prevent, reached from the other side.

This was measured, not argued: filling `graphReady`/`readyRule` in a scratch
copy with a closure-only graph branch leaves R18 cases (a)–(e) green and case
(f) diverging on **tick 2** — *legacy promoted [], graph promoted [511070c9…,
608dbecb…]*. Adding the term makes all six agree. The transcript is in
`evidence/phase1-migration.md` §13.4.

So: **a graph row is also not ready while any legacy row of the same project in
a strictly lower round is not `done`** (R69, §3.1). With it, each kind of row in
a straddling project is correct **for every row created under the old
semantics**. Both directions are covered — a legacy row already waits on frozen
rows below it, because R12's branch scans by round without looking at
`depends_on`.

**AMENDED ROUND 223, AMENDED AGAIN ROUND 242.** This paragraph used to end *"and
the sentence this section used to end on becomes true"*, meaning §3.2's claim
about the whole project. Under R69 as round 106 landed it that was false, and
§3.2.2 is where round 223 said so: the term closed F13 — rows the OLD engine
inserts in the deploy gap — completely, and nothing about rows the NEW engine
inserts afterwards. Since round 242 the term reads `graph_frozen` rather than the
blocker's sentinel, so both hazards close under one predicate and §3.2's sentence
is true again. The two hazards are still not the same hazard; what changed is
that the candidate's own provenance answers for both.

*Rejected — move the backfill to a quiet fleet.* §2.2 already closed this: the
restart is detached and self-timed, so the deploy task has no moment to sequence
"after quiet, before load". Adding a pre-restart hook to `safe-restart.sh` would
not close it either — "quiet" is 45 s without a heartbeat, and a project tick
can fire between the quiet check and the restart. The term needs no timing
argument at all, which is why it wins.

*Rejected — accept the divergence and document its blast radius.* The project's
central claim is that the migration is an exact replica (R18, DoD). A divergence
that is reachable on the very project we deploy against is not a footnote.

#### 3.2.2 What R69 did not close, and what closed it (rounds 223, 242)

R69 as round 106 landed it tested `depends_on IS NULL` — a property of the
BLOCKING row. R42 gives a fix chain created by the **new** engine real graph
fields, so a row the new engine inserts below a frozen row was invisible to the
term, and the frozen row promoted where today's engine holds it. Phase 1 found
this, read it as intended DAG behaviour, and correctly declined to fix something
outside its phase; it flagged that §3.2's sentence was wider than what R69
delivered. Round 223 settled it by experiment —
`scripts/checks/check-r69-straddle.sh`, transcript in
`evidence/phase4-workstreams.md` §5 — ruled option B, and priced the one change
that would let option A be taken. Round 242 took it (§9.3, `evidence/…` §11).

**THE DIVERGENCE WAS REAL, AND IT WAS THE SAME DIVERGENCE F13 NAMES.** Fed the R9
fixture with every row frozen and a post-restart chain at 1307/1308, the engine
before round 242 and today's engine part company on **tick 2**, on **`511070c9…`
and `608dbecb…`** — the identical two rows, on the identical tick, that §3.2.1
records for the closure-only measurement. Only the provenance of the blocking row
differed: a NULL sentinel there, real graph fields here. Today's rule takes 17
ticks; that engine took 14.

**WHAT CLOSED IT.** One additive column (R71) and one disjunct. `graph_frozen` is
`true` on exactly the rows 0040's backfill wrote, set by the same `UPDATE`, so
the term can key on the CANDIDATE's provenance instead of the blocker's: a row
whose closure was derived is held behind any non-`done` lower-round row, and a
row that declared its dependencies is not. Measured both ways rather than
asserted:

| probe | reading |
|---|---|
| 1b — the straddle, with the marker | legacy 17 ticks / 10 promoted, shipped **17 / 10**, first divergence **NONE** |
| 1 — the marker cleared (the pre-242 schema) | diverges at **tick 2** on `511070c9…`, `608dbecb…`; 14 ticks against 17 |
| 1c — R69's disjunct DELETED from a copy of the module | the same divergence, on the same tick, on the same rows — and identical to the marker-cleared arm on all three fixtures |
| 3b — a project planned entirely after the restart | **3 ticks / 8-wide**, byte-identical to the engine before the column existed; the same widening ungated is 17 / 1-wide |

**WHY THE MARKER AND NOT A CLEVERER PREDICATE.** Round 223 built and measured the
four signatures the schema could express and each failed in its own way — the
sentinel gate silent on a straddle with no gap row, the same gate firing on one
only because an unrelated settled row happened to carry NULL,
`isClosureShaped()` blind on 8/8 of the exposed rows the moment the post-restart
row exists, a `created_at` horizon right on the straddle and ruinous everywhere
else. Those measurements still run, on the pre-242 rows, as arms of the same
script: they are the argument for the column, so deleting them would leave the
column asserted rather than justified. §9.3 has the table.

**WHAT REMAINS ACCEPTED.** Nothing of F14. What the marker does NOT do is make a
frozen row's closure complete — it cannot, no closure can name a row that did not
exist — it makes the row's ORDERING complete, by replaying the round rule the row
was born under for as long as it lives. A project with frozen rows therefore
schedules exactly as today's engine schedules it, which is the replica claim
(R18), and gains the graph's concurrency only for rows planned after the restart,
which is where the concurrency was measured to matter (`00-vision.md` §2).

### 3.3 The backfill must be the full closure, not the previous round

The brief says *"every task in round N depends on every task in round N-1"*.
Two problems, both real:

**Rounds are sparse.** `operator-visibility` runs 1290, 1291, 1292, 1293, 1300,
1301… — "N−1" has to mean "the immediately preceding round that has tasks", or
1300's tasks get no dependencies at all and become roots.

**Previous-round-only is not an exact replica under retry.** Today's rule is
"*every* strictly lower round is done", not "the previous one is done". Take
rounds 1290, 1291, 1292: suppose 1291 and 1292 have run, and an operator retries
a failed task in 1290 back to `ready`. A task added to 1292 is, under today's
rule, **not** promotable (1290 holds a non-`done` task). Under a
previous-round-only backfill it depends only on 1291, which is `done`, so it
promotes. Divergence — and `retryTask()`/`unwedgeProject()` make it reachable,
not theoretical.

So the backfill writes the **transitive closure**: for each task, the ids of
every task of the same project in a strictly lower round.

```sql
UPDATE project_tasks pt
   SET depends_on = COALESCE((
         SELECT array_agg(e.id ORDER BY e.round, e.created_at, e.id)
           FROM project_tasks e
          WHERE e.project_id = pt.project_id
            AND e.round < pt.round
       ), '{}'::uuid[])
 WHERE pt.depends_on IS NULL;        -- R2: second application is a zero-row no-op
```

Cost: `operator-visibility` has ~124 tasks; the widest row carries ~120 uuids.
That is nothing. It is provably exact, which is what the replay test needs it to
be. The ordering inside `array_agg` is fixed so the backfill is deterministic and
its output diffable between two applications.

*Rejected:* previous-non-empty-round only — smaller arrays, diverges under
retry, and the divergence would be found by the replay test anyway (case R18-b),
so it costs a round to discover what can be decided now.

### 3.4 Claiming, and computed contention

`claimReadyTasks()` keeps its transaction, its `FOR UPDATE OF pt SKIP LOCKED`
(which locks only task rows — a bare `FOR UPDATE` would also lock the joined
`projects` row and make every claim contend with any concurrent status flip),
its `p.status = 'active'` join, and its in-transaction flip to `running`.

Two changes:

1. **Ordering.** `ORDER BY pt.round ASC, pt.created_at ASC` stays — it is
   stable, and under computed rounds it now genuinely means "shallower first".
2. **Contention belt.** The claim now also selects the project's currently
   `running` tasks, and `selectClaimable()` (pure, in `task-graph.ts`) drops any
   candidate whose `write_set` intersects a running task's, or an
   earlier-in-this-pass candidate's, **within the same workstream**. Dropped
   candidates stay `ready` and are claimed on a later tick.

Two tasks in **different** workstreams never conflict, whatever they write —
that is the entire point of the worktree per workstream.

An empty `write_set` intersects nothing (R17). That is today's behaviour
preserved exactly, and it is why the replay fixture — whose rows all have empty
write-sets — cannot diverge. It is also a permissive default, so it is paired
with a warning per builder spawn and with `metadata.strict_write_sets` (R31) for
new projects, where an undeclared builder write-set is a `400`.

### 3.5 Where concurrency actually comes from

Worth being explicit, because it is easy to over-attribute. Three sources, in
order of size:

1. **Removing the round barrier** (R11). This is the big one. Tonight's five
   builders start together instead of queueing behind a 32-minute reviewer.
2. **Worktrees per workstream** (R32–R35). This unlocks the cases the round
   barrier was *legitimately* covering — two builders that really do write
   `DesktopApp.tsx`.
3. **Nothing else.** The spawn cap is unchanged at 12, the tick interval is
   unchanged at ~10s, no model or account changes. If the measurement improves,
   it improved because of 1 and 2.

---

## 4. Workstreams and worktrees

### 4.0 Declared write-sets prevent SOURCE conflicts. Only directory isolation prevents ARTIFACT conflicts.

Read this before proposing a shared build directory for speed, because the
argument for one is superficially strong and it is wrong.

A `write_set` is a list of **source files a task intends to edit**. That is what
a planner can know and what R28 can validate, and the contention belt is exact
about it (R16: string equality, no prefix semantics). It is therefore complete
for exactly one class of collision — two agents editing one file — and blind to
every other.

**Nobody declares their compiler's scratch space.** `next build` writes `.next`,
`tsc` writes `tsbuildinfo`, `pnpm` writes `node_modules/.pnpm`, a test run writes
coverage output. None of it appears in any brief, none of it is knowable at
planning time, and all of it is shared the moment two tasks share a directory.
On 2026-08-17 this box hit it twice in one project — operator-visibility rounds
1353 and 1357, `next build` dying on ENOENT with a sibling building against the
same directory — and **both pairs of tasks had entirely disjoint source
write-sets**. Perfect declarations; a collision anyway.

So the two mechanisms are not alternatives and neither substitutes for the
other:

| collision | prevented by |
|---|---|
| two tasks editing `DesktopApp.tsx` | declared write-sets (R16/R17), *within* a workstream |
| two tasks sharing one `.next` | **a separate directory, and nothing else** |

Round 221's builder A priced the isolation rather than hand-waving it; the
numbers — real installs, real disk, and why `du` overstates the cost by ~40× —
are in `evidence/phase4-workstreams.md` §D1 and are deliberately **not restated
here**, so there is one source and no drift.

The consequence for the scheduler is stated at 04-phases Phase 4 deliverable 13
and enforced in the spawn path: **two tasks of the same workstream never run
concurrently.** They share a directory, so the second class of collision is
reachable between them, and the workstream is the unit of parallelism precisely
because tasks placed in one were placed there to contend. Buying concurrency
back inside that unit — with an isolated build dir per task — was considered and
rejected at round 222: it is a second isolation mechanism to reason about, and it
leaves declared write-sets as the only defence *inside* the workstream, which
this section has just shown is insufficient.

### 4.1 Naming — the spec's form does not work

Spec §3 writes the branch as `project/<id>/<workstream>`. Git will not create it
while `project/<id>` exists: refs are files in a directory tree, so
`refs/heads/project/abc123` and `refs/heads/project/abc123/ui` are a file and a
directory at the same path. Verified on this host, 2026-08-17:

```
$ git branch project/abc123
$ git branch project/abc123/ui
fatal: cannot lock ref 'refs/heads/project/abc123/ui':
       'refs/heads/project/abc123' exists; cannot create 'refs/heads/project/abc123/ui'
$ git branch project/abc123-ui
$                                  # exit 0
```

Renaming the project branch to `project/<id8>/main` would make the slash form
legal, but it renames the branch of every live project, which is exactly the
kind of change the deploy is trying not to make.

**Resolution (R33):**

| workstream | branch | directory |
|---|---|---|
| `main` | `project/<id8>` *(the existing branch — unchanged)* | `${PROJECT_WORKTREE_ROOT}/<project-id>` *(the existing directory — unchanged)* |
| `<ws>` | `project/<id8>-<ws>` | `${PROJECT_WORKTREE_ROOT}/<project-id>--<ws>` |

Double hyphen in the directory because a project id contains single hyphens and
the boundary should be unambiguous when a human reads `ls`.

### 4.2 Sibling, not nested

`${PROJECT_WORKTREE_ROOT}/<project-id>/<ws>` would put a worktree *inside* the
main worktree. Git tolerates it; `git status --porcelain` does not ignore it. The
main worktree would report the nested directory as untracked content — and
`git status --porcelain` is the literal input to the reviewer cleanliness gate
(`REVIEWER_LIVE_CHECK` in `project-tick.ts`) and to the deploy task's pre-merge
check. A design that makes the cleanliness gate cry wolf trains reviewers to
ignore it, which is precisely the disclose-and-proceed habit standing rule 2
exists to kill.

### 4.3 Provisioning

`provisionWorkstream(project, workstream)` reuses `provisionWorkspace`'s
race-safety verbatim, because the same two-process race exists (the API route
and the tick can both want a directory at once): look up the worktree first and
return it if present; adopt an existing branch rather than `-b` it; on a failed
`worktree add`, `worktree prune` and re-check before throwing.

Start point for a non-`main` workstream is the **project branch's current tip**,
not `resolveStartPoint()`'s local-vs-origin comparison — that function exists to
pick between a live checkout and a stale origin, which is a question that only
arises for the project branch itself.

Cap: `PROJECT_MAX_WORKSTREAMS = 6` (R39), enforced at task creation with a `400`
naming the count. A full checkout of `ai-os` is not free and a goal project that
fans out 40 teams would fill the disk quietly.

**Where the constant lives — reviewed round 222, and it STAYS in
`routes/projects.ts` behind `lib/workspace.ts`'s dynamic `import()`.** Round 4A
proposed moving it to `lib/task-graph.ts` (the pure leaf both layers already
import statically, and the owner of `validateWorkstream()`/R28) and deferred the
move because phase 4B held that file. Phase 4C is after 4B and did not take it
either, for two reasons, the second of which corrects the first's own record:

1. **Ownership.** The move writes `lib/task-graph.ts` and `lib/workspace.ts`.
   §10 gives `task-graph.ts` to phases 1–3, and phase 4C's brief excludes both
   files by name. Taking it would be a silent write outside a declared set in
   the project whose entire deliverable is computing contention from *declared*
   write-sets.
2. **The stated justification for the dynamic import is not the true one, and
   the difference matters to whoever finally moves it.** 4A recorded that a
   static import of `routes/projects.ts` "would put three pg Pools into
   `pnpm test`", because `lib/project-tick.test.ts` value-imports
   `lib/workspace.ts`. Measured on 2026-08-17 with a counting `pg.Pool`
   subclass: importing **`lib/project-tick.ts` alone constructs 5 pools**, and
   `lib/project-tick.test.ts` value-imports that module for `buildPrompt`, so
   `pnpm test` constructs those 5 pools TODAY, before any of this. Importing
   `routes/projects.ts` on top adds **zero** — its pools are the same
   already-loaded db modules. NF3 is not violated by either, because a `pg.Pool`
   constructs lazily and connects only on the first query: the rule is that
   tests never *touch* a database, and none does.

   So the dynamic import buys nothing measurable in pool count. What it does buy
   is the **import direction**: `lib/` must not depend on `routes/`, and a
   static import would make the leaf module of the workspace layer depend on the
   HTTP layer. That is a real and sufficient reason to keep it, and it is the one
   that should be quoted — a correct decision resting on a measurement that does
   not hold is one audit away from being reversed for the wrong reason.

The clean end state is unchanged: the constant belongs in `lib/task-graph.ts`,
and the phase that owns that file should take it and delete
`maxWorkstreams()`'s dynamic import in the same commit.

### 4.4 Integration — explicit, reviewed, never automatic

Per workstream other than `main`, the planner creates:

```
  … every task of workstream W …
                 │  (depends_on)
                 ▼
  [builder]  "Integrate workstream W"        workstream = main
             write_set = union of W's write-sets
             merges project/<id8>-W into project/<id8> in the main worktree
             ON CONFLICT: stop, report the files verbatim, resolve nothing
                 │
                 ▼
  [reviewer] "Review integration of W"       workstream = main
```

The integration task lives in `main` because that is where the merge lands and
where the conflict must be visible.

**R38's structural definition is now ENFORCED, not merely stated (R70, round
222).** The shape above — an integration task in `main` that depends on every
task of W — was a description of what a planner ought to create. It is now the
predicate the engine closes projects by: `closeFinishedProjects()` refuses to
close a project while some workstream has no `main` task whose `depends_on`
covers all of it, and says so out loud. That is what turns "integration is an
explicit task" from a convention a planner can forget into something the engine
will not let a project finish without. It needs no new column and no naming
convention precisely because the definition above is already structural — see
R70 in `01-requirements.md` for the membership ruling (the integration task and
its reviewer are `main`, so they are never required to depend on themselves) and
for the mutation record.

**There is no auto-merge path anywhere in the tree** (R38, N3). Auto-merge
resolves conflicts in favour of whoever finishes last, which is silent
clobbering wearing a merge commit. The gain of this whole design is not extra
concurrency — it is that **contention becomes a git conflict inside a named task
instead of two agents overwriting each other in one directory.** Git is good at
the former and there is no defence against the latter. Auto-merging would throw
away the only thing bought.

### 4.5 The reviewer's diff base

`buildPrompt`'s reviewer branch tells the reviewer to run
`git diff ${project.base_branch}...HEAD`. In a workstream worktree that shows
every other workstream's merged work as though it were this task's. For a
non-`main` workstream the prompt becomes

```
git diff $(git merge-base project/<id8> HEAD)...HEAD
```

`main` keeps today's form byte-identically.

**Landed round 222 (phase 4C), with the byte-identity taken from history rather
than from the new code.** `buildPrompt()` gained an optional third argument, the
resolved `TaskWorkspace` — the workstream and the branch actually checked out —
which `spawnTaskRuns()` always passes and which nothing else can guess: a
workstream row's branch is not derivable from `project.work_branch`, so omitting
it for a non-`main` task is a refusal, not a default (NF1). Three strings vary on
it: the diff base above, the header's branch, and the builder's "already checked
out". For `main` all three are the bytes commit `4244b20` emitted, and the test
that says so reads that commit out of git and substitutes into ITS template —
because a test that built its expectation by calling the new `buildPrompt()`
again would prove only that the new code agrees with itself.

`WORKTREE_POLICY()` and `REVIEWER_LIVE_CHECK()` are **unchanged in wording**, as
R37 requires, and that is asserted the same way: their bodies are compared
character for character against `4244b20`. `REVIEWER_LIVE_CHECK` in particular
needed no change on inspection either — `git -C <live> status --porcelain` is
about the LIVE checkout, which no workstream worktree touches.

---

## 5. Consolidation, restated in graph terms

The brief's constraint: *preserve the group decision, restate only its
definition.*

**Today:** the group is `(project_id, round)` filtered to `VERDICT_ROLES`
(`listVerdictRound`, `consolidateVerdictGroup`).

**After:** the group is `(project_id, round, workstream)`.

That is the graph-native reading of "the set of reviewers sharing a dependency
join": verdict tasks that depend on the same predecessor set receive the same
computed round by construction (`1 + max(dep.round)`), and the workstream term
separates two teams that happen to sit at the same depth.

Without the workstream term there is a concrete bug: two reviewers at the same
depth in different workstreams would consolidate as one group, produce **one**
merged fix builder — which can only live in one worktree — and the other
workstream's findings would be delivered nowhere. That is a dropped verdict, the
exact silent outcome the whole reconcile module exists to prevent.

### 5.1 Chain keys

`chainKeys(round, cycle)` becomes `chainKeys(round, cycle, workstream)`:

```
workstream === "main"   →  fix:<round>:<cycle>              (byte-identical to today)
                           rereview:<round>:<cycle>
                           retest:<round>:<cycle>
otherwise               →  fix:<ws>:<round>:<cycle>
                           rereview:<ws>:<round>:<cycle>
                           retest:<ws>:<round>:<cycle>
```

The `main` special case is not cosmetic. Every chain written since 0039 carries
the unprefixed form, and a replayed consolidation of one of those rounds must
match the row it already wrote — on `chain_key` *and* on identity. Changing the
string for `main` would make a replay miss its own chain and insert a second one.
The historical `rereview:` prefix is preserved for the same reason it already is.

Existing `chainKeys` test cases must pass **unmodified** (R41, R43). New cases
cover a named workstream.

**AND THE TITLES TOO — round 221, and the chain key alone would have blocked the
project.** `project_tasks_identity_idx` (migration 0035) is
`(project_id, round, role, title)`; migration 0040 added no workstream term.
Two groups at one round therefore write two builders at `round + 1` with role
`builder` and title `Fix cycle 1` — the SAME identity tuple. The second INSERT
conflicts, `insertChainRow` classifies it `occupied`, and consolidation blocks
the project with that workstream's merged feedback undelivered: §5's own
motivating failure, through the other index. So the chain rows' TITLES carry the
workstream on exactly the same terms as the keys:

```
workstream === "main"   →  Fix cycle <n>                        (byte-identical to today)
                           Re-review after fix cycle <n>
                           Re-test after fix cycle <n>
otherwise               →  Fix cycle <n> · <ws>
                           Re-review after fix cycle <n> · <ws>
                           Re-test after fix cycle <n> · <ws>
```

Adding `workstream` to the identity index was rejected: it is a phase-1
migration this phase does not own, and it would change what idempotency means
for every `createTask` caller. The title is already the component that separates
two rows the round and the role cannot.

`FIX_TASK_TITLE` and `RECHECK_TASK_TITLE` take the workstream as an optional
trailing parameter defaulting to `main`, for R43's reason: the existing cases
call them with the old arity and must pass unmodified. Same for `chainKeys` and
`consolidateVerdictRound`. It is a default-for-omitted, not an NF1
fallback-for-invalid.

### 5.2 Fix-chain rows join the graph

`createFixChain` must write the graph fields, or the chain rows are born as
roots and run immediately — in parallel with the very work they follow:

| Row | round | depends_on | workstream | write_set |
|---|---|---|---|---|
| fix builder | `round + 1` | the gating task ids | the group's | union of the reviewed tasks' write-sets |
| each re-checker | `round + 2` | `[fix builder id]` | the group's | `{}` |

`round + 1` / `round + 2` remain literal because the group's round is a real
stored value, and `1 + max(dep.round)` yields the same numbers anyway — the
arithmetic and the rule agree, which is worth asserting in a test rather than
assuming.

**Asserted, round 221, and the assertion found the exception.** They agree
everywhere `computeRound()` has an answer, and disagree only where it has none:
at the last two rounds of a phase block, R24's 99-level cap makes `computeRound`
REFUSE where the literal answers 100. The chain is still created — promotion is
by `depends_on`, so only the Kanban's phase label moves, and refusing would
wedge a real fix cycle to protect a numbering convention. Recorded with its
reachability argument in R42; the cases are `T23`'s two boundary tests.

The row descriptors are computed by `fixChainGraphFields()` in
`lib/project-reconcile.ts` and handed to `createFixChain` as `input.graph`,
rather than assembled inside the DB module — one definition for the rounds, the
edges and the write-set union, and a shape test that needs no database. The
builder's `depends_on` is deduped and sorted, which does three jobs: it makes
the row byte-identical across replays, it makes R41's set comparison
well-defined, and it is the immutable identity R41's guard leans on.

### 5.3 Everything else is untouched

`verdictMemberSettled`'s three-term rule and its two SQL mirrors
(`markVerdictTaskDone`, `unsettledVerdictTasks`) — untouched, term for term.
Decision order (a)…(e) in `consolidateVerdictRound` — untouched. `MAX_FIX_CYCLES
= 3` — untouched. `mergeFeedback`'s verbatim-quoting — untouched.
`insertChainRow`'s three-way conflict classification (`created` / `replay` /
`occupied`) — untouched, and it is what will catch a chain-key mistake if this
design is wrong.

---

## 6. Failure modes

Every one of these must be **loud**. NF1 forbids the silent variants.

| # | Failure | Detection | Behaviour | Konrad sees |
|---|---|---|---|---|
| F1 | Dangling dependency (dep row deleted) | cardinality check in the promote sweep (R14) | Task → `blocked`, project → `blocked` | `🚫 Project "X" — task "T" names N dependencies that no longer exist: <ids>` |
| F2 | Cycle inserted | `findCycle` at the API (R25) | `400`, nothing written | The 400 body naming the path; the planner reads it and retries |
| F3 | Cross-project / non-existent dep id | existence + project check (R27) | `400`, nothing written | The 400 body naming the ids |
| F4 | Two workstreams collide on a chain key | `insertChainRow` → `occupied` (existing) | Project `blocked`, merged feedback **not** silently dropped | The existing `🚫 … already occupies it` push, naming the row |
| F5 | Worktree add fails / disk full | `provisionWorkstream` throws | `spawnTaskRuns`'s catch: task `failed`, project `blocked`, push | `🚫 Project "X" blocked — could not start builder task "T": <git stderr>` |
| F6 | Workstream cap exceeded | count at task creation (R39) | `400` naming the count and the limit | The 400 body; planner reduces the fan-out |
| F7 | Integration merge conflict | non-zero `git merge` exit inside the integration task | Task reports the conflicting files and **stops**. No resolution, no `-X ours`, no `--strategy` | The task's report, and its reviewer's verdict |
| F8 | Undeclared write (builder wrote outside its `write_set`) | reviewer gate (R57): `git log --name-only` vs `write_set` | `NEEDS_FIXES` finding | The reviewer's numbered list |
| F9 | Legacy row promoted by the graph branch (sentinel confusion) | replay test (R18) at build time; column comment at runtime | Caught before deploy | — |
| F10 | Migration applied twice | R2's guards | Zero-row no-op | Nothing, correctly |
| F11 | A group never drains (all deps done, task never promoted) | `measure-schedule.ts`'s S3 metric reports a non-zero numbering stall | Reported as a number | The measurement table |
| F12 | Consolidation throws repeatedly | existing `noteGroupFailure` / `MAX_GROUP_FAILURES = 3` | Escalated once at the threshold | The existing `🚫 … frozen` push |
| F13 | **Frozen closure outruns a post-migration row.** A row the old engine inserted between `psql -f 0040` and the restart is named by no frozen closure, so a backfilled row promotes past it (§3.2.1) | R18 case (f) at build time; the legacy-row term (R69) at runtime | The graph branch holds the row until every lower-round legacy row is `done` | Nothing — it does not happen. Without R69 Konrad would have seen a phase-18 builder run before a round-8 fix chain, with no error anywhere |
| ~~F14~~ | **RETIRED ROUND 242 — the condition cannot occur.** F14 recorded that a frozen closure outran a row the NEW engine inserted, because R69's term tested the BLOCKING row's `depends_on IS NULL` and a post-restart fix chain carries real graph fields (R42). The term now keys on the CANDIDATE's `graph_frozen` (R71), so a derived closure is held behind any non-`done` lower-round row whatever wrote it | It does not arise. `scripts/checks/check-r69-straddle.sh` probe 1b measures the straddle matching today's engine tick for tick, and probes 1/1c measure the divergence RETURNING when the marker is cleared or the term deleted | — | **Nothing. The risk this row described is gone, not accepted.** It is kept as a struck row rather than deleted because §3.2.2 and §9.3 both cite it, and because a reader who remembers the accepted risk must be able to find where it was closed. Retired together with its blast-radius note in §3.2.2 and the narrowed sentence in §3.2, in one commit (standing rule 4) |

**Explicitly forbidden degradations** (the reviewer must check for each):
an unparseable workstream silently becoming `main`; a write-set validation
failure being dropped; a missing workstream worktree being recreated as the main
one; a dangling dependency reading as satisfied; a cycle being "broken" by
dropping an edge.

---

## 7. How progress and state are observable

Konrad's three surfaces, and what each gains:

**1. The Kanban / plan panel.** `GET /api/chat/:id/plan` already returns
`deps: string[]` per task, synthesised by `groupPlanPhases` as "every id in a
strictly lower round". Its own doc-comment names this project as the refinement
and promises the response shape will not change. We keep that promise: `deps`
becomes the real `depends_on` when non-null, the synthesised set when NULL.
`workstream` and `depth` are added as new fields. Phase blocks still group by
`floor(round / 100) * 100`, which the `k*100` seeding keeps meaningful.

`planEdges()` in `forge-control-web/app/desktop/team/planStore.ts` is already
shipped and covered by `scripts/checks/check-plan-store.ts` — three lines,
`nodes.flatMap(n => n.deps.map(d => ({source: d, target: n.id})))` — with no
renderer yet. After this project those edges are true. Drawing them is N4, a
different project.

**2. The executor log.** Every spawn line gains the workstream and the
dependency count:

```
[project-tick] spawned builder run <id> for task <id> (round 203, ws ui, deps 2/2 done, tier standard) — …
```

so the log says *why* a task started when it did. Today it says only which round
it was numbered into, which is exactly the number that stopped meaning anything.

**3. Notifications.** Unchanged in shape; the `🏁 round N complete` push becomes
per group (R45) so one workstream draining does not announce another's
completion.

**4. The measurement instrument** (`scripts/measure-schedule.ts`, phase 7). The
only surface that answers "did this work". It prints its own git SHA and the
schema version it read before printing a number, because standing rule 3 says
instruments lie before code does: tonight's red team found a probe clipping to
the viewport instead of its scroll container, a harness a doc called "ALREADY
UP", and a SHA naming a worktree rather than a build. A measurement whose
provenance is not printed is not a measurement, and one whose probes miss must
exit non-zero rather than certify itself (R61).

---

## 8. Technology choices, one line each

| Choice | Rationale |
|---|---|
| `uuid[]` column, not a `task_deps` join table | One row per task stays one row; `= ANY(...)` and a GIN index are enough at ~10² tasks per project; a join table adds a second write to every insert and a second place for a partial failure. |
| Nullable `depends_on` as the legacy sentinel | Turns the migration-vs-restart race into a non-event (§2.2). A boolean `graph_scheduled` column would say the same thing in two columns instead of one. |
| Pure `lib/task-graph.ts`, decisions out of SQL | The replay proof (R18) must run without a database; `project-reconcile.ts` already proves this discipline works here. |
| Depth computed, never stored | It is a projection; storing it would need invalidation, and the stable `round` already carries what identity and chain keys need. |
| Exact-path write-set intersection | Prefix semantics let a task declare `.` and serialize the project by accident — silent under-parallelism, the disease itself. |
| Sibling worktree directories | A nested worktree pollutes `git status --porcelain`, the reviewer cleanliness gate's only input (§4.2). |
| `project/<id8>-<ws>` branches | The spec's slash form is refused by git's ref store (§4.1, verified). |
| Group key gains `workstream`, chain keys namespaced only for non-`main` | Preserves byte-identical replay of every chain written since 0039 (§5.1). |
| No new runtime dependency | NF2; NFU8 from the previous project still holds for the web side. |
| Node's built-in `node:test`, `tsx --test src/lib/*.test.ts` | What this repo already uses; adding vitest would be a second harness for the same job. |

---

## 9. Escalation — the decisions the brief did not settle

**"the two" through round 222.** E3 (§9.2) made it three at round 106 and E4
(§9.3) makes it four at round 223, without either touching this heading. Counted
headings rot; corrected here rather than carried, standing rule 1.

Per the fleet escalation policy rule 3, these are build-once-use-many shapes that
everything downstream inherits, and I state the default I will proceed with.

**E1 — `round` stays a stored, engine-computed integer rather than becoming a
read-time derived value.** The spec §2 says derived. Derived puts a recomputable
number inside two unique indexes (0035 identity, 0039 chain-key) whose purpose is
replay safety, and it collapses the shipped Kanban's phase blocks. My design
gives Konrad what he asked for — no planner ever writes a round again — while
`round` remains stable enough to be an identity key. **Default: proceed as
designed** (§0).

**E2 — `depends_on` defaults to NULL, not `'{}'`.** The brief says `default
'{}'`. NULL is what makes the migration-before-restart window safe (§2.2), and
it is what makes the legacy branch retirable in one commit later. **Default:
proceed with NULL.**

**Not escalated, because the brief already answered it:** integration merges are
explicit tasks with reviewers, never automatic. The spec §3 asks the question and
states Konrad's default; the project brief restates it as a hard requirement and
adds *"if Konrad has answered otherwise in the meantime, follow his answer and
say so."* He has not, so N3/R38 stand as written.

Both escalations were sent as reminders from this round and reported to the
manager chat. Neither blocked planning: if Konrad had answered differently, the
change would have landed in phase 1 (E2, one line of DDL) or phases 1–3 (E1, and
the corpus says exactly which requirements move).

### 9.1 Resolution — 2026-08-17, round 0

**Konrad's answer: "Proceed to phase 1. Nothing here needs my ruling."**

E1 and E2 are therefore **settled on the defaults above**, on the record, and
this section is the citation for it:

- **E1 — `round` stays a stored, engine-computed integer.** Settled. §0's design
  is the design.
- **E2 — `depends_on` defaults to `NULL`, not `'{}'`.** Settled. R3 stands as
  written, against the project brief's `default '{}'`; the deploy-race reasoning
  in §2.2 is why, and it is the reason of record.

A later round that wants to change either must argue with §0 and §2.2, not
rediscover the question. **Neither is an open question any more, and neither is
a silent decision** — the difference matters, because an unrecorded default and
a ruled-on default look identical in the code six phases later.

### 9.2 E3 — the frozen-closure divergence, ruled 2026-08-17, round 106

**The question.** The backfill freezes a closure; the old engine keeps inserting
NULL-deps rows until the restart; no frozen closure can name them. Round 105's
reviewer raised it as a blocking finding and correctly refused to decide it from
a builder's chair. §3.2.1 is the full statement.

**The ruling: option (a) — the graph branch gains a legacy-row term (R69).**
The alternatives and why they lost are in §3.2.1. In one line each: moving the
backfill to a quiet fleet was already rejected in §2.2 and cannot be rescued by
a `safe-restart.sh` hook, because "quiet" is a 45-second heartbeat window and a
tick can fire inside it; accepting the divergence contradicts R18 and the
Definition of Done on a hazard reachable on the deploy's own target project.

**Who ruled, and on what.** Taken by round 106's builder under fleet escalation
policy rule 3 — stated as a default, escalated to the manager chat and by
reminder in the same turn, and *not* blocked on. It is a correctness decision
with one answer consistent with the corpus's existing commitments, not a
preference decision. **Konrad may overrule it**; if he does, the change is
localised to R69, §3.1's SQL, F13, and R18 case (f), and nothing else in the
plan moves.

**Evidence, not assertion.** The term was mutation-tested before it was written
down. Closure-only: cases (a)–(e) green, case (f) diverges on tick 2. With the
term: all six agree. `evidence/phase1-migration.md` §13.4 carries the transcript
and the exact command.

A later round that wants to delete R69 must delete it *with* R12's legacy branch
and R18 case (f), in one commit, when no `depends_on IS NULL` row remains
(standing rule 4). Deleting it alone re-opens F13.

### 9.3 E4 — the R69 straddle, ruled 2026-08-17 (round 223), REOPENED AND CLOSED 2026-08-18 (round 242)

**THE OUTCOME FIRST. Option A is implemented.** `project_tasks.graph_frozen`
(R71) records which closures 0040's backfill wrote, set `true` by the same
`UPDATE` that writes them; R69's term gates on it; §3.2's sentence is restored
and F14 is retired. The operator reopened E4 on exactly the terms round 223
specified — *"option A becomes implementable the moment a frozen row is MARKED
rather than INFERRED"* — inside the window round 223 priced, which closes when
phase 8 runs `psql -f`.

**Round 223's ruling is superseded, not withdrawn, and its reasoning is not
weakened.** For a schema with no marker, option B was correct: every one of the
four inferences below was built, measured, and failed. That measurement is the
evidence that justifies the column, so it is preserved below in full and its
arms still RUN, against the pre-242 rows, in the same script (`PRE-E4`,
`WIDE-*`). What changed is not the argument but the schema it reasons about.

Round 242's own measurements — the straddle matching today's engine tick for
tick, the divergence returning under both a data mutation and a source-level
deletion of the term, and the post-restart project unchanged at 3 ticks / 8-wide
— are in §3.2.2's table and in `evidence/phase4-workstreams.md` §11.

---

#### 9.3.1 The ruling as it stood in round 223 (superseded 2026-08-18)

**The question.** R69 holds a frozen row behind LEGACY rows only. R42 gives fix
chains created after the restart REAL graph fields. So in a straddling project a
row the new engine inserts below a frozen row is invisible to R69's term, and
§3.2's sentence — that a straddling project finishes under its original
semantics — is wider than what R69 delivers. Phase 1 raised it and declined to
fix it as out of phase. Two options, both defensible:

- **A — widen R69's predicate for frozen rows only:** while a row is frozen,
  hold it behind ANY non-`done` row of strictly lower round, not merely a legacy
  one. The operator's proposal, on the reasoning that a straddle is transient so
  the widening costs nothing on any project planned after the restart.
- **B — narrow §3.2 to match R69,** accept the divergence on the record, and
  state its blast radius.

The operator's instruction was explicit: *"treat it as a hypothesis to test, not
a ruling. Overrule it with evidence and I will endorse the overrule"*, and
*"prove your choice the way phase 1 proved R69 — fill the stubs both ways in a
scratch repo and show what diverges, rather than reasoning about it on paper."*

**The ruling: option B.** The divergence is accepted, named, bounded, and
recorded — and §3.2's sentence is retired in the same commit as the requirement
it disagreed with (standing rule 4; the sentence is asserted in no gate anywhere,
which was checked by grep before it was narrowed, so nothing retires with it
beyond R6's matching clause and one over-wide sentence in `db/projects.ts`'s
module preamble).

**Evidence, not assertion — `scripts/checks/check-r69-straddle.sh`, 11 probes,
all green.** Three fixtures, six arms; three of the arms are the SHIPPED
`graphReady()` with a widening composed on top of it, so no arm re-implements
the rule under test. Transcript: `evidence/phase4-workstreams.md` §5.

| what was measured | result |
|---|---|
| Is the divergence real? (S1: 131 frozen rows + a post-restart chain at 1307/1308) | **Yes.** Legacy 17 ticks, shipped engine 14. First divergence **tick 2**, rows `511070c9…` and `608dbecb…` — the same two rows on the same tick §3.2.1 records for F13 |
| Option A's arithmetic, applied to every graph row | **Correct** — reproduces today's schedule tick for tick, term fired 6× |
| Option A gated on "the project holds a NULL row" | **Silent.** Gate opened 0/52 times: 0040's backfill overwrites the sentinel on every pre-existing row, so a straddle with no gap row holds no legacy row at all |
| …the same gate on S2, which is S1 **plus one already-`done` NULL row** | **Closes the divergence.** Fired 6×. Two projects differing by one settled, scheduling-inert row are scheduled differently — a coincidence, not a predicate |
| Option A gated on `isClosureShaped()`, the corpus's own frozen-row detector | **Blind where it is needed.** It compares a closure against the CURRENT row list, so the post-migration row breaks the signature of every frozen row above it: **8/8** of the exposed rows read "frozen" before the chain exists, **0/8** after |
| Option A gated on a `created_at` horizon taken from the row's own closure (the cleverest gate the schema can express; needs no stored migration timestamp) | **Right on the straddle, ruinous elsewhere.** Closes S1 exactly. On S3 — a project planned entirely after the restart, one long reviewer and seven unrelated builders — it fires 56× and takes the schedule from **3 ticks / 8-wide to 17 ticks / 1-wide**, i.e. back to today's engine. It cannot tell "my closure is complete because a migration wrote it" from "my closure is complete because I was created first" |
| Ungated widening, on that same post-restart project | **Identical collapse:** 3 ticks / 8-wide → 17 / 1-wide |

**Why A lost, in one line:** its arithmetic is right and it has no gate. "While a
row is frozen" is not a predicate this schema can evaluate — nothing records that
0040 wrote a closure, and every signature that stands in for it either goes blind
exactly when it is needed or convicts ordinary fan-out of being a backfill. An
option that can only be implemented by charging every future project the cost of
a migration window is not the cheaper option.

**The blast radius of B, which is the option taken.** §3.2.2 states it in full.
In summary: in a straddling project, a row the new engine inserts at a lower
round does not hold a frozen row above it; both are `workstream = 'main'` in one
worktree and both carry an empty `write_set`, so contention does not separate
them either. R63 drains the deploy's own target before the deploy, so the
project §3.2.1's reachability argument was built on is not exposed; any other
project holding frozen `pending` rows is.

**What would reopen this — AND DID, in round 242.** Option A becomes
implementable the moment a frozen row is *marked* rather than *inferred* — one
more additive column in 0040
(`ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS graph_frozen boolean NOT
NULL DEFAULT false`, set `true` by the same backfill `UPDATE`), after which the
gate is `pt.graph_frozen` and every objection above evaporates. That is cheap
**only while 0040 is un-applied**, which is true until phase 8 runs `psql -f`,
and impossible to do honestly afterwards. It is a phase-1 change touching
`0042_task_graph.sql`, `db/projects.ts`, `task-graph.ts`, `task-graph.test.ts`,
`task-graph-replay.test.ts` (a case (g)), `check-scheduler-sql.sh` and R3/R6/R69
— six files across three phases. Round 223 did not take it, and did not take it
silently: it is priced here so the choice is one decision rather than a
rediscovery. **Round 242 took it, and the price was accurate**: the six files
named here plus `check-migration-0040.sh` (the migration's own test, which counts
the columns), `routes/chat.ts` (a `GraphTask` literal that stops compiling
without the field — which is the point of the field being required), and the four
test factories that build a whole `ProjectTask`. Every one of those was a compile
error rather than a silent default, which is why the estimate held.

**Who ruled, and on what** (round 223). Round 223's builder, under fleet escalation policy
rule 3 — measured first, ruled second, and reported to the manager chat with the
`graph_frozen` alternative attached as an explicit choice rather than described
in prose. It is a correctness-versus-cost decision with a measured answer, not a
preference decision, so it was not blocked on. **Konrad may overrule it**; if he
does, the change is the `graph_frozen` column above and the six files it touches,
and §3.2's original sentence comes back with it. **He did, on 2026-08-18** — the
task brief for round 242 is the overrule, and it arrived with the reasoning
round 223 asked to be measured against: *the fact is not recorded, so every gate
is archaeology; record the fact at the moment it is true, by the process that
makes it true.*

---

## 10. What a reader should check this document against

- `promoteReadyTasks`, `claimReadyTasks`, `createTask`, `createFixChain`,
  `unwedgeProject`, `roundIsComplete`, `TASK_COLS`, `TASK_COLS_PT` — all in
  `forge-control/src/db/projects.ts`.
- `consolidateVerdictRound`, `chainKeys`, `verdictMemberSettled`, `VERDICT_ROLES`
  — `forge-control/src/lib/project-reconcile.ts`.
- `buildPrompt`, `withPolicy`, `PARALLELISM_GUIDE`, `IDEMPOTENCY_NOTE`,
  `WORKTREE_POLICY`, `REVIEWER_LIVE_CHECK`, `spawnTaskRuns`,
  `consolidateVerdictGroup` — `forge-control/src/lib/project-tick.ts`.
- `provisionWorkspace`, `lookupWorktree`, `resolveStartPoint`, `removeWorkspace`,
  `liveCheckoutPath` — `forge-control/src/lib/workspace.ts`.
- `groupPlanPhases`, `PLAN_TASKS_SQL`, `PlanTask`, `PlanPhase` —
  `forge-control/src/routes/chat.ts`.
- `planEdges`, `planProgress`, `PlanNode` —
  `forge-control-web/app/desktop/team/planStore.ts`.
- Migrations 0030, 0035, 0037, 0039 and the lint in
  `forge-control/src/lib/migrations.test.ts`.

If any citation above no longer resolves to the symbol described, **that is a
finding to report**, not a footnote to reinterpret.
