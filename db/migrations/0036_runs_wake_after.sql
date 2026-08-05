-- Execution-layer redesign, Step 2 (rework-2026-08-04/01-execution-layer.md, E10).
--
-- The session guard in executor.ts re-queues a run when another `claude`
-- process already owns its session. Re-queued means immediately re-claimable,
-- so run ece63bdb (Konrad's 6h17m CRM run, 2026-08-04) was claimed 1,219 times
-- and refused 1,202 times — status flipping between queued and running roughly
-- every 18 seconds for six hours. The Live panel showed noise and the stuck
-- watchdog was defeated.
--
-- wake_after is the missing piece: a queued run is invisible to the claim
-- query until its wake time passes. Cleared on claim, so it only ever delays
-- the retry it was set for.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS wake_after timestamptz;

-- Partial index matching claimNextRun's predicate: queued rows ordered by
-- created_at, filtered on wake_after.
CREATE INDEX IF NOT EXISTS runs_queued_wake_idx
  ON runs (wake_after NULLS FIRST, created_at)
  WHERE status = 'queued';
