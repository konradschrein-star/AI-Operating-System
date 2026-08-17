/**
 * check-r1873-fixes.ts — round 1872's six findings, as assertions.
 *
 * Every finding whose fix has a pure core is asserted here, so the next round
 * cannot re-introduce it by editing a condition. What is NOT here, and why:
 *
 *   FINDING 1 (switcher looked dead for 7s) — the bug was a REF WRITTEN DURING
 *     RENDER being read by a click handler that ran before that render, plus a
 *     pressed state derived from the response instead of the request. Both are
 *     component wiring; there is no function to call. The observable contract
 *     is asserted in the browser instead: `data-team-state="switching"`,
 *     `[data-project-pending]` and `aria-pressed` inside one frame — see
 *     docs/plan/artifacts/phase1873/.
 *   FINDING 3 (11 of 14 destinations unreachable on a phone) — a menu that
 *     renders 18 buttons. Asserted below as a COVERAGE claim over `NAV`, which
 *     is the part that can silently rot: a group added to the rail and not to
 *     the sheet is exactly how three destinations went missing in the first
 *     place. The 390px reachability itself is a browser measurement.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-r1873-fixes.ts
 */

import {
  armedXLabel,
  confirmStripText,
  decideXClick,
  dismissTitle,
  needsConfirm,
} from "../../forge-control-web/app/desktop/team/confirm";
import {
  cascadeRowCount,
  flattenTeam,
} from "../../forge-control-web/app/desktop/team/teamRows";
import type {
  TeamNode,
  TeamResponse,
} from "../../forge-control-web/app/desktop/team/teamApi";
import {
  commsCensus,
  commsLedgerLine,
  commsLedgerTitle,
} from "../../forge-control-web/app/desktop/chat/comms-identity";
import {
  currentFrameLabel,
  type NavFrame,
} from "../../forge-control-web/app/desktop/chat/nav-stack";
import { restoredNavStack } from "../../forge-control-web/app/desktop/chat/stored-nav";
import {
  NAV,
  SURFACES,
  mobileNavDestinations,
} from "../../forge-control-web/app/desktop/nav-items";

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

const NO_TOKENS = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  total: 0,
};

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
    manager: node({ id: "manager", kind: "operator", role: null, settled: false, status: "running" }),
    workers: [],
    ...over,
  } as TeamResponse;
}

const NONE: ReadonlySet<string> = new Set<string>();

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 2 — the destructive direction is the guarded one
 *
 * "One click on a row's ✕ dismissed 174 nodes / 165 of 166 visible rows … No
 * confirm, no undo toast … Meanwhile 'restore all', the harmless direction,
 * still takes two clicks."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── blast radius: what one ✕ actually takes ──────────────────");

const leaf = node({ id: "leaf" });
const parentOfTwo = node({
  id: "worker-a",
  subagents: [
    node({ id: "toolu_01AAA", kind: "subagent", parent_id: "worker-a" }),
    node({ id: "toolu_01BBB", kind: "subagent", parent_id: "worker-a" }),
  ],
});

check("a leaf hides itself and nothing else", cascadeRowCount(leaf, NONE), 1);
check("a worker with two sub-agents hides three rows", cascadeRowCount(parentOfTwo, NONE), 3);
check(
  "…and only the ones still on screen: one sub-agent already hidden → two",
  cascadeRowCount(parentOfTwo, new Set(["toolu_01AAA"])),
  2,
);
check(
  "a row that is itself already dismissed still reports at least 1",
  cascadeRowCount(leaf, new Set(["leaf"])),
  1,
);

console.log("\n── the row carries the count, and keeps its identity ────────");
{
  const tree = response({ workers: [parentOfTwo, leaf] });
  const flat = flattenTeam(tree, NONE);
  const byId = new Map(flat.rows.map((r) => [r.node.id, r]));
  check("worker-a's row says 3", byId.get("worker-a")?.hidesRows, 3);
  check("its sub-agent's row says 1", byId.get("toolu_01AAA")?.hidesRows, 1);
  check("the manager's row counts its OWN subtree only", byId.get("manager")?.hidesRows, 1);
  /* The reason that last one is 1 and not 5: `hidesRows` is a row prop compared
   * by `sameRow`, and a manager count that read its siblings would refresh the
   * manager's wrapper every time any worker settled — breaking round 1302's
   * identity invariant for a fact about a different row. The manager's real
   * reach is stated in words instead (`widerReach`), asserted below. */
}

