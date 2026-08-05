/**
 * check-story-digest.ts — executable unit check for the U24 story-so-far
 * derivation (`app/desktop/chat/story-digest.ts`).
 *
 * Three properties matter more than the field list:
 *   1. PURITY — same input, same digest, forever. No clock, no fetch, no LLM.
 *   2. TIME TRUTH — a settled run's elapsed is frozen; a running run's is
 *      null, never invented (project Definition of Done #1).
 *   3. VERBATIM — every snippet is a literal substring of what the agent
 *      wrote. Nothing is paraphrased, ever.
 * Each gets its own section below, plus the real 285-entry capture.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch. Same shape as
 * check-team-rows.ts, deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-story-digest.ts
 */

import { readFileSync } from "node:fs";

import type { RunDetail, ThreadEntry } from "../../forge-control-web/app/api.ts";
import {
  deriveDigest,
  DIGEST_MIN_ENTRIES,
  DIGEST_SNIPPETS,
} from "../../forge-control-web/app/desktop/chat/story-digest.ts";
import { subagentEntries } from "../../forge-control-web/app/desktop/chat/subagent-slice.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

/** A run with every required field, so each case only states what it varies. */
function run(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    title: "operator-visibility · Fix cycle 1",
    status: "completed",
    worker: null,
    budget_usd: "0",
    spent_usd: "0",
    created_at: "2026-08-05T08:00:00.000Z",
    updated_at: "2026-08-05T09:00:00.000Z",
    last_heartbeat_at: null,
    message_count: 0,
    last_message_preview: "",
    last_role: "assistant",
    archived: false,
    prompt: "",
    thread: [],
    metadata: {},
    parent_run_id: null,
    stuck_signal: null,
    started_at: "2026-08-05T08:00:00.000Z",
    completed_at: "2026-08-05T09:00:00.000Z",
    ...over,
  };
}

function prose(ts: string, content: string): ThreadEntry {
  return { role: "assistant", kind: "text", content, ts, meta: {} };
}

function call(ts: string, tool: string, id: string, parent?: string): ThreadEntry {
  return {
    role: "tool",
    kind: "tool_call",
    content: tool,
    ts,
    meta: parent === undefined
      ? { tool, tool_use_id: id }
      : { tool, tool_use_id: id, parent_tool_use_id: parent },
  };
}

function result(ts: string, id: string, isError: boolean, parent?: string): ThreadEntry {
  return {
    role: "tool",
    kind: "tool_result",
    content: isError ? "boom" : "ok",
    ts,
    meta: parent === undefined
      ? { tool_use_id: id, is_error: isError }
      : { tool_use_id: id, is_error: isError, parent_tool_use_id: parent },
  };
}

console.log("── the spec constant ────────────────────────────────────────");
check("U24's threshold is 50 entries", DIGEST_MIN_ENTRIES, 50);
check("the digest carries three closing turns", DIGEST_SNIPPETS, 3);
{
  const short = Array.from({ length: 49 }, (_, i) => prose(`t${i}`, `line ${i}`));
  check("49 entries: below the bar", deriveDigest(run(), short).show, false);
  check(
    "50 entries: at the bar, digest shows",
    deriveDigest(run(), [...short, prose("t49", "x")]).show,
    true,
  );
  check("an empty thread never shows", deriveDigest(run(), []).show, false);
}

