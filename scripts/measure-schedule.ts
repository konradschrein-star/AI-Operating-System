#!/usr/bin/env -S node --import tsx
/**
 * measure-schedule.ts — the I/O half of the project engine's measurement
 * instrument. R59 (it prints), R60 (it declares its own identity first), R61
 * (the exit-code half: it fails loudly rather than printing a smaller table).
 *
 * THE SPLIT. Every decision and every arithmetic operation lives in
 * `forge-control/src/lib/schedule-metrics.ts`, which is pure and hermetic. This
 * file does the three things that module refuses to do: it reads bytes, it
 * prints, and it maps a refusal onto a non-zero exit status. It is the same
 * split `project-reconcile.ts` / `project-tick.ts` already uses.
 *
 * -------------------------------------------------------------------------
 * TWO NAMED MODES, NEITHER OF WHICH DEGRADES INTO THE OTHER
 * -------------------------------------------------------------------------
 *
 *   tsx scripts/measure-schedule.ts full   [--fixture <path> | --project <uuid>]
 *   tsx scripts/measure-schedule.ts rounds [--fixture <path> | --project <uuid>]
 *
 * `full` prints everything R59 lists — the round/task table, run count, mean
 * run duration, summed run time, wall clock, the per-minute concurrency
 * samples, S1, S2 and S3. It requires run data, and if it cannot produce every
 * one of those numbers it exits non-zero with the reason.
 *
 * `rounds` prints the `00-vision.md` §2 round/task table and its tasks-per-round
 * and NOTHING else. It reads no run data at all and says so in its own header
 * (`ROUNDS_MODE_DISCLAIMER` below).
 *
 * **`full` NEVER falls back to `rounds`.** Not on a missing `runs` key, not on a
 * parse failure, not on an empty result. That fallback is exactly R61's "smaller,
 * prettier table" and it is the failure this instrument exists to make
 * impossible. An operator who wants the round table alone asks for it by name.
 * The fallback is unwritable rather than merely unwritten: `runMeasurement()`
 * has one call to `computeSchedule()` and no catch, and the only `catch` in the
 * file is the top-level one that exits non-zero.
 *
 * -------------------------------------------------------------------------
 * THE HEADER IS THE INSTRUMENT'S OWN IDENTITY, COMPUTED AT RUN TIME (R60)
 * -------------------------------------------------------------------------
 * The header is the FIRST output, in every mode, on every run, before any
 * number — and it is computed by the running process from the bytes actually
 * executing. It is never hand-copied into a document; a report that quotes an
 * identity this script did not itself emit is a finding.
 *
 * `instrument-sha256` is a hash of THIS FILE, read off disk at startup via
 * `import.meta.url`. It is the field that matters. Three separate identity
 * failures are already on this project's record, and each came from an identity
 * recorded at a different moment from the one the instrument ran in: a SHA
 * naming the worktree rather than the build; a generated region stamped with
 * `git HEAD` so that COMMITTING it moved HEAD and made the region wrong on the
 * very commit that created it (`03-quality.md` §3.2, phase 2, mutation 5); and a
 * transcript attributing results to a sha256 naming bytes in no commit at all. A
 * self-hash of the executing file has none of those gaps: it is stable across
 * the commit that lands the file, and it changes if and only if the bytes that
 * ran changed.
 *
 * `git-head` is printed too, and is labelled in the header line itself as naming
 * the TREE rather than the bytes that ran. The two fields disagreeing is normal
 * and informative — commit this file and `git-head` moves while
 * `instrument-sha256` does not.
 *
 * -------------------------------------------------------------------------
 * NO DATABASE IS OPENED IN FIXTURE MODE
 * -------------------------------------------------------------------------
 * Not opened, not imported. `pg` appears NOWHERE in this file. Every line that
 * touches it lives in `forge-control/src/lib/schedule-source.ts`, which this
 * file reaches through a dynamic `await import()` inside `readFromDatabase()`,
 * which is called from exactly one place: the `--project` branch of
 * `loadInput()`. A static import would put a database driver in the module graph
 * of every fixture-mode run, and that is what would stop this script being
 * runnable from a build task at all under the worktree-only policy
 * (`03-quality.md` §2.3 — live reads belong to phase 8 alone).
 *
 * The reader lives inside `forge-control/src/` rather than here for a second
 * reason, found by running it rather than by reading it: `scripts/` has no
 * `node_modules` and neither does the repo root, so a bare `pg` specifier in a
 * root-level script resolves nowhere — `ERR_MODULE_NOT_FOUND` at run time,
 * TS2307 at compile time. The first draft imported `pg` here and died the moment
 * `--project` was passed. See that file's header.
 *
 * -------------------------------------------------------------------------
 * THE FIXTURES
 * -------------------------------------------------------------------------
 * `forge-control/src/lib/fixtures/replay-operator-visibility.json` — phase 1's
 * capture of `operator-visibility` (8ea0cc08). A BARE ARRAY of 131 task rows
 * carrying exactly six keys each (`{id, round, role, title, status,
 * created_at}`, asserted as A3 in its sibling `.md`). No `run_id`, no
 * timestamps beyond `created_at`. `rounds` mode reads it; `full` mode exits
 * non-zero naming the missing `runs` key, and that refusal is the mechanical
 * form of a finding this phase carries rather than solves: S1, S2, mean run
 * duration and wall clock for the 8ea0cc08 baseline are NOT COMPUTABLE from
 * anything in this worktree. Completing that baseline needs a live read, which
 * is phase 8's authority, not phase 7's. No estimated durations are invented
 * here and the live database is not read.
 *
 * `forge-control/src/lib/fixtures/schedule-truncated-4.json` — four obviously
 * synthetic task rows (ids `00000000-0000-0000-0000-00000000000{1..4}`),
 * otherwise entirely well-formed: real project id, real `depends_on` edges, all
 * four `pending` with no `run_id`, and an empty `runs` array. It exists solely
 * so a reviewer can run the R61 case and watch `full` exit 1 on `too-few-tasks`.
 * It is documented here, by name, because a bare JSON array has no room for a
 * `_comment` key.
 *
 * It is deliberately the OBJECT form rather than a bare array: `too-few-tasks`
 * is `computeSchedule()`'s refusal, so the input must get that far, and a bare
 * array would be refused one step earlier for having no `runs` key. Every field
 * of it is valid; the ONLY reason it exits non-zero is that four rows are fewer
 * than the five R61 requires.
 *
 * -------------------------------------------------------------------------
 * USAGE
 * -------------------------------------------------------------------------
 *   cd forge-control
 *   ./node_modules/.bin/tsx ../scripts/measure-schedule.ts rounds \
 *       --fixture src/lib/fixtures/replay-operator-visibility.json
 *   ./node_modules/.bin/tsx ../scripts/measure-schedule.ts full --project <uuid>
 *
 *   --fixture <path>   read a JSON file. Either a bare array of task rows, or
 *                      an object `{ project_id, tasks: [...], runs: [...] }`.
 *   --project <uuid>   read the live database. `DATABASE_URL` must be set; it is
 *                      never hardcoded and never echoed. NOT EXERCISED IN PHASE
 *                      7 — written, typechecked, left unrun (`03-quality.md`
 *                      §2.3).
 *   --from <iso>       inclusive lower bound on `project_tasks.created_at`.
 *   --to <iso>         inclusive upper bound on `project_tasks.created_at`.
 *
 * Both window flags are optional; absent, the header reads `window: full
 * project`. They exist because `00-vision.md` §2's numbers describe a window
 * (2026-08-16 22:51 → 2026-08-17 03:04 CEST) and a whole-project table compared
 * against a windowed one is not a comparison.
 *
 * WINDOW SEMANTICS, STATED RATHER THAN ASSUMED. `--from`/`--to` filter TASKS by
 * `created_at`, inclusive at both ends. When either flag is given, the run set
 * is narrowed with them to the runs the retained tasks name plus those runs'
 * sub-agent children — otherwise wall clock would be computed over runs the
 * window excluded. That narrowing costs one thing and the header says so: an
 * earlier run of a task that was later retried is no longer counted, because
 * `project_tasks.run_id` names only the most recent one. With no window flag the
 * run set is untouched and those retry runs are counted, which is
 * `schedule-metrics.ts`'s `scopeRuns()` decision left intact.
 *
 * -------------------------------------------------------------------------
 * EXIT CODES
 * -------------------------------------------------------------------------
 *   0   the mode printed every number its header promised.
 *   1   a refusal: `MeasurementError` from the metrics module, or an
 *       `InstrumentError` from this one (bad input, missing key, no DSN, git
 *       unavailable). The reason and every line of `detail` go to stderr.
 *   2   usage: unknown subcommand, unknown flag, missing or conflicting input.
 *
 * There is no path on which this script prints a table and exits 0 without
 * having computed every number its mode's header promised.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MeasurementError,
  computeSchedule,
  inputCensus,
  roundSummary,
  roundTable,
  type InputCensus,
  type MetricInput,
  type MetricRun,
  type MetricTask,
  type ScheduleMetrics,
} from "../forge-control/src/lib/schedule-metrics.ts";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/**
 * The sentence `rounds` mode prints in its own header. A CONSTANT, not a string
 * assembled at the call site: the whole point of the two-mode split is that the
 * disclaimer cannot drift away from the mode that owes it, and a literal built
 * where it is printed is a literal someone edits in one of two places.
 */
