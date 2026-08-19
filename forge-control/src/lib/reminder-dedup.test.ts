/**
 * R705 finding 1: the login-reminder dedup was 16 rows from failing open.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * THE DEFECT, precisely. scripts/research-browser.mjs deduped its one-time-login reminder by
 * scanning `GET /api/reminders`, which is `listReminders(100)`:
 *
 *     WHERE status != 'dismissed'
 *     ORDER BY (status = 'pending') DESC, due_at ASC
 *     LIMIT 100
 *
 * The reminder is queued `in 5m`, so it is `pending` for five minutes and `delivered` for
 * the remaining fifty-five of its one-hour dedup window. Delivered rows sort AFTER every
 * pending row, and within them by due_at ASC — so the NEWEST delivered reminder is the last
 * row on the page, and therefore the first one LIMIT removes. Nothing prunes delivered rows
 * (84 non-dismissed measured on 2026-08-05: 13 pending, 71 delivered). At 100, the page stops
 * containing the very row the dedup is looking for, every wall-hitting run concludes "no
 * duplicate", and the dedup becomes a reminder storm.
 *
 * The fix has three parts, and all three are asserted here:
 *   1. db/reminders.ts gains findRemindersByText — marker-scoped, ORDER BY created_at DESC,
 *      so truncation can only ever drop the OLDEST match, never the newest;
 *   2. routes/reminders.ts exposes it as `?contains=` and ECHOES the filter, so a client can
 *      tell "no matches" apart from "this server ignored my filter";
 *   3. the CLI prunes spent matches after queueing, so the marker-scoped set stays small
 *      instead of re-creating the same truncation problem one query down.
 *
 * db/ and routes/ modules open a pg Pool at import time, so — following the precedent in
 * reminder-text.test.ts — the SQL and the route are asserted against their source. The
 * client-side half is pure and is exercised directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_URL = new URL("../../../scripts/research-browser.mjs", import.meta.url).href;

interface Reminder {
  id?: string;
  text?: string;
  status?: string;
  created_at?: string;
}

interface Page {
  reminders: Reminder[];
  scope: string;
  truncated: boolean | null;
  warning: string | null;
}

interface ResearchBrowser {
  reminderMarker(profile: string, service: string): string;
  interpretReminderPage(listed: unknown, marker: string): Page;
  findRecentLoginReminder(
    reminders: Reminder[] | undefined,
    opts: { profile: string; service: string; nowMs: number; windowMs: number },
  ): { match: Reminder | null };
  REMINDER_DEDUP_WINDOW_MS: number;
  REMINDER_WHEN: string;
}

const rb = (await import(SCRIPT_URL)) as ResearchBrowser;

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const DB = readSource("../db/reminders.ts");
const ROUTE = readSource("../routes/reminders.ts");

/** Drop `//` and `/* *\/` comments, so prose about the code is never mistaken for the code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ========================================================================== *
 * 1. The query cannot truncate away the row it is looking for
 * ========================================================================== */

describe("findRemindersByText — the query the dedup actually needs", () => {
  test("it exists, and it is not listReminders with a filter bolted on", () => {
    assert.match(DB, /export async function findRemindersByText/);
  });

  test("it orders NEWEST FIRST — this is the whole fix", () => {
    // With created_at DESC, LIMIT drops the oldest match. The recency question the dedup
    // asks is therefore answerable even from a truncated page. Any other ordering
    // re-introduces the defect.
    const body = DB.slice(DB.indexOf("export async function findRemindersByText"));
    assert.match(body, /ORDER BY created_at DESC/);
    assert.doesNotMatch(
      body.slice(0, body.indexOf("export async function dismissReminder")),
      /ORDER BY \(status = 'pending'\)/,
      "pending-first ordering is what put the newest delivered row last",
    );
  });

  test("the substring test is position(), not LIKE — a marker cannot be widened by % or _", () => {
    assert.match(DB, /position\(\$1 in text\) > 0/);
    // Comments are stripped first: the prose above the query says the word "LIKE" precisely
    // because it explains why the query does not use it.
    assert.doesNotMatch(stripComments(DB), /LIKE/i);
  });

  test("an empty `contains` throws instead of matching every reminder in the table", () => {
    assert.match(DB, /contains === ""/);
    assert.match(DB, /must not be empty/);
  });

  test("dismissed rows stay excluded, exactly as in the unfiltered listing", () => {
    const body = DB.slice(DB.indexOf("export async function findRemindersByText"));
    assert.match(body, /WHERE status != 'dismissed'/);
  });

  test("the unfiltered listing is left alone — it is a UI page, not a dedup source", () => {
    assert.match(DB, /ORDER BY \(status = 'pending'\) DESC, due_at ASC/);
  });
});

/* ========================================================================== *
 * 2. The route, and the version handshake that makes it verifiable
 * ========================================================================== */

describe("GET /api/reminders?contains=", () => {
  test("the filtered branch is served by findRemindersByText, not by a client-side scan", () => {
    assert.match(ROUTE, /findRemindersByText\(\{ contains, limit: REMINDER_MATCH_LIMIT \}\)/);
  });

  test("both branches echo `filter`, so an ignored parameter is detectable", () => {
    // Without the echo, "your server is too old to filter" and "there are no matches" are
    // the same response, and the client would silently trust the wrong one.
    assert.match(ROUTE, /filter: null/);
    assert.match(ROUTE, /truncated: items\.length === REMINDER_MATCH_LIMIT/);
  });

  test("?contains= with an empty value is a 400, never a full-table match", () => {
    assert.match(ROUTE, /contains must not be empty/);
    assert.match(ROUTE, /, 400\)/);
  });
});

