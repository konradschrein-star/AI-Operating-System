/**
 * Spend log data access.
 *
 * Gateways (fastgen, tts, claude-pool, forge-api, etc.) POST rows to
 * /api/spend after each billable upstream call. Today screen + autonomy
 * guardrail read the daily rollup from here.
 *
 * Schema: db/migrations/0026_spend_log.sql.
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[spend pg pool error]", err.message);
});

export type SpendKind =
  | "image"
  | "tts"
  | "llm_input"
  | "llm_output"
  | "video"
  | "music"
  | "embedding";

export interface SpendRow {
  provider: string;
  kind: SpendKind;
  amount_eur: number;
  job_id?: string | null;
  units?: number | null;
  meta?: Record<string, unknown>;
}

export interface DailySpendRollup {
  /** Sum of today's amount_eur across all providers. */
  total_eur: number;
  /** Number of rows logged today. Distinguishes "no spend" from "untracked". */
  row_count: number;
  /** Per-provider breakdown, sorted desc by total. */
  by_provider: Array<{ provider: string; total_eur: number; rows: number }>;
}

/** Insert one or more rows. Batched single SQL when >1 to minimize round
 *  trips at high gateway throughput. Returns the inserted row count. */
export async function recordSpend(rows: SpendRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const params: unknown[] = [];
  const values: string[] = [];
  for (const r of rows) {
    const start = params.length + 1;
    params.push(
      r.provider,
      r.kind,
      r.amount_eur,
      r.job_id ?? null,
      r.units ?? null,
      JSON.stringify(r.meta ?? {}),
    );
    const placeholders = Array.from(
      { length: 6 },
      (_, i) => `$${start + i}`,
    ).join(",");
    values.push(`(${placeholders})`);
  }
  const sql = `INSERT INTO spend_log (provider, kind, amount_eur, job_id, units, meta)
               VALUES ${values.join(",")}`;
  const r = await pool.query(sql, params);
  return r.rowCount ?? 0;
}

/** Sum + breakdown of today's spend in UTC. UTC chosen because gateways
 *  run on VPS time and the cap is a daily reset, not a tz-localized total.
 *  Always returns a row, even when there's nothing logged yet. */
export async function todaySpendRollup(): Promise<DailySpendRollup> {
  const totals = await pool.query<{ total_eur: string; row_count: string }>(
    `SELECT COALESCE(SUM(amount_eur), 0)::text AS total_eur,
            COUNT(*)::text AS row_count
       FROM spend_log
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
                          AT TIME ZONE 'UTC'`,
  );
  const byProvider = await pool.query<{
    provider: string;
    total_eur: string;
    rows: string;
  }>(
    `SELECT provider,
            COALESCE(SUM(amount_eur), 0)::text AS total_eur,
            COUNT(*)::text AS rows
       FROM spend_log
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
                          AT TIME ZONE 'UTC'
      GROUP BY provider
      ORDER BY SUM(amount_eur) DESC`,
  );

  return {
    total_eur: Number(totals.rows[0]?.total_eur ?? "0"),
    row_count: Number(totals.rows[0]?.row_count ?? "0"),
    by_provider: byProvider.rows.map((r) => ({
      provider: r.provider,
      total_eur: Number(r.total_eur),
      rows: Number(r.rows),
    })),
  };
}
