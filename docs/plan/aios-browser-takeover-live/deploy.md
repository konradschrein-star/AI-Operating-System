# aios-browser-takeover-live — deploy runbook

The build phase produced code and a reviewable nginx copy. **Nothing in this
project has been installed.** This file is the ordered, copy-pasteable procedure
the deploy task follows on the live host.

Read it once end to end before running step 1. Two steps are irreversible in the
"you cannot un-ring it" sense — the pm2 restart and the nginx reload — and both
have an ordering constraint in front of them that, if skipped, takes the whole AI
OS down for a browser feature.

**The one-line summary of the ordering rule:** *secret file first, ecosystem
second, nginx third, restart last, `nginx -t` before every reload.*

---

## 0. Preconditions — check these before touching anything

```bash
# a) You are on VPS1 (65.108.6.149), the host that serves os.schreinercontentsystems.com
hostname; ip -4 addr show | grep -c '65\.108\.6\.149'

# b) The live vhost is a REAL FILE, not a symlink into sites-available.
#    (If this ever prints a symlink, the edit target below is wrong — resolve it first.)
ls -l /etc/nginx/sites-enabled/os.schreinercontentsystems.com

# c) $connection_upgrade is mapped globally. Do NOT add a second map.
grep -n 'map \$http_upgrade' /etc/nginx/conf.d/00-gzip-and-upgrade.conf

# d) The live vhost still matches the copy this project reviewed. A non-empty
#    diff means the live file drifted since 2026-08-25 and step 3 must be
#    re-derived by hand instead of pasted.
diff /etc/nginx/sites-enabled/os.schreinercontentsystems.com \
     <(grep -v '^#' /opt/forge-ai-os/deploy/nginx/os.schreinercontentsystems.com.conf | grep -v '^$')
#    (the repo copy carries explanatory comments the live file does not; compare
#     the directive lines, not the comments)

# e) The gate is green in the deployed checkout
cd /opt/forge-ai-os/forge-control-web && \
  ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
  ../scripts/checks/check-browser-takeover-ticket.ts
```

---

## 1. The signing secret — FIRST, before any restart

`TAKEOVER_TICKET_SECRET` is the only thing standing between the public internet
and a Chrome holding Konrad's logged-in Google and Perplexity sessions. It is
generated on the host and never leaves it. **No file in git contains its value,
and none ever may** — `scripts/checks/check-browser-takeover-ticket.ts` §7 scans
every tracked file, docs included, and fails on a literal assignment.

```bash
# Idempotent: only generates and appends when the name is absent.
if grep -q '^TAKEOVER_TICKET_SECRET=' /opt/ai-os/.secrets/forge-control.env; then
  echo "already present — leaving it alone (rotating it invalidates live tickets)"
else
  cp -a /opt/ai-os/.secrets/forge-control.env \
        /opt/ai-os/.secrets/forge-control.env.bak-$(date -u +%Y%m%dT%H%M%SZ)
  printf 'TAKEOVER_TICKET_SECRET=%s\n' "$(openssl rand -hex 32)" \
    >> /opt/ai-os/.secrets/forge-control.env
fi

# Mode must stay 0600. Verify the NAME landed; never echo the value.
chmod 600 /opt/ai-os/.secrets/forge-control.env
ls -l /opt/ai-os/.secrets/forge-control.env
grep -c '^TAKEOVER_TICKET_SECRET=' /opt/ai-os/.secrets/forge-control.env   # must print 1
awk -F= '/^TAKEOVER_TICKET_SECRET=/{print "length:", length($2)}' \
  /opt/ai-os/.secrets/forge-control.env                                    # must print 64
```

As of 2026-08-25 the name is already present in that file (generated during the
review of `7f34bb4`). The block above is written to be safe to run anyway.

**Why this step is first.** `forge-control` reads its environment at boot. A
restart that happens before the name exists brings the process up with the
feature dead — mint and verify both throw `TAKEOVER_TICKET_SECRET is not set` —
and you would then need a *second* restart, i.e. a second window in which live
runs are at risk. One restart, at the end, after everything is in place.

**Do not rotate an existing value as part of this deploy.** Rotation invalidates
every outstanding ticket; it is a separate, deliberate operation.

---

## 2. Pass the name through `ecosystem.config.cjs` — as a PASS-THROUGH, not `required()`

Edit `/opt/forge-ai-os/forge-control/ecosystem.config.cjs`, in the
**`forge-control` app's `env` block only** (the executor does not mint or verify
tickets and must not gain a reason to fail). Add one line beside the existing
`CLAUDE_POOL_API_KEY` pass-through, which is the precedent this copies:

