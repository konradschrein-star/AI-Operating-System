/**
 * check-live-sessions.ts — executable unit check for the LIVE SESSIONS block's
 * three pure modules:
 *
 *   • `liveSessions.ts` — what "live" means, the reading order, the activity
 *     and elapsed degrade rules, the age of an activity.
 *   • `engineBadge.ts`  — the data-driven badge map, its unknown-engine
 *     fallback, and the two null cases that must never become a claude badge.
 *   • `teamApi.ts`      — the optional-field contract (`undefined` is a THIRD
 *     state, not a synonym for null).
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, zero dependencies, one PASS/FAIL
 * line per case, `process.exit(1)` if anything fails. Same shape as
 * check-team-rows.ts, deliberately.
 *
 * ── EVERY EXPECTATION IS A LITERAL ───────────────────────────────────────────
 * Nothing here imports a constant from a module under test and compares it to
 * itself. `STATUS_RANK` is not exported and is not re-derived; the ordering is
 * asserted by naming the ids in the order they must come out. The badge labels
 * are written out as strings. An assertion that reads its expectation from the
 * subject passes at every value the subject could ever hold, which is the same
 * as no assertion at all (fleet note `test-imports-threshold-from-subject`).
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-live-sessions.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  type TeamActivity,
  type TeamNode,
  type TeamResponse,
} from "../../forge-control-web/app/desktop/team/teamApi.ts";
import {
  ENGINE_BADGE,
  engineBadge,
} from "../../forge-control-web/app/desktop/team/engineBadge.ts";
import {
  activityAgeMs,
  activityFor,
  activityText,
  countLiveSessions,
  engineFor,
  isLiveNode,
  liveStatusRank,
  liveTitle,
  selectLiveSessions,
} from "../../forge-control-web/app/desktop/team/liveSessions.ts";

const RESPONSE_NOW_ISO = "2026-08-25T12:00:00.000Z";
const T0 = Date.parse(RESPONSE_NOW_ISO);

const NO_TOKENS = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  total: 0,
};

/** A node with every required field, so each case states only what it varies.
 *  Defaults to a LIVE Claude worker: the cases below turn one knob each. */
function node(over: Partial<TeamNode> & { id: string }): TeamNode {
  return {
    kind: "worker",
    role: "builder",
    model: "claude-opus-5",
    status: "running",
    tokens: NO_TOKENS,
    working_ms: 60_000,
    working_ms_source: "thread",
    started_at: RESPONSE_NOW_ISO,
    settled: false,
    description: "a worker",
    parent_id: null,
    dismissed_at: null,
    subagents: [],
    task: null,
    engine: "claude-code",
    activity: null,
    ...over,
  };
}

function response(over: Partial<TeamResponse> & { manager: TeamNode }): TeamResponse {
  return {
    chat_id: "00000000-0000-0000-0000-0000000000ff",
    now: RESPONSE_NOW_ISO,
    project: { id: "11111111-1111-1111-1111-111111111111", status: "running" },
    link_source: "metadata",
    link_ambiguous: false,
    workers: [],
    complete: true,
    errors: [],
    ...over,
  };
}

function activity(over: Partial<TeamActivity> = {}): TeamActivity {
  return { kind: "tool_call", tool: "Bash", text: null, ts: RESPONSE_NOW_ISO, ...over };
}

/* ── Harness ──────────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

/* ── 1. THE LIVE PREDICATE ────────────────────────────────────────────────── */

console.log("\n── the live predicate: !settled, and nothing else ──");

eq("running is live", isLiveNode(node({ id: "a", status: "running" })), true);
eq(
  "queued is live — claimed work that has not started still belongs on the panel",
  isLiveNode(node({ id: "a", status: "queued" })),
  true,
);
eq(
  "stuck is live — the row that most needs looking at is not the one to hide",
  isLiveNode(node({ id: "a", status: "stuck" })),
  true,
);
eq("paused is live", isLiveNode(node({ id: "a", status: "paused" })), true);
eq(
  "completed is NOT live",
  isLiveNode(node({ id: "a", status: "completed", settled: true })),
  false,
);
eq(
  "failed is NOT live",
  isLiveNode(node({ id: "a", status: "failed", settled: true })),
  false,
);
eq(
  "cancelled is NOT live",
  isLiveNode(node({ id: "a", status: "cancelled", settled: true })),
  false,
);
eq(
  "`settled` beats the status word: a settled row calling itself running is not live",
  isLiveNode(node({ id: "a", status: "running", settled: true })),
  false,
);

