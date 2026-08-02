-- 0001_claude_accounts.sql
--
-- TARGET DATABASE: ai_os  (host postgres, 127.0.0.1:5434)  -- NOT content_forge
-- Apply with:
--   sudo -u postgres psql -p 5434 -d ai_os -f db/migrations-ai-os/0001_claude_accounts.sql
--
-- First table of the AI OS / Content Forge database split. It is deliberately
-- new and self-contained so it can prove the second connection, the migration
-- pattern and the deploy path before anything with real data moves.
-- See docs/superpowers/specs/2026-08-02-claude-account-health-failover-design.md §4.1

CREATE TABLE IF NOT EXISTS claude_accounts (
  -- Names the IDENTITY, not the directory. The old slugs ('root',
  -- 'claude-worker') described filesystem paths, which is exactly why nobody
  -- noticed when the identity inside /root/.claude was replaced.
  slug            TEXT PRIMARY KEY,

  -- Set as CLAUDE_CONFIG_DIR on the spawned CLI. One directory = one identity.
  -- Never a secret; no credential material is stored in this database.
  config_dir      TEXT NOT NULL UNIQUE,

  login_email     TEXT,
  plan_label      TEXT,

  priority        INTEGER NOT NULL DEFAULT 100,   -- lower wins
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,

  -- healthy | broken | unknown.  'unknown' is never treated as healthy.
  health          TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (health IN ('healthy', 'broken', 'unknown')),
  health_detail   TEXT,

  -- Presence of a refresh token: the real liveness bit. The access token's
  -- own expiry is ~8h by design and carries no health information, so it is
  -- recorded for display only and never drives `health`.
  has_refresh     BOOLEAN,
  access_expires_at TIMESTAMPTZ,

  last_probed_at  TIMESTAMPTZ,
  last_ok_at      TIMESTAMPTZ,      -- last CONFIRMED successful run
  last_error      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claude_accounts_selection_idx
  ON claude_accounts (enabled, health, priority);

COMMENT ON TABLE claude_accounts IS
  'Claude CLI accounts available to the AI OS executor. Health-failover only: '
  'a BROKEN account is skipped, a RATE-LIMITED one is not. Holds no secrets.';

-- Seed: reality as of 2026-08-02, not aspiration.
--
-- Only the live account is enabled. Konrad explicitly chose to run a single
-- account for now, so failover has nowhere to go — the monitoring half is what
-- earns its keep. The dead directory is recorded as disabled rather than
-- omitted, so the settings page tells the truth about what is on the box.
INSERT INTO claude_accounts
  (slug, config_dir, login_email, plan_label, priority, enabled, health, health_detail)
VALUES
  ('arved', '/root/.claude', 'media.asphaltaction@gmail.com', 'max', 10, TRUE,
   'unknown', 'seeded — awaiting first probe'),
  ('claude-worker-legacy', '/home/claude-worker/.claude', NULL, 'max_5x', 90, FALSE,
   'broken', 'token expired 2026-06-03; unused since. Not re-authenticated by choice.')
ON CONFLICT (slug) DO NOTHING;
