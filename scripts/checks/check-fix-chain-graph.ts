/**
 * check-fix-chain-graph.ts — the behavioural proof of phase 4B's two database
 * halves, against real rows in a throwaway schema:
 *
 *   R42  `createFixChain()` writes the graph fields, so the chain is NOT born a
 *        root that promotes immediately, in parallel with the work it follows.
 *   R41  a group renumbered AFTER its chain exists cannot land a SECOND chain —
 *        the hazard recorded round 204 from phase 2's red team, decided round
 *        221, and the case `04-phases.md` Phase 4 deliverable 11 demands.
 *   R40  two groups at ONE round in TWO workstreams both land, and neither
 *        row's brief reaches the other's worktree.
 *
 * It calls the SHIPPED `createFixChain` — not a re-implementation of it — with
 * `DATABASE_URL` pointed at the scratch database and the pool's `search_path`
 * pinned to a throwaway schema, so what is proved is the function the executor
 * will run.
 *
 * ---------------------------------------------------------------------------
 * OPERATOR PREAMBLE — run these three lines once, by hand, before this script.
 * This script NEVER invents credentials: it only consumes $SCRATCH_DATABASE_URL.
 * Creating a scratch DATABASE on this host is authorised and conventional
 * (forge_tg_scratch, forge_r850_dryrun, fleet_selftest and a dozen siblings
 * already exist). Authorised means CREATE DATABASE issued while connected to
 * the `postgres` MAINTENANCE database. It never means a statement of any kind
 * against content_forge.
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_tg_scratch'   # once; ignore "already exists"
 *   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-fix-chain-graph.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, the
 * same gap `03-quality.md` §3.2 named for scripts/measure-schedule.ts):
 *   cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
 *     --module ESNext --moduleResolution bundler --lib ES2022 --skipLibCheck \
 *     --allowImportingTsExtensions --resolveJsonModule --types node \
 *     ../scripts/checks/check-fix-chain-graph.ts
 *
 * Exit: 0 = every case ran, executed exactly the assertions it declares, and
 * every one of them passed. Anything else is non-zero.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A *.test.ts
 *
 * NF3: the unit suite is hermetic and never touches a database — `pnpm test` is
 * `tsx --test src/lib/*.test.ts` with type-only imports of `db/*`. This needs a
 * real Postgres, because the two properties under test are properties of the
 * two UNIQUE INDEXES and of a transaction. It therefore lives here beside
 * check-migration-0040.sh and check-task-api.ts and must NEVER be added to
 * `pnpm test`.
 *
 * The pure halves — `fixChainGraphFields`, `duplicatesFixChain`, `chainKeys`,
 * the titles — are unit-tested in `project-reconcile.test.ts` (T22–T24, T28).
 * This script proves the rows.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot
 *
 *  (a) AN EMPTY DATABASE. A check that certifies zero rows certifies nothing.
 *      Guarded: every assertion that counts rows names the count it expects,
 *      and case 1 fails unless `createFixChain` actually created three rows.
 *  (b) THE RENUMBER CASE PASSING BECAUSE A UNIQUE INDEX REFUSED IT, not because
 *      the guard did. That would be a green light for deleting the guard.
 *      Guarded by a POSITIVE CONTROL: before the refusal is provoked, the
 *      script proves that BOTH indexes would have admitted the row — the new
 *      chain_key is free and the identity tuple (project, round, role, title)
 *      is free — so the only thing that can refuse it is the guard.
 *  (c) A REFUSAL THAT ALSO WROTE SOMETHING. A guard that throws after inserting
 *      half a chain is worse than none. Guarded: the row count is captured
 *      before and after the refusal and asserted equal.
 *  (d) PROBES THAT MISS. The script counts the assertions it executed and exits
 *      non-zero if that count is below EXPECTED_ASSERTIONS. A sweep whose
 *      probes miss must fail, never certify itself (00-vision.md §7 rule 3).
 *  (e) A STALE SCHEMA from an earlier run making `IF NOT EXISTS` DDL a no-op.
 *      Guarded: the schema is dropped and recreated, and the pre-flight asserts
 *      project_tasks carries all three graph columns and both unique indexes
 *      before a single row is written.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------------- *
 * 0. Repo root, resolved by structure — this file is transpiled to CJS by tsx
 *    (there is no package.json at the repo root) and neither __dirname nor
 *    import.meta is guaranteed across that boundary.
 * ------------------------------------------------------------------------- */

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "db", "migrations")) && existsSync(join(dir, "forge-control"))) {
      return dir;
    }
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `check-fix-chain-graph.ts: could not find the repo root above ${process.cwd()} ` +
      "(looked for db/migrations + forge-control). Run it as: " +
      "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-fix-chain-graph.ts",
  );
}

