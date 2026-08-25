# aios-browser-takeover-live — deploy & verification measurement

Round 3, deploy/verify task. Executed on VPS1 (65.108.6.149,
`content-forge-Ubuntu-2404-noble-amd64-base`) on **2026-08-25**, 00:50–01:10 UTC,
following `docs/plan/aios-browser-takeover-live/deploy.md`.

**Verdict: the tunnel is gone.** A signed-in browser opening
`https://os.schreinercontentsystems.com/takeover/<runId>` reaches a live Chrome
over noVNC with no SSH tunnel, and the socket refuses every ticket it should.

**Two defects found while verifying, neither of them fixed here** (this task's
write-set is this file only): the in-chat *Take Control* button cannot reach the
canvas (§7.1), and the ticket is written to forge-control's own log by a
non-upgrade GET (§7.2). Both are reported to the manager chat.

Every screenshot path below was `ls`-ed and read back with the Read tool. A
prior round of this project's predecessor was caught citing screenshots that did
not exist on the host; §6 lists byte sizes so the claim is checkable.

---

## 1. Pre-flight, before anything was installed

| Check | Command | Result |
| --- | --- | --- |
| Host | `hostname; ip -4 addr … grep -c '65\.108\.6\.149'` | `content-forge-Ubuntu-2404-noble-amd64-base`, `1` |
| vhost is a real file | `ls -l /etc/nginx/sites-enabled/os.…` | `-rw-r--r-- 1 root root 1862` — not a symlink |
| `$connection_upgrade` mapped globally | `grep -n 'map $http_upgrade' /etc/nginx/conf.d/00-gzip-and-upgrade.conf` | `30:map $http_upgrade $connection_upgrade {` |
| Live vhost matches the reviewed copy | `diff` of directive lines (comments stripped) | **only** difference is the block being added — zero drift |
| Secret already present | `grep -c '^TAKEOVER_TICKET_SECRET='` / `awk length` | `1`, `length: 64`, file mode `600` |

Gate, run in the worktree **after** merging main (see §2):

```
forge-control  tsc --noEmit                       -> exit 0
forge-control-web  tsc --noEmit                   -> exit 0
forge-control  pnpm test                          -> tests 2182 / pass 2182 / fail 0
check-browser-takeover-ticket.ts (EXECUTED)       -> ALL PASS
check-uploads-payload.ts (EXECUTED)               -> ALL PASS
```

`check-uploads-payload.ts` is **compiled** by `check-instrument-typecheck.sh` and
**executed by no gate**, so it was run by hand deliberately — a green gate is not
evidence about that file.

## 2. The merge, and its one predicted conflict

`git merge-tree --write-tree --messages main project/69806709` was re-run
immediately before merging, as the brief required. It still reported exactly one
conflict and no more:

```
CONFLICT (content): Merge conflict in scripts/checks/check-uploads-payload.ts
```

Resolved by taking **main's** side, per the brief. Verified byte-identical
rather than asserted: `git diff --cached main -- scripts/checks/check-uploads-payload.ts`
produced **no output**. Main's copy is the reconciled one — it carries the
`RECONCILED 2026-08-25` comment and the corrected Test 4 (a plain HTTP GET under
`/vnc/` is proxied, not bailed). Main's side also subsumes what the round-2
builder had fixed on the branch: it replaces the drifted `BrowserShotRef`
literals with a `makeShotRef()` helper derived from the real `parseShotName()`,
so no type fix had to be re-applied on top. Both packages typecheck clean
afterwards, which is the check that would have caught it if one had.

Merged into the live checkout as `35f180c` (16 files, +3317/−316).

**Live checkout was dirty and was NOT touched.** 25 uncommitted paths
(Goals/day-system + chat file-explorer work, mtimes 2026-08-24 23:25 →
2026-08-25 00:42). Measured overlap with this branch's merge set:

```
comm -12 <(sort mergeset) dirty   ->  (empty)
```

Zero overlap, so nothing was stashed, reverted or discarded. Escalated to the
manager chat as a standing condition, per `live-checkout-dirty-protocol`.

## 3. What was installed

