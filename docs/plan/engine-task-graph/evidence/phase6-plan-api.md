# Phase 6 — observability: real edges on the plan endpoint

Builder 6A (round 222) writes §1 and §2. Builder 6B appends §3 (the web
surface); builder 6C appends §4 (R58, the spawn log line, at round 231).

Base commit of this branch: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e` — the
same commit the corpus was planned against.
Server half landed at `811e8c1`.

---

## §1 — what changed, and why

### 1.1 R54 — `deps` becomes the real edge set when one exists

`groupPlanPhases` (`forge-control/src/routes/chat.ts`) previously synthesised
`deps` unconditionally as "every task id in a strictly lower round of the same
project". It now has two branches, selected by the `depends_on` sentinel and by
nothing else:

| `depends_on` in the row | `deps` in the response |
|---|---|
| non-null, populated | that array, **verbatim** — same ids, same order, copied not aliased |
| non-null, `[]` | `[]` — an **explicit graph root**, never the synthesised set |
| `null` (the legacy sentinel) | today's strictly-lower-round set, byte-identical to what shipped |

Four decisions inside that table, each taken deliberately:

- **One `=== null` test.** Not `?? []`, not truthiness. `[]` and `null` are
  precisely the two values a defaulting operator would merge, and they are
  precisely the two this branch exists to tell apart. `readyRule()` in
  `lib/task-graph.ts` remains the **single interpreter of the sentinel on the
  scheduling path** (the inherited contract from phase 2A, commit `bac02ec`);
  this is display code, it decides nothing, and importing `graphReady()` or
  `readyRule()` would put a scheduling decision inside a route. It reads the
  sentinel the same *way*, which is the part that must not drift.
- **The running accumulator is unchanged**, so same-round siblings stay out of
  each other's deps under the legacy branch, and **graph rows still feed it** —
  a legacy row above graph rows must see them, or a straddling project renders
  as two disconnected boards. Case D asserts exactly that.
- **A dangling dep id is emitted verbatim.** R27 makes one unreachable through
  the API, so a dep naming no row in the project means a corrupt row arrived
  some other way. Suppressing it here would hand an operator a tidy graph the
  scheduler will never drain. (`taskDepth()` takes the opposite decision for its
  own arithmetic — an absent dep contributes no edge — because a missing node
  cannot be given a longest path. Both are display; only this one is a *report*.)
- **The doc-comment's promise is marked KEPT.** The paragraph that read
  "refining it later (file-overlap, explicit `depends_on` column) changes which
  ids appear in this array and NOTHING about the response shape" named this
  refinement before it existed. The rewritten comment now describes both
  branches, names R54 as the requirement that made the refinement, and records
  the commit that kept the promise. §2.1 is the mechanical proof that it held.

### 1.2 R55 — `workstream` and `depth`

`PlanTask` gains `workstream: string` and `depth: number`. `PLAN_TASKS_SQL` and
`PlanTaskRow` gain `depends_on::text[]`, `workstream` and `write_set`. The
`::text[]` cast follows `TASK_COLS` in `db/projects.ts`, whose
`ProjectTask.depends_on` doc-comment explains why it is deliberate rather than
necessary: a raw `uuid[]` already arrives as `string[]` on this host's pg, and
the cast is what stops a future pg without the `_uuid` parser turning the field
into the raw string `'{a,b}'` behind the `=== null` comparison above.

`write_set` is **read but not published**. It is the contention input the
scheduler owns; a `PlanTask` field nothing draws would be response shape bought
for nothing (N4 — the renderer is a different project).

`depth` is the derived longest-path depth from `taskDepth()`. It is computed in
a new function, `planDepths`, and handed to `groupPlanPhases` as a
`ReadonlyMap`. That split exists so **the single `taskDepth()` call and its
single catch live in one named place** rather than inside a per-task loop —
the second inherited decision from phase 2A. `taskDepth()` is total by
construction (a legacy row seeds its own `round`; an absent dep contributes no
edge; a duplicate dep is one edge), so a cycle is the only thing it throws on,
and it throws rather than returning what it managed to compute.

The `GraphTask` projection casts `PlanTaskRow.status` (a plain `string`, the
wire shape) to the `TaskStatus` union. **The pin resolves:**
`db/migrations/0030_coding_projects.sql` lines 44-45 at git SHA `7efa36b` are

```
  status       varchar(16) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','ready','running','done','failed','blocked')),
```

— exactly the six members of `TaskStatus`. Verified against that SHA before the
comment citing it was written, per standing rule 1. (`taskDepth()` reads only
`id`, `round` and `depends_on` in any case, so the cast is a type obligation
rather than a behavioural one.)

`lib/task-graph.ts` is safe to import into a route: its only import is
`import type { TaskStatus }`, which erases, so it opens no pool and drags no db
module in behind it.

### 1.3 The cycle path — a disclosed degradation

`taskDepth()` throwing must neither 500 the panel nor be swallowed. What ships:

- **Only `GraphIntegrityError` is caught**, around the single `taskDepth()`
  call. Anything else escaping the two pure calls is a defect in this route and
  gets `planFailure`'s 500 with diagnostics — a defect is not a field.
- On the catch: every task's `depth` becomes its own `round`, and the new
  optional `PlanResponse.graph_error` carries the thrown message **verbatim**,
  including the ids it names. The message is also logged.
- `graph_error` is a **new field, not an overload of `error`**. `error`'s own
  doc-comment says it means "the docs listing failed"; merging the two would
  make two unrelated degradations indistinguishable to the one reader who has to
  act on them. It is the same idiom `error` already uses (NFU6 — "a null with a
  reason is a fact"), and case D/F assert `graph_error` is **absent** on a
  well-formed graph while case G asserts it is present and names both cyclic ids
  — with the docs `error` present in every one of those responses, which is what
  proves the two fields are genuinely distinct rather than coincidentally equal.

The alternative — taking the Kanban down over a board it can simply draw — is
the "outage in place of a diagram" `taskDepth()`'s own doc-comment rules out.
The other alternative — a silent `depth = round` — would show an operator a
plausible board computed from a graph that cannot drain.

**For the reviewer's silent-fallback audit (`03-quality.md` §3.1 item 6),** the
complete list of what this phase added to `chat.ts`:

| site | why it is not a swallowed error |
|---|---|
| `catch` in `planDepths` | Catches **one class only** and rethrows everything else. The caught condition is reported to the client in `graph_error`, verbatim, and logged. Disclosed, not swallowed. |
| `try` around `planDepths` + `groupPlanPhases` in the route | Converts a defect into `planFailure`'s 500 **with the message**, rather than a half-built body. It cannot catch the cycle — `planDepths` has already handled that one. |
| `if (rowDepth === undefined) throw` in `groupPlanPhases` | The **opposite** of a fallback, and written that way on purpose: `?? row.round` would be indistinguishable from a real depth that happens to equal the round, and would hide a `planDepths`/grouping disagreement on the one surface built to expose it. |

No `?? default`, no `|| fallback`, no `.catch(() => {})` was added.

### 1.4 R56 — verified, not re-added

R56 asks that `GET /api/projects/board` and `GET /api/projects/:id` carry
`depends_on`, `workstream` and `write_set` via `TASK_COLS` and `TASK_COLS_PT`.
Confirmed at this HEAD: both lists carry all three, and both routes return
`listTasksForProject()` / `listActiveTasks()` rows unmodified. `db/projects.ts`
was not edited — it is phase 4's file this round.

What is added is the **mechanical assertion** the requirement lacked: case H of
the probe fetches the same task row through both routes and compares their key
sets. They must be identical but for `project_name`, which the board's join adds
on purpose. **They agree.** The shared doc-comment on those two constants exists
so "a new column can never again be added to `TASK_COLS` and silently forgotten
in a hand-written joined SELECT"; case H is that sentence turned into a test.

### 1.5 What would have made this probe report a pass WRONGLY

Four mechanisms, each disarmed **by an assertion in the shipped script**, not by
inspection:

1. **A fixture where the synthesised set and the real set coincide.** Then
   `deps: [...lower]` — the exact regression this phase must rule out — passes
   case A silently. *Impossible in what shipped:* case A recomputes the
   synthesised set **from the response itself**, in a function deliberately
   reimplemented rather than imported (importing the code under test to compute
   what it is compared against would prove only that the code equals itself),
   and asserts via `assertDiffers` that the two **differ** before asserting
   `deps` equals the declared one. The fixture's `depends_on` is written
   round-**descending** (`{L3, L1}`), which no synthesised set can produce and no
   accidental sort preserves; a second assertion pins that property so a future
   fixture edit cannot quietly lose it. Case B does the same for the `'{}'` root
   — two lower rounds holding three rows are seeded precisely so `[]` and the
   synthesised set cannot be confused. A fixture edited into coincidence fails
   on `assertDiffers` instead of passing. **Observed:** case A's transcript line
   reads `[] !== [...]` / `["…b003","…b001"] !== ["…b001","…b002","…b003"]`.
2. **A probe that never reached the route** — the dynamic import failed, a
   friendly catch printed a message, and the run "passed" having asserted
   nothing. *Impossible in what shipped, three ways:* (i) the `await import()`
   is **not** wrapped in a try, so an import failure reaches the top-level catch
   which prints `ABORTED — NOT a pass` and exits 1; (ii) two positive controls
   run **first and abort the whole run** unless a real HTTP round-trip returns
   rows this script seeded — 0a proves `chat.ts`'s `teamPool` **and**
   `chat-linkage.ts`'s pool resolved the seeded chat to the seeded project, 0b
   proves `db/projects.ts`'s pool reads the same schema; (iii) every case
   declares its assertion count and the runner compares declared against
   executed **in both directions**, plus cases planned against cases that
   asserted anything. **Observed in both mutation runs:** the `MISSED case …
   declares N assertion(s) but executed M` line fires, and the census fails the
   run on the count alone even before the failed assertion.
3. **A `depth` field that simply returns `round`.** Indistinguishable from a
   working `taskDepth()` on any fixture where the two agree. *Impossible in what
   shipped:* case F seeds rounds 100/101/102 where 102 depends **only** on 100,
   so depth is 0/1/1 while round is 100/101/102, and asserts **both** numbers on
   every row plus the property "depth differs from round on all three".
   Mutation 2 in §2.3 is this exact regression, observed red.
4. **A cycle case that passes because the route 500ed**, or because a partial
   map was returned. *Impossible in what shipped:* case G asserts the status is
   **200**, that `graph_error` is a string naming **both** cyclic ids, and that
   every depth equals its round — including `Y3`, a graph **root** at round 202
   which a partial map would have given depth 0. It also asserts the cycle
   really is in the database, through `psql` rather than through the API.

Two further guards worth naming: **the null-vs-empty distinction is asserted in
`psql`, not through JSON** (`SELECT depends_on IS NULL`) before any API answer is
judged, because `null` and `[]` can both arrive looking like absence depending on
the serializer and that distinction *is* the straddle; and **the probe prints its
own build identity** — repo, git SHA, branch, uncommitted subject files, and the
sha256 of each of the four files under test. Both mutation transcripts below
carry a **different** `chat.ts` sha256 in their header than the clean run, so a
transcript produced against a mutated tree is legible as such rather than reading
as authoritative.

### 1.6 Notes and findings

- **No corpus citation failed to resolve.** The one line-number pin this phase
  relies on (`0030_coding_projects.sql` lines 44-45 at `7efa36b`) was checked
  against that SHA and does read as described; it is reproduced above.
  `check-corpus-map.py` and `check-instrument-identity.py` both exit 0.
- **No unsatisfiable gate was found in this phase's scope**, so nothing was
  amended under standing rule 2.
- **No requirement was retired**, so standing rule 4 does not apply.
- **Disclosed — the worktree is shared and in flight.** Two phase-4 builders are
  committing beside this one (`db/projects.ts`, `lib/project-tick.ts`). The
  probe's own provenance header records this honestly: the clean run's
  `uncommitted (subj)` line names `db/projects.ts` as modified by another
  builder at the moment of the run. Case H therefore exercised a
  `db/projects.ts` that phase 4 was mid-edit on; `TASK_COLS` and `TASK_COLS_PT`
  agreed anyway. See §2.5 for the state of `pnpm typecheck` at the time of
  writing and why it is not this phase's.

---

## §2 — transcripts

### 2.1 Response shape — additions only

Command, verbatim, and its complete output. Base commit
`20bd46abc9228ca1e8c06a7a17be13f06e6d287e`, HEAD `811e8c1`:

```
$ git diff "$(git merge-base main HEAD)"...HEAD -- forge-control/src/routes/chat.ts | grep '^-' | grep -v '^---'
- *  Route-local by phase-300 law (13 §3): db/projects.ts is the engine lane's. */
-const PLAN_TASKS_SQL = `SELECT id::text, round, role, title, status, tier
- * Group tasks into hundreds-blocks and attach `deps`.
- * DEPS, PRECISELY: every task id in a STRICTLY LOWER round of the same project.
- * That is the engine's real ordering rule made explicit (13 §3) — project-tick
- * releases a round only once every task below it has settled, so "lower round"
- * IS "must happen first". It is COARSE: round 306 genuinely depends on 305
- * (same file) but only bureaucratically on 101, and the edge set says both.
- * It is nonetheless TRUE — no edge here is a lie, only some are uninteresting.
- * Refining it later (file-overlap, explicit `depends_on` column) changes which
- * ids appear in this array and NOTHING about the response shape, so the Kanban
- * and the future graph both survive the refinement untouched.
- * Same-round siblings are never each other's deps: the four round-303 builders
- * ran in parallel, by design, on disjoint files.
-function groupPlanPhases(rows: PlanTaskRow[], docs: string[]): PlanPhase[] {
-      deps: [...lower],
- * task query or the project row itself fails.
-    phases: groupPlanPhases(taskRows, docs),
```

