-- v2.2 — Telegram bridge + coach feedback loop.
--
-- notifications: outbound push queue. Producers: forge-executor (run
-- completions, reminders), forge-control (cron failures). Single consumer:
-- the telegram bridge loop inside forge-control. Decouples the two
-- processes without HTTP calls between them.
--
-- tg_state: single-row cursor so the bridge survives restarts without
-- re-processing (or dropping) inbound Telegram updates.
--
-- coach_metrics: the accountability loop. The evening coach run reports
-- how many of the morning's committed tasks got done; Today surface and
-- future coach runs read the streak back.

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text        text NOT NULL,
  status      varchar(16) NOT NULL DEFAULT 'pending', -- pending|sent|failed
  source      varchar(64) NOT NULL DEFAULT 'system',
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS tg_state (
  id              integer PRIMARY KEY CHECK (id = 1),
  last_update_id  bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tg_state (id, last_update_id) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS coach_metrics (
  day         date PRIMARY KEY,
  committed   integer NOT NULL DEFAULT 0,
  completed   integer NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Cron schedules can now attach metadata to the runs they create
-- (e.g. {"model": "haiku"} for the hourly watchdog so it doesn't burn
-- sonnet money 24x a day, or {"notify": "always"}).
ALTER TABLE cron_schedules
  ADD COLUMN IF NOT EXISTS run_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
