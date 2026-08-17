/**
 * Subscription quota — the 5-hour and 7-day windows.
 *
 *   GET /api/usage/quota            → cached snapshot
 *   GET /api/usage/quota?fresh=1    → force a refetch (the UI's refresh button)
 *
 * Anthropic exposes this at /api/oauth/usage using the SAME OAuth token the
 * `claude` CLI already holds. Worth stating plainly because the codebase
 * previously assumed the opposite ("the CLI has no proactive 'X% of quota
 * used' API" — see routes/spend.ts limit-hits): it does, so we no longer have
 * to infer quota reactively from runs that already crashed into the ceiling.
 *
 * Cached because this is chrome polled by an always-open dashboard, and the
 * numbers move in minutes, not milliseconds. `fetched_at` is returned so the
 * UI can show how stale the reading is rather than implying it's live.
 */

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  ATTRIBUTION,
  DEFAULT_EUR_PER_USD,
  RateValidationError,
  getRate,
  setRate,
  usdToEur,
  type Querier,
} from "../lib/usage-sampler.ts";

const r = new Hono();

const CREDS = process.env.CLAUDE_CREDENTIALS ?? "/root/.claude/.credentials.json";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_MS = 60_000;

export interface QuotaWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface QuotaSnapshot {
  five_hour: QuotaWindow;
  seven_day: QuotaWindow;
  /** Present only on plans that break Opus out separately. */
  seven_day_opus: QuotaWindow | null;
  fetched_at: string;
  error?: string;
}

let cache: QuotaSnapshot | null = null;
let cacheAt = 0;
let inFlight: Promise<QuotaSnapshot> | null = null;

/** Rate-limit cooldown. The upstream quota endpoint answers 429 if polled too
 *  eagerly (several dashboard tabs + a manual refresh is enough). Hammering it
 *  through the limit is what turned a transient 429 into a stuck "last refresh
 *  failed" with no way back. While a cooldown is active we serve the cached
 *  reading and refuse to call upstream at all — including for ?fresh=1, which
 *  is precisely the button a frustrated user mashes. */
let cooldownUntil = 0;
const COOLDOWN_MS = Number(process.env.USAGE_429_COOLDOWN_MS ?? "120000");

async function oauthToken(): Promise<string | null> {
  try {
    const raw = await readFile(CREDS, "utf8");
    const j = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return j.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function pickWindow(v: unknown): QuotaWindow {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    utilization: typeof o.utilization === "number" ? o.utilization : null,
    resets_at: typeof o.resets_at === "string" ? o.resets_at : null,
  };
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  const now = new Date().toISOString();
  const token = await oauthToken();
  if (!token) {
    return {
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: null,
      fetched_at: now,
      error: "no oauth token on disk",
    };
  }
  const ctl = AbortSignal.timeout(8_000);
  const res = await fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
    signal: ctl,
  });
  if (!res.ok) {
    if (res.status === 429) {
      // Honour Retry-After when the server sends one, else a flat cooldown.
      const ra = Number(res.headers.get("retry-after"));
      cooldownUntil =
        Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : COOLDOWN_MS);
    }
    return {
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: null,
      fetched_at: now,
      error:
        res.status === 429
          ? "rate limited — showing the last good reading"
          : `usage endpoint returned ${res.status}`,
    };
  }
  const j = (await res.json()) as Record<string, unknown>;
  return {
    five_hour: pickWindow(j.five_hour),
    seven_day: pickWindow(j.seven_day),
    seven_day_opus: j.seven_day_opus ? pickWindow(j.seven_day_opus) : null,
    fetched_at: now,
  };
}

