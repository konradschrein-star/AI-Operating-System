# Phase 1300 — round 1302: the bare-tag hover selector at `v2.css:291`

One rule deleted. `forge-control-web/app/v2.css` is the only application file
this round touched. No `.tsx` changed, `globals.css` was not opened for writing.

| File | What it is |
|---|---|
| `README.md` | this file |
| `pseudo-invalidation-1302-before.json` | probe output, raw and unfiltered, against a build of this worktree **with** the rule |
| `pseudo-invalidation-1302-after.json` | same probe, same recipe, against a build **without** it |
| `nav-rail-{dark,light}-{before,after}.png` | `/desktop` at 1600×950 in both themes, both builds |

---

## 0. The caveat, carried verbatim from the instrument

**This instrument counts invalidation RECORDS, not milliseconds.** It is NOT
established that this rule is what Konrad feels. Nothing in this file says the
hover lag is fixed; it says how many invalidation records a 30-crossing sweep
produced before and after. No millisecond harness was run this round, so no ms
figure appears here at all. For milliseconds on this surface the instrument is
`phase1290/hover/hover-1291.cjs`, and the reader should know that this VPS
carries an ambient **50–60 ms long-task floor with the pointer parked** —
r1291's finding, not this round's.

This is a cheap second win. It is not a substitute for the payload work.

---

## 1. Step 1 — is `.v2-nav-item` live? It is not.

Every search below was run from the worktree root
(`/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`), across
**all** repos in it — `forge-control`, `forge-control-web`,
`forge-control-mcp`, `vault-seed`, `agents`, `db`, `scripts` — excluding
`node_modules` and `.next`.

