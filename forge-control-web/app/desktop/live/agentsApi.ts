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

export interface AgentRow {
  /** "run" = a forge-control task (its own `claude` process, survives session
   *  cycles). "subagent" = a Task-tool agent living INSIDE one run. */
  kind: "run" | "subagent";
  id: string;
  title: string;
  status: string;
  worker: string | null;
  model: string | null;
  effort: string | null;
  engine: string | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  elapsed_ms: number;
  spent_usd: number;
  usage_total: AgentUsage;
  usage_running?: AgentUsage;
  current_activity: CurrentActivity | null;
  parent_run_id: string | null;
  subagents?: AgentRow[];
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
