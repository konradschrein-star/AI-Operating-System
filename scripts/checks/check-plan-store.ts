/**
 * check-plan-store.ts — executable unit check for the U27 plan store:
 * `toPlanNodes`, `groupPlanPhases`, `planProgress`, `planEdges`,
 * `statusTokenName` and `phaseBase` in
 * forge-control-web/app/desktop/team/planStore.ts.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-team-rows.ts and check-nav-stack.ts, deliberately.
 *
 * It imports `planStore.ts` / `planApi.ts` directly — neither has React or
 * JSX, which is exactly why the flattening, the grouping and the counting
 * rule live there and not inside the Kanban component.
 *
 * The four claims this file exists to hold down:
 *   1. an UNKNOWN status survives verbatim into the node and counts as
 *      not-done (never coerced into a neighbouring bucket — NFU6);
 *   2. `planProgress` is EXACTLY the rail badge's SQL, so the two numbers
 *      cannot drift (round 704's three-way agreement);
 *   3. `planEdges` is the whole graph projection and already works;
 *   4. `tier: null` produces `meta` with no `tier` key, not `tier: undefined`.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import type { PlanPhase, PlanResponse, PlanTask } from "../../forge-control-web/app/desktop/team/planApi.ts";
import {
  KNOWN_STATUSES,
  groupPlanPhases,
  phaseBase,
  planEdges,
  planProgress,
  statusTokenName,
  toPlanNodes,
} from "../../forge-control-web/app/desktop/team/planStore.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

function checkDeep(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        expected ${b}\n        got      ${a}`));
}

/* ── Fixtures ──────────────────────────────────────────────────────────────
 *
 * THE CORPUS is this project's real shape: rounds 0..703 across the eight
 * hundreds-blocks 0, 100, … 700, ordered the way the server orders them
 * (`ORDER BY round, created_at`). Blocks 0 and 100 carry no doc_path because
 * this corpus numbers its documents `00-`…`16-` by document rather than by
 * round, so `matchPhaseDoc` finds nothing for them — the honest absence the
 * endpoint ships today. Block 0 also carries no title, to prove the field
 * stays absent rather than becoming "".
 *
 * Round 703 wears the status `harvesting`, which no migration admits and no
 * engine emits. It is the point of half this file.
 */

function task(over: Partial<PlanTask> & { id: string; round: number }): PlanTask {
  return {
    role: "builder",
    title: `task ${over.round}`,
    status: "done",
    tier: null,
    deps: [],
    ...over,
  };
}

const PHASES: PlanPhase[] = [
  {
    round_base: 0,
    tasks: [
      task({ id: "t-0", round: 0, role: "architect", tier: "flagship" }),
      task({ id: "t-1", round: 1, role: "planner", deps: ["t-0"] }),
    ],
  },
  {
    round_base: 100,
    title: "phase 100 — read-side API",
    tasks: [
      task({ id: "t-100", round: 100, role: "planner", tier: "standard", deps: ["t-0", "t-1"] }),
      task({ id: "t-101", round: 101 }),
    ],
  },
  {
    round_base: 200,
    title: "phase 200 — live panel",
    tasks: [task({ id: "t-200", round: 200, role: "planner" }), task({ id: "t-201", round: 201 })],
  },
  {
    round_base: 300,
    title: "phase 300 — chat surface",
    doc_path: "300-read-side-api.md",
    tasks: [
      task({ id: "t-300", round: 300, role: "planner" }),
      task({ id: "t-301", round: 301 }),
      task({ id: "t-302", round: 302, role: "reviewer" }),
    ],
  },
  {
    round_base: 400,
    title: "phase 400 — right panel",
    tasks: [task({ id: "t-400", round: 400, role: "planner" }), task({ id: "t-401", round: 401 })],
  },
  {
    round_base: 500,
    title: "phase 500 — control plane",
    tasks: [task({ id: "t-500", round: 500, role: "planner" }), task({ id: "t-501", round: 501 })],
  },
  {
    round_base: 600,
    title: "phase 600 — worker legibility",
    tasks: [
      task({ id: "t-600", round: 600, role: "planner" }),
      task({ id: "t-601", round: 601 }),
      task({ id: "t-606", round: 606, status: "running" }),
    ],
  },
  {
    round_base: 700,
    title: "phase 700 — kanban",
    doc_path: "700-kanban.md",
    tasks: [
      task({ id: "t-700", round: 700, role: "planner" }),
      task({ id: "t-701", round: 701, status: "pending", deps: ["t-700"] }),
      task({ id: "t-702", round: 702, status: "pending" }),
      // The stranger. No CHECK constraint admits it; it must still arrive.
      task({ id: "t-703", round: 703, status: "harvesting", deps: ["t-700", "t-701"] }),
    ],
  },
];

function response(over: Partial<PlanResponse> = {}): PlanResponse {
  return {
    chat_id: "00000000-0000-0000-0000-0000000000ff",
    project: { id: "11111111-1111-1111-1111-111111111111", status: "running" },
    link_source: "metadata",
    link_ambiguous: false,
    phases: PHASES,
    docs: ["12-ui-v3-requirements.md", "13-ui-v3-architecture.md", "300-read-side-api.md", "700-kanban.md"],
    ...over,
  };
}

