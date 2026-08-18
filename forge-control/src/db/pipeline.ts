/**
 * Pipeline (content_jobs collapsed into phase buckets).
 *
 * The ~40 job_status enum values map to 7 user-facing phases. Each phase
 * shows a count + most recent cards. Unknown statuses fall into "other".
 *
 * ── READ-ONLY, ABSOLUTELY (R68) ───────────────────────────────────────────
 * Every statement in this file is a SELECT. The AI OS displays Content Forge;
 * it does not operate it. Unstalling the QC queue is an explicit non-goal
 * (00-vision.md §5), and no code here restarts a worker.
 *
 * ── What phase 5 added, and why ───────────────────────────────────────────
 * The surface could not tell "no work today" from "work that has not moved in
 * a fortnight while four workers sat idle" — opposite facts, same empty column
 * (02-architecture.md §4.2). So each card now carries a stall verdict (R64)
 * and each phase carries a state sentence (R65), both from the pure
 * classifiers in lib/pipeline-health.ts.
 *
 * ── The two fake counts this file used to publish ─────────────────────────
 * Measured in phase5/premises-remeasured.md § P2:
 *   - `count` was `phaseMap.get(key).length`, i.e. the length of an array
 *     capped at 20 by `if (arr.length < 20) arr.push(card)`;
 *   - `total` was `r.rows.length` under `LIMIT 500`.
 * Both were CAPS WEARING THE NAME OF A COUNT. They read correctly today only
 * because the whole table is 24 rows — they would have gone wrong silently on
 * the first busy day, which is the only day they matter. Counts now come from
 * a `GROUP BY` over every matching row; the card list is capped separately and
 * says so (`card_limit_per_phase`, `cards_truncated`).
 */

import pg from "pg";

import {
  STALL_AFTER_HOURS,
  stallCutoffMs,
  classifyStall,
  classifyPhaseState,
  parsePm2Jlist,
  CONTENT_FORGE_PM2_PROCESSES,
  type PhaseCount,
  type PhaseState,
  type WorkerHealth,
} from "../lib/pipeline-health.ts";
import { run } from "../lib/exec.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (e) => console.error("[pipeline pool]", e.message));

/** Cards are a preview, not an inventory. The count is the inventory. */
const CARD_LIMIT_PER_PHASE = 20;
/** How many rows the card query reads. Reported, so it is never a hidden cap. */
const CARD_QUERY_LIMIT = 500;

export interface PipelineCard {
  id: string;
  title: string;
  status: string;
  format: string;
  channel: string;
  template: string;
  age: string;
  updated_at: string;
  /** Raw `status_updated_at`, so the client can compute its own ages (R64). */
  status_updated_at: string;
  /** Older than `stall_threshold_hours` with no status change. */
  stalled: boolean;
  /** Whole days since `status_updated_at`, stalled or not. */
  stall_days: number;
}

export interface PipelinePhase {
  key: string;
  label: string;
  description: string;
  statuses: string[];
  /** TRUE count of matching jobs — from GROUP BY, not from `cards.length`. */
  count: number;
  /** How many of those `count` jobs are stalled. Same clock as the cards. */
  stalled_count: number;
  state: PhaseState;
  state_reason: string;
  /** At most `card_limit_per_phase` of them, newest first. */
  cards: PipelineCard[];
  /** `count` exceeds what `cards` can show. */
  cards_truncated: boolean;
}

export interface PipelineSnapshot {
  as_of: string;
  /** The threshold this response actually used — never assume 48 (R64). */
  stall_threshold_hours: number;
  /** The instant it resolves to; both counts and cards use exactly this one. */
  stall_cutoff: string;
  phases: PipelinePhase[];
  /** TRUE count of non-deleted jobs. */
  total: number;
  stalled_total: number;
  card_limit_per_phase: number;
  card_query_limit: number;
  /** Rows the card query actually read. `=== card_query_limit` means capped. */
  card_rows_scanned: number;
}

const PHASES: {
  key: string;
  label: string;
  description: string;
  match: RegExp;
}[] = [
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
    match: /(QMS|QC|AWAITING)/i,
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
];

