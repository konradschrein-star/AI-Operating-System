/**
 * check-thread-mapping.ts — executable unit check for the scoped thread mapper
 * (`app/desktop/chat/thread-mapping.ts`, round 602).
 *
 * Three things are under test, in order of how badly they hurt when broken:
 *
 *  1. COUNT CONSERVATION. Folding a sub-agent hides its entries from the
 *     parent's view; it must never lose them. For every scope,
 *     `visible + folded + above + deeper === total`, and each bucket is
 *     checked against the numbers the slicer independently reports. Asserted
 *     on the REAL 285-entry capture (run 3853c154-e07b-4378-9313-2b34f4a33342),
 *     where 196 entries belong to two sub-agents — the case the fold exists
 *     for. On that run the top-level view is 89 visible + 196 folded: every
 *     entry is either read here or exactly one descent down, with nothing
 *     left over.
 *
 *  2. NOTHING IS TRUNCATED. `argsText` on a tool-call part is `meta.input`
 *     byte-for-byte and `result` is the tool_result's `content` byte-for-byte,
 *     across all 136 tool calls of the real thread. Round 604 measures the
 *     rendered expansion against the API payload; this is the same claim one
 *     layer down, so a regression is caught here first.
 *
 *  3. THE DEFAULT DID NOT MOVE. `mapThreadToMessages(thread)` with no options
 *     must produce exactly what it produced before round 602 — same grouping,
 *     same ids, same parts — because the manager chat and ProjectsSurface both
 *     call it that way.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch. Same shape as
 * check-subagent-slice.ts, deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-thread-mapping.ts
 */

import { readFileSync } from "node:fs";

import type { ThreadEntry } from "../../forge-control-web/app/api.ts";
import {
  mapThreadToMessages,
  mapThreadView,
  type SubagentFold,
  type ToolCallPart,
} from "../../forge-control-web/app/desktop/chat/thread-mapping.ts";
import {
  partitionCheck,
  subagentEntries,
  subagentIndex,
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

/* ── Reading the mapper's output ───────────────────────────────────────────
 * `ThreadMessageLike` types `content` loosely (it accepts a bare string), so
 * these readers narrow it once, here, instead of casting at twenty call sites.
 * A message whose content is not an array is a bug in the mapper and reads as
 * "no parts" rather than throwing mid-table. */

type AnyMessage = { role: string; id?: string; content: unknown };

function parts(m: AnyMessage): unknown[] {
  return Array.isArray(m.content) ? m.content : [];
}

function toolParts(messages: AnyMessage[]): ToolCallPart[] {
  const out: ToolCallPart[] = [];
  for (const m of messages) {
    for (const p of parts(m)) {
      if (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "tool-call") {
        out.push(p as ToolCallPart);
      }
    }
  }
  return out;
}

/** Prose parts of the ASSISTANT messages. User and system messages carry a
 *  text part too; counting those as prose would make every "the agent said N
 *  things" assertion off by the number of turns Konrad took. */
function textParts(messages: AnyMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of parts(m)) {
      if (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "text") {
        out.push(String((p as { text?: unknown }).text ?? ""));
      }
    }
  }
  return out;
}

function folds(messages: AnyMessage[]): SubagentFold[] {
  return toolParts(messages)
    .map((p) => p.subagent)
    .filter((f): f is SubagentFold => f !== undefined);
}

/** An entry with every field, so each case only states what it varies. */
function entry(over: Partial<ThreadEntry> & { ts: string }): ThreadEntry {
  return { role: "tool", content: "", kind: "tool_call", meta: {}, ...over };
}

function sub(parent: string, ts: string, over: Partial<ThreadEntry> = {}): ThreadEntry {
  return entry({ ts, ...over, meta: { parent_tool_use_id: parent, ...(over.meta ?? {}) } });
}

/* ── The synthetic thread ──────────────────────────────────────────────────
 *
 *   t0  user
 *   t1  assistant prose
 *   t2  Agent tool_call        (spawn A)
 *   t3  sub A — bash call
 *   t4  sub A — bash result
 *   t5  assistant prose        (the parent talking WHILE A works)
 *   t6  Bash tool_call         (the parent's own)
 *   t7  Bash tool_result
 *   t8  sub A — prose
 *   t9  tool_result for A      (A reports back)
 *   t10 assistant prose
 */
