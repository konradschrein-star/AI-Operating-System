/**
 * check-team-confirm.ts — executable red-team of the team panel's destructive
 * control machine (`forge-control-web/app/desktop/team/confirm.ts`).
 *
 * 14-ui-v3-quality.md §500 puts this round under a RED-TEAM review: "X/stop on
 * running vs settled rows with all-false capabilities (must be inert + visibly
 * disabled); confirm-step bypass by rapid clicks". Those are assertions about
 * a state machine, so they are asserted against the state machine — in
 * milliseconds, with a synthetic clock, repeatable by anyone — rather than only
 * through a browser where a passing run proves the attack was mounted badly
 * just as easily as it proves the defence held.
 *
 * What it covers, in the brief's own words:
 *   • fire-without-arm     = no-op   (first click can only ever arm)
 *   • fire-under-the-floor = no-op   (dblclick / two clicks in one tick)
 *   • arm + 3.1s           = disarmed (stale arming re-arms, never fires)
 *   • capability-false     = the guard returns EVEN WHEN ARMED
 * plus: settled X dismisses on one click, arming a second row disarms the
 * first, stop is gated the same way, and a backwards clock lands on the safe
 * side.
 *
 * Round 506 adds the case whose absence let a real bypass ship: this script
 * only ever replayed click PAIRS, and the attack is a STREAM. A swallowed
 * click used to leave the arming timestamp untouched, so `sinceArm` grew
 * through a burst of clicks and crossed the 150ms floor on its own — 20 clicks
 * 30ms apart produced three terminates, and one held Enter key produced four.
 * The "sustained click STREAMS" section below replays the panel's reducer over
 * bursts of 3 to 200 activations (fixed, ragged, and autorepeat cadence) and
 * asserts zero terminates, while still asserting that two DELIBERATE clicks
 * fire exactly once — a gate that never opens is not a fix.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so this is a
 * plain tsx script: table-driven, zero dependencies, one PASS/FAIL line per
 * case, `process.exit(1)` if anything fails. Same shape as check-team-rows.ts,
 * deliberately.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-team-confirm.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  ARM_WINDOW_MS,
  MIN_CONFIRM_MS,
  capabilityTitle,
  decideRestoreAllClick,
  decideStopClick,
  decideXClick,
  isArmed,
  isSpuriousActivation,
  type ArmedState,
  type XDecision,
} from "../../forge-control-web/app/desktop/team/confirm.ts";

/** A fixed synthetic clock. Nothing here reads `Date.now()` — the machine
 *  takes `nowMs` as an argument precisely so the confirm floor and the 3s window
 *  can be crossed instantly instead of waited out. */
const T0 = 1_800_000_000_000;

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

/** Decisions compare as one readable string: "arm:worker-a", "blocked:capability". */
function tag(d: XDecision): string {
  return d.action === "blocked" ? `blocked:${d.reason}` : `${d.action}:${d.id}`;
}

const RUNNING = "worker-a";
const OTHER = "worker-b";
const SETTLED = "worker-done";

/** The world as it is today: every control-plane flag false (U8). */
const TODAY = { canTerminate: false } as const;
/** The world after engine-v2-research-lane ships the contract. */
const LATER = { canTerminate: true } as const;

const armedAt = (id: string, at: number): ArmedState => ({ id, at });

console.log("── constants ────────────────────────────────────────────────");
check("arm window is 3s (U17)", ARM_WINDOW_MS, 3_000);
check("confirm floor is 500ms — the platform multi-click window", MIN_CONFIRM_MS, 500);
check(
  "the disabled tooltip names the contract flag (NFU6)",
  capabilityTitle("terminate"),
  "engine support pending (control plane contract: terminate)",
);

