/**
 * Phase 6, task D: the ruled reminder retention, attacked from the direction the
 * red-team reviewer will attack it from.
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts, no test framework dependency)
 *
 * FIXTURES, NOT THE LIVE DB (N2). The live `reminders` table grew by three rows
 * during the six minutes of task B's triage
 * (`phase6/reminders-triage.md §1.1`), which is why "count before === count
 * after" was already recorded as unsatisfiable there. Every number below comes
 * from literals and a pinned clock, so a test that passes today passes at 3 a.m.
 * on a project day when the table is 400 rows deep.
 *
 * THE ONE RULE THIS FILE EXISTS FOR is (a): a `pending` row is ALWAYS visible as
 * its OWN row. Outside the window, sharing its text with four delivered rows,
 * recurring, 60 days stale — visible. A pending reminder has not fired yet, so
 * hiding one is not a presentation choice, it is a lost notification. Three
 * separate tests below try to make it disappear.
 *
 * The last section asserts the two things that MUST NOT MOVE, against source
 * text, following the precedent in reminder-dedup.test.ts (db/ opens a pg Pool at
 * import time, so it cannot be imported into a unit test): no DELETE reaches the
 * reminders data layer, and `claimDueReminders` still ADVANCES a recurring row's
 * due_at instead of creating a second one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  foldReminders,
  ReminderRetentionError,
  REMINDER_VIEW_DEFAULT_DAYS,
  REMINDER_VIEW_MAX_DAYS,
  type ReminderRetentionRow,
} from "./reminder-retention.ts";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** Pinned clock. Task B measured the live table at 2026-08-18 20:16Z; this is
 *  the same evening, so the fixture ages read the way the artefacts do. */
const NOW = new Date("2026-08-18T20:00:00Z");
const DAY = 86_400_000;

/** A `due_at` `days` days before NOW, in the text shape Postgres `::text` emits
 *  (`2026-08-18 20:00:00+00`) — not ISO, because that is not what the driver
 *  hands the code under test. */
function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "+00");
}

interface Row extends ReminderRetentionRow {
  source: string;
}

let seq = 0;
function row(over: Partial<Row> = {}): Row {
  seq++;
  return {
    id: over.id ?? `r${String(seq).padStart(3, "0")}`,
    text: over.text ?? `reminder ${seq}`,
    due_at: over.due_at ?? ago(1),
    recur: over.recur ?? null,
    status: over.status ?? "delivered",
    source: over.source ?? "chat",
  };
}

const W = { windowDays: REMINDER_VIEW_DEFAULT_DAYS, now: NOW };

/* ========================================================================== *
 * 1. RULE (a) — a pending row is always visible, as its own row
 * ========================================================================== */

