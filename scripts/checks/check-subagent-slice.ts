/**
 * check-subagent-slice.ts — executable unit check for the sub-agent slicer
 * (`app/desktop/chat/subagent-slice.ts`).
 *
 * The thing under test is the one invariant the whole worker-chat view stands
 * on: a run's thread partitions EXACTLY into the parent's own entries plus one
 * slice per sub-agent. Lose an entry and the transcript lies; double-count one
 * and the counts do. Both directions are checked, synthetically and against
 * the real 285-entry capture where 196 entries belong to two sub-agents.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch. Same shape as
 * check-team-rows.ts, deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-subagent-slice.ts
 */

import { readFileSync } from "node:fs";

import type { ThreadEntry } from "../../forge-control-web/app/api.ts";
import {
  mergeSubagentMeta,
  parentToolUseId,
  parseSpawnInput,
  parseSubagentsV2,
  partitionCheck,
  sliceOwnerId,
  spawnRoles,
  spawnToolUseIds,
  subagentEntries,
  subagentIndex,
  subagentTranscript,
  toolUseId,
  topLevelEntries,
} from "../../forge-control-web/app/desktop/chat/subagent-slice.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

/** An entry with every field, so each case only states what it varies. */
function entry(over: Partial<ThreadEntry> & { ts: string }): ThreadEntry {
  return {
    role: "tool",
    content: "",
    kind: "tool_call",
    meta: {},
    ...over,
  };
}

/** A sub-agent-tagged entry. */
function sub(parent: string, ts: string, over: Partial<ThreadEntry> = {}): ThreadEntry {
  return entry({ ts, ...over, meta: { parent_tool_use_id: parent, ...(over.meta ?? {}) } });
}

/* ── The fixture thread ────────────────────────────────────────────────────
 *
 *   t0  top-level text
 *   t1  top-level Agent tool_call  (tool_use_id A)
 *   t2  sub A
 *   t3  top-level bash
 *   t4  sub A
 *   t5  top-level Agent tool_call  (tool_use_id B)
 *   t6  sub B
 *   t7  sub A
 *   t8  top-level text
 */
const A = "toolu_A";
const B = "toolu_B";
const THREAD: ThreadEntry[] = [
  entry({ ts: "t0", role: "assistant", kind: "text", content: "plan of attack" }),
  entry({ ts: "t1", meta: { tool: "Agent", tool_use_id: A } }),
  sub(A, "t2"),
  entry({ ts: "t3", meta: { tool: "Bash", tool_use_id: "toolu_bash" } }),
  sub(A, "t4"),
  entry({ ts: "t5", meta: { tool: "Agent", tool_use_id: B } }),
  sub(B, "t6"),
  sub(A, "t7"),
  entry({ ts: "t8", role: "assistant", kind: "text", content: "done" }),
];

console.log("── parentToolUseId / toolUseId ──────────────────────────────");
check("a top-level entry has no parent", parentToolUseId(THREAD[0]), null);
check("a sub-agent entry names its parent", parentToolUseId(THREAD[2]), A);
check("an empty-string parent counts as top-level", parentToolUseId(sub("", "t")), null);
check(
  "a non-string parent counts as top-level",
  parentToolUseId(entry({ ts: "t", meta: { parent_tool_use_id: 7 } })),
  null,
);
check("a missing meta is tolerated", parentToolUseId({ role: "tool", content: "", ts: "t" }), null);
check("toolUseId reads meta.tool_use_id", toolUseId(THREAD[1]), A);
check("toolUseId is null when absent", toolUseId(THREAD[0]), null);

console.log("\n── topLevelEntries / subagentEntries ────────────────────────");
check("top-level keeps only untagged entries", topLevelEntries(THREAD).length, 5);
check(
  "…in thread order",
  topLevelEntries(THREAD).map((e) => e.ts).join(","),
  "t0,t1,t3,t5,t8",
);
check("slice A has three entries", subagentEntries(THREAD, A).length, 3);
check(
  "…in thread order",
  subagentEntries(THREAD, A).map((e) => e.ts).join(","),
  "t2,t4,t7",
);
check("slice B has one entry", subagentEntries(THREAD, B).length, 1);
check("an unknown id yields an empty slice, not a throw", subagentEntries(THREAD, "nope").length, 0);
check("an empty id yields an empty slice", subagentEntries(THREAD, "").length, 0);
check("an empty thread yields nothing", topLevelEntries([]).length, 0);

