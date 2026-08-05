# 04 — Phases (the waterfall)

Six phases. Each is seeded as **one planner task** at round `k*100`
(100, 200, …, 600); the gaps leave room for fix cycles without colliding with the
next phase. Rounds gate ordering: round `N+1` starts only when everything `≤ N` is
done. Phases are sequenced so that no two phases edit the same file concurrently —
in particular **P3 and P4 both touch `FileExplorerPanel.tsx`, so they are in
consecutive rounds, never the same one.**

Each phase planner reads this file plus `01-requirements.md`, `02-architecture.md`,
and `03-quality.md`, then breaks its phase into builder/reviewer tasks. **Tasks a
planner creates in the SAME round must touch disjoint files;** anything that could
collide goes in consecutive rounds.

---

## Phase 1 — Profile & baseline  (round 100)

**Goal:** Prove where the lag is before changing anything, and record numbers the
final phase will be measured against.

**Scope:** Read-only + temporary instrumentation. No production source changes.

**Deliverables:**
- Extend `docs/plan/BASELINE-FINDINGS.md` (or a new `docs/plan/baseline-render.md`)
  with **in-browser** measurements: click-to-first-paint of the Files tab on the
  vault root (typical dir), a React Profiler or `performance.mark` trace of the
  mount, and confirmation that the accumulating `files` array grows as you
  navigate. Use the `playwright-skill` to drive the live web app.
- Confirm the API timings already captured (curl) and add a nested-dir timing.
- A one-paragraph "root cause confirmed" statement: mount cost + array growth
  (client), light mode = `!important` CSS. If the data contradicts the architect's
  read, say so explicitly and flag it — do not proceed on a false premise.

**Acceptance:** Numbers written into the corpus and committed; root-cause
statement present. No gate on code (nothing changed).

**Requirements covered:** measurement basis for R11/R12/R13 (owned/verified later).

---

## Phase 2 — Backend `/list` hardening  (round 200)

**Goal:** Make `/api/files/list` bounded and cache-friendly for large directories
without changing containment or the entry shape.

**Scope (files):** `forge-control/src/routes/files.ts` only.

**Deliverables:**
- Switch the dir/file distinction to `fs.readdir(abs, { withFileTypes: true })`;
  `stat` only what still needs size/mtime, and `stat` symlink entries explicitly so
  a symlinked directory still reports `isDir` correctly (document this caveat in a
  comment).
- Cap large listings at `LIST_CAP` (default ~1000) with a `truncated` flag + total
  count, mirroring `/search`'s `SEARCH_RESULT_CAP` pattern. (Optional upgrade:
  `limit`/`offset` pagination — allowed if the reviewer prefers it.)
- Add `Cache-Control: private, max-age=<small>` to `/list`.
- Preserve `resolveInRoot` and all traversal/dotfile/symlink guards byte-for-byte.

**Acceptance / gates:** T1 (`forge-control` tsc clean), T5/T6 (`/list` timings incl.
a synthetic ≥2000-entry temp dir, cleaned up after), T7 (`Cache-Control` present),
T8 (containment attempts still blocked). Containment diff reviewed.

**Requirements covered:** R16, R17, R24, R26.

---

## Phase 3 — `VaultFileList`: virtualized, token-native list  (round 300)

**Goal:** Replace the `@cubone/react-file-manager` list/nav/breadcrumb surface with
our own windowed component; move the panel to a bounded per-directory data model +
client cache; surface errors. **HIGH-RISK — planner adds a red-team reviewer.**

**Scope (files):**
- New `forge-control-web/app/desktop/chat/VaultFileList.tsx` (+ optional `.css`).
- `forge-control-web/app/desktop/chat/FileExplorerPanel.tsx` (swap `<FileManager>`
  for `<VaultFileList>`; introduce `(root, rel)` state + bounded cache; remove the
  `.catch(() => [])` silent swallow).
