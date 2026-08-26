# R1 — Reaching `UI.rfb` from the parent frame and typing non-ASCII over RFB keysyms

Project `aios-takeover-usable`, round 0, task R1. Measured 2026-08-26 01:20–01:40 UTC
(03:20–03:40 CEST) on VPS1 against a real Chrome on Xvfb raised by
`scripts/research-browser.mjs` (profile `r1-keysym`, display `:97`, x11vnc `:5997`,
websockify/noVNC `:6907`). Every number below comes from a command run this session;
the harness scripts are quoted in §6 so the run can be repeated.

**Verdict in one line:** the module trick returns the live `UI` object from a parent
frame; `UI.rfb.sendKey(keysym, null)` types ASCII, Latin-1, €, and emoji byte-exact
into a Chrome textarea on Xvfb **with 0 ms inter-key delay**, 5/5 for both test strings
and 3/3 for a 3000-character burst. The one real hazard is not keysyms — it is **where
the VM's keyboard focus is** (§3.1).

---

## 1. Module trick — does `import UI from './app/ui.js'` return the live instance?

Source facts (read this run):

- `/usr/share/novnc` is Debian `novnc 1:1.3.0-2` (`dpkg -l novnc`).
- `app/ui.js:1027` — `UI.rfb = new RFB(document.getElementById('noVNC_container'), url, …)`;
  `ui.js:1085-1086` `connectFinished` sets `UI.connected = true`; `ui.js:1102-1111`
  `disconnectFinished` sets `UI.connected = false; UI.rfb = undefined;`.
- `app/ui.js:388-414` `updateVisualState(state)` first REMOVES all four of
  `noVNC_connecting|connected|disconnecting|reconnecting` from `documentElement`, then
  adds one for `connecting|connected|disconnecting|reconnecting`. **There is no
  `noVNC_disconnected` class** — `grep -n noVNC_disconnected app/ui.js app/styles/base.css`
  returns nothing. The `'disconnected'` case adds nothing.
- `core/rfb.js:408-431` `sendKey(keysym, code, down)`: returns silently unless
  `_rfbConnectionState === 'connected'` and not `_viewOnly`; with `code` null/undefined
  `XtScancode[code]` is undefined, so it takes the plain `RFB.messages.keyEvent` branch
  regardless of QEMU extended-key support (x11vnc reports `_qemuExtKeyEventSupported=false`
  anyway, measured below).
- `core/input/keysymdef.js:672-690` `lookup(u)`: U+0020–U+00FF → `u`; else table; else
  `0x01000000 | u`. Table has `0x20ac: 0x20ac // XK_EuroSign` (line 482).

### 1.1 Direct page (Playwright page IS `vnc.html`)

Command: `node measure.mjs` part 1a (§6.2). Page loaded
`http://127.0.0.1:6907/vnc.html?autoconnect=1&path=websockify`, waited for
`documentElement.classList.contains('noVNC_connected')` (736–861 ms after `goto`), then
appended `<script type="module">import UI from './app/ui.js'; window.__forgeNoVNC = UI;
window.__forgeNoVNCReady = true;</script>` to `document.head`.

Result (`PART1A`, second run):

```
{"connectMs":736,"hasRfb":true,"rfbCtor":"RFB","rfbState":"connected","connected":true,
 "sameInstanceOnReimport":true,"windowUI":"undefined","classes":"noVNC_connected",
 "qemuExtKey":false,"viewOnly":false}
```

- `sameInstanceOnReimport`: a second `await import('http://127.0.0.1:6907/app/ui.js')`
  from `page.evaluate` returned `=== window.__forgeNoVNC` — the module map is per realm,
  one instance.
- `windowUI: "undefined"` confirms vnc.html never publishes `window.UI`; the trick is
  required.
- Screenshot: `/api/uploads/d5521c3f37a3/20260826T013158Z-r1-part1a-direct-vnc-connected.png`.

### 1.2 Parent frame → same-origin iframe (B1's actual shape)

The parent was a routed page `http://127.0.0.1:6907/__r1-parent.html` (Playwright
`ctx.route` → `fulfill`, so same origin as noVNC) holding
`<iframe id="f" src="/vnc.html?autoconnect=1&path=websockify">`. From the PARENT:

```js
const d = f.contentDocument; const s = d.createElement('script'); s.type = 'module';
s.textContent = "import UI from './app/ui.js'; import keysyms from './core/input/keysymdef.js';"
  + " window.__forgeNoVNC = UI; window.__forgeKeysyms = keysyms; window.__forgeNoVNCReady = true;";
d.head.appendChild(s);
```

