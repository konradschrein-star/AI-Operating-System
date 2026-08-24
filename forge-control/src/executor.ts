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
import { engineForModel, resumableSession } from "./lib/engine-session.ts";
import { isGeminiModel } from "./lib/gemini-runner.ts";
import { ingestEvent, finalizeRollup } from "./lib/run-rollup.ts";
import {
  resolveAccount,
  resolveFailoverAccount,
  recordRunOutcome,
} from "./lib/accounts.ts";
import {
  compressThread,
  emptyCompressorState,
  readCompressorState,
  type CompressorOptions,
} from "./lib/thread-compressor.ts";
import { prefetchMemoryForUserTurn } from "./lib/memory-prefetch.ts";
import { queueNotification } from "./db/notifications.ts";
import { reminderCardTitle, reminderCardAsk } from "./lib/reminder-text.ts";
import { projectTick } from "./lib/project-tick.ts";
// The completion decision is NOT re-derived here: route and executor import the
// same pure rule so the two can never drift (06 C5, 07 §5/§6).
import { completionTransition } from "./lib/run-control-rules.ts";

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
/* The ONE value that routes a run to the legacy text-only HTTP pool.
 *
 * This used to be expressed the other way round — `engine === "claude-code"`
 * took the CLI branch and *everything else* fell through to the pool. That
 * inverted default is what broke Gemini (2026-08-24). `saveCcSession` stamps
 * the producing engine into `metadata.engine` and for a Gemini run that value
 * is "agy" — so from turn two onward a Gemini chat matched "everything else"
 * and was posted to the Claude pool over HTTP. Under 10k chars it answered as
 * Claude while the row still read `agy`; over 10k it died with the error
 * Konrad kept seeing:
 *
 *     [executor] run a5b13a04-… failed: pool 400: Invalid request
 *
 * An engine name we do not recognise must never silently become "post the
 * whole thread to Claude". Only the explicit legacy value goes there; the
 * unknown case takes the CLI path, where the model id decides Claude vs
 * Gemini and an unroutable model fails loudly. */
const LEGACY_POOL_ENGINE = "claude-pool";
// The deployed pool rejects an oversize `prompt` with 400 rather than
// truncating. See the clamp at callClaudePool for why we do it ourselves.
const POOL_MAX_PROMPT_CHARS = Number(
  process.env.POOL_MAX_PROMPT_CHARS ?? "180000",
);
// `timeout_ms` is bounded at 600s by the pool's schema while MAX_RUN_TIMEOUT_MS
// here is 1800s — the overlap is a 400, so clamp on the way out.
const POOL_MAX_TIMEOUT_MS = Number(
  process.env.POOL_MAX_TIMEOUT_MS ?? "600000",
);
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
// Ceiling for the exponential re-queue backoff applied when another engine
// process still owns a run's session (migration 0036, failure mode E10).
const SESSION_WAIT_MAX_BACKOFF_S = 60;

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
  // wake_after (migration 0036) parks a re-queued run for a backoff interval;
  // until it passes, the run is queued but not claimable. Cleared on claim so
  // it never delays a later turn of the same run.
  // pending_input is cleared here too (07 §5, the belt to E2's braces): a
  // claimed run has consumed its pending input by definition — the tail of its
  // thread goes into this very prompt — so leaving the flag set would requeue
  // it a second time at the end of the turn.
  const r = await pool.query<ClaimedRun>(
    `WITH claimed AS (
       SELECT id
         FROM runs
         WHERE status = 'queued'
           AND (wake_after IS NULL OR wake_after <= now())
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
     )
     UPDATE runs r
        SET status = 'running',
            started_at = COALESCE(r.started_at, now()),
            last_heartbeat_at = now(),
            wake_after = NULL,
            metadata = COALESCE(r.metadata, '{}'::jsonb) - 'pending_input',
            updated_at = now(),
            worker = COALESCE(r.worker, 'forge-executor')
       FROM claimed
       WHERE r.id = claimed.id
       RETURNING r.id::text, r.title, r.thread, r.metadata`,
  );
  return r.rows[0] ?? null;
}

/**
 * Hand a duplicate claim back to the turn that is already running.
 *
 * claimNextRun() has just flipped the row to `running` and STRIPPED
 * `pending_input` (its own comment explains why: a claimed run has consumed its
 * input). For a duplicate claim both of those are wrong — the live process
 * never saw this input — so the flag goes straight back. Status is left
 * `running` because that is now true again and the live process owns the row.
 *
 * Deliberately unguarded on status: the row is `running` because we just made
 * it so, one statement ago, and narrowing the WHERE would only add a way for
 * this to silently do nothing.
 */
