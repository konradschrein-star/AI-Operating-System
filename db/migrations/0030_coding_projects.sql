-- 0030: Coding projects — multi-agent dev work on top of the existing runs
-- engine, per the "manage more coding agents at once" design (2026-07-08).
--
-- A project is a git worktree (against ai-os or content-forge) plus a
-- brief. Work happens in rounds: all tasks in round N must be 'done' before
-- any task in round N+1 becomes eligible. Round 0 is always a single
-- architect task; the architect run itself creates round 1+ tasks via
-- POST /api/projects/:id/tasks as part of its job (it has curl access).
--
-- Each task, when eligible, becomes exactly one `runs` row (metadata
-- .project_id/.task_id/.role) — reusing the existing executor/cc-runner/
-- guardrails/spend/SSE machinery as-is. project_tasks.run_id points at the
-- most recent run; task status mirrors that run's outcome once it settles.
--
-- Concurrency across all projects is capped by the existing
-- guardrail_rules['agent.spawn_cap'] row (config.max, currently 8) — no new
-- cap introduced here.

CREATE TABLE IF NOT EXISTS projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  brief         text NOT NULL,
  repo          varchar(32) NOT NULL CHECK (repo IN ('ai-os','content-forge')),
  workspace_dir text,
  base_branch   text NOT NULL DEFAULT 'main',
  work_branch   text,
  status        varchar(16) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','done','blocked','cancelled')),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round        int  NOT NULL DEFAULT 0,
  role         varchar(16) NOT NULL
                 CHECK (role IN ('architect','planner','scout','builder','reviewer')),
  title        text NOT NULL,
  brief        text NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','ready','running','done','failed','blocked')),
  run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
  fix_cycle    int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_tasks_project_idx
  ON project_tasks (project_id, round, status);
CREATE INDEX IF NOT EXISTS project_tasks_pending_idx
  ON project_tasks (project_id) WHERE status IN ('pending','ready');
CREATE INDEX IF NOT EXISTS project_tasks_run_idx
  ON project_tasks (run_id) WHERE run_id IS NOT NULL;
