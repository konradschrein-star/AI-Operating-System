/**
 * check-workstream-claim.ts — round 960. GRAPH_GUIDE's workstream bullet,
 * EXECUTED against the engine it describes.
 *
 * THE QUESTION THIS ANSWERS. `GRAPH_GUIDE` (project-tick.ts) is interpolated
 * into every prompt that can create tasks — the goal-mode architect, the
 * non-goal architect and the planner — and its workstream bullet makes four
 * claims about the SCHEDULER, not about itself:
 *
 *   1. "One workstream is one git worktree whose tasks run one at a time"
 *   2. "two are isolated directories that may write the SAME file at once"
 *   3. "open ONE PER LANE you want running at once, up to that cap"
 *   4. (R33, the shape the guide's worktrees actually land on disk with)
 *      the branch is `project/<id8>-<ws>` — a hyphen, never a slash
 *
 * Nothing checked claims 1–3 against the code until this file. Between them
 * they cost the project its fan-out: the bullet's RETIRED closing criterion
 * ("open a second only when two teams truly need one file concurrently") asked
 * a same-file question, `spawnTaskRuns()`'s deferred branch never asks one, and
 * round 815's project came out one task wide with a correct DAG
 * (`evidence/phase8-verify.md` §7c: max concurrency 1, distinct workstreams 1,
 * two ready planners with disjoint write-sets, the second waiting 32 minutes).
 *
 * A prompt is a claim about the system. This is the claim executed — the same
 * shape as `check-screenshot-render-shapes.ts` (round 902), which is the
 * precedent for the class: a check that runs a prompt's promise against the
 * code that must keep it.
 *
 * WHY A SCRIPT AND NOT A UNIT TEST. `project-tick.test.ts` asserts the STRING
 * (R48's clause gate, round 960's case) and it should — a clause that vanishes
 * must fail loudly. But a substring gate cannot tell a true clause from a false
 * one, and the retired criterion passed every substring gate this repo has for
 * eight rounds. The truth of the clause is a property of three exported
 * functions in two modules, so it gets a table-driven tsx script: zero
 * dependencies, one PASS/FAIL line per case, `process.exit(1)` on anything.
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ──────────────────
 * (a) A SHADOW TREE — measuring some other checkout's scheduler. §0 prints the
 *     RESOLVED absolute path and sha256 of every module imported, next to this
 *     script's own sha256. A reader can `sha256sum` the named path.
 * (b) A VACUOUS SWEEP — a table that ran zero cases, or one whose every
 *     expectation is "nothing happened" and would pass against deleted code.
 *     Closed twice: the case counts are asserted against declared constants
 *     before the verdict, and every section carries a POSITIVE expectation (2
 *     spawned, 6 spawned, a branch name) that a no-op implementation fails.
 * (c) A TAUTOLOGY — deriving the expectation from the function under test. No
 *     expectation here is computed; each is a number or a string typed by hand
 *     from what round 815 measured and what R33 verified against git.
 * (d) THE ONE-SIDED BELT — a `partitionByWorkstream()` that deferred NOTHING
 *     would pass every isolation case, and a `selectClaimable()` that claimed
 *     nothing would pass every serialisation case. Each section therefore
 *     carries its own opposite: §1 asserts both that the belt defers the second
 *     task AND that the contention gate would have claimed it, §2 asserts both
 *     that two workstreams spawn together AND that one workstream sharing a
 *     file does not.
 * (e) A PROMPT THAT DRIFTED AWAY FROM THE PROOF — §5 asserts the four clauses
 *     the sections above demonstrate, and asserts the retired criterion is
 *     ABSENT. A guide carrying both would teach a planner a contradiction.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-workstream-claim.ts
 * Exit: 0 = every case matched; 1 = anything failed, or the sweep was empty.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  busyWorkstreams,
  partitionByWorkstream,
  GRAPH_GUIDE,
} from "../../forge-control/src/lib/project-tick.ts";
import { selectClaimable, type GraphTask } from "../../forge-control/src/lib/task-graph.ts";
import { workstreamBranch } from "../../forge-control/src/lib/workspace.ts";

let failures = 0;
let ran = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  ran++;
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

function digest(specifier: string): { path: string; sha256: string } {
  const path = fileURLToPath(new URL(specifier, import.meta.url));
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

/* ── 0. PROVENANCE, before any verdict (00-vision.md §7 rule 3) ───────────── */

const IMPORTED = [
  "../../forge-control/src/lib/project-tick.ts",
  "../../forge-control/src/lib/task-graph.ts",
  "../../forge-control/src/lib/workspace.ts",
].map(digest);

const SELF = digest("./check-workstream-claim.ts");

console.log("check-workstream-claim.ts — round 960, GRAPH_GUIDE's workstream bullet, executed");
console.log();
console.log("PROVENANCE");
console.log(`  this check      : ${SELF.path}`);
console.log(`  this check sha  : ${SELF.sha256}`);
for (const m of IMPORTED) {
  console.log(`  imported        : ${m.path}`);
  console.log(`     sha256       : ${m.sha256}`);
}
console.log(`  node            : ${process.version}`);
console.log();