describe("rule (a): pending is never hidden", () => {
  test("a pending row sharing its text with 4 delivered rows renders ALONE and visible", () => {
    const TEXT = "🔧 Watchdog: project \"operator-visibility\" was blocked by a failed run";
    const pending = row({ id: "p1", text: TEXT, status: "pending", due_at: ago(0.5) });
    const rows = [
      pending,
      row({ id: "d1", text: TEXT, due_at: ago(1) }),
      row({ id: "d2", text: TEXT, due_at: ago(2) }),
      row({ id: "d3", text: TEXT, due_at: ago(3) }),
      row({ id: "d4", text: TEXT, due_at: ago(4) }),
    ];

    // Default (the ruling): nothing collapses at all.
    const ruled = foldReminders(rows, W);
    assert.deepEqual(
      ruled.visible.map((r) => r.id),
      ["p1", "d1", "d2", "d3", "d4"],
      "pending first, then delivered newest-first",
    );
    assert.equal(ruled.visible[0].repeat_count, 1, "the pending row stands for itself only");
    assert.deepEqual(ruled.visible[0].repeat_ids, ["p1"]);

    // And with grouping switched on — the case that could swallow it.
    const grouped = foldReminders(rows, { ...W, groupRepeats: true });
    const pendingRows = grouped.visible.filter((r) => r.status === "pending");
    assert.equal(pendingRows.length, 1, "the pending row survives the collapse");
    assert.equal(pendingRows[0].id, "p1");
    assert.equal(pendingRows[0].repeat_count, 1, "and is not counted inside the cluster");
    assert.equal(grouped.visible.length, 2, "4 delivered collapse to 1, pending stays its own row");
    const cluster = grouped.visible.find((r) => r.status === "delivered");
    assert.equal(cluster?.repeat_count, 4);
    assert.equal(cluster?.repeat_ids.includes("p1"), false, "the pending id is not inside a group");
    assert.equal(
      grouped.counts.represented,
      5,
      "2 rows on screen still stand for all 5 reminders",
    );
  });

  test("a pending row with a due_at 60 days old is visible — the window does not apply to it", () => {
    const rows = [
      row({ id: "stale", status: "pending", due_at: ago(60) }),
      row({ id: "old", status: "delivered", due_at: ago(60) }),
    ];
    const v = foldReminders(rows, W);
    assert.deepEqual(v.visible.map((r) => r.id), ["stale"]);
    assert.equal(v.history_count, 1, "only the DELIVERED 60-day row went to history");
    assert.equal(v.counts.pending, 1);
  });

  test("a pending row 60 days old that shares its text with history still renders", () => {
    const TEXT = "same text, different fate";
    const rows = [
      row({ id: "p", text: TEXT, status: "pending", due_at: ago(60) }),
      row({ id: "h1", text: TEXT, status: "delivered", due_at: ago(59) }),
      row({ id: "h2", text: TEXT, status: "delivered", due_at: ago(58) }),
    ];
    for (const groupRepeats of [false, true]) {
      const v = foldReminders(rows, { ...W, groupRepeats });
      assert.deepEqual(v.visible.map((r) => r.id), ["p"], `groupRepeats=${groupRepeats}`);
      assert.equal(v.history_count, 2);
    }
  });

  test("a pending row due in the FUTURE is visible, and sorts before a later one", () => {
    const soon = new Date(NOW.getTime() + 3_600_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");
    const later = new Date(NOW.getTime() + 90 * DAY).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");
    const v = foldReminders(
      [row({ id: "later", status: "pending", due_at: later }), row({ id: "soon", status: "pending", due_at: soon })],
      W,
    );
    assert.deepEqual(v.visible.map((r) => r.id), ["soon", "later"], "soonest pending first");
  });
});

/* ========================================================================== *
 * 2. RULE (b) — the window, and its exact boundary
 * ========================================================================== */

describe("rule (b): delivered rows inside the window are visible, older ones are counted", () => {
  test("the boundary is inclusive, and one millisecond older falls into history", () => {
    const onCutoff = new Date(NOW.getTime() - 7 * DAY).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");
    const justOlder = new Date(NOW.getTime() - 7 * DAY - 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "+00");
    const v = foldReminders(
      [row({ id: "in", due_at: onCutoff }), row({ id: "out", due_at: justOlder })],
      W,
    );
    assert.deepEqual(v.visible.map((r) => r.id), ["in"]);
    assert.equal(v.history_count, 1);
  });

  test("delivered rows render NEWEST FIRST — escalation §3.3 fix 1", () => {
    // listReminders() orders due_at ASC, which is why the phone opens on a
    // 2 July smoke test. That query is untouched (R705 asserts its text); this
    // is the new path and it is the other way round.
    const v = foldReminders(
      [row({ id: "b", due_at: ago(2) }), row({ id: "c", due_at: ago(3) }), row({ id: "a", due_at: ago(1) })],
      W,
    );
    assert.deepEqual(v.visible.map((r) => r.id), ["a", "b", "c"]);
  });

  test("a wider window pulls history back into view — this is how 'show' works", () => {
    const rows = [row({ id: "recent", due_at: ago(2) }), row({ id: "july", due_at: ago(47) })];
    assert.equal(foldReminders(rows, W).history_count, 1);
    const all = foldReminders(rows, { windowDays: REMINDER_VIEW_MAX_DAYS, now: NOW });
    assert.equal(all.history_count, 0);
    assert.deepEqual(all.visible.map((r) => r.id), ["recent", "july"]);
  });

  test("window_days is echoed back, so the surface can label its own unit", () => {
    assert.equal(foldReminders([], W).window_days, 7);
    assert.equal(foldReminders([], { windowDays: 30, now: NOW }).window_days, 30);
  });
});

/* ========================================================================== *
 * 3. Dismissed rows — excluded, exactly as today, and counted anyway
 * ========================================================================== */

describe("dismissed rows", () => {
  test("a dismissed row is excluded from the view — the same rule listReminders() has", () => {
    const v = foldReminders(
      [row({ id: "keep", due_at: ago(1) }), row({ id: "gone", status: "dismissed", due_at: ago(1) })],
      W,
    );
    assert.deepEqual(v.visible.map((r) => r.id), ["keep"]);
    assert.equal(v.counts.dismissed, 1);
    assert.equal(v.history_count, 0, "dismissed is not history — they are different numbers");
  });

  test("a dismissed PENDING-dated row stays excluded — dismissal outranks rule (a)", () => {
    // Dismissal is Konrad's own verb (escalation §3.2: only he dismisses), so it
    // is the one thing allowed to take a row off the list.
    const v = foldReminders([row({ id: "d", status: "dismissed", due_at: ago(60) })], W);
    assert.deepEqual(v.visible, []);
    assert.equal(v.counts.dismissed, 1);
  });
});

/* ========================================================================== *
 * 4. RULE (e) — the arithmetic adds up to the input length
 * ========================================================================== */

describe("rule (e): nothing is dropped without being counted", () => {
  test("dismissed + pending + delivered_in_window + history === input, on a mixed table", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row({ id: `p${i}`, status: "pending", due_at: ago(30 * i) })),
      ...Array.from({ length: 11 }, (_, i) => row({ id: `w${i}`, due_at: ago(i * 0.5) })),
      ...Array.from({ length: 104 }, (_, i) => row({ id: `h${i}`, due_at: ago(8 + i * 0.3) })),
      ...Array.from({ length: 20 }, (_, i) => row({ id: `x${i}`, status: "dismissed" })),
    ];
    const v = foldReminders(rows, W);
    const c = v.counts;
    assert.equal(c.input, 138);
    assert.equal(c.pending, 3);
    assert.equal(c.delivered_in_window, 11);
    assert.equal(c.history, 104);
    assert.equal(c.dismissed, 20);
    assert.equal(c.dismissed + c.pending + c.delivered_in_window + c.history, c.input);
    assert.equal(v.history_count, c.history, "history_count is the number the fold shows");
    assert.equal(c.visible_rows, 14);
    assert.equal(c.represented, 14, "nothing collapsed, so every visible row stands for itself");
  });

  test("with grouping on, visible_rows shrinks but represented does not", () => {
    const rows = [
      row({ id: "a1", text: "watchdog", due_at: ago(1) }),
      row({ id: "a2", text: "watchdog", due_at: ago(2) }),
      row({ id: "a3", text: "watchdog", due_at: ago(3) }),
      row({ id: "b1", text: "other", due_at: ago(1.5) }),
      row({ id: "old", text: "watchdog", due_at: ago(40) }),
    ];
    const v = foldReminders(rows, { ...W, groupRepeats: true });
    assert.equal(v.counts.visible_rows, 2);
    assert.equal(v.counts.represented, 4, "3 collapsed + 1 alone");
    assert.equal(v.history_count, 1);
    assert.equal(v.counts.represented + v.history_count + v.counts.dismissed, v.counts.input);
  });

  test("an empty table produces zeroes, not a missing number", () => {
    const v = foldReminders([], W);
    assert.deepEqual(v.visible, []);
    assert.deepEqual(v.groups, []);
    assert.equal(v.history_count, 0);
    assert.equal(v.counts.input, 0);
    assert.equal(v.counts.represented, 0);
  });
});

