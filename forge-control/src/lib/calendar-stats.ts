/**
 * Hours booked against hours worked, week by week.
 *
 * The week board can show what was ON the calendar and what got DONE, but never
 * the two against each other — and the gap between them is the only number that
 * says whether a plan was a plan or a wish. This module answers it per Mon–Sun
 * Berlin week:
 *
 *   booked_min  — timed Google Calendar events in that week
 *   worked_min  — tasks completed in that week, `duration_min ?? est_min ??
 *                 the length of the calendar event they are linked to`
 *   by_area     — where both went
 *
 * ── Failure is per week, and it is visible ─────────────────────────────────
 * Google is one `python3 google_api.py` away and it fails for reasons that have
 * nothing to do with this box: an expired token, a disabled API, a 476. So each
 * week fetches its own events and catches its own failure into `error`, and the
 * remaining weeks still come back with real numbers. A week that failed reports
 * `booked_min: 0` WITH a non-null `error` — the caller must render the message,
 * because zero booked hours and "we could not ask" look identical otherwise and
 * one of them is a lie.
 *
 * `worked_min` survives a Google outage: it comes from the database. Only the
 * event-length fallback for a task with neither duration nor estimate is lost,
 * and that is stated in the error rather than papered over.
 *
 * Deps are injected so the aggregation can be tested against a fixed event list
 * — the arithmetic is the part that can be wrong, and it must not need a live
 * calendar to prove.
 */

import { listCalendarEvents, weekStart, weekWindow, type CalendarEvent } from "./calendar.ts";
import { shiftDay, type Day } from "./day-score.ts";
import { doneTasksInRange, type DoneTaskInRange } from "../db/daily.ts";

/** Events with no task behind them are still hours he spent. This is their bucket. */
export const CALENDAR_AREA = "calendar";

/** A task with no area is not a task with no time. Its minutes land here. */
export const UNASSIGNED_AREA = "unassigned";

export const CALENDAR_STATS_DEFAULT_WEEKS = 2;
export const CALENDAR_STATS_MAX_WEEKS = 8;

export interface AreaSplit {
  area: string;
  booked_min: number;
  worked_min: number;
}

export interface WeekCalendarStats {
  week_start: Day;
  week_end: Day;
  booked_min: number;
  worked_min: number;
  events: number;
  tasks_done: number;
  by_area: AreaSplit[];
  /** Non-null when Google failed FOR THIS WEEK. The other weeks are unaffected. */
  error: string | null;
}

export interface CalendarStatsDeps {
  listEvents: (window: { start: string; end: string }) => Promise<CalendarEvent[]>;
  doneTasks: (from: Day, to: Day) => Promise<DoneTaskInRange[]>;
}

const liveDeps: CalendarStatsDeps = {
  listEvents: (window) => listCalendarEvents({ start: window.start, end: window.end, max: 250 }),
  doneTasks: (from, to) => doneTasksInRange(from, to),
};

/** Whole minutes an event occupies. All-day and cancelled events are not hours
 *  of work and are excluded before this is ever called. */
export function eventMinutes(event: CalendarEvent): number {
  const a = Date.parse(event.start);
  const b = Date.parse(event.end);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new Error(
      `calendar-stats: event ${event.id} has unparseable start/end ` +
        `(${JSON.stringify(event.start)} → ${JSON.stringify(event.end)})`,
    );
  }
  return b <= a ? 0 : Math.round((b - a) / 60_000);
}

/** A timed, live event — the only kind that counts as booked time. A birthday
 *  is not two hours of anything, and a cancelled meeting is the opposite of
 *  booked. */
function isTimedEvent(event: CalendarEvent): boolean {
  return event.all_day !== true && event.status !== "cancelled";
}

/**
 * Aggregate ONE week. Pure: no clock, no network, no database.
 *
 * `events` is what Google returned for the week (or null when the fetch failed),
 * `tasks` what the board completed in it.
 */
