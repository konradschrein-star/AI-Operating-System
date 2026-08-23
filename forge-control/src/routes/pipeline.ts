import { Hono } from "hono";
import pg from "pg";
import { getPipeline, getWorkerHealth } from "../db/pipeline.ts";
import { probeQueueDepths } from "../lib/redis-probe.ts";
import { phaseFor } from "../lib/pipeline-health.ts";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:90d4iBxMYP6m3DYrsP1fjSSU7uWDVE@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (e) => console.error("[pipeline route pool]", e.message));

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VALID_JOB_STATUSES = new Set([
  "IDEA_GENERATION",
  "SCRIPTING",
  "AWAITING_RESEARCH",
  "RESEARCH_UPLOADED",
  "TRANSLATING",
  "ASSET_COLLECTION",
  "QMS_VALIDATING",
  "ROUTING_RENDER",
  "RENDERING_FFMPEG",
  "RENDERING_REMOTION",
  "AWAITING_PRODUCTION_VA",
  "AWAITING_IMAGE_QC",
  "AWAITING_QC",
  "AWAITING_UPLOADER",
  "UPLOADING",
  "PUBLISHED",
  "CANCELLED",
  "DELETED",
  "FAILED_QMS",
  "FAILED_RENDER",
  "FAILED_UPLOAD",
  "FAILED_GENERAL",
  "FAILED_IRRECOVERABLE",
  "PAUSED",
  "MARKED_FOR_DELETION",
  "CLIP_SELECTION",
  "AWAITING_CLIP_REVIEW",
  "FAILED_CLIP_SELECTION",
  "SPACE_TTS_GENERATING",
  "SPACE_TRANSCRIBING",
  "SPACE_PROMPT_GENERATING",
  "SPACE_IMAGE_GENERATING",
  "SPACE_VIDEO_GENERATING",
  "SPACE_ASSEMBLING",
  "FAILED_SPACE_PIPELINE",
  "DRAMA_TTS_GENERATING",
  "DRAMA_TRANSCRIBING",
  "DRAMA_PROMPT_GENERATING",
  "DRAMA_IMAGE_GENERATING",
  "DRAMA_VIDEO_GENERATING",
  "DRAMA_ASSEMBLING",
  "DRAMA_QC",
  "DRAMA_QC_FAILED",
  "FAILED_DRAMA_PIPELINE",
  "REACTOR_DOWNLOADING",
  "REACTOR_TRANSCRIBING",
  "REACTOR_SCRIPTING",
  "REACTOR_TTS_GENERATING",
  "REACTOR_ASSEMBLING",
  "FAILED_REACTOR_PIPELINE",
  "TECH_FOOTAGE_COLLECTING",
  "TECH_FOOTAGE_FAILED",
  "AWAITING_VA_REVIEW",
]);

const r = new Hono();

/**
 * Helper to dispatch jobs to Content Forge BullMQ queues if reachable.
 * Degrades gracefully if Redis or @repo/queue is unreachable.
 */
