-- 0047: guardrail_rule_changes — the audit log for the guardrails themselves.
--
-- Round-0 finding P1-1 of aios-guardrail-hardening: `POST /api/autonomy/rules/:id`
-- and `POST /api/autonomy/trips/:id/resolve` are unauthenticated on localhost,
-- wrote no audit row and sent no notification. An agent could switch
-- `fs.destructive` off — or poison its config so it silently stopped enforcing
-- while the console still showed it ON — and the only trace was a changed
-- `updated_at`. The ACK path next to it was made deliberately loud; this table
-- and the notification the routes queue alongside it close the quiet door.
--
-- One row per WRITE to a guardrail. Reads are not audited: reading the rules is
-- the ordinary path, and auditing it would bury the writes.
--
-- Conventions follow 0021_ai_os_tables.sql: uuid pk, IF NOT EXISTS, no tenancy
-- column, no soft delete (an audit log is append-only — nothing in the codebase
-- issues an UPDATE or DELETE against it).

CREATE TABLE IF NOT EXISTS guardrail_rule_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The rule that was patched. NULL for a trip resolve, which names a trip
  -- instead. Intentionally NOT a foreign key to guardrail_rules: the log must
  -- outlive a rule row that gets deleted (spend.per_run_cap was deleted on
  -- 2026-08-25) — an audit entry that vanishes with its subject is not an audit.
  rule_id      varchar(64),
  -- The trip that was resolved. NULL for a rule update. Same reasoning: no FK.
  trip_id      uuid,
  kind         text NOT NULL
                 CHECK (kind IN ('rule.update','trip.resolve')),
  -- What was asked for: the request body for a rule patch, {} for a resolve.
  patch        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which surface made the change: console | api | deploy. Taken from the
  -- `x-forge-source` request header when it names one of those, otherwise
  -- 'api'. Deliberately NOT a CHECK constraint: a source the code has not been
  -- taught yet must land in the log as data, never bounce the write and lose
  -- the record of a change that has already happened.
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The only access pattern: newest first (GET /api/autonomy ships the last 20).
CREATE INDEX IF NOT EXISTS guardrail_rule_changes_created_idx
  ON guardrail_rule_changes (created_at DESC);
