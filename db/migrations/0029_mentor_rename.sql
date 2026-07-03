-- 0029_mentor_rename.sql
--
-- v2.3 — Konrad renamed the coach to "mentor". The table follows so the
-- schema reads the way the product speaks. IF EXISTS keeps the migration
-- re-runnable and harmless on a fresh install where 0028 + 0029 run in
-- sequence.

ALTER TABLE IF EXISTS coach_metrics RENAME TO mentor_metrics;
ALTER INDEX IF EXISTS coach_metrics_pkey RENAME TO mentor_metrics_pkey;