console.log("\n── needsConfirm: the guard is proportional ──────────────────");
check("a settled leaf: one click", needsConfirm({ settled: true, hidesRows: 1 }), false);
check("a settled row with one child: confirm", needsConfirm({ settled: true, hidesRows: 2 }), true);
check("165 rows: confirm", needsConfirm({ settled: true, hidesRows: 165 }), true);
check("a running row: always confirm (terminate)", needsConfirm({ settled: false, hidesRows: 1 }), true);
check(
  "an operator row whose reach cannot be counted: confirm even at 1",
  needsConfirm({ settled: true, hidesRows: 1, widerReach: true }),
  true,
);

console.log("\n── decideXClick: two clicks for a cascade, one for a leaf ───");
{
  const T0 = 1_800_000_000_000;
  const leafClick = decideXClick({
    nodeId: "leaf",
    settled: true,
    hidesRows: 1,
    armed: null,
    nowMs: T0,
    canTerminate: false,
  });
  check("first click on a settled LEAF dismisses", leafClick.action, "dismiss");

  const first = decideXClick({
    nodeId: "worker-a",
    settled: true,
    hidesRows: 165,
    armed: null,
    nowMs: T0,
    canTerminate: false,
  });
  check("first click on a CASCADE only arms", first.action, "arm");

  const tooFast = decideXClick({
    nodeId: "worker-a",
    settled: true,
    hidesRows: 165,
    armed: { id: "worker-a", at: T0 },
    nowMs: T0 + 120,
    canTerminate: false,
  });
  check("…a rage-click cannot confirm it", tooFast.action, "rearm");

  const deliberate = decideXClick({
    nodeId: "worker-a",
    settled: true,
    hidesRows: 165,
    armed: { id: "worker-a", at: T0 },
    nowMs: T0 + 600,
    canTerminate: false,
  });
  check("…a deliberate second click does", deliberate.action, "dismiss");

  const stale = decideXClick({
    nodeId: "worker-a",
    settled: true,
    hidesRows: 165,
    armed: { id: "worker-a", at: T0 },
    nowMs: T0 + 60_000,
    canTerminate: false,
  });
  check("…a minute-old “hide?” re-arms rather than firing", stale.action, "arm");

  /* The property the whole machine exists for: no single click, at any clock,
   * with any arming of ANOTHER row, ever hides more than one row. */
  let leaks = 0;
  let swept = 0;
  for (const hidesRows of [2, 3, 17, 165]) {
    for (const armed of [null, { id: "other", at: T0 }, { id: "worker-a", at: T0 + 5_000_000 }]) {
      for (const nowMs of [T0 - 1, T0, T0 + 1, T0 + 499, T0 + 3_001]) {
        swept += 1;
        const d = decideXClick({
          nodeId: "worker-a",
          settled: true,
          hidesRows,
          armed,
          nowMs,
          canTerminate: false,
        });
        if (d.action === "dismiss") leaks += 1;
      }
    }
  }
  check(`${swept} first-clicks on cascades swept, dismissals issued`, leaks, 0);
}

