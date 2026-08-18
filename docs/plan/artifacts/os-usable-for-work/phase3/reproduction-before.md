# Phase 3 — Reproduction, BEFORE state

**Project:** `os-usable-for-work` · phase 3 (round 300) · workstream `surfaces`
**Task:** B3a — reproduce all four unbuilt surfaces, MEASURE half (no application code changed)
**Requirements:** R37 (before screenshots), N1, N7, N10
**Date:** 2026-08-18 · **Run:** `7affdc56-1460-47bc-b06f-605ccc5470c8` (`FORGE_RUN_ID=7affdc561460`)
**Worktree:** `/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--surfaces`, branch `project/7851068b-surfaces`

Every number below carries the command that produced it (N10). Nothing here was recalled.

---

## 1. What was reproduced, and where

| # | Surface | How it was reached | URL at the moment of the shot | Artefact |
|---|---|---|---|---|
| 1 | *(the nav rail)* | initial load, no click | `http://127.0.0.1:7783/desktop` | `before-nav-rail.png` |
| 2 | GOALS | click `GOALS` in the left nav rail | `http://127.0.0.1:7783/desktop` | `before-goals.png` |
| 3 | JOURNAL | click `JOURNAL` in the left nav rail | `http://127.0.0.1:7783/desktop` | `before-journal.png` |
| 4 | MAP | click `MAP` in the left nav rail | `http://127.0.0.1:7783/desktop` | `before-map.png` |
| 5 | LIBRARY | click `LIBRARY` in the left nav rail | `http://127.0.0.1:7783/desktop` | `before-library.png` |
| — | SEARCH | **no click is possible** — seeded `localStorage["forge.desktop.surface"]="search"` and reloaded | `http://127.0.0.1:7783/desktop` | *no shot; §5 and the determinations doc §5* |

**The URL is the same string for all six.** The app has exactly one route (`/desktop`); the surface is
React state persisted to `localStorage`, not a path. That is stated in `nav-items.ts:56-60` in the
codebase's own words ("The URL is the honest home for this … but the app has exactly one route today").
It matters for this reproduction because **a screenshot cannot be identified by its URL** — the only
identifier is the rendered content, which is why the harness probes the DOM for the placeholder tag
before every shot and hard-errors if it is absent.

**Viewport:** 1600 × 1000 CSS px, headless Chromium, `deviceScaleFactor` 1 (Playwright default).
Chosen because `useNarrowViewport` unmounts the left rail below 900 px, and the rail is deliverable #1.
The harness asserts `document.querySelectorAll("nav").length === 1` and fails if the mobile nav-menu
panel mounted instead (`shots-phase3.cjs`, "expected exactly one `<nav>` at 1600px").

---

## 2. The server that was photographed

**Not the live UI.** Per N4/N5 this is a build task, so the target is a throwaway `next start` served
**from this worktree**. `/opt/forge-ai-os` was read exactly once — `.env.local`, for `AUTH_SECRET` —
and never written.

```bash
# 1 — devDependencies. --prod=false is mandatory: the runtime exports
#     NODE_ENV=production, under which a bare --frozen-lockfile skips
#     devDependencies, exits 0, and removes typescript.
cd forge-control-web && pnpm install --frozen-lockfile --prod=false
#   → "Lockfile is up to date, resolution step is skipped / Already up to date"
#   → nothing removed. Verified positively rather than by reading the summary:
node -e 'console.log(require("typescript/package.json").version)'   # 5.7.2
node -e 'console.log(require("next/package.json").version)'         # 15.1.3
node -e 'console.log(require("next-auth/package.json").version)'    # 5.0.0-beta.25

# 2 — build
pnpm build
cat .next/BUILD_ID            # fKeri3s5ko0R6OK2C4Uf2

# 3 — port. Phases 1,2,4,5,6 run concurrently and also want ports.
for p in 7780 7781 7782 7783 7784 7785; do
  ss -ltn "sport = :$p" | grep -q LISTEN && echo "$p BUSY" || echo "$p FREE"; done
#   → all six FREE. 7783 chosen, as the brief suggested.
#   Occupied on this host at the time: 7700 (live forge-control API),
#   7701 (live web), 7798 (another phase's throwaway).

# 4 — serve
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
AUTH_URL=http://127.0.0.1:7783 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7783
#   → "✓ Ready in 307ms"
```

**Port used: 7783.** `BUILD_ID` of the photographed build: **`fKeri3s5ko0R6OK2C4Uf2`**.

