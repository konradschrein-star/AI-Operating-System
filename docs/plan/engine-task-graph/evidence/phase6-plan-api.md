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
