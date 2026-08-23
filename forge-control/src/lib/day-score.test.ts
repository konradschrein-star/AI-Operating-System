/**
 * Tests for the day score, day resolver, and streak arithmetic.
 *
 * Run: cd forge-control && npm test   (tsx --test, no test framework dep)
 *
 * Everything here is pure — computeDayScore takes folded rows and returns a
 * number, so the whole formula is provable without a database. The four cases
 * the spec calls out by name (renormalisation, no Big 3, abandoned ≠ done, a
 * hand-computed expected score) each have a named test below, so a regression
 * reads as the rule it broke rather than as an anonymous arithmetic failure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  berlinDay,
  berlinHour,
  isDay,
  assertDay,
  shiftDay,
  daysBetween,
  daysBack,
  computeDayScore,
  streakEndingToday,
  bestStreak,
  SCORE_WEIGHTS,
  FULFILLED_AT,
  type ScoreInput,
  type GoalStatus,
} from "./day-score.ts";

/** The real seeded habit set: 4 habits at weight 2, 14 at weight 1 → Σ 22. */
function seededHabits(doneWeight2: number, doneWeight1: number) {
  const habits: Array<{ weight: number; done: boolean }> = [];
  for (let i = 0; i < 4; i++) habits.push({ weight: 2, done: i < doneWeight2 });
  for (let i = 0; i < 14; i++) habits.push({ weight: 1, done: i < doneWeight1 });
  return habits;
}

function goals(...statuses: GoalStatus[]) {
  return statuses.map((status) => ({ status }));
}

function tasks(done: number, total: number) {
  return Array.from({ length: total }, (_, i) => ({ done: i < done }));
}

const EMPTY: ScoreInput = { habits: [], big3: [], tasks: [] };

// ---------------------------------------------------------------------------

describe("berlinDay / berlinHour", () => {
  test("resolves the BERLIN day, not the UTC one, across the midnight window", () => {
    // 00:30 Berlin on 2026-08-20 is 22:30 UTC on the 19th (CEST, +2). A habit
    // ticked then belongs to the 20th. This is the bug the helper exists for.
    assert.equal(berlinDay(new Date("2026-08-19T22:30:00Z")), "2026-08-20");
    assert.equal(berlinHour(new Date("2026-08-19T22:30:00Z")), 0);
    // And 23:50 Berlin is still the same day, not tomorrow.
    assert.equal(berlinDay(new Date("2026-08-19T21:50:00Z")), "2026-08-19");
  });

  test("winter (CET, +1) shifts by one hour, not two", () => {
    assert.equal(berlinDay(new Date("2026-01-15T23:30:00Z")), "2026-01-16");
    assert.equal(berlinDay(new Date("2026-01-15T22:30:00Z")), "2026-01-15");
    assert.equal(berlinHour(new Date("2026-01-15T22:30:00Z")), 23);
  });

  test("the NIGHT panel boundary (20:00 local) is read from Berlin time", () => {
    // 18:00 UTC in summer = 20:00 Berlin.
    assert.equal(berlinHour(new Date("2026-07-01T18:00:00Z")), 20);
    assert.equal(berlinHour(new Date("2026-07-01T17:59:00Z")), 19);
  });

  test("an invalid Date throws instead of yielding a day", () => {
    assert.throws(() => berlinDay(new Date("nonsense")), /invalid Date/);
  });
});

describe("day arithmetic", () => {
  test("isDay rejects malformed and impossible dates", () => {
    assert.equal(isDay("2026-08-19"), true);
    assert.equal(isDay("2024-02-29"), true); // leap year
    assert.equal(isDay("2026-02-30"), false);
    assert.equal(isDay("2026-13-01"), false);
    assert.equal(isDay("2026-8-19"), false);
    assert.equal(isDay("2026-08-19T00:00:00Z"), false);
    assert.equal(isDay(""), false);
    assert.equal(isDay(20260819), false);
    assert.equal(isDay(null), false);
  });

  test("assertDay names the offending value", () => {
    assert.throws(() => assertDay("yesterday", "planned_day"), /planned_day must be a real calendar day/);
  });

  test("shiftDay crosses months, years and the DST switch without drifting", () => {
    assert.equal(shiftDay("2026-08-19", 1), "2026-08-20");
    assert.equal(shiftDay("2026-08-19", -1), "2026-08-18");
    assert.equal(shiftDay("2026-08-31", 1), "2026-09-01");
    assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
    // 2026-03-29 is the spring-forward day in Berlin; a date-only shift must
    // not lose it to a 23-hour day.
    assert.equal(shiftDay("2026-03-28", 1), "2026-03-29");
    assert.equal(shiftDay("2026-03-29", 1), "2026-03-30");
    assert.equal(shiftDay("2026-10-24", 1), "2026-10-25"); // fall back
    assert.equal(shiftDay("2026-08-19", 0), "2026-08-19");
  });

  test("daysBetween is signed and daysBack descends inclusively", () => {
    assert.equal(daysBetween("2026-08-19", "2026-08-22"), 3);
    assert.equal(daysBetween("2026-08-22", "2026-08-19"), -3);
    assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2);
    assert.deepEqual(daysBack("2026-08-19", 3), ["2026-08-19", "2026-08-18", "2026-08-17"]);
    assert.throws(() => daysBack("2026-08-19", 0), /positive integer/);
  });
});

