/**
 * check-chat-delta.ts — verification measurement harness for chat delta synchronization,
 * bounded window fetching, backward pagination, and payload reduction.
 *
 * Project: aios-chat-thread-pagination (and aios-chat-delta-prompt)
 *
 * This check verifies:
 *  1. Backend Delta & Pagination Query Contract (forge-control /api/chat/:id):
 *     - parseSinceParam: parses non-negative integer strings, rejects invalid/negative/fractional.
 *     - parseBeforeParam: parses non-negative integer strings, rejects invalid/negative/fractional.
 *     - parseLimitParam: parses positive integer strings, clamps to maxLimit (500), defaults to 60.
 *     - chatDeltaResponse:
 *       - Initial bounded load (since & before omitted): returns newest window [total - limit, total) with prompt (< 30 KB).
 *       - Steady-state delta (since === total): returns empty thread slice [] and omits prompt (< 2 KB).
 *       - Incremental delta (since < total): returns slice [since, total) and omits prompt.
 *       - Backward pagination (?before=<idx>&limit=<n>): returns slice [max(0, before - limit), before) and omits prompt.
 *       - Recovery fallback (since > total or malformed): recovers to bounded newest window with prompt.
 *  2. Frontend Delta Merging & Reference Identity (forge-control-web fetchChatDelta & fetchChatOlder):
 *     - Retains exact thread array reference on empty delta (0 React re-renders / 0 DOM thrash).
 *     - Preserves cached prompt across >= 4 consecutive delta polls when prompt is omitted over the wire.
 *     - Appends new entries cleanly when incremental messages arrive, preserving prompt and updating tail.
 *     - Prepends older historical slices on backward pagination, maintaining total integrity across multi-page walk.
 *     - Recovers to replacement snapshot on cursor mismatch (e.g. compacted thread).
 *  3. Payload Reduction Measurements:
 *     - Production baseline (103 entries w/ 10 KB prompt): ~86% steady-state delta payload reduction.
 *     - Medium thread (576 entries w/ 10 KB prompt): > 98% steady-state reduction.
 *     - Large production chat (2,477 entries matching 11dd264b): 2.53 MB legacy -> ~24 KB bounded initial (< 30 KB, > 99% cut),
 *       ~1.6 KB steady-state delta (< 2 KB, > 99.9% cut), and ~18 KB backward page.
 *  4. Chat Surface Poll Budget Calculations:
 *     - Healthy steady state (SSE live): 19 req/min (≤ 40 req/min ceiling).
 *     - Degraded fallback state (SSE down): 32 req/min (≤ 40 req/min ceiling).
 *  5. Team Tree Settled Backoff & Uploads Index ETag Support:
 *     - isTreeSettled: backs off when all tree nodes (manager, workers, subagents) are settled.
 *     - Uploads Index: supports ETag caching tag computation for conditional polling.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-delta.ts
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-delta.ts
 */

import { gzipSync } from "node:zlib";
import {
  parseSinceParam,
  parseBeforeParam,
  parseLimitParam,
  chatDeltaResponse,
} from "../../forge-control/src/routes/chat.ts";
import type { RunDelta, ChatQueryParams } from "../../forge-control/src/routes/chat.ts";
import type { RunDetail, ThreadEntry } from "../../forge-control/src/db/runs.ts";
import { getUploadsCacheTag, listAllRuns } from "../../forge-control/src/lib/uploads-index.ts";
import { fetchChatDelta, type RunDetail as ApiRunDetail } from "../../forge-control-web/app/api.ts";
import { isTreeSettled } from "../../forge-control-web/app/desktop/team/ChatTeamPanel.tsx";
import type { TeamNode, TeamResponse } from "../../forge-control-web/app/desktop/team/teamApi.ts";
import {
  AGENTS_POLL_MS,
  CHAT_DETAIL_FALLBACK_POLL_MS,
  CHAT_DETAIL_LIVE_POLL_MS,
  CHAT_LIST_POLL_MS,
  CHAT_SURFACE_REQ_PER_MIN_CEILING,
  PLAN_POLL_MS,
  SHOTS_INDEX_POLL_MS,
  SIDEBAR_AGENTS_POLL_MS,
  TEAM_POLL_MS,
} from "../../forge-control-web/app/desktop/chat/pollBudget.ts";
import {
  SECRETS_FALLBACK_POLL_MS,
  secretsPollInterval,
} from "../../forge-control-web/app/desktop/chat/secretLive.ts";
/* The sidebar scope toggle's own predicate — the one ChatSurface arms the fleet
 * feed's query from. Section 5b spends it, and check-sidebar-scope.ts owns the
 * rest of that module's behaviour. */
import {
  SIDEBAR_SCOPE_DEFAULT,
  scopePolls,
} from "../../forge-control-web/app/desktop/team/sidebar-scope.ts";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

