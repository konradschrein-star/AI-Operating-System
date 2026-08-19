-- 0042_daily_goals.sql
--
-- GOALS/TASKS surface — daily goals, habits, task planner.
-- Spec: docs/spec-daily-goals.md §2. Replaces Konrad's dead Notion setup.
--
-- The spine is "said vs done": a morning COMMIT freezes the day's Big 3, and
-- nothing may rewrite that text afterwards. The freeze lives in the route
-- (409 on a draft edit once committed_at is set), not in a trigger, because the
-- same row must stay writable for status/abandon/reflection after the freeze.
--
-- Applied by hand, twice, to prove re-runnability:
--   psql "$DATABASE_URL" -f db/migrations/0042_daily_goals.sql
-- against content_forge (the database that owns `reminders`, `runs`,
-- `ui_dismissals`).
--
-- Every statement carries IF NOT EXISTS / ON CONFLICT DO NOTHING —
-- forge-control/src/lib/migrations.test.ts lints this file for it and there is
-- no migration ledger, so the statement itself is the only defence against a
-- second `psql -f`.

-- day_plans: one row per calendar day (Europe/Berlin, resolved by
-- forge-control/src/lib/day-score.ts — never by the database's clock, which
-- runs UTC and would flip the day at 01:00/02:00 local).
CREATE TABLE IF NOT EXISTS day_plans (
  day          date PRIMARY KEY,
  -- [{id, text, why, status:'open'|'done'|'abandoned', reason, done_at}]
  -- Max 3 entries, enforced in the route (routes/daily.ts) not the DB: the
  -- limit is a product rule about attention, and a CHECK on jsonb length would
  -- turn a fixable 400 into a 500.
  big3         jsonb NOT NULL DEFAULT '[]'::jsonb,
  intent       text,                 -- one line: what today is FOR
  committed_at timestamptz,          -- NULL = still an editable draft
  generated_by text,                 -- 'operator' | 'konrad'
  generated_at timestamptz,
  subjective   smallint,             -- 1..5, his night rating
  reflection   text,                 -- optional free line at night
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- habits: the definitions. Editable; seeded below from his Notion columns.
CREATE TABLE IF NOT EXISTS habits (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text UNIQUE NOT NULL,       -- stable slug, survives relabelling
  label      text NOT NULL,
  icon       text NOT NULL,              -- Material Symbols name
  grp        text NOT NULL,              -- 'morning'|'body'|'work'|'evening'
  polarity   text NOT NULL DEFAULT 'do', -- 'do' | 'avoid' ("No sweets")
  weight     smallint NOT NULL DEFAULT 1,
  sort       smallint NOT NULL DEFAULT 0,
  -- Deactivate, never DELETE: habit_logs cascade, and deleting a habit would
  -- silently rewrite every historical day score that counted it.
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- habit_logs: the ticks. An absent row means not done — there is no 'false'
-- state to distinguish "skipped" from "not yet", and inventing one would put a
-- 19-column checkbox wall back on his phone.
CREATE TABLE IF NOT EXISTS habit_logs (
  day      date NOT NULL,
  habit_id uuid NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  done     boolean NOT NULL DEFAULT true,
  ts       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, habit_id)
);

-- day_tasks: the task planner. Deliberately NOT the coding-project `tasks`
-- table (project_tasks / the runs engine) — different lifecycle, different
-- owner, and joining them would make a personal to-do list a dependency of the
-- multi-agent scheduler.
CREATE TABLE IF NOT EXISTS day_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  area        text,                        -- 'uni'|'business'|'health'|... free text
  importance  smallint NOT NULL DEFAULT 2, -- 3 critical / 2 high / 1 normal / 0 low
  status      text NOT NULL DEFAULT 'todo',-- todo|doing|done|parked
  planned_day date,                        -- the day it is scheduled ON
  due_day     date,                        -- the day it is due BY (optional)
  est_min     smallint,                    -- rough estimate, for load warning
  carried     smallint NOT NULL DEFAULT 0, -- times rolled to a new day; >=3 is stale
  notes       text,
  done_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Partial: the hot query is "what is open on day X", and finished work is the
-- overwhelming majority of the table over a year.
CREATE INDEX IF NOT EXISTS day_tasks_planned_idx ON day_tasks(planned_day)
  WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS day_tasks_status_idx ON day_tasks(status);
-- The stats window folds completions by day; done_at is what it folds on.
CREATE INDEX IF NOT EXISTS day_tasks_done_at_idx ON day_tasks(done_at)
  WHERE done_at IS NOT NULL;

-- Seed: his 18 Notion habit columns, grouped so a phone shows four short rows
-- instead of one 19-wide table. ON CONFLICT (key) DO NOTHING — re-running this
-- file must not resurrect a habit he deactivated, nor overwrite a relabelling.
INSERT INTO habits (key, label, icon, grp, polarity, weight, sort) VALUES
  ('wake_6',        'Woke up 6:00',         'alarm',                   'morning', 'do',    1, 10),
  -- weight 2: the four that actually move his year (spec §2).
  ('sleep_8h',      '8h sleep',             'bedtime',                 'morning', 'do',    2, 20),
  ('journaling',    'Journaling',           'edit_note',               'morning', 'do',    1, 30),
  ('meditation',    'Meditation 5 min',     'self_improvement',        'morning', 'do',    1, 40),
  ('breakfast',     'Healthy breakfast',    'egg_alt',                 'morning', 'do',    1, 50),
  ('supplements',   'Supplements',          'medication',              'morning', 'do',    1, 60),
  ('stretching',    'Stretching',           'accessibility_new',       'body',    'do',    1, 10),
  ('trained',       'Trained',              'fitness_center',          'body',    'do',    2, 20),
  ('clean_diet',    'Clean diet',           'restaurant',              'body',    'do',    1, 30),
  ('no_sweets',     'No sweets',            'no_food',                 'body',    'avoid', 1, 40),
  ('deep_work',     'Done enough work',     'bolt',                    'work',    'do',    2, 10),
  ('shipped',       'Shipped / uploaded',   'rocket_launch',           'work',    'do',    2, 20),
  ('chores',        'All chores done',      'checklist',               'work',    'do',    1, 30),
  ('screen_time',   'Screen time < 30 min', 'phone_iphone',            'work',    'avoid', 1, 40),
  ('read_20',       'Read 20 mins',         'menu_book',               'evening', 'do',    1, 10),
  ('face',          'Cleaned face',         'face_retouching_natural', 'evening', 'do',    1, 20),
  ('teeth',         'Brushed teeth',        'dentistry',               'evening', 'do',    1, 30),
  ('plan_tomorrow', 'Reviewed tomorrow''s plan', 'event_upcoming',     'evening', 'do',    1, 40)
ON CONFLICT (key) DO NOTHING;
