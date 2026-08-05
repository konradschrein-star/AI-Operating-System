/**
 * confirm-stream-506.ts — before/after evidence for round 505's blocking
 * finding #1: "the 150ms floor is a delay, not a gate".
 *
 * The reviewer's deterministic repro, run against BOTH machines in one
 * process, so the fix is a measured difference rather than a claim:
 *
 *   • PRE-506 — verbatim copy of the rules as they shipped in 8e6b243. An
 *     under-floor click returned `blocked:too-fast` and left `armed.at`
 *     untouched, so `sinceArm` kept growing THROUGH a click stream and crossed
 *     the floor on its own.
 *   • POST-506 — the real `decideXClick`, imported from the app. An
 *     under-floor click returns `rearm`, which re-stamps `armed.at` to that
 *     click, so the separation can never accumulate.
 *
 * Both are driven by the same replay of the panel's `handleX` reducer
 * (ChatTeamPanel.tsx), so the only variable is the rule under test. No React,
 * no DOM, no browser, no clock of its own: every `now` is an argument, which
 * is why this reproduces in milliseconds and identically on any machine.
 *
 * The browser attacks the reviewer mounted (15 real mouse clicks 20ms apart →
 * 2 terminates; 25 trusted autorepeat keydowns @33ms → 4 terminates) are the
 * same arithmetic delivered by a different transport, and their DOM-level
 * guards are asserted separately in `scripts/checks/check-team-confirm.ts`
 * ("spurious activations are dropped before the machine").
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx \
 *     ../docs/plan/artifacts/phase500/confirm-stream-506.ts
 *
 * Exits 1 if the post-fix machine ever fires on a sub-floor stream, or if the
 * pre-fix machine does NOT (which would mean this file has stopped reproducing
 * the bug it documents and is no longer evidence of anything).
 */

import {
  ARM_WINDOW_MS,
  decideXClick,
  type ArmedState,
} from "../../../../forge-control-web/app/desktop/team/confirm.ts";

const T0 = 1_800_000_000_000;
const ROW = "worker-a";

/** The floor as it shipped, hardcoded. It must NOT come from the import: round
 *  506 also raised the live floor to 500ms (four discrete clicks 350ms apart
 *  walked past 150ms while every one of them reported `detail: 1`), and a
 *  "before" that tracked the "after" would quietly stop reproducing anything. */
const PRE_506_FLOOR_MS = 150;

/* ── The pre-506 machine, copied verbatim from 8e6b243 ──────────────────────
 * Only rule 4 differs from the shipped file: it returned a bare block, so the
 * caller left the arming timestamp where it was. */
type OldDecision =
  | { action: "dismiss" | "arm" | "terminate"; id: string }
  | { action: "blocked"; reason: "capability" | "too-fast" };

function decideXClickPre506(i: {
  nodeId: string;
  settled: boolean;
  armed: ArmedState | null;
  nowMs: number;
  canTerminate: boolean;
}): OldDecision {
  if (i.settled) return { action: "dismiss", id: i.nodeId };
  if (i.armed === null || i.armed.id !== i.nodeId) return { action: "arm", id: i.nodeId };
  const sinceArm = i.nowMs - i.armed.at;
  if (sinceArm > ARM_WINDOW_MS) return { action: "arm", id: i.nodeId };
  if (sinceArm < PRE_506_FLOOR_MS) return { action: "blocked", reason: "too-fast" }; // ← the bug
  if (!i.canTerminate) return { action: "blocked", reason: "capability" };
  return { action: "terminate", id: i.nodeId };
}

/** The panel's `handleX` reducer, over a list of click timestamps. `arm` and
 *  `rearm` both write `{ id, at: nowMs }`; `terminate` clears the slot;
 *  `blocked` changes nothing. Identical for both machines. */
function replay(
  decide: (i: {
    nodeId: string;
    settled: boolean;
    armed: ArmedState | null;
    nowMs: number;
    canTerminate: boolean;
  }) => { action: string; id?: string },
  times: number[],
  canTerminate: boolean,
): { terminates: number; firedAt: number[] } {
  let armed: ArmedState | null = null;
  let terminates = 0;
  const firedAt: number[] = [];
  for (const nowMs of times) {
    const d = decide({ nodeId: ROW, settled: false, armed, nowMs, canTerminate });
    if (d.action === "arm" || d.action === "rearm") armed = { id: ROW, at: nowMs };
    else if (d.action === "terminate") {
      terminates++;
      firedAt.push(nowMs - T0);
      armed = null;
    }
  }
  return { terminates, firedAt };
}

