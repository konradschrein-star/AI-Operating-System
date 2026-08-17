/**
 * Hourly usage sampler — the write side of the usage panel.
 *
 * Once an hour we close the previous hour into one `usage_hourly` row: the
 * Claude shadow cost, the token counts, and how many runs were billed into it.
 * `routes/usage.ts` then serves 24h / 30d / 12w series straight off that table
 * and NEVER scans `runs` at request time. Read-time folds over `runs.metadata`
 * are exactly what made the Live panel bog the machine down; a usage chart is
 * the same trap one table over, so it gets the same fix — aggregate on write.
 *
 * ── ATTRIBUTION RULE ────────────────────────────────────────────────────────
 * A run's WHOLE usage lands in the hour of its LAST BILLED TURN.
 *
 * The original wording here was "the hour it COMPLETED", justified by "spend_log
 * gets exactly one row per finished run". That premise was wrong, and round
 * 1353's review caught what it cost. `executor.ts:1147` calls `recordSpend`
 * once per EXECUTOR INVOCATION — and a chat run is re-entered for every turn,
 * so a run accumulates one spend row per turn, spread across as many hours as
 * it lives. Live proof at the time: 14 run ids carried more than one spend row,
 * and one carried 123 across 15 of the last 24 hours.
 *
 * TOKENS are cumulative per run (`usage_total_running`), so they may be folded
 * into exactly ONE bucket or they multiply. That bucket is the hour holding the
 * run's most recent claude-code spend row — see the `linked` CTE. For a
 * finished run that IS its completion hour, so the old sentence stays true
 * where it was ever true; for a run still talking, the total travels forward
 * with it and the earlier hour gives it up rather than double-counting it.
 *
 * COST is per-turn and is summed as it stands — every spend row's usd counts in
 * its own hour. A four-hour run is four small cost bars and one token spike at
 * the end. Smearing tokens across the hours would need per-turn token deltas we
 * do not persist; inventing a plausible curve is worse than a labelled spike,
 * so the rule is returned in the API payload (`attribution`) for the UI to
 * print.
 *
 * ── WHERE THE NUMBERS ACTUALLY COME FROM ────────────────────────────────────
 * Cost: spend_log.meta->>'usd' — the USD truth. NOT amount_eur, which
 * executor.ts already multiplied by a hardcoded CC_USD_EUR. We store USD and
 * convert at read time with the configurable rate, so changing the rate never
 * double-converts and never rewrites history.
 *
 * Tokens: the run row the spend row points at. The task brief said these live
 * in `metadata->'rollup_v1'->'usage'`; verified against the live table on
 * 2026-08-17, they do not — `metadata.rollup_v1` is a TIMESTAMP SCALAR (a
 * flush marker, see run-rollup.ts buildPayload) and `->'usage'` is always
 * NULL. The real fields, all written by lib/run-rollup.ts:
 *
 *   metadata.usage_total_running  — cumulative parent-run usage. What we want.
 *   metadata.usage_running        — the LAST assistant message only. Summing
 *                                   this across runs under-counts by orders of
 *                                   magnitude; used only as a fallback for old
 *                                   rows written before usage_total_running
 *                                   existed (20 of 355 live rows).
 *   metadata.subagents_v2[].usage — per-subagent totals, NOT included in the
 *                                   parent total, so they are added on top.
 *
 * The rollup is per-executor-process and resets if the executor restarts
 * mid-run, so token counts UNDER-count when that happens. They were also
 * OVER-counting on every hour a run was billed in, until round 1354's
 * anti-join narrowed that to the run's newest hour — which is why the word
 * "floor" has been removed from this header: a floor is a promise, and the
 * number was never one in both directions. Round 1355 found the anti-join is
 * only exact WITHIN one `sampleHour()` call: `runSamplerTick` freezes a
 * bucket after writing it twice and `backfill` only ever fills EMPTY
 * buckets, so a run that idled across >= 2 hourly buckets and then resumed
 * got folded into BOTH the frozen old bucket and the new one holding its
 * resumed turn. Round 1356 closed that: every bucket records the run ids it
 * folded (`meta.folded_runs`), and `repairDisplacedBuckets` re-samples any
 * bucket whose recorded set contains a run that has since been billed later.
 * What can honestly be said now: a run's rollup lands in exactly one bucket —
 * the hour of its last billed turn as of the last repair pass — and an
 * executor restart mid-run still loses part of it. Cost is unaffected either
 * way (it comes from the CLI's own total_cost_usd) — which is why cost, not
 * tokens, is the number the panel should lead with. Runs that carry no rollup
 * at all are counted in `meta.runs_without_usage` on the bucket rather than
 * silently rounded away.
 *
 * Schema: db/migrations/0040_usage_hourly.sql.
 */

