/**
 * check-sidebar-scope.ts — executable unit check for the right sidebar's scope
 * toggle: `forge-control-web/app/desktop/team/sidebar-scope.ts`.
 *
 * What it pins, all three of them Konrad's requirement rather than my design
 * (vault `AI OS/Spec - Manager Chat UI v3.md`, addendum 2026-08-25):
 *
 *   1. the DEFAULT is "this chat" — a chat opens scoped to itself;
 *   2. a persisted choice ROUND-TRIPS — what the panel wrote is what it reads;
 *   3. an unrecognised stored value falls back to "this chat" rather than
 *      crashing or landing the operator in the scope that polls.
 *
 * ── EVERY EXPECTATION IS A LITERAL ───────────────────────────────────────────
 * Nothing here compares a constant from the module under test to itself.
 * `SIDEBAR_SCOPE_DEFAULT` is asserted to equal the string "this-chat", not to
 * equal whatever the module happens to say today; the round-trip cases name
 * both scopes as strings. An assertion that reads its expectation from the
 * subject passes at every value the subject could ever hold (fleet note
 * `test-imports-threshold-from-subject`), which is the same as no assertion.
 *
 * The serialisation is JSON, deliberately — the key is read by
 * `usePersistentState`, which `JSON.parse`s, so the stored bytes for the
 * default are `"this-chat"` WITH quotes. That is the opposite convention from
 * `forge.theme`, which is a bare word (fleet note
 * `theme-localstorage-is-bare-string-not-json`), and getting it backwards is
 * silent: the value simply never matches and the panel sits on its default
 * forever. Case 3 below is written from the WRONG convention's bytes on
 * purpose, so that a future edit to the encoding has to come here.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so a pure
 * module gets a plain tsx script — same shape as check-live-sessions.ts.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-sidebar-scope.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  SIDEBAR_SCOPES,
  SIDEBAR_SCOPE_DEFAULT,
  SIDEBAR_SCOPE_KEY,
  SIDEBAR_SCOPE_LABEL,
  isSidebarScope,
  readSidebarScope,
  scopePolls,
  writeSidebarScope,
} from "../../forge-control-web/app/desktop/team/sidebar-scope.ts";
/* The two poll periods this toggle spends, asserted here as well as in
 * check-chat-delta.ts: this check is the one a reader opens when asking "what
 * does the toggle cost", and the answer must not require a second file. */
import {
  AGENTS_POLL_MS,
  SIDEBAR_AGENTS_POLL_MS,
} from "../../forge-control-web/app/desktop/chat/pollBudget.ts";

/* ── Harness ──────────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

/* ── 1. The default ───────────────────────────────────────────────────────── */

console.log("\n── 1. The default is 'this chat' ─────────────────────────────");

eq("the default scope is this-chat", SIDEBAR_SCOPE_DEFAULT, "this-chat");
eq("nothing stored yet reads as this-chat", readSidebarScope(null), "this-chat");
eq(
  "the default scope issues no /api/agents poll",
  scopePolls(SIDEBAR_SCOPE_DEFAULT),
  false,
);
eq(
  "only 'everything running' polls",
  scopePolls("everything-running"),
  true,
);
eq(
  "the key is the one usePersistentState reads",
  SIDEBAR_SCOPE_KEY,
  "forge.layout.chat.sidebarScope",
);
eq(
  "there are exactly two scopes, scoped one first",
  SIDEBAR_SCOPES,
  ["this-chat", "everything-running"],
);
eq("this-chat is labelled in his words", SIDEBAR_SCOPE_LABEL["this-chat"], "this chat");
eq(
  "everything-running is labelled in his words",
  SIDEBAR_SCOPE_LABEL["everything-running"],
  "everything running",
);

/* ── 2. Round trip ────────────────────────────────────────────────────────── */

console.log("\n── 2. A persisted choice round-trips ─────────────────────────");

eq(
  "everything-running survives write → read",
  readSidebarScope(writeSidebarScope("everything-running")),
  "everything-running",
);
eq(
  "this-chat survives write → read",
  readSidebarScope(writeSidebarScope("this-chat")),
  "this-chat",
);
eq(
  "the stored bytes are JSON, quotes and all",
  writeSidebarScope("everything-running"),
  '"everything-running"',
);
eq(
  "usePersistentState's own encoding reads back",
  readSidebarScope(JSON.stringify("everything-running")),
  "everything-running",
);

/* ── 3. An unrecognised stored value ──────────────────────────────────────── */

console.log("\n── 3. Anything else falls back to 'this chat' ────────────────");

/* Each of these is a real way the key can hold something this build does not
 * know: a renamed value from a future build, an older build's vocabulary, a
 * hand-edit, a half-written value, and — the silent one — the BARE word, which
 * is what a script written against the `forge.theme` convention would store. */
for (const [label, raw] of [
  ["a future build's value", '"fleet"'],
  ["an older vocabulary", '"live"'],
  ["the bare word, wrong convention", "everything-running"],
  ["empty string", ""],
  ["not JSON at all", "{oops"],
  ["JSON of the wrong type", "42"],
  ["JSON null", "null"],
  ["an object", '{"scope":"everything-running"}'],
  ["an array", '["everything-running"]'],
  ["a near miss", '"everything running"'],
  ["case drift", '"This-Chat"'],
] as const) {
  eq(`${label} → this-chat`, readSidebarScope(raw), "this-chat");
}

ok(
  "no unrecognised value ever resolves to the polling scope",
  ['"fleet"', "everything-running", "{oops", "null", '["everything-running"]']
    .every((raw) => scopePolls(readSidebarScope(raw)) === false),
);

/* The guard itself, which is what usePersistentState is handed. */
eq("the guard accepts this-chat", isSidebarScope("this-chat"), true);
eq("the guard accepts everything-running", isSidebarScope("everything-running"), true);
eq("the guard rejects a near miss", isSidebarScope("everything running"), false);
eq("the guard rejects null", isSidebarScope(null), false);
eq("the guard rejects undefined", isSidebarScope(undefined), false);
eq("the guard rejects an object", isSidebarScope({ scope: "this-chat" }), false);

/* ── 4. What the toggle costs ─────────────────────────────────────────────── */

console.log("\n── 4. The two poll periods, against their own literals ───────");

/* The sidebar's period is a SEPARATE constant from /live's on purpose: mounting
 * the fleet feed in the chat surface must not make /live slower, and the chat
 * surface has a committed 40 req/min ceiling that /live does not. Both are
 * pinned to literals here; check-chat-delta.ts adds them up. */
eq("the /live fleet feed polls at 4s", AGENTS_POLL_MS, 4_000);
eq("the sidebar's fleet feed polls at 8s", SIDEBAR_AGENTS_POLL_MS, 8_000);
ok(
  "the sidebar is strictly slower than /live",
  SIDEBAR_AGENTS_POLL_MS > AGENTS_POLL_MS,
  `${SIDEBAR_AGENTS_POLL_MS}ms is not slower than ${AGENTS_POLL_MS}ms`,
);
eq("the sidebar's feed costs 7.5 req/min", 60_000 / SIDEBAR_AGENTS_POLL_MS, 7.5);

/* ── Verdict ──────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("check-sidebar-scope: FAIL");
  process.exit(1);
}
console.log("check-sidebar-scope: PASS");