console.log("\n── fire-without-arm ─────────────────────────────────────────");
{
  // The single most important property: there is no input to a FIRST click on
  // a running row that produces a terminate. Not with capabilities on, not
  // with a clock hours away from anything.
  const first = decideXClick({
    nodeId: RUNNING,
    settled: false,
    armed: null,
    nowMs: T0,
    ...LATER,
  });
  check("first click on a running row arms, never fires", tag(first), `arm:${RUNNING}`);
  check(
    "…and with capabilities off it still only arms",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed: null, nowMs: T0, ...TODAY })),
    `arm:${RUNNING}`,
  );
  check(
    "an arming on a DIFFERENT row does not count as this row's arming",
    tag(
      decideXClick({
        nodeId: RUNNING,
        settled: false,
        armed: armedAt(OTHER, T0),
        nowMs: T0 + 1_000,
        ...LATER,
      }),
    ),
    `arm:${RUNNING}`,
  );
  check(
    "…and arming this row is what disarms the other (one slot, this id wins)",
    isArmed(armedAt(RUNNING, T0 + 1_000), OTHER, T0 + 1_000),
    false,
  );
}

console.log("\n── fire under the floor: double-click bypass ────────────────");
{
  const armed = armedAt(RUNNING, T0);
  // Two click events dispatched in the SAME tick — the synthetic-dblclick
  // attack. Delta 0. `rearm` is the swallow: it fires nothing AND pushes the
  // window forward to this click (round 505 finding #1).
  check(
    "two clicks in the same tick: second is swallowed",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0, ...LATER })),
    `rearm:${RUNNING}`,
  );
  check(
    "a physical double-click (40ms) is swallowed",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 40, ...LATER })),
    `rearm:${RUNNING}`,
  );
  check(
    "499ms is still too fast",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 499, ...LATER })),
    `rearm:${RUNNING}`,
  );
  check(
    "a clock that ran backwards lands on the safe side",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 - 5_000, ...LATER })),
    `rearm:${RUNNING}`,
  );
  check(
    "a swallowed click does NOT disarm — the row is still armed after it",
    isArmed(armed, RUNNING, T0 + 40),
    true,
  );
  check(
    "the floor exactly is a deliberate second click (capabilities on → fires)",
    tag(
      decideXClick({
        nodeId: RUNNING,
        settled: false,
        armed,
        nowMs: T0 + MIN_CONFIRM_MS,
        ...LATER,
      }),
    ),
    `terminate:${RUNNING}`,
  );
}

