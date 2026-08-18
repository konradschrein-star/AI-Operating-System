/**
 * check-r1875-fixes.ts — round 1874's five findings, as assertions.
 *
 * Same contract as check-r1873-fixes.ts: every finding whose fix has a pure
 * core is asserted here, so the next round cannot re-introduce it by editing a
 * condition. What is NOT here, and why:
 *
 *   FINDING 3 (an armed ✕ can't be called off) — the fix is two document
 *     listeners mounted while `armedId !== null` (ChatTeamPanel.tsx,
 *     AgentActivity.tsx). There is no function to call; what IS assertable is
 *     that both panels tell the operator the gesture exists, which is the half
 *     that was missing from the screen. The Escape keypress itself is a browser
 *     measurement — see the harness in docs/plan/artifacts/phase1875/.
 *   FINDING 5 (the phone menu button is 34px) — a literal in a style object.
 *     Asserted by reading the source below, because a number in JSX is exactly
 *     the kind of thing that silently regresses and there is nothing else to
 *     import.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-r1875-fixes.ts
 */

import { readFileSync } from "node:fs";
import {
  CANCEL_HINT,
  confirmStripText,
  hideToastText,
} from "../../forge-control-web/app/desktop/team/confirm";
import { dismissedToggleTitle, DISMISSAL_SURFACES } from "../../forge-control-web/app/desktop/team/peek";
import { flattenTeam, rowsHiddenBy } from "../../forge-control-web/app/desktop/team/teamRows";
import type {
  TeamNode,
  TeamResponse,
} from "../../forge-control-web/app/desktop/team/teamApi";
import { rowsHiddenBy as liveRowsHiddenBy } from "../../forge-control-web/app/desktop/live/agentsApi";
import type { AgentRow } from "../../forge-control-web/app/desktop/live/agentsApi";
import {
  discriminatingId,
  isSubagentId,
  shortNodeId,
} from "../../forge-control-web/app/desktop/short-id";
import {
  commsHeader,
  readComms,
  shortRunId,
} from "../../forge-control-web/app/desktop/chat/comms-identity";
import type { PeerFacts } from "../../forge-control-web/app/desktop/chat/comms-identity";
import {
  mergePeerFacts,
  unresolvedPeerIds,
  type PeerRecord,
} from "../../forge-control-web/app/desktop/chat/peersApi";

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

function contains(label: string, haystack: string, needle: string): void {
  check(`${label} — contains “${needle}”`, haystack.includes(needle), true);
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const NO_TOKENS = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };

function node(over: Partial<TeamNode> & { id: string }): TeamNode {
  return {
    kind: "worker",
    role: "builder",
    model: "claude-opus-5",
    status: "completed",
    tokens: NO_TOKENS,
    working_ms: 1_000,
    working_ms_source: "thread",
    started_at: "2026-08-17T10:00:00.000Z",
    settled: true,
    description: "a task",
    parent_id: null,
    dismissed_at: null,
    subagents: [],
    task: null,
    ...over,
  };
}

function response(over: Partial<TeamResponse>): TeamResponse {
  return {
    chat_id: "chat-1",
    now: "2026-08-17T10:10:00.000Z",
    project: { id: "p1", status: "active" },
    link_source: "metadata",
    link_ambiguous: false,
    complete: true,
    errors: [],
    manager: node({
      id: "manager",
      kind: "operator",
      role: null,
      settled: false,
      status: "running",
    }),
    workers: [],
    ...over,
  } as TeamResponse;
}

