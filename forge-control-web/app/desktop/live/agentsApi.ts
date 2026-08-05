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
  /** When the rollup saw the spawn's tool_result — the real settle time.
   *  `updated_at` is NOT a substitute: late events arriving under a stale
   *  parent_tool_use_id keep pushing it forward after the sub-agent is done.
   *  Null on rows predating rollup v2 and on the thread-fallback path. */
  ended_at: string | null;
  /** Human one-liner from the spawn's input ("Recon chat Bash block
   *  rendering"). Null where the rollup never captured one. */
  description: string | null;
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
  /** Server-derived wall clock. For a LIVE run, `now − started_at` at the
   *  moment of the response. For a SETTLED run, FROZEN at
   *  `settled_at − started_at` — the client must use it verbatim and never
   *  recompute. `null` when the server could not derive one (queued, or
   *  unusable timestamps) — the client tolerates it and renders "—". */
  elapsed_ms: number | null;
  /** status ∈ {completed, failed, cancelled}: the run's duration is history,
   *  not a stopwatch. */
  settled: boolean;
  /** When the run settled (`completed_at ?? updated_at`). Null while live. */
  settled_at: string | null;
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

/* ── Duration truth ───────────────────────────────────────────────────────
 *
 * These three functions are the ONLY place in the Live panel where a
 * duration is derived (R6). They live here, next to the wire types, rather
 * than in AgentActivity.tsx for two reasons: this module has no React and no
 * imports, so `scripts/checks/check-duration.ts` can import it directly under
 * tsx with no bundler; and co-locating them with the interfaces keeps the
 * settled-vs-live contract readable as one thing.
 *
 * The invariant they exist to enforce: a finished row NEVER derives its
 * number from `now`. If the honest value is unavailable we return null, which
 * `humanDuration` renders as "—". A visible gap beats a growing lie.
 */

/** Parse the two timestamp shapes the API hands out: Postgres
 *  "2026-07-30 16:21:19.674825+00" and ISO 8601
 *  "2026-08-05T06:47:23.678Z". Returns NaN for anything unusable. */
export function parseTs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return new Date(ts.replace(" ", "T").replace(/\+00$/, "Z")).getTime();
}

/** Wall-clock for a top-level run row.
 *
 *  1. queued            → null. `started_at` is non-null on every row in the
 *     DB today, so status is the only honest signal that work has not begun.
 *  2. settled           → `elapsed_ms` verbatim. The server froze it against
 *     `settled_at`; recomputing here would re-introduce the bug. May itself
 *     be null (unusable server-side timestamps) → "—".
 *  3. live with a parsable start → `now − started_at`.
 *  4. otherwise         → null. */
export function runElapsedMs(a: AgentRow, now: number): number | null {
  if (a.status === "queued") return null;
  if (a.settled) return a.elapsed_ms;
  const started = parseTs(a.started_at);
  if (Number.isFinite(started)) return Math.max(0, now - started);
  return null;
}

/** Wall-clock for a nested sub-agent line.
 *
 *  Running ticks against `now`. A DONE sub-agent measures against the LATER
 *  of `ended_at` and `updated_at`, and never against `now` — that `now`
 *  fallback is what made finished sub-agents grow forever.
 *
 *  Why the later of the two, rather than `ended_at` first:
 *  `run-rollup.ts:226-229` stamps `ended_at` when the spawn's `tool_result`
 *  arrives. For an ASYNC agent spawn that result is the launch
 *  acknowledgement, which lands ~10–40 ms after the call — verified in run
 *  3853c154's thread: spawn `toolu_014raMUrJc` called 06:47:12.533,
 *  tool_result 06:47:12.565, and the sub-agent kept emitting events under
 *  that parent until 06:53:09.636. Trusting `ended_at` first renders every
 *  real sub-agent as "0s". `updated_at` — the last event seen under the
 *  sub-agent — is the honest end of its work, and it freezes as soon as the
 *  sub-agent stops emitting.
 *
 *  When `ended_at` IS a true completion stamp (a synchronous spawn, where
 *  the result arrives after the work), `updated_at` precedes it and the max
 *  picks `ended_at` — the originally specified behaviour, preserved.
 *
 *  The underlying defect is engine-side (a background sub-agent is marked
 *  `done` at launch): see docs/plan/artifacts/phase1/ended-at-is-a-launch-ack.md.
 *  This function cannot fix that; it declines to repeat it. */
export function subagentElapsedMs(s: SubagentRow, now: number): number | null {
  const started = parseTs(s.started_at);
  if (!Number.isFinite(started)) return null;
  if (s.status === "running") return Math.max(0, now - started);
  const ended = parseTs(s.ended_at);
  const updated = parseTs(s.updated_at);
  const settledAt = Math.max(
    Number.isFinite(ended) ? ended : -Infinity,
    Number.isFinite(updated) ? updated : -Infinity,
  );
  if (!Number.isFinite(settledAt)) return null;
  return Math.max(0, settledAt - started);
}

export interface Manager {
  project_id: string;
  name: string;
  status: string;
  mode: string | null;
  tasks_done: number;
  tasks_total: number;
  tokens_in: number;
  tokens_out: number;
  spent_usd: number;
  last_activity_at: string | null;
}

export interface ManagersResponse {
  managers: Manager[];
}

export const fetchManagers = async (): Promise<ManagersResponse> => {
  const r = await fetch(`${ROOT}/projects/managers`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /projects/managers`);
  return (await r.json()) as ManagersResponse;
};

export const fetchAgents = async (projectId?: string): Promise<AgentsResponse> => {
  const url = projectId
    ? `${ROOT}/agents?project_id=${encodeURIComponent(projectId)}`
    : `${ROOT}/agents`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /agents`);
  return (await r.json()) as AgentsResponse;
};
