# P7 evidence — the browser research lane, executed

**Round:** 704 · **Phase 7** · **Date:** 2026-08-05
**Artifacts under test:** `scripts/research-browser.mjs`, `scripts/perplexity.mjs`,
`scripts/gemini-qa.mjs`, `agents/researcher.md`, `forge-control/src/routes/uploads.ts`
**Working dir for every command:** `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
**Branch:** `project/4120f785` · **node** v22.22.2 · **pnpm** 9.15.9

Every block below is command → verbatim output → verdict. Nothing is paraphrased and nothing
is reconstructed from memory.

---

## Scoreboard — read this first

| # | Smoke item | Verdict |
|---|---|---|
| 1 | Full suite green (`pnpm install` + `tsc` + `pnpm test`) | **PASS** |
| 2 | Zero new deps | **PASS** |
| 3 | gemini-qa against the LIVE pool with a real video | **FAIL — pool-side, not tool-side** |
| 3b | gemini-qa wrong-key error path | **PASS** |
| 4 | perplexity.mjs browser run reaches the login wall | **FAIL — egress-side, not tool-side** |
| 4b | The needs-login handshake itself (proved on a reachable site) | **PASS** |
| 5 | research-browser takeover up, noVNC 200, VNC loopback-only, torn down | **PASS** |
| 6 | Screenshot convention actually serves | **FAIL, then FIXED — it was crashing forge-control** |
| 7 | All three scripts' `--help` exit 0 | **PASS** |
| 8 | `agents/researcher.md` still parses (T11 + T14) | **PASS** |

**Three things the reviewer must not skim past:**

1. **Item 6 found a live-severity bug and it is now fixed.** `GET /api/uploads/:id/:name`
   handed undici a Node `Readable` cast to `ReadableStream`. When a client leaves mid-body the
   cast throws `ERR_INVALID_STATE` from a microtask — uncatchable, so the whole process dies and
   pm2 restarts forge-control. It restarted the live API during this round. Fixed with
   `Readable.toWeb()`, covered by a new regression test that fails on the old construction.
   **The running forge-control is still the pre-fix build; the deploy phase must ship this.**
2. **Items 3 and 4 are blocked on infrastructure, not on code.** The Gemini pool's Google
   session is dead (`Account status: UNAUTHENTICATED`), and perplexity.ai returns HTTP 403 to
   this host's egress IP. Both tools behaved exactly as designed against those failures. Neither
   is fixable in this worktree. Both were already known from R702; §3 and §4 add fresh proof and
   sharper diagnosis.
3. **The Perplexity smoke never reached a login wall**, so the brief's literal pass condition
   ("exits with the documented needs-login code") could not be met. Rather than paper over it,
   §4b proves the identical handshake — wall detection → screenshot → reminder → loopback
   takeover → exit 4 — against a real login wall this host *can* reach.

---

## 1. Full suite green — **PASS**

```console
$ cd forge-control && NODE_ENV=development pnpm install --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 844ms using pnpm v9.15.9
```

```console
$ npx tsc --noEmit
tsc exit=0
```

(No output. Run after every change in this round, including the §6 fix and its new test.)

```console
$ pnpm test
# tests 416
# suites 79
# pass 416
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4855.840348
```

416/416. The suite entered this round at 413; the three added tests are §6's regression cover.

---

## 2. Zero new dependencies — **PASS**

```console
$ git merge-base main HEAD
55941887e6dee4001266b7e65830b554d547ab0d

$ git diff main...HEAD -- '**/package.json' 'pnpm-lock.yaml' | wc -c
0

$ git diff --stat main...HEAD -- '**/package.json' 'pnpm-lock.yaml'
(no rows = no change)
```

Byte-empty. Everything R701–R704 shipped runs on node built-ins plus what forge-control already
had. The §6 fix uses `node:stream`; the §6 test uses `node:child_process` and `node:net`.

---

## 3. gemini-qa against the live pool — **FAIL (pool-side)**

### 3.1 The pool claimed to be healthy before the run

```console
$ curl -s http://127.0.0.1:8090/health
{"status":"ok","sessions_total":4,"sessions_ready":4,"queue_active":0,"queue_waiting":0,"uptime_s":657643,"avg_response_s":46.18,"egress":"direct (eduVPN kernel routing)"}
```

Four production sessions, none queued — so this round spent exactly **two** pool calls: one
analyse and one preflight. Nothing was retried.

### 3.2 The input — a real, finished short video

```console
$ ffprobe -v error -show_entries format=duration,size -of default=nw=1 \
    /opt/content-forge/media/tutorial/801453f3-463b-461a-983d-a11e28a9c67c/final.mp4
duration=141.348000
size=5923211

$ ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 <same file>
aac
```

141 s, 5.9 MB, with an AAC audio track — a genuine rendered output, not a synthetic fixture.

### 3.3 The run

```console
$ node scripts/gemini-qa.mjs /opt/content-forge/media/tutorial/801453f3-463b-461a-983d-a11e28a9c67c/final.mp4 \
    --out /tmp/r704-gemini-qa.json
gemini-qa.mjs: pool analyse — final.mp4 (5923211 bytes, video/mp4), timeout 900s
gemini-qa.mjs: pool analyse failed
HTTP 500 Internal Server Error
Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue.
  A 500 here is opaque by construction: the wrapper reports Google's error code and
  nothing else, and the same code covers a dead pool account, an unsupported file and
  a transient Google fault. Do NOT read it as "temporary" just because it says so.
  Check, in this order:
    1. gemini-qa.mjs --preflight ...        (or: POST http://127.0.0.1:8090/v1/chat {"prompt":"Reply with OK"})
       If text generation ALSO fails, the pool account is dead — re-auth it.
       If text succeeds and only file requests fail, the file-attachment path is
       broken for every file type; that is a pool-side problem, not a video problem.
    2. docker logs gemini-pool-api-gemini-api-1 | tail   (look for AuthError /
       "Account status: UNAUTHENTICATED")
  GET http://127.0.0.1:8090/health cannot tell you any of this — it reports sessions as ready
  without ever observing a generation outcome (docs/research/round-701-33d8cba3.md §2a).
raw body:
{"detail":"Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue."}
exit=1
```

**No QA JSON was produced, so no rubric keys can be pasted.** That is the honest state of item 3.

### 3.4 Diagnosis — the tool's own ladder, followed

Step 1 of the ladder the error message prints:

```console
$ node scripts/gemini-qa.mjs <same video> --preflight
gemini-qa.mjs: pool preflight — POST http://127.0.0.1:8090/v1/chat (this takes ~45s)
gemini-qa.mjs: pool preflight failed
HTTP 500 Internal Server Error
Failed to generate contents (stream). Unknown API error code: 1096. This might be a temporary Google service issue.
[...same diagnostic block...]
exit=1
```

Text generation fails too. Per the ladder: **the pool account is dead.** Step 2 confirms it
without ambiguity:

```console
$ docker logs --tail 40 gemini-pool-api-gemini-api-1
2026-08-05 19:14:02.400 | WARNING | gemini_webapi.client:_fetch_user_status:402 - Account status: UNAUTHENTICATED - Session is not authenticated or cookies have expired. Please check your cookies.
2026-08-05 19:14:02.945 | SUCCESS | gemini_webapi.client:init:270 - Gemini client initialized successfully.
[...the same pair repeats for every session, continuously...]
INFO:     127.0.0.1:42586 - "POST /v1/analyze HTTP/1.1" 500 Internal Server Error
INFO:     127.0.0.1:46188 - "POST /v1/chat HTTP/1.1" 500 Internal Server Error
INFO:     127.0.0.1:48840 - "GET /health HTTP/1.1" 200 OK
```

Every session logs `UNAUTHENTICATED`, then immediately logs `initialized successfully` — which
is precisely why `/health` reports `sessions_ready: 4` while every generation fails. R701 §2a
predicted this; here it is, verbatim.

**Verdict: FAIL, cause external.** `scripts/gemini-qa.mjs` did everything right — it made one
request, refused to retry, printed Google's body verbatim, exited non-zero, and named the exact
next diagnostic step. The blocker is stale Google cookies in `/opt/gemini-pool-api`, which this
worktree cannot mint. **This is not fixable by code and must not be marked green.** Reminder
`a2224386` (queued R702) already carries the repair instructions; §9 re-states it with today's
`1096`/`1100` evidence attached.

### 3.5 Wrong-key error path — **PASS**

A real request to `generativelanguage.googleapis.com`; the body is Google's.

```console
$ GEMINI_API_KEY=AIzaSyR704_deliberately_wrong_key_for_evidence \
    node scripts/gemini-qa.mjs <same video> --backend api
gemini-qa.mjs: files upload (start) failed
HTTP 400 Bad Request
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
        "metadata": {
          "service": "generativelanguage.googleapis.com"
        }
      },
      {
        "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
        "locale": "en-US",
        "message": "API key not valid. Please pass a valid API key."
      }
    ]
  }
}