import pg from "pg";

/* ------------------------------------------------------------------------- *
 * Connection
 * ------------------------------------------------------------------------- */

const { Pool } = pg;

/** Lazily created: a value import of this module must not open a pool, so the
 *  unit tests (which inject a fake Querier) can import it without a live
 *  Postgres. Same reason db/ai-os-pool.ts defers. */
let pool: pg.Pool | null = null;

function usagePool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. usage_hourly, spend_log and runs all live in " +
          "content_forge (127.0.0.1:5432); the sampler refuses to guess a DSN.",
      );
    }
    pool = new Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (e) => console.error("[usage-sampler pool]", e.message));
  }
  return pool;
}

/** The slice of pg.Pool this module uses. Narrow on purpose: the tests hand in
 *  a fake, and a fake that has to implement all of pg.Pool is a fake nobody
 *  writes. */
export interface Querier {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/* ------------------------------------------------------------------------- *
 * Rate (EUR per USD)
 * ------------------------------------------------------------------------- */

export const RATE_KEY = "usage.eur_per_usd";

/** Accepted band for the display rate. Declared before DEFAULT_EUR_PER_USD
 *  because readDefaultRate() validates against them at module load. */
export const RATE_MIN = 0.1;
export const RATE_MAX = 10;

/**
 * Default EUR per USD.
 *
 * 0.86, not the 0.92 the brief floated, because executor.ts already converts
 * with `CC_USD_EUR ?? 0.86` when it writes spend_log.amount_eur. /api/spend
 * sums those EUR rows. If the usage panel converted the same USD at a
 * different rate, the two surfaces would disagree about the same spend and
 * look like a bug. Same env var, same default, one number.
 */
export const DEFAULT_EUR_PER_USD = readDefaultRate();

function readDefaultRate(): number {
  const raw = process.env.CC_USD_EUR;
  if (raw === undefined) return 0.86;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) {
    throw new Error(
      `CC_USD_EUR=${raw} is not a usable EUR/USD rate (expected ${RATE_MIN}..${RATE_MAX}). ` +
        "executor.ts prices every run with this variable; a bad value would " +
        "corrupt spend_log, so the sampler refuses to start on it.",
    );
  }
  return n;
}

/** Thrown by validateRate(). Carried out of routes/usage.ts as a 400 with the
 *  message intact, so the caller learns what was wrong with their number. */
export class RateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateValidationError";
  }
}

/**
 * Accept a rate or say precisely why not. Bounds are 0.1..10 inclusive: wide
 * enough for any real EUR/USD rate plus a decade of drift, narrow enough that
 * a fat-fingered 0 or 1000 never silently rewrites every number on the panel.
 */
export function validateRate(input: unknown): number {
  if (typeof input !== "number") {
    throw new RateValidationError(
      `eur_per_usd must be a number, got ${input === null ? "null" : typeof input}`,
    );
  }
  if (!Number.isFinite(input)) {
    throw new RateValidationError(
      `eur_per_usd must be finite, got ${String(input)}`,
    );
  }
  if (input < RATE_MIN || input > RATE_MAX) {
    throw new RateValidationError(
      `eur_per_usd must be between ${RATE_MIN} and ${RATE_MAX}, got ${input}`,
    );
  }
  return input;
}

export interface RateSetting {
  eur_per_usd: number;
  /** 'app_settings' once a human has overridden it, 'default' until then. The
   *  distinction is the whole reason migration 0040 seeds no row. */
  source: "app_settings" | "default";
  updated_at: string | null;
}

export async function getRate(db: Querier = usagePool()): Promise<RateSetting> {
  const r = await db.query<{ value: unknown; updated_at: Date | string }>(
    `SELECT value, updated_at FROM app_settings WHERE key = $1`,
    [RATE_KEY],
  );
  const row = r.rows[0];
  if (!row) {
    return {
      eur_per_usd: DEFAULT_EUR_PER_USD,
      source: "default",
      updated_at: null,
    };
  }
  const raw = row.value;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) {
    throw new Error(
      `app_settings['${RATE_KEY}'] holds ${JSON.stringify(raw)}, which is not a ` +
        `rate in ${RATE_MIN}..${RATE_MAX}. Fix the row or delete it to fall back ` +
        `to the default (${DEFAULT_EUR_PER_USD}); the usage panel will not guess.`,
    );
  }
  return {
    eur_per_usd: n,
    source: "app_settings",
    updated_at: toIso(row.updated_at),
  };
}

