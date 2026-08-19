# The shared authenticated-browser harness

**Built once, in phase 1, task B1d. Phases 2–6 consume it and do not rebuild it.**
Architecture `02-architecture.md §0.2` (N3) · quality `03-quality.md §1.3`.

Runnable script: `browser-harness.mjs`, next to this file.
Proof it works: `harness-proof.png`, next to this file — the authenticated `/desktop` surface with
Konrad's real live data, captured through it at 2026-08-18T19:41:24Z.

---

## 1. What problem this solves, and why it is not optional

`forge-control-web/middleware.ts` redirects every unauthenticated request to `/signin`. An agent that
points a browser at the OS naively screenshots the login page, sees no memory notes, and files
*"the memory surface renders empty"* — inventing exactly the class of defect this project exists to
remove. Five lanes each discovering that wall independently is five wasted rounds, and the failure is
**silent**: `/signin` returns HTTP 200 and screenshots beautifully.

So the harness does two things: it gets past the wall, and — the part that matters — it **asserts**
it got past, as a hard error, before anything on the page is believed.

---

## 2. The recipe, end to end

Copy-pasteable. Run from the worktree root.

```bash
# 0. dependencies FIRST, in both packages. NODE_ENV=production makes a bare
#    --frozen-lockfile skip devDependencies: it says so quietly, exits 0, prints
#    "Already up to date", removes typescript, and the next command dies with
#    "tsc: not found" while the install looked clean. The tell is `- typescript`.
cd forge-control     && pnpm install --frozen-lockfile --prod=false
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false

# 1. build this worktree's web app (NOT the live checkout)
cd forge-control-web && NODE_ENV=production pnpm build

# 2. pick a FREE spare port and check it really is free. 7700 is the live API,
#    7701 the live UI; 7783/7786/7798/7852/7853 were taken on 2026-08-18.
ss -lnt | grep -q ':7781 ' && echo "7781 BUSY — pick another" || echo "7781 free"

# 3. start it. AUTH_URL decides the salt (see §3) — set it explicitly, do not
#    let it inherit production's https value from the env file.
cd forge-control-web
nohup bash -c 'set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a;
  AUTH_URL=http://127.0.0.1:7781 NEXTAUTH_URL=http://127.0.0.1:7781 \
  exec ./node_modules/.bin/next start -p 7781' > /tmp/next-7781.log 2>&1 &
sleep 10 && grep -q Ready /tmp/next-7781.log && echo up

# 4. drive it. The harness mints its own cookie; there is no step to copy one.
cd ..
node docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs \
  --base http://127.0.0.1:7781 \
  --path /desktop \
  --shot "/opt/ai-os/uploads/$FORGE_RUN_ID/$(date -u +%Y%m%dT%H%M%SZ)-<label>.png"

# 5. stop it when done
pkill -f 'next start -p 7781'
```

`/opt/forge-ai-os/forge-control-web/.env.local` is **READ** in step 3 and by the harness. It is never
written. That is the only contact this task has with the live checkout.

---

## 3. THERE ARE TWO SALTS. This is the trap that has cost the fleet two rounds.

In auth.js v5 **the session cookie's name is also the JWE salt**, and the name is decided by the
**running server's `AUTH_URL`** — not by the port you dial.

| Target | server's `AUTH_URL` | salt **and** cookie name | `secure` |
|---|---|---|---|
| throwaway `next start` from this worktree (§2) | `http://127.0.0.1:7781` | `authjs.session-token` | `false` |
| the live UI — `:7701`, and the https host | `https://os.schreiner…` | `__Secure-authjs.session-token` | `true` |

`browser-harness.mjs --salt auto` (the default) picks `secure` for an `https` `--base` **or** for a
port in its `LIVE_HTTPS_PORTS` set, which today is `{7701}`; `plain` otherwise. It prints which it
chose and why. Override with `--salt plain|secure|<literal>` when you know better — and if you add a
new always-https port, add it to `LIVE_HTTPS_PORTS` rather than passing `--salt` at every call site.

Two details that bite:

- CDP rejects `secure: false` on a `__Secure-` prefixed name outright:
  `Protocol error (Storage.setCookies): Invalid cookie fields`. The harness ties `secure` to the salt
  so this cannot be got wrong independently.
