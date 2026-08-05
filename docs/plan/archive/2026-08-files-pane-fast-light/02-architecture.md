# 02 — Architecture

## Recommendation (first)

**Replace the third-party `@cubone/react-file-manager` list surface with a small,
purpose-built, virtualized, token-native component — `VaultFileList` — that we
fully own. Keep everything already ours (preview, search, attach, drag-out, the
secure backend) unchanged.**

That single move removes *both* root causes at once:

- **Light mode** becomes correct by construction: our JSX reads `tokens.*` and any
  component CSS reads `var(--fg-*)`, so the pane flips with `data-theme` like the
  rest of the app. The 49-line `!important` shadow-palette in
  `FileExplorerPanel.css` is deleted, not patched.
- **Lag** goes away: we render a **windowed** list (row count ≪ entry count) over a
  **bounded per-directory data model** with a small client cache, instead of
  mounting a heavy third-party tree over an ever-growing flat array.

### Reasoning

1. The library is the *single common cause* of both defects. Fixing light mode by
   tokenizing its CSS would leave a fragile 49-line `!important` layer we must keep
   in sync forever; fixing lag inside it is impossible because it has no windowing
   and re-derives a folder's children from the full flat array we hand it.
2. Owning the list makes "zero hardcoded colors" **structural** rather than a
   grep-and-chase. Tokens are the default, not an override.
3. Real directories are ≤86 entries and the API answers in 1–14 ms (see
   `BASELINE-FINDINGS.md`), so the replacement component is genuinely small: a
   virtualized fixed-row list, folder-descend, a breadcrumb, selection, and
   drag-out. The hard, security-sensitive parts (preview, search, attach,
   containment) are already ours and stay put.
4. The blast radius is controlled: the swap is confined to the `<FileManager>`
   list/nav/breadcrumb surface plus its CSS. Public contracts
   (`VPS_FILE_DRAG_MIME`, `onAttach`, the `api.ts` client, `files.ts`) are unchanged.

### Rejected alternatives (one line each)

- **Tokenize the library's CSS + cap the rows fed to it** — keeps a brittle 49-line
  `!important` shadow palette and can't truly virtualize; capping is hacky because
  the library derives children by prefix from the whole flat array.
- **Fork `@cubone/react-file-manager` to add windowing** — an unowned upstream
  surface, slow to do well, over-scoped for a single-operator tool.
- **Keep the library, fix only light mode, accept the lag** — fails the perf DoD
  (D1/D2) outright.
- **Swap in a different heavyweight file-manager lib** — trades one opaque
  dependency and its theming assumptions for another; no better on virtualization
  or tokens, and a larger integration risk overnight.

## Components (after the change)

```
ChatSurface.tsx  (SidePanel: Live | Files tabs — UNCHANGED except it still
  │                renders <FileExplorerPanel/> for the Files tab)
  └── FileExplorerPanel.tsx        ← owns navigation + selection + cache state
        ├── header (search input, selected count, copy-path, attach)  [tokens]
        ├── VaultFileList.tsx      ← NEW: virtualized list + breadcrumb  [tokens]
        │     (folder-descend, selection toggle, drag-out, error/empty rows)
        ├── SearchResultsList      ← OURS today, kept; tokens audited
        └── FilePreview            ← OURS today, kept; tokens audited

forge-control/src/routes/files.ts  ← /list hardened (bounded, Cache-Control);
                                       containment UNCHANGED
app/theme.css + app/tokens.ts      ← new accent-alpha tint tokens (both palettes)
```

### What owns state

`FileExplorerPanel` is the single owner of navigation and selection state:

- `currentRoot: string | null`, `currentRel: string` — the location (null root =
  virtual Home showing the root list). Replaces today's ambiguous `currentPath`
  string parsing where practical; a `currentPath` virtual string may be retained
  internally if it simplifies breadcrumb/search reuse, but the source of truth is
  root+rel.