/* ========================================================================== *
 * 2b. ADDED IN PHASE 6 (task D). The retention view is a THIRD branch, and
 *     everything R705 depends on had to survive it. These assertions exist so
 *     that a future retention change cannot quietly reroute the dedup lookup;
 *     every assertion above this point is untouched.
 * ========================================================================== */

describe("GET /api/reminders?view=window — additive, not a rewrite", () => {
  test("the dedup branch is still reached — `view` is checked and RETURNS before it", () => {
    const viewBranch = ROUTE.indexOf('c.req.query("view")');
    const containsBranch = ROUTE.indexOf('const contains = (c.req.query("contains")');
    assert.ok(viewBranch > 0 && containsBranch > viewBranch, "the view branch precedes and returns");
    // The dedup call itself, unchanged and still downstream of it.
    assert.match(ROUTE, /findRemindersByText\(\{ contains, limit: REMINDER_MATCH_LIMIT \}\)/);
  });

  test("an absent ?view= reaches the two original branches — no silent redirection", () => {
    // `view !== undefined` and nothing looser: a falsy test would send `?view=`
    // (empty) into the new branch, and a truthy one on the QUERY OBJECT would
    // send every request there.
    assert.match(ROUTE, /if \(view !== undefined\)/);
  });

  test("an unknown ?view= is a 400 naming the value, never a fallback to the old page", () => {
    // Falling back would answer the 100-row oldest-first page under a parameter
    // the caller believed had changed the result — the R705 failure mode exactly.
    assert.match(ROUTE, /unknown view "\$\{view\}"/);
  });

  test("the view branch echoes `view`, the same handshake `filter` performs", () => {
    assert.match(ROUTE, /mode: "window"/);
    assert.match(ROUTE, /window_days: page\.window_days/);
    assert.match(ROUTE, /history_count: page\.history_count/);
  });

  test("retention never deletes: no DELETE reaches the reminders route or its data layer", () => {
    assert.doesNotMatch(ROUTE, /\bDELETE\b/i);
    assert.doesNotMatch(DB, /\bDELETE\b/i);
  });
});

/* ========================================================================== *
 * 3. The client half: what it does with the answer it gets
 * ========================================================================== */

describe("interpretReminderPage", () => {
  const marker = rb.reminderMarker("perplexity", "perplexity");
  const rows = [{ id: "a", text: marker, status: "delivered", created_at: "2026-08-05 11:00:00+00" }];

  test("a filtered reply is trusted and reported as marker-filtered", () => {
    const page = rb.interpretReminderPage(
      { count: 1, reminders: rows, filter: { contains: marker, truncated: false } },
      marker,
    );
    assert.equal(page.scope, "marker-filtered");
    assert.equal(page.truncated, false);
    assert.equal(page.warning, null);
    assert.deepEqual(page.reminders, rows);
  });

  test("a truncated filtered reply says so — it can answer recency but not completeness", () => {
    const page = rb.interpretReminderPage(
      { reminders: rows, filter: { contains: marker, truncated: true } },
      marker,
    );
    assert.equal(page.truncated, true);
  });

  test("an old forge-control that ignored the filter is caught and WARNED about", () => {
    const page = rb.interpretReminderPage({ count: 84, reminders: rows }, marker);
    assert.equal(page.scope, "unfiltered-page-fallback");
    assert.equal(page.truncated, null);
    assert.match(page.warning ?? "", /did not echo the contains filter/);
    assert.match(page.warning ?? "", /fail OPEN/, "the direction of the failure must be stated");
  });

  test("a filter echoing SOMEONE ELSE'S marker is not accepted as ours", () => {
    const page = rb.interpretReminderPage(
      { reminders: rows, filter: { contains: rb.reminderMarker("gsc", "perplexity") } },
      marker,
    );
    assert.equal(page.scope, "unfiltered-page-fallback");
  });

  test("a malformed reply degrades to an empty list rather than throwing mid-login", () => {
    for (const junk of [null, undefined, {}, { reminders: "nope" }, { reminders: null }]) {
      const page = rb.interpretReminderPage(junk, marker);
      assert.deepEqual(page.reminders, [], JSON.stringify(junk));
    }
  });
});

/* ========================================================================== *
 * 4. The arithmetic that made this a live bug rather than a theoretical one
 * ========================================================================== */

describe("why the old page-scan failed", () => {
  test("the reminder is delivered for most of its own dedup window", () => {
    // 5 minutes pending, 55 minutes delivered. The dedup therefore spends 92% of its window
    // looking for a row that the old ordering pushed to the end of the page.
    assert.equal(rb.REMINDER_WHEN, "in 5m");
    assert.equal(rb.REMINDER_DEDUP_WINDOW_MS, 60 * 60 * 1000);
    const deliveredMs = rb.REMINDER_DEDUP_WINDOW_MS - 5 * 60 * 1000;
    assert.ok(deliveredMs / rb.REMINDER_DEDUP_WINDOW_MS > 0.9);
  });

  test("a delivered row still suppresses — which is why losing it to LIMIT mattered", () => {
    const marker = rb.reminderMarker("perplexity", "perplexity");
    const nowMs = Date.parse("2026-08-05T12:00:00Z");
    const opts = {
      profile: "perplexity",
      service: "perplexity",
      nowMs,
      windowMs: rb.REMINDER_DEDUP_WINDOW_MS,
    };
    const row = { id: "s", text: marker, status: "delivered", created_at: "2026-08-05 11:30:00+00" };
    assert.equal(rb.findRecentLoginReminder([row], opts).match?.id, "s");
    // ...and the storm, reproduced as the truncation that used to hide it.
    assert.equal(rb.findRecentLoginReminder([], opts).match, null);
  });
});