const CORPUS = response();
const NODES = toPlanNodes(CORPUS);

const EMPTY = response({ phases: [], docs: [] });
const EMPTY_NODES = toPlanNodes(EMPTY);

/* HAND COUNT, so the assertions below are not the code marking its own work:
 *   0:2  100:2  200:2  300:3  400:2  500:2  600:3  700:4   → 20 tasks
 *   not done: t-606 running, t-701 pending, t-702 pending, t-703 harvesting
 *   → done 16, total 20
 *   deps: t-1(1) + t-100(2) + t-701(1) + t-703(2) → 6 edges */
const HAND_TOTAL = 20;
const HAND_DONE = 16;
const HAND_EDGES = 6;

console.log("── toPlanNodes ──────────────────────────────────────────────");
check("flattens every task in every phase", NODES.length, HAND_TOTAL);
check("preserves server order — first node is round 0", NODES[0]?.id, "t-0");
check("preserves server order — last node is round 703", NODES[NODES.length - 1]?.id, "t-703");
checkDeep(
  "rounds come out ascending, exactly as the server ordered them",
  NODES.map((n) => n.round),
  [0, 1, 100, 101, 200, 201, 300, 301, 302, 400, 401, 500, 501, 600, 601, 606, 700, 701, 702, 703],
);
checkDeep("a node is the U27 shape and nothing else", NODES[1], {
  id: "t-1",
  title: "task 1",
  status: "done",
  round: 1,
  role: "planner",
  deps: ["t-0"],
  meta: {},
});
check("deps are copied, not aliased to the wire array", NODES[1]?.deps === PHASES[0]?.tasks[1]?.deps, false);
checkDeep("…and copied faithfully", NODES[1]?.deps, ["t-0"]);
check("empty phases[] → no nodes", EMPTY_NODES.length, 0);

console.log("\n── meta.tier / meta.run_id ──────────────────────────────────");
{
  const flagship = NODES.find((n) => n.id === "t-0");
  const standard = NODES.find((n) => n.id === "t-100");
  const tierless = NODES.find((n) => n.id === "t-101");
  check("tier 'flagship' lands on meta.tier", flagship?.meta.tier, "flagship");
  check("tier 'standard' lands on meta.tier", standard?.meta.tier, "standard");
  check("tier: null → meta has NO tier key", "tier" in (tierless?.meta ?? {}), false);
  checkDeep("…and meta serialises as {} , not {\"tier\":null}", tierless?.meta, {});
  check("run_id is unset — the wire does not carry it today", "run_id" in (flagship?.meta ?? {}), false);
}

console.log("\n── unknown status survives ──────────────────────────────────");
{
  const stranger = NODES.find((n) => n.id === "t-703");
  check("an unrecognised status reaches the node VERBATIM", stranger?.status, "harvesting");
  check("KNOWN_STATUSES does not contain it", KNOWN_STATUSES.includes("harvesting"), false);
  check("…and it is not silently dropped from the array", NODES.filter((n) => n.id === "t-703").length, 1);
  check("it counts as NOT done", planProgress([stranger!]).done, 0);
  check("…while still counting toward total", planProgress([stranger!]).total, 1);
  check("its group counts it in total, not in done", groupPlanPhases([stranger!], CORPUS)[0]?.done, 0);
  check("…same group, total 1", groupPlanPhases([stranger!], CORPUS)[0]?.total, 1);
}

console.log("\n── statusTokenName ──────────────────────────────────────────");
checkDeep(
  "KNOWN_STATUSES is the migration's CHECK list, in lifecycle order",
  KNOWN_STATUSES,
  ["pending", "ready", "running", "done", "failed", "blocked"],
);
check("pending  → textMuted", statusTokenName("pending"), "textMuted");
check("ready    → textMuted", statusTokenName("ready"), "textMuted");
check("running  → info", statusTokenName("running"), "info");
check("done     → ok", statusTokenName("done"), "ok");
check("failed   → bleed", statusTokenName("failed"), "bleed");
check("blocked  → stuck, never the running colour", statusTokenName("blocked"), "stuck");
check("blocked is not folded into running", statusTokenName("blocked") === statusTokenName("running"), false);
check("unknown  → textFaint (TeamRow's own fallback)", statusTokenName("harvesting"), "textFaint");
check("cancelled → textFaint, where TeamRow puts it", statusTokenName("cancelled"), "textFaint");
check("empty string → textFaint, not a crash", statusTokenName(""), "textFaint");
check("'DONE' is not 'done' — status compare is exact", statusTokenName("DONE"), "textFaint");
for (const s of KNOWN_STATUSES) {
  check(`every known status has a non-fallback token: ${s}`, statusTokenName(s) === "textFaint", false);
}

