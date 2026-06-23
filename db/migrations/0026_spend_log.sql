-- 0026_spend_log.sql
--
-- v1.9 — honest cost tracking.
--
-- The Today screen reported €0 hardcoded; the spend.daily_cap guardrail never
-- fired because nothing populated `payload.daily_spend_eur`. This migration
-- adds the missing log + the supporting indexes for cheap aggregation.
--
-- Gateways (fastgen, tts, claude-pool, forge-api, AI33-direct callers, etc.)
-- POST one row per billable upstream call via /api/spend. The Today route
-- sums today's rows; the guardrail evaluator consumes the same sum.

CREATE TABLE IF NOT EXISTS spend_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  provider    text NOT NULL,                -- 'ai33', 'elevenlabs', 'claude-pool', 'fastgen', 'forge-api', 'minimax', 'gemini-pool', etc.
  kind        text NOT NULL,                -- 'image', 'tts', 'llm_input', 'llm_output', 'video', 'music', 'embedding'
  amount_eur  numeric(10, 4) NOT NULL,      -- 4 decimal places — fractions of a cent matter at high volume
  job_id      uuid,                          -- optional content_jobs reference, nullable
  units       integer,                       -- optional unit count (tokens, seconds, images)
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (amount_eur >= 0)
);

-- Aggregations sweep by created_at; covering index keeps daily rollups
-- cheap even at 50k+ rows/day.
CREATE INDEX IF NOT EXISTS spend_log_created_at_idx
  ON spend_log (created_at DESC);

-- Per-provider breakdown ("AI33 cost today") benefits from a composite.
CREATE INDEX IF NOT EXISTS spend_log_provider_created_idx
  ON spend_log (provider, created_at DESC);
