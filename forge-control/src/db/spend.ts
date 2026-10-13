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
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

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

export interface SpendWindow {
  /** Real spend — every provider except claude-code (flat-rate subscription). */
  total_eur: number;
  calls: number;
  /** claude-code shadow price: what the tokens would've cost on metered API
   *  pricing. Not billed — surfaced separately so it never inflates total_eur
   *  and spikes anyone's blood pressure reading the headline number. */
  claude_eur: number;
  claude_calls: number;
}

export interface SpendSummary {
  today: SpendWindow;
  d7: SpendWindow;
  d30: SpendWindow;
  /** Per provider×kind over the last 30 days, sorted desc by total. */
  by_area: Array<{
    provider: string;
    kind: string;
    total_eur: number;
    calls: number;
    units: number;
  }>;
  /** UTC-day series over the last 30 days, ascending, gap days omitted. */
  daily: Array<{ day: string; total_eur: number; calls: number }>;
}

/** The Money surface's one query fan-out: window totals, provider×kind
 *  breakdown, and a daily series — all over a 30-day horizon. today uses
 *  the UTC day boundary (consistent with todaySpendRollup); d7/d30 are
 *  rolling windows. */
export async function spendSummary(): Promise<SpendSummary> {
  const windows = await pool.query<{
    today_eur: string;
    today_calls: string;
    today_claude_eur: string;
    today_claude_calls: string;
    d7_eur: string;
    d7_calls: string;
    d7_claude_eur: string;
    d7_claude_calls: string;
    d30_eur: string;
    d30_calls: string;
    d30_claude_eur: string;
    d30_claude_calls: string;
  }>(
    `SELECT
       COALESCE(SUM(amount_eur) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND provider <> 'claude-code'), 0)::text AS today_eur,
       COUNT(*)   FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND provider <> 'claude-code')::text        AS today_calls,
       COALESCE(SUM(amount_eur) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND provider = 'claude-code'), 0)::text AS today_claude_eur,
       COUNT(*)   FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND provider = 'claude-code')::text        AS today_claude_calls,
       COALESCE(SUM(amount_eur) FILTER (WHERE created_at >= now() - interval '7 days' AND provider <> 'claude-code'), 0)::text  AS d7_eur,
       COUNT(*)   FILTER (WHERE created_at >= now() - interval '7 days' AND provider <> 'claude-code')::text                    AS d7_calls,
       COALESCE(SUM(amount_eur) FILTER (WHERE created_at >= now() - interval '7 days' AND provider = 'claude-code'), 0)::text  AS d7_claude_eur,
       COUNT(*)   FILTER (WHERE created_at >= now() - interval '7 days' AND provider = 'claude-code')::text                    AS d7_claude_calls,
       COALESCE(SUM(amount_eur) FILTER (WHERE provider <> 'claude-code'), 0)::text AS d30_eur,
       COUNT(*)   FILTER (WHERE provider <> 'claude-code')::text                   AS d30_calls,
       COALESCE(SUM(amount_eur) FILTER (WHERE provider = 'claude-code'), 0)::text AS d30_claude_eur,
       COUNT(*)   FILTER (WHERE provider = 'claude-code')::text                   AS d30_claude_calls
     FROM spend_log
     WHERE created_at >= now() - interval '30 days'`,
  );
  const byArea = await pool.query<{
    provider: string;
    kind: string;
    total_eur: string;
    calls: string;
    units: string;
  }>(
    `SELECT provider, kind,
            COALESCE(SUM(amount_eur), 0)::text AS total_eur,
            COUNT(*)::text                     AS calls,
            COALESCE(SUM(units), 0)::text      AS units
       FROM spend_log
      WHERE created_at >= now() - interval '30 days'
      GROUP BY provider, kind
      ORDER BY SUM(amount_eur) DESC, COUNT(*) DESC`,
  );
  const daily = await pool.query<{
    day: string;
    total_eur: string;
    calls: string;
  }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            COALESCE(SUM(amount_eur), 0)::text AS total_eur,
            COUNT(*)::text                     AS calls
       FROM spend_log
      WHERE created_at >= now() - interval '30 days'
        AND provider <> 'claude-code'
      GROUP BY 1
      ORDER BY 1`,
  );

  const w = windows.rows[0];
  return {
    today: {
      total_eur: Number(w?.today_eur ?? "0"),
      calls: Number(w?.today_calls ?? "0"),
      claude_eur: Number(w?.today_claude_eur ?? "0"),
      claude_calls: Number(w?.today_claude_calls ?? "0"),
    },
    d7: {
      total_eur: Number(w?.d7_eur ?? "0"),
      calls: Number(w?.d7_calls ?? "0"),
      claude_eur: Number(w?.d7_claude_eur ?? "0"),
      claude_calls: Number(w?.d7_claude_calls ?? "0"),
    },
    d30: {
      total_eur: Number(w?.d30_eur ?? "0"),
      calls: Number(w?.d30_calls ?? "0"),
      claude_eur: Number(w?.d30_claude_eur ?? "0"),
      claude_calls: Number(w?.d30_claude_calls ?? "0"),
    },
    by_area: byArea.rows.map((r) => ({
      provider: r.provider,
      kind: r.kind,
      total_eur: Number(r.total_eur),
      calls: Number(r.calls),
      units: Number(r.units),
    })),
    daily: daily.rows.map((r) => ({
      day: r.day,
      total_eur: Number(r.total_eur),
      calls: Number(r.calls),
    })),
  };
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