**Eighteen removal lines. Zero of them are inside `interface PlanTask`,
`interface PlanPhase` or `interface PlanResponse`.** Line by line, which is
which:

| removal | what it is | verdict |
|---|---|---|
| ` *  Route-local by phase-300 law…` | last line of `PLAN_TASKS_SQL`'s doc-comment; the comment continues with the new `::text[]` paragraph | comment-only |
| `const PLAN_TASKS_SQL = \`SELECT id::text, round, role, title, status, tier` | the SQL literal's first line, replaced by a longer one that adds three columns and removes none | **not an interface**; additive SQL |
| the eleven ` * …` lines from `Group tasks into…` to `…on disjoint files.` | `groupPlanPhases`'s doc-comment, rewritten to describe both branches and to mark its own promise KEPT | comment-only |
| `function groupPlanPhases(rows: PlanTaskRow[], docs: string[]): PlanPhase[] {` | the function **signature**, which gains a third parameter (`depth`) | **not the response shape**; an internal function's arity, and the only caller is in the same file |
| `      deps: [...lower],` | the old unconditional expression, replaced by the two-branch one | **not an interface**; `deps` is still `string[]` |
| ` * task query or the project row itself fails.` | route doc-comment, extended to describe the 200-with-`graph_error` path | comment-only |
| `    phases: groupPlanPhases(taskRows, docs),` | the call site, now passing the depth map | **not an interface** |

The three interfaces gained `PlanTask.workstream`, `PlanTask.depth` and
`PlanResponse.graph_error`, and lost nothing. `PlanPhase` is untouched.
Acceptance criterion met.

### 2.2 The probe, green — full output

```
$ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-plan-api.ts ; echo "exit=$?"
=== check-plan-api.ts — provenance ===========================================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 4244b20
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control/src/db/projects.ts |  M forge-control/src/routes/chat.ts
  sha256             : f682bddd1745f4267ae3d44fc0046dfaad8d605e6853b9afe10ba35334c9050d  forge-control/src/routes/chat.ts
  sha256             : 5e5850391feb11327ad22ad37d0b3ed9b55f53c251e8d2c90761f88d2fc152c3  forge-control/src/lib/task-graph.ts
  sha256             : f6ceb8cfd5b3cad624957f354360103f8ce13be2de446e549ab6b7ff890517e0  forge-control/src/routes/projects.ts
  sha256             : 9e5402f0847ad3f653aedfb93323a2e59b005812a11df774abe7bc04d314d08e  forge-control/src/db/projects.ts
  scratch database   : forge_tg_scratch (local; DSN never printed)
  throwaway schema   : tg_check_plan
  schema reached by  : PGOPTIONS=-c search_path=tg_check_plan (re-proved by control 0a)
  bind               : http://127.0.0.1:7797 (never 7700)
  mounts             : /api/chat, /api/projects
  migrations applied : 20 (+1 forced content_jobs placeholder)
  rows seeded        : 3 projects, 13 tasks
  cases to run       : 8
  assertions declared: 46
==============================================================================

--- 0a. positive control: is the CHAT router reading the scratch schema? ------
      GET /api/chat/00000000-0000-4000-8000-0000000f0001/plan → 200
      ok   chat.ts + chat-linkage.ts read tg_check_plan: chat 00000000-0000-4000-8000-0000000f0001 → project 00000000-0000-4000-8000-00000000a001
--- 0b. positive control: is the PROJECTS router reading the scratch schema? --
      GET /api/projects/00000000-0000-4000-8000-00000000a001 → 200
      ok   db/projects.ts reads tg_check_plan

--- case A: R54 — a graph row with a populated depends_on: deps is that array, ids AND order
    A  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   A sentinel in the DATABASE: G_POP.depends_on IS NOT NULL — = "f"
      ok   A the fixture discriminates (real vs synthesised) — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"] !== ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      ok   A deps == depends_on, verbatim — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]
      ok   A the declared order is not the round order — = true
      ok   A sibling graph row unaffected by A's read — []

--- case B: R54 — depends_on = '{}' is an EXPLICIT root: deps [], NOT the synthesised set
    B  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   B sentinel in the DATABASE: G_ROOT.depends_on IS NOT NULL — = "f"
      ok   B and it is empty — = "0"
      ok   B the fixture discriminates ([] vs synthesised) — [] !== ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      ok   B deps == [] — []

--- case C: R54 — a legacy row (depends_on IS NULL) keeps the synthesised strictly-lower set
    C  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   C sentinel in the DATABASE: L3.depends_on IS NULL — = "t"
      ok   C L3 (round 101) deps == the two round-100 rows — ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"]
      ok   C L1 deps == [] (no round below 100) — []
      ok   C L2 deps == [] — its sibling L1 is NOT a dep — []
      ok   C L2's deps do not name L1 — = false

--- case D: R54 — a MIXED project: both kinds of row in ONE response, and graph rows still feed the accumulator
    D  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   D the project holds 4 legacy rows and 3 graph rows — = "4|3"
      ok   D every seeded task is in the response — = 7
      ok   D L4 (legacy, round 104) sees every strictly-lower row INCLUDING the graph ones — ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"]
      ok   D a dangling dep id survives to the client — ["00000000-0000-4000-8000-00000000bfff"]
      ok   D no graph_error on a well-formed graph — no 'graph_error' key

--- case E: R55 — workstream present on every task; a non-'main' value survives verbatim
    E  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   E every task carries a workstream — = 7
      ok   E G_POP's non-default workstream survives — = "alpha"
      ok   E the other six are 'main' — = 6

--- case F: R55 — depth is the DERIVED longest path, and it DISAGREES with round
    F  depth-vs-round project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0002/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0002","project":{"id":"00000000-0000-4000-8000-00000000a002","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000c001","round":100,"role":"builder","title":"depth root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000c002","round":101,"role":"builder","title":"depends on the root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000c001"],"workstream":"main","depth":1},{"id":"00000000-0000-4000-8000-00000000c003","round":102,"role":"builder","title":"ALSO depends only on the root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000c001"],"workstream":"main","depth":1}],"title":"depth root"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   F D0 round — = 100
      ok   F D1 round — = 101
      ok   F D2 round — = 102
      ok   F D0 depth (explicit root) — = 0
      ok   F D1 depth — = 1
      ok   F D2 depth — 1, NOT 2: it depends only on D0 — = 1
      ok   F depth differs from round on every row of this fixture — = 3
      ok   F no graph_error on an acyclic graph — no 'graph_error' key

--- case G: R55 — a stored CYCLE: HTTP 200, graph_error naming the ids, every depth == its round
[chat plan] taskDepth refused the stored graph: task-graph: taskDepth(): 2 task(s) cannot be topologically ordered — depends_on contains a cycle through: 00000000-0000-4000-8000-00000000d001, 00000000-0000-4000-8000-00000000d002 (R19, R25)
    G  cyclic project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0003/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0003","project":{"id":"00000000-0000-4000-8000-00000000a003","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":200,"tasks":[{"id":"00000000-0000-4000-8000-00000000d001","round":200,"role":"builder","title":"cycle node 1","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000d002"],"workstream":"main","depth":200},{"id":"00000000-0000-4000-8000-00000000d002","round":201,"role":"builder","title":"cycle node 2","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000d001"],"workstream":"main","depth":201},{"id":"00000000-0000-4000-8000-00000000d003","round":202,"role":"builder","title":"graph ROOT outside the cycle","status":"done","tier":null,"deps":[],"workstream":"main","depth":202}],"title":"cycle node 1"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located","graph_error":"task-graph: taskDepth(): 2 task(s) cannot be topologically ordered — depends_on contains a cycle through: 00000000-0000-4000-8000-00000000d001, 00000000-0000-4000-8000-00000000d002 (R19, R25)"}
      ok   G the cycle really is in the DATABASE (Y1→Y2, Y2→Y1) — = "t"
      ok   G status is 200, not 500 — = 200
      ok   G graph_error is present and a string — task-graph: taskDepth(): 2 task(s) cannot be topologically ordered — depends_on 
      ok   G graph_error names Y1 — body names "00000000-0000-4000-8000-00000000d001"
      ok   G graph_error names Y2 — body names "00000000-0000-4000-8000-00000000d002"
      ok   G Y1 depth == its round — = 200
      ok   G Y3 (graph root, round 202) depth == 202, NOT 0 — = 202
      ok   G every depth equals its round — = 3

--- case H: R56 — the projects router carries depends_on, workstream and write_set, and its two column lists agree
    H  GET /api/projects/00000000-0000-4000-8000-00000000a001 → 200
      ok   H detail status — = 200
      ok   H detail row for G_POP found — 7 tasks in the project
      ok   H detail depends_on (TASK_COLS) — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]
      ok   H detail workstream (TASK_COLS) — = "alpha"
      ok   H detail write_set (TASK_COLS) — ["forge-control/src/routes/chat.ts"]
    H  GET /api/projects/board → 200
      ok   H no TASK_COLS column is missing from TASK_COLS_PT — []
      ok   H TASK_COLS_PT adds only the joined project_name — ["project_name"]
      ok   H the board row's depends_on matches the detail row's — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]

--- census -------------------------------------------------------------------
  cases planned              : 8
  cases that ran an assertion: 8
  assertions declared        : 46
  assertions executed        : 46
  assertions failed          : 0

PASS — 8 cases, every declared assertion executed and green: real edges for graph rows and synthesised edges for NULL rows in ONE response (R54), the explicit '{}' root, the dangling dep emitted verbatim, workstream and the derived depth (R55), the disclosed graph_error on a stored cycle, and TASK_COLS / TASK_COLS_PT agreeing on the same row (R56).
  teardown           : schema tg_check_plan dropped, :7797 closed
exit=0
```

