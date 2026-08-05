# Round 304 (phase 300g) — verification transcript

Code under test: `forge-control/src/routes/chat-linkage.ts` (new) and the two additions in
`forge-control/src/routes/chat.ts`. Served through the worktree harness on **:7798**;
production `:7700` was never restarted and `forge-executor` was never touched.

Requirements: U2 (linkage resolution), U3 (rail rollup), NFU4 (additive API), NFU6 (no
silent fallbacks). Quality gate: `14-ui-v3-quality.md` § "Linkage honesty".

---

## 0. Typecheck — both repos clean

```
$ cd forge-control     && npx tsc --noEmit ; echo exit=$?      → exit=0
$ cd forge-control-web && npx tsc --noEmit ; echo exit=$?      → exit=0
```

`forge-control-web` was not modified this round (API-only round); it is checked because
the gate asks for both. Its production build was run for the same reason:

```
$ cd forge-control-web && npm run build ; echo exit=$?    → exit=0   (middleware 83.2 kB,
                                                            shared JS 108 kB, no warnings)
```

`git status --porcelain` after the build is unchanged — the build wrote nothing tracked.

## 1. Linkage honesty — the triple (14 § "Linkage honesty")

Harness booted on this round's code (`tsx` does not hot-reload — the stale :7798 process
from round 303d was replaced first, which is the trap that round documented).

### (a) metadata linkage — `link_source: "metadata"`

```
$ curl -sS -w " HTTP %{http_code}\n" :7798/api/chat/01b820d1-9d46-4c6f-94da-525c5994dfd9/linkage
{"chat_id":"01b820d1-9d46-4c6f-94da-525c5994dfd9",
 "project_id":"46c8dd66-5338-4434-8594-2e2905946e83","project_status":"done",
 "link_source":"metadata","link_ambiguous":false} HTTP 200
```

That is round 303d's probe project (`u1-probe.md` §3), the only row in the database that
carried `origin_chat_id` before this round. The metadata branch wins without touching the
thread. The **second** metadata case — one produced by this round's own backfill — is §2.

### (b) thread_scan + ambiguity — `11dd264b…`

```
$ curl -sS -w " HTTP %{http_code}\n" :7798/api/chat/11dd264b-f173-44d7-ada4-f1eb39fb4abd/linkage
{"chat_id":"11dd264b-f173-44d7-ada4-f1eb39fb4abd",
 "project_id":"1d574922-b407-4b1b-9351-142d7e5956ed","project_status":"paused",
 "link_source":"thread_scan","link_ambiguous":true} HTTP 200
```

Ground truth: that chat ran two real `curl -X POST /api/projects` calls, at thread entries
1286 (`live-agent-panel` → `9632f076…`, created 2026-07-30 15:42:30) and 1305
(`canvas-ux` → `1d574922…`, 15:43:36). Two distinct projects → ambiguous, newest wins,
and **nothing is written**:

```
$ psql -c "SELECT id,name,metadata FROM projects WHERE id IN ('1d574922…','9632f076…')"
 9632f076-…  live-agent-panel  {}
 1d574922-…  canvas-ux         {}
```

### (b′) the PINNED fixture `bfd1283a…` — resolves to NULL, and that is correct

```
$ curl -sS -w " HTTP %{http_code}\n" :7798/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/linkage
{"chat_id":"bfd1283a-b71b-4f35-b577-7d09aad803f2","project_id":null,"project_status":null,
 "link_source":null,"link_ambiguous":false} HTTP 200
```

The brief expected `thread_scan` + `link_ambiguous:true` + `4120f785…`. It is not
reachable under the specified rule, because the two projects were created by a **detached
`setsid` script** the chat wrote to disk — the POST never happened inside a tool call and
its response never entered the thread. Full evidence, the seven candidate entries, and
why the method bound is not being dropped to make the fixture pass:
**`linkage-fixture-finding.md`**. The rule was not special-cased in either direction.

### (c) plain chat — no project, HTTP 200

```
$ curl … :7798/api/chat/05187ada-069c-479f-9236-e8a58b0fde68/linkage
{"chat_id":"05187ada-…","project_id":null,"project_status":null,
 "link_source":null,"link_ambiguous":false} HTTP 200
```

Edge cases:

```
unknown chat id 00000000-0000-4000-8000-000000000000 → same null body, HTTP 200
malformed id     "not-a-uuid"                        → {"error":"invalid run id"} HTTP 400
```

## 2. Backfill — fires once, flips the source, never twice

Production holds no chat with a single unambiguous scan hit (see
`linkage-fixture-finding.md` §5), so the unambiguous branch is exercised against a
**synthetic fixture chat**, `c0de0304-0000-4000-8000-000000000304`, inserted for this
purpose (§6). Its thread carries one real create **plus two decoys the bounds must
reject**: a `POST /api/projects/<uuid>/tasks` whose result names `8ea0cc08…`, and a
`GET /api/projects` listing that names three more projects. If either decoy leaked in, the
scan would return ≥2 candidates and report `link_ambiguous: true` — so
`link_ambiguous:false` below is itself the proof that both bounds hold.