```js
        // Browser takeover (aios-browser-takeover-live). PASS-THROUGH, never
        // required(): the nginx location /api/browser-takeover/ws/ bypasses
        // NextAuth and this key is the only thing authenticating that socket —
        // but required() THROWS and refuses to boot the whole control plane,
        // so a restart that landed ahead of the secrets file would take the
        // entire AI OS down for a browser feature. Absent value => the ticket
        // code throws on mint and on verify, the feature dies loudly, the OS
        // stays up. See forge-control/src/lib/takeover-ticket.ts.
        TAKEOVER_TICKET_SECRET: process.env.TAKEOVER_TICKET_SECRET || '',
```

The secrets loader at the top of that file has already copied every `KEY=value`
line of `/opt/ai-os/.secrets/forge-control.env` into `process.env` by the time
this line evaluates, so the pass-through picks it up.

Verify the edit parses before it is anywhere near a restart:

```bash
node -e "const c=require('/opt/forge-ai-os/forge-control/ecosystem.config.cjs');
  const app=c.apps.find(a=>a.name==='forge-control');
  console.log('key present:', 'TAKEOVER_TICKET_SECRET' in app.env);
  console.log('value length:', String(app.env.TAKEOVER_TICKET_SECRET).length);
  console.log('executor untouched:',
    !('TAKEOVER_TICKET_SECRET' in c.apps.find(a=>a.name==='forge-executor').env));"
```

`key present: true`, `value length: 64`, `executor untouched: true`. If length is
`0`, step 1 did not land — **stop and fix step 1 rather than restarting.**

---

## 3. Install the nginx location

The reviewed copy is `deploy/nginx/os.schreinercontentsystems.com.conf`. The live
file is edited **in place**; there is no `sites-available` twin.

```bash
cp -a /etc/nginx/sites-enabled/os.schreinercontentsystems.com \
      /root/os.schreinercontentsystems.com.bak-$(date -u +%Y%m%dT%H%M%SZ)
```

Insert this block immediately **before** the existing `location / {` line. Copy
it verbatim — it is byte-identical to the block in the reviewed repo copy:

```nginx
    location /api/browser-takeover/ws/ {
        proxy_pass http://127.0.0.1:7700;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        access_log off;
    }
```

Carry the comment block from the repo copy across with it. It is not decoration:
it tells the next person that this prefix bypasses NextAuth, that the signed
ticket is its only protection, and that nothing else may ever be mounted under
`/api/browser-takeover/`.

Three things about this block that look optional and are not:

- **`access_log off`** — the ticket is a bearer credential and it rides in the
  URI *path segment* (noVNC rebuilds its socket URL from the `path` setting
  frozen at page load and drops query parameters, so there is nowhere else to
  put it). Logging the request line writes live credentials into
  `/var/log/nginx/access.log`. forge-control logs the attempt instead — run id,
  profile, port, `jti`, outcome — and never the ticket.
- **`$connection_upgrade`, not a hardcoded `"upgrade"`** — it is already mapped
  globally at `/etc/nginx/conf.d/00-gzip-and-upgrade.conf:30`. Do not redefine
  it here; a duplicate `map` at http scope is a hard config error.
- **3600 s timeouts** — Konrad is typing a password into a real browser by hand.
  The session is idle for long stretches; the handshake is authorised once.

### `nginx -t` BEFORE any reload. Always. No exceptions.

```bash
nginx -t
```

Only if that prints `syntax is ok` **and** `test is successful`:

```bash
systemctl reload nginx        # reload, not restart — no dropped connections
```

If `nginx -t` fails: restore the backup taken above, run `nginx -t` again to
confirm you are back to a good config, and **do not reload** until it passes.
A failed `nginx -t` followed by a reload is how the whole host loses TLS.

Smoke-test the hop without a valid ticket. The expected answer is a refusal from
forge-control, which proves the request reached `:7700` instead of being swallowed
by Next's 502 upgrade bailout:

```bash
# Reached :7700 and was refused by the ticket check => 401. (A 502 with
# `x-proxy-bailout: upgrade` means the location did not take effect and the
# request still went to Next on :7701.)
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
  https://os.schreinercontentsystems.com/api/browser-takeover/ws/not-a-ticket

# And the location must NOT have widened anything: the parent prefix is still
# NextAuth-protected and must redirect to /signin, not answer.
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://os.schreinercontentsystems.com/api/browser-takeover/
```

---

## 4. Restart forge-control — LAST, and only via `safe-restart.sh`

**Never `pm2 restart forge-control`. Never `pm2 restart forge-executor`.** A pm2
restart kills every run in flight, including chats Konrad is sitting in front of
— it killed four runs on 2026-08-25 00:16, two of them his. A `PreToolUse` hook
blocks the command from inside an agent turn; this is the sanctioned path:

```bash
/opt/ai-os/scripts/safe-restart.sh forge-control 7200 45 \
  /opt/forge-ai-os/forge-control/ecosystem.config.cjs
```

