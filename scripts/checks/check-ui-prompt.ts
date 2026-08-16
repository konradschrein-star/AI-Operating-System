/**
 * check-ui-prompt.ts — round 950's gate: the prompts that TEACH the `forge:ui`
 * format must agree, field for field, with the validator that JUDGES it.
 *
 * Round 808 shipped the renderer and the closed schema
 * (forge-control-web/app/desktop/chat/rich-blocks.ts) and put the format in no
 * agent prompt, so nothing ever emitted a control. Round 950 writes the format
 * into two prompts. That creates a failure mode the renderer alone cannot have:
 * a prompt that teaches a SLIGHTLY WRONG shape does not fail quietly — the
 * agent emits a block, validation rejects it, and Konrad gets a visible
 * "unreadable control block" in his chat where a button should have been.
 *
 * So this check does not eyeball the prose. It takes the REAL prompt strings
 * the engine ships, runs them through the REAL fence scanner and the REAL
 * validator, and fails on any block the renderer would refuse:
 *
 *  §1 EVERY worked example in EVERY prompt parses. `splitRichSegments` is the
 *     same function the transcript calls, so a `forge:ui` fence that the
 *     scanner does not even recognise as a block (the four-space-indent trap —
 *     `FENCE` allows at most three) fails here as a MISSING example rather
 *     than passing as prose nobody noticed.
 *
 *  §2 The documented CAPS are the validator's caps. The prompts quote concrete
 *     numbers ("max 400", "1–12 entries"); those numbers are asserted against
 *     `LIMITS` and against the two character classes, so moving a cap in
 *     rich-blocks.ts without rewriting the prompt text turns this check red
 *     instead of silently teaching a stale bound.
 *
 *  §3 A hand-written block of the documented shape parses, and the near-miss
 *     mutations of it are REJECTED — proof the schema is closed and the
 *     examples are not passing by accident.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch. Same shape as
 * check-chat-rich.tsx, deliberately. rich-blocks.ts is pure and React-free, so
 * unlike that file this one needs no JSX tsconfig.
 *
 * Run:
 *   forge-control/node_modules/.bin/tsx scripts/checks/check-ui-prompt.ts
 */

import { buildSystemPrompt } from "../../forge-control/src/lib/cc-runner.ts";
import { MANAGER_COMMS } from "../../forge-control/src/lib/project-tick.ts";
import {
  LIMITS,
  parseUiBlock,
  splitRichSegments,
  type RichSegment,
  type UiBlock,
} from "../../forge-control-web/app/desktop/chat/rich-blocks.ts";

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  ok(
    actual === expected,
    label,
    actual === expected ? undefined : `expected ${String(expected)}, got ${String(actual)}`,
  );
}

/* ── §1  Every worked example in every shipped prompt parses ───────────────
 *
 * The prompts are taken from the functions the engine actually calls, not
 * re-pasted here: a copy would drift from the source the day someone edits one
 * and not the other, which is the exact class of bug this file exists to catch.
 */

interface PromptCase {
  label: string;
  source: string;
  /** The block kinds the prompt is required to demonstrate, in order. */
  expect: readonly UiBlock["kind"][];
}

const PROMPTS: readonly PromptCase[] = [
  {
    label: "operator system prompt (vault access)",
    source: buildSystemPrompt(true),
    expect: ["choice", "secret"],
  },
  {
    label: "operator system prompt (no vault access)",
    source: buildSystemPrompt(false),
    expect: ["choice", "secret"],
  },
  {
    label: "MANAGER_COMMS (builder — non-verdict role)",
    source: MANAGER_COMMS("bfd1283a-b71b-4f35-b577-7d09aad803f2", "builder"),
    expect: ["choice", "secret"],
  },
  {
    label: "MANAGER_COMMS (reviewer — verdict role, longer tail)",
    source: MANAGER_COMMS("bfd1283a-b71b-4f35-b577-7d09aad803f2", "reviewer"),
    expect: ["choice", "secret"],
  },
];