- A wrong salt is a **307 to `/signin`**, indistinguishable from an expired token. The harness's error
  message therefore names the salt as the FIRST suspect, `AUTH_SECRET` drift second, `maxAge` third.

---

## 4. The invocation contract

```
node browser-harness.mjs --base <url> [--path /route] [options]
```

`--help` prints the full option list. The contract phases 2–6 depend on:

| Channel | Content |
|---|---|
| **stdout** | exactly one JSON object — `{ok, url, status, title, salt, secure, shot, html, eval, consoleErrors, failedRequests, blockedExternal, startedAt, finishedAt}`. Parse this. It is emitted on **failure too**, so a failed run is still diagnosable. |
| **stderr** | human progress, one line per step. `--quiet` silences it; stdout is unaffected. |
| **exit 0** | navigated **and** cleared the `/signin` assertion. |
| **exit 1** | usage error, mint failure, dead port, navigation failure, missing `--wait-selector`. |
| **exit 2** | **the auth wall.** Reserved for it, so a caller can distinguish "the cookie is wrong" from "the page broke". |

Options worth knowing before you write a phase-2 check:

- `--eval '<function body>'` / `--eval-file <f>` — run JS in the page, JSON result lands under
  `eval`. This is how you measure `document.fonts.check(...)`, `getComputedStyle(...)`, a DOM handler's
  presence, or a node count, instead of squinting at a PNG.
- `--dump-html <f>` — the rendered DOM. `03-quality.md §1.5` requires exactly this for A2
  ("Open in Obsidian does nothing": a DOM dump showing no handler).
- `--wait-selector <sel>` — hard-fails if the selector never appears, unless `--keep-going`. The
  `/signin` assertion is **never** downgraded by `--keep-going`.
- `--cookie-out <f>` — writes the minted token (mode 600) for anything wanting `FORGE_SESSION_COOKIE`,
  e.g. `gates-808.sh --browser`.
- `--web-dir <path>` — only needed when running the script from outside the repo (§7).

**Zero new dependencies.** playwright is resolved at runtime from `/opt/hermes-workspace/node_modules`
and chromium from `/root/.cache/ms-playwright`. Nothing is added to any `package.json` or
`pnpm-lock.yaml` — phases 2–6 run under gates that diff the lockfile. Do **not** "fix" a resolution
error with `pnpm add playwright`.

---

## 5. Failure modes, each one observed rather than imagined

**Failure 1 — the auth wall.** Exit 2, and the message names the salt first. Reproduced deliberately
on 2026-08-18 by running `--salt secure` against the http throwaway server: exit 2, and **no
screenshot was written**, because nothing after the wall is believed. That negative control is how you
know the assertion is real and not decorative. Re-run it if you ever change the assertion.

**Failure 2 — nothing is listening.** The harness probes the TCP port before launching a browser and
fails with `nothing is listening on <host>:<port>`. A dead port is not a dead surface; a browser error
page is not evidence about the product.

**Failure 3 — `tsc: not found` / `next-auth/jwt` unresolvable.** `NODE_ENV=production` plus a bare
`--frozen-lockfile` pruned the dev tree. Re-run the two installs in §2 step 0 with `--prod=false`.

**Failure 4 — the navigation hangs for the whole timeout, INTERMITTENTLY.** The app links three
Google Fonts stylesheets (Inter, JetBrains Mono, Material Symbols). `fonts.googleapis.com` has both an
A and a AAAA record and **this host has no working IPv6 egress**:

```
$ curl -sS -o /dev/null -w '%{http_code} %{time_total} %{remote_ip}\n' https://fonts.googleapis.com/css2?family=Inter
   000  20.002  (connect timeout — resolver returned 2a00:1450:4010:c0e::5f)
$ curl -4 ... same URL
   200  0.220  209.85.233.95
```

A render-blocking stylesheet that never resolves means `DOMContentLoaded` never fires, `page.goto`
times out, and a **live** surface is reported dead. Measured 2026-08-18: 2 of the first 3 navigations
stalled to a 45 s timeout; 6 later ones loaded in ~1.4 s once the resolver was handing back the A
record. **The variable is DNS, not the page** — and an intermittent false negative is worse than a
reliable one, because it teaches you to retry instead of to look.

