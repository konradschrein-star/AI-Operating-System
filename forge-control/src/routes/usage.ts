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
 *
 * ROUND 1876 — the response also carries `gemini`, a SELF-TALLY (calls and
 * tokens we counted), because the whole indicator row is one request now. See
 * the `GeminiTally` block below for why it is a count and not a bar.
 */

import { Hono } from "hono";
import { access, readFile } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
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

/* ── Gemini: a tally, never a percentage ─────────────────────────────────────
 *
 * Konrad wants his Google subscription in the same indicator row as the Claude
 * windows. It CANNOT be a bar. Round 1302's research (docs/plan/
 * operator-visibility/artifacts/phase1700/gemini-ultra-oauth.md §3.1-§3.4)
 * established that Google publishes no quota surface for a consumer AI Ultra
 * subscription: the Gemini API discovery document has no quota resource, the
 * Code Assist path that once carried one was switched off on 2026-06-18, and
 * the only place a remaining-credit number exists is inside the Antigravity
 * CLI's own TUI. There is no denominator to divide by, so this reports what WE
 * counted and says so — §3.4 option 1.
 *
 * It rides the /quota response ON PURPOSE. The indicator row is one row, and a
 * second endpoint behind it would be a second poll on its own timer — which is
 * precisely the duplication this round exists to delete.
 * ────────────────────────────────────────────────────────────────────────── */

interface GeminiWindowTally {
  /** Calls WE logged to spend_log in the window. Never null: zero rows is a
   *  real answer ("we made no Gemini calls"), unlike a failed query. */
  calls: number;
  /** Tokens WE counted, from spend_log.units on the token-priced kinds. Null
   *  when rows exist but none carried a unit count — "we called it N times and
   *  nobody recorded how many tokens" is a different sentence from "0 tokens". */
  tokens: number | null;
}

export interface GeminiTally {
  /** `agy` on PATH — the CLI that carries the Ultra entitlement. */
  cli_installed: boolean;
  /** A local `agy` profile exists. The session itself lives in the OS keyring
   *  (Linux Secret Service), which no HTTP handler may open, so this is the
   *  furthest an honest probe gets without launching the CLI. */
  cli_profile: boolean;
  /** One line, rendered verbatim: what state the sign-in is actually in. */
  auth_note: string;
  /** The exact thing to type to sign in. Null once a profile exists. */
  connect_command: string | null;
  five_hour: GeminiWindowTally | null;
  seven_day: GeminiWindowTally | null;
  /** Set when spend_log could not be read. A tally we could not compute is an
   *  error, NEVER a zero. */
  error?: string;
  /** Why there is no percentage. Shipped next to the number so the sentence
   *  and the thing it describes cannot drift apart. */
  no_limit_note: string;
}

/** Where the Antigravity CLI keeps its settings on Linux —
 *  `~/.gemini/antigravity-cli/settings.json` per antigravity.google/docs/cli/
 *  install. Read per call, not once at import, for the same reason `PATH` is:
 *  the CLI can be installed and signed into while this process is running, and
 *  a value frozen at boot would keep reporting the state of an hour ago. */
function agySettingsPath(): string {
  return (
    process.env.AGY_SETTINGS_PATH ??
    join(process.env.HOME ?? "/root", ".gemini/antigravity-cli/settings.json")
  );
}

const NO_LIMIT_NOTE =
  "Google publishes no quota endpoint for an AI Ultra subscription — no denominator exists, so this is our own count, not a share of a limit.";

/** Token-priced spend kinds. `units` on an image or TTS row is images/seconds,
 *  and summing those into a token figure would be a fabricated number. */
const TOKEN_KINDS = ["llm_input", "llm_output", "embedding"];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `agy` on PATH, resolved by hand: no shell, no `which`, no spawn. */
async function agyOnPath(): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    if (await exists(join(dir, "agy"))) return true;
  }
  return false;
}

interface GeminiTallyRow {
  calls_5h: string;
  tokens_5h: string | null;
  calls_7d: string;
  tokens_7d: string | null;
}

