/**
 * The day score, and the day itself.
 *
 * Spec: docs/spec-daily-goals.md §3. This is the ONLY place a day score is
 * computed and the ONLY place "today" is resolved. Both rules exist because
 * Notion broke them:
 *
 *   - A second copy of the formula drifts, and then the number on the heatmap
 *     disagrees with the number on the ring, and the scoreboard stops meaning
 *     anything. Every caller (routes/daily.ts, db/daily.ts stats) folds rows
 *     into ScoreInput and calls computeDayScore().
 *
 *   - `new Date()` scattered through route handlers resolves "today" in the
 *     process's timezone, which is UTC on this box. Between 00:00 and 02:00
 *     Europe/Berlin that is YESTERDAY, so a habit ticked at 00:30 would land on
 *     the wrong day and a 23:50 commit would freeze the wrong plan. Everything
 *     goes through berlinDay().
 *
 * Pure module: no database, no I/O, no clock except the Date passed in.
 * Unit-tested in day-score.test.ts.
 */

export const BERLIN_TZ = "Europe/Berlin";

/** A calendar day as `YYYY-MM-DD`. Not a timestamp — days have no time. */
export type Day = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const BERLIN_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: BERLIN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar day `at` falls on in Europe/Berlin. Defaults to now.
 *
 * formatToParts rather than format(): `en-CA` happens to render ISO order
 * today, but a locale-data update is not something a scoreboard should be able
 * to lose a day to.
 */
export function berlinDay(at: Date = new Date()): Day {
  if (Number.isNaN(at.getTime())) {
    throw new Error("berlinDay: invalid Date — refusing to resolve a day from NaN");
  }
  const parts = BERLIN_FMT.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) {
      throw new Error(
        `berlinDay: Intl produced no ${type} part for ${at.toISOString()} — ` +
          `the runtime's ICU data cannot format ${BERLIN_TZ}`,
      );
    }
    return p.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The local hour (0..23) in Europe/Berlin — the NIGHT panel opens at 20:00. */
export function berlinHour(at: Date = new Date()): number {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TZ,
    hour: "2-digit",
    hour12: false,
  }).format(at);
  const h = Number(s);
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error(`berlinHour: Intl returned "${s}", which is not an hour`);
  }
  return h;
}

