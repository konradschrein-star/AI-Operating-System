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
-- NOT YET APPLIED TO content_forge. A round-4 review checked the live
-- database and found no `journal_entries` there, correctly failing an earlier
-- version of this header that claimed otherwise; the claim was false and has
-- been removed rather than softened. Applying a pending migration to the live
-- database is the DEPLOY phase's job (docs/tools/deploy-playbook.md §6 step 4,
-- "apply any pending migrations added by the project ... before restarting
-- either process") and a build task has no business writing to it, so the
-- proof below was taken on a throwaway database instead.
--
-- Re-runnability, actually measured 2026-08-23 on a per-run scratch database
-- (`journal_mig_probe_$$`, created and dropped by the same shell), NOT on
-- content_forge:
--
--   psql -d "$SCRATCH" -v ON_ERROR_STOP=1 -f db/migrations/0043_journal_entries.sql
--     apply 1 → CREATE TABLE / CREATE INDEX
--     apply 2 → NOTICE: relation "journal_entries" already exists, skipping
--               NOTICE: relation "journal_entries_day_idx" already exists, skipping
--               CREATE TABLE / CREATE INDEX, exit 0
--
-- Until deploy runs it, GET /api/journal/day, POST /api/journal/upload and
-- DELETE /api/journal/entries/:id all fail against a missing relation. That is
-- the expected pre-deploy state, not a defect in the routes.
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
