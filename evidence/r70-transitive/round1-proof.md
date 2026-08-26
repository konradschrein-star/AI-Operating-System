# R70 transitive — round 1 build proof

Every transcript below was produced 2026-08-26 in the lane worktree
`/opt/ai-os/workspace/projects/0a0806d3-…` on branch `project/0a0806d3`.
`/opt/forge-ai-os` was never edited. `pm2 restart forge-executor` was never run.
Nothing was written to `content_forge`: the only live statements issued were
`SELECT`s and one schema-only `pg_dump -s`.

## What changed

| file | change |
|---|---|
| `forge-control/src/lib/task-graph.ts` | now OWNS `MAIN_WORKSTREAM`, `CloseGateTask` and `unintegratedWorkstreams()`; the predicate walks `depends_on` transitively (BFS + `visited`) instead of testing direct array membership |
| `forge-control/src/lib/project-reconcile.ts` | `MAIN_WORKSTREAM` becomes a re-export of the leaf's definition |
| `forge-control/src/lib/project-tick.ts` | `unintegratedWorkstreams` / `CloseGateTask` become re-exports; the call site stays here |
| `forge-control/src/db/projects.ts` | the R70 coverage term becomes a `NOT EXISTS` over a `WITH RECURSIVE reach(project_id, src, dst)` closure |
| `forge-control/src/lib/project-tick.test.ts` | six new R70 cases; the SQL source-pin re-derived |

`forge-control/src/lib/task-graph.test.ts` and
`forge-control/src/lib/r20-smoke-arming.test.ts` were declared in the write-set
and needed **no** change — r20's two pins (`AND ${stillOpen()}` and
`WHERE project_id = p.id AND status = 'done'`) survive the rewrite verbatim,
which was checked directly and not assumed:

```
slice length: 7212 bytes
true   stillOpen
true   done-count
true   reach term
false  direct-membership (must be ABSENT)
project_id correlations: WHERE w.project_id = p.id | WHERE i.project_id = p.id
                       | WHERE m.project_id = p.id | WHERE r.project_id = p.id
```

The correlation count was **re-derived, not softened**: three quantifiers
(`w`, `i`, `m`) plus the `reach` lookup, which spans every active project and
would otherwise carry an edge across the project boundary. The assertion still
reads `assert.equal(..., 4)`, never "at least one".

## 1. The SQL mirror and the pure predicate, driven against a scratch database

`forge_r70_scratch`, schema copied with `pg_dump -s -t projects -t project_tasks
-t runs` (`pg_trgm` created first — see `scratch-db-fixture-for-projects-and-
project-tasks`). A throwaway probe inside the package repointed `DATABASE_URL`
at it and called the **shipped** `closeFinishedProjects()` and the **shipped**
`unintegratedWorkstreams()` over the same rows. Probe deleted afterwards;
`git status --porcelain` clean.

```
RED  — projects the OLD direct-membership term would have let close:
       r70-probe-cycle-in-main

PURE — unintegratedWorkstreams() over the same rows:
       r70-probe-live-shape       -> []  expected []
       r70-probe-partial          -> [ui]  expected [ui]
       r70-probe-unreachable      -> [tog]  expected [tog]
       r70-probe-cycle-in-w       -> []  expected []
       r70-probe-cycle-in-main    -> []  expected []

GREEN — closeFinishedProjects() returned in 25 ms (a cycle that did not hang):
        closed: r70-probe-cycle-in-main, r70-probe-cycle-in-w, r70-probe-live-shape
        held:   r70-probe-partial, r70-probe-unreachable

ASSERTIONS
  ok   pure: r70-probe-live-shape -> []
  ok   SQL:  r70-probe-live-shape is in closed
  ok   pure: r70-probe-partial -> [ui]
  ok   SQL:  r70-probe-partial is in held
  ok   pure: r70-probe-unreachable -> [tog]
  ok   SQL:  r70-probe-unreachable is in held
  ok   pure: r70-probe-cycle-in-w -> []
  ok   SQL:  r70-probe-cycle-in-w is in closed
  ok   pure: r70-probe-cycle-in-main -> []
  ok   SQL:  r70-probe-cycle-in-main is in closed
  ok   RED CONTROL: the OLD term did NOT close r70-probe-live-shape
  ok   RED CONTROL: the OLD term closed exactly the one-task-workstream fixture
  ok   TERMINATION: both cycle fixtures resolved (25 ms, no hang)

PROBE PASSED
```

The one fixture the old term DOES close is `cycle-in-main`, whose workstream has
exactly ONE task — the brief's own control appearing in the fixture, since
direct membership and reachability coincide on a single node.

## 2. The three live projects, real rows, shipped statement

The three named projects' `projects` and `project_tasks` rows were read from
`content_forge` (SELECT only, 127 task rows), copied into the scratch database,
and the **shipped** `closeFinishedProjects()` was run there.

```
LIVE READ — 3 project row(s):
  aios-chat-reference-navigation   status=active
  aios-sidebar-live-sessions       status=active
  os-usable-for-work               status=active
LIVE READ — 127 task row(s). No write was issued against the live database.

PURE — unintegratedWorkstreams() over each project's real rows:
  aios-chat-reference-navigation   -> []
  aios-sidebar-live-sessions       -> [toggle]
  os-usable-for-work               -> [connections, surfaces, vault]

SHIPPED closeFinishedProjects() on the scratch copy — 79 ms
  closed: aios-chat-reference-navigation
  held:   aios-sidebar-live-sessions, os-usable-for-work

MIRROR AGREEMENT — pure side vs SQL side, per project:
  ok   aios-chat-reference-navigation   pure=close sql=close
  ok   aios-sidebar-live-sessions       pure=hold  sql=hold
  ok   os-usable-for-work               pure=hold  sql=hold

MIRROR AGREES ON EVERY PROJECT
```

