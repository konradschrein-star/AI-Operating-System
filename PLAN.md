# Architecture Plan: aios-uploads-index-payload

## Executive Summary & Recommendation

**Recommendation**:
1. **Backend Payload Pruning (`forge-control/src/lib/uploads-index.ts`)**: Prune idle run rows in `/api/uploads/index` by omitting `browser_state`, `is_live`, `needs_human`, and `signal` when inactive (`!is_live && !needs_human`). Only serialize active indicators (`is_live: true`, `needs_human: true`, `signal`, and `browser_state`) when a run is live or alerting. This reduces uncompressed response body from **~60.7 KB down to ~15.3 KB** across 133 runs (~75% reduction).
2. **Proxy Header Passthrough Route Handler (`forge-control-web/app/api/proxy/[...path]/route.ts`)**: Replace the Next.js `rewrites()` rule in `next.config.mjs` for `/api/proxy/*` with a dedicated App Router Route Handler that explicitly forwards conditional request headers (`If-None-Match`, `If-Match`, `If-Modified-Since`) and faithfully passes through upstream status codes (notably **HTTP 304 Not Modified**) and headers (`ETag`, `Cache-Control`, `Content-Type`).
3. **Client Integration & Verification**: Ensure `BrowserShots.tsx` (`useShotIndex`, `RunShotsIndicator`) handles optional `browser_state` smoothly without layout shifts, preserving identical visual indicators (idle camera count, live blue flowing sheen, and red pulse alert with diagnostic popover). Prove zero visual regression via screenshots of all 3 states.
4. **Target Metric**: Restore steady-state `/uploads/index` bandwidth from **121,374 B/min down to ~300 B/min** (>99.7% reduction at 2 req/min / 30s poll), well below the **< 20,000 B/min** project threshold.

**Reasoning**:
- The 4x payload explosion (16 KB -> 60 KB) occurred because `aios-browser-stream-viewer` attached a full 14-field `browser_state` object to all 133 runs in the index, even though 99% are historical/idle runs that never need it. Detailed shot & browser state is already loaded on-demand via `GET /api/uploads/:id/shots` when an indicator is clicked.
- The caching failure occurred because Next.js internal `rewrites()` in `next.config.mjs` strip `ETag` and conditional caching headers on reverse-proxied responses. Bypassing the rewrite with an App Router Route Handler restores full HTTP 304 conditional request semantics for the browser without altering the NextAuth middleware security boundary.

**Rejected Alternatives**:
- *Omit runs with zero screenshots entirely from `/uploads/index`*: Rejected because `LibrarySurface.tsx` requires all run directories containing listable artifacts (patches, diffs, logs, transcripts).
- *Poll `/uploads/index` only for currently visible runs*: Rejected because the console rail / team list dynamically scrolls and filtering by visible run IDs adds query complexity without eliminating cache invalidation overhead.
- *Rely on client-side polling backoff or longer poll intervals*: Rejected because a 30s poll interval (`SHOTS_INDEX_POLL_MS`) is already budgeted, and slowing it down degrades live screenshot freshness for active agent tasks.
- *Use custom nginx location bypass for `/api/proxy/uploads/index`*: Rejected because nginx bypasses NextAuth middleware and introduces routing fragmentation across routes.

---

## Architectural Analysis & System Design

### 1. State Ownership, Work Dispatch, and Failure Modes
- **State Ownership**:
  - `forge-control/src/lib/uploads-index.ts` owns the filesystem sweep over `/opt/ai-os/uploads`, cache invalidation (`invalidateRunsCache()`), and ETag calculation (`getUploadsCacheTag()`).
  - `forge-control-web/app/api/proxy/[...path]/route.ts` owns the transport-level HTTP request/response proxying between the browser and forge-control (`:7700`).
  - `BrowserShots.tsx` owns the client query hook (`useShotIndex`, query key `["uploads-index"]`), deriving stream mode via `resolveStreamMode(browserState)`.
- **What Dispatches Work**:
  - Client: TanStack Query in `BrowserShots.tsx` dispatches `GET /api/proxy/uploads/index` every 30s (`SHOTS_INDEX_POLL_MS`).
  - Proxy: `route.ts` receives request, attaches `If-None-Match` from client, and invokes `http://127.0.0.1:7700/api/uploads/index`.
  - Backend: `routes/uploads.ts` compares `If-None-Match` with in-memory `tag`. If matched, returns `304 Not Modified` with 0 body bytes.
