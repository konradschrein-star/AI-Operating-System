/**
 * Unit tests for `schedule-source.ts` — the database half of the measurement
 * instrument, and the module phase 8's live read runs entirely through.
 *
 * WHY THIS FILE EXISTS: round 214's phase-7 finding 4. `schedule-source.ts` was
 * created by round 212's builder outside its declared write set, and shipped
 * with NO test file while `schedule-metrics.ts` beside it has an extensive one.
 * The code itself reviewed clean — pool closed in `finally`, no hardcoded DSN,
 * schema asked of `information_schema` rather than inferred — so the defect was
 * the zero coverage on phase 8's execution path, not a bug anyone had found.
 * The write is now recorded in `04-phases.md` §10 and this file is the
 * coverage.
 *
 * NF3 — NOTHING HERE OPENS A CONNECTION, and the module's own design is what
 * makes that possible. `readProjectRows()` builds its `pg.Pool` INSIDE the
 * function, so importing this module connects to nothing; and the `no-dsn`
 * refusal is the first statement in it, so the one call below returns before a
 * Pool is constructed. The row mappers are pure by construction.
 *
 * §4 IS ROUND 811'S ANSWER TO WHAT THIS HEADER USED TO SAY. It said: "WHAT IS
 * DELIBERATELY NOT TESTED HERE: the three SQL statements and the pool
 * lifecycle. Those need a database, they belong to phase 8." Round 810 executed
 * this module for the first time and it died before reading a row, on every
 * project, with `operator does not exist: uuid = text` — a parameter bound in
 * two irreconcilable type contexts in one statement. `tsc` could not see it;
 * neither could any test in this file. The disclosure was accurate and it was
 * not a plan.
 *
 * So the SQL is tested now, in two layers, and the reasoning that kept it
 * untested is answered rather than repeated:
 *
 *   §4.1 STATIC, always runs, opens nothing. It reads the exported statements
 *        and derives, per bound parameter, the set of types its comparison
 *        contexts force. Two forced types with nothing casting between them is
 *        the defect. Its own teeth are proved on the UNCAST statement, which
 *        stays in this file as a fixture forever.
 *   §4.2 EXECUTING, opt-in, the oracle. A static analysis of SQL is an opinion
 *        about SQL; only Postgres decides. It runs `readProjectRows()` and the
 *        raw statements against a THROWAWAY cluster and keeps the uncast form
 *        as a live negative control — the suite goes on watching the bug fail
 *        rather than trusting a fix nobody re-checks.
 *
 * NF3 SURVIVES BOTH. §4.2 is skipped unless `SCHEDULE_SOURCE_TEST_DSN` names a
 * scratch database, so `pnpm test` opens no connection. `scripts/check-schedule-sql.sh`
 * provisions the cluster and sets it, in one command, and exits non-zero.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import pg from "pg";

import {
  readProjectRows,
  taskRow,
  runRow,
  tasksSql,
  ScheduleSourceError,
  DEPENDS_ON_COLUMN_SQL,
  RUNS_SQL,
  type ProjectRows,
} from "./schedule-source.ts";

const PROJECT = "8ea0cc08-0000-4000-8000-000000000001";

/** Run `fn` with `DATABASE_URL` forced to `value` (or deleted), then restore it
 *  exactly, including the difference between "absent" and "empty". Used by §1,
 *  which needs it gone, and by §4.2, which needs it pointed at the scratch
 *  cluster — `readProjectRows()` reads the environment and nothing else. */
async function withDatabaseUrl(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const had = "DATABASE_URL" in process.env;
  const previous = process.env.DATABASE_URL;
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  try {
    await fn();
  } finally {
    if (had && previous !== undefined) process.env.DATABASE_URL = previous;
    else delete process.env.DATABASE_URL;
  }
}

/** A `project_tasks` row exactly as node-postgres hands it back. */
function pgTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    project_id: PROJECT,
    round: 1290,
    role: "builder",
    title: "a task",
    status: "done",
    created_at: new Date("2026-08-16T22:51:00.000Z"),
    run_id: "run-1",
    depends_on: ["task-0"],
    ...over,
  };
}

