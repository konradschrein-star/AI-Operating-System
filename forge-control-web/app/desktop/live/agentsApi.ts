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

/** Mirrors `AgentKind` in forge-control/src/routes/agents.ts:585. Kept as a
 *  literal union rather than imported — this module must not reach across
 *  repos, and the wire contract is exactly these four strings. */
export type AgentKind = "operator" | "worker" | "cron" | "unknown";

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
  /* ── Kind truth (R7) ────────────────────────────────────────────────
   * These four are OPTIONAL on purpose, and the difference matters.
   * `agent_kind` and friends ship in the same phase-2 server change that
   * this panel reads them from, but client and server deploy together only
   * at phase 5 — until then production :7700 answers without them. Typing
   * them as required would make `agentKindOf`'s fallback look like dead
   * code to the compiler while the running UI silently rendered
   * `undefined`. Optional here means: the panel must state "unknown", not
   * guess. */
  agent_kind?: AgentKind;
  /** Project worker role from `metadata.role` — architect/planner/scout/
   *  researcher/builder/reviewer. Null on anything that isn't a worker. */
  role?: string | null;
  project_id?: string | null;
  /** The schedule's human name ("weekly-review"); `cron_id` is what
   *  classifies the row, this is display only. */
  cron_name?: string | null;
  /** When this row was dismissed (round 1350, `ui_dismissals`), else null.
   *
   *  OPTIONAL for the same reason `agent_kind` is: the server field ships in
   *  this phase and a :7700 running main answers without it. The panel does
   *  not filter on this field — the shared dismissal set from
   *  `GET /api/agents/dismissals` is the authority, because it is the only
   *  source that also knows about sub-agent node ids and that a restore just
   *  happened. It is used ONLY as the pre-GET seed (see
   *  `seededDismissals` in ../team/dismissals), so the first painted frame
   *  does not flash rows that the server already considers hidden. */
  dismissed_at?: string | null;
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

/* ── Kind grammar ─────────────────────────────────────────────────────────
 *
 * The vocabulary the panel uses to say what a row IS. Pure, React-free and
 * token-free for the same reason the duration helpers are: `check-classify.ts`
 * imports this file directly under tsx, with no bundler and no DOM.
 *
 * Colours are therefore expressed as token NAMES (`"decide"`, `"info"`, …)
 * rather than `tokens.decide` strings. AgentActivity.tsx maps a name to the
 * real token in one place. One map, one source of truth, and the check script
 * can still assert the fallback for an unseen role — which it could not if the
 * map lived inside the React module.
 */

const AGENT_KINDS: ReadonlySet<string> = new Set([
  "operator",
  "worker",
  "cron",
  "unknown",
]);

/** The row's kind, or an honest "unknown".
 *
 *  Both failure modes map to the same answer and both are real: the field is
 *  absent (pre-phase-5 production), or it carries a string this build does not
 *  know (a server ahead of the client). Never infer a kind from `worker` or
 *  `title` as a consolation prize — a guessed org chart is worse than a blank
 *  one, because it cannot be told apart from a correct one. */
export function agentKindOf(a: AgentRow): AgentKind {
  const k = a.agent_kind;
  if (typeof k === "string" && AGENT_KINDS.has(k)) return k;
  return "unknown";
}

/** Rendered when there is no honest value — same glyph `humanDuration` uses. */
const EM_DASH = "—";

/** Bare model families with no version. `claude-opus-5` names one model;
 *  `opus` names whatever the alias resolved to that day, which for the 108
 *  legacy rows carrying one we can no longer recover. They render faint
 *  (R8): legible, but visibly less precise than a resolved id. */
const MODEL_ALIASES: ReadonlySet<string> = new Set([
  "haiku",
  "sonnet",
  "opus",
  "fable",
]);

/** Strip the vendor prefix a Claude model id always carries. */
const CLAUDE_PREFIX = /^claude-/;
/** Trailing snapshot date: `claude-haiku-4-5-20251001` → `haiku-4-5`. */
const SNAPSHOT_DATE = /-\d{8}$/;

/** Display form of a model id. Mechanical, not a lookup table — a model this
 *  build has never heard of must still render as itself.
 *
 *    claude-fable-5             → fable-5
 *    claude-haiku-4-5-20251001  → haiku-4-5
 *    haiku                      → haiku      (alias; render faint)
 *    gpt-5-whatever             → gpt-5-whatever   (verbatim)
 *    null                       → —
 *
 *  Never returns an empty string: a pathological id like "claude-" keeps its
 *  raw form rather than collapsing into a blank column. */
export function modelDisplay(model: string | null | undefined): string {
  if (model == null) return EM_DASH;
  const raw = model.trim();
  if (!raw) return EM_DASH;
  const display = raw.replace(CLAUDE_PREFIX, "").replace(SNAPSHOT_DATE, "");
  return display || raw;
}

/** True for a bare family alias — with or without the `claude-` prefix. */
export function isModelAlias(model: string | null | undefined): boolean {
  if (model == null) return false;
  return MODEL_ALIASES.has(model.trim().toLowerCase().replace(CLAUDE_PREFIX, ""));
}

/** The six project roles — forge-control/src/routes/projects.ts:24-30.
 *
 *  Deliberately `Record<string, …>` and not keyed by app/api.ts's `TaskRole`:
 *  that union has no `researcher`, and two surfaces hold exhaustive
 *  `Record<TaskRole, string>` maps that widening it would break. The panel
 *  owns its own vocabulary and treats an unseen role as data, not as an
 *  error — `scout` and `researcher` have no rows in the database yet, and the
 *  first one ever spawned must render as itself rather than as a blank. */
