-- v1.6 tier-2 phase 4 — Webhooks + Cron schedules.
--
-- Two new surfaces inspired by NousResearch/hermes-agent's WebhooksPage /
-- CronPage / ScheduleBuilder pages. Both fire a new `runs` row when their
-- trigger fires, using a stored prompt_template with simple
-- `{{ body.field }}` interpolation against an event payload.
--
-- webhooks       — inbound HTTP triggers (Stripe / GitHub / Telegram / IFTTT
--                  / Zapier callbacks). External services POST to
--                  /webhooks/in/<slug>; the receiver validates an
--                  HMAC-SHA256 signature against `secret`, then spawns a run.
-- cron_schedules — time-driven triggers. The forge-control process ticks
--                  every ~15s, finds rows where next_run_at <= now() and
--                  fires them. `next_run_at` is recomputed on each fire.
--
-- Both link to their last-spawned run via last_run_id for the UI surface.

CREATE TABLE IF NOT EXISTS webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  name            text NOT NULL,
  description     text,
  -- HMAC-SHA256 key. Caller signs request body with this, signs hex digest
  -- goes in `X-Forge-Signature: sha256=<hex>`. Random 256-bit on create.
  secret          text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  -- prompt to fire with. Supports {{ body.* }} placeholders that get replaced
  -- with the JSON payload of the inbound request.
  prompt_template text NOT NULL,
  -- title template for the spawned run; defaults to "webhook: <name>".
  title_template  text,
  -- optional run.worker label so spawned runs are tagged for filtering.
  worker_label    varchar(64),
  -- usage stats.
  total_calls     int  NOT NULL DEFAULT 0,
  last_called_at  timestamptz,
  last_run_id     uuid REFERENCES runs(id) ON DELETE SET NULL,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhooks_enabled_idx
  ON webhooks (enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS cron_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  description     text,
  -- 5-field cron: minute hour day-of-month month day-of-week.
  -- Parsed in TS by lib/cron-parser.ts; storage layer is opaque.
  cron_expr       varchar(64) NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  prompt_template text NOT NULL,
  title_template  text,
  worker_label    varchar(64),
  -- when the scheduler tick should next fire this row.
  next_run_at     timestamptz NOT NULL,
  last_run_at     timestamptz,
  last_run_id     uuid REFERENCES runs(id) ON DELETE SET NULL,
  last_error      text,
  total_fires     int  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cron_schedules_next_run_idx
  ON cron_schedules (next_run_at) WHERE enabled;