/** A `runs` row exactly as node-postgres hands it back. */
function pgRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    parent_run_id: null,
    status: "completed",
    created_at: new Date("2026-08-16T22:50:00.000Z"),
    started_at: new Date("2026-08-16T22:51:00.000Z"),
    completed_at: new Date("2026-08-16T23:23:00.000Z"),
    updated_at: new Date("2026-08-16T23:23:00.000Z"),
    archived: false,
    wake_after: null,
    ...over,
  };
}

/** Assert `fn` throws a `ScheduleSourceError` with exactly `reason`, whose
 *  `detail` names each needle. Asserts on the error VALUE, never on a
 *  stringified form — the anchored-RegExp defect of round 103. */
function expectSourceError(fn: () => unknown, reason: string, needles: string[]): ScheduleSourceError {
  let caught: unknown = undefined;
  let threw = false;
  try {
    fn();
  } catch (err) {
    caught = err;
    threw = true;
  }
  if (!threw) assert.fail(`expected ScheduleSourceError "${reason}", but nothing was thrown`);
  assert.ok(
    caught instanceof ScheduleSourceError,
    `threw ${String(caught)}, which is not a ScheduleSourceError`,
  );
  assert.equal(caught.reason, reason);
  for (const needle of needles) {
    assert.ok(
      caught.detail.some((d) => d.includes(needle)),
      `detail ${JSON.stringify(caught.detail)} names nothing matching "${needle}"`,
    );
  }
  return caught;
}

/* -------------------------------------------------------------------------- *
 * 1. The no-dsn refusal — the one arm of readProjectRows() reachable without
 *    a database.
 * -------------------------------------------------------------------------- */

