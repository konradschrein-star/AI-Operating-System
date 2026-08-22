-- 0043_journal_entries.sql
--
-- JOURNAL surface — paper-first capture. Konrad journals on paper; this table
-- records photographs of pages (and any other future entry types) so they can
-- be listed on a per-day timeline alongside the vault's daily notes and the
-- decisions log. See docs/plan (aios-journal-and-mentor) and Konrad's own
-- words, tonight: "I reckon for now we will do it with paper where we can
-- then upload images here."
--
-- Deliberately in content_forge (this DB), matching `decisions`, `day_plans`
-- and every other AI-OS table added since 0021 — NOT a new database, NOT the
-- separate ai_os (:5434) instance.
--
-- Files are NOT re-stored here: `file_path`/`file_url` point into the SAME
-- /opt/ai-os/uploads/<id>/<name> tree and the SAME GET /api/uploads/:id/:name
-- serving route that chat attachments already use (routes/uploads.ts). This
-- table is the index over that storage, dated and typed, not a second copy of
-- it.
--
-- OCR: there is no local OCR engine on this box today (no tesseract, no OCR
-- library in package.json — checked before writing this). `ocr_text` and
-- `ocr_status` exist so a future pass can fill them in without a migration;
-- `ocr_status` defaults to 'unavailable' rather than 'pending' so a reader
-- never mistakes an entry for one queued behind a pipeline that does not
-- exist yet.
--
-- Applied by hand, twice, to prove re-runnability:
--   psql "$DATABASE_URL" -f db/migrations/0043_journal_entries.sql
-- against content_forge.
--
-- Every statement carries IF NOT EXISTS — forge-control/src/lib/migrations.test.ts
-- lints this file for it and there is no migration ledger, so the statement
-- itself is the only defence against a second `psql -f`.

CREATE TABLE IF NOT EXISTS journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The day this entry belongs ON (Europe/Berlin calendar day — resolved by
  -- lib/day-score.ts's berlinDay(), never the database's UTC clock), not the
  -- instant it was uploaded. Lets a page photographed after midnight still
  -- land on the day it was written.
  day         date NOT NULL,
  -- 'paper_photo' today; free text so a future entry type (e.g. a typed note,
  -- or video journaling per the brief's "leave room for later") needs no
  -- migration to add.
  type        text NOT NULL DEFAULT 'paper_photo',
  -- The /opt/ai-os/uploads/<upload_id>/ directory this entry's file lives in
  -- — the same id scheme routes/uploads.ts issues (12 hex chars).
  upload_id   text,
  file_path   text,
  file_url    text,
  file_name   text,
  mime_type   text,
  size_bytes  bigint,
  ocr_text    text,
  ocr_status  text NOT NULL DEFAULT 'unavailable',
  caption     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The timeline's hot query is "everything for day X".
CREATE INDEX IF NOT EXISTS journal_entries_day_idx ON journal_entries(day);