const REPO_ROOT = findRepoRoot();
const SCHEMA = "tg_check_fixchain";

/* ------------------------------------------------------------------------- *
 * 1. REFUSE-TO-RUN GUARD — first thing, before a single statement is issued.
 *    Ported from check-task-api.ts, which ported it from
 *    check-migration-0040.sh: resolve the target NAME, refuse content_forge,
 *    refuse the maintenance and template databases, refuse any database this
 *    fleet actually runs on, refuse a non-local host, and print the NAME only —
 *    never the DSN.
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
 * 2. psql plumbing — everything this script issues DIRECTLY (schema, seed,
 *    verification reads) goes through here, with search_path pinned to the
 *    throwaway schema and ON_ERROR_STOP so a SQL error is a failure with a
 *    location. The DSN is passed in argv and never logged.
 *
 *    The rows under test are written by the shipped `createFixChain` through
 *    its own pool, NOT through here — see section 5.
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

/** One scalar answer, trimmed. */
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

const EXPECTED_ASSERTIONS = 40;
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

function assertOk(name: string, cond: boolean, detail: string): void {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

/* ------------------------------------------------------------------------- *
 * 4. Build identity — printed before any assertion. A harness that does not
 *    expose its own build identity is not evidence (standing rule 3), and
 *    "which copy of createFixChain did this run?" is exactly the question a
 *    reviewer of this evidence has to be able to answer.
 * ------------------------------------------------------------------------- */

function sha256(rel: string): string {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, rel))).digest("hex").slice(0, 16);
}

function git(args: readonly string[]): string {
  const r = spawnSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : `<git ${args.join(" ")} failed>`;
}

const PROJECTS_REL = "forge-control/src/db/projects.ts";
const RECONCILE_REL = "forge-control/src/lib/project-reconcile.ts";

console.log("=== check-fix-chain-graph.ts — build identity =================================");
console.log(`  repo worktree        : ${REPO_ROOT}`);
console.log(`  git HEAD             : ${git(["rev-parse", "--short", "HEAD"])}`);
console.log(`  git branch           : ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`);
console.log(`  uncommitted (subj)   : ${git(["status", "--porcelain", "--", PROJECTS_REL, RECONCILE_REL]) || "(clean)"}`);
console.log(`  sha256(projects.ts)  : ${sha256(PROJECTS_REL)}…`);
console.log(`  sha256(reconcile.ts) : ${sha256(RECONCILE_REL)}…`);
console.log(`  scratch database     : ${SCRATCH.name} (local; DSN never printed)`);
console.log(`  throwaway schema     : ${SCHEMA}`);
console.log(`  expected assertions  : ${EXPECTED_ASSERTIONS}`);
console.log("==============================================================================");
console.log();

/* ------------------------------------------------------------------------- *
 * 5. The real schema, from the real migrations, then the shipped module.
 *
 *    `DATABASE_URL` is set BEFORE the dynamic import, because db/projects.ts
 *    constructs its pool at module load. `options=-c search_path=…` travels in
 *    the startup packet, so the shipped code writes into the throwaway schema
 *    without a line of it knowing that it did.
 * ------------------------------------------------------------------------- */