async function tryDispatchQueue(
  queueName: string,
  jobName: string,
  payload: Record<string, unknown>,
): Promise<{ dispatched: boolean; error?: string }> {
  try {
    const queuePkg = await import(
      "/opt/content-forge/packages/queue/dist/index.js"
    );
    const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    const conn = queuePkg.createRedisConnection({
      url: redisUrl,
      mode: "queue",
    });

    let queue: { add: (name: string, data: any, opts?: any) => Promise<unknown> } | null = null;
    if (queueName === "queue-render-heavy") {
      queue = queuePkg.createRenderHeavyQueue(conn);
    } else if (queueName === "queue-qms-validation") {
      queue = queuePkg.createQMSValidationQueue(conn);
    } else if (queueName === "queue-asset-collection") {
      queue = queuePkg.createAssetCollectionQueue(conn);
    } else if (queueName === "queue-ai-generation") {
      queue = queuePkg.createAIGenerationQueue(conn);
    } else if (queueName === "queue-clip-selection") {
      queue = queuePkg.createClipSelectionQueue(conn);
    } else if (queueName === "queue-bundestag-clip-analysis") {
      queue = queuePkg.createBundestagClipAnalysisQueue(conn);
    } else if (queueName === "queue-bundestag-playbook-generation") {
      queue = queuePkg.createBundestagPlaybookGenerationQueue(conn);
    } else if (queueName === "queue-bundestag-render") {
      queue = queuePkg.createBundestagRenderQueue(conn);
    }

    if (!queue) {
      await conn.quit();
      return { dispatched: false, error: `Unknown queue ${queueName}` };
    }

    await queue.add(jobName, payload);
    await conn.quit();
    return { dispatched: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pipeline queue dispatch failed: ${queueName}]`, msg);
    return { dispatched: false, error: msg };
  }
}

/**
 * Normalise human-friendly stage alias to a valid job_status enum and queue.
 */
function resolveStageAlias(stage: string): { status: string; queueName: string | null } | null {
  const norm = stage.trim().toUpperCase();
  if (norm === "RENDER" || norm === "ROUTING_RENDER") {
    return { status: "ROUTING_RENDER", queueName: "queue-render-heavy" };
  }
  if (norm === "QC" || norm === "QMS_VALIDATING") {
    return { status: "QMS_VALIDATING", queueName: "queue-qms-validation" };
  }
  if (norm === "ASSETS" || norm === "ASSET_COLLECTION") {
    return { status: "ASSET_COLLECTION", queueName: "queue-asset-collection" };
  }
  if (norm === "SCRIPT" || norm === "SCRIPTING") {
    return { status: "SCRIPTING", queueName: "queue-ai-generation" };
  }
  if (norm === "PUBLISH" || norm === "AWAITING_UPLOADER") {
    return { status: "AWAITING_UPLOADER", queueName: null };
  }
  if (norm === "AWAITING_QC") {
    return { status: "AWAITING_QC", queueName: null };
  }
  if (norm === "CLIP_SELECTION") {
    return { status: "CLIP_SELECTION", queueName: "queue-clip-selection" };
  }
  if (VALID_JOB_STATUSES.has(norm)) {
    return { status: norm, queueName: null };
  }
  return null;
}

/**
 * Determine default retry target stage and queue based on failure type and format.
 */
function determineRetryStage(
  currentStatus: string,
  format: string,
  hasScript: boolean,
): { targetStatus: string; queueName: string | null } {
  if (currentStatus === "FAILED_RENDER") {
    return {
      targetStatus: "ROUTING_RENDER",
      queueName: "queue-render-heavy",
    };
  }
  if (currentStatus === "FAILED_QMS" || currentStatus === "DRAMA_QC_FAILED") {
    return {
      targetStatus: "ASSET_COLLECTION",
      queueName: "queue-asset-collection",
    };
  }
  if (currentStatus === "FAILED_CLIP_SELECTION") {
    return {
      targetStatus: "CLIP_SELECTION",
      queueName: "queue-clip-selection",
    };
  }
  if (currentStatus === "FAILED_UPLOAD") {
    return { targetStatus: "AWAITING_UPLOADER", queueName: null };
  }
  if (currentStatus === "FAILED_SPACE_PIPELINE") {
    return {
      targetStatus: "SPACE_TTS_GENERATING",
      queueName: null,
    };
  }
  if (currentStatus === "FAILED_DRAMA_PIPELINE") {
    return {
      targetStatus: "DRAMA_TTS_GENERATING",
      queueName: null,
    };
  }
  if (currentStatus === "FAILED_REACTOR_PIPELINE") {
    return {
      targetStatus: "REACTOR_DOWNLOADING",
      queueName: null,
    };
  }
  if (currentStatus === "TECH_FOOTAGE_FAILED") {
    return {
      targetStatus: "TECH_FOOTAGE_COLLECTING",
      queueName: null,
    };
  }

  // Standard pipeline formats
  return hasScript
    ? {
        targetStatus: "ASSET_COLLECTION",
        queueName: "queue-asset-collection",
      }
    : { targetStatus: "SCRIPTING", queueName: "queue-ai-generation" };
}

/**
 * Determine default stage progression.
 */
function determineAdvanceStage(currentStatus: string): {
  targetStatus: string;
  queueName: string | null;
  requiresQCApproval?: boolean;
} | null {
  switch (currentStatus) {
    case "AWAITING_QC":
      return {
        targetStatus: "AWAITING_UPLOADER",
        queueName: null,
        requiresQCApproval: true,
      };
    case "AWAITING_IMAGE_QC":
    case "AWAITING_PRODUCTION_VA":
    case "AWAITING_VA_REVIEW":
    case "AWAITING_CLIP_REVIEW":
      return {
        targetStatus: "QMS_VALIDATING",
        queueName: "queue-qms-validation",
      };
    case "QMS_VALIDATING":
      return {
        targetStatus: "ROUTING_RENDER",
        queueName: "queue-render-heavy",
      };
    case "AWAITING_UPLOADER":
      return { targetStatus: "UPLOADING", queueName: null };
    case "SCRIPTING":
      return {
        targetStatus: "ASSET_COLLECTION",
        queueName: "queue-asset-collection",
      };
    case "ASSET_COLLECTION":
      return {
        targetStatus: "QMS_VALIDATING",
        queueName: "queue-qms-validation",
      };
    default:
      return null;
  }
}

/**
 * GET /api/pipeline — Content Forge state, additively extended by phase 5.
 */
r.get("/", async (c) => {
  const [pipeline, workers, queues] = await Promise.all([
    getPipeline(),
    getWorkerHealth(),
    probeQueueDepths(),
  ]);
  return c.json({ ...pipeline, workers, queues });
});

/**
 * GET /api/pipeline/meta — Channels, active templates, and VA users directory.
 */
r.get("/meta", async (c) => {
  try {
    const [channelsRes, templatesRes, usersRes] = await Promise.all([
      pool.query<{
        id: string;
        name: string;
        youtube_channel_id: string;
        description: string | null;
        language: string;
      }>(
        `SELECT id::text, name, youtube_channel_id, description, language
           FROM channels
          ORDER BY name ASC`,
      ),
      pool.query<{
        id: string;
        name: string;
        format: string;
        description: string;
        is_active: boolean;
      }>(
        `SELECT id::text, name, format::text AS format, description, is_active
           FROM content_templates
          WHERE is_active = true
          ORDER BY name ASC`,
      ),
      pool.query<{
        id: string;
        name: string;
        email: string;
        role: string;
        is_active: boolean;
      }>(
        `SELECT id::text, name, email, role::text AS role, is_active
           FROM users
          WHERE is_active = true
          ORDER BY name ASC`,
      ),
    ]);

    return c.json({
      channels: channelsRes.rows,
      templates: templatesRes.rows,
      users: usersRes.rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: "Failed to fetch pipeline metadata", details: message },
      500,
    );
  }
});

/**
 * GET /api/pipeline/jobs/:id — Detailed job inspection with script, manifests, history, logs.
 */
r.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid job id (expected uuid)" }, 400);
  }

  try {
    const result = await pool.query<{
      id: string;
      title: string;
      description: string;
      status: string;
      format: string;
      production_version: string;
      channel_id: string | null;
      channel_name: string;
      youtube_channel_id: string | null;
      template_id: string | null;
      template_name: string;
      initial_topic: string | null;
      script: string | null;
      generated_tags: string[] | null;
      language: string;
      aspect_ratio: string | null;
      target_duration_seconds: number | null;
      duration_frames: number | null;
      render_engine: string | null;
      render_started_at: string | null;
      render_completed_at: string | null;
      total_render_time_seconds: number | null;
      final_video_size_bytes: string | null;
      final_video_duration_seconds: number | null;
      final_video_path: string | null;
      youtube_video_id: string | null;
      published_at: string | null;
      views: number | null;
      revenue_cents: number | null;
      error_message: string | null;
      error_detail: unknown;
      error_metadata: unknown;
      retry_count: number;
      qc_feedback: string | null;
      qc_reviewed_at: string | null;
      assigned_production_va_id: string | null;
      production_va_name: string | null;
      production_va_email: string | null;
      production_va_time_spent_seconds: number | null;
      assigned_uploader_va_id: string | null;
      uploader_va_name: string | null;
      uploader_va_email: string | null;
      uploader_va_time_spent_seconds: number | null;
      assembly_manifest: unknown;
      r2_asset_manifest: unknown;
      state_machine_history: unknown;
      generation_log: unknown;
      metadata: unknown;
      created_at: string;
      updated_at: string;
      status_updated_at: string;
    }>(
      `SELECT j.id::text,
              j.title,
              j.description,
              j.status::text AS status,
              j.format::text AS format,
              j.production_version::text AS production_version,
              j.channel_id::text AS channel_id,
              COALESCE(c.name, '—') AS channel_name,
              c.youtube_channel_id,
              j.template_id::text AS template_id,
              COALESCE(t.name, '—') AS template_name,
              j.initial_topic,
              j.script,
              j.generated_tags,
              j.language,
              j.aspect_ratio,
              j.target_duration_seconds,
              j.duration_frames,
              j.render_engine::text AS render_engine,
              j.render_started_at::text AS render_started_at,
              j.render_completed_at::text AS render_completed_at,
              j.total_render_time_seconds,
              j.final_video_size_bytes::text AS final_video_size_bytes,
              j.final_video_duration_seconds,
              j.final_video_path,
              j.youtube_video_id,
              j.published_at::text AS published_at,
              j.views,
              j.revenue_cents,
              j.error_message,
              j.error_detail,
              j.error_metadata,
              j.retry_count,
              j.qc_feedback,
              j.qc_reviewed_at::text AS qc_reviewed_at,
              j.assigned_production_va_id::text AS assigned_production_va_id,
              pva.name AS production_va_name,
              pva.email AS production_va_email,
              j.production_va_time_spent_seconds,
              j.assigned_uploader_va_id::text AS assigned_uploader_va_id,
              uva.name AS uploader_va_name,
              uva.email AS uploader_va_email,
              j.uploader_va_time_spent_seconds,
              j.assembly_manifest,
              j.r2_asset_manifest,
              j.state_machine_history,
              j.generation_log,
              j.metadata,
              j.created_at::text AS created_at,
              j.updated_at::text AS updated_at,
              j.status_updated_at::text AS status_updated_at
         FROM content_jobs j
         LEFT JOIN channels c ON c.id = j.channel_id
         LEFT JOIN content_templates t ON t.id = j.template_id
         LEFT JOIN users pva ON pva.id = j.assigned_production_va_id
         LEFT JOIN users uva ON uva.id = j.assigned_uploader_va_id
        WHERE j.id = $1::uuid`,
      [id],
    );

    const row = result.rows[0];
    if (!row) {
      return c.json({ error: "job not found" }, 404);
    }

    const hubUrl = `https://hub.schreinercontentsystems.com/jobs/${row.id}`;
    const phase = phaseFor(row.status);

    return c.json({
      job: {
        ...row,
        hub_url: hubUrl,
        phase,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: "Failed to fetch job detail", details: message },
      500,
    );
  }
});

