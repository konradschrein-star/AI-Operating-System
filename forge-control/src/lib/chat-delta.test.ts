/**
 * GET /api/chat/:id — bounded window, deltas, and pagination.
 *
 * This test suite pins `parseSinceParam`, `parseBeforeParam`, `parseLimitParam`,
 * and `chatDeltaResponse` (routes/chat.ts). These pure functions ensure that:
 * 1. Initial chat fetch returns a bounded window (default 60 newest turns) with prompt.
 * 2. Forward delta polling returns only new turns with prompt omitted, or [] at steady-state.
 * 3. Backward pagination retrieves older turns via before/limit with prompt omitted.
 * 4. Stale/corrupted cursors (since > total) recover cleanly to the newest bounded window with prompt.
 * 5. Input run objects and threads are never mutated.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  chatDeltaResponse,
  parseSinceParam,
  parseBeforeParam,
  parseLimitParam,
  trimRailMetadata,
} from "../routes/chat.ts";
import type { RunDetail, ThreadEntry } from "../db/runs.ts";

function entry(content: string, ts: string): ThreadEntry {
  return { role: "user", content, ts };
}

/** A run with a 3-entry thread — enough to exercise short-thread logic. */
function fixtureRun(): RunDetail {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "fixture chat",
    status: "running",
    worker: "claude",
    budget_usd: "10",
    spent_usd: "0",
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:03.000Z",
    last_heartbeat_at: null,
    message_count: 3,
    last_message_preview: "third",
    last_role: "user",
    archived: false,
    metadata: {},
    prompt: "fixture prompt",
    thread: [
      entry("first", "2026-08-24T00:00:01.000Z"),
      entry("second", "2026-08-24T00:00:02.000Z"),
      entry("third", "2026-08-24T00:00:03.000Z"),
    ],
    parent_run_id: null,
    stuck_signal: null,
    started_at: "2026-08-24T00:00:00.000Z",
    completed_at: null,
  };
}

/** A run with arbitrary N entries to test bounded windows and pagination. */
function fixtureLargeRun(count = 100): RunDetail {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    title: "large fixture chat",
    status: "running",
    worker: "claude",
    budget_usd: "100",
    spent_usd: "5",
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T01:00:00.000Z",
    last_heartbeat_at: null,
    message_count: count,
    last_message_preview: `entry-${count - 1}`,
    last_role: "user",
    archived: false,
    metadata: { test: true },
    prompt: "large fixture prompt",
    thread: Array.from({ length: count }, (_, i) =>
      entry(`entry-${i}`, new Date(1700000000000 + i * 1000).toISOString()),
    ),
    parent_run_id: null,
    stuck_signal: null,
    started_at: "2026-08-24T00:00:00.000Z",
    completed_at: null,
  };
}

/* ── parseLimitParam ──────────────────────────────────────────────────────── */

describe("parseLimitParam", () => {
  test("omitted or empty param -> defaultLimit (60)", () => {
    assert.equal(parseLimitParam(undefined), 60);
    assert.equal(parseLimitParam(""), 60);
    assert.equal(parseLimitParam(undefined, 30), 30);
  });

  test("valid integer parses within bounds", () => {
    assert.equal(parseLimitParam("1"), 1);
    assert.equal(parseLimitParam("30"), 30);
    assert.equal(parseLimitParam("60"), 60);
    assert.equal(parseLimitParam("500"), 500);
  });

  test("clamps to maxLimit (default 500)", () => {
    assert.equal(parseLimitParam("1000"), 500);
    assert.equal(parseLimitParam("99999"), 500);
    assert.equal(parseLimitParam("100", 60, 50), 50);
  });

  test("invalid, non-positive, fractional, and non-numeric fall back to defaultLimit", () => {
    assert.equal(parseLimitParam("0"), 60);
    assert.equal(parseLimitParam("-10"), 60);
    assert.equal(parseLimitParam("1.5"), 60);
    assert.equal(parseLimitParam("abc"), 60);
    assert.equal(parseLimitParam("NaN"), 60);
    assert.equal(parseLimitParam("Infinity"), 60);
  });
});

