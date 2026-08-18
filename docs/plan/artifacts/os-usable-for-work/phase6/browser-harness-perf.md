# browser-harness-perf.md — the authenticated browser harness this task actually ran

**Which harness this is.** `docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.md` **did not
exist** when this task ran — the whole `docs/plan/artifacts/os-usable-for-work/` tree contained only
`phase6/`, created by this task. So this is a **local copy built from the recipe in
`02-architecture.md §0.2`**, which is itself the recipe proven in this repo since phase 500 and recorded
at `docs/plan/artifacts/phase1871/README.md:306`. Task brief: *"do NOT block waiting for phase 1."*

When phase 1's shared harness lands, this file should be reduced to a citation of it plus the two
deltas below, which are specific to a **measurement** task and are not in the shared recipe:

1. the build must be `next build --profile`, or React commit durations are unmeasurable (§3);
2. the throwaway server must outlive the run, and on this box it does not by default (§7).

Every command below was run from the workstream worktree
`/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--perf`, on 2026-08-18.
`/opt/forge-ai-os` was **read** once (§2) and never written.

---

## 1. Dependencies

```bash
cd forge-control-web && pnpm install --frozen-lockfile --prod=false
```

`--prod=false` is not optional. The runtime exports `NODE_ENV=production`, under which a bare
`--frozen-lockfile` prunes devDependencies, prints *"Already up to date"*, exits 0 and removes
`typescript` — and `next` and `tsc` are both devDependency-adjacent binaries this task needs. Observed
output: `Lockfile is up to date, resolution step is skipped / Already up to date / Done in 1s`, and
`node_modules/.bin/` afterwards contained both `next` and `tsc`.

## 2. AUTH_SECRET — a read of the live checkout

```bash
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
```

Permitted and explicitly named as a read in the standing policy. The file is never written.

## 3. Build — `--profile`, and why this task cannot use a plain build

```bash
FORGE_CONTROL_URL=http://127.0.0.1:7700 ./node_modules/.bin/next build --profile
# exit 0, BUILD_ID dBka1xZWW7bsNJ_Ewlheo
```

Two things are load-bearing:

* **`FORGE_CONTROL_URL` at BUILD time.** The Next rewrite `'/api/proxy/:path*' →
  `${FORGE_CONTROL}/api/:path*`` (`next.config.mjs:11`) is baked into `.next/routes-manifest.json` when
  the bundle is built, not read at boot. Build without it and the throwaway server proxies nowhere,
  the board is empty, and the anti-lying card check fires.
* **`--profile`.** Without it react-dom is the plain production build, fiber `actualDuration` is never
  populated, and every per-commit duration would be `null` — leaving only the renderer-wide CDP
  aggregates, which cannot be honestly quoted as component render time. Verified positively rather
  than assumed:

```bash
grep -l "actualDuration" .next/static/chunks/*.js
#   .next/static/chunks/afe62c3a-9238a91ab31f1ea6.js
#   .next/static/chunks/framework-bbe1996ec4353ed9.js
```

and again at runtime — `projects-lag-before.json` carries `preflight.reactProfilingBuild: true` and
`commitDurationSource: "(a) React fiber actualDuration from a next build --profile bundle, per commit"`.
If that flag is ever `false`, every `commitMs` in the file is `null` and the report must say
NOT MEASURED rather than quote a zero.

## 4. Serve on a spare port

```bash
tmux new-session -d -s p6web "cd $PWD && \
  AUTH_URL=http://127.0.0.1:7786 AUTH_SECRET='$AUTH_SECRET' \
  FORGE_CONTROL_URL=http://127.0.0.1:7700 exec ./node_modules/.bin/next start -p 7786"
```

**Port 7786, not the 7781 in the task brief.** 7781 was free but 7798, 7852 and 7853 were already held
by other lanes' throwaway servers (`ss -ltnp | grep :77`), and a port collision between two
concurrently-running lanes produces a measurement of *someone else's build*. The port is one of the
script's two parameters precisely so this is a flag and not an edit.

