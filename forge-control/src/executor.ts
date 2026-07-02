/**
 * Run executor — long-running process that drains the runs queue.
 *
 *  1. Atomically claim a queued run with `UPDATE ... WHERE status='queued'
 *     RETURNING ...` so only one executor wins.
 *  2. Pre-flight evaluateGuardrails (financial cap + runtime kill switch).
 *  3. Build a prompt from the existing thread (user/assistant turns).
 *  4. POST to claude-pool /v1/run with per-run timeout from metadata.timeout_ms.
 *  5. Append the assistant turn to thread, mark completed.
 *  6. On timeout: append a stuck_notice turn and mark 'stuck' (resumable via
 *     POST /chat/:id/resume). On other errors: mark 'failed'.
 *
 * Manager loop runs alongside, mirroring HCP messages → inbox AND ticking a
 * stuck-watchdog that flips stale 'running' rows to 'stuck'.
 *
 * Concurrency: a single executor instance; claude-pool itself shapes how many
 * concurrent Anthropic calls it allows. We poll every 1.5s when idle, and
 * immediately again after handling a run.
 */

import pg from "pg";
import { evaluateGuardrails } from "./db/autonomy.ts";
import { todaySpendRollup, recordSpend } from "./db/spend.ts";
import { claimDueReminders } from "./db/reminders.ts";
import {
  runClaudeCode,
  CcResumeError,
  type CcEvent,
} from "./lib/cc-runner.ts";
import {
  compressThread,
  emptyCompressorState,
  readCompressorState,
  type CompressorOptions,
} from "./lib/thread-compressor.ts";
import {
  prefetchMemoryForUserTurn,
  lastUserText,
} from "./lib/memory-prefetch.ts";
import { queueNotification } from "./db/notifications.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";
const POOL_URL = process.env.CLAUDE_POOL_URL ?? "http://127.0.0.1:8092";
const POOL_KEY = process.env.CLAUDE_POOL_API_KEY ?? "";
// v2.0: engine per run. 'claude-code' spawns the CC CLI (tools, sessions,
// streamed events); 'claude-pool' is the legacy text-only HTTP path.
// Per-run override via runs.metadata.engine.
const DEFAULT_ENGINE = process.env.EXECUTOR_ENGINE ?? "claude-code";
// USD→EUR for spend_log rows written from CC's total_cost_usd.
const USD_EUR = Number(process.env.CC_USD_EUR ?? "0.86");
const POLL_INTERVAL_MS = 1500;
// v1.6: default raised 180s → 600s. Per-run override via runs.metadata.timeout_ms.
const DEFAULT_RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? "600000");
const MIN_RUN_TIMEOUT_MS = 30_000;
const MAX_RUN_TIMEOUT_MS = 1_800_000;
// Stale-running watchdog: anything that hasn't heartbeat in this window flips to 'stuck'.
const HEARTBEAT_STUCK_THRESHOLD_MS = Number(
  process.env.HEARTBEAT_STUCK_THRESHOLD_MS ?? "90000",
);
const MAX_THREAD_CHARS = 24_000;

// v1.6 Tier-2 phase 1: trajectory compression.
// Ported from NousResearch/hermes-agent context_compressor.py — see
// forge-control/src/lib/thread-compressor.ts. Compresses runs.thread when it
// exceeds THREAD_COMPRESS_THRESHOLD_CHARS by replacing the middle window with
// an LLM-generated structured summary. Compression is in-memory only — the
// stored runs.thread keeps every original turn for UI rendering; only the
// prompt the model sees is shortened.
const THREAD_COMPRESS_THRESHOLD_CHARS = Number(
  process.env.THREAD_COMPRESS_THRESHOLD_CHARS ?? "80000",
);
const THREAD_COMPRESS_PROTECT_LAST_N = Number(
  process.env.THREAD_COMPRESS_PROTECT_LAST_N ?? "10",
);
const THREAD_COMPRESS_PROTECT_FIRST_N = Number(
  process.env.THREAD_COMPRESS_PROTECT_FIRST_N ?? "2",
);
const THREAD_COMPRESS_TAIL_RATIO = Number(
  process.env.THREAD_COMPRESS_TAIL_RATIO ?? "0.30",
);
const THREAD_COMPRESS_SUMMARY_BUDGET_CHARS = Number(
  process.env.THREAD_COMPRESS_SUMMARY_BUDGET_CHARS ?? "8000",
);
const THREAD_COMPRESS_TIMEOUT_MS = Number(
  process.env.THREAD_COMPRESS_TIMEOUT_MS ?? "60000",
);

if (!POOL_KEY) {
  console.warn(
    "[executor] CLAUDE_POOL_API_KEY is empty — runs will fail with 401",
  );
}

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[executor pool]", e.message));

