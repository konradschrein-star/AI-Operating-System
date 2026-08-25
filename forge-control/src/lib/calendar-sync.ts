/**
 * Google Calendar → task board, one direction, idempotently.
 *
 * Konrad's rule: "if in Google Calendar I enter a time slot, for example going
 * to the doctor, it should automatically turn into a task." Google Calendar is
 * the primary calendar and his phone talks to it directly, so anything he
 * schedules on the move has to arrive here without him opening the OS.
 *
 * The whole design rests on `day_tasks.gcal_event_id`. Keyed on the event id,
 * a second pass over the same window is a no-op rather than a second copy of
 * the week — which matters, because this runs on a timer.
 *
 * Lives in lib/ rather than inside the route so the background tick and the
 * HTTP endpoint cannot drift into two subtly different syncs.
 */

import { listCalendarEvents, dayWindow, weekWindow } from "./calendar.ts";
import { berlinDay, type Day } from "./day-score.ts";
import { createTask, updateTask, tasksByEventId } from "../db/daily.ts";

/** Longest task title the board will store; matches the route's own limit. */
const TITLE_MAX = 300;

export interface CalendarSyncOptions {
  day?: Day;
  view?: "day" | "week";
  dryRun?: boolean;
}

export interface CalendarSyncResult {
  dry_run: boolean;
  window: { start: string; end: string };
  events: number;
  created: string[];
  updated: string[];
  skipped: string[];
}

/** The Berlin calendar day an RFC3339 instant falls on. A Google event carries
 *  its own offset (`…T12:30:00+02:00`), so slicing the first ten characters is
 *  right only by accident — read it through the zone. */
export function berlinDayOfInstant(instant: string): Day {
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? berlinDay() : berlinDay(d);
}

/** Whole minutes between two instants, floored at 5 and capped at a day. */
export function durationMinutes(start: string, end: string): number {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 30;
  return Math.min(1440, Math.max(5, Math.round((b - a) / 60_000)));
}

/**
 * Do two timestamp strings name the same moment?
 *
 * Postgres hands back `2026-08-27 10:30:00+00` and Google sends
 * `2026-08-27T12:30:00+02:00`. Those are the same instant and never the same
 * characters, so a string compare reports every task as moved on every pass —
 * measured, a second sync over an unchanged week claimed two updates. Null is
 * never equal to anything: an absent time means "needs setting", not "matches".
 */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
}

/**
 * Pull one window of Google Calendar into the task board.
 *
 * All-day events are skipped deliberately: birthdays, public holidays and
 * multi-day trips are not units of work, and importing them would bury the
 * board on the first run. Cancelled events are skipped for the same reason.
 */
export async function syncCalendarWindow(
  options: CalendarSyncOptions = {},
): Promise<CalendarSyncResult> {
  const day: Day = options.day ?? berlinDay();
  const view = options.view ?? "week";
  const dryRun = options.dryRun === true;
  const window = view === "week" ? weekWindow(day) : dayWindow(day);

  const events = await listCalendarEvents({
    start: window.start,
    end: window.end,
    max: 250,
  });

  const linked = await tasksByEventId();
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const ev of events) {
    if (ev.all_day) {
      skipped.push(`${ev.id} (all-day)`);
      continue;
    }
    if (ev.status === "cancelled") {
      skipped.push(`${ev.id} (cancelled)`);
      continue;
    }

    const plannedDay = berlinDayOfInstant(ev.start);
    const mins = durationMinutes(ev.start, ev.end);
    const existing = linked.get(ev.id);

    if (existing) {
      // Only write when something actually moved. An unconditional UPDATE would
      // bump updated_at on every pass and make every task look freshly touched.
      if (existing.planned_day !== plannedDay || !sameInstant(existing.start_time, ev.start)) {
        if (!dryRun) {
          await updateTask(existing.id, {
            planned_day: plannedDay,
            start_time: ev.start,
            duration_min: mins,
          });
        }
        updated.push(ev.id);
      }
      continue;
    }

    if (!dryRun) {
      await createTask({
        title: ev.summary.slice(0, TITLE_MAX),
        area: "other",
        planned_day: plannedDay,
        est_min: mins,
        start_time: ev.start,
        duration_min: mins,
        gcal_event_id: ev.id,
        notes: ev.location ? `Location: ${ev.location}` : null,
      });
    }
    created.push(ev.id);
  }

  return {
    dry_run: dryRun,
    window: { start: window.start, end: window.end },
    events: events.length,
    created,
    updated,
    skipped,
  };
}
