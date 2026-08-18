/**
 * measure-graph-guide-budget.ts — round 822. What a CANDIDATE edit to
 * `GRAPH_GUIDE` would cost, measured against NF7's cap BEFORE it is written.
 *
 * THE QUESTION THIS ANSWERS. Round 821's reviewer had to hand the next round a
 * budget by hand — "NF7's ledger is an `assert.equal` at cap 12271, HEAD 12246,
 * headroom 25 characters" — and every round since 239 that touched
 * `GRAPH_GUIDE` has re-derived the same arithmetic in prose, in a commit
 * message, or in a doc-comment. `measure-prompt-baseline.sh` measures COMMITTED
 * REFS; nothing measured a candidate. So the question a round actually asks —
 * "does the text my brief requires FIT?" — could only be answered after writing
 * it, running `pnpm test`, and reading the ledger's failure message backwards.
 *
 * This reports the number first. Given a file holding a candidate
 * `GRAPH_GUIDE`, it prints the net delta against the live constant, the ledger
 * row that candidate would have to declare, and whether the result clears the
 * cap — and exits non-zero when it does not.
 *
 * WHERE EVERY NUMBER COMES FROM. Not from this file. `BASELINE`, `BUDGET`,
 * `FIVE_A_TIP` and every ledger `spent` are PARSED out of
 * `forge-control/src/lib/project-tick.test.ts`, which is where NF7 is enforced.
 * A cap copied into an instrument is a pin that rots the first time the gate
 * moves — the exact failure class `00-vision.md` §7 rule 1 names — so this file
 * reads the gate rather than remembering it. If the parse finds nothing, it
 * refuses to report (see (b) below).
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ──────────────────
 * (a) MEASURING A SHORTER PROMPT THAN A PLANNER RECEIVES. NF7's cap is
 *     meaningful only against the MAXIMAL path — repo-backed (WORKTREE_POLICY +
 *     GITHUB_PUSH_GUIDE), goal metadata, manager-chat linkage (MANAGER_COMMS),
 *     at a uuid-shaped project id that `taskCurl()` renders verbatim. §1
 *     asserts all four blocks present and the id 36 characters long before any
 *     number is printed, exactly as `maximalPlannerPrompt()` does in the test.
 *     Measuring the scratch path would understate the prompt by hundreds of
 *     characters and certify a candidate that does not fit.
 * (b) A PARSE THAT SILENTLY FOUND NOTHING. A regex that matches zero ledger
 *     rows would compute `ledgered = 0`, agree with nothing, and print a
 *     headroom of thousands. §2 asserts each of the three scalars was found
 *     exactly once and that at least one ledger row was parsed, then §3 checks
 *     the parsed ledger against a LIVE measurement: `FIVE_A_TIP + Σspent` must
 *     equal the measured prompt length — the ledger's own `assert.equal`,
 *     re-executed here. A parse that drifted from the gate fails there.
 * (c) SUBSTITUTION ARITHMETIC ON A CONSTANT THAT APPEARS TWICE. The delta
 *     `candidate.length - GRAPH_GUIDE.length` is the prompt's delta only if the
 *     guide occurs EXACTLY ONCE in the built prompt. It does today (the planner
 *     branch interpolates it once) and rounds 900 and 960 both leaned on that
 *     silently. §1 counts the occurrences and refuses at anything but 1, and §4
 *     performs the substitution for real and asserts the substituted length
 *     equals the arithmetic — the same positive control round 900 used.
 * (d) A SHADOW TREE. §0 prints the resolved absolute path and sha256 of the
 *     module measured, of the test file parsed, and of this script.
 * (e) READING A STALE CANDIDATE. §0 prints the candidate file's path, sha256
 *     and length, so the transcript names the exact text a number came off.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/measure-graph-guide-budget.ts
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/measure-graph-guide-budget.ts \
 *     --candidate ../docs/plan/engine-task-graph/evidence/round822-candidate-graph-guide.txt
 *
 * The candidate file holds the REPLACEMENT TEXT of the whole constant, verbatim
 * — what `GRAPH_GUIDE` would evaluate to, not its TypeScript source. A single
 * trailing newline is stripped (every editor adds one; the constant has none).
 *
 * Exit: 0 = measured, and the candidate (if any) fits the cap.
 *       1 = a control failed, or the candidate is over the cap.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildPrompt, GRAPH_GUIDE } from "../../forge-control/src/lib/project-tick.ts";
import type { Project, ProjectTask } from "../../forge-control/src/db/projects.ts";

let failures = 0;

function fail(message: string): void {
  failures++;
  console.log(`FAIL  ${message}`);
}

function digest(specifier: string): { path: string; sha256: string } {
  const path = fileURLToPath(new URL(specifier, import.meta.url));
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

/* ── 0. PROVENANCE, before any verdict (00-vision.md §7 rule 3) ───────────── */