export interface ThreadEntry {
  role: "user" | "assistant" | "system" | "tool" | "agent";
  content: string;
  ts: string;
  kind?: string;
  meta?: Record<string, unknown>;
}

interface ClaimedRun {
  id: string;
  title: string;
  thread: ThreadEntry[];
  metadata: Record<string, unknown>;
}

async function claimNextRun(): Promise<ClaimedRun | null> {
  // SKIP LOCKED so we never block on another executor's row.
  const r = await pool.query<ClaimedRun>(
    `WITH claimed AS (
       SELECT id
         FROM runs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
     )
     UPDATE runs r
        SET status = 'running',
            started_at = COALESCE(r.started_at, now()),
            last_heartbeat_at = now(),
            updated_at = now(),
            worker = COALESCE(r.worker, 'forge-executor')
       FROM claimed
       WHERE r.id = claimed.id
       RETURNING r.id::text, r.title, r.thread, r.metadata`,
  );
  return r.rows[0] ?? null;
}

function buildPromptFromThread(
  thread: ThreadEntry[],
  { assistantMarker = true }: { assistantMarker?: boolean } = {},
): string {
  // Compact transcript format claude-pool will handle as a single prompt.
  // We rely on claude-pool's underlying model to follow the role markers.
  // The CC engine reuses this (without the trailing completion marker) when
  // adopting a pool-era thread that has no CC session yet.
  const lines: string[] = [];
  let chars = 0;
  for (const e of thread) {
    if (chars > MAX_THREAD_CHARS) break;
    const tag =
      e.role === "user"
        ? "USER"
        : e.role === "assistant"
          ? "ASSISTANT"
          : e.role === "system"
            ? "SYSTEM"
            : e.role.toUpperCase();
    const text = String(e.content ?? "");
    const block = `[${tag}]\n${text}\n`;
    chars += block.length;
    lines.push(block);
  }
  if (assistantMarker) lines.push("[ASSISTANT]\n");
  return lines.join("\n");
}

/** Messages appended after the last engine output — what a resumed CC
 *  session needs to see (its own context carries the rest). */
function trailingUserBlock(thread: ThreadEntry[]): string {
  let lastEngineIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].role === "assistant" || thread[i].role === "tool") {
      lastEngineIdx = i;
      break;
    }
  }
  const tail = thread.slice(lastEngineIdx + 1);
  if (tail.length === 0) {
    // Shouldn't happen (a queued run always has a fresh user/system turn),
    // but never send an empty prompt.
    return "[SYSTEM]\nContinue.";
  }
  return tail
    .map((e) =>
      e.role === "system" ? `[SYSTEM]\n${e.content}` : String(e.content ?? ""),
    )
    .join("\n\n");
}

/**
 * Compress the thread in-memory before building the prompt sent to claude-pool.
 * Returns a single string ready for the `/v1/run` payload. The stored
 * `runs.thread` is NOT mutated — the live chat UI keeps every original turn.
 */
async function buildCompressedPrompt(
  runId: string,
  thread: ThreadEntry[],
  metadata: Record<string, unknown> | null | undefined,
): Promise<string> {
  const totalChars = thread.reduce(
    (n, e) => n + String(e.content ?? "").length + 16,
    0,
  );
  if (totalChars <= THREAD_COMPRESS_THRESHOLD_CHARS) {
    return buildPromptFromThread(thread);
  }

  // Iterative compression carries the previous summary across calls so
  // re-runs of the same long thread don't re-summarize identical content.
  const priorState = readCompressorState(metadata);

  const opt: CompressorOptions = {
    thresholdChars: THREAD_COMPRESS_THRESHOLD_CHARS,
    protectLastN: THREAD_COMPRESS_PROTECT_LAST_N,
    protectFirstN: THREAD_COMPRESS_PROTECT_FIRST_N,
    tailRatio: THREAD_COMPRESS_TAIL_RATIO,
    summaryBudgetChars: THREAD_COMPRESS_SUMMARY_BUDGET_CHARS,
    summarize: async (payload) => {
      try {
        return await callClaudePool(payload, THREAD_COMPRESS_TIMEOUT_MS);
      } catch (e) {
        console.warn(
          `[compressor] summarize call failed for run ${runId}:`,
          e instanceof Error ? e.message : e,
        );
        return null;
      }
    },
  };

  const t0 = Date.now();
  const result = await compressThread(thread, priorState, opt);
  const ms = Date.now() - t0;

  if (result.compressed) {
    console.log(
      `[compressor] run ${runId}: collapsed ${result.collapsedCount} turns, ` +
        `saved ${result.charsSaved}ch (${totalChars} → ${totalChars - result.charsSaved}) in ${ms}ms`,
    );
    // Persist updated state so the next pass uses iterative-update mode.
    await pool
      .query(
        `UPDATE runs
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('compression_state', $2::jsonb),
                updated_at = now()
          WHERE id = $1`,
        [runId, JSON.stringify(result.state)],
      )
      .catch((e) =>
        console.warn(
          `[compressor] failed to persist compression_state: ${e.message}`,
        ),
      );
  }

  return buildPromptFromThread(result.thread);
}

