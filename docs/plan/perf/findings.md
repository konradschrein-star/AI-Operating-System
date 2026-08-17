# Hover performance — FINDINGS (R13): the named mechanism

**Round 1292. Retrospective write-up. No application code was changed, no server
was started, no browser was run.**

R13 requires the mechanism to be *named from measurement, not intuition*, with the
evidence attached. This document names it, cites the code as it reads in the
current tree, and lists what was ruled out and how.

Companions: `docs/plan/perf/baseline.md` (R12 — the before numbers and the
protocol gap), `docs/plan/perf/after.md` (R14 — the series and the gate verdict).

---

## 1. The mechanism: per-row React hover state on the chat rail

`ChatListItem` held a `useState(hover)` and swapped the age stamp `<age>` for the
close affordance `<✕>` on every pointer enter and leave. **Every row the pointer
crossed re-rendered and rebuilt DOM.**

Recorded in `docs/plan/artifacts/phase400/README.md` (round-401a section, under
"The hover number (NFU2 — Konrad: 'hovering the sidebar still lags')"):

> `ChatListItem` held `useState(hover)` and swapped `<age>` for `<✕>` on every
> pointer enter/leave. Every row the pointer crossed re-rendered and rebuilt DOM.

**The evidence is the shape of the number, not just its size.**

| | value | what it means |
|---|---|---|
| crossings | 76 | pointer entries across 7 rail rows in a 10 s window |
| react commits attributable to hover | **77** | ≈ **1.01 commits per crossing** — a commit for each row crossed |
| DOM mutations attributable to hover | **1 057** | ≈ **13.9 mutations per crossing** — the subtree torn down and rebuilt, not a style flip |

Source `docs/plan/artifacts/phase400/hover-cost-before.json`. A poll-driven
storm would not track crossings one-for-one; a pure style change would not mutate
DOM at all. One commit per crossing with a double-digit mutation tail is the
signature of a React state change per row, and that is what the code contained.

---

## 2. The fix: both children always mounted, swapped by CSS `:hover` opacity

Both children are now mounted at all times, stacked in one slot, and swapped by
`.chat-row:hover` opacity rules. No React state is involved, so no commit occurs
and no DOM is rebuilt.

**Cited from the current tree — `forge-control-web/app/globals.css`, lines
94–108, verified to still read this way:**

```css
/* v3 phase 400 (U9/NFU2): chat rail hover reveal, CSS-only. The close ✕ and
 * the age stamp share one slot; hovering swaps their opacity. This replaces a
 * React `useState(hover)` per row — the source of the sidebar lag. Opacity
 * only: every colour still comes from app/tokens.ts (NFU1). */
.chat-row .chat-row-x {          /* :98  */
  opacity: 0;
}
.chat-row:hover .chat-row-x,     /* :101 */
.chat-row:focus-within .chat-row-x {
  opacity: 1;
}
.chat-row:hover .chat-row-age,   /* :105 */
.chat-row:focus-within .chat-row-age {
  opacity: 0;
}
```

Two properties of this shape matter and both were measured, not asserted:

- **Opacity only.** No layout property changes, so the row cannot reflow. §5.2
  below carries the geometry proof.
- **`:focus-within` alongside `:hover`.** The ✕ stays reachable by keyboard. This
  is R15's affordance surviving the fix rather than being deleted to buy a number.

The comment block is load-bearing documentation and it is accurate: the brief for
this round asked whether lines 94–117 still read that way. They do, with the exact
boundaries being **94–108 for `.chat-row`** and **110–121 for `.team-row`** (§3).

---

## 3. The team panel was built with the same bargain from the start

The team panel never had a hover-state version to fix. It was written with the
CSS-only pattern, so its measurement is an **absolute** number, not a delta.

`docs/plan/artifacts/phase500/README.md` §3.2:

> The mechanism behind it is checkable by grep rather than by trust: there is no
> pointer handler and no hover state anywhere in `app/desktop/team/`, and the
> controls are revealed by the `.team-row:hover` opacity rule in
> `app/globals.css`. The geometry assertion is the other half: every row's
> `getBoundingClientRect()` is byte-identical hovered and not (`geom_before` /
> `geom_during` in the JSON), because `.team-row-controls` is a fixed-width slot
> that is always mounted.

