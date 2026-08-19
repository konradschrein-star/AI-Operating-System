# The font decision (R31/R32), and the client binding it shipped beside

**Task:** `B2c` (phase 2, workstream `vault`) · **Executed:** 2026-08-19T00:36Z – 02:10Z
**Tree:** `project/7851068b-vault` · **Commits:** `b6eb201` (api-vault.ts), `a810074` (fonts)
**Branch taken: (i) SELF-HOST — all three families.**

---

## 0. The decision, and who made it

`font-measurement.md`'s closing section — *"What B2c must do"* — closes with **(i) SELF-HOST. All
three families.** I did not re-open that judgement; I executed it, and then I measured the result
against the pre-fix numbers B2a published so the claim "this fixed something" is a comparison rather
than an assertion.

**Extending R31 to Material Symbols Outlined is deliberate, and the reason is on the record:**
R31 names only Inter and JetBrains Mono. Fixing the two text faces and leaving the icon font on a
third-party CDN would have fixed the quiet two thirds of the defect and shipped the loudest third
exactly as it was — `globals.css:29`'s `.ms` declares **one family and no fallback**, so when
`fonts.googleapis.com` does not answer, every icon on every surface renders as its ligature name. The
word `description` next to a filename is the best match for the words Konrad actually used.

---

## 1. The proving test, both states, and why it is not the one R31 names

R31 makes `document.fonts.check` the proving test. **It cannot fail.** B2a measured it returning
`true` for `NoSuchFontXYZ` — a family that does not exist — in both conditions, and I re-measured the
same thing in my own run at both commits. It is recorded below because R30 asks for it in writing, and
it is recorded **beside the note that it returned the same value in both states and is therefore not
the evidence.**

The discriminator is B2a's **width probe**, run with third-party origins **BLOCKED** — the browser
harness's default, which for this one measurement is the instrument rather than a nuisance.

### The two runs

Identical driver, identical viewport (1600×2200), identical surface (`/desktop` → MEMORY), minutes
apart. The only difference is the commit the server was built from.

```bash
# PRE-FIX  — built at b6eb201 (api-vault.ts only; no CSS, no layout, no public/)
# POST-FIX — built at a810074 (the font commit)
(cd forge-control-web && setsid nohup bash -c 'set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a;
   AUTH_URL=http://127.0.0.1:7794 NEXTAUTH_URL=http://127.0.0.1:7794 \
   exec ./node_modules/.bin/next start -p 7794' > /tmp/next-7794.log 2>&1 < /dev/null &)

node docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs \
  --base http://127.0.0.1:7794 --path /desktop --wait-until commit --quiet \
  --cookie-out /tmp/b2c-cookie.txt                      # HARNESS EXIT=0  ok=true

node /tmp/b2c-drive.mjs --base http://127.0.0.1:7794 --cookie-file /tmp/b2c-cookie.txt \
  --surface memory --eval-file /tmp/width-probe.js --viewport 1600x2200 \
  --shot "$UP/$STAMP-fonts-blocked-{before,after}.png" --out /tmp/b2c-{prefix,postfix}-blocked.json
```

> **Disclosure — the driver.** `/tmp/b2c-drive.mjs` is a throwaway interaction driver, not a second
> auth harness: it mints nothing, it consumes the token `browser-harness.mjs --cookie-out` already
> minted **and wall-asserted**, and it re-asserts `/signin` itself (exit 2, no screenshot). It exists
> for the structural reason B2a already filed — `browser-harness.mjs` has no `--init-script`, so it
> cannot select a surface that lives behind a `localStorage` key before it shoots. Both runs cleared
> the `/signin` assertion and exited 0.

### THE DISCRIMINATING INSTRUMENT — width probe, third-party BLOCKED

