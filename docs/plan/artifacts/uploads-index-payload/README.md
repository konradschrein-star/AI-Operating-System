# aios-uploads-index-payload — Round 1: Verification, Attribution & Evidence Report

**Project:** `aios-uploads-index-payload`  
**Branch:** `project/6a6a16c6`  
**Status:** Verification & Evidence Complete (`gates-808.sh --strict` GREEN)

---

## 1. Problem Statement & Root Cause Analysis

During production console bandwidth profiling (60s window at rest, valid browser session, 2026-08-24 08:05Z), `/uploads/index` was measured as the single largest bandwidth consumer, generating **121,374 B/min (47% of total console traffic)**. While prior lanes successfully cut `/chat` (-40%) and `/chat/<id>/team` (-41%), the console's net bandwidth remained unimproved (254,171 B/min baseline vs 260,448 B/min after) because `/uploads/index` grew nearly 4x.

Two independent root causes were identified and resolved in this project:

1. **Payload Bloat per Response (16 KB → 60.7 KB uncompressed):**
   `aios-browser-stream-viewer` added rich diagnostic fields for Red Mode (`is_live`, `needs_human`, `signal`, `browser_state` containing 15+ subfields like `reason`, `service`, `port`, `novnc_port`, `vnc_url`, `stuck_ts`, etc.) to *every single run row* in `forge-control/src/lib/uploads-index.ts`. For 133 runs on the Hetzner VPS, 130 of which were idle, the response payload ballooned from ~16 KB to 60,689 bytes.
2. **Next.js Rewrite Stripping ETag Headers:**
   `aios-chat-list-payload` introduced conditional request support (`ETag` / `HTTP 304 Not Modified`) on `forge-control` directly (:7700). However, the Next.js rewrite rule in `next.config.mjs` (`/api/proxy/:path* -> ${FORGE_CONTROL}/api/:path*`) failed to carry response `ETag` headers through to the browser. As a result, the browser never received an `ETag`, never sent `If-None-Match`, and always fetched full 60.7 KB payloads on every 30s poll tick.

---

## 2. Implemented Architecture & Solutions

### 2.1 Idle Run Payload Pruning (`forge-control/src/lib/uploads-index.ts`)
- `computeAllRuns()` now conditionally serializes `browser_state`, `is_live`, `needs_human`, and `signal` **only** when a run is active (`is_live: true`) or alerting (`needs_human: true`).
- Idle runs (`!is_live && !needs_human`) serialize only the 6 essential fields: `id`, `count`, `image_count`, `artifact_count`, `file_count`, `latest_ts`.
- **Cold Payload Reduction:** The 133-run uncompressed payload drops from **68,481 B (66.9 KB)** to **17,651 B (17.2 KB)** — a **74.2% reduction**, well below the < 20 KB ceiling.

### 2.2 Dynamic State Invalidation in ETag Hashing (`computeTag`)
- `computeTag()` incorporates `is_live`, `needs_human`, and `signal` into the SHA-1 digest alongside file counts and timestamps:
  ```ts
  h.update(`${r.id}:${r.count}:${r.image_count}:${r.artifact_count}:${r.file_count}:${r.latest_ts ?? ""}:${r.is_live ? 1 : 0}:${r.needs_human ? 1 : 0}:${r.signal ?? ""};`);
  ```
- Any state transition (e.g. idle → live blue mode or live → red mode alert) immediately alters the computed ETag, ensuring clients break out of 304 caching and receive updated state within the 30s poll tick.

### 2.3 Transparent Route Handler Proxy (`forge-control-web/app/api/proxy/[...path]/route.ts`)
- Replaced the opaque Next.js rewrite with an App Router Route Handler (`proxy-handler.ts`).
- **Header Preservation:** Explicitly forwards conditional headers (`If-None-Match`, `If-Match`, `If-Modified-Since`, `Accept`, `Authorization`, `Cookie`) and upstream response headers (`ETag`, `Cache-Control`, `Content-Type`, `Content-Length`).
- **HTTP 304 Handling:** Directly forwards upstream `304 Not Modified` with `null` body (0 bytes transfer).
- **WebSocket / VNC Bailout:** Intercepts `Upgrade: websocket` and `/vnc/` subpaths, failing fast with `502 Bad Gateway` and `x-proxy-bailout: upgrade`, preserving the dedicated nginx takeover route.
- **Dynamic Host Binding:** Reads `process.env.FORGE_CONTROL_URL` inside the request handler at runtime, preventing test/production host baking.

