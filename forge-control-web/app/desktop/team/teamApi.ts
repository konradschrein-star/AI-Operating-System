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
  /** False when the zeros in `tokens` are IGNORANCE rather than measurement
   *  (round 1871). A spawn-only sub-agent — one whose individual steps were
   *  never stamped with its `parent_tool_use_id` — has no token record at all,
   *  and printing `0` for it asserts "this agent burned nothing", which is
   *  false for an architect that ran for four minutes. The row prints "n/a".
   *
   *  Optional on the type, not on the wire: a client running against a
   *  pre-1871 API sees `undefined`, and `tokensMeasured()` reads that as the
   *  old behaviour rather than as "unmeasured" — the panel must not start
   *  claiming ignorance about every run because the server is older. */
  tokens_measured?: boolean;
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
  /** When this node was dismissed (round 1350, `ui_dismissals`), else null.
   *  Carried on every node INCLUDING sub-agents; the tree is never filtered by
   *  it server-side. The panel hides by the shared set from
   *  `GET /api/agents/dismissals` and uses this field only to seed the frames
   *  before that GET answers — see `seededDismissals` in ./dismissals. */
  dismissed_at: string | null;
  /** Present on run nodes; always empty on sub-agents (they do not nest). */
  subagents: TeamNode[];
  task: TeamTask | null;
}

/** One project that claims this chat. Mirrors `ChatProjectCandidate` in
 *  forge-control/src/routes/chat-linkage.ts. */
export interface ChatProjectCandidate {
  id: string;
  name: string | null;
  status: string;
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
  /** Every project this chat started, best first (round 1871). More than one
   *  entry means the chat is ambiguous and the panel offers the choice instead
   *  of only labelling the problem. Optional so a pre-1871 server degrades to
   *  "no switcher" rather than to a crash. */
  candidates?: ChatProjectCandidate[];
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

/** `projectId` overrides the server's ranked default (round 1871). The server
 *  validates it against this chat's own candidates and 400s anything else, so
 *  the panel cannot be pointed at an unrelated project by a stale value. */
export const fetchChatTeam = async (
  chatId: string,
  projectId?: string | null,
): Promise<TeamResponse> => {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const r = await fetch(`${ROOT}/chat/${encodeURIComponent(chatId)}/team${q}`, {
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

/* ── Control-plane POSTs ──────────────────────────────────────────────────
 *
 * `POST /api/runs/:id/stop` and `POST /api/runs/:id/terminate`, the two verbs
 * of forge-control/src/routes/run-control.ts §3/§4. Same bare-fetch idiom as
 * the two GETs above, with one addition that is the whole point of these two
 * functions: THE SERVER'S REASON IS THE MESSAGE.
 *
 * That route file answers every refusal with `{ error: "<reason>" }` — 404
 * "unknown run", 409 "run is already cancelled", 409 raceReason(...) — and its
 * own header calls those strings "a `reason` string the UI renders verbatim in
 * a toast". A client that replaced them with "409 Conflict" would throw away
 * the only sentence that tells an operator what actually happened, and a client
 * that resolved on a 4xx would report a stop that never happened (NFU6). So:
 * parse the body, prefer its words, never swallow.
 *
 * `reason` is tried before `error` because the contract note names the field
 * `reason` while the route emits `error`; both are accepted so a later rename
 * on either side cannot silently degrade the toast to a status line.
 */

/** The one place a non-2xx becomes an Error. Always throws. */
async function throwRunControlError(res: Response, path: string): Promise<never> {
  // `.text()` first, then JSON.parse: a 502 from the proxy or an HTML error
  // page is not JSON, and `res.json()` on it throws a SyntaxError whose message
  // ("Unexpected token <") tells an operator nothing about their run.
  const raw = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    body = null;
  }
  const field = (key: string): string | null => {
    if (typeof body !== "object" || body === null) return null;
    const v = (body as Record<string, unknown>)[key];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const statusLine = `${res.status} ${res.statusText}`.trim();
  throw new Error(
    field("reason") ?? field("error") ?? (statusLine || `HTTP ${res.status} on ${path}`),
  );
}

async function postRunControl<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) await throwRunControlError(res, path);
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A 202 whose body is not JSON means the proxy, not the engine, answered.
    // Reporting it as success would claim a verb was accepted on no evidence.
    throw new Error(`${res.status} on ${path} returned a non-JSON body`);
  }
}

/** Graceful stop → `paused`. 202 `{stopping:true}`; every refusal throws with
 *  the engine's own reason. */
export const postRunStop = async (runId: string): Promise<{ stopping?: boolean }> =>
  postRunControl(`/runs/${encodeURIComponent(runId)}/stop`);

/** Hard stop → `cancelled`. 202 `{terminating:true}`; refusals throw as above. */
export const postRunTerminate = async (
  runId: string,
): Promise<{ terminating?: boolean }> =>
  postRunControl(`/runs/${encodeURIComponent(runId)}/terminate`);

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

/** What an unmeasured cell prints. Three characters, so it fits the same fixed
 *  column the numbers do and the reveal still moves no pixel. */
export const NOT_RECORDED = "n/a";

/**
 * Did anybody count this node's tokens? (round 1871)
 *
 * `undefined` — a pre-1871 server — reads as YES, because that is what the
 * panel assumed before the field existed and a newer client must not start
 * printing "n/a" against every row of an older API.
 */
export function tokensMeasured(node: TeamNode): boolean {
  return node.tokens_measured !== false;
}
