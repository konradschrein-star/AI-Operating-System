# B5 — `check-takeover-text-input-e2e.ts`: typed through the real stack, no-log proven, wired, mutation-proved

Project `aios-takeover-usable`, round 3, task B5. Worktree `project/51ddfb27`, base
`ca1602b`. Measured 2026-08-26 04:20–04:45 CEST on VPS1 (16 cores, load average
12–30 throughout — other lanes were building). Run id `8b3c6330b0aa`.

Declared write-set: `scripts/checks/check-takeover-text-input-e2e.ts`,
`scripts/checks/gates-808.sh`, `docs/plan/aios-takeover-usable/evidence-text-input.md`.
Written OUTSIDE it, by the operator addendum's instruction ("you own the checks, so
you own this"): `scripts/checks/check-takeover-clipboard-e2e.ts` — §3 below.

## 1. What was built

`scripts/checks/check-takeover-text-input-e2e.ts` (≈1 300 lines) in two modes:

| mode | what runs | wall clock | gate |
|---|---|---|---|
| default (fast) | (7) keysym table · comment-stripped `console.` scan of the five page modules · pure session-view shape (`computeSessionView`) + the exact header strings | 1.7 s | unconditional, next to `check-vm-keys.ts` |
| `--browser` | the fast sections + the whole stack: loopback echo server → `research-browser.mjs open testtextinput --throwaway --url file://…/echo.html` (real Chrome on Xvfb :129, x11vnc 6029, websockify 6939) → xdotool focus click + a fail-fast "ok" probe → forge-control PROBE (uploads router + the real upgrade listener, restartable on a fixed port) → `next dev` → nginx stand-in → Playwright as an iPhone (390×844, iPhone UA, `isMobile`, `hasTouch`, every control tapped) | 23–27 s quiet, 89 s beside a tsc storm | behind `--browser` with the other browser gates |

Assertions, by the brief's numbering (107 in `--browser`, 26 fast):

1. textarea and Send bounding boxes inside 390×844, `scrollTop 0`, Send 44 px, panel shown, Type keys default.
2. `Pässwörd ßÄÖÜ € tab⇥here⏎line2` (30 code points) → panel says `typed 30 keys into the VM` → the echo server (POSTed by the page INSIDE the VM on every `input` event, sequence-numbered so racing requests cannot present a stale value) holds it byte-exact. echo.html makes Tab INSERT `\t` (a browser textarea moves focus on Tab — R1 §2.2 d), so an XK_Tab that arrived is a character and one that was dropped is a missing character.
3. Set VM clipboard: `xclip -o -selection clipboard -display :129` == `Buffer.from(text,"latin1")` hex (the VNC clipboard is Latin-1 on this stack — memory `vnc-clipboard-is-latin1-on-x11vnc-stack`).
4. `fc.restart()` destroys every probe socket (incl. the upgraded pipe) and re-listens on the same port → header shows `reconnecting 1/5 · dropped after 2 s` → `noVNC_connected` again → a NEW jti accepted, all jtis distinct, the first one's `upgrade closed … by=client` logged, no `ticket_replayed` → typing through the new iframe appends to the same VM textarea.
5. `GET /api/proxy/uploads/e2ec11b00002/takeover/session` through the nginx stand-in with the minted cookie: `connected_sockets 1`, `remaining_ms > 0`, `supervisor_live`, `stack_up`, `ended null`; header `connected · ends in h:mm:ss`; Done → confirm row → End → `POST …/takeover/end` answered `{ended:true, profile}` (captured by a page-side fetch spy) → header `Session ended: ended by Done`, iframe gone, `status testtextinput` → `takeover.up false`, `last_shutdown` recorded — **and** both ports free and no `x11vnc -display :129` within 15 s (added after run 3, §4.2).
6. NO-LOG: the sentinel fragment, the clipboard text and the sentinel+word are absent from this process's tee'd stdout+stderr (the probe and the front proxy live in-process), from `next dev`'s output, and from every `.state/testtextinput/*.log` (read as UTF-8 and Latin-1); five modules carry no `console.` outside comments.
7. `"\r\n"` → one `0xff0d`; `"\t"` → `0xff09`; `"ä"` → `0xe4`; `"€"` → `0x20ac`; `"🙂"` → one event (`0x0101f642`); sentinel → 30 events for 30 code points.

Nothing typed toward the VM is ever printed: a failed comparison reports lengths and the first differing index only. The check itself is the one place the sentinel string exists.

## 2. Wiring — `scripts/checks/gates-808.sh`

Unconditional (after `check-vm-keys.ts`):

```
gate_sh "check-takeover-text-input-e2e.ts — keysym table, no-console scan, session-view shape (fast)" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-takeover-text-input-e2e.ts | tail -3"
```

Inside `if [ "$BROWSER" = "1" ]` (after `check-chat-tool-path.mjs`), both takeover E2Es:

