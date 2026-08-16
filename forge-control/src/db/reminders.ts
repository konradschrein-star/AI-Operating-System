/**
 * Reminders data access. Schema: db/migrations/0027_reminders.sql.
 *
 * Lifecycle: pending → delivered (mirrored into inbox_items by the
 * executor's reminderTick) or dismissed. Recurring reminders stay
 * 'pending' and advance due_at on delivery.
 */

import pg from "pg";
import { nextRecurrence } from "../lib/when-parser.ts";
import { assertReminderTextFits } from "../lib/reminder-text.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[reminders pool]", e.message));

export interface Reminder {
  id: string;
  text: string;
  due_at: string;
  recur: "daily" | "weekly" | null;
  status: "pending" | "delivered" | "dismissed";
  source: string;
  created_at: string;
  delivered_at: string | null;
}

const COLS = `id::text, text, due_at::text, recur, status, source,
              created_at::text, delivered_at::text`;

export async function createReminder(input: {
  text: string;
  dueAt: Date;
  recur?: "daily" | "weekly" | null;
  source?: string;
}): Promise<Reminder> {
  // Throws rather than truncating: a reminder that arrives cut off mid-word
  // still looks armed. See lib/reminder-text.ts for the round-604 incident.
  assertReminderTextFits(input.text);
  const r = await pool.query<Reminder>(
    `INSERT INTO reminders (text, due_at, recur, source)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLS}`,
    [
      input.text,
      input.dueAt.toISOString(),
      input.recur ?? null,
      input.source ?? "chat",
    ],
  );
  return r.rows[0];
}

export async function listReminders(limit = 100): Promise<Reminder[]> {
  const r = await pool.query<Reminder>(
    `SELECT ${COLS} FROM reminders
      WHERE status != 'dismissed'
      ORDER BY (status = 'pending') DESC, due_at ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/** Ceiling for a marker-scoped lookup. See findRemindersByText for why it is safe. */
export const REMINDER_MATCH_LIMIT = 50;

/**
 * Reminders whose text CONTAINS `contains`, newest first.
 *
 * Deliberately not listReminders() with a client-side filter, and the R705 review is the
 * reason. A caller that dedups by scanning listReminders(100) is 16 rows from failing open:
 * that page is ordered pending-first then due_at ASC, so the newest *delivered* reminder is
 * the LAST row returned and the first one truncated. Once 100 non-dismissed reminders exist
 * — measured at 84 on 2026-08-05, with nothing pruning delivered rows — the page stops
 * containing the very reminder the caller is searching for, every caller concludes "no
 * duplicate", and the dedup becomes a reminder storm.
 *
 * ORDER BY created_at DESC is the load-bearing part: truncation then drops the OLDEST match,
 * never the newest, so a "was one queued recently?" question is answered correctly even if
 * the limit clips the result. `position()` is a literal substring test — no LIKE wildcards to
 * escape, so a marker containing % or _ cannot widen the match.
 */
export async function findRemindersByText(opts: {
  contains: string;
  limit?: number;
}): Promise<Reminder[]> {
  if (opts.contains === "") {
    throw new Error("findRemindersByText: `contains` must not be empty — that would match every reminder");
  }
  const r = await pool.query<Reminder>(
    `SELECT ${COLS} FROM reminders
      WHERE status != 'dismissed'
        AND position($1 in text) > 0
      ORDER BY created_at DESC
      LIMIT $2`,
    [opts.contains, opts.limit ?? REMINDER_MATCH_LIMIT],
  );
  return r.rows;
}

export async function dismissReminder(id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE reminders SET status = 'dismissed', updated_at = now()
      WHERE id = $1 AND status != 'dismissed'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Claim due pending reminders (FOR UPDATE SKIP LOCKED — safe if two
 *  executor instances ever run). Advances recurring rows; one-shots flip
 *  to 'delivered'. Returns the claimed rows as they were when due. */
export async function claimDueReminders(): Promise<Reminder[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<Reminder>(
      `SELECT ${COLS} FROM reminders
        WHERE status = 'pending' AND due_at <= now()
        ORDER BY due_at ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED`,
    );
    for (const rem of due.rows) {
      if (rem.recur) {
        const next = nextRecurrence(new Date(rem.due_at), rem.recur);
        await client.query(
          `UPDATE reminders
              SET due_at = $2, delivered_at = now(), updated_at = now()
            WHERE id = $1`,
          [rem.id, next.toISOString()],
        );
      } else {
        await client.query(
          `UPDATE reminders
              SET status = 'delivered', delivered_at = now(), updated_at = now()
            WHERE id = $1`,
          [rem.id],
        );
      }
    }
    await client.query("COMMIT");
    return due.rows;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
