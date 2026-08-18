/**
 * check-orientation.ts — executable unit check for the U22 orientation strip's
 * derivation (`app/desktop/chat/OrientationStrip.tsx`).
 *
 * The strip's promise is narrow and testable: every field is a pure function of
 * data already on the wire, and everything it cannot derive is DEGRADED with a
 * named reason rather than guessed. Four properties, one section each:
 *
 *   1. PLAN ARITHMETIC — `phase = floor(round/100)*100`, and nothing else.
 *      No lookup, no endpoint, and `null` for any round that is not a
 *      non-negative integer (U22: never invent a phase).
 *   2. NODE MATCHING — a session matches on run id; a sub-agent matches on
 *      `tool_use_id` AND `parent_id`. A tree that does not describe this node
 *      never supplies its task.
 *   3. DEGRADE COVERAGE — every member of `DegradeReason` is reachable and has
 *      rendered text. No silent blank.
 *   4. ACTIVITY TAXONOMY — the four kinds from
 *      `docs/research/round-599-4d8679b2.md` §"Current Activity Taxonomy" map
 *      to their verbs; an unseen kind is passed through verbatim and marked
 *      `known: false` rather than folded into the nearest familiar one.
 *
 * Plus the real 285-entry capture: the reference run's `current_activity`
 * really is an `assistant_text`, and the strip renders it as one.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain tsx,
 * table-driven, `process.exit(1)` on any mismatch. Same shape as
 * check-story-digest.ts, deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-orientation.ts
 */

import { readFileSync } from "node:fs";

import type { TeamNode, TeamResponse } from "../../forge-control-web/app/desktop/team/teamApi.ts";
import {
  activityLine,
  clipLine,
  DEGRADE_TEXT,
  derivePlanFacts,
  findTeamNode,
  isTeamResponse,
  parseActivity,
  planPosition,
  readTeam,
  type CachedTeamQuery,
  type DegradeReason,
} from "../../forge-control-web/app/desktop/chat/OrientationStrip.tsx";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

/* ── 1. Plan arithmetic ───────────────────────────────────────────────────── */

console.log("\n── plan position is arithmetic on task.round, nothing else ──");

const PLAN_CASES: Array<[number, string]> = [
  [601, "600→700"],
  [603, "600→700"],
  [600, "600→700"],
  [699, "600→700"],
  [700, "700→800"],
  [500, "500→600"],
  [0, "0→100"],
  [42, "0→100"],
];
for (const [round, expected] of PLAN_CASES) {
  const p = planPosition(round);
  check(
    `round ${round} → phase ${expected}`,
    p === null ? "null" : `${p.phase}→${p.next}`,
    expected,
  );
}

for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  check(`round ${String(bad)} yields no phase at all`, planPosition(bad), null);
}

/* ── 2. Node matching ─────────────────────────────────────────────────────── */

console.log("\n── a tree only supplies a task for the node it describes ──");

const RUN_A = "3853c154-e07b-4378-9313-2b34f4a33342";
const RUN_B = "58096061-0000-0000-0000-000000000000";
const SUB = "toolu_014raMUrJcAiXV61BerokrjN";

function node(over: Partial<TeamNode> & Pick<TeamNode, "id" | "kind">): TeamNode {
  return {
    role: null,
    model: null,
    status: "running",
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    working_ms: null,
    working_ms_source: null,
    started_at: null,
    settled: false,
    description: null,
    parent_id: null,
    dismissed_at: null,
    subagents: [],
    task: null,
    ...over,
  };
}

const TASK = {
  id: "task-1",
  round: 601,
  role: "builder",
  title: "601 · derivation core",
  status: "done",
};

const tree: TeamResponse = {
  chat_id: "chat-1",
  now: "2026-08-06T10:00:00.000Z",
  project: { id: "proj-1", status: "running" },
  link_source: "metadata",
  link_ambiguous: false,
  /* `kind` is a `TeamNodeKind`: "operator" | "worker" | "cron" | "unknown" |
   * "subagent" (teamApi.ts:30, over AgentKind in live/agentsApi.ts:60). The
   * manager IS the chat run, which the server ships as `agent_kind: "operator"`
   * (chat.ts:548), and a project worker run as "worker". "operator_chat" and
   * "project_worker" were never members of this union — see the note under
   * section 2 for what that did and did not cost this instrument. */
  manager: node({ id: "manager-run", kind: "operator" }),
  workers: [
    node({
      id: RUN_A,
      kind: "worker",
      role: "architect",
      task: TASK,
      subagents: [node({ id: SUB, kind: "subagent", parent_id: RUN_A, role: "Explore" })],
    }),
    node({ id: RUN_B, kind: "worker", role: "builder" }),
  ],
  complete: true,
  errors: [],
};

