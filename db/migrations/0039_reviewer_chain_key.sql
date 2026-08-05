-- Reviewer-round consolidation (engine-v2, 2026-08-05): deterministic
-- idempotency key for the fix chains the reconciler creates. One NEEDS_FIXES
-- round must yield exactly ONE fix builder + ONE re-reviewer, and a tick that
-- crashes between the two INSERTs must be able to replay without duplicating
-- either — so both rows carry a chain_key ('fix:<round>:<cycle>' /
-- 'rereview:<round>:<cycle>') that is unique per project.
--
-- NULL for every historical row: the first goal-mode night produced real
-- duplicate fix/deploy tasks, and a partial index that skips NULLs lets those
-- rows stand untouched instead of blocking the migration. Only the reconciler
-- ever writes chain_key — the task-creation API route does not expose it, so
-- agents cannot forge one.
--
-- Purely additive: the currently-running (old) engine never writes this column,
-- so the migration is safe to apply while the fleet is live.
-- Re-runnable, like 14 of the 19 migrations beside it: there is no ledger
-- table and no runner, so re-application is a manual `psql -f` and must be a
-- no-op rather than an error.
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS chain_key text;
CREATE UNIQUE INDEX IF NOT EXISTS project_tasks_chain_key_uniq
  ON project_tasks (project_id, chain_key) WHERE chain_key IS NOT NULL;
