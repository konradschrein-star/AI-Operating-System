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
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/hcp";
const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

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
