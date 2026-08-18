import { Hono } from "hono";
import {
  listMemoryPage,
  noteCounts,
  getMemory,
  searchMemory,
  searchMemoryWithGraph,
  extractTriplesForNote,
  extractTriplesNextBatch,
  pingMemory,
  knowledgeGraph,
  syncVaultNotes,
  graphLaneStatus,
  indexHealth,
  pruneStaleEmbeddingRows,
  TRIPLE_CATEGORIES,
  type TripleCategory,
  type NoteSource,
} from "../db/memory.ts";
import {
  SCORE_FLOOR,
  MAX_CHUNKS_PER_NOTE,
} from "../lib/memory-ranking.ts";
import { stalePaths } from "../lib/index-health.ts";

const r = new Hono();

function parseSource(c: { req: { query: (k: string) => string | undefined } }): NoteSource | undefined {
  const raw = c.req.query("source");
  return raw === "vault" || raw === "agent" ? raw : undefined;
}

r.get("/health", async (c) => c.json(await pingMemory()));

/* Manual trigger for the vault↔knowledge_note reconciliation pass — the
 * periodic tick (vault-sync-tick.ts) covers the steady state, this lets the
 * UI (or a curl) force an immediate resync after editing the vault. */
r.post("/sync", async (c) => c.json(await syncVaultNotes()));

/* v2.2: entity graph for the 3D visualization. Registered before /:slug so
 * the catch-all param route doesn't shadow it. */
r.get("/graph", async (c) => {
  const maxLinks = Math.min(
    6000,
    Math.max(100, Number(c.req.query("limit") ?? "3000")),
  );
  return c.json(await knowledgeGraph(maxLinks));
});

/* Vault-wide labelled counts envelope, independent of pagination. Mounted
 * before the slug-scoped GET so Hono routes correctly. The bare `all` and the
 * five category chips are gone — see noteCounts() in db/memory.ts. */
r.get("/counts", async (c) => c.json(await noteCounts(parseSource(c))));

/* Three-way reconciliation of vault ↔ hcp.knowledge_note ↔
 * content_forge.knowledge_embeddings (R12/R13). Registered BEFORE the
 * /:slug{.+} catch-all below, which would otherwise swallow it and look up a
 * note called "index-health"; memory-index-health.test.ts asserts that
 * ordering against this router's own route table rather than by eye.
 *
 * On failure this returns 500 WITH THE MESSAGE. It never degrades to zeros:
 * a zeroed reconciliation is indistinguishable from a real, total index gap,
 * and chasing that phantom is the afternoon this endpoint exists to save. */
