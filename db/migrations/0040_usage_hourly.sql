-- 0040_usage_hourly.sql
--
-- Round 1350 — the usage panel stops scanning `runs` at request time.
--
-- Until now every "how many tokens did we burn this week" question meant a
-- live fold over `runs.metadata` (JSONB, hundreds of rows, growing). That is
-- the same read-time-aggregation shape that made the Live panel bog the box
-- down, and it gets worse every day the fleet runs. This migration adds the
-- pre-aggregated hour table the series endpoints read INSTEAD of `runs`.
--
-- One row per CLOSED hour, written by lib/usage-sampler.ts. Cost comes from
-- `spend_log` (migration 0026), which the executor already writes one row per
-- finished run into — it is timestamped, it survives run archival, and it
-- needs no cursor bookkeeping. Tokens come from the run the spend row points
-- at (`meta->>'run_id'`).
--
-- ATTRIBUTION, stated once and carried into the API payload so the UI can
-- label it: a run's WHOLE usage lands in the hour it COMPLETED, because that
-- is when the spend_log row is written. A four-hour run shows up as one spike,
-- not a smear across four buckets. Smearing would need per-turn timestamps we
-- do not persist, and inventing them silently is worse than a labelled spike.
--
-- shadow_usd is USD on purpose. executor.ts converts USD→EUR with a hardcoded
-- CC_USD_EUR (default 0.86) when it writes spend_log.amount_eur; storing EUR
-- here too would freeze that rate into history and make the configurable
-- display rate a double conversion. We store the USD truth and convert at read
-- time with app_settings['usage.eur_per_usd'].
--
-- Applied by hand: psql "$DATABASE_URL" -f db/migrations/0040_usage_hourly.sql
-- against content_forge (the database that owns runs + spend_log).

CREATE TABLE IF NOT EXISTS usage_hourly (
  bucket_start timestamptz PRIMARY KEY,        -- inclusive start of the hour, UTC
  tokens_in    bigint         NOT NULL DEFAULT 0,
  tokens_out   bigint         NOT NULL DEFAULT 0,
  cache_read   bigint         NOT NULL DEFAULT 0,
  cache_write  bigint         NOT NULL DEFAULT 0,
  shadow_usd   numeric(12, 4) NOT NULL DEFAULT 0,  -- USD, never EUR — see header
  run_count    int            NOT NULL DEFAULT 0,  -- finished runs billed into this hour
  sampled_at   timestamptz    NOT NULL DEFAULT now(),
  meta         jsonb          NOT NULL DEFAULT '{}'::jsonb
);

-- Every read is "the last N buckets, newest first". DESC matches the scan.
CREATE INDEX IF NOT EXISTS usage_hourly_bucket_start_desc_idx
  ON usage_hourly (bucket_start DESC);

-- Small key/value store for settings that must outlive a process restart and
-- be editable without a deploy. First tenant: 'usage.eur_per_usd', the
-- EUR-per-USD rate the usage panel converts shadow_usd with.
--
-- Deliberately NOT seeded here. The default lives in exactly one place —
-- DEFAULT_EUR_PER_USD in forge-control/src/lib/usage-sampler.ts — so a row in
-- this table always means "a human overrode the default", and GET
-- /api/usage/rate can say which of the two it is served from. A seed row would
-- be a second copy of the default, free to drift from the first.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
