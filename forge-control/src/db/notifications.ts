/**
 * Outbound notification queue (schema: db/migrations/0028_telegram_coach.sql).
 *
 * Producers live in BOTH processes (forge-executor queues run-completion and
 * reminder pushes; forge-control queues cron errors), consumer is the
 * telegram bridge loop in forge-control. The table is the hand-off point so
 * the executor never needs the bot token.
 */

import pg from "pg";

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
pool.on("error", (e) => console.error("[notifications pool]", e.message));

export interface Notification {
  id: string;
  text: string;
  status: "pending" | "sent" | "failed";
  source: string;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

const MAX_ATTEMPTS = 5;

/** Queue a push. Never throws — a lost notification must not fail a run. */
export async function queueNotification(
  text: string,
  source = "system",
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  try {
    await pool.query(
      `INSERT INTO notifications (text, source) VALUES ($1, $2)`,
      [body.slice(0, 8000), source],
    );
  } catch (e) {
    console.error(
      "[notifications] queue failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Claim up to `limit` pending rows (FOR UPDATE SKIP LOCKED — bump attempts
 *  immediately so a crashed send doesn't retry forever). */
export async function claimPendingNotifications(
  limit = 10,
): Promise<Notification[]> {
  const r = await pool.query<Notification>(
    `WITH due AS (
       SELECT id FROM notifications
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE notifications n
        SET attempts = attempts + 1,
            status = CASE WHEN n.attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END
       FROM due
      WHERE n.id = due.id
     RETURNING n.id::text, n.text, n.status, n.source, n.attempts,
               n.created_at::text, n.sent_at::text`,
    [limit, MAX_ATTEMPTS],
  );
  return r.rows;
}

export async function markNotificationSent(id: string): Promise<void> {
  await pool.query(
    `UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1`,
    [id],
  );
}

/* --- Telegram inbound cursor -------------------------------------------- */

export async function getTgOffset(): Promise<number> {
  const r = await pool.query<{ last_update_id: string }>(
    `SELECT last_update_id::text FROM tg_state WHERE id = 1`,
  );
  return Number(r.rows[0]?.last_update_id ?? 0);
}

export async function saveTgOffset(updateId: number): Promise<void> {
  await pool.query(
    `UPDATE tg_state SET last_update_id = $1, updated_at = now()
      WHERE id = 1 AND last_update_id < $1`,
    [updateId],
  );
}
