/**
 * Webhook management routes — CRUD for the management UI.
 * The inbound receiver lives at routes/webhook-in.ts (unauthenticated,
 * HMAC-validated, mounted at /webhooks/in/:slug NOT /api/...).
 */
import { Hono } from "hono";
import {
  listWebhooks,
  getWebhookById,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateSecret,
  lookupBySlug,
} from "../db/webhooks.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

r.get("/", async (c) => {
  const webhooks = await listWebhooks();
  return c.json({ count: webhooks.length, webhooks });
});

r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid webhook id" }, 400);
  const w = await getWebhookById(id);
  if (!w) return c.json({ error: "webhook not found" }, 404);
  return c.json({ webhook: w });
});

r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    name?: string;
    description?: string;
    prompt_template?: string;
    title_template?: string;
    worker_label?: string;
    enabled?: boolean;
  };

  const slug = (body.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return c.json(
      {
        error:
          "slug must be 3-64 chars, lowercase letters/digits/dashes, not starting or ending with a dash",
      },
      400,
    );
  }
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const prompt_template = (body.prompt_template ?? "").trim();
  if (!prompt_template) {
    return c.json({ error: "prompt_template required" }, 400);
  }

  // Surface a friendly error if the slug is already taken (unique constraint).
  if (await lookupBySlug(slug)) {
    return c.json({ error: `slug "${slug}" already exists` }, 409);
  }

  const { webhook, raw_secret } = await createWebhook({
    slug,
    name,
    description: body.description,
    prompt_template,
    title_template: body.title_template,
    worker_label: body.worker_label,
    enabled: body.enabled,
  });
  // Return the *full* unmasked secret one time on create so the user can copy it.
  // Subsequent fetches only show the preview.
  return c.json({ webhook, raw_secret, secret_once: raw_secret }, 201);
});

r.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid webhook id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof updateWebhook>[1] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.description === "string" || body.description === null) {
    patch.description = body.description as string | null;
  }
  if (typeof body.prompt_template === "string") {
    patch.prompt_template = body.prompt_template;
  }
  if (typeof body.title_template === "string" || body.title_template === null) {
    patch.title_template = body.title_template as string | null;
  }
  if (typeof body.worker_label === "string" || body.worker_label === null) {
    patch.worker_label = body.worker_label as string | null;
  }
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  const w = await updateWebhook(id, patch);
  if (!w) return c.json({ error: "webhook not found" }, 404);
  return c.json({ webhook: w });
});

r.post("/:id/rotate-secret", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid webhook id" }, 400);
  const fresh = await rotateSecret(id);
  if (!fresh) return c.json({ error: "webhook not found" }, 404);
  // Return the fresh secret one time so the user can update external services.
  return c.json({ secret: fresh });
});

r.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid webhook id" }, 400);
  const ok = await deleteWebhook(id);
  if (!ok) return c.json({ error: "webhook not found" }, 404);
  return c.json({ deleted: true });
});

export default r;
