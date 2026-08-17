# Round 1350 — dismissal persistence API (server half)

Phase 6 item 1. `ui_dismissals` + four endpoints on `/api/agents/dismissals`.
Client half (swapping `forge-control-web/app/desktop/team/dismissals.ts`'s
localStorage for these calls) is a sibling task.

## Design: a table, not a column on `runs`

`ui_dismissals(node_id text PRIMARY KEY, kind text, dismissed_at timestamptz)`
is free-standing, with no FK to `runs`, for three reasons. (1) Ownership:
`runs` is written by the engine files this cycle puts off limits
(project-tick.ts, cc-runner.ts, executor.ts, db/projects.ts), and a read-side
UI preference has no business widening the engine's row. (2) Not every node id
is a run: the panel keys sub-agent rows on the spawn's `tool_use_id`, a string
that lives inside `runs.thread` JSONB and is a row nowhere — a column on `runs`
could not hold it, and the transcript below stores one (`toolu_01ProbeSubagent`,
`kind='subagent'`). (3) Reversibility: a dismissal is a HIDE. Nothing in this
round writes to `runs`, `/api/agents` and `/api/chat/:id/team` never filter on
`dismissed_at` — they only carry it — and restoring is one DELETE against a
table the run row never knew about. The cascade rule itself is a pure function
(`lib/dismissals.ts`) so it is provable without a database; the SQL is
route-local in `routes/agents.ts` as the round's constraints require.

Single viewer (Konrad), so no user column. The migration header states the
widening path (`viewer` column, composite PK) if that ever changes.

**DEPLOY ORDER**: `/api/agents` and the team query LEFT JOIN this table. Apply
`db/migrations/0041_ui_dismissals.sql` to content_forge BEFORE restarting
forge-control with this code, or every agents query fails with
"relation ui_dismissals does not exist".

## tsc + unit tests (worktree)

```
$ cd forge-control && npx tsc --noEmit && echo "TSC CLEAN"
TSC CLEAN

$ npm test          # tsx --test src/lib/*.test.ts
1..182
# tests 855
# suites 165
# pass 855
# fail 0

$ npx tsx --test src/lib/dismissals.test.ts
# tests 13
# suites 2
# pass 13
# fail 0
```

13 cases over `resolveCascade`: leaf; two settled children; settled + running
sibling; running excluded at every depth while the walk continues past it (a
settled grandchild under a live child IS hidden); the target returned even
while running; a manager taking its project's settled workers and their
descendants; a chat that is nobody's origin chat; unknown id (the sub-agent
case — no row exists, `[id]` is the answer); `parent_run_id` cycles including
self-reference; order determinism against a reversed input; idempotence.

## Integration transcript — scratch database, never production

`forge_dismiss_probe`: schema-only clone of `runs`/`projects`/`project_tasks`
(`pg_dump -s`), migration 0041 applied, 7 synthetic runs seeded. Served by
`scripts/checks/serve-v3-7798.ts` (unmodified) on port 7819 with
`DATABASE_URL` pointed at the probe db. Production was never written to and no
service was restarted.

