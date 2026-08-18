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
import {
  foldReminders,
  type FoldedReminder,
  type ReminderRepeatGroup,
  type ReminderRetentionCounts,
} from "../lib/reminder-retention.ts";

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

/**
 * The windowed view — phase 6's ruled retention (R79/R80/R82), served ALONGSIDE
 * listReminders() rather than replacing it.
 *
 * WHY A SECOND FUNCTION AND NOT A CHANGE TO THE FIRST. listReminders()'s exact
 * SQL text is asserted by lib/reminder-dedup.test.ts (R705): its pending-first,
 * due_at ASC ordering is what a dedup caller was proven to depend on. So the
 * retention fix ADDS a path. Callers of the old one see byte-identical behaviour.
 *
 * WHY NO LIMIT. The old page silently truncates at 100 — measured on 2026-08-18
 * at 156 non-dismissed rows, of which 100 returned and 56 vanished with no flag,
 * and all 56 dropped rows were from that day (phase6/reminders-triage.md P3).
 * A silent truncation plus a windowed view would mean the history count itself
 * was wrong, which is the one number this phase promises. So every row is read —
 * dismissed ones included, see below — and the split is computed in
 * lib/reminder-retention.ts, where it is unit-testable; the surface receives
 * counts, never a truncated page.
 *
 * The ceiling below is a runaway guard, not a page size. At 180 rows and the
 * worst observed arrival day of 67, it is years away — and it THROWS with both
 * numbers rather than returning a short list, because a wrong history count looks
 * exactly like a right one.
 *
 * Reads nothing outside `reminders` and writes nothing at all: retention is
 * hide / group / collapse / count. No row is removed by this path, ever.
 */
export const REMINDER_VIEW_ROW_CEILING = 20_000;

export interface ReminderViewPage {
  reminders: FoldedReminder<Reminder>[];
  groups: ReminderRepeatGroup[];
  history_count: number;
  window_days: number;
  counts: ReminderRetentionCounts;
}

export async function listRemindersForView(opts: {
  windowDays: number;
  /** Injectable clock. Defaults to the real one here — this is the layer that is
   *  allowed to know the time; lib/reminder-retention.ts is not. */
  now?: Date;
  /** Escalation option 4 (collapse repeated texts). Konrad did not pick it, so
   *  the shipped route leaves it off. See reminders-policy-escalation.md §3.2. */
  groupRepeats?: boolean;
}): Promise<ReminderViewPage> {
  // NO `WHERE status != 'dismissed'` HERE, deliberately. The exclusion happens in
  // foldReminders, which then reports `counts.dismissed` as a real number and
  // `counts.input` as the whole table — so the view's own arithmetic is a
  // running proof that no row was removed: `counts.input` must equal
  // `SELECT count(*) FROM reminders`, which is the query phase 6's reviewer runs
  // itself. Filtering here would have made `counts.dismissed` a permanent 0 that
  // looks like "nothing has ever been dismissed".
  const r = await pool.query<Reminder>(
    `SELECT ${COLS} FROM reminders
      ORDER BY (status = 'pending') DESC, due_at DESC`,
  );
  if (r.rows.length > REMINDER_VIEW_ROW_CEILING) {
    throw new Error(
      `listRemindersForView: ${r.rows.length} reminders exceeds the ` +
        `${REMINDER_VIEW_ROW_CEILING}-row ceiling. Nothing has been deleted and nothing will be; ` +
        `the fix is to move the window split into SQL (a count(*) for the history total plus a ` +
        `windowed SELECT) rather than to cap this list, because a capped list makes history_count ` +
        `wrong while looking right.`,
    );
  }
  const view = foldReminders(r.rows, {
    windowDays: opts.windowDays,
    now: opts.now ?? new Date(),
    groupRepeats: opts.groupRepeats ?? false,
  });
  // `visible` → `reminders`, because every other reminders payload calls the
  // array `reminders` and a second name for the same thing on one endpoint is
  // how a client ends up reading the wrong key and rendering an empty list.
  return {
    reminders: view.visible,
    groups: view.groups,
    history_count: view.history_count,
    window_days: view.window_days,
    counts: view.counts,
  };
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
