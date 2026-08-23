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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<FleetState>(
      `UPDATE fleet_state
          SET status = $1, updated_at = now(), updated_by = $2
        WHERE id = 1
        RETURNING status, updated_at::text AS updated_at, updated_by`,
      [status, updatedBy],
    );
    await client.query(
      `UPDATE guardrail_rules
          SET enabled = $1, updated_at = now()
        WHERE id = 'runtime.pause_all'`,
      [status === "paused"],
    );
    await client.query("COMMIT");
    return r.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

export interface ResolvedInboxItem extends InboxItem {
  resolved_at: string;
  resolved_by: string;
  resolution: Record<string, unknown>;
}

/** History tab (audit finding: resolved rows exist — 178 of them at last
 *  count — but nothing in the UI could ever reach them). `age` is measured
 *  from `resolved_at` here, not `created_at` like the open-item shape: what
 *  the history view answers is "how long ago was this handled", not "how
 *  old was the item when it landed". */
export async function listResolvedInbox(
  limit = 50,
): Promise<ResolvedInboxItem[]> {
  const r = await pool.query(
    `SELECT id, type, status, title, ask, tried, actions, source,
            related_job_id, related_worker_id, escalation_count,
            created_at::text AS created_at,
            resolved_at::text AS resolved_at,
            resolved_by,
            resolution
       FROM inbox_items
      WHERE resolved_at IS NOT NULL
      ORDER BY resolved_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    ...row,
    age: humanAge(row.resolved_at),
  })) as ResolvedInboxItem[];
}

/* ============================================================================
 * Inbox preview — JOIN against content_jobs so the desktop/mobile inbox card
 * can show video player + scene thumbs + stats instead of just title + buttons.
 * ========================================================================== */

export interface InboxPreview {
  inbox_item_id: string;
  job: {
    id: string;
    title: string;
    format: string;
    status: string;
    channel_id: string;
    channel_name: string | null;
    render_engine: string | null;
    production_version: string;
    enqueued_for_qc_at: string | null;
    render_started_at: string | null;
    render_completed_at: string | null;
    total_render_time_seconds: number | null;
  } | null;
  video: {
    url: string;
    poster_url: string | null;
    duration_sec: number;
    size_mb: number;
    aspect_ratio: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrate_kbps: number | null;
  } | null;
  scenes: Array<{
    index: number;
    thumb_url: string | null;
    duration_sec: number;
    visual_type: string | null;
    sentence: string | null;
  }>;
  stats: Array<{ label: string; value: string }>;
  format_extras: Record<string, unknown>;
}

interface JoinedRow {
  inbox_id: string;
  related_job_id: string | null;
  job_id: string | null;
  job_title: string | null;
  job_format: string | null;
  job_status: string | null;
  channel_id: string | null;
  channel_name: string | null;
  render_engine: string | null;
  production_version: string | null;
  render_started_at: string | null;
  render_completed_at: string | null;
  total_render_time_seconds: number | null;
  status_updated_at: string | null;
  final_video_size_bytes: string | null;
  final_video_duration_seconds: number | null;
  duration_frames: number | null;
  aspect_ratio: string | null;
  assembly_manifest: { scenes?: SceneRaw[] } | null;
  metadata: Record<string, unknown> | null;
}

interface SceneRaw {
  scene_index?: number;
  duration_frames?: number | null;
  visual_type?: string | null;
  paragraph?: string | null;
  sentence_images?: Array<{ r2_key?: string | null; sentence_text?: string }>;
}

function parseAspectDims(
  aspect: string | null,
): [number | null, number | null] {
  if (!aspect) return [null, null];
  const m = /^(\d+):(\d+)$/.exec(aspect);
  if (!m) return [null, null];
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (w === 16 && h === 9) return [1920, 1080];
  if (w === 9 && h === 16) return [1080, 1920];
  if (w === 1 && h === 1) return [1080, 1080];
  if (w === 4 && h === 3) return [1440, 1080];
  return [null, null];
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function basenameSafe(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/);
  const last = parts[parts.length - 1] || "";
  return /^[\w.\-]+\.(?:png|jpg|jpeg|webp|gif)$/i.test(last) ? last : null;
}

export async function getInboxItemPreview(
  itemId: string,
): Promise<InboxPreview | null> {
  const r = await pool.query<JoinedRow>(
    `SELECT i.id::text AS inbox_id,
            i.related_job_id::text AS related_job_id,
            j.id::text AS job_id,
            j.title AS job_title,
            j.format::text AS job_format,
            j.status::text AS job_status,
            j.channel_id::text AS channel_id,
            c.name AS channel_name,
            j.render_engine::text AS render_engine,
            j.production_version::text AS production_version,
            j.render_started_at::text AS render_started_at,
            j.render_completed_at::text AS render_completed_at,
            j.total_render_time_seconds,
            j.status_updated_at::text AS status_updated_at,
            j.final_video_size_bytes::text AS final_video_size_bytes,
            j.final_video_duration_seconds,
            j.duration_frames,
            j.aspect_ratio,
            j.assembly_manifest,
            j.metadata
       FROM inbox_items i
       LEFT JOIN content_jobs j ON j.id = i.related_job_id
       LEFT JOIN channels c ON c.id = j.channel_id
      WHERE i.id = $1
      LIMIT 1`,
    [itemId],
  );
  const row = r.rows[0];
  if (!row) return null;

  // No related job → return preview shell only.
  if (!row.job_id) {
    return {
      inbox_item_id: row.inbox_id,
      job: null,
      video: null,
      scenes: [],
      stats: [],
      format_extras: {},
    };
  }

  const sizeMb = row.final_video_size_bytes
    ? Math.round(Number(row.final_video_size_bytes) / 1024 / 1024)
    : 0;
  const durationSec = row.final_video_duration_seconds ?? 0;
  const [w, h] = parseAspectDims(row.aspect_ratio);
  const fps =
    row.duration_frames && durationSec
      ? Math.round(row.duration_frames / durationSec)
      : null;
  const bitrate =
    durationSec > 0 && sizeMb > 0
      ? Math.round((sizeMb * 8192) / durationSec)
      : null;

  let video: InboxPreview["video"] = null;
  if (sizeMb > 0 || durationSec > 0) {
    video = {
      // No `/api` prefix: the client always prepends `/api/proxy`
      // (next.config.mjs rewrites `/api/proxy/:path*` to the forge-control
      // `/api/:path*`), so an `/api`-prefixed url here doubled up into
      // `/api/proxy/api/media/...` → forge-control saw `GET /api/api/media/...`
      // and 404'd. Verified: routes/media.ts mounts at `/api/media`.
      url: `/media/job/${row.job_id}/final.mp4`,
      poster_url: null,
      duration_sec: durationSec,
      size_mb: sizeMb,
      aspect_ratio: row.aspect_ratio,
      width: w,
      height: h,
      fps,
      bitrate_kbps: bitrate,
    };
  }

  // Build scenes — sample every Nth if there are >60.
  const am = row.assembly_manifest ?? {};
  const sceneList: SceneRaw[] = Array.isArray(am.scenes) ? am.scenes : [];
  const step = sceneList.length > 60 ? Math.ceil(sceneList.length / 60) : 1;
  const scenes: InboxPreview["scenes"] = [];
  for (let i = 0; i < sceneList.length; i += step) {
    if (scenes.length >= 60) break;
    const s = sceneList[i];
    const firstImg = Array.isArray(s.sentence_images)
      ? s.sentence_images[0]
      : null;
    const thumbBasename = basenameSafe(firstImg?.r2_key);
    scenes.push({
      index: typeof s.scene_index === "number" ? s.scene_index : i,
      thumb_url: thumbBasename
        ? `/media/job/${row.job_id}/asset/${thumbBasename}`
        : null,
      duration_sec:
        s.duration_frames && fps
          ? Math.round(s.duration_frames / fps)
          : s.duration_frames
            ? Math.round(s.duration_frames / 30)
            : 0,
      visual_type: s.visual_type ?? null,
      sentence: s.paragraph ?? firstImg?.sentence_text ?? null,
    });
  }
  if (video && scenes[0]?.thumb_url) {
    video.poster_url = scenes[0].thumb_url;
  }

  const stats: Array<{ label: string; value: string }> = [];
  if (durationSec > 0)
    stats.push({ label: "duration", value: formatDuration(durationSec) });
  if (sizeMb > 0) stats.push({ label: "size", value: `${sizeMb} MB` });
  if (sceneList.length > 0)
    stats.push({ label: "scenes", value: String(sceneList.length) });
  if (w && h)
    stats.push({
      label: "resolution",
      value: `${w}×${h}${fps ? " · " + fps + "fps" : ""}`,
    });
  if (bitrate) stats.push({ label: "bitrate", value: `${bitrate} kbps` });
  if (row.aspect_ratio)
    stats.push({ label: "aspect ratio", value: row.aspect_ratio });
  if (row.production_version)
    stats.push({
      label: "pipeline",
      value:
        row.production_version +
        (row.render_engine ? ` / ${row.render_engine}` : ""),
    });
  if (row.job_format) stats.push({ label: "format", value: row.job_format });
  if (row.channel_name)
    stats.push({ label: "channel", value: row.channel_name });
  if (row.total_render_time_seconds)
    stats.push({
      label: "render time",
      value: formatDuration(row.total_render_time_seconds),
    });

  return {
    inbox_item_id: row.inbox_id,
    job: {
      id: row.job_id,
      title: row.job_title ?? "",
      format: row.job_format ?? "",
      status: row.job_status ?? "",
      channel_id: row.channel_id ?? "",
      channel_name: row.channel_name,
      render_engine: row.render_engine,
      production_version: row.production_version ?? "V2",
      enqueued_for_qc_at: row.status_updated_at,
      render_started_at: row.render_started_at,
      render_completed_at: row.render_completed_at,
      total_render_time_seconds: row.total_render_time_seconds,
    },
    video,
    scenes,
    stats,
    format_extras: (row.metadata as Record<string, unknown>) ?? {},
  };
}

/** Look up `{channel_id}` for a content job — used by routes/media.ts to
 *  build the on-disk path without trusting the URL. */
export async function getJobChannelId(jobId: string): Promise<string | null> {
  const r = await pool.query<{ channel_id: string }>(
    `SELECT channel_id::text FROM content_jobs WHERE id = $1 LIMIT 1`,
    [jobId],
  );
  return r.rows[0]?.channel_id ?? null;
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

/** Bulk-dismiss every currently open inbox item — the Today screen's "NEEDS
 *  YOU" panel is just a 3-item preview of this same open set (see
 *  getTodayPayload below), so "clear the important box" means resolving
 *  all of it, not only the 3 shown. Reuses resolveInbox() per item (not a
 *  single bulk UPDATE) so each one still gets its decision-log row and HCP
 *  relay — a dismiss is a real resolution, not a silent hide. One item
 *  failing doesn't block the rest. */
export async function resolveAllOpenInbox(
  resolvedBy = "user",
): Promise<{ resolved: number; failed: number }> {
  const open = await listOpenInbox(500);
  const results = await Promise.allSettled(
    open.map((i) =>
      resolveInbox(i.id, resolvedBy, {
        action: "resolve",
        reason: "cleared from Today",
      }),
    ),
  );
  const resolved = results.filter(
    (r) => r.status === "fulfilled" && r.value !== null,
  ).length;
  return { resolved, failed: open.length - resolved };
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

/**
 * `day`, given alone, scopes to one Europe/Berlin calendar day (the JOURNAL
 * timeline's per-day decisions stream) — matched via `AT TIME ZONE`, not a JS
 * UTC-midnight range, for the same reason lib/day-score.ts's berlinDay() exists:
 * this box's clock is UTC and a naive range would put entries between
 * 22:00–00:00 UTC on the wrong day. `from`/`to` are a raw timestamptz range for
 * callers that already have instants. Both may be passed; `day` takes
 * precedence when it disagrees with a `from`/`to` that spans multiple days.
 */
export async function listDecisions(
  limit = 50,
  filters: { day?: string; from?: string; to?: string } = {},
): Promise<Decision[]> {
  const r = await pool.query<Decision>(
    `SELECT id, ts::text AS ts, kind, actor, action, payload,
            inbox_item_id, related_job_id
       FROM decisions
      WHERE ($2::date IS NULL OR (ts AT TIME ZONE 'Europe/Berlin')::date = $2::date)
        AND ($3::timestamptz IS NULL OR ts >= $3::timestamptz)
        AND ($4::timestamptz IS NULL OR ts < $4::timestamptz)
      ORDER BY ts DESC
      LIMIT $1`,
    [limit, filters.day ?? null, filters.from ?? null, filters.to ?? null],
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
    /** "active" = a general-purpose worker that's running but isn't in the
     *  orchestrator/render buckets. Added alongside the today.ts fix that
     *  stopped forcing every running non-orchestrator worker to "idle". */
    status: "routing" | "render" | "active" | "idle" | "stuck";
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
