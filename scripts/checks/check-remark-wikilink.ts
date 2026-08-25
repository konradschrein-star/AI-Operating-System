/**
 * check-remark-wikilink.ts — `[[Operating Manual]]` is a link, and everything
 * that must NOT become one stays text.
 *
 * TWO SECTIONS, AND THE SPLIT IS THE POINT.
 *
 * §1 drives `transformWikilinks()` over hand-built mdast. It is the only way
 * to assert the structural rules (a wikilink inside an existing link is not
 * nested, an opaque node is not descended into) because the markdown parser
 * cannot even produce some of those trees.
 *
 * §2 renders the REAL `MessageMarkdown` — remark-gfm, the wikilink plugin,
 * the allowlist, the urlTransform and the component overrides, in the order
 * the app runs them — and asserts on the HTML that comes out. Every case whose
 * answer depends on how markdown is PARSED lives here and nowhere else: a
 * GFM table cell escapes its pipes (`[[Target\|Alias]]`), a fenced block must
 * stay literal, and an injection payload has to be judged on what the shipped
 * renderer emits. Asserting those against a hand-written mdast fixture would
 * be asserting against my own guess at the parser — the exact fabrication that
 * has produced green checks over broken code in this repo before.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch.
 *
 * Run (needs the JSX/runtime tsconfig — see tsconfig.checks.json at the repo
 * root, whose header says why it cannot live in this directory):
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-remark-wikilink.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  transformWikilinks,
  wikilinkHref,
  type MdastNode,
} from "../../forge-control-web/app/desktop/chat/remark-wikilink.ts";
import { MessageMarkdown } from "../../forge-control-web/app/desktop/chat/MessageMarkdown.tsx";

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

/* ───────────────────────────── §1 the plugin ─────────────────────────────
 * Structural rules, on trees the parser cannot hand us. */

console.log("── §1 transformWikilinks over mdast ──");

/** A paragraph holding one text node — the shape the parser produces for
 *  ordinary prose, built by hand so the assertions are about the transform. */
function para(value: string): MdastNode {
  return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
}

/** Flatten a transformed tree to `text:…` / `link:url:text` tokens. */
function tokens(node: MdastNode): string[] {
  const out: string[] = [];
  const walk = (n: MdastNode): void => {
    if (n.type === "text") {
      out.push(`text:${(n as { value: string }).value}`);
      return;
    }
    if (n.type === "link") {
      const link = n as { url: string; children: MdastNode[] };
      const label = link.children
        .map((c) => (c.type === "text" ? (c as { value: string }).value : `<${c.type}>`))
        .join("");
      out.push(`link:${link.url}:${label}`);
      return;
    }
    for (const c of (n as { children?: MdastNode[] }).children ?? []) walk(c);
  };
  walk(node);
  return out;
}

function plugin(name: string, tree: MdastNode, expected: string[]): void {
  transformWikilinks(tree);
  check(name, tokens(tree).join(" | "), expected.join(" | "));
}

plugin("plain note becomes one link", para("see [[Operating Manual]] first"), [
  "text:see ",
  "link:/document?wikilink=Operating%20Manual:Operating Manual",
  "text: first",
]);

plugin("two wikilinks in one text node", para("[[A]] and [[B]]"), [
  "link:/document?wikilink=A:A",
  "text: and ",
  "link:/document?wikilink=B:B",
]);

plugin("empty inner stays literal text", para("brackets [[]] here"), [
  "text:brackets [[]] here",
]);

plugin("markup inner stays literal text", para("[[<img src=x onerror=alert(1)>]]"), [
  "text:[[<img src=x onerror=alert(1)>]]",
]);

plugin(
  "a refused link does not eat the accepted one beside it",
  para("[[]] then [[Real Note]]"),
  ["text:[[]] then ", "link:/document?wikilink=Real%20Note:Real Note"],
);

plugin(
  "text inside an existing link is not touched",
  {
    type: "root",
    children: [
      {
        type: "link",
        url: "https://example.com",
        title: null,
        children: [{ type: "text", value: "[[Note]]" }],
      } as MdastNode,
    ],
  },
  ["link:https://example.com:[[Note]]"],
);

