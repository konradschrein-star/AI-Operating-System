# Phase 3 — AFTER verification

**Project:** `os-usable-for-work` · phase 3 (round 300) · workstream `surfaces`
**Task:** B3b — honest NOT BUILT placeholder and nav markers, the CODE half
**Requirements:** R38, R39, R40, R43 + N1–N10
**Date:** 2026-08-18 · **Run:** `c38b6815-1bdd-4d9f-b5b6-d173edcde78d` (`FORGE_RUN_ID=c38b68151bdd`)
**Worktree:** `/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--surfaces`, branch `project/7851068b-surfaces`
**Before state:** `reproduction-before.md` · **Determinations:** `surface-determinations.md`

Every number below carries the command that produced it (N10). Nothing here was recalled.

---

## 1. What changed, in one paragraph

`PlaceholderSurface` no longer renders a tidy card with feature bullets. It renders a warning banner
whose first sentence contains the literal words **"not built yet"**, followed by three labelled
statements — what the screen would be **for**, what it **needs in order to exist**, and **whether
anyone is coming**. `PLACEHOLDER_SURFACES` was retyped to carry those three statements instead of
`items`, and its copy is quoted from `surface-determinations.md` so the screen and the document cannot
drift. Four nav entries (`goals`, `journal`, `map`, `library`) carry a new optional
`unbuilt?: true` in `nav-items.ts`, rendered as a marker at **all three** nav sites. SEARCH gets
different words, because its backend is built and answering.

**No feature was built.** No route, no table, no data fetch, no new surface component.

---

## 2. The server that was photographed, and the wall that nearly wasn't up

Per N4/N5 this is a build task, so the target is a throwaway `next start` served **from this
worktree**. `/opt/forge-ai-os` was read exactly once — `.env.local`, for `AUTH_SECRET` — and never
written.

```bash
cd forge-control-web && pnpm install --frozen-lockfile --prod=false
#   → "Lockfile is up to date … Already up to date", nothing removed.
#   Verified positively rather than off the summary line:
node -e 'console.log(require("typescript/package.json").version)'   # 5.7.2
node -e 'console.log(require("next/package.json").version)'         # 15.1.3

pnpm build && cat .next/BUILD_ID          # 68hufrSEsqciNXX1IIWbH
#   B3a photographed fKeri3s5ko0R6OK2C4Uf2. A different BUILD_ID is the proof
#   that these frames are of THIS code: `next start` does not watch files.

set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
setsid env AUTH_URL=http://127.0.0.1:7783 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7783 > /tmp/next-7783-b3b.log 2>&1 < /dev/null &
```

Port **7783**, chosen after checking 7780–7787 were free; five other phases run concurrently.

### 2.1 THE FAILURE THIS TASK ACTUALLY HIT, and the assertion added because of it

A first full verification run went green — **against a server with the auth wall down.**

The restart line was written as `cd forge-control-web && set -a; . …/.env.local; set +a`. The `&&`
binds to `set -a` alone. The `cd` failed (the shell was already inside `forge-control-web`), so
`set -a` never ran, the variables were sourced but **not exported**, and `next start` inherited no
`AUTH_SECRET`. `auth()` then throws inside the middleware and the request **falls through to the
page**:

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7783/desktop   # anonymous
200
$ tail -2 /tmp/next-7783-b3b.log
[auth][error] MissingSecret: Please define a `secret`. …
```

The whole app was being served to anybody. Every `/signin` guard downstream was **inert** — the
session cookie was never consulted, so a run that "asserted it was past the wall" had asserted
nothing. `assertServerUp()` had tolerated it because it accepted `307 or 200`, copied from B3a's
harness where the same tolerance sits.

`verify-phase3.cjs` now **requires a 307** to an anonymous `GET /desktop` and names `MissingSecret`
and the `cd &&` trap in the failure message. The run below was redone from a correctly-restarted
server:

```bash
$ curl -s -o /dev/null -w 'anon:   %{http_code} %{redirect_url}\n' http://127.0.0.1:7783/desktop
anon:   307 http://127.0.0.1:7783/signin
$ curl -s -o /dev/null -w 'authed: %{http_code}\n' \
    -H "Cookie: authjs.session-token=$(cat /tmp/session-cookie-phase3b.txt)" \
    http://127.0.0.1:7783/desktop
authed: 200
$ grep -c MissingSecret /tmp/next-7783-b3b.log
0
```

**`shots-phase3.cjs` still carries the `307 or 200` tolerance.** It is B3a's file and outside this
task's write-set, so it was not edited; whoever next owns that harness should tighten it the same way.
Flagged for the reviewer rather than fixed silently.

**There are two salts** (corpus commit `3f98e67`): this http server takes `authjs.session-token`;
the live UI, whose `AUTH_URL` is `https://os.schreinercontentsystems.com`, takes
`__Secure-authjs.session-token`. Both harnesses name the salt first in their failure message.

