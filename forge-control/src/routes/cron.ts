/**
 * Cron schedule management routes — CRUD + dry-run preview.
 * Scheduler tick runs in src/index.ts startup so the management UI
 * doesn't need to be loaded for fires to happen.
 */
import { Hono } from "hono";
import {
  listSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  validateCronExpr,
} from "../db/cron.ts";
import { nextFireFromExpr } from "../lib/cron-parser.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

r.get("/", async (c) => {
  const schedules = await listSchedules();
  return c.json({ count: schedules.length, schedules });
});

r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid schedule id" }, 400);
  const s = await getScheduleById(id);
  if (!s) return c.json({ error: "schedule not found" }, 404);
  return c.json({ schedule: s });
});

/** Dry-run a cron expression to preview the next N fires. Used by the
 *  ScheduleBuilder UI to confirm an expression behaves as intended. */
r.post("/preview", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    cron_expr?: string;
    count?: number;
  };
  const expr = (body.cron_expr ?? "").trim();
  const count = Math.min(20, Math.max(1, Number(body.count ?? 5)));
  if (!expr) return c.json({ error: "cron_expr required" }, 400);
  try {
    validateCronExpr(expr);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "invalid cron" },
      400,
    );
  }
  const fires: string[] = [];
  let from = new Date();
  for (let i = 0; i < count; i++) {
    const f = nextFireFromExpr(expr, from);
    fires.push(f.toISOString());
    from = f;
  }
  return c.json({ cron_expr: expr, count, fires });
});

r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    cron_expr?: string;
    prompt_template?: string;
    title_template?: string;
    worker_label?: string;
    enabled?: boolean;
  };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const cron_expr = (body.cron_expr ?? "").trim();
  if (!cron_expr) return c.json({ error: "cron_expr required" }, 400);
  const prompt_template = (body.prompt_template ?? "").trim();
  if (!prompt_template) {
    return c.json({ error: "prompt_template required" }, 400);
  }
  try {
    validateCronExpr(cron_expr);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "invalid cron" },
      400,
    );
  }
  const s = await createSchedule({
    name,
    description: body.description,
    cron_expr,
    prompt_template,
    title_template: body.title_template,
    worker_label: body.worker_label,
    enabled: body.enabled,
  });
  return c.json({ schedule: s }, 201);
});

r.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid schedule id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof updateSchedule>[1] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.description === "string" || body.description === null) {
    patch.description = body.description as string | null;
  }
  if (typeof body.cron_expr === "string") {
    try {
      validateCronExpr(body.cron_expr);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "invalid cron" },
        400,
      );
    }
    patch.cron_expr = body.cron_expr;
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

  const s = await updateSchedule(id, patch);
  if (!s) return c.json({ error: "schedule not found" }, 404);
  return c.json({ schedule: s });
});

r.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid schedule id" }, 400);
  const ok = await deleteSchedule(id);
  if (!ok) return c.json({ error: "schedule not found" }, 404);
  return c.json({ deleted: true });
});

export default r;
