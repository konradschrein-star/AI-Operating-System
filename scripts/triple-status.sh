#!/usr/bin/env bash
set -euo pipefail
PGPASSWORD=content_forge_prod psql -h 127.0.0.1 -U postgres -d content_forge -At <<'SQL'
SELECT 'total_triples:' || count(*) FROM knowledge_triples;
SELECT 'chunks_with_triples:' || count(*) FROM (SELECT DISTINCT source_path, chunk_index FROM knowledge_triples) t;
SELECT 'distinct_entities:' || count(*) FROM (
  SELECT DISTINCT subject_key FROM knowledge_triples
  UNION
  SELECT DISTINCT object_key FROM knowledge_triples
) e;
SELECT 'cat:' || category || ':' || cnt FROM (
  SELECT category, count(*) AS cnt FROM knowledge_triples GROUP BY category ORDER BY cnt DESC
) c;
SQL