The Next proxy rewrite to `127.0.0.1:7700` is baked at build time and was **not** repointed. Every
surface photographed is a placeholder that issues no API call, so the proxy target is immaterial to
these five frames; where live API data is quoted in the determinations document it is quoted from a
direct `curl` against `127.0.0.1:7700`, which is a read.

---

## 3. Getting past the auth wall — and the salt that decides it

`forge-control-web/middleware.ts` 307s every unauthenticated request to `/signin`. Proven, not assumed:

```bash
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:7783/desktop
307 http://127.0.0.1:7783/signin
```

**There are two salts** (corpus commit `3f98e67`). In auth.js v5 the session-cookie name is *also* the
JWE salt, and which name is used is decided by the running server's `AUTH_URL`, not by the port:

| Target | `AUTH_URL` | salt **and** cookie name | `secure` |
|---|---|---|---|
| this harness (`next start -p 7783`) | `http://127.0.0.1:7783` | `authjs.session-token` | `false` |
| the live UI / `:7701` | `https://os.schreinercontentsystems.com` | `__Secure-authjs.session-token` | `true` |

The live value was confirmed, not assumed:

```bash
$ grep -o 'AUTH_URL=.*' /opt/forge-ai-os/forge-control-web/.env.local
AUTH_URL=https://os.schreinercontentsystems.com
```

Minting with the wrong salt fails as a 307 to `/signin` that is **indistinguishable from an expired
token**, which is why `shots-phase3.cjs` names the salt as the first suspect in its failure message
rather than `AUTH_SECRET`/`maxAge`.

```bash
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node -e 'import("next-auth/jwt").then(async m=>{ ... salt:"authjs.session-token", maxAge:14400 ...})' \
  > /tmp/session-cookie-phase3.txt          # → minted 457 chars

$ curl -s -o /dev/null -w '%{http_code}\n' \
    -H "Cookie: authjs.session-token=$(cat /tmp/session-cookie-phase3.txt)" \
    http://127.0.0.1:7783/desktop
200
```

`assertPastTheWall()` re-runs this check **after every navigation**, not once at startup, and throws
on `/signin` or on a DOM with no `<nav>`. An agent that skips it screenshots the login page and
reports a working surface as dead; that has happened in this fleet (00-vision.md §2.8).

---

## 4. The harness run that produced the five shots

```bash
cd /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--surfaces
FORGE_RUN_ID=7affdc561460 \
BASE_URL=http://127.0.0.1:7783 \
COOKIE_FILE=/tmp/session-cookie-phase3.txt \
SHOT_PHASE=before \
ARTIFACT_DIR=docs/plan/artifacts/os-usable-for-work/phase3 \
  node docs/plan/artifacts/os-usable-for-work/phase3/shots-phase3.cjs
```

Browser: `/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`, driven through
`/opt/hermes-workspace/node_modules/playwright`. Neither is a dependency of `forge-control-web`;
`pnpm install` does not provide them and the harness hard-errors if either is missing.

**Output (N7 — upload path first, then the committed copy):**

| Label | Upload path (`/opt/ai-os/uploads/7affdc561460/`) | Bytes | Committed as | md5 |
|---|---|---|---|---|
| nav rail | `20260818T192747Z-before-nav-rail.png` | 15,729 | `phase3/before-nav-rail.png` | `d936250f3f52b925cf372a64439fbe43` |
| goals | `20260818T192749Z-before-goals.png` | 60,893 | `phase3/before-goals.png` | `ad2fa5e47c575d680d5f1f8ca058d03c` |
| journal | `20260818T192750Z-before-journal.png` | 63,649 | `phase3/before-journal.png` | `40a2a5926bcab1ec0801ca0167c39ca1` |
| map | `20260818T192752Z-before-map.png` | 64,230 | `phase3/before-map.png` | `96e691e97c5c8daa5dd3e858b9fb6cae` |
| library | `20260818T192753Z-before-library.png` | 62,275 | `phase3/before-library.png` | `940af78c7439797fbd837eb55fc6a585` |

md5 identity of upload copy vs committed copy verified by:

```bash
for l in goals journal map library nav-rail; do
  a=$(md5sum docs/plan/artifacts/os-usable-for-work/phase3/before-$l.png | cut -d' ' -f1)
  b=$(md5sum /opt/ai-os/uploads/$FORGE_RUN_ID/*before-$l.png | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "$l OK $a" || echo "$l MISMATCH"; done
# → all five OK
```

`/opt/ai-os/uploads` is not permanent; the committed copies are the durable record.

**DOM probe at the moment of each shot** (the harness prints this as JSON):

