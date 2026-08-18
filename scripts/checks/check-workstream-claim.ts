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
 * (e) A PROMPT THAT DRIFTED AWAY FROM THE PROOF — §6 asserts the four clauses
 *     the sections above demonstrate, and asserts the retired criterion is
 *     ABSENT. A guide carrying both would teach a planner a contradiction.
 * (f) A CAP THIS FILE NAMES BUT NEVER EXECUTES — closed at round 820, and it
 *     was open until then. Rounds 961 and 819 both mutation-proved it: §3's
 *     top row was the hand-typed literal 6, labelled "PROJECT_MAX_WORKSTREAMS=6
 *     — the cap, and the widest lawful fan-out", and §5 asserted GRAPH_GUIDE
 *     mentions "at most PROJECT_MAX_WORKSTREAMS distinct ones" as "the cap §3.6
 *     exercises" — while this file imported neither the constant nor the guard.
 *     `PROJECT_MAX_WORKSTREAMS=2 tsx check-workstream-claim.ts` printed
 *     `ALL PASS — 19 checks`, exit 0, against an engine that would 400 the third
 *     lane; and a SAME-LENGTH edit making the guide advertise "(9 unless the
 *     host overrides it)" passed 19/19 and `pnpm test` 1294/1294, caught by
 *     nothing (6→99 was caught only by NF7's ledger counting one extra
 *     character — an accident of length, not a semantic assertion). Three
 *     things close it, and all three must stay: the constant is IMPORTED and
 *     §3's table is DERIVED from it, so the case list moves when the host moves
 *     the cap; §5 EXECUTES `workstreamCapRefusal()` — R39's actual decision,
 *     the same function the `400` returns — at the cap and one past it; and
 *     §6.6 parses the guide's advertised default and compares it to the code's.
 *     Re-run the two mutations above before trusting any future green here.
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
import {
  PROJECT_MAX_WORKSTREAMS,
  workstreamCapRefusal,
} from "../../forge-control/src/routes/projects.ts";

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

/** R39's cap, IMPORTED — never typed. Round 819's finding 2 / round 961's
 *  finding 2: the row below used to read a literal `6` while calling itself
 *  "the widest LAWFUL fan-out", and lawfulness is a property of this constant.
 *  Deriving the table from it is what makes a host override visibly change this
 *  instrument's output instead of leaving it certifying a cap it never read. */
const CAP = PROJECT_MAX_WORKSTREAMS;

/** The lane counts worth measuring: the degenerate 1, the first two steps of
 *  the linear region, and THE CAP — every one of them lawful by construction,
 *  because a case above the cap is a fan-out the engine refuses (§5) and
 *  asserting a width for it would be asserting a width for a project that
 *  cannot exist. Deduplicated and sorted, so a host cap of 1, 2 or 3 yields a
 *  shorter table rather than a duplicated or unlawful one. */
const LANE_COUNTS: readonly number[] = [...new Set([1, 2, 3, CAP])]
  .filter((n) => n <= CAP)
  .sort((a, b) => a - b);

const WHY_BY_LANES = new Map<number, string>([
  [1, "what round 815 shipped: everything in main, six tasks, width 1"],
  [2, "the first lane a planner opens is the first concurrency it gets"],
  [3, "linear, with no file shared anywhere in the six"],
]);

const LANE_CASES: readonly LaneCase[] = LANE_COUNTS.map((lanes) => ({
  lanes,
  expected: lanes,
  why:
    lanes === CAP
      ? `PROJECT_MAX_WORKSTREAMS=${CAP} — the cap, and the widest fan-out §5 proves LAWFUL`
      : (WHY_BY_LANES.get(lanes) ?? "a lane count below the cap, in the linear region"),
}));

/* THE SWEEP'S OWN CENSUS, derived the OTHER way. `LANE_CASES.length` cannot be
 * compared against itself, so the expected count is recomputed from CAP by an
 * expression that shares no code with the one above: how many of {1,2,3} are at
 * or below the cap, plus one for the cap itself when it is not already among
 * them. At CAP=6 this is 4 — the same four lane rows this file has run since
 * round 960, so deriving the table changed which NUMBERS it reads, not which
 * widths it measures. */
const DECLARED_LANE_CASES =
  [1, 2, 3].filter((n) => n <= CAP).length + (CAP > 3 ? 1 : 0);

