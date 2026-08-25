/**
 * check-frontmatter.ts — executable unit check for `splitFrontmatter` in
 * forge-control-web/app/desktop/chat/frontmatter.ts.
 *
 * FilePreview hides a note's YAML frontmatter behind a compact meta strip
 * (project aios-chat-reference-navigation, detail D3). The dangerous failure is
 * not a mis-rendered strip — it is eating body text: if the splitter guesses a
 * terminator that is not there, the first paragraphs of a note silently vanish
 * from the only renderer the chat panel and /document have. So the table below
 * pins the body byte-for-byte on every negative case (no block, `---` in the
 * body only, unterminated block).
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, one PASS/FAIL line per case,
 * `process.exit(1)` if anything fails. Same shape as check-code-path-link.ts,
 * deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-frontmatter.ts
 */

import {
  splitFrontmatter,
  type MetaEntry,
} from "../../forge-control-web/app/desktop/chat/frontmatter.ts";

interface Case {
  name: string;
  input: string;
  /** null = expect no frontmatter at all (and an untouched body). */
  meta: Array<[string, string]> | null;
  body: string;
}

const CASES: Case[] = [
  {
    name: "no frontmatter — body untouched",
    input: "# Title\n\nsome prose\n",
    meta: null,
    body: "# Title\n\nsome prose\n",
  },
  {
    name: "normal block",
    input: "---\ntype: profile\nsection: operating-manual\n---\n# Operating Manual\n\nbody\n",
    meta: [
      ["type", "profile"],
      ["section", "operating-manual"],
    ],
    body: "# Operating Manual\n\nbody\n",
  },
  {
    name: "`---` inside the body only — not frontmatter",
    input: "# Title\n\nabove\n\n---\n\nbelow\n",
    meta: null,
    body: "# Title\n\nabove\n\n---\n\nbelow\n",
  },
  {
    name: "unterminated block — meta null, body byte-for-byte",
    input: "---\ntype: profile\nstill going\n\n# Title\n",
    meta: null,
    body: "---\ntype: profile\nstill going\n\n# Title\n",
  },
  {
    name: "windows line endings",
    input: "---\r\ntype: profile\r\ntags: a\r\n---\r\n# Title\r\n\r\nbody\r\n",
    meta: [
      ["type", "profile"],
      ["tags", "a"],
    ],
    body: "# Title\r\n\r\nbody\r\n",
  },
  {
    name: "empty values keep their keys",
    input: "---\naliases:\ncreated: 2026-08-25\nsummary:\n---\nbody\n",
    meta: [
      ["aliases", ""],
      ["created", "2026-08-25"],
      ["summary", ""],
    ],
    body: "body\n",
  },
  {
    name: "nested block and list kept raw as a multi-line value",
    input: "---\nname: memory-note\nmetadata:\n  node_type: memory\n  type: project\ntags:\n- a\n- b\n---\nbody\n",
    meta: [
      ["name", "memory-note"],
      ["metadata", "  node_type: memory\n  type: project"],
      ["tags", "- a\n- b"],
    ],
    body: "body\n",
  },
  {
    name: "empty block — a block with no keys is still a block",
    input: "---\n---\nbody\n",
    meta: [],
    body: "body\n",
  },
  {
    name: "value containing a colon survives whole",
    input: "---\nsource: chat://a8d768ba\n---\nbody\n",
    meta: [["source", "chat://a8d768ba"]],
    body: "body\n",
  },
  {
    name: "empty file",
    input: "",
    meta: null,
    body: "",
  },
];

function metaEq(got: MetaEntry[] | null, want: Array<[string, string]> | null): boolean {
  if (got === null || want === null) return got === want;
  if (got.length !== want.length) return false;
  return got.every((e, i) => e[0] === want[i][0] && e[1] === want[i][1]);
}

let failures = 0;
for (const c of CASES) {
  const got = splitFrontmatter(c.input);
  const okMeta = metaEq(got.meta, c.meta);
  const okBody = got.body === c.body;
  const ok = okMeta && okBody;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!okMeta) {
    console.log(`        meta got  ${JSON.stringify(got.meta)}`);
    console.log(`        meta want ${JSON.stringify(c.meta)}`);
  }
  if (!okBody) {
    console.log(`        body got  ${JSON.stringify(got.body)}`);
    console.log(`        body want ${JSON.stringify(c.body)}`);
  }
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — frontmatter (${CASES.length} cases)`,
);
process.exit(failures === 0 ? 0 : 1);
