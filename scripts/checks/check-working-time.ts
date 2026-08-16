/**
 * check-working-time.ts — executable unit check for the working-time module
 * (U5 of docs/plan/operator-visibility/12-ui-v3-requirements.md, model in
 * docs/plan/operator-visibility/13-ui-v3-architecture.md §4).
 *
 * vitest is not set up in either repo and NF4 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies,
 * one PASS/FAIL line per case, `process.exit(1)` if anything fails. Same
 * shape as `check-duration.ts` and `check-classify.ts`.
 *
 * Every expected value in the table below is hand-computed in its comment.
 * If a case ever fails, read the arithmetic there before touching the module:
 * the table is the specification, the module is the implementation.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-working-time.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, so it
 * needs its own invocation with the same compiler options):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/check-working-time.ts
 */

import {
  WORKING_MS_SQL,
  WORKING_TIME_CAP_MS,
  WORKING_MS_SOURCES,
  parseWorkingTs,
  workingMsFromTimestamps,
  workingMsRunningExtension,
  workingMsSql,
  workingTimeFromRollup,
  workingTimeFromTimestamps,
  type WorkingMsSource,
} from "../../forge-control/src/routes/working-time.ts";

/** Fixture epoch. Every timestamp below is expressed as an offset from it. */
const BASE = Date.parse("2026-08-05T12:00:00.000Z");
/** A clock six hours further on — the drift that turns wall-time into a lie. */
const MUCH_LATER = BASE + 6 * 60 * 60 * 1000;

const s = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

// ── The table ────────────────────────────────────────────────────────────
// Each row: a synthetic thread, the clock (undefined = settled node), and the
// hand-computed sum with its arithmetic.

interface Case {
  name: string;
  ts: unknown[];
  runningNowMs?: number;
  /** hand-computed working_ms */
  expected: number;
  /** hand-computed count of unparseable entries */
  expectedSkipped: number;
}