console.log("\n── sustained click STREAMS (round 505 finding #1) ───────────");
{
  /**
   * The panel's `handleX` reducer, replayed without React.
   *
   * This is the case the old check script could not see, because it only ever
   * replayed click PAIRS: a swallowed click used to leave `armed.at` alone, so
   * `sinceArm` kept growing THROUGH a stream and crossed the floor on
   * its own. Twenty clicks 30ms apart produced three terminates. The fix is
   * that a too-fast click re-stamps the window, and this replay is what holds
   * it in place — mirroring the component exactly: `arm` and `rearm` both
   * write `{ id, at: nowMs }`, `terminate` clears the slot.
   */
  function replayStream(
    times: number[],
    canTerminate: boolean,
  ): { terminates: number; decisions: string[] } {
    let armed: ArmedState | null = null;
    let terminates = 0;
    const decisions: string[] = [];
    for (const nowMs of times) {
      const d = decideXClick({
        nodeId: RUNNING,
        settled: false,
        armed,
        nowMs,
        canTerminate,
      });
      decisions.push(tag(d));
      switch (d.action) {
        case "arm":
        case "rearm":
          armed = { id: d.id, at: nowMs };
          break;
        case "terminate":
          terminates++;
          armed = null;
          break;
        default:
          break;
      }
    }
    return { terminates, decisions };
  }

  /** n clicks, `gap` ms apart, starting at T0. */
  const stream = (n: number, gap: number): number[] =>
    Array.from({ length: n }, (_, k) => T0 + k * gap);

  // The reviewer's exact repro: t=0,30,60,…,570 with the flag ON.
  const r30 = replayStream(stream(20, 30), true);
  check("20 clicks 30ms apart, capabilities ON → terminates", r30.terminates, 0);
  check(
    "…and every click after the first is a rearm, never a fire",
    r30.decisions.slice(1).every((d) => d === `rearm:${RUNNING}`),
    true,
  );
  // The minimum stream the reviewer asked to be guarded: three clicks.
  check("3 clicks 60ms apart → terminates", replayStream(stream(3, 60), true).terminates, 0);
  check("3 clicks 149ms apart → terminates", replayStream(stream(3, 149), true).terminates, 0);
  // The case the 150ms floor let through: discrete clicks, each reporting
  // detail 1, spaced wider than the old floor but inside the platform's
  // multi-click window (round 506 browser protocol, case B3).
  check("8 clicks 350ms apart (rage-click) → terminates", replayStream(stream(8, 350), true).terminates, 0);
  check("6 clicks 499ms apart → terminates", replayStream(stream(6, 499), true).terminates, 0);
  // Autorepeat cadence (33ms) held for a full second, and a click-spam rate no
  // human sustains.
  check("30 clicks 33ms apart (held key cadence) → terminates", replayStream(stream(30, 33), true).terminates, 0);
  check("200 clicks 10ms apart → terminates", replayStream(stream(200, 10), true).terminates, 0);
  check("…the same 200-click stream with capabilities OFF", replayStream(stream(200, 10), false).terminates, 0);
  // Ragged timing: a stream whose gaps vary but never reach the floor.
  {
    const gaps = [0, 5, 17, 3, 140, 90, 12, 148, 60, 33, 7, 149, 20];
    const times: number[] = [T0];
    for (const g of gaps) times.push(times[times.length - 1] + g);
    check("a ragged sub-floor stream (14 clicks) → terminates", replayStream(times, true).terminates, 0);
  }
  // The confirm step must still WORK. Two deliberate clicks a second apart are
  // the whole point of the control; if this stops firing the gate has become a
  // wall and the engine lane inherits a dead button.
  check(
    "two deliberate clicks 1s apart still fire exactly once",
    replayStream([T0, T0 + 1_000], true).terminates,
    1,
  );
  check(
    "…and with capabilities OFF the same pair fires nothing",
    replayStream([T0, T0 + 1_000], false).terminates,
    0,
  );
  check(
    "a stream that PAUSES past the floor fires once, at the pause",
    replayStream([T0, T0 + 20, T0 + 40, T0 + 60, T0 + 1_000], true).terminates,
    1,
  );
}

console.log("\n── spurious activations are dropped before the machine ──────");
{
  // The DOM half of finding #1, as a value rather than an inline lambda: the
  // browser tells us when an activation is the tail of a gesture (`detail`)
  // or a key repeating itself (`repeat`), and neither is a decision.
  check("a plain single click is honoured", isSpuriousActivation({ detail: 1, repeat: false }), false);
  check("the 2nd click of a double-click is dropped", isSpuriousActivation({ detail: 2, repeat: false }), true);
  check("the 3rd of a triple-click is dropped", isSpuriousActivation({ detail: 3, repeat: false }), true);
  check("a 15th rapid click is dropped", isSpuriousActivation({ detail: 15, repeat: false }), true);
  check(
    "keyboard activation (detail 0) is honoured",
    isSpuriousActivation({ detail: 0, repeat: false }),
    false,
  );
  check(
    "…but an autorepeat keydown is dropped — one held Enter is one decision",
    isSpuriousActivation({ detail: 0, repeat: true }),
    true,
  );
  check(
    "25 autorepeat keydowns yield 0 activations",
    Array.from({ length: 25 }, () => isSpuriousActivation({ detail: 0, repeat: true })).filter(
      (dropped) => !dropped,
    ).length,
    0,
  );
}

