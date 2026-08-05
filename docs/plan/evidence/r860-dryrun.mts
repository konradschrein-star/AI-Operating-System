/**
 * R860 dry-run: the usage-wall auto-recovery path, end to end, against a
 * throwaway database. content_forge is NOT touched.
 */
const URL_ = process.env.DRYRUN_DATABASE_URL ?? "";
if (!URL_) throw new Error("DRYRUN_DATABASE_URL is not set — point it at a THROWAWAY database, never content_forge");
process.env.DATABASE_URL = URL_;
process.env.AI_OS_DATABASE_URL = URL_;
process.env.REMINDER_TZ = "Europe/Berlin";

// Resolved from this file's own location (docs/plan/evidence -> repo root), so
// the script runs from any checkout or worktree without editing.
const ROOT = new URL("../../../forge-control/src", import.meta.url).pathname;
const { deferForUsageWall } = await import(`${ROOT}/lib/project-tick.ts`);
const { listSettledRunningTasks, getProject } = await import(`${ROOT}/db/projects.ts`);
// `pg` is resolved from forge-control's node_modules rather than from this
// file's directory — the script lives under docs/, which has no package of its
// own, so a bare `import "pg"` would not resolve.
const { createRequire } = await import("node:module");
const pg = createRequire(`${ROOT}/`)("pg");

const pool = new pg.Pool({ connectionString: URL_ });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

const SESSION_WALL =
  "Executor failed: claude-code exit 1: You've hit your session limit · resets 1:10pm (Europe/Berlin)";
const SPEND_CAP =
  "Run blocked: Daily spend cap — daily spend EUR 202.79 exceeds cap EUR 200";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function seed(opts: {
  projectName: string;
  projectStatus: string;
  errorText: string;
  runStatus?: string;
  wallAttempts?: number;
}) {
  const [p] = await q(
    `INSERT INTO projects (name, brief, repo, base_branch, work_branch, workspace_dir, status, metadata)
     VALUES ($1,'brief','ai-os','main','wb','/tmp/ws',$2,'{"mode":"goal"}'::jsonb) RETURNING id::text`,
    [opts.projectName, opts.projectStatus],
  );
  const thread = [
    { role: "user", content: "do the thing", ts: "2026-08-05T08:00:00Z", kind: "text" },
    { role: "assistant", content: "working on it", ts: "2026-08-05T09:00:00Z", kind: "text" },
    { role: "system", content: opts.errorText, ts: "2026-08-05T09:14:17Z", kind: "error" },
  ];
  const [r] = await q(
    `INSERT INTO runs (title, prompt, worker, status, thread, metadata, completed_at)
     VALUES ($1,'p','project:builder',$2,$3::jsonb,$4::jsonb, now()) RETURNING id::text`,
    [
      `${opts.projectName} · task`,
      opts.runStatus ?? "failed",
      JSON.stringify(thread),
      JSON.stringify({
        project_id: p.id,
        role: "builder",
        cc_session_id: "sess-abc",
        ...(opts.wallAttempts ? { usage_wall_attempts: opts.wallAttempts } : {}),
      }),
    ],
  );
  await q(
    `INSERT INTO project_tasks (project_id, round, role, title, brief, status, run_id)
     VALUES ($1, 300, 'builder', $2, 'b', 'running', $3)`,
    [p.id, `task for ${opts.projectName}`, r.id],
  );
  return { projectId: p.id as string, runId: r.id as string };
}

async function settledFor(projectId: string) {
  const all = await listSettledRunningTasks();
  return all.find((t: { project_id: string }) => t.project_id === projectId);
}

console.log("\n=== A. the incident: two projects, one wall ===");
const ov = await seed({ projectName: "operator-visibility", projectStatus: "active", errorText: SESSION_WALL });
const ev2 = await seed({ projectName: "engine-v2-research-lane", projectStatus: "active", errorText: SESSION_WALL });

