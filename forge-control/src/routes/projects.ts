import { Hono } from "hono";
import {
  listProjects,
  getProject,
  createProject,
  setProjectWorkspace,
  setProjectStatus,
  listTasksForProject,
  listActiveTasks,
  listManagerRollup,
  createTask,
  unwedgeProject,
  type ProjectRepo,
  type ProjectStatus,
  type TaskRole,
  type TaskTier,
} from "../db/projects.ts";
import { provisionWorkspace, removeWorkspace } from "../lib/workspace.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOS = new Set<ProjectRepo>(["ai-os", "content-forge", "scratch"]);
const ROLES = new Set<TaskRole>([
  "architect",
  "planner",
  "scout",
  "researcher",
  "builder",
  "reviewer",
]);
const STATUSES = new Set<ProjectStatus>([
  "active",
  "paused",
  "done",
  "blocked",
  "cancelled",
]);
const TIERS = new Set<TaskTier>(["fast", "junior", "standard", "flagship"]);

/* Unified board feed — every task across every active/blocked project,
 * for the Kanban UI. Registered before /:id so "board" doesn't get parsed
 * as a project id. */
r.get("/board", async (c) => {
  const tasks = await listActiveTasks();
  return c.json({ count: tasks.length, tasks });
});

/* Manager rollup — one card per active/blocked project with aggregate
 * token/spend/task stats. Registered before /:id so "managers" is never
 * matched as a project id by Hono's param router. */
r.get("/managers", async (c) => {
  const managers = await listManagerRollup();
  return c.json({ managers });
});

r.get("/", async (c) => {
  const projects = await listProjects();
  return c.json({ count: projects.length, projects });
});

r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    brief?: string;
    repo?: string;
    base_branch?: string;
    architect_tier?: string;
    mode?: string;
    checkin_hours?: number;
  };
  const name = (body.name ?? "").trim();
  const brief = (body.brief ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if (!brief) return c.json({ error: "brief required" }, 400);
  if (!body.repo || !REPOS.has(body.repo as ProjectRepo)) {
    return c.json({ error: `repo must be one of: ${[...REPOS].join(", ")}` }, 400);
  }
  if (body.architect_tier && !TIERS.has(body.architect_tier as TaskTier)) {
    return c.json({ error: `architect_tier must be one of: ${[...TIERS].join(", ")}` }, 400);
  }
  if (body.mode !== undefined && body.mode !== "goal") {
    return c.json({ error: `mode must be "goal" or omitted` }, 400);
  }

  const { project, architectTask } = await createProject({
    name,
    brief,
    repo: body.repo as ProjectRepo,
    base_branch: body.base_branch,
    architect_tier: body.architect_tier as TaskTier | undefined,
    metadata: body.mode === "goal"
      ? {
          mode: "goal",
          ...(Number(body.checkin_hours) > 0
            ? { checkin_hours: Number(body.checkin_hours) }
            : {}),
        }
      : {},
  });

  try {
    const ws = await provisionWorkspace(project);
    await setProjectWorkspace(project.id, ws);
  } catch (e) {
    // The project row and its round-0 task exist either way — surfacing the
    // failure as 'blocked' beats silently leaving workspace_dir null with
    // no explanation on the Kanban card.
    await setProjectStatus(project.id, "blocked");
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[projects] workspace provisioning failed for ${project.id}:`, msg);
    return c.json(
      { project: await getProject(project.id), architectTask, warning: `workspace provisioning failed: ${msg}` },
      201,
    );
  }

  return c.json({ project: await getProject(project.id), architectTask }, 201);
});

r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);
  const tasks = await listTasksForProject(id);
  return c.json({ project, tasks });
});

/* Task creation — this is what an architect/reviewer run calls via curl
 * from inside its own CC session to fan out the next round of work. */
r.post("/:id/tasks", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    role?: string;
    round?: number;
    title?: string;
    brief?: string;
    tier?: string;
  };
  if (!body.role || !ROLES.has(body.role as TaskRole)) {
    return c.json({ error: `role must be one of: ${[...ROLES].join(", ")}` }, 400);
  }
  const round = Number(body.round);
  if (!Number.isFinite(round) || round < 0) {
    return c.json({ error: "round must be a non-negative integer" }, 400);
  }
  const title = (body.title ?? "").trim();
  const brief = (body.brief ?? "").trim();
  if (!title) return c.json({ error: "title required" }, 400);
  if (!brief) return c.json({ error: "brief required" }, 400);
  if (body.tier && !TIERS.has(body.tier as TaskTier)) {
    return c.json({ error: `tier must be one of: ${[...TIERS].join(", ")}` }, 400);
  }

  const { task, created } = await createTask({
    project_id: id,
    round,
    role: body.role as TaskRole,
    title,
    brief,
    tier: body.tier as TaskTier | undefined,
  });
  if (!created) {
    // Idempotency (migration 0035): a retried curl gets the original task id
    // back, not a second task that would race it in the same worktree.
    return c.json(
      {
        task,
        error:
          "duplicate task: this project already has a task with that round/role/title",
      },
      409,
    );
  }
  return c.json({ task }, 201);
});

/* Unwedge: retry every failed/blocked task in the earliest round that has one,
 * and un-block the project. The bulk counterpart to POST /api/tasks/:id/retry
 * — one call to get a frozen project moving again instead of hand-written SQL
 * against project_tasks (E3). */
r.post("/:id/unwedge", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
  const out = await unwedgeProject(id, { force: body.force === true });
  if (out.round === null) {
    return c.json(
      { error: "nothing to unwedge: no failed or blocked tasks", project },
      409,
    );
  }
  console.log(
    `[projects] unwedge ${id} round ${out.round}: ${out.retried.length} retried, ` +
      `${out.skipped.length} skipped`,
  );
  return c.json({
    project: await getProject(id),
    round: out.round,
    retried: out.retried,
    skipped: out.skipped,
    ...(out.skipped.length > 0
      ? {
          warning:
            `${out.skipped.length} task(s) exceeded the retry cap — re-send with ` +
            `{"force":true} to override`,
        }
      : {}),
  });
});

/* Pause / resume / cancel. Cancel best-effort tears down the git worktree. */
r.post("/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = (body.status ?? "") as ProjectStatus;
  if (!STATUSES.has(status)) {
    return c.json({ error: `status must be one of: ${[...STATUSES].join(", ")}` }, 400);
  }
  const updated = await setProjectStatus(id, status);
  if (status === "cancelled") {
    await removeWorkspace(project);
  }
  return c.json({ project: updated });
});

export default r;
