/**
 * Round 1871 — the two API-side findings from the round-1870 customer test.
 *
 * FINDING 5, "sub-agent rows are blank": 7 of 8 rows showed role `agent`,
 * `(no description)`, model `—` and `0` tokens. The cause was not missing
 * data. `meta.input` on a Task/Agent spawn is the tool's JSON arguments, and
 * the executor stores it CLIPPED AT 1500 CHARACTERS; the `prompt` argument is
 * routinely longer, so `JSON.parse` threw and the catch dropped the role and
 * the description on the floor. Measured on chat 11dd264b: six of seven inputs
 * are exactly 1501 chars, the seventh is 1203 and parses — which is why
 * exactly one row said `scout` and the rest said `agent`.
 *
 * FINDING 3, "the chat shows another project's team": chat bfd1283a owns
 * `operator-visibility` (active, 5 Aug) and `engine-task-graph` (paused, 17
 * Aug). "Newest wins" served the paused one.
 *
 * Both fixes are pure functions on purpose, so this file needs no database.
 * The fixtures below are the real shapes, trimmed: `CLIPPED_SPAWN` is the
 * first 1501 characters of the real `toolu_01S2khB7` payload's structure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  foldSubagents,
  readSpawnField,
  subagentsFromRollup,
} from "../routes/agents-shared.ts";
import { rankCandidates, statusRank } from "../routes/chat-linkage.ts";
import type { ThreadEntry } from "../db/runs.ts";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** A whole payload, small enough that the clip never touched it. */
const WHOLE_SPAWN = JSON.stringify({
  description: "Recon forge-control command + agent infra",
  subagent_type: "scout",
  prompt: "Recon in /opt/forge-ai-os. Report concisely with absolute paths.",
});

/**
 * The failing shape. Built by clipping a real-length payload at 1500 chars and
 * appending the ellipsis the executor writes, so the test breaks for the same
 * reason production did rather than for a hand-made one.
 */
const CLIPPED_SPAWN =
  JSON.stringify({
    description: "Research planning/brainstorm flow",
    subagent_type: "architect",
    prompt: `You are designing the planning system. ${"x".repeat(4000)}`,
  }).slice(0, 1500) + "…";

function spawnEntry(toolUseId: string, input: string, ts: string): ThreadEntry {
  return {
    role: "assistant",
    kind: "tool_call",
    content: "",
    ts,
    meta: { tool: "Agent", tool_use_id: toolUseId, input },
  } as ThreadEntry;
}

function resultEntry(toolUseId: string, ts: string): ThreadEntry {
  return {
    role: "user",
    kind: "tool_result",
    content: "ok",
    ts,
    meta: { tool_use_id: toolUseId },
  } as ThreadEntry;
}

/* ── readSpawnField ───────────────────────────────────────────────────────── */

describe("readSpawnField — clipped spawn arguments", () => {
  test("reads a whole payload through JSON.parse", () => {
    assert.equal(readSpawnField(WHOLE_SPAWN, "subagent_type"), "scout");
    assert.equal(
      readSpawnField(WHOLE_SPAWN, "description"),
      "Recon forge-control command + agent infra",
    );
  });

  test("THE BUG: the clipped payload is not valid JSON", () => {
    assert.throws(() => JSON.parse(CLIPPED_SPAWN) as unknown);
  });

  test("THE FIX: both fields survive the clip", () => {
    assert.equal(readSpawnField(CLIPPED_SPAWN, "subagent_type"), "architect");
    assert.equal(
      readSpawnField(CLIPPED_SPAWN, "description"),
      "Research planning/brainstorm flow",
    );
  });

  test("a value the clip ate is null, never a fragment", () => {
    const cut = '{"description":"Research planning/brainst';
    assert.equal(readSpawnField(cut, "description"), null);
  });

  test("escapes come back as characters, not as backslash pairs", () => {
    const withEscapes = '{"description":"say \\"hi\\"\\nthen stop","prompt":"unterminated';
    assert.equal(readSpawnField(withEscapes, "description"), 'say "hi"\nthen stop');
  });

  test("a quote inside the value cannot end the match early", () => {
    const tricky = '{"description":"the \\"scout\\" role","subagent_type":"builder","p":"x';
    assert.equal(readSpawnField(tricky, "description"), 'the "scout" role');
    assert.equal(readSpawnField(tricky, "subagent_type"), "builder");
  });

  test("absent, empty, non-string and non-JSON all answer null", () => {
    assert.equal(readSpawnField(WHOLE_SPAWN, "model"), null);
    assert.equal(readSpawnField('{"description":""}', "description"), null);
    assert.equal(readSpawnField('{"description":42}', "description"), null);
    assert.equal(readSpawnField("not json at all", "description"), null);
    assert.equal(readSpawnField("", "description"), null);
    assert.equal(readSpawnField(undefined, "description"), null);
    assert.equal(readSpawnField(null, "description"), null);
  });
});

/* ── foldSubagents ────────────────────────────────────────────────────────── */

