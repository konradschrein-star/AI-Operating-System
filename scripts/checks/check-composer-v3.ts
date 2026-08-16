/**
 * check-composer-v3.ts — executable unit check for the phase-800 composer:
 * `clampAutogrow` / `rowsToPx` / `normaliseScrollHeight` in
 * forge-control-web/app/desktop/chat/useAutogrow.ts (U28), and the effort
 * colour ramp in forge-control-web/app/desktop/chat/effort-ramp.ts (U29).
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-plan-store.ts and check-team-rows.ts, deliberately.
 *
 * No DOM: the sizing decision was deliberately factored out of the layout
 * effect into a pure function precisely so that it could be checked here, on a
 * table of pixel values, rather than only by eyeballing a browser.
 *
 * The four claims this file exists to hold down:
 *   1. an empty composer clamps to EXACTLY minPx — this is the "reset on send"
 *      guarantee (setDraft("") re-runs the effect, the empty box measures one
 *      row, one row is below two rows, so it lands on minPx and nowhere else);
 *   2. the cap boundary is closed on the correct side — exactly at the cap the
 *      height is maxPx with NO scrollbar, one pixel over is maxPx WITH one;
 *   3. the ramp covers every value of ENGINE_EFFORT_CHOICES exactly once, in
 *      cost order, so a new effort level cannot ship uncoloured;
 *   4. every colour the ramp returns is a `var(--fg-*)` token reference — NFU1
 *      has no exceptions, including for a colour that only appears on hover.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  clampAutogrow,
  normaliseScrollHeight,
  rowsToPx,
  type BoxMetrics,
} from "../../forge-control-web/app/desktop/chat/useAutogrow.ts";
import {
  EFFORT_RAMP,
  EFFORT_RAMP_ORDER,
  effortRamp,
  type EffortRamp,
} from "../../forge-control-web/app/desktop/chat/effort-ramp.ts";
import { ENGINE_EFFORT_CHOICES } from "../../forge-control-web/app/api.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
  }
}

function checkThrows(name: string, fn: () => unknown) {
  try {
    fn();
    failures += 1;
    console.log(`FAIL  ${name}\n        expected a throw, got a value`);
  } catch (err) {
    console.log(`PASS  ${name} (${(err as Error).message})`);
  }
}

/* ---------------------------------------------------------------------------
 * 1. Autogrow clamp (U28)
 *
 * Fixture = the real composer: font-size 13, line-height 1.5 (19.5px), padding
 * 10px top and bottom, 1px border, border-box (globals.css sets it globally).
 * minRows 2, maxRows 10 — COMPOSER_ROWS in ChatSurface.tsx.
 * ------------------------------------------------------------------------ */

const M: BoxMetrics = {
  lineHeightPx: 19.5,
  padPx: 20,
  borderPx: 2,
  borderBox: true,
};

const MIN_PX = rowsToPx(M, 2); // round(39 + 22)  = 61
const MAX_PX = rowsToPx(M, 10); // round(195 + 22) = 217

check("rowsToPx: 2 rows (border-box)", MIN_PX, 61);
check("rowsToPx: 10 rows (border-box)", MAX_PX, 217);
check(
  "rowsToPx: content-box excludes padding + border",
  rowsToPx({ ...M, borderBox: false }, 2),
  39,
);

/** scrollHeight the browser reports for `n` wrapped rows: content + padding. */
const scrollFor = (rows: number) => M.lineHeightPx * rows + M.padPx;

check(
  "normaliseScrollHeight: border-box adds the border back",
  normaliseScrollHeight(M, scrollFor(1)),
  41.5,
);
check(
  "normaliseScrollHeight: content-box subtracts the padding",
  normaliseScrollHeight({ ...M, borderBox: false }, scrollFor(1)),
  19.5,
);

interface ClampCase {
  name: string;
  measured: number;
  expected: { height: number; overflowY: "auto" | "hidden" };
}

