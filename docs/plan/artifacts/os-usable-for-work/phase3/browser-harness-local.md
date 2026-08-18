# Phase 3 — local browser harness

**Why this file exists.** N3 says the authenticated-browser harness is built once in phase 1 and
shared, as `docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.md`. Phase 3 runs
**concurrently** with phase 1 and that file did not exist when this task ran:

```bash
$ ls docs/plan/artifacts/os-usable-for-work/
phase0
$ ls docs/plan/artifacts/os-usable-for-work/phase1/
ls: cannot access '…/phase1/': No such file or directory
```

Per the brief, that is not a blocker and not a dependency: this is a **local copy** built from the
recipe proven in this repo since phase 500 (`docs/plan/artifacts/phase1871/README.md:290-320`, with
working examples `verify-1871.cjs` and `themes-1871.cjs` beside it). When phase 1's shared harness
lands, this file is the thing it should replace — the deltas it must absorb are listed in §5.

---

## 1. The recipe, start to finish

```bash
cd /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--surfaces

# ── 1. devDependencies. --prod=false ALWAYS ───────────────────────────────────
# The runtime exports NODE_ENV=production. A bare `pnpm install --frozen-lockfile`
# under it SKIPS devDependencies, says so quietly, EXITS 0, and REMOVES typescript.
# The tell in the transcript is `- typescript` versus `+ typescript`. pnpm, never npm.
cd forge-control-web && pnpm install --frozen-lockfile --prod=false

# Do not trust the summary line. Verify positively:
node -e 'console.log(require("typescript/package.json").version)'   # 5.7.2
node -e 'console.log(require("next/package.json").version)'         # 15.1.3
node -e 'console.log(require("next-auth/package.json").version)'    # 5.0.0-beta.25

# ── 2. build FROM THIS WORKTREE ───────────────────────────────────────────────
pnpm build && cat .next/BUILD_ID          # fKeri3s5ko0R6OK2C4Uf2 on 2026-08-18

# ── 3. pick a free port. Phases 1,2,4,5,6 run concurrently and also want ports.
for p in 7780 7781 7782 7783 7784 7785; do
  ss -ltn "sport = :$p" | grep -q LISTEN && echo "$p BUSY" || echo "$p FREE"; done
# Phase 3 used 7783. Occupied on this host: 7700 (live API), 7701 (live web),
# 7798 (another phase's throwaway).

# ── 4. serve. AUTH_URL decides the cookie salt — see §2. ──────────────────────
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a   # a READ of the live checkout (N4)
# setsid, NOT a bare `&`. This server has no supervisor: started with a plain
# background `&` it is reaped when its shell goes away, leaving a log that ends
# at "✓ Ready" with no error and a harness that reports a goto timeout. That
# happened during phase 3 — see reproduction-before.md §7.3.
setsid env AUTH_URL=http://127.0.0.1:7783 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7783 > /tmp/next-7783.log 2>&1 < /dev/null &
disown
sleep 10
ss -ltn | awk '$4 ~ /:7783$/'          # ← the listener must actually be there
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:7783/desktop
#   → 307 http://127.0.0.1:7783/signin      ← the wall is up, as it must be

# ── 5. mint the session cookie ────────────────────────────────────────────────
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node -e '
import("next-auth/jwt").then(async m=>{
  const t = await m.encode({
    token:{name:"phase3-surfaces",email:"phase3@localhost",sub:"phase3"},
    secret:process.env.AUTH_SECRET, salt:"authjs.session-token", maxAge:14400});
  require("node:fs").writeFileSync("/tmp/session-cookie-phase3.txt", t);
  console.log("minted", t.length, "chars");
})'
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Cookie: authjs.session-token=$(cat /tmp/session-cookie-phase3.txt)" \
  http://127.0.0.1:7783/desktop
#   → 200      ← past the wall. If this is 307, read §2 before touching AUTH_SECRET.

# ── 6. drive the browser ──────────────────────────────────────────────────────
cd /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--surfaces
FORGE_RUN_ID=$FORGE_RUN_ID BASE_URL=http://127.0.0.1:7783 \
COOKIE_FILE=/tmp/session-cookie-phase3.txt SHOT_PHASE=before \
ARTIFACT_DIR=docs/plan/artifacts/os-usable-for-work/phase3 \
  node docs/plan/artifacts/os-usable-for-work/phase3/shots-phase3.cjs
```

---

## 2. THERE ARE TWO SALTS. This is the failure that costs rounds.

In auth.js v5 the session-cookie **name is also the JWE salt**, and which name is used is decided by
the **running server's `AUTH_URL`** — not by the port, not by whether you typed `http` in the browser.

