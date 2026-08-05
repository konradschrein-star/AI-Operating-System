/**
 * Smoke: Step 5 of the execution-layer redesign (E7) — promoteReadyTasks and
 * claimReadyTasks must ignore every project that is not 'active'.
 *
 * Both queries are global (they scan all projects), so this needs a database
 * that contains nothing but the fixtures — and it mutates task rows, so it
 * REFUSES to run against a live database. Same setup as
 * smoke-project-recovery.ts:
 *
 *   DATABASE_URL=<...>/fleet_selftest npx tsx scripts/smoke-project-pause.ts
 */
import pg from "pg";
import { promoteReadyTasks, claimReadyTasks } from "../src/db/projects.ts";

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

const STATES = ["active", "paused", "blocked", "done", "cancelled"] as const;

async function main(): Promise<void> {
  const existing = await seed.query<{ n: string }>(`SELECT count(*) AS n FROM projects`);
  if (existing.rows[0].n !== "0") {
    throw new Error(
      `scratch database is not empty (${existing.rows[0].n} projects) — these queries are ` +
        `global, so leftovers would make the result meaningless. Recreate it.`,
    );
  }

  const ids = new Map<string, string>();
  for (const status of STATES) {
    const p = await seed.query<{ id: string }>(
      `INSERT INTO projects (name, brief, repo, status, workspace_dir, work_branch)
       VALUES ($1,'brief','ai-os',$2,'/tmp/selftest','project/selftest')
       RETURNING id::text`,
      [`p-${status}`, status],
    );
    ids.set(status, p.rows[0].id);
    await seed.query(
      `INSERT INTO project_tasks (project_id, round, role, title, brief, status)
       VALUES ($1, 0, 'builder', 'work', 'b', 'pending')`,
      [p.rows[0].id],
    );
  }

  const promoted = await promoteReadyTasks();
  check("exactly one task promoted", promoted === 1, `promoted=${promoted}`);

  const readyBy = await seed.query<{ name: string; status: string }>(
    `SELECT p.name, pt.status FROM project_tasks pt
       JOIN projects p ON p.id = pt.project_id ORDER BY p.name`,
  );
  for (const row of readyBy.rows) {
    const expected = row.name === "p-active" ? "ready" : "pending";
    check(`${row.name}: task stays ${expected}`, row.status === expected, row.status);
  }

  // A ready task in a paused project must still be unclaimable — this is the
  // real 2026-07-30 scenario: Konrad paused two projects that already had
  // promoted work sitting in them.
  await seed.query(
    `UPDATE project_tasks SET status = 'ready' WHERE project_id = $1`,
    [ids.get("paused")],
  );
  const claimed = await claimReadyTasks();
  check("only the active project's task is claimed", claimed.length === 1, `claimed=${claimed.length}`);
  check(
    "claimed task belongs to the active project",
    claimed[0]?.project_id === ids.get("active"),
    claimed[0]?.project.name ?? "none",
  );

  const pausedTask = await seed.query<{ status: string }>(
    `SELECT status FROM project_tasks WHERE project_id = $1`,
    [ids.get("paused")],
  );
  check("paused project's ready task untouched", pausedTask.rows[0].status === "ready", pausedTask.rows[0].status);

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
