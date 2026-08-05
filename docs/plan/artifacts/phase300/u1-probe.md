# U1 live probe — `origin_chat_id` at `POST /api/projects` (round 303d / phase 300f)

Requirement: `12-ui-v3-requirements.md` U1. Write path: `13-ui-v3-architecture.md` §5.
Code under test: `buildProjectMetadata()` in `forge-control/src/routes/projects.ts`,
served through the worktree harness on **:7798** (never :7700).

All timestamps below are DB time (UTC); the shell clock in the transcripts is CEST (+2).

---

## 1. Harness state — a stale server invalidated the first attempt

`:7798` was already listening when this round started (pid 1492764, booted
**16:05:46 CEST**, i.e. *before* this round's edit to `routes/projects.ts`). tsx does
not hot-reload, so that process was serving the pre-change module.

A probe was fired at it before that was checked. It therefore exercised the OLD code
and, as the old code has no `origin_chat_id` validation, **created a real project from
input that the new code rejects**:

| | |
|---|---|
| project | `4d3291c4-4eb3-483a-8d32-acc817a7b352` — "phase300-invalid-guard" |
| body | `{"repo":"scratch","name":"phase300-invalid-guard","brief":"must never be created","origin_chat_id":"not-a-uuid"}` |
| response | `HTTP 201`, `metadata: {}` (old code silently ignored the unknown field) |
| created | 14:07:51 |

This row is **unintended state created by this round** and is accounted for in §5.
The harness was then restarted so it served the code actually under test.

## 2. Invalid `origin_chat_id` → 400, nothing created (against the fresh harness)

```
$ before=$(curl -sS http://127.0.0.1:7798/api/projects | jq '.count')
$ curl -sS -w "HTTP %{http_code}" -X POST http://127.0.0.1:7798/api/projects \
    -H 'content-type: application/json' \
    -d '{"repo":"scratch","name":"phase300-invalid-guard-2","brief":"must never be created","origin_chat_id":"not-a-uuid"}'
HTTP 400  {"error":"origin_chat_id must be a uuid"}
$ after=$(curl -sS http://127.0.0.1:7798/api/projects | jq '.count')
project count before=9 after=9 (must be equal)
```

The 400 is raised by `buildProjectMetadata()` throwing `ProjectMetadataError`, caught in
the handler **before** `createProject()` — so a rejected id leaves no half-born project
and no round-0 architect task. The unchanged project count is the proof.

## 3. The sanctioned probe — create + immediate cancel, one shell command

`origin_chat_id` is set to **`01b820d1-9d46-4c6f-94da-525c5994dfd9`** — the run id of the
builder run that issued the create. That is exactly the §5 semantics ("the creating agent
passes its own run id"), and it deliberately avoids the pinned linkage fixtures
`bfd1283a…` and `a86cf7b3…`: writing a `metadata.origin_chat_id` pointing at `bfd1283a…`
would have made round 304's metadata path win over the thread scan and **falsified that
fixture's expected `link_source:"thread_scan"` + `link_ambiguous:true` verdict**.

```
=== 2. PROBE create (no-op brief) + IMMEDIATE cancel, same shell command ===
created: 46c8dd66-5338-4434-8594-2e2905946e83
{"id":"46c8dd66-5338-4434-8594-2e2905946e83","status":"active",
 "metadata":{"origin_chat_id":"01b820d1-9d46-4c6f-94da-525c5994dfd9"},
 "architectTask":"3e0b3f15-cb52-4eeb-b443-2942feb0da0a"}
--- cancelling immediately ---
{"id":"46c8dd66-5338-4434-8594-2e2905946e83","status":"cancelled",
 "metadata":{"origin_chat_id":"01b820d1-9d46-4c6f-94da-525c5994dfd9"}}
=== 3. GET /api/projects/:id — metadata echo ===
{
  "project_status": "cancelled",
  "metadata": { "origin_chat_id": "01b820d1-9d46-4c6f-94da-525c5994dfd9" },
  "origin_chat_id": "01b820d1-9d46-4c6f-94da-525c5994dfd9",
  "tasks": [ { "role": "architect", "status": "pending", "run_id": null } ]
}
```

**U1 satisfied:** `GET /api/projects/:id` echoes `metadata.origin_chat_id` through the
pre-existing `project.metadata` field. No second field was added anywhere.

Confirmed at the storage layer, not just the wire:

```
$ psql -tAc "select status, metadata::text from projects where id='46c8dd66-…'"
cancelled|{"origin_chat_id": "01b820d1-9d46-4c6f-94da-525c5994dfd9"}
```

This row is round 304's `link_source: "metadata"` fixture — before it, all 8 projects
carried NULL (plan-300.md, "Linkage ground truth"). Note for 304: the chat it points at
is a *builder* run, not an operator chat, and the project is settled — fine for
exercising the metadata branch, not a substitute for a real operator-created link.

## 4. Did an architect run spawn? — yes, in both cases

The brief's expectation was that the cancel would land inside the project tick's window.
It did not: the tick spawned an architect for both projects anyway.

| project | architect run | started | outcome |
|---|---|---|---|
| `46c8dd66…` (probe) | `3924ae7d-5adf-4146-b620-111d8fbcff49` | 14:09:40 | **cancelled** manually, 14:09:5x |
| `46c8dd66…` (probe) | `907e9577-bd69-4f06-9e3c-47b8ddbfe218` | 14:10:10 | completed 14:10:20 (~10 s) |
| `4d3291c4…` (§1 accident) | `9d218823-2093-43ec-b10f-37703495ff81` | 14:08:00 | **cancelled** manually, 14:08:1x |
| `4d3291c4…` (§1 accident) | `dd7e0013-b8a6-4ec6-9c69-e07ed04c4075` | 14:10:10 | completed 14:11:24 (~74 s) |

Two observations worth carrying forward:

- **`POST /api/projects/:id/status {"status":"cancelled"}` did not hold.** Both projects
  read `cancelled` immediately after the call, then a *second* architect run started at
  14:10:10 and each project ended at `done`. Cancelling the project does not stop a task
  whose CC run is already in flight, and the tick re-advances the project when that run
  settles. Nothing in `project-tick.ts` sets a project back to `active` from `cancelled`
  (only `blocked → active`, db/projects.ts:536, the retry path), so the exact mechanism
  is unidentified — **flagged, not fixed: those files are owned by engine-v2 this cycle.**
  Consequence for future rounds: "create then immediately cancel" is *not* a reliable
  blast shield. The no-op brief is the one that actually worked.
- **The no-op brief did its job.** The probe's architect completed in 10 s and fanned out
  zero tasks (`project_tasks` for `46c8dd66…` holds exactly the one round-0 architect row,
  status `done`).

## 5. Final state — everything settled, nothing on the board

```
== projects ==
46c8dd66-…  phase300-origin-probe   done  14:10:30
4d3291c4-…  phase300-invalid-guard  done  14:11:30
== runs ==  all four settled (2 cancelled, 2 completed), none running
== tasks == one architect row each, both done
== board (GET /api/projects/managers) ==
8ea0cc08-…  operator-visibility        active
4120f785-…  engine-v2-research-lane    active
```

Both probe projects reached a terminal status and neither appears on the Kanban board
(the manager rollup lists only `active`/`blocked`). **No DB row was deleted.**

Left behind, deliberately not removed (deleting is a destructive op and was not
instructed) — two empty scratch worktree stubs, each containing only a `.git` entry:

```
/opt/ai-os/workspace/projects/4d3291c4-4eb3-483a-8d32-acc817a7b352/.git
/opt/ai-os/workspace/projects/46c8dd66-5338-4434-8594-2e2905946e83/.git
```

Konrad: `rm -rf` on those two paths is safe whenever you want them gone.

## 6. `api-diff.sh` — three failures, none from this change

`scripts/checks/api-diff.sh` is **not green**, and it is not green on unmodified
production either. Attribution was established by running the same script against
`:7700` (the live checkout on `main`, which does not contain this round's edit):

| endpoint | :7798 (this change) | :7700 (control) | cause |
|---|---|---|---|
| `agents`, `agents-project`, `agents-run` | **ok** | FAIL (key set) | production predates round 302's committed `agents-shared` refactor — expected, and the worktree is the green side |
| `chat-list` | FAIL (values) | FAIL (values) | pinned chat `bfd1283a…` was `completed` at baseline; Konrad kept talking to it (`message_count` 314 → 354, `spent_usd` 49.92 → 55.44). Terminal-status rows are treated as frozen and get no waiver |
| `chat-thread` | FAIL (key set) | FAIL (key set) | same chat's thread gained three new `meta` keys — `blocked_by`, `rule_label`, `trip_id` — written by a guardrail feature outside this phase |
| `projects` | FAIL (values) | FAIL (values) | **`.count` 8 → 10 only** — the two rows from §1/§3. Every one of the 8 baseline rows diffs byte-equal, `metadata` included, and the key set is identical |
| `projects-managers`, `secrets` | ok | ok | — |

So: the only `projects` delta this round produced is a row *count*, and it comes from the
probe rows existing in the shared DB — visible from production too, i.e. data, not code.
The shape layer, which is what would catch a response-contract regression, is clean on
both `projects` and `projects-managers`.

**Response shape for callers that omit `origin_chat_id` is unchanged** — the handler's
`{project, architectTask}` envelope is untouched, and the metadata identity for every
pre-existing input shape is pinned by `scripts/checks/check-project-metadata.ts`
(11 cases covering `mode`/`checkin_hours`, all PASS). That is asserted at unit level
rather than by a second live create, because each live create is real state and the brief
authorises exactly one probe.

The baseline is stale for `chat-list`/`chat-thread` (real-world drift on a pinned chat
that has since been used heavily). Re-baselining is round 301's file, not this round's —
**recommendation to the reviewer: re-capture the baseline for those two endpoints, or pin
a chat that is genuinely closed.**
