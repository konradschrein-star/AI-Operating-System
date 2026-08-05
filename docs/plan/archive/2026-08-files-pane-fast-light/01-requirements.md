# 01 — Requirements

Every requirement is numbered and testable. The **Verify** column is the exact
check a reviewer runs. The **Phase** column maps each requirement to exactly one
phase (see `docs/plan/04-phases.md`); no requirement is unassigned or shared.

## Functional requirements

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| R1 | Clicking the **Files** tab renders the current directory's contents (names, dir/file distinction, size, mtime) for both roots (`vault`, `workspace`). | Manual/Playwright: open Files, see both roots; descend into a folder, see its children. | P3 |
| R2 | Folder navigation: activating a directory row descends into it and loads exactly that directory (one `/list` call, single-level). | Network panel / server log: one `/list` per descend; no recursive fetch. | P3 |
| R3 | A **breadcrumb** reflects the current path and each segment is clickable to jump back up the tree. | Descend 2+ levels; click a breadcrumb segment; list updates to that level. | P3 |
| R4 | **Selection**: clicking a file toggles it selected; the header shows the selected count; selection persists across navigation as it does today. | Select files; count updates; navigate; selection state behaves as before. | P3 |
| R5 | **Copy path** and **Attach** (when a chat is active) act on the current selection exactly as today, via `attachExistingFile` → `/api/files/attach`. | Select file(s), Copy path → clipboard has absolute VPS path(s); Attach → attachment registered. | P3 |
| R6 | **Drag-to-chat** still works: dragging a file row onto the composer registers the existing VPS path (mime `application/x-forge-vps-file`) with no re-upload. | Drag a row to composer; `useAttachments` drop path fires; `VPS_FILE_DRAG_MIME` payload intact. | P3 |
| R7 | **Preview** is unchanged in behavior: md/txt/json/csv (truncated at 40k on a line boundary), images, video, audio, pdf, and a download fallback for other types. | Open representative files of each type; preview matches current behavior. | P3 |
| R8 | **Search** is unchanged in behavior: ≥2 chars, 300 ms debounce, scoped to current folder or all roots at Home, files-only results, capped/`truncated` surfaced. | Type a query; results match current semantics; truncation banner appears past cap. | P3 |
| R9 | **Download** of a file remains reachable (row action or preview fallback link). | Trigger download; file streams via `/api/files/read`. | P3 |
| R10 | **Refresh** re-fetches the current directory (bypassing cache) and re-seeds roots at Home. | Click refresh; a fresh `/list` is issued; cache for that dir is replaced. | P3 |

## Non-functional requirements

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| R11 | **Click-to-first-paint ≤ 200 ms** on a typical (≤100 entry) directory. | Phase 1 baseline + Phase 5 re-measure via `performance.mark`/Profiler or Playwright timing. | P1 / P5 |
| R12 | **Cached re-visit paints < ~30 ms** — re-opening an already-seen directory renders from a client cache before any refetch. | Navigate away and back; measured paint from cache; network shows revalidation, not a blocking fetch. | P5 |
| R13 | **Virtualized/windowed rendering**: a directory of ≥1000 entries opens with no long task > 200 ms and scrolls smoothly. | Synthetic 1000+ dir; Performance profile shows windowed DOM (row count ≪ entry count), no long task. | P3 / P5 |
| R14 | **Bounded client state**: the list data model holds the current directory (plus a small bounded cache), not an unbounded accumulation of every visited directory. | Code review: no ever-growing global `files` array; cache has an explicit bound/eviction. | P3 |
| R15 | **The click path issues no recursive fetch** — only a single-level `/list`. | Server log/network: descend → exactly one `/list`, no `/search` or recursive walk. | P3 |
| R16 | **`/list` server cost is bounded** for large directories: dir/file distinction does not require an O(N) stat storm where a `Dirent` type suffices, and large listings are capped or paginated with a `truncated`/count signal. Containment semantics unchanged. | Read `files.ts`; time `/list` on a synthetic 2000-entry dir; confirm cap/pagination + preserved `resolveInRoot` behavior. | P2 |
| R17 | **`/list` sends an appropriate `Cache-Control`** so the client cache/browser can revalidate cheaply (short max-age or explicit revalidation contract). | `curl -I` the endpoint; header present and sane. | P2 |

