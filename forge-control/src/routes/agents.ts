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
  dismissalKind,
  isRunId,
  resolveCascade,
  type DismissalCandidate,
} from "../lib/dismissals.ts";
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
 *
 * The `ui_dismissals` LEFT JOIN (round 1350) adds `dismissed_at` and NOTHING
 * else: no WHERE clause reads it, so a hidden row is still returned and still
 * counted. Hiding is the panel's decision, and the panel needs the hidden rows
 * to offer "N hidden · show". `node_id` is that table's primary key, so the
 * join can never multiply a row.
 */
async function fetchActiveRows(projectId?: string): Promise<AgentRowRaw[]> {
  const params: string[] = [String(RECENT_COMPLETION_WINDOW_MS)];
  let projectFilter = "";
  if (projectId) {
    params.push(projectId);
    projectFilter = `AND runs.metadata->>'project_id' = $${params.length}
      AND runs.metadata->>'role' IS DISTINCT FROM 'manager'`;
  }
  const r = await pool.query<AgentRowRaw>(
    `SELECT runs.id::text, runs.title, runs.status, runs.worker,
            runs.spent_usd::text,
            runs.metadata,
            CASE
              WHEN runs.metadata ? 'rollup_v1' THEN NULL::jsonb
              WHEN runs.status IN ('running','queued','paused','stuck') THEN runs.thread
              ELSE NULL::jsonb
            END AS thread,
            runs.parent_run_id::text AS parent_run_id,
            runs.started_at::text, runs.updated_at::text, runs.completed_at::text,
            runs.last_heartbeat_at::text,
            d.dismissed_at::text AS dismissed_at
       FROM runs
       LEFT JOIN ui_dismissals d ON d.node_id = runs.id::text
      WHERE (
              runs.status IN ('running','queued','paused','stuck')
              OR (runs.status IN ('completed','failed','cancelled')
                  AND runs.updated_at > now() - ($1 || ' milliseconds')::interval)
            )
            ${projectFilter}
      ORDER BY
        CASE runs.status
          WHEN 'running' THEN 0
          WHEN 'paused'  THEN 1
          WHEN 'stuck'   THEN 2
          WHEN 'queued'  THEN 3
          ELSE 4
        END,
        runs.started_at DESC NULLS LAST,
        runs.updated_at DESC
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

/* ═══════════════════════════════════════════════════════════════════════════
 * Dismissals — /api/agents/dismissals (round 1350, phase 6)
 *
 * REGISTERED BEFORE `/:id` ON PURPOSE. Hono matches in registration order, so
 * a `GET /:id` declared first would swallow `GET /dismissals` and answer it
 * with "invalid run id". Anything added below this block is fine; anything
 * added above `/:id` must keep this ordering.
 *
 * The rule these endpoints apply lives in `lib/dismissals.ts` as a pure
 * function; the SQL lives HERE, route-local, because this cycle's constraints
 * put the shared engine files (project-tick, cc-runner, executor, db/projects)
 * off limits and a UI preference is no reason to widen them.
 *
 * Dismissal is a HIDE. Nothing in this block writes to `runs`, and every
 * insert is reversible by the two DELETE routes.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** A load-bearing step failed: 500 naming the step and the database's own
 *  message, in the shape `chat.ts`'s `teamFailure` established. Never a 200
 *  with an empty set — "nothing is hidden" and "we could not find out what is
 *  hidden" must not look the same to the panel. */
function dismissalFailure(
  step: string,
  e: unknown,
): { error: string; step: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[agents dismissals] ${step} failed:`, message);
  return { error: `dismissals: ${step} failed`, step, message };
}

/** Node ids are run uuids OR sub-agent `tool_use_id`s, so the only validation
 *  possible is "a non-empty, plausibly-sized string". 200 chars is far beyond
 *  any id either system mints and keeps a hostile body out of the table. */
function badNodeId(id: unknown): string | null {
  if (typeof id !== "string") return "id must be a string";
  if (id.trim() === "") return "id must not be empty";
  if (id.length > 200) return "id must be at most 200 characters";
  return null;
}

/**
 * Candidate rows for a cascade, in one query.
 *
 * Three sources unioned, because a cascade reaches in two directions and the
 * pure resolver needs every row it might select:
 *   • the target itself,
 *   • its transitive `parent_run_id` descendants (recursive CTE — running
 *     nodes are traversed here and rejected there, so the SQL stays a plain
 *     reachability walk and the RULE stays in one place),
 *   • every run of a project whose `metadata.origin_chat_id` is the target,
 *     plus those runs' descendants.
 *
 * `origin_chat_id` comes from `projects.metadata`, joined per row, which is
 * how `resolveCascade` recognises a manager without a second lookup. The join
 * is `LEFT` so a run whose project row was deleted still appears (as a plain
 * descendant) instead of vanishing from its own cascade.
 */
/* `$1` is TEXT in both branches, cast to uuid only where a uuid column is
 * compared. Postgres infers ONE type per parameter across the whole statement:
 * writing `id = $1::uuid` in the first branch made $1 a uuid, and the second
 * branch's `metadata->>'origin_chat_id' = $1` then failed at plan time with
 * "operator does not exist: text = uuid". The explicit `$1::text` pins it. */
