/**
 * /api/agents — live agent activity feed for the desktop Live panel.
 *
 * Konrad wanted the Claude Code CLI's transparency: for every agent that is
 * actively burning tokens right now, show ELAPSED runtime, tokens in/out
 * (including cache hits — that's where the real cost signal lives), the
 * running USD spend, the model powering it, and what tool it's touching
 * this second. The old Live panel showed none of that.
 *
 * Two concurrency systems, one endpoint. Distinguished by `kind`:
 *
 *   • System B — durable forge-control tasks. Each is a separate `claude`
 *     CLI process (its own row in `runs`), survives session cycles, has a
 *     UUID, spend, heartbeat. These are the "workers". `kind: "run"`.
 *
 *   • System A — Claude Code sub-agents (Task tool). They live INSIDE one
 *     System B run's CLI process, share its session, and vanish when the
 *     parent exits. Detected on the wire via `parent_tool_use_id` — the
 *     executor's onEvent stamps every streamed event with it and registers
 *     Task-tool spawns in `runs.thread[].meta.spawns_subagent_role`.
 *     `kind: "subagent"`, nested under `run.subagents`.
 *
 * The UI renders System B as top-level rows and System A as indented
 * children — mirroring the actual "workers vs. threads inside a worker"
 * split so the concurrency model is legible at a glance.
 */

import { Hono } from "hono";
import pg from "pg";
import type { ThreadEntry } from "../db/runs.ts";

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
pool.on("error", (e) => console.error("[agents pool]", e.message));

const r = new Hono();

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface ModelBreakdown extends Usage {
  model: string;
  cost_usd: number;
}

interface CurrentActivity {
  kind: "tool_call" | "tool_result" | "assistant_text" | "thinking";
  tool?: string | null;
  text?: string | null;
  parent_tool_use_id?: string | null;
  model?: string | null;
  ts?: string | null;
}

interface Subagent {
  kind: "subagent";
  /** parent Task tool_use_id — the spawn identity, stable inside the turn */
  tool_use_id: string;
  role: string;
  model: string | null;
  started_at: string;
  updated_at: string;
  usage: Usage;
  event_count: number;
  latest_activity: {
    kind: string;
    tool: string | null;
    text: string | null;
    ts: string;
  } | null;
  status: "running" | "done";
}

interface AgentRun {
  kind: "run";
  id: string;
  title: string;
  status: string;
  worker: string | null;
  model: string | null;
  effort: string | null;
  engine: string;
  cwd: string | null;
  started_at: string | null;
  updated_at: string;
  last_heartbeat_at: string | null;
  /** Live wall-clock derived server-side too, so a paused UI reflects the
   *  true elapsed by the time it renders (the client also ticks it). */
  elapsed_ms: number | null;
  spent_usd: number;
  /** Aggregate across every turn this run has taken. */
  usage_total: Usage & {
    turns: number;
    cost_usd: number;
    thinking_tokens: number;
  };
  /** Just the last turn (the current one, when still `running`). */
  usage_last_turn: Usage;
  /** Live counter streaming during the current turn — populated even
   *  between tool calls, so the UI has something ticking. */
  usage_running: Usage | null;
  usage_by_model: ModelBreakdown[];
  current_activity: CurrentActivity | null;
  parent_run_id: string | null;
  /** System A sub-agents currently active within this run's process. */
  subagents: Subagent[];
}

interface AgentSummary {
  running: number;
  queued: number;
  stuck: number;
  paused: number;
  active_subagents: number;
  spent_usd_last_hour: number;
  tokens_in_last_hour: number;
  tokens_out_last_hour: number;
}

interface AgentsResponse {
  now: string;
  summary: AgentSummary;
  agents: AgentRun[];
}

// A run is "active" for this view whenever the operator would care about
// it — anything with a real running CLI attached (running/queued/paused/
// stuck) plus anything that finished within the last 90s so a completion
// briefly stays visible instead of vanishing mid-tick.
const RECENT_COMPLETION_WINDOW_MS = 90_000;

