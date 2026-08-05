# The pinned linkage fixture is wrong — what `bfd1283a…` actually contains (round 304 / phase 300g)

**Verdict up front:** under the scan rule this round was told to implement, chat
`bfd1283a-b71b-4f35-b577-7d09aad803f2` resolves to **no project**, not to
`4120f785…` with `link_ambiguous: true`. The rule is implemented as specified and was
not bent to reproduce the expected answer. This file is the evidence, so a reviewer can
re-run it in thirty seconds instead of taking a builder's word.

The brief anticipated exactly this situation — *"honesty over prettiness"* — and it also
named the fixture. Both cannot hold; the data decides.

---

## 1. What the brief specified

> walk the thread in order; consider only `tool_call` entries whose content contains a
> POST to `/api/projects` with **NO further path segment** … take uuids from the
> FOLLOWING `tool_result` entry

## 2. What `bfd1283a…` really holds

The chat has 354 thread entries. Exactly **seven** `tool_call` entries pair a literal
`POST` with a bare `/api/projects`. Here is every one of them, with the `tool_result`
that follows it:

```sql
WITH t AS (
  SELECT idx, e FROM runs r, jsonb_array_elements(r.thread) WITH ORDINALITY AS x(e,idx)
  WHERE r.id='bfd1283a-b71b-4f35-b577-7d09aad803f2')
SELECT a.idx, left(b.e->>'content',80)
FROM t a JOIN t b ON b.idx=a.idx+1
WHERE a.e->>'kind'='tool_call'
  AND (a.e->>'content') ~ 'POST[^"]{0,60}/api/projects([^/a-zA-Z0-9]|$)';
```

| tool_call idx | what it is | its tool_result |
|---|---|---|
| 87 | `Write` of `/opt/ai-os/scripts/deploy-goal-mode.sh` (the *script text* contains a POST) | `File created successfully at: …` |
| 89 | two real POSTs — **deliberate validation smoke tests** | `{"error":"repo must be one of…"}`, `{"error":"mode must be \"goal\" or omitted"}` |
| 93 | `Write` of a vault note quoting the endpoint | `File created successfully at: …` |
| 97 | `cat >>` into the Operator Log, quoting the endpoint | `appended` |
| 99 | `Write` of a memory file quoting the endpoint | `File created successfully at: …` |
| 203 | `Write` of `/opt/ai-os/scripts/deploy-retier.sh` | `File created successfully at: …` |

**Not one of those results contains a project uuid.** The two projects
(`8ea0cc08…` operator-visibility, `4120f785…` engine-v2-research-lane, created 06:46:34
and 06:46:35) were created by **`deploy-retier.sh`, a detached `setsid` script** that this
chat wrote to disk and launched. The HTTP request happened in that script's own shell; its
response went to `/var/log/forge-goal-mode-deploy.log`, never into `runs.thread`. The
evidence the scan is designed to find does not exist in this chat.

## 3. Where the planner's expectation came from

Both uuids DO appear in the thread — at entry **220**, which is the `tool_result` of a
**GET**:

```
idx 219  tool_call    Bash {"command":"curl -s http://127.0.0.1:7700/api/projects | python3 -c \"…if p['status']=='active': print(p['id'], p['name'])…"}
idx 220  tool_result  4120f785-fd86-414c-9a04-f10b2cd0c365 engine-v2-research-lane
                      8ea0cc08-28d9-4301-9f28-c98e1c5d6838 operator-visibility
```

Drop the method bound and keep only the path bound, and the scan yields both uuids,
newest first → `4120f785…`, `link_ambiguous: true`. That is precisely the pinned
expectation, and it is reachable only by **linking a chat to every active project it ever
listed**.

## 4. Why the method bound stays

`GET /api/projects` returns the whole project table. Any chat that ever ran that
command — the operator runs it constantly — would be linked to whatever happened to be
active that minute, and the *newest-wins* tiebreak would silently hand it the most
recently created project in the system. That is the same class of garbage the planner
rejected one level down (`/api/projects/<uuid>/tasks`), and it fails worse: it is a
plausible-looking link that survives review.

The cost of keeping the bound is a chat with no `x/y` badge until someone links it. The
cost of dropping it is the UI confidently attributing a project to the wrong conversation.

## 5. What the scan DOES find in production

Same query, run across every operator chat, uuid-validated against `projects`:

| chat | candidates | resolver verdict |
|---|---|---|
| `11dd264b-f173-44d7-ada4-f1eb39fb4abd` | `9632f076…` live-agent-panel (created 15:42:30), `1d574922…` canvas-ux (15:43:36) — both from real `curl -X POST /api/projects` calls at thread idx 1286 and 1305 | `link_source:"thread_scan"`, **`link_ambiguous:true`**, project `1d574922…` (newest). **No backfill.** |
| every other chat | none | `project_id: null`, HTTP 200 |

So the phase's real ambiguity fixture is `11dd264b…`, not `bfd1283a…`, and it exercises
the same code path with the same verdict shape — including the rule that an ambiguous
scan writes nothing.

## 6. Recommended follow-up (not done here — out of this round's file scope)

`8ea0cc08…` and `4120f785…` are genuinely Konrad's chat `bfd1283a…`'s projects. The
honest way to link them is the **write** path, not a heuristic: a one-line manual
statement of fact,

```sql
UPDATE projects SET metadata = metadata || jsonb_build_object(
         'origin_chat_id','bfd1283a-b71b-4f35-b577-7d09aad803f2')
 WHERE id IN ('8ea0cc08-28d9-4301-9f28-c98e1c5d6838','4120f785-fd86-414c-9a04-f10b2cd0c365')
   AND NOT (metadata ? 'origin_chat_id');
```

Left unrun: this round is authorised to write only what its own scan proves, and this is
a human assertion, not a scan result. Konrad or the reviewer can run it; the resolver will
then report `link_source:"metadata"`, `link_ambiguous:true` (two projects, one chat) —
which is the truth about that morning.
