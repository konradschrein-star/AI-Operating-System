# PLAN — aios-r70-transitive-and-idle-fleet-alarm

Round 0 architect plan. Written 2026-08-26 against the code in this worktree
(branch `project/0a0806d3`), not from memory. Every file/line reference below
was opened.

## Recommendation, first

Two independent changes, two workstreams, one shared deploy.

1. **`r70`** — replace R70's *direct array membership* test with *transitive
   reachability over `depends_on`*, in the pure predicate and in its SQL mirror,
   in **one builder task** (they are one decision written twice; splitting them
   across two agents is precisely how a mirror drifts). A second, cheap task
   then makes the two provably agree by adding the missing pairing step to
   `scripts/checks/check-close-gate.ts`.
2. **`idle-alarm`** — add the two sections to `scripts/ops/stalled-projects.sh`
   that let the detector observe a fleet with nothing queued.

Disjoint files, parallel lanes, each ending in its own integration task, joined
by one reviewer, ending in a deploy task.

## What owns state / what dispatches / what happens on failure / how Konrad sees it broke

- **Owns state:** `projects.status` in `content_forge`. The only writer is the
  `UPDATE` in `closeFinishedProjects()` (`forge-control/src/db/projects.ts:626`).
- **Dispatches:** `projectTick()` calls it every pass; `reportUnintegratedWorkstreams()`
  (`project-tick.ts` ~3180) turns each `held` row into one notification and re-arms.
- **On failure:** a `held` row the pure side cannot explain is already reported as
  a mirror disagreement in words ("have drifted apart"). That path is preserved.
- **How Konrad sees it broke:** today he does not — that is the whole bug.
  Workstream 2 is the answer: `stalled-projects.sh` gains a section that fires on
  a finished-but-active project and a fleet line that fires on zero queued work.

---

## Findings that change how this must be built

### F1 — every existing R70 unit test is green BEFORE and AFTER the fix

I hand-evaluated all eleven cases in `project-tick.test.ts:1607–1731` under
transitive reachability. All eleven keep their current expected value, including
the two that must stay red:

| case | shape | direct | transitive |
|---|---|---|---|
| THE ATTACK | `1:main[]`, `2:ui[1]`, `3:ui[1]` | `["ui"]` | `["ui"]` |
| covering only PART | `4:main[2]` misses `3` | `["ui"]` | `["ui"]` — `4→2→1`, never `3` |
| integrator inside W | `3:ui[1,2]` | `["ui"]` | `["ui"]` |
| foreign-workstream integrator | `4:api[2,3]` | `["api","ui"]` | `["api","ui"]` |
| …the other seven | | unchanged | unchanged |

**Consequence: the suite cannot discriminate this fix.** A builder who runs
`pnpm test`, sees green, and ships has proven nothing. New cases are not optional
polish — they are the only evidence the change happened. Required new cases:

- **the live shape** (the red-to-green one): `2:main[]`, `3:md[2]`, `4:md[3]`,
  `5:main[4]` → today `["md"]`, after `[]`.
- **a cycle inside W**: `a:ws[b]`, `b:ws[a]`, `i:main[a]` → must return `[]` and
  must **terminate**.
- **a cycle among `main` rows** reachable from an integrator → must terminate.
- **the preserved negative**: a workstream no `main` task reaches at all, in the
  scratch DB, still `held`.

### F2 — nothing pairs the pure predicate with the SQL. The comment claims it; no code does it.

`check-close-gate.ts:17` says "The pure mirror … is unit-tested in
project-tick.test.ts; this script proves the SQL agrees." It does not import
`unintegratedWorkstreams` — its only imports are five node builtins
(`check-close-gate.ts:74–78`). `grep unintegratedWorkstreams` across `src` and
`scripts` returns exactly one non-comment importer: the unit test.