Both halves re-verified in the current tree:

```
$ grep -rnE "onMouseEnter|onMouseLeave|useState.*[Hh]over" forge-control-web/app/desktop/team/
(no output)
```

```css
/* forge-control-web/app/globals.css:110-121 — v3 phase 500 (U17/NFU2) */
.team-row .team-row-controls {          /* :116 */
  opacity: 0;
}
.team-row:hover .team-row-controls,     /* :119 */
.team-row:focus-within .team-row-controls {
  opacity: 1;
}
```

And the geometry, from `docs/plan/artifacts/phase500/team-hover-after.json`: all
20 rows appear in both `geom_before` and `geom_during` with identical
`x`/`height`/`width` triples (`137x43x259`, `180x43x259`, … `954x43x259`),
`layout_shift: false`, `verdict: "PASS"`. Re-confirmed unchanged one phase later
in `docs/plan/artifacts/phase600/team-hover-round604.json` — same 20 triples,
same verdict.

---

## 4. The open lead: §9.7's `PseudoClass` records — now closed, as two mechanisms

`docs/plan/artifacts/phase800/canvas-perf.md` §9.7 recorded **4 636
`StyleRecalcInvalidationTracking · PseudoClass` records on the cold canvas open
and 4 637 on the warm one, against 4 716 DOM elements** — about one per element,
on every canvas toggle — and said so explicitly:

> **The mechanism is NOT established and is deliberately not guessed at here.**

§9.7 named our own three descendant `:hover` rules as the suspects it could not
clear, and §9.8 item 3 called it *"the next real question on this surface, and it
is the one that touches the panel's hover requirement rather than the canvas."*

**Round 1291's probe ran it. Its verdict, quoted verbatim from
`docs/plan/artifacts/phase1290/invalidation/README.md`:**

> ## MECHANISM ESTABLISHED
>
> Two mechanisms, because the probe found that §9.7 had merged two different
> things under one record count.

### 4.1 Mechanism A — §9.7's records are a canvas cost, not a hover cost

**Cause:** Excalidraw's `setLanguage` writes `document.documentElement.lang` on
mount. `lang` backs the `:lang()` pseudo-class, so Blink fires a pseudo-state
change on the root and propagates it to every descendant — one `PseudoClass`
record per DOM element, on every canvas open.

**Record counts, read out of `docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.json`:**

| leg | `PseudoClass` records | elements | per element |
|---|---|---|---|
| canvas toggle (counting categories) | **5 934** | 5 941 | 0.999 |
| canvas toggle, all 121 `:hover` rules deleted first | **5 934** | 5 942 | 0.999 |
| canvas toggle, full categories + stacks | **5 934** | 5 942 | 0.999 |
| canvas toggle, minimal categories | **5 934** | 5 942 | 0.999 |
| §9.7's original figure, for comparison | 4 636 | 4 716 | 0.983 |
| reproduced with **no canvas at all**, one `document.documentElement.lang = "de-DE"` write | **6 098** | 6 139 | 0.993 |
| same write with the value it already had (`lang = "en"`) | **6 098** | 6 139 | 0.993 |
| `document.documentElement.dir = "rtl"` | **1** | 6 139 | 0.000 |

Four trace-category sets agree to the integer, and one line of JavaScript with no
canvas anywhere reproduces the storm exactly. The law is one record per DOM
element, and it held across a 26 % growth in document size (4 716 → 5 941).

**And it is not hover.** The pointer legs of the same probe:

| leg | `PseudoClass` records | per crossing |
|---|---|---|
| one chat-rail crossing | **0** | 0.00 |
| one team-panel crossing | **0** | 0.00 |
| 30-crossing rail sweep | **0** | 0.00 |

Zero on every pointer leg in every one of the six rounds. §9.8 item 3 hoped
§9.7's records were the panel's hover lead. **They are not.**