console.log("\n── arm + 3.1s: the arming goes stale ────────────────────────");
{
  const armed = armedAt(RUNNING, T0);
  check(
    "at 3.0s the arming still holds",
    isArmed(armed, RUNNING, T0 + ARM_WINDOW_MS),
    true,
  );
  check(
    "at 3.1s it reads as disarmed even though no timer ran",
    isArmed(armed, RUNNING, T0 + 3_100),
    false,
  );
  check(
    "…and a click at 3.1s RE-ARMS instead of firing (capabilities on)",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 3_100, ...LATER })),
    `arm:${RUNNING}`,
  );
  check(
    "a five-minute-old 'sure?' cannot be cashed in",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 300_000, ...LATER })),
    `arm:${RUNNING}`,
  );
}

console.log("\n── capability-false: the guard holds even when armed ────────");
{
  // The devtools attack: strip `disabled`, click once to arm, wait past the
  // floor, click again. This is the click that must dead-end.
  const armed = armedAt(RUNNING, T0);
  check(
    "armed + past the floor + capabilities off → blocked at the gate",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 500, ...TODAY })),
    "blocked:capability",
  );
  check(
    "…at the very end of the arm window too",
    tag(
      decideXClick({
        nodeId: RUNNING,
        settled: false,
        armed,
        nowMs: T0 + ARM_WINDOW_MS,
        ...TODAY,
      }),
    ),
    "blocked:capability",
  );
  check(
    "the SAME input with the flag on is the only thing that fires",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 500, ...LATER })),
    `terminate:${RUNNING}`,
  );
}

console.log("\n── settled rows: dismiss is one click, and reversible ───────");
{
  check(
    "X on a settled row dismisses immediately",
    tag(decideXClick({ nodeId: SETTLED, settled: true, armed: null, nowMs: T0, ...TODAY })),
    `dismiss:${SETTLED}`,
  );
  check(
    "…even while another row is armed",
    tag(
      decideXClick({
        nodeId: SETTLED,
        settled: true,
        armed: armedAt(RUNNING, T0),
        nowMs: T0 + 10,
        ...TODAY,
      }),
    ),
    `dismiss:${SETTLED}`,
  );
  check(
    "…and capabilities are irrelevant to it (nothing leaves the browser)",
    tag(decideXClick({ nodeId: SETTLED, settled: true, armed: null, nowMs: T0, ...LATER })),
    `dismiss:${SETTLED}`,
  );
}

console.log("\n── stop ─────────────────────────────────────────────────────");
{
  const blocked = decideStopClick({ nodeId: RUNNING, settled: false, canStop: false });
  check("stop with the flag off is blocked at the gate", blocked.action, "blocked");
  check(
    "…with reason 'capability'",
    blocked.action === "blocked" ? blocked.reason : "<not blocked>",
    "capability",
  );
  const settledStop = decideStopClick({ nodeId: SETTLED, settled: true, canStop: true });
  check(
    "stopping an already-settled row is refused, not faked",
    settledStop.action === "blocked" ? settledStop.reason : "<not blocked>",
    "settled",
  );
  const ok = decideStopClick({ nodeId: RUNNING, settled: false, canStop: true });
  check("stop fires only with the flag on and a live row", ok.action, "stop");
}

console.log("\n── exhaustive sweep: nothing fires today ────────────────────");
{
  // Every combination the machine can be handed with TODAY's capabilities.
  // Not one of them may produce a terminate — that is the round's headline
  // claim, and this is the check that earns it.
  const armings: (ArmedState | null)[] = [
    null,
    armedAt(RUNNING, T0),
    armedAt(OTHER, T0),
    armedAt(RUNNING, T0 - 10_000),
    armedAt(RUNNING, T0 + 10_000),
  ];
  const clocks = [T0 - 1_000, T0, T0 + 1, T0 + 149, T0 + 499, T0 + 500, T0 + 2_999, T0 + 3_001, T0 + 1e7];
  let terminates = 0;
  let total = 0;
  for (const armed of armings) {
    for (const nowMs of clocks) {
      for (const settled of [true, false]) {
        total++;
        const d = decideXClick({
          nodeId: RUNNING,
          settled,
          armed,
          nowMs,
          canTerminate: false,
        });
        if (d.action === "terminate") terminates++;
      }
    }
  }
  check(`${total} combinations swept, terminates issued`, terminates, 0);
}

