import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[forge pg pool error]", err.message);
});

export interface JobSummary {
  id: string;
  status: string;
  format: string;
  title: string;
  production_version: string;
  channel_id: string;
  template_id: string;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  status_updated_at: string;
  published_at: string | null;
  render_started_at: string | null;
  render_completed_at: string | null;
  total_render_time_seconds: number | null;
  final_video_size_bytes: number | null;
  final_video_duration_seconds: number | null;
  assigned_production_va_id: string | null;
  assigned_uploader_va_id: string | null;
  youtube_video_id: string | null;
  views: number | null;
}

const SUMMARY_COLS = `
  id, status, format, title, production_version, channel_id, template_id,
  retry_count, error_message,
  created_at, updated_at, status_updated_at, published_at,
  render_started_at, render_completed_at, total_render_time_seconds,
  final_video_size_bytes, final_video_duration_seconds,
  assigned_production_va_id, assigned_uploader_va_id,
  youtube_video_id, views
`;

// "Active" = anything not in a terminal state. Robust to future enum additions.
const TERMINAL_STATUSES = ["PUBLISHED", "MARKED_FOR_DELETION"];

export async function listActiveJobs(limit = 100): Promise<JobSummary[]> {
  const r = await pool.query<JobSummary>(
    `SELECT ${SUMMARY_COLS} FROM content_jobs
     WHERE status::text <> ALL($1::text[])
     ORDER BY status_updated_at DESC
     LIMIT $2`,
    [TERMINAL_STATUSES, limit],
  );
  return r.rows;
}

export async function listRecentJobs(limit = 50): Promise<JobSummary[]> {
  const r = await pool.query<JobSummary>(
    `SELECT ${SUMMARY_COLS} FROM content_jobs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function jobsByStatus(): Promise<
  { status: string; count: number }[]
> {
  const r = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
     FROM content_jobs
     GROUP BY status
     ORDER BY COUNT(*) DESC`,
  );
  return r.rows.map((row) => ({
    status: row.status,
    count: Number(row.count),
  }));
}

export async function getJob(
  id: string,
): Promise<Record<string, unknown> | null> {
  const r = await pool.query(`SELECT * FROM content_jobs WHERE id = $1::uuid`, [
    id,
  ]);
  return r.rows[0] ?? null;
}

export async function pingPostgres(): Promise<{
  ok: boolean;
  latency_ms: number;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message };
  }
}
