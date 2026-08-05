# Rollup cost — the `GET /api/chat` linkage query (round 304 / U3, NFU3)

Two claims, both measured against the live database through the worktree harness on
:7798, 2026-08-05 16:25 CEST.

## 1. ONE aggregate pass

The query, as `rollupChatProjects()` issues it:

```sql
SELECT p.metadata->>'origin_chat_id' AS chat_id,
       p.id::text AS project_id, p.status, p.created_at::text,
       count(t.*)::text AS total,
       count(t.*) FILTER (WHERE t.status = 'done')::text AS done
  FROM projects p
  LEFT JOIN project_tasks t ON t.project_id = p.id
 WHERE p.metadata->>'origin_chat_id' = ANY($1::text[])
 GROUP BY p.metadata->>'origin_chat_id', p.id;
```

`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` with the ten chat ids of a `?limit=10` page:

```
                                                                                                                                                                                                                                 QUERY PLAN
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 HashAggregate  (cost=20.90..21.22 rows=10 width=182) (actual time=2.480..2.484 rows=2 loops=1)
   Output: ((p.metadata ->> 'origin_chat_id'::text)), (p.id)::text, p.status, (p.created_at)::text, (count(t.*))::text, (count(t.*) FILTER (WHERE ((t.status)::text = 'done'::text)))::text, p.id
   Group Key: (p.metadata ->> 'origin_chat_id'::text), p.id
   Batches: 1  Memory Usage: 24kB
   Buffers: shared hit=237
   ->  Hash Right Join  (cost=1.32..18.91 rows=159 width=646) (actual time=1.012..2.473 rows=2 loops=1)
         Output: (p.metadata ->> 'origin_chat_id'::text), p.id, p.status, p.created_at, t.*, t.status
         Inner Unique: true
         Hash Cond: (t.project_id = p.id)
         Buffers: shared hit=237
         ->  Seq Scan on public.project_tasks t  (cost=0.00..16.59 rows=159 width=600) (actual time=0.223..2.396 rows=162 loops=1)
               Output: t.*, t.status, t.project_id
               Buffers: shared hit=236
         ->  Hash  (cost=1.20..1.20 rows=10 width=68) (actual time=0.035..0.037 rows=2 loops=1)
               Output: p.metadata, p.id, p.status, p.created_at
               Buckets: 1024  Batches: 1  Memory Usage: 9kB
               Buffers: shared hit=1
               ->  Seq Scan on public.projects p  (cost=0.03..1.20 rows=10 width=68) (actual time=0.027..0.028 rows=2 loops=1)
                     Output: p.metadata, p.id, p.status, p.created_at
                     Filter: ((p.metadata ->> 'origin_chat_id'::text) = ANY ('{c0de0304-0000-4000-8000-000000000304,bfd1283a-b71b-4f35-b577-7d09aad803f2,a86cf7b3-9283-4315-a389-ab60bd2ea4df,ece63bdb-884c-4d2c-9680-deca13cf2dda,11dd264b-f173-44d7-ada4-f1eb39fb4abd,da286217-6f4c-4d09-9a72-2fd5e26eb2c8,05187ada-069c-479f-9236-e8a58b0fde68,2d39402f-450e-428e-b9b6-acb25fa0b11e,affdba99-f652-4f99-9f62-8ad2936d1f7d,01b820d1-9d46-4c6f-94da-525c5994dfd9}'::text[]))
                     Rows Removed by Filter: 8
                     Buffers: shared hit=1
 Planning:
   Buffers: shared hit=323
 Planning Time: 2.070 ms
 Execution Time: 2.586 ms
(26 rows)
```

Read it: a single `HashAggregate` (`Batches: 1`) over a single `Hash Right Join`, and
**`loops=1` on every node** — no nested loop, no per-chat repetition, one pass over
`project_tasks` for the whole page. 2.5 ms, 237 shared buffers, all hits.

The two sequential scans are the planner's correct choice at this size (10 project rows,
162 task rows); they are not the shape of the plan and they do not multiply with page
width. What would matter — and does not happen — is a node whose `loops` grows with the
number of chats.

## 2. Request count is O(1) in page size

Every database call in `chat-linkage.ts` goes through one counting helper, so this is a
measurement of the module, not an assertion about it:

```
$ export FORGE_LINKAGE_DEBUG=1   # harness restarted with the module's query counter on

$ curl -s ":7798/api/chat?limit=5"    → runs: 5   linked: 1
$ curl -s ":7798/api/chat?limit=30"   → runs: 7   linked: 1

harness log, complete, nothing elided:
[chat-linkage] db#1 rollup/list in=[["c0de0304-0000-4000-8000-000000000304","bfd1283a-b71b-4f35-b577-7d09aad803f2","a86cf7b3- rows=1
[chat-linkage] db#2 rollup/list in=[["c0de0304-0000-4000-8000-000000000304","bfd1283a-b71b-4f35-b577-7d09aad803f2","a86cf7b3- rows=1
```

One call for a 5-chat page, one call for a 30-chat page (7 chats exist). No N+1, and no
`resolve/thread` line anywhere — the list path never reads a thread, which is the whole
reason the scan is confined to the detail route.

`FORGE_LINKAGE_DEBUG` is off unless set: the rail polls every 8 s and a line per poll
would be noise in the pm2 log rather than observability.