The fourth argument is **required here and easy to omit**: `pm2 restart <name>
--update-env` re-reads only the *shell* environment, never
`ecosystem.config.cjs`. Without the ecosystem path the new
`TAKEOVER_TICKET_SECRET` line silently never takes effect and the feature stays
dead while every command reports success.

`safe-restart.sh` waits for the fleet to go quiet (no run heartbeat for 45 s,
two consecutive polls) and gives up after 2 h rather than restarting under a
live turn. Exit 0 = restarted; exit 2 = gave up, nothing was touched, try again
later. **Exit 2 is not a failure to work around.**

Confirm the process came back and can see the key — without printing it:

```bash
pm2 jlist | python3 -c "
import sys, json
apps = json.load(sys.stdin)
app = next(a for a in apps if a['name'] == 'forge-control')
env = app['pm2_env']
print('status:', env['status'])
print('secret present:', bool(env.get('TAKEOVER_TICKET_SECRET')))
print('secret length:', len(env.get('TAKEOVER_TICKET_SECRET', '')))"

curl -sS -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:7700/api/today
```

`status: online`, `secret present: True`, `secret length: 64`.

---

## 5. Prove it, end to end — the part this feature has historically skipped

A previous round of this project was caught reporting screenshots that did not
exist on disk. Every path claimed below must be `ls`-ed and read back with the
Read tool.

1. **Positive.** Signed in, open the chat surface, click *Take Control*, land on
   `/takeover/<runId>`, and show the noVNC canvas connected to a live Chrome —
   a real page, not a shell prompt.
2. **No ticket.** The upgrade above with `not-a-ticket` in the path: refused.
3. **Expired ticket.** Mint one, wait past its 120 s TTL, present it: refused.
4. **Tampered ticket.** Flip one byte of the signature: refused.
5. **Replay.** Present a valid ticket twice: the second is refused
   (`ticket_replayed`).

Rejections are visible in forge-control's own log, one line per attempt:

```bash
grep 'browser-takeover. upgrade' /root/.pm2/logs/forge-control-out.log | tail -20
```

Screenshots go to `/opt/ai-os/uploads/$FORGE_RUN_ID/<compact-UTC-ISO>-<label>.png`
and each one is read back with the Read tool. A path named in a document is not
evidence.

**If any of 1-5 cannot be produced, say so plainly.** A takeover route that
cannot be shown to reject is not secured, and reporting it as done is worse than
reporting it as blocked.

---

## 6. Rollback

The nginx location is the only externally-visible change, and removing it closes
the route completely. It is independent of the secret and of the pm2 env: neither
needs to be undone, and undoing them is riskier than leaving them.

```bash
# 1. Remove the location /api/browser-takeover/ws/ block from
#    /etc/nginx/sites-enabled/os.schreinercontentsystems.com
#    (or restore the backup taken in step 3):
cp -a /root/os.schreinercontentsystems.com.bak-<STAMP> \
      /etc/nginx/sites-enabled/os.schreinercontentsystems.com

# 2. ALWAYS test before reloading
nginx -t

# 3. Only on "test is successful"
systemctl reload nginx

# 4. Confirm the route is gone: NextAuth now owns the path again, so an
#    unauthenticated request is redirected to /signin instead of reaching :7700.
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://os.schreinercontentsystems.com/api/browser-takeover/ws/not-a-ticket
```

With the location gone, the socket has no route in and the takeover page falls
back to its error state — which is the intended failure mode, not a crash.

**Deliberately NOT rolled back:**

- `TAKEOVER_TICKET_SECRET` in the secrets file. It is inert without the nginx
  location, removing it would require another restart, and a future re-deploy
  wants it present.
- The `ecosystem.config.cjs` pass-through. Same reasoning: inert, and reverting
  it costs a restart window for no gain.

---

## Failure modes, and what each one actually means

| Symptom | Cause | Fix |
| --- | --- | --- |
| `502` with `x-proxy-bailout: upgrade` | The request went to Next on :7701; the nginx location is missing or misspelled | Re-check step 3, `nginx -t`, reload |
| `503 ticket_secret_unavailable` in the log | forge-control booted without the secret | Step 1 landed after the restart — redo step 4 with the ecosystem path |
| `401 ticket_expired` on every attempt | Ticket TTL is 120 s; the page sat open too long | The viewer re-mints and reloads the iframe; if it does not, that is a client bug, not a deploy one |
| `401 ticket_replayed` | The same ticket was presented twice (often noVNC auto-reconnect) | `reconnect=0` must be in the noVNC URL — check `vncProxyUrl` |
| Socket connects, canvas stays black | The takeover stack is down for that profile — nothing listening on the loopback noVNC port | `ss -ltnp | grep -E ':(69[0-5][0-9])'`; the driver's `ensureTakeover` starts it on a login wall |
| pm2 shows the app online but the feature is dead | `safe-restart.sh` was run without the ecosystem path | Re-run step 4 exactly as written |