const NONE: ReadonlySet<string> = new Set<string>();

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 1 — every comms card names its sender
 *
 * "28 of 128 comms cards don't say who spoke … `◂ c8bc5ffa unknown role`, an
 * 8-character id fragment and the literal words 'unknown role' where the
 * agent's name and role belong … The data exists: `c8bc5ffa` is a planner,
 * 'operator-visibility · Plan phase 800: composer v3', but the thread stores
 * only `peer_run_id` and the feed it joins against holds 60 recent runs."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── which peers actually need looking up ─────────────────────");
{
  const entry = (over: Record<string, unknown>) => ({
    meta: { comms: { direction: "in", from: "worker", ...over } },
  });
  const OLD = "c8bc5ffa-f63e-4f11-af27-39e3c8fb9e2f";
  const NEW = "4e842cc8-bab9-4e9b-9d34-0523b1931419";
  const IN_TREE = "e69ea9a8-232c-4b3f-aa9a-f1b2c6fb334f";
  const tree = new Map<string, PeerFacts>([
    [IN_TREE, { role: "builder", description: "Fix cycle 2" }],
  ]);

  check(
    "an un-stamped peer nobody knows is asked about",
    unresolvedPeerIds([entry({ peer_run_id: OLD })], tree),
    [OLD],
  );
  check(
    "a STAMPED peer is never asked about — the stamp already named it",
    unresolvedPeerIds([entry({ peer_run_id: NEW, peer_role: "builder" })], tree),
    [],
  );
  check(
    "a peer the team tree already knows is not asked about either",
    unresolvedPeerIds([entry({ peer_run_id: IN_TREE })], tree),
    [],
  );
  check(
    "Konrad has no run to look up",
    unresolvedPeerIds([entry({ from: "konrad", peer_run_id: OLD })], tree),
    [],
  );
  check(
    "a sub-agent tool_use_id is never sent to a route that queries uuids",
    unresolvedPeerIds([entry({ peer_run_id: "toolu_01AeuQskZPyHpsYrHayvrqrT" })], tree),
    [],
  );
  check(
    "a non-comms entry contributes nothing",
    unresolvedPeerIds([{ meta: { tool: "Bash" } }], tree),
    [],
  );
  check("no thread, no request", unresolvedPeerIds(null, tree), []);
  check(
    "the same peer twice is one id, and the order is STABLE (it is a query key)",
    unresolvedPeerIds(
      [entry({ peer_run_id: NEW }), entry({ peer_run_id: OLD }), entry({ peer_run_id: NEW })],
      tree,
    ),
    [NEW, OLD].sort(),
  );
  check(
    "…so two identical threads produce the same key",
    unresolvedPeerIds([entry({ peer_run_id: NEW }), entry({ peer_run_id: OLD })], tree).join(),
    unresolvedPeerIds([entry({ peer_run_id: OLD }), entry({ peer_run_id: NEW })], tree).join(),
  );
  check(
    "the batch is bounded, and the bound is the server's",
    unresolvedPeerIds(
      Array.from({ length: 40 }, (_, i) =>
        entry({ peer_run_id: `c8bc5ffa-f63e-4f11-af27-${String(i).padStart(12, "0")}` }),
      ),
      tree,
      10,
    ).length,
    10,
  );
}

console.log("\n── the lookup fills gaps and never overwrites the tree ──────");
{
  const A = "c8bc5ffa-f63e-4f11-af27-39e3c8fb9e2f";
  const B = "4e842cc8-bab9-4e9b-9d34-0523b1931419";
  const tree = new Map<string, PeerFacts>([
    [B, { role: "builder", description: "Fix cycle 3 (live)" }],
  ]);
  const looked: PeerRecord[] = [
    { id: A, role: "planner", description: "Plan phase 800: composer v3", project: "operator-visibility" },
    { id: B, role: "builder", description: "Fix cycle 3 (stale)", project: "operator-visibility" },
  ];
  const merged = mergePeerFacts(tree, looked);
  check("the missing peer gains a role", merged.get(A)?.role, "planner");
  check("…and a name", merged.get(A)?.description, "Plan phase 800: composer v3");
  check(
    "the POLLED tree still outranks the cached lookup",
    merged.get(B)?.description,
    "Fix cycle 3 (live)",
  );
  check(
    "a lookup that adds nothing returns the SAME map object (no re-render)",
    mergePeerFacts(tree, [{ id: B, role: "builder", description: "x", project: null }]) === tree,
    true,
  );
  check("no answer at all is the same map", mergePeerFacts(tree, undefined) === tree, true);
  check(
    "a peer the database has never seen adds no entry",
    mergePeerFacts(tree, [{ id: A, role: null, description: null, project: null }]).has(A),
    false,
  );
}