console.log("\n── phaseBase ────────────────────────────────────────────────");
check("0   → 0", phaseBase(0), 0);
check("1   → 0", phaseBase(1), 0);
check("99  → 0", phaseBase(99), 0);
check("100 → 100", phaseBase(100), 100);
check("606 → 600", phaseBase(606), 600);
check("703 → 700", phaseBase(703), 700);

console.log("\n── groupPlanPhases ──────────────────────────────────────────");
{
  const groups = groupPlanPhases(NODES, CORPUS);
  check("eight blocks across rounds 0..703", groups.length, 8);
  checkDeep(
    "ascending by block: 0,100,…,700",
    groups.map((g) => g.round_base),
    [0, 100, 200, 300, 400, 500, 600, 700],
  );
  checkDeep(
    "every node lands in exactly one column",
    groups.map((g) => g.total),
    [2, 2, 2, 3, 2, 2, 3, 4],
  );
  check(
    "column totals sum to the node count",
    groups.reduce((n, g) => n + g.total, 0),
    HAND_TOTAL,
  );
  check(
    "column done-counts sum to planProgress().done",
    groups.reduce((n, g) => n + g.done, 0),
    HAND_DONE,
  );
  check("block 600: 2 of 3 done (606 is running)", `${groups[6]?.done}/${groups[6]?.total}`, "2/3");
  check("block 700: 1 of 4 done (pending, pending, harvesting)", `${groups[7]?.done}/${groups[7]?.total}`, "1/4");

  check("title comes from the server", groups[3]?.title, "phase 300 — chat surface");
  check("doc_path comes from the server", groups[3]?.doc_path, "300-read-side-api.md");
  check("a server phase with no title → no title key", "title" in (groups[0] ?? {}), false);
  check("a server phase with no doc_path → no doc_path key", "doc_path" in (groups[1] ?? {}), false);
  check("…and that block still has its title", groups[1]?.title, "phase 100 — read-side API");
  checkDeep(
    "column membership is by round, in server order",
    groups[7]?.nodes.map((n) => n.id),
    ["t-700", "t-701", "t-702", "t-703"],
  );

  check("empty phases[] → no columns", groupPlanPhases(EMPTY_NODES, EMPTY).length, 0);

  // A node whose block the response never listed must still get a column
  // rather than vanish (NFU6) — derived base, no title, no doc_path.
  const orphan = { ...NODES[0]!, id: "t-9000", round: 9000 };
  const withOrphan = groupPlanPhases([...NODES, orphan], CORPUS);
  check("a node outside every server phase still gets a column", withOrphan.length, 9);
  check("…carrying its derived base", withOrphan[8]?.round_base, 9000);
  check("…and no invented title", "title" in (withOrphan[8] ?? {}), false);
}

console.log("\n── planProgress (must byte-match the rail badge SQL) ─────────");
{
  const p = planProgress(NODES);
  check("done — EXACTLY status === 'done'", p.done, HAND_DONE);
  check("total — every node, no status excluded", p.total, HAND_TOTAL);
  check(
    "done equals a hand filter over the same rule",
    p.done,
    NODES.filter((n) => n.status === "done").length,
  );
  check("a failed task is in total and not in done", planProgress([{ ...NODES[0]!, status: "failed" }]).done, 0);
  check("…and still in total", planProgress([{ ...NODES[0]!, status: "failed" }]).total, 1);
  checkDeep("empty plan → 0/0, not a divide-by-zero anywhere", planProgress([]), { done: 0, total: 0 });
  checkDeep("empty phases[] → 0/0", planProgress(EMPTY_NODES), { done: 0, total: 0 });
}

console.log("\n── planEdges (the whole graph projection) ───────────────────");
{
  const edges = planEdges(NODES);
  check("one edge per dep, no more", edges.length, HAND_EDGES);
  check(
    "…which is exactly the sum of deps.length",
    edges.length,
    NODES.reduce((n, node) => n + node.deps.length, 0),
  );
  check("every edge's source is a dep of its target", edges.every((e) => {
    const target = NODES.find((n) => n.id === e.target);
    return target !== undefined && target.deps.includes(e.source);
  }), true);
  checkDeep("edges point dep → dependent, in node order", edges, [
    { source: "t-0", target: "t-1" },
    { source: "t-0", target: "t-100" },
    { source: "t-1", target: "t-100" },
    { source: "t-700", target: "t-701" },
    { source: "t-700", target: "t-703" },
    { source: "t-701", target: "t-703" },
  ]);
  checkDeep(
    "a node with 3 deps yields 3 edges, one per dep",
    planEdges([{ ...NODES[0]!, id: "x", deps: ["a", "b", "c"] }]),
    [
      { source: "a", target: "x" },
      { source: "b", target: "x" },
      { source: "c", target: "x" },
    ],
  );
  checkDeep("no deps → no edges", planEdges([{ ...NODES[0]!, deps: [] }]), []);
  checkDeep("empty plan → no edges", planEdges([]), []);
  checkDeep("empty phases[] → no edges", planEdges(EMPTY_NODES), []);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — U27 plan store`,
);
process.exit(failures === 0 ? 0 : 1);
