/**
 * Runs (chat threads + agent tasks) data access.
 *
 * Schema lives in content_forge.runs (migration 0021):
 *   id uuid, title text, prompt text, worker varchar(64),
 *   status (queued|running|paused|stuck|completed|failed|cancelled),
 *   thread jsonb (array of {role, content, ts, kind?, meta?}),
 *   budget_usd numeric, spent_usd numeric,
 *   parent_run_id uuid, stuck_signal varchar(64), metadata jsonb,
 *   created_at, updated_at, started_at, completed_at, last_heartbeat_at
 */

import pg from "pg";
// Value import of the two eligibility matrices only — run-control-rules.ts is
// pure and imports nothing, so this cannot pull pg/fs/network into a module
// that a unit test might load. The route (round 903) imports the SAME arrays,
// which is what stops db and route from drifting (C5).
import { STOP_ELIGIBLE, TERMINATE_ELIGIBLE } from "../lib/run-control-rules.ts";

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

pool.on("error", (e) => console.error("[runs pool]", e.message));

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "stuck"
  | "completed"
  | "failed"
  | "cancelled";

export interface ThreadEntry {
  role: "user" | "assistant" | "system" | "tool" | "agent";
  content: string;
  ts: string;
  // "comms" is the manager control plane's entry kind (07 §3): a message that
  // crossed between Konrad, a manager run and a worker run. It rides the
  // existing jsonb column — no migration (C21) — and is the query key for
  // GET /api/runs/:id/comms (C14, see listComms below).
  kind?: "text" | "tool_call" | "tool_result" | "heartbeat" | "error" | "comms";
  meta?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  worker: string | null;
  budget_usd: string;
  spent_usd: string;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  message_count: number;
  last_message_preview: string;
  last_role: string;
  archived: boolean;
}

export interface RunDetail extends RunSummary {
  prompt: string;
  thread: ThreadEntry[];
  metadata: Record<string, unknown>;
  parent_run_id: string | null;
  stuck_signal: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function previewOf(thread: ThreadEntry[]): {
  text: string;
  role: string;
} {
  if (!Array.isArray(thread) || thread.length === 0) {
    return { text: "", role: "" };
  }
  const last = thread[thread.length - 1];
  const text = (last.content ?? "")
    .toString()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return { text, role: last.role ?? "" };
}

export interface RunListPage {
  runs: RunSummary[];
  hasMore: boolean;
}

/** Newest-first, archived runs excluded by default — that's the "closed"
 *  state (see archiveRun). Fetches limit+1 to derive hasMore without a
 *  separate COUNT query.
 *
 *  THE CHAT RAIL IS CONVERSATIONS ONLY. Two other kinds of row live in
 *  `runs` and must never appear here:
 *
 *    • sub-runs (parent_run_id set) — an agent spawned by another agent.
 *    • coding-project tasks (metadata.project_id set) — architect/planner/
 *      builder/reviewer work items like "SkyLab Script Factory · Fix cycle 3".
 *
 *  Both belong in the Live panel, grouped under their project, where their
 *  hierarchy is meaningful. Listing them flat in the rail buried Konrad's
 *  actual conversations under 39 rows of machine chatter — the fleet doing
 *  its job is not 30 new "chats". Filtering here (not in the UI) keeps every
 *  consumer of listRuns honest. */
export async function listRuns(
  limit = 80,
  offset = 0,
  opts: { includeArchived?: boolean } = {},
): Promise<RunListPage> {
  const r = await pool.query<{
    id: string;
    title: string;
    status: RunStatus;
    worker: string | null;
    budget_usd: string;
    spent_usd: string;
    created_at: string;
    updated_at: string;
    last_heartbeat_at: string | null;
    thread: ThreadEntry[];
    archived: boolean;
  }>(
    `SELECT id::text, title, status, worker, budget_usd::text, spent_usd::text,
            created_at::text, updated_at::text, last_heartbeat_at::text, thread, archived
       FROM runs
       WHERE (archived = false OR $3::boolean)
         AND parent_run_id IS NULL
         AND NOT (metadata ? 'project_id')
       ORDER BY updated_at DESC
       LIMIT $1 OFFSET $2`,
    [limit + 1, offset, opts.includeArchived ?? false],
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const runs = rows.map((row) => {
    const pv = previewOf(row.thread ?? []);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      worker: row.worker,
      budget_usd: row.budget_usd,
      spent_usd: row.spent_usd,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_heartbeat_at: row.last_heartbeat_at,
      message_count: Array.isArray(row.thread) ? row.thread.length : 0,
      last_message_preview: pv.text,
      last_role: pv.role,
      archived: row.archived,
    };
  });
  return { runs, hasMore };
}

/** Full-text-ish search across title, prompt, and every message in the
 *  thread (both roles — a reply often echoes the topic the user asked
 *  about). Includes archived runs: closing a chat hides it from the
 *  default rail but it must stay findable. */
export async function searchRuns(q: string, limit = 30): Promise<RunSummary[]> {
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const r = await pool.query<{
    id: string;
    title: string;
    status: RunStatus;
    worker: string | null;
    budget_usd: string;
    spent_usd: string;
    created_at: string;
    updated_at: string;
    last_heartbeat_at: string | null;
    thread: ThreadEntry[];
    archived: boolean;
  }>(
    `SELECT id::text, title, status, worker, budget_usd::text, spent_usd::text,
            created_at::text, updated_at::text, last_heartbeat_at::text, thread, archived
       FROM runs
       WHERE title ILIKE $1
          OR prompt ILIKE $1
          OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(thread) elem
                WHERE elem->>'content' ILIKE $1
             )
       ORDER BY updated_at DESC
       LIMIT $2`,
    [like, limit],
  );
  return r.rows.map((row) => {
    const pv = previewOf(row.thread ?? []);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      worker: row.worker,
      budget_usd: row.budget_usd,
      spent_usd: row.spent_usd,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_heartbeat_at: row.last_heartbeat_at,
      message_count: Array.isArray(row.thread) ? row.thread.length : 0,
      last_message_preview: pv.text,
      last_role: pv.role,
      archived: row.archived,
    };
  });
}

