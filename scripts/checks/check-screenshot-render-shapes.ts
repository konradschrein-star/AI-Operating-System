/**
 * check-screenshot-render-shapes.ts — round 902, fix cycle 1, review finding 1.
 *
 * THE QUESTION THIS ANSWERS. `SCREENSHOT_CONVENTION` (project-tick.ts) and the
 * `- Screenshots:` bullet in `buildSystemPrompt` (cc-runner.ts) tell four task
 * roles and every manager-chat run where to save a screenshot AND what will
 * happen to it. Until this round they promised that the desktop chat "renders
 * every shot under that directory inline". Nothing checked that promise against
 * the renderer, and it was false: `extractBrowserShots` matches exactly two
 * payload shapes, and "the agent wrote a PNG into the directory" is neither of
 * them. A prompt is a claim about the system; this is the claim executed.
 *
 * WHY A SCRIPT AND NOT A UNIT TEST. The claim spans two packages —
 * `forge-control`'s prompts and `forge-control-web`'s renderer — and
 * `forge-control`'s test run cannot import the web app. vitest is not set up in
 * either repo and NFU8 forbids adding one, so a pure helper gets a plain tsx
 * script: table-driven, zero dependencies, one PASS/FAIL line per case,
 * `process.exit(1)` if anything fails. Same shape as check-browser-shots.ts,
 * deliberately — that script proves the extractor is right about its OWN
 * fixtures; this one proves the PROMPTS are right about the extractor.
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ──────────────────
 * (a) A SHADOW TREE — importing a renderer from some other checkout while
 *     claiming to check this one. The provenance block prints the RESOLVED
 *     absolute path of every module it imported and that file's sha256, next to
 *     this worktree's git HEAD and this script's own sha256. A reader can
 *     `sha256sum` the named path and get the same value or find out otherwise.
 * (b) A VACUOUS SWEEP — a table that ran zero cases, or whose cases all assert
 *     `0 refs` and would pass against a renderer that had been deleted. Closed
 *     twice: the case count is asserted against a declared constant before the
 *     verdict, and the table carries POSITIVE cases (a Read, a `"url"` member)
 *     whose expected value is 1 — a renderer returning `[]` for everything
 *     fails them.
 * (c) A TAUTOLOGY — reading the expectation out of the same regexes the
 *     renderer uses. Nothing here imports a regex; every case is a payload
 *     shape written the way an agent's transcript actually carries it, and the
 *     expectation is a number typed by hand from what the round-902 review
 *     established.
 * (d) A PROMPT THAT DRIFTED AWAY FROM THE PROOF — the cases stay green while
 *     the constants stop saying what they demonstrate. Closed by §3, which
 *     imports both prompts and asserts the clause each proven shape justifies.
 *
 * Run:
 *   cd forge-control-web && npx tsx ../scripts/checks/check-screenshot-render-shapes.ts
 * Exit: 0 = every case matched; 1 = anything failed, or the sweep was empty.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  extractBrowserShots,
  type ToolCallLike,
} from "../../forge-control-web/app/desktop/chat/browser-shots.ts";
import {
  SCREENSHOT_CONVENTION,
} from "../../forge-control/src/lib/project-tick.ts";
import { buildSystemPrompt } from "../../forge-control/src/lib/cc-runner.ts";

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
  "../../forge-control-web/app/desktop/chat/browser-shots.ts",
  "../../forge-control/src/lib/project-tick.ts",
  "../../forge-control/src/lib/cc-runner.ts",
].map(digest);

console.log("check-screenshot-render-shapes.ts — round 902, review finding 1");
console.log();
console.log("PROVENANCE");
console.log(`  this check      : ${digest("./check-screenshot-render-shapes.ts").path}`);
console.log(`  this check sha  : ${digest("./check-screenshot-render-shapes.ts").sha256}`);
for (const m of IMPORTED) {
  console.log(`  imported        : ${m.path}`);
  console.log(`     sha256       : ${m.sha256}`);
}
console.log(`  node            : ${process.version}`);
console.log();

/* ── 1. THE PAYLOAD SHAPES ────────────────────────────────────────────────
 *
 * `DIR` is the uploads directory of run 7a0c6432-cde4-4ca1-8f17-ff340c236c0a,
 * the same real run check-browser-shots.ts uses; `NAME` follows the convention
 * this round defines. What each case models is written next to it, because the
 * point of the table is that these are the things AGENTS ACTUALLY DO, not
 * inputs chosen to make a regex happy.
 */

const DIR = "7a0c6432cde4";
const NAME = "20260818T093000Z-settings-dark.png";
const PATH = `/opt/ai-os/uploads/${DIR}/${NAME}`;

const bash = (result: string, command = ""): ToolCallLike => ({
  toolName: "Bash",
  argsText: JSON.stringify({ command }),
  result,
});
const read = (filePath: string): ToolCallLike => ({
  toolName: "Read",
  argsText: JSON.stringify({ file_path: filePath }),
});

interface Case {
  /** What an agent did, in one line. */
  what: string;
  call: ToolCallLike;
  /** Refs `extractBrowserShots` returns — i.e. thumbnails rendered inline. */
  refs: number;
  /** Why this case is in the table. */
  why: string;
}

