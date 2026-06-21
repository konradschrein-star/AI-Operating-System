/**
 * Personal AI OS data access for forge-control.
 *
 * Uses the same `pg` Pool as forge.ts (content_forge DB). All seven AI-OS
 * tables created by migration 0021 live in the same Postgres instance.
 *
 * Mirrors the data shapes consumed by forge-control-web/app/MobileApp.tsx
 * exactly — when these queries are wired in, the UI swaps mocks for live
 * data without component changes.
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[ai_os pg pool error]", err.message);
});

const HCP_DATABASE_URL =
  process.env.HCP_DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/hcp";

const hcpPool = new Pool({
  connectionString: HCP_DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

hcpPool.on("error", (err) => {
  console.error("[ai_os hcp pool error]", err.message);
});

/* ============================================================================
 * Types — mirror packages/db/src/schema/ai-os.ts plus the renderVals() shape
 * in design/Forge Mobile.dc.html.
 * ========================================================================== */

export type InboxStatus = "BLEED" | "STUCK" | "APPROVE" | "DECIDE" | "NORMAL";
export type InboxTried = { icon: string; text: string };
export type InboxAction = {
  label: string;
  variant: "primary" | "ok" | "danger" | "neutral";
  action_id: string;
};

export interface InboxItem {
  id: string;
  type: string;
  status: InboxStatus;
  title: string;
  ask: string;
  tried: InboxTried[];
  actions: InboxAction[];
  source: string;
  related_job_id: string | null;
  related_worker_id: string | null;
  escalation_count: number;
  created_at: string;
  age: string;
}

export type DecisionKind =
  | "dispatch"
  | "breaker"
  | "degrade"
  | "escalate"
  | "unstick"
  | "resolve"
  | "freeze"
  | "resume"
  | "guardrail"
  | "manager"
  | "user";

export interface Decision {
  id: string;
  ts: string;
  kind: DecisionKind;
  actor: string;
  action: string;
  payload: Record<string, unknown>;
  inbox_item_id: string | null;
  related_job_id: string | null;
}

export type FleetStatus = "running" | "paused";