Result (`PART1B`):

```
{"hasRfb":true,"rfbCtor":"RFB","rfbState":"connected","connected":true,
 "parentWindowUI":"undefined","iframeClasses":"noVNC_connected",
 "keysymLookupEuro":"20ac","keysymLookupSmiley":"101f642"}
```

- The relative specifier `./app/ui.js` resolved against the IFRAME document's URL
  (`/vnc.html`), so it hit `/app/ui.js` — the same module vnc.html loaded. The globals
  landed on the iframe's `window` (`parentWindowUI` stays undefined) — read them as
  `f.contentWindow.__forgeNoVNC`.
- `keysymdef.js` imported the same way gives `lookup(0x20ac) = 0x20ac` and
  `lookup(0x1f642) = 0x0101f642`.
- **Verdict: module trick works from the parent frame.** B1 needs no fork of noVNC and
  no `window.UI` patch.

### 1.3 Class changes and the MutationObserver when the WS is killed

Observer installed BY THE PARENT on `f.contentDocument.documentElement` with
`{attributes:true, attributeFilter:['class'], attributeOldValue:true}`; then the TCP
connection to websockify was destroyed from outside the browser with
`ss -K -tn state established '( dport = :6907 )'` (kernel has
`CONFIG_INET_DIAG_DESTROY=y`; `ss` iproute2-6.1.0). Result (`KILL`, second run):

```
classLog: [{dtMs:27, cls:"", old:"noVNC_connected"}, {dtMs:27, cls:"", old:"noVNC_connected"},
           {dtMs:27, cls:"", old:""}, {dtMs:27, cls:"", old:""}]
connectedAfter:false  rfbAfter:"undefined"  classesAfter:""  status:"Disconnected"
reconnectSetting:false  disconnectEvent:{clean:true, dtMs:27}
```

- The observer fires **27 ms** after the kill, four records (the four `classList.remove`
  calls in `updateVisualState`). The signal B1 must watch is **removal of
  `noVNC_connected`** (`old` contains it, `cls` does not) — NOT the appearance of a
  `noVNC_disconnected` class, which never exists. PLAN.md §1.1/§1.3 say "on
  `noVNC_disconnected`"; read that as "on `noVNC_connected` leaving the class list".
- `UI.rfb` becomes `undefined` on disconnect and is a NEW object on every connect
  (`ui.js:1027`). B1 must re-read `__forgeNoVNC.rfb` at send time, never cache it.
- A kernel-level socket destroy surfaced as `disconnect` with `clean: true` and the
  benign "Disconnected" status (not "Something went wrong"). The first run's kill
  produced the identical shape. So "clean" does not mean "user asked for it"; do not
  gate reconnect on `!clean`.
- noVNC's own `reconnect` setting is `false` (URL param `reconnect=1`, delay
  `reconnect_delay`, default 5000 ms, `ui.js:1120-1125`) — it would reconnect to the
  SAME URL, i.e. the same ticket, which is exactly the `ticket_replayed` failure from
  the brief. B1's reconnect must re-mint and rewrite the iframe `src`.
- Screenshot after the kill: `/api/uploads/d5521c3f37a3/20260826T013451Z-r1-kill-ws-observer.png`
  (noVNC back on its Connect panel).

---

## 2. Keysyms — round trips through x11vnc into Chrome on Xvfb

### 2.1 Rig

- `research-browser.mjs open r1-keysym --url file:///tmp/r1-keysym.sBQQ/echo.html --service
  generic --no-reminder` → exit 0, `takeover.novnc_port: 6907`, `vnc_port: 5997`, display
  `:97` (§4.1 explains why not the hashed `:99`). `.state/r1-keysym/takeover.json` carried
  the same ports. Screenshot by the tool:
  `/api/uploads/d5521c3f37a3/20260826T012359Z-r1-keysym-echo-page.png`.
- `echo.html`: `<textarea id=t autofocus>` whose `input` handler does
  `fetch('http://127.0.0.1:47311/echo',{method:'POST',body:t.value})` — a text/plain POST
  from a `file://` origin, CORS-simple, no preflight; verified by the echo server
  receiving every keystroke (`count` equals the string length in every passing trial).
- `echo-server.mjs` (14 lines, node `http`): stores the last body; `GET /last` →
  `{last,count}`; `POST /reset`.
