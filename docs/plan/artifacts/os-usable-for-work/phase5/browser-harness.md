# phase5/browser-harness.md — the `business` lane's authenticated browser + API harness

Companion to `harness.mjs` (the browser) and `serve-pipeline.ts` (the API).
Built in phase 5 round 0 so the other three builders in this lane can measure
before they change anything.

## Why this exists as a lane-local copy (N3)

N3 says the harness is built once, in phase 1, and shared by lanes 2–6. Phase 1
runs in a **different worktree** on branch `project/7851068b-vault`; its commits
are not on `project/7851068b-business` and will not be until phase-7
integration. Waiting for it would serialise five lanes that `04-phases.md`
explicitly runs concurrently, so this lane built its own and did not block.

**At integration:** keep one. Whichever survives, the salt truth table below
must survive with it — it is the only part of this document that was expensive
to learn.

Recipe adapted from `docs/plan/artifacts/phase1871/README.md:280-312`, with
four corrections. That README says `npm`; **we use `pnpm`**, always with
`--prod=false`.

---

## 0. Dependencies, before anything

The runtime exports `NODE_ENV=production`, under which a bare
`pnpm install --frozen-lockfile` **prunes devDependencies, says so quietly, and
exits 0** — and `tsx` and `typescript` are devDependencies. The tell is a `-
typescript` line rather than a `+ typescript` line.

```bash
cd forge-control      && pnpm install --frozen-lockfile --prod=false
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
```

---

## 1. The API on a spare port — `serve-pipeline.ts`

```bash
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
cd forge-control
SERVE_PIPELINE_PORT=7841 ./node_modules/.bin/tsx \
  ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts
```

Mounts **only** this worktree's `pipeline` router; every other path proxies to
production `:7700`. Read `serve-pipeline.ts`'s header for why booting
`forge-control/src/index.ts` is forbidden (it starts cron, the Telegram
long-poll, the vault tick and the probe loop against the live DB and the live
bot token).

Env comes from `/opt/ai-os/.secrets/forge-control.env` and **never** from the
live checkout's app files.

### Mode A — live read-only

The default. `GET /api/pipeline` runs this worktree's code against the live
`content_forge`. The router is a single `SELECT`; there is no write path in
`routes/pipeline.ts` or `db/pipeline.ts`, so this cannot violate R68.

### Mode B — the stub, for the flip test

```bash
PIPELINE_STUB_FILE=/tmp/p5-stub-fresh.json SERVE_PIPELINE_PORT=7842 \
  ./node_modules/.bin/tsx .../serve-pipeline.ts
```

`GET /api/pipeline` then returns that file verbatim (`x-phase5-harness: stub`
on the response) and never touches the database.

**Builder 3 needs this and there is no substitute.** R64's acceptance criterion
requires proving that *a fresh job renders not-stalled*. There is no fresh job:
`content_jobs` holds 24 rows, 19 `MARKED_FOR_DELETION` and 5 aged 11–14 days
(`premises-remeasured.md` § P2). R68 forbids creating one. The stub is the only
honest way to exercise the other branch.

A missing file or malformed JSON is a **hard throw before the port opens** —
never a fall back to the live query, because a harness that silently serves real
data when you asked for a stub makes the flip test pass for the wrong reason.
Proven:

```
$ echo 'not json{' > /tmp/bad-stub.json
$ PIPELINE_STUB_FILE=/tmp/bad-stub.json ... tsx serve-pipeline.ts
Error: PIPELINE_STUB_FILE "/tmp/bad-stub.json" is not valid JSON: Unexpected token 'o', "not json{
" is not valid JSON
```

---

## 2. The web build on another spare port

```bash
cd forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7841 NODE_ENV=production pnpm build
```

**`FORGE_CONTROL_URL` is baked at BUILD time, not read at runtime.**
`next.config.mjs` reads it inside `rewrites()`, so `/api/proxy/:path*` is frozen
into `.next/routes-manifest.json` when you build. Setting it in the environment
of `next start` does nothing. Verify what you actually baked:

```bash
python3 -c "
import json,re;print(sorted(set(re.findall(r'http://127\.0\.0\.1:\d+',
json.dumps(json.load(open('.next/routes-manifest.json')))))))"
# → ['http://127.0.0.1:7841']
```

To flip an existing build from mode A to mode B **without rebuilding** (three
minutes saved), patch the manifest the way the phase1871 README does:

```bash
python3 - <<'EOF'
import json; p='.next/routes-manifest.json'; d=json.load(open(p))
def walk(o):
    if isinstance(o,dict):
        if o.get('destination','').startswith('http://127.0.0.1:7841'):
            o['destination']=o['destination'].replace(':7841',':7842')
        [walk(v) for v in o.values()]
    elif isinstance(o,list): [walk(v) for v in o]
walk(d); json.dump(d,open(p,'w'))
EOF
```

`next start` must be restarted after patching; the manifest is read at boot.

---

## 3. THE TRAP: AUTH_URL's scheme decides the cookie name, and the salt IS the cookie name