function getTimeoutFor(
  metadata: Record<string, unknown> | null | undefined,
): number {
  const raw = Number(
    (metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).timeout_ms
      : undefined) ?? DEFAULT_RUN_TIMEOUT_MS,
  );
  if (!Number.isFinite(raw)) return DEFAULT_RUN_TIMEOUT_MS;
  return Math.max(MIN_RUN_TIMEOUT_MS, Math.min(MAX_RUN_TIMEOUT_MS, raw));
}

async function callClaudePool(
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs + 5_000);
  try {
    const res = await fetch(`${POOL_URL}/v1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": POOL_KEY,
      },
      body: JSON.stringify({ prompt, timeout_ms: timeoutMs }),
      signal: ac.signal,
    });
    const j = (await res.json().catch(() => ({}))) as {
      text?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(
        `pool ${res.status}: ${j.error ?? res.statusText ?? "unknown"}`,
      );
    }
    if (typeof j.text !== "string") {
      throw new Error("pool returned no text field");
    }
    return j.text;
  } finally {
    clearTimeout(timer);
  }
}

async function completeRun(
  id: string,
  entry: ThreadEntry | null,
  status: "completed" | "failed" | "stuck",
  stuckSignal: string | null = null,
): Promise<void> {
  // 'stuck' is a resumable terminal — leave completed_at NULL so the UI can
  // still distinguish "ended" runs from a parked one. failed/completed write
  // completed_at = now(). Split into two queries because Postgres can't
  // reconcile the status-enum binding when $3 is also referenced via $3::text
  // in a CASE expression (deduces conflicting types for the parameter).
  // entry === null: the CC engine already streamed its turns into the
  // thread — only flip status.
  const threadConcat = entry ? `thread = thread || $2::jsonb,` : "";
  const params: unknown[] = entry ? [id, JSON.stringify([entry])] : [id];
  if (status === "stuck") {
    params.push(status, stuckSignal);
    await pool.query(
      `UPDATE runs
          SET ${threadConcat}
              status = $${params.length - 1},
              stuck_signal = $${params.length},
              updated_at = now(),
              last_heartbeat_at = now()
        WHERE id = $1`,
      params,
    );
  } else {
    params.push(status);
    await pool.query(
      `UPDATE runs
          SET ${threadConcat}
              status = $${params.length},
              stuck_signal = NULL,
              completed_at = now(),
              updated_at = now(),
              last_heartbeat_at = now()
        WHERE id = $1`,
      params,
    );
  }
}

/**
 * v2.2: push run outcomes to Telegram. Only runs born on a push channel
 * (telegram) or from a schedule (cron) notify; web chats have the live SSE
 * stream. A cron run whose final text starts with [SILENT] stays quiet —
 * that's how the hourly watchdog avoids 24 "all clear" pings a day.
 * Never throws: a lost push must not fail the run.
 */
async function notifyRunOutcome(
  run: { id: string; title: string; metadata: Record<string, unknown> },
  status: "completed" | "failed" | "stuck",
  text: string | null,
): Promise<void> {
  const source = String(run.metadata?.source ?? "");
  if (source !== "telegram" && source !== "cron") return;
  const body = (text ?? "").trim();
  if (status === "completed" && /^\s*\[SILENT\]/i.test(body)) return;

  let msg: string;
  if (status === "completed") {
    msg =
      source === "cron"
        ? `🤖 ${run.title}\n\n${body || "(no output)"}`
        : body || "(no output)";
  } else {
    const what = status === "stuck" ? "got stuck (resumable)" : "failed";
    msg = `⚠️ ${source === "cron" ? run.title : "your request"} ${what}${body ? `:\n${body.slice(0, 500)}` : ""}`;
  }
  await queueNotification(msg, `run:${source}`);
}

/** Append a thread entry without touching status (streamed CC events). */
async function appendThreadEntry(id: string, entry: ThreadEntry): Promise<void> {
  await pool.query(
    `UPDATE runs
        SET thread = thread || $2::jsonb,
            updated_at = now(),
            last_heartbeat_at = now()
      WHERE id = $1`,
    [id, JSON.stringify([entry])],
  );
}

async function saveCcSession(id: string, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE runs
        SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                       jsonb_build_object('cc_session_id', $2::text, 'engine', 'claude-code'),
            updated_at = now()
      WHERE id = $1`,
    [id, sessionId],
  );
}