## Color / theme requirements

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| R18 | **Zero hardcoded colors** in every touched Files component (`.tsx` and `.css`): no hex, `rgb(a)`, or `hsl(a)` literals. | `grep -nE '#[0-9a-fA-F]{3,8}\b\|rgba?\(\|hsla?\('` over touched files = 0 hits. | P4 |
| R19 | Every color reads a **design token** (`tokens.*` in TSX, `var(--fg-*)` in CSS). | Code review of the diff; all color props resolve to a token. | P4 |
| R20 | Any color a token doesn't yet cover (e.g. accent-alpha selection/hover tints) is added as a **new token to BOTH palettes** in `theme.css`, then consumed — never inlined. | New `--fg-*` vars exist in both `:root` and `html[data-theme="light"]`; used via `var()`. | P4 |
| R21 | The pane is **legible and visually consistent in BOTH themes** — surfaces, borders, text ramp, hover/selected states all correct in dark and light. | Playwright screenshots in `data-theme` dark AND light; reviewer confirms. | P4 |
| R22 | The obsolete `FileExplorerPanel.css` `!important` dark-override block is **removed** (or reduced to token-only rules), not left dormant. | File no longer contains hardcoded hex; `!important` count drops to 0 (or justified token-only). | P4 |

## Correctness / robustness requirements

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| R23 | **No silent error swallow** in the click path: a failed `/list` renders an explicit error row (message + retry affordance), never a silently-empty directory. | Force a 4xx/5xx (bad root); UI shows an error row; `console.error` logged. | P3 |
| R24 | **Security/containment unchanged**: `resolveInRoot` and its traversal/dotfile/symlink guards behave identically; no new root or arbitrary-path browsing introduced. | Diff review of `files.ts`; traversal attempts still 400; behavior byte-equivalent. | P2 |
| R25 | **Preview safety preserved**: the 40k-char line-boundary truncation and fetch-cancel-on-unmount in `FilePreview` remain. | Code review; open a large md file; no freeze, truncation banner shows. | P3 |

## Build / gate requirements

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| R26 | `npx tsc --noEmit` is clean in **`forge-control`**. | Run it; exit 0. | P2 / P5 |
| R27 | `npx tsc --noEmit` is clean in **`forge-control-web`**. | Run it; exit 0. | P3 / P5 |
| R28 | `pnpm build` passes in **`forge-control-web`**. | Run it; exit 0. | P5 |
| R29 | Any new dependency is installed with `NODE_ENV=development pnpm add <pkg> --prod=false` (never plain `npm install`), and is React 19 / Next 15 compatible. | `git diff` of `package.json`/lockfile; install method in the task log. | P3 |
| R30 | The diff stays **focused on the Files experience** — no drive-by edits outside the files pane, its API routes, its client helpers, and the theme-token files it strictly needs. | Diff review: touched paths ⊆ the allowed set (see below). | all |

### Allowed touched-path set (R30 guardrail)

- `forge-control-web/app/desktop/chat/FileExplorerPanel.tsx`
- `forge-control-web/app/desktop/chat/FileExplorerPanel.css` (delete/trim)
- **New** `forge-control-web/app/desktop/chat/VaultFileList.tsx` (+ optional `.css`)
- `forge-control-web/app/theme.css` (new tokens only, both palettes)
- `forge-control-web/app/tokens.ts` (map new tokens only)
- `forge-control-web/app/api.ts` (only if a client signature must change — avoid if possible)
- `forge-control/src/routes/files.ts`
- `forge-control-web/package.json` + lockfile (only if a dep is added)
- `docs/plan/**` (planning corpus; architect-owned)

Anything outside this set is a scope violation unless a phase explicitly justifies
it in writing and the reviewer signs off. `DesktopApp.tsx` and `app/desktop/live/`
are off-limits (N1). `forge-executor` is never touched (N6).