**This is a NOTE, not a finding.** The operator decision of 2026-08-17
(`docs/plan/operator-visibility/15-ui-v3-phases.md`, mirrored in
`docs/plan/artifacts/phase800/README.md`) is binding: Konrad accepts the ~190 ms
canvas first-open cost, option (d). Options (a) keep-mounted and (c) shrink-the-
document are **CLOSED**. Canvas first-open is not a defect and must not be
re-opened as one.

### 4.2 Mechanism B — the hover finding §9.7 was hoping for exists, and it is one rule

Hover never reaches `reason: PseudoClass`. It produces a smaller, differently
shaped family of records where Blink **does** name the selector — and there the
result is sharp.

**Cause:** `forge-control-web/app/v2.css:291`, verified to still read this way in
the current tree:

```css
.v2-nav-item:hover:not(.v2-nav-active) span {
  color: rgba(232, 229, 224, 0.85) !important;
}
```

The selector ends in a bare **tagName**. Blink keys `:hover` descendant
invalidation sets on the rightmost compound and applies the union to whichever
element's hover state changed, so `span` enters the document-wide hover
invalidation set. Every pointer crossing of a `.chat-row` or `.team-row`
therefore invalidates **every `<span>` in that row**, not the one or two that
change. The rule's `.v2-nav-item` scope does not scope its invalidation set.

**The ladder, all rounds on one loaded page, `base` measured twice first so the
instrument's own repeatability is visible before any difference is read as a
finding:**

| round | rules deleted | `:hover` rules left | sweep ×30 records | per crossing | `PseudoClass` |
|---|---|---|---|---|---|
| `base` | — | 121 | **1 340** | 44.67 | 0 |
| `base_repeat` | — | 121 | **1 340** | 44.67 | 0 |
| delete `v2.css:291` only | 1 | 120 | **720** | 24.00 | 0 |
| + all six descendant rules | 6 | 115 | **484** | 16.13 | 0 |
| + our 18 subject-only `:hover` rules | 24 | 97 | **480** | 16.00 | 0 |
| + all 97 remaining, **including Excalidraw's 87** | 121 | 0 | **480** | 16.00 | 0 |

**One rule is worth 620 of the 860 reducible records — 46 % of the total.** Every
`:hover` rule Excalidraw ships is worth 4.

The group table names the mechanism rather than inferring it: deleting
`v2.css:291` alone takes four `matched tagName: span` groups (240 + 70 + 60 + 60)
to **zero** and replaces them with two `matched class` groups of 60 —
`chat-row-age` and `chat-row-x`, the two elements that actually change.

**Honesty about the size of B, quoted from the probe's own README:**

> 44.67 → 24 invalidation records per crossing is a real, attributable 2×
> reduction in style-invalidation work, and it is the correct fix regardless. It
> is **not** established that it is what Konrad feels as hover lag: 44 records per
> crossing is small, this instrument does not measure milliseconds, and nothing in
> this round measured a frame.

**Not applied.** Round 1291 was forbidden from touching application code and did
not. The recommendation it hands forward is a class-keyed rightmost compound
(`.v2-nav-item:hover:not(.v2-nav-active) .v2-nav-item-label`) with the
corresponding `className` at the call site, and it states a checkable prediction:
the sweep should land at **720**. Phase 1300 owns that decision.

### 4.3 The caveat the probe puts before its own numbers

`docs/plan/artifacts/phase1290/invalidation/README.md` §0, and it is not optional
reading for anyone quoting this section:

> **These categories materially change what the renderer does.** Every figure in
> this file is a RECORD COUNT. It attributes cost. **It does not measure
> milliseconds, and anyone quoting an ms figure out of this file is quoting the
> wrong instrument.**

Also disclosed there: Chrome's `dataLossOccurred` is true on every canvas leg (the
canvas count is defended by four independent category sets agreeing instead), and
`/desktop` is a live document whose element count moved 5 859 → 5 943 across runs,
so the pointer A/B ran all its rounds on one loaded page.

---

## 5. What was ruled out along the way

### 5.1 Poll cadence — never slowed, and unchanged throughout