const ROUNDS_MODE_DISCLAIMER =
  "S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.";

/**
 * What a bare-array fixture's rows carry instead of a project id: nothing. The
 * capture format is six keys and `project_id` is not one of them, so this
 * placeholder is printed in the header and is the only thing the header can
 * honestly say. It never reaches arithmetic — `full` mode refuses a bare array
 * before `computeSchedule()` is called, and `assertIdentifiedProject()` refuses
 * it a second time on the way in.
 */
const UNIDENTIFIED_PROJECT = "(none — a bare-array fixture declares no project_id)";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/* -------------------------------------------------------------------------- *
 * Failure carriers
 * -------------------------------------------------------------------------- */

/**
 * This wrapper's own refusal, shaped like `MeasurementError` so the top-level
 * handler prints both identically. Its reasons: `fixture-unreadable`,
 * `fixture-not-json`, `fixture-shape`, `fixture-has-no-runs`, `bad-row`,
 * `bad-window`, `project-id-mismatch`, `unidentified-project`, `self-unreadable`,
 * `git-unavailable`.
 */
class InstrumentError extends Error {
  readonly reason: string;
  readonly detail: string[];

  constructor(reason: string, detail: string[]) {
    super(`measure-schedule: ${reason} — ${detail.join("; ")}`);
    this.name = "InstrumentError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** A bad command line. Printed with usage, exits 2. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/* -------------------------------------------------------------------------- *
 * Output discipline — R60's ordering, enforced rather than intended
 * -------------------------------------------------------------------------- */

let headerEmitted = false;

/**
 * The only way a number leaves this process, and the structural guarantee
 * behind R60's "first output line". `out()` throws if the header has not been
 * printed, so a future edit that prints a table before the identity block dies
 * on its first line instead of shipping a headerless measurement. `printHeader()`
 * is the sole writer that bypasses it, and it is what sets the flag.
 */
function out(line: string): void {
  if (!headerEmitted) {
    throw new Error(
      "measure-schedule: refused to print output before the R60 identity header. " +
        "The header is computed at run time and printed first, in every mode, on every run.",
    );
  }
  process.stdout.write(`${line}\n`);
}

/* -------------------------------------------------------------------------- *
 * Command line
 * -------------------------------------------------------------------------- */

type Mode = "full" | "rounds";

interface Args {
  mode: Mode;
  fixture: string | null;
  project: string | null;
  from: string | null;
  to: string | null;
}

const USAGE = `usage: measure-schedule.ts <full|rounds> (--fixture <path> | --project <uuid>) [--from <iso>] [--to <iso>]

  full     round table, run count, mean duration, wall clock, per-minute
           concurrency, S1, S2, S3. Requires run data. Exits non-zero if it
           cannot compute all of it. NEVER degrades to 'rounds'.
  rounds   the round/task table and tasks-per-round only. Reads no run data
           and claims no concurrency result.

  --fixture <path>  a JSON file: a bare array of task rows, or an object
                    { project_id, tasks: [...], runs: [...] }. No database is
                    opened in this mode.
  --project <uuid>  the live database, via DATABASE_URL.
  --from <iso>      inclusive lower bound on project_tasks.created_at.
  --to <iso>        inclusive upper bound on project_tasks.created_at.

  With no subcommand the mode is 'full'.`;

function parseArgs(argv: string[]): Args {
  let mode: Mode = "full";
  let cursor = 0;

  if (argv.length > 0 && !argv[0].startsWith("--")) {
    const word = argv[0];
    if (word !== "full" && word !== "rounds") {
      throw new UsageError(`unknown subcommand '${word}' — the modes are 'full' and 'rounds'`);
    }
    mode = word;
    cursor = 1;
  }

  const args: Args = { mode, fixture: null, project: null, from: null, to: null };

  while (cursor < argv.length) {
    const flag = argv[cursor];
    const value = argv[cursor + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    switch (flag) {
      case "--fixture":
        args.fixture = value;
        break;
      case "--project":
        args.project = value;
        break;
      case "--from":
        args.from = value;
        break;
      case "--to":
        args.to = value;
        break;
      default:
        throw new UsageError(`unknown flag '${flag}'`);
    }
    cursor += 2;
  }

  if (args.fixture === null && args.project === null) {
    throw new UsageError("one of --fixture or --project is required");
  }
  if (args.fixture !== null && args.project !== null) {
    throw new UsageError("--fixture and --project are mutually exclusive");
  }
  return args;
}

/* -------------------------------------------------------------------------- *
 * The window
 * -------------------------------------------------------------------------- */

interface Window {
  fromMs: number | null;
  toMs: number | null;
  label: string;
}

function buildWindow(from: string | null, to: string | null): Window {
  const fromMs = from === null ? null : parseBound(from, "--from");
  const toMs = to === null ? null : parseBound(to, "--to");
  if (fromMs !== null && toMs !== null && toMs < fromMs) {
    throw new InstrumentError("bad-window", [`--to ${to} precedes --from ${from}`]);
  }
  if (fromMs === null && toMs === null) {
    return { fromMs, toMs, label: "full project (no --from/--to given)" };
  }
  const lower = from === null ? "(open)" : from;
  const upper = to === null ? "(open)" : to;
  return { fromMs, toMs, label: `${lower} .. ${upper} (inclusive, on project_tasks.created_at)` };
}

function parseBound(value: string, flag: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new InstrumentError("bad-window", [`${flag} is "${value}", which Date.parse cannot read`]);
  }
  return ms;
}

function windowIsOpen(window: Window): boolean {
  return window.fromMs === null && window.toMs === null;
}

/** Inclusive at both ends — a human-stated interval, not a half-open one. */
function withinWindow(task: MetricTask, window: Window): boolean {
  const ms = Date.parse(task.created_at);
  if (Number.isNaN(ms)) {
    throw new InstrumentError("bad-row", [
      `task ${task.id}.created_at is "${task.created_at}", which Date.parse cannot read`,
    ]);
  }
  if (window.fromMs !== null && ms < window.fromMs) return false;
  if (window.toMs !== null && ms > window.toMs) return false;
  return true;
}

/**
 * The run set that belongs to a windowed task set: the runs those tasks name,
 * plus those runs' sub-agent children (kept so `inputCensus()` can still
 * disclose the sub-agent count that D1 excludes — a disclosure silently
 * emptied by a filter is worse than no disclosure). Applied ONLY when a window
 * flag was given; see WINDOW SEMANTICS in the file header for what it costs.
 */
function narrowRunsToTasks(tasks: MetricTask[], runs: MetricRun[]): MetricRun[] {
  const named = new Set<string>();
  for (const task of tasks) {
    if (typeof task.run_id === "string") named.add(task.run_id);
  }
  return runs.filter((run) => named.has(run.id) || (run.parent_run_id !== null && named.has(run.parent_run_id)));
}

/* -------------------------------------------------------------------------- *
 * Input
 * -------------------------------------------------------------------------- */

interface LoadedInput {
  project_id: string;
  tasks: MetricTask[];
  /**
   * `null` means the input DECLARED NO RUNS — a bare-array fixture. It does not
   * mean "zero runs"; an object fixture with `runs: []` is an empty array here
   * and is a different fact. `full` mode refuses the `null` case by name.
   */
  runs: MetricRun[] | null;
  /** How many rows carried a `depends_on` key at all — R60's schema fact. */
  rowsWithDependsOnKey: number;
  /** The schema evidence printed in the header, in the words of its own source. */
  schemaEvidence: string;
  sourceLabel: string;
}

async function loadInput(args: Args, window: Window): Promise<LoadedInput> {
  if (args.fixture !== null) return readFixture(args.fixture, window);
  if (args.project !== null) return readFromDatabase(args.project, window);
  // parseArgs() has already refused the empty case; this is the type narrowing.
  throw new UsageError("one of --fixture or --project is required");
}

/* ---- fixture ------------------------------------------------------------- */

function readFixture(path: string, window: Window): LoadedInput {
  const absolute = resolve(process.cwd(), path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (err) {
    // Rethrown with the path attached. The underlying error message alone names
    // errno and not what the instrument was trying to do.
    throw new InstrumentError("fixture-unreadable", [`${absolute}: ${messageOf(err)}`]);
  }

  const fixtureSha = createHash("sha256").update(bytes).digest("hex");

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new InstrumentError("fixture-not-json", [`${absolute}: ${messageOf(err)}`]);
  }

  const sourceLabel = `fixture:${path} sha256=${fixtureSha}`;

  if (Array.isArray(parsed)) {
    const { tasks, withKey } = parseTaskRows(parsed, null, absolute);
    return {
      project_id: UNIDENTIFIED_PROJECT,
      tasks: applyWindow(tasks, window),
      runs: null,
      rowsWithDependsOnKey: withKey,
      schemaEvidence: `${withKey}/${tasks.length} fixture rows carry a depends_on key`,
      sourceLabel,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new InstrumentError("fixture-shape", [
      `${absolute} parsed to ${describe(parsed)}; expected an array of task rows or an object with { project_id, tasks, runs }`,
    ]);
  }

  const envelope: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const projectId = asString(requireKey(envelope, "project_id", absolute), `${absolute}.project_id`);
  const rawTasks = requireKey(envelope, "tasks", absolute);
  if (!Array.isArray(rawTasks)) {
    throw new InstrumentError("fixture-shape", [`${absolute}.tasks is ${describe(rawTasks)}, not an array`]);
  }
  const { tasks, withKey } = parseTaskRows(rawTasks, projectId, absolute);
  const windowed = applyWindow(tasks, window);

  // The `runs` key is optional in the SHAPE and mandatory for `full` mode. Its
  // absence is recorded here and refused by name in runMeasurement(), so the
  // operator is told which key was missing rather than which number was.
  const rawRuns = "runs" in envelope ? envelope.runs : undefined;
  let runs: MetricRun[] | null;
  if (rawRuns === undefined) {
    runs = null;
  } else if (Array.isArray(rawRuns)) {
    runs = rawRuns.map((row, i) => parseRunRow(row, i, absolute));
  } else {
    throw new InstrumentError("fixture-shape", [`${absolute}.runs is ${describe(rawRuns)}, not an array`]);
  }

  if (runs !== null && !windowIsOpen(window)) runs = narrowRunsToTasks(windowed, runs);

  return {
    project_id: projectId,
    tasks: windowed,
    runs,
    rowsWithDependsOnKey: withKey,
    schemaEvidence: `${withKey}/${tasks.length} fixture rows carry a depends_on key`,
    sourceLabel,
  };
}

function applyWindow(tasks: MetricTask[], window: Window): MetricTask[] {
  if (windowIsOpen(window)) return tasks;
  return tasks.filter((task) => withinWindow(task, window));
}

function parseTaskRows(
  rows: unknown[],
  envelopeProjectId: string | null,
  source: string,
): { tasks: MetricTask[]; withKey: number } {
  const tasks: MetricTask[] = [];
  let withKey = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const { task, hasDependsOnKey } = parseTaskRow(rows[i], i, envelopeProjectId, source);
    if (hasDependsOnKey) withKey += 1;
    tasks.push(task);
  }
  return { tasks, withKey };
}

function parseTaskRow(
  value: unknown,
  index: number,
  envelopeProjectId: string | null,
  source: string,
): { task: MetricTask; hasDependsOnKey: boolean } {
  const where = `${source}.tasks[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InstrumentError("bad-row", [`${where} is ${describe(value)}, not an object`]);
  }
  const row: Record<string, unknown> = { ...(value as Record<string, unknown>) };

  const declaredProjectId = "project_id" in row ? asString(row.project_id, `${where}.project_id`) : null;
  if (declaredProjectId !== null && envelopeProjectId !== null && declaredProjectId !== envelopeProjectId) {
    throw new InstrumentError("project-id-mismatch", [
      `${where}.project_id is ${declaredProjectId}, but the fixture envelope declares ${envelopeProjectId}`,
    ]);
  }
  const projectId = declaredProjectId ?? envelopeProjectId ?? UNIDENTIFIED_PROJECT;

  const hasDependsOnKey = "depends_on" in row;
  const task: MetricTask = {
    id: asString(requireKey(row, "id", where), `${where}.id`),
    project_id: projectId,
    round: asNumber(requireKey(row, "round", where), `${where}.round`),
    role: asString(requireKey(row, "role", where), `${where}.role`),
    title: asString(requireKey(row, "title", where), `${where}.title`),
    status: asString(requireKey(row, "status", where), `${where}.status`),
    created_at: asString(requireKey(row, "created_at", where), `${where}.created_at`),
  };
  if ("run_id" in row) task.run_id = asStringOrNull(row.run_id, `${where}.run_id`);
  if (hasDependsOnKey) task.depends_on = asStringArrayOrNull(row.depends_on, `${where}.depends_on`);
  return { task, hasDependsOnKey };
}

function parseRunRow(value: unknown, index: number, source: string): MetricRun {
  const where = `${source}.runs[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InstrumentError("bad-row", [`${where} is ${describe(value)}, not an object`]);
  }
  const row: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const run: MetricRun = {
    id: asString(requireKey(row, "id", where), `${where}.id`),
    parent_run_id: asStringOrNull(requireKey(row, "parent_run_id", where), `${where}.parent_run_id`),
    status: asString(requireKey(row, "status", where), `${where}.status`),
    created_at: asString(requireKey(row, "created_at", where), `${where}.created_at`),
    started_at: asStringOrNull(requireKey(row, "started_at", where), `${where}.started_at`),
    completed_at: asStringOrNull(requireKey(row, "completed_at", where), `${where}.completed_at`),
    updated_at: asString(requireKey(row, "updated_at", where), `${where}.updated_at`),
  };
  if ("archived" in row) run.archived = asBoolean(row.archived, `${where}.archived`);
  if ("wake_after" in row) run.wake_after = asStringOrNull(row.wake_after, `${where}.wake_after`);
  return run;
}

/* ---- database ------------------------------------------------------------ */

/**
 * The live read. NOT EXERCISED IN PHASE 7 — written, typechecked, and left
 * unrun, because `03-quality.md` §2.3 gives live verification to phase 8 alone.
 *
 * Every line that touches `pg` lives in `forge-control/src/lib/schedule-source.ts`
 * and this is the ONLY place that reaches it, through a dynamic `await import()`
 * on the `--project` branch of `loadInput()`. Fixture mode therefore never
 * resolves that module, never resolves `pg`, and cannot construct a Pool even by
 * accident — which is what keeps the instrument runnable from a build task under
 * the worktree-only policy.
 *
 * The reader lives over there rather than here for a reason that was measured
 * rather than assumed: `scripts/` has no `node_modules` and neither does the
 * repo root, so a bare `pg` specifier in a root-level script fails to resolve at
 * run time (`ERR_MODULE_NOT_FOUND`) and at compile time (TS2307). See that
 * file's header.
 */
async function readFromDatabase(projectId: string, window: Window): Promise<LoadedInput> {
  const source = await import("../forge-control/src/lib/schedule-source.ts");
  const rows = await source.readProjectRows(projectId);
  const windowed = applyWindow(rows.tasks, window);

  return {
    project_id: projectId,
    tasks: windowed,
    runs: windowIsOpen(window) ? rows.runs : narrowRunsToTasks(windowed, rows.runs),
    rowsWithDependsOnKey: rows.hasDependsOnColumn ? rows.tasks.length : 0,
    schemaEvidence: rows.hasDependsOnColumn
      ? "information_schema.columns names project_tasks.depends_on"
      : "information_schema.columns has no project_tasks.depends_on — pre-0040 schema",
    sourceLabel: `db:${projectId}`,
  };
}

/* -------------------------------------------------------------------------- *
 * R60 — the identity header
 * -------------------------------------------------------------------------- */

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SELF_PATH));

