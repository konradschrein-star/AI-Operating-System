-- Execution-layer redesign, Step 1 (rework-2026-08-04/01-execution-layer.md, E2).
--
-- POST /api/projects/:id/tasks had no idempotency key and no unique
-- constraint. On 2026-07-30 the canvas-ux architect ran its fan-out curls
-- twice; four duplicate tasks were created 2s apart, then ran CONCURRENTLY in
-- the same shared worktree and reverted each other's edits. The duplicate
-- reviewers then each spawned a fix cycle, doubling the damage.
--
-- (project_id, round, role, title) is the natural key of a fan-out task: an
-- architect re-issuing the same curl means the same task, not a second one.
--
-- Historic duplicates are RENAMED, never deleted — the runs they produced are
-- still referenced from project_tasks.run_id and are part of the audit trail.
-- Only the non-earliest row of each duplicate group gets the suffix.
UPDATE project_tasks pt
   SET title = pt.title || ' [dup ' || left(pt.id::text, 8) || ']'
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY project_id, round, role, title
             ORDER BY created_at, id
           ) AS rn
      FROM project_tasks
  ) d
 WHERE d.id = pt.id
   AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS project_tasks_identity_idx
  ON project_tasks (project_id, round, role, title);