```
  gate_sh "check-takeover-clipboard-e2e.ts — Paste/Copy buttons through the real noVNC iframe" \
    "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
       --tsconfig ../tsconfig.checks.json ../scripts/checks/check-takeover-clipboard-e2e.ts | tail -3"
  gate_sh "check-takeover-text-input-e2e.ts --browser — type through the real stack, restart-reconnect, Done, no-log" \
    "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
       --tsconfig ../tsconfig.checks.json ../scripts/checks/check-takeover-text-input-e2e.ts --browser | tail -3"
```

Why the browser half is behind the flag although it takes 23–27 s on a quiet host: run 1
took 89 s and **dropped a keystroke** while `check-instrument-typecheck.sh` (63 tsc
processes) ran beside it (§4.1). Inside gates-808 the suite is its own tsc storm; a gate
that goes red under the suite's own contention would be reported as the feature
regressing. The fast half — the half a refactor breaks — runs every time.

## 3. `check-takeover-clipboard-e2e.ts` (outside the write-set, per the addendum)

- `:487` `takeover testclipe2e` → `takeover testclipe2e --throwaway`. Measured: without it the
  driver refuses a new name (exit 3); on this box it passed only because `.state/testclipe2e`
  survived from an earlier run.
- It was RED on this branch for a second reason nobody had seen because nobody ran it: §3d
  pinned the v1 fallback (`Clipboard read failed: …` + a `Paste text here...` textarea
  unfolding). B1 replaced that with a message pointing at the always-visible panel. Baseline
  run: `FAIL Toolbar displays honest permission error diagnostic`, `FAIL Manual paste fallback
  textarea is rendered on screen`, `FAILED: 2 CHECK(S) FAILED`, 24.1 s. §3d now pins the v2
  message, the panel's textarea, the absence of the old one, and that the panel accepts pasted
  text. Re-run: 28/28, 31.0 s.
- The addendum's "not even listed in instrument-manifest.txt": true, and moot —
  `check-instrument-typecheck.sh` enumerates `scripts/checks/**` by glob and reads the manifest
  only as a waiver ledger (0 entries). Both files compile: `PASS … exit 0, 0 diagnostics`. The
  suite's one red, `check-chat-pagination-browser.ts(139,11) TS2339`, is byte-identical to
  `main` — inherited.

## 4. Findings (both reported to the manager chat)

### 4.1 Type keys drops a keysym under CPU contention — the panel still says "typed 30 keys"

Run 1 (`--browser`, with the 60 s typecheck running beside it): the sentinel arrived as
29 of 30 code points, first difference at index 9 — the `ß` (keysym 0xdf, an on-the-fly
`x11vnc -add_keysyms` addition; ä ö Ä Ö Ü € are the same kind and all arrived). The panel
reported `typed 30 keys into the VM`: it counts what it SENT. Runs 2, 3(after the orphan
was reaped) and 4, nothing else started by me: 30/30 every time. R1's 0 ms and B1's
`KEY_DELAY_MS = 4` were measured on an idle host; a password typed during a deploy can
lose a character silently. Not in this write-set; memory note
`takeover-type-keys-drops-a-key-under-cpu-contention`.

### 4.2 `close` can leave x11vnc holding the VNC port — every later takeover on that profile hangs

Run 3's unmutated pass (inside prove-it-bites) died in `waitForConnected` after 60 s:
`upgrade accepted … jti=ee82…`, then `upgrade closed … seconds=57 by=client`. Cause: run 2's
x11vnc (pid 1156195, `-display :129 -rfbport 6029`) was still alive seven minutes after
Done — `.state/testtextinput/x11vnc.log` for that instance ends at `caught signal: 15`;
`/proc/1156195/wchan` = `futex_wait_queue`, ppid 1, `/tmp/.X129-lock` gone. A second SIGTERM
did nothing; SIGKILL reaped it. Every `open` in between logged `Error: could not obtain
listening port` twice, websockify proxied to the zombie, noVNC never got ServerInit.
`teardownTakeover()` (`scripts/research-browser.mjs:1276`) fires one SIGTERM per pid, never
waits, never escalates, and deletes takeover.json — so the next `open` cannot even see the
orphan. Run 1's instance exited only because it also saw `X connection to :129 broken`; which
one you get is a race. For `konrad-main`, reused daily, this is "Done today, hung takeover
tomorrow". The check now refuses to start on a held port naming the pid (E1), and asserts
after Done that both ports are free and no x11vnc for the display survives within 15 s
(run 4: PASS, x11vnc gone inside the window). Memory note
`research-browser-close-leaves-x11vnc-holding-the-vnc-port`.

### 4.3 Observation, no action: the header clock shows the sliding idle deadline

`connected · ends in 0:59:45` on a session with a 2 h cap: `remaining_ms` is
`min(idle, takeover, hard)` and the idle deadline (1 h from launch, then `now + 30 min` grace
every tick while connected) is the nearest. It never expires while a viewer is connected —
correct per B3's rules — but it reads as "59 minutes left" and will hover around 30:00
forever. A wording call for the ui lane, not a defect.

## 5. Runs

