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
- **No native drag-out.** The library doesn't support dragging a row out of
  its own panel to an external drop target (confirmed by the research pass).
  Built an explicit "attach to chat" button on the current selection
  instead of fighting the library's DOM for a drag gesture it doesn't
  expose hooks for.
- **Not a separate top-level nav surface.** Lives inside Chat as a tab next
  to Live, not a new "Files" nav item — the ask was specifically about
  referencing files *in a session*, and this keeps "attach to the currently
  open thread" trivial (same component tree) instead of needing
  cross-surface state.
- **Two roots only** (vault, workspace) for now. Per-project workspace dirs
  (dynamic git worktrees under the Projects pipeline) aren't included —
  natural follow-up once that's wanted.
