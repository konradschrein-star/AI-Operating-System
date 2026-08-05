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
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[projects pool]", e.message));

export type ProjectRepo = "ai-os" | "content-forge" | "scratch";
export type ProjectStatus = "active" | "paused" | "done" | "blocked" | "cancelled";
export type TaskRole =
  | "architect"
  | "planner"
  | "scout"
  | "researcher"
  | "builder"
  | "reviewer";
export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "blocked";
/** Model/effort tier — see TIER_MODELS in lib/project-tick.ts. NULL = use
 *  the role file's static model:/effort: default. Only architect and
 *  builder tasks are ever assigned one. */
export type TaskTier = "fast" | "junior" | "standard" | "flagship";

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
  tier: TaskTier | null;
  /** Deterministic idempotency key for reconciler-created chains
   *  ("fix:<round>:<cycle>" / "rereview:<round>:<cycle>"), unique per project
   *  — see migration 0035. NULL for every task that is not part of a fix
   *  chain, which is why the unique index is partial. Only the reconciler
   *  writes it; the task-creation API route does not expose the field. */
  chain_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectTaskWithProject extends ProjectTask {
  project_name: string;
}

const PROJECT_COLS = `id::text, name, brief, repo, workspace_dir, base_branch, work_branch,
  status, metadata, created_at::text, updated_at::text`;
const TASK_COLS = `id::text, project_id::text, round, role, title, brief, status,
  run_id::text, fix_cycle, tier, chain_key, created_at::text, updated_at::text`;
/** TASK_COLS qualified for queries that join `project_tasks pt` to another
 *  table — `projects` and `runs` both carry id/status/created_at, so an
 *  unqualified list is ambiguous there. Kept as one list so a new column can
 *  never again be added to TASK_COLS and silently forgotten in a hand-written
 *  joined SELECT (every ProjectTask row this module returns must be whole). */
const TASK_COLS_PT = `pt.id::text, pt.project_id::text, pt.round, pt.role, pt.title,
  pt.brief, pt.status, pt.run_id::text, pt.fix_cycle, pt.tier, pt.chain_key,
  pt.created_at::text, pt.updated_at::text`;
/** Last assistant message of the joined run `r`, by thread timestamp — the
 *  text every verdict parse reads. Shared by listSettledRunningTasks() and
 *  listReviewerRound() so the two can never drift apart. */