So the harness **blocks third-party origins by default** and lists every blocked URL under
`blockedExternal`. It never hides what it withheld. `--allow-external` turns blocking off.

**Failure 5 — the artefact that blocking creates, which phase 2 must not misread.** With fonts
blocked, the UI falls back to system fonts **and the Material Symbols ligatures render as literal
words**: `settings SETTINGS`, `search search everything`, `light_mode`. That is visible in
`harness-proof.png` and it is **an artefact of `--allow-external` being off**, not Konrad's defect.

> **A5 ("weird font") must be measured, not eyeballed** — and the instrument `03-quality.md §1.5`
> prescribes for it is **inert**. Measured here, blocked vs allowed, same page, same run:
>
> | instrument | fonts loaded | fonts blocked | discriminates? |
> |---|---|---|---|
> | `document.fonts.check("1em Inter")` | `true` | `true` | **NO** |
> | `document.fonts.check("1em NoSuchFontXYZ")` | `true` | `true` | **NO — true for a family that does not exist** |
> | `getComputedStyle(body).fontFamily` | `Inter, system-ui, …` | `Inter, system-ui, …` | **NO — it echoes the CSS, not what rendered** |
> | width probe: `w("Inter") !== w("serif")` @64px | `609.81` vs `552.91` → **true** | `552.91` vs `552.91` → **false** | **YES** |
> | `failedRequests` / `blockedExternal` | `0` | `2` | YES |
>
> Two of the three instruments in §1.5 answer the same thing at every value — the classic inert
> assertion. Use the **width probe** as the discriminator and carry the request status alongside it:
>
> ```bash
> --eval 'const w=f=>{const s=document.createElement("span");s.textContent="Konrad 0123 mmmiii";
>   s.style.cssText="position:absolute;visibility:hidden;font-size:64px;font-family:"+f;
>   document.body.appendChild(s);const x=s.getBoundingClientRect().width;s.remove();return x;};
>   return {applied: w("Inter")!==w("serif"), inter: w("Inter"), serif: w("serif")};'
> ```
>
> Worth carrying into A5 as a hypothesis: **nothing in this app self-hosts its fonts or its icon
> font** — `app/layout.tsx:39-50` links all three from `fonts.googleapis.com`, and
> `app/globals.css:13,23,29` names `Inter`, `JetBrains Mono` and `Material Symbols Outlined` with no
> local `@font-face`. So any font-load failure anywhere — Konrad's network, an extension, a blocked
> CDN — degrades the whole UI to fallback text with the icon names spelled out. That is a plausible
> mechanism for the complaint and is cheap to confirm or kill. It is a hypothesis, not a finding:
> nothing here measures what Konrad's own browser did.