- `forge-control-web/app/api.ts` only if `fetchFileList` needs optional pagination
  args (additive; don't break callers).
- `package.json` + lockfile only if `@tanstack/react-virtual` is added
  (`NODE_ENV=development pnpm add @tanstack/react-virtual --prod=false`).
- **Do not** finalize theming/tokens here beyond using tokens for any color you
  write — the dedicated token audit is Phase 4. (Write tokens from the start; P4
  verifies and fills gaps.)

**Deliverables:**
- Windowed list (row count ≪ entry count) over fixed-height rows; folder-descend;
  clickable breadcrumb; selection toggle with count; drag-out preserving
  `VPS_FILE_DRAG_MIME` + `{root, rel}` payload; explicit error row + empty row;
  truncation banner when `/list` reports `truncated`.
- Bounded cache (`Map`, ≤~32 dirs, stale-while-revalidate); `refresh` forces
  refetch; roots seed unchanged.
- Preserve: `FilePreview` (untouched), `SearchResultsList` (kept; may reuse), the
  `onAttach` prop, the `memo`, and the `VPS_FILE_DRAG_MIME` export from the panel
  module.

**Acceptance / gates:** T2 (web tsc clean), T13 (behavior parity: R1–R10), T11
(virtualization smoke on synthetic large dir), T14 (error surfacing). Red-team
reviewer attempts to break drag-out, selection persistence, breadcrumb edges, the
error path, and large-dir scroll — and signs off only when it can't.

**Requirements covered:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R13, R14, R15,
R23, R25, R27, R29.

---

## Phase 4 — Theme correctness & token audit  (round 400)

**Goal:** Zero hardcoded colors across the Files pane; verified legible and
consistent in BOTH themes; the old `!important` dark-override CSS gone.

**Scope (files):**
- `forge-control-web/app/desktop/chat/FileExplorerPanel.css` — delete the 49-line
  `!important` hardcoded block (or reduce to token-only rules).
- `forge-control-web/app/desktop/chat/FileExplorerPanel.tsx` — replace the inline
  `rgba(91,141,239,0.12)` (line ~569) and any remaining literals with tokens.
- `forge-control-web/app/desktop/chat/VaultFileList.tsx` — audit; any literal → token.
- `forge-control-web/app/theme.css` — add accent-alpha tint tokens (e.g.
  `--fg-rowHover`, `--fg-rowSelected`) to **BOTH** `:root` and
  `html[data-theme="light"]`.
- `forge-control-web/app/tokens.ts` — map the new tokens.

**Deliverables:**
- New tint tokens defined in both palettes and consumed via `tokens.*` / `var()`.
- The hardcoded-color grep (T4) over all touched Files components returns **0**.
- Playwright screenshots of the pane in dark AND light, attached to the task.

**Acceptance / gates:** T4 (0 hardcoded colors), T12 (both-theme screenshots),
T17 (token discipline; new tokens in both palettes), T22/R22 (`!important` block
removed). T2 (web tsc still clean).

**Requirements covered:** R18, R19, R20, R21, R22.

---

## Phase 5 — Perf verification & final adversarial review  (round 500)

**Goal:** Prove the DoD numerically and adversarially before deploy.
**HIGH-RISK — planner adds a red-team reviewer.**

**Scope:** Verification + any small fixes the review demands (no new scope).

**Deliverables / gates (all executed, output pasted into the task):**
- T1 + T2 (`tsc` clean both repos), T3 (`pnpm build` green).
- T9 click-to-render ≤ 200 ms on a typical dir; **before/after vs Phase 1 baseline**
  written into the corpus.
- T10 cached re-visit < ~30 ms; T11 synthetic ≥1000-entry dir stays responsive
  (no long task > 200 ms, windowed DOM).
- T15 scope diff (touched paths ⊆ allowed set, R30); T16 no silent fallback.
- Final adversarial pass over the whole Files experience in both themes at narrow
  and wide panel widths.
- A written **PASS/NEEDS_FIXES** verdict. PASS is required before Phase 6.

**Requirements covered:** R11, R12, R28 (and re-verifies R13, R26, R27, R30).

---

## Phase 6 — Merge & deploy  (round 600)

**Goal:** Ship it to the live checkout. Only runs after Phase 5 PASS.

**Scope:** Deployment only. Follows the brief's deployment section exactly.

**Steps:**
1. In `/opt/forge-ai-os` (the **live** checkout, NOT this worktree):
   `git merge` the project work branch into `main`. **If it conflicts, STOP** —
   leave the branch, force nothing, report the conflict in the final message.
2. Rebuild `forge-control-web` (`pnpm install` only if deps changed, then
   `pnpm build`); `pm2 restart forge-control-web`. Restart `forge-control` **only
   if its files changed** (Phase 2 did change `files.ts`, so a `forge-control`
   restart is expected). **NEVER** touch `forge-executor`.
3. Verify: `pm2` shows both processes online; `GET http://127.0.0.1:7700/api/health`
   → 200; the web app serves HTTP 200 on its port (find the port via pm2 env /
   ecosystem config).
4. Final task message: what changed + before/after timings.

**Requirements covered:** deployment / S7. Enforces R30 one last time.

---

## Requirement → phase coverage matrix (every R assigned to exactly one phase)

| Phase | Requirements owned |
|---|---|
| P1 Profile | (measurement basis; owns no unique R) |
| P2 Backend | R16, R17, R24, R26 |
| P3 List | R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R13, R14, R15, R23, R25, R27, R29 |
| P4 Theme | R18, R19, R20, R21, R22 |
| P5 Perf/Final | R11, R12, R28 |
| P6 Deploy | S7 (deployment) |
| Cross-cutting | R30 (enforced every phase, finally at P5/P6) |

All of R1–R29 are owned by exactly one phase; R30 is the cross-cutting scope
guardrail; deployment (S7) is P6.

## Round map

| Round | Task |
|---|---|
| 0 | Architect (this plan) — done |
| 100 | Planner: Phase 1 — Profile & baseline |
| 200 | Planner: Phase 2 — Backend `/list` hardening |
| 300 | Planner: Phase 3 — `VaultFileList` (adds red-team reviewer) |
| 400 | Planner: Phase 4 — Theme & token audit |
| 500 | Planner: Phase 5 — Perf verification & final review (adds red-team reviewer) |
| 600 | Planner: Phase 6 — Merge & deploy |