console.log("\n── TIME TRUTH (Definition of Done #1) ──────────────────────");
{
  const d = deriveDigest(run(), []);
  check("a completed run's elapsed is settled_at − started_at", d.elapsed_ms, 3_600_000);
  check("…and is flagged frozen", d.elapsed_frozen, true);
  check("…and the run is settled", d.settled, true);
}
for (const status of ["completed", "failed", "cancelled"] as const) {
  const d = deriveDigest(run({ status }), []);
  check(`${status} is settled`, d.settled, true);
  check(`…with a frozen elapsed`, d.elapsed_ms, 3_600_000);
}
for (const status of ["running", "queued", "paused", "stuck"] as const) {
  const d = deriveDigest(run({ status, completed_at: null }), []);
  check(`${status} is NOT settled`, d.settled, false);
  check(`…and its elapsed is null, never invented`, d.elapsed_ms, null);
  check(`…flagged not frozen`, d.elapsed_frozen, false);
  check(`…but started_at is passed through for the renderer to tick`, d.started_at, "2026-08-05T08:00:00.000Z");
}
{
  // A running run that still carries a stale completed_at must not use it.
  const d = deriveDigest(run({ status: "running" }), []);
  check("a running run ignores a stale completed_at", d.elapsed_ms, null);
}
check(
  "postgres timestamp format parses (this is what the API actually returns)",
  deriveDigest(
    run({ started_at: "2026-08-05 06:46:36.994632+00", completed_at: "2026-08-05 07:02:26.316605+00" }),
    [],
  ).elapsed_ms,
  949_322,
);
check(
  "an unparsable timestamp yields null, never NaN",
  deriveDigest(run({ started_at: "not a date" }), []).elapsed_ms,
  null,
);
check(
  "a missing started_at yields null",
  deriveDigest(run({ started_at: null }), []).elapsed_ms,
  null,
);
check(
  "completed_at before started_at yields null, never a negative duration",
  deriveDigest(run({ completed_at: "2026-08-05T07:00:00.000Z" }), []).elapsed_ms,
  null,
);

console.log("\n── PURITY: the same input always derives the same digest ───");
{
  const thread = [prose("t0", "first"), call("t1", "Bash", "c1"), result("t2", "c1", false)];
  const a = JSON.stringify(deriveDigest(run(), thread));
  const b = JSON.stringify(deriveDigest(run(), thread));
  check("two derivations are byte-identical", a, b);
  check("…and the thread was not mutated", thread.length, 3);
  check("…nor were its entries", thread[0].content, "first");
}

console.log("\n── counts ──────────────────────────────────────────────────");
{
  const thread = [
    prose("t0", "opening"),
    call("t1", "Agent", "A"),
    call("t2", "Bash", "c1", "A"),
    result("t3", "c1", false, "A"),
    call("t4", "Bash", "c2"),
    result("t5", "c2", true),
    prose("t6", "closing"),
  ];
  const d = deriveDigest(run(), thread);
  check("entry_count is every entry handed over", d.entry_count, 7);
  check("top_level_count excludes sub-agent work", d.top_level_count, 5);
  check("subagent_entry_count is the remainder", d.subagent_entry_count, 2);
  check("…and the two add back to the whole", d.top_level_count + d.subagent_entry_count, d.entry_count);
  check("tool_call_count spans the whole thread", d.tool_call_count, 3);
  check("error_count counts is_error results", d.error_count, 1);
}
{
  const thread = [
    { role: "system", kind: "error", content: "executor died", ts: "t0" } as ThreadEntry,
    result("t1", "c1", true),
  ];
  check("kind:'error' entries count too", deriveDigest(run(), thread).error_count, 2);
}

console.log("\n── sub-agent roles ─────────────────────────────────────────");
{
  const thread = [call("t0", "Agent", "A"), call("t1", "Bash", "c1", "A")];
  const d = deriveDigest(
    run({ metadata: { subagents_v2: [{ tool_use_id: "A", role: "Explore" }] } }),
    thread,
  );
  check("one sub-agent", d.subagent_count, 1);
  check("…named from metadata", d.subagent_roles.join(","), "Explore");
}
{
  // Spawned this turn, no entries and no metadata yet — still part of the org
  // chart, and its role is honestly "unknown" rather than guessed.
  const d = deriveDigest(run(), [call("t0", "Agent", "A")]);
  check("a just-spawned sub-agent is counted", d.subagent_count, 1);
  check("…with an honest 'unknown' role", d.subagent_roles.join(","), "unknown");
}
{
  const thread = [call("t0", "Agent", "A"), call("t1", "Agent", "B"), call("t2", "x", "c", "A")];
  const d = deriveDigest(
    run({
      metadata: {
        subagents_v2: [
          { tool_use_id: "A", role: "Explore" },
          { tool_use_id: "B", role: "Explore" },
        ],
      },
    }),
    thread,
  );
  check("two sub-agents of the same role", d.subagent_count, 2);
  check("…listed as one distinct role", d.subagent_roles.join(","), "Explore");
}
{
  // A parent's sub-agents must not be attributed to a slice that has none.
  const d = deriveDigest(
    run({ metadata: { subagents_v2: [{ tool_use_id: "A", role: "Explore" }] } }),
    [prose("t0", "sub-agent prose")],
  );
  check("a thread that never mentions them reports none", d.subagent_count, 0);
}

