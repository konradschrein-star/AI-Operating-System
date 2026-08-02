/** Client for /api/agents — live agent activity. Deliberately its own module
 *  rather than an addition to app/api.ts, so the Live panel can evolve without
 *  touching the shared client. */

const ROOT = "/api/proxy";

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  turns?: number;
  cost_usd?: number;
  thinking_tokens?: number;
}

export interface CurrentActivity {
  kind: string;
  tool: string | null;
  text: string | null;
  parent_tool_use_id: string | null;
  model: string | null;
  ts: string;
}

/** System-A Claude-Code Task subagent — a role living inside ONE parent run's
 *  process. The wire shape is deliberately different from AgentRow because
 *  the backend has less to hand out for them (no run UUID, no spend row, no
 *  heartbeat) — it's folded from thread events, not a database row. */
export interface SubagentRow {
  kind: "subagent";
  /** Parent Task tool_use_id — stable within the run's turn, used as React key. */
  tool_use_id: string;
  role: string;
  model: string | null;
  started_at: string;
  updated_at: string;
  usage: AgentUsage;
  event_count: number;
  latest_activity: {
    kind: string;
    tool: string | null;
    text: string | null;
    ts: string;
  } | null;
  status: "running" | "done";
}

export interface AgentRow {
  /** System-B forge-control task — its own `claude` process, survives session
   *  cycles. Top-level rows in the Live panel; System-A subagents nest under. */
  kind: "run";
  id: string;
  title: string;
  status: string;
  worker: string | null;
  model: string | null;
  effort: string | null;
  engine: string | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  /** Server-derived wall clock. `null` when the run has not started yet
   *  (queued) — the client tolerates it and renders "—". */
  elapsed_ms: number | null;
  spent_usd: number;
  usage_total: AgentUsage;
  usage_running?: AgentUsage;
  current_activity: CurrentActivity | null;
  parent_run_id: string | null;
  subagents?: SubagentRow[];
}

export interface AgentsResponse {
  now: string;
  summary: {
    running: number;
    queued: number;
    stuck: number;
    paused: number;
    active_subagents: number;
    spent_usd_last_hour: number;
    tokens_in_last_hour: number;
    tokens_out_last_hour: number;
  };
  agents: AgentRow[];
}

export const fetchAgents = async (): Promise<AgentsResponse> => {
  const r = await fetch(`${ROOT}/agents`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /agents`);
  return (await r.json()) as AgentsResponse;
};