- **Failure Modes & Degradation**:
  - *forge-control offline*: Route handler catches network error and returns `502 Bad Gateway` with clear JSON error. TanStack Query enters error state and retains previous query data (`staleTime`).
  - *Corrupted / missing run directory*: `uploads-index.ts` skips unreadable entries without throwing (`catch(() => [])`), maintaining index availability.
  - *Browser state resolution failure*: `resolveBrowserState` falls back gracefully to `{ is_live: false, needs_human: false }`, rendering idle camera count.
- **How Konrad Sees It Broke**:
  - Hard errors surfaced via console toast / red indicator error badge.
  - Test suites (`pnpm test`, `check-uploads-payload.ts`, `gates-808.sh --strict`) fail on any non-200/304 response, dropped ETag, or oversized payload.

---

## Technical Specifications

### Component 1: Backend Payload Pruning (`forge-control/src/lib/uploads-index.ts`)
```ts
// Idle run representation in computeAllRuns():
const baseSummary: RunSummary = {
  id: entry.name,
  count: images.length,
  image_count: images.length,
  artifact_count: files.length - images.length,
  file_count: files.length,
  latest_ts: files[0].mtime,
};

// Only attach enriched browser state when active or needs human intervention
if (browser_state.is_live || browser_state.needs_human) {
  baseSummary.is_live = browser_state.is_live;
  baseSummary.needs_human = browser_state.needs_human;
  baseSummary.signal = browser_state.signal;
  baseSummary.browser_state = browser_state;
}
runs.push(baseSummary);
```
- ETag computation in `computeTag(runs)` includes `is_live`, `needs_human`, `signal` alongside counts and `latest_ts`, ensuring immediate invalidation when a run transitions between idle, live, and alerting states.

### Component 2: Next.js App Router Route Handler (`forge-control-web/app/api/proxy/[...path]/route.ts`)
- Mounts at `app/api/proxy/[...path]/route.ts`.
- Handles `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD`.
- Extracts `path` parameter and search parameters, constructing target URL `${FORGE_CONTROL}/api/${subpath}${query}`.
- Forwards incoming headers (including `if-none-match`, `if-match`, `if-modified-since`, `accept`, `content-type`, `authorization`, `cookie`).
- Passes through upstream response status (specifically `304 Not Modified`) and all upstream headers (`etag`, `cache-control`, `content-type`, `content-length`).
- Handles response streaming via `new Response(upstream.body, { status: upstream.status, headers: outHeaders })`.

### Component 3: Frontend Integration & Visual Verification
- `UploadsIndexRun` in `BrowserShots.tsx` already defines `is_live?`, `needs_human?`, `signal?`, and `browser_state?` as optional.
- Verify `resolveStreamMode(browserState)` handles missing/undefined `browser_state` as `"idle"`.
- Verify `RunShotsIndicator` renders correctly in all three states:
  1. **Idle**: Camera glyph `📷` + count.
  2. **Live**: Flowing blue sheen (`fg-stream-live`), badge `LIVE`, count.
  3. **Red Mode**: Pulsing red outline (`fg-stream-red`), warning glyph `⚠️`, badge `NEEDS KONRAD`, diagnostic tooltip/popover.

---

## Bandwidth Attribution & Before/After Targets

| Endpoint | Before (B/min) | Target After (Cold) | Target After (Steady 304) | Status |
| :--- | :--- | :--- | :--- | :--- |
| `/api/proxy/uploads/index` | **121,374 B/min** (47%) | **~30,600 B/min** (cache miss) | **~300 B/min** (304 hit) | **Target: < 20,000 B/min** |
| `/api/proxy/chat` | 75,410 B/min (29%) | 75,410 B/min | 75,410 B/min | Landed in prior lane |
| `/api/proxy/chat/<id>/team` | 48,670 B/min (19%) | 48,670 B/min | 0 B/min (settled) | Landed in prior lane |
| **TOTAL CONSOLE AT REST** | **260,448 B/min** | **~170,000 B/min** | **~139,000 B/min** | **Net ~47% total reduction** |

---

## Task Decomposition & Workstream Allocation

All tasks run in workstream `"main"`:

### Task 1: Backend Payload Pruning & Cache Invalidation
- **Role**: `builder`
- **Tier**: `junior` (Sonnet)
- **Workstream**: `main`
- **Depends On**: `[]`
- **Write Set**:
  - `forge-control/src/lib/uploads-index.ts`
  - `forge-control/src/lib/uploads-index.test.ts`
