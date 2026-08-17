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
  createTeamRowCache,
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
    dismissed_at: null,
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
  const { rows } = flattenTeam(TREE, NONE);
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
  const { rows } = flattenTeam(
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
  const { rows } = flattenTeam(response({ manager }), NONE);
  check("a chat with no project still renders its manager", rows.length, 1);
  check("…at depth 0", rows[0].depth, 0);
}

console.log("\n── flattenTeam: dismissal ────────────────────────────────────");
{
  const { rows } = flattenTeam(TREE, new Set(["worker-a"]));
  check(
    "dismissing a worker takes its sub-agents with it",
    rows.map((r) => r.node.id).join(","),
    "manager,worker-b",
  );
}
{
  const { rows } = flattenTeam(TREE, new Set(["sub-a1"]));
  check(
    "dismissing one sub-agent leaves its sibling and its parent",
    rows.map((r) => r.node.id).join(","),
    "manager,worker-a,sub-a2,worker-b",
  );
}
{
  const { rows } = flattenTeam(TREE, new Set(["manager"]));
  check(
    "dismissing the manager hides only the manager's subtree, not the workers",
    rows.map((r) => r.node.id).join(","),
    "worker-a,sub-a1,sub-a2,worker-b",
  );
}
{
  const { rows } = flattenTeam(TREE, new Set(["worker-a", "worker-b", "manager"]));
  check("dismissing everything yields an empty array", rows.length, 0);
}
{
  const { rows } = flattenTeam(TREE, new Set(["nobody-by-that-id"]));
  check("an unknown dismissed id changes nothing", rows.length, 5);
}

console.log("\n── flattenTeam: hiddenCount is ROWS, not ids (round 505 #3) ──");
{
  // The label used to count `dismissed.size`, which is wrong in BOTH
  // directions. Each case below is one of the reviewer's reproductions.
  check("nothing dismissed → 0", flattenTeam(TREE, NONE).hiddenCount, 0);
  {
    // Undercount: one id, three rows gone (worker-a owns sub-a1 + sub-a2).
    const flat = flattenTeam(TREE, new Set(["worker-a"]));
    check("dismissing a parent counts its whole subtree", flat.hiddenCount, 3);
    check("…and it equals the rows actually withheld", flat.hiddenCount, 5 - flat.rows.length);
  }
  {
    // Phantom: ids that match nothing hide nothing and must count nothing —
    // the "60000 hidden · show" bug on a panel showing every row.
    const junk = new Set(["nonexistent-a", "nonexistent-b", "nonexistent-c"]);
    const flat = flattenTeam(TREE, junk);
    check("ids matching nothing count 0", flat.hiddenCount, 0);
    check("…and every row still renders", flat.rows.length, 5);
  }
  {
    const flat = flattenTeam(TREE, new Set(["sub-a1"]));
    check("a leaf dismissal counts 1", flat.hiddenCount, 1);
  }
  {
    // A dismissed id nested under an already-dismissed parent is never
    // reached, so it cannot be counted twice.
    const flat = flattenTeam(TREE, new Set(["worker-a", "sub-a1", "sub-a2"]));
    check("nested dismissals do not double-count", flat.hiddenCount, 3);
    check("…rows left = manager + worker-b", flat.rows.length, 2);
  }
  {
    const flat = flattenTeam(TREE, new Set(["manager", "worker-a", "worker-b"]));
    check("dismissing everything counts every node", flat.hiddenCount, 5);
    check("…and renders nothing", flat.rows.length, 0);
  }
  {
    // Mixed real + junk: only the real one may be counted.
    const flat = flattenTeam(TREE, new Set(["worker-b", "ghost-1", "ghost-2"]));
    check("junk beside a real dismissal does not inflate the count", flat.hiddenCount, 1);
  }
}

/* ── Row identity, the L1 half of round 1302 ───────────────────────────────
 *
 * The panel's `memo(TeamRowView)` can only bail out if the wrapper object it
 * is handed is the SAME object as last poll. Round 1301 measured 0 bail-outs
 * in 432 compares because `flattenTeam` allocated a fresh wrapper for every
 * node on every response — even though react-query's structural sharing had
 * kept 428 of those 432 inner `node` objects identity-stable.
 *
 * These cases assert the contract that fix rests on, in the same terms the
 * measurement used: identity, with `===`, never deep equality. They simulate
 * structural sharing the way react-query actually delivers it — a new response
 * object whose unchanged children are the SAME objects, and whose one changed
 * node is a new object.
 */
