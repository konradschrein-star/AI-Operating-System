/**
 * check-plan-store.ts — executable unit check for the U27 plan store:
 * `toPlanNodes`, `groupPlanPhases`, `planProgress`, `planEdges`,
 * `workstreamLabel`, `statusTokenName` and `phaseBase` in
 * forge-control-web/app/desktop/team/planStore.ts.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-team-rows.ts and check-nav-stack.ts, deliberately.
 *
 * It imports `planStore.ts` / `planApi.ts` directly — neither has React or
 * JSX, which is exactly why the flattening, the grouping, the counting rule
 * and the workstream label live there and not inside the Kanban component.
 *
 * The claims this file exists to hold down:
 *   1. an UNKNOWN status survives verbatim into the node and counts as
 *      not-done (never coerced into a neighbouring bucket — NFU6);
 *   2. `planProgress` is EXACTLY the rail badge's SQL, so the two numbers
 *      cannot drift (round 704's three-way agreement);
 *   3. `planEdges` is the whole graph projection and already works;
 *   4. `tier: null` produces `meta` with no `tier` key, not `tier: undefined`;
 *   5. **R55, round 223** — `workstream` and `depth` pass through untouched,
 *      `workstreamLabel` hides exactly `main` and folds nothing, and the
 *      Kanban still groups by `round` and never by `depth`;
 *   6. **R54, round 223** — the fixture carries edges the coarse
 *      strictly-lower-round synthesis could NEVER have produced (a dep that
 *      skips five phase blocks; two same-round siblings with different dep
 *      sets), and asserts that the synthesised set would have differed. A
 *      fixture whose real deps happen to equal the synthesised ones proves
 *      nothing about which branch produced them, so that coincidence is
 *      itself asserted against.
 *
 * ── BUILD IDENTITY (00-vision.md §7 rule 3), added round 223 ───────────────
 * This script used to print PASS/FAIL lines and nothing else. Two ways it
 * could then have reported a pass wrongly, both closed here:
 *
 *  (a) NOT SAYING WHICH BYTES IT CHECKED. A green transcript pasted into an
 *      evidence file named a worktree, not a build. The first output line is
 *      now provenance: git HEAD, the branch, whether either subject file is
 *      uncommitted, the sha256 of each subject file, the fixture's node count
 *      and the number of assertions about to run.
 *  (b) A CASE DECLARED BUT NEVER REACHED. Every assertion increments a
 *      counter; the run exits NON-ZERO when the number executed differs from
 *      `DECLARED_ASSERTIONS` in EITHER direction. A block that threw before
 *      asserting, or a new section someone commented out, used to print
 *      "ALL PASS" — the same species of failure as a sweep whose probes miss
 *      the target and certify themselves.
 *
 * `DECLARED_ASSERTIONS` is HAND-DERIVED, section by section, in the comment
 * beside it. That is the point: a declared count computed from the code would
 * be the code marking its own work.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlanPhase, PlanResponse, PlanTask } from "../../forge-control-web/app/desktop/team/planApi.ts";
import {
  KNOWN_STATUSES,
  groupPlanPhases,
  phaseBase,
  planEdges,
  planProgress,
  statusTokenName,
  toPlanNodes,
  workstreamLabel,
  type PlanNode,
} from "../../forge-control-web/app/desktop/team/planStore.ts";

/* ── Provenance ────────────────────────────────────────────────────────────
 *
 * Resolved from THIS FILE's own location, never from `process.cwd()`: the run
 * command puts the cwd in forge-control-web/, and a header that described a
 * directory rather than the checked bytes is exactly failure mode (a).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The bytes whose behaviour is being asserted — AND this script's own, because
 *  a harness that names only its subject can still be the thing that changed.
 *  A mutation run pasted into evidence must be distinguishable from a green one
 *  by its header alone. */
const SUBJECT_FILES = [
  "forge-control-web/app/desktop/team/planStore.ts",
  "forge-control-web/app/desktop/team/planApi.ts",
  "scripts/checks/check-plan-store.ts",
];

function git(args: string[]): string {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  } catch (e) {
    // NOT swallowed into "unknown": a header that cannot name its build must
    // say so loudly, because the whole point of the header is to be trusted.
    return `UNAVAILABLE (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
  }
}

function sha256(relPath: string): string {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, relPath))).digest("hex");
}

/* ── Assertions, and the accounting that makes a missed case a failure ───── */

let failures = 0;
let executed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  executed++;
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

function checkDeep(name: string, actual: unknown, expected: unknown): void {
  executed++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        expected ${b}\n        got      ${a}`));
}