console.log("\n── subagentIndex ───────────────────────────────────────────");
{
  const index = subagentIndex(THREAD);
  check("two sub-agents found", index.size, 2);
  check("…in order of first appearance", [...index.keys()].join(","), `${A},${B}`);
  check("A's count", index.get(A)?.count, 3);
  check("A's firstTs is its first entry", index.get(A)?.firstTs, "t2");
  check("A's lastTs is its last entry", index.get(A)?.lastTs, "t7");
  check("B's count", index.get(B)?.count, 1);
  check("a single-entry slice has firstTs === lastTs", index.get(B)?.firstTs, index.get(B)?.lastTs);
  check("an empty thread has no sub-agents", subagentIndex([]).size, 0);
}

console.log("\n── spawnToolUseIds ─────────────────────────────────────────");
{
  const ids = spawnToolUseIds(THREAD);
  check("only Agent/Task calls count as spawns", ids.size, 2);
  check("…the two spawn ids", [...ids].join(","), `${A},${B}`);
  check("a Bash call is not a spawn", ids.has("toolu_bash"), false);
  check(
    "Task counts as well as Agent",
    spawnToolUseIds([entry({ ts: "t", meta: { tool: "Task", tool_use_id: "T" } })]).has("T"),
    true,
  );
  check(
    "a tool_result carrying the same id is not a second spawn",
    spawnToolUseIds([
      entry({ ts: "t0", meta: { tool: "Agent", tool_use_id: "T" } }),
      entry({ ts: "t1", kind: "tool_result", meta: { tool: "Agent", tool_use_id: "T" } }),
    ]).size,
    1,
  );
  check(
    "a sub-agent's inner ids are NOT spawns of the thread it sits in",
    spawnToolUseIds([sub(A, "t", { meta: { tool: "Bash", tool_use_id: "inner" } })]).size,
    0,
  );
}

console.log("\n── parseSpawnInput ─────────────────────────────────────────");
/* The ONE reader of the spawn call's `input` on the client. The drilled header
 * and the digest roster both go through it — round 604 measured what two
 * readers of the same field produce: `scout` on one surface, `unknown` on
 * another (`phase600/README.md §6.1`). */
{
  const ok = JSON.stringify({ subagent_type: "scout", description: "Recon the API" });
  check("subagent_type is the role", parseSpawnInput(ok).role, "scout");
  check("…and description comes along", parseSpawnInput(ok).description, "Recon the API");
  check("a non-string input is nulls", parseSpawnInput({ subagent_type: "scout" }).role, null);
  check("an absent input is nulls", parseSpawnInput(undefined).role, null);
  check("an empty string is nulls", parseSpawnInput("").role, null);
  check("a JSON array is nulls, not a crash", parseSpawnInput("[1,2]").role, null);
  check("an empty subagent_type is null, not ''", parseSpawnInput('{"subagent_type":""}').role, null);
  check(
    "a TRUNCATED input is nulls — the fixture's own shape, 1500 chars and cut mid-string",
    parseSpawnInput('{"subagent_type":"scout","prompt":"aaaa').role,
    null,
  );
}

console.log("\n── spawnRoles ──────────────────────────────────────────────");
{
  const roles = spawnRoles([
    entry({ ts: "t0", meta: { tool: "Agent", tool_use_id: "A", input: '{"subagent_type":"scout"}' } }),
    entry({
      ts: "t1",
      meta: { tool: "Task", tool_use_id: "B", spawns_subagent_role: "builder", input: '{"subagent_type":"scout"}' },
    }),
    entry({ ts: "t2", meta: { tool: "Agent", tool_use_id: "C" } }),
    entry({ ts: "t3", meta: { tool: "Bash", tool_use_id: "c1", input: '{"subagent_type":"nope"}' } }),
  ]);
  check("one entry per spawn, Bash excluded", roles.size, 3);
  check("the input's subagent_type", roles.get("A"), "scout");
  check("an explicit stamp beats the input", roles.get("B"), "builder");
  check("a spawn with no input maps to null, and is still present", roles.get("C"), null);
  check("…present, i.e. the sub-agent is not dropped", roles.has("C"), true);
  check(
    "spawnToolUseIds is exactly its key set — the two cannot drift",
    [...spawnToolUseIds(THREAD)].join(","),
    [...spawnRoles(THREAD).keys()].join(","),
  );
}

