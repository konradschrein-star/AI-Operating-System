# Surface boundary audit — aios-divider-visibility, round 1

Every panel boundary across all 19 desktop surfaces (`SURFACES` in
`forge-control-web/app/desktop/nav-items.ts`), read directly from source —
`grep` for `width:\s*[0-9]` / `position:\s*"fixed"|"absolute"` across each
surface component, then read in context to classify. Global boundary (applies
to every surface): the **DesktopApp nav rail** split
(`LeftRail`, `useResizablePanel` in `DesktopApp.tsx:174`) — already resizable,
measured in `separator-probe-evidence.md`.

**No code was converted or restyled in this round** — this is an audit only,
per this round's declared write-set (the two markdown files in this
directory). Items marked "candidate" are exactly that: identified, not
converted. A future round should treat this list as its starting point.

## Already resizable (use `useResizablePanel`/`ResizeHandle`)

| Surface | Boundary | File:line |
|---|---|---|
| chat | chat list ↔ open thread | `ChatSurface.tsx:225` (`panel`) |
| chat | thread ↔ CanvasPane (when canvas open) | `ChatSurface.tsx:655` (`canvasSplit`) |
| chat | thread ↔ Team panel | `ChatSurface.tsx:640` (`rail`) |
| chat (ChatTeamPanel) | team tree ↔ PLAN doc tree | `team/ChatTeamPanel.tsx:309` |
| chat (CanvasPane) | Excalidraw canvas ↔ plan drawer (when a drawing + plan panel are both open) | `CanvasPane.tsx:297` (`planPanel`) — not reached this round, see probe evidence |
| library | run/artefact list ↔ preview pane | `LibrarySurface.tsx:184` (`masterPanel`) |
| autonomy | category rail ↔ detail | `AutonomySurface.tsx:243` (`railPanel`) |
| journal | retro deck ↔ mentor panel (desktop width only, `!isNarrow`) | `JournalSurface.tsx:84` (`journalSplit`) |
| *(global)* | left nav rail ↔ everything else | `DesktopApp.tsx:174` (`navRail`) |

All 8 (7 per-surface + 1 global) were measured live in
`separator-probe-evidence.md`: 1px painted at rest, restrained
`tokens.borderEmphasis` on hover, 11px grab target, 0px layout-footprint
delta, and (after this round's fix) still 1px painted after a hover cycle
completes.

## Fixed-width boundaries NOT yet resizable — conversion candidates

Real two-pane (or three-pane) fixed-width layouts where a user would
plausibly want to trade space, exactly the shape `useResizablePanel` already
serves elsewhere. None converted this round — listed for a future round to
pick up.

| Surface | Boundary | Fixed width | File:line |
|---|---|---|---|
| inbox | triage rail ↔ message detail | 380px | `InboxSurface.tsx:457` |
| tasks (ProjectsSurface) | project rail ↔ board/detail | 260px | `ProjectsSurface.tsx:374` |
| skills | category rail ↔ list | 200px | `SkillsSurface.tsx:200` |
| skills | list ↔ detail panel | 420px | `SkillsSurface.tsx:557` |
| memory | left rail (counts/folders) ↔ note list | 210px | `MemorySurface.tsx:544` |
| memory | note list ↔ note/graph view | 340px | `MemorySurface.tsx:847` |
| control | main content ↔ Invariant Engine / Decision Stream sidebar | 330px | `ControlSurface.tsx:1189` |
| settings | section rail ↔ section content | 184px | `settings/SettingsSurface.tsx:93` |

That's **8 real candidate boundaries across 6 surfaces**. All follow the same
shape as the already-converted surfaces (a `flex:"none"; width:<N>` panel
beside a `flex:1` sibling inside a `display:"flex"` row) — a mechanical
conversion, not a design decision, when someone picks this up.

## Deliberately NOT candidates (checked, excluded, and why)

| Surface | What was found | Why it's excluded |
|---|---|---|
| tasks (ProjectsSurface) | Kanban `RoleColumn`s, 240px each | Horizontally-scrolling board columns (like Trello), not a two-pane split with a single boundary to trade space across — there is no adjacent flex sibling losing space when one grows. |
| money | 320px "Claude limit hits" panel | `position: "absolute"` popover anchored to a button, not an in-flow panel — matches the existing exclusion pattern for overlay/backdrop content (see `resizable-split-excludes-overlay-drawers` precedent: `JobDetailDrawer.tsx`, `MapInspectorDrawer.tsx`). |
| map | `MapInspectorDrawer.tsx` / `.map-drawer-overlay` | Same overlay-drawer exclusion, already documented from a prior project round — re-confirmed still true this round (still `position: fixed`/`absolute` with a backdrop, no adjacent in-flow content that would reflow). |
| map | `.mindmap-search` input, 240px (`MapSurface.css:191`) | A search input's fixed width, not a panel boundary. |
| automation | modal dialog overlay (`modalOverlay`, `position: "fixed"`) | Centered modal with backdrop, not an in-flow split. |
| automation | various 80–160px widths | Skeleton-loading placeholder blocks (`SkeletonRoutineCard`/`SkeletonWebhookCard`) and small form-field widths, not panel boundaries. |
| today | 140px/280px/64px widths | Skeleton-loading placeholder blocks inside a loading state, not real panels. |

## No boundary exists at all (single-column / dashboard layouts)

Checked for a `display:"flex"` row pairing a fixed-width panel with a
flex-sibling, at the surface's own top level. None found — these render as a
single scrolling column, a card grid, or a feed, with no second pane to trade
space against:

- **today** — briefing cards, single column.
- **pipeline** — job list, single column.
- **businesses** — inventory cards, single column.
- **live** — status feed, single column.
- **goals** (GOALS/TASKS) — icon-button toolbar + single content column.
- **search** — not a `NAV` entry at all (confirmed in `nav-items.ts`'s own
  comment: "`search` is deliberately absent: it is not a NAV entry, and its
  backend is built and live"); reached via the top-strip search bar/modal,
  not a rail destination, so it has no desktop-shell panel boundary to audit.

## Coverage check

19 `SURFACES` entries in `nav-items.ts`: today, inbox, chat, tasks, pipeline,
library, money, businesses, skills, memory, live, control, autonomy,
automation, goals, journal, map, search, settings.

| Surface | Status |
|---|---|
| today | no boundary (single column) |
| inbox | candidate (380px rail) |
| chat | resizable ×4 (list↔thread, thread↔canvas, thread↔team, team tree↔PLAN) |
| tasks | resizable? **no** — candidate (260px rail); Kanban columns excluded |
| pipeline | no boundary (single column) |
| library | resizable (master/detail) |
| money | no candidate — only an excluded overlay popover |
| businesses | no boundary (single column) |
| skills | candidate ×2 (200px rail, 420px detail) |
| memory | candidate ×2 (210px rail, 340px middle column) |
| live | no boundary (single column) |
| control | candidate (330px sidebar) |
| autonomy | resizable (category rail) |
| automation | no candidate — only excluded overlay/skeleton widths |
| goals | no boundary (single column) |
| journal | resizable (retro/mentor split) |
| map | no candidate — only an excluded overlay drawer |
| search | not a NAV surface — no shell boundary to audit |
| settings | candidate (184px rail) |

All 19 accounted for. 9 boundaries already resizable (8 per-surface + the
global nav rail), 8 real candidates across 6 surfaces, the rest either have
no two-pane structure or are correctly-excluded overlays/skeletons.