- **Brief**:
  1. In `forge-control/src/lib/uploads-index.ts`, update `computeAllRuns()` so idle runs (`!browser_state.is_live && !browser_state.needs_human`) do not serialize `browser_state`, `is_live`, `needs_human`, or `signal`. Only include these fields when a run is actively streaming (`is_live === true`) or blocked/alerting (`needs_human === true`).
  2. Ensure `computeTag()` incorporates `is_live`, `needs_human`, and `signal` into ETag hashing so live state transitions invalidate the cache immediately.
  3. In `forge-control/src/lib/uploads-index.test.ts`, add comprehensive unit tests asserting:
     - Idle runs produce trimmed payloads without `browser_state` or redundant boolean flags.
     - Live and needs_human runs retain complete `browser_state` and flags.
     - ETag is computed deterministically and changes on both file additions and state transitions.
  4. Ensure `cd forge-control && pnpm test` and `npx tsc --noEmit` pass with zero errors.

### Task 2: Next.js Proxy Route Handler & Memory Note
- **Role**: `builder`
- **Tier**: `standard` (Opus)
- **Workstream**: `main`
- **Depends On**: `[]`
- **Write Set**:
  - `forge-control-web/app/api/proxy/[...path]/route.ts`
  - `forge-control-web/next.config.mjs`
- **Brief**:
  1. Create `forge-control-web/app/api/proxy/[...path]/route.ts` as an App Router Route Handler supporting `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD`.
  2. Implement transparent HTTP proxying to `${FORGE_CONTROL_URL}/api/...` preserving:
     - Request headers, specifically `If-None-Match`, `If-Match`, `If-Modified-Since`, `Accept`, `Content-Type`, `Authorization`, `Cookie`.
     - Upstream status codes verbatim (crucially `304 Not Modified`).
     - Upstream response headers (`ETag`, `Cache-Control`, `Content-Type`, `Content-Length`).
     - Request and response streaming (`ReadableStream`).
  3. Clean up `next.config.mjs` rewrites if necessary or verify App Router route handler takes precedence cleanly.
  4. Update fleet memory note `/root/.claude/projects/-opt-forge-ai-os/memory/nextjs-rewrite-cannot-proxy-websockets.md` with findings on rewrite response header stripping and Route Handler solution.
  5. Verify `curl http://127.0.0.1:7701/api/proxy/uploads/index` through `:7701` returns `ETag` and that repeating with `-H 'If-None-Match: <etag>'` returns `HTTP 304`.

### Task 3: Client Integration, Verification Checks & Evidence Harness
- **Role**: `builder`
- **Tier**: `junior` (Sonnet)
- **Workstream**: `main`
- **Depends On**: `[Task 1 ID, Task 2 ID]`
- **Write Set**:
  - `forge-control-web/app/desktop/chat/BrowserShots.tsx`
  - `scripts/checks/check-browser-stream-viewer.ts`
  - `scripts/checks/check-uploads-payload.ts`
  - `docs/plan/artifacts/uploads-index-payload/README.md`
- **Brief**:
  1. Verify `forge-control-web/app/desktop/chat/BrowserShots.tsx` handles trimmed uploads index objects seamlessly for idle, live blue, and red mode runs.
  2. Fix `scripts/checks/check-browser-stream-viewer.ts` line 448 where `TEAM_POLL_MS` was pinned to legacy `6000` (update to `10000` as established in `pollBudget.ts`).
  3. Create `scripts/checks/check-uploads-payload.ts` to measure and assert:
     - Cold uncompressed payload size is < 20 KB (target ~15.3 KB vs legacy 60.7 KB).
     - Steady-state bandwidth at 2 req/min with HTTP 304 is < 500 B/min (>99% reduction).
     - ETag and conditional request matching through `:7701`.
  4. Capture screenshots of the three visual states (idle camera indicator, live blue outline, red mode alert) and document before/after attribution in `docs/plan/artifacts/uploads-index-payload/README.md`.
  5. Ensure `gates-808.sh --strict` runs clean.

### Task 4: Final Adversarial Review & Gating Verification
- **Role**: `reviewer`
- **Tier**: `standard` (Opus)
- **Workstream**: `main`
- **Depends On**: `[Task 3 ID]`
- **Write Set**: `[]`
- **Brief**:
  1. Perform complete adversarial check across all changes from Tasks 1, 2, and 3.
  2. Verify that `GET /api/proxy/uploads/index` through `:7701` returns `ETag` and responds with `304 Not Modified` on `If-None-Match`.
  3. Verify payload size reduction meets DoD (< 20,000 B/min steady-state at rest).
  4. Inspect screenshots in `docs/plan/artifacts/uploads-index-payload/` to confirm zero visual regressions across idle, live blue, and red mode states.
  5. Confirm all gates pass: `npx tsc --noEmit` (both packages), `node scripts/checks/no-raw-colours.cjs`, `pnpm test` (unit suite), and `bash scripts/checks/gates-808.sh --strict`.