/**
 * First match wins, and the order above is the pipeline order.
 *
 * Note what that means for the live data, measured in premises-remeasured.md
 * § P1: `AWAITING_QC` AND `AWAITING_UPLOADER` both land in `qc`, because `qc`
 * is tested before `render` and `publish` and its pattern includes a bare
 * `AWAITING`. So Publish renders empty while four jobs sit at the gate
 * immediately in front of it — which is exactly the "blocked upstream" state
 * R65 asks this surface to say out loud.
 */
function phaseFor(status: string): string {
  if (status === "MARKED_FOR_DELETION") return "deleted";
  for (const p of PHASES) if (p.match.test(status)) return p.key;
  return "other";
}

function humanAge(ts: string | null, now: number): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface PhaseTally {
  count: number;
  stalled: number;
  statuses: Set<string>;
}

function emptyTally(): PhaseTally {
  return { count: 0, stalled: 0, statuses: new Set() };
}

export async function getPipeline(): Promise<PipelineSnapshot> {
  // ONE clock for the whole response. The counts are tallied in SQL and the
  // cards are classified in JS; if SQL used now() and JS used Date.now(), a
  // phase could report stalled_count: 4 over five cards each marked stalled.
  const now = Date.now();
  const cutoff = new Date(stallCutoffMs(now, STALL_AFTER_HOURS));

  const [counts, cards] = await Promise.all([
    // TRUE counts. Every non-deleted row, no LIMIT, no cap.
    pool.query<{ status: string; n: number; stalled_n: number }>(
      `SELECT j.status::text AS status,
              count(*)::int AS n,
              count(*) FILTER (WHERE j.status_updated_at < $1::timestamptz)::int AS stalled_n
         FROM content_jobs j
        WHERE j.status <> 'MARKED_FOR_DELETION'
        GROUP BY 1`,
      [cutoff.toISOString()],
    ),
    // The card PREVIEW. Capped, and the caps are published in the response.
    pool.query<{
      id: string;
      title: string;
      status: string;
      format: string;
      channel: string;
      template: string;
      status_updated_at: string;
    }>(
      `SELECT j.id::text, j.title, j.status::text AS status, j.format::text AS format,
              COALESCE(c.name, '—') AS channel,
              COALESCE(t.name, '—') AS template,
              j.status_updated_at::text AS status_updated_at
         FROM content_jobs j
         LEFT JOIN channels c ON c.id = j.channel_id
         LEFT JOIN content_templates t ON t.id = j.template_id
        WHERE j.status <> 'MARKED_FOR_DELETION'
        ORDER BY j.status_updated_at DESC
        LIMIT ${CARD_QUERY_LIMIT}`,
    ),
  ]);

  const tallies = new Map<string, PhaseTally>();
  for (const p of PHASES) tallies.set(p.key, emptyTally());
  tallies.set("other", emptyTally());

  let total = 0;
  let stalledTotal = 0;
  for (const row of counts.rows) {
    const key = phaseFor(row.status);
    const tally = tallies.get(key);
    if (tally === undefined) {
      // phaseFor only ever returns a PHASES key, "other" or "deleted", and
      // "deleted" is excluded by the WHERE clause. Reaching here means the
      // bucketing and the query disagree — say so, do not drop the rows.
      throw new Error(
        `getPipeline: status ${JSON.stringify(row.status)} bucketed to unknown phase ${JSON.stringify(key)}`,
      );
    }
    tally.count += row.n;
    tally.stalled += row.stalled_n;
    tally.statuses.add(row.status);
    total += row.n;
    stalledTotal += row.stalled_n;
  }

  const cardsByPhase = new Map<string, PipelineCard[]>();
  for (const key of tallies.keys()) cardsByPhase.set(key, []);

  for (const row of cards.rows) {
    const key = phaseFor(row.status);
    const arr = cardsByPhase.get(key) ?? cardsByPhase.get("other")!;
    if (arr.length >= CARD_LIMIT_PER_PHASE) continue;
    const { stalled, stall_days } = classifyStall(row.status_updated_at, now, STALL_AFTER_HOURS);
    arr.push({
      id: row.id,
      title: row.title,
      status: row.status,
      format: row.format,
      channel: row.channel,
      template: row.template,
      age: humanAge(row.status_updated_at, now),
      updated_at: row.status_updated_at,
      status_updated_at: row.status_updated_at,
      stalled,
      stall_days,
    });
  }

  // Ordered, so "upstream" in classifyPhaseState means what it says.
  const ordered: PhaseCount[] = PHASES.map((p) => ({
    key: p.key,
    label: p.label,
    count: tallies.get(p.key)!.count,
  }));

  const phases: PipelinePhase[] = PHASES.map((p, i) => {
    const tally = tallies.get(p.key)!;
    const phaseCards = cardsByPhase.get(p.key) ?? [];
    const { state, state_reason } = classifyPhaseState(i, ordered);
    return {
      key: p.key,
      label: p.label,
      description: p.description,
      statuses: [...tally.statuses],
      count: tally.count,
      stalled_count: tally.stalled,
      state,
      state_reason,
      cards: phaseCards,
      cards_truncated: tally.count > phaseCards.length,
    };
  });

  const other = tallies.get("other")!;
  if (other.count > 0) {
    const otherCards = cardsByPhase.get("other") ?? [];
    phases.push({
      key: "other",
      label: "Other",
      description: "Unbucketed states",
      statuses: [...other.statuses],
      count: other.count,
      stalled_count: other.stalled,
      state: "has_work",
      state_reason: `${other.count === 1 ? "1 job" : `${other.count} jobs`} in a status no phase claims: ${[...other.statuses].join(", ")}.`,
      cards: otherCards,
      cards_truncated: other.count > otherCards.length,
    });
  }

  return {
    as_of: new Date(now).toISOString(),
    stall_threshold_hours: STALL_AFTER_HOURS,
    stall_cutoff: cutoff.toISOString(),
    phases,
    total,
    stalled_total: stalledTotal,
    card_limit_per_phase: CARD_LIMIT_PER_PHASE,
    card_query_limit: CARD_QUERY_LIMIT,
    card_rows_scanned: cards.rows.length,
  };
}

