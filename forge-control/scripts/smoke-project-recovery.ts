/**
 * Smoke: the task-recovery state machine from Step 4 of the execution-layer
 * redesign (rework-2026-08-04/01-execution-layer.md, E3) — retryTask,
 * unwedgeProject, the attempt cap, and the idempotent createTask from Step 1.
 *
 * It writes real rows, so it REFUSES to run against content_forge. Point it at
 * a scratch database with the same schema:
 *
 *   psql "$DATABASE_URL" -c 'CREATE DATABASE fleet_selftest'
 *   pg_dump "$DATABASE_URL" --schema-only -t public.runs -t public.projects \
 *     -t public.project_tasks | psql "<...>/fleet_selftest"
 *   DATABASE_URL=<...>/fleet_selftest npx tsx scripts/smoke-project-recovery.ts
 *
 * Why a scratch database and not a transaction: the functions under test use
 * the module-level pool, so there is no client to roll back. Why not the live
 * database: a task flipped to 'ready' is claimable, and the executor's tick
 * would spawn a real agent against the fixture within ~10s.
 */
import pg from "pg";
import {
  retryTask,
  unwedgeProject,
  createTask,
  getTask,
  MAX_TASK_ATTEMPTS,
} from "../src/db/projects.ts";

const { Pool } = pg;

const DSN = process.env.DATABASE_URL ?? "";
if (!DSN || /\/(content_forge|ai_os|hcp)(\?|$)/.test(DSN)) {
  throw new Error(
    `refusing to run against a live database (DATABASE_URL=${DSN.replace(/:[^:@/]*@/, ":***@")}). ` +
      `Create a scratch database first — see the header of this file.`,
  );
}

const seed = new Pool({ connectionString: DSN });

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const p = await seed.query<{ id: string }>(
    `INSERT INTO projects (name, brief, repo, status, workspace_dir, work_branch)
     VALUES ('selftest','brief','ai-os','blocked','/tmp/selftest','project/selftest')
     RETURNING id::text`,
  );
  const projectId = p.rows[0].id;

  const seedTask = async (
    round: number,
    title: string,
    status: string,
    attempt = 0,
  ): Promise<string> => {
    const r = await seed.query<{ id: string }>(
      `INSERT INTO project_tasks (project_id, round, role, title, brief, status, attempt)
       VALUES ($1,$2,'builder',$3,'b',$4,$5) RETURNING id::text`,
      [projectId, round, title, status, attempt],
    );
    return r.rows[0].id;
  };

  // retryTask: the happy path also un-blocks the project, or the tick would
  // skip it forever (Step 5 makes 'blocked'/'paused' projects invisible).
  const failed = await seedTask(3, "Fix cycle 1", "failed");
  const r1 = await retryTask(failed);
  check("failed -> ready", r1.ok && r1.task.status === "ready", r1.ok ? "" : r1.reason);
  check("attempt incremented", r1.ok && r1.task.attempt === 1);
  check("run_id cleared", r1.ok && r1.task.run_id === null);
  check("blocked project resumed", r1.ok && r1.project_resumed === true);
  const proj = await seed.query<{ status: string }>(
    `SELECT status FROM projects WHERE id = $1`,
    [projectId],
  );
  check("project row is active", proj.rows[0].status === "active");

  const r2 = await retryTask(failed);
  check("a 'ready' task is not retryable", !r2.ok && r2.reason === "not_retryable");

  const capped = await seedTask(3, "Capped", "failed", MAX_TASK_ATTEMPTS);
  const r3 = await retryTask(capped);
  check("attempt cap enforced", !r3.ok && r3.reason === "attempts_exhausted");
  const r4 = await retryTask(capped, { force: true });
  check("force overrides the cap", r4.ok && r4.task.attempt === MAX_TASK_ATTEMPTS + 1);

  const r5 = await retryTask("00000000-0000-4000-8000-0000000000ff");
  check("unknown id -> not_found", !r5.ok && r5.reason === "not_found");

  // unwedgeProject: earliest blocking round only.
  await seed.query(`UPDATE projects SET status='blocked' WHERE id = $1`, [projectId]);
  const early = await seedTask(1, "Early failure", "failed");
  const earlyBlocked = await seedTask(1, "Early blocked", "blocked");
  const later = await seedTask(9, "Later failure", "failed");
  const u = await unwedgeProject(projectId);
  check("earliest blocking round chosen", u.round === 1, `round=${u.round}`);
  check("both round-1 tasks retried", u.retried.length === 2);
  check("later round left alone", (await getTask(later))?.status === "failed");
  check(
    "failed and blocked both became ready",
    (await getTask(early))?.status === "ready" &&
      (await getTask(earlyBlocked))?.status === "ready",
  );

  // createTask idempotency (Step 1).
  const a = await createTask({
    project_id: projectId, round: 50, role: "builder", title: "Dup me", brief: "x",
  });
  const b = await createTask({
    project_id: projectId, round: 50, role: "builder", title: "Dup me", brief: "y",
  });
  check("first create is new", a.created === true);
  check("repeat returns the original task", b.created === false && b.task.id === a.task.id);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
}

main()
  .then(async () => {
    await seed.end();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(e);
    await seed.end();
    process.exit(1);
  });