/* ── 2. READING ORDER ─────────────────────────────────────────────────────── */

console.log("\n── reading order: running first, then stuck, paused, queued ──");

ok(
  "running sorts before stuck",
  liveStatusRank("running") < liveStatusRank("stuck"),
  `running=${liveStatusRank("running")} stuck=${liveStatusRank("stuck")}`,
);
ok(
  "stuck sorts before paused",
  liveStatusRank("stuck") < liveStatusRank("paused"),
);
ok(
  "paused sorts before queued",
  liveStatusRank("paused") < liveStatusRank("queued"),
);
ok(
  "an unseen status sorts last, rather than being folded into running",
  liveStatusRank("hibernating") > liveStatusRank("queued"),
  `hibernating=${liveStatusRank("hibernating")}`,
);
eq("running is rank 0", liveStatusRank("running"), 0);

{
  const res = response({
    manager: node({ id: "mgr", kind: "operator", status: "queued" }),
    workers: [
      node({ id: "w-stuck", status: "stuck" }),
      node({ id: "w-run-1", status: "running" }),
      node({ id: "w-done", status: "completed", settled: true }),
      node({ id: "w-run-2", status: "running" }),
      node({ id: "w-paused", status: "paused" }),
    ],
  });
  const rows = selectLiveSessions(res, T0);
  eq(
    "the block orders by status rank and keeps tree order inside a rank",
    rows.map((r) => r.node.id),
    ["w-run-1", "w-run-2", "w-stuck", "w-paused", "mgr"],
  );
  eq("settled nodes never appear", rows.some((r) => r.node.id === "w-done"), false);
  eq("countLiveSessions agrees with the selector", countLiveSessions(res), rows.length);
  eq("…and that number is 5 here", countLiveSessions(res), 5);
}

{
  /* Sub-agents are sessions doing work in their own right, and the walk has to
     reach them at every depth. */
  const res = response({
    manager: node({
      id: "mgr",
      kind: "operator",
      status: "completed",
      settled: true,
      subagents: [node({ id: "mgr-sub", kind: "subagent", status: "running" })],
    }),
    workers: [
      node({
        id: "w",
        status: "completed",
        settled: true,
        subagents: [
          node({ id: "w-sub-live", kind: "subagent", status: "running" }),
          node({ id: "w-sub-done", kind: "subagent", status: "completed", settled: true }),
        ],
      }),
    ],
  });
  eq(
    "a live sub-agent under a settled parent is still listed",
    selectLiveSessions(res, T0).map((r) => r.node.id),
    ["mgr-sub", "w-sub-live"],
  );
}

{
  const res = response({
    manager: node({ id: "mgr", kind: "operator", status: "completed", settled: true }),
    workers: [node({ id: "w", status: "failed", settled: true })],
  });
  eq("a fully settled tree yields no rows", selectLiveSessions(res, T0).length, 0);
  eq("…and counts zero without a clock", countLiveSessions(res), 0);
}

{
  /* A dismissal hides a row from the TREE. It must not be able to silence the
     LIVE block — "is anything running?" answered "no" by an old ✕ is the worst
     failure this block could have. */
  const res = response({
    manager: node({ id: "mgr", kind: "operator", status: "completed", settled: true }),
    workers: [node({ id: "w", status: "running", dismissed_at: RESPONSE_NOW_ISO })],
  });
  eq(
    "a dismissed but running node is still a live session",
    selectLiveSessions(res, T0).map((r) => r.node.id),
    ["w"],
  );
}

/* ── 3. THE ENGINE BADGE ──────────────────────────────────────────────────── */

console.log("\n── the badge: data-driven, two engines, no codex ──");

eq(
  "the map ships exactly the two engines that exist",
  Object.keys(ENGINE_BADGE).sort(),
  ["agy", "claude-code"],
);
eq("there is no codex entry", "codex" in ENGINE_BADGE, false);

