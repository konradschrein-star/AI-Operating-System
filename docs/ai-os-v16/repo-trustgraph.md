# TrustGraph — Eval for Hermes / AI OS Memory Layer

Repo: https://github.com/trustgraph-ai/TrustGraph · 2.2k stars · updated 2026-06-20 · Apache-2.0 · 99% Python

## TL;DR

TrustGraph is a heavyweight, fully-batteries-included "holonic context graph" platform — it bundles Cassandra + Qdrant + Garage (S3) + Pulsar/RabbitMQ + an LLM serving stack and wants to own the whole memory backend. It is **not a drop-in upgrade** to our Postgres + halfvec setup. There are 2–3 ideas worth lifting (ontology-driven entity/relation extraction, GraphRAG retrieval, provenance-per-edge), but deploying TrustGraph itself would 5–10× our ops surface for a tier of users we don't have. **Verdict: cherry-pick concepts, do not deploy.**

## What TrustGraph is

- "Semantic infrastructure for agents." Treats knowledge as **Context Cores** (ontology + holons + embeddings + provenance + retrieval policies) rather than chunks.
- Three RAG pipelines OOTB: **DocumentRAG, GraphRAG, OntologyRAG**.
- Three-tier tenancy: Workspaces → Collections → Flows.
- Ships with: 3D graph explorer, agent console, ontology workbench, MCP integration, Prometheus/Grafana.
- Built on **semantic web standards** (RDF / OWL / SHACL / SKOS) — not Cypher-native; graph backends are pluggable (Neo4j, Cassandra, Memgraph, FalkorDB).

## License + stack

Apache-2.0 (lift-compatible). Python core, TS client libs (`@trustgraph/client`, `react-state`, `react-provider`). Deploys via docker compose / k8s. Single-command config via `npx @trustgraph/config`.

## Comparison vs our current memory layer

| Feature                      | TrustGraph                                      | Our setup (Hermes / AI OS)           | Gap                                   |
| ---------------------------- | ----------------------------------------------- | ------------------------------------ | ------------------------------------- |
| Vector store                 | Qdrant / Pinecone / Milvus                      | Postgres halfvec(1024) + HNSW cosine | None — ours is leaner                 |
| Graph store                  | Neo4j / Cassandra / Memgraph / FalkorDB         | None (just FK relations)             | **Real gap** if we want graph queries |
| Entity / relation extraction | Ontology-driven, automated, with provenance     | None — raw markdown chunked          | **Real gap**                          |
| Hybrid retrieval             | GraphRAG + DocumentRAG + OntologyRAG            | Vector-only (`/api/memory/search`)   | **Real gap**                          |
| Reranking                    | Implicit via graph traversal (BFS neighborhood) | None                                 | Minor gap                             |
| Ingestion                    | PDF / DB / API connectors + pipelines           | Obsidian-only via `km-indexer.js`    | We're narrower on purpose             |
| Provenance                   | Per-node/edge source attribution                | `knowledge_note` row only            | Minor gap                             |
| Multi-tenancy                | Structural isolation at queue/storage/API       | Single-tenant (Konrad)               | Don't need it                         |
| Ops surface                  | Cassandra + Qdrant + Pulsar + Garage + vLLM     | 1 Postgres + 1 sidecar (`:8766`)     | TrustGraph is **~10× heavier**        |

## Top 3 reuse paths

1. **Cherry-pick GraphRAG concept into our indexer.** Add a lightweight entity/relation extractor pass to `km-indexer.js` (LLM-driven: prompt → JSON triples), persist to a new `knowledge_triples` table (subject, predicate, object, note_id, chunk_id). Use it to expand vector hits via 1-hop neighborhood at query time inside `/api/memory/search`. ~2 days; no new infra.
2. **Steal the OntologyRAG idea for Hermes Skills.** Define a tiny ontology over our domains (job, format, provider, asset, error) and tag chunks during indexing. Lets `/api/search` filter by entity type before vector search. Few hours of prompt work + a column.
3. **Sidecar TrustGraph for a single Workspace** _only if_ we ever want a 3D graph UI / explainability DAG over the vault. Run it isolated on the VPS (1 docker-compose stack), point its ingestion at `/opt/obsidian-vault`, expose its `/api/v1/graph-rag` to our Next.js. Read-only mirror — our Postgres stays canonical. Realistically ~16GB RAM and a weekend of ops.

## Cost to integrate

- **Cherry-pick (paths 1+2):** ~3 days dev, no new infra, marginal LLM cost (1 extraction call per chunk at index time, cacheable). Best ROI.
- **Sidecar deploy (path 3):** Cassandra + Qdrant + Pulsar + Garage = ~16–24GB RAM minimum, ~50GB disk, new Prometheus targets, new auth surface. Ops debt is meaningful for a 1-user system.
- **Replacement:** Not viable. Would force-migrate 198 notes + 626 embeddings into a stack designed for enterprise multi-tenant with no payoff at our scale.

## Verdict

**Cherry-pick, do not deploy.** Build a tiny entity/triple extractor on top of `km-indexer.js`, add a `knowledge_triples` table, and graft 1-hop graph expansion onto `/api/memory/search`. Revisit a TrustGraph sidecar only if/when Konrad wants a real 3D knowledge explorer UI or starts hosting context for other users.
