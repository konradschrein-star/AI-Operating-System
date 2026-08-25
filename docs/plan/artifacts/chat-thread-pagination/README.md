# Chat Thread Pagination — Verification Suite & Acceptance Evidence

Project `aios-chat-thread-pagination`, round 2 (verification only — the server
and client changes were built and committed in round 1: `0ad4ab9`, `8f80e73`,
`e56be04`). This document is the acceptance evidence for the goal stated in the
brief: **the desktop chat must never ship more than a bounded window of turns,
a poll that has seen everything must ship ~0 bytes of thread, and the CLIENT
must actually use it — not just the server.**

## Why two measurement harnesses

- `scripts/checks/check-chat-delta.ts` — 156 assertions, pure functions and
  in-process router calls. Fast, deterministic, exhaustive on edge cases
  (cursor parsing, stale-cursor recovery, cache-merge reference identity,
  full backward-walk sequence integrity). No browser.
- `scripts/checks/check-chat-pagination-browser.ts` — real headless Chrome via
  Playwright, in two parts:
  - **Part A (server contract):** the page scripts `fetch()` calls directly at
    the worktree's own chat router, mounted in-process against real production
    DB rows. Proves the server behaves under real HTTP framing.
  - **Part B (real client, real network):** the page loads the *actual*
    forge-control-web `/desktop` app (`next dev`, real React code, real
    `fetchChatDelta`/`fetchChatOlder` in `app/api.ts`, real TanStack Query poll
    loop), pointed at the same worktree router through the real
    `app/api/proxy/[...path]/route.ts` handler. `page.on("response")` observes
    exactly the bytes the app's own code asked for; nothing in the harness
    chooses a `since` or `before` value.

Part B exists specifically because of a prior failure mode recorded in the
fleet's memory
(`etag-304-needs-an-explicit-client.md`): a previous payload-reduction project
built a correct server-side ETag and reported ">99.8% saved" — measured with
`curl`. The real browser never sent `If-None-Match`, and the saving was zero
in practice. "The server is correct" and "the client uses it" are different
claims, and only Part B proves the second one. Part A alone would have been
exactly the kind of measurement that memory note warns against.

**Methodology note — SSE deliberately blocked in Part B.** The probe backing
Part B answers `GET /api/chat/:id/events` with a hard 404 rather than serving
or proxying it. `useRunEvents.ts`'s `EventSource.onerror` then sets `live:
false` immediately, which is the app's own documented path into its 4s
fallback poll (`CHAT_DETAIL_FALLBACK_POLL_MS`) instead of the 20s live-stream
cadence (`CHAT_DETAIL_LIVE_POLL_MS`). This makes the observation window
deterministic (several polls inside 26s instead of needing 60–90s to catch two
20s cycles) and it is the *more conservative* of the app's two real cadences —
if the delta is small at 4s, it is smaller still at 20s. The 20s/live and
4s/fallback constants themselves, and the ≤40 req/min ceiling both cadences
must respect, are contract-tested directly against their real values in
`check-chat-delta.ts` §5a/5b.

## Before vs after — measured

"Before" is the legacy behaviour computed directly from each chat's real
`runs.thread` row (what `GET /api/chat/:id` used to return in full, no
pagination). "After" columns marked **(real app)** are Part B: bytes actually
observed leaving the real `/desktop` client's own fetch calls, not scripted.

### Chat `11dd264b` (2,477 turns, ~2.53 MB thread)

| Measurement | Before (legacy full fetch) | After |
|---|---|---|
| Initial load, decoded | 2,528,262 B (2,469 KB) | **85,222 B (83.2 KB)** — real app, 60 turns |
| Initial load, gzip (Part A, scripted) | 550,495 B (537.6 KB) | 20,879 B (20.4 KB) |
| Steady-state poll, decoded | 2,528,262 B (whole thread re-sent) | **1,696 B** — real app, 6/6 polls, `thread: []`, prompt omitted |
| Steady-state poll, gzip (Part A, scripted) | 550,495 B | 813 B |
| Backward page ("show 60 older"), decoded | n/a (no pagination existed) | **74,621 B** — real app, 60 turns, prompt omitted |
| Rest rate, 4s-fallback cadence | 36.17 MB/min | **22.93 KB/min** — real app, observed over 26s |

Initial-load reduction: **96.6%** decoded / 96.2% gzip. Steady-state
reduction: **99.93%** decoded / 99.85% gzip. Rest-rate reduction at the
(worse-case) 4s cadence: **99.94%**.

### Chat `ece63bdb` (1,911 turns, ~2.12 MB thread)

| Measurement | Before (legacy full fetch) | After |
|---|---|---|
| Initial load, decoded | 2,116,650 B (2,067 KB) | **65,396 B (63.9 KB)** — real app, 60 turns |
| Initial load, gzip (Part A, scripted) | 491,447 B (479.9 KB) | 13,897 B (13.6 KB) |
| Steady-state poll, decoded | 2,116,650 B (whole thread re-sent) | **958 B** — real app, 6/6 polls, `thread: []`, prompt omitted |
| Steady-state poll, gzip (Part A, scripted) | 491,447 B | 605 B |
| Backward page ("show 60 older"), decoded | n/a | **84,026 B** — real app, 60 turns, prompt omitted |
| Rest rate, 4s-fallback cadence | 30.28 MB/min | **12.95 KB/min** — real app, observed over 26s |

Initial-load reduction: **96.9%** decoded / 97.2% gzip. Steady-state
reduction: **99.95%** decoded / 99.88% gzip. Rest-rate reduction: **99.96%**.

Full machine-readable evidence, including per-poll byte sizes and both parts'
raw numbers: [`chat-pagination-browser.json`](./chat-pagination-browser.json)
(`verdict: PASS`, `failures: 0`).

**Why Part A's gzip numbers are the ones quoted for compression, not Part B's.**
gzip on the real deployment happens at nginx in front of `:7700`; the `next
dev` + in-process-router probe behind Part B has no nginx hop, so its wire
bytes are the same as its decoded bytes. Part A talks to the same worktree
router directly with `Accept-Encoding` honoured, and its gzip figures are real
compressed bytes, not an estimate — they are quoted here as the compression
number because they are measured, not because Part B's number is worse. Part
B's contribution is the decoded byte count and, more importantly, that the
real client requested this shape at all.

## Acceptance checklist (brief's 3 deliverables)

1. **"The chat endpoint must never ship more than a bounded window of turns by
   default, and a poll that has seen everything must ship ~0 bytes of
   thread."**
   PASS. Part A + Part B both confirm: initial load is bounded to the newest
   60 turns regardless of total thread length (2,477 and 1,911 turns alike);
   every one of 12 observed real-client steady-state polls across both chats
   carried `thread: []` and omitted `prompt` (658–1,696 B, not "~0" in the
   literal-zero sense because the envelope itself — `id`, `status`,
   `updated_at`, etc. — still has to travel, but 99.93%+ below the legacy
   full-thread payload).
2. **"The client must actually use it."**
   PASS — this is what Part B is *for*. All 24 Part-B assertions passed
   against real, unscripted network traffic from the real `/desktop` app: the
   initial request, all 6 steady polls per chat, and the real "show older"
   button's own fetch.
3. **"Opening an old chat must still render its full history — pagination,
   not truncation. Scrolling back must load older turns."**
   PASS. `check-chat-delta.ts` §2 proves a full backward walk from `from=100`
   down to `from=0` reconstructs all 578 fixture messages with zero gaps and
   zero duplicates. Part B proves the same mechanism end-to-end in the real
   UI: clicking the real app's own "show 60 older" button fetched a real
   `before`-paginated response (60 more turns, prompt correctly omitted) for
   both `11dd264b` and `ece63bdb`.

## What was NOT touched

Per the brief: nothing here changes what the chat renders, drops turns from
storage, or touches the uploads/team/plan endpoints. `check-chat-delta.ts` §7
re-asserts the uploads-index ETag contract is unaffected as a drift guard, not
because this round changed it.

## Reproduction

```bash
cd forge-control && pnpm install --frozen-lockfile --prod=false   # tsx/typescript are devDependencies
cd forge-control-web && pnpm install --frozen-lockfile --prod=false

