# `scripts/perplexity.mjs`

## 1. What it is

The researcher lane's Perplexity instrument. Since **R776 it is api-first**: both `ask` and
`search` default to `POST https://api.perplexity.ai/...` and need `PERPLEXITY_API_KEY`. The
browser backend — `ask --backend browser`, which drives `perplexity.ai` inside the
authenticated Chrome profile owned by `scripts/research-browser.mjs`, waits for the answer to
finish streaming, and extracts the answer text **and its cited source URLs** — is unchanged,
fully reachable, and is now the **documented fallback**, plus the only path for logged-in work.

**Why api-first, and why this is a re-rank rather than a reversal.** R702 made the browser the
default for a reason that still holds: Konrad has no Perplexity API key and does not intend to
buy one (stated 2026-08-05 ~09:30) — Perplexity is a browser service for him. Nothing about
that judgement was wrong. What R702 did not have is the probe that R775 ran and R776 re-ran
from this host (`65.108.6.149`):

```
$ curl -s -m 12 -X POST https://api.perplexity.ai/search \
    -H 'content-type: application/json' -d '{"query":"x"}'
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.",
          "type":"invalid_api_key","code":401}}          # HTTP 401

$ curl -s -o /dev/null -w '%{http_code}' -m 12 https://www.perplexity.ai/
403                                                       # Cloudflare "Just a moment"
```

Read together those two lines rank the backends for us. **The API host answers this box — it
only wants a key. The consumer site refuses this box at the edge, upstream of anything a
browser flag can change** (§12.1). R702 therefore promoted the one path that cannot complete
from here and demoted the one that needs nothing but a key. The ranking flips; R702's reasoning
does not. What changes is that Konrad's constraint now has a **visible price**: with no key,
this tool has no working path from this host at all, and the only thing that makes the browser
lane work unattended is a different egress (proxy/VPN), not a code change.

Two backends, one output contract:

| Backend | Default for | Needs | Costs | Status |
|---|---|---|---|---|
| `api` | `ask`, `search` | `PERPLEXITY_API_KEY` (§9.1) | billed per `web_search` call (§9.3) | **recommended default** — host reachable, 401 without a key |
| `browser` | — (pass `--backend browser`) | a logged-in Perplexity session in the shared profile | nothing; a minute of wall clock | documented fallback; **the only path for logged-in work**, but 403 from this host today (§12) |

**A `--backend browser` run is meant to stop at a login wall — that is success, not failure
(§6). On this host it currently stops one step earlier**, at a Cloudflare edge block on the
VPS's IP, which is a decision for Konrad rather than a bug in the tool: **§12**.

## 2. Requirements

- Node.js **>= 22** (built-in `fetch`; this box runs v22.22.2).
- **Zero npm dependencies, still.** No `package.json` / `pnpm-lock.yaml` entry exists for this
  script or is needed. `playwright` is resolved **at runtime** from outside this repo
  (`PLAYWRIGHT_MODULE`, else `/opt/hermes-workspace/node_modules/playwright`), exactly as
  `research-browser.mjs` does it.
- The browser backend additionally needs everything `research-browser.mjs` needs: system
  Chrome, `Xvfb`, `x11vnc`, `websockify`, `/usr/share/novnc`. Missing any of them is exit `2`
  naming every path tried — see `docs/tools/research-browser.md` §2.
- **One deliberate departure from the standalone-copyable rule**
  (`docs/plan/02-architecture.md` §6.1): this script `import`s `scripts/research-browser.mjs`
  for profile paths, the screenshot convention, the login-wall evaluator, the reminder
  contract and the exit-code numbering. It is copyable *together with its harness*, which is
  the point — R702's brief requires building on R701 rather than shipping a second profile and
  takeover implementation. Everything else (the `writeFd` output helpers, key resolution, the
  `--out` pre-flight) stays duplicated per §6.1. Do not factor those out.

## 3. Usage

```
scripts/perplexity.mjs ask "<question>" [--backend browser|api] [options]
scripts/perplexity.mjs search "<query>" [options]          # API only
scripts/perplexity.mjs --help
```

### 3.1 `ask` on the browser backend (the fallback — pass `--backend browser`)

```
scripts/perplexity.mjs ask "What changed in the Perplexity Agent API in July 2026?" \
  --backend browser

scripts/perplexity.mjs ask "who won the 2026 Tour de France" --backend browser \
  --run-id f47c604a037f --label tour-answer --out /tmp/tour.json
```

