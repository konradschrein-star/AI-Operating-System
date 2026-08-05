# `research-browser` — persistent browser profiles, noVNC takeover, one-time login

Transcribed from `scripts/research-browser.mjs --help` and the shipped script (R701). Evidence
for every claim below: the live transcripts in §9 (real commands run in this worktree,
node v22.22.2, Chrome 148.0.7778.178, 2026-08-05) and
`forge-control/src/lib/research-browser-cli.test.ts` (the pure decision logic, no browser).

## 1. What it is / when to use it

`scripts/research-browser.mjs` is the browser harness the research lane runs on. A **named
profile** is a persistent Chrome `user-data-dir`: log into a service by hand ONCE, and every
later run of that profile is already authenticated. When a run does hit a login wall, the tool
brings up a **noVNC takeover** session, screenshots the wall, and queues a reminder telling
Konrad the exact URL to open — then exits with a distinct code so the caller knows the
difference between "needs a human" and "broke".

Use it for any research surface that requires being logged in. Perplexity is the first entry in
the `SERVICES` table (§6); Google Search Console, a paid analytics dashboard or anything else is
a new object in that table, not new code.

**No passwords are stored anywhere. See §8 — that section is the point of this tool, not a
footnote.**

## 2. Requirements

- Node.js >= 22 (this box runs v22.22.2).
- **Zero npm dependencies in this repo.** `docs/plan/03-quality.md` gates on
  `git diff main...HEAD -- '**/package.json' 'pnpm-lock.yaml'` being empty, so playwright is
  *not* a dependency of `forge-control`. It is resolved at runtime via `createRequire`, in this
  order, and a failure to resolve is exit 2 naming every path tried:
  1. `$PLAYWRIGHT_MODULE`
  2. `/opt/hermes-workspace/node_modules/playwright` (verified present, v1.60.0)
- System binaries, all verified present on this box: `/usr/bin/Xvfb`, `/usr/bin/x11vnc`,
  `/usr/bin/websockify`, `/usr/share/novnc/vnc.html`, and a browser (§2.1). `/usr/bin/openbox`
  is used if present and is optional (§7.1).
- The file is a standalone, executable, copy-anywhere script (`chmod +x`, shebang
  `#!/usr/bin/env node`). The `writeFd`/`writeSync` stdout helpers are intentionally duplicated
  from `scripts/gemini-qa.mjs` rather than shared, per `docs/plan/02-architecture.md` §6.1's
  standalone-copyable requirement — do not "fix" that.

### 2.1 Why this exists instead of the `auto-browser` skill

The `auto-browser` SKILL.md describes a controller on `http://127.0.0.1:8000` with noVNC on
`:6081`. **Neither is installed on this host.** Verified 2026-08-05: both ports return
connect-failure (`http_code 000`), there is no `/opt/auto-browser`, no container matches
browser/vnc/chrome, and `mcpServers` in `/root/.claude.json` is an empty list. That SKILL.md
lives inside a Hermes docker volume
(`/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills/browser/auto-browser/`)
and documents a *different machine*. This tool reimplements its **semantics** — named profile,
save/reuse, takeover URL — on what is actually here, and this repo owns it.

