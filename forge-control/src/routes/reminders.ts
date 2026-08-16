/**
 * Reminders routes.
 *
 *   GET  /api/reminders              → open reminders (pending first)
 *   GET  /api/reminders?contains=X   → open reminders whose text contains X,
 *                                    NEWEST FIRST — the dedup lookup (R705)
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
  findRemindersByText,
  dismissReminder,
  REMINDER_MATCH_LIMIT,
} from "../db/reminders.ts";
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