/* THE FIXTURE MUST BE AT LEAST AS WIDE AS THE LANE COUNT IT IS ASKED TO FILL —
 * round 962, an unsatisfiable gate amended where it is enforced (standing rule
 * 2), found by running this sweep under a lawful host override.
 *
 * Round 820 derived `lanes` from the imported CAP (correctly — that was its own
 * finding) but left the task count as the literal 6 it had always been. The two
 * then disagree the moment a host raises the cap above 6: at
 * `PROJECT_MAX_WORKSTREAMS=9` the table demands `width 9` while `i % 9` over six
 * rows can only ever produce SIX distinct workstreams, so case 3.9 asserted a
 * width the fixture could not express and this sweep exited 1 on a host that had
 * done nothing wrong. Measured, both at HEAD and here: `PROJECT_MAX_WORKSTREAMS=9
 * tsx check-workstream-claim.ts` -> `FAIL 3.9 ... → width 9`, 1 failure of 27.
 *
 * That is the "gate demanding >=8 rows on a 7-row rail" the standing rules name,
 * and the reason it is fixed rather than disclosed is that a red a host override
 * can produce, on a check nobody runs overridden, is exactly how a sweep teaches
 * its readers that its own reds are normal.
 *
 * `Math.max(6, c.lanes)` keeps the six-task fixture EXACTLY as it was for every
 * cap up to 6 — the default path, and every case this file has run since round
 * 960, is byte-for-byte the same measurement — and widens the rail only where it
 * would otherwise be too short to hold the lanes. One task per lane is the
 * minimum that can express a width of `c.lanes`; the count is printed in the
 * case label so a reader never has to infer which rail was measured. */
