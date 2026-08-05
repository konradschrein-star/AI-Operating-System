/**
 * check-team-rows.ts — executable unit check for the v3 team panel's data
 * layer: `flattenTeam` (ordering, depth, dismissal cascade) and
 * `interpolatedWorkingMs` (U16 frozen truth, the 15s interpolation clamp,
 * null-means-unknown), plus the two formatters.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-duration.ts, deliberately.
 *
 * It imports `teamRows.ts` / `teamApi.ts` directly — neither has React or JSX,
 * which is exactly why the flattening and the time policy live there and not
 * inside the panel component.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-team-rows.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none —
 * the brief's forge-control-web invocation cannot work today.)
 */

import {
  fmtTokens,
  fmtWorkingTime,
  type TeamNode,
  type TeamResponse,
} from "../../forge-control-web/app/desktop/team/teamApi.ts";
import {
  CLIENT_INTERPOLATION_CAP_MS,
  flattenTeam,
  interpolatedWorkingMs,
  responseNowMs,
  type TeamRow,
} from "../../forge-control-web/app/desktop/team/teamRows.ts";

const RESPONSE_NOW_ISO = "2026-08-05T12:00:00.000Z";
const T0 = Date.parse(RESPONSE_NOW_ISO);

const NO_TOKENS = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  total: 0,
};

