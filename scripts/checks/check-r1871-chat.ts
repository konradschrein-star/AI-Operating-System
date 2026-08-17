/**
 * check-r1871-chat.ts — the round-1871 client-side fixes, as assertions.
 *
 * Round 1870's customer test returned twelve findings. Five of them are pure
 * functions on this side of the wire, and this file is what stops each from
 * coming back:
 *
 *   FINDING 2  agent comms are a wall of text — 117 cards, 0 collapse
 *              controls, peer rendered as a raw uuid + "unknown role".
 *              → `commsPreview` (the one-line skim) and `commsHeader().name`
 *                (a name instead of eight hex characters).
 *   FINDING 10 machinery leaking into prose — an assistant bubble whose whole
 *              body is `{"queued":true,"delivery":"next-turn","echo":true}`.
 *              → `readControlEnvelope`, and — just as important — everything
 *                it must REFUSE, because a false positive here swallows
 *                something an agent actually said.
 *   FINDING 5  the "n/a" that replaces a lying `0`.
 *              → `tokensMeasured`, including its pre-1871-server default.
 *
 * The nav-stack half of finding 10 (`sub-agent toolu_01`) is asserted in
 * check-nav-stack.ts, next to the crumb logic it belongs to; the effort-ramp
 * half of finding 11 is in check-composer-v3.ts for the same reason.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-r1871-chat.ts
 */

import {
  commsHeader,
  commsPreview,
  COMMS_PREVIEW_CHARS,
  type CommsFacts,
} from "../../forge-control-web/app/desktop/chat/comms-identity";
import { readControlEnvelope } from "../../forge-control-web/app/desktop/chat/machinery";
import {
  tokensMeasured,
  NOT_RECORDED,
  type TeamNode,
} from "../../forge-control-web/app/desktop/team/teamApi";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 2 — the collapsed comms card
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── commsPreview: the one line you skim ──────────────────────");

/** The real payload from the card in `52-comms-cards-dark.png`. */
const REAL_REPORT =
  "Phase 800 planned (rounds 801-805, 6 builders + 1 adversarial reviewer). " +
  "One decision the brief did not cover: the chat surface is already at 39-40 " +
  "req/min against the <=40 ceiling.";

check(
  "a report previews as its first sentence",
  commsPreview(REAL_REPORT).startsWith("Phase 800 planned (rounds 801-805"),
  true,
);
check(
  "the preview fits the budget",
  commsPreview(REAL_REPORT).length <= COMMS_PREVIEW_CHARS,
  true,
);
check("a long preview is elided, not cut mid-air", commsPreview(REAL_REPORT).endsWith("…"), true);
check("a short body is not elided", commsPreview("ack"), "ack");
check(
  "a markdown heading previews as its words, not its hashes",
  commsPreview("## Phase 800 planned\n\nbody"),
  "Phase 800 planned",
);
check(
  "a leading blank line is skipped",
  commsPreview("\n\n   \nthe first real line"),
  "the first real line",
);
check("a leading fence is skipped", commsPreview("```ts\nconst x = 1;"), "const x = 1;");
check("a bullet previews without its marker", commsPreview("- did the thing"), "did the thing");
check("a numbered item too", commsPreview("3. did the thing"), "did the thing");
check("inline emphasis is flattened", commsPreview("**bold** and `code`"), "bold and code");
check("an empty body says so rather than rendering blank", commsPreview(""), "(empty)");
check("whitespace only says so too", commsPreview("   \n\t\n "), "(empty)");
check("a non-string cannot throw on the render path", commsPreview(null as never), "(empty)");

console.log("\n── commsHeader: a NAME, not eight hex characters ────────────");

const inbound: CommsFacts = {
  direction: "in",
  from: "worker",
  peerRunId: "c8bc5ffa-0000-4000-8000-000000000001",
  peerRole: null,
  subagentId: null,
};

