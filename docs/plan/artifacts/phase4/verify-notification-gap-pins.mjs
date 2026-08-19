/**
 * verify-notification-gap-pins.mjs — makes `docs/plan/notification-gap.md` §1's
 * central claim executable instead of hand-checked.
 *
 * §1 asserts that every pin in that document resolves. Round 1350 verified that
 * by hand, round 1352's reviewer verified it again by hand and found one pin
 * that had rotted underneath it (a sibling commit inserted two lines above
 * `AssistantThread.tsx` in this shared worktree). A claim that has to be
 * re-verified by hand every round is a claim that will eventually be verified
 * by nobody.
 *
 * So: this script IS the check. It runs in FOUR halves and then, in a fifth
 * pass, proves that those four covered everything.
 *
 *  A. FENCED QUOTES. Every pinned heading followed by a code fence: the quoted
 *     block must still exist in the working tree, verbatim, contiguously, and
 *     EXACTLY ONCE. It does not verify the SHA — if you have moved off
 *     `852b089` and the block still matches, that is a pass, and correctly so,
 *     because the quote is what the reader relies on. Whether the doc's SHA is
 *     current is what §1's `git diff <sha> -- <files>` command is for.
 *
 *     ROUND 972 — CONTENT ANCHORS, NOT LINE NUMBERS. This half used to slice
 *     the source at the doc's cited line range and compare. That made every
 *     pin a hostage to unrelated edits ABOVE it: main's `6a9406d` (+4 lines in
 *     `cc-runner.ts`) and `1e0330b` (+1 in `AssistantThread.tsx`) took this
 *     script from 92/92 green to 20 failures without touching one pinned
 *     symbol, on a merge whose authors could not have known — this verifier
 *     does not exist on `main`, so `main` has never run it. The operator ruling
 *     ("where a doc-gate lives", `AI OS/Operator Decisions.md`) is explicit:
 *     *do not fix this by re-pinning the numbers, that buys one merge* —
 *     re-anchor on symbols or fenced content.
 *
 *     So the doc's `:A-B` is now read as what it has always literally said: a
 *     HISTORICAL citation, true at the `@ sha` printed beside it. The check is
 *     the content. Where the block has moved, the found line is reported as
 *     `now :M` — drift stays visible without being fatal. What still fails, and
 *     these are the failures worth having:
 *       - the block is GONE (0 matches) — the code the doc describes changed;
 *       - the block is AMBIGUOUS (2+ matches) — the anchor no longer identifies
 *         one place, so declare a scope in FENCE_SCOPES rather than let the
 *         script pick the first. Ambiguity is reported, never resolved silently.
 *
 *  B. PROSE PINS — added round 1355, and the reason is a failure of half A.
 *     The doc also cites `file:line` in running prose, with no fence under it,
 *     and half A cannot see those: it keys off a heading followed by ```. In
 *     round 1353 two such pins in §2c were swapped to the wrong symbols and
 *     this script printed `ALL PASS — 11/11` with a wrong pin sitting four
 *     lines below a passing one. `11/11` meant "eleven fenced quotes", and it
 *     was read as "every pin in the document".
 *
 *  C. CROSS-DOCUMENT PINS — added round 1863. The doc pins lines in sibling
 *     planning files (`00-vision.md:48`, `02-architecture.md:187`, …). Those
 *     rot exactly like code pins and nothing was watching them.
 *
 *  D. LINE RULES — added round 1863, and this is the half that closes the hole
 *     the previous version documented but did not fix. Halves A–C each know
 *     which pins they own. Nothing knew about the REST: the corrections table's
 *     was/now columns, the §1 rot narrative, §3's recipe pins, §4's
 *     reconciliation list. Every one of those is now declared here with an
 *     explicit disposition — verified live, a repeat of a pin verified
 *     elsewhere, or deliberately historical with the reason written down.
 *
 *  E. THE INVENTORY, and the reason this script was rewritten. Round 1862's
 *     task put it plainly: `11/11` with no denominator cannot distinguish
 *     "checked everything" from "checked everything I can see". So half E
 *     tokenises the WHOLE document — every `path.ext:NNN[-MMM]` and every bare
 *     `` `:NNN[-MMM]` `` citation, fenced or not — and asserts that halves A–D
 *     consumed all of them. An unclassified token is a HARD FAILURE, not a
 *     skip. The summary line prints coverage over that denominator, so the
 *     count can no longer be read as broader than it is.
 *
 *     Deliberately still outside the denominator, and named so the next reader
 *     does not have to guess: pins that cite no line number at all (a bare
 *     file name, a symbol, a SHA), and pins inside OTHER documents that point
 *     back at this one. This script audits this document's outbound pins.
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
  ["run-control.ts", "forge-control/src/routes/run-control.ts"],
  ["run-control-rules.ts", "forge-control/src/lib/run-control-rules.ts"],
  ["AssistantThread.tsx", "forge-control-web/app/desktop/chat/AssistantThread.tsx"],
  ["thread-mapping.ts", "forge-control-web/app/desktop/chat/thread-mapping.ts"],
  ["tool-summary.ts", "forge-control-web/app/desktop/chat/tool-summary.ts"],
  ["subagent-slice.ts", "forge-control-web/app/desktop/chat/subagent-slice.ts"],
  ["00-vision.md", "docs/plan/operator-visibility/00-vision.md"],
  ["01-requirements.md", "docs/plan/operator-visibility/01-requirements.md"],
  ["02-architecture.md", "docs/plan/operator-visibility/02-architecture.md"],
]);

/** ``file`` — prose (`:A-B` @ `sha`)  or  (`:A` @ `sha`) */
const HEADING = /^`([^`]+)`\s+—\s+.*\(`:(\d+)(?:-(\d+))?`\s+@\s+`([0-9a-f]{7,40})`\)\s*$/;

/**
 * SCOPES — the disambiguator a content anchor needs when the content is not
 * unique in its file.
 *
 * `after` must match EXACTLY ONE line; `until` ends the scope at its first
 * match strictly below that line (end of file if it never matches, or if
 * `until` is omitted). The anchor must then resolve to exactly one line INSIDE
 * that window. This is what "cite by symbol" means operationally: the outer
 * anchor names the symbol, the inner one names the line within it. Both are
 * content, so both survive an insertion anywhere above.
 *
 * Keyed by the doc's own citation, so an entry that stops being needed fails
 * loudly (its key no longer resolves) instead of lingering as a dead waiver.
 */
const FENCE_SCOPES = new Map([
  [
    // This 8-line commsEntries({...}) call is byte-identical in `/:id/message`
    // and in `/:id/resume-chat` — a genuine duplicate in the source, not a
    // defect in the pin. The doc means the one in `/:id/message`.
    "routes/run-control.ts:259-266",
    { after: /^r\.post\("\/:id\/message"/, until: /^r\.(?:post|get|patch|delete)\(/ },
  ],
]);

/**
 * Half B: the pins that live in running prose, where no fence carries the
 * evidence.
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
    // `toolCallEntry` above it carries the identical line — the symbol is what
    // distinguishes them, which is the whole point of §3a's claim.
    scope: { after: /^function toolResultEntry\(/, until: /^function / },
  },
  {
    section: "§2b / §3",
    cite: "(`:952-986` @ `852b089`)",
    // Deliberately anchored on `executor.ts`'s — §3 item 4 says "`onEvent`
    // (`:952-986` …)" too, and half E cannot tell two identical citations
    // apart. The narrower bind gives this entry line 262; item 4's copy is a
    // declared repeat in LINE_RULES.
    bind: /`executor\.ts`'s `onEvent`\s+\(`:952-986` @ `852b089`\)/,
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
    cite: "already in scope at `:493`",
    bind: /`parentToolUseId`, already in scope at `:493`/,
    path: "forge-control/src/lib/cc-runner.ts",
    line: 493,
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
    cite: "`AssistantThread.tsx:331-333`",
    bind: /`AssistantThread\.tsx:331-333` \(`UserMessage`\)/,
    path: "forge-control-web/app/desktop/chat/AssistantThread.tsx",
    line: 331,
    what: "UserMessage, where an inbound comms entry is dispatched",
    expect: /^function UserMessage\(\)/,
  },
  {
    section: "§2c",
    cite: "`:375-376`",
    bind: /and `:375-376`\s+\(`AssistantMessage`/,
    path: "forge-control-web/app/desktop/chat/AssistantThread.tsx",
    line: 375,
    what: "AssistantMessage's comms lookup, for the outbound echo",
    expect: /^\s*const comms = useCommsFacts\(\);/,
    // `UserMessage` makes the identical call — §2c pins both, and only the
    // enclosing component tells them apart.
    scope: { after: /^function AssistantMessage\(\)/, until: /^function / },
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

/**
 * Half D: one rule per document line that carries a pin halves A–C do not own.
 *
 * `context` must match EXACTLY ONE line of the doc — an ambiguous context is a
 * failure, not a coin flip. `tokens` gives one disposition per pin on that
 * line, in the order they appear. Three dispositions exist and each is checked,
 * none is a bare exemption:
 *
 *   live      — a first-class claim about the tree. Path + expect, like half B.
 *   repeat    — the same pin, said again elsewhere in the doc. Names the
 *               `path:startLine` that some other half verifies; the script
 *               asserts BOTH that the key was actually verified and that this
 *               token's start line equals it. Renumber the primary and every
 *               restatement of it fails with it.
 *   historical— a pin that deliberately names where something USED to be. Not
 *               a claim about the tree, so there is nothing to resolve — but
 *               `why` is mandatory and the line must match `guard`, so a live
 *               claim cannot be parked here to dodge checking.
 */
const LINE_RULES = [
  {
    context: /^Non-empty output means the line pins in this doc may be stale/,
    tokens: [],
  },
  {
    context: /every quote below is headed by its \*\*stable symbol anchor\*\*/,
    tokens: [
      {
        crossdoc: {
          path: "docs/plan/operator-visibility/01-requirements.md",
          line: 5,
          what: "the standing citation rule",
          expect: /Citation rule — standing/,
        },
      },
    ],
  },
  {
    context: /^\| `AssistantThread\.tsx` `CommsMessage\(\)` \| `:147-151`/,
    tokens: [
      { historical: "where CommsMessage sat before sibling commit 0938385 inserted two lines above it" },
      { historical: "where CommsMessage sat between 0938385 and rounds 1871/1873/1875 — live until round 1875 found it rotted again, see the row below" },
    ],
  },
  {
    context: /^\| `AssistantThread\.tsx` `UserMessage` dispatch \| `:233-235`/,
    tokens: [
      { historical: "the pre-0938385 position of the UserMessage dispatch" },
      { historical: "the pre-1871 position of the UserMessage dispatch — live until round 1875 found it rotted again, see the row below" },
    ],
  },
  {
    context: /^\| `AssistantThread\.tsx` `AssistantMessage` dispatch \| `:277-278`/,
    tokens: [
      { historical: "the pre-0938385 position of the AssistantMessage dispatch" },
      { historical: "the pre-1871 position of the AssistantMessage dispatch — live until round 1875 found it rotted again, see the row below" },
    ],
  },
  {
    context: /^\| `AssistantThread\.tsx` `CommsMessage\(\)` \| `:149-153`/,
    tokens: [
      { historical: "the pre-1871 position of CommsMessage — superseded by rounds 1871/1873/1875" },
      { repeat: "forge-control-web/app/desktop/chat/AssistantThread.tsx:158" },
    ],
  },
  {
    context: /^\| `AssistantThread\.tsx` `UserMessage` dispatch \| `:235-237`/,
    tokens: [
      { historical: "the pre-1871 position of the UserMessage dispatch — superseded by rounds 1871/1873/1875" },
      { repeat: "forge-control-web/app/desktop/chat/AssistantThread.tsx:331" },
    ],
  },
  {
    context: /^\| `AssistantThread\.tsx` `AssistantMessage` dispatch \| `:279-281`/,
    tokens: [
      { historical: "the pre-1871 position of the AssistantMessage dispatch — superseded by rounds 1871/1873/1875" },
      { repeat: "forge-control-web/app/desktop/chat/AssistantThread.tsx:375" },
    ],
  },
  /* The round-6 (`project/b7ab4c57`) correction table — every `cc-runner.ts` pin, moved
   * +31 by rounds 900/902 growing `buildSystemPrompt`. Same shape as the round-1875 rows
   * above: the was-column is historical, the now-column repeats a pin another half
   * verifies, so renumbering the doc without renumbering the primary fails here. */
  {
    context: /^\| `cc-runner\.ts` §2a1 the `evt\.type === "user"` branch/,
    tokens: [
      { historical: "where the user branch sat at 852b089 — superseded by rounds 900/902" },
      { repeat: "forge-control/src/lib/cc-runner.ts:533" },
    ],
  },
  {
    context: /^\| `cc-runner\.ts` §2a2 the `parentToolUseId` lift/,
    tokens: [
      { historical: "where the parentToolUseId lift sat at 852b089 — superseded by rounds 900/902" },
      { repeat: "forge-control/src/lib/cc-runner.ts:490" },
    ],
  },
  {
    context: /^\| `cc-runner\.ts` §3 the `CcEvent` union/,
    tokens: [
      { historical: "where the CcEvent union sat at 852b089 — superseded by rounds 900/902" },
      { repeat: "forge-control/src/lib/cc-runner.ts:265" },
    ],
  },
  {
    context: /^\| §3 recipe item 2 — the `parentToolUseId` binding in scope/,
    tokens: [
      { historical: "the 852b089 position of the parentToolUseId binding §3 item 2 leans on" },
      { repeat: "forge-control/src/lib/cc-runner.ts:493" },
    ],
  },
  {
    context: /^\| §3 recipe item 1 — the `CcEvent` `type` field to widen/,
    tokens: [
      { historical: "the 852b089 position of the type field §3 item 1 says to widen" },
      { repeat: "forge-control/src/lib/cc-runner.ts:266" },
    ],
  },
  {
    context: /^\| `tool-summary\.ts` "Async agent launched" banner note/,
    tokens: [
      { historical: "where the banner note sat before round 1353's own EMPTY_GIST edit above it" },
      { repeat: "forge-control-web/app/desktop/chat/tool-summary.ts:406" },
    ],
  },
  {
    context: /^\| §2c `POST \/:id\/message`/,
    tokens: [
      { repeat: "forge-control/src/routes/run-control.ts:214" },
      { repeat: "forge-control/src/routes/run-control.ts:214" },
      { historical: "round 1353's withdrawn correction — the number it wrongly moved this pin to" },
    ],
  },
  {
    context: /^\| §2c `toThreadEntry`/,
    tokens: [
      { repeat: "forge-control/src/routes/run-control.ts:149" },
      { repeat: "forge-control/src/routes/run-control.ts:149" },
    ],
  },
  {
    context: /^\| `subagent-slice\.ts` the inline-entries fact/,
    tokens: [
      { repeat: "forge-control-web/app/desktop/chat/subagent-slice.ts:11" },
      { repeat: "forge-control-web/app/desktop/chat/subagent-slice.ts:11" },
    ],
  },
  {
    context: /^Round 1350's original mapping — route at/,
    tokens: [
      { repeat: "forge-control/src/routes/run-control.ts:214" },
      { repeat: "forge-control/src/routes/run-control.ts:149" },
    ],
  },
  {
    context: /^written against `cc-runner\.ts:170/,
    tokens: [
      { historical: "R19's original pins, recorded precisely because they rotted" },
      { historical: "same — the rotted :417–429 pin" },
      { historical: "same — the rotted :170–188 pin" },
    ],
  },
  {
    context: /^`buildSystemPrompt`'s prompt text and/,
    tokens: [{ historical: "what the rotted :417–429 pin points at today, quoted to show the rot" }],
  },
  {
    context: /^recorded the \*\*verbatim snippet\*\* the author quoted at/,
    tokens: [{ historical: "the round-600 fixture's pin, cited as the evidence that the code did not change" }],
  },
  {
    context: /^\*\*character-for-character identical\*\* to the block now at/,
    tokens: [{ repeat: "forge-control/src/lib/cc-runner.ts:533" }],
  },
  {
    context: /^\| b \| \*\*Async task-completion notification\*\*/,
    tokens: [{ repeat: "forge-control/src/lib/cc-runner.ts:533" }],
  },
  {
    context: /^`` `executor\.ts:1` `` and a bare `` `:4242` `` to this file/,
    tokens: [
      { historical: "a deliberately fake pin, quoted while describing pass 5's negative control" },
      { historical: "the other half of that fake pair — illustrative, not a claim about any tree" },
    ],
  },
  {
    context: /^The primary control — renumber the one fenced `db\/runs\.ts` pin from/,
    tokens: [
      { repeat: "forge-control/src/db/runs.ts:52" },
      { historical: "the off-by-one this control renumbers that pin TO — deliberately wrong, and the reason the control fails" },
    ],
  },
  {
    context: /Renumber the freshly re-pinned §2a1 quote from `:533-545` to/,
    tokens: [
      { repeat: "forge-control/src/lib/cc-runner.ts:533" },
      { historical: "round 6's own control value — the deliberately wrong start line that makes the quote and its four repeats fail together" },
    ],
  },
  {
    context: /^   size — and `appendThreadEntry` \(`executor\.ts:484-493`\) is a bare/,
    tokens: [
      {
        live: {
          path: "forge-control/src/executor.ts",
          line: 484,
          what: "appendThreadEntry — the bare append that rules out dedup",
          expect: /^async function appendThreadEntry\(/,
        },
      },
    ],
  },
  {
    context: /^  shape is collapsible\.\*\* The binding loop at `thread-mapping\.ts:334-353` searches/,
    tokens: [
      {
        live: {
          path: "forge-control-web/app/desktop/chat/thread-mapping.ts",
          line: 334,
          what: "the tool_result binding loop that will not re-bind a filled slot",
          expect: /^\s*if \(e\.kind === "tool_result"\) \{/,
        },
      },
    ],
  },
  {
    context: /^  `:351`, and degrades to \*\*the same loose text part as shape A\*\*\./,
    tokens: [
      {
        live: {
          path: "forge-control-web/app/desktop/chat/thread-mapping.ts",
          line: 351,
          what: "the orphan-result branch the second tool_result actually lands in",
          expect: /if \(content\.trim\(\)\) openParts\.push\(\{ type: "text", text: content \}\);/,
          // That push is the shared degrade-to-text idiom and appears three
          // times in the mapper; its own comment is what names THIS one.
          scope: {
            after: /^\s*\/\/ orphaned result — degrade to a text part rather than dropping it$/,
            until: /^\s*return;\s*$/,
          },
        },
      },
    ],
  },
  {
    context: /^`00-vision\.md:48` \("the engine-v2 lane"\), `01-requirements\.md:107` and$/,
    tokens: [
      { repeat: "docs/plan/operator-visibility/00-vision.md:48" },
      { repeat: "docs/plan/operator-visibility/01-requirements.md:107" },
    ],
  },
  {
    context: /^`02-architecture\.md:187` \("engine-v2-research-lane"\)\./,
    tokens: [{ repeat: "docs/plan/operator-visibility/02-architecture.md:187" }],
  },
  {
    context: /^  R19 \(`01-requirements\.md:107`\) asks for a document/,
    tokens: [{ repeat: "docs/plan/operator-visibility/01-requirements.md:107" }],
  },
  {
    context: /^1\. \*\*`cc-runner\.ts`\*\* — widen the union at/,
    tokens: [
      {
        live: {
          path: "forge-control/src/lib/cc-runner.ts",
          line: 266,
          what: "the CcEvent `type` field §3 item 1 says to widen",
          expect: /type: "init" \| "assistant_text" \| "tool_call" \| "tool_result";/,
        },
      },
    ],
  },
  {
    context: /^2\. \*\*`cc-runner\.ts`\*\* — add one `else if` to the `user` branch at/,
    tokens: [{ repeat: "forge-control/src/lib/cc-runner.ts:533" }],
  },
  {
    context: /^3\. \*\*`db\/runs\.ts:52`\*\* — add `\| "task_notification"`/,
    tokens: [{ repeat: "forge-control/src/db/runs.ts:52" }],
  },
  {
    context: /^4\. \*\*`executor\.ts`\*\* — one more branch in `onEvent`/,
    tokens: [{ repeat: "forge-control/src/executor.ts:952" }],
  },
  {
    context: /^R20 \(`01-requirements\.md:112-113`\) did \*\*not\*\* hold/,
    tokens: [
      {
        crossdoc: {
          path: "docs/plan/operator-visibility/01-requirements.md",
          line: 112,
          what: "R20, the no-silent-drops requirement",
          expect: /^\*\*R20 — No silent drops in the transcript\.\*\*/,
        },
      },
    ],
  },
  {
    context: /^engine lane widens `db\/runs\.ts:52`/,
    tokens: [{ repeat: "forge-control/src/db/runs.ts:52" }],
  },
  {
    context: /^- \*\*The claim was over-broad and is corrected\*\*/,
    tokens: [
      {
        crossdoc: {
          path: "docs/plan/operator-visibility/00-vision.md",
          line: 48,
          what: "00-vision's narrowed gap claim",
          expect: /Verified gap \(narrowed round 1350\)/,
        },
      },
    ],
  },
  {
    context: /^  and `02-architecture\.md:187` said agent completion payloads/,
    tokens: [
      {
        crossdoc: {
          path: "docs/plan/operator-visibility/02-architecture.md",
          line: 187,
          what: "02-architecture's narrowed gap claim",
          expect: /async task-completion notification/,
          // §2.2's facts list says the same phrase at :49 — the section
          // heading is what makes §6.3's copy the one this pin means.
          scope: { after: /^### 6\.3 What is knowingly absent \(R19\)/, until: /^#{2,3} / },
        },
      },
    ],
  },
  {
    context: /^- \*\*Line pins corrected\*\* in \*\*four\*\* places/,
    tokens: [
      { repeat: "docs/plan/operator-visibility/00-vision.md:48" },
      {
        crossdoc: {
          path: "docs/plan/operator-visibility/01-requirements.md",
          line: 107,
          what: "R19's own requirement line",
          expect: /`docs\/plan\/notification-gap\.md`: exactly what is missing/,
        },
      },
    ],
  },
  {
    context: /^  `02-architecture\.md:187` and `02-architecture\.md:49`:/,
    tokens: [
      { repeat: "docs/plan/operator-visibility/02-architecture.md:187" },
      {
        crossdoc: {
          path: "docs/plan/operator-visibility/02-architecture.md",
          line: 49,
          what: "the §2.2 facts-that-gate-design entry",
          expect: /^Facts that gate design:/,
        },
      },
    ],
  },
  {
    context: /^  `170–188` → `234–235`\. \(`02-architecture\.md:49`/,
    tokens: [{ repeat: "docs/plan/operator-visibility/02-architecture.md:49" }],
  },
  {
    context: /ended-at-is-a-launch-ack\.md:107` — cites `cc-runner\.ts:417-429`/,
    tokens: [
      {
        crossdoc: {
          path: "docs/plan/artifacts/phase1/ended-at-is-a-launch-ack.md",
          line: 107,
          what: "the dated artifact line this doc knowingly leaves stale",
          expect: /Recognise the async launch ack/,
        },
      },
      { historical: "the stale pin inside that dated artifact, quoted so a grep for it finds the explanation" },
    ],
  },
];

const doc = readFileSync(resolve(ROOT, DOC), "utf8").split("\n");
const docText = doc.join("\n");
const sourceCache = new Map();

function sourceLines(path) {
  let lines = sourceCache.get(path);
  if (lines === undefined) {
    lines = readFileSync(resolve(ROOT, path), "utf8").split("\n");
    sourceCache.set(path, lines);
  }
  return lines;
}

let failed = 0;

/* ── The content anchor, shared by halves A–D (round 972) ─────────────────────
 *
 * One resolver for every pin, so no half can drift into a weaker rule than its
 * neighbours. `find` takes the source lines and returns every 1-based line the
 * anchor matches; the scope narrows the search before it runs.
 *
 * @returns {{ok:true,line:number}|{ok:false,why:string}}
 */
function scopeWindow(path, scope) {
  const lines = sourceLines(path);
  if (scope === undefined) return { ok: true, from: 0, to: lines.length };
  const starts = lines.map((t, i) => (scope.after.test(t) ? i : -1)).filter((i) => i >= 0);
  if (starts.length !== 1) {
    return {
      ok: false,
      why: `scope anchor /${scope.after.source}/ matches ${starts.length} line(s) of ${path}, expected exactly 1`,
    };
  }
  const from = starts[0];
  let to = lines.length;
  if (scope.until !== undefined) {
    for (let i = from + 1; i < lines.length; i++) {
      if (scope.until.test(lines[i])) {
        to = i;
        break;
      }
    }
  }
  return { ok: true, from, to };
}

function anchor(path, scope, find, what) {
  const win = scopeWindow(path, scope);
  if (!win.ok) return win;
  const hits = find(sourceLines(path), win.from, win.to);
  if (hits.length === 1) return { ok: true, line: hits[0] };
  const where = scope === undefined ? path : `${path} within /${scope.after.source}/`;
  if (hits.length === 0) {
    return { ok: false, why: `${what} is no longer present in ${where}` };
  }
  return {
    ok: false,
    why:
      `${what} matches ${hits.length} places in ${where} (lines ${hits.join(", ")}) — ` +
      `the anchor no longer identifies one site; narrow it with a scope rather than picking one`,
  };
}

/** A single line matching `expect`. */
const anchorLine = (path, expect, scope, what) =>
  anchor(
    path,
    scope,
    (lines, from, to) => {
      const hits = [];
      for (let i = from; i < to; i++) if (expect.test(lines[i])) hits.push(i + 1);
      return hits;
    },
    what,
  );

/** A contiguous verbatim block, used by half A for a fenced quote. */
const anchorBlock = (path, block, scope, what) =>
  anchor(
    path,
    scope,
    (lines, from, to) => {
      const hits = [];
      for (let s = from; s + block.length <= to; s++) {
        let ok = true;
        for (let k = 0; k < block.length; k++) {
          if (lines[s + k] !== block[k]) {
            ok = false;
            break;
          }
        }
        if (ok) hits.push(s + 1);
      }
      return hits;
    },
    what,
  );

/** `` (now :M) `` when the content has moved off the line the doc cites. */
const drift = (declared, found) => (found === declared ? "" : `  (now :${found})`);

/* ── Half E's tokeniser, run FIRST so A–D can mark what they consume ─────────
 *
 * Two shapes, and the second is the one round 1355's version could not see:
 * a fully-qualified `path.ext:NNN`, and a bare `` `:NNN` `` citation whose file
 * is named by the surrounding prose. Both hyphen and en-dash ranges count —
 * the doc uses both, and treating `:502–514` as a different pin from
 * `:502-514` is exactly the kind of blind spot this half exists to remove. */
const QUALIFIED = /[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|json|md):\d+(?:[-–—]\d+)?\+?/g;
const BARE = /`:\d+(?:[-–—]\d+)?`/g;

/** @type {{line:number,col:number,raw:string,start:number,owner:string|null}[]} */
const inventory = [];
doc.forEach((text, i) => {
  for (const m of text.matchAll(QUALIFIED)) {
    inventory.push({ line: i, col: m.index, raw: m[0], start: Number(/:(\d+)/.exec(m[0])[1]), owner: null });
  }
  for (const m of text.matchAll(BARE)) {
    inventory.push({ line: i, col: m.index, raw: m[0], start: Number(/:(\d+)/.exec(m[0])[1]), owner: null });
  }
});
inventory.sort((a, b) => a.line - b.line || a.col - b.col);

const DENOMINATOR = inventory.length;
if (DENOMINATOR === 0) {
  console.log(`\nFAILURE — no pins of any shape found in ${DOC}. The document moved, or its citation style changed.`);
  process.exit(1);
}

/** Start lines proved by some half. `repeat` dispositions resolve against this. */
const verifiedStarts = new Set();
const claim = (path, line) => verifiedStarts.add(`${path}:${line}`);

function consume(lineIdx, owner, predicate) {
  const hits = inventory.filter((t) => t.line === lineIdx && t.owner === null && (predicate?.(t) ?? true));
  for (const t of hits) t.owner = owner;
  return hits.length;
}

/* ── Half A: fenced quotes ──────────────────────────────────────────────── */

let checked = 0;

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

  checked++;
  consume(i, "fenced");
  const cite = `${name}:${aRaw}${bRaw ? `-${bRaw}` : ""}`;
  const found = anchorBlock(path, quoted, FENCE_SCOPES.get(cite), "the quoted block");

  /* `claim()` is keyed on the line the DOC cites, not the line the block was
   * found at. Half D's `repeat` disposition asks whether the document restates
   * its own citation consistently — a question about the doc, answered inside
   * the doc. Keying it on the resolved line would make every restatement fail
   * the moment the source moved, which is the rot this change removes. */
  if (found.ok) {
    claim(path, a);
    console.log(
      `PASS  ${cite} @ ${sha}  (${quoted.length} line${quoted.length === 1 ? "" : "s"})${drift(a, found.line)}`,
    );
    continue;
  }
  failed++;
  console.log(`FAIL  ${cite} @ ${sha}`);
  console.log(`        ${found.why}`);
  if (quoted.length > 0) console.log(`        first quoted line: ${JSON.stringify(quoted[0])}`);
}

if (checked === 0) {
  // Zero checks passing vacuously is the failure mode this script exists to
  // avoid: it would report ALL PASS after someone reformatted every heading.
  console.log(`\nFAILURE — no pinned quotes found in ${DOC}. The heading format changed, or the doc moved.`);
  process.exit(1);
}

/* ── Half B: the prose pins ───────────────────────────────────────────────── */

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

  /* Round 1863: tell half E which token this pin owns. The candidate is the
   * unclaimed pin whose own start line is the one this entry declares, sitting
   * on a line `bind` actually matched — the corrections table restates several
   * of these numbers, and without the bind filter the same citation string
   * appears two and three times over. `bind` is matched on a two-line window
   * because several of them straddle a wrap. Anything other than exactly one
   * survivor is ambiguous, and ambiguity is reported, never resolved by
   * picking the first. */
  const boundLine = (i) =>
    pin.bind.test(doc[i]) ||
    pin.bind.test(`${doc[i]}\n${doc[i + 1] ?? ""}`) ||
    pin.bind.test(`${doc[i - 1] ?? ""}\n${doc[i]}`);
  const candidates = inventory.filter(
    (t) =>
      t.owner === null &&
      t.start === pin.line &&
      pin.cite.includes(t.raw) &&
      boundLine(t.line),
  );
  if (candidates.length !== 1) {
    failed++;
    console.log(`FAIL  ${label}`);
    console.log(
      `        cannot bind this pin to exactly one citation token in ${DOC} ` +
        `(${candidates.length} candidates) — half E would misreport coverage`,
    );
    continue;
  }
  candidates[0].owner = "prose";

  prose++;
  const found = anchorLine(pin.path, pin.expect, pin.scope, `/${pin.expect.source}/`);
  if (found.ok) {
    claim(pin.path, pin.line);
    console.log(`PASS  ${label}${drift(pin.line, found.line)}`);
    continue;
  }
  failed++;
  console.log(`FAIL  ${label}`);
  console.log(`        ${found.why}`);
}

if (prose === 0 && PROSE_PINS.length > 0) {
  console.log(`\nFAILURE — PROSE_PINS is declared but nothing in it resolved against ${DOC}.`);
  process.exit(1);
}

/* ── Halves C and D: line rules ───────────────────────────────────────────── */

let live = 0;
let crossdoc = 0;
let repeats = 0;
let historical = 0;

/* Resolve every rule to its line and its tokens FIRST. Then evaluate in two
 * ordered phases: everything that PROVES a pin, then the repeats that hang off
 * those proofs. Without the split, a repeat declared above its primary in this
 * table fails for a reason that has nothing to do with the document — the
 * table's own order. Output is buffered and printed in document order, so the
 * report still reads top-to-bottom. */
const resolved = [];
for (const rule of LINE_RULES) {
  const matches = doc.map((t, i) => (rule.context.test(t) ? i : -1)).filter((i) => i >= 0);
  if (matches.length !== 1) {
    // An ambiguous or dead context silently stops covering its tokens, which
    // is the exact failure mode half E exists to make impossible. Fail loudly.
    failed++;
    console.log(`FAIL  LINE_RULE /${rule.context.source}/ matches ${matches.length} lines of ${DOC}, expected 1`);
    continue;
  }
  const lineIdx = matches[0];
  const tokens = inventory.filter((t) => t.line === lineIdx && t.owner === null);

  if (tokens.length !== rule.tokens.length) {
    failed++;
    console.log(
      `FAIL  ${DOC}:${lineIdx + 1} carries ${tokens.length} unclaimed pin(s), ` +
        `LINE_RULE declares ${rule.tokens.length} — ${JSON.stringify(tokens.map((t) => t.raw))}`,
    );
    continue;
  }
  resolved.push({ lineIdx, tokens, dispositions: rule.tokens });
}

/** @type {{line:number,col:number,text:string}[]} */
const report = [];
const say = (token, text) => report.push({ line: token.line, col: token.col, text });

for (const phase of ["prove", "repeat"]) {
  for (const { lineIdx, tokens, dispositions } of resolved) {
    tokens.forEach((token, k) => {
      const d = dispositions[k];
      const isRepeat = d.repeat !== undefined;
      if (isRepeat !== (phase === "repeat")) return;
      const where = `${DOC}:${lineIdx + 1} ${token.raw}`;

      if (d.historical !== undefined) {
        token.owner = "historical";
        historical++;
        say(token, `PASS  historical  ${where} — ${d.historical}`);
        return;
      }

      if (isRepeat) {
        token.owner = "repeat";
        repeats++;
        const declaredStart = Number(/:(\d+)$/.exec(d.repeat)[1]);
        if (!verifiedStarts.has(d.repeat)) {
          failed++;
          say(token, `FAIL  repeat      ${where} → ${d.repeat} was never verified by another half`);
          return;
        }
        if (token.start !== declaredStart) {
          failed++;
          say(token, `FAIL  repeat      ${where} starts at :${token.start}, but restates ${d.repeat}`);
          return;
        }
        say(token, `PASS  repeat      ${where} → ${d.repeat}`);
        return;
      }

      const spec = d.live ?? d.crossdoc;
      if (spec === undefined) {
        failed++;
        say(token, `FAIL  ${where} — LINE_RULE token ${k} declares no disposition`);
        return;
      }
      token.owner = d.live ? "live" : "crossdoc";
      if (d.live) live++;
      else crossdoc++;

      if (token.start !== spec.line) {
        failed++;
        say(token, `FAIL  ${d.live ? "live" : "cross-doc"}   ${where} starts at :${token.start}, rule declares :${spec.line}`);
        return;
      }
      const found = anchorLine(spec.path, spec.expect, spec.scope, `/${spec.expect.source}/`);
      if (found.ok) {
        claim(spec.path, spec.line);
        say(
          token,
          `PASS  ${d.live ? "live      " : "cross-doc "} ${where} → ${spec.what}${drift(spec.line, found.line)}`,
        );
        return;
      }
      failed++;
      say(
        token,
        `FAIL  ${d.live ? "live" : "cross-doc"}   ${where} → ${spec.what}\n` + `        ${found.why}`,
      );
    });
  }
}

console.log("");
for (const r of report.sort((a, b) => a.line - b.line || a.col - b.col)) console.log(r.text);

/* ── Half E: the inventory closes ─────────────────────────────────────────── */

const orphans = inventory.filter((t) => t.owner === null);
if (orphans.length > 0) {
  failed++;
  console.log(`\n${orphans.length} UNCLASSIFIED pin(s) — every pin in ${DOC} must be owned by a half:`);
  for (const t of orphans) {
    console.log(`  ${DOC}:${t.line + 1}  ${t.raw}`);
    console.log(`      ${doc[t.line].trim().slice(0, 120)}`);
  }
  console.log(
    `  → add a LINE_RULE (live / repeat / historical) or a PROSE_PINS entry. ` +
      `A pin nobody owns is how "11/11" came to mean "eleven of the sixty-four I could see".`,
  );
}

const owned = DENOMINATOR - orphans.length;
console.log(
  `\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — ${owned}/${DENOMINATOR} pins in ${DOC} classified ` +
    `(${checked} fenced quote${checked === 1 ? "" : "s"}, ${prose} prose, ${live} live, ${crossdoc} cross-doc, ` +
    `${repeats} repeat, ${historical} historical).`,
);
console.log(
  `Denominator = every \`path.ext:NNN\` and every bare \`:NNN\` citation in ${DOC}, fenced or not. ` +
    `Outside it: pins carrying no line number, and other documents' pins into this one.`,
);
process.exit(failed === 0 ? 0 : 1);