This is the twenty minutes every lane loses. It has **two halves** and knowing
one is worse than knowing neither.

**Half one.** The live `.env.local` sets `AUTH_URL=https://…`. NextAuth derives
`useSecureCookies` from that **scheme**, and with it true the session cookie is
named `__Secure-authjs.session-token` instead of `authjs.session-token`.

**Half two.** In next-auth v5 the `salt` passed to `encode()` is part of the key
derivation and **must equal the cookie name**. So the salt is a function of
`AUTH_URL`'s scheme, one step removed.

The phase1871 recipe mints with the *unprefixed* salt and is correct — but only
because the line above it overrides `AUTH_URL=http://127.0.0.1:<port>` when it
launches the throwaway server. Source the env file, forget the override, keep
the unprefixed salt, and the token silently fails auth and 307s to `/signin` —
**indistinguishable from an expired token**.

### The salt experiment — measured, not reasoned

Two servers from the **same build** and the **same `AUTH_SECRET`**, differing
only in whether `AUTH_URL` was overridden:

```
# server A: next start -p 7840, launched with AUTH_URL=http://127.0.0.1:7840   (the override)
# server B: next start -p 7844, launched with AUTH_URL left at the live https:// value
# SAME BUILD, same AUTH_SECRET. probe: curl --cookie "<name>=<token>" http://127.0.0.1:<port>/desktop

SALT PASSED TO encode()         COOKIE NAME SENT                | A :7840 (http override)  | B :7844 (live https)
------------------------------- ------------------------------- | ------------------------ | --------------------
authjs.session-token            authjs.session-token            | 200                      | 307 https://os.schreinercontentsystems.com/signin
authjs.session-token            __Secure-authjs.session-token   | 307 http://127.0.0.1:7840/signin | 307 https://os.schreinercontentsystems.com/signin
__Secure-authjs.session-token   authjs.session-token            | 307 http://127.0.0.1:7840/signin | 307 https://os.schreinercontentsystems.com/signin
__Secure-authjs.session-token   __Secure-authjs.session-token   | 307 http://127.0.0.1:7840/signin | 200 
(none)                          (no cookie sent)                | 307 http://127.0.0.1:7840/signin | 307 https://os.schreinercontentsystems.com/signin
authjs.session-token            authjs.session-token (TAMPERED) | 307 http://127.0.0.1:7840/signin | 307 https://os.schreinercontentsystems.com/signin
```

Read the diagonal. **Exactly one combination works per server, and it is always
salt == cookie name == the name implied by `AUTH_URL`'s scheme.**

**The diagnostic that tells the two failures apart** — and it is free, because
`curl -w '%{redirect_url}'` prints it:

- redirect to `http://127.0.0.1:<port>/signin` → your **salt/cookie-name pair is
  wrong**, but you are talking to your own server.
- redirect to `https://os.schreinercontentsystems.com/signin` → you **forgot the
  `AUTH_URL` override**. Your throwaway server is sending the browser to the
  live public site. A browser follows it, and you then measure production while
  believing you measured the worktree.

### The recipe that works (mode used for every measurement in this phase)

```bash
cd forge-control-web
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a   # a READ (N4)
AUTH_URL=http://127.0.0.1:7840 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7840
```

…and mint with the **unprefixed** salt, which `harness.mjs` does by default:

```js
encode({ token: {...}, secret: AUTH_SECRET, salt: "authjs.session-token", maxAge: 14400 })
```

If you ever need the other mode (no override, live `https://` AUTH_URL), set
`HARNESS_COOKIE_NAME=__Secure-authjs.session-token`; `harness.mjs` uses that
constant as **both** the salt and the cookie name, so they cannot drift apart.

`AUTH_SECRET` is read from `/opt/forge-ai-os/forge-control-web/.env.local`.
That is a **read** and is explicitly permitted by N4. Nothing here writes to
`/opt/forge-ai-os`.

---

## 4. The controls — both required

```bash
node docs/plan/artifacts/os-usable-for-work/phase5/harness.mjs controls
```

```
PASS  web server reachable — http://127.0.0.1:7840/signin → HTTP 200
PASS  api server reachable — http://127.0.0.1:7841/api/pipeline → HTTP 200
PASS  positive control — valid cookie reaches /desktop with the real nav — http://127.0.0.1:7840/desktop, nav has TODAY/PIPELINE/MONEY/BUSINESSES
PASS  negative control — tampered cookie redirects to /signin — http://127.0.0.1:7840/signin
PASS  negative control — no cookie at all redirects to /signin — http://127.0.0.1:7840/signin

5/5 PASS
```

**Why the positive control asserts CONTENT and not just a status.** "Not
`/signin`" is too weak — a 200 that renders a blank shell passes it and proves
nothing. The positive control therefore requires exactly one `<nav>` and the
four labels `TODAY`, `PIPELINE`, `MONEY`, `BUSINESSES` inside it. (Note: the nav
items are **not** `<button>` elements — the whole page has exactly one
`<button>`, the theme toggle. A selector of `nav button` matches nothing, which
is how the first draft of this harness failed.)