| Flag | Default | Notes |
|---|---|---|
| `--backend browser\|api` | `api` | Everything below needs `--backend browser`; on `--backend api` these flags are a usage error, not a silent ignore. `search` mode refuses `browser` (usage error, not a silent downgrade). |
| `--profile <name>` | `perplexity` | The shared research profile. Must match the harness's profile grammar (`docs/tools/research-browser.md` §4). |
| `--run-id <id>` | `$FORGE_RUN_ID`, else the harness's hex sentinel | Screenshot directory under `/opt/ai-os/uploads/`. |
| `--label <text>` | `perplexity-answer` | Screenshot label, sanitised to `[a-z0-9-]`. |
| `--answer-timeout <ms>` | `120000` | Bounded `5000`–`900000`; out of range is a usage error, never a silent clamp. |
| `--allow-uncited` | off | Accept an answer with **zero** extracted sources. Off by default — see §4.1. |
| `--dump-capture <file>` | — | Also write the raw DOM capture. This is how you re-cut the parser fixture when selectors rot (§7). Pre-flighted like `--out`. |
| `--keep-open` | off | Leave the browser running after the answer (debugging). |
| `--out <file>` | — | Also write the JSON result to `<file>`. stdout is written **first** (§5.1). |

The `api`-only flags (`--model`, `--preset`, `--instructions`, `--max-steps`,
`--max-tool-calls`, `--no-force-search`) are **rejected** on the browser backend rather than
accepted and ignored — a caller who passes `--model` believes they chose a model. The reverse
holds too: browser-only flags on `--backend api` are a usage error.

### 3.2 `ask` on the API backend (the default since R776)

Unchanged from R502 except that the emitted envelope now carries `"backend": "api"`. Needs a
key (§9.1); `POST https://api.perplexity.ai/v1/agent`, default model `perplexity/sonar`, web
search forced by default.

```
scripts/perplexity.mjs ask "Summarize current LLM pricing trends" --preset medium
scripts/perplexity.mjs ask "Summarize current LLM pricing trends" --backend api --preset medium  # same thing
```

### 3.3 `search`

API only. There is no browser equivalent and inventing one would mean scraping a second
surface; `--backend browser` on `search` is a usage error explaining exactly that.

```
scripts/perplexity.mjs search "Perplexity Agent API pricing" --max-results 5
```

## 4. Output shape (the contract)

Stable, machine-readable, and the **same top-level keys on both backends** — the researcher
role consumes this, so a consumer must never have to branch on which path served it.

### 4.1 `ask --backend browser`, success

```json
{
  "backend": "browser",
  "needs_login": false,
  "question": "...",
  "answer": "the full answer text, streaming finished",
  "citations": ["https://...", "..."],
  "sources": [
    { "url": "https://...", "title": "...", "citation_index": 1, "region": "sources" }
  ],
  "search_results": [ { "url": "https://...", "title": "..." } ],
  "model": null,
  "usage": null,
  "screenshots": [
    { "label": "perplexity-answer",
      "path": "/opt/ai-os/uploads/f47c604a037f/20260805T191203Z-perplexity-answer.png",
      "url": "/api/uploads/f47c604a037f/20260805T191203Z-perplexity-answer.png",
      "url_servable": true }
  ],
  "extraction": {
    "answer_selector": "[data-testid=\"answer\"]",
    "sources_strategy": "sources-region",
    "sources_region_selector": "[data-testid=\"sources\"]",
    "submission_strategy": "url-query",
    "links_harvested": 12,
    "links_dropped": { "internal": 3, "non_http": 0, "duplicate": 1 },
    "answer_candidates_tried": [ { "selector": "...", "result": "matched (352 chars)" } ]
  },
  "bot_challenge": { "seen": true, "matched": "Just a moment", "cleared_after_ms": 6100 },
  "stream": { "samples": 5, "settled_after_ms": 7500, "final_length": 1841 },
  "page": { "url": "https://www.perplexity.ai/search?q=...", "title": "..." },
  "profile": { "name": "perplexity", "dir": "/opt/ai-os/browser-profiles/perplexity" },
  "run_id": "f47c604a037f", "run_id_source": "flag", "run_id_servable": true,
  "takeover": { "display": ":109", "novnc_port": 6919, "novnc_url": "...", "ssh_tunnel": "...",
                "bound_to": "127.0.0.1 only — never a public interface" },
  "lock_actions": [],
  "runtime": { "playwright": "...", "chrome": "/usr/bin/google-chrome-stable" }
}
```

What changed from the R502 contract, and what did not:

- **Preserved:** `answer`, `citations`, `search_results`, `model`, `usage`. A consumer written
  against the API backend keeps working.
- **Added:** `backend`, `needs_login`, `sources`, `screenshots`, `extraction`, `page`,
  `profile`, `run_id*`, `takeover`, `bot_challenge`, `stream`, `lock_actions`.
