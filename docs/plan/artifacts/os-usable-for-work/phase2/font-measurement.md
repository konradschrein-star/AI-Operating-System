# The "weird font" measurement (R30) — and why two of the three prescribed instruments are inert

**Task:** `B2a` (phase 2, workstream `vault`) · **Measured:** 2026-08-18T23:35:58Z – 23:38Z
**Tree:** `project/7851068b-vault` @ `c0615ae` · **Surface:** `/desktop`, MEMORY, note view
**Server:** throwaway `next start -p 7791` built from *this worktree* (`NODE_ENV=production pnpm build`)
**No source file was changed by this task.** `app/globals.css`, `app/layout.tsx` and `public/fonts` are
B2c's write-set and are untouched here.

---

## 0. Read this first: the requirement's own proving test cannot fail

R30 mandates recording `document.fonts.check(...)` and `getComputedStyle(...)`. **They are recorded
below, verbatim, exactly as asked.** But neither of them can tell a loaded font from a missing one in
this app, and R31 makes `document.fonts.check` the *proving test* for B2c's fix. I did not inherit
that claim from `B1d`; **I re-measured it in my own run, including the negative control B1d used**:

```
document.fonts.check('12px "NoSuchFontXYZ"')  →  true      # fonts reachable
document.fonts.check('12px "NoSuchFontXYZ"')  →  true      # fonts blocked
```

`true`, in both conditions, **for a font family that does not exist.** An assertion that returns the
same value at every input is not an assertion. If B2c "proves" its fix with
`document.fonts.check('12px Inter') === true`, it will pass that test on a tree where the fonts were
never fixed, on a tree where they were deleted, and on a tree where the CSS names a font nobody has
ever shipped.

**The discriminator this document reports its finding from is the WIDTH PROBE**, and §3 shows it
separating the two conditions cleanly on all three families. Recording the inert instruments satisfies
R30 as written; naming them as inert is the job, not a deviation from it.

A second discriminator surfaced during the run and is worth carrying: `document.fonts.size` (**45**
reachable vs **4** blocked). It is not in any requirement; it is cheap, and it corroborates the width
probe independently.

---

## 1. Method, and the one thing to know before reading the tables

Both conditions are the **same URL, the same build, the same viewport, minutes apart**, differing only
in whether third-party origins were reachable:

```bash
# server + all drives in ONE bash invocation (harness §5, Failure 7)
(cd forge-control-web && setsid nohup bash -c 'set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a;
  AUTH_URL=http://127.0.0.1:7791 NEXTAUTH_URL=http://127.0.0.1:7791 \
  exec ./node_modules/.bin/next start -p 7791' > /tmp/next-7791.log 2>&1 < /dev/null &)

# auth: minted and wall-asserted by the shared harness, never re-implemented
node docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs \
  --base http://127.0.0.1:7791 --path /desktop --wait-until commit --quiet \
  --cookie-out /tmp/b2a-cookie.txt --shot "$UP/$STAMP-harness-wall-cleared.png"
# → HARNESS EXIT=0  ok=true

# condition A — third-party ALLOWED
node /tmp/b2a-memory-drive.mjs --base http://127.0.0.1:7791 --cookie-file /tmp/b2a-cookie.txt \
  --allow-external --viewport 1600x2200 --shot "$UP/$STAMP-before-note-view.png" \
  --dump-html /tmp/b2a-before-dom-note-view.html --out /tmp/b2a-allowed.json     # EXIT=0

# condition B — third-party BLOCKED (the harness's default)
node /tmp/b2a-memory-drive.mjs --base http://127.0.0.1:7791 --cookie-file /tmp/b2a-cookie.txt \
  --viewport 1600x2200 --shot "$UP/$STAMP-fonts-blocked-note-view.png" \
  --out /tmp/b2a-blocked.json                                                     # EXIT=0
```

**Every run cleared the `/signin` assertion.** Nothing below was screenshotted past a failed wall check.

**Disclosure — the driver.** `b2a-memory-drive.mjs` is a throwaway interaction driver in `/tmp`, not a
second auth harness and not a fork of one: it mints nothing, it consumes the token
`browser-harness.mjs --cookie-out` already minted and asserted, and it re-asserts `/signin` itself
(exit 2, no screenshot). It exists for one structural reason — `browser-harness.mjs` evaluates
`--eval` **after** the screenshot (`browser-harness.mjs:533` vs `:546`), so it cannot select a surface
that lives behind a `localStorage` key (`DesktopApp.tsx:239`, `"forge.desktop.surface"`) before it
shoots. **Suggested harness improvement for the integration task: an `--init-script` /
`--local-storage` flag.** Filed here per `browser-harness.md` §7 rather than by forking the harness.

