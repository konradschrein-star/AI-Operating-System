/**
 * Reminders data access. Schema: db/migrations/0027_reminders.sql.
 *
 * Lifecycle: pending → delivered (mirrored into inbox_items by the
 * executor's reminderTick) or dismissed. Recurring reminders stay
 * 'pending' and advance due_at on delivery.
 */

import pg from "pg";
import { nextRecurrence } from "../lib/when-parser.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

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
  const r = await pool.query<Reminder>(
    `INSERT INTO reminders (text, due_at, recur, source)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLS}`,
    [
      input.text.slice(0, 500),
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