/** Two values that must NOT be equal — the self-defeat guard for R54. A
 *  fixture edited (or a rule refactored) into the coincidence "real deps
 *  happen to equal the synthesised deps" fails here instead of certifying a
 *  branch it never exercised. Same idiom as `assertDiffers` in
 *  check-plan-api.ts. */
function checkDiffers(name: string, a: unknown, b: unknown): void {
  executed++;
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  const ok = x !== y;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? ` — ${x} !== ${y}` : `\n        both sides are ${x} — this case proves nothing`),
  );
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
 *
 * ── ROUND 223: FOUR ROWS THE COARSE RULE COULD NEVER HAVE PRODUCED ────────
 * Until R54 the server synthesised `deps` as "every task in a strictly lower
 * round", so two shapes were IMPOSSIBLE on the wire and are therefore the two
 * that prove the edges are now real:
 *
 *   t-704   round 704, deps [t-101] — a dep that SKIPS five phase blocks.
 *           The synthesised set for round 704 is all 20 rows below it; the
 *           real one is a single id from block 100.
 *   t-705a  round 705, deps [t-700]           two SAME-ROUND siblings with
 *   t-705b  round 705, deps [t-701, t-702]    DIFFERENT dep sets. The coarse
 *           rule gave same-round siblings identical sets by construction, and
 *           the check asserts that identity still holds for the synthesised
 *           sets while the real ones differ.
 *   t-706   round 706, deps [t-missing] — a dep naming NO row in the set. The
 *           server emits a dangling id verbatim on purpose (R27 makes one
 *           unreachable through the API, so one arriving means a corrupt row
 *           and the panel is the surface that must show it).
 *
 * ── `depth` IS NOT `round` IN THIS FIXTURE, DELIBERATELY ──────────────────
 * Every `depth` below is the true longest path over the fixture's own `deps`
 * (a row with no deps is a root at 0), which is what the server's `taskDepth()`
 * computes. Exactly ONE row — t-0, a root at round 0 — has `depth === round`.
 * That matters: if `toPlanNodes` were written `depth: t.round` by mistake, a
 * fixture whose depths mirrored its rounds would pass anyway. Here 23 of 24
 * rows would go red.
 */

function task(
  over: Partial<PlanTask> & { id: string; round: number; depth: number },
): PlanTask {
  return {
    role: "builder",
    title: `task ${over.round}`,
    status: "done",
    tier: null,
    deps: [],
    /* The column default (migration 0040): every row that does not ask for
     * another runs in `main`, which is every row on this engine today. */
    workstream: "main",
    ...over,
  };
}

