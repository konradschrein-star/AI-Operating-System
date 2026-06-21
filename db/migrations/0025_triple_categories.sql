-- v1.7 phase 2 — ontology categories on knowledge_triples.
--
-- The v1.6 phase 5 extractor emitted free-form (subject, predicate, object)
-- triples with no schema. That's fine for "what entities co-occur in this
-- chunk" but it can't answer "filter to just standing rules" or "give me
-- only the decisions Konrad made about TTS providers". This phase adds a
-- tight 8-value ontology over triples so the search route can filter, and
-- the memory surface (phase 4) can colour-code by category.
--
-- Categories — chosen to map onto Konrad's Content Forge + AI OS domain:
--   decision  — a discrete choice Konrad made ("X over Y because Z")
--   rule      — a standing preference / policy ("never do X")
--   error     — a known failure mode / circuit / bug
--   provider  — an external service / API / pool (AI33, ElevenLabs, etc.)
--   job       — a content_jobs row or pipeline state
--   format    — a content format (CASUALLY_EXPLAINED, SPACE_VIDEO, etc.)
--   person    — Konrad, collaborators, fleet workers, anyone
--   other     — fallback when the LLM can't classify confidently
--
-- The set is closed: the extractor validates against this list and falls
-- back to 'other' for anything off-list.

ALTER TABLE knowledge_triples
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other'
    CHECK (category IN (
      'decision','rule','error','provider','job','format','person','other'
    ));

CREATE INDEX IF NOT EXISTS knowledge_triples_category_idx
  ON knowledge_triples (category);