const CASCADE_SQL = `
WITH RECURSIVE seed AS (
  SELECT id FROM runs WHERE id = ($1::text)::uuid
  UNION
  SELECT r.id
    FROM runs r
    JOIN projects p ON p.id::text = r.metadata->>'project_id'
   WHERE p.metadata->>'origin_chat_id' = $1::text
),
tree AS (
  SELECT s.id FROM seed s
  UNION
  SELECT c.id FROM runs c JOIN tree t ON c.parent_run_id = t.id
)
SELECT r.id::text                        AS id,
       r.parent_run_id::text             AS parent_run_id,
       r.status,
       r.metadata->>'project_id'         AS project_id,
       p.metadata->>'origin_chat_id'     AS origin_chat_id
  FROM tree t
  JOIN runs r ON r.id = t.id
  LEFT JOIN projects p ON p.id::text = r.metadata->>'project_id'`;

/** GET /api/agents/dismissals — everything currently hidden, newest first.
 *  The panel calls this once on mount; `/api/agents` then only has to carry
 *  the per-row flag. Sub-agent node ids appear here too — they are hidden the
 *  same way, and they have no `runs` row to carry a flag on. */
r.get("/dismissals", async (c) => {
  try {
    const res = await pool.query<{ node_id: string }>(
      `SELECT node_id FROM ui_dismissals ORDER BY dismissed_at DESC, node_id`,
    );
    const nodeIds = res.rows.map((row) => row.node_id);
    return c.json({ node_ids: nodeIds, count: nodeIds.length });
  } catch (e) {
    return c.json(dismissalFailure("list", e), 500);
  }
});

/**
 * POST /api/agents/dismissals  {id, cascade?} → {dismissed: string[]}
 *
 * Idempotent by SQL (`ON CONFLICT DO NOTHING`), not by convention: the second
 * call returns the same set with the same 200. `dismissed` is what is hidden
 * as a RESULT of the call, including ids that were already hidden — the panel
 * uses it to update its set, and "already hidden" is not an error.
 *
 * One honest wrinkle, stated rather than hidden: the cascade is computed from
 * live status, so if a child settles between two calls the second call hides
 * more than the first did. That is the correct answer to "hide this and its
 * finished work", not drift.
 */
r.post("/dismissals", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json(
      { error: "invalid JSON body", message: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const reason = badNodeId(raw.id);
  if (reason) return c.json({ error: reason }, 400);
  const id = (raw.id as string).trim();
  if (raw.cascade !== undefined && typeof raw.cascade !== "boolean") {
    return c.json({ error: "cascade must be a boolean" }, 400);
  }
  const cascade = raw.cascade !== false;

  let ids: string[] = [id];
  if (cascade) {
    // A non-uuid node id is a sub-agent: `runs.id` is uuid, so asking the
    // cascade query about it is a cast error, not an empty result. It has no
    // descendants by construction — it lives inside one run's thread.
    if (isRunId(id)) {
      try {
        const res = await pool.query<DismissalCandidate>(CASCADE_SQL, [id]);
        ids = resolveCascade(id, res.rows);
      } catch (e) {
        return c.json(dismissalFailure("cascade query", e), 500);
      }
    }
  }

  try {
    await pool.query(
      `INSERT INTO ui_dismissals (node_id, kind)
       SELECT n, k FROM unnest($1::text[], $2::text[]) AS t(n, k)
       ON CONFLICT (node_id) DO NOTHING`,
      [ids, ids.map(dismissalKind)],
    );
  } catch (e) {
    return c.json(dismissalFailure("insert", e), 500);
  }
  return c.json({ dismissed: ids });
});

/** DELETE /api/agents/dismissals — restore everything. The escape hatch behind
 *  the panel's "show all", and the only un-cascade there is. */
r.delete("/dismissals", async (c) => {
  try {
    const res = await pool.query(`DELETE FROM ui_dismissals`);
    return c.json({ restored: res.rowCount ?? 0 });
  } catch (e) {
    return c.json(dismissalFailure("restore all", e), 500);
  }
});

/**
 * DELETE /api/agents/dismissals/:id → {restored: string[]}
 *
 * Restores exactly the id given — never the set that a POST cascaded, because
 * the cascade is not recorded and re-deriving it would restore whatever is
 * settled NOW, which is a different set. Restoring one row at a time plus
 * "restore all" covers both real gestures; guessing at a third is how a hide
 * turns into a surprise.
 *
 * `restored` is `[]` when the id was not hidden — a 200, not a 404: the caller
 * asked for a state ("this is not hidden") and that state now holds.
 */
r.delete("/dismissals/:id", async (c) => {
  const id = c.req.param("id");
  const reason = badNodeId(id);
  if (reason) return c.json({ error: reason }, 400);
  try {
    const res = await pool.query<{ node_id: string }>(
      `DELETE FROM ui_dismissals WHERE node_id = $1 RETURNING node_id`,
      [id],
    );
    return c.json({ restored: res.rows.map((row) => row.node_id) });
  } catch (e) {
    return c.json(dismissalFailure("restore", e), 500);
  }
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
    `SELECT runs.id::text, runs.title, runs.status, runs.worker,
            runs.spent_usd::text,
            runs.metadata, runs.thread,
            runs.parent_run_id::text AS parent_run_id,
            runs.started_at::text, runs.updated_at::text, runs.completed_at::text,
            runs.last_heartbeat_at::text,
            d.dismissed_at::text AS dismissed_at
       FROM runs
       LEFT JOIN ui_dismissals d ON d.node_id = runs.id::text
      WHERE runs.id = $1
      LIMIT 1`,
    [id],
  );
  const row = r0.rows[0];
  if (!row) return c.json({ error: "run not found" }, 404);
  return c.json({ agent: agentFromRow(row, Date.now()) });
});

export default r;
