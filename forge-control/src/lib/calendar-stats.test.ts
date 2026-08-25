/**
 * Hours booked vs hours worked — the aggregation, and what a Google outage does
 * to it.
 *
 * Run: cd forge-control && pnpm test   (tsx --test)
 *
 * ── WHAT THIS FILE GUARDS ───────────────────────────────────────────────────
 * Two failure modes, both silent:
 *
 *   1. One week's Google call fails and the whole endpoint answers 502, so a
 *      transient token problem last Tuesday erases this week's real numbers.
 *      The `error` assertions below fail against any implementation that lets a
 *      rejection out of one week into another.
 *   2. A failed week reports `booked_min: 0` with `error: null`, which reads on
 *      screen as "you booked nothing" — a statement about his week rather than
 *      about the API. Every failing-week assertion checks the error is CARRIED,
 *      not just that the number is zero.
 *
 * The event list is injected, so the arithmetic is proved without a calendar,
 * a token, or a python subprocess.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateWeek,
  calendarStats,
  eventMinutes,
  weekRanges,
  CALENDAR_AREA,
  CALENDAR_STATS_MAX_WEEKS,
  UNASSIGNED_AREA,
  type CalendarStatsDeps,
} from "./calendar-stats.ts";
import type { CalendarEvent } from "./calendar.ts";
import type { DoneTaskInRange } from "../db/daily.ts";
import type { Day } from "./day-score.ts";

const THIS_WEEK: { from: Day; to: Day } = { from: "2026-08-24", to: "2026-08-30" };

function event(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    summary: `event ${over.id}`,
    start: "2026-08-24T09:00:00+02:00",
    end: "2026-08-24T10:00:00+02:00",
    ...over,
  };
}

function done(over: Partial<DoneTaskInRange> & { id: string }): DoneTaskInRange {
  return {
    title: `task ${over.id}`,
    area: null,
    done_at: "2026-08-24T18:00:00+02:00",
    minutes: 0,
    gcal_event_id: null,
    goal_id: null,
    goal_title: null,
    goal_horizon: null,
    ...over,
  };
}

describe("eventMinutes", () => {
  test("counts whole minutes across a timezone offset", () => {
    assert.equal(
      eventMinutes(event({ id: "a", start: "2026-08-24T09:00:00+02:00", end: "2026-08-24T10:30:00+02:00" })),
      90,
    );
    // Same instants, written in UTC. The offset must not change the answer.
    assert.equal(
      eventMinutes(event({ id: "b", start: "2026-08-24T07:00:00Z", end: "2026-08-24T08:30:00Z" })),
      90,
    );
  });

  test("an inverted or zero-length event is zero, not negative", () => {
    assert.equal(
      eventMinutes(event({ id: "c", start: "2026-08-24T10:00:00Z", end: "2026-08-24T09:00:00Z" })),
      0,
    );
  });

  test("an unparseable stamp throws with the event id in the message", () => {
    assert.throws(
      () => eventMinutes(event({ id: "bad", start: "not a date" })),
      /event bad has unparseable start\/end/,
    );
  });
});

describe("aggregateWeek — what counts as booked", () => {
  test("all-day and cancelled events are excluded from booked time", () => {
    const week = aggregateWeek(
      THIS_WEEK.from,
      THIS_WEEK.to,
      [
        event({ id: "meeting", start: "2026-08-25T09:00:00+02:00", end: "2026-08-25T11:00:00+02:00" }),
        event({
          id: "birthday",
          all_day: true,
          start: "2026-08-26T00:00:00+02:00",
          end: "2026-08-27T00:00:00+02:00",
        }),
        event({
          id: "called-off",
          status: "cancelled",
          start: "2026-08-27T09:00:00+02:00",
          end: "2026-08-27T17:00:00+02:00",
        }),
      ],
      [],
    );
    // 120 minutes, not 120 + 1440 + 480.
    assert.equal(week.booked_min, 120);
    assert.equal(week.events, 1);
  });
});

describe("aggregateWeek — what counts as worked", () => {
  test("duration wins over estimate wins over the linked event's length", () => {
    const events = [
      event({ id: "ev-long", start: "2026-08-24T09:00:00+02:00", end: "2026-08-24T12:00:00+02:00" }),
    ];
    const week = aggregateWeek(THIS_WEEK.from, THIS_WEEK.to, events, [
      // db/daily.ts already collapsed duration_min ?? est_min ?? 0 into `minutes`.
      done({ id: "t-recorded", minutes: 45, gcal_event_id: "ev-long" }),
      // Nothing recorded, but bound to a three-hour block: the block is the only
      // honest source of a duration left.
      done({ id: "t-fallback", minutes: 0, gcal_event_id: "ev-long" }),
      // Nothing recorded and nothing linked: zero, not a guess.
      done({ id: "t-unknown", minutes: 0 }),
    ]);
    assert.equal(week.worked_min, 45 + 180);
    assert.equal(week.tasks_done, 3);
  });

  test("a task linked to an event outside this week does not borrow its minutes", () => {
    const week = aggregateWeek(THIS_WEEK.from, THIS_WEEK.to, [event({ id: "ev-here" })], [
      done({ id: "t", minutes: 0, gcal_event_id: "ev-elsewhere" }),
    ]);
    assert.equal(week.worked_min, 0);
  });
});

describe("aggregateWeek — the area split", () => {
  const events = [
    event({ id: "ev-biz", start: "2026-08-24T09:00:00+02:00", end: "2026-08-24T11:00:00+02:00" }),
    event({ id: "ev-loose", start: "2026-08-25T09:00:00+02:00", end: "2026-08-25T09:30:00+02:00" }),
  ];
  const tasks = [
    done({ id: "t-biz", area: "business", minutes: 60, gcal_event_id: "ev-biz" }),
    done({ id: "t-yt", area: "youtube", minutes: 25 }),
    done({ id: "t-none", area: null, minutes: 10 }),
  ];

  test("an event linked to a task takes the task's area; an unlinked one is 'calendar'", () => {
    const week = aggregateWeek(THIS_WEEK.from, THIS_WEEK.to, events, tasks);
    const by = new Map(week.by_area.map((a) => [a.area, a]));
    assert.equal(by.get("business")?.booked_min, 120);
    assert.equal(by.get(CALENDAR_AREA)?.booked_min, 30);
    assert.equal(by.get(CALENDAR_AREA)?.worked_min, 0);
  });

  test("worked minutes land under the task's own area, null under 'unassigned'", () => {
    const week = aggregateWeek(THIS_WEEK.from, THIS_WEEK.to, events, tasks);
    const by = new Map(week.by_area.map((a) => [a.area, a]));
    assert.equal(by.get("business")?.worked_min, 60);
    assert.equal(by.get("youtube")?.worked_min, 25);
    assert.equal(by.get(UNASSIGNED_AREA)?.worked_min, 10);
    // youtube had no calendar time at all — the row exists with a zero, which is
    // "worked without booking it", a real and interesting shape.
    assert.equal(by.get("youtube")?.booked_min, 0);
  });

  test("the split sums to the week totals", () => {
    const week = aggregateWeek(THIS_WEEK.from, THIS_WEEK.to, events, tasks);
    assert.equal(
      week.by_area.reduce((n, a) => n + a.booked_min, 0),
      week.booked_min,
    );
    assert.equal(
      week.by_area.reduce((n, a) => n + a.worked_min, 0),
      week.worked_min,
    );
    assert.deepEqual(
      week.by_area.map((a) => a.area),
      ["business", "calendar", "unassigned", "youtube"],
    );
  });
});

describe("aggregateWeek — a week Google could not answer for", () => {
  test("null events with an error keeps the database half and carries the message", () => {
    const week = aggregateWeek(
      THIS_WEEK.from,
      THIS_WEEK.to,
      null,
      [done({ id: "t", area: "business", minutes: 50 })],
      "Google Calendar unavailable for 2026-08-24…2026-08-30: token expired",
    );
    assert.equal(week.booked_min, 0);
    assert.equal(week.events, 0);
    // The work still happened and the board still knows about it.
    assert.equal(week.worked_min, 50);
    assert.equal(week.tasks_done, 1);
    assert.match(week.error ?? "", /token expired/);
  });
});

describe("weekRanges", () => {
  test("oldest first, the week containing today last, Mon–Sun", () => {
    const ranges = weekRanges("2026-08-26", 3); // a Wednesday
    assert.deepEqual(ranges, [
      { from: "2026-08-10", to: "2026-08-16" },
      { from: "2026-08-17", to: "2026-08-23" },
      { from: "2026-08-24", to: "2026-08-30" },
    ]);
  });

  test("a Sunday belongs to the week that started the previous Monday", () => {
    assert.deepEqual(weekRanges("2026-08-30", 1), [{ from: "2026-08-24", to: "2026-08-30" }]);
  });

  test("out-of-range week counts throw rather than clamp", () => {
    assert.throws(() => weekRanges("2026-08-26", 0), /weeks must be an integer between 1 and 8/);
    assert.throws(
      () => weekRanges("2026-08-26", CALENDAR_STATS_MAX_WEEKS + 1),
      /weeks must be an integer between 1 and 8/,
    );
    assert.throws(() => weekRanges("2026-08-26", 1.5), /weeks must be an integer/);
  });
});

describe("calendarStats — one week failing does not take the others down", () => {
  /** Google answers for every week except the one starting 2026-08-17. */
  const deps = (failFor: string): CalendarStatsDeps => ({
    listEvents: async (window) => {
      if (window.start.startsWith(failFor)) {
        throw new Error("HTTP 476 from Google, Retry-After: 86400");
      }
      return [
        event({
          id: `ev-${window.start.slice(0, 10)}`,
          start: "2026-08-24T09:00:00+02:00",
          end: "2026-08-24T10:00:00+02:00",
        }),
      ];
    },
    doneTasks: async (from) => [done({ id: `t-${from}`, area: "business", minutes: 30 })],
  });

  test("the failing week is flagged; the healthy ones carry real numbers", async () => {
    const { weeks } = await calendarStats(
      { weeks: 3, today: "2026-08-26" },
      deps("2026-08-16"), // the Berlin instant of Monday 2026-08-17 is 08-16T22:00Z
    );
    assert.equal(weeks.length, 3);

    const failed = weeks.find((w) => w.week_start === "2026-08-17");
    assert.ok(failed, "the 08-17 week is missing from the response");
    assert.match(failed.error ?? "", /Retry-After/);
    assert.equal(failed.booked_min, 0);
    // …and its database half survived the outage.
    assert.equal(failed.worked_min, 30);

    for (const w of weeks.filter((x) => x.week_start !== "2026-08-17")) {
      assert.equal(w.error, null, `${w.week_start} should not carry an error`);
      assert.equal(w.booked_min, 60);
      assert.equal(w.worked_min, 30);
    }
  });

  test("a database failure is NOT relabelled as a calendar outage", async () => {
    // Hard errors are policy: if the board's own numbers cannot be read, the
    // endpoint fails loudly instead of reporting a week of zeros with a
    // Google-shaped excuse on it.
    await assert.rejects(
      () =>
        calendarStats(
          { weeks: 2, today: "2026-08-26" },
          {
            listEvents: async () => [],
            doneTasks: async () => {
              throw new Error("relation day_tasks does not exist");
            },
          },
        ),
      /relation day_tasks does not exist/,
    );
  });
});