check(
  "THE BUG: with nothing known, the card led with the short id",
  commsHeader(inbound).name,
  "c8bc5ffa",
);
check(
  "a role alone is already better than the id",
  commsHeader(inbound, { role: "builder", description: null }).name,
  "builder",
);
check(
  "THE FIX: the peer's task title wins when the team cache has it",
  commsHeader(inbound, { role: "builder", description: "Fix cycle 1" }).name,
  "Fix cycle 1",
);
check(
  "the server's own stamp still outranks the cache for the ROLE",
  commsHeader({ ...inbound, peerRole: "reviewer" }, { role: "builder", description: null }).role,
  "reviewer",
);
check("konrad is named, never role-guessed", commsHeader({ ...inbound, from: "konrad" }).name, "konrad");
check(
  "the legacy string fallback still works (check-chat-rich calls it that way)",
  commsHeader(inbound, "planner").role,
  "planner",
);
check(
  "the short id stays reachable on the expanded card",
  commsHeader(inbound, { role: "builder", description: "Fix cycle 1" }).peer,
  "c8bc5ffa",
);
check(
  "a peer with no run id at all still gets a name",
  commsHeader({ ...inbound, peerRunId: null }).name,
  "worker",
);
check("direction still drives the glyph", commsHeader(inbound).arrow, "◂");
check(
  "…and the outbound half is the other one",
  commsHeader({ ...inbound, direction: "out" }).arrow,
  "▸",
);

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 10 — a receipt is not prose
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── readControlEnvelope: what it catches ─────────────────────");

const REAL_ENVELOPE = '{"queued":true,"delivery":"next-turn","echo":true}';
const caught = readControlEnvelope(REAL_ENVELOPE);
check("the exact bubble from the screenshot is recognised", caught !== null, true);
check(
  "…and reads as English",
  caught?.label,
  "message queued · will be delivered on the agent's next turn · echoed into this transcript",
);
check("…with the original kept byte-for-byte", caught?.raw, REAL_ENVELOPE);
check(
  "surrounding whitespace does not hide it",
  readControlEnvelope(`\n  ${REAL_ENVELOPE}  \n`) !== null,
  true,
);
check(
  "a terminate receipt too",
  readControlEnvelope('{"terminating":true}')?.label,
  "terminate accepted",
);
check(
  "an unfamiliar control envelope still reads as a receipt, not as JSON",
  readControlEnvelope('{"queued":true,"weather":"fine"}')?.label,
  "message queued",
);

console.log("\n── …and everything it must REFUSE ───────────────────────────");

const mustBeProse: Array<[string, string]> = [
  ["ordinary prose", "Round 0 closed. Corpus at 0ea9d28, pushed to origin."],
  [
    "prose that merely mentions an envelope",
    'The API answered {"queued":true} — so the message is on its way.',
  ],
  ["a JSON array", '[{"queued":true}]'],
  ["a nested payload — it might be an answer", '{"queued":true,"run":{"id":"abc"}}'],
  ["an object with no control key", '{"name":"builder","round":1871}'],
  ["an empty object", "{}"],
  ["a code fence around it", '```json\n{"queued":true}\n```'],
  ["malformed JSON", '{"queued":true,'],
  ["an object with too many keys to be an envelope", JSON.stringify(Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [i === 0 ? "queued" : `k${i}`, true]),
  ))],
];
for (const [label, text] of mustBeProse) {
  check(`refuses: ${label}`, readControlEnvelope(text), null);
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 5 — "n/a" is not "0"
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── tokensMeasured: zero vs unknown ──────────────────────────");

const node = (over: Partial<TeamNode>): TeamNode =>
  ({
    id: "toolu_01AeuQskZPyHpsYrHayvrqrT",
    kind: "subagent",
    role: "architect",
    model: null,
    status: "done",
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    working_ms: null,
    working_ms_source: null,
    started_at: null,
    settled: true,
    description: "Research planning/brainstorm flow",
    parent_id: null,
    dismissed_at: null,
    subagents: [],
    task: null,
    ...over,
  }) as TeamNode;

check("an unmeasured sub-agent is unmeasured", tokensMeasured(node({ tokens_measured: false })), false);
check("a measured one is measured", tokensMeasured(node({ tokens_measured: true })), true);
check(
  "a pre-1871 server (field absent) keeps the OLD behaviour, not a panel full of n/a",
  tokensMeasured(node({})),
  true,
);
check("the unmeasured cell fits the fixed token column", NOT_RECORDED.length <= 3, true);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — round 1871 chat fixes`,
);
process.exit(failures === 0 ? 0 : 1);