---

## 2. (a) + (b) `document.fonts.check` — R30's literal ask, plus the negative control

Command (identical in both conditions, inside the page):

```js
document.fonts.check('12px Inter')
document.fonts.check('12px "JetBrains Mono"')
document.fonts.check('12px "Material Symbols Outlined"')
document.fonts.check('12px "NoSuchFontXYZ"')          // negative control
```

| instrument | third-party ALLOWED | third-party BLOCKED | discriminates? |
|---|---|---|---|
| `document.fonts.check('12px Inter')` | `true` | `true` | **NO** |
| `document.fonts.check('12px "JetBrains Mono"')` | `true` | `true` | **NO** |
| `document.fonts.check('12px "Material Symbols Outlined"')` | `true` | `true` | **NO** |
| **`document.fonts.check('12px "NoSuchFontXYZ"')`** | **`true`** | **`true`** | **NO — `true` for a family that does not exist** |
| `document.fonts.status` | `"loaded"` | `"loaded"` | **NO** |
| `document.fonts.size` | `45` | `4` | **YES** (not in any requirement) |

The negative control is the whole point of this section. `document.fonts.check` returns `true` for
`NoSuchFontXYZ` because the CSS Font Loading API answers *"can I render this text with the fonts I
have, after fallback"*, not *"is this family present"*. It is behaving to spec; it is simply not the
question R30 and R31 think they are asking.

`document.fonts.status === "loaded"` is inert for the same reason: with the stylesheet request
aborted, there are no pending font loads, so the document is trivially "loaded".

`document.fonts.size` counting **45 → 4** is a genuine signal: the three Google stylesheets contribute
41 `FontFace` entries (Inter and JetBrains Mono ship many `unicode-range` subsets), and blocking them
leaves 4.

---

## 3. (c) The width probe — the instrument that actually discriminates

Per `browser-harness.md` §5. A hidden span, `font-size: 64px`, text `Konrad 0123 mmmiii`, measured with
`getBoundingClientRect().width`; the family renders iff its width differs from `serif`'s. Material
Symbols is probed with the ligature `open_in_new` at 24px, because a loaded icon font collapses that
string to **one glyph** and an absent one renders **eleven letters**.

| family | ALLOWED (px) | vs `serif` | applied? | BLOCKED (px) | vs `serif` | applied? |
|---|---|---|---|---|---|---|
| `Inter` | **609.81** | 552.91 | **true** | **552.91** | 552.91 | **false** |
| `"JetBrains Mono"` | **689.48** | 552.91 | **true** | **552.91** | 552.91 | **false** |
| `"Material Symbols Outlined"` (`open_in_new` @24px) | **23.91** | 128.25 | **true** | **128.25** | 128.25 | **false** |

Three families, two conditions, six values, and the instrument flips on every one. `552.91` is the
serif measurement: in the blocked condition **all three families measure exactly the fallback**, which
is what "the webfont did not render" looks like when you measure it instead of asserting it.

---

## 4. (d) `getComputedStyle` on real memory-surface nodes — CSS declared vs what rendered

Seven live nodes on the memory surface, sampled in the same `evaluate()` as everything above. For each
node the probe measures its full computed stack against **the same stack with its first family
removed**: if the primary is absent, the two measure identically.