function checkTrue(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function makeEntry(role: "user" | "assistant" | "system", content: string, ts: string): ThreadEntry {
  return { role, content, ts };
}

function makeFixtureRun(threadLength = 3, prompt = "Coordinate system updates and manage tasks"): RunDetail {
  const thread: ThreadEntry[] = [];
  for (let i = 0; i < threadLength; i++) {
    thread.push(
      makeEntry(
        i % 2 === 0 ? "user" : "assistant",
        `Message ${i}: This is a sample message content with some realistic payload details.`,
        new Date(1724457600000 + i * 1000).toISOString(),
      ),
    );
  }

  return {
    id: "2ef126b7-d6d9-4a55-a8e7-d9acf0508645",
    title: "manager chat fixture",
    status: "running",
    worker: "claude",
    budget_usd: "10.00",
    spent_usd: "1.25",
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:10:00.000Z",
    last_heartbeat_at: "2026-08-24T00:10:00.000Z",
    message_count: threadLength,
    last_message_preview: threadLength > 0 ? thread[threadLength - 1].content.slice(0, 50) : "",
    last_role: threadLength > 0 ? thread[threadLength - 1].role : "",
    archived: false,
    metadata: { manager: true, channel: "desktop" },
    prompt,
    thread,
    parent_run_id: null,
    stuck_signal: null,
    started_at: "2026-08-24T00:00:00.000Z",
    completed_at: null,
  };
}

export type ClientRunDetail = RunDetail & { from?: number; total?: number };

/** Pure merge helper matching fetchChatDelta in forge-control-web/app/api.ts */
function mergeChatDelta(
  prev: ClientRunDetail | undefined,
  deltaResponse: { run: RunDelta | RunDetail; from: number; total: number },
): ClientRunDetail {
  if (prev === undefined) return { ...(deltaResponse.run as RunDetail), from: deltaResponse.from, total: deltaResponse.total };
  const tail = (prev.from ?? 0) + prev.thread.length;
  const { run, from, total } = deltaResponse;
  if (from !== tail) return { ...(run as RunDetail), from, total };
  const prompt =
    "prompt" in run && run.prompt !== undefined ? run.prompt : prev.prompt;
  const thread =
    run.thread.length === 0 ? prev.thread : [...prev.thread, ...run.thread];
  return { ...prev, ...run, prompt, thread, from: prev.from ?? 0, total };
}

/** Pure merge helper matching AssistantThread.tsx older turns prepending */
function mergeChatOlder(
  prev: ClientRunDetail,
  olderResponse: { run: RunDelta; from: number; total: number },
): ClientRunDetail {
  const { run: olderRun, from, total } = olderResponse;
  const prompt =
    "prompt" in olderRun && olderRun.prompt !== undefined ? olderRun.prompt : prev.prompt;
  return {
    ...prev,
    ...olderRun,
    thread: [...olderRun.thread, ...prev.thread],
    from,
    total,
    prompt,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 1: Query String Parsing & Validation
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 1a. parseSinceParam: query string parsing & validation ────────────");

check("since: undefined query parameter -> undefined", parseSinceParam(undefined), undefined);
check("since: empty string -> undefined", parseSinceParam(""), undefined);
check("since: valid zero '0' -> 0", parseSinceParam("0"), 0);
check("since: valid positive integer '576' -> 576", parseSinceParam("576"), 576);
check("since: valid positive integer '2477' -> 2477", parseSinceParam("2477"), 2477);
check("since: negative integer '-5' -> undefined (recovery)", parseSinceParam("-5"), undefined);
check("since: fractional number '12.34' -> undefined (recovery)", parseSinceParam("12.34"), undefined);
check("since: non-numeric string 'foo' -> undefined (recovery)", parseSinceParam("foo"), undefined);
check("since: NaN -> undefined (recovery)", parseSinceParam("NaN"), undefined);
check("since: Infinity -> undefined (recovery)", parseSinceParam("Infinity"), undefined);

console.log("\n── 1b. parseBeforeParam: query string parsing & validation ───────────");

check("before: undefined query parameter -> undefined", parseBeforeParam(undefined), undefined);
check("before: empty string -> undefined", parseBeforeParam(""), undefined);
check("before: valid zero '0' -> 0", parseBeforeParam("0"), 0);
check("before: valid positive integer '2417' -> 2417", parseBeforeParam("2417"), 2417);
check("before: negative integer '-1' -> undefined", parseBeforeParam("-1"), undefined);
check("before: fractional number '50.5' -> undefined", parseBeforeParam("50.5"), undefined);
check("before: non-numeric string 'old' -> undefined", parseBeforeParam("old"), undefined);

console.log("\n── 1c. parseLimitParam: query string parsing, default & clamp ────────");

check("limit: undefined -> default 60", parseLimitParam(undefined), 60);
check("limit: empty string -> default 60", parseLimitParam(""), 60);
check("limit: custom default 30 -> 30", parseLimitParam(undefined, 30), 30);
check("limit: valid positive '100' -> 100", parseLimitParam("100"), 100);
check("limit: zero '0' -> default 60 (rejected)", parseLimitParam("0"), 60);
check("limit: negative '-10' -> default 60 (rejected)", parseLimitParam("-10"), 60);
check("limit: fractional '25.5' -> default 60 (rejected)", parseLimitParam("25.5"), 60);
check("limit: non-numeric 'all' -> default 60 (rejected)", parseLimitParam("all"), 60);
check("limit: exceeds maxLimit 500 clamped to 500", parseLimitParam("1000", 60, 500), 500);
check("limit: custom maxLimit 200 clamped to 200", parseLimitParam("350", 60, 200), 200);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 2: Backend Delta, Bounded Window & Pagination Response Logic
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 2. chatDeltaResponse: server delta slicing & pagination ───────────");

const runFixture5 = makeFixtureRun(5);

// 1. Small run initial load (since & before omitted): from === 0, total === 5, prompt present
const smallInitResp = chatDeltaResponse(runFixture5, undefined);
check("small run initial load: from === 0", smallInitResp.from, 0);
check("small run initial load: total === 5", smallInitResp.total, 5);
check("small run initial load: thread length === 5", smallInitResp.run.thread.length, 5);
checkTrue("small run initial load: prompt is present", "prompt" in smallInitResp.run);
check("small run initial load: prompt matches fixture", (smallInitResp.run as RunDetail).prompt, runFixture5.prompt);

// 2. Large run initial load (total = 100, limit = 60 default): from === 40, returns newest 60 entries with prompt
const runFixture100 = makeFixtureRun(100);
const largeInitResp = chatDeltaResponse(runFixture100, {});
check("large run initial load: from === 40 (Math.max(0, 100 - 60))", largeInitResp.from, 40);
check("large run initial load: total === 100", largeInitResp.total, 100);
check("large run initial load: thread length === 60 (bounded window)", largeInitResp.run.thread.length, 60);
check("large run initial load: first item is index 40", largeInitResp.run.thread[0].content, runFixture100.thread[40].content);
check("large run initial load: last item is index 99", largeInitResp.run.thread[59].content, runFixture100.thread[99].content);
checkTrue("large run initial load: prompt is present in initial envelope", "prompt" in largeInitResp.run);
check("large run initial load: prompt matches fixture", (largeInitResp.run as RunDetail).prompt, runFixture100.prompt);

// 3. Custom limit on initial load (limit = 20): from === 80, returns 20 entries
const customLimitInitResp = chatDeltaResponse(runFixture100, { limit: 20 });
check("custom limit initial load: from === 80", customLimitInitResp.from, 80);
check("custom limit initial load: thread length === 20", customLimitInitResp.run.thread.length, 20);

// 4. Steady-state delta poll (since === total): from === 100, empty thread, prompt omitted
const emptyDeltaResp = chatDeltaResponse(runFixture100, 100);
check("steady-state delta (since === total): from === 100", emptyDeltaResp.from, 100);
check("steady-state delta (since === total): total === 100", emptyDeltaResp.total, 100);
check("steady-state delta (since === total): thread is empty []", emptyDeltaResp.run.thread, []);
checkTrue("steady-state delta: prompt is omitted over wire", !("prompt" in emptyDeltaResp.run));
check("steady-state delta: prompt is undefined", emptyDeltaResp.run.prompt, undefined);

// 5. Incremental forward delta poll (since < total, e.g. since = 98): from === 98, returns 2 new items, prompt omitted
const appendDeltaResp = chatDeltaResponse(runFixture100, { since: 98 });
check("incremental delta (since < total): from === 98", appendDeltaResp.from, 98);
check("incremental delta (since < total): total === 100", appendDeltaResp.total, 100);
check("incremental delta (since < total): returns slice of 2 new items", appendDeltaResp.run.thread.length, 2);
check("incremental delta: first item is index 98", appendDeltaResp.run.thread[0].content, runFixture100.thread[98].content);
check("incremental delta: second item is index 99", appendDeltaResp.run.thread[1].content, runFixture100.thread[99].content);
checkTrue("incremental delta: prompt is omitted over wire", !("prompt" in appendDeltaResp.run));

// 6. Backward pagination (?before=40&limit=60): from === 0, returns older slice [0, 40), prompt omitted
const backwardPage1 = chatDeltaResponse(runFixture100, { before: 40, limit: 60 });
check("backward pagination (?before=40&limit=60): from === 0", backwardPage1.from, 0);
check("backward pagination: total === 100", backwardPage1.total, 100);
check("backward pagination: thread length === 40 (clamped to start 0)", backwardPage1.run.thread.length, 40);
check("backward pagination: first item is index 0", backwardPage1.run.thread[0].content, runFixture100.thread[0].content);
check("backward pagination: last item is index 39", backwardPage1.run.thread[39].content, runFixture100.thread[39].content);
checkTrue("backward pagination: prompt is omitted over wire", !("prompt" in backwardPage1.run));

// 7. Backward pagination middle slice (?before=80&limit=30): from === 50, returns [50, 80)
const backwardMiddle = chatDeltaResponse(runFixture100, { before: 80, limit: 30 });
check("backward pagination middle slice: from === 50", backwardMiddle.from, 50);
check("backward pagination middle slice: thread length === 30", backwardMiddle.run.thread.length, 30);
check("backward pagination middle slice: first item is index 50", backwardMiddle.run.thread[0].content, runFixture100.thread[50].content);
check("backward pagination middle slice: last item is index 79", backwardMiddle.run.thread[29].content, runFixture100.thread[79].content);

// 8. Backward pagination boundary clamping: before <= 0
const backwardZero = chatDeltaResponse(runFixture100, { before: 0, limit: 60 });
check("backward pagination with before=0: from === 0", backwardZero.from, 0);
check("backward pagination with before=0: returns empty thread []", backwardZero.run.thread, []);

// 9. Stale cursor / compaction recovery fallback (since > total, e.g. since = 999 on 100 total):
// Server safely recovers to bounded newest window WITH prompt
const staleRecoveryResp = chatDeltaResponse(runFixture100, 999);
check("stale cursor recovery (since > total): from === 40 (bounded window)", staleRecoveryResp.from, 40);
check("stale cursor recovery: total === 100", staleRecoveryResp.total, 100);
check("stale cursor recovery: thread length === 60", staleRecoveryResp.run.thread.length, 60);
checkTrue("stale cursor recovery: prompt is included in recovery snapshot", "prompt" in staleRecoveryResp.run);
check("stale cursor recovery: prompt matches fixture", (staleRecoveryResp.run as RunDetail).prompt, runFixture100.prompt);

// 10. Envelope metadata preserved across delta and pagination responses
const deltaEnvelope = appendDeltaResp.run;
check("delta envelope preserves run.id", deltaEnvelope.id, runFixture100.id);
check("delta envelope preserves run.title", deltaEnvelope.title, runFixture100.title);
check("delta envelope preserves run.status", deltaEnvelope.status, runFixture100.status);
check("delta envelope preserves run.worker", deltaEnvelope.worker, runFixture100.worker);
check("delta envelope preserves run.budget_usd", deltaEnvelope.budget_usd, runFixture100.budget_usd);
check("delta envelope preserves run.spent_usd", deltaEnvelope.spent_usd, runFixture100.spent_usd);
check("delta envelope preserves run.message_count", deltaEnvelope.message_count, runFixture100.message_count);
check("delta envelope preserves run.metadata", deltaEnvelope.metadata, runFixture100.metadata);

// 11. Immutability verification
const beforeThreadRef = runFixture100.thread;
const beforePromptVal = runFixture100.prompt;
chatDeltaResponse(runFixture100, { before: 50, limit: 20 });
checkTrue("original run.thread is never mutated", runFixture100.thread === beforeThreadRef);
check("original run.prompt is never mutated", runFixture100.prompt, beforePromptVal);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 3: Frontend Client Cache Merging, Reference Identity & Pagination Walk
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 3. Client cache merging, reference identity & backward pagination ─");

// Initial bounded open of 576-message chat (limit = 60 default)
const initial576Server = makeFixtureRun(576, "Initial prompt brief for run 2ef126b7");
const initial576Resp = chatDeltaResponse(initial576Server, {}); // from = 516, total = 576, len = 60, prompt included
const clientCache0 = mergeChatDelta(undefined, initial576Resp);

check("initial bounded load: client cache has 60 entries", clientCache0.thread.length, 60);
check("initial bounded load: from === 516", clientCache0.from, 516);
check("initial bounded load: total === 576", clientCache0.total, 576);
check("initial bounded load: prompt is cached", clientCache0.prompt, initial576Server.prompt);

// Poll 1 (steady-state empty delta): tail = 516 + 60 = 576. Server sends 0 items, prompt omitted.
const deltaPoll1 = chatDeltaResponse(initial576Server, (clientCache0.from ?? 0) + clientCache0.thread.length);
checkTrue("poll 1 delta omits prompt over wire", !("prompt" in deltaPoll1.run));
const clientCache1 = mergeChatDelta(clientCache0, deltaPoll1);
check("poll 1 maintains message count 60", clientCache1.thread.length, 60);
check("poll 1 preserves cached prompt", clientCache1.prompt, initial576Server.prompt);
check("poll 1 preserves from === 516", clientCache1.from, 516);
checkTrue(
  "poll 1 preserves EXACT array reference (0 React re-renders / 0 DOM thrash)",
  clientCache1.thread === clientCache0.thread,
  "Thread array reference changed on poll 1 despite 0 new messages",
);

// Poll 2 (steady-state empty delta): consecutive poll 2 -> prompt survives, array ref preserved
const deltaPoll2 = chatDeltaResponse(initial576Server, (clientCache1.from ?? 0) + clientCache1.thread.length);
const clientCache2 = mergeChatDelta(clientCache1, deltaPoll2);
check("poll 2 preserves cached prompt", clientCache2.prompt, initial576Server.prompt);
checkTrue("poll 2 preserves EXACT array reference", clientCache2.thread === clientCache1.thread);

// Poll 3 (steady-state empty delta): consecutive poll 3 -> prompt survives, array ref preserved
const deltaPoll3 = chatDeltaResponse(initial576Server, (clientCache2.from ?? 0) + clientCache2.thread.length);
const clientCache3 = mergeChatDelta(clientCache2, deltaPoll3);
check("poll 3 preserves cached prompt", clientCache3.prompt, initial576Server.prompt);
checkTrue("poll 3 preserves EXACT array reference", clientCache3.thread === clientCache2.thread);

// Poll 4 (steady-state empty delta): consecutive poll 4 -> prompt survives across >= 4 polls
const deltaPoll4 = chatDeltaResponse(initial576Server, (clientCache3.from ?? 0) + clientCache3.thread.length);
const clientCache4 = mergeChatDelta(clientCache3, deltaPoll4);
check("poll 4 preserves cached prompt across >= 4 consecutive polls", clientCache4.prompt, initial576Server.prompt);
checkTrue("prompt survives across >= 4 consecutive delta polls", clientCache4.prompt === initial576Server.prompt);

// Forward incremental delta: 2 new messages arrive on server (total = 578)
const expanded578Server: RunDetail = {
  ...initial576Server,
  thread: [
    ...initial576Server.thread,
    makeEntry("user", "New message 576", "2026-08-24T00:10:01.000Z"),
    makeEntry("assistant", "New message 577", "2026-08-24T00:10:02.000Z"),
  ],
  message_count: 578,
  spent_usd: "1.45",
};
const incTail = (clientCache4.from ?? 0) + clientCache4.thread.length; // 516 + 60 = 576
const incDeltaResp = chatDeltaResponse(expanded578Server, incTail); // returns 2 items [576, 578)
checkTrue("incremental forward delta omits prompt over wire", !("prompt" in incDeltaResp.run));
const clientCacheWithInc = mergeChatDelta(clientCache4, incDeltaResp);
check("incremental merge increases cached thread from 60 to 62", clientCacheWithInc.thread.length, 62);
check("incremental merge preserves from === 516", clientCacheWithInc.from, 516);
check("incremental merge updates total to 578", clientCacheWithInc.total, 578);
check("incremental merge preserves prompt in cache", clientCacheWithInc.prompt, initial576Server.prompt);
check("incremental merge contains appended message 576", clientCacheWithInc.thread[60].content, "New message 576");
check("incremental merge contains appended message 577", clientCacheWithInc.thread[61].content, "New message 577");

// Backward pagination: User clicks "show older" -> fetchChatOlder(id, run.from = 516, limit = 60)
const olderChunk1 = chatDeltaResponse(expanded578Server, { before: clientCacheWithInc.from, limit: 60 }); // before: 516 -> [456, 516)
check("older chunk 1: from === 456", olderChunk1.from, 456);
check("older chunk 1: thread length === 60", olderChunk1.run.thread.length, 60);
checkTrue("older chunk 1: prompt is omitted over wire", !("prompt" in olderChunk1.run));

const clientCachePrepend1 = mergeChatOlder(clientCacheWithInc, olderChunk1);
check("older prepend 1: thread length becomes 122 (60 older + 62 existing)", clientCachePrepend1.thread.length, 122);
check("older prepend 1: cache from updates to 456", clientCachePrepend1.from, 456);
check("older prepend 1: total is 578", clientCachePrepend1.total, 578);
check("older prepend 1: first message is index 456", clientCachePrepend1.thread[0].content, expanded578Server.thread[456].content);
check("older prepend 1: message at index 60 is index 516", clientCachePrepend1.thread[60].content, expanded578Server.thread[516].content);
check("older prepend 1: cached prompt is preserved", clientCachePrepend1.prompt, initial576Server.prompt);

// Multi-page backward pagination walk to index 0:
// Iteratively simulate clicking "show older" until from === 0
let walkCache = clientCachePrepend1;
let pageIterations = 0;
while ((walkCache.from ?? 0) > 0) {
  pageIterations++;
  const olderPage = chatDeltaResponse(expanded578Server, { before: walkCache.from, limit: 60 });
  walkCache = mergeChatOlder(walkCache, olderPage);
  if (pageIterations > 20) throw new Error("Infinite pagination walk loop detected");
}

check("full backward walk reaches from === 0", walkCache.from, 0);
check("full backward walk reconstructs all 578 messages", walkCache.thread.length, 578);
check("full backward walk message 0 matches server", walkCache.thread[0].content, expanded578Server.thread[0].content);
check("full backward walk message 577 matches server", walkCache.thread[577].content, expanded578Server.thread[577].content);
check("full backward walk maintains total === 578", walkCache.total, 578);
check("full backward walk preserves prompt", walkCache.prompt, initial576Server.prompt);

// Verify exact sequence integrity: every message matches without gaps or duplication
let sequenceIntegrity = true;
for (let i = 0; i < 578; i++) {
  if (walkCache.thread[i].content !== expanded578Server.thread[i].content) {
    sequenceIntegrity = false;
    break;
  }
}
checkTrue("full backward pagination walk exhibits 100% sequence integrity (0 gaps, 0 duplicates)", sequenceIntegrity);

// Compaction recovery: server compacted thread from 578 to 60 messages
const compactedServerRun: RunDetail = {
  ...makeFixtureRun(60),
  prompt: "Compacted thread replacement prompt",
};
// Client asks with stale tail cursor 578, server returns from = 0, len = 60 with prompt
const compactedDelta = chatDeltaResponse(compactedServerRun, 578);
check("compacted delta returns from=0", compactedDelta.from, 0);
checkTrue("compacted recovery delta carries prompt in snapshot", "prompt" in compactedDelta.run);
const compactedMerged = mergeChatDelta(walkCache, compactedDelta);
check("compacted merge heals client cache to 60 messages", compactedMerged.thread.length, 60);
check("compacted merge updates prompt from full recovery payload", compactedMerged.prompt, compactedServerRun.prompt);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 4: Payload Size Reduction Measurements on Realistic Fixtures
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 4a. Production Baseline (103-entry chat with ~10 KB prompt) ───────");

const realistic10kPrompt = "You are the executor of Konrad's Personal AI OS (forge-control), running headless on his Hetzner VPS. " +
  "Environment details: Content Forge monorepo at /opt/content-forge, PostgreSQL content_forge, BullMQ queues, VPS2 at 167.233.145.218. " +
  "Autonomous execution policies, gate verification rules, token budget tracking, tool usage contracts, and comprehensive project instructions. ".repeat(42);
const promptBytes = Buffer.byteLength(realistic10kPrompt, "utf8");

const productionFixture103: RunDetail = {
  ...makeFixtureRun(103, realistic10kPrompt),
  metadata: { manager: true, channel: "desktop", project_id: "e3ec32ed-0f03-48c8-b742-5a770de4a596", tags: ["aios", "chat-delta", "perf"] },
};

const prodFullJson = JSON.stringify(chatDeltaResponse(productionFixture103, { limit: 500 }));
const prodFullBytes = Buffer.byteLength(prodFullJson, "utf8");

const legacyDeltaWithPrompt = {
  from: 103,
  total: 103,
  run: { ...productionFixture103, thread: [] },
};
const beforeSteadyStateJson = JSON.stringify(legacyDeltaWithPrompt);
const beforeSteadyStateBytes = Buffer.byteLength(beforeSteadyStateJson, "utf8");
const beforeSteadyStateGzip = gzipSync(Buffer.from(beforeSteadyStateJson)).byteLength;

const afterSteadyStateResponse = chatDeltaResponse(productionFixture103, 103);
const afterSteadyStateJson = JSON.stringify(afterSteadyStateResponse);
const afterSteadyStateBytes = Buffer.byteLength(afterSteadyStateJson, "utf8");
const afterSteadyStateGzip = gzipSync(Buffer.from(afterSteadyStateJson)).byteLength;

const promptReductionPct = ((1 - afterSteadyStateBytes / beforeSteadyStateBytes) * 100).toFixed(2);
const promptGzipReductionPct = ((1 - afterSteadyStateGzip / beforeSteadyStateGzip) * 100).toFixed(2);

console.log(`[103-Entry Production Fixture — Prompt Omission Impact]`);
console.log(`  Full fetch payload:             ${prodFullBytes.toLocaleString()} bytes uncompressed (${(prodFullBytes / 1024).toFixed(1)} KB)`);
console.log(`  Prompt size:                    ${promptBytes.toLocaleString()} bytes (~${((promptBytes / beforeSteadyStateBytes) * 100).toFixed(1)}% of legacy steady-state delta)`);
console.log(`  Steady-state BEFORE (w/prompt):  ${beforeSteadyStateBytes.toLocaleString()} bytes uncompressed | ${beforeSteadyStateGzip.toLocaleString()} bytes gzipped`);
console.log(`  Steady-state AFTER  (no prompt): ${afterSteadyStateBytes.toLocaleString()} bytes uncompressed | ${afterSteadyStateGzip.toLocaleString()} bytes gzipped`);
console.log(`  Steady-state delta reduction:   ${promptReductionPct}% (uncompressed), ${promptGzipReductionPct}% (gzipped)`);

checkTrue("prompt accounts for > 80% of legacy steady-state payload", (promptBytes / beforeSteadyStateBytes) > 0.80);
checkTrue("prompt omission achieves ~86% steady-state reduction (> 80%)", parseFloat(promptReductionPct) > 80.0);
checkTrue("after-steady-state delta payload is < 2 KB uncompressed", afterSteadyStateBytes < 2048);

console.log("\n── 4b. Large Live Production Chat Measurements (2,477 entries matching 11dd264b) ──");

// Generate realistic calibrated 2,477-entry thread fixture (matching real 2.53 MB live chat 11dd264b)
const realistic2477Thread: ThreadEntry[] = [];
for (let i = 0; i < 2477; i++) {
  const role: "user" | "assistant" | "system" = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "system";
  let content: string;
  if (i < 2417 && i % 5 === 0) {
    // Historical heavy tool outputs, JSON execution traces, build logs (accounts for ~2.5 MB bulk history)
    content = `\`\`\`json\n{\n  "action": "execute_suite",\n  "step": ${i},\n  "uuid": "${Math.random().toString(36).slice(2, 10)}",\n  "log": "${"build and test runner output trace data ".repeat(105)}"\n}\n\`\`\``;
  } else {
    // Standard chat turn (~300 bytes)
    content = i % 3 === 0
      ? `Task update for phase ${i}: verified all endpoints and executed check suite cleanly. Summary token tally: ${1500 + i * 20} input, ${300 + i * 5} output.`
      : i % 3 === 1
      ? `Approved plan and verified code diffs for step ${i}. Proceeding to next verification step.`
      : `Phase ${i} status: checks passed, 0 failures, all universal gates green.`;
  }
  realistic2477Thread.push(makeEntry(role, content, new Date(1724457600000 + i * 2000).toISOString()));
}

const large2477Run: RunDetail = {
  ...makeFixtureRun(0, realistic10kPrompt),
  id: "11dd264b-f173-44d7-ada4-f1eb39fb4abd",
  title: "Large live production chat fixture (11dd264b)",
  thread: realistic2477Thread,
  message_count: 2477,
};

// 1. Legacy full fetch payload (all 2,477 turns)
const legacyFullJson = JSON.stringify({
  from: 0,
  total: 2477,
  run: large2477Run,
});
const legacyFullBytes = Buffer.byteLength(legacyFullJson, "utf8");
const legacyFullGzip = gzipSync(Buffer.from(legacyFullJson)).byteLength;

// 2. Bounded initial load (default 60 turns + prompt + envelope)
const boundedInitialResp = chatDeltaResponse(large2477Run, {});
const boundedInitialJson = JSON.stringify(boundedInitialResp);
const boundedInitialBytes = Buffer.byteLength(boundedInitialJson, "utf8");
const boundedInitialGzip = gzipSync(Buffer.from(boundedInitialJson)).byteLength;

// 3. Steady-state delta poll (since = 2477, 0 thread turns, prompt omitted)
const steadyDeltaResp = chatDeltaResponse(large2477Run, 2477);
const steadyDeltaJson = JSON.stringify(steadyDeltaResp);
const steadyDeltaBytes = Buffer.byteLength(steadyDeltaJson, "utf8");
const steadyDeltaGzip = gzipSync(Buffer.from(steadyDeltaJson)).byteLength;

// 4. Backward page load (before = 2417, limit = 60, prompt omitted)
const backwardPageResp = chatDeltaResponse(large2477Run, { before: 2417, limit: 60 });
const backwardPageJson = JSON.stringify(backwardPageResp);
const backwardPageBytes = Buffer.byteLength(backwardPageJson, "utf8");
const backwardPageGzip = gzipSync(Buffer.from(backwardPageJson)).byteLength;

const initialReductionPct = ((1 - boundedInitialBytes / legacyFullBytes) * 100).toFixed(2);
const initialGzipReductionPct = ((1 - boundedInitialGzip / legacyFullGzip) * 100).toFixed(2);
const steadyReductionPct = ((1 - steadyDeltaBytes / legacyFullBytes) * 100).toFixed(2);
const steadyGzipReductionPct = ((1 - steadyDeltaGzip / legacyFullGzip) * 100).toFixed(2);

console.log(`[2,477-Entry Production Chat (11dd264b) Measurements]`);
console.log(`  Legacy Full Initial Fetch:      ${legacyFullBytes.toLocaleString()} bytes uncompressed (${(legacyFullBytes / 1024).toFixed(1)} KB) | ${legacyFullGzip.toLocaleString()} bytes gzipped (${(legacyFullGzip / 1024).toFixed(1)} KB)`);
console.log(`  Bounded Initial Fetch (60 msg): ${boundedInitialBytes.toLocaleString()} bytes uncompressed (${(boundedInitialBytes / 1024).toFixed(1)} KB) | ${boundedInitialGzip.toLocaleString()} bytes gzipped (${(boundedInitialGzip / 1024).toFixed(1)} KB)`);
console.log(`  Steady-State Delta (0 msg):     ${steadyDeltaBytes.toLocaleString()} bytes uncompressed (${(steadyDeltaBytes / 1024).toFixed(1)} KB) | ${steadyDeltaGzip.toLocaleString()} bytes gzipped (${(steadyDeltaGzip / 1024).toFixed(1)} KB)`);
console.log(`  Backward Page Load (60 msg):    ${backwardPageBytes.toLocaleString()} bytes uncompressed (${(backwardPageBytes / 1024).toFixed(1)} KB) | ${backwardPageGzip.toLocaleString()} bytes gzipped (${(backwardPageGzip / 1024).toFixed(1)} KB)`);
console.log(`  Initial Load Reduction:         ${initialReductionPct}% uncompressed, ${initialGzipReductionPct}% gzipped`);
console.log(`  Steady-State Delta Reduction:   ${steadyReductionPct}% uncompressed, ${steadyGzipReductionPct}% gzipped`);

checkTrue("legacy full payload exceeds 2 MB (> 2,000,000 bytes)", legacyFullBytes > 2_000_000);
checkTrue("bounded initial payload is < 30 KB uncompressed", boundedInitialBytes < 30_000);
checkTrue("bounded initial payload reduction exceeds 98%", parseFloat(initialReductionPct) > 98.0);
checkTrue("steady-state delta payload is < 2 KB uncompressed", steadyDeltaBytes < 2048);
checkTrue("steady-state delta payload reduction exceeds 99.9%", parseFloat(steadyReductionPct) > 99.9);
checkTrue("backward page payload is bounded (< 100 KB uncompressed)", backwardPageBytes < 100_000);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 5: Chat Surface Poll Budget Verification
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 5a. The poll constants themselves, against their own literals ──────");

check("CHAT_LIST_POLL_MS is 10s", CHAT_LIST_POLL_MS, 10_000);
check("CHAT_DETAIL_LIVE_POLL_MS is 20s", CHAT_DETAIL_LIVE_POLL_MS, 20_000);
check("CHAT_DETAIL_FALLBACK_POLL_MS is 4s", CHAT_DETAIL_FALLBACK_POLL_MS, 4_000);
check("TEAM_POLL_MS is 10s", TEAM_POLL_MS, 10_000);
check("PLAN_POLL_MS is 30s", PLAN_POLL_MS, 30_000);
check("SHOTS_INDEX_POLL_MS is 30s", SHOTS_INDEX_POLL_MS, 30_000);
/* The fleet feed's two periods. `AGENTS_POLL_MS` was a bare `refetchInterval:
 * 4_000` inside AgentActivity until the sidebar's scope toggle gave the CHAT
 * surface a way to mount that component — 15 req/min this file could not see,
 * and therefore could not govern. It is /live's number and stays 4s;
 * `SIDEBAR_AGENTS_POLL_MS` is what the chat sidebar mounts it at. */
check("AGENTS_POLL_MS is 4s (/live's fleet feed)", AGENTS_POLL_MS, 4_000);
check("SIDEBAR_AGENTS_POLL_MS is 8s (the chat sidebar's)", SIDEBAR_AGENTS_POLL_MS, 8_000);
check("SECRETS_FALLBACK_POLL_MS is 60s", SECRETS_FALLBACK_POLL_MS, 60_000);
check("committed ceiling is 40 req/min", CHAT_SURFACE_REQ_PER_MIN_CEILING, 40);
check("secrets poll costs nothing while its stream is up", secretsPollInterval(true), false);
check("secrets poll falls back to 60s with the stream down", secretsPollInterval(false), 60_000);

console.log("\n── 5b. Chat surface poll budget (from the real constants) ─────────────");

const perMin = (intervalMs: number): number => 60_000 / intervalMs;

const runListReqPerMin = perMin(CHAT_LIST_POLL_MS);       // 6 req/min
const teamPanelReqPerMin = perMin(TEAM_POLL_MS);          // 6 req/min
const shotsReqPerMin = perMin(SHOTS_INDEX_POLL_MS);       // 2 req/min
const planKanbanReqPerMin = perMin(PLAN_POLL_MS);         // 2 req/min
const secretsReqPerMin = perMin(SECRETS_FALLBACK_POLL_MS); // 1 req/min

const panelsReqPerMin =
  runListReqPerMin + teamPanelReqPerMin + shotsReqPerMin + planKanbanReqPerMin; // 16 req/min

const healthyDetailReqPerMin = perMin(CHAT_DETAIL_LIVE_POLL_MS); // 3 req/min
const totalHealthyReqPerMin = panelsReqPerMin + healthyDetailReqPerMin; // 19 req/min

const degradedDetailReqPerMin = perMin(CHAT_DETAIL_FALLBACK_POLL_MS); // 15 req/min
const totalDegradedReqPerMin =
  panelsReqPerMin + degradedDetailReqPerMin + secretsReqPerMin; // 32 req/min

const drilledDetailReqPerMin = perMin(CHAT_DETAIL_FALLBACK_POLL_MS);
const totalDrilledDegradedReqPerMin =
  panelsReqPerMin + drilledDetailReqPerMin + secretsReqPerMin;

/* ── "EVERYTHING RUNNING" (the sidebar's scope toggle) ─────────────────────
 *
 * Konrad's toggle (vault `AI OS/Spec - Manager Chat UI v3.md`, addendum
 * 2026-08-25) swaps the right sidebar between the open chat's team panel and
 * /live's fleet feed. It is a SWAP, not an addition: in "everything running"
 * `ChatTeamPanel` and `PlanKanban` are unmounted, so TEAM_POLL_MS (6 req/min)
 * and PLAN_POLL_MS (2 req/min) stop and the fleet feed's poll starts.
 *
 * At /live's own 4s that trade is 15 in for 8 out — net +7, taking the degraded
 * surface from 32 to 39 req/min. Under the ceiling by one request, with nothing
 * left over, which is not a budget so much as a coincidence. So the sidebar
 * mounts the feed at SIDEBAR_AGENTS_POLL_MS (8s, 7.5 req/min) and /live keeps
 * 4s: the swap is net -0.5 req/min and the committed degraded total does not
 * move up at all. Both branches are asserted below, the second as the
 * counterfactual it is. */
const sidebarFleetReqPerMin = perMin(SIDEBAR_AGENTS_POLL_MS);   // 7.5 req/min
const liveFleetReqPerMin = perMin(AGENTS_POLL_MS);              // 15 req/min

/** Panels in "everything running": the rail's list and the shot index survive
 *  the swap; team and plan do not exist in this scope. */
const fleetScopePanelsReqPerMin =
  runListReqPerMin + shotsReqPerMin + sidebarFleetReqPerMin;    // 15.5 req/min

const totalFleetScopeHealthyReqPerMin =
  fleetScopePanelsReqPerMin + healthyDetailReqPerMin;           // 18.5 req/min
const totalFleetScopeDegradedReqPerMin =
  fleetScopePanelsReqPerMin + degradedDetailReqPerMin + secretsReqPerMin; // 31.5

/** The counterfactual: the same swap with the feed left at /live's 4s. Not a
 *  live value — the whole point is that the sidebar does NOT mount it there. */
const wouldBeDegradedAtLiveRateReqPerMin =
  runListReqPerMin + shotsReqPerMin + liveFleetReqPerMin +
  degradedDetailReqPerMin + secretsReqPerMin;                   // 39 req/min

/* The counterexample, and the one number here that is deliberately a LITERAL:
 * 3s detail + 6s team is history (41 req/min), not live values. */
const PREV_DEGRADED_DETAIL_POLL_MS = 3_000;
const PREV_TEAM_POLL_MS = 6_000;
const prevPanelsReqPerMin =
  runListReqPerMin + perMin(PREV_TEAM_POLL_MS) + shotsReqPerMin + planKanbanReqPerMin;
const prevTotalDegradedReqPerMin =
  prevPanelsReqPerMin + perMin(PREV_DEGRADED_DETAIL_POLL_MS) + secretsReqPerMin;

console.log(`Committed Chat Surface Ceiling: ≤ ${CHAT_SURFACE_REQ_PER_MIN_CEILING} req/min`);
console.log(`Healthy steady-state rate:      ${totalHealthyReqPerMin} req/min`);
console.log(`Degraded fallback rate (4s):    ${totalDegradedReqPerMin} req/min`);
console.log(`Degraded, drilled to depth 1:   ${totalDrilledDegradedReqPerMin} req/min`);
console.log(`Previous degraded rate (3s):    ${prevTotalDegradedReqPerMin} req/min (Violated ceiling: ${prevTotalDegradedReqPerMin} > ${CHAT_SURFACE_REQ_PER_MIN_CEILING})`);

check("healthy poll rate equals 19 req/min", totalHealthyReqPerMin, 19);
checkTrue(
  "healthy poll rate is under the committed ceiling",
  totalHealthyReqPerMin <= CHAT_SURFACE_REQ_PER_MIN_CEILING,
);

check("degraded fallback poll rate equals 32 req/min", totalDegradedReqPerMin, 32);
checkTrue(
  "degraded fallback poll rate is under the committed ceiling",
  totalDegradedReqPerMin <= CHAT_SURFACE_REQ_PER_MIN_CEILING,
);

check("drilled degraded poll rate equals 32 req/min", totalDrilledDegradedReqPerMin, 32);
check(
  "drilling in does not change the surface's request rate",
  totalDrilledDegradedReqPerMin,
  totalDegradedReqPerMin,
);

checkTrue("previous 3s fallback violated ceiling (> 40 req/min)", prevTotalDegradedReqPerMin > 40);

console.log(`\nSidebar scope "everything running" (team + plan unmounted, /api/agents at ${SIDEBAR_AGENTS_POLL_MS / 1000}s):`);
console.log(`  Healthy:  ${totalFleetScopeHealthyReqPerMin} req/min (List ${runListReqPerMin} + Detail ${healthyDetailReqPerMin} + Shots ${shotsReqPerMin} + Fleet ${sidebarFleetReqPerMin})`);
console.log(`  Degraded: ${totalFleetScopeDegradedReqPerMin} req/min (List ${runListReqPerMin} + Detail ${degradedDetailReqPerMin} + Shots ${shotsReqPerMin} + Fleet ${sidebarFleetReqPerMin} + Secrets ${secretsReqPerMin}) — vs ${totalDegradedReqPerMin} scoped to this chat`);
console.log(`  Counterfactual at /live's ${AGENTS_POLL_MS / 1000}s: ${wouldBeDegradedAtLiveRateReqPerMin} req/min (net +${wouldBeDegradedAtLiveRateReqPerMin - totalDegradedReqPerMin} over the scoped surface)`);

check(
  "everything-running healthy rate equals 18.5 req/min",
  totalFleetScopeHealthyReqPerMin,
  18.5,
);
check(
  "everything-running degraded rate equals 31.5 req/min",
  totalFleetScopeDegradedReqPerMin,
  31.5,
);
checkTrue(
  "everything-running is under the committed ceiling",
  totalFleetScopeDegradedReqPerMin <= CHAT_SURFACE_REQ_PER_MIN_CEILING,
);
/* THE ASSERTION THIS ROUND EXISTS FOR. Flipping the toggle must not make the
 * surface cost more than it did scoped to one chat. A future edit that speeds
 * the sidebar's feed up to /live's rate goes red HERE, not in production. */
checkTrue(
  "flipping to everything-running does not raise the surface's request rate",
  totalFleetScopeDegradedReqPerMin <= totalDegradedReqPerMin,
);
checkTrue(
  "the sidebar's fleet feed is strictly slower than /live's",
  SIDEBAR_AGENTS_POLL_MS > AGENTS_POLL_MS,
);
/* The counterfactual, stated so the choice is legible rather than folded into
 * a constant: at /live's 4s the same swap would have cost 7 req/min MORE than
 * the scoped surface — inside the ceiling, but spending headroom the last two
 * nights of payload work bought. */
checkTrue(
  "at /live's rate the swap would have cost the surface more, not less",
  wouldBeDegradedAtLiveRateReqPerMin > totalDegradedReqPerMin,
);
/* And the default scope — where Konrad spends nearly all his time — costs the
 * fleet feed NOTHING. `scopePolls` is the gate ChatSurface computes
 * `fleetEnabled` from and the same predicate that decides whether the component
 * is mounted at all, so asserting it here is asserting the zero, not restating
 * an arithmetic identity: if it ever returned true for the default, the
 * surface's real degraded cost would be 32 + 7.5 and this line would be the
 * one that noticed. */
check("the default scope is the non-polling one", scopePolls(SIDEBAR_SCOPE_DEFAULT), false);
check("only the fleet scope polls /api/agents", scopePolls("everything-running"), true);
check(
  "so the default scope's degraded total carries no fleet term",
  totalDegradedReqPerMin +
    (scopePolls(SIDEBAR_SCOPE_DEFAULT) ? sidebarFleetReqPerMin : 0),
  32,
);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 6: Team Tree Settled Backoff & Uploads Index Caching
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 6. Team tree settled backoff (isTreeSettled) ──────────────────────");

function makeTestTeamNode(overrides: Partial<TeamNode> = {}): TeamNode {
  return {
    id: "test-node",
    kind: "worker",
    role: "builder",
    model: "claude-sonnet",
    status: "completed",
    tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0, total: 150 },
    tokens_measured: true,
    working_ms: 1000,
    working_ms_source: "thread",
    started_at: "2026-08-24T00:00:00.000Z",
    settled: true,
    description: "Test node",
    parent_id: null,
    dismissed_at: null,
    subagents: [],
    task: null,
    ...overrides,
  };
}

function makeTestTeamResponse(overrides: Partial<TeamResponse> = {}): TeamResponse {
  return {
    chat_id: "2ef126b7-d6d9-4a55-a8e7-d9acf0508645",
    now: "2026-08-24T00:00:00.000Z",
    project: { id: "proj-1", status: "completed" },
    link_source: "metadata",
    link_ambiguous: false,
    manager: makeTestTeamNode({ id: "mgr-1", kind: "operator", role: "manager" }),
    workers: [],
    complete: true,
    errors: [],
    ...overrides,
  };
}

check("undefined response is not settled", isTreeSettled(undefined), false);
check("running manager is not settled", isTreeSettled(makeTestTeamResponse({ manager: makeTestTeamNode({ settled: false }) })), false);
check("manager with running subagent is not settled", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: false })] }),
})), false);
check("settled manager with running worker is not settled", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true }),
  workers: [makeTestTeamNode({ settled: false })],
})), false);
check("settled worker with running subagent is not settled", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true }),
  workers: [makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: false })] })],
})), false);
check("all nodes settled -> tree is settled", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: true })] }),
  workers: [makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: true })] })],
})), true);

console.log("\n── 7. Uploads index ETag & cache tag verification ──────────────────");

/** Round 4 review finding #1 (ChatSurface.tsx:794, api.ts:1099-1112):
 *  the delta poll's queryFn used to capture `prev` once, before the network
 *  round trip, and merge against that closure-captured snapshot when the
 *  response landed — silently clobbering a concurrent write from
 *  AssistantThread's backward-pagination handlers (`handleShowOlder`/
 *  `handleShowAll`), which write to the same cache key synchronously via
 *  `qc.setQueryData` while the poll's `fetch` is still in flight.
 *
 *  This drives the REAL `fetchChatDelta` (not a local pure-function stand-in)
 *  against a hand-controlled `fetch` mock so the network response resolves
 *  only after we've mutated what `getPrev()` returns — reproducing the exact
 *  interleaving the reviewer described. Before the fix (`prev` captured once,
 *  used for the merge) this test fails: the prepended older turns and the
 *  moved cursor are overwritten wholesale by the poll's stale-based replace.
 *  After the fix (`getPrev()` re-invoked right before merging) it passes. */
async function raceConditionRegression(): Promise<void> {
  console.log("\n── 8. Race regression: backward pagination vs. in-flight delta poll ──");

  function makeEntry(role: ApiRunDetail["thread"][number]["role"], content: string): ApiRunDetail["thread"][number] {
    return { role, content, ts: "2026-08-24T00:00:00.000Z" };
  }

  function makeApiFixture(threadLength: number, from: number, total: number): ApiRunDetail {
    return {
      id: "race-test-run",
      title: "race regression fixture",
      status: "running",
      worker: "claude",
      budget_usd: "10.00",
      spent_usd: "1.25",
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
      last_heartbeat_at: "2026-08-24T00:00:00.000Z",
      message_count: total,
      last_message_preview: "",
      last_role: "assistant",
      archived: false,
      metadata: {},
      prompt: "race regression fixture prompt",
      thread: Array.from({ length: threadLength }, (_, i) => makeEntry("assistant", `seed-${i}`)),
      parent_run_id: null,
      stuck_signal: null,
      started_at: "2026-08-24T00:00:00.000Z",
      completed_at: null,
      from,
      total,
    };
  }

  // Cached state before the poll starts: tail = from(40) + thread.length(60) = 100.
  let cache: ApiRunDetail | undefined = makeApiFixture(60, 40, 100);

  let resolveFetch!: (res: Response) => void;
  const fetchGate = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (((url: string) => {
    capturedUrl = String(url);
    return fetchGate;
  }) as unknown) as typeof fetch;

  try {
    const deltaPromise = fetchChatDelta("race-test-run", () => cache);

    // Simulate handleShowOlder: a synchronous qc.setQueryData that prepends
    // 10 older turns and moves the cursor back, WHILE the poll's fetch above
    // is still pending. Tail is invariant under a backward prepend
    // (30 + 70 === 40 + 60 === 100), so this write is exactly the scenario
    // the fix's doc comment describes as still valid against the requested cursor.
    const older = Array.from({ length: 10 }, (_, i) => makeEntry("user", `older-${i}`));
    cache = { ...cache!, thread: [...older, ...cache!.thread], from: 30 };

    // Now let the network resolve: 5 new entries appended past tail 100.
    const newEntries = Array.from({ length: 5 }, (_, i) => makeEntry("assistant", `new-${i}`));
    const { thread: _discardedThread, prompt: _discardedPrompt, ...metaRest } = makeApiFixture(0, 100, 105);
    resolveFetch(
      new Response(
        JSON.stringify({ run: { ...metaRest, thread: newEntries }, from: 100, total: 105 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const merged = await deltaPromise;

    checkTrue(
      "race: request was built from the pre-write tail (since=100)",
      capturedUrl.includes("since=100"),
      capturedUrl,
    );
    check("race: merged thread length is 70 (prepended) + 5 (appended), not 60 + 5", merged.thread.length, 75);
    check("race: merged cursor keeps the prepend's from=30, not the stale prev's from=40", merged.from, 30);
    check("race: merged total reflects the server's fresh total", merged.total, 105);
    checkTrue(
      "race: the 10 prepended older turns survived the poll's merge",
      merged.thread.slice(0, 10).every((e, i) => e.content === `older-${i}`),
      JSON.stringify(merged.thread.slice(0, 12).map((e) => e.content)),
    );
    checkTrue(
      "race: the 5 newly-appended turns landed after the prepend + original 60",
      merged.thread.slice(70).every((e, i) => e.content === `new-${i}`),
      JSON.stringify(merged.thread.slice(70).map((e) => e.content)),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runAsyncChecks(): Promise<void> {
  const tagInitial = getUploadsCacheTag();
  checkTrue("uploads index cache tag is non-empty quoted string", typeof tagInitial === "string" && tagInitial.startsWith('"') && tagInitial.endsWith('"'));

  await listAllRuns();
  const tagComputed = getUploadsCacheTag();
  checkTrue("uploads index computed tag is valid quoted string", typeof tagComputed === "string" && tagComputed.startsWith('"') && tagComputed.endsWith('"'));
  check("subsequent getUploadsCacheTag returns stable cached tag", getUploadsCacheTag(), tagComputed);

  await raceConditionRegression();

  /* ════════════════════════════════════════════════════════════════════════════
   * SUMMARY
   * ══════════════════════════════════════════════════════════════════════════ */

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — check-chat-delta suite`);
  process.exit(failures === 0 ? 0 : 1);
}

runAsyncChecks().catch((err) => {
  console.error("Unhandled error in check-chat-delta:", err);
  process.exit(1);
});
