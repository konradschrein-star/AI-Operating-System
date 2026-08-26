# aios-ops-inventory-red — plan (round 0)

**Goal.** Resolve the persistent gate failure on `main` where `scripts/checks/check-ops-scripts.sh` exits 1 due to `scripts/ops/assert-merge-scope.sh` and `scripts/ops/recover-stuck-task.sh` missing from the `FILES` array in `scripts/ops/install-symlinks.sh`. Make the repo gate suite `gates-808` green on this gate and ensure the recovery/merge tools are properly symlinked into `/opt/ai-os/scripts/` upon deploy.

## Recommendation

Add `assert-merge-scope.sh` and `recover-stuck-task.sh` to the `FILES` array in `scripts/ops/install-symlinks.sh`. Do not add either script to `RESTRICTED_MODE_FILES` or `EXEC_MODE_FILES`.

### Reasoning
1. **Inventory Consistency**: `install-symlinks.sh` manages symlinks for all operational scripts from `scripts/ops/` into `/opt/ai-os/scripts/`. `check-ops-scripts.sh` enforces parity between files in `scripts/ops/` and the `FILES` array in `install-symlinks.sh`. Both `assert-merge-scope.sh` and `recover-stuck-task.sh` exist on disk but were not registered in `FILES`, causing `check-ops-scripts.sh` (and thus `gates-808.sh`) to fail on pristine `main`.
2. **Mode Classification**:
   - `RESTRICTED_MODE_FILES`: Reserved solely for files embedding private keys / host credentials (such as `check-vps2-backup.sh` which requires mode `750`). `assert-merge-scope.sh` is a pure git diff validator and `recover-stuck-task.sh` loads environment credentials dynamically at runtime via `/opt/ai-os/.secrets/forge-control.env`. Neither needs 750 mode.
   - `EXEC_MODE_FILES`: Defensive belt-and-braces list for the PreToolUse hook Python scripts and hook installation/test scripts (`guard-*.py`, `test-guard-*.py`, `install-hooks.sh`) invoked by Claude CLI. Neither script is a PreToolUse hook; standard git tracking (`755` executable) suffices.

### Rejected Alternatives
- **Adding scripts to `RESTRICTED_MODE_FILES`**: Rejected — unnecessary restriction as neither script embeds secrets or requires 750 mode.
- **Adding scripts to `EXEC_MODE_FILES`**: Rejected — neither script is a PreToolUse hook requiring defensive hook-execution chmod.
- **Softening `check-ops-scripts.sh` to ignore unregistered scripts**: Rejected — violates inventory policy and masks uninstalled ops tooling.
- **Running `install-symlinks.sh` inside the project worktree**: Rejected — `install-symlinks.sh` explicitly refuses to run from worktrees to prevent creating dangling symlinks when worktrees are cleaned up.

---

## State · Dispatch · Failure Modes · Operator Visibility

- **What owns state**:
  - Repo inventory: `scripts/ops/install-symlinks.sh` (`FILES` array) and `scripts/ops/` filesystem contents.
  - Host symlinks: `/opt/ai-os/scripts/` symlinks pointing to `/opt/forge-ai-os/scripts/ops/*`.
- **What dispatches work**:
  - In-lane validation: Builder runs `scripts/checks/check-ops-scripts.sh` and mutation controls.
  - Repo gate suite: `scripts/checks/gates-808.sh` line 381 executes `check-ops-scripts.sh`.
  - Host deploy: Deploy task runs `scripts/ops/install-symlinks.sh` from the live checkout `/opt/forge-ai-os`.
- **What happens on failure**:
  - If a file is missing from `FILES`, `check-ops-scripts.sh` prints a diff of expected vs actual and exits 1.
  - If `install-symlinks.sh` is run in a worktree, it halts immediately with exit 1 and a descriptive refusal.
- **How Konrad sees it broke**:
  - Repo gate status: `gates-808` reports gate failure on `check-ops-scripts.sh`.
  - Host scripts: `ls -la /opt/ai-os/scripts/assert-merge-scope.sh` / `recover-stuck-task.sh` would show missing or broken symlinks.

---

## Task Graph

```
T1 builder (gemini, main)
  Register assert-merge-scope.sh and recover-stuck-task.sh in install-symlinks.sh
  │
  ▼
T2 reviewer (standard, main)
  Review diff, verify check-ops-scripts.sh PASS, mutation proof & gates-808
  │
  ▼
T3 deploy builder (junior, main)
  Deploy symlinks on live checkout /opt/forge-ai-os & verify live resolution
```

### Tasks Detail