const LAST_ASSISTANT_TEXT = `(SELECT elem->>'content'
               FROM jsonb_array_elements(r.thread) elem
              WHERE elem->>'role' = 'assistant'
              ORDER BY (elem->>'ts')::timestamptz DESC
              LIMIT 1)`;

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
  architect_tier?: TaskTier;
  metadata?: Record<string, unknown>;
}): Promise<{ project: Project; architectTask: ProjectTask }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pr = await client.query<Project>(
      `INSERT INTO projects (name, brief, repo, base_branch, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PROJECT_COLS}`,
      [
        input.name.slice(0, 200),
        input.brief,
        input.repo,
        input.base_branch ?? "main",
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const project = pr.rows[0];
    const tr = await client.query<ProjectTask>(
      `INSERT INTO project_tasks (project_id, round, role, title, brief, tier)
       VALUES ($1, 0, 'architect', $2, $3, $4)
       RETURNING ${TASK_COLS}`,
      [project.id, `Plan: ${project.name}`, project.brief, input.architect_tier ?? null],
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
    `SELECT ${TASK_COLS_PT}, p.name AS project_name
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

/** Create one task. `chain_key` is reconciler-only (see ProjectTask.chain_key)
 *  — POST /api/projects/:id/tasks passes an explicit field list that omits it,
 *  so an agent cannot forge a chain key through the API. Callers that pass one
 *  must be prepared for a unique violation on replay; use createFixChain() for
 *  the crash-safe path. */
export async function createTask(input: {
  project_id: string;
  round: number;
  role: TaskRole;
  title: string;
  brief: string;
  fix_cycle?: number;
  tier?: TaskTier;
  chain_key?: string;
}): Promise<ProjectTask> {
  const r = await pool.query<ProjectTask>(
    `INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier, chain_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${TASK_COLS}`,
    [
      input.project_id,
      input.round,
      input.role,
      input.title.slice(0, 200),
      input.brief,
      input.fix_cycle ?? 0,
      input.tier ?? null,
      input.chain_key ?? null,
    ],
  );
  return r.rows[0];
}

/** Mark 'active' projects 'done' once every one of their tasks has settled
 *  into 'done' (and none are failed/blocked). Run after each reconciliation
 *  pass — cheap, and the only place project completion is decided. Returns
 *  the finished projects so the tick can push a completion notification. */
export async function closeFinishedProjects(): Promise<
  Array<{ id: string; name: string }>
> {
  const r = await pool.query<{ id: string; name: string }>(
    `UPDATE projects p
        SET status = 'done', updated_at = now()
      WHERE p.status = 'active'
        AND EXISTS (SELECT 1 FROM project_tasks WHERE project_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM project_tasks
           WHERE project_id = p.id AND status <> 'done'
        )
      RETURNING p.id::text, p.name`,
  );
  return r.rows;
}

/** Shallow-merge a patch into projects.metadata. Used by goal-mode
 *  bookkeeping (last_checkin_at) — deliberately does NOT bump updated_at so
 *  heartbeats don't churn board ordering. */
export async function patchProjectMetadata(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE projects SET metadata = metadata || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(patch)],
  );
}

export interface ManagerRollupRow {
  project_id: string;
  name: string;
  status: string;
  mode: string | null;
  tasks_done: number;
  tasks_total: number;
  /** Aggregate input tokens over all top-level worker runs (float8 so
   *  node-postgres returns a JS number, not a bigint string). */
  tokens_in: number;
  tokens_out: number;
  spent_usd: number;
  last_activity_at: string | null;
}

/** One row per active/blocked project with task + token rollup in a single
 *  CTE — no N+1.  Only top-level worker runs are summed (parent_run_id IS
 *  NULL) to avoid double-counting sub-agent spend. */
export async function listManagerRollup(): Promise<ManagerRollupRow[]> {
  const r = await pool.query<ManagerRollupRow>(`
    WITH worker_agg AS (
      SELECT
        (metadata->>'project_id')::uuid                                               AS project_id,
        SUM(COALESCE((metadata->'usage_total_running'->>'input_tokens')::bigint, 0))  AS tokens_in,
        SUM(COALESCE((metadata->'usage_total_running'->>'output_tokens')::bigint, 0)) AS tokens_out,
        SUM(COALESCE(spent_usd, 0))                                                   AS spent_usd,
        MAX(updated_at)                                                                AS last_activity_at
      FROM runs
      WHERE metadata ? 'project_id'
        AND parent_run_id IS NULL
      GROUP BY (metadata->>'project_id')::uuid
    ),
    task_agg AS (
      SELECT
        project_id,
        COUNT(*)::int                                AS tasks_total,
        COUNT(*) FILTER (WHERE status = 'done')::int AS tasks_done
      FROM project_tasks
      GROUP BY project_id
    )
    SELECT
      p.id::text                           AS project_id,
      p.name,
      p.status,
      p.metadata->>'mode'                  AS mode,
      COALESCE(ta.tasks_done, 0)::int      AS tasks_done,
      COALESCE(ta.tasks_total, 0)::int     AS tasks_total,
      COALESCE(wa.tokens_in,  0)::float8   AS tokens_in,
      COALESCE(wa.tokens_out, 0)::float8   AS tokens_out,
      COALESCE(wa.spent_usd,  0)::float8   AS spent_usd,
      wa.last_activity_at::text            AS last_activity_at
    FROM projects p
    LEFT JOIN worker_agg wa ON wa.project_id = p.id
    LEFT JOIN task_agg   ta ON ta.project_id = p.id
    WHERE p.status IN ('active', 'blocked')
    ORDER BY wa.last_activity_at DESC NULLS LAST
  `);
  return r.rows;
}

export interface GoalProgress {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  created_at: string;
  total: number;
  done: number;
  running: number;
  ready: number;
  pending: number;
  failed: number;
  running_titles: string[];
  last_done_title: string | null;
}

/** Active goal-mode projects with task rollups — feeds the periodic
 *  progress heartbeat. */
export async function listGoalProgress(): Promise<GoalProgress[]> {
  const r = await pool.query<GoalProgress>(
    `SELECT p.id::text, p.name, p.metadata, p.created_at::text,
            count(pt.id)::int                                        AS total,
            count(pt.id) FILTER (WHERE pt.status = 'done')::int      AS done,
            count(pt.id) FILTER (WHERE pt.status = 'running')::int   AS running,
            count(pt.id) FILTER (WHERE pt.status = 'ready')::int     AS ready,
            count(pt.id) FILTER (WHERE pt.status = 'pending')::int   AS pending,
            count(pt.id) FILTER (WHERE pt.status = 'failed')::int    AS failed,
            coalesce(array_agg(pt.title ORDER BY pt.updated_at DESC)
              FILTER (WHERE pt.status = 'running'), '{}')            AS running_titles,
            (SELECT title FROM project_tasks
              WHERE project_id = p.id AND status = 'done'
              ORDER BY updated_at DESC LIMIT 1)                      AS last_done_title
       FROM projects p
       LEFT JOIN project_tasks pt ON pt.project_id = p.id
      WHERE p.status = 'active'
        AND p.metadata->>'mode' = 'goal'
      GROUP BY p.id`,
  );
  return r.rows;
}

/** Promote every 'pending' task whose project has no earlier-round task
 *  still outstanding to 'ready'. Single set-based query across all
 *  projects — this is the "manager" for stage sequencing, run every tick.
 *
 *  Gated on `projects.status = 'active'` (R8): a paused/blocked project
 *  promotes nothing, so its remaining rounds stop spawning work the moment
 *  Konrad pauses it. The gate is a filter, not a state change — when the
 *  project flips back to 'active' the same rows are still 'pending' and the
 *  round resumes exactly where it stopped. The reconciler is therefore free
 *  to create fix-chain tasks for a non-active project: they sit inert under
 *  this gate instead of the verdict being dropped on the floor. */
export async function promoteReadyTasks(): Promise<number> {
  const r = await pool.query(
    `UPDATE project_tasks pt
        SET status = 'ready', updated_at = now()
      WHERE pt.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM projects p
           WHERE p.id = pt.project_id AND p.status = 'active'
        )
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
 *  row per task and then calls attachRun().
 *
 *  Gated on `projects.status = 'active'` (R9), expressed as a JOIN so it
 *  composes with the row lock. `FOR UPDATE OF pt` is deliberate: a bare
 *  FOR UPDATE would also lock the joined `projects` row, so every claim would
 *  contend with any concurrent status flip or metadata write on that project.
 *
 *  Pausing a project stops NEW claims only — runs already in flight are NOT
 *  killed. They finish and reconcile normally; bookkeeping is not billable
 *  work, and killing mid-run would lose the agent's output. */
export async function claimReadyTasks(): Promise<
  Array<ProjectTask & { project: Project }>
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<ProjectTask>(
      `SELECT ${TASK_COLS_PT} FROM project_tasks pt
         JOIN projects p ON p.id = pt.project_id AND p.status = 'active'
        WHERE pt.status = 'ready' AND pt.run_id IS NULL
        ORDER BY pt.round ASC, pt.created_at ASC
        LIMIT 32
        FOR UPDATE OF pt SKIP LOCKED`,
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
    `SELECT ${TASK_COLS_PT},
            r.status AS run_status,
            ${LAST_ASSISTANT_TEXT} AS last_text
       FROM project_tasks pt
       JOIN runs r ON r.id = pt.run_id
      WHERE pt.status = 'running'
        AND r.status IN ('completed','failed','cancelled')`,
  );
  return r.rows;
}

/** Every reviewer task of one project+round, with its run settlement — the
 *  input to project-tick's group consolidation, which must decide on the
 *  ROUND as a whole rather than per settled task (two reviewers each firing
 *  their own fix chain was bug 1 of the first goal-mode night).
 *
 *  LEFT JOIN, not JOIN: a reviewer whose run has not been created yet has
 *  `run_id IS NULL` and surfaces here as `run_status: null`, which the caller
 *  maps to `settled: false` — a group with any such member must wait, never
 *  decide. Task status is deliberately NOT filtered: a reviewer already marked
 *  'done' still belongs to the group's history and the caller decides what
 *  that means. ORDER BY created_at ASC is load-bearing — it is what makes the
 *  merged fix brief byte-identical across replays of the same round. */
export async function listReviewerRound(
  projectId: string,
  round: number,
): Promise<Array<ProjectTask & { run_status: RunStatus | null; last_text: string | null }>> {
  const r = await pool.query<
    ProjectTask & { run_status: RunStatus | null; last_text: string | null }
  >(
    `SELECT ${TASK_COLS_PT},
            r.status AS run_status,
            ${LAST_ASSISTANT_TEXT} AS last_text
       FROM project_tasks pt
       LEFT JOIN runs r ON r.id = pt.run_id
      WHERE pt.project_id = $1
        AND pt.round = $2
        AND pt.role = 'reviewer'
      ORDER BY pt.created_at ASC`,
    [projectId, round],
  );
  return r.rows;
}

/** Insert a fix builder (round + 1) and its re-reviewer (round + 2) in ONE
 *  transaction, keyed by chain_key so the pair is idempotent (R7).
 *
 *  `round` is the REVIEWER round R that produced the NEEDS_FIXES verdicts.
 *  Both INSERTs use the partial-index conflict target from migration 0035, so
 *  a tick that crashes after COMMIT but before marking the reviewers 'done'
 *  replays harmlessly: the second attempt inserts nothing and both flags come
 *  back false. The flags are returned rather than swallowed so the caller can
 *  log the replay instead of silently believing it created fresh work.
 *
 *  The conflict target must be the index-inference form with the index's own
 *  WHERE predicate; `ON CONFLICT ON CONSTRAINT project_tasks_chain_key_uniq`
 *  is NOT a usable fallback, because a partial unique index is an index and
 *  not a constraint — Postgres rejects it ("constraint ... does not exist").
 *  Proven in docs/plan/evidence/0035-dryrun.md (T4/T6). */
export async function createFixChain(input: {
  project_id: string;
  round: number;
  cycle: number;
  builderTitle: string;
  builderBrief: string;
  builderChainKey: string;
  reviewerTitle: string;
  reviewerBrief: string;
  reviewerChainKey: string;
  tier?: TaskTier;
}): Promise<{ builderCreated: boolean; reviewerCreated: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const b = await client.query<{ id: string }>(
      `INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier, chain_key)
       VALUES ($1, $2, 'builder', $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, chain_key) WHERE chain_key IS NOT NULL DO NOTHING
       RETURNING id::text`,
      [
        input.project_id,
        input.round + 1,
        input.builderTitle.slice(0, 200),
        input.builderBrief,
        input.cycle,
        input.tier ?? null,
        input.builderChainKey,
      ],
    );
    const rv = await client.query<{ id: string }>(
      `INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier, chain_key)
       VALUES ($1, $2, 'reviewer', $3, $4, $5, NULL, $6)
       ON CONFLICT (project_id, chain_key) WHERE chain_key IS NOT NULL DO NOTHING
       RETURNING id::text`,
      [
        input.project_id,
        input.round + 2,
        input.reviewerTitle.slice(0, 200),
        input.reviewerBrief,
        input.cycle,
        input.reviewerChainKey,
      ],
    );
    await client.query("COMMIT");
    return {
      builderCreated: (b.rowCount ?? 0) > 0,
      reviewerCreated: (rv.rowCount ?? 0) > 0,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
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
  effort?: string;
  allowed_tools?: string[];
  vault_access?: boolean;
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
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.allowed_tools ? { allowed_tools: input.allowed_tools } : {}),
      ...(input.vault_access !== undefined ? { vault_access: input.vault_access } : {}),
    },
  });
}
