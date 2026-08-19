/**
 * projects.test.ts — R72, THE LANE CAP: at most one live task per
 * (project_id, workstream), proved against a real Postgres by driving the
 * SHIPPED `promoteReadyTasks()` from `./projects.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS NOT PART OF `pnpm test`, AND MUST NEVER BE ADDED TO IT.
 *
 * `pnpm test` is `tsx --test src/lib/*.test.ts`: hermetic, no database, and
 * `db/*` imported TYPE-ONLY (NF3). This file is the opposite by necessity —
 * the subject IS a SQL statement, and a check that re-pastes the statement
 * under test proves only that the paste agrees with itself. So it imports
 * `promoteReadyTasks` as a VALUE, which opens the module's pg Pool, and it
 * needs a live server. It therefore sits outside the unit glob deliberately.
 * Adding `src/db/*.test.ts` to the `test` script would make the hermetic suite
 * require Postgres on every machine that runs it.
 *
 * It is also NOT a `node:test` file, and that is deliberate too: the three
 * module-level pg Pools (db/projects.ts, db/notifications.ts, db/runs.ts) are
 * private to their modules with no exported close, so a node:test run would
 * either hang on their open sockets or need a forced exit whose code races the
 * runner's own verdict. An instrument that can report the wrong exit code is
 * worse than no instrument, so this file counts its own assertions and exits
 * on its own arithmetic (standing rule: INSTRUMENTS LIE BEFORE CODE DOES).
 *
 * HOW TO RUN (the preamble is identical to check-scheduler-sql.sh's):
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_r972_lanecap'
 *   SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_r972_lanecap" \
 *     ./node_modules/.bin/tsx src/db/projects.test.ts
 *
 * Exit 0 = every assertion passed AND every assertion ran.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES, and which half of the fix each case is aimed at.
 *
 *   CASE 1  ONE LANE, TWO ELIGIBLE ROOTS  → exactly one promotes, and it is
 *           the lane's head by (round, created_at, id). Then the lane stays
 *           capped on the next tick, and frees when the head is `done`.
 *           FAILS ON THE PRE-FIX STATEMENT: both rows promote (measured; see
 *           the pre-fix run recorded in the round's evidence).
 *   CASE 2  TWO LANES, ONE ROOT EACH      → BOTH promote on one tick. The cap
 *           must not serialise the fleet; this is the assertion that would
 *           catch a fix that did. Passes before AND after, by design — it is
 *           the control that says the cap is narrow, not the one that says it
 *           exists.
 *   CASE 3  LANE OCCUPIED BY A `running`  → nothing promotes into it. This is
 *           the cross-statement half in isolation. Also FAILS pre-fix.
 *   CASE 4  DETECTOR CONTROL, POSITIVE    → `stalled-projects.sh`'s section
 *           "TWO LIVE SESSIONS IN ONE WORKTREE" query, verbatim in shape, run
 *           against a HAND-SEEDED two-live-row lane, must return that lane.
 *           A detector that has only ever said `none` is indistinguishable
 *           from one that cannot fire; this is how this round confirmed it
 *           still can, without touching live data.
 *   CASE 5  DETECTOR CONTROL, NEGATIVE    → the same query over the lanes this
 *           run's promotes produced returns nothing, INCLUDING case 2's two
 *           simultaneously live rows in different workstreams. Cross-lane
 *           parallelism is not what the detector is looking for.
 *   CASE 6  THE READY RULE IS UNTOUCHED   → the promote statement was rewritten
 *           from a bare UPDATE into a CTE, so the graph branch, the legacy
 *           branch and the `p.status = 'active'` gate are each re-asserted.
 *           Every one of them is measured ACROSS lanes, so the lane cap cannot
 *           be the reason the row was held — otherwise a rewrite that dropped
 *           the dependency predicate entirely would still look green.
 *
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot:
 *   (a) AN EMPTY SEED. The seeded row count is asserted against a literal.
 *   (b) A ROW THAT WAS NEVER INSERTED. Every assertion names a literal uuid and
 *       compares its STATUS; a missing row reads as `absent`, never as a match.
 *   (c) A PROMOTE THAT RETURNED 0 FOR THE WRONG REASON. Nothing is asserted on
 *       a count alone: case 1 asserts WHICH row promoted and which did not, and
 *       case 2 asserts both ids by name, so a promote that did nothing at all
 *       fails case 2 immediately.
 *   (d) PROBES THAT MISS. The assertions actually executed are counted and
 *       compared with EXPECTED_ASSERTIONS at the end. A short run FAILS.
 *   (e) THE WRONG DATABASE. A guard refuses anything but a local, non-fleet,
 *       non-`content_forge` scratch database, and it runs BEFORE the dynamic
 *       import of ./projects.ts — which defaults to content_forge when
 *       DATABASE_URL is unset, and is therefore never imported until the
 *       environment has been proved safe.
 *   (f) A STALE SCHEMA FROM A PREVIOUS RUN. The schema is named per PROCESS and
 *       dropped both before and after, so two concurrent runs cannot share a
 *       table (the shared-scratch-DB failure this fleet has already paid for).
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SUBJECT = path.join(REPO_ROOT, "forge-control/src/db/projects.ts");
const MIGRATIONS = path.join(REPO_ROOT, "db/migrations");
const SCHEMA = `r972_lane_${process.pid}`;

const EXPECTED_ASSERTIONS = 33;
const SEED_EXPECTED_ROWS = 15;

let assertionsRun = 0;
let failed = 0;

function pass(name: string, detail = ""): void {
  assertionsRun += 1;
  console.log(`  ok   ${name.padEnd(58)} ${detail}`);
}
function fail(name: string, detail = ""): void {
  assertionsRun += 1;
  failed += 1;
  console.error(`  FAIL ${name.padEnd(58)} ${detail}`);
}
function assertEq(name: string, expected: string, actual: string): void {
  if (expected === actual) pass(name, `= ${actual}`);
  else fail(name, `expected [${expected}] got [${actual}]`);
}
function assertHas(name: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) pass(name, `contains: ${needle}`);
  else fail(name, `missing [${needle}] in [${haystack}]`);
}

/** Refuse to run anywhere but a throwaway, local, non-fleet database. Resolves
 *  the database NAME and never prints or returns the DSN — failure mode (e).
 *  Throws with the reason; there is no fallback and no default, because a
 *  default here is a statement issued against content_forge. */