const PHASES: PlanPhase[] = [
  {
    round_base: 0,
    tasks: [
      task({ id: "t-0", round: 0, depth: 0, role: "architect", tier: "flagship" }),
      task({ id: "t-1", round: 1, depth: 1, role: "planner", deps: ["t-0"] }),
    ],
  },
  {
    round_base: 100,
    title: "phase 100 — read-side API",
    tasks: [
      task({
        id: "t-100",
        round: 100,
        depth: 2,
        role: "planner",
        tier: "standard",
        deps: ["t-0", "t-1"],
      }),
      task({ id: "t-101", round: 101, depth: 0 }),
    ],
  },
  {
    round_base: 200,
    title: "phase 200 — live panel",
    tasks: [
      task({ id: "t-200", round: 200, depth: 0, role: "planner" }),
      task({ id: "t-201", round: 201, depth: 0 }),
    ],
  },
  {
    round_base: 300,
    title: "phase 300 — chat surface",
    doc_path: "300-read-side-api.md",
    tasks: [
      task({ id: "t-300", round: 300, depth: 0, role: "planner" }),
      task({ id: "t-301", round: 301, depth: 0 }),
      task({ id: "t-302", round: 302, depth: 0, role: "reviewer" }),
    ],
  },
  {
    round_base: 400,
    title: "phase 400 — right panel",
    tasks: [
      task({ id: "t-400", round: 400, depth: 0, role: "planner" }),
      task({ id: "t-401", round: 401, depth: 0 }),
    ],
  },
  {
    round_base: 500,
    title: "phase 500 — control plane",
    tasks: [
      task({ id: "t-500", round: 500, depth: 0, role: "planner" }),
      task({ id: "t-501", round: 501, depth: 0 }),
    ],
  },
  {
    round_base: 600,
    title: "phase 600 — worker legibility",
    tasks: [
      task({ id: "t-600", round: 600, depth: 0, role: "planner" }),
      task({ id: "t-601", round: 601, depth: 0 }),
      task({ id: "t-606", round: 606, depth: 0, status: "running" }),
    ],
  },
  {
    round_base: 700,
    title: "phase 700 — kanban",
    doc_path: "700-kanban.md",
    tasks: [
      task({ id: "t-700", round: 700, depth: 0, role: "planner" }),
      task({ id: "t-701", round: 701, depth: 1, status: "pending", deps: ["t-700"] }),
      task({ id: "t-702", round: 702, depth: 0, status: "pending" }),
      // The stranger. No CHECK constraint admits it; it must still arrive.
      task({ id: "t-703", round: 703, depth: 2, status: "harvesting", deps: ["t-700", "t-701"] }),
      /* THE PHASE-SKIPPING DEP. Round 704 waits on ONE task in block 100 and
       * on nothing in between — impossible under the strictly-lower-round
       * synthesis, which owed it all 20 rows below it. Its workstream is the
       * one interesting row the chip exists for, and its depth (1) disagrees
       * with its round (704) by three orders of magnitude. */
      task({
        id: "t-704",
        round: 704,
        depth: 1,
        status: "pending",
        workstream: "ui",
        deps: ["t-101"],
      }),
      /* THE TWO SIBLINGS. Same round, different dep sets — the coarse rule
       * gave same-round siblings identical sets by construction. */
      task({ id: "t-705a", round: 705, depth: 1, status: "running", workstream: "api-v2", deps: ["t-700"] }),
      task({ id: "t-705b", round: 705, depth: 2, deps: ["t-701", "t-702"] }),
      /* THE DANGLING DEP. `t-missing` names no row in this set; `planEdges`
       * must still emit the edge (see the planEdges section for why that is
       * the honest behaviour). Depth 0: an absent dep contributes no edge to
       * the longest path, which is the server's own opposite-but-deliberate
       * decision on the same id. */
      task({ id: "t-706", round: 706, depth: 0, status: "blocked", deps: ["t-missing"] }),
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

/* HAND COUNT, so the assertions below are not the code marking its own work.
 * Re-derived at round 223 when the fixture gained four rows:
 *   0:2  100:2  200:2  300:3  400:2  500:2  600:3  700:8   → 24 tasks
 *   not done: t-606 running, t-701 pending, t-702 pending, t-703 harvesting,
 *             t-704 pending, t-705a running, t-706 blocked   → 7
 *   → done 17, total 24
 *   deps: t-1(1) + t-100(2) + t-701(1) + t-703(2) + t-704(1) + t-705a(1)
 *         + t-705b(2) + t-706(1) → 11 edges
 *   non-`main` workstreams: t-704 (ui), t-705a (api-v2) → 2
 *   depth === round: t-0 (0 === 0) and t-1 (1 === 1) — the only two, because
 *     a chain's first two links happen to be numbered like their depth. 2 of
 *     24, so 22 rows would go red if `toPlanNodes` copied `round` into
 *     `depth`. (Hand-counted as 1 on the first pass and caught by the check
 *     itself: t-1 was missed. The count is corrected here rather than the
 *     assertion loosened — the hand derivation was wrong, the code was not.) */
const HAND_TOTAL = 24;
const HAND_DONE = 17;
const HAND_EDGES = 11;
const HAND_LABELLED_WORKSTREAMS = 2;
const HAND_DEPTH_EQUALS_ROUND = 2;

/**
 * HAND-DERIVED, section by section, and the run exits non-zero if the number
 * of assertions actually executed differs from it — in either direction.
 *
 *   toPlanNodes                                   8
 *   meta.tier / meta.run_id                       5
 *   unknown status survives                       7
 *   statusTokenName                              12 + 6 (loop over
 *                                                     KNOWN_STATUSES) = 18
 *   phaseBase                                     6
 *   groupPlanPhases                              17
 *   planProgress                                  7
 *   planEdges                                     8
 *   ── round 223 ───────────────────────────────────
 *   workstream / depth pass-through               8
 *   workstreamLabel                               8
 *   edges the coarse rule could not produce       9
 *   the dangling edge                             3
 *   depth disagrees with round                    3
 *                                              ────
 *                                                107
 *
 * A count computed from the code would be the code marking its own work, so
 * this number is written by hand and the census below is what enforces it.
 */
const DECLARED_ASSERTIONS = 107;

/* ── Provenance — the FIRST thing this script says (00-vision.md §7 rule 3) ── */
console.log("=== check-plan-store.ts — provenance ========================");
console.log(`  repo worktree      : ${REPO_ROOT}`);
console.log(`  git HEAD           : ${git(["rev-parse", "--short", "HEAD"])}`);
console.log(`  git branch         : ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`);
{
  const dirty = git(["status", "--porcelain", "--", ...SUBJECT_FILES]);
  console.log(`  uncommitted (subj) : ${dirty === "" ? "none" : dirty.replace(/\n/g, " | ")}`);
}
for (const f of SUBJECT_FILES) console.log(`  sha256             : ${sha256(f)}  ${f}`);
console.log(`  fixture nodes      : ${NODES.length} (hand count ${HAND_TOTAL})`);
console.log(`  assertions declared: ${DECLARED_ASSERTIONS}`);
console.log("============================================================");
console.log();

console.log("── toPlanNodes ──────────────────────────────────────────────");
check("flattens every task in every phase", NODES.length, HAND_TOTAL);
check("preserves server order — first node is round 0", NODES[0]?.id, "t-0");
check("preserves server order — last node is round 706", NODES[NODES.length - 1]?.id, "t-706");
checkDeep(
  "rounds come out ascending, exactly as the server ordered them",
  NODES.map((n) => n.round),
  [
    0, 1, 100, 101, 200, 201, 300, 301, 302, 400, 401, 500, 501, 600, 601, 606, 700, 701, 702, 703,
    704, 705, 705, 706,
  ],
);
checkDeep("a node is the U27 shape and nothing else", NODES[1], {
  id: "t-1",
  title: "task 1",
  status: "done",
  round: 1,
  role: "planner",
  deps: ["t-0"],
  // R55: two more fields, and the key ORDER here is the order `toPlanNodes`
  // writes them — this is a JSON.stringify compare, so a field added in the
  // wrong place fails loudly rather than silently.
  workstream: "main",
  depth: 1,
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
  check("eight blocks across rounds 0..706", groups.length, 8);
  checkDeep(
    "ascending by block: 0,100,…,700",
    groups.map((g) => g.round_base),
    [0, 100, 200, 300, 400, 500, 600, 700],
  );
  checkDeep(
    "every node lands in exactly one column",
    groups.map((g) => g.total),
    [2, 2, 2, 3, 2, 2, 3, 8],
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
  check(
    "block 700: 2 of 8 done (pending, pending, harvesting, pending, running, blocked)",
    `${groups[7]?.done}/${groups[7]?.total}`,
    "2/8",
  );

  check("title comes from the server", groups[3]?.title, "phase 300 — chat surface");
  check("doc_path comes from the server", groups[3]?.doc_path, "300-read-side-api.md");
  check("a server phase with no title → no title key", "title" in (groups[0] ?? {}), false);
  check("a server phase with no doc_path → no doc_path key", "doc_path" in (groups[1] ?? {}), false);
  check("…and that block still has its title", groups[1]?.title, "phase 100 — read-side API");
  checkDeep(
    "column membership is by round, in server order",
    groups[7]?.nodes.map((n) => n.id),
    ["t-700", "t-701", "t-702", "t-703", "t-704", "t-705a", "t-705b", "t-706"],
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
    // Round 223's four rows: the phase-skipping edge, the two siblings, and
    // the dangling source. Hand-derived above with the rest of the counts.
    { source: "t-101", target: "t-704" },
    { source: "t-700", target: "t-705a" },
    { source: "t-701", target: "t-705b" },
    { source: "t-702", target: "t-705b" },
    { source: "t-missing", target: "t-706" },
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

/* ══ ROUND 223 — R54/R55 ═══════════════════════════════════════════════════ */

/** A node by id, or a loud throw. `NODES.find(...)!` would let a renamed
 *  fixture row turn into `undefined` and then into a silently skipped
 *  assertion — the exact accounting hole the census below exists to close. */
function node(id: string): PlanNode {
  const found = NODES.find((n) => n.id === id);
  if (found === undefined) {
    throw new Error(`fixture has no node ${id} — the fixture and this check disagree`);
  }
  return found;
}

/**
 * THE RULE THIS PHASE REPLACED, reimplemented here as the thing to differ
 * FROM: every task id in a strictly lower round, in server order. That is
 * byte-for-byte what `groupPlanPhases` on the server synthesises for a legacy
 * row (`depends_on === null`), and what it synthesised for EVERY row before
 * R54. Keeping it in the check is what lets the cases below assert that the
 * fixture's real edges could not have come out of it.
 */
function synthesised(id: string): string[] {
  const target = node(id);
  return NODES.filter((n) => n.round < target.round).map((n) => n.id);
}

console.log("\n── workstream / depth pass through toPlanNodes (R55) ────────");
{
  checkDeep(
    "every depth arrives verbatim, in node order",
    NODES.map((n) => n.depth),
    // HAND-DERIVED from the fixture's own deps: a row with no deps is a root
    // at 0, otherwise 1 + the longest of its deps. This is the array that
    // makes `depth: t.round` — the plausible typo — impossible to pass with.
    [0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 1, 2, 0],
  );
  check(
    "depth is NOT the round: only t-0 and t-1 agree, by coincidence of numbering",
    NODES.filter((n) => n.depth === n.round).length,
    HAND_DEPTH_EQUALS_ROUND,
  );
  check("t-704 depth is 1 — three orders of magnitude off its round", node("t-704").depth, 1);
  check("…and its round is still 704", node("t-704").round, 704);
  checkDeep(
    "the non-`main` rows arrive with their workstream verbatim",
    NODES.filter((n) => n.workstream !== "main").map((n) => [n.id, n.workstream]),
    [
      ["t-704", "ui"],
      ["t-705a", "api-v2"],
    ],
  );
  check("a row that asks for nothing is `main`, the column default", node("t-0").workstream, "main");
  check(
    "no node leaks an undefined workstream",
    NODES.every((n) => typeof n.workstream === "string"),
    true,
  );
  check("no node leaks an undefined depth", NODES.every((n) => typeof n.depth === "number"), true);
}

console.log("\n── workstreamLabel — the chip's whole rule (R55) ────────────");
{
  /* Built off a real node so the rule is exercised on the shape it ships
   * against, with only the field under test varied. */
  const ws = (workstream: string): PlanNode => ({ ...NODES[0]!, workstream });

  check("`main` → undefined: no chip, no placeholder, no dash", workstreamLabel(ws("main")), undefined);
  check("`ui` → 'ui'", workstreamLabel(ws("ui")), "ui");
  check("`Main` → 'Main' — case-sensitive, never folded to `main`", workstreamLabel(ws("Main")), "Main");
  /* THE EMPTY STRING, decided and documented rather than left to chance.
   * `validateWorkstream` in lib/task-graph.ts refuses '' upstream and the
   * column is NOT NULL DEFAULT 'main', so it cannot arrive through the API —
   * only from a hand-written row. Returning undefined for it would file a
   * corrupt row under "ordinary main task"; returning it verbatim renders an
   * empty chip carrying `data-plan-workstream=""`, which is a visible anomaly
   * someone can ask about. Not-`main` is the rule, and '' is not `main`. */
  check("the empty string → '' verbatim, not undefined", workstreamLabel(ws("")), "");
  check("…and specifically NOT undefined", workstreamLabel(ws("")) === undefined, false);
  check("on the real corpus: t-0 is main → undefined", workstreamLabel(node("t-0")), undefined);
  check("on the real corpus: t-704 → 'ui'", workstreamLabel(node("t-704")), "ui");
  check(
    "exactly two of twenty-four rows would wear a chip",
    NODES.filter((n) => workstreamLabel(n) !== undefined).length,
    HAND_LABELLED_WORKSTREAMS,
  );
}

console.log("\n── edges the coarse rule could NEVER have produced (R54) ────");
{
  checkDeep("t-704 waits on ONE task, five phase blocks below it", node("t-704").deps, ["t-101"]);
  check(
    "…which is block 100 while t-704 sits in block 700",
    `${phaseBase(node("t-101").round)}→${phaseBase(node("t-704").round)}`,
    "100→700",
  );
  checkDiffers(
    "the real dep set is NOT the synthesised one — the fixture discriminates",
    node("t-704").deps,
    synthesised("t-704"),
  );
  check("the synthesised set would have owed it all 20 rows below", synthesised("t-704").length, 20);

  const a = node("t-705a");
  const b = node("t-705b");
  check("the two siblings share a round", `${a.round}/${b.round}`, "705/705");
  checkDiffers("…and have DIFFERENT dep sets, which was impossible before R54", a.deps, b.deps);
  checkDeep("sibling a waits on t-700 alone", a.deps, ["t-700"]);
  checkDeep("sibling b waits on t-701 and t-702", b.deps, ["t-701", "t-702"]);
  /* The other half of the proof: under the old rule the two would have been
   * given the SAME set by construction, so the fact that they differ above is
   * only interesting because this is true. */
  check(
    "the coarse rule would have given both siblings the identical set",
    JSON.stringify(synthesised("t-705a")) === JSON.stringify(synthesised("t-705b")),
    true,
  );
}

console.log("\n── the dangling edge, emitted on purpose (R54/R27) ──────────");
{
  /* WHY THIS IS THE HONEST BEHAVIOUR: R27 makes a dangling dep unreachable
   * through the API, so a dep naming no row means a corrupt row arrived some
   * other way. Dropping the edge here would hand the operator a tidy graph
   * that the scheduler will never drain — the panel is the one surface built
   * to show that, so `planEdges` emits the id verbatim and lets the missing
   * node be visible by its absence. (`taskDepth()` on the server takes the
   * opposite decision for its own arithmetic — an absent dep contributes no
   * edge — because a missing node cannot be given a longest path. Both are
   * display; only this one is a report.) */
  check("`t-missing` names no node in the set", NODES.some((n) => n.id === "t-missing"), false);
  check(
    "…and planEdges emits its edge anyway, verbatim",
    planEdges(NODES).some((e) => e.source === "t-missing" && e.target === "t-706"),
    true,
  );
  checkDeep("the dangling id also survives on the node itself", node("t-706").deps, ["t-missing"]);
}

console.log("\n── depth disagrees with round; grouping follows ROUND (R55) ─");
{
  /* THE ASSERTION THAT CATCHES SOMEONE "IMPROVING" THE GROUPING TO USE DEPTH.
   * t-704 is round 704, depth 1: grouping by round puts it in block 700,
   * grouping by depth would put it in block 0. */
  const misfit = node("t-704");
  check("t-704 groups under 700, by its ROUND", groupPlanPhases([misfit], CORPUS)[0]?.round_base, 700);
  check("…while its depth would have grouped it under 0", phaseBase(misfit.depth), 0);
  check(
    "the extreme case too: round 101 with depth 703 is still block 100",
    groupPlanPhases([{ ...misfit, id: "t-x", round: 101, depth: 703 }], CORPUS)[0]?.round_base,
    100,
  );
}

/* ── Census (00-vision.md §7 rule 3) ──────────────────────────────────────
 *
 * A check that silently skipped half its table used to print "ALL PASS". The
 * declared count is hand-written above; this is where the two meet.
 */
console.log("\n── census ───────────────────────────────────────────────────");
console.log(`  fixture nodes        : ${NODES.length}`);
console.log(`  assertions declared  : ${DECLARED_ASSERTIONS}`);
console.log(`  assertions executed  : ${executed}`);
console.log(`  assertions failed    : ${failures}`);

let exitCode = failures === 0 ? 0 : 1;
if (executed !== DECLARED_ASSERTIONS) {
  console.error(
    `  FAIL executed ${executed} assertions but ${DECLARED_ASSERTIONS} are declared — ` +
      "a check that does not run what it declares cannot certify anything.",
  );
  exitCode = 1;
}
if (NODES.length !== HAND_TOTAL) {
  console.error(
    `  FAIL fixture has ${NODES.length} nodes but the hand count says ${HAND_TOTAL} — ` +
      "every expected value below was derived from the hand count.",
  );
  exitCode = 1;
}

/* The wording matters in the one case that used to be invisible: every printed
 * line says PASS and the run still fails, because the table did not run what it
 * declared. "0 FAILURE(S)" alone would read as a green run with a puzzling exit
 * code. */
console.log(
  `\n${
    exitCode === 0
      ? "ALL PASS"
      : failures > 0
        ? `${failures} FAILURE(S) — see the census above`
        : "FAILED — every assertion that ran was green, but the census above rejected the run"
  } — U27 plan store`,
);
process.exit(exitCode);
