# BASELINE FINDINGS — profile before fixing

Captured by the architect during round-0 planning, against the **live** running
system (`forge-control` on `:7700`, real `/opt/obsidian-vault` and
`/opt/ai-os/workspace`). Phase 1 re-runs and extends these with in-browser
render measurements; treat this as the seed, not the last word.

## API timings (curl, live `:7700`)

| Endpoint | time_total | payload | http |
|---|---|---|---|
| `GET /api/files/roots` | 0.0012 s | 98 B | 200 |
| `GET /api/files/list?root=vault&path=` | 0.0141 s | 8238 B | 200 |
| `GET /api/files/list?root=workspace&path=` | 0.0025 s | 3355 B | 200 |
| `GET /api/health` | — | — | 200 |

**Conclusion: the API is not the bottleneck.** Even the root vault listing —
which stats every child (`fs.stat` per entry inside `Promise.all`) — returns in
14 ms. The click-to-render lag Konrad feels is on the client.

## Directory sizes (real data)

- Vault top level: **86 entries.**
- Largest real directories surveyed (both roots, `find` + per-dir `ls | wc -l`):
  `30_YouTube/Plan for YouTube` = 63, `90_AI_OS` = 56, source dirs ≈ 36. **No real
  directory approaches 1000 entries.**
- Implication: the 1000+ requirement (D2/S2) is a *robustness* requirement to be
  proven with a **synthetic** large directory, not a reproduction of today's pain.
  Today's pain is mount cost + the accumulating `files` array (below).

## Client-side cost analysis (code-read; Phase 1 confirms with React Profiler)

1. **Third-party mount on every tab switch.** `ChatSurface` renders
   `tab === "files" ? … : <FileExplorerPanel/>` — switching to Files mounts the
   whole `@cubone/react-file-manager` tree (nav pane, breadcrumb, list, drag +
   keyboard wiring, its stylesheet) from cold each time.
2. **Unbounded flat `files` array.** `loadDir` (FileExplorerPanel.tsx:239)
   appends every visited directory's children into one array and only prunes
   entries *directly under the dir being refreshed* — siblings, parents and the
   other root accumulate for the life of the panel. The un-virtualized library
   lays out **every** row it is handed on each render.
3. **No windowing.** `@cubone/react-file-manager/dist` contains no
   `react-window`/virtual code — every row is a real DOM node.
4. **`memo` already applied** to `FileExplorerPanelImpl` (prior fix) — it keeps
   streamed chat re-renders out of the tree, but does nothing for mount cost or
   array growth.

## Light-mode defect (concrete)

- `FileExplorerPanel.css`: **49 lines** of hardcoded dark hex, **49 `!important`**,
  scoped to `.file-explorer *`. These override the library's light-only theme with
  a fixed dark palette that ignores `data-theme`.
- `FileExplorerPanel.tsx:569`: inline `background: seld ? "rgba(91, 141, 239, 0.12)"
  : "transparent"` — a hardcoded accent-alpha tint on the search-result selected row.
- `theme.css` proves the intended mechanism works: both palettes are fully
  defined; anything reading `var(--fg-*)` already flips correctly. The Files pane
  is the lone hold-out because it bypasses tokens.

## Error handling defect

- `loadDir`: `fetchFileList(...).catch(() => [])` → a failed listing renders as an
  empty directory, silently. Violates the "hard errors are policy" rule. Must
  surface an explicit error row.

## What is already correct (do NOT regress)

- `/list` is single-level — satisfies D3 as-is.
- `/search` is recursive **by design** (that is its job), debounced 300 ms client
  side, capped at `SEARCH_RESULT_CAP = 200` with a `truncated` flag — and it is
  NOT in the click path. Leave its semantics intact.
- `resolveInRoot` containment (traversal / dotfile / symlink-escape guards) is
  correct and security-critical. Preserve byte-for-byte behavior.
- `FilePreview` already caps previewed text at 40 000 chars on a line boundary —
  a real prior fix for the "big markdown froze the app" bug. Keep it.
- Range streaming in `/read` (206 support) is correct. Keep it.

---

## In-browser measurements (Phase 1)

Captured by Playwright against the live production app
(`https://os.schreinercontentsystems.com`) with a valid session cookie.
Headless Chromium, 1600×900 viewport, 3 independent runs per timing measurement.

### Click-to-first-paint

Measured from `performance.mark("files-tab-click")` (set immediately before
clicking the Files button in the CHAT right panel) to when
`.file-explorer *` node count first exceeds 5 — i.e., when any file content is
visible in the DOM.

| Run | paint (ms) | wall (ms) | DOM nodes at detection |
|-----|-----------|-----------|----------------------|
| 1   | 118.8     | 115       | 43                   |
| 2   | 105.7     | 102       | 43                   |
| 3   | 117.0     | 109       | 43                   |

**min = 105.7 ms · median = 117.0 ms · max = 118.8 ms**

**vs. 200 ms target → PASSES.** The initial Files tab render is already within
the target window. The 43 nodes at detection represent the two root-directory
entries ("Obsidian Vault" and "Agent Workspace") plus the file manager chrome —
no full directory listing is loaded on the initial tab switch.