export async function getRun(id: string): Promise<RunDetail | null> {
  const r = await pool.query<{
    id: string;
    title: string;
    prompt: string;
    status: RunStatus;
    worker: string | null;
    budget_usd: string;
    spent_usd: string;
    thread: ThreadEntry[];
    metadata: Record<string, unknown>;
    parent_run_id: string | null;
    stuck_signal: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
    last_heartbeat_at: string | null;
    archived: boolean;
  }>(
    `SELECT id::text, title, prompt, status, worker, budget_usd::text, spent_usd::text,
            thread, metadata, parent_run_id::text AS parent_run_id,
            stuck_signal, created_at::text, updated_at::text,
            started_at::text, completed_at::text, last_heartbeat_at::text, archived
       FROM runs
       WHERE id = $1
       LIMIT 1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const pv = previewOf(row.thread ?? []);
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    worker: row.worker,
    budget_usd: row.budget_usd,
    spent_usd: row.spent_usd,
    thread: row.thread ?? [],
    metadata: row.metadata ?? {},
    parent_run_id: row.parent_run_id,
    stuck_signal: row.stuck_signal,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_heartbeat_at: row.last_heartbeat_at,
    message_count: Array.isArray(row.thread) ? row.thread.length : 0,
    last_message_preview: pv.text,
    last_role: pv.role,
    archived: row.archived,
  };
}

export async function createRun(input: {
  title: string;
  prompt: string;
  worker?: string;
  budget_usd?: number;
  metadata?: Record<string, unknown>;
}): Promise<RunDetail> {
  const seed: ThreadEntry[] = [
    {
      role: "user",
      content: input.prompt,
      ts: new Date().toISOString(),
      kind: "text",
    },
  ];
  const r = await pool.query<{ id: string }>(
    `INSERT INTO runs (title, prompt, worker, status, thread, budget_usd, metadata)
     VALUES ($1, $2, $3, 'queued', $4::jsonb, $5, $6::jsonb)
     RETURNING id::text`,
    [
      input.title.slice(0, 200),
      input.prompt,
      input.worker ?? null,
      JSON.stringify(seed),
      input.budget_usd ?? 0,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const run = await getRun(r.rows[0].id);
  if (!run) throw new Error("run created but read-back failed");
  return run;
}

/** Most recent non-terminal run from a given source (e.g. 'telegram') inside
 *  a freshness window. The telegram bridge uses this to decide whether a
 *  plain message continues the active thread or starts a new one. */
export async function findActiveRunBySource(
  source: string,
  windowHours: number,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text FROM runs
      WHERE metadata->>'source' = $1
        AND status NOT IN ('cancelled', 'failed')
        AND updated_at > now() - ($2 || ' hours')::interval
      ORDER BY updated_at DESC
      LIMIT 1`,
    [source, String(windowHours)],
  );
  if (!r.rows[0]) return null;
  return getRun(r.rows[0].id);
}

