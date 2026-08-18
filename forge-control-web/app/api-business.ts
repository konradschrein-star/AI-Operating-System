/**
 * Typed client for the `business` lane's surfaces (Pipeline, Businesses).
 *
 * WHY THIS FILE EXISTS AND NOT `api.ts`: `app/api.ts` is the one contended
 * file in this project — every workstream would otherwise edit it at once and
 * the conflict would only surface at integration (02-architecture.md §0.3).
 * So this lane owns `api-business.ts` exclusively and `api.ts` is not touched.
 * It deliberately re-declares its own fetch helper rather than importing one:
 * `api.ts`'s `getJson` is module-private, and exporting it would be an edit to
 * the contended file.
 *
 * The shapes mirror `forge-control/src/db/pipeline.ts` and
 * `forge-control/src/lib/redis-probe.ts`. Where the server publishes a
 * discriminated union, so does this file — a client that flattened
 * `{ok: false, error}` into optional fields would put the "unreachable renders
 * as unreachable, never as zero" rule (R66/R67/N1) back in the caller's hands.
 */

const ROOT = "/api/proxy";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

/* ----------------------------------------------------------------------------
 * Pipeline — content_jobs grouped by phase, with stall ages, worker health and
 * queue depth (R64–R67).
 * -------------------------------------------------------------------------- */

export interface BusinessPipelineCard {
  id: string;
  title: string;
  status: string;
  format: string;
  channel: string;
  template: string;
  /** Pre-rendered short age, e.g. `14d`. */
  age: string;
  updated_at: string;
  /** Raw `content_jobs.status_updated_at`, for a client-side age if wanted. */
  status_updated_at: string;
  /** No status change for longer than `stall_threshold_hours`. */
  stalled: boolean;
  /** Whole days since `status_updated_at` — reported stalled or not. */
  stall_days: number;
}

/**
 * Why a column is empty is not one fact but two:
 *  - `no_work_idle`             — nothing here and nothing upstream;
 *  - `no_work_blocked_upstream` — nothing here because work is stuck earlier.
 * Render `state_reason`; it is written as a sentence for exactly this reason.
 */
export type BusinessPhaseState = "has_work" | "no_work_idle" | "no_work_blocked_upstream";

export interface BusinessPipelinePhase {
  key: string;
  label: string;
  description: string;
  statuses: string[];
  /** TRUE count of matching jobs, NOT `cards.length` and NOT a cap. */
  count: number;
  stalled_count: number;
  state: BusinessPhaseState;
  state_reason: string;
  /** A preview capped at `card_limit_per_phase`, newest first. */
  cards: BusinessPipelineCard[];
  /** `count` exceeds what `cards` shows — say so rather than implying `count`. */
  cards_truncated: boolean;
}

export interface WorkerHealth {
  name: string;
  /** pm2's own word: `online`, `stopped`, `errored`, … */
  status: string;
  /** null when pm2 reports no start time (i.e. not running). Never 0. */
  uptime_ms: number | null;
  restarts: number;
}

export type WorkerHealthResult =
  | {
      ok: true;
      as_of: string;
      workers: WorkerHealth[];
      online: number;
      expected: string[];
      /** Expected processes pm2 has never heard of. Absent ≠ stopped. */
      missing: string[];
    }
  | { ok: false; as_of: string; expected: string[]; error: string };

export interface QueueSetDepth {
  /** `wait` | `active` | `delayed` | `failed` | `completed` | `paused`. */
  set: string;
  key: string;
  /** Verbatim redis TYPE reply: `list`, `zset`, `none`, … */
  redis_type: string;
  /** Entry count, or null when the key holds nothing countable — ABSENT, never 0. */
  depth: number | null;
}

export interface QueueDepth {
  queue: string;
  sets: QueueSetDepth[];
}

/**
 * Every live queue currently reads `wait: 0` / `active: 0` (measured), so a
 * WORKING probe returns zeroes. That is why this is a union: `ok: false` is
 * the only honest rendering of an unreachable redis, and it must never be
 * confused with the real zeroes carried by `ok: true`.
 */
export type QueueProbeResult =
  | {
      ok: true;
      as_of: string;
      endpoint: string;
      probed_queues: number;
      queues: QueueDepth[];
    }
  | { ok: false; as_of: string; endpoint: string; error: string };

export interface BusinessPipelineResponse {
  as_of: string;
  /** The threshold the server used. Label with this, never with a literal 48. */
  stall_threshold_hours: number;
  stall_cutoff: string;
  phases: BusinessPipelinePhase[];
  /** TRUE total of non-deleted jobs. */
  total: number;
  stalled_total: number;
  card_limit_per_phase: number;
  card_query_limit: number;
  /** Equal to `card_query_limit` means the card query itself hit its cap. */
  card_rows_scanned: number;
  workers: WorkerHealthResult;
  queues: QueueProbeResult;
}

export const fetchPipelineBusiness = () =>
  getJson<BusinessPipelineResponse>("/pipeline");
