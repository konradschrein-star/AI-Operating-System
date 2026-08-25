/**
 * Per-run activity rollup persisted to `runs.metadata` at write time.
 *
 * The Live agent panel used to compute all of this on read: `GET /api/agents`
 * pulled `runs.thread` (full JSONB, up to 60 rows) every 4s and folded it in
 * JS to derive subagent state, per-run token totals and current activity.
 * For a 682-turn thread that's several MB of network + JSON parse per poll,
 * cited by the UI audit (§7 fix #1) as the strongest single candidate for
 * the "the UI bogs down the whole machine" symptom.
 *
 * This module keeps the same information hot on the write side: as `cc-runner`
 * streams events, we mutate an in-memory `RunRollup` and periodically flush
 * a compact JSON snapshot to `runs.metadata.rollup_v1` +
 * `runs.metadata.subagents_v2` + `runs.metadata.usage_running` +
 * `runs.metadata.current_activity`. `routes/agents.ts` then selects those
 * columns directly instead of the whole thread.
 *
 * The rollup is per-executor-process and NOT durable across restarts. If the
 * executor restarts mid-run, the rollup starts fresh from the next event;
 * `routes/agents.ts` falls back to `foldSubagents(thread)` when a live run
 * has no rollup marker yet, so nothing looks broken during the transition.
 */

import pg from "pg";
import type { CcEvent, CcTokenUsage } from "./cc-runner.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[run-rollup pool]", e.message));

const EMPTY_USAGE: CcTokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** Compact per-subagent record — mirrors the wire shape the UI already
 *  consumes (`SubagentRow` in forge-control-web/live/agentsApi.ts). */
export interface SubagentRollup {
  tool_use_id: string;
  role: string;
  /** Optional short human label — the Task tool's `description` field. */
  description: string | null;
  model: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  usage: CcTokenUsage;
  event_count: number;
  latest_activity: {
    kind: string;
    tool: string | null;
    text: string | null;
    ts: string;
  } | null;
  status: "running" | "done";
}

/** Current tool call (parent run only), so the UI can show "editing X.tsx"
 *  without cracking the thread. */
export interface CurrentActivityRollup {
  kind: "tool_call" | "tool_result" | "assistant_text";
  tool: string | null;
  text: string | null;
  ts: string;
}

interface RunRollup {
  runId: string;
  /** Aggregate parent-run usage across all assistant messages seen this
   *  process. Reset on executor restart. */
  usageTotal: CcTokenUsage;
  /** Usage from the LAST assistant message we saw — proxy for "usage_running"
   *  during a turn. */
  usageLast: CcTokenUsage;
  currentActivity: CurrentActivityRollup | null;
  /** `tool_use_id` → tool name, for PARENT tool calls still awaiting their
   *  result. Exists so a `tool_result` can name the tool it answers — see
   *  the header on the tool_result branch of `ingestEvent`.
   *
   *  Self-bounding: an entry is deleted the moment its result arrives, so the
   *  map holds only the calls actually in flight (one, or a handful when the
   *  model batches parallel calls). `PENDING_TOOL_CAP` is the backstop for
   *  the case where a result never arrives at all — a killed run, or a Task
   *  spawn whose parent exits first — since those entries would otherwise
   *  live until `finalizeRollup`. */
  pendingTools: Map<string, string>;
  subagents: Map<string, SubagentRollup>;
  /** Model reported on the most recent parent assistant message. */
  lastModel: string | null;
  /** Throttle bookkeeping. */
  dirty: boolean;
  lastFlushMs: number;
  flushInFlight: Promise<void> | null;
  /** Ended runs get one final flush and are then dropped from the map. */
  finalized: boolean;
}

const state = new Map<string, RunRollup>();

const FLUSH_INTERVAL_MS = 2_000;

/** Hard ceiling on `pendingTools`. Only reached when tool results stop
 *  arriving, so the oldest un-answered call is the right one to forget. */
const PENDING_TOOL_CAP = 64;

/** Remember which tool a parent `tool_use_id` belongs to, oldest evicted
 *  first (a `Map` iterates in insertion order). */