- **Different in kind, deliberately:** on the browser backend `model` and `usage` are `null` —
  the web UI discloses neither which model served the answer nor any token accounting.
  `search_results` entries carry `{url, title}` and **no `snippet`/`date`/`id`**; the web UI
  does not expose them. That is stated here rather than faked with empty strings.
- `citations` is the de-duplicated `sources[].url` list, in citation order when Perplexity
  numbered them, otherwise DOM order.

**Zero sources is an error, not a result.** The citations are the entire reason a researcher
uses this tool, so an answer with no extractable sources exits `1` with a diagnostic naming how
many links were harvested and why each was dropped. If a genuinely uncited answer is what you
want, say so with `--allow-uncited`; `extraction.sources_strategy` then reports `none`.

**`sources_strategy` — the ladder, always reported, never silent.** `sources-region` (links
inside the sources strip) → `numbered-citations` (links whose visible text is a bare `[n]`) →
`content-external-anchors` (every external anchor under `main`, in DOM order). Each rung is
strictly more permissive than the one above; which one produced your sources is in the output
because the answer's trustworthiness differs between them.

### 4.2 `ask --backend browser`, login wall

Identical shape with `needs_login: true`, `answer: null`, and empty `citations` / `sources` /
`search_results` — a consumer can read `answer` on *every* browser result and see there is
none. Plus `reason`, `reminder` (the harness's reminder record), `login` (the harness's
verdict), `takeover`, and `next_steps` — four literal lines telling Konrad what to do. Exit
code **4**. See §6.

### 4.3 `--backend api` and `search`

Unchanged from R502 apart from the added `"backend": "api"`. `ask` emits
`{ backend, question, answer, citations, search_results, model, usage }`; `search` emits
`{ backend, search_results }`. `citations` there is *derived* from the single `output[]` item of
type `search_results` — the Agent API has no top-level citations field. A `search_results` item
whose `results` is not an array is a **hard error with the body verbatim**, never `citations: []`
with exit `0` (regression-guarded, `R404-1`).

## 5. Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | API, browser or extraction error: non-2xx from the API, an Agent run that `failed`, a selector that matched nothing, a bot wall that never cleared, an answer that never stopped streaming, a DOM harvest that could not run. **No partial answer is ever emitted on this path.** |
| `2` | Missing prerequisite — no API key (`--backend api`), or no playwright / Chrome / Xvfb / noVNC (browser backend). Nothing was sent and nothing was launched. |
| `3` | Usage error, or an unusable `--out` / `--dump-capture` target (pre-flighted before any request or launch). |
| **`4`** | **NEEDS LOGIN.** A login wall. The takeover stack is up, the wall is screenshotted, a reminder is queued, the browser is left running for a one-time human login. "Needs Konrad", not "broke" — and the expected outcome of a first run. |

`4` is deliberately the **same number** `research-browser.mjs` uses for `LOGIN_REQUIRED`. The
script asserts that at import time: if the harness ever renumbers, this file throws instead of
silently reporting a wall as an API error.

A local filesystem fault is exit `3`, never `1` — a caller that retries on `1` must not re-run
(and re-pay for) work the service handled perfectly well.

### 5.1 `--out`, and why stdout goes first

A browser run costs a minute of wall clock and an API run costs money, so a local write fault
must never destroy a result that was already earned:

1. **Pre-flight.** `--out` and `--dump-capture` are checked *before* the request or the browser
   launch: an existing target must be a regular file (not a directory) and `W_OK`; otherwise
   its parent must exist, be a directory, and be `W_OK`. A bad path costs nothing (exit `3`).
2. **stdout first.** The full JSON reaches stdout *before* the file is touched.

Gate order overall: arguments → backend prerequisite (key or browser stack) → filesystem.

**Ordering holds on a pipe.** `process.stdout.write()` is asynchronous when stdout is a pipe —
which is how the researcher lane captures this script — and `process.exit()` discards whatever
has not drained, truncating at 64 KiB. Every byte of stdout and stderr therefore goes through
`fs.writeSync()` on the raw fd. Regression test: `R405-2`, which drives a >64 KiB payload
through a real `pipe(2)`.

## 6. The first run: the login wall, step by step

The browser backend needs a logged-in Perplexity session inside
`/opt/ai-os/browser-profiles/perplexity/`. As of 2026-08-05 nobody has logged in there, so
**every browser run is expected to stop at the wall.** The tool never attempts a login, never
prompts for a credential, and never types one. It surfaces the harness's handshake and exits `4`.