const stream = (n: number, gap: number): number[] =>
  Array.from({ length: n }, (_, k) => T0 + k * gap);

interface Case {
  name: string;
  times: number[];
  /** What the post-fix machine must produce. */
  expect: number;
  /** Does this case reproduce the bug on the pre-fix machine? */
  reproducesBug: boolean;
}

const RAGGED: number[] = (() => {
  const gaps = [0, 5, 17, 3, 140, 90, 12, 148, 60, 33, 7, 149, 20];
  const t = [T0];
  for (const g of gaps) t.push(t[t.length - 1] + g);
  return t;
})();

const CASES: Case[] = [
  { name: "reviewer's repro: 20 clicks @30ms", times: stream(20, 30), expect: 0, reproducesBug: true },
  /* Three clicks 60ms apart accumulate only 120ms, so even the pre-506
   * machine never fired on this one — it is here as the regression floor the
   * reviewer asked for ("add a ≥3-click stream case"), not as a repro. */
  { name: "3 clicks @60ms (minimum stream)", times: stream(3, 60), expect: 0, reproducesBug: false },
  { name: "3 clicks @149ms (just under the floor)", times: stream(3, 149), expect: 0, reproducesBug: true },
  { name: "held-key cadence: 30 clicks @33ms", times: stream(30, 33), expect: 0, reproducesBug: true },
  { name: "click spam: 200 clicks @10ms", times: stream(200, 10), expect: 0, reproducesBug: true },
  { name: "ragged sub-floor stream (14 clicks)", times: RAGGED, expect: 0, reproducesBug: true },
  /* Found by round 506's own browser protocol (case B3), not by the reviewer:
   * discrete clicks spaced wider than the OLD floor but inside the platform's
   * multi-click window, each reporting detail 1 so the double-click guard
   * never sees them. This is why the floor is now 500ms. */
  { name: "rage-click: 8 clicks @350ms", times: stream(8, 350), expect: 0, reproducesBug: true },
  { name: "6 clicks @499ms", times: stream(6, 499), expect: 0, reproducesBug: true },
  { name: "two deliberate clicks, 1s apart", times: [T0, T0 + 1_000], expect: 1, reproducesBug: false },
  {
    name: "burst then a pause past the floor",
    times: [T0, T0 + 20, T0 + 40, T0 + 60, T0 + 1_000],
    expect: 1,
    reproducesBug: false,
  },
];

let failures = 0;

console.log("Round 506 — finding #1 before/after (capabilities.terminate = TRUE,");
console.log("i.e. the state the engine lane will ship; today every flag is false).\n");
console.log(
  "case                                       pre-506   post-506   expected",
);
console.log(
  "─────────────────────────────────────────  ───────   ────────   ────────",
);

for (const c of CASES) {
  const before = replay(decideXClickPre506, c.times, true);
  const after = replay(decideXClick, c.times, true);
  const ok = after.terminates === c.expect;
  const bugOk = !c.reproducesBug || before.terminates > 0;
  if (!ok || !bugOk) failures++;
  console.log(
    `${c.name.padEnd(42)} ${String(before.terminates).padStart(7)}   ` +
      `${String(after.terminates).padStart(8)}   ${String(c.expect).padStart(8)}` +
      `${ok ? "" : "   ← FAIL"}${bugOk ? "" : "   ← no longer reproduces"}`,
  );
  if (c.reproducesBug && before.firedAt.length > 0) {
    console.log(
      `${" ".repeat(43)}pre-506 fired at t+${before.firedAt.join("ms, t+")}ms`,
    );
  }
}

/* Capabilities as they actually are today: the stream must be inert on BOTH
 * machines, which is why round 505 measured 0 non-GET requests even while the
 * bypass existed. The fix matters for the day the flag flips, not for today. */
const todayBefore = replay(decideXClickPre506, stream(200, 10), false).terminates;
const todayAfter = replay(decideXClick, stream(200, 10), false).terminates;
console.log(
  `\ncapabilities OFF (today): pre-506 ${todayBefore} terminates, post-506 ${todayAfter}`,
);
if (todayBefore !== 0 || todayAfter !== 0) failures++;

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — ` +
    "sub-floor streams fire nothing; deliberate double-clicks still fire once",
);
process.exit(failures === 0 ? 0 : 1);