`03-quality.md` §4's honesty rules forbid buying a number by slowing a poll. No
round did. Current tree:

```
$ grep -rn refetchInterval forge-control-web/app
forge-control-web/app/Providers.tsx:9: * These used to carry a GLOBAL `refetchInterval: 5_000`, which meant every
forge-control-web/app/MobileApp.tsx:1895:    refetchInterval: 60_000,
forge-control-web/app/desktop/ProjectsSurface.tsx:77:    refetchInterval: 6_000,
forge-control-web/app/desktop/ProjectsSurface.tsx:82:    refetchInterval: 15_000,
forge-control-web/app/desktop/ProjectsSurface.tsx:597:    refetchInterval: live ? 20_000 : 3_000,
forge-control-web/app/desktop/ProjectsSurface.tsx:703:    refetchInterval: live ? 20_000 : 3_000,
forge-control-web/app/desktop/AutonomySurface.tsx:40:    refetchInterval: 8000,
forge-control-web/app/desktop/PipelineSurface.tsx:22:    refetchInterval: 10_000,
forge-control-web/app/desktop/team/PlanKanban.tsx:352:    refetchInterval: PLAN_POLL_MS,
forge-control-web/app/desktop/team/ChatTeamPanel.tsx:164:    refetchInterval: TEAM_POLL_MS,
forge-control-web/app/desktop/MoneySurface.tsx:54:    refetchInterval: 60_000,
forge-control-web/app/desktop/MoneySurface.tsx:59:    refetchInterval: 60_000,
forge-control-web/app/desktop/live/AgentActivity.tsx:554:    refetchInterval: 4_000,
forge-control-web/app/desktop/DesktopApp.tsx:296:    refetchInterval: surface === "live" ? 15_000 : false,
forge-control-web/app/desktop/DesktopApp.tsx:985:    refetchInterval: 120_000,
forge-control-web/app/desktop/ChatSurface.tsx:393:    refetchInterval: 10_000,
forge-control-web/app/desktop/ChatSurface.tsx:587:    refetchInterval: live ? 20000 : 3000,
forge-control-web/app/desktop/ChatSurface.tsx:670:  // ONE request per chat opened, deliberately no refetchInterval: linkage does
forge-control-web/app/desktop/ChatSurface.tsx:1523:   * `refetchIntervalInBackground` is left at its default (false), so a
forge-control-web/app/desktop/ChatSurface.tsx:1541:    refetchInterval: secretsPollInterval(secretsLive),
forge-control-web/app/desktop/chat/AgentChatView.tsx:396:    refetchInterval: live ? 20000 : 3000,
```

```
$ grep -rn "TEAM_POLL_MS" forge-control-web/app/desktop/team/ChatTeamPanel.tsx
forge-control-web/app/desktop/team/ChatTeamPanel.tsx:91:const TEAM_POLL_MS = 6_000;
forge-control-web/app/desktop/team/ChatTeamPanel.tsx:164:    refetchInterval: TEAM_POLL_MS,
```

`TEAM_POLL_MS` is still `6_000`. Round 1291 identified it as the source of the
only >50 ms tasks on this surface (see `docs/plan/perf/after.md` §2) and
**deliberately left it alone** — `ChatTeamPanel.tsx:86-90` records that 6 s was
already chosen against a committed 40 req/min ceiling.

The poll is also, separately, the thing whose commits the idle subtraction removes.
`docs/plan/artifacts/phase700/hover-700.json` makes that explicit rather than
statistical: every one of the 11 commits in its hover window is attributed to a
named cause — `commits_unattributed: 0`, with the causes being
`poll /api/proxy/chat/bfd1283a…` ×2, `poll …/team` ×2, `poll /api/proxy/chat?limit=30`
×1 and `timer 1000ms` ×6.

### 5.2 Layout / reflow on hover — ruled out by byte-identical geometry

Three independent phases assert it, and the assertion is geometry equality, not a
screenshot:

