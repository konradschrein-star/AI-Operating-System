# prod-curls-904.md — U34 step 1: production endpoint verification

PHASE 900, round 904. Every request below was issued against the LIVE API on
`127.0.0.1:7700` (pm2 `forge-control`, serving /opt/forge-ai-os at main `26ea125`).
Not :7798, not :7832, not a worktree harness. Captured 2026-08-16T22:00:37Z.

Bodies are pretty-printed and truncated by LINE where long — never by field, so the
shape each check claims is visible rather than asserted.

---

## GET /api/health

```
$ curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' http://127.0.0.1:7700/api/health
{"ok":true,"service":"forge-control","version":"0.1.0","uptime_seconds":1466,"timestamp":"2026-08-16T22:00:37.599Z"}
HTTP 200 in 0.001667s
```

---

## GET /api/capabilities

```
$ curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' http://127.0.0.1:7700/api/capabilities
{"control_plane":{"message_into_session":false,"resume_finished":false,"stop":false,"terminate":false}}
HTTP 200 in 0.002186s
```

---

## GET /api/chat — the grouped list rollup (U3)

```
$ curl -s http://127.0.0.1:7700/api/chat | python3 -m json.tool

HTTP 200 in 0.126374s
{
    "count": 6,
    "runs": [
        {
            "id": "bfd1283a-b71b-4f35-b577-7d09aad803f2",
            "title": "Okay when I click the file section, things still lag and they still don't work in light mode. The ov",
            "status": "completed",
            "worker": "forge-executor",
            "budget_usd": "0.00",
            "spent_usd": "126.00",
            "created_at": "2026-08-04 22:40:19.793779+00",
            "updated_at": "2026-08-16 21:38:28.401952+00",
            "last_heartbeat_at": "2026-08-16 21:38:28.401952+00",
            "message_count": 667,
            "last_message_preview": "**It's deployed. Hard-refresh your browser.** I verified it myself rather than taking the report's word: main is at the new commit, the web app rebuilt at 23:35",
            "last_role": "assistant",
            "archived": false,
            "project_id": "8ea0cc08-28d9-4301-9f28-c98e1c5d6838",
            "project_status": "active",
            "tasks_done": 79,
            "tasks_total": 90
        },
        {
            "id": "a86cf7b3-9283-4315-a389-ab60bd2ea4df",
            "title": "let's make the AI operating system into a more capable development and ideating environment.",
            "status": "completed",
            "worker": "forge-executor",
            "budget_usd": "0.00",
            "spent_usd": "50.08",
            "created_at": "2026-08-04 19:04:35.501192+00",
            "updated_at": "2026-08-05 07:38:56.342356+00",
            "last_heartbeat_at": "2026-08-05 07:38:56.342356+00",
  ... (6 runs total; each carries project_id / project_status / tasks_done / tasks_total)
```

**Verdict:** grouped rollup, not a raw run dump. `count: 6`, and every row carries the
x/y pair the rail badge renders — `tasks_done`/`tasks_total` (this project: 79/90).
Confirmed present on all six rows:

```
  bfd1283a   79/90  tasks  project_status=active  msgs=667
  a86cf7b3  None/None tasks  project_status=None  msgs=1991
  ece63bdb  None/None tasks  project_status=None  msgs=1911
  11dd264b  None/None tasks  project_status=None  msgs=2477
  da286217  None/None tasks  project_status=None  msgs=183
  05187ada  None/None tasks  project_status=None  msgs=77
```

---

## GET /api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/team — U4