Confirm the premise yourself in one line before trusting any of the above:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/docs   # 000 = not there
```

### 2.2 Browser choice

Resolution order, first match wins: `$RESEARCH_BROWSER_CHROME`, `/usr/bin/google-chrome-stable`,
`/usr/bin/google-chrome`, then playwright's bundled chromium
(`/root/.cache/ms-playwright/chromium-1234/...`) as a last resort.

**System Google Chrome is preferred deliberately.** Real Chrome trips fewer bot defenses than
playwright's bundled chromium, and it decouples this tool from playwright's browser-revision
pin — the bundled path contains a revision number and breaks on a playwright upgrade.

## 3. Usage

```
research-browser.mjs <open|status|takeover|close> <profile> [flags]
research-browser.mjs --help
```

| Subcommand | What it does |
|---|---|
| `open <profile>` | Launch or attach a Chrome `persistentContext` on the profile, navigate, evaluate the login signals, screenshot, print JSON status. Exit 4 on a login wall, with the browser **left running**. |
| `status <profile>` | Is a session live, is the profile authenticated, what is the takeover URL. Cheap by default; `--probe` re-navigates for an authoritative answer. |
| `takeover <profile>` | Ensure Xvfb + x11vnc + websockify (+ a WM) are up for this profile's display; print the noVNC URL and the SSH tunnel command. Needs no browser. |
| `close <profile>` | Tear down the browser and the entire takeover stack. Never touches the profile's cookies. |

**Flags**

| Flag | Default | Meaning |
|---|---|---|
| `--url URL` | the resolved service's `home` | Page to open. Required when the resolved service is `generic` (it has no home). |
| `--label L` | `<service>-open`, or `<service>-login-wall` on a wall | Screenshot label, sanitised to `[a-z0-9-]` |
| `--run-id ID` | `$FORGE_RUN_ID`, else `deadbeefcafe` | Screenshot directory under `/opt/ai-os/uploads/` (§5) |
| `--service S` | inferred from `--url`'s host, then the profile name | Force a `SERVICES` entry: `perplexity`, `generic` |
| `--probe` | — | `status` only: re-navigate and re-evaluate instead of reading cached state |
| `--no-reminder` | — | `open` only: detect the wall and exit 4, but queue no reminder |
| `--help`, `-h` | — | Print usage and exit 0 |

Flags accept `--url X` or `--url=X`. Unknown flags, a missing or empty flag value, a bad
profile name, an extra positional argument, and `--probe` on the wrong subcommand are all usage
errors (exit 3) that cost nothing — they happen before playwright, Chrome or the network is
touched.

**Examples**

```bash
# Perplexity, resolved from the profile name; goes to the service home
scripts/research-browser.mjs open perplexity

# Any page, explicit run id so the screenshot URL is servable
scripts/research-browser.mjs open scratch --url https://example.com --label smoke --run-id 148ae1fd8f65

# Authoritative auth check (re-navigates; never queues a reminder)
scripts/research-browser.mjs status perplexity --probe

# Just the takeover stack, no browser
scripts/research-browser.mjs takeover perplexity

