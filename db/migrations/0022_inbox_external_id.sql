-- 0022: External id on inbox_items so the manager loop can dedupe mirrors
-- of HCP agent_message rows into the human-facing inbox.

ALTER TABLE inbox_items
  ADD COLUMN IF NOT EXISTS external_id varchar(80);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_external_id_uniq
  ON inbox_items (external_id)
  WHERE external_id IS NOT NULL;
