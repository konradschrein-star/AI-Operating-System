# 14 — UI v3 Quality & Review Protocol

Extends `03-quality.md` (its preamble, ports, and harness conventions still apply: worktree API on :7798 spun from routes under test, worktree web on :7799, production :7700/:7701 untouched until phase 900).

## Universal gates — EVERY phase's reviewer runs all of these

1. `npx tsc --noEmit` in forge-control AND forge-control-web — zero errors.
2. `NODE_ENV=production pnpm build` in forge-control-web — green.
3. `git diff --name-only <phase-base>..HEAD` — assert none of: `project-tick.ts`, `cc-runner.ts`, `executor.ts`, `db/projects.ts`, `FileExplorerPanel*`, `VaultFileList*`, `routes/files.ts`. Any hit = automatic FAIL.
4. Token purity: `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(" <files touched this phase>` — only tokens.ts itself may define colors.
5. Both themes: dark + light screenshots of every surface the phase touched, attached to `docs/plan/artifacts/phase<NNN>/`.
6. $-sweep regression (phases 400+): `grep -rniE "usd|spend" forge-control-web/app --include="*.tsx" -l` — every hit must be on the phase's documented allowlist (non-rendering types/comments); a new rendering hit = FAIL.
7. Additive-API check (phases that touch forge-control): curl the pre-existing endpoints (`/api/chat`, `/api/agents`, `/api/projects/managers`) and diff shapes against a recorded baseline — removed/renamed fields = FAIL.

Reviewers verify with their own commands — never accept the builder's transcript as evidence. Screenshots must be taken by the reviewer or reproduced from the builder's committed script.

## Measurement protocols

### Hover non-regression (NFU2 — phases 500, 600, 700)
React DevTools profiler (or `react-scan`, already used in phase-2 tooling if present; otherwise the profiler API) sampling during a scripted 10-second hover sweep across ≥20 team rows (adapt phase-1's `frozen-dom.cjs` Playwright harness). Gate: zero component re-renders attributable to pointer events. The deep CDP-trace protocol stays with deferred phase 1300 — this gate is cheaper and binary.

### Frozen-time truth (U16 — phase 500)
Playwright samples the team panel DOM at t and t+12s with at least 3 settled rows present. Every settled row's time/token cells byte-identical. Running rows must differ (anti-vacuous-pass guard, per phase-2 artifacts README).

### Working-time unit truth (U5 — phase 300)
`scripts/checks/check-working-time.ts`: table-driven synthetic threads (gap below cap / above cap / mixed / running-node now-extension / rollup fallback) with exact expected sums; `process.exit(1)` on mismatch. Runs in review AND stays as a regression check.

### Poll budget (NFU3 — phase 500 review, re-checked at 700)
One minute of network capture (Playwright HAR or DevTools) with a project chat open, before (main) vs after (branch). Requests/minute to :7798-proxied endpoints must be ≤ baseline. Attach both HARs.

### Secret non-leakage (U30 — phase 800)
End-to-end: `POST /api/secrets/:name/mark-pending` with a request note → UI shows request → answer in panel with a sentinel value (`LEAKCANARY-<rand>`) → then `psql`: `SELECT count(*) FROM runs WHERE thread::text LIKE '%LEAKCANARY%'` must be 0, and `GET /api/chat/:id` body must not contain the sentinel. FAIL on any hit.

### Composer autogrow (U28 — phase 800)
Playwright: type 1 line → record height; 5 lines → taller; 25 lines → height equals the 10-row cap and the textarea scrolls internally; clear → back to min. Assert numerically, not by eyeball.

### Path traversal (U6 — phase 300)
`curl ':7798/api/chat/<id>/plan/doc?name=../../../../etc/passwd'` and `name=..%2f..%2fsecrets` → both 400, body names the rejection. Also `name=10-ui-v3-spec.md` → 200 with markdown.

### Linkage honesty (U2 — phase 300)
Three curls: chat with `origin_chat_id` project (`link_source:"metadata"`), legacy chat resolvable by scan (`"thread_scan"` + backfill verified by re-curl showing `"metadata"`), plain chat (`project: null`, HTTP 200).

## Per-phase reviewer focus (beyond universal gates)

- **300 (API):** run every check script; verify NO web files touched; verify agents.ts helper extraction didn't change `/api/agents` output (curl-diff against baseline recorded BEFORE the phase).
- **400 (rail/header/$):** the $-sweep IS the review — walk every surface (chat, live, status bar, pipeline) in both themes hunting rendered dollars; verify ManagersSection gone and `/api/projects/managers` uncalled (grep + network capture); slim header in live-SSE and polling states.
- **500 (team panel):** RED-TEAM (destructive controls). Attack: X/stop on running vs settled rows with all-false capabilities (must be inert + visibly disabled); confirm-step bypass by rapid clicks; hover sweep re-renders; frozen-time protocol; empty/error/unlinked states by curling nonsense chat ids through the UI; dismissal persistence across reloads.
- **600 (navigation/legibility):** walk the full stack down (manager→worker→sub-agent) and back; browser refresh mid-stack lands on manager chat without errors; orientation strip on a LIVE worker (values change with `current_activity`); ToolCallRow summaries expand to full payloads byte-complete (no truncation in raw view); digest honesty on a 200-entry real session.
- **700 (Kanban):** render THIS project's real plan; counts agree between rail badge, panel bar, and `GET /api/projects/:id` ground truth; phase-doc click-through + back; graph-readiness note names the exact store type and the mapping.
- **800 (composer/secrets):** RED-TEAM (secrets). Run the sentinel protocol; also try to leak via: secret request note rendered as markdown (XSS/injection — note must render as plain text), secret value in a failed-request error toast, value lingering in React state after store (heap snapshot or component inspection). Effort ramp + autogrow protocols. Canvas numbers verified by rerunning the trace.
- **900 (deploy):** follow the runbook exactly; verify pm2 online, `/api/health`, production screenshots (U34); confirm forge-executor uptime unchanged (`pm2 show forge-executor` start time before vs after).

## QA sequencing rule

A phase's reviewer FAIL spawns fix tasks inside the same round-block (e.g. 511, 512 after a 510 review) and a re-review; the next phase's planner does not start until the block is green. Phase plans must state their artifact list explicitly so the reviewer knows what "complete" looks like before reading the diff.