interface SelfIdentity {
  path: string;
  sha256: string;
  gitHead: string;
  dirty: boolean;
}

/**
 * The instrument hashing the bytes that are executing. Read off disk through
 * `import.meta.url`, at startup, every run — never a constant, never a value
 * carried in from a build step, never a git object id standing in for a file.
 */
function selfIdentity(): SelfIdentity {
  let bytes: Buffer;
  try {
    bytes = readFileSync(SELF_PATH);
  } catch (err) {
    throw new InstrumentError("self-unreadable", [
      `cannot read ${SELF_PATH} to hash it: ${messageOf(err)}`,
      "R60's identity is a hash of the executing file; without it there is no measurement to report.",
    ]);
  }
  return {
    path: relative(REPO_ROOT, SELF_PATH),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitHead: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]).length > 0,
  };
}

/**
 * `git` with a refusal attached. An absent or failing git is an `InstrumentError`,
 * not an "unknown" printed in the header: a provenance field that degrades to a
 * placeholder is the identity failure R60 exists to prevent.
 */
function git(argv: string[]): string {
  try {
    return execFileSync("git", argv, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch (err) {
    throw new InstrumentError("git-unavailable", [
      `git ${argv.join(" ")} failed in ${REPO_ROOT}: ${messageOf(err)}`,
    ]);
  }
}

function printHeader(
  self: SelfIdentity,
  mode: Mode,
  input: LoadedInput,
  window: Window,
  census: InputCensus,
): void {
  const lines = [
    "== measure-schedule — instrument identity (R60) ==",
    `instrument-sha256: ${self.sha256}`,
    `                   sha256 of ${self.path}, hashed from disk at startup — THIS names the bytes that ran.`,
    `git-head:          ${self.gitHead}${self.dirty ? " -dirty" : ""}`,
    "                   names the working TREE at run time, NOT the bytes that ran; committing this file moves",
    "                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.",
    `mode:              ${mode}`,
    `source:            ${input.sourceLabel}`,
    `project:           ${input.project_id}`,
    `depends_on:        ${input.rowsWithDependsOnKey > 0 ? "present" : "absent"} (${input.schemaEvidence})`,
    `window:            ${window.label}`,
    `census:            ${renderCensus(census, input.runs !== null)}`,
  ];
  if (mode === "rounds") lines.push(`disclaimer:        ${ROUNDS_MODE_DISCLAIMER}`);
  if (input.runs !== null && !windowIsOpen(window)) {
    lines.push(
      "note:              a window is in force, so the run set was narrowed to the runs the retained tasks name",
      "                   (plus their sub-agents). An earlier run of a retried task is therefore not counted.",
    );
  }
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
  headerEmitted = true;
}

/**
 * `inputCensus()` counts nine things and five of them are answers about runs.
 * In `rounds` mode the runs were never read, so those five print as `not-read`
 * rather than as a number — `runs=0` would be a claim about run data this mode
 * is defined not to make. The four printed in both modes (`tasks`,
 * `legacy-rows`, `graph-rows`, `closure-shaped-rows`) are the four derived from
 * task rows alone.
 *
 * `closure-shaped-rows` joined the header in round 215 because round 214's
 * phase-7 finding 1 was exactly that no header field disclosed a dependency set
 * written by migration 0040's backfill rather than by a planner. It prints in
 * BOTH modes for the same reason `legacy-rows` does: it is a property of the
 * task rows, and `rounds` mode is the mode a reader runs first.
 */
function renderCensus(census: InputCensus, runsRead: boolean): string {
  if (!runsRead) {
    return (
      `tasks=${census.tasks} legacy-rows=${census.legacyRows} graph-rows=${census.graphRows} ` +
      `closure-shaped-rows=${census.closureShapedRows} ` +
      "runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read"
    );
  }
  return (
    `tasks=${census.tasks} runs=${census.runs} top-level=${census.topLevelRuns} ` +
    `sub-agent=${census.subagentRuns} archived=${census.archivedRuns} ` +
    `tasks-without-run=${census.tasksWithoutRun} legacy-rows=${census.legacyRows} ` +
    `graph-rows=${census.graphRows} closure-shaped-rows=${census.closureShapedRows}`
  );
}

/* -------------------------------------------------------------------------- *
 * The two modes
 * -------------------------------------------------------------------------- */

function printRoundTable(tasks: MetricTask[]): void {
  const table = roundTable(tasks);
  const summary = roundSummary(tasks);
  out("-- round / task table (00-vision.md §2) --");
  out("  round   tasks");
  for (const row of table) {
    out(`  ${String(row.round).padStart(5)}   ${String(row.tasks).padStart(5)}`);
  }
  out(`  ${summary.rounds} rounds, ${summary.tasks} tasks, ${summary.tasksPerRound} tasks per round`);
}

function printFull(metrics: ScheduleMetrics): void {
  out("");
  out("-- run and wall-clock totals --");
  out(`  runs measured (top-level, in scope)   ${metrics.runCount}`);
  out(`  mean run duration (min)               ${metrics.meanRunMinutes}`);
  out(`  summed run time (min)                 ${metrics.sumRunMinutes}`);
  out(`  wall clock (min)                      ${metrics.wallClockMinutes}`);
  out("");
  out("-- S1 / S2 / S3 (00-vision.md §4) --");
  out(
    `  S1 mean concurrency                   ${metrics.meanConcurrency} ` +
      `(peak ${metrics.peakConcurrency}, over ${metrics.concurrencySamples.length} per-minute samples)`,
  );
  out(`  S2 parallelism ratio                  ${metrics.parallelismRatio} (wall clock ÷ summed run time; lower is more parallel)`);
  const stall = metrics.numberingStall;
  if (stall.computable) {
    out(`  S3 max numbering stall (min)          ${stall.maxMinutes} (over ${stall.perTask.length} tasks with a recorded dependency set)`);
  } else {
    // BOTH counts, always. The two D7 arms are distinguished by which of them
    // is non-zero — `legacy rows` is the pre-migration NULL sentinel, `closure-
    // shaped rows` is what migration 0040 turns those same rows into — and a
    // line printing only the first read `0 legacy rows` for the post-migration
    // refusal, which is the sentence a reader would have called a bug.
    out(
      `  S3 max numbering stall (min)          NOT COMPUTABLE ` +
        `(${stall.legacyRows} legacy rows, ${stall.closureRows} closure-shaped rows)`,
    );
    out(`     reason: ${stall.reason}`);
  }
  out("");
  out("-- disclosures (schedule-metrics.ts D1, D2, D4, D5) --");
  out(`  sub-agent runs, EXCLUDED              ${metrics.excluded.subagentRuns}`);
  out(`  archived top-level runs, INCLUDED     ${metrics.excluded.archivedRuns}`);
  out(`  runs never started (no started_at)    ${metrics.excluded.neverStartedRuns}`);
  out(`  runs started and never terminated     ${metrics.excluded.unterminatedRunIds.length}`);
  out("");
  out("-- per-minute concurrency (every sample, uncapped) --");
  for (const sample of metrics.concurrencySamples) {
    out(`  ${sample.minute}  ${sample.live}`);
  }
  if (stall.computable) {
    out("");
    out("-- per-task numbering stall (min) --");
    for (const entry of stall.perTask) out(`  ${entry.task_id}  ${entry.minutes}`);
  }
}

/* -------------------------------------------------------------------------- *
 * main
 * -------------------------------------------------------------------------- */

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const window = buildWindow(args.from, args.to);

  // Identity FIRST, from the bytes on disk, before anything is read or printed.
  const self = selfIdentity();
  const input = await loadInput(args, window);

  // The census is computed over whatever was loaded and never throws (its own
  // contract), so the header prints even for a project computeSchedule() will
  // refuse. `runs: []` here is not a claim: in `rounds` mode renderCensus()
  // prints every run-derived field as `not-read`.
  const census = inputCensus({ project_id: input.project_id, tasks: input.tasks, runs: input.runs ?? [] });
  printHeader(self, args.mode, input, window, census);

  if (args.mode === "rounds") {
    printRoundTable(input.tasks);
    return;
  }

  // `full` from here down. There is no branch back to `rounds`.
  if (input.runs === null) {
    throw new InstrumentError("fixture-has-no-runs", [
      `${input.sourceLabel} declares no 'runs' key, so it is a task-only fixture`,
      "full mode needs run rows for the run count, mean duration, wall clock, S1 and S2, and it does not " +
        "print a smaller table instead (R61). Ask for the round table by name: 'rounds --fixture <path>'.",
      "For the 8ea0cc08 baseline this is the finding, not a defect: the phase-1 capture carries six keys per " +
        "row and no run_id, so S1, S2, mean duration and wall clock are not computable from this worktree. " +
        "Completing that baseline needs a live read, which belongs to phase 8.",
    ]);
  }
  assertIdentifiedProject(input);

  const measured: MetricInput = {
    project_id: input.project_id,
    tasks: input.tasks,
    runs: input.runs,
  };
  // COMPUTE, THEN PRINT — in that order, and the order is the R61 contract at
  // this level. Printing the round table first would mean a `full` run that
  // refuses still emits the table `rounds` mode emits, i.e. `full` degrading to
  // `rounds` and announcing the degradation only in its exit status. Nothing
  // below the header is written unless every number exists.
  const metrics = computeSchedule(measured);
  printRoundTable(input.tasks);
  printFull(metrics);
}

/**
 * A measurement attributed to no project is not a measurement (R60 names the
 * project id as a header field). Unreachable from the fixture paths as written —
 * a bare array is refused one line above for having no runs, and the object form
 * requires `project_id` — and asserted anyway, because "unreachable" is a claim
 * about today's control flow.
 */
function assertIdentifiedProject(input: LoadedInput): void {
  if (input.project_id === UNIDENTIFIED_PROJECT) {
    throw new InstrumentError("unidentified-project", [
      `${input.sourceLabel} declares no project_id, and full mode will not attribute S1/S2/S3 to an unnamed project`,
    ]);
  }
}

/* -------------------------------------------------------------------------- *
 * Field narrowing — explicit, and loud about what it found instead
 * -------------------------------------------------------------------------- */

function requireKey(row: Record<string, unknown>, key: string, where: string): unknown {
  if (!(key in row)) {
    throw new InstrumentError("bad-row", [`${where} has no '${key}'`]);
  }
  return row[key];
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new InstrumentError("bad-row", [`${where} is ${describe(value)}, expected a string`]);
  }
  return value;
}