const CASES: Case[] = [
  {
    // gaps: 30s + 15s + 60s, all ≤ 120s → 30000 + 15000 + 60000
    name: "all gaps below cap → every gap counts in full",
    ts: [s(0), s(30), s(45), s(105)],
    expected: 105_000,
    expectedSkipped: 0,
  },
  {
    // gaps: 30s (counts) + 300s (> cap → 0) → 30000 + 0
    name: "one gap above cap → that gap contributes 0, NOT the cap",
    ts: [s(0), s(30), s(330)],
    expected: 30_000,
    expectedSkipped: 0,
  },
  {
    // gaps: 10s + 190s(>cap→0) + 10s + 5s → 10000 + 0 + 10000 + 5000
    name: "mixed — work, a long idle, work again",
    ts: [s(0), s(10), s(200), s(210), s(215)],
    expected: 25_000,
    expectedSkipped: 0,
  },
  {
    // gap of exactly the cap is INSIDE the cap: `gap ≤ CAP` counts in full
    name: "gap of exactly CAP counts in full (boundary, inclusive)",
    ts: [s(0), s(120)],
    expected: 120_000,
    expectedSkipped: 0,
  },
  {
    // one millisecond over the boundary → 0, no partial credit
    name: "gap of CAP+1ms contributes 0 (boundary, exclusive on the other side)",
    ts: ["2026-08-05T12:00:00.000Z", "2026-08-05T12:02:00.001Z"],
    expected: 0,
    expectedSkipped: 0,
  },
  {
    // a single entry has no consecutive pair → no gaps → 0
    name: "single entry → 0 (no pair, nothing to measure)",
    ts: [s(0)],
    expected: 0,
    expectedSkipped: 0,
  },
  {
    name: "empty thread → 0",
    ts: [],
    expected: 0,
    expectedSkipped: 0,
  },
  {
    // entries: 30s of gaps; now is 45s past the last entry (< cap)
    // → 30000 + min(45000, 120000) = 30000 + 45000
    name: "running node, now-extension below cap → + the full open interval",
    ts: [s(0), s(30)],
    runningNowMs: BASE + 75 * 1000,
    expected: 75_000,
    expectedSkipped: 0,
  },
  {
    // entries: 30s of gaps; now is 400s past the last entry (> cap)
    // → 30000 + min(400000, 120000) = 30000 + 120000
    // min() applies HERE and nowhere else — a live node that has been quiet
    // for an hour is credited two minutes, not an hour and not zero.
    name: "running node, now-extension above cap → + exactly CAP",
    ts: [s(0), s(30)],
    runningNowMs: BASE + 430 * 1000,
    expected: 150_000,
    expectedSkipped: 0,
  },
  {
    // open interval exactly CAP → min(120000, 120000)
    name: "running node, now-extension exactly CAP → + CAP",
    ts: [s(0)],
    runningNowMs: BASE + 120 * 1000,
    expected: 120_000,
    expectedSkipped: 0,
  },
  {
    // clock behind the last entry: negative open interval contributes 0
    name: "running node with now BEFORE the last entry → no negative credit",
    ts: [s(0), s(60)],
    runningNowMs: BASE + 30 * 1000,
    expected: 60_000,
    expectedSkipped: 0,
  },
  {
    // parseable: 0s, 40s, 70s → gaps 40s + 30s. The bad entry is SKIPPED,
    // so its neighbours become consecutive (40s), not zeroed and not thrown.
    name: "unparseable ts in the middle → skipped, neighbours join, counted",
    ts: [s(0), "sometime tuesday", s(40), s(70)],
    expected: 70_000,
    expectedSkipped: 1,
  },
  {
    // null / number / undefined are all "not a timestamp": 3 skipped,
    // surviving 0s and 20s → one 20s gap
    name: "null, number and undefined entries → all skipped and counted",
    ts: [s(0), null, 1_754_395_200_000, undefined, s(20)],
    expected: 20_000,
    expectedSkipped: 3,
  },
  {
    // gaps: +60s, −30s (out of order → 0), +60s → 60000 + 0 + 60000
    name: "out-of-order timestamps → negative gap contributes 0, never negative",
    ts: [s(0), s(60), s(30), s(90)],
    expected: 120_000,
    expectedSkipped: 0,
  },
  {
    // Postgres renders timestamptz with a space and a +00 offset; V8 parses it
    // gaps: 30s + 30s
    name: "Postgres 'YYYY-MM-DD HH:MM:SS.ffffff+00' rendering parses",
    ts: [
      "2026-07-30 16:21:19.000000+00",
      "2026-07-30 16:21:49.000000+00",
      "2026-07-30 16:22:19.000000+00",
    ],
    expected: 60_000,
    expectedSkipped: 0,
  },
];

console.log("── core: workingTimeFromTimestamps ───────────────────────────");
for (const c of CASES) {
  const opts = c.runningNowMs === undefined ? {} : { runningNowMs: c.runningNowMs };
  const got = workingTimeFromTimestamps(c.ts, opts);
  check(c.name, got.working_ms, c.expected);
  check(`  …skipped_ts counted: ${c.name}`, got.skipped_ts, c.expectedSkipped);
  check(`  …source is "thread": ${c.name}`, got.working_ms_source, "thread");
  check(
    `  …workingMsFromTimestamps agrees: ${c.name}`,
    workingMsFromTimestamps(c.ts, opts),
    c.expected,
  );
  check(`  …never negative: ${c.name}`, got.working_ms >= 0, true);
}

console.log("\n── frozen truth: a settled node never sees the clock ─────────");
{
  // Same entries, two clocks six hours apart, no runningNowMs: identical.
  const ts = [s(0), s(30), s(400), s(430)];
  const a = workingMsFromTimestamps(ts);
  const b = workingMsFromTimestamps(ts, {});
  check("settled result is clock-independent (30s + idle + 30s)", a, 60_000);
  check("settled result identical when opts omitted vs empty", a === b, true);
  check(
    "the same list WITH a running clock differs — proving the clock is wired",
    workingMsFromTimestamps(ts, { runningNowMs: MUCH_LATER }) > a,
    true,
  );
}

