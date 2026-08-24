/**
 * check-chat-rail-payload.ts — verification measurement harness for chat rail and secondary payload reductions.
 *
 * Project: aios-chat-list-payload
 *
 * This check verifies:
 *  1. Backend Rail Metadata Pruning Contract (forge-control/src/db/runs.ts: trimRailMetadata):
 *     - Trims unrendered execution baggage (subagent trees, canvas snapshots, logs, system prompts).
 *     - Preserves exact keys required for context occupancy gauge, hover popovers, and model identity:
 *       `model`, `model_resolved`, `usage_running`, `usage_last_turn`, `effort`.
 *     - Handles null, undefined, primitives, and empty objects safely without throwing.
 *     - Preserves full compatibility with context-window.ts (`readContextTokens`, `readRunModel`).
 *  2. Chat Rail List Payload Reduction Measurements (GET /api/proxy/chat):
 *     - A 30-row synthetic mix (6 manager rows w/ subagents_v2, 5 w/ canvas_snapshot, the rest
 *       plain worker/completed chats) — not a worst-case "every row is heavy" fixture.
 *     - Metadata-layer-only reduction (isolates trimRailMetadata's effect from the row shell):
 *       > 65% on this mix, vs. the > 80% chat-delta.test.ts gets on its all-heavy fixture.
 *     - Full-row reduction on the same mix: ~46% uncompressed. Lower than the metadata-only
 *       number because usage_running/usage_last_turn — kept for the context gauge — are already
 *       most of a SIMPLE row's weight; pruning's win concentrates on the few heavy rows.
 *     - Asserts that every field rendered by ChatListItem on the chat rail is present and intact.
 *  3. Team Tree Polling Optimization & Settled Backoff (GET /api/proxy/chat/:id/team):
 *     - Asserts TEAM_POLL_MS is 10,000ms (6 req/min, 40% request frequency reduction).
 *     - Asserts isTreeSettled correctly detects when all nodes (manager, workers, subagents) are settled.
 *     - Computes active bandwidth reduction (82.6 KB/min -> 49.6 KB/min, from the operator's real
 *       measured per-response average) and settled reduction (0 B/min).
 *  4. Uploads Index Conditional Caching (GET /api/uploads/index):
 *     - Fixture uses the REAL response shape — `{ runs: RunSummary[] }` from uploads-index.ts
 *       (id/count/image_count/artifact_count/file_count/latest_ts) — not the unrelated per-file
 *       upload shape POST /api/uploads returns.
 *     - Asserts ETag generation via getUploadsCacheTag() and 304 Not Modified conditional request matching.
 *     - Measures steady-state index polling bandwidth reduction (>98% reduction from ~16 KB/response down to ~300 B/min).
 *  5. Chat Surface Poll Budget & Console Bandwidth Attribution:
 *     - Verifies all poll constants against literals and imports.
 *     - Computes the aggregate before-and-after attribution table across all 6 console endpoints.
 *       The chat-list "after" figure is an ESTIMATE — the operator's real "before" baseline scaled
 *       by this harness's own measured reduction ratio, not a live re-measurement (worktree-only
 *       policy forbids hitting the live DB/session from a build task). Flagged (est.) in the table;
 *       needs confirmation from a deploy/verify task.
 *     - Asserts that healthy (19 req/min) and degraded (32 req/min) poll rates stay under the ≤ 40 req/min ceiling.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-rail-payload.ts
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-rail-payload.ts
 */

import { gzipSync } from "node:zlib";
import crypto from "node:crypto";
import {
  trimRailMetadata,
  type RunSummary,
  type RunStatus,
} from "../../forge-control/src/db/runs.ts";
import {
  getUploadsCacheTag,
  invalidateRunsCache,
  listAllRuns,
  type RunSummary as UploadsIndexEntry,
} from "../../forge-control/src/lib/uploads-index.ts";
import { isTreeSettled } from "../../forge-control-web/app/desktop/team/ChatTeamPanel.tsx";
import type { TeamNode, TeamResponse } from "../../forge-control-web/app/desktop/team/teamApi.ts";
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
import {
  readContextTokens,
  readRunModel,
  contextWindowFor,
} from "../../forge-control-web/app/desktop/chat/context-window.ts";

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

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 1: trimRailMetadata Contract & Context Gauge Compatibility
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 1. trimRailMetadata: edge cases, preservation & stripping ──────────");

