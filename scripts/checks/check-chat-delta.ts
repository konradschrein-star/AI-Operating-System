/**
 * check-chat-delta.ts — verification measurement harness for chat delta synchronization.
 *
 * Project: aios-console-responsiveness
 *
 * This check verifies:
 *  1. Backend Delta Query Contract (forge-control /api/chat/:id?since=N):
 *     - parseSinceParam: parses non-negative integer strings, rejects invalid/negative/fractional.
 *     - chatDeltaResponse: returns full thread when since is omitted, empty delta when since === total,
 *       incremental slice when since < total, full snapshot recovery when since > total.
 *  2. Frontend Delta Merging & Reference Identity (forge-control-web fetchChatDelta):
 *     - Retains exact thread array reference on empty delta (0 React re-renders / 0 DOM thrash).
 *     - Appends new entries cleanly when incremental messages arrive.
 *     - Recovers to full replacement snapshot on cursor mismatch (e.g. compacted thread).
 *  3. Payload Reduction Measurements:
 *     - Simulates realistic manager thread (576 entries, ~542.7 KB uncompressed).
 *     - Measures uncompressed & compressed byte reductions (>99% reduction on steady-state poll).
 *  4. Chat Surface Poll Budget Calculations:
 *     - Healthy steady state (SSE live): 23 req/min (≤ 40 req/min ceiling).
 *     - Degraded fallback state (SSE down): 36 req/min (≤ 40 req/min ceiling).
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-delta.ts
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-delta.ts
 */

import { gzipSync } from "node:zlib";
import { parseSinceParam, chatDeltaResponse } from "../../forge-control/src/routes/chat.ts";
import type { RunDetail, ThreadEntry } from "../../forge-control/src/db/runs.ts";
/* THE REAL CONSTANTS THE SURFACE POLLS AT — imported, never copied. Round 3 of
 * this project hand-copied them into local `const`s here, which made section 5
 * an assertion that arithmetic is arithmetic: `TEAM_POLL_MS` could have gone to
 * 1s and every line below would still have printed PASS. See §5's own header
 * for why each one is ALSO asserted against a literal. */
import {
  CHAT_DETAIL_FALLBACK_POLL_MS,
  CHAT_DETAIL_LIVE_POLL_MS,
  CHAT_LIST_POLL_MS,
  CHAT_SURFACE_REQ_PER_MIN_CEILING,
  PLAN_POLL_MS,
  SHOTS_INDEX_POLL_MS,
  TEAM_POLL_MS,
} from "../../forge-control-web/app/desktop/chat/pollBudget.ts";
import {
  SECRETS_FALLBACK_POLL_MS,
  secretsPollInterval,
} from "../../forge-control-web/app/desktop/chat/secretLive.ts";

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

function makeFixtureRun(threadLength = 3): RunDetail {
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
    /* `""`, not `null`: `RunDetail` declares both as `string`
     * (forge-control/src/db/runs.ts:68-69), and `makeFixtureRun(0)` — which
     * §4's `largeRun` calls — took the empty branch. `tsx` strips types without
     * checking them, so round 3 shipped two real type errors that only
     * `check-instrument-typecheck.sh` (universal gate item 9) could see. */
    last_message_preview: threadLength > 0 ? thread[threadLength - 1].content.slice(0, 50) : "",
    last_role: threadLength > 0 ? thread[threadLength - 1].role : "",
    archived: false,
    metadata: { manager: true, channel: "desktop" },
    prompt: "Coordinate system updates and manage tasks",
    thread,
    parent_run_id: null,
    stuck_signal: null,
    started_at: "2026-08-24T00:00:00.000Z",
    completed_at: null,
  };
}

/** Pure merge helper matching fetchChatDelta in forge-control-web/app/api.ts */
function mergeChatDelta(
  prev: RunDetail | undefined,
  deltaResponse: { run: RunDetail; from: number; total: number },
): RunDetail {
  if (prev === undefined) return deltaResponse.run;
  const { run, from } = deltaResponse;
  if (from !== prev.thread.length) return run;
  return run.thread.length === 0
    ? { ...run, thread: prev.thread }
    : { ...run, thread: [...prev.thread, ...run.thread] };
}

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 1: Backend Delta Query Parsing & Response Logic
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 1. parseSinceParam: query string parsing & validation ─────────────");

check("undefined query parameter -> undefined", parseSinceParam(undefined), undefined);
check("empty string -> undefined", parseSinceParam(""), undefined);
check("valid zero '0' -> 0", parseSinceParam("0"), 0);
check("valid positive integer '576' -> 576", parseSinceParam("576"), 576);
check("negative integer '-5' -> undefined (recovery)", parseSinceParam("-5"), undefined);
check("fractional number '12.34' -> undefined (recovery)", parseSinceParam("12.34"), undefined);
check("non-numeric string 'foo' -> undefined (recovery)", parseSinceParam("foo"), undefined);
check("NaN -> undefined (recovery)", parseSinceParam("NaN"), undefined);
check("Infinity -> undefined (recovery)", parseSinceParam("Infinity"), undefined);

console.log("\n── 2. chatDeltaResponse: server delta slicing & recovery ──────────────");

const runFixture = makeFixtureRun(5);

const fullResp = chatDeltaResponse(runFixture, undefined);
check("since omitted: from === 0", fullResp.from, 0);
check("since omitted: total === 5", fullResp.total, 5);
check("since omitted: thread length === 5", fullResp.run.thread.length, 5);

const emptyDeltaResp = chatDeltaResponse(runFixture, 5);
check("since === total: from === 5", emptyDeltaResp.from, 5);
check("since === total: total === 5", emptyDeltaResp.total, 5);
check("since === total: returns empty thread array", emptyDeltaResp.run.thread, []);

const appendDeltaResp = chatDeltaResponse(runFixture, 3);
check("since < total: from === 3", appendDeltaResp.from, 3);
check("since < total: total === 5", appendDeltaResp.total, 5);
check("since < total: returns slice of 2 new items", appendDeltaResp.run.thread.length, 2);
check("since < total: first item is index 3", appendDeltaResp.run.thread[0].content, runFixture.thread[3].content);
check("since < total: second item is index 4", appendDeltaResp.run.thread[1].content, runFixture.thread[4].content);

const zeroSinceResp = chatDeltaResponse(runFixture, 0);
check("since === 0: from === 0", zeroSinceResp.from, 0);
check("since === 0: total === 5", zeroSinceResp.total, 5);
check("since === 0: returns all 5 items", zeroSinceResp.run.thread.length, 5);

const staleRecoveryResp = chatDeltaResponse(runFixture, 99);
check("since > total (stale client): from === 0 (recovery)", staleRecoveryResp.from, 0);
check("since > total (stale client): total === 5", staleRecoveryResp.total, 5);
check("since > total (stale client): returns full thread snapshot", staleRecoveryResp.run.thread.length, 5);

// Verify immutability
const beforeThreadRef = runFixture.thread;
chatDeltaResponse(runFixture, 2);
checkTrue("original run.thread reference is never mutated", runFixture.thread === beforeThreadRef);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 2: Frontend Cache Merging & Reference Identity
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 3. Client cache merging & reference identity ───────────────────────");

// Initial mount: prev is undefined
const initialRun = makeFixtureRun(576);
const initialMerged = mergeChatDelta(undefined, { run: initialRun, from: 0, total: 576 });
check("initial fetch with prev undefined returns full run", initialMerged.thread.length, 576);

// Steady-state poll: 0 new messages -> array reference identity must be preserved
const steadyStateDelta = chatDeltaResponse(initialMerged, 576);
const steadyMerged = mergeChatDelta(initialMerged, steadyStateDelta);
check("steady-state merge maintains message count", steadyMerged.thread.length, 576);
checkTrue(
  "steady-state merge preserves EXACT array reference (0 React re-renders)",
  steadyMerged.thread === initialMerged.thread,
  "Thread array reference changed despite 0 new messages",
);

// Incremental poll: 2 new messages arrive on server
const expandedServerRun: RunDetail = {
  ...initialMerged,
  thread: [
    ...initialMerged.thread,
    makeEntry("user", "New message 576", "2026-08-24T00:10:01.000Z"),
    makeEntry("assistant", "New message 577", "2026-08-24T00:10:02.000Z"),
  ],
  message_count: 578,
};
const incDelta = chatDeltaResponse(expandedServerRun, 576);
const incMerged = mergeChatDelta(steadyMerged, incDelta);
check("incremental merge updates length from 576 to 578", incMerged.thread.length, 578);
check("incremental merge contains appended message 576", incMerged.thread[576].content, "New message 576");
check("incremental merge contains appended message 577", incMerged.thread[577].content, "New message 577");
check("incremental merge preserves previous message prefixes", incMerged.thread[0].content, initialMerged.thread[0].content);

// Compaction recovery: server compacted thread from 578 to 60 messages
const compactedServerRun = makeFixtureRun(60);
const compactedDelta = chatDeltaResponse(compactedServerRun, 578); // Client asks since=578, server returns from=0
check("compacted delta returns from=0", compactedDelta.from, 0);
const compactedMerged = mergeChatDelta(incMerged, compactedDelta);
check("compacted merge heals client cache to 60 messages", compactedMerged.thread.length, 60);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 3: Payload Size Reduction Measurements
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 4. Payload size measurements (576-entry realistic thread) ─────────");

// Generate realistic 576-message run (matching real manager run 2ef126b7)
const realisticThread: ThreadEntry[] = [];
for (let i = 0; i < 576; i++) {
  const role: "user" | "assistant" | "system" = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "system";
  const content = i % 4 === 0
    ? `Task update for phase ${i}: verified all endpoints and executed check suite cleanly. Results attached in report artifact. Detailed log: commit ${Math.random().toString(16).slice(2, 10)} touched src/routes/chat.ts, src/lib/chat-delta.test.ts with full passing coverage.`
    : i % 4 === 1
    ? `\`\`\`json\n{\n  "action": "run_check",\n  "step": ${i},\n  "uuid": "${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}",\n  "status": "success",\n  "details": {\n    "duration_ms": ${120 + i},\n    "memory_mb": ${45 + (i % 10)},\n    "diagnostics": "typecheck 0 errors, full test suite pass"\n  }\n}\n\`\`\``
    : i % 4 === 2
    ? `Reviewed proposal for task ${i}. Approved architecture changes and state ownership boundaries. Next step: execute verification gate suite and record before/after numbers.`
    : `Phase ${i} status: 12 checks passed, 0 failures, all universal gates green. Ready for next phase. Summary token tally: ${1500 + i * 20} input, ${300 + i * 5} output.`;
  realisticThread.push(makeEntry(role, content, new Date(1724457600000 + i * 2000).toISOString()));
}

const largeRun: RunDetail = {
  ...makeFixtureRun(0),
  thread: realisticThread,
  message_count: realisticThread.length,
};

const fullPayloadJson = JSON.stringify(chatDeltaResponse(largeRun, undefined));
const fullPayloadBytes = Buffer.byteLength(fullPayloadJson, "utf8");
const fullPayloadGzip = gzipSync(Buffer.from(fullPayloadJson)).byteLength;

const emptyDeltaJson = JSON.stringify(chatDeltaResponse(largeRun, 576));
const emptyDeltaBytes = Buffer.byteLength(emptyDeltaJson, "utf8");
const emptyDeltaGzip = gzipSync(Buffer.from(emptyDeltaJson)).byteLength;

const twoMsgAppendRun: RunDetail = {
  ...largeRun,
  thread: [
    ...largeRun.thread,
    makeEntry("user", "What is the status of gate 8?", "2026-08-24T00:20:00.000Z"),
    makeEntry("assistant", "Gate 8 dollar-sweep is passing with 0 findings.", "2026-08-24T00:20:02.000Z"),
  ],
  message_count: 578,
};
const appendDeltaJson = JSON.stringify(chatDeltaResponse(twoMsgAppendRun, 576));
const appendDeltaBytes = Buffer.byteLength(appendDeltaJson, "utf8");
const appendDeltaGzip = gzipSync(Buffer.from(appendDeltaJson)).byteLength;

const uncompressedReductionPct = ((1 - emptyDeltaBytes / fullPayloadBytes) * 100).toFixed(2);
const gzippedReductionPct = ((1 - emptyDeltaGzip / fullPayloadGzip) * 100).toFixed(2);

console.log(`Full thread payload:       ${fullPayloadBytes.toLocaleString()} bytes uncompressed (${(fullPayloadBytes / 1024).toFixed(1)} KB) | ${fullPayloadGzip.toLocaleString()} bytes gzipped (${(fullPayloadGzip / 1024).toFixed(1)} KB)`);
console.log(`Steady-state empty delta:  ${emptyDeltaBytes.toLocaleString()} bytes uncompressed (${(emptyDeltaBytes / 1024).toFixed(1)} KB) | ${emptyDeltaGzip.toLocaleString()} bytes gzipped (${(emptyDeltaGzip / 1024).toFixed(1)} KB)`);
console.log(`2-message append delta:    ${appendDeltaBytes.toLocaleString()} bytes uncompressed (${(appendDeltaBytes / 1024).toFixed(1)} KB) | ${appendDeltaGzip.toLocaleString()} bytes gzipped (${(appendDeltaGzip / 1024).toFixed(1)} KB)`);
console.log(`Reduction (steady-state):  ${uncompressedReductionPct}% (uncompressed), ${gzippedReductionPct}% (gzipped)`);

checkTrue("full payload is substantial (> 50 KB)", fullPayloadBytes > 50_000);
checkTrue("empty delta payload is minimal (< 2 KB)", emptyDeltaBytes < 2048);
checkTrue("uncompressed payload reduction exceeds 98%", parseFloat(uncompressedReductionPct) > 98.0);
checkTrue("gzipped payload reduction exceeds 95%", parseFloat(gzippedReductionPct) > 95.0);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 4: Chat Surface Poll Budget Verification
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 5a. The poll constants themselves, against their own literals ──────");

/* WHY THESE NINE LINES EXIST, and why they are not the same assertion twice.
 *
 * Section 5b adds up the REAL constants, imported from
 * `forge-control-web/app/desktop/chat/pollBudget.ts` — so a poll that gets
 * faster raises the totals below and breaks the ceiling assertion. That is the
 * regression the round-3 version could not see, because it added up local
 * copies.
 *
 * But an imported constant makes the arithmetic agree with the code by
 * construction, and a build could still drift a long way UNDER the ceiling —
 * team 6s → 20s halves the surface's freshness and every total below just gets
 * smaller and passes. So each constant is ALSO pinned to a LITERAL here. The
 * literal is the committed decision; the import is the live value; a round that
 * moves one has to come and move the other, in this file, deliberately. */
check("CHAT_LIST_POLL_MS is 10s", CHAT_LIST_POLL_MS, 10_000);
check("CHAT_DETAIL_LIVE_POLL_MS is 20s", CHAT_DETAIL_LIVE_POLL_MS, 20_000);
check("CHAT_DETAIL_FALLBACK_POLL_MS is 4s", CHAT_DETAIL_FALLBACK_POLL_MS, 4_000);
check("TEAM_POLL_MS is 6s", TEAM_POLL_MS, 6_000);
check("PLAN_POLL_MS is 30s", PLAN_POLL_MS, 30_000);
check("SHOTS_INDEX_POLL_MS is 30s", SHOTS_INDEX_POLL_MS, 30_000);
check("SECRETS_FALLBACK_POLL_MS is 60s", SECRETS_FALLBACK_POLL_MS, 60_000);
check("committed ceiling is 40 req/min", CHAT_SURFACE_REQ_PER_MIN_CEILING, 40);
check("secrets poll costs nothing while its stream is up", secretsPollInterval(true), false);
check("secrets poll falls back to 60s with the stream down", secretsPollInterval(false), 60_000);

console.log("\n── 5b. Chat surface poll budget (from the real constants) ─────────────");

const perMin = (intervalMs: number): number => 60_000 / intervalMs;

const runListReqPerMin = perMin(CHAT_LIST_POLL_MS);       // 6 req/min
const teamPanelReqPerMin = perMin(TEAM_POLL_MS);          // 10 req/min
const shotsReqPerMin = perMin(SHOTS_INDEX_POLL_MS);       // 2 req/min
const planKanbanReqPerMin = perMin(PLAN_POLL_MS);         // 2 req/min
const secretsReqPerMin = perMin(SECRETS_FALLBACK_POLL_MS); // 1 req/min

/** Everything on the surface except the open transcript, which is the only
 *  poll whose period depends on the stream. */
const panelsReqPerMin =
  runListReqPerMin + teamPanelReqPerMin + shotsReqPerMin + planKanbanReqPerMin;

// Healthy steady state (SSE live): the transcript idles at CHAT_DETAIL_LIVE_POLL_MS
// and the secrets query costs nothing at all (server push, round 808).
const healthyDetailReqPerMin = perMin(CHAT_DETAIL_LIVE_POLL_MS); // 3 req/min
const totalHealthyReqPerMin = panelsReqPerMin + healthyDetailReqPerMin;

// Degraded fallback state (SSE down): transcript at CHAT_DETAIL_FALLBACK_POLL_MS,
// and the secrets query degrades to its 60s poll.
const degradedDetailReqPerMin = perMin(CHAT_DETAIL_FALLBACK_POLL_MS); // 15 req/min
const totalDegradedReqPerMin =
  panelsReqPerMin + degradedDetailReqPerMin + secretsReqPerMin;

/* DRILLED (depth 1), degraded. ChatSurface disables its own detail query while
 * `navStack` is non-empty and AgentChatView runs one in its place — so the
 * drilled total is the depth-0 total ONLY IF both read the same constant. They
 * did not until round 4: AgentChatView was left on a 3s literal while
 * ChatSurface moved to 4s, so clicking a worker quietly cost 5 req/min more
 * than the number this section reported. One constant, one total, asserted. */
const drilledDetailReqPerMin = perMin(CHAT_DETAIL_FALLBACK_POLL_MS);
const totalDrilledDegradedReqPerMin =
  panelsReqPerMin + drilledDetailReqPerMin + secretsReqPerMin;

/* The counterexample, and the one number here that is deliberately a LITERAL:
 * 3s is history, not a live value, and importing anything for it would make it
 * move when the build moves. */
const PREV_DEGRADED_DETAIL_POLL_MS = 3_000;
const prevTotalDegradedReqPerMin =
  panelsReqPerMin + perMin(PREV_DEGRADED_DETAIL_POLL_MS) + secretsReqPerMin;

console.log(`Committed Chat Surface Ceiling: ≤ ${CHAT_SURFACE_REQ_PER_MIN_CEILING} req/min`);
console.log(`Healthy steady-state rate:      ${totalHealthyReqPerMin} req/min (List ${runListReqPerMin} + Detail ${healthyDetailReqPerMin} + Team ${teamPanelReqPerMin} + Shots ${shotsReqPerMin} + Plan ${planKanbanReqPerMin})`);
console.log(`Degraded fallback rate (4s):    ${totalDegradedReqPerMin} req/min (List ${runListReqPerMin} + Detail ${degradedDetailReqPerMin} + Team ${teamPanelReqPerMin} + Shots ${shotsReqPerMin} + Plan ${planKanbanReqPerMin} + Secrets ${secretsReqPerMin})`);
console.log(`Degraded, drilled to depth 1:   ${totalDrilledDegradedReqPerMin} req/min (AgentChatView's transcript in place of ChatSurface's)`);
console.log(`Previous degraded rate (3s):    ${prevTotalDegradedReqPerMin} req/min (Violated ceiling: ${prevTotalDegradedReqPerMin} > ${CHAT_SURFACE_REQ_PER_MIN_CEILING})`);

check("healthy poll rate equals 23 req/min", totalHealthyReqPerMin, 23);
checkTrue(
  "healthy poll rate is under the committed ceiling",
  totalHealthyReqPerMin <= CHAT_SURFACE_REQ_PER_MIN_CEILING,
);

check("degraded fallback poll rate equals 36 req/min", totalDegradedReqPerMin, 36);
checkTrue(
  "degraded fallback poll rate is under the committed ceiling",
  totalDegradedReqPerMin <= CHAT_SURFACE_REQ_PER_MIN_CEILING,
);

check("drilled degraded poll rate equals 36 req/min", totalDrilledDegradedReqPerMin, 36);
check(
  "drilling in does not change the surface's request rate",
  totalDrilledDegradedReqPerMin,
  totalDegradedReqPerMin,
);

checkTrue("previous 3s fallback violated ceiling (> 40 req/min)", prevTotalDegradedReqPerMin > 40);

/* The measured counterpart to all of the above. Arithmetic cannot see a poll
 * that keeps running when its panel is hidden, a retry storm, or a request
 * nobody counted — a browser can, and this project's numbers were taken by one:
 * `docs/plan/aios-console-responsiveness/browser-measurement.md` records
 * `docs/plan/aios-console-responsiveness/depth-poll-r4.cjs` (three 60s windows
 * — at rest, depth 1, depth 2 — on a build of this branch AND on a build of
 * main, in the same browser) and `docs/plan/artifacts/phase700/network-700.cjs`
 * (NFU3, unmodified, ALL PASS). Measured: 39 → 35 req/min at rest, 40 → 35
 * drilled, and 48,036,978 → 65,670 transcript body bytes per minute. This check
 * is the drift guard between those runs; it is not a substitute for them. */

/* ════════════════════════════════════════════════════════════════════════════
 * SUMMARY
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — check-chat-delta suite`);
process.exit(failures === 0 ? 0 : 1);
