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

---

## Round 308 — the list became executable

Review finding 5: *"The four additive chat-list fields are never exercised by the additive
gate."* They are now, and so is every other addition of this phase. `api-diff.sh`'s
`additive_for()` holds the same list as a data table, and `--control` mode asserts it
rather than tolerating it:

| assertion | failure mode it catches |
|---|---|
| every listed path is PRESENT in the `:7798` capture | the fixture stopped reaching the field — the gate was proving nothing |
| every listed path is ABSENT from the `:7700` control | it was never an addition of this phase |
| no OTHER key is added | an unannounced API change |
| no key is removed, anywhere | a client-breaking change |

Keep this file and `additive_for()` in step. This file is the prose and the reasoning;
that function is the copy the gate executes.

### The complete list, as declared

| endpoint | added paths | phase / requirement |
|---|---|---|
| `/api/agents`, `/api/agents?project_id=` | `agents[].agent_kind`, `.cron_name`, `.project_id`, `.role`, `.settled`, `.settled_at`, `agents[].subagents[].description`, `.ended_at` | phases 1–2 — KIND TRUTH (DoD 2) and the settle stamps TIME TRUTH (DoD 1) is computed from |
| `/api/agents/:id` | the same eight, in the single-run shape (`agent.*`) | as above |
| `/api/chat` (list) | `runs[].project_id`, `.project_status`, `.tasks_done`, `.tasks_total` | U3, round 304 — only on a chat that resolves to a project |
| `/api/secrets` | `secrets[].requestedByRunId` | U7, round 303 |

Nothing is removed or renamed anywhere in this phase, which is why "any removal fails"
is an unconditional rule rather than a list.

### One declared VALUE change

`elapsed_ms` is not an addition — it exists on main, and this phase changes what it
says. That is the deliverable, not a regression: main recomputes it against `now` for
every row, so the pinned settled architect run `3853c154` (completed 07:02Z) read
**31 977 125 ms** on `:7700` and **949 322 ms** — its real 15m 49s span — on `:7798`
in the same capture. Konrad's report was *"elapsed times are still growing even though
they are done."*

It is declared in `changed_for()`, which waives worktree-only value differences on
declared paths. In practice the waiver rarely fires for this one: main's value drifts
against any baseline too (it is a function of `now`), so the gate attributes it as
ordinary drift. The declaration is there for the case where main is stable and the
difference is genuinely worktree-only.

### Round 308's own additions

None to any endpoint. `/api/chat/:id/team` gains no field; `working_ms` on a sub-agent
node changes VALUE from `0` to `null` when the rollup has no independent end stamp
(review finding 1) — a new value in an existing nullable field, on a route that does
not exist on main at all, so no baseline compares it. `docs/plan/artifacts/phase300/verification-308.md`
records the before/after directly against the endpoint.