### 2.3 Mutation 1 — `deps` forced to the synthesised set, observed FAILING

The mutation, applied to the committed file and reverted immediately after:

```
$ perl -0pi -e 's/deps: row\.depends_on === null \? \[\.\.\.lower\] : \[\.\.\.row\.depends_on\],/deps: [...lower], \/* MUTATION 1 *\//' forge-control/src/routes/chat.ts
$ grep -n 'MUTATION 1' forge-control/src/routes/chat.ts
951:      deps: [...lower], /* MUTATION 1 */
```

Note the `chat.ts` sha256 in the header below: `8ce734f7…`, **not** the clean
run's `f682bddd…`. The instrument names the bytes it measured.

```
$ ./node_modules/.bin/tsx ../scripts/checks/check-plan-api.ts ; echo "exit=$?"
=== check-plan-api.ts — provenance ===========================================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 4244b20
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control/src/db/projects.ts |  M forge-control/src/routes/chat.ts
  sha256             : 8ce734f79219834640e279a49d34092e307286b151adc7322837752096b987df  forge-control/src/routes/chat.ts
  sha256             : 5e5850391feb11327ad22ad37d0b3ed9b55f53c251e8d2c90761f88d2fc152c3  forge-control/src/lib/task-graph.ts
  sha256             : f6ceb8cfd5b3cad624957f354360103f8ce13be2de446e549ab6b7ff890517e0  forge-control/src/routes/projects.ts
  sha256             : 9e5402f0847ad3f653aedfb93323a2e59b005812a11df774abe7bc04d314d08e  forge-control/src/db/projects.ts
  scratch database   : forge_tg_scratch (local; DSN never printed)
  throwaway schema   : tg_check_plan
  schema reached by  : PGOPTIONS=-c search_path=tg_check_plan (re-proved by control 0a)
  bind               : http://127.0.0.1:7797 (never 7700)
  mounts             : /api/chat, /api/projects
  migrations applied : 20 (+1 forced content_jobs placeholder)
  rows seeded        : 3 projects, 13 tasks
  cases to run       : 8
  assertions declared: 46
==============================================================================

--- 0a. positive control: is the CHAT router reading the scratch schema? ------
      GET /api/chat/00000000-0000-4000-8000-0000000f0001/plan → 200
      ok   chat.ts + chat-linkage.ts read tg_check_plan: chat 00000000-0000-4000-8000-0000000f0001 → project 00000000-0000-4000-8000-00000000a001
--- 0b. positive control: is the PROJECTS router reading the scratch schema? --
      GET /api/projects/00000000-0000-4000-8000-00000000a001 → 200
      ok   db/projects.ts reads tg_check_plan

--- case A: R54 — a graph row with a populated depends_on: deps is that array, ids AND order
    A  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   A sentinel in the DATABASE: G_POP.depends_on IS NOT NULL — = "f"
      ok   A the fixture discriminates (real vs synthesised) — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"] !== ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      FAIL A deps == depends_on, verbatim — expected ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"], got ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      MISSED case A declares 5 assertion(s) but executed 3 — a case that does not run what it declares cannot certify anything.

--- case B: R54 — depends_on = '{}' is an EXPLICIT root: deps [], NOT the synthesised set
    B  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   B sentinel in the DATABASE: G_ROOT.depends_on IS NOT NULL — = "f"
      ok   B and it is empty — = "0"
      ok   B the fixture discriminates ([] vs synthesised) — [] !== ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      FAIL B deps == [] — expected [], got ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]

--- case C: R54 — a legacy row (depends_on IS NULL) keeps the synthesised strictly-lower set
    C  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   C sentinel in the DATABASE: L3.depends_on IS NULL — = "t"
      ok   C L3 (round 101) deps == the two round-100 rows — ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"]
      ok   C L1 deps == [] (no round below 100) — []
      ok   C L2 deps == [] — its sibling L1 is NOT a dep — []
      ok   C L2's deps do not name L1 — = false

--- case D: R54 — a MIXED project: both kinds of row in ONE response, and graph rows still feed the accumulator
    D  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   D the project holds 4 legacy rows and 3 graph rows — = "4|3"
      ok   D every seeded task is in the response — = 7
      ok   D L4 (legacy, round 104) sees every strictly-lower row INCLUDING the graph ones — ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"]
      FAIL D a dangling dep id survives to the client — expected ["00000000-0000-4000-8000-00000000bfff"], got ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005"]
      MISSED case D declares 5 assertion(s) but executed 4 — a case that does not run what it declares cannot certify anything.

--- case E: R55 — workstream present on every task; a non-'main' value survives verbatim
    E  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005"],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   E every task carries a workstream — = 7
      ok   E G_POP's non-default workstream survives — = "alpha"
      ok   E the other six are 'main' — = 6

--- case F: R55 — depth is the DERIVED longest path, and it DISAGREES with round
    F  depth-vs-round project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0002/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0002","project":{"id":"00000000-0000-4000-8000-00000000a002","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000c001","round":100,"role":"builder","title":"depth root","status":"done","tier":null,"deps":[],"workstream":"main","depth":0},{"id":"00000000-0000-4000-8000-00000000c002","round":101,"role":"builder","title":"depends on the root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000c001"],"workstream":"main","depth":1},{"id":"00000000-0000-4000-8000-00000000c003","round":102,"role":"builder","title":"ALSO depends only on the root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000c001","00000000-0000-4000-8000-00000000c002"],"workstream":"main","depth":1}],"title":"depth root"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   F D0 round — = 100
      ok   F D1 round — = 101
      ok   F D2 round — = 102
      ok   F D0 depth (explicit root) — = 0
      ok   F D1 depth — = 1
      ok   F D2 depth — 1, NOT 2: it depends only on D0 — = 1
      ok   F depth differs from round on every row of this fixture — = 3
      ok   F no graph_error on an acyclic graph — no 'graph_error' key

--- case G: R55 — a stored CYCLE: HTTP 200, graph_error naming the ids, every depth == its round
[chat plan] taskDepth refused the stored graph: task-graph: taskDepth(): 2 task(s) cannot be topologically ordered — depends_on contains a cycle through: 00000000-0000-4000-8000-00000000d001, 00000000-0000-4000-8000-00000000d002 (R19, R25)
    G  cyclic project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0003/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0003","project":{"id":"00000000-0000-4000-8000-00000000a003","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":200,"tasks":[{"id":"00000000-0000-4000-8000-00000000d001","round":200,"role":"builder","title":"cycle node 1","status":"done","tier":null,"deps":[],"workstream":"main","depth":200},{"id":"00000000-0000-4000-8000-00000000d002","round":201,"role":"builder","title":"cycle node 2","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000d001"],"workstream":"main","depth":201},{"id":"00000000-0000-4000-8000-00000000d003","round":202,"role":"builder","title":"graph ROOT outside the cycle","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000d001","00000000-0000-4000-8000-00000000d002"],"workstream":"main","depth":202}],"title":"cycle node 1"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located","graph_error":"task-graph: taskDepth(): 2 task(s) cannot be topologically ordered — depends_on contains a cycle through: 00000000-0000-4000-8000-00000000d001, 00000000-0000-4000-8000-00000000d002 (R19, R25)"}
      ok   G the cycle really is in the DATABASE (Y1→Y2, Y2→Y1) — = "t"
      ok   G status is 200, not 500 — = 200
      ok   G graph_error is present and a string — task-graph: taskDepth(): 2 task(s) cannot be topologically ordered — depends_on 
      ok   G graph_error names Y1 — body names "00000000-0000-4000-8000-00000000d001"
      ok   G graph_error names Y2 — body names "00000000-0000-4000-8000-00000000d002"
      ok   G Y1 depth == its round — = 200
      ok   G Y3 (graph root, round 202) depth == 202, NOT 0 — = 202
      ok   G every depth equals its round — = 3

--- case H: R56 — the projects router carries depends_on, workstream and write_set, and its two column lists agree
    H  GET /api/projects/00000000-0000-4000-8000-00000000a001 → 200
      ok   H detail status — = 200
      ok   H detail row for G_POP found — 7 tasks in the project
      ok   H detail depends_on (TASK_COLS) — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]
      ok   H detail workstream (TASK_COLS) — = "alpha"
      ok   H detail write_set (TASK_COLS) — ["forge-control/src/routes/chat.ts"]
    H  GET /api/projects/board → 200
      ok   H no TASK_COLS column is missing from TASK_COLS_PT — []
      ok   H TASK_COLS_PT adds only the joined project_name — ["project_name"]
      ok   H the board row's depends_on matches the detail row's — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]

--- census -------------------------------------------------------------------
  cases planned              : 8
  cases that ran an assertion: 8
  assertions declared        : 46
  assertions executed        : 43
  assertions failed          : 3
  FAIL executed 43 assertions but 46 are declared

FAILED — 3 case(s): A, B, D
  teardown           : schema tg_check_plan dropped, :7797 closed
exit=1
```

Case A went red exactly as the gate requires — and cases B and D with it, since
the `'{}'` root and the dangling dep are the same defect seen from two other
angles. The run exited **1**.

### 2.4 Mutation 2 — `depth` forced to return `round`, observed FAILING

```
$ perl -0pi -e 's/    return \{ depth: taskDepth\(graph\) \};/    \/* MUTATION 2 *\/ const m = new Map<string, number>(); for (const r of rows) m.set(r.id, r.round); void taskDepth; void graph; return { depth: m };/' forge-control/src/routes/chat.ts
$ grep -n 'MUTATION 2' forge-control/src/routes/chat.ts
831:    /* MUTATION 2 */ const m = new Map<string, number>(); … return { depth: m };
```

`chat.ts` sha256 in the header below: `1d0d5b68…` — a third distinct value.