/* ── WHAT `kind` IS ACTUALLY WORTH TO THIS SECTION ────────────────────────
 *
 * Until this line was written the fixture above carried "operator_chat" and
 * "project_worker", two strings `TeamNodeKind` has never contained, and every
 * assertion in this file passed — before the correction and after it, byte for
 * byte. So it is worth saying exactly which assertions read `kind` at all.
 *
 * Three do, and all three through ONE predicate: `findTeamNode`
 * (OrientationStrip.tsx:237-249) discriminates on `kind === "subagent"` and
 * nothing else.
 *
 *   · "a sub-agent is found by tool_use_id under its parent" — needs
 *     `sub.kind === "subagent"` to be true, or the sub-agent branch never matches.
 *   · "a run id is never satisfied by a sub-agent whose id happens to equal it"
 *     — needs it to be true again, this time to make the run branch REFUSE.
 *   · "a worker is found by run id" / "the manager is found by run id" — need
 *     `kind !== "subagent"`, which every non-subagent literal satisfies.
 *
 * That is one bit of coverage: subagent, or not. NO assertion in this file
 * distinguishes "operator" from "worker" from "cron" from "unknown", and no
 * assertion would have failed had the manager been declared a cron. The
 * instrument's coverage of `kind` is smaller than the union it types against,
 * which is precisely why nothing here objected to two literals the server
 * cannot produce. Recorded, not fixed: inventing an assertion about a
 * distinction OrientationStrip does not make would test a strip that does not
 * exist. */

check("a worker is found by run id", findTeamNode(tree, RUN_A)?.id, RUN_A);
check("the manager is found by run id", findTeamNode(tree, "manager-run")?.id, "manager-run");
check(
  "a sub-agent is found by tool_use_id under its parent",
  findTeamNode(tree, RUN_A, SUB)?.id,
  SUB,
);
check(
  "the SAME sub-agent id under a DIFFERENT parent does not match",
  findTeamNode(tree, RUN_B, SUB),
  null,
);
check("an unknown run id does not match", findTeamNode(tree, "nope"), null);
check(
  "a run id is never satisfied by a sub-agent whose id happens to equal it",
  findTeamNode(tree, SUB),
  null,
);

/* ── 3. Degrade coverage ──────────────────────────────────────────────────── */

console.log("\n── every degraded state is named, never blank (NFU6) ──");

const okQuery: CachedTeamQuery = { status: "success", data: tree, error: null };

function facts(queries: CachedTeamQuery[], runId: string, subId?: string) {
  return derivePlanFacts(readTeam(queries, runId, subId));
}

check("no active team query → team-not-polling", facts([], RUN_A).degraded, "team-not-polling");
check(
  "an errored query → team-error",
  facts([{ status: "error", data: undefined, error: new Error("500") }], RUN_A).degraded,
  "team-error",
);
check(
  "a pending query → team-loading",
  facts([{ status: "pending", data: undefined, error: null }], RUN_A).degraded,
  "team-loading",
);
check(
  "a live tree that does not contain the node → node-absent",
  facts([okQuery], "some-other-run").degraded,
  "node-absent",
);
check("a node with no task → no-task", facts([okQuery], RUN_B).degraded, "no-task");
check("a node with a task → not degraded", facts([okQuery], RUN_A).degraded, null);
check("…and it carries the task title", facts([okQuery], RUN_A).task?.title, TASK.title);
check("…and derives phase 600 from round 601", facts([okQuery], RUN_A).plan?.phase, 600);
check("…with 700 next", facts([okQuery], RUN_A).plan?.next, 700);

// A degraded reading never carries a task or a plan — the two halves cannot
// come apart, which is what stops a stale title sitting beside a fresh round.
for (const [name, f] of [
  ["team-not-polling", facts([], RUN_A)],
  ["node-absent", facts([okQuery], "nope")],
  ["no-task", facts([okQuery], RUN_B)],
] as const) {
  check(`${name} carries no task`, f.task, null);
  check(`${name} carries no plan`, f.plan, null);
}

const ALL_REASONS: DegradeReason[] = [
  "team-not-polling",
  "team-error",
  "team-loading",
  "node-absent",
  "no-task",
];
for (const r of ALL_REASONS) {
  check(`"${r}" has rendered text`, typeof DEGRADE_TEXT[r] === "string" && DEGRADE_TEXT[r].length > 0, true);
}

