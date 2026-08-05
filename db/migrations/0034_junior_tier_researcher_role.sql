-- Model re-tiering (Konrad, 2026-08-05 morning): 'junior' tier = Sonnet for
-- tests/boilerplate/repetitive work; 'standard' moves up to Opus 5. Also
-- pre-authorize the 'researcher' role for the deep-research lane (browser
-- steering, Perplexity, Gemini video QA) being built by the fleet.
ALTER TABLE project_tasks DROP CONSTRAINT project_tasks_tier_check;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_tier_check
  CHECK (tier IS NULL OR tier IN ('fast', 'junior', 'standard', 'flagship'));
ALTER TABLE project_tasks DROP CONSTRAINT project_tasks_role_check;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_role_check
  CHECK (role IN ('architect', 'planner', 'scout', 'researcher', 'builder', 'reviewer'));
