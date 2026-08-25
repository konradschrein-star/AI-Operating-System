/**
 * Tests for StatsPanel's arithmetic.
 *
 * Run: cd forge-control-web && npx tsx --test app/desktop/stats/stats-math.test.ts
 * (node --test via tsx, the same runner as the two other web-side unit tests
 * under app/desktop/ — see README.md, which also records that NO gate executes
 * any of the three. The module under test imports nothing but types, so no DOM
 * and no fetch have to exist.)
 *
 * Two of these tests earn their place specifically:
 *
 *  - the `insufficientFeltSentence` test pins the string CHARACTER FOR
 *    CHARACTER against the brief. That sentence is the entire HabitFelt tile
 *    for the next ~60 days; a reworded version is a silently broken feature
 *    that still renders.
 *  - the throw tests prove the hard-error policy (PLAN.md §3.6) is real. A
 *    "no silent fallback" claim that no test exercises is a claim, and every
 *    one of these functions would happily return NaN instead if the guard were
 *    deleted tomorrow.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { DayCalendarStatsByArea, DayStatsDay, DayStatsHabit } from "../../api";
import {
  FELT_MAX,
  FELT_MIN,
  HABIT_GROUPS,
  feltOnScoreAxis,
  foldAreas,
  habitGroupBlocks,
  hoursText,
  insufficientFeltSentence,
  maxAbsDelta,
  movingAverage,
  scoredDays,
  signedBarGeometry,
} from "./stats-math";

/* ── fixtures ─────────────────────────────────────────────────────────── */

const habit = (
  key: string,
  grp: string,
  ticks: string[],
): DayStatsHabit => ({
  id: `id-${key}`,
  key,
  label: key,
  icon: "check",
  grp,
  rate30: 0,
  streak: 0,
  best: 0,
  ticks30: ticks,
  ticks,
});

const day = (d: string, score: number | null, subjective: number | null): DayStatsDay => ({
  day: d,
  score,
  habit_pct: null,
  goal_pct: null,
  task_pct: null,
  subjective,
});

/* ── movingAverage ────────────────────────────────────────────────────── */

