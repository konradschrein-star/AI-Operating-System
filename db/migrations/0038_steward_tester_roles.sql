-- Org extension (Konrad, 2026-08-05 late morning): 'steward' = big-picture
-- guardian (Wirtschaftsingenieur — checks the work still serves the goal and
-- makes business sense at phase boundaries); 'tester' = customer-perspective
-- QA (uses the product like a user, distinct from the code reviewer).
ALTER TABLE project_tasks DROP CONSTRAINT project_tasks_role_check;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_role_check
  CHECK (role IN ('architect','planner','scout','researcher','builder','reviewer','steward','tester'));
