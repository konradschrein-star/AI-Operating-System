# R70 transitive coverage — live measurement (round 0, READ-ONLY)

Measured 2026-08-26 against the live `content_forge` database (`$DATABASE_URL`
from `/opt/ai-os/.secrets/forge-control.env`). No UPDATE/INSERT/DELETE/DDL was
run; every statement below is a `SELECT`. No project or task row was touched.

## Headline finding — escalated

**Rule A (transitive reachability from a single integrator) closes only
`aios-chat-reference-navigation`.** `os-usable-for-work` and
`aios-sidebar-live-sessions` stay HELD under Rule A **and** under Rule B
(union-of-integrators). The acceptance criterion in the project brief — "must
close all three projects" — is **not achievable by the R70 traversal fix
alone**, on live data, and Rule B does not rescue the other two either. See
"Why Rule A doesn't close two of the three" below: the cause is not the
tree-vs-chain shape the brief hypothesized, but administratively dead-end
tasks (`FOLDED`/`RETIRED`) and one workstream (`toggle`) that was never given
an integrator at all. This was reported to the manager chat and a reminder was
queued per the brief's escalation instruction; see "Escalation" at the end of
this document.

## 1. Exact SQL run

### 1a. Cycle check (0 cyclic self-pairs found, 22.8 ms)

```sql
WITH RECURSIVE reach(project_id, src, dst) AS (
    SELECT t.project_id, t.id, d.dep
      FROM project_tasks t
      CROSS JOIN LATERAL unnest(t.depends_on) AS d(dep)
      JOIN projects p ON p.id = t.project_id
     WHERE t.depends_on IS NOT NULL
       AND p.name IN ('aios-chat-reference-navigation','os-usable-for-work','aios-sidebar-live-sessions')
  UNION
    SELECT r.project_id, r.src, e.dep
      FROM reach r
      JOIN project_tasks t2
        ON t2.id = r.dst AND t2.project_id = r.project_id
      CROSS JOIN LATERAL unnest(t2.depends_on) AS e(dep)
     WHERE t2.depends_on IS NOT NULL
)
SELECT count(*) AS cyclic_self_pairs FROM reach WHERE src = dst;
```
Result: `cyclic_self_pairs = 0`. Time: `22.797 ms`.

### 1b. Rule A — exists ONE main integrator covering every task of W (transitively)

```sql
WITH RECURSIVE reach(project_id, src, dst) AS (
    SELECT t.project_id, t.id, d.dep
      FROM project_tasks t
      CROSS JOIN LATERAL unnest(t.depends_on) AS d(dep)
      JOIN projects p ON p.id = t.project_id
     WHERE t.depends_on IS NOT NULL
       AND p.name IN ('aios-chat-reference-navigation','os-usable-for-work','aios-sidebar-live-sessions')
  UNION
    SELECT r.project_id, r.src, e.dep
      FROM reach r
      JOIN project_tasks t2
        ON t2.id = r.dst AND t2.project_id = r.project_id
      CROSS JOIN LATERAL unnest(t2.depends_on) AS e(dep)
     WHERE t2.depends_on IS NOT NULL
),
main_tasks AS (
  SELECT t.id, t.project_id FROM project_tasks t
  JOIN projects p ON p.id = t.project_id
  WHERE t.workstream = 'main'
    AND p.name IN ('aios-chat-reference-navigation','os-usable-for-work','aios-sidebar-live-sessions')
),
ws_tasks AS (
  SELECT t.id, t.project_id, t.workstream FROM project_tasks t
  JOIN projects p ON p.id = t.project_id
  WHERE t.workstream <> 'main'
    AND p.name IN ('aios-chat-reference-navigation','os-usable-for-work','aios-sidebar-live-sessions')
),
coverage AS (
  SELECT m.id AS integrator_id, w.project_id, w.workstream,
         count(DISTINCT w.id) AS ws_task_count,
         count(DISTINCT w.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM reach r WHERE r.project_id = m.project_id AND r.src = m.id AND r.dst = w.id
           )
         ) AS covered_count
  FROM main_tasks m
  JOIN ws_tasks w ON w.project_id = m.project_id
  GROUP BY m.id, w.project_id, w.workstream
)
SELECT p.name AS project, c.workstream,
       max(c.ws_task_count) AS ws_task_count,
       bool_or(c.covered_count = c.ws_task_count) AS rule_a_exists_full_integrator
FROM coverage c
JOIN projects p ON p.id = c.project_id
GROUP BY p.name, c.workstream
ORDER BY p.name, c.workstream;
```
Wall clock for this whole query (server-side, `\timing`): **23.1 ms** — well
under any timeout concern. `psql` process wall clock including connection
setup: 90 ms.