function asStringOrNull(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, where);
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InstrumentError("bad-row", [`${where} is ${describe(value)}, expected a finite number`]);
  }
  return value;
}

function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new InstrumentError("bad-row", [`${where} is ${describe(value)}, expected a boolean`]);
  }
  return value;
}

function asStringArrayOrNull(value: unknown, where: string): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new InstrumentError("bad-row", [`${where} is ${describe(value)}, expected an array or null`]);
  }
  return value.map((entry, i) => asString(entry, `${where}[${i}]`));
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a ${typeof value}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A refusal: an `Error` carrying `reason: string` and `detail: string[]`. */
interface Refusal {
  reason: string;
  detail: string[];
}

/**
 * Recognises `MeasurementError`, `InstrumentError` and
 * `ScheduleSourceError` — three classes, one shape — so all three print
 * identically.
 *
 * STRUCTURAL RATHER THAN `instanceof`, and the reason is the whole isolation
 * argument of this file: `instanceof ScheduleSourceError` would require a static
 * import of `schedule-source.ts`, which statically imports `pg`, which would put
 * a database driver in the module graph of every fixture-mode run. A three-field
 * shape test costs nothing and keeps the dynamic import the only door.
 *
 * It narrows rather than casts: an `Error` without both fields returns null and
 * falls through to the generic branch, which prints the message and the stack.
 * Nothing is swallowed on either path — both exit non-zero.
 */
function asRefusal(err: unknown): Refusal | null {
  if (!(err instanceof Error)) return null;
  const reason: unknown = Reflect.get(err, "reason");
  const detail: unknown = Reflect.get(err, "detail");
  if (typeof reason !== "string") return null;
  if (!Array.isArray(detail)) return null;
  const lines: string[] = [];
  for (const entry of detail) {
    if (typeof entry !== "string") return null;
    lines.push(entry);
  }
  return { reason, detail: lines };
}

/* -------------------------------------------------------------------------- *
 * Exit codes — the only catch in this file
 * -------------------------------------------------------------------------- */

/**
 * `main().catch()` rather than a top-level `await` in a try: this file sits at
 * the repo root, which has no `package.json`, so tsx transforms it as CJS and
 * top-level await is a hard transform error there. The success path deliberately
 * does NOT call `process.exit()` — `process.stdout` is asynchronous on a pipe,
 * and exiting on top of a several-hundred-line concurrency table truncates it.
 * Exit 0 happens by the event loop draining, which flushes.
 */
main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`measure-schedule: ${err.message}\n\n${USAGE}\n`);
    process.exit(EXIT_USAGE);
  }
  const refusal = asRefusal(err);
  if (refusal !== null) {
    process.stderr.write(`MEASUREMENT FAILED: ${refusal.reason}\n`);
    for (const line of refusal.detail) process.stderr.write(`  - ${line}\n`);
    process.exit(EXIT_FAILED);
  }
  process.stderr.write(`MEASUREMENT FAILED: ${err instanceof Error ? err.name : "throw"}\n`);
  process.stderr.write(`  - ${messageOf(err)}\n`);
  if (err instanceof Error && typeof err.stack === "string") process.stderr.write(`${err.stack}\n`);
  process.exit(EXIT_FAILED);
});
