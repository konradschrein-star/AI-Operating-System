# aios-browser-takeover-live — plan (round 0)

**Goal.** Konrad clicks a link in his chat, lands in the agent's live Chrome, logs in by
hand, the agent resumes. No SSH tunnel.

## Recommendation

Carry the websockify upgrade on a **dedicated, single-purpose URL prefix**
`/api/browser-takeover/ws/<ticket>` served by an exact nginx `location` that
`proxy_pass`es to `127.0.0.1:7700`, bypassing Next entirely. The **ticket is the
credential**: an HMAC-SHA256-signed, 120-second, run+profile+port-bound blob carried in
the URL *path segment*. forge-control verifies it before proxying a single byte, and takes
the profile and port **from the signed payload**, never from a client-supplied run id.
Every existing upgrade arm that accepts a bare run id is deleted, so there is exactly one
authentication rule on the socket instead of "the safe one and the other one".

Reasoning, in order of what drove the design:

1. **A dedicated prefix, not a regex over `/api/uploads/`.** The nginx location bypasses
   NextAuth. Anything it covers is public. `location /api/browser-takeover/ws/` covers
   exactly one handler and cannot shadow an upload route, a shots index, or a future
   `/api/uploads/*` addition. A regex like `~ ^/api/uploads/[^/]+/vnc/websockify$` would
   work today and would silently widen the day someone adds a sibling path.
2. **Ticket in the path, not the query.** Measured in noVNC's own source: `ui.js:1019-1025`
   builds the socket URL by bare string concatenation, `url += '/' + path`, and
   `webutil.js:32-43` captures the `path` query var with `[^&#]*`. A ticket in a path
   segment (base64url — no `&`, no `#`) round-trips cleanly. A query-form ticket also
   happens to survive today, but only because `?` is not in that exclusion set; it breaks
   the moment a ticket needs a second parameter. Path form has no such edge.
3. **Verify at upgrade time, not for the session's life.** The ticket authorises
   *establishing* the socket. Once the 101 is written the session runs as long as Konrad
   needs. 120 s is generous for a click-to-connect and short enough that a leaked URL is
   worthless.
4. **`reconnect=0` is mandatory, not cosmetic.** noVNC rebuilds the socket URL from the
   `path` setting frozen at page load (`ui.js:1062-1070` → `connect()` → `rfb.js:83`), so an
   auto-reconnect replays an **expired** ticket and shows Konrad an opaque failure. Disable
   noVNC's reconnect; the viewer re-mints and reloads the iframe instead.
5. **Only forge-control holds the signing key.** The mint endpoint lives on `:7700` and is
   reached through the already-authenticated `/api/proxy` hop, so the Next process never
   needs the secret and there is one copy of it on the box.

Rejected alternatives, one line each:

- *Make the Next Route Handler proxy the upgrade* — impossible: no socket access, `Response`
  rejects 101 (vercel/next.js #58698, #95514); this is the gap, not the fix.
- *nginx `auth_request` against the NextAuth session* — the session cookie is a JWE that only
  the Next process can open, so it needs a new decrypt endpoint anyway; a signed ticket is
  the same work without a second round trip on every upgrade.
- *HTTP Basic auth on the location* — survives an upgrade, but adds a second credential
  Konrad must hold and is unbound to run, profile, or expiry.
- *Bare run id over a loopback-only nginx location* — the brief's own prohibition, and the
  correct one: guessing a run id would hand over a logged-in Google session.
- *Single-use tickets with a replay store* — adds state to a stateless check to defend
  against replay inside a 120 s window by whoever already holds the URL.
- *`location ~ ^/api/uploads/.../websockify$`* — see (1).

## Corrections to the brief's established facts

Both measured on this host, 2026-08-25, and both change what a builder should do:

1. **"Right now NOTHING listens in 6900-6959 or 5990-6049" is no longer true.** `ss -ltnp`
   shows `websockify` on `127.0.0.1:6941` (pid 3831317) and `x11vnc` on `127.0.0.1:6031`
   and `[::1]:6031` (pid 3831277) — a live takeover stack on display `:131`. Both are
   loopback-only, so the "never on 0.0.0.0" rule holds. Do not assume a clean slate.
2. **The driver IS in this repo.** The brief says the driver is at
   `/opt/ai-os/scratch/gemfix/scripts/research-browser.mjs` and "NOT /opt/ai-os/scripts/".
   True, but incomplete: `scripts/research-browser.mjs` is **tracked in this repo**
   (last touched `b0d0f4b`), 2284 lines, and byte-identical to both the scratch copy and
   the live `/opt/forge-ai-os/scripts/research-browser.mjs`. Builders edit the **worktree
   copy**; the deploy task ships it.

And one thing the brief overstated in our favour:

3. **`ensureTakeover` already runs on a login wall, unconditionally** — `research-browser.mjs:1774`,
   inside `handleRequest`, before the verdict is even checked. Deliverable 3 is therefore
   *not* "start the takeover stack"; the stack already starts. The only missing half is the
   **marker** that lets `resolveProfileForRun` map a run id to a profile.

## What owns state, what dispatches, what happens on failure

| Concern | Owner |
| --- | --- |
| Signing key | `/opt/ai-os/.secrets/forge-control.env` (0600), the file `ecosystem.config.cjs` already reads |
| Ticket mint | forge-control `:7700`, behind the authenticated `/api/proxy` hop |
| Ticket verify | forge-control's `'upgrade'` listener, before any byte is proxied |
| Profile → display → port | `displaySlot()` / `portsForDisplay()`, unchanged |
| Run → profile | `browser_state.json` in the run's upload dir, written by the driver |
| Takeover processes | `research-browser.mjs`'s `ensureTakeover`, unchanged |

**On failure, everything fails closed and loudly.** Missing secret → mint and verify both
throw; no unsigned path exists. Bad/expired ticket → the socket gets an HTTP status line and
closes, and the reason is logged. Stack down → the mint endpoint still answers, the socket
proxy fails to connect to loopback, and the takeover page renders the error rather than a
blank canvas. No fallback anywhere converts a failure into a silent success.

**How Konrad sees it broke:** the `/takeover/<runId>` page renders the failure text
inline — it is the page the reminder links to, so a failure is visible at exactly the moment
he tries to use it. forge-control logs one line per upgrade attempt (accepted or rejected)
with run id, profile, port and outcome — never the ticket itself.

### Secret provisioning — the landmine to avoid

`ecosystem.config.cjs`'s `required()` **throws and refuses to boot the whole control plane**
if a name is missing. Do **not** wire `TAKEOVER_TICKET_SECRET` through `required()`: a deploy
that reloads pm2 before the secret file is updated would take the entire AI OS down for a
browser feature. Pass it through as an optional env var and make the **ticket code** throw on
mint and on verify when it is absent. The feature dies loudly; the OS stays up. The deploy
task writes the secret to the 0600 file **before** any restart regardless.

## Work

Files, one owner each:

- `forge-control/src/lib/takeover-ticket.ts` (+ test) — mint/verify. Payload
  `{v:1, rid, prof, port, exp, jti}` → `base64url(json).base64url(hmac)`. Read the env var
  **inside** the function, never at module scope (a module-level capture is what made an
  earlier round's proxy tests run against production). `timingSafeEqual` on the signature,
  then expiry, then `PROFILE_RE`, then the 6900-6959 port range.
- `forge-control/src/lib/browser-takeover.ts` — new `kind: "ticket"` arm matching
  `/api/browser-takeover/ws/<ticket>`; `handleBrowserTakeoverUpgrade` requires a valid ticket
  on **every** arm it accepts; delete the bare run-id and bare profile upgrade arms. Reuse
  `proxyTakeoverUpgrade` untouched. Keep both port-allowlist checks. **Fix the false comment
  at lines 665-666** — `next.config.mjs` contains no `rewrites()` at all (verified: 14 lines,
  `reactStrictMode` and a webpack alias only).
- `forge-control/src/routes/uploads.ts` — `GET .../vnc/ticket`, registered **before** the
  `r.all("/:id/vnc/*")` catch-all, which would otherwise swallow it.
- `forge-control-web/app/desktop/chat/browser-shots.ts` — `vncProxyUrl` takes a ticket,
  emits `path=api/browser-takeover/ws/<ticket>` and `reconnect=0`.
- `forge-control-web/app/takeover/[runId]/page.tsx` — the reminder's landing page. Needed
  because `/desktop` is a single client-state route with no deep links, so a phone
  notification has nowhere else to point.
- `scripts/research-browser.mjs` — write `browser_state.json` into the run's upload dir at
  login-wall time; replace the `ssh -N -L` line with the https URL.
- `deploy/nginx/os.schreinercontentsystems.com.conf` — the location block, reviewable in
  git. Note the live file `/etc/nginx/sites-enabled/os.schreinercontentsystems.com` is a
  **real file, not a symlink** to `sites-available`. `$connection_upgrade` is already mapped
  globally in `/etc/nginx/conf.d/00-gzip-and-upgrade.conf:30`. `access_log off` on this
  location — the ticket is in the URI.
- `scripts/checks/check-browser-takeover-ticket.ts` — the gate.

## Proof the deploy task must produce

Real browser, signed in, screenshots to `/opt/ai-os/uploads/$FORGE_RUN_ID/`, each one read
back with the Read tool:

1. The takeover page connected — a live Chrome canvas, not a shell.
2. **No ticket** → socket refused.
3. **Expired ticket** → socket refused.
4. **Tampered ticket** (flipped byte in the signature) → socket refused.

A route that cannot be shown to reject is not secured. If any of these cannot be produced,
the task says so plainly rather than reporting success.
