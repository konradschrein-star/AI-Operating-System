/**
 * REPLAY: what state does run-rollup's `current_activity` actually hold, and
 * for what share of live wall-clock?
 *
 * Round 0 of `aios-sidebar-live-sessions` published "60.8% of live wall-clock
 * in tool_result" and never landed the artefact behind it (round-4 review,
 * finding 3). This re-derives the number from scratch so the figure quoted in
 * run-rollup.ts / liveSessions.ts has a method and raw counts behind it.
 *
 * METHOD. `ingestEvent` only ever moves `currentActivity` on three event types,
 * and only for PARENT events (`parentToolUseId` absent):
 *     tool_call      → { kind: "tool_call",     tool }
 *     tool_result    → { kind: "tool_result",   tool: <the answering call> }
 *     assistant_text → { kind: "assistant_text" }
 * Everything else in the thread (comms, error, system text, user text, and all
 * SUBAGENT events) leaves the parent state untouched, so those rows are read
 * but do not emit a state.
 *
 * A state is held from its own `ts` until the next state-changing event's `ts`.
 * That gap is the weight. Two exclusions, both because "live wall-clock" means
 * the agent was actually working:
 *   - an interval containing a `role:"user"` row is dropped: the run was parked
 *     waiting for a human, which is not the agent doing anything.
 *   - an interval longer than GAP_CAP_S is dropped: a queue stall, an executor
 *     restart, or a run that sat between turns. Reported at four caps so the
 *     reader can see how stable the figure is rather than trusting one choice.
 *
 * Read-only: one SELECT, no writes.
 */

import pg from "pg";

const DSN =
  process.env.REPLAY_DSN ??
  (() => {
    throw new Error("REPLAY_DSN must be set — refusing to guess a database");
  })();

const GAP_CAPS_S = [60, 120, 300, Number.POSITIVE_INFINITY] as const;
const DAYS = Number(process.env.REPLAY_DAYS ?? "7");

interface ThreadRow {
  ts?: string;
  kind?: string;
  role?: string;
  meta?: {
    tool?: string;
    tool_use_id?: string;
    parent_tool_use_id?: string | null;
  } | null;
}

type Kind = "tool_call" | "tool_result" | "assistant_text";

interface Interval {
  kind: Kind;
  /** The tool name the rollup would have stored, under the CURRENT code. */
  tool: string | null;
  seconds: number;
  /** true when a user turn falls inside this interval — run was parked. */
  parked: boolean;
}

/** Replay one run's thread through the parent-only state machine. */
function replayRun(thread: ThreadRow[]): {
  intervals: Interval[];
  parentToolResults: number;
  resolvedToolResults: number;
} {
  // The same map run-rollup keeps, so the `tool` column is what the code
  // would actually have written — not what we wish it wrote.
  const pendingTools = new Map<string, string>();
  const PENDING_TOOL_CAP = 64;

  const emitted: { kind: Kind; tool: string | null; tMs: number }[] = [];
  const userTurnsMs: number[] = [];
  let parentToolResults = 0;
  let resolvedToolResults = 0;

  for (const row of thread) {
    if (typeof row.ts !== "string") continue;
    const tMs = Date.parse(row.ts);
    if (!Number.isFinite(tMs)) continue;

    if (row.role === "user") {
      userTurnsMs.push(tMs);
      continue;
    }
    // Subagent events never touch the parent's current_activity.
    const parent = row.meta?.parent_tool_use_id ?? null;
    if (parent !== null && parent !== "") continue;

    const tuid = row.meta?.tool_use_id;
    if (row.kind === "tool_call") {
      const tool = typeof row.meta?.tool === "string" ? row.meta.tool : null;
      if (typeof tuid === "string" && tuid !== "" && tool !== null) {
        pendingTools.set(tuid, tool);
        while (pendingTools.size > PENDING_TOOL_CAP) {
          const oldest = pendingTools.keys().next();
          if (oldest.done) break;
          pendingTools.delete(oldest.value);
        }
      }
      emitted.push({ kind: "tool_call", tool, tMs });
    } else if (row.kind === "tool_result") {
      parentToolResults += 1;
      const answering = typeof tuid === "string" ? (pendingTools.get(tuid) ?? null) : null;
      if (answering !== null) resolvedToolResults += 1;
      if (typeof tuid === "string") pendingTools.delete(tuid);
      emitted.push({ kind: "tool_result", tool: answering, tMs });
    } else if (row.kind === "text" && row.role === "assistant") {
      emitted.push({ kind: "assistant_text", tool: null, tMs });
    }
    // comms / error / system rows: read, no state change. Correct — ingestEvent
    // never sees them.
  }

  const intervals: Interval[] = [];
  for (let i = 0; i < emitted.length - 1; i += 1) {
    const a = emitted[i]!;
    const b = emitted[i + 1]!;
    const seconds = (b.tMs - a.tMs) / 1000;
    if (seconds < 0) continue; // out-of-order rows: drop rather than negate
    const parked = userTurnsMs.some((u) => u > a.tMs && u < b.tMs);
    intervals.push({ kind: a.kind, tool: a.tool, seconds, parked });
  }
  return { intervals, parentToolResults, resolvedToolResults };
}