const A = "toolu_A";
const THREAD: ThreadEntry[] = [
  entry({ ts: "t0", role: "user", kind: "text", content: "go" }),
  entry({ ts: "t1", role: "assistant", kind: "text", content: "plan of attack" }),
  entry({
    ts: "t2",
    meta: {
      tool: "Agent",
      tool_use_id: A,
      input: '{"subagent_type":"scout","description":"Recon forge-control API"}',
    },
  }),
  sub(A, "t3", { meta: { tool: "Bash", tool_use_id: "inner1", input: '{"command":"ls"}' } }),
  sub(A, "t4", { kind: "tool_result", content: "a\nb", meta: { tool_use_id: "inner1" } }),
  entry({ ts: "t5", role: "assistant", kind: "text", content: "meanwhile" }),
  entry({ ts: "t6", meta: { tool: "Bash", tool_use_id: "own1", input: '{"command":"pwd"}' } }),
  entry({ ts: "t7", kind: "tool_result", content: "/opt", meta: { tool_use_id: "own1" } }),
  sub(A, "t8", { role: "assistant", kind: "text", content: "scout report" }),
  entry({ ts: "t9", kind: "tool_result", content: "Recon done", meta: { tool_use_id: A } }),
  entry({ ts: "t10", role: "assistant", kind: "text", content: "wrapping up" }),
];

console.log("── DEFAULT SCOPE: the pre-602 behaviour, unchanged ──────────");
{
  const messages = mapThreadToMessages(THREAD) as unknown as AnyMessage[];
  check("user entry is its own message", messages[0].role, "user");
  check("…keyed by its thread index", messages[0].id, "t0");
  check("everything after it groups into one assistant message", messages.length, 2);
  check("…opened at the first assistant entry", messages[1].id, "t1");
  // 4 prose (t1, t5, t8, t10) + 3 tool calls (t2, t3, t6) = 7 parts; the three
  // tool_results attach to their calls rather than becoming parts of their own.
  check("parts interleave prose and tool calls", parts(messages[1]).length, 7);
  check("…4 of them prose", textParts(messages).length, 4);
  check("…3 of them tool calls", toolParts(messages).length, 3);
  check(
    "…INCLUDING the sub-agent's, inline — this is the defect 602 fixes",
    toolParts(messages).map((p) => p.toolCallId).join(","),
    `${A},inner1,own1`,
  );
  check("no fold is attached in the default scope", folds(messages).length, 0);
  check(
    "results attach to their calls by tool_use_id",
    toolParts(messages).map((p) => String(p.result)).join("|"),
    "Recon done|a\nb|/opt",
  );
  const view = mapThreadView(THREAD);
  check("coverage: everything is visible", view.coverage.visible, THREAD.length);
  check("coverage: nothing is folded", view.coverage.folded, 0);
  check("coverage: nothing is deeper", view.coverage.deeper, 0);
  check("coverage: nothing is above", view.coverage.above, 0);
  check("coverage holds", view.coverage.ok, true);
}