/* ── restore-all (round 1355, from round 1354's review A4) ─────────────────
 *
 * `restoreAll` deletes every dismissal on the machine. Round 1354's review
 * clicked a control labelled "N hidden · show" and lost eleven dismissals it
 * had made in a different panel — no peek, no confirm, no undo. The label is
 * fixed in ./peek; the confirm is this machine, and it is asserted here for the
 * same reason the ✕ machine is: a confirm step you can only attack through a
 * browser is a confirm step nobody re-attacks.
 */
console.log("\n── restore-all: the two-click confirm ───────────────────────");
{
  check(
    "first click can only ARM — a fresh control never restores",
    decideRestoreAllClick({ armedAt: null, nowMs: T0 }).action,
    "arm",
  );
  check(
    "a second click after a real pause restores",
    decideRestoreAllClick({ armedAt: T0, nowMs: T0 + MIN_CONFIRM_MS }).action,
    "restore-all",
  );
  check(
    "…and 1ms under the floor does not",
    decideRestoreAllClick({ armedAt: T0, nowMs: T0 + MIN_CONFIRM_MS - 1 }).action,
    "rearm",
  );
  check(
    "a double-click's trailing half is swallowed",
    decideRestoreAllClick({ armedAt: T0, nowMs: T0 }).action,
    "rearm",
  );
  check(
    "a stale arming re-arms rather than firing",
    decideRestoreAllClick({ armedAt: T0, nowMs: T0 + ARM_WINDOW_MS + 1 }).action,
    "arm",
  );
  check(
    "exactly at the arm window, still a confirm",
    decideRestoreAllClick({ armedAt: T0, nowMs: T0 + ARM_WINDOW_MS }).action,
    "restore-all",
  );
  check(
    "a clock that ran backwards lands on the safe side",
    decideRestoreAllClick({ armedAt: T0, nowMs: T0 - 10_000 }).action,
    "rearm",
  );
}
{
  /* The stream attack that beat the ✕ machine in round 505, replayed against
   * this one: the panel's own reducer (arm/rearm both write `nowMs`), driven by
   * bursts at every cadence a hand or a keyboard can produce. A `rearm` that
   * failed to re-stamp the window would let separation accumulate and fire. */
  const cadences = [0, 1, 20, 30, 33, 120, 350, 499];
  let fired = 0;
  let bursts = 0;
  for (const gap of cadences) {
    for (const clicks of [3, 10, 50, 200]) {
      bursts++;
      let armedAt: number | null = null;
      for (let i = 0; i < clicks; i++) {
        const nowMs = T0 + i * gap;
        const d = decideRestoreAllClick({ armedAt, nowMs });
        if (d.action === "restore-all") {
          fired++;
          armedAt = null;
        } else {
          armedAt = nowMs;
        }
      }
    }
  }
  check(`${bursts} sub-floor click streams, restore-alls issued`, fired, 0);
}
{
  // …and the gate still opens for a person. Two clicks, 800ms apart.
  let armedAt: number | null = null;
  let fired = 0;
  for (const nowMs of [T0, T0 + 800]) {
    const d = decideRestoreAllClick({ armedAt, nowMs });
    if (d.action === "restore-all") {
      fired++;
      armedAt = null;
    } else {
      armedAt = nowMs;
    }
  }
  check("two deliberate clicks restore exactly once", fired, 1);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — team confirm machine`,
);
process.exit(failures === 0 ? 0 : 1);