plugin(
  // A today's-mdast `inlineCode` holds a value and NO children, so it is
  // unreachable by the walk whatever the OPAQUE set says — an assertion on
  // that shape could not fail and would be worthless. This tree gives it
  // children, which is the case OPAQUE actually decides: drop "inlineCode"
  // from that set and this line goes red.
  "a code node with children is still opaque",
  {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "inlineCode",
            children: [{ type: "text", value: "[[Note]]" }],
          } as MdastNode,
        ],
      },
    ],
  },
  ["text:[[Note]]"],
);

check(
  "wikilinkHref encodes the name",
  wikilinkHref("A & B/C", null),
  "/document?wikilink=A%20%26%20B%2FC",
);
check(
  "wikilinkHref carries the qualifying path",
  wikilinkHref("Note", "Dir/Note"),
  "/document?wikilink=Note&wikipath=Dir%2FNote",
);

/* ─────────────────────── §2 through the shipped renderer ─────────────────── */

console.log("\n── §2 the real MessageMarkdown pipeline ──");

function render(source: string): string {
  return renderToStaticMarkup(createElement(MessageMarkdown, { source }));
}

/** The tags only. A payload that renders correctly appears as ESCAPED TEXT
 *  (`&lt;img src=x onerror=…&gt;`), which contains "src=" and "onerror=" —
 *  a regex over the raw HTML would report a hit on an inert payload. Escaped
 *  text has no `<`, so it cannot be inside a tag. Same technique as
 *  check-chat-rich.tsx, deliberately. */
function tagsOf(html: string): string {
  return (html.match(/<[^>]*>/g) ?? []).join(" ");
}

const LIVE_NODE = /<(script|iframe|object|embed|form|svg|math|link|style|base|meta|img|audio|video|canvas)\b/i;
const HANDLER = /\s(on[a-z]+)\s*=/i;
const BAD_SCHEME_HREF = /href\s*=\s*"(?:\s|&#\d+;)*(javascript|data|vbscript|file):/i;

/** Every `href` on an anchor, in document order, HTML-unescaped enough to
 *  compare against what `wikilinkHref` produced. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
}

/** The ACCESSIBLE text of the first anchor: `aria-hidden` subtrees are dropped
 *  first, which is what removes the decorative `[[` glyph — the same thing a
 *  screen reader does, so the assertion is about the link's real name. */
function firstLinkText(html: string): string | null {
  const m = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/<span\b[^>]*\saria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]*>/g, "");
}

interface Case {
  id: string;
  source: string;
  /** Hrefs expected on anchors, in order. `[]` means "no anchor at all". */
  hrefs: string[];
  /** The first anchor's visible text, when there is one. */
  linkText?: string;
  /** Substrings that must survive into the output (escaped where markup). */
  literal?: string[];
  /** Substrings that must NOT appear anywhere in the output. */
  absent?: string[];
}

