/**
 * Pipeline health — the pure logic behind GET /api/pipeline's stall ages,
 * per-phase state sentences and Content Forge worker health.
 *
 * Why this file exists: the Pipeline surface cannot currently tell "no work
 * today" from "work that has not moved in a fortnight while four workers sat
 * idle". Both render as an empty column with a `0`. Those are opposite
 * operational facts (02-architecture.md §4.2, R64/R65/R66).
 *
 * Everything here is PURE and synchronous — no database, no filesystem, no
 * network, no `Date.now()` read inside a function. `now` is always passed in.
 * That is what lets `pnpm test` (`tsx --test src/lib/*.test.ts`) prove the
 * classifiers, including the branches the live data cannot produce: there is
 * no fresh job in `content_jobs` to prove the not-stalled branch against, and
 * R68 forbids creating one.
 *
 * The one exception is `STALL_AFTER_HOURS`, which reads `process.env` ONCE at
 * module load through the pure, tested `resolveStallHours()`.
 *
 * ── Why `status_updated_at` is the stall signal (cited, not re-derived) ────
 * S-C-content-forge-state.md §5 established it against the live schema:
 *   - `content_jobs` has NO status trigger — `SELECT tgname FROM pg_trigger
 *     WHERE tgrelid='content_jobs'::regclass AND NOT tgisinternal` → 0 rows.
 *     (The trigger that does exist, `log_bundestag_status_change()`, fires on
 *     a different table for a different product line.)
 *   - There is exactly ONE write path that changes `status`:
 *     `updateJobStatus()` at
 *     `/opt/content-forge/packages/db/src/repositories/job-repository.ts:188-222`,
 *     which sets `status` and `status_updated_at: new Date()` in the same
 *     object literal of the same UPDATE, so the two cannot drift apart.
 *     `createJob()` (lines 37-56) does the same on insert.
 * The column is `timestamp with time zone NOT NULL`, so a missing value is an
 * anomaly and `classifyStall()` throws on one rather than inventing an age.
 */

/* ========================================================================== *
 * Stall threshold
 * ========================================================================== */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Hours without a `status_updated_at` change before a job is called stalled.
 *
 * 48h is deliberately far below the live 11–14 day band (S-C §0) and far above
 * the longest legitimate machine stage (render-heavy, minutes to hours). It is
 * a threshold, not a law, which is why the API publishes the value it used
 * instead of hardcoding "48" into any label.
 */
export const DEFAULT_STALL_AFTER_HOURS = 48;

/**
 * Parse `PIPELINE_STALL_HOURS`. An unset or empty value takes the default; a
 * present-but-unusable value THROWS. Falling back silently would make the API
 * publish `stall_threshold_hours: 48` while the operator believed they had set
 * 6, and every stall verdict on the surface would be quietly wrong.
 */