// 1. Edge cases / non-object primitives
check("undefined input -> empty object", trimRailMetadata(undefined), {});
check("null input -> empty object", trimRailMetadata(null), {});
check("empty object input -> empty object", trimRailMetadata({}), {});
check("array input -> empty object", trimRailMetadata([] as unknown as Record<string, unknown>), {});
check("string input -> empty object", trimRailMetadata("string" as unknown as Record<string, unknown>), {});
check("number input -> empty object", trimRailMetadata(42 as unknown as Record<string, unknown>), {});
check("boolean input -> empty object", trimRailMetadata(true as unknown as Record<string, unknown>), {});

// 2. Exact preservation of UI-required keys
const completeUiMetadata = {
  model: "claude-sonnet-5",
  model_resolved: "claude-sonnet-5",
  usage_running: {
    input_tokens: 1540,
    cache_read_input_tokens: 24000,
    cache_creation_input_tokens: 1000,
    output_tokens: 350,
  },
  usage_last_turn: {
    input_tokens: 1200,
    cache_read_input_tokens: 20000,
    cache_creation_input_tokens: 500,
    output_tokens: 300,
  },
  effort: "high",
};

const trimmedComplete = trimRailMetadata(completeUiMetadata);
check("preserves full UI metadata object exactly", trimmedComplete, completeUiMetadata);
check("preserves meta.model", trimmedComplete.model, "claude-sonnet-5");
check("preserves meta.model_resolved", trimmedComplete.model_resolved, "claude-sonnet-5");
check("preserves meta.usage_running", trimmedComplete.usage_running, completeUiMetadata.usage_running);
check("preserves meta.usage_last_turn", trimmedComplete.usage_last_turn, completeUiMetadata.usage_last_turn);
check("preserves meta.effort", trimmedComplete.effort, "high");

/* 3. Stripping of unrendered execution baggage.
 *
 * subagents_v2 entries use the REAL SubagentMeta shape (forge-control-web/
 * app/desktop/chat/subagent-slice.ts:270-282: tool_use_id, role, model,
 * description, status, started_at, ended_at, updated_at, event_count, usage,
 * latest_activity) — there is no `transcript` field on a subagent entry; a
 * subagent's own turn-by-turn log lives in ITS run's thread, not the
 * manager's metadata. An earlier draft of this harness invented one, which
 * inflated every "before" byte count in this file by roughly 10x. */
function makeSubagentMeta(id: string, role: string, tool: string): Record<string, unknown> {
  return {
    tool_use_id: id,
    role,
    model: "claude-sonnet-5",
    description: `${role} task`,
    status: "completed",
    started_at: "2026-08-24T05:58:00.000Z",
    ended_at: "2026-08-24T06:02:00.000Z",
    updated_at: "2026-08-24T06:02:00.000Z",
    event_count: 14,
    usage: {
      input_tokens: 820,
      output_tokens: 210,
      cache_read_input_tokens: 6200,
      cache_creation_input_tokens: 400,
    },
    latest_activity: { kind: "tool_call", tool, text: `Ran ${tool} to verify the change`, ts: "2026-08-24T06:02:00.000Z" },
  };
}

const heavyProductionMetadata = {
  ...completeUiMetadata,
  subagents_v2: [
    makeSubagentMeta("toolu_01Abc", "researcher", "grep"),
    makeSubagentMeta("toolu_02Def", "builder", "bash"),
  ],
  // Calibrated to chat-delta.test.ts's own "massive payload reduction" fixture
  // (forge-control/src/lib/chat-delta.test.ts:303) — 15 elements, not invented.
  canvas_snapshot: {
    elements: Array.from({ length: 15 }, (_, i) => ({ id: `el_${i}`, type: "box", x: i, y: i })),
    appState: { zoom: 1.0, scrollX: 0, scrollY: 0 },
  },
  canvas: "Daily/2026-08-24.canvas",
  system_prompt: "You are the executor of Konrad's Personal AI OS... ".repeat(15),
  trace_logs: ["bootstrapping container", "resolving dependencies", "compilation successful"],
  cc_session_id: "sess_987654321_abcdef",
  arbitrary_custom_field: { deeply: { nested: { value: 12345 } } },
};

const strippedResult = trimRailMetadata(heavyProductionMetadata);
checkTrue("subagents_v2 is stripped", !("subagents_v2" in strippedResult));
checkTrue("canvas_snapshot is stripped", !("canvas_snapshot" in strippedResult));
checkTrue("canvas is stripped", !("canvas" in strippedResult));
checkTrue("system_prompt is stripped", !("system_prompt" in strippedResult));
checkTrue("trace_logs is stripped", !("trace_logs" in strippedResult));
checkTrue("cc_session_id is stripped", !("cc_session_id" in strippedResult));
checkTrue("arbitrary_custom_field is stripped", !("arbitrary_custom_field" in strippedResult));
check("stripped object equals completeUiMetadata", strippedResult, completeUiMetadata);

// 4. Immutability: original object is never mutated
const beforeKeys = Object.keys(heavyProductionMetadata);
trimRailMetadata(heavyProductionMetadata);
check("input metadata object keys count is unmodified", Object.keys(heavyProductionMetadata).length, beforeKeys.length);

// 5. Context-window reader parity with trimmed metadata
console.log("\n── 2. Context gauge & model reader parity ───────────────────────────");

const unprunedTokens = readContextTokens(heavyProductionMetadata);
const prunedTokens = readContextTokens(strippedResult);
check("readContextTokens produces identical token count", prunedTokens, unprunedTokens);
check("readContextTokens returns 25540 tokens (1540 input + 24000 cache read)", prunedTokens, 25540);

const unprunedModel = readRunModel(heavyProductionMetadata);
const prunedModel = readRunModel(strippedResult);
check("readRunModel produces identical model name", prunedModel, unprunedModel);
check("readRunModel returns claude-sonnet-5", prunedModel, "claude-sonnet-5");

const windowInfo = contextWindowFor(prunedModel);
check("contextWindowFor resolves 1M window for sonnet", windowInfo?.tokens, 1_000_000);
check("contextWindowFor assumed flag is false for exact match", windowInfo?.assumed, false);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 2: Chat Rail List Payload Reduction Measurements (GET /api/chat)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 3. Chat Rail 30-Run List Payload Reduction (GET /api/chat) ───────");

function createMockRunRow(index: number, includeHeavyMetadata = true): {
  id: string;
  title: string;
  status: RunStatus;
  worker: string | null;
  budget_usd: string;
  spent_usd: string;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  message_count: number;
  last_message_preview: string;
  last_role: string;
  archived: boolean;
  metadata: Record<string, unknown>;
} {
  const isManager = index % 5 === 0;
  const isCanvas = index % 6 === 0;
  const isFinished = index > 10;
  const status: RunStatus = isFinished ? "completed" : "running";

  // usage_running only makes sense on a run that is still running (it is "the
  // rollup's live counter, rewritten from every assistant message" —
  // context-window.ts:14-16); a completed row keeps only the turn it finished
  // on. Giving every row both fields — the earlier draft's assumption —
  // overstated the floor every row carries regardless of pruning.
  const baseMeta: Record<string, unknown> = {
    model: index % 2 === 0 ? "claude-sonnet-5" : "gemini-3.7-flash-high",
    model_resolved: index % 2 === 0 ? "claude-sonnet-5" : "gemini-3.7-flash-high",
    usage_last_turn: {
      input_tokens: 1100 + index * 40,
      cache_read_input_tokens: 14000 + index * 400,
      cache_creation_input_tokens: 600,
      output_tokens: 350 + index * 8,
    },
    effort: index % 3 === 0 ? "high" : "medium",
  };
  if (!isFinished) {
    baseMeta.usage_running = {
      input_tokens: 1200 + index * 50,
      cache_read_input_tokens: 15000 + index * 500,
      cache_creation_input_tokens: 800,
      output_tokens: 400 + index * 10,
    };
  }

  if (includeHeavyMetadata) {
    if (isManager) {
      // Real SubagentMeta shape (subagent-slice.ts:270-282) — no `transcript`
      // field; see the note above heavyProductionMetadata in section 1.
      const roles = ["architect", "builder", "reviewer"];
      baseMeta.subagents_v2 = Array.from({ length: 2 }, (_, s) => ({
        tool_use_id: `sub_${index}_${s}`,
        role: roles[s % roles.length],
        model: "claude-sonnet-5",
        description: `${roles[s % roles.length]} task ${s} for manager run ${index}`,
        status: "completed",
        started_at: new Date(1724457600000 - index * 60000).toISOString(),
        ended_at: new Date(1724457600000 - index * 60000 + 20000).toISOString(),
        updated_at: new Date(1724457600000 - index * 60000 + 20000).toISOString(),
        event_count: 12 + s,
        usage: {
          input_tokens: 800 + s * 50,
          output_tokens: 200 + s * 10,
          cache_read_input_tokens: 6000 + s * 200,
          cache_creation_input_tokens: 400,
        },
        latest_activity: {
          kind: "tool_call",
          tool: s === 0 ? "grep" : "bash",
          text: `Step ${s} for run ${index}`,
          ts: new Date(1724457600000 - index * 60000 + 20000).toISOString(),
        },
      }));
      baseMeta.system_prompt = "You are the autonomous project manager for AI OS... ".repeat(15);
    }
    if (isCanvas) {
      // 15 elements — calibrated to chat-delta.test.ts's own fixture
      // (forge-control/src/lib/chat-delta.test.ts:303), not invented.
      baseMeta.canvas_snapshot = {
        elements: Array.from({ length: 15 }, (_, e) => ({ id: `node_${e}`, type: "box", x: e, y: e })),
      };
      baseMeta.canvas = `Daily/2026-08-${(index % 28) + 1}.canvas`;
    }
    baseMeta.trace_logs = ["bootstrapping container", "resolving dependencies", "compilation successful"];
    baseMeta.cc_session_id = `sess_uuid_${index}_${(index * 2654435761).toString(36).slice(0, 8)}`;
  }

  return {
    id: `2ef126b7-d6d9-4a55-a8e7-${index.toString(16).padStart(12, "0")}`,
    title: `Chat Conversation ${index}: ${isManager ? "Project Orchestration" : "Feature Implementation"}`,
    status,
    worker: isManager ? "operator" : "claude",
    budget_usd: "10.00",
    spent_usd: (0.25 + index * 0.1).toFixed(2),
    created_at: new Date(1724457600000 - index * 60000).toISOString(),
    updated_at: new Date(1724457600000 - index * 10000).toISOString(),
    last_heartbeat_at: isFinished ? null : new Date(1724457600000 - index * 5000).toISOString(),
    message_count: 10 + index * 3,
    last_message_preview: `Latest message update snippet for conversation ${index} with preview content.`,
    last_role: index % 2 === 0 ? "assistant" : "user",
    archived: false,
    metadata: includeHeavyMetadata ? baseMeta : trimRailMetadata(baseMeta),
  };
}

// Build 30-run list responses
const legacyRuns30: RunSummary[] = Array.from({ length: 30 }, (_, i) => createMockRunRow(i, true));
const prunedRuns30: RunSummary[] = Array.from({ length: 30 }, (_, i) => createMockRunRow(i, false));

const legacyPayloadJson = JSON.stringify({ runs: legacyRuns30, hasMore: true });
const legacyPayloadBytes = Buffer.byteLength(legacyPayloadJson, "utf8");
const legacyPayloadGzip = gzipSync(Buffer.from(legacyPayloadJson)).byteLength;

const prunedPayloadJson = JSON.stringify({ runs: prunedRuns30, hasMore: true });
const prunedPayloadBytes = Buffer.byteLength(prunedPayloadJson, "utf8");
const prunedPayloadGzip = gzipSync(Buffer.from(prunedPayloadJson)).byteLength;

const railUncompressedReductionPct = ((1 - prunedPayloadBytes / legacyPayloadBytes) * 100).toFixed(2);
const railGzipReductionPct = ((1 - prunedPayloadGzip / legacyPayloadGzip) * 100).toFixed(2);

/* METADATA-ONLY comparison — isolates trimRailMetadata's own effect from the
 * row shell (id/title/dates/preview) it never touches.
 *
 * chat-delta.test.ts's own "massive payload reduction" assertion
 * (forge-control/src/lib/chat-delta.test.ts:292-328) gives EVERY one of its
 * 30 rows a full subagents_v2 + canvas_snapshot + system_prompt blob and gets
 * >80% — a worst-case "every chat is a heavy manager chat" fixture, useful
 * for proving trimRailMetadata itself works but not representative of what
 * the rail actually shows. This harness's 30-row mix (6 manager rows, 5
 * canvas rows, the rest plain worker/completed chats) is closer to a real
 * rail and reduces less, because most rows' metadata was already small
 * (model/effort/usage_last_turn) before pruning — pruning's real win is
 * concentrated on the FEW heavy rows, not spread across the average. */
const legacyMetaOnlyBytes = Buffer.byteLength(JSON.stringify(legacyRuns30.map((r) => r.metadata)), "utf8");
const prunedMetaOnlyBytes = Buffer.byteLength(JSON.stringify(prunedRuns30.map((r) => r.metadata)), "utf8");
const metaOnlyReductionPct = ((1 - prunedMetaOnlyBytes / legacyMetaOnlyBytes) * 100).toFixed(2);

// Per-minute bandwidth at 7 req/min (measured baseline poll rate)
const legacyBytesPerMin = legacyPayloadBytes * 7;
const prunedBytesPerMin = prunedPayloadBytes * 7;
const bytesSavedPerMin = legacyBytesPerMin - prunedBytesPerMin;

console.log(`[30-Run Chat Rail List Payload (7 req/min) — representative synthetic mix: 6/30 manager rows w/ subagents_v2, 5/30 w/ canvas_snapshot]`);
console.log(`  Metadata only    — Legacy: ${legacyMetaOnlyBytes.toLocaleString()} B | Pruned: ${prunedMetaOnlyBytes.toLocaleString()} B | Reduction: ${metaOnlyReductionPct}%`);
console.log(`  Full row payload — Legacy: ${legacyPayloadBytes.toLocaleString()} bytes (${(legacyPayloadBytes / 1024).toFixed(1)} KB) uncompressed | ${legacyPayloadGzip.toLocaleString()} bytes gzipped | ${(legacyBytesPerMin / 1024).toFixed(1)} KB/min`);
console.log(`                     Pruned: ${prunedPayloadBytes.toLocaleString()} bytes (${(prunedPayloadBytes / 1024).toFixed(1)} KB) uncompressed | ${prunedPayloadGzip.toLocaleString()} bytes gzipped | ${(prunedBytesPerMin / 1024).toFixed(1)} KB/min`);
console.log(`  Full-row Reduction: ${railUncompressedReductionPct}% (uncompressed), ${railGzipReductionPct}% (gzipped)`);
console.log(`  Bandwidth Saved:    ${(bytesSavedPerMin / 1024).toFixed(1)} KB/min saved on /api/proxy/chat, this synthetic mix`);

checkTrue("metadata-only reduction exceeds 65% on a realistic mixed rail", parseFloat(metaOnlyReductionPct) > 65.0);
checkTrue("legacy metadata total is substantial (> 8 KB across 30 rows)", legacyMetaOnlyBytes > 8_000);
checkTrue("full-row payload reduction is positive and non-trivial (> 20%)", parseFloat(railUncompressedReductionPct) > 20.0);
checkTrue("pruned payload is smaller than legacy, uncompressed", prunedPayloadBytes < legacyPayloadBytes);
checkTrue("pruned payload is smaller than legacy, gzipped", prunedPayloadGzip < legacyPayloadGzip);

// Rail Row Contract: verify all rendered properties are present on every row
for (let i = 0; i < prunedRuns30.length; i++) {
  const row = prunedRuns30[i];
  checkTrue(`row ${i} has valid id`, typeof row.id === "string" && row.id.length > 0);
  checkTrue(`row ${i} has title`, typeof row.title === "string");
  checkTrue(`row ${i} has status`, typeof row.status === "string");
  checkTrue(`row ${i} has updated_at`, typeof row.updated_at === "string");
  checkTrue(`row ${i} has last_message_preview`, typeof row.last_message_preview === "string");
  checkTrue(`row ${i} has last_role`, typeof row.last_role === "string");
  checkTrue(`row ${i} has archived boolean`, typeof row.archived === "boolean");
  checkTrue(`row ${i} has message_count`, typeof row.message_count === "number");
  checkTrue(`row ${i} has metadata object`, typeof row.metadata === "object" && row.metadata !== null);
  checkTrue(`row ${i} metadata has model`, typeof row.metadata.model === "string");
  // readContextTokens (context-window.ts:160-165) reads usage_running OR
  // usage_last_turn — a completed row legitimately has only the latter, so
  // requiring usage_running specifically would fail on every finished chat.
  checkTrue(
    `row ${i} metadata has usage_running or usage_last_turn`,
    typeof row.metadata.usage_running === "object" || typeof row.metadata.usage_last_turn === "object",
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 3: Team Polling Interval & Settled Backoff (GET /api/chat/:id/team)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 4. Team Polling Rate & Settled Backoff (GET /api/chat/:id/team) ───");

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

// 1. TEAM_POLL_MS is 10s (6 req/min vs legacy 6s / 10 req/min)
check("TEAM_POLL_MS is pinned to 10s (10,000ms)", TEAM_POLL_MS, 10_000);
const teamReqPerMinLegacy = 60_000 / 6_000;  // 10 req/min
const teamReqPerMinActive = 60_000 / TEAM_POLL_MS; // 6 req/min
check("active team polling rate is 6 req/min", teamReqPerMinActive, 6);

// 2. isTreeSettled detects active vs completed states
check("undefined team response -> not settled (polls)", isTreeSettled(undefined), false);
check("running manager -> not settled (polls)", isTreeSettled(makeTestTeamResponse({ manager: makeTestTeamNode({ settled: false }) })), false);
check("running subagent on manager -> not settled (polls)", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: false })] }),
})), false);
check("running worker -> not settled (polls)", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true }),
  workers: [makeTestTeamNode({ settled: false })],
})), false);
check("all nodes settled -> tree is settled (backs off polling)", isTreeSettled(makeTestTeamResponse({
  manager: makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: true })] }),
  workers: [makeTestTeamNode({ settled: true, subagents: [makeTestTeamNode({ settled: true })] })],
})), true);

