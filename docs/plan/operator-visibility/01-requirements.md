# 01 — Requirements

Every requirement is numbered and testable. **Verify** is the exact check a reviewer runs. **Phase** maps each requirement to exactly one phase (`04-phases.md`). File references are to the worktree.

> **Citation rule — standing, added 2026-08-17 by the operator after the third consecutive round found rotted line pins.**
> A bare `file.ts:170–188` pin is a **claim with an expiry date**. This corpus has now produced three of them that silently came to point at unrelated code: R15's `01-requirements.md:75`, R19's `cc-runner.ts:170–188` (today: `buildSystemPrompt` text) and `:417–429` (today: the idle-timeout kill). A reader who trusts a rotted pin is not reading stale information — they are reading *different* information that looks authoritative.
> Therefore, when you cite code:
> 1. **Anchor to something stable** — a symbol name, a requirement id, a `grep`-able string. `the CcEvent union in cc-runner.ts` survives every edit above it; `cc-runner.ts:234` does not.
> 2. **If a line number genuinely helps, pin it to a recorded SHA** and write the SHA next to it. A pin without a SHA is unfalsifiable.
> 3. **A pin you cannot resolve is a finding, not a footnote.** Say so in your report; do not quietly re-derive what the author probably meant.
> 4. **Retire a requirement and its gate clause together, in one commit, explicitly.** A requirement whose subject no longer exists must not leave an orphaned gate behind for a later round to fail against.

## A. Time truth (Phase 1)

**R1 — Server-side settled duration.**
`GET /api/agents` computes `elapsed_ms` per run as:
- status ∈ {completed, failed, cancelled}: `COALESCE(completed_at, updated_at) − started_at` (server-side, from columns selected in the same query);
- otherwise: `now − started_at` as today.
`completed_at` must be added to the SELECT in `fetchActiveRows` (routes/agents.ts:420–449) and to the `/api/agents/:id` SELECT (agents.ts:661–669). No engine files touched.
*Verify:* `curl -s :7700/api/agents | jq '[.agents[] | select(.status=="completed" or .status=="failed" or .status=="cancelled") | {id, elapsed_ms}]'` twice, ≥5s apart → identical output. A row with NULL `started_at` yields `elapsed_ms: null`, not a crash.

**R2 — Settled flag + settle timestamp on the wire.**
`AgentRun` gains `settled: boolean` (status ∈ completed/failed/cancelled) and `settled_at: string | null` (`completed_at ?? updated_at` for settled rows, null otherwise). Additive only — no existing field renamed or removed (the mobile PWA consumes this endpoint too).
*Verify:* `curl … | jq '.agents[0] | keys'` shows old fields intact plus new ones; settled rows have non-null `settled_at`.