/* ========================================================================== *
 * 5. RULE (c) — repeat clusters, and the ruling that they are REPORTED not COLLAPSED
 * ========================================================================== */

describe("rule (c): repeat clusters", () => {
  const rows = [
    row({ id: "w1", text: "watchdog unwedged operator-visibility", due_at: ago(1) }),
    row({ id: "w2", text: "watchdog unwedged operator-visibility", due_at: ago(2) }),
    row({ id: "w3", text: "watchdog unwedged operator-visibility", due_at: ago(3) }),
    row({ id: "w4", text: "watchdog unwedged operator-visibility", due_at: ago(4) }),
    row({ id: "s1", text: "singleton", due_at: ago(1.2) }),
  ];

  test("BY DEFAULT nothing collapses — Konrad did not pick option 4 (escalation §3.2)", () => {
    const v = foldReminders(rows, W);
    assert.equal(v.visible.length, 5, "all five rows render separately");
    assert.ok(v.visible.every((r) => r.repeat_count === 1));
    assert.equal(v.groups.length, 1, "the cluster is still REPORTED — it is information");
    assert.equal(v.groups[0].collapsed, false, "…and says, honestly, that it was not collapsed");
    assert.equal(v.groups[0].count, 4);
  });

  test("when it IS ruled on, the cluster carries an honest count and the NEWEST due_at", () => {
    const v = foldReminders(rows, { ...W, groupRepeats: true });
    const cluster = v.visible.find((r) => r.repeat_count > 1);
    assert.equal(cluster?.repeat_count, 4);
    assert.equal(cluster?.due_at, ago(1), "the newest of the four, not the oldest");
    assert.deepEqual(cluster?.repeat_ids, ["w1", "w2", "w3", "w4"]);
    assert.equal(v.groups[0].newest_due_at, ago(1));
    assert.equal(v.groups[0].collapsed, true);
  });

  test("a cluster split by the window only groups the rows that are IN the window", () => {
    const v = foldReminders(
      [...rows, row({ id: "wOld", text: "watchdog unwedged operator-visibility", due_at: ago(30) })],
      { ...W, groupRepeats: true },
    );
    assert.equal(v.groups[0].count, 4, "the 30-day-old row is history, not part of the badge");
    assert.equal(v.groups[0].ids.includes("wOld"), false);
    assert.equal(v.history_count, 1);
  });

  test("a singleton is never reported as a group", () => {
    const v = foldReminders([row({ id: "only", text: "unique", due_at: ago(1) })], W);
    assert.deepEqual(v.groups, []);
  });
});

