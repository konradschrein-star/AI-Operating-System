# 04 — Phases (the waterfall)

Five phases, one planner task each at rounds 100/200/300/400/500. Gaps leave room for fix cycles (reviewer+1/+2) without colliding with the next phase's planner. Rounds gate ordering only: round N+1 starts when everything ≤ N is done. Phases are sequenced so no two phases edit the same file concurrently — phases 1 and 2 both touch `routes/agents.ts` + `AgentActivity.tsx` + `agentsApi.ts`, phases 3 and 4 both touch the chat surface; strict ordering removes every collision.

Every phase inherits: the QA gate preamble (03-quality §3 items 1–4), NF1–NF7 (01-requirements), the forbidden-files list, and per-unit commits to `project/8ea0cc08` (pushed to origin after green builds). Every planner should split into builder task(s) + one reviewer task (adversarial where marked), with fix cycles inside the phase's round gap.

---

## Phase 1 — Time truth (round 100)

**Covers: R1 R2 R3 R4 R5 R6**

**Scope.** `forge-control/src/routes/agents.ts` (SELECTs + `agentFromRow` + `subagentsFromRollup` + local wire interfaces); `forge-control-web/app/desktop/live/agentsApi.ts` (type mirror), `AgentActivity.tsx` (duration helpers + both row components). Nothing else.

**Deliverables.**
1. `completed_at` selected; `elapsed_ms` settled-aware; `settled`/`settled_at` on the wire (additive).
2. Sub-agent `ended_at` + `description` projected.
3. `runElapsedMs`/`subagentElapsedMs` helpers own all duration math; components contain none.
4. `scripts/checks/check-duration.ts` (table-driven, exits nonzero on failure).
5. Recorded pre-change `jq keys` snapshot (for the additivity check) in the task log.

**Acceptance.** Phase gate + two-curl frozen check on :7798 + Playwright frozen-DOM check on :7799 + check-duration green + screenshots (dark/light) showing a settled run and a done sub-agent with frozen durations. Reviewer hunts for any still-ticking settled number anywhere in the panel.

**Notes for the planner.** Worktree needs `pnpm install` in both repos first. The 4 legacy cancelled rows in the live DB are the natural fixture for the `updated_at` fallback — pin their ids in the builder brief (query in 02-architecture §2.3 recon; e.g. `310a6cdb`). Do not "fix" the cancel path in `db/runs.ts` — read around it (non-goal).

---

## Phase 2 — Kind truth (round 200)

**Covers: R7 R8 R9 R10 R11**

**Scope.** Same three files as phase 1 (sequential round — no collision), plus (if the planner chooses to centralize the role-color map) a small shared constant in the live module; `ManagersSection.tsx` read-only unless R11 needs a pin.

**Deliverables.**
1. `agent_kind` + `role` + `project_id` + `cron_name` projected with the ordered precedence (02-architecture §4.1), `unknown` rendered honestly.
2. Panel row grammar per §4.2: kind badge, role label, model display mapping (pure fn), sub-agent `description` as title.
3. Lineage via enriched native `title` attributes (§4.3 decision) — no JS hover state in the Live panel.
4. `scripts/checks/check-classify.ts`.

**Acceptance.** Phase gate + curl kind spot-checks against pinned DB rows + dark/light screenshots + the stranger test + `title` content dumps. Zero `onMouseEnter` in `app/desktop/live/` (grep).

**Notes for the planner.** Reuse the visual idiom, don't redesign. The role set must include scout/researcher (new roles, no rows yet — code against the set in `routes/projects.ts:24–30`). Badge colors from tokens only; check both palettes actually differ enough (light theme faint colors — screenshot judgment).

---

## Phase 3 — Hover performance (round 300) ⚠ high-risk: measurement rigor

**Covers: R12 R13 R14 R15**

**Scope.** Measurement scripts (`scripts/checks/hover-sweep.ts`), artifacts under `docs/plan/perf/` + `docs/plan/artifacts/phase3/`, and — depending on what the trace names — `ChatSurface.tsx` (ChatListItem, task list rows, memoization), possibly `Providers.tsx` (only with trace evidence). Poll cadences unchanged (honesty rule).

**Deliverables.**
1. `hover-sweep.ts` per protocol 03-quality §4 (both candidate sidebars swept: chat rail AND right SidePanel/Live rows).
2. `docs/plan/perf/baseline.md` + raw traces (pre-fix, this worktree).
3. `docs/plan/perf/findings.md` — the named mechanism with trace evidence.
4. The fix (expected shape: memoized rail rows + CSS-`:hover` for the ✕ affordance, killing per-row `useState` — but the trace decides).
5. `docs/plan/perf/after.md` + raw traces; before/after table.

**Acceptance.** Phase gate + numeric gate (zero >50ms hover-attributed tasks; ≥50% scripting reduction vs baseline when baseline ≥120ms; the "lag lives elsewhere" branch per protocol otherwise) + R15 click-through + **adversarial red-team reviewer** (03-quality §5: attack with live SSE streaming, 60-row panel, rapid cross-surface hover; verify the sweep actually hovers rows; hunt stale-UI regressions from memoization).