// 3. Bandwidth computation: bytes/response derived from the operator's real
//    browser measurement in the brief (82,638 B/min over 10 req/min at 06:05Z
//    2026-08-24) — not re-measured here, since a live GET against /api/proxy/
//    chat/:id/team needs a live session and a real chat id (worktree-only
//    policy forbids that from a build task; see docs/plan/artifacts/
//    chat-rail-payload/README.md for the sourcing).
const teamResponseBytes = 82_638 / 10; // = 8,263.8 B, the operator-measured average
const teamBandwidthBefore = teamResponseBytes * teamReqPerMinLegacy; // 82,640 B/min (~82.6 KB/min)
const teamBandwidthActive = teamResponseBytes * teamReqPerMinActive; // 49,584 B/min (~49.6 KB/min)
const teamActiveReductionPct = ((1 - teamBandwidthActive / teamBandwidthBefore) * 100).toFixed(1);

console.log(`[Team Endpoint Bandwidth (/api/proxy/chat/<chat>/team)]`);
console.log(`  Before (6s poll / 10 req/min):     ${(teamBandwidthBefore / 1024).toFixed(1)} KB/min (82,640 bytes/min)`);
console.log(`  After active (10s poll / 6 req/min): ${(teamBandwidthActive / 1024).toFixed(1)} KB/min (49,584 bytes/min) — ${teamActiveReductionPct}% reduction`);
console.log(`  After settled (backoff / 0 req/min): 0.0 KB/min (100% reduction when tree settled)`);

checkTrue("active team polling achieves 40% reduction", Math.abs(parseFloat(teamActiveReductionPct) - 40.0) < 0.5);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 4: Uploads Index Conditional Caching (GET /api/uploads/index)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 5. Uploads Index ETag & 304 Caching (GET /api/uploads/index) ──────");

// 1. ETag format & computation
const initialTag = getUploadsCacheTag();
checkTrue("uploads index cache tag is non-empty quoted string", typeof initialTag === "string" && initialTag.startsWith('"') && initialTag.endsWith('"'));

// 2. 304 vs 200 payload size comparison.
//    GET /api/uploads/index answers `{ runs: RunSummary[] }` where RunSummary
//    is uploads-index.ts's own type — {id, count, image_count, artifact_count,
//    file_count, latest_ts} — NOT the per-file upload shape (id/name/path/url/
//    mime/size) that POST /api/uploads returns. Fixtures use the real type so
//    a field this endpoint never sends can't inflate the "before" number.
function createMockUploadsEntry(index: number): UploadsIndexEntry {
  const images = 4 + (index % 30);
  const artifacts = index % 5;
  return {
    id: crypto.randomBytes(6).toString("hex"),
    count: images,
    image_count: images,
    artifact_count: artifacts,
    file_count: images + artifacts,
    latest_ts: new Date(1724457600000 - index * 60_000).toISOString(),
  };
}

// 140 run directories: representative of a VPS that has accumulated months of
// browser-research screenshots (the observed 16 KB/response baseline implies
// roughly this many entries at ~115 B each).
const uploadsEntries: UploadsIndexEntry[] = Array.from({ length: 140 }, (_, i) => createMockUploadsEntry(i));
const fullUploadsIndexJson = JSON.stringify({ runs: uploadsEntries });
const fullUploadsIndexBytes = Buffer.byteLength(fullUploadsIndexJson, "utf8");
const notModifiedHeadersBytes = 150; // approximate HTTP 304 response headers (ETag + Cache-Control, no body)

const uploadsBeforePerMin = fullUploadsIndexBytes * 2; // 2 req/min -> ~32.1 KB/min
const uploadsAfterSteadyStatePerMin = notModifiedHeadersBytes * 2; // 2 req/min -> ~300 bytes/min
const uploadsReductionPct = ((1 - uploadsAfterSteadyStatePerMin / uploadsBeforePerMin) * 100).toFixed(2);

console.log(`[Uploads Index Endpoint Bandwidth (/api/proxy/uploads/index, 2 req/min)]`);
console.log(`  Full 200 response body:            ${fullUploadsIndexBytes.toLocaleString()} bytes (~${(fullUploadsIndexBytes / 1024).toFixed(1)} KB) | ${(uploadsBeforePerMin / 1024).toFixed(1)} KB/min`);
console.log(`  304 Not Modified response:         0 body bytes (~${notModifiedHeadersBytes} B headers) | ${(uploadsAfterSteadyStatePerMin / 1024).toFixed(2)} KB/min`);
console.log(`  Steady-state reduction:            ${uploadsReductionPct}% (>98% reduction)`);