function rememberPendingTool(s: RunRollup, toolUseId: string, tool: string): void {
  s.pendingTools.set(toolUseId, tool);
  while (s.pendingTools.size > PENDING_TOOL_CAP) {
    const oldest = s.pendingTools.keys().next();
    if (oldest.done) break;
    s.pendingTools.delete(oldest.value);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensure(runId: string): RunRollup {
  let s = state.get(runId);
  if (!s) {
    s = {
      runId,
      usageTotal: { ...EMPTY_USAGE },
      usageLast: { ...EMPTY_USAGE },
      currentActivity: null,
      pendingTools: new Map(),
      subagents: new Map(),
      lastModel: null,
      dirty: false,
      lastFlushMs: 0,
      flushInFlight: null,
      finalized: false,
    };
    state.set(runId, s);
  }
  return s;
}

function sumUsage(target: CcTokenUsage, add: CcTokenUsage): void {
  target.input_tokens += add.input_tokens;
  target.output_tokens += add.output_tokens;
  target.cache_read_input_tokens += add.cache_read_input_tokens;
  target.cache_creation_input_tokens += add.cache_creation_input_tokens;
}

/** Parse the Task tool's input to recover the subagent's declared role +
 *  human description. Input arrives as a JSON string on the tool_call event. */
function parseTaskInput(
  input: unknown,
): { role: string; description: string | null } {
  const fallback = { role: "agent", description: null as string | null };
  if (input == null) return fallback;
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return fallback;
    }
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  const p = parsed as Record<string, unknown>;
  const role =
    typeof p.subagent_type === "string" && p.subagent_type.trim()
      ? p.subagent_type
      : typeof p.description === "string" && p.description.trim()
        ? p.description
        : "agent";
  const description =
    typeof p.description === "string" && p.description.trim()
      ? p.description
      : null;
  return { role, description };
}

/** Ingest one streamed CC event, updating the in-memory rollup and
 *  scheduling a flush if enough time has passed. Never throws — a
 *  rollup miss is strictly worse UI, not a broken run. */
export function ingestEvent(runId: string, e: CcEvent): void {
  try {
    const s = ensure(runId);
    const parent = e.parentToolUseId ?? null;
    const ts = nowIso();

    if (e.type === "tool_call") {
      // A Task/Agent tool_call on the PARENT run spawns a subagent. Seed a
      // row immediately so the UI can render it even before the child's
      // first assistant message arrives.
      const isTaskSpawn =
        !parent &&
        typeof e.toolName === "string" &&
        (e.toolName === "Task" || e.toolName === "Agent") &&
        typeof e.toolUseId === "string";
      if (isTaskSpawn) {
        const { role, description } = parseTaskInput(e.toolInput);
        s.subagents.set(e.toolUseId!, {
          tool_use_id: e.toolUseId!,
          role,
          description,
          model: null,
          started_at: ts,
          updated_at: ts,
          ended_at: null,
          usage: { ...EMPTY_USAGE },
          event_count: 0,
          latest_activity: null,
          status: "running",
        });
        s.dirty = true;
      }
      if (!parent) {
        // Parent-run tool call — becomes the "current activity" label.
        const toolName = typeof e.toolName === "string" ? e.toolName : null;
        if (typeof e.toolUseId === "string" && e.toolUseId !== "" && toolName) {
          rememberPendingTool(s, e.toolUseId, toolName);
        }
        s.currentActivity = {
          kind: "tool_call",
          tool: toolName,
          text: null,
          ts,
        };
      } else {
        // Subagent tool call — update its latest_activity.
        const sub = s.subagents.get(parent);
        if (sub) {
          sub.updated_at = ts;
          sub.event_count += 1;
          sub.latest_activity = {
            kind: "tool_call",
            tool: typeof e.toolName === "string" ? e.toolName : null,
            text: null,
            ts,
          };
        }
      }
      s.dirty = true;
    } else if (e.type === "tool_result") {
      if (!parent && typeof e.toolUseId === "string") {
        // Result for a Task spawn — mark that subagent done.
        const sub = s.subagents.get(e.toolUseId);
        if (sub && sub.status === "running") {
          sub.status = "done";
          sub.ended_at = ts;
          sub.updated_at = ts;
        }
        /* ── The tool_result hole ────────────────────────────────────────────
         *
         * This used to write `tool: null`, and every reader of it renders a
         * blank: `activityLabel` (live/AgentActivity.tsx) returns "" for a
         * tool_result outright. Replaying this state machine over 338 runs of
         * `runs.thread` shows the parent sits in `tool_result` for 58.8-75.3%
         * of live wall-clock — a tool returns in milliseconds and the model
         * then thinks for seconds — so the "what is it doing right now" column
         * would be empty most of the time it is looked at.
         *
         * The range is the measurement's honest width: the share depends on
         * the idle-gap cap that defines "live", 68.3% at a 120 s cap. Method,
         * raw counts and the re-runnable instrument are in
         * `evidence/aios-sidebar-live-sessions/activity-truth.md` §2-§4; it is
         * NOT the bare "60.8%" round 0 published against no artefact.
         *
         * The answering tool's name is the honest label for that state: the
         * agent is digesting what `Bash` just returned. It costs one map
         * lookup and no new event, and it makes the cell correct even while
         * the flush throttle below is still serving the preceding tool_call —
         * both states now render the same tool name.
         */
        const answering = s.pendingTools.get(e.toolUseId) ?? null;
        s.pendingTools.delete(e.toolUseId);
        s.currentActivity = {
          kind: "tool_result",
          tool: answering,
          text: null,
          ts,
        };
      } else if (parent) {
        const sub = s.subagents.get(parent);
        if (sub) {
          sub.updated_at = ts;
          sub.event_count += 1;
        }
      }
      s.dirty = true;
    } else if (e.type === "assistant_text") {
      const usage = e.usage ?? EMPTY_USAGE;
      if (parent) {
        const sub = s.subagents.get(parent);
        if (sub) {
          sub.updated_at = ts;
          sub.event_count += 1;
          sub.usage = { ...sub.usage };
          sumUsage(sub.usage, usage);
          if (e.model && !sub.model) sub.model = e.model;
          sub.latest_activity = {
            kind: "assistant_text",
            tool: null,
            text: e.text ? e.text.slice(0, 160) : null,
            ts,
          };
        }
      } else {
        // Parent assistant message — feeds usage_total + usage_running.
        sumUsage(s.usageTotal, usage);
        s.usageLast = { ...usage };
        if (e.model) s.lastModel = e.model;
        s.currentActivity = {
          kind: "assistant_text",
          tool: null,
          text: e.text ? e.text.slice(0, 160) : null,
          ts,
        };
      }
      s.dirty = true;
    }

    maybeFlush(s);
  } catch (err) {
    console.error(
      "[run-rollup] ingest failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function maybeFlush(s: RunRollup): void {
  if (!s.dirty || s.flushInFlight) return;
  const now = Date.now();
  if (now - s.lastFlushMs < FLUSH_INTERVAL_MS) return;
  s.flushInFlight = flush(s).finally(() => {
    s.flushInFlight = null;
  });
}

async function flush(s: RunRollup): Promise<void> {
  s.dirty = false;
  s.lastFlushMs = Date.now();
  const payload = buildPayload(s);
  try {
    await pool.query(
      `UPDATE runs
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [s.runId, JSON.stringify(payload)],
    );
  } catch (err) {
    console.warn(
      `[run-rollup] flush run ${s.runId} failed:`,
      err instanceof Error ? err.message : err,
    );
    // Re-flag dirty so the next event tries again. Nothing else is safe:
    // silently swallowing loses the rollup permanently for this run.
    s.dirty = true;
  }
}

function buildPayload(s: RunRollup): Record<string, unknown> {
  return {
    // Marker: presence means routes/agents.ts can trust the rollup and
    // skip the thread SELECT for this row. Timestamp is diagnostic.
    rollup_v1: new Date().toISOString(),
    subagents_v2: Array.from(s.subagents.values()),
    usage_running: s.usageLast,
    usage_total_running: s.usageTotal,
    current_activity: s.currentActivity,
    // Only overwrite metadata.model when we learned a fresher one — the
    // executor sets metadata.model at claim time from the run's declared
    // model; parent assistant frames often carry the resolved concrete id
    // (e.g. "claude-opus-4-5-20260827"), which is more useful.
    ...(s.lastModel ? { model_resolved: s.lastModel } : {}),
  };
}

/** Force a final flush and drop in-memory state. Call from processRun
 *  cleanup, so the UI sees the last event burst that arrived before close. */
export async function finalizeRollup(runId: string): Promise<void> {
  const s = state.get(runId);
  if (!s) return;
  s.finalized = true;
  // Wait for any in-flight flush to complete before we push the terminal one.
  if (s.flushInFlight) {
    try {
      await s.flushInFlight;
    } catch {
      /* already logged */
    }
  }
  if (s.dirty) {
    try {
      await flush(s);
    } catch {
      /* already logged in flush */
    }
  }
  state.delete(runId);
}

/** Test-only reset. */
export function _resetForTests(): void {
  state.clear();
}

/** Test-only read of the in-memory rollup for one run.
 *
 *  Exists because `pendingTools` is otherwise observable only through a
 *  `flush()` to Postgres, which would make the unit suite need a database —
 *  see the header of `run-rollup.test.ts`. Returns a shallow copy so a test
 *  cannot mutate executor state through it, and `null` when the run has no
 *  rollup (never seen, or already finalized). */
export function _snapshotForTests(runId: string): {
  currentActivity: CurrentActivityRollup | null;
  pendingTools: [string, string][];
  subagents: SubagentRollup[];
  lastModel: string | null;
} | null {
  const s = state.get(runId);
  if (!s) return null;
  return {
    currentActivity: s.currentActivity === null ? null : { ...s.currentActivity },
    pendingTools: Array.from(s.pendingTools.entries()),
    subagents: Array.from(s.subagents.values()),
    lastModel: s.lastModel,
  };
}