// ---------------------------------------------------------------------------

describe("computeDayScore", () => {
  test("hand-computed: 1/3 goals, 10/22 habit weight, 3/5 tasks → 43", () => {
    // 0.45*(1/3)      = 0.15
    // 0.35*(10/22)    = 0.159090909…
    // 0.20*0.6        = 0.12
    //                 = 0.429090909… → round(42.909…) = 43
    const s = computeDayScore({
      habits: seededHabits(2, 6), // 2*2 + 6*1 = 10 of 22
      big3: goals("done", "abandoned", "open"),
      tasks: tasks(3, 5),
    });
    assert.equal(s.counts.habits_done_weight, 10);
    assert.equal(s.counts.habits_total_weight, 22);
    assert.equal(s.goal_pct, 1 / 3);
    assert.equal(s.habit_pct, 10 / 22);
    assert.equal(s.task_pct, 0.6);
    assert.equal(s.score, 43);
    assert.equal(s.fulfilled, false);
    // No renormalisation happened: all three components had a denominator.
    assert.deepEqual(s.weights, { goal: 0.45, habit: 0.35, task: 0.2 });
  });

  test("abandoned counts as NOT done — killing a goal does not earn the tick", () => {
    const done = computeDayScore({ ...EMPTY, big3: goals("done", "done", "done") });
    const abandoned = computeDayScore({ ...EMPTY, big3: goals("done", "done", "abandoned") });
    const open = computeDayScore({ ...EMPTY, big3: goals("done", "done", "open") });
    assert.equal(done.score, 100);
    assert.equal(abandoned.score, 67);
    // An abandoned goal scores exactly what an untouched one scores. The
    // difference between them is honesty, recorded in said_vs_done — not points.
    assert.equal(abandoned.score, open.score);
    assert.equal(abandoned.goal_pct, open.goal_pct);
    assert.equal(abandoned.counts.goals_abandoned, 1);
    assert.equal(open.counts.goals_abandoned, 0);
  });

  test("no Big 3: the day is scored on habits and tasks alone, renormalised", () => {
    // Weights present: 0.35 + 0.20 = 0.55.
    // (0.35*(10/22) + 0.20*0.6) / 0.55 = (0.159090909… + 0.12) / 0.55
    //                                  = 0.279090909… / 0.55 = 0.507438…  → 51
    const s = computeDayScore({
      habits: seededHabits(2, 6),
      big3: [],
      tasks: tasks(3, 5),
    });
    assert.equal(s.goal_pct, null);
    assert.equal(s.weights.goal, 0);
    assert.equal(s.score, 51);
    // The renormalised weights sum to 1 — nothing is scored as a silent zero.
    assert.equal(
      Math.abs(s.weights.goal + s.weights.habit + s.weights.task - 1) < 1e-12,
      true,
    );
    // Proof it is renormalisation and not "goals scored 0": scoring the missing
    // component as zero would give round(100 * 0.279…) = 28.
    assert.notEqual(s.score, 28);
  });

  test("renormalisation: a perfect day on the surviving components is still 100", () => {
    // The load-bearing property. A day with no Big 3 and no tasks, all habits
    // ticked, must read 100 — not 35. Notion's permanent 0% was this bug.
    const s = computeDayScore({ habits: seededHabits(4, 14), big3: [], tasks: [] });
    assert.equal(s.score, 100);
    assert.equal(s.habit_pct, 1);
    assert.equal(s.weights.habit, 1);
    assert.equal(s.weights.goal, 0);
    assert.equal(s.weights.task, 0);
    assert.equal(s.fulfilled, true);
  });

  test("every single-component day renormalises to that component alone", () => {
    const goalOnly = computeDayScore({ ...EMPTY, big3: goals("done", "open") });
    assert.equal(goalOnly.score, 50);
    assert.deepEqual(goalOnly.weights, { goal: 1, habit: 0, task: 0 });

    const taskOnly = computeDayScore({ ...EMPTY, tasks: tasks(1, 4) });
    assert.equal(taskOnly.score, 25);
    assert.deepEqual(taskOnly.weights, { goal: 0, habit: 0, task: 1 });
  });

  test("goals dominate: 18/18 habits with 0/3 goals is not a good day", () => {
    // The number must say what the spec says out loud.
    const s = computeDayScore({
      habits: seededHabits(4, 14),
      big3: goals("open", "open", "abandoned"),
      tasks: [],
    });
    // (0.45*0 + 0.35*1) / 0.80 = 0.4375 → 44
    assert.equal(s.score, 44);
    assert.equal(s.fulfilled, false);
  });

  test("nothing at all: score is null, never 0", () => {
    const s = computeDayScore(EMPTY);
    assert.equal(s.score, null);
    assert.equal(s.goal_pct, null);
    assert.equal(s.habit_pct, null);
    assert.equal(s.task_pct, null);
    assert.equal(s.fulfilled, false);
    assert.deepEqual(s.weights, { goal: 0, habit: 0, task: 0 });
  });

  test("all habits deactivated: zero total weight drops the component, no NaN", () => {
    const s = computeDayScore({
      habits: [], // Σweight 0 — the divide-by-zero case
      big3: goals("done", "done"),
      tasks: [],
    });
    assert.equal(s.habit_pct, null);
    assert.equal(s.score, 100);
    assert.equal(Number.isNaN(s.score), false);
  });

  test("weights are the spec's, and the fulfilled threshold is 80", () => {
    assert.deepEqual({ ...SCORE_WEIGHTS }, { goal: 0.45, habit: 0.35, task: 0.2 });
    assert.equal(FULFILLED_AT, 80);
    // Exactly 80 earns it; 79 does not.
    assert.equal(computeDayScore({ ...EMPTY, tasks: tasks(80, 100) }).fulfilled, true);
    assert.equal(computeDayScore({ ...EMPTY, tasks: tasks(79, 100) }).fulfilled, false);
  });

  test("weighted habits: the four that move his year count double", () => {
    // 4 heavy habits done, 0 light = 8/22. 14 light done, 0 heavy = 14/22.
    const heavy = computeDayScore({ habits: seededHabits(4, 0), big3: [], tasks: [] });
    const light = computeDayScore({ habits: seededHabits(0, 14), big3: [], tasks: [] });
    assert.equal(heavy.counts.habits_done_weight, 8);
    assert.equal(light.counts.habits_done_weight, 14);
    assert.equal(heavy.score, 36);
    assert.equal(light.score, 64);
  });
});

