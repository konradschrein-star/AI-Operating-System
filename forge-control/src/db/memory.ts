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
import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  rankCandidates,
  CANDIDATE_MULTIPLIER,
  CANDIDATE_CAP,
  MAX_CHUNKS_PER_NOTE,
  SCORE_FLOOR,
  type NoteKind,
  type RankExplain,
} from "../lib/memory-ranking.ts";
import {
  reconcile,
  countByReason,
  folderCounts,
  folderRule,
  EXCLUDED_EXTENSION,
  type IndexHealth,
  type DiskFile,
  type MemoryCounts,
  type ReconcileInput,
} from "../lib/index-health.ts";
// The Obsidian deep-link pair, REUSED rather than reimplemented: obsidianUri()
// already encodes each component separately, which is the whole reason a note
// whose name contains "&" opens at all (see its comment in lib/vault.ts).
import { vaultName, obsidianUri } from "../lib/vault.ts";

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

/** "vault" = indexed from a real file in /opt/obsidian-vault (syncVaultNotes).
 *  "agent" = written directly by a Hermes fleet worker via knowledge.ts's
 *  POST /knowledge — a status brief, not a real vault file; vault_path there
 *  is a self-declared label, not a path that exists on disk. */
export type NoteSource = "vault" | "agent";

export interface NoteRow {
  id: string;
  slug: string;
  topic: string;
  vault_path: string;
  category: NoteCategory;
  source: NoteSource;
  created_by: string;
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
  /** The Obsidian vault name the deep link below targets. Returned for EVERY
   *  note, agent briefs included, because the UI states the precondition on
   *  screen ("only opens on a machine running Obsidian with this vault")
   *  whether or not it can offer the link (R26). */
  vault_name: string;
  /** obsidian://open?vault=…&file=… — null for an agent brief, whose
   *  vault_path is "a self-declared label, not a path that exists on disk"
   *  (see NoteSource). A deep link to one silently fails, which is exactly
   *  what R26 forbids. */
  obsidian_uri: string | null;
}

