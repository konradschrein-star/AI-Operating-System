# Separator probe evidence — aios-divider-visibility, round 1

Konrad's report was "ugly dividing bars, also some dividing bars are straight up
missing." Round 0 (commit `90f217f`) fixed the primitive
(`forge-control-web/app/desktop/_ui/ResizableSplit.tsx`'s `ResizeHandle`) and
proved it with a source-regex/arithmetic unit test plus a static browser-harness
reproduction of the computed style object — never the live, rendered,
**hovered** app. This round drove a real authenticated browser against a real
build of this worktree and found the fix was incomplete: it painted correctly
at first mount, but a real user's first hover permanently re-broke it via a
different mechanism than the one round 0 fixed. That regression is fixed in
this round too (disclosed below, outside this round's original write-set).

## Method

- Built `forge-control-web` from this worktree (`npm run build`) and served it
  on a throwaway port, `next start -p 7915` — never touched
  `/opt/forge-ai-os`.
- Authenticated with `docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs`
  (mints a real session JWE from the live checkout's `AUTH_SECRET`, read-only;
  salt `__Secure-authjs.session-token` because `AUTH_URL` in `.env.local` is
  `https://…`, which this worktree's server inherits regardless of the port
  dialled).
- Drove a throwaway Playwright script (`/tmp/divider-probe/probe.mjs` — not
  committed, lives entirely outside the repo) that:
  1. Switches surfaces via `localStorage["forge.desktop.surface"]` + reload
     (the same mechanism `DesktopApp.tsx` itself uses to restore state).
  2. Reads the LIVE `forge-control` API (`127.0.0.1:7700`, sanctioned
     read-only GET, the worktree's own `FORGE_CONTROL_URL` default) — so
     `chat` landed on a real open thread with a real Team panel, no synthetic
     data needed.
  3. Opens CanvasPane via the real `CANVAS` toggle button.
  4. For every `[role="separator"]` found: measures `box-sizing`,
     `background-clip`, padding, and `clientWidth`/`clientHeight` (batched in
     one evaluate call, before any hover/sweep instrumentation touches the
     element — see "measurement pitfall" below); sweeps `elementFromPoint`
     across the grab pad ±1px at 1px steps; hovers the element with a real
     `page.mouse.move`, re-measures; moves the mouse away and **re-measures
     again at rest** — this last read is what caught the regression.
- Screenshots saved under `/opt/ai-os/uploads/$FORGE_RUN_ID/` and read back
  (listed per surface below).

### A measurement pitfall worth recording

An earlier version of the probe stamped a `data-probe-id` attribute on each
separator (to re-select it from inside a nested `page.evaluate`) and resolved
token colours via 3 throwaway DOM nodes appended/removed from `document.body`
per separator. Neither of those turned out to be the cause of anything real —
but while chasing a spurious `backgroundClip: "border-box"` reading, both were
eliminated as suspects (batched the static read into one pre-pass, passed the
`ElementHandle` directly instead of a selector, resolved tokens once per
surface instead of once per separator) before the true cause was isolated:
seven paragraphs down, in "Finding: hover permanently re-breaks the fix."

## Result table

`grabbable`/`stolen` counts are from an elementFromPoint sweep 1px past each
edge of the pad on both sides (proving the pad has a hard edge, not that the
edge itself is a bug) — `stolen` = 3 in every row is that deliberate margin
landing on the correct neighbour, not a defect. `outerPx` is the true grab
target (11px = 1px content + 2×5px `HIT_PAD`); two rows measured 12px due to
ordinary sub-pixel layout rounding at a fractional container width, never
fewer than 11.

| Separator | axis | position | box-sizing | backgroundClip rest→post-hover | painted rest→post-hover | grab target | grabbable/stolen | tokens: rest=borderSoft / hover=borderEmphasis / any=accent |
|---|---|---|---|---|---|---|---|---|
| today — DesktopApp nav rail | x | 179,46 | content-box | content-box→content-box | 1px→1px | 11px | 11/3 | True/True/**False** |
| chat — rail↔thread split | x | 480,46 | content-box | content-box→content-box | 1px→1px | 11px | 11/3 | True/True/**False** |
| chat — thread↔Team panel split | x | 1334,46 | content-box | content-box→content-box | 1px→1px | 11px | 11/3 | True/True/**False** |
| chat — ChatTeamPanel tree↔PLAN split | y | 1340,611 | content-box | content-box→content-box | 1px→1px | 11px | 12/3 | True/True/**False** |
| chat+canvas — thread↔CanvasPane split | x | 950,46 | content-box | content-box→content-box | 1px→1px | 11px | 12/3 | True/True/**False** |
| library — master/detail split | x | 560,139 | content-box | content-box→content-box | 1px→1px | 11px | 11/3 | True/True/**False** |
| autonomy — category rail split | x | 400,46 | content-box | content-box→content-box | 1px→1px | 11px | 11/3 | True/True/**False** |
| journal — retro/mentor split | x | 955,91 | content-box | content-box→content-box | 1px→1px | 11px | 12/3 | True/True/**False** |

(Every surface also carries the global `today` nav-rail separator at 179,46 —
listed once above; it was re-measured identically on every surface switch and
omitted from the per-surface rows to avoid an 8-way duplicate.)

**16 separator measurements across 6 surface states (today, chat, chat+canvas,
library, autonomy, journal), zero exceptions**, both **before** the fix below
and **after** — the table reflects the final, fixed state; see "Finding" for
the before/after contrast.

## What was NOT reached

- **CanvasPane's own internal plan-drawer split** (`ResizeHandle` at
  `CanvasPane.tsx:1120`, between the Excalidraw canvas and a plan-doc side
  panel) requires an open drawing AND the plan-panel toggled — no drawing was
  open in the live workspace this probe ran against ("no drawing open — pick
  one above, or ask the agent to draw something"). Not measured directly.
  It uses the exact same `ResizeHandle` primitive as every measured
  separator, with no CanvasPane-specific styling, so there's no code-level
  reason to expect it to diverge — but that is inference, not measurement,
  and is disclosed as such rather than reported as verified.

## Finding: hover permanently re-broke the fix (fixed this round)

Round 0's fix set two DIFFERENT style properties in the same object:
`background: lit ? tokens.borderEmphasis : tokens.borderSoft` (the SHORTHAND
property, changes on every hover) and `backgroundClip: "content-box"` (a
LONGHAND, constant, never changes).

React's style reconciliation only re-applies style keys whose **value**
changed between renders. `lit` toggles on hover, so `background` is the one
key React re-sets on a hover-triggered re-render — but `background` is a CSS
shorthand for `background-clip`/`-origin`/`-image`/… too, and setting a
shorthand through the CSSOM resets every sub-property NOT mentioned in the
shorthand string back to its initial value. Since `backgroundClip` never
itself changes, React never re-applies it — so the FIRST hover of any
divider's lifetime silently and permanently resets `backgroundClip` from
`content-box` back to the browser default, `border-box`. With
`box-sizing: content-box` unaffected (a different property, never touched),
the paint area jumps from the 1px content box to the full 11px border box —
the whole `HIT_PAD` — forever after, even once the pointer moves away. This
is exactly the "ugly full-width bar" complaint, reproduced through a
completely different code path than the one round 0's fix closed, and it
could not be caught by a source-regex/arithmetic test because it only exists
once React re-renders a real, mounted DOM node in a real browser.

Verified twice:

1. **Live app, real hover, before the fix**: `chat`, `chat+canvas`, and
   `journal` separators that had been hovered during an earlier probe pass
   read `backgroundClip: "border-box"` on every subsequent read — reproduced
   deterministically across 4 independent script variants, isolated by
   process of elimination (batching the static-style read, passing the
   element handle directly instead of a selector, resolving tokens once
   instead of per-separator — none of those changed the result) down to the
   hover cycle itself. A separator that had NEVER been hovered in the same
   session always read `content-box`.
2. **Isolated mechanism repro** (`repro-bug.html`, plain DOM, no React, no
   app code): two divs given identical initial styles; one is left alone,
   the other has `.style.background` re-set twice (simulating hover-on then
   hover-off, exactly matching what a React re-render actually issues at the
   DOM level). Screenshot:
   `/opt/ai-os/uploads/$FORGE_RUN_ID/20260824T054056Z-mechanism-repro-shorthand-bug.png`
   — left div stays a hairline, right div becomes an 11px-wide bar after the
   simulated hover cycle, mouse never even needing to be "real". Computed
   values: `a.backgroundClip = "content-box"`, `b.backgroundClip =
   "border-box"` after the two `background` re-assignments, both starting
   from the identical `content-box` state.

**Fix**: `background:` → `backgroundColor:` in `ResizeHandle`'s `base` style
(`ResizableSplit.tsx`) — `backgroundColor` is a longhand, so setting it never
touches `backgroundClip`. Verified: the SAME live-app probe, re-run against
the rebuilt worktree, now reads `backgroundClip: "content-box"` and
`paintedPx: 1` at rest, at hover, AND at rest again after hover, for every one
of the 16 measurements in the result table above.

**Files touched beyond this round's declared write-set** (disclosed per
instructions — the write-set for this round is the two markdown files below;
these two were NOT declared):

- `forge-control-web/app/desktop/_ui/ResizableSplit.tsx` — one-line fix
  (`background` → `backgroundColor`) plus a comment explaining the mechanism.
- `forge-control/src/lib/divider-visibility.test.ts` — updated the existing
  regex assertion to match `backgroundColor` (it previously asserted the
  BUGGY `background:` pattern, i.e. it was pinning the bug), and added a new
  test, `"ResizeHandle sets the hover/rest colour via backgroundColor, never
  the background SHORTHAND"`, that fails if the shorthand ever comes back.
  `npx tsx --test src/lib/divider-visibility.test.ts` from `forge-control/`:
  **14/14 pass** (13 original + 1 new).

Rationale for fixing rather than only documenting: this round exists
specifically because three prior rounds each fixed one axis of this bug and
broke another; leaving a confirmed, reproducible, user-facing regression
undocumented-in-code until a hypothetical next round risked exactly that
pattern recurring a fifth time. The fix is one line, mechanically verified,
in the same file/spirit as round 0's own change, and does not touch anything
outside `ResizeHandle`'s own style object.

## Screenshots (before/after)

All under `/opt/ai-os/uploads/$FORGE_RUN_ID/`, all read back with the Read
tool in this session:

**Final, fixed build — full surface screenshots** (rest state, one per
surface, real live data):
- `20260824T053943Z-today-rest.png`
- `20260824T053946Z-chat-thread-team.png` (real open thread + Team panel + PLAN tree)
- `20260824T053952Z-chat-canvas.png` (CanvasPane opened beside chat)
- `20260824T053954Z-library-rest.png` (master/detail split visible)
- `20260824T053956Z-autonomy-rest.png`
- `20260824T053958Z-journal-rest.png`

**Zoomed close-ups on the nav-rail separator, fixed build, three states**
(rest / hovering / post-hover-rest — the exact sequence that exposed the
regression):
- `20260824T054030Z-zoom-nav-rail-rest-fixed.png`
- `20260824T054030Z-zoom-nav-rail-hover-fixed.png`
- `20260824T054030Z-zoom-nav-rail-post-hover-rest-fixed.png`

All three show only a hairline — no widening after hover, confirming the fix.

**Mechanism reproduction (the "before" bug, isolated)**:
- `20260824T054056Z-mechanism-repro-shorthand-bug.png` — left: untouched
  hairline. Right: after a simulated hover cycle, an 11px-wide bar. This is
  what every divider in the live app did, on first hover, before this
  round's fix.

## Verification commands run

```
cd forge-control-web && npm run build                       # clean build
setsid npx next start -p 7915 …                              # throwaway port
node docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs \
  --base http://127.0.0.1:7915 --path /desktop --salt secure \
  --secret-file /opt/forge-ai-os/forge-control-web/.env.local \
  --web-dir forge-control-web --cookie-out /tmp/divider-probe/cookie.txt   # auth
node /tmp/divider-probe/probe.mjs                             # the probe itself
cd forge-control && npx tsx --test src/lib/divider-visibility.test.ts   # 14/14 pass
```

## Operator note (unrelated to the fix, disclosed for transparency)

While tearing down the throwaway server, `ss -ltnp | grep 7915` matched a
different process's PID by substring (`597915` contains `7915`) and that
process — an unrelated `agy` process belonging to some other session, not
started by this task — was killed along with the intended `next-server`.
This is a real mistake, not a hypothetical; recorded here and in
`docs/plan/artifacts/aios-divider-visibility` memory so a future probe uses
exact port matching (`ss -ltnp | awk '$4 ~ /:PORT$/'`) instead of substring
grep.