export const ROLE_LABEL: Record<string, string> = {
  architect: "architect",
  planner: "planner",
  scout: "scout",
  researcher: "researcher",
  builder: "builder",
  reviewer: "reviewer",
};

/** Label for a role: known roles from the map, unseen roles verbatim, absent
 *  role as the em dash. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return EM_DASH;
  return ROLE_LABEL[role] ?? role;
}

/** Token names, not token values — see the section header. */
export type RoleTokenName =
  | "decide"
  | "info"
  | "accent"
  | "warn"
  | "textMuted2"
  | "ok"
  | "textMuted";

/** Per-role colour. Chosen so the four roles that actually run today are
 *  distinguishable at a glance in both palettes: architect decides (decide),
 *  planner informs (info), builder is the live-work colour (accent), reviewer
 *  is the one who says stop (warn). `scout`/`researcher` have no rows yet and
 *  take the two remaining neutral-ish tokens. */
export const ROLE_TOKEN: Record<string, RoleTokenName> = {
  architect: "decide",
  planner: "info",
  builder: "accent",
  reviewer: "warn",
  scout: "textMuted2",
  researcher: "ok",
};

/** Colour token for a role, `textMuted` for an unseen or absent one. */
export function roleTokenName(role: string | null | undefined): RoleTokenName {
  if (!role) return "textMuted";
  return ROLE_TOKEN[role] ?? "textMuted";
}

/* phase 400 (U9): the manager row type and its fetcher were deleted here,
 * along with the manager cards component in ./live. The right panel no longer
 * has a selector of its own — it is scoped to the open chat's linked project
 * (GET /api/chat/:id/linkage). The manager-rollup endpoint stays live on the
 * server (NFU4, additive policy); the web app simply stops calling it. */

export const fetchAgents = async (projectId?: string): Promise<AgentsResponse> => {
  const url = projectId
    ? `${ROOT}/agents?project_id=${encodeURIComponent(projectId)}`
    : `${ROOT}/agents`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /agents`);
  return (await r.json()) as AgentsResponse;
};

/* ── Dismissals ───────────────────────────────────────────────────────────
 *
 * `/api/agents/dismissals` (round 1350, server half in
 * docs/plan/artifacts/phase1350/dismissal-api.md). The four calls live HERE,
 * beside `fetchAgents`, because they are routes of the same router and this
 * module is the Live panel's whole network surface; the React hook that owns
 * the shared set is ../team/dismissals.
 *
 * Every one of them THROWS on a non-2xx, carrying the server's own `error`/
 * `message` — a dismissal that did not persist must not look like one that
 * did (NFU6). There is no catch here that turns a 500 into an empty set.
 */

/** The server's own reason, appended to a thrown message when it sent one.
 *  Falls back to the raw body, then to nothing — never invents a cause. */
function serverReason(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const parts = [rec.error, rec.message].filter(
        (v): v is string => typeof v === "string" && v !== "",
      );
      if (parts.length > 0) return ` — ${parts.join(": ")}`;
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  const raw = body.trim();
  return raw ? ` — ${raw.slice(0, 200)}` : "";
}

/** One request, one parsed body, or a throw naming the route. */
async function dismissalRequest(
  path: string,
  init: RequestInit,
  what: string,
): Promise<unknown> {
  const r = await fetch(`${ROOT}/agents/dismissals${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.text();
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText} on ${what}${serverReason(body)}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${what}: response was not JSON — ${body.slice(0, 200)}`);
  }
}

/** The named field as a string array, or a throw. A malformed body is a
 *  failure to report, not a set to silently treat as empty. */
function stringArray(body: unknown, field: string, what: string): string[] {
  const value =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${what}: malformed \`${field}\` in response`);
  }
  return value as string[];
}

/** Everything currently hidden — run uuids AND sub-agent `tool_use_id`s. */
export async function fetchDismissals(): Promise<string[]> {
  const body = await dismissalRequest("", { method: "GET" }, "GET /agents/dismissals");
  return stringArray(body, "node_ids", "GET /agents/dismissals");
}

/**
 * Hide `id`, and — with `cascade` — everything the server resolves under it:
 * its settled descendants, and for an operator chat its project's settled
 * workers. The returned list is what is hidden AS A RESULT of the call
 * (already-hidden ids included), so the caller can adopt it wholesale instead
 * of waiting a poll to discover what went with it.
 */
export async function postDismissal(
  id: string,
  cascade: boolean,
): Promise<string[]> {
  const body = await dismissalRequest(
    "",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, cascade }),
    },
    "POST /agents/dismissals",
  );
  return stringArray(body, "dismissed", "POST /agents/dismissals");
}

/** Un-hide exactly this id. `[]` means it was not hidden — a state, not an
 *  error, which is why the server answers 200. */
export async function deleteDismissal(id: string): Promise<string[]> {
  const body = await dismissalRequest(
    `/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "DELETE /agents/dismissals/:id",
  );
  return stringArray(body, "restored", "DELETE /agents/dismissals/:id");
}

/** Un-hide everything. Returns how many rows the server deleted. */
export async function deleteAllDismissals(): Promise<number> {
  const body = await dismissalRequest(
    "",
    { method: "DELETE" },
    "DELETE /agents/dismissals",
  );
  const restored =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>).restored
      : undefined;
  if (typeof restored !== "number") {
    throw new Error("DELETE /agents/dismissals: malformed `restored` in response");
  }
  return restored;
}