1. **T1 (Builder, tier: gemini, workstream: main, depends_on: [])**
   - **Title**: Register assert-merge-scope.sh and recover-stuck-task.sh in install-symlinks.sh
   - **Write Set**: `["scripts/ops/install-symlinks.sh"]`
   - **Actions**:
     - Edit `scripts/ops/install-symlinks.sh` to add `assert-merge-scope.sh` and `recover-stuck-task.sh` to the `FILES` array.
     - Run `bash scripts/checks/check-ops-scripts.sh` and verify exit 0.
     - Execute mutation control: temporarily delete an entry from `FILES`, verify `check-ops-scripts.sh` fails with exit 1, restore and verify exit 0.
     - Run `bash scripts/checks/gates-808.sh` and verify gate status.
     - Commit changes cleanly.

2. **T2 (Reviewer, tier: standard, workstream: main, depends_on: [T1])**
   - **Title**: Review ops scripts registration and gate-808 status
   - **Write Set**: `[]`
   - **Actions**:
     - Review diff against base branch: verify only `scripts/ops/install-symlinks.sh` was modified.
     - Verify `check-ops-scripts.sh` passes and mutation proof is recorded in builder notes.
     - Run `bash scripts/checks/gates-808.sh --strict` (apply sibling contention rule if unrelated unit tests flake once).
     - Issue review verdict.

3. **T3 (Deploy Builder, tier: junior, workstream: main, depends_on: [T2])**
   - **Title**: Deploy ops symlinks to /opt/ai-os/scripts and verify live
   - **Write Set**: `["deploy/aios-ops-inventory-red.md"]`
   - **Actions**:
     - Merge branch to main on live checkout `/opt/forge-ai-os`.
     - Run `scripts/ops/install-symlinks.sh` from `/opt/forge-ai-os`.
     - Verify symlinks resolve: `ls -la /opt/ai-os/scripts/assert-merge-scope.sh` and `ls -la /opt/ai-os/scripts/recover-stuck-task.sh`.
     - Run `bash scripts/checks/check-ops-scripts.sh` from `/opt/forge-ai-os` and show exit 0.
     - Write deploy record `deploy/aios-ops-inventory-red.md`.

---

<!-- MERGE 2026-08-26: PLAN.md carries one plan per project and both sides of this
     merge held a whole, different plan (aios-ops-inventory-red above, this project
     below). Neither was dropped: interleaving git's three hunks would have spliced
     two unrelated documents into one unreadable file, so both are kept whole, in
     merge order. -->

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

Planned as two parallel workstreams (`r70`, `idle-alarm`), each ending in its own
integration task. **Seeded as one, in `main`** — see the lane note below.

```
r0  measure          (researcher, junior)  deps []
r0  detector         (builder,  standard)  deps []
r1  r70-core         (builder,  standard)  deps [measure]
r1  idle-prove       (builder,  junior)    deps [detector]
r2  close-gate-bind  (builder,  junior)    deps [r70-core]
r3  reviewer         (reviewer, standard)  deps [all five above]
r4  deploy           (builder,  standard)  deps [reviewer]
```

### Lane note — why one workstream and not two

The two lanes touch strictly disjoint files and were seeded as `r70` and
`idle-alarm`. Both died at dispatch, `attempt=0`, `run_id=NULL`:

```
[project-tick] failed to spawn run for task fbe5ecfb-… (builder):
  The requested module '../db/ai_os.ts' does not provide an export named 'getFleetDefaultTier'
```

The export exists. The **running** executor holds a stale ESM module graph, and
`lib/workspace.ts:197` does a dynamic `import()` inside the worktree-creation
path — which only runs for a workstream that has no worktree yet. An existing
workstream is safe; opening a new one is not, until the executor restarts. This
has been true fleet-wide since 2026-08-25 20:00Z, so **every project seeded in
the last day has been silently serialised into `main`**. Escalated to Konrad by
reminder; the restart belongs to a moment with no run in flight.

Both lanes were therefore collapsed into `main`. Consequences, stated rather than
discovered later:

- **No integration tasks.** With one workstream there is no side branch to merge
  back; the work commits directly on the project branch. This project satisfies
  R70 vacuously — it has no non-`main` workstream — under both the rule it is
  replacing and the rule it is installing.
- **Everything serialises.** `main` runs one task at a time, so the two lanes
  interleave instead of overlapping. Correctness is unaffected; wall-clock is.
- Re-seeding required **new titles**: task identity is `(project, round, role,
  title)`, so re-creating a cancelled task under the same title answers 409 with
  the cancelled row and seeds nothing.

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
