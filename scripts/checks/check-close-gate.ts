/**
 * check-close-gate.ts — the behavioural proof of R70 against real rows:
 *
 *   R70  `closeFinishedProjects()` must not close a project while some
 *        workstream W <> 'main' has at least one task and there is NO task with
 *        workstream='main' whose `depends_on` covers every task id of W. The
 *        refusal is loud (NF1) — the project stays 'active' and the function
 *        reports it as `held` so the tick can name the workstream.
 *
 *   And the property every live project depends on: a project whose rows are
 *   ALL in workstream 'main' closes EXACTLY as it did before R70, whether its
 *   `depends_on` values are graph arrays or legacy NULLs.
 *
 * It calls the SHIPPED `closeFinishedProjects` — not a re-implementation — with
 * `DATABASE_URL` pointed at the scratch database and the pool's `search_path`
 * pinned to a throwaway schema, so what is proved is the function the executor
 * will run. The pure mirror (`unintegratedWorkstreams` in lib/task-graph.ts,
 * re-exported from lib/project-tick.ts) is unit-tested in project-tick.test.ts;
 * this script IMPORTS THE REAL PREDICATE (round 2 — it did not before, see item
 * (d) below) and proves the SQL agrees, project by project, rather than
 * asserting the agreement in a comment.
 *
 * ---------------------------------------------------------------------------
 * OPERATOR PREAMBLE — run these three lines once, by hand, before this script.
 * This script NEVER invents credentials: it only consumes $SCRATCH_DATABASE_URL.
 * Creating a scratch DATABASE on this host is authorised and conventional
 * (forge_tg_scratch and a dozen siblings already exist). Authorised means
 * CREATE DATABASE issued while connected to the `postgres` MAINTENANCE
 * database. It never means a statement of any kind against content_forge.
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_tg_scratch'   # once; ignore "already exists"
 *   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-close-gate.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, the
 * same gap `03-quality.md` §3.2 named for scripts/measure-schedule.ts):
 *   cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
 *     --module ESNext --moduleResolution bundler --lib ES2022 --skipLibCheck \
 *     --allowImportingTsExtensions --resolveJsonModule --types node \
 *     ../scripts/checks/check-close-gate.ts
 *
 * Exit: 0 = every case ran, executed exactly the assertions it declares, and
 * every one of them passed. Anything else is non-zero.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A *.test.ts
 *
 * NF3: the unit suite is hermetic and never touches a database — `pnpm test` is
 * `tsx --test src/lib/*.test.ts`. The property under test here is a property of
 * a SQL statement, and a SQL statement can only be observed by executing it. It
 * therefore lives here beside check-fix-chain-graph.ts and check-task-api.ts,
 * and must NEVER be added to `pnpm test`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot
 *
 *  (a) A FIXTURE WITH NO NON-MAIN WORKSTREAM. Then R70's term is vacuous, every
 *      project closes, and a broken term looks perfect. Guarded: case 3 asserts
 *      the row count of workstream 'ui' BEFORE it asserts anything about the
 *      close, and the assertion accounting below fails the run if that probe
 *      never executed.
 *  (b) THE REFUSAL BEING CREDITED TO R70 WHEN SOMETHING ELSE REFUSED IT — a
 *      typo in the status filter would hold every project and look like a pass.
 *      Guarded by a POSITIVE CONTROL: case 3 re-runs the PRE-R70 statement,
 *      verbatim, against the very same rows and asserts that it WOULD have
 *      closed the project. The only difference between the two statements is
 *      R70's term, so the refusal cannot be attributed to anything else.
 *  (c) A PASS THAT NEVER RAN THE SHIPPED CODE. Guarded: the build-identity
 *      block below prints the sha256 of the db/projects.ts this process
 *      imported, and case 1 fails unless the shipped function actually
 *      transitioned a project to 'done'.
 *  (d) THE PAIRING THAT DID NOT EXIST BEFORE ROUND 2. This file's own header
 *      claimed the SQL was proved against the pure predicate while importing
 *      only five node builtins — `grep -rn unintegratedWorkstreams src scripts`
 *      found exactly one non-comment importer, the unit test, so the agreement
 *      was asserted by a regex over source text and by nothing else. Round 2
 *      imports `unintegratedWorkstreams` from lib/task-graph.ts (the pure leaf
 *      — never lib/project-tick.ts, which would drag `db/*` and `node:fs` into
 *      this process and repoint DATABASE_URL out from under it) and, for every
 *      fixture project the SQL actually classified, re-runs the real predicate
 *      over that project's own rows and asserts the verdicts agree. A pass that
 *      never executed this step is caught the same way every other missed
 *      probe is: EXPECTED_ASSERTIONS below counts it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// The pure leaf, not lib/project-tick.ts — see item (d) above and
// oracle-sql-mirror-is-check-scheduler-sql / terminal-task-statuses-owned-by-
// the-pure-leaf in the fleet memory: lib/task-graph.ts type-imports
// TaskStatus from db/projects.ts only, so this stays a Postgres-free import
// and does not build a pg Pool before SCRATCH_DATABASE_URL is resolved below.
import { unintegratedWorkstreams, MAIN_WORKSTREAM, type CloseGateTask } from "../../forge-control/src/lib/task-graph.ts";

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "db", "migrations")) && existsSync(join(dir, "forge-control"))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    "check-close-gate.ts: could not find the repo root above " +
      `${process.cwd()} (looked for db/migrations + forge-control).`,
  );
}

const REPO_ROOT = findRepoRoot();
const SCHEMA = "tg_check_closegate";

/* ------------------------------------------------------------------------- *
 * 1. REFUSE-TO-RUN GUARD — first thing, before a single statement is issued.
 *    Ported verbatim in shape from check-fix-chain-graph.ts: resolve the target
 *    NAME, refuse content_forge, refuse the maintenance and template databases,
 *    refuse any database this fleet actually runs on, refuse a non-local host,
 *    and print the NAME only — never the DSN.
 * ------------------------------------------------------------------------- */

