# aios-takeover-usable — plan (round 0)

Project `51ddfb27-1dfc-487a-bd3a-e650c963292a`, branch `project/51ddfb27` off `main`
(`c708f24`). Manager chat: run `2ef126b7-d6d9-4a55-a8e7-d9acf0508645`.

**Goal.** Make the live noVNC takeover usable from Konrad's phone: (1) a text
input that reaches the VM without any clipboard permission, (2) one durable
browser profile instead of a new throwaway per run, (3) a session that lives
until it is ended — by him, by the agent, or by a visible clock — and never
dies silently.

## 0. What was verified before designing (measured 2026-08-26 00:50–01:10Z)

| Claim in the brief | Verdict | Evidence |
|---|---|---|
| Paste button calls `navigator.clipboard.readText()` and cannot work off-Chromium | **Confirmed** | `TakeoverClient.tsx:115-135`; fallback textarea only appears after the failure and is 10px type, `rows={2}` |
| Persistence is plumbed; runs invent profile names | **Confirmed, with a correction** | `research-browser.mjs:1750` `launchPersistentContext(profileDir(profile))`; `<profile>` is a REQUIRED positional with no default (`parseArgs`, l.2123–2131); agents are told `open scratch --url …` by `forge-control/src/lib/project-tick.ts:754`. **Correction:** every profile's `Default/Login Data` has **0 rows**; cookies are tiny (os-ui 17 rows: github/google; perplexity 4; r3-takeover 5; r5proof 5; r704-loginwall 7; r705-review 3; scratch 0; smoke-r701 0). Nothing valuable is trapped in the throwaways. Still: do NOT delete them without Konrad's word. |
| `DEFAULT_TICKET_TTL_MS = 120_000` killed the session | **Refuted as the killer** | Ticket is verified ONCE at connect (`browser-takeover.ts:805`), the pipe has no timer, nginx `proxy_read_timeout 3600s`. A hand-rolled RFB client (WS→RFB 3.8→None→ServerInit, then silence) **survived 240 s idle on both hops** — direct `:7700` and via `https://os.…` with ALPN `http/1.1`. |
| — what actually happened tonight | **Measured** | `.state/os-ui/websockify.log`: six connects to `os-ui` 23:58:48→00:10:47 CEST at 46–270 s gaps, from **Windows Edge** (nginx UA), no forge-control restart in that window. The socket died client-side and Konrad re-minted by hand each time. For run `2ce31fa484df` (in-chat viewer) forge-control logged `ticket_replayed` and `ticket_expired`: the viewer's iframe remounts with the SAME URL, so the 120 s TTL bites the **re**-connect, never the connection. Separately proven: a forge-control restart resets every open takeover socket (connect 00:46:46Z → pm2 restart 00:47:06Z → websockify `Connection reset by peer`); the counter says 114 restarts. |
| `check-browser-takeover-ticket.ts` is wired into gates-808 | **Confirmed** | `scripts/checks/gates-808.sh:321` |
| `check-takeover-clipboard-e2e.ts` exists | Exists, **wired into nothing** | 929 lines, referenced only by the previous PLAN.md |

Memory note written: `takeover-socket-death-forensics` (where the timestamps are, probe recipe).

## 1. Recommendation

**Client-side text path over the socket that is already authenticated; one durable
profile chosen by name; session lifetime owned by the supervisor that already owns
the stack, with forge-control reporting socket facts to it through a file it already
polls. No new unauthenticated route. No TTL change. No VM, no anti-detect tool.**

### 1.1 Text into the VM (top ask)

- New always-visible panel `forge-control-web/app/takeover/[runId]/TextToVM.tsx`,
  rendered by `TakeoverClient.tsx` under the canvas (never behind a menu). Textarea
  `rows=3`, 16px type (iOS does not zoom a 16px field), `autoCapitalize/autoCorrect/
  spellCheck` off, buttons ≥44px tall. A "Hide / Show input" toggle is itself a big
  button. Phone-first: at `max-width: 640px` the panel is a bottom sheet of fixed
  height and the iframe takes the rest.