console.log("\n── the words say what will happen ──────────────────────────");
{
  const cascade = { settled: true, hidesRows: 165 };
  contains("the strip names the count", confirmStripText(cascade), "hide 165 rows");
  contains("…and how to confirm", confirmStripText(cascade), "✕ again to confirm");
  contains("the tooltip names the count", dismissTitle(cascade), "165 in total");
  contains("…and the undo", dismissTitle(cascade), "undo");
  contains(
    "a leaf's tooltip promises nothing else goes",
    dismissTitle({ settled: true, hidesRows: 1 }),
    "Nothing else goes with it",
  );
  contains(
    "an uncountable reach says so instead of guessing",
    dismissTitle({ settled: true, hidesRows: 2, widerReach: true }),
    "cannot count",
  );
  contains(
    "…and its strip marks the count as a floor",
    confirmStripText({ settled: true, hidesRows: 2, widerReach: true }),
    "2+ rows",
  );
  contains("a running row still asks about terminating", confirmStripText({ settled: false, hidesRows: 1 }), "terminate");
  /* Five characters, both of them: `X_COL` in TeamRow.tsx reserves exactly the
   * width of "sure?" so that arming a row moves no pixel (round 1355, finding
   * #4). A label that grew would reflow the row it is warning about. */
  check("the armed label is 5 chars — dismiss", armedXLabel({ settled: true, hidesRows: 165 }).length, 5);
  check("the armed label is 5 chars — terminate", armedXLabel({ settled: false, hidesRows: 1 }).length, 5);
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 4 — reload restores the drill-in, not just the chat
 *
 * "`forge.chat.navStack` is sitting in localStorage with the right runId and
 * label" and the worker view was replaced by the manager thread anyway.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── restoredNavStack: the decision table ─────────────────────");
{
  const CHAT = "bfd1283a-b71b-4f35-b577-7d09aad803f2";
  const WORKER = "4e842cc8-1111-4222-8333-444444444444";
  const stack = JSON.stringify({
    chatId: CHAT,
    frames: [{ kind: "agent", runId: WORKER, label: "Fix cycle 2" }],
  });

  const restored = restoredNavStack(stack, JSON.stringify(CHAT));
  check("a stack stored for the restored chat comes back", restored?.length, 1);
  check(
    "…with its frame intact, label and all",
    restored?.[0],
    { kind: "agent", runId: WORKER, label: "Fix cycle 2" },
  );
  check(
    "a two-level drill-in comes back whole",
    restoredNavStack(
      JSON.stringify({
        chatId: CHAT,
        frames: [
          { kind: "agent", runId: WORKER },
          { kind: "agent", runId: WORKER, subagentId: "toolu_01AeuQskZPyHpsYrHayvrqrT" },
        ],
      }),
      JSON.stringify(CHAT),
    )?.length,
    2,
  );
  check("no stored chat → manager chat", restoredNavStack(stack, null), null);
  check("no stored stack → manager chat", restoredNavStack(null, JSON.stringify(CHAT)), null);
  check(
    "a stack belonging to ANOTHER chat is dropped, never re-parented",
    restoredNavStack(stack, JSON.stringify(WORKER)),
    null,
  );
  check("an empty stack is the manager chat", restoredNavStack(
    JSON.stringify({ chatId: CHAT, frames: [] }),
    JSON.stringify(CHAT),
  ), null);
  check("half-written JSON is not a crash", restoredNavStack("{\"chatId\":", JSON.stringify(CHAT)), null);
  check(
    "a frame with no runId never reaches a fetch",
    restoredNavStack(
      JSON.stringify({ chatId: CHAT, frames: [{ kind: "agent" }] }),
      JSON.stringify(CHAT),
    ),
    null,
  );
  check(
    "a chat id that is not a uuid is refused",
    restoredNavStack(stack, JSON.stringify("../../etc/passwd")),
    null,
  );
  check(
    "a plandoc frame survives too",
    restoredNavStack(
      JSON.stringify({ chatId: CHAT, frames: [{ kind: "plandoc", name: "04-phases.md" }] }),
      JSON.stringify(CHAT),
    )?.length,
    1,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 5 — the breadcrumb says the name that was clicked
 *
 * "The row says 'Recon chat Bash block rendering'; the view it opens is titled
 * `sub-agent toolu_01`."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── currentFrameLabel ───────────────────────────────────────");
{
  const RUN = "4e842cc8-1111-4222-8333-444444444444";
  const TOOLU = "toolu_01AeuQskZPyHpsYrHayvrqrT";
  const clicked: NavFrame = {
    kind: "agent",
    runId: RUN,
    subagentId: TOOLU,
    label: "Recon chat Bash block rendering",
  };
  check(
    "the label the row passed is the label the crumb shows",
    currentFrameLabel(clicked, null),
    "Recon chat Bash block rendering",
  );
  check(
    "…and it outranks what the fetch learned",
    currentFrameLabel(clicked, "some spawn description"),
    "Recon chat Bash block rendering",
  );
  check(
    "no label → what the view learned",
    currentFrameLabel({ kind: "agent", runId: RUN, subagentId: TOOLU }, "Recon: timing data"),
    "Recon: timing data",
  );
  check(
    "neither → the DISCRIMINATING part of the id, never `toolu_01`",
    currentFrameLabel({ kind: "agent", runId: RUN, subagentId: TOOLU }, null),
    "sub-agent AeuQskZP",
  );
  check(
    "a session with nothing known says session + short id",
    currentFrameLabel({ kind: "agent", runId: RUN }, null),
    "session 4e842cc8",
  );
  check(
    "a blank label is not a label",
    currentFrameLabel({ kind: "agent", runId: RUN, label: "   " }, null),
    "session 4e842cc8",
  );
  check(
    "a doc frame is its own name",
    currentFrameLabel({ kind: "plandoc", name: "04-phases.md" }, null),
    "04-phases.md",
  );
  /* The exact string the tester quoted twice, in two rounds. If this ever comes
   * back, this line is the one that fails. */
  check(
    "the round-1871/1872 string is unreachable for a named sub-agent",
    currentFrameLabel(clicked, null).includes("toolu_01"),
    false,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 6 — the transcript says which half of the traffic it holds
 *
 * "All 119 cards are data-comms-direction='in' … this is honest rendering, not
 * a rendering bug. But the brief asked that a genuinely-absent payload be
 * documented, and the panel says nothing."
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── commsCensus / the ledger line ───────────────────────────");
{
  const inbound = (n: number) =>
    Array.from({ length: n }, () => ({
      meta: { comms: { direction: "in", from: "worker", peer_run_id: null } },
    }));
  const outbound = (n: number) =>
    Array.from({ length: n }, () => ({
      meta: { comms: { direction: "out", from: "worker", peer_run_id: null } },
    }));

  check("no thread → nothing counted", commsCensus(null), { in: 0, out: 0 });
  check("a thread with no comms → nothing counted", commsCensus([{ meta: { tool: "Bash" } }]), {
    in: 0,
    out: 0,
  });
  check("the operator chat's real shape: 120 in, 0 out", commsCensus(inbound(120)), {
    in: 120,
    out: 0,
  });
  check("a worker's own thread holds both", commsCensus([...inbound(1), ...outbound(1)]), {
    in: 1,
    out: 1,
  });
  check(
    "a malformed comms meta is not counted as either",
    commsCensus([{ meta: { comms: { direction: "sideways", from: "worker" } } }]),
    { in: 0, out: 0 },
  );

  check("nothing to say about a thread with no traffic", commsLedgerLine({ in: 0, out: 0 }), null);
  contains("the line counts both directions", commsLedgerLine({ in: 120, out: 0 }) ?? "", "120 received");
  contains("…including the zero", commsLedgerLine({ in: 120, out: 0 }) ?? "", "0 sent");
  contains(
    "…and does not leave the zero unexplained",
    commsLedgerLine({ in: 120, out: 0 }) ?? "",
    "no outbound records",
  );
  check(
    "a two-way thread gets no caveat",
    (commsLedgerLine({ in: 4, out: 4 }) ?? "").includes("no outbound"),
    false,
  );
  contains(
    "the tooltip names the mechanism, not just the symptom",
    commsLedgerTitle({ in: 120, out: 0 }),
    "run-control-rules.ts",
  );
  contains(
    "…and where those records actually are",
    commsLedgerTitle({ in: 120, out: 0 }),
    "own thread",
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * FINDING 3 — every destination is reachable on a phone
 *
 * "The top nav strip is 1,138px wide inside a 390px viewport … Only TODAY, CHAT
 * and PROJECTS sit inside the viewport; LIVE — the panel this project is about —
 * is at x=914 and cannot be reached by any gesture."
 *
 * The 390px measurement is a browser one. What is assertable here is the thing
 * that made the gap invisible: the destinations existed in two lists, and the
 * one the phone could see was the shorter one.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── the phone sheet covers the whole model ──────────────────");
{
  const reachable = new Set(mobileNavDestinations());
  const missing = NAV.filter((n) => !reachable.has(n.key)).map((n) => n.key);
  check("every NAV entry is reachable from the phone menu", missing, []);
  check("…including LIVE, the panel this project is about", reachable.has("live"), true);
  check("…and the three RECALL entries the top strip never had", [
    reachable.has("goals"),
    reachable.has("journal"),
    reachable.has("map"),
  ], [true, true, true]);
  check("…and SETTINGS, which is not in NAV at all", reachable.has("settings"), true);
  check("18 destinations, no duplicates", mobileNavDestinations().length, reachable.size);
  check(
    "every destination the menu offers is a real surface",
    mobileNavDestinations().filter((k) => !SURFACES.includes(k)),
    [],
  );
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — round 1873 fixes`,
);
process.exit(failures === 0 ? 0 : 1);