### 1c. Rule B — every task of W reachable from SOME main integrator (union)

Same `reach` CTE, but instead of grouping per-integrator, each workstream task
is checked against the union of ALL main integrators:

```sql
...
per_task_covered AS (
  SELECT w.id, w.project_id, w.workstream,
         EXISTS (
           SELECT 1 FROM main_tasks m
           WHERE m.project_id = w.project_id
             AND EXISTS (SELECT 1 FROM reach r WHERE r.project_id = m.project_id AND r.src = m.id AND r.dst = w.id)
         ) AS covered_by_some_main
  FROM ws_tasks w
)
SELECT p.name AS project, pt.workstream,
       count(*) AS ws_task_count,
       bool_and(pt.covered_by_some_main) AS rule_b_all_tasks_covered_by_union,
       count(*) FILTER (WHERE NOT pt.covered_by_some_main) AS uncovered_task_count
FROM per_task_covered pt
JOIN projects p ON p.id = pt.project_id
GROUP BY p.name, pt.workstream
ORDER BY p.name, pt.workstream;
```
Time: `34.4 ms`.

### 1d. OLD direct-membership predicate (the RED half)

```sql
WITH main_tasks AS (
  SELECT t.id, t.project_id, t.depends_on FROM project_tasks t
  JOIN projects p ON p.id = t.project_id
  WHERE t.workstream = 'main'
    AND p.name IN ('aios-chat-reference-navigation','os-usable-for-work','aios-sidebar-live-sessions')
    AND t.depends_on IS NOT NULL
),
ws_agg AS (
  SELECT t.project_id, t.workstream, array_agg(t.id) AS ids, count(*) AS ws_task_count
  FROM project_tasks t
  JOIN projects p ON p.id = t.project_id
  WHERE t.workstream <> 'main'
    AND p.name IN ('aios-chat-reference-navigation','os-usable-for-work','aios-sidebar-live-sessions')
  GROUP BY t.project_id, t.workstream
)
SELECT p.name AS project, w.workstream, w.ws_task_count,
  EXISTS (
    SELECT 1 FROM main_tasks m
    WHERE m.project_id = w.project_id
      AND w.ids <@ m.depends_on
  ) AS old_direct_rule_satisfied
FROM ws_agg w
JOIN projects p ON p.id = w.project_id
ORDER BY p.name, w.workstream;
```

## 2. Results table — project | workstream | task count | Rule A | Rule B

| project | workstream | ws task count | Rule A (single integrator, transitive) | Rule B (union of integrators) |
|---|---|---:|:---:|:---:|
| aios-chat-reference-navigation | detect | 1 | **t** | t |
| aios-chat-reference-navigation | markdown | 2 | **t** | t |
| aios-chat-reference-navigation | panel | 1 | **t** | t |
| aios-chat-reference-navigation | preview | 1 | **t** | t |
| aios-chat-reference-navigation | test | 2 | **t** | t |
| aios-sidebar-live-sessions | toggle | 4 | **f** | f (0/4 covered) |
| os-usable-for-work | business | 9 | **t** | t |
| os-usable-for-work | connections | 13 | **f** | f (12/13 covered, 1 uncovered) |
| os-usable-for-work | perf | 7 | **t** | t |
| os-usable-for-work | surfaces | 9 | **f** | f (7/9 covered, 2 uncovered) |
| os-usable-for-work | vault | 25 | **f** | f (24/25 covered, 1 uncovered) |