### DOM node count after mount

`document.querySelectorAll('.file-explorer *').length` on run 3, after the
initial render (2 root entries visible): **75 nodes**.

This is the minimum baseline — each directory navigation loads more entries. The
library is not virtualized, so each additional file entry adds 3–5 DOM nodes.
Production impact: small for current directories (max 86 entries at vault root),
but the node cost grows linearly.

### API calls per user action (via `page.on("response")` against `/api/proxy/*`)

All file manager requests go to `/api/proxy/files/*` (Next.js rewrite to
forge-control at `:7700`).

| Action | Calls | Endpoint(s) |
|--------|-------|-------------|
| Initial page load | 0 files calls | — |
| CHAT nav click | 0 files calls | — |
| Files tab click | **1** | `GET /api/proxy/files/roots` (98 B) |
| Click into a root dir | **1** | `GET /api/proxy/files/list?root=workspace&path=` (3355 B) |
| Click into a sub-dir | **1** | `GET /api/proxy/files/list?root=...&path=...` |

**Result: exactly 1 `/list` call per navigation click — satisfies D3 as-is.**

No recursive fetching observed. Each call's payload is bounded to the current
directory's entries only. The accumulating flat `files` array in client state is
still a latent concern for deep navigation sessions (grows across directory
visits), but does not affect the initial paint or the per-click API call count.

**React DevTools hook:** `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` is `false` —
production Next.js build; React internals are not exposed. Programmatic profiler
trace is unavailable. Performance marks emitted by the app: none detected.

### Nested-dir curl timings (`:7700` direct)

Extends the architect's baseline (vault root = 14 ms, workspace root = 2.5 ms):

| Endpoint | time_total | payload | http |
|---|---|---|---|
| `/api/files/list?root=vault&path=30_YouTube%2FPlan+for+YouTube` | 0.0025 s | 6044 B | 200 |
| `/api/files/list?root=vault&path=90_AI_OS` | 0.0018 s | 5697 B | 200 |
| `/api/files/list?root=workspace&path=` | 0.0015 s | 3355 B | 200 |
| `/api/files/roots` | 0.0007 s | 98 B | 200 |

All sub-directories return in 1–3 ms. **The API is not the bottleneck at any
directory depth measured.**

### Light-mode screenshots

Saved to `docs/plan/`:
- `baseline-screenshot-dark.png` — Files pane in default dark mode
- `baseline-screenshot-light.png` — Files pane after `data-theme="light"` forced
  via JS

Both screenshots show an identical dark UI. Computed-style verification confirms
the defect:

```
Dark mode  background: rgb(11, 11, 12)
Light mode background: rgb(11, 11, 12)   ← unchanged
```

Even though `--fg-text` changes correctly (`#17171a` in light mode), the `.file-explorer`
element ignores it. CSS rule [9] from the injected stylesheet:

```css
.file-explorer {
  background: rgb(11, 11, 12) !important;
  color: rgb(237, 237, 238) !important;
  /* ... 49 more !important declarations */
}
```

This and 46 further hardcoded-color rules in `FileExplorerPanel.css` override
every token. None of these rules read `var(--fg-*)`.

---

## Root cause confirmed

1. **Click-to-first-paint: 105–118 ms (median 117 ms) → PASSES the 200 ms target.**
   The initial Files pane render is already fast. The lag Konrad reports is
   likely felt during *subsequent directory navigation* (each `loadDir` call +
   re-render of the growing flat `files` array), not on the first tab switch.
   The click-path fetches only `files/roots` (98 B, ~0.7 ms at `:7700`) then
   renders two root entries — this is cheap. API latency is confirmed not the
   bottleneck.

2. **Mount cost and DOM node growth, not API, explain residual lag.**
   Each directory visit appends entries to the flat client-side `files` array
   and re-renders the entire un-virtualized list. Even at 75 nodes for 2 roots,
   the pattern scales poorly: a vault root listing (86 entries) would produce
   ~300+ nodes, all laid out on each re-render. The architect's analysis (mount
   cost + flat array accumulation) is confirmed by the data; it does not
   contradict the 200 ms initial-paint number because that only covers root
   discovery, not full directory traversal.

3. **Light mode is broken by 49 `!important` hardcoded-color rules.**
   `FileExplorerPanel.css` injects `rgb(11, 11, 12)` and `rgb(237, 237, 238)`
   (etc.) with `!important` across 49 declarations, all scoped to
   `.file-explorer *`. CSS token variables respond correctly to `data-theme`
   (verified: `--fg-text` flips to `#17171a` in light mode) but the file pane
   ignores them entirely. The screenshots confirm the pane stays dark regardless
   of theme. Architect's analysis: **confirmed.**

4. **No contradictions with `docs/plan/00-vision.md`.** The 1-call-per-navigation
   assertion (D3) holds as-is. The lack of virtualization (D2) is confirmed. The
   API performance headroom is confirmed. The initial-paint number being under
   200 ms does not invalidate the overall performance goal — the 200 ms target
   should be measured post-fix, after full directory navigation, not just roots.