export async function appendMessage(
  id: string,
  entry: ThreadEntry,
  opts: { setStatus?: RunStatus } = {},
): Promise<RunDetail | null> {
  const newStatus = opts.setStatus;
  const sql = newStatus
    ? `UPDATE runs
         SET thread = thread || $2::jsonb,
             status = $3,
             updated_at = now()
       WHERE id = $1
       RETURNING id::text`
    : `UPDATE runs
         SET thread = thread || $2::jsonb,
             updated_at = now()
       WHERE id = $1
       RETURNING id::text`;
  const params: unknown[] = [id, JSON.stringify([entry])];
  if (newStatus) params.push(newStatus);
  const r = await pool.query<{ id: string }>(sql, params);
  if (r.rowCount === 0) return null;
  return getRun(id);
}

/** Set (or clear with null) metadata.model — the engine model override. */
export async function setRunModel(
  id: string,
  model: string | null,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    model === null
      ? `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) - 'model',
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`
      : `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                         jsonb_build_object('model', $2::text),
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`,
    model === null ? [id] : [id, model],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

/** Persist the canvas snapshot used to diff the next turn. Kept in run
 *  metadata (not a table) because it is per-conversation scratch state: it
 *  means nothing outside this thread and should die with it. */
export async function setRunCanvasSnapshot(
  id: string,
  snap: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                     jsonb_build_object('canvas_snapshot', $2::jsonb),
                     updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(snap)],
  );
}

/** Set (or clear with null) metadata.canvas — the vault-relative path of the
 *  drawing that should be open beside this chat. Living in runs.metadata (not
 *  browser localStorage) means the same chat opens the same drawing on any
 *  device and survives a full page reload. */
