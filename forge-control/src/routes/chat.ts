import { Hono } from "hono";
import pg from "pg";
import {
  loadCanvas,
  renderDelta,
  type CanvasSnapshot,
} from "../lib/canvas-context.ts";
import { streamSSE } from "hono/streaming";
import {
  listRuns,
  getRun,
  createRun,
  appendMessage,
  setRunCanvas,
  setRunCanvasSnapshot,
  setRunStatus,
  setRunModel,
  setRunEffort,
  runCounts,
  archiveRun,
  archiveAllRuns,
  searchRuns,
  type RunStatus,
} from "../db/runs.ts";
import { sanitizeEffort } from "../lib/cc-runner.ts";
/* phase 300g (U2/U3) — chat↔project linkage. All SQL lives in chat-linkage.ts;
 * this file only calls it. See that module for the scan bounds and the
 * backfill's idempotence guarantee. */
import {
  resolveChatProject,
  rollupChatProjects,
} from "./chat-linkage.ts";
/* phase 300h (U4) — the team tree reuses the SHAPING that /api/agents already
 * ships (frozen elapsed, agent_kind, sub-agent rollup + thread fallback). Only
 * the query is new; a second implementation of `agentFromRow` would drift the
 * first time one side is fixed. See agents-shared.ts's header. */
import {
  agentFromRow,
  numOr0,
  type AgentRowRaw,
  type AgentRun,
  type Subagent,
  type Usage,
} from "./agents-shared.ts";
/* phase 300h (U5) — the ONE definition of working time. `workingMsSql` is the
 * Postgres half of it, used here so multi-MB threads never leave the database
 * (measured: 70 ms for all 23 runs of this project + the chat itself). */
import {
  workingMsRunningExtension,
  workingMsSql,
  workingTimeFromRollup,
  type WorkingMsSource,
} from "./working-time.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "paused",
  "stuck",
  "completed",
  "failed",
  "cancelled",
]);

/* List threads (newest first, archived excluded) plus counts by status for
 * the rail. limit/offset page the rail — default 30 + "load more".
 *
 * U3 (phase 300g): each run that owns a coding project also carries
 * `project_id`, `project_status`, `tasks_done`, `tasks_total` so the rail can
 * render "x/y tasks" next to the status dot. Additive and OPTIONAL: a chat
 * with no project has the four fields ABSENT — not zeroed. `tasks_done: 0,
 * tasks_total: 0` would render as a real progress badge on a chat that never
 * started a project, which is precisely the kind of confident-looking lie
 * this phase exists to remove.
 *
 * Request cost is O(1) in page size: one listRuns, one runCounts, one grouped
 * rollup query for the whole page — no per-row query, and no thread scan
 * (that is the detail path's job; see chat-linkage.ts). CONSEQUENCE: chats
 * created before `origin_chat_id` existed show no x/y in the rail until they
 * are opened once, because opening a chat is what runs the scan and backfills
 * the link. */
r.get("/", async (c) => {
  const limit = Math.min(
    200,
    Math.max(1, Number(c.req.query("limit") ?? "30")),
  );
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0"));
  const [{ runs, hasMore }, counts] = await Promise.all([
    listRuns(limit, offset),
    runCounts(),
  ]);
  const links = await rollupChatProjects(runs.map((run) => run.id));
  const shaped = runs.map((run) => {
    const link = links.get(run.id);
    return link ? { ...run, ...link } : run;
  });
  return c.json({ count: shaped.length, runs: shaped, counts, hasMore });
});

