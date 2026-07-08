/**
 * Coding projects — data access. Schema in migration 0030_coding_projects.sql.
 *
 * A project is a git worktree (ai-os or content-forge) plus a brief. Work
 * happens in rounds: round 0 is always a single architect task; nothing in
 * round N+1 becomes 'ready' until every task in round < N+1 for that
 * project is 'done'. Each task, once ready, becomes exactly one `runs` row
 * — this module never talks to the CC engine directly, it only creates
 * `runs` rows via db/runs.ts and lets the existing executor pick them up.
 */

import pg from "pg";
import { createRun, type RunStatus } from "./runs.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[projects pool]", e.message));

export type ProjectRepo = "ai-os" | "content-forge";
export type ProjectStatus = "active" | "paused" | "done" | "blocked" | "cancelled";
export type TaskRole = "architect" | "planner" | "scout" | "builder" | "reviewer";
export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "blocked";

export interface Project {
  id: string;
  name: string;
  brief: string;
  repo: ProjectRepo;
  workspace_dir: string | null;
  base_branch: string;
  work_branch: string | null;
  status: ProjectStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectTask {
  id: string;
  project_id: string;
  round: number;
  role: TaskRole;
  title: string;
  brief: string;
  status: TaskStatus;
  run_id: string | null;
  fix_cycle: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectTaskWithProject extends ProjectTask {
  project_name: string;
}

const PROJECT_COLS = `id::text, name, brief, repo, workspace_dir, base_branch, work_branch,
  status, metadata, created_at::text, updated_at::text`;
const TASK_COLS = `id::text, project_id::text, round, role, title, brief, status,
  run_id::text, fix_cycle, created_at::text, updated_at::text`;

export async function listProjects(): Promise<Project[]> {
  const r = await pool.query<Project>(
    `SELECT ${PROJECT_COLS} FROM projects ORDER BY updated_at DESC`,
  );
  return r.rows;
}

export async function getProject(id: string): Promise<Project | null> {
  const r = await pool.query<Project>(
    `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1 LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Create a project and seed its round-0 architect task. Workspace/git
 *  provisioning happens separately (lib/workspace.ts) — this row starts
 *  with workspace_dir = NULL until that completes. */
export async function createProject(input: {
  name: string;
  brief: string;
  repo: ProjectRepo;
  base_branch?: string;
}): Promise<{ project: Project; architectTask: ProjectTask }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pr = await client.query<Project>(
      `INSERT INTO projects (name, brief, repo, base_branch)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PROJECT_COLS}`,
      [input.name.slice(0, 200), input.brief, input.repo, input.base_branch ?? "main"],
    );
    const project = pr.rows[0];
    const tr = await client.query<ProjectTask>(
      `INSERT INTO project_tasks (project_id, round, role, title, brief)
       VALUES ($1, 0, 'architect', $2, $3)
       RETURNING ${TASK_COLS}`,
      [project.id, `Plan: ${project.name}`, project.brief],
    );
    await client.query("COMMIT");
    return { project, architectTask: tr.rows[0] };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function setProjectWorkspace(
  id: string,
  input: { workspace_dir: string; work_branch: string },
): Promise<void> {
  await pool.query(
    `UPDATE projects SET workspace_dir = $2, work_branch = $3, updated_at = now()
      WHERE id = $1`,
    [id, input.workspace_dir, input.work_branch],
  );
}

export async function setProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<Project | null> {
  const r = await pool.query<Project>(
    `UPDATE projects SET status = $2, updated_at = now() WHERE id = $1
     RETURNING ${PROJECT_COLS}`,
    [id, status],
  );
  return r.rows[0] ?? null;
}

export async function listTasksForProject(
  projectId: string,
): Promise<ProjectTask[]> {
  const r = await pool.query<ProjectTask>(
    `SELECT ${TASK_COLS} FROM project_tasks
      WHERE project_id = $1
      ORDER BY round ASC, created_at ASC`,
    [projectId],
  );
  return r.rows;
}

/** Every task across every non-terminal project — what the unified Kanban
 *  board renders. Terminal projects (done/cancelled) are excluded so the
 *  board doesn't accumulate stale cards forever. */
export async function listActiveTasks(): Promise<ProjectTaskWithProject[]> {
  const r = await pool.query<ProjectTaskWithProject>(
    `SELECT pt.id::text, pt.project_id::text, pt.round, pt.role, pt.title,
            pt.brief, pt.status, pt.run_id::text, pt.fix_cycle,
            pt.created_at::text, pt.updated_at::text, p.name AS project_name
       FROM project_tasks pt
       JOIN projects p ON p.id = pt.project_id
      WHERE p.status IN ('active','blocked')
      ORDER BY pt.updated_at DESC`,
  );
  return r.rows;
}

export async function getTask(id: string): Promise<ProjectTask | null> {
  const r = await pool.query<ProjectTask>(
    `SELECT ${TASK_COLS} FROM project_tasks WHERE id = $1 LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function createTask(input: {
  project_id: string;
  round: number;
  role: TaskRole;
  title: string;
  brief: string;
  fix_cycle?: number;
}): Promise<ProjectTask> {
  const r = await pool.query<ProjectTask>(
    `INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${TASK_COLS}`,
    [
      input.project_id,
      input.round,
      input.role,
      input.title.slice(0, 200),
      input.brief,
      input.fix_cycle ?? 0,
    ],
  );
  return r.rows[0];
}

/** Mark 'active' projects 'done' once every one of their tasks has settled
 *  into 'done' (and none are failed/blocked). Run after each reconciliation
 *  pass — cheap, and the only place project completion is decided. */
export async function closeFinishedProjects(): Promise<number> {
  const r = await pool.query(
    `UPDATE projects p
        SET status = 'done', updated_at = now()
      WHERE p.status = 'active'
        AND EXISTS (SELECT 1 FROM project_tasks WHERE project_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM project_tasks
           WHERE project_id = p.id AND status <> 'done'
        )
      RETURNING p.id`,
  );
  return r.rowCount ?? 0;
}

/** Promote every 'pending' task whose project has no earlier-round task
 *  still outstanding to 'ready'. Single set-based query across all
 *  projects — this is the "manager" for stage sequencing, run every tick. */
export async function promoteReadyTasks(): Promise<number> {
  const r = await pool.query(
    `UPDATE project_tasks pt
        SET status = 'ready', updated_at = now()
      WHERE pt.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM project_tasks earlier
           WHERE earlier.project_id = pt.project_id
             AND earlier.round < pt.round
             AND earlier.status <> 'done'
        )
      RETURNING pt.id`,
  );
  return r.rowCount ?? 0;
}

/** Claim every 'ready' task with no run yet (FOR UPDATE SKIP LOCKED so a
 *  second tick overlap never double-fires one). Caller creates the `runs`
 *  row per task and then calls attachRun(). */
export async function claimReadyTasks(): Promise<
  Array<ProjectTask & { project: Project }>
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<ProjectTask>(
      `SELECT ${TASK_COLS} FROM project_tasks
        WHERE status = 'ready' AND run_id IS NULL
        ORDER BY round ASC, created_at ASC
        LIMIT 32
        FOR UPDATE SKIP LOCKED`,
    );
    if (r.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }
    const projectIds = [...new Set(r.rows.map((t) => t.project_id))];
    const pr = await client.query<Project>(
      `SELECT ${PROJECT_COLS} FROM projects WHERE id = ANY($1::uuid[])`,
      [projectIds],
    );
    const byId = new Map(pr.rows.map((p) => [p.id, p]));
    // Mark 'running' inside the same transaction so a concurrent tick can't
    // also pick these up between claim and run-creation.
    await client.query(
      `UPDATE project_tasks SET status = 'running', updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [r.rows.map((t) => t.id)],
    );
    await client.query("COMMIT");
    return r.rows.flatMap((t) => {
      const project = byId.get(t.project_id);
      return project ? [{ ...t, project }] : [];
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function attachRun(taskId: string, runId: string): Promise<void> {
  await pool.query(
    `UPDATE project_tasks SET run_id = $2, updated_at = now() WHERE id = $1`,
    [taskId, runId],
  );
}

export async function setTaskStatus(
  id: string,
  status: TaskStatus,
): Promise<void> {
  await pool.query(
    `UPDATE project_tasks SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  );
}

export async function bumpFixCycle(id: string): Promise<number> {
  const r = await pool.query<{ fix_cycle: number }>(
    `UPDATE project_tasks SET fix_cycle = fix_cycle + 1, updated_at = now()
      WHERE id = $1 RETURNING fix_cycle`,
    [id],
  );
  return r.rows[0]?.fix_cycle ?? 0;
}

/** Tasks whose run has settled (completed/failed/cancelled) but whose task
 *  row hasn't been reconciled yet — the other half of the project-tick loop. */
export async function listSettledRunningTasks(): Promise<
  Array<ProjectTask & { run_status: RunStatus; last_text: string | null }>
> {
  const r = await pool.query<
    ProjectTask & { run_status: RunStatus; last_text: string | null }
  >(
    `SELECT pt.id::text, pt.project_id::text, pt.round, pt.role, pt.title,
            pt.brief, pt.status, pt.run_id::text, pt.fix_cycle,
            pt.created_at::text, pt.updated_at::text,
            r.status AS run_status,
            (SELECT elem->>'content'
               FROM jsonb_array_elements(r.thread) elem
              WHERE elem->>'role' = 'assistant'
              ORDER BY (elem->>'ts')::timestamptz DESC
              LIMIT 1) AS last_text
       FROM project_tasks pt
       JOIN runs r ON r.id = pt.run_id
      WHERE pt.status = 'running'
        AND r.status IN ('completed','failed','cancelled')`,
  );
  return r.rows;
}

/** Convenience wrapper so project-tick doesn't import db/runs.ts directly
 *  for the one call it needs. */
export async function createRunForTask(input: {
  title: string;
  prompt: string;
  role: TaskRole;
  project_id: string;
  task_id: string;
  workspace_dir: string;
  model?: string;
  allowed_tools?: string[];
}) {
  return createRun({
    title: input.title,
    prompt: input.prompt,
    worker: `project:${input.role}`,
    metadata: {
      project_id: input.project_id,
      task_id: input.task_id,
      role: input.role,
      workspace_dir: input.workspace_dir,
      ...(input.model ? { model: input.model } : {}),
      ...(input.allowed_tools ? { allowed_tools: input.allowed_tools } : {}),
    },
  });
}