> **Reality check, 2026-08-05:** on this VPS the login wall is not currently reachable — a
> Cloudflare edge block on the host's IP stops runs before the page ever renders (§12). The
> procedure below is what happens the moment that is resolved; it is also exactly what R701's
> harness already does live for other services.

What happens on the wall, in order:

1. This tool screenshots what *it* saw (`perplexity-login-wall-seen`) and closes its own Chrome
   so the harness can take the profile lock back.
2. It hands the whole handshake to `research-browser.mjs open perplexity` — which owns it:
   the wall screenshot, the reminder, the noVNC stack, and **leaving the browser running** so
   there is something for a human to take over. (This tool cannot leave a browser running:
   playwright kills the context when its process exits. That is why the handshake is delegated
   rather than duplicated.)
3. It emits the needs-login JSON (§4.2) on stdout, prints the four steps below on stderr, and
   exits `4`.

### 6.1 What Konrad does, once

1. **A reminder arrives** (due ~5 minutes out) naming the profile, the service, the tunnel
   command and the noVNC URL. Reminder text is capped at 500 characters by `forge-control`;
   the harness asserts its own text fits, because an over-length reminder is rejected with a
   `400` — i.e. no notification at all.

2. **Open the tunnel from your laptop.** The `perplexity` profile lives on display `:109`, so
   its noVNC port is `6919` (the port is per-profile and is always in the run's JSON and in the
   reminder — do not memorise it):

   ```bash
   ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149
   ```

   The tunnel is **not optional**: `x11vnc` binds `-localhost` and `websockify` binds
   `127.0.0.1` explicitly, so the VNC surface is unreachable from the internet by construction.
   SSH is the access control; there is no VNC password because there is no exposed port.

3. **Open the noVNC URL in a local browser:**

   ```
   http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale
   ```

   You are looking at the real Chrome window sitting on the Perplexity login wall — with a
   window manager (`openbox`) running, so an OAuth popup can take focus and be typed into.

4. **Log into Perplexity by hand.** Password, Google SSO, 2FA, whatever it asks. Nothing about
   this is read, recorded, or transmitted by any code in this repo.

5. **Leave the window alone and close the tunnel.** The session cookie is already in the
   profile.

6. **Confirm it took, then re-run:**

   ```bash
   scripts/research-browser.mjs status perplexity --probe
   scripts/perplexity.mjs ask "who won the 2026 Tour de France"
   ```

   `login.authenticated: true` means no human is in the loop again. `null` means "no negative
   signals, no positive proof" — honest rather than reassuring.

### 6.2 A handshake already in flight is not restarted

If the harness's supervisor is holding the profile *and* its last recorded evaluation says
`needs_login`, this tool will **not** close it: Konrad may be typing into that very window.
It reports the same needs-login payload with
`reason: "a login handshake is already in flight for this profile"` and exits `4`.

Otherwise — a live supervisor with no pending wall — the tool closes it to take the Chrome
profile lock, says so on stderr, and records it in `lock_actions`. Two Chromes cannot share one
`user-data-dir`; the handover is explicit and reported, never a silent kill. `close` never
touches the profile directory, so cookies survive. See §8 for the change that would remove the
need for this dance altogether.

## 7. When the selectors rot — the recovery procedure

They **will** rot. `perplexity.ai` is a bot-defended SPA with no documented interface; nothing
in `SELECTORS` is a contract with anyone.

**Every DOM selector in this tool lives in one table**, `SELECTORS`, at the top of
`scripts/perplexity.mjs`. Nothing else in the file — and nothing in `research-browser.mjs` —
knows what Perplexity's markup looks like. Repairing rot means editing that table and nothing
else. The table is ordered most-semantic → least (`data-testid`, `aria-label`, element
semantics, then structural CSS; class-name soup last, because class names rot fastest), and
the citation harvest is **anchor-based, not layout-based**: "an external `<a>` under `main`"
outlives any wrapper `div`.

Symptoms, and which entry to edit:

| stderr says | Edit |
|---|---|
| `no answer could be extracted … None of the answerBody selectors matched` | `SELECTORS.answerBody.domCss` |
| `an answer was extracted … but ZERO sources were` | `SELECTORS.sourcesRegion.domCss`, then `SELECTORS.contentRoot.domCss` |
| `the answer never settled within … ms` | `SELECTORS.streamingIndicator.domCss` (or raise `--answer-timeout`) |
| `the DOM harvest could not run` | an unparseable entry — `domCss` lists must be **plain CSS**; playwright pseudo-classes like `:has-text()` are invalid inside `page.evaluate` and belong in `pwLocator` entries |
| `Perplexity served a bot wall … did NOT clear` | not a selector problem at all — see §7.2 |