/* ── THE FIXTURE ──────────────────────────────────────────────────────────
 *
 * One project id, because the belt keys on (project, workstream) and a second
 * project would answer every question with "different key" rather than with the
 * property under test. The id is round 815's real DoD-6 measurement project, so
 * a reader can put these rows next to the transcript in
 * `evidence/phase8-verify.md` §7c and see the same shape.
 */

const PROJECT = "b7ab4c57-7ebd-4ef5-a7e3-9345941467c5";

interface Row {
  id: string;
  project_id: string;
  workstream: string;
  status: GraphTask["status"];
  write_set: string[];
}

const row = (
  id: string,
  workstream: string,
  write_set: string[],
  status: GraphTask["status"] = "ready",
): Row => ({ id, project_id: PROJECT, workstream, status, write_set });

/** The `GraphTask` view of a row — `selectClaimable()`'s input. `round` and the
 *  two graph fields are irrelevant to contention and are filled with the values
 *  a graph-written root actually carries, never with a sentinel that would make
 *  a reader wonder whether they matter. */
const graph = (r: Row): GraphTask => ({
  id: r.id,
  round: 0,
  workstream: r.workstream,
  status: r.status,
  depends_on: [],
  write_set: r.write_set,
  graph_frozen: false,
});

/** How many of `ready` actually get a run this tick: the contention gate first
 *  (`selectClaimable`), then the round-222 spawn belt (`busyWorkstreams` +
 *  `partitionByWorkstream`) — the two stages `spawnTaskRuns()` applies, in its
 *  order. Written once so no case can quietly test only the half that suits it. */
function spawnedThisTick(ready: readonly Row[], running: readonly Row[] = []): Row[] {
  const claimable = selectClaimable(ready.map(graph), running.map(graph));
  const claimedIds = new Set(claimable.map((t) => t.id));
  const claimed = ready.filter((r) => claimedIds.has(r.id));
  const busy = busyWorkstreams([...ready, ...running], claimedIds);
  return partitionByWorkstream(claimed, busy).spawn;
}

/* ── 1. "one git worktree whose tasks run one at a time" ──────────────────
 *
 * THE ROUND-815 SHAPE, EXACTLY: two `ready` tasks, one workstream, DISJOINT
 * write-sets. The measured outcome was one running task and a 32-minute wait.
 */

console.log('── 1. one workstream: "tasks run one at a time" ──────────────');

const STALL = [
  row("phase2", "main", ["scripts/checks/check-instrument-typecheck.sh"]),
  row("phase3", "main", ["scripts/checks/check-orientation.ts"]),
];

check(
  "1.1 two disjoint tasks in ONE workstream spawn ONE — the round-815 stall, reproduced",
  spawnedThisTick(STALL).length,
  1,
);
check(
  "1.2 and it is the first-ordered one that goes, not an arbitrary one",
  spawnedThisTick(STALL)[0]?.id,
  "phase2",
);
check(
  "1.3 the CONTENTION GATE would have run both — so the belt is what serialises, " +
    "which is why a disjoint write_set buys a planner nothing inside one workstream",
  selectClaimable(STALL.map(graph), []).length,
  2,
);
check(
  "1.4 a workstream with a task already RUNNING is busy, so its ready sibling defers",
  spawnedThisTick([row("later", "main", ["docs/plan/a.md"])], [
    row("live", "main", ["docs/plan/b.md"], "running"),
  ]).length,
  0,
);
console.log();

/* ── 2. "two are isolated directories that may write the SAME file at once" ─ */

console.log("── 2. two workstreams: the same file, at the same time ───────");

const SAME_FILE_TWO_WS = [
  row("ui-side", "ui", ["forge-control-web/app/desktop/DesktopApp.tsx"]),
  row("quota-side", "quota", ["forge-control-web/app/desktop/DesktopApp.tsx"]),
];

check(
  "2.1 the SAME file in two workstreams spawns BOTH — the property one worktree per " +
    "workstream buys, and the reason DesktopApp.tsx no longer forces two rounds",
  spawnedThisTick(SAME_FILE_TWO_WS).length,
  2,
);
check(
  "2.2 NEGATIVE CONTROL — the same two tasks in ONE workstream spawn one, so 2.1 is a " +
    "property of the workstreams and not of a belt that never defers anything",
  spawnedThisTick([
    row("ui-side", "main", ["forge-control-web/app/desktop/DesktopApp.tsx"]),
    row("quota-side", "main", ["forge-control-web/app/desktop/DesktopApp.tsx"]),
  ]).length,
  1,
);
check(
  "2.3 a workstream is NOT held busy by another workstream's running task",
  spawnedThisTick([row("api-work", "api", ["forge-control/src/routes/projects.ts"])], [
    row("ui-live", "ui", ["forge-control-web/app/desktop/DesktopApp.tsx"], "running"),
  ]).length,
  1,
);
console.log();