for (const c of LANE_CASES) {
  const taskCount = Math.max(6, c.lanes);
  const tasks = Array.from({ length: taskCount }, (_, i) =>
    row(`t${i}`, c.lanes === 1 ? "main" : `ws${i % c.lanes}`, [`src/f${i}.ts`]),
  );
  check(
    `3.${c.lanes} ${c.lanes} workstream(s) over ${taskCount} independent tasks → width ` +
      `${c.expected}  [${c.why}]`,
    spawnedThisTick(tasks).length,
    c.expected,
  );
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

/* ── 5. R39's CAP, EXECUTED — what makes §3's top row "LAWFUL" ─────────────
 *
 * ADDED ROUND 820 (round 819's finding 2, round 961's finding 2). §3 asserts a
 * width AT the cap and calls it lawful. Lawfulness is not a property of the
 * scheduler at all — it is a property of R39's refusal at TASK CREATION, and
 * until this section existed no case here reached that refusal. The label was
 * the whole of the claim.
 *
 * `workstreamCapRefusal()` is R39's DECISION, hoisted out of the handler at
 * round 820 and called by it: `null` is the 201 path, a string is the exact
 * `error` body of the 400. This is therefore the shipped guard and not a model
 * of it — the distinction that matters, because a replayed copy of the
 * predicate would pass against a route that had stopped calling it.
 *
 * IT IS NOT A TAUTOLOGY: every expectation below is a fixed shape (null / not
 * null / a substring), never a value computed from the function under test.
 * BOTH DIRECTIONS ARE ASSERTED — a guard that refused everything would fail
 * 5.1 and 5.4, one that refused nothing would fail 5.2, 5.3 and 5.5. */

console.log("── 5. R39: the cap, executed rather than labelled ────────────");

/** `k` lanes already present on a project, named so no two collide. */
const lanes = (k: number): string[] =>
  k === 0 ? [] : ["main", ...Array.from({ length: k - 1 }, (_unused, i) => `ws${i}`)];

check(
  `5.1 at ${CAP - 1} present lane(s), opening lane #${CAP} is ALLOWED — the positive control, ` +
    "and the half that earns §3's top row the word LAWFUL",
  workstreamCapRefusal(lanes(CAP - 1), "the-cap-th"),
  null,
);
const pastCap = workstreamCapRefusal(lanes(CAP), "one-past-cap");
check(
  `5.2 at ${CAP} present lane(s), opening lane #${CAP + 1} is REFUSED — so ${CAP + 1} is the ` +
    "fan-out §3 must never assert a width for",
  pastCap !== null,
  true,
);
check(
  "5.3 and the refusal names the limit, so an operator reads the number it was refused against",
  pastCap?.includes(`limit PROJECT_MAX_WORKSTREAMS=${CAP}`),
  true,
);
check(
  "5.4 JOINING a lane that already exists is allowed at the cap — it provisions no worktree, " +
    "which is why the cap counts DISTINCT workstreams and not tasks",
  workstreamCapRefusal(lanes(CAP), "main"),
  null,
);
check(
  "5.5 the refusal names the workstream it refused, not just the count",
  pastCap?.includes('new workstream "one-past-cap"'),
  true,
);
/* THE OPENABLE COUNT — round 961's finding 3, CLOSED at round 962, and the
 * label retired in the same commit as the fix (standing rule 4).
 *
 * The arithmetic is unchanged and still measured here: every project is born
 * with its architect row in `main` (`createProject()` inserts no `workstream`
 * column, so the schema default applies), and `workstreamCapRefusal()` counts
 * all distinct workstreams regardless of status — so the NEW lanes a project
 * can open is CAP - 1, not CAP.
 *
 * WHAT CHANGED IS ONLY THE VERDICT ON THE GUIDE. Round 820 wrote this as "the
 * arithmetic the guide gets wrong, so the day the guide is fixed there is a
 * measurement to fix it against". That day is this round: GRAPH_GUIDE now says
 * it, and 6.7 below asserts it says it — so leaving the word OPEN here would be
 * a document mislabelling a closed finding as live, which is the same defect
 * class as round 825's blocker being fixed in this very commit. The measurement
 * stays; only the claim about the guide moves. */
check(
  `5.6 a project born in "main" can open ${CAP - 1} NEW lane(s), not ${CAP} — R39 counts main ` +
    "(round 961 finding 3; CLOSED at round 962, and 6.7 asserts GRAPH_GUIDE now says so)",
  workstreamCapRefusal(lanes(CAP - 1), "the-cap-th") === null &&
    workstreamCapRefusal(lanes(CAP), "one-more") !== null,
  true,
);
console.log();

/* ── 6. THE GUIDE SAYS WHAT THE TABLE PROVED ──────────────────────────────── */

console.log("── 6. GRAPH_GUIDE matches the executed result ────────────────");

for (const [what, needle] of [
  ["§1's fact", "one git worktree whose tasks run one at a time"],
  ["§2's property", "isolated directories that may write the SAME file"],
  [
    "§3's criterion",
    "so open ONE PER LANE you want running at once, up to that cap, not one per file conflict.",
  ],
  ["the cap §5 exercises", "at most PROJECT_MAX_WORKSTREAMS distinct ones"],
] as const) {
  check(`6.x GRAPH_GUIDE states ${what}`, GRAPH_GUIDE.includes(needle), true);
}
check(
  "6.5 the retired same-file criterion is GONE — a guide carrying both teaches a " +
    "contradiction, and §3.1 shows which half the engine obeys",
  GRAPH_GUIDE.includes("truly need one file concurrently"),
  false,
);

/* 6.6 — THE NUMBER THE GUIDE ADVERTISES, against the number the code uses.
 *
 * This is the assertion that kills round 961's second mutation: a SAME-LENGTH
 * edit making the guide read "(9 unless the host overrides it)" passed the old
 * §5 19/19 and `pnpm test` 1294/1294, because every gate on this clause was a
 * substring test and no substring test can tell 6 from 9. The number is parsed
 * out of the prompt and compared to the constant — not read, not assumed.
 *
 * The guide advertises the DEFAULT ("N unless the host overrides it"), and
 * `PROJECT_MAX_WORKSTREAMS` is the EFFECTIVE cap, so the two are equal exactly
 * when the host has not overridden it. Both branches assert something real:
 * unset, the advertised number must BE the effective cap; overridden, the
 * clause that tells a planner the number is overridable at all must still be
 * there — otherwise the guide would be stating a flat falsehood to every
 * planner on this host. The override branch is not a skip. */
const advertised = /\((\d+) unless the host overrides it\)/.exec(GRAPH_GUIDE);
check(
  "6.6a GRAPH_GUIDE advertises a parseable default cap — a clause no substring gate can read",
  advertised !== null,
  true,
);
const HOST_OVERRIDE = process.env.PROJECT_MAX_WORKSTREAMS;
if (HOST_OVERRIDE === undefined) {
  check(
    `6.6b the default GRAPH_GUIDE advertises (${advertised?.[1] ?? "<unparsed>"}) IS the cap the ` +
      `engine enforces (${CAP}) — host override unset, so the two must be equal`,
    Number(advertised?.[1]),
    CAP,
  );
} else {
  console.log(
    `        [host override PROJECT_MAX_WORKSTREAMS=${HOST_OVERRIDE} is set — the advertised ` +
      `default ${advertised?.[1] ?? "<unparsed>"} is not expected to equal the effective cap ${CAP}]`,
  );
  check(
    `6.6b the host overrode the cap to ${CAP}, so the guide must still tell a planner the number ` +
      "is overridable — a flat, unqualified number would be false on this host",
    GRAPH_GUIDE.includes("unless the host overrides it"),
    true,
  );
}
console.log();

/* ── 6B. ROUND 962's THREE RULES, EXECUTED WHERE THEY CAN BE ──────────────── */

console.log("── 6B. round 962's rules (961 findings 3, 4, 5) ──────────────");

/* 6.7 — FINDING 3, the openable count, DERIVED rather than asserted.
 *
 * §5.6 proves CAP - 1 against `workstreamCapRefusal`. This proves the GUIDE now
 * says it, and — the part that matters — it does not look for a hard-coded "5".
 * It walks the refusal from the state every project is BORN in (one row, in
 * `main`) and counts how many NEW lanes actually open before the 400. So the
 * expected value is computed from the engine on both sides; a host that
 * overrides the cap moves the count and this check follows it. A literal here
 * would be the inert-constant failure round 961 found in §3's top row. */
function openableFromBirth(): number {
  const present = ["main"];
  let opened = 0;
  for (let i = 0; i < CAP + 2; i++) {
    const lane = `lane-${i}`;
    if (workstreamCapRefusal(present, lane) !== null) break;
    present.push(lane);
    opened++;
  }
  return opened;
}
check(
  `6.7a from the state a project is BORN in (one row, "main"), ${CAP - 1} NEW lane(s) open before ` +
    "the 400 — walked against the guard, not read off a literal",
  openableFromBirth(),
  CAP - 1,
);
check(
  '6.7b GRAPH_GUIDE states that the cap COUNTS the "main" a project is born in — round 961 ' +
    "finding 3, the clause whose absence taught the 400 §5.6 measures",
  GRAPH_GUIDE.includes('COUNTING the "main" every project is born in, so cap-1 remain'),
  true,
);
check(
  "6.7c GRAPH_GUIDE gives the project-wide budget an ALLOCATION RULE — this constant reaches the " +
    "architect AND every planner it seeds, and an unqualified ceiling is read from both seats " +
    "as a whole budget",
  GRAPH_GUIDE.includes("That budget is the PROJECT's, not yours"),
  true,
);

/* 6.8 — FINDING 4, EXECUTED: what "no workstream" actually costs.
 *
 * The guide calls research fan-out "the cheapest parallelism there is". Round
 * 961's finding 4 is that N researchers with `depends_on []` and NO workstream
 * all land in `main` (`createTask()` writes `input.workstream ?? "main"`) and
 * then run ONE AT A TIME behind the round-222 belt — so the sentence promised a
 * width the engine does not deliver, which is round 815's project exactly.
 *
 * This drives the SAME `spawnedThisTick()` the rest of the sweep uses, over the
 * two shapes side by side: the omitted field, and a lane each. It is a
 * controlled pair — same count, same empty write-sets, same tick — so the only
 * variable is the field the guide now tells a planner not to omit. Both halves
 * are asserted: without the clause a planner writes the left-hand shape and
 * believes it bought the right-hand one. */
const RESEARCHERS = 4;
const omittedField = Array.from({ length: RESEARCHERS }, (_, i) =>
  row(`res-main-${i}`, "main", []),
);
const laneEach = Array.from({ length: RESEARCHERS }, (_, i) =>
  row(`res-lane-${i}`, `research-${i}`, []),
);
check(
  `6.8a ${RESEARCHERS} researchers with depends_on [] and the workstream field OMITTED (so "main") ` +
    "spawn 1 this tick — the fan-out the guide calls cheapest, costing its full width in wall clock",
  spawnedThisTick(omittedField).length,
  1,
);
check(
  `6.8b the same ${RESEARCHERS} with a lane each spawn all ${RESEARCHERS} — the difference between ` +
    "the two rows is the field, and nothing else",
  spawnedThisTick(laneEach).length,
  RESEARCHERS,
);
check(
  "6.8c GRAPH_GUIDE states the non-inheritance in FAN-OUT, where the fan-out decision is made — " +
    "defining the field three paragraphs earlier is what round 961 finding 4 measured as not enough",
  GRAPH_GUIDE.includes("a task does NOT inherit your workstream"),
  true,
);

/* 6.9 — FINDING 5, stated; and SAID PLAINLY, it is the one rule of the three
 * this script cannot execute.
 *
 * The rule is that a lane opened FOR a task that creates tasks belongs to that
 * task. Its two premises live where this script cannot reach them without a
 * database and a server: R29's immutability of `depends_on` after insert, and
 * the route's refusal of dependency ids that do not exist (`depends_on names N
 * dependency id(s) that do not exist` -> 400). `check-task-api.ts` reaches both
 * over HTTP and needs `$SCRATCH_DATABASE_URL`.
 *
 * So this is a CLAUSE check and is labelled one. Recording that honestly is the
 * point: round 961's finding 2 was exactly an instrument asserting a claim it
 * never executed while reading as though it had. */
check(
  "6.9 GRAPH_GUIDE states that a lane opened for a task-creating task belongs to that task " +
    "(clause only — R29 immutability and the unknown-id 400 need check-task-api.ts and a database)",
  GRAPH_GUIDE.includes("A lane you open for a task that itself creates tasks belongs to THAT task"),
  true,
);

/* 6.10 — ROUND 963's FINDING 4: FAN-OUT's two lane instructions carry the
 * bound, not just the bullet three paragraphs above them.
 *
 * §5.6 and 6.7a measure that only CAP - 1 lanes open. 6.8 measures what the
 * lane field buys. Neither says anything about FAN-OUT's own arithmetic, and
 * FAN-OUT is where a planner decides HOW MANY researchers to fan out to: it
 * said "a lane each" and "as many lanes as you want building at once", both
 * unbounded, so six independent research questions met the 400 at the one
 * moment the planner was not reading the workstream bullet. That is the same
 * shape as 6.8c's own argument, which is why round 963 raised it.
 *
 * A CLAUSE CHECK, AND THE REASON IT IS ENOUGH HERE. The engine behaviour these
 * clauses describe is already executed twice over — the refusal by §5, the
 * openable count by 6.7a. What was missing was only the sentence, so a needle
 * is the whole of the fix; there is no second thing to drive. It is asserted
 * rather than left to the ledger because the edit is NET ZERO (round 964's
 * LEDGER row) and a zero-delta reflow is invisible to every arithmetic gate in
 * this project — this needle is the only thing that would notice it going. */
for (const [what, needle] of [
  ["researchers", "a lane each while lanes remain"],
  ["builders", "in as many lanes as remain"],
] as const) {
  check(
    `6.10 FAN-OUT bounds its ${what} instruction by the lanes that REMAIN, in the vocabulary the ` +
      'workstream bullet uses ("so cap-1 remain") and never "up to the cap", which is the ' +
      "phrasing round 961 finding 3 condemned for over-promising by one",
    GRAPH_GUIDE.includes(needle),
    true,
  );
}
console.log();

/* ── 7. VERDICT, with the sweep's own census first ────────────────────────── */

if (LANE_CASES.length !== DECLARED_LANE_CASES) {
  console.log(
    `FAIL  the lane table declares ${DECLARED_LANE_CASES} cases and holds ${LANE_CASES.length} — ` +
      "a sweep whose probes went missing must not certify itself",
  );
  failures++;
}
/* §1 four, §2 three, §3 one per lane case, §4 three, §5 six, §6 seven (four
 * clause needles + the retired-criterion absence + 6.6a + whichever branch of
 * 6.6b the host selects — exactly one of the two runs, never both, never
 * neither), §6B nine (6.7a/b/c, 6.8a/b/c, 6.9, and 6.10's two needles — one per
 * FAN-OUT instruction, because a bound stated for researchers and dropped for
 * builders is exactly the half-fix round 963's finding 4 describes). At the
 * default cap of 6 that is 4+3+4+3+6+7+9 = 36; the pre-820 baseline was 19, +8
 * was §5's six and §6.6's two at round 820, +7 is round 962's §6B, and +2 is
 * round 964's 6.10. */
const EXPECTED_CHECKS = 4 + 3 + DECLARED_LANE_CASES + 3 + 6 + 7 + 9;
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
