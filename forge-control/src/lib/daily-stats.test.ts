/**
 * The two derived tiles of /api/daily/stats: habit↔felt and goals-this-week.
 *
 * Run: cd forge-control && pnpm test   (tsx --test — the script globs
 * src/lib/*.test.ts, which is why a test for src/db/daily.ts lives in this
 * directory. A file at src/db/daily-stats.test.ts is executed by nothing.)
 *
 * ── WHAT THIS FILE GUARDS ───────────────────────────────────────────────────
 * `day_plans.subjective` is non-null on ZERO days as of 2026-08-25, and the
 * whole reason this endpoint exists is the question "which of these 18 habits
 * actually matter". Both halves of that are easy to get wrong in a way no
 * typecheck and no screenshot can see:
 *
 *   1. A mean over an empty side rendered as 0.0 — which draws a bar saying
 *      "days without meditation feel like a zero out of ten" from no data at
 *      all. Every assertion about null below exists to make that impossible.
 *   2. A habit ranked top of the table on three data points because its delta
 *      happened to be large. The fixture is built so the INSUFFICIENT habit has
 *      a bigger |delta| than a sufficient one; if sufficiency ever stops
 *      dominating the sort, the ordering assertion fails.
 *
 * `computeHabitFelt` and `groupGoalsWeek` take their rows as arguments so this
 * needs no database. Whether the SQL feeding them selects the right rows is a
 * database question a fixture cannot answer, and is proved separately against
 * the scratch database in the round-1 report.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeHabitFelt,
  groupGoalsWeek,
  HABIT_FELT_MIN_RATED_DAYS,
  HABIT_FELT_MIN_SIDE,
} from "../db/daily.ts";
import type { Day } from "./day-score.ts";

// ---------------------------------------------------------------------------
// A 25-rated-day fixture with a known answer
// ---------------------------------------------------------------------------
//
// 2026-08-01 … 2026-08-25. Felt ratings, in order:
//   days  1– 3 → 10
//   days  4–12 →  8
//   days 13–25 →  4
//
// deep_work   ticked days  1–12          → mean 8.5 with, 4.0 without, Δ +4.5
// late_snack  ticked day 1 and days 14–25 → mean 4.46 with, 8.0 without, Δ −3.54
// journal     ticked days  1– 3          → mean 10.0 with, 5.64 without, Δ +4.36
//                                           but n_with = 3, so NOT sufficient
//
// journal's delta is the second largest in the table and it must still sort
// last. That is the point of the fixture.

const day = (n: number): Day => `2026-08-${String(n).padStart(2, "0")}`;

function ratingOf(n: number): number {
  if (n <= 3) return 10;
  if (n <= 12) return 8;
  return 4;
}

const ALL_DAYS = Array.from({ length: 25 }, (_, i) => i + 1);

const RATED_DAYS = ALL_DAYS.map((n) => ({ day: day(n), subjective: ratingOf(n) }));

const HABITS = [
  { id: "h-deep", key: "deep_work", label: "Deep work block", icon: "🧠" },
  { id: "h-snack", key: "late_snack", label: "Late night snack", icon: "🍪" },
  { id: "h-journal", key: "journal", label: "Journal", icon: "📓" },
];

const TICKS = new Map<string, Day[]>([
  ["h-deep", ALL_DAYS.filter((n) => n <= 12).map(day)],
  ["h-snack", [day(1), ...ALL_DAYS.filter((n) => n >= 14).map(day)]],
  ["h-journal", [day(1), day(2), day(3)]],
]);

const rowOf = (
  felt: ReturnType<typeof computeHabitFelt>,
  key: string,
): ReturnType<typeof computeHabitFelt>["rows"][number] => {
  const row = felt.rows.find((r) => r.key === key);
  if (!row) throw new Error(`fixture broken: no habit_felt row for ${key}`);
  return row;
};

describe("computeHabitFelt — the sufficiency floor", () => {
  test("the thresholds are 20 rated days and 8 days per side", () => {
    // Hard-coded, not imported into the assertion: if someone lowers the floor
    // to make the tile draw sooner, this fails and they have to mean it.
    assert.equal(HABIT_FELT_MIN_RATED_DAYS, 20);
    assert.equal(HABIT_FELT_MIN_SIDE, 8);
  });

  test("no rated days at all: every mean is null, nothing is sufficient", () => {
    const felt = computeHabitFelt(
      ALL_DAYS.map((n) => ({ day: day(n), subjective: null })),
      HABITS,
      TICKS,
    );
    assert.equal(felt.rated_days, 0);
    assert.equal(felt.needed, 20);
    assert.equal(felt.sufficient, false);
    assert.equal(felt.rows.length, 3);
    for (const row of felt.rows) {
      assert.equal(row.mean_with, null, `${row.key} mean_with must be null, not 0`);
      assert.equal(row.mean_without, null, `${row.key} mean_without must be null, not 0`);
      assert.equal(row.delta, null, `${row.key} delta must be null, not 0`);
      assert.equal(row.n_with, 0);
      assert.equal(row.n_without, 0);
      assert.equal(row.sufficient, false);
    }
  });

  test("19 rated days is not enough however clean the split", () => {
    // Days 5–23: one day short of the floor with BOTH sides over 8, so the only
    // thing standing between this row and `sufficient: true` is the day count.
    const nineteen = RATED_DAYS.slice(4, 23);
    const felt = computeHabitFelt(nineteen, HABITS, TICKS);
    assert.equal(felt.rated_days, 19);
    assert.equal(felt.sufficient, false);
    const deep = rowOf(felt, "deep_work");
    assert.equal(deep.n_with, 8);
    assert.equal(deep.n_without, 11);
    assert.equal(deep.sufficient, false);
    // The means are still real numbers — the data exists, it is just too thin
    // to rank on. Nulling them here would be a different lie.
    assert.equal(deep.mean_with, 8);
    assert.equal(deep.mean_without, 4);
  });

  test("a thin side blocks sufficiency even at 25 rated days", () => {
    const felt = computeHabitFelt(RATED_DAYS, HABITS, TICKS);
    const journal = rowOf(felt, "journal");
    assert.equal(felt.rated_days, 25);
    assert.equal(journal.n_with, 3);
    assert.equal(journal.n_without, 22);
    assert.equal(journal.sufficient, false);
  });
});

describe("computeHabitFelt — the arithmetic", () => {
  const felt = computeHabitFelt(RATED_DAYS, HABITS, TICKS);

  test("a habit that goes with good days reads positive", () => {
    const deep = rowOf(felt, "deep_work");
    assert.equal(deep.n_with, 12);
    assert.equal(deep.n_without, 13);
    assert.equal(deep.mean_with, 8.5); // (3×10 + 9×8) / 12
    assert.equal(deep.mean_without, 4);
    assert.equal(deep.delta, 4.5);
    assert.equal(deep.sufficient, true);
  });

  test("a habit that goes with bad days reads negative, rounded to 2 dp", () => {
    const snack = rowOf(felt, "late_snack");
    assert.equal(snack.n_with, 13);
    assert.equal(snack.n_without, 12);
    assert.equal(snack.mean_with, 4.46); // 58/13 = 4.4615…
    assert.equal(snack.mean_without, 8);
    assert.equal(snack.delta, -3.54); // 4.4615… − 8
    assert.equal(snack.sufficient, true);
  });

  test("means carry the habit's identity for the tile to label with", () => {
    const deep = rowOf(felt, "deep_work");
    assert.equal(deep.habit_id, "h-deep");
    assert.equal(deep.label, "Deep work block");
    assert.equal(deep.icon, "🧠");
  });

  test("the panel is sufficient as soon as one row is", () => {
    assert.equal(felt.sufficient, true);
  });
});

describe("computeHabitFelt — ordering", () => {
  const felt = computeHabitFelt(RATED_DAYS, HABITS, TICKS);

  test("sufficiency dominates |delta|, and |delta| orders within it", () => {
    // journal's |Δ| is 4.36 — larger than late_snack's 3.54 — and it must still
    // come last, because three days is not an answer.
    assert.deepEqual(
      felt.rows.map((r) => r.key),
      ["deep_work", "late_snack", "journal"],
    );
    const journal = rowOf(felt, "journal");
    const snack = rowOf(felt, "late_snack");
    assert.equal(journal.delta, 4.36);
    assert.ok(
      Math.abs(journal.delta ?? 0) > Math.abs(snack.delta ?? 0),
      "fixture broken: the insufficient row must out-delta a sufficient one",
    );
  });

  test("ties among insufficient rows fall back to the label", () => {
    const felt0 = computeHabitFelt(
      ALL_DAYS.map((n) => ({ day: day(n), subjective: null })),
      [
        { id: "z", key: "zulu", label: "Zulu", icon: "z" },
        { id: "a", key: "alpha", label: "Alpha", icon: "a" },
        { id: "m", key: "mike", label: "Mike", icon: "m" },
      ],
      new Map(),
    );
    assert.deepEqual(
      felt0.rows.map((r) => r.label),
      ["Alpha", "Mike", "Zulu"],
    );
  });
});

// ---------------------------------------------------------------------------
// goals_week
// ---------------------------------------------------------------------------

describe("groupGoalsWeek", () => {
  const WEEK_START: Day = "2026-08-24";
  const WEEK_END: Day = "2026-08-30";

  const rows = [
    { goal_id: "g1", goal_title: "Ship the OS", goal_horizon: "quarterly", minutes: 90 },
    { goal_id: "g2", goal_title: "10k subscribers", goal_horizon: "yearly", minutes: 120 },
    { goal_id: "g1", goal_title: "Ship the OS", goal_horizon: "quarterly", minutes: 45 },
    { goal_id: null, goal_title: null, goal_horizon: null, minutes: 30 },
    { goal_id: null, goal_title: null, goal_horizon: null, minutes: 0 },
    { goal_id: "g1", goal_title: "Ship the OS", goal_horizon: "quarterly", minutes: 15 },
  ];

  test("linked tasks fold into their goal, unlinked ones are counted apart", () => {
    const week = groupGoalsWeek(WEEK_START, WEEK_END, rows);
    assert.equal(week.week_start, WEEK_START);
    assert.equal(week.week_end, WEEK_END);
    assert.equal(week.total_done, 6);
    assert.equal(week.unlinked_done, 2);
    assert.equal(week.moved.length, 2);
    // The unlinked pair must NOT appear as a group — the ratio between them and
    // the linked work is the answer the tile exists to give.
    assert.equal(
      week.moved.some((m) => m.title === null || m.goal_id === null),
      false,
    );
  });

  test("minutes and task counts accumulate per goal", () => {
    const week = groupGoalsWeek(WEEK_START, WEEK_END, rows);
    const ship = week.moved.find((m) => m.goal_id === "g1");
    assert.ok(ship, "g1 missing from moved");
    assert.equal(ship.tasks_done, 3);
    assert.equal(ship.minutes, 150);
    assert.equal(ship.horizon, "quarterly");
  });

  test("groups are ordered by minutes, not by task count", () => {
    // g1 has three tasks against g2's one, and still sorts second: an hour is
    // the scarce thing, not a checkbox.
    const week = groupGoalsWeek(WEEK_START, WEEK_END, rows);
    assert.deepEqual(
      week.moved.map((m) => m.goal_id),
      ["g1", "g2"],
    );
    assert.equal(week.moved[0]?.minutes, 150);
    assert.equal(week.moved[1]?.minutes, 120);
  });

  test("a week with nothing done is zeros, not an error", () => {
    const week = groupGoalsWeek(WEEK_START, WEEK_END, []);
    assert.equal(week.total_done, 0);
    assert.equal(week.unlinked_done, 0);
    assert.deepEqual(week.moved, []);
  });

  test("a goal_id with no goal behind it throws rather than inventing a title", () => {
    assert.throws(
      () =>
        groupGoalsWeek(WEEK_START, WEEK_END, [
          { goal_id: "ghost", goal_title: null, goal_horizon: null, minutes: 10 },
        ]),
      /task links goal ghost but the join returned no title\/horizon/,
    );
  });
});
