/** Client for GET /api/chat/:id/team and GET /api/capabilities — the data
 *  layer of the v3 right panel (13-ui-v3-architecture.md §1).
 *
 *  Its own module rather than an addition to app/api.ts or to ./live/agentsApi
 *  for the same reason agentsApi exists separately: the Team panel is a new
 *  surface with its own wire contract, and /live must keep evolving without
 *  either one dragging the other. Nothing here imports React, so
 *  `scripts/checks/check-team-rows.ts` can import it directly under tsx.
 *
 *  Source of truth for every type below: forge-control/src/routes/chat.ts
 *  (interfaces TeamTask / TeamTokens / TeamNode / TeamError / TeamResponse,
 *  lines ~288-380) and forge-control/src/routes/capabilities.ts. These are
 *  hand-mirrored, not imported — this module must not reach across repos. When
 *  the server shape changes, this file changes with it.
 *
 *  NOT re-exported here, import them from ./live/agentsApi directly:
 *  `roleLabel`, `modelDisplay`, `isModelAlias`, `ROLE_TOKEN`, `roleTokenName`,
 *  `parseTs`. They are already the shared vocabulary; a second copy would be a
 *  second truth.
 */

import type { AgentKind } from "../live/agentsApi";

const ROOT = "/api/proxy";

/** The KIND TRUTH of one row: the four run kinds `/api/agents` already
 *  classifies, plus the one value the team tree adds — an in-process Task
 *  sub-agent, which is not a run and has no row in `runs`. Mirrors
 *  `AgentRun["agent_kind"] | "subagent"` in routes/chat.ts:330. */
export type TeamNodeKind = AgentKind | "subagent";

/** How `working_ms` was measured. `"thread"` is the precise path (summed gaps
 *  between the node's own thread entries); `"rollup"` is the sub-agent
 *  fallback — a wall-clock span from `subagents_v2` — and the panel is
 *  expected to render it visibly less precise (13 §4, §9). `null` alongside a
 *  null `working_ms` means: not measured at all. */
export type WorkingMsSource = "thread" | "rollup";

/** The project task a worker run was spawned for.
 *
 *  No `id` since round 1302: the server stopped shipping one because nothing
 *  in this repo read it (`grep -rn "task\.id" app/` → no hits). Rows are keyed
 *  and navigated by RUN id; the task block is here to say which round and role
 *  of the plan a run is executing. Every field below has a reader —
 *  `title` in ../chat/OrientationStrip.tsx and (via `description`) in
 *  ./TeamRow.tsx, `round`/`role`/`status` in both. */
export interface TeamTask {
  round: number;
  role: string;
  title: string;
  status: string;
}

/** U4's token block. `total` is the sum of the other four — the server does
 *  that math, the client never re-derives it. No cost, no dollars (U11). */
export interface TeamTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

/** One row of the org chart. */
export interface TeamNode {
  /** Run uuid for a session; the spawn's `tool_use_id` for a sub-agent. */
  id: string;
  kind: TeamNodeKind;
  role: string | null;
  model: string | null;
  status: string;
  tokens: TeamTokens;
  /** Milliseconds of attributed work, or `null` when it is NOT MEASURABLE —
   *  the working-time query failed, or a sub-agent has no independent end
   *  stamp. Never 0-as-unknown: 0 means measured, and it was zero. A client
   *  that renders `null` as "0s" re-introduces exactly the lie this whole
   *  project exists to remove (NFU6). */
  working_ms: number | null;
  working_ms_source: WorkingMsSource | null;
  started_at: string | null;
  /** True when nothing about this node can change any more. Settled rows never
   *  tick, ever (U16). */
  settled: boolean;
  /** The human one-liner: a worker's task title, a sub-agent's spawn
   *  description, otherwise the run title. */
  description: string | null;
  /** Lineage: the run this node hangs under. Null for the manager. */
  parent_id: string | null;
  /** Present on run nodes; always empty on sub-agents (they do not nest). */
  subagents: TeamNode[];
  task: TeamTask | null;
}

