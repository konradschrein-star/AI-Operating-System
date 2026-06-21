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

## Maximalist evaluation (2026-06-21)

**Why re-audit:** Konrad waved off the "10× ops surface" framing — personal side project, no commercial intent, full deployment is on the table. Re-grounding on the VPS: `free -h` shows 62GB total / 41GB available, `df -h /` shows 372GB free on a 906GB disk, 16 cores, load avg 1.34. The maximalist deploy is comfortably within budget on this box. The license is Apache-2.0 so "use freely" is a non-issue.

**What we now know vs. the first audit:**

- Graph backends really are pluggable — trustgraph.ai confirms Neo4j, Cassandra, Memgraph, FalkorDB. Cassandra is recommended for "ease of use," not required. **FalkorDB (Redis-backed graph) collapses the heaviest dep**: ~1–2GB RAM vs Cassandra's 8–12GB, and we already run Redis for BullMQ.
- Ontology Workbench: full OWL/SHACL class+property tree editor with OWL/Turtle round-trip, circular-dep detection, safe-delete. Konrad could define a `Job`, `Format`, `Provider`, `Asset`, `Channel`, `Error`, `StuckSignal` ontology, then have every chunk auto-tagged against it during ingest. That schema would also drive UI faceting in `/api/memory/search` and Hermes Skills routing — single source of truth.
- 3D Graph Explorer: BFS neighborhood extraction, edge pulse animation, dynamic graph loading, multiple nav views. If we feed it `content_jobs` + `agent_message` + `knowledge_note` + Hermes `runs`, Konrad would actually *see* the fleet — which jobs are stuck, what they share, which providers cluster around which errors. Not just "feels cool" — it's a new operational surface.
- GraphRAG pipeline (7-step, confirmed): chunk → entity/relation extraction → embed entities → store triples → semantic-similarity entry point → graph traversal → LLM with subgraph context. The win over our halfvec-only `/api/memory/search` is **multi-hop recall**: "what did Konrad decide about TTS providers and how does that connect to AI33 deprecation and the fastgen-gateway?" — that's 3-hop reasoning we can't do today.
- MCP: `trustgraph-mcp` directory exists and "MCP Registry" is a first-class navigation surface, so cc-* workers can consume TrustGraph knowledge tools natively. Specific tool list wasn't documented on the public docs site — needs a clone-and-grep, but the shape is confirmed.

### Three tiers

**Minimal — cherry-pick (original verdict)**
- Hours: ~3 days.
- VPS impact: zero new processes, one new PG table (`knowledge_triples`), +~50MB extraction cache.
- AI OS gains: 1-hop expansion in `/api/memory/search`, marginal recall lift.
- Risks: still vector-only at the core; no multi-hop; no visual surface; ontology stays implicit.

**Mid — sidecar TrustGraph (FalkorDB profile)**
- Hours: ~5–7 days (1 day docker-compose + FalkorDB swap, 2 days ingest pipeline pointed at `/opt/obsidian-vault`, 2 days MCP server wiring into cc-* workers, 1–2 days `/api/memory/search` hybrid query layer).
- VPS impact: ~6–10GB RAM (FalkorDB + Qdrant + minimal Pulsar + trustgraph-* services + MCP server), ~15GB disk, 1 new docker-compose stack, 4–6 new PM2-equivalent processes (or all-in-docker). Postgres stays canonical.
- AI OS gains: GraphRAG retrieval via MCP for every cc-* worker; entity-typed search; provenance per edge; ontology workbench available but optional.
- Risks: two memory systems to keep in sync (PG `knowledge_embeddings` mirror vs TrustGraph triples) until we trust the new one; Pulsar is the dep that least justifies itself at our scale.

**Maximalist — TrustGraph primary, AI OS Memory tab**
- Hours: ~12–15 days (Mid + 3D explorer embedded as `/memory/explore` tab in AI OS via `@trustgraph/react-provider`, 2 days ontology design for Content Forge domain, 2 days migrating `knowledge_embeddings` to read-through cache, 2 days exposing ontology-tagged write path so Hermes `agent_message` + `content_jobs` events flow into TrustGraph in real time).
- VPS impact: ~12–18GB RAM total, ~30–50GB disk over 6 months, full docker-compose stack (FalkorDB + Qdrant + Pulsar + Garage + trustgraph-* + workbench UI + MCP). Comfortably within the 41GB headroom.
- AI OS gains: (a) a Memory tab with real 3D fleet explorer; (b) Konrad-authored fleet ontology drives both memory and Skills routing; (c) GraphRAG over both notes *and* operational state (jobs, runs, errors); (d) explainability DAG for every agent decision.
- Risks: real lock-in to TrustGraph's data model; backup/restore story is now 4 systems not 1; if upstream pivots, migration is non-trivial. Mitigation: keep Postgres write-ahead log of every ingest event so we can rebuild.

### Recommendation: **Mid tier, with maximalist as the documented next step.**

Mid gets us the two genuinely new capabilities (GraphRAG multi-hop + MCP-for-cc-*) without committing the AI OS data model to TrustGraph. Run it as a read-only mirror of the Obsidian vault + `content_jobs` snapshot for 2–3 weeks; if Konrad uses GraphRAG queries daily and the 3D explorer becomes the primary "what's my fleet doing" surface, promote to Maximalist. If it's a curiosity, walk back to Minimal with the lessons learned.

**Concrete next step:** spike a single-day branch — `git clone TrustGraph`, swap Cassandra → FalkorDB in the generated compose, point ingest at `/opt/obsidian-vault`, expose `trustgraph-mcp` to one cc-* worker, run 10 multi-hop questions against it and against `/api/memory/search`, score recall side-by-side. Decision gate before committing to the 5–7 day Mid build.