export function resolveStallHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_AFTER_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `PIPELINE_STALL_HOURS must be a positive finite number of hours; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** The threshold this process is actually using. Published by the API (R64). */
export const STALL_AFTER_HOURS = resolveStallHours(process.env.PIPELINE_STALL_HOURS);

/**
 * The instant before which a job counts as stalled, in epoch ms.
 *
 * Exported because the SQL count query and the per-card classifier MUST use
 * the same cutoff. If SQL used `now()` (the database clock) and the cards used
 * `Date.now()` (the API process clock), a phase could report
 * `stalled_count: 4` over five cards each marked `stalled: true`. One clock,
 * one threshold, one cutoff — computed here and passed to both.
 */
export function stallCutoffMs(
  now: number,
  thresholdHours: number = STALL_AFTER_HOURS,
): number {
  if (!Number.isFinite(now)) {
    throw new Error(`stallCutoffMs: now must be a finite epoch-ms number; got ${String(now)}`);
  }
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new Error(
      `stallCutoffMs: thresholdHours must be a positive finite number; got ${String(thresholdHours)}`,
    );
  }
  return now - thresholdHours * MS_PER_HOUR;
}

/* ========================================================================== *
 * Per-job stall classification (R64)
 * ========================================================================== */

export interface StallVerdict {
  /** `status_updated_at` is strictly older than the threshold. */
  stalled: boolean;
  /**
   * Whole days since `status_updated_at`, reported whether or not the job is
   * stalled — a 3-hour-old job is `{stalled: false, stall_days: 0}`. The name
   * is the field's use, not a claim that the job is stuck.
   */
  stall_days: number;
}

/**
 * Classify one job's `status_updated_at` against `now`.
 *
 * @param statusUpdatedAt  The column value: pg's `::text` rendering
 *                         (`2026-08-04 01:01:34.885+00`), an ISO-8601 string,
 *                         or a `Date`. Unparseable input throws with the
 *                         offending value — a job whose age cannot be computed
 *                         must not be rendered as fresh.
 * @param now              Epoch ms. Passed in so tests can pin the clock.
 *
 * A timestamp in the future (clock skew between writer and reader) yields
 * `{stalled: false, stall_days: 0}`: a job that claims to have moved in the
 * future has certainly not been sitting still, and a negative age is never
 * shown to Konrad.
 */
export function classifyStall(
  statusUpdatedAt: string | Date,
  now: number,
  thresholdHours: number = STALL_AFTER_HOURS,
): StallVerdict {
  if (!Number.isFinite(now)) {
    throw new Error(`classifyStall: now must be a finite epoch-ms number; got ${String(now)}`);
  }
  const t = statusUpdatedAt instanceof Date ? statusUpdatedAt.getTime() : Date.parse(statusUpdatedAt);
  if (Number.isNaN(t)) {
    throw new Error(
      `classifyStall: status_updated_at is not a parseable timestamp; got ${JSON.stringify(
        statusUpdatedAt instanceof Date ? "Invalid Date" : statusUpdatedAt,
      )}`,
    );
  }
  const ageMs = now - t;
  if (ageMs <= 0) return { stalled: false, stall_days: 0 };
  return {
    stalled: t < stallCutoffMs(now, thresholdHours),
    stall_days: Math.floor(ageMs / MS_PER_DAY),
  };
}

/* ========================================================================== *
 * Phase topography — which bucket a `job_status` belongs to
 * ========================================================================== */

export interface PhaseDefinition {
  key: string;
  label: string;
  description: string;
  match: RegExp;
}

/**
 * First match wins, and the order below is the pipeline order — it is also
 * the match-check order, so a status that would match two phases lands in
 * whichever comes first in this array.
 *
 * `qc`'s pattern used to be `/(QMS|QC|AWAITING)/i` — a bare `AWAITING` catch-
 * all that matched every `AWAITING_*` status in `job_status`, INCLUDING
 * `AWAITING_UPLOADER`, before `publish`'s own `/UPLOAD/i` ever got a look.
 * Content Forge's real `job_status` enum has `AWAITING_QC` (belongs here) and
 * `AWAITING_UPLOADER` (belongs in `publish`, one gate further along) — the
 * bare catch-all could not tell them apart and silently emptied `publish`
 * while `qc` absorbed jobs already past it. `AWAITING_(?!UPLOADER)` keeps
 * every other `AWAITING_*` status (`AWAITING_QC`, `AWAITING_RESEARCH`,
 * `AWAITING_PRODUCTION_VA`, `AWAITING_VA_REVIEW`, …) exactly where it always
 * landed, and excludes only the one status that belongs downstream.
 */
export const PHASES: readonly PhaseDefinition[] = [
  {
    key: "idea",
    label: "Idea",
    description: "Topic + brief, pre-script",
    match: /^(IDEA_GENERATION|TOPIC_SELECTION|BRIEF)/i,
  },
  {
    key: "script",
    label: "Script",
    description: "Scripting → script ready",
    match: /^(SCRIPTING|SCRIPT_READY|SCRIPT_REVIEW)/i,
  },
  {
    key: "voice",
    label: "Voice",
    description: "TTS generation",
    match: /(TTS|VOICE)/i,
  },
  {
    key: "assets",
    label: "Assets",
    description: "Image / clip / asset collection",
    match: /(ASSET|IMAGE|CLIP|FOOTAGE|HEYGEN)/i,
  },
  {
    key: "qc",
    label: "QC",
    description: "QMS validation + manual gates",
    match: /(QMS|QC|AWAITING_(?!UPLOADER))/i,
  },
  {
    key: "render",
    label: "Render",
    description: "Routing + render + stitch",
    match: /(ROUTING_RENDER|RENDER|STITCH|FAILED_RENDER)/i,
  },
  {
    key: "publish",
    label: "Publish",
    description: "Uploader → published",
    match: /(UPLOAD|PUBLISH)/i,
  },
] as const;

/**
 * Bucket one `job_status` value into a phase key.
 *
 * `MARKED_FOR_DELETION` is its own sentinel — callers filter it out of the
 * live query, but the classifier still names it rather than falling through
 * to `other`, so a caller that forgets the filter gets an honest bucket
 * instead of a silent miscount. Anything the array above does not match
 * (and is not the deletion sentinel) is `other` — never dropped.
 */
export function phaseFor(status: string): string {
  if (status === "MARKED_FOR_DELETION") return "deleted";
  for (const p of PHASES) if (p.match.test(status)) return p.key;
  return "other";
}

/* ========================================================================== *
 * Per-phase state (R65) — "no work" is not one fact, it is two
 * ========================================================================== */

export type PhaseState = "has_work" | "no_work_idle" | "no_work_blocked_upstream";

/** One phase's identity and TRUE count, in pipeline order. */
export interface PhaseCount {
  key: string;
  label: string;
  count: number;
}

export interface PhaseStateVerdict {
  state: PhaseState;
  /** A sentence a human reads, not a code a human decodes. */
  state_reason: string;
}

function jobsWord(n: number): string {
  return n === 1 ? "1 job" : `${n} jobs`;
}

/**
 * Decide whether a phase is busy, idle, or empty because everything is held
 * upstream of it.
 *
 * - `has_work`                 — count > 0.
 * - `no_work_blocked_upstream` — zero here, non-zero in ANY earlier phase.
 * - `no_work_idle`             — zero here and zero in every earlier phase.
 *
 * This is the whole of R65: today six of the seven columns render `0`, four of
 * them because nothing was ever started and two of them because five jobs are
 * stuck at the QC/upload gate in front of them. Same column, opposite facts.
 *
 * @param phaseIndex     Index into `countsByPhase`, which MUST be in pipeline
 *                       order — "upstream" means "earlier in this array".
 * @param countsByPhase  Every phase, ordered. Passing a filtered or reordered
 *                       array silently changes what "upstream" means, so an
 *                       out-of-range index throws rather than returning idle.
 */
export function classifyPhaseState(
  phaseIndex: number,
  countsByPhase: readonly PhaseCount[],
): PhaseStateVerdict {
  const self = countsByPhase[phaseIndex];
  if (self === undefined) {
    throw new Error(
      `classifyPhaseState: phaseIndex ${phaseIndex} is out of range for ${countsByPhase.length} phases`,
    );
  }

  if (self.count > 0) {
    return {
      state: "has_work",
      state_reason: `${jobsWord(self.count)} in ${self.label}.`,
    };
  }

  const upstream = countsByPhase.slice(0, phaseIndex).filter((p) => p.count > 0);
  if (upstream.length === 0) {
    const reason =
      phaseIndex === 0
        ? `Nothing in ${self.label}, and it is the first phase — no work has been created.`
        : `Nothing in ${self.label}, and nothing in any earlier phase — idle, not blocked.`;
    return { state: "no_work_idle", state_reason: reason };
  }

  const held = upstream.reduce((sum, p) => sum + p.count, 0);
  const where = upstream.map((p) => `${p.label} (${p.count})`).join(", ");
  return {
    state: "no_work_blocked_upstream",
    state_reason: `Nothing in ${self.label} — ${jobsWord(held)} held further up, in ${where}. This column is empty because work is stuck, not because there is none.`,
  };
}

/* ========================================================================== *
 * Content Forge worker health (R66) — the pure half
 * ========================================================================== */

/**
 * The four pm2 processes R66 names. A named constant, not a `pm_cwd` prefix
 * match: `/opt/content-forge` also hosts `audio-face-sidecar`, `vlm-sidecar`,
 * `derivative-watcher`, `forge-api`, `storage-drive-uploader` and `hub-web`,
 * and a wildcard would silently redefine "worker health" the day one of those
 * is added or renamed.
 */
export const CONTENT_FORGE_PM2_PROCESSES = [
  "worker-orchestrator",
  "worker-render",
  "worker-video-stitch",
  "claude-pool",
] as const;

export interface WorkerHealth {
  name: string;
  /** pm2's own word: `online`, `stopped`, `errored`, `launching`, … */
  status: string;
  /**
   * ms since pm2 started this process, or null when pm2 reports no start time
   * — which is what a `stopped` process looks like. NEVER 0: a zero uptime
   * reads as "just restarted", which is the opposite of "not running".
   */
  uptime_ms: number | null;
  /**
   * pm2's `restart_time`, or null when pm2 omits it — the same NEVER-0 rule as
   * `uptime_ms` above, for the same reason. A `0` here is a CLAIM ("this worker
   * has never restarted"), and the surface renders it as one; missing data must
   * not be able to make that claim.
   */
  restarts: number | null;
}

export interface WorkerHealthSelection {
  workers: WorkerHealth[];
  /** Named processes pm2 does not know about at all. Absent ≠ stopped. */
  missing: string[];
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`parsePm2Jlist: expected ${what} to be an object; got ${typeof v}`);
  }
  return v as Record<string, unknown>;
}

/**
 * Select the Content Forge processes out of `pm2 jlist` stdout.
 *
 * Throws — with the first 200 characters of what it was handed — on anything
 * that is not a JSON array of process objects. `pm2 jlist` prints warnings to
 * stdout under some node versions, and a parser that swallowed that would
 * report "0 workers online" for a perfectly healthy fleet.
 */
export function parsePm2Jlist(
  stdout: string,
  now: number,
  wanted: readonly string[] = CONTENT_FORGE_PM2_PROCESSES,
): WorkerHealthSelection {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `parsePm2Jlist: pm2 jlist did not return JSON (${message}); stdout began ${JSON.stringify(
        stdout.slice(0, 200),
      )}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(`parsePm2Jlist: expected a JSON array from pm2 jlist; got ${typeof raw}`);
  }

  const byName = new Map<string, WorkerHealth>();
  for (const entry of raw) {
    const proc = asRecord(entry, "a pm2 jlist entry");
    const name = proc["name"];
    if (typeof name !== "string" || !wanted.includes(name)) continue;

    const env = proc["pm2_env"] === undefined ? {} : asRecord(proc["pm2_env"], "pm2_env");
    const status = typeof env["status"] === "string" ? env["status"] : "unknown";
    const startedAt = env["pm_uptime"];
    const restarts = env["restart_time"];

    byName.set(name, {
      name,
      status,
      uptime_ms:
        status === "online" && typeof startedAt === "number" && Number.isFinite(startedAt)
          ? Math.max(0, now - startedAt)
          : null,
      restarts: typeof restarts === "number" && Number.isFinite(restarts) ? restarts : null,
    });
  }

  return {
    workers: wanted.map((n) => byName.get(n)).filter((w): w is WorkerHealth => w !== undefined),
    missing: wanted.filter((n) => !byName.has(n)),
  };
}
