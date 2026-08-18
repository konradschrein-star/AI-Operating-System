# 15 — UI v3 Phases (rounds 300–900)

Waterfall for the Chat-Manager UI v3 rework. Precedence: `10-ui-v3-spec.md` (law) → `12-ui-v3-requirements.md` → this doc. Rounds 300–999 belong to this rework; each phase owns its hundreds-block (planner at k00, builders/reviewers/fix-cycles within k01–k99). Rounds 1200+ are reserved (steward checkpoint 1250, deferred hover-perf 1300, operator-comms 1400, original deploy 1500, dismissal 1600, customer test 1900) — those run AFTER this rework, on top of the v3 layout.

## OPERATOR DECISION — 2026-08-17, canvas first-open cost (binding, Konrad)

The r1250 steward escalated the canvas "190 ms on first open" to Konrad: Excalidraw registers
~230 fonts on mount, and Blink answers by relaying the whole `/desktop` document (8,416 layout
objects). Options offered: (a) keep the canvas editor mounted+hidden after first open,
(c) virtualise/cap the chat transcript so the document is small, (d) accept the cost.

**Konrad's answer: (d) — 190 ms once per page load is acceptable.**

Consequences, binding on every later round:
- **Option (c) is CLOSED.** No transcript virtualisation, capping, or windowing may be
  undertaken to buy canvas-open time. The transcript is what Konrad reads every day; it is
  not to be restructured for a 190 ms one-off. If virtualisation is ever proposed again it
  needs a NEW justification and a fresh operator decision — not this one.
- **Option (a) is CLOSED for this reason.** Keeping a hidden editor mounted is not to be
  built as a canvas-open optimisation. (It may still be considered if some other requirement
  independently demands it.)
- **Round 1300 keeps only the hover work**: profile the v3 panel, confirm hover is clean, record
  numbers. Canvas first-open is **not a defect** and must not be re-opened as one. Do not
  regress it either — 190 ms first open is the accepted ceiling, not a licence to grow.
- A measurement showing canvas-open cost is a *note*, not a finding. Reviewers must not raise it.

## How the deferred phases interact with v3 (binding)

- v3 must not regress hover performance (NFU2 gate per phase); the deep measurement protocol stays with round 1300 and will profile the NEW panel.
- v3 keeps the thread-mapping layer (`AssistantThread` mapping) structurally intact so round 1400's Agent/SendMessage comms renderers slot into the same ToolCallRow-style pattern v3 extends in phase 600.
- Frozen-time and kind-classification server logic from phases 1–2 is REUSED (imported), never reimplemented.

Every phase: planner task at round k00 plans from this doc + `12` + `13` + `14`; the planner creates builder tasks (disjoint files per round, colliding work in consecutive rounds) and ALWAYS ends the block with a reviewer task running `14-ui-v3-quality.md`'s universal gates + phase focus. Phases 500 and 800 get an ADVERSARIAL reviewer (briefed to attack, not check). Artifacts land in `docs/plan/artifacts/phase<NNN>/`.

---

## Phase 300 — Read-side API: linkage, team, plan, capabilities

**Repo:** forge-control only. **Covers:** U1, U2, U3, U4, U5, U6, U7, U8 (+NFU4, NFU5 server-side).

Scope: everything in `13-ui-v3-architecture.md §3–§5`. Route-local SQL; shared run-shaping helpers exported from routes/agents.ts (or extracted to a NEW routes/agents-shared.ts) without changing `/api/agents` output; `origin_chat_id` accepted at POST /api/projects (route layer only); linkage resolver with thread_scan fallback + one-time backfill; `GET /api/chat` list rollup (single grouped query, metadata-linkage only); `GET /api/chat/:id/team` with working_ms per the 120s-cap model; `GET /api/chat/:id/plan` + path-restricted doc streaming; `GET /api/capabilities` all-false constant; `mark-pending` additive `requested_by_run_id`.

Deliverables: routes + `scripts/checks/check-working-time.ts` + curl transcript baseline (pre-change `/api/agents`, `/api/chat` shapes) + worktree API harness (:7798) updated to mount the new routes.

Acceptance: all Phase-300 protocols in `14 §Measurement` pass (working-time unit truth, path traversal, linkage honesty); `/api/agents` curl-diff byte-stable; tsc clean both repos; zero web files touched.

Risk note for the planner: the agents.ts helper extraction is the touchiest step — it refactors reviewed phase-1/2 code. Sequence it as its own builder round with the curl-diff check BEFORE any new-endpoint work builds on the helpers.

## Phase 400 — Shell: rail progress, slim header, kill managers, $-sweep

**Repo:** forge-control-web only. **Covers:** U9, U10, U11, U12, U13 (+NFU1, NFU6 markers for link_source).

Scope: delete ManagersSection + its fetch; rail rows gain x/y badge + heuristic-link marker; verify/fix most-recent-first ordering; slim the ChatThread header per U12 (dot + docked live/polling + model + canvas + resume/cancel); whole-app $-sweep (chat header, AgentActivity header + run lines, StatusBar, PipelineSurface cards, any tooltip) replacing with token counts where a magnitude helps; document the grep allowlist.

