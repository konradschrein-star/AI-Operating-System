-- Goal mode: allow 'scratch' repos — a fresh standalone git repo per project
-- (for goals that don't live in ai-os or content-forge: new products,
-- business systems, the YouTube distribution engine, ...). Goal-mode flags
-- themselves live in projects.metadata (mode, checkin_hours,
-- last_checkin_at) — no new columns needed.
ALTER TABLE projects DROP CONSTRAINT projects_repo_check;
ALTER TABLE projects ADD CONSTRAINT projects_repo_check
  CHECK (repo IN ('ai-os', 'content-forge', 'scratch'));