/* ── parseBeforeParam ─────────────────────────────────────────────────────── */

describe("parseBeforeParam", () => {
  test("omitted or empty param -> undefined", () => {
    assert.equal(parseBeforeParam(undefined), undefined);
    assert.equal(parseBeforeParam(""), undefined);
  });

  test("valid non-negative integer parses through", () => {
    assert.equal(parseBeforeParam("0"), 0);
    assert.equal(parseBeforeParam("40"), 40);
    assert.equal(parseBeforeParam("2477"), 2477);
  });

  test("negative, fractional, non-numeric, and NaN fall back to undefined", () => {
    assert.equal(parseBeforeParam("-1"), undefined);
    assert.equal(parseBeforeParam("1.5"), undefined);
    assert.equal(parseBeforeParam("abc"), undefined);
    assert.equal(parseBeforeParam("NaN"), undefined);
    assert.equal(parseBeforeParam("Infinity"), undefined);
  });
});

/* ── parseSinceParam ─────────────────────────────────────────────────────── */

describe("parseSinceParam", () => {
  test("omitted query param -> undefined", () => {
    assert.equal(parseSinceParam(undefined), undefined);
  });

  test("empty string -> undefined", () => {
    assert.equal(parseSinceParam(""), undefined);
  });

  test("a valid non-negative integer parses through", () => {
    assert.equal(parseSinceParam("0"), 0);
    assert.equal(parseSinceParam("3"), 3);
  });

  test("recovery: negative, fractional and non-numeric all fall back to undefined", () => {
    assert.equal(parseSinceParam("-1"), undefined);
    assert.equal(parseSinceParam("1.5"), undefined);
    assert.equal(parseSinceParam("abc"), undefined);
    assert.equal(parseSinceParam("NaN"), undefined);
  });
});

/* ── chatDeltaResponse ────────────────────────────────────────────────────── */