Never 7701. That is the live `forge-control-web`; the script refuses it outright, both because it is
live and because it runs an https `AUTH_URL` and would need the other salt (§5).

## 5. The cookie — and THERE ARE TWO SALTS

```bash
node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
  token:{name:"phase6",email:"perf@localhost",sub:"perf"},
  secret:process.env.AUTH_SECRET, salt:"authjs.session-token", maxAge:14400})))' > /tmp/p6-cookie.txt
```

`authjs.session-token`, `secure: false` — correct **for this harness**, because the throwaway server
runs an **http** `AUTH_URL`. Production and `:7701` run an https `AUTH_URL`, where auth.js v5 uses
`__Secure-authjs.session-token` as both the cookie name and the JWE salt, with `secure: true`
(`02-architecture.md §0.2`; CDP rejects `secure:false` on a `__Secure-` name outright). Using the wrong
one produces a `307 → /signin` that is indistinguishable from an expired token and has already cost
this fleet two rounds.

Verified in both directions before any measurement, which is the point of doing it with curl first:

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://127.0.0.1:7786/desktop
#   307 -> http://127.0.0.1:7786/signin           (no cookie: the wall is real)
curl -s -o /dev/null -w '%{http_code}\n' --cookie "authjs.session-token=$(cat /tmp/p6-cookie.txt)" \
     http://127.0.0.1:7786/desktop
#   200                                            (cookie: past the wall)
curl -s --cookie "authjs.session-token=$(cat /tmp/p6-cookie.txt)" \
     -o /dev/null -w '%{http_code} %{size_download}\n' http://127.0.0.1:7786/api/proxy/projects/board
