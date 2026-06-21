import { Hono } from "hono";
import {
  listMemory,
  getMemory,
  searchMemory,
  searchMemoryWithGraph,
  extractTriplesForNote,
  extractTriplesNextBatch,
  pingMemory,
  TRIPLE_CATEGORIES,
  type TripleCategory,
} from "../db/memory.ts";

const r = new Hono();

r.get("/health", async (c) => c.json(await pingMemory()));

r.get("/", async (c) => {
  const limit = Math.min(
    500,
    Math.max(1, Number(c.req.query("limit") ?? "200")),
  );
  const notes = await listMemory(limit);
  return c.json({ count: notes.length, notes });
});

r.get("/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ q, hits: [], message: "query required" }, 400);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "12")));
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
    });
    return c.json({
      q,
      count: hits.length,
      hits,
      expand: true,
      max_hops: maxHops,
      category,
    });
  }
  const hits = await searchMemory(q, limit);
  return c.json({ q, count: hits.length, hits });
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