describe("readProjectRows — the no-dsn refusal", () => {
  test("an UNSET DATABASE_URL refuses before any pool is constructed", async () => {
    await withDatabaseUrl(undefined, async () => {
      // If this ever stopped refusing, the assertion would not merely fail — it
      // would hang for `connectionTimeoutMillis` against whatever DSN pg
      // defaults to. The rejection arriving promptly is itself the evidence
      // that no connection was attempted.
      await assert.rejects(
        () => readProjectRows(PROJECT),
        (err: unknown) => {
          assert.ok(err instanceof ScheduleSourceError, `threw ${String(err)}`);
          assert.equal(err.reason, "no-dsn");
          return true;
        },
      );
    });
  });

  test("an EMPTY DATABASE_URL is refused too, not treated as a DSN", async () => {
    // `""` is the shape an unset shell variable produces through `export
    // DATABASE_URL=$SOMETHING_MISSING`, and `new pg.Pool({connectionString:
    // ""})` silently falls back to libpq's own defaults — i.e. to whatever
    // database the operator's environment happens to name. That is exactly the
    // "instrument reading the wrong database" failure the phase-3 probe's
    // positive control exists to catch, arriving here instead.
    await withDatabaseUrl("", async () => {
      await assert.rejects(
        () => readProjectRows(PROJECT),
        (err: unknown) => err instanceof ScheduleSourceError && err.reason === "no-dsn",
      );
    });
  });

  test("the refusal never echoes a connection string", async () => {
    await withDatabaseUrl(undefined, async () => {
      const err = await readProjectRows(PROJECT).then(
        (rows: ProjectRows) => assert.fail(`expected a refusal, got ${rows.tasks.length} tasks`),
        (e: unknown) => e,
      );
      assert.ok(err instanceof ScheduleSourceError);
      assert.doesNotMatch(err.message, /postgres:\/\//);
      assert.match(err.message, /never hardcodes one and never echoes one/);
    });
  });
});

/* -------------------------------------------------------------------------- *
 * 2. taskRow — where pg's runtime types meet MetricTask's declared ones.
 * -------------------------------------------------------------------------- */

describe("taskRow — the project_tasks narrowing", () => {
  test("a well-formed row maps field for field, with created_at as an ISO string", () => {
    assert.deepEqual(taskRow(pgTask(), 0, true, PROJECT), {
      id: "task-1",
      project_id: PROJECT,
      round: 1290,
      role: "builder",
      title: "a task",
      status: "done",
      // A `Date` in, an ISO-8601 string out. `MetricTask.created_at` is typed
      // `string` and `parseInstant()` calls `Date.parse` on it; a Date leaking
      // through would make `Date.parse(someDate)` coerce via toString and lose
      // the milliseconds.
      created_at: "2026-08-16T22:51:00.000Z",
      run_id: "run-1",
      depends_on: ["task-0"],
    });
  });

  test("on a pre-0040 schema `depends_on` is ABSENT, not null — E2's distinction", () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE. `isLegacyRow()` in
    // schedule-metrics.ts treats null and undefined identically, so this cannot
    // be caught downstream — but they say different things in the header, and
    // `hasDependsOnColumn` is asked of information_schema precisely so the two
    // are distinguishable. A mapper that wrote `depends_on: null` here would
    // report "migration 0040 has run and this row predates the graph" for a
    // database where the column does not exist at all.
    const row = taskRow(pgTask({ depends_on: undefined }), 0, false, PROJECT);
    assert.equal("depends_on" in row, false);
  });

  test("a NULL depends_on on a post-0040 schema survives as null", () => {
    // The migration-0040 sentinel itself. It must reach `isLegacyRow()` intact:
    // coerced to `[]` it would become an explicit graph root and D7 would
    // compute a number for a project it must refuse.
    const row = taskRow(pgTask({ depends_on: null }), 0, true, PROJECT);
    assert.equal(row.depends_on, null);
  });

  test("an empty depends_on array is preserved as an array, never as null", () => {
    const row = taskRow(pgTask({ depends_on: [] }), 0, true, PROJECT);
    assert.deepEqual(row.depends_on, []);
  });

  test("a null run_id normalises to null and does not throw", () => {
    assert.equal(taskRow(pgTask({ run_id: null }), 0, true, PROJECT).run_id, null);
  });

  const TASK_REFUSALS: Array<[string, Record<string, unknown>, string[]]> = [
    [
      "a column missing from the SELECT",
      (() => {
        const row = pgTask();
        delete row.status;
        return row;
      })(),
      ["has no 'status'"],
    ],
    [
      "round arriving as a string — an int8 or a numeric would",
      pgTask({ round: "1290" }),
      ["round is a string", "expected a finite number"],
    ],
    [
      "round arriving as NaN",
      pgTask({ round: Number.NaN }),
      ["expected a finite number"],
    ],
    [
      "a NOT NULL timestamp arriving null",
      pgTask({ created_at: null }),
      ["created_at is null", "NOT NULL in the schema"],
    ],
    [
      "depends_on arriving as a raw Postgres array literal instead of a parsed array",
      pgTask({ depends_on: "{task-0}" }),
      ["depends_on is a string", "expected a uuid[] or null"],
    ],
    [
      "depends_on holding a non-string element",
      pgTask({ depends_on: ["task-0", 7] }),
      ["depends_on[1] is a number"],
    ],
  ];

  for (const [why, row, needles] of TASK_REFUSALS) {
    test(`refuses ${why}, naming the row and the column`, () => {
      const err = expectSourceError(() => taskRow(row, 3, true, PROJECT), "db-shape", needles);
      // Every message must locate the row. `project_tasks[3]` and the project
      // id are what turn "db-shape" into something an operator can go and look
      // at; a refusal that names only the type is a refusal you cannot act on.
      assert.match(err.message, /project_tasks\[3\]/);
      assert.ok(err.message.includes(PROJECT), "the refusal must name the project");
    });
  }
});

/* -------------------------------------------------------------------------- *
 * 3. runRow — the same narrowing over the runs table.
 * -------------------------------------------------------------------------- */