```
$ curl -s http://127.0.0.1:7700/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/team | python3 -m json.tool

HTTP 200 in 0.284121s
{
    "chat_id": "bfd1283a-b71b-4f35-b577-7d09aad803f2",
    "now": "2026-08-16T22:00:37.811Z",
    "project": {
        "id": "8ea0cc08-28d9-4301-9f28-c98e1c5d6838",
        "status": "active"
    },
    "link_source": "metadata",
    "link_ambiguous": false,
    "manager": {
        "id": "bfd1283a-b71b-4f35-b577-7d09aad803f2",
        "kind": "operator",
        "role": null,
        "model": "claude-opus-5",
        "status": "completed",
        "tokens": {
            "input": 3,
            "output": 4,
            "cache_read": 1444865,
            "cache_creation": 10751,
            "total": 1455623
        },
        "working_ms": 5459715,
        "working_ms_source": "thread",
        "started_at": "2026-08-04 22:40:19.839346+00",
        "settled": true,
        "description": "Okay when I click the file section, things still lag and they still don't work in light mode. The ov",
        "parent_id": null,
        "subagents": [],
        "task": null
    },
    "workers": [
        {
            "id": "3853c154-e07b-4378-9313-2b34f4a33342",
            "kind": "worker",
            "role": "architect",
            "model": "claude-fable-5",
            "status": "completed",
            "tokens": {
                "input": 14,
                "output": 30,
                "cache_read": 821249,
                "cache_creation": 45133,
                "total": 866426
            },
            "working_ms": 949813,
  ... (87 workers, 6 sub-agents; 94 rows total)
```

**Verdict:** `working_ms` present on **94/94** rows (0 missing). 93 of 94 are settled and
carry a frozen value; the 1 running row ticks. Proof it is frozen rather than merely
present — the same endpoint sampled 45 s apart:

```
rows compared          : 94
settled rows           : 93
settled rows that MOVED: 0   <- must be 0
running row 4599b621   : 49570 ms -> 106168 ms   <- must move (anti-vacuous guard)
```

0 settled rows moved; the live row advanced 49 570 ms -> 106 168 ms. The panel is not
frozen because nothing updates — it is frozen exactly where it should be.

---

## GET /api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/plan — U6 (the corpus-relocation regression check)

Round 901 moved the corpus to `docs/plan/operator-visibility/`. If the plan endpoint
resolved a hardcoded old path, this is where phase 900 would break. It does not 404.

```
$ curl -s http://127.0.0.1:7700/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/plan

HTTP 200 in 0.023375s
{
  "chat_id": "bfd1283a-b71b-4f35-b577-7d09aad803f2",
  "project": {
    "id": "8ea0cc08-28d9-4301-9f28-c98e1c5d6838",
    "status": "active"
  },
  "link_source": "metadata",
  "link_ambiguous": false,
  "docs": [
    "00-vision.md",
    "01-requirements.md",
    "02-architecture.md",
    "03-quality.md",
    "04-phases.md",
    "05-control-plane-boundary.md",
    "06-control-plane-requirements.md",
    "07-control-plane-architecture.md",
    "08-control-plane-quality.md",
    "09-control-plane-phases.md",
    "10-policy-agent-autonomy-and-escalation.md"
  ]
}
phases: 16
  round_base=0    tasks=1   Plan: operator-visibility
  round_base=100  tasks=5   Plan phase 1: time truth (frozen settled durations)
  round_base=200  tasks=6   Plan phase 2: kind truth (row classification, model, lineage
  round_base=300  tasks=13  Plan phase 300: read-side API (linkage, team, plan, capabili
  ...
doc refs on phases: (none carried in this payload)
```

**Verdict: NO REGRESSION.** HTTP 200, 16 phases, 90 tasks — this project's real plan.
The endpoint resolves the plan from the `tasks` table by project id, not from a corpus
path, so the round-901 move could not have broken it and demonstrably did not. The
separate `/plan/doc?name=` route is the one that touches the corpus directory; it is
checked below.

---

## GET /api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/plan/doc — the route that DOES read the corpus

```
$ curl -s '.../plan/doc?name=14-ui-v3-quality.md'
HTTP 404  bytes=83
{"error":"no such plan document: 14-ui-v3-quality.md","name":"14-ui-v3-quality.md"}

$ curl -s '.../plan/doc?name=10-ui-v3-spec.md'
HTTP 404  bytes=77
{"error":"no such plan document: 10-ui-v3-spec.md","name":"10-ui-v3-spec.md"}

$ curl -s '.../plan/doc?name=../../../../etc/passwd'   # traversal guard
HTTP 400
{"error":"rejected: name must be a bare file name, got a path: ../../../../etc/passwd","name":"../../../../etc/passwd"}
```

