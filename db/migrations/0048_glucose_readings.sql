-- 0048 — blood glucose readings from FreeStyle Libre via LibreLinkUp.
--
-- Konrad already built the connector
-- (github.com/konradschrein-star/freestyle-libre-live-bloodshugar-connector);
-- this is where its readings land so the week board can draw them under the
-- calendar. The question he wants answered is specific: "see the post-lunch
-- crash against the hours I was unproductive."
--
-- `taken_at` is the primary key rather than a serial id, because LibreLinkUp's
-- graph endpoint returns a ROLLING ~12h window on every poll — the same reading
-- comes back dozens of times. Keying on the instant makes re-ingesting the whole
-- window an idempotent upsert instead of eighty duplicate rows every 5 minutes.
--
-- Both units are stored. The sensor reports mg/dL, Konrad's own connector shows
-- mmol/L (the German default), and deriving one from the other at read time is
-- how a chart ends up off by a factor of 18.

CREATE TABLE IF NOT EXISTS glucose_readings (
  taken_at     timestamptz PRIMARY KEY,
  value_mgdl   real        NOT NULL,
  value_mmol   real        NOT NULL,
  -- 1 green / 2 yellow(high) / 3 orange(low) / 4 red(critical), as LibreLinkUp
  -- reports it. Stored rather than recomputed so the chart can colour exactly
  -- the way his sensor app does.
  measurement_color smallint,
  is_high      boolean     NOT NULL DEFAULT false,
  is_low       boolean     NOT NULL DEFAULT false,
  -- 1..5 falling-quickly..rising-quickly, 0 = not determined. Only present on a
  -- live reading; historical graph points carry no trend.
  trend_id     smallint,
  source       text        NOT NULL DEFAULT 'librelinkup',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The week board asks for one window at a time, always ordered by time.
CREATE INDEX IF NOT EXISTS glucose_readings_taken_at_idx
  ON glucose_readings (taken_at DESC);