```
$ ./node_modules/.bin/tsx ../scripts/checks/check-plan-api.ts ; echo "exit=$?"
=== check-plan-api.ts — provenance ===========================================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 4244b20
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control/src/db/projects.ts |  M forge-control/src/routes/chat.ts
  sha256             : 1d0d5b68eced7b16eab20e8dacf06c2ff7ed609557ad50042d05efafb7d1f1eb  forge-control/src/routes/chat.ts
  sha256             : 5e5850391feb11327ad22ad37d0b3ed9b55f53c251e8d2c90761f88d2fc152c3  forge-control/src/lib/task-graph.ts
  sha256             : f6ceb8cfd5b3cad624957f354360103f8ce13be2de446e549ab6b7ff890517e0  forge-control/src/routes/projects.ts
  sha256             : 9e5402f0847ad3f653aedfb93323a2e59b005812a11df774abe7bc04d314d08e  forge-control/src/db/projects.ts
  scratch database   : forge_tg_scratch (local; DSN never printed)
  throwaway schema   : tg_check_plan
  schema reached by  : PGOPTIONS=-c search_path=tg_check_plan (re-proved by control 0a)
  bind               : http://127.0.0.1:7797 (never 7700)
  mounts             : /api/chat, /api/projects
  migrations applied : 20 (+1 forced content_jobs placeholder)
  rows seeded        : 3 projects, 13 tasks
  cases to run       : 8
  assertions declared: 46
==============================================================================

--- 0a. positive control: is the CHAT router reading the scratch schema? ------
      GET /api/chat/00000000-0000-4000-8000-0000000f0001/plan → 200
      ok   chat.ts + chat-linkage.ts read tg_check_plan: chat 00000000-0000-4000-8000-0000000f0001 → project 00000000-0000-4000-8000-00000000a001
--- 0b. positive control: is the PROJECTS router reading the scratch schema? --
      GET /api/projects/00000000-0000-4000-8000-00000000a001 → 200
      ok   db/projects.ts reads tg_check_plan

--- case A: R54 — a graph row with a populated depends_on: deps is that array, ids AND order
    A  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":102},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":103},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   A sentinel in the DATABASE: G_POP.depends_on IS NOT NULL — = "f"
      ok   A the fixture discriminates (real vs synthesised) — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"] !== ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      ok   A deps == depends_on, verbatim — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]
      ok   A the declared order is not the round order — = true
      ok   A sibling graph row unaffected by A's read — []

--- case B: R54 — depends_on = '{}' is an EXPLICIT root: deps [], NOT the synthesised set
    B  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":102},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":103},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   B sentinel in the DATABASE: G_ROOT.depends_on IS NOT NULL — = "f"
      ok   B and it is empty — = "0"
      ok   B the fixture discriminates ([] vs synthesised) — [] !== ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003"]
      ok   B deps == [] — []

--- case C: R54 — a legacy row (depends_on IS NULL) keeps the synthesised strictly-lower set
    C  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":102},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":103},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   C sentinel in the DATABASE: L3.depends_on IS NULL — = "t"
      ok   C L3 (round 101) deps == the two round-100 rows — ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"]
      ok   C L1 deps == [] (no round below 100) — []
      ok   C L2 deps == [] — its sibling L1 is NOT a dep — []
      ok   C L2's deps do not name L1 — = false

--- case D: R54 — a MIXED project: both kinds of row in ONE response, and graph rows still feed the accumulator
    D  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":102},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":103},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   D the project holds 4 legacy rows and 3 graph rows — = "4|3"
      ok   D every seeded task is in the response — = 7
      ok   D L4 (legacy, round 104) sees every strictly-lower row INCLUDING the graph ones — ["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"]
      ok   D a dangling dep id survives to the client — ["00000000-0000-4000-8000-00000000bfff"]
      ok   D no graph_error on a well-formed graph — no 'graph_error' key

--- case E: R55 — workstream present on every task; a non-'main' value survives verbatim
    E  mixed project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0001/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0001","project":{"id":"00000000-0000-4000-8000-00000000a001","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000b001","round":100,"role":"builder","title":"legacy A at round 100","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b002","round":100,"role":"builder","title":"legacy B at round 100 (L1's sibling)","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000b003","round":101,"role":"builder","title":"legacy C at round 101","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000b004","round":102,"role":"builder","title":"graph row with real deps","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"],"workstream":"alpha","depth":102},{"id":"00000000-0000-4000-8000-00000000b005","round":102,"role":"builder","title":"graph row, EXPLICIT root","status":"done","tier":null,"deps":[],"workstream":"main","depth":102},{"id":"00000000-0000-4000-8000-00000000b006","round":103,"role":"builder","title":"graph row with a dangling dep","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000bfff"],"workstream":"main","depth":103},{"id":"00000000-0000-4000-8000-00000000b007","round":104,"role":"builder","title":"legacy D above the graph rows","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000b001","00000000-0000-4000-8000-00000000b002","00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b004","00000000-0000-4000-8000-00000000b005","00000000-0000-4000-8000-00000000b006"],"workstream":"main","depth":104}],"title":"legacy B at round 100 (L1's sibling)"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   E every task carries a workstream — = 7
      ok   E G_POP's non-default workstream survives — = "alpha"
      ok   E the other six are 'main' — = 6

--- case F: R55 — depth is the DERIVED longest path, and it DISAGREES with round
    F  depth-vs-round project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0002/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0002","project":{"id":"00000000-0000-4000-8000-00000000a002","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":100,"tasks":[{"id":"00000000-0000-4000-8000-00000000c001","round":100,"role":"builder","title":"depth root","status":"done","tier":null,"deps":[],"workstream":"main","depth":100},{"id":"00000000-0000-4000-8000-00000000c002","round":101,"role":"builder","title":"depends on the root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000c001"],"workstream":"main","depth":101},{"id":"00000000-0000-4000-8000-00000000c003","round":102,"role":"builder","title":"ALSO depends only on the root","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000c001"],"workstream":"main","depth":102}],"title":"depth root"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   F D0 round — = 100
      ok   F D1 round — = 101
      ok   F D2 round — = 102
      FAIL F D0 depth (explicit root) — expected 0, got 100
      MISSED case F declares 8 assertion(s) but executed 4 — a case that does not run what it declares cannot certify anything.

--- case G: R55 — a stored CYCLE: HTTP 200, graph_error naming the ids, every depth == its round
    G  cyclic project
      GET  /api/chat/00000000-0000-4000-8000-0000000f0003/plan
      res  200 {"chat_id":"00000000-0000-4000-8000-0000000f0003","project":{"id":"00000000-0000-4000-8000-00000000a003","status":"active"},"link_source":"metadata","link_ambiguous":false,"phases":[{"round_base":200,"tasks":[{"id":"00000000-0000-4000-8000-00000000d001","round":200,"role":"builder","title":"cycle node 1","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000d002"],"workstream":"main","depth":200},{"id":"00000000-0000-4000-8000-00000000d002","round":201,"role":"builder","title":"cycle node 2","status":"done","tier":null,"deps":["00000000-0000-4000-8000-00000000d001"],"workstream":"main","depth":201},{"id":"00000000-0000-4000-8000-00000000d003","round":202,"role":"builder","title":"graph ROOT outside the cycle","status":"done","tier":null,"deps":[],"workstream":"main","depth":202}],"title":"cycle node 1"}],"docs":[],"error":"project has no workspace_dir — plan docs cannot be located"}
      ok   G the cycle really is in the DATABASE (Y1→Y2, Y2→Y1) — = "t"
      ok   G status is 200, not 500 — = 200
      FAIL G graph_error is a string — got undefined
      MISSED case G declares 8 assertion(s) but executed 3 — a case that does not run what it declares cannot certify anything.

--- case H: R56 — the projects router carries depends_on, workstream and write_set, and its two column lists agree
    H  GET /api/projects/00000000-0000-4000-8000-00000000a001 → 200
      ok   H detail status — = 200
      ok   H detail row for G_POP found — 7 tasks in the project
      ok   H detail depends_on (TASK_COLS) — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]
      ok   H detail workstream (TASK_COLS) — = "alpha"
      ok   H detail write_set (TASK_COLS) — ["forge-control/src/routes/chat.ts"]
    H  GET /api/projects/board → 200
      ok   H no TASK_COLS column is missing from TASK_COLS_PT — []
      ok   H TASK_COLS_PT adds only the joined project_name — ["project_name"]
      ok   H the board row's depends_on matches the detail row's — ["00000000-0000-4000-8000-00000000b003","00000000-0000-4000-8000-00000000b001"]

--- census -------------------------------------------------------------------
  cases planned              : 8
  cases that ran an assertion: 8
  assertions declared        : 46
  assertions executed        : 37
  assertions failed          : 2
  FAIL executed 37 assertions but 46 are declared

FAILED — 2 case(s): F, G
  teardown           : schema tg_check_plan dropped, :7797 closed
exit=1
```

Case F went red on the first row it checked (`D0 depth expected 0, got 100`),
and case G with it — a `depth` that returns `round` never calls `taskDepth()`,
so the cycle is never detected and `graph_error` never appears. The run exited
**1**.

Restored afterwards, byte-for-byte:

```
$ cp /tmp/chat.ts.pristine forge-control/src/routes/chat.ts
$ sha256sum forge-control/src/routes/chat.ts
f682bddd1745f4267ae3d44fc0046dfaad8d605e6853b9afe10ba35334c9050d  forge-control/src/routes/chat.ts
$ grep -c MUTATION forge-control/src/routes/chat.ts
0
```

That is the same sha256 the clean run in §2.2 reports, so §2.2 certifies the
bytes that are committed.

### 2.5 Typechecks and the universal gate

The probe lives outside `forge-control/tsconfig.json`'s `"include":
["src/**/*.ts"]`, so `pnpm typecheck` never examines it — the same gap
`03-quality.md` §3.2 names for `scripts/measure-schedule.ts`. Its own
invocation, and its output (silence is a pass):

```
$ cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext \
    --moduleResolution bundler --lib ES2022 --skipLibCheck --allowImportingTsExtensions \
    --resolveJsonModule --types node ../scripts/checks/check-plan-api.ts
$ echo "exit=$?"
exit=0
```

`chat.ts` itself, compiled standalone under the same options:

```
$ cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext \
    --moduleResolution bundler --lib ES2022 --skipLibCheck --allowImportingTsExtensions \
    --resolveJsonModule --types node src/routes/chat.ts
$ echo "exit=$?"
exit=0
```

**Universal gate at the time this phase's code was written** — `pnpm typecheck`
clean and `pnpm test` green:

```
$ cd forge-control && pnpm typecheck
> tsc --noEmit
(no output)