So the agreement between the two sides is asserted **by a regex over source
text** (`project-tick.test.ts:1732`, "the SQL mirror carries R70's three
quantifiers") and nowhere else. That regex is exactly what a rewrite invalidates.
This is the `oracle-sql-mirror-is-check-scheduler-sql` trap one rule over: the
binding lives in a driver step that, for R70, was never written.

**Therefore the pairing step is in scope and is the second r70 task**: for every
fixture project, run `unintegratedWorkstreams()` over the same rows the SQL saw
and assert the partition agrees, the way `check-scheduler-sql.sh`'s `mirror`
driver step (~line 547) binds `graphReady()` to `promoteReadyTasks()`.

### F3 — TWO source-pin tests slice `closeFinishedProjects()`, and one is not about R70

Both do `src.slice(start, src.indexOf("\n/**", start))`:

- `project-tick.test.ts:1732` — pins `NOT \(m\.id = ANY \(i\.depends_on\)\)`
  (**the term being deleted**) and asserts the correlation count is **exactly 3**.
- `r20-smoke-arming.test.ts:133` — pins `AND \$\{stillOpen\(\)\}` and
  `WHERE project_id = p\.id AND status = 'done'`. Nothing in its name or subject
  suggests R70; a builder editing R70 will not think to look at it.

Three hard constraints fall out, and they belong in the builder's brief, not in
a review finding:

1. The SQL must stay **inline inside the function**. Hoisting the recursive CTE
   to a module-level `const` moves it out of both slices — the pins then read a
   function that no longer contains the terms, and one of them fails while the
   other silently passes over the wrong text.
2. **No line inside the function may begin with `/**`** — it truncates both
   slices. Use `--` SQL comments only.
3. `AND ${stillOpen()}` must survive verbatim, and the correlation-count
   assertion must be **re-derived, not deleted**. R27's intent is "every level
   correlated on `project_id`"; the recursive CTE adds levels, so the number
   changes and the *claim* must not weaken into "at least one".

### F4 — the design fork, and why it gets measured before it gets built

The brief proves transitivity closes `markdown` (a 2-task chain). It asserts by
correlation that it closes all eight failing workstreams. Transitive reachability
from **one** integrator closes W only if W's tasks are reachable from the single
task that integrator names — true for a **chain**, false for a **tree with two
leaves**. `vault/25`, `connections/13`, `business/9`, `surfaces/9` are large
enough that this is a real risk, not a pedantic one.

- **Rule A (recommended, and what the brief specifies):** ∃ one `main` task `i`
  such that every task of W is reachable from `i`.
- **Rule B (fallback only):** every task of W is reachable from **some** `main`
  task. Strictly weaker — two half-integrators would pass. Defensible (between
  them they do merge the branch) but it is a **rule change**, not an
  implementation detail.

**Rule B must not be chosen silently.** Task 1 measures both against live rows,
read-only, and reports which projects each closes. If A closes all three, A ships
and B is never mentioned again. If A does not, the measurement task escalates via
`/api/reminders` and the graph pauses on a stated question rather than a guess.

### F5 — the pure predicate's home

`unintegratedWorkstreams()` currently lives in `project-tick.ts`, which imports
`db/*` and `node:fs`. `check-close-gate.ts` needs to call it (F2) and should not
drag the tick's import graph into a harness that repoints `DATABASE_URL`.

**Recommendation:** move `unintegratedWorkstreams` + `CloseGateTask` into the pure
leaf `lib/task-graph.ts` — which already owns `findCycle`, `taskDepth`,
`graphReady` and, since 2026-08-26, `TERMINAL_TASK_STATUSES` — and re-export from
`project-tick.ts`. A re-export adds no module edge; the one importer
(`project-tick.test.ts:1177`) and the source-pin at `project-tick.test.ts:1766`
(which pins the *call site*, still in `project-tick.ts`) both keep working.
`MAIN_WORKSTREAM` lives in `project-reconcile.ts:96` and moves with it, re-exported
the same way — **after** grepping for tests that pin it by regex against
`project-reconcile.ts`'s source.

*Rejected:* have `check-close-gate.ts` import `project-tick.ts` — works, but pulls
`db/*` + `fs` into the harness for one pure function.
*Rejected:* leave it and duplicate the walk in the harness — a third copy of the
rule is the disease, not the cure.

### F6 — the cycle guard is a `UNION` vs `UNION ALL` decision, and a `depth` column defeats it

`depends_on` is not constrained acyclic. In the recursive CTE:

```sql
WITH RECURSIVE reach(project_id, src, dst) AS (
    SELECT t.project_id, t.id, d.dep
      FROM project_tasks t
      CROSS JOIN LATERAL unnest(t.depends_on) AS d(dep)
     WHERE t.depends_on IS NOT NULL
  UNION                       -- NOT "UNION ALL". See below.
    SELECT r.project_id, r.src, e.dep
      FROM reach r
      JOIN project_tasks t2
        ON t2.id = r.dst AND t2.project_id = r.project_id   -- R27, every level
      CROSS JOIN LATERAL unnest(t2.depends_on) AS e(dep)
     WHERE t2.depends_on IS NOT NULL
)
```

Termination is by **finiteness plus dedup**: the recursive term can only ever
emit pairs drawn from one project's tasks × tasks, and `UNION` discards
duplicates, so a cycle `a→b→a` re-derives pairs that already exist and the
iteration reaches a fixed point. `UNION ALL` here hangs.

**The trap worth stating out loud:** adding a `depth` column "to be safe" *breaks*
this. A monotonically increasing `depth` makes every revisit a distinct tuple,
`UNION` stops deduplicating, and the cycle runs forever — the guard that was
added for safety is what removes the guarantee. If a depth cap is wanted anyway,
it must be `UNION ALL` + `depth < N`, and then N is a silent truncation that can
make a legitimately deep chain read as unintegrated. Do not do both. **Ship
`UNION` without `depth`.**

The pure side's guard is the ordinary one: BFS from the integrator's `depends_on`
with a `visited: Set<string>`, which terminates by construction.

### F7 — `stalled-projects.sh` already carries both fixes my memory note warned about

`Q()` now captures the status, lets stderr through, exits **2**, and guards
against being called in a subshell (lines 51–85). `STALLED_PROJECTS_DB_URL` is
the scratch override, short-circuiting the `set -a` source (lines 31–49). The new
sections **inherit working machinery** — they must use `Q "..."` as a statement
and read the global `out`, never `out=$(Q ...)`.

Both new sections will return **0 rows on live data the moment workstream 1
ships**, which is the point and also the hazard: a green run is evidence of
nothing. Both must be proven against a constructed shape in a scratch DB, and the
transcript recorded in the section's comment block in the file's own convention
(`NEGATIVE` / `POSITIVE A` / `POSITIVE B` / `BITE PROOF`, with measured counts).
`zz-tierpin-verify` and `smoke-test` are permanent noise — not ours.

---

## The graph

```
T1 measure (researcher, junior, main) ──┐
                                        ├─> T3 r70-core (builder, standard, ws:r70)
                                        │      └─> T5 r70-harness (builder, junior, ws:r70)
                                        │             └─> T6 integrate-r70 (builder, standard, main) ── depends on T3 AND T5
T2 idle-sections (builder, standard, ws:idle-alarm)
   └─> T4 idle-prove (builder, junior, ws:idle-alarm)
          └─> T7 integrate-idle (builder, junior, main) ── depends on T2 AND T4

T8 reviewer (reviewer, standard, main) ── depends on T1..T7
   └─> T9 deploy (builder, standard, main)
```

Both integration tasks depend on **every** task of their workstream, directly —
so this project satisfies R70 under the rule it is replacing *and* the rule it is
installing. If any task is later added to `r70` or `idle-alarm`, T6/T7's
`depends_on` must be fixed in the same breath.

## Acceptance

- Read-only `SELECT` naming `aios-chat-reference-navigation`,
  `os-usable-for-work`, `aios-sidebar-live-sessions` under the new predicate and
  none of them under the old one (T1, before any code changes — the red).
- `closeFinishedProjects()` returns those three in `closed`, live, at deploy (T9
  — the green). Not closed by hand: they are the fixture.
- A constructed project with a genuinely unreachable workstream still in `held`.
- `check-close-gate.ts` passes with its pairing step and its raised
  `EXPECTED_ASSERTIONS`; the pure side and the SQL agree on every fixture.
- `stalled-projects.sh` prints the three projects **before** T3 merges and
  nothing **after**, and prints the fleet-idle line when open work is zero —
  each proven in a scratch DB, not inferred from a clean live run.