const CLAMP_CASES: ClampCase[] = [
  {
    // Empty composer: the browser still reports one row of content.
    name: "empty draft → exactly minPx, no scrollbar (reset-on-send)",
    measured: normaliseScrollHeight(M, scrollFor(1)),
    expected: { height: MIN_PX, overflowY: "hidden" },
  },
  {
    name: "one line → still minPx (a 1-row box never renders)",
    measured: normaliseScrollHeight(M, scrollFor(1)),
    expected: { height: MIN_PX, overflowY: "hidden" },
  },
  {
    name: "two lines → the resting height itself",
    measured: normaliseScrollHeight(M, scrollFor(2)),
    expected: { height: MIN_PX, overflowY: "hidden" },
  },
  {
    name: "five lines → grown, still no scrollbar",
    measured: normaliseScrollHeight(M, scrollFor(5)),
    expected: { height: 119.5, overflowY: "hidden" },
  },
  {
    name: "exactly at the cap → maxPx, NO scrollbar",
    measured: MAX_PX,
    expected: { height: MAX_PX, overflowY: "hidden" },
  },
  {
    name: "one px over the cap → maxPx WITH a scrollbar",
    measured: MAX_PX + 1,
    expected: { height: MAX_PX, overflowY: "auto" },
  },
  {
    name: "25 lines → pinned at the cap, scrolls internally",
    measured: normaliseScrollHeight(M, scrollFor(25)),
    expected: { height: MAX_PX, overflowY: "auto" },
  },
  {
    name: "absurd paste (1000 lines) → still exactly the cap",
    measured: normaliseScrollHeight(M, scrollFor(1000)),
    expected: { height: MAX_PX, overflowY: "auto" },
  },
  {
    name: "zero measurement (unlaid-out element) → minPx, never 0",
    measured: 0,
    expected: { height: MIN_PX, overflowY: "hidden" },
  },
];

for (const c of CLAMP_CASES) {
  check(`clampAutogrow: ${c.name}`, clampAutogrow(c.measured, MIN_PX, MAX_PX), c.expected);
}

// Explicit error paths — a broken box model must be loud, not silently sized.
checkThrows("clampAutogrow: NaN measurement throws", () =>
  clampAutogrow(Number.NaN, MIN_PX, MAX_PX),
);
checkThrows("clampAutogrow: inverted bounds throw", () =>
  clampAutogrow(100, MAX_PX, MIN_PX),
);

/* ---------------------------------------------------------------------------
 * 2. Effort ramp (U29)
 * ------------------------------------------------------------------------ */

check(
  "ramp order == ENGINE_EFFORT_CHOICES (no drift between api.ts and the ramp)",
  [...EFFORT_RAMP_ORDER],
  [...ENGINE_EFFORT_CHOICES],
);
check(
  "ramp order is low < medium < high < xhigh (calm → hot)",
  [...EFFORT_RAMP_ORDER],
  ["low", "medium", "high", "xhigh"],
);

const rampKeys = Object.keys(EFFORT_RAMP);
check(
  "ramp table covers every choice exactly once (no extras, no gaps)",
  [...rampKeys].sort(),
  [...ENGINE_EFFORT_CHOICES].sort(),
);
check("ramp table has no duplicate keys", rampKeys.length, new Set(rampKeys).size);

for (const level of ENGINE_EFFORT_CHOICES) {
  const entry: EffortRamp | undefined = (EFFORT_RAMP as Record<string, EffortRamp>)[level];
  check(`ramp["${level}"] exists`, entry !== undefined, true);
  if (!entry) continue;
  check(
    `ramp["${level}"] has exactly {fg,border,bg}`,
    Object.keys(entry).sort(),
    ["bg", "border", "fg"],
  );
  for (const [slot, value] of Object.entries(entry)) {
    check(
      `ramp["${level}"].${slot} is a token reference (NFU1)`,
      typeof value === "string" && value.startsWith("var(--"),
      true,
    );
  }
  check(`effortRamp("${level}") returns that entry`, effortRamp(level), entry);
}

// Distinctness: a ramp whose rungs share a colour is not a ramp.
const fgs = ENGINE_EFFORT_CHOICES.map((e) => effortRamp(e).fg);
check("every rung has a distinct fg", new Set(fgs).size, ENGINE_EFFORT_CHOICES.length);
const bgs = ENGINE_EFFORT_CHOICES.map((e) => effortRamp(e).bg);
check("every rung has a distinct selected fill", new Set(bgs).size, ENGINE_EFFORT_CHOICES.length);

// "max" exists in the engine but is deliberately not offered in the UI; if a
// run carries it, the picker must still render rather than throw mid-paint.
check("effortRamp('max') falls to the calm rung", effortRamp("max"), EFFORT_RAMP.low);
check("effortRamp('') falls to the calm rung", effortRamp(""), EFFORT_RAMP.low);

console.log(
  failures === 0
    ? `\nOK — ${CLAMP_CASES.length} clamp cases + ramp table clean`
    : `\n${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
