# Pixel-delta evidence — three new `ResizableSplit` conversions

Project `aios-layout-adjustability`, round 1. Branch `project/f75101a5`.

A screenshot cannot prove a splitter drags — a rail looks identical whether
its divider is live or inert (that is literally how this shipped inert
twice). Every number below comes from a real Playwright pointer drag against
a running build of this worktree, reading `getBoundingClientRect()` before
and after via `Element.previousElementSibling`/`nextElementSibling` off the
handle itself, and a real double-click to prove the reset path.

## Setup

- `cd forge-control-web && pnpm install --frozen-lockfile --prod=false` (tsc
  and next were already present; confirmed `./node_modules/.bin/tsc
  --version` → `5.7.2`).
- `npm run build` → clean (`✓ Compiled successfully`, `/desktop` in the route
  table). No `.env.local` in this worktree, so `next.config`'s
  `FORGE_CONTROL_URL` default (`http://127.0.0.1:7700`, the live
  forge-control API) applied — a sanctioned read-only GET target for
  `/api/proxy/*`, not a write to `/opt/forge-ai-os`.
- Started a throwaway server: `AUTH_URL=http://127.0.0.1:7912 AUTH_SECRET=<live
  secret, read-only> ./node_modules/.bin/next start -p 7912` (7912 was free —
  checked `ss -ltn` first). Never touched `pm2`, `:7700`, or `:7701`.
- Auth: minted a next-auth v5 session JWT locally (`next-auth/jwt`.`encode`,
  `salt:"authjs.session-token"`, `secret` = the live `AUTH_SECRET`, matching
  the documented recipe in `docs/plan/artifacts/phase1871/README.md`) and set
  it as the `authjs.session-token` cookie in a Playwright context.
  - Positive control: `curl` with the cookie against `/desktop` → `200`.
  - Negative control: same URL, no cookie → `307` (redirect to `/signin`).
- Navigation: `/desktop` is one route with client-side surface state
  (`forge.desktop.surface` in localStorage). Each surface was reached by
  writing that key directly (`JSON.stringify("autonomy")` etc. —
  `usePersistentState` does `JSON.parse`) and reloading, exactly the
  mechanism the app's own `deep-link.ts` uses. CanvasPane has no direct nav
  entry — it is reached by navigating to `map`, clicking the `.map-mode-tab`
  labelled "canvas" (`MapSurface.tsx:198`), then clicking the plan-toggle
  button (`title="Toggle structured execution plan & DAG"`,
  `CanvasPane.tsx:804`) to open the drawer and mount its handle.
- Every surface renders **two** `[role="separator"]` elements: `DesktopApp`'s
  own nav-rail handle (mounted on every surface, `DesktopApp.tsx:283`) plus
  the surface's own. Scripts select `.last()` to target the surface-specific
  handle.
- Script: `/tmp/playwright-test-layout-deltas.js`, run via the
  `playwright-skill`'s `run.js` (Chromium, headless, real
  `page.mouse.down/move/up`, 20-step drags). Full JSON dump at
  `/tmp/layout-delta-results.json` (not committed — throwaway, per the
  worktree-only policy).
- Server killed after the run (`kill 896400`, confirmed with `ss -ltnp`).

## 1. AutonomySurface — category rail

- File: `forge-control-web/app/desktop/AutonomySurface.tsx:243`
- Storage key: `forge.layout.autonomy.categoryRail`, unit `px`, axis `x`,
  `invert: false` (rail is the handle's `previousElementSibling`, so
  dragging right must grow it).
- Bounds: `AUTONOMY_RAIL_MIN=160`, `AUTONOMY_RAIL_MAX=420`,
  `AUTONOMY_RAIL_INITIAL=220` (`autonomy-rail-split.ts`).

**Drag:** click point at the handle's true center (fraction 0.5 — this
handle's hit-pad is fully live, see §4). Dragged **+80px** right.

| | value |
|---|---|
| before | 220.0px |
| after | 300.0px |
| delta | **+80.0px** |
| expected direction | grow (invert:false, drag right) |
| actual direction | grow |
| localStorage after drag | `"300"` |

Delta matches drag distance exactly (px unit, 1:1 scale, as designed).

