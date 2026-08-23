import { Hono } from "hono";
import {
  getInboxItemPreview,
  listOpenInbox,
  listResolvedInbox,
  resolveInbox,
  resolveAllOpenInbox,
} from "../db/ai_os.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* `?status=open` (default, unchanged) | `resolved` | `all`. `all` merges both
 * lists and re-sorts by created_at since the two source queries are each
 * sorted on a different column (created_at vs resolved_at). */
r.get("/", async (c) => {
  const limit = Math.min(
    200,
    Math.max(1, Number(c.req.query("limit") ?? "50")),
  );
  const status = c.req.query("status") ?? "open";

  if (status === "resolved") {
    const items = await listResolvedInbox(limit);
    return c.json({ count: items.length, items });
  }
  if (status === "all") {
    const [open, resolved] = await Promise.all([
      listOpenInbox(limit),
      listResolvedInbox(limit),
    ]);
    const items = [...open, ...resolved].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    return c.json({ count: items.length, items });
  }
  if (status !== "open") {
    return c.json({ error: "status must be one of open|resolved|all" }, 400);
  }

  const items = await listOpenInbox(limit);
  return c.json({ count: items.length, items });
});

/* Bulk-dismiss every open item — the Today screen's "NEEDS YOU" clear-all
 * button. Mounted before /:id/* so the literal "resolve-all" segment can't
 * be swallowed by a param route (it can't here since :id routes are
 * suffixed, but keeping the literal route first is the defensive habit). */
r.post("/resolve-all", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    resolved_by?: string;
  };
  const result = await resolveAllOpenInbox(body.resolved_by ?? "user");
  return c.json(result);
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
