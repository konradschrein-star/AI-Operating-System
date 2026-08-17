/**
 * agents-shared.ts — run-shaping logic shared by every read-side route that
 * has to render a `runs` row as an agent.
 *
 * Nothing here talks to the database and nothing here is a route. It is the
 * pure half of `routes/agents.ts`: the wire types the Live panel consumes,
 * plus the functions that turn one raw `runs` row into one of those objects.
 * `routes/agents.ts` keeps its pool, its SQL, its summary math and its two
 * handlers, and imports the rest from here.
 *
 * Why the split exists (13-ui-v3-architecture.md §3): phases 1–2 established
 * two truths inside `agentFromRow` — a settled run's duration is frozen at
 * `settled_at − started_at`, and every row is classified into an `agent_kind`
 * — and phase 300's `GET /api/chat/:id/team` must show the SAME numbers for
 * the SAME runs. A second implementation would drift the first time one side
 * is fixed. So the shaping moves to a module both can import, and the queries
 * stay route-local (the team endpoint needs its own SQL: `fetchActiveRows`
 * carries a 24 h recency window and LIMIT 60, and a chat opened next week must
 * still show its finished team).
 *
 * The contract for those callers is `agentFromRow(row: AgentRowRaw, nowMs)`.
 * See `AgentRowRaw` below for the exact column set a caller's own SELECT must
 * produce.
 *
 * Extraction discipline: this file was moved out of `routes/agents.ts`
 * verbatim in round 302 — same code, same comments, same semantics — and the
 * move was gated on `GET /api/agents` staying byte-identical against the
 * pre-change transcript in `docs/plan/artifacts/phase300/baseline/`
 * (`scripts/checks/api-diff.sh`). Anything that changes what these functions
 * return is a change to the shipped Live panel, not a refactor.
 */

import type { ThreadEntry } from "../db/runs.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ModelBreakdown extends Usage {
  model: string;
  cost_usd: number;
}

export interface CurrentActivity {
  kind: "tool_call" | "tool_result" | "assistant_text" | "thinking";
  tool?: string | null;
  text?: string | null;
  parent_tool_use_id?: string | null;
  model?: string | null;
  ts?: string | null;
}