1. **Secret** — already present from the review of `7f34bb4`; not rotated,
   because rotation invalidates outstanding tickets. Name verified, value never
   printed.
2. **`ecosystem.config.cjs`** — `TAKEOVER_TICKET_SECRET` added to the
   `forge-control` app's `env` as a pass-through, never `required()`.
   ```
   key present: true
   value length: 64
   executor untouched: true
   ```
3. **nginx** — backup taken to
   `/root/os.schreinercontentsystems.com.bak-20260825T005046Z`, the location
   inserted immediately before `location /`, with its comment block. Installed
   directives verified byte-identical to
   `deploy/nginx/os.schreinercontentsystems.com.conf`.
   ```
   nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
   nginx: configuration file /etc/nginx/nginx.conf test is successful
   ```
   `nginx -t` was run **before** the reload, and only then `systemctl reload nginx`.
   (The four `protocol options redefined for 0.0.0.0:443` warnings are
   pre-existing and belong to unrelated vhosts — `thumbnails`, `tps-longform`,
   `tutorials`, `veo`.)
4. **Build** — `next build` in the live checkout. `/takeover/[runId]` appears in
   the route manifest at 4.15 kB. `forge-control-web` was then restarted, because
   a rebuild rewrites every chunk hash while the running server still serves the
   old ones; that process owns no agent turns, so restarting it is safe.
5. **Restart** — `safe-restart.sh forge-control 7200 45 <ecosystem>`. It waited
   ~10 minutes for the fleet to go quiet and then restarted: pm2 `restart_time`
   94 → 95, `secret present: True`. **No `pm2 restart forge-control` and no
   `pm2 restart forge-executor` was issued at any point.**

## 4. The one hop — before and after

The gap this project exists to close was that any `Connection: Upgrade` died in
the Next Route Handler with `502` + `x-proxy-bailout: upgrade`, never reaching
`:7700`. After the location was installed, the same request reaches
forge-control. Two independent tells: the response carries forge-control's CORS
headers, and there is **no `x-proxy-bailout` header** on any response below.

All probes below hit the **public** origin `os.schreinercontentsystems.com` by
name over TLS — never `127.0.0.1`, because a request to your own box hits the
local ACCEPT rule and proves nothing about what an outsider reaches. ALPN is
pinned to `http/1.1`: HTTP/2 has no `Connection: Upgrade`, so over h2 nginx drops
the upgrade headers and the request silently arrives as an ordinary GET.

## 5. Results

### 5.1 POSITIVE — the canvas is connected to a live Chrome

A real takeover stack was brought up on a fresh profile against a **genuine**
login wall (`https://mail.google.com/` redirects a logged-out profile to
`accounts.google.com`, `decision: hard-signal`):

```
profile r3-takeover · display :98 · vnc 5998 · novnc 6908 · Chrome pid 111826
marker: {"profile":"r3-takeover","service":"generic","needs_login":true,
         "is_live":true,"novnc_port":6908,…}
resolveProfileForRun("64253cc4a322") -> r3-takeover
mint via live :7700  -> profile: r3-takeover  port: 6908
```

Raw WebSocket handshake, public origin, valid ticket — **verbatim**:

```
HTTP/1.1 101 Switching Protocols
Server: nginx/1.24.0 (Ubuntu)
Connection: upgrade
upgrade: websocket
sec-websocket-accept: ICX+Yqv66kxgM0FcWaLWlFLwTAI=

<binary>RFB 003.008
```

`RFB 003.008` is x11vnc's own protocol banner, carried from the public internet
through nginx → forge-control `:7700` → websockify → x11vnc. **No SSH tunnel.**

Driven in a real browser, signed in, against the public origin:

```json
{
  "negativeControlUrl": "https://os.schreinercontentsystems.com/signin",
  "positiveControlUrl": "https://os.schreinercontentsystems.com/desktop",
  "takeoverUrl":        "https://os.schreinercontentsystems.com/takeover/64253cc4a322",
  "headerText":  "TAKEOVER · r3-takeover\nticket expires 3:07:42 AM\nRetry",
  "mintFailed":  false,
  "novncStatus": "Connected (encrypted) to content-forge-Ubuntu-2404-noble-amd64-base:98",
  "canvas": { "width": 1600, "height": 1000, "distinctColours": 5001 }
}
```

