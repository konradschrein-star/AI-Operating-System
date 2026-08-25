/**
 * check-code-path-link.ts — executable unit check for `detectPath` / `codeText`
 * in forge-control-web/app/desktop/chat/code-path-link.ts.
 *
 * detectPath decides whether an inline `code` pill in chat names an openable
 * file. It is deliberately narrow — rule ids, commands, env vars and API
 * routes must stay plain pills, never a dead click. This is the ported
 * version of the live checkout's throwaway /tmp/detect-test.mts (the sole
 * copy of this feature, see PLAN.md finding 1), same 18 cases plus the
 * `codeText` array-join case, now committed so a future edit to the matcher
 * cannot silently regress it.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, one PASS/FAIL line per case,
 * `process.exit(1)` if anything fails. Same shape as check-nav-stack.ts,
 * deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-code-path-link.ts
 */

import { codeText, detectPath } from "../../forge-control-web/app/desktop/chat/code-path-link.ts";

const CASES: Array<[string, "exact" | "search" | null]> = [
  ["/opt/obsidian-vault/Mentor/Profile/OPEN-QUESTIONS.md", "exact"],
  ["/opt/ai-os/workspace/OVERNIGHT.md", "exact"],
  ["AI OS/Operator Log.md", "search"],
  ["OPEN-QUESTIONS.md", "search"],
  ["Mentor/Profile/OPEN-QUESTIONS.md", "search"],
  ["app/desktop/chat/MessageMarkdown.tsx", "search"],
  // not files -> no affordance
  ["spend.per_run_cap", null],
  ["pnpm install", null],
  ["rm -rf node_modules", null],
  ["/api/autonomy/check", null],
  ["guardrail_rules", null],
  ["FORGE_RUN_UUID", null],
  ["3", null],
  ["/root/.claude/settings.json", null], // outside every root
  ["/opt/ai-os/scripts/guard-autonomy.py", "exact"], // now inside the aios root
  ["curl -s http://x/y.json", null],
  ["../../etc/passwd", null],
  ["/opt/obsidian-vault/../../etc/passwd", null],
];

let failures = 0;
for (const [text, want] of CASES) {
  const got = detectPath(text);
  const kind = got ? got.kind : null;
  const ok = kind === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  kind=${String(kind).padEnd(6)} want=${String(want).padEnd(6)} ${JSON.stringify(text)}`);
}

const joinOk = codeText(["AI OS/", "Operator Log.md"]) === "AI OS/Operator Log.md";
if (!joinOk) failures++;
console.log(`${joinOk ? "PASS" : "FAIL"}  codeText joins string-array children`);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — code-path-link (${CASES.length + 1} cases)`,
);
process.exit(failures === 0 ? 0 : 1);