r.get("/quota", async (c) => {
  const fresh = c.req.query("fresh") === "1";
  const age = Date.now() - cacheAt;
  if (!fresh && cache && age < CACHE_MS) {
    return c.json({ ...cache, cached: true, age_ms: age });
  }
  // Rate-limited: serve what we have and say when we'll try again, instead of
  // calling upstream and deepening the limit. Applies to ?fresh=1 too.
  const cooldownLeft = cooldownUntil - Date.now();
  if (cooldownLeft > 0) {
    return c.json({
      ...(cache ?? {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: null, resets_at: null },
        seven_day_opus: null,
        fetched_at: new Date().toISOString(),
      }),
      cached: true,
      age_ms: age,
      error: "rate limited — showing the last good reading",
      retry_in_ms: cooldownLeft,
    });
  }
  // Collapse concurrent misses onto one upstream call.
  if (!inFlight) {
    inFlight = fetchQuota()
      .then((snap) => {
        // Never let a transient failure erase a good reading — stale numbers
        // with an error flag beat blank bars.
        if (!snap.error || !cache) {
          cache = snap;
          cacheAt = Date.now();
        } else {
          cache = { ...cache, error: snap.error };
        }
        return cache;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  try {
    const snap = await inFlight;
    return c.json({ ...snap, cached: false, age_ms: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[usage/quota]", msg);
    if (cache) return c.json({ ...cache, cached: true, error: msg });
    return c.json({ error: msg }, 502);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Usage series — token + shadow-cost history.
 *
 *   GET /api/usage/series   → hourly (24h), daily (30d), weekly (~12w)
 *   GET /api/usage/rate     → the EUR-per-USD display rate and where it came from
 *   PUT /api/usage/rate     → set it (0.1..10)
 *
 * Every series reads `usage_hourly` and ONLY `usage_hourly`. The table is
 * written once an hour by lib/usage-sampler.ts. Nothing here touches `runs` or
 * `spend_log`: a chart polled by an always-open dashboard must not fold a
 * growing JSONB table on every request — that read-time-aggregation shape is
 * what made the Live panel bog the machine down, and this endpoint is the
 * place it would have come back.
 *
 * Consequence worth stating rather than hiding: the series is only as fresh as
 * the last closed hour, so `sampled_through` is returned and the UI is expected
 * to say "through 13:00" instead of implying live numbers.
 * ═══════════════════════════════════════════════════════════════════════════ */

const { Pool } = pg;

let seriesPool: pg.Pool | null = null;

/** Own lazy pool, same DSN as the sampler. Lazy so importing this router (the
 *  single-router probe harness does exactly that) never opens a socket until a
 *  request needs one. */
function db(): Querier {
  if (!seriesPool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. usage_hourly lives in content_forge " +
          "(127.0.0.1:5432); /api/usage/series refuses to guess a DSN.",
      );
    }
    seriesPool = new Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    seriesPool.on("error", (e) => console.error("[usage/series pool]", e.message));
  }
  return seriesPool;
}

interface SeriesPoint {
  bucket_start: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  shadow_usd: number;
  eur: number;
  run_count: number;
}

interface SeriesRow {
  bucket_start: Date | string;
  tokens_in: string;
  tokens_out: string;
  cache_read: string;
  cache_write: string;
  shadow_usd: string;
  run_count: string;
}

function toPoint(row: SeriesRow, eurPerUsd: number): SeriesPoint {
  const usd = Number(row.shadow_usd);
  return {
    bucket_start:
      row.bucket_start instanceof Date
        ? row.bucket_start.toISOString()
        : new Date(row.bucket_start).toISOString(),
    tokens_in: Number(row.tokens_in),
    tokens_out: Number(row.tokens_out),
    cache_read: Number(row.cache_read),
    cache_write: Number(row.cache_write),
    shadow_usd: usd,
    eur: usdToEur(usd, eurPerUsd),
    run_count: Number(row.run_count),
  };
}

/** Roll usage_hourly up to a coarser grain. `grain` is a compile-time literal
 *  from the two call sites below — never request input — so it is safe inline. */
function rollupSql(grain: "day" | "week"): string {
  return `SELECT date_trunc('${grain}', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
                 COALESCE(SUM(tokens_in), 0)::text   AS tokens_in,
                 COALESCE(SUM(tokens_out), 0)::text  AS tokens_out,
                 COALESCE(SUM(cache_read), 0)::text  AS cache_read,
                 COALESCE(SUM(cache_write), 0)::text AS cache_write,
                 COALESCE(SUM(shadow_usd), 0)::text  AS shadow_usd,
                 COALESCE(SUM(run_count), 0)::text   AS run_count
            FROM usage_hourly
           WHERE bucket_start >= $1::timestamptz
           GROUP BY 1
           ORDER BY 1`;
}

r.get("/series", async (c) => {
  try {
    const q = db();
    const rate = await getRate(q);
    const now = Date.now();
    // Hour buckets are UTC; date_trunc('week') is ISO (Monday-start) in
    // Postgres, which is what "ISO weeks" means on the UI side too.
    const from24h = new Date(now - 24 * 3_600_000).toISOString();
    const from30d = new Date(now - 30 * 24 * 3_600_000).toISOString();
    const from12w = new Date(now - 12 * 7 * 24 * 3_600_000).toISOString();

    const [hourly, daily, weekly, through] = await Promise.all([
      q.query<SeriesRow>(
        `SELECT bucket_start,
                tokens_in::text, tokens_out::text, cache_read::text,
                cache_write::text, shadow_usd::text, run_count::text
           FROM usage_hourly
          WHERE bucket_start >= $1::timestamptz
          ORDER BY bucket_start`,
        [from24h],
      ),
      q.query<SeriesRow>(rollupSql("day"), [from30d]),
      q.query<SeriesRow>(rollupSql("week"), [from12w]),
      q.query<{ max: Date | string | null }>(
        `SELECT MAX(bucket_start) AS max FROM usage_hourly`,
      ),
    ]);

    const maxBucket = through.rows[0]?.max ?? null;
    return c.json({
      hourly: hourly.rows.map((row) => toPoint(row, rate.eur_per_usd)),
      daily: daily.rows.map((row) => toPoint(row, rate.eur_per_usd)),
      weekly: weekly.rows.map((row) => toPoint(row, rate.eur_per_usd)),
      eur_per_usd: rate.eur_per_usd,
      rate_source: rate.source,
      // The rule the numbers obey, shipped with them so the UI can print it
      // instead of the reader guessing why a long run is one spike.
      attribution: ATTRIBUTION,
      // Newest closed hour on record. null on a database where the sampler has
      // never run — an empty chart with a reason beats an empty chart.
      sampled_through:
        maxBucket === null
          ? null
          : maxBucket instanceof Date
            ? maxBucket.toISOString()
            : new Date(maxBucket).toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[usage/series]", msg);
    return c.json({ error: msg }, 500);
  }
});

r.get("/rate", async (c) => {
  try {
    const rate = await getRate(db());
    return c.json({ ...rate, default_eur_per_usd: DEFAULT_EUR_PER_USD });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[usage/rate]", msg);
    return c.json({ error: msg }, 500);
  }
});

r.put("/rate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON: {\"eur_per_usd\": <number>}" }, 400);
  }
  const value =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>).eur_per_usd
      : undefined;
  try {
    const rate = await setRate(value, db());
    return c.json({ ...rate, default_eur_per_usd: DEFAULT_EUR_PER_USD });
  } catch (e) {
    // A bad number is the caller's fault (400); anything else is ours (500).
    if (e instanceof RateValidationError) {
      return c.json({ error: e.message }, 400);
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[usage/rate PUT]", msg);
    return c.json({ error: msg }, 500);
  }
});

export default r;