export interface FleetState {
  status: FleetStatus;
  updated_at: string;
  updated_by: string;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function humanAge(createdAt: string): string {
  const ts = new Date(createdAt).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/* ============================================================================
 * Fleet state
 * ========================================================================== */

export async function getFleetState(): Promise<FleetState> {
  const r = await pool.query<FleetState>(
    `SELECT status, updated_at::text AS updated_at, updated_by
       FROM fleet_state
      WHERE id = 1`,
  );
  if (r.rows[0]) return r.rows[0];
  // The migration seeds this row; if it's somehow missing return a safe default.
  return {
    status: "running",
    updated_at: new Date().toISOString(),
    updated_by: "system",
  };
}

export async function setFleetState(
  status: FleetStatus,
  updatedBy = "user",
): Promise<FleetState> {
  const r = await pool.query<FleetState>(
    `UPDATE fleet_state
        SET status = $1, updated_at = now(), updated_by = $2
      WHERE id = 1
      RETURNING status, updated_at::text AS updated_at, updated_by`,
    [status, updatedBy],
  );
  return r.rows[0];
}

/* ============================================================================
 * Inbox
 * ========================================================================== */

export async function listOpenInbox(limit = 50): Promise<InboxItem[]> {
  const r = await pool.query(
    `SELECT id, type, status, title, ask, tried, actions, source,
            related_job_id, related_worker_id, escalation_count,
            created_at::text AS created_at
       FROM inbox_items
      WHERE resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    ...row,
    age: humanAge(row.created_at),
  })) as InboxItem[];
}

export async function resolveInbox(
  id: string,
  resolvedBy = "user",
  resolution: Record<string, unknown> = {},
): Promise<InboxItem | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      `UPDATE inbox_items
          SET resolved_at = now(), resolved_by = $2, resolution = $3, updated_at = now()
        WHERE id = $1 AND resolved_at IS NULL
        RETURNING id, type, status, title, ask, tried, actions, source,
                  related_job_id, related_worker_id, escalation_count,
                  external_id,
                  created_at::text AS created_at`,
      [id, resolvedBy, resolution],
    );
    if (!u.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO decisions (kind, actor, action, payload, inbox_item_id, related_job_id)
       VALUES ('resolve', $1, $2, $3, $4, $5)`,
      [
        resolvedBy,
        `resolved inbox item ${u.rows[0].type}: ${u.rows[0].title}`,
        resolution,
        id,
        u.rows[0].related_job_id,
      ],
    );
    await client.query("COMMIT");
    const row = u.rows[0] as Omit<InboxItem, "age"> & {
      external_id?: string | null;
    };
    // Best-effort relay back to HCP. Failures here don't undo the local
    // resolution — the user already saw the action succeed in the UI.
    try {
      const rawAction = String(
        (resolution.action as string | undefined) ??
          (resolution.action_id as string | undefined) ??
          "resolve",
      ).toLowerCase();
      const action: "approve" | "deny" | "ack" | "resolve" =
        rawAction.startsWith("approve")
          ? "approve"
          : rawAction.startsWith("deny") || rawAction.startsWith("reject")
            ? "deny"
            : rawAction.startsWith("ack") || rawAction.startsWith("acknowledge")
              ? "ack"
              : "resolve";
      const replyId = await replyToHcpIfMirrored({
        external_id: row.external_id ?? null,
        action,
        reason: (resolution.reason as string | undefined) ?? undefined,
        reply_text: (resolution.reply_text as string | undefined) ?? undefined,
      });
      if (replyId) {
        console.log(
          `[ai_os] inbox ${id} relayed to HCP as agent_message ${replyId}`,
        );
      }
    } catch (e) {
      console.error(
        "[ai_os] HCP relay failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
    return { ...row, age: humanAge(row.created_at) } as InboxItem;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * If an inbox item was mirrored from HCP (external_id "hcp:<msg_id>"), write
 * a reply row into hcp.agent_message so the upstream worker unblocks.
 *
 *   ESCALATE          -> ANSWER
 *   APPROVAL_REQUEST  -> APPROVAL_DECISION
 *   ANOMALY           -> CHAT (acknowledgement; no policy decision yet)
 *
 * Returns the new message id, or null if the item was not HCP-mirrored or the
 * upstream message could not be located.
 */
export async function replyToHcpIfMirrored(opts: {
  external_id: string | null;
  action: "approve" | "deny" | "ack" | "resolve";
  reason?: string;
  reply_text?: string;
}): Promise<string | null> {
  if (!opts.external_id || !opts.external_id.startsWith("hcp:")) return null;
  const upstreamId = opts.external_id.slice("hcp:".length);
  // Look up the original message so we know who to address the reply to.
  const r = await hcpPool.query<{
    id: string;
    sender_kind: string;
    sender_id: string;
    intent: string;
    job_id: string | null;
    task_id: string | null;
    correlation_id: string | null;
  }>(
    `SELECT id::text, sender_kind::text, sender_id, intent::text,
            job_id::text AS job_id, task_id::text AS task_id,
            correlation_id::text AS correlation_id
       FROM agent_message
      WHERE id = $1
      LIMIT 1`,
    [upstreamId],
  );
  const original = r.rows[0];
  if (!original) {
    console.warn(
      `[ai_os] inbox external_id ${opts.external_id} has no upstream HCP message; skipping reply`,
    );
    return null;
  }

  let replyIntent: "ANSWER" | "APPROVAL_DECISION" | "CHAT";
  let body: Record<string, unknown>;
  switch (original.intent) {
    case "APPROVAL_REQUEST":
      replyIntent = "APPROVAL_DECISION";
      body = {
        decision: opts.action === "approve" ? "approved" : "denied",
        action: opts.action,
        reason: opts.reason ?? null,
        source: "ai-os.inbox",
      };
      break;
    case "ESCALATE":
      replyIntent = "ANSWER";
      body = {
        answer: opts.reply_text ?? opts.reason ?? `(resolved: ${opts.action})`,
        action: opts.action,
        source: "ai-os.inbox",
      };
      break;
    default:
      replyIntent = "CHAT";
      body = {
        message:
          opts.reply_text ?? opts.reason ?? `acknowledged: ${opts.action}`,
        action: opts.action,
        source: "ai-os.inbox",
      };
  }

  const ins = await hcpPool.query<{ id: string }>(
    `INSERT INTO agent_message
       (sender_kind, sender_id, recipient_kind, recipient_id,
        job_id, task_id, intent, body, reply_to, correlation_id)
       VALUES ('ceo', 'konrad', $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id::text`,
    [
      original.sender_kind,
      original.sender_id,
      original.job_id,
      original.task_id,
      replyIntent,
      JSON.stringify(body),
      original.id,
      original.correlation_id,
    ],
  );
  return ins.rows[0]?.id ?? null;
}

/* ============================================================================
 * Decisions
 * ========================================================================== */

export async function listDecisions(limit = 50): Promise<Decision[]> {
  const r = await pool.query<Decision>(
    `SELECT id, ts::text AS ts, kind, actor, action, payload,
            inbox_item_id, related_job_id
       FROM decisions
      ORDER BY ts DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function appendDecision(
  kind: DecisionKind,
  actor: string,
  action: string,
  payload: Record<string, unknown> = {},
  refs: { inbox_item_id?: string; related_job_id?: string } = {},
): Promise<Decision> {
  const r = await pool.query<Decision>(
    `INSERT INTO decisions (kind, actor, action, payload, inbox_item_id, related_job_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, ts::text AS ts, kind, actor, action, payload,
               inbox_item_id, related_job_id`,
    [
      kind,
      actor,
      action,
      payload,
      refs.inbox_item_id ?? null,
      refs.related_job_id ?? null,
    ],
  );
  return r.rows[0];
}

/* ============================================================================
 * Composite "today" / "live" / "control" feeds for the mobile UI
 * ========================================================================== */

export interface TodayPayload {
  date: string;
  greeting: string;
  chips: {
    label: string;
    type: "NORMAL" | "BLEED" | "STUCK";
    goto: "inbox" | "control";
    animate: boolean;
  }[];
  needs: { type: string; status: InboxStatus; age: string; title: string }[];
  fleet: {
    name: string;
    state: string;
    status: "routing" | "render" | "idle" | "stuck";
  }[];
  spend: { value: string; cap: string };
  shipped: { value: string; pipeline: string };
}

/**
 * Compose the Today screen. Pulls open inbox counts + a sample of needs,
 * fleet snapshot (provided by the caller from Hermes), shipped count from
 * content_jobs, and a hard-coded daily spend cap until the spend tracker
 * lands.
 */
export async function getTodayPayload(opts: {
  fleet: TodayPayload["fleet"];
  spendEur: number;
  spendCapEur: number;
}): Promise<TodayPayload> {
  const inbox = await listOpenInbox(200);
  const counts = {
    BLEED: inbox.filter((i) => i.status === "BLEED").length,
    STUCK: inbox.filter((i) => i.status === "STUCK").length,
    APPROVE:
      inbox.filter((i) => i.status === "APPROVE").length +
      inbox.filter((i) => i.status === "DECIDE").length,
  };

  const shipped = await pool.query<{ shipped: string; pipeline: string }>(
    `SELECT
       (SELECT count(*) FROM content_jobs WHERE status = 'PUBLISHED' AND published_at::date = current_date)::text AS shipped,
       (SELECT count(*) FROM content_jobs WHERE status NOT IN ('PUBLISHED','MARKED_FOR_DELETION'))::text AS pipeline`,
  );

  const needs = inbox.slice(0, 3).map((i) => ({
    type: i.type,
    status: i.status,
    age: i.age,
    title: i.title,
  }));

  const date = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const hour = new Date().getHours();
  const greet =
    hour < 5
      ? "Working late, Konrad."
      : hour < 12
        ? "Good morning, Konrad."
        : hour < 18
          ? "Good afternoon, Konrad."
          : "Good evening, Konrad.";

  const chips: TodayPayload["chips"] = [
    {
      label: `${counts.APPROVE} to ship`,
      type: "NORMAL",
      goto: "control",
      animate: false,
    },
  ];
  if (counts.BLEED > 0)
    chips.push({
      label: `${counts.BLEED} bleed`,
      type: "BLEED",
      goto: "inbox",
      animate: true,
    });
  if (counts.STUCK > 0)
    chips.push({
      label: `${counts.STUCK} stuck`,
      type: "STUCK",
      goto: "inbox",
      animate: true,
    });

  return {
    date,
    greeting: greet,
    chips,
    needs,
    fleet: opts.fleet,
    spend: {
      value: `€${opts.spendEur.toFixed(2)}`,
      cap: `of €${opts.spendCapEur.toFixed(0)} cap`,
    },
    shipped: {
      value: shipped.rows[0]?.shipped ?? "0",
      pipeline: `${shipped.rows[0]?.pipeline ?? "0"} in pipeline`,
    },
  };
}

/* ============================================================================
 * Live & Control feeds compose data that lives outside the AI-OS tables
 * (Hermes ledger, gateway health). The HTTP routes glue them together; this
 * module only exposes the slices that live in Postgres.
 * ========================================================================== */

export async function pingAiOs(): Promise<{
  ok: boolean;
  latency_ms: number;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    await pool.query("SELECT 1 FROM fleet_state WHERE id = 1");
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message };
  }
}
