# Plan: aios-layout-adjustability

## Recommendation

Convert exactly three remaining fixed splits to the shared `useResizablePanel` /
`ResizeHandle` primitive (`forge-control-web/app/desktop/_ui/ResizableSplit.tsx`),
and explicitly leave two look-alike candidates alone. Everything else in the
desktop console that looked like a candidate is either already wired
(ChatSurface's nav rail, side panel, chat↔canvas split; ChatTeamPanel's
tree↔PLAN split; LibrarySurface's master↔detail split) or is decorative
chrome (1px row separators, badges, modal max-widths, table column widths)
that the brief itself says must NOT become a splitter.

## Convert (3)

1. **`CanvasPane.tsx` plan drawer** (~line 1101) — Excalidraw canvas ↔
   structured-plan drawer. Currently `width: 520, minWidth: 380, maxWidth:
   "50vw"` on a `borderLeft` div, in-flow flex sibling of the canvas. Real
   zone boundary — Konrad will want more canvas when sketching, more drawer
   when reading a long plan.
   - New `forge-control-web/app/desktop/canvas-plan-split.ts`:
     `CANVAS_PLAN_KEY = "forge.layout.canvas.planDrawer"`,
     `CANVAS_PLAN_INITIAL = 520`, `CANVAS_PLAN_MIN = 380`, `CANVAS_PLAN_MAX = 820`.
   - `useResizablePanel({ axis: "x", unit: "px", invert: true })` — handle
     sits on the drawer's left edge, so dragging left must grow it (same
     `invert` reasoning as ChatSurface's side panel).
   - Keep `maxWidth: "50vw"` in the inline style as a secondary CSS clamp for
     ultra-narrow viewports; the JS `max` is the primary bound.

2. **`AutonomySurface.tsx` category rail** (~line 366) — fixed `width: 220`
   `borderRight` rail ↔ rules/trips content, in-flow flex row. Real zone
   boundary — category labels can run long.
   - New `forge-control-web/app/desktop/autonomy-rail-split.ts`:
     `AUTONOMY_RAIL_KEY = "forge.layout.autonomy.categoryRail"`,
     `AUTONOMY_RAIL_INITIAL = 220`, `AUTONOMY_RAIL_MIN = 160`,
     `AUTONOMY_RAIL_MAX = 420`.
   - `axis: "x", unit: "px", invert: false`.

3. **`JournalSurface.tsx` retro↔mentor split** (~line 404) — `flex: "1 1
   55%"` / `"1 1 45%"` with a `borderRight` divider between
   `JournalRetrospectivePane` and `MentorAgentDeck`, only when `!isNarrow`.
   Real zone boundary — reflection vs. mentor-chat time genuinely varies.
   - New `forge-control-web/app/desktop/journal-split.ts`:
     `JOURNAL_SPLIT_KEY = "forge.layout.journal.split"`,
     `JOURNAL_SPLIT_INITIAL = 0.55`, `JOURNAL_SPLIT_MIN = 0.35`,
     `JOURNAL_SPLIT_MAX = 0.70`.
   - `axis: "x", unit: "fraction", invert: false`. Only rendered when
     `!isNarrow` — the narrow single-column tab view is untouched.

Each new `*-split.ts` module mirrors `team/plan-split.ts`: numbers only, no
JSX, so a `node:test` file can import the constants directly and assert
`min < initial < max` without pulling in React.

## Deliberately NOT converted

- **`JobDetailDrawer.tsx`** (`maxWidth: 680`) and **`MapInspectorDrawer.tsx`**
  (`.map-drawer { width: 440px }`) — both are `position: fixed/absolute`
  overlays with a click-to-dismiss backdrop and a slide-in animation, not
  in-flow flex siblings. There is no second pane whose space they trade
  against; resizing them would change nothing about the content behind them.
  That is a different interaction pattern than every existing split in this
  primitive (all trade space with a sibling), so it does not belong in this
  pass. Flagging in case Konrad disagrees.
- **`LiveSurface.tsx` `AgentActivity`** (`minHeight: 280, maxHeight: 460`) —
  a bounded card inside a scrolling page, not a boundary between two
  panes that share a fixed parent height.
- **`SettingsSurface.tsx` nav** (`width: 184`) — a narrow icon+label list
  that doesn't reflow with more width; negligible benefit, and the brief
  is explicit that not every fixed width qualifies.
- Every `TeamRow.tsx` column width, `MediaDocumentViewer` toolbar chrome,
  goals/journal card `minHeight`s, and all 1px `borderTop`/`borderBottom`
  row separators — decorative, exactly the class the brief says to leave
  alone.

## Rejected alternative

Converting the two overlay drawers anyway "for consistency" — rejected:
`invert` and the min/max-vs-sibling-space model in `ResizableSplit` assume a
pane trading space with a flex neighbor; retrofitting that onto a
backdrop-modal would be the second kind of judgement call the brief warns
against (a plausible-looking guess at an interaction model nobody asked for).

## Evidence plan

Per the brief, a screenshot proves nothing here (a rail looks identical
whether its divider drags or not). Two proofs per split, matching
`team-plan-splitter.test.ts`'s precedent:

1. **Source assertions** (`forge-control/src/lib/layout-splits.test.ts`):
   each surface file imports `useResizablePanel`/`ResizeHandle` from
   `_ui/ResizableSplit`, calls it with the right `storageKey`/`axis`/`unit`/
   `invert`, and the numeric bounds satisfy `min < initial < max`. Also a
   repo-wide grep that no second `onPointerDown`-driven drag implementation
   exists outside `_ui/ResizableSplit.tsx`.
2. **Measured pixel delta**: a throwaway `next build && next start` on a
   spare port inside this worktree (never `/opt/forge-ai-os`), driven by
   Playwright/`scripts/research-browser.mjs`, dragging each of the three new
   handles a known pointer distance and reading the panel's
   `getBoundingClientRect()` before and after. The delta is written into
   `docs/plan/artifacts/aios-layout-adjustability/pixel-delta-evidence.md`
   with the exact before/after numbers per split — not "it moved."

## Task graph

All three conversions touch disjoint files with no contention, so they stay
in the single `main` workstream (no worktree-merge overhead for work this
small). Six tasks, one round of parallelism among the three converters:

1. builder/standard — CanvasPane plan-drawer split
2. builder/standard — AutonomySurface category-rail split
3. builder/standard — JournalSurface retro↔mentor split
4. builder/junior — source-assertion + bounds tests for all three (depends on 1,2,3)
5. builder/junior — measured pixel-delta evidence doc for all three (depends on 1,2,3)
6. reviewer/standard — reviews the whole diff (depends on 1,2,3,4,5)