**R3 — Sub-agent `ended_at` + `description` projected.**
`subagentsFromRollup` (agents.ts:503–533) and the `Subagent` wire interface pass through `ended_at` (string | null) and `description` (string | null) from `metadata.subagents_v2[]`. These are persisted today and dropped.
*Verify:* `curl … | jq '.agents[] | .subagents[]? | {role, status, ended_at, description}'` — every `status:"done"` element has non-null `ended_at` (for runs recorded since rollup v2; older nulls fall to R5's fallback).

**R4 — Client: settled top-level rows never tick.**
`AgentRunLine` renders duration for settled rows strictly from server `elapsed_ms` (now correct per R1) and passes `now` only to live rows. Queued rows (not yet started) show `—`, not a growing count.
*Verify:* React DevTools / code review plus: open panel with a settled run visible; duration text unchanged across ≥3 poll cycles (screenshot pair or DOM poll via Playwright).

**R5 — Client: settled sub-agent lines never tick.**
`SubagentLine` duration: `status === "running"` → `now − started_at`; else `ended_at − started_at`; if `ended_at` is null (old rows) → `updated_at − started_at`; if that is also unusable → render `—`. **Never `now` for a done sub-agent** (kills the current grow-forever fallback at AgentActivity.tsx:258).
*Verify:* Playwright DOM poll over a done sub-agent line across ≥3 poll cycles → text constant; a fabricated entry with null `ended_at`+`updated_at` renders `—` (unit test on the extracted duration function).

**R6 — One duration function.**
Exactly one exported helper (e.g. `runElapsedMs(row, now)` / `subagentElapsedMs(s, now)`) in the Live panel module owns the settled-vs-live decision; both row components call it; no other call site computes durations. This is the "no exceptions anywhere" clause made structural.
*Verify:* `grep -n "now -\|- started\|parseTs" forge-control-web/app/desktop/live/*.tsx` — all duration arithmetic lives in the helper module; components contain none.

## B. Kind truth (Phase 2)

**R7 — Server-side kind classification.**
`AgentRun` gains `agent_kind: "operator" | "worker" | "cron" | "unknown"` plus `role: string | null` (`metadata.role`), `project_id: string | null`, `cron_name: string | null`. Classification precedence (explicit, ordered, documented in code):
1. `metadata.cron_id` present → `cron`;
2. `metadata.project_id` AND `metadata.role` present → `worker`;
3. `worker = 'forge-executor'` with none of the above → `operator`;
4. anything else → `unknown` (rendered as such — never guessed).
`parent_run_id` (already on the wire) marks child runs orthogonally.
*Verify:* `curl … | jq '[.agents[] | {id, agent_kind, role, project_id}]'` — every row classified; cross-check 3 known rows (an operator chat, a project worker, a cron run) against the DB.

**R8 — Model normalization for display.**
The wire keeps raw `model` (resolved-preferred, as today, agents.ts:549–561). The client renders a display name via a small pure mapping (`claude-fable-5` → `fable-5`, `claude-opus-5` → `opus-5`, alias `haiku`/`opus` → shown as-is but faint); unknown ids pass through verbatim. No hardcoded colors; mapping unit-tested.
*Verify:* unit test table; screenshot shows old alias rows legible, current rows showing concrete model.

**R9 — Visible kind classification in the panel.**
Every top-level row shows: kind marker (operator chat vs project worker vs cron — distinct token-colored badge or glyph, both themes), role label for workers (architect/planner/builder/reviewer/scout/researcher), and model. Sub-agent lines (nested, existing indent idiom) show role, model, and now `description` as the title text where present. A stranger reading the panel can answer "session or sub-agent?" for every line.
*Verify:* dark+light screenshots of a live goal project; reviewer names each row's kind without reading code (S3).

**R10 — Lineage on hover, perf-safe.**
Hovering a row reveals lineage: for sub-agents, "sub-agent of <parent run title> (<model>)"; for child runs, parent run id/title; for workers, "project <name> · <role> · round context if present". Implementation must be CSS-only visibility (pre-rendered content, `:hover` class or enriched native `title` — decision in 02-architecture §5.3), **no state updates, no portal/tooltip library, no new dependency**.
*Verify:* code review (no onMouseEnter state in the Live panel); hover during the phase-3 measurement adds no long tasks; both themes screenshot with tooltip visible (CSS route) or title attribute content dumped (native route).

**R11 — Managers/summary rows keep counting only live work.**
`ManagersSection` and the summary strip must not regress: counts and spend remain as today; any duration ManagersSection might show follows R6's helper. (Today it shows none — this requirement pins that no ticking duration gets *added* here.)
*Verify:* code review + screenshots.

## C. Hover performance (Phase 3)

**R12 — Recorded baseline before any perf fix.**
Baseline measurement of the hover interaction on the worktree build (pre-phase-3-changes), per protocol `03-quality.md` §4, committed as `docs/plan/perf/baseline.md` + raw trace files. Baseline is taken at phase start so it isolates the phase-3 fix (phases 1–2 touch the Live panel, not the chat rail).
*Verify:* files exist, numbers filled in, trace loadable in Chrome DevTools (`chrome://tracing` / Performance tab import).

**R13 — Root cause identified from measurement, not intuition.**
The phase's fix PR/commit message and `docs/plan/perf/findings.md` name the mechanism (e.g. unmemoized rail re-render per mouse event, poll-driven commit storm, style recalculation) **with the trace evidence** (which function/component, how many ms, how many commits). Candidate list in 02-architecture §5.2 is a starting point, not a conclusion.
*Verify:* reviewer reads findings against the raw trace and confirms the named cause appears in it.

**R14 — Fix meets the numeric gate.**
After the fix, the scripted hover sweep (03-quality §4) shows: zero main-thread tasks > 50ms attributable to hover handling, and total scripting time during the sweep reduced vs baseline (target ≥ 50% if baseline shows a storm; if baseline is already < 60ms total, the gate is "no regression + cause documented elsewhere"). Numbers recorded in `docs/plan/perf/after.md`.
> **The "≥ 50%" scripting-ms target above is clause (b) of the numeric gate, and clause (b) was RETIRED 2026-08-17 by operator decision (Konrad), round 1300.** The binding text is `03-quality.md` §4 — clause (a) stands, and clauses (b1) invalidation records / (b2) attributable long tasks against a stated idle floor replace it. This line is kept as written for history; read §4 before evaluating R14.
*Verify:* reviewer re-runs the sweep script and reproduces within ±20%.

**R15 — No behavior regressions from the perf fix.**
Chat rail still: selects on click, shows ✕ close affordance on hover, marks selected row, updates status dots live. Side-panel task list still opens runs.
*Verify:* Playwright click-through + screenshots both themes.

## D. Agent comms in chat (Phase 4)

**R16 — `thread-mapping.ts` carries the dropped fields.**
`ToolCallPart` gains `parentToolUseId?: string` and result `isError` is preserved onto the part (today only set via back-search; keep) — mapping continues to dispatch on `role`/`kind` only. No pipeline changes server-side.
*Verify:* unit test: a thread fixture with subagent-attributed entries maps parts with `parentToolUseId` set.

**R17 — First-class Agent/SendMessage blocks.**
Register `tools.by_name` renderers (AssistantThread.tsx:127) for `Agent` and `SendMessage` (both directions of the operator↔agent conversation that exist in the thread):
- **Agent spawn** (`tool_call`, meta.tool="Agent"): direction marker "→" + parsed `subagent_type`/`description` as the one-line preview; expanded: full `prompt` payload, mono block.
- **Launch ack** (`tool_result` on that call): rendered inside the same block as today's RESULT section (status line: launched/failed).
- **SendMessage** (`tool_call`): "→ <to>" + `summary` preview; expanded: full message; its `tool_result` = the reply, direction-marked "←".
Visual grammar identical to `ToolCallRow` (same tokens: `toolBg`, `borderDivider`, status color coding, `dot()`, mono class, collapsed-by-default, 110-char preview). Input JSON that fails to parse renders the raw `argsText` with an explicit "unparsed payload" label — visible, never dropped (R20).
*Verify:* open historical run `3853c154-…` (this architect run — it contains 2 Agent spawns) in the chat surface; blocks render with direction + agent name + preview; expand shows full prompt; both themes screenshots.

**R18 — Sub-agent attribution in the transcript.**
Parts carrying `parentToolUseId` render with a visible sub-agent marker (indent/left rail + the spawning agent's `description` or short id association) so a sub-agent's tool calls are no longer indistinguishable from the operator's own. Association map is built in `mapThreadToMessages` from Agent spawn calls seen earlier in the same thread (tool_use_id → description) — pure function, unit-tested.
*Verify:* fixture test + screenshot of run `3853c154-…` where sub-agent Bash calls show the marker.

**R19 — Notification gap documented, not plumbed.**
`docs/plan/notification-gap.md`: exactly what is missing (the harness's **async task-completion notification** — narrowed round 1350, see below), where it dies (`cc-runner.ts:502–514`, closed `CcEvent` union at :234–235), what a fix would take (new event type + `ThreadEntry.kind` + mapping branch), and why it is out of scope here (engine files owned by engine-v2-research-lane). No code change for this item. **Status: OPEN.**
*Pins drifted:* the original `:417–429` / `:170–188` were written against an older `cc-runner.ts` and now point at the idle-timeout kill logic and `buildSystemPrompt` respectively; corrected above against `b02aa62`.
*Claim narrowed (round 1350):* "agent completion payloads never reach `runs.thread`" was over-broad and is **false** for synchronous sub-agent results, for async sub-agents' own inline entries (`meta.parent_tool_use_id`), and for peer traffic via `POST /api/runs/:id/message` (`kind: "comms"`). Only the async completion notification is genuinely uncovered.
*Verify:* doc exists, claims match the quoted code, and no diff touches `cc-runner.ts`.

**R20 — No silent drops in the transcript.**
Every thread entry that reaches the mapper produces a visible part: unknown kinds degrade to the existing text/generic-tool rendering, malformed tool payloads render raw with an explicit label. Grep-level check that the new renderers contain no bare `return null` on data they merely fail to parse.
*Verify:* code review + a deliberately malformed fixture renders visibly.

## E. Cross-cutting / deploy (Phase 5; NF apply to all phases)

**R21 — Builds green.**
`npx tsc --noEmit` clean in `forge-control` and `forge-control-web`; `pnpm build` passes in `forge-control-web`. Run in every phase; formally gated here.
*Verify:* command output in the deploy task log.

**R22 — Deploy per the brief's runbook.**
Merge main into `project/8ea0cc08` first if main moved; re-run tsc + build in the worktree; merge to main in `/opt/forge-ai-os`; rebuild web; `pm2 restart forge-control-web` and `forge-control` (API files changed — yes, agents.ts). **Never forge-executor.** On any merge conflict: stop, leave the branch, report the exact files.
*Verify:* `pm2 jlist` online; `curl :7700/api/health`; `curl -s -o /dev/null -w '%{http_code}' :7701/desktop`; settled runs frozen in production; final summary includes hover before/after numbers.

### Non-functional (all phases)

**NF1** Design tokens only (`app/tokens.ts` / `var(--fg-*)`); both themes verified per phase; zero hardcoded colors in touched files (`grep -nE '#[0-9a-fA-F]{3,8}|rgb\(' <touched>` → only token definitions may hit).
**NF2** Forbidden files: `project-tick.ts`, `cc-runner.ts`, `executor.ts`, `db/projects.ts`, `FileExplorerPanel*`, `VaultFileList*`, `routes/files.ts`. Needed run-query helpers live inside `routes/agents.ts`.
**NF3** `/api/agents` changes are strictly additive (mobile PWA + ProjectsSurface consume it).
**NF4** No new npm dependencies in any phase. (Perf fixes use React.memo / CSS, not libraries.)
**NF5** Work only inside this worktree until phase 5. `pnpm install` in each repo before first build (worktree ships without node_modules): `NODE_ENV=development pnpm install --prod=false`.
**NF6** No `forge-executor` restart; no destructive DB statements; DB access read-only (`psql` SELECTs) except nothing — this project writes no DB data at all.
**NF7** Every phase's builder commits to `project/8ea0cc08` with per-unit commits and updates its task log; reviewer tasks paste executed command output, not assertions.
