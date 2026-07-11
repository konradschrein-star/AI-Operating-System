-- Model/effort tiering for architect + builder tasks (2026-07-11 design:
-- docs/superpowers/specs/2026-07-11-manager-orchestration-model-tiering-design.md).
-- NULL means "use the role file's static model:/effort: default" — most
-- tasks are untiered; only architect and builder are ever assigned one.
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS tier varchar(16)
    CHECK (tier IS NULL OR tier IN ('fast','standard','flagship'));