console.log("\n── flattenTeam: wrapper identity (round 1302 L1) ─────────────");
{
  const cache = createTeamRowCache();
  const first = flattenTeam(TREE, NONE, cache).rows;
  const second = flattenTeam(TREE, NONE, cache).rows;
  check("same response twice → same row count", second.length, first.length);
  check(
    "same response twice → EVERY wrapper is the identical object",
    first.every((rowA, i) => rowA === second[i]),
    true,
  );
  check(
    "…and the nodes inside them are untouched too",
    first.every((rowA, i) => rowA.node === second[i].node),
    true,
  );
}
{
  // Structural sharing, reproduced: one node replaced, every other node the
  // same object. Exactly what a poll delivers when one worker's status moves.
  const cache = createTeamRowCache();
  const before = flattenTeam(TREE, NONE, cache).rows;
  const movedWorkerB = node({
    id: "worker-b",
    role: "reviewer",
    description: "review the team panel",
    subagents: [],
    working_ms: 30_000,
    status: "running",
    settled: false,
  });
  const nextTree = response({ manager, workers: [workerA, movedWorkerB] });
  const after = flattenTeam(nextTree, NONE, cache).rows;

  const fresh = after.filter((rowA, i) => rowA !== before[i]).map((r) => r.node.id);
  check("one node changed → exactly one fresh wrapper", fresh.length, 1);
  check("…and it is the node that changed", fresh[0], "worker-b");
  check(
    "…every other wrapper survives by identity",
    after.filter((rowA, i) => rowA === before[i]).length,
    before.length - 1,
  );
  check(
    "the fresh wrapper carries the new node, not the stale one",
    after[after.length - 1].node,
    movedWorkerB,
  );
}
{
  // A row whose PARENT's description changes is a changed row even though its
  // own node did not move: `parentDescription` is rendered in the lineage
  // tooltip, so reusing the wrapper would show stale lineage.
  const cache = createTeamRowCache();
  const before = flattenTeam(TREE, NONE, cache).rows;
  const renamedA = node({
    id: "worker-a",
    description: "build the team panel, again",
    parent_id: null,
    subagents: [subA1, subA2],
    working_ms: 60_000,
  });
  const after = flattenTeam(
    response({ manager, workers: [renamedA, workerB] }),
    NONE,
    cache,
  ).rows;
  const freshIds = after.filter((rowA, i) => rowA !== before[i]).map((r) => r.node.id);
  check(
    "a renamed parent refreshes itself AND its sub-agents' wrappers",
    freshIds.join(","),
    "worker-a,sub-a1,sub-a2",
  );
}
{
  // Without a cache the old behaviour is unchanged — every wrapper fresh. The
  // cache is opt-in, so a caller that does not pass one cannot be surprised by
  // an object it shares with a previous call.
  const a = flattenTeam(TREE, NONE).rows;
  const b = flattenTeam(TREE, NONE).rows;
  check("no cache → no wrapper is shared", a.some((rowA, i) => rowA === b[i]), false);
  check("…but the content is identical", a.length === b.length && a[0].node === b[0].node, true);
}
{
  // Dismissing must not corrupt the cache: the surviving rows keep identity,
  // the dismissed subtree's wrappers leave, and restoring builds fresh ones
  // rather than resurrecting a wrapper whose depth may have changed.
  const cache = createTeamRowCache();
  const full = flattenTeam(TREE, NONE, cache).rows;
  const pruned = flattenTeam(TREE, new Set(["worker-a"]), cache).rows;
  check("dismissal removes the subtree's rows", pruned.map((r) => r.node.id).join(","), "manager,worker-b");
  check(
    "…and the survivors keep their identity across it",
    pruned[0] === full[0] && pruned[1] === full[4],
    true,
  );
  check("…the cache dropped the dismissed subtree", cache.byId.has("worker-a"), false);
  check("…and kept exactly the rendered rows", cache.byId.size, 2);

  const restored = flattenTeam(TREE, NONE, cache).rows;
  check("restore brings every row back", restored.length, 5);
  check("…the never-dismissed manager still keeps identity", restored[0] === full[0], true);
  check("…the restored rows are fresh wrappers", restored[1] === full[1], false);
}
{
  // The empty tree and the all-dismissed tree: no cache entries, no crash, and
  // a stable `hiddenCount`.
  const cache = createTeamRowCache();
  const lone = response({ manager, workers: [] });
  flattenTeam(lone, NONE, cache);
  check("manager-only tree caches exactly one wrapper", cache.byId.size, 1);
  const all = flattenTeam(TREE, new Set(["manager", "worker-a", "worker-b"]), cache);
  check("everything dismissed → no rows", all.rows.length, 0);
  check("…hiddenCount still counts ROWS, not ids", all.hiddenCount, 5);
  check("…and the cache is empty, not stale", cache.byId.size, 0);
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