function numOr0(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function pickUsage(src: unknown): Usage {
  if (!src || typeof src !== "object") {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
  }
  const s = src as Record<string, unknown>;
  return {
    input_tokens: numOr0(s.input_tokens),
    output_tokens: numOr0(s.output_tokens),
    cache_read_input_tokens: numOr0(s.cache_read_input_tokens),
    cache_creation_input_tokens: numOr0(s.cache_creation_input_tokens),
  };
}

function pickTotal(src: unknown): AgentRun["usage_total"] {
  const base = pickUsage(src);
  const s = (src && typeof src === "object" ? src : {}) as Record<string, unknown>;
  return {
    ...base,
    turns: numOr0(s.turns),
    cost_usd: numOr0(s.cost_usd),
    thinking_tokens: numOr0(s.thinking_tokens),
  };
}

function pickModelBreakdown(src: unknown): ModelBreakdown[] {
  if (!Array.isArray(src)) return [];
  return src
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      model: typeof x.model === "string" ? x.model : "unknown",
      input_tokens: numOr0(x.input_tokens),
      output_tokens: numOr0(x.output_tokens),
      cache_read_input_tokens: numOr0(x.cache_read_input_tokens),
      cache_creation_input_tokens: numOr0(x.cache_creation_input_tokens),
      cost_usd: numOr0(x.cost_usd),
    }));
}

function pickCurrentActivity(src: unknown): CurrentActivity | null {
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  const kind = s.kind;
  if (
    kind !== "tool_call" &&
    kind !== "tool_result" &&
    kind !== "assistant_text" &&
    kind !== "thinking"
  ) {
    return null;
  }
  return {
    kind,
    tool: typeof s.tool === "string" ? s.tool : null,
    text: typeof s.text === "string" ? s.text : null,
    parent_tool_use_id:
      typeof s.parent_tool_use_id === "string" ? s.parent_tool_use_id : null,
    model: typeof s.model === "string" ? s.model : null,
    ts: typeof s.ts === "string" ? s.ts : null,
  };
}

/** Fold sub-agent events out of the thread. Anything with
 *  meta.parent_tool_use_id is one; group by that id so an architect that
 *  ran 40 tool calls collapses to one row with its latest activity.
 *  Sub-agents are considered "done" once their tool_result has fired for
 *  the parent Task call — we detect that by scanning for the matching
 *  tool_result entry whose meta.tool_use_id equals the parent's Task
 *  tool_use_id. */