console.log("\n── VERBATIM prose: clipped, never paraphrased ──────────────");
{
  const thread = [
    prose("t0", "one"),
    prose("t1", "two"),
    call("t2", "Bash", "c1"),
    prose("t3", "three"),
    prose("t4", "four"),
  ];
  const d = deriveDigest(run(), thread);
  check("the last three prose turns, oldest first", d.snippets.map((s) => s.text).join(","), "two,three,four");
  check("…each with its own timestamp", d.snippets.map((s) => s.ts).join(","), "t1,t3,t4");
  check("…none marked clipped", d.snippets.every((s) => !s.clipped), true);
  check("outcome is the closing turn", d.outcome, "four");
  check("…and says where it came from", d.outcome_source, "assistant_prose");
}
{
  const long = "L".repeat(400);
  const d = deriveDigest(run(), [prose("t0", long)]);
  check("a long snippet clips to 160 + ellipsis", d.snippets[0].text.length, 161);
  check("…marked clipped", d.snippets[0].clipped, true);
  check("…and is a VERBATIM prefix of the original", long.startsWith(d.snippets[0].text.slice(0, -1)), true);
  check("outcome clips at 240 + ellipsis", d.outcome?.length, 241);
  check("…also a verbatim prefix", long.startsWith((d.outcome ?? "").slice(0, -1)), true);
}
{
  const thread = [
    prose("t0", "  "),
    call("t1", "Bash", "c1"),
    result("t2", "c1", false),
    { role: "user", kind: "text", content: "do the thing", ts: "t3" } as ThreadEntry,
  ];
  const d = deriveDigest(run(), thread);
  check("whitespace-only prose is not a turn", d.snippets.length, 0);
  check("user messages are not the agent's prose", d.outcome_source, "none");
  check("…and outcome is null, not an empty string", d.outcome, null);
}
{
  const d = deriveDigest(
    run({ metadata: { current_activity: { kind: "tool_call", tool: "Bash", text: "running tsc", ts: "t" } } }),
    [call("t0", "Bash", "c1")],
  );
  check("with no prose, outcome falls back to current_activity", d.outcome, "running tsc");
  check("…and says so", d.outcome_source, "current_activity");
}
{
  const d = deriveDigest(run(), [{ role: "agent", content: "narration", ts: "t0" }]);
  check("role 'agent' with no kind counts as prose", d.snippets[0]?.text, "narration");
}

console.log("\n── prose scope: parent story vs sub-agent slice ────────────");
{
  const thread = [
    prose("t0", "parent speaking"),
    { role: "assistant", kind: "text", content: "sub speaking", ts: "t1", meta: { parent_tool_use_id: "A" } } as ThreadEntry,
  ];
  const d = deriveDigest(run(), thread);
  check("a parent's digest quotes only the parent", d.snippets.map((s) => s.text).join(","), "parent speaking");
  check("…and says which scope it used", d.prose_scope, "top-level");
}
{
  const slice: ThreadEntry[] = [
    { role: "assistant", kind: "text", content: "sub speaking", ts: "t1", meta: { parent_tool_use_id: "A" } },
    { role: "assistant", kind: "text", content: "sub closing", ts: "t2", meta: { parent_tool_use_id: "A" } },
  ];
  const d = deriveDigest(run(), slice);
  check("a pure slice reads its own prose", d.snippets.map((s) => s.text).join(","), "sub speaking,sub closing");
  check("…flagged as a slice", d.prose_scope, "slice");
  check("…with the slice's own counts", d.entry_count, 2);
}