## 3. OLD direct-membership predicate — the RED half

| project | workstream | ws task count | old direct rule satisfied |
|---|---|---:|:---:|
| aios-chat-reference-navigation | detect | 1 | t |
| aios-chat-reference-navigation | markdown | 2 | **f** |
| aios-chat-reference-navigation | panel | 1 | t |
| aios-chat-reference-navigation | preview | 1 | t |
| aios-chat-reference-navigation | test | 2 | **f** |
| aios-sidebar-live-sessions | toggle | 4 | **f** |
| os-usable-for-work | business | 9 | **f** |
| os-usable-for-work | connections | 13 | **f** |
| os-usable-for-work | perf | 7 | **f** |
| os-usable-for-work | surfaces | 9 | **f** |
| os-usable-for-work | vault | 25 | **f** |

Confirms the brief exactly: **every multi-task workstream fails the old
direct-membership rule**, including the three (`business`, `perf`) that DO
pass under transitivity, and the three (`connections`, `surfaces`, `vault`)
that fail even under transitivity for an unrelated reason (§4). The three
single-task workstreams (`detect`, `panel`, `preview`) are the only ones the
old rule already handles, because direct and transitive coincide when the
workstream is one task. `toggle` fails both old and new for a third,
different reason (§4).

## 4. Which projects close under A, and under B — and why the others don't

**Under Rule A:** only `aios-chat-reference-navigation` closes (all 5 of its
workstreams satisfy Rule A). `os-usable-for-work` stays held (3 of 6
workstreams fail: `connections`, `surfaces`, `vault`). `aios-sidebar-live-sessions`
stays held (`toggle` fails).

**Under Rule B:** identical verdict — `aios-chat-reference-navigation` closes,
the other two stay held, on the same three workstreams (`connections`,
`surfaces`, `vault`) plus `toggle`. Rule B is not merely "weaker but doesn't
matter here" — it was checked task-by-task (§1c) and genuinely fails to
rescue any of the four failing workstreams, because the failure mode isn't a
tree-with-two-leaves that only a single integrator misses. See below.

### Why `business` and `perf` needed the fix and got it (the textbook case)

`business` (9 tasks) is a straight chain: `0→1→{2,2}→3→4→5` plus two
unconnected planner/scout tasks (`499→500`), with the workstream's last task
(round 5, "Re-review after fix cycle 1 · business") reachable transitively
from a `main` integrator that only directly names an earlier round. Old rule:
`f`. Transitive Rule A: `t`. This is exactly the bug described in the brief.

### Why `connections`, `surfaces`, `vault` still fail — NOT tree-vs-chain

Pulled every task row and its `depends_on` for these three workstreams. In
each case exactly the tasks explicitly marked `[FOLDED into ...]` or
`[RETIRED as duplicate of ...]` in their own title are the ones no other task
— in `main` or in the workstream itself — ever lists in `depends_on`:

- `os-usable-for-work` / `connections`, round 7,
  `832fdfdc-95dd-4aad-b0c6-f909f1b74010`,
  `"[FOLDED into rereview:connections:4:1] Re-review after fix cycle 2 · connections"`.
  `SELECT ... WHERE depends_on @> ARRAY['832fdfdc-...']` returns **zero rows** —
  nothing anywhere points at it, ever.
- `os-usable-for-work` / `vault`, round 4,
  `6c6fb2c8-d13b-4567-89b7-ceca70f21be0`,
  `"[RETIRED as duplicate of fix:vault:3:1] B1e — fix all three red-team blockers..."`,
  `depends_on` itself is empty and nothing depends on it either.