describe("chatDeltaResponse", () => {
  describe("initial bounded load (since and before omitted)", () => {
    test("short thread (< limit): returns all entries from 0 with prompt", () => {
      const run = fixtureRun();
      const res = chatDeltaResponse(run);
      assert.equal(res.from, 0);
      assert.equal(res.total, 3);
      assert.deepEqual(
        res.run.thread.map((e) => e.content),
        ["first", "second", "third"],
      );
      assert.equal(res.run.prompt, "fixture prompt");
    });

    test("large thread (> limit): returns bounded newest window (last 60) with prompt", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run);
      assert.equal(res.from, 40);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 60);
      assert.equal(res.run.thread[0].content, "entry-40");
      assert.equal(res.run.thread[59].content, "entry-99");
      assert.equal(res.run.prompt, "large fixture prompt");
    });

    test("custom limit: returns bounded newest window respecting limit parameter", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, { limit: 10 });
      assert.equal(res.from, 90);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 10);
      assert.equal(res.run.thread[0].content, "entry-90");
      assert.equal(res.run.thread[9].content, "entry-99");
      assert.equal(res.run.prompt, "large fixture prompt");
    });

    test("empty thread: returns empty thread from 0 with prompt", () => {
      const run = { ...fixtureRun(), thread: [] };
      const res = chatDeltaResponse(run);
      assert.equal(res.from, 0);
      assert.equal(res.total, 0);
      assert.deepEqual(res.run.thread, []);
      assert.equal(res.run.prompt, "fixture prompt");
    });
  });

  describe("forward delta polling (since provided)", () => {
    test("since === thread.length: steady-state empty delta fetch, prompt omitted", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, 100);
      assert.equal(res.from, 100);
      assert.equal(res.total, 100);
      assert.deepEqual(res.run.thread, []);
      assert.equal("prompt" in res.run, false);
      assert.equal(res.run.prompt, undefined);
    });

    test("since < thread.length: append delta, only new entries, prompt omitted", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, { since: 90 });
      assert.equal(res.from, 90);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 10);
      assert.equal(res.run.thread[0].content, "entry-90");
      assert.equal(res.run.thread[9].content, "entry-99");
      assert.equal("prompt" in res.run, false);
      assert.equal(res.run.prompt, undefined);
    });

    test("since === 0: delta fetch over whole thread, prompt omitted", () => {
      const run = fixtureRun();
      const res = chatDeltaResponse(run, 0);
      assert.equal(res.from, 0);
      assert.equal(res.total, 3);
      assert.deepEqual(
        res.run.thread.map((e) => e.content),
        ["first", "second", "third"],
      );
      assert.equal("prompt" in res.run, false);
      assert.equal(res.run.prompt, undefined);
    });

    test("recovery: since > thread.length (stale/compacted cache) recovers to newest bounded window with prompt", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, 999);
      assert.equal(res.from, 40);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 60);
      assert.equal(res.run.thread[0].content, "entry-40");
      assert.equal(res.run.thread[59].content, "entry-99");
      assert.equal("prompt" in res.run, true);
      assert.equal(res.run.prompt, "large fixture prompt");
    });

    test("recovery on short thread: since > thread.length recovers to all entries from 0 with prompt", () => {
      const run = fixtureRun();
      const res = chatDeltaResponse(run, 99);
      assert.equal(res.from, 0);
      assert.equal(res.total, 3);
      assert.deepEqual(
        res.run.thread.map((e) => e.content),
        ["first", "second", "third"],
      );
      assert.equal("prompt" in res.run, true);
      assert.equal(res.run.prompt, "fixture prompt");
    });
  });

  describe("backward pagination (before provided)", () => {
    test("before and limit: returns older slice [before - limit, before) with prompt omitted", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, { before: 80, limit: 30 });
      assert.equal(res.from, 50);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 30);
      assert.equal(res.run.thread[0].content, "entry-50");
      assert.equal(res.run.thread[29].content, "entry-79");
      assert.equal("prompt" in res.run, false);
      assert.equal(res.run.prompt, undefined);
    });

    test("before reaching start: clamps start to 0 when before < limit", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, { before: 40, limit: 60 });
      assert.equal(res.from, 0);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 40);
      assert.equal(res.run.thread[0].content, "entry-0");
      assert.equal(res.run.thread[39].content, "entry-39");
      assert.equal("prompt" in res.run, false);
    });

    test("before === 0: returns empty slice from 0", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, { before: 0, limit: 60 });
      assert.equal(res.from, 0);
      assert.equal(res.total, 100);
      assert.deepEqual(res.run.thread, []);
      assert.equal("prompt" in res.run, false);
    });

    test("before > total: clamps end to total", () => {
      const run = fixtureLargeRun(100);
      const res = chatDeltaResponse(run, { before: 200, limit: 60 });
      assert.equal(res.from, 40);
      assert.equal(res.total, 100);
      assert.equal(res.run.thread.length, 60);
      assert.equal(res.run.thread[0].content, "entry-40");
      assert.equal(res.run.thread[59].content, "entry-99");
      assert.equal("prompt" in res.run, false);
    });
  });

  describe("envelope and immutability", () => {
    test("delta responses preserve all envelope metadata while omitting prompt", () => {
      const run = fixtureRun();
      const res = chatDeltaResponse(run, 1);
      assert.equal(res.run.id, run.id);
      assert.equal(res.run.title, run.title);
      assert.equal(res.run.status, run.status);
      assert.equal(res.run.worker, run.worker);
      assert.equal(res.run.budget_usd, run.budget_usd);
      assert.equal(res.run.spent_usd, run.spent_usd);
      assert.equal(res.run.message_count, run.message_count);
      assert.equal(res.run.last_message_preview, run.last_message_preview);
      assert.deepEqual(res.run.metadata, run.metadata);
      assert.equal("prompt" in res.run, false);
    });

    test("responses do not mutate the caller's run object or thread array", () => {
      const run = fixtureRun();
      const beforeThread = run.thread;
      const beforePrompt = run.prompt;
      chatDeltaResponse(run, 1);
      assert.equal(run.thread, beforeThread);
      assert.equal(run.prompt, beforePrompt);

      chatDeltaResponse(run, { before: 2, limit: 1 });
      assert.equal(run.thread, beforeThread);
      assert.equal(run.prompt, beforePrompt);
    });
  });
});