console.log("\n── task derivation ─────────────────────────────────────────");
check("the run title wins when it has one", deriveDigest(run(), []).task, "operator-visibility · Fix cycle 1");
check("…and says so", deriveDigest(run(), []).task_source, "title");
{
  const d = deriveDigest(run({ title: "" }), [
    { role: "user", kind: "text", content: "Preamble.\nYour task: **601A · derivation core** — build it.", ts: "t0" },
  ]);
  check("no title: the first bolded phrase of the brief", d.task, "601A · derivation core");
  check("…sourced from the user entry", d.task_source, "user_entry");
}
{
  const d = deriveDigest(run({ title: "  " }), [
    { role: "user", kind: "text", content: "\n\nPlain first line\nsecond", ts: "t0" },
  ]);
  check("no bold either: the first non-empty line", d.task, "Plain first line");
}
{
  const d = deriveDigest(run({ title: "" }), []);
  check("nothing to go on: says so rather than guessing", d.task, "(no task recorded)");
  check("…sourced from nothing", d.task_source, "none");
}

console.log("\n── REAL FIXTURE: run 3853c154 (the architect's own session) ─");
{
  const fixtureUrl = new URL(
    "../../docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json",
    import.meta.url,
  );
  const real = (JSON.parse(readFileSync(fixtureUrl, "utf8")) as { run: RunDetail }).run;
  const d = deriveDigest(real, real.thread);

  check("digest shows (285 ≫ 50)", d.show, true);
  check("task", d.task, "operator-visibility · Plan: operator-visibility");
  check("task_source", d.task_source, "title");
  check("status", d.status, "completed");
  check("settled", d.settled, true);
  check("elapsed is frozen at 15m 49s", d.elapsed_ms, 949_322);
  check("elapsed_frozen", d.elapsed_frozen, true);
  check("model comes from metadata.model_resolved", d.model, "claude-fable-5");

  check("entry_count", d.entry_count, 285);
  check("top_level_count", d.top_level_count, 89);
  check("subagent_entry_count", d.subagent_entry_count, 196);
  check("tool_call_count", d.tool_call_count, 136);
  check("error_count", d.error_count, 3);
  check("subagent_count", d.subagent_count, 2);
  check("subagent_roles", d.subagent_roles.join(","), "Explore");

  check("prose_scope", d.prose_scope, "top-level");
  check("three closing turns", d.snippets.length, 3);
  check(
    "the middle one, verbatim",
    d.snippets[1].text,
    "Planning is complete. Two closing actions: append the durable findings to the Operator Log, and cancel the fallback wakeup.",
  );
  check("its timestamp", d.snippets[1].ts, "2026-08-05T07:01:59.902Z");
  check("the closing turn is clipped", d.snippets[2].clipped, true);
  check(
    "…and is a verbatim prefix of what the architect actually wrote",
    real.thread.some(
      (e) => typeof e.content === "string" && e.content.startsWith(d.snippets[2].text.slice(0, -1)),
    ),
    true,
  );
  check("outcome_source", d.outcome_source, "assistant_prose");
  check(
    "outcome opens with the architect's closing report",
    d.outcome?.startsWith("Round 0 complete. The waterfall plan is committed and the pipeline is seeded."),
    true,
  );

  // PURITY, restated on real data: derive twice, compare bytes.
  check(
    "deriving the real session twice is byte-identical",
    JSON.stringify(deriveDigest(real, real.thread)),
    JSON.stringify(d),
  );

  // A sub-agent's own digest, derived from its slice with no extra fetch —
  // there is no sub-agent run row to fetch, which is the whole point.
  const slice = subagentEntries(real.thread, "toolu_014raMUrJcAiXV61BerokrjN");
  const sd = deriveDigest(real, slice);
  check("the scout's slice is 118 entries", sd.entry_count, 118);
  check("…read as a slice", sd.prose_scope, "slice");
  check("…with its own top_level_count of 0", sd.top_level_count, 0);
  check("…and no sub-agents of its own", sd.subagent_count, 0);
  check("…it still clears the digest bar", sd.show, true);
  check(
    "…and its closing turn is the report it handed back",
    sd.snippets[sd.snippets.length - 1].text.startsWith("# Recon Report"),
    true,
  );
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — story-so-far digest`,
);
process.exit(failures === 0 ? 0 : 1);
