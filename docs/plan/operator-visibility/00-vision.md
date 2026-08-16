# 00 — Vision: operator-visibility

Project `operator-visibility` (`8ea0cc08-28d9-4301-9f28-c98e1c5d6838`), goal mode, branch `project/8ea0cc08` off `main`.
Repos touched: `forge-control` (Hono API, :7700) and `forge-control-web` (Next 15 + React 19, pm2 `forge-control-web`, :7701).
This corpus replaces the previous project's plan (files-pane-fast-light) that main carried in `docs/plan/` — that one is preserved in git history.

## 1. The goal, restated precisely

Konrad looks at the Live panel and the operator chat and cannot trust what he sees. Four complaints, in his words (2026-08-05 morning):

1. "Elapsed times are still growing even though they are done."
2. He "cannot tell whether these are sub-agents of Claude Fable 5 or actually whole Claude Code sessions."
3. "Hovering the sidebar still lags."
4. In operator chat: "see the conversations you have with them… something similar to the bash command, where I can see that you sent them a message and that you received a message from them."

This project makes the agent-activity surface **truthful** (durations freeze when runs settle), **legible** (every row visibly classified: full Claude Code session vs in-process sub-agent, with role, model, lineage), **fast** (hover causes no visible lag, proven with recorded before/after numbers), and **transparent** (operator↔agent messages render as first-class collapsible blocks in the transcript, mirroring the existing tool-block pattern).

## 2. Ground truth from recon (verified, not guessed)

Full detail in `02-architecture.md` §2. The load-bearing facts:

### 2.1 Growing timers — root cause is server-side, fix needs no engine changes

`forge-control/src/routes/agents.ts:537–538` computes `elapsed_ms = now − started_at` for **every** run, regardless of status; `completed_at` is never selected. The client (`AgentActivity.tsx:136–140`) correctly stops its own ticking for settled rows, then renders the poisoned server value. Measured live: a 130-second completed run displayed as "5h 05m", growing 4s per poll for 24h.

The truth already exists in the row, unused:

- `runs.completed_at` (migration 0021) is stamped by every complete/fail path — 239/239 settled rows populated. The cancel path never stamps it (4 legacy rows), but stamps `updated_at`. So **`COALESCE(completed_at, updated_at) − started_at`** is the reliable settled duration.
- In-process sub-agents (`metadata.subagents_v2[]` elements) already persist a per-sub-agent `ended_at` (written on tool_result by `run-rollup.ts:228`) which the API layer **drops on the wire** (`subagentsFromRollup`, agents.ts:503–533). Sub-agent `updated_at` can keep advancing *after* `ended_at` (events arriving under a stale `parent_tool_use_id`), so `ended_at` is the only safe settle proxy; the current client fallback (`updated_at`, else `now`) both overstates and, when `updated_at` is absent, grows forever.

**No executor/engine change is needed for time truth.** This matters: engine files are owned by the parallel project engine-v2-research-lane and are hard off-limits.

### 2.2 Illegible kinds — the data exists, the API throws it away

- `metadata.role` (architect/planner/builder/reviewer today; scout/researcher newly legal) and `metadata.project_id` are used in agents.ts WHERE clauses but **never projected** into the response.
- Kind signals present in every row: operator chats (`worker='forge-executor'`, no project_id/role/cron_id), project workers (`worker='project:<role>'` + project metadata), child runs (`parent_run_id IS NOT NULL`), cron/watchdog runs (`metadata.cron_id`/`cron_name`/`source='cron'`, 143 rows).
- Sub-agent elements carry `role`, `model`, and a human `description` ("Recon chat Bash block rendering") — description also dropped by the API.
- `metadata.model` holds unresolved aliases (`haiku`, `opus`) on 108 older rows; `metadata.model_resolved` holds the concrete id when present. The UI renders `a.model ?? "run"`.

### 2.3 Hover lag — suspects identified, cause to be proven by profiling

The Live panel has **no** JS hover handlers (native `title` only). React-state hover lives in `ChatSurface.tsx`: `ChatListItem` chat-rail rows (`useState` hover, :961–966) and inline style-mutation handlers in the side-panel tasks list (:186–191) — all inside the ~1000-line `ChatSurface` tree that re-renders under three polling queries (agents 4s, managers 8s, chat 3s/20s + 1s SSE snapshots). Phase 3 profiles first (protocol: `03-quality.md` §4), fixes the measured cause, records numbers. Production :7701 stays untouched until deploy and remains a valid reference throughout.

### 2.4 Agent comms — render what the thread already records; document what it doesn't