| Source | What it asserts |
|---|---|
| `docs/plan/artifacts/phase400/rail-shot.cjs` lines 88–121 | reads every row's `getBoundingClientRect()` before and during hover, compares `JSON.stringify`, prints `no reflow on hover: row geometry identical` and sets a non-zero exit code otherwise |
| `docs/plan/artifacts/phase500/team-hover-after.json` | 20 rows, `geom_before` ≡ `geom_during`, `layout_shift: false` |
| `docs/plan/artifacts/phase600/team-hover-round604.json` | same 20 rows, same triples, `layout_shift: false` one phase later |
| `docs/plan/artifacts/phase700/hover-700.json` | 153 geometry entries, `geom_before` ≡ `geom_during` (verified: identical), `layout_shift: false` |

The mechanism behind the geometry is structural, not incidental: the ✕ and the age
stamp share **one slot**, and `.team-row-controls` is a fixed-width slot mounted in
every row at all times. Opacity is the only property that changes.

### 5.3 Excalidraw's own pseudo-class rules — suspected by §9.7, cleared by measurement

§9.7 *guessed* Excalidraw was innocent because its 20 descendant-invalidating
pseudo-class rules are all `.excalidraw`-scoped. Round 1291 measured it:

- Deleting **all 97** non-ours `:hover` rules, **including all 87 of Excalidraw's**,
  moves the 30-crossing sweep from 480 to **480** — a difference of zero.
- Deleting all 121 `:hover` rules in the document *before* opening the canvas
  changes the canvas storm from 5 934 to **5 934** — also zero.

Excalidraw's sheet is cleared on both counts. The sheet survey that establishes
the population: `008289500c38878d.css`, 1 098 rules, 87 with `:hover`, not ours.

### 5.4 A note on the grep §9.7 asked for

The single-line grep for descendant `:hover` rules finds only one of the six in
this tree:

```
$ grep -nE ':hover[^,{]*[ >+~][^,{]+\{' forge-control-web/app/globals.css forge-control-web/app/v2.css
forge-control-web/app/v2.css:291:.v2-nav-item:hover:not(.v2-nav-active) span {
```

That is a limitation of the grep, not evidence that the other five are gone. The
`.chat-row` and `.team-row` rules are written as multi-line selector lists, so the
opening brace is on a different line from `:hover` and a line-oriented pattern
cannot match them. They are present at `globals.css:101`, `:105`, `:119` and
`:179`/`:196` (the `.nav-back` pair, the second inside
`@media (prefers-reduced-motion: reduce)`). Round 1291's probe walked the CSSOM —
including recursing into `CSSMediaRule.cssRules`, which is the only way rule #5 is
reachable at all — and found six. **Trust the CSSOM walk, not the grep.**

---

## 6. Summary for R13

| Question | Answer | Evidence |
|---|---|---|
| What caused the rail hover lag Konrad reported? | Per-row `useState(hover)` in `ChatListItem`, swapping `<age>` for `<✕>` on every pointer enter/leave | 77 commits over 76 crossings ≈ 1:1, plus 1 057 DOM mutations — `docs/plan/artifacts/phase400/hover-cost-before.json` |
| What fixed it? | Both children always mounted, one slot, `.chat-row:hover` opacity swap | `forge-control-web/app/globals.css:94-108`; 77 → 1 commits, 1 057 → 0 mutations |
| Was the team panel ever affected? | No — built CSS-only from the start; its number is absolute, not a delta | `docs/plan/artifacts/phase500/README.md` §3.2; no pointer handler in `app/desktop/team/` |
| What was §9.7's storm? | Excalidraw's `lang` write on canvas mount. Not hover, not CSS, not ours. A NOTE, not a finding | `docs/plan/artifacts/phase1290/invalidation/README.md` — 0 records on every pointer leg |
| Is there a real remaining hover cost? | Yes, and it is one selector: `v2.css:291` puts a bare `span` in the document-wide hover invalidation set, doubling per-crossing invalidation work | 1 340 → 720 records over 30 crossings from deleting that one rule |
| Is that cost what Konrad feels? | **Not established.** Record counts are not milliseconds | The probe says so itself, §4.2 above |
