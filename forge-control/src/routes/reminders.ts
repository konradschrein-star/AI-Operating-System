/**
 * Reminders routes.
 *
 *   GET  /api/reminders              → open reminders (pending first)
 *   GET  /api/reminders?contains=X   → open reminders whose text contains X,
 *                                    NEWEST FIRST — the dedup lookup (R705)
 *   GET  /api/reminders?view=window&days=7
 *                                    → the RULED retention view: every pending
 *                                    row plus the last `days` of delivered ones,
 *                                    newest first, with everything older counted
 *                                    into `view.history_count` instead of hidden.
 *                                    Ruling: docs/plan/artifacts/os-usable-for-work/
 *                                    phase6/reminders-policy-escalation.md §3.
 *   POST /api/reminders              { text, when } — when is a natural
 *                                    expression ("in 2h", "tomorrow 9:00",
 *                                    "daily 08:30", "2026-07-04 14:00")
 *   POST /api/reminders/:id/dismiss
 *
 * Delivery into inbox_items happens in the executor's reminderTick.
 */

import { Hono } from "hono";
import {
  createReminder,
  listReminders,
  listRemindersForView,
  findRemindersByText,
  dismissReminder,
  REMINDER_MATCH_LIMIT,
} from "../db/reminders.ts";
import {
  REMINDER_VIEW_DEFAULT_DAYS,
  REMINDER_VIEW_MAX_DAYS,
} from "../lib/reminder-retention.ts";
import { parseWhen } from "../lib/when-parser.ts";
import { ReminderTextTooLongError } from "../lib/reminder-text.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?contains=` exists for programmatic dedup (scripts/research-browser.mjs). The unfiltered
 * page is a UI listing: pending first, capped at 100, so the newest DELIVERED row is the
 * first casualty of truncation — which is exactly the row a dedup check needs (R705). The
 * filtered branch answers from the whole table, newest first.
 *
 * `filter` is echoed on BOTH branches on purpose: it is how a client can tell a server that
 * understands `contains` from an older one that ignored the parameter and handed back an
 * unfiltered page. Without the echo, "ignored my filter" and "no matches" look identical.
 */
r.get("/", async (c) => {
  // THIRD BRANCH — the ruled retention view (phase 6, R79/R80/R82). It is keyed
  // on an EXPLICIT `?view=` and nothing else: absent or unknown parameters must
  // reach the two branches below byte-identically, because the dedup client and
  // every existing caller read them.
  //
  // `view` is also the version handshake for this branch, the same trick `filter`
  // plays for `?contains=`: a forge-control too old to know `?view=` answers the
  // UNFILTERED page — 100 rows, oldest first — with no `view` key. Without the
  // echo, "your server predates the retention fix" and "you have 100 reminders
  // and no history" are the same response, and the client would render the wrong
  // one confidently. app/api-reminders.ts hard-errors on the missing key.
  const view = c.req.query("view");
  if (view !== undefined) {
    if (view !== "window") {
      return c.json(
        {
          error: `unknown view "${view}" — the only view is "window" (pending + the last N days of delivered, older counted into history). Omit ?view= for the unfiltered listing.`,
        },
        400,
      );
    }
    const rawDays = c.req.query("days");
    // No silent default and no clamp (N1): a caller that sends days=0, days=-1
    // or days=abc gets its own value back in a 400. Only an ABSENT days falls to
    // the ruled default, and the response echoes window_days so the surface can
    // label the number with its unit rather than showing a bare count.
    let windowDays = REMINDER_VIEW_DEFAULT_DAYS;
    if (rawDays !== undefined) {
      const parsed = Number(rawDays);
      if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > REMINDER_VIEW_MAX_DAYS ||
        rawDays.trim() === ""
      ) {
        return c.json(
          {
            error: `days must be a whole number of days between 1 and ${REMINDER_VIEW_MAX_DAYS}, got "${rawDays}"`,
          },
          400,
        );
      }
      windowDays = parsed;
    }
    const page = await listRemindersForView({ windowDays });
    return c.json({
      count: page.reminders.length,
      reminders: page.reminders,
      filter: null,
      view: {
        mode: "window",
        window_days: page.window_days,
        history_count: page.history_count,
        groups: page.groups,
        counts: page.counts,
      },
    });
  }

  const contains = (c.req.query("contains") ?? "").trim();
  if (contains === "") {
    if (c.req.query("contains") !== undefined) {
      return c.json({ error: "contains must not be empty — omit it to list all reminders" }, 400);
    }
    const items = await listReminders();
    return c.json({ count: items.length, reminders: items, filter: null });
  }
  const items = await findRemindersByText({ contains, limit: REMINDER_MATCH_LIMIT });
  return c.json({
    count: items.length,
    reminders: items,
    filter: {
      contains,
      limit: REMINDER_MATCH_LIMIT,
      order: "created_at DESC",
      // Newest-first means a truncated page still carries the newest match, so a recency
      // question is answerable; an "all of them" question is not. Say which one this is.
      truncated: items.length === REMINDER_MATCH_LIMIT,
    },
  });
});

r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    text?: string;
    when?: string;
    source?: string;
  };
  const when = (body.when ?? "").trim();
  if (!when) return c.json({ error: "when required" }, 400);
  const parsed = parseWhen(when);
  if (!parsed) {
    return c.json(
      {
        error: `could not parse when: "${when}" — try "in 2h", "tomorrow 9:00", "18:30", "daily 08:30", or "2026-07-04 14:00"`,
      },
      400,
    );
  }
  // Text can live in `text` or trail the when-expression ("in 2h call mom").
  const text = [(body.text ?? "").trim(), parsed.rest].filter(Boolean).join(" ").trim();
  if (!text) return c.json({ error: "reminder text required" }, 400);
  try {
    const reminder = await createReminder({
      text,
      dueAt: parsed.dueAt,
      recur: parsed.recur,
      source: body.source ?? "chat",
    });
    return c.json({ ok: true, reminder }, 201);
  } catch (e) {
    // Over-length text used to be truncated silently behind a 201. It is a
    // client error now, with the numbers the caller needs to split on.
    if (e instanceof ReminderTextTooLongError) {
      return c.json({ error: e.message, length: e.length, max: e.max }, 400);
    }
    throw e;
  }
});

r.post("/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid reminder id" }, 400);
  const ok = await dismissReminder(id);
  if (!ok) return c.json({ error: "reminder not found" }, 404);
  return c.json({ ok: true });
});

export default r;
