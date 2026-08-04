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