const PROJECT_ID = "00000000-0000-4000-8000-00000000fc01";
/** The two gating reviewers of round 7, one per workstream. */
const T_MAIN_A = "00000000-0000-4000-8000-00000000fc11";
const T_MAIN_B = "00000000-0000-4000-8000-00000000fc12";
const T_UI = "00000000-0000-4000-8000-00000000fc21";

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
  for (const f of migrations) {
    runPsql(["-f", join("db", "migrations", f)], f);
  }
  console.log(`  applied ${migrations.length} migrations into ${SCHEMA}`);

  // Pre-flight (failure mode (e)): the shape under test is really there.
  assertEq(
    "pre-flight: all three graph columns exist",
    "3",
    q(
      `SELECT count(*) FROM information_schema.columns WHERE table_schema=${lit(SCHEMA)} ` +
        `AND table_name='project_tasks' AND column_name IN ('depends_on','workstream','write_set')`,
    ),
  );
  assertEq(
    "pre-flight: both unique indexes exist",
    "2",
    q(
      `SELECT count(*) FROM pg_indexes WHERE schemaname=${lit(SCHEMA)} ` +
        `AND indexname IN ('project_tasks_identity_idx','project_tasks_chain_key_uniq')`,
    ),
  );
  assertEq(
    "pre-flight: the identity index still has NO workstream term",
    "project_id, round, role, title",
    q(
      `SELECT array_to_string(array_agg(a.attname ORDER BY k.ord), ', ') ` +
        `FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid ` +
        `JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true ` +
        `JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ` +
        `WHERE c.relname = 'project_tasks_identity_idx' AND c.relnamespace = ${lit(SCHEMA)}::regnamespace`,
    ),
  );
  console.log();

  console.log("--- 2. seed: one project, two groups at round 7 -------------------------------");
  exec(
    `INSERT INTO projects (id, name, brief, repo, status) VALUES (` +
      `${lit(PROJECT_ID)}, 'phase-4B fix-chain check (synthetic)', ` +
      `'Scratch project for check-fix-chain-graph.ts. Not a real project.', 'ai-os', 'active')`,
    "seed project",
  );
  const seed = (id: string, ws: string, title: string, writeSet: string[]): string =>
    `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, write_set, depends_on) ` +
    `VALUES (${lit(id)}, ${lit(PROJECT_ID)}, 7, 'reviewer', ${lit(title)}, 'seeded', 'done', ` +
    `${lit(ws)}, ARRAY[${writeSet.map(lit).join(",")}]::text[], '{}'::uuid[])`;
  exec(seed(T_MAIN_A, "main", "Review main A", ["src/a.ts", "src/b.ts"]), "seed main A");
  exec(seed(T_MAIN_B, "main", "Review main B", ["src/b.ts"]), "seed main B");
  exec(seed(T_UI, "ui", "Review ui", ["src/a.ts"]), "seed ui");
  assertEq("seeded three gating reviewers", "3", q("SELECT count(*) FROM project_tasks"));
  console.log();

  // The pool is built at import; the URL and the search_path must be in place
  // first. Nothing else in this process ever writes through that pool.
  const url = new URL(SCRATCH.dsn);
  url.searchParams.set("options", `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  const { createFixChain, listTaskReports } = await import(join(REPO_ROOT, PROJECTS_REL));
  const { fixChainGraphFields, chainKeys, FIX_TASK_TITLE, RECHECK_TASK_TITLE } = await import(
    join(REPO_ROOT, RECONCILE_REL)
  );

  type Outcome = { kind: string; id: string };
  type ChainResult = { builder: Outcome; checkers: Array<Outcome & { role: string }> };

  // AMENDED ROUND 970 — `fixChainGraphFields` takes two sets now, and the
  // split is the fix rather than a rename: `gating` (the verdict tasks) decides
  // the ORDERING dependency, `fixing` (the builders whose work is being fixed)
  // decides the write-set union. Feeding the gating rows' write-sets is what
  // made every fix builder declare the reviewer's report file and then touch
  // source it had not declared. This helper keeps ONE fixture list because the
  // rows this script asserts on are the same either way; it is the SHIPPED
  // function that decides which field reaches which column.
  const groupOf = (round: number, ws: string, members: Array<{ taskId: string; writeSet: string[] }>) =>
    fixChainGraphFields({
      round,
      workstream: ws,
      gating: members.map((m) => ({ taskId: m.taskId })),
      fixing: members.map((m) => ({ writeSet: m.writeSet })),
    });

  const callChain = (
    round: number,
    ws: string,
    cycle: number,
    members: Array<{ taskId: string; writeSet: string[] }>,
  ): Promise<ChainResult> => {
    const keys = chainKeys(round, cycle, ws);
    return createFixChain({
      project_id: PROJECT_ID,
      round,
      cycle,
      builderTitle: FIX_TASK_TITLE(cycle, ws),
      builderBrief: `merged feedback for ${ws} round ${round}`,
      builderChainKey: keys.builder,
      checkers: [
        {
          role: "reviewer",
          title: RECHECK_TASK_TITLE("reviewer", cycle, ws),
          brief: `re-review ${ws}`,
          chainKey: keys.reviewer,
        },
      ],
      graph: groupOf(round, ws, members),
    }) as Promise<ChainResult>;
  };

  const MAIN_MEMBERS = [
    { taskId: T_MAIN_A, writeSet: ["src/a.ts", "src/b.ts"] },
    { taskId: T_MAIN_B, writeSet: ["src/b.ts"] },
  ];
  const UI_MEMBERS = [{ taskId: T_UI, writeSet: ["src/a.ts"] }];

  console.log("--- 3. R42: the chain joins the graph ----------------------------------------");
  const mainChain = await callChain(7, "main", 1, MAIN_MEMBERS);
  assertEq("main: the builder was created", "created", mainChain.builder.kind);
  assertEq("main: one re-checker was created", "created", mainChain.checkers[0]?.kind);
  assertEq("three rows now exist beyond the seed", "5", q("SELECT count(*) FROM project_tasks"));

  const builderRow = q(
    `SELECT round || '|' || workstream || '|' || array_to_string(depends_on, ',') || '|' || ` +
      `array_to_string(write_set, ',') || '|' || chain_key || '|' || title ` +
      `FROM project_tasks WHERE id = ${lit(mainChain.builder.id)}`,
  );
  assertEq(
    "main builder: round+1, workstream, gating ids, write-set union, key, title",
    `8|main|${T_MAIN_A},${T_MAIN_B}|src/a.ts,src/b.ts|fix:7:1|Fix cycle 1`,
    builderRow,
  );
  assertOk(
    "main builder is NOT a graph root",
    q(`SELECT cardinality(depends_on) FROM project_tasks WHERE id = ${lit(mainChain.builder.id)}`) ===
      "2",
    "a root would promote on the next tick, in parallel with the work it follows",
  );
  const checkerRow = q(
    `SELECT round || '|' || workstream || '|' || array_to_string(depends_on, ',') || '|' || ` +
      `cardinality(write_set) || '|' || chain_key || '|' || title ` +
      `FROM project_tasks WHERE id = ${lit(mainChain.checkers[0]!.id)}`,
  );
  assertEq(
    "main checker: round+2, depends on the builder, empty write-set",
    `9|main|${mainChain.builder.id}|0|rereview:7:1|Re-review after fix cycle 1`,
    checkerRow,
  );
  assertEq(
    "no chain row was born legacy (depends_on NULL)",
    "0",
    q("SELECT count(*) FROM project_tasks WHERE chain_key IS NOT NULL AND depends_on IS NULL"),
  );
  console.log();

  console.log("--- 4. R42: the replay is still absorbed -------------------------------------");
  const replay = await callChain(7, "main", 1, MAIN_MEMBERS);
  assertEq("replayed builder is classified `replay`", "replay", replay.builder.kind);
  assertEq("replayed checker is classified `replay`", "replay", replay.checkers[0]?.kind);
  assertEq("replay wrote nothing", "5", q("SELECT count(*) FROM project_tasks"));
  assertEq("the replay found OUR row", mainChain.builder.id, replay.builder.id);
  console.log();

  console.log("--- 5. R40: the second workstream lands beside it, not on top of it ----------");
  const uiChain = await callChain(7, "ui", 1, UI_MEMBERS);
  assertEq("ui: the builder was created, not `occupied`", "created", uiChain.builder.kind);
  assertEq("ui: the re-checker was created", "created", uiChain.checkers[0]?.kind);
  assertEq("both chains coexist", "7", q("SELECT count(*) FROM project_tasks"));
  assertEq(
    "ui builder: same round, other workstream, its own key and title",
    `8|ui|${T_UI}|src/a.ts|fix:ui:7:1|Fix cycle 1 · ui`,
    q(
      `SELECT round || '|' || workstream || '|' || array_to_string(depends_on, ',') || '|' || ` +
        `array_to_string(write_set, ',') || '|' || chain_key || '|' || title ` +
        `FROM project_tasks WHERE id = ${lit(uiChain.builder.id)}`,
    ),
  );
  assertEq(
    "neither builder's brief reached the other's worktree",
    "1|1",
    q(
      `SELECT count(*) FILTER (WHERE workstream='main' AND brief LIKE '%for main%') || '|' || ` +
        `count(*) FILTER (WHERE workstream='ui' AND brief LIKE '%for ui%') ` +
        `FROM project_tasks WHERE role='builder'`,
    ),
  );
  assertEq(
    "the two builders differ on identity, which is what the index reads",
    "2",
    q("SELECT count(DISTINCT (round, role, title)) FROM project_tasks WHERE role='builder'"),
  );
  console.log();

  console.log("--- 6. R41: the hand-renumber hazard ------------------------------------------");
  // The operator's edit, verbatim in shape: a group renumbered AFTER its chain
  // exists. `grep -n "SET round"` over the tree is empty — no engine path does
  // this, which is why the statement is issued here by hand.
  exec(
    `UPDATE project_tasks SET round = 9 WHERE id IN (${lit(T_MAIN_A)}, ${lit(T_MAIN_B)})`,
    "operator renumber",
  );
  assertEq(
    "the group now sits at round 9, its chain still at 8/9",
    "9|9|8",
    q(
      `SELECT (SELECT round FROM project_tasks WHERE id = ${lit(T_MAIN_A)}) || '|' || ` +
        `(SELECT round FROM project_tasks WHERE id = ${lit(T_MAIN_B)}) || '|' || ` +
        `(SELECT round FROM project_tasks WHERE id = ${lit(mainChain.builder.id)})`,
    ),
  );

  // POSITIVE CONTROL (failure mode (b)): prove BOTH indexes would admit the
  // second chain, so a refusal can only come from the guard.
  const newKeys = chainKeys(9, 1, "main");
  assertEq(
    "control: the renumbered chain_key is FREE — chain_key_uniq would admit it",
    "0",
    q(
      `SELECT count(*) FROM project_tasks WHERE project_id = ${lit(PROJECT_ID)} ` +
        `AND chain_key = ${lit(newKeys.builder)}`,
    ),
  );
  assertEq(
    "control: the renumbered identity tuple is FREE — identity_idx would admit it",
    "0",
    q(
      `SELECT count(*) FROM project_tasks WHERE project_id = ${lit(PROJECT_ID)} ` +
        `AND round = 10 AND role = 'builder' AND title = ${lit(FIX_TASK_TITLE(1, "main"))}`,
    ),
  );
  assertOk(
    "control: the two chain keys really do differ",
    newKeys.builder !== "fix:7:1",
    `${newKeys.builder} vs fix:7:1`,
  );

  const before = q("SELECT count(*) FROM project_tasks");
  let refusal: Error | null = null;
  try {
    await callChain(9, "main", 1, MAIN_MEMBERS);
  } catch (e) {
    refusal = e instanceof Error ? e : new Error(String(e));
  }
  assertOk("the second chain is REFUSED", refusal !== null, refusal ? "threw" : "IT WAS CREATED");
  assertOk(
    "the refusal names the existing row and the reason",
    refusal !== null &&
      refusal.message.includes(mainChain.builder.id) &&
      refusal.message.includes("renumbered") &&
      refusal.message.includes("R41"),
    refusal ? refusal.message.slice(0, 160) : "(no error)",
  );
  assertEq("the refusal wrote NOTHING (failure mode (c))", before, q("SELECT count(*) FROM project_tasks"));
  assertEq(
    "still exactly two fix builders in the project",
    "2",
    q("SELECT count(*) FROM project_tasks WHERE role = 'builder' AND chain_key IS NOT NULL"),
  );

  // ...and the guard is not simply "refuse everything at cycle 1": a genuinely
  // different group at the same cycle still lands.
  const T_OTHER = "00000000-0000-4000-8000-00000000fc31";
  exec(
    `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, write_set, depends_on) ` +
      `VALUES (${lit(T_OTHER)}, ${lit(PROJECT_ID)}, 20, 'reviewer', 'Review later', 'seeded', 'done', 'main', ` +
      `'{}'::text[], '{}'::uuid[])`,
    "seed a later group",
  );
  const later = await callChain(20, "main", 1, [{ taskId: T_OTHER, writeSet: [] }]);
  assertEq("a different group at the same cycle still lands", "created", later.builder.kind);
  assertEq(
    "which is three fix builders now",
    "3",
    q("SELECT count(*) FROM project_tasks WHERE role = 'builder' AND chain_key IS NOT NULL"),
  );

  // ...and cycle 2 of the ORIGINAL group is not blocked by its own cycle 1.
  const cycle2 = await callChain(9, "main", 2, MAIN_MEMBERS);
  assertEq("cycle 2 of the same group is NOT refused", "created", cycle2.builder.kind);
  console.log();

  console.log("--- 6b. ROUND 970: listTaskReports — the fixed work, by edge ------------------");
  // The fix builder's inherited BRIEF and WRITE-SET both come from this query,
  // and it is the only part of round 970 that is SQL rather than a pure
  // function — so it is proved against rows rather than reasoned about. The
  // pure halves (`fixBuilderBrief`, `allocateReportBudget`, `inheritedWriteSet`)
  // are unit-tested in project-reconcile.test.ts T30/T30b/T30c.
  // fc4x, NOT fc3x: §6 already binds fc31 as `T_OTHER`. The collision was
  // found by running this — a reused id aborts the script rather than quietly
  // reusing a row, which is the behaviour a seeding helper owes.
  const B_EARLY = "00000000-0000-4000-8000-00000000fc41";
  const B_LATE = "00000000-0000-4000-8000-00000000fc42";
  const P_DEP = "00000000-0000-4000-8000-00000000fc43";
  const B_NORUN = "00000000-0000-4000-8000-00000000fc44";
  const RUN_EARLY = "00000000-0000-4000-8000-00000000fd01";
  const RUN_LATE = "00000000-0000-4000-8000-00000000fd02";

  // Two runs whose threads hold MORE THAN ONE assistant message, so "the last
  // one" is a real choice and not the only one available. The `ts` values are
  // deliberately out of array order in RUN_LATE: the projection orders by
  // thread timestamp, not by array position, and a probe seeded in order could
  // not tell the two apart.
  const seedRun = (id: string, entries: Array<[string, string, string]>): string =>
    `INSERT INTO runs (id, title, prompt, status, thread) VALUES (${lit(id)}, ` +
    `'synthetic builder run', 'seeded', 'completed', ` +
    lit(JSON.stringify(entries.map(([role, ts, content]) => ({ role, ts, content })))) +
    `::jsonb)`;
  exec(
    seedRun(RUN_EARLY, [
      ["assistant", "2026-08-19T09:00:00Z", "an early draft nobody should read"],
      ["user", "2026-08-19T09:30:00Z", "carry on"],
      ["assistant", "2026-08-19T10:00:00Z", "REPORT-EARLY: the belt partitions by project."],
    ]),
    "seed run EARLY",
  );
  exec(
    seedRun(RUN_LATE, [
      ["assistant", "2026-08-19T12:00:00Z", "REPORT-LATE: promotion reads the sentinel."],
      ["assistant", "2026-08-19T11:00:00Z", "an earlier turn, stored LATER in the array"],
    ]),
    "seed run LATE",
  );

  const seedTask = (
    id: string,
    role: string,
    title: string,
    writeSet: string[],
    runId: string | null,
    createdAt: string,
  ): string =>
    `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, ` +
    `write_set, depends_on, run_id, created_at) VALUES (${lit(id)}, ${lit(PROJECT_ID)}, 6, ` +
    `${lit(role)}, ${lit(title)}, 'seeded', 'done', 'main', ` +
    `ARRAY[${writeSet.map(lit).join(",")}]::text[], '{}'::uuid[], ` +
    `${runId === null ? "NULL" : lit(runId)}, ${lit(createdAt)}::timestamptz)`;
  exec(seedTask(B_LATE, "builder", "Builder LATE", ["src/late.ts"], RUN_LATE, "2026-08-19T02:00:00Z"), "seed builder LATE");
  exec(seedTask(B_EARLY, "builder", "Builder EARLY", ["src/early.ts"], RUN_EARLY, "2026-08-19T01:00:00Z"), "seed builder EARLY");
  exec(seedTask(P_DEP, "planner", "Planner", ["docs/plan.md"], null, "2026-08-19T00:30:00Z"), "seed planner dep");
  exec(seedTask(B_NORUN, "builder", "Builder NO RUN", ["src/norun.ts"], null, "2026-08-19T03:00:00Z"), "seed builder without a run");

  const allIds = [B_LATE, B_EARLY, P_DEP, B_NORUN];
  const reports = (await listTaskReports(PROJECT_ID, allIds, ["builder"])) as Array<{
    id: string;
    title: string;
    write_set: string[];
    last_text: string | null;
  }>;

  assertEq(
    "only BUILDERS come back — the planner dependency is filtered out",
    ["Builder EARLY", "Builder LATE", "Builder NO RUN"],
    reports.map((r) => r.title),
  );
  assertEq(
    "…and in created_at order, NOT the order the ids were passed in",
    [B_EARLY, B_LATE, B_NORUN],
    reports.map((r) => r.id),
  );
  assertEq(
    "the LAST assistant message by thread timestamp, not the first and not the last array slot",
    ["REPORT-EARLY: the belt partitions by project.", "REPORT-LATE: promotion reads the sentinel.", null],
    reports.map((r) => r.last_text),
  );
  assertEq(
    "a task with NO run yields last_text null rather than vanishing from the result",
    1,
    reports.filter((r) => r.last_text === null).length,
  );
  assertEq(
    "the declared write-sets ride along — this is what the fix builder inherits",
    [["src/early.ts"], ["src/late.ts"], ["src/norun.ts"]],
    reports.map((r) => r.write_set),
  );
  assertEq(
    "an empty id list returns [] without a query",
    0,
    ((await listTaskReports(PROJECT_ID, [], ["builder"])) as unknown[]).length,
  );
  assertEq(
    "an id from ANOTHER project is refused by the project_id term",
    0,
    ((await listTaskReports(
      "00000000-0000-4000-8000-0000000000ff",
      allIds,
      ["builder"],
    )) as unknown[]).length,
  );
  console.log();

  console.log("--- 7. teardown ---------------------------------------------------------------");
  runPsql(["-c", `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`], "schema teardown", "public");
  assertEq(
    "the throwaway schema is gone",
    "0",
    runPsql(
      ["-At", "-c", `SELECT count(*) FROM information_schema.schemata WHERE schema_name = ${lit(SCHEMA)}`],
      "teardown check",
      "public",
    ).trim(),
  );
}

main()
  .then(() => {
    console.log();
    console.log("=== summary ==================================================================");
    console.log(`  assertions run    : ${assertionsRun} (expected ${EXPECTED_ASSERTIONS})`);
    console.log(`  assertions failed : ${assertionsFailed}`);
    if (assertionsRun < EXPECTED_ASSERTIONS) {
      console.error(
        `  PROBES MISSED: ${EXPECTED_ASSERTIONS - assertionsRun} assertion(s) never ran. ` +
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
    console.error("check-fix-chain-graph.ts ABORTED — NOT a pass:");
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.error(`  assertions run before the abort: ${assertionsRun}`);
    process.exit(1);
  });
