import { Hono } from "hono";
import pg from "pg";
import { searchMemory, type SearchHit } from "../db/memory.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (e) => console.error("[search pool]", e.message));

const r = new Hono();

/**
 * Routing hypervisor — runs the same query through every engine that can
 * answer it and returns one set of grouped, source-tagged hits.
 *
 *  vault   — semantic vector search via knowledge_embeddings (pgvector cosine)
 *  inbox   — ILIKE over open inbox_items.title + ask
 *  runs    — ILIKE over runs.title + prompt
 *  jobs    — ILIKE over content_jobs.title
 *  decisions — ILIKE over decisions.action
 *
 * Per-source counts let the UI render a "via vector / via sql" line per
 * group. The frontend ranks across engines; we don't merge into one list.
 */

interface InboxHit {
  id: string;
  title: string;
  type: string;
  status: string;
}
interface RunHit {
  id: string;
  title: string;
  status: string;
}
interface JobHit {
  id: string;
  title: string;
  status: string;
}
interface DecisionHit {
  id: string;
  ts: string;
  kind: string;
  action: string;
}

async function sqlSearch(q: string): Promise<{
  inbox: InboxHit[];
  runs: RunHit[];
  jobs: JobHit[];
  decisions: DecisionHit[];
}> {
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const [inbox, runs, jobs, decisions] = await Promise.all([
    pool
      .query<InboxHit>(
        `SELECT id::text, title, type, status
         FROM inbox_items
         WHERE resolved_at IS NULL
           AND (title ILIKE $1 OR ask ILIKE $1)
         ORDER BY created_at DESC
         LIMIT 8`,
        [like],
      )
      .then((r) => r.rows)
      .catch(() => [] as InboxHit[]),
    pool
      .query<RunHit>(
        `SELECT id::text, title, status
         FROM runs
         WHERE title ILIKE $1 OR prompt ILIKE $1
         ORDER BY created_at DESC
         LIMIT 8`,
        [like],
      )
      .then((r) => r.rows)
      .catch(() => [] as RunHit[]),
    pool
      .query<JobHit>(
        `SELECT id::text, title, status::text
         FROM content_jobs
         WHERE title ILIKE $1
         ORDER BY created_at DESC
         LIMIT 8`,
        [like],
      )
      .then((r) => r.rows)
      .catch(() => [] as JobHit[]),
    pool
      .query<DecisionHit>(
        `SELECT id::text, ts::text, kind, action
         FROM decisions
         WHERE action ILIKE $1
         ORDER BY ts DESC
         LIMIT 8`,
        [like],
      )
      .then((r) => r.rows)
      .catch(() => [] as DecisionHit[]),
  ]);
  return { inbox, runs, jobs, decisions };
}

r.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ q, groups: [], engines: [] }, 400);

  const [vault, sql] = await Promise.all([searchMemory(q, 10), sqlSearch(q)]);

  const groups = [
    {
      key: "vault",
      label: "Vault",
      engine: "pgvector",
      engine_label: "vector · cosine",
      rows: vault.map((h: SearchHit) => ({
        icon: "description",
        title: h.title,
        meta: `Vault · score ${h.score.toFixed(2)}`,
        snippet: h.snippet,
        nav: { surface: "memory", slug: h.slug },
      })),
    },
    {
      key: "inbox",
      label: "Inbox",
      engine: "sql",
      engine_label: "sql · ilike",
      rows: sql.inbox.map((h) => ({
        icon: "inbox",
        title: h.title,
        meta: `${h.type} · ${h.status}`,
        nav: { surface: "inbox", id: h.id },
      })),
    },
    {
      key: "runs",
      label: "Runs",
      engine: "sql",
      engine_label: "sql · ilike",
      rows: sql.runs.map((h) => ({
        icon: "conveyor_belt",
        title: h.title,
        meta: `run · ${h.status}`,
        nav: { surface: "tasks", id: h.id },
      })),
    },
    {
      key: "jobs",
      label: "Jobs",
      engine: "sql",
      engine_label: "sql · ilike",
      rows: sql.jobs.map((h) => ({
        icon: "table_rows",
        title: h.title,
        meta: `job · ${h.status}`,
        nav: { surface: "pipeline", id: h.id },
      })),
    },
    {
      key: "decisions",
      label: "Decisions",
      engine: "sql",
      engine_label: "sql · ilike",
      rows: sql.decisions.map((h) => ({
        icon: "gavel",
        title: h.action,
        meta: `${h.kind} · ${h.ts}`,
        nav: { surface: "control", id: h.id },
      })),
    },
  ].filter((g) => g.rows.length > 0);

  const engines = [
    {
      key: "vector",
      name: "Vector DB",
      impl: "pgvector · cosine",
      hits: vault.length,
    },
    {
      key: "sql",
      name: "SQL engine",
      impl: "postgres · ilike",
      hits:
        sql.inbox.length +
        sql.runs.length +
        sql.jobs.length +
        sql.decisions.length,
    },
  ];

  return c.json({
    q,
    count: groups.reduce((s, g) => s + g.rows.length, 0),
    groups,
    engines,
  });
});

export default r;