for (const [name, ids] of [["ov", ov], ["ev2", ev2]] as const) {
  const task = await settledFor(ids.projectId);
  check(`${name}: run surfaces as settled with its error text`, !!task && task.last_error === SESSION_WALL);
  check(`${name}: usage_wall_attempts starts at 0`, task?.usage_wall_attempts === 0, String(task?.usage_wall_attempts));
  const project = await getProject(ids.projectId);
  const deferred = await deferForUsageWall(task!, project);
  check(`${name}: deferForUsageWall parked it`, deferred === true);
}

const parked = await q(
  `SELECT id::text, status, wake_after, metadata->>'usage_wall_attempts' AS att,
          jsonb_array_length(thread) AS n,
          thread->-1->>'content' AS last_entry, thread->-1->>'role' AS last_role
     FROM runs ORDER BY created_at`,
);
for (const r of parked as Array<Record<string, unknown>>) {
  check(`run ${String(r.id).slice(0, 8)}: re-queued`, r.status === "queued", String(r.status));
  check(`run ${String(r.id).slice(0, 8)}: wake_after set`, r.wake_after !== null, String(r.wake_after));
  check(`run ${String(r.id).slice(0, 8)}: attempt = 1`, r.att === "1", String(r.att));
  check(
    `run ${String(r.id).slice(0, 8)}: resume note appended as a system turn`,
    r.last_role === "system" && String(r.last_entry).includes("parked automatically"),
  );
}

const tasks = await q(`SELECT status FROM project_tasks`);
check("both TASKS still 'running' (not failed)", tasks.every((t) => t.status === "running"));
const projs = await q(`SELECT status FROM projects`);
check("both PROJECTS still 'active' (not blocked)", projs.every((p) => p.status === "active"));

const notes = await q(`SELECT text, source FROM notifications`);
check("exactly ONE notification for the whole outage", notes.length === 1, `got ${notes.length}`);
check("…tagged usage_wall", notes[0]?.source === "usage_wall");
console.log(`\n  Konrad's push: ${notes[0]?.text}\n`);

console.log("=== B. the wall does not lift: ladder, then give up ===");
for (const prior of [1, 2, 3]) {
  const t = await seed({
    projectName: `retry-prior-${prior}`,
    projectStatus: "active",
    errorText: "Executor failed: claude-code exit 1: You've hit your session limit",
    wallAttempts: prior,
  });
  const task = await settledFor(t.projectId);
  const deferred = await deferForUsageWall(task!, await getProject(t.projectId));
  const [run] = await q(`SELECT status, metadata->>'usage_wall_attempts' AS att, wake_after FROM runs WHERE id=$1`, [t.runId]);
  if (prior < 3) {
    check(`prior=${prior}: parked again as attempt ${prior + 1}`, deferred === true && run.att === String(prior + 1));
  } else {
    check(`prior=3: cap reached, hands back to the failure path`, deferred === false);
    check(`prior=3: run left 'failed', untouched`, run.status === "failed");
  }
}

console.log("\n=== C. what must NOT be parked ===");
const real = await seed({ projectName: "real-failure", projectStatus: "active", errorText: SPEND_CAP });
check(
  "a spend-cap failure is not a wall",
  (await deferForUsageWall((await settledFor(real.projectId))!, await getProject(real.projectId))) === false,
);

const blocked = await seed({ projectName: "blocked-project", projectStatus: "blocked", errorText: SESSION_WALL });
check(
  "a wall on a BLOCKED project is not parked (no work smuggled past the gate)",
  (await deferForUsageWall((await settledFor(blocked.projectId))!, await getProject(blocked.projectId))) === false,
);

const cancelled = await seed({
  projectName: "cancelled-run", projectStatus: "active", errorText: SESSION_WALL, runStatus: "cancelled",
});
check(
  "a CANCELLED run is never resurrected",
  (await deferForUsageWall((await settledFor(cancelled.projectId))!, await getProject(cancelled.projectId))) === false,
);
const [canc] = await q(`SELECT status FROM runs WHERE id=$1`, [cancelled.runId]);
check("…and stays cancelled", canc.status === "cancelled");

const notes2 = await q(`SELECT count(*)::int AS n FROM notifications`);
check("still exactly ONE notification after all of the above", notes2[0].n === 1, `got ${notes2[0].n}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