console.log("\n── and the card then says the name, not the id ──────────────");
{
  const facts = readComms({
    comms: { direction: "in", from: "worker", peer_run_id: "c8bc5ffa-f63e-4f11" },
  });
  if (facts === null) throw new Error("fixture is not a comms entry");

  const unnamed = commsHeader(facts, null);
  check("with nothing known it still says so honestly", unnamed.role, "unknown role");

  const named = commsHeader(facts, {
    role: "planner",
    description: "Plan phase 800: composer v3",
  });
  check("with the lookup's answer it leads with the name", named.name, "Plan phase 800: composer v3");
  check("…and the role", named.role, "planner");
  /* The tooltip is the whole point of finding 1's second half — the header line
   * ellipsises at 190px, so the FULL name has to be somewhere. */
  contains("the tooltip carries the full name", named.summary, "Plan phase 800: composer v3");
  contains("…the role", named.summary, "planner");
  contains("…and the id", named.summary, "c8bc5ff");
  check(
    "a card whose only name IS its role does not print it twice",
    commsHeader(facts, { role: "planner", description: null }).summary,
    "◂ from worker · planner · c8bc5ffa",
  );
  check(
    "the exact string the tester quoted is unreachable once a peer is resolved",
    named.summary.includes("unknown role"),
    false,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 2 — one gesture, one number the reader can act on
 *
 * "The toast says '180 rows hidden'; the dismissed tray four inches above it
 * says '21 dismissed · show'. Each is locally true … but side by side they read
 * as a bug, and the customer cannot tell which number the 'show' link will
 * restore."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── the toast reconciles itself with the tray ────────────────");
{
  check("one row is one row", hideToastText({ hidden: 1, here: 1 }), "row hidden");
  check(
    "a cascade wholly inside this tree keeps the old, correct sentence",
    hideToastText({ hidden: 3, here: 3 }),
    "3 rows hidden — this row and everything settled under it",
  );
  const wide = hideToastText({ hidden: 180, here: 21 });
  contains("the tester's numbers: what LEFT this panel, first", wide, "21 rows hidden here");
  contains("…what was hidden in total", wide, "180 in total");
  contains("…and what the undo will restore", wide, "undo restores all 180");
  check(
    "the two numbers can never be swapped: `here` is clamped to `hidden`",
    hideToastText({ hidden: 4, here: 99 }),
    "4 rows hidden — this row and everything settled under it",
  );
  contains(
    "a cascade that took nothing off THIS panel says that too",
    hideToastText({ hidden: 12, here: 0 }),
    "all of them elsewhere in the fleet",
  );
  /* The number in the toast and the number in the tray must be the same KIND of
   * number, which is what this asserts about the tray's own tooltip. */
  contains(
    "the tray's tooltip says which number it is",
    dismissedToggleTitle(DISMISSAL_SURFACES.live),
    "the rows THIS panel is withholding",
  );
}

console.log("\n── rowsHiddenBy: counted by the walk that does the hiding ───");
{
  const withSubs = node({
    id: "worker-a",
    subagents: [
      node({ id: "toolu_014exr6WxDpq", kind: "subagent", parent_id: "worker-a" }),
      node({ id: "toolu_019chfnXBnJa", kind: "subagent", parent_id: "worker-a" }),
    ],
  });
  const tree = response({ workers: [withSubs, node({ id: "leaf" })] });
  const all = flattenTeam(tree, NONE);
  check("the fixture has 5 rows", all.rows.length, 5);
  check("hiding a leaf loses one row", rowsHiddenBy(tree, NONE, ["leaf"]), 1);
  check(
    "hiding a parent loses it AND its sub-agent lines",
    rowsHiddenBy(tree, NONE, ["worker-a"]),
    3,
  );
  check(
    "ids from other trees cost this panel nothing — the finding, in one number",
    rowsHiddenBy(tree, NONE, ["leaf", "some-other-run", "and-another"]),
    1,
  );
  check("nothing added, nothing lost", rowsHiddenBy(tree, NONE, []), 0);
  check(
    "re-hiding what is already hidden loses nothing further",
    rowsHiddenBy(tree, new Set(["leaf"]), ["leaf"]),
    0,
  );
  check(
    "…and it agrees with the tray, which is the whole point",
    rowsHiddenBy(tree, NONE, ["worker-a"]),
    flattenTeam(tree, new Set(["worker-a"])).hiddenCount,
  );
}

console.log("\n── the Live panel counts the same way ───────────────────────");
{
  const agent = (id: string, subs: string[]): AgentRow =>
    ({
      id,
      title: id,
      status: "completed",
      subagents: subs.map((s) => ({ tool_use_id: s })),
    }) as unknown as AgentRow;
  const agents = [agent("run-a", ["toolu_014exr6WxDpq"]), agent("run-b", [])];
  check("a run takes its sub-agent lines", liveRowsHiddenBy(agents, NONE, ["run-a"]), 2);
  check("a bare run takes one", liveRowsHiddenBy(agents, NONE, ["run-b"]), 1);
  check(
    "a sub-agent alone takes one",
    liveRowsHiddenBy(agents, NONE, ["toolu_014exr6WxDpq"]),
    1,
  );
  check(
    "an id outside this feed takes nothing",
    liveRowsHiddenBy(agents, NONE, ["a-run-in-another-project"]),
    0,
  );
  check(
    "an already-hidden run takes nothing further",
    liveRowsHiddenBy(agents, new Set(["run-a"]), ["run-a"]),
    0,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 3 — an armed ✕ can be called off, and says so
 *
 * "Pressed Escape — still `armed`. Clicked in the transcript — still `armed`.
 * Only a 3.09s timer disarms it … a customer who wants out has no way to say
 * so."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── the way out is on screen, in both panels' words ──────────");
{
  contains(
    "a cascade's strip offers the way out",
    confirmStripText({ settled: true, hidesRows: 165 }),
    CANCEL_HINT,
  );
  contains(
    "…so does a terminate's",
    confirmStripText({ settled: false, hidesRows: 1 }),
    CANCEL_HINT,
  );
  contains(
    "…and an uncountable cascade's",
    confirmStripText({ settled: true, hidesRows: 2, widerReach: true }),
    CANCEL_HINT,
  );
  contains("the hint names both gestures", CANCEL_HINT, "esc");
  contains("…including the pointer one", CANCEL_HINT, "click away");
  /* Round 1873's own assertion, restated: adding the hint must not have moved
   * the confirm instruction. */
  contains(
    "the confirm instruction survives",
    confirmStripText({ settled: true, hidesRows: 165 }),
    "✕ again to confirm",
  );

  /* Both panels mount the listeners. Asserted by reading the source: there is
   * no exported function, and a panel that lost this effect would otherwise
   * fail nothing until a human clicked a ✕ and pressed Escape. */
  const panels = [
    ["ChatTeamPanel", "forge-control-web/app/desktop/team/ChatTeamPanel.tsx", "[data-team-x]"],
    ["AgentActivity", "forge-control-web/app/desktop/live/AgentActivity.tsx", "[data-live-x]"],
  ] as const;
  for (const [name, path, selector] of panels) {
    const src = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    check(`${name} listens for Escape while armed`, src.includes('e.key === "Escape"'), true);
    check(`${name} listens for a pointer landing elsewhere`, src.includes('"pointerdown"'), true);
    check(
      `${name} leaves a click ON a ✕ to the machine (${selector})`,
      src.includes(`t.closest("${selector}")`),
      true,
    );
    check(
      `${name} removes both listeners when nothing is armed`,
      src.includes('removeEventListener("pointerdown"'),
      true,
    );
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 4 — two sub-agents are told apart
 *
 * "All 7 rows' tooltips end `· id toolu_01 ·` — the constant prefix, identical
 * for `toolu_014exr6W…` and `toolu_019chfnX…`."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── short-id: eight characters that discriminate ─────────────");
{
  const A = "toolu_014exr6WxDpqAAAAAAAAA";
  const B = "toolu_019chfnXBnJaBBBBBBBBB";
  check("a uuid keeps its first eight", discriminatingId("c8bc5ffa-f63e-4f11"), "c8bc5ffa");
  check("a sub-agent id drops the constant head", discriminatingId(A), "4exr6WxD");
  check("…and the other one differs in the first character", discriminatingId(B), "9chfnXBn");
  check("the two are not equal — the finding, in one line", discriminatingId(A) === discriminatingId(B), false);
  check(
    "the exact string the tester quoted is unreachable",
    [discriminatingId(A), discriminatingId(B)].some((s) => s.includes("toolu_01")),
    false,
  );
  check("a prefix with nothing after it keeps itself", discriminatingId("toolu_01"), "toolu_01");
  check("an id shorter than eight is itself", discriminatingId("abc"), "abc");
  check("is it a sub-agent id", [isSubagentId(A), isSubagentId("c8bc5ffa-f63e")], [true, false]);
  check("absent means what the caller says it means", shortNodeId(null, "none"), "none");
  check("…and the comms column says it differently on purpose", shortRunId(null), "—");
  check("shortRunId follows the same rule", shortRunId(A), "4exr6WxD");
  check("an empty string is absent, not a zero-length label", shortNodeId("  ", "none"), "none");

  /* The two row tooltips that printed `toolu_01` — asserted at the source,
   * because they compose a native `title` string inside a component. */
  for (const path of [
    "forge-control-web/app/desktop/team/TeamRow.tsx",
    "forge-control-web/app/desktop/live/AgentActivity.tsx",
  ]) {
    const src = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    check(`${path.split("/").pop()} shortens ids through short-id`, src.includes("shortNodeId(id"), true);
    check(`…and no longer slices ids by hand`, /id\s*\?\s*id\.slice\(0, 8\)/.test(src), false);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 5 — the phone's menu button is a thumb target
 *
 * "The button is 34×34 while all 18 destinations inside the sheet are a correct
 * 44 px."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── the button that opens the sheet is as big as the sheet ───");
{
  const src = readFileSync(
    new URL("../../forge-control-web/app/desktop/DesktopApp.tsx", import.meta.url),
    "utf8",
  );
  const menu = src.slice(src.indexOf("data-nav-menu\n"), src.indexOf("data-nav-menu\n") + 1200);
  check("the menu button is 44 wide", /width: 44,/.test(menu), true);
  check("…and 44 tall", /height: 44,/.test(menu), true);
  check("34 is gone from it", /: 34,/.test(menu), false);
  /* It has to still FIT the 46px bar — a 44px control with vertical margin
   * would overflow and the header would grow. */
  check("no vertical margin was added to make it fit", /marginTop|marginBottom/.test(menu), false);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — round 1875 fixes`,
);
process.exit(failures === 0 ? 0 : 1);