- `entries: DirEntry[]` — **only the current directory's** children (bounded).
- `cache: Map<string, { entries: DirEntry[]; ts: number }>` keyed by
  `${root}::${rel}`, with an explicit small bound (e.g. keep ≤ 32 most-recent dirs,
  evict oldest). This is the fix for R14 (no unbounded array).
- `selected: DirEntry[]`, `query`, `searchResults` — as today.

`VaultFileList` is **presentational + virtualization only**: given `entries`,
`loading`, `error`, `selected`, and callbacks (`onDescend`, `onToggleSelect`,
`onBreadcrumb`, `onDragOutPayload`), it renders a windowed list and a breadcrumb.
It owns no fetch logic.

### What dispatches work

- **Navigate:** `onDescend(entry)` → panel computes new `(root, rel)` → `loadDir`.
- **`loadDir(root, rel)`:** check `cache`; if hit, render immediately
  (stale-while-revalidate); always issue one `api.fetchFileList(root, rel)`; on
  success update `entries` + `cache`; on error set `error` state.
- **Breadcrumb click:** `onBreadcrumb(index)` → derive `(root, rel)` → `loadDir`.
- **Refresh:** delete the cache entry for `(root, rel)` → `loadDir` (forced).
- **Search:** unchanged effect — debounced, scoped, calls `api.searchFiles`.
- **Roots (Home):** `loadRoots()` seeds the root list (as today).

The click path for D3/R15 is therefore exactly: `onDescend → loadDir → one
/list`. No recursion, no per-navigation stat storm on the client.

### Data model

```ts
interface DirEntry {          // one row; mirrors /api/files/list entry shape
  name: string;
  isDir: boolean;
  size?: number;              // undefined for dirs
  mtime: string;              // ISO
}
```

`/api/files/list` already returns `{ root, path, entries: {name,isDir,size,mtime}[] }`.
Phase 2 adds a bounded/paginated form (see below) but keeps this entry shape, so
the client change is additive.

### Interfaces (unchanged contracts)

- `api.ts`: `fetchFileRoots`, `fetchFileList`, `searchFiles`, `fileReadUrl`,
  `attachExistingFile` — signatures preserved. (If Phase 2 adds pagination params,
  extend `fetchFileList` with optional args; do not break existing callers.)
- `VPS_FILE_DRAG_MIME` export stays (imported by `CanvasPane.tsx` and read by
  `useAttachments`). The drag-out payload stays `JSON.stringify({root, rel})`.
- `onAttach: ((file: UploadedFile) => void) | null` prop stays.
- `filePreviewComponent` / `FilePreview` contract stays (rendered when a file row
  is activated for preview).

### Technology choices (with one-line rationale)

- **Virtualization: `@tanstack/react-virtual`** — headless, ~tiny, React 19
  compatible, battle-tested; we keep full control of row markup and tokens.
  *Fallback if a React-19 peer issue appears:* a hand-rolled fixed-row-height
  windowed list (~40 lines: `scrollTop` + container height → visible range), zero
  deps. Rows are uniform height, so either approach is simple. Install per R29:
  `NODE_ENV=development pnpm add @tanstack/react-virtual --prod=false`.
- **Client cache: a plain bounded `Map`** — boring, explicit, no library. Stale-
  while-revalidate gives instant re-visits (R12) while staying correct on change.
- **Tokens: existing `tokens.ts` / `theme.css`** — no new theming mechanism; add
  accent-alpha tint tokens to both palettes (R20).
- **Backend `/list` hardening: `fs.readdir(abs, { withFileTypes: true })`** for the
  dir/file bit without a stat, then stat only as needed for size/mtime (or lazily);
  cap/paginate very large listings. Rationale: kill the O(N) stat storm on huge
  dirs while preserving the current entry shape and containment.

### Backend `/list` hardening (Phase 2 detail)

Current `/list` does `readdir` then `fs.stat` for **every** child inside
`Promise.all` — fine at 86 entries (14 ms), an O(N) syscall storm at thousands.
Plan:

1. Use `fs.readdir(abs, { withFileTypes: true })` to get `isDirectory()` from the
   `Dirent` without a per-entry stat. **Caveat:** `Dirent.isDirectory()` does not
   follow symlinks, whereas today's `fs.stat` does. To preserve behavior for a
   symlinked directory, `stat` only entries whose `Dirent` is a symlink
   (`d.isSymbolicLink()`), not all entries. Document this explicitly.
2. `size`/`mtime` still need a stat. Options, in order of preference:
   (a) keep statting for these but only after the (cheap) type pass, and **cap** the
   number of entries returned (e.g. `LIST_CAP`, default ~1000) with a `truncated`
   flag + total count, so a pathological dir never stats unbounded; or
   (b) add `limit`/`offset` query params for true pagination. Given real dirs are
   tiny, a cap with a `truncated` signal (mirroring `/search`) is the boring,
   sufficient choice; pagination is optional if the reviewer wants it.
3. Sort order unchanged (dirs first, then name, `localeCompare`).
4. Add `Cache-Control: private, max-age=<small>` (e.g. 5–10 s) to `/list` (R17) so
   revalidation is cheap; the client cache remains the primary fast path.
5. **Containment untouched** (R24): `resolveInRoot`, dotfile/traversal/symlink
   guards behave identically. Only the listing/stat strategy changes.

### Failure modes — and how Konrad sees it broke

| Failure | Behavior (hard-error policy) | Visibility |
|---|---|---|
| `/list` 4xx/5xx or network error | Panel sets `error` state; **no** silent `[]` | Explicit error row in the list: "couldn't load <dir> — <msg>" + a retry/refresh affordance; `console.error` |
| `/list` truncated (huge dir) | Render the capped page, windowed | A "showing first N of M — narrow or paginate" banner (like search's truncation banner) |
| Preview fetch fails | `FilePreview` shows "(failed to load)" (already) | In-preview message (unchanged) |
| Search error per scope | That scope resolves to empty; others still show | Result count reflects it; no crash (unchanged) |
| Attach/copy-path resolve fails | Skips the unresolved file (unchanged), never throws | Count/clipboard reflect only resolved files |
| New dep peer conflict at install | Build fails loudly at Phase 3/5 gate | `pnpm build`/`tsc` non-zero; fallback = hand-rolled windowing |

The guiding rule: **no silent fallback.** The current `loadDir`
`.catch(() => [])` is explicitly removed (R23).

### How progress/state is observable during the build

- The planning corpus (`docs/plan/**`) is committed on the work branch;
  progress is visible on GitHub if `origin` exists.
- Each phase is a task on the forge-control Kanban (`/api/projects/.../tasks`),
  visible in the Live panel; rounds gate ordering.
- Phase 1 writes measured baselines and Phase 5 writes before/after timings into
  the corpus, so the perf claim is auditable, not asserted.

## Integration points to preserve (do not break)

1. `CanvasPane.tsx` imports `VPS_FILE_DRAG_MIME` from `FileExplorerPanel` — keep
   the export in that module (re-export from `VaultFileList` if the constant moves).
2. `useAttachments` drop handling reads the `application/x-forge-vps-file`
   dataTransfer payload — keep the payload shape `{root, rel}` (today: the result of
   `splitVirtualPath`). The new list can set it directly from `(root, rel)` without
   the virtual-path round-trip.
3. `ChatSurface` renders `<FileExplorerPanel onAttach={…}/>` — keep this signature;
   the swap is internal to the panel.
4. `memo(FileExplorerPanelImpl)` — keep the memo; it still shields the tree from
   chat re-renders.

## Open decisions left to the phase planners (bounded)

- Whether to keep an internal `currentPath` virtual string for breadcrumb/search
  reuse or fully switch to `(root, rel)` — either is fine as long as R2/R3/R8 hold.
- `@tanstack/react-virtual` vs hand-rolled windowing — planner picks based on a
  quick React-19 peer check; both satisfy R13. Prefer the library unless it fights
  the peer set.
- `/list` cap vs true pagination — cap+`truncated` is the default; pagination is an
  allowed upgrade if the reviewer wants it (R16).
