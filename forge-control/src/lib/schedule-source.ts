/**
 * schedule-source.ts — the database half of the measurement instrument, and the
 * ONLY module in it that names `pg`.
 *
 * WHY THIS FILE EXISTS AT ALL, given that `scripts/measure-schedule.ts` could
 * have held these thirty lines itself: it could not. `scripts/` has no
 * `node_modules` and neither does the repo root, so a bare `pg` specifier in a
 * root-level script resolves nowhere — at run time with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'pg' imported from
 * .../scripts/measure-schedule.ts`, and at compile time with TS2307. Measured,
 * not assumed: the first draft of the wrapper imported `pg` directly, typechecked
 * only under a `paths` mapping, and died on module resolution the moment
 * `--project` was passed. That failure would have surfaced in phase 8, against
 * the live database, in the one task that has no worktree fallback.
 *
 * Inside `forge-control/src/lib/` the specifier resolves natively, `@types/pg`
 * is found without a mapping, and the file is covered by `pnpm typecheck`
 * (`include: ["src/**​/*.ts"]`) rather than by a bespoke check.
 *
 * IT ALSO MAKES THE ISOLATION STRUCTURAL. `measure-schedule.ts` reaches this
 * module through a dynamic `await import()` on the `--project` branch alone, so
 * fixture mode does not resolve it, does not resolve `pg`, and cannot construct
 * a Pool even by accident. That is what keeps the instrument runnable from a
 * build task under the worktree-only policy (`03-quality.md` §2.3).
 *
 * THE POOL IS BUILT INSIDE THE FUNCTION, not at module scope, unlike
 * `db/projects.ts` and its siblings. Importing this module therefore connects to
 * nothing; only calling it does. A module-scope pool would put a live
 * connection one stray import away from the unit suite, and NF3 says no test
 * opens a database connection.
 *
 * NOT EXERCISED IN PHASE 7. Written, typechecked and left unrun: live reads
 * belong to phase 8. The DSN comes from `DATABASE_URL` and from nowhere else —
 * never a hardcoded fallback (unlike `db/projects.ts`'s `CONTENT_URL`, which is
 * that module's own decision and not one an instrument may inherit), and never
 * echoed into output.
 *
 * QUERY SHAPES are the scout's, `docs/research/round-100-e7548096.md` §2 and §4:
 * a project's tasks are `project_tasks WHERE project_id = $1`; a task's run is
 * `project_tasks.run_id`; and the project's other runs — the sub-agent census D1
 * excludes, and any earlier run of a retried task — are found by
 * `runs.metadata->>'project_id' = $1`.
 */

import pg from "pg";

import type { MetricRun, MetricTask } from "./schedule-metrics.ts";

/**
 * A refusal from the source layer, shaped like `MeasurementError` — an `Error`
 * carrying `reason: string` and `detail: string[]`. `measure-schedule.ts`
 * recognises that shape structurally rather than by `instanceof`, precisely so
 * it does not have to import this module (and therefore `pg`) to print an error
 * from it.
 */
export class ScheduleSourceError extends Error {
  readonly reason: string;
  readonly detail: string[];

