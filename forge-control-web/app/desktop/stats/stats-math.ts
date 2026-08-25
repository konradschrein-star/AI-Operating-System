/**
 * The arithmetic behind StatsPanel — every function here is pure, so every
 * claim the panel makes is testable without a DOM, a fetch or a database.
 *
 * Nothing in this file reads React, tokens, or the network. The tiles own the
 * pixels; this file owns the numbers. When a tile prints a sentence Konrad
 * will act on ("0 of 20 rated days"), the sentence is built here and pinned by
 * `stats-math.test.ts`, because a sentence assembled inline in JSX is a
 * sentence no test ever sees.
 *
 * FAILURE POLICY (PLAN.md §3.6): out-of-contract input throws with the value
 * that broke it. There is no clamping and no silent `?? 0` — a felt rating of
 * 47 is a backend bug, and a chart that quietly plots it at the top of the
 * axis is how that bug ships.
 */

import type {
  DayCalendarStatsByArea,
  DayStatsDay,
  DayStatsHabit,
} from "../../api";

/* ── trend ────────────────────────────────────────────────────────────── */

/**
 * Trailing moving average; the first `n-1` points average what exists so the
 * line starts where the data starts instead of floating at zero.
 *
 * Moved here verbatim from `goals/StatsTab.tsx` (PLAN.md §5: "extract the
 * primitives, delete nothing yet") — StatsTab is unmounted since the week
 * board shipped, and a live panel importing from a dead tab is a deletion
 * hazard. StatsTab now re-exports this one.
 */