function foldSubagents(thread: ThreadEntry[]): Subagent[] {
  if (!Array.isArray(thread) || thread.length === 0) return [];
  // 1) Registry: tool_use_id of every Task spawn → its declared role.
  const spawn = new Map<string, { role: string; model: string | null; ts: string }>();
  // 2) Completion: set of Task tool_use_ids whose result has arrived.
  const completed = new Set<string>();
  for (const e of thread) {
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    if (
      e.kind === "tool_call" &&
      typeof meta.tool === "string" &&
      // The CLI names this tool "Agent"; the docs (and older transcripts)
      // call it "Task". Matching only "Task" is exactly why no sub-agent ever
      // showed in the Live panel even on runs that obviously spawned them —
      // this session alone logged 7 "Agent" calls and zero "Task" calls.
      (meta.tool === "Agent" || meta.tool === "Task") &&
      typeof meta.tool_use_id === "string"
    ) {
      // Prefer an explicit label; otherwise read the spawn's own input, which
      // carries {"subagent_type":"builder","description":"..."}.
      let role =
        typeof meta.spawns_subagent_role === "string"
          ? meta.spawns_subagent_role
          : "";
      if (!role && typeof meta.input === "string") {
        try {
          const parsed = JSON.parse(meta.input) as Record<string, unknown>;
          if (typeof parsed.subagent_type === "string") {
            role = parsed.subagent_type;
          } else if (typeof parsed.description === "string") {
            role = parsed.description;
          }
        } catch {
          /* input isn't JSON — fall through to the default */
        }
      }
      if (!role) role = "agent";
      spawn.set(meta.tool_use_id, {
        role,
        model: typeof meta.model === "string" ? meta.model : null,
        ts: e.ts,
      });
    }
    if (
      e.kind === "tool_result" &&
      typeof meta.tool_use_id === "string" &&
      // A result whose tool_use_id is a known spawn == that sub-agent finished
      spawn.has(meta.tool_use_id)
    ) {
      completed.add(meta.tool_use_id);
    }
  }

  // 3) Fold events belonging to each spawn.
  const acc = new Map<
    string,
    Omit<Subagent, "kind" | "tool_use_id"> & { tool_use_id: string }
  >();

  // Seed a row for EVERY observed spawn, before folding child events.
  //
  // Folding alone produced nothing: rows were only created from entries
  // carrying `meta.parent_tool_use_id`, and the CLI does not stamp that here
  // (this run has 7 spawns and zero parent-tagged entries). So a sub-agent
  // that ran to completion was invisible purely because its individual steps
  // weren't attributable. The spawn call and its result are enough to show
  // that it ran, its role, when it started and whether it finished; any
  // parent-tagged events found below then enrich the row with live token
  // counts and current activity.
  for (const [id, seed] of spawn) {
    acc.set(id, {
      tool_use_id: id,
      role: seed.role,
      model: seed.model,
      started_at: seed.ts,
      updated_at: seed.ts,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      event_count: 0,
      latest_activity: null,
      status: completed.has(id) ? "done" : "running",
    });
  }

  for (const e of thread) {
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    const parent =
      typeof meta.parent_tool_use_id === "string"
        ? meta.parent_tool_use_id
        : null;
    if (!parent) continue;
    const seed = spawn.get(parent);
    if (!seed) continue; // orphan — parent spawn wasn't observed
    let row = acc.get(parent);
    if (!row) {
      row = {
        tool_use_id: parent,
        role: seed.role,
        model: typeof meta.model === "string" ? meta.model : seed.model,
        started_at: seed.ts,
        updated_at: e.ts,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        event_count: 0,
        latest_activity: null,
        status: completed.has(parent) ? "done" : "running",
      };
      acc.set(parent, row);
    }
    row.event_count += 1;
    row.updated_at = e.ts;
    // Any thread entry belonging to this subagent may carry a
    // meta.usage object stamped by the executor when it saw an assistant
    // frame arrive under this parent_tool_use_id. Sum them so the row
    // reflects real tokens burned, not a permanent zero.
    const usageDelta = pickUsage((meta as Record<string, unknown>).usage);
    row.usage.input_tokens += usageDelta.input_tokens;
    row.usage.output_tokens += usageDelta.output_tokens;
    row.usage.cache_read_input_tokens += usageDelta.cache_read_input_tokens;
    row.usage.cache_creation_input_tokens += usageDelta.cache_creation_input_tokens;
    row.latest_activity = {
      kind: String(e.kind ?? "text"),
      tool: typeof meta.tool === "string" ? meta.tool : null,
      text:
        e.kind === "text"
          ? (e.content ?? "").slice(0, 160)
          : typeof meta.tool === "string"
            ? String(meta.tool)
            : null,
      ts: e.ts,
    };
  }

  return Array.from(acc.values()).map((r) => ({ kind: "subagent" as const, ...r }));
}

interface AgentRowRaw {
  id: string;
  title: string;
  status: string;
  worker: string | null;
  spent_usd: string;
  metadata: Record<string, unknown>;
  thread: ThreadEntry[];
  parent_run_id: string | null;
  started_at: string | null;
  updated_at: string;
  last_heartbeat_at: string | null;
}

async function fetchActiveRows(): Promise<AgentRowRaw[]> {
  const r = await pool.query<AgentRowRaw>(
    `SELECT id::text, title, status, worker, spent_usd::text,
            metadata, thread, parent_run_id::text AS parent_run_id,
            started_at::text, updated_at::text, last_heartbeat_at::text
       FROM runs
      WHERE status IN ('running','queued','paused','stuck')
         OR (status IN ('completed','failed','cancelled')
             AND updated_at > now() - ($1 || ' milliseconds')::interval)
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          WHEN 'paused'  THEN 1
          WHEN 'stuck'   THEN 2
          WHEN 'queued'  THEN 3
          ELSE 4
        END,
        started_at DESC NULLS LAST,
        updated_at DESC
      LIMIT 60`,
    [String(RECENT_COMPLETION_WINDOW_MS)],
  );
  return r.rows;
}

interface RollupRow {
  running: string;
  queued: string;
  stuck: string;
  paused: string;
}