  constructor(reason: string, detail: string[]) {
    super(`schedule-source: ${reason} — ${detail.join("; ")}`);
    this.name = "ScheduleSourceError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface ProjectRows {
  tasks: MetricTask[];
  runs: MetricRun[];
  /**
   * R60's schema fact, asked of `information_schema` rather than inferred from
   * the rows. A project whose every row happens to carry an empty `depends_on`
   * is indistinguishable from a pre-0040 schema by row inspection alone, and
   * the header must not guess between "no dependencies" and "no column".
   */
  hasDependsOnColumn: boolean;
}

export async function readProjectRows(projectId: string): Promise<ProjectRows> {
  const dsn = process.env.DATABASE_URL;
  if (dsn === undefined || dsn === "") {
    throw new ScheduleSourceError("no-dsn", [
      "DATABASE_URL is not set. The instrument takes its connection string from the environment; " +
        "it never hardcodes one and never echoes one.",
    ]);
  }

  const pool = new pg.Pool({ connectionString: dsn, max: 2, connectionTimeoutMillis: 5_000 });
  try {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'project_tasks'
          AND column_name = 'depends_on'`,
    );
    const hasDependsOnColumn = columns.rows.length === 1;

    const taskColumns = hasDependsOnColumn
      ? "id, project_id, round, role, title, status, created_at, run_id, depends_on"
      : "id, project_id, round, role, title, status, created_at, run_id";
    const taskRows = await pool.query<Record<string, unknown>>(
      `SELECT ${taskColumns} FROM project_tasks WHERE project_id = $1 ORDER BY round, created_at`,
      [projectId],
    );

    const runRows = await pool.query<Record<string, unknown>>(
      `SELECT id, parent_run_id, status, created_at, started_at, completed_at, updated_at, archived, wake_after
         FROM runs
        WHERE metadata->>'project_id' = $1
           OR id IN (SELECT run_id FROM project_tasks WHERE project_id = $1 AND run_id IS NOT NULL)
        ORDER BY created_at`,
      [projectId],
    );

    return {
      tasks: taskRows.rows.map((row, i) => taskRow(row, i, hasDependsOnColumn, projectId)),
      runs: runRows.rows.map((row, i) => runRow(row, i)),
      hasDependsOnColumn,
    };
  } finally {
    await pool.end();
  }
}

/**
 * EXPORTED FOR `schedule-source.test.ts`, round 215 (round 214's phase-7
 * finding 4). This module is the entire path phase 8's live read runs through
 * and it shipped with no test file at all, while the pure module beside it has
 * an extensive one. The reason was structural rather than lazy: everything here
 * was reachable only through `readProjectRows()`, which needs a pool, and NF3
 * forbids a test that opens a connection.
 *
 * Exporting the two row mappers dissolves that: the MAPPING is pure — a
 * `Record<string, unknown>` in, a narrowed row out — and it is the half most
 * likely to be wrong, because it is where `pg`'s runtime types (a `Date` for
 * `timestamptz`, a `string` for `int8`, `null` for an absent column) meet
 * `MetricTask`'s declared ones. The SQL and the pool stay untested from here
 * and are phase 8's business; the narrowing no longer is.
 */
export function taskRow(
  row: Record<string, unknown>,
  index: number,
  hasDependsOn: boolean,
  projectId: string,
): MetricTask {
  const where = `project_tasks[${index}] of project ${projectId}`;
  const task: MetricTask = {
    id: asString(field(row, "id", where), `${where}.id`),
    project_id: asString(field(row, "project_id", where), `${where}.project_id`),
    round: asNumber(field(row, "round", where), `${where}.round`),
    role: asString(field(row, "role", where), `${where}.role`),
    title: asString(field(row, "title", where), `${where}.title`),
    status: asString(field(row, "status", where), `${where}.status`),
    created_at: asIso(field(row, "created_at", where), `${where}.created_at`),
    run_id: asStringOrNull(field(row, "run_id", where), `${where}.run_id`),
  };
  // On a pre-0040 schema `depends_on` is left ABSENT rather than set to null.
  // `isLegacyRow()` in schedule-metrics.ts reads the two the same way, but they
  // say different things to a reader of the header: null is migration 0040's
  // sentinel, undefined is "the column does not exist".
  if (hasDependsOn) {
    task.depends_on = asStringArrayOrNull(field(row, "depends_on", where), `${where}.depends_on`);
  }
  return task;
}

/** Exported for the same reason as `taskRow()` above. */
export function runRow(row: Record<string, unknown>, index: number): MetricRun {
  const where = `runs[${index}]`;
  return {
    id: asString(field(row, "id", where), `${where}.id`),
    parent_run_id: asStringOrNull(field(row, "parent_run_id", where), `${where}.parent_run_id`),
    status: asString(field(row, "status", where), `${where}.status`),
    created_at: asIso(field(row, "created_at", where), `${where}.created_at`),
    started_at: asIsoOrNull(field(row, "started_at", where), `${where}.started_at`),
    completed_at: asIsoOrNull(field(row, "completed_at", where), `${where}.completed_at`),
    updated_at: asIso(field(row, "updated_at", where), `${where}.updated_at`),
    archived: asBoolean(field(row, "archived", where), `${where}.archived`),
    wake_after: asIsoOrNull(field(row, "wake_after", where), `${where}.wake_after`),
  };
}

/* -------------------------------------------------------------------------- *
 * Narrowing — every column stated, every surprise named
 * -------------------------------------------------------------------------- */

function field(row: Record<string, unknown>, key: string, where: string): unknown {
  if (!(key in row)) throw new ScheduleSourceError("db-shape", [`${where} has no '${key}'`]);
  return row[key];
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new ScheduleSourceError("db-shape", [`${where} is ${describe(value)}, expected a string`]);
  }
  return value;
}

function asStringOrNull(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, where);
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScheduleSourceError("db-shape", [
      `${where} is ${describe(value)}, expected a finite number`,
    ]);
  }
  return value;
}

function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new ScheduleSourceError("db-shape", [`${where} is ${describe(value)}, expected a boolean`]);
  }
  return value;
}

function asStringArrayOrNull(value: unknown, where: string): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new ScheduleSourceError("db-shape", [
      `${where} is ${describe(value)}, expected a uuid[] or null`,
    ]);
  }
  return value.map((entry, i) => asString(entry, `${where}[${i}]`));
}

/** A `timestamptz` as node-postgres hands it back: a `Date`. */
function asIso(value: unknown, where: string): string {
  const iso = asIsoOrNull(value, where);
  if (iso === null) {
    throw new ScheduleSourceError("db-shape", [
      `${where} is null, and this column is NOT NULL in the schema`,
    ]);
  }
  return iso;
}

function asIsoOrNull(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new ScheduleSourceError("db-shape", [
    `${where} is ${describe(value)}, expected a Date, a string or null`,
  ]);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a ${typeof value}`;
}