exit=1
```

Exit 1, Google's body printed verbatim, no retry, no fallback to the pool backend, no partial
output. This also proves the credential separation holds: an env `GEMINI_API_KEY` reached
Google and never touched the pool's `x-api-key`.

---

## 4. perplexity.mjs browser run — **FAIL (egress-side)**

### 4.1 The wall this host actually hits

```console
$ curl -sI https://www.perplexity.ai/
HTTP/2 403
date: Wed, 05 Aug 2026 19:13:56 GMT
content-type: text/html; charset=UTF-8
content-length: 5365
accept-ch: Sec-CH-UA-Bitness, Sec-CH-UA-Arch, ...
```

Plain `curl` gets 403. Per `docs/tools/perplexity.md` §12, a 403 to plain curl means an edge
block on the egress IP, not a challenge a browser can solve.

### 4.2 The run

```console
$ node scripts/perplexity.mjs ask "What changed in the Perplexity Search API in 2026?" \
    --run-id 704b0f5e1a2c --label r704-perplexity-smoke
perplexity.mjs: the harness supervisor (pid 2220438) holds profile "perplexity"; closing it to take the Chrome profile lock. Cookies are untouched — research-browser.mjs close never removes the profile directory.
perplexity.mjs: Perplexity served a Cloudflare challenge ("Just a moment"); waiting up to 90s for it to clear itself
perplexity.mjs: Perplexity served a bot wall, not an answer — matched "Just a moment" at https://www.perplexity.ai/search/new?q=What%20changed%20in%20the%20Perplexity%20Search%20API%20in%202026%3F,
  and it did NOT clear within 90s.
  This is NOT a login wall and NO reminder was queued: logging in cannot fix a
  challenge page. 02-architecture §10 called this risk when it rejected scraping;
  see docs/tools/perplexity.md §7.2 and §12 for what is known and what to try.
  Screenshot: /opt/ai-os/uploads/704b0f5e1a2c/20260805T191601Z-perplexity-bot-wall.png
  A browser has been LEFT RUNNING on that page for a human takeover:
    tunnel: ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149
    open:   http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale
  If the challenge is an edge block on this host's egress IP (verify with
  `curl -sI https://www.perplexity.ai/` — a 403 to plain curl means it is), then no
  browser flag, longer --challenge-timeout or human click will pass it: the run needs
  a different egress IP. Harness status of the parked browser:
    {
      "url": "https://www.perplexity.ai/?__cf_chl_rt_tk=X4yk15VmGdvqr4adw5tdLoWohQRhp3yamhnDT0g5gRw-1785957363-1.0.1.1-4vn57ud9aYI1tgEyQYBJp0qrQJvNzIWMLSRfRy2F84g",
      "title": "Just a moment..."
    }
  Page text excerpt:
    www.perplexity.ai
    Performing security verification

    This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.

    Ray ID: a26820125f415288
    Performance and Security by Cloudflare
    Privacy

exit=1
```

### 4.3 The four things the brief asked to see

| Asked for | Actual | Verdict |
|---|---|---|
| reaches the login wall | reaches a **Cloudflare bot wall** first; the login page is never served | **FAIL** |
| exits with the documented needs-login code (4) | exits **1** | **FAIL as specified, CORRECT as designed** |
| a screenshot lands under `/opt/ai-os/uploads/<run_id>/` | two did | **PASS** |
| a reminder is present in `GET /api/reminders` | present, from R702 | **PASS** |

Exit 1 rather than 4 is deliberate, not a bug: `perplexity.mjs` refuses to queue a "please log
in" reminder for a wall that logging in cannot clear. Confusing a bot wall with a login wall
would send Konrad to a noVNC session to solve a challenge his IP is not allowed to solve. The
brief's pass condition assumed the run would get as far as a login prompt; the egress block
means it cannot.

Screenshots:

```console
$ ls -la /opt/ai-os/uploads/704b0f5e1a2c/
-rw-r--r-- 1 root root 42344 Aug  5 21:16 20260805T191601Z-perplexity-bot-wall.png
-rw-r--r-- 1 root root 38894 Aug  5 21:16 20260805T191604Z-perplexity-bot-wall-parked.png