// A cache entry holding something that is not a team response must not be read
// as one — the cache is typed `unknown` and this is the guard that means it.
check("a junk payload is not a TeamResponse", isTeamResponse({ hello: "world" }), false);
check("null is not a TeamResponse", isTeamResponse(null), false);
check("the real tree is", isTeamResponse(tree), true);
check(
  "a junk payload degrades rather than matching",
  facts([{ status: "success", data: { hello: "world" }, error: null }], RUN_A).degraded,
  "team-loading",
);

// Two trees active at once (a chat switch in flight): the one that CONTAINS
// the node wins, whichever order they arrive in.
const otherTree: TeamResponse = { ...tree, chat_id: "chat-2", workers: [] };
check(
  "the tree containing the node wins over one that does not",
  facts([{ status: "success", data: otherTree, error: null }, okQuery], RUN_A).task?.round,
  601,
);

/* ── 4. Activity taxonomy ─────────────────────────────────────────────────── */

console.log("\n── the four observed activity kinds, per round-599 §taxonomy ──");

check("a non-object activity is null", parseActivity("nope"), null);
check("an empty object is null, not four blanks", parseActivity({}), null);

const assistant = parseActivity({
  kind: "assistant_text",
  tool: null,
  text: "Round 0 complete.",
  ts: "2026-08-05T07:02:25.964Z",
});
check("assistant_text → writing", assistant && activityLine(assistant).verb, "writing");
check(
  "…with the prose verbatim as its detail",
  assistant && activityLine(assistant).detail,
  "Round 0 complete.",
);

const toolCall = parseActivity({ kind: "tool_call", tool: "Bash", text: null, ts: "x" });
check("tool_call → calling <tool>", toolCall && activityLine(toolCall).verb, "calling Bash");

// The observed trap: the executor sometimes puts the tool name in `text` too.
const echoed = parseActivity({ kind: "tool_call", tool: "Bash", text: "Bash", ts: "x" });
check(
  "…and the tool name is not repeated as its own detail",
  echoed && activityLine(echoed).detail,
  null,
);

const toolResult = parseActivity({
  kind: "tool_result",
  tool: "Grep",
  text: "12 matches",
  ts: "x",
});
check("tool_result → <tool> returned", toolResult && activityLine(toolResult).verb, "Grep returned");
check("…with the outcome snippet", toolResult && activityLine(toolResult).detail, "12 matches");

const thinking = parseActivity({ kind: "thinking", tool: null, text: null, ts: "x" });
check("thinking → thinking", thinking && activityLine(thinking).verb, "thinking");
check("…with no detail to show", thinking && activityLine(thinking).detail, null);

const unseen = parseActivity({ kind: "compaction", tool: null, text: null, ts: "x" });
check("an unseen kind is shown verbatim", unseen && activityLine(unseen).verb, "compaction");
check("…and marked as not understood", unseen && activityLine(unseen).known, false);
check("a known kind is marked known", assistant && activityLine(assistant).known, true);

// Clipping is a leading VERBATIM substring, marked. Nothing is reworded.
const long = "a".repeat(200);
const clipped = clipLine(long, 130);
check("a long line is clipped to the budget + ellipsis", clipped.text.length, 131);
check("…and marked clipped", clipped.clipped, true);
check("…and is a prefix of the original", long.startsWith(clipped.text.slice(0, -1)), true);
check("a short line is untouched", clipLine("hello", 130).text, "hello");
check("…and not marked", clipLine("hello", 130).clipped, false);
check("newlines collapse to spaces for a one-line strip", clipLine("a\n\nb", 130).text, "a b");

/* ── 5. The real capture ──────────────────────────────────────────────────── */

console.log("\n── against the 285-entry reference run ──");

const FIXTURE = "../docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json";
try {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const runValue = (raw as { run?: unknown }).run;
  const metadata = (runValue as { metadata?: Record<string, unknown> }).metadata ?? {};
  const real = parseActivity(metadata.current_activity);
  check("the reference run has a current_activity", real !== null, true);
  check("…of kind assistant_text", real?.kind, "assistant_text");
  check("…rendered as 'writing'", real === null ? null : activityLine(real).verb, "writing");
  check(
    "…whose detail is the architect's own words, verbatim",
    real === null ? false : (real.text ?? "").startsWith("Round 0 complete."),
    true,
  );
  check(
    "…and it carries the timestamp the executor stamped",
    real?.ts,
    "2026-08-05T07:02:25.964Z",
  );
} catch (err) {
  failures++;
  console.log(`FAIL  could not read ${FIXTURE}: ${(err as Error).message}`);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — orientation strip derivation`,
);
process.exit(failures === 0 ? 0 : 1);