export async function setRunCanvas(
  id: string,
  canvasPath: string | null,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    canvasPath === null
      ? `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) - 'canvas',
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`
      : `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                         jsonb_build_object('canvas', $2::text),
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`,
    canvasPath === null ? [id] : [id, canvasPath],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

/** Set (or clear with null) metadata.effort — same pattern as setRunModel. */
export async function setRunEffort(
  id: string,
  effort: string | null,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    effort === null
      ? `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) - 'effort',
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`
      : `UPDATE runs SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                         jsonb_build_object('effort', $2::text),
                         updated_at = now()
          WHERE id = $1 RETURNING id::text`,
    effort === null ? [id] : [id, effort],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

export async function setRunStatus(
  id: string,
  status: RunStatus,
): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    `UPDATE runs SET status = $2, updated_at = now() WHERE id = $1 RETURNING id::text`,
    [id, status],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

const NON_TERMINAL: RunStatus[] = ["queued", "running", "paused", "stuck"];

/** "Close" a chat: archive it (hidden from the default rail, still
 *  searchable) and, if it's still doing anything, cancel it — same
 *  mechanism the existing Cancel button uses, so the executor's poll loop
 *  kills the underlying claude-code process within ~5s instead of letting
 *  it keep working or notifying in the background. */
export async function archiveRun(id: string): Promise<RunDetail | null> {
  const r = await pool.query<{ id: string }>(
    `UPDATE runs
        SET archived = true,
            status = CASE WHEN status = ANY($2::text[]) THEN 'cancelled' ELSE status END,
            updated_at = now()
      WHERE id = $1
      RETURNING id::text`,
    [id, NON_TERMINAL],
  );
  if (r.rowCount === 0) return null;
  return getRun(id);
}

/** Close every open chat in one shot. Returns how many were touched. */
export async function archiveAllRuns(): Promise<number> {
  const r = await pool.query(
    `UPDATE runs
        SET archived = true,
            status = CASE WHEN status = ANY($1::text[]) THEN 'cancelled' ELSE status END,
            updated_at = now()
      WHERE archived = false`,
    [NON_TERMINAL],
  );
  return r.rowCount ?? 0;
}

export interface LimitHit {
  run_id: string;
  title: string;
  ts: string;
  message: string;
}

/** Runs that failed because the Claude subscription hit a usage wall
 *  (weekly / 5-hour limit) rather than an actual bug — the executor writes
 *  these as a plain error entry (see executor.ts's catch block), there's no
 *  proactive quota API to poll instead. This is reactive by necessity: it
 *  only knows the wall was hit AFTER a run bounced off it. */
export async function recentLimitHits(days = 14, limit = 20): Promise<LimitHit[]> {
  const r = await pool.query<{
    id: string;
    title: string;
    updated_at: string;
    message: string;
  }>(
    `SELECT id::text, title, updated_at::text,
            (SELECT elem->>'content' FROM jsonb_array_elements(thread) elem
              WHERE elem->>'kind' = 'error' AND elem->>'content' ILIKE '%limit%'
              ORDER BY elem->>'ts' DESC LIMIT 1) AS message
       FROM runs
      WHERE status = 'failed'
        AND updated_at > now() - ($1 || ' days')::interval
        AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(thread) elem
               WHERE elem->>'kind' = 'error' AND elem->>'content' ILIKE '%limit%'
            )
      ORDER BY updated_at DESC
      LIMIT $2`,
    [String(days), limit],
  );
  return r.rows.map((row) => ({
    run_id: row.id,
    title: row.title,
    ts: row.updated_at,
    message: row.message,
  }));
}

/**
 * Park a run that died on the Claude subscription's usage wall: put it BACK on
 * the queue behind `wake_after` instead of leaving it as a corpse (R860).
 *
 * This resurrects the SAME row rather than creating a replacement, which is
 * what makes the recovery free: `runs.wake_after` (migration 0036) already
 * hides a queued run from claimNextRun() until its wake time passes, and the
 * executor's resume path already rebuilds the prompt from the thread — with a
 * live CC session it sends trailingUserBlock(), i.e. everything appended after
 * the last engine turn, which is exactly the `note` this writes. So the agent
 * wakes up holding its own transcript and a sentence explaining the gap. A new
 * run would have thrown that context away and paid for it again.
 *
 * `status = 'failed'` in the WHERE is the safety catch, not decoration. It is
 * the only status this may ever un-terminate: a 'cancelled' run was killed by
 * Konrad on purpose and must stay dead, a 'completed' one has already been
 * reconciled, and a 'stuck' one is resumable by hand and owns its own path.
 * Returns whether the row actually moved so the caller can fall back to the
 * ordinary failure path instead of assuming a park that never happened.
 */
export async function requeueRunAfterUsageWall(input: {
  runId: string;
  wakeAt: Date;
  /** 1-based; persisted as metadata.usage_wall_attempts and read back by the
   *  next reconcile to advance the backoff ladder. */
  attempt: number;
  /** Appended to the thread so the pause is visible in the run's transcript —
   *  and, on resume, is the text the engine is handed. */
  note: string;
}): Promise<boolean> {
  const entry: ThreadEntry = {
    role: "system",
    content: input.note,
    ts: new Date().toISOString(),
    kind: "text",
    meta: { usage_wall: true, usage_wall_attempt: input.attempt },
  };
  const r = await pool.query(
    `UPDATE runs
        SET status = 'queued',
            wake_after = $2,
            completed_at = NULL,
            stuck_signal = NULL,
            thread = thread || $3::jsonb,
            metadata = COALESCE(metadata, '{}'::jsonb) ||
                       jsonb_build_object('usage_wall_attempts', $4::int),
            updated_at = now()
      WHERE id = $1
        AND status = 'failed'`,
    [input.runId, input.wakeAt.toISOString(), JSON.stringify([entry]), input.attempt],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function runCounts(): Promise<Record<RunStatus, number>> {
  const r = await pool.query<{ status: RunStatus; count: string }>(
    // Same scope as listRuns — otherwise the rail header claims "28 completed"
    // above a list showing five, because the fleet's task rows were counted.
    `SELECT status, COUNT(*)::text AS count
       FROM runs
       WHERE archived = false
         AND parent_run_id IS NULL
         AND NOT (metadata ? 'project_id')
       GROUP BY status`,
  );
  const out: Record<RunStatus, number> = {
    queued: 0,
    running: 0,
    paused: 0,
    stuck: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of r.rows) out[row.status] = Number(row.count);
  return out;
}

/* ------------------------------------------------------------------------- *
 * Manager control plane — row primitives (CP1).
 *
 * Everything below is ADDITIVE: no existing helper changed behaviour for it.
 * Three rules govern this whole section and none of them is decoration:
 *
 *  1. NEVER READ-THEN-WRITE. The caller's precondition (the eligible-status
 *     list from run-control-rules.ts) travels INTO the UPDATE's WHERE clause,
 *     so two operators clicking stop and terminate at the same moment resolve
 *     to one applied write and one honest 409 — never a mixed state
 *     (07 §4, last paragraph).
 *  2. ROWCOUNT 0 IS A QUESTION, NOT AN ANSWER. It means either "no such run"
 *     or "the precondition did not hold", and the route owes the UI different
 *     codes for those (404 vs 409 + the CURRENT status). So every miss
 *     re-reads the status once and reports what it found.
 *  3. NO SWALLOWED ERRORS (C20). There is not a single try/catch here: a pg
 *     failure propagates to the route and becomes a visible 5xx rather than a
 *     202 that did nothing.
 *
 * All state is in the `runs` row — no side tables, no process-local delivery
 * state, so an executor restart can never strand a message (C23).
 * ------------------------------------------------------------------------- */

/** The rowcount-0 re-read (rule 2 above). null = the row does not exist. */
async function readRunStatus(id: string): Promise<RunStatus | null> {
  const r = await pool.query<{ status: RunStatus }>(
    `SELECT status FROM runs WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.status ?? null;
}

/**
 * The outcome of a guarded single-row write.
 *
 * `applied:false` carries the status the row ACTUALLY holds right now, so the
 * route can answer 409 with a reason naming it ("run is already paused"), or
 * 404 when `status` is null. A caller must never treat `applied:false` as a
 * no-op success — that is exactly the 200-that-did-nothing C20 forbids.
 */
export interface RunWriteResult {
  applied: boolean;
  status: RunStatus | null;
}

/**
 * Append a comms entry (07 §3) and, in the SAME statement, optionally move the
 * status and/or raise `metadata.pending_input`.
 *
 * One UPDATE does all of it on purpose. The plan's separate `markPendingInput`
 * helper is deliberately NOT built: 07 §5 specifies the flag write as a
 * "single stmt with T1", because a second statement would open a window in
 * which the entry is in the thread but the flag is not — the executor's
 * completion write (E1) could read `pending_input` as absent, complete the run,
 * and strand the message until something else requeued it. Fusing them makes
 * the handshake's "append lands before E1" case atomic. (Sanctioned deviation
 * from the phase plan's helper list; the CP1 gating reviewer has been briefed.)
 *
 * `opts.eligible` is the precondition, carried into SQL. Passing an EMPTY array
 * means nothing is eligible and the write is refused — it is not silently
 * treated as "no precondition"; omit the key for that.
 *
 * `clearCompletedAt` / `clearWakeAfter` exist because putting a settled run
 * back on the queue has to leave a row that does not lie about itself. The
 * executor's E2 (executor.ts, the pending-input requeue) and
 * `requeueRunAfterUsageWall` above both clear these stamps for the same reason,
 * and this is the third requeue path: without them, messaging a `completed` run
 * produces a `queued`/`running` row still carrying `completed_at`, so every
 * duration in the UI is wrong until it settles again — and if the watchdog
 * catches it first, a `stuck` row with a completion timestamp, which
 * completeRun's own invariant forbids. Two flags rather than one so the SET
 * clause says exactly what it does.
 */
export async function appendCommsEntry(
  id: string,
  entry: ThreadEntry,
  opts: {
    eligible?: readonly RunStatus[];
    setStatus?: RunStatus;
    setPendingInput?: boolean;
    clearCompletedAt?: boolean;
    clearWakeAfter?: boolean;
  } = {},
): Promise<RunWriteResult> {
  const params: unknown[] = [id, JSON.stringify([entry])];
  const sets = ["thread = thread || $2::jsonb"];

  if (opts.setStatus) {
    params.push(opts.setStatus);
    sets.push(`status = $${params.length}`);
  }
  if (opts.setPendingInput) {
    sets.push(
      `metadata = COALESCE(metadata, '{}'::jsonb) || '{"pending_input":true}'::jsonb`,
    );
  }
  if (opts.clearCompletedAt) sets.push("completed_at = NULL");
  if (opts.clearWakeAfter) sets.push("wake_after = NULL");
  sets.push("updated_at = now()");

  let where = "id = $1";
  if (opts.eligible) {
    params.push(opts.eligible);
    where += ` AND status = ANY($${params.length}::text[])`;
  }

  const r = await pool.query<{ status: RunStatus }>(
    `UPDATE runs SET ${sets.join(", ")} WHERE ${where} RETURNING status`,
    params,
  );
  // id is the primary key, so a hit is exactly one row; RETURNING gives the
  // POST-update status, which is what the route echoes back to the UI.
  const row = r.rows[0];
  if (r.rowCount === 1 && row) return { applied: true, status: row.status };
  return { applied: false, status: await readRunStatus(id) };
}

/**
 * Stop (C11): status → `paused`, eligible `queued|running|stuck`.
 *
 * No `completed_at` write — a paused run is not finished, it is interrupted,
 * and it stays resumable via /resume-chat. No kill machinery either: the
 * executor's existing 5s status poll (executor.ts ~line 857) reads `paused`
 * and SIGTERMs the child by itself.
 */
export async function stopRun(id: string): Promise<RunWriteResult> {
  const r = await pool.query<{ status: RunStatus }>(
    `UPDATE runs
        SET status = 'paused',
            updated_at = now()
      WHERE id = $1
        AND status = ANY($2::text[])
      RETURNING status`,
    [id, STOP_ELIGIBLE],
  );
  const row = r.rows[0];
  if (r.rowCount === 1 && row) return { applied: true, status: row.status };
  return { applied: false, status: await readRunStatus(id) };
}

/**
 * Terminate (C12): status → `cancelled` AND `completed_at = now()`, eligible
 * `queued|running|paused|stuck`.
 *
 * Both writes are in ONE statement — the contract §4 consistency fix (today's
 * cancel path leaves completed_at NULL and durations fall back to updated_at).
 * Because the precondition excludes `cancelled`, a double-terminate's second
 * call is refused rather than re-stamping, so there is no ordering in which a
 * row ends up `cancelled` with a NULL completed_at.
 */
export async function terminateRun(id: string): Promise<RunWriteResult> {
  const r = await pool.query<{ status: RunStatus }>(
    `UPDATE runs
        SET status = 'cancelled',
            completed_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status = ANY($2::text[])
      RETURNING status`,
    [id, TERMINATE_ELIGIBLE],
  );
  const row = r.rows[0];
  if (r.rowCount === 1 && row) return { applied: true, status: row.status };
  return { applied: false, status: await readRunStatus(id) };
}

/** One comms entry as GET /api/runs/:id/comms serves it (C14). */
export interface CommsEntry {
  role: string;
  content: string;
  ts: string;
  kind: string;
  meta: Record<string, unknown> | null;
}

/**
 * The run's comms traffic, oldest first (C14).
 *
 * Filtering happens in Postgres, not in Node: a long-running worker's thread is
 * megabytes of tool calls and shipping all of it to filter out a dozen entries
 * would make the UI's cheapest panel the most expensive query in the system.
 * WITH ORDINALITY + ORDER BY ord preserves thread order — jsonb_agg over a set
 * has no inherent ordering guarantee, so the ORDER BY is load-bearing.
 *
 * Each entry is rebuilt with jsonb_build_object rather than passed through
 * verbatim so that every key in CommsEntry is present in the JSON: an entry
 * written without `meta` comes back as `meta: null`, matching the declared
 * type, instead of an absent key the UI would have to guess about.
 *
 * Unknown run → null (the route answers 404). A known run with no comms →
 * `{run_id, comms: []}` — never null, because "no traffic yet" is a normal
 * state and must not read as "no such run".
 */
export async function listComms(
  id: string,
): Promise<{ run_id: string; comms: CommsEntry[] } | null> {
  const r = await pool.query<{ run_id: string; comms: CommsEntry[] }>(
    `SELECT r.id::text AS run_id,
            COALESCE(
              (SELECT jsonb_agg(
                        jsonb_build_object(
                          'role', e->>'role',
                          'content', e->>'content',
                          'ts', e->>'ts',
                          'kind', e->>'kind',
                          'meta', CASE WHEN jsonb_typeof(e->'meta') = 'object'
                                       THEN e->'meta' ELSE 'null'::jsonb END
                        ) ORDER BY ord)
                 FROM jsonb_array_elements(r.thread) WITH ORDINALITY AS t(e, ord)
                WHERE e->>'kind' = 'comms'),
              '[]'::jsonb) AS comms
       FROM runs r
      WHERE r.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { run_id: row.run_id, comms: row.comms ?? [] };
}