async function fetchStatusRollup(): Promise<RollupRow> {
  const r = await pool.query<RollupRow>(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'running')::text AS running,
        COUNT(*) FILTER (WHERE status = 'queued')::text  AS queued,
        COUNT(*) FILTER (WHERE status = 'stuck')::text   AS stuck,
        COUNT(*) FILTER (WHERE status = 'paused')::text  AS paused
       FROM runs
      WHERE archived = false`,
  );
  return r.rows[0] ?? { running: "0", queued: "0", stuck: "0", paused: "0" };
}

interface HourlyRow {
  spent_usd: string;
  input_tokens: string;
  output_tokens: string;
}

async function fetchHourlyTotals(): Promise<HourlyRow> {
  // Cost is authoritative from runs.spent_usd deltas over the window; tokens
  // are best-effort from metadata.usage_last_turn (populated after every
  // turn completes). If a run is mid-turn its live counter is on
  // metadata.usage_running — we ignore that here, it'd double-count once
  // the turn finishes and its total lands in usage_last_turn.
  const r = await pool.query<HourlyRow>(
    `SELECT
        COALESCE(SUM(spent_usd), 0)::text AS spent_usd,
        COALESCE(SUM(
          COALESCE((metadata->'usage_last_turn'->>'input_tokens')::bigint, 0)
        ), 0)::text AS input_tokens,
        COALESCE(SUM(
          COALESCE((metadata->'usage_last_turn'->>'output_tokens')::bigint, 0)
        ), 0)::text AS output_tokens
       FROM runs
      WHERE updated_at > now() - interval '1 hour'`,
  );
  return r.rows[0] ?? { spent_usd: "0", input_tokens: "0", output_tokens: "0" };
}

function agentFromRow(row: AgentRowRaw, nowMs: number): AgentRun {
  const meta = row.metadata ?? {};
  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
  const usageRunningRaw = (meta as Record<string, unknown>).usage_running;
  return {
    kind: "run",
    id: row.id,
    title: row.title,
    status: row.status,
    worker: row.worker,
    model: typeof meta.model === "string" ? (meta.model as string) : null,
    effort: typeof meta.effort === "string" ? (meta.effort as string) : null,
    engine: typeof meta.engine === "string" ? (meta.engine as string) : "claude-code",
    cwd: typeof meta.workspace_dir === "string" ? (meta.workspace_dir as string) : null,
    started_at: row.started_at,
    updated_at: row.updated_at,
    last_heartbeat_at: row.last_heartbeat_at,
    elapsed_ms: elapsed,
    spent_usd: numOr0(row.spent_usd),
    usage_total: pickTotal((meta as Record<string, unknown>).usage_total),
    usage_last_turn: pickUsage((meta as Record<string, unknown>).usage_last_turn),
    usage_running: usageRunningRaw ? pickUsage(usageRunningRaw) : null,
    usage_by_model: pickModelBreakdown(
      (meta as Record<string, unknown>).usage_last_model_breakdown,
    ),
    current_activity: pickCurrentActivity(
      (meta as Record<string, unknown>).current_activity,
    ),
    parent_run_id: row.parent_run_id,
    subagents: foldSubagents(row.thread ?? []),
  };
}

/** GET /api/agents — one payload the Live panel polls every 1-2s. */
r.get("/", async (c) => {
  const [rows, rollup, hourly] = await Promise.all([
    fetchActiveRows(),
    fetchStatusRollup(),
    fetchHourlyTotals(),
  ]);
  const nowMs = Date.now();
  const agents = rows.map((row) => agentFromRow(row, nowMs));
  const activeSubagents = agents.reduce(
    (n, a) => n + a.subagents.filter((s) => s.status === "running").length,
    0,
  );
  const body: AgentsResponse = {
    now: new Date(nowMs).toISOString(),
    summary: {
      running: Number(rollup.running),
      queued: Number(rollup.queued),
      stuck: Number(rollup.stuck),
      paused: Number(rollup.paused),
      active_subagents: activeSubagents,
      spent_usd_last_hour: numOr0(hourly.spent_usd),
      tokens_in_last_hour: numOr0(hourly.input_tokens),
      tokens_out_last_hour: numOr0(hourly.output_tokens),
    },
    agents,
  };
  return c.json(body);
});

/** GET /api/agents/:id — full detail for a single run, same shape as the
 *  entries in the list endpoint. Handy for a drill-down pane. */
r.get("/:id", async (c) => {
  const id = c.req.param("id");
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const r0 = await pool.query<AgentRowRaw>(
    `SELECT id::text, title, status, worker, spent_usd::text,
            metadata, thread, parent_run_id::text AS parent_run_id,
            started_at::text, updated_at::text, last_heartbeat_at::text
       FROM runs
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  const row = r0.rows[0];
  if (!row) return c.json({ error: "run not found" }, 404);
  return c.json({ agent: agentFromRow(row, Date.now()) });
});

export default r;