---

## 3. The R38 acceptance test, flipped

B3a wrote the assertion and ran it against the unchanged code, where it fired on the first surface and
exited 1 (`reproduction-before.md` §7.2). The **same command**, same file, against this build:

```bash
$ env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
    FORGE_RUN_ID=c38b68151bdd BASE_URL=http://127.0.0.1:7783 \
    COOKIE_FILE=/tmp/session-cookie-phase3b.txt SHOT_PHASE=after EXPECT_NOT_BUILT=1 \
    node docs/plan/artifacts/os-usable-for-work/phase3/shots-phase3.cjs
preflight: http://127.0.0.1:7783/desktop → 307
  goals: tagVisible=true hasNotBuilt=true
  journal: tagVisible=true hasNotBuilt=true
  map: tagVisible=true hasNotBuilt=true
  library: tagVisible=true hasNotBuilt=true
  search (localStorage only): tagVisible=true hasNotBuilt=false stored="search"
OK — 5 shots
$ echo $?
0
```

The column of ✘ that was the phase-3 defect in one measurement is now ✔ on all four — **and `search`
is still `false`, deliberately**. From `env -i`, so nothing inherited from this task's shell is
load-bearing.

| Surface | `/not built/i` BEFORE | AFTER | bullets BEFORE | AFTER |
|---|---|---|---|---|
| goals | ✘ | **✔** | 3 | 0 |
| journal | ✘ | **✔** | 3 | 0 |
| map | ✘ | **✔** | 4 | 0 |
| library | ✘ | **✔** | 4 | 0 |
| search | ✘ | **✘ — correct** | 4 | 0 |

---

## 4. `verify-phase3.cjs` — 76 assertions, all pass

```bash
$ FORGE_RUN_ID=c38b68151bdd BASE_URL=http://127.0.0.1:7783 \
  COOKIE_FILE=/tmp/session-cookie-phase3b.txt \
  ARTIFACT_DIR=docs/plan/artifacts/os-usable-for-work/phase3 \
    node docs/plan/artifacts/os-usable-for-work/phase3/verify-phase3.cjs
preflight: http://127.0.0.1:7783/desktop → 307 (anonymous — the wall is up)
…
ALL PASS — 76 assertions, 6 shots in /opt/ai-os/uploads/c38b68151bdd
$ echo $?
0
```

`assertPastTheWall()` runs **after every navigation** — the initial load, each of the four rail
clicks, the reload that seeds `search`, and the phone-sheet open — not once at startup.

### 4.1 R38 — the words, and the bounding box

Asserted at **1280×800 and 1280×600**, for all four. Presence in the DOM is not the test: the script
takes the **deepest** element whose own text matches `/not built/i` and requires
`rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth`. It also
requires the whole warning banner to satisfy the same, and requires `data-placeholder-banner="unbuilt"`
— so a NOT BUILT label bolted onto a surviving neutral card would fail.

Why it needed measuring: the version this replaced opened with `padding: "64px 40px"` under a 25px
title, so an honest line placed at the bottom of that card would have been below the fold on a short
window, which is the same as absent. The banner is now the first thing in the box.

### 4.2 R39 — three statements, and no "coming soon"

All three headings are asserted present per surface — `WHAT IT WOULD BE FOR`,
`WHAT IT NEEDS IN ORDER TO EXIST`, `WHETHER ANYONE IS COMING` — **including on SEARCH**. And
`/coming soon/i` is asserted **absent**: a promise with no owner and no date is exactly what R39 bans,
and only an inverse assertion catches it.

### 4.3 R40 — the marker, at all three nav sites

| Site | Where | Marked | Asserted |
|---|---|---|---|
| left rail | `DesktopApp.tsx` `LeftRail` | goals, journal, map, library | `nav [data-nav-unbuilt]` → exactly those four, at both desktop viewports |
| top strip | `DesktopApp.tsx` `TopNav` | library only | the strip renders `operator`/`work`/`ai`; the other three are in `recall`, which it does not render at all |
| phone sheet | `DesktopApp.tsx` `MobileNav` | goals, journal, map, library | at **390×844**, where the rail is not mounted: `[data-nav-menu-panel] [data-nav-unbuilt]` → the same four, out of **18** destinations |

Total in the DOM at 1280: **5 nodes, 4 distinct keys**. No built entry carries one, at any of the
three sites, at any of the three viewports.