Each of those failures is **loud**: a screenshot (path *and* `/api/uploads/...` URL), a
page-text excerpt, and the full list of candidates tried with why each missed. No answer is
emitted. A partial answer presented as a complete one is the single outcome this tool refuses.

### 7.1 Re-cutting the parser fixture

The parser is tested against a committed capture,
`forge-control/src/lib/fixtures/perplexity-answer-capture.json`. When the markup changes:

```bash
scripts/perplexity.mjs ask "who won the 2026 Tour de France" \
  --dump-capture forge-control/src/lib/fixtures/perplexity-answer-capture.json
cd forge-control && NODE_ENV=development pnpm install --prod=false && pnpm test
```

The fixture currently in the repo is **hand-authored, not a recording** — and says so in its
own `_fixture_note`, because no live answer page has ever been reached (§12). It is a *contract*
fixture: each entry exercises one parser rule. Re-cut it from a real page the moment a session
exists, delete the note, and re-run the suite. If the tests still pass, the parser survived the
real markup; if they do not, that failure is the fixture doing its job.

### 7.2 Bot wall ≠ login wall

A Cloudflare interstitial is **not** a login wall and **never queues a reminder**: logging in
cannot fix a challenge page. A managed challenge is normally transient, so one is **waited
out** — `--challenge-timeout`, default 90 s — rather than judged on sight, and whether one
appeared and how long it took to clear is reported in `bot_challenge`.

A challenge that persists past the deadline is a hard exit `1`. Before dying, the tool
**parks a browser on that page for a human**: it hands the profile back to
`research-browser.mjs open … --no-reminder`, which re-opens it headed and leaves it running, and
the error message carries the SSH tunnel command and the noVNC URL. A wall nobody can look at
is a dead end; interacting with the real page is the only thing that can clear a managed
challenge at all.

**On this box it will not clear, and the tool says so** — see §12. Diagnose it in one command:

```bash
curl -sI https://www.perplexity.ai/ | head -1     # 403 ⇒ the egress IP is edge-blocked
```

A 403 to plain `curl` means the block is on the IP, upstream of the browser entirely. No flag,
no longer `--challenge-timeout` and no human click will pass it; that run needs different
egress. This is the risk `02-architecture.md` §10 named when it rejected scraping, surfacing
exactly as predicted — loudly, with a screenshot, and never as a half-answer.

## 8. Needed changes in `research-browser.mjs` (not made here — R702 may not edit that file)

Stated plainly so the next round can act on them:

1. **The supervisor has no content action.** `handleRequest()` supports navigate-evaluate-
   screenshot only; there is no way to submit a query or read page content through it. That is
   the whole reason this tool takes the profile lock (§6.2) instead of asking the harness.
   **Fix:** add an `action: "extract"` (run a caller-supplied capture function, return its JSON)
   and an `action: "type"` request to `handleRequest()`. Then `perplexity.mjs` never launches a
   browser, the supervisor stays up across queries, and the lock dance disappears.
2. **`resolvePlaywright()` / `resolveChrome()` and the hardened launch args are
   module-private.** This tool re-implements the two resolution loops (importing only the
   candidate-path tables, so there is still exactly one place that knows *where* they live) and
   copies the four Chrome flags — including `--disable-features=CDPScreenshotNewSurface`, which
   is load-bearing on this box. **Fix:** export `resolvePlaywright`, `resolveChrome` and a
   `CHROME_LAUNCH_ARGS` constant.
3. **`SERVICES.perplexity.loggedInSelectors` includes `textarea[placeholder*="Ask" i]`**, which
   is present on the logged-out home page too. It costs nothing today (a hard URL signal
   overrides it) but it is the entry most likely to produce a false "authenticated" once a
   session exists.

4. **No egress control.** The harness always launches Chrome on the host's own IP, and
   `perplexity.ai` edge-blocks this host (§12). **Fix:** a `--proxy` flag /
   `RESEARCH_BROWSER_PROXY` env on `research-browser.mjs`, passed straight to playwright's
   `proxy` launch option, so the profile and this tool inherit one egress decision. Blocked on
   Konrad choosing an egress (§12.1) — there is no point building it against nothing.

Until (1) lands, the profile-lock handover is the documented behaviour, not a workaround to be
quietly removed.

## 9. The API backend (secondary at R702, primary again since R776)

Behaviour is unchanged from R502 — only its ranking has moved. The facts below now describe the
**default** path.

### 9.1 Key setup

Resolved in this order; **no HTTP request is attempted** unless one yields a non-empty value:

1. environment variable `PERPLEXITY_API_KEY`
2. secret-store file `/opt/ai-os/.secrets/store/perplexity-api-key` (raw key, trimmed)