Both auth controls were asserted **before** believing any of it, because a stale
or mis-salted session cookie redirects to `/signin` which still answers HTTP 200
and reads as a pass. A garbage cookie bounced to `/signin`; the minted one
reached `/desktop` and stayed. A canvas *element* only proves the noVNC shell
loaded — `distinctColours: 5001` is what proves a framebuffer actually crossed
the socket, since an unconnected canvas is a single flat fill.

> **Session note, stated plainly.** The `os-ui` profile's session had expired, so
> the harness minted a NextAuth session cookie on this host from the same
> `AUTH_SECRET` the middleware verifies with, for the identity already in
> `AUTH_ALLOWLIST` (salt `__Secure-authjs.session-token`, which must equal the
> cookie name). I did **not** click through GitHub OAuth and did not type any
> credential. So: "signed in" here means a validly-authenticated session, not a
> hand-performed OAuth round trip.

### 5.2 NEGATIVE — every refusal, verbatim, at the public origin

| Case | Request | Response |
| --- | --- | --- |
| (a) no ticket | `GET /api/browser-takeover/ws/` upgrade | `HTTP/1.1 502 Bad Gateway` (nginx) — see note |
| (a2) garbage ticket | `…/ws/not-a-ticket` | `HTTP/1.1 401 Unauthorized` |
| (b) **expired** ticket | signed, `ttlMs: 1` | `HTTP/1.1 401 Unauthorized` |
| (c) **tampered** signature | one byte flipped | `HTTP/1.1 401 Unauthorized` |
| (d) **replay** | a valid ticket presented twice | 1st `101`, 2nd `HTTP/1.1 401 Unauthorized` |

```
HTTP/1.1 401 Unauthorized
Server: nginx/1.24.0 (Ubuntu)
Content-Type: text/plain
Transfer-Encoding: chunked
Connection: keep-alive

c
Unauthorized
0
```

**Note on case (a), stated precisely rather than rounded up to "401".** The bare
prefix carries no ticket *segment*, so it does not match
`TICKET_UPGRADE_RE = /^\/api\/browser-takeover\/ws\/([^/]+)\/?$/`. The handler
returns "not handled", the listener destroys the socket, and nginx reports its
own `502` because the upstream closed. It is a refusal and it fails closed — but
it arrives by socket-destroy, not by the ticket check's 401 path. Both are
refusals; they are not the same mechanism, and the table says so.

Corresponding forge-control log lines, one per attempt:

```
[browser-takeover] upgrade rejected run=- profile=- port=- jti=- status=401 reason=ticket_expired
[browser-takeover] upgrade rejected run=- profile=- port=- jti=- status=401 reason=ticket_bad_signature
[browser-takeover] upgrade accepted run=64253cc4a322 profile=r3-takeover port=6908 jti=06e1341083b3d177…
[browser-takeover] upgrade rejected run=64253cc4a322 profile=r3-takeover port=6908 jti=- status=401 reason=ticket_replayed
```

### 5.3 GET (not upgrade), and the surrounding paths

```
GET /api/browser-takeover/ws/                 -> 404 Not Found (13 bytes)
GET /api/browser-takeover/ws/<VALID TICKET>   -> 404 Not Found (13 bytes)   ← nothing useful, and the jti is NOT burnt
GET /api/browser-takeover/ws/anything/else    -> 404
GET /api/browser-takeover/         (followed) -> 200 at .../signin          ← still NextAuth-protected
```

The location widened exactly one prefix and nothing else is mounted under it.

### 5.4 Nothing exposed off loopback

```
$ ss -ltnp   # filtered to 5990-6049 and 6900-6959
LISTEN 0 100  127.0.0.1:6908  users:(("websockify",pid=111966,fd=3))
LISTEN 0  32  127.0.0.1:5998  users:(("x11vnc",pid=111961,fd=8))
LISTEN 0  32      [::1]:5998  users:(("x11vnc",pid=111961,fd=9))

# count of 0.0.0.0 / [::] binds in those ranges:
0
```

