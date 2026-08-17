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

/** Consolidation group key (R40). */
export function groupKey(t: Pick<GraphTask, "round" | "workstream">): string;

/** Path normalisation + validation for write_set entries (R28). */
export function normaliseWritePath(raw: string): string;   // throws on violation
export function validateWorkstream(raw: string): string;   // throws on violation

export class GraphIntegrityError extends Error {}          // R14 — its own class
```

`GraphIntegrityError` is its own class for the same reason `RoleFileParseError`
in `project-tick.ts` is: the caller must distinguish a corrupt graph from an I/O
failure, and a test must assert on the class rather than on message text.

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

### 2.1 The three columns

```sql
-- db/migrations/0040_task_graph.sql
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS depends_on uuid[];              -- NULL default
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS workstream  text  NOT NULL DEFAULT 'main';
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS write_set   text[] NOT NULL DEFAULT '{}';
```

`ADD COLUMN IF NOT EXISTS` on all three — required by `migrations.test.ts`'s
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
   explicitly. Enforcing immutability in the database (a trigger, a rule) is
   **rejected**: it would take away Konrad's own escape hatch on a system he
   operates by hand at 3am, to defend an invariant the engine already respects.
   Boring beats clever, and the operator is not the adversary here.

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
          = cardinality(pt.depends_on))           -- R14: no dangling dep may satisfy
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

### 3.2 The legacy branch is the migration strategy

There is no flag day and no engine-version switch. The behaviour of a row is
decided by its own data. A project in flight when the new engine loads finishes
under its original semantics; a project planned after it runs on the graph; a
project that straddles the restart has both kinds of row and each is correct.

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

## 9. Escalation — the two decisions the brief did not settle

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

Both escalations are sent as reminders from this round and reported to the
manager chat. Neither blocks planning: if Konrad answers differently, the change
lands in phase 1 (E2, one line of DDL) or phases 1–3 (E1, and the corpus says
exactly which requirements move).

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