console.log("\n── subagentTranscript: what the drilled view actually renders ");
{
  const thread: ThreadEntry[] = [
    entry({ ts: "t0" }),
    entry({ ts: "t1", meta: { tool: "Agent", tool_use_id: A, input: '{"subagent_type":"scout"}' } }),
    sub(A, "t2"),
    sub(A, "t3"),
    entry({ ts: "t4", kind: "tool_result", meta: { tool_use_id: A } }),
    entry({ ts: "t5" }),
  ];
  const t = subagentTranscript(thread, A);
  check("its own entries plus the envelope", t.length, 4);
  check("…opening with the spawn call", t[0].ts, "t1");
  check("…closing with its result", t[3].ts, "t4");
  check("…and nothing of the parent's", t.some((e) => e.ts === "t0" || e.ts === "t5"), false);
  check(
    "it is a superset of the pure slice, by exactly the envelope",
    t.length - subagentEntries(thread, A).length,
    2,
  );
  check("an unknown id yields nothing at all", subagentTranscript(thread, "nope").length, 0);
  check(
    "a run with no envelope recorded degrades to the pure slice",
    subagentTranscript([sub(A, "t0"), sub(A, "t1")], A).length,
    2,
  );
}

console.log("\n── sliceOwnerId ────────────────────────────────────────────");
check("a whole run has no slice owner", sliceOwnerId(THREAD), null);
check("an empty thread has none either", sliceOwnerId([]), null);
check("a pure slice names its owner", sliceOwnerId(subagentEntries(THREAD, A)), A);
check(
  "one top-level entry is enough to make it a run, not a slice",
  sliceOwnerId([sub(A, "t0"), entry({ ts: "t1" })]),
  null,
);
/* The documented blind spot, pinned so nobody re-derives an owner from shape:
 * a `subagentTranscript` HAS top-level entries (the envelope), so this returns
 * null on the very input the drilled view renders. `deriveDigest` is told the
 * owner instead — round 605's defect was exactly this inference. */
check(
  "it CANNOT see the owner of a transcript — the envelope is top-level",
  sliceOwnerId(subagentTranscript(THREAD, A)),
  null,
);

console.log("\n── HARD INVARIANT: nothing lost, nothing double-counted ────");
{
  const p = partitionCheck(THREAD);
  check("partition holds", p.ok, true);
  check("total", p.total, 9);
  check("top-level", p.topLevel, 5);
  check("sliced", p.sliced, 4);
  check("top-level + sliced === total", p.topLevel + p.sliced, p.total);

  // Restated the long way: rebuild the thread from its parts and compare.
  const index = subagentIndex(THREAD);
  const rebuilt = new Set<ThreadEntry>(topLevelEntries(THREAD));
  let overlaps = 0;
  for (const id of index.keys()) {
    for (const e of subagentEntries(THREAD, id)) {
      if (rebuilt.has(e)) overlaps++;
      rebuilt.add(e);
    }
  }
  check("every entry is in exactly one part", rebuilt.size, THREAD.length);
  check("no entry appears in two parts", overlaps, 0);
}
{
  const empty = partitionCheck([]);
  check("an empty thread partitions trivially", empty.ok, true);
  check("…with zero everywhere", `${empty.total},${empty.topLevel},${empty.sliced}`, "0,0,0");
}
{
  const allSub: ThreadEntry[] = [sub(A, "x1"), sub(A, "x2")];
  const p = partitionCheck(allSub);
  check("a pure sub-agent slice still partitions", p.ok, true);
  check("…with no top-level entries", p.topLevel, 0);
}
{
  const noSub: ThreadEntry[] = [entry({ ts: "y1" }), entry({ ts: "y2" })];
  const p = partitionCheck(noSub);
  check("a thread with no sub-agents partitions", p.ok, true);
  check("…entirely into top-level", p.topLevel, 2);
}

