/**
 * Project-task recovery surface (Step 4 of rework-2026-08-04/01-execution-layer.md).
 *
 * Before this, a task that failed could only be moved with hand-written SQL:
 * promoteReadyTasks() requires every earlier-round task to be 'done', so one
 * failure froze a project permanently (E3 — canvas-ux and live-agent-panel
 * have been wedged since 2026-07-30).
 *
 * Mounted at /api/tasks. Deliberately a separate router from /api/projects:
 * Step 11 of the design turns /api/tasks into the unified dispatch verb, and
 * this is where it will live.
 */

import { Hono } from "hono";
import {
  getTask,
  retryTask,
  MAX_TASK_ATTEMPTS,
} from "../db/projects.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid task id" }, 400);
  const task = await getTask(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json({ task });
});

/* failed|blocked -> ready. `force: true` overrides the attempt cap — that is
 * an operator decision, never an automatic one. */
r.post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid task id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };

  const out = await retryTask(id, { force: body.force === true });
  if (out.ok) {
    console.log(
      `[tasks] retry ${id} → ready (attempt ${out.task.attempt}` +
        `${out.project_resumed ? ", project un-blocked" : ""})`,
    );
    return c.json({
      task: out.task,
      project_resumed: out.project_resumed,
      attempts_left: Math.max(0, MAX_TASK_ATTEMPTS - out.task.attempt),
    });
  }
  if (out.reason === "not_found") return c.json({ error: "task not found" }, 404);
  if (out.reason === "attempts_exhausted") {
    return c.json(
      {
        error:
          `task has already used ${out.task?.attempt ?? 0}/${MAX_TASK_ATTEMPTS} retries — ` +
          `re-send with {"force":true} to override`,
        task: out.task,
      },
      409,
    );
  }
  return c.json(
    {
      error: `task status '${out.task?.status}' is not retryable (need failed or blocked)`,
      task: out.task,
    },
    409,
  );
});

export default r;