function refuse(why: string): never {
  console.error(`REFUSING TO RUN: ${why}`);
  process.exit(2);
}

function resolveScratchDatabase(): { dsn: string; name: string } {
  const dsn = (process.env.SCRATCH_DATABASE_URL ?? "").trim();
  if (!dsn) {
    refuse(
      "$SCRATCH_DATABASE_URL is unset. This check never guesses a connection " +
        "string; see the operator preamble in the header.",
    );
  }
  let url: URL;
  try {
    url = new URL(dsn);
  } catch (e) {
    refuse(
      `$SCRATCH_DATABASE_URL is not a parsable URL (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    refuse("$SCRATCH_DATABASE_URL is not a postgres:// URL.");
  }
  const name = url.pathname.replace(/^\//, "").split("?")[0] ?? "";
  if (!name) refuse("$SCRATCH_DATABASE_URL names no database.");
  const host = url.hostname || "localhost";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    refuse(`scratch database must be local, host resolved to ${JSON.stringify(host)}.`);
  }
  const banned = new Set(["content_forge", "postgres", "template0", "template1"]);
  if (banned.has(name)) {
    refuse(
      `${JSON.stringify(name)} is a protected database. Point $SCRATCH_DATABASE_URL ` +
        "at a throwaway scratch database.",
    );
  }
  const configs: string[] = ["/opt/forge-ai-os/.env", "/opt/content-forge/.env"];
  const secretsDir = "/opt/ai-os/.secrets";
  if (existsSync(secretsDir)) {
    for (const f of readdirSync(secretsDir)) {
      if (f.endsWith(".env")) configs.push(join(secretsDir, f));
    }
  }
  const live = new Set<string>();
  for (const path of configs) {
    let blob: string;
    try {
      blob = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const m of blob.matchAll(/postgres(?:ql)?:\/\/[^\s'"]+/g)) {
      try {
        const found = new URL(m[0]).pathname.replace(/^\//, "").split("?")[0];
        if (found) live.add(found);
      } catch {
        continue;
      }
    }
  }
  if (live.has(name)) {
    refuse(
      `${JSON.stringify(name)} is a database this fleet runs on (found in the fleet ` +
        "config). Use a throwaway scratch database.",
    );
  }
  return { dsn, name };
}

const SCRATCH = resolveScratchDatabase();

/* ------------------------------------------------------------------------- *
 * 2. psql plumbing. Everything this script issues DIRECTLY (schema, seed,
 *    verification reads, the positive control) goes through here with
 *    search_path pinned and ON_ERROR_STOP set. The row under test is
 *    TRANSITIONED by the shipped closeFinishedProjects through its own pool.
 * ------------------------------------------------------------------------- */

function runPsql(extra: readonly string[], label: string, schema = SCHEMA): string {
  const r = spawnSync("psql", [SCRATCH.dsn, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...extra], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` },
  });
  if (r.error) throw new Error(`psql (${label}) failed to spawn: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `psql (${label}) exited ${r.status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`,
    );
  }
  return r.stdout;
}

function q(sql: string): string {
  return runPsql(["-At", "-c", sql], sql.slice(0, 70)).trim();
}

function exec(sql: string, label: string): void {
  runPsql(["-c", sql], label);
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------------- *
 * 3. Assertions, and the accounting that makes a missed probe a failure.
 * ------------------------------------------------------------------------- */

const EXPECTED_ASSERTIONS = 51;
let assertionsRun = 0;
let assertionsFailed = 0;

function pass(name: string, detail: string): void {
  assertionsRun += 1;
  console.log(`      ok   ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string): void {
  assertionsRun += 1;
  assertionsFailed += 1;
  console.error(`      FAIL ${name} — ${detail}`);
}

function assertEq(name: string, expected: unknown, actual: unknown): void {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e === a) pass(name, `= ${a}`);
  else fail(name, `expected ${e}, got ${a}`);
}

/* ------------------------------------------------------------------------- *
 * 4. Build identity — printed before any assertion. A harness that does not
 *    expose its own build identity is not evidence (00-vision.md §7 rule 3).
 * ------------------------------------------------------------------------- */

function sha256(rel: string): string {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, rel))).digest("hex").slice(0, 16);
}

