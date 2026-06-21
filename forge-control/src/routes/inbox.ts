import { Hono } from "hono";
import {
  getInboxItemPreview,
  listOpenInbox,
  resolveInbox,
} from "../db/ai_os.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

r.get("/", async (c) => {
  const limit = Math.min(
    200,
    Math.max(1, Number(c.req.query("limit") ?? "50")),
  );
  const items = await listOpenInbox(limit);
  return c.json({ count: items.length, items });
});

/* GET /:id/preview — rich preview payload for the inbox detail pane.
 * v1.6 phase 3. Returns the inbox item joined with content_jobs (via
 * related_job_id) so the UI can render video player + scene thumbs +
 * stats grid instead of just title + buttons. Returns `{ job: null,
 * video: null }` when no job is linked (early-stage approvals like
 * AWAITING_IMAGE_QC). */
r.get("/:id/preview", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid inbox item id" }, 400);
  const preview = await getInboxItemPreview(id);
  if (!preview) return c.json({ error: "inbox item not found" }, 404);
  return c.json({ preview });
});

r.post("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid inbox item id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    resolved_by?: string;
    resolution?: Record<string, unknown>;
  };
  const item = await resolveInbox(
    id,
    body.resolved_by ?? "user",
    body.resolution ?? {},
  );
  if (!item)
    return c.json({ error: "item not found or already resolved" }, 404);
  return c.json({ item });
});

export default r;