**Notes for the planner.** Seed TWO review tasks in sequence: a standard reviewer (gate + reproduce numbers) and a red-team reviewer briefed to break it — or one reviewer with an explicit attack brief; do NOT run two reviewers in the same round (known engine dedupe bug — Operator Log 2026-08-05). Baseline must be captured BEFORE any fix commit touches ChatSurface — enforce by commit order in the builder brief. Phases 1–2 changed the Live panel; that is fine — baseline is defined as this worktree pre-phase-3, and the protocol's "lag lives elsewhere" branch covers surprises.

---

## Phase 4 — Agent comms in chat (round 400)

**Covers: R16 R17 R18 R19 R20**

**Scope.** `forge-control-web/app/desktop/chat/thread-mapping.ts`, `AssistantThread.tsx` (new sibling components `AgentSpawnRow`, `SendMessageRow` may live in a new file in the same dir), `app/api.ts` only if `ThreadEntry` typing needs the additive `kind` literals it already has. `docs/plan/notification-gap.md`. **No forge-control changes in this phase; `cc-runner.ts` untouched.**

**Deliverables.**
1. `parentToolUseId` + spawn-index attribution through the mapper (pure, fixture-tested via `check-thread-mapping.ts`).
2. `by_name` renderers for Agent + SendMessage per 02-architecture §6.2 — visual grammar cloned from `ToolCallRow`, direction markers, defensive parsing, `UNPARSED PAYLOAD` visible fallback.
3. Sub-agent attribution marker on transcript parts (R18) — low visual weight.
4. `docs/plan/notification-gap.md` (R19) with pinned code quotes.

**Acceptance.** Phase gate + check-thread-mapping green + Playwright on run `3853c154-e07b-4378-9313-2b34f4a33342` (2 Agent spawns, sub-agent Bash attribution) and a SendMessage-bearing run (`a86cf7b3…`, 2026-08-04) + malformed-fixture visible render + both themes + adversarial payload attacks (03-quality §5: truncated JSON, missing description, duplicated SendMessage fields, missing tool_result, very long prompts).

**Notes for the planner.** The historical runs named above are the ground-truth fixtures — they exist in the live DB and render through the worktree UI at :7799 against the live API with zero setup. Collapse state stays local per-row (existing pattern). Do not restructure the assistant-message grouping algorithm (rejected alternative — 02-architecture §1).

---

## Phase 5 — Deploy & production verification (round 500)

**Covers: R21 R22**

**Scope.** `/opt/forge-ai-os` live checkout (first time this project touches it), pm2 `forge-control-web` + `forge-control`. **Never forge-executor.**

**Deliverables / runbook (in order, stop on any failure):**
1. In the worktree: final `tsc` ×2 + `pnpm build` green; all phases' tasks done; push branch.
2. In `/opt/forge-ai-os`: `git fetch` + check whether `main` moved since branch point; if yes, merge `main` INTO `project/8ea0cc08` in the worktree, re-run tsc + build there. **Any conflict → STOP, leave the branch, report exact files.**
3. Merge `project/8ea0cc08` → `main` in `/opt/forge-ai-os` (fast-forward or clean merge only).
4. `pnpm install --prod=false` if lockfile moved; rebuild forge-control-web; `pm2 restart forge-control-web`; `pm2 restart forge-control` (agents.ts changed).
5. Verify: `pm2 jlist` both online; `curl :7700/api/health`; `:7701/desktop` serves (200/307); settled runs frozen in production (two-curl check against :7700); kind badges + agent-comm blocks spot-checked in production UI; hover sweep against :7701 within tolerance of phase-3 "after".
6. Final summary to the project: changes shipped + the hover before/after numbers (the brief demands them in the final message).

**Acceptance.** Every runbook step's output pasted. A deploy reviewer is optional; if seeded, it re-runs step 5 only.

**Notes for the planner.** forge-executor keeps running old code until the engine-v2 lane deploys it — `/api/agents` reads whatever the executor wrote, and all phase-1/2 fields come from columns + rollup the old executor already writes, so no coordination is needed. If `docs/plan/` conflicts at merge (the previous project's corpus lives on main), resolution is: ours (this project's corpus) — that is the one foreseeable conflict and it is content-disjoint by design; anything else stops per rule 2.

---

## Requirement → phase map (completeness check)

| Phase | Requirements |
|---|---|
| 1 — Time truth | R1 R2 R3 R4 R5 R6 |
| 2 — Kind truth | R7 R8 R9 R10 R11 |
| 3 — Hover perf | R12 R13 R14 R15 |
| 4 — Agent comms | R16 R17 R18 R19 R20 |
| 5 — Deploy | R21 R22 |
| (all) | NF1–NF7 |

22 requirements, each in exactly one phase; no orphans.