- Driver: headless Playwright 1.60.0 (`/opt/hermes-workspace/node_modules/playwright`)
  with `executablePath: /usr/bin/google-chrome-stable` (Chrome 148.0.7778.178) — the
  bundled `chromium_headless_shell-1223` the module wants is not installed (only
  `-1234` is), so the default `chromium.launch()` throws "Executable doesn't exist".
- Per trial: `Ctrl+A` (`0xffe3` down, `0x61`, up) + `BackSpace 0xff08` to clear, 250 ms,
  `POST /reset`, then `for each keysym: sendKey(k,null,true); sendKey(k,null,false);
  await delay` — then poll `/last` until `count` is stable for 700 ms. Pass = `last ===
  string` (JS string equality, i.e. code-unit exact; the echo body is UTF-8).
- keysym rule used: `\n → 0xff0d`, `\t → 0xff09`, else `keysymdef.lookup(codePoint)`
  (iterating the string by code point, so astral chars are one keysym each).

x11vnc 0.9.16 (`x11vnc -version`: `lastmod: 2019-01-05`) is spawned by
`research-browser.mjs:1137-1148` with `-display :N -rfbport P -localhost -nopw -forever
-shared -noxdamage -quiet` — no keysym flags. `x11vnc -help` says (lines 3144-3148):
"-add_keysyms / -noadd_keysyms  If a Keysym is received from a VNC viewer and that Keysym
does not exist in the X server, then add the Keysym to the X server's keyboard mapping on
an unused key. Added Keysyms will be removed periodically and also when x11vnc exits.
**Default: -add_keysyms**", and `-modtweak` is likewise "Default: -modtweak" (line 3058).
Nothing needs adding to the spawn line.

### 2.2 Results at 8 ms (the PLAN's starting delay)

| Case | String | Result | Notes |
|---|---|---|---|
| a | `Hello, World! @#$%^&*()` | **pass**, 23/23 events, 359 ms | uppercase + shifted symbols via `-modtweak`; `$` `^` `&` `*` `(` `)` all exact |
| b | `Pässwörd ßÄÖÜ €` | **pass**, 15/15, 163 ms | Latin-1 by codepoint; `€` via table `0x20ac`; screenshot `/api/uploads/d5521c3f37a3/20260826T013205Z-r1-part2-b-umlauts-in-vm.png` shows it in the VM textarea |
| c | `line1\nline2` (`\n` as `XK_Return 0xff0d`) | **pass**, 11/11 | textarea stores `\n` — value byte-exact |
| d | `a\tb` (`\t` as `XK_Tab 0xff09`) | **fails as expected**: echo = `a` | Tab moved focus OUT of the textarea; `b` went to whatever got focus. Recovery: `Shift+ISO_Left_Tab` (`0xffe1` down, `0xfe20`, up) then `z` → echo `az`, so focus came back. Screenshot `/api/uploads/d5521c3f37a3/20260826T013448Z-r1-part2-d-after-tab.png` |
| e | `🙂` as `0x0101f642` | **pass** — 2 UTF-16 units, ONE `input` event (`count:1`) | x11vnc added the keysym on the fly; Chrome/GTK translated it. Emoji works on this stack |
| f | 300-char mixed string (§6.3 `seed.repeat(6).slice(0,300)`, 336 UTF-8 bytes, no control chars) | **pass**, 300/300, 2.96 s at 8 ms | screenshot `/api/uploads/d5521c3f37a3/20260826T013212Z-r1-part2-f-300chars-in-vm.png` |

### 2.3 Delay sweep — smallest inter-key delay with 5/5 byte-exact

| Delay | (b) 15 chars: pass / send time | (f) 300 chars: pass / send time |
|---|---|---|
| **0 ms** | **5/5** — 3, 0, 0, 8, 1 ms | **5/5** — 6, 5, 5, 12, 9 ms |
| 4 ms | 5/5 — 73–137 ms | 5/5 — 1.43–1.51 s |
| 8 ms | 5/5 — 136–171 ms | 5/5 — 2.54–2.69 s |
| 16 ms | 5/5 — 252–292 ms | 5/5 — 4.93–4.99 s |
| 32 ms | 5/5 — 491–505 ms | 5/5 — 9.76–9.79 s |