Neither present ⇒ exit `2` before any network call, printing **both** locations.

R702's exit-`2` text ended with "Drop `--backend api` and this run needs no key at all". R776
removed that sentence: it pointed the caller at the path that 403s from this host, so it was
advice that could not be taken. The message now says the opposite — the browser fallback exists
and is intact, but `perplexity.ai` refuses this box, so **the key is the real unblock** (or a
different egress; §12.1).

**Konrad has no key and did not intend to buy one, and that remains his call.** The honest
statement of the trade-off is: with no key and no egress change, `scripts/perplexity.mjs` has
no working path from this host — `api` returns 401, `browser` returns 403. This doc does not
queue a reminder demanding a key; it records the cost so the decision is made with the number
in front of it.

### 9.2 Why the Agent API

Perplexity deprecated Sonar Chat Completions in July 2026 in favour of the Agent API
(`POST /v1/agent`); `POST /v1/chat/completions` returns a live **404**. Model slugs are
provider-prefixed (`perplexity/sonar`, …) and **there is no `perplexity/sonar-pro` slug**.
Presets are `fast | low | medium | high | xhigh` and currently resolve to third-party models,
a mapping the vendor itself warns is unstable — read `response.model` if it matters. Full
live-probed research: `docs/research/perplexity-api.md`.

Two behaviours that bite callers: **(a)** a failed Agent run arrives as HTTP `200` with
`response.status: "failed"`, so the tool branches on `response.status`, never on the HTTP code
alone; **(b)** the Agent API 400s on the *first* unknown field, so the request body is an
explicit whitelist, never a pass-through of user options.

### 9.3 Cost (api backend only)

- `perplexity/sonar`: **$0.25 / $2.50 per 1M tokens** (input/output).
- `web_search` tool call: **~$0.0025 per invocation** — billed per call, not per token.
- Search API: **~$5.00 per 1,000 requests**.

Tool calls dominate the bill; `--max-steps` (8) and `--max-tool-calls` (5) are the levers.
These figures replace the `sonar-pro` pricing in `02-architecture.md` §6.3.

## 10. No password is stored anywhere

**Neither this tool nor the harness reads, types, prompts for, transmits or writes a
credential.** There is no password flag, no credential file, no secret-store lookup on the
browser path (the API key is a *service* key, and it is never touched unless `--backend api`
was asked for), and no keystroke injection of a secret.

What persists is Chrome's own `user-data-dir` at `/opt/ai-os/browser-profiles/perplexity/`,
mode `0700`, owner-only: **session cookies and Chrome's profile state, nothing else.** Konrad
types his password himself, into a real Chrome window, over a loopback-only noVNC session
reachable only through an SSH tunnel he opens. Nothing in this repo could do otherwise.

The session lives exactly as long as Perplexity's cookie does. When it expires, the next run
detects the wall again and re-runs the handshake in §6 — that is the designed lifecycle, not a
regression.

## 11. What `02-architecture.md` §10 said, and why this is an amendment rather than a reversal

The architecture doc rejected "Building Perplexity browser scraping — fragile, bot-defended,
unmaintainable; documented manual fallback only." **That judgement was correct and is not
withdrawn.** Konrad's constraint (no key, ever) overruled it at R702, and §6.3 carries a dated
`AMENDED at R702` note recording exactly that.

**R776 re-ranked the backends and left both of the above standing.** The browser code is not
removed, not deprecated, and not deemed a mistake — it is demoted from default to documented
fallback, because a probe R702 never ran showed that the path it defaulted to is the one this
host cannot use (401 on the API host vs 403 on the consumer site — §1, §12.1). Note which of
the three rejected risks actually bit: not `fragile` and not `unmaintainable`, both of which
the mitigations below handled. It was **`bot-defended`**, and it bit at the network edge rather
than in the markup, where no selector table could reach it. §6.3 carries a second dated note,
`AMENDED at R776`, saying so.

The engineering response is to **mitigate, not to pretend**:

| The rejection's risk | The mitigation |
|---|---|
| fragile | every selector in ONE table, ordered semantic-first, with `--dump-capture` + a fixture suite so a repair is a five-minute edit (§7) |
| bot-defended | the challenge is waited out and *reported*, never hidden; a persistent wall is a loud exit `1`, explicitly distinguished from a login wall |
| unmaintainable | zero scraping logic outside `SELECTORS` + `CAPTURE_SOURCE`; the parser is pure and fixture-tested; rot symptoms map to a table row in §7 |
| silently wrong results | a missed selector, an unsettled stream and zero citations are all hard errors with a screenshot. **No partial answer is ever emitted.** |