- Two send mechanisms, a segmented switch, **default = Type keys**:
  - **Type keys** — synthesise RFB `KeyEvent`s into the focused VM field via
    `UI.rfb.sendKey(keysym, code, down)` (noVNC 1.3.0, `core/rfb.js:408`).
  - **Set VM clipboard** — `UI.rfb.clipboardPasteFrom(text)` (`rfb.js:443`), the
    path the existing buttons already drive through `#noVNC_clipboard_text`.
  The page cannot see which VM element is focused (VM focus lives in X11), so the
  default is the mechanism that works on login forms; the other is one tap away.
- **Reaching `UI.rfb`:** `app/ui.js` is an ES module (`export default UI`, no
  `window.UI`). Same-origin iframe ⇒ inject `<script type="module">import UI from
  './app/ui.js'; window.__forgeNoVNC = UI;</script>` into the iframe document; the
  module map is per realm, so this returns the SAME instance vnc.html loaded. R1
  proves this before B1 builds on it. Connection state is DOM-observable regardless:
  `documentElement.classList` carries `noVNC_connecting|connected|disconnecting|
  reconnecting` (`ui.js:388-414`) — a MutationObserver on it is the reconnect trigger.
- **Key synthesis rules** (`vm-keys.ts`, pure, unit-tested):
  `\r\n`→one `XK_Return 0xff0d`; `\n`→Return; `\t`→`XK_Tab 0xff09`; U+0020–U+00FF →
  keysym = codepoint (Latin-1 is 1:1, covers ä ö ü ß); other BMP → noVNC's
  `keysymdef.lookup` table or `0x01000000|cp` (€ is U+20AC → table hit `0x20ac`);
  astral (emoji) → iterate by code point, `0x01000000|cp`. x11vnc `-add_keysyms`
  (default on in 0.9.16) maps keysyms absent from the Xvfb US keymap onto spare
  keycodes on the fly, and `-modtweak` supplies Shift for uppercase/`@`. A short
  inter-key delay (start at 8 ms, R1 measures) lets the remap settle. The component
  states in a comment exactly which strings the E2E typed and read back.
- **Never logged, by construction and by gate:** the text goes browser → WS → x11vnc
  as RFB frames; forge-control pipes bytes it never parses; nginx has `access_log
  off` on that location. Components contain no `console.*`; B5's check greps for it
  and asserts a typed sentinel never appears in any harness process's stdout/stderr.

### 1.2 One durable profile

- `scripts/research-browser.mjs`: `<profile>` becomes OPTIONAL for every subcommand;
  default `konrad-main` (`RESEARCH_BROWSER_DEFAULT_PROFILE` overrides). A profile
  name that does not yet exist on disk, is not the default and is not a `SERVICES`
  key (`perplexity`) is refused with exit 2 **unless `--throwaway` is given**; then a
  `.throwaway` marker is written and `status` reports it. Existing directories open
  as before (nothing Konrad has is cut off). Pure `resolveProfileChoice()` in the
  script, tested from `forge-control/src/lib/research-browser-cli.test.ts`.
- Prompt corpus and docs say the same thing (`project-tick.ts:754` `open scratch` →
  `open` (default) / `open <name> --throwaway`; `docs/tools/research-browser.md` §3/§4).
- **Migration is Konrad's choice**, asked in the manager chat with a control block;
  default if unanswered: **C** (fresh `konrad-main`, log in once; nothing renamed,
  nothing deleted). A: make `os-ui` the default name (richest, 17 cookies, live
  session on `:126` right now). B: `close os-ui`, then `mv` profile + `.state` dir to
  `konrad-main`. Deleting the six throwaways is a separate, explicit request.
- Known cost, stated: one durable profile = one Chrome = one supervisor, so agent
  browser work serialises through its file queue (already the design). Parallel
  isolated research keeps `--throwaway`.

### 1.3 Session lifetime, Done, agent shutdown, clocks

Ticket TTL stays 120 s — it is a connect window for a bearer token in a URL path.

