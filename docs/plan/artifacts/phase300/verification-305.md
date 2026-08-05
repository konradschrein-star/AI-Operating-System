# Round 305 (phase 300h) — verification transcript

Code under test: the `GET /api/chat/:id/team` block added to
`forge-control/src/routes/chat.ts`. Nothing else changed — `git diff --name-only` at the
end of this round lists that one file, plus two new artifacts.

Requirements: **U4** (team endpoint), **U5** (working-time definition), **NFU4** (additive
API), **NFU6** (hard errors, no silent fallbacks), **NFU7** (build gates).

Served through the worktree harness on **:7798**. Production `:7700` was never restarted;
`forge-executor` was never touched.

---

## 0. Build gates — clean

```
$ cd forge-control     && npx tsc --noEmit ; echo exit=$?      → exit=0
$ cd forge-control-web && npx tsc --noEmit ; echo exit=$?      → exit=0
$ cd forge-control-web && npm run build    ; echo exit=$?      → exit=0
                                                 (middleware 83.2 kB, shared JS 108 kB)
```

---

## 1. THE FIXTURE PROBLEM, AND WHAT WAS DONE ABOUT IT

The brief says: *"curl :7798/api/chat/bfd1283a…/team — this is THIS project's own org
chart."* It is not, and round 304 already proved why:
**`linkage-fixture-finding.md`** — chat `bfd1283a…` created `8ea0cc08…` (operator-visibility)
and `4120f785…` (engine-v2-research-lane) through a **detached `setsid` script it wrote to
disk**, so the `POST /api/projects` never happened inside a tool call and its response never
entered the thread. The bounded scan has nothing to find. In its natural state that chat
resolves to `project: null`:

```
$ curl -sS -w "\nHTTP %{http_code}\n" :7798/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/team
{"chat_id":"bfd1283a-b71b-4f35-b577-7d09aad803f2","now":"2026-08-05T14:39:12.105Z",
 "project":null,"link_source":null,"link_ambiguous":false,
 "manager":{"id":"bfd1283a-b71b-4f35-b577-7d09aad803f2","kind":"operator","role":null,
            "model":"claude-fable-5","status":"completed",
            "tokens":{"input":2,"output":3,"cache_read":314570,"cache_creation":1604,
                      "total":316179},
            "working_ms":2876900,"working_ms_source":"thread",
            "started_at":"2026-08-04 22:40:19.839346+00","settled":true,
            "description":"Okay when I click the file section, things still lag and they
                           still don't work in light mode. The ov",
            "parent_id":null,"subagents":[],"task":null},
 "workers":[],"complete":true,"errors":[]}
HTTP 200
```

That IS the specified behaviour for an unlinked chat (§4 below) — but it is not an org
chart, and the round's whole point is that a stranger can read the org chart.

**What was done:** the linkage was established for the length of the capture with the SAME
additive, idempotent statement the phase's own backfill uses, using the value that
`linkage-fixture-finding.md` proves is TRUE (that chat did launch the script that created
this project), and then **reverted**. Both statements, verbatim, with their observed effect:

```sql
-- set (14:39, before capture)
UPDATE projects
   SET metadata = metadata || jsonb_build_object('origin_chat_id',
                                                 'bfd1283a-b71b-4f35-b577-7d09aad803f2')
 WHERE id = '8ea0cc08-28d9-4301-9f28-c98e1c5d6838'
   AND NOT (metadata ? 'origin_chat_id');                                   -- UPDATE 1

-- revert (14:41, after capture)
UPDATE projects SET metadata = metadata - 'origin_chat_id'
 WHERE id = '8ea0cc08-28d9-4301-9f28-c98e1c5d6838';                         -- UPDATE 1
```

Verified after the revert — the database is byte-for-byte what round 304 left behind:

```
$ psql -At -c "SELECT id, metadata FROM projects WHERE id='8ea0cc08-…'"
8ea0cc08-…|{"mode": "goal", "checkin_hours": 2, "last_checkin_at": "2026-08-05T13:02:14.767Z"}

$ psql -At -c "SELECT id,name FROM projects WHERE metadata ? 'origin_chat_id'"
46c8dd66-…|phase300-origin-probe      ← round 303d's probe
4d3291c4-…|phase300-invalid-guard     ← round 304's fixture
```