cd forge-control
./node_modules/.bin/tsx ../scripts/checks/check-chat-delta.ts
./node_modules/.bin/tsx ../scripts/checks/check-chat-pagination-browser.ts   # ~2 min: starts a throwaway
                                                                              # `next dev`, mints a session
                                                                              # cookie, drives real Chrome,
                                                                              # cleans up after itself
```

Both exit non-zero on any failure. `check-chat-pagination-browser.ts` also
(re)writes `chat-pagination-browser.json` in this directory on every run.

## Gates

`bash scripts/checks/gates-808.sh --strict` — repo-wide gate suite (typecheck
both packages, production build, unit suite, and every project-specific
check). See the run's own log for the current pass/fail table; this project
added no new gate, only the two check scripts above and this document.

## Round 4 fix cycle (reviewer findings)

1. **Race condition — backward pagination clobbered by a concurrent delta
   poll.** `fetchChatDelta` (`forge-control-web/app/api.ts`) used to capture
   `prev` once, before the network round trip, then build its return value
   — which React Query commits verbatim as the new cache entry — from that
   closure-captured snapshot. `AssistantThread`'s `handleShowOlder`/
   `handleShowAll` write to the same `["chat","run",id]` cache key
   synchronously mid-flight (`qc.setQueryData`), and a poll response landing
   after that write silently overwrote the just-prepended older turns and
   the moved cursor. Fixed by making `fetchChatDelta`'s second argument a
   thunk (`getPrev: () => RunDetail | undefined`) invoked twice: once before
   the request (to size the `since` cursor) and again right after the
   response lands, to merge against whatever is in the cache at that moment
   instead of the stale snapshot. All five call sites
   (`ChatSurface.tsx`, `ProjectsSurface.tsx` ×2, `MentorAgentDeck.tsx`,
   `AgentChatView.tsx`) were updated to pass a thunk. Regression test:
   `check-chat-delta.ts` §8 drives the real `fetchChatDelta` (not a stand-in)
   against a hand-controlled `fetch` mock that mutates the cache mid-flight,
   reproducing the exact interleaving; verified to fail against the
   pre-fix code before confirming it passes against the fix.
2. **Undeclared write — `chat-pagination-browser.json`.** Accepted as a
   generated-artifact exception rather than a write_set correction: the
   file is the browser harness's own evidence output, rewritten by
   `check-chat-pagination-browser.ts` on every single run (documented above,
   "Reproduction"). It is a side effect of running an already-declared file,
   not independently authored content — the same category as a coverage
   report or a screenshot a check script saves. No project_tasks row edit
   was made from this build task, in keeping with the worktree-only policy
   (live-DB writes belong to a briefed deploy/verify task).
3. **Minor — `fae58daa` over-declared `ChatSurface.tsx`.** Bookkeeping-only,
   noted here for the record; no code change needed (over-declaring a file
   that was never written is not a hazard).
4. **`chat.ts:1551`'s hardcoded SSE snapshot window (`60`) now shares
   `DEFAULT_CHAT_WINDOW`** with `parseLimitParam`'s default, so the two
   paths cannot drift apart on a future change.
