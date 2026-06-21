/**
 * Inbound webhook receiver.
 *
 * Mount path: `/webhooks/in/:slug` (NOT under /api/* — external services hit
 * this URL directly). The request is HMAC-validated against the stored
 * `webhooks.secret`. On success the receiver:
 *   1. Renders the webhook's prompt_template with `{{ body.field }}` slots
 *   2. Creates a new `runs` row (status=queued) so the executor picks it up
 *   3. Records the fire for the management UI
 *
 * On signature failure: 401 with no diagnostic info (defense against probe
 * attempts). The webhook's last_error is populated for the UI to surface.
 */
import { Hono } from "hono";
import {
  lookupBySlug,
  verifySignature,
  renderTemplate,
  recordFire,
  recordError,
} from "../db/webhooks.ts";
import { createRun } from "../db/runs.ts";

const r = new Hono();

r.post("/in/:slug", async (c) => {
  const slug = c.req.param("slug");
  const w = await lookupBySlug(slug);
  if (!w || !w.enabled) {
    // Same response shape on either missing or disabled so the prober can't
    // distinguish.
    return c.json({ error: "not found" }, 404);
  }

  // Raw body is needed for HMAC; Hono parses JSON lazily.
  const rawBody = await c.req.text();
  const sig =
    c.req.header("x-forge-signature") ??
    c.req.header("x-hub-signature-256") ?? // GitHub-style
    null;

  if (!verifySignature(rawBody, sig, w.secret)) {
    await recordError(w.id, "signature mismatch");
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      await recordError(w.id, "invalid JSON body");
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }

  let prompt: string;
  try {
    prompt = renderTemplate(w.prompt_template, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordError(w.id, `template render failed: ${msg}`);
    return c.json({ error: "template render failed" }, 500);
  }

  const titleTpl = w.title_template ?? `webhook: ${w.name}`;
  const title = renderTemplate(titleTpl, body).slice(0, 200) || `webhook: ${w.name}`;

  try {
    const run = await createRun({
      title,
      prompt,
      worker: w.worker_label ?? undefined,
      metadata: {
        source: "webhook",
        webhook_id: w.id,
        webhook_slug: w.slug,
        received_at: new Date().toISOString(),
      },
    });
    await recordFire(w.id, run.id);
    return c.json({ accepted: true, run_id: run.id }, 202);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordError(w.id, `run creation failed: ${msg}`);
    return c.json({ error: "run creation failed" }, 500);
  }
});

export default r;
