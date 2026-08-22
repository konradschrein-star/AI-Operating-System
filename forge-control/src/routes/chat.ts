import { Hono } from "hono";
/* phase 300i (U6) — the plan-doc endpoint reads ONE directory of the project's
 * own worktree; round 906 moved the choosing and the guarding of that directory
 * into lib/plan-corpus.ts so the listing and the reader cannot disagree about
 * which directory the corpus is. `realpath` is still load-bearing over there:
 * `resolve` alone cannot see a symlink escape. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { resolvePlanDoc, selectPlanCorpus } from "../lib/plan-corpus.ts";
/* phase 6 (R55) — the DERIVED depth the plan panel groups and orders by.
 * lib/task-graph.ts is a pure leaf: its only import is `import type
 * { TaskStatus }`, which erases, so it opens no pool and pulls no db module in
 * behind it. Importing it into a route is therefore safe in a way importing
 * db/projects.ts would not be. */
import { GraphIntegrityError, taskDepth, type GraphTask } from "../lib/task-graph.ts";
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
  type ThreadEntry,
} from "../db/runs.ts";
import { sanitizeEffort } from "../lib/cc-runner.ts";
/* phase 300g (U2/U3) — chat↔project linkage. All SQL lives in chat-linkage.ts;
 * this file only calls it. See that module for the scan bounds and the
 * backfill's idempotence guarantee. */
import {
  resolveChatProject,
  rollupChatProjects,
  type ChatProjectCandidate,
  type ChatProjectLink,
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
 * number for `spent_usd` and Date objects for the six timestamps, and the
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
const TEAM_RUN_COLUMNS = `runs.id::text, runs.title, runs.status, runs.worker,
       runs.spent_usd::text,
       runs.metadata,
       CASE WHEN runs.metadata ? 'subagents_v2' THEN NULL::jsonb ELSE runs.thread END AS thread,
       runs.parent_run_id::text AS parent_run_id,
       runs.started_at::text, runs.updated_at::text, runs.completed_at::text,
       runs.last_heartbeat_at::text,
       d.dismissed_at::text AS dismissed_at`;

/** The join that supplies the last of those columns (round 1350). `node_id` is
 *  `ui_dismissals`' primary key, so it can never multiply a row, and it is a
 *  LEFT join with no WHERE clause attached: a dismissed node is still in the
 *  tree, carrying the timestamp that lets the panel hide it and offer it back
 *  under "N dismissed · show". The team endpoint never filters on dismissal. */
const TEAM_DISMISSAL_JOIN = `LEFT JOIN ui_dismissals d ON d.node_id = runs.id::text`;

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
  ${TEAM_DISMISSAL_JOIN}
 WHERE runs.metadata->>'project_id' = $1
   AND runs.metadata->>'role' IS DISTINCT FROM 'manager'
   AND runs.id <> $2
 ORDER BY runs.created_at`;

const TEAM_MANAGER_SQL = `SELECT ${TEAM_RUN_COLUMNS}
  FROM runs
  ${TEAM_DISMISSAL_JOIN}
 WHERE runs.id = $1 LIMIT 1`;

/** Sub-agent dismissals, which no join can supply: a sub-agent node is keyed
 *  on a `tool_use_id` that lives inside `runs.thread` JSONB and has no row of
 *  its own. `kind` is the discriminator migration 0041 writes at insert time,
 *  so this reads only the handful of rows the run join cannot cover. */
const TEAM_SUBAGENT_DISMISSALS_SQL = `SELECT node_id, dismissed_at::text AS dismissed_at
  FROM ui_dismissals
 WHERE kind = 'subagent'`;

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
 *  executed it, so this is how a worker row learns which round it is doing.
 *
 *  `id` is NOT selected (round 1302, L2). It used to be, purely to be shipped
 *  as `task.id`, and no client reads it — the panel keys rows on the RUN id,
 *  and a task's own uuid appears in no tooltip, no nav frame and no query. It
 *  cost ~43 wire bytes on each of 93 nodes for nothing. The row is still
 *  keyed by `run_id`, which is what the tree joins on. */
const TEAM_TASKS_SQL = `SELECT run_id::text AS run_id, round, role, title, status
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
  round: number;
  role: string;
  title: string;
  status: string;
}

/** The task a worker run was spawned for, as the tree carries it.
 *
 *  No `id`: round 1302 removed it from the wire after grepping the whole web
 *  repo for a reader and finding none. What identifies a row is the RUN id;
 *  this block exists to say which round and role of the plan the run is
 *  executing, and every field left here is rendered — `title` by the row's
 *  description and by OrientationStrip, `round`/`role`/`status` by the row's
 *  lineage tooltip and the orientation strip's plan line. */
interface TeamTask {
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
  /** False when the zeros in `tokens` mean "nobody counted" rather than
   *  "counted, and it was zero" — see `Subagent.tokens_measured`. Always true
   *  on a run node: a run's usage is rolled up from its own turns. */
  tokens_measured: boolean;
  /** Milliseconds of attributed work, or null when it is not measurable:
   *  the working-time query failed (see `errors[]`), or this is a sub-agent
   *  whose rollup has no independent end stamp (`subagentWorkingTime`).
   *  Never 0-as-unknown — 0 means measured, and it was zero. */
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
  /** When Konrad hid this node from the panel, else null (`ui_dismissals`,
   *  round 1350). It ships INSIDE the tree so the panel's first paint is
   *  already correct — without it the panel would draw every node and then
   *  un-draw the hidden ones after a second round-trip. The tree itself is
   *  never filtered by this field: "N dismissed · show" needs the hidden nodes. */
  dismissed_at: string | null;
  /** Present on run nodes; empty on sub-agents (they do not nest further). */
  subagents: TeamNode[];
  /** The project task this run executed, when resolvable. Null for the
   *  manager, and for a worker whose task row was deleted. */
  task: TeamTask | null;
}

/** A named failure of an enrichment step. The tree still renders; the panel
 *  shows this text instead of pretending the missing numbers are zero. */
interface TeamError {
  /** Which step failed: "working_time" | "tasks" | "dismissals". */
  scope: string;
  message: string;
}

