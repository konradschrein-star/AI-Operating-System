/**
 * verify-notification-gap-pins.mjs — makes `docs/plan/notification-gap.md` §1's
 * central claim executable instead of hand-checked.
 *
 * §1 asserts that every fenced code block in that document is byte-identical to
 * the source range its heading pins. Round 1350 verified that by hand, round
 * 1352's reviewer verified it again by hand and found one pin that had rotted
 * underneath it (a sibling commit inserted two lines above `AssistantThread.tsx`
 * in this shared worktree). A claim that has to be re-verified by hand every
 * round is a claim that will eventually be verified by nobody.
 *
 * So: this script IS the check. It parses the doc, finds every heading of the
 * shape
 *
 *     `file.ts` — some anchor prose (`:120-134` @ `852b089`)
 *     ```ts
 *     …quoted lines…
 *     ```
 *
 * (single-line pins — `(`:52` @ `sha`)` — are handled too), reads the pinned
 * range out of the working tree, and diffs. Any mismatch prints both sides and
 * exits 1.
 *
 * SCOPE, deliberately narrow, in two halves.
 *
 *  A. FENCED QUOTES. Every pinned heading followed by a code fence: the quote
 *     must be byte-identical to the pinned range in the working tree. It does
 *     not verify the SHA — if you have moved off `852b089` and the lines still
 *     match, that is a pass, and correctly so, because the quote is what the
 *     reader relies on. Whether the doc's SHA is current is what §1's
 *     `git diff <sha> -- <files>` command is for.
 *
 *  B. PROSE PINS — added round 1355, and the reason is a failure of half A.
 *     The doc also cites `file:line` in running prose, with no fence under it,
 *     and half A cannot see those: it keys off a heading followed by ```. In
 *     round 1353 two such pins in §2c were swapped to the wrong symbols and
 *     this script printed `ALL PASS — 11/11` with a wrong pin sitting four
 *     lines below a passing one. `11/11` meant "eleven fenced quotes", and it
 *     was read as "every pin in the document".
 *
 *     So prose pins are now declared explicitly in PROSE_PINS below. Each entry
 *     asserts two things: that the doc still CONTAINS that exact citation
 *     string (so renumbering a pin without registering it fails loudly rather
 *     than drifting out of coverage), and that the cited line matches the
 *     symbol the prose says is there. Registration is manual on purpose — a
 *     generic "find every `file:line` in the prose" regex would have to guess
 *     what each pin is claiming, and a check that guesses is a check that gets
 *     argued with.
 *
 * What is STILL not covered, stated so the next `ALL PASS` is read correctly:
 * prose pins that are not in PROSE_PINS, cross-document pins into other
 * `docs/plan` files, and the historical pins in §1 that deliberately name
 * ranges at OLD SHAs (they describe what rotted; they are not claims about the
 * tree). The count in the summary line names both halves separately.
 *
 * Run (from the repo root):
 *   node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DOC = "docs/plan/notification-gap.md";

/**
 * The doc cites files by the shortest unambiguous name a reader would grep for
 * ("cc-runner.ts", "db/runs.ts"). Resolve those to repo-relative paths here
 * rather than guessing: an unmapped citation is a hard error, so adding a new
 * quote to the doc without registering its file fails loudly instead of being
 * silently skipped.
 */
const RESOLVE = new Map([
  ["cc-runner.ts", "forge-control/src/lib/cc-runner.ts"],
  ["executor.ts", "forge-control/src/executor.ts"],
  ["db/runs.ts", "forge-control/src/db/runs.ts"],
  ["routes/run-control.ts", "forge-control/src/routes/run-control.ts"],
  ["run-control-rules.ts", "forge-control/src/lib/run-control-rules.ts"],
  ["AssistantThread.tsx", "forge-control-web/app/desktop/chat/AssistantThread.tsx"],
  ["thread-mapping.ts", "forge-control-web/app/desktop/chat/thread-mapping.ts"],
  ["tool-summary.ts", "forge-control-web/app/desktop/chat/tool-summary.ts"],
  ["subagent-slice.ts", "forge-control-web/app/desktop/chat/subagent-slice.ts"],
]);