console.log("§1  worked examples parse through the real scanner + validator");
for (const prompt of PROMPTS) {
  const segments: RichSegment[] = splitRichSegments(prompt.source);
  const ui = segments.filter((s): s is Extract<RichSegment, { kind: "ui" }> => s.kind === "ui");
  const invalid = segments.filter(
    (s): s is Extract<RichSegment, { kind: "invalid" }> => s.kind === "invalid",
  );

  /* An invalid segment IS the bug being hunted: it means the prompt ships a
   * block the renderer would draw as "unreadable control block". Print the
   * reason, because that reason is the fix. */
  ok(
    invalid.length === 0,
    `${prompt.label}: no invalid blocks`,
    invalid.length === 0
      ? undefined
      : invalid.map((s) => `reason: ${s.reason}\n      raw: ${s.raw.slice(0, 160)}`).join("\n      "),
  );

  eq(ui.length, prompt.expect.length, `${prompt.label}: example count`);
  prompt.expect.forEach((kind, i) => {
    eq(ui[i]?.block.kind, kind, `${prompt.label}: example ${i + 1} is a ${kind}`);
  });

  console.log(
    `  ${prompt.label}: ${ui.length} block(s) [${ui.map((s) => s.block.kind).join(", ")}], ${invalid.length} invalid`,
  );
}

/* Both prompts must actually name the fence, otherwise §1 would pass happily on
 * a prompt that documented nothing at all. */
for (const prompt of PROMPTS) {
  ok(prompt.source.includes("```forge:ui"), `${prompt.label}: names the forge:ui fence`);
}

/* ── §2  The documented caps ARE the validator's caps ──────────────────────
 *
 * Each entry: the number the prompt prose quotes, and the LIMITS field it
 * claims to be quoting. If rich-blocks.ts moves a cap, this fails rather than
 * letting the prompt teach a bound the validator no longer enforces.
 */

console.log("\n§2  documented caps agree with LIMITS");
const CAPS: readonly { field: keyof typeof LIMITS; documented: number }[] = [
  { field: "options", documented: 12 },
  { field: "valueChars", documented: 400 },
  { field: "labelChars", documented: 80 },
  { field: "hintChars", documented: 160 },
  { field: "promptChars", documented: 400 },
  { field: "secretNameChars", documented: 64 },
  { field: "whyChars", documented: 400 },
  { field: "idChars", documented: 64 },
];
for (const cap of CAPS) {
  eq(LIMITS[cap.field], cap.documented, `LIMITS.${cap.field} is the documented ${cap.documented}`);
}

/* The character classes the prompts spell out verbatim. Asserted by BEHAVIOUR
 * against the validator rather than by re-declaring the regexes, so this cannot
 * drift into testing a copy of the rule instead of the rule. */
const nameLegal = parseUiBlock('{"kind":"secret","name":"A.z_0-9"}');
ok(nameLegal.ok, "secret name accepts the documented [A-Za-z0-9._-]");
const nameIllegal = parseUiBlock('{"kind":"secret","name":"has space"}');
ok(!nameIllegal.ok, "secret name rejects a character outside the documented class");
const idLegal = parseUiBlock('{"kind":"choice","id":"a.b:c-d_1","options":["x"]}');
ok(idLegal.ok, "choice id accepts the documented [A-Za-z0-9._:-]");
const idIllegal = parseUiBlock('{"kind":"choice","id":"a b","options":["x"]}');
ok(!idIllegal.ok, "choice id rejects a character outside the documented class");

/* ── §3  A hand-written block of the documented shape, and its near misses ──
 *
 * §1 proves the examples IN the prompts parse. This proves the SHAPE the prose
 * describes parses when written fresh by someone reading only that prose — and
 * that the schema stays closed around it.
 */

console.log("\n§3  hand-written block of the documented shape");
const HAND_WRITTEN = `{"kind":"choice","id":"deploy-target","prompt":"Which host should take the migration?","multiple":false,"options":[
  {"value":"vps1","label":"VPS1","hint":"65.108.6.149 — current"},
  {"value":"vps2","label":"VPS2","hint":"167.233.145.218 — 16 GB, idle"},
  "neither, stay put"]}`;