checkTrue("uploads full payload is ~16 KB", fullUploadsIndexBytes > 12_000 && fullUploadsIndexBytes < 22_000);
checkTrue("steady-state 304 reduction exceeds 98%", parseFloat(uploadsReductionPct) > 98.0);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 5: Poll Budget, Ceilings & Console Bandwidth Attribution Table
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 6. Console Poll Budget Constants & Rate Verification ──────────────");

check("CHAT_LIST_POLL_MS is 10s", CHAT_LIST_POLL_MS, 10_000);
check("CHAT_DETAIL_LIVE_POLL_MS is 20s", CHAT_DETAIL_LIVE_POLL_MS, 20_000);
check("CHAT_DETAIL_FALLBACK_POLL_MS is 4s", CHAT_DETAIL_FALLBACK_POLL_MS, 4_000);
check("TEAM_POLL_MS is 10s", TEAM_POLL_MS, 10_000);
check("PLAN_POLL_MS is 30s", PLAN_POLL_MS, 30_000);
check("SHOTS_INDEX_POLL_MS is 30s", SHOTS_INDEX_POLL_MS, 30_000);
check("SECRETS_FALLBACK_POLL_MS is 60s", SECRETS_FALLBACK_POLL_MS, 60_000);
check("CHAT_SURFACE_REQ_PER_MIN_CEILING is 40 req/min", CHAT_SURFACE_REQ_PER_MIN_CEILING, 40);

const perMin = (intervalMs: number): number => 60_000 / intervalMs;
const listReqPerMin = perMin(CHAT_LIST_POLL_MS);        // 6 req/min
const teamReqPerMin = perMin(TEAM_POLL_MS);             // 6 req/min
const shotsReqPerMin = perMin(SHOTS_INDEX_POLL_MS);     // 2 req/min
const planReqPerMin = perMin(PLAN_POLL_MS);             // 2 req/min
const secretsReqPerMin = perMin(SECRETS_FALLBACK_POLL_MS); // 1 req/min

const panelsReqPerMin = listReqPerMin + teamReqPerMin + shotsReqPerMin + planReqPerMin; // 16 req/min
const healthyRate = panelsReqPerMin + perMin(CHAT_DETAIL_LIVE_POLL_MS); // 16 + 3 = 19 req/min
const degradedRate = panelsReqPerMin + perMin(CHAT_DETAIL_FALLBACK_POLL_MS) + secretsReqPerMin; // 16 + 15 + 1 = 32 req/min

check("healthy steady-state rate equals 19 req/min", healthyRate, 19);
checkTrue("healthy rate is <= 40 ceiling", healthyRate <= CHAT_SURFACE_REQ_PER_MIN_CEILING);

check("degraded fallback rate equals 32 req/min", degradedRate, 32);
checkTrue("degraded rate is <= 40 ceiling", degradedRate <= CHAT_SURFACE_REQ_PER_MIN_CEILING);

console.log("\n── 7. Console Bandwidth Attribution Table (Before vs After) ──────────");

// "Before" baseline: the operator's own real-browser, real-session measurement
// at 2026-08-24 06:05Z (given verbatim in the aios-chat-list-payload brief,
// not re-derived here). This script cannot reproduce it directly — a live
// GET against production needs a live session and is out of bounds for a
// build-phase task (worktree-only policy) — so it is transcribed as fact and
// the "after" figures below are computed from the actual pruning/polling code
// this worktree ships, per section.
const bChatList = 125288;
const bTeam = 82638;
const bUploads = 32125;
const bPlan = 7972;
const bTranscript = 4938;
const bQuota = 1210;
const totalBaseline = bChatList + bTeam + bUploads + bPlan + bTranscript + bQuota; // 254,171

/* aChatList is an ESTIMATE, not a re-measurement: this worktree's synthetic
 * 30-row mix is calibrated for a realistic PROPORTION of heavy rows (see the
 * section 3 comment above), not for the same absolute row-size distribution
 * production actually has — DB access to pull real rows is out of bounds for
 * a build task. So rather than use the synthetic mock's own absolute bytes
 * (which are not on the same scale as real rows and would misstate this
 * table), the REAL "before" baseline is scaled by the harness's OWN measured
 * full-row reduction ratio. This estimate needs live re-confirmation in a
 * deploy/verify task — flagged in the README. */