async function addRunSpend(id: string, usd: number): Promise<void> {
  await pool.query(
    `UPDATE runs SET spent_usd = COALESCE(spent_usd, 0) + $2, updated_at = now()
      WHERE id = $1`,
    [id, usd],
  );
}

async function getRunStatus(id: string): Promise<string | null> {
  const r = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE id = $1",
    [id],
  );
  return r.rows[0]?.status ?? null;
}

async function heartbeat(id: string): Promise<void> {
  await pool
    .query(
      `UPDATE runs SET last_heartbeat_at = now() WHERE id = $1 AND status = 'running'`,
      [id],
    )
    .catch((e) => console.error("[executor heartbeat]", e.message));
}

async function processRun(run: ClaimedRun): Promise<void> {
  console.log(`[executor] claimed run ${run.id} (${run.title.slice(0, 60)})`);

  // Guardrail pre-flight: spend cap + runtime kill switch on the chat path.
  // Rough thread-char → EUR estimate so spend.per_run_cap can bite before a
  // long burn (real spend is recorded by claude-pool; this is preemptive).
  const threadChars = (run.thread ?? []).reduce(
    (n, e) => n + String(e.content ?? "").length,
    0,
  );
  const estSpendEur = Math.max(0.01, (threadChars / 1000) * 0.04);
  // v1.9: today's actual rolled-up spend from spend_log so the
  // spend.daily_cap guardrail can finally trip when it should. Failures
  // here MUST NOT block the run — fall back to estimating from this turn
  // alone if the rollup query fails.
  const dailySpendEur = await todaySpendRollup()
    .then((r) => r.total_eur + estSpendEur)
    .catch(() => estSpendEur);
  const guard = await evaluateGuardrails({
    agent: "forge-executor",
    action: "claude-pool.run",
    category: "financial",
    payload: {
      run_id: run.id,
      spend_eur: estSpendEur,
      daily_spend_eur: dailySpendEur,
      thread_chars: threadChars,
      bypass_blanket: true,
    },
  }).catch((e) => {
    console.error("[executor guardrails]", e instanceof Error ? e.message : e);
    return { allow: true } as { allow: true };
  });
  if (!guard.allow) {
    console.warn(
      `[executor] run ${run.id} blocked by ${guard.blocked_by}: ${guard.reason}`,
    );
    await completeRun(
      run.id,
      {
        role: "system",
        content: `Run blocked: ${guard.rule_label} — ${guard.reason}`,
        ts: new Date().toISOString(),
        kind: "error",
        meta: {
          blocked_by: guard.blocked_by,
          rule_label: guard.rule_label,
          trip_id: guard.trip_id,
        },
      },
      "failed",
    );
    return;
  }

  // v1.6 Tier-2 phase 3: prefetch memory hits relevant to the latest user
  // turn and prepend a [MEMORY] block to the prompt. No-op if disabled, the
  // query is too short, the search errors, or no hits land.
  const userText = lastUserText(run.thread ?? []);
  const memory = userText
    ? await prefetchMemoryForUserTurn(userText)
    : { hits: [], block: null };
  if (memory.hits.length > 0) {
    const vector = memory.hits.filter((h) => h.via === "vector").length;
    const graph = memory.hits.length - vector;
    console.log(
      `[executor] run ${run.id}: memory prefetch ${memory.hits.length} hits ` +
        `(${vector} vector + ${graph} graph)`,
    );
  }

  const engine = String(run.metadata?.engine ?? DEFAULT_ENGINE);
  const timeoutMs = getTimeoutFor(run.metadata);
  const hb = setInterval(() => heartbeat(run.id), 5_000);
  try {
    if (engine === "claude-code") {
      await processWithClaudeCode(run, memory.block, timeoutMs);
    } else {
      const baseCompressed = await buildCompressedPrompt(
        run.id,
        run.thread ?? [],
        run.metadata,
      );
      const prompt = memory.block
        ? `${memory.block}${baseCompressed}`
        : baseCompressed;
      const t0 = Date.now();
      const text = await callClaudePool(prompt, timeoutMs);
      const ms = Date.now() - t0;
      console.log(`[executor] run ${run.id} ok in ${ms}ms (${text.length}ch)`);
      await completeRun(
        run.id,
        {
          role: "assistant",
          content: text,
          ts: new Date().toISOString(),
          kind: "text",
          meta: {
            provider: "claude-pool",
            duration_ms: ms,
            timeout_ms: timeoutMs,
          },
        },
        "completed",
      );
      await notifyRunOutcome(run, "completed", text);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The user cancelled/paused mid-run — the engine was killed on purpose.
    // Leave their chosen status alone; just leave a marker in the thread.
    if (msg.includes("run cancelled")) {
      console.log(`[executor] run ${run.id} cancelled mid-flight`);
      await appendThreadEntry(run.id, {
        role: "system",
        content: "Run stopped — engine process terminated.",
        ts: new Date().toISOString(),
        kind: "text",
        meta: { cancelled: true },
      }).catch(() => {});
      return;
    }
    const isTimeout =
      msg.includes("timed out") ||
      msg.includes("AbortError") ||
      msg.includes("aborted") ||
      msg.includes("timeout");
    if (isTimeout) {
      console.warn(
        `[executor] run ${run.id} timed out after ${timeoutMs}ms — marking stuck`,
      );
      await completeRun(
        run.id,
        {
          role: "system",
          content: `Timed out after ${Math.round(
            timeoutMs / 1000,
          )}s. Use Resume to continue from this point.`,
          ts: new Date().toISOString(),
          kind: "stuck_notice",
          meta: { error: msg, timeout_ms: timeoutMs },
        },
        "stuck",
        "timeout",
      );
      await notifyRunOutcome(run, "stuck", `timed out after ${Math.round(timeoutMs / 1000)}s`);
    } else {
      console.error(`[executor] run ${run.id} failed: ${msg}`);
      await completeRun(
        run.id,
        {
          role: "system",
          content: `Executor failed: ${msg}`,
          ts: new Date().toISOString(),
          kind: "error",
          meta: { error: msg, engine },
        },
        "failed",
      );
      await notifyRunOutcome(run, "failed", msg);
    }
  } finally {
    clearInterval(hb);
  }
}

/* ============================================================================
 * Claude Code engine — CLAUDE-DESIGN-BRIEF.md §20 step 2, finally real.
 * Streams tool calls + interim text into runs.thread as they happen; keeps
 * a CC session per run so follow-up turns resume with full agent context.
 * ========================================================================== */

const INPUT_PREVIEW_CHARS = 1_500;
const RESULT_PREVIEW_CHARS = 2_500;

function toolCallEntry(e: CcEvent): ThreadEntry {
  let inputStr = "";
  try {
    inputStr = JSON.stringify(e.toolInput ?? {});
  } catch {
    inputStr = String(e.toolInput);
  }
  if (inputStr.length > INPUT_PREVIEW_CHARS) {
    inputStr = inputStr.slice(0, INPUT_PREVIEW_CHARS) + "…";
  }
  return {
    role: "tool",
    content: `${e.toolName ?? "tool"} ${inputStr}`,
    ts: new Date().toISOString(),
    kind: "tool_call",
    meta: {
      tool_use_id: e.toolUseId,
      tool: e.toolName,
      input: inputStr,
    },
  };
}

function toolResultEntry(e: CcEvent): ThreadEntry {
  let text = e.text ?? "";
  if (text.length > RESULT_PREVIEW_CHARS) {
    text = text.slice(0, RESULT_PREVIEW_CHARS) + `\n… [truncated]`;
  }
  return {
    role: "tool",
    content: text,
    ts: new Date().toISOString(),
    kind: "tool_result",
    meta: { tool_use_id: e.toolUseId, is_error: e.isError === true },
  };
}

async function processWithClaudeCode(
  run: ClaimedRun,
  memoryBlock: string | null,
  timeoutMs: number,
): Promise<void> {
  const thread = run.thread ?? [];
  const priorSession =
    typeof run.metadata?.cc_session_id === "string"
      ? (run.metadata.cc_session_id as string)
      : null;
  const model =
    typeof run.metadata?.model === "string"
      ? (run.metadata.model as string)
      : null;

  const baseMessage = priorSession
    ? trailingUserBlock(thread)
    : buildPromptFromThread(thread, { assistantMarker: false });
  // v2.2: turns born on Telegram land on Konrad's phone — tell the engine so
  // it keeps the final reply short (the system prompt carries the details).
  const sourceHint =
    String(run.metadata?.source ?? "") === "telegram"
      ? "[SYSTEM] This turn came from Telegram. Final reply goes to Konrad's phone: keep it under ~1200 chars, plain text, front-load the answer.\n\n"
      : "";
  const message = `${memoryBlock ?? ""}${sourceHint}${baseMessage}`;

  // Serialize streamed appends so thread order matches event order.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => {
      console.error(
        `[executor] run ${run.id} stream append failed:`,
        e instanceof Error ? e.message : e,
      );
    });
  };

  const onEvent = (e: CcEvent) => {
    if (e.type === "init" && e.sessionId) {
      const sid = e.sessionId;
      enqueue(() => saveCcSession(run.id, sid));
    } else if (e.type === "assistant_text" && e.text) {
      const entry: ThreadEntry = {
        role: "assistant",
        content: e.text,
        ts: new Date().toISOString(),
        kind: "text",
        meta: { provider: "claude-code" },
      };
      enqueue(() => appendThreadEntry(run.id, entry));
    } else if (e.type === "tool_call") {
      const entry = toolCallEntry(e);
      enqueue(() => appendThreadEntry(run.id, entry));
    } else if (e.type === "tool_result") {
      const entry = toolResultEntry(e);
      enqueue(() => appendThreadEntry(run.id, entry));
    }
  };

  const isCancelled = async () => {
    const status = await getRunStatus(run.id).catch(() => null);
    return status === "cancelled" || status === "paused";
  };

  let result;
  try {
    result = await runClaudeCode({
      prompt: message,
      sessionId: priorSession,
      timeoutMs,
      model,
      onEvent,
      isCancelled,
    });
  } catch (err) {
    if (err instanceof CcResumeError) {
      // Session file evaporated (CC upgrade, cleanup). Retry ONCE with the
      // full transcript so no context is silently lost — and say so loudly.
      console.warn(`[executor] run ${run.id}: ${err.message} — retrying fresh`);
      await appendThreadEntry(run.id, {
        role: "system",
        content:
          "Engine session expired — restarted with full transcript context.",
        ts: new Date().toISOString(),
        kind: "text",
        meta: { resume_miss: true },
      });
      const fullMessage = buildPromptFromThread(thread, {
        assistantMarker: false,
      });
      result = await runClaudeCode({
        prompt: memoryBlock ? `${memoryBlock}${fullMessage}` : fullMessage,
        sessionId: null,
        timeoutMs,
        model,
        onEvent,
        isCancelled,
      });
    } else {
      await chain; // flush whatever streamed before the failure
      throw err;
    }
  }

  await chain; // all streamed entries persisted, in order

  // The final assistant message already arrived via assistant_text events;
  // only fall back to result.text if the stream somehow produced none.
  const finalEntry: ThreadEntry | null =
    result.assistantTextEvents === 0 && result.text
      ? {
          role: "assistant",
          content: result.text,
          ts: new Date().toISOString(),
          kind: "text",
          meta: { provider: "claude-code", from_result: true },
        }
      : null;

  if (result.sessionId) {
    await saveCcSession(run.id, result.sessionId).catch((e) =>
      console.warn(`[executor] save session failed: ${e.message}`),
    );
  }
  if (result.costUsd > 0) {
    await addRunSpend(run.id, result.costUsd).catch(() => {});
    await recordSpend([
      {
        provider: "claude-code",
        kind: "llm_output",
        amount_eur: result.costUsd * USD_EUR,
        job_id: null,
        units: result.numTurns,
        meta: { run_id: run.id, usd: result.costUsd },
      },
    ]).catch((e) =>
      console.warn(`[executor] spend_log write failed: ${e.message}`),
    );
  }

  console.log(
    `[executor] run ${run.id} ok via claude-code in ${result.durationMs}ms ` +
      `(${result.numTurns} turns, $${result.costUsd.toFixed(4)})`,
  );
  await completeRun(run.id, finalEntry, "completed");
  await notifyRunOutcome(
    run,
    "completed",
    result.text || finalEntry?.content || null,
  );
}