describe("foldSubagents — the row a stranger has to read", () => {
  const thread: ThreadEntry[] = [
    spawnEntry("toolu_A", CLIPPED_SPAWN, "2026-07-30T11:49:11.598Z"),
    resultEntry("toolu_A", "2026-07-30T11:49:11.718Z"),
    spawnEntry("toolu_B", WHOLE_SPAWN, "2026-07-30T11:50:21.750Z"),
  ];

  test("a clipped spawn yields its real role and description", () => {
    const [a] = foldSubagents(thread);
    assert.ok(a);
    assert.equal(a.role, "architect");
    assert.equal(a.description, "Research planning/brainstorm flow");
  });

  test("the whole spawn is unaffected", () => {
    const b = foldSubagents(thread)[1];
    assert.ok(b);
    assert.equal(b.role, "scout");
    assert.equal(b.description, "Recon forge-control command + agent infra");
  });

  test("a spawn-only row reports its zeros as UNMEASURED", () => {
    for (const s of foldSubagents(thread)) {
      assert.equal(s.event_count, 0);
      assert.equal(s.usage.output_tokens, 0);
      assert.equal(
        s.tokens_measured,
        false,
        "no thread entry carried this sub-agent's parent_tool_use_id, so 0 is ignorance",
      );
    }
  });

  test("one attributed entry flips it to measured", () => {
    const withChild: ThreadEntry[] = [
      ...thread,
      {
        role: "assistant",
        kind: "tool_call",
        content: "",
        ts: "2026-07-30T11:50:30.000Z",
        meta: {
          parent_tool_use_id: "toolu_B",
          tool: "Read",
          usage: { output_tokens: 12 },
        },
      } as ThreadEntry,
    ];
    const b = withChild.length > 0 ? foldSubagents(withChild)[1] : undefined;
    assert.ok(b);
    assert.equal(b.tokens_measured, true);
    assert.equal(b.usage.output_tokens, 12);
  });

  test("the spawn's own tool_result is NOT used as a settle stamp", () => {
    /* It lands 6–120 ms after the call because the executor acks the spawn;
     * treating it as the end would report four minutes of work as 11 ms. */
    const [a] = foldSubagents(thread);
    assert.ok(a);
    assert.equal(a.ended_at, null);
    assert.equal(a.started_at, a.updated_at);
  });

  test("status still comes from the result having arrived", () => {
    const [a, b] = foldSubagents(thread);
    assert.equal(a?.status, "done");
    assert.equal(b?.status, "running");
  });
});

describe("subagentsFromRollup — measured vs unmeasured", () => {
  test("a rollup row with events is measured", () => {
    const [s] = subagentsFromRollup([
      {
        tool_use_id: "toolu_C",
        role: "scout",
        model: "claude-haiku-4-5-20251001",
        description: "Wire-shape probe subject",
        event_count: 58,
        usage: { input_tokens: 16, output_tokens: 3 },
        status: "done",
      },
    ]);
    assert.equal(s?.tokens_measured, true);
  });

  test("a rollup row written from the spawn alone is not", () => {
    const [s] = subagentsFromRollup([
      { tool_use_id: "toolu_D", role: "builder", event_count: 0, usage: {} },
    ]);
    assert.equal(s?.tokens_measured, false);
  });

  test("tokens with no event count still count as measured", () => {
    const [s] = subagentsFromRollup([
      { tool_use_id: "toolu_E", event_count: 0, usage: { cache_read_input_tokens: 4 } },
    ]);
    assert.equal(s?.tokens_measured, true);
  });
});

/* ── rankCandidates ───────────────────────────────────────────────────────── */

describe("rankCandidates — which project the chat is ABOUT", () => {
  /** The real pair, in the order the query returns them (created_at DESC). */
  const REAL = [
    { id: "8c591d6c", name: "engine-task-graph", status: "paused" },
    { id: "8ea0cc08", name: "operator-visibility", status: "active" },
  ];

  test("THE BUG: newest-first hands over the paused project", () => {
    assert.equal(REAL[0]?.name, "engine-task-graph");
  });

  test("THE FIX: the active project wins despite being older", () => {
    const ranked = rankCandidates(REAL);
    assert.equal(ranked[0]?.name, "operator-visibility");
    assert.equal(ranked[1]?.name, "engine-task-graph");
  });

  test("both survive — the switcher needs the loser too", () => {
    assert.equal(rankCandidates(REAL).length, 2);
  });

  test("newest-first is the tie-break inside a tier, not the rule", () => {
    const sameTier = [
      { id: "new", name: "newer", status: "active" },
      { id: "old", name: "older", status: "active" },
    ];
    assert.equal(rankCandidates(sameTier)[0]?.name, "newer");
  });

  test("finished and abandoned projects sort below dormant ones", () => {
    assert.ok(statusRank("active") < statusRank("paused"));
    assert.ok(statusRank("paused") < statusRank("completed"));
    assert.ok(statusRank("completed") < statusRank("cancelled"));
    assert.ok(statusRank("cancelled") < statusRank("archived"));
  });

  test("an unrecognised status is treated as dormant, not as finished", () => {
    assert.equal(statusRank("some-future-status"), statusRank("paused"));
    assert.ok(statusRank("some-future-status") < statusRank("completed"));
  });

  test("the input array is not mutated", () => {
    const input = [...REAL];
    rankCandidates(input);
    assert.equal(input[0]?.name, "engine-task-graph");
  });
});
