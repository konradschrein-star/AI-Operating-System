/**
 * Memory (Obsidian vault) data access.
 *
 * Data layout:
 *  - hcp.knowledge_note (Postgres) — note registry (id, topic, vault_path, tags, links)
 *  - content_forge.knowledge_embeddings (Postgres) — chunked + embedded bodies with halfvec(1024)
 *  - /opt/obsidian-vault/*.md — source of truth for note bodies
 *
 * The knowledge-mcp/km-indexer.js process keeps the registry + embeddings in
 * sync with the on-disk vault. We read from both: registry for fast list
 * queries, on-disk for the canonical body when a note is opened.
 */

import pg from "pg";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const { Pool } = pg;

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const EMBED_SIDECAR =
  process.env.EMBED_SIDECAR_URL ?? "http://127.0.0.1:8766/embed";

const HCP_URL =
  process.env.HCP_DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/hcp";
const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const hcp = new Pool({
  connectionString: HCP_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
const cf = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

hcp.on("error", (e) => console.error("[hcp pool]", e.message));
cf.on("error", (e) => console.error("[cf memory pool]", e.message));

/* ============================================================================
 * Types
 * ========================================================================== */
export type NoteCategory =
  | "rule"
  | "pref"
  | "fact"
  | "person"
  | "project"
  | "note";

export interface NoteRow {
  id: string;
  slug: string;
  topic: string;
  vault_path: string;
  category: NoteCategory;
  tags: string[];
  links: string[];
  created_at: string;
  preview: string;
}

export interface NoteDetail extends NoteRow {
  body: string;
  word_count: number;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  backlinks: { slug: string; topic: string }[];
}

export interface SearchHit {
  slug: string;
  vault_path: string;
  title: string;
  snippet: string;
  score: number;
  chunk_index: number;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */
/** Convert a Markdown filename → URL-safe slug. Reversible (the slug IS the
 * filename without the .md, so /api/memory/:slug maps back to disk). */
export function slugify(vaultPath: string): string {
  return path.basename(vaultPath, ".md");
}

/** Map our notion of category to whatever signals exist in the registry. */
function inferCategory(topic: string, tags: string[]): NoteCategory {
  const t = (topic ?? "").toLowerCase();
  const tagsLower = (tags ?? []).map((s) => s.toLowerCase());
  if (tagsLower.includes("rule") || t.startsWith("rule -")) return "rule";
  if (tagsLower.includes("preference") || tagsLower.includes("pref"))
    return "pref";
  if (tagsLower.includes("person") || t.startsWith("client -")) return "person";
  if (tagsLower.includes("project") || t.startsWith("project -"))
    return "project";
  if (tagsLower.includes("fact") || tagsLower.includes("reference"))
    return "fact";
  return "note";
}

function extractFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let val: unknown = kv[2].trim().replace(/^["']|["']$/g, "");
    // arrays in the form `[a, b, c]` or `- item` are common; keep them strings
    // here and let the UI handle the rest — we don't need a full YAML parser.
    if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, body: raw.slice(m[0].length) };
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
function extractWikilinks(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) set.add(m[1].trim());
  return [...set];
}

async function safeReadVaultFile(vaultPath: string): Promise<string | null> {
  // Defense against path-traversal: only read from inside VAULT_DIR.
  const abs = path.resolve(VAULT_DIR, vaultPath);
  if (!abs.startsWith(path.resolve(VAULT_DIR) + path.sep)) return null;
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function embedQuery(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(EMBED_SIDECAR, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { dense?: number[] };
    return j.dense ?? null;
  } catch {
    return null;
  }
}

/* ============================================================================
 * Queries
 * ========================================================================== */

/** List vault notes joined with a one-chunk preview from the embeddings store. */
export async function listMemory(limit = 200): Promise<NoteRow[]> {
  const noteResult = await hcp.query<{
    id: string;
    topic: string;
    vault_path: string;
    tags: string[];
    links: string[];
    created_at: string;
  }>(
    `SELECT id, topic, vault_path, tags, links, created_at::text
       FROM knowledge_note
       ORDER BY created_at DESC
       LIMIT $1`,
    [limit],
  );

  const paths = noteResult.rows.map((r) => r.vault_path);
  const previews = new Map<string, string>();
  if (paths.length > 0) {
    const previewResult = await cf.query<{
      source_path: string;
      content: string;
    }>(
      `SELECT DISTINCT ON (source_path) source_path, content
         FROM knowledge_embeddings
         WHERE source_path = ANY($1::text[])
         ORDER BY source_path, chunk_index ASC`,
      [paths],
    );
    for (const row of previewResult.rows) {
      previews.set(row.source_path, row.content.slice(0, 240));
    }
  }

  return noteResult.rows.map((r) => ({
    id: r.id,
    slug: slugify(r.vault_path),
    topic: r.topic,
    vault_path: r.vault_path,
    category: inferCategory(r.topic, r.tags ?? []),
    tags: r.tags ?? [],
    links: r.links ?? [],
    created_at: r.created_at,
    preview: previews.get(r.vault_path) ?? "",
  }));
}

/** Single note detail — reads the on-disk markdown, joins backlinks. */
export async function getMemory(slug: string): Promise<NoteDetail | null> {
  const vaultPath = `${slug}.md`;
  const raw = await safeReadVaultFile(vaultPath);
  if (raw === null) return null;

  const { meta, body } = extractFrontmatter(raw);
  const wikilinks = extractWikilinks(body);

  // Registry row, if it exists.
  const registry = await hcp.query<{
    id: string;
    topic: string;
    tags: string[];
    links: string[];
    created_at: string;
  }>(
    `SELECT id, topic, tags, links, created_at::text
       FROM knowledge_note
       WHERE vault_path = $1
       LIMIT 1`,
    [vaultPath],
  );

  const reg = registry.rows[0];
  const tags =
    reg?.tags ?? (Array.isArray(meta.tags) ? (meta.tags as string[]) : []);
  const links = reg?.links ?? wikilinks;
  const topic = reg?.topic ?? slug.replace(/_/g, " ");

  // Backlinks: notes that link TO this slug.
  const backRes = await hcp.query<{ vault_path: string; topic: string }>(
    `SELECT vault_path, topic
       FROM knowledge_note
       WHERE $1 = ANY(links)
       ORDER BY topic
       LIMIT 50`,
    [slug],
  );
  const backlinks = backRes.rows.map((r) => ({
    slug: slugify(r.vault_path),
    topic: r.topic,
  }));

  return {
    id: reg?.id ?? slug,
    slug,
    topic,
    vault_path: vaultPath,
    category: inferCategory(topic, tags),
    tags,
    links,
    created_at: reg?.created_at ?? new Date(0).toISOString(),
    preview: body.slice(0, 240),
    body,
    word_count: body.split(/\s+/).filter(Boolean).length,
    frontmatter: meta,
    wikilinks,
    backlinks,
  };
}

/** Semantic search over the vault using pgvector cosine on the HNSW index. */
export async function searchMemory(
  query: string,
  limit = 12,
): Promise<SearchHit[]> {
  const vec = await embedQuery(query);
  if (!vec) return [];

  // halfvec literal: pgvector accepts a string '[v1,v2,...]' cast to halfvec.
  const literal = `[${vec.join(",")}]`;
  const r = await cf.query<{
    source_path: string;
    title: string;
    content: string;
    chunk_index: number;
    distance: number;
  }>(
    `SELECT source_path, title, content, chunk_index,
            (embedding <=> $1::halfvec) AS distance
       FROM knowledge_embeddings
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::halfvec
       LIMIT $2`,
    [literal, limit],
  );

  return r.rows.map((row) => ({
    slug: slugify(row.source_path),
    vault_path: row.source_path,
    title: row.title,
    snippet: row.content.slice(0, 220),
    score: 1 - row.distance, // cosine distance → similarity
    chunk_index: row.chunk_index,
  }));
}

/* ============================================================================
 * v1.6 phase 5 — knowledge_triples + 1-hop GraphRAG expansion.
 *
 * Builds a small entity/relation index on top of knowledge_embeddings. An LLM
 * pass (claude-pool) reads each chunk and emits `{subject, predicate, object}`
 * triples; we persist them with provenance back to the source chunk.
 *
 * At search time, top vector hits seed an entity set; we then expand 1-hop
 * across knowledge_triples to surface chunks that share an entity even if
 * the vector cosine missed them. Postgres-only — no TrustGraph deploy.
 * ========================================================================== */

const POOL_URL =
  process.env.CLAUDE_POOL_URL ?? "http://127.0.0.1:8092";
const POOL_KEY = process.env.CLAUDE_POOL_API_KEY ?? "";

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

function normaliseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXTRACTION_PROMPT = `You are a knowledge extractor. Read the passage
below and emit a JSON array of {subject, predicate, object, confidence}
triples capturing factual relations. Keep predicates short and consistent
(e.g. "deprecates", "replaces", "uses", "owns", "rules-against", "located-in",
"belongs-to", "decided-on"). Use Title Case for proper nouns. Confidence is
0.0-1.0. Reply with ONLY the JSON array, no preface, no markdown fences.

Passage:
---
{TEXT}
---`;

async function callPoolForJson(prompt: string): Promise<unknown> {
  const res = await fetch(`${POOL_URL}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": POOL_KEY },
    body: JSON.stringify({ prompt, timeout_ms: 120_000 }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };
  if (!res.ok)
    throw new Error(`pool ${res.status}: ${j.error ?? res.statusText}`);
  if (typeof j.text !== "string") throw new Error("pool returned no text");
  // Strip trailing/leading whitespace and any accidental ``` fences.
  const body = j.text
    .trim()
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "");
  return JSON.parse(body);
}

/** Extract triples for a single chunk via claude-pool. Best-effort: returns
 *  an empty array if the pool errors or the response can't be parsed. */
export async function extractTriplesFromChunk(text: string): Promise<Triple[]> {
  try {
    const raw = await callPoolForJson(EXTRACTION_PROMPT.replace("{TEXT}", text));
    if (!Array.isArray(raw)) return [];
    const out: Triple[] = [];
    for (const t of raw) {
      if (!t || typeof t !== "object") continue;
      const r = t as Record<string, unknown>;
      const subject = typeof r.subject === "string" ? r.subject.trim() : "";
      const predicate =
        typeof r.predicate === "string" ? r.predicate.trim() : "";
      const object = typeof r.object === "string" ? r.object.trim() : "";
      if (!subject || !predicate || !object) continue;
      const confidence =
        typeof r.confidence === "number" &&
        r.confidence >= 0 &&
        r.confidence <= 1
          ? r.confidence
          : undefined;
      out.push({ subject, predicate, object, confidence });
    }
    return out;
  } catch (e) {
    console.error(
      "[memory triples] extraction failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/** Insert triples for one chunk. Idempotent thanks to the unique index. */
export async function upsertTriples(
  noteSlug: string,
  sourcePath: string,
  chunkIndex: number,
  triples: Triple[],
): Promise<number> {
  if (triples.length === 0) return 0;
  const values: string[] = [];
  const params: unknown[] = [];
  for (const t of triples) {
    const start = params.length + 1;
    params.push(
      t.subject,
      t.predicate,
      t.object,
      normaliseKey(t.subject),
      normaliseKey(t.object),
      noteSlug,
      sourcePath,
      chunkIndex,
      t.confidence ?? null,
    );
    const placeholders = Array.from(
      { length: 9 },
      (_, i) => `$${start + i}`,
    ).join(",");
    values.push(`(${placeholders})`);
  }
  const sql = `INSERT INTO knowledge_triples
                 (subject, predicate, object, subject_key, object_key,
                  note_slug, source_path, chunk_index, confidence)
               VALUES ${values.join(",")}
               ON CONFLICT (subject_key, predicate, object_key,
                            source_path, chunk_index) DO NOTHING`;
  const r = await cf.query(sql, params);
  return r.rowCount ?? 0;
}

/** Run extraction for one note: re-embed-source-of-truth is chunks already
 *  indexed in knowledge_embeddings. Walks those chunks, calls the LLM per
 *  chunk, inserts triples. Matches by suffix so both vault notes (`%.md`)
 *  and other source layouts (`hermes://msg-…`) work — caller passes the
 *  filename or message id, we LIKE-match. */
export async function extractTriplesForNote(slug: string): Promise<{
  chunks: number;
  triples: number;
}> {
  const r = await cf.query<{
    source_path: string;
    chunk_index: number;
    content: string;
  }>(
    `SELECT source_path, chunk_index, content
       FROM knowledge_embeddings
       WHERE source_path LIKE $1 OR source_path LIKE $2
       ORDER BY chunk_index ASC`,
    [`%${slug}.md`, `%${slug}`],
  );
  let triplesTotal = 0;
  for (const row of r.rows) {
    const tps = await extractTriplesFromChunk(row.content);
    const n = await upsertTriples(slug, row.source_path, row.chunk_index, tps);
    triplesTotal += n;
  }
  return { chunks: r.rows.length, triples: triplesTotal };
}

/** Bulk extractor — walks the next N un-extracted chunks (any source) and
 *  persists triples. Idempotent; safe to re-run. Used as a one-shot warm-up
 *  endpoint before turning on the cron job. */
export async function extractTriplesNextBatch(limit = 20): Promise<{
  chunks: number;
  triples: number;
}> {
  const r = await cf.query<{
    source_path: string;
    chunk_index: number;
    content: string;
  }>(
    `SELECT e.source_path, e.chunk_index, e.content
       FROM knowledge_embeddings e
       LEFT JOIN knowledge_triples t
         ON t.source_path = e.source_path
        AND t.chunk_index = e.chunk_index
      WHERE t.id IS NULL
      ORDER BY e.source_path, e.chunk_index
      LIMIT $1`,
    [limit],
  );
  let triplesTotal = 0;
  for (const row of r.rows) {
    const slug = slugify(row.source_path);
    const tps = await extractTriplesFromChunk(row.content);
    const n = await upsertTriples(slug, row.source_path, row.chunk_index, tps);
    triplesTotal += n;
  }
  return { chunks: r.rows.length, triples: triplesTotal };
}

/** Look up chunks that share at least one entity (subject_key OR object_key)
 *  with the seed set. Returns SearchHit shape so callers can merge with
 *  vector results. */
export async function neighborhoodHits(
  entities: Iterable<string>,
  excludePaths: string[],
  limit = 8,
): Promise<SearchHit[]> {
  const keys = [...new Set(entities)].filter(Boolean);
  if (keys.length === 0) return [];
  const r = await cf.query<{
    source_path: string;
    chunk_index: number;
    title: string;
    content: string;
    hit_count: string;
  }>(
    `WITH neighbours AS (
       SELECT source_path, chunk_index, COUNT(*)::int AS hit_count
         FROM knowledge_triples
        WHERE subject_key = ANY($1::text[]) OR object_key = ANY($1::text[])
        GROUP BY source_path, chunk_index
     )
     SELECT e.source_path, e.chunk_index, e.title, e.content,
            n.hit_count::text AS hit_count
       FROM neighbours n
       JOIN knowledge_embeddings e
         ON e.source_path = n.source_path
        AND e.chunk_index = n.chunk_index
      WHERE NOT (e.source_path = ANY($2::text[]))
      ORDER BY n.hit_count DESC
      LIMIT $3`,
    [keys, excludePaths, limit],
  );
  return r.rows.map((row) => ({
    slug: slugify(row.source_path),
    vault_path: row.source_path,
    title: row.title,
    snippet: row.content.slice(0, 220),
    score: 0.5 + Math.min(0.49, Number(row.hit_count) * 0.1),
    chunk_index: row.chunk_index,
  }));
}

/* ============================================================================
 * v1.7 Phase 1 — multi-hop GraphRAG expansion.
 *
 * Generalisation of the v1.6 phase 5 1-hop walk: seed entities from the vector
 * hits, then walk outward up to MEMORY_GRAPH_MAX_HOPS (default 2) hops, with
 * each successive hop's hits scored down by MEMORY_GRAPH_HOP_DECAY (default
 * 0.65). 2-hop catches "what did Konrad decide about TTS providers and how
 * does that connect to AI33 deprecation" — the kind of multi-hop reasoning
 * single-hop expansion misses.
 *
 * Hit ordering: vector first (hop=0), then graph in hop-order. Score decay is
 * applied across the row so callers can sort by score within a hop if they
 * want. Each hit carries both `via` ('vector' | 'graph') and `hop` (0|1|2|…)
 * so the UI can render lane chips per hit.
 * ========================================================================== */

const MAX_HOPS = Number(process.env.MEMORY_GRAPH_MAX_HOPS ?? "2");
const HOP_DECAY = Number(process.env.MEMORY_GRAPH_HOP_DECAY ?? "0.65");

export type SearchHitWithLane = SearchHit & {
  via: "vector" | "graph";
  hop: number;
};

/** Look up triples that fired against a specific set of (path, chunk) pairs
 *  and return the entity set so callers can walk outward from those chunks. */
async function entitiesForChunks(
  chunks: Array<{ vault_path: string; chunk_index: number }>,
): Promise<Set<string>> {
  if (chunks.length === 0) return new Set();
  const paths = chunks.map((h) => h.vault_path);
  const idxs = chunks.map((h) => h.chunk_index);
  const r = await cf.query<{ subject_key: string; object_key: string }>(
    `SELECT DISTINCT subject_key, object_key
       FROM knowledge_triples
       WHERE (source_path, chunk_index) = ANY(
              SELECT * FROM UNNEST($1::text[], $2::int[])
            )`,
    [paths, idxs],
  );
  const set = new Set<string>();
  for (const row of r.rows) {
    set.add(row.subject_key);
    set.add(row.object_key);
  }
  return set;
}

/** Vector + N-hop GraphRAG expansion. */
export async function searchMemoryWithGraph(
  query: string,
  opts: {
    vectorLimit?: number;
    graphLimit?: number;
    maxHops?: number;
  } = {},
): Promise<SearchHitWithLane[]> {
  const vectorLimit = opts.vectorLimit ?? 8;
  const graphLimit = opts.graphLimit ?? 6;
  const maxHops = Math.max(0, Math.min(5, opts.maxHops ?? MAX_HOPS));
  // Spread the graph budget across hops; ceil so the first hop gets at least 1.
  const perHopBudget = Math.max(1, Math.ceil(graphLimit / Math.max(1, maxHops)));

  // Hop 0: vector hits.
  const vectorHits = await searchMemory(query, vectorLimit);
  const vectorLane: SearchHitWithLane[] = vectorHits.map((h) => ({
    ...h,
    via: "vector",
    hop: 0,
  }));

  // Track every (path, chunk) we've already surfaced so subsequent hops don't
  // resurrect them. Same key format as the previous 1-hop dedup.
  const seenChunkKey = new Set(
    vectorHits.map((h) => `${h.vault_path}#${h.chunk_index}`),
  );
  // Path-level exclusion for the SQL — we exclude entire vault paths from
  // graph expansion once we've seen any chunk from them, so multi-hop doesn't
  // recirculate. This is consistent with v1.6 phase 5 behaviour for hop 1.
  const seenPaths = new Set(vectorHits.map((h) => h.vault_path));

  // Walk outward: each iteration seeds from the previous hop's NEW chunks.
  let frontier: Array<{ vault_path: string; chunk_index: number }> =
    vectorHits.map((h) => ({ vault_path: h.vault_path, chunk_index: h.chunk_index }));
  const graphLanes: SearchHitWithLane[] = [];

  for (let hop = 1; hop <= maxHops; hop++) {
    const entities = await entitiesForChunks(frontier);
    if (entities.size === 0) break;
    const raw = await neighborhoodHits(entities, [...seenPaths], perHopBudget);
    const fresh: SearchHitWithLane[] = [];
    for (const h of raw) {
      const key = `${h.vault_path}#${h.chunk_index}`;
      if (seenChunkKey.has(key)) continue;
      seenChunkKey.add(key);
      seenPaths.add(h.vault_path);
      // Diminishing weight per hop. Hop 1 keeps decay^1, hop 2 decay^2, etc.
      const decayed = h.score * Math.pow(HOP_DECAY, hop);
      fresh.push({ ...h, score: decayed, via: "graph", hop });
    }
    if (fresh.length === 0) break;
    graphLanes.push(...fresh);
    // Seed next hop from the chunks we just discovered.
    frontier = fresh.map((h) => ({
      vault_path: h.vault_path,
      chunk_index: h.chunk_index,
    }));
  }

  return [...vectorLane, ...graphLanes];
}

/** Health-check the vault dir + the embedding sidecar. */
export async function pingMemory(): Promise<{
  vault_ok: boolean;
  vault_notes: number;
  embeddings_ok: boolean;
  embed_sidecar_ok: boolean;
}> {
  let vault_ok = false;
  let vault_notes = 0;
  try {
    const s = await stat(VAULT_DIR);
    vault_ok = s.isDirectory();
    if (vault_ok) {
      const r = await hcp.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM knowledge_note`,
      );
      vault_notes = Number(r.rows[0]?.count ?? "0");
    }
  } catch {
    // leave defaults
  }
  let embeddings_ok = false;
  try {
    const r = await cf.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM knowledge_embeddings`,
    );
    embeddings_ok = Number(r.rows[0]?.count ?? "0") > 0;
  } catch {
    // leave default
  }
  let embed_sidecar_ok = false;
  try {
    const r = await fetch(EMBED_SIDECAR.replace("/embed", "/health"), {
      method: "GET",
    });
    embed_sidecar_ok = r.ok;
  } catch {
    // leave default
  }
  return { vault_ok, vault_notes, embeddings_ok, embed_sidecar_ok };
}
