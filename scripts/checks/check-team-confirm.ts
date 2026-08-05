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
 *   • fire-within-150ms    = no-op   (dblclick / two clicks in one tick)
 *   • arm + 3.1s           = disarmed (stale arming re-arms, never fires)
 *   • capability-false     = the guard returns EVEN WHEN ARMED
 * plus: settled X dismisses on one click, arming a second row disarms the
 * first, stop is gated the same way, and a backwards clock lands on the safe
 * side.
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
  decideStopClick,
  decideXClick,
  isArmed,
  type ArmedState,
  type XDecision,
} from "../../forge-control-web/app/desktop/team/confirm.ts";

/** A fixed synthetic clock. Nothing here reads `Date.now()` — the machine
 *  takes `nowMs` as an argument precisely so the 150ms floor and the 3s window
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
check("confirm floor is 150ms", MIN_CONFIRM_MS, 150);
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

console.log("\n── fire-within-150ms: double-click bypass ───────────────────");
{
  const armed = armedAt(RUNNING, T0);
  // Two click events dispatched in the SAME tick — the synthetic-dblclick
  // attack. Delta 0.
  check(
    "two clicks in the same tick: second is swallowed",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0, ...LATER })),
    "blocked:too-fast",
  );
  check(
    "a physical double-click (40ms) is swallowed",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 40, ...LATER })),
    "blocked:too-fast",
  );
  check(
    "149ms is still too fast",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 + 149, ...LATER })),
    "blocked:too-fast",
  );
  check(
    "a clock that ran backwards lands on the safe side",
    tag(decideXClick({ nodeId: RUNNING, settled: false, armed, nowMs: T0 - 5_000, ...LATER })),
    "blocked:too-fast",
  );
  check(
    "a swallowed click does NOT disarm — the row is still armed after it",
    isArmed(armed, RUNNING, T0 + 40),
    true,
  );
  check(
    "150ms exactly is a deliberate second click (capabilities on → fires)",
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
  const clocks = [T0 - 1_000, T0, T0 + 1, T0 + 149, T0 + 150, T0 + 2_999, T0 + 3_001, T0 + 1e7];
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

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — team confirm machine`,
);
process.exit(failures === 0 ? 0 : 1);