| node | class | CSS-declared `font-family` (`getComputedStyle`) | primary | ALLOWED: rendered? | BLOCKED: rendered? |
|---|---|---|---|---|---|
| `body` | — | `Inter, system-ui, -apple-system, "Segoe UI", sans-serif` | `Inter` | **true** (609.81 vs 666.88) | **false** (666.88 vs 666.88) |
| note body / reader pane | — | `Inter, system-ui, -apple-system, "Segoe UI", sans-serif` | `Inter` | **true** | **false** |
| first `.mono` span | `mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | `JetBrains Mono` | **true** (689.48 vs 691.84) | **false** (691.84 vs 691.84) |
| counts rail `"287 notes"` (9px) | `mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | `JetBrains Mono` | **true** | **false** |
| tag chip | `mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | `JetBrains Mono` | **true** | **false** |
| list row | — | `Inter, system-ui, -apple-system, "Segoe UI", sans-serif` | `Inter` | **true** | **false** |
| first `.ms` icon span | `ms` | **`"Material Symbols Outlined"`** — *one family, no fallback list* | `Material Symbols Outlined` | n/a (see below) | n/a |

**`getComputedStyle().fontFamily` returned the identical string in both conditions for all seven
nodes.** It echoes the cascade, never the rasteriser. That is R30's third instrument and it is the
third one that cannot answer the question.

**The `.ms` row is the mechanism.** `globals.css:29` declares:

```css
.ms {
  font-family: 'Material Symbols Outlined';   /* ← no fallback, no second family */
  ...
}
```

The per-node "remove the primary" probe is undefined for it (there is nothing after the primary to
compare against), which is itself the finding: **every other class in this app degrades to a fallback;
the icon class degrades to nothing and the browser renders the ligature text literally.** §5 measures
that directly.

---

## 5. (f) Material Symbols: icons, or their literal names?

**This is the finding that matches Konrad's words.** Every `.ms` node on the surface, measured as
`getBoundingClientRect().width / font-size`. A rendered glyph is ~1 em wide; the literal word is many.

| ligature | font-size | ALLOWED: box | ALLOWED: em | BLOCKED: box | BLOCKED: em | blocked verdict |
|---|---|---|---|---|---|---|
| `search` | 14px | 14.02px | **1.00** | 35.77px | **2.55** | LITERAL WORD |
| `light_mode` | 16px | 16.00px | **1.00** | 72.89px | **4.56** | LITERAL WORD |
| `settings` | 15px | 15.00px | **1.00** | 45.84px | **3.06** | LITERAL WORD |
| `hub` | 14px | 14.02px | **1.00** | 21.00px | **1.50** | LITERAL WORD *(see caveat)* |
| `graph_3` | 14px | 14.02px | **1.00** | 45.89px | **3.28** | LITERAL WORD |
| `search` (2nd) | 14px | 14.02px | **1.00** | 35.77px | **2.55** | LITERAL WORD |

```
ms nodes on the surface           : 8   (both conditions)
classified LITERAL_WORD, allowed  : 0 / 8
classified LITERAL_WORD, blocked  : 7 / 8
```

**Caveat on my own instrument, disclosed rather than buried.** The automatic classifier used a
threshold of `box_width > font_size × 2.2`, and `hub` — three letters — measures 1.50 em, below it. The
classifier therefore called `hub` a GLYPH. **The screenshot shows it is not**: the rail header in
`before-fonts-blocked-note-view.png` reads *"hub Obsidian vault"*. The true blocked count is **8 of 8**;
my threshold under-reports short ligatures and a reviewer re-running it will get 7. The number to trust
is the em ratio per row, not the verdict column.

**What the screenshots show.** In `before-fonts-blocked-note-view.png` the surface reads
`hub Obsidian vault`, `graph_3 3D net`, `settings SETTINGS`, `description Vault › Daily/2026-08-19.md`,
`open_in_new Open in Obsidian`, `search search everything`, and `light_mode` spilling past the right
edge of the window. In `before-note-view.png`, same build, same minute, every one of those is an icon.

That is what "weird font" looks like. A serif fallback is a subtle change a busy operator might not
mention; **the word `description` appearing next to a filename is not.**

---

## 6. (e) Network status of all three font requests

Taken from the harness's own `failedRequests` / `blockedExternal` arrays and the driver's equivalents —
not inferred from the pixels.

**Third-party ALLOWED:**
```json
{ "blockedExternal": 0, "failedRequests": [], "consoleErrors": 1 }
```
All three stylesheets loaded. (`layout.tsx:39-50` emits **two** `<link>` elements: one combined
Inter + JetBrains Mono request, one Material Symbols request — three families, two requests.)

**Third-party BLOCKED** — both requests fail, and the harness names them:
```json
"blockedExternal": [
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap",
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,200,0,0&display=swap"
],
"failedRequests": [
  { "url": "…Inter…JetBrains+Mono…", "failure": "net::ERR_FAILED" },
  { "url": "…Material+Symbols+Outlined…", "failure": "net::ERR_FAILED" }
]
```

**Note for every phase-2 reader:** blocking is the harness's **default**, and the literal-word icons it
produces are an **artefact of that default**, not in themselves proof of Konrad's defect
(`browser-harness.md` §5, Failure 5). Condition B is a *deliberate simulation* of the failure, run to
establish what the failure looks like and to give B2c a number to beat. Condition A is what this VPS
does when nothing interferes.

---

## 7. The mechanism — established, and one inherited claim partly refuted

### 7.1 Nothing in this app self-hosts anything

```bash
$ grep -rn "@font-face" forge-control-web/app forge-control-web/public
grep: forge-control-web/public: No such file or directory      # exit 2 — the directory does not exist
$ ls forge-control-web/public
ls: cannot access 'forge-control-web/public': No such file or directory
```

Zero `@font-face` rules. No `public/` directory at all. All three families are named in
`globals.css:13,23,29` and served exclusively from `fonts.googleapis.com` via `layout.tsx:46,50`.
**A third party decides whether this UI renders.**

`display=swap` is present on both stylesheet URLs, so there is no FOIT once the CSS arrives — but the
`<link rel="stylesheet">` is itself **render-blocking**, which is the hazard `browser-harness.md` §5
Failure 4 measured.

### 7.2 The IPv6 half of Failure 4 is still true. The stall it caused is NOT reproducing today.

`browser-harness.md` §5 Failure 4 recorded `000 / 20.002s` on the default resolver and `200 / 0.220s`
on `-4`, and attributed it to an AAAA record with no working IPv6 egress. **Confirmed and refuted, in
part, today:**

```bash
$ getent ahosts fonts.googleapis.com | head -6
64.233.161.95           STREAM fonts.googleapis.com
64.233.161.95           DGRAM
64.233.161.95           RAW
2a00:1450:4010:c01::5f  STREAM                        # the AAAA record is still there
...