function git(args: readonly string[]): string {
  const r = spawnSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : `<git ${args.join(" ")} failed>`;
}

const PROJECTS_REL = "forge-control/src/db/projects.ts";
const TASK_GRAPH_REL = "forge-control/src/lib/task-graph.ts";

console.log("=== check-close-gate.ts — build identity =====================================");
console.log(`  repo worktree        : ${REPO_ROOT}`);
console.log(`  git HEAD             : ${git(["rev-parse", "--short", "HEAD"])}`);
console.log(`  git branch           : ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`);
console.log(
  `  uncommitted (subj)   : ${git(["status", "--porcelain", "--", PROJECTS_REL]) || "(clean)"}`,
);
console.log(`  sha256(projects.ts)  : ${sha256(PROJECTS_REL)}…`);
console.log(
  `  uncommitted (pure)   : ${git(["status", "--porcelain", "--", TASK_GRAPH_REL]) || "(clean)"}`,
);
console.log(`  sha256(task-graph.ts): ${sha256(TASK_GRAPH_REL)}… (owns unintegratedWorkstreams, round 2)`);
console.log(`  scratch database     : ${SCRATCH.name} (local; DSN never printed)`);
console.log(`  throwaway schema     : ${SCHEMA}`);
console.log(`  expected assertions  : ${EXPECTED_ASSERTIONS}`);
console.log("==============================================================================");
console.log();

/* ------------------------------------------------------------------------- *
 * 5. Fixtures. One project per case, all seeded before the single call to the
 *    shipped function — because closeFinishedProjects() is a SET operation over
 *    every active project, and running all the cases through one call is the
 *    only way to prove it discriminates between them rather than answering the
 *    same thing to everyone.
 * ------------------------------------------------------------------------- */

const P = {
  legacy: "00000000-0000-4000-8000-0000000c1001",
  graphMain: "00000000-0000-4000-8000-0000000c1002",
  wsNoIntegration: "00000000-0000-4000-8000-0000000c1003",
  wsIntegrated: "00000000-0000-4000-8000-0000000c1004",
  wsPartial: "00000000-0000-4000-8000-0000000c1005",
  wsForeignIntegrator: "00000000-0000-4000-8000-0000000c1006",
  unfinished: "00000000-0000-4000-8000-0000000c1007",
  crossProject: "00000000-0000-4000-8000-0000000c1008",
  // Round 2 — the four cases the brief names, each proving transitive
  // reachability rather than direct membership (see the header's item (d)).
  chainLive: "00000000-0000-4000-8000-0000000c1009",
  cycleReachable: "00000000-0000-4000-8000-0000000c100a",
  negativeUnreachable: "00000000-0000-4000-8000-0000000c100b",
  disconnectedBranch: "00000000-0000-4000-8000-0000000c100c",
} as const;

/** `depends_on` values: `null` is the LEGACY sentinel, an array is a graph row. */
type Deps = string[] | null;

let seq = 0;
function taskId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function seedProject(id: string, name: string): void {
  exec(
    `INSERT INTO projects (id, name, brief, repo, base_branch, status)
     VALUES (${lit(id)}, ${lit(name)}, ${lit("fixture")}, 'ai-os', 'main', 'active')`,
    `project ${name}`,
  );
}

