-- 0044_goals_and_calendar.sql
--
-- GOALS/TASKS surface extensions:
-- 1. Day tasks calendar time-blocking and Google Calendar linkage.
-- 2. Life goals (strategic horizon goals: quarterly, yearly, long-term).
-- 3. Seed life_goals with Konrad's 11 real strategic goals from Obsidian vault.
--
-- RENUMBERED 0043 -> 0044 by the operator, 2026-08-23. Three lanes each wrote a
-- file called 0043 in their own worktree, invisible to each other: gemini_tier
-- (already on main), goals_and_calendar (this one) and journal_entries. Git does
-- not conflict on that — the filenames differ, so all three would merge cleanly
-- and only collide inside a database. scripts/checks/check-migration-numbers.ts
-- now fails on it. Renaming is safe: this repo has no migration ledger, so the
-- number only orders a FRESH install, and every statement below is already
-- applied to content_forge under the old name.
--
-- APPLIED to content_forge 2026-08-23 by the operator (deploy step). Verified:
-- life_goals present with 11 rows, day_tasks carries start_time / duration_min /
-- gcal_event_id, and a second run is a clean no-op (INSERT 0 0 — the seed is
-- guarded by WHERE NOT EXISTS on title).
--
-- Applied with:
--   psql "$DATABASE_URL" -f db/migrations/0044_goals_and_calendar.sql
-- Every statement carries IF NOT EXISTS / idempotency guards.

-- 1. Extend day_tasks with scheduling and calendar linkage
ALTER TABLE day_tasks ADD COLUMN IF NOT EXISTS start_time timestamptz;
ALTER TABLE day_tasks ADD COLUMN IF NOT EXISTS duration_min smallint DEFAULT 30;
ALTER TABLE day_tasks ADD COLUMN IF NOT EXISTS gcal_event_id text;

CREATE INDEX IF NOT EXISTS day_tasks_gcal_event_id_idx ON day_tasks(gcal_event_id)
  WHERE gcal_event_id IS NOT NULL;

-- 2. Life goals table
CREATE TABLE IF NOT EXISTS life_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'planned',
  horizon      text NOT NULL DEFAULT 'quarterly',
  area         text,
  progress     smallint NOT NULL DEFAULT 0,
  started_day  date,
  target_day   date,
  completed_at timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS life_goals_status_idx ON life_goals(status);
CREATE INDEX IF NOT EXISTS life_goals_horizon_idx ON life_goals(horizon);

-- 3. Seed Konrad's 11 real strategic goals from Mentor/Profile/Goals & Aspirations.md
INSERT INTO life_goals (title, status, horizon, area, progress, notes)
SELECT v.title, v.status, v.horizon, v.area, v.progress, v.notes
FROM (VALUES
  ('Break the shipping drought: publish video output again', 'in_progress', 'quarterly', 'business', 10, 'Pipeline sat at zero across every phase; last publish was May 31. Committed to: queue 3+ ideas, ship 1 published video, and add an alert so it can''t silently zero again.'),
  ('Get the AI OS Console operational', 'in_progress', 'quarterly', 'tech', 25, 'A single pane of glass over Hermes + Content Forge + the side apps. Phase 1 backend (forge-control :7700) is live; frontend still TBD.'),
  ('Stabilise core infra', 'planned', 'quarterly', 'tech', 0, 'Worker-orchestrator and hub-web crash-loop; the VEO image/video farm is half-broken.'),
  ('Reach positive ROI on the YouTube venture within ~6 months', 'planned', 'yearly', 'business', 0, 'Deemed "pretty easy for an internet business." Currently –$300/week.'),
  ('Scale the VA operation from 5 toward 50', 'planned', 'yearly', 'business', 0, 'Funded through Shane, gated on a CMS deal ($6k + 15% rev share) and the render pipeline.'),
  ('Own search-based content real estate in German + Nordic markets', 'planned', 'yearly', 'business', 0, 'Before English competitors can hire translators — a 6–18 month window.'),
  ('Multi-language arbitrage', 'planned', 'yearly', 'business', 0, 'Replicate proven English formats into German, Nordic, French, Spanish via AI dubbing.'),
  ('Full-scale content studio', 'planned', 'long_term', 'business', 0, '12+ channels, multi-language ops, Tier 3/4 (~$28–32k/month burn at 50 VAs).'),
  ('Relocate to a low-tax jurisdiction (Cyprus)', 'planned', 'long_term', 'personal', 0, 'Budgeted ~$2,500/mo; revenue routed US LLCs → Cyprus LLC → Jersey. Living standards won''t be inflated to not loose focus.'),
  ('Build a durable AI co-founder', 'planned', 'long_term', 'tech', 0, 'An Obsidian-linked agent with business memory, without typical context-window-dementia.'),
  ('Financial independence via automated compounding systems', 'planned', 'long_term', 'financial', 0, 'Build machines that earn without linear labor, so he can operate from anywhere on his own terms.')
) AS v(title, status, horizon, area, progress, notes)
WHERE NOT EXISTS (SELECT 1 FROM life_goals WHERE life_goals.title = v.title);