Acceptance: $-sweep grep gate; screenshots of rail/header/live/status bar, both themes, SSE + polling states; ManagersSection unreferenced; chat list still paginates + searches.

Collision note: touches ChatSurface.tsx and AssistantThread header area — phases 500/600 touch them too, hence strict sequencing (no parallel rounds across phases 400–600).

## Phase 500 — Right panel v3: the team tree

**Repo:** forge-control-web (+capabilities consumption). **Covers:** U14, U15, U16, U17, U18, U19 (+NFU2, NFU3, NFU6).

Scope: `ChatTeamPanel` replaces AgentActivity+LiveProjectsBody in the chat SidePanel (Files tab untouched; /live untouched); flat memoized row render with depth indent per `13 §6`; leaf-only 1s tick for running working-time; CSS-only hover reveal of X + stop; two-click confirm; capability gating (all disabled today, tooltips naming the contract); dismissal-persistence wiring for X; empty/error/unlinked states; polls: one team query per open chat replacing the panel's old agents poll (budget: NFU3).

Acceptance: `14`'s hover non-regression, frozen-time, and poll-budget protocols with numbers attached; adversarial review passes (destructive-controls red team); dark+light screenshots against a real project chat.

## Phase 600 — Drill-in navigation + worker-chat legibility

**Repo:** forge-control-web. **Covers:** U20, U21, U22, U23, U24.

Scope: `navStack` in ChatSurface absorbing `agentViewFrom` (one mechanism); AgentChatView with animated (CSS) back button + role/model header; nested descent into sub-agents; OrientationStrip from wire data; ToolCallRow `summary` mode with the per-tool formatter table (prose-primary transcript); story-so-far derivation for >50-entry threads (or the documented gap artifact). PlanDocView shell lands here too (back-nav shared), fed by phase 700's Kanban clicks later.

Acceptance: `14`'s navigation walk + refresh test; strip live-updates; summaries expand byte-complete; digest honesty check; both themes.

Scout at 599 first: sample real worker/sub-agent threads (this project's own runs) and inventory `current_activity` / `subagents_v2` / per-tool payload shapes, so summary formatters and the digest are designed from real data, not guesses.

## Phase 700 — Plan zone: Kanban + phase docs + graph-ready store

**Repo:** forge-control-web. **Covers:** U25, U26, U27.

Scope: `PlanKanban` bottom zone over the `PlanNode` store (`13 §7`, `16-ui-v3-graph-research.md`); per-phase cards with task chips + always-visible x/y progress bar agreeing with the rail badge; phase click → PlanDocView (U6 endpoint + MessageMarkdown) with back-nav; graph-mapping design note in artifacts (how React-Flow+ELK would consume the same store — NO dependency added).

Acceptance: renders THIS project's real plan; three-way count agreement (rail, panel, API ground truth); click-through + back; store type + mapping note reviewed; both themes; poll budget re-check.

## Phase 800 — Composer v3 + two-way secrets + canvas perf

**Repo:** forge-control-web. **Covers:** U28, U29, U30, U31, U32.

Scope: autogrow textarea (2→~10 rows, internal scroll, reset on send); effort color ramp in EngineControls (token-mapped, manager-only unchanged); two-way secret sharer (pending-request badge + auto-open panel with request text as PLAIN TEXT, answer via existing store flow, `[secret: name]` marker only in thread); canvas button open-cost measurement → fix if >100ms scripting → before/after numbers; send button untouched.

Acceptance: autogrow numeric protocol; sentinel non-leakage protocol (DB-level); adversarial review passes (secrets red team incl. markdown-injection of the request note); canvas numbers verified by rerun; both themes.

## Phase 900 — Deploy + production verification

**Covers:** U33, U34.

Scope: the runbook verbatim — in /opt/forge-ai-os merge main INTO work branch first; conflicts → STOP and report exact files; re-run tsc (both) + build (web) in the worktree; merge to main; rebuild forge-control-web; `pm2 restart forge-control-web` + forge-control (API changed in phase 300); NEVER forge-executor (verify its start time unchanged); production curls of U3/U4/U6/U8 + screenshots (both themes) of rail, team panel, Kanban, composer; final summary including the canvas before/after numbers and the hover non-regression evidence.

Acceptance: pm2 online, `/api/health` ok, web serves, executor untouched, U34 artifact set complete.

---

## Requirement → phase map (completeness check)

| Phase | Requirements |
|---|---|
| 300 | U1 U2 U3 U4 U5 U6 U7 U8 |
| 400 | U9 U10 U11 U12 U13 |
| 500 | U14 U15 U16 U17 U18 U19 |
| 600 | U20 U21 U22 U23 U24 |
| 700 | U25 U26 U27 |
| 800 | U28 U29 U30 U31 U32 |
| 900 | U33 U34 |
| cross-cutting, every phase | NFU1–NFU9 |

All 34 U-requirements mapped exactly once. Deferred (rounds 1200+, NOT this rework): graph-view toggle, hover-perf deep instrumentation (1300 — hover only; canvas first-open is CLOSED by the operator decision at the top of this doc), operator-comms blocks (1400), dismissal phase (1600), customer test (1900).