- **Facts owner — forge-control** (`browser-takeover.ts`): on accepted upgrade
  increment a per-profile live-socket count; on either side closing, decrement and
  log `upgrade closed run= profile= jti= seconds= by=client|upstream` (jti only,
  never bytes). Persist `.state/<profile>/takeover-activity.json`
  `{connected, connects, first_connect_at, last_connect_at, last_disconnect_at,
  written_at}` atomically (read-modify-write so `first_connect_at` survives a
  forge-control restart). A write failure → 503 + error log, never a silent session
  without a clock.
- **Lifetime owner — the supervisor** (`research-browser.mjs supervise()`), which
  already polls every `POLL_MS` and already owns `shutdown()`. Each tick it reads
  the activity file and applies `computeTakeoverDeadlines()` (pure, unit-tested):
  - **Idle rule:** a connected viewer is never idle. After the last socket closes,
    `TAKEOVER_IDLE_GRACE_MS` (default 30 min) before idle shutdown — stepping away
    for a coffee does not kill it; the first idle tick does nothing but arm the
    grace. Existing `IDLE_TIMEOUT_MS`/`LOGIN_IDLE_TIMEOUT_MS` keep governing the
    agent-only case.
  - **Safety cap:** `TAKEOVER_MAX_SESSION_MS` (default 2 h, env-configurable) from
    `first_connect_at` → `shutdown('takeover cap 2h')`. The 8 h `HARD_MAX_SESSION_MS`
    stays as the outer bound.
  - `session.json` gains `takeover_deadline`, `connected`, `takeover_started_at`;
    every shutdown writes `.state/<profile>/last-shutdown.json` `{reason, at}` so a
    page that polls after the fact can say WHY.
- **Ending the session — three signals, one code path** (`research-browser.mjs
  close <profile>`: stop file → supervisor `shutdown()` → `teardownTakeover()`
  kills websockify, x11vnc, autocutsel×2, WM, Xvfb; Chrome dies with its display;
  the profile dir is untouched):
  1. **Done button** → `POST /api/proxy/uploads/<runId>/takeover/end` (NextAuth
     behind `/api/proxy`) → forge-control spawns `close <profile>` (30 s timeout,
     returns its JSON; failure → 502 with stderr tail). Two-tap confirm on the page.
  2. **Agent** — when it judges the work complete it runs `close <profile>`; a
     `status --probe` that comes back `authenticated: true` after a login wall is the
     cue. That is THE signal; there is no implicit one.
  3. **Clocks** — cap or idle grace, above.
- **Visible clock — the page:** `GET /api/proxy/uploads/<runId>/takeover/session`
  polled every 15 s; header shows `connected · ends in 1:52:10`, warn colour under
  10 min, and after the end `Session ended: <reason>`. If forge-control predates the
  endpoint (404) the page says so in words — never a blank.
- **Reconnect:** on `noVNC_disconnected` the page re-mints at once, then 2/5/10/10 s,
  five attempts, status `reconnecting 2/5 · dropped after 118 s`; stops with Retry
  after that, and never auto-reconnects when the session endpoint says ended. The
  same hook fixes the in-chat viewer's stale-ticket remount.

### 1.4 API contract (so lanes build in parallel)

```
GET  /api/uploads/:id/takeover/session            (also /browser/:profile/takeover/session)
 200 { profile, stack_up, supervisor_live, connected_sockets, connects,
       takeover_started_at, last_disconnect_at, idle_deadline, takeover_deadline,
       hard_deadline, remaining_ms, now, ended: null | { reason, at } }
 404 { error } when the run has no profile
POST /api/uploads/:id/takeover/end                (also /browser/:profile/takeover/end)
 200 { ended: true, profile, actions: [...] }      502 { error, stderr_tail } on failure
```
Both live in `forge-control/src/routes/uploads.ts`, reached through `/api/proxy`.
**Nothing new under `/api/browser-takeover/`** (`check-browser-takeover-ticket.ts` §6.1).

## 2. What owns state · what dispatches · what fails how · how Konrad sees it

- **State:** socket facts → forge-control (memory + `takeover-activity.json`);
  deadlines and shutdown → supervisor (`session.json`, `last-shutdown.json`); profile
  choice → the CLI at call time; text → the browser tab only, never persisted.