let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

async function isFleetPaused(): Promise<boolean> {
  try {
    const r = await pool.query<{ status: string }>(
      "SELECT status FROM fleet_state WHERE id = 1 LIMIT 1",
    );
    return r.rows[0]?.status === "paused";
  } catch {
    return false;
  }
}

/* Flip 'running' rows that haven't heartbeat in HEARTBEAT_STUCK_THRESHOLD_MS
 * to 'stuck' so the manager loop / UI can surface them. Idempotent. */
async function stuckWatchdogTick(): Promise<void> {
  try {
    const r = await pool.query<{ id: string }>(
      `UPDATE runs
          SET status = 'stuck',
              stuck_signal = COALESCE(stuck_signal, 'heartbeat_stale'),
              updated_at = now()
        WHERE status = 'running'
          AND last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at < now() - (interval '1 millisecond' * $1)
        RETURNING id::text`,
      [HEARTBEAT_STUCK_THRESHOLD_MS],
    );
    if (r.rowCount && r.rowCount > 0) {
      console.warn(
        `[watchdog] flipped ${r.rowCount} stale 'running' run(s) to 'stuck' (heartbeat > ${HEARTBEAT_STUCK_THRESHOLD_MS}ms)`,
      );
    }
  } catch (e) {
    console.error(
      "[watchdog] tick failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

async function loop(): Promise<void> {
  console.log(
    `[executor] starting · pool=${POOL_URL} · keylen=${POOL_KEY.length}`,
  );
  let lastPauseLogAt = 0;
  while (running) {
    try {
      if (await isFleetPaused()) {
        const now = Date.now();
        if (now - lastPauseLogAt > 5 * 60 * 1000) {
          console.log(
            "[executor] fleet_state=paused — holding run queue (Personal AI OS FREEZE active).",
          );
          lastPauseLogAt = now;
        }
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      const run = await claimNextRun();
      if (run) {
        await processRun(run);
        continue; // poll immediately for more work
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[executor] claim cycle failed:", msg);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log("[executor] shutting down");
  await pool.end().catch(() => {});
}

/* ============================================================================
 * Manager loop — mirror HCP ESCALATE/APPROVAL_REQUEST messages into inbox_items
 * so the user sees them on the Inbox surface. Dedupe by inbox_items.external_id
 * = 'hcp:' || agent_message.id (migration 0022).
 * ========================================================================== */

const HCP_URL =
  process.env.HCP_DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/hcp";

const hcp = new Pool({
  connectionString: HCP_URL,
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
hcp.on("error", (e) => console.error("[manager hcp pool]", e.message));

interface EscalateBody {
  reason?: string;
  summary?: string;
  request?: string;
  detail?: string;
  attempts?: string[];
  recommendation?: string;
  [k: string]: unknown;
}

interface AgentMessageRow {
  id: string;
  ts: string;
  sender_id: string;
  intent: string;
  body: EscalateBody;
}

function pickTitle(b: EscalateBody): string {
  // Try shape-specific titles in priority order. ANOMALY shape has rule+
  // description; APPROVAL_REQUEST from CF has a literal title; ESCALATE has
  // summary or reason. Fall back to first line of whatever is there.
  const raw =
    (b.title as string | undefined) ??
    (b.summary as string | undefined) ??
    (b.description as string | undefined) ??
    (b.reason as string | undefined) ??
    (b.rule as string | undefined) ??
    (b.detail as string | undefined) ??
    (b.request as string | undefined) ??
    (b.kind as string | undefined) ??
    JSON.stringify(b).slice(0, 200);
  return String(raw).split("\n")[0].slice(0, 120);
}

function pickAsk(b: EscalateBody): string {
  const parts: string[] = [];
  // Lead with whichever long-form description exists.
  if (b.description) parts.push(String(b.description));
  else if (b.reason) parts.push(String(b.reason));
  if (b.detail && b.detail !== b.reason && b.detail !== b.description)
    parts.push(String(b.detail));
  // For CF state-change approvals, summarise the transition.
  if (b.kind && b.toStatus) {
    const from = b.fromStatus ? String(b.fromStatus) : "?";
    const to = String(b.toStatus);
    parts.push(`State change: ${from} → ${to}`);
    if (b.format) parts.push(`Format: ${String(b.format)}`);
  }
  // ANOMALY evidence.
  if (b.evidence && typeof b.evidence === "object") {
    const ev = b.evidence as Record<string, unknown>;
    const evLines = Object.entries(ev)
      .slice(0, 6)
      .map(
        ([k, v]) => `· ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      );
    if (evLines.length > 0) parts.push("Evidence:\n" + evLines.join("\n"));
  }
  if (b.recommendation)
    parts.push(`Recommendation: ${String(b.recommendation)}`);
  return parts.join("\n\n") || JSON.stringify(b).slice(0, 600);
}

function pickTried(b: EscalateBody) {
  if (!Array.isArray(b.attempts)) return [];
  return b.attempts.slice(0, 6).map((a) => ({
    icon: "history",
    text: String(a).slice(0, 280),
  }));
}

function actionsFor(intent: string): unknown[] {
  if (intent === "APPROVAL_REQUEST") {
    return [
      { label: "Approve", variant: "ok", action_id: "approve" },
      { label: "Deny", variant: "danger", action_id: "deny" },
    ];
  }
  return [
    { label: "Acknowledge", variant: "neutral", action_id: "ack" },
    { label: "Resolve", variant: "ok", action_id: "resolve" },
  ];
}

function inboxStatusFor(intent: string): string {
  if (intent === "APPROVAL_REQUEST") return "APPROVE";
  if (intent === "ANOMALY") return "BLEED";
  return "STUCK";
}

function inboxTypeFor(intent: string): string {
  if (intent === "APPROVAL_REQUEST") return "APPROVAL";
  if (intent === "ANOMALY") return "ANOMALY";
  return "ESCALATION";
}

async function fetchUnmirrored(): Promise<AgentMessageRow[]> {
  // Last 24h of ESCALATE/APPROVAL_REQUEST/ANOMALY messages; we filter mirrored
  // ones below by looking them up in inbox_items.external_id.
  // 7-day window — Hermes can go quiet over a weekend; we still want the
  // user to see open escalations when they wake the OS up after a break.
  const r = await hcp.query<AgentMessageRow>(
    `SELECT id::text, ts::text, sender_id, intent::text AS intent, body
       FROM agent_message
       WHERE intent IN ('ESCALATE','APPROVAL_REQUEST','ANOMALY')
         AND ts > now() - interval '7 days'
       ORDER BY ts DESC
       LIMIT 80`,
  );
  return r.rows;
}

async function alreadyMirrored(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const externals = ids.map((id) => `hcp:${id}`);
  const r = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM inbox_items WHERE external_id = ANY($1::text[])`,
    [externals],
  );
  return new Set(r.rows.map((row) => row.external_id.replace(/^hcp:/, "")));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pull a content_jobs UUID out of a Hermes message body. cf-worker sends
 *  `cfJobId`; other senders may send `jobId` / `job_id`. Returns null if no
 *  valid UUID is found — the inbox row just won't have a job preview. */
function pickRelatedJobId(b: EscalateBody): string | null {
  const raw =
    (b.cfJobId as string | undefined) ??
    (b.jobId as string | undefined) ??
    (b.job_id as string | undefined) ??
    null;
  if (!raw) return null;
  const s = String(raw).trim();
  return UUID_RE.test(s) ? s : null;
}

async function createInboxFromMessage(m: AgentMessageRow): Promise<void> {
  const body = m.body ?? {};
  await pool.query(
    `INSERT INTO inbox_items
       (type, status, title, ask, tried, actions, source, external_id,
        related_job_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::uuid)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING`,
    [
      inboxTypeFor(m.intent),
      inboxStatusFor(m.intent),
      pickTitle(body),
      pickAsk(body),
      JSON.stringify(pickTried(body)),
      JSON.stringify(actionsFor(m.intent)),
      `hermes:${m.sender_id}`,
      `hcp:${m.id}`,
      pickRelatedJobId(body),
    ],
  );
}

async function managerTick(): Promise<void> {
  try {
    const recent = await fetchUnmirrored();
    if (recent.length === 0) return;
    const mirrored = await alreadyMirrored(recent.map((m) => m.id));
    const fresh = recent.filter((m) => !mirrored.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) {
      try {
        await createInboxFromMessage(m);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Unique violation = race with another mirror cycle — ignore.
        if (!msg.includes("inbox_items_external_id_uniq")) {
          console.error(`[manager] mirror ${m.id} failed:`, msg);
        }
      }
    }
    console.log(`[manager] mirrored ${fresh.length} hcp messages → inbox`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[manager] tick failed:", msg);
  }
}

/* v2.0: deliver due reminders into the inbox. Recurrence is advanced by
 * claimDueReminders; external_id includes the due timestamp so a daily
 * reminder can mirror once per firing. */
async function reminderTick(): Promise<void> {
  try {
    const due = await claimDueReminders();
    for (const rem of due) {
      const dueLocal = new Date(rem.due_at).toLocaleString("de-DE", {
        timeZone: process.env.REMINDER_TZ ?? "Europe/Berlin",
        dateStyle: "medium",
        timeStyle: "short",
      });
      await pool
        .query(
          `INSERT INTO inbox_items
             (type, status, title, ask, tried, actions, source, external_id)
           VALUES ('REMINDER', 'DECIDE', $1, $2, '[]'::jsonb, $3::jsonb,
                   'reminders', $4)
           ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING`,
          [
            rem.text.slice(0, 120),
            `Reminder — due ${dueLocal}${rem.recur ? ` (repeats ${rem.recur})` : ""}`,
            JSON.stringify([
              { label: "Done", variant: "ok", action_id: "resolve" },
            ]),
            `reminder:${rem.id}:${rem.due_at}`,
          ],
        )
        .catch((e) =>
          console.error(`[reminders] inbox insert failed: ${e.message}`),
        );
      // v2.2: reminders also push to Telegram — the inbox is where they're
      // tracked, the phone is where they're actually seen.
      await queueNotification(
        `⏰ ${rem.text}${rem.recur ? ` (repeats ${rem.recur})` : ""}`,
        "reminder",
      );
    }
    if (due.length > 0) {
      console.log(`[reminders] delivered ${due.length} reminder(s) → inbox`);
    }
  } catch (e) {
    console.error(
      "[reminders] tick failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

async function managerLoop(): Promise<void> {
  console.log(`[manager] starting · hcp=${HCP_URL.replace(/:.+@/, ":***@")}`);
  // Stagger first tick to avoid hammering the DB at startup with the executor.
  await new Promise((r) => setTimeout(r, 4_000));
  while (running) {
    await managerTick();
    await stuckWatchdogTick();
    await reminderTick();
    await new Promise((r) => setTimeout(r, 10_000));
  }
  await hcp.end().catch(() => {});
}

Promise.all([loop(), managerLoop()]).catch((e) => {
  console.error("[executor] fatal:", e);
  process.exit(1);
});