/** A named failure of one enrichment step. The tree still renders; the panel
 *  shows this text instead of pretending the missing numbers are zero. */
export interface TeamError {
  /** Which step failed: "working_time" | "tasks". */
  scope: string;
  message: string;
}

export interface TeamResponse {
  chat_id: string;
  /** Server clock at response time, ISO 8601. The anchor every client-side
   *  interpolation measures from — see `interpolatedWorkingMs` in ./teamRows. */
  now: string;
  project: { id: string; status: string | null } | null;
  /** `"thread_scan"` means the chat↔project link was inferred, not recorded;
   *  the panel marks it "linked heuristically" (U2/NFU6). */
  link_source: "metadata" | "thread_scan" | null;
  link_ambiguous: boolean;
  manager: TeamNode;
  workers: TeamNode[];
  /** False when any enrichment failed. A panel that shows numbers must check
   *  this before claiming the tree is the whole truth (NFU6). */
  complete: boolean;
  errors: TeamError[];
}

/** Control-plane feature detection (U8). Every flag is `false` today; the
 *  engine-v2-research-lane flips them as endpoints ship. The panel renders
 *  unavailable controls DISABLED WITH A REASON — never hidden, never a silent
 *  no-op. Mirrors forge-control/src/routes/capabilities.ts. */
export interface CapabilitiesResponse {
  control_plane: {
    message_into_session: boolean;
    resume_finished: boolean;
    stop: boolean;
    terminate: boolean;
  };
}

/* ── Fetchers ─────────────────────────────────────────────────────────────
 *
 * Same idiom as `fetchAgents` in ./live/agentsApi: bare fetch, explicit
 * accept header, THROW on non-2xx with the status in the message. There is no
 * `catch` that turns a 500 into an empty tree — an empty tree and a broken
 * server must never look the same in the panel (NFU6). react-query surfaces
 * the thrown error; the panel renders it inline.
 */

export const fetchChatTeam = async (chatId: string): Promise<TeamResponse> => {
  const r = await fetch(`${ROOT}/chat/${encodeURIComponent(chatId)}/team`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /chat/:id/team`);
  return (await r.json()) as TeamResponse;
};

export const fetchCapabilities = async (): Promise<CapabilitiesResponse> => {
  const r = await fetch(`${ROOT}/capabilities`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /capabilities`);
  return (await r.json()) as CapabilitiesResponse;
};

/* ── Formatters ───────────────────────────────────────────────────────────
 *
 * Ported from `humanDuration` / `humanTokens` in ./live/AgentActivity.tsx
 * (lines 78-98). They are DUPLICATED on purpose: AgentActivity.tsx is the
 * /live surface, which this phase does not touch (13 §1 — "/live survives
 * unchanged"), and those two functions are module-private there. Exporting
 * them would mean editing a file this round is forbidden to edit; importing a
 * React module would put JSX in the path of the tsx check script. Twelve lines
 * of pure formatting is the cheaper duplicate. If /live is ever refactored,
 * the two should collapse into this file — it is the React-free one.
 *
 * One deliberate difference: `fmtWorkingTime` takes the null-means-unknown
 * contract seriously and is the only renderer of it in the panel.
 */

/** Rendered wherever there is no honest value — the same glyph the Live panel
 *  and agentsApi use. */
const EM_DASH = "—";

/** 1h 04m / 12m 30s / 45s — Claude Code's own format, no clock glyph.
 *  Length-bounded so the time column never wobbles as it counts.
 *
 *  `null` → "—", NEVER "0s". Null means the server could not measure this
 *  node's work; "0s" would claim it measured zero. */
export function fmtWorkingTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 204.7k / 1.2M / 987 — same rounding rules as the Claude Code bar. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k < 10 ? k.toFixed(1) : k.toFixed(k < 100 ? 1 : 0)}k`;
  }
  const M = n / 1_000_000;
  return `${M < 10 ? M.toFixed(2) : M.toFixed(1)}M`;
}