### VERDICT ON /plan/doc — **REAL REGRESSION, introduced by phase 900 (round 901)**

This is the failure the brief predicted, and it is worse than a 404.

`planDirFor()` (chat.ts:810) resolves exactly one FLAT directory —
`<workspace_dir>/docs/plan` — and `resolvePlanDoc()` (chat.ts:965 layer 1) rejects any
`name` containing `/`. Round 901 moved the operator-visibility corpus down one level into
`docs/plan/operator-visibility/`. Two consequences, both live right now:

1. **Our corpus is unreachable.** `14-ui-v3-quality.md`, `10-ui-v3-spec.md`, and every
   other `1x-ui-v3-*.md` return 404. There is no name that reaches them: the file is a
   directory deeper and the path separator is refused by the traversal guard.
2. **Another project's documents are served under this project's plan.** What remains at
   `docs/plan/*.md` is the *engine-v2-research-lane* corpus, and `GET /plan` advertises it:

```
docs advertised by THIS project's plan endpoint:
    00-vision.md
    01-requirements.md
    02-architecture.md
    03-quality.md
    04-phases.md
    05-control-plane-boundary.md
    06-control-plane-requirements.md
    07-control-plane-architecture.md
    08-control-plane-quality.md
    09-control-plane-phases.md
    10-policy-agent-autonomy-and-escalation.md

phases carrying a doc ref: 0

$ curl -s '.../plan/doc?name=00-vision.md' | head -1
# 00 — Vision: engine-v2-research-lane
   ^ the OTHER project's vision document, served under the operator-visibility chat
```

The traversal guard itself is intact (400, and it names the rejection), so this is a
resolution-scope bug, not a security hole. It needs a briefed fix round against
`routes/chat.ts`; round 904 is a read-only verification task and did not touch it.
Reported to the manager chat at the moment of discovery.

---

## GET /api/agents — the endpoint phases 1-2 shipped

```
$ curl -s http://127.0.0.1:7700/api/agents | python3 -m json.tool

HTTP 200 in 0.017133s
{
  "now": "2026-08-16T22:02:25.551Z",
  "summary": {
    "running": 2,
    "queued": 0,
    "stuck": 0,
    "paused": 0,
    "active_subagents": 0,
    "spent_usd_last_hour": 141.72,
    "tokens_in_last_hour": 0,
    "tokens_out_last_hour": 0
  }
}
agents: 32
   {"id": "4599b621-15ef-4f93-ae40-6ede65bf1bb6", "kind": "run", "role": "builder", "model": "claude-opus-5", "status": "running", "settled": false, "ela
   {"id": "bfd1283a-b71b-4f35-b577-7d09aad803f2", "kind": "run", "role": null, "model": "claude-opus-5", "status": "running", "settled": false, "elapsed_
   {"id": "fadf2fbc-40b4-467b-8a23-bb0e5a06efbb", "kind": "run", "role": "builder", "model": "claude-opus-5", "status": "completed", "settled": true, "el
   {"id": "224054a7-98d7-48d4-b474-197f14cdc48e", "kind": "run", "role": "builder", "model": "claude-sonnet-5", "status": "completed", "settled": true, "
   {"id": "e8e0fc4a-3ff7-4c09-b206-7d139406bb08", "kind": "run", "role": "builder", "model": "claude-opus-5", "status": "completed", "settled": true, "el
```

**Verdict:** intact and frozen. Same 45 s two-sample test as `/team`:

```
rows compared           : 32
settled rows that MOVED : 0   <- must be 0
running row 4599b621    : 48625 ms -> 105200 ms
```

Every settled row carries a `settled_at` and a frozen `elapsed_ms`; the one running row
ticks. No field was removed or renamed relative to the shape phases 1-2 shipped.
