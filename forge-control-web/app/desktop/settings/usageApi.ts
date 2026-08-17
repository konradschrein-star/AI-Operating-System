/**
 * usageApi — fetchers and axis maths for the credit tracker (round 1352).
 *
 * Shapes mirror forge-control/src/routes/usage.ts EXACTLY, read from the code
 * rather than from a brief: `/usage/series` also returns `rate_source`, which
 * the spec for this round did not mention, and the panel prints it.
 *
 * Two things live here rather than in the panel:
 *
 *   • the error path. A 400 from PUT /usage/rate carries the reason the number
 *     was rejected (`{"error": "eur_per_usd must be between 0.1 and 10, got
 *     50"}`). It is thrown verbatim, because "invalid rate" tells Konrad
 *     nothing the server had already worked out.
 *
 *   • `alignSlots`, the reason the charts can be honest. The API returns ONLY
 *     the buckets the sampler actually wrote — an hour with no runs, or an
 *     hour the sampler missed, is simply absent from the array. Plotting that
 *     array left-to-right would silently close the hole and draw a continuous
 *     history nobody sampled. `alignSlots` lays the points onto a continuous
 *     grid and leaves `null` where there is no reading, so the chart can draw
 *     a gap. Never interpolate a bucket nobody measured.
 *
 * Everything here is pure except the three fetchers, so the axis behaviour is
 * inspectable without a DOM.
 */

const ROOT = "/api/proxy";

/* ── payload shapes (routes/usage.ts) ─────────────────────────────────────── */

export interface UsagePoint {
  /** Inclusive start of the bucket, UTC ISO. Hour / UTC-day / ISO-week. */
  bucket_start: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  /** USD, the stored truth. EUR is a display conversion — see `eurOf`. */
  shadow_usd: number;
  /** Server-side conversion at the rate in force when the request was served. */
  eur: number;
  run_count: number;
}

export interface UsageSeries {
  hourly: UsagePoint[];
  daily: UsagePoint[];
  weekly: UsagePoint[];
  eur_per_usd: number;
  rate_source: RateSource;
  /** The rule the numbers obey, printed as-is. Today: "tokens land in the
   *  hour of the run's last billed turn, usually once — a run idling >=2h
   *  then resuming can be double-counted; cost is per turn, never double-
   *  counted". Never hardcode it here — the server stamps the rule that
   *  actually produced the buckets, and it has changed twice already: round
   *  1354 replaced "counted at run completion" (a fold that counted a run in
   *  every hour it touched), and round 1355 replaced "counted once" (still an
   *  overclaim — see usage-sampler.ts's KNOWN EXCEPTION note by LINKED).
   *  Buckets written under an older rule still carry that rule's string. */
  attribution: string;
  /** Newest closed hour on record; null on a database the sampler never ran on. */
  sampled_through: string | null;
}

export type RateSource = "app_settings" | "default";

export interface RateSetting {
  eur_per_usd: number;
  source: RateSource;
  updated_at: string | null;
  default_eur_per_usd: number;
}

export interface QuotaWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface QuotaSnapshot {
  five_hour: QuotaWindow;
  seven_day: QuotaWindow;
  seven_day_opus: QuotaWindow | null;
  fetched_at: string;
  cached?: boolean;
  error?: string;
  /** Present while the upstream 429 cooldown is running. */
  retry_in_ms?: number;
}

/* ── fetchers ─────────────────────────────────────────────────────────────── */

/** Pull the server's own message out of an error body instead of reporting a
 *  bare status code. routes/usage.ts answers `{error: string}` on every
 *  failure path it owns, and that string is the diagnosis. */
async function failure(res: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = ` — ${body.error}`;
  } catch {
    /* not JSON: the status line is all there is */
  }
  return new Error(`${what} failed: ${res.status} ${res.statusText}${detail}`);
}

export async function fetchUsageSeries(): Promise<UsageSeries> {
  const res = await fetch(`${ROOT}/usage/series`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await failure(res, "GET /usage/series");
  return (await res.json()) as UsageSeries;
}

export async function fetchUsageRate(): Promise<RateSetting> {
  const res = await fetch(`${ROOT}/usage/rate`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await failure(res, "GET /usage/rate");
  return (await res.json()) as RateSetting;
}

export async function putUsageRate(eurPerUsd: number): Promise<RateSetting> {
  const res = await fetch(`${ROOT}/usage/rate`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eur_per_usd: eurPerUsd }),
  });
  if (!res.ok) throw await failure(res, "PUT /usage/rate");
  return (await res.json()) as RateSetting;
}

