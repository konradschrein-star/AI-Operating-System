# aios-chat-list-payload — round 1: measurement harness & evidence report

Project brief: cut the chat rail's console payload — the single biggest
consumer of console bandwidth on the desktop chat surface. The transcript
work (dropping `prompt` from the steady-state delta) predates this project
and is out of scope here; see `[[chat-delta-still-ships-the-run-prompt]]`.

Harness: `scripts/checks/check-chat-rail-payload.ts`. Run it with:

```
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-rail-payload.ts
```

Both documented invocation forms pass (`ALL PASS`, exit 0), and the file
typechecks clean under `check-instrument-typecheck.sh` (universal gate item
9). `gates-808.sh --strict` on this branch: **25 executed, 2 skipped
(`--browser` not requested, by design), 0 RED**.

## What was already fixed before this round

Two commits landed on this branch ahead of this task and are **not** this
round's work — this round only builds the harness that verifies them and
writes this report:

- `26298af` — `trimRailMetadata` (`forge-control/src/db/runs.ts:109-122`),
  applied inside `listRuns()` (line 193) and covering the rail list and
  search list. Ships with its own unit tests in
  `forge-control/src/lib/chat-delta.test.ts:186-329`.
- `bc589d7` — `TEAM_POLL_MS` 6s → 10s (`pollBudget.ts`), settled-tree polling
  backoff in `ChatTeamPanel.tsx` (`isTreeSettled`), and ETag/304 conditional
  caching on `GET /api/uploads/index` (`routes/uploads.ts`,
  `lib/uploads-index.ts`).

## The "before" baseline — sourced, not re-derived

The table below's **Before** column is the operator's own real-browser,
real-session measurement, transcribed verbatim from the project brief:

    MEASURED, chat surface at rest, 60s window, production, 2026-08-24 06:05Z
    TOTAL 254,171 bytes/min

This predates both commits above (06:05Z UTC = 08:05 CEST, ~6 minutes before
`26298af` landed at 08:11 CEST) — it is genuinely the pre-fix state. This
harness cannot reproduce that measurement directly: a live `GET` against
production needs a live session and a real chat id, and the **worktree-only
policy** forbids hitting the live DB or live session from a build task. So
the harness proves the *mechanism* (trimRailMetadata, the poll intervals,
the ETag/304 path) against real production code and realistic fixtures, and
this report is explicit about which "after" numbers are live-equivalent and
which are estimates awaiting a deploy/verify task's live re-measurement.

## Before / after attribution table

| Endpoint | Before (B/min) | After active (B/min) | After settled (B/min) | Basis |
|---|---|---|---|---|
| `GET /api/proxy/chat` (rail list) | 125,288 | **~67,600 (est.)** | ~67,600 (est.) | estimate: real baseline × harness-measured reduction ratio |
| `GET /api/proxy/chat/<chat>/team` | 82,638 | 49,584 | 0 | direct: real baseline × real poll-rate change |
| `GET /api/proxy/uploads/index` | 32,125 | ~300 | ~300 | direct: 304 response is headers only, independent of index size |
| `GET /api/proxy/chat/<chat>/plan` | 7,972 | 7,972 | 7,972 | untouched this round |
| `GET /api/proxy/chat/<chat>` | 4,938 | 4,938 | 4,938 | already fixed in a prior round — left alone per brief |
| `GET /api/proxy/usage/quota` | 1,210 | 1,210 | 1,210 | untouched this round |
| **TOTAL** | **254,171** | **~131,600 (est.)** | **~82,100 (est.)** | **-48% / -68%** |

Exact numbers (to the byte) are printed by the harness on every run —
`console.log`'d attribution table in section 7 of the script's output.

### Why `/api/proxy/chat` is an estimate, not a measurement

`trimRailMetadata` is deterministic — given the same input metadata it always
produces the same output — but the *distribution* of real production rows
(how many carry `subagents_v2`, how many are simple worker chats with just
`{model, effort}`) is not something this harness can read without querying
the live `runs` table, which the worktree-only policy forbids from a build
task. Two numbers came out of the harness's synthetic 30-row mix (6 manager
rows carrying `subagents_v2`, 5 carrying `canvas_snapshot`, the rest plain):

- **Metadata-layer-only reduction: 70.3%** — isolates `trimRailMetadata`'s
  own effect from the row shell (id/title/dates/preview) it never touches.
  `chat-delta.test.ts`'s own already-committed fixture
  (`forge-control/src/lib/chat-delta.test.ts:292-328`) gets **>80%** on an
  all-heavy 30-row fixture (every row carries the full baggage) — a
  worst-case proof the function works, not a rail average. This harness's
  mixed fixture is closer to what the rail actually shows and gets less,
  because most rows' metadata was already small before pruning.