console.log("\n── TOP-LEVEL SCOPE: the parent's own story ──────────────────");
{
  const view = mapThreadView(THREAD, { scope: { kind: "top-level" } });
  const messages = view.messages as unknown as AnyMessage[];
  check("the sub-agent's prose is gone from the parent's transcript", textParts(messages).length, 4 - 1);
  check(
    "…and so is its bash call",
    toolParts(messages).map((p) => p.toolCallId).join(","),
    `${A},own1`,
  );
  check("message ids are still thread indices", messages[1].id, "t1");
  check("the spawn still carries its result", String(toolParts(messages)[0].result), "Recon done");
  check("the parent's own bash still carries its own", String(toolParts(messages)[1].result), "/opt");
  check("argsText is untouched", toolParts(messages)[1].argsText, '{"command":"pwd"}');

  console.log("   — the fold —");
  const f = folds(messages);
  check("exactly one sub-agent is folded", f.length, 1);
  check("…onto the Agent call that spawned it", f[0].subagentId, A);
  check("…carrying its entry count", f[0].eventCount, 3);
  check("…which is what the slicer says", f[0].eventCount, subagentEntries(THREAD, A).length);
  check("…first entry ts", f[0].firstTs, "t3");
  check("…last entry ts", f[0].lastTs, "t8");
  check("a plain Bash call carries no fold", toolParts(messages)[1].subagent, undefined);

  console.log("   — count conservation —");
  check("visible === the parent's own entries", view.coverage.visible, topLevelEntries(THREAD).length);
  check("folded === the sub-agent's entries", view.coverage.folded, 3);
  check("nothing is deeper than one descent", view.coverage.deeper, 0);
  check("a run's own view has nothing above it", view.coverage.above, 0);
  check(
    "visible + folded + above + deeper === total",
    view.coverage.visible + view.coverage.folded + view.coverage.above + view.coverage.deeper,
    THREAD.length,
  );
  check("…which the mapper agrees with", view.coverage.ok, true);
}

console.log("\n── SUBAGENT SCOPE: the slice plus its envelope ──────────────");
{
  const view = mapThreadView(THREAD, { scope: { kind: "subagent", subagentId: A } });
  const messages = view.messages as unknown as AnyMessage[];
  check(
    "the slice's own tool call is there",
    toolParts(messages).some((p) => p.toolCallId === "inner1"),
    true,
  );
  check("…so is the spawn that briefed it", toolParts(messages).some((p) => p.toolCallId === A), true);
  check("…and nothing of the parent's own work", toolParts(messages).some((p) => p.toolCallId === "own1"), false);
  check("the sub-agent's prose is here, not in the parent view", textParts(messages).join(","), "scout report");
  check(
    "the envelope spawn does NOT fold its own slice into itself",
    folds(messages).length,
    0,
  );
  check("the spawn's result — what the sub-agent reported back", String(toolParts(messages)[0].result), "Recon done");
  check("visible === slice + envelope", view.coverage.visible, 3 + 2);
  check("nothing folded at this level", view.coverage.folded, 0);
  check("nothing deeper", view.coverage.deeper, 0);
  check("the parent's own work is ABOVE, one press of back away", view.coverage.above, 6);
  check("conservation holds", view.coverage.ok, true);
}

console.log("\n── EDGE CASES ───────────────────────────────────────────────");
{
  const view = mapThreadView([], { scope: { kind: "top-level" } });
  check("an empty thread maps to no messages", view.messages.length, 0);
  check("…and conserves trivially", view.coverage.ok, true);
  check("…with zeroes everywhere", `${view.coverage.total},${view.coverage.visible},${view.coverage.folded}`, "0,0,0");
}
{
  // A spawn whose sub-agent produced no inline entries — the older-run case.
  // The fold is present with eventCount 0 rather than absent: the sub-agent is
  // real, and a missing fold would read as "no sub-agent here".
  const t: ThreadEntry[] = [
    entry({ ts: "t0", meta: { tool: "Task", tool_use_id: "toolu_S", input: "{}" } }),
    entry({ ts: "t1", kind: "tool_result", content: "done", meta: { tool_use_id: "toolu_S" } }),
  ];
  const f = folds(mapThreadView(t, { scope: { kind: "top-level" } }).messages as unknown as AnyMessage[]);
  check("a Task spawn with no stamped entries still folds", f.length, 1);
  check("…with an honest zero", f[0].eventCount, 0);
  check("…and no invented timestamps", `${f[0].firstTs},${f[0].lastTs}`, "null,null");
}
{
  // An entry tagged to a sub-agent the thread never spawned: it cannot be
  // reached in one descent, so it is reported as `deeper` rather than lost.
  const t: ThreadEntry[] = [
    entry({ ts: "t0", role: "assistant", kind: "text", content: "hi" }),
    sub("toolu_ghost", "t1", { role: "assistant", kind: "text", content: "orphan" }),
  ];
  const view = mapThreadView(t, { scope: { kind: "top-level" } });
  check("an unspawned slice is not folded", view.coverage.folded, 0);
  check("…and it is not above either", view.coverage.above, 0);
  check("…it is counted as deeper", view.coverage.deeper, 1);
  check("…and named", view.coverage.deeperParents.join(","), "toolu_ghost");
  check("…so conservation still holds", view.coverage.ok, true);
}
{
  // An orphaned tool_result degrades to text rather than vanishing.
  const t: ThreadEntry[] = [
    entry({ ts: "t0", kind: "tool_result", content: "no call to attach to", meta: {} }),
  ];
  const messages = mapThreadView(t, { scope: { kind: "top-level" } }).messages as unknown as AnyMessage[];
  check("an orphaned result becomes a text part", textParts(messages).join(""), "no call to attach to");
}
{
  // A heartbeat renders nothing today and is counted, not assumed away.
  const t: ThreadEntry[] = [entry({ ts: "t0", kind: "heartbeat", content: "" })];
  const view = mapThreadView(t, { scope: { kind: "top-level" } });
  check("a heartbeat produces no part", view.messages.length, 0);
  check("…and is reported as silent, not dropped", view.coverage.silent, 1);
  check("…still inside `visible`, so conservation holds", view.coverage.ok, true);
}

