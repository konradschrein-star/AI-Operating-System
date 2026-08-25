# aios-chat-list-etag — plan (round 0)

**Goal.** Reduce the console's chat list poll (`GET /api/chat?limit=30`, currently ~15.2 KB every 10s = ~90 KB/min at rest) to ~0 bytes/min by implementing strong ETag / HTTP 304 Not Modified conditional requests with explicit client-side validator caching, and prove the savings in a real browser.

---

## Recommendation

Implement strong ETag generation and `If-None-Match` validation on `GET /api/chat` in `forge-control`, and pair it with explicit in-memory validator holding and HTTP 304 response merging in `forge-control-web/app/api.ts` (`fetchChatList`).

Reasoning, in order of what drove the design:

1. **Explicit Client Validator Holding is Mandatory.**
   As documented in `/root/.claude/projects/-opt-forge-ai-os/memory/etag-304-needs-an-explicit-client.md`, standard browser `fetch()` delegates revalidation to internal browser HTTP cache heuristics and Next.js `Vary` headers, which fail to send `If-None-Match` on subsequent polls. Explicitly sending `headers["if-none-match"] = cached.etag` guarantees deterministic 304 responses across all browsers and test harnesses.
2. **Validator Saved ONLY After Clean Parse.**
   The client stores `etag` and `data` in memory only after `res.json()` successfully parses and validates the array schema. Storing a validator before validation would cause subsequent 304 responses to serve rejected/malformed bodies indefinitely.
3. **Nginx Weak ETag Transformation Compatibility.**
   In production, nginx gzip transformation rewrites origin strong ETags (`"hash"`) to weak ETags (`W/"hash"`). The server-side ETag validator strips `W/` prefixes and surrounding quotes on both incoming client header and server tag, ensuring seamless 304 matching across reverse proxy tiers.
4. **Zero Row Mutation / Shape Invariance.**
   Row trimming was completed in a previous phase (`trimRailMetadata`). The payload structure (`count`, `runs`, `counts`, `hasMore`) remains byte-for-byte identical on 200 responses; the savings come entirely from eliminating body transfer on unchanged polls.
5. **Deterministic Cache Invalidation.**
   Whenever the database state changes (e.g. new chat created, new message arrived, status changed, archived, deleted), `listRuns` or `runCounts` outputs different values. The computed SHA-1 hash changes immediately, causing the server to return HTTP 200 with the new body and new ETag on the next poll/invalidation tick.

### Rejected Alternatives (one line each):
- *Rely on browser HTTP caching without explicit client headers* — Fails in practice; `fetch()` without explicit `If-None-Match` does not send the validator.
- *Re-trim chat list fields* — Rejected; rows are already lean (~290 B metadata per row), the primary win is conditional 304 caching.
- *In-memory server database cache table* — Rejected; computing SHA-1 over the JSON-serialized response takes <0.05ms and avoids cache synchronization bugs.

---

## What Owns State, What Dispatches, What Happens on Failure

| Concern | Owner |
| --- | --- |
| ETag Computation | `forge-control/src/routes/chat.ts` (`forge-control/src/lib/chat-etag.ts`) via SHA-1 over serialized payload |
| Header Passing | `forge-control-web/app/api/proxy/[...path]/proxy-handler.ts` forwards `If-None-Match`, `ETag`, `Cache-Control`, 304 status |
| Client Validator Cache | `forge-control-web/app/api.ts` in-memory `chatListCache` Map keyed by request path |
| Cache Invalidation on Mutation | Database state change naturally updates SHA-1 hash; React Query invalidation triggers immediate re-fetch |
| Browser Measurement & Proof | `scripts/checks/check-chat-list-etag-browser.ts` running real headless Chromium via Playwright |

### Failure Modes & Diagnosis:
- **Server 500 / DB Error:** Route handler errors throw 500; client does not update cache and propagates error to React Query error state.
- **Malformed Response:** `fetchChatList` validates payload before setting ETag; malformed responses throw immediately and do not poison the cached validator.
- **Nginx Weak ETag Rewriting:** Handled transparently by prefix-stripping matching logic.
- **Konrad Visibility:** Console chat list displays instantly; failures log to browser console and error toasts.