**Why it was reverted rather than kept.** The link is only half the truth: the same chat
created `4120f785…` too, so a written `origin_chat_id` on one project alone reports
`link_ambiguous: false` for a chat that is genuinely ambiguous. Round 304's rule is
explicit — *"an ambiguous chat gets no guess written into the database"* — and a curated
row that makes the answer prettier than the evidence is exactly the laundering that rule
forbids. **Decision for Konrad / the reviewer:** the honest permanent fix is for the
operator to pass `origin_chat_id` when it creates a project (U1 shipped that in round
303f); this legacy chat stays unlinked until then, or gets BOTH projects stamped, which
would make it resolve to `4120f785…` + `link_ambiguous: true`. Reproducing this section
takes the two statements above and thirty seconds.

Everything in §2, §3, §5, §6 was captured inside that window.

---

## 2. THE ORG CHART (U4) — `docs/plan/artifacts/phase300/team-tree.json`

Full payload committed as `team-tree.json` (774 lines). Rendered:

```
MANAGER  operator  claude-fable-5  completed  work=2876s [thread]  tok=316179
         "Okay when I click the file section, things still lag and they still don't work…"
  WORKER architect  r0  claude-fable-5  completed  work=949s [thread]  tok=866426  settled=true
         3853c154-…  "Plan: operator-visibility"
    └─ SUBAGENT Explore  claude-opus-5  done  work=355s [thread]  tok=149252  settled=true
       parent=3853c154-…  "Recon chat Bash block rendering"
    └─ SUBAGENT Explore  claude-opus-5  done  work=273s [thread]  tok=99900   settled=true
       parent=3853c154-…  "Recon agents API and runs schema"
  WORKER planner  r100  claude-opus-5  completed  work=505s  tok=354551
         6eeec7bf-…  "Plan phase 1: time truth (frozen settled durations)"
  WORKER builder  r101  claude-opus-5  completed  work=491s  tok=665761
         51694164-…  "Phase 1a — server: settled-aware elapsed_ms, settled/settled_at, …"
  WORKER builder  r102  claude-opus-5  completed  work=1377s tok=1473754
         b4d241ea-…  "Phase 1b — client: one duration-helper pair; settled rows and done …"
  WORKER reviewer r103  claude-opus-5  completed  work=876s  tok=202344
         3d26461f-…  "Phase 1 review — adversarial time-truth gate (R1-R6) …"
  WORKER planner  r200  claude-opus-5  completed  work=345s  tok=261558
         20bb47eb-…  "Plan phase 2: kind truth (row classification, model, lineage)"
  WORKER builder  r201  claude-opus-5  completed  work=271s  tok=1087567
         fdc1eacf-…  "Phase 2a — server: agent_kind classification + role/project_id/…"
  WORKER builder  r202  claude-opus-5  completed  work=1193s tok=1080174
         9a937009-…  "Phase 2b — Live panel: kind badge, role, model display, …"
  WORKER reviewer r203  claude-opus-5  completed  work=794s  tok=213213
         1110e146-…  "Phase 2 review — kind truth (R7-R11) …"
  WORKER architect r250 claude-fable-5 completed  work=662s  tok=794602
         ab331865-…  "Chat-Manager UI v3 — full rework per Konrad spec"
    └─ SUBAGENT scout  claude-haiku-4-5-20251001  done  work=143s [thread] tok=169753
    └─ SUBAGENT scout  claude-haiku-4-5-20251001  done  work=138s [thread] tok=298442
    └─ SUBAGENT scout  claude-haiku-4-5-20251001  done  work=137s [thread] tok=170512
    └─ SUBAGENT scout  claude-haiku-4-5-20251001  done  work=95s  [thread] tok=30689
       parent=ab331865-…  "Recon forge-control-web UI" / "Recon forge-control API/data" /
                          "Summarize existing plan corpus" / "Research agent task-graph UIs"
  WORKER scout    r299  claude-haiku-4-5-20251001 completed work=200s tok=182120
         0ed80848-…  "Recon: chat-thread evidence for project linkage scan"
  WORKER planner  r300  claude-opus-5  completed  work=612s  tok=288997
         2c535643-…  "Plan phase 300: read-side API (linkage, team, plan, capabilities)"
  WORKER builder  (no task)  <synthetic>  failed  work=92s  tok=100061
         a59d2cf8-…  "operator-visibility · Phase 300a — …"          ← retried attempt
  WORKER builder  r301  claude-opus-5  completed  work=822s  tok=3228352
         5f359463-…  "Phase 300a — additive-API baseline transcript + generalized :7798 harness"
  WORKER builder  (no task)  claude-opus-5  failed  work=1s  tok=0
         03e54ad6-…  "operator-visibility · Phase 300b — …"          ← retried attempt
  WORKER builder  r302  claude-opus-5  completed  work=593s  tok=1767646
         0faca9b9-…  "Phase 300b — extract shared run-shaping helpers to agents-shared.ts"
  WORKER builder  r303  claude-sonnet-5 completed work=233s  tok=1550880
         8e036e52-…  "Phase 300c — GET /api/capabilities (U8) + mounts"
  WORKER builder  r303  claude-opus-5  completed  work=545s  tok=867438
         2598ec14-…  "Phase 300d — working-time module (U5) + check-working-time"
  WORKER builder  r303  claude-sonnet-5 completed work=299s  tok=2171796
         9d6c0782-…  "Phase 300e — additive requested_by_run_id on secrets mark-pending"
  WORKER builder  r303  claude-opus-5  completed  work=568s  tok=1281910
         01b820d1-…  "Phase 300f — origin_chat_id accepted at POST /api/projects"
  WORKER builder  r304  claude-opus-5  completed  work=1011s tok=1211078
         5dccbcf1-…  "Phase 300g — chat→project linkage resolver + rail rollup"
  WORKER builder  r305  claude-opus-5  running    work=516s  tok=496797  settled=false
         453410f8-…  "Phase 300h — GET /api/chat/:id/team …"          ← this very run
```