r.get("/index-health", async (c) => {
  try {
    return c.json(await indexHealth());
  } catch (err) {
    return c.json(
      {
        error: `index-health failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }
});

/* The ONLY caller of pruneStaleEmbeddingRows(). No tick, no startup path and
 * no read reaches it (R14). It removes embedding rows for exactly the paths
 * this run classified `stale_row_file_missing` — recomputed here, never taken
 * from the client, so a stale or hostile path list cannot delete a live note's
 * chunks. Deliberate act ⇒ `{"confirm": true}` required. */
r.post("/index-health/prune", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json(
      {
        error: `body must be JSON {"confirm": true} — ${err instanceof Error ? err.message : String(err)}`,
      },
      400,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { confirm?: unknown }).confirm !== true
  ) {
    return c.json(
      { error: 'pruning requires {"confirm": true} in the body' },
      400,
    );
  }
  try {
    const health = await indexHealth();
    const stale = stalePaths(health);
    const { pruned, count } = await pruneStaleEmbeddingRows(stale);
    return c.json({ pruned, count });
  } catch (err) {
    // Same contract as the GET: 5xx carrying the message. A prune that cannot
    // first reconcile must delete NOTHING and say why — reconciliation is what
    // decides which paths are stale, so a failed one has no candidate list.
    return c.json(
      {
        error: `index-health prune failed before deleting anything: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }
});

r.get("/", async (c) => {
  const limit = Math.min(
    500,
    Math.max(1, Number(c.req.query("limit") ?? "30")),
  );
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0"));
  const { notes, hasMore } = await listMemoryPage(limit, offset, parseSource(c));
  return c.json({ count: notes.length, notes, hasMore });
});

r.get("/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ q, hits: [], message: "query required" }, 400);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "12")));

  // 2026-08-05 ranking rework (audit §4.C): results are deduped to at most
  // `max_per_note` chunks per source note, weighted by note type + mtime
  // recency, and cut at `floor`. A query with nothing above the floor returns
  // an empty hit list on purpose — fewer results beat confident noise.
  // ?floor=0 disables the cut for diagnostics ("what was rejected, and why").
  const floorRaw = c.req.query("floor");
  const floor =
    floorRaw !== undefined && floorRaw !== "" && Number.isFinite(Number(floorRaw))
      ? Math.min(1, Math.max(0, Number(floorRaw)))
      : undefined;
  const perNoteRaw = c.req.query("max_per_note");
  const maxPerNote =
    perNoteRaw !== undefined && Number.isFinite(Number(perNoteRaw))
      ? Math.min(10, Math.max(1, Number(perNoteRaw)))
      : undefined;
  const ranking = {
    floor: floor ?? SCORE_FLOOR,
    max_per_note: maxPerNote ?? MAX_CHUNKS_PER_NOTE,
  };
  // v1.6 phase 5: ?expand=1 enables GraphRAG expansion on top of vector-only
  // halfvec cosine. Hit shape carries `via` ('vector' | 'graph') so the UI
  // can lane each result.
  // v1.7 phase 1: ?hops=N controls multi-hop expansion (1-3). Defaults to
  // server-side MEMORY_GRAPH_MAX_HOPS. Each hit also carries `hop` (0 for
  // vector, 1..N for graph) so the UI can render the hop depth.
  const expand = c.req.query("expand") === "1";
  if (expand) {
    const hopsRaw = c.req.query("hops");
    const maxHops = hopsRaw !== undefined
      ? Math.max(0, Math.min(3, Number(hopsRaw)))
      : undefined;
    // v1.7 phase 2: ?category=decision|rule|… filters the graph walk so
    // only triples of that category propagate. Unknown values 400.
    const catRaw = c.req.query("category");
    let category: TripleCategory | undefined;
    if (catRaw) {
      if (!(TRIPLE_CATEGORIES as readonly string[]).includes(catRaw)) {
        return c.json(
          {
            error: `unknown category "${catRaw}" — valid: ${TRIPLE_CATEGORIES.join(", ")}`,
          },
          400,
        );
      }
      category = catRaw as TripleCategory;
    }
    const hits = await searchMemoryWithGraph(q, {
      vectorLimit: limit,
      graphLimit: Math.max(4, Math.floor(limit / 2)),
      maxHops,
      category,
      floor,
      maxPerNote,
    });
    return c.json({
      q,
      count: hits.length,
      hits,
      expand: true,
      max_hops: maxHops,
      category,
      ranking,
      // Why the graph lane did or didn't contribute — otherwise "expand=1
      // returned only vector hits" is indistinguishable from a bug.
      graph_lane: await graphLaneStatus(),
    });
  }
  const hits = await searchMemory(q, limit, { floor, maxPerNote });
  return c.json({ q, count: hits.length, hits, ranking });
});

/* POST /triples/extract-batch?limit=N — walks the next N un-extracted
 * chunks (across all source_path schemes) and persists triples. Bulk
 * vault-wide cron deferred to v1.7. Mounted BEFORE the slug-scoped
 * version so Hono routes correctly. */
r.post("/triples/extract-batch", async (c) => {
  const limit = Math.min(
    50,
    Math.max(1, Number(c.req.query("limit") ?? "20")),
  );
  const r2 = await extractTriplesNextBatch(limit);
  return c.json({ batch_limit: limit, ...r2 });
});

/* POST /:slug/triples/extract — run the LLM extractor across every chunk of
 * one note and persist triples. */
r.post("/:slug/triples/extract", async (c) => {
  const slug = c.req.param("slug");
  if (!slug || slug.length > 200)
    return c.json({ error: "invalid slug" }, 400);
  const r2 = await extractTriplesForNote(slug);
  return c.json({ slug, ...r2 });
});

// Slug may contain spaces (vault file names do). Hono decodes path params.
r.get("/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  const note = await getMemory(slug);
  if (!note) return c.json({ error: "note not found", slug }, 404);
  return c.json({ note });
});

export default r;
