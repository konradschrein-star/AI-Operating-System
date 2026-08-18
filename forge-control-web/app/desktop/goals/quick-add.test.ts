/**
 * Tests for the GOALS/TASKS quick-add parser.
 *
 * Run: npx tsx --test app/desktop/goals/quick-add.test.ts
 * (node --test via tsx, same runner as forge-control/src/lib/*.test.ts —
 * no test framework dependency, and the parser imports nothing but itself so
 * the DOM never has to exist.)
 *
 * What these pin is not "the regex matches" but the two ways a one-line task
 * entry can lie to you: a marker silently eaten (the task files itself under
 * an importance or a day Konrad never typed) and a marker silently ignored
 * (he typed `tomorrow` and it landed on today). Both end the same way — he
 * stops trusting the box and stops writing tasks down, which is failure mode
 * §0.1 all over again.
 *
 * `now` is injected everywhere: a test that resolves "mon" against the wall
 * clock passes for six days a week.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseQuickAdd, toDayKey, addDays, fromDayKey } from "./quick-add";

/** Wednesday, 19 Aug 2026, 09:00 local. */
const NOW = new Date(2026, 7, 19, 9, 0, 0);

describe("parseQuickAdd — #area", () => {
  test("extracts the area and strips it from the title", () => {
    const r = parseQuickAdd("Finish the stats route #uni", NOW);
    assert.equal(r.area, "uni");
    assert.equal(r.title, "Finish the stats route");
  });

  test("is case-insensitive, position-independent, and first-one-wins", () => {
    const r = parseQuickAdd("#Business call the accountant #health", NOW);
    assert.equal(r.area, "business");
    assert.equal(r.title, "call the accountant");
  });

  test("leaves a bare # and a #1 in the title — those are not areas", () => {
    const r = parseQuickAdd("read #1 chapter # notes", NOW);
    assert.equal(r.area, null);
    assert.equal(r.title, "read #1 chapter # notes");
  });

  test("is null when no area was typed", () => {
    assert.equal(parseQuickAdd("water the plants", NOW).area, null);
  });
});

describe("parseQuickAdd — importance", () => {
  test("!! is critical (3)", () => {
    const r = parseQuickAdd("Pay the tax bill !!", NOW);
    assert.equal(r.importance, 3);
    assert.equal(r.title, "Pay the tax bill");
  });

  test("! is high (2)", () => {
    const r = parseQuickAdd("! Reply to the landlord", NOW);
    assert.equal(r.importance, 2);
    assert.equal(r.title, "Reply to the landlord");
  });

  test("a stray ! does not demote what !! just promoted", () => {
    assert.equal(parseQuickAdd("ship it !! !", NOW).importance, 3);
  });

  test("no marker means null, NOT a client-side default", () => {
    // §2 gives day_tasks.importance a server-side DEFAULT; inventing a second
    // one here is how the two drift apart.
    assert.equal(parseQuickAdd("tidy the desk", NOW).importance, null);
  });

  test("an exclamation attached to a word stays in the title", () => {
    const r = parseQuickAdd("Ship it!", NOW);
    assert.equal(r.importance, null);
    assert.equal(r.title, "Ship it!");
  });
});

describe("parseQuickAdd — ~estimate", () => {
  test("~30m is 30 minutes", () => {
    const r = parseQuickAdd("Write the intro ~30m", NOW);
    assert.equal(r.est_min, 30);
    assert.equal(r.title, "Write the intro");
  });

  test("hours convert to minutes", () => {
    assert.equal(parseQuickAdd("deep work ~2h", NOW).est_min, 120);
    assert.equal(parseQuickAdd("deep work ~1.5h", NOW).est_min, 90);
  });

  test("a bare ~number is minutes", () => {
    assert.equal(parseQuickAdd("call mum ~45", NOW).est_min, 45);
  });

  test("an implausible estimate stays in the title rather than being coerced", () => {
    const r = parseQuickAdd("nap ~0m and ~99h", NOW);
    assert.equal(r.est_min, null);
    assert.equal(r.title, "nap ~0m and ~99h");
  });
});

describe("parseQuickAdd — day words", () => {
  test("tomorrow is the next calendar day", () => {
    const r = parseQuickAdd("Renew the passport tomorrow", NOW);
    assert.equal(r.planned_day, "2026-08-20");
    assert.equal(r.title, "Renew the passport");
  });

  test("today is today", () => {
    assert.equal(parseQuickAdd("gym today", NOW).planned_day, "2026-08-19");
  });

  test("mon resolves to the next Monday", () => {
    // NOW is a Wednesday; the next Monday is the 24th.
    const r = parseQuickAdd("Lecture notes mon", NOW);
    assert.equal(r.planned_day, "2026-08-24");
    assert.equal(r.title, "Lecture notes");
  });

  test("naming today's weekday means NEXT week, not today", () => {
    // Typing "wed" on a Wednesday means the one coming, not the one you are
    // standing in — "today" is the word for that.
    assert.equal(parseQuickAdd("review wed", NOW).planned_day, "2026-08-26");
  });

  test("is null when no day was named", () => {
    assert.equal(parseQuickAdd("someday maybe", NOW).planned_day, null);
  });
});

describe("parseQuickAdd — the remainder is the title", () => {
  test("every marker together, title intact and whitespace collapsed", () => {
    const r = parseQuickAdd(
      "  Finish   the stats route #uni !! ~90m tomorrow ",
      NOW,
    );
    assert.deepEqual(r, {
      title: "Finish the stats route",
      area: "uni",
      importance: 3,
      est_min: 90,
      planned_day: "2026-08-20",
    });
  });

  test("markers first still leaves a usable title", () => {
    const r = parseQuickAdd("#health ! ~20m stretch properly", NOW);
    assert.equal(r.title, "stretch properly");
  });

  test("a line of markers only yields an empty title — the caller must refuse it", () => {
    assert.equal(parseQuickAdd("#uni !! ~30m tomorrow", NOW).title, "");
  });
});

describe("day keys", () => {
  test("toDayKey uses the LOCAL date, not UTC", () => {
    // 01:00 Berlin is still the previous day in UTC; toISOString() would file
    // the task on the wrong day and make it look carried.
    assert.equal(toDayKey(new Date(2026, 7, 19, 1, 0, 0)), "2026-08-19");
    assert.equal(toDayKey(new Date(2026, 0, 1, 23, 30, 0)), "2026-01-01");
  });

  test("addDays crosses month and year boundaries", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addDays("2026-08-19", 7), "2026-08-26");
  });

  test("fromDayKey round-trips and rejects nonsense loudly", () => {
    assert.equal(toDayKey(fromDayKey("2026-02-28")), "2026-02-28");
    assert.throws(() => fromDayKey("not-a-day"), /YYYY-MM-DD/);
  });
});
