-- 0050 — a board task can name the life goal it serves.
--
-- The week board can say what happened; it cannot yet say whether any of it
-- MATTERED. `life_goals` has carried 11 rows since 0042 and nothing on the
-- board has ever pointed at one, so "did this week move anything that matters"
-- had no query behind it. This column is that query's join.
--
-- NULLABLE, and it stays nullable. Most work is not in service of a stated
-- goal, and a required link would either be lied to or left empty — the same
-- failure mode as the commit gate the week board deleted. The read side offers
-- `suggested_goal_id` (exactly one in_progress goal in the task's area) as a
-- chip; nothing is ever linked by a background write.
--
-- ON DELETE SET NULL, not CASCADE: abandoning a goal must not delete the work
-- that was done towards it. The tasks survive, unattributed, which is the true
-- statement.
--
-- The index is partial for the same reason 0047's is: today every row is NULL
-- and the overwhelming majority always will be. It serves the drawer's
-- per-goal counts (tasks_open / tasks_done_30d / minutes_30d / last_moved_at in
-- db/daily.ts) and the goals_week rollup in /api/daily/stats.
--
-- Re-runnable: both statements are IF NOT EXISTS. `ADD COLUMN IF NOT EXISTS`
-- skips the whole clause when the column is present, so the foreign key is not
-- added twice on a second run.
--
-- NOT YET APPLIED to content_forge — the deploy phase owns that
-- (docs/tools/deploy-playbook.md §6 step 4). Until it runs, every read and
-- write of `goal_id` fails: GET/POST/PATCH /api/daily/tasks, GET
-- /api/daily/goals and GET /api/daily/stats (goals_week) all reference the
-- column and will answer 500 "column goal_id does not exist".
--
-- Proven re-runnable 2026-08-25 on a per-run scratch database
-- (`daily_api_probe_6a8b826f1ba8`, schema-only pg_dump of content_forge, 0042
-- through 0050 applied twice with ON_ERROR_STOP=1). The second pass printed
--
--   psql:0050_day_tasks_goal.sql:46: NOTICE:  column "goal_id" of relation
--     "day_tasks" already exists, skipping
--   psql:0050_day_tasks_goal.sql:49: NOTICE:  relation "day_tasks_goal_id_idx"
--     already exists, skipping
--
-- and exited 0, leaving exactly one `goal_id` column, one foreign key
-- (`day_tasks_goal_id_fkey`, confdeltype 'n' = SET NULL) and one index.

ALTER TABLE day_tasks
  ADD COLUMN IF NOT EXISTS goal_id uuid NULL REFERENCES life_goals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS day_tasks_goal_id_idx ON day_tasks(goal_id)
  WHERE goal_id IS NOT NULL;