**Why the negative control uses a tampered token rather than no token.** A
missing cookie is the easy case; every middleware catches it. The failure mode
that matters is a *present but invalid* cookie — the exact shape of a wrong salt
— so the harness mangles the last six characters of a valid token and requires
the redirect. Both are asserted; `controls` also runs the no-cookie case.

**Every browser step re-asserts.** `assertNotSignin()` runs on the initial load,
after each navigation and immediately before every screenshot, and it **throws**.
A warning would let a `/signin` page be photographed and filed as "the
Businesses tab is empty" — the precise failure this project exists to kill.

---

## 5. Two more traps this harness hit, both now asserted against

### 5a. `localStorage` surface seeding must be JSON-encoded

`DesktopApp.tsx:239` restores the open surface through `usePersistentState`
(`_ui/ResizableSplit.tsx:313`), which does `JSON.parse(raw)` inside a try/catch
whose catch body is empty. Seed the **bare** string:

```js
localStorage.setItem("forge.desktop.surface", "businesses")   // WRONG
```

…and the parse throws, the catch swallows it, the surface stays `today`, and you
photograph the TODAY page. **This harness did exactly that on its first run** —
the shot is not committed; the corrected one is. The fix is `JSON.stringify(s)`,
and `openSurface()` now additionally (a) reads the key back and compares, and
(b) refuses to screenshot any page still showing TODAY's `"Good evening"`
greeting.

### 5b. `waitUntil` must be `"commit"`

Measured, on a box running five lanes' harnesses at once:

- `"networkidle"` **never arrives** — DesktopApp polls (`refetchInterval`), so
  the network is never quiet for 500 ms.
- `"domcontentloaded"` **also never arrives**, which is the surprising one. Next
  15 streams App-Router HTML; with a suspended boundary still open the document
  stays in `loading` readyState. A playwright `response` trace shows
  `RESP 200 http://127.0.0.1:7840/signin` while the same `goto` times out at
  45 s — and `curl` answers the identical URL in 9 ms in the same second.
- `"commit"` fires when the final response (after the redirect chain) is
  committed. That is exactly what the `/signin` assertions need, and
  `waitForSelector` polls the DOM happily while the stream is still open.

Navigation timeout is 60 s, not playwright's 30 s: a 1-minute load average of
~4 was measured while this was built, and a timeout under contention is a
measurement artefact that looks exactly like a broken page.

---

## 6. Screenshots (N7)

```bash
node docs/plan/artifacts/os-usable-for-work/phase5/harness.mjs shots
```

Writes `/opt/ai-os/uploads/$FORGE_RUN_ID/<compact-UTC-stamp>-<label>.png`. The
harness **refuses to run** if `FORGE_RUN_ID` is unset rather than guessing a
directory — a shot written anywhere else is invisible to Konrad and gone at the
next reboot.

**Writing the file renders nothing.** The desktop chat renders a shot inline
only when the transcript shows a `Read` of its path (or a printed JSON
`"url": "/api/uploads/<id>/<name>"`). Read every shot back.

Then copy into this directory for permanence. The three committed here match
their uploads by sha256:

| File | sha256 (first 16) |
|---|---|
| `before-businesses.png` | `4142fe08ff4be0f2` |
| `before-pipeline.png` | `3f79a8f830b3cecf` |
| `before-money.png` | `2313db207bcdc577` |

---

## 7. Full reproduce, end to end

```bash
cd /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--business

cd forge-control      && pnpm install --frozen-lockfile --prod=false
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false

# 1. the API
cd ../forge-control
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
SERVE_PIPELINE_PORT=7841 ./node_modules/.bin/tsx \
  ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts &

# 2. the web build, baked against it
cd ../forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7841 NODE_ENV=production pnpm build
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
AUTH_URL=http://127.0.0.1:7840 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7840 &

# 3. controls, then shots
cd ..
node docs/plan/artifacts/os-usable-for-work/phase5/harness.mjs all
```

`setsid` the background servers. A plain `&` from a tool-driven shell dies with
its parent, and — separately — **do not `pkill -f 'next start -p 7840'`**: that
pattern matches the very command line running the `pkill`, so the shell kills
itself (observed twice, exit 144). Match on the pid from `ss -ltnp` instead.

## 8. What this harness deliberately does NOT do

- **No SSE.** The pass-through buffers the whole body before replying, so
  `GET /api/chat/:id/events` and any other stream hangs. Phase 5 needs none.
- **No writes, anywhere.** It mounts one read-only router and reads two
  databases. It runs no `pm2` command at all.
- **It is not a replacement for gates 23/24.** Those browser gates in
  `gates-808.sh` want `PHASE600_BASE_URL` / `PHASE700_BASE_URL` /
  `PHASE700_API_URL` on their own ports; this harness serves a different port
  set on purpose. See `gates-baseline-business.txt`.
