import { Hono } from "hono";
import {
  listProjects,
  getProject,
  createProject,
  setProjectWorkspace,
  setProjectStatus,
  listTasksForProject,
  listActiveTasks,
  createTask,
  type ProjectRepo,
  type ProjectStatus,
  type TaskRole,
} from "../db/projects.ts";
import { provisionWorkspace, removeWorkspace } from "../lib/workspace.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOS = new Set<ProjectRepo>(["ai-os", "content-forge"]);
const ROLES = new Set<TaskRole>([
  "architect",
  "planner",
  "scout",
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

/* Unified board feed — every task across every active/blocked project,
 * for the Kanban UI. Registered before /:id so "board" doesn't get parsed
 * as a project id. */
r.get("/board", async (c) => {
  const tasks = await listActiveTasks();
  return c.json({ count: tasks.length, tasks });
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
  };
  const name = (body.name ?? "").trim();
  const brief = (body.brief ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if (!brief) return c.json({ error: "brief required" }, 400);
  if (!body.repo || !REPOS.has(body.repo as ProjectRepo)) {
    return c.json({ error: `repo must be one of: ${[...REPOS].join(", ")}` }, 400);
  }

  const { project, architectTask } = await createProject({
    name,
    brief,
    repo: body.repo as ProjectRepo,
    base_branch: body.base_branch,
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

  const task = await createTask({
    project_id: id,
    round,
    role: body.role as TaskRole,
    title,
    brief,
  });
  return c.json({ task }, 201);
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