/* ========================================================================== *
 * Worker health (R66)
 * ========================================================================== */

export type WorkerHealthResult =
  | {
      ok: true;
      as_of: string;
      workers: WorkerHealth[];
      online: number;
      expected: string[];
      /** Named processes pm2 has never heard of. Absent ≠ stopped ≠ zero. */
      missing: string[];
    }
  | {
      ok: false;
      as_of: string;
      expected: string[];
      /** Verbatim upstream message from pm2 or the parser. */
      error: string;
    };

/**
 * Probe pm2 for the four Content Forge workers.
 *
 * `run()` from lib/exec.ts is reused exactly as routes/pm2.ts already does —
 * one shell-out, a timeout, no throw. This lives beside the pipeline query
 * because it answers the same question ("is this pipeline moving?"), and R66
 * requires the answer to come from a real probe rather than being inferred
 * from job movement: four idle-but-online workers must not look like four dead
 * ones.
 *
 * `pm2 list` is the ONLY pm2 verb used. No restart, ever (R68).
 */
export async function getWorkerHealth(now: number = Date.now()): Promise<WorkerHealthResult> {
  const as_of = new Date(now).toISOString();
  const expected = [...CONTENT_FORGE_PM2_PROCESSES];
  const { ok, stdout, stderr } = await run("pm2 jlist", 5000);
  if (!ok) {
    return { ok: false, as_of, expected, error: stderr.trim() || "pm2 jlist failed with no output" };
  }
  try {
    const { workers, missing } = parsePm2Jlist(stdout, now);
    return {
      ok: true,
      as_of,
      workers,
      online: workers.filter((w) => w.status === "online").length,
      expected,
      missing,
    };
  } catch (err) {
    // A parse failure is an UNREACHABLE probe, not a healthy fleet of zero.
    return {
      ok: false,
      as_of,
      expected,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
