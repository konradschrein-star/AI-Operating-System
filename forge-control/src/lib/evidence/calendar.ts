/**
 * Evidence source: calendar events that actually OCCURRED that Berlin day.
 *
 * Two rules, both borrowed rather than re-derived:
 *
 *  - The day window is `dayWindow(day)` from lib/calendar.ts — a two-pass,
 *    DST-correct resolution of Berlin midnight to a UTC instant. Nothing here
 *    appends a literal `Z` or a hardcoded `+02:00`; that is exactly the bug
 *    that shifted every day by two hours before calendar.ts existed.
 *
 *  - All-day events are skipped, and so are cancelled ones — the same filter
 *    lib/calendar-sync.ts applies when it turns events into tasks. A 24-hour
 *    block is not something that "happened at" a time.
 *
 * "Occurred" is one comparison: the event's END is at or before now. For a past
 * day every timed event satisfies that automatically; for today it excludes the
 * meeting that is still running and the one at 20:00 that has not started. The
 * clock is injectable so the rule can be tested without waiting for it.
 */

import { dayWindow, listCalendarEvents } from "../calendar.ts";
import { durationMinutes } from "../calendar-sync.ts";
import { tasksByEventId } from "../../db/daily.ts";
import type { Day } from "../day-score.ts";

export interface EventEvidence {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** Whole minutes, via calendar-sync's durationMinutes — which floors at 5 and
   *  caps at 1440. Shared on purpose: the number on this card and the
   *  `duration_min` on the task the same event created must agree. */
  minutes: number;
  /** The day_task bound to this event by calendar-sync, when there is one. */
  task_id: string | null;
}

/** Google's page size for one day. calendar-sync uses the same ceiling. */
const MAX_EVENTS = 250;

export async function eventsOccurred(
  day: Day,
  now: Date = new Date(),
): Promise<EventEvidence[]> {
  const window = dayWindow(day);
  const [events, byEvent] = await Promise.all([
    listCalendarEvents({ start: window.start, end: window.end, max: MAX_EVENTS }),
    tasksByEventId(),
  ]);

  const nowMs = now.getTime();
  const occurred: EventEvidence[] = [];

  for (const ev of events) {
    if (ev.all_day) continue;
    if (ev.status === "cancelled") continue;

    const endMs = Date.parse(ev.end);
    if (Number.isNaN(endMs)) {
      throw new Error(
        `calendar event ${ev.id} ("${ev.summary}") has an unparseable end "${ev.end}"`,
      );
    }
    if (endMs > nowMs) continue;

    occurred.push({
      id: ev.id,
      summary: ev.summary,
      start: ev.start,
      end: ev.end,
      minutes: durationMinutes(ev.start, ev.end),
      task_id: byEvent.get(ev.id)?.id ?? null,
    });
  }

  occurred.sort((a, b) => a.start.localeCompare(b.start));
  return occurred;
}