export async function setRate(
  input: unknown,
  db: Querier = usagePool(),
): Promise<RateSetting> {
  const rate = validateRate(input);
  const r = await db.query<{ updated_at: Date | string }>(
    `INSERT INTO app_settings (key, value, updated_at)
          VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
       RETURNING updated_at`,
    [RATE_KEY, JSON.stringify(rate)],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      `setting ${RATE_KEY} returned no row — the upsert did not apply. ` +
        "Has migration 0040 been applied to this database?",
    );
  }
  return {
    eur_per_usd: rate,
    source: "app_settings",
    updated_at: toIso(row.updated_at),
  };
}

/** USD → EUR, rounded to the cent-fraction the rest of the money surfaces use
 *  (4 decimals, matching spend_log.amount_eur). Rounding here rather than in
 *  the UI keeps every consumer showing the same number. */
export function usdToEur(usd: number, eurPerUsd: number): number {
  return Math.round(usd * eurPerUsd * 10_000) / 10_000;
}

/* ------------------------------------------------------------------------- *
 * Hour maths (pure — every clock reading is an argument)
 * ------------------------------------------------------------------------- */

export const HOUR_MS = 3_600_000;

/** Start of the hour containing `d`, UTC. */
export function floorHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/** The most recent hour that is fully in the past — the newest one it is safe
 *  to close. At 14:03 that is 13:00. */
export function previousClosedHour(now: Date): Date {
  return new Date(floorHour(now).getTime() - HOUR_MS);
}

/** Milliseconds until the next top of the hour plus `skewMs`, always > 0 so a
 *  timer armed exactly on the boundary cannot spin. */
export function msUntilNextTick(now: Date, skewMs: number): number {
  const next = floorHour(now).getTime() + HOUR_MS + skewMs;
  const delta = next - now.getTime();
  return delta > 0 ? delta : delta + HOUR_MS;
}

/**
 * Every hour bucket in [from, throughInclusive] that `existing` does not
 * already cover. Used for the boot backfill: spend_log holds the history, so
 * a fresh table can be filled in one pass instead of starting blind.
 *
 * Empty hours are INCLUDED — a quiet hour must become a zero row, not a hole.
 * A hole is indistinguishable from "the sampler was down", and a chart that
 * cannot tell those apart lies twice.
 */
