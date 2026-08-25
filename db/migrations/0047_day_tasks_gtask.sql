-- 0047 — bind a board task to a Google Tasks entry.
--
-- Companion to 0044's `gcal_event_id`. The two are deliberately separate columns
-- because they answer different questions and a task can only ever be in one of
-- them at a time:
--
--   start_time IS NOT NULL  → it has an hour → it belongs on Google CALENDAR
--   start_time IS NULL      → it has a day   → it belongs in Google TASKS
--
-- That split is forced by the API, not by taste: Google Tasks stores `due` at
-- DATE precision and silently discards the time of day, so a 14:00 dentist
-- appointment pushed to Tasks would come back as "sometime Thursday".
--
-- `gtask_updated` caches Google's own last-modified stamp for the entry as we
-- last saw it. Without it a two-way sync cannot tell "he edited this on his
-- phone" from "we wrote this ourselves thirty seconds ago", and the two sides
-- ping-pong an edit back and forth forever.
--
-- Re-runnable: every statement is IF NOT EXISTS.

ALTER TABLE day_tasks ADD COLUMN IF NOT EXISTS gtask_id text;
ALTER TABLE day_tasks ADD COLUMN IF NOT EXISTS gtask_updated timestamptz;

-- Partial, like the gcal index: the overwhelming majority of rows are NULL here
-- and have no business in the index.
CREATE UNIQUE INDEX IF NOT EXISTS day_tasks_gtask_id_idx ON day_tasks(gtask_id)
  WHERE gtask_id IS NOT NULL;