function seedTask(
  projectId: string,
  id: string,
  workstream: string,
  depends: Deps,
  status = "done",
  role = "builder",
): void {
  const deps = depends === null ? "NULL" : `ARRAY[${depends.map(lit).join(",")}]::uuid[]`;
  exec(
    `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, depends_on)
     VALUES (${lit(id)}, ${lit(projectId)}, 1, ${lit(role)}, ${lit(`t-${id.slice(-4)}`)},
             ${lit("fixture")}, ${lit(status)}, ${lit(workstream)}, ${deps})`,
    `task ${id.slice(-4)} (${workstream})`,
  );
}

/** The statement as it stood BEFORE R70 — the positive control. Character for
 *  character the pre-phase-4C `closeFinishedProjects` predicate, with the
 *  UPDATE replaced by a SELECT so running it changes nothing. If this does not
 *  name a project that the shipped function refused, the refusal cannot be
 *  attributed to R70's term. */
const PRE_R70_PREDICATE = `
  SELECT p.id::text FROM projects p
   WHERE p.status = 'active'
     AND EXISTS (SELECT 1 FROM project_tasks WHERE project_id = p.id)
     AND NOT EXISTS (
       SELECT 1 FROM project_tasks
        WHERE project_id = p.id AND status <> 'done'
     )
   ORDER BY p.id`;