| run | context | result | wall |
|---|---|---|---|
| 1 | `--browser`, typecheck running beside it | 101 PASS / 2 FAIL (ß dropped, §4.1) | 89.4 s |
| 2 | `--browser`, alone | 103/103 | 23.5 s |
| 3 | `--browser`, alone, after run 2's Done | harness timeout in `waitForConnected` (§4.2) | 82.2 s |
| 4 | `--browser`, alone, after reaping pid 1156195, with the new E1/5 assertions | 107/107 | 26.9 s |
| fast | default mode | 26/26 | 1.7 s |
| clipboard | baseline / after §3 | 26 PASS 2 FAIL → 28/28 | 24.1 s / 31.0 s |

Screenshots (all read back in the run transcript), `/opt/ai-os/uploads/8b3c6330b0aa/`:
`20260826T023906Z-text-input-phone-connected.png`, `…3907Z-text-input-sentinel-typed.png`,
`…3908Z-text-input-clipboard-set.png`, `…3908Z-text-input-reconnecting.png`,
`…3909Z-text-input-reconnected.png`, `…3909Z-text-input-done-confirm.png`,
`…3910Z-text-input-session-ended.png`; run 1's `20260826T022806Z-text-input-sentinel-typed.png`
shows the VM textarea with the missing `ß`.

## 6. Mutation controls — `bash scripts/checks/prove-it-bites.sh` (e83f318, materialised untracked, deleted after)

Each `--check` is the gate body EXTRACTED from `gates-808.sh` by name (never hand-copied), run
the way `gate_sh` runs it — `bash -c "set -o pipefail; …"` with the `| tail -3`:

```
--check 'gate_sh() { bash -c "set -o pipefail; $2"; }; source <(awk "/^ *gate_sh .<name>/,/tail -3.\$/" scripts/checks/gates-808.sh)'
```

### 6.1 fast pipe · subject `vm-keys.ts` · mutation: `"\r\n"` produces two Returns

```
STEP 3 — check UNMUTATED
  | ALL PASS — 26 checks (fast sections only)
  exit code (unmutated): 0
STEP 4.1 — apply mutation 1 of 1 (source: file:/tmp/b5-mut-crlf.sh)
STEP 5.1 — check MUTATED
  | PASS  header: 'Session ended: ended by Done'
  | FAILED: 1 CHECK(S) FAILED (25 passed)
  exit code (mutated/1): 1
STEP 6.1 — restore and prove it by hash
  md5 BEFORE   : 722ee69221ea85664f1148f2b17b28f1
  md5 AFTER    : 722ee69221ea85664f1148f2b17b28f1
VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored
```

### 6.2 fast pipe · subject `TextToVM.tsx` · mutation: `console.log("sent")` after every `sendKey`

```
  exit code (unmutated): 0
  | FAILED: 1 CHECK(S) FAILED (25 passed)
  exit code (mutated/1): 1
  md5 BEFORE   : f5468a471afae9d5a3ca50927dfe4cda
  md5 AFTER    : f5468a471afae9d5a3ca50927dfe4cda
VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored
```

### 6.3 browser pipe · subject `TakeoverClient.tsx` · mutation: `Pasted ${text.length} chars` → `Pasted chars`

```
  | ALL PASS — takeover clipboard bridge and session quality fully verified E2E
  exit code (unmutated): 0
  | FAILED: 1 CHECK(S) FAILED
  exit code (mutated/1): 1
  md5 BEFORE   : 1c28d24258ffd4f7ad22671590dd5b22
  md5 AFTER    : 1c28d24258ffd4f7ad22671590dd5b22
VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored
```

### 6.4 browser pipe · subject `TextToVM.tsx` · mutation: silently skip the third key of every send

First attempt exited 3 (`HARD ERROR — the check was ALREADY FAILING before any mutation`) —
that was §4.2's orphan, the control doing its job. After reaping it:

```
  | PASS  no next dev for this worktree left running (0)
  | ALL PASS — 107 checks (fast + browser E2E)
  exit code (unmutated): 0
STEP 4.1 — apply mutation 1 of 1 (source: file:/tmp/b5-mut-skipkey.sh)
STEP 5.1 — check MUTATED
  | FAILED: 2 CHECK(S) FAILED (105 passed)
  exit code (mutated/1): 1
  md5 BEFORE   : f5468a471afae9d5a3ca50927dfe4cda
  md5 AFTER    : f5468a471afae9d5a3ca50927dfe4cda
VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored
```

(The two reds are (2) the sentinel comparison and (4) the after-reconnect comparison; the
panel's own `typed 30 keys` counter stays green under this mutation — the counter is not a
receipt, §4.1.)

## 7. Cleanup, verified

`ps` shows no `next dev`, Xvfb, x11vnc or websockify from this worktree; `ss -ltnp` shows
`:6029`/`:6939` free; `/opt/ai-os/uploads/e2ec11b00002` and the mktemp echo dirs are gone;
`/opt/ai-os/browser-profiles/testtextinput/` and `testclipe2e/` remain (`.throwaway`-marked,
0 logins) — deleting a profile dir is Konrad's call.