/** ``file`` — prose (`:A-B` @ `sha`)  or  (`:A` @ `sha`) */
const HEADING = /^`([^`]+)`\s+—\s+.*\(`:(\d+)(?:-(\d+))?`\s+@\s+`([0-9a-f]{7,40})`\)\s*$/;

/**
 * Half B: the pins that live in running prose, where no fence carries the
 * evidence. See SCOPE above for why these are declared by hand.
 *
 * Three fields do the work, and the middle one is the whole lesson:
 *
 *   `cite`   the exact string the doc must still contain — the registration
 *            handshake, so renumbering a pin without updating this table fails
 *            loudly instead of drifting out of coverage.
 *   `bind`   the SENTENCE that ties that number to the symbol it claims, matched
 *            against the whole doc. This is the field that catches round 1353's
 *            defect and `cite` alone does not: both `run-control.ts:214` and
 *            `run-control.ts:149` appeared in the wrong version of §2c too, just
 *            wearing each other's labels. Two right numbers, swapped, are
 *            invisible to any check that only asks "is this number present?".
 *            Verified: run this script against the doc at `b3995f3` with `bind`
 *            removed and it reports ALL PASS; with `bind` it reports 2 FAILURES.
 *   `expect` what the pinned line itself must match, in the working tree.
 *
 * `what` is printed in the PASS/FAIL line: the claim, in the doc's own words.
 */
const PROSE_PINS = [
  {
    section: "§2c",
    cite: "`run-control.ts:214`",
    bind: /`POST \/:id\/message` \(`run-control\.ts:214`/,
    path: "forge-control/src/routes/run-control.ts",
    line: 214,
    what: "the POST /:id/message route handler",
    expect: /^r\.post\("\/:id\/message"/,
  },
  {
    section: "§2c",
    cite: "`run-control.ts:149`",
    bind: /`toThreadEntry`\s+\(`run-control\.ts:149`/,
    path: "forge-control/src/routes/run-control.ts",
    line: 149,
    what: "toThreadEntry, the comms-entry serializer",
    expect: /^function toThreadEntry\(/,
  },
  {
    section: "§2a1",
    cite: "`executor.ts:772`",
    bind: /`RESULT_PREVIEW_CHARS = 2_500`\s+\(`executor\.ts:772`\)/,
    path: "forge-control/src/executor.ts",
    line: 772,
    what: "RESULT_PREVIEW_CHARS, the tool_result truncation ceiling",
    expect: /RESULT_PREVIEW_CHARS\s*=\s*2_500/,
  },
  {
    section: "§3a",
    cite: "`executor.ts:806`",
    bind: /`toolResultEntry` returns\s+`role: "tool"` \(`executor\.ts:806`\)/,
    path: "forge-control/src/executor.ts",
    line: 806,
    what: 'toolResultEntry\'s role: "tool"',
    expect: /^\s*role: "tool",\s*$/,
  },
  {
    section: "§2b / §3",
    cite: "(`:952-986` @ `852b089`)",
    bind: /`onEvent`\s+\(`:952-986` @ `852b089`\)/,
    path: "forge-control/src/executor.ts",
    line: 952,
    what: "the opening of executor's onEvent",
    expect: /^\s*const onEvent = \(e: CcEvent\) => \{/,
  },
  {
    section: "§3",
    cite: "`:800-817`",
    bind: /`toolResultEntry` \(`:800-817`\)/,
    path: "forge-control/src/executor.ts",
    line: 800,
    what: "toolResultEntry, the entry builder item 4 says to build beside",
    expect: /^function toolResultEntry\(/,
  },
  {
    section: "§3",
    cite: "already in scope at `:462`",
    bind: /`parentToolUseId`, already in scope at `:462`/,
    path: "forge-control/src/lib/cc-runner.ts",
    line: 462,
    what: "the parentToolUseId binding",
    expect: /^\s*const parentToolUseId =/,
  },
  {
    section: "§2b",
    cite: "`forge-control-web/app/desktop/chat/tool-summary.ts:406-409`",
    bind: /`forge-control-web\/app\/desktop\/chat\/tool-summary\.ts:406-409` \(@ `852b089`\) — \*"An async/,
    path: "forge-control-web/app/desktop/chat/tool-summary.ts",
    line: 406,
    what: 'the "Async agent launched" banner note',
    expect: /An async spawn returns the harness's "Async agent launched/,
  },
  {
    section: "§2a2",
    cite: "`forge-control-web/app/desktop/chat/subagent-slice.ts:11-17`",
    bind: /on this exact wire fact \(`forge-control-web\/app\/desktop\/chat\/subagent-slice\.ts:11-17`\)/,
    path: "forge-control-web/app/desktop/chat/subagent-slice.ts",
    line: 11,
    what: "the inline-sub-agent-entries fact",
    expect: /Sub-agent entries are INLINE in the parent run's thread/,
  },
  {
    section: "§2c",
    cite: "`AssistantThread.tsx:235-237`",
    bind: /`AssistantThread\.tsx:235-237` \(`UserMessage`\)/,
    path: "forge-control-web/app/desktop/chat/AssistantThread.tsx",
    line: 235,
    what: "UserMessage, where an inbound comms entry is dispatched",
    expect: /^function UserMessage\(\)/,
  },
  {
    section: "§2c",
    cite: "`:279-281`",
    bind: /and `:279-281`\s+\(`AssistantMessage`/,
    path: "forge-control-web/app/desktop/chat/AssistantThread.tsx",
    line: 279,
    what: "AssistantMessage's comms lookup, for the outbound echo",
    expect: /^\s*const comms = useCommsFacts\(\);/,
  },
  {
    section: "§2c",
    cite: "`forge-control/src/lib/run-control-rules.test.ts:468+`",
    bind: /`forge-control\/src\/lib\/run-control-rules\.test\.ts:468\+` \(`describe\("commsEntries"\)`\)/,
    path: "forge-control/src/lib/run-control-rules.test.ts",
    line: 468,
    what: 'describe("commsEntries") — the test the section cites',
    expect: /^describe\("commsEntries"/,
  },
];

const doc = readFileSync(resolve(ROOT, DOC), "utf8").split("\n");
const sourceCache = new Map();

function sourceLines(path) {
  let lines = sourceCache.get(path);
  if (lines === undefined) {
    lines = readFileSync(resolve(ROOT, path), "utf8").split("\n");
    sourceCache.set(path, lines);
  }
  return lines;
}

let checked = 0;
let failed = 0;

for (let i = 0; i < doc.length; i++) {
  const m = HEADING.exec(doc[i]);
  if (m === null) continue;
  const [, name, aRaw, bRaw, sha] = m;

  if (!/^```/.test(doc[i + 1] ?? "")) {
    // A pinned heading with no fence under it is a doc bug, not a skip: the
    // heading promises a quote. Say so rather than passing over it.
    failed++;
    console.log(`FAIL  ${name}:${aRaw}${bRaw ? `-${bRaw}` : ""} — pinned heading is not followed by a code fence`);
    continue;
  }

  const path = RESOLVE.get(name);
  if (path === undefined) {
    throw new Error(
      `${DOC}:${i + 1} cites \`${name}\`, which is not in this script's RESOLVE map. ` +
        `Register it (repo-relative path) — an unmapped citation must not be skipped silently.`,
    );
  }

  const quoted = [];
  for (let j = i + 2; j < doc.length && !/^```/.test(doc[j]); j++) quoted.push(doc[j]);

  const a = Number(aRaw);
  const b = bRaw === undefined ? a : Number(bRaw);
  if (b < a) throw new Error(`${DOC}:${i + 1} pins an inverted range :${a}-${b}`);
  const actual = sourceLines(path).slice(a - 1, b);

  checked++;
  const ok = quoted.length === actual.length && quoted.every((l, k) => l === actual[k]);
  if (ok) {
    console.log(`PASS  ${name}:${a}${bRaw ? `-${b}` : ""} @ ${sha}  (${quoted.length} line${quoted.length === 1 ? "" : "s"})`);
    continue;
  }
  failed++;
  console.log(`FAIL  ${name}:${a}${bRaw ? `-${b}` : ""} @ ${sha}`);
  console.log(`        doc quotes ${quoted.length} line(s), source range holds ${actual.length}`);
  const width = Math.max(quoted.length, actual.length);
  for (let k = 0; k < width; k++) {
    if (quoted[k] === actual[k]) continue;
    console.log(`        L${a + k}  doc: ${JSON.stringify(quoted[k] ?? null)}`);
    console.log(`               src: ${JSON.stringify(actual[k] ?? null)}`);
  }
}

if (checked === 0) {
  // Zero checks passing vacuously is the failure mode this script exists to
  // avoid: it would report ALL PASS after someone reformatted every heading.
  console.log(`\nFAILURE — no pinned quotes found in ${DOC}. The heading format changed, or the doc moved.`);
  process.exit(1);
}

/* ── Half B: the prose pins ───────────────────────────────────────────────── */

const docText = doc.join("\n");
let prose = 0;

console.log("");
for (const pin of PROSE_PINS) {
  const label = `${pin.section} ${pin.cite} → ${pin.what}`;

  if (!docText.includes(pin.cite)) {
    // The registration handshake. A pin whose citation string has changed is
    // OUT of this table's coverage, and silently dropping it is how §2c got
    // wrong for two rounds. Fail, and say which side has to move.
    failed++;
    console.log(`FAIL  ${label}`);
    console.log(`        ${DOC} no longer contains the citation ${pin.cite}`);
    console.log(`        — either the doc renumbered it (update PROSE_PINS) or the pin was dropped`);
    continue;
  }

  if (!pin.bind.test(docText)) {
    // The number is in the doc, but not attached to the claim it is supposed
    // to carry — the round-1353 failure exactly. `cite` cannot see this.
    failed++;
    console.log(`FAIL  ${label}`);
    console.log(`        ${DOC} contains ${pin.cite}, but not bound to this claim`);
    console.log(`        expected the doc to match /${pin.bind.source}/`);
    continue;
  }

  const line = sourceLines(pin.path)[pin.line - 1];
  prose++;
  if (line !== undefined && pin.expect.test(line)) {
    console.log(`PASS  ${label}`);
    continue;
  }
  failed++;
  console.log(`FAIL  ${label}`);
  console.log(`        ${pin.path}:${pin.line} does not hold it`);
  console.log(`        expected /${pin.expect.source}/`);
  console.log(`        line is  ${JSON.stringify(line ?? null)}`);
}

if (prose === 0 && PROSE_PINS.length > 0) {
  console.log(`\nFAILURE — PROSE_PINS is declared but nothing in it resolved against ${DOC}.`);
  process.exit(1);
}

console.log(
  `\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — ${checked} fenced quote${checked === 1 ? "" : "s"} ` +
    `+ ${prose} prose pin${prose === 1 ? "" : "s"} in ${DOC} vs the working tree ` +
    `(NOT every pin in the doc — see SCOPE at the top of this file)`,
);
process.exit(failed === 0 ? 0 : 1);