**Smallest delay giving 5/5 on both: 0 ms.** The whole 300-char string leaves the
browser in ≈6 ms as one burst of 600 `KeyEvent` frames; x11vnc's on-the-fly keysym
additions (`ä ö ü ß Ä Ö Ü € —`, each absent from the US map) did not race Chrome's keymap
refresh in 25 trials at 0 ms. The 4-ms-per-key cost of `setTimeout` is pure latency with no
measurable benefit here.

Follow-up burst test (`extra.mjs`, 0 ms): **1000 chars 3/3** (13–19 ms send), **3000 chars
3/3** (42–72 ms send), first-diff index −1 every time. Total time to appear in the VM was
dominated by the echo settle window, not by typing.

Caveat for B1's comment: this is one Xvfb/x11vnc/Chrome-148 stack on an idle host. A
loaded host or a different X keymap could behave differently — hence the comment should
say what was typed and where, not claim universality. A conservative production default of
a few ms costs nothing user-visible for a password and only ~1 s per 300 chars.

### 2.4 Focus is NOT required on the noVNC canvas (rfb.js:408 writes the socket)

`extra.mjs` `BLURRED`: before, `iframe.activeElement = CANVAS` (noVNC calls
`UI.rfb.focus()` on connect, `ui.js:1099`). Then `canvas.blur()` + `parentTextarea.focus()`
→ `iframeActive: BODY, parentActive: pt, parentHasFocus: true` — i.e. exactly B1's state,
where Konrad's cursor sits in the takeover page's own textarea. `sendKey` of
`Blur-Test ÄÖÜ €` at 0 ms: **pass, 15/15**. `sendKey` does not read DOM focus at all
(`rfb.js:408-431`).

### 2.5 CR / CRLF

`keysymdef.lookup(0x0d)` returns `0x0100000d` — a "unicode CR" keysym, not `XK_Return`.
Do not feed `\r` to `lookup`. Sending `x`, one `0xff0d`, `y` yields textarea `x\ny`
(`extra.mjs` `CRLF-as-one-Return`), so the PLAN's rule "`\r\n` → one Return; `\n` →
Return" is the right normalisation; a lone `\r` should also become one Return.

---

## 3. What else B1 must know

### 3.1 The VM's keyboard focus starts in Chrome's OMNIBOX — and Return there is a Google search

First measurement pass (before the fail-fast probe existed) typed everything into the
address bar: the supervisor's `page.goto(file:///…/echo.html)` left Chrome's keyboard
focus on the omnibox, not on the page's `autofocus` textarea. `xdotool getwindowfocus
getwindowname` on `:97` still said `r1 keysym echo - Google Chrome`, so "which window is
active" tells you nothing about "which widget has focus". Consequences observed:

- Cases a, b, e, f: echo empty — the text went into the omnibox.
- Case c: `line1` + Return **navigated the VM to
  `https://www.google.com/search?q=line1&…`** (window title afterwards; screenshot
  `/api/uploads/d5521c3f37a3/20260826T012715Z-r1-part2-f-300chars-in-vm.png` shows Google's
  "unusual traffic" reCAPTCHA page for that query, egress IP shown as `141.56.60.4`, time
  `2026-08-26T01:27:10Z`). `line2` then landed in the still-displayed echo textarea (5
  events, exact) because pressing Enter in the omnibox hands focus to the page content.
- `Ctrl+A` outside a field selected the whole page (visible in the same screenshot).

For a text-to-VM feature that exists to type **passwords**, this is the failure that
matters: with the wrong focus, "Type keys" + Enter submits the secret to Google as a
search query. Recommendations for B1, in order of importance:

1. Never append Return implicitly. Make "Send" type the text only; make "Send + Enter" a
   separate, explicit control.
2. Tell him, in the panel, to tap the target field in the VM first. The page cannot see
   VM focus (X11 owns it); a noVNC pointer tap IS the focus mechanism.