const TICK = digest("../../forge-control/src/lib/project-tick.ts");
const TEST = digest("../../forge-control/src/lib/project-tick.test.ts");
const SELF = digest("./measure-graph-guide-budget.ts");

const argv = process.argv.slice(2);
const candidateFlag = argv.indexOf("--candidate");
if (candidateFlag !== -1 && argv[candidateFlag + 1] === undefined) {
  console.log("FAIL  --candidate needs a path");
  process.exit(1);
}
const candidatePath = candidateFlag === -1 ? null : argv[candidateFlag + 1];

console.log("measure-graph-guide-budget.ts — round 822, a candidate GRAPH_GUIDE against NF7");
console.log();
console.log("PROVENANCE");
console.log(`  this check      : ${SELF.path}`);
console.log(`  this check sha  : ${SELF.sha256}`);
console.log(`  measured module : ${TICK.path}`);
console.log(`     sha256       : ${TICK.sha256}`);
console.log(`  gate parsed     : ${TEST.path}`);
console.log(`     sha256       : ${TEST.sha256}`);
console.log(`  node            : ${process.version}`);

let candidate: string | null = null;
if (candidatePath !== null) {
  const raw = readFileSync(candidatePath, "utf8");
  candidate = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  console.log(`  candidate       : ${candidatePath}`);
  console.log(
    `     sha256       : ${createHash("sha256").update(raw).digest("hex")}` +
      `  (${candidate.length} chars, newline-stripped)`,
  );
}
console.log();

/* ── 1. THE MAXIMAL PLANNER PROMPT, with the controls that make it maximal ──
 *
 * The fixture is the one `project-tick.test.ts`'s `maximalPlannerPrompt()`
 * builds, restated here rather than imported because a test file is not a
 * module anyone may import for its fixtures (importing it would execute 152
 * cases). The controls are restated with it — a fixture copied without its
 * controls is the shorter prompt of (a) wearing the longer one's name. */

const MAXIMAL_PROJECT_ID = "8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4";
/* The key is assembled, never spelled, for the same reason the test assembles
 * it: `08 §4.3`'s boundary grep must keep matching only `cc-runner.ts` and
 * `db/projects.ts`. */
const MANAGER_LINK_KEY = "origin_" + "chat_id";

const maximalProject: Project = {
  id: MAXIMAL_PROJECT_ID,
  name: "Test Project",
  brief: "Do the thing.",
  repo: "ai-os",
  workspace_dir: null,
  base_branch: "main",
  work_branch: "project/x",
  status: "active",
  metadata: {
    mode: "goal",
    [MANAGER_LINK_KEY]: "bfd1283a-b71b-4f35-b577-7d09aad803f2",
  },
  created_at: "",
  updated_at: "",
};

const plannerTask: ProjectTask = {
  id: "t1",
  project_id: "p1",
  round: 500,
  role: "planner",
  title: "Do it",
  brief: "Implement the thing.",
  status: "ready",
  run_id: null,
  fix_cycle: 0,
  tier: null,
  attempt: 0,
  chain_key: null,
  depends_on: null,
  workstream: "main",
  write_set: [],
  graph_frozen: false,
  created_at: "",
  updated_at: "",
};

const prompt = buildPrompt(plannerTask, maximalProject);

if (maximalProject.id.length !== 36) {
  fail(
    `NOT THE MAXIMAL PATH: the fixture project id is ${maximalProject.id.length} characters, ` +
      "not a uuid's 36 — taskCurl() renders it verbatim and every NF7 constant was measured " +
      "against a uuid-shaped id",
  );
}
for (const [name, needle] of [
  ["WORKTREE_POLICY", "WORKTREE-ONLY POLICY"],
  ["ESCALATION_POLICY", "AUTONOMY AND ESCALATION"],
  ["MANAGER_COMMS", "MANAGER COMMS"],
  ["GITHUB_PUSH_GUIDE", "GITHUB PUSH"],
] as const) {
  if (!prompt.includes(needle)) {
    fail(
      `NOT THE MAXIMAL PATH: ${name} is absent, so this measurement understates the prompt ` +
        "every real planner receives (NF7)",
    );
  }
}

/* Control (c). `split(needle).length - 1` counts non-overlapping occurrences;
 * GRAPH_GUIDE is not self-overlapping, so this is the occurrence count. */
const guideOccurrences = prompt.split(GRAPH_GUIDE).length - 1;
if (guideOccurrences !== 1) {
  fail(
    `GRAPH_GUIDE occurs ${guideOccurrences} time(s) in the maximal planner prompt, not once. ` +
      "Every delta below is `candidate.length - GRAPH_GUIDE.length`, which is the PROMPT's " +
      "delta only at exactly one occurrence — at two, a replacement costs twice what the " +
      "ledger row would say, and rounds 900 and 960 both relied on this without checking it",
  );
}

const measured = prompt.length;

/* ── 2. THE GATE, PARSED FROM WHERE IT IS ENFORCED ────────────────────────── */

const testSource = readFileSync(TEST.path, "utf8");

function scalar(name: string): number {
  const hits = [...testSource.matchAll(new RegExp(`\\bconst ${name} = (\\d+);`, "g"))];
  if (hits.length !== 1) {
    fail(
      `parsed ${hits.length} definitions of \`const ${name}\` in project-tick.test.ts, expected ` +
        "exactly 1 — the gate moved or was renamed, and a number this instrument cannot find " +
        "must not be replaced by one it remembers",
    );
    return Number.NaN;
  }
  return Number(hits[0][1]);
}

const BASELINE = scalar("BASELINE");
const BUDGET = scalar("BUDGET");
const FIVE_A_TIP = scalar("FIVE_A_TIP");

/* THE LEDGER BLOCK IS ISOLATED FIRST, and that is not tidiness. The obvious
 * one-pass regex — `round: (\d+)` … lazily … `spent: (\d+)` — reads the WHOLE
 * file, and `project-tick.test.ts` is full of task fixtures carrying
 * `round: 1`. Measured at round 822, before this was scoped: it reported the
 * 240 row as `round: 1`, because the lazy middle started at the first
 * `round:` anywhere in the file and ran forward to the ledger's first `spent:`.
 * The SUM was right and one label was a fiction — an instrument reporting a
 * plausible wrong number, which is worse than one that fails. So: cut the
 * `const LEDGER = [ … ] as const;` block out by its own delimiters, assert it
 * was found exactly once, and parse only inside it. */
const ledgerBlocks = [...testSource.matchAll(/\n\s*const LEDGER = \[\n([\s\S]*?)\n\s*\] as const;/g)];
if (ledgerBlocks.length !== 1) {
  fail(
    `found ${ledgerBlocks.length} \`const LEDGER = [ … ] as const;\` blocks in ` +
      "project-tick.test.ts, expected exactly 1 — the gate was renamed or reshaped, and a " +
      "ledger this instrument cannot locate must not be replaced by one it infers from the " +
      "whole file (the whole file is full of `round: 1` task fixtures)",
  );
}
const ledgerBody = ledgerBlocks.length === 1 ? ledgerBlocks[0][1] : "";
const ledgerRounds = [...ledgerBody.matchAll(/^\s+round: (\d+),$/gm)].map((m) => Number(m[1]));
const ledgerSpends = [...ledgerBody.matchAll(/^\s+spent: (\d+),$/gm)].map((m) => Number(m[1]));
if (ledgerRounds.length === 0 || ledgerRounds.length !== ledgerSpends.length) {
  fail(
    `parsed ${ledgerRounds.length} round label(s) and ${ledgerSpends.length} spend(s) out of ` +
      "NF7's LEDGER — a ledger that reads as empty, or as unpaired, would put every character " +
      "since the 5A tip into 'unattributed' and report a headroom thousands of characters wide",
  );
}
const ledgerRows = ledgerSpends.map((spent, i) => ({ round: ledgerRounds[i] ?? Number.NaN, spent }));

const ledgered = ledgerRows.reduce((sum, row) => sum + row.spent, 0);
const cap = BASELINE + BUDGET;
const headroom = cap - measured;

console.log("NF7, AS ENFORCED (parsed from project-tick.test.ts, not remembered here)");
console.log(`  BASELINE                       ${BASELINE}`);
console.log(`  BUDGET                         ${BUDGET}`);
console.log(`  cap = BASELINE + BUDGET        ${cap}`);
console.log(`  FIVE_A_TIP                     ${FIVE_A_TIP}`);
for (const row of ledgerRows) {
  console.log(`  ledger row ${String(row.round).padEnd(6)}             +${row.spent}`);
}
console.log(`  ledgered total                 ${ledgered}`);
console.log();
console.log("MEASURED, through the maximal planner path");
console.log(`  GRAPH_GUIDE                    ${GRAPH_GUIDE.length} chars`);
console.log(`  maximal planner prompt         ${measured} chars`);
console.log(`  headroom = cap - measured      ${headroom}`);
console.log();

/* ── 3. THE LEDGER'S OWN assert.equal, RE-EXECUTED ─────────────────────────
 * If this disagrees, either the parse above is wrong or the working tree has
 * an unledgered edit. Either way no candidate arithmetic below is trustworthy,
 * so it is a failure and not a warning. */

const expected = FIVE_A_TIP + ledgered;
if (measured !== expected) {
  fail(
    `the parsed ledger says ${FIVE_A_TIP} + ${ledgered} = ${expected}, and the live maximal ` +
      `prompt measures ${measured} — ${measured - expected} characters are unaccounted for. ` +
      "Either this instrument's parse has drifted from the gate, or the working tree carries " +
      "an unledgered prompt edit (`pnpm test` will say which, in NF7's own message).",
  );
}

/* ── 4. THE CANDIDATE ─────────────────────────────────────────────────────── */

if (candidate !== null) {
  const delta = candidate.length - GRAPH_GUIDE.length;
  const projected = measured + delta;

  // Control (c), second half: perform the substitution rather than trusting the
  // arithmetic. `replace()` with a string pattern replaces the FIRST occurrence
  // only, which is exactly right at the single occurrence §1 asserted.
  const substituted = prompt.replace(GRAPH_GUIDE, candidate).length;
  if (substituted !== projected) {
    fail(
      `the arithmetic projects ${projected} and the real substitution measures ${substituted}. ` +
        "The two can only differ if GRAPH_GUIDE does not appear in the prompt verbatim — " +
        "trust the substitution and not this instrument until that is explained.",
    );
  }

  const projectedHeadroom = cap - projected;
  console.log("CANDIDATE");
  console.log(`  candidate GRAPH_GUIDE          ${candidate.length} chars`);
  console.log(`  net delta vs the live guide    ${delta >= 0 ? "+" : ""}${delta}`);
  console.log(`  projected maximal prompt       ${projected} chars (substitution: ${substituted})`);
  console.log(`  projected headroom             ${projectedHeadroom}`);
  console.log();
  console.log("  the LEDGER row this candidate would have to declare:");
  console.log(`    { round: <yours>, what: "…", spent: ${delta}, reserved: >= ${delta} }`);
  console.log();

  if (projectedHeadroom < 0) {
    fail(
      `the candidate is ${-projectedHeadroom} characters OVER the cap (${cap}). Either shrink ` +
        `it — a replacement is ledgered at its NET, so retiring text pays for new text — or ` +
        `amend BUDGET where it is enforced (project-tick.test.ts's NF7 block AND ` +
        `01-requirements.md §J's NF7 text, in ONE commit), with this arithmetic inline and ` +
        `the divergence reported to the manager chat. BUDGET ${BUDGET} -> ` +
        `${BUDGET - projectedHeadroom} is the minimum that admits it, with no headroom left ` +
        `over for the round after yours.`,
    );
  } else if (!Number.isFinite(projectedHeadroom)) {
    /* Round 823's non-blocking note 1, closed at round 824. `scalar()` returns
     * NaN when a constant cannot be parsed out of the gate — the correct
     * refusal — but `NaN < 0` is FALSE, so control flow fell into the `else`
     * and printed `VERDICT: FITS — NaN characters would remain under the cap`.
     * The run still exited 1 and §5 still voided every number, so the letter of
     * `00-vision.md` §7 rule 3 held; what did not hold is that the affirmative
     * string is the one a grep, a skim or a pasted excerpt lifts. A verdict line
     * is read on its own far more often than in sequence. Reproduced by
     * renaming `const BASELINE` in project-tick.test.ts; re-run after this
     * change, the same mutation prints the refusal below and no FITS anywhere. */
    fail(
      `NO VERDICT IS AVAILABLE: the projected headroom is ${projectedHeadroom} (cap ${cap}, ` +
        `projected ${projected}). A scalar above failed to parse out of ` +
        "project-tick.test.ts, so there is no cap to judge this candidate against — and a " +
        "candidate cannot be called fitting against a number that was never read.",
    );
  } else {
    console.log(`  VERDICT: FITS — ${projectedHeadroom} characters would remain under the cap.`);
  }
}

/* ── 5. VERDICT ───────────────────────────────────────────────────────────── */

console.log(
  failures === 0
    ? `OK — measured ${measured} against cap ${cap}, ${headroom} of headroom` +
        (candidate === null ? "" : ", candidate fits")
    : `${failures} FAILURE(S) — no number above may be quoted`,
);
process.exit(failures === 0 ? 0 : 1);
