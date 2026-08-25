/**
 * check-code-path-link.ts — executable unit check for `detectPath`,
 * `parseWikilink`, `documentHref` and `codeText` in
 * forge-control-web/app/desktop/chat/code-path-link.ts.
 *
 * detectPath decides whether an inline `code` pill in chat names an openable
 * file. It is deliberately narrow — rule ids, commands, env vars and API
 * routes must stay plain pills, never a dead click. The first 18 cases are the
 * ported version of the live checkout's throwaway /tmp/detect-test.mts (the
 * sole copy of this feature, see PLAN.md finding 1); round 1 added line
 * references (D1), directories (D5), the `memory` root (D6), the false
 * affordances observed live (PLAN.md finding 6) and wikilink parsing (D2).
 *
 * Cases assert the WHOLE target, not just its kind: a matcher that returns
 * `exact` with the wrong root or drops the line number passes a kind-only
 * table while being useless in the browser.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, one PASS/FAIL line per case,
 * `process.exit(1)` if anything fails. Same shape as check-nav-stack.ts,
 * deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-code-path-link.ts
 */

import {
  codeText,
  detectPath,
  documentHref,
  parseWikilink,
  type PathTarget,
  type WikilinkTarget,
} from "../../forge-control-web/app/desktop/chat/code-path-link.ts";

let failures = 0;