/* ─── phase 300g (U2): linkage resolution for ONE chat ──────────────────────
 *
 * `GET /api/chat/:id/linkage` → `{chat_id, project_id, project_status,
 * link_source, link_ambiguous}`. Additive endpoint; nothing else changed.
 *
 * This is the detail-path resolver: metadata first, bounded thread scan as
 * fallback, and a one-time idempotent backfill when the scan is unambiguous
 * (chat-linkage.ts owns all three). Round 305's `GET /api/chat/:id/team`
 * calls the same function rather than re-deriving linkage.
 *
 * An unlinked chat — and a chat id that does not exist — answers 200 with
 * `project_id: null`. "No project" is a fact about this chat, not a failure;
 * only a malformed id (400) or a database error (500, via the resolver's
 * throw) is an error. */
r.get("/:id/linkage", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const link = await resolveChatProject(id);
  return c.json({ chat_id: id, ...link });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * phase 300h (U4, U5) — GET /api/chat/:id/team
 *
 * The org chart of ONE chat: the manager (this chat's own run), its workers
 * (every run of the project this chat started), and each worker's in-process
 * sub-agents. This is the endpoint the right sidebar reads; a stranger looking
 * at its output must be able to name who is managing whom, on which model, and
 * how much work each of them actually did.
 *
 * Three rules this endpoint exists to keep:
 *
 *  1. FROZEN TRUTH. A settled node's numbers are history. Nothing about a
 *     settled run, or a sub-agent whose parent process is gone, is derived
 *     from `now` — poll it twice a minute apart and those nodes are
 *     byte-identical. Only live nodes tick.
 *  2. REUSE, NOT REIMPLEMENTATION. Every node is shaped by `agentFromRow`
 *     (agents-shared.ts) and every millisecond of working time by
 *     `workingMsSql` / `workingTimeFromRollup` (working-time.ts). This file
 *     contributes queries and nesting — no second definition of any number.
 *  3. NO PARTIAL TREE PRESENTED AS COMPLETE (NFU6). The manager row, the
 *     linkage and the worker query are load-bearing: if any of them fails the
 *     answer is a 500 naming the step. The two ENRICHMENTS — working time and
 *     task titles — degrade instead: their fields go null, `complete` goes
 *     false, and `errors[]` says which one failed and why. A zero would be a
 *     lie; a null with a reason is a fact.
 * ═══════════════════════════════════════════════════════════════════════════ */

const { Pool } = pg;

/* Route-local pool, exactly as agents.ts and chat-linkage.ts keep theirs: the
 * `db/` helpers are owned by the engine lane this cycle and must not grow a
 * team query. chat-linkage.ts's pool is module-private and this round may not
 * edit that file, so the team endpoint opens its own — two connections, which
 * is what a 5 s poll of one panel needs. */
const teamPool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge",
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
teamPool.on("error", (e) => console.error("[chat team pool]", e.message));

/**
 * The column set `AgentRowRaw` documents, verbatim — see agents-shared.ts's
 * comment on that interface, which is the contract for callers with their own
 * SQL. The `::text` casts are load-bearing: without them pg hands back a JS
 * number for `spent_usd` and Date objects for the five timestamps, and the
 * wire shape stops matching what /api/agents has always carried.
 *
 * `thread` is pulled ONLY for rows that have no `subagents_v2` rollup, because
 * that is the exact condition under which `agentFromRow` falls back to folding
 * sub-agents out of the raw thread. Every other row gets NULL and stays small.
 * (agents.ts keys its own CASE on `rollup_v1` and additionally on liveness —
 * that is right for a 4 s poll over 60 rows of the global fleet; here a
 * finished worker's sub-agents must still appear months later, so the only
 * question is whether the fallback is needed at all.)
 */
const TEAM_RUN_COLUMNS = `id::text, title, status, worker, spent_usd::text,
       metadata,
       CASE WHEN metadata ? 'subagents_v2' THEN NULL::jsonb ELSE thread END AS thread,
       parent_run_id::text AS parent_run_id,
       started_at::text, updated_at::text, completed_at::text,
       last_heartbeat_at::text`;

/**
 * The worker query. Deliberately NOT `fetchActiveRows()` from agents.ts: that
 * one carries a 24 h recency window and LIMIT 60 because it feeds the global
 * Live panel, and a chat opened next week must still show its finished team.
 * Scope here is the project and nothing else.
 *
 * Two exclusions:
 *   • `metadata.role = 'manager'` — the same guard agents.ts applies to its
 *     project-scoped path. There are no such rows today; the guard is what
 *     keeps an engine-side manager run out of the worker list if one appears.
 *   • the chat's own id — the chat run IS the manager node. A chat that also
 *     carried `metadata.project_id` would otherwise appear twice in its own
 *     org chart.
 *
 * Ordered by `created_at`: the order the project spawned them, which is the
 * order the plan reads in. Not by status — this is an org chart, not a queue.
 */
const TEAM_WORKERS_SQL = `SELECT ${TEAM_RUN_COLUMNS}
  FROM runs
 WHERE metadata->>'project_id' = $1
   AND metadata->>'role' IS DISTINCT FROM 'manager'
   AND id <> $2
 ORDER BY created_at`;

const TEAM_MANAGER_SQL = `SELECT ${TEAM_RUN_COLUMNS} FROM runs WHERE id = $1 LIMIT 1`;

/**
 * Working time for every node of the tree, in one query, computed inside
 * Postgres (13 §4 / U5).
 *
 * Per run: the entry-gap sum from `workingMsSql`, plus the last thread entry's
 * timestamp so the caller can add the open trailing interval for a RUNNING
 * node — and only for a running node. `thread -> -1` is the last element of
 * the array; thread order is append order, so that is the last event. If it
 * carries no parseable `ts` the running extension is 0 (visible as a node
 * whose working time stops advancing), never a guess.
 *
 * Per sub-agent: the SAME fragment over that sub-agent's own slice of the
 * thread — the entries stamped with its `parent_tool_use_id`, re-assembled
 * with `jsonb_agg` in thread order and handed to `workingMsSql` unchanged.
 * Passing the slice to the shared fragment rather than rewriting the gap rule
 * with a PARTITION BY is the whole point: the sub-agent path cannot drift from
 * the run path, because it is the same SQL text.
 *
 * A sub-agent with no tagged entries produces no key here; the node falls back
 * to `workingTimeFromRollup` and is flagged `working_ms_source: "rollup"`.
 * Both cases exist in this very project (verified: run 3853c154… and ab331865…
 * carry slices, every other sub-agent falls back).
 */
const TEAM_TIMING_SQL = `SELECT r.id::text AS id,
       ${workingMsSql("r.thread")} AS working_ms,
       r.thread -> -1 ->> 'ts' AS last_ts,
       (
         SELECT coalesce(jsonb_object_agg(s.pid, jsonb_build_object(
                  'working_ms', ${workingMsSql("s.slice")},
                  'last_ts', s.slice -> -1 ->> 'ts')), '{}'::jsonb)
           FROM (
             SELECT p.pid, jsonb_agg(p.val ORDER BY p.ord) AS slice
               FROM (
                 SELECT e.val->'meta'->>'parent_tool_use_id' AS pid,
                        e.val, e.ord
                   FROM jsonb_array_elements(r.thread) WITH ORDINALITY AS e(val, ord)
                  WHERE e.val->'meta'->>'parent_tool_use_id' IS NOT NULL
               ) p
              GROUP BY p.pid
           ) s
       ) AS subagent_working
  FROM runs r
 WHERE r.id = ANY($1::uuid[])`;

/** Task titles for the workers of a project, in ONE grouped query — never one
 *  per row. `project_tasks.run_id` is the FK from a task to the run that
 *  executed it, so this is how a worker row learns which round it is doing. */
const TEAM_TASKS_SQL = `SELECT run_id::text AS run_id, id::text, round, role, title, status
  FROM project_tasks
 WHERE project_id = $1 AND run_id IS NOT NULL`;

interface TimingSlice {
  working_ms: number | string;
  last_ts: string | null;
}

interface TimingRow {
  id: string;
  /** bigint — node-postgres hands bigints back as strings. */
  working_ms: string;
  last_ts: string | null;
  subagent_working: Record<string, TimingSlice>;
}

interface TaskRow {
  run_id: string;
  id: string;
  round: number;
  role: string;
  title: string;
  status: string;
}

/** The task a worker run was spawned for, as the tree carries it. */
interface TeamTask {
  id: string;
  round: number;
  role: string;
  title: string;
  status: string;
}

/** U4's token block. `total` is the sum of the four counters that were already
 *  on the wire — no new token math, no cost, no dollars (10-ui-v3-spec.md:
 *  tokens are the currency this UI shows). */
interface TeamTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

/**
 * One row of the org chart (U4).
 *
 * `kind` is the KIND TRUTH the Live panel already renders, extended by one
 * value: a run node carries its `agent_kind` (`operator` for the chat itself,
 * `worker` for a project worker, `cron`/`unknown` for anything that does not
 * classify), and an in-process sub-agent carries `subagent`. That single field
 * is what tells a reader whether a row is a whole Claude Code session or a
 * Task-tool child living inside one.
 */
interface TeamNode {
  /** Run uuid for a session; the spawn's `tool_use_id` for a sub-agent. */
  id: string;
  kind: AgentRun["agent_kind"] | "subagent";
  role: string | null;
  model: string | null;
  status: string;
  tokens: TeamTokens;
  /** Milliseconds of attributed work, or null when the working-time query
   *  failed — see `errors[]`. Never 0-as-unknown. */
  working_ms: number | null;
  working_ms_source: WorkingMsSource | null;
  started_at: string | null;
  /** True when nothing about this node can change any more. For a run: a
   *  terminal status. For a sub-agent: its own completion OR its parent
   *  process having exited — a sub-agent cannot outlive the session it runs
   *  inside, so a "running" sub-agent under a settled parent is frozen too. */
  settled: boolean;
  /** The human one-liner: a worker's task title, a sub-agent's spawn
   *  description, otherwise the run title. Null only if none of those exist. */
  description: string | null;
  /** Lineage: the run this node hangs under. Null for the manager. */
  parent_id: string | null;
  /** Present on run nodes; empty on sub-agents (they do not nest further). */
  subagents: TeamNode[];
  /** The project task this run executed, when resolvable. Null for the
   *  manager, and for a worker whose task row was deleted. */
  task: TeamTask | null;
}

/** A named failure of an enrichment step. The tree still renders; the panel
 *  shows this text instead of pretending the missing numbers are zero. */
interface TeamError {
  /** Which step failed: "working_time" | "tasks". */
  scope: string;
  message: string;
}

interface TeamResponse {
  chat_id: string;
  now: string;
  project: { id: string; status: string | null } | null;
  link_source: "metadata" | "thread_scan" | null;
  link_ambiguous: boolean;
  manager: TeamNode;
  workers: TeamNode[];
  /** False when any enrichment failed. A client that shows numbers must check
   *  this before claiming the tree is the whole truth (NFU6). */
  complete: boolean;
  errors: TeamError[];
}

function teamTokens(u: Usage): TeamTokens {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cache_read: u.cache_read_input_tokens,
    cache_creation: u.cache_creation_input_tokens,
    total:
      u.input_tokens +
      u.output_tokens +
      u.cache_read_input_tokens +
      u.cache_creation_input_tokens,
  };
}

/**
 * Working time for a sub-agent.
 *
 * Preferred path: its own thread slice, already summed by `TEAM_TIMING_SQL`
 * with the shared fragment → `"thread"`.
 *
 * Fallback (13 §4): the wall-clock span from the `subagents_v2` rollup,
 * flagged `"rollup"` so the imprecision is VISIBLE rather than blended into
 * the precise numbers. The span is measured `started_at → updated_at`, which
 * is what 13 §4 specifies, and not `ended_at`: `ended_at` is the settle stamp
 * from the parent's tool_result and is routinely earlier than the sub-agent's
 * own last observed event (live example in this project: the `Explore`
 * sub-agent of run 3853c154… has started 06:47:12.533, ended 06:47:12.565 —
 * 32 ms — and a last activity at 06:53:09). Using it would report six minutes
 * of work as a rounding error.
 */
function subagentWorkingTime(
  sub: Subagent,
  slice: TimingSlice | undefined,
  live: boolean,
  nowMs: number,
): { working_ms: number; working_ms_source: WorkingMsSource } {
  if (slice) {
    const base = numOr0(slice.working_ms);
    return {
      working_ms: live
        ? base + workingMsRunningExtension(slice.last_ts, nowMs)
        : base,
      working_ms_source: "thread",
    };
  }
  const wt = live
    ? workingTimeFromRollup(sub.started_at, null, { runningNowMs: nowMs })
    : workingTimeFromRollup(sub.started_at, sub.updated_at);
  return { working_ms: wt.working_ms, working_ms_source: wt.working_ms_source };
}

/** Shape one already-shaped `AgentRun` (plus its sub-agents) into a tree node.
 *  `timing` is undefined when the working-time query failed — then every
 *  working number in this subtree is null, and errors[] carries the reason. */
function teamNodeFromRun(
  run: AgentRun,
  timing: TimingRow | undefined,
  task: TeamTask | null,
  nowMs: number,
): TeamNode {
  // Frozen truth: a settled run never sees `now`. Its thread cannot grow
  // again, so the entry-gap sum IS its final working time.
  const runWorking = timing
    ? run.settled
      ? numOr0(timing.working_ms)
      : numOr0(timing.working_ms) +
        workingMsRunningExtension(timing.last_ts, nowMs)
    : null;

  const subagents = run.subagents.map((sub) => {
    const live = !run.settled && sub.status === "running";
    const wt = timing
      ? subagentWorkingTime(sub, timing.subagent_working?.[sub.tool_use_id], live, nowMs)
      : null;
    const node: TeamNode = {
      id: sub.tool_use_id,
      kind: "subagent",
      role: sub.role,
      model: sub.model,
      status: sub.status,
      tokens: teamTokens(sub.usage),
      working_ms: wt ? wt.working_ms : null,
      working_ms_source: wt ? wt.working_ms_source : null,
      started_at: sub.started_at || null,
      settled: !live,
      description: sub.description,
      parent_id: run.id,
      subagents: [],
      task: null,
    };
    return node;
  });

  return {
    id: run.id,
    kind: run.agent_kind,
    role: run.role,
    model: run.model,
    status: run.status,
    tokens: teamTokens(run.usage_total),
    working_ms: runWorking,
    working_ms_source: timing ? "thread" : null,
    started_at: run.started_at,
    settled: run.settled,
    description: task ? task.title : (run.title ?? null),
    parent_id: run.parent_run_id,
    subagents,
    task,
  };
}

/** A load-bearing step failed: 500, naming the step and the database's own
 *  message. Never a tree with holes in it pretending to be an answer. */
function teamFailure(step: string, e: unknown): { error: string; step: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[chat team] ${step} failed:`, message);
  return { error: `team: ${step} failed`, step, message };
}

/**
 * GET /api/chat/:id/team → the scoped org tree.
 *
 * Status codes: 400 malformed id, 404 no such chat run, 200 for a real chat
 * whether or not it owns a project (an unlinked chat answers with its manager
 * node, `workers: []` and `project: null` — a chat with no project still shows
 * itself), 500 when a load-bearing query fails.
 *
 * Cost: 1 manager row + 1–3 linkage queries (chat-linkage.ts) + 1 worker query
 * + 1 task query + 1 timing query. Measured end-to-end against this project's
 * 22 workers: see docs/plan/artifacts/phase300/verification-305.md.
 */
r.get("/:id/team", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const nowMs = Date.now();
  const errors: TeamError[] = [];

  // ── 1. The manager: this chat's own run row. Its absence is a 404 — the
  //       only 404 this endpoint has. An unlinked chat is not one.
  let managerRow: AgentRowRaw | undefined;
  try {
    const res = await teamPool.query<AgentRowRaw>(TEAM_MANAGER_SQL, [id]);
    managerRow = res.rows[0];
  } catch (e) {
    return c.json(teamFailure("manager query", e), 500);
  }
  if (!managerRow) return c.json({ error: "run not found" }, 404);

  // ── 2. Linkage (U2). Round 304 owns the rule; this route only asks.
  let link;
  try {
    link = await resolveChatProject(id);
  } catch (e) {
    return c.json(teamFailure("linkage resolution", e), 500);
  }

  // ── 3. The workers. Empty by definition when the chat owns no project.
  let workerRows: AgentRowRaw[] = [];
  if (link.project_id) {
    try {
      const res = await teamPool.query<AgentRowRaw>(TEAM_WORKERS_SQL, [
        link.project_id,
        id,
      ]);
      workerRows = res.rows;
    } catch (e) {
      return c.json(teamFailure("worker query", e), 500);
    }
  }

  // ── 4. Enrichment A: task titles. One grouped query, never per row. A
  //       failure here costs titles, not the tree.
  const taskByRun = new Map<string, TeamTask>();
  if (link.project_id) {
    try {
      const res = await teamPool.query<TaskRow>(TEAM_TASKS_SQL, [link.project_id]);
      for (const row of res.rows) {
        // A run can only execute one task; if the data ever says otherwise the
        // first row wins and the duplicate is not silently merged into it.
        if (!taskByRun.has(row.run_id)) {
          taskByRun.set(row.run_id, {
            id: row.id,
            round: row.round,
            role: row.role,
            title: row.title,
            status: row.status,
          });
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[chat team] task query failed:", message);
      errors.push({ scope: "tasks", message });
    }
  }

  // ── 5. Enrichment B: working time, for the manager and every worker in one
  //       query. On failure every `working_ms` in the response is null and
  //       `complete` is false — a zero here would read as "did no work".
  const allRows = [managerRow, ...workerRows];
  const timingById = new Map<string, TimingRow>();
  let timingOk = true;
  try {
    const res = await teamPool.query<TimingRow>(TEAM_TIMING_SQL, [
      allRows.map((row) => row.id),
    ]);
    for (const row of res.rows) timingById.set(row.id, row);
  } catch (e) {
    timingOk = false;
    const message = e instanceof Error ? e.message : String(e);
    console.error("[chat team] working-time query failed:", message);
    errors.push({ scope: "working_time", message });
  }

  const shape = (row: AgentRowRaw): TeamNode =>
    teamNodeFromRun(
      agentFromRow(row, nowMs),
      timingOk ? timingById.get(row.id) : undefined,
      taskByRun.get(row.id) ?? null,
      nowMs,
    );

  const body: TeamResponse = {
    chat_id: id,
    now: new Date(nowMs).toISOString(),
    project: link.project_id
      ? { id: link.project_id, status: link.project_status }
      : null,
    link_source: link.link_source,
    link_ambiguous: link.link_ambiguous,
    manager: shape(managerRow),
    workers: workerRows.map(shape),
    complete: errors.length === 0,
    errors,
  };
  return c.json(body);
});

/* Search past chats — title, prompt, and every message in the thread, so a
 * word Konrad typed (or the engine replied with) is enough to find the
 * conversation, not just a title match. Includes closed/archived chats:
 * closing hides a chat from the rail but must never make it unfindable. */
r.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ q, runs: [] });
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "30")));
  const runs = await searchRuns(q, limit);
  return c.json({ q, runs });
});

/* Close every open chat in one shot — archives each and cancels any that
 * were still queued/running/paused/stuck. */
r.post("/archive-all", async (c) => {
  const archived = await archiveAllRuns();
  return c.json({ archived });
});

/* v2.0: live run events. Emits a `snapshot` (full run JSON) immediately
 * and whenever status / thread length / updated_at changes; `ping` keeps
 * proxies from closing the pipe. DB-poll at 1s — the executor streams CC
 * tool events into runs.thread, so this is what makes chat feel alive. */
r.get("/:id/events", (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    /** Every write races the client disconnecting. `alive` is only updated by
     *  onAbort, which can fire while we're awaiting the DB — so by the time we
     *  write, the stream may already be closed and hono throws
     *  ERR_INVALID_STATE ("ReadableStream is already closed"). That surfaced
     *  as a steady drip of unhandled errors in the API log and could take the
     *  request down. Closing is a normal, expected end to an SSE connection,
     *  not an error: treat a failed write as "client left" and stop cleanly. */
    const send = async (event: string, data: string): Promise<boolean> => {
      if (!alive) return false;
      try {
        await stream.writeSSE({ event, data });
        return true;
      } catch {
        alive = false;
        return false;
      }
    };

    let lastKey = "";
    let lastPing = Date.now();
    while (alive) {
      let run;
      try {
        run = await getRun(id);
      } catch (e) {
        console.error(
          "[chat events] getRun failed:",
          e instanceof Error ? e.message : e,
        );
        await stream.sleep(2_000);
        continue;
      }
      if (!alive) break; // disconnected while we were querying
      if (!run) {
        await send("gone", "{}");
        break;
      }
      const key = `${run.status}:${run.thread.length}:${run.updated_at}`;
      if (key !== lastKey) {
        lastKey = key;
        lastPing = Date.now();
        if (!(await send("snapshot", JSON.stringify({ run })))) break;
      } else if (Date.now() - lastPing > 15_000) {
        lastPing = Date.now();
        if (!(await send("ping", String(Date.now())))) break;
      }
      await stream.sleep(1_000);
    }
  });
});

/* Full thread detail. */
r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const run = await getRun(id);
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json({ run });
});

/* New chat. */
r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    prompt?: string;
    worker?: string;
    budget_usd?: number;
    metadata?: Record<string, unknown>;
  };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return c.json({ error: "prompt required" }, 400);
  const title = (body.title ?? prompt.split("\n")[0] ?? "untitled")
    .trim()
    .slice(0, 100);
  const run = await createRun({
    title,
    prompt,
    worker: body.worker,
    budget_usd: body.budget_usd,
    metadata: body.metadata,
  });
  return c.json({ run }, 201);
});

/* Append a user message and re-queue for executor pickup. */
r.post("/:id/message", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    content?: string;
    role?: "user" | "system";
    /** Vault-relative path of the drawing open beside the chat, if any. */
    canvas_path?: string;
  };
  const content = (body.content ?? "").trim();
  if (!content) return c.json({ error: "content required" }, 400);
  const role = body.role === "system" ? "system" : "user";

  // Canvas context. The board is sent in full the first time it appears in a
  // conversation, and after that only what changed — an untouched canvas adds
  // nothing to the thread, which is the whole point: these drawings are meant
  // to get huge, and re-sending an unchanged one every turn would burn the
  // context window on geometry nobody asked about.
  const canvasPath = (body.canvas_path ?? "").trim();
  if (canvasPath) {
    const current = await getRun(id);
    if (current) {
      const drawing = await loadCanvas(canvasPath);
      if (drawing) {
        const prev =
          (current.metadata?.canvas_snapshot as CanvasSnapshot | undefined) ??
          null;
        const delta = renderDelta(canvasPath, drawing, prev);
        if (delta.changed) {
          await appendMessage(id, {
            role: "system",
            content: delta.text,
            ts: new Date().toISOString(),
            kind: "text",
          });
        }
        // Snapshot even when unchanged: cheap, and it keeps takenAt honest.
        await setRunCanvasSnapshot(id, delta.snapshot);
      }
    }
  }

  const updated = await appendMessage(
    id,
    {
      role,
      content,
      ts: new Date().toISOString(),
      kind: "text",
    },
    { setStatus: "queued" },
  );
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* Resume a stuck run by appending a continue marker and re-queueing. The
 * marker is a system turn that the executor's buildPromptFromThread will
 * surface as a [SYSTEM] block to Claude — telling it not to repeat what it
 * already produced in the partial assistant turn. v1.6 phase 1.
 */
r.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const current = await getRun(id);
  if (!current) return c.json({ error: "run not found" }, 404);
  if (current.status !== "stuck") {
    return c.json(
      { error: `cannot resume run with status '${current.status}'` },
      409,
    );
  }
  const updated = await appendMessage(
    id,
    {
      role: "system",
      content:
        "[continue marker] Resume from where you stopped. Do not repeat what you already produced; pick up from the last partial assistant turn.",
      ts: new Date().toISOString(),
      kind: "text",
      meta: { continue_marker: true },
    },
    { setStatus: "queued" },
  );
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* v2.1: set the engine model for subsequent turns of this run. Aliases
 * (sonnet/opus/haiku) or full model ids; "default" clears the override. */
r.post("/:id/model", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { model?: string };
  const raw = (body.model ?? "").trim();
  if (!raw) return c.json({ error: "model required" }, 400);
  const model = raw === "default" ? null : raw;
  if (model !== null && !/^[a-z0-9[\]().-]+$/i.test(model)) {
    return c.json({ error: `invalid model: ${raw}` }, 400);
  }
  const updated = await setRunModel(id, model);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* PLAN.md F1: persist the vault-relative path of the drawing open beside this
 * chat. Was in browser localStorage before, which meant a chat opened on the
 * phone didn't know a canvas was pinned to it on the desktop. Empty string or
 * null clears the pin. Path shape is validated the same way the canvas routes
 * validate it — .excalidraw.md, no traversal — because it will be read from
 * this row and passed straight to loadCanvas() next turn. */
r.post("/:id/canvas", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { path?: string | null };
  const raw = body.path;
  let next: string | null;
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    next = null;
  } else if (typeof raw === "string") {
    const p = raw.trim();
    if (!p.endsWith(".excalidraw.md")) {
      return c.json({ error: "path must end with .excalidraw.md" }, 400);
    }
    if (p.includes("..") || p.startsWith("/")) {
      return c.json({ error: "path must be vault-relative" }, 400);
    }
    next = p;
  } else {
    return c.json({ error: "path must be a string or null" }, 400);
  }
  const updated = await setRunCanvas(id, next);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* v2.5: set the reasoning effort for subsequent turns of this run. One of
 * low/medium/high/xhigh/max; "default" clears the override. The web UI caps
 * its own picker at "high" — xhigh/max stay reachable via API/Telegram only. */
r.post("/:id/effort", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { effort?: string };
  const raw = (body.effort ?? "").trim();
  if (!raw) return c.json({ error: "effort required" }, 400);
  const effort = raw === "default" ? null : sanitizeEffort(raw);
  if (raw !== "default" && effort === null) {
    return c.json({ error: `invalid effort: ${raw}` }, 400);
  }
  const updated = await setRunEffort(id, effort);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* Close (archive) a single chat. Cancels it first if it's still doing
 * anything — see archiveRun. Logs are kept, just hidden from the rail. */
r.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const updated = await archiveRun(id);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* Status control: pause / resume / cancel. */
r.post("/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = (body.status ?? "") as RunStatus;
  if (!VALID_STATUSES.has(status))
    return c.json({ error: `invalid status: ${status}` }, 400);
  const updated = await setRunStatus(id, status);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

export default r;