export interface SearchHit {
  slug: string;
  vault_path: string;
  title: string;
  snippet: string;
  /** Weighted score (raw cosine × note-type prior × recency decay). */
  score: number;
  chunk_index: number;
  /** Retrieval prior applied — see lib/memory-ranking.ts. Absent on graph-lane
   *  hits, whose score is synthetic rather than cosine-derived. */
  note_kind?: NoteKind;
  /** Ranking provenance, so a bad result set can be diagnosed from the API
   *  response alone instead of by re-deriving the maths. */
  explain?: RankExplain;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */
/** Convert a vault-relative path → URL-safe slug. Reversible (the slug IS
 * the full relative path without the .md, so /api/memory/:slug maps back to
 * disk) — keeping the folder is required: two notes with the same filename
 * in different folders (common in a 296-note vault) would otherwise collide,
 * and every nested note would 404 on open (basename-only lost the folder). */
export function slugify(vaultPath: string): string {
  return vaultPath.replace(/\.md$/i, "");
}

export const VAULT_SYNC_AUTHOR = "vault-sync";

/** Rows written by syncVaultNotes() are real vault files; everything else
 *  came from a Hermes fleet worker's POST /knowledge (see NoteSource). */
function sourceOf(createdBy: string): NoteSource {
  return createdBy === VAULT_SYNC_AUTHOR ? "vault" : "agent";
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
 * Vault sync — the missing half of km-indexer.js. That process only ever
 * wrote to knowledge_embeddings; knowledge_note (this module's registry) was
 * never populated from the real on-disk vault, only from Hermes fleet
 * workers' own briefs (see NoteSource). This walks the real vault and keeps
 * knowledge_note in sync with it, without ever touching worker-authored rows.
 * ========================================================================== */

export interface VaultSyncResult {
  scanned: number;
  upserted: number;
  deleted: number;
  errors: number;
}

/** Full reconciliation pass: walk every .md file under VAULT_DIR, upsert its
 *  topic/tags/links (from frontmatter) into knowledge_note as a 'vault-sync'
 *  row, then delete any 'vault-sync' row whose file no longer exists. The
 *  DO UPDATE's WHERE guard means a hypothetical vault_path collision with a
 *  worker-authored row is left untouched rather than overwritten. */
export async function syncVaultNotes(): Promise<VaultSyncResult> {
  const entries = await readdir(VAULT_DIR, {
    withFileTypes: true,
    recursive: true,
  }).catch(() => []);

  const seenPaths: string[] = [];
  let upserted = 0;
  let errors = 0;

  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    // Node >=20.12 exposes parentPath; older releases used `path`.
    const parentAbs =
      (e as unknown as { parentPath?: string; path?: string }).parentPath ??
      (e as unknown as { path?: string }).path ??
      VAULT_DIR;
    const abs = path.join(parentAbs, e.name);
    const rel = path.relative(VAULT_DIR, abs).split(path.sep).join("/");
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;

    seenPaths.push(rel);
    try {
      const raw = await readFile(abs, "utf8");
      const { meta, body } = extractFrontmatter(raw);
      const wikilinks = extractWikilinks(body);
      const rawTags = meta.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags.map(String)
        : typeof rawTags === "string" && rawTags.trim()
          ? rawTags.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      const topic =
        typeof meta.title === "string" && meta.title.trim()
          ? meta.title.trim()
          : path.basename(rel, ".md").replace(/[_-]+/g, " ");

      await hcp.query(
        `INSERT INTO knowledge_note (topic, vault_path, tags, links, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (vault_path) DO UPDATE
             SET topic = EXCLUDED.topic, tags = EXCLUDED.tags, links = EXCLUDED.links
             WHERE knowledge_note.created_by = $5`,
        [topic, rel, tags, wikilinks, VAULT_SYNC_AUTHOR],
      );
      upserted++;
    } catch (err) {
      errors++;
      console.error(
        `[vault-sync] failed to index ${rel}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const del = await hcp.query(
    `DELETE FROM knowledge_note
       WHERE created_by = $1 AND NOT (vault_path = ANY($2::text[]))`,
    [VAULT_SYNC_AUTHOR, seenPaths],
  );

  return {
    scanned: seenPaths.length,
    upserted,
    deleted: del.rowCount ?? 0,
    errors,
  };
}

/* ============================================================================
 * Queries
 * ========================================================================== */

export interface NoteListPage {
  notes: NoteRow[];
  hasMore: boolean;
}

/** vault = real files indexed by syncVaultNotes(); agent = Hermes fleet
 *  worker briefs (POST /knowledge) — see NoteSource. Omit for both. */
function sourceWhere(source?: NoteSource): { clause: string; value: string | null } {
  if (source === "vault") return { clause: "created_by = $SOURCE", value: VAULT_SYNC_AUTHOR };
  if (source === "agent") return { clause: "created_by != $SOURCE", value: VAULT_SYNC_AUTHOR };
  return { clause: "TRUE", value: null };
}

/** List vault notes joined with a one-chunk preview from the embeddings
 *  store. Paged (fetches limit+1 to derive hasMore) — the vault only grows,
 *  so the caller should page rather than pull everything every time. */
export async function listMemoryPage(
  limit = 30,
  offset = 0,
  source?: NoteSource,
): Promise<NoteListPage> {
  const where = sourceWhere(source);
  const params: unknown[] = where.value !== null ? [where.value, limit + 1, offset] : [limit + 1, offset];
  const clause = where.value !== null ? where.clause.replace("$SOURCE", "$1") : where.clause;
  const limitIdx = where.value !== null ? 2 : 1;
  const noteResult = await hcp.query<{
    id: string;
    topic: string;
    vault_path: string;
    tags: string[];
    links: string[];
    created_by: string;
    created_at: string;
  }>(
    `SELECT id, topic, vault_path, tags, links, created_by, created_at::text
       FROM knowledge_note
       WHERE ${clause}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
    params,
  );
  const hasMore = noteResult.rows.length > limit;
  if (hasMore) noteResult.rows.length = limit;

  const notes = await notesWithPreview(noteResult.rows);
  return { notes, hasMore };
}

/* ============================================================================
 * Index health — the three-way reconciliation (02-architecture.md §1.4,
 * R12–R14). Pure classification lives in lib/index-health.ts; this half does
 * the I/O and NOTHING ELSE, so the rules stay testable without a database.
 *
 * NOTE ON THE FAMOUS "67-FILE GAP": it never existed. It was manufactured by
 * comparing 326 (a `find` over the vault that INCLUDED the 42 `.md` files in
 * `.trash`) against 259 (a `content_forge.knowledge_embeddings` figure). The
 * scan below excludes dot-directory segments exactly as syncVaultNotes() does
 * — that exclusion is what makes the honest number 284 rather than 326 — and
 * `.trash` is reported separately as `disk.excluded_trash`, never mixed into
 * the total.
 *
 * Every query here propagates its error. There is no `?? 0`, no `|| []` and no
 * catch that returns a default (R20/N1): a partial reconciliation reads as a
 * real gap and sends someone hunting a phantom for an afternoon, which is
 * precisely the failure this endpoint exists to end.
 * ========================================================================== */

interface IndexMeasurement {
  input: ReconcileInput;
  health: IndexHealth;
  /** `vault_path` of the non-`vault-sync` rows — a self-declared label rather
   *  than a path on disk (see NoteSource), kept for the folder rail. */
  agentPaths: string[];
}

/** Walk the vault, both registries and the embeddings store once, and fold the
 *  result. Shared by indexHealth() and noteCounts() so a single request never
 *  measures the same vault twice and never reports two different totals. */
async function measureIndex(): Promise<IndexMeasurement> {
  const measured_at = new Date().toISOString();

  // --- hcp.knowledge_note: one pass, split by author. vault_path carries a
  // UNIQUE constraint (see syncVaultNotes' ON CONFLICT), so path-set size and
  // row count are the same number by construction.
  const reg = await hcp.query<{ vault_path: string; created_by: string }>(
    `SELECT vault_path, created_by FROM knowledge_note`,
  );
  const vaultSyncPaths: string[] = [];
  const agentPaths: string[] = [];
  for (const row of reg.rows) {
    if (row.created_by === VAULT_SYNC_AUTHOR) vaultSyncPaths.push(row.vault_path);
    else agentPaths.push(row.vault_path);
  }

  // --- content_forge.knowledge_embeddings, scoped to real vault notes.
  // indexAgentMessages() also writes chunks under `worker-task://…` and
  // `agent-message://…` pseudo-URIs; counting those as "embedded vault files"
  // is how an index reports coverage it does not have.
  const embPaths = await cf.query<{ source_path: string }>(
    `SELECT DISTINCT source_path
       FROM knowledge_embeddings
       WHERE ${VAULT_SOURCE_PATH_SQL("source_path")}`,
  );
  const embChunks = await cf.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM knowledge_embeddings
       WHERE ${VAULT_SOURCE_PATH_SQL("source_path")}`,
  );
  const chunkCountRaw = embChunks.rows[0]?.count;
  if (chunkCountRaw === undefined) {
    throw new Error(
      "index-health: COUNT(*) over content_forge.knowledge_embeddings returned " +
        "no row — the query shape changed and a chunk total cannot be reported",
    );
  }
  const embeddingSet = new Set(embPaths.rows.map((r) => r.source_path));

  // --- disk. Same walk and the same dot-segment rule as syncVaultNotes(), so
  // `md_files` and `vault_sync_rows` are comparable numbers rather than two
  // different definitions of "the vault".
  const entries = await readdir(VAULT_DIR, {
    withFileTypes: true,
    recursive: true,
  });
  const relPaths: string[] = [];
  let excludedTrash = 0;
  const excludedOtherDot: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    // Node >=20.12 exposes parentPath; older releases used `path`.
    const parentAbs =
      (e as unknown as { parentPath?: string; path?: string }).parentPath ??
      (e as unknown as { path?: string }).path ??
      VAULT_DIR;
    const abs = path.join(parentAbs, e.name);
    const rel = path.relative(VAULT_DIR, abs).split(path.sep).join("/");
    const segments = rel.split("/");
    if (segments.some((seg) => seg.startsWith("."))) {
      if (segments.includes(".trash")) excludedTrash++;
      else excludedOtherDot.push(rel);
      continue;
    }
    relPaths.push(rel);
  }
  if (excludedOtherDot.length > 0) {
    // The envelope shape (02-architecture.md §1.4) has exactly one field for
    // dot-excluded files and it names `.trash`. Anything else excluded is
    // therefore uncounted, so it is named in the log rather than vanishing.
    console.warn(
      `[index-health] ${excludedOtherDot.length} .md file(s) excluded from a ` +
        `dot-directory other than .trash and reported in no field: ` +
        excludedOtherDot.slice(0, 10).join(", "),
    );
  }

  // Read the body only for the files that need the frontmatter_only decision:
  // on disk, absent from the embeddings index, non-empty, not a drawing. That
  // is a couple of dozen files, not 284 — the rest get `hasBody: null` and
  // reconcile() throws rather than guessing if it ever needs one.
  const files: DiskFile[] = [];
  for (const rel of relPaths) {
    const abs = path.join(VAULT_DIR, rel);
    const st = await stat(abs);
    const bytes = st.size;
    const needsBody =
      !embeddingSet.has(rel) &&
      bytes > 0 &&
      !rel.toLowerCase().endsWith(EXCLUDED_EXTENSION);
    const hasBody = needsBody
      ? extractFrontmatter(await readFile(abs, "utf8")).body.trim().length > 0
      : null;
    files.push({ path: rel, bytes, hasBody });
  }

  const input: ReconcileInput = {
    measured_at,
    disk: { files, excluded_trash: excludedTrash },
    registry: { vault_sync_paths: vaultSyncPaths, agent_rows: agentPaths.length },
    embeddings: {
      paths: [...embeddingSet],
      chunks: Number(chunkCountRaw),
    },
  };
  return { input, health: reconcile(input), agentPaths };
}

/** GET /api/memory/index-health. Throws on any store failure — never a
 *  partial or zeroed payload (R20). */
export async function indexHealth(): Promise<IndexHealth> {
  return (await measureIndex()).health;
}

/**
 * Delete embedding rows for the exact `source_path`s handed in — nothing else,
 * ever. Called from exactly ONE place: `POST /api/memory/index-health/prune`,
 * behind an explicit `{"confirm": true}`. Never from a tick, never on read,
 * never at startup (R14): an index that deletes its own rows on a schedule is
 * one bad mount away from deleting all of them.
 *
 * `pruned` = the distinct source_paths that actually had rows.
 * `count`   = embedding CHUNK rows removed (a file has many).
 */
export async function pruneStaleEmbeddingRows(
  paths: string[],
): Promise<{ pruned: string[]; count: number }> {
  if (paths.length === 0) return { pruned: [], count: 0 };
  const r = await cf.query<{ source_path: string }>(
    `DELETE FROM knowledge_embeddings
       WHERE source_path = ANY($1::text[])
       RETURNING source_path`,
    [paths],
  );
  return {
    pruned: [...new Set(r.rows.map((row) => row.source_path))].sort(),
    count: r.rows.length,
  };
}

/**
 * GET /api/memory/counts — the labelled envelope of 02-architecture.md §1.5
 * (R15–R17). Every top-level integer name states its unit and its source.
 *
 * The bare `all: 482` is GONE and is not replaced by a union: R15 requires
 * every top-level integer key to match /^(vault|agent|embedded|excluded|stale)_/
 * and `notes_all_sources` would violate it. The vault/agent split (284 real
 * files against 198 worker briefs) is the honest presentation.
 *
 * The five category chips are gone too. `inferCategory()` matches frontmatter
 * tags named rule/pref/person/project/fact; the vault's real tags are
 * `recurring`, `wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope`,
 * and only 65 of 284 notes carry any tag at all — so five of six chips were
 * structurally incapable of a non-zero number, and a filter that always
 * returns zero teaches the operator his vault is empty. `folder_counts`
 * replaces them, with `folder_rule` stating the derivation in the response.
 * `inferCategory()` itself stays: listMemoryPage() still returns a per-note
 * `category` the web list uses. Only this rail loses it.
 *
 * `source` scopes `folder_counts` only — the totals above it are absolute and
 * already labelled by source, so they never move.
 */
export async function noteCounts(source?: NoteSource): Promise<MemoryCounts> {
  const { input, health, agentPaths } = await measureIndex();

  const scope: MemoryCounts["source"] = source ?? "all";
  const folderPaths =
    scope === "vault"
      ? input.registry.vault_sync_paths
      : scope === "agent"
        ? agentPaths
        : [...input.registry.vault_sync_paths, ...agentPaths];
  const scopeLabel =
    scope === "vault"
      ? "hcp.knowledge_note rows where created_by = 'vault-sync'"
      : scope === "agent"
        ? "hcp.knowledge_note rows where created_by <> 'vault-sync' (worker " +
          "briefs — vault_path is a self-declared label, not a path on disk)"
        : "all hcp.knowledge_note rows (vault-sync files and worker briefs)";

  return {
    vault_files_on_disk: health.disk.md_files,
    vault_notes_indexed: health.registry.vault_sync_rows,
    agent_notes: health.registry.agent_rows,
    embedded_files: health.embeddings.files,
    embedded_chunks: health.embeddings.chunks,
    excluded: {
      excalidraw: countByReason(health, "excluded_extension"),
      empty: countByReason(health, "empty_file"),
      frontmatter_only: countByReason(health, "frontmatter_only"),
    },
    stale_embedding_rows: countByReason(health, "stale_row_file_missing"),
    measured_at: health.measured_at,
    source: scope,
    folder_counts: folderCounts(folderPaths),
    folder_rule: folderRule(scopeLabel),
  };
}

async function notesWithPreview(
  noteRows: {
    id: string;
    topic: string;
    vault_path: string;
    tags: string[];
    links: string[];
    created_by: string;
    created_at: string;
  }[],
): Promise<NoteRow[]> {
  // Only real vault files have embedded-chunk previews — agent briefs carry
  // their full text in `topic` itself (see shortTopic()) and have no rows
  // in knowledge_embeddings at all (indexAgentMessages() embeds raw
  // agent_message rows under an unrelated worker-task://… scheme).
  const vaultPaths = noteRows
    .filter((r) => sourceOf(r.created_by) === "vault")
    .map((r) => r.vault_path);
  const previews = new Map<string, string>();
  if (vaultPaths.length > 0) {
    const previewResult = await cf.query<{
      source_path: string;
      content: string;
    }>(
      `SELECT DISTINCT ON (source_path) source_path, content
         FROM knowledge_embeddings
         WHERE source_path = ANY($1::text[])
         ORDER BY source_path, chunk_index ASC`,
      [vaultPaths],
    );
    for (const row of previewResult.rows) {
      previews.set(row.source_path, row.content.slice(0, 240));
    }
  }

  return noteRows.map((r) => {
    const source = sourceOf(r.created_by);
    return {
      id: r.id,
      slug: slugify(r.vault_path),
      topic: source === "agent" ? shortTopic(r.topic) : r.topic,
      vault_path: r.vault_path,
      category: inferCategory(r.topic, r.tags ?? []),
      source,
      created_by: r.created_by,
      tags: r.tags ?? [],
      links: r.links ?? [],
      created_at: r.created_at,
      preview:
        source === "agent"
          ? r.topic.slice(0, 240)
          : (previews.get(r.vault_path) ?? ""),
    };
  });
}

/** A Hermes worker's brief has no title/body split — the worker POSTs the
 *  whole write-up as `topic` (it's a `text` column, no length limit). Derive
 *  a short display title from its first line so list rows don't render a
 *  wall of text; the full text is still used as the note body untouched. */
function shortTopic(full: string, max = 90): string {
  const firstLine = (full.split(/\r?\n/)[0] ?? full).trim();
  if (!firstLine) return full.slice(0, max);
  return firstLine.length > max ? `${firstLine.slice(0, max).trimEnd()}…` : firstLine;
}

/** Single note detail — reads the on-disk markdown for real vault notes;
 *  for Hermes fleet-worker briefs (no file ever existed, and — unlike real
 *  notes — no embeddings either, since indexAgentMessages() embeds raw
 *  agent_message rows under an unrelated worker-task://… URI scheme, not
 *  these self-declared vault_path labels) the full write-up already lives in
 *  `topic` itself. Joins backlinks either way.
 *
 *  slugify() only strips a trailing .md, so a vault-sync slug round-trips
 *  to `${slug}.md` — but an agent-authored vault_path never had .md to
 *  begin with (workers self-declare it, e.g. "tech/hcp/heartbeat-probe"),
 *  so the two forms must both be tried rather than assumed. */
export async function getMemory(slug: string): Promise<NoteDetail | null> {
  // Registry row, if it exists — tells us whether this is a real vault file
  // or an agent-authored brief, and gives us the exact vault_path to use
  // (never guess/reconstruct it — the two sources disagree on the .md
  // suffix).
  const registry = await hcp.query<{
    id: string;
    topic: string;
    tags: string[];
    links: string[];
    created_by: string;
    created_at: string;
    vault_path: string;
  }>(
    `SELECT id, topic, tags, links, created_by, created_at::text, vault_path
       FROM knowledge_note
       WHERE vault_path = $1 OR vault_path = $1 || '.md'
       LIMIT 1`,
    [slug],
  );
  const reg = registry.rows[0];
  // No registry row (e.g. a vault file created since the last sync tick) —
  // fall back to the vault-file assumption, same as before this fix.
  const vaultPath = reg?.vault_path ?? `${slug}.md`;
  const source: NoteSource = sourceOf(reg?.created_by ?? VAULT_SYNC_AUTHOR);

  let meta: Record<string, unknown> = {};
  let wikilinks: string[] = [];
  let body: string | null;
  if (source === "agent") {
    // reg is guaranteed here — sourceOf() only returns "agent" when reg
    // exists (the fallback default is VAULT_SYNC_AUTHOR → "vault").
    body = reg?.topic ?? null;
  } else {
    const raw = await safeReadVaultFile(vaultPath);
    if (raw !== null) {
      const parsed = extractFrontmatter(raw);
      meta = parsed.meta;
      body = parsed.body;
      wikilinks = extractWikilinks(body);
    } else {
      body = null;
    }
  }
  if (body === null) return null;

  const tags =
    reg?.tags ?? (Array.isArray(meta.tags) ? (meta.tags as string[]) : []);
  const links = reg?.links ?? wikilinks;
  const fullTopic = reg?.topic ?? slug.replace(/_/g, " ");
  const topic = source === "agent" ? shortTopic(fullTopic) : fullTopic;

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

  // Obsidian deep link (R25/R26). Agent briefs never reach obsidianUri() at
  // all — their vault_path names no file, so a link would open nothing.
  //
  // N1 ruling, deliberate: a VaultRefusedError out of obsidianUri() on a VAULT
  // note propagates and 500s the read. It can only fire on an empty vault name
  // or an empty path, and syncVaultNotes() cannot produce either — every row
  // it writes came from a real readdir entry. So that throw is a genuine
  // defect in the registry, not a malformed row to be tolerated, and
  // swallowing it would hand the UI a note that looks fine and has no link.
  const vault_name = vaultName();
  const obsidian_uri =
    source === "agent"
      ? null
      : obsidianUri({ vaultName: vault_name, vaultRelativePath: vaultPath });

  return {
    id: reg?.id ?? slug,
    slug,
    topic,
    vault_path: vaultPath,
    category: inferCategory(fullTopic, tags),
    source,
    created_by: reg?.created_by ?? VAULT_SYNC_AUTHOR,
    tags,
    links,
    created_at: reg?.created_at ?? new Date(0).toISOString(),
    preview: body.slice(0, 240),
    body,
    word_count: body.split(/\s+/).filter(Boolean).length,
    frontmatter: meta,
    wikilinks,
    backlinks,
    vault_name,
    obsidian_uri,
  };
}

export interface SearchOptions {
  /** Override the weighted-score cutoff. `0` disables the floor entirely —
   *  used by diagnostics that need to see what was rejected. */
  floor?: number;
  /** Override the per-source-note chunk cap. */
  maxPerNote?: number;
  /** Snippet length in characters. */
  snippetChars?: number;
}

/**
 * Semantic search over the vault using pgvector cosine on the HNSW index,
 * then re-ranked (see lib/memory-ranking.ts).
 *
 * The ANN pass over-fetches `limit × CANDIDATE_MULTIPLIER` rows because the
 * three corrections applied afterwards are all *subtractive*: at most two
 * chunks survive per note, and anything under the floor is discarded. Without
 * the over-fetch a query whose top 30 candidates are all one note would return
 * two results instead of a full page.
 */
export async function searchMemory(
  query: string,
  limit = 12,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const vec = await embedQuery(query);
  if (!vec) return [];

  const candidateLimit = Math.min(
    CANDIDATE_CAP,
    Math.max(limit, limit * CANDIDATE_MULTIPLIER),
  );
  const snippetChars = opts.snippetChars ?? 220;

  // halfvec literal: pgvector accepts a string '[v1,v2,...]' cast to halfvec.
  const literal = `[${vec.join(",")}]`;
  const r = await cf.query<{
    source_path: string;
    title: string;
    content: string;
    chunk_index: number;
    distance: number;
    chunk_count: number | null;
  }>(
    `SELECT source_path, title, content, chunk_index,
            (embedding <=> $1::halfvec) AS distance,
            NULLIF(metadata->>'chunk_count', '')::int AS chunk_count
       FROM knowledge_embeddings
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::halfvec
       LIMIT $2`,
    [literal, candidateLimit],
  );

  const candidates = r.rows.map((row) => ({
    source_path: row.source_path,
    chunk_index: row.chunk_index,
    score: 1 - row.distance, // cosine distance → similarity
    chunk_count: row.chunk_count ?? undefined,
    title: row.title,
    content: row.content,
  }));

  return rankCandidates(candidates, {
    limit,
    floor: opts.floor,
    maxPerNote: opts.maxPerNote,
  }).map((row) => ({
    slug: slugify(row.source_path),
    vault_path: row.source_path,
    title: row.title,
    snippet: row.content.slice(0, snippetChars),
    score: row.score,
    chunk_index: row.chunk_index,
    note_kind: row.explain.kind,
    explain: row.explain,
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

/* v1.7 phase 2 — closed ontology on knowledge_triples. The extractor asks
 * the LLM to pick one of these per triple; anything off-list collapses to
 * 'other'. Matches migration 0025's CHECK constraint. */
export const TRIPLE_CATEGORIES = [
  "decision",
  "rule",
  "error",
  "provider",
  "job",
  "format",
  "person",
  "other",
] as const;
export type TripleCategory = (typeof TRIPLE_CATEGORIES)[number];
const TRIPLE_CATEGORY_SET = new Set<string>(TRIPLE_CATEGORIES);

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
  category: TripleCategory;
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
below and emit a JSON array of {subject, predicate, object, category, confidence}
triples capturing factual relations.

Predicates: short and consistent (e.g. "deprecates", "replaces", "uses",
"owns", "rules-against", "located-in", "belongs-to", "decided-on"). Use
Title Case for proper nouns.

Category — pick EXACTLY one of the following for each triple based on what
the triple is about. If you can't tell, use "other".
  - decision  : a discrete choice the user made ("X over Y because Z")
  - rule      : a standing preference / policy ("never do X", "always Y")
  - error     : a known failure mode, bug, circuit-breaker tripped
  - provider  : an external service / API / pool (AI33, ElevenLabs, …)
  - job       : a content_jobs row or pipeline state
  - format    : a content format (CASUALLY_EXPLAINED, SPACE_VIDEO, …)
  - person    : Konrad, collaborators, fleet workers, anyone
  - other     : everything else

Confidence is 0.0-1.0. Reply with ONLY the JSON array, no preface, no
markdown fences.

Passage:
---
{TEXT}
---`;

/** Pool-level failure (HTTP non-2xx, empty body, transport error). Distinct
 *  from JSON-parse failures so the extractor's caller can react — most
 *  importantly, 429 rate limits should stop a bulk extraction batch rather
 *  than silently producing zero triples per chunk. */
export class TripleExtractorPoolError extends Error {
  status?: number;
  rateLimited: boolean;
  constructor(message: string, opts: { status?: number; rateLimited?: boolean } = {}) {
    super(message);
    this.name = "TripleExtractorPoolError";
    this.status = opts.status;
    this.rateLimited = opts.rateLimited ?? false;
  }
}

async function callPoolForJson(prompt: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${POOL_URL}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": POOL_KEY },
      body: JSON.stringify({ prompt, timeout_ms: 120_000 }),
    });
  } catch (e) {
    throw new TripleExtractorPoolError(
      `pool transport error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const j = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new TripleExtractorPoolError(
      `pool ${res.status}: ${j.error ?? res.statusText}`,
      { status: res.status, rateLimited: res.status === 429 },
    );
  }
  if (typeof j.text !== "string") {
    throw new TripleExtractorPoolError("pool returned no text");
  }
  // Strip trailing/leading whitespace and any accidental ``` fences.
  const body = j.text
    .trim()
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "");
  return JSON.parse(body);
}

/** Discriminated result for a single-chunk extraction.
 *  - `ok: true`  → triples extracted (possibly empty if the chunk genuinely
 *    has no facts the LLM could lift).
 *  - `ok: false` → either a pool failure (`poolFailure: true`, batch should
 *    consider stopping) or a parse failure (`poolFailure: false`, batch can
 *    keep going — that one chunk's pool response was malformed). */
export type ExtractionResult =
  | { ok: true; triples: Triple[] }
  | { ok: false; error: string; poolFailure: boolean; rateLimited?: boolean };

/** Extract triples for a single chunk via claude-pool. Errors are returned
 *  via the discriminated union — callers MUST distinguish pool failures
 *  (rate limits, 5xx, network) from parse failures so a flooded pool
 *  doesn't masquerade as "chunk had no triples". */
export async function extractTriplesFromChunk(
  text: string,
): Promise<ExtractionResult> {
  let raw: unknown;
  try {
    raw = await callPoolForJson(EXTRACTION_PROMPT.replace("{TEXT}", text));
  } catch (e) {
    if (e instanceof TripleExtractorPoolError) {
      console.error("[memory triples] pool failure:", e.message);
      return {
        ok: false,
        error: e.message,
        poolFailure: true,
        rateLimited: e.rateLimited,
      };
    }
    // JSON.parse blew up — pool replied, response is malformed. Don't
    // count this as a pool outage; the next chunk's response may parse
    // cleanly. Treat as parse failure.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[memory triples] parse failure:", msg);
    return { ok: false, error: msg, poolFailure: false };
  }
  if (!Array.isArray(raw)) {
    return { ok: true, triples: [] };
  }
  const out: Triple[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const subject = typeof r.subject === "string" ? r.subject.trim() : "";
    const predicate = typeof r.predicate === "string" ? r.predicate.trim() : "";
    const object = typeof r.object === "string" ? r.object.trim() : "";
    if (!subject || !predicate || !object) continue;
    const confidence =
      typeof r.confidence === "number" &&
      r.confidence >= 0 &&
      r.confidence <= 1
        ? r.confidence
        : undefined;
    // v1.7 phase 2: closed-set category, default 'other' on miss.
    const rawCat =
      typeof r.category === "string" ? r.category.trim().toLowerCase() : "";
    const category: TripleCategory = TRIPLE_CATEGORY_SET.has(rawCat)
      ? (rawCat as TripleCategory)
      : "other";
    out.push({ subject, predicate, object, category, confidence });
  }
  return { ok: true, triples: out };
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
      t.category, // v1.7 phase 2
    );
    const placeholders = Array.from(
      { length: 10 },
      (_, i) => `$${start + i}`,
    ).join(",");
    values.push(`(${placeholders})`);
  }
  const sql = `INSERT INTO knowledge_triples
                 (subject, predicate, object, subject_key, object_key,
                  note_slug, source_path, chunk_index, confidence, category)
               VALUES ${values.join(",")}
               ON CONFLICT (subject_key, predicate, object_key,
                            source_path, chunk_index) DO UPDATE
                 SET category = EXCLUDED.category`;
  const r = await cf.query(sql, params);
  return r.rowCount ?? 0;
}

/** After this many consecutive pool failures, the bulk extractor aborts
 *  the batch and surfaces the reason. Stops the cascading-no-op failure
 *  mode where every chunk in a batch hits a rate-limited pool. Tunable
 *  via env so a future cron job can pick a more permissive threshold. */
const EXTRACTOR_CIRCUIT_BREAKER_THRESHOLD = Number(
  process.env.EXTRACTOR_CIRCUIT_BREAKER_THRESHOLD ?? "3",
);

/** Per-batch counters surfaced in the API response so smoke scripts +
 *  the UI can tell "chunk had no facts" from "pool was down". */
export interface BatchExtractionStats {
  chunks: number;
  chunks_processed: number;
  triples: number;
  pool_failures: number;
  parse_failures: number;
  circuit_broken: boolean;
  errors: string[];
}

/** Run extraction for one note: re-embed-source-of-truth is chunks already
 *  indexed in knowledge_embeddings. Walks those chunks, calls the LLM per
 *  chunk, inserts triples. Matches by suffix so both vault notes (`%.md`)
 *  and other source layouts (`hermes://msg-…`) work — caller passes the
 *  filename or message id, we LIKE-match. */
export async function extractTriplesForNote(
  slug: string,
): Promise<BatchExtractionStats> {
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
  return runBatch(slug, r.rows);
}

/** Bulk extractor — walks the next N un-extracted chunks (any source) and
 *  persists triples. Idempotent; safe to re-run. Used as a one-shot warm-up
 *  endpoint before turning on the cron job. */
export async function extractTriplesNextBatch(
  limit = 20,
): Promise<BatchExtractionStats> {
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
  return runBatch(null, r.rows);
}

/** Shared batch loop: walks rows, calls the extractor, persists triples,
 *  tracks pool vs parse failures, trips a circuit breaker after N
 *  consecutive pool failures. */
async function runBatch(
  forcedSlug: string | null,
  rows: { source_path: string; chunk_index: number; content: string }[],
): Promise<BatchExtractionStats> {
  let triples = 0;
  let processed = 0;
  let poolFailures = 0;
  let parseFailures = 0;
  let consecutivePoolFailures = 0;
  const errors: string[] = [];
  let circuitBroken = false;

  for (const row of rows) {
    const result = await extractTriplesFromChunk(row.content);
    processed += 1;
    if (result.ok) {
      consecutivePoolFailures = 0;
      const slug = forcedSlug ?? slugify(row.source_path);
      const n = await upsertTriples(
        slug,
        row.source_path,
        row.chunk_index,
        result.triples,
      );
      triples += n;
      continue;
    }

    if (result.poolFailure) {
      poolFailures += 1;
      consecutivePoolFailures += 1;
      errors.push(
        `pool@${row.source_path}#${row.chunk_index}: ${result.error}`,
      );
      if (consecutivePoolFailures >= EXTRACTOR_CIRCUIT_BREAKER_THRESHOLD) {
        circuitBroken = true;
        console.error(
          `[memory triples] circuit-breaker tripped after ${consecutivePoolFailures} consecutive pool failures — aborting batch`,
        );
        break;
      }
    } else {
      parseFailures += 1;
      consecutivePoolFailures = 0;
      errors.push(
        `parse@${row.source_path}#${row.chunk_index}: ${result.error}`,
      );
    }
  }

  return {
    chunks: rows.length,
    chunks_processed: processed,
    triples,
    pool_failures: poolFailures,
    parse_failures: parseFailures,
    circuit_broken: circuitBroken,
    errors,
  };
}

/** Look up chunks that share at least one entity (subject_key OR object_key)
 *  with the seed set. Returns SearchHit shape so callers can merge with
 *  vector results. v1.7 phase 2: optional `category` filter narrows the
 *  walk to triples of that category only — lets the UI ask "expand only
 *  via decisions" or "only via errors". */
export async function neighborhoodHits(
  entities: Iterable<string>,
  excludePaths: string[],
  limit = 8,
  category?: TripleCategory,
  scoreCeiling = GRAPH_SCORE_MAX,
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
        WHERE (subject_key = ANY($1::text[]) OR object_key = ANY($1::text[]))
          AND ($4::text IS NULL OR category = $4)
          AND ${VAULT_SOURCE_PATH_SQL("source_path")}
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
    [keys, excludePaths, limit, category ?? null],
  );
  return r.rows.map((row) => ({
    slug: slugify(row.source_path),
    vault_path: row.source_path,
    title: row.title,
    snippet: row.content.slice(0, 220),
    // Synthetic — NOT a cosine similarity. Capped below the weakest vector hit
    // by the caller (see searchMemoryWithGraph) so an entity co-occurrence can
    // never outrank a genuine semantic match. The audit measured the old
    // uncapped formula landing at ~0.64 against real hits of 0.45–0.55.
    score: Math.min(scoreCeiling, 0.5 + Math.min(0.49, Number(row.hit_count) * 0.1)),
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

/* ---------------------------------------------------------------------------
 * Graph-lane gate — §4.C of the 2026-08-04 RAG audit.
 *
 * At audit time all 1,452 rows in knowledge_triples were extracted from
 * `hermes://` agent messages and `worker-task://` job JSON — zero came from a
 * vault note. The lane could therefore only ever surface June job-state noise,
 * and its synthetic score (0.5 + 0.1·n ≈ 0.64 after hop decay) outranked
 * genuine vector hits. Blending it into results was strictly harmful.
 *
 * Rather than delete the lane, gate it on the condition that made it noise:
 * it stays inert until triples exist that were extracted from real vault
 * notes. `MEMORY_GRAPH_LANE` overrides — "0" forces off, "1" forces on
 * (accepting synthetic hits), "auto" (default) applies the data condition.
 * ------------------------------------------------------------------------- */

const GRAPH_LANE_MODE = (process.env.MEMORY_GRAPH_LANE ?? "auto").toLowerCase();

/** Synthetic graph scores are additionally hard-capped here, so even a forced
 *  lane cannot present entity co-occurrence as a high-confidence match. */
const GRAPH_SCORE_MAX = Number(process.env.MEMORY_GRAPH_SCORE_MAX ?? "0.60");

/** SQL predicate: this source_path is a real vault note, not an agent-message
 *  or worker-task pseudo-URI. Both noise schemes carry a `://`. */
function VAULT_SOURCE_PATH_SQL(col: string): string {
  return `(${col} LIKE '%.md' AND ${col} NOT LIKE '%://%')`;
}

export interface GraphLaneStatus {
  enabled: boolean;
  mode: string;
  vault_triples: number;
  total_triples: number;
  reason: string;
}

let graphLaneCache: { at: number; status: GraphLaneStatus } | null = null;
const GRAPH_LANE_TTL_MS = 60_000;

/** Whether the GraphRAG lane may contribute to blended results right now.
 *  Cached for a minute — this runs on every expanded search and the answer
 *  only changes when a re-extraction batch lands. */
export async function graphLaneStatus(): Promise<GraphLaneStatus> {
  const now = Date.now();
  if (graphLaneCache && now - graphLaneCache.at < GRAPH_LANE_TTL_MS) {
    return graphLaneCache.status;
  }

  let vaultTriples = 0;
  let totalTriples = 0;
  try {
    const r = await cf.query<{ vault: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE ${VAULT_SOURCE_PATH_SQL("source_path")})::text AS vault,
              COUNT(*)::text AS total
         FROM knowledge_triples`,
    );
    vaultTriples = Number(r.rows[0]?.vault ?? "0");
    totalTriples = Number(r.rows[0]?.total ?? "0");
  } catch (e) {
    // A gate that fails open would reintroduce exactly the noise it exists to
    // suppress, so a broken count means "off", loudly.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[memory graph-lane] triple count failed — lane off:", msg);
    const status: GraphLaneStatus = {
      enabled: false,
      mode: GRAPH_LANE_MODE,
      vault_triples: 0,
      total_triples: 0,
      reason: `triple count failed: ${msg}`,
    };
    graphLaneCache = { at: now, status };
    return status;
  }

  let enabled: boolean;
  let reason: string;
  if (GRAPH_LANE_MODE === "0" || GRAPH_LANE_MODE === "off") {
    enabled = false;
    reason = "disabled by MEMORY_GRAPH_LANE";
  } else if (GRAPH_LANE_MODE === "1" || GRAPH_LANE_MODE === "on") {
    enabled = true;
    reason = "forced on by MEMORY_GRAPH_LANE";
  } else if (vaultTriples > 0) {
    enabled = true;
    reason = `${vaultTriples} vault-derived triples available`;
  } else {
    enabled = false;
    reason =
      totalTriples > 0
        ? `all ${totalTriples} triples are agent-message-derived — no vault triples yet`
        : "knowledge_triples is empty — re-extraction has not run";
  }

  const status: GraphLaneStatus = {
    enabled,
    mode: GRAPH_LANE_MODE,
    vault_triples: vaultTriples,
    total_triples: totalTriples,
    reason,
  };
  graphLaneCache = { at: now, status };
  return status;
}

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

/** Vector + N-hop GraphRAG expansion. v1.7 phase 2: when `category` is set,
 *  the graph walk only follows triples of that category — useful for
 *  "show me decisions about TTS" vs "show me errors about TTS". */
export async function searchMemoryWithGraph(
  query: string,
  opts: {
    vectorLimit?: number;
    graphLimit?: number;
    maxHops?: number;
    category?: TripleCategory;
    floor?: number;
    maxPerNote?: number;
    snippetChars?: number;
  } = {},
): Promise<SearchHitWithLane[]> {
  const vectorLimit = opts.vectorLimit ?? 8;
  const graphLimit = opts.graphLimit ?? 6;
  const maxHops = Math.max(0, Math.min(5, opts.maxHops ?? MAX_HOPS));
  // Spread the graph budget across hops; ceil so the first hop gets at least 1.
  const perHopBudget = Math.max(1, Math.ceil(graphLimit / Math.max(1, maxHops)));

  // Hop 0: vector hits.
  const vectorHits = await searchMemory(query, vectorLimit, {
    floor: opts.floor,
    maxPerNote: opts.maxPerNote,
    snippetChars: opts.snippetChars,
  });
  const vectorLane: SearchHitWithLane[] = vectorHits.map((h) => ({
    ...h,
    via: "vector",
    hop: 0,
  }));

  // Graph gate: until triples exist that came from real vault notes, every
  // graph hit is June agent-message noise. Return the vector lane alone.
  const lane = await graphLaneStatus();
  if (!lane.enabled) return vectorLane;

  // Synthetic scores are capped strictly below the weakest surviving vector
  // hit, so entity co-occurrence can supplement a result set but never
  // displace a semantic match — the inversion the audit measured.
  const weakestVector =
    vectorHits.length > 0
      ? vectorHits[vectorHits.length - 1].score
      : GRAPH_SCORE_MAX;
  const scoreCeiling = Math.min(GRAPH_SCORE_MAX, weakestVector - 0.01);

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
    const raw = await neighborhoodHits(
      entities,
      [...seenPaths],
      perHopBudget,
      opts.category,
      scoreCeiling,
    );
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

/* ============================================================================
 * The memory graph — built from hcp.knowledge_note.links (parsed [[wikilinks]]).
 *
 * WHY NOT knowledge_triples. Until 2026-08-19 this section exported
 * knowledgeGraph(), which selected from content_forge.knowledge_triples. That
 * table held 1 452 rows at the 2026-08-02 audit and holds 0 today, and NOTHING
 * REFILLS IT: the LLM extractor (extractTriplesNextBatch, above) is manual-only
 * and no tick calls it. GET /api/memory/graph therefore served
 * {"nodes":[],"links":[],"triples":0} for a week while the 3D component was
 * blamed for it (00-vision.md §2.2). Scheduling the extractor is an explicit
 * non-goal — an LLM pass over 2 131 chunks, recurring, to rebuild something the
 * vault already states in plain text.
 *
 * WHAT WE READ INSTEAD. hcp.knowledge_note.links is written by
 * extractWikilinks() inside syncVaultNotes() on the 5-minute vault-sync tick
 * (lib/vault-sync-tick.ts): deterministic, already fresh, zero marginal cost.
 * Measured 2026-08-19 on the live hcp database: 288 vault-sync rows, 122 of
 * them carrying at least one wikilink, 636 link entries in total.
 *
 * SCOPE: VAULT-SYNC ROWS ONLY, and that is a measurement rather than a taste.
 * The 198 agent-authored rows (NoteSource "agent" — a worker's brief, whose
 * vault_path is a self-declared label) do carry a `links` array, but 6 of 6
 * non-empty ones hold URLs, not wikilinks:
 *   hcp-worker-03 ops/runbooks/hcp-approve-publish-flow
 *     → {http://127.0.0.1:8650/approvals}
 * Feeding those into a wikilink graph would draw edges to hostnames and add
 * agent rows to the resolution index, where their self-declared vault_path
 * would be handed back to the UI as if it were a real file.
 * ========================================================================== */

/** One knowledge_note row, reduced to what the graph needs. Named separately
 *  from NoteRow because the pure builder below must be callable from a test
 *  with no database — see lib/memory-graph.test.ts. */
export interface WikilinkNoteRow {
  /** vault-relative path, WITH the .md suffix (as syncVaultNotes writes it). */
  vault_path: string;
  /** frontmatter `title`, else the filename with [_-]+ collapsed to spaces. */
  topic: string;
  /** raw [[targets]] as extractWikilinks() stored them; may be null in SQL. */
  links: string[] | null;
}

export interface WikilinkNode {
  /** Normalised key. For a node backed by a real note this is its slug
   *  (vault_path minus .md, lowercased) — unique, because two notes may share
   *  a basename. For a dangling target it is the normalised link text. */
  id: string;
  /** Display form: the note's topic when resolved, else the first-seen
   *  original casing of the link text. */
  label: string;
  /** Number of incident rendered edges. */
  degree: number;
  /** false ⇒ a wikilink target with no knowledge_note row behind it: a note
   *  Konrad meant to write. Kept as a node ON PURPOSE (R34) — dropping it
   *  makes the graph quietly under-report. */
  resolved: boolean;
  /** The real on-disk path, or null when `resolved` is false. */
  vault_path: string | null;
  /** Slugs of the notes this node appears in, capped at NODE_NOTES_CAP. */
  notes: string[];
}

export interface WikilinkLink {
  source: string;
  target: string;
  kind: "wikilink";
}

/** Every figure here is labelled on screen by MemoryGraph3D — a bare integer
 *  floating over a 3D scene is the defect this phase exists to remove.
 *
 *  Units, exactly:
 *   - notes_scanned      knowledge_note rows read (vault-sync only)
 *   - notes_with_links   of those, how many carried ≥1 non-empty link entry
 *   - links_total        edges IN `links` — i.e. what is actually drawn:
 *                        self-links removed, duplicate source→target collapsed
 *   - unresolved_targets nodes with resolved:false
 *   - self_links_dropped link entries pointing at their own note (including
 *                        bare `[[#Heading]]` anchors), skipped for rendering
 *                        but COUNTED here rather than silently discarded */
export interface WikilinkGraphCounts {
  notes_scanned: number;
  notes_with_links: number;
  links_total: number;
  unresolved_targets: number;
  self_links_dropped: number;
}

export interface WikilinkGraph {
  /** The literal table this graph was built from. R33 asserts this string. */
  source: "knowledge_note.links";
  nodes: WikilinkNode[];
  links: WikilinkLink[];
  counts: WikilinkGraphCounts;
  /** Non-null ONLY when `nodes` is empty, and then it names the table read,
   *  the rows found and what would refill them (R35). */
  empty_reason: string | null;
  measured_at: string;
}

/** Existing convention from the triples graph this replaces. */
const NODE_NOTES_CAP = 12;

/** Default edge ceiling. Measured against the live vault (636 link entries
 *  across 288 rows) this sits roughly 5× above the whole corpus, so the cap is
 *  a guard against a pathological vault, not a page. */
export const WIKILINK_GRAPH_MAX_LINKS = 3000;

/** Normalise one raw [[target]] to its lookup key.
 *
 *  Three artefacts of how the links were stored, all present in the live vault:
 *
 *  1. A HEADING OR BLOCK ANCHOR. `[[System - Software Stack#AI Services]]`
 *     targets the note, not a separate thing; Obsidian resolves the part before
 *     the `#`. A bare `[[#Heading]]` has nothing before it and is a link into
 *     the note's OWN body — it normalises to "" and the caller counts it as a
 *     self-link.
 *  2. A TRAILING BACKSLASH. Inside a markdown table an aliased link must be
 *     written `[[Target\|Alias]]` so the pipe is not read as a cell separator,
 *     and WIKILINK_RE's `[^\]|]+` capture keeps that escape: the stored target
 *     is "System - Remotion Rendering Pipeline\". Left alone, every wikilink in
 *     every table in the vault reads as dangling.
 *  3. CASE AND PADDING. Keys are compared lowercased and trimmed.
 *
 *  Deliberately NOT fixed upstream in extractWikilinks(): rewriting what
 *  syncVaultNotes stores would change note.links and the backlink query too,
 *  and would not take effect until the next tick re-wrote all 288 rows. The
 *  escape artefact is reported as a finding instead. */
export function normaliseWikilinkTarget(raw: string): string {
  const beforeAnchor = raw.split("#")[0];
  return beforeAnchor.replace(/\\+$/, "").trim().toLowerCase();
}

/** vault_path → slug key: drop the .md, lowercase. Uses slugify() so the graph
 *  and /api/memory/:slug cannot drift apart. */
function slugKey(vaultPath: string): string {
  return slugify(vaultPath).toLowerCase();
}

/** Last "/"-separated segment of a slug — the filename without .md. */
function basenameKey(vaultPath: string): string {
  const slug = slugify(vaultPath);
  const cut = slug.lastIndexOf("/");
  return (cut === -1 ? slug : slug.slice(cut + 1)).toLowerCase();
}

/** Shape the graph. PURE: no database, no clock unless you omit `measuredAt`,
 *  no I/O — so lib/memory-graph.test.ts can drive every branch from fixtures.
 *
 *  RESOLUTION (R34). A target resolves against a knowledge_note row by, in
 *  order of precedence:
 *    1. its slug   — the full vault_path minus .md. Required, not optional:
 *       the vault really does contain path-qualified links such as
 *       `[[30_YouTube/Plan for YouTube/System - OpenClaw AI Agent]]`, which no
 *       basename comparison can ever match.
 *    2. its topic  — frontmatter title, case-insensitively.
 *    3. its basename — filename minus .md, case-insensitively. Ambiguous when
 *       two folders hold the same filename; rows are sorted by vault_path in
 *       the query so first-wins is deterministic rather than whatever order
 *       Postgres felt like.
 *  Precedence 1 above 2/3 means a link that names an exact file always wins
 *  over a same-named note somewhere else.
 *
 *  A target that matches nothing becomes a node with resolved:false and
 *  vault_path:null. It is never dropped. */
export function buildWikilinkGraph(
  rows: WikilinkNoteRow[],
  options: { maxLinks?: number; measuredAt?: string } = {},
): WikilinkGraph {
  const maxLinks = options.maxLinks ?? WIKILINK_GRAPH_MAX_LINKS;
  const measured_at = options.measuredAt ?? new Date().toISOString();

  // ---- resolution index -------------------------------------------------
  // key → row. First writer wins, so precedence is expressed by filling the
  // three maps separately and consulting them in order.
  const bySlug = new Map<string, WikilinkNoteRow>();
  const byTopic = new Map<string, WikilinkNoteRow>();
  const byBasename = new Map<string, WikilinkNoteRow>();
  for (const row of rows) {
    const sk = slugKey(row.vault_path);
    if (!bySlug.has(sk)) bySlug.set(sk, row);
    const tk = row.topic.trim().toLowerCase();
    if (tk && !byTopic.has(tk)) byTopic.set(tk, row);
    const bk = basenameKey(row.vault_path);
    if (bk && !byBasename.has(bk)) byBasename.set(bk, row);
  }
  const resolve = (key: string): WikilinkNoteRow | undefined =>
    bySlug.get(key) ?? byTopic.get(key) ?? byBasename.get(key);

  // ---- accumulate -------------------------------------------------------
  const nodes = new Map<string, WikilinkNode>();
  const links: WikilinkLink[] = [];
  const seenEdge = new Set<string>();
  let notes_with_links = 0;
  let self_links_dropped = 0;

  /** Create-or-touch a node. `slug` is the note the edge was found in. */
  const touch = (
    id: string,
    label: string,
    row: WikilinkNoteRow | undefined,
    slug: string,
  ): void => {
    let n = nodes.get(id);
    if (!n) {
      n = {
        id,
        label,
        degree: 0,
        resolved: row !== undefined,
        vault_path: row?.vault_path ?? null,
        notes: [],
      };
      nodes.set(id, n);
    }
    n.degree += 1;
    if (n.notes.length < NODE_NOTES_CAP && !n.notes.includes(slug)) {
      n.notes.push(slug);
    }
  };

  for (const row of rows) {
    const entries = (row.links ?? []).filter(
      (l) => typeof l === "string" && l.trim() !== "",
    );
    if (entries.length > 0) notes_with_links += 1;

    const sourceId = slugKey(row.vault_path);
    const sourceSlug = slugify(row.vault_path);

    for (const raw of entries) {
      const key = normaliseWikilinkTarget(raw);
      // "" ⇐ a bare [[#Heading]] anchor: a link into this note's own body.
      if (key === "" || key === sourceId) {
        self_links_dropped += 1;
        continue;
      }
      const target = resolve(key);
      const targetId = target ? slugKey(target.vault_path) : key;
      if (targetId === sourceId) {
        // Resolved back to the linking note itself (e.g. [[Topic]] where Topic
        // is this note's own title). Same edge, same reason to skip it.
        self_links_dropped += 1;
        continue;
      }
      const edgeKey = `${sourceId}→${targetId}`;
      if (seenEdge.has(edgeKey)) continue;
      if (links.length >= maxLinks) continue;
      seenEdge.add(edgeKey);

      touch(sourceId, row.topic, row, sourceSlug);
      touch(
        targetId,
        target ? target.topic : raw.replace(/\\+$/, "").trim(),
        target,
        sourceSlug,
      );
      links.push({ source: sourceId, target: targetId, kind: "wikilink" });
    }
  }

  const nodeList = [...nodes.values()];
  const counts: WikilinkGraphCounts = {
    notes_scanned: rows.length,
    notes_with_links,
    links_total: links.length,
    unresolved_targets: nodeList.filter((n) => !n.resolved).length,
    self_links_dropped,
  };

  // R35: an empty graph must never leave the operator guessing which store was
  // read. The week this endpoint cost was spent looking at a React component
  // because the response said nothing about the table behind it.
  const empty_reason =
    nodeList.length === 0
      ? `read hcp.knowledge_note.links: ${counts.notes_scanned} vault-sync rows scanned, ` +
        `${counts.notes_with_links} carried a wikilink, ${counts.self_links_dropped} self-link(s) dropped — ` +
        `no renderable node. hcp.knowledge_note.links is refilled by syncVaultNotes() in ` +
        `forge-control/src/db/memory.ts on the 5-minute vault-sync tick (lib/vault-sync-tick.ts); ` +
        `a vault whose notes contain no [[wikilinks]] yields an empty graph and that is not an error. ` +
        `content_forge.knowledge_triples is NOT read by this endpoint any more.`
      : null;

  return {
    source: "knowledge_note.links",
    nodes: nodeList,
    links,
    counts,
    empty_reason,
    measured_at,
  };
}

/** GET /api/memory/graph's data source.
 *
 *  N1: no catch-and-default. If the query fails this THROWS and the route
 *  answers 5xx with the message. A zeroed graph is indistinguishable from a
 *  real empty graph, and chasing that phantom is the week this function exists
 *  to save. */
export async function wikilinkGraph(
  maxLinks = WIKILINK_GRAPH_MAX_LINKS,
): Promise<WikilinkGraph> {
  const r = await hcp.query<WikilinkNoteRow>(
    `SELECT vault_path, topic, links
       FROM knowledge_note
       WHERE created_by = $1
       ORDER BY vault_path`,
    [VAULT_SYNC_AUTHOR],
  );
  return buildWikilinkGraph(r.rows, { maxLinks });
}
