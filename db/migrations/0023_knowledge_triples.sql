-- v1.6 phase 5 — knowledge_triples table for 1-hop GraphRAG expansion.
--
-- Concept lifted from TrustGraph: enrich the existing vector search
-- (content_forge.knowledge_embeddings, halfvec(1024) + HNSW cosine) with
-- entity/relation triples extracted from notes by an LLM pass. Search
-- queries first hit vectors, then optionally expand 1-hop via shared
-- triples so "what did Konrad decide about TTS providers and how does
-- that connect to AI33 deprecation" returns chunks linked by entity
-- (TTS_PROVIDER) and predicate (deprecates / replaces).
--
-- No new infra: lives in the existing content_forge database next to
-- knowledge_embeddings so JOINs are cheap. TrustGraph's full stack
-- (Cassandra + Qdrant + Pulsar + Garage) is deferred to a future
-- Phase 5.1 sidecar deploy if this proves valuable (see
-- docs/ai-os-v16/repo-trustgraph.md "Mid tier").

CREATE TABLE IF NOT EXISTS knowledge_triples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Subject + predicate + object are kept as plain text + a normalised
  -- lowercase key for join/lookup. We don't bind to an ontology yet;
  -- the LLM picks free-form predicates from a tight palette.
  subject     text NOT NULL,
  predicate   text NOT NULL,
  object      text NOT NULL,
  subject_key text NOT NULL,
  object_key  text NOT NULL,
  -- Provenance — which note + chunk this triple was extracted from.
  -- Matches `knowledge_embeddings.source_path / chunk_index` so we can
  -- JOIN back into the embedded chunks for retrieval.
  note_slug    text NOT NULL,
  source_path  text NOT NULL,
  chunk_index  integer NOT NULL,
  -- Optional LLM confidence (0..1). Null = not provided.
  confidence  numeric(4, 3),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_triples_subject_key_idx
  ON knowledge_triples (subject_key);
CREATE INDEX IF NOT EXISTS knowledge_triples_object_key_idx
  ON knowledge_triples (object_key);
CREATE INDEX IF NOT EXISTS knowledge_triples_note_slug_idx
  ON knowledge_triples (note_slug);

-- Dedup on the same triple from the same chunk. The LLM extractor may
-- return overlapping triples across re-runs; this lets us re-extract
-- without exploding the table.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_triples_unique_idx
  ON knowledge_triples (subject_key, predicate, object_key, source_path, chunk_index);