## 12. Live transcript — the first real runs (2026-08-05), and the block they found

**The expected outcome of R702 was the exit-`4` login wall. The real runs never got that far:
`perplexity.ai` refuses this host outright.** That is a finding, not a tool failure — the tool
classified it correctly, refused to invent an answer, and said what it could not do.

Transcript reproduced verbatim from 2026-08-05. It is quoted as recorded and not rewritten: at
the time `ask` reached the browser with no flag. Since R776 the same run needs an explicit
`--backend browser` (§1) — everything after that first line is unchanged, because the re-rank
touched the default, not the browser code.

```
$ node scripts/perplexity.mjs ask "What is the Perplexity Agent API rate limit in 2026?" \
    --run-id 08e8d160cda1 ; echo "exit=$?"
perplexity.mjs: the harness supervisor (pid 2191716) holds profile "perplexity"; closing it to
  take the Chrome profile lock. Cookies are untouched — research-browser.mjs close never removes
  the profile directory.
perplexity.mjs: Perplexity served a Cloudflare challenge ("Just a moment"); waiting up to 90s
  for it to clear itself
perplexity.mjs: Perplexity served a bot wall, not an answer — matched "Just a moment" at
  https://www.perplexity.ai/search/new?q=What%20is%20the%20Perplexity%20Agent%20API%20rate%20limit%20in%202026%3F,
  and it did NOT clear within 90s.
  This is NOT a login wall and NO reminder was queued: logging in cannot fix a
  challenge page. 02-architecture §10 called this risk when it rejected scraping;
  see docs/tools/perplexity.md §7.2 and §12 for what is known and what to try.
  Screenshot: /opt/ai-os/uploads/08e8d160cda1/20260805T185521Z-perplexity-bot-wall.png
  A browser has been LEFT RUNNING on that page for a human takeover:
    tunnel: ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149
    open:   http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale
  ...
  Page text excerpt:
    www.perplexity.ai
    Performing security verification
    This website uses a security service to protect against malicious bots. ...
    Ray ID: a26801ca3f24542d
exit=1
```