console.log("\n── running extension helper ─────────────────────────────────");
check(
  "workingMsRunningExtension below cap → the open interval",
  workingMsRunningExtension(s(0), BASE + 45 * 1000),
  45_000,
);
check(
  "workingMsRunningExtension above cap → CAP",
  workingMsRunningExtension(s(0), MUCH_LATER),
  WORKING_TIME_CAP_MS,
);
check("workingMsRunningExtension with unparseable last ts → 0", workingMsRunningExtension("nope", MUCH_LATER), 0);
check("workingMsRunningExtension with null last ts → 0", workingMsRunningExtension(null, MUCH_LATER), 0);
check(
  "workingMsRunningExtension with now before last ts → 0, never negative",
  workingMsRunningExtension(s(60), BASE),
  0,
);

console.log("\n── rollup fallback shape (13 §4) ────────────────────────────");
{
  // A settled sub-agent with no attributable thread slice: wall span,
  // 300s = 300000ms, deliberately UNCAPPED, flagged "rollup".
  const settled = workingTimeFromRollup(s(0), s(300));
  check("rollup settled span → uncapped wall clock (300s)", settled.working_ms, 300_000);
  check("rollup settled flagged as source \"rollup\"", settled.working_ms_source, "rollup");
  check("rollup settled skipped_ts = 0", settled.skipped_ts, 0);

  // Running rollup: no end stamp, so `now` closes the span (90s).
  const running = workingTimeFromRollup(s(0), null, { runningNowMs: BASE + 90 * 1000 });
  check("rollup running uses now when there is no end stamp", running.working_ms, 90_000);
  check("rollup running flagged as source \"rollup\"", running.working_ms_source, "rollup");

  // Settled rollup ignores the clock entirely — frozen like everything else.
  check(
    "rollup settled ignores runningNowMs (frozen)",
    workingTimeFromRollup(s(0), s(300), { runningNowMs: MUCH_LATER }).working_ms,
    300_000,
  );

  // ── NULL, NOT ZERO (round 308, review finding 1) ───────────────────────
  // Every shape below has no independent end stamp, so the subtraction is 0
  // by construction rather than by measurement. `null` is the only honest
  // answer; a 0 renders as "did no work" for a sub-agent that demonstrably
  // worked. Source stays "rollup" in every one of them — the provenance flag
  // does not disappear just because the number is unknown.
  const synthesised = workingTimeFromRollup(s(0), s(0));
  check(
    "rollup with updated_at === started_at → null, NOT 0 (the synthesised sub-agent)",
    synthesised.working_ms,
    null,
  );
  check("  …still flagged \"rollup\"", synthesised.working_ms_source, "rollup");
  check("  …and counts no skipped stamp (both parsed fine)", synthesised.skipped_ts, 0);

  // End before start (clock skew): not a measurement either.
  check("rollup with end before start → null", workingTimeFromRollup(s(300), s(0)).working_ms, null);
  // Start with no end and no clock: nothing to measure against.
  check("rollup settled with a missing end stamp → null", workingTimeFromRollup(s(0), null).working_ms, null);
  check(
    "  …source survives the null",
    workingTimeFromRollup(s(0), null).working_ms_source,
    "rollup",
  );
  // Unparseable start → null and the bad stamp is counted.
  const bad = workingTimeFromRollup("last tuesday", s(300));
  check("rollup with unparseable start → null", bad.working_ms, null);
  check("rollup counts the unparseable stamp", bad.skipped_ts, 1);
  const badEnd = workingTimeFromRollup(s(0), "last tuesday");
  check("rollup with unparseable end → null", badEnd.working_ms, null);
  check("rollup counts the unparseable end stamp", badEnd.skipped_ts, 1);
  // Missing (null) stamps are absence, not malformation — nothing to count.
  check("rollup with null stamps → null working_ms", workingTimeFromRollup(null, null).working_ms, null);
  check("rollup with null stamps → 0 skipped (absent ≠ malformed)", workingTimeFromRollup(null, null).skipped_ts, 0);

  // A RUNNING rollup keeps zero, because `now` IS a second observation: a
  // sub-agent spawned this millisecond has really done 0 ms of work so far,
  // and the number ticks up on the next poll.
  check(
    "rollup running, spawned this instant → 0 (measured), not null",
    workingTimeFromRollup(s(0), null, { runningNowMs: BASE }).working_ms,
    0,
  );
  check(
    "rollup running with a clock behind the spawn → 0, never negative",
    workingTimeFromRollup(s(60), null, { runningNowMs: BASE }).working_ms,
    0,
  );
}