const hand = parseUiBlock(HAND_WRITTEN);
ok(hand.ok, "hand-written choice parses", hand.ok ? undefined : `reason: ${hand.reason}`);
if (hand.ok && hand.block.kind === "choice") {
  eq(hand.block.options.length, 3, "hand-written choice keeps all three options");
  eq(hand.block.id, "deploy-target", "hand-written choice keeps its id");
  eq(hand.block.multiple, false, "hand-written choice is single-select");
  /* The bare-string option documented as allowed: label defaults to value. */
  eq(hand.block.options[2]?.label, "neither, stay put", "bare string option labels itself");
  eq(hand.block.options[2]?.hint, null, "bare string option has no hint");
  eq(hand.block.options[0]?.hint, "65.108.6.149 — current", "object option keeps its hint");
}

const HAND_SECRET = `{"kind":"secret","name":"OPENAI_API_KEY","why":"needed to run the batch re-tag"}`;
const secret = parseUiBlock(HAND_SECRET);
ok(secret.ok, "hand-written secret parses", secret.ok ? undefined : `reason: ${secret.reason}`);
if (secret.ok && secret.block.kind === "secret") {
  eq(secret.block.name, "OPENAI_API_KEY", "hand-written secret keeps its name");
  eq(secret.block.why, "needed to run the batch re-tag", "hand-written secret keeps its why");
}

/* Near misses: each is a shape the prompt could plausibly have taught wrong.
 * All must be REFUSED — a schema that accepts these is not the closed one the
 * security property depends on. */
console.log("\n§3b near misses are refused");
const NEAR_MISSES: readonly { label: string; raw: string }[] = [
  { label: "unknown kind", raw: '{"kind":"confirm","options":["yes"]}' },
  { label: "no kind", raw: '{"options":["yes"]}' },
  { label: "choice with no options", raw: '{"kind":"choice","prompt":"pick"}' },
  { label: "choice with empty options", raw: '{"kind":"choice","options":[]}' },
  {
    label: `choice with ${LIMITS.options + 1} options`,
    raw: JSON.stringify({
      kind: "choice",
      options: Array.from({ length: LIMITS.options + 1 }, (_, i) => `o${i}`),
    }),
  },
  { label: "option object missing value", raw: '{"kind":"choice","options":[{"label":"VPS1"}]}' },
  {
    label: `label over ${LIMITS.labelChars}`,
    raw: JSON.stringify({
      kind: "choice",
      options: [{ value: "v", label: "x".repeat(LIMITS.labelChars + 1) }],
    }),
  },
  { label: "secret with no name", raw: '{"kind":"secret","why":"because"}' },
  { label: "multiple as a string", raw: '{"kind":"choice","multiple":"yes","options":["a"]}' },
  { label: "a JSON array, not an object", raw: '[{"kind":"choice","options":["a"]}]' },
  { label: "not JSON at all", raw: "kind: choice" },
];
for (const miss of NEAR_MISSES) {
  const r = parseUiBlock(miss.raw);
  ok(!r.ok, `refused: ${miss.label}`, r.ok ? "PARSED — schema is not closed" : undefined);
}

/* The four-space-indent trap, asserted rather than trusted: `FENCE` allows at
 * most three leading spaces, so an indented example teaches a block that never
 * becomes one. This is why the prompts put their fences at column 0. */
console.log("\n§3c the indent trap the prompts avoid");
const INDENTED = ['    ```forge:ui', '    {"kind":"choice","options":["a"]}', "    ```"].join("\n");
const indentedSegs = splitRichSegments(INDENTED);
ok(
  indentedSegs.every((s) => s.kind === "markdown"),
  "a four-space-indented forge:ui fence is NOT a control block (so prompts must not indent theirs)",
);
const COLUMN0 = ['```forge:ui', '{"kind":"choice","options":["a"]}', "```"].join("\n");
ok(
  splitRichSegments(COLUMN0).some((s) => s.kind === "ui"),
  "the same block at column 0 IS a control block",
);

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} ${checks - failures}/${checks} assertions`,
);
process.exit(failures === 0 ? 0 : 1);
