-- Close (archive) chats without deleting them. Closing a non-terminal run
-- also cancels it (same effect as the existing cancel button) so the
-- underlying claude-code process stops within ~5s instead of continuing to
-- run/notify in the background. Archived runs stay in the DB and stay
-- searchable — just hidden from the default chat rail + excluded from
-- status counts.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_runs_archived_updated
  ON runs (archived, updated_at DESC);
