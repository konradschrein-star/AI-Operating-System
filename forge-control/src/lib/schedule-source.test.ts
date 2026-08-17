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
 * WHAT IS DELIBERATELY NOT TESTED HERE: the three SQL statements and the pool
 * lifecycle. Those need a database, they belong to phase 8, and a unit test
 * that mocked `pg` would assert that the module equals a mock rather than that
 * it equals Postgres. The narrowing is what this file covers — the half where
 * `pg`'s RUNTIME types (a `Date` for `timestamptz`, `null` for an absent
 * column) meet `MetricTask`'s DECLARED ones, which is the half a typechecker
 * cannot see at all because the query result is `Record<string, unknown>`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  readProjectRows,
  taskRow,
  runRow,
  ScheduleSourceError,
  type ProjectRows,
} from "./schedule-source.ts";

const PROJECT = "8ea0cc08-0000-4000-8000-000000000001";

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
  /** Run `fn` with `DATABASE_URL` forced to `value` (or deleted), then restore
   *  it exactly, including the difference between "absent" and "empty". */
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