/**
 * POST /api/pipeline/jobs/:id/retry — Stage retry with status validation and queue re-dispatch.
 */
r.post("/jobs/:id/retry", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid job id (expected uuid)" }, 400);
  }

  let body: { target_stage?: string; reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional
  }

  try {
    const existing = await pool.query<{
      id: string;
      title: string;
      status: string;
      format: string;
      script: string | null;
      initial_topic: string | null;
      template_id: string | null;
      metadata: unknown;
      retry_count: number;
    }>(
      `SELECT id::text, title, status::text AS status, format::text AS format,
              script, initial_topic, template_id::text AS template_id, metadata, retry_count
         FROM content_jobs
        WHERE id = $1::uuid`,
      [id],
    );

    const job = existing.rows[0];
    if (!job) {
      return c.json({ error: "job not found" }, 404);
    }

    if (job.status === "FAILED_IRRECOVERABLE") {
      return c.json(
        {
          error:
            "Cannot retry FAILED_IRRECOVERABLE job — requires manual human intervention",
        },
        409,
      );
    }

    let targetStatus: string;
    let queueName: string | null = null;

    if (body.target_stage && body.target_stage.trim()) {
      const resolved = resolveStageAlias(body.target_stage);
      if (!resolved) {
        return c.json(
          {
            error: `Invalid target stage: ${body.target_stage}`,
          },
          400,
        );
      }
      targetStatus = resolved.status;
      queueName = resolved.queueName;
    } else {
      const strategy = determineRetryStage(
        job.status,
        job.format,
        (job.script ?? "").trim().length > 0,
      );
      targetStatus = strategy.targetStatus;
      queueName = strategy.queueName;
    }

    const historyEntry = {
      from: job.status,
      to: targetStatus,
      timestamp: new Date().toISOString(),
      actor: "aios-operator",
      reason: body.reason || `Manual retry from ${job.status}`,
    };

    const updateRes = await pool.query<{
      id: string;
      title: string;
      status: string;
      retry_count: number;
      status_updated_at: string;
    }>(
      `UPDATE content_jobs
          SET status = $1,
              retry_count = retry_count + 1,
              error_message = NULL,
              error_detail = NULL,
              updated_at = NOW(),
              status_updated_at = NOW(),
              state_machine_history = COALESCE(state_machine_history, '[]'::jsonb) || $2::jsonb
        WHERE id = $3::uuid
        RETURNING id::text, title, status::text AS status, retry_count, status_updated_at::text`,
      [targetStatus, JSON.stringify([historyEntry]), id],
    );

    let queueResult: { dispatched: boolean; error?: string } = {
      dispatched: false,
    };

    if (queueName) {
      let payload: Record<string, unknown> = { job_id: id };
      if (queueName === "queue-render-heavy") {
        payload = { job_id: id, priority: 5 };
      } else if (queueName === "queue-qms-validation") {
        payload = { job_id: id, validation_stage: "pre-render" };
      } else if (queueName === "queue-ai-generation") {
        payload = {
          job_id: id,
          generation_type: "script",
          template_id: job.template_id,
          topic: (job.initial_topic ?? job.title ?? "").trim(),
        };
      }
      queueResult = await tryDispatchQueue(queueName, `retry-${id}`, payload);
    }

    return c.json({
      success: true,
      message: `Job ${id} retried (${job.status} → ${targetStatus})`,
      old_status: job.status,
      new_status: targetStatus,
      retry_count: updateRes.rows[0]?.retry_count ?? job.retry_count + 1,
      queue_name: queueName,
      queue_dispatched: queueResult.dispatched,
      queue_error: queueResult.error,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Failed to retry job", details: message }, 500);
  }
});

/**
 * POST /api/pipeline/jobs/:id/assign — Update VA assignments (production / uploader).
 */
r.post("/jobs/:id/assign", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid job id (expected uuid)" }, 400);
  }

  let body: {
    production_va_id?: string | null;
    uploader_va_id?: string | null;
    role?: "production" | "uploader";
    user_id?: string | null;
  } = {};

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let prodVaId: string | null | undefined = body.production_va_id;
  let uploaderVaId: string | null | undefined = body.uploader_va_id;

  if (body.role !== undefined && body.role !== "production" && body.role !== "uploader") {
    return c.json({ error: "invalid role (expected 'production' or 'uploader')" }, 400);
  }

  if (body.role === "production") {
    prodVaId = body.user_id;
  } else if (body.role === "uploader") {
    uploaderVaId = body.user_id;
  }

  if (prodVaId !== undefined && prodVaId !== null && !UUID_RE.test(prodVaId)) {
    return c.json({ error: "invalid production_va_id (expected uuid or null)" }, 400);
  }
  if (uploaderVaId !== undefined && uploaderVaId !== null && !UUID_RE.test(uploaderVaId)) {
    return c.json({ error: "invalid uploader_va_id (expected uuid or null)" }, 400);
  }

  try {
    const existing = await pool.query<{
      id: string;
      status: string;
      assigned_production_va_id: string | null;
      assigned_uploader_va_id: string | null;
    }>(
      `SELECT id::text, status::text AS status,
              assigned_production_va_id::text AS assigned_production_va_id,
              assigned_uploader_va_id::text AS assigned_uploader_va_id
         FROM content_jobs
        WHERE id = $1::uuid`,
      [id],
    );

    const job = existing.rows[0];
    if (!job) {
      return c.json({ error: "job not found" }, 404);
    }

    if (prodVaId) {
      const u = await pool.query("SELECT id FROM users WHERE id = $1::uuid", [
        prodVaId,
      ]);
      if (u.rows.length === 0) {
        return c.json({ error: `User ${prodVaId} not found` }, 404);
      }
    }

    if (uploaderVaId) {
      const u = await pool.query("SELECT id FROM users WHERE id = $1::uuid", [
        uploaderVaId,
      ]);
      if (u.rows.length === 0) {
        return c.json({ error: `User ${uploaderVaId} not found` }, 404);
      }
    }

    const setProd = prodVaId !== undefined;
    const setUploader = uploaderVaId !== undefined;

    const historyEntry = {
      from: job.status,
      to: job.status,
      timestamp: new Date().toISOString(),
      actor: "aios-operator",
      reason: `VA assignments updated: prod=${prodVaId ?? "unchanged"}, uploader=${uploaderVaId ?? "unchanged"}`,
    };

    const updateRes = await pool.query<{
      id: string;
      assigned_production_va_id: string | null;
      assigned_uploader_va_id: string | null;
      production_va_name: string | null;
      uploader_va_name: string | null;
    }>(
      `WITH updated AS (
         UPDATE content_jobs
            SET assigned_production_va_id = CASE WHEN $1::boolean THEN $2::uuid ELSE assigned_production_va_id END,
                assigned_uploader_va_id   = CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_uploader_va_id END,
                updated_at = NOW(),
                state_machine_history = COALESCE(state_machine_history, '[]'::jsonb) || $5::jsonb
          WHERE id = $6::uuid
          RETURNING id, assigned_production_va_id, assigned_uploader_va_id
       )
       SELECT u.id::text,
              u.assigned_production_va_id::text AS assigned_production_va_id,
              u.assigned_uploader_va_id::text AS assigned_uploader_va_id,
              pva.name AS production_va_name,
              uva.name AS uploader_va_name
         FROM updated u
         LEFT JOIN users pva ON pva.id = u.assigned_production_va_id
         LEFT JOIN users uva ON uva.id = u.assigned_uploader_va_id`,
      [
        setProd,
        prodVaId ?? null,
        setUploader,
        uploaderVaId ?? null,
        JSON.stringify([historyEntry]),
        id,
      ],
    );

    const updated = updateRes.rows[0];

    return c.json({
      success: true,
      message: "VA assignment updated successfully",
      job_id: id,
      assigned_production_va_id: updated?.assigned_production_va_id ?? null,
      production_va_name: updated?.production_va_name ?? null,
      assigned_uploader_va_id: updated?.assigned_uploader_va_id ?? null,
      uploader_va_name: updated?.uploader_va_name ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Failed to assign VA", details: message }, 500);
  }
});

