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
-- label it: a run's WHOLE token usage lands in the hour of its LAST BILLED
-- TURN, and cost lands per turn in the turn's own hour.
--
-- This paragraph said "the hour it COMPLETED, because that is when the
-- spend_log row is written" until round 1354. Both halves were wrong. The
-- executor writes a spend row per INVOCATION and a chat run is re-entered for
-- every turn, so a run carries many rows across many hours — 14 live run ids
-- carried more than one, one carried 123 across 15 hours. Tokens are stored
-- CUMULATIVELY per run (metadata.usage_total_running), so folding "every run
-- billed in this hour" counted the same total once per hour touched: 4.9%
-- phantom tokens over 24h, unbounded as a chat grows. The sampler now keeps a
-- run only in the hour of its most recent claude-code spend row.
--
-- A four-hour run is therefore one token spike at its end plus four small cost
-- bars. Smearing tokens would need per-turn token deltas we do not persist,
-- and inventing them silently is worse than a labelled spike.
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
  run_count    int            NOT NULL DEFAULT 0,  -- BILLED TURNS, not runs — see below
  sampled_at   timestamptz    NOT NULL DEFAULT now(),
  meta         jsonb          NOT NULL DEFAULT '{}'::jsonb
);

-- run_count: this column said "finished runs billed into this hour" until
-- round 1356, and the panel printed it as "runs". It is COUNT(*) over the
-- hour's claude-code spend rows, and spend_log gets one row per TURN — so a
-- four-turn chat contributes four. Live, over 24h: 217 by this count where
-- there were 101 distinct runs. Renaming the column would break every reader
-- for a word; the honest label ships instead, in the panel and in the
-- sampler's log line. The distinct-run count is written to meta.distinct_runs
-- per bucket, and deliberately NOT summed into the day/week rollups: a run
-- spanning three hours is distinct in each, so summing would claim three.
--
-- meta.folded_runs (round 1356): the run ids whose CUMULATIVE token totals
-- were folded into this bucket. It is what lets the sampler find a bucket
-- whose fold has since moved to a later hour and re-sample it, instead of
-- freezing the double count in place — see repairDisplacedBuckets in
-- forge-control/src/lib/usage-sampler.ts. Rows written before that round have
-- no such key; the sampler re-samples them once on boot to give them one.

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
