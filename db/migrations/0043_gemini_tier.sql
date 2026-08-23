-- 'gemini' joins the tier ladder (Konrad, 2026-08-23 overnight AI-OS build).
--
-- The tier was added to TypeScript on 2026-08-22 in three places —
-- db/projects.ts's TaskTier union, routes/projects.ts's TIERS set, and
-- project-tick.ts's TIER_MODELS (gemini-3.7-flash-high, routed to agy by
-- lib/gemini-runner.ts) — but the CHECK constraint was never widened to match.
--
-- The failure mode that cost the time: POST /api/projects with
-- architect_tier "gemini" is ACCEPTED by the route's validation, seeds the
-- round-0 architect row, and then dies at the INSERT with a bare
-- "Internal Server Error" on the wire. Nothing in the response names the tier
-- or the constraint; only the pm2 error log does. So the tier reads as
-- "implemented and broken" rather than "never migrated".
--
-- Widening a CHECK is additive: no existing row can violate the larger set.
ALTER TABLE project_tasks DROP CONSTRAINT project_tasks_tier_check;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_tier_check
  CHECK (tier IS NULL OR tier IN ('fast', 'junior', 'standard', 'flagship', 'gemini'));
