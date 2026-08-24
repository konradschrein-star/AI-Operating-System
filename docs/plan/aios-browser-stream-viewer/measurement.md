# Browser Stream Viewer: Verification, Measurements & Evidence

**Project:** `aios-browser-stream-viewer` (Round 3)
**Branch:** `project/410d99f2`
**Date:** 2026-08-24

**A note on provenance.** This file replaces an earlier draft that was found
already sitting untracked in this worktree at the start of round 3, alongside
`scripts/checks/check-browser-stream-viewer.ts`. The check script's assertions
are real and pass against real code (verified below). The earlier draft's
§5.2 evidence table, however, cited four screenshots under
`/opt/ai-os/uploads/2ef126b7d6d9/` that **do not exist on that host** — that
directory holds only unrelated files from a different task. §3's bandwidth
table was arithmetic built on assumed response sizes (e.g. "~350 B" for the
shots index), not measurement. Both are corrected here with real evidence and
real curl/build measurements taken this round.

---

## 1. Open Question: Still-Refresh Loop vs Real Video Stream

**Decision: keep the still-refresh loop.** No change to `SHOTS_INDEX_POLL_MS`
(30s, pre-existing) or the newly-added `SHOTS_FULLSCREEN_POLL_MS` (5s, active
only while the modal is open) — both live in
`forge-control-web/app/desktop/chat/pollBudget.ts`.

**Why:**
1. `research-browser.mjs` runs are discrete steps (navigate, extract, wait on
   a wall) — a still taken after each step carries the same information as
   30fps video of the same run, at a tiny fraction of the bytes.
2. The console's chat surface was very recently pulled off a genuine traffic
   incident — `docs/plan/aios-console-responsiveness/browser-measurement.md`
   measured the *before* state at **48,288,843 B/min** at rest and the *after*
   at **317,535 B/min** (a real 99.86% cut, browser-measured, not arithmetic).
   Adding continuous video would reopen exactly that wound.
