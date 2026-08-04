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
        s.currentActivity = {
          kind: "tool_call",
          tool: typeof e.toolName === "string" ? e.toolName : null,
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
        s.currentActivity = {
          kind: "tool_result",
          tool: null,
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