$ file /opt/ai-os/uploads/704b0f5e1a2c/*.png
20260805T191601Z-perplexity-bot-wall.png:        PNG image data, 1600 x 1000, 8-bit/color RGB, non-interlaced
20260805T191604Z-perplexity-bot-wall-parked.png: PNG image data, 1600 x 1000, 8-bit/color RGB, non-interlaced
```

The standing reminder, verbatim from `GET /api/reminders` (id `1fc35eb9`, source `r702-perplexity`):

```
Perplexity browser lane (R702) is blocked BEFORE the login step: perplexity.ai returns HTTP 403
to this VPS IP 65.108.6.149 — a Cloudflare edge block, verified with plain curl AND real Chrome
(challenge never clears, 150s). No hand-login is possible until egress changes. The tool is
built + tested and needs NO API key. Decision needed: give the research browser a different
egress IP (proxy/VPN/VPS2), or drop Perplexity. Details: docs/tools/perplexity.md §12.
```

**Verdict: FAIL, cause external, and it needs a DECISION rather than a fix.** No code change in
this worktree can reach perplexity.ai from 65.108.6.149. The options are a different egress
(VPS2, proxy, VPN) or dropping Perplexity for a reachable provider. §9 re-queues the decision
with the noVNC/profile detail the brief asked for, so it is actionable the moment egress changes.

### 4b. The needs-login handshake, proved on a reachable site — **PASS**

Item 4's real intent is "does the browser lane's login handshake work end to end". Perplexity
cannot answer that question, so it was put to a site this host *can* reach that serves a genuine
login wall. `github.com/settings/profile` redirects to `github.com/login` when signed out, which
the `generic` service's `loginUrlPatterns` and the password-field probe both catch.

```console
$ node scripts/research-browser.mjs open r704-loginwall \
    --url https://github.com/settings/profile --label r704-loginwall --run-id 704b0f5e1a2c
{
  "tool": "research-browser",
  "subcommand": "open",
  "profile": "r704-loginwall",
  "profile_dir": "/opt/ai-os/browser-profiles/r704-loginwall",
  "state_dir": "/opt/ai-os/browser-profiles/.state/r704-loginwall",
  "display": ":128",
  "run_id": "704b0f5e1a2c",
  "run_id_source": "flag",
  "run_id_servable": true,
  "navigation": {
    "requested": "https://github.com/settings/profile",
    "http_status": 200
  },
  "page": {
    "url": "https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fsettings%2Fprofile",
    "title": "Sign in to GitHub · GitHub"
  },
  "service": "generic",
  "login": {
    "needs_login": true,
    "authenticated": false,
    "decision": "hard-signal",
    "reasons": [
      "final url matches login pattern /\\/login\\b/i (https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fsettings%2Fprofile)",
      "1 visible password field(s) on the page"
    ],
    "signal_errors": []
  },
  "takeover": {
    "up": true,
    "display": ":128",
    "vnc_port": 6028,
    "novnc_port": 6938,
    "novnc_url": "http://127.0.0.1:6938/vnc.html?autoconnect=1&resize=scale",
    "ssh_tunnel": "ssh -N -L 6938:127.0.0.1:6938 root@65.108.6.149",
    "bound_to": "127.0.0.1 only — never a public interface",
    "window_manager": "/usr/bin/openbox"
  },
  "reminder": {
    "queued": true,
    "reason": "no identical reminder within the dedup window",
    "id": "8f50b429-60c5-4975-85d4-7dd812fde494",
    "due_at": "2026-08-05 19:39:07.664+00",
    "when": "in 5m",
    "text_length": 383
  },
  "screenshots": [
    {
      "label": "r704-loginwall",
      "path": "/opt/ai-os/uploads/704b0f5e1a2c/20260805T193407Z-r704-loginwall.png",
      "url": "/api/uploads/704b0f5e1a2c/20260805T193407Z-r704-loginwall.png",
      "url_servable": true
    }
  ],
  "session": {
    "live": true,
    "pid": 2302167,
    "started_at": "2026-08-05T19:34:07.676Z"
  }
}
exit=4
```

```console
(stderr)
research-browser.mjs: LOGIN REQUIRED for profile "r704-loginwall" — the browser is still running.
  Open http://127.0.0.1:6938/vnc.html?autoconnect=1&resize=scale
  Tunnel first: ssh -N -L 6938:127.0.0.1:6938 root@65.108.6.149
```

Every link in the chain fired: hard-signal wall detection with two independent reasons, **exit
4**, a screenshot on the documented path with `url_servable: true`, a takeover stack bound to
loopback, a browser left running, and a reminder queued. The reminder as stored:

```console
$ curl -s http://127.0.0.1:7700/api/reminders   # filtered to this id
{
  "id": "8f50b429-60c5-4975-85d4-7dd812fde494",
  "text": "Research browser needs a ONE-TIME login: this site, profile \"r704-loginwall\". 1) tunnel: ssh -N -L 6938:127.0.0.1:6938 root@65.108.6.149 2) open http://127.0.0.1:6938/vnc.html?autoconnect=1&resize=scale 3) log in by hand in that Chrome window, then leave it. The profile keeps the cookies; nothing stores your password. [research-browser login profile=r704-loginwall service=generic]",
  "due_at": "2026-08-05 19:39:07.664+00",
  "recur": null,
  "status": "pending",
  "source": "research-browser:r704-loginwall",
  "created_at": "2026-08-05 19:34:07.664616+00",
  "delivered_at": null
}
```

That reminder is a smoke artifact — nobody needs to log a scratch profile into GitHub — so it
was dismissed rather than left to wake Konrad:

```console
$ curl -s -X POST http://127.0.0.1:7700/api/reminders/8f50b429-60c5-4975-85d4-7dd812fde494/dismiss
{"ok":true}
$ # re-fetch: gone from the pending list
```

The `r704-loginwall` profile directory is left in place (`close` never deletes profiles) and is
inert; it holds nothing but an empty Chrome profile.

**This is the strongest available evidence that the browser lane works.** The only unproven step
in the Perplexity path is the part Cloudflare will not let this host reach.

---

## 5. research-browser takeover — **PASS**

### 5.1 Bring the stack up

```console
$ node scripts/research-browser.mjs takeover perplexity
{
  "tool": "research-browser",
  "subcommand": "takeover",
  "profile": "perplexity",
  "display": ":109",
  "run_id": "deadbeefcafe",
  "run_id_source": "fallback-sentinel",
  "run_id_servable": true,
  "takeover": {
    "up": true,
    "started_now": [],
    "display": ":109",
    "vnc_port": 6009,
    "novnc_port": 6919,
    "novnc_url": "http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale",
    "ssh_tunnel": "ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149",
    "bound_to": "127.0.0.1 only — never a public interface",
    "window_manager": "/usr/bin/openbox",
    "logs": { ... }
  },
  "session": { "live": true, "pid": 2268568 },
  "note": "a browser session is live on this display"
}
exit=0
```

### 5.2 The noVNC URL answers 200 on loopback

```console
$ curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale'
200
```

### 5.3 VNC bind addresses — the security gate

```console
$ ss -lntp | grep -E ':(59[0-9][0-9]|60[0-9][0-9]|61[0-9][0-9])'
LISTEN 0 4096 127.0.0.1:5984 0.0.0.0:* users:(("docker-proxy",pid=6819,fd=8))
LISTEN 0 32   127.0.0.1:6009 0.0.0.0:* users:(("x11vnc",pid=2263549,fd=8))
LISTEN 0 1    127.0.0.1:5900 0.0.0.0:* users:(("qemu-system-x86",pid=3737,fd=33))
LISTEN 0 1    127.0.0.1:5910 0.0.0.0:* users:(("qemu-system-x86",pid=2823947,fd=32))
LISTEN 0 100    0.0.0.0:6082 0.0.0.0:* users:(("websockify",pid=2015117,fd=3))
LISTEN 0 10   127.0.0.1:60425 0.0.0.0:* users:(("chrome",pid=2201709,fd=75))
LISTEN 0 10   127.0.0.1:60381 0.0.0.0:* users:(("chrome",pid=2202201,fd=66))
LISTEN 0 32       [::1]:6009    [::]:* users:(("x11vnc",pid=2263549,fd=9))
```

**The brief's grep range stops at 6199, and this profile's noVNC port is 6919 — outside it.**
Checking only the briefed range would have silently skipped the port a human actually connects
to, so it was checked explicitly:

```console
$ ss -lntp | grep -E ':69[0-9][0-9] '
LISTEN 0 100 127.0.0.1:6919 0.0.0.0:* users:(("websockify",pid=2263550,fd=3))
```

This lane's two listeners, and their verdicts:

| Port | Process | Bind | Verdict |
|---|---|---|---|
| 6009 | `x11vnc` pid 2263549 | `127.0.0.1` + `[::1]` | loopback only — **PASS** |
| 6919 | `websockify` pid 2263550 | `127.0.0.1` | loopback only — **PASS** |

Confirmed from outside as well:

```console
$ curl -s -o /dev/null -w '%{http_code}' http://65.108.6.149:6919/vnc.html
000
(no answer — correct)
```

The §4b profile was checked the same way and is identically clean:

```console
$ ss -lntp | grep -E ':(6028|6938) '
LISTEN 0 100 127.0.0.1:6938 0.0.0.0:* users:(("websockify",pid=2302247,fd=3))
LISTEN 0 32  127.0.0.1:6028 0.0.0.0:* users:(("x11vnc",pid=2302244,fd=8))
LISTEN 0 32      [::1]:6028    [::]:* users:(("x11vnc",pid=2302244,fd=9))

$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6938/vnc.html
200
$ curl -s -o /dev/null -w '%{http_code}' http://65.108.6.149:6938/vnc.html
000
```

### 5.4 The `0.0.0.0:6082` bind — NOT this project's, but reported anyway

The grep above surfaces one public bind. It is **not** part of the research lane and predates
this project by four days, but a reviewer reading the raw grep would reasonably call it a FAIL,
so here is exactly what it is:

```console
$ ps -o pid,lstart,cmd -p 2015117
    PID                  STARTED CMD
2015117 Sat Aug  1 06:29:58 2026 /usr/bin/python3 /usr/bin/websockify --web=/usr/share/novnc/ 6082 127.0.0.1:5910

$ iptables -S INPUT | grep 6082
-A INPUT -p tcp -m tcp --dport 6082 -j ACCEPT

$ curl -s -o /dev/null -w '%{http_code}' http://65.108.6.149:6082/vnc.html
200
```

It is a noVNC console for a libvirt/qemu VM (`127.0.0.1:5910`), started 2026-08-01, bound to
`0.0.0.0` and explicitly allowed through the firewall — **reachable from the public internet
right now**. Nothing in R701–R704 created it, nothing in this worktree can close it, and closing
a firewall port is not in this task's remit. It is flagged to Konrad in §9 rather than silently
left in a grep nobody re-reads.

### 5.5 Teardown

```console
$ node scripts/research-browser.mjs close perplexity
{
  "subcommand": "close",
  "profile": "perplexity",
  "actions": [ { "what": "supervisor", "result": "stopped-gracefully", "pid": 2268568 } ],
  "note": "the profile directory /opt/ai-os/browser-profiles/perplexity is NOT touched — its cookies are the whole point of a persistent profile"
}
exit=0

$ ss -lntp | grep -E ':(59[0-9][0-9]|60[0-9][0-9]|61[0-9][0-9]|69[0-9][0-9]) '
LISTEN 0 4096 127.0.0.1:5984 0.0.0.0:* users:(("docker-proxy",pid=6819,fd=8))
LISTEN 0 1    127.0.0.1:5900 0.0.0.0:* users:(("qemu-system-x86",pid=3737,fd=33))
LISTEN 0 1    127.0.0.1:5910 0.0.0.0:* users:(("qemu-system-x86",pid=2823947,fd=32))
LISTEN 0 100    0.0.0.0:6082 0.0.0.0:* users:(("websockify",pid=2015117,fd=3))
```

`x11vnc:6009`, `websockify:6919`, Xvfb `:109` and both Chrome debug ports are gone; only the
pre-existing qemu/docker listeners remain. The `r704-loginwall` stack (6028/6938) was torn down
the same way and both ports are gone. **Nothing from this round is still listening.**

---

## 6. Screenshot convention — **FAIL, then FIXED**

This item was supposed to be one `curl`. It found a bug that restarts forge-control.

### 6.1 The failure, as it happened

```console
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' \
    http://127.0.0.1:7700/api/uploads/704b0f5e1a2c/20260805T191601Z-perplexity-bot-wall.png
200 image/png 42344

$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' \
    http://127.0.0.1:7700/api/uploads/704b0f5e1a2c/20260805T191604Z-perplexity-bot-wall-parked.png
000  0
```

The first request answered correctly. The second could not connect — **forge-control had died
between them.**

```console
$ pm2 jlist | (forge-control)
forge-control restarts= 28 uptime_start= 2026-08-05T21:18:18.382000
```

```console
$ pm2 logs forge-control --err
TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is already closed
    at ReadableByteStreamController.close (node:internal/webstreams/readablestream:1162:13)
    at node:internal/deps/undici/undici:1615:28
    at node:internal/process/task_queues:149:7
    at AsyncResource.runInAsyncScope (node:async_hooks:214:14)
    at AsyncResource.runMicrotask (node:internal/process/task_queues:146:8)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5) {
  code: 'ERR_INVALID_STATE'
}
```

The out-log puts the two events 45 ms apart, and this is the **only** occurrence of
`ERR_INVALID_STATE` in the entire error log:

```console
$ grep -n '19:1[5-9]:' /root/.pm2/logs/forge-control-out.log
17116:[2026-08-05T19:18:18.337Z] GET /api/uploads/704b0f5e1a2c/20260805T191601Z-perplexity-bot-wall.png 200 1ms
        ← process died here; pm_uptime of the new process is 19:18:18.382
17122:[2026-08-05T19:18:22.851Z] GET /api/today 200 70ms
```

### 6.2 Root cause

`src/routes/uploads.ts` built its response as:

```ts
const stream = createReadStream(abs);
return new Response(stream as unknown as ReadableStream, { ... });
```

A Node `Readable` is not a web `ReadableStream`. undici tolerates it on the happy path — a
`Readable` is async-iterable — so the cast looks harmless and the compiler was silenced. It is
not harmless: when a client leaves **mid-body**, undici's teardown calls `close()` on a
controller the Node stream has already closed and throws from a **microtask**. That is outside
every request scope, so neither Hono nor `@hono/node-server` can catch it. Uncaught exception →
process exit → pm2 restart → every open SSE stream dropped.

### 6.3 Bisection — what actually triggers it

Run on a throwaway port (7811) against four variants of the same response, never against live
forge-control:

| Client behaviour | Broken handler | Note |
|---|---|---|
| undici `fetch`, body drained | clean, 10/10 | a test written this way is GREEN on the bug |
| raw client, waits for `end`, then destroys | clean, 10/10 | |
| abort after headers, before any body byte | clean, 10/10 | |
| **abort mid-body, from another process** | **CRASHED, 3 runs of 3** | at abort 7–21 of 12–24 |
| **`curl`** (5 flag variants: default, `Connection: close`, `--http1.0`, `Accept-Encoding`, `-o file`) | **CRASHED, 5 of 5** | crashed at request 2–5 |

```console
$ # variant /a = the shipped construction; 12 mid-body aborts per run
/a run1: CRASHED (UNCAUGHT: TypeError: Invalid state: ReadableStream is already closed)
/a run2: CRASHED (UNCAUGHT: TypeError: Invalid state: ReadableStream is already closed)
/a run3: CRASHED (UNCAUGHT: TypeError: Invalid state: ReadableStream is already closed)
```

Two ingredients are both required and dropping either loses the bug: the abort must land
**inside the body**, and the client must be in a **different process**. `curl` qualifies because
its process exits the instant it is done, RSTing the socket. So does a browser navigating away
from a half-loaded `<img>` — which is exactly how the research lane's screenshots get looked at.

### 6.4 The fix

`forge-control/src/routes/uploads.ts` now hands over a real web stream:

```ts
const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
return new Response(stream, { ... });
```

Same throwaway harness, fixed variant:

```console
/c run1: survived
/c run2: survived
/c run3: survived
/c 60 aborts + 20 curl: survived   (still listening)
```

### 6.5 The regression test

`forge-control/src/lib/uploads-serving.test.ts` plus the child-process fixture
`forge-control/src/lib/fixtures/uploads-serving-server.ts`, which mounts the **real** router.
The fixture runs out-of-process because §6.3 proves an in-process test cannot reproduce the
race — the first two drafts of this test were green on the broken handler, which is why the
bisection table above exists.

Against the **fixed** handler:

```console
$ npx tsx --test src/lib/uploads-serving.test.ts
    ok 1 - 24 mid-body aborts do not kill the server process
    ok 2 - a complete GET returns the exact bytes on disk
    ok 3 - a bad run id is 400 and a missing file is 404
# tests 3
# pass 3
# fail 0
```

Against the **old** construction, restored temporarily to prove the test has teeth:

```console
    not ok 1 - 24 mid-body aborts do not kill the server process
        the server died on abort 21 of 24. Its output was:
        UNCAUGHT TypeError: Invalid state: ReadableStream is already closed
        If that says ERR_INVALID_STATE, routes/uploads.ts is handing undici a Node stream cast to ReadableStream again. It must use Readable.toWeb().
# tests 3
# pass 2
# fail 1
```

The fix was restored immediately afterwards; §1's 416/416 is the post-restore run.

### 6.6 The item-6 curl, answered with the fixed code

Live forge-control still runs the **pre-fix** build, so re-curling it would just crash it again
for no new information. Instead the fixture serves the same real directory
(`/opt/ai-os/uploads`) out of this worktree — read-only, no live service involved:

```console
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' \
    http://127.0.0.1:<port>/api/uploads/704b0f5e1a2c/<name>
20260805T191601Z-perplexity-bot-wall.png         200 image/png 42344
20260805T191604Z-perplexity-bot-wall-parked.png  200 image/png 38894
20260805T193407Z-r704-loginwall.png              200 image/png 30478

$ # then 12 further curls of the first file — the exact shape that killed live forge-control
200 200 200 200 200 200 200 200 200 200 200 200
(server STILL UP)
```

All three screenshots produced in this round serve at 200 with the right MIME and byte count.

**DEPLOY OBLIGATION: the running forge-control is the pre-fix build and every `<img>` pointed at
`/api/uploads/...` can still restart it. This fix must ship.** `pm2 restart forge-control` is
permitted by the brief's deploy section; the executor is untouched by this change.

---

## 7. `--help` on all three scripts — **PASS**

```console
$ node scripts/gemini-qa.mjs --help        → exit=0, 111 lines
$ node scripts/perplexity.mjs --help       → exit=0,  81 lines
$ node scripts/research-browser.mjs --help → exit=0,  68 lines
```

Each prints full usage — subcommands, every flag, credential resolution order and the exit-code
table — and exits 0. Full texts are reproduced in `docs/tools/gemini-qa.md`,
`docs/tools/perplexity.md` and `docs/tools/research-browser.md`.

---

## 8. `agents/researcher.md` parses with the engine's own parser — **PASS**

Two suites cover it, and both pass against the edited file in this worktree:

```console
$ pnpm test | grep -E 'T11|T14'
# Subtest: T11 researcher frontmatter parse
ok 70 - T11 researcher frontmatter parse
# Subtest: T14 parseRoleFile robustness — BOM, CRLF, malformed header
ok 72 - T14 parseRoleFile robustness — BOM, CRLF, malformed header
```

- **T11** runs the real `parseRoleFile` over the real `agents/researcher.md` and asserts the
  tool allowlist parses to the exact expected list in order, that `model` survives
  `sanitizeModel`, that `effort` survives `sanitizeEffort`, that the mission is non-empty with
  frontmatter stripped, and that it still mentions `docs/research` and a citation obligation.
- **T14** is the security suite. It mutates the real role-file bytes (BOM, CRLF, BOM+CRLF,
  unclosed frontmatter) and proves none of them can collapse `tools` to `null` — a null there
  fails open to `CC_ALLOWED_TOOLS`, which includes `Write`, `Edit`, `MultiEdit`, `Task` and
  `Skill`.

R703 edited `agents/researcher.md` to wire in the browser lane; both suites still pass, so the
edit introduced neither a parse regression nor a privilege-escalation path.

---

## 9. What Konrad owes the system

`GET /api/reminders` was read first (80 pending) so R702's entries were not duplicated. Standing
and still correct — **not re-queued**:

| id | Subject |
|---|---|
| `a2224386` | Gemini Pool is blocked; re-auth `cdp-9400` cookies in `/opt/gemini-pool-api` |
| `1fc35eb9` | Perplexity edge-blocks 65.108.6.149; egress decision needed |
| `4c4532af` | `PERPLEXITY_API_KEY` still absent |
| `c88f6e19` | Gemini API key still absent |
| `016e3833` | Deploy must refresh `/root/.claude/agents/researcher.md` |

Queued by this round, all confirmed `{"ok":true}`:

| id | Due | Subject |
|---|---|---|
| `1d73fbde` | tomorrow 09:00 | Perplexity one-time login, part 1/2 — profile name, what `open perplexity` does, gated on egress changing |
| `b84ce65d` | tomorrow 09:00 | Perplexity one-time login, part 2/2 — the exact tunnel command, the exact noVNC URL, and how to verify afterwards |
| `f50d042d` | in 2h | **Deploy the `/api/uploads` fix** (§6) — the live API can still be restarted by any client that abandons a screenshot download |
| `5ffa4edb` | tomorrow 09:00 | The public noVNC on port 6082 (§5.4) — pre-existing, not this project's, reachable from the internet |

The login instructions are split across two reminders because the API caps text at 500 chars
and rejects longer bodies with a 400 rather than truncating (the R605 fix). The single message
came to 578.

---

## What is NOT proven here, and why

- **A real Gemini QA rubric.** The pool's Google session is dead (§3.4). The rubric shape,
  key-completeness and extraction logic are covered by `src/lib/gemini-qa-cli.test.ts`; what is
  unproven is one successful end-to-end analyse. It cannot be proven until the cookies are
  refreshed.
- **A Perplexity ANSWER.** Explicitly out of scope for this phase, and unreachable anyway (§4.1).
- **A Perplexity LOGIN WALL.** Cloudflare blocks the host before the login page is served. §4b
  proves the identical handshake on a reachable wall.
- **The fix running in production.** §6.6 proves it in the worktree. Deploying it is the deploy
  phase's job; this was a build phase and `/opt/forge-ai-os` was not touched.

---

## 10. Commands run against live services

For the reviewer checking the worktree-only rule. `/opt/forge-ai-os` was **never** read from,
written to, or restarted. `pm2 restart forge-executor` was never run.

| Target | Calls | Nature |
|---|---|---|
| Gemini Pool `127.0.0.1:8090` | 1 analyse, 1 preflight, a few `/health` | read-only; 2 of 4 shared sessions used once each |
| `generativelanguage.googleapis.com` | 1 | wrong-key error path, rejected at the door |
| `perplexity.ai` | 1 curl HEAD, 1 browser run | blocked at the edge |
| `github.com/login` | 1 browser run | unauthenticated page load |
| forge-control `127.0.0.1:7700` | 3 GET `/api/uploads`, 2 GET `/api/reminders`, 1 POST dismiss, 3 POST reminders | the first uploads GET crashed it (§6.1); that is the finding, not a side quest |
| `docker logs`, `ss`, `iptables -S`, `pm2 list/jlist/logs` | read-only | diagnosis |

The throwaway repro server (port 7811) and the test fixture (ephemeral ports) both ran from this
worktree and were killed; the temporary repro file was deleted and is not committed.
