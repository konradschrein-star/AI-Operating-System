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
  "steward",
  "tester",
]);
const STATUSES = new Set<ProjectStatus>([
  "active",
  "paused",
  "done",
  "blocked",
  "cancelled",
]);
const TIERS = new Set<TaskTier>(["fast", "junior", "standard", "flagship"]);

/* ── Project metadata construction (U1, 13-ui-v3-architecture.md §5) ────────
 *
 * The metadata object is built HERE, at the route layer. db/projects.ts takes
 * whatever `metadata` it is handed and writes it verbatim — that `metadata`
 * parameter is the entire seam, and the engine's db layer stays untouched.
 *
 * OPERATOR-PROMPT IMPLICATION (13 §5): for `origin_chat_id` to ever be set on
 * the write path, the operator must pass ITS OWN run id when it creates a
 * project. That is a change to the operator's prompt contract in the vault
 * (config), not to engine code — nothing in this repo can make the operator
 * send the field. Projects created without it stay resolvable only through
 * round 304's thread-scan fallback, which is why that fallback exists at all.
 */

/** The `POST /` request body, as it arrives off the wire: every field optional
 *  and untrusted, validated below. */
type CreateProjectBody = {
  name?: string;
  brief?: string;
  repo?: string;
  base_branch?: string;
  architect_tier?: string;
  mode?: string;
  checkin_hours?: number;
  origin_chat_id?: string;
};

/** Thrown by buildProjectMetadata for input it refuses to shape. The route
 *  maps it to a 400 — never to a silently dropped key, because round 304's
 *  linkage resolver treats the PRESENCE of `origin_chat_id` as truth: a
 *  malformed id that got swallowed here would read downstream as "this project
 *  was never linked to a chat", which is a different and false statement. */
export class ProjectMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectMetadataError";
  }
}

/**
 * Build the `projects.metadata` object for a create request. Pure: no DB, no
 * clock, no I/O — so scripts/checks/check-project-metadata.ts can table-drive
 * it directly.
 *
 * Keys are OMITTED rather than set to null/"" when they do not apply. Callers
 * downstream test presence (`metadata ? 'origin_chat_id'` in SQL, `has()` in
 * jq), so an explicit null would be a false positive.
 *
 * @throws {ProjectMetadataError} when `origin_chat_id` is present, non-empty
 *         and not a uuid.
 */
export function buildProjectMetadata(body: CreateProjectBody): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (body.mode === "goal") {
    metadata.mode = "goal";
    // Number(undefined) is NaN and NaN > 0 is false, so a missing, zero,
    // negative or unparsable interval drops the key — goal mode without a
    // check-in cadence is legal, a check-in every "NaN" hours is not.
    const checkinHours = Number(body.checkin_hours);
    if (checkinHours > 0) metadata.checkin_hours = checkinHours;
  }

  // An empty/whitespace string is "the caller had nothing to send", not an
  // error — that is the shape a shell `--arg` or an unset template variable
  // produces. Anything else non-empty must be a real uuid.
  const originChatId = (body.origin_chat_id ?? "").trim();
  if (originChatId) {
    if (!UUID_RE.test(originChatId)) {
      throw new ProjectMetadataError("origin_chat_id must be a uuid");
    }
    metadata.origin_chat_id = originChatId;
  }

  return metadata;
}

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
  const body = (await c.req.json().catch(() => ({}))) as CreateProjectBody;
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

  // Built (and validated) BEFORE createProject: a rejected origin_chat_id must
  // not leave a half-born project and its round-0 architect task behind.
  let metadata: Record<string, unknown>;
  try {
    metadata = buildProjectMetadata(body);
  } catch (e) {
    if (e instanceof ProjectMetadataError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const { project, architectTask } = await createProject({
    name,
    brief,
    repo: body.repo as ProjectRepo,
    base_branch: body.base_branch,
    architect_tier: body.architect_tier as TaskTier | undefined,
    metadata,
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
  /* The warning is composed per REASON (round 204). Until R14 gained its retry
   * refusal, "exceeded the retry cap" was the only way a task could be skipped;
   * telling an operator to re-send with {"force":true} for a task whose
   * depends_on is corrupt would send them round a loop force cannot open. */
  const corrupt = out.skipped_reasons.filter((s) => s.reason === "dependencies_corrupt");
  const capped = out.skipped_reasons.filter((s) => s.reason === "attempts_exhausted");
  const other = out.skipped_reasons.filter(
    (s) => s.reason !== "dependencies_corrupt" && s.reason !== "attempts_exhausted",
  );
  const warnings = [
    ...(capped.length > 0
      ? [`${capped.length} task(s) exceeded the retry cap — re-send with {"force":true} to override`]
      : []),
    ...corrupt.map(
      (s) => `task ${s.id} was NOT retried: its depends_on ${s.detail ?? "is corrupt"} (R14) — force does not override this`,
    ),
    ...other.map((s) => `task ${s.id} was NOT retried: ${s.reason}`),
  ];
  return c.json({
    project: await getProject(id),
    round: out.round,
    retried: out.retried,
    skipped: out.skipped,
    skipped_reasons: out.skipped_reasons,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
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