eq("claude-code badges as claude", engineBadge("claude-code", null).label, "claude");
eq("claude-code wears the accent token", engineBadge("claude-code", null).tokenName, "accent");
eq("claude-code is known", engineBadge("claude-code", null).known, true);
eq("agy badges as agy", engineBadge("agy", null).label, "agy");
eq("agy wears a different token than claude", engineBadge("agy", null).tokenName, "decide");
eq("agy is known", engineBadge("agy", null).known, true);

eq(
  "an unknown engine renders its OWN RAW STRING, not a guess",
  engineBadge("codex", null).label,
  "codex",
);
eq(
  "…in a neutral token",
  engineBadge("codex", null).tokenName,
  "textMuted",
);
eq("…and says it is not known", engineBadge("codex", null).known, false);
eq(
  "…and carries the raw string on the element",
  engineBadge("some-engine-2027", null).attr,
  "some-engine-2027",
);
eq(
  "an unknown engine's label is never rewritten to claude",
  engineBadge("codex", null).label === "claude",
  false,
);

eq(
  "engine null (model unknown) renders the em dash",
  engineBadge(null, "unknown").label,
  "—",
);
eq(
  "engine undefined (older API) renders the em dash",
  engineBadge(undefined, "not-served").label,
  "—",
);
eq(
  "an empty engine string renders the em dash, not an empty badge",
  engineBadge("", "unknown").label,
  "—",
);
eq("a null engine is not marked known", engineBadge(null, "unknown").known, false);
eq("a null engine's data attribute is 'none'", engineBadge(null, "unknown").attr, "none");
ok(
  "the two gaps differ in words, so the tooltip names the right thing to fix",
  engineBadge(null, "unknown").title !== engineBadge(null, "not-served").title,
);
ok(
  "the measured-unknown tooltip refuses the claude default in so many words",
  engineBadge(null, "unknown").title.includes("Not claude: unknown"),
);
for (const gap of ["unknown", "not-served", null] as const) {
  eq(
    `a null engine never becomes a claude badge (gap=${String(gap)})`,
    engineBadge(null, gap).label === "claude",
    false,
  );
}

/* ── 4. THE OPTIONAL-FIELD CONTRACT ───────────────────────────────────────── */

console.log("\n── absent vs measured-null: three states, not two ──");

eq(
  "an absent engine field is 'not-served'",
  engineFor(node({ id: "a", engine: undefined })),
  { engine: null, gap: "not-served" },
);
eq(
  "a null engine field is 'unknown'",
  engineFor(node({ id: "a", engine: null })),
  { engine: null, gap: "unknown" },
);
eq(
  "a present engine field has no gap",
  engineFor(node({ id: "a", engine: "agy" })),
  { engine: "agy", gap: null },
);
eq(
  "an absent activity field is 'not-served'",
  activityFor(node({ id: "a", activity: undefined })),
  { activity: null, gap: "not-served" },
);
eq(
  "a null activity field is 'unknown'",
  activityFor(node({ id: "a", activity: null })),
  { activity: null, gap: "unknown" },
);
eq(
  "a present activity on a live node passes through",
  activityFor(node({ id: "a", activity: activity() })),
  { activity: activity(), gap: null },
);
eq(
  "A SETTLED NODE SHOWS NO ACTIVITY, even if the server shipped one",
  activityFor(
    node({ id: "a", status: "completed", settled: true, activity: activity() }),
  ),
  { activity: null, gap: "unknown" },
);

{
  const res = response({
    manager: node({ id: "mgr", kind: "operator", engine: undefined, activity: undefined }),
  });
  const [row] = selectLiveSessions(res, T0);
  eq("an older API degrades the engine cell, it does not crash it", row.engine, null);
  eq("…and names the gap", row.engineGap, "not-served");
  eq("…and degrades the activity cell the same way", row.activity, null);
  eq("…naming that gap too", row.activityGap, "not-served");
  eq("…and its age is null, never 0", row.activityAgeMs, null);
}

/* ── 5. THE ACTIVITY CELL ─────────────────────────────────────────────────── */

console.log("\n── the activity cell: never blank, never undated ──");