---

## Workstreams and Task Graph

```
[server]   Task 1: Server conditional ETag & 304 (chat.ts, chat-etag.ts, chat-etag.test.ts)
[client]   Task 2: Client explicit ETag & 304 cache (api.ts, api.test.ts)                   ──► Task 4: Integration (merge branches, guard, test) ──► Task 5: Reviewer
[harness]  Task 3: Harness & Browser measurement (check-chat-list-etag*.ts)
```

### Workstream 1: `server`
- **Task 1** (`builder`, tier: `junior`, workstream: `server`, `depends_on: []`):
  - **Title:** Server: conditional ETag and 304 support for GET /api/chat
  - **Write Set:** `forge-control/src/routes/chat.ts`, `forge-control/src/lib/chat-etag.ts`, `forge-control/src/lib/chat-etag.test.ts`
  - **Brief:** Implement strong ETag computation (SHA-1) and `If-None-Match` validation supporting both strong and weak (`W/`) tags on `GET /api/chat`. Return `304 Not Modified` with null body when tag matches, or `200 OK` with `ETag` and `Cache-Control: no-cache` on cold/mismatched requests. Add unit and route tests.

### Workstream 2: `client`
- **Task 2** (`builder`, tier: `junior`, workstream: `client`, `depends_on: []`):
  - **Title:** Client: explicit ETag holding and 304 handling in fetchChatList
  - **Write Set:** `forge-control-web/app/api.ts`, `forge-control-web/app/api.test.ts`
  - **Brief:** Update `fetchChatList` in `forge-control-web/app/api.ts` to manage in-memory validator map keyed by path, explicitly send `if-none-match` header, return cached rows on 304, and store validator only after clean parse. Export `clearChatListCache` for testing. Add unit tests for initial 200, 304 repeat, and cache update on change.

### Workstream 3: `harness`
- **Task 3** (`builder`, tier: `junior`, workstream: `harness`, `depends_on: []`):
  - **Title:** Harness: check-chat-list-etag verification and browser measurement suite
  - **Write Set:** `scripts/checks/check-chat-list-etag.ts`, `scripts/checks/check-chat-list-etag-browser.ts`
  - **Brief:** Create unit verification and real Playwright browser measurement harnesses. Verify cold GET (200), conditional GET (304), weak tag handling, steady-state poll at rest (0 B/min payload bytes), screenshot capture to `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-chat-list-etag.png` and read back, and JSON evidence emission.

### Workstream 4: `main` (Integration & Review)
- **Task 4** (`builder`, tier: `junior`, workstream: `main`, `depends_on: [Task 1, Task 2, Task 3]`):
  - **Title:** Integration: merge server, client, and harness workstreams to main
  - **Write Set:** `forge-control/src/routes/chat.ts`, `forge-control/src/lib/chat-etag.ts`, `forge-control/src/lib/chat-etag.test.ts`, `forge-control-web/app/api.ts`, `forge-control-web/app/api.test.ts`, `scripts/checks/check-chat-list-etag.ts`, `scripts/checks/check-chat-list-etag-browser.ts`, `docs/plan/artifacts/aios-chat-list-etag/README.md`, `docs/plan/artifacts/aios-chat-list-etag/measurement.json`
  - **Brief:** Merge `server`, `client`, and `harness` worktree branches into main worktree branch. Run `pnpm install --frozen-lockfile --prod=false`, run `guard.sh --fast`, execute verification harnesses and browser measurement, read back screenshots, and write evidence report.
- **Task 5** (`reviewer`, tier: `standard`, workstream: `main`, `depends_on: [Task 4]`):
  - **Title:** Review: aios-chat-list-etag implementation and browser evidence verification
  - **Write Set:** `[]`
  - **Brief:** Review diff against requirements: verify 304 response matching, explicit client header passing, merge correctness, unmodified payload structure, green guard checks, and real-browser proof of ~0 B/min steady-state payload at rest.