/* ========================================================================== *
 * 6. RULE (d) — a recurring reminder is ALREADY one row. Assert it, do not fix it.
 * ========================================================================== */

const DB = readFileSync(fileURLToPath(new URL("../db/reminders.ts", import.meta.url)), "utf8");
const ROUTE = readFileSync(fileURLToPath(new URL("../routes/reminders.ts", import.meta.url)), "utf8");

describe("rule (d): recurring renders as one row because the WRITE path advances it", () => {
  test("one recurring row in, one row out — there is no per-occurrence expansion here", () => {
    const v = foldReminders(
      [row({ id: "daily", status: "pending", recur: "daily", due_at: ago(0.1) })],
      W,
    );
    assert.equal(v.visible.length, 1);
    assert.equal(v.visible[0].recur, "daily");
    assert.equal(v.visible[0].repeat_count, 1);
  });

  test("claimDueReminders UPDATEs due_at for a recurring row — it does not INSERT a second one", () => {
    const claim = DB.slice(DB.indexOf("export async function claimDueReminders"));
    assert.match(claim, /if \(rem\.recur\)/);
    assert.match(claim, /SET due_at = \$2, delivered_at = now\(\)/);
    assert.doesNotMatch(claim, /INSERT INTO reminders/, "a recurrence is an advance, not a new row");
  });

  test("a recurring row therefore stays 'pending' forever — so rule (a) is what keeps it visible", () => {
    // 0 recurring rows exist today (reminders-triage.md §1.6); this is the
    // forward-looking assertion, and it is why the window must never apply to
    // pending rows: a daily reminder whose due_at has been advanced 60 times is
    // still one row, and it is still pending.
    const v = foldReminders(
      [row({ id: "old-daily", status: "pending", recur: "daily", due_at: ago(400) })],
      W,
    );
    assert.equal(v.visible.length, 1);
    assert.equal(v.history_count, 0);
  });
});