console.log("\n── REAL FIXTURE: run 3853c154 (285 entries, 196 sub-agent) ──");
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
  const SCOUT_1 = "toolu_014raMUrJcAiXV61BerokrjN";
  const SCOUT_2 = "toolu_012sWh2xagb6t8J11pTV5oMT";

  check("the slicer's partition still holds on this capture", partitionCheck(thread).ok, true);
  check("285 entries", thread.length, 285);

  console.log("   — default scope: the interleaved transcript 602 replaces —");
  {
    const view = mapThreadView(thread);
    check("every entry is visible", view.coverage.visible, 285);
    check("136 tool calls, sub-agents' included", toolParts(view.messages as unknown as AnyMessage[]).length, 136);
    check("no fold", view.coverage.folded, 0);
    check("conservation holds", view.coverage.ok, true);
  }

  console.log("   — top-level scope: COUNT CONSERVATION on real data —");
  const view = mapThreadView(thread, { scope: { kind: "top-level" } });
  const messages = view.messages as unknown as AnyMessage[];
  check("visible === the architect's own 89 entries", view.coverage.visible, 89);
  check("…which is what topLevelEntries says", view.coverage.visible, topLevelEntries(thread).length);
  check("folded === the two scouts' 196 entries", view.coverage.folded, 196);
  check("nothing is deeper than one descent", view.coverage.deeper, 0);
  check("and nothing above the run itself", view.coverage.above, 0);
  check("89 + 196 + 0 + 0 === 285", view.coverage.visible + view.coverage.folded + view.coverage.above + view.coverage.deeper, 285);
  check("THE INVARIANT: nothing is dropped", view.coverage.ok, true);
  check("no entry renders silently on this run", view.coverage.silent, 0);

  console.log("   — the folds are the org chart —");
  const f = folds(messages);
  check("two sub-agents folded", f.length, 2);
  check("…in spawn order", f.map((x) => x.subagentId).join(","), `${SCOUT_1},${SCOUT_2}`);
  check("first scout: 118 entries", f[0].eventCount, 118);
  check("second scout: 78 entries", f[1].eventCount, 78);
  check(
    "…counts agree with the slicer",
    f.map((x) => x.eventCount).join(","),
    [SCOUT_1, SCOUT_2].map((id) => subagentIndex(thread).get(id)?.count).join(","),
  );
  check("first scout's slice starts when it did", f[0].firstTs, "2026-08-05T06:47:14.127Z");
  check("…and ends with its report", f[0].lastTs, "2026-08-05T06:53:09.636Z");
  check(
    "the tool calls left in the parent's view are its own 40",
    toolParts(messages).length,
    40,
  );
  check(
    "…and exactly two of them carry a fold",
    toolParts(messages).filter((p) => p.subagent !== undefined).length,
    2,
  );

  console.log("   — descending: each slice is reachable, and complete —");
  for (const [label, id, expected] of [
    ["first scout", SCOUT_1, 118],
    ["second scout", SCOUT_2, 78],
  ] as const) {
    const sliceView = mapThreadView(thread, { scope: { kind: "subagent", subagentId: id } });
    // The slice itself, plus the spawn call and the tool_result that framed it.
    check(`${label}: visible === slice + envelope`, sliceView.coverage.visible, expected + 2);
    check(`${label}: its slice is whole`, subagentEntries(thread, id).length, expected);
    check(`${label}: it folds nothing of its own`, sliceView.coverage.folded, 0);
    check(
      `${label}: the architect's own work is above it`,
      sliceView.coverage.above,
      89 - 2,
    );
    check(
      `${label}: the OTHER scout's work is deeper, not lost`,
      sliceView.coverage.deeper,
      196 - expected,
    );
    check(
      `${label}: visible + above + deeper === 285`,
      sliceView.coverage.visible + sliceView.coverage.above + sliceView.coverage.deeper,
      285,
    );
    check(`${label}: conservation holds`, sliceView.coverage.ok, true);
  }
  check(
    "89 top-level + 118 + 78 === 285, the whole run reachable in one descent",
    89 + 118 + 78,
    285,
  );

  console.log("   — NOTHING IS TRUNCATED (round 604 measures this rendered) —");
  {
    const all = toolParts(mapThreadView(thread).messages as unknown as AnyMessage[]);
    const callById = new Map<string, ThreadEntry>();
    const resultById = new Map<string, ThreadEntry>();
    for (const e of thread) {
      const id = typeof e.meta?.tool_use_id === "string" ? e.meta.tool_use_id : null;
      if (id === null) continue;
      if (e.kind === "tool_call" && !callById.has(id)) callById.set(id, e);
      if (e.kind === "tool_result" && !resultById.has(id)) resultById.set(id, e);
    }
    let argsExact = 0;
    let argsWrong = 0;
    let resultExact = 0;
    let resultWrong = 0;
    let argsBytes = 0;
    let resultBytes = 0;
    for (const p of all) {
      const id = p.toolCallId ?? "";
      const call = callById.get(id);
      if (call !== undefined && typeof call.meta?.input === "string") {
        if (p.argsText === call.meta.input) argsExact++;
        else argsWrong++;
        argsBytes += (p.argsText ?? "").length;
      }
      const res = resultById.get(id);
      if (res !== undefined) {
        if (p.result === res.content) resultExact++;
        else resultWrong++;
        resultBytes += String(p.result ?? "").length;
      }
    }
    check("every tool call's argsText is meta.input byte-for-byte", argsWrong, 0);
    check("…across all 136 of them", argsExact, 136);
    check("every result is the tool_result's content byte-for-byte", resultWrong, 0);
    check("…across all 136 of them", resultExact, 136);
    console.log(`        (carried whole: ${argsBytes} argument bytes, ${resultBytes} result bytes)`);
    check("…and that is a lot more than the old 110-char preview", argsBytes > 136 * 110, true);
  }

  console.log("   — the default scope is byte-identical to pre-602 —");
  {
    /* Restated as a property rather than a golden file: with no options, the
     * output must contain exactly the parts the flat walk produced — one text
     * part per non-empty prose entry, one tool-call part per tool_call, and no
     * fold anywhere. */
    const m = mapThreadView(thread).messages as unknown as AnyMessage[];
    const prose = thread.filter(
      (e) =>
        (e.role === "assistant" || e.role === "agent") &&
        (e.kind === undefined || e.kind === "text") &&
        String(e.content ?? "").trim() !== "",
    ).length;
    check("one text part per prose entry", textParts(m).length, prose);
    check("one tool-call part per tool_call entry", toolParts(m).length, thread.filter((e) => e.kind === "tool_call").length);
    check("no folds", folds(m).length, 0);
  }
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — scoped thread mapping (U23)`,
);
process.exit(failures === 0 ? 0 : 1);