$ curl -6 -sS -m 8 -o /dev/null -w '%{http_code} %{time_total} %{remote_ip}\n' 'https://fonts.googleapis.com/css2?family=Inter'
curl: (7) Failed to connect to fonts.googleapis.com port 443 after 2 ms: Couldn't connect to server
000 0.002445                                          # IPv6 egress IS still dead
```

**CONFIRMED:** the host still publishes a AAAA record and this box still has no IPv6 egress.

**REFUTED (today):** the 20-second stall did not reproduce once. Eight sequential default-resolver
requests, then the two real stylesheet URLs from `layout.tsx`:

```bash
$ for i in $(seq 1 8); do curl -sS -m 25 -o /dev/null \
    -w "  run$i %{http_code} %{time_total} %{remote_ip}\n" 'https://fonts.googleapis.com/css2?family=Inter'; done
  run1 200 0.220706 64.233.161.95        run5 200 0.225270 74.125.131.95
  run2 200 0.231238 64.233.161.95        run6 200 0.232898 64.233.161.95
  run3 200 0.227102 64.233.161.95        run7 200 0.226430 64.233.161.95
  run4 200 0.224468 64.233.161.95        run8 200 0.230093 74.125.131.95

$ curl -sS -m 25 -o /dev/null -w '  Inter+JBMono %{http_code} %{time_total} %{remote_ip}\n' \
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap'
  Inter+JBMono 200 0.228444 64.233.161.95
$ curl -sS -m 25 -o /dev/null -w '  MaterialSymbols %{http_code} %{time_total} %{remote_ip}\n' \
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,200,0,0&display=swap'
  MaterialSymbols 200 0.228855 64.233.161.95