Everything the run promised is on disk and reachable:
`/opt/ai-os/uploads/08e8d160cda1/20260805T185521Z-perplexity-bot-wall.png` (the wall this tool
saw) and `…-perplexity-bot-wall-parked.png` (the harness's shot of the browser it left running),
served at `/api/uploads/08e8d160cda1/<name>`; `research-browser.mjs status perplexity` reports
`session.live: true` on display `:109` with the takeover stack up.

### 12.1 What was measured, and what it rules out

| Probe (2026-08-05, this host) | Result |
|---|---|
| `perplexity.mjs ask …` (headed Chrome, shared profile, 45 s then 90 s budget) | challenge never cleared |
| `research-browser.mjs open perplexity` (the R701 harness, home page) | HTTP **403**, title `Just a moment...`, `login.decision: no-signal` |
| throwaway Chrome, brand-new profile, 150 s of polling | still `Just a moment...` |
| `curl -A '<real Chrome UA>' https://www.perplexity.ai/` | **403** |
| `curl https://www.google.com/` from the same host | 200 |

**Re-probed at R775 and again at R776 (2026-08-06), byte-identical both times — this is the
evidence that re-ranked the backends (§1):**

| Probe (2026-08-06, this host) | Result |
|---|---|
| `curl -X POST https://api.perplexity.ai/search -d '{"query":"x"}'` | **HTTP 401** `{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}` |
| `curl -o /dev/null -w '%{http_code}' https://www.perplexity.ai/` | **403** |

A 401 is a *reachability* result: the request crossed the network, hit Perplexity's application
layer, and was rejected on credentials. A 403 from the Cloudflare interstitial never reaches an
application at all. **The API host is fully reachable from `65.108.6.149`; only the consumer
site is challenged.** That asymmetry is why `api` is the default and `browser` is the fallback,
and it is a property of this host's egress — on a box Cloudflare scores differently, the
ranking could reasonably flip back.

The browser is not the problem, and this rules out the usual suspects: `navigator.webdriver`
is `false`, the UA is stock Chrome 148, and WebGL reports a working
`ANGLE (… SwiftShader …)` renderer — Chrome is not obviously automated and not obviously
headless. **Plain `curl` gets the same 403, so the block sits on the egress IP
(`65.108.6.149`), upstream of anything a browser flag could change.**

**What would actually unblock it — Konrad's call, not the tool's:**

1. **Different egress** for the research browser: an HTTP/SOCKS proxy or VPN on the Chrome
   launch, or running the profile on a host Cloudflare does not score as datacenter traffic.
   This is the only fix that makes the browser lane work unattended.
2. **A human pass over noVNC** on the parked browser. Cheap to try and already set up (the
   browser is running, the tunnel command is in the error), but a challenge that loops for
   150 s against a fresh profile suggests an IP verdict, not a behavioural one — do not count
   on it.
3. **Accept that Perplexity is not reachable from this VPS** and use the researcher role's other
   instruments. Nothing else in the research lane depends on this tool.
4. **Add `PERPLEXITY_API_KEY`** (§9.1). Not on the list at R702, because at R702 the browser
   path was believed to be the free way around it; the 401-vs-403 asymmetry (§12.1) shows it is
   in fact the *cheapest* unblock — no proxy, no VPN, no human at a noVNC console. This is why
   R776 made `api` the default. It costs money, which is exactly the constraint Konrad stated,
   so it stays his call and not the tool's.

A reminder carrying this decision is queued: `1fc35eb9-e49e-4899-b3c8-4676dab32dfa`, due
2026-08-06 07:00 UTC.

### 12.2 What is therefore still unproven

- **The exit-`4` login wall has never fired for Perplexity** — the bot wall stops the run one
  step earlier. The needs-login *payload and exit code* are covered by unit tests (`R702-D`),
  and the *harness* handshake it delegates to has its own live exit-4 transcript in
  `docs/tools/research-browser.md` §12. What is unproven is only the composition of the two on
  this specific site.
- **No answer has ever been extracted**, so §4.1's success shape and the selector table are
  written against the code and the contract fixture, not a real answer page. The first run that
  gets past the edge is the moment to re-cut the fixture (§7.1) and re-read §7's rot table.

## 13. Tests

`forge-control/src/lib/perplexity-cli.test.ts` — 58 cases, **no network, no browser, no X
display**, enforced structurally rather than by discipline:

- Pure logic (argv/backend parsing, the answer+citation parser, the bot-wall classifier, the
  streaming-settled rule, screenshot path/URL construction, the needs-login payload) is
  imported straight from the `.mjs`; since R702 the script runs `main()` only behind an
  `isMain()` inode check, so importing it parses no argv, resolves no key and launches nothing.
- The API backend's CLI contract is exercised by spawning the real script with a `--import`
  preload that replaces `globalThis.fetch` before the script's first line.
- The browser backend is never spawned. Its DOM harvest is represented by the committed
  capture fixture (§7.1); everything downstream of the harvest is pure.

Blocks: `R702-A` backend selection, `R702-B` argv/exit-code contract, `R702-C` fixture parsing
+ URL helpers, `R702-D` needs-login, `R702-E` screenshot paths, `R702-F` bot wall and
streaming, plus the retained `R404-*` / `R405-*` regression guards.

```bash
cd forge-control && NODE_ENV=development pnpm install --prod=false && npx tsc --noEmit && pnpm test
```

`NODE_ENV=development` and `--prod=false` are not optional in a fresh worktree: `NODE_ENV`
is inherited as `production`, a plain `pnpm install` then skips devDependencies, and you get
the Debian `/usr/bin/tsc` impostor plus `tsx: not found`
(`docs/plan/03-quality.md` lines 3–18).

## 14. Known limits

- **No successful browser answer has ever been observed**, because `perplexity.ai` edge-blocks
  this host's IP (§12) and no session exists behind it. Every claim in §4.1 about the
  success-path JSON is written against the code and the contract fixture, not a captured live
  run. The first run that gets past the edge is the confirmation step — and the moment to re-cut
  the fixture (§7.1).
- **The tool has no proxy option.** Deliberate: an egress decision belongs to the harness that
  owns the browser launch, not to a per-query wrapper. If Konrad picks option 1 in §12.1, the
  right shape is a `--proxy` / `RESEARCH_BROWSER_PROXY` on `research-browser.mjs` that both the
  harness and this tool launch with — one more entry for §8.
- **No successful API response has ever been observed either** (no key, and none is coming).
  §4.3 stands on `docs/research/perplexity-api.md`.
- **The Search API's top-level results key is unconfirmed**: the script accepts `results` or
  `search_results` and hard-errors, body verbatim, if neither is present.
- **`sources[].title` is best-effort**: the anchor's `title`, else its visible text, else its
  hostname. A bare citation number is never used as a title.
- **The typed-submission fallback is untested against the live UI.** URL submission
  (`/search?q=...`) is primary precisely because it needs no selector; the typed path exists
  for the day that scheme changes and reports itself as
  `extraction.submission_strategy: "typed"`.
- **One run, one query.** There is no follow-up/conversation support; each `ask` is a fresh
  navigation. Adding threads would mean owning more of the SPA's state than this tool wants to.
</content>
</invoke>
