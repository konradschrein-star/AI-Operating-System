/**
 * check-nav-stack.ts — executable unit check for the chat surface's ONE
 * navigation source of truth (U20/U21, 13 §2): `push`, `pop`, `reset`,
 * `crumbs` in forge-control-web/app/desktop/chat/nav-stack.ts.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-team-rows.ts, deliberately.
 *
 * It imports nav-stack.ts directly — no React, no JSX, which is exactly why
 * the reducer lives in its own module instead of inside ChatSurface's
 * `useState` calls where nothing could reach it.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-nav-stack.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  EMPTY_STACK,
  crumbs,
  frameKey,
  pop,
  push,
  reset,
  sameFrame,
  top,
  type NavFrame,
  type NavStack,
} from "../../forge-control-web/app/desktop/chat/nav-stack.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

function checkDeep(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        expected ${b}\n        got      ${a}`));
}

/* ── Fixtures ──────────────────────────────────────────────────────────────
 * The real shapes: a worker session, one of its sub-agents (whose id is a
 * tool_use_id, NOT a run id), a second worker, and a plan doc. */

const WORKER: NavFrame = { kind: "agent", runId: "3853c154-e07b-4318-9313-2b34f4a33342" };
const SUBAGENT: NavFrame = {
  kind: "agent",
  runId: "3853c154-e07b-4318-9313-2b34f4a33342",
  subagentId: "toolu_01ABCDEFGHIJKLMNOP",
};
const OTHER_WORKER: NavFrame = { kind: "agent", runId: "9f1e2d3c-0000-4000-8000-000000000001" };
const DOC: NavFrame = { kind: "plandoc", name: "13-ui-v3-architecture.md" };

console.log("── empty = the manager chat ─────────────────────────────────");
check("EMPTY_STACK is empty", EMPTY_STACK.length, 0);
check("reset() === EMPTY_STACK (identity, so React bails out)", reset(), EMPTY_STACK);
check("top(empty) is null — null MEANS the manager chat", top(EMPTY_STACK), null);
checkDeep("crumbs(empty) is still one crumb: the manager is a place", crumbs(EMPTY_STACK), [
  { depth: 0, kind: "manager", id: null, label: "manager chat" },
]);
check("frameKey(empty)", frameKey(EMPTY_STACK), "manager");

console.log("\n── push: descend ────────────────────────────────────────────");
const d1 = push(EMPTY_STACK, WORKER);
check("depth after one push", d1.length, 1);
check("the pushed frame is on top", top(d1), d1[0]);
checkDeep("top frame is the worker", top(d1), WORKER);
check("push does not mutate its input", EMPTY_STACK.length, 0);

const d2 = push(d1, SUBAGENT);
check("depth after descending into a sub-agent", d2.length, 2);
checkDeep("the worker frame is untouched underneath", d2[0], WORKER);
checkDeep("the sub-agent frame is on top", top(d2), SUBAGENT);
check("push does not mutate the shallower stack", d1.length, 1);

const d3 = push(d2, DOC);
check("plan-doc frames stack like any other", d3.length, 3);

console.log("\n── push is idempotent on the top frame ──────────────────────");
/* A double-click on a team row must not bury the user two levels deep in the
 * identical view, which would take two presses of back to undo one gesture. */
check("re-pushing the top frame returns the SAME stack", push(d1, WORKER), d1);
check(
  "…even as a structurally-equal-but-distinct object",
  push(d1, { kind: "agent", runId: WORKER.kind === "agent" ? WORKER.runId : "" }),
  d1,
);
check("a DIFFERENT worker does push", push(d1, OTHER_WORKER).length, 2);
check(
  "worker vs its own sub-agent are different frames (subagentId matters)",
  push(d1, SUBAGENT).length,
  2,
);

console.log("\n── sameFrame ────────────────────────────────────────────────");
check("same run, both without subagentId", sameFrame(WORKER, { ...WORKER }), true);
check("same run, one with a subagentId", sameFrame(WORKER, SUBAGENT), false);
check("different runs", sameFrame(WORKER, OTHER_WORKER), false);
check("different kinds", sameFrame(WORKER, DOC), false);
check("same doc name", sameFrame(DOC, { kind: "plandoc", name: DOC.kind === "plandoc" ? DOC.name : "" }), true);
check("different doc name", sameFrame(DOC, { kind: "plandoc", name: "10-ui-v3-spec.md" }), false);

console.log("\n── pop: climb ───────────────────────────────────────────────");
check("pop at depth 3 → depth 2", pop(d3).length, 2);
checkDeep("…and lands on the frame below", top(pop(d3)), SUBAGENT);
check("pop at depth 2 → depth 1", pop(d2).length, 1);
checkDeep("…and lands on the worker", top(pop(d2)), WORKER);

/* THE invariant the brief names: back at depth 1 is the manager chat, not a
 * one-frame stack pointing at nothing and not a throw. */