$ cd forge-control && pnpm test
# pass 1070
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4873.598615
```

1070 rather than the 1009 the brief names as the baseline at `7efa36b`: phase 4
added 61 tests in `c2c22d5` and `4244b20`, which land on this branch below this
commit. **Zero skipped**, which is what §3.1 item 2 actually gates on.

**DISCLOSED — a later `pnpm typecheck` on this shared worktree is red, and not
from this phase.** After the mutation runs were finished and `chat.ts` restored,
`pnpm typecheck` reported errors in `forge-control/src/lib/project-tick.ts`
only:

```
$ cd forge-control && pnpm typecheck 2>&1 | grep -E '^src/' | sed 's/(.*//' | sort -u
src/lib/project-tick.ts
```

`project-tick.ts` is phase 4/5's file, uncommitted and mid-edit by a concurrent
builder in this shared worktree; this phase never touched it. The two proofs
that the red is not this phase's are above: `chat.ts` compiles clean standalone,
and the whole-project typecheck was clean when this phase's edits were made and
lists no file of this phase's write set now. Judge this phase's paths only, per
the round-222 brief's own note on `git status --porcelain` in this worktree.

**RESOLVED, and re-run at this phase's committed HEAD.** The concurrent builder
finished its edit; `project-tick.ts` compiles again. The whole gate, re-run
after both of this phase's commits had landed:

```
$ cd forge-control && pnpm typecheck
> tsc --noEmit
(no output — clean)

$ cd forge-control && pnpm test
# suites 195
# pass 1070
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4998.506188

$ ./node_modules/.bin/tsx ../scripts/checks/check-plan-api.ts | tail -3
  assertions failed          : 0
PASS — 8 cases, …
$ echo "exit=$?"
exit=0
```

That run's provenance header reads `git HEAD : 463803f` and
`sha256 : f682bddd…  forge-control/src/routes/chat.ts` — **the same `chat.ts`
digest as the clean run in §2.2**, so §2.2's transcript and this re-run certify
byte-identical code, and both certify what is committed. Its
`uncommitted (subj)` line still names `db/projects.ts`: phase 4 continues to
work beside this phase, and case H therefore still exercised an in-flight
`db/projects.ts` — on which `TASK_COLS` and `TASK_COLS_PT` agreed.

The live checkout was never touched:

```
$ git -C /opt/forge-ai-os status --porcelain
(no output — empty is the only pass)
```

Corpus gates:

```
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
OK — R1..R69 and NF1..NF7 complete, all three statements of the map agree.   (exit 0)

