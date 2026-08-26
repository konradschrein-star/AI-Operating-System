# Round 0 — R70 transitive coverage measured against live rows

Task: `aios-r70-transitive-and-idle-fleet-alarm`, round 0, explicitly briefed
read-only verify task. All sources below are live `SELECT` queries run
2026-08-26 against the `content_forge` PostgreSQL database
(`psql "$DATABASE_URL"`, credentials from
`/opt/ai-os/.secrets/forge-control.env`). No web sources apply to this task —
it is a live-database measurement, not a docs lookup. No UPDATE/INSERT/DELETE/
DDL was executed; verified by reading every statement run in this session
before execution (all are `SELECT`/`WITH ... SELECT`).

Full SQL, full per-workstream table, and full analysis are in
`evidence/r70-transitive/live-coverage.md` (committed alongside this file) —
that is the deliverable path the task brief named explicitly. This document is
the shorter pointer the researcher-role wrapper also asks for.

## Headline

Rule A (transitive reachability from a single `main` integrator, the fix the
brief specifies) closes **only one of the three named projects**:
`aios-chat-reference-navigation`. `os-usable-for-work` and
`aios-sidebar-live-sessions` stay held under Rule A — **and under Rule B
(union of all integrators) too**, which the brief did not anticipate: it
frames Rule B as the fallback that would rescue tree-shaped workstreams a
single integrator misses. On live data, the four failing workstreams
(`connections`, `surfaces`, `vault`, `toggle`) don't fail because of a
tree/chain shape at all — they fail because specific tasks are dead ends that
literally nothing in the project ever names in `depends_on` (three are
explicitly marked `[FOLDED into ...]` / `[RETIRED as duplicate of ...]` in
their own titles; the fourth, `toggle`, was never given an integration task in
the first place). Both rules are structurally unable to reach a node nobody
points at.

This was escalated per the brief's explicit instruction ("ESCALATE IF RULE A
DOES NOT CLOSE ALL THREE") — see `evidence/r70-transitive/live-coverage.md`
§"Escalation" for the exact reminder and manager-chat report sent, including
the correction that Rule B is not a viable fallback here.

## What the brief got right, confirmed live

- The old direct-membership predicate fails every multi-task workstream
  (`markdown`, `test`, `business`, `connections`, `perf`, `surfaces`,
  `vault`) and passes only the three single-task ones (`detect`, `panel`,
  `preview`) — exact 1:1 match with the brief's claim, verified by a live
  query (`evidence/r70-transitive/live-coverage.md` §3).
- `business` and `perf` are the textbook case the transitive fix targets: a
  clean chain, old rule fails, transitive Rule A passes. Confirmed by reading
  every row of `business`'s 9 tasks and their `depends_on` arrays.
- No cycle exists in `depends_on` for any of the three live projects (0
  cyclic self-pairs from a `WITH RECURSIVE ... UNION` walk, 22.8 ms).
- Both reachability queries terminate promptly: 23.1 ms (Rule A) and 34.4 ms
  (Rule B) server-side for all three projects combined (~190 tasks, 11
  non-main workstreams).

## What the brief did not anticipate, found live

`markdown` (the brief's own worked chain example) is not actually one of the
blocking cases on the current live board — it already passes Rule A cleanly.
The workstreams that actually block closure post-fix are a different failure
mode entirely: administratively dead tasks in the dependency graph
(`FOLDED`/`RETIRED` tags) and one workstream integration task that was simply
never seeded (`toggle`). Fixing R70's traversal logic — direct membership to
transitive reachability — does not and cannot touch either of these, because
both are "nothing points at this node," which is invariant to how the
traversal is done. Full task-by-task evidence (ids, titles, `depends_on`
arrays, and the containment query proving nothing references the dead-end
node) is in `evidence/r70-transitive/live-coverage.md` §4.

## Recommendation carried into the escalation

Ship Rule A (transitive) as specified — it is a strict improvement and is
what closes `aios-chat-reference-navigation`. Do not substitute Rule B: it was
checked task-by-task and rescues nothing extra on live data, so weakening the
rule buys no additional closures here and is a rule-change decision the brief
correctly reserves for Konrad, not the implementer. `os-usable-for-work` and
`aios-sidebar-live-sessions` will need either a follow-up task that adds real
integration coverage for `connections`/`surfaces`/`vault`/`toggle`, or an
explicit ruling that folded/retired tasks are exempt from R70's "every task of
W" requirement — a scope decision, not something to guess.

## Sources

- Live PostgreSQL `content_forge` database, `projects` and `project_tasks`
  tables, queried directly via `psql "$DATABASE_URL"` on 2026-08-26. Not a web
  source; access date is the query timestamp. All SQL is reproduced verbatim
  in `evidence/r70-transitive/live-coverage.md` §1.
- `forge-control/src/lib/project-tick.ts:3156`, `unintegratedWorkstreams()` —
  read directly from the worktree checkout to confirm the exact predicate
  shape (direct `depends_on` membership) before writing the transitive
  mirror, 2026-08-26.
- `/root/.claude/projects/-opt-forge-ai-os/memory/` notes read before starting:
  `recursive-cte-depth-column-defeats-the-union-cycle-guard.md` (shape used
  for the `UNION`, no-depth-column CTE),
  `r70-transitive-fix-is-invisible-to-its-own-tests.md`,
  `terminal-task-statuses-owned-by-the-pure-leaf.md`,
  `oracle-sql-mirror-is-check-scheduler-sql.md`,
  `shared-suite-gate-that-cannot-pass.md`,
  `stalled-projects-sh-two-testability-defects.md` — all read 2026-08-26,
  none of their claims are load-bearing for this document beyond the CTE shape
  and the confirmation that `unintegratedWorkstreams()` is the pure
  definition to mirror.