function report(ok: boolean, line: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${line}`);
}

// ---------------------------------------------------------------- detectPath

/** null = no affordance; otherwise the exact target expected, field for field. */
type Expect = PathTarget | null;

const CASES: Array<[string, Expect]> = [
  // ---- ported from the live /tmp/detect-test.mts (the original 18) --------
  [
    "/opt/obsidian-vault/Mentor/Profile/OPEN-QUESTIONS.md",
    { kind: "exact", root: "vault", path: "Mentor/Profile/OPEN-QUESTIONS.md", label: "OPEN-QUESTIONS.md" },
  ],
  [
    "/opt/ai-os/workspace/OVERNIGHT.md",
    { kind: "exact", root: "workspace", path: "OVERNIGHT.md", label: "OVERNIGHT.md" },
  ],
  ["AI OS/Operator Log.md", { kind: "search", query: "AI OS/Operator Log.md", label: "Operator Log.md" }],
  ["OPEN-QUESTIONS.md", { kind: "search", query: "OPEN-QUESTIONS.md", label: "OPEN-QUESTIONS.md" }],
  [
    "Mentor/Profile/OPEN-QUESTIONS.md",
    { kind: "search", query: "Mentor/Profile/OPEN-QUESTIONS.md", label: "OPEN-QUESTIONS.md" },
  ],
  [
    "app/desktop/chat/MessageMarkdown.tsx",
    { kind: "search", query: "app/desktop/chat/MessageMarkdown.tsx", label: "MessageMarkdown.tsx" },
  ],
  // not files -> no affordance
  ["spend.per_run_cap", null],
  ["pnpm install", null],
  ["rm -rf node_modules", null],
  ["/api/autonomy/check", null],
  ["guardrail_rules", null],
  ["FORGE_RUN_UUID", null],
  ["3", null],
  ["/root/.claude/settings.json", null], // outside every root, .claude is not the memory dir
  [
    "/opt/ai-os/scripts/guard-autonomy.py",
    { kind: "exact", root: "aios", path: "scripts/guard-autonomy.py", label: "guard-autonomy.py" },
  ],
  ["curl -s http://x/y.json", null],
  ["../../etc/passwd", null],
  ["/opt/obsidian-vault/../../etc/passwd", null],

  // ---- D1 line references -------------------------------------------------
  [
    "MessageMarkdown.tsx:160",
    { kind: "search", query: "MessageMarkdown.tsx", label: "MessageMarkdown.tsx", line: 160 },
  ],
  [
    "/opt/forge-ai-os/forge-control/src/executor.ts:715",
    { kind: "exact", root: "forge-src", path: "forge-control/src/executor.ts", label: "executor.ts", line: 715 },
  ],
  [
    // column parsed and discarded — the viewer scrolls to a line
    "/opt/forge-ai-os/forge-control/src/executor.ts:715:3",
    { kind: "exact", root: "forge-src", path: "forge-control/src/executor.ts", label: "executor.ts", line: 715 },
  ],
  [
    // trailing prose punctuation around the reference
    "executor.ts:715)",
    { kind: "search", query: "executor.ts", label: "executor.ts", line: 715 },
  ],
  [
    "app/desktop/chat/code-path-link.ts:1",
    { kind: "search", query: "app/desktop/chat/code-path-link.ts", label: "code-path-link.ts", line: 1 },
  ],
  ["README.md:0", null], // lines are 1-based; :0 is malformed, not "open at the top"
  ["README.md:abc", null], // suffix defeats the extension test
  ["https://example.com/y.md:1", null], // a URL is the browser's business
  ["https://example.com/y.md", null],
  ["executor.ts:715:3:9", null], // not a shape we recognise -> no affordance

  // ---- D5 directories -----------------------------------------------------
  ["/opt/ai-os/scripts/", { kind: "exact", root: "aios", path: "scripts", label: "scripts", isDir: true }],
  [
    "/root/.claude/projects/-opt-forge-ai-os/memory/",
    { kind: "exact", root: "memory", path: "", label: "memory", isDir: true },
  ],
  ["Mentor/Profile/", { kind: "search", query: "Mentor/Profile", label: "Profile", isDir: true }],
  [
    "/opt/obsidian-vault/AI OS/",
    { kind: "exact", root: "vault", path: "AI OS", label: "AI OS", isDir: true },
  ],
  ["/", null],
  ["./", null],
  ["src/:12", null], // a directory has no line number
  ["/etc/nginx/", null], // outside every root

  // ---- D6 memory root -----------------------------------------------------
  [
    "/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md",
    { kind: "exact", root: "memory", path: "MEMORY.md", label: "MEMORY.md" },
  ],
  [
    "/root/.claude/projects/-opt-forge-ai-os/memory/gates-808-is-the-repo-suite.md:12",
    {
      kind: "exact",
      root: "memory",
      path: "gates-808-is-the-repo-suite.md",
      label: "gates-808-is-the-repo-suite.md",
      line: 12,
    },
  ],
  ["/root/.claude/projects/-opt-forge-ai-os/", null], // the parent is not a root

  // ---- false affordances observed live (PLAN.md finding 6) ----------------
  [".txt", null],
  [".md .txt .json .csv", null],
  [".ts .tsx .js .py .sh .sql", null],
  ["a.md b.md", null],
  [".env", null],
  ["notes/.hidden.md", null], // dotfile basename: empty stem
  ["README.md,", { kind: "search", query: "README.md", label: "README.md" }],
  [
    "docs/plan/03-quality.md.",
    { kind: "search", query: "docs/plan/03-quality.md", label: "03-quality.md" },
  ],

  // ---- false affordances found by sweeping 16 636 REAL inline-code spans --
  // out of the repo's own markdown + the fleet memory notes (2026-08-25).
  // Each of these was marked openable by the first draft of the D1/D5 rules.
  ["![x](http://host/beacon.png)", null], // markdown image, scheme mid-string
  ["--help.ts", null], // a flag, not a file
  ["-broken.ts", null],
  ["-v docs/", null],
  ["@excalidraw/excalidraw/index.css", null], // npm scope, not a path on disk
  ["@types/", null],
  ["/opt/ai-os/uploads/dbb65f80ce12/frozen-live-t{0,1}-dark.png", null], // brace glob
  ["F=src/lib/fixtures/replay-operator-visibility.json", null], // shell assignment
  [" M README.md", null], // git status short format
  [" M forge-control-web/app/desktop/chat/AssistantThread.tsx", null],
  ["GET /", null],
  ["GET /api/files/vault/", null], // prose, then a path
  ["GET www.perplexity.ai/", null], // a spaced relative "directory" is prose
  ["HANDOFF.md, WORKLOG.md", null], // two filenames = a list
  // resolveInRoot (files.ts:118) 400s on EVERY dot segment, not just ".."
  ["/opt/ai-os/.secrets/store/", null],
  ["/opt/obsidian-vault/.obsidian/plugins/config.json", null],
  ["Daily/../../x.md", null], // traversal probe, not a name a search can place
  ["Notes/../.trash/deleted.md", null],
  ["docs/plan/artifacts/.../phase3/gate-verdict.md", null], // elided middle
  // …and the spaced paths that MUST survive all of the above
  [
    "/opt/obsidian-vault/AI OS/Specs/Directory + Business Plan Hub.md",
    {
      kind: "exact",
      root: "vault",
      path: "AI OS/Specs/Directory + Business Plan Hub.md",
      label: "Directory + Business Plan Hub.md",
    },
  ],
  [
    "Drawing 2026-07-03 18.25.41.excalidraw.md",
    { kind: "search", query: "Drawing 2026-07-03 18.25.41.excalidraw.md", label: "Drawing 2026-07-03 18.25.41.excalidraw.md" },
  ],
  [
    "Help from Harry.md",
    { kind: "search", query: "Help from Harry.md", label: "Help from Harry.md" },
  ],

  // ---- longest-prefix ordering still holds --------------------------------
  [
    "/opt/ai-os/uploads/051c7e2a92b5/shot.png",
    { kind: "exact", root: "uploads", path: "051c7e2a92b5/shot.png", label: "shot.png" },
  ],
  [
    "/opt/content-forge/media/clip.mp4",
    { kind: "exact", root: "media", path: "clip.mp4", label: "clip.mp4" },
  ],
];

/** Stable, key-sorted rendering so two targets compare as strings. */
function show(t: Expect): string {
  if (t === null) return "null";
  const keys = Object.keys(t).sort();
  return `{${keys.map((k) => `${k}:${JSON.stringify((t as Record<string, unknown>)[k])}`).join(",")}}`;
}

for (const [text, want] of CASES) {
  const got = detectPath(text);
  report(show(got) === show(want), `${JSON.stringify(text).padEnd(56)} -> ${show(got)}   want ${show(want)}`);
}

// -------------------------------------------------------------- parseWikilink

type WikiExpect = WikilinkTarget | null;

const WIKI_CASES: Array<[string, WikiExpect]> = [
  ["Note", { name: "Note", anchor: null, alias: null, path: null }],
  ["Note|Alias", { name: "Note", anchor: null, alias: "Alias", path: null }],
  // table-cell escape: inside a table the pipe must be written "\|"
  ["Note\\|Alias", { name: "Note", anchor: null, alias: "Alias", path: null }],
  ["Note#Heading", { name: "Note", anchor: "Heading", alias: null, path: null }],
  [
    "System - Software Stack#AI Services",
    { name: "System - Software Stack", anchor: "AI Services", alias: null, path: null },
  ],
  [
    "Dir/Sub/Note",
    { name: "Note", anchor: null, alias: null, path: "Dir/Sub/Note" },
  ],
  [
    "30_YouTube/Plan for YouTube/System - OpenClaw AI Agent",
    {
      name: "System - OpenClaw AI Agent",
      anchor: null,
      alias: null,
      path: "30_YouTube/Plan for YouTube/System - OpenClaw AI Agent",
    },
  ],
  [
    "Dir/Note#Heading\\|Alias",
    { name: "Note", anchor: "Heading", alias: "Alias", path: "Dir/Note" },
  ],
  ["  Spaced Note  ", { name: "Spaced Note", anchor: null, alias: null, path: null }],
  ["Note|", { name: "Note", anchor: null, alias: null, path: null }], // empty alias, still a link
  ["Note#", { name: "Note", anchor: null, alias: null, path: null }],
  // rejected
  ["", null],
  ["   ", null],
  ["#Heading", null], // a link into the note's own body names no file
  ["Note]", null],
  ["Note[", null],
  ["Note\nOther", null],
  ["<script>", null],
  ["Dir/", null], // path-qualified with no note at the end
  ["\\", null],
];

function showWiki(w: WikiExpect): string {
  return w === null
    ? "null"
    : `{alias:${JSON.stringify(w.alias)},anchor:${JSON.stringify(w.anchor)},name:${JSON.stringify(w.name)},path:${JSON.stringify(w.path)}}`;
}

for (const [inner, want] of WIKI_CASES) {
  const got = parseWikilink(inner);
  report(
    showWiki(got) === showWiki(want),
    `wikilink ${JSON.stringify(inner).padEnd(48)} -> ${showWiki(got)}   want ${showWiki(want)}`,
  );
}

// -------------------------------------------------------------- documentHref

const hrefNoLine = documentHref("vault", "AI OS/Operator Log.md");
report(
  hrefNoLine === "/document?root=vault&path=AI%20OS%2FOperator%20Log.md",
  `documentHref without a line -> ${hrefNoLine}`,
);

const hrefLine = documentHref("forge-src", "forge-control/src/executor.ts", 715);
report(
  hrefLine === "/document?root=forge-src&path=forge-control%2Fsrc%2Fexecutor.ts&line=715",
  `documentHref with a line -> ${hrefLine}`,
);

let threw = false;
try {
  documentHref("vault", "x.md", 0);
} catch (err) {
  threw = err instanceof RangeError;
}
report(threw, "documentHref throws RangeError on a 0 line rather than linking nowhere");

// ------------------------------------------------------------------ codeText

report(
  codeText(["AI OS/", "Operator Log.md"]) === "AI OS/Operator Log.md",
  "codeText joins string-array children",
);
report(codeText({ nested: true }) === "", "codeText declines a non-string child");

const total = CASES.length + WIKI_CASES.length + 5;
console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — code-path-link (${total} cases)`,
);
process.exit(failures === 0 ? 0 : 1);