3. Consider a "Set VM clipboard" default when no tap on the canvas has happened yet in
   this session, and switch the default to "Type keys" after the first canvas
   pointer-down (`rfb` fires no focus event, but the parent can listen for `pointerdown`
   on the iframe's canvas via `contentDocument`).
4. Do not `Ctrl+A` on his behalf.

After recovery (`Ctrl+L`, URL, Return, then a mouse click on the textarea via xdotool), the
probe string `probe` round-tripped and the full run passed — so the rig, not the keysyms,
was at fault.

### 3.2 Other facts

- `sendKey` returns silently when `_rfbConnectionState !== 'connected'` — B1 must check
  `__forgeNoVNC.connected` (or the class) BEFORE sending and report "not connected" to
  the user, or the text vanishes with no error.
- x11vnc reports no QEMU-extended-key support (`qemuExtKey:false`), so `sendKey` always
  emits classic `KeyEvent`s; passing `code=null` is correct and future-proof (it stays
  on that branch even if a server advertises the pseudo-encoding).
- Emoji works; astral characters must be iterated by code point (`for (const ch of str)`),
  not by UTF-16 unit.
- Tab leaves the field. If B1 keeps `\t → XK_Tab`, say so in the UI ("Tab moves to the
  next field") — it is useful for user+Tab+password, and harmful in a textarea.
- The typed text never appears in any log on this path by construction: forge-control
  pipes bytes it does not parse, websockify logs only connects, nginx has `access_log off`
  there (memory note `takeover-socket-death-forensics`). Nothing here changes that.

---

## 4. Harness defects found on the way (not B1's, but someone's)

### 4.1 `assignDisplay` ignores foreign X servers — `r1-keysym` hashed onto a live `:99`

`research-browser.mjs:851-884` claims a slot in `.state/displays/<n>` by FNV hash of the
profile name (`displaySlot`, l.190) and only probes onward if ANOTHER profile owns the
registry file. It never consults `/tmp/.X<n>-lock`. `r1-keysym` hashes to `:99`, where a
Xvfb this tool did not start has run since Aug 11 (`pid 2275830`, `/usr/bin/Xvfb :99
-screen 0 1920x1080x24 -extension GLX -ac -nolisten tcp`, parent pid 1). `clearStaleXLock`
(l.968-989) then dies with "display :99 is already in use by a live X server … remove
`.state/<profile>/display` to move the profile" — but removing that file re-runs
`assignDisplay`, which re-reads the registry, sees `displays/99` owned by `r1-keysym`
and re-pins `:99`. The advice in the error cannot work. What did: write
`.state/displays/97` = `r1-keysym` and `.state/r1-keysym/display` = `97` by hand, then
`open` succeeded. Any profile name whose hash lands on 99 (or 126 while `os-ui` is up,
or any display another tool uses) is dead on arrival until this is fixed — a name like
`konrad-main` should be checked against this before it is baked in as the default.

### 4.2 Bundled Playwright browser drift

`/opt/hermes-workspace/node_modules/playwright` (1.60.0) wants
`chromium_headless_shell-1223`; `/root/.cache/ms-playwright/` has `chromium-1234` and
`chromium_headless_shell-1234`. `chromium.launch()` with no `executablePath` throws. Use
`executablePath: /usr/bin/google-chrome-stable` (what `research-browser.mjs` resolves,
`CHROME_CANDIDATE_PATHS`) — any new E2E check (B5) must do the same or it will be red for
the wrong reason.

### 4.3 Google bot-wall from this box (relevant to Konrad's Dolphin-Anty question)

A plain search from the VM Chrome (`--no-sandbox` infobar visible, datacenter egress) got
Google's "Our systems have detected unusual traffic … I'm not a robot" reCAPTCHA
interstitial on the first request. That is real evidence of bot-detection against our
Chrome — but on a Google **search**, triggered by an accidental omnibox submit, not on a
site Konrad needs to log into. It should be recorded, not acted on: the profile-name fix
stands, and the anti-detect question is answered only when a login target he needs shows
this wall.

---

## 5. Cleanup

- `node scripts/research-browser.mjs close r1-keysym` → exit 0, `supervisor
  stopped-gracefully pid 763698`; afterwards no `Xvfb :97`, `x11vnc`, `websockify :6907`
  or listener on `5997/6907/47311` remained; `/tmp/.X97-lock` gone.
- Echo server killed (`pkill -f "node echo-server.mjs"`).
- `/opt/ai-os/browser-profiles/r1-keysym/` and `.state/r1-keysym/` remain: a THROWAWAY
  with no logins — per project rules not deleted. `.state/displays/97` and `/99` both say
  `r1-keysym`; harmless, delete with the profile when Konrad decides on the sweep.

---

## 6. Repro

### 6.1 Rig

```sh
D=$(mktemp -d /tmp/r1-keysym.XXXX)            # this run: /tmp/r1-keysym.sBQQ
# echo-server.mjs (node http, port 47311): POST /echo stores body; GET /last → {last,count}; POST /reset
# echo.html: <textarea id=t autofocus> + input → fetch('http://127.0.0.1:47311/echo',{method:'POST',body:t.value})
node scripts/research-browser.mjs open r1-keysym --url "file://$D/echo.html" --service generic --no-reminder
#   (display pinned by hand to :97 first — see §4.1)
DISPLAY=:97 xdotool key ctrl+l; xdotool type "file://$D/echo.html"; xdotool key Return
DISPLAY=:97 xdotool mousemove 200 250 click 1     # give the textarea VM focus (§3.1)
NOVNC_PORT=6907 ECHO_PORT=47311 node measure.mjs   # §6.2
node extra.mjs                                     # §6.3 bursts / blurred / CR
node scripts/research-browser.mjs close r1-keysym
```

### 6.2 `measure.mjs` (shape; full file was in the mktemp dir, throwaway)

Headless Playwright with system Chrome → part 1a on `vnc.html?autoconnect=1&path=websockify`
→ part 1b parent page (`ctx.route` fulfill) with the iframe, module script injected via
`f.contentDocument.createElement('script')`, `MutationObserver` on the iframe `<html>` →
fail-fast `probe` trial → cases a,b,c,e,f at 8 ms → sweep `{0,4,8,16,32} × 5` for b and f →
case d + Shift+Tab recovery → `ss -K` kill + observer read-back. Screenshots via
`page.screenshot` into `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png`.

Typing primitive (runs in the parent):

```js
const rfb = f.contentWindow.__forgeNoVNC.rfb;          // re-read each call
for (const ch of str) {                                  // by code point
  const cp = ch.codePointAt(0);
  const k = cp === 0x0a ? 0xff0d : cp === 0x09 ? 0xff09 : f.contentWindow.__forgeKeysyms.lookup(cp);
  rfb.sendKey(k, null, true); rfb.sendKey(k, null, false);
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
}
```

### 6.3 Strings

- seed for (f) and the bursts: `Zäh und präzise: Übung 42 macht den Meister! Preis €19,90 —
  Größe XL; Straße #7 (Köln) & Co. ` (95 chars), repeated and sliced to 300 / 1000 / 3000.

---

## Sources

All accessed 2026-08-26 (UTC), on VPS1 unless noted.

- `/usr/share/novnc/app/ui.js` (Debian `novnc 1:1.3.0-2`) — lines 388-414, 985-1035,
  1085-1130.
- `/usr/share/novnc/core/rfb.js` — lines 125, 400-450, 1786, 2200-2201, 2580.
- `/usr/share/novnc/core/input/keysymdef.js` — lines 482, 672-690.
- `x11vnc -version` / `x11vnc -help` (0.9.16, lastmod 2019-01-05) — help lines 3051-3058
  (`-modtweak`), 3144-3148 (`-add_keysyms`).
- `scripts/research-browser.mjs` (this worktree, `5805d76`) — lines 174-226 (display/port
  maths), 595-640 (`resolvePlaywright`), 851-884 (`assignDisplay`), 968-989
  (`clearStaleXLock`), 1137-1175 (x11vnc/websockify spawn), 1750 (`launchPersistentContext`).
- `/opt/ai-os/browser-profiles/.state/r1-keysym/takeover.json`, `x11vnc.log`;
  `.state/displays/*`.
- `ps -eo pid,ppid,lstart,cmd -p 2275830`; `/tmp/.X99-lock`.
- Measurement logs: `/tmp/r1-keysym.sBQQ/measure.log` (first pass, omnibox), `measure2.log`
  (reported pass), `extra.log` — throwaway, quoted above.
- Screenshots (served by forge-control; run `d5521c3f37a3`):
  `/api/uploads/d5521c3f37a3/20260826T012359Z-r1-keysym-echo-page.png`,
  `…/20260826T012715Z-r1-part2-f-300chars-in-vm.png` (omnibox → Google wall, first pass),
  `…/20260826T013158Z-r1-part1a-direct-vnc-connected.png`,
  `…/20260826T013205Z-r1-part2-b-umlauts-in-vm.png`,
  `…/20260826T013212Z-r1-part2-f-300chars-in-vm.png`,
  `…/20260826T013448Z-r1-part2-d-after-tab.png`,
  `…/20260826T013451Z-r1-kill-ws-observer.png`.
- Memory notes read before starting: `takeover-socket-death-forensics`,
  `novnc-ws-proxy-needs-two-fixes`, `clipboard-e2e-harness-was-already-complete`.
- No web sources were needed; nothing came from a logged-in browser session. The only
  browser sessions were the loopback `r1-keysym` stack (research-browser.mjs) and a
  headless Playwright driver on this host.
