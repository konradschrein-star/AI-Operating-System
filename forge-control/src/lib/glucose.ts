/**
 * Blood glucose from FreeStyle Libre via LibreLinkUp.
 *
 * Shells out to `/opt/ai-os/libre/libre_api.py`, which wraps Konrad's own
 * connector. Same arrangement as calendar.ts and google_api.py: one place owns
 * the credentials, the session and the backoff.
 *
 * ── The rate limit is the whole design constraint ─────────────────────────
 * Abbott answers repeated logins with **HTTP 476 / Retry-After: 86400** — a
 * 24-hour block, and three logins in two minutes was enough to trigger it
 * (measured 2026-08-25). The bridge therefore caches its bearer token and
 * refuses locally while a block is live. Nothing here should retry a
 * `rate_limited` result: retrying through the limit is how a day's block
 * becomes a longer one.
 *
 * The poll interval is deliberately slack. A Libre sensor produces a reading
 * every 15 minutes and the graph endpoint returns a rolling ~12h window, so a
 * 15-minute poll loses nothing and a missed poll costs nothing — the next one
 * back-fills everything.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const DEFAULT_LIBRE_SCRIPT = "/opt/ai-os/libre/libre_api.py";

export interface GlucoseReading {
  taken_at: string;
  value_mgdl: number;
  value_mmol: number;
  measurement_color: number | null;
  is_high: boolean;
  is_low: boolean;
  trend_id: number | null;
  trend_symbol?: string;
}

export interface GlucoseSyncPayload {
  latest: GlucoseReading;
  graph: GlucoseReading[];
}

export class GlucoseRateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlucoseRateLimited";
  }
}

/**
 * One session, both payloads. Asking for `latest` and `graph` separately would
 * double the login rate for no benefit.
 */
export async function fetchGlucose(
  opts: { scriptPath?: string; timeoutMs?: number } = {},
): Promise<GlucoseSyncPayload> {
  const script = opts.scriptPath ?? process.env.LIBRE_SCRIPT_PATH ?? DEFAULT_LIBRE_SCRIPT;

  let stdout: string;
  try {
    const r = await execFileAsync("python3", [script, "sync"], {
      timeout: opts.timeoutMs ?? 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = r.stdout.trim();
  } catch (err: unknown) {
    // The bridge exits non-zero on a handled failure but still prints its JSON
    // on stdout, so read that before treating this as a crash.
    const e = err as Error & { stdout?: string; stderr?: string };
    const out = (e.stdout ?? "").trim();
    if (out) {
      stdout = out;
    } else {
      throw new Error(`libre_api.py failed: ${e.stderr?.trim() || e.message}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`libre_api.py returned non-JSON: ${stdout.slice(0, 300)}`);
  }

  const obj = parsed as { error?: string; code?: string } & Partial<GlucoseSyncPayload>;
  if (obj.error) {
    if (obj.code === "rate_limited") throw new GlucoseRateLimited(obj.error);
    throw new Error(obj.error);
  }
  if (!obj.latest || !Array.isArray(obj.graph)) {
    throw new Error(`libre_api.py returned an unexpected shape: ${stdout.slice(0, 200)}`);
  }
  return { latest: obj.latest, graph: obj.graph };
}
