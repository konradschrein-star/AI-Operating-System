/**
 * Runs (chat threads + agent tasks) data access.
 *
 * Schema lives in content_forge.runs (migration 0021):
 *   id uuid, title text, prompt text, worker varchar(64),
 *   status (queued|running|paused|stuck|completed|failed|cancelled),
 *   thread jsonb (array of {role, content, ts, kind?, meta?}),
 *   budget_usd numeric, spent_usd numeric,
 *   parent_run_id uuid, stuck_signal varchar(64), metadata jsonb,
 *   created_at, updated_at, started_at, completed_at, last_heartbeat_at
 */

import pg from "pg";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (e) => console.error("[runs pool]", e.message));

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "stuck"
  | "completed"
  | "failed"
  | "cancelled";

export interface ThreadEntry {
  role: "user" | "assistant" | "system" | "tool" | "agent";
  content: string;
  ts: string;
  kind?: "text" | "tool_call" | "tool_result" | "heartbeat" | "error";
  meta?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  worker: string | null;
  budget_usd: string;
  spent_usd: string;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  message_count: number;
  last_message_preview: string;
  last_role: string;
}

export interface RunDetail extends RunSummary {
  prompt: string;
  thread: ThreadEntry[];
  metadata: Record<string, unknown>;
  parent_run_id: string | null;
  stuck_signal: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function previewOf(thread: ThreadEntry[]): {
  text: string;
  role: string;
} {
  if (!Array.isArray(thread) || thread.length === 0) {
    return { text: "", role: "" };
  }
  const last = thread[thread.length - 1];
  const text = (last.content ?? "")
    .toString()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return { text, role: last.role ?? "" };
}

export async function listRuns(limit = 80): Promise<RunSummary[]> {
  const r = await pool.query<{
    id: string;
    title: string;
    status: RunStatus;
    worker: string | null;
    budget_usd: string;
    spent_usd: string;
    created_at: string;
    updated_at: string;
    last_heartbeat_at: string | null;
    thread: ThreadEntry[];
  }>(
    `SELECT id::text, title, status, worker, budget_usd::text, spent_usd::text,
            created_at::text, updated_at::text, last_heartbeat_at::text, thread
       FROM runs
       ORDER BY updated_at DESC
       LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => {
    const pv = previewOf(row.thread ?? []);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      worker: row.worker,
      budget_usd: row.budget_usd,
      spent_usd: row.spent_usd,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_heartbeat_at: row.last_heartbeat_at,
      message_count: Array.isArray(row.thread) ? row.thread.length : 0,
      last_message_preview: pv.text,
      last_role: pv.role,
    };
  });
}

export async function getRun(id: string): Promise<RunDetail | null> {
  const r = await pool.query<{
    id: string;
    title: string;
    prompt: string;
    status: RunStatus;
    worker: string | null;
    budget_usd: string;
    spent_usd: string;
    thread: ThreadEntry[];
    metadata: Record<string, unknown>;
    parent_run_id: string | null;
    stuck_signal: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
    last_heartbeat_at: string | null;
  }>(
    `SELECT id::text, title, prompt, status, worker, budget_usd::text, spent_usd::text,
            thread, metadata, parent_run_id::text AS parent_run_id,
            stuck_signal, created_at::text, updated_at::text,
            started_at::text, completed_at::text, last_heartbeat_at::text
       FROM runs
       WHERE id = $1
       LIMIT 1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const pv = previewOf(row.thread ?? []);
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    worker: row.worker,
    budget_usd: row.budget_usd,
    spent_usd: row.spent_usd,
    thread: row.thread ?? [],
    metadata: row.metadata ?? {},
    parent_run_id: row.parent_run_id,
    stuck_signal: row.stuck_signal,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_heartbeat_at: row.last_heartbeat_at,
    message_count: Array.isArray(row.thread) ? row.thread.length : 0,
    last_message_preview: pv.text,
    last_role: pv.role,
  };
}

export async function createRun(input: {
  title: string;
  prompt: string;
  worker?: string;
  budget_usd?: number;
  metadata?: Record<string, unknown>;
}): Promise<RunDetail> {
  const seed: ThreadEntry[] = [
    {
      role: "user",
      content: input.prompt,
      ts: new Date().toISOString(),
      kind: "text",
    },
  ];
  const r = await pool.query<{ id: string }>(
    `INSERT INTO runs (title, prompt, worker, status, thread, budget_usd, metadata)
     VALUES ($1, $2, $3, 'queued', $4::jsonb, $5, $6::jsonb)
     RETURNING id::text`,
    [
      input.title.slice(0, 200),
      input.prompt,
      input.worker ?? null,
      JSON.stringify(seed),
      input.budget_usd ?? 0,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const run = await getRun(r.rows[0].id);
  if (!run) throw new Error("run created but read-back failed");
  return run;
}

/** Most recent non-terminal run from a given source (e.g. 'telegram') inside
 *  a freshness window. The telegram bridge uses this to decide whether a
 *  plain message continues the active thread or starts a new one. */
export async function findActiveRunBySource(
  source: string,
  windowHours: number,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text FROM runs
      WHERE metadata->>'source' = $1
        AND status NOT IN ('cancelled', 'failed')
        AND updated_at > now() - ($2 || ' hours')::interval
      ORDER BY updated_at DESC
      LIMIT 1`,
    [source, String(windowHours)],
  );
  if (!r.rows[0]) return null;
  return getRun(r.rows[0].id);
}

export async function appendMessage(
  id: string,
  entry: ThreadEntry,
  opts: { setStatus?: RunStatus } = {},
): Promise<RunDetail | null> {
  const newStatus = opts.setStatus;
  const sql = newStatus
    ? `UPDATE runs
         SET thread = thread || $2::jsonb,
             status = $3,
             updated_at = now()
       WHERE id = $1
       RETURNING id::text`
    : `UPDATE runs
         SET thread = thread || $2::jsonb,
             updated_at = now()
       WHERE id = $1
       RETURNING id::text`;
  const params: unknown[] = [id, JSON.stringify([entry])];
  if (newStatus) params.push(newStatus);
  const r = await pool.query<{ id: string }>(sql, params);
  if (r.rowCount === 0) return null;
  return getRun(id);
}

/** Set (or clear with null) metadata.model — the engine model override. */
export async function setRunModel(
  id: string,
  model: string | null,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    model === null
      ? `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) - 'model',
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`
      : `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                         jsonb_build_object('model', $2::text),
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`,
    model === null ? [id] : [id, model],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

export async function setRunStatus(
  id: string,
  status: RunStatus,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    `UPDATE runs SET status = $2, updated_at = now() WHERE id = $1 RETURNING id::text`,
    [id, status],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

export async function runCounts(): Promise<Record<RunStatus, number>> {
  const r = await pool.query<{ status: RunStatus; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM runs GROUP BY status`,
  );
  const out: Record<RunStatus, number> = {
    queued: 0,
    running: 0,
    paused: 0,
    stuck: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of r.rows) out[row.status] = Number(row.count);
  return out;
}