export function movingAverage(values: number[], n: number): number[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`movingAverage: window must be a positive integer, got ${n}`);
  }
  return values.map((_, i) => {
    const from = Math.max(0, i - n + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** The felt-rating scale, widened from 1..5 to 1..10 on 2026-08-25. */
export const FELT_MIN = 1;
export const FELT_MAX = 10;

/**
 * Felt rating (1..10) expressed on the score's 0..100 axis.
 *
 * This is the "index both series to a common base" answer to a two-scale plot,
 * NOT a second y-axis: a dual-axis chart lets the author slide one scale until
 * the two lines appear to agree, which invents a correlation that is not in the
 * data. One axis, one mapping, and ScoreTrend prints the mapping in its caption
 * so the reader can undo it by eye.
 *
 * 1 → 0 and 10 → 100, so the two ends of the felt scale are the two ends of
 * the axis; a felt 5 sits at 44, not at 50, and that is correct — 5 is below
 * the middle of a 1..10 scale.
 */
export function feltOnScoreAxis(subjective: number): number {
  if (!Number.isFinite(subjective) || subjective < FELT_MIN || subjective > FELT_MAX) {
    throw new Error(
      `feltOnScoreAxis: subjective must be ${FELT_MIN}..${FELT_MAX}, got ${subjective}`,
    );
  }
  return ((subjective - FELT_MIN) / (FELT_MAX - FELT_MIN)) * 100;
}

/** Days with a real score, oldest first. A null score had no denominator at
 *  all — it is dropped from the line rather than drawn as a zero, which is the
 *  difference between "did nothing" and "recorded nothing". */
export function scoredDays(days: DayStatsDay[]): (DayStatsDay & { score: number })[] {
  return days
    .filter((d): d is DayStatsDay & { score: number } => d.score !== null)
    .sort((a, b) => a.day.localeCompare(b.day));
}

/* ── habit ↔ felt rating ──────────────────────────────────────────────── */

/**
 * The exact sentence the HabitFelt tile prints while the sample is too small.
 *
 * Pinned verbatim by the task brief and by a test, because this string IS the
 * feature until roughly day 60: it is the only thing on the surface that tells
 * Konrad the answer is coming rather than absent. A chart of four rated days
 * would be noise wearing a trend's clothes.
 */
export function insufficientFeltSentence(ratedDays: number, needed: number): string {
  if (!Number.isInteger(ratedDays) || ratedDays < 0) {
    throw new Error(`insufficientFeltSentence: rated_days must be >= 0, got ${ratedDays}`);
  }
  if (!Number.isInteger(needed) || needed < 1) {
    throw new Error(`insufficientFeltSentence: needed must be >= 1, got ${needed}`);
  }
  return (
    `${ratedDays} of ${needed} rated days so far — rate a day on the board or ` +
    `in the journal; this answers itself after ~60 days.`
  );
}

/**
 * Geometry for one signed bar on a centred axis: where it starts and how wide,
 * both as percentages of the full track.
 *
 * `maxAbs` is the largest |delta| in the set, so the widest bar reaches the
 * edge of its half and every other bar is honestly proportional to it. A zero
 * `maxAbs` (every delta identical to zero) would divide by zero — the caller
 * must not draw bars at all in that case, and this throws to say so rather
 * than returning a NaN width that renders as an invisible bar.
 */
export function signedBarGeometry(
  delta: number,
  maxAbs: number,
): { leftPct: number; widthPct: number; positive: boolean } {
  if (!Number.isFinite(delta)) {
    throw new Error(`signedBarGeometry: delta must be finite, got ${delta}`);
  }
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) {
    throw new Error(`signedBarGeometry: maxAbs must be > 0, got ${maxAbs}`);
  }
  const half = (Math.min(Math.abs(delta), maxAbs) / maxAbs) * 50;
  const positive = delta >= 0;
  return { leftPct: positive ? 50 : 50 - half, widthPct: half, positive };
}

/** Largest |delta| among rows that carry one — the scale every bar is drawn
 *  against. Returns 0 when there is nothing to draw, which the tile reads as
 *  "print the rows as text, no bars". */
export function maxAbsDelta(rows: { delta: number | null }[]): number {
  return rows.reduce(
    (m, r) => (r.delta === null ? m : Math.max(m, Math.abs(r.delta))),
    0,
  );
}

/* ── habit matrix ─────────────────────────────────────────────────────── */

/**
 * The habit groups, in the order migration 0042 seeds them. Fixed order, not
 * discovered from the payload: a group that happens to have no ticks in the
 * window must still hold its place, or the matrix silently reorders itself
 * week to week and the reader's spatial memory is worthless.
 */
export const HABIT_GROUPS = ["morning", "body", "work", "evening"] as const;
export type HabitGroup = (typeof HABIT_GROUPS)[number];

export interface HabitGroupBlock {
  group: string;
  habits: DayStatsHabit[];
  /** Ticks in the window across every habit in the group, over the number of
   *  (habit × day) cells — the group's own density, printed beside its label. */
  density: number;
}

/**
 * Habits faceted into labelled blocks, one per group.
 *
 * WHY FACET RATHER THAN COLOUR BY GROUP — this is a deliberate departure from
 * "weighted group colour" and it is arithmetic, not taste. The dataviz skill's
 * validator was run over every 4-token subset of the theme palette in BOTH
 * modes (`accent ok bleed stuck warn info decide`): exactly THREE tokens sit
 * inside the OKLCH lightness band in dark AND light — accent, ok, bleed. Four
 * groups need a fourth hue and there isn't one, and the skill's own rule for
 * that case is "cut the series count, facet, or switch chart form", never
 * invent a hue. Faceting also beats colour here on its own merits: a printed
 * group label is legible to a colourblind reader, at 4px cell width, and in
 * a screenshot, none of which a hue is.
 *
 * Groups the payload does not know about are appended after the fixed four
 * rather than dropped — a habit invented in the DB must not vanish from the
 * matrix just because this constant is older than it is.
 */
export function habitGroupBlocks(habits: DayStatsHabit[], windowDays: number): HabitGroupBlock[] {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error(`habitGroupBlocks: windowDays must be >= 1, got ${windowDays}`);
  }
  const known = new Set<string>(HABIT_GROUPS);
  const extra = [...new Set(habits.map((h) => h.grp))]
    .filter((g) => !known.has(g))
    .sort();
  return [...HABIT_GROUPS, ...extra]
    .map((group) => {
      const rows = habits.filter((h) => h.grp === group);
      const cells = rows.length * windowDays;
      return {
        group,
        habits: rows,
        density: cells === 0 ? 0 : rows.reduce((n, h) => n + h.ticks.length, 0) / cells,
      };
    })
    .filter((b) => b.habits.length > 0);
}

/* ── calendar hours ───────────────────────────────────────────────────── */

/** Minutes as hours, one decimal — "3.5 h". Whole hours lose the decimal so a
 *  column of them does not read as false precision. */
export function hoursText(minutes: number): string {
  if (!Number.isFinite(minutes)) {
    throw new Error(`hoursText: minutes must be finite, got ${minutes}`);
  }
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/**
 * Areas for one week, biggest first, with the tail folded into "Other".
 *
 * `area` is free text on `day_tasks`, so the list is unbounded — and past
 * roughly seven classes adjacent rows stop being distinguishable at all. The
 * fold is capped at `keep` and the tail's size is RETURNED, not swallowed, so
 * the tile can print "+3 more folded into Other" instead of implying the list
 * was complete.
 */
export function foldAreas(
  areas: DayCalendarStatsByArea[],
  keep: number,
): { rows: DayCalendarStatsByArea[]; folded: number } {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`foldAreas: keep must be >= 1, got ${keep}`);
  }
  const sorted = [...areas].sort(
    (a, b) => b.booked_min + b.worked_min - (a.booked_min + a.worked_min),
  );
  if (sorted.length <= keep) return { rows: sorted, folded: 0 };
  const head = sorted.slice(0, keep);
  const tail = sorted.slice(keep);
  return {
    rows: [
      ...head,
      {
        area: "Other",
        booked_min: tail.reduce((n, a) => n + a.booked_min, 0),
        worked_min: tail.reduce((n, a) => n + a.worked_min, 0),
      },
    ],
    folded: tail.length,
  };
}