describe("movingAverage", () => {
  test("the leading points average what exists, not zeros", () => {
    // The whole reason this is a trailing average over a shrinking window: a
    // 7-day MA that padded with zeros would start the line at ~14% of the
    // first real value and draw a rally that never happened.
    assert.deepEqual(movingAverage([10, 20, 30], 3), [10, 15, 20]);
  });

  test("a full window is the plain mean of the last n", () => {
    assert.deepEqual(movingAverage([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);
  });

  test("window of 1 is the identity", () => {
    assert.deepEqual(movingAverage([5, 9, 2], 1), [5, 9, 2]);
  });

  test("empty input is empty output, not a throw", () => {
    assert.deepEqual(movingAverage([], 7), []);
  });

  test("a non-positive or fractional window throws with the value", () => {
    assert.throws(() => movingAverage([1, 2], 0), /positive integer, got 0/);
    assert.throws(() => movingAverage([1, 2], 2.5), /positive integer, got 2.5/);
  });
});

/* ── feltOnScoreAxis ──────────────────────────────────────────────────── */

describe("feltOnScoreAxis", () => {
  test("both ends of the felt scale are both ends of the axis", () => {
    assert.equal(feltOnScoreAxis(FELT_MIN), 0);
    assert.equal(feltOnScoreAxis(FELT_MAX), 100);
  });

  test("a felt 5 sits BELOW the middle, because 5 is below the middle of 1..10", () => {
    // The off-by-one that a naive `subjective * 10` would hide: it would put
    // felt 5 at 50 and felt 1 at 10, so a worst-possible day would plot above
    // the axis floor and read as "some score".
    assert.equal(Math.round(feltOnScoreAxis(5)), 44);
    assert.equal(Math.round(feltOnScoreAxis(6)), 56);
  });

  test("out-of-range ratings throw rather than clamp", () => {
    // A rating of 47 is a backend contract break. Clamping it to 100 draws a
    // perfect day and loses the bug forever.
    assert.throws(() => feltOnScoreAxis(0), /must be 1\.\.10, got 0/);
    assert.throws(() => feltOnScoreAxis(11), /must be 1\.\.10, got 11/);
    assert.throws(() => feltOnScoreAxis(Number.NaN), /must be 1\.\.10/);
  });

  test("the pre-2026-08-25 five-point scale is NOT silently accepted as-is", () => {
    // Widening 1..5 to 1..10 means an old 5 now means "middling", not "best".
    // This asserts we map it as a 5 on the new scale — the migration's job is
    // to rescale stored rows, not this function's.
    assert.notEqual(feltOnScoreAxis(5), 100);
  });
});

/* ── scoredDays ───────────────────────────────────────────────────────── */

describe("scoredDays", () => {
  test("null-score days are dropped, not plotted as zero", () => {
    const out = scoredDays([day("2026-08-02", null, null), day("2026-08-01", 40, null)]);
    assert.deepEqual(out.map((d) => d.day), ["2026-08-01"]);
  });

  test("output is oldest first regardless of input order", () => {
    const out = scoredDays([
      day("2026-08-03", 30, null),
      day("2026-08-01", 10, null),
      day("2026-08-02", 20, null),
    ]);
    assert.deepEqual(out.map((d) => d.score), [10, 20, 30]);
  });

  test("a genuine score of 0 survives — it is not the same as null", () => {
    const out = scoredDays([day("2026-08-01", 0, null)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].score, 0);
  });
});

/* ── insufficientFeltSentence ─────────────────────────────────────────── */

describe("insufficientFeltSentence", () => {
  test("is the brief's sentence, character for character", () => {
    assert.equal(
      insufficientFeltSentence(0, 20),
      "0 of 20 rated days so far — rate a day on the board or in the journal; " +
        "this answers itself after ~60 days.",
    );
  });

  test("N comes from the payload, not from a constant", () => {
    assert.match(insufficientFeltSentence(13, 20), /^13 of 20 rated days so far —/);
  });

  test("the em dash and the tilde are the real characters", () => {
    // A hyphen or a 'roughly' here would pass a looser assertion and ship a
    // sentence that is not the one specified.
    const s = insufficientFeltSentence(3, 20);
    assert.ok(s.includes("—"), "expected an em dash U+2014");
    assert.ok(s.includes("~60 days"), "expected a literal ~60 days");
  });

  test("nonsense counts throw", () => {
    assert.throws(() => insufficientFeltSentence(-1, 20), /rated_days must be >= 0/);
    assert.throws(() => insufficientFeltSentence(1, 0), /needed must be >= 1/);
  });
});

/* ── signed bars ──────────────────────────────────────────────────────── */

describe("signedBarGeometry", () => {
  test("a positive delta grows right from the centre", () => {
    assert.deepEqual(signedBarGeometry(1, 2), { leftPct: 50, widthPct: 25, positive: true });
  });

  test("a negative delta grows LEFT and still ends at the centre", () => {
    const g = signedBarGeometry(-2, 2);
    assert.deepEqual(g, { leftPct: 0, widthPct: 50, positive: false });
    assert.equal(g.leftPct + g.widthPct, 50, "a negative bar must terminate on the axis");
  });

  test("the widest bar in the set reaches exactly its half, never past it", () => {
    assert.equal(signedBarGeometry(2, 2).widthPct, 50);
    assert.equal(signedBarGeometry(9, 2).widthPct, 50);
  });

  test("a zero delta is a zero-width bar at the axis, not a hidden one", () => {
    assert.deepEqual(signedBarGeometry(0, 2), { leftPct: 50, widthPct: 0, positive: true });
  });

  test("a zero scale throws instead of returning NaN widths", () => {
    // NaN% renders as a bar of no width — an invisible chart that looks like
    // an empty result. The tile must branch on maxAbsDelta === 0 instead.
    assert.throws(() => signedBarGeometry(1, 0), /maxAbs must be > 0, got 0/);
  });
});

describe("maxAbsDelta", () => {
  test("ignores null deltas and takes the magnitude", () => {
    assert.equal(maxAbsDelta([{ delta: null }, { delta: -3.2 }, { delta: 1 }]), 3.2);
  });

  test("all-null is 0 — the tile's signal to print text instead of bars", () => {
    assert.equal(maxAbsDelta([{ delta: null }, { delta: null }]), 0);
  });
});

/* ── habit matrix faceting ────────────────────────────────────────────── */

describe("habitGroupBlocks", () => {
  test("blocks come back in migration 0042's order, not the payload's", () => {
    const blocks = habitGroupBlocks(
      [habit("teeth", "evening", []), habit("wake_6", "morning", [])],
      30,
    );
    assert.deepEqual(blocks.map((b) => b.group), ["morning", "evening"]);
  });

  test("every seeded group is a known group", () => {
    assert.deepEqual([...HABIT_GROUPS], ["morning", "body", "work", "evening"]);
  });

  test("an unknown group is appended, never dropped", () => {
    // A habit invented in the DB after this constant was written must still
    // appear — silently omitting a row is the worst failure a matrix has.
    const blocks = habitGroupBlocks([habit("x", "finance", []), habit("y", "body", [])], 30);
    assert.deepEqual(blocks.map((b) => b.group), ["body", "finance"]);
  });

  test("empty groups are omitted rather than drawn as blank blocks", () => {
    const blocks = habitGroupBlocks([habit("wake_6", "morning", [])], 30);
    assert.deepEqual(blocks.map((b) => b.group), ["morning"]);
  });

  test("density is ticks over (habits × days), not over ticked days", () => {
    const blocks = habitGroupBlocks(
      [habit("a", "morning", ["d1", "d2"]), habit("b", "morning", [])],
      4,
    );
    assert.equal(blocks[0].density, 2 / 8);
  });

  test("a bad window throws rather than dividing by zero", () => {
    assert.throws(() => habitGroupBlocks([], 0), /windowDays must be >= 1, got 0/);
  });
});

/* ── calendar hours ───────────────────────────────────────────────────── */

describe("hoursText", () => {
  test("whole hours lose the decimal", () => {
    assert.equal(hoursText(120), "2 h");
    assert.equal(hoursText(0), "0 h");
  });

  test("partial hours keep one decimal", () => {
    assert.equal(hoursText(210), "3.5 h");
    assert.equal(hoursText(50), "0.8 h");
  });

  test("a non-finite minute count throws", () => {
    assert.throws(() => hoursText(Number.NaN), /minutes must be finite/);
  });
});

describe("foldAreas", () => {
  const a = (area: string, booked: number, worked: number): DayCalendarStatsByArea => ({
    area,
    booked_min: booked,
    worked_min: worked,
  });

  test("sorts by total time, biggest first", () => {
    const { rows, folded } = foldAreas([a("x", 10, 0), a("y", 0, 90)], 5);
    assert.deepEqual(rows.map((r) => r.area), ["y", "x"]);
    assert.equal(folded, 0);
  });

  test("the tail folds into one Other row whose minutes are the sum", () => {
    const { rows, folded } = foldAreas(
      [a("a", 100, 100), a("b", 50, 50), a("c", 10, 5), a("d", 4, 1)],
      2,
    );
    assert.deepEqual(rows.map((r) => r.area), ["a", "b", "Other"]);
    assert.equal(rows[2].booked_min, 14);
    assert.equal(rows[2].worked_min, 6);
    assert.equal(folded, 2, "the count of folded areas must be reported, not swallowed");
  });

  test("exactly `keep` areas are not folded — no gratuitous Other row", () => {
    const { rows, folded } = foldAreas([a("a", 1, 1), a("b", 1, 1)], 2);
    assert.equal(rows.length, 2);
    assert.equal(folded, 0);
  });

  test("a bad keep throws", () => {
    assert.throws(() => foldAreas([], 0), /keep must be >= 1, got 0/);
  });
});
