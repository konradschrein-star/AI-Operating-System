# Phase 1290 — `StyleRecalcInvalidationTracking · PseudoClass`: whose records are they?

Round 1291c. **No application code changed.** This directory contains one
probe, its raw JSON, and this file.

| File | What it is |
|---|---|
| `pseudo-invalidation.cjs` | the probe. Adapted from `phase800/canvas-layout-probe.cjs`; playwright by absolute path via `phase700/lib-703.cjs` (NFU8) |
| `pseudo-invalidation.json` | its raw output, committed. Every number below comes out of it |
| `README.md` | this file |

---

## 0. The caveat, before any number

The probe runs Chrome with
`disabled-by-default-devtools.timeline.invalidationTracking` and
`disabled-by-default-devtools.timeline.stack`. **These categories materially
change what the renderer does.** Every figure in this file is a RECORD COUNT.
It attributes cost. **It does not measure milliseconds, and anyone quoting an
ms figure out of this file is quoting the wrong instrument.** For milliseconds
on this surface, `phase800/canvas-open.cjs` is the instrument.

`canvas-perf.md` §9.8 item 4 also warns that `canvas-layout-probe.cjs`'s
`top_forcing_frames` contains a Playwright artifact. This file inherits that
file's rig, **not** that field's interpretation, and emits no equivalent field.

Two more things a reader should know before trusting a number here:

- **Chrome truncates the canvas legs.** `dataLossOccurred` is true on every
  canvas leg, on every run, whatever the category set; `traceBufferSizeInKb`
  is accepted by this Chrome and then ignored (buffer still 99.95% full to
  sixteen digits, with and without it). The canvas count is defended instead
  by **four legs under four different category sets** — including a `minimal`
  set that records nothing but user timing and the invalidation records
  themselves — which agree to the integer. The pointer legs, which carry every
  hover conclusion, lose nothing; that is checked strictly.
- **The document is not byte-identical between page loads.** `/desktop` is a
  live chat and its element count moved 5,859 → 5,943 across runs of this
  probe. Comparisons that need identical documents (the pointer A/B) run all
  their rounds on ONE loaded page.

---

## 1. Where it ran

Worktree only. No production URL was contacted.

- API harness `:7798` (already up; `forge-control/src/index.ts` never booted)
- isolated build of this worktree at `/tmp/phase1291c-web`, built with
  `FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production`, served on
  **`:7791`**. `forge-control-web/.next` was never rebuilt in place
- fixture: run `bfd1283a-b71b-4f35-b577-7d09aad803f2`, the manager chat titled
  *"Okay when I click the file section…"* — the large document §9.7 measured
- `PUT /api/proxy/canvas/file` **stubbed** on every canvas page (§9.9:
  `CanvasPane.tsx` flushes on unmount and Excalidraw dirties the scene while
  loading). `seen === stubbed` is asserted: the vault never saw a revision
- nothing restarted; `/opt/forge-ai-os` read exactly once, for `AUTH_SECRET`

**Element count: 5,941 on `/desktop`** where §9.7 recorded 4,716. The document
has grown ~26% since phase 800 — the transcript is longer. The records grew
with it, which is itself part of the finding.