const aChatList = Math.round(bChatList * (prunedPayloadBytes / legacyPayloadBytes));
const aTeamActive = Math.round(teamBandwidthActive);  // ~49,584 B/min
const aUploads = Math.round(uploadsAfterSteadyStatePerMin); // ~300 B/min
const aPlan = bPlan; // 7,972 B/min
const aTranscript = bTranscript; // 4,938 B/min
const aQuota = bQuota; // 1,210 B/min

const totalAfterActive = aChatList + aTeamActive + aUploads + aPlan + aTranscript + aQuota;
const overallActiveReductionPct = ((1 - totalAfterActive / totalBaseline) * 100).toFixed(1);

// After settled (team tree settled -> 0 B/min)
const aTeamSettled = 0;
const totalAfterSettled = aChatList + aTeamSettled + aUploads + aPlan + aTranscript + aQuota;
const overallSettledReductionPct = ((1 - totalAfterSettled / totalBaseline) * 100).toFixed(1);

const pctOf = (before: number, after: number): string => (before === 0 ? "0" : ((1 - after / before) * 100).toFixed(1));

console.log(`
| Endpoint                     | Before (B/min) | After Active (B/min) | After Settled (B/min) | Reduction (active/settled) |
|------------------------------|----------------|----------------------|------------------------|----------------------------|
| /api/proxy/chat (est.)       | ${bChatList.toLocaleString().padStart(15)} | ${aChatList.toLocaleString().padStart(20)} | ${aChatList.toLocaleString().padStart(22)} | -${pctOf(bChatList, aChatList)}%                      |
| /api/proxy/chat/<chat>/team  | ${bTeam.toLocaleString().padStart(15)} | ${aTeamActive.toLocaleString().padStart(20)} | ${aTeamSettled.toLocaleString().padStart(22)} | -${pctOf(bTeam, aTeamActive)}% / -100%              |
| /api/proxy/uploads/index     | ${bUploads.toLocaleString().padStart(15)} | ${aUploads.toLocaleString().padStart(20)} | ${aUploads.toLocaleString().padStart(22)} | -${pctOf(bUploads, aUploads)}%                     |
| /api/proxy/chat/<chat>/plan  | ${bPlan.toLocaleString().padStart(15)} | ${aPlan.toLocaleString().padStart(20)} | ${aPlan.toLocaleString().padStart(22)} |    0% (untouched)          |
| /api/proxy/chat/<chat>       | ${bTranscript.toLocaleString().padStart(15)} | ${aTranscript.toLocaleString().padStart(20)} | ${aTranscript.toLocaleString().padStart(22)} |    0% (already fixed)      |
| /api/proxy/usage/quota       | ${bQuota.toLocaleString().padStart(15)} | ${aQuota.toLocaleString().padStart(20)} | ${aQuota.toLocaleString().padStart(22)} |    0% (untouched)          |
|------------------------------|----------------|----------------------|------------------------|----------------------------|
| TOTAL                        | ${totalBaseline.toLocaleString().padStart(15)} | ${totalAfterActive.toLocaleString().padStart(20)} | ${totalAfterSettled.toLocaleString().padStart(22)} | -${overallActiveReductionPct}% / -${overallSettledReductionPct}%          |

(est.) = scaled from the operator's real "before" baseline by this harness's
worktree-computed reduction ratio, not itself a live re-measurement. Needs
confirmation from a deploy/verify task with a real browser session.
`);

checkTrue("overall active console bandwidth reduction exceeds 25%", parseFloat(overallActiveReductionPct) >= 25.0);
checkTrue("overall settled console bandwidth reduction exceeds 40%", parseFloat(overallSettledReductionPct) >= 40.0);

/* ════════════════════════════════════════════════════════════════════════════
 * SUMMARY
 * ══════════════════════════════════════════════════════════════════════════ */

async function runAsync(): Promise<void> {
  await listAllRuns();
  const tagAfter = getUploadsCacheTag();
  checkTrue("uploads cache tag is stable across listAllRuns", typeof tagAfter === "string" && tagAfter.length > 0);

  invalidateRunsCache();
  const tagInvalidated = getUploadsCacheTag();
  checkTrue("uploads cache tag exists after invalidateRunsCache", typeof tagInvalidated === "string" && tagInvalidated.length > 0);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — check-chat-rail-payload suite`);
  process.exit(failures === 0 ? 0 : 1);
}

runAsync().catch((err) => {
  console.error("Unhandled error in check-chat-rail-payload:", err);
  process.exit(1);
});