- **Full-row reduction: 46.0%** uncompressed (41.2% gzipped) — lower again,
  because `usage_running`/`usage_last_turn` are *kept* (needed for the
  context-occupancy gauge, see below) and are already most of a simple row's
  weight. Pruning's win concentrates on the few rows that carry subagent
  trees, canvas snapshots, and system prompts — not spread across the
  average row.

The **~67,600 B/min (est.)** figure in the table applies the 46.0% full-row
ratio to the real 125,288 B/min baseline. **This is the one number in this
report that needs live confirmation** — recommend the deploy/verify task
re-run the same real-browser measurement against the deployed fix and update
this table with the actual figure.

## Hard constraint: no visible change

The brief requires every field the rail renders today to keep rendering
identically, and requires proof by grep, not by reasoning from field names.
Grepped `ChatListItem` — the rail row component,
`forge-control-web/app/desktop/ChatSurface.tsx:1507-1748` — for every read of
`run.metadata`:

```
1523:  const occ = contextOccupancy(run.metadata);
1571:  <ChatContextPopover meta={run.metadata} align="left">
```

`contextOccupancy` / `readContextTokens` / `readRunModel`
(`forge-control-web/app/desktop/chat/context-window.ts:160-176`) read only
`usage_running`, `usage_last_turn`, `model`, `model_resolved`.
`ChatContextPopover` (`forge-control-web/app/desktop/chat/
ChatContextPopover.tsx:40`) reads only `usage_running`/`usage_last_turn`.
`effort` is preserved but currently unread by the rail row — kept because
`trimRailMetadata`'s contract (`runs.ts:99-108`) scopes it to "model identity
& settings", and dropping a field the popover's own doc-comment names as
load-bearing was out of scope for a payload-only round. No field the rail
row reads is outside `trimRailMetadata`'s five preserved keys
(`model`, `model_resolved`, `usage_running`, `usage_last_turn`, `effort`).
The rest of the row (`status`, `tasks_done`/`tasks_total`/`project_status`
link fields, `archived`, `updated_at`, `title`, `last_message_preview`,
`last_role`) comes from `RunSummary` fields or the `rollupChatProjects` merge
in `routes/chat.ts:118-122` — neither touched by this round.

## Uploads index — the real response shape

`GET /api/uploads/index` returns `{ runs: RunSummary[] }` where `RunSummary`
is `uploads-index.ts`'s own type (`id`, `count`, `image_count`,
`artifact_count`, `file_count`, `latest_ts` — `lib/uploads-index.ts:148-164`),
**not** the per-file upload shape (`id`/`name`/`path`/`url`/`mime`/`size`)
that `POST /api/uploads` returns. An earlier draft of this harness fixture
used the wrong shape, inflating the "before" estimate with fields the
endpoint never sends; fixed to import the real type before measuring.

304 conditional caching (`routes/uploads.ts:125-148`) makes the "after"
number independent of index size: a steady-state poll against an unchanged
index answers with headers only (~150 B) regardless of how many run
directories exist, so the >98% reduction is a property of the mechanism, not
of this harness's synthetic entry count.

## An earlier draft of this harness fabricated its "before" numbers

Worth recording for whoever picks this up next: the version of
`check-chat-rail-payload.ts` first written for this round modeled
`subagents_v2` entries with a `transcript` array field that does not exist
on the real type (`SubagentMeta`,
`forge-control-web/app/desktop/chat/subagent-slice.ts:270-282` — no
`transcript` field; a subagent's turn-by-turn log lives in *its own* run's
thread, not the manager's metadata) and gave every one of 30 mock rows a
full heavy metadata blob, producing a "before" total 2-14x heavier than
either the real operator-measured baseline or a fixture calibrated against
the codebase's own `SubagentMeta` type and `chat-delta.test.ts`'s existing
test data. Every number in this report is from the corrected fixture, run
against the real `trimRailMetadata`, `TEAM_POLL_MS`, `isTreeSettled`, and
uploads-index code paths.

## What's left

- Live re-measurement of the `/api/proxy/chat` "after" figure in a
  deploy/verify task, per the note above.
- SCOPE items 2 (team, 33%) and 3 (uploads, 13%) from the brief are already
  implemented (prior commits) and this harness proves their arithmetic; no
  further code change identified as necessary for those two this round.