describe("runRow — the runs narrowing", () => {
  test("a well-formed row maps field for field, every timestamp an ISO string", () => {
    assert.deepEqual(runRow(pgRun(), 0), {
      id: "run-1",
      parent_run_id: null,
      status: "completed",
      created_at: "2026-08-16T22:50:00.000Z",
      started_at: "2026-08-16T22:51:00.000Z",
      completed_at: "2026-08-16T23:23:00.000Z",
      updated_at: "2026-08-16T23:23:00.000Z",
      archived: false,
      wake_after: null,
    });
  });

  test("an unterminated run keeps completed_at null rather than inventing one", () => {
    // D5's input. A mapper that defaulted this to `updated_at` would make
    // `runIntervals()`'s "unterminated-run" refusal unreachable and shorten
    // summed run time, which flatters S2.
    const row = runRow(pgRun({ completed_at: null, status: "running" }), 0);
    assert.equal(row.completed_at, null);
    assert.equal(row.started_at, "2026-08-16T22:51:00.000Z");
  });

  test("a sub-agent run keeps its parent_run_id — D1's whole exclusion rests on it", () => {
    assert.equal(runRow(pgRun({ parent_run_id: "run-parent" }), 0).parent_run_id, "run-parent");
  });

  test("archived: true survives — D2 counts it as a disclosure", () => {
    assert.equal(runRow(pgRun({ archived: true }), 0).archived, true);
  });

  test("a timestamptz already arriving as a string passes through unchanged", () => {
    // pg can be configured to skip Date parsing. The mapper accepts both, and
    // this pins that it does not double-convert.
    const row = runRow(pgRun({ started_at: "2026-08-16T22:51:00.000Z" }), 0);
    assert.equal(row.started_at, "2026-08-16T22:51:00.000Z");
  });

  const RUN_REFUSALS: Array<[string, Record<string, unknown>, string[]]> = [
    ["archived arriving as null", pgRun({ archived: null }), ["archived is null", "expected a boolean"]],
    ["archived arriving as 0/1", pgRun({ archived: 0 }), ["archived is a number"]],
    ["a NOT NULL updated_at arriving null", pgRun({ updated_at: null }), ["NOT NULL in the schema"]],
    [
      "a timestamp arriving as a number of epoch ms",
      pgRun({ started_at: 1_755_385_860_000 }),
      ["expected a Date, a string or null"],
    ],
  ];

  for (const [why, row, needles] of RUN_REFUSALS) {
    test(`refuses ${why}`, () => {
      const err = expectSourceError(() => runRow(row, 5), "db-shape", needles);
      assert.match(err.message, /runs\[5\]/);
    });
  }
});

/* -------------------------------------------------------------------------- *
 * 4.1 The statements, read statically — the defect class, derived
 * -------------------------------------------------------------------------- */

/**
 * THE BUG, KEPT ALIVE AS A FIXTURE. This is `RUNS_SQL` with round 811's cast
 * taken back off — the statement exactly as it shipped from round 212 until
 * round 810 executed it. It is DERIVED from the shipped constant rather than
 * pasted beside it, so it cannot drift into a museum piece that still passes
 * while the shipped statement has moved on. That derivation is itself checked
 * below: if it stops differing from `RUNS_SQL`, this fixture is measuring
 * nothing and must say so.
 */
const RUNS_SQL_UNCAST = RUNS_SQL.replace("$1::uuid", "$1");

/** One `<lhs> = $n` comparison found in a statement. */
interface ParamUse {
  /** `1` for `$1`. */
  param: string;
  /** The left-hand operand text, verbatim. */
  lhs: string;
  /** `"::uuid"` when the site casts the parameter, `null` when it does not. */
  cast: string | null;
  /** The type this site forces the parameter to, or `UNCLASSIFIED`. */
  forced: string;
}

const UNCLASSIFIED = "UNCLASSIFIED";

/**
 * Columns whose declared type is `uuid` in `db/migrations/0021_ai_os_tables.sql`
 * and `0030_coding_projects.sql`. Comparing a parameter to one of these forces
 * the parameter to `uuid`.
 */
const UUID_COLUMNS = new Set(["id", "project_id", "run_id", "parent_run_id"]);

