-- Execution-layer redesign, Step 4 (rework-2026-08-04/01-execution-layer.md, E3).
--
-- promoteReadyTasks() requires every earlier-round task to be 'done', so a
-- single 'failed' task freezes a project forever. There was no retry endpoint,
-- no reset endpoint and no UI control that moves a task out of failed/blocked:
-- recovery meant hand-written SQL. canvas-ux and live-agent-panel have been
-- wedged that way since 2026-07-30.
--
-- `attempt` is what keeps the new retry path from becoming an infinite loop:
-- two automatic retries, then the task stays blocked until Konrad forces it.
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