# Full teardown; cookies survive
scripts/research-browser.mjs close scratch
```

## 4. Profiles — and what is in them

```
/opt/ai-os/browser-profiles/<profile>/          Chrome user-data-dir, mode 0700
/opt/ai-os/browser-profiles/.state/<profile>/   this tool's runtime bookkeeping, mode 0700
/opt/ai-os/browser-profiles/.state/displays/<n> display registry: which profile owns :<n>
```

**The profile directory holds session cookies and Chrome's own profile state, and nothing
else.** No credential of any kind is written there or anywhere else (§8). Runtime bookkeeping
deliberately lives *outside* the profile directory, in `.state/<profile>/`, so that sentence
stays literally true:

| File | Contents |
|---|---|
| `session.json` | supervisor pid, display, ports, deadlines — its liveness proof |
| `takeover.json` | pids of Xvfb / WM / x11vnc / websockify |
| `auth.json` | the last login evaluation, for a cheap `status` |
| `display` | this profile's pinned display number |
| `req/`, `res/` | the request/response queue the CLI uses to talk to the supervisor |
| `stop` | touch file asking the supervisor to shut down |
| `*.log` | one log per managed process, plus `supervisor.log` |

Profile names must match `/^[a-z0-9][a-z0-9-]{0,38}$/` — lowercase alphanumerics and dashes,
starting alphanumeric. The dot is excluded so a profile can never collide with `.state`, and
path traversal (`../escape`) is rejected as a usage error.

## 5. Screenshot convention (a contract)

```
/opt/ai-os/uploads/<run_id>/<compact-ISO8601>-<label>.png
e.g. /opt/ai-os/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png
```

`forge-control` serves these at `/api/uploads/<run_id>/<name>`
(`forge-control/src/routes/uploads.ts`). **The operator-visibility project is building its
renderer against this exact shape**, so it is a contract, not an implementation detail. This
tool builds no UI of its own.

Every screenshot appears in the JSON with **both** its absolute path and its URL:

```json
{
  "label": "smoke-r701",
  "path": "/opt/ai-os/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png",
  "url": "/api/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png",
  "url_servable": true
}
```

- **Timestamp**: compact ISO 8601, second resolution, UTC (`20260805T165301Z`).
- **Label**: sanitised to `[a-z0-9-]`, so the URL is always valid. Runs of anything else
  collapse to one dash, leading/trailing dashes are dropped, and the result is capped at 64
  characters (never leaving a trailing dash). An empty result becomes `screenshot`.
- **`run_id`**: `--run-id`, else `$FORGE_RUN_ID`, else the sentinel `deadbeefcafe`. The JSON
  reports which source was used in `run_id_source`.

### 5.1 `url_servable`, and why the ad-hoc sentinel is hex

The uploads route gates the id on `/^[a-f0-9]{12}$/` and **400s anything else** — every one of
the existing upload directories is exactly 12 hex characters, written by
`crypto.randomBytes(6).toString("hex")`.

Two consequences, both deliberate:

1. **The ad-hoc fallback is `deadbeefcafe`, not `adhoc`.** A mnemonic literal would be rejected
   by the route, making every ad-hoc screenshot unviewable in the Console. The sentinel is 12
   hex characters so its URL actually works, and is obviously a sentinel.
2. **A differently shaped run id still gets the documented path.** The convention is never
   mangled to force servability — guessing would produce a URL pointing at a file that is not
   there. Instead `url_servable` is `false` and a note goes to stderr naming both the URL that
   will 400 and the file that does exist. A UUID-shaped run id is the realistic case.

## 6. Login-wall detection — the `SERVICES` table

Detection is **data-driven**. A service is an object; Perplexity is the first entry, not a
hardcoded guess:

| Field | Meaning |
|---|---|
| `hosts` | which service a `--url` belongs to (matched against the hostname) |
| `home` | where `open <profile>` goes with no `--url` |
| `loginUrlPatterns` | a **final** URL matching one of these is a login wall (hard signal) |
| `loggedOutSelectors` | visible ⇒ logged out (soft signal) |
| `loggedInSelectors` | visible ⇒ logged in (positive signal) |

`generic` is the fallback for any host with no entry. It carries only the two signals true of
essentially every login page (`/sign-in`, `/login`, `accounts.google.com`, plus a visible
password field) and **claims nothing about being logged in** — an empty `loggedInSelectors` is
the only honest default.

**Service resolution precedence:** explicit `--service` → the `--url`'s hostname → a profile
name that happens to be a service key → `generic`. An explicit `--url` outranks the profile
name on purpose: a profile called `perplexity` pointed at `example.com` is evaluated with
`generic` signals, because applying Perplexity's logged-in selectors to another site could
report a session as authenticated on evidence from a page it never visited.

### 6.1 Verdict precedence

The evaluator is a pure function of collected signals (`evaluateLoginWall`), which is why the
test suite drives it against synthetic inputs with no browser:

1. **Hard signals win outright** — a final URL on a login path, or a visible password field. A
   page asking for a password is a login wall whatever else it renders. If a logged-in selector
   *also* matched, the decision is reported as `hard-signal-overrides-logged-in` rather than
   silently resolved.
2. **A logged-in selector beats the soft logged-out selectors** — sites routinely leave a dead
   "Sign in" node in the DOM after auth, and a visible account control is the stronger claim.
3. **A logged-out selector alone is a wall** (`logged-out-selector`).
4. **Silence proves nothing** — no signals at all gives `needs_login: false` and
   `authenticated: null`. Reporting `null` instead of `true` is the whole point: this tool never
   guesses that a session is good.

Every non-trivial decision carries a `reasons` array naming the signal that produced it, and a
selector that cannot be evaluated is reported in `signal_errors` rather than swallowed.

## 7. The takeover stack and its security

For a profile's pinned display `:N`:

| Process | Bind | Purpose |
|---|---|---|
| `Xvfb :N -screen 0 1600x1000x24 -extension GLX -nolisten tcp` | no TCP | the virtual display |
| `openbox` (optional, §7.1) | — | window focus management for the human |
| `x11vnc -display :N -rfbport <5900+N> -localhost -nopw` | **127.0.0.1 only** | VNC server |
| `websockify --web /usr/share/novnc 127.0.0.1:<6900+N-90> 127.0.0.1:<5900+N>` | **127.0.0.1 only** | noVNC |

Displays are `:90`–`:149`, allocated **deterministically per profile**: a hash picks the
preferred slot, and the assignment is recorded in `.state/displays/<n>` and pinned in
`.state/<profile>/display`. Because a hash alone can collide, the registry is authoritative —
on collision the allocator probes forward and persists the result, and a profile keeps its
display forever after. Ports are derived from the display, so two profiles can never share one.

> **`-extension GLX` is not decoration.** Measured on this box 2026-08-05: Xvfb **segfaults**
> (signal 11) during startup with GLX enabled, at any resolution. The same command with GLX
> disabled starts fine. A headless X server has no use for GLX anyway.

**NEVER EXPOSE VNC ON A PUBLIC INTERFACE.** Both `x11vnc` and `websockify` bind loopback only,
verified with `ss -ltn` in §9. `-nopw` (no VNC password) is safe *only because of that* — the
access control is the loopback bind plus SSH, not a VNC password. Do not add `-listen` or a
`0.0.0.0` bind to make it "easier to reach"; use the tunnel:

```bash
ssh -N -L 6937:127.0.0.1:6937 root@65.108.6.149     # port varies per profile
```

Override the SSH target with `$RESEARCH_BROWSER_SSH_TARGET`. The exact tunnel command for a
given profile is printed by `status` and `takeover` as `ssh_tunnel`, and is included in the
login reminder.

### 7.1 The window manager is optional, never silently absent

A WM is unnecessary for automation and close to essential for a human takeover: without one, X
windows get no focus management, so a login popup (Google OAuth opens one) can be impossible to
type into over VNC. `/usr/bin/openbox`, `/usr/bin/fluxbox` and `/usr/bin/i3` are tried in that
order; `openbox` is installed here.

Its absence never fails a run, and is never invisible either: `takeover.window_manager` in the
JSON is the binary in use or `null`, and a `null` prints a stderr line saying exactly what it
costs and how to install one. The WM is deliberately excluded from `takeover.up`, so a box
without one still reports a working stack.

### 7.2 Spawning is not starting

Each managed process is waited for until it is genuinely ready — the X socket exists, the VNC
port accepts a connection, the noVNC port accepts a connection — and the wait fails the instant
the process dies, printing that process's own log tail. Without this, a downstream failure
reports as "the supervisor did not come up within 90s" and the real cause (the Xvfb segfault
above) is visible only to someone who thinks to read three log files.

## 8. No passwords are stored anywhere

**This tool never reads, types, prompts for, transmits or writes a credential.** There is no
code path in `scripts/research-browser.mjs` that could: it has no password flag, no credential
file, no secret-store lookup, and no keystroke injection.

What persists is Chrome's own `user-data-dir` under `/opt/ai-os/browser-profiles/<profile>/`
(mode 0700, owner-only): **session cookies and Chrome's profile state, nothing else.** Konrad
types his password himself, into a real Chrome window, over a loopback-only noVNC session that
is reachable only through an SSH tunnel. The reminder the tool queues says so too, so the
promise is visible at the moment it matters.

`close` never touches the profile directory — its cookies are the entire point of a persistent
profile.

## 9. The one-time login procedure

Steps Konrad can follow verbatim. The trigger is a run that exits **4**.

1. **A reminder arrives** (due 5 minutes out) naming the noVNC URL, the profile, and the service
   to log into. It also carries the tunnel command. Reminder text is capped at 500 characters by
   `forge-control` and this tool asserts its own text fits, because an over-length reminder is
   rejected with a 400 — i.e. no notification at all.

2. **Open the tunnel from your laptop.** The port is in the reminder:

   ```bash
   ssh -N -L 6937:127.0.0.1:6937 root@65.108.6.149
   ```

3. **Open the noVNC URL in a local browser:**

   ```
   http://127.0.0.1:6937/vnc.html?autoconnect=1&resize=scale
   ```

   You are now looking at the real Chrome window sitting on the login wall. The wall was also
   screenshotted; its `/api/uploads/...` URL is in the run's JSON.

4. **Log in by hand.** Type the password, complete 2FA, dismiss whatever the service asks.
   Nothing about this is recorded by the tool.

5. **Leave the window alone and close the tunnel.** The cookies are already in the profile.

6. **Confirm it took:**

   ```bash
   scripts/research-browser.mjs status perplexity --probe
   ```

   `login.authenticated: true` means the next `open` needs no human. If the service defines no
   logged-in selector, expect `null` — "no negative signals, no positive proof" — which is
   honest rather than reassuring.

The browser is deliberately **left running** on exit 4 so there is something to take over. The
supervisor shuts itself down after 4 hours idle following a wall (1 hour otherwise, 8 hours
absolute), and `close <profile>` ends it immediately.

### 9.1 Reminder de-duplication

Before queueing, the tool `GET`s `/api/reminders` and looks for a reminder carrying the marker
`[research-browser login profile=<p> service=<s>]` created within the **last hour**. A match
suppresses the new reminder and reports `{"queued": false, "reason": "deduplicated"}` with the
existing id and its age.

An **unreadable `created_at` counts as not-a-duplicate**, on purpose. The failure modes are not
symmetric: a duplicate reminder is noise on a phone, while a suppressed one means Konrad is
never told and the research lane is stuck forever. Noise is the cheaper mistake. The skipped
reminder is named on stderr, so it is never invisible.

## 10. Exit codes

| Code | Meaning |
|---|---|
| 0 | Success — JSON status on stdout |
| 1 | Runtime error: browser launch, X/VNC startup, screenshot failure, supervisor IPC timeout, reminder POST failure. The offending process's log tail is printed. |
| 2 | Missing prerequisite: the playwright module, a Chrome binary, or the Xvfb/x11vnc/websockify/noVNC stack. Every path tried is named. |
| 3 | Usage error: bad subcommand, bad profile name, unknown flag, empty flag value, bad `--url`, extra positional argument, or `--url` missing for `generic`. Costs nothing — nothing is launched. |
| **4** | **LOGIN REQUIRED** — a login wall was detected. The takeover stack is up, the wall is screenshotted, a reminder is queued, and the browser is **left running**. Distinct on purpose: a caller can tell "needs Konrad" from "broke". Not an error. |

Large payloads are safe on a pipe: `process.stdout.write()` is asynchronous when stdout is a
pipe and `process.exit()` drops whatever has not drained — a silent cut at 64 KiB. All output
goes through `fs.writeSync()` on the raw fd, exactly as in `scripts/gemini-qa.mjs`
(`docs/tools/gemini-qa.md` §5.1).

## 11. Architecture: why there is a supervisor

playwright closes the browser when the process that launched it exits. A CLI that launched
Chrome and returned could therefore never leave anything on screen for a human to take over —
and `close` would have nothing to close.

So `open` never drives the browser itself. It starts (or reuses) a **detached supervisor** that
owns the persistent context for its whole life, and talks to it through a request/response
directory pair under `.state/<profile>/`. Consequences worth knowing:

- **`open` on a live session attaches** — same supervisor, same browser, one more navigation and
  screenshot. Verified in §12: identical supervisor pid across two `open` calls.
- Two concurrent `open`s cannot launch two browsers on one `user-data-dir`: the starter holds an
  atomic `mkdir` lock (`start.lock/`), and the loser waits for the winner's session file.
- A stale `session.json` (dead pid) is detected by checking the pid *and* that its cmdline still
  looks like a supervisor, so pid reuse cannot make the tool talk to an unrelated process. The
  same guard protects every `SIGTERM` in `close`, which reports `skipped-pid-reuse` rather than
  signalling a process it merely remembers.

## 12. Live transcripts

All commands below were run in this worktree on 2026-08-05, node v22.22.2,
Chrome 148.0.7778.178.

**Successful open, end to end** (Xvfb → Chrome → navigate → screenshot):

```
$ scripts/research-browser.mjs open smoke-r701 --url https://example.com --label "Smoke R701" --run-id 148ae1fd8f65
{
  "tool": "research-browser",
  "subcommand": "open",
  "profile": "smoke-r701",
  "display": ":127",
  "run_id": "148ae1fd8f65",
  "run_id_source": "flag",
  "run_id_servable": true,
  "navigation": { "requested": "https://example.com", "http_status": 200 },
  "page": { "url": "https://example.com/", "title": "Example Domain" },
  "service": "generic",
  "login": { "needs_login": false, "authenticated": null, "decision": "no-signal", "reasons": [], "signal_errors": [] },
  "takeover": {
    "up": true, "display": ":127", "vnc_port": 6027, "novnc_port": 6937,
    "novnc_url": "http://127.0.0.1:6937/vnc.html?autoconnect=1&resize=scale",
    "ssh_tunnel": "ssh -N -L 6937:127.0.0.1:6937 root@65.108.6.149",
    "bound_to": "127.0.0.1 only — never a public interface",
    "window_manager": "/usr/bin/openbox"
  },
  "reminder": null,
  "screenshots": [ { "label": "smoke-r701",
    "path": "/opt/ai-os/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png",
    "url": "/api/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png",
    "url_servable": true } ],
  "session": { "live": true, "pid": 1842926, "started_at": "2026-08-05T16:53:01.975Z" }
}
exit=0
```

The screenshot is a real 1600x1000 PNG of the rendered page, and `forge-control` serves it
byte-identically at the advertised URL:

```
$ file /opt/ai-os/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png
PNG image data, 1600 x 1000, 8-bit/color RGB, non-interlaced
$ curl -s -o /tmp/served.png -w 'http=%{http_code} bytes=%{size_download} type=%{content_type}\n' \
    http://127.0.0.1:7700/api/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png