| Surface | placeholder tag in DOM | `/not built/i` in DOM | feature bullets | `localStorage` surface |
|---|---|---|---|---|
| goals | ✔ | **✘** | 3 | `"goals"` |
| journal | ✔ | **✘** | 3 | `"journal"` |
| map | ✔ | **✘** | 4 | `"map"` |
| library | ✔ | **✘** | 4 | `"library"` |
| search | ✔ | **✘** | 4 | `"search"` |

**That column of ✘ is the phase-3 defect in one measurement.** Five surfaces render a titled card with
three or four feature bullets and the phrase "not built" appears nowhere in the document. R38's
acceptance is the same probe returning ✔ — run the harness with `EXPECT_NOT_BUILT=1` and it becomes an
assertion that exits non-zero instead of a column in a table.

---

## 5. SEARCH: reachability, settled

`search` is the fifth key in `PLACEHOLDER_SURFACES` (`DesktopApp.tsx:177`) and it renders through the
same branch (`DesktopApp.tsx:477-486` excludes seven of the ten keys, leaving goals, journal, map,
library **and search**). It is in `SURFACES` (`nav-items.ts:65`) but **not in `NAV`**
(`nav-items.ts:78-96`, seventeen entries, no `search`).

Four candidate entry points were checked. All four are closed:

```bash
$ grep -rn 'setSurface(' forge-control-web/app/
forge-control-web/app/desktop/DesktopApp.tsx:463:                  setSurface(s);
forge-control-web/app/desktop/DesktopApp.tsx:506:            setSurface(s);
```

1. **Nav rail, top strip, phone sheet** — all three map over `NAV`
   (`DesktopApp.tsx:627` `NAV.filter(n => n.group === g)`, `:997-1001` `railGroups` built from four
   `NAV.filter(...)` calls, `:781` `MOBILE_NAV_GROUPS.map` over `NAV`). `search` is not in `NAV`, so no
   entry is rendered anywhere.
2. **Command palette** (`DesktopApp.tsx:1236-1239`) — `NAV.filter(n => !term || n.label…)`. It filters
   `NAV`. Typing "search" into the palette matches nothing; the palette itself is what the
   `search everything ⌘K` box in the header opens (`onPalette`), and it is *not* the SEARCH surface.
3. **`StatusBar onNav`** — `onNav={setSurface}` (`:494`); every call site inside StatusBar passes a
   literal, and those literals are `"autonomy"`, `"inbox"`, `"inbox"` (`:1168`, `:1185`, `:1196`).
   Not `"search"`.
4. **Chat slash-navigation** — `DesktopApp.tsx:450-467` whitelists eight keys explicitly
   (`today, inbox, live, control, memory, skills, pipeline, autonomy`) and `SurfaceKey`
   (`chat/slash-registry.ts:28-37`) does not contain `search` at all.
5. **Keyboard shortcuts** — the only global handler is ⌘K/Ctrl+K → palette and Escape → close
   (`DesktopApp.tsx:275-285`). No surface hotkeys exist.

**The one remaining door is `localStorage`, and it is open.** `surface` is
`usePersistentState<Surface>("forge.desktop.surface", "today", isSurface)` (`DesktopApp.tsx:239-243`);
the hook reads the key on mount and accepts any value passing the guard
(`_ui/ResizableSplit.tsx:313-331`), and `isSurface` tests membership of `SURFACES`
(`nav-items.ts:68`), which **includes `search`**. So a stored `"search"` — from an older build that
had the entry, or set by hand — renders the SEARCH placeholder with no way back except clicking
another nav entry.

Proven in the browser, not argued:

```
seed:   localStorage.setItem("forge.desktop.surface", JSON.stringify("search")); location.reload()
probe:  { tagVisible: true, hasNotBuilt: false, bulletCount: 4, storedSurface: "\"search\"" }
```

**Answer: `search` is unreachable through every UI affordance in the product, and reachable through
exactly one non-UI path — a stored `localStorage` value.** It is a fifth determination section, not a
fifth nav marker: a marker on an entry that does not exist would mark nothing. No screenshot was
committed for it because the deliverable list is five and this is a finding about *absence of a
route to* a surface, not about how that surface looks.

---

## 6. Two findings from the before state that B3b needs

**6.1 — the one honesty affordance that exists is 58 days stale and wrong.**
Every placeholder card ends with an 11 px `tokens.textGhost` line (`DesktopApp.tsx:2858-2864`):

> `live in this build: chrome · command palette · today · inbox · live · control · tasks`

It is visible in all five screenshots. It is a hardcoded string, unchanged since the surface was
written:

```bash
$ git log -1 --format='%h %ad' --date=short -S'live in this build' -- forge-control-web/app/desktop/DesktopApp.tsx
c7e488d 2026-06-21
```

Fourteen surfaces render real components today (`today, inbox, chat, tasks, pipeline, money,
businesses, skills, memory, live, control, autonomy, automation, settings` — enumerated from the render
switch, `DesktopApp.tsx:423-476`). The caption names five of them and omits nine. It is the OS telling
a tired operator that MEMORY and PIPELINE are not live, in ghost grey, on the page whose job is to say
what is not live. **B3b should delete this line rather than update it** — a hand-maintained list of
built surfaces is a second source of truth that will rot again, and R38's per-surface treatment
replaces its whole purpose.

**6.2 — the nav rail gives no hint, and `before-nav-rail.png` is the proof.**
`LIBRARY`, `GOALS`, `JOURNAL` and `MAP` are rendered with byte-identical styling to `TODAY`, `INBOX`,
`PROJECTS` and `MEMORY`: same `railStyle()` (`DesktopApp.tsx:987-1001`), same font, same weight, same
colour. `NavItem` declares an optional `badge` field (`nav-items.ts:74`) that **no entry populates**
(`grep -c 'badge:' forge-control-web/app/desktop/nav-items.ts` → 0), so R40's marker has a slot waiting
for it and needs no type change. Note it is *not* the mechanism behind the `8` beside INBOX: that comes
from a separate `badges: Record<string, string>` prop threaded from the inbox query
(`DesktopApp.tsx:345`, read at `:635`). Both mechanisms exist; only the second is wired.

---

## 7. Reproducibility — verified, including the failure paths

The harness is committed at `docs/plan/artifacts/os-usable-for-work/phase3/shots-phase3.cjs` and is
the same file for the before and the after set — see `browser-harness-local.md` for the full recipe,
including how to bring the 7783 server back up from cold. B3b runs it with `SHOT_PHASE=after
EXPECT_NOT_BUILT=1`; the reviewer can run either.

**7.1 — re-run from a clean shell, exit 0.** `env -i` strips the whole environment, so nothing
inherited from this task's shell is load-bearing:

```bash
$ env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
    FORGE_RUN_ID=7affdc561460 BASE_URL=http://127.0.0.1:7783 \
    COOKIE_FILE=/tmp/session-cookie-phase3.txt SHOT_PHASE=before \
    node docs/plan/artifacts/os-usable-for-work/phase3/shots-phase3.cjs
preflight: http://127.0.0.1:7783/desktop → 307
  shot …-before-nav-rail.png (15762 bytes)
  goals: tagVisible=true hasNotBuilt=false
  … journal, map, library …
  search (localStorage only): tagVisible=true hasNotBuilt=false stored="search"
OK — 5 shots in /opt/ai-os/uploads/7affdc561460
$ echo $?
0
```

Same five shots, same probe verdicts. This run was made **without** `ARTIFACT_DIR` so it could not
overwrite the committed copies whose md5s are tabled in §4 — the status bar carries a live clock and
an inbox count, so two runs are never byte-identical and the recorded md5s must stay the ones that
were committed.

**7.2 — the R38 assertion is not inert.** A check that passes in every state is worth nothing, so it
was run against the *unchanged* code it is supposed to reject:

```bash
$ … EXPECT_NOT_BUILT=1 node …/shots-phase3.cjs; echo $?
FAILED: Error: EXPECT_NOT_BUILT=1 but "goals" does not render the words "not built" (R38).
1
```

It fires, on the first surface, with a non-zero exit. When B3b's change lands, the same command must
exit 0 — and that is the R38 acceptance test, not an eyeball.

**7.3 — a dead target is named, not timed out.** During this task the throwaway 7783 server was reaped
silently (it is a background process with no supervisor, and its log ends at `✓ Ready in 307ms` with
no error). The harness failed — correctly, no shot was fabricated — but the message Playwright
produced was `page.goto: Timeout 30000ms exceeded`, which reads like a slow application. That is a
wrong signpost, so `assertServerUp()` was added: it fetches `/desktop` before launching the browser
and reports the connection error plus the restart instruction. Restart it with `setsid` (see
`browser-harness-local.md` §1 step 4) so it survives the shell that started it.

**Scope statement:** this task changed no application code. `git status` at hand-off shows only the
nine paths in the declared write-set, all under
`docs/plan/artifacts/os-usable-for-work/phase3/`.