/* ── 3. THE CRITERION ITSELF: "open ONE PER LANE you want running at once" ──
 *
 * The bullet's advice, executed as arithmetic. Six independent tasks — no
 * dependencies, no shared files, the cheapest parallelism there is — split
 * across k workstreams. Achieved width is k, for every k up to the cap. The
 * retired criterion asked about files; none of these six shares one, so it
 * answered "one workstream" and the fleet ran 1-wide. The expectations below
 * are typed by hand from that reading, not computed from anything.
 */

console.log("── 3. width is the number of workstreams, not of files ───────");

interface LaneCase {
  lanes: number;
  expected: number;
  why: string;
}

const LANE_CASES: readonly LaneCase[] = [
  { lanes: 1, expected: 1, why: "what round 815 shipped: everything in main, six tasks, width 1" },
  { lanes: 2, expected: 2, why: "the first lane a planner opens is the first concurrency it gets" },
  { lanes: 3, expected: 3, why: "linear, with no file shared anywhere in the six" },
  { lanes: 6, expected: 6, why: "PROJECT_MAX_WORKSTREAMS=6 — the cap, and the widest lawful fan-out" },
];

const DECLARED_LANE_CASES = 4;

for (const c of LANE_CASES) {
  const six = Array.from({ length: 6 }, (_, i) =>
    row(`t${i}`, c.lanes === 1 ? "main" : `ws${i % c.lanes}`, [`src/f${i}.ts`]),
  );
  check(`3.${c.lanes} ${c.lanes} workstream(s) over 6 independent tasks → width ${c.expected}  [${c.why}]`,
    spawnedThisTick(six).length, c.expected);
}
console.log();

/* ── 4. R33 — THE BRANCH FORM, hyphen and never slash ──────────────────────
 *
 * Round 815 found three documents predicting `project/<id>/<workstream>`,
 * including a live deploy payload's expected-observation item. Git refuses that
 * ref while `project/<id8>` exists — a file and a directory at one path in the
 * ref store — so the prediction could never have been observed. The e2e check
 * proves this against real git; this is the same fact, asserted where every
 * round can afford to run it.
 */

console.log("── 4. R33 the workstream branch is the hyphen form ───────────");

const PROJECT_BRANCH = "project/b7ab4c57";
check("4.1 a workstream branch is project/<id8>-<ws>", workstreamBranch(PROJECT_BRANCH, "ui"),
  "project/b7ab4c57-ui");
check("4.2 and never the slash form git refuses",
  workstreamBranch(PROJECT_BRANCH, "ui").includes("b7ab4c57/ui"), false);
check("4.3 main is a PASSTHROUGH — no live project changes branch",
  workstreamBranch(PROJECT_BRANCH, "main"), PROJECT_BRANCH);
console.log();

/* ── 5. THE GUIDE SAYS WHAT THE TABLE PROVED ──────────────────────────────── */

console.log("── 5. GRAPH_GUIDE matches the executed result ────────────────");

for (const [what, needle] of [
  ["§1's fact", "one git worktree whose tasks run one at a time"],
  ["§2's property", "isolated directories that may write the SAME file"],
  [
    "§3's criterion",
    "so open ONE PER LANE you want running at once, up to that cap, not one per file conflict.",
  ],
  ["the cap §3.6 exercises", "at most PROJECT_MAX_WORKSTREAMS distinct ones"],
] as const) {
  check(`5.x GRAPH_GUIDE states ${what}`, GRAPH_GUIDE.includes(needle), true);
}
check(
  "5.5 the retired same-file criterion is GONE — a guide carrying both teaches a " +
    "contradiction, and §3.1 shows which half the engine obeys",
  GRAPH_GUIDE.includes("truly need one file concurrently"),
  false,
);
console.log();

/* ── 6. VERDICT, with the sweep's own census first ────────────────────────── */

if (LANE_CASES.length !== DECLARED_LANE_CASES) {
  console.log(
    `FAIL  the lane table declares ${DECLARED_LANE_CASES} cases and holds ${LANE_CASES.length} — ` +
      "a sweep whose probes went missing must not certify itself",
  );
  failures++;
}
const EXPECTED_CHECKS = 4 + 3 + DECLARED_LANE_CASES + 3 + 5;
if (ran !== EXPECTED_CHECKS) {
  console.log(
    `FAIL  ${ran} checks ran, ${EXPECTED_CHECKS} expected — a section stopped executing and the ` +
      "remaining PASS lines would have read as full coverage",
  );
  failures++;
}

console.log(
  failures === 0 ? `ALL PASS — ${ran} checks` : `${failures} FAILURE(S) out of ${ran} checks`,
);
process.exit(failures === 0 ? 0 : 1);