http=200 bytes=20709 type=image/png
$ cmp /opt/ai-os/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png /tmp/served.png && echo identical
identical
```

**Attach, not relaunch** — a second `open` reuses the live supervisor:

```
supervisor pid before: 1842926
$ scripts/research-browser.mjs open smoke-r701 --url https://example.com/ --label attach-check --run-id 148ae1fd8f65
pid: 1842926
title: Example Domain
shot: /opt/ai-os/uploads/148ae1fd8f65/20260805T165341Z-attach-check.png
```

**Loopback only** — nothing is on a public interface:

```
$ ss -ltn | grep -E '6937|6027'
LISTEN 0 100  127.0.0.1:6937  0.0.0.0:*  users:(("websockify",pid=1842943,fd=3))
LISTEN 0 32   127.0.0.1:6027  0.0.0.0:*  users:(("x11vnc",pid=1842942,fd=8))
LISTEN 0 32       [::1]:6027     [::]:*  users:(("x11vnc",pid=1842942,fd=9))
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6937/vnc.html
200
```

**Login wall → exit 4 + reminder** (a `/login` path is a hard signal for `generic`; this is a
synthetic wall — no Perplexity login was attempted, round 702 owns that):

```
$ scripts/research-browser.mjs open smoke-r701 --url https://example.com/login --run-id 148ae1fd8f65
exit=4
login: { "needs_login": true, "authenticated": false, "decision": "hard-signal",
         "reasons": ["final url matches login pattern /\\/login\\b/i (https://example.com/login)"] }
