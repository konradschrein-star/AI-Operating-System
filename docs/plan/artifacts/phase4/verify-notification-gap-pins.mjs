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
 * SCOPE, deliberately narrow: it verifies that the QUOTES match the PINS in the
 * working tree. It does not verify the SHA — if you have moved off `852b089`
 * and the lines still match, that is a pass, and correctly so, because the
 * quote is what the reader relies on. Whether the doc's SHA is current is what
 * §1's `git diff <sha> -- <files>` command is for. The two together are the
 * whole guarantee.
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

console.log(
  `\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — ${checked} pinned quote${checked === 1 ? "" : "s"} in ${DOC} vs the working tree`,
);
process.exit(failed === 0 ? 0 : 1);