console.log("\n── parseSubagentsV2 (defensive over wire metadata) ─────────");
check("undefined → empty", parseSubagentsV2(undefined).length, 0);
check("null → empty", parseSubagentsV2(null).length, 0);
check("a non-array → empty", parseSubagentsV2({ tool_use_id: A }).length, 0);
check("entries without a tool_use_id are dropped", parseSubagentsV2([{ role: "scout" }]).length, 0);
check("nulls inside the array are dropped", parseSubagentsV2([null, { tool_use_id: A }]).length, 1);
{
  const [m] = parseSubagentsV2([
    {
      tool_use_id: A,
      role: "Explore",
      model: "claude-opus-5",
      description: "Recon",
      status: "done",
      started_at: "2026-08-05T06:47:12.533Z",
      ended_at: "2026-08-05T06:47:12.565Z",
      updated_at: "2026-08-05T06:53:09.635Z",
      event_count: 118,
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 130260 },
      latest_activity: { kind: "assistant_text", tool: null, text: "Report", ts: "t" },
    },
  ]);
  check("role", m.role, "Explore");
  check("model", m.model, "claude-opus-5");
  check("event_count", m.event_count, 118);
  check("usage keys are the executor's spelling", m.usage?.cache_read_input_tokens, 130260);
  check("a missing usage key defaults to 0, never NaN", m.usage?.cache_creation_input_tokens, 0);
  check("latest_activity.kind", m.latest_activity?.kind, "assistant_text");
  check("a null activity field stays null", m.latest_activity?.tool, null);
}
{
  const [m] = parseSubagentsV2([{ tool_use_id: A, model: null, event_count: "118" }]);
  check("a null model stays null", m.model, null);
  check("a string event_count is rejected, not coerced", m.event_count, null);
  check("a missing usage is null, not a zero object", m.usage, null);
}

console.log("\n── mergeSubagentMeta ───────────────────────────────────────");
{
  const index = subagentIndex(THREAD);
  const merged = mergeSubagentMeta(
    [
      { tool_use_id: A, role: "Explore", event_count: 3 },
      { tool_use_id: B, role: "reviewer", event_count: 1 },
    ],
    index,
  );
  check("both sub-agents merged", merged.length, 2);
  check("declaration order is kept", merged.map((m) => m.tool_use_id).join(","), `${A},${B}`);
  check("slice count is the thread's, not the metadata's", merged[0].sliceCount, 3);
  check("firstTs comes from the slice", merged[0].firstTs, "t2");
  check("agreeing event_count raises no flag", merged[0].eventCountMismatch, false);
  check("nothing is missing", `${merged[0].metaMissing},${merged[0].sliceMissing}`, "false,false");
}
{
  // Metadata disagreeing with the thread must be VISIBLE (NFU6), not smoothed.
  const merged = mergeSubagentMeta([{ tool_use_id: A, event_count: 99 }], subagentIndex(THREAD));
  check("a stale event_count is flagged", merged[0].eventCountMismatch, true);
  check("…and the thread's number is what is reported", merged[0].sliceCount, 3);
  check("a sub-agent present in the thread but undeclared is still listed", merged.length, 2);
  check("…flagged metaMissing", merged[1].metaMissing, true);
  check("…with the id it was found under", merged[1].tool_use_id, B);
  check("…and no invented role", merged[1].role, null);
}
{
  // Declared but no entries yet — a just-spawned sub-agent.
  const merged = mergeSubagentMeta(
    [{ tool_use_id: "toolu_fresh", role: "builder", event_count: 0 }],
    subagentIndex([]),
  );
  check("a declared sub-agent with no entries is kept", merged.length, 1);
  check("…flagged sliceMissing", merged[0].sliceMissing, true);
  check("…with sliceCount 0", merged[0].sliceCount, 0);
  check("…and event_count 0 agrees with it", merged[0].eventCountMismatch, false);
}
{
  const merged = mergeSubagentMeta(
    [{ tool_use_id: A, role: "first" }, { tool_use_id: A, role: "duplicate" }],
    subagentIndex(subagentEntries(THREAD, A)),
  );
  check("a duplicated tool_use_id is merged once", merged.length, 1);
  check("…keeping the first declaration", merged[0].role, "first");
}
check("no metadata at all still lists what the thread shows", mergeSubagentMeta(undefined, subagentIndex(THREAD)).length, 2);