reminder: { "queued": true, "reason": "no identical reminder within the dedup window",
            "id": "a720488c-4831-4d6d-a946-4bfb4778ea08",
            "due_at": "2026-08-05 16:58:52.126+00", "when": "in 5m", "text_length": 375 }
shot: /opt/ai-os/uploads/148ae1fd8f65/20260805T165352Z-generic-login-wall.png

--- stderr ---
research-browser.mjs: LOGIN REQUIRED for profile "smoke-r701" — the browser is still running.
  Open http://127.0.0.1:6937/vnc.html?autoconnect=1&resize=scale
  Tunnel first: ssh -N -L 6937:127.0.0.1:6937 root@65.108.6.149
```

Note the label: nobody passed one, and the screenshot named itself `generic-login-wall`.

The reminder as actually stored — 375 characters, intact, not truncated:

```
Research browser needs a ONE-TIME login: this site, profile "smoke-r701". 1) tunnel: ssh -N -L
6937:127.0.0.1:6937 root@65.108.6.149 2) open http://127.0.0.1:6937/vnc.html?autoconnect=1&resize=scale
3) log in by hand in that Chrome window, then leave it. The profile keeps the cookies; nothing
stores your password. [research-browser login profile=smoke-r701 service=generic]
```

**De-duplication** — an identical second run queues nothing (reminder count went 66 → 67 across
both runs, i.e. exactly one):

```
$ scripts/research-browser.mjs open smoke-r701 --url https://example.com/login --run-id 148ae1fd8f65
exit=4
reminder: { "queued": false, "reason": "deduplicated",
            "existing_id": "a720488c-4831-4d6d-a946-4bfb4778ea08",
            "age_s": 9, "window_s": 3600 }
