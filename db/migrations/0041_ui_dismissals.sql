-- 0041_ui_dismissals.sql
--
-- Round 1350, phase 6 — dismissals stop living in localStorage.
--
-- Konrad hides a settled agent or a finished team from the Live panel and
-- expects it to stay hidden across a reload, a second browser and a rebuild.
-- Until now the only store was `forge.teamDismissed` in localStorage
-- (forge-control-web/app/desktop/team/dismissals.ts, whose header explicitly
-- hands the server half to this round). This table is that server half.
--
-- WHY A TABLE AND NOT A COLUMN ON `runs`
--   1. Ownership. `runs` is written by the engine files this project may not
--      touch (project-tick.ts, cc-runner.ts, executor.ts, db/projects.ts).
--      A read-side UI preference has no business widening the engine's row.
--   2. Node ids are not all runs. The panel's tree keys sub-agent rows on the
--      spawn's `tool_use_id` — a string that lives inside `runs.thread` JSONB
--      and is not a row anywhere. A column on `runs` could not hold it; a
--      free-standing `node_id text` can.
--   3. Reversibility. A dismissal is a HIDE, never a delete. Nothing here
--      references `runs`, so restoring is one DELETE and the run row was never
--      touched in the first place. There is deliberately no FK: a dismissal
--      must survive the archival of the thing it hides, and must be creatable
--      for a sub-agent id that has no row to point at.
--
-- Single viewer (Konrad), so no user column. When forge-control grows a second
-- viewer this table gains `viewer text NOT NULL DEFAULT 'konrad'` and the
-- primary key becomes (viewer, node_id) — stated here so that migration is a
-- widening rather than a redesign.
--
-- Applied by hand: psql "$DATABASE_URL" -f db/migrations/0041_ui_dismissals.sql
-- against content_forge (the database that owns `runs`).
--
-- DEPLOY ORDER MATTERS: /api/agents and /api/chat/:id/team LEFT JOIN this
-- table. Apply this file BEFORE restarting forge-control with the round-1350
-- code, or every agents query fails with "relation ui_dismissals does not
-- exist".

CREATE TABLE IF NOT EXISTS ui_dismissals (
  -- A run uuid OR a sub-agent spawn tool_use_id. text, not uuid: see (2).
  node_id      text        PRIMARY KEY,
  -- 'run' | 'subagent' — what the id names, so a later reader can tell the
  -- two apart without re-deriving it from the id's shape.
  kind         text        NOT NULL DEFAULT 'run',
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

-- The panel's peek-back ("N hidden · show") lists most-recently-hidden first.
CREATE INDEX IF NOT EXISTS ui_dismissals_dismissed_at_desc_idx
  ON ui_dismissals (dismissed_at DESC);
