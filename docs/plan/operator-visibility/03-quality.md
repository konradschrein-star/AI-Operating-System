# 03 — Quality strategy & QA gates

Rule from the brief: reviewers run `tsc` + the web build, curl the touched endpoints, verify both themes, and — for the hover fix — reproduce the recorded measurement. **An assertion without pasted command output is a NEEDS_FIXES on the review itself.**

## 1. Environment ground rules (every phase)

- Worktree ships without `node_modules`. First command in each repo: `NODE_ENV=development pnpm install --prod=false` (pnpm 10.x at `/usr/bin/pnpm`; lockfiles present in both repos — do not update them).
- Builds: `npx tsc --noEmit` in `forge-control` and `forge-control-web`; `pnpm build` in `forge-control-web`.
- A worktree web server for visual checks: `PORT` clash rule — production owns :7701; run the worktree build on **:7799** (`pnpm build && pnpm exec next start -p 7799`). The worktree UI proxies `/api/proxy/*` to `FORGE_CONTROL_URL` (default `http://127.0.0.1:7700`) — i.e., it reads the **live** API and live data; that is intended (real settled rows, real threads) and safe (this project's UI is read-only against the API; do not exercise mutating chat actions from the worktree UI beyond selecting/viewing).
- API testing of *worktree* forge-control changes: run the worktree API on **:7798** (`PORT=7798 pnpm dev` or the repo's start script) against the same Postgres — `routes/agents.ts` is read-only SQL, so this is safe. Never point pm2 at the worktree.
- Both themes: toggle via `document.documentElement.dataset.theme = 'light' | 'dark'` (persisted key `forge.theme`) — Playwright: `page.evaluate` then screenshot.
- Screenshots and traces are artifacts: commit under `docs/plan/artifacts/phase<k>/` (small PNGs; traces gzipped if > 2 MB).

## 2. Test strategy by layer

### Unit (vitest is NOT set up — do not add a test framework; NF4)
In lieu of a runner, pure helpers get **executable check scripts** under `scripts/checks/` (plain `tsx`/`node` scripts that `process.exit(1)` on failure) — boring, zero-dep, runnable by reviewer:
- `check-duration.ts` — table-driven cases for `runElapsedMs`/`subagentElapsedMs`: settled uses settled_at; cancelled falls back to updated_at; done sub-agent with null ended_at falls back to updated_at; all-null → null; running ticks with `now`.
- `check-classify.ts` — classification precedence incl. `unknown`; model display mapping incl. alias and unknown passthrough.
- `check-thread-mapping.ts` — fixtures: Agent spawn + ack; SendMessage + reply; subagent-attributed Bash call gets `parentToolUseId` + `agentLabel`; malformed input JSON → parts still produced; orphan tool_result degrades to text (existing behavior preserved).
Fixtures are verbatim thread entries captured from the live DB (samples already in this corpus's recon; extend by read-only psql).

### Integration (curl, against worktree API :7798)
- Time truth: two `curl`s ≥5s apart, `jq` diff of settled rows' `elapsed_ms` → empty.
- Additivity: `jq '.agents[0] | keys'` superset of the pre-change key set (recorded in phase 1 planner output).
- Kind truth: `jq` over known rows (one operator, one worker, one cron — ids pinned in the phase task) → expected `agent_kind`/`role`.
- Sub-agents: every `status:"done"` element post-rollup-v2 has `ended_at`.

### End-to-end (Playwright against worktree web :7799)
- Frozen timers: locate a settled row's duration cell; poll DOM text 3× across 10s → constant. Same for a done sub-agent line.
- Kind badges: screenshot dark + light; assert badge text content for the three kinds via selectors.
- Chat comms: open run `3853c154-e07b-4378-9313-2b34f4a33342` (contains 2 Agent spawns + sub-agent-attributed tool calls); assert spawn blocks render (`→`, "Explore", description preview), expand → full prompt text present; screenshot both themes.
- Hover behavior regression (R15): click chat-rail row selects; ✕ appears on hover and closes; task-list row opens run.

## 3. QA gates per phase (reviewer checklist)

Every phase gate includes, without exception:
1. `npx tsc --noEmit` both repos — paste tail.
2. `pnpm build` in forge-control-web — paste tail.
3. `git diff --name-only main...HEAD` — confirm **no forbidden file** (`project-tick.ts|cc-runner.ts|executor.ts|db/projects.ts|VaultFileList|routes/files.ts`) and no file outside the phase's declared scope.
   > **OPERATOR WAIVER 2026-08-16: FileExplorerPanel.tsx only; files-pane-fast-light completed 2026-08-05 so the collision this rule guarded against no longer exists.** The executable gate (`scripts/checks/gates-808.sh`, commit `c5bce64`) already carries this waiver; this prose now matches it. Scope is `FileExplorerPanel.tsx` and nothing else — `VaultFileList*`, `routes/files.ts` and every engine file above stay forbidden.
4. `grep -nE '#[0-9a-fA-F]{3,8}|rgb\(|hsl\(' <touched .tsx/.ts>` — zero hits (NF1).
5. Phase-specific checks below.

**Phase 1 (time truth):** run `scripts/checks/check-duration.ts`; the two-curl frozen check; the `keys` additivity check; Playwright frozen-DOM check; screenshot pair. Adversarial instinct: try to find *any* ticking settled number — RECENT section, sub-agent lines, second-line labels.
**Phase 2 (kind truth):** `check-classify.ts`; curl kind spot-checks against DB rows (paste the psql SELECT too); dark+light screenshots; the stranger test — reviewer states each visible row's kind/role/model from the screenshot alone; hover/`title` content dumped via Playwright `getAttribute('title')` for one sub-agent and one worker row.
**Phase 3 (hover perf):** see §4 — reviewer *re-runs* the sweep, reproduces within ±20%, checks the named root cause exists in the baseline trace, R15 click-through, and confirms poll cadences unchanged (`grep refetchInterval`).
**Phase 4 (agent comms):** `check-thread-mapping.ts`; Playwright on run `3853c154…` (+ one SendMessage-bearing run, e.g. `a86cf7b3…` from 2026-08-04); malformed-fixture visible-render check; `notification-gap.md` exists and its quoted code matches `cc-runner.ts` at the pinned lines; both themes.
**Phase 5 (deploy):** the runbook checks (01-requirements R22) plus production spot-checks: settled runs frozen on :7701, kind badges visible, agent-comm blocks render in a real operator chat, hover sweep numbers from production within tolerance of the phase-3 "after".

## 4. Hover-performance measurement protocol (binding for R12–R14)

**Tooling:** Playwright (chromium already installed under `/root/.cache/ms-playwright`) driving the worktree build, Chrome tracing via `browser.startTracing` / CDP `Performance` + `Tracing` domains. React DevTools is not available headless; the trace's function/component attribution plus targeted `console.count` instrumentation (temporary, removed before merge) stand in for the profiler's flame chart.

**Scripted sweep (one script, `scripts/checks/hover-sweep.ts`, committed in phase 3 and reused by reviewer and phase 5):**
1. Launch chromium headless, viewport 1440×900, open `http://127.0.0.1:7799/desktop`, wait for the chat rail + Live panel to be populated (network idle + selector waits).
2. Settle 5s (let initial polls land).
3. Start tracing (categories: `devtools.timeline`, `disabled-by-default-devtools.timeline`, `blink.user_timing`).
4. For 10 seconds, dispatch `mousemove`/`mouseenter`/`mouseleave` sweeps up and down the chat-rail rows at ~60 events/s (Playwright `mouse.move` along the rail's bounding boxes), covering ≥ 8 rows repeatedly.
5. Stop tracing; save `trace-<label>-<n>.json`.
6. Repeat ×3; report per-run and median of: total main-thread scripting ms during the 10s window; count of tasks > 50ms; longest task ms; and (from user timing if present) React commit count. Record `uptime`/`nproc`/load average alongside (busy-VPS honesty).

**Baseline (R12):** run the sweep on the worktree build at phase-3 start (pre-fix). Label `baseline`. Optionally also against production :7701 for context (label `prod-ref`) — informative, not the gate, since phases 1–2 changed the Live panel.
**After (R14):** identical script post-fix. Label `after`.

**Numeric gate:** `after` median shows (a) **zero tasks > 50ms** during the sweep window that the trace attributes to script/hover handling (GC and unrelated poll work must be called out explicitly if present), and (b) total scripting ms reduced **≥ 50%** vs baseline *if* baseline total ≥ 120ms; if baseline is already < 120ms total (i.e., the lag lives elsewhere than the swept surface), the phase must instead identify where the felt lag comes from (widen the sweep: sidebar = SidePanel? Managers? DesktopApp nav rail?), measure *that*, fix *that*, and apply the same gate there. Konrad said "the sidebar" — the phase planner must not assume which sidebar until the baseline says so. Sweep both candidates (chat rail + right SidePanel/Live rows) in the baseline.

**Honesty rules:** no cadence slowing to pass the gate; no removing hover affordances to pass (the ✕ must survive, R15); traces committed raw; if the 3 runs disagree wildly (>2× spread), note VPS load and re-run rather than cherry-picking.

## 5. Adversarial review (phase 3 and phase 4 carry extra risk)

Phase 3's planner must include a **red-team reviewer task** briefed to attack, not check: try to produce visible hover jank after the fix (long transcript open, live run streaming SSE snapshots at 1s, 60-row panel, rapid hover between rail and panel); try to catch a stale UI (status change not reflected after memoization); try to catch the measurement lying (sweep script not actually hitting rows — verify with screenshot mid-sweep or DOM hover-state assertion).
Phase 4's reviewer must attack payload edge cases: 1,500-char-truncated input JSON (mid-string cut → parse fails → raw render, never blank); Agent call with missing description; SendMessage duplicated fields; a thread where the spawn's tool_result is missing (pending forever → `running` state, not crash); very long prompts (maxHeight scroll, no layout blowout); both themes on every screenshot.

## 6. What "done" means for a reviewer verdict

PASS requires: all gate commands pasted with output, artifacts committed, requirement IDs of the phase each explicitly checked off with evidence reference. NEEDS_FIXES must name the failing requirement ID and the exact command/output that failed. No third verdict exists.
