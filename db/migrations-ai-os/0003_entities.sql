-- 0003_entities.sql
--
-- TARGET DATABASE: ai_os  (host postgres, 127.0.0.1:5434)  -- NOT content_forge
-- Apply with:
--   sudo -u postgres psql -p 5434 -d ai_os -f db/migrations-ai-os/0003_entities.sql
--
-- THE IDENTITY REGISTRY — the third native system of the AI OS.
--
-- Money (ledger_entries), memory (the vault), and identity are the three
-- things the OS itself must own. See CRM Integration Plan (Twenty) §3–§4.
-- Everything else (Twenty, the scraper, Axtrelis workflows, ReelForge) is a
-- satellite that owns its own domain and exposes an API. The seam that turns
-- that from a pile of webhooks into an actual OS is the pair of tables in
-- this migration and 0004_events.sql: a canonical person/company row, plus a
-- side table of external ids so every satellite can point at the same soul.
--
-- The whole reason the CRM adoption is worth the trouble is captured in one
-- pattern: "the directory lead who later buys an Axtrelis site". Without a
-- canonical entity that person is two unrelated rows in two systems, and the
-- highest-value cross-sell signal in the whole operation is invisible. This
-- table is what stops that.
--
-- Design decisions worth not re-litigating later:
--
--  * kind is a small enum, not a free string. Person and company have
--    different downstream shapes (companies get pipelines, people get
--    contact channels) and letting a typo introduce a third kind would
--    silently split every aggregate.
--
--  * display_name is the ONLY name column here on purpose. Given/family
--    name, legal name, DBA, trading name and the rest are satellite
--    concerns — Twenty already models them, and duplicating them here
--    would create a second authoritative name that immediately drifts
--    from Twenty's. What the OS actually needs is one label to render in
--    a briefing.
--
--  * arm partitions the entity registry the same way ledger_entries is
--    partitioned. This is what makes a per-arm view of "who do we know"
--    possible without joining through activity. NOTE: this enum includes
--    'directory'; ledger_entries.arm does NOT (see 0002_ledger.sql:57).
--    That discrepancy is real and known — directory revenue is currently
--    booked to 'other' in the ledger while entities can already be tagged
--    'directory' natively. Do NOT alter ledger_entries here; that is a
--    ledger migration, not an entity migration, and touching two systems
--    of record in one change is how you invent bugs. Flagged for a
--    follow-up 0005_ledger_arm_directory.sql when directory revenue
--    starts landing.
--
--  * owner_id is TEXT and nullable. The multi-user posture is three tiers
--    (spec §6): Konrad now, partner read-only later, VAs never in the OS.
--    Nothing in the current codebase needs this column, but adding it to
--    a table with rows in it is a real migration and adding it to an
--    empty table is a NULL default. Cheap now, expensive later — put the
--    seam in on day one and leave it dormant. TEXT rather than UUID
--    because the eventual owner id may come from Twenty or an OIDC
--    provider, and pinning the type prematurely would force a rewrite.
--
--  * updated_at exists and is updated by application code (no trigger).
--    The rest of the ai_os schema follows the same pattern; adding a
--    trigger for one table would be a new convention.

CREATE TABLE IF NOT EXISTS entities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'person' or 'company'. See note above on why this stays small.
  kind           TEXT NOT NULL CHECK (kind IN ('person', 'company')),

  -- The one label a briefing or a UI list renders. Not authoritative for
  -- billing, legal or contact — those live in satellites.
  display_name   TEXT NOT NULL,

  -- Which arm of the operation this entity belongs to. Mirrors the
  -- partitioning used by ledger_entries.arm, plus 'directory' — see
  -- header note on the deliberate discrepancy.
  arm            TEXT NOT NULL CHECK (arm IN
                   ('directory', 'axtrelis', 'youtube', 'infra',
                    'personal', 'other')),

  -- Tenant/owner seam. Null while single-user (Konrad). Populated when
  -- partner read-only surfaces or a friends-of-Konrad multi-tenant build
  -- ship. See spec §6.
  owner_id       TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access pattern: "list entities in this arm, most recently touched first".
-- This is what the Today briefing and the CRM sidebar want. Composite on
-- (arm, updated_at DESC) so the arm filter uses the index and the sort is
-- served without a separate ORDER BY pass.
CREATE INDEX IF NOT EXISTS entities_arm_updated_idx
  ON entities (arm, updated_at DESC);

-- Fuzzy name search over display_name. Not a trigram index yet — that is
-- worth adding when the CRM starts landing real name variants, not before
-- there are rows to search. Plain btree on lower(display_name) is enough
-- for exact-prefix lookups the manual "find X" path uses today.
CREATE INDEX IF NOT EXISTS entities_display_name_lower_idx
  ON entities (lower(display_name));

COMMENT ON TABLE entities IS
  'Canonical person/company registry — the identity system-of-record for the '
  'AI OS. External ids live in entity_links. See CRM Integration Plan §4.';

CREATE TABLE IF NOT EXISTS entity_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cascade on delete: removing an entity removes its links. The opposite
  -- policy (RESTRICT) would leave dangling links pointing at a system that
  -- has already forgotten the counterpart, which is worse than losing the
  -- pointer.
  entity_id     UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

  -- Small enum. Adding a satellite is a migration on purpose: a new value
  -- means a new integration to keep working, not a passing string.
  system        TEXT NOT NULL CHECK (system IN
                  ('twenty', 'scraper', 'axtrelis', 'ledger')),

  -- Opaque id from that satellite. TEXT because different satellites use
  -- UUIDs, integers, slugs, or vendor-shaped composites; the OS only needs
  -- to round-trip them.
  external_id   TEXT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The uniqueness contract from spec §4.1: (system, external_id) is
  -- unique. This is what makes imports idempotent — running the scraper
  -- twice cannot double-link the same business, and Twenty webhooks
  -- arriving out of order cannot fork one identity into two. Every
  -- upsert path in the data-access layer relies on this constraint being
  -- present.
  UNIQUE (system, external_id)
);

-- Access pattern: "what does entity X look like in Twenty / in the ledger /
-- in the scraper?" — a per-entity fanout. Kept separate from the uniqueness
-- index above because that one is keyed on (system, external_id) and would
-- not serve this lookup efficiently.
CREATE INDEX IF NOT EXISTS entity_links_entity_id_idx
  ON entity_links (entity_id);

COMMENT ON TABLE entity_links IS
  'External-id mapping from an OS entity to every satellite that also knows '
  'it. UNIQUE(system, external_id) is what makes cross-system imports '
  'idempotent — spec §4.1.';
