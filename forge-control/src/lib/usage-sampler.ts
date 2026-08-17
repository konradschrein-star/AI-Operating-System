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
 * buckets (see the KNOWN EXCEPTION note by LINKED below), so a run that
 * idles across >= 2 hourly buckets and then resumes gets folded into BOTH
 * the frozen old bucket and the new one holding its resumed turn. What can
 * honestly be said now: a run's rollup usually lands in exactly one bucket,
 * except when it idles >= 2 buckets and comes back, in which case it lands
 * in two; and an executor restart loses part of it either way. Cost is
 * unaffected either way (it comes from the CLI's own total_cost_usd) — which
 * is why cost, not tokens, is the number the panel should lead with. Runs
 * that carry no rollup at all are counted in `meta.runs_without_usage` on
 * the bucket rather than silently rounded away.
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
   * fold. It stops being exact once the tick's write schedule enters the
   * picture:
   *
   *   KNOWN EXCEPTION — the idle-then-resume double fold. `runSamplerTick`
   *   below writes each bucket at most twice (once as the closing hour, once
   *   more the following tick as the RESAMPLE_LOOKBACK hour) and never
   *   revisits it after that — the bucket is frozen. `backfill` only fills
   *   buckets that have NO row yet, so a frozen bucket is never recomputed by
   *   either path. A run that goes idle for >= 2 hourly buckets and then
   *   resumes was folded into its old, now-frozen bucket while it looked
   *   idle, and gets folded AGAIN into the new bucket holding its resumed
   *   turn — nothing goes back and un-counts the frozen one. Measured on live
   *   data at round 1355: true total 5000 tokens, buckets summed to 6000; 16
   *   phantom foldings across 4 runs over 30 days, worst case one long-lived
   *   operator chat folded 7x, carrying 1.37M cache_read with it each time.
   *   NOT fixed here — the fix is a larger job (resample every bucket a still-
   *   open run could still reach back into, or stop freezing buckets a live
   *   run could touch) and is deliberately out of scope for round 1355, which
   *   only had to stop this comment and the UI from claiming more than the
   *   SQL delivers.
   *
   * It also fixes the stability half of round 1353's defect. RESAMPLE_LOOKBACK
   * re-closes the previous hour on every tick, and re-closing used to re-read a
   * still-growing run's counter and rewrite an already-settled number upward
   * (1000 → 5000 in the reviewer's repro). A run that has spoken since simply
   * leaves the earlier bucket for the later one it belongs to — as long as
   * that earlier bucket has not frozen yet; see the exception above when it
   * has.
   *
   * Cost is deliberately NOT deduped this way: `cost` aggregates `billed`
   * directly, because each spend row carries its OWN turn's usd and summing
   * them is exactly right. Both the round-1353 bug and the round-1355
   * exception above are token-fold-only; cost is never double-counted.
   *
   * Proved against a real Postgres by scripts/checks/check-usage-fold.ts —
   * which fails on the pre-1354 SQL with precisely round 1353's numbers. It
   * does not yet cover the round-1355 idle-then-resume exception; fixing that
   * is the larger job named above, not this round's.
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
    cost AS (
      SELECT COUNT(*)::bigint AS run_count,
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
                  AND s2.meta->>'run_id' = b.run_id::text
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
             'subagent_count',      subs.subagent_count,
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
 * until round 1355 — both named the claim the SQL looked like it made, not
 * the claim it could actually keep. Round 1354's anti-join fixed the every-
 * hour-billed fold, but left the freeze-then-empty-only-backfill gap that
 * double-folds a run idling >= 2 hourly buckets before it resumes (see the
 * KNOWN EXCEPTION note by LINKED above). The wording now says only what is
 * true: tokens land whole in the hour of a run's last billed turn, usually
 * once — except a run that idles long enough to freeze its bucket and then
 * resumes, which lands in two. Buckets written before this round carry the
 * older strings in their own `meta`, which is the point of stamping it per
 * row — a reader can tell which rule produced which number.
 */
export const ATTRIBUTION =
  "tokens land in the hour of the run's last billed turn, usually once — a " +
  "run idling >=2h then resuming can be double-counted; cost is per turn, " +
  "never double-counted";

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
 *  This is also HALF of the round-1355 KNOWN EXCEPTION named by LINKED in
 *  sampleHour(): a bucket gets written when it is `newest` and again when it
 *  is `newest - RESAMPLE_LOOKBACK`, then never again — it freezes. */
const RESAMPLE_LOOKBACK = 1;

let tickHandle: NodeJS.Timeout | null = null;
let started = false;

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
  return out;
}

/**
 * Fill every hour in the last BACKFILL_DAYS that has no row yet. One-shot, on
 * boot. Sequential on purpose — 720 small aggregates on a pool of 2 must not
 * starve the HTTP server that shares the process.
 *
 * "No row yet" is the OTHER half of the round-1355 KNOWN EXCEPTION named by
 * LINKED in sampleHour(): this never revisits a bucket that already has a
 * row, so once RESAMPLE_LOOKBACK above has frozen a bucket, nothing —
 * neither the tick nor this boot pass — ever recomputes it.
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
    } catch (e) {
      console.error(
        "[usage-sampler] boot backfill failed:",
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
              `[usage-sampler] closed ${closed.bucket_start} · ` +
                `${closed.run_count} run(s), $${closed.shadow_usd}`,
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
