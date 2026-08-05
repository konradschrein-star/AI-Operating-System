# Additive API fields — phase 300 (NFU4)

The running list of fields phase 300 ADDS to the read-side API, so a reviewer running
`scripts/checks/api-diff.sh` can tell an intended addition from a regression. Nothing in
this phase removes or renames anything; every entry below is optional or new.

---

## Round 304 (phase 300g) — `GET /api/chat` (list) and a new sub-route

### 1. `GET /api/chat` — four OPTIONAL row fields (U3)

Added to a row in `.runs[]` **only when that chat resolves to a project** via
`projects.metadata->>'origin_chat_id'`:

| field | type | source |
|---|---|---|
| `project_id` | string (uuid) | `projects.id` |
| `project_status` | string | `projects.status` |
| `tasks_done` | number | `count(project_tasks) FILTER (status='done')` |
| `tasks_total` | number | `count(project_tasks)` |

**They are ABSENT, not zero, on every unlinked chat.** `tasks_done: 0, tasks_total: 0`
would render in the rail as a real progress badge on a chat that never started a project.
Measured on the live harness — identical key sets except for the four additions:

```
baseline row (any)          linked row (c0de0304…)      unlinked row (bfd1283a…)
archived                    archived                    archived
budget_usd                  budget_usd                  budget_usd
created_at                  created_at                  created_at
id                          id                          id
last_heartbeat_at           last_heartbeat_at           last_heartbeat_at
last_message_preview        last_message_preview        last_message_preview
last_role                   last_role                   last_role
message_count               message_count               message_count
                          + project_id
                          + project_status
spent_usd                   spent_usd                   spent_usd
status                      status                      status
                          + tasks_done
                          + tasks_total
title                       title                       title
updated_at                  updated_at                  updated_at
worker                      worker                      worker
```

Envelope (`count`, `runs`, `counts`, `hasMore`) unchanged. Pre-existing row fields keep
their values and their order — the shaping is `{...run, ...link}`, so the additions are
appended.

### 2. `GET /api/chat/:id/linkage` — NEW route (U2)

```json
{"chat_id":"…","project_id":"…|null","project_status":"…|null",
 "link_source":"metadata|thread_scan|null","link_ambiguous":true|false}
```

New path; nothing else answers it today. 400 on a malformed uuid, 200 in every other
case — including an unlinked chat and an unknown chat id ("no project" is a fact, not an
error). Round 305's `GET /api/chat/:id/team` reuses the same resolver function.

---

## How `api-diff.sh` sees round 304

Run against the worktree harness (`:7798`), 2026-08-05 16:25 CEST:

| endpoint | result | attribution |
|---|---|---|
| `agents`, `agents-project`, `agents-run` | **ok** | worktree is the green side (production still predates round 302) |
| `chat-list` | key set **ok**, VALUES **FAIL** | pinned chat `bfd1283a…` drifted: `message_count` 314 → 354, `spent_usd` 49.92 → 55.44. Konrad kept talking to it. Identical FAIL on `:7700` control |
| `chat-thread` | key set **FAIL** | `meta.blocked_by`, `meta.rule_label`, `meta.trip_id` — a guardrail feature outside this phase. Identical FAIL on `:7700` control |
| `projects` | VALUES **FAIL** | `.count` 8 → 10, the round-303d probe rows. Identical FAIL on `:7700` control |
| `projects-managers`, `secrets` | **ok** | — |

Control run (`API_BASE=http://127.0.0.1:7700`, production, without this round's code)
produces the *same three* failures plus the three `agents` ones. **Round 304 adds zero new
diff failures.**

Note on why the four new fields do not show up as a `chat-list` shape failure: the script
aligns rows by id and compares only ids present in BOTH captures, and the only chat that
currently resolves to a project (`c0de0304…`, the round-304 fixture) did not exist at
baseline. The key-set table above is the direct measurement instead.

`chat-list` also reports two DRIFT rows: `da286217…` aged out of the top-5 page, and
`c0de0304…` (the fixture) appeared. Drift is data, not code.