export interface Subagent {
  kind: "subagent";
  /** parent Task tool_use_id — the spawn identity, stable inside the turn */
  tool_use_id: string;
  role: string;
  model: string | null;
  started_at: string;
  updated_at: string;
  /** Stamped by the rollup when the spawn's tool_result fires. This — not
   *  `updated_at` — is the settle time: late events arriving under a stale
   *  parent_tool_use_id keep pushing `updated_at` forward after the
   *  sub-agent is already done. Null on rows predating rollup v2 and on the
   *  thread-fallback path, where the client falls back visibly. */
  ended_at: string | null;
  /** The human one-liner from the spawn's input ("Recon chat Bash block
   *  rendering") — persisted by the rollup, dropped on the wire until now. */
  description: string | null;
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

export interface AgentRun {
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
  /** Wall-clock runtime. For a LIVE run this is `now − started_at`, derived
   *  server-side so a paused UI reflects the true elapsed by the time it
   *  renders (the client also ticks it). For a SETTLED run it is frozen at
   *  `settled_at − started_at` — never now-derived, or a finished 130-second
   *  run reads "5h 05m" and grows every poll. Unusable timestamps → null,
   *  which the client renders as "—". */
  elapsed_ms: number | null;
  /** status ∈ {completed, failed, cancelled}. */
  settled: boolean;
  /** When the run settled: `completed_at ?? updated_at`. Null while live. */
  settled_at: string | null;
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
  /** What KIND of thing this row is — see `classifyAgentKind`. The panel
   *  renders it verbatim: a stranger must be able to tell an operator chat
   *  from a project worker from a cron tick without reading the title. */
  agent_kind: AgentKind;
  /** Project worker role (architect/planner/builder/reviewer/scout/
   *  researcher) from `metadata.role`. Null on anything that isn't a worker
   *  — and on a worker whose metadata is incomplete, which is exactly why
   *  such a row does not classify as `worker`. */
  role: string | null;
  /** `metadata.project_id` — the project this run belongs to. */
  project_id: string | null;
  /** `metadata.cron_name` — the schedule's human name ("weekly-review").
   *  Present independently of `agent_kind`; `cron_id` is what classifies. */
  cron_name: string | null;
  /** When Konrad hid this row from the Live panel, else null (round 1350,
   *  `ui_dismissals`). The payload is NOT filtered by it: the server's job is
   *  to say what is true, and the panel's job is to decide what to draw — it
   *  also has to render "N dismissed · show", which needs the hidden rows. */
  dismissed_at: string | null;
  /** System A sub-agents currently active within this run's process. */
  subagents: Subagent[];
}

/** Terminal statuses. Once a run is in one of these its duration is history,
 *  not a stopwatch. */
export const SETTLED_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function numOr0(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

export function pickUsage(src: unknown): Usage {
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

export function pickTotal(src: unknown): AgentRun["usage_total"] {
  const base = pickUsage(src);
  const s = (src && typeof src === "object" ? src : {}) as Record<string, unknown>;
  return {
    ...base,
    turns: numOr0(s.turns),
    cost_usd: numOr0(s.cost_usd),
    thinking_tokens: numOr0(s.thinking_tokens),
  };
}

export function pickModelBreakdown(src: unknown): ModelBreakdown[] {
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

export function pickCurrentActivity(src: unknown): CurrentActivity | null {
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
export function foldSubagents(thread: ThreadEntry[]): Subagent[] {
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
      // Thread fallback: the rollup owns the settle stamp and the spawn
      // description; neither is recoverable from the raw thread here, so we
      // say null and let the client show its visible fallback rather than
      // inventing a timestamp.
      ended_at: null,
      description: null,
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
        ended_at: null,
        description: null,
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

/**
 * One raw `runs` row, as `agentFromRow` needs it.
 *
 * THIS IS THE CONTRACT FOR CALLERS WITH THEIR OWN SQL. A route that shapes
 * runs itself (phase 300's `GET /api/chat/:id/team`, whose query must not
 * inherit `fetchActiveRows`' 24 h window and LIMIT 60) selects exactly these
 * columns, verbatim, and passes the rows straight to `agentFromRow`:
 *
 *   id::text, title, status, worker, spent_usd::text,
 *   metadata, thread, parent_run_id::text AS parent_run_id,
 *   started_at::text, updated_at::text, completed_at::text,
 *   last_heartbeat_at::text,
 *   d.dismissed_at::text AS dismissed_at   -- LEFT JOIN ui_dismissals d
 *                                          --   ON d.node_id = runs.id::text
 *
 * The `::text` casts are not cosmetic: `spent_usd` is numeric and the six
 * timestamps are timestamptz, and pg would hand back a JS number and Date
 * objects whose serialization differs from what the wire has always carried.
 * `thread` may be selected as `NULL::jsonb` (see `fetchActiveRows` for when
 * that is the right call) but the column must be present.
 *
 * `dismissed_at` (round 1350) is the ONE field on this row that does not come
 * from `runs`. It is a LEFT JOIN against `ui_dismissals` (migration 0041) and
 * is null for the overwhelming majority of rows. A caller that forgets the
 * join gets `undefined` from pg and the compiler will not catch it — pg types
 * a result to whatever you tell it to — so the join is written out above
 * verbatim, and every query in this repo that produces an `AgentRowRaw` has
 * it. Dismissal NEVER filters rows out of a payload; it is a flag the client
 * decides what to do with.
 *
 * Do not widen this shape. Every field on it is read by `agentFromRow`, and
 * every caller's SELECT is checked against this list by eye, not by the
 * compiler — pg types a query result to whatever you tell it to.
 */
export interface AgentRowRaw {
  id: string;
  title: string;
  status: string;
  worker: string | null;
  spent_usd: string;
  metadata: Record<string, unknown>;
  /** Only populated on the fallback path (see `fetchActiveRows` in
   *  agents.ts): live rows that don't yet carry `metadata.rollup_v1`. All
   *  other rows get NULL here so the row payload stays small. */
  thread: ThreadEntry[] | null;
  parent_run_id: string | null;
  started_at: string | null;
  updated_at: string;
  /** Stamped by every complete/fail path. The cancel path never stamps it
   *  (4 legacy rows), which is why the settle time falls back to
   *  `updated_at` — see `agentFromRow`. */
  completed_at: string | null;
  last_heartbeat_at: string | null;
  /** From `ui_dismissals`, not from `runs` — see the join in the header
   *  above. Null means "not hidden", which is nearly every row. */
  dismissed_at: string | null;
}

/** Parse the persisted `metadata.subagents_v2` rollup into wire-shape
 *  Subagent rows. Guards each field so a malformed record can't crash the
 *  Live panel — anything unrecognised becomes an empty/default. */
export function subagentsFromRollup(src: unknown): Subagent[] {
  if (!Array.isArray(src)) return [];
  const out: Subagent[] = [];
  for (const raw of src) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.tool_use_id !== "string") continue;
    const la = s.latest_activity as Record<string, unknown> | null | undefined;
    out.push({
      kind: "subagent",
      tool_use_id: s.tool_use_id,
      role: typeof s.role === "string" ? s.role : "agent",
      model: typeof s.model === "string" ? s.model : null,
      started_at: typeof s.started_at === "string" ? s.started_at : "",
      updated_at: typeof s.updated_at === "string" ? s.updated_at : "",
      ended_at: typeof s.ended_at === "string" ? s.ended_at : null,
      description: typeof s.description === "string" ? s.description : null,
      usage: pickUsage(s.usage),
      event_count: numOr0(s.event_count),
      latest_activity:
        la && typeof la === "object"
          ? {
              kind: typeof la.kind === "string" ? la.kind : "text",
              tool: typeof la.tool === "string" ? la.tool : null,
              text: typeof la.text === "string" ? la.text : null,
              ts: typeof la.ts === "string" ? la.ts : "",
            }
          : null,
      status: s.status === "done" ? "done" : "running",
    });
  }
  return out;
}

export type AgentKind = "operator" | "worker" | "cron" | "unknown";

/** Read a metadata field as a non-empty string, or nothing.
 *
 *  ABSENT means: missing key, null, empty string, or any non-string value.
 *  `metadata` is untyped JSONB — a number, an object or a stray `""` must
 *  never be mistaken for a project id, or a cron tick reads as a worker. */
export function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v ? v : null;
}

/**
 * Classify a run row into one of four kinds
 * (R7, operator-visibility/02-architecture §4.1).
 *
 * Ordered precedence — FIRST MATCH WINS:
 *   1. `metadata.cron_id` present            → "cron"
 *   2. `metadata.project_id` AND `.role`     → "worker"
 *   3. `worker === "forge-executor"`         → "operator"
 *   4. anything else                         → "unknown"
 *
 * Why cron outranks the rest: a cron tick can carry ANY worker identity.
 * Verified live — run e0f6f39e-10a3-4b9a-8124-3f0989205453 is a cron with
 * `worker='forge-executor'` (would read as an operator chat at rule 3), and
 * faa0fd8a… is a cron with `worker='skylab-producer'`. The schedule is the
 * truth about why the run exists; the worker is only who executed it.
 *
 * Why a partial worker signature falls through: `project_id` without `role`
 * (or the reverse) cannot name a role in the org chart, so it drops to the
 * worker-identity rule and, failing that, to "unknown". "unknown" is a real,
 * honest answer that shows up in the panel as signal — never guess a kind,
 * never fall back to "operator".
 */
export function classifyAgentKind(
  worker: string | null,
  meta: Record<string, unknown>,
): AgentKind {
  if (metaStr(meta, "cron_id")) return "cron";
  if (metaStr(meta, "project_id") && metaStr(meta, "role")) return "worker";
  if (worker === "forge-executor") return "operator";
  return "unknown";
}

export function agentFromRow(row: AgentRowRaw, nowMs: number): AgentRun {
  const meta = row.metadata ?? {};
  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  // Time truth: a settled run's duration is measured against when it settled,
  // never against `now`. `completed_at` is stamped by every complete/fail
  // path; the legacy cancel path isn't, so `updated_at` carries the settle
  // time there. If neither parses we return null rather than a now-derived
  // number — a visible "—" beats a plausible lie that grows all day.
  const settled = SETTLED_STATUSES.has(row.status);
  const settledAtRaw = settled ? (row.completed_at ?? row.updated_at) : null;
  const settledAtMs = settledAtRaw ? Date.parse(settledAtRaw) : NaN;
  const elapsed = !Number.isFinite(startedMs)
    ? null
    : settled
      ? Number.isFinite(settledAtMs)
        ? Math.max(0, settledAtMs - startedMs)
        : null
      : Math.max(0, nowMs - startedMs);
  const usageRunningRaw = (meta as Record<string, unknown>).usage_running;
  const totalRunningRaw = (meta as Record<string, unknown>).usage_total_running;
  // Prefer the persisted rollup; only crack the thread when a live row has
  // no rollup marker yet (executor pre-deploy, or restarted mid-run).
  const rolledSubagents =
    (meta as Record<string, unknown>).subagents_v2 !== undefined
      ? subagentsFromRollup((meta as Record<string, unknown>).subagents_v2)
      : row.thread
        ? foldSubagents(row.thread)
        : [];
  const modelResolved =
    typeof (meta as Record<string, unknown>).model_resolved === "string"
      ? ((meta as Record<string, unknown>).model_resolved as string)
      : null;
  return {
    kind: "run",
    id: row.id,
    title: row.title,
    status: row.status,
    worker: row.worker,
    model:
      modelResolved ??
      (typeof meta.model === "string" ? (meta.model as string) : null),
    effort: typeof meta.effort === "string" ? (meta.effort as string) : null,
    engine: typeof meta.engine === "string" ? (meta.engine as string) : "claude-code",
    cwd: typeof meta.workspace_dir === "string" ? (meta.workspace_dir as string) : null,
    started_at: row.started_at,
    updated_at: row.updated_at,
    last_heartbeat_at: row.last_heartbeat_at,
    elapsed_ms: elapsed,
    settled,
    settled_at: settledAtRaw,
    spent_usd: numOr0(row.spent_usd),
    // usage_total_running (the rollup's aggregate for the current process)
    // beats the older metadata.usage_total path — that field was never
    // written by the executor, only ever the empty default from pickTotal.
    usage_total: pickTotal(
      totalRunningRaw ?? (meta as Record<string, unknown>).usage_total,
    ),
    usage_last_turn: pickUsage((meta as Record<string, unknown>).usage_last_turn),
    usage_running: usageRunningRaw ? pickUsage(usageRunningRaw) : null,
    usage_by_model: pickModelBreakdown(
      (meta as Record<string, unknown>).usage_last_model_breakdown,
    ),
    current_activity: pickCurrentActivity(
      (meta as Record<string, unknown>).current_activity,
    ),
    parent_run_id: row.parent_run_id,
    // Kind truth. The three metadata fields go over the wire through the
    // SAME guard the classifier uses (`metaStr`), so a row can never render
    // a role the classification didn't see — no join, no extra column: both
    // `worker` and `metadata` are already selected by every query here, and
    // a 4-second poll must not grow a projects-table join for a name.
    agent_kind: classifyAgentKind(row.worker, meta),
    role: metaStr(meta, "role"),
    project_id: metaStr(meta, "project_id"),
    cron_name: metaStr(meta, "cron_name"),
    // Straight through from the join. `?? null` is not a fallback hiding a
    // bug: pg omits the key entirely when a caller's SELECT lacks the column,
    // and `undefined` on the wire would silently drop the field from the JSON
    // rather than sending the honest `null` the client's type expects.
    dismissed_at: row.dismissed_at ?? null,
    subagents: rolledSubagents,
  };
}