/** True for a well-formed AND real calendar day ("2026-02-30" is neither). */
export function isDay(value: unknown): value is Day {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Validate a day, or throw with the offending value. Callers that need a 400
 * rather than a 500 should test with isDay() first.
 */
export function assertDay(value: unknown, what = "day"): Day {
  if (!isDay(value)) {
    throw new Error(`${what} must be a real calendar day as YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `day` shifted by n calendar days. UTC arithmetic on a date-only value is
 * exact — no DST hour to lose, because there is no hour.
 */
export function shiftDay(day: Day, n: number): Day {
  assertDay(day);
  if (!Number.isInteger(n)) throw new Error(`shiftDay: n must be an integer, got ${n}`);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, negative if `to` is earlier. */
export function daysBetween(from: Day, to: Day): number {
  assertDay(from, "from");
  assertDay(to, "to");
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Descending list of `count` days ending at `end` (inclusive): [end, end-1, ...]. */
export function daysBack(end: Day, count: number): Day[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`daysBack: count must be a positive integer, got ${count}`);
  }
  const out: Day[] = [];
  for (let i = 0; i < count; i++) out.push(shiftDay(end, -i));
  return out;
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

export type GoalStatus = "open" | "done" | "abandoned";

export interface ScoreHabit {
  /** Σ over ACTIVE habits only — an archived habit must not move the number. */
  weight: number;
  done: boolean;
}

export interface ScoreInput {
  /** Active habit definitions with their tick state for the day. */
  habits: ScoreHabit[];
  /** The Big 3 as committed. Empty (or an uncommitted plan) → no denominator. */
  big3: Array<{ status: GoalStatus }>;
  /** Tasks whose planned_day IS this day. */
  tasks: Array<{ done: boolean }>;
}

export interface DayScore {
  /** 0..100, or null when no component had a denominator at all. */
  score: number | null;
  goal_pct: number | null;
  habit_pct: number | null;
  task_pct: number | null;
  /** The renormalised weight each component actually carried, for the UI. */
  weights: { goal: number; habit: number; task: number };
  counts: {
    goals_done: number;
    goals_abandoned: number;
    goals_total: number;
    habits_done_weight: number;
    habits_total_weight: number;
    tasks_done: number;
    tasks_total: number;
  };
  /** score >= 80 → "Day fulfilled — rest guilt-free." */
  fulfilled: boolean;
}

/** Nominal weights. Goals dominate on purpose (spec §3). */
export const SCORE_WEIGHTS = { goal: 0.45, habit: 0.35, task: 0.2 } as const;

/** The threshold that earns guilt-free rest. */
export const FULFILLED_AT = 80;

/** The sentence itself, so the UI and any notifier quote the same words. */
export const FULFILLED_LINE = "Day fulfilled — rest guilt-free.";

/**
 * The one honest formula.
 *
 *   habit_pct = Σ weight(done habits) / Σ weight(active habits)
 *   goal_pct  = done big3 / committed big3     (abandoned counts as NOT done)
 *   task_pct  = done tasks planned today / tasks planned today
 *   day_score = round(100 * (0.45*goal + 0.35*habit + 0.20*task))
 *
 * A component with no denominator is DROPPED and the remaining weights
 * renormalise over their own sum. It is never scored as 0. Notion scored the
 * missing components as zero and produced a permanent, meaningless 0% — which
 * is precisely how a scoreboard becomes something you stop looking at.
 */
export function computeDayScore(input: ScoreInput): DayScore {
  const habitsTotal = input.habits.reduce((n, h) => n + h.weight, 0);
  const habitsDone = input.habits.reduce((n, h) => n + (h.done ? h.weight : 0), 0);
  // Abandoned is not done. That is the entire point of recording it separately:
  // he may kill a goal honestly, but killing it does not earn the tick.
  const goalsDone = input.big3.filter((g) => g.status === "done").length;
  const goalsAbandoned = input.big3.filter((g) => g.status === "abandoned").length;
  const tasksDone = input.tasks.filter((t) => t.done).length;

  const goal_pct = input.big3.length > 0 ? goalsDone / input.big3.length : null;
  // A zero total weight is a live possibility, not a hypothetical: deactivate
  // every habit and Σweight is 0. Guard on the weight, not on habits.length.
  const habit_pct = habitsTotal > 0 ? habitsDone / habitsTotal : null;
  const task_pct = input.tasks.length > 0 ? tasksDone / input.tasks.length : null;

  const present: Array<[keyof typeof SCORE_WEIGHTS, number]> = [];
  if (goal_pct !== null) present.push(["goal", goal_pct]);
  if (habit_pct !== null) present.push(["habit", habit_pct]);
  if (task_pct !== null) present.push(["task", task_pct]);

  const nominalSum = present.reduce((n, [k]) => n + SCORE_WEIGHTS[k], 0);
  const weights = { goal: 0, habit: 0, task: 0 };
  let score: number | null = null;

  if (nominalSum > 0) {
    let acc = 0;
    for (const [k, pct] of present) {
      const w = SCORE_WEIGHTS[k] / nominalSum;
      weights[k] = w;
      acc += w * pct;
    }
    score = Math.round(100 * acc);
  }

  return {
    score,
    goal_pct,
    habit_pct,
    task_pct,
    weights,
    counts: {
      goals_done: goalsDone,
      goals_abandoned: goalsAbandoned,
      goals_total: input.big3.length,
      habits_done_weight: habitsDone,
      habits_total_weight: habitsTotal,
      tasks_done: tasksDone,
      tasks_total: input.tasks.length,
    },
    fulfilled: score !== null && score >= FULFILLED_AT,
  };
}

/**
 * Consecutive days ending yesterday-or-today that are in `hit`.
 *
 * Today counts only if it is a hit, but an unhit TODAY does not break the
 * streak — the day is not over. Notion showed `Current: 0 days` at 09:00 on
 * day 12 of a streak, which is both wrong and demoralising, and demoralising
 * is the expensive half.
 *
 * @param hit    the days that count (ticked habit / fulfilled day)
 * @param today  the reference day, from berlinDay()
 */
export function streakEndingToday(hit: Iterable<Day>, today: Day): number {
  assertDay(today, "today");
  const set = hit instanceof Set ? (hit as Set<Day>) : new Set<Day>(hit);
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (set.has(cursor)) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/** The longest run of consecutive days anywhere in `hit`. */
export function bestStreak(hit: Iterable<Day>): number {
  const days = [...new Set<Day>(hit)].sort();
  let best = 0;
  let run = 0;
  let prev: Day | null = null;
  for (const d of days) {
    run = prev !== null && daysBetween(prev, d) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}