const CASES: readonly Case[] = [
  {
    what: "A. the agent READS the shot back after saving it",
    call: read(PATH),
    refs: 1,
    why: "the action SCREENSHOT_CONVENTION now prescribes — this is the case that makes the promise true",
  },
  {
    what: 'B. a Bash result echoing the BARE /api/uploads URL as text',
    call: bash(`saved: /api/uploads/${DIR}/${NAME}\n`),
    refs: 0,
    why:
      "round 901's review offered 'print its URL' as an equal alternative. It does not render: " +
      "URL_MEMBER_RE requires the quoted JSON member, not the path in a sentence. Prescribing this " +
      "would have rebuilt the defect one round later",
  },
  {
    what: 'C. a Bash result carrying a JSON "url" member',
    call: bash(`{"label":"settings-dark","url":"/api/uploads/${DIR}/${NAME}","url_servable":true}`),
    refs: 1,
    why: "what scripts/research-browser.mjs prints itself — the one population covered before round 900",
  },
  {
    what: "D. mcp__playwright__browser_take_screenshot straight to the directory",
    call: {
      toolName: "mcp__playwright__browser_take_screenshot",
      argsText: JSON.stringify({ filename: PATH }),
      result: `Saved to ${PATH}`,
    },
    refs: 0,
    why:
      "the extractor reads Bash and Read tool names only; an MCP browser call renders nothing inline " +
      "however correct its path, which is precisely why the prompt must say 'then Read it back'",
  },
  {
    what: "E. the playwright-skill's script copying its /tmp shot into the directory",
    call: bash("", `cp /tmp/shot.png ${PATH}`),
    refs: 0,
    why: "a correct save with a silent result — the file is served and listed, but nothing is inline",
  },
  {
    what: "F. a Read of a correctly-placed but UNSTAMPED name",
    call: read(`/opt/ai-os/uploads/${DIR}/settings-dark.png`),
    refs: 1,
    why:
      "finding 3: it does render, so this is not a naming pedantry — parseShotName yields ts:null, " +
      "so it sorts last in newestFirst and shows no clock. The <stamp> clause exists for this",
  },
  {
    what: "G. a Bash result merely mentioning /api/uploads in prose",
    call: bash(`I saved two shots under /api/uploads/${DIR}/ for you.`),
    refs: 0,
    why: "the negative control browser-shots.ts's own header claims: shape, not prose",
  },
];

const DECLARED_CASES = 7;

console.log("── payload shapes → inline refs ─────────────────────────────");
for (const c of CASES) {
  check(`${c.what}  [${c.why}]`, extractBrowserShots(c.call).length, c.refs);
}
console.log();

/* ── 2. THE STAMP, MEASURED RATHER THAN ASSUMED ───────────────────────────── */

console.log("── the <stamp> clause is about a real difference ─────────────");
const stamped = extractBrowserShots(read(PATH))[0];
const unstamped = extractBrowserShots(read(`/opt/ai-os/uploads/${DIR}/settings-dark.png`))[0];
check("a stamped name carries its own time", stamped?.ts, "2026-08-18T09:30:00Z");
check("an unstamped one carries none", unstamped?.ts, null);
console.log();

/* ── 3. THE PROMPTS SAY WHAT THE TABLE PROVED ─────────────────────────────── */

console.log("── both prompts match the executed result ────────────────────");
const CHAT = buildSystemPrompt(true);
for (const [what, needle] of [
  ["the read-back action (task roles)", "THEN READ THE FILE BACK with the Read tool"],
  ["the stamp format by example (task roles)", "20260818T093000Z"],
  ["the honest fallback surface (task roles)", "camera indicator in the Team and Live panels"],
] as const) {
  check(`SCREENSHOT_CONVENTION states ${what}`, SCREENSHOT_CONVENTION.includes(needle), true);
}
for (const [what, needle] of [
  ["the read-back action (manager chat)", "READ THE FILE BACK with the Read tool"],
  ["the stamp format by example (manager chat)", "20260818T093000Z"],
  ["the honest fallback surface (manager chat)", "camera indicator in the Team and Live panels"],
] as const) {
  check(`buildSystemPrompt states ${what}`, CHAT.includes(needle), true);
}
check(
  "neither prompt still promises that writing the file is enough",
  SCREENSHOT_CONVENTION.includes("renders every shot under that directory inline") ||
    CHAT.includes("renders every shot under that directory inline"),
  false,
);
console.log();

/* ── 4. VERDICT, with the sweep's own census first ────────────────────────── */

if (CASES.length !== DECLARED_CASES) {
  console.log(
    `FAIL  the payload table declares ${DECLARED_CASES} cases and holds ${CASES.length} — a sweep ` +
      "whose probes went missing must not certify itself",
  );
  failures++;
}
const EXPECTED_CHECKS = DECLARED_CASES + 2 + 7;
if (ran !== EXPECTED_CHECKS) {
  console.log(
    `FAIL  ${ran} checks ran, ${EXPECTED_CHECKS} expected — a section stopped executing and the ` +
      "remaining PASS lines would have read as full coverage",
  );
  failures++;
}

console.log(
  failures === 0
    ? `ALL PASS — ${ran} checks`
    : `${failures} FAILURE(S) out of ${ran} checks`,
);
process.exit(failures === 0 ? 0 : 1);