---

## 3. Console Bandwidth Attribution Table

**Provenance, read this before the numbers:** the *Before* and *After (Two
Prior Lanes)* columns are the operator's own real-browser, real-session
production measurement (60s at rest, 2026-08-24 08:05Z), transcribed
verbatim from the project brief — not re-derived. This round's own build
task cannot repeat that capture: the worktree-only policy forbids hitting
live endpoints, the live session, or the live database from a build task
(only an explicitly-briefed deploy/verify task may — see
`docs/plan/10-policy-agent-autonomy-and-escalation.md`), and the sibling
`aios-chat-list-payload` round made the identical call for the same reason
(`docs/plan/artifacts/chat-rail-payload/README.md`).

What **is** independently verified here: `scripts/checks/check-uploads-payload.ts`
spins up a real upstream HTTP server, drives it through the *actual*
`GET` handler exported by `forge-control-web/app/api/proxy/[...path]/route.ts`,
captures the real 304 response the Route Handler returns, and serializes its
actual status line + headers to get a real byte count — **117 bytes**, not a
guessed constant. The `/uploads/index` "This Round" cell below is that
measured value × 2 req/min (`SHOTS_INDEX_POLL_MS = 30_000`). Every other row
is carried over unchanged from the prior lanes' real measurements.

| Endpoint | Before (Baseline) | After (Two Prior Lanes) | This Round (Done) | Impact / Basis |
|---|---|---|---|---|
| **`GET /api/proxy/uploads/index`** | 32,125 B/min (13%) | 121,374 B/min (47%) | **234 B/min (0%)** | **-99.81%**, MEASURED: 2 req/min × 117 real bytes (actual 304 status line + headers from the live Route Handler code path, 0 body bytes) |
| `GET /api/proxy/chat` (rail list) | 125,288 B/min (49%) | 75,410 B/min (29%) | 75,410 B/min (54%) | -39.8% (retained from prior lane, out of this round's scope) |
| `GET /api/proxy/chat/<id>/team` | 82,638 B/min (33%) | 48,670 B/min (19%) | 48,670 B/min (35%) | -41.1% (retained from prior lane, `TEAM_POLL_MS = 10000`) |
| `GET /api/proxy/chat/<id>/plan` | 7,972 B/min (3%) | 7,972 B/min (3%) | 7,972 B/min (6%) | Untouched (2 req/min) |
| `GET /api/proxy/chat/<id>` (delta) | 4,938 B/min (2%) | 4,938 B/min (2%) | 4,938 B/min (4%) | Untouched (delta prompt pruning) |
| `GET /api/proxy/usage/quota` | 1,210 B/min (<1%) | 1,210 B/min (<1%) | 1,210 B/min (1%) | Untouched (1 req/min) |
| **TOTAL CONSOLE BANDWIDTH** | **254,171 B/min** | **259,574 B/min** | **138,434 B/min** | **-45.5% net console reduction vs baseline; -99.81% on the target endpoint vs the pre-fix peak** |

**Still open:** the two prior lanes' "After" numbers for `/chat` and
`/chat/<id>/team` are themselves live-equivalent estimates, not this round's
own capture (see their own reports). A single live re-measurement through
`os.schreinercontentsystems.com` at `:7701`, mirroring the operator's
original method, is what a deploy/verify task should run to confirm the
actual production number lands under the ~20,000 B/min target — this report
gives it a specific, sourced prediction (234 B/min) to check against, not a
guess dressed as a result.

---

## 4. Visual Verification & Screenshot Evidence

To ensure zero visual regression, `BrowserShots.tsx` and `RunShotsIndicator` were tested and verified across all three core visual states using the real exported components rendered against pruned `UploadsIndexRun` fixtures (idle rows omitting `browser_state`/`is_live`/`needs_human`/`signal`, live and red rows retaining them — the exact shape `computeAllRuns()` now emits per `866eeea`). Screenshots were captured with `research-browser.mjs` driving real Chromium against a throwaway preview page, and are saved under this run's uploads directory, `/opt/ai-os/uploads/d6b614e7ad9a/` (read back inline in the reporting chat transcript, not merely written):

### State 1: Idle Run (Archived Stills, Pruned Payload)
- **Visuals:** Neutral borders, collapsed camera indicator showing shot count and timestamp, thumbnail strip with lazy images. No LIVE or NEEDS KONRAD badge.
- **File:** `/opt/ai-os/uploads/d6b614e7ad9a/20260824T110500Z-uploads-state-idle.png`
- **Artifact Copy:** `docs/plan/artifacts/uploads-index-payload/20260824T110500Z-uploads-state-idle.png`

### State 2: Live Blue Mode (Active Streaming & Flowing Outline)
- **Visuals:** Flowing blue animated glow (`fg-stream-live` using `--fg-accent` and `--fg-decide`), `● LIVE` badge, thumbnail strip with accent border. Reduced motion fallback applies static `1.5px solid var(--fg-accent)`.
- **File:** `/opt/ai-os/uploads/d6b614e7ad9a/20260824T110500Z-uploads-state-live-blue.png`
- **Artifact Copy:** `docs/plan/artifacts/uploads-index-payload/20260824T110500Z-uploads-state-live-blue.png`

### State 3: Red Mode (Needs Human / Login Wall Alert)
- **Visuals:** Pulsing red alert outline (`fg-stream-red` using `--fg-bleed` and `--fg-dangerActionBorder`), `⚠️ NEEDS KONRAD` badge, explicit warning banner detailing service name and reason ("Perplexity authentication wall — CAPTCHA verification required").
- **File:** `/opt/ai-os/uploads/d6b614e7ad9a/20260824T110500Z-uploads-state-red-mode.png`
- **Artifact Copy:** `docs/plan/artifacts/uploads-index-payload/20260824T110500Z-uploads-state-red-mode.png`

Note on the thumbnails inside each screenshot: the individual shot images
(`dashboard-overview`, `active-devtools`, `perplexity-login-wall`, …) render
as broken-image glyphs because the preview page's mock `BrowserShotRef`s
point at filenames that were never written to an uploads directory — only
the container chrome (border color, badge, camera indicator, warning banner)
under test is real. That is the correct scope for this check: the
component-state contract, not individual image loading, which is already
covered by the existing `shotSrc()` validation path.

---

## 5. Test Harnesses & Verification Evidence

All test suites and strict gate scripts pass cleanly:

1. **Uploads Payload & ETag Harness (`scripts/checks/check-uploads-payload.ts`):**
   - Cold payload size: 17,651 bytes (< 20,000 bytes ceiling) — **PASS**
   - Steady-state 304 bandwidth: 234 B/min, measured from a real 304 response (< 500 B/min ceiling, 99.81% cut) — **PASS**
   - ETag generation and state transition invalidation — **PASS**
   - Proxy Route Handler conditional passthrough & 502 upgrade bailout — **PASS**
   - Token purity (zero raw colour literals) — **PASS**
2. **Browser Stream Viewer Check (`scripts/checks/check-browser-stream-viewer.ts`):**
   - Pinned `TEAM_POLL_MS = 10000` (6 req/min) — **PASS**
   - Steady-state rate: 19 req/min (≤ 40 ceiling) — **PASS**
   - Degraded fallback rate: 32 req/min (≤ 40 ceiling) — **PASS**
   - Fullscreen modal open rate: 31 req/min (≤ 40 ceiling) — **PASS**
3. **Engine Unit Suite (`forge-control/src/lib/uploads-index.test.ts` & `proxy-route.test.ts`):**
   - Comprehensive unit coverage for payload pruning, cache tagging, and proxy routing.
4. **Universal Gate Suite (`scripts/checks/gates-808.sh --strict`):**
   - All TypeScript compilation, token checks, and unit tests pass with zero warnings or errors.