| probe (64 px, `Konrad 0123 mmmiii`; Material Symbols: `open_in_new` @24 px) | **PRE-FIX `b6eb201`** | **POST-FIX `a810074`** |
|---|---|---|
| `w("Inter")` vs `w("serif")` | `552.91` vs `552.91` → **`false`** | **`609.81`** vs `552.91` → **`true`** |
| `w('"JetBrains Mono"')` vs `w("serif")` | `552.91` vs `552.91` → **`false`** | **`689.48`** vs `552.91` → **`true`** |
| `w('"Material Symbols Outlined"')` vs `w("serif")` | `128.25` vs `128.25` → **`false`** | **`23.91`** vs `128.25` → **`true`** |
| `.ms` nodes measured `box_width / font_size` | **8 of 8 above 1.4 em — literal words** | **0 of 8 — every one exactly `1.00` em** |
| `blockedExternal` | 2 URLs (both `fonts.googleapis.com` stylesheets) | **`[]` — nothing third-party is requested at all** |
| `failedRequests` | (the same two) | **`[]`** |

Every post-fix number lands on B2a's published expectation (`≈609.81`, `≈689.48`, `≈23.91`, i.e. one
glyph). **The pre-fix state fails exactly the test the post-fix state passes**, on the same six
measurements, so the fix is a change in behaviour rather than a change in wording.

The `.ms` per-node detail, both states:

| ligature | font-size | PRE-FIX box / em | POST-FIX box / em |
|---|---|---|---|
| `search` | 14 px | 35.77 / **2.55** | 14.02 / **1.00** |
| `light_mode` | 16 px | 72.89 / **4.56** | 16.00 / **1.00** |
| `settings` | 15 px | 45.84 / **3.06** | 15.00 / **1.00** |
| `hub` | 14 px | 21.00 / **1.50** | 14.02 / **1.00** |
| `graph_3` | 14 px | 45.89 / **3.28** | 14.02 / **1.00** |
| `search` (2nd) | 14 px | 35.77 / **2.55** | 14.02 / **1.00** |
| `description` | 13 px | 57.77 / **4.44** | 13.02 / **1.00** |
| `open_in_new` | 13 px | 70.05 / **5.39** | 13.02 / **1.00** |

**I did not reuse B2a's 2.2 em classifier threshold**, which it disclosed as misclassifying the
three-letter `hub` at 1.50 em. At a 1.4 em threshold the pre-fix count is **8 of 8**, which is what
B2a's own screenshot shows and what its verdict column under-reported as 7.

### R30's literal ask, recorded — and recorded as inert

| instrument | PRE-FIX, blocked | POST-FIX, blocked | discriminates? |
|---|---|---|---|
| `document.fonts.check('12px Inter')` | `true` | `true` | **NO** |
| `document.fonts.check('12px "JetBrains Mono"')` | `true` | `true` | **NO** |
| `document.fonts.check('12px "Material Symbols Outlined"')` | `true` | `true` | **NO** |
| `document.fonts.check('12px "NoSuchFontXYZ"')` | `true` | `true` | **NO — `true` for a family that does not exist** |
| `document.fonts.status` | `"loaded"` | `"loaded"` | **NO** |
| `document.fonts.size` | `4` | `7` | yes, but it is a function of how many files ship — do not assert a value |

**`document.fonts.check` returned the identical value in both states, including for a font nobody has
ever shipped. It is recorded to satisfy R30 and it is not the evidence for R31.** Reporting a pass
from it would have been a pass available on a tree where nothing was fixed.

### The screenshot