const CASES: Case[] = [
  {
    id: "plain",
    source: "read [[Operating Manual]] before you start",
    hrefs: ["/document?wikilink=Operating%20Manual"],
    linkText: "Operating Manual",
  },
  {
    id: "aliased",
    source: "read [[Operating Manual|the manual]] first",
    hrefs: ["/document?wikilink=Operating%20Manual"],
    linkText: "the manual",
  },
  {
    id: "table-escaped-alias",
    // THE TABLE CASE. Inside a GFM cell an aliased wikilink must be written
    // with an escaped pipe or the cell splits; the vault has 41 stored links
    // carrying this artefact. Parsed for real here — remark-gfm decides what
    // the text node actually contains, not this file.
    source: "| note | why |\n| - | - |\n| [[Operating Manual\\|the manual]] | onboarding |",
    hrefs: ["/document?wikilink=Operating%20Manual"],
    linkText: "the manual",
    literal: ["onboarding"],
  },
  {
    id: "heading-anchor",
    source: "see [[Operating Manual#Daily Rhythm]]",
    hrefs: ["/document?wikilink=Operating%20Manual"],
    linkText: "Operating Manual",
  },
  {
    id: "path-qualified",
    source: "see [[Mentor/Profile/Operating Manual]]",
    hrefs: [
      "/document?wikilink=Operating%20Manual&wikipath=Mentor%2FProfile%2FOperating%20Manual",
    ],
    linkText: "Operating Manual",
  },
  {
    id: "empty",
    source: "the syntax is [[]] for a note",
    hrefs: [],
    literal: ["[[]]"],
  },
  {
    id: "img-injection",
    source: "[[<img src=x onerror=alert(1)>]]",
    hrefs: [],
    literal: ["&lt;img src=x onerror=alert(1)&gt;"],
  },
  {
    id: "javascript-scheme",
    // Must never become a live href of that scheme. It is not refused
    // outright — it becomes a search for a note with a silly name, which is
    // a same-origin relative path and cannot execute anything.
    source: "[[javascript:alert(1)]]",
    hrefs: ["/document?wikilink=javascript%3Aalert(1)"],
    linkText: "javascript:alert(1)",
    absent: ['href="javascript'],
  },
  {
    id: "fenced-code-untouched",
    source: "```\nlink it as [[Operating Manual]] in the note\n```",
    hrefs: [],
    literal: ["[[Operating Manual]]"],
  },
  {
    id: "inline-code-untouched",
    source: "write `[[Operating Manual]]` to link it",
    hrefs: [],
    literal: ["[[Operating Manual]]"],
  },
  {
    id: "real-link-still-external",
    // A plain markdown link is unaffected: it keeps target=_blank and does
    // NOT get our /document handler or the openable data attributes.
    source: "[docs](https://example.com/x)",
    hrefs: ["https://example.com/x"],
    linkText: "docs",
    absent: ["data-openable-kind"],
  },
];

for (const c of CASES) {
  const html = render(c.source);
  const tags = tagsOf(html);
  check(`${c.id}: hrefs`, hrefs(html).join(" , "), c.hrefs.join(" , "));
  if (c.linkText !== undefined) check(`${c.id}: link text`, firstLinkText(html), c.linkText);
  for (const lit of c.literal ?? []) {
    check(`${c.id}: keeps ${JSON.stringify(lit)}`, html.includes(lit), true);
  }
  for (const bad of c.absent ?? []) {
    check(`${c.id}: no ${JSON.stringify(bad)}`, html.includes(bad), false);
  }
  check(`${c.id}: no live node`, LIVE_NODE.test(tags), false);
  check(`${c.id}: no inline handler`, HANDLER.test(tags), false);
  check(`${c.id}: no dangerous scheme in an href`, BAD_SCHEME_HREF.test(tags), false);
}

/* The discoverability contract (D7) and the attributes the Playwright
 * regression test keys on. `data-openable-path` must not be renamed. */
const wikiHtml = render("read [[Operating Manual]] now");
check("wikilink pill is marked openable", wikiHtml.includes('data-openable-path="true"'), true);
check("wikilink pill declares its kind", wikiHtml.includes('data-openable-kind="wikilink"'), true);
check("wikilink pill takes the link colour", wikiHtml.includes("var(--v2-accent)"), true);

const fileHtml = render("open `MessageMarkdown.tsx:160` please");
check("line ref is marked openable", fileHtml.includes('data-openable-path="true"'), true);
check("line ref declares kind=file", fileHtml.includes('data-openable-kind="file"'), true);
const dirHtml = render("look in `/root/.claude/projects/-opt-forge-ai-os/memory/`");
check("folder ref declares kind=dir", dirHtml.includes('data-openable-kind="dir"'), true);
const plainHtml = render("run `pnpm install` first");
check("a non-path pill gets no affordance", plainHtml.includes("data-openable"), false);

console.log(
  failures === 0
    ? `\nPASS — ${assertions}/${assertions} assertions`
    : `\nFAIL — ${failures} of ${assertions} assertions failed`,
);
process.exit(failures === 0 ? 0 : 1);