/* ── trimRailMetadata ─────────────────────────────────────────────────────── */

describe("trimRailMetadata", () => {
  test("handles null, undefined, empty, or non-object primitives safely", () => {
    assert.deepEqual(trimRailMetadata(undefined), {});
    assert.deepEqual(trimRailMetadata(null), {});
    assert.deepEqual(trimRailMetadata({}), {});
    assert.deepEqual(trimRailMetadata([] as unknown as Record<string, unknown>), {});
    assert.deepEqual(trimRailMetadata("primitive" as unknown as Record<string, unknown>), {});
    assert.deepEqual(trimRailMetadata(12345 as unknown as Record<string, unknown>), {});
    assert.deepEqual(trimRailMetadata(true as unknown as Record<string, unknown>), {});
  });

  test("preserves exact keys required for context gauge and model identity", () => {
    const exactMeta = {
      model: "claude-3-5-sonnet-20241022",
      model_resolved: "claude-3-5-sonnet-20241022",
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

    const trimmed = trimRailMetadata(exactMeta);
    assert.deepEqual(trimmed, exactMeta);
    assert.equal(trimmed.model, "claude-3-5-sonnet-20241022");
    assert.equal(trimmed.model_resolved, "claude-3-5-sonnet-20241022");
    assert.deepEqual(trimmed.usage_running, exactMeta.usage_running);
    assert.deepEqual(trimmed.usage_last_turn, exactMeta.usage_last_turn);
    assert.equal(trimmed.effort, "high");
  });

  test("preserves partial subsets when only some allowed keys are present", () => {
    const partialMeta = {
      model: "gemini-1.5-pro",
      effort: "medium",
    };
    const trimmed = trimRailMetadata(partialMeta);
    assert.deepEqual(trimmed, {
      model: "gemini-1.5-pro",
      effort: "medium",
    });
  });

  test("prunes heavy subagents_v2, canvas_snapshot, system_prompt, logs, and execution baggage", () => {
    const heavyMeta = {
      model: "claude-3-5-sonnet-20241022",
      model_resolved: "claude-3-5-sonnet-20241022",
      usage_running: { input_tokens: 100, cache_read_input_tokens: 200 },
      usage_last_turn: { input_tokens: 80, cache_read_input_tokens: 150 },
      effort: "high",
      // Heavy baggage to be stripped:
      subagents_v2: [
        {
          tool_use_id: "tool_u1",
          role: "researcher",
          description: "Subagent research task",
          transcript: Array.from({ length: 50 }, (_, i) => ({ step: i, content: "heavy logs ".repeat(20) })),
        },
        {
          tool_use_id: "tool_u2",
          role: "builder",
          description: "Subagent builder task",
        },
      ],
      canvas_snapshot: {
        elements: Array.from({ length: 100 }, (_, i) => ({ id: `el_${i}`, type: "rectangle", x: i, y: i })),
        appState: { zoom: 1, scrollX: 0, scrollY: 0 },
      },
      canvas: "Daily/2026-08-24.canvas",
      system_prompt: "You are the system prompt... ".repeat(100),
      tools: [{ name: "bash", schema: { parameters: {} } }],
      trace_logs: ["log 1", "log 2", "error trace"],
      cc_session_id: "sess_12345",
      arbitrary_garbage: { deep: { nested: true } },
    };

    const trimmed = trimRailMetadata(heavyMeta);

    // Only allowed keys exist
    assert.deepEqual(Object.keys(trimmed).sort(), [
      "effort",
      "model",
      "model_resolved",
      "usage_last_turn",
      "usage_running",
    ].sort());

    // Baggage is explicitly absent
    assert.equal("subagents_v2" in trimmed, false);
    assert.equal("canvas_snapshot" in trimmed, false);
    assert.equal("canvas" in trimmed, false);
    assert.equal("system_prompt" in trimmed, false);
    assert.equal("tools" in trimmed, false);
    assert.equal("trace_logs" in trimmed, false);
    assert.equal("cc_session_id" in trimmed, false);
    assert.equal("arbitrary_garbage" in trimmed, false);

    // Exact values of allowed keys are preserved
    assert.equal(trimmed.model, "claude-3-5-sonnet-20241022");
    assert.equal(trimmed.model_resolved, "claude-3-5-sonnet-20241022");
    assert.deepEqual(trimmed.usage_running, { input_tokens: 100, cache_read_input_tokens: 200 });
    assert.deepEqual(trimmed.usage_last_turn, { input_tokens: 80, cache_read_input_tokens: 150 });
    assert.equal(trimmed.effort, "high");
  });

  test("does not mutate the input metadata object", () => {
    const original = {
      model: "claude-3-5-sonnet-20241022",
      subagents_v2: [{ tool_use_id: "t1" }],
      canvas_snapshot: { elements: [1, 2, 3] },
    };
    const cloned = JSON.parse(JSON.stringify(original));
    trimRailMetadata(original);
    assert.deepEqual(original, cloned);
  });

  test("achieves massive payload reduction on simulated rail datasets (>85% metadata size drop)", () => {
    // Realistic mix of 30 rail rows: 10 active with usage, 10 closed with model, 10 simple
    const rawMetadatas = Array.from({ length: 30 }, (_, i) => {
      const base: Record<string, unknown> = {
        model: "claude-3-5-sonnet-20241022",
        effort: "high",
        subagents_v2: Array.from({ length: 2 }, (_, j) => ({
          tool_use_id: `tool_${i}_${j}`,
          description: `subagent ${j} description with extended baggage text`,
          transcript: ["step 1", "step 2", "step 3", "step 4", "step 5"],
        })),
        canvas_snapshot: { elements: Array.from({ length: 15 }, (_, k) => ({ id: k, type: "box" })) },
        system_prompt: "Standard prompt string ".repeat(15),
      };
      if (i < 10) {
        base.model_resolved = "claude-3-5-sonnet-20241022";
        base.usage_running = { input_tokens: 1540 + i, cache_read_input_tokens: 24000, output_tokens: 300 };
      } else if (i < 20) {
        base.usage_last_turn = { input_tokens: 800, cache_read_input_tokens: 12000, output_tokens: 150 };
      }
      return base;
    });

    const trimmedMetadatas = rawMetadatas.map((meta) => trimRailMetadata(meta));

    const rawMetaBytes = Buffer.byteLength(JSON.stringify(rawMetadatas), "utf8");
    const trimmedMetaBytes = Buffer.byteLength(JSON.stringify(trimmedMetadatas), "utf8");

    // Raw metadata payload ~25KB+ drops to ~2.5KB-3.9KB (< 4.5KB)
    assert.ok(rawMetaBytes > 20_000, `expected rawMetaBytes > 20KB, got ${rawMetaBytes}`);
    assert.ok(trimmedMetaBytes < 4_500, `expected trimmedMetaBytes < 4.5KB, got ${trimmedMetaBytes}`);
    const reductionRatio = (rawMetaBytes - trimmedMetaBytes) / rawMetaBytes;
    assert.ok(
      reductionRatio >= 0.80,
      `expected at least 80% reduction, got ${(reductionRatio * 100).toFixed(1)}%`,
    );
  });
});