```bash
# a) the class itself, ALL file types, no extension filter, docs excluded
$ grep -rn "v2-nav" . | grep -v node_modules | grep -v '/\.next/' | grep -v '^\./docs/'
./forge-control-web/app/v2.css:284:.v2-nav-item {
./forge-control-web/app/v2.css:287:.v2-nav-item:hover:not(.v2-nav-active) {
./forge-control-web/app/v2.css:291:.v2-nav-item:hover:not(.v2-nav-active) span {

# b) the fragment, in every source file type
$ grep -rn "nav-item" --include=*.tsx --include=*.ts --include=*.jsx --include=*.js \
      --include=*.html --include=*.mdx . | grep -v node_modules | grep -v '/\.next/'
(no output)

# c) class names assembled at runtime — template literals, concatenation
$ grep -rnE '"v2-[a-z]*"?\s*\+|`v2-\$\{|v2-\$\{' --include=*.tsx --include=*.ts --include=*.js . \
    | grep -v node_modules | grep -v '/\.next/'
(no output)

# d) identifier-shaped spellings (clsx keys, camelCase helpers)
$ grep -rniE 'nav-?item|navLabel|nav-label' --include=*.tsx --include=*.ts . \
    | grep -v node_modules | grep -v '/\.next/'
./forge-control-web/app/desktop/DesktopApp.tsx:79:interface NavItem {
./forge-control-web/app/desktop/DesktopApp.tsx:86:const NAV: NavItem[] = [
./forge-control-web/app/desktop/DesktopApp.tsx:554:  const groups: Array<NavItem["group"]> = ["operator", "work", "ai"];
./forge-control-web/app/desktop/DesktopApp.tsx:756:  const railGroups: { items: NavItem[]; badged?: boolean }[] = [
```

(d)'s four hits are a **TypeScript interface named `NavItem`** and its uses —
a type, never a class name; (a) proves no string `v2-nav` exists in any `.tsx`.
Outside the stylesheet the only occurrences of `v2-nav-item` anywhere in the
worktree are in `docs/` — prose and probe fixtures describing this very rule.

`v2.css` is imported globally at `app/layout.tsx:2`, so the rule was shipped to
every page and matched nothing on any of them.

**Verdict: genuinely dead.** Per the round's instruction, all three
`.v2-nav-item` rules were deleted outright.

### Proven a second time, in the browser

The screenshot script counts rules whose `selectorText` contains `v2-nav-item`
in the live document's stylesheets, on both builds:

```
before dark:  v2-nav-item rules in live sheets = 3
before light: v2-nav-item rules in live sheets = 3
after  dark:  v2-nav-item rules in live sheets = 0
after  light: v2-nav-item rules in live sheets = 0
```

And in the probe's own sheet survey — our app bundle, `is_app_bundle: true`:

| build | chunk | rules total | with `:hover` |
|---|---|---|---|
| before | `3509fd11e190f67e.css` | 102 | 24 |
| after | `44692621e45095d7.css` | **99** | **22** |

Three rules gone, two of them `:hover`. Excalidraw's `008289500c38878d.css`
(1098 rules, 87 `:hover`) and `67ab3368c62b9f05.css` are byte-identical across
the two builds.

---

## 2. The rule, as it was and as it is

**Was** — `forge-control-web/app/v2.css:284–293`:

```css
.v2-nav-item {
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.v2-nav-item:hover:not(.v2-nav-active) {
  background: rgba(var(--v2-accent-rgb), 0.06) !important;
  box-shadow: inset 4px 0 0 rgba(var(--v2-accent-rgb), 0.25);
}
.v2-nav-item:hover:not(.v2-nav-active) span {
  color: rgba(232, 229, 224, 0.85) !important;
}
```

**Is** — a comment in their place, so the next reader does not re-add them:

```css
/* `.v2-nav-item` (three rules, incl. `.v2-nav-item:hover:not(.v2-nav-active) span`)
   removed in round 1302. No markup in either repo ever carried the class — see
   docs/plan/artifacts/phase1300/selector/README.md for the greps. The `span`
   compound put a bare tag name in Blink's document-wide hover invalidation set,
   so hovering ANY element invalidated every `span` in the document. */
```

The mechanism is r1291c's, restated: the rightmost compound of
`…:hover:not(.v2-nav-active) span` is a **bare tag name**, so Blink cannot key
the rule to a class and files `span` in the document-wide hover invalidation
set. Hovering any row anywhere then invalidates every `span` in the document —
including on pages where nothing could ever match `.v2-nav-item`.

---

## 3. Step 3 — the measured delta

Same script (`phase1290/invalidation/pseudo-invalidation.cjs`, unmodified,
default `/tmp` output — the committed 1291c evidence was not touched), same
recipe (`phase1290/hover/README.md` §7 A–E), same fixture (manager chat
`bfd1283a`), same crossing count (**30 crossings** over the chat rail, cycling
rows), two isolated builds of this worktree. `forge-control-web/.next` was
never rebuilt in place; ports `:7793` (before) and `:7795` (after) were free per
`ss -ltn` and nothing else was stopped or restarted.

**All invalidation records, 30-crossing sweep:**

| build | leg | records | per crossing | elements on `/desktop` | VPS load (1/5/15) |
|---|---|---:|---:|---:|---|
| **before** (rule present) | `base` | **1460** | 48.67 | 6355 | 2.65 / 2.27 / 2.34 |
| **before** | `base_repeat` | **1466** | 48.87 | 6355 | (same run, back to back) |
| **after** (rule deleted) | `base` | **780** | 26.00 | 6430 | 3.07 / 2.95 / 2.73 → 1.80 / 2.14 / 2.49 |
| **after** | `base_repeat` | **780** | 26.00 | 6430 | (same run, back to back) |

**Δ = −680 records over 30 crossings, −46.6%** against `base`; −686 / −46.8%
against `base_repeat`. The instrument's own repeatability is visible in the two
base legs: 1460 vs 1466 before (0.4%), 780 vs 780 after (0%).

Two supporting controls, both from the same runs:

- **In the BEFORE build, the same rule deleted at runtime** by the probe's
  `deleteRule` level 1 — one document, back to back with `base`, nothing else
  changed: **1460 → 840** (−620). Lower than the source deletion's 780 because
  level 1 removes only the `span` rule and leaves the two class-keyed
  `.v2-nav-item` rules; the source change removes all three. Same direction,
  same order of magnitude, on a single document.
- **In the AFTER build, level 1 is a no-op**: `base` 780, `v2_nav_item_span_only`
  **780** — nothing left to delete, which is what a correctly-applied source
  change should look like from inside the browser.

The two builds' documents are not identical (6355 vs 6430 elements — `/desktop`
is a live chat and the transcript grew between the runs). That drift is
recorded rather than hidden; it moves the count in the direction that would
*weaken* the result, not strengthen it.

Note on r1291c's numbers: it measured 1340 → 720 on a 5,941-element document.
This round measured 1460 → 840 for the same runtime deletion on 6,355 elements.
The absolute counts scale with the document; the proportion does not move.

---

## 4. Step 2 — the five sibling rules: recommendation, not an edit

`globals.css` was read-only for this round and was not modified. The other five
descendant `:hover` rules, with the classification the round asked for:

| # | file:line | selector | rightmost compound | bare tag? |
|---|---|---|---|---|
| 1 | `globals.css:101` | `.chat-row:hover .chat-row-x` | `.chat-row-x` | no — class |
| 2 | `globals.css:105` | `.chat-row:hover .chat-row-age` | `.chat-row-age` | no — class |
| 3 | `globals.css:119` | `.team-row:hover .team-row-controls` | `.team-row-controls` | no — class |
| 4 | `globals.css:179` | `.nav-back:hover .nav-back-arrow` | `.nav-back-arrow` | no — class |
| 5 | `globals.css:196` | same, inside `@media (prefers-reduced-motion: reduce)` | `.nav-back-arrow` | no — class |
| 6 | `v2.css:291` | `.v2-nav-item:hover:not(.v2-nav-active) span` | **`span`** | **YES — deleted this round** |

**Only #6 ended in a bare tag.** All five survivors are class-keyed, which is
the cheap form: Blink keys them to a class and they never enter the
document-wide set.

**Their measured cost**, from the same two runs (the step from level 1 to
`ours_descendant` removes exactly these five):

| build | base | −rule #6 | −all six | five siblings' share |
|---|---:|---:|---:|---:|
| before | 1460 | 840 | 600 | **240 records / 30 crossings = 8 per crossing** |
| after | 780 | 780 (no-op) | 540 | **240 records / 30 crossings = 8 per crossing** |

Identical in both builds. For contrast, rule #6 alone cost **620–680**.

**Recommendation: do not remove them.** Three reasons, in order of weight.

1. They are the **✕ / age / row-controls hover affordances R15 protects**.
   Deleting them to shave records would delete a feature to improve a
   measurement — exactly what `03-quality` §4's honesty rule forbids. This is
   not a close call.
2. They are already in the cheap form. There is no re-keying available: the
   rightmost compound is a class in all five.
3. 8 records per crossing, against 26 remaining, against 48.7 before. Even a
   free removal buys little, and this one is not free.

Two further findings from the same runs, handed forward and **not acted on**:

- **Excalidraw's 87 `:hover` rules contribute 0.** `ours_all_hover` 606 vs
  `all_hover` 600 before, 545 vs 540 after — a 5–6 record difference in both
  directions of a 780-record leg, i.e. noise. Deleting Excalidraw's entire
  hover surface buys nothing. Confirms r1291c.
- **A floor of ~18–20 records per 30 crossings survives deleting every `:hover`
  rule in every same-origin sheet** (600 before, 540 after). Whatever remains
  is not authored-selector cost.

**NOTE, explicitly not a finding of this round:** the 4,636 `PseudoClass`
records §9.7 chased are Excalidraw's `setLanguage` writing
`document.documentElement.lang` on mount — this run reproduces it again
(`lang_changed` 6511 records over 6553 elements; `dir_changed` 1). Canvas is
closed by operator decision. Recorded here because the probe emits it, not
raised as a finding.

---

## 5. Reproduce

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838

# A) worktree API on :7798 — already up. forge-control/src/index.ts never booted.
curl -s 127.0.0.1:7798/api/health

# B) isolated build (NOT forge-control-web/.next). Repeat with git stash for BEFORE.
rm -rf /tmp/p1302-after && mkdir -p /tmp/p1302-after
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/p1302-after/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/p1302-after/node_modules
cd /tmp/p1302-after
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build

# C) cookie — phase1290/hover/README.md §7 step C verbatim, into /tmp/session-cookie-1302.txt
# D) serve on a free port (ss -ltn first; never kill another round's server)
AUTH_URL=http://127.0.0.1:7795 FORGE_CONTROL_URL=http://127.0.0.1:7798 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7795 &

# E) probe from the worktree — writes to /tmp, committed 1291c evidence untouched
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-1302.txt)"
export PHASE700_BASE_URL=http://127.0.0.1:7795 PHASE1290_OUT_DIR=/tmp/p1302-out-after
node docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.cjs
```

Numbers straight out of the committed JSON:

```bash
python3 -c "
import json
for t in ['before','after']:
    d=json.load(open(f'docs/plan/artifacts/phase1300/selector/pseudo-invalidation-1302-{t}.json'))
    for k,v in d['summary']['per_crossing'].items():
        print(t,k,v['sweep30']['all_invalidation_records'])"
```

---

## 6. Gates

| Gate | Result |
|---|---|
| `(cd forge-control-web && npx tsc --noEmit)` | exit 0 |
| `(cd forge-control && npx tsc --noEmit)` | exit 0 |
| `next build` (isolated copy, post-edit) | passes — 22 routes, `/desktop` 212 B / 324 kB, unchanged from the before build |
| `node scripts/checks/no-raw-colours.cjs` | **PASS** — 222 literals / 14 files, 176 legitimate, 46 known debt, 0 unlisted. Verdict unchanged; the deleted rules used `var(--v2-accent-rgb)` and were never counted |
| `bash scripts/checks/dollar-sweep.sh` | **PASS** — 49 hits, all allowlisted. Verdict unchanged |

`pnpm build` was run against `/tmp/p1302-after` rather than in
`forge-control-web/` because §7 of the hover README forbids rebuilding
`forge-control-web/.next` in place while sibling rounds serve from it. Same
binary, same config, same lockfile (the copy symlinks the worktree's
`node_modules`).

### Both themes — nothing changed visually

`/desktop` at 1600×950, cookie-authenticated, `localStorage['forge.theme']` set
before first paint and asserted applied (`document.documentElement.dataset.theme`).

| pair | differing pixels | bounding box |
|---|---:|---|
| `nav-rail-dark-before.png` vs `nav-rail-dark-after.png` | **47** of 1,520,000 | (1341, 933)–(1348, 940) |
| `nav-rail-light-before.png` vs `nav-rail-light-after.png` | **47** of 1,520,000 | (1341, 933)–(1348, 940) |

Both diffs are the same 7×7 box in the status bar — the live clock, which
advanced between the two captures. Everything else is byte-identical. Which is
the expected result for deleting a rule that matched no element.