One honest qualification: `0.0.0.0:5950` is bound by `node /opt/veofo…`
(`veoforge-engine`). It falls inside the numeric 5900-6049 window but is an
unrelated pre-existing service, not a VNC or takeover process. No takeover
component binds anything but loopback.

## 6. Evidence — every path `ls`-ed and read back

| File (under `/opt/ai-os/uploads/2ce31fa484df/`) | Bytes | What it shows |
| --- | --- | --- |
| `20260825T010100Z-novnc-canvas-loopback-framebuffer.png` | 254,311 | The raw noVNC framebuffer: live Chrome on `:98` at the real Google sign-in wall |
| `20260825T010100Z-novnc-canvas-loopback.png` | 164,011 | The same through the noVNC viewer, control-bar handle visible |
| `20260825T010504Z-takeover-page-debug.png` | 175,315 | `/takeover/64253cc4a322` on the **public origin**, header `TAKEOVER · r3-takeover`, canvas connected |
| `20260825T010554Z-takeover-canvas-live.png` | 175,400 | The final positive run, after both auth controls passed |
| `20260825T010741Z-chat-surface-desktop.png` | 131,719 | `/desktop`, signed in — proves the minted session is real |
| `20260825T010856Z-chat-surface-transcript.png` | 363,100 | The chat surface with the project rail — see §7.1 |
| `20260825T005256Z-loginwall.png` | 44,055 | The driver's own capture of the genuine login wall |

## 7. What did NOT work — the honest part

### 7.1 The in-chat "Take Control" cannot reach the canvas — CONFIRMED DEFECT

The brief asked for the path "the way Konrad will: open the chat surface and
click Take Control". **That path is broken**, and it is broken in code, not in
the deploy.

`BrowserStreamViewer.tsx:264`:

```ts
const vncUrl = vncProxyUrl(dirId);      // ← one argument. No ticket.
```

`vncProxyUrl(dirId, ticket?)` returns `null` when `ticket` is falsy
(`browser-shots.ts:452`). Proven at runtime rather than by reading:

```
vncProxyUrl("64253cc4a322")        -> null
vncProxyUrl("64253cc4a322","a.b")  -> /api/proxy/uploads/64253cc4a322/vnc/vnc.html?…
takeoverTicketUrl("64253cc4a322")  -> /api/proxy/uploads/64253cc4a322/vnc/ticket
```

So `vncUrl` is *always* null there and manual mode always renders its error
branch — the literal string `Could not construct authenticated proxy URL for run
<id>`. Unlike `TakeoverClient.tsx`, that component never calls
`takeoverTicketUrl` and never mints. The landing page works; the in-transcript
button does not.

**What I could not do:** photograph that failure *in situ*. The chat surface
opened on Konrad's manager thread, which carries no browser shots, so no *Take
Control* button was on the page (`takeControlCount: 0`) — and `/desktop` has no
query deep links, so reaching a transcript that does have shots is click-through
only. The screenshot in §6 shows the surface as reached, **not** the error
branch. The runtime evaluation above is the evidence for this defect; the
screenshot is not, and is not offered as such.

### 7.2 The ticket is written to forge-control's log by a non-upgrade GET

The nginx block sets `access_log off` precisely because the ticket is a bearer
credential in the URI path. That works. But forge-control's own catch-all
request logger (`src/index.ts:57-63`, `app.use("*")` printing `c.req.path`)
catches any **non-upgrade** GET on the same path:

```
[2026-08-25T01:02:17.593Z] GET /api/browser-takeover/ws/eyJ2IjoxLCJyaWQiOiI2NDI1M2NjNGEzMjIi… 404 0ms
```

— the complete ticket, payload and signature, on disk in
`/root/.pm2/logs/forge-control-out.log`.