function guardScratchDsn(): { dsn: string; name: string } {
  const dsn = (process.env.SCRATCH_DATABASE_URL ?? "").trim();
  if (dsn === "") {
    throw new Error(
      "REFUSING TO RUN: $SCRATCH_DATABASE_URL is unset. This check never guesses " +
        "a connection string — see the preamble in this file's header.",
    );
  }
  let u: URL;
  try {
    u = new URL(dsn);
  } catch (e) {
    throw new Error(
      `REFUSING TO RUN: $SCRATCH_DATABASE_URL is not a parsable URL (${
        e instanceof Error ? e.message : String(e)
      }).`,
    );
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("REFUSING TO RUN: $SCRATCH_DATABASE_URL is not a postgres:// URL.");
  }
  const name = u.pathname.replace(/^\//, "").split("?")[0] ?? "";
  if (name === "") {
    throw new Error("REFUSING TO RUN: $SCRATCH_DATABASE_URL names no database.");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(
      `REFUSING TO RUN: scratch database must be local, host resolved to ${u.hostname}.`,
    );
  }
  const banned = new Set(["content_forge", "postgres", "template0", "template1"]);
  if (banned.has(name)) {
    throw new Error(
      `REFUSING TO RUN: ${name} is a protected database. Point ` +
        "$SCRATCH_DATABASE_URL at a throwaway scratch database.",
    );
  }
  // Soft denylist, computed from the fleet's own config: the DSNs are read and
  // discarded, only NAMES are compared, and none of them is printed.
  const live = new Set<string>();
  for (const p of [
    "/opt/ai-os/.secrets/forge-control.env",
    "/opt/forge-ai-os/.env",
    "/opt/content-forge/.env",
  ]) {
    let blob: string;
    try {
      blob = readFileSync(p, "utf8");
    } catch {
      continue; // a config this host does not have is not a finding
    }
    for (const m of blob.matchAll(/postgres(?:ql)?:\/\/[^\s'"]+/g)) {
      try {
        live.add(new URL(m[0]).pathname.replace(/^\//, "").split("?")[0] ?? "");
      } catch {
        continue;
      }
    }
  }
  live.delete("");
  if (live.has(name)) {
    throw new Error(
      `REFUSING TO RUN: ${name} is a database this fleet runs on (found in the ` +
        "fleet config). Use a throwaway scratch database.",
    );
  }
  return { dsn, name };
}

/** Every migration, in filename order, with the glob itself checked. R70 —
 *  "apply migrations by explicit filename, never by glob" — exists because two
 *  files once claimed number 0040 and sort order silently decided which won.
 *  A glob is still the only way to build a scratch schema, so the property R70
 *  actually wants is asserted instead of assumed: no two files may share a
 *  numeric prefix. If one ever does again, this throws instead of choosing. */
function migrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const byNumber = new Map<string, string>();
  for (const f of files) {
    const n = f.slice(0, 4);
    const prior = byNumber.get(n);
    if (prior !== undefined) {
      throw new Error(
        `REFUSING TO RUN: migrations ${prior} and ${f} share the number ${n} — ` +
          "sort order would silently decide their order (R70).",
      );
    }
    byNumber.set(n, f);
  }
  return files;
}

const SEED_PROJECTS: Array<{ id: string; name: string; status: string }> = [
  { id: "00000000-0000-4000-8000-000000097201", name: "r972 one lane", status: "active" },
  { id: "00000000-0000-4000-8000-000000097202", name: "r972 two lanes", status: "active" },
  { id: "00000000-0000-4000-8000-000000097203", name: "r972 occupied lane", status: "active" },
  { id: "00000000-0000-4000-8000-000000097204", name: "r972 detector positive", status: "active" },
  { id: "00000000-0000-4000-8000-000000097205", name: "r972 ready rule", status: "active" },
  { id: "00000000-0000-4000-8000-000000097206", name: "r972 paused", status: "paused" },
  // The legacy pair lives in a project OF ITS OWN, and the reason is a finding
  // this file's first run made: R69's straddle term holds a graph row behind ANY
  // non-`done` lower-round row whose `depends_on IS NULL`. Seeded beside the
  // graph rows, the legacy fixtures held the graph fixtures — correct engine
  // behaviour reading as a lane-cap regression. Mixing the two rules inside one
  // project measures the straddle term, not the clause the case is about.
  { id: "00000000-0000-4000-8000-000000097207", name: "r972 legacy rule", status: "active" },
];
const [P_LANE, P_TWO, P_OCC, P_DET, P_RULE, P_PAUSED, P_LEGACY] = SEED_PROJECTS.map(
  (p) => p.id,
) as [string, string, string, string, string, string, string];

// Case 1 — one lane, two eligible graph roots. A1 is the head: same round, and
// created_at one second earlier, so the expected winner is not a coin toss.
const A1 = "00000000-0000-4000-8000-0000009721a1";
const A2 = "00000000-0000-4000-8000-0000009721a2";
// Case 2 — two lanes, one eligible graph root each.
const B_ALPHA = "00000000-0000-4000-8000-0000009722b1";
const B_BETA = "00000000-0000-4000-8000-0000009722b2";
// Case 3 — a lane already occupied by a `running` row.
const C_RUNNING = "00000000-0000-4000-8000-0000009723c0";
const C_PENDING = "00000000-0000-4000-8000-0000009723c1";
// Case 4 — the detector's positive control, seeded live by hand, never promoted.
const D_LIVE1 = "00000000-0000-4000-8000-0000009724d1";
const D_LIVE2 = "00000000-0000-4000-8000-0000009724d2";
// Case 6 — the ready rule, each clause measured across DIFFERENT lanes so the
// cap can never be the reason a row was held.
const E_DEP = "00000000-0000-4000-8000-0000009726e0"; // graph: the dependency
const E_WAITER = "00000000-0000-4000-8000-0000009726e1"; // graph: depends_on [E_DEP]
const E_LOW = "00000000-0000-4000-8000-0000009726e2"; // legacy: round 0, NULL deps
const E_HIGH = "00000000-0000-4000-8000-0000009726e3"; // legacy: round 1, NULL deps
const E_PAUSED = "00000000-0000-4000-8000-0000009726e4"; // a root in a paused project

async function main(): Promise<number> {
  const { dsn, name } = guardScratchDsn();

  // Build identity FIRST — a harness that does not expose its own is not
  // evidence. The sha of the subject matters more than the commit here,
  // because this drives the WORKING TREE's copy of projects.ts.
  const headSha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const subjectDirty = execFileSync(
    "git",
    ["-C", REPO_ROOT, "status", "--porcelain", "--", "forge-control/src/db/projects.ts"],
    { encoding: "utf8" },
  ).trim();
  const subjectSha = createHash("sha256").update(readFileSync(SUBJECT)).digest("hex");
  console.log("=== projects.test.ts (R72 lane cap) — build identity ==========================");
  console.log(`  repo worktree      : ${REPO_ROOT}`);
  console.log(`  git HEAD           : ${headSha}`);
  console.log(`  subject            : forge-control/src/db/projects.ts`);
  console.log(`  subject uncommitted: ${subjectDirty === "" ? "no" : "YES — " + subjectDirty}`);
  console.log(`  sha256(subject)    : ${subjectSha}`);
  console.log(`  scratch database   : ${name} (local; DSN never printed)`);
  console.log(`  throwaway schema   : ${SCHEMA} (per-process)`);
  console.log(`  driven by          : the SHIPPED promoteReadyTasks(), value-imported`);
  console.log(`  expected assertions: ${EXPECTED_ASSERTIONS}`);
  console.log("==============================================================================");

  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();

  // The schema-scoped DSN, built from the GUARDED value and from nothing else.
  const scopedDsn = `${dsn}?options=-c%20search_path%3D${SCHEMA}`;
  const db = new pg.Client({ connectionString: scopedDsn });
  await db.connect();

  let exitCode = 1;
  try {
    assertEq(
      "search_path actually reached the server",
      SCHEMA,
      (await db.query<{ s: string }>("SELECT current_schema() AS s")).rows[0]?.s ?? "absent",
    );

    // ---- schema ------------------------------------------------------------
    console.log("\n--- schema + migrations -------------------------------------------------------");
    // 0021 declares a FK to content_jobs, which no migration in this repo
    // creates. The same forced placeholder check-migration-0040.sh documents.
    await db.query("CREATE TABLE content_jobs (id uuid PRIMARY KEY)");
    const files = migrationFiles();
    const migrationErrors: Array<{ file: string; message: string }> = [];
    for (const f of files) {
      try {
        await db.query(readFileSync(path.join(MIGRATIONS, f), "utf8"));
      } catch (e) {
        // NOT swallowed: recorded, printed, and the columns this check needs
        // are asserted below. A migration that fails here and matters will show
        // up as a missing column, with its own error text already on screen.
        migrationErrors.push({
          file: f,
          message: e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e),
        });
      }
    }
    console.log(`  applied ${files.length} migration file(s); ${migrationErrors.length} raised`);
    for (const me of migrationErrors) console.log(`    - ${me.file}: ${me.message}`);
    assertEq(
      "the four 0042 graph columns exist",
      "4",
      (
        await db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'project_tasks'
              AND column_name IN ('depends_on','workstream','write_set','graph_frozen')`,
          [SCHEMA],
        )
      ).rows[0]?.c ?? "absent",
    );
    assertEq(
      "notifications table reachable (the R14 sweep writes to it)",
      "notifications",
      (
        await db.query<{ t: string }>(
          `SELECT table_name AS t FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = 'notifications'`,
          [SCHEMA],
        )
      ).rows[0]?.t ?? "absent",
    );

    // ---- seed --------------------------------------------------------------
    console.log("\n--- seed ----------------------------------------------------------------------");
    for (const p of SEED_PROJECTS) {
      await db.query(
        `INSERT INTO projects (id, name, brief, repo, status)
         VALUES ($1, $2, 'r972 lane cap fixture', 'ai-os', $3)`,
        [p.id, p.name, p.status],
      );
    }
    const seed = async (
      id: string,
      projectId: string,
      workstream: string,
      round: number,
      role: string,
      status: string,
      dependsOn: string[] | null,
      createdOffsetSeconds: number,
    ): Promise<void> => {
      await db.query(
        `INSERT INTO project_tasks
           (id, project_id, workstream, round, role, title, brief, status, depends_on, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'r972 fixture', $7, $8::uuid[],
                 now() + make_interval(secs => $9))`,
        [id, projectId, workstream, round, role, `r972 ${id.slice(-4)}`, status, dependsOn, createdOffsetSeconds],
      );
    };

    // CASE 1 — one lane, two graph roots ('{}' names nothing and is trivially
    // satisfied). Same round; A1 is one second older, so the head is decided by
    // created_at and the expected winner is not luck.
    await seed(A1, P_LANE, "build", 1, "builder", "pending", [], 0);
    await seed(A2, P_LANE, "build", 1, "reviewer", "pending", [], 1);
    // CASE 2 — two lanes of ONE project, one root each.
    await seed(B_ALPHA, P_TWO, "alpha", 1, "builder", "pending", [], 0);
    await seed(B_BETA, P_TWO, "beta", 1, "builder", "pending", [], 0);
    // CASE 3 — lane already occupied by a live run.
    await seed(C_RUNNING, P_OCC, "main", 1, "reviewer", "running", [], 0);
    await seed(C_PENDING, P_OCC, "main", 1, "builder", "pending", [], 1);
    // CASE 4 — the detector's positive control. Hand-seeded live, exactly the
    // shape the operator found on 2026-08-19, and never promoted by anything.
    await seed(D_LIVE1, P_DET, "vault", 1, "reviewer", "ready", [], 0);
    await seed(D_LIVE2, P_DET, "vault", 1, "reviewer", "running", [], 1);
    // CASE 6 — the ready rule, measured across lanes.
    await seed(E_DEP, P_RULE, "main", 1, "builder", "pending", [], 0);
    await seed(E_WAITER, P_RULE, "other", 2, "reviewer", "pending", [E_DEP], 1);
    await seed(E_LOW, P_LEGACY, "legacy-low", 0, "builder", "pending", null, 0);
    await seed(E_HIGH, P_LEGACY, "legacy-high", 1, "reviewer", "pending", null, 1);
    await seed(E_PAUSED, P_PAUSED, "main", 1, "builder", "pending", [], 0);
    // Two more rows so the paused project and the detector project each have a
    // second row: a project with exactly one task can pass a lane-cap assertion
    // for the trivial reason that there was never a second candidate.
    await seed("00000000-0000-4000-8000-0000009726e5", P_PAUSED, "main", 1, "reviewer", "pending", [], 1);
    await seed("00000000-0000-4000-8000-0000009724d3", P_DET, "solo", 1, "builder", "pending", [], 0);

    assertEq(
      "seeded row count (failure mode (a))",
      String(SEED_EXPECTED_ROWS),
      (await db.query<{ c: string }>("SELECT count(*)::text AS c FROM project_tasks")).rows[0]?.c ??
        "absent",
    );

    // ---- drive the SHIPPED function ---------------------------------------
    // Imported only now, and only after the guard: db/projects.ts defaults to
    // content_forge when DATABASE_URL is unset, so the import itself is the
    // dangerous act and it happens after the environment is proved safe.
    process.env.DATABASE_URL = scopedDsn;
    const { promoteReadyTasks } = await import("./projects.ts");

    const statusOf = async (id: string): Promise<string> =>
      (
        await db.query<{ s: string }>("SELECT status AS s FROM project_tasks WHERE id = $1", [id])
      ).rows[0]?.s ?? "absent";
    const liveInLane = async (projectId: string, workstream: string): Promise<string> =>
      (
        await db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM project_tasks
            WHERE project_id = $1 AND workstream = $2 AND status IN ('ready','running')`,
          [projectId, workstream],
        )
      ).rows[0]?.c ?? "absent";

    console.log("\n--- tick 1 --------------------------------------------------------------------");
    const promoted1 = await promoteReadyTasks();
    console.log(`  promoteReadyTasks() returned ${promoted1}`);

    // CASE 1 -----------------------------------------------------------------
    console.log("\n--- case 1: one lane, two eligible roots ---------------------------------------");
    assertEq("case 1: lane 'build' holds exactly one live row", "1", await liveInLane(P_LANE, "build"));
    assertEq("case 1: the lane head A1 promoted", "ready", await statusOf(A1));
    assertEq("case 1: its sibling A2 stayed pending", "pending", await statusOf(A2));

    console.log("\n--- tick 2 (the cap must hold, not merely delay) -------------------------------");
    await promoteReadyTasks();
    assertEq("case 1: still exactly one live row after a second tick", "1", await liveInLane(P_LANE, "build"));
    assertEq("case 1: A2 is still pending while A1 is live", "pending", await statusOf(A2));

    console.log("\n--- tick 3 (the head settles, the lane frees) ----------------------------------");
    await db.query("UPDATE project_tasks SET status = 'done' WHERE id = $1", [A1]);
    await promoteReadyTasks();
    assertEq("case 1: A2 promotes once the lane is free", "ready", await statusOf(A2));
    assertEq("case 1: the freed lane holds exactly one live row again", "1", await liveInLane(P_LANE, "build"));
    assertEq("case 1: A1 was not re-promoted out of 'done'", "done", await statusOf(A1));

    // CASE 2 -----------------------------------------------------------------
    console.log("\n--- case 2: two lanes must NOT serialise ---------------------------------------");
    assertEq("case 2: alpha's root promoted", "ready", await statusOf(B_ALPHA));
    assertEq("case 2: beta's root promoted", "ready", await statusOf(B_BETA));
    assertEq("case 2: lane alpha holds one live row", "1", await liveInLane(P_TWO, "alpha"));
    assertEq("case 2: lane beta holds one live row", "1", await liveInLane(P_TWO, "beta"));
    assertEq(
      "case 2: the project as a whole runs two tasks at once",
      "2",
      (
        await db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM project_tasks
            WHERE project_id = $1 AND status IN ('ready','running')`,
          [P_TWO],
        )
      ).rows[0]?.c ?? "absent",
    );

    // CASE 3 -----------------------------------------------------------------
    console.log("\n--- case 3: a lane occupied by a running task ----------------------------------");
    assertEq("case 3: nothing promoted into the occupied lane", "pending", await statusOf(C_PENDING));
    assertEq("case 3: the occupant is untouched", "running", await statusOf(C_RUNNING));
    assertEq("case 3: the occupied lane holds exactly one live row", "1", await liveInLane(P_OCC, "main"));

    // CASE 4/5 — the detector -------------------------------------------------
    // The query is the shape of stalled-projects.sh's section "TWO LIVE SESSIONS
    // IN ONE WORKTREE": project + workstream, live = ready|running, having > 1.
    console.log("\n--- case 4/5: the stalled-projects detector, both directions -------------------");
    const detector = async (): Promise<string> => {
      const r = await db.query<{ line: string }>(
        `SELECT p.name || '|' || t.workstream || '|' || count(*)::text || '|' ||
                string_agg(DISTINCT t.role, '+') AS line
           FROM projects p JOIN project_tasks t ON t.project_id = p.id
          WHERE p.status = 'active' AND t.status IN ('ready','running')
          GROUP BY p.name, t.workstream
         HAVING count(*) > 1
          ORDER BY count(*) DESC`,
      );
      return r.rows.map((x) => x.line).join("\n");
    };
    const detected = await detector();
    console.log(`  detector output:\n${detected === "" ? "    (none)" : detected.replace(/^/gm, "    ")}`);
    assertHas("case 4: the detector FIRES on a hand-seeded two-live lane", detected, "r972 detector positive|vault|2");
    assertHas("case 4: it prints the roles, which is why it is worth waking up for", detected, "reviewer");
    assertEq(
      "case 4: exactly one lane is reported — the seeded one, nothing else",
      "1",
      String(detected.split("\n").filter((l) => l !== "").length),
    );
    assertEq(
      "case 5: no promoted lane is reported (incl. case 2's two live lanes)",
      "false",
      String(detected.includes("r972 two lanes") || detected.includes("r972 one lane") || detected.includes("r972 occupied lane")),
    );

    // CASE 6 — the ready rule survived the CTE rewrite -----------------------
    console.log("\n--- case 6: the ready rule is untouched by the rewrite -------------------------");
    assertEq("case 6: the graph dependency itself promoted", "ready", await statusOf(E_DEP));
    assertEq(
      "case 6: a graph waiter is held by its UNMET dependency, in its own free lane",
      "pending",
      await statusOf(E_WAITER),
    );
    assertEq("case 6: the legacy round-0 row promoted", "ready", await statusOf(E_LOW));
    assertEq(
      "case 6: the legacy round-1 row is held by the undrained round, in its own free lane",
      "pending",
      await statusOf(E_HIGH),
    );
    assertEq("case 6: the paused project's root did not promote", "pending", await statusOf(E_PAUSED));
    assertEq(
      "case 6: nothing at all is live in the paused project",
      "0",
      (
        await db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM project_tasks
            WHERE project_id = $1 AND status IN ('ready','running')`,
          [P_PAUSED],
        )
      ).rows[0]?.c ?? "absent",
    );
    // And each clause is a real gate, not a coincidence: settle the rows they
    // were waiting on and both held rows promote on the next tick. Without this
    // the two "pending" assertions above would be satisfied by a statement that
    // never promotes anything at all.
    await db.query("UPDATE project_tasks SET status = 'done' WHERE id = ANY($1::uuid[])", [
      [E_DEP, E_LOW],
    ]);
    await promoteReadyTasks();
    assertEq("case 6: the waiter promotes once its dependency is done", "ready", await statusOf(E_WAITER));
    assertEq(
      "case 6: the legacy row promotes once round 0 has drained",
      "ready",
      await statusOf(E_HIGH),
    );

    // ---- the global property ----------------------------------------------
    console.log("\n--- the property, over every lane this run touched -----------------------------");
    const overCapped = await db.query<{ line: string }>(
      `SELECT project_id::text || '/' || workstream || '=' || count(*)::text AS line
         FROM project_tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE p.status = 'active' AND t.status IN ('ready','running')
          AND t.id <> $1 AND t.id <> $2          -- case 4's hand-seeded pair, never promoted
        GROUP BY project_id, workstream
       HAVING count(*) > 1`,
      [D_LIVE1, D_LIVE2],
    );
    assertEq(
      "no lane the promote statement touched holds more than one live row",
      "",
      overCapped.rows.map((r) => r.line).join(","),
    );

    exitCode = failed === 0 ? 0 : 1;
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch((e: unknown) => {
      console.error(
        `  WARNING: could not drop ${SCHEMA}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    await db.end();
  }

  console.log("\n==============================================================================");
  if (assertionsRun !== EXPECTED_ASSERTIONS) {
    console.error(
      `PROBES MISSED: ran ${assertionsRun} assertions, expected ${EXPECTED_ASSERTIONS}. ` +
        "A sweep whose probes miss must fail, never certify itself.",
    );
    return 1;
  }
  if (failed > 0) {
    console.error(`projects.test.ts FAILED — ${failed} of ${assertionsRun} assertions failed`);
    return 1;
  }
  console.log(`projects.test.ts PASSED — ${assertionsRun}/${EXPECTED_ASSERTIONS} assertions`);
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    // Never a quiet early return a caller could mistake for "nothing to report".
    console.error(`projects.test.ts ABORTED — ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(2);
  });