function tallyWindow(calls: string, tokens: string | null): GeminiWindowTally {
  return {
    calls: Number(calls),
    tokens: tokens === null ? null : Number(tokens),
  };
}

let geminiCache: GeminiTally | null = null;
let geminiCacheAt = 0;

/** Cached on the same 60s beat as the quota reading, so a dashboard polling
 *  /quota every 120s runs at most one aggregate per poll. */
async function geminiTally(fresh: boolean): Promise<GeminiTally> {
  if (!fresh && geminiCache && Date.now() - geminiCacheAt < CACHE_MS) {
    return geminiCache;
  }

  const settingsPath = agySettingsPath();
  const cliInstalled = await agyOnPath();
  const cliProfile = cliInstalled ? await exists(settingsPath) : false;
  const auth_note = !cliInstalled
    ? "Antigravity CLI (agy) is not installed on this box, so the Ultra subscription has never been signed in here."
    : !cliProfile
      ? `agy is installed but has no local profile (${settingsPath} is absent) — run it once to sign in.`
      : "agy has a local profile; the session lives in the OS keyring and cannot be read from here, so this is still our own count.";

  const base: Omit<GeminiTally, "five_hour" | "seven_day"> = {
    cli_installed: cliInstalled,
    cli_profile: cliProfile,
    auth_note,
    connect_command: cliProfile
      ? null
      : cliInstalled
        ? "agy   # then paste the printed URL into a browser and enter the code back in the terminal (the SSH sign-in flow)"
        : "install the Antigravity CLI, then run `agy` once to sign in",
    no_limit_note: NO_LIMIT_NOTE,
  };

  let tally: GeminiTally;
  try {
    const res = await db().query<GeminiTallyRow>(
      `SELECT count(*) FILTER (WHERE created_at >= now() - interval '5 hours')::text AS calls_5h,
              sum(units) FILTER (WHERE created_at >= now() - interval '5 hours'
                                   AND kind = ANY($1::text[]))::text                 AS tokens_5h,
              count(*) FILTER (WHERE created_at >= now() - interval '7 days')::text  AS calls_7d,
              sum(units) FILTER (WHERE created_at >= now() - interval '7 days'
                                   AND kind = ANY($1::text[]))::text                 AS tokens_7d
         FROM spend_log
        WHERE provider ILIKE 'gemini%'
          AND created_at >= now() - interval '7 days'`,
      [TOKEN_KINDS],
    );
    const row = res.rows[0];
    tally = row
      ? {
          ...base,
          five_hour: tallyWindow(row.calls_5h, row.tokens_5h),
          seven_day: tallyWindow(row.calls_7d, row.tokens_7d),
        }
      : // An aggregate with no GROUP BY always returns one row; if Postgres ever
        // returns none, that is a broken assumption, not an empty window.
        {
          ...base,
          five_hour: null,
          seven_day: null,
          error: "spend_log returned no aggregate row — the tally is unknown, not zero",
        };
  } catch (err) {
    tally = {
      ...base,
      five_hour: null,
      seven_day: null,
      error: `spend_log is unreachable — the Gemini tally is unknown, not zero: ${(err as Error).message}`,
    };
  }

  geminiCache = tally;
  geminiCacheAt = Date.now();
  return tally;
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
  /* Computed once, attached to EVERY branch below. The Gemini tally must
   * survive an Anthropic 429 or a cold cache: those are two different
   * upstreams and one failing is no reason for the other's number to vanish
   * from the row. `geminiTally` never throws — it returns its own `error`. */
  const gemini = await geminiTally(fresh);
  if (!fresh && cache && age < CACHE_MS) {
    return c.json({ ...cache, gemini, cached: true, age_ms: age });
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
      gemini,
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
    return c.json({ ...snap, gemini, cached: false, age_ms: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[usage/quota]", msg);
    if (cache) return c.json({ ...cache, gemini, cached: true, error: msg });
    return c.json({ error: msg, gemini }, 502);
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