```
BEFORE                psql → projects 4d3291c4… metadata = {}

run #1  curl :7798/api/chat/c0de0304-…/linkage
        {"project_id":"4d3291c4-4eb3-483a-8d32-acc817a7b352","project_status":"done",
         "link_source":"thread_scan","link_ambiguous":false} HTTP 200
AFTER   psql → metadata = {"origin_chat_id": "c0de0304-0000-4000-8000-000000000304"}

run #2  curl :7798/api/chat/c0de0304-…/linkage
        {"project_id":"4d3291c4-4eb3-483a-8d32-acc817a7b352","project_status":"done",
         "link_source":"metadata","link_ambiguous":false} HTTP 200      ← flipped
AFTER   psql → metadata = {"origin_chat_id": "c0de0304-0000-4000-8000-000000000304"}   ← unchanged
```

The write is logged exactly once — the second call performs no UPDATE (`rowCount 0` from
the `AND NOT (metadata ? 'origin_chat_id')` guard, so nothing is logged and nothing is
appended):

```
harness log:   [chat-linkage] 2026-08-05T14:21:52.554Z backfill origin_chat_id
                 chat=c0de0304-0000-4000-8000-000000000304 project=4d3291c4-4eb3-483a-8d32-acc817a7b352
backfill.log:  1 line, identical
```

Projects carrying `origin_chat_id` after the whole round — two rows, one from round 303d's
write path, one from this round's backfill:

```
4d3291c4-…  phase300-invalid-guard  c0de0304-0000-4000-8000-000000000304   ← this round
46c8dd66-…  phase300-origin-probe   01b820d1-9d46-4c6f-94da-525c5994dfd9   ← round 303d
```

**ROLLBACK (do not run unless instructed):**
`UPDATE projects SET metadata = metadata - 'origin_chat_id' WHERE id = '4d3291c4-4eb3-483a-8d32-acc817a7b352';`

## 3. `/api/chat` rollup (U3)

```
$ curl -sS ":7798/api/chat?limit=10"
count 7 hasMore False
  c0de0304 completed phase300 round-304 linkage fixture   {'project_id': '4d3291c4-…', 'project_status': 'done', 'tasks_done': 1, 'tasks_total': 1}
  bfd1283a completed Okay when I click the file section…   (fields absent)
  a86cf7b3 completed let's make the AI operating system…   (fields absent)
  ece63bdb completed Execute AI OS/Specs/CRM Integration…  (fields absent)
  11dd264b completed Okay this session is very important…  (fields absent)
  da286217 completed Really quick, where are all the vid…  (fields absent)
  05187ada completed Directory                             (fields absent)
```

Note `11dd264b…`: it resolves on the detail path, but its scan is ambiguous so it was
never backfilled and therefore carries no rail badge. That is the intended price of not
guessing, and it is the visible consequence of the list path using metadata only.

**Cross-check against ground truth** — `GET /api/projects/4d3291c4…`, statuses counted by
hand:

```
project status: done
tasks: [(0, 'architect', 'done')]
status counts: {'done': 1}
=> ground truth tasks_done = 1   tasks_total = 1      (rail says 1 / 1 ✓)
```

Because that project has a single task, the aggregate arithmetic was additionally checked
against a project with 36 tasks, using the identical expression:

```
psql: id 8ea0cc08-…  status active  total 36  done 19
API   GET /api/projects/8ea0cc08-… : total 36  done 19  (all statuses: done 19, running 1, pending 16)   ✓
```

## 4. Cost — one aggregate pass, O(1) requests in page size

See **`rollup-cost.md`** for the full `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` output and the
query-count log. Summary: one `HashAggregate` over one `Hash Right Join`, `loops=1`
everywhere (no per-chat repetition), 2.5 ms; and the module's query counter shows exactly
**one** database call for `?limit=5` and **one** for `?limit=30`.

## 5. `api-diff.sh` — no new failures

Worktree (`:7798`) and production control (`:7700`) both fail on the same three
pre-existing items (`chat-list` values, `chat-thread` key set, `projects` count); the
worktree additionally *fixes* the three `agents` failures via round 302. Full attribution
table and the exact list of intentionally-added fields: **`additive-fields.md`**.

## 6. State this round created, and how to remove it

| what | why | removal |
|---|---|---|
| run `c0de0304-0000-4000-8000-000000000304` — synthetic chat, status `completed`, 9 thread entries | the only way to exercise the unambiguous scan + backfill + rail-badge path; production has no such chat | left in place **on purpose** so round 307's reviewer can re-run §2 and §3. `DELETE FROM runs WHERE id='c0de0304-0000-4000-8000-000000000304';` once the phase is reviewed — a delete, so it needs Konrad's word |
| `origin_chat_id` on project `4d3291c4…` (a settled round-303d probe project) | the backfill under test | rollback line in §2 |

It is visible in Konrad's rail as *"phase300 round-304 linkage fixture (synthetic)"* until
then. Nothing else in the database was written by this round.