async function main(): Promise<void> {
  console.log("--- 1. schema + migrations ---------------------------------------------------");
  runPsql(
    ["-c", `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`, "-c", `CREATE SCHEMA ${SCHEMA}`],
    "schema reset",
    "public",
  );
  // The one forced placeholder, exactly as check-migration-0040.sh documents:
  // 0021_ai_os_tables.sql declares a FK to content_jobs, which belongs to the
  // content-forge pipeline schema and is created by no migration in this repo.
  exec("CREATE TABLE content_jobs (id uuid PRIMARY KEY)", "content_jobs placeholder");
  const migrations = readdirSync(join(REPO_ROOT, "db", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of migrations) runPsql(["-f", join("db", "migrations", f)], f);
  console.log(`  applied ${migrations.length} migrations into ${SCHEMA}`);
  console.log();

  console.log("--- 2. fixtures --------------------------------------------------------------");

  // (1) A LEGACY project: every row 'main', every depends_on NULL, all done.
  //     This is the shape of every live project on the box today.
  seedProject(P.legacy, "legacy-all-main");
  seedTask(P.legacy, taskId(), "main", null);
  seedTask(P.legacy, taskId(), "main", null);

  // (2) A GRAPH project with only workstream 'main'.
  const g1 = taskId();
  seedProject(P.graphMain, "graph-all-main");
  seedTask(P.graphMain, g1, "main", []);
  seedTask(P.graphMain, taskId(), "main", [g1]);

  // (3) THE ATTACK (03-quality.md §5): workstream 'ui', every task done, no
  //     integration task anywhere. Closing this loses everything on
  //     project/<id8>-ui.
  const a1 = taskId();
  const aUi1 = taskId();
  const aUi2 = taskId();
  seedProject(P.wsNoIntegration, "ws-no-integration");
  seedTask(P.wsNoIntegration, a1, "main", []);
  seedTask(P.wsNoIntegration, aUi1, "ui", [a1]);
  seedTask(P.wsNoIntegration, aUi2, "ui", [a1]);

  // (4) The same, with R38's integration task in 'main' covering both ui rows,
  //     and the reviewer that depends only on the integration task. THE
  //     MEMBERSHIP CASE: neither is a member of 'ui', so neither has to depend
  //     on itself, and this project MUST close.
  const b1 = taskId();
  const bUi1 = taskId();
  const bUi2 = taskId();
  const bInt = taskId();
  seedProject(P.wsIntegrated, "ws-integrated");
  seedTask(P.wsIntegrated, b1, "main", []);
  seedTask(P.wsIntegrated, bUi1, "ui", [b1]);
  seedTask(P.wsIntegrated, bUi2, "ui", [b1]);
  seedTask(P.wsIntegrated, bInt, "main", [bUi1, bUi2]);
  seedTask(P.wsIntegrated, taskId(), "main", [bInt], "done", "reviewer");

  // (5) An integration task that covers only PART of the workstream.
  const c1 = taskId();
  const cUi1 = taskId();
  const cUi2 = taskId();
  seedProject(P.wsPartial, "ws-partial-integration");
  seedTask(P.wsPartial, c1, "main", []);
  seedTask(P.wsPartial, cUi1, "ui", [c1]);
  seedTask(P.wsPartial, cUi2, "ui", [c1]);
  seedTask(P.wsPartial, taskId(), "main", [cUi1]);

  // (6) A covering task that lives in ANOTHER workstream, chained INTO by a
  //     proper 'main' integrator.
  //
  //     ROUND 2 CORRECTION: this fixture predates the transitive rewrite
  //     (project-tick.test.ts era of R70, direct `depends_on` membership) and
  //     was never re-run against the shipped round-1 code before this round —
  //     it was silently stale, an orphan of [[checks-dir-is-compiled-not-executed]].
  //     Under DIRECT membership the final 'main' task named only `dApi1`, so
  //     'ui' (member `dUi1`) was uncovered and the project stayed held — that
  //     was the case's whole point. Under TRANSITIVE reachability (landed,
  //     `unintegratedWorkstreams()`'s own "COVERAGE IS ⊇, NOT =" doc-comment)
  //     the SAME final task now walks `dApi1 -> dUi1 -> d1` and reaches `dUi1`
  //     too, so 'ui' is ALSO covered — by design, not by accident: reachability
  //     does not stop at a workstream boundary partway along the chain, only
  //     the id it started from ('main') and the ids it must cover matter. Both
  //     the SQL and the pure mirror agree this project now CLOSES — see the
  //     round-2 mirror step below — so the fixture is kept as the demonstration
  //     of that specific, intended consequence rather than reworked to dodge it.
  const d1 = taskId();
  const dUi1 = taskId();
  const dApi1 = taskId();
  seedProject(P.wsForeignIntegrator, "ws-foreign-integrator");
  seedTask(P.wsForeignIntegrator, d1, "main", []);
  seedTask(P.wsForeignIntegrator, dUi1, "ui", [d1]);
  seedTask(P.wsForeignIntegrator, dApi1, "api", [dUi1]); // covers all of 'ui' — but is not 'main'
  seedTask(P.wsForeignIntegrator, taskId(), "main", [dApi1]); // integrates 'api', and transitively 'ui' through it

  // (7) A project with work still to do — neither closed nor reported held.
  seedProject(P.unfinished, "unfinished");
  seedTask(P.unfinished, taskId(), "main", [], "running");

  // (8) CROSS-PROJECT: this project's 'ui' rows are covered only by a task
  //     belonging to a DIFFERENT project. Without the project_id correlation on
  //     all three levels, that foreign task would release this workstream.
  const e1 = taskId();
  const eUi1 = taskId();
  seedProject(P.crossProject, "cross-project");
  seedTask(P.crossProject, e1, "main", []);
  seedTask(P.crossProject, eUi1, "ui", [e1]);
  //     …the vouching task lives in project (2), which is otherwise all-'main'.
  //     Note it names a task of ANOTHER project, which is corruption the engine
  //     would refuse to create (R27) — but an operator with psql can, and R70's
  //     correlation is what makes it harmless here.
  seedTask(P.graphMain, taskId(), "main", [eUi1]);

  // (9) ROUND 2 — THE LIVE SHAPE, the red-to-green case. Workstream 'md' is a
  //     CHAIN (f1 <- fmd1 <- fmd2 <- fmd3) and the one 'main' integrator
  //     depends only on the LAST link, exactly as every architect-seeded
  //     integration task does. Direct array membership held this forever
  //     (fmd1/fmd2 never appear in the integrator's own depends_on); transitive
  //     reachability walks fmd3 -> fmd2 -> fmd1 and closes it. This is the
  //     shape measured live on all eight failing workstreams
  //     (r70-transitive-fix-is-invisible-to-its-own-tests.md).
  const f1 = taskId();
  const fmd1 = taskId();
  const fmd2 = taskId();
  const fmd3 = taskId();
  seedProject(P.chainLive, "chain-live-shape");
  seedTask(P.chainLive, f1, MAIN_WORKSTREAM, []);
  seedTask(P.chainLive, fmd1, "md", [f1]);
  seedTask(P.chainLive, fmd2, "md", [fmd1]);
  seedTask(P.chainLive, fmd3, "md", [fmd2]);
  seedTask(P.chainLive, taskId(), MAIN_WORKSTREAM, [fmd3]);

  // (10) ROUND 2 — A CYCLE inside W, reachable from the integrator: gc1 and
  //      gc2 depend on each other. The walk must both answer correctly (the
  //      cycle does not hide gc1 from the integrator) and TERMINATE — proven
  //      below by timing the single call that has to resolve this alongside
  //      every other fixture (recursive-cte-depth-column-defeats-the-union-
  //      cycle-guard.md: dedup is the guard, not a depth column).
  const g0 = taskId();
  const gc1 = taskId();
  const gc2 = taskId();
  seedProject(P.cycleReachable, "cycle-inside-workstream");
  seedTask(P.cycleReachable, g0, MAIN_WORKSTREAM, []);
  seedTask(P.cycleReachable, gc1, "cyc", [g0, gc2]);
  seedTask(P.cycleReachable, gc2, "cyc", [gc1]);
  seedTask(P.cycleReachable, taskId(), MAIN_WORKSTREAM, [gc2]);

  // (11) ROUND 2 — THE PRESERVED NEGATIVE, the case that stops the fix from
  //      becoming a tautology. Workstream 'orphan' chains internally
  //      (ho1 <- ho2) exactly like the live-shape case above, but NO 'main'
  //      task depends on either of them, directly or transitively — there is
  //      no path in from any integrator at all. Must stay HELD.
  const h0 = taskId();
  const ho1 = taskId();
  const ho2 = taskId();
  seedProject(P.negativeUnreachable, "no-path-reaches-it");
  seedTask(P.negativeUnreachable, h0, MAIN_WORKSTREAM, []);
  seedTask(P.negativeUnreachable, ho1, "orphan", [h0]);
  seedTask(P.negativeUnreachable, ho2, "orphan", [ho1]);

  // (12) ROUND 2 — A DISCONNECTED SECOND BRANCH: workstream 'branch' has two
  //      tasks off the SAME root, ibA1 and ibB1, that never depend on each
  //      other. The integrator reaches ibA1 transitively but has no edge
  //      anywhere near ibB1. Coverage is over EVERY task of W, so partial
  //      transitive reach still holds the project.
  const i0 = taskId();
  const ibA1 = taskId();
  const ibB1 = taskId();
  seedProject(P.disconnectedBranch, "disconnected-second-branch");
  seedTask(P.disconnectedBranch, i0, MAIN_WORKSTREAM, []);
  seedTask(P.disconnectedBranch, ibA1, "branch", [i0]);
  seedTask(P.disconnectedBranch, ibB1, "branch", [i0]);
  seedTask(P.disconnectedBranch, taskId(), MAIN_WORKSTREAM, [ibA1]);

  assertEq("twelve fixture projects seeded", "12", q("SELECT count(*) FROM projects"));
  assertEq(
    "chainLive workstream 'md' really is a 3-task chain (round 2)",
    "3",
    q(`SELECT count(*) FROM project_tasks WHERE project_id = ${lit(P.chainLive)} AND workstream = 'md'`),
  );
  assertEq(
    "cycleReachable workstream 'cyc' really contains the cycle (round 2)",
    "2",
    q(`SELECT count(*) FROM project_tasks WHERE project_id = ${lit(P.cycleReachable)} AND workstream = 'cyc'`),
  );
  assertEq(
    "negativeUnreachable workstream 'orphan' really has no integrator naming it (round 2)",
    "0",
    q(
      `SELECT count(*) FROM project_tasks
        WHERE project_id = ${lit(P.negativeUnreachable)} AND workstream = 'main'
          AND depends_on IS NOT NULL
          AND (${lit(ho1)} = ANY(depends_on) OR ${lit(ho2)} = ANY(depends_on))`,
    ),
  );
  assertEq(
    "disconnectedBranch workstream 'branch' really has two independent tasks (round 2)",
    "2",
    q(`SELECT count(*) FROM project_tasks WHERE project_id = ${lit(P.disconnectedBranch)} AND workstream = 'branch'`),
  );
  assertEq(
    "the attack fixture really holds a non-main workstream",
    "2",
    q(`SELECT count(*) FROM project_tasks WHERE project_id = ${lit(P.wsNoIntegration)} AND workstream = 'ui'`),
  );
  assertEq(
    "every fixture project except (7) has all tasks done",
    "1",
    q("SELECT count(DISTINCT project_id) FROM project_tasks WHERE status <> 'done'"),
  );
  console.log();

  console.log("--- 3. POSITIVE CONTROL: the pre-R70 statement would have closed the attack ---");
  const wouldHaveClosed = q(PRE_R70_PREDICATE).split("\n").filter(Boolean).sort();
  assertEq(
    "pre-R70, all eleven finished projects qualify to close — including every held one",
    [
      P.crossProject,
      P.graphMain,
      P.legacy,
      P.wsForeignIntegrator,
      P.wsIntegrated,
      P.wsNoIntegration,
      P.wsPartial,
      P.chainLive,
      P.cycleReachable,
      P.negativeUnreachable,
      P.disconnectedBranch,
    ].sort(),
    wouldHaveClosed,
  );
  console.log(
    "      (so any project the shipped function leaves 'active' below was refused by R70's term\n" +
      "       and by nothing else — the two statements differ in that term alone)",
  );
  console.log();

  console.log("--- 4. the SHIPPED closeFinishedProjects() -----------------------------------");
  // The pool is built at import; the URL and the search_path must be in place
  // first. Nothing else in this process writes through that pool.
  const url = new URL(SCRATCH.dsn);
  url.searchParams.set("options", `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  const { closeFinishedProjects } = (await import(join(REPO_ROOT, PROJECTS_REL))) as {
    closeFinishedProjects: () => Promise<{
      closed: Array<{ id: string; name: string }>;
      held: Array<{ id: string; name: string }>;
    }>;
  };

  const callStartedAt = Date.now();
  const out = await closeFinishedProjects();
  const callElapsedMs = Date.now() - callStartedAt;
  const closed = out.closed.map((p) => p.id).sort();
  const held = out.held.map((p) => p.id).sort();
  console.log(`      closed: ${out.closed.map((p) => p.name).join(", ") || "(none)"}`);
  console.log(`      held  : ${out.held.map((p) => p.name).join(", ") || "(none)"}`);
  console.log(`      elapsed: ${callElapsedMs}ms`);
  console.log();

  assertEq("(1) a legacy all-'main' project closes, exactly as before R70", true, closed.includes(P.legacy));
  assertEq("(2) a graph all-'main' project closes", true, closed.includes(P.graphMain));
  assertEq("(3) THE ATTACK — a workstream with no integration task does NOT close", false, closed.includes(P.wsNoIntegration));
  assertEq("(3) …and it is reported held, not silently skipped (NF1)", true, held.includes(P.wsNoIntegration));
  assertEq("(4) an integrated workstream closes — the integrator does not depend on itself", true, closed.includes(P.wsIntegrated));
  assertEq("(4) …and is NOT reported held", false, held.includes(P.wsIntegrated));
  assertEq("(5) partial coverage does not close", false, closed.includes(P.wsPartial));
  assertEq("(5) …and is reported held", true, held.includes(P.wsPartial));
  assertEq(
    "(6) a proper 'main' integrator chained THROUGH another workstream closes it too (round-2 correction)",
    true,
    closed.includes(P.wsForeignIntegrator),
  );
  assertEq("(6) …and is NOT reported held", false, held.includes(P.wsForeignIntegrator));
  assertEq("(7) a project with a running task neither closes…", false, closed.includes(P.unfinished));
  assertEq("(7) …nor is reported held", false, held.includes(P.unfinished));
  assertEq("(8) another project's task cannot vouch for this workstream", false, closed.includes(P.crossProject));
  assertEq("(8) …and it is reported held", true, held.includes(P.crossProject));
  assertEq(
    "(9) THE LIVE SHAPE — a chain workstream closes via transitive reach, round 2",
    true,
    closed.includes(P.chainLive),
  );
  assertEq("(9) …and is NOT reported held", false, held.includes(P.chainLive));
  assertEq(
    "(10) a cycle inside W, reachable from the integrator, still closes, round 2",
    true,
    closed.includes(P.cycleReachable),
  );
  assertEq("(10) …and is NOT reported held", false, held.includes(P.cycleReachable));
  assertEq(
    "(10) …and the whole call — cycle included — terminates well under 5s",
    true,
    callElapsedMs < 5000,
  );
  assertEq(
    "(11) THE PRESERVED NEGATIVE — no path from any integrator does NOT close, round 2",
    false,
    closed.includes(P.negativeUnreachable),
  );
  assertEq("(11) …and it is reported held", true, held.includes(P.negativeUnreachable));
  assertEq(
    "(12) A DISCONNECTED SECOND BRANCH — partial transitive reach does NOT close, round 2",
    false,
    closed.includes(P.disconnectedBranch),
  );
  assertEq("(12) …and it is reported held", true, held.includes(P.disconnectedBranch));
  assertEq("exactly six projects closed", 6, closed.length);
  assertEq("exactly five projects are held", 5, held.length);

  console.log();
  console.log("--- 5. the rows agree with the return value ----------------------------------");
  assertEq(
    "six projects are 'done' in the table",
    "6",
    q("SELECT count(*) FROM projects WHERE status = 'done'"),
  );
  assertEq(
    "the attack project is still 'active'",
    "active",
    q(`SELECT status FROM projects WHERE id = ${lit(P.wsNoIntegration)}`),
  );
  assertEq(
    "no task row was touched",
    "0",
    q("SELECT count(*) FROM project_tasks WHERE updated_at <> created_at"),
  );

  console.log();
  console.log("--- 5b. ROUND 2 — the SQL agrees with the REAL unintegratedWorkstreams() ------");
  // Item (d) above: for every fixture project the SQL actually classified (i.e.
  // excluding P.unfinished, which the SQL puts in neither partition because it
  // has an open task and never reaches R70's term at all), read that project's
  // own (id, workstream, depends_on) rows back out of the scratch schema, run
  // the SHIPPED pure predicate over them, and assert its verdict agrees with the
  // SQL's closed/held split: pure returns [] exactly when the SQL closed the
  // project, and pure names at least one workstream exactly when the SQL held
  // it. This is the driver step check-scheduler-sql.sh's `mirror` step models —
  // it is what makes "if the two disagree the pure side is right" a checked
  // claim instead of a comment.
  function fetchCloseGateTasks(projectId: string): CloseGateTask[] {
    const raw = q(
      `SELECT COALESCE(json_agg(json_build_object(
                'id', id::text, 'workstream', workstream, 'depends_on', depends_on
              )), '[]'::json)
         FROM project_tasks WHERE project_id = ${lit(projectId)}`,
    );
    return JSON.parse(raw) as CloseGateTask[];
  }

  const MIRROR_PROJECTS: ReadonlyArray<{ id: string; label: string }> = [
    { id: P.legacy, label: "(1) legacy" },
    { id: P.graphMain, label: "(2) graphMain" },
    { id: P.wsNoIntegration, label: "(3) THE ATTACK" },
    { id: P.wsIntegrated, label: "(4) wsIntegrated" },
    { id: P.wsPartial, label: "(5) wsPartial" },
    { id: P.wsForeignIntegrator, label: "(6) wsForeignIntegrator (closes, round-2 correction)" },
    { id: P.crossProject, label: "(8) crossProject" },
    { id: P.chainLive, label: "(9) chainLive" },
    { id: P.cycleReachable, label: "(10) cycleReachable" },
    { id: P.negativeUnreachable, label: "(11) negativeUnreachable" },
    { id: P.disconnectedBranch, label: "(12) disconnectedBranch" },
  ];
  for (const { id, label } of MIRROR_PROJECTS) {
    const rows = fetchCloseGateTasks(id);
    const pureOpen = unintegratedWorkstreams(rows);
    assertEq(
      `mirror: pure unintegratedWorkstreams() agrees with the SQL partition for ${label}`,
      closed.includes(id),
      pureOpen.length === 0,
    );
  }

  console.log();
  console.log("--- 6. idempotence: a second call closes nothing new --------------------------");
  const again = await closeFinishedProjects();
  assertEq("second call closes nothing", 0, again.closed.length);
  assertEq("second call still reports the same five held", 5, again.held.length);

  console.log();
  console.log("--- 7. creating the missing integration task releases the project ------------");
  const fixInt = taskId();
  seedTask(P.wsNoIntegration, fixInt, "main", [aUi1, aUi2]);
  const third = await closeFinishedProjects();
  assertEq(
    "the attack project closes once R38's integration task exists",
    true,
    third.closed.map((p) => p.id).includes(P.wsNoIntegration),
  );
  assertEq("…and is no longer held", false, third.held.map((p) => p.id).includes(P.wsNoIntegration));
}

main()
  .then(() => {
    console.log();
    console.log("=== summary ==================================================================");
    console.log(`  assertions run    : ${assertionsRun} (expected ${EXPECTED_ASSERTIONS})`);
    console.log(`  assertions failed : ${assertionsFailed}`);
    if (assertionsRun !== EXPECTED_ASSERTIONS) {
      console.error(
        `  PROBE COUNT MISMATCH: ${assertionsRun} ran, ${EXPECTED_ASSERTIONS} declared. ` +
          "A sweep whose probes miss must fail, not certify itself.",
      );
      process.exit(1);
    }
    if (assertionsFailed > 0) {
      console.error("  FAILED");
      process.exit(1);
    }
    console.log("  PASS");
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.error();
    console.error("check-close-gate.ts ABORTED — NOT a pass:");
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.error(`  assertions run before the abort: ${assertionsRun}`);
    process.exit(1);
  });