// ---------------------------------------------------------------------------

describe("streaks", () => {
  const TODAY = "2026-08-19";

  test("an unticked today does not break the streak", () => {
    // Ticked through yesterday, nothing yet today — at 09:00 this is a live
    // 3-day streak, not the 0 Notion printed.
    const hit = ["2026-08-16", "2026-08-17", "2026-08-18"];
    assert.equal(streakEndingToday(hit, TODAY), 3);
  });

  test("today counts once it is ticked", () => {
    const hit = ["2026-08-17", "2026-08-18", "2026-08-19"];
    assert.equal(streakEndingToday(hit, TODAY), 3);
  });

  test("a gap at the day before yesterday ends it", () => {
    // 08-17 missing → nothing reaches back past it.
    const hit = ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-18"];
    assert.equal(streakEndingToday(hit, TODAY), 1);
  });

  test("no ticks at all is zero, and only today is one", () => {
    assert.equal(streakEndingToday([], TODAY), 0);
    assert.equal(streakEndingToday([TODAY], TODAY), 1);
    // A tick two days ago and nothing since: yesterday is the first probe and
    // it misses, so the streak is over.
    assert.equal(streakEndingToday(["2026-08-17"], TODAY), 0);
  });

  test("streak crosses month boundary without off-by-one", () => {
    const ref = "2026-08-02";
    // 4 consecutive days: July 30, July 31, Aug 1, Aug 2
    const hit = ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"];
    assert.equal(streakEndingToday(hit, ref), 4);

    // If Aug 2 unticked yet, still 3 (July 30, 31, Aug 1)
    const hitUntickedToday = ["2026-07-30", "2026-07-31", "2026-08-01"];
    assert.equal(streakEndingToday(hitUntickedToday, ref), 3);
  });

  test("streak crosses year boundary without drifting", () => {
    const ref = "2026-01-02";
    const hit = ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"];
    assert.equal(streakEndingToday(hit, ref), 4);
    assert.equal(bestStreak(hit), 4);
  });

  test("streak crosses leap year day Feb 29 cleanly", () => {
    const ref = "2024-03-01";
    const hit = ["2024-02-28", "2024-02-29", "2024-03-01"];
    assert.equal(streakEndingToday(hit, ref), 3);
    assert.equal(bestStreak(hit), 3);
  });

  test("duplicate dates and unordered arrays do not corrupt streak", () => {
    const hit = [
      "2026-08-18",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18", // duplicate
      "2026-08-19",
      "2026-08-17", // duplicate
    ];
    assert.equal(streakEndingToday(hit, TODAY), 4);
    assert.equal(bestStreak(hit), 4);
  });

  test("bestStreak finds the longest run anywhere, deduped and unordered", () => {
    const hit = [
      "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", // 4
      "2026-08-12",
      "2026-08-16", "2026-08-17", // 2
      "2026-08-05", // duplicate
    ];
    assert.equal(bestStreak(hit), 4);
    assert.equal(bestStreak([...hit].reverse()), 4);
    assert.equal(bestStreak([]), 0);
    assert.equal(bestStreak(["2026-08-19"]), 1);
    // Across a month boundary.
    assert.equal(bestStreak(["2026-07-30", "2026-07-31", "2026-08-01"]), 3);
  });

  test("bestStreak compares multiple non-contiguous runs correctly", () => {
    const hit = [
      "2026-05-01", "2026-05-02", "2026-05-03", // 3
      "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", // 6
      "2026-07-01", "2026-07-02", // 2
    ];
    assert.equal(bestStreak(hit), 6);
  });
});
