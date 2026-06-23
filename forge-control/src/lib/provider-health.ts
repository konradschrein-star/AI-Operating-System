/**
 * Provider health poller. Hits a configurable list of HTTP health endpoints
 * concurrently, classifies each into a degradation tier, returns the shape
 * the Live screen expects.
 *
 * In-process cache with TTL so the Live screen polling every few seconds
 * doesn't fan out into a probe storm against shared upstreams.
 *
 * Provider list: env `FORGE_HEALTH_PROVIDERS=name|url[|kind],…` (comma-sep).
 * `kind` is optional; defaults to `internal`. If unset, falls back to the
 * known VPS-local probes.
 */

export type Tier = "L0" | "L1" | "L2" | "L3" | "L4";

export interface ProviderStatus {
  name: string;
  badge: string;
  status: "ok" | "warn" | "error";
  tier: Tier;
  why: string | null;
  latency_ms: number;
}

interface ProviderSpec {
  name: string;
  url: string;
  kind: "internal" | "external";
}

const DEFAULT_PROVIDERS: ProviderSpec[] = [
  { name: "claude-pool", url: "http://127.0.0.1:8092/health", kind: "internal" },
  { name: "gemini-pool", url: "http://127.0.0.1:8090/health", kind: "internal" },
  { name: "hub-web", url: "http://127.0.0.1:3000/api/health", kind: "internal" },
  { name: "hermes-workspace", url: "http://127.0.0.1:3010/health", kind: "internal" },
];

function parseProviderEnv(raw: string | undefined): ProviderSpec[] | null {
  if (!raw) return null;
  const out: ProviderSpec[] = [];
  for (const entry of raw.split(",")) {
    const parts = entry.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;
    const [name, url, kindRaw] = parts;
    if (!name || !url) continue;
    const kind = kindRaw === "external" ? "external" : "internal";
    out.push({ name, url, kind });
  }
  return out.length > 0 ? out : null;
}

const PROVIDERS: ProviderSpec[] =
  parseProviderEnv(process.env.FORGE_HEALTH_PROVIDERS) ?? DEFAULT_PROVIDERS;

const PROBE_TIMEOUT_MS = Number(process.env.FORGE_HEALTH_TIMEOUT_MS ?? "3000");
const CACHE_TTL_MS = Number(process.env.FORGE_HEALTH_CACHE_TTL_MS ?? "15000");

interface CacheEntry {
  at: number;
  data: ProviderStatus[];
}
let cache: CacheEntry | null = null;

function classify(
  status: number,
  latencyMs: number,
): Pick<ProviderStatus, "status" | "tier" | "why"> {
  if (status >= 200 && status < 300) {
    return { status: "ok", tier: "L0", why: null };
  }
  if (status === 429) {
    return { status: "warn", tier: "L2", why: "rate-limited (429)" };
  }
  if (status === 503) {
    return { status: "error", tier: "L3", why: "service unavailable (503)" };
  }
  if (status >= 500) {
    return {
      status: "error",
      tier: "L4",
      why: `upstream ${status}`,
    };
  }
  if (status >= 400) {
    return {
      status: "warn",
      tier: "L2",
      why: `unexpected ${status} (latency ${latencyMs}ms)`,
    };
  }
  return { status: "error", tier: "L4", why: `non-standard ${status}` };
}

async function probeOne(p: ProviderSpec): Promise<ProviderStatus> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(p.url, {
      method: "GET",
      signal: ac.signal,
      // Internal probes don't need credentials; external probes get the
      // same treatment — providers needing auth headers would be a future
      // ProviderSpec extension.
    });
    const ms = Date.now() - t0;
    const c = classify(res.status, ms);
    return {
      name: p.name,
      badge: `${res.status} ${ms}ms`,
      latency_ms: ms,
      ...c,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      name: p.name,
      badge: aborted ? `timeout ${ms}ms` : `unreachable ${ms}ms`,
      latency_ms: ms,
      status: "error",
      tier: "L4",
      why: aborted ? "probe timed out" : "connection refused",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the full provider status table, possibly from cache. */
export async function getProviderHealth(): Promise<ProviderStatus[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await Promise.all(PROVIDERS.map(probeOne));
  cache = { at: now, data };
  return data;
}

/** Force a refresh — used by callers that just took an action they want
 *  reflected immediately (e.g. just restarted a service). */
export function invalidateProviderHealthCache(): void {
  cache = null;
}
