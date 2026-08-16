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
  TRIPLE_CATEGORIES,
  type TripleCategory,
  type NoteSource,
} from "../db/memory.ts";
import {
  SCORE_FLOOR,
  MAX_CHUNKS_PER_NOTE,
} from "../lib/memory-ranking.ts";

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

/* Vault-wide per-category totals, independent of pagination. Mounted before
 * the slug-scoped GET so Hono routes correctly. */
r.get("/counts", async (c) => c.json(await noteCounts(parseSource(c))));

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