/** `fresh` bypasses the server's 60s cache — the panel's refresh button. */
export async function fetchUsageQuota(fresh = false): Promise<QuotaSnapshot> {
  const res = await fetch(`${ROOT}/usage/quota${fresh ? "?fresh=1" : ""}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await failure(res, "GET /usage/quota");
  return (await res.json()) as QuotaSnapshot;
}

/* ── conversion ───────────────────────────────────────────────────────────── */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/**
 * USD → EUR at the rate on screen, rounded exactly as `usdToEur` in
 * forge-control/src/lib/usage-sampler.ts rounds it (4 decimals).
 *
 * The panel converts client-side rather than reading `point.eur` so that
 * editing the rate re-prices every figure on screen in the same tick as the
 * PUT resolves. Same input, same formula, same rounding as the server — the
 * two agree; they must, or the panel and /api/spend would disagree about one
 * number, which is exactly the bug DEFAULT_EUR_PER_USD exists to prevent.
 */
export function eurOf(usd: number, eurPerUsd: number): number {
  return Math.round(usd * eurPerUsd * 10_000) / 10_000;
}

/** Every token category the sampler records. Cache reads dominate this sum by
 *  an order of magnitude and that is not a bug: they are what the fleet
 *  actually moves. The per-bucket tooltip breaks the four apart. */
export function totalTokens(p: UsagePoint): number {
  return p.tokens_in + p.tokens_out + p.cache_read + p.cache_write;
}

/* ── axis ─────────────────────────────────────────────────────────────────── */

export interface Slot {
  /** Bucket start, ms since epoch. Always on the grain's grid. */
  start: number;
  /** null = nobody sampled this bucket. Draw a gap; do not interpolate. */
  point: UsagePoint | null;
}

/**
 * Lay sampled points onto a continuous grid of `stepMs` buckets ending at
 * `anchor` (the newest slot's start, already floored to the grain).
 *
 * `minCount` is the window the panel promises — 24 hours, 30 days. If the API
 * hands back points OLDER than that window the grid grows to include them
 * rather than dropping them: a chart labelled "last 24h" may show 24 slots,
 * but it must never quietly discard a bucket the server sent.
 *
 * Points that do not sit on the grid are a contract violation by the server
 * (routes/usage.ts truncates every bucket), so they throw rather than being
 * rounded to a neighbour — a misaligned bucket drawn in the wrong hour is a
 * lie that looks like data.
 */
export function alignSlots(
  points: readonly UsagePoint[],
  stepMs: number,
  anchor: number,
  minCount: number,
): Slot[] {
  const byStart = new Map<number, UsagePoint>();
  let oldest = anchor;
  // The newest slot is normally `anchor` (the grain the clock is in), but a
  // bucket newer than that — a machine whose clock trails the database's — is
  // still real data and gets a slot rather than vanishing off the right edge.
  let newest = anchor;
  for (const p of points) {
    const t = Date.parse(p.bucket_start);
    if (Number.isNaN(t)) {
      throw new Error(
        `usage bucket_start is not a date: ${JSON.stringify(p.bucket_start)}`,
      );
    }
    if ((anchor - t) % stepMs !== 0) {
      throw new Error(
        `usage bucket ${p.bucket_start} is not aligned to the ${stepMs}ms grain ` +
          `anchored at ${new Date(anchor).toISOString()}; refusing to plot it in ` +
          "a neighbouring slot",
      );
    }
    byStart.set(t, p);
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  const spanned = Math.floor((newest - oldest) / stepMs) + 1;
  const count = Math.max(minCount, spanned);
  const slots: Slot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = newest - i * stepMs;
    slots.push({ start, point: byStart.get(start) ?? null });
  }
  return slots;
}

/** Newest slot start for a grain, floored in UTC — the same truncation
 *  `date_trunc(… AT TIME ZONE 'UTC')` performs server-side. Weeks are
 *  Monday-start, because Postgres' `date_trunc('week')` is ISO. */
export function anchorFor(grain: "hour" | "day" | "week", nowMs: number): number {
  if (grain === "hour") return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const day = Math.floor(nowMs / DAY_MS) * DAY_MS;
  if (grain === "day") return day;
  // 1970-01-01 was a Thursday; step back to the Monday of this UTC week.
  const dow = new Date(day).getUTCDay(); // 0=Sun … 6=Sat
  const sinceMonday = (dow + 6) % 7;
  return day - sinceMonday * DAY_MS;
}

/* ── formatting ───────────────────────────────────────────────────────────── */

/** Compact token counts: 84.9k, 2.43M, 1.2G. Full precision lives in the
 *  tooltip; a bar label with nine digits is unreadable. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtExact(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtEur(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `€${n.toFixed(n >= 100 ? 0 : 2)}`;
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** UTC labels, on purpose. Buckets are truncated in UTC server-side; printing
 *  them in Europe/Berlin would shift every bar two hours off the hour it
 *  actually covers. The axis says UTC so the reader knows. */
export function labelFor(grain: "hour" | "day" | "week", startMs: number): string {
  const d = new Date(startMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (grain === "hour") return `${hh}:00`;
  if (grain === "day") return `${dd}.${mm}`;
  return `w/c ${dd}.${mm}`;
}

/** Full UTC stamp for tooltips — "16.08 05:00 UTC". */
export function stampFor(startMs: number): string {
  const d = new Date(startMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00 UTC`;
}

/** "3m ago" / "2h ago" — how old a reading is, in the vocabulary QuotaBars
 *  and QuotaStrip already use. */
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