```

**10 for 10, HTTP 200, ~0.23 s, every one over IPv4.** The difference from 2026-08-18 is that the
resolver is currently returning the A record first. Nothing was fixed; the coin is landing the other
way. `curl -6` failing in **2 ms** rather than timing out also means Happy Eyeballs currently falls
back instantly instead of stalling.

**So the honest statement of the mechanism is not "the CDN is down".** It is: *the render path of every
surface in this product depends on a third-party host whose address selection this box does not
control, with no local copy of any font and — for the icon font — no fallback family at all.* The
failure is intermittent by construction, and §5 measured exactly how ugly it is when it trips.

### 7.3 What this measurement cannot see, stated plainly

**Nothing here measures Konrad's own browser.** The complaint originated on his machine, and this run
observed a headless Chromium on the VPS. The blocked condition is a *simulation* of what his browser
would show if `fonts.googleapis.com` did not answer for it — and the population of reasons it might
not is large and entirely outside this repo: an ad-blocker or privacy extension (`fonts.googleapis.com`
is on common blocklists, and "block remote fonts" is a one-click setting in uBlock Origin and a default
in some Brave configurations), a corporate or GDPR-motivated DNS filter, a captive network, or the same
AAAA/IPv6 coin-flip landing badly on his side.

I am not asserting which of those it was. I am asserting that **the app has no defence against any of
them**, and that the failure mode they all share is a pixel-exact match for the words he used.

---

## 8. R32 baseline, recorded for the gate

```bash
$ grep -n "fontFamily" forge-control-web/app/desktop/MemorySurface.tsx
871:                  fontFamily: "inherit",
```

One occurrence, and it is `inherit` — the only value R32 permits. B2d must not add another.

---

## What B2c must do

### **(i) SELF-HOST. All three families.**

The measurement supports it, and the honest form of that support is worth stating precisely, because it
is *not* "the CDN is broken":

- **Which families:** all three — `Inter`, `JetBrains Mono` and **`Material Symbols Outlined`**. The
  icon font is the loudest third and the one nothing in the corpus had tested on this surface. Fixing
  the two text faces and leaving the icon font on the CDN would fix the quiet two thirds of the defect
  and ship the visible third.
- **The mechanism, named:** `forge-control-web` self-hosts nothing (no `public/`, zero `@font-face`),
  so all three families arrive over two render-blocking `<link>`s to `fonts.googleapis.com`
  (`layout.tsx:46,50`). `globals.css:29` gives `.ms` **a single family and no fallback**, so when that
  host does not answer, every icon on every surface renders as its ligature name. This box still
  publishes an unreachable AAAA route to that host (`curl -6` → `000`, connect failure in 2 ms), and
  the harness measured a 20 s render-blocking stall from it on 2026-08-18.
- **The honest counterweight, so nobody is misled:** from *this* VPS, *today*, the fonts load. 10/10
  requests returned 200 in ~0.23 s and the 20 s stall did not reproduce once. **A strict reading of
  R31's first clause — "if the measurement shows the webfonts fail or race" — is not satisfied by the
  network measurement on this host.** It is satisfied by the *dependency*: a UI whose legibility is
  decided by a third party, with no local copy and no icon fallback, and whose degraded state is a
  pixel-match for the reported complaint. Self-hosting is the only intervention that makes §5's
  screenshot unreachable. It costs three font files and one CSS block, and it is reversible by a single
  `git revert` (`phase2-plan.md` §6).
- **Why not branch (ii):** branch (ii) requires *naming the real cause instead*. I have no candidate.
  `MemorySurface.tsx` introduces no font of its own (§8 — one `fontFamily`, and it is `inherit`), the
  computed stacks are correct on all seven sampled nodes, and no other mechanism on this surface
  produces a "weird font". Declining to self-host would leave the complaint with no named cause and no
  fix.

### The proving test B2c must pass — and the pre-fix numbers to beat

R31's own proving test (`document.fonts.check` returns `true` with the network blocked) **is already
true at HEAD, before any fix, for a font that does not exist.** It cannot be the gate. Use this instead:

> **THE WIDTH PROBE RETURNS `true` FOR ALL THREE FAMILIES WITH THIRD-PARTY ORIGINS BLOCKED.**

Run it in the harness's **default** (blocking) mode, on `/desktop` → MEMORY, same probe as §3. It must
return `false` on the pre-fix tree — which is measured, here, and is the row on the left. If B2c cannot
reproduce these pre-fix `false`s before it starts, its "after" proves nothing.

| probe (64px, `Konrad 0123 mmmiii`; Material Symbols: `open_in_new` @24px) | **PRE-FIX, BLOCKED (must be reproduced)** | **POST-FIX, BLOCKED (must be achieved)** |
|---|---|---|
| `w("Inter")` vs `w("serif")` | `552.91` vs `552.91` → **`false`** | differ → **`true`** (expect `w("Inter") ≈ 609.81`) |
| `w('"JetBrains Mono"')` vs `w("serif")` | `552.91` vs `552.91` → **`false`** | differ → **`true`** (expect `≈ 689.48`) |
| `w('"Material Symbols Outlined"', "open_in_new", 24)` vs `w("serif", …)` | `128.25` vs `128.25` → **`false`** | differ → **`true`** (expect `≈ 23.91`, i.e. one glyph) |
| every `.ms` node's `box_width / font_size` | **8 of 8 > 1.4 em** (literal words) | **8 of 8 ≈ 1.00 em** (glyphs) |
| `document.fonts.size` | `4` | ≥ the number of `@font-face` rules shipped |

Corroborate with `document.fonts.size` and a screenshot; do **not** report a pass from
`document.fonts.check`, and if the post-fix `.ms` check is automated, do not reuse my 2.2 em threshold
— it misclassifies `hub` (§5).

Two further notes for B2c, both cheap and both load-bearing:

1. Keep `font-display: swap` on every `@font-face`, and **give `.ms` a fallback family** so the worst
   case is a wrong-looking glyph rather than the word `description`.
2. `Inter` and `JetBrains Mono` ship as many `unicode-range` subsets (that is the 45 → 4 in §2). Self-
   hosting a single Latin subset per family is fine and is what changes the count; just do not assert a
   specific `document.fonts.size` value in a test, because it is a function of how many files you ship.