### Reproduce

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
# phase500/README.md §2 steps A–E, with :7791 and /tmp/phase1291c-web
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-1291c.txt)"
export PHASE700_BASE_URL=http://127.0.0.1:7791
node docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.cjs   # writes to /tmp, non-destructive
```

Every number in this README is extractable from the JSON. One-liner:

```bash
python3 -c "import json;d=json.load(open('docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.json'));print(json.dumps(d['summary'],indent=1))"
```

---

## 2. The rules actually tested

Confirmed in this worktree with the command §9.7 asked for:

```
grep -nE ':hover[^,{]*[ >+~][^,{]+\{|:hover' forge-control-web/app/globals.css forge-control-web/app/v2.css
```

The **descendant** `:hover` rules — `:hover` with something after it — are six:

| # | file:line | selector |
|---|---|---|
| 1 | `globals.css:101` | `.chat-row:hover .chat-row-x` |
| 2 | `globals.css:105` | `.chat-row:hover .chat-row-age` |
| 3 | `globals.css:119` | `.team-row:hover .team-row-controls` |
| 4 | `globals.css:179` | `.nav-back:hover .nav-back-arrow` |
| 5 | `globals.css:196` | `.nav-back:hover .nav-back-arrow` (inside `@media (prefers-reduced-motion: reduce)`) |
| 6 | `v2.css:291` | `.v2-nav-item:hover:not(.v2-nav-active) span` |

§9.7 counted six and named three; the three it did not name are the two
`.nav-back` rules and the `@media` copy. Rule **#5 is only reachable by a
recursive walk** into `CSSMediaRule.cssRules`, which is why the probe walks
grouping rules rather than a sheet's top level.

Matching is by `selectorText`, not by file: the production build concatenates
`globals.css` and `v2.css` into one chunk and `href` can no longer tell them
apart. A grouped rule is therefore deleted whole — deleting #1 also removes
`.chat-row:focus-within .chat-row-x`. That is recorded, not worked around;
`:focus-within` is the same class of invalidation and removing it too only
strengthens a negative result.

**Sheet survey** (`sheets` in the JSON), same-origin sheets on `/desktop`:

| sheet | rules | with `:hover` | ours? |
|---|---|---|---|
| `3509fd11e190f67e.css` | 102 | 24 | yes (carries `.chat-row`) |
| `67ab3368c62b9f05.css` | 43 | 10 | no |
| `008289500c38878d.css` | 1098 | 87 | no (Excalidraw's) |

**121 `:hover` rules document-wide.** Two Google Fonts sheets are cross-origin
and throw on `.cssRules`; they are recorded as inaccessible rather than
silently skipped, and they contain no `:hover` selectors that could reach our
elements.

---

## 3. Q1 — is this a hover cost at all? **No. It is a canvas cost.**

One crossing = pointer moves *neutral → row centre → neutral* (one enter, one
leave). Every pointer leg asserts mid-leg that the row matches `:hover` in the
DOM and records the assertion (`hover_proof`: `rows_matching_hover: 1`,
`hover_chain_depth: 10`).

| leg | `PseudoClass` records | per crossing |
|---|---|---|
| (i) one CANVAS toggle | **5,934** | — |
| (ii) ONE chat-rail crossing | **0** | **0.00** |
| (iii) ONE team-panel crossing | **0** | **0.00** |
| (iv) 30-crossing rail sweep | **0** | **0.00** |

**Zero. Not "few" — zero, on every pointer leg, in every one of the six
rounds.** §9.7's records are produced by the canvas toggle and by nothing a
pointer does. §9.8 item 3 hoped this was the panel's hover lead; it is not.

The canvas number is stable and it is not a truncation artifact:

| leg | trace categories | records | elements | per element |
|---|---|---|---|---|
| `canvas_toggle` | counting | 5,934 | 5,941 | 0.999 |
| `canvas_toggle_all_hover_deleted` | counting | 5,934 | 5,942 | 0.999 |
| `canvas_toggle_stack_attribution` | full (+stacks) | 5,934 | 5,942 | 0.999 |
| `canvas_toggle_minimal_categories` | minimal | 5,934 | 5,942 | 0.999 |

Four category sets, one integer. §9.7 saw 4,636 against 4,716 elements
(0.983/element); this round sees 5,934 against 5,941 (0.999/element). **The law
is one record per DOM element, and it held across a 26% change in document
size.** That is also why `/canvas`, with 248 elements, produced 27.

---

## 4. Q2 — who owns the records?

### 4.1 The canvas storm: no authored selector owns it

Top groups, `canvas_toggle_stack_attribution`
(`groups.all_records`, ranked; 87 distinct groups):

| count | event | reason | selectorPart | invalidatedSelectorId | nodeName | subtree |
|---|---|---|---|---|---|---|
| 1,818 | `StyleRecalcInvalidationTracking` | `PseudoClass` | — | — | `SPAN` | true |
| 1,373 | " | `PseudoClass` | — | — | `DIV` | true |
| 782 | " | `PseudoClass` | — | — | `SPAN class='mono'` | true |
| 501 | " | `PseudoClass` | — | — | `P` | true |
| 419 | " | `PseudoClass` | — | — | `DIV class='mono'` | true |
| 254 | " | `PseudoClass` | — | — | `STRONG` | true |
| 216 | " | `PseudoClass` | — | — | `BUTTON class='mono'` | true |
| 105 | " | `PseudoClass` | — | — | `LI` | true |

The remaining groups are the same shape over the rest of the tag census. The
non-`PseudoClass` remainder of the leg is **121** records: `Animation` 44,
`Node was inserted into tree` 19, `Related style rule` 16, inline-style 10,
`Attribute` 8, `Control` 2 — plus the 5 + 17 below.

**`selectorPart`, `invalidatedSelectorId` and `changedPseudo` are null on every
one of the 5,934.** Blink did not attribute them to any selector — not one of
ours, not one of Excalidraw's. This is why §9.7 could count them and still not
know who they belonged to: `StyleRecalcInvalidationTracking` carries no
selector fields at all. The two events that *do* — `ScheduleStyleInvalidation‑
Tracking` and `StyleInvalidatorInvalidationTracking` — number **5** and **17**
on this leg, against 6,033 of the one that does not. §9.7 was reading the one
event of the three that cannot answer its own question.

Exactly **1** record in the whole canvas leg is attributed to `hover`.

### 4.2 The stack, resolved out of the shipped bundle

All 5,934 share one stack. The probe fetches the very script the browser ran
and quotes the characters around each frame's column, so the attribution is
checkable rather than assertable (`canvas_attribution.top_group_frame_sources`):

```
O @ 60568ccb.505732e182393499.js:1:7063        (Excalidraw's chunk, 504,623 bytes)
  … var _=N,R={},O=async e=>{if(_=e,
      document.documentElement.dir  = _.rtl?"rtl":"ltr",
      document.documentElement.lang = _.code,
      e.code.startsWith(P))R={};else try{R=await D(`./locales/${_.code}.json`)} …

t @ 60568ccb…:1:8585   Y=e=>{ … useEffect(()=>{ let t=async()=>{await O(i),n(!1)},
                          i=A.find(t=>t.code===e.langCode)||N; t() },[e.langCode]) …
```

That is Excalidraw's `setLanguage`, called from its init effect on mount. The
outer frames are react-dom (`dc458b9b…js`), i.e. the commit phase.

### 4.3 The hover records: ours, and named

Hover never reaches `reason: PseudoClass`. It produces a different, much
smaller family, and there Blink **does** name the selector. 30-crossing sweep:

| count | event | reason | selectorPart | nodeName |
|---|---|---|---|---|
| 240 | `StyleInvalidatorInvalidationTracking` | Invalidation set matched **tagName** | `span` | `SPAN` |
| 240 | `StyleRecalcInvalidationTracking` | Related style rule | — | `SPAN` |
| 240 | `StyleRecalcInvalidationTracking` | Animation | — | `SPAN` |
| 70 | `StyleInvalidatorInvalidationTracking` | matched **tagName** | `span` | `SPAN class='mono'` |
| 70 | `StyleRecalcInvalidationTracking` | Related style rule | — | `SPAN class='mono'` |
| 60 | `ScheduleStyleInvalidationTracking` | — (`changedPseudo: hover`, `invalidatedSelectorId: pseudo`) | — | `DIV class='chat-row'` |
| 60 | `StyleInvalidatorInvalidationTracking` | Invalidation set invalidates self | — | `DIV class='chat-row'` |
| 60 | `StyleInvalidatorInvalidationTracking` | Element has pending invalidation list | — | `DIV class='chat-row'` |
| 60 | `StyleRecalcInvalidationTracking` | Related style rule | — | `DIV class='chat-row'` |
| 60 | `StyleInvalidatorInvalidationTracking` | matched **tagName** | `span` | `SPAN class='mono chat-row-age'` |
| 60 | `StyleInvalidatorInvalidationTracking` | matched **tagName** | `span` | `SPAN class='mono chat-row-x'` |
| 60 | `StyleRecalcInvalidationTracking` | Related style rule | — | `SPAN class='mono chat-row-age'` |
| 60 | `StyleRecalcInvalidationTracking` | Related style rule | — | `SPAN class='mono chat-row-x'` |

`ScheduleStyleInvalidationTracking · changedPseudo: hover` is exactly **2 per
crossing** — one enter, one leave — in every round, at every neutralisation
level. That is the irreducible cost of the pointer entering a row. Everything
above it is what our stylesheet asks Blink to do about it.

Note `selectorPart: span` — a **tagName**, not a class.

---

## 5. Q3 — do our rules multiply it? **Yes, by 2.8× — and one rule owns half.**

All rounds on ONE loaded page, cumulative deletions, `base` measured twice
first so the instrument's own repeatability is visible before any difference
is read as a finding. Each level re-reads the matching `selectorText`s after
deleting and asserts they are gone (`rules_matching_after: 0`, zero failures);
counts are in `neutralisation` per round.

| round | rules deleted | `:hover` rules left in document | rail ×1 | team ×1 | sweep ×30 | per crossing | `PseudoClass` |
|---|---|---|---|---|---|---|---|
| `base` | — | 121 | 52 | 52 | **1,340** | 44.67 | 0 |
| `base_repeat` | — | 121 | 48 | 48 | **1,340** | 44.67 | 0 |
| `v2_nav_item_span_only` | 1 | 120 | 24 | 20 | **720** | 24.00 | 0 |
| `ours_descendant` | +5 (6 total) | 115 | 16 | 20 | **484** | 16.13 | 0 |
| `ours_all_hover` | +18 (24 total) | 97 | 16 | 20 | **480** | 16.00 | 0 |
| `all_hover` | +97 (121 total) | 0 | 16 | 16 | **480** | 16.00 | 0 |

Read the last column first: **`PseudoClass` is 0 in every row.** Nothing in
this table touches §9.7's metric. What it does touch is the invalidation work a
pointer crossing actually causes, and there the result is sharp.

**Deleting ONE rule — `v2.css:291`, `.v2-nav-item:hover:not(.v2-nav-active)
span` — halves it: 1,340 → 720.** The group table says why:

| group | base | after deleting only `v2.css:291` |
|---|---|---|
| invalidation set matched **tagName** `span` → `SPAN` | 240 | **0** |
| → `SPAN class='mono'` | 70 | **0** |
| → `SPAN class='mono chat-row-age'` | 60 | **0** |
| → `SPAN class='mono chat-row-x'` | 60 | **0** |
| invalidation set matched **class** `chat-row-age` | 0 | **60** |
| invalidation set matched **class** `chat-row-x` | 0 | **60** |

Blink keys a `:hover` descendant invalidation set on the **rightmost compound**
of the selector, and applies the union of those sets to whichever element's
hover state changed. `.v2-nav-item:hover:not(.v2-nav-active) span` ends in a
bare tag, so `span` enters the document's hover invalidation set — and from
then on, hovering **any** element invalidates every `<span>` in its subtree.
The rule is scoped to `.v2-nav-item`; its invalidation set is not. It was
taxing `.chat-row` and `.team-row`, which have nothing to do with it.

With that one rule gone, the same crossings invalidate `chat-row-x` and
`chat-row-age` **by class** — the two elements that actually change — instead
of every span in the row.

The rest of the ladder: the other five descendant rules take it 720 → 484 (they
are correctly class-keyed; that 236 is the honest cost of the reveal). Our own
remaining 18 subject-only `:hover` rules (`.v2-btn:hover`, `.v2-tr:hover`, …)
are worth **4** records: 484 → 480. And the other 97 `:hover` rules in the
document, **including all 87 of Excalidraw's**, are worth **0**: 480 → 480.
§9.7 guessed Excalidraw's sheet was innocent because its rules are
`.excalidraw`-scoped. **Confirmed, and now measured: zero records over 30
crossings.**

### The canvas A/B, for completeness

Deleting **all 121** `:hover` rules *before* opening the canvas changes the
storm by **zero**: 5,934 → 5,934. No authored `:hover` rule is implicated in
§9.7's records at all.

---

## 6. What §9.7's records actually are

The stack in §4.2 is a hypothesis until it runs without a canvas. Three legs on
a plain `/desktop`, no canvas, no pointer, one attribute write each:

| leg | `PseudoClass` records | elements | per element |
|---|---|---|---|
| `document.documentElement.lang = "de-DE"` | **6,098** | 6,139 | **0.993** |
| `document.documentElement.lang = "en"` (the value it already had) | **6,098** | 6,139 | **0.993** |
| `document.documentElement.dir = "rtl"` | **1** | 6,139 | 0.000 |

One line of JavaScript, no canvas anywhere, reproduces §9.7's storm exactly —
same shape, same `reason: PseudoClass`, same `subtree: true`, same null
selector fields, same one-record-per-element. `lang` backs the `:lang()`
pseudo-class, so writing it on `<html>` is a pseudo-state change that Blink
propagates to every descendant element.

Two things the control legs establish that a single leg could not:

1. **It is `lang`, not `dir`.** The same Excalidraw line writes both; only one
   of them costs anything.
2. **It costs the same whether or not the value changes.** Writing `lang="en"`
   over an existing `lang="en"` costs the identical 6,098 records. Blink's
   `lang` handler does not short-circuit on an equal value — which matters for
   anyone who might try to fix this by comparing before assigning.

---

## MECHANISM ESTABLISHED

Two mechanisms, because the probe found that §9.7 had merged two different
things under one record count.

### A. §9.7's 4,636 — the canvas storm. **Not hover. Not CSS. Not ours.**

**Cause.** Excalidraw's `setLanguage` writes `document.documentElement.lang`
on mount (`60568ccb…js:1:7063`, called from its init effect via react-dom's
commit). `lang` backs the `:lang()` pseudo-class, so Blink fires a pseudo-state
change on the root and propagates it to every descendant: **one
`StyleRecalcInvalidationTracking · PseudoClass` record per DOM element, on
every canvas open.**

**Counts.** 5,934 records / 5,941 elements = 0.999 per element, identical
across four trace-category sets. §9.7's 4,636 / 4,716 = 0.983 on a document 26%
smaller — the same law. Reproduced with no canvas at all by one `lang` write:
6,098 / 6,139 = 0.993. Ruled out by measurement: deleting all 121 `:hover`
rules in the document before the toggle changes the count by 0.

**This is a NOTE, not a finding, and it is recorded as one.** The operator
decision of 2026-08-17 (`docs/plan/operator-visibility/15-ui-v3-phases.md`,
"OPERATOR DECISION — canvas first-open cost", enforced in
`phase800/README.md`) is binding: Konrad accepts ~190 ms once per page load,
canvas first-open **is not a defect and must not be re-opened as one**, and
"a measurement showing canvas-open cost is a *note*, not a finding. Reviewers
must not raise it." Nothing in section A above changes that; it closes §9.7's
question about *what the records are*, which §9.8 item 3 left open, and stops
there.

**RECOMMENDATION ONLY — not applied.** There is no selector change to propose,
because no selector is involved, and the two structural options are already
shut:

1. **Do nothing** — the decided answer. §9.6's option (c), shrinking
   `/desktop`'s document, would cut this proportionally and is **CLOSED**: no
   transcript virtualisation, capping or windowing may be undertaken to buy
   canvas-open time. Option (a) is closed for the same reason. Neither may be
   revived on the strength of this measurement.
2. **Optionally upstream it**, alongside §9.6(e)'s font-registration issue, as
   the one action that costs this project nothing. Writing `<html lang>`
   unconditionally on mount, with the value it usually already has, is a
   defect in a library embedded in someone else's document, and the cost is
   not Excalidraw's to pay — it scales with the *host* page's element count.
   Not a fix this project can schedule.
3. **Do not** attempt a local fix by patching the attribute write. The value
   is written by third-party code inside a react effect, and Blink charges for
   the write regardless of whether the value changes, so the obvious guard
   would cost the same and add a monkey-patch to maintain.

The one thing this note is good for going forward: 190 ms is the accepted
ceiling and not a licence to grow, and this storm scales linearly with
`/desktop`'s element count. The document has already grown 4,716 → 5,941
(+26%) since phase 800 measured it.

### B. The hover finding §9.7 was hoping for — it exists, and it is one rule

**Cause.** `forge-control-web/app/v2.css:291`

```css
.v2-nav-item:hover:not(.v2-nav-active) span { … }
```

ends in a bare **tagName**. Blink keys `:hover` descendant invalidation sets on
the rightmost compound and applies the union to whichever element is hovered,
so `span` is in the document-wide hover invalidation set. Every pointer
crossing of a `.chat-row` or `.team-row` therefore invalidates **every `<span>`
in that row**, not the one or two that change. The rule's `.v2-nav-item` scope
does not scope its invalidation set.

**Counts** (30-crossing sweep, same page, `base` measured twice at 1,340 both
times):

| | invalidation records | per crossing |
|---|---|---|
| before | **1,340** | 44.67 |
| after deleting `v2.css:291` alone | **720** | 24.00 |
| after deleting all six descendant rules | **484** | 16.13 |
| after deleting all 121 `:hover` rules in the document | **480** | 16.00 |

One rule is worth 620 of the 860 reducible records — 46% of the total. Every
`:hover` rule Excalidraw ships is worth 4.

**RECOMMENDATION ONLY — not applied. Phase 1300 owns the fix.**
Give the rule a class-keyed rightmost compound, so its invalidation set stops
being document-wide:

```css
/* v2.css:291 — RECOMMENDATION, NOT APPLIED */
.v2-nav-item:hover:not(.v2-nav-active) .v2-nav-item-label { … }
```

with the corresponding `className` added at the call site. The measured
prediction is explicit, so phase 1300 can check it rather than trust it: the
four `matched tagName: span` groups (240 + 70 + 60 + 60 = 430 records per
30 crossings) disappear and are replaced by two `matched class` groups of 60,
i.e. the sweep should land at **720**, and `.chat-row`/`.team-row` crossings
should stop paying for a nav rule entirely.

**Honesty about the size of B.** 44.67 → 24 invalidation records per crossing
is a real, attributable 2× reduction in style-invalidation work, and it is the
correct fix regardless. It is **not** established that it is what Konrad feels
as hover lag: 44 records per crossing is small, this instrument does not
measure milliseconds, and nothing in this round measured a frame. If the
sibling `phase1290/hover/` round has produced hover timings, B is a hypothesis
to test against them — not a lag fix to claim.

### What this round did NOT establish

- **Any millisecond figure.** By construction. See §0.
- **That fixing B removes the perceived hover lag.** See above.
- **Why `dir` is free and `lang` is not** beyond the measurement — plausibly
  Blink's directionality handling early-outs where `:lang()` does not, but the
  probe did not test that and no reader should take the parenthetical as proof.
- **Whether anything else in the app writes `<html lang>`.** Only Excalidraw's
  write was traced. If a theme or locale toggle also writes it, it pays the
  same 6,098, and nobody has looked.