/* ========================================================================== *
 * 7. Explicit error paths (N1) — no silent defaults anywhere
 * ========================================================================== */

describe("bad input throws with the value in the message", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, REMINDER_VIEW_MAX_DAYS + 1]) {
    test(`windowDays ${String(bad)} is refused`, () => {
      assert.throws(
        () => foldReminders([], { windowDays: bad, now: NOW }),
        (e: unknown) =>
          e instanceof ReminderRetentionError && new RegExp(String(bad).slice(0, 6)).test(e.message),
      );
    });
  }

  test("an invalid clock is refused rather than silently becoming 'now'", () => {
    assert.throws(
      () => foldReminders([], { windowDays: 7, now: new Date("nonsense") }),
      ReminderRetentionError,
    );
  });

  test("an unparseable due_at names the row instead of sorting it to one end", () => {
    assert.throws(
      () => foldReminders([row({ id: "broken", due_at: "not a timestamp" })], W),
      (e: unknown) => e instanceof ReminderRetentionError && /broken/.test(e.message),
    );
  });

  test("an unknown status is refused — a new lifecycle state must not silently vanish", () => {
    const rogue = { ...row({ id: "rogue" }), status: "snoozed" } as unknown as Row;
    assert.throws(
      () => foldReminders([rogue], W),
      (e: unknown) => e instanceof ReminderRetentionError && /snoozed/.test(e.message),
    );
  });
});

/* ========================================================================== *
 * 8. THE THINGS THAT MUST NOT MOVE
 * ========================================================================== */

describe("phase 6 invariants, asserted against source", () => {
  test("NO ROW IS DELETED — there is no DELETE anywhere in the reminders data layer", () => {
    // `SELECT count(*) FROM reminders` before and after phase 6 must be
    // identical. Hide, group, collapse, archive — yes. DELETE — no.
    assert.doesNotMatch(DB, /\bDELETE\b/i);
    assert.doesNotMatch(ROUTE, /\bDELETE\b/i);
  });

  test("dismissal is still an UPDATE to status='dismissed' — the archive verb, unchanged", () => {
    assert.match(DB, /UPDATE reminders SET status = 'dismissed'/);
  });

  test("the delivery path's claim query is intact — FOR UPDATE SKIP LOCKED and all", () => {
    const claim = DB.slice(DB.indexOf("export async function claimDueReminders"));
    assert.match(claim, /WHERE status = 'pending' AND due_at <= now\(\)/);
    assert.match(claim, /FOR UPDATE SKIP LOCKED/);
    assert.match(claim, /SET status = 'delivered', delivered_at = now\(\)/);
  });

  test("the R705 dedup query and the unfiltered listing are still exactly as they were", () => {
    assert.match(DB, /ORDER BY \(status = 'pending'\) DESC, due_at ASC/);
    assert.match(DB, /ORDER BY created_at DESC/);
    assert.match(ROUTE, /findRemindersByText\(\{ contains, limit: REMINDER_MATCH_LIMIT \}\)/);
  });

  test("the new view is a THIRD branch, keyed on ?view= — it does not reroute the other two", () => {
    assert.match(DB, /export async function listRemindersForView/);
    assert.match(ROUTE, /listRemindersForView/);
    assert.match(ROUTE, /c\.req\.query\("view"\)/);
  });
});