const COMPARISON_RE = /([A-Za-z_][A-Za-z0-9_.]*(?:\s*->>\s*'[^']*')?)\s*=\s*\$(\d+)(::[a-z_]+)?/g;

/** `->>` yields `text`; a uuid column forces `uuid`; anything else is a gap in
 *  this classifier and must be reported as one, never waved through as safe. */
function forcedTypeOf(lhs: string): string {
  if (lhs.includes("->>")) return "text";
  const bare = lhs.split(".").pop() ?? lhs;
  return UUID_COLUMNS.has(bare) ? "uuid" : UNCLASSIFIED;
}

function parameterUses(sql: string): ParamUse[] {
  const uses: ParamUse[] = [];
  for (const match of sql.matchAll(COMPARISON_RE)) {
    const lhs = match[1].trim();
    uses.push({
      param: match[2],
      lhs,
      cast: match[3] ?? null,
      forced: forcedTypeOf(lhs),
    });
  }
  return uses;
}

/**
 * The invariant, stated as Postgres states it: a parameter is typed ONCE per
 * statement. Every UNCAST site therefore constrains the same single type, so
 * two uncast sites forcing different types is a statement that cannot resolve.
 * A cast site is excluded because the cast, not the site, decides there.
 */
function typeConflicts(sql: string): string[] {
  const forcedByParam = new Map<string, Map<string, string>>();
  const problems: string[] = [];
  for (const use of parameterUses(sql)) {
    if (use.forced === UNCLASSIFIED) {
      problems.push(
        `$${use.param} is compared with '${use.lhs}', which this test's classifier ` +
          "does not know the type of — teach it rather than assume the statement is safe",
      );
      continue;
    }
    if (use.cast !== null) continue;
    const seen = forcedByParam.get(use.param) ?? new Map<string, string>();
    seen.set(use.forced, use.lhs);
    forcedByParam.set(use.param, seen);
  }
  for (const [param, seen] of forcedByParam) {
    if (seen.size < 2) continue;
    const where = [...seen].map(([type, lhs]) => `${type} (via '${lhs}')`).join(" and ");
    problems.push(
      `$${param} is forced to ${seen.size} types with no cast between them: ${where}. ` +
        "Postgres types a parameter once per statement, so this cannot resolve.",
    );
  }
  return problems;
}

describe("the shipped SQL, read statically", () => {
  const PARAMETERISED: Array<[string, string]> = [
    ["tasksSql(false) — pre-0040 schema", tasksSql(false)],
    ["tasksSql(true) — post-0040 schema", tasksSql(true)],
    ["RUNS_SQL", RUNS_SQL],
  ];

  test("POSITIVE CONTROL: the analyser actually finds comparisons to analyse", () => {
    // A regex that silently matches nothing would report every statement clean,
    // which is the self-certifying sweep 00-vision.md §7 rule 2 forbids.
    for (const [name, sql] of PARAMETERISED) {
      assert.ok(parameterUses(sql).length > 0, `${name}: no '<lhs> = $n' comparison was parsed`);
    }
    assert.equal(parameterUses(DEPENDS_ON_COLUMN_SQL).length, 0, "the probe binds no parameter");
  });

  test("POSITIVE CONTROL: the uncast fixture really differs from the shipped statement", () => {
    assert.notEqual(
      RUNS_SQL_UNCAST,
      RUNS_SQL,
      "RUNS_SQL no longer contains '$1::uuid', so the negative controls below are vacuous — " +
        "either the cast was removed (the round-810 bug is back) or the statement was rewritten",
    );
  });

  test("THE DEFECT, DERIVED: the uncast statement forces $1 to both uuid and text", () => {
    // This assertion is the reason this section exists. Run against the bytes
    // that shipped before round 811 it names the failure; the shipped statement
    // below is clean. A test that has only ever seen the fix proves nothing.
    const problems = typeConflicts(RUNS_SQL_UNCAST);
    assert.equal(problems.length, 1, `expected exactly one conflict, got ${JSON.stringify(problems)}`);
    assert.match(problems[0], /^\$1 is forced to 2 types/);
    assert.match(problems[0], /uuid \(via 'project_id'\)/);
    assert.match(problems[0], /text \(via 'metadata->>'project_id''\)/);
  });

  for (const [name, sql] of [...PARAMETERISED, ["DEPENDS_ON_COLUMN_SQL", DEPENDS_ON_COLUMN_SQL]] as Array<
    [string, string]
  >) {
    test(`${name} forces no parameter to two types`, () => {
      assert.deepEqual(typeConflicts(sql), []);
    });
  }

  test("RUNS_SQL casts the uuid arm and leaves the json arm text", () => {
    // WHICH arm carries the cast matters. On the json arm it would have to cast
    // the COLUMN expression on every row, discarding the index; on the uuid arm
    // it casts one scalar once.
    const uses = parameterUses(RUNS_SQL);
    assert.equal(uses.length, 2, `expected $1 twice, got ${JSON.stringify(uses)}`);
    const json = uses.find((u) => u.lhs.includes("->>"));
    const uuid = uses.find((u) => !u.lhs.includes("->>"));
    assert.ok(json !== undefined && uuid !== undefined);
    assert.equal(json.cast, null);
    assert.equal(uuid.cast, "::uuid");
    assert.equal(uuid.lhs, "project_id");
  });
});

/* -------------------------------------------------------------------------- *
 * 4.2 The statements, EXECUTED — Postgres is the only oracle
 * -------------------------------------------------------------------------- */

/**
 * The scratch database `scripts/check-schedule-sql.sh` creates on a throwaway
 * cluster. The name is asserted before a single statement runs: an instrument
 * that can be aimed at the live database by setting one variable is the "probe
 * measuring the wrong thing" failure this project has already paid for.
 */
const SCRATCH_DB = "schedule_sql_check";
const EXEC_DSN = process.env.SCHEDULE_SOURCE_TEST_DSN ?? "";
const EXEC_SKIP: string | false =
  EXEC_DSN === ""
    ? "SCHEDULE_SOURCE_TEST_DSN is unset, so NF3 holds and this suite opens no connection. " +
      "Run `scripts/check-schedule-sql.sh` — it provisions a throwaway cluster, sets the variable and exits non-zero on failure."
    : false;

const SCRATCH_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    id            uuid PRIMARY KEY,
    parent_run_id uuid REFERENCES runs(id),
    status        varchar(16) NOT NULL,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz,
    completed_at  timestamptz,
    archived      boolean NOT NULL DEFAULT false,
    wake_after    timestamptz
  );
  CREATE TABLE IF NOT EXISTS project_tasks (
    id         uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    round      int NOT NULL DEFAULT 0,
    role       varchar(16) NOT NULL,
    title      text NOT NULL,
    status     varchar(16) NOT NULL DEFAULT 'pending',
    run_id     uuid REFERENCES runs(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`;

const NAMED_RUN = "8ea0cc08-0000-4000-8000-0000000000a1";
const METADATA_ONLY_RUN = "8ea0cc08-0000-4000-8000-0000000000a2";

/** `pg` attaches SQLSTATE as `code`. Read it off the error VALUE — a match on a
 *  stringified error is the anchored-RegExp defect of round 103. */
function sqlstateOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

describe("the shipped SQL, executed against a throwaway Postgres", { skip: EXEC_SKIP }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: EXEC_DSN, max: 2, connectionTimeoutMillis: 5_000 });
    const db = await pool.query<{ current_database: string }>("SELECT current_database()");
    const name = db.rows[0]?.current_database;
    if (name !== SCRATCH_DB) {
      // A refusal, NOT a skip. A misaimed DSN must stop the run, because the
      // next statement would create tables in whatever database it named.
      throw new Error(
        `SCHEDULE_SOURCE_TEST_DSN names database '${String(name)}', not '${SCRATCH_DB}'. ` +
          "This suite writes DDL and rows; it runs only against the scratch database " +
          "scripts/check-schedule-sql.sh creates on a throwaway cluster.",
      );
    }
    await pool.query(SCRATCH_DDL);
    await pool.query(
      `INSERT INTO runs (id, status, metadata, created_at, started_at, completed_at, updated_at)
       VALUES ($1::uuid, 'completed', jsonb_build_object('project_id', $2::text),
               '2026-08-16T22:50:00Z', '2026-08-16T22:51:00Z', '2026-08-16T23:23:00Z', '2026-08-16T23:23:00Z'),
              ($3::uuid, 'completed', jsonb_build_object('project_id', $2::text),
               '2026-08-16T23:30:00Z', '2026-08-16T23:31:00Z', '2026-08-16T23:40:00Z', '2026-08-16T23:40:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [NAMED_RUN, PROJECT, METADATA_ONLY_RUN],
    );
    await pool.query(
      `INSERT INTO project_tasks (id, project_id, round, role, title, status, run_id, created_at)
       VALUES ('8ea0cc08-0000-4000-8000-0000000000b1'::uuid, $1::uuid, 1290, 'builder', 'a task', 'done',
               $2::uuid, '2026-08-16T22:51:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT, NAMED_RUN],
    );
  });

  after(async () => {
    await pool.end();
  });

  test("THE REGRESSION: readProjectRows() completes end to end on a pre-0040 schema", async () => {
    // Round 810 got no further than this call. Against the uncast statement it
    // rejects with 42883 before a row is read, on every project.
    await withDatabaseUrl(EXEC_DSN, async () => {
      const rows: ProjectRows = await readProjectRows(PROJECT);
      assert.equal(rows.hasDependsOnColumn, false);
      assert.equal(rows.tasks.length, 1);
      assert.equal(rows.tasks[0].id, "8ea0cc08-0000-4000-8000-0000000000b1");
      assert.equal("depends_on" in rows.tasks[0], false, "a pre-0040 row carries no depends_on key");
      // BOTH arms of the OR must still fire: one run is reached through
      // project_tasks.run_id (the cast arm), the other only through
      // metadata->>'project_id' (the text arm). A cast that fixed the statement
      // by breaking the json arm would return one row here.
      assert.deepEqual(
        rows.runs.map((r) => r.id).sort(),
        [NAMED_RUN, METADATA_ONLY_RUN].sort(),
      );
      assert.equal(rows.runs[0].created_at, "2026-08-16T22:50:00.000Z");
    });
  });

  test("NEGATIVE CONTROL: the uncast statement still fails, with the error round 810 hit", async () => {
    // The permanent form of "this test has seen the bug". It does not assert
    // that the fix works; it asserts that the thing the fix fixed is still
    // broken, so a future rewrite cannot make this file pass vacuously.
    await assert.rejects(
      () => pool.query(RUNS_SQL_UNCAST, [PROJECT]),
      (err: unknown) => {
        assert.equal(sqlstateOf(err), "42883", `SQLSTATE was ${String(sqlstateOf(err))}`);
        assert.match(String(err), /operator does not exist: uuid = text/);
        return true;
      },
    );
  });

  test("the shipped RUNS_SQL prepares and executes with the same binding", async () => {
    const result = await pool.query(RUNS_SQL, [PROJECT]);
    assert.equal(result.rows.length, 2);
  });

  test("a malformed project id fails loudly at the cast rather than matching nothing", async () => {
    // The cast's one behavioural cost, pinned. `$1` is still typed `text`, so a
    // non-uuid reaches the cast and raises 22P02. An empty result set here
    // would be the silent fallback the standing rules forbid.
    await assert.rejects(
      () => pool.query(RUNS_SQL, ["not-a-uuid"]),
      (err: unknown) => {
        assert.equal(sqlstateOf(err), "22P02");
        return true;
      },
    );
  });

  test("the tasks statement and the schema probe execute, before and after 0040", async () => {
    await pool.query(tasksSql(false), [PROJECT]);
    const before0040 = await pool.query(DEPENDS_ON_COLUMN_SQL);
    assert.equal(before0040.rows.length, 0, "the scratch schema starts pre-0040");

    await pool.query("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS depends_on uuid[] DEFAULT '{}'");
    const after0040 = await pool.query(DEPENDS_ON_COLUMN_SQL);
    assert.equal(after0040.rows.length, 1, "the probe must see the column migration 0040 adds");

    await pool.query(tasksSql(true), [PROJECT]);
    await withDatabaseUrl(EXEC_DSN, async () => {
      const rows = await readProjectRows(PROJECT);
      assert.equal(rows.hasDependsOnColumn, true);
      // pg parses uuid[] into a JS array; the mapper must receive it as one.
      assert.deepEqual(rows.tasks[0].depends_on, []);
    });
  });
});
