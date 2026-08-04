-- 0004_events.sql
--
-- TARGET DATABASE: ai_os  (host postgres, 127.0.0.1:5434)  -- NOT content_forge
-- Apply with:
--   sudo -u postgres psql -p 5434 -d ai_os -f db/migrations-ai-os/0004_events.sql
--
-- THE EVENT SPINE — one append-only row per meaningful thing any module did.
--
-- Paired with 0003_entities.sql; the two are the seam between the OS and its
-- satellites. entities answers "who?", events answers "what happened to them,
-- when, in which system?". Together they let the OS narrate ("what happened
-- with this company?") and let the weekly briefing read from one place
-- instead of federating four APIs on demand. See CRM Integration Plan §4.2.
--
-- Design decisions worth not re-litigating later:
--
--  * Append-only. There is no update path in the data-access layer for a
--    reason: the log is more useful when it cannot be rewritten. A wrong
--    row is corrected by a new row, not by mutating history — same
--    discipline as a real ledger.
--
--  * occurred_at is TIMESTAMPTZ, not DATE. Opposite call from
--    ledger_entries.occurred_on, and deliberate. Events are moments in
--    time (a webhook fired, a stage advanced, an email was sent); cash
--    reconciles by day but activity does not. Two events on the same day
--    have a real order that matters when reconstructing a story.
--
--  * system is a free TEXT, not an enum. entity_links.system is an enum
--    because a new satellite there means a new integration to keep
--    working. events.system is descriptive — a new emitter is not a
--    breaking change, and forcing a migration every time the scraper
--    grows a sub-module would be exactly the incentive that gets logging
--    quietly dropped instead.
--
--  * verb is TEXT, not an enum, for the same reason as ledger.category
--    (see 0002_ledger.sql:60). Convention over enforcement: dot-namespaced
--    strings like 'twenty.stage.advanced', 'scraper.business.imported',
--    'ledger.entry.recorded', 'axtrelis.brief.sent'. If the convention
--    slips the aggregate is noisy, not wrong; if this were an enum the
--    aggregate would be silently missing rows because someone bypassed
--    validation.
--
--  * entity_id is NULLABLE and ON DELETE SET NULL. Some events are about
--    entities (a company advanced a stage), some are not (a nightly cron
--    ran). Deleting an entity must not erase the record that it once
--    existed and did things — the audit is still worth having. SET NULL
--    keeps the row; CASCADE would silently reduce history.
--
--  * subject is a short human string. This is what a briefing renders
--    inline without joining anywhere else. Duplicative with payload on
--    purpose: an events table where you must parse JSON to know what
--    happened is one nobody actually reads.
--
--  * payload is JSONB with a '{}' default. Structure varies wildly per
--    emitter; forcing a schema now would either be underspecified for
--    everyone or forbid new use cases tomorrow. Queries that need to
--    aggregate go through the events data-access module, which is where
--    the shape gets pinned per verb.

CREATE TABLE IF NOT EXISTS events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- When it actually happened, from the emitter's clock. Defaults to now()
  -- for the common case where the emitter is the OS itself; overridden
  -- when replaying or importing historical data so the timeline stays true.
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who emitted this. See note above on why this is not an enum.
  system         TEXT NOT NULL,

  -- What happened, dot-namespaced by convention. See note above.
  verb           TEXT NOT NULL,

  -- Optional link back to the identity registry. SET NULL on delete so a
  -- purged entity does not erase its history.
  entity_id     UUID REFERENCES entities(id) ON DELETE SET NULL,

  -- One-line human summary. Rendered directly in briefings.
  subject       TEXT,

  -- Structured detail. Emitters are free to shape this per verb; readers
  -- pin the shape in the data-access layer.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Access pattern 1: "recent activity across the whole OS", newest first.
-- The Today briefing and the /live feed both scan this.
CREATE INDEX IF NOT EXISTS events_occurred_at_desc_idx
  ON events (occurred_at DESC);

-- Access pattern 2: "what happened to this company / this person?" — the
-- per-entity timeline. Composite with occurred_at DESC so the entity filter
-- uses the index and the sort is served without an extra pass. Partial on
-- (entity_id IS NOT NULL) because unlinked events (cron ticks, health
-- pings) would only bloat the index without ever matching this query.
CREATE INDEX IF NOT EXISTS events_entity_occurred_idx
  ON events (entity_id, occurred_at DESC)
  WHERE entity_id IS NOT NULL;

-- Access pattern 3: "everything the scraper did today" — narrow filters
-- for debugging and per-satellite dashboards. Cheap composite index; both
-- columns are low-cardinality relative to the timestamp so this stays
-- small.
CREATE INDEX IF NOT EXISTS events_system_verb_idx
  ON events (system, verb, occurred_at DESC);

COMMENT ON TABLE events IS
  'Append-only spine of meaningful actions across the OS and its satellites. '
  'Paired with entities: subject + payload describe what happened, entity_id '
  'links it to who. See CRM Integration Plan §4.2.';
