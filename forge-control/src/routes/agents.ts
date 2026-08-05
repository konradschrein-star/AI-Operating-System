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
 *
 * This file owns the pool, the SQL and the two handlers. The row→wire
 * shaping — the types, `agentFromRow` and everything it calls — lives in
 * `agents-shared.ts` so phase 300's chat/team routes can produce identical
 * rows from their own queries instead of a second, drifting implementation.
 */

import { Hono } from "hono";
import pg from "pg";
import {
  agentFromRow,
  numOr0,
  type AgentRowRaw,
  type AgentRun,
} from "./agents-shared.ts";

/** Re-exported, not relocated: `scripts/checks/check-classify.ts` imports the
 *  classifier from THIS module and the extraction must not break an existing
 *  importer. `agents.ts` remains the public name for the classification the
 *  wire actually uses. */
export { classifyAgentKind } from "./agents-shared.ts";
export type { AgentKind } from "./agents-shared.ts";

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
// stuck) plus anything that finished recently. 24h, not seconds: this panel
// is Konrad's overview of what ran tonight, not only what runs this instant.
// Completed rows never pull the thread fallback and LIMIT 60 bounds payload.
const RECENT_COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch the rows the Live panel needs.
 *
 * Cost story: this query used to `SELECT ... thread ...` unconditionally for
 * up to 60 rows every 4 s, folding subagents out of the JSONB in JS. On a
 * long conversation `runs.thread` can reach several MB (this session's parent
 * run already has 682 entries), so that was megabytes of network + parse per
 * poll and — per the UI audit §7 fix #1 — the strongest single candidate for
 * the "the UI bogs down the whole machine" symptom.
 *
 * The rewrite: the executor now maintains a compact `metadata.rollup_v1`
 * snapshot at write time (subagents, current activity, running usage), so
 * we can select just `metadata`. Thread is only pulled as a FALLBACK, for
 * live rows that don't yet carry the rollup — the current running run when
 * this deploy first lands, and anything a restart-mid-run temporarily
 * dropped from the in-memory rollup map. Completed rows never fall back:
 * their subagents finished by definition, so an empty subagent list is the
 * correct answer.
 *
 * When `projectId` is provided the result is scoped to runs belonging to that
 * project (metadata.project_id = projectId). Child runs carry the same
 * project_id, so workers + their System-B sub-agents are both included and
 * the caller can nest them via parent_run_id as usual. Manager-role runs
 * (metadata.role = 'manager') are excluded from the worker feed — there are
 * none today but the guard is defensive.
 */
async function fetchActiveRows(projectId?: string): Promise<AgentRowRaw[]> {
  const params: string[] = [String(RECENT_COMPLETION_WINDOW_MS)];
  let projectFilter = "";
  if (projectId) {
    params.push(projectId);
    projectFilter = `AND metadata->>'project_id' = $${params.length}
      AND metadata->>'role' IS DISTINCT FROM 'manager'`;
  }
  const r = await pool.query<AgentRowRaw>(
    `SELECT id::text, title, status, worker, spent_usd::text,
            metadata,
            CASE
              WHEN metadata ? 'rollup_v1' THEN NULL::jsonb
              WHEN status IN ('running','queued','paused','stuck') THEN thread
              ELSE NULL::jsonb
            END AS thread,
            parent_run_id::text AS parent_run_id,
            started_at::text, updated_at::text, completed_at::text,
            last_heartbeat_at::text
       FROM runs
      WHERE (
              status IN ('running','queued','paused','stuck')
              OR (status IN ('completed','failed','cancelled')
                  AND updated_at > now() - ($1 || ' milliseconds')::interval)
            )
            ${projectFilter}
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
    params,
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

/** GET /api/agents — one payload the Live panel polls every 1-2s.
 *
 * Optional ?project_id=<uuid> scopes the response to a single project's
 * worker runs + their sub-agents. The summary block is also scoped to the
 * filtered set in that case (derived from the rows, not a second DB query).
 * Without the param the behaviour is identical to before. */
r.get("/", async (c) => {
  const projectId = c.req.query("project_id") || undefined;
  const nowMs = Date.now();

  if (projectId) {
    const rows = await fetchActiveRows(projectId);
    const agents = rows.map((row) => agentFromRow(row, nowMs));
    const activeSubagents = agents.reduce(
      (n, a) => n + a.subagents.filter((s) => s.status === "running").length,
      0,
    );
    const body: AgentsResponse = {
      now: new Date(nowMs).toISOString(),
      summary: {
        running: agents.filter((a) => a.status === "running").length,
        queued: agents.filter((a) => a.status === "queued").length,
        stuck: agents.filter((a) => a.status === "stuck").length,
        paused: agents.filter((a) => a.status === "paused").length,
        active_subagents: activeSubagents,
        spent_usd_last_hour: agents.reduce((s, a) => s + a.spent_usd, 0),
        tokens_in_last_hour: agents.reduce((s, a) => s + a.usage_total.input_tokens, 0),
        tokens_out_last_hour: agents.reduce((s, a) => s + a.usage_total.output_tokens, 0),
      },
      agents,
    };
    return c.json(body);
  }

  const [rows, rollup, hourly] = await Promise.all([
    fetchActiveRows(),
    fetchStatusRollup(),
    fetchHourlyTotals(),
  ]);
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
  // Drill-down: always include `thread` here — the caller wants full
  // detail and this is a single row, not the list path where thread pulls
  // become expensive. Rollup is still preferred by agentFromRow when
  // present; thread is the fallback.
  const r0 = await pool.query<AgentRowRaw>(
    `SELECT id::text, title, status, worker, spent_usd::text,
            metadata, thread, parent_run_id::text AS parent_run_id,
            started_at::text, updated_at::text, completed_at::text,
            last_heartbeat_at::text
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
