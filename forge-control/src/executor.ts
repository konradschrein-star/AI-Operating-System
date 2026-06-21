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

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";
const POOL_URL = process.env.CLAUDE_POOL_URL ?? "http://127.0.0.1:8092";
const POOL_KEY = process.env.CLAUDE_POOL_API_KEY ?? "";
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

interface ThreadEntry {
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

function buildPromptFromThread(thread: ThreadEntry[]): string {
  // Compact transcript format claude-pool will handle as a single prompt.
  // We rely on claude-pool's underlying model to follow the role markers.
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
  lines.push("[ASSISTANT]\n");
  return lines.join("\n");
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
  entry: ThreadEntry,
  status: "completed" | "failed" | "stuck",
  stuckSignal: string | null = null,
): Promise<void> {
  // 'stuck' is a resumable terminal — leave completed_at NULL so the UI can
  // still distinguish "ended" runs from a parked one. failed/completed write
  // completed_at = now(). Split into two queries because Postgres can't
  // reconcile the status-enum binding when $3 is also referenced via $3::text
  // in a CASE expression (deduces conflicting types for the parameter).
  if (status === "stuck") {
    await pool.query(
      `UPDATE runs
          SET thread = thread || $2::jsonb,
              status = $3,
              stuck_signal = $4,
              updated_at = now(),
              last_heartbeat_at = now()
        WHERE id = $1`,
      [id, JSON.stringify([entry]), status, stuckSignal],
    );
  } else {
    await pool.query(
      `UPDATE runs
          SET thread = thread || $2::jsonb,
              status = $3,
              stuck_signal = NULL,
              completed_at = now(),
              updated_at = now(),
              last_heartbeat_at = now()
        WHERE id = $1`,
      [id, JSON.stringify([entry]), status],
    );
  }
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
  const guard = await evaluateGuardrails({
    agent: "forge-executor",
    action: "claude-pool.run",
    category: "financial",
    payload: {
      run_id: run.id,
      spend_eur: estSpendEur,
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

  const prompt = buildPromptFromThread(run.thread ?? []);
  const timeoutMs = getTimeoutFor(run.metadata);
  const hb = setInterval(() => heartbeat(run.id), 5_000);
  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    } else {
      console.error(`[executor] run ${run.id} failed: ${msg}`);
      await completeRun(
        run.id,
        {
          role: "system",
          content: `Executor failed: ${msg}`,
          ts: new Date().toISOString(),
          kind: "error",
          meta: { error: msg },
        },
        "failed",
      );
    }
  } finally {
    clearInterval(hb);
  }
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

async function createInboxFromMessage(m: AgentMessageRow): Promise<void> {
  const body = m.body ?? {};
  await pool.query(
    `INSERT INTO inbox_items
       (type, status, title, ask, tried, actions, source, external_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
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

async function managerLoop(): Promise<void> {
  console.log(`[manager] starting · hcp=${HCP_URL.replace(/:.+@/, ":***@")}`);
  // Stagger first tick to avoid hammering the DB at startup with the executor.
  await new Promise((r) => setTimeout(r, 4_000));
  while (running) {
    await managerTick();
    await stuckWatchdogTick();
    await new Promise((r) => setTimeout(r, 10_000));
  }
  await hcp.end().catch(() => {});
}

Promise.all([loop(), managerLoop()]).catch((e) => {
  console.error("[executor] fatal:", e);
  process.exit(1);
});