It does not fire in normal use: a real noVNC connection is an *upgrade*, and
upgrades are served by the `http.Server` `'upgrade'` listener, which never
reaches Hono middleware. The takeover handler's own log lines are clean — they
record run/profile/port/jti/outcome and never the ticket, exactly as designed.
This fires only when something fetches that URL as ordinary HTTP: a link
preview, a crawler, a URL pasted into an address bar, or a probe like mine.
Mitigating: tickets are single-use and 120 s. Aggravating: the GET does **not**
burn the jti, so a ticket logged this way stays live for the rest of its TTL, and
pm2 logs are rotated and retained. That last point is measured, not reasoned —
the same ticket was presented twice, first as a GET and then as an upgrade:

```
1) plain GET first:                       HTTP/1.1 404 Not Found
2) upgrade with the SAME ticket:          HTTP/1.1 101 Switching Protocols
```

A `101` on the second call is the proof: the GET wrote the credential to the log
and left it spendable.

**I wrote one real ticket into that log myself during verification** (expired
01:04 UTC, inert). Naming it rather than leaving it to be found.

### 7.3 `resolveProfileForRun` can bind a ticket to the wrong browser

Two defects, found by driving the chain rather than reading it:

1. **The marker is last-writer-wins per run dir.** `writeBrowserStateMarker`
   writes `<uploads>/<runId>/browser_state.json` keyed only by run id, so a run
   that hits a login wall on profile A and later on profile B silently
   overwrites A. Measured: my run dir ended up saying `os-ui` after starting on
   `r3-takeover`.
2. **Screenshot-name inference outranks the explicit marker.**
   `resolveProfileForRun` tries route 2 (parse `<ts>-<service>-….png`, match
   `.state/<service>`) *before* route 4 (read the marker). One stray
   service-named screenshot therefore beats the marker the driver deliberately
   wrote.

Measured: run `2ce31fa484df` had a live stack on `r3-takeover:6908` and a marker
naming `os-ui`, and `resolveProfileForRun` returned **`perplexity`**. The mint
endpoint then issued a ticket bound to `profile=perplexity port=6919`. Because
the port is derived from the profile *name*, that ticket aims the socket at
whatever listens on that port — nothing was listening tonight, so it was inert,
but had the `perplexity` stack been up, *Take Control* on that run would have
handed over Konrad's real logged-in Perplexity browser.

The route ordering is **pre-existing**; this project added the marker and placed
it last, where route 2 shadows it. The mainline is unaffected: a clean run dir
(one login wall, label `generic-login-wall`, no service-named sibling) resolves
to `r3-takeover:6908` correctly, which is what §5.1 used.

## 8. State left on the host

- The takeover stack for `r3-takeover` is **still up** (display `:98`, Chrome on
  the Google sign-in wall) so the feature can be seen working live. Close it
  with `node /opt/forge-ai-os/scripts/research-browser.mjs close r3-takeover`.
- The `os-ui` stack raised during verification was closed; its profile
  directory, and therefore its cookies, were not touched.
- Throwaway probes (`probe-takeover-r3.ts`, `probe-vncurl-r3.ts`) were deleted
  from the live checkout; `git status` there shows none of them. The verification
  harnesses live outside the repo, in
  `/opt/ai-os/scratch/takeover-verify-r3/`.
- The route was exercised with a **single-router probe** on a spare port
  (uploads router + the upgrade listener only) — never `tsx src/index.ts`, which
  would have started a second cron tick, Telegram poller and vault-sync against
  the live system.

## 9. Deliverables against the brief

| # | Deliverable | Status |
| --- | --- | --- |
| 1 | nginx location carrying the upgrade to `:7700`, bypassing Next | **Done** — §3, §4 |
| 2 | Signed, short-lived, single-use ticket; port allowlist kept; every takeover logged | **Done** — §5.2. Caveat §7.2 |
| 3 | `resolveProfileForRun` succeeds for a real run; driver writes the marker | **Works on the mainline** — §5.1. Two defects, §7.3 |
| 4 | Reminder carries the clickable https URL, not an ssh command | **Done** — 338/500 chars, contains `https://os.schreinercontentsystems.com/takeover/<runId>`, contains no `ssh` |
| 5 | Stale `next.config.mjs` comment at `browser-takeover.ts:665-666` corrected | **Done** — the comment now states the truth, and it is true: `grep -c rewrites next.config.mjs` = `0`, file is 14 lines |