`/opt/ai-os/uploads/25175c0e7d69/20260819T004336Z-fonts-blocked-after.png` — the memory surface with
third-party origins **blocked**, read back into the run transcript. Icons are icons: the rail reads
`⌂ Obsidian vault`, the breadcrumb carries a document glyph, `Open in Obsidian` carries an
open-in-new glyph. Compare `phase2/before-fonts-blocked-note-view.png` (B2a's, same condition),
where those same three read `hub Obsidian vault`, `description Vault › …` and
`open_in_new Open in Obsidian`.

---

## 2. What shipped

```
forge-control-web/app/globals.css                              +68   three @font-face blocks
forge-control-web/app/layout.tsx                               ±25   3 <link>s + 2 preconnects removed
forge-control-web/public/fonts/inter-variable-latin.woff2       48,256 bytes
forge-control-web/public/fonts/jetbrains-mono-variable-latin.woff2  40,404 bytes
forge-control-web/public/fonts/material-symbols-outlined.woff2 359,460 bytes
forge-control-web/public/fonts/LICENSE.md                       provenance, sha256s, licences
```

`forge-control-web/public/` **did not exist** before this commit.

Four decisions inside that diff worth naming:

1. **`font-display: swap` on all three** (R31 names it). Left as `swap` rather than `block` for the
   icon font even though `block` would remove the brief flash of literal words during load: R31 names
   `swap`, the file is now same-origin so the window is milliseconds, and quietly substituting a
   different value for the one the requirement names is how a requirement stops meaning anything.
   Worth revisiting deliberately, not silently.
2. **`unicode-range` on the two text faces, NONE on the icon font.** The icon glyphs live in the
   Private Use Area and are reached by ligature; restricting the range would break the substitution
   and put the literal words straight back. That is a trap I nearly walked into by symmetry.
3. **The Material Symbols file is a STATIC INSTANCE**, not a variable face — requesting the pinned
   axes `opsz,wght,FILL,GRAD@20,200,0,0` (exactly what `layout.tsx` linked) makes Google serve one
   instantiated weight. Its `@font-face` therefore declares `font-weight: 200`. `.ms`'s existing
   `font-variation-settings: 'FILL' 0, 'wght' 200, 'opsz' 20` is **inert against it** and was kept
   anyway: it is correct, it costs nothing, and it keeps working if the file is ever swapped for the
   variable build. The post-fix measurement above is what proves the icons still render as icons.
4. **`-4` on every `curl`.** `fonts.googleapis.com` publishes an AAAA record this host cannot reach.
   Bare `curl` can stall 20 s and return `000`; `curl -4` returned `200` in ~0.22 s, ten times out of
   ten. A modern browser User-Agent is equally load-bearing or Google serves a legacy format.

**R32 — no hardcoded font-family was introduced.** The families keep resolving through the existing
`.body` / `.mono` / `.ms` classes. This commit changed **where the bytes come from**, not what
anything is styled with.

```
$ grep -n "fontFamily" forge-control-web/app/desktop/MemorySurface.tsx
1537:  fontFamily: "inherit",
1572:  fontFamily: "inherit",
1694:  fontFamily: "inherit",
```
Three occurrences, all `inherit` — the only value R32 permits. (B2a's baseline recorded one; the two
new ones are the conflict UI's side-by-side `<pre>` blocks, which inherit exactly as the reader's
`<pre>` always did.)

**No colour literal** is introduced anywhere in the diff — `no-raw-colours.cjs`: `PASS — 221
literal(s) across 14 file(s), all accounted for (178 legitimate, 43 known debt, 0 unlisted)`, and
`MemorySurface.tsx`'s known-debt count went **8 → 5**. **Zero new dependencies**; `pnpm-lock.yaml` is
untouched.

---

## 3. A REGRESSION THIS CHANGE INTRODUCES, MEASURED, AND NOT MINE TO FIX

**`/fonts/*.woff2` is behind the auth wall.**

```
$ curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7794/fonts/inter-variable-latin.woff2
307
```

`forge-control-web/middleware.ts:21`'s matcher is `["/((?!_next/static|_next/image|favicon.ico).*)"]`
— it does not exclude `/fonts`, so an **unauthenticated** request for a self-hosted font redirects to
`/signin`. Consequences, measured rather than assumed:

- **The authenticated app is unaffected.** Every measurement in §1 was taken through the wall with a
  real session cookie, and all three families resolved.
- **The sign-in page is the one casualty.** `app/signin/page.tsx` uses `className="mono"` at two
  sites, so its monospace text will now fall back to `ui-monospace`. It renders **no `.ms` icons**
  (`grep` finds none), so nobody sees a literal word.
- Before this commit that page pulled its font from the CDN, so this is a real if small change.

**The fix is one line — `|fonts` added to that matcher — and `middleware.ts` is not in my write_set.**
It belongs to the `surfaces` workstream / the phase-7 integration task. Filed here, reported to the
manager chat, and deliberately not touched.

---

## 4. Job 1 — `forge-control-web/app/api-vault.ts` (commit `b6eb201`, 437 lines)

A NEW file. **`app/api.ts` was not edited** — every lane conflicts on it (02-architecture.md §0.3).

It exports `fetchVaultFile`, `saveVaultFile`, `fetchMemoryCountsLabelled`, `fetchWikilinkGraph`,
`fetchMemoryNoteV2` and their types, plus `VaultApiError`. Three things about it are load-bearing:

- **Its own error helper.** `api.ts:29`'s `getJson` throws `${status} ${statusText}` and discards the
  body — and every diagnostic `routes/vault.ts` produces lives in that body's `.error`. Throwing it
  away makes R24 unsatisfiable in the UI no matter how the UI is written. `VaultApiError` carries the
  status, the statusText, the path **and** the server's message, and exposes `status` as a property so
  a caller can branch on it. §5 of `editor-browser-proof.md` shows both halves rendered on screen.
- **`saveVaultFile` has no retry parameter and no re-read.** 200 → `{kind:"ok"}`; 409 →
  `{kind:"conflict"}`; anything else throws. A 400 can never be smuggled back as a conflict or a
  success.
- **N1 holds throughout**: no `?? []`, no `?? 0`, no catch-and-default. The two `try/catch` blocks in
  the file both convert a parse failure into a *more precise error*, never into a value.

### CONTRACT DISCREPANCY — the plan's §4.3 sketch is missing two fields, and they matter

`phase2-plan.md` §4.3 and this task's brief describe `VaultConflict` as three fields. **The server
sends five** (`routes/vault.ts:217-227`): also `current_content_truncated` and `current_bytes`. The
409 body is capped at **8 Mi UTF-16 code units** (`MAX_CONFLICT_CONTENT`), so `current_content` may be
a **prefix** of what is on disk.

This is not cosmetic. A conflict UI that offers a truncated prefix back as "take theirs" **destroys
the tail on the next save**. `api-vault.ts` types all five and requires all five — a 409 missing any
of them throws rather than defaulting — and `MemorySurface` disables "Take theirs" with a stated
reason when the flag is set. **I followed the code, not the brief, as instructed, and this is the
report that the two disagreed.**

### Debt for phase 7's integration task, recorded here as instructed

Three exports in `app/api.ts` are now stale and were deliberately left exactly as they are:

| export | line | why it is stale |
|---|---|---|
| `fetchMemoryCounts` | `api.ts:468` | typed `Record<MemoryCategory \| "all", number>`. B1c removed the bare `all` key and replaced the category totals with `folder_counts` (R15). The type describes a payload the server no longer sends. |
| `KnowledgeGraphData` | `api.ts:514` | carries `triples: number`, gone from the response; `GraphLink.predicate` is now `kind`. |
| `fetchMemoryGraph` | `api.ts:519` | returns the above. |

After this round **nothing imports any of them** — `MemorySurface` and `MemoryGraph3D` were their only
consumers and both now import `api-vault.ts`. They are dead code with a misleading type, safe to
delete in one commit at integration, and unsafe for five concurrent lanes to each delete separately.

---

## 5. Verification actually run

```
cd forge-control-web && pnpm install --frozen-lockfile --prod=false   # no "- typescript" in the output
npx tsc --noEmit                                                       # exit 0
node scripts/checks/no-raw-colours.cjs                                 # PASS, 0 unlisted
NODE_ENV=production pnpm build                                         # succeeded — a bad @font-face
                                                                       #   src is build-time-silent
git diff --stat                                                        # exactly the write_set
```

The build was run **after** the font change and again after each component change; a broken
`@font-face` `src` does not fail a build, which is why the width probe above — not the build — is
what proves the bytes arrive.
