# VPS file explorer

**Status:** approved, executed directly (Konrad: "B and let's go")
**Date:** 2026-07-11

## Motivation

Konrad wants the AI OS to be his primary development environment — right now
referencing a file the agent wrote (a markdown note, a rendered video, a
generated doc) means downloading it or asking the agent to paste contents
inline. Wants to browse VPS files directly in the web UI and pull one into a
chat as context without a local round-trip.

## Decision

Researched two approaches (standalone self-hosted file-manager service vs. a
React component built into the existing Next.js app). Went with the React
component: the two things that actually matter — attach a file into chat, and
match the existing dark UI — are same-DOM operations for a React component
and awkward across an iframe boundary for a standalone service. Picked
`@cubone/react-file-manager` (actively maintained, `filePreviewComponent`
render-prop for custom previews) over the better-known Chonky (drag-and-drop
native, but the maintained fork is a fork of an otherwise-dead project).

## What shipped

- **Backend** (`forge-control/src/routes/files.ts`): two named roots
  (`vault` = Obsidian vault, `workspace` = the shared coding-agent
  workspace) — never an arbitrary filesystem path. `GET /roots`,
  `GET /list`, `GET /read` (HTTP Range support for video/audio scrubbing,
  same technique as the existing `routes/media.ts`), `POST /attach`.
  Path containment reuses `lib/vault.ts`'s resolve-and-check technique,
  plus a realpath check to catch a symlink escaping the root.
- **Frontend**: `FileExplorerPanel.tsx`, a tab in the same collapsible
  right-hand panel the Live projects board already lives in (`SidePanel`
  now owns collapse + tab state; `LiveProjectsPanel` became
  `LiveProjectsBody`, chrome-free). Two virtual top-level folders (Vault,
  Workspace) merged into one flat tree, populated lazily per-directory.
  Custom previews: markdown (reuses `MessageMarkdown`), image, video, audio,
  PDF (`<iframe>`), else a download link — no inline docx viewer, download
  only, per Konrad's call.
- **Attach-to-chat**: `useAttachments()`'s state was lifted from `ChatThread`
  up to `ChatSurface` (passed down as a prop) so the file panel — a sibling,
  not a child — can reach the active thread's composer directly.
  `attachExistingFile()` registers the VPS path as an attachment with zero
  copy/re-upload; `addExisting()` pushes it into the same attachment state
  the drag-drop/paste paths already use, so the composer needs no
  special-casing.

## Scope decisions (disclosed, not silent)

- **Read-only.** No create/rename/delete/move/copy — browsing + download +
  attach only. All wired as `permissions={false}` on the component; no
  server-side mutation endpoints exist yet.
- **Not a separate top-level nav surface.** Lives inside Chat as a tab next
  to Live, not a new "Files" nav item — the ask was specifically about
  referencing files *in a session*, and this keeps "attach to the currently
  open thread" trivial (same component tree) instead of needing
  cross-surface state.
- **Two roots only** (vault, workspace) for now. Per-project workspace dirs
  (dynamic git worktrees under the Projects pipeline) aren't included —
  natural follow-up once that's wanted.

## 2026-07-11 revision — browsing was broken, plus native drag + restyle

First-use feedback: browsing didn't work at all (every folder showed "This
folder is empty"), the panel was unstyled (library ships a light-only
theme, unreadable against the app's dark UI), and Konrad wanted real
drag-and-drop onto the composer instead of only the select+button flow.

- **Root cause of the empty-folder bug:** `@cubone/react-file-manager`
  derives a folder's children by requiring `path === parentPath + "/" +
  name` — a node's own path must end with its own name. The two root nodes
  used the short API key as `path` (`/vault`) but the human label as `name`
  ("Obsidian Vault"), so the equality check never matched and the root
  view was permanently empty. Fixed by making root nodes use the label for
  *both* (`path: "/Obsidian Vault"`), with `splitVirtualPath()` resolving
  the label back to the API's short root key via the fetched roots list.
- **Dark theme:** added `FileExplorerPanel.css`, a `!important`-heavy
  override sheet targeting the library's hardcoded class names (verified
  against the actual rendered DOM, not just the library's minified source).
  Colors are copied from `tokens.ts`, not invented.
- **Native drag-out onto the composer, reversing the earlier "no native
  drag-out" call.** The library only sets the native `draggable` attribute
  on rows when `permissions.move` is on — that's its own internal
  move-between-folders feature, which we don't want (no backend mutation
  endpoint exists). We enable `permissions.move: true` *solely* to get the
  native `draggable` attribute, but never wire `onPaste`/`onCut`, so the
  internal move/cut-paste stays fully inert — the only visible side effect
  is a "Cut"/"Paste" affordance in the context menu and a transient toolbar
  pill mid-drag that does nothing if clicked. A delegated `dragstart`
  listener on the panel container reads the row's `title` attribute (the
  library always sets it to the file name), resolves it against the
  panel's own `files` state to get `{root, rel}`, and sets that as a custom
  `application/x-forge-vps-file` DataTransfer payload. `useAttachments`'s
  `dropHandlers.onDrop` reads that payload (alongside the existing native
  `Files` handling for OS drag-and-drop) and calls the same
  `attachExistingFile` + `addExisting` path the button already used — no
  new attach mechanism, just a second way to trigger it.
- **Nav pane collapsed by default** (`defaultNavExpanded={false}`,
  `collapsibleNav`) — the library's dual-pane layout doesn't fit a ~420px
  sidebar; root labels ("Obsidian Vault") were truncating unreadably.
  Still user-togglable via the library's own expand control.
- **Added:** a per-folder name filter (client-side, over the already-loaded
  directory listing) and a working refresh button (`onRefresh` was never
  wired before, so the visible refresh icon did nothing).