export function aggregateWeek(
  from: Day,
  to: Day,
  events: CalendarEvent[] | null,
  tasks: DoneTaskInRange[],
  error: string | null = null,
): WeekCalendarStats {
  const timed = (events ?? []).filter(isTimedEvent);
  const minutesByEvent = new Map<string, number>();
  for (const e of timed) minutesByEvent.set(e.id, eventMinutes(e));

  const areaOfEvent = new Map<string, string>();
  for (const t of tasks) {
    if (t.gcal_event_id !== null && minutesByEvent.has(t.gcal_event_id)) {
      areaOfEvent.set(t.gcal_event_id, t.area ?? UNASSIGNED_AREA);
    }
  }

  const booked = new Map<string, number>();
  const worked = new Map<string, number>();
  const add = (m: Map<string, number>, area: string, minutes: number): void => {
    m.set(area, (m.get(area) ?? 0) + minutes);
  };

  let bookedTotal = 0;
  for (const e of timed) {
    const minutes = minutesByEvent.get(e.id) ?? 0;
    bookedTotal += minutes;
    add(booked, areaOfEvent.get(e.id) ?? CALENDAR_AREA, minutes);
  }

  let workedTotal = 0;
  for (const t of tasks) {
    // `minutes` is already duration_min ?? est_min ?? 0 (db/daily.ts). The zero
    // is the case with nothing recorded — fall back to the length of the event
    // the task is bound to, which is the last honest source of a duration.
    const minutes =
      t.minutes > 0
        ? t.minutes
        : t.gcal_event_id !== null
          ? (minutesByEvent.get(t.gcal_event_id) ?? 0)
          : 0;
    workedTotal += minutes;
    add(worked, t.area ?? UNASSIGNED_AREA, minutes);
  }

  const areas = [...new Set([...booked.keys(), ...worked.keys()])].sort();
  return {
    week_start: from,
    week_end: to,
    booked_min: bookedTotal,
    worked_min: workedTotal,
    events: timed.length,
    tasks_done: tasks.length,
    by_area: areas.map((area) => ({
      area,
      booked_min: booked.get(area) ?? 0,
      worked_min: worked.get(area) ?? 0,
    })),
    error,
  };
}

/**
 * The last `weeks` Mon–Sun Berlin weeks, oldest first, the week containing
 * `today` last.
 */
export function weekRanges(today: Day, weeks: number): Array<{ from: Day; to: Day }> {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > CALENDAR_STATS_MAX_WEEKS) {
    throw new Error(
      `weekRanges: weeks must be an integer between 1 and ${CALENDAR_STATS_MAX_WEEKS}, got ${weeks}`,
    );
  }
  const current = weekStart(today);
  const out: Array<{ from: Day; to: Day }> = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const from = shiftDay(current, -7 * i);
    out.push({ from, to: shiftDay(from, 6) });
  }
  return out;
}

export async function calendarStats(
  opts: { weeks: number; today: Day },
  deps: CalendarStatsDeps = liveDeps,
): Promise<{ weeks: WeekCalendarStats[] }> {
  const ranges = weekRanges(opts.today, opts.weeks);

  const weeks = await Promise.all(
    ranges.map(async ({ from, to }) => {
      // The board's own week window, so a week here and a week there cover the
      // same instants including across a DST change.
      const window = weekWindow(from);
      // Deliberately NOT in the same try as the fetch: a database failure is a
      // real failure of this endpoint and must reach the caller as a 500, not
      // be relabelled as "Google is down".
      const tasks = await deps.doneTasks(from, to);
      let events: CalendarEvent[] | null = null;
      let error: string | null = null;
      try {
        events = await deps.listEvents({ start: window.start, end: window.end });
      } catch (err: unknown) {
        error = `Google Calendar unavailable for ${from}…${to}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      return aggregateWeek(from, to, events, tasks, error);
    }),
  );

  return { weeks };
}
