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
  /** `users.name` for `content_jobs.assigned_production_va_id`, or null if unassigned. */
  production_va_name: string | null;
  /** `users.name` for `content_jobs.assigned_uploader_va_id`, or null if unassigned. */
  uploader_va_name: string | null;
  /** bigint column — node-postgres hands bigints back as strings. Null pre-render. */
  final_video_size_bytes: string | null;
  final_video_duration_seconds: number | null;
  render_completed_at: string | null;
  /** Populated on FAILED_* statuses; null otherwise. */
  error_message: string | null;
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
  /** null when pm2 omits `restart_time`. Never 0 — a 0 would claim "never restarted". */
  restarts: number | null;
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

/* ----------------------------------------------------------------------------
 * Entities — identity registry summary and listings (ai_os :5434).
 * -------------------------------------------------------------------------- */

export interface EntitySummaryRow {
  arm: string;
  kind: string;
  count: number;
}

export interface EntityArmSummary {
  arm: string;
  total: number;
  companies: number;
  persons: number;
}

export interface EntitiesSummaryResponse {
  total: number;
  by_arm_and_kind: EntitySummaryRow[];
  by_arm: Record<string, { total: number; companies: number; persons: number }>;
  arms: EntityArmSummary[];
  as_of: string;
}

export interface EntityRecord {
  id: string;
  kind: "person" | "company";
  displayName: string;
  arm: "directory" | "axtrelis" | "youtube" | "infra" | "personal" | "other";
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntitiesListResponse {
  entities: EntityRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface FetchEntitiesParams {
  arm?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export const fetchEntitiesSummary = () =>
  getJson<EntitiesSummaryResponse>("/entities/summary");

export const fetchEntities = (params: FetchEntitiesParams = {}) => {
  const query = new URLSearchParams();
  if (params.arm) query.set("arm", params.arm);
  if (params.kind) query.set("kind", params.kind);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const qs = query.toString();
  return getJson<EntitiesListResponse>(`/entities${qs ? `?${qs}` : ""}`);
};

/* ----------------------------------------------------------------------------
 * Cash Ledger — net cashflow and financial breakdown by arm (ai_os :5434).
 * -------------------------------------------------------------------------- */

export interface LedgerArmTotals {
  arm: string;
  inEur: number;
  outEur: number;
  netEur: number;
  entries: number;
}

export interface LedgerSummary {
  since: string;
  until: string;
  byArm: LedgerArmTotals[];
  totalInEur: number;
  totalOutEur: number;
  netEur: number;
  shadowEur: number;
  unconvertedRows: number;
}

export interface LedgerSummaryResponse {
  summary: LedgerSummary;
}

export const fetchLedgerSummary = (days?: number) => {
  const qs = days !== undefined ? `?days=${encodeURIComponent(days)}` : "";
  return getJson<LedgerSummaryResponse>(`/ledger/summary${qs}`);
};

/* ----------------------------------------------------------------------------
 * Bank Accounts & Treasury — Mercury 3x + E&G Private Bank balances.
 * -------------------------------------------------------------------------- */

export type BankAccountStatus = "active" | "unlinked" | "error" | "manual";
export type BankAccountType =
  | "checking"
  | "savings"
  | "treasury"
  | "private_banking";

export interface BankAccount {
  id: string;
  name: string;
  institution: "mercury" | "eg_bank" | "other";
  account_number_mask: string | null;
  type: BankAccountType;
  currency: "USD" | "EUR";
  current_balance: number;
  available_balance: number;
  balance_usd: number;
  balance_eur: number;
  status: BankAccountStatus;
  status_detail: string | null;
  last_synced_at: string | null;
}

export interface BankBalancesResponse {
  connected: boolean;
  mercury: {
    connected: boolean;
    credential_required: boolean;
    secret_name: string;
    accounts: BankAccount[];
    error: string | null;
  };
  eg_bank: BankAccount;
  accounts: BankAccount[];
  total_liquid_eur: number;
  total_usd: number;
  fx_rate_usd_eur: number;
  /** `static_fallback` = a constant in forge-control, not a quote. Render the
   *  qualifier: a converted balance from a made-up rate is a fabricated
   *  figure, and reads exactly like a measured one. */
  fx_rate_source: "static_fallback" | "live_quote";
  as_of: string;
}

export const fetchBankAccounts = () =>
  getJson<BankBalancesResponse>("/accounts/bank");

/* ----------------------------------------------------------------------------
 * Spend Summary — metered spend vs shadow compute with time-series.
 * -------------------------------------------------------------------------- */

export interface SpendWindow {
  total_eur: number;
  calls: number;
  claude_eur: number;
  claude_calls: number;
}

export interface SpendAreaItem {
  provider: string;
  kind: string;
  total_eur: number;
  calls: number;
  units: number;
}

/**
 * `shadow_eur` and `total_compute_eur` are REQUIRED, matching what the server
 * actually returns. They were optional here, which meant every chart read them
 * as `x ?? 0` — a server that stopped sending them would draw a flat zero line
 * for Claude's compute rather than fail, and nobody would know the difference.
 * If they are ever genuinely absent, that is a broken server and it should
 * surface as one.
 */
export interface SpendDailyItem {
  day: string;
  /** Metered cost in EUR — every provider except claude-code. */
  total_eur: number;
  /** claude-code's notional price. Flat-rate subscription, never billed. */
  shadow_eur: number;
  /** `total_eur + shadow_eur` — how much compute RAN, never a cash total. */
  total_compute_eur: number;
  calls: number;
}

/** The pick lists and the current selection, both from the server. `providers`
 *  and `kinds` are unfiltered, so narrowing to one provider never empties the
 *  picker you would need to get back out. */
export interface SpendFilters {
  providers: string[];
  kinds: string[];
  applied: { provider: string | null; kind: string | null };
}

/**
 * The response THIS repo's forge-control returns — `filters` and the daily
 * compute split are required because the route always emits them, and
 * defaulting a missing one to zero is a fabrication.
 *
 * They are still not safe to read blind. `getJson<T>` is an unchecked cast and
 * forge-control-web restarts independently of forge-control, so a web build
 * can face an API that predates a field (verified 2026-08-23: the deployed
 * `/api/spend/summary` returned no `filters` key at all). MoneySurface reads
 * both through `desktop/spend-skew.ts`, which reports absence as unknown
 * instead of throwing or inventing a zero.
 */
export interface SpendSummaryResponse {
  today: SpendWindow;
  d7: SpendWindow;
  d30: SpendWindow;
  by_area: SpendAreaItem[];
  daily: SpendDailyItem[];
  filters: SpendFilters;
}

export interface SpendSummaryQuery {
  days?: number;
  /** null / omitted = every provider. */
  provider?: string | null;
  /** null / omitted = every kind. */
  kind?: string | null;
}

export const fetchSpendSummaryFiltered = (query: SpendSummaryQuery = {}) => {
  const params = new URLSearchParams();
  if (query.days !== undefined) params.set("days", String(query.days));
  if (query.provider) params.set("provider", query.provider);
  if (query.kind) params.set("kind", query.kind);
  const qs = params.toString();
  return getJson<SpendSummaryResponse>(`/spend/summary${qs ? `?${qs}` : ""}`);
};


/* ----------------------------------------------------------------------------
 * Job detail — GET /api/pipeline/jobs/:id. Mirrors the `content_jobs` row
 * `forge-control/src/routes/pipeline.ts` selects, plus two derived fields it
 * adds server-side: `hub_url` (the hub-web deep link, built from the id —
 * never construct this client-side) and `phase` (`phaseFor(status)`, the same
 * key space as `BusinessPipelinePhase.key`).
 * -------------------------------------------------------------------------- */

export interface PipelineJobDetail {
  id: string;
  title: string;
  description: string;
  status: string;
  format: string;
  production_version: string;
  channel_id: string | null;
  channel_name: string;
  youtube_channel_id: string | null;
  template_id: string | null;
  template_name: string;
  initial_topic: string | null;
  script: string | null;
  generated_tags: string[] | null;
  language: string;
  aspect_ratio: string | null;
  target_duration_seconds: number | null;
  duration_frames: number | null;
  render_engine: string | null;
  render_started_at: string | null;
  render_completed_at: string | null;
  total_render_time_seconds: number | null;
  /** bigint column — arrives as a string. */
  final_video_size_bytes: string | null;
  final_video_duration_seconds: number | null;
  final_video_path: string | null;
  youtube_video_id: string | null;
  published_at: string | null;
  views: number | null;
  revenue_cents: number | null;
  error_message: string | null;
  error_detail: unknown;
  error_metadata: unknown;
  retry_count: number;
  qc_feedback: string | null;
  qc_reviewed_at: string | null;
  assigned_production_va_id: string | null;
  production_va_name: string | null;
  production_va_email: string | null;
  production_va_time_spent_seconds: number | null;
  assigned_uploader_va_id: string | null;
  uploader_va_name: string | null;
  uploader_va_email: string | null;
  uploader_va_time_spent_seconds: number | null;
  assembly_manifest: unknown;
  r2_asset_manifest: unknown;
  /** Server appends `{from,to,timestamp,actor,reason}` entries; pre-existing
   *  rows may carry a different shape, so this stays `unknown` — narrow it at
   *  the render site instead of trusting it here. */
  state_machine_history: unknown;
  generation_log: unknown;
  metadata: unknown;
  created_at: string;
  updated_at: string;
  status_updated_at: string;
  hub_url: string;
  phase: string;
}

/** A server error body: `{error}` always, `{details}` only from a 500. */
interface BusinessApiError {
  error: string;
  details?: string;
}

export type JobDetailResult =
  | { ok: true; job: PipelineJobDetail }
  | { ok: false; status: number; error: string; details?: string };

/* ----------------------------------------------------------------------------
 * Pipeline meta — GET /api/pipeline/meta. Channels, active templates and the
 * active-user directory, for assignment pickers and retry/advance forms.
 * -------------------------------------------------------------------------- */

export interface PipelineChannel {
  id: string;
  name: string;
  youtube_channel_id: string;
  description: string | null;
  language: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  format: string;
  description: string;
  is_active: boolean;
}

export interface PipelineVaUser {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
}

export interface PipelineMeta {
  channels: PipelineChannel[];
  templates: PipelineTemplate[];
  users: PipelineVaUser[];
}

export type PipelineMetaResult =
  | { ok: true; meta: PipelineMeta }
  | { ok: false; status: number; error: string; details?: string };

/**
 * A GET that can fail with a server-authored `{error, details?}` body, not
 * just a transport error. Returns the raw fetch outcome; callers shape their
 * own discriminated union from it rather than this file flattening one error
 * shape into every endpoint's success type.
 */
async function getBusinessRaw(
  path: string,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  const payload = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, payload };
}

export async function fetchJobDetail(id: string): Promise<JobDetailResult> {
  const { ok, status, payload } = await getBusinessRaw(
    `/pipeline/jobs/${encodeURIComponent(id)}`,
  );
  if (ok) return { ok: true, job: (payload as { job: PipelineJobDetail }).job };
  const err = payload as BusinessApiError | null;
  return {
    ok: false,
    status,
    error: err?.error ?? `${status} on /pipeline/jobs/${id}`,
    details: err?.details,
  };
}

export async function fetchPipelineMeta(): Promise<PipelineMetaResult> {
  const { ok, status, payload } = await getBusinessRaw("/pipeline/meta");
  if (ok) return { ok: true, meta: payload as PipelineMeta };
  const err = payload as BusinessApiError | null;
  return {
    ok: false,
    status,
    error: err?.error ?? `${status} on /pipeline/meta`,
    details: err?.details,
  };
}

/* ----------------------------------------------------------------------------
 * Job actions — POST retry/assign/advance. Each mirrors the exact success
 * shape its route in `forge-control/src/routes/pipeline.ts` returns; failure
 * (400/404/409/500) carries the server's own `error` text — a caller showing
 * `mutation.error` shows Konrad the real reason (e.g. "Cannot retry
 * FAILED_IRRECOVERABLE job — requires manual human intervention"), never a
 * generic status line.
 * -------------------------------------------------------------------------- */

export interface MutationFailure {
  success: false;
  status: number;
  error: string;
  details?: string;
  /** 409 only. `true` means the transition is legal but off the curated path:
   *  the same request with `confirm: true` will be accepted. `false`/absent
   *  means the server refused outright and re-sending will not help. */
  requires_confirmation?: boolean;
  /** 409 only. What the row actually holds now — the server read it back
   *  after refusing, so this is the truth to reload against, not a guess. */
  current_status?: string;
}

async function postBusinessRaw(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const res = await fetch(`${ROOT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, payload };
}

function toMutationFailure(status: number, payload: unknown, path: string): MutationFailure {
  const err = payload as
    | (BusinessApiError & {
        requires_confirmation?: boolean;
        current_status?: string;
      })
    | null;
  return {
    success: false,
    status,
    error: err?.error ?? `${status} on ${path}`,
    details: err?.details,
    requires_confirmation: err?.requires_confirmation,
    current_status: err?.current_status,
  };
}

export interface RetryJobRequest {
  /** Human alias (`"render"`, `"qc"`, …) or a raw `job_status` value.
   *  Omit to let the server infer the retry target from the failure. */
  target_stage?: string;
  reason?: string;
  /** The status this screen was showing. The server 409s instead of acting if
   *  a Content Forge worker moved the job in the meantime — the operator's
   *  click was a decision about a state that no longer exists. */
  expected_status?: string;
  /** Re-send a 409 that came back `requires_confirmation: true`. Never
   *  unlocks a destructive target; those are refused 403 either way. */
  confirm?: boolean;
}

export interface RetryJobSuccess {
  success: true;
  message: string;
  /** True when the job was re-queued into the stage it was already in — the
   *  unstick control. `old_status === new_status` by design: the status write
   *  is the no-op and the queue dispatch is the point, so the UI must not
   *  report it as a transition that went nowhere. */
  redispatch?: boolean;
  old_status: string;
  new_status: string;
  retry_count: number;
  queue_name: string | null;
  queue_dispatched: boolean;
  queue_error?: string;
}

export type RetryJobResult = RetryJobSuccess | MutationFailure;

export async function retryJob(
  id: string,
  body: RetryJobRequest = {},
): Promise<RetryJobResult> {
  const path = `/pipeline/jobs/${encodeURIComponent(id)}/retry`;
  const { ok, status, payload } = await postBusinessRaw(path, body);
  return ok ? (payload as RetryJobSuccess) : toMutationFailure(status, payload, path);
}

export interface AssignJobRequest {
  /** Either set these two directly (`null` clears an assignment)… */
  production_va_id?: string | null;
  uploader_va_id?: string | null;
  /** …or set one role and the user to fill it. */
  role?: "production" | "uploader";
  user_id?: string | null;
  /** The assignments this screen was showing (`null` = "was unassigned").
   *  The server 409s rather than reverting someone else's reassignment. */
  expected_production_va_id?: string | null;
  expected_uploader_va_id?: string | null;
}

export interface AssignJobSuccess {
  success: true;
  message: string;
  job_id: string;
  assigned_production_va_id: string | null;
  production_va_name: string | null;
  assigned_uploader_va_id: string | null;
  uploader_va_name: string | null;
}

export type AssignJobResult = AssignJobSuccess | MutationFailure;

export async function assignJob(
  id: string,
  body: AssignJobRequest,
): Promise<AssignJobResult> {
  const path = `/pipeline/jobs/${encodeURIComponent(id)}/assign`;
  const { ok, status, payload } = await postBusinessRaw(path, body);
  return ok ? (payload as AssignJobSuccess) : toMutationFailure(status, payload, path);
}

export interface AdvanceJobRequest {
  /** Human alias or raw `job_status`. Omit to take the server's default
   *  next stage — it 400s if the current status has no default. */
  target_status?: string;
  reason?: string;
  /** Recorded as `qc_feedback` when the advance is a QC approval. */
  feedback?: string;
  /** See `RetryJobRequest.expected_status`. */
  expected_status?: string;
  /** See `RetryJobRequest.confirm`. */
  confirm?: boolean;
}

export interface AdvanceJobSuccess {
  success: true;
  message: string;
  old_status: string;
  new_status: string;
  qc_reviewed_at: string | null;
  assigned_uploader_va_id: string | null;
  queue_name: string | null;
  queue_dispatched: boolean;
  queue_error?: string;
}

export type AdvanceJobResult = AdvanceJobSuccess | MutationFailure;

export async function advanceJob(
  id: string,
  body: AdvanceJobRequest = {},
): Promise<AdvanceJobResult> {
  const path = `/pipeline/jobs/${encodeURIComponent(id)}/advance`;
  const { ok, status, payload } = await postBusinessRaw(path, body);
  return ok ? (payload as AdvanceJobSuccess) : toMutationFailure(status, payload, path);
}