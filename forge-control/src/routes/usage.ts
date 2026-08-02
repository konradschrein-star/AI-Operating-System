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

export default r;
