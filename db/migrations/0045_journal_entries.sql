-- 0045_journal_entries.sql
--
-- RENUMBERED 0043 → 0045 on 2026-08-23 (round 7). It was written as `0043`, and
-- so were three other migrations, each in a different lane's worktree and each
-- invisible to the others: `0043_gemini_tier.sql` (landed on main at 86d8794),
-- `0043_goals_and_calendar.sql` and `0043_task_graph.sql`. Git does not conflict
-- on this — the filenames differ — so `git merge-tree --write-tree main HEAD`
-- was the only cheap way to see it, and main's own gate
-- (`scripts/checks/check-migration-numbers.ts`, added at 246528b, after this
-- lane branched) reports `COLLISION 0043` against that merged file set.
--
-- Moved with `git mv`; the digest is unchanged by the move —
-- `sha256sum` before and after both read
-- 47b32b9c88d70fbe69d1da222f798a7dc655703ebfbe8cf87ba57b5633586715, so the
-- committed digest differs from that only because of this header edit, made in
-- the same commit.
--
-- Why 0045 and not 0044: `project/2bbf2879` (aios-goals-day-system) already
-- committed `0044_goals_and_calendar.sql` at 70cfa21, so 0044 is taken.
-- 0045 was free on main, in every sibling worktree and in the live checkout,
-- checked 2026-08-23T16:50Z. `engine-task-graph` still holds a `0043` and needs
-- 0046 or later.
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
-- ── LIVE STATE: A MEASUREMENT, NOT A STANDING FACT ───────────────────────────
--
-- Do not trust this paragraph. It records one reading of a database that other
-- processes change; it is true as of the timestamp on it and of nothing else.
-- DEPLOY MUST RE-MEASURE rather than read this sentence — the check is
-- read-only and takes a second:
--
--   docker exec content-forge-postgres psql -U postgres -d content_forge \
--     -tAc "SELECT to_regclass('public.journal_entries')"
--
-- Measured 2026-08-23T16:50:12Z from this worktree with exactly that command
-- (plus `(SELECT count(*) FROM journal_entries)`), output verbatim:
--
--   journal_entries|0
--
-- So at that instant the relation DID exist in content_forge, empty, with the
-- 14 columns and the `journal_entries_day_idx` index this file creates
-- (`information_schema.columns` and `pg_indexes`, same session). This lane did
-- NOT apply it: a build task may not write to the live database, and an earlier
-- reading taken during round 4 found no such relation. It was applied out of
-- band by something else between those two readings — round 6's review dates
-- the relation file at 2026-08-23T16:40:00Z — and this header makes no claim
-- about what did it.
--
-- CONSEQUENCE FOR DEPLOY: none, beyond re-measuring. Every statement here is
-- IF NOT EXISTS, so re-running the file against a database that already has
-- the table is a no-op that exits 0 with `NOTICE: … already exists, skipping`.
-- Applying it remains the DEPLOY phase's job either way
-- (docs/tools/deploy-playbook.md §6 step 4, "apply any pending migrations added
-- by the project ... before restarting either process"); the proof below was
-- taken on a throwaway database, never on content_forge.
--
-- Earlier history, kept because it is the reason this header is worded this
-- way: an earlier version claimed the file had been "applied by hand, twice …
-- against content_forge". That claim was false when written — a round-4 review
-- checked and found nothing there. It was removed rather than softened, and its
-- replacement ("NOT YET APPLIED") then went stale within minutes, which is why
-- what stands now is a stamped reading with an instruction to re-measure.
--
-- Re-runnability, re-measured 2026-08-23T16:51:47Z AFTER the renumber and this
-- header rewrite (a re-run is what proves the file still parses), on a per-run
-- scratch database (`journal_mig_probe_$$`, created and dropped by the same
-- shell), NOT on content_forge:
--
--   psql -U postgres -d "$SCRATCH" -v ON_ERROR_STOP=1 \
--     -f db/migrations/0045_journal_entries.sql
--     apply 1 → CREATE TABLE / CREATE INDEX, exit 0
--     apply 2 → CREATE TABLE
--               NOTICE: relation "journal_entries" already exists, skipping
--               NOTICE: relation "journal_entries_day_idx" already exists, skipping
--               CREATE INDEX, exit 0
--   information_schema.columns on the scratch DB → 14 columns
--
-- GET /api/journal/day, POST /api/journal/upload and DELETE
-- /api/journal/entries/:id need this relation. Against a database that does not
-- have it they fail with a missing-relation error — an expected pre-deploy
-- state, not a defect in the routes. Whether that is the state you are in is
-- the `to_regclass` question above; answer it, do not infer it from here.
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