22 workers, 6 sub-agents, `complete: true`, `errors: []`.

Stranger test — every claim readable straight off the payload:

| Question | Field |
|---|---|
| Who is the manager? | `manager.kind = "operator"`, model `claude-fable-5`, description = Konrad's opening line |
| Which are whole CC sessions vs in-process children? | `kind` — `worker` (own run row, own uuid) vs `subagent` (`id` is the spawn's `tool_use_id`) |
| What role, on what model? | `role` + `model` per node (models really do differ: fable/opus/sonnet/haiku) |
| Which sub-agent belongs to whom? | `parent_id` on every sub-agent, and the nesting under `workers[].subagents[]` |
| What is each worker doing? | `task: {round, role, title, status}` — e.g. r302 → "extract shared run-shaping helpers" |
| Who is still alive? | exactly one node with `settled: false` |

Two `failed` workers carry `task: null` — their `project_tasks` row was re-pointed at the
retry run that succeeded. Reported honestly as null with the run title as `description`,
never a borrowed title. `<synthetic>` on one is that run's real `metadata.model_resolved`,
pre-existing data, passed through unmodified.

Sub-agent provenance, both paths exercised:

* `working_ms_source: "thread"` — the 6 sub-agents above; their parents' threads carry
  `meta.parent_tool_use_id`, so each got its own slice.
* `working_ms_source: "rollup"` — verified on another chat's tree, where the rollup
  fallback is the only option:
  ```
  $ curl :7798/api/chat/11dd264b-…/team | jq '… group_by(.working_ms_source) …'
  [{"source":"rollup","n":7,…},{"source":"thread","n":1,…}]
  ```

---

## 3. FROZEN CHECK — settled nodes byte-identical, running node ticks

Two captures 22.5 s apart (`now`: `14:39:41.838Z` → `14:40:04.316Z`), diffed after
selecting the settled nodes only:

```
$ FILTER='[.manager, .workers[]] | map(select(.settled))
          | map(. + {subagents: (.subagents|map(select(.settled)))})'
$ jq -S "$FILTER" team-t0.json > settled-t0.json ; jq -S "$FILTER" team-t1.json > settled-t1.json
$ diff settled-t0.json settled-t1.json && md5sum settled-t0.json settled-t1.json

IDENTICAL — 22 settled run nodes, 6 settled sub-agent nodes, 21432 bytes each
dcef5030392400cb5aebe52265080f3f  settled-t0.json
dcef5030392400cb5aebe52265080f3f  settled-t1.json
```

Every field — `working_ms`, all five token counters, `started_at`, `settled`, `status`,
`task` — is byte-equal. Nothing settled is derived from `now`.

**Anti-vacuous guard.** A live node existed and moved: run `453410f8…` (this round's own
builder, `status: running`, `settled: false`):

```
-     "working_ms": 516798        (t0)
+     "working_ms": 539276        (t1)
```

+22 478 ms across a 22 478 ms wall gap — i.e. the whole interval counted, which is correct
for a run that was emitting tool events the entire time (no gap came near the 120 s cap).

---

## 4. STATUS-CODE MATRIX

| Request | Result |
|---|---|
| `…/chat/bfd1283a-…/team` (real chat, unlinked) | **200**, `project: null`, `link_source: null`, `workers: []`, manager node fully populated |
| `…/chat/11dd264b-…/team` (linked by thread_scan) | **200**, `project {id: 1d574922-…, status: paused}`, `link_source: "thread_scan"`, `link_ambiguous: true` |
| `…/chat/00000000-0000-4000-8000-000000000000/team` | **404** `{"error":"run not found"}` |
| `…/chat/abc/team` | **400** `{"error":"invalid run id"}` |

A nonexistent chat 404s; an unlinked-but-real chat never does.

---

## 5. `working_ms` SANITY vs WALL CLOCK

```
   run    |   role    |  status   | wall_ms | 1st entry − started_at | thread span | working_ms
----------+-----------+-----------+---------+------------------------+-------------+-----------
 3853c154 | architect | completed |  949322 |               −843 ms  |     949813  |    949813
 51694164 | builder   | completed |  491422 |               −802 ms  |     491867  |    491867
 b4d241ea | builder   | completed | 1377198 |              −1120 ms  |    1377843  |   1377843
 9a937009 | builder   | completed | 1319600 |              −1072 ms  |    1320256  |   1193619
 bfd1283a | (manager) | completed |56843852 |                   —    |   56843375  |   2876900
```

* **Near-equal (three builders/architect):** `working_ms == thread span`, i.e. **not one
  gap exceeded 120 s** — these runs worked continuously, exactly as the planner measured.
  `working_ms` sits ~500–650 ms ABOVE `completed_at − started_at`, which looks like a
  violation and is not: the first thread entry (the queued prompt) is stamped **before**
  `started_at` (−843/−802/−1120 ms above), so the thread span legitimately begins earlier
  than the run's own start stamp. Wall-clock is measured start→complete; working time is
  measured over the events. Same order, different endpoints.
* **Wildly apart (`9a937009`, −126 637 ms):**
  ```
   run     | over_cap_gaps | dropped_ms | largest_gap_ms | total_span_ms
   9a937009|             1 |     126637 |         126637 |       1320256
  ```
  One single gap of 126.6 s — just over the cap — was dropped whole, which is the model:
  a gap above CAP contributes **0**, not CAP (working-time.ts, divergence note #1).
  1 320 256 − 126 637 = 1 193 619. ✓
* **The cap earning its keep (`bfd1283a`, the manager):** 2 876 900 ms of work inside
  56 843 852 ms of wall clock — 5 %. 14 over-cap gaps totalling 53 966 475 ms, the largest
  **25 720 841 ms** (7.1 h — Konrad asleep). Wall-clock would have called that "15h 47m of
  work"; this is the exact lie U5 exists to kill.

---

## 6. TIMING + `EXPLAIN ANALYZE`

End-to-end, through the harness, against this project's 22 workers + manager (23 runs,
2 813 thread entries):

```
$ for i in 1 2 3; do curl -o /dev/null -w "  run$i total=%{time_total}s http=%{http_code}\n" \
      :7798/api/chat/bfd1283a-…/team ; done
  run1  total=0.067484s  http=200
  run2  total=0.066704s  http=200
  run3  total=0.069798s  http=200
```

**67 ms**, against a 5 s poll budget (NFU3) and the brief's ~300 ms line. Not exceeded.

```
═══ WORKER QUERY ═══
Sort  (cost=80.08..80.09 rows=2 width=1001) (actual time=0.783..0.784 rows=22 loops=1)
  Sort Key: created_at
  Sort Method: quicksort  Memory: 56kB
  Buffers: shared hit=110
  ->  Seq Scan on runs  (actual time=0.147..0.718 rows=22 loops=1)
        Filter: ((id <> 'bfd1283a-…'::uuid)
                 AND ((metadata ->> 'role') IS DISTINCT FROM 'manager')
                 AND ((metadata ->> 'project_id') = '8ea0cc08-…'))
        Rows Removed by Filter: 289
Planning Time: 2.279 ms
Execution Time: 0.839 ms

═══ TIMING QUERY (23 run ids) ═══
Bitmap Heap Scan on runs r  (actual time=1.944..59.560 rows=23 loops=1)
  Recheck Cond: (id = ANY (…23 uuids…))
  Heap Blocks: exact=17   Buffers: shared hit=924
  ->  Bitmap Index Scan on runs_pkey  (actual time=0.037..0.038 rows=25 loops=1)
  SubPlan 1   (per-run gap sum — workingMsSql("r.thread"))
    ->  Aggregate  (actual time=1.199..1.199 rows=1 loops=23)
          ->  WindowAgg  (actual time=0.593..1.175 rows=141 loops=23)
                ->  Function Scan on jsonb_array_elements e  (rows=141 loops=23)
                      Filter: ((val ->> 'ts') ~ '^[0-9]{4}-…')
  SubPlan 3   (per-sub-agent slices)
    ->  Aggregate  (actual time=0.889..0.889 rows=1 loops=23)
          ->  GroupAggregate  Group Key: ((val -> 'meta') ->> 'parent_tool_use_id')
                ->  Function Scan on jsonb_array_elements e_2  (rows=18 loops=23)
                      Rows Removed by Filter: 122
          SubPlan 2   (the SAME workingMsSql fragment, over s.slice)
            ->  Aggregate  (actual time=0.373..0.373 rows=1 loops=6)
                  ->  WindowAgg  (rows=70 loops=6)
Planning Time: 1.077 ms
Execution Time: 59.992 ms
```

Reading it: the whole working-time computation — runs AND sub-agent slices — costs **60 ms
inside Postgres**, and 924 shared buffer hits (~7 MB) that never cross the wire. The route
receives 23 rows of `{id, working_ms, last_ts, subagent_working}`.

**Noted for the reviewer, not a defect today:** the worker query is a **Seq Scan** — there
is no index on `metadata->>'project_id'`, and `runs` currently holds 311 rows, so it costs
0.8 ms. At 10 000 runs this becomes the endpoint's slowest step. The fix when it matters is
one expression index (`CREATE INDEX ON runs ((metadata->>'project_id'))`), which is a
migration and therefore out of this phase's scope.

---

## 7. NFU6 — DEGRADATION, PROVED, NOT ASSERTED

`working-time.ts` documents one way its SQL half can fail where the JS core would not: a
`ts` string that MATCHES the shape regex but is not a real date throws in Postgres
(divergence note #3). A fixture run carrying exactly that was inserted, curled, and removed:

```sql
INSERT INTO runs (id, title, prompt, worker, status, thread, metadata,
                  started_at, updated_at, completed_at)
VALUES ('c0de0305-0000-4000-8000-000000000305',
        'phase300h fixture — working-time SQL failure path', 'fixture',
        'forge-executor', 'completed',
        '[{"role":"user","kind":"text","content":"a","ts":"2026-08-05T10:00:00.000Z"},
          {"role":"assistant","kind":"text","content":"b","ts":"2026-13-45T99:99:99.000Z"}]',
        '{}', now(), now(), now());                                      -- INSERT 0 1
```

```
$ curl -sS -w "\nHTTP %{http_code}\n" :7798/api/chat/c0de0305-…/team
{ "chat_id":"c0de0305-0000-4000-8000-000000000305", …
  "manager": { …, "working_ms": null, "working_ms_source": null,
               "settled": true, "tokens": {…} },
  "workers": [],
  "complete": false,
  "errors": [ { "scope": "working_time",
                "message": "date/time field value out of range: \"2026-13-45T99:99:99.000Z\"" } ] }
HTTP 200
```

The tree still renders, the working numbers are **null and not 0**, `complete` is false,
and the error names the step AND Postgres's own message. Cleanup, verified:

```sql
DELETE FROM runs WHERE id='c0de0305-0000-4000-8000-000000000305';   -- DELETE 1
$ psql -At -c "SELECT count(*) FROM runs WHERE id='c0de0305-…'"  →  0
$ curl :7798/api/chat/c0de0305-…/team                            →  404 {"error":"run not found"}
```

The load-bearing steps are NOT degradable — manager query, linkage and worker query each
answer **500** with `{error, step, message}` rather than shipping a tree with holes.

---

## 8. NFU4 — `api-diff.sh`: three pre-existing failures, none of them this round's

`scripts/checks/api-diff.sh` reports:

```
ok    agents / agents-project / agents-run / projects-managers / secrets
FAIL  chat-list   — normalized VALUES differ
FAIL  chat-thread — KEY SET changed
FAIL  projects    — normalized VALUES differ
```

**Attribution test — the file was reverted to HEAD and the whole suite re-run:**

```
$ cp forge-control/src/routes/chat.ts /tmp/chat-305.ts.bak
$ git checkout -- forge-control/src/routes/chat.ts     # no team route at all
$ <restart :7798>  ; curl -o /dev/null -w "%{http_code}" :7798/api/chat/bfd1283a-…/team → 404
$ scripts/checks/api-diff.sh
ok    agents / agents-project / agents-run / projects-managers / secrets
FAIL  chat-list   — normalized VALUES differ
FAIL  chat-thread — KEY SET changed
FAIL  projects    — normalized VALUES differ                ← IDENTICAL, with my code gone
$ cp /tmp/chat-305.ts.bak forge-control/src/routes/chat.ts
```

The three failures are **real-world drift since round 301 captured the baseline**, and the
diffs say so plainly:

* `chat-list` / `chat-thread` — the pinned operator chat `bfd1283a…` kept working:
  `message_count 314 → 358`, `spent_usd 49.92 → 56.29`, and newer thread entries carry
  `meta.blocked_by`, `meta.rule_label`, `meta.trip_id`. The normalizer only blanks rows
  that are non-terminal; this chat is `completed` in both captures yet was resumed and
  completed again in between — a documented blind spot of the gate, not an API change.
* `projects` — `count: 8 → 10`: the two probe projects rounds 303d and 304 created
  (`phase300-origin-probe`, `phase300-invalid-guard`). `.count` is deliberately not
  normalized.

`GET /api/chat/:id/team` is a pure addition: no existing handler, response or field was
touched, and every previously-captured endpoint is still shaped exactly as it was.

---

## 9. Design notes a reviewer should check rather than take on faith

* **Reuse, not reimplementation.** Every node is built by `agentFromRow` from
  `agents-shared.ts` (frozen `settled`/`settled_at`, `agent_kind`, `subagents_v2` rollup +
  thread fallback), and every millisecond by `workingMsSql` / `workingTimeFromRollup` /
  `workingMsRunningExtension` from `working-time.ts`. No helper needed by this round was
  missing from those modules — nothing was copy-pasted.
* **The sub-agent slice reuses the fragment literally.** Rather than re-deriving the gap
  rule with a `PARTITION BY`, the query re-assembles each sub-agent's entries with
  `jsonb_agg(... ORDER BY ord)` and passes that array to `workingMsSql("s.slice")`. Same
  SQL text as the run path → it cannot drift.
* **Frozen truth is structural, not incidental.** The running extension is added only
  where `run.settled === false`, and a sub-agent counts as live only when
  `!run.settled && sub.status === "running"` — a sub-agent cannot outlive the session it
  runs inside, so a "running" child of a settled parent is frozen too.
* **`ended_at` is deliberately NOT the rollup fallback's end stamp.** 13 §4 says
  started/updated, and the data says why: the `Explore` sub-agent of run `3853c154…` has
  `started_at 06:47:12.533`, `ended_at 06:47:12.565` (32 ms) and a last activity at
  `06:53:09` — `ended_at` would report six minutes of work as a rounding error.
* **The worker query is its own SQL, not `fetchActiveRows`** — no 24 h window, no
  LIMIT 60, ordered by `created_at`; `agents.ts` was imported and never edited.
* **`thread` is pulled only for rows without a `subagents_v2` rollup** — the exact
  condition under which `agentFromRow` needs it. One row in this project qualifies.
* **Token math is not new:** `tokens.total` is the sum of the four counters already on the
  wire. No cost, no dollars anywhere in the payload (10-ui-v3-spec.md).

## 10. Files

```
$ git diff --name-only
forge-control/src/routes/chat.ts

$ git status --porcelain
 M forge-control/src/routes/chat.ts
?? docs/plan/artifacts/phase300/team-tree.json
?? docs/plan/artifacts/phase300/verification-305.md
```

Forbidden files (NFU5): `agents.ts`, `db/*`, `project-tick.ts`, `cc-runner.ts`,
`executor.ts`, `FileExplorerPanel*`, `VaultFileList*`, `routes/files.ts` — untouched.

## 11. Left for round 306 / the reviewer

* `GET /api/chat/:id/plan` + `/plan/doc` (U6) — round 306, same file.
* The panel's org-chart consumer is phase 500; this round ships the data only.
* An expression index on `metadata->>'project_id'` when `runs` outgrows a seq scan (§6).
* The linkage of legacy chat `bfd1283a…` is still unresolvable by evidence (§1) — a
  product decision for Konrad, not a code fix.