- **Dispatch:** user taps; supervisor tick; forge-control upgrade listener; `close`.
- **Failure:** every branch renders its reason on the page; forge-control 503s rather
  than proxying without a record; the supervisor logs each shutdown reason; a
  missing endpoint is named, not hidden.
- **Visibility:** the header clock, the reconnect counter, the end reason, and the
  closed-socket log line in forge-control with seconds and side.

## 3. Rejected alternatives (one line each)

- Raise ticket TTL to 2 h — hands out a 2 h bearer credential that sits in URLs.
- nginx `auth_request` + `proxy_pass` straight to websockify (survives forge-control
  restarts) — right idea, a deploy-only change with a dynamic-port variable; follow-up.
- Server-side `xdotool type` endpoint — routes passwords through forge-control HTTP.
- `#noVNC_keyboardinput` + `input` event — cannot send Return/Tab.
- Fix the clipboard button — cannot work on iOS/Firefox by construction.
- Real VM / Dolphin Anty / Multilogin — see §5; wrong problem.
- Auto-merge workstreams — silent clobbering.

## 4. Task graph (ids are what the API returned; rounds are computed)

```
R1  researcher  junior   main     []            keysym/module-trick measurement → docs/plan/aios-takeover-usable/research-keysym.md
B2  builder     junior   control  []            forge-control socket facts + session/end routes + tests
B3  builder     junior   browser  []            research-browser.mjs default profile, --throwaway, takeover clocks + tests
B4  builder     junior   main     []            docs + prompt corpus (research-browser.md, project-tick.ts(.test.ts)), answer doc
B1  builder     standard ui       [R1]          TextToVM + vm-keys + reconnect + clock + Done, both surfaces
I3  builder     junior   main     [B3]          integrate browser → main (stop on conflict)
I2  builder     junior   main     [B2]          integrate control → main
I1  builder     junior   main     [B1]          integrate ui → main
B5  builder     junior   main     [I1,I2,I3]    check-takeover-text-input-e2e.ts + wire gates-808 + prove-it-bites RED
REV reviewer    standard main     [all above]   the join: check the stated claims
DEP builder     junior   main     [REV]         deploy forge-control-web only; verify live; reminder for forge-control safe-restart
```

## 5. Answer to Konrad — VM / Dolphin Anty / Multilogin

Short version: **a stable profile name is the whole fix, and it costs nothing.**

Persistence already works. `research-browser.mjs` launches real Chrome with
`launchPersistentContext` on `/opt/ai-os/browser-profiles/<name>`; cookies survive
across runs. What breaks it is that every run picks a new `<name>` — the argument is
mandatory and has no default, and the prompt corpus literally says `open scratch`.
Eight directories exist; six are round-scoped throwaways. Their contents, measured
tonight: zero saved logins anywhere (`Login Data` is empty in all eight) and a handful
of cookies (`os-ui` 17, the rest 0–7). Nothing valuable is lost, and nothing there
needs rescuing by a heavier tool.

Dolphin Anty and Multilogin are **anti-detect** browsers: they spoof canvas, WebGL,
fonts, timezone and TLS fingerprints so a site cannot tell your ten accounts share a
machine. That solves *fingerprint evasion*, a different problem from *persistence*.
A "real VM" is persistence with a hypervisor tax — and the Xvfb + persistent-profile
stack IS a persistent desktop already. The one place your vault records a genuine
fingerprint block is `90_AI_OS/Self-Mint Veo - Technical Learnings.md`: Google's
`PUBLIC_ERROR_UNUSUAL_ACTIVITY` on raw/nodriver minting — and the fix recorded there
was "use a genuine headful browser", which is exactly what this stack runs. No
`auth.json` or supervisor log on disk shows a captcha, a challenge or a block.

Recommend an anti-detect tool only when a named site blocks *this* Chrome with
*this* profile, with the block on screen. Today there is no such site. Your own
2026-08-16 daily note already names the "Dolphin-Anty, residential-proxy digital
employee" as the abstraction rung above the 90-second manual act; the stable name
is the rung below it.