/**
 * POST /api/pipeline/jobs/:id/advance — Stage advancement (QC approval, stage transition).
 */
r.post("/jobs/:id/advance", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid job id (expected uuid)" }, 400);
  }

  let body: {
    target_status?: string;
    reason?: string;
    feedback?: string;
  } = {};

  try {
    body = await c.req.json();
  } catch {
    // Body is optional
  }

  try {
    const existing = await pool.query<{
      id: string;
      title: string;
      status: string;
      format: string;
      assigned_uploader_va_id: string | null;
    }>(
      `SELECT id::text, title, status::text AS status, format::text AS format,
              assigned_uploader_va_id::text AS assigned_uploader_va_id
         FROM content_jobs
        WHERE id = $1::uuid`,
      [id],
    );

    const job = existing.rows[0];
    if (!job) {
      return c.json({ error: "job not found" }, 404);
    }

    let newStatus: string;
    let queueName: string | null = null;
    let isQCApproval = false;

    if (body.target_status && body.target_status.trim()) {
      const resolved = resolveStageAlias(body.target_status);
      if (!resolved) {
        return c.json(
          {
            error: `Invalid target status: ${body.target_status}`,
          },
          400,
        );
      }
      newStatus = resolved.status;
      queueName = resolved.queueName;
      if (job.status === "AWAITING_QC" && newStatus === "AWAITING_UPLOADER") {
        isQCApproval = true;
      }
    } else {
      const step = determineAdvanceStage(job.status);
      if (!step) {
        return c.json(
          {
            error: `Cannot automatically advance job in status: ${job.status}. Specify target_status explicitly.`,
          },
          400,
        );
      }
      newStatus = step.targetStatus;
      queueName = step.queueName;
      isQCApproval = step.requiresQCApproval ?? false;
    }

    let defaultUploaderId: string | null = null;
    if (isQCApproval && !job.assigned_uploader_va_id) {
      const uploaderRes = await pool.query<{ id: string }>(
        `SELECT id::text FROM users
          WHERE role = 'UPLOADER_VA' AND is_active = true
          ORDER BY created_at ASC
          LIMIT 1`,
      );
      defaultUploaderId = uploaderRes.rows[0]?.id ?? null;
    }

    const historyEntry = {
      from: job.status,
      to: newStatus,
      timestamp: new Date().toISOString(),
      actor: "aios-operator",
      reason:
        body.reason ||
        (isQCApproval
          ? `QC approved${body.feedback ? `: ${body.feedback}` : ""}`
          : `Stage advance from ${job.status}`),
    };

    const updateRes = await pool.query<{
      id: string;
      status: string;
      qc_reviewed_at: string | null;
      qc_feedback: string | null;
      assigned_uploader_va_id: string | null;
      status_updated_at: string;
    }>(
      `UPDATE content_jobs
          SET status = $1,
              qc_reviewed_at = CASE WHEN $2::boolean THEN NOW() ELSE qc_reviewed_at END,
              qc_feedback = CASE WHEN $2::boolean THEN $3 ELSE qc_feedback END,
              assigned_uploader_va_id = COALESCE(assigned_uploader_va_id, $4::uuid),
              updated_at = NOW(),
              status_updated_at = NOW(),
              state_machine_history = COALESCE(state_machine_history, '[]'::jsonb) || $5::jsonb
        WHERE id = $6::uuid
        RETURNING id::text, status::text AS status,
                  qc_reviewed_at::text AS qc_reviewed_at,
                  qc_feedback,
                  assigned_uploader_va_id::text AS assigned_uploader_va_id,
                  status_updated_at::text AS status_updated_at`,
      [
        newStatus,
        isQCApproval,
        body.feedback ?? null,
        defaultUploaderId,
        JSON.stringify([historyEntry]),
        id,
      ],
    );

    let queueResult: { dispatched: boolean; error?: string } = {
      dispatched: false,
    };

    if (queueName) {
      let payload: Record<string, unknown> = { job_id: id };
      if (queueName === "queue-render-heavy") {
        payload = { job_id: id, priority: 5 };
      } else if (queueName === "queue-qms-validation") {
        payload = { job_id: id, validation_stage: "pre-render" };
      }
      queueResult = await tryDispatchQueue(queueName, `advance-${id}`, payload);
    }

    return c.json({
      success: true,
      message: `Job ${id} advanced from ${job.status} to ${newStatus}`,
      old_status: job.status,
      new_status: newStatus,
      qc_reviewed_at: updateRes.rows[0]?.qc_reviewed_at ?? null,
      assigned_uploader_va_id:
        updateRes.rows[0]?.assigned_uploader_va_id ?? null,
      queue_name: queueName,
      queue_dispatched: queueResult.dispatched,
      queue_error: queueResult.error,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Failed to advance job", details: message }, 500);
  }
});

export default r;