#   200 1790636                                    (the rewrite reaches :7700 — the build took)
```

A harness that only ever tests the success case cannot tell "authenticated" from "no wall".

## 6. The mandatory assertion, in the script

`measure-projects-lag.cjs` hard-errors on `/signin` immediately after the first navigation, and the
message names the salt as the first suspect rather than the secret — because "the cookie did not take"
is what sent the last two agents to `AUTH_SECRET` and `maxAge`:

```js
if (/\/signin\b/.test(page.url())) {
  throw new Error(`auth wall: landed on ${page.url()}. FIRST SUSPECT IS THE SALT, not the secret: …`);
}
```

Two further fatal checks specific to a measurement, both in the script: the board must hold ≥ 100 task
cards before any window runs, and the React commit counter must be > 0 after W1. See
`projects-lag-before.md §7`.

## 7. Running it

```bash
RUN_LABEL=before PORT=7786 \
FORGE_SESSION_COOKIE="$(cat /tmp/p6-cookie.txt)" \
PROJECTS_LAG_SHOTS=/tmp/p6-shots \
node docs/plan/artifacts/os-usable-for-work/phase6/measure-projects-lag.cjs --commit-artifact
```

`--commit-artifact` is the explicit opt-in to write inside the repo; without it, and without
`PROJECTS_LAG_OUT`, the script refuses and writes to `/tmp` (the phase-1871 guard, kept verbatim).

**`tmux`, and why it is not decoration.** The throwaway `next start` was killed three times by
something outside this run — twice between tool calls while completely idle, once mid-measurement —
each time with an empty server log and no OOM record readable from this container (`dmesg`,
`journalctl -k` both return nothing here). `nohup` did not survive it and `setsid nohup` did not
survive it. A tmux session did. **The failure is silent and it is not silent in the data:** the run
that died mid-flight recorded three reps of `0 decoded bytes` and `164 requests per 30 s`, which looks
exactly like a catastrophic client-side finding and is not one. So:

```bash
curl -s -o /dev/null -w 'pre-run server: %{http_code}\n' http://127.0.0.1:7786/signin   # before
# … run …
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7786/signin                   # after
```

Both must be `200`. **A run that ends with a dead server is not a measurement of the application** —
it is a measurement of a browser talking to nothing, and `projects-lag-before.md §6` is what that
looks like when you keep the evidence. The script now writes `projects-lag-<label>.partial.json` on
failure for exactly this reason.

## 8. What this harness may and may not do

`GET` through the throwaway UI to `127.0.0.1:7700` is permitted and is the only way to reach live scale
(17 projects, 142 board cards, 6 running). The script drives **navigation and selection only**: the
`TODAY`/`PROJECTS` nav labels, a task card, the `board`/`floor` toggle, and `← board`. It never clicks
`+ new`, the project `×`, `send`, or any run control, and it never restarts anything under pm2. One of
the six running runs on the board during the measurement was this task's own run
(`667663f7-11d5-4d99-ba26-045c128e3c4f`), which is the sharpest possible reason not to click a control.

## 9. THE HARNESS IS HTTP/1.1 AND PRODUCTION IS HTTP/2 — this changes a number by 237×

The single most important caveat in this file, and it was nearly reported as a finding.

The throwaway server is plain http, so the browser opens **HTTP/1.1** connections and is bound by the
per-origin limit of **6 sockets**. In floor view the surface holds exactly **6** `EventSource` streams
to `/api/events/:runId` — one per running task — which is the entire pool. Every ordinary request then
queues behind them:

| request, in floor view | median outside floor view | in floor view (3/3 reps) |
|---|---|---|
| `GET /api/proxy/projects/board` | 109 ms | **25,855 / 25,828 / 25,842 ms** |
| `GET /api/proxy/projects` | ~110 ms | 16,751 / 16,749 / 16,761 ms |
| `GET /api/proxy/chat/:id` | ~40–580 ms | 11,437 / 11,451 / 11,460 ms |

A 237× stall, reproduced three times out of three, deterministic to within 27 ms. It is also **not
Konrad's experience**, because production negotiates HTTP/2, which multiplexes and has no 6-stream
ceiling:

```bash
curl -sI --max-time 15 https://os.schreinercontentsystems.com/signin -o /dev/null -w '%{http_version}\n'
#   2
```

(Worth noting the site config carries no `http2` directive — `grep -rn http2 /etc/nginx/sites-enabled/`
is empty, nginx is 1.24.0 — so this was confirmed by asking a real client rather than by reading the
config, which would have given the wrong answer.)

**Consequence for task C:** the W5 network durations in `projects-lag-before.json` are harness numbers.
A fix that reduces them has not necessarily helped Konrad, and a fix must not be credited with removing
a 25.8 s stall that only ever existed on port 7786. Everything in W1–W4 is uncontaminated — those
windows hold no `FloorTile` and therefore no SSE streams, and their board fetches all measured
91–137 ms.

## 10. Reproducing the whole thing

```bash
cd /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--perf/forge-control-web
pnpm install --frozen-lockfile --prod=false
FORGE_CONTROL_URL=http://127.0.0.1:7700 ./node_modules/.bin/next build --profile
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
tmux new-session -d -s p6web "cd $PWD && AUTH_URL=http://127.0.0.1:7786 AUTH_SECRET='$AUTH_SECRET' \
  FORGE_CONTROL_URL=http://127.0.0.1:7700 exec ./node_modules/.bin/next start -p 7786"
node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
  token:{name:"phase6",email:"perf@localhost",sub:"perf"},
  secret:process.env.AUTH_SECRET, salt:"authjs.session-token", maxAge:14400})))' > /tmp/p6-cookie.txt
cd .. && RUN_LABEL=before PORT=7786 FORGE_SESSION_COOKIE="$(cat /tmp/p6-cookie.txt)" \
  PROJECTS_LAG_SHOTS=/tmp/p6-shots \
  node docs/plan/artifacts/os-usable-for-work/phase6/measure-projects-lag.cjs --commit-artifact
```

Runtime ≈ 8 minutes (3 reps × five windows, each paired with a same-length idle window). Task C runs
the identical line with `RUN_LABEL=after` and **must not edit the script** — a different measurement
after is not a comparison.
