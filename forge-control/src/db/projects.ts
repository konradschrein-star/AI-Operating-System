/**
 * Coding projects — data access. Schema in migrations 0030_coding_projects.sql
 * and 0040_task_graph.sql.
 *
 * A project is a git worktree (ai-os or content-forge) plus a brief. Round 0 is
 * always a single architect task. Each task, once ready, becomes exactly one
 * `runs` row — this module never talks to the CC engine directly, it only
 * creates `runs` rows via db/runs.ts and lets the existing executor pick them
 * up.
 *
 * WHAT MAKES A TASK 'ready' (engine-task-graph phase 2, R11/R12/R69). Not a
 * round draining. `project_tasks.depends_on` is a `uuid[]` whose NULL is a
 * SENTINEL, and it selects one of two rules — the split is stated once here and
 * implemented once, in `promoteReadyTasks()` below, mirroring `readyRule()` in
 * lib/task-graph.ts:
 *
 *  - `depends_on IS NOT NULL` — the GRAPH rule. Ready when every id it names
 *    belongs to a `done` task OF THE SAME PROJECT. `'{}'` names nothing, is
 *    trivially satisfied, and promotes immediately: an explicit root. `round` is
 *    not consulted, which is the entire point — a reviewer's 32 minutes no
 *    longer hold seven builders that never depended on it.
 *  - `depends_on IS NULL` — the LEGACY rule, which is what this header described
 *    in the present tense until round 204: nothing in round N+1 becomes 'ready'
 *    until every task of that project in a round < N+1 is 'done'. It survives
 *    for rows the old engine wrote, and only for those. TODO(R12-retire)
 *
 * `round` therefore no longer schedules anything. It remains a stored,
 * engine-computed integer (E1) for Kanban grouping, consolidation keys and human
 * conversation, plus ONE legacy-surface predicate: R69's term, which holds a
 * graph row behind a lower-round row it cannot have named, so that a project
 * that straddles the deploy behaves exactly as it did before it (F13).
 *
 * NARROWED ROUND 223, RESTORED ROUND 242 — comment only both times; the
 * statement below changed once, in 242, and by one disjunct. Round 223 narrowed
 * that sentence to a claim about the ROW because R69 tested `depends_on IS
 * NULL` alone: a fix chain the NEW engine creates after the restart carries real
 * graph fields (R42), so the term could not see it and a frozen row above it
 * promoted where today's engine holds it (F14). Round 242 records the fact that
 * makes the wider claim true — `graph_frozen` (R71), written by 0040's backfill
 * itself — and R69 now holds a FROZEN row behind any non-`done` lower-round row
 * whatever wrote it. The claim about the whole straddling project is therefore
 * back, and F14 is retired rather than annotated: E4 in `02-architecture.md`
 * §9.3, measured by `scripts/checks/check-r69-straddle.sh` both ways.
 *
 * A `depends_on` whose cardinality does not match the same-project rows it names
 * is CORRUPTION, never a schedule: it blocks the task, blocks the project and
 * notifies (R14, `sweepDanglingDependencies()`), and no route — promote, claim,
 * retry or unwedge — may turn it into a run.
 */

import pg from "pg";
import { createRun, type RunStatus } from "./runs.ts";
import { queueNotification } from "./notifications.ts";
import { selectClaimable, type GraphTask } from "../lib/task-graph.ts";
// Pure, DB-free decisions this module MIRRORS rather than restates: the unwedge
// group ordering (R46) and the duplicate-fix-chain rule (R41). Both are value
// imports of a module that imports nothing but types, so no cycle is closed
// around the pool — the same shape as the task-graph import above.
import { earliestFailedGroup, duplicatesFixChain } from "../lib/project-reconcile.ts";

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
  | "reviewer"
  | "steward"
  | "tester";
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
  /** Manual/automatic retries spent on this task (migration 0037). Capped by
   *  MAX_TASK_ATTEMPTS unless an operator forces it. */
  attempt: number;
  /** Deterministic idempotency key for reconciler-created chains
   *  ("fix:<round>:<cycle>" / "rereview:<round>:<cycle>"), unique per project
   *  — see migration 0039. NULL for every task that is not part of a fix
   *  chain, which is why the unique index is partial. Only the reconciler
   *  writes it; the task-creation API route does not expose the field.
   *
   *  It is a SECOND idempotency key, layered on top of migration 0035's
   *  identity index (project, round, role, title): identity dedupes the
   *  architect's fan-out curls, chain_key dedupes reconciler replays whose
   *  titles are generated and could legitimately repeat across cycles. */
  chain_key: string | null;
  /** The tasks this one waits for — THE ORDERING DEPENDENCY, and only that
   *  (migration 0040, R3). `null` is a SENTINEL, not an empty list: it means
   *  "this row was never graph-scheduled, so apply the legacy round rule".
   *  A non-null array, INCLUDING `[]`, means "graph-scheduled: promote when
   *  exactly these ids are done", so `[]` is an explicit root that promotes
   *  immediately. `promoteReadyTasks()` is where the sentinel is read.
   *
   *  Selected as `depends_on::text[]`, matching the `id::text` /
   *  `project_id::text` convention above. The cast is for CONSISTENCY, not
   *  necessity: measured on this host (pg 8.21, node-pg registers a parser for
   *  `_uuid`/OID 2951), a raw `uuid[]` already arrives as `string[]`. It is
   *  cast anyway so every id this module hands out is a string produced the
   *  same way, and so a future pg that drops the `_uuid` parser cannot turn
   *  this field into a raw `'{a,b}'` string behind phases 3 and 6. */
  depends_on: string[] | null;
  /** Which workstream worktree this task runs in (migration 0040, R4).
   *  `'main'` for every row that predates the column and for every row that
   *  does not ask for another. Same workstream = same worktree, serialized
   *  against its siblings; different workstreams are isolated directories that
   *  may write the same path. NOT NULL with a default in the schema, so it is
   *  never null here. */
  workstream: string;
  /** Repo-relative POSIX paths this task intends to write (migration 0040,
   *  R5) — the input to computed contention, declared by the planner rather
   *  than reconstructed by grepping briefs. An EMPTY array intersects nothing
   *  and is therefore always claimable (R17), which is today's behaviour
   *  exactly. NOT NULL with a `'{}'` default in the schema. */
  write_set: string[];
  /** Whether 0040's backfill wrote this row's `depends_on` (migration 0040,
   *  R71, E4). `true` on exactly those rows; `false` — the column default —
   *  on every row an engine wrote itself, before or after the migration.
   *
   *  It is PROVENANCE, not a second sentinel: `depends_on` still says which
   *  rule applies (`readyRule()`), and this says whether the array that rule
   *  reads was derived from a round number against a snapshot or declared by a
   *  planner. `promoteReadyTasks()` reads it in one place, R69's term, to hold
   *  a derived closure behind rows it could not have named. NOT NULL with a
   *  default in the schema, so it is never null here. */
  graph_frozen: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectTaskWithProject extends ProjectTask {
  project_name: string;
}

const PROJECT_COLS = `id::text, name, brief, repo, workspace_dir, base_branch, work_branch,
  status, metadata, created_at::text, updated_at::text`;
const TASK_COLS = `id::text, project_id::text, round, role, title, brief, status,
  run_id::text, fix_cycle, tier, attempt, chain_key,
  depends_on::text[], workstream, write_set, graph_frozen,
  created_at::text, updated_at::text`;
/** TASK_COLS qualified for queries that join `project_tasks pt` to another
 *  table — `projects` and `runs` both carry id/status/created_at, so an
 *  unqualified list is ambiguous there. Kept as one list so a new column can
 *  never again be added to TASK_COLS and silently forgotten in a hand-written
 *  joined SELECT (every ProjectTask row this module returns must be whole). */
const TASK_COLS_PT = `pt.id::text, pt.project_id::text, pt.round, pt.role, pt.title,
  pt.brief, pt.status, pt.run_id::text, pt.fix_cycle, pt.tier, pt.attempt,
  pt.chain_key, pt.depends_on::text[], pt.workstream, pt.write_set, pt.graph_frozen,
  pt.created_at::text, pt.updated_at::text`;
/** Last assistant message of the joined run `r`, by thread timestamp — the
 *  text every verdict parse reads. Shared by listSettledRunningTasks() and
 *  listVerdictRound() so the two can never drift apart. */
const LAST_ASSISTANT_TEXT = `(SELECT elem->>'content'
               FROM jsonb_array_elements(r.thread) elem
              WHERE elem->>'role' = 'assistant'
              ORDER BY (elem->>'ts')::timestamptz DESC
              LIMIT 1)`;
/** Last failure entry of the joined run `r` — what the executor's catch block
 *  wrote when the run died ("Executor failed: claude-code exit 1: You've hit
 *  your session limit · resets 1:10pm (Europe/Berlin)").
 *
 *  Separate from LAST_ASSISTANT_TEXT because they are different messages with
 *  different authors: the verdict is the AGENT's last word, this is the
 *  EXECUTOR's. Reusing the assistant text for failure classification would have
 *  read whatever the agent happened to say before it was killed — on 2026-08-05
 *  a half-finished tool narration — and never seen the wall at all.
 *
 *  'stuck_notice' is included alongside 'error' so a timeout's text is
 *  available to the same classifier; matching on it is the classifier's
 *  business, not this query's. */
const LAST_ERROR_TEXT = `(SELECT elem->>'content'
               FROM jsonb_array_elements(r.thread) elem
              WHERE elem->>'kind' IN ('error','stuck_notice')
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
    // depends_on = '{}' — an EXPLICIT graph root, not the NULL legacy sentinel
    // (02-architecture.md §2.2; the sentinel's two meanings are on the
    // ProjectTask.depends_on doc-comment above).
    //
    // Correct because a round-0 task has no predecessors by construction, so
    // the legacy rule ("no non-done task in a strictly lower round" — vacuous
    // at round 0) and the graph rule ("[] is trivially satisfied") agree
    // exactly on this row: it promotes immediately under either branch. No
    // observable scheduling change, on any project.
    //
    // Necessary because without it every project this engine mints is born
    // carrying a permanent `depends_on IS NULL` row, and NF6 — "the legacy
    // branch is retirable in one commit once no NULL rows remain" — would
    // never again be satisfiable: the retirement condition cannot be reached
    // while the creation path keeps manufacturing legacy roots.
    //
    // Not named by R22–R31; taken as a decision under fleet escalation policy
    // rule 3 and reported to the manager chat (round 211).
    const tr = await client.query<ProjectTask>(
      `INSERT INTO project_tasks (project_id, round, role, title, brief, tier, depends_on)
       VALUES ($1, 0, 'architect', $2, $3, $4, '{}'::uuid[])
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