$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
OK — 8 pasted header(s) across 1 file(s) name f6828a68…
OK — no retired identity quoted without '[historical instrument]'            (exit 0)
```

---

## §3 — the web half: the mirrors, the chip, and the check that counts itself

Builder 6B, **round 223**. Written against builder 6A's landed commit `811e8c1`,
not against the brief: the route is the source of truth and this half mirrors
what it actually shipped. `graph_error` is mirrored because `chat.ts`'s
`interface PlanResponse` really carries it.

**Write set, declared (this is the input to contention, not archaeology):**

```
forge-control-web/app/desktop/team/planApi.ts        PlanTask/PlanResponse mirror, rotted pins
forge-control-web/app/desktop/team/planStore.ts      PlanNode, toPlanNodes, workstreamLabel
forge-control-web/app/desktop/team/PlanKanban.tsx    the chip, chipTitle, the block-number tooltip
forge-control-web/app/api.ts                         ProjectTask mirror (R56's web half)
scripts/checks/check-plan-store.ts                   extended: real edges, provenance, census
docs/plan/engine-task-graph/03-quality.md            §3.2's phase-6 gate block
docs/plan/engine-task-graph/evidence/phase6-plan-api.md   this section
```

Nothing outside it was written. `forge-control/src/routes/chat.ts` and
`scripts/checks/check-plan-api.ts` are 6A's and were read only.

### 3.1 The mirrors, all in one commit

They are hand-written on purpose — there is no shared build across the two
repos — so drift is the failure mode the mirroring accepts in exchange, and the
only defence is that every mirror moves together.

| type | gained | mirrored from |
|---|---|---|
| `planApi.ts:PlanTask` | `workstream: string`, `depth: number` | `chat.ts:`​`interface PlanTask` |
| `planApi.ts:PlanResponse` | `graph_error?: string` | `chat.ts:`​`interface PlanResponse` (verified present in `811e8c1`, not assumed from the brief) |
| `planApi.ts:PlanTask.deps` | doc-comment restated | `chat.ts:`​`groupPlanPhases`'s two branches |
| `planStore.ts:PlanNode` | `workstream`, `depth`, copied through by `toPlanNodes` | — |
| `app/api.ts:ProjectTask` | `depends_on: string[] \| null`, `workstream: string`, `write_set: string[]` | `db/projects.ts:`​`interface ProjectTask` |

`PlanTask.deps`'s comment said *"Coarse today (every task in a strictly lower
round)"*. That sentence is now FALSE for a graph row, so it was replaced rather
than softened: real `depends_on` when the engine recorded one — including `[]`,
an explicit root with no edges — and the synthesised strictly-lower-round set
for a legacy row, with the added fact that **both kinds can appear in one
response**, so no consumer may assume two tasks' edges came from the same rule.

`ProjectTask.depends_on` is typed `| null` and documented as a SENTINEL, not as
"missing": `null` selects the legacy scheduler, `[]` is an explicit graph root.
Those are the two values a `?? []` at a read site would merge, and they are
precisely the two that must never be merged. The doc-comment mirrors the
canonical statement on `ProjectTask.depends_on` in `db/projects.ts`.

**One drift observed and deliberately NOT repaired here:** `app/api.ts`'s
`ProjectTask` has been missing `attempt` (migration 0037) and `chain_key`
(migration 0039) since before this project. It is real drift of the same kind,
but repairing it is neither R56 nor this round's brief, and adding two fields
nothing on this branch reads would be scope this builder did not price. Recorded
so the next audit resolves it without archaeology.

### 3.2 The rotted citations, repaired — standing rule 1

A finding handed to this builder by the planner, in a file this builder owns.

| the pin, as it read | resolved at git SHA `7efa36b` | replaced with |
|---|---|---|
| header: `chat.ts` "(interfaces PlanTask / PlanPhase / PlanResponse, lines 650-689)" | the three interfaces sat at **657-667, 669-682, 684-706** | `chat.ts:`​`interface PlanTask` / `interface PlanPhase` / `interface PlanResponse` |
| `PlanTask`: "See chat.ts:650-660." | 657-667 | ``chat.ts:`interface PlanTask` `` |
| `PlanPhase`: "chat.ts:662-674." | 669-682 | ``chat.ts:`interface PlanPhase` `` |
| `PlanResponse`: "chat.ts:676-689." | 684-706 | ``chat.ts:`interface PlanResponse` `` |

They were **not re-pinned to fresh line numbers**: `811e8c1` moved those
interfaces again the same night, which is the whole argument. A symbol name
cannot rot. The header now records the old pins, the SHA they were resolved
against and why they are gone, so the repair is legible rather than silent.

### 3.3 `check-plan-store.ts`, green — full output, provenance header first

Run from the worktree, `git HEAD 417be41`:

```
cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts
```

```
=== check-plan-store.ts — provenance ========================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 417be41
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control-web/app/desktop/team/planApi.ts |  M forge-control-web/app/desktop/team/planStore.ts |  M scripts/checks/check-plan-store.ts
  sha256             : 729fe2e462c47dd43df03df0312d7defbddc9cd22198233833cf3677f67f8383  forge-control-web/app/desktop/team/planStore.ts
  sha256             : 31ec8e5f750a3d149586324de2f78e5f9b115faade98949a6c6d4bbf12ccc631  forge-control-web/app/desktop/team/planApi.ts
  sha256             : 541eaa597faf338a055059ea292f9a9cc30d98370c20976e07bd9a7b449bdde6  scripts/checks/check-plan-store.ts
  fixture nodes      : 24 (hand count 24)
  assertions declared: 107
============================================================

── toPlanNodes ──────────────────────────────────────────────
PASS  flattens every task in every phase
PASS  preserves server order — first node is round 0
PASS  preserves server order — last node is round 706
PASS  rounds come out ascending, exactly as the server ordered them
PASS  a node is the U27 shape and nothing else
PASS  deps are copied, not aliased to the wire array
PASS  …and copied faithfully
PASS  empty phases[] → no nodes

── meta.tier / meta.run_id ──────────────────────────────────
PASS  tier 'flagship' lands on meta.tier
PASS  tier 'standard' lands on meta.tier
PASS  tier: null → meta has NO tier key
PASS  …and meta serialises as {} , not {"tier":null}
PASS  run_id is unset — the wire does not carry it today

── unknown status survives ──────────────────────────────────
PASS  an unrecognised status reaches the node VERBATIM
PASS  KNOWN_STATUSES does not contain it
PASS  …and it is not silently dropped from the array
PASS  it counts as NOT done
PASS  …while still counting toward total
PASS  its group counts it in total, not in done
PASS  …same group, total 1

── statusTokenName ──────────────────────────────────────────
PASS  KNOWN_STATUSES is the migration's CHECK list, in lifecycle order
PASS  pending  → textMuted
PASS  ready    → textMuted
PASS  running  → info
PASS  done     → ok
PASS  failed   → bleed
PASS  blocked  → stuck, never the running colour
PASS  blocked is not folded into running
PASS  unknown  → textFaint (TeamRow's own fallback)
PASS  cancelled → textFaint, where TeamRow puts it
PASS  empty string → textFaint, not a crash
PASS  'DONE' is not 'done' — status compare is exact
PASS  every known status has a non-fallback token: pending
PASS  every known status has a non-fallback token: ready
PASS  every known status has a non-fallback token: running
PASS  every known status has a non-fallback token: done
PASS  every known status has a non-fallback token: failed
PASS  every known status has a non-fallback token: blocked

── phaseBase ────────────────────────────────────────────────
PASS  0   → 0
PASS  1   → 0
PASS  99  → 0
PASS  100 → 100
PASS  606 → 600
PASS  703 → 700

── groupPlanPhases ──────────────────────────────────────────
PASS  eight blocks across rounds 0..706
PASS  ascending by block: 0,100,…,700
PASS  every node lands in exactly one column
PASS  column totals sum to the node count
PASS  column done-counts sum to planProgress().done
PASS  block 600: 2 of 3 done (606 is running)
PASS  block 700: 2 of 8 done (pending, pending, harvesting, pending, running, blocked)
PASS  title comes from the server
PASS  doc_path comes from the server
PASS  a server phase with no title → no title key
PASS  a server phase with no doc_path → no doc_path key
PASS  …and that block still has its title
PASS  column membership is by round, in server order
PASS  empty phases[] → no columns
PASS  a node outside every server phase still gets a column
PASS  …carrying its derived base
PASS  …and no invented title

── planProgress (must byte-match the rail badge SQL) ─────────
PASS  done — EXACTLY status === 'done'
PASS  total — every node, no status excluded
PASS  done equals a hand filter over the same rule
PASS  a failed task is in total and not in done
PASS  …and still in total
PASS  empty plan → 0/0, not a divide-by-zero anywhere
PASS  empty phases[] → 0/0

── planEdges (the whole graph projection) ───────────────────
PASS  one edge per dep, no more
PASS  …which is exactly the sum of deps.length
PASS  every edge's source is a dep of its target
PASS  edges point dep → dependent, in node order
PASS  a node with 3 deps yields 3 edges, one per dep
PASS  no deps → no edges
PASS  empty plan → no edges
PASS  empty phases[] → no edges

── workstream / depth pass through toPlanNodes (R55) ────────
PASS  every depth arrives verbatim, in node order
PASS  depth is NOT the round: only t-0 and t-1 agree, by coincidence of numbering
PASS  t-704 depth is 1 — three orders of magnitude off its round
PASS  …and its round is still 704
PASS  the non-`main` rows arrive with their workstream verbatim
PASS  a row that asks for nothing is `main`, the column default
PASS  no node leaks an undefined workstream
PASS  no node leaks an undefined depth

── workstreamLabel — the chip's whole rule (R55) ────────────
PASS  `main` → undefined: no chip, no placeholder, no dash
PASS  `ui` → 'ui'
PASS  `Main` → 'Main' — case-sensitive, never folded to `main`
PASS  the empty string → '' verbatim, not undefined
PASS  …and specifically NOT undefined
PASS  on the real corpus: t-0 is main → undefined
PASS  on the real corpus: t-704 → 'ui'
PASS  exactly two of twenty-four rows would wear a chip

── edges the coarse rule could NEVER have produced (R54) ────
PASS  t-704 waits on ONE task, five phase blocks below it
PASS  …which is block 100 while t-704 sits in block 700
PASS  the real dep set is NOT the synthesised one — the fixture discriminates — ["t-101"] !== ["t-0","t-1","t-100","t-101","t-200","t-201","t-300","t-301","t-302","t-400","t-401","t-500","t-501","t-600","t-601","t-606","t-700","t-701","t-702","t-703"]
PASS  the synthesised set would have owed it all 20 rows below
PASS  the two siblings share a round
PASS  …and have DIFFERENT dep sets, which was impossible before R54 — ["t-700"] !== ["t-701","t-702"]
PASS  sibling a waits on t-700 alone
PASS  sibling b waits on t-701 and t-702
PASS  the coarse rule would have given both siblings the identical set

── the dangling edge, emitted on purpose (R54/R27) ──────────
PASS  `t-missing` names no node in the set
PASS  …and planEdges emits its edge anyway, verbatim
PASS  the dangling id also survives on the node itself

── depth disagrees with round; grouping follows ROUND (R55) ─
PASS  t-704 groups under 700, by its ROUND
PASS  …while its depth would have grouped it under 0
PASS  the extreme case too: round 101 with depth 703 is still block 100

── census ───────────────────────────────────────────────────
  fixture nodes        : 24
  assertions declared  : 107
  assertions executed  : 107
  assertions failed    : 0

ALL PASS — U27 plan store
EXIT=0
```

The subject files read `M` in the header because this transcript was taken
**before** the commit that lands them; their sha256 is what identifies the
bytes, and it is the sha256 that differs in every mutation below.

**The fixture gained four rows the coarse rule could never have produced:**

| row | round | deps | why it exists |
|---|---|---|---|
| `t-704` | 704 | `[t-101]` | a dep that **skips five phase blocks**. The synthesis owed round 704 all 20 rows below it; the real set is one id from block 100. Workstream `ui`, depth 1. |
| `t-705a` | 705 | `[t-700]` | two **same-round siblings with different dep sets** — impossible under a rule that gave same-round siblings identical sets by construction. `t-705a` also carries workstream `api-v2`. |
| `t-705b` | 705 | `[t-701, t-702]` | ↑ |
| `t-706` | 706 | `[t-missing]` | a dep naming **no row in the set**. 6A's route emits a dangling id verbatim on purpose (R27 makes one unreachable through the API, so one arriving means a corrupt row and the panel is the surface that must show it). `planEdges` must therefore emit the edge, and does. |

Hand counts, re-derived and updated: 24 tasks, 17 done, **11 edges**, 2 non-`main`
workstreams, and — the discriminating one — **only 2 of 24 rows have
`depth === round`**.

### 3.4 The three mutations, observed FAILING

Each was applied to the shipped bytes, run, and reverted. **Read the `sha256`
line of each header**: it is a different file from the green run above, which is
what makes these transcripts evidence rather than assertion.

#### Mutation 1 — `planEdges` drops the last dep of every node

`n.deps.map(...)` → `n.deps.slice(0, -1).map(...)`. Exit **1**, five assertions red,
including the exact-edge case and the dangling-edge case.

```
=== check-plan-store.ts — provenance ========================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 417be41
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control-web/app/desktop/team/planApi.ts |  M forge-control-web/app/desktop/team/planStore.ts |  M scripts/checks/check-plan-store.ts
  sha256             : b268e8bf1618347aa1eec3853b3b22e625897cef6cbde032528dbec759d6178c  forge-control-web/app/desktop/team/planStore.ts
  sha256             : 31ec8e5f750a3d149586324de2f78e5f9b115faade98949a6c6d4bbf12ccc631  forge-control-web/app/desktop/team/planApi.ts
  sha256             : 541eaa597faf338a055059ea292f9a9cc30d98370c20976e07bd9a7b449bdde6  scripts/checks/check-plan-store.ts
  fixture nodes      : 24 (hand count 24)
  assertions declared: 107
============================================================

[ELIDED: the sections not named below are byte-identical to the green run in §3.3.]

── planEdges (the whole graph projection) ───────────────────
FAIL  one edge per dep, no more
        expected 11, got 3
FAIL  …which is exactly the sum of deps.length
        expected 11, got 3
PASS  every edge's source is a dep of its target
FAIL  edges point dep → dependent, in node order
        expected [{"source":"t-0","target":"t-1"},{"source":"t-0","target":"t-100"},{"source":"t-1","target":"t-100"},{"source":"t-700","target":"t-701"},{"source":"t-700","target":"t-703"},{"source":"t-701","target":"t-703"},{"source":"t-101","target":"t-704"},{"source":"t-700","target":"t-705a"},{"source":"t-701","target":"t-705b"},{"source":"t-702","target":"t-705b"},{"source":"t-missing","target":"t-706"}]
        got      [{"source":"t-0","target":"t-100"},{"source":"t-700","target":"t-703"},{"source":"t-701","target":"t-705b"}]
FAIL  a node with 3 deps yields 3 edges, one per dep
        expected [{"source":"a","target":"x"},{"source":"b","target":"x"},{"source":"c","target":"x"}]
        got      [{"source":"a","target":"x"},{"source":"b","target":"x"}]
PASS  no deps → no edges
PASS  empty plan → no edges
PASS  empty phases[] → no edges


── the dangling edge, emitted on purpose (R54/R27) ──────────
PASS  `t-missing` names no node in the set
FAIL  …and planEdges emits its edge anyway, verbatim
        expected true, got false
PASS  the dangling id also survives on the node itself


── census ───────────────────────────────────────────────────
  fixture nodes        : 24
  assertions declared  : 107
  assertions executed  : 107
  assertions failed    : 5

5 FAILURE(S) — see the census above — U27 plan store
EXIT=1
```

#### Mutation 2 — `workstreamLabel` returns the workstream for `main` too

`node.workstream === MAIN_WORKSTREAM ? undefined : node.workstream` →
`node.workstream`. Exit **1**, three assertions red: the rule itself, the same
rule over a real corpus row, and the "exactly two of twenty-four rows would wear
a chip" count that catches a badge on all sixty rows.

```
=== check-plan-store.ts — provenance ========================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 417be41
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control-web/app/desktop/team/planApi.ts |  M forge-control-web/app/desktop/team/planStore.ts |  M scripts/checks/check-plan-store.ts
  sha256             : 20cc1d35af004b2ee4973c83dd2ad466316eadcfbb2f7664eeef48d45730b9bd  forge-control-web/app/desktop/team/planStore.ts
  sha256             : 31ec8e5f750a3d149586324de2f78e5f9b115faade98949a6c6d4bbf12ccc631  forge-control-web/app/desktop/team/planApi.ts
  sha256             : 541eaa597faf338a055059ea292f9a9cc30d98370c20976e07bd9a7b449bdde6  scripts/checks/check-plan-store.ts
  fixture nodes      : 24 (hand count 24)
  assertions declared: 107
============================================================

[ELIDED: the sections not named below are byte-identical to the green run in §3.3.]

── workstreamLabel — the chip's whole rule (R55) ────────────
FAIL  `main` → undefined: no chip, no placeholder, no dash
        expected undefined, got main
PASS  `ui` → 'ui'
PASS  `Main` → 'Main' — case-sensitive, never folded to `main`
PASS  the empty string → '' verbatim, not undefined
PASS  …and specifically NOT undefined
FAIL  on the real corpus: t-0 is main → undefined
        expected undefined, got main
PASS  on the real corpus: t-704 → 'ui'
FAIL  exactly two of twenty-four rows would wear a chip
        expected 2, got 24


── census ───────────────────────────────────────────────────
  fixture nodes        : 24
  assertions declared  : 107
  assertions executed  : 107
  assertions failed    : 3

3 FAILURE(S) — see the census above — U27 plan store
EXIT=1
```

#### Mutation 3 — a case DECLARED but never REACHED

One `check(...)` line commented out. **Zero assertions fail. Every printed line
says PASS. The run still exits 1**, because 106 ≠ 107. This is the mutation that
proves the census is not decoration: before this round the same edit printed
`ALL PASS` and exited 0.

```
=== check-plan-store.ts — provenance ========================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 417be41
  git branch         : project/8c591d6c
  uncommitted (subj) : M forge-control-web/app/desktop/team/planApi.ts |  M forge-control-web/app/desktop/team/planStore.ts |  M scripts/checks/check-plan-store.ts
  sha256             : 729fe2e462c47dd43df03df0312d7defbddc9cd22198233833cf3677f67f8383  forge-control-web/app/desktop/team/planStore.ts
  sha256             : 31ec8e5f750a3d149586324de2f78e5f9b115faade98949a6c6d4bbf12ccc631  forge-control-web/app/desktop/team/planApi.ts
  sha256             : 2083b39eea8aa35cbf8d85709ff208328f6d3c23104db1ff4079fb8cba90018c  scripts/checks/check-plan-store.ts
  fixture nodes      : 24 (hand count 24)
  assertions declared: 107
============================================================

[ELIDED: the sections not named below are byte-identical to the green run in §3.3.]

── workstreamLabel — the chip's whole rule (R55) ────────────
PASS  `main` → undefined: no chip, no placeholder, no dash
PASS  `ui` → 'ui'
PASS  `Main` → 'Main' — case-sensitive, never folded to `main`
PASS  the empty string → '' verbatim, not undefined
PASS  …and specifically NOT undefined
PASS  on the real corpus: t-0 is main → undefined
PASS  exactly two of twenty-four rows would wear a chip


── census ───────────────────────────────────────────────────
  fixture nodes        : 24
  assertions declared  : 107
  assertions executed  : 106
  assertions failed    : 0
  FAIL executed 106 assertions but 107 are declared — a check that does not run what it declares cannot certify anything.

FAILED — every assertion that ran was green, but the census above rejected the run — U27 plan store
EXIT=1
```

### 3.5 The gate this phase needed, and the gate lines that now exist

`03-quality.md` §3.1's universal gate runs `pnpm typecheck` **in `forge-control/`
only**, against a `tsconfig.json` whose `include` is `["src/**/*.ts"]`. Four of
this round's six code files live in `forge-control-web/`, a separate project the
universal gate never invokes — so the gate would have reported "`tsc --noEmit`
clean" for a phase whose principal deliverable was not compiled at all. Same
species as phase 7's `measure-schedule.ts` gap ("Added round 212"), same repair:
**amended where it is enforced, in this commit** — `03-quality.md` §3.2's
**Phase 6 — observability** block now carries the install precondition and the
three commands, with the reasoning inline.

The precondition is the part that makes the gate **satisfiable rather than
merely plausible**: this worktree ships without `forge-control-web/node_modules`
(gitignored), so a reviewer's first `npx tsc` in a fresh worktree answers
`tsc: not found` — and a gate whose first response is an error is a gate that
gets disclosed-and-ignored. Measured at round 221, it completes offline in ~1s
from the local pnpm store. `--frozen-lockfile` is what keeps the NFU8 diff empty
and is not optional.

Run here, in order:

```
$ cd forge-control-web && npx tsc --noEmit
WEB_TSC_EXIT=0

$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts
ALL PASS — U27 plan store        (exit 0; full transcript in §3.3)

$ git diff main -- forge-control-web/package.json
[[[ package.json diff bytes: 0 ]]]
```

**NFU8 holds: the diff is empty.** No `@xyflow/react`, no `elkjs`, no renderer,
no layout library. Drawing the node-link view is N4 and out of scope; what this
round shipped is the data it will consume.

The universal gate, re-run at this tree:

```
$ cd forge-control && pnpm typecheck            # exit 0
$ cd forge-control && pnpm test                 # tests 1113 | pass 1113 | fail 0 | skipped 0 | todo 0
$ git -C /opt/forge-ai-os status --porcelain    # empty
$ python3 docs/plan/engine-task-graph/check-corpus-map.py         # OK, exit 0
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py # OK, exit 0
```

The 1113 is not the brief's 1009 baseline at `7efa36b`; rounds 221 and 222 added
tests in `task-graph.test.ts`, `task-graph-replay.test.ts` and
`project-tick.test.ts`. **This round added no test to `forge-control/`** — its
whole test surface is `check-plan-store.ts` — so the delta belongs to phase 4,
not here.

**A fourth command a reviewer may run, recorded rather than made a gate clause.**
`tsx` strips types without checking them, and `scripts/checks/*.ts` is outside
both projects' `include`, so this round's check script is compiled by nothing.
Measured, exit 0:

```
cd forge-control-web && npx tsc --noEmit --strict --target ES2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --types node --lib ES2022 \
  ../scripts/checks/check-plan-store.ts
```

It is **not** added to §3.2 by this builder because the same gap covers 6A's
`check-plan-api.ts`, which this builder does not own — and a gate clause written
across another builder's file is exactly the undeclared cross-write §10 exists
to stop. Handed to the phase-6 reviewer as a decision, not taken silently.

### 3.6 What would have made MY instruments report a pass wrongly

Three mechanisms, each shown impossible in what shipped.

**(a) A fixture whose real deps happen to equal the synthesised set.** If every
fixture row's `deps` were "everything in a strictly lower round", the check
could not tell which branch of `groupPlanPhases` produced them, and a green run
would prove nothing about R54. Closed mechanically, not by inspection:
`synthesised(id)` reimplements the old rule inside the check, and
`checkDiffers` **fails when the two sides are equal** —
`["t-101"] !== ["t-0",…,"t-703"]` is printed in the transcript, so a fixture
edited into coincidence goes red instead of certifying. The sibling case is the
same guard from the other side: it asserts that the synthesised sets of `t-705a`
and `t-705b` are **identical** while their real sets differ, which is only
possible if the real ones are not synthesised.

**(b) A check whose new cases were declared but never reached the assertion
counter.** This is failure mode (b) in the script's own header and mutation 3 in
§3.4: `DECLARED_ASSERTIONS = 107` is hand-derived section by section, every
assertion helper increments `executed`, and the census exits non-zero when the
two differ **in either direction** — so both a skipped case and an accidentally
duplicated one are caught. The hand count is not decorative: it was wrong on
first derivation (`HAND_DEPTH_EQUALS_ROUND` was written 1 and is 2, because
`t-1` is round 1 at depth 1), the check caught it, and the **hand count was
corrected rather than the assertion loosened**. Also guarded: `node(id)` throws
by name instead of returning `undefined`, so a renamed fixture row cannot turn
an assertion into a silently skipped one; and `NODES.length` is asserted against
`HAND_TOTAL` in the census, because every expected value was derived from it.

**(c) `depth` mirroring `round` in the fixture.** The plausible typo in
`toPlanNodes` is `depth: t.round`. A fixture whose depths equalled its rounds
would pass with that typo in place. Every fixture depth is instead the true
longest path over the fixture's own deps, so **22 of 24 rows disagree** with
their round and the verbatim-depth array assertion goes red on that typo. The
count of agreeing rows is itself asserted (`HAND_DEPTH_EQUALS_ROUND = 2`), so a
future edit that quietly aligns depths with rounds — restoring the blind spot —
fails too.

**(d) A transcript that names a worktree instead of a build.** The header now
prints `git HEAD`, the branch, the uncommitted status of each subject file and
the **sha256 of `planStore.ts`, `planApi.ts` and the check script itself**. Every
mutation transcript in §3.4 carries a different sha256 from §3.3's, which is
what makes the pair readable as evidence.

### 3.7 Two decisions this round had to take

**The empty workstream.** `workstreamLabel("")` returns `""` verbatim, not
`undefined`. `validateWorkstream` refuses `''` upstream and the column is
NOT NULL DEFAULT `'main'`, so it cannot arrive through the API — only from a
hand-written row. Returning `undefined` would file a corrupt row under "ordinary
`main` task" and hide it; returning it verbatim renders an empty chip carrying
`data-plan-workstream=""`, a visible anomaly a reader can ask about. The rule is
"not `main`", and `''` is not `main` — the same NFU6 discipline this module
already applies to an unrecognised status. Asserted both ways in §3.3.

**The phase label that can cross a block boundary (phase 4B's hand-off).** R42's
`round+1` fix-chain placement can put a group-99 fix builder at round 100, which
`floor(round / 100) * 100` files under the NEXT phase block from the group that
spawned it. **Chosen: show the label as derived-and-possibly-crossing; do not
regroup.** Regrouping is not available to this component and should not be —
R55 fixes the grouping expression, the wire carries no `chain_key`, and a client
re-deriving membership would eventually disagree with the server's own phase
blocks and 404 a `doc_path` in the reader's face. So the block number in
`PlanKanban.tsx` carries a native tooltip saying the block is a numbering
convention, that nothing is scheduled by it, and that a fix chain created at a
boundary can appear there rather than under its originating group.
`planStore.ts:`​`groupPlanPhases`'s doc-comment states the same thing where the
rule lives. Reachability is low (99 dependency levels inside one phase block);
this is correctness-of-display, and it is disclosed on the surface rather than
silently misfiled.

### 3.8 Silent-fallback audit (§3.1 item 6) — everything this round added

| site | what it is | why it is not a swallowed error |
|---|---|---|
| `planStore.ts:`​`workstreamLabel` — `=== MAIN_WORKSTREAM ? undefined : …` | a deliberate ternary, not a default | `undefined` here means "print nothing", the requirement's own answer for `main`. Nothing is coerced: every other string, including `''` and `Main`, comes back verbatim. |
| `PlanKanban.tsx` — `workstream !== undefined && (…)` | a render guard | The exact condition above, read once. No `??`, no truthiness — `''` is falsy and would have been dropped by a truthiness test, which is the bug this spelling avoids. |
| `check-plan-store.ts:`​`git()` — `catch` returning `UNAVAILABLE (…)` | the only catch added | It does not degrade to a plausible value: the header prints the literal word `UNAVAILABLE` with the error's first line, so a run that cannot name its build says so on its first line instead of printing a confident wrong SHA. It cannot mask a subject-file failure — `sha256()` has no catch and aborts the run. |
| `check-plan-store.ts:`​`node(id)` — `throw` on a missing fixture row | the opposite of a fallback | Added *because* `NODES.find(...)!` would let a renamed row become `undefined` and then a silently skipped assertion. |

`chipTitle` gained two fields and no fallback; `tier`'s pre-existing
`?? "engine default"` is unchanged and is a label for a real fact (null means
"the engine picks"), not a swallowed value.

### 3.9 Requirements this round discharges

| id | artefact |
|---|---|
| R54 (web half) | `planApi.ts:`​`PlanTask.deps` restated; `check-plan-store.ts`'s "edges the coarse rule could NEVER have produced" and "the dangling edge" sections; §3.3, §3.4 mutation 1 |
| R55 | `planStore.ts:`​`PlanNode.workstream`/`.depth`, `workstreamLabel`; `PlanKanban.tsx`'s chip, `chipTitle`, `data-plan-workstream`; the "grouping follows ROUND" section; §3.4 mutation 2 |
| R56 (web half) | `app/api.ts:`​`ProjectTask` gains `depends_on`, `workstream`, `write_set`, mirroring `db/projects.ts:`​`interface ProjectTask` |
| NFU8 | `git diff main -- forge-control-web/package.json` empty (§3.5) |
| standing rule 1 | §3.2 — four rotted pins resolved at a recorded SHA and replaced by symbols |
| standing rule 2 | §3.5 — `03-quality.md` §3.2's phase-6 gate amended where it is enforced, in this commit |
| standing rule 3 | §3.3's provenance header, §3.4's three mutations, §3.6's four mechanisms |

### 3.10 Re-run AFTER the commit — the header that names the shipped build

§3.3's transcript reads `M` on all three subject files, because it was taken
before the commit that lands them. A provenance header stamped with `git HEAD`
goes stale the moment it lands — the lesson of `evidence/phase2-cycle-2.md` §3
mutation 5, where a gate was checked green and became unsatisfiable on commit.
So the check is re-run **at the commit**, and this is the header and census that
name the bytes actually on the branch:

```
=== check-plan-store.ts — provenance ========================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 9b04039
  git branch         : project/8c591d6c
  uncommitted (subj) : none
  sha256             : 729fe2e462c47dd43df03df0312d7defbddc9cd22198233833cf3677f67f8383  forge-control-web/app/desktop/team/planStore.ts
  sha256             : 31ec8e5f750a3d149586324de2f78e5f9b115faade98949a6c6d4bbf12ccc631  forge-control-web/app/desktop/team/planApi.ts
  sha256             : 541eaa597faf338a055059ea292f9a9cc30d98370c20976e07bd9a7b449bdde6  scripts/checks/check-plan-store.ts
  fixture nodes      : 24 (hand count 24)
  assertions declared: 107
============================================================

[ELIDED: the 107 PASS lines are byte-identical to §3.3.]

  fixture nodes        : 24
  assertions declared  : 107
  assertions executed  : 107
  assertions failed    : 0

ALL PASS — U27 plan store
EXIT=0
```

`git HEAD 9b04039`, `uncommitted (subj) : none`, and the three sha256 values
identical to §3.3's — which is the point: the green run in §3.3 was made against
exactly these bytes, and the mutation runs in §3.4 were not.

---

## §4 — R58, round 231: the spawn log names the workstream and the dependency count

Builder 6C. One requirement, `spawnTaskRuns()` in
`forge-control/src/lib/project-tick.ts`, and the corpus row 04-phases.md §10
requires alongside it.

### 4.1 The ruling this task ran under, restated

R58 belongs to phase 6 (01-requirements.md §G; 04-phases.md §9). Its only
implementation site, `spawnTaskRuns()`, lives in `project-tick.ts` — a file
04-phases.md §10's ownership table assigns to phases **4** (spawn/log) and
**5** (prompts), never 6. The round-221 planner found the gap: R58's
requirement and R58's file were owned by different phases. The ruling, taken
under the same precedent §10 already sets for the round-213 and round-215
out-of-set writes (**disclose, not abstain**): phase 6 writes the spawn log
line at a round strictly *after* every phase-4 round including its fix cycles
(phase 4's fix cycles were live in this worktree through round 223, so round
231 could not collide with a live phase-4 builder), and the write is recorded
in 04-phases.md §10 in the same commit that makes it. Phase 5's round-500+
rewrite of the prompt constants in the same file is a different, later edit to
a different part of the file; `formatSpawnLog()` is not a prompt constant and
does not collide with it.

### 4.2 The change — `spawnTaskRuns()` → `formatSpawnLog()`

**Before** (verified at git SHA `7efa36b`, the log call inline in
`spawnTaskRuns()`):

```ts
console.log(
  `[project-tick] spawned ${task.role} run ${run.id} for task ${task.id} ` +
    `(round ${task.round}, tier ${task.tier ?? "role-default"}) — ` +
    `${task.project.name} · ${task.title}`,
);
```

Rendered example: `[project-tick] spawned builder run <id> for task <id> (round 1, tier role-default) — Test Project · Do it`

**After.** The text moved into a new pure, exported function, `formatSpawnLog()`
(placed just above `emptyWriteSetWarning()`, matching that function's existing
`Pick<ProjectTask, …>` + `projectName: string` shape so the two read as one
family). `spawnTaskRuns()` now calls it:

```ts
console.log(formatSpawnLog(task, run.id, task.project.name));
```

```ts
export function formatSpawnLog(
  task: Pick<ProjectTask, "id" | "role" | "round" | "tier" | "workstream" | "depends_on" | "title">,
  runId: string,
  projectName: string,
): string {
  const deps = task.depends_on === null ? "legacy" : String(task.depends_on.length);
  return (
    `[project-tick] spawned ${task.role} run ${runId} for task ${task.id} ` +
    `(round ${task.round}, tier ${task.tier ?? "role-default"}, workstream=${task.workstream}, deps=${deps}) — ` +
    `${projectName} · ${task.title}`
  );
}
```

Rendered examples (all taken from the test suite's actual assertions, §4.3
below):

| case | rendered line |
|---|---|
| graph row, 3 deps | `[project-tick] spawned builder run run-1 for task t1 (round 1, tier role-default, workstream=main, deps=3) — Test Project · Do it` |
| graph row, `[]` | `[project-tick] spawned builder run run-1 for task t1 (round 1, tier role-default, workstream=main, deps=0) — Test Project · Do it` |
| legacy row, `null` | `[project-tick] spawned builder run run-1 for task t1 (round 1, tier role-default, workstream=main, deps=legacy) — Test Project · Do it` |
| non-main workstream | `[project-tick] spawned builder run run-1 for task t1 (round 1, tier role-default, workstream=ui, deps=0) — Test Project · Do it` |

The existing fields (`role`, `run.id`/`runId`, `task.id`, `round`, `tier`) keep
their exact order and wording; `workstream=` and `deps=` are appended inside
the same parenthesised group, as the brief required. `deps` distinguishes the
`depends_on` sentinel with a single `task.depends_on === null` test — never
`?? []`, never a truthiness check on `task.depends_on` (an empty array `[]` is
falsy and a truthiness test would have printed `deps=legacy` for a real graph
root, the opposite bug from the one NF1 forbids but a lie all the same).

### 4.3 The test — `project-tick.test.ts`, "R58 spawn log — workstream and dependency count"

`formatSpawnLog` is a pure function of plain data, so the new `describe` block
imports it directly (`import { formatSpawnLog } from "./project-tick.ts"`,
appended after the R70/close-gate block) and reuses the file's existing `task()`
factory — no value import of `db/*`, no pg `Pool`, hermetic per NF3.

Five cases, appended, never editing an existing assertion:

```
# Subtest: R58 spawn log — workstream and dependency count
    # Subtest: a graph row with three deps renders deps=3
    ok 1 - a graph row with three deps renders deps=3
    # Subtest: a graph row with an empty depends_on array renders deps=0
    ok 2 - a graph row with an empty depends_on array renders deps=0
    # Subtest: a NULL depends_on (the legacy sentinel) renders deps=legacy, never deps=0
    ok 3 - a NULL depends_on (the legacy sentinel) renders deps=legacy, never deps=0
    # Subtest: workstream 'main' is printed, not omitted
    ok 4 - workstream 'main' is printed, not omitted
    # Subtest: a non-main workstream is printed by name
    ok 5 - a non-main workstream is printed by name
    1..5
ok 122 - R58 spawn log — workstream and dependency count
```

**The call site, so the test is not a formatter tested in isolation that the
spawner never actually calls** — the failure mode this section's closing
paragraph names explicitly. `spawnTaskRuns()`'s only `console.log` in its spawn
path is now:

```ts
console.log(formatSpawnLog(task, run.id, task.project.name));
```

one call, on the line the pre-existing "R17 warn clause" test already asserts
comes immediately before `emptyWriteSetWarning(task, task.project.name)` — see
§4.5.

### 4.4 The full suite, at this commit

```
$ pnpm typecheck
> forge-control@0.1.0 typecheck
> tsc --noEmit
[clean, zero errors]

$ pnpm test
...
# tests 1118
# suites 202
# pass 1118
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Baseline at `7efa36b` was 1009 pass (brief's figure); the corpus has grown by
109 tests across the intervening rounds. All 1118 pass, zero skipped.

### 4.5 One pre-existing assertion had to change, and why (standing rule 4)

`project-tick.test.ts`'s "R17 warn clause — an undeclared builder is named at
spawn" describe block already contained a structural test, "the spawn path
emits it once per spawn, beside the spawn line", predating this task. It sliced
`spawnTaskRuns()`'s source text and searched for the literal string
`` "[project-tick] spawned ${task.role}" `` to locate the spawn log line, then
asserted `emptyWriteSetWarning(task, task.project.name)` appears textually
after it, exactly once.

Extracting `formatSpawnLog()` — which this task's brief explicitly prescribed,
precisely so the log text could be tested without importing anything that opens
a pg Pool — moves that literal string out of `spawnTaskRuns()`'s body into the
new function, which sits earlier in the file. The literal search target no
longer occurs inside the slice the test takes, so it went red as a direct,
expected consequence of the prescribed refactor — not a behaviour change: the
call to `formatSpawnLog(task, run.id, task.project.name)` is still the very
next statement before `emptyWriteSetWarning(...)`, in the same position the
original inline `console.log(...)` occupied.

**What changed:** the test's search target, from the literal log string to the
literal call `` "formatSpawnLog(task, run.id, task.project.name)" ``. The
assertion's meaning — the warn call sits beside the spawn record, exactly one
call site — is unmodified; only the token it locates that record by is updated
to match where the record now lives. No requirement is retired; this is the
narrow case standing rule 4 anticipates ("if one genuinely must change, the
commit message names [it]"), named here and in the commit message.

### 4.6 Mutation — proving the new test can fail

Reproduced live, on this worktree, then reverted:

```
$ sed -i 's/const deps = task.depends_on === null ? "legacy" : String(task.depends_on.length);/const deps = "0"; \/\/ MUTATION: always print 0, even for a NULL row/' src/lib/project-tick.ts

$ node --test --import tsx src/lib/project-tick.test.ts
    # Subtest: a graph row with three deps renders deps=3
    not ok 1 - a graph row with three deps renders deps=3
      error: |-
        The input did not match the regular expression /deps=3\)/. Input:
        '[project-tick] spawned builder run run-1 for task t1 (round 1, tier role-default, workstream=main, deps=0) — Test Project · Do it'

    # Subtest: a NULL depends_on (the legacy sentinel) renders deps=legacy, never deps=0
    not ok 3 - a NULL depends_on (the legacy sentinel) renders deps=legacy, never deps=0
      error: |-
        The input did not match the regular expression /deps=legacy\)/. Input:
        '[project-tick] spawned builder run run-1 for task t1 (round 1, tier role-default, workstream=main, deps=0) — Test Project · Do it'
```

Two of the five cases go red under the mutation — exactly the two the mutation
touches (`deps=3` and `deps=legacy`); the workstream cases and the `[]` case
correctly stay green, since the mutation does not affect them. This is the
precise failure NF1 forbids (a legacy row silently reporting `deps=0`), and the
test catches it.

```
$ cp /tmp/project-tick.ts.bak2 src/lib/project-tick.ts   # revert
$ pnpm typecheck   # clean
$ pnpm test        # 1118/1118 pass again
```

### 4.7 What would have made this test report a pass WRONGLY

The obvious failure mode, named because standing rule 3 requires it: a
formatter tested in isolation that the spawner does not actually call — a
`formatSpawnLog()` that typechecks and passes its own unit tests while
`spawnTaskRuns()` quietly still runs its own inline `console.log(...)` beside
it, unreached by the extraction. Ruled out two ways: (1) §4.3 above shows the
call site — `spawnTaskRuns()` contains exactly one `console.log` in its spawn
path, and it is `console.log(formatSpawnLog(task, run.id, task.project.name))`,
confirmed by `grep -c "console.log(formatSpawnLog" src/lib/project-tick.ts`
returning 1 and `grep -c "console.log(\`\[project-tick\] spawned"`
returning 0; (2) the pre-existing R17 structural test in §4.5, now retargeted
at the call rather than the literal string, independently asserts there is
exactly one call site and that it sits where the old inline log sat.

### 4.8 Files written, and the §10 row

- `forge-control/src/lib/project-tick.ts` — `formatSpawnLog()` added; the one
  `spawnTaskRuns()` call site changed. Nothing else in the file touched:
  `PARALLELISM_GUIDE`, the prompt branches, `WORKTREE_POLICY`, the group loop,
  and `buildPrompt` are all byte-identical to this task's start.
- `forge-control/src/lib/project-tick.test.ts` — one case appended (§4.3); one
  pre-existing assertion's search target updated (§4.5).
- `docs/plan/engine-task-graph/04-phases.md` — §10's "writes recorded after the
  fact, round 215" table gained one row, naming `project-tick.ts`, round 231,
  and the ruling of §4.1. `check-corpus-map.py` still exits 0 (it parses only
  §9/§K/phase headers, not §10, so this row cannot desync the requirement→phase
  map — verified by re-running it after the edit).
- `docs/plan/engine-task-graph/evidence/phase6-plan-api.md` — this section.

No live database, no live endpoint, no edit to `/opt/forge-ai-os` — every
verification above ran in this worktree, out of `tsx`/`node --test`, per this
task's brief.