async function deferDuplicateClaim(id: string): Promise<void> {
  await pool.query(
    `UPDATE runs
        SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"pending_input":true}'::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [id],
  );
}

/**
 * The other half of deferDuplicateClaim: requeue a run that is still carrying
 * an unread `pending_input` after its live turn ended.
 *
 * Both terms are load-bearing. `pending_input = 'true'` means E2 never consumed
 * it (E2 clears the flag in the same statement it requeues), and the status
 * filter means we only act on a row nobody else is driving — a `queued` row is
 * already on its way and a `completed` one belongs to the stranded-input sweep.
 * A run that ended `failed` or `stuck` keeps its input for a human, since
 * requeueing into a failure loop is how a bad turn becomes an expensive one.
 */
async function requeueIfTurnStillOwed(id: string): Promise<void> {
  const r = await pool.query(
    `UPDATE runs
        SET status = 'queued',
            completed_at = NULL,
            wake_after = NULL,
            metadata = metadata - 'pending_input',
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND metadata->>'pending_input' = 'true'`,
    [id],
  );
  if ((r.rowCount ?? 0) > 0) {
    console.log(
      `[executor] run ${id}: deferred turn re-queued — its live turn ended without reading pending_input`,
    );
  }
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

/* The pool validates before it runs, and a violation is a 400 — not a clamp.
 *
 * Both of its bounds are reachable from here. `timeout_ms` is capped at 600s
 * upstream while MAX_RUN_TIMEOUT_MS is 1800s, so a long-timeout run is
 * rejected outright. `prompt` is capped by length, and the compressor cannot
 * promise a ceiling: it protects the last N turns verbatim, so a thread whose
 * tail alone is huge comes back over the line.
 *
 * A 400 here is the worst possible shape of failure. It surfaces to Konrad as
 * `pool 400: Invalid request` — no clue that the cause is size — and it takes
 * the compressor's own summarize call down with it, so the one mechanism that
 * would have shrunk the prompt fails first and silently falls back to
 * deterministic truncation. Clamp to the contract, log what was dropped. */
function clampForPool(prompt: string): string {
  if (prompt.length <= POOL_MAX_PROMPT_CHARS) return prompt;
  // Keep both ends: the head carries the system framing, the tail the actual
  // question. The middle is what compression would have collapsed anyway.
  const keep = POOL_MAX_PROMPT_CHARS - 200;
  const head = Math.floor(keep * 0.3);
  const tail = keep - head;
  const dropped = prompt.length - keep;
  console.warn(
    `[executor] pool prompt clamped: ${prompt.length}ch > ${POOL_MAX_PROMPT_CHARS}ch, dropped ${dropped}ch from the middle`,
  );
  return (
    prompt.slice(0, head) +
    `\n\n[… ${dropped} characters elided to fit the pool's ${POOL_MAX_PROMPT_CHARS}-character limit …]\n\n` +
    prompt.slice(prompt.length - tail)
  );
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
      body: JSON.stringify({
        prompt: clampForPool(prompt),
        // The pool's own ceiling. Sending more is a 400, not a longer run.
        timeout_ms: Math.min(timeoutMs, POOL_MAX_TIMEOUT_MS),
      }),
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

/**
 * What the completion write actually did.
 *
 * `applied: false` means the row was NOT ours to finish — an operator's
 * stop/terminate landed in the window between the child's last event and this
 * write (07 §6). Callers MUST then skip notifyRunOutcome: a run Konrad
 * terminated does not push a "completed" notification.
 *
 * `requeued: true` means the run is not finished at all — it consumed a
 * pending message and goes back to `queued` for one more turn (07 §5).
 * Callers skip notifyRunOutcome for that too.
 */
interface CompletionWrite {
  applied: boolean;
  requeued: boolean;
}

async function completeRun(
  id: string,
  entry: ThreadEntry | null,
  status: "completed" | "failed" | "stuck",
  stuckSignal: string | null = null,
  opts: { guardRunning?: boolean } = {},
): Promise<CompletionWrite> {
  // 'stuck' is a resumable terminal — leave completed_at NULL so the UI can
  // still distinguish "ended" runs from a parked one. failed/completed write
  // completed_at = now(). Split into two queries because Postgres can't
  // reconcile the status-enum binding when $3 is also referenced via $3::text
  // in a CASE expression (deduces conflicting types for the parameter).
  // entry === null: the CC engine already streamed its turns into the
  // thread — only flip status.
  //
  // guardRunning (07 §6, C13): the control-plane path carries its precondition
  // into SQL. `AND status = 'running'` makes an operator's paused/cancelled
  // win the race with a clean exit, and the RETURNING clause hands the
  // handshake flag (07 §5) to completionTransition in the same round trip.
  const threadConcat = entry ? `thread = thread || $2::jsonb,` : "";
  const guard = opts.guardRunning ? `\n           AND status = 'running'` : "";
  const returning = opts.guardRunning
    ? `\n      RETURNING status, metadata->>'pending_input' AS pending_input`
    : "";
  const params: unknown[] = entry ? [id, JSON.stringify([entry])] : [id];
  let res;
  if (status === "stuck") {
    params.push(status, stuckSignal);
    res = await pool.query<{ status: string; pending_input: string | null }>(
      `UPDATE runs
          SET ${threadConcat}
              status = $${params.length - 1},
              stuck_signal = $${params.length},
              updated_at = now(),
              last_heartbeat_at = now()
        WHERE id = $1${guard}${returning}`,
      params,
    );
  } else {
    params.push(status);
    res = await pool.query<{ status: string; pending_input: string | null }>(
      `UPDATE runs
          SET ${threadConcat}
              status = $${params.length},
              stuck_signal = NULL,
              completed_at = now(),
              updated_at = now(),
              last_heartbeat_at = now()
        WHERE id = $1${guard}${returning}`,
      params,
    );
  }

  // Legacy (claude-pool) path: unchanged behaviour, no guard, no handshake.
  // 07 §6 is explicit that the pool branch is not on this control plane.
  if (!opts.guardRunning) return { applied: true, requeued: false };

  if (res.rowCount === 0) {
    // The precondition was gone: stop/terminate landed first. Write nothing
    // else — the operator's verb already stamped what it needed.
    const actual = await getRunStatus(id);
    console.log(
      `[executor] run ${id}: completion yielded to operator status ${actual}`,
    );
    return { applied: false, requeued: false };
  }

  const decision = completionTransition({
    outcome: status,
    // The guard proved it: rowCount 1 means the row WAS 'running'.
    rowStatus: "running",
    pendingInput: res.rows[0].pending_input === "true",
  });
  if (!(decision.status === "queued" && decision.clearPendingInput)) {
    return { applied: true, requeued: false };
  }

  // E2 of the 07 §5 diagram. completed_at must be cleared: the first statement
  // stamped it and this run is going back to work. `AND status = 'completed'`
  // means an operator who terminated between the two statements still wins.
  const requeue = await pool.query(
    `UPDATE runs
        SET status = 'queued',
            completed_at = NULL,
            wake_after = NULL,
            metadata = metadata - 'pending_input',
            updated_at = now()
      WHERE id = $1 AND status = 'completed'`,
    [id],
  );
  if (requeue.rowCount === 0) {
    const actual = await getRunStatus(id);
    console.log(
      `[executor] run ${id}: completion yielded to operator status ${actual}`,
    );
    return { applied: false, requeued: false };
  }
  console.log(
    `[executor] run ${id}: pending input consumed - requeued for next turn`,
  );
  return { applied: true, requeued: true };
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

/* ── A session id belongs to an ENGINE, not to the run ───────────────────────
 *
 * `cc_session_id` is one slot shared by both engines, and this function used to
 * stamp `'engine': 'claude-code'` unconditionally. So a Gemini run wrote agy's
 * conversation id into that slot and labelled it Claude, and the resume path
 * read the slot back without checking whose id it was.
 *
 * Konrad hit the visible half on 2026-08-23: switching a live chat to Gemini
 * killed the run with
 *   agy returned status ERROR ... conversation "6b1c2951-…" not found
 * because that is a *Claude* session id and agy keeps its own conversation
 * store. The mirror image is worse because it is silent — handing
 * `claude --resume` an agy conversation id.
 *
 * So the producing engine is recorded beside the id, and `resumableSession()`
 * only hands back an id the engine about to run actually minted. Switching
 * engines mid-chat now starts a fresh conversation instead of failing, which is
 * the honest behaviour: the two engines cannot share context anyway.
 *
 * ── AND WHY IT WRITES `session_engine`, NOT `engine` (2026-08-24) ────────────
 * That fix wrote the provenance into `metadata.engine`, which was already
 * taken: `processRun` reads the same key to choose the DISPATCH branch. One
 * key, two vocabularies — dispatch says {claude-code | claude-pool},
 * provenance says {claude-code | agy}. So the first Gemini turn of a chat
 * succeeded and, on its way out, rewrote its own dispatch to "agy". Turn two
 * read "agy", failed `=== "claude-code"`, and went to the legacy HTTP pool.
 * Konrad's `pool 400: Invalid request` is that write landing.
 *
 * Provenance now has its own slot and the dispatch key is left exactly as the
 * operator set it. */
async function saveCcSession(
  id: string,
  sessionId: string,
  engine: string,
): Promise<void> {
  await pool.query(
    `UPDATE runs
        SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                       jsonb_build_object('cc_session_id', $2::text, 'session_engine', $3::text),
            updated_at = now()
      WHERE id = $1`,
    [id, sessionId, engine],
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

/** Is a `claude` process already resuming this session? Reads /proc directly
 *  rather than shelling out to ps — no subprocess per check, and it can't be
 *  fooled by a pattern that accidentally matches our own command line (a
 *  `pkill -f "next build"` once killed the operator's own shell that way). */
async function sessionProcessAlive(sessionId: string): Promise<boolean> {
  const { readdir, readFile } = await import("node:fs/promises");
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch {
    return false; // not Linux / no procfs — fail open rather than block work
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    if (pid === String(process.pid)) continue;
    let cmd: string;
    try {
      cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // process exited between readdir and read — normal
    }
    // cmdline is NUL-separated; `--resume <id>` therefore appears as two args.
    if (cmd.includes(sessionId) && cmd.includes("claude")) return true;
  }
  return false;
}

async function processRun(run: ClaimedRun): Promise<void> {
  console.log(`[executor] claimed run ${run.id} (${run.title.slice(0, 60)})`);

  // Hoisted above the guardrail pre-flight (R905): the guard is the control
  // plane's and the control plane is the CC engine only (07 §6), and the
  // pre-flight below is itself a completion path — so it needs to know which
  // engine this run is on BEFORE it writes anything.
  const engine = String(run.metadata?.engine ?? DEFAULT_ENGINE);
  // Opt IN to the legacy pool, never fall into it (see LEGACY_POOL_ENGINE).
  // `guardRunning` follows the branch rather than the literal "claude-code":
  // 07 §6 exempts the pool path from the completion guard, and every other
  // engine — agy included — runs through processWithClaudeCode, which is the
  // control plane the guard belongs to.
  const usesPool = engine === LEGACY_POOL_ENGINE;
  const guardRunning = !usesPool;
  const model = typeof run.metadata?.model === "string" ? run.metadata.model : undefined;
  const isGemini =
    isGeminiModel(model) ||
    engine === "gemini" ||
    engine === "gemini-cli" ||
    engine === "agy";

  // Guardrail pre-flight: spend cap + runtime kill switch on the chat path.
  // Rough thread-char → EUR estimate so spend.per_run_cap can bite before a
  // long burn (real spend is recorded by claude-pool; this is preemptive).
  // Gemini runs are flat Google AI Pro subscription, 0 USD/EUR direct token cost.
  // For Gemini runs, set estSpendEur = 0 so EUR spend caps are not falsely tripped.
  const threadChars = (run.thread ?? []).reduce(
    (n, e) => n + String(e.content ?? "").length,
    0,
  );
  const estSpendEur = isGemini ? 0 : Math.max(0.01, (threadChars / 1000) * 0.04);
  // v1.9: today's actual rolled-up spend from spend_log so the
  // spend.daily_cap guardrail can finally trip when it should. Failures
  // here MUST NOT block the run — fall back to estimating from this turn
  // alone if the rollup query fails.
  const dailySpendEur = isGemini
    ? 0
    : await todaySpendRollup()
        .then((r) => r.total_eur + estSpendEur)
        .catch(() => estSpendEur);
  const guard = await evaluateGuardrails({
    agent: "forge-executor",
    action: isGemini ? "gemini.run" : "claude-pool.run",
    category: "financial",
    model,
    engine: isGemini ? "gemini" : engine,
    payload: {
      run_id: run.id,
      model,
      engine: isGemini ? "gemini" : engine,
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
    // GUARDED like every other CC completion write (C13, 07 §6). This path is
    // reached AFTER two awaited round trips (todaySpendRollup +
    // evaluateGuardrails), which is a wide-open window for an operator's
    // stop/terminate to land on a row this code is about to flip to 'failed'.
    // Unguarded, Konrad's terminate — already stamped `cancelled` +
    // `completed_at` — was silently overwritten, and his phone was pushed about
    // a run he had just killed.
    const written = await completeRun(
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
      null,
      { guardRunning },
    );
    // A guardrail trip is exactly the "you're not looking at the screen
    // right now" case — push it regardless of run source (unlike
    // notifyRunOutcome, which only pings for telegram/cron so a normal
    // web-chat reply doesn't also buzz the phone). Gated on the write actually
    // landing: a run whose status the operator already owns must not generate a
    // notification about a block that never applied to it.
    if (written.applied) {
      await queueNotification(
        `🚫 "${run.title}" blocked — ${guard.rule_label}: ${guard.reason}\n/rules to see current caps, /cap <rule_id> <euros> to raise one.`,
        "guardrail",
      ).catch(() => {});
    }
    return;
  }

  // v1.6 Tier-2 phase 3: prefetch memory hits relevant to the latest user
  // turn and prepend a [MEMORY] block to the prompt. No-op if disabled, the
  // turn carries no topical content, the search errors, or nothing lands above
  // the score floor.
  //
  // 2026-08-05 (audit §4.E): the whole thread is passed, not just the last
  // message — a thin turn ("do it") is augmented with the thread's running
  // topic instead of being embedded verbatim. `memory.reason` is logged either
  // way so an absent [MEMORY] block is explicable from the log alone.
  const memory = await prefetchMemoryForUserTurn(run.thread ?? []);
  console.log(
    `[executor] run ${run.id}: memory prefetch — ${memory.reason}` +
      (memory.block ? ` (${memory.block.length}ch block)` : ""),
  );

  const timeoutMs = getTimeoutFor(run.metadata);
  const hb = setInterval(() => heartbeat(run.id), 5_000);
  try {
    if (!usesPool) {
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
    // `guardRunning` (= engine === "claude-code") is decided once at the top of
    // processRun: the guard is the control plane's, and the control plane is
    // the CC engine only (07 §6). A run the operator terminated must not be
    // flipped to `stuck` by a timeout that was already moot.
    if (isTimeout) {
      console.warn(
        `[executor] run ${run.id} timed out after ${timeoutMs}ms — marking stuck`,
      );
      const written = await completeRun(
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
        { guardRunning },
      );
      if (written.applied && !written.requeued) {
        await notifyRunOutcome(run, "stuck", `timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
    } else {
      console.error(`[executor] run ${run.id} failed: ${msg}`);
      const written = await completeRun(
        run.id,
        {
          role: "system",
          content: `Executor failed: ${msg}`,
          ts: new Date().toISOString(),
          kind: "error",
          meta: { error: msg, engine },
        },
        "failed",
        null,
        { guardRunning },
      );
      if (written.applied && !written.requeued) {
        await notifyRunOutcome(run, "failed", msg);
      }
    }
  } finally {
    clearInterval(hb);
    // Drop the in-memory rollup regardless of outcome. finalizeRollup is
    // idempotent and no-ops if the run was already flushed on the happy
    // path (processWithClaudeCode calls it just before completeRun).
    await finalizeRollup(run.id).catch(() => {});
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
      ...(e.parentToolUseId
        ? { parent_tool_use_id: e.parentToolUseId }
        : {}),
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
    meta: {
      tool_use_id: e.toolUseId,
      is_error: e.isError === true,
      ...(e.parentToolUseId
        ? { parent_tool_use_id: e.parentToolUseId }
        : {}),
    },
  };
}

async function processWithClaudeCode(
  run: ClaimedRun,
  memoryBlock: string | null,
  timeoutMs: number,
): Promise<void> {
  const thread = run.thread ?? [];
  // `model` is read BEFORE the session id on purpose: which engine is about to
  // run decides whether the stored session id is ours to resume at all.
  const model =
    typeof run.metadata?.model === "string"
      ? (run.metadata.model as string)
      : null;
  const engineNow = engineForModel(model);
  const priorSession = resumableSession(
    run.metadata as Record<string, unknown> | null,
    engineNow,
  );
  const effort =
    typeof run.metadata?.effort === "string"
      ? (run.metadata.effort as string)
      : null;
  // Coding-project tasks run inside their project's git worktree instead of
  // the shared CC_WORKSPACE — see db/projects.ts / lib/project-tick.ts.
  const cwd =
    typeof run.metadata?.workspace_dir === "string"
      ? (run.metadata.workspace_dir as string)
      : null;
  const allowedTools = Array.isArray(run.metadata?.allowed_tools)
    ? (run.metadata.allowed_tools as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : null;
  // Undefined (plain Chat/Manager runs) falls back to runClaudeCode's own
  // default of true; ticker-spawned tasks set this explicitly per role.
  const vaultAccess =
    typeof run.metadata?.vault_access === "boolean"
      ? (run.metadata.vault_access as boolean)
      : undefined;

  // GUARD: never run two engine processes against one session.
  //
  // On 2026-07-30 three `claude -p --resume <same-session>` processes were
  // live at once. They edited the same files from stale reads and reverted
  // each other's work for hours, and two concurrent builds deleted each
  // other's artifacts. The in-memory `inFlight` map below does not prevent
  // this: it is lost whenever the executor restarts, while an orphaned child
  // from a previously-killed turn keeps running (a timeout marked the run
  // stuck but never reaped its process).
  //
  // So the check has to look at the OS, not at our own bookkeeping.
  if (priorSession && (await sessionProcessAlive(priorSession))) {
    // Put it BACK on the queue rather than completing it. Completing would
    // silently swallow whatever the user just sent; re-queuing means the turn
    // runs as soon as the existing process finishes.
    //
    // v2.6 (E10): re-queuing alone was a livelock. A re-queued run is instantly
    // re-claimable, so run ece63bdb spun 1,219 times over six hours. wake_after
    // parks it for 2^n seconds (capped at 60) instead — the retry still happens
    // on its own, just not 3,300 times an hour.
    const waited = Number(run.metadata?.session_wait_attempts ?? 0);
    const attempts = Number.isFinite(waited) && waited > 0 ? waited : 0;
    const delayMs = Math.min(2 ** attempts, SESSION_WAIT_MAX_BACKOFF_S) * 1000;
    console.warn(
      `[executor] run ${run.id}: a live engine process already owns session ` +
        `${priorSession} — refusing to start a second one; re-queued for ` +
        `${delayMs / 1000}s (attempt ${attempts + 1})`,
    );
    // `AND status = 'running'` is the same guard the completion writes carry
    // (07 §6), and it is load-bearing here for a sharper reason: the procfs
    // scan above is an awaited syscall walk, and the runs it fires on are
    // exactly the wedged ones an operator terminates. Unguarded, a terminate
    // landing in that window was overwritten — `cancelled` flipped back to
    // `queued`, and the run Konrad killed came back on the next claim and kept
    // spending. The E10 backoff loop re-opens the window every cycle, so this
    // was not a one-shot race but a recurring one. A stop's `paused` was
    // overwritten the same way.
    //
    // No .catch: a pg failure here must surface (C20). It propagates to
    // processRun's handler, which marks the run failed with the message in the
    // thread, rather than silently leaving a `running` row for the watchdog.
    const requeued = await pool.query(
      `UPDATE runs
          SET status = 'queued',
              wake_after = now() + ($2::int * interval '1 millisecond'),
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                         jsonb_build_object('session_wait_attempts', $3::int),
              updated_at = now()
        WHERE id = $1
          AND status = 'running'`,
      [run.id, delayMs, attempts + 1],
    );
    if (requeued.rowCount === 0) {
      const actual = await getRunStatus(run.id);
      console.log(
        `[executor] run ${run.id}: session-wait requeue yielded to operator status ${actual}`,
      );
    }
    return;
  }

  // Past the guard: this turn owns the session, so the next contention starts
  // its backoff from zero again.
  if (run.metadata?.session_wait_attempts !== undefined) {
    await pool
      .query(
        `UPDATE runs SET metadata = metadata - 'session_wait_attempts' WHERE id = $1`,
        [run.id],
      )
      .catch((e) =>
        console.error("[executor] clearing session_wait_attempts failed:", e.message),
      );
  }

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
    // Feed the per-run rollup FIRST — it's what backs GET /api/agents now,
    // and unlike the thread append it batches its own writes (~2s), so we
    // pay the DB cost once per burst instead of once per event.
    ingestEvent(run.id, e);
    if (e.type === "init" && e.sessionId) {
      const sid = e.sessionId;
      enqueue(() => saveCcSession(run.id, sid, engineNow));
    } else if (e.type === "assistant_text" && e.text) {
      const entry: ThreadEntry = {
        role: "assistant",
        content: e.text,
        ts: new Date().toISOString(),
        kind: "text",
        // Stamp parent_tool_use_id and usage into thread meta so the
        // read-side fallback (foldSubagents on runs without rollup_v1)
        // can still attribute events to their subagent.
        meta: {
          provider: "claude-code",
          ...(e.parentToolUseId
            ? { parent_tool_use_id: e.parentToolUseId }
            : {}),
          ...(e.usage ? { usage: e.usage } : {}),
          ...(e.model ? { model: e.model } : {}),
        },
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

  // Which Claude identity serves this run. Throws NoHealthyAccountError naming
  // every account and why it was rejected — the diagnosis that was missing on
  // 2026-08-02, when the only signal was a bare authentication failure.
  let account = await resolveAccount();
  console.log(
    `[executor] run ${run.id}: account=${account.slug} health=${account.health}`,
  );

  const callEngine = (over: {
    prompt: string;
    sessionId: string | null;
    configDir: string;
  }) =>
    runClaudeCode({
      prompt: over.prompt,
      sessionId: over.sessionId,
      configDir: over.configDir,
      // The child's own run identity — FORGE_RUN_ID/FORGE_RUN_UUID on its
      // environment. The research lane's screenshot convention
      // (/opt/ai-os/uploads/<run_id>/...) is unusable without it.
      runId: run.id,
      timeoutMs,
      model,
      effort,
      cwd,
      allowedTools,
      vaultAccess,
      onEvent,
      isCancelled,
    });

  let result;
  try {
    result = await callEngine({
      prompt: message,
      sessionId: priorSession,
      configDir: account.configDir,
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
      result = await callEngine({
        prompt: memoryBlock ? `${memoryBlock}${fullMessage}` : fullMessage,
        sessionId: null,
        configDir: account.configDir,
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      // Classifies the failure and, for auth ONLY, marks the account broken.
      // A rate-limited account is busy, not broken: it is left healthy and
      // failover is refused, so the run fails visibly instead of quietly
      // consuming a second account's capacity.
      const outcome = await recordRunOutcome(account.slug, {
        ok: false,
        errorMessage: msg,
      });
      if (!outcome.failover) {
        if (outcome.classification === "rate_limit") {
          console.warn(
            `[executor] run ${run.id}: ${account.slug} is rate-limited — ` +
              `failing visibly, NOT switching accounts`,
          );
        }
        await chain; // flush whatever streamed before the failure
        throw err;
      }

      const next = await resolveFailoverAccount(account.slug);
      if (!next) {
        console.error(
          `[executor] run ${run.id}: ${account.slug} failed authentication and ` +
            `no other usable account exists`,
        );
        await chain;
        throw err;
      }

      console.warn(
        `[executor] run ${run.id}: ${account.slug} failed authentication — ` +
          `failing over to ${next.slug}`,
      );
      await appendThreadEntry(run.id, {
        role: "system",
        content: `Claude account "${account.slug}" failed to authenticate — retried on "${next.slug}".`,
        ts: new Date().toISOString(),
        kind: "text",
        meta: { account_failover: true, from: account.slug, to: next.slug },
      });

      // A CC session lives INSIDE the account's config dir, so the new account
      // cannot resume the old one's session. Start fresh and re-send the full
      // transcript, exactly as the resume-miss path does.
      const fullMessage = buildPromptFromThread(thread, {
        assistantMarker: false,
      });
      account = next;
      try {
        result = await callEngine({
          prompt: memoryBlock ? `${memoryBlock}${fullMessage}` : fullMessage,
          sessionId: null,
          configDir: next.configDir,
        });
      } catch (err2) {
        // One hop only. Two auth failures in a row is a systemic fault, not a
        // bad account, and walking the whole list would burn every credential.
        await recordRunOutcome(next.slug, {
          ok: false,
          errorMessage: err2 instanceof Error ? err2.message : String(err2),
        });
        await chain;
        throw err2;
      }
    }
  }

  await chain; // all streamed entries persisted, in order

  // Proof the account works. This is the ONLY thing that promotes an account
  // out of `unknown` — a credential file cannot, since a dead account's file is
  // structurally identical to a live one's.
  await recordRunOutcome(account.slug, { ok: true }).catch((e) =>
    console.warn(`[executor] account success write failed: ${e.message}`),
  );

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
    await saveCcSession(run.id, result.sessionId, engineNow).catch((e) =>
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
  // Flush the rollup one last time BEFORE marking completed so the UI's
  // "recent" section reflects the final subagent statuses instead of a
  // stale mid-run snapshot.
  await finalizeRollup(run.id);
  const written = await completeRun(run.id, finalEntry, "completed", null, {
    guardRunning: true,
  });
  // Yielded to an operator verb, or requeued to consume a pending message:
  // either way this run did not just finish, so it must not push a
  // "completed" notification (07 §5/§6).
  if (!written.applied || written.requeued) return;
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

// v2.5: concurrency. Reads the agent.spawn_cap guardrail (config.max,
// currently 8) that's existed in guardrail_rules since migration 0021 but
// was never enforced — the executor claimed and processed exactly one run
// at a time. Coding projects need real parallelism (multiple task runs in
// flight per tick), so this became load-bearing. Disabled/missing rule
// falls back to a safety default rather than "unlimited" — this cap
// controls how many `claude` child processes run at once on the VPS.
const CONCURRENCY_SAFETY_DEFAULT = 4;
const CONCURRENCY_HARD_CEILING = 16;

async function getConcurrencyLimit(): Promise<number> {
  try {
    const r = await pool.query<{ enabled: boolean; config: { max?: number } }>(
      `SELECT enabled, config FROM guardrail_rules WHERE id = 'agent.spawn_cap' LIMIT 1`,
    );
    const row = r.rows[0];
    const max = Number(row?.config?.max);
    if (!row || !row.enabled || !Number.isFinite(max) || max < 1) {
      return CONCURRENCY_SAFETY_DEFAULT;
    }
    return Math.min(max, CONCURRENCY_HARD_CEILING);
  } catch {
    return CONCURRENCY_SAFETY_DEFAULT;
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
  // Fire-and-forget map of in-flight processRun() calls, keyed by run id.
  // We claim up to `limit` concurrently instead of awaiting each one before
  // claiming the next — that's the whole change from v2.4's strictly serial
  // loop. processRun() already never throws in normal operation (it catches
  // internally and writes 'failed'/'stuck'); the .catch() here only guards
  // against something escaping before that try block (e.g. memory prefetch).
  const inFlight = new Map<string, Promise<void>>();

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
      const limit = await getConcurrencyLimit();
      if (inFlight.size < limit) {
        const run = await claimNextRun();
        if (run && inFlight.has(run.id)) {
          // TWO PROCESSES, ONE RUN — the bug that put "Executor failed:
          // claude-code exit 0:" into Konrad's chat mid-conversation on
          // 2026-08-25, and into three other threads before it.
          //
          // claimNextRun() only takes `queued` rows, so this cannot happen on
          // its own. It happens when a row this executor is ALREADY running
          // goes back to `queued` underneath it — the api-overload and
          // usage-wall parks (db/runs.ts) both write `queued` off a `failed`
          // row, and a duplicate's own failure is enough to open that door.
          // The claim then spawns a SECOND `claude --resume <session>` against
          // the session the live process is holding. The CLI does not error on
          // that: it exits 0 having emitted no `result` event, which
          // cc-runner reads as a failed turn, which marks the whole run failed
          // while the real turn is still working. The operator sees a red
          // system line in a conversation that is in fact fine.
          //
          // The turn is NOT dropped. `pending_input` is the sanctioned way to
          // say "this run owes another turn" (07 §5) — E1/E2 in completeRun
          // read it and requeue once the live turn finishes, which is exactly
          // the semantics a second claim was reaching for.
          console.warn(
            `[executor] run ${run.id} was claimed while already in flight — deferring to the live turn instead of racing its session`,
          );
          await deferDuplicateClaim(run.id);
          // Safety net for the one order E1/E2 cannot cover: if the live turn
          // had already passed its completion handshake when we set the flag,
          // nobody is left to read it. Re-queue it ourselves once that promise
          // settles — guarded so it does nothing when E2 did its job.
          void inFlight
            .get(run.id)
            ?.finally(() => requeueIfTurnStillOwed(run.id));
          continue;
        }
        if (run) {
          const p = processRun(run)
            .catch((err) => {
              console.error(
                `[executor] run ${run.id} escaped processRun uncaught:`,
                err instanceof Error ? err.message : err,
              );
            })
            .finally(() => {
              inFlight.delete(run.id);
            });
          inFlight.set(run.id, p);
          continue; // try to fill remaining concurrency headroom immediately
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[executor] claim cycle failed:", msg);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(
    `[executor] shutting down — waiting for ${inFlight.size} in-flight run(s)`,
  );
  await Promise.allSettled([...inFlight.values()]);
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
            // The title is a lede; the reminder itself goes in `ask`, whole.
            // Truncating here used to be the last place a reminder could lose
            // its payload silently — see lib/reminder-text.ts.
            reminderCardTitle(rem.text),
            reminderCardAsk(rem.text, dueLocal, rem.recur),
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

/**
 * How long a `completed` row may carry `metadata.pending_input` before the
 * sweep below treats it as stranded. Generous on purpose: E2 follows E1 by one
 * statement, so anything still in that shape a minute later is not in flight.
 */
const PENDING_INPUT_STRANDED_MS = 60_000;

/**
 * Rescue messages stranded by an executor restart between E1 and E2 (07 §5,
 * red-team S6).
 *
 * The handshake is two statements: E1 completes the run and RETURNs the flag,
 * E2 requeues it. Between them the row is `completed` + `pending_input=true`,
 * and E2 lives only in an in-flight promise — a crash, an OOM kill, or this
 * project's own DETACHED safe-restart drops it. Nothing else consumes the flag:
 * its only two readers are `claimNextRun` (which touches `queued` rows only)
 * and E2 itself (`WHERE status='completed'`, never re-run). So the message sat
 * in the thread forever behind a 202 that had already promised "delivery:
 * next-turn".
 *
 * This is E2, replayed from durable state instead of from memory — the whole
 * point of C23 keeping every byte of delivery state in the `runs` row. It is
 * byte-for-byte the same UPDATE, so a row it and E2 both reach is written once
 * and the loser logs a yield.
 *
 * Scope is deliberately narrow: `completed` only. A `failed`/`stuck` run keeps
 * its flag by design (07 §5, last bullet) — a message must never convert a
 * failure into a silent retry loop — and resume-chat is what delivers it there.
 *
 * It is engine-agnostic, which 07 §6's "the pool branch is not on this control
 * plane" does NOT contradict: §6 is about the pool branch's completion WRITE,
 * which is untouched. A legacy `claude-pool` run messaged while running takes
 * the unguarded completion path, so nothing ever reads its flag and the message
 * would strand exactly as an E1/E2 crash strands a CC one — the same defect,
 * and this repairs it the same way (one extra turn, ≤60s late), rather than
 * leaving a silently undelivered 202 behind an engine distinction the caller
 * never saw.
 */
async function pendingInputSweepTick(): Promise<void> {
  try {
    const r = await pool.query<{ id: string }>(
      `UPDATE runs
          SET status = 'queued',
              completed_at = NULL,
              wake_after = NULL,
              metadata = metadata - 'pending_input',
              updated_at = now()
        WHERE status = 'completed'
          AND metadata->>'pending_input' = 'true'
          AND updated_at < now() - (interval '1 millisecond' * $1)
        RETURNING id::text`,
      [PENDING_INPUT_STRANDED_MS],
    );
    for (const row of r.rows) {
      console.warn(
        `[executor] run ${row.id}: stranded pending input swept - requeued for next turn`,
      );
    }
  } catch (e) {
    console.error(
      "[pending-input sweep] tick failed:",
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
    // Rescues messages stranded by a restart between E1 and E2 (07 §5). Beside
    // the stuck watchdog on purpose: both are cheap, idempotent UPDATEs that
    // repair rows no in-memory owner is left for.
    await pendingInputSweepTick();
    await reminderTick();
    // v2.5: coding-project stage advancement — same tick cadence as
    // everything else here, gated on fleet_state internally like cron-tick.
    await projectTick();
    await new Promise((r) => setTimeout(r, 10_000));
  }
  await hcp.end().catch(() => {});
}

Promise.all([loop(), managerLoop()]).catch((e) => {
  console.error("[executor] fatal:", e);
  process.exit(1);
});