/** Create a fan-out task, idempotently.
 *
 *  (project_id, round, role, title) is the task's identity — migration 0035
 *  enforces it with a unique index. An architect that runs its fan-out curls
 *  twice (2026-07-30, canvas-ux) gets the SAME task back the second time
 *  instead of a duplicate that then races the original inside one worktree.
 *  `created` tells the caller which happened: the API route turns
 *  created=false into a 409, the fix-cycle path treats it as a no-op.
 *
 *  This function deliberately does NOT accept `chain_key`: every chain row is
 *  written by createFixChain(), which is the only path that has to survive a
 *  replay against BOTH unique indexes. A second entry point that writes
 *  chain_key while arbitrating on identity alone would raise unique_violation
 *  on exactly the replay it was meant to absorb.
 *
 *  ── The three graph columns (R22, migration 0040) ───────────────────────────
 *
 *  `depends_on` CARRIES A SENTINEL and the two absent-ish values are NOT the
 *  same value (02-architecture.md §2.2, settled as E2 in §9.1):
 *
 *    undefined  → SQL NULL → a LEGACY row: never graph-scheduled, promoted by
 *                 the round rule. This is what every caller that predates the
 *                 column gets, which is what makes the migration a no-op on
 *                 day one.  TODO(R12-retire)
 *    null       → SQL NULL. Identical to undefined, explicitly.
 *    []         → SQL '{}' → a GRAPH ROOT: graph-scheduled, no predecessors,
 *                 promotes immediately.
 *    [a, b]     → SQL '{a,b}' → promotes when a and b are both done.
 *
 *  The column is therefore ALWAYS named in the INSERT and always bound, with
 *  `input.depends_on ?? null`. That `??` is a NULL-to-NULL identity — the only
 *  value it can convert is `undefined`, and the value it converts to is the
 *  same SQL NULL `undefined` would have produced via the schema default. It
 *  is not an NF1 silent fallback: nothing is being rescued, no error is being
 *  swallowed, and `[]` cannot reach it. Naming the column unconditionally is
 *  what keeps the emitted SQL a single constant string, so which of the four
 *  cases you are in is decided by the BINDING and provable by reading it,
 *  rather than by a branch that assembles a different statement.
 *
 *  `workstream` mirrors the schema default (`NOT NULL DEFAULT 'main'`,
 *  02-architecture.md §2.1) on the TS side rather than omitting the column,
 *  for the same one-statement reason. It is a default-for-omitted, not a
 *  fallback-for-invalid: an INVALID workstream is passed through untouched so
 *  the column's CHECK rejects it loudly. `write_set` likewise defaults to `[]`,
 *  which intersects nothing and is therefore always claimable (R17).
 *
 *  VALIDATION IS NOT THIS LAYER'S. The route calls validateWorkstream() and
 *  normaliseWritePath() from lib/task-graph.ts and answers 400 (R28); the
 *  values arriving here are already normalised. Nothing is re-validated and
 *  nothing is coerced — an unparseable workstream quietly becoming 'main' is
 *  named in NF1 as a forbidden silent fallback, so the omission is deliberate
 *  and must stay.
 *
 *  IDENTITY IS UNCHANGED BY ALL THREE (R30). It remains
 *  (project_id, round, role, title): the ON CONFLICT target, the follow-up
 *  SELECT and the unexplained-conflict diagnostic below all still name exactly
 *  those four columns. A repeated call with an identical body therefore returns
 *  the EXISTING row with created=false — including the depends_on, workstream
 *  and write_set that row was inserted with, never the ones the second call
 *  sent. A second POST does not get to rewrite the graph, which is how R29
 *  (depends_on immutable after insert) holds at this layer: the only write is
 *  the insert itself. */
export async function createTask(input: {
  project_id: string;
  round: number;
  role: TaskRole;
  title: string;
  brief: string;
  fix_cycle?: number;
  tier?: TaskTier;
  /** See the sentinel table above: `undefined` and `null` both mean legacy,
   *  `[]` means an explicit graph root. Already validated by the route. */
  depends_on?: string[] | null;
  workstream?: string;
  write_set?: string[];
}): Promise<{ task: ProjectTask; created: boolean }> {
  const title = input.title.slice(0, 200);
  // $8/$10 are cast explicitly because an array parameter's type is otherwise
  // inferred from the target column, and the emitted SQL should say what it
  // sends rather than rely on that inference surviving a schema edit.
  const r = await pool.query<ProjectTask>(
    `INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier,
                                depends_on, workstream, write_set)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10::text[])
     ON CONFLICT (project_id, round, role, title) DO NOTHING
     RETURNING ${TASK_COLS}`,
    [
      input.project_id,
      input.round,
      input.role,
      title,
      input.brief,
      input.fix_cycle ?? 0,
      input.tier ?? null,
      // NULL-to-NULL identity, not a fallback — see the sentinel table above.
      input.depends_on ?? null,
      input.workstream ?? "main",
      input.write_set ?? [],
    ],
  );
  if (r.rows[0]) return { task: r.rows[0], created: true };

  const existing = await pool.query<ProjectTask>(
    `SELECT ${TASK_COLS} FROM project_tasks
      WHERE project_id = $1 AND round = $2 AND role = $3 AND title = $4
      LIMIT 1`,
    [input.project_id, input.round, input.role, title],
  );
  if (!existing.rows[0]) {
    // DO NOTHING fired but nothing matches the identity we just tried to
    // insert — the unique index is on different columns than we think.
    throw new Error(
      `createTask: insert for (${input.project_id}, round ${input.round}, ` +
        `${input.role}, "${title}") conflicted but no existing row matches — ` +
        `project_tasks_identity_idx (migration 0035) may be missing or altered`,
    );
  }
  return { task: existing.rows[0], created: false };
}

/** Mark 'active' projects 'done' once every one of their tasks has settled
 *  into 'done' (and none are failed/blocked). Run after each reconciliation
 *  pass — cheap, and the only place project completion is decided. Returns
 *  the finished projects so the tick can push a completion notification, and
 *  the projects R70 REFUSED to close so the tick can say so out loud.
 *
 *  ── R70 (phase 4C): NO PROJECT CLOSES ON AN UNMERGED WORKSTREAM BRANCH ────
 *
 *  The attack 03-quality.md §5 briefs the red team to run SUCCEEDED against
 *  the statement that stood here: it had no git term and no workstream term,
 *  so every task of workstream `ui` being 'done' made the project 'done' —
 *  with `project/<id8>-ui` never merged and all of its work stranded on a
 *  branch nobody would look at again. R38's integration task is a defence only
 *  while the PLANNER REMEMBERS to create one; planner discipline is not a
 *  defence, which is why this term exists.
 *
 *  THE TEST IS STRUCTURAL, and deliberately so. `project_tasks` has no
 *  `metadata` column to flag an integration task with (see TASK_COLS), and a
 *  title convention would rot the first time someone renamed a task. R38 already
 *  defines the integration task as the one that DEPENDS ON EVERY TASK OF ITS
 *  WORKSTREAM and lives in `main` — so `depends_on` alone identifies it, with no
 *  new column and nothing to keep in sync. In words: a project may not close
 *  while some workstream W <> 'main' has at least one task and no `main` task's
 *  `depends_on` covers every task id of W.
 *
 *  MEMBERSHIP, decided here rather than left to be discovered (it is the
 *  difference between this term and a bug that no workstream project could ever
 *  survive): the integration task and the reviewer that follows it are tasks of
 *  `main`, per R38 and 02-architecture.md §4.4 — the merge lands in the main
 *  worktree and the conflict must be visible there. They are therefore NOT
 *  members of W, and are never required to depend on themselves. An integration
 *  task mistakenly placed IN W is a member of W, cannot cover itself, and the
 *  project is held — loudly, by the caller — which is the correct outcome: it is
 *  not an integration task by R38's definition and its merge would run in the
 *  wrong worktree.
 *
 *  THE RESIDUAL, ON THE RECORD RATHER THAN IMPLIED AWAY (round 224's red team).
 *  This term verifies EXISTENCE AND EDGES, never git: an integration task marked
 *  'done' WITHOUT its merge having happened is caught by nothing here, and the
 *  project closes. The designed catch is R38's integration REVIEWER, which a
 *  hand-edit in psql bypasses — the same operator-with-psql class as the
 *  hand-renumber R41 guards, and accepted for the same reason. What this term
 *  does defend against is the case that actually occurred to a planner: no
 *  integration task at all.
 *
 *  A LEGACY PROJECT IS UNTOUCHED. `workstream` defaults to 'main' and
 *  `depends_on` may be NULL (02-architecture.md §2.2 — nullable IS the migration
 *  strategy). With every row in 'main' the correlated subquery finds no `w` at
 *  all, the term is vacuously true, and the statement is the one that ran
 *  before. Every live project today is such a project.
 *
 *  SQL MIRROR — as on promoteReadyTasks() above, this module owns no decision
 *  (02-architecture.md §1.2). The readable definition is
 *  `unintegratedWorkstreams()` in lib/project-tick.ts, which the tick runs over
 *  the same rows to NAME the offending workstreams for NF1's notification; the
 *  term below is its set-based mirror. If the two ever disagree the pure side is
 *  right and this statement is the bug — and the disagreement is observable at
 *  runtime rather than only in a test, because a `held` row the pure side cannot
 *  explain is reported by the tick as exactly that.
 *
 *  `held` COSTS NO SECOND COPY OF THE RULE. It is the OLD condition re-run after
 *  the UPDATE: a project that would have closed under the pre-R70 statement and
 *  is still 'active' was refused by the new term and by nothing else, because the
 *  new term is the only thing that changed. The R70 predicate is written once. */