`runs.thread` (jsonb) already contains, for operator runs: `tool_call` entries with `meta.tool = "Agent"` (63 all-time) and `"SendMessage"` (3), full input JSON (truncated server-side at 1,500 chars), and their `tool_result` entries. All flow through the existing render pipeline today and land in the generic `ToolCallRow` fallback — the same collapsible block Bash uses. The work is a **renderer**: register per-tool components via assistant-ui's `tools.by_name` slot (verified available in the installed 0.14.24) and thread two dropped fields (`parent_tool_use_id`, result `is_error`) through `thread-mapping.ts`.

**Verified gap:** task-completion notifications (the payload that comes back when a background agent finishes) **never reach the thread**. `cc-runner.ts:417–429` forwards only `tool_result` blocks from user events; the `CcEvent` union is closed (`init | assistant_text | tool_call | tool_result`). `cc-runner.ts` is an off-limits engine file. Per the brief's escape hatch, phase 4 renders what exists and **documents this gap precisely** (deliverable `docs/plan/notification-gap.md`) for the engine-v2 lane. No new plumbing.

## 3. Definition of done (verbatim contract)

1. **TIME TRUTH** — a settled run (completed/failed/cancelled) shows a FROZEN duration (settle time − started_at). Only live runs tick. No exceptions anywhere in the panel: top-level rows, RECENT section, sub-agent lines.
2. **KIND TRUTH** — every row visibly classified: full Claude Code session runs (project workers with role architect/planner/builder/reviewer/scout/researcher, and operator chats) vs in-process sub-agents, with model, and parent/lineage on hover. A stranger can read the org chart of a running project from the panel.
3. **HOVER PERFORMANCE** — hovering rows causes no visible lag. Profile first, fix the measured cause, record before/after numbers the reviewer can reproduce.
4. **AGENT COMMS IN CHAT** — operator→agent sends and agent→operator results render as first-class collapsible blocks (direction marker + agent name + one-line preview → full payload), visually consistent with Bash tool blocks. Payloads genuinely absent from the thread are documented, not plumbed.
5. **CLEAN BUILDS** — `npx tsc --noEmit` clean in both repos; `pnpm build` passes in forge-control-web.

## 4. Measurable success criteria

- **S1** `curl /api/agents` twice ≥5s apart → every settled run's `elapsed_ms` byte-identical across calls; every settled sub-agent carries a non-null `ended_at` on the wire (or the documented fallback) and the client derives a constant duration from it.
- **S2** The 4 legacy cancelled rows (no `completed_at`) render finite, frozen durations via the `updated_at` fallback — verified by pointing the panel at the live DB.
- **S3** Panel screenshots (dark + light) of a running goal-mode project show: operator chat rows, project-worker rows labeled role + model, sub-agent lines nested with model + description; hover reveals lineage. A reviewer unfamiliar with the codebase can name each row's kind.
- **S4** Recorded before/after measurement for the hover interaction per the protocol in `03-quality.md` §4, "after" meeting the numeric gate, reviewer reproduces within tolerance.
- **S5** In an operator chat that spawned agents (real historical run), the transcript shows direction-marked collapsible agent-comm blocks; expanding shows the full recorded payload; both themes correct; `grep` finds no hardcoded colors in touched files.
- **S6** Deploy verified: `pm2` online, `:7700/api/health` ok, `:7701` serves, summary includes the hover numbers.

## 5. Non-goals (explicit)

- **No engine changes.** `project-tick.ts`, `cc-runner.ts`, `executor.ts`, `db/projects.ts` untouched — even the missing `completed_at` on the cancel path and the dropped task notifications. Read around; document; hand off.
- **No new persistence, migrations, or rollup writers.** Time and kind truth are projection + rendering over existing data.
- **No websockets/SSE work.** Polling cadence changes only if profiling proves polling is the hover-lag cause, and then minimally.
- **No Files components** (`FileExplorerPanel*`, `VaultFileList*`, `routes/files.ts`).
- **No visual redesign** of the Live panel's monospace idiom; extend it.
- **No data backfill** (alias models on old rows get display normalization only).
- **No forge-executor restart, ever, within this project.**

## 6. Operability answers (policy for every design here)

- **What owns state?** Postgres `runs` (+ `metadata` rollup written by the executor, untouched). The web UI owns only ephemeral view state (collapse/expand, hover). No new state owners.
- **What dispatches work?** The project engine, via the phase tasks seeded per `04-phases.md`. At runtime, react-query polling — unchanged.
- **What happens on failure?** API errors keep rendering as visible red text. A thread entry the new renderers can't parse renders as an explicit raw block ("unparsed payload" + raw text), never dropped. A run whose kind can't be classified shows an explicit `unknown` badge, never a guessed one. Silent fallbacks are policy violations — any found during build must be surfaced in review.
- **How does Konrad see it broke?** The panel is itself the observability surface: wrong now renders as *visibly* wrong (frozen "—", `unknown` badge, raw block) instead of plausibly wrong (a ticking timer). Reviewer gates in `03-quality.md` require curl output, screenshots in both themes, and reproduced perf numbers before PASS.