check("pop at depth 1 yields the EMPTY stack", pop(d1).length, 0);
check("…identically EMPTY_STACK, so React bails out", pop(d1), EMPTY_STACK);
check("top() of that is null — i.e. the manager chat", top(pop(d1)), null);

check("pop on an empty stack does not throw and stays empty", pop(EMPTY_STACK), EMPTY_STACK);
check("pop does not mutate its input", d3.length, 3);

/* Walking all the way down and all the way back returns you to the manager. */
check("push×3 then pop×3 → empty", pop(pop(pop(d3))).length, 0);
check("…and pop×4 is still empty (holding back is safe)", pop(pop(pop(pop(d3)))).length, 0);

console.log("\n── reset: switching chats ───────────────────────────────────");
/* ChatSurface's `openChat` calls reset() on every chat switch. A worker view
 * left standing under a newly-opened chat asserts that the worker belongs to
 * the new chat, which is false — this is the check for that rule. */
function switchChat(_stack: NavStack): NavStack {
  return reset();
}
check("switching chats from depth 1 → empty", switchChat(d1).length, 0);
check("switching chats from depth 2 → empty", switchChat(d2).length, 0);
check("switching chats from depth 3 → empty", switchChat(d3).length, 0);
check("switching chats from empty stays empty, same identity", switchChat(EMPTY_STACK), EMPTY_STACK);

console.log("\n── crumbs: the lineage trail ────────────────────────────────");
checkDeep("manager → worker", crumbs(d1), [
  { depth: 0, kind: "manager", id: null, label: "manager chat" },
  { depth: 1, kind: "agent", id: "3853c154-e07b-4318-9313-2b34f4a33342", label: "session 3853c154" },
]);
/* ROUND 1871 — this expectation used to be `sub-agent toolu_01`, and it was
 * asserting the defect. `toolu_01` is the Anthropic tool_use_id PREFIX: every
 * sub-agent that has ever run produced that identical crumb, so the trail named
 * nothing and could not tell two sub-agents of one run apart. The customer test
 * reported it as "machinery leaking into prose". The label now drops the prefix
 * and takes eight characters of the part that actually varies. */
checkDeep("manager → worker → sub-agent", crumbs(d2), [
  { depth: 0, kind: "manager", id: null, label: "manager chat" },
  { depth: 1, kind: "agent", id: "3853c154-e07b-4318-9313-2b34f4a33342", label: "session 3853c154" },
  { depth: 2, kind: "subagent", id: "toolu_01ABCDEFGHIJKLMNOP", label: "sub-agent ABCDEFGH" },
]);
check(
  "two sub-agents of one run get DIFFERENT crumbs (they did not before r1871)",
  crumbs(push(d1, { kind: "agent", runId: WORKER.runId, subagentId: "toolu_01ZZZZZZZZ" }))[2]
    .label !==
    crumbs(d2)[2].label,
  true,
);
check(
  "a caller-supplied label wins over the id",
  crumbs(
    push(d1, {
      kind: "agent",
      runId: WORKER.runId,
      subagentId: "toolu_01ABCDEFGHIJKLMNOP",
      label: "Recon: what timing data the runs take",
    }),
  )[2].label,
  "Recon: what timing data the runs take",
);
/* A DIFFERENT run id, deliberately: pushing WORKER's own id back onto d1 is a
 * no-op by design (`sameFrame`), so these two would index past the end. */
const OTHER_RUN = "9f2c1a55-0000-4000-8000-000000000001";
check(
  "an over-long label is clipped to fit a 260px header",
  crumbs(push(d1, { kind: "agent", runId: OTHER_RUN, label: "x".repeat(80) }))[2].label
    .length,
  42,
);
check(
  "a blank label falls back to the id rather than rendering an empty crumb",
  crumbs(push(d1, { kind: "agent", runId: OTHER_RUN, label: "   " }))[2].label,
  `session ${OTHER_RUN.slice(0, 8)}`,
);
check(
  "a label does NOT change frame identity — re-clicking the same row is still idempotent",
  push(d1, { ...WORKER, label: "named now" }),
  d1,
);
check("a plan doc crumb is its file name, verbatim", crumbs(d3)[3].label, "13-ui-v3-architecture.md");
check("crumbs length is always depth + 1", crumbs(d3).length, d3.length + 1);

console.log("\n── frameKey: what replays the drill-in animation ────────────");
check("worker key", frameKey(d1), "agent:3853c154-e07b-4318-9313-2b34f4a33342::1");
check(
  "sub-agent key differs from its parent's",
  frameKey(d2) !== frameKey(d1),
  true,
);
check("plan-doc key", frameKey(d3), "plandoc:13-ui-v3-architecture.md");
check("the same stack yields the same key (no spurious replays)", frameKey(push(d1, WORKER)), frameKey(d1));

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — nav stack (U20/U21)`,
);
process.exit(failures === 0 ? 0 : 1);