### The acceptance criterion is met one project out of three, and that was known before this task started

The brief's acceptance reads "must close all three projects". It closes **one**.
This is not a shortfall in the traversal fix — it is round 0's finding
(`evidence/r70-transitive/live-coverage.md`, headline, escalated to the manager
chat and to `/api/reminders` on 2026-08-26), reproduced here with the shipped
code rather than with hand-written SQL, and the workstream names match exactly.

`connections`, `surfaces` and `vault` each contain one task explicitly titled
`[FOLDED into …]` or `[RETIRED as duplicate of …]` that **no task anywhere in
the project names in `depends_on`** — a retired branch tip with nothing on the
far side of it to be reachable from. `toggle` has no integration task at all, at
any round. Neither shape is a traversal problem and neither Rule A (one
integrator reaching all of W) nor Rule B (the union of integrators) rescues
them; round 0 measured Rule B task-by-task and it fails identically.

`toggle` is, in fact, exactly the negative the brief demands be preserved —
"a project with a genuinely unintegrated workstream must still be held" — so
one of the three projects staying held is the rule working, not failing.

## 3. The new unit cases discriminate — three mutants, measured

Restored between runs with `cp` + `sha256sum`, never `git checkout`
(`mutation-control-restore-must-not-use-git-checkout`). Baseline sha
`3b97906b4e6e9bd3857f6bab0dec2b31bfe085268dc56133bd071a8204423ee8`.

```
=== BASELINE (unmutated) ===
# tests 164 / # pass 164 / # fail 0

=== M1  reachability -> DIRECT array membership (the pre-2026-08-26 rule) ===
not ok 13 - THE LIVE SHAPE — an integrator naming the workstream's LAST task …
not ok 14 - a CYCLE INSIDE the workstream terminates and does not hold the project
not ok 15 - a CYCLE AMONG `main` ROWS on the walk to the workstream terminates
not ok 18 - a DANGLING dependency id is a dead end, not a crash and not a free pass
# pass 160 / # fail 4

=== M2  coverage every() -> some() (the rule weakened into a tautology) ===
not ok 7  - covering only PART of the workstream does not release it
not ok 16 - REACHABILITY DOES NOT RESCUE A PARTIAL INTEGRATION — the negative is preserved
# pass 162 / # fail 2

=== M3  BOTH cycle guards removed from reachableFrom() ===
Terminated
  >>> KILLED BY TIMEOUT AFTER 45s — the walk did not return
```

Read together: M1 proves the four new positive cases could not have passed
before the fix. M2 proves the two preserved negatives are not vacuous — they are
green under M1 *on purpose* (their job is to be unchanged), and it is M2 they
exist to kill. M3 proves the two cycle cases are a real termination test.

**M3 needed BOTH guards removed.** `reachableFrom()` filters on push *and* on
pop; removing either alone still terminates. That is worth knowing before
someone "simplifies" one of them away and reads the green suite as permission.

## 4. F6 — the CTE, and the two edits that destroy its guard

`UNION` (never `UNION ALL`) over `(project_id, src, dst)` with **no `depth`
column**. Termination is finiteness plus dedup. The reasoning lives in
`closeFinishedProjects()`'s header comment rather than beside the `UNION`,
because the drift guard asserts `UNION ALL` and `depth` are ABSENT from that
clause and a *warning* about a string is indistinguishable from the string to a
substring scan (`checker-names-its-own-forbidden-strings`). The same trap bit
twice while writing this: the first draft of the in-SQL comment quoted the
deleted direct-membership term, and the `assert.doesNotMatch` caught its own
documentation.

## 5. Suite

```
# tests 2577
# suites 505
# pass 2576
# fail 1
```

Baseline on the same tree before any edit was **2570 / 2569 / 1**. The single
failure is identical in both runs and is not this task's:
`src/lib/secret-scan-redaction.test.ts:141`, "a PGPASSWORD assignment still
FAILS" — it expects the label `PGPASSWORD` in the finding line and the scanner
now prints `password assignment`. Pre-existing on `project/0a0806d3` at
`90c8485`, outside this write-set, and reported rather than touched.

`npx tsc --noEmit` exits 0.

## What is left for the next tasks

1. **The `check-close-gate.ts` pairing step (F2) is still not written.** Its
   header at line 17 still says "the pure mirror (`unintegratedWorkstreams` in
   lib/project-tick.ts)" — a sentence that is still true through the re-export,
   but the file imports five node builtins and calls the predicate nowhere. The
   move to `lib/task-graph.ts` is what makes that import cheap: the harness can
   now have the predicate without `db/*` or `node:fs`. `scripts/` is outside
   this task's write-set.
2. **`docs/plan/engine-task-graph/01-requirements.md:822/833` and
   `04-phases.md:322`** still site `unintegratedWorkstreams()` in
   `lib/project-tick.ts`. True via re-export, stale as a location. Docs are
   outside this write-set.
3. **The deploy/verify task must re-run the close against live**, and should
   expect ONE project to close, not three — with the three workstream names
   above as the reason the other two stay held.
