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
  /** Metered out-of-pocket spend today — every provider except claude-code. */
  total_eur: number;
  /** claude-code shadow price today: notional, not billed. Never add this to
   *  total_eur — it is a flat-rate subscription, not metered spend, and
   *  folding it in is what let it trip the €50 daily cap before. */
  shadow_eur: number;
  /** Number of rows logged today, across all providers. Distinguishes
   *  "no spend" from "untracked". */
  row_count: number;
  /** Per-provider breakdown (all providers, including claude-code), sorted
   *  desc by total. */
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
  /** Per provider×kind over the requested horizon, sorted desc by total. */
  by_area: Array<{
    provider: string;
    kind: string;
    total_eur: number;
    calls: number;
    units: number;
  }>;
  /** UTC-day series over the requested horizon, ascending, gap days omitted.
   *  total_eur is metered spend (excludes claude-code), shadow_eur is the
   *  claude-code notional price, total_compute_eur is their sum — the one
   *  figure that answers "how much compute ran", never itself a cash total. */
  daily: Array<{
    day: string;
    total_eur: number;
    shadow_eur: number;
    total_compute_eur: number;
    calls: number;
  }>;
  /** What the caller could have picked and what it did pick. `providers` and
   *  `kinds` are the UNFILTERED distinct sets over the horizon, so a UI can
   *  build its dropdowns from the same response that answers the query —
   *  filtering to `gemini` must not make every other provider vanish from the
   *  picker, which is how a filter becomes a trap you cannot get out of. */
  filters: {
    providers: string[];
    kinds: string[];
    applied: { provider: string | null; kind: string | null };
  };
}

export interface SpendSummaryFilters {
  provider?: string | null;
  kind?: string | null;
}

/** The Money surface's one query fan-out: window totals, provider×kind
 *  breakdown, and a daily series. today/d7/d30 are fixed reference windows
 *  regardless of `days`; by_area and daily use the requested horizon, so a
 *  caller filtering to "this week" gets a week of chart data, not a month.
 *  today uses the UTC day boundary (consistent with todaySpendRollup).
 *
 *  `filters.provider` / `filters.kind` narrow ONLY `by_area` and `daily` — the
 *  three window totals stay whole-portfolio on purpose. A headline that moved
 *  with the chart's filter would let a reader answer "what am I spending?"
 *  with one provider's slice and never notice; the chart is the thing being
 *  sliced, and the headline is the thing it is sliced out of. */
export async function spendSummary(
  days = 30,
  filters: SpendSummaryFilters = {},
): Promise<SpendSummary> {
  const horizonDays = Math.min(365, Math.max(1, Math.trunc(days) || 30));
  const provider = filters.provider ?? null;
  const kind = filters.kind ?? null;
  /* $2/$3 are always bound, so one prepared shape serves every combination —
   * `$2::text IS NULL OR provider = $2` is the filter and its own bypass. */
  const filterArgs: [number, string | null, string | null] = [
    horizonDays,
    provider,
    kind,
  ];
  const FILTER_SQL =
    "AND ($2::text IS NULL OR provider = $2) AND ($3::text IS NULL OR kind = $3)";
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
      WHERE created_at >= now() - ($1::int * interval '1 day')
      ${FILTER_SQL}
      GROUP BY provider, kind
      ORDER BY SUM(amount_eur) DESC, COUNT(*) DESC`,
    filterArgs,
  );
  const daily = await pool.query<{
    day: string;
    total_eur: string;
    shadow_eur: string;
    calls: string;
  }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            COALESCE(SUM(amount_eur) FILTER (WHERE provider <> 'claude-code'), 0)::text AS total_eur,
            COALESCE(SUM(amount_eur) FILTER (WHERE provider = 'claude-code'), 0)::text AS shadow_eur,
            COUNT(*)::text                     AS calls
       FROM spend_log
      WHERE created_at >= now() - ($1::int * interval '1 day')
      ${FILTER_SQL}
      GROUP BY 1
      ORDER BY 1`,
    filterArgs,
  );
  /* Deliberately UNFILTERED: these populate the pickers. Bound to $1 only. */
  const options = await pool.query<{ provider: string; kind: string }>(
    `SELECT DISTINCT provider, kind
       FROM spend_log
      WHERE created_at >= now() - ($1::int * interval '1 day')`,
    [horizonDays],
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
    daily: daily.rows.map((r) => {
      const total_eur = Number(r.total_eur);
      const shadow_eur = Number(r.shadow_eur);
      return {
        day: r.day,
        total_eur,
        shadow_eur,
        total_compute_eur: Number((total_eur + shadow_eur).toFixed(6)),
        calls: Number(r.calls),
      };
    }),
    filters: {
      providers: [...new Set(options.rows.map((r) => r.provider))].sort(),
      kinds: [...new Set(options.rows.map((r) => r.kind))].sort(),
      applied: { provider, kind },
    },
  };
}

/** Sum + breakdown of today's spend in UTC. UTC chosen because gateways
 *  run on VPS time and the cap is a daily reset, not a tz-localized total.
 *  Always returns a row, even when there's nothing logged yet.
 *
 *  Excludes `claude-code` — same rule as spendSummary() above: it's flat-rate
 *  subscription usage shadow-priced at metered rates, not real cash burn. Left
 *  in, it made the Today screen report a false 244%-over-cap emergency
 *  against genuine metered spend of €0. */
export async function todaySpendRollup(): Promise<DailySpendRollup> {
  const totals = await pool.query<{
    total_eur: string;
    shadow_eur: string;
    row_count: string;
  }>(
    `SELECT COALESCE(SUM(amount_eur) FILTER (WHERE provider <> 'claude-code'), 0)::text AS total_eur,
            COALESCE(SUM(amount_eur) FILTER (WHERE provider = 'claude-code'), 0)::text AS shadow_eur,
            COUNT(*)::text AS row_count
       FROM spend_log
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
                          AT TIME ZONE 'UTC'
        AND provider <> 'claude-code'`,
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
        AND provider <> 'claude-code'
      GROUP BY provider
      ORDER BY SUM(amount_eur) DESC`,
  );

  return {
    total_eur: Number(totals.rows[0]?.total_eur ?? "0"),
    shadow_eur: Number(totals.rows[0]?.shadow_eur ?? "0"),
    row_count: Number(totals.rows[0]?.row_count ?? "0"),
    by_provider: byProvider.rows.map((r) => ({
      provider: r.provider,
      total_eur: Number(r.total_eur),
      rows: Number(r.rows),
    })),
  };
}