console.log("\n── parseWorkingTs ───────────────────────────────────────────");
check("ISO 8601 parses", parseWorkingTs("2026-08-05T06:47:23.678Z"), Date.parse("2026-08-05T06:47:23.678Z"));
check(
  "Postgres rendering parses",
  parseWorkingTs("2026-07-30 16:21:19.674825+00"),
  Date.parse("2026-07-30T16:21:19.674Z"),
);
check("garbage → null", parseWorkingTs("sometime tuesday"), null);
check("null → null", parseWorkingTs(null), null);
check("number → null (not a string, not coerced)", parseWorkingTs(BASE), null);

console.log("\n── constants and the SQL fragment ───────────────────────────");
check("CAP is 120_000 ms, in one place", WORKING_TIME_CAP_MS, 120_000);
const SOURCES: WorkingMsSource[] = ["thread", "rollup"];
check("working_ms_source values are exactly thread|rollup", WORKING_MS_SOURCES.join(","), SOURCES.join(","));
check("SQL fragment interpolates the ONE cap constant", WORKING_MS_SQL.includes(String(WORKING_TIME_CAP_MS)), true);
check(
  "SQL fragment does NOT use least(gap, CAP) — over-cap gaps must drop to 0",
  /least\s*\(/i.test(WORKING_MS_SQL),
  false,
);
check("SQL fragment gates on both bounds (>= 0 AND <= CAP)", /gap_ms >= 0 AND g\.gap_ms <= /.test(WORKING_MS_SQL), true);
check("SQL fragment orders by WITH ORDINALITY, not a bare row_number()", WORKING_MS_SQL.includes("WITH ORDINALITY"), true);
check("SQL fragment filters malformed ts before the cast", WORKING_MS_SQL.includes("->>'ts' ~ '"), true);
// Round 308, review finding 6: each stamp is truncated to whole milliseconds
// BEFORE the subtraction, which is what Date.parse does on the JS side.
// Truncating the gap instead would be a different function.
check(
  "SQL fragment truncates each stamp to whole ms before lag()",
  WORKING_MS_SQL.includes("trunc(extract(epoch FROM q.ts) * 1000) AS ms"),
  true,
);
check(
  "SQL fragment differences the TRUNCATED stamps, not the raw timestamps",
  /p\.ms - lag\(p\.ms\) OVER \(ORDER BY p\.ord\)/.test(WORKING_MS_SQL),
  true,
);
check(
  "SQL fragment no longer subtracts timestamptz values directly",
  /p\.ts - lag\(p\.ts\)/.test(WORKING_MS_SQL),
  false,
);
check("SQL fragment defaults to the `runs r` alias", WORKING_MS_SQL.includes("jsonb_array_elements(r.thread)"), true);
check("workingMsSql() takes a caller alias", workingMsSql("x.thread").includes("jsonb_array_elements(x.thread)"), true);
check("SQL fragment is a balanced parenthesised scalar expression", (() => {
  let depth = 0;
  for (const ch of WORKING_MS_SQL) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && WORKING_MS_SQL.trim().startsWith("(") && WORKING_MS_SQL.trim().endsWith(")");
})(), true);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — working-time (U5)`,
);
process.exit(failures === 0 ? 0 : 1);