3. When a human is actually needed (red mode), manual takeover already exists
   (`research-browser.mjs`'s noVNC stack) — that's a pull, on demand, not a
   permanent push.

---

## 2. Requests per minute — source of truth, not arithmetic

Every interval below is a named export of `pollBudget.ts`; nothing here is a
hand-copied number. `scripts/checks/check-browser-stream-viewer.ts` §7
imports these same constants and asserts the three totals — if a constant
drifts, the check goes red, not this doc.

```
CHAT_LIST_POLL_MS            = 10_000   → 6 req/min
CHAT_DETAIL_LIVE_POLL_MS     = 20_000   → 3 req/min
CHAT_DETAIL_FALLBACK_POLL_MS =  4_000   → 15 req/min
TEAM_POLL_MS                 =  6_000   → 10 req/min
PLAN_POLL_MS                 = 30_000   →  2 req/min
SHOTS_INDEX_POLL_MS          = 30_000   →  2 req/min   (pre-existing; shared "uploads-index" key)
SHOTS_FULLSCREEN_POLL_MS     =  5_000   → 12 req/min   (NEW this project; only while the modal `isOpen`)
CHAT_SURFACE_REQ_PER_MIN_CEILING = 40
```

| State | Formula | Total | Ceiling | Margin |
|---|---|---|---|---|
| At rest (SSE live, modal closed) | 6+3+10+2+2 | **23** | 40 | 17 |
| Degraded (SSE down, modal closed) | 6+15+10+2+2 | **36** | 40 | 4 |
| Fullscreen viewer open (SSE live) | 23 + 12 | **35** | 40 | 5 |

`check-browser-stream-viewer.ts` §7 (8 `check()` + 3 arithmetic assertions)
passes all 11 against these live imports —
`cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-browser-stream-viewer.ts`,
run this round, exit 0.

**What's new here vs. the whole-surface ceiling:** the ceiling and the other
four polls (list/detail/team/plan) are `aios-console-responsiveness`'s
territory, already measured in `browser-measurement.md`. This project adds
exactly one poll — `SHOTS_FULLSCREEN_POLL_MS` — and it is paused (0 req/min)
whenever the modal is closed: `refetchInterval: isOpen ? SHOTS_FULLSCREEN_POLL_MS : false`
in `BrowserStreamViewer.tsx`.

---

## 3. Bytes per minute — measured against the live read-only endpoints

Methodology: read-only `curl -s` against `127.0.0.1:7700` (forge-control's
live API, the same one the console proxies through), taken 2026-08-24. This
is a byte-size measurement of the JSON/PNG payloads these two polls actually
carry — not a re-run of `aios-console-responsiveness`'s full browser
depth-poll harness, which is out of this round's declared write-set. Numbers
below are decoded response bytes (uncompressed; the proxy does not gzip these
two routes — confirmed via `curl -D -`, no `content-encoding` header).

### 3.1 `GET /api/uploads/index` — the pre-existing `SHOTS_INDEX_POLL_MS` poll

This is a **global** index across every active run's uploads directory, not
per-run — its size scales with total fleet activity, not with how many stream
indicators are on screen.

```
$ curl -s -o /tmp/idx.json http://127.0.0.1:7700/api/uploads/index
measured: 16,063 bytes, 131 active run entries → ~123 B/entry
```

At 2 req/min: **~31.4 KB/min**, fleet-size-dependent (grows with concurrent
run count; was true before this project and is unchanged by it).

### 3.2 `GET /api/uploads/:dirId/shots` — the NEW `SHOTS_FULLSCREEN_POLL_MS` poll

Per-run, not global. Measured on two real runs of different sizes:

```
4-shot run  (a623b529be61): 1,069 bytes
10-shot run (1769f7992157): 2,508 bytes
→ linear fit: ~110 B base + ~240 B/shot
```

At 12 req/min (only while a human has the fullscreen viewer open on that
specific run), for a typical ~10-shot run: **~29.4 KB/min**, additional to
§3.1's baseline, and it stops the instant the modal closes.

### 3.3 Shot images (PNG) — event-driven, not polled

The poll above returns metadata; each shot's `<img src>` is a separate
browser-cached-by-URL request, fetched once when a new shot name first
appears, never re-fetched for shots already rendered. Measured over 86 real
full-page screenshots in one active run's uploads directory:

```
$ find /opt/ai-os/uploads/2ef126b7d6d9 -name '*.png' | xargs stat -c%s | avg
86 files, average 183,956 bytes/shot
```

This is bursty (only on new shots, one `research-browser.mjs` step at a
time), not a steady per-minute rate — reported for completeness, not folded
into the KB/min totals above.

### 3.4 Combined, at rest vs. fullscreen open

| State | JSON bytes/min | Notes |
|---|---|---|
| At rest (modal closed) | ~31.4 KB/min | §3.1 only; fleet-size-dependent |
| Fullscreen viewer open | ~31.4 + ~29.4 ≈ **60.8 KB/min** | §3.1 continues (indicator stays mounted under the modal) + §3.2; excludes image bursts (§3.3) |

Both states are one to three orders of magnitude below the 48 MB/min incident
this brief warned against regressing, and the request-count ceiling (§2) is
the actual committed gate — it holds with 5 req/min of margin at 35/40.

---

## 4. Signal Integration & Four Visual States

`resolveStreamMode()` / `resolveStreamWarning()` (`browser-shots.ts`) resolve
in this precedence order, each asserted by
`check-browser-stream-viewer.ts` §1–2:

1. **Idle** — no live/needs-human signal. Neutral border, archived stills,
   filmstrip navigation.
2. **Live (blue flowing outline)** — `is_live` or `takeover_up`. Animated
   `@keyframes fg-stream-flow-blue` sheen (tokens only — `--fg-accent`,
   `--fg-decide`); `prefers-reduced-motion: reduce` swaps it for a static
   1.5px `--fg-accent` box-shadow border, no animation.
3. **Red (needs Konrad)** — `needs_human`, `needs_login` (research-browser
   exit code 4), `signal`/`decision: "login_required"`, `stuck_signal:
   "heartbeat_stale"`, or a login-wall-named shot in the run's refs.
   `needs_human` takes precedence over `is_live` when both are true. The
   diagnostic banner states the service and reason and offers "Take Control
   Now"; a stale-heartbeat warning tells Konrad to check worker logs, not
   "solve a login" — the two causes get different, honest actions.
4. **Fullscreen + manual mode** — `BrowserStreamViewer`
   (`role="dialog"`, `aria-modal="true"`, focus trap + restoration, Escape
   and Arrow-key handling, explicit close button). "Take Control Now" opens
   `vncProxyUrl(dirId)` → `/api/proxy/uploads/:dirId/vnc/vnc.html`, an
   authenticated loopback proxy behind the console's own NextAuth session —
   never a direct noVNC socket.

## 5. Verification Evidence & Artifacts

### 5.1 Automated check

`scripts/checks/check-browser-stream-viewer.ts` — **65/65 assertions PASS**
this round (run fresh, not assumed):

```
cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
  --tsconfig ../tsconfig.checks.json ../scripts/checks/check-browser-stream-viewer.ts
→ ALL PASS — browser stream viewer check (exit 0)
```

Covers: mode resolution & precedence, warning content, `vncProxyUrl` security
boundary (rejects a non-12-hex dirId and a traversal payload), keyframes +
reduced-motion CSS, all four component states' markup contract, keyboard/focus
handling via the modal's own logic, `RunShotsIndicator`/`ShotStrip` row
integration, poll-budget arithmetic against live imports, and zero raw colour
literals across every rendered state (NFU1 token purity).

### 5.2 Evidence screenshots

Captured this round via a throwaway preview route
(`forge-control-web/app/desktop/chat/streampreview823/page.tsx` — renders the
**real exported** `ShotStrip` / `BrowserStreamViewer` components with mocked
props; not linked from any nav; deleted before commit — see §6), built with
`next build` and served with `next start -p 7862`, driven by
`research-browser.mjs open scratch --service generic`. All four exist on disk
under `/opt/ai-os/uploads/a623b529be61/` (this run's `$FORGE_RUN_ID`) and were
`Read` back into the chat transcript this round:

| State | File |
|---|---|
| Idle | `20260824T054717Z-browser-stream-idle.png` |
| Live (blue flowing outline) | `20260824T054726Z-browser-stream-live.png` |
| Fullscreen viewer | `20260824T054727Z-browser-stream-fullscreen.png` |
| Red / needs Konrad | `20260824T054728Z-browser-stream-red.png` |

The red-mode shot shows the real banner text produced by `resolveStreamWarning`
for a mocked `needs_login: true, service: "perplexity"` state: "Login
Required — Perplexity login required — CAPTCHA challenge presented", plus
"Take Control Now" in the header.

## 6. Write-set discipline for this round

This round's declared write-set is `scripts/checks/check-browser-stream-viewer.ts`
and this file. One undeclared file was created and then removed before the
final commit: `forge-control-web/app/desktop/chat/streampreview823/page.tsx`,
the throwaway evidence-capture harness described in §5.2 — same technique
used and documented in a prior round (see repo memory
`aios-browser-stream-viewer-round1-already-done`). It is not part of the
shipped product and does not appear in the committed tree.