**Double-click reset:** `storedAfterReset` → `null` (key removed, matches
`reset()`'s `localStorage.removeItem`), rail width back to **220.0px** —
exactly `AUTONOMY_RAIL_INITIAL`.

## 2. JournalSurface — retro/mentor split

- File: `forge-control-web/app/desktop/JournalSurface.tsx:84`
- Storage key: `forge.layout.journal.split`, unit `fraction`, axis `x`,
  `invert: false` (retro pane is the handle's `previousElementSibling`).
- Bounds: `JOURNAL_SPLIT_MIN=0.35`, `JOURNAL_SPLIT_MAX=0.70`,
  `JOURNAL_SPLIT_INITIAL=0.55` (`journal-split.ts`). Only rendered
  `!isNarrow` — viewport was 1600×1000, well above the 960px narrow
  breakpoint.

**Drag:** center click (fully live hit-pad). Dragged **+80px** right.

| | value |
|---|---|
| before (retro pane width) | 776.046875px |
| after | 852.375px |
| delta | **+76.328125px** |
| expected direction | grow (invert:false, drag right) |
| actual direction | grow |
| localStorage after drag | `"0.606497175141243"` |

This is a **fraction** unit, so a screen-pixel delta isn't 1:1 with the drag
distance — it's scaled by the container width at grab time
(`useResizablePanel`'s `scale = 1 / span`). Reconstructing: container width
= `776.046875 / 0.55` ≈ **1411.0px**. Predicted new fraction =
`0.55 + 80/1411.0` ≈ `0.6067`; measured `0.6065` — the ~0.02% gap is the
20-step mouse-move quantization, not a bug. Predicted screen delta =
`0.0567 × 1411.0` ≈ `80.0px` before the container reflows to give the
drawer/mentor pane less width, which is why the raw pixel delta above
(76.3px) sits slightly under the nominal 80: the retro pane's flex-basis is
`${fraction} 1 0`, and its final rendered width also loses a hair to the 1px
handle's own layout width changing between reads. The **fraction value**
(the thing the primitive actually persists and clamps) tracks the drag
distance correctly.

**Double-click reset:** `storedAfterReset` → `null`, retro pane back to
**776.046875px** — exactly the pre-drag/default width at this fraction and
viewport.

## 3. CanvasPane — plan drawer

- File: `forge-control-web/app/desktop/CanvasPane.tsx:297`
- Storage key: `forge.layout.canvas.planDrawer`, unit `px`, axis `x`,
  `invert: true` (drawer is the handle's `nextElementSibling` — the sized
  zone follows the handle, so dragging **left**, i.e. negative dx, must grow
  it).
- Bounds: `CANVAS_PLAN_MIN=380`, `CANVAS_PLAN_MAX=820`,
  `CANVAS_PLAN_INITIAL=520` (`canvas-plan-split.ts`).
- Reached via `MapSurface` → canvas mode → plan toggle (no direct nav entry;
  `ChatSurface.tsx:1455` also mounts `CanvasPane` but requires an open
  project chat with a canvas path, which is more setup for the same
  component — `MapSurface`'s `DEFAULT_CANVAS_PATH` is always non-empty, so
  the plan-toggle button is visible immediately).

**Drag:** dragged **-80px** (left). **Center click (fraction 0.5) does NOT
land on the handle** — see §4 for why. Used fraction 0.2 instead, found by
probing `elementFromPoint` across the handle's own bounding box.

| | value |
|---|---|
| before (drawer width) | 520.0px |
| after | 600.0px |
| delta | **+80.0px** (grew, as expected for invert:true + leftward drag) |
| expected direction | grow (invert:true, drag left) |
| actual direction | grow |
| localStorage after drag | `"600"` |

Delta matches drag distance exactly — `invert` is wired correctly.

**Double-click reset:** `storedAfterReset` → `null`, drawer back to
**520.0px** — exactly `CANVAS_PLAN_INITIAL`.

## 4. Finding: this worktree's handle hit-pad is half-dead for the plan drawer (pre-existing primitive bug, not this round's regression)

`elementFromPoint` probed across the CanvasPane handle's own
`boundingBox()` (`x=1075, width=10` — the full `2*HIT_PAD + rule` box):

| fraction | resolves to |
|---|---|
| 0.05 – 0.40 | the handle (`role="separator"`, `position: static`, `z-index: 2`) |
| 0.50 – 0.95 | the plan drawer div (`position: relative`, `z-index: 10`) |

The right half of the 10px hit-pad is covered by the drawer, because the
drawer carries `position: relative; zIndex: 10` (`CanvasPane.tsx:1132-1133`,
untouched by this conversion) and `ResizeHandle`'s own `zIndex: 2` is
decorative — it never applied, because nothing in `_ui/ResizableSplit.tsx`
sets `position` on the handle itself in **this worktree's** copy of the
primitive, so z-index has no positioned box to stack against.

**This is not a new bug introduced by this round's conversions** — it is the
exact defect described in this project's own memory note
(`resize-handle-hitpad-loses-to-positioned-sibling`), already fixed upstream
in commit `79bc6de` ("give the handle a position, so its z-index is not
decorative"). That commit is on `main` and on `project/a19c98b5`, but **is
not an ancestor of `project/f75101a5`** (confirmed via `git merge-base
--is-ancestor 79bc6de HEAD` → not an ancestor) — this branch was cut before
that fix landed. `ResizableSplit.tsx` is out of this round's write-set (the
brief names it as claimed by the project's manager), so it was not
patched here; a real mouse user on this exact branch has roughly half the
intended grab target on this one handle until the branches converge or the
fix is cherry-picked. AutonomySurface's and JournalSurface's handles have no
positioned neighbour and are fully live across their whole pad (fractions
0.05–0.95 all resolved to the handle in ad-hoc spot checks during the drag
runs above).

## Files touched this round

- `docs/plan/artifacts/aios-layout-adjustability/pixel-delta-evidence.md` (this file) — the declared write-set.

No other file in the repo was edited. `/tmp/playwright-test-layout-deltas.js`,
`/tmp/playwright-check-canvas-hitpad.js`, `/tmp/layout-delta-results.json`,
and `/tmp/session-cookie-7912.txt` are scratch artifacts outside the repo,
not committed.
