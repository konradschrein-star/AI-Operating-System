-- 0021: Personal AI OS tables (forge-control + forge-control-web)
--
-- Backs the Personal AI OS Console described in CLAUDE-DESIGN-BRIEF.md.
-- See design/Forge Mobile.dc.html for the UI surfaces these tables support.
--
-- Conventions
--   • Single-user system: no tenancy column.
--   • Use uuid pks except fleet_state (singleton) and string-id config tables.
--   • Soft-delete only where the UI offers an undo flow (inbox_items.resolved_at).

-- ---------------------------------------------------------------------------
-- fleet_state — singleton row tracking whether agents may dispatch work.
-- The mobile Control screen's FREEZE ALL button writes here; Hermes
-- supervisor polls this on its loop and refuses new dispatch when paused.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fleet_state (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status       varchar(16) NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','paused')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   varchar(64) NOT NULL DEFAULT 'system'
);

INSERT INTO fleet_state (id, status, updated_by)
  VALUES (1, 'running', 'migration-0021')
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- inbox_items — questions, approvals, decisions that need the human.
-- Items reach here only after manager-first routing has exhausted itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbox_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 varchar(64) NOT NULL,
  status               varchar(32) NOT NULL
                         CHECK (status IN ('BLEED','STUCK','APPROVE','DECIDE','NORMAL')),
  title                text NOT NULL,
  ask                  text NOT NULL,
  tried                jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions              jsonb NOT NULL DEFAULT '[]'::jsonb,
  source               varchar(64) NOT NULL,
  related_job_id       uuid REFERENCES content_jobs(id) ON DELETE SET NULL,
  related_worker_id    varchar(64),
  escalation_count     int  NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz,
  resolved_by          varchar(64),
  resolution           jsonb
);

CREATE INDEX IF NOT EXISTS inbox_items_open_idx
  ON inbox_items (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS inbox_items_status_idx
  ON inbox_items (status) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS inbox_items_related_job_idx
  ON inbox_items (related_job_id) WHERE related_job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- decisions — append-only log of what the fleet and the human did.
-- Powers the Control screen's DECISION LOG and any future audit view.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts              timestamptz NOT NULL DEFAULT now(),
  kind            varchar(32) NOT NULL
                    CHECK (kind IN ('dispatch','breaker','degrade','escalate',
                                    'unstick','resolve','freeze','resume',
                                    'guardrail','manager','user')),
  actor           varchar(64) NOT NULL,
  action          text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  inbox_item_id   uuid REFERENCES inbox_items(id) ON DELETE SET NULL,
  related_job_id  uuid REFERENCES content_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS decisions_ts_idx ON decisions (ts DESC);
CREATE INDEX IF NOT EXISTS decisions_kind_idx ON decisions (kind, ts DESC);

-- ---------------------------------------------------------------------------
-- runs — long-running agent tasks (Tasks surface, brief §6.8).
-- The run executor in forge-control polls this table and drives Claude
-- worker sessions; the manager loop reads child runs to escalate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  prompt               text NOT NULL,
  worker               varchar(64),
  status               varchar(16) NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','paused','stuck',
                                           'completed','failed','cancelled')),
  thread               jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_usd           numeric(10,2) NOT NULL DEFAULT 0,
  spent_usd            numeric(10,2) NOT NULL DEFAULT 0,
  parent_run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
  stuck_signal         varchar(64),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  last_heartbeat_at    timestamptz
);

CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_parent_idx ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_worker_idx ON runs (worker) WHERE worker IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_stuck_idx ON runs (last_heartbeat_at) WHERE status IN ('running','stuck');

-- ---------------------------------------------------------------------------
-- guardrail_rules — toggleable no-go rulebook (Settings → Guardrails).
-- builtin rules come from migrations; custom rules are user-authored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guardrail_rules (
  id          varchar(64) PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL,
  category    varchar(32) NOT NULL
                CHECK (category IN ('financial','destructive','communication',
                                    'security','deployment','custom')),
  enabled     boolean NOT NULL DEFAULT true,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  builtin     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the built-in rules from CLAUDE-DESIGN-BRIEF.md §6.14.1
INSERT INTO guardrail_rules (id, label, description, category, enabled, config, builtin) VALUES
  ('spend.daily_cap',  'Daily spend cap',  'Refuse paid actions once daily LLM/API spend exceeds the cap.', 'financial', true, '{"cap_eur":50}'::jsonb, true),
  ('spend.per_run_cap','Per-run spend cap','Refuse paid actions on a single run beyond cap.',               'financial', true, '{"cap_eur":10}'::jsonb, true),
  ('fs.destructive',   'Destructive fs ops','Confirm before rm -rf, mass delete, table drops.',             'destructive', true, '{}'::jsonb, true),
  ('git.force_push',   'Force push protection','Block force-push to main, warn on other branches.',         'destructive', true, '{"protected_branches":["main","master","prod"]}'::jsonb, true),
  ('deploy.prod',      'Prod deploys',     'Confirm any deploy to production targets.',                     'deployment', true, '{}'::jsonb, true),
  ('secrets.read',     'Secrets read',     'Confirm reads of .env, keychain, encrypted_secrets.',           'security', true, '{}'::jsonb, true),
  ('comm.outbound',    'Outbound messaging','Confirm sending email, posting to Slack/social on my behalf.', 'communication', true, '{}'::jsonb, true),
  ('agent.spawn_cap',  'Worker spawn cap', 'Cap the number of concurrent Claude workers.',                  'security', true, '{"max":8}'::jsonb, true),
  ('runtime.pause_all','Emergency pause',  'When tripped, pauses every worker via fleet_state.',            'security', false, '{}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- guardrail_trips — append-only log of denied actions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guardrail_trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            varchar(64) NOT NULL REFERENCES guardrail_rules(id) ON DELETE CASCADE,
  agent              varchar(64) NOT NULL,
  attempted_action   text NOT NULL,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved           boolean NOT NULL DEFAULT false,
  resolution_note    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guardrail_trips_ts_idx ON guardrail_trips (created_at DESC);
CREATE INDEX IF NOT EXISTS guardrail_trips_rule_idx ON guardrail_trips (rule_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- connector_configs — external service shells (Settings → Connectors).
-- Non-secret config in `config`; the secret pointer lives in secret_ref
-- which references encrypted_secrets (existing table).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_configs (
  id            varchar(64) PRIMARY KEY,
  service       varchar(64) NOT NULL,
  display_name  text NOT NULL,
  status        varchar(16) NOT NULL DEFAULT 'disconnected'
                  CHECK (status IN ('disconnected','connected','error','syncing')),
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref    varchar(128),
  last_sync_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