export async function closeFinishedProjects(): Promise<{
  closed: Array<{ id: string; name: string }>;
  /** Projects whose every task is 'done' and which R70 held open. NF1 forbids
   *  the silent variant: the caller must say which workstreams are unmerged. */
  held: Array<{ id: string; name: string }>;
}> {
  const r = await pool.query<{ id: string; name: string }>(
    `UPDATE projects p
        SET status = 'done', updated_at = now()
      WHERE p.status = 'active'
        AND EXISTS (SELECT 1 FROM project_tasks WHERE project_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM project_tasks
           WHERE project_id = p.id AND status <> 'done'
        )
        AND NOT EXISTS (
          -- R70. "There is no workstream W <> 'main' of this project for which
          -- no 'main' task covers every task of W." The three levels are
          -- exactly that sentence's three quantifiers; correlating each on
          -- project_id is the same precaution promoteReadyTasks() takes (R27),
          -- and here it is what stops another project's integration task
          -- vouching for this one's workstream.
          SELECT 1 FROM project_tasks w
           WHERE w.project_id = p.id
             AND w.workstream <> 'main'
             AND NOT EXISTS (
               SELECT 1 FROM project_tasks i
                WHERE i.project_id = p.id
                  AND i.workstream = 'main'
                  -- A legacy row names nothing and cannot integrate anything.
                  -- Explicit because ANY(NULL) is NULL, not false, and a
                  -- three-valued accident is not a rule anyone can read.
                  AND i.depends_on IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM project_tasks m
                     WHERE m.project_id = p.id
                       AND m.workstream = w.workstream
                       AND NOT (m.id = ANY (i.depends_on))
                  )
             )
        )
      RETURNING p.id::text, p.name`,
  );
  const held = await pool.query<{ id: string; name: string }>(
    `SELECT p.id::text, p.name FROM projects p
      WHERE p.status = 'active'
        AND EXISTS (SELECT 1 FROM project_tasks WHERE project_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM project_tasks
           WHERE project_id = p.id AND status <> 'done'
        )
      ORDER BY p.updated_at ASC`,
  );
  return { closed: r.rows, held: held.rows };
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

/** The THREE shapes of `depends_on` corruption, per row — the complete
 *  explanation of a cardinality mismatch, and the only three that exist.
 *  `cardinality(depends_on)` counts array ELEMENTS; the comparison counts
 *  same-project ROWS named by them, so a mismatch means at least one element
 *  names no row at all (`missing`), names a row of another project
 *  (`foreign_ids`, R27's precondition violated), or appears twice
 *  (`duplicated`). Nothing else can make the two numbers differ: the row count
 *  is over distinct primary keys, so it can never exceed the element count.
 *
 *  That exhaustiveness is an argument, so the sweep does not trust it — a row
 *  whose mismatch none of the three explains gets its own message rather than a
 *  clause that would name zero ids (an instrument lying about what it found). */
export interface DepsCorruption {
  missing: string[] | null;
  foreign_ids: string[] | null;
  duplicated: string[] | null;
}

/** One corrupt row found by sweepDanglingDependencies(), carrying everything
 *  the notification needs so the caller never has to go back to the database
 *  for a name. `status` is carried because it distinguishes the two routes a
 *  corrupt row reaches the sweep by — still `pending`, or released to `ready`
 *  by an operator retry — and a notification that did not say which would leave
 *  the operator guessing (R14, round 204 finding 1). */
interface DanglingSweepRow extends DepsCorruption {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  status: TaskStatus;
}

/** The SQL that decides whether ONE row's `depends_on` is corrupt, written
 *  once and interpolated into both places that must agree: the sweep's `corrupt`
 *  CTE and `dependencyCorruption()`'s single-row probe on the retry path. Two
 *  hand-copied predicates that must stay identical is how the retry path came to
 *  disagree with the promote path in the first place.
 *
 *  `pt` must be the `project_tasks` alias in scope. Project-scoped in BOTH the
 *  count and the arms: `graphReady()` documents "the tasks of ONE project" as a
 *  precondition and throws `GraphIntegrityError` on an id it cannot resolve
 *  inside that project, so the SQL enforces the precondition rather than
 *  trusting the write path to have upheld it (R27; round 204, red-team
 *  finding 3). */
const DEPS_MISMATCH_SQL = `pt.depends_on IS NOT NULL
          AND cardinality(pt.depends_on)
              <> (SELECT count(*) FROM project_tasks d
                   WHERE d.id = ANY(pt.depends_on)
                     AND d.project_id = pt.project_id)`;

const DEPS_CORRUPTION_COLS = `(SELECT array_agg(DISTINCT d::text ORDER BY d::text)
                 FROM unnest(pt.depends_on) AS d
                WHERE NOT EXISTS (SELECT 1 FROM project_tasks x WHERE x.id = d))
                                   AS missing,
              (SELECT array_agg(DISTINCT d::text ORDER BY d::text)
                 FROM unnest(pt.depends_on) AS d
                WHERE EXISTS (SELECT 1 FROM project_tasks x
                               WHERE x.id = d AND x.project_id <> pt.project_id))
                                   AS foreign_ids,
              (SELECT array_agg(d::text ORDER BY d::text)
                 FROM (SELECT d FROM unnest(pt.depends_on) AS d
                        GROUP BY d HAVING count(*) > 1) AS dup(d))
                                   AS duplicated`;

/** English for one corrupt row, naming every id of every shape it exhibits —
 *  the text of the notification (F1) and of the retry refusal, so an operator
 *  reads the same diagnosis whichever surface reported it. Returns `null` when
 *  none of the three shapes fired, which is the caller's cue to say so rather
 *  than to compose a sentence that names nothing. */
export function describeDepsCorruption(c: DepsCorruption): string | null {
  const clauses: string[] = [];
  const missing = c.missing ?? [];
  const foreignIds = c.foreign_ids ?? [];
  const duplicated = c.duplicated ?? [];
  if (missing.length > 0) {
    clauses.push(
      `${missing.length} dependenc${missing.length === 1 ? "y" : "ies"} that no ` +
        `longer exist${missing.length === 1 ? "s" : ""}: ${missing.join(", ")}`,
    );
  }
  if (foreignIds.length > 0) {
    clauses.push(
      `${foreignIds.length} dependenc${foreignIds.length === 1 ? "y" : "ies"} ` +
        `belonging to ANOTHER project: ${foreignIds.join(", ")}`,
    );
  }
  if (duplicated.length > 0) {
    clauses.push(`duplicated ids ${duplicated.join(", ")}`);
  }
  return clauses.length > 0 ? `names ${clauses.join("; and ")}` : null;
}

/**
 * R14's BACK half: a `pending` graph row whose `depends_on` names rows that do
 * not exist is moved to `blocked`, its project is moved to `blocked`, and one
 * notification names the task and the missing ids (failure F1,
 * 02-architecture.md §6).
 *
 * The front half — the `cardinality` equality in promoteReadyTasks()'s graph
 * branch — only refuses to PROMOTE such a row. That is not enough on its own:
 * a task stuck at `pending` forever with nobody told is precisely the silent
 * stall this project exists to end, so the two halves ship together and are
 * exact complements. The sweep's predicate is the literal negation of the
 * promote term (`<>` where the promote branch writes `=`), so no row can ever
 * be held by one and ignored by the other.
 *
 * DECISIONS TAKEN HERE, because the corpus does not state them:
 *
 *  1. SWEEP BEFORE PROMOTE, in one function call, so no caller changes. A
 *     corrupt graph must STOP a project, not release more work into it.
 *     Blocking first means the promote statement's `p.status = 'active'` join
 *     finds the project already `blocked` and promotes nothing else for it on
 *     this tick — the gate doing exactly the job it already does for a paused
 *     project, with no new mechanism.
 *  2. SCOPED TO UNSTARTED ROWS (`pending`, or `ready` WITH NO RUN ATTACHED) OF
 *     `active` PROJECTS, and to nothing else. WIDENED FROM `pending` ALONE IN
 *     ROUND 204, and the reason is the finding, not a tidy-up: `retryTask()`
 *     moves a `blocked` row to `ready`, so the sweep's own notification invited
 *     an operator recovery that walked the corrupt row straight past a
 *     `pending`-only sweep and into `claimReadyTasks()`, which never re-checks
 *     dependency integrity. R14's headline is "never a silent promotion"; that
 *     was one.
 *     - Still NOT `running` rows, and still not a `ready` row that already has
 *       a `run_id`: flipping one to `blocked` under a live run would strand the
 *       run and lose its output — the same reasoning that makes pausing a
 *       project stop new claims without killing runs in flight
 *       (claimReadyTasks below). `run_id IS NULL` is the precise form of "not
 *       started yet", and it is the same term `claimReadyTasks()` itself uses to
 *       decide a row is unclaimed, so the two agree by construction rather than
 *       by coincidence. The status/run_id terms are repeated on the
 *       `blocked_tasks` UPDATE for a reason recorded there.
 *     - Not `paused`/`blocked`/`done`/`cancelled` projects: blocking a paused
 *       project would destroy the pause — an operator who resumed it would
 *       find `blocked`, which is a different state with a different meaning,
 *       and the corruption is not going anywhere in the meantime.
 *  3. IDEMPOTENT BY CONSTRUCTION, which is the whole anti-spam argument: a
 *     swept task is neither `pending` nor `ready`, so the next tick's sweep does
 *     not find it and does not notify again. Nothing remembers anything; the
 *     row's own status is the memory.
 *  4. THE SWEEP IS THE LOUD HALF, AND THAT IS WHY THE CLAIM PATH GOT NO NEW
 *     FILTER. A candidate `SELECT` in `claimReadyTasks()` that quietly skipped a
 *     corrupt `ready` row would leave it `ready` forever with nobody told —
 *     trading a silent promotion for a silent stall, which is the same disease
 *     in a new costume. The sweep runs FIRST in this same function, and
 *     `projectTick()` calls `promoteReadyTasks()` before `spawnTaskRuns()`, so a
 *     corrupt `ready` row is blocked and notified BEFORE any claim can see it,
 *     on the same tick. The three routes into `running` are therefore each
 *     closed loudly: promote by the cardinality equality (R14 front half), retry
 *     and unwedge by `retryTask()`'s `dependencies_corrupt` refusal, and any
 *     out-of-band write (`psql`, an import, a future writer) by this sweep.
 *
 * THREE SHAPES OF CORRUPTION, all loud — see `DepsCorruption`. A missing id
 * (F1, the case R14 describes), an id naming a row of ANOTHER project (R27's
 * precondition, which only the API can enforce and only for its own callers),
 * and the same id twice (the count is over rows, not over array elements).
 * Neither of the last two is reachable from any writer today — the R6 backfill
 * aggregates over distinct rows of one project — but the promote term refuses
 * all three identically, so the sweep must report all three or a row would be
 * held by the front half and swept by nothing.
 *
 * @returns the rows it blocked, for the caller's log line
 */
async function sweepDanglingDependencies(): Promise<DanglingSweepRow[]> {
  const r = await pool.query<DanglingSweepRow>(
    `WITH corrupt AS (
       SELECT pt.id::text          AS id,
              pt.title             AS title,
              pt.project_id::text  AS project_id,
              p.name               AS project_name,
              pt.status            AS status,
              ${DEPS_CORRUPTION_COLS}
         FROM project_tasks pt
         JOIN projects p ON p.id = pt.project_id
        WHERE p.status = 'active'
          AND pt.status IN ('pending','ready')     -- decision 2, round 204
          AND pt.run_id IS NULL
          AND ${DEPS_MISMATCH_SQL}
     ),
     blocked_tasks AS (
       -- The status and run_id terms are REPEATED here, not just inherited from
       -- the CTE. An UPDATE re-checks its own WHERE against the row version it
       -- actually locks (EvalPlanQual), so if a concurrent claim commits between
       -- the CTE's snapshot and this write, these two terms are what make the
       -- sweep skip the now-'running' row instead of blocking a task whose agent
       -- is already working. The CTE's copy alone would match on id and clobber.
       UPDATE project_tasks t SET status = 'blocked', updated_at = now()
        WHERE t.id IN (SELECT id::uuid FROM corrupt)
          AND t.status IN ('pending','ready')
          AND t.run_id IS NULL
       RETURNING t.id
     ),
     blocked_projects AS (
       UPDATE projects p SET status = 'blocked', updated_at = now()
        WHERE p.id IN (SELECT project_id::uuid FROM corrupt)
       RETURNING p.id
     )
     SELECT id, title, project_id, project_name, status, missing, foreign_ids, duplicated
       FROM corrupt`,
  );
  for (const row of r.rows) {
    const what = describeDepsCorruption(row);
    const text =
      what !== null
        ? `🚫 Project "${row.project_name}" — task "${row.title}" (${row.status}) ${what}`
        : `🚫 Project "${row.project_name}" — task "${row.title}" (${row.status}) has a ` +
          `depends_on array whose length does not match the same-project tasks it ` +
          `names, and none of the three known shapes explains it — read the row by hand`;
    // queueNotification never throws by construction (db/notifications.ts) —
    // a lost push must not fail a tick — so this is not a swallowed error, and
    // the block itself has already happened in the statement above regardless.
    await queueNotification(text, "project-graph");
    console.error(
      `[project-graph] R14: task ${row.id} (${row.status}) blocked, project ` +
        `${row.project_id} blocked — missing [${(row.missing ?? []).join(",")}] ` +
        `foreign [${(row.foreign_ids ?? []).join(",")}] ` +
        `duplicated [${(row.duplicated ?? []).join(",")}]`,
    );
  }
  return r.rows;
}

/** Is ONE row's `depends_on` corrupt, and how? `null` means sound — the same
 *  predicate the sweep applies, from the same constant, so the retry path can
 *  refuse exactly what the tick would block (R14, round 204 finding 1).
 *
 *  Scoped to the row's id and nothing else: unlike the sweep it does NOT filter
 *  on task status, run_id or project status, because its caller is asking about
 *  a `failed`/`blocked` row and about a project that is by definition not
 *  advancing. */
async function dependencyCorruption(taskId: string): Promise<DepsCorruption | null> {
  const r = await pool.query<DepsCorruption>(
    `SELECT ${DEPS_CORRUPTION_COLS}
       FROM project_tasks pt
      WHERE pt.id = $1
        AND ${DEPS_MISMATCH_SQL}`,
    [taskId],
  );
  return r.rows[0] ?? null;
}

/** Promote every 'pending' task whose dependencies are all satisfied to
 *  'ready'. Single set-based query across all projects — this is the
 *  "manager" for stage sequencing, run every tick.
 *
 *  Only 'active' projects advance (E7 on main, R8 in this project's plan —
 *  the same bug, found twice). Neither this query nor claimReadyTasks used to
 *  look at the project row at all, so `paused` was decoration: the two
 *  projects Konrad paused on 2026-07-30 would have resumed the moment anyone
 *  unwedged them. Pause, blocked and cancelled all now mean what they say — a
 *  project has to be explicitly returned to 'active' to move.
 *
 *  The gate is a filter, not a state change: when the project flips back to
 *  'active' the same rows are still 'pending' and the round resumes exactly
 *  where it stopped. The reconciler is therefore free to create fix-chain
 *  tasks for a non-active project — they sit inert under this gate instead of
 *  the verdict being dropped on the floor. All of that survives R13 verbatim:
 *  the term is unchanged, in the same join, and it is what makes decision 1 of
 *  the sweep above work at all.
 *
 *  ------------------------------------------------------------------------
 *  WHAT CHANGED (engine-task-graph phase 2, R11/R12/R69).
 *
 *  "No earlier-round task still outstanding" was three unrelated things at
 *  once — ordering, file contention and narrative phase — and only ordering is
 *  a real dependency (00-vision.md §2). The predicate now has TWO LABELLED
 *  BRANCHES, chosen by the row's own `depends_on` sentinel:
 *
 *   - GRAPH BRANCH (`depends_on IS NOT NULL`, R11): ready when every id it
 *     names belongs to a `done` task. `'{}'` names nothing, is trivially
 *     satisfied, and promotes immediately — an explicit root. `round` is NOT
 *     consulted, which is the entire point: a reviewer's 32 minutes no longer
 *     hold seven builders that never depended on it.
 *   - LEGACY BRANCH (`depends_on IS NULL`, R12): today's rule, unchanged —
 *     promote when no task of the same project in a strictly lower round is
 *     anything other than `done`. TODO(R12-retire)
 *
 *  ONE STATEMENT, not two. Two statements would leave a window in which a row
 *  whose `depends_on` flipped between them satisfies neither and is skipped by
 *  both. The branches are exclusive and exhaustive over `depends_on`, so every
 *  `pending` row of an active project is judged by exactly one of them.
 *
 *  THE CARDINALITY EQUALITY is R14's front half. `NOT EXISTS (... status <>
 *  'done')` alone reads a VANISHED dependency as satisfied and releases the
 *  task — the silent-fallback shape this fleet forbids. Its back half is
 *  sweepDanglingDependencies() above, called first, in the same tick.
 *
 *  BOTH DEPENDENCY SUBQUERIES ARE CORRELATED ON `project_id` (round 204,
 *  red-team finding 3). Without it a `depends_on` naming another project's
 *  `done` row promoted, and one naming another project's `pending` row stalled
 *  forever with a matching cardinality that the sweep could not see — while
 *  `graphReady()` threw `GraphIntegrityError` on the identical input, because its
 *  `byId` holds one project's rows. R27 closes the API path; this closes the
 *  path an operator `psql`, an import or a future writer opens, so the SQL
 *  enforces the precondition the pure side documents instead of trusting it.
 *
 *  THE STRADDLE TERM (R69, ruled as E3 in 02-architecture.md §9.2 and widened
 *  as E4 in §9.3) is the graph branch's only reference to `round`, and it reads
 *  it only about rows whose ordering a closure cannot express. `depends_on` is
 *  a FROZEN closure: the R6 backfill writes the rows that existed when 0040
 *  ran, and 0040 is applied BEFORE the executor restarts (R64), so rows keep
 *  arriving that no frozen closure can name — createFixChain's builder at
 *  `round + 1` and re-reviewer at `round + 2`, born NULL before the restart
 *  (E2) and carrying real graph fields after it (R42). Without the term a
 *  backfilled row promotes straight past a fix chain numbered far below it,
 *  where today's engine holds it (failure F13). Measured, not argued:
 *  closure-only leaves R18 cases (a)–(e) green and (f) diverging on tick 2
 *  (evidence/phase1-migration.md §13.4).
 *
 *  THE DISJUNCT, and which side of it applies to whom (round 242). A candidate
 *  carrying `graph_frozen` (R71 — written by 0040's backfill and by nothing
 *  else) is held behind ANY non-`done` lower-round row, because ITS closure is
 *  the derived one; a candidate that declared its own dependencies is held only
 *  behind `depends_on IS NULL` rows, which never got to declare anything. On a
 *  project planned entirely after the restart nothing is frozen and nothing is
 *  NULL, both sides are false, and `round` is never consulted — it costs only
 *  where it must, measured as 3 ticks / 8-wide by probe 3 of
 *  check-r69-straddle.sh against 17 / 1-wide for the same widening ungated. It
 *  is legacy SURFACE, not graph logic, and it is deleted in the same commit as
 *  the legacy branch and R18 cases (f)/(g), when no NULL and no frozen row
 *  remains. TODO(R12-retire)
 *
 *  SQL MIRROR — this module owns NO scheduling decision (02-architecture.md
 *  §1.2), exactly as markVerdictTaskDone mirrors verdictMemberSettled today.
 *  The statement below is the set-based mirror of `readyRule()` +
 *  `graphReady()` + `legacyRoundReady()` in lib/task-graph.ts; those three are
 *  the readable, testable definition and the replay proof (R18) runs against
 *  them without a database. If the two ever disagree, the pure side is right
 *  and this statement is the bug.
 *
 *  The return value stays `Promise<number>` (rows promoted). projectTick()
 *  calls it and ignores the value; widening the signature to surface the sweep
 *  would drag lib/project-tick.ts into this phase, and the sweep already
 *  reports itself through the notification queue and the executor log. */
export async function promoteReadyTasks(): Promise<number> {
  // R14 back half, BEFORE the promote — decision 1 on the sweep above.
  await sweepDanglingDependencies();
  const r = await pool.query(
    `UPDATE project_tasks pt
        SET status = 'ready', updated_at = now()
       FROM projects p
      WHERE p.id = pt.project_id
        AND p.status = 'active'                        -- E7/R8/R13: unchanged, load-bearing
        AND pt.status = 'pending'
        AND (
          -- GRAPH BRANCH
          (pt.depends_on IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM project_tasks d
                            WHERE d.id = ANY(pt.depends_on)
                              AND d.project_id = pt.project_id   -- R27, round 204
                              AND d.status <> 'done')
           AND (SELECT count(*) FROM project_tasks d
                 WHERE d.id = ANY(pt.depends_on)
                   AND d.project_id = pt.project_id)     -- R27, round 204
               = cardinality(pt.depends_on)            -- R14: no dangling dep may satisfy
           AND NOT EXISTS (SELECT 1 FROM project_tasks l   -- R69, E3/E4: the straddle term
                            WHERE l.project_id = pt.project_id
                              AND (pt.graph_frozen OR l.depends_on IS NULL)  -- R71, E4
                              AND l.round < pt.round
                              AND l.status <> 'done'))  -- TODO(R12-retire)
          OR
          -- LEGACY BRANCH  TODO(R12-retire)
          (pt.depends_on IS NULL
           AND NOT EXISTS (SELECT 1 FROM project_tasks earlier
                            WHERE earlier.project_id = pt.project_id
                              AND earlier.round < pt.round
                              AND earlier.status <> 'done'))
        )
      RETURNING pt.id`,
  );
  return r.rowCount ?? 0;
}

/** Claim every 'ready' task with no run yet (FOR UPDATE SKIP LOCKED so a
 *  second tick overlap never double-fires one). Caller creates the `runs`
 *  row per task and then calls attachRun().
 *
 *  Joined to projects and filtered to 'active' for the same reason as
 *  promoteReadyTasks (E7 / R9): pausing a project must actually stop it
 *  spending money. `FOR UPDATE OF pt` locks only the task rows — a bare
 *  FOR UPDATE would also lock the joined `projects` row, so every claim would
 *  contend with any concurrent status flip or metadata write on that project,
 *  and one claimed task could hide the rest of its project's work.
 *
 *  Pausing a project stops NEW claims only — runs already in flight are NOT
 *  killed. They finish and reconcile normally; bookkeeping is not billable
 *  work, and killing mid-run would lose the agent's output.
 *
 *  ------------------------------------------------------------------------
 *  WHAT CHANGED (engine-task-graph phase 2, R15/R16/R17/R21).
 *
 *  Everything about the transaction is untouched: `FOR UPDATE OF pt SKIP
 *  LOCKED`, the `p.status = 'active'` join, the in-transaction flip to
 *  'running', the `LIMIT 32`. Two things are different.
 *
 *  1. ORDERING — the CLAUSE is byte-identical, its MEANING is not. R15 says
 *     "only the ordering and the contention filter change" while
 *     02-architecture.md §3.4 says `ORDER BY pt.round ASC, pt.created_at ASC`
 *     stays. Both are true and the reconciliation is recorded here so a later
 *     reviewer does not have to re-derive it: the text of the ORDER BY does
 *     not change, but `round` is now an engine-computed depth rather than a
 *     hand-written schedule, so the same clause genuinely means "shallower
 *     first" instead of "whatever number a planner typed". No new ORDER BY was
 *     invented; inventing one would have been an unrecorded change of claim
 *     order across the migration, which R18's replica proof exists to forbid.
 *
 *  2. CONTENTION BELT (R16) — inside the same transaction, after the
 *     `SELECT … FOR UPDATE`, the project's currently 'running' tasks are read
 *     and candidates plus running rows are passed through `selectClaimable()`
 *     in lib/task-graph.ts. Only survivors are flipped to 'running' and
 *     returned. A dropped candidate stays 'ready' — it is NOT flipped, NOT
 *     failed, and NOT logged as an error, because nothing went wrong: it is
 *     claimed on a later tick when the sibling writing its files has finished.
 *
 *     An EMPTY `write_set` intersects nothing and is therefore always
 *     claimable (R17). That is today's behaviour exactly — every task shares
 *     one worktree and runs in parallel.
 *
 *     WHAT PROVES IT, precisely (corrected round 204, gating finding 2): the
 *     `conflicts()` empty-set cases in `task-graph.test.ts`, and case 7 of
 *     `scripts/checks/check-scheduler-sql.sh`, which drives THIS function
 *     against a real Postgres and asserts the empty-write-set row is claimed.
 *     NOT the R18 replay: its `simulate()` has no claim step at all — it moves
 *     rows `pending → running` and never calls `selectClaimable()` — so the
 *     replay is silent about contention, and crediting it here inflated R17's
 *     proof base. Measured: inverting the empty-set rule leaves all 35 replay
 *     tests green.
 *
 *     PARTITIONED BY PROJECT before the pure call. `GraphTask` deliberately
 *     carries no `project_id` and every task-graph function taking a
 *     COLLECTION is defined over ONE project (see its precondition), so one
 *     call per project is the contract, not an optimisation. One call over the
 *     whole batch would make two projects that both list `src/index.ts` in
 *     workstream 'main' serialise against each other although they run in
 *     different worktrees entirely.
 *
 *  SQL MIRROR — as on promoteReadyTasks above, this module owns NO decision
 *  (02-architecture.md §1.2). The contention rule is NOT duplicated in SQL:
 *  rows are mapped to `GraphTask` and `selectClaimable()` decides. The only
 *  thing this function decides is which rows to offer it.
 *
 *  R21 is a NON-change and is named so a later reader does not mistake its
 *  absence for a removal: spawnTaskRuns()'s TypeScript-side belt in
 *  lib/project-tick.ts still hands a task back to 'ready' when its project
 *  stopped accepting work between claim and spawn. Nothing here replaces it. */
export async function claimReadyTasks(): Promise<
  Array<ProjectTask & { project: Project }>
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<ProjectTask>(
      `SELECT ${TASK_COLS_PT}
         FROM project_tasks pt
         JOIN projects p ON p.id = pt.project_id
        WHERE pt.status = 'ready'
          AND pt.run_id IS NULL
          AND p.status = 'active'
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

    // The contention belt's other input: what is already in flight in these
    // projects. Read inside the same transaction as the candidates, so the
    // belt cannot be decided against a snapshot older than the claim. No
    // `FOR UPDATE` — these rows are read, never written, and locking them
    // would make every claim contend with the reconciler marking one 'done'.
    const runningRows = await client.query<ProjectTask>(
      `SELECT ${TASK_COLS_PT}
         FROM project_tasks pt
        WHERE pt.project_id = ANY($1::uuid[])
          AND pt.status = 'running'`,
      [projectIds],
    );
    const claimable = new Set<string>();
    for (const projectId of projectIds) {
      const candidates = r.rows
        .filter((t) => t.project_id === projectId)
        .map(toGraphTask);
      const running = runningRows.rows
        .filter((t) => t.project_id === projectId)
        .map(toGraphTask);
      for (const survivor of selectClaimable(candidates, running)) {
        claimable.add(survivor.id);
      }
    }
    // Original ORDER BY order preserved: selectClaimable returns a subset and
    // the caller's spawn order is part of the claim's observable behaviour.
    const claimed = r.rows.filter((t) => claimable.has(t.id));
    if (claimed.length === 0) {
      // Every candidate was deferred by contention. Nothing failed; the rows
      // stay 'ready' and a later tick claims them. COMMIT rather than ROLLBACK
      // so the SKIP LOCKED locks are released promptly.
      await client.query("COMMIT");
      return [];
    }
    // Mark 'running' inside the same transaction so a concurrent tick can't
    // also pick these up between claim and run-creation.
    await client.query(
      `UPDATE project_tasks SET status = 'running', updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [claimed.map((t) => t.id)],
    );
    await client.query("COMMIT");
    return claimed.flatMap((t) => {
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

/** The narrow projection lib/task-graph.ts decides over (R10) — the seven
 *  columns a scheduling decision may read, and nothing else. Written out here
 *  rather than passing the whole row so that a decision function cannot
 *  quietly start depending on a brief, a run id or a timestamp.
 *  `graph_frozen` joined the projection with R69's widening (E4, round 242):
 *  the predicate that reads it is in `graphReady()`, so the column has to reach
 *  it, and a projection that dropped it would make every row read not-frozen. */
function toGraphTask(t: ProjectTask): GraphTask {
  return {
    id: t.id,
    round: t.round,
    workstream: t.workstream,
    status: t.status,
    depends_on: t.depends_on,
    write_set: t.write_set,
    graph_frozen: t.graph_frozen,
  };
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

/**
 * Mark ONE gating task 'done', but only while the round's view of it still
 * holds — the optimistic-concurrency half of consolidation (red-team S4, R905;
 * predicate widened by R1005 findings 1 and 2).
 *
 * The verdict a round is judged on is read by listVerdictRound() and acted on
 * several DB round trips later. In between, the control plane can requeue a
 * settled reviewer run: `POST /api/runs/:id/message` against a `completed`
 * target appends and flips it to `queued` in one statement, so the run owes one
 * more turn — and that turn may say NEEDS_FIXES where the snapshot said PASS.
 * An unconditional mark-done wrote 'done' anyway, and a 'done' task is
 * invisible to listSettledRunningTasks() forever: the flipped verdict was
 * honoured zero times, silently, which is the one outcome this whole module
 * exists to prevent.
 *
 * The predicate is the SQL mirror of verdictMemberSettled() in
 * lib/project-reconcile.ts — the same three-term rule the decision layer uses,
 * so the two halves cannot disagree about which member is settled:
 *
 *  - `pt.status = 'done'` — already marked by an earlier tick. For a VERDICT
 *    role that write can only have come from this function: project-tick's
 *    per-task branch marks 'done' for non-verdict roles only (`isVerdictRole`
 *    defers the rest to consolidation), and no API route writes a task status
 *    at all — so the branch re-confirms THIS module's own earlier decision, it
 *    does not trust a stranger. Re-marking is
 *    the no-op it is meant to be, and it must NOT be conditioned on the run:
 *    that row's verdict was consumed by bookkeeping and its run is free to be
 *    resumed, stopped or to fail afterwards. Requiring `completed` here was
 *    R1005 finding 2's other half — the round would be refused release forever
 *    instead of merely waiting forever.
 *  - `r.status = 'completed'` — the settled snapshot the decision was computed
 *    from. Every write that delivers a message to a settled run moves it out of
 *    `completed` in the SAME statement as the append, so a move is visible here.
 *  - `pending_input IS DISTINCT FROM 'true'` — R1005 finding 1. `completed`
 *    alone is NOT an exact detector: completeRun's handshake is two statements
 *    (executor.ts E1/E2), and a `/message` to a RUNNING reviewer sets the flag
 *    and leaves the row `running` for E1 to complete. If the executor dies
 *    between E1 and E2 — OOM, pm2 restart, or this project's own DETACHED
 *    safe-restart — the row sits `completed` carrying an undelivered message
 *    for ≥PENDING_INPUT_STRANDED_MS and unboundedly while the executor is down.
 *    Closing the round in that window buries the revised verdict in a 'done'
 *    task nothing ever reads again: the exact silent outcome R906 exists to
 *    prevent, arriving through the `running`-target door. NULL-safe by
 *    construction — a run with no flag yields NULL, which IS DISTINCT FROM
 *    'true'.
 *
 * EXISTS rather than `FROM runs r`: an UPDATE ... FROM is an inner join, so a
 * 'done' task whose run reference was dropped (retryTask clears run_id) could
 * never re-confirm itself. The done branch must not depend on a run row at all.
 *
 * Returns whether the task moved. `false` means the round must NOT be treated
 * as decided — the caller re-consolidates on the next tick, by which time the
 * requeued run has either settled again with a fresh verdict or is plainly
 * unsettled (→ `wait`), and the stranded-input sweep has requeued whatever the
 * flag was guarding.
 */
export async function markVerdictTaskDone(taskId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE project_tasks pt
        SET status = 'done', updated_at = now()
      WHERE pt.id = $1
        AND (pt.status = 'done'
             OR EXISTS (SELECT 1
                          FROM runs r
                         WHERE r.id = pt.run_id
                           AND r.status = 'completed'
                           AND (r.metadata->>'pending_input') IS DISTINCT FROM 'true'))`,
    [taskId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Which of these gating tasks are NOT settled — the exact complement of
 * markVerdictTaskDone()'s predicate, term for term.
 *
 * The cheap pre-check that keeps markVerdictTaskDone()'s refusal from arriving
 * AFTER an irreversible side effect. consolidateVerdictGroup creates the fix
 * chain and blocks the project before it marks the group done — that order is
 * deliberate and crash-safe — so the same window is closed from the front here:
 * one query immediately before the side effect, and the conditional mark-done
 * behind it as the backstop for whatever slips through the remaining
 * milliseconds.
 *
 * The two predicates being exact complements is the property that matters, and
 * it is pinned in cp2-reconciler-interaction.test.ts: a pre-check that let
 * through what the mark-done then refuses turns every consolidation into a
 * partially-applied round, and one that refuses what mark-done would accept
 * wedges the round instead.
 *
 * A task with no run (`run_id IS NULL`) counts as unsettled unless it is
 * already 'done': it cannot have produced the verdict the decision was computed
 * from. A run still carrying `pending_input` counts as unsettled for the reason
 * spelled out above — it owes a turn nobody has delivered yet.
 */
export async function unsettledVerdictTasks(
  taskIds: readonly string[],
): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const r = await pool.query<{ id: string }>(
    `SELECT pt.id::text AS id
       FROM project_tasks pt
       LEFT JOIN runs r ON r.id = pt.run_id
      WHERE pt.id = ANY($1::uuid[])
        AND pt.status IS DISTINCT FROM 'done'
        AND (r.status IS DISTINCT FROM 'completed'
             OR r.metadata->>'pending_input' = 'true')`,
    [[...taskIds]],
  );
  return r.rows.map((row) => row.id);
}

/** Automatic-retry ceiling (E3). Two retries, then the task stays put until
 *  an operator forces it — an infinitely-retried task is just a slower way of
 *  burning money on the same failure. */
export const MAX_TASK_ATTEMPTS = 2;

export type RetryOutcome =
  | { ok: true; task: ProjectTask; project_resumed: boolean }
  | { ok: false; reason: "not_found" | "not_retryable" | "attempts_exhausted"; task: ProjectTask | null }
  /** R14 on the operator path: the row's `depends_on` is still corrupt, so
   *  `ready` is not a state it may occupy. Carries the ids so the API can name
   *  them — a refusal that does not say which dependency is broken tells the
   *  operator to go and read the array by hand. */
  | { ok: false; reason: "dependencies_corrupt"; task: ProjectTask; corruption: DepsCorruption };

/** failed|blocked -> ready: drop the dead run reference, count the attempt,
 *  and un-block the project so the tick can actually pick it up again (after
 *  Step 5 a 'blocked' project is skipped by promote/claim, so leaving the
 *  project status alone would make retry a silent no-op).
 *
 *  `force` is the operator override for the attempt cap — reachable from the
 *  API, never from the tick.
 *
 *  R14 IS RE-ASSERTED HERE (round 204, gating finding 1 / red-team finding 1).
 *  This function is the one route that moves a row INTO `ready` without
 *  consulting the graph, and `sweepDanglingDependencies()` used to scope itself
 *  to `pending`, so a task blocked for naming a dependency that does not exist
 *  could be retried into `ready`, claimed on the next tick, and given a run —
 *  with the corrupt `depends_on` untouched. The sweep's own notification is what
 *  invited the operator to do it. Integrity is checked BEFORE the attempt cap
 *  and is NOT bypassable by `force`, for the same reason `graphReady()` checks
 *  it before the deps-done term: `force` is an override of a budget, not of a
 *  fact, and offering "re-send with force" for a graph that cannot drain would
 *  be an instrument inviting a nonsense. The operator's real repair is to fix
 *  the array (or delete the row), which is why the refusal names the ids. */
export async function retryTask(
  id: string,
  opts: { force?: boolean } = {},
): Promise<RetryOutcome> {
  const task = await getTask(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (task.status !== "failed" && task.status !== "blocked") {
    return { ok: false, reason: "not_retryable", task };
  }
  if (task.depends_on !== null) {
    const corruption = await dependencyCorruption(id);
    if (corruption) return { ok: false, reason: "dependencies_corrupt", task, corruption };
  }
  if (task.attempt >= MAX_TASK_ATTEMPTS && !opts.force) {
    return { ok: false, reason: "attempts_exhausted", task };
  }

  const r = await pool.query<ProjectTask>(
    `UPDATE project_tasks
        SET status = 'ready', run_id = NULL, attempt = attempt + 1, updated_at = now()
      WHERE id = $1 AND status IN ('failed','blocked')
      RETURNING ${TASK_COLS}`,
    [id],
  );
  if (!r.rows[0]) {
    // Lost a race with the tick between the read and the write.
    return { ok: false, reason: "not_retryable", task };
  }

  const p = await pool.query(
    `UPDATE projects SET status = 'active', updated_at = now()
      WHERE id = $1 AND status = 'blocked'`,
    [task.project_id],
  );
  return { ok: true, task: r.rows[0], project_resumed: (p.rowCount ?? 0) > 0 };
}

/** Retry every failed task in the EARLIEST failed GROUP — earliest by
 *  `(round, workstream)`, ordered by round then workstream name (R46). Later
 *  groups are left alone deliberately: they are gated behind this one anyway,
 *  and re-running them before the blocker is fixed just burns tokens.
 *
 *  THE WORKSTREAM TERM IS NOT COSMETIC. Keyed on the round alone, one operator
 *  keystroke would restart every workstream sitting at that depth — two teams
 *  put back to work in two worktrees on the strength of a single `/unwedge`,
 *  with only one of them named in the response. `workstream` is returned
 *  alongside `round` so the caller can say which group actually moved.
 *
 *  THE SELECTION ITSELF IS PURE and lives in lib/project-reconcile.ts
 *  (`earliestFailedGroup`), which is why this reads DISTINCT pairs rather than
 *  asking SQL for a MIN: the ordering rule is then unit-testable without a
 *  database, and this function holds no decision — the same split as
 *  `markVerdictTaskDone` mirroring `verdictMemberSettled`.
 *
 *  `skipped_reasons` is additive and exists because this function became able to
 *  skip for TWO unrelated reasons in round 204 — the attempt cap, and R14's
 *  `dependencies_corrupt` refusal — and the API's "exceeded the retry cap,
 *  re-send with force" warning was true of only one of them. A caller that reads
 *  `skipped` alone still sees exactly what it saw before. */
export async function unwedgeProject(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<{
  round: number | null;
  /** The workstream of the group that was retried; `null` when nothing was. */
  workstream: string | null;
  retried: ProjectTask[];
  skipped: ProjectTask[];
  skipped_reasons: Array<{ id: string; reason: string; detail: string | null }>;
}> {
  const blocking = await pool.query<{ round: number; workstream: string }>(
    `SELECT DISTINCT round, workstream FROM project_tasks
      WHERE project_id = $1 AND status IN ('failed','blocked')`,
    [projectId],
  );
  const group = earliestFailedGroup(blocking.rows);
  if (group === null) {
    return { round: null, workstream: null, retried: [], skipped: [], skipped_reasons: [] };
  }
  const { round, workstream } = group;

  const candidates = await pool.query<ProjectTask>(
    `SELECT ${TASK_COLS} FROM project_tasks
      WHERE project_id = $1 AND round = $2 AND workstream = $3
        AND status IN ('failed','blocked')
      ORDER BY created_at ASC`,
    [projectId, round, workstream],
  );

  const retried: ProjectTask[] = [];
  const skipped: ProjectTask[] = [];
  const skipped_reasons: Array<{ id: string; reason: string; detail: string | null }> = [];
  for (const c of candidates.rows) {
    const out = await retryTask(c.id, opts);
    if (out.ok) {
      retried.push(out.task);
      continue;
    }
    skipped.push(c);
    skipped_reasons.push({
      id: c.id,
      reason: out.reason,
      detail:
        out.reason === "dependencies_corrupt" ? describeDepsCorruption(out.corruption) : null,
    });
  }
  return { round, workstream, retried, skipped, skipped_reasons };
}

export async function bumpFixCycle(id: string): Promise<number> {
  const r = await pool.query<{ fix_cycle: number }>(
    `UPDATE project_tasks SET fix_cycle = fix_cycle + 1, updated_at = now()
      WHERE id = $1 RETURNING fix_cycle`,
    [id],
  );
  return r.rows[0]?.fix_cycle ?? 0;
}

/** Is every task of this GROUP — project + round + workstream — done? Called
 *  when a task settles, so the LAST task of a group is the one that reports the
 *  group complete — no extra bookkeeping table, and it fires exactly once per
 *  group.
 *
 *  R45 added the workstream term and the fire-exactly-once property is what it
 *  is FOR. Keyed on `(project, round)` alone, workstream A's last task draining
 *  would announce a round that workstream B is still working inside — and B's
 *  own completion would then never fire at all, because by the time B drained,
 *  A's tasks had made the round "complete" once already. One `🏁` per group,
 *  fired by that group's last task, is the same property restated over the new
 *  unit; the notification text itself is
 *  lib/project-reconcile.ts's `groupCompleteNotification`, byte-identical to
 *  the historical string for `main`. */
export async function roundIsComplete(
  projectId: string,
  round: number,
  workstream: string,
): Promise<boolean> {
  const r = await pool.query<{ complete: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM project_tasks
        WHERE project_id = $1 AND round = $2 AND workstream = $3 AND status <> 'done'
     ) AS complete`,
    [projectId, round, workstream],
  );
  return r.rows[0]?.complete ?? false;
}

/** Tasks whose run has settled but whose task row hasn't been reconciled yet
 *  — the other half of the project-tick loop.
 *
 *  'stuck' counts as settled. It is a terminal state for the TASK even though
 *  the run itself stays resumable: the watchdog only flips a run to 'stuck'
 *  after 90s without a heartbeat, i.e. the engine process is gone or hung.
 *  Before this, such a task sat 'running' forever with no owner and the
 *  project could never close or wedge — it just went quiet (E4). */
export interface SettledRunningTask extends ProjectTask {
  run_status: RunStatus;
  /** Last ASSISTANT message — the verdict text. */
  last_text: string | null;
  /** Last EXECUTOR failure entry — what the run died of (R860). */
  last_error: string | null;
  /** Times this run has already been parked behind a usage wall. 0 for every
   *  run that never was, which is almost all of them. */
  usage_wall_attempts: number;
}

export async function listSettledRunningTasks(): Promise<SettledRunningTask[]> {
  const r = await pool.query<SettledRunningTask>(
    `SELECT ${TASK_COLS_PT},
            r.status AS run_status,
            ${LAST_ASSISTANT_TEXT} AS last_text,
            ${LAST_ERROR_TEXT} AS last_error,
            COALESCE((r.metadata->>'usage_wall_attempts')::int, 0) AS usage_wall_attempts
       FROM project_tasks pt
       JOIN runs r ON r.id = pt.run_id
      WHERE pt.status = 'running'
        AND r.status IN ('completed','failed','cancelled','stuck')`,
  );
  return r.rows;
}

/** Every gating task of one project+round, with its run settlement — the
 *  input to project-tick's group consolidation, which must decide on the
 *  ROUND as a whole rather than per settled task (two reviewers each firing
 *  their own fix chain was bug 1 of the first goal-mode night).
 *
 *  R40 (phase 4) added the WORKSTREAM term, so the group this returns is
 *  `(project_id, round, workstream)` — the graph-native reading of "the set of
 *  reviewers sharing a dependency join". Two reviewers of different workstreams
 *  that land on the same computed round are two groups: consolidating them as
 *  one would merge their feedback into a SINGLE fix builder, which can only be
 *  spawned into one worktree, and the other workstream's findings would be
 *  delivered nowhere — a dropped verdict. The rule is stated in
 *  lib/project-reconcile.ts (`groupKey`); this query is its SQL half.
 *
 *  `roles` is passed in rather than hardcoded so lib/project-reconcile.ts's
 *  VERDICT_ROLES stays the single definition of "which roles end in a VERDICT
 *  line" (R850 added 'tester' to it), and so this query stays generic over the
 *  role list its caller decides on.
 *
 *  AMENDED ROUND 221 — the sentence that stood here said a value import of that
 *  constant "would close an import cycle around the pg pool". Phase 4 makes
 *  that false: this module now value-imports `earliestFailedGroup` and
 *  `duplicatesFixChain` from lib/project-reconcile.ts, and no cycle exists,
 *  because the dependency runs exactly ONE WAY. project-reconcile.ts imports
 *  from db/* with `import type` only — erased before a module is ever
 *  evaluated — which is what keeps the pool out of the test process (NF3) and
 *  out of this edge. Leaving the old claim in place would have made it a
 *  rotted citation the moment the import above was written; the DIRECTION is
 *  the rule, and it is: db/projects.ts may import project-reconcile.ts for
 *  value, project-reconcile.ts may import db/* for types alone. cp3-linkage's
 *  value import of `isVerdictRole` is what would open a pg Pool in a test
 *  process if that ever reversed.
 *
 *  LEFT JOIN, not JOIN: a task whose run has not been created yet has
 *  `run_id IS NULL` and surfaces here as `run_status: null`, which the caller
 *  maps to `settled: false` — a group with any such member must wait, never
 *  decide. Task status is deliberately NOT filtered: a reviewer already marked
 *  'done' still belongs to the group's history and the caller decides what
 *  that means (verdictMemberSettled: it is settled BY BOOKKEEPING, whatever
 *  its run has done since).
 *
 *  `pending_input` rides along for the same reason markVerdictTaskDone reads it
 *  (R1005 finding 1): a `completed` run still carrying the flag owes an
 *  undelivered turn, so the decision layer must call it unsettled and `wait`
 *  rather than compute a decision from text a message is about to revise. The
 *  column is projected as a boolean here so lib/project-reconcile.ts's pure
 *  predicate never has to know about jsonb.
 *
 *  ORDER BY created_at ASC is load-bearing — it is what makes the
 *  merged fix brief byte-identical across replays of the same round; the id
 *  tiebreak covers the two-rows-same-timestamp case, which a single-statement
 *  insert of a reviewer and a tester makes reachable. */
export interface VerdictRoundRow extends ProjectTask {
  /** NULL when the task has no run yet (LEFT JOIN). */
  run_status: RunStatus | null;
  /** `metadata.pending_input === 'true'` — the run owes an undelivered turn. */
  pending_input: boolean;
  /** Last ASSISTANT message — the verdict text. */
  last_text: string | null;
}

export async function listVerdictRound(
  projectId: string,
  round: number,
  workstream: string,
  roles: readonly TaskRole[],
): Promise<VerdictRoundRow[]> {
  const r = await pool.query<VerdictRoundRow>(
    `SELECT ${TASK_COLS_PT},
            r.status AS run_status,
            COALESCE(r.metadata->>'pending_input' = 'true', false) AS pending_input,
            ${LAST_ASSISTANT_TEXT} AS last_text
       FROM project_tasks pt
       LEFT JOIN runs r ON r.id = pt.run_id
      WHERE pt.project_id = $1
        AND pt.round = $2
        AND pt.workstream = $3
        AND pt.role = ANY($4::text[])
      ORDER BY pt.created_at ASC, pt.id ASC`,
    [projectId, round, workstream, [...roles]],
  );
  return r.rows;
}

/** What became of one chain row.
 *
 *  `replay` and `occupied` BOTH mean "the INSERT wrote nothing", and they must
 *  never be collapsed into one boolean:
 *
 *  - `replay` — the existing row carries OUR chain_key. It is the same chain,
 *    re-created after a crash. Safe, expected, nothing is lost.
 *  - `occupied` — a DIFFERENT row already holds our identity tuple
 *    (project, round, role, title) with someone else's chain_key or none.
 *    Its brief is not ours, so the feedback this consolidation merged would
 *    go nowhere. That is a silent dropped verdict, and the caller has to stop
 *    rather than mark the round done. */
export type ChainRowOutcome =
  | { kind: "created"; id: string }
  | { kind: "replay"; id: string }
  | { kind: "occupied"; id: string; title: string; chain_key: string | null };

/** One chain INSERT, with the conflict CLASSIFIED rather than assumed.
 *
 *  `DO NOTHING` reports zero rows whichever index fired, so the row has to be
 *  looked up afterwards to learn which one did. Order matters: chain_key is
 *  checked FIRST, because a row matching our chain_key is our own chain even
 *  if its round or title has since been edited, whereas a row matching only
 *  the identity tuple is a stranger.
 *
 *  Throws when neither lookup explains the conflict — same contract as
 *  createTask(): a `DO NOTHING` that nothing accounts for means the indexes
 *  are not what this code believes, and guessing would corrupt a round. */
async function insertChainRow(
  client: pg.PoolClient,
  row: {
    project_id: string;
    round: number;
    role: TaskRole;
    title: string;
    brief: string;
    fix_cycle: number;
    tier: TaskTier | null;
    chain_key: string;
    /** R42's three graph columns. Never optional here, unlike createTask's:
     *  a chain row born with `depends_on` NULL is a LEGACY row, and a legacy
     *  row is promoted by the round rule — which is exactly the behaviour the
     *  fix chain must NOT inherit once the graph is scheduling. Making the
     *  caller state all three is what stops one being forgotten. */
    depends_on: string[];
    workstream: string;
    write_set: string[];
  },
): Promise<ChainRowOutcome> {
  const ins = await client.query<{ id: string }>(
    `INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier, chain_key,
                                depends_on, workstream, write_set)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11::text[])
     ON CONFLICT DO NOTHING
     RETURNING id::text`,
    [
      row.project_id,
      row.round,
      row.role,
      row.title,
      row.brief,
      row.fix_cycle,
      row.tier,
      row.chain_key,
      row.depends_on,
      row.workstream,
      row.write_set,
    ],
  );
  if (ins.rows[0]) return { kind: "created", id: ins.rows[0].id };

  const mine = await client.query<{ id: string }>(
    `SELECT id::text FROM project_tasks
      WHERE project_id = $1 AND chain_key = $2 LIMIT 1`,
    [row.project_id, row.chain_key],
  );
  if (mine.rows[0]) return { kind: "replay", id: mine.rows[0].id };

  const theirs = await client.query<{ id: string; title: string; chain_key: string | null }>(
    `SELECT id::text, title, chain_key FROM project_tasks
      WHERE project_id = $1 AND round = $2 AND role = $3 AND title = $4 LIMIT 1`,
    [row.project_id, row.round, row.role, row.title],
  );
  if (theirs.rows[0]) {
    return {
      kind: "occupied",
      id: theirs.rows[0].id,
      title: theirs.rows[0].title,
      chain_key: theirs.rows[0].chain_key,
    };
  }

  throw new Error(
    `createFixChain: insert for (${row.project_id}, round ${row.round}, ${row.role}, ` +
      `"${row.title}", chain_key ${row.chain_key}) conflicted but neither ` +
      `project_tasks_chain_key_uniq (migration 0039) nor project_tasks_identity_idx ` +
      `(migration 0035) has a matching row — the unique indexes are not what this code expects`,
  );
}

/** Insert a fix builder (round + 1) and its re-checkers (round + 2) in ONE
 *  transaction, keyed by chain_key so the whole chain is idempotent (R7).
 *
 *  `checkers` is one row per DISSENTING ROLE (R850) — a re-reviewer, a
 *  re-tester, or one of each when a reviewer and a tester both returned
 *  NEEDS_FIXES in the same round. Never one per dissenting TASK: two unhappy
 *  reviewers still produce exactly one re-review, which is the whole point of
 *  consolidation. They all land in the same round+2 and are therefore
 *  consolidated together in turn, exactly like the round that spawned them.
 *
 *  `round` is the gating round R that produced the NEEDS_FIXES verdicts. A
 *  tick that crashes after COMMIT but before marking the group 'done'
 *  replays harmlessly: the second attempt inserts nothing and every row comes
 *  back `replay`. The outcomes are returned rather than swallowed so the
 *  caller can log the replay instead of silently believing it created fresh
 *  work — and, for `occupied`, so it can refuse to drop a verdict on the floor.
 *
 *  BARE `ON CONFLICT DO NOTHING`, with no conflict target, is deliberate.
 *  There are now TWO unique indexes a chain row can hit:
 *
 *    - `project_tasks_chain_key_uniq` — partial, (project_id, chain_key)
 *      WHERE chain_key IS NOT NULL (migration 0039). The replay guard.
 *    - `project_tasks_identity_idx` — (project_id, round, role, title)
 *      (migration 0035, already live). Not ours, but chain rows have a round,
 *      a role and a title too, so they are subject to it.
 *
 *  Naming only the first — which is what this function did until R308 — makes
 *  an identity collision an unhandled unique_violation that aborts the whole
 *  transaction. That is reachable, not theoretical: every fix chain the
 *  PRE-0039 engine wrote has chain_key NULL and a title of the same generated
 *  shape ("Fix cycle N"), so re-surfacing one of those reviewer groups after
 *  this ships collides on identity, not on chain_key. The bare form lets the
 *  INSERT survive either, and insertChainRow() then works out WHICH one fired
 *  — because "my own chain, replayed" and "a stranger holds my identity" are
 *  the same rowCount and completely different situations.
 *
 *  A targeted form would also have been fragile for a second reason: the
 *  target must be the index-inference form carrying the index's own WHERE
 *  predicate. `ON CONFLICT ON CONSTRAINT project_tasks_chain_key_uniq` is NOT
 *  a usable fallback, because a partial unique index is an index and not a
 *  constraint — Postgres rejects it ("constraint ... does not exist").
 *  Proven in docs/plan/evidence/0035-dryrun.md (T4/T6).
 *
 *  ── THE GRAPH FIELDS (R42, phase 4) ───────────────────────────────────────
 *
 *  `graph` carries what lib/project-reconcile.ts's `fixChainGraphFields()`
 *  computed for this group, and every chain row is inserted WITH it. Before
 *  phase 4 these rows named none of the three columns and took the defaults —
 *  `depends_on` NULL, i.e. a LEGACY row promoted by the round rule. Under the
 *  graph that default is a root: the fix builder would be promoted on the very
 *  next tick, running in parallel with the work it exists to follow, and the
 *  re-checkers in parallel with the fix.
 *
 *  ── THE HAND-RENUMBER GUARD (R41, phase 4) ────────────────────────────────
 *
 *  `chainKeys()` embeds `round`, so an operator who renumbers a group AFTER
 *  its chain exists makes the next consolidation compute a chain_key that
 *  collides with NEITHER unique index — the `ON CONFLICT DO NOTHING` succeeds
 *  and a SECOND chain lands, with `occupied` never firing because it is only
 *  reached on a conflict. The rule that refuses it is
 *  `duplicatesFixChain()` in lib/project-reconcile.ts — a fix builder whose
 *  `(fix_cycle, depends_on-as-a-set)` already exists under a DIFFERENT
 *  chain_key. The gating task ids are immutable (R29) where the round is not,
 *  which is what makes them the identity to guard on; R42 is what puts them on
 *  the row in the first place. This module NARROWS in SQL and DECIDES in that
 *  function — no second copy of the rule to drift (02-architecture.md §1.2).
 *
 *  It runs INSIDE the transaction and BEFORE the builder's INSERT, so a
 *  refusal writes nothing at all. It throws rather than returning an outcome:
 *  a second chain for one group is not a state the caller can reconcile, and
 *  the three-way `created`/`replay`/`occupied` classification is deliberately
 *  left untouched (R44) — it is the net that catches a chain-key MISTAKE, and
 *  overloading it with a chain-key HAZARD would blunt both. project-tick's
 *  per-group catch escalates the throw to Konrad after MAX_GROUP_FAILURES
 *  consecutive ticks, with this message quoted in the push. */
export async function createFixChain(input: {
  project_id: string;
  round: number;
  cycle: number;
  builderTitle: string;
  builderBrief: string;
  builderChainKey: string;
  checkers: Array<{
    role: TaskRole;
    title: string;
    brief: string;
    chainKey: string;
  }>;
  tier?: TaskTier;
  /** From `fixChainGraphFields()` — never assembled here, so the rounds and
   *  the dependency edges have exactly one definition (R42). */
  graph: {
    builder: { round: number; depends_on: string[]; workstream: string; write_set: string[] };
    checker: { round: number; workstream: string; write_set: string[] };
  };
}): Promise<{
  builder: ChainRowOutcome;
  /** Parallel to `input.checkers`, role carried through so the caller can name
   *  the offending row in a collision without re-deriving it from the key. */
  checkers: Array<ChainRowOutcome & { role: TaskRole }>;
}> {
  // A fix builder with nobody to check it would close the round on the next
  // tick with the merged feedback unverified. Refuse loudly rather than write
  // half a chain — the caller's decision type guarantees a non-empty list, so
  // reaching this means the decision was built by hand or by a future caller.
  if (input.checkers.length === 0) {
    throw new Error(
      `createFixChain: no re-checkers for project ${input.project_id} round ${input.round} ` +
        `cycle ${input.cycle} — a fix cycle must be re-checked by at least one verdict role`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // R41's guard, before the first INSERT so a refusal writes nothing. The
    // SELECT only NARROWS — every fix-chain builder of this project at this
    // cycle that has a dependency set at all — and the DECISION is
    // `duplicatesFixChain()` in lib/project-reconcile.ts, called here rather
    // than restated in SQL so the rule has exactly one definition and the unit
    // test asserts on the function the engine actually runs.
    const twins = await client.query<{
      id: string;
      round: number;
      chain_key: string;
      fix_cycle: number;
      depends_on: string[];
    }>(
      `SELECT id::text, round, chain_key, fix_cycle, depends_on::text[] AS depends_on
         FROM project_tasks
        WHERE project_id = $1
          AND role = 'builder'
          AND chain_key IS NOT NULL
          AND fix_cycle = $2
          AND depends_on IS NOT NULL`,
      [input.project_id, input.cycle],
    );
    const candidate = {
      cycle: input.cycle,
      chainKey: input.builderChainKey,
      dependsOn: input.graph.builder.depends_on,
    };
    const existing = twins.rows.find((row) =>
      duplicatesFixChain(candidate, {
        cycle: row.fix_cycle,
        chainKey: row.chain_key,
        dependsOn: row.depends_on,
      }),
    );
    if (existing) {
      // Not a conflict Postgres can see — the chain_key differs and so does the
      // round, so both unique indexes would have let this INSERT through.
      throw new Error(
        `createFixChain: project ${input.project_id} already has a fix chain for this group at ` +
          `fix cycle ${input.cycle} — task ${existing.id} (round ${existing.round}, chain_key ` +
          `${existing.chain_key}) depends on exactly the same gating tasks as the builder this ` +
          `call would insert as ${input.builderChainKey} at round ${input.graph.builder.round}. ` +
          `The group's round was renumbered after its chain existed (R41): the new chain_key ` +
          `collides with neither project_tasks_chain_key_uniq nor project_tasks_identity_idx, so ` +
          `a SECOND fix chain would land. Renumber task ${existing.id} back to its group, or ` +
          `delete that chain, then POST /api/projects/${input.project_id}/unwedge`,
      );
    }

    const builder = await insertChainRow(client, {
      project_id: input.project_id,
      round: input.graph.builder.round,
      role: "builder",
      title: input.builderTitle.slice(0, 200),
      brief: input.builderBrief,
      fix_cycle: input.cycle,
      tier: input.tier ?? null,
      chain_key: input.builderChainKey,
      depends_on: input.graph.builder.depends_on,
      workstream: input.graph.builder.workstream,
      write_set: input.graph.builder.write_set,
    });
    const checkers: Array<ChainRowOutcome & { role: TaskRole }> = [];
    // Sequential, not Promise.all: they share one client, and one transaction
    // cannot have two statements in flight. R42 gives every checker
    // `depends_on = [builder id]`, which is why the id has to come from the
    // INSERT above rather than from the descriptor: it does not exist until
    // that statement has run, and it must be the id of the row THIS
    // transaction inserted — or, on a `replay` or an `occupied` identity, of
    // the row that is actually there, which is the row a re-checker would have
    // to follow anyway. The caller blocks the project on `occupied`, so
    // nothing is promoted out of that state regardless.
    for (const c of input.checkers) {
      const outcome = await insertChainRow(client, {
        project_id: input.project_id,
        round: input.graph.checker.round,
        role: c.role,
        title: c.title.slice(0, 200),
        brief: c.brief,
        fix_cycle: input.cycle,
        tier: null,
        chain_key: c.chainKey,
        depends_on: [builder.id],
        workstream: input.graph.checker.workstream,
        write_set: input.graph.checker.write_set,
      });
      checkers.push({ ...outcome, role: c.role });
    }
    await client.query("COMMIT");
    return { builder, checkers };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** The project-metadata key that names the manager chat run a project came out
 *  of. Written by the OTHER lane's `POST /api/projects` (boundary F8); read
 *  here and nowhere else in this file's callers — see `managerChatRunId`. */
const ORIGIN_CHAT_KEY = "origin_chat_id";

/** The manager chat run a project was created from, or null when it has none.
 *
 *  Exists so `project-tick.ts` can gate a prompt block on the linkage (C17)
 *  without ever spelling the key: 08 §4.3's boundary grep requires the literal
 *  `origin_chat_id` to appear only in `lib/cc-runner.ts` and this file, so the
 *  key name stays sealed here and callers ask a function instead.
 *
 *  This is a metadata getter, NOT the linkage resolver / thread scanner /
 *  rollup that boundary D5 forbids: it runs no query, scans no thread, and
 *  resolves nothing. It also does not validate the id (D5 again) — a
 *  non-empty string is all it claims. */
export function managerChatRunId(project: Pick<Project, "metadata">): string | null {
  const raw = project.metadata?.[ORIGIN_CHAT_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  /** The owning project's `metadata`, so the run can inherit the manager-chat
   *  linkage (C16). Optional: a caller that omits it just gets no linkage. */
  project_metadata?: Record<string, unknown>;
}) {
  // C16: copy the project's manager-chat linkage onto the run so a worker run
  // is self-describing without a resolver JOIN. Presence + non-empty string is
  // the WHOLE check by design — boundary D5 forbids origin_chat_id validation
  // on this branch (the other lane's POST /api/projects already uuid-checks it
  // on the way in), so the missing uuid check here is deliberate, not an
  // oversight. Additive only: no reader anywhere else changes.
  const originChat = input.project_metadata
    ? managerChatRunId({ metadata: input.project_metadata })
    : null;
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
      ...(originChat ? { [ORIGIN_CHAT_KEY]: originChat } : {}),
    },
  });
}