console.log("\n── REAL FIXTURE: run 3853c154 (285 entries, 196 sub-agent) ─");
{
  const fixtureUrl = new URL(
    "../../docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json",
    import.meta.url,
  );
  const run = (
    JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
      run: { thread: ThreadEntry[]; metadata: Record<string, unknown> };
    }
  ).run;
  const thread = run.thread;

  const p = partitionCheck(thread);
  check("the real thread partitions", p.ok, true);
  check("285 entries total", p.total, 285);
  check("89 belong to the architect itself", p.topLevel, 89);
  check("196 belong to its two sub-agents", p.sliced, 196);
  check("89 + 196 === 285", p.topLevel + p.sliced, p.total);

  const index = subagentIndex(thread);
  check("two sub-agents in the thread", index.size, 2);
  check(
    "…the ids the executor stamped",
    [...index.keys()].join(","),
    "toolu_014raMUrJcAiXV61BerokrjN,toolu_012sWh2xagb6t8J11pTV5oMT",
  );
  check("first slice is 118 entries", index.get("toolu_014raMUrJcAiXV61BerokrjN")?.count, 118);
  check("second slice is 78 entries", index.get("toolu_012sWh2xagb6t8J11pTV5oMT")?.count, 78);
  check(
    "first slice starts when the scout did",
    index.get("toolu_014raMUrJcAiXV61BerokrjN")?.firstTs,
    "2026-08-05T06:47:14.127Z",
  );
  check(
    "first slice ends with its report",
    index.get("toolu_014raMUrJcAiXV61BerokrjN")?.lastTs,
    "2026-08-05T06:53:09.636Z",
  );

  const merged = mergeSubagentMeta(run.metadata.subagents_v2, index);
  check("both merge against subagents_v2", merged.length, 2);
  check("roles come from metadata", merged.map((m) => m.role).join(","), "Explore,Explore");
  check("models come from metadata", merged.map((m) => m.model).join(","), "claude-opus-5,claude-opus-5");
  check(
    "descriptions come from metadata",
    merged.map((m) => m.description).join(" | "),
    "Recon chat Bash block rendering | Recon agents API and runs schema",
  );
  check("both are done", merged.map((m) => m.status).join(","), "done,done");
  check(
    "declared event_count matches the entries actually present",
    merged.map((m) => `${m.event_count}=${m.sliceCount}`).join(","),
    "118=118,78=78",
  );
  check("…so no mismatch is flagged", merged.every((m) => !m.eventCountMismatch), true);
  check("…and nothing is missing on either side", merged.every((m) => !m.metaMissing && !m.sliceMissing), true);
  check(
    "usage is read with the executor's key spelling",
    merged[0].usage?.cache_read_input_tokens,
    130260,
  );

  // Every sub-agent's slice is reachable by the tool_use_id of a real Agent
  // tool_call in the same thread — this is what makes the org chart clickable.
  const spawnIds = thread
    .filter((e) => e.kind === "tool_call" && e.meta?.tool === "Agent")
    .map((e) => String(e.meta?.tool_use_id));
  check("the run made two Agent calls", spawnIds.length, 2);
  check(
    "every slice is owned by one of them",
    [...index.keys()].every((id) => spawnIds.includes(id)),
    true,
  );
  check(
    "spawnToolUseIds finds exactly those two",
    [...spawnToolUseIds(thread)].sort().join(","),
    [...index.keys()].sort().join(","),
  );

  // A real slice, taken out of the real thread, behaves like a slice.
  const realSlice = subagentEntries(thread, "toolu_012sWh2xagb6t8J11pTV5oMT");
  check("the second scout's slice is 78 entries", realSlice.length, 78);
  check("…and knows whose it is", sliceOwnerId(realSlice), "toolu_012sWh2xagb6t8J11pTV5oMT");
  check("…it spawned no sub-agents of its own", spawnToolUseIds(realSlice).size, 0);
  check("…and it partitions on its own terms", partitionCheck(realSlice).ok, true);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — sub-agent slicing`,
);
process.exit(failures === 0 ? 0 : 1);