```
=== 0. seed (scratch db forge_dismiss_probe, schema-only clone of runs/projects/project_tasks + 0041) ===
    id    |  status   |   role   |  parent  
----------+-----------+----------+----------
 11111111 | completed |          | 
 22222222 | completed | builder  | 
 33333333 | running   | reviewer | 
 44444444 | failed    | scout    | 
 55555555 | completed | builder  | 22222222
 66666666 | running   |          | 
 77777777 | completed |          | 66666666
(7 rows)

project aaaaaaaa-…0001 has metadata.origin_chat_id = 11111111-… (the manager/operator chat)

$ curl -s $B/dismissals
{"node_ids":[],"count":0}
$ curl -s $B | jq -c '[.agents[] | {id: .id[0:8], status, kind: .agent_kind, role, dismissed_at}]'
[{"id":"66666666","status":"running","kind":"cron","role":null,"dismissed_at":null},{"id":"33333333","status":"running","kind":"worker","role":"reviewer","dismissed_at":null},{"id":"77777777","status":"completed","kind":"unknown","role":null,"dismissed_at":null},{"id":"11111111","status":"completed","kind":"operator","role":null,"dismissed_at":null},{"id":"55555555","status":"completed","kind":"worker","role":"builder","dismissed_at":null},{"id":"22222222","status":"completed","kind":"worker","role":"builder","dismissed_at":null},{"id":"44444444","status":"failed","kind":"worker","role":"scout","dismissed_at":null}]

=== 1. dismiss the MANAGER — cascade takes the project's SETTLED workers, never the running one ===

$ curl -s -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"11111111-1111-4111-8111-111111111111"}' | jq -c
{"dismissed":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"]}
   11111111 manager · 22222222 builder(completed) · 44444444 scout(failed) · 55555555 builder-child(completed)
   NOT hidden: 33333333 reviewer(RUNNING), 66666666/77777777 (another project's tree)

$ curl -s $B | jq -c '[.agents[] | {id: .id[0:8], status, hidden: (.dismissed_at != null)}]'
[{"id":"66666666","status":"running","hidden":false},{"id":"33333333","status":"running","hidden":false},{"id":"77777777","status":"completed","hidden":false},{"id":"11111111","status":"completed","hidden":true},{"id":"55555555","status":"completed","hidden":true},{"id":"22222222","status":"completed","hidden":true},{"id":"44444444","status":"failed","hidden":true}]

$ curl -s $B/dismissals | jq -c
{"node_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"],"count":4}

=== 2. POST again — idempotent, same set, 200 ===

$ curl -s -o /tmp/p2.json -w 'http=%{http_code}\n' -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"11111111-1111-4111-8111-111111111111"}'; cat /tmp/p2.json
http=200
{"dismissed":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"]}
$ psql "$PROBE" -tAc 'SELECT count(*) AS rows_in_ui_dismissals FROM ui_dismissals'
4

=== 3. cascade:false hides exactly one row ===

$ curl -s -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"66666666-6666-4666-8666-666666666666","cascade":false}' | jq -c
{"dismissed":["66666666-6666-4666-8666-666666666666"]}

$ curl -s $B | jq -c '[.agents[] | select(.dismissed_at != null) | .id[0:8]]'
["66666666","11111111","55555555","22222222","44444444"]

=== 4. a sub-agent node id (tool_use_id, not a run) is accepted and stored as kind=subagent ===

$ curl -s -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"toolu_01ProbeSubagent"}' | jq -c
{"dismissed":["toolu_01ProbeSubagent"]}

$ psql "$PROBE" -c 'SELECT node_id, kind FROM ui_dismissals ORDER BY kind, node_id'
               node_id                |   kind   
--------------------------------------+----------
 11111111-1111-4111-8111-111111111111 | run
 22222222-2222-4222-8222-222222222222 | run
 44444444-4444-4444-8444-444444444444 | run
 55555555-5555-4555-8555-555555555555 | run
 66666666-6666-4666-8666-666666666666 | run
 toolu_01ProbeSubagent                | subagent
(6 rows)


=== 5. bad input → 400 with a reason, never a silent no-op ===

$ curl -s -o /dev/null -w 'http=%{http_code} ' -X POST $B/dismissals -H 'content-type: application/json' -d '{}'; curl -s -X POST $B/dismissals -H 'content-type: application/json' -d '{}'
http=400 {"error":"id must be a string"}
$ curl -s -o /dev/null -w 'http=%{http_code} ' -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"  "}'; curl -s -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"  "}'
http=400 {"error":"id must not be empty"}
$ curl -s -o /dev/null -w 'http=%{http_code} ' -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"x","cascade":"yes"}'; curl -s -X POST $B/dismissals -H 'content-type: application/json' -d '{"id":"x","cascade":"yes"}'
http=400 {"error":"cascade must be a boolean"}
$ curl -s -X DELETE $B/dismissals/x | jq -c   # restore the row that 400-test left behind? (it never inserted)
{"restored":[]}

=== 6. 'dismissals' is not eaten by GET /:id (route order) ===

$ curl -s -o /dev/null -w 'GET /api/agents/dismissals -> http=%{http_code}\n' $B/dismissals
GET /api/agents/dismissals -> http=200

$ curl -s $B/11111111-1111-4111-8111-111111111111 | jq -c '.agent | {id: .id[0:8], dismissed_at}'
{"id":"11111111","dismissed_at":"2026-08-17 03:33:26.491061+00"}

=== 7. DELETE one id — restores that id only, cascade is NOT undone ===

$ curl -s -X DELETE $B/dismissals/22222222-2222-4222-8222-222222222222 | jq -c
{"restored":["22222222-2222-4222-8222-222222222222"]}

$ curl -s -X DELETE $B/dismissals/22222222-2222-4222-8222-222222222222 | jq -c   # already gone: [] and 200
{"restored":[]}

$ curl -s $B/dismissals | jq -c
{"node_ids":["toolu_01ProbeSubagent","66666666-6666-4666-8666-666666666666","11111111-1111-4111-8111-111111111111","44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555"],"count":5}

=== 8. the team tree carries dismissed_at per node ===

$ curl -s $C/11111111-1111-4111-8111-111111111111/team | jq -c '{complete, errors, manager: {id: .manager.id[0:8], dismissed_at: .manager.dismissed_at}, workers: [.workers[] | {id: .id[0:8], status, dismissed_at}]}'
{"complete":true,"errors":[],"manager":{"id":"11111111","dismissed_at":"2026-08-17 03:33:26.491061+00"},"workers":[{"id":"22222222","status":"completed","dismissed_at":null},{"id":"33333333","status":"running","dismissed_at":null},{"id":"44444444","status":"failed","dismissed_at":"2026-08-17 03:33:26.491061+00"},{"id":"55555555","status":"completed","dismissed_at":"2026-08-17 03:33:26.491061+00"}]}

=== 9. DELETE all — the escape hatch ===

$ curl -s -X DELETE $B/dismissals | jq -c
{"restored":5}

$ curl -s $B/dismissals | jq -c
{"node_ids":[],"count":0}

$ curl -s $B | jq -c '[.agents[] | select(.dismissed_at != null)] | length'
0

=== 10. sanity: one full row, unchanged apart from the new field ===

$ curl -s $B | jq '.agents[0]'
{
  "kind": "run",
  "id": "66666666-6666-4666-8666-666666666666",
  "title": "unrelated cron",
  "status": "running",
  "worker": "skylab-producer",
  "model": null,
  "effort": null,
  "engine": "claude-code",
  "cwd": null,
  "started_at": "2026-08-17 03:21:41.003212+00",
  "updated_at": "2026-08-17 03:31:41.003212+00",
  "last_heartbeat_at": null,
  "elapsed_ms": 705976,
  "settled": false,
  "settled_at": null,
  "spent_usd": 0,
  "usage_total": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "turns": 0,
    "cost_usd": 0,
    "thinking_tokens": 0
  },
  "usage_last_turn": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  },
  "usage_running": null,
  "usage_by_model": [],
  "current_activity": null,
  "parent_run_id": null,
  "agent_kind": "cron",
  "role": null,
  "project_id": null,
  "cron_name": "weekly-review",
  "dismissed_at": null,
  "subagents": []
}
```