- `os-usable-for-work` / `surfaces`: two tasks, round 3
  (`e282aed9-9566-456e-91ae-a3ed14830424`, "Fix cycle 1 · surfaces") and round 4
  (`da6385eb-a845-4a01-930e-7555271a0282`, "Re-review after fix cycle 1 ·
  surfaces") form their own two-task sub-chain off round 2, but the
  workstream's later continuation (round 8, "GOALS is built...") has
  `depends_on = {}` — it does **not** chain from round 4 at all. The round-4
  task is a genuine dead end: `SELECT ... WHERE depends_on @>
  ARRAY['da6385eb-...']` returns zero rows.

None of these are "a tree with two leaves that a single integrator can't
cover but the union could." They are single dead-end nodes that **no task in
the entire project, main or otherwise, ever names in `depends_on`** — a
retired/folded/superseded branch tip. Transitive reachability cannot help:
there is nothing to be transitively reachable *from* on the far side of a node
nobody points at. Rule B (union of integrators) doesn't help either, for the
identical reason — union-of-reachable-sets still excludes a node nobody's
`depends_on` chain ever touches.

### Why `toggle` fails — a workstream that was never given an integrator, period

Pulled all 17 tasks of `aios-sidebar-live-sessions`. The `toggle` workstream
(4 tasks, rounds 3–6: `ffd72985`→`89fa0ad2`→`6fbf3a43`→`e7684092`, a clean
internal chain) has **no `main`-workstream task, at any round, that lists any
`toggle` task id in its `depends_on`** — checked by hand across all 13 `main`
rows. `main`'s own chain (`d23b5dd8`→`d163a0b1`→`d318f4ff`→`6c0a0031`→...)
never branches to touch `toggle` at all. This is precisely the negative case
the brief asked to be preserved: "a project with a genuinely unintegrated
workstream (no main task reaching its tasks at all) must still be held." It
is not a bug in R70's traversal rule — it is a missing integration task that
was never seeded. `unintegratedWorkstreams()` (`forge-control/src/lib/
project-tick.ts:3156`) would correctly report `["toggle"]` for this project
both before and after the R70 fix.

## 5. Termination and performance

- No cycle exists in `depends_on` across the three live projects (§1a, 0
  cyclic self-pairs, 22.8 ms).
- The full Rule A query (recursive CTE + per-integrator coverage aggregation)
  runs in **23.1 ms** server-side over all three projects combined (11
  workstreams, ~190 tasks total). This is well inside any request-timeout
  budget `closeFinishedProjects()` would need.
- Rule B's per-task union check: **34.4 ms**.
- Both queries use `UNION` (not `UNION ALL`) with no `depth` column, per
  [[recursive-cte-depth-column-defeats-the-union-cycle-guard]] — termination is
  by finiteness-plus-dedup over `(project_id, src, dst)`, not by a depth cap.

## Escalation

Per the task brief: "ESCALATE IF RULE A DOES NOT CLOSE ALL THREE." Rule A does
not close two of the three. A reminder was queued
(`POST /api/reminders`) and a report was sent to the manager chat
(`f97efebb-ce0d-47e9-8e20-0d0c4ec4f888`) stating: which workstreams fail Rule
A, that Rule B does **not** rescue them (a correction to the brief's working
assumption that it might), the true root cause (folded/retired dead-end tasks
plus one wholly unintegrated workstream, not a tree-vs-chain shape), and that
the default being taken is to ship Rule A and leave `os-usable-for-work` and
`aios-sidebar-live-sessions` held pending either (a) a human/architect task
that adds real integration tasks for `connections`/`surfaces`/`vault`/`toggle`,
or (b) a deliberate ruling that folded/retired tasks should be exempted from
R70's "every task of W" requirement.

## Answers to the deliverable's explicit questions

1. Exact SQL: §1 above, verbatim.
2. Table: §2 above.
3. Old direct-membership predicate, RED half: §3 above.
4. Which of the three projects close under A, and under B: **only
   `aios-chat-reference-navigation` closes under either rule.**
   `os-usable-for-work` and `aios-sidebar-live-sessions` stay held under
   both A and B.
5. Query termination/wall-clock: confirmed prompt, 22.8–36.1 ms per query,
   §5. No cycle found in live `depends_on` data for these three projects.