export function missingBuckets(
  existing: Iterable<Date | string>,
  from: Date,
  throughInclusive: Date,
): Date[] {
  const have = new Set<number>();
  for (const e of existing) {
    have.add(floorHour(e instanceof Date ? e : new Date(e)).getTime());
  }
  const out: Date[] = [];
  const end = floorHour(throughInclusive).getTime();
  for (let t = floorHour(from).getTime(); t <= end; t += HOUR_MS) {
    if (!have.has(t)) out.push(new Date(t));
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Sampling one hour
 * ------------------------------------------------------------------------- */

export interface HourSample {
  bucket_start: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  shadow_usd: number;
  run_count: number;
  sampled_at: string;
  meta: Record<string, unknown>;
}

/** The four token keys, verbatim as run-rollup.ts writes them. */
const TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/**
 * `expr->'key'` as a numeric, or 0 when it is absent or not a JSON number.
 *
 * The jsonb_typeof guard is not decoration: `(x->>'k')::numeric` raises on any
 * non-numeric text, and one malformed metadata blob written by some future
 * code path would abort the whole hour's sample. Keys are compile-time
 * literals from TOKEN_KEYS — nothing user-supplied reaches this string.
 */
function num(expr: string, key: string): string {
  return `(CASE WHEN jsonb_typeof(${expr}->'${key}') = 'number'
                THEN (${expr}->>'${key}')::numeric ELSE 0 END)`;
}

const PARENT_USAGE = `COALESCE(r.metadata->'usage_total_running', r.metadata->'usage_running', '{}'::jsonb)`;

/**
 * One hour, aggregated and upserted. Idempotent: running it again over the
 * same hour recomputes from source and overwrites, so a re-run, a backfill and
 * a live tick all converge on the same row. `sampled_at` DOES advance on every
 * write — it records when we last looked, which is the one thing that is
 * genuinely different the second time; every measured column is byte-identical.
 */
export async function sampleHour(
  bucketStart: Date,
  db: Querier = usagePool(),
): Promise<HourSample> {
  const start = floorHour(bucketStart);
  const end = new Date(start.getTime() + HOUR_MS);

  /* ── LINKED: one bucket per run, the newest one AS OF THIS QUERY ─────────
   *
   * `billed` holds every claude-code spend row in this hour, and spend_log gets
   * one row per TURN — executor.ts:1147 runs once per invocation and a chat run
   * is re-entered for every turn — so a run that lives four hours is billed in
   * four buckets. `parent` folds that run's CUMULATIVE `usage_total_running`,
   * so the previous `linked` (SELECT DISTINCT run_id FROM billed) counted the
   * run's whole total once per hour it touched. Round 1353's reviewer measured
   * 4.9% phantom tokens over 24h of live data, unbounded as a chat grows.
   *
   * The anti-join keeps a run only when NO claude-code spend row for it exists
   * at or after this bucket's end — i.e. its latest turn is in THIS hour.
   * WITHIN a single sampleHour() call that is exact: one run, one bucket, one
   * fold. It is NOT self-sufficient across the tick's write schedule, and this
   * is the half that round 1356 had to add:
   *
   *   THE IDLE-THEN-RESUME DOUBLE FOLD (round 1355's blocker, fixed here).
   *   `runSamplerTick` writes each bucket at most twice — once as the closing
   *   hour, once more on the following tick as the RESAMPLE_LOOKBACK hour —
   *   and `backfill` only ever fills buckets with NO row yet. So two ticks
   *   after an hour closes, its row is frozen: nothing recomputes it. A run
   *   that goes quiet for >= 2 hourly buckets and then resumes was folded into
   *   its old, now-frozen bucket while it looked settled, and is folded AGAIN
   *   into the bucket holding its resumed turn. Measured on live-shaped data
   *   at round 1355: true total 5000 tokens, buckets summed to 6000; 16
   *   phantom foldings across 4 runs over 30 days, worst case one long-lived
   *   operator chat folded 7x, carrying 1.37M cache_read each time.
   *
   *   The repair is `repairDisplacedBuckets` below, and `folded_runs` in this
   *   statement's `meta` is what makes it possible AND makes it terminate.
   *   Each bucket records the exact run ids it folded; the repair pass finds
   *   any bucket whose recorded set contains a run that has since been billed
   *   at or after that bucket's end, and re-samples it. Re-sampling drops the
   *   run from `linked`, so it also drops out of `folded_runs` and the bucket
   *   is never revisited for that run again. Without the recorded set the pass
   *   would have to re-sample every earlier hour of every multi-hour run on
   *   every tick, forever — cost with no convergence.
   *
   * It also fixes the stability half of round 1353's defect. RESAMPLE_LOOKBACK
   * re-closes the previous hour on every tick, and re-closing used to re-read a
   * still-growing run's counter and rewrite an already-settled number upward
   * (1000 → 5000 in the reviewer's repro). A run that has spoken since simply
   * leaves the earlier bucket for the later one it belongs to — and now leaves
   * it however long the silence between the two turns was.
   *
   * `lower()` on the spend row's id is not cosmetic. `b.run_id::text` is
   * lowercase-canonical (Postgres renders every uuid that way), so a spend row
   * whose `meta.run_id` was stored uppercase would fail the comparison, the
   * anti-join would not see the later turn, and the double fold would resume
   * silently. Zero such rows exist today (694 live rows checked at round
   * 1355); the guard costs one function call on a set that has no index to
   * lose. The same normalisation is applied on both sides of the repair join.
   *
   * Cost is deliberately NOT deduped this way: `cost` aggregates `billed`
   * directly, because each spend row carries its OWN turn's usd and summing
   * them is exactly right. Both the round-1353 bug and the round-1355
   * double fold are token-fold-only; cost is never double-counted.
   *
   * Proved against a real Postgres by scripts/checks/check-usage-fold.ts —
   * which fails on the pre-1354 SQL with precisely round 1353's numbers, and
   * whose §2b drives the REAL `runSamplerTick` across a 3-hour silence and
   * fails on the pre-1356 code with round 1355's numbers (5000 true, 6000
   * summed).
   */
  const sql = `
    WITH billed AS (
      SELECT s.meta AS meta,
             CASE WHEN jsonb_typeof(s.meta->'run_id') = 'string'
                   AND s.meta->>'run_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                  THEN (s.meta->>'run_id')::uuid END AS run_id
        FROM spend_log s
       WHERE s.provider = 'claude-code'
         AND s.created_at >= $1::timestamptz
         AND s.created_at <  $2::timestamptz
    ),
    -- run_count is COUNT(*) over spend rows, i.e. TURNS — one per executor
    -- invocation, and a chat run is re-entered every turn. It is labelled
    -- "turns" in the panel for that reason. distinct_runs is the number the
    -- word "runs" would honestly describe; it is kept in meta rather than in
    -- the series payload because it is NOT additive across buckets (a run
    -- spanning three hours is distinct in each of them, and summing would
    -- claim three runs), and /api/usage/series rolls hours up into days and
    -- weeks by summing.
    cost AS (
      SELECT COUNT(*)::bigint AS run_count,
             COUNT(DISTINCT run_id)::bigint AS distinct_runs,
             COALESCE(SUM(${num("meta", "usd")}), 0)::numeric AS shadow_usd,
             COUNT(*) FILTER (WHERE jsonb_typeof(meta->'usd') <> 'number')::bigint AS rows_without_usd,
             COUNT(*) FILTER (WHERE run_id IS NULL)::bigint AS rows_without_run_id
        FROM billed
    ),
    -- ONE BUCKET PER RUN: the newest hour it is billed in. See LINKED above.
    linked AS (
      SELECT b.run_id
        FROM (SELECT DISTINCT run_id FROM billed WHERE run_id IS NOT NULL) b
       WHERE NOT EXISTS (
               SELECT 1
                 FROM spend_log s2
                WHERE s2.provider = 'claude-code'
                  AND s2.created_at >= $2::timestamptz
                  AND lower(s2.meta->>'run_id') = b.run_id::text
             )
    ),
    parent AS (
      SELECT COALESCE(SUM(${num(PARENT_USAGE, "input_tokens")}), 0)::bigint AS tokens_in,
             COALESCE(SUM(${num(PARENT_USAGE, "output_tokens")}), 0)::bigint AS tokens_out,
             COALESCE(SUM(${num(PARENT_USAGE, "cache_read_input_tokens")}), 0)::bigint AS cache_read,
             COALESCE(SUM(${num(PARENT_USAGE, "cache_creation_input_tokens")}), 0)::bigint AS cache_write,
             COUNT(*)::bigint AS runs_found,
             COUNT(*) FILTER (
               WHERE r.metadata->'usage_total_running' IS NULL
                 AND r.metadata->'usage_running' IS NULL
             )::bigint AS runs_without_usage
        FROM linked l
        JOIN runs r ON r.id = l.run_id
    ),
    subs AS (
      SELECT COALESCE(SUM(${num("e.value->'usage'", "input_tokens")}), 0)::bigint AS tokens_in,
             COALESCE(SUM(${num("e.value->'usage'", "output_tokens")}), 0)::bigint AS tokens_out,
             COALESCE(SUM(${num("e.value->'usage'", "cache_read_input_tokens")}), 0)::bigint AS cache_read,
             COALESCE(SUM(${num("e.value->'usage'", "cache_creation_input_tokens")}), 0)::bigint AS cache_write,
             COUNT(*)::bigint AS subagent_count
        FROM linked l
        JOIN runs r ON r.id = l.run_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.metadata->'subagents_v2') = 'array'
               THEN r.metadata->'subagents_v2' ELSE '[]'::jsonb END
        ) AS e(value)
    )
    INSERT INTO usage_hourly
      (bucket_start, tokens_in, tokens_out, cache_read, cache_write,
       shadow_usd, run_count, sampled_at, meta)
    SELECT $1::timestamptz,
           parent.tokens_in  + subs.tokens_in,
           parent.tokens_out + subs.tokens_out,
           parent.cache_read + subs.cache_read,
           parent.cache_write + subs.cache_write,
           ROUND(cost.shadow_usd, 4),
           cost.run_count,
           now(),
           jsonb_build_object(
             'runs_found',          parent.runs_found,
             'runs_without_usage',  parent.runs_without_usage,
             'rows_without_usd',    cost.rows_without_usd,
             'rows_without_run_id', cost.rows_without_run_id,
             'distinct_runs',       cost.distinct_runs,
             'subagent_count',      subs.subagent_count,
             'folded_runs',         (SELECT COALESCE(jsonb_agg(l.run_id ORDER BY l.run_id), '[]'::jsonb)
                                       FROM linked l),
             'source',              'spend_log+runs.metadata',
             'attribution',         $3::text
           )
      FROM cost, parent, subs
    ON CONFLICT (bucket_start) DO UPDATE
       SET tokens_in   = EXCLUDED.tokens_in,
           tokens_out  = EXCLUDED.tokens_out,
           cache_read  = EXCLUDED.cache_read,
           cache_write = EXCLUDED.cache_write,
           shadow_usd  = EXCLUDED.shadow_usd,
           run_count   = EXCLUDED.run_count,
           sampled_at  = EXCLUDED.sampled_at,
           meta        = EXCLUDED.meta
    RETURNING bucket_start, tokens_in, tokens_out, cache_read, cache_write,
              shadow_usd, run_count, sampled_at, meta`;

  const r = await db.query<{
    bucket_start: Date | string;
    tokens_in: string;
    tokens_out: string;
    cache_read: string;
    cache_write: string;
    shadow_usd: string;
    run_count: number;
    sampled_at: Date | string;
    meta: Record<string, unknown>;
  }>(sql, [start.toISOString(), end.toISOString(), ATTRIBUTION]);

  const row = r.rows[0];
  if (!row) {
    // `FROM cost, parent, subs` is a cross join of three aggregates; each is
    // guaranteed exactly one row even when its input is empty, so a missing
    // row here means the INSERT did not apply at all.
    throw new Error(
      `sampleHour(${start.toISOString()}) inserted no row. The aggregate CTEs ` +
        "always yield one row, so this means the INSERT was suppressed — check " +
        "that migration 0040 is applied to this database.",
    );
  }
  return {
    bucket_start: toIso(row.bucket_start),
    tokens_in: Number(row.tokens_in),
    tokens_out: Number(row.tokens_out),
    cache_read: Number(row.cache_read),
    cache_write: Number(row.cache_write),
    shadow_usd: Number(row.shadow_usd),
    run_count: Number(row.run_count),
    sampled_at: toIso(row.sampled_at),
    meta: row.meta ?? {},
  };
}

/**
 * The attribution rule, in the one wording that ships everywhere: written into
 * each bucket's meta and returned by GET /api/usage/series, which the panel
 * prints verbatim.
 *
 * It said "counted at run completion" until round 1354, then "counted once"
 * until round 1355, then named its own exception out loud in round 1355 —
 * each wording tracking what the SQL could actually keep at the time. Round
 * 1354's anti-join fixed the every-hour-billed fold; round 1356's repair pass
 * (`repairDisplacedBuckets`) closed the freeze-then-empty-only-backfill gap
 * that double-folded a run idling >= 2 hourly buckets before it resumed. The
 * exception is gone, so the wording drops it — and says where the boundary
 * now is instead: the fold is corrected by the repair pass, so a bucket read
 * between a run's resumption and the next tick can still hold a fold that is
 * about to move. Buckets written before this round carry the older strings in
 * their own `meta`, which is the point of stamping it per row — a reader can
 * tell which rule produced which number.
 */
export const ATTRIBUTION =
  "tokens land whole in the hour of the run's last billed turn, counted once " +
  "— earlier buckets are re-sampled when a run resumes; cost is per turn, in " +
  "the turn's own hour";

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/* ------------------------------------------------------------------------- *
 * The tick
 * ------------------------------------------------------------------------- */

/** Fire a bit after the boundary, not on it: a run completing at :59:59.9
 *  commits its spend_log row a moment later, and the clock is not the same
 *  clock. 30s costs nothing and stops the last run of the hour landing in a
 *  bucket we already closed. */
const TICK_SKEW_MS = Number(process.env.USAGE_SAMPLER_SKEW_MS ?? "30000");

/** How far back the boot backfill reaches. spend_log holds ~30d of history. */
const BACKFILL_DAYS = Number(process.env.USAGE_SAMPLER_BACKFILL_DAYS ?? "30");

/** Each tick also re-samples the hour BEFORE the one it is closing. Free
 *  (the upsert is idempotent) and it repairs the one race the skew cannot:
 *  an executor whose rollup flush lands after we already closed the bucket.
 *  It is deliberately NOT the mechanism that keeps old buckets honest — two
 *  writes and a bucket would freeze forever. `repairDisplacedBuckets` below
 *  is what reaches further back, and it reaches only where it must. */
const RESAMPLE_LOOKBACK = 1;

/** How far back a repair pass audits. Same horizon as the boot backfill:
 *  spend_log holds ~30d, and a bucket whose source rows have aged out cannot
 *  be recomputed from anything. */
const REPAIR_DAYS = Number(
  process.env.USAGE_SAMPLER_REPAIR_DAYS ?? String(BACKFILL_DAYS),
);

/** What one repair pass did. Returned rather than logged-and-forgotten so the
 *  tick can print it and a check can assert on it. */
export interface RepairResult {
  /** Buckets that folded a run which has since been billed at or after the
   *  bucket's end — the double-fold, found and re-sampled. */
  displaced: string[];
  /** Buckets written before `meta.folded_runs` existed (round 1356). They
   *  cannot be audited, so they are re-sampled once, which both corrects them
   *  and gives them the audit field. Empty on every pass after the first. */
  unaudited: string[];
}

/**
 * Re-sample every bucket whose stored fold is now wrong. This is the fix for
 * round 1355's blocker — the idle-then-resume double fold — and the reason
 * `sampleHour` records `meta.folded_runs`.
 *
 * TWO reasons a bucket is re-sampled, and they are reported separately:
 *
 *   displaced — the bucket recorded run R in `folded_runs`, and R has a
 *     claude-code spend row at or after that bucket's end. R's cumulative
 *     total therefore belongs to a LATER bucket and is currently counted in
 *     both. Re-sampling drops R from `linked`, which drops it from
 *     `folded_runs`, which is why this terminates: the same bucket is never
 *     selected for the same run twice.
 *
 *   unaudited — the bucket predates `folded_runs`. Nothing can be said about
 *     what it folded, so it is recomputed once. After that pass every row in
 *     the horizon carries the field and this list stays empty. This is also
 *     what repairs the 16 (run, bucket) pairs round 1355's reviewer measured
 *     on live-shaped data — they were written by the frozen-bucket code.
 *
 * ORDERING MATTERS: the caller must sample the closing hour BEFORE repairing.
 * Repair first and a run's tokens are removed from the old bucket before the
 * new bucket that should hold them exists — a momentary UNDER-count in a
 * table other processes read. Sample-then-repair is never wrong in either
 * direction: between the two statements the run is counted in both, and
 * `runSamplerTick` closes that window inside one tick.
 *
 * Sequential, like `backfill`, and for the same reason: a pool of 2 shared
 * with the HTTP server must not be flooded by a chart's bookkeeping.
 */
export async function repairDisplacedBuckets(
  now: Date,
  db: Querier = usagePool(),
): Promise<RepairResult> {
  const from = new Date(
    previousClosedHour(now).getTime() - (REPAIR_DAYS * 24 - 1) * HOUR_MS,
  );

  /* One pass over spend_log, one over usage_hourly. `lower()` on BOTH sides:
   * `folded_runs` holds uuid::text (lowercase-canonical by construction) and
   * spend_log.meta->>'run_id' is free text — see the LINKED note above. */
  const audit = await db.query<{ bucket_start: Date | string; reason: string }>(
    `WITH last_billed AS (
       SELECT lower(s.meta->>'run_id') AS run_id, MAX(s.created_at) AS last_at
         FROM spend_log s
        WHERE s.provider = 'claude-code'
          AND jsonb_typeof(s.meta->'run_id') = 'string'
          AND s.created_at >= $1::timestamptz
        GROUP BY 1
     ),
     audited AS (
       SELECT u.bucket_start, lower(f.run_id) AS run_id
         FROM usage_hourly u
         CROSS JOIN LATERAL jsonb_array_elements_text(u.meta->'folded_runs') AS f(run_id)
        WHERE u.bucket_start >= $1::timestamptz
          AND jsonb_typeof(u.meta->'folded_runs') = 'array'
     )
     SELECT DISTINCT a.bucket_start, 'displaced' AS reason
       FROM audited a
       JOIN last_billed b ON b.run_id = a.run_id
      WHERE b.last_at >= a.bucket_start + interval '1 hour'
     UNION ALL
     SELECT u.bucket_start, 'unaudited' AS reason
       FROM usage_hourly u
      WHERE u.bucket_start >= $1::timestamptz
        AND COALESCE(jsonb_typeof(u.meta->'folded_runs'), 'missing') <> 'array'
      ORDER BY 1`,
    [from.toISOString()],
  );

  const out: RepairResult = { displaced: [], unaudited: [] };
  for (const row of audit.rows) {
    const bucket = row.bucket_start instanceof Date
      ? row.bucket_start
      : new Date(row.bucket_start);
    if (row.reason === "displaced") out.displaced.push(toIso(bucket));
    else if (row.reason === "unaudited") out.unaudited.push(toIso(bucket));
    else {
      // The two literals above are the only values the statement can produce.
      throw new Error(
        `repairDisplacedBuckets: unknown audit reason ${JSON.stringify(row.reason)} ` +
          `for bucket ${toIso(bucket)} — the audit query and this switch have diverged`,
      );
    }
    await sampleHour(bucket, db);
  }
  return out;
}

let tickHandle: NodeJS.Timeout | null = null;
let started = false;

/**
 * One tick: close the newest complete hour (and re-close the one before it for
 * the flush race), THEN repair every older bucket whose fold has moved on.
 * The order is load-bearing — see `repairDisplacedBuckets`.
 */
export async function runSamplerTick(
  now: Date,
  db: Querier = usagePool(),
): Promise<HourSample[]> {
  const newest = previousClosedHour(now);
  const out: HourSample[] = [];
  for (let i = RESAMPLE_LOOKBACK; i >= 0; i--) {
    const bucket = new Date(newest.getTime() - i * HOUR_MS);
    out.push(await sampleHour(bucket, db));
  }
  const repaired = await repairDisplacedBuckets(now, db);
  const n = repaired.displaced.length + repaired.unaudited.length;
  if (n > 0) {
    console.log(
      `[usage-sampler] repaired ${n} bucket(s) · ` +
        `${repaired.displaced.length} displaced by a resumed run, ` +
        `${repaired.unaudited.length} written before folded_runs existed`,
    );
  }
  // Deliberately NOT appended to the return value: callers treat this array as
  // "the hours this tick closed", and the newest of them is what gets logged.
  return out;
}

/**
 * Fill every hour in the last BACKFILL_DAYS that has no row yet. One-shot, on
 * boot. Sequential on purpose — 720 small aggregates on a pool of 2 must not
 * starve the HTTP server that shares the process.
 *
 * "No row yet" is strict, and stays strict: this pass must never rewrite a
 * bucket it did not create, or booting the process would silently restate
 * history. Recomputing an EXISTING bucket is `repairDisplacedBuckets`'s job,
 * which does it only where it can name the reason.
 */
export async function backfill(
  now: Date,
  db: Querier = usagePool(),
): Promise<number> {
  const through = previousClosedHour(now);
  const from = new Date(
    through.getTime() - (BACKFILL_DAYS * 24 - 1) * HOUR_MS,
  );
  const existing = await db.query<{ bucket_start: Date | string }>(
    `SELECT bucket_start FROM usage_hourly WHERE bucket_start >= $1::timestamptz`,
    [from.toISOString()],
  );
  const todo = missingBuckets(
    existing.rows.map((r) => r.bucket_start),
    from,
    through,
  );
  for (const bucket of todo) {
    await sampleHour(bucket, db);
  }
  return todo.length;
}

/**
 * Start the hourly sampler. Safe to call twice — only the first arms a timer.
 * `USAGE_SAMPLER=0` disables it entirely (the kill switch: the endpoints keep
 * serving whatever is already in the table, and nothing writes).
 */
export function startUsageSamplerTick(): void {
  if (process.env.USAGE_SAMPLER === "0") {
    console.log("[usage-sampler] disabled by USAGE_SAMPLER=0");
    return;
  }
  if (started) return;
  started = true;

  void (async () => {
    try {
      const filled = await backfill(new Date());
      console.log(
        `[usage-sampler] boot backfill complete · ${filled} bucket(s) filled ` +
          `(${BACKFILL_DAYS}d horizon)`,
      );
      // On the first boot after round 1356 this recomputes every pre-existing
      // bucket once (they carry no `folded_runs`), which is what un-doubles
      // the folds the frozen-bucket code left behind. Every later boot finds
      // nothing and costs one audit query.
      const repaired = await repairDisplacedBuckets(new Date());
      console.log(
        `[usage-sampler] boot repair complete · ` +
          `${repaired.displaced.length} displaced, ` +
          `${repaired.unaudited.length} unaudited bucket(s) re-sampled ` +
          `(${REPAIR_DAYS}d horizon)`,
      );
    } catch (e) {
      console.error(
        "[usage-sampler] boot backfill/repair failed:",
        e instanceof Error ? e.message : e,
      );
    }
  })();

  const arm = (): void => {
    const delay = msUntilNextTick(new Date(), TICK_SKEW_MS);
    tickHandle = setTimeout(() => {
      void (async () => {
        try {
          const rows = await runSamplerTick(new Date());
          const closed = rows[rows.length - 1];
          if (closed) {
            console.log(
              // "turn(s)", not "run(s)": run_count is COUNT(*) over spend
              // rows and spend_log gets one row per TURN. Round 1355's
              // reviewer caught this line still using the old word after the
              // panel had been corrected.
              `[usage-sampler] closed ${closed.bucket_start} · ` +
                `${closed.run_count} turn(s), $${closed.shadow_usd}`,
            );
          }
        } catch (e) {
          console.error(
            "[usage-sampler] tick failed:",
            e instanceof Error ? e.message : e,
          );
        } finally {
          // Re-arm from the new clock reading rather than setInterval, so a
          // slow tick cannot drift the schedule off the hour boundary.
          arm();
        }
      })();
    }, delay);
    // Never hold the process open for a chart.
    tickHandle.unref?.();
  };
  arm();
  console.log(
    `[usage-sampler] armed · next close in ${Math.round(msUntilNextTick(new Date(), TICK_SKEW_MS) / 1000)}s`,
  );
}

export function stopUsageSamplerTick(): void {
  if (tickHandle) clearTimeout(tickHandle);
  tickHandle = null;
  started = false;
}