const pool = new pg.Pool({ connectionString: DSN, max: 2 });

const { rows } = await pool.query<{ id: string; thread: ThreadRow[] }>(
  `SELECT id, thread
     FROM runs
    WHERE created_at > now() - ($1 || ' days')::interval
      AND thread IS NOT NULL
      AND jsonb_array_length(thread) > 0`,
  [String(DAYS)],
);

let runsWithSignal = 0;
let allIntervals: Interval[] = [];
let parentToolResults = 0;
let resolvedToolResults = 0;

for (const r of rows) {
  if (!Array.isArray(r.thread)) continue;
  const out = replayRun(r.thread);
  parentToolResults += out.parentToolResults;
  resolvedToolResults += out.resolvedToolResults;
  if (out.intervals.length > 0) {
    runsWithSignal += 1;
    allIntervals = allIntervals.concat(out.intervals);
  }
}

console.log(`corpus: last ${DAYS} days`);
console.log(`runs with a thread            : ${rows.length}`);
console.log(`runs contributing >=1 interval: ${runsWithSignal}`);
console.log(`state intervals               : ${allIntervals.length}`);
const parkedN = allIntervals.filter((i) => i.parked).length;
console.log(`  dropped as parked (user turn inside): ${parkedN}`);
console.log("");

for (const cap of GAP_CAPS_S) {
  const kept = allIntervals.filter((i) => !i.parked && i.seconds <= cap);
  const total = kept.reduce((a, i) => a + i.seconds, 0);
  const by = new Map<Kind, number>();
  const cnt = new Map<Kind, number>();
  for (const i of kept) {
    by.set(i.kind, (by.get(i.kind) ?? 0) + i.seconds);
    cnt.set(i.kind, (cnt.get(i.kind) ?? 0) + 1);
  }
  const capLabel = cap === Number.POSITIVE_INFINITY ? "uncapped" : `${cap}s`;
  console.log(
    `--- gap cap ${capLabel} — ${kept.length} intervals, ${(total / 3600).toFixed(1)} h live`,
  );
  for (const k of ["tool_result", "tool_call", "assistant_text"] as Kind[]) {
    const s = by.get(k) ?? 0;
    console.log(
      `    ${k.padEnd(15)} ${((s / total) * 100).toFixed(1).padStart(5)}%  ` +
        `${(s / 3600).toFixed(1).padStart(6)} h  n=${cnt.get(k) ?? 0}`,
    );
  }
}

console.log("");
console.log("--- pendingTools resolution rate (parent tool_results) ---");
console.log(`  parent tool_results replayed : ${parentToolResults}`);
console.log(`  resolved to a tool name      : ${resolvedToolResults}`);
console.log(
  `  unresolved (would print null): ${parentToolResults - resolvedToolResults}` +
    ` (${(((parentToolResults - resolvedToolResults) / parentToolResults) * 100).toFixed(4)}%)`,
);

await pool.end();