```

That test reminder was dismissed afterwards (it would otherwise have paged Konrad about a
throwaway profile), returning the count to 66.

**Clean teardown:**

```
$ scripts/research-browser.mjs close smoke-r701
actions: [ { "what": "supervisor", "result": "stopped-gracefully", "pid": 1842926 } ]
# afterwards: no Chrome for that profile, no Xvfb :127, ports 6027/6937 free
```

## 13. Tests

`forge-control/src/lib/research-browser-cli.test.ts`, run by `pnpm test` (`node:test` via
`tsx`). **A real browser is never a precondition**, and neither is an X display, a VNC stack or
the forge-control API — enforced structurally, not by discipline:

- The pure logic is imported straight from the `.mjs`, which only runs `main()` behind an
  `isMain()` inode check. Covered: argv parsing and the usage-error contract, profile path
  construction, label sanitisation (including the 64-char cut never leaving a trailing dash),
  screenshot path/URL construction, run-id resolution and `url_servable` (asserted against a
  local copy of the uploads route's own regex), display and port allocation, service resolution
  precedence, the login-wall evaluator against synthetic signals, reminder text length against
  the real 500-char limit, Postgres timestamp parsing, and the dedup window including its
  boundary, dismissed reminders, clock skew and unreadable timestamps.
- The CLI contract (`--help`, every exit-3 path) is exercised by spawning the real script with
  both `PLAYWRIGHT_MODULE` and `RESEARCH_BROWSER_CHROME` pointed at nonexistent paths — so the
  tests prove a usage error never reaches a browser.

## 14. Known limits

- **No Perplexity login has been performed.** Round 702 owns that. The wall handshake in §12 was
  proven against a synthetic `/login` URL, which exercises the same hard-signal path, the same
  reminder POST and the same dedup logic — but Perplexity's own `loggedInSelectors` are
  unverified against the live site and may need adjusting when someone actually logs in.
- **`status` without `--probe` is cached**, reporting the last recorded evaluation and its
  timestamp. `--probe` is the authoritative answer and costs a navigation.
- **Screenshot capture requires `--disable-features=CDPScreenshotNewSurface`** on this box.
  playwright passes `--enable-features=CDPScreenshotNewSurface`, and on that path every
  `Page.captureScreenshot` for a headed browser on Xvfb fails with "Unable to capture
  screenshot" (reproduced with and without a window manager). `--disable-gpu` and
  `--use-angle=swiftshader` also fix it; the feature flag was chosen because it changes nothing
  about rendering, whereas `--disable-gpu` is visible to WebGL fingerprinting and this tool
  exists to survive bot defenses. If a future Chrome drops the feature name, the flag becomes a
  no-op and screenshots fail loudly (exit 1), never silently.
- **A `SERVICES` entry is a guess until a real login proves it.** Selectors rot. When one does,
  the symptom is a wrong `authenticated` value, which is why `reasons` always names the signal
  that decided.