/** A node with every required field, so each case only states what it varies. */
function node(over: Partial<TeamNode> & { id: string }): TeamNode {
  return {
    kind: "worker",
    role: "builder",
    model: "claude-sonnet-5",
    status: "completed",
    tokens: NO_TOKENS,
    working_ms: 0,
    working_ms_source: "thread",
    started_at: RESPONSE_NOW_ISO,
    settled: true,
    description: null,
    parent_id: null,
    subagents: [],
    task: null,
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

function row(over: Partial<TeamRow> & { node: TeamNode }): TeamRow {
  return {
    depth: 1,
    parentDescription: null,
    displayWorkingMs: over.node.working_ms,
    ...over,
  };
}

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

const NONE: ReadonlySet<string> = new Set();

/* ── The fixture tree ──────────────────────────────────────────────────────
 *
 *   manager                depth 0
 *   ├─ worker-a            depth 1
 *   │  ├─ sub-a1           depth 2
 *   │  └─ sub-a2           depth 2
 *   └─ worker-b            depth 1
 */
const subA1 = node({
  id: "sub-a1",
  kind: "subagent",
  role: "Explore",
  parent_id: "worker-a",
  description: "recon the rail",
  working_ms: 4_000,
});
const subA2 = node({
  id: "sub-a2",
  kind: "subagent",
  role: "Explore",
  parent_id: "worker-a",
  description: "recon the panel",
  working_ms: 6_000,
});
const workerA = node({
  id: "worker-a",
  description: "build the team panel",
  parent_id: null,
  subagents: [subA1, subA2],
  working_ms: 60_000,
});
const workerB = node({
  id: "worker-b",
  role: "reviewer",
  description: "review the team panel",
  subagents: [],
  working_ms: 30_000,
});
const manager = node({
  id: "manager",
  kind: "operator",
  role: null,
  model: "claude-fable-5",
  status: "running",
  settled: false,
  description: "operator chat",
  working_ms: 120_000,
});
const TREE = response({ manager, workers: [workerA, workerB] });

console.log("── flattenTeam: ordering + depth ─────────────────────────────");
{
  const rows = flattenTeam(TREE, NONE);
  check("row count = 1 manager + 2 workers + 2 sub-agents", rows.length, 5);
  check(
    "order is manager, worker-a, its two sub-agents, worker-b",
    rows.map((r) => r.node.id).join(","),
    "manager,worker-a,sub-a1,sub-a2,worker-b",
  );
  check(
    "depths are 0,1,2,2,1",
    rows.map((r) => r.depth).join(","),
    "0,1,2,2,1",
  );
  check("manager has no parent description", rows[0].parentDescription, null);
  check(
    "a worker's parentDescription is the manager's",
    rows[1].parentDescription,
    "operator chat",
  );
  check(
    "a sub-agent's parentDescription is its worker's",
    rows[2].parentDescription,
    "build the team panel",
  );
  check(
    "displayWorkingMs is node.working_ms verbatim",
    rows[1].displayWorkingMs,
    60_000,
  );
}
{
  // The operator chat is a real Claude Code session and spawns Task
  // sub-agents too; they hang under it at depth 1, before the workers.
  const opSub = node({
    id: "sub-m1",
    kind: "subagent",
    parent_id: "manager",
    description: "operator's own scout",
  });
  const rows = flattenTeam(
    response({
      manager: { ...manager, subagents: [opSub] },
      workers: [workerB],
    }),
    NONE,
  );
  check(
    "manager's own sub-agents render at depth 1, before the workers",
    rows.map((r) => `${r.node.id}@${r.depth}`).join(","),
    "manager@0,sub-m1@1,worker-b@1",
  );
}
{
  const rows = flattenTeam(response({ manager }), NONE);
  check("a chat with no project still renders its manager", rows.length, 1);
  check("…at depth 0", rows[0].depth, 0);
}

console.log("\n── flattenTeam: dismissal ────────────────────────────────────");
{
  const rows = flattenTeam(TREE, new Set(["worker-a"]));
  check(
    "dismissing a worker takes its sub-agents with it",
    rows.map((r) => r.node.id).join(","),
    "manager,worker-b",
  );
}
{
  const rows = flattenTeam(TREE, new Set(["sub-a1"]));
  check(
    "dismissing one sub-agent leaves its sibling and its parent",
    rows.map((r) => r.node.id).join(","),
    "manager,worker-a,sub-a2,worker-b",
  );
}
{
  const rows = flattenTeam(TREE, new Set(["manager"]));
  check(
    "dismissing the manager hides only the manager's subtree, not the workers",
    rows.map((r) => r.node.id).join(","),
    "worker-a,sub-a1,sub-a2,worker-b",
  );
}
{
  const rows = flattenTeam(TREE, new Set(["worker-a", "worker-b", "manager"]));
  check("dismissing everything yields an empty array", rows.length, 0);
}
{
  const rows = flattenTeam(TREE, new Set(["nobody-by-that-id"]));
  check("an unknown dismissed id changes nothing", rows.length, 5);
}

console.log("\n── interpolatedWorkingMs ─────────────────────────────────────");
const RESP_NOW = responseNowMs(TREE);
check("responseNowMs parses the response clock", RESP_NOW, T0);

{
  const settled = row({ node: node({ id: "s", settled: true, working_ms: 130_000 }) });
  const at0 = interpolatedWorkingMs(settled, RESP_NOW, T0);
  const at30 = interpolatedWorkingMs(settled, RESP_NOW, T0 + 30_000);
  check("settled row at t = the server's value", at0, 130_000);
  check("settled row at t+30s is IDENTICAL (U16 frozen truth)", at30, 130_000);
  check("…and identical to itself, not merely close", at0 === at30, true);
  check(
    "settled row six hours later is still identical",
    interpolatedWorkingMs(settled, RESP_NOW, T0 + 6 * 3_600_000),
    130_000,
  );
}
{
  const running = row({
    node: node({ id: "r", status: "running", settled: false, working_ms: 60_000 }),
  });
  check("running row at t = the server's value", interpolatedWorkingMs(running, RESP_NOW, T0), 60_000);
  check(
    "running row grows with the clock",
    interpolatedWorkingMs(running, RESP_NOW, T0 + 5_000),
    65_000,
  );
  check(
    "running row grows to exactly the cap at +15s",
    interpolatedWorkingMs(running, RESP_NOW, T0 + CLIENT_INTERPOLATION_CAP_MS),
    75_000,
  );
  check(
    "running row CLAMPS past the cap (poll stalled, tab backgrounded)",
    interpolatedWorkingMs(running, RESP_NOW, T0 + 10 * 60_000),
    75_000,
  );
  check(
    "a clock behind the response never subtracts",
    interpolatedWorkingMs(running, RESP_NOW, T0 - 30_000),
    60_000,
  );
  check(
    "an unparsable response clock yields the base, not NaN",
    interpolatedWorkingMs(running, Number.NaN, T0 + 5_000),
    60_000,
  );
}
{
  const settledNull = row({
    node: node({ id: "sn", settled: true, working_ms: null, working_ms_source: null }),
  });
  const runningNull = row({
    node: node({
      id: "rn",
      status: "running",
      settled: false,
      working_ms: null,
      working_ms_source: null,
    }),
  });
  check("null on a settled row stays null at t", interpolatedWorkingMs(settledNull, RESP_NOW, T0), null);
  check(
    "null on a settled row stays null at t+30s",
    interpolatedWorkingMs(settledNull, RESP_NOW, T0 + 30_000),
    null,
  );
  check("null on a running row stays null at t", interpolatedWorkingMs(runningNull, RESP_NOW, T0), null);
  check(
    "null on a running row stays null at t+30s — unknown never becomes 0",
    interpolatedWorkingMs(runningNull, RESP_NOW, T0 + 30_000),
    null,
  );
}
{
  // Measured zero is not unknown: a node that genuinely did no measurable work
  // must render "0s", and a running one must still tick up from it.
  const zero = row({ node: node({ id: "z", settled: true, working_ms: 0 }) });
  check("a measured 0 survives as 0, not null", interpolatedWorkingMs(zero, RESP_NOW, T0 + 30_000), 0);
  check("…and renders as '0s', not '—'", fmtWorkingTime(interpolatedWorkingMs(zero, RESP_NOW, T0)), "0s");
}

console.log("\n── fmtWorkingTime ───────────────────────────────────────────");
check("null → em dash, NEVER '0s'", fmtWorkingTime(null), "—");
check("negative → em dash", fmtWorkingTime(-1), "—");
check("NaN → em dash", fmtWorkingTime(Number.NaN), "—");
check("measured zero → '0s'", fmtWorkingTime(0), "0s");
check("45s", fmtWorkingTime(45_000), "45s");
check("59.9s floors to 59s", fmtWorkingTime(59_900), "59s");
check("60s → '1m 00s'", fmtWorkingTime(60_000), "1m 00s");
check("12m 30s", fmtWorkingTime(12 * 60_000 + 30_000), "12m 30s");
check("1h 04m", fmtWorkingTime(64 * 60_000), "1h 04m");

console.log("\n── fmtTokens ────────────────────────────────────────────────");
check("0 → '0'", fmtTokens(0), "0");
check("negative → '0'", fmtTokens(-5), "0");
check("NaN → '0'", fmtTokens(Number.NaN), "0");
check("987 → '987'", fmtTokens(987), "987");
check("987.4 rounds to '987'", fmtTokens(987.4), "987");
check("999 → '999'", fmtTokens(999), "999");
check("1000 → '1.0k'", fmtTokens(1_000), "1.0k");
check("9999 → '10.0k'", fmtTokens(9_999), "10.0k");
check("12_345 → '12.3k'", fmtTokens(12_345), "12.3k");
check("204_700 → '205k'", fmtTokens(204_700), "205k");
check("1_200_000 → '1.20M'", fmtTokens(1_200_000), "1.20M");
check("12_300_000 → '12.3M'", fmtTokens(12_300_000), "12.3M");

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — team row model`,
);
process.exit(failures === 0 ? 0 : 1);
