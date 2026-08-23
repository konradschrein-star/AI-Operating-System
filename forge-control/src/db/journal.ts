/**
 * JOURNAL surface data access. Schema: db/migrations/0045_journal_entries.sql
 * (written as 0043; renumbered in round 7 because main and two sibling lanes
 * each held a different 0043 — see that file's own header).
 *
 * A module-local pg.Pool on DATABASE_URL (content_forge), matching db/daily.ts
 * and db/ai_os.ts — `journal_entries` lives in the same database as
 * `decisions` and `day_plans`, not the separate ai_os (:5434) instance.
 *
 * `day` is a `date` column; node-pg hands DATE OIDs back as a JS Date built at
 * LOCAL midnight, which on this UTC box would serialise the wrong calendar day
 * (see db/daily.ts's own note on this). Cast every `day` to `::text` so the
 * wire always carries the exact "YYYY-MM-DD" that was stored.
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[journal pool]", e.message));

export type JournalEntryType = "paper_photo" | string;
export type OcrStatus = "unavailable" | "pending" | "done" | "failed" | string;

export interface JournalEntry {
  id: string;
  day: string;
  type: JournalEntryType;
  upload_id: string | null;
  file_path: string | null;
  file_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  ocr_text: string | null;
  ocr_status: OcrStatus;
  caption: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = `
  id, day::text AS day, type, upload_id, file_path, file_url, file_name,
  mime_type, size_bytes, ocr_text, ocr_status, caption,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

/** All entries for one calendar day (Europe/Berlin), oldest first — the order
 *  a timeline reads top to bottom as the day happened. */
export async function listJournalEntries(day: string): Promise<JournalEntry[]> {
  const r = await pool.query<JournalEntry>(
    `SELECT ${COLS} FROM journal_entries WHERE day = $1::date ORDER BY created_at ASC`,
    [day],
  );
  return r.rows;
}

export interface CreateJournalEntryInput {
  day: string;
  type?: JournalEntryType;
  upload_id?: string | null;
  file_path?: string | null;
  file_url?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  ocr_text?: string | null;
  ocr_status?: OcrStatus;
  caption?: string | null;
}

export async function createJournalEntry(
  input: CreateJournalEntryInput,
): Promise<JournalEntry> {
  const r = await pool.query<JournalEntry>(
    `INSERT INTO journal_entries
       (day, type, upload_id, file_path, file_url, file_name, mime_type,
        size_bytes, ocr_text, ocr_status, caption)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLS}`,
    [
      input.day,
      input.type ?? "paper_photo",
      input.upload_id ?? null,
      input.file_path ?? null,
      input.file_url ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      input.size_bytes ?? null,
      input.ocr_text ?? null,
      input.ocr_status ?? "unavailable",
      input.caption ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error("createJournalEntry: INSERT ... RETURNING produced no row");
  }
  return row;
}

/** Deletes the row and returns it, or null if no entry had that id. Does NOT
 *  touch the file on disk under /opt/ai-os/uploads/ — that storage is shared
 *  with chat attachments (routes/uploads.ts) and other entries may still
 *  reference the same upload id; deleting it here would be a second place
 *  that decides an upload is unreferenced, and the two would drift. */
export async function deleteJournalEntry(id: string): Promise<JournalEntry | null> {
  const r = await pool.query<JournalEntry>(
    `DELETE FROM journal_entries WHERE id = $1 RETURNING ${COLS}`,
    [id],
  );
  return r.rows[0] ?? null;
}