**Failure 6 — the throwaway UI is NOT sandboxed from the live API.** `next.config` bakes the proxy
rewrite at **build** time: `/api/proxy/:path*` → `http://127.0.0.1:7700/api/:path*` unless
`FORGE_CONTROL_URL` was set when `pnpm build` ran. So a page served from your throwaway port reads —
and would **write** — the **live** forge-control API. That is deliberate and desirable for read-only
reproduction (the proof screenshot shows Konrad's real inbox and fleet), and it is a live-fire hazard
for anything that clicks. Rules:

- Never drive a mutating control (✕, stop, terminate, delete, save) against a build baked at `:7700`.
- If a phase must exercise writes, **rebuild** with `FORGE_CONTROL_URL=http://127.0.0.1:<throwaway>`
  — the value is baked in, so setting it only at `next start` changes nothing.
- Re-assert row state immediately before any click, and again between runs of the same script: a
  settled row can be running by the next execution.

**Failure 7 — the throwaway `next start` does not survive between your tool calls.** Observed
repeatedly on 2026-08-18: a server backgrounded with `nohup`, `setsid` **and** `disown` in one Bash
call was gone by the next one, with no crash line in its log — the agent runtime reaps it. The symptom
in the next call is the harness's own `nothing is listening on 127.0.0.1:7781`, which is correct and
loud, so nobody is misled — but it wastes a round if you were not expecting it.

**Start the server and drive it in the SAME tool invocation**, e.g.

```bash
ss -lnt | grep -q ':7781 ' || { (cd forge-control-web && setsid nohup bash -c '…next start -p 7781' \
  > /tmp/next-7781.log 2>&1 < /dev/null &); sleep 9; }
node …/browser-harness.mjs --base http://127.0.0.1:7781 …   # same call
```

Never interpret a dead port as a dead surface; that is precisely the false negative this harness
exists to prevent, arriving by a different door.

**Failure 8 — two option names belong to node, not to this script.** `--eval` and `--env-file` are
node's own CLI flags and node claims them **even after the script path**. `--env-file` exits **9** with
`node: <file>: not found` before a line of this script runs, which is why the option here is called
`--secret-file`. `--eval` survives only because node requires `=` or a following value in a position
this script's arguments never occupy — treat it as fragile: prefer `--eval-file` for anything
elaborate.

---

## 6. Screenshot discipline (`03-quality.md §1.4`)

1. Write to `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png` — `<stamp>` compact UTC ISO-8601
   (`20260818T194124Z`), `<label>` lowercase `[a-z0-9-]`. `--shot` creates the directory.
2. **Read the file back with the Read tool.** The chat renders a shot inline only when the transcript
   shows a Read of its path. A shot merely written is invisible to Konrad.
3. Copy it into `docs/plan/artifacts/os-usable-for-work/phase<N>/` and commit it. `/opt/ai-os/uploads`
   is not permanent.

---

## 7. Cross-lane use — no merge required

Lanes 2–6 work in **sibling worktrees of the same git dir** (`/opt/forge-ai-os/.git`), so they can
fetch this harness before integration without merging the branch:

```bash
git show project/7851068b-vault:docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs > /tmp/browser-harness.mjs
```

Run it from your own worktree root so it finds `forge-control-web`, or pass `--web-dir` explicitly:

```bash
node /tmp/browser-harness.mjs --base http://127.0.0.1:<your port> --path /desktop \
  --web-dir /path/to/your/worktree/forge-control-web --shot ...
```

It resolves `next-auth/jwt` from **your** `forge-control-web`, so the JWE always matches the server
that will read it. **Pick your own port** — one `next start` per lane, and check `ss -lnt` first.

If you improve the harness, say so in your report so the integration task takes the better version.
Do not fork it silently; two harnesses is how the assertion drifts out of one of them.

---

## 8. The self-test — 11 assertions, all passing at 2026-08-18

Run with the server up (§2). Every one of these was executed before this file was committed;
`--keep-going` and `--secret-file` each failed on the first pass and the **script** was fixed, not the
document.

| # | Assertion | Result |
|---|---|---|
| 1 | positive run against `/desktop` exits 0, HTTP 200, title `forge` | PASS |
| 2 | `--salt secure` against the http server exits **2** (the wall) | PASS |
| 3 | …and still emits the JSON on stdout, with `error` set | PASS |
| 4 | a dead port exits 1 with `nothing is listening` | PASS |
| 5 | that **early** failure still emits the JSON — it dies before the browser launches | PASS |
| 6 | a `--wait-selector` that never appears exits 1 | PASS |
| 7 | `--keep-going` survives it and exits 0 | PASS |
| 8 | a bogus `--wait-until` is rejected, exit 1 | PASS |
| 9 | a missing `--secret-file` is rejected, exit 1 | PASS |
| 10 | `--help` exits 0 | PASS |
| 11 | …and prints no JSON | PASS |

Assertion 2 is the one that matters: it is the **negative control** for the `/signin` guard. A guard
nobody has watched fire is a comment. When it fired, **no screenshot was written** — the run died at
the wall, exactly as intended. Re-run assertion 2 after any edit to `assertPastAuthWall`.

---

## 9. What this harness is NOT

It is not the harness gates 23/24 need. `gates-808.sh --browser` runs
`phase700/network-700.cjs` and `phase600/nav-walk.cjs`, which require the phase800 §2 setup: an API on
its own port with an **isolated `SECRET_STORE_DIR`** and a web build baked against it. Both gates are
SKIPPED in `gates-baseline.txt` and their baseline verdict is therefore UNKNOWN, not green. Do not
substitute one harness for the other.