interface TeamResponse {
  chat_id: string;
  now: string;
  project: { id: string; status: string | null } | null;
  link_source: "metadata" | "thread_scan" | null;
  link_ambiguous: boolean;
  /** Every project this chat started, best first (round 1871). The panel
   *  renders a switcher when there is more than one, so an ambiguous chat is a
   *  choice rather than a nine-pixel apology. */
  candidates: ChatProjectCandidate[];
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
 *
 * The rollup may answer `null` (round 308, review finding 1). A run without
 * `metadata.subagents_v2` has its sub-agents synthesised from the spawn call
 * alone, so `started_at === updated_at` and the span is 0 BY CONSTRUCTION, not
 * by measurement — seven sub-agents of chat `11dd264b…` reported `working_ms:
 * 0` for work that visibly took over a minute each. `workingTimeFromRollup()`
 * returns null for that shape and this function passes it through unchanged,
 * which is the same doctrine step 5 of the route already applies to its own
 * failure path: a zero here would read as "did no work".
 */
function subagentWorkingTime(
  sub: Subagent,
  slice: TimingSlice | undefined,
  live: boolean,
  nowMs: number,
): { working_ms: number | null; working_ms_source: WorkingMsSource } {
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
 *  working number in this subtree is null, and errors[] carries the reason.
 *  `subDismissedAt` maps a sub-agent's `tool_use_id` to its dismissal stamp;
 *  the run node reads its own from `run.dismissed_at`, which came in on the
 *  join. An empty map is the honest answer when that query failed — errors[]
 *  says so, and an un-hidden node is the safe direction to be wrong in. */
function teamNodeFromRun(
  run: AgentRun,
  timing: TimingRow | undefined,
  task: TeamTask | null,
  nowMs: number,
  subDismissedAt: ReadonlyMap<string, string>,
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
      tokens_measured: sub.tokens_measured,
      working_ms: wt ? wt.working_ms : null,
      working_ms_source: wt ? wt.working_ms_source : null,
      started_at: sub.started_at || null,
      settled: !live,
      description: sub.description,
      parent_id: run.id,
      dismissed_at: subDismissedAt.get(sub.tool_use_id) ?? null,
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
    tokens_measured: true,
    working_ms: runWorking,
    working_ms_source: timing ? "thread" : null,
    started_at: run.started_at,
    settled: run.settled,
    description: task ? task.title : (run.title ?? null),
    parent_id: run.parent_run_id,
    dismissed_at: run.dismissed_at,
    subagents,
    task,
  };
}

/* ── Which of a chat's projects the caller wants (round 1871) ────────────────
 *
 * `resolveChatProject` ranks the projects claiming a chat and picks a default.
 * `?project_id=` lets the panel's switcher override it. The override is
 * VALIDATED against the candidate list rather than trusted: this endpoint's
 * whole contract is "the team of the project THIS CHAT started", and honouring
 * an arbitrary uuid would turn it into a general project reader that any
 * caller could point anywhere.
 *
 * An id that is not a candidate is a 400, not a silent fallback to the
 * default — a switcher that quietly shows you a different project than the one
 * you clicked is the exact failure this round is fixing.
 */
type ProjectChoice =
  | { ok: true; link: ChatProjectLink }
  | { ok: false; message: string };

function chooseProject(
  link: ChatProjectLink,
  requested: string | undefined,
): ProjectChoice {
  if (requested === undefined || requested === "") return { ok: true, link };
  const match = link.candidates.find((p) => p.id === requested);
  if (!match) {
    return {
      ok: false,
      message:
        `project_id ${requested} is not one of this chat's projects ` +
        `(${link.candidates.map((p) => p.id).join(", ") || "none"})`,
    };
  }
  return {
    ok: true,
    link: { ...link, project_id: match.id, project_status: match.status },
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

  // ── 2. Linkage (U2). Round 304 owns the rule; this route only asks. Round
  //       1871: `?project_id=` overrides the ranked default, validated.
  let link: ChatProjectLink;
  try {
    link = await resolveChatProject(id);
  } catch (e) {
    return c.json(teamFailure("linkage resolution", e), 500);
  }
  const chosen = chooseProject(link, c.req.query("project_id"));
  if (!chosen.ok) return c.json({ error: chosen.message }, 400);
  link = chosen.link;

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

  // ── 6. Enrichment C: dismissals for SUB-AGENT nodes (round 1350). Run nodes
  //       already carry theirs on the join; a sub-agent is a `tool_use_id`
  //       inside `runs.thread` with no row to join to, so its dismissal is
  //       looked up by id. A failure here costs hidden-ness, not the tree —
  //       the node renders visible and errors[] names the reason.
  const subDismissedAt = new Map<string, string>();
  try {
    const res = await teamPool.query<{ node_id: string; dismissed_at: string }>(
      TEAM_SUBAGENT_DISMISSALS_SQL,
    );
    for (const row of res.rows) subDismissedAt.set(row.node_id, row.dismissed_at);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[chat team] sub-agent dismissal query failed:", message);
    errors.push({ scope: "dismissals", message });
  }

  const shape = (row: AgentRowRaw): TeamNode =>
    teamNodeFromRun(
      agentFromRow(row, nowMs),
      timingOk ? timingById.get(row.id) : undefined,
      taskByRun.get(row.id) ?? null,
      nowMs,
      subDismissedAt,
    );

  const body: TeamResponse = {
    chat_id: id,
    now: new Date(nowMs).toISOString(),
    project: link.project_id
      ? { id: link.project_id, status: link.project_status }
      : null,
    link_source: link.link_source,
    link_ambiguous: link.link_ambiguous,
    candidates: link.candidates,
    manager: shape(managerRow),
    workers: workerRows.map(shape),
    complete: errors.length === 0,
    errors,
  };
  return c.json(body);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * phase 300i (U6) — GET /api/chat/:id/plan  and  GET /api/chat/:id/plan/doc
 *
 * The work in front of the project this chat started, and the planning corpus
 * that work was derived from.
 *
 * `/plan` is deliberately NOT a Kanban payload. 13 §7 makes the point that
 * matters: THIS RESPONSE IS THE STORE. The Kanban (U25) groups `phases[].tasks`
 * by block and counts statuses; a future graph toggle (U27) feeds the very same
 * task objects to React-Flow as nodes and `deps` as edges. Neither needs a
 * second endpoint, and neither may re-derive a number the server already
 * decided — that is how the rail badge and the panel bar ended up disagreeing
 * in the UI this rework replaces.
 *
 * `/plan/doc` streams one markdown file out of the project's own worktree.
 * routes/files.ts is off-limits this cycle AND its configured roots do not
 * cover per-project worktrees, so the restriction is implemented from scratch,
 * against ONE directory per project. Round 906: which directory that is is no
 * longer a constant — a project created since C18 (or relocated, as this one
 * was in round 901) keeps its corpus in `<workspace_dir>/docs/plan/<slug>/`,
 * while everything older is still flat in `<workspace_dir>/docs/plan/`. Both
 * endpoints below ask `selectPlanCorpus` (lib/plan-corpus.ts) which one it is
 * and then behave exactly as before against that single directory; the
 * restriction itself is unchanged and spelled out at `resolvePlanDoc` there.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** One task, in the shape 13 §7 names as the client store's `PlanNode`. */
interface PlanTask {
  id: string;
  round: number;
  role: string;
  title: string;
  status: string;
  /** The model tier the engine ran (or will run) this task on. Null is a real
   *  value here — the engine picks a default for tier-less tasks. */
  tier: string | null;
  deps: string[];
  /** Which workstream worktree the task runs in (R55). `'main'` for every row
   *  that predates migration 0040 and every row that does not ask for another,
   *  so this is never null and never absent — the column is NOT NULL DEFAULT
   *  'main'. The Kanban chip shows it only when it is not `'main'`. */
  workstream: string;
  /** DERIVED longest-path depth from the graph roots (R55, R19), computed by
   *  `taskDepth()` and never stored. It is not `round`: `round` is the
   *  planner's narrative phase number, `depth` is how far down the dependency
   *  chain this task actually sits. They agree only by coincidence.
   *
   *  When the stored graph cannot be ordered at all, every task's depth falls
   *  back to its own `round` and `PlanResponse.graph_error` says so — see
   *  `planDepths`. Silent on neither side. */
  depth: number;
}

interface PlanPhase {
  /** The hundreds-block: `floor(round / 100) * 100`. */
  round_base: number;
  /** The block's opening task title, when the corpus's own convention (planner
   *  or architect at k00) was followed. Absent when no task sits exactly on the
   *  base round — a phase label is not worth inventing. */
  title?: string;
  tasks: PlanTask[];
  /** Present ONLY when a file in the project's corpus carries this block's
   *  number (see `corpus` on the response for which directory that is). See
   *  `matchPhaseDoc`. Absent is the honest answer; a guessed path would 404 in
   *  the reader's face one click later. */
  doc_path?: string;
}

interface PlanResponse {
  chat_id: string;
  project: { id: string; status: string | null } | null;
  link_source: "metadata" | "thread_scan" | null;
  link_ambiguous: boolean;
  /** As on the team response — every project this chat started, best first. */
  candidates: ChatProjectCandidate[];
  phases: PlanPhase[];
  /** File names (not paths) of the project corpus's `*.md`, sorted. Names, not
   *  paths, is what makes `/plan/doc?name=` safe to keep bare: the client
   *  never learns — and never needs to send — the directory. */
  docs: string[];
  /** Which directory `docs` was listed from, and whether it is the project's
   *  own namespaced corpus (`docs/plan/<slug>/`) or the flat legacy
   *  `docs/plan/`. Round 906: the flat directory of a namespaced project's
   *  worktree holds ANOTHER project's corpus, so "which one did you read"
   *  stopped being a detail an operator can be expected to assume. Absent only
   *  when no directory could be derived at all (`error` says why). */
  corpus?: { dir: string; namespaced: boolean };
  /** Set when the docs listing failed — U6/NFU6: `docs: []` on its own would
   *  read as "this project has no plan corpus", which is a different fact from
   *  "the corpus could not be read, and here is why". The phases are unaffected
   *  and still present when this is set.
   *
   *  ROUND 1871 — THIS FIELD IS PROSE, and the panel prints it verbatim. It
   *  used to be `plan docs unreadable at /opt/…/docs/plan: ENOENT: no such
   *  file or directory, scandir '…'` — a Node error object stringified into
   *  Konrad's UI, which tells a reader nothing they can act on and reads as a
   *  crash. The machine-readable half now lives in `error_detail`. */
  error?: string;
  /** Set when `taskDepth()` refused to order the stored graph — a cycle in
   *  `depends_on` (R19's throw, R25/R26's display-side belt). Carries the
   *  thrown message VERBATIM, including the ids it names, and every task's
   *  `depth` is then its own `round`.
   *
   *  A SEPARATE field from `error` on purpose: `error` means "the docs listing
   *  failed" and its doc-comment above says exactly that. Overloading it would
   *  make two unrelated degradations indistinguishable to the one reader who
   *  has to act on them. Same idiom, NFU6 — "a null with a reason is a fact";
   *  the phases are still real and still drawn. */
  graph_error?: string;
  /** The raw fs error behind `error`, for the log and for a diagnostic
   *  disclosure — never the headline. */
  error_detail?: string;
}

/**
 * `error`'s prose, from an fs failure.
 *
 * Named codes get a sentence that says what happened AND what it means for the
 * board, because "the phases below are still real" is the part a reader needs;
 * anything else falls back to a generic sentence rather than to the exception's
 * own text. The directory is deliberately absent: it is a server path, it is
 * long enough to wrap the panel twice, and `error_detail` has it.
 */
function describeCorpusError(e: unknown, projectName: string): string {
  const code =
    e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  if (code === "ENOENT") {
    return (
      `${projectName} has no plan-docs directory yet — its planning corpus ` +
      `has not been written, or the worktree moved. The phases below are ` +
      `read from the database and are unaffected.`
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return `The plan-docs directory for ${projectName} could not be read (permission denied).`;
  }
  if (code === "ENOTDIR") {
    return `The plan-docs path for ${projectName} is a file, not a directory.`;
  }
  return `The plan docs for ${projectName} could not be listed.`;
}

/** Tasks of one project, oldest round first. `created_at` breaks ties inside a
 *  round so the four round-303 siblings keep the order the planner wrote them.
 *  Route-local by phase-300 law (13 §3): db/projects.ts is the engine lane's.
 *
 *  R54/R55 joined `depends_on`, `workstream` and `write_set`. `depends_on` is
 *  selected as `depends_on::text[]` to match the `id::text` convention here and
 *  the same cast in db/projects.ts's `TASK_COLS` — read the doc-comment on
 *  `ProjectTask.depends_on` there for why it is deliberate rather than
 *  necessary: a raw `uuid[]` already arrives as `string[]` on this host's pg,
 *  and the cast is what stops a future pg without the `_uuid` parser turning
 *  this field into the raw string `'{a,b}'` behind the comparison below.
 *  `write_set` is read but not published — it is the contention input the
 *  scheduler owns, and `PlanTask` gaining a field nothing draws would be a
 *  shape change bought for nothing (N4: the renderer is a different project). */
const PLAN_TASKS_SQL = `SELECT id::text, round, role, title, status, tier,
       depends_on::text[], workstream, write_set, graph_frozen
  FROM project_tasks
 WHERE project_id = $1
 ORDER BY round, created_at`;

/** The columns `/plan` needs beyond what the linkage resolver returns. `name`
 *  joined round 906: it is the input to `projectSlug`, and the slug is what
 *  says whether this project's corpus is its own `docs/plan/<slug>/` or the
 *  flat one. Reading the name here rather than slugging the project id keeps
 *  ONE derivation shared with project-tick.ts, which is what creates the
 *  directory in the first place. */
const PLAN_PROJECT_SQL = `SELECT name, workspace_dir, status FROM projects WHERE id = $1`;

interface PlanProjectRow {
  name: string;
  workspace_dir: string | null;
  status: string;
}

interface PlanTaskRow {
  id: string;
  round: number;
  role: string;
  title: string;
  status: string;
  tier: string | null;
  /** THE SENTINEL, unchanged from db/projects.ts's `ProjectTask.depends_on`:
   *  `null` means "never graph-scheduled, apply the legacy round rule", while
   *  a non-null array INCLUDING `[]` means "these ids and no others". Read here
   *  with `=== null` and nothing else. */
  depends_on: string[] | null;
  workstream: string;
  write_set: string[];
  /** Provenance of `depends_on` (migration 0040, R71): `true` only where the
   *  backfill wrote the array. Not drawn — carried because `GraphTask` requires
   *  it, and a hardcoded `false` here would be this route inventing a scheduling
   *  input rather than reading one. */
  graph_frozen: boolean;
}

/**
 * Longest-path depth for every task, or the disclosed fallback when the stored
 * graph has a cycle (R55, R19).
 *
 * ONE call to `taskDepth()`, and the `try` wraps exactly that call. Read its
 * doc-comment in lib/task-graph.ts before changing anything here: it is TOTAL
 * by construction — a legacy row seeds its own `round`, an absent dep
 * contributes no edge, a duplicate dep is one edge — so the ONLY thing it
 * throws on is a cycle, and it throws rather than returning the part of the map
 * it managed to compute. That is a deliberate inherited decision (phase 2A) and
 * this function does not soften it: it does not catch inside a per-task loop,
 * and it does not keep a partial map.
 *
 * THE DEGRADATION IS DISCLOSED, NOT SWALLOWED (NF1, NFU6). On a cycle the panel
 * still renders — every task's depth becomes its own `round`, which is the
 * number the operator was reading before this project existed — and the thrown
 * message travels to the client VERBATIM as `PlanResponse.graph_error`, ids and
 * all. The alternative, a 500, would take the Kanban down over a row it can
 * simply draw; the other alternative, a silent `depth = round`, would show an
 * operator a plausible board computed from a graph that cannot drain. Only
 * `GraphIntegrityError` is caught: anything else coming out of a pure function
 * over rows this route just read is a defect in the module, and defects belong
 * in `planFailure`'s 500, not in a field labelled "cycle".
 */
function planDepths(rows: PlanTaskRow[]): { depth: Map<string, number>; graph_error?: string } {
  /* `PlanTaskRow.status` is a plain `string` (the wire shape) while
   * `GraphTask.status` is the `TaskStatus` union. The cast is sound because
   * `project_tasks.status` carries
   * `CHECK (status IN ('pending','ready','running','done','failed','blocked'))`
   * — db/migrations/0030_coding_projects.sql lines 44-45 at git SHA 7efa36b,
   * resolved before this comment was written — which is exactly that union.
   * `taskDepth()` reads only `id`, `round` and `depends_on` in any case. */
  const graph: GraphTask[] = rows.map((row) => ({
    id: row.id,
    round: row.round,
    workstream: row.workstream,
    status: row.status as GraphTask["status"],
    depends_on: row.depends_on,
    write_set: row.write_set,
    graph_frozen: row.graph_frozen,
  }));

  try {
    return { depth: taskDepth(graph) };
  } catch (e) {
    if (!(e instanceof GraphIntegrityError)) throw e;
    console.error("[chat plan] taskDepth refused the stored graph:", e.message);
    const fallback = new Map<string, number>();
    for (const row of rows) fallback.set(row.id, row.round);
    return { depth: fallback, graph_error: e.message };
  }
}

/**
 * Group tasks into hundreds-blocks and attach `deps`, `workstream` and `depth`.
 *
 * DEPS, PRECISELY — two branches since R54, chosen by the `depends_on` sentinel
 * and by nothing else:
 *
 *  - `depends_on` NON-NULL, INCLUDING `[]`: those ids, verbatim, in that order.
 *    `[]` is an EXPLICIT graph root and yields `deps: []` — not the synthesised
 *    set, because a root that renders with inherited edges is a lie about the
 *    graph the scheduler will actually run. The array is COPIED, never aliased:
 *    the row belongs to the caller's result set.
 *  - `depends_on` NULL — the legacy sentinel: every task id in a STRICTLY LOWER
 *    round of the same project, byte-identical to what this function has always
 *    returned. That is the pre-graph engine's real ordering rule made explicit
 *    (13 §3) — project-tick released a round only once every task below it had
 *    settled, so "lower round" IS "must happen first". It is COARSE: round 306
 *    genuinely depends on 305 (same file) but only bureaucratically on 101, and
 *    the edge set says both. It is nonetheless TRUE for a row scheduled that
 *    way — no edge is a lie, only some are uninteresting.
 *
 * The sentinel is read with ONE `=== null` test. Never `?? []`, never
 * truthiness: `[]` and `null` are the two values a defaulting operator would
 * merge, and they are precisely the two this branch has to tell apart.
 * `readyRule()` in lib/task-graph.ts is the single interpreter of this sentinel
 * on the SCHEDULING path (phase 2A, commit bac02ec) and is deliberately not
 * imported here — this is display code, it decides nothing, and reaching for
 * `graphReady()`/`readyRule()` would put a scheduling decision in a route. It
 * reads the sentinel the same WAY, which is the part that must not drift.
 *
 * A DEP ID NAMING NO ROW IN THIS RESULT SET IS EMITTED ANYWAY, verbatim. R27
 * makes a dangling dep unreachable through the API, so one appearing here means
 * a corrupt row got in some other way; suppressing it would hide that from the
 * one surface an operator actually looks at, and hand back a tidy graph that
 * the scheduler will never drain. (`taskDepth()` takes the opposite decision
 * for its own arithmetic — an absent dep contributes no edge — because a
 * missing node cannot be given a longest path. Both are display; only this one
 * is a report.)
 *
 * PROMISE KEPT, R54, commit feat(engine-task-graph/phase-6, round 222). The
 * paragraph this comment replaced promised that "refining it later
 * (file-overlap, explicit `depends_on` column) changes which ids appear in this
 * array and NOTHING about the response shape". That refinement is this one, and
 * the promise held: `PlanTask` gained `workstream` and `depth` and lost
 * nothing, `deps` is still `string[]`, and the phase blocks still group by
 * `floor(round / 100) * 100`.
 *
 * Same-round siblings are never each other's deps under the legacy branch: the
 * four round-303 builders ran in parallel, by design, on disjoint files. The
 * running accumulator that guarantees it is unchanged, and graph rows still
 * feed it — a legacy row's "everything strictly below me" must include the
 * graph-scheduled rows below it, or a straddling project would read as two
 * disconnected boards.
 *
 * @param depth `planDepths()`'s map. Passed in rather than computed here so the
 *              single `taskDepth()` call and its one catch live in one named
 *              place instead of inside this loop.
 */
function groupPlanPhases(
  rows: PlanTaskRow[],
  docs: string[],
  depth: ReadonlyMap<string, number>,
): PlanPhase[] {
  const phases: PlanPhase[] = [];
  const byBase = new Map<number, PlanPhase>();
  /** ids of every task in a strictly lower round than the cursor. */
  const lower: string[] = [];
  /** ids of the round being read right now — they join `lower` only when the
   *  round changes, which is what keeps siblings out of each other's deps. */
  let pending: string[] = [];
  let currentRound: number | null = null;

  for (const row of rows) {
    if (currentRound !== null && row.round !== currentRound) {
      lower.push(...pending);
      pending = [];
    }
    currentRound = row.round;

    const base = Math.floor(row.round / 100) * 100;
    let phase = byBase.get(base);
    if (!phase) {
      phase = { round_base: base, tasks: [] };
      const docPath = matchPhaseDoc(base, docs);
      if (docPath) phase.doc_path = docPath;
      byBase.set(base, phase);
      phases.push(phase);
    }
    if (row.round === base) phase.title = row.title;

    /* `taskDepth()` returns a value for EVERY row it was given, and `planDepths`
     * gave it exactly these rows, so a miss is a defect in one of the two — not
     * a case to default away. Written as an explicit refusal rather than
     * `?? row.round`, which would be indistinguishable from a real depth that
     * happens to equal the round, and would therefore hide the defect on the
     * one surface built to expose it. */
    const rowDepth = depth.get(row.id);
    if (rowDepth === undefined) {
      throw new Error(
        `groupPlanPhases: no depth computed for task ${row.id} — planDepths() and ` +
          "this grouping disagree about the row set (this is a bug, not a data state)",
      );
    }

    phase.tasks.push({
      id: row.id,
      round: row.round,
      role: row.role,
      title: row.title,
      status: row.status,
      tier: row.tier,
      deps: row.depends_on === null ? [...lower] : [...row.depends_on],
      workstream: row.workstream,
      depth: rowDepth,
    });
    pending.push(row.id);
  }

  // `rows` arrives ordered by round, so `phases` is already ascending by base.
  return phases;
}

/**
 * Map a phase block to a file in docs/plan/, or to nothing.
 *
 * The rule is exact, not fuzzy: a file matches when one of its digit runs is
 * the block number written the same way — `300-read-side-api.md`,
 * `phase300.md` and `plan-300.md` all match block 300; `10-ui-v3-spec.md` does
 * not match block 100 (its runs are "10" and "3"), and `00-vision.md` does not
 * match block 0 ("00" is not "0").
 *
 * String comparison, not numeric, on purpose. Numeric equality would make
 * `00-vision.md` the plan document of round-0 by accident of zero-padding —
 * plausible-looking and unearned. U6 says: no match → no field.
 *
 * OBSERVED TODAY: this project's corpus is numbered `00-`…`16-` by document,
 * not by round, so nothing matches and no phase carries `doc_path`. That is
 * reported, not hidden: `docs[]` still lists all twelve files, and U26's reader
 * picks from that list. The day a phase doc is named `300-*.md` the field
 * appears with no code change.
 */
function matchPhaseDoc(roundBase: number, docs: string[]): string | undefined {
  const want = String(roundBase);
  const exact = docs.find((name) =>
    (name.match(/\d+/g) ?? []).some((run) => run === want),
  );
  if (exact) return exact;

  /* ── The corpus convention (round 1871) ───────────────────────────────────
   *
   * The rule above matches a document that spells the round base — `800-…md`.
   * No corpus in this database is named that way. Every planning corpus the
   * engine writes is a WATERFALL, numbered from zero in reading order:
   *
   *     00-vision.md  01-requirements.md  02-architecture.md
   *     03-quality.md 04-phases.md
   *
   * and the hundreds-blocks run 0, 100, 200, … in the same order. So block
   * `N*100` is document `N`, zero-padded to the width the corpus uses. On
   * engine-task-graph that matches five of ten blocks and — correctly —
   * nothing for 500-900, which have no document at all.
   *
   * IT IS A CONVENTION, NOT A FACT, and it is only allowed to fire on a name
   * whose number is the LEADING token: `04-phases.md` matches block 400,
   * `check-corpus-map.py` and `16-ui-v3-graph-research.md` cannot be dragged in
   * by a digit somewhere in the middle. The UI labels what it opens with the
   * file name, so a reader always sees which document a click produced.
   */
  const index = roundBase / 100;
  if (!Number.isInteger(index) || index < 0) return undefined;
  return docs.find((name) => {
    const lead = /^(\d+)[-_.]/.exec(name);
    return lead !== null && Number(lead[1]) === index;
  });
}

/** A load-bearing plan query failed: 500, naming the step. Mirrors
 *  `teamFailure` rather than sharing it so each endpoint's log prefix names
 *  the endpoint that actually broke. */
function planFailure(step: string, e: unknown): { error: string; step: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[chat plan] ${step} failed:`, message);
  return { error: `plan: ${step} failed`, step, message };
}

/**
 * GET /api/chat/:id/plan → the phases, their tasks, and the doc listing.
 *
 * Status codes: 400 malformed id, 200 otherwise — including a chat that owns
 * no project (`{project: null, phases: [], docs: []}`; "not a coding chat" is
 * a fact, not an error), and including an unreadable docs directory (the
 * phases are real; `error` names what could not be read). 500 only when the
 * task query or the project row itself fails, or when the pure grouping throws
 * something that is not a graph cycle — a defect, and defects are not fields.
 *
 * A CYCLE IN THE STORED GRAPH IS ALSO A 200 (R55). `depth` falls back to each
 * task's own `round` and `graph_error` carries the refusal verbatim; the phases
 * are real either way, and taking the panel down over a drawable board would be
 * the outage-in-place-of-a-diagram `taskDepth`'s own doc-comment rules out.
 *
 * Cost: 1–3 linkage queries (chat-linkage.ts) + 1 project row + 1 task query +
 * 1 readdir. No index, no cache — 13 §3: plan dirs are a dozen files and this
 * panel polls far slower than the team tree.
 */
r.get("/:id/plan", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  let link: ChatProjectLink;
  try {
    link = await resolveChatProject(id);
  } catch (e) {
    return c.json(planFailure("linkage resolution", e), 500);
  }
  /* Same override, same validation as `/team` — the two panels sit side by
   * side and must never be looking at different projects. */
  const chosen = chooseProject(link, c.req.query("project_id"));
  if (!chosen.ok) return c.json({ error: chosen.message }, 400);
  link = chosen.link;

  if (!link.project_id) {
    const empty: PlanResponse = {
      chat_id: id,
      project: null,
      link_source: link.link_source,
      link_ambiguous: link.link_ambiguous,
      candidates: link.candidates,
      phases: [],
      docs: [],
    };
    return c.json(empty);
  }

  let projectRow: PlanProjectRow | undefined;
  try {
    const res = await teamPool.query<PlanProjectRow>(PLAN_PROJECT_SQL, [link.project_id]);
    projectRow = res.rows[0];
  } catch (e) {
    return c.json(planFailure("project query", e), 500);
  }
  // The resolver only returns ids that exist; a miss here means the row was
  // deleted between the two queries. Say so instead of shipping empty phases.
  if (!projectRow) {
    return c.json(
      planFailure("project query", new Error(`project ${link.project_id} vanished mid-request`)),
      500,
    );
  }

  let taskRows: PlanTaskRow[];
  try {
    const res = await teamPool.query<PlanTaskRow>(PLAN_TASKS_SQL, [link.project_id]);
    taskRows = res.rows;
  } catch (e) {
    return c.json(planFailure("task query", e), 500);
  }

  // The docs listing degrades on its own (NFU6): a project whose worktree was
  // moved still has a real plan to show.
  //
  // ONE directory, chosen from the project row (round 906). The listing reads
  // the namespaced corpus when the project has one and the flat one only when
  // it does not — never both. Merging them is what put engine-v2's
  // `00-vision.md` in this project's panel, and a listing that offers a file
  // the doc reader will refuse (or, worse, serve from elsewhere) is a broken
  // contract between two endpoints that must agree by construction.
  let docs: string[] = [];
  let docsError: string | undefined;
  let docsDetail: string | undefined;
  let corpus: { dir: string; namespaced: boolean } | undefined;
  const dir = await selectPlanCorpus(
    projectRow.workspace_dir,
    projectRow.name,
    link.project_id,
  );
  if ("error" in dir) {
    docsError = dir.error;
  } else {
    corpus = { dir: dir.dir, namespaced: dir.namespaced };
    try {
      const entries = await readdir(dir.dir, { withFileTypes: true });
      docs = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
        .map((e) => e.name)
        .sort();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[chat plan] docs readdir failed:", message);
      docsError = describeCorpusError(e, projectRow.name);
      docsDetail = `readdir ${dir.dir}: ${message}`;
    }
  }

  // R55: depth is derived here, once, and handed to the grouping. A cycle in
  // the stored graph is NOT a failure — it degrades to `depth = round` and says
  // so in `graph_error` (see `planDepths`). Anything else escaping these two
  // pure calls is a defect in this route, and a defect gets the 500 with
  // diagnostics that `planFailure` writes rather than a half-built body.
  let depths: { depth: Map<string, number>; graph_error?: string };
  let phases: PlanPhase[];
  try {
    depths = planDepths(taskRows);
    phases = groupPlanPhases(taskRows, docs, depths.depth);
  } catch (e) {
    return c.json(planFailure("phase grouping", e), 500);
  }

  const body: PlanResponse = {
    chat_id: id,
    project: { id: link.project_id, status: projectRow.status },
    link_source: link.link_source,
    link_ambiguous: link.link_ambiguous,
    candidates: link.candidates,
    phases,
    docs,
  };
  if (corpus) body.corpus = corpus;
  if (docsError) body.error = docsError;
  if (depths.graph_error) body.graph_error = depths.graph_error;
  if (docsDetail) body.error_detail = docsDetail;
  return c.json(body);
});

/**
 * GET /api/chat/:id/plan/doc?name=<file> → one plan document as markdown.
 *
 * Status codes: 400 malformed id / rejected name / a corpus directory that
 * failed a safety check, 404 chat owns no project, no derivable plan directory,
 * or no such document, 413 over the size cap, 500 a query or an unexpected fs
 * error. 200 carries `text/markdown` and nothing else — no JSON envelope, so
 * the web surface can hand the body straight to `MessageMarkdown` (U26).
 *
 * An unlinked chat is a 404 here, not the 200 that `/plan` gives it: `/plan`
 * answers "what work exists" (none is a real answer), this answers "give me
 * this file" (there is no file, and no directory it could have come from).
 */
r.get("/:id/plan/doc", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const name = c.req.query("name") ?? "";

  let link: ChatProjectLink;
  try {
    link = await resolveChatProject(id);
  } catch (e) {
    return c.json(planFailure("linkage resolution", e), 500);
  }
  /* The switcher travels here too, or a chat showing its second project's
   * board would open the FIRST project's documents. */
  const chosen = chooseProject(link, c.req.query("project_id"));
  if (!chosen.ok) return c.json({ error: chosen.message }, 400);
  link = chosen.link;
  if (!link.project_id) {
    return c.json({ error: "chat is not linked to a project — no plan documents" }, 404);
  }

  let projectRow: PlanProjectRow;
  try {
    const res = await teamPool.query<PlanProjectRow>(PLAN_PROJECT_SQL, [link.project_id]);
    const row = res.rows[0];
    if (!row) {
      return c.json(
        planFailure("project query", new Error(`project ${link.project_id} vanished mid-request`)),
        500,
      );
    }
    projectRow = row;
  } catch (e) {
    return c.json(planFailure("project query", e), 500);
  }

  // The SAME choice `/plan` listed from — one call, one directory. If this
  // project has a namespaced corpus, a name that is not in it is a 404 and NOT
  // a second look in the flat directory: that second look is precisely how
  // engine-v2's `00-vision.md` was served under this project's plan panel in
  // round 904.
  const dir = await selectPlanCorpus(projectRow.workspace_dir, projectRow.name, link.project_id);
  if ("error" in dir) {
    // no-dir → 404 (nowhere to look, as before), refused → 400 (a safety check
    // said no, and the operator gets told which), fs → 500.
    const status = dir.kind === "no-dir" ? 404 : dir.kind === "refused" ? 400 : 500;
    if (dir.kind !== "no-dir") console.warn(`[chat plan doc] ${dir.error}`);
    return c.json({ error: dir.error, name }, status);
  }

  const decision = await resolvePlanDoc(dir.dir, name);
  if (!decision.ok) {
    if (decision.status === 400) console.warn(`[chat plan doc] ${decision.error}`);
    return c.json({ error: decision.error, name }, decision.status);
  }

  let content: string;
  try {
    content = await readFile(decision.file, "utf8");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[chat plan doc] read failed:", message);
    return c.json({ error: `cannot read ${name}: ${message}`, name }, 500);
  }
  return c.body(content, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": String(Buffer.byteLength(content)),
    "x-plan-doc": name,
  });
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

/** Fingerprint of the thread prefix we last shipped, used to prove the
 *  client's copy of entries [0, len) is still valid before we send a
 *  delta. runs.thread is append-only in practice (executor.ts and
 *  appendMessage both use `thread = thread || …`), so checking the tail
 *  entry is enough to catch the pathological case — a rewrite that keeps
 *  the length identical — without hashing the whole array every second. */
function prefixKey(thread: ThreadEntry[], len: number): string {
  if (len <= 0) return "0";
  const e = thread[len - 1];
  if (!e) return `${len}:missing`;
  return `${len}:${e.ts}:${e.role}:${e.kind ?? ""}:${(e.content ?? "").length}`;
}

/* v2.0: live run events. Emits one `snapshot` (full run JSON) on connect
 * and `append` deltas — `{from, entries, run}` with the thread stripped
 * off `run` — thereafter; `ping` keeps proxies from closing the pipe.
 * DB-poll at 1s.
 *
 * Deltas, not snapshots, because the old code re-sent the entire thread on
 * every executor tool event: a 300-entry run shipped ~300 copies of a
 * growing array — O(n²) bytes on the wire and a full re-map of the message
 * list in the client for each one. A delta is one entry.
 *
 * Resync contract: if the prefix the client holds can no longer be proven
 * intact (thread shrank, or the tail entry changed under us) we fall back
 * to a full `snapshot`. The client's own resync path — reconnect, which
 * always begins with a snapshot — covers the case where its cache is
 * behind ours. */
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
    /** -1 until the opening snapshot lands; then the number of thread
     *  entries the client is known to hold. */
    let sentLen = -1;
    let sentPrefix = "";
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
        const thread = run.thread;
        const canAppend =
          sentLen >= 0 &&
          thread.length >= sentLen &&
          prefixKey(thread, sentLen) === sentPrefix;
        if (canAppend) {
          const { thread: _thread, ...meta } = run;
          const payload = JSON.stringify({
            from: sentLen,
            entries: thread.slice(sentLen),
            run: meta,
          });
          if (!(await send("append", payload))) break;
        } else {
          if (!(await send("snapshot", JSON.stringify({ run })))) break;
        }
        sentLen = thread.length;
        sentPrefix = prefixKey(thread, sentLen);
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

/**
 * POST /api/chat/:id/compact — shrink a long chat's context.
 *
 * Konrad, 2026-08-18 at 82% of the window: *"I need a functionality that
 * compresses you."* There is no harness-level hook a chat can call, so this
 * does the only thing that actually reduces the next turn's context: it
 * REWRITES `runs.thread`, keeping the newest `keep` entries and replacing
 * everything older with one system entry that says what was dropped.
 *
 * IT ARCHIVES BEFORE IT REWRITES, and that is not optional. The full prior
 * thread is written to /opt/ai-os/backups/threads/<id>-<ts>.json and the
 * archive path is named in the marker. A compaction that destroyed the
 * transcript would be exactly the silent data loss this codebase spent a day
 * removing from the vault write path. If the archive write fails, nothing is
 * rewritten and the route 500s — never compact what you could not save first.
 *
 * `keep` is clamped to [10, 400]. Below 10 the agent loses the thread of the
 * conversation it is in; above 400 there is no point compacting.
 */
r.post("/:id/compact", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const current = await getRun(id);
  if (!current) return c.json({ error: "run not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { keep?: number };
  const keep = Math.min(400, Math.max(10, Number(body.keep ?? 60)));

  const thread = Array.isArray(current.thread) ? current.thread : [];
  /* `keep + 1`, not `keep`: this route's OUTPUT is always the marker plus
   * `keep` entries, so a thread of exactly keep+1 is already compacted. Using
   * `keep` here made the route non-idempotent — a second /compact dropped one
   * more real entry and stacked a second marker, eroding the transcript one
   * message per invocation. Found by running it twice, which is the only way
   * that class of bug shows itself. */
  if (thread.length <= keep + 1) {
    /* SHORT TRANSCRIPT, FAT SESSION — still worth resetting.
     *
     * "Already short" is a statement about OUR copy of the thread. It says
     * nothing about the engine session, which is where the model's context
     * actually lives. After one compaction the thread is `keep + 1` entries
     * forever, so every later /compact used to bail here and never drop the
     * session again — the bar stayed pinned and the command looked broken for
     * the second time in the same way it looked broken the first time.
     *
     * So: nothing to archive, nothing to rewrite, but if a session is live it
     * still goes. That is the part Konrad is actually asking for. */
    const live = typeof (current.metadata as Record<string, unknown> | null)?.cc_session_id === "string";
    if (!live) {
      return c.json({
        compacted: false,
        reason: "already short, and no engine session to reset",
        entries: thread.length,
        session_reset: false,
      });
    }
    const keptChars = thread.reduce(
      (n, e) => n + String((e as { content?: unknown }).content ?? "").length + 16,
      0,
    );
    /* NEVER RAISE THE BAR. The estimate is chars/4 over what survives, which on
     * a SHORT chat can exceed the real measured figure — compaction would then
     * make the gauge climb, which is nonsense: freeing context cannot cost
     * context. Take the lesser of the two. On the fat chats this command exists
     * for, the estimate is the smaller number by orders of magnitude and this
     * guard never binds. */
    const priorTokens = Number(
      (
        ((current.metadata as Record<string, unknown> | null)?.usage_running as
          | Record<string, unknown>
          | undefined)?.input_tokens ?? Number.POSITIVE_INFINITY
      ),
    );
    const estTokens = Math.max(
      1,
      Math.min(Math.round(keptChars / 4), Number.isFinite(priorTokens) ? priorTokens : Infinity),
    );
    await teamPool.query(
      `UPDATE runs
          SET metadata = (coalesce(metadata,'{}'::jsonb) - 'cc_session_id')
                         || jsonb_build_object(
                              'compacted_at', to_jsonb(now()),
                              'usage_last_turn', jsonb_build_object(
                                'input_tokens', $2::int, 'output_tokens', 0, 'estimated', true
                              ),
                              /* usage_running is what the ctx gauge reads FIRST
                               * (readContextTokens prefers it), and despite the
                               * name it holds the LAST assistant message, not a
                               * running total. Overwriting only usage_last_turn
                               * left the stale pre-compaction figure winning and
                               * the bar pinned — the exact symptom this whole
                               * fix exists to remove. */
                              'usage_running', jsonb_build_object(
                                'input_tokens', $2::int, 'output_tokens', 0, 'estimated', true
                              )
                            ),
              updated_at = now()
        WHERE id = $1`,
      [id, estTokens],
    );
    return c.json({
      compacted: false,
      reason: "already short — transcript untouched, engine session reset",
      entries: thread.length,
      session_reset: true,
      estimated_tokens: estTokens,
    });
  }

  const dropped = thread.length - keep;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = "/opt/ai-os/backups/threads";
  const archive = `${dir}/${id}-${stamp}.json`;
  // Archive FIRST. A failure here must abort the compaction, not proceed.
  await mkdir(dir, { recursive: true });
  await writeFile(archive, JSON.stringify(thread), "utf8");

  const marker = {
    role: "system",
    content:
      `[compacted ${stamp}] ${dropped} earlier entries of this chat were removed from the ` +
      `working context to free room. NOTHING WAS LOST: the full transcript is archived at ` +
      `${archive}. Durable state for this session lives in the Obsidian vault — read ` +
      `"AI OS/Session State" and "AI OS/Operator Decisions" before assuming anything about ` +
      `what was decided. The ${keep} most recent entries follow verbatim.`,
    ts: new Date().toISOString(),
    kind: "text",
    meta: { compaction: { dropped, kept: keep, archive } },
  };

  const next = [marker, ...thread.slice(-keep)];

  /* ── DROPPING cc_session_id IS WHAT ACTUALLY RESETS THE WINDOW ─────────────
   *
   * Rewriting `runs.thread` was only ever half of a compaction, and on the
   * surface Konrad uses it was the half that does nothing. The `claude-code`
   * engine passes `--resume <cc_session_id>` and sends ONLY the trailing user
   * block: the history lives inside Claude Code's own session, not in our
   * thread. So the old route shrank our copy while the model kept carrying
   * every original turn, and the `ctx` bar — which reads `usage_last_turn`,
   * a number the CLI reports — never moved. Konrad, 2026-08-22: "compressing
   * still doesn't seem to work on resetting the context window."
   *
   * Removing the session id makes the next turn start a FRESH session, seeded
   * from the compacted thread above. That is the reset.
   *
   * `usage_last_turn` is replaced with an ESTIMATE of the compacted size so the
   * gauge moves at once instead of staying pinned to the pre-compaction figure
   * until the next turn happens to land. It is flagged `estimated: true`, and
   * the next real turn overwrites it with the CLI's own measurement — showing
   * the stale number would be the more misleading of the two. */
  const keptChars = next.reduce(
    (n, e) => n + String((e as { content?: unknown }).content ?? "").length + 16,
    0,
  );
  /* Same guard as the short-thread branch: compaction may lower the reading,
   * never raise it. */
  const priorRunning = Number(
    (
      ((current.metadata as Record<string, unknown> | null)?.usage_running as
        | Record<string, unknown>
        | undefined)?.input_tokens ?? Number.POSITIVE_INFINITY
    ),
  );
  const estTokens = Math.max(
    1,
    Math.min(Math.round(keptChars / 4), Number.isFinite(priorRunning) ? priorRunning : Infinity),
  );

  const { rows } = await teamPool.query(
    `UPDATE runs
        SET thread = $2::jsonb,
            metadata = (coalesce(metadata,'{}'::jsonb) - 'cc_session_id')
                       || jsonb_build_object(
                            'last_compaction', $3::text,
                            'compacted_at', to_jsonb(now()),
                            'usage_last_turn', jsonb_build_object(
                              'input_tokens', $4::int,
                              'output_tokens', 0,
                              'estimated', true
                            ),
                            /* See the short-thread branch: the gauge reads
                             * usage_running first, so it must move too. */
                            'usage_running', jsonb_build_object(
                              'input_tokens', $4::int,
                              'output_tokens', 0,
                              'estimated', true
                            )
                          ),
            updated_at = now()
      WHERE id = $1
      RETURNING id, (metadata ? 'cc_session_id') AS still_has_session`,
    [id, JSON.stringify(next), archive, estTokens],
  );
  if (!rows.length) return c.json({ error: "run not found" }, 404);

  return c.json({
    compacted: true,
    dropped,
    kept: next.length,
    was: thread.length,
    archive,
    /* The honest signal that the window was reset, not just the transcript
     * trimmed. False here means the next turn will resume the old session. */
    session_reset: rows[0].still_has_session === false,
    estimated_tokens: estTokens,
  });
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