| Target | `AUTH_URL` | salt **and** cookie name | `secure` |
|---|---|---|---|
| a throwaway `next start` from a worktree | `http://127.0.0.1:<spare>` | `authjs.session-token` | `false` |
| the live UI, and `127.0.0.1:7701` | `https://os.schreinercontentsystems.com` | `__Secure-authjs.session-token` | `true` |

```bash
$ grep -o 'AUTH_URL=.*' /opt/forge-ai-os/forge-control-web/.env.local
AUTH_URL=https://os.schreinercontentsystems.com
```

The wrong salt fails as a **307 to `/signin`, indistinguishable from an expired token**. The instinct
is then to suspect `AUTH_SECRET` or `maxAge`, and that instinct has already burned two rounds in this
fleet (`phase900/verification-904.md:366`, `operator-visibility/phase1860/03-acceptance.md:40`). So
`shots-phase3.cjs` prints the salt it used, first, in its failure message.

CDP rejects `secure:false` on a `__Secure-`-prefixed name with
`Protocol error (Storage.setCookies): Invalid cookie fields`. The harness refuses that combination up
front (`COOKIE_NAME=… requires COOKIE_SECURE=1`) rather than letting Playwright produce the confusing
error.

---

## 3. The assertion that is not optional

**Every browser test must assert its URL is not `/signin` and hard-error if it is.** In this harness
that is `assertPastTheWall()`, and it runs **after every navigation** — initial load, each of the four
nav clicks, and the reload that seeds `search`. Not once at startup, because a session can expire
mid-run and because a click can navigate.

It also asserts the desktop shell actually mounted (`<nav>` present). A page that is authenticated but
blank is as misleading as the login page.

---

## 4. Browser binaries

Playwright is **not** a dependency of `forge-control-web` and `pnpm install` does not provide it. On
this host:

- module: `/opt/hermes-workspace/node_modules/playwright`
- browsers: `/root/.cache/ms-playwright/` → `chromium-1234`, `chromium_headless_shell-1234`, `ffmpeg-1011`

`shots-phase3.cjs` resolves the executable from that cache and throws a named error if neither the
cache nor a matching binary exists. It never falls back to a system Chrome.

---

## 5. What phase 1's shared harness must absorb from this copy

If phase 1's `browser-harness.md` lands without these, it is a regression against what phase 3 proved:

1. **Both salts, tabulated**, with `AUTH_URL` as the deciding input and the salt named first in the
   failure message.
2. **`--prod=false` verified positively** (`require("typescript/package.json").version`), not read off
   pnpm's summary line — "Already up to date" is printed in both the healthy and the pruned case.
3. **`assertPastTheWall()` after every navigation**, not once.
4. **A port-freedom check before binding**, because six workstreams run concurrently.
5. **Playwright resolved from `/opt/hermes-workspace`**, with a hard error rather than a fallback.
6. **N7 in the harness itself**: shots written to `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png`
   *and* copied to the phase artefact directory, with the byte size asserted (`< 2000 bytes` is not a
   rendered page).
7. **A preflight that names a dead server.** `assertServerUp()` fetches `/desktop` before launching
   Chromium. Without it, a reaped `next start` surfaces as `page.goto: Timeout 30000ms exceeded`,
   which sends the next agent to profile the application instead of restarting the server.
8. **`setsid` when starting the server**, per §1 step 4 — a bare `&` does not survive the shell.

---

## 6. Shutting down — and the stale-build trap that follows

B3a stopped its 7783 server when it finished. That is deliberate, and B3b should understand why
before restarting one.

**`next start` serves the build that was on disk when `pnpm build` ran.** It does not watch files.
So after B3b edits `DesktopApp.tsx` and `nav-items.ts`, a still-running server from B3a's build keeps
serving the OLD bundle — the harness would report `hasNotBuilt=false`, `EXPECT_NOT_BUILT=1` would
still exit 1, and the obvious reading is "my change didn't work" when in fact it was never compiled.
Leaving a server up across a code change is a worse hazard than a busy port.

**So: `pnpm build` first, then start the server, then run the harness. Every time.**

```bash
# Kill by LISTENING SOCKET, not by command-line pattern.
# `pkill -f 'next start -p 7783'` matches the argv of the very shell running it —
# the agent harness wraps commands in `bash -c '<your command>'`, so the pattern
# finds itself and the shell dies with exit 144 before the rest of the line runs.
# That happened here. This does not have that failure mode:
ss -ltnp | awk '$4 ~ /:7783$/ {print}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r kill

cd forge-control-web && pnpm build && cat .next/BUILD_ID   # must differ from fKeri3s5ko0R6OK2C4Uf2
# …then §1 step 4 to restart, and re-mint the cookie if more than 4h has passed (maxAge 14400).
```

The server holds no state and writes nothing, so stopping it costs nothing but the rebuild.
