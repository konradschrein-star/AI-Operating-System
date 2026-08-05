# 03 — Quality strategy & QA gates

The rule from the brief is absolute: **a review without executed checks is a
NEEDS_FIXES on itself.** Every gate below is a *command that runs* and an output
that is pasted into the task record — not an assertion.

## Test strategy

This is a single-operator UI + a thin file API; the highest-value verification is
executed gates + Playwright visual/interaction checks, not a large unit suite.
Layers, in order of leverage:

### 1. Static / type gates (cheap, run constantly)

- **T1 — `forge-control` types:** `cd forge-control && npx tsc --noEmit` → exit 0.
- **T2 — `forge-control-web` types:** `cd forge-control-web && npx tsc --noEmit` →
  exit 0.
- **T3 — Web build:** `cd forge-control-web && pnpm build` → exit 0.
- **T4 — Hardcoded-color grep (the light-mode gate):**
  `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' \
   forge-control-web/app/desktop/chat/FileExplorerPanel.tsx \
   forge-control-web/app/desktop/chat/FileExplorerPanel.css \
   forge-control-web/app/desktop/chat/VaultFileList.tsx` → **0 hits**
  (adjust file list to whatever the phase actually touched). Note: `var(--fg-*)`
  and token references are not literals and won't match.

### 2. API / backend checks (executed curl)

- **T5 — `/list` correctness & timing:** `curl -s -w '%{time_total} %{http_code}'`
  against `/api/files/list` for both roots and a nested dir → 200, entry shape
  intact, single-level.
- **T6 — `/list` on a synthetic large dir:** create a temp dir of ≥2000 entries
  under `workspace` (a throwaway path, cleaned up after), time `/list` → bounded
  (capped/`truncated` if over `LIST_CAP`), no unbounded stat storm.
- **T7 — `Cache-Control` present:** `curl -sI '/api/files/list?...'` → header set.
- **T8 — Containment preserved:** traversal attempts (`?path=../..`, dotfile,
  symlink-escape) still return 400/blocked exactly as before.

### 3. Interaction / visual checks (Playwright — use the `playwright-skill`)

- **T9 — Click-to-render timing (R11):** script the Files-tab click, measure to
  first list paint via `performance` marks or Playwright timing → ≤ 200 ms on a
  typical dir. Record the number.
- **T10 — Cached re-visit (R12):** navigate away and back; confirm paint from
  cache and a revalidation (not a blocking fetch).
- **T11 — Virtualization (R13):** point the pane at the synthetic ≥1000-entry dir;
  assert rendered DOM row count ≪ entry count and scrolling is smooth (no long
  task > 200 ms in a trace).
- **T12 — BOTH themes (R21):** screenshot the Files pane with
  `document.documentElement.dataset.theme = 'dark'` AND `'light'`; a reviewer
  confirms legibility/consistency in each. Attach both screenshots to the task.
- **T13 — Behavior parity:** descend, breadcrumb-up, select, copy-path, attach,
  drag-to-composer, search, preview each type, download — each still works
  (R1–R10).
- **T14 — Error surfacing (R23):** force a bad listing (e.g. temporarily point at a
  non-existent path / bad root); confirm an explicit error row, not an empty folder.

### 4. Code review (adversarial where flagged)

- **T15 — Scope diff (R30):** `git diff --stat main...HEAD` — touched paths ⊆ the
  allowed set in `01-requirements.md`. Any stray file is a finding.
- **T16 — No silent fallback:** grep the diff for `.catch(() => [])`,
  `catch {}`, swallowed promises in the click path → none in new code.
- **T17 — Token discipline:** every color in the diff resolves to `tokens.*` /
  `var(--fg-*)`; new tokens exist in **both** palettes.

## QA gates per phase

| Phase | Gate to pass before the phase is "done" |
|---|---|
| P1 Profile | Baseline numbers (T5, and T9-style render timing) written into the corpus; no code changes to gate. |
| P2 Backend | T1 (forge-control tsc), T5, T6, T7, T8 all green; containment diff reviewed (T24/R24). |
| P3 List component | T2 (web tsc), T13 behavior parity, T11 virtualization smoke, T14 error surfacing; dep installed per R29. |
| P4 Theme | T4 (0 hardcoded colors), T12 (both-theme screenshots), T17 token discipline, T22/R22 (`!important` block gone). |
| P5 Perf verify + final review | T1, T2, T3, T9, T10, T11 re-measured; before/after timings recorded; T15 scope diff; adversarial review sign-off. |
| P6 Deploy | Post-merge: pm2 both online, `/api/health` 200, web app HTTP 200 on its port. |

## What the phase reviewer MUST run (non-negotiable checklist)

For any phase that touches code, the reviewer's report must include **pasted
output** of:

1. `cd forge-control && npx tsc --noEmit` (if backend touched)
2. `cd forge-control-web && npx tsc --noEmit`
3. `cd forge-control-web && pnpm build` (at least at P5)
4. `curl` timings against `/api/files/list` (both roots + one nested + the
   synthetic large dir at P5)
5. The hardcoded-color grep over the touched components (must be 0 at/after P4)
6. Playwright screenshots of the pane in **dark and light** (at/after P4)

A review that only *claims* these passed, without the output, is itself a
NEEDS_FIXES — re-run with evidence.

## High-risk phases → adversarial review

- **P3 (list replacement)** and **P5 (perf + final)** are the high-risk phases.
  Their planners MUST add a **red-team reviewer** briefed to *attack*, not merely
  check: try to break drag-out, selection persistence, breadcrumb edge cases
  (root boundary, deep paths, names with `/`-lookalikes), the error path, the
  synthetic large dir, and both themes at narrow panel widths. The red-team
  reviewer assumes the change is broken and must prove it isn't.
- **P4 (theme)** gets the standard reviewer plus the mandatory both-theme
  screenshot gate.

## Regression guards (things a fix must not break)

- Preview 40k truncation + fetch-cancel-on-unmount (R25).
- `/read` Range/206 streaming.
- `VPS_FILE_DRAG_MIME` export + payload shape (CanvasPane / useAttachments).
- `memo` on the panel (chat-render shielding).
- Security containment in `files.ts` (R24).
- Search semantics (debounce, scope, cap/truncated) (R8).