### 4.4 SEARCH, asserted from the other side

`search` is in `SURFACES` but not in `NAV`, so it is reached the only way it can be — a stored
`localStorage` value that passes `isSurface()`. Its backend is built, mounted at `index.ts:166` and
answering live (`surface-determinations.md` §5), so the script asserts:

- `hasNotBuilt` is **false** — it must not claim to be unbuilt
- `data-placeholder-banner` is **`unreachable`**, not `unbuilt`
- all three statements still render
- the nav marker set is still exactly the four — SEARCH gets none, because it has no nav entry to
  put one on

Applying the four-surface template to it unmodified would have replaced one wrong label with another.

---

## 5. R43 — the diff does not wander, measured rather than asserted

```bash
$ git diff --stat
 forge-control-web/app/desktop/DesktopApp.tsx | 487 +++++++++++++++++----------
 forge-control-web/app/desktop/nav-items.ts   |  39 ++-
$ git diff -U0 forge-control-web/app/desktop/DesktopApp.tsx | grep -c '^@@'
26
```

Every one of the 26 hunks falls in one of four regions:

| Region | Hunks |
|---|---|
| `PLACEHOLDER_SURFACES` (the record and its types) | `-73,73 +73,61` … `-189,0 +201,3` |
| the placeholder branch of the render switch | `-477,10 +491,12` |
| `UnbuiltMark`, the new guarded marker component | `-515,0 +532,75` |
| the three guarded call sites | `-634,0 +726,3` · `-850,0 +945,3` · `-1026,0 +1124,3` |
| `PlaceholderSurface` | `-2773,28 +2873,59` and the hunks within it |

**All three nav call sites are `,0` on the minus side — pure insertions.** Nothing was deleted or
edited at any of them, so a built entry renders byte-identically to what it rendered before this
round. Nothing in the diff touches Today, Inbox, Chat, Projects, or the rendering of any built surface.

### 5.1 The one place a marker COULD have changed a built surface, and what was done about it

The top strip is horizontal and **already overflows before this round**. Measured on this build by
hiding the strip marker in the DOM and re-measuring the same element:

```
without the marker: scrollWidth 1384px   with it: 1402px   container: 1280px
```

At 1280 the `forge` wordmark's right edge (77px) is already past TODAY's left edge (36px) — the brand
block has collapsed and the search box on the right is cut. **That is pre-existing and is not this
round's to fix**, but the first version of the marker was the word `UNBUILT` (48px), which would have
pushed one more built destination off the right edge in the 1,384–1,432px band. So the strip renders
the same token, the same `data-nav-unbuilt` attribute and the same tooltip as a **16px warning glyph**
instead, and `verify-phase3.cjs` asserts the added cost is **under 20px**. The rail and the phone sheet
are vertical lists with a `flex: 1` spacer, where the word costs nothing, and they keep it.

**Finding for whoever owns the nav:** the top strip overflows its container by 104px at a 1280px
window, with the brand overlapping TODAY and the search box clipped, on code that predates this
project. Reported, not fixed — it is outside phase 3.

---

## 6. The other gates

```bash
$ cd forge-control-web && npx tsc --noEmit ; echo $?
0
$ cd forge-control && npx tsc --noEmit ; echo $?
0
$ node scripts/checks/no-raw-colours.cjs
no-raw-colours: PASS — 222 literal(s) across 14 file(s), all accounted for
                       (176 legitimate, 46 known debt, 0 unlisted).
```

Identical to the baseline recorded before any edit: **222 / 176 / 46 / 0**. Every colour on the new
surface comes from the `tokens` object — `tokens.warn`, `tokens.freezeBgWarn`,
`tokens.freezeBorderWarn`, `tokens.textBody`, `tokens.textGhost`.

```bash
$ cd forge-control && ./node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
    ../scripts/checks/check-phase3-placeholders.ts
… 33 assertions …
ALL PASS — phase 3 placeholders (R40)

$ cd forge-control && ./node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
    ../scripts/checks/check-r1873-fixes.ts
ALL PASS — round 1873 fixes
```

`check-r1873-fixes.ts` was **not edited**. It imports `NAV` and reads `.key` only, so the new optional
field is invisible to it — the write-set permitted an edit in case the type change forced one, and it
did not.

### 6.1 The flip, which is half of `check-phase3-placeholders.ts`

An assertion that passes at every fixture value proves nothing. `auditUnbuiltMarks` is run over the
real `NAV`, where it must report nothing, and over five deliberately broken copies, where it must name
the specific key:

| Fixture | Must report |
|---|---|
| `today` marked unbuilt | `markedButBuilt: ["today"]` |
| `pipeline` marked unbuilt (the built surface next to LIBRARY) | `markedButBuilt: ["pipeline"]` |
| `map` stripped of its marker | `unmarkedButUnbuilt: ["map"]` |
| `library` stripped of its marker | `unmarkedButUnbuilt: ["library"]` |
| the phone sheet's coverage truncated | `unreachableOnPhone: ["journal"]` |
| a marked key that is not a surface at all | `notASurface: ["kanban"]` |

And a final assertion that none of the fixtures mutated the imported model.

---

## 7. Screenshots (N7)

Written to `/opt/ai-os/uploads/c38b68151bdd/<stamp>-<label>.png`, read back so they render inline in
Konrad's chat, then copied into this directory. `/opt/ai-os/uploads` is not permanent; the committed
copies are the durable record.

| Label | Upload path | Bytes | Committed as | md5 |
|---|---|---|---|---|
| nav rail | `20260818T200924Z-after-nav-rail.png` | 16,763 | `after-nav-rail.png` | `6e314cc9989d51e534cdcef0449cbc17` |
| goals | `20260818T200926Z-after-goals.png` | 109,413 | `after-goals.png` | `a023b7c4da549297aabf1b1942455318` |
| journal | `20260818T200927Z-after-journal.png` | 117,413 | `after-journal.png` | `d62c6afced9538b01760e6a45fdf5503` |
| map | `20260818T200928Z-after-map.png` | 113,505 | `after-map.png` | `2b4e8ea88309683e83e5805853180e55` |
| library | `20260818T200930Z-after-library.png` | 119,050 | `after-library.png` | `e1a3826c9c6576d5f5358bacff0b6b1e` |
| phone sheet | `20260818T200947Z-after-phone-sheet.png` | 20,199 | `after-phone-sheet.png` | `346a6d93312fa8ae8101fc5cc3426139` |

md5 identity of upload copy vs committed copy verified for all six.

**`after-phone-sheet.png` is an UNDECLARED WRITE.** It is not in B3b's declared write-set, which names
five PNGs. It is committed anyway because the 390px assertions in §4.3 are the only proof that the
third nav render site carries the marker, and an assertion whose evidence lives only in a directory
that does not survive a reboot is half an assertion. Named here, in the commit message, and in the
final report.

Two further frames were taken to `/opt/ai-os/uploads` and read back for Konrad but **not committed**,
because they are illustrative rather than deliverables: `20260818T200708Z-after-search.png` (the SEARCH
copy, which no committed frame shows) and `20260818T200714Z-after-goals-short-viewport.png` (GOALS at
1280×600, showing the banner and all three statements above the fold).

---

## 8. What this task deliberately did NOT do

- **No feature was built.** Building Goals, Journal, Map or Library is an explicit non-goal
  (`00-vision.md` §5). No route, no table, no data fetch, no new surface component.
- **`shots-phase3.cjs` was not edited** — B3a's file, outside the write-set. Its `307 or 200`
  preflight tolerance is flagged in §2.1 instead.
- **`scripts/checks/gates-808.sh` was not edited.** It governs every ai-os project and is shared with
  all six lanes; the reviewer runs `check-phase3-placeholders.ts` by name.
- **`/opt/forge-ai-os` was not written**, only read once for `AUTH_SECRET`. `pm2 restart
  forge-executor` was never run.
- **The top strip's pre-existing 1280px overflow was not fixed** (§5.1). Measured, reported, left.

## 9. Scope statement

`git status` at hand-off shows the two application files and the four artefact paths listed in §7 and
below. The application diff is confined to `PLACEHOLDER_SURFACES`, `PlaceholderSurface`, the
placeholder branch of the render switch, one new guarded marker component and three pure-insertion
call sites, plus the `NavItem.unbuilt` field and its derivation in `nav-items.ts`.

**Declared write-set, and what actually moved:**

| Path | Written | Note |
|---|---|---|
| `forge-control-web/app/desktop/DesktopApp.tsx` | yes | |
| `forge-control-web/app/desktop/nav-items.ts` | yes | |
| `scripts/checks/check-phase3-placeholders.ts` | yes | new |
| `scripts/checks/check-r1873-fixes.ts` | **no** | permitted companion; the type change did not force an edit |
| `docs/plan/artifacts/…/phase3/verify-phase3.cjs` | yes | new |
| `docs/plan/artifacts/…/phase3/after-verification.md` | yes | this file |
| `docs/plan/artifacts/…/phase3/after-{goals,journal,map,library,nav-rail}.png` | yes | |
| `docs/plan/artifacts/…/phase3/after-phone-sheet.png` | **yes — UNDECLARED** | §7 |