eq(
  "a tool_call renders the tool's name",
  activityText(activity({ kind: "tool_call", tool: "Bash" })),
  "Bash",
);
eq(
  "a tool_result renders THE SAME tool name — the 2s flush throttle must not flicker",
  activityText(activity({ kind: "tool_result", tool: "Bash" })),
  "Bash",
);
eq(
  "an assistant_text renders its text",
  activityText(activity({ kind: "assistant_text", tool: null, text: "reading the plan" })),
  "reading the plan",
);
eq(
  "a tool_result that answers no known tool says what it is, not nothing",
  activityText(activity({ kind: "tool_result", tool: null, text: null })),
  "reading a tool result",
);
eq(
  "a tool_call with no tool name says what it is",
  activityText(activity({ kind: "tool_call", tool: null, text: null })),
  "calling a tool",
);
eq(
  "an assistant_text with no text says what it is",
  activityText(activity({ kind: "assistant_text", tool: null, text: null })),
  "writing",
);
eq(
  "a kind this client has never seen renders its own raw string",
  activityText(activity({ kind: "compacting", tool: null, text: null })),
  "compacting",
);
for (const kind of ["tool_call", "tool_result", "assistant_text", "compacting"]) {
  ok(
    `no kind ever renders the empty string (${kind})`,
    activityText(activity({ kind, tool: null, text: null })) !== "",
  );
}

eq(
  "an activity stamped 8s ago is 8s old",
  activityAgeMs(activity({ ts: "2026-08-25T11:59:52.000Z" }), T0),
  8_000,
);
eq(
  "an unstamped activity has NO age — null, never 0",
  activityAgeMs(activity({ ts: null }), T0),
  null,
);
eq(
  "an unparsable stamp has no age either",
  activityAgeMs(activity({ ts: "not a date" }), T0),
  null,
);
eq(
  "no activity, no age",
  activityAgeMs(null, T0),
  null,
);
eq(
  "a stamp from the future clamps to 0 rather than reading as negative",
  activityAgeMs(activity({ ts: "2026-08-25T12:00:05.000Z" }), T0),
  0,
);

/* ── 6. ELAPSED ───────────────────────────────────────────────────────────── */

console.log("\n── elapsed: interpolated while live, null when unmeasured ──");

{
  const res = response({
    manager: node({ id: "mgr", kind: "operator", working_ms: 60_000 }),
  });
  eq(
    "a live row's elapsed is its working time plus the gap since the response",
    selectLiveSessions(res, T0 + 3_000)[0].elapsedMs,
    63_000,
  );
  eq(
    "interpolation is clamped, so a stalled poll cannot invent minutes",
    selectLiveSessions(res, T0 + 600_000)[0].elapsedMs,
    75_000,
  );
  eq(
    "a clock before the response adds nothing rather than subtracting",
    selectLiveSessions(res, T0 - 5_000)[0].elapsedMs,
    60_000,
  );
}

{
  const res = response({
    manager: node({ id: "mgr", kind: "operator", working_ms: null }),
  });
  eq(
    "an unmeasured working time stays NULL — the cell prints the em dash, never 0s",
    selectLiveSessions(res, T0 + 3_000)[0].elapsedMs,
    null,
  );
}

/* ── 7. THE TITLE ─────────────────────────────────────────────────────────── */

console.log("\n── the title: the task it is executing, else its own words ──");

eq(
  "a task title wins over the description",
  liveTitle(
    node({
      id: "a",
      description: "the run's own title",
      task: { round: 2, role: "builder", title: "client: live strip", status: "running" },
    }),
  ),
  "client: live strip",
);
eq(
  "no task falls back to the description",
  liveTitle(node({ id: "a", description: "the run's own title", task: null })),
  "the run's own title",
);
eq(
  "an empty task title does not win",
  liveTitle(
    node({
      id: "a",
      description: "the run's own title",
      task: { round: 2, role: "builder", title: "   ", status: "running" },
    }),
  ),
  "the run's own title",
);
eq(
  "nothing to say is null, not an empty string",
  liveTitle(node({ id: "a", description: null, task: null })),
  null,
);

/* ── Verdict ──────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("check-live-sessions: FAIL");
  process.exit(1);
}
console.log("check-live-sessions: PASS");
