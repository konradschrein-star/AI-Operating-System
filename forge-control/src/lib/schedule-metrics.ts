/**
 * schedule-metrics.ts — the pure arithmetic behind the project engine's
 * measurement instrument (R59, R61, and the input side of R60).
 *
 * This module answers one question: *did the scheduler actually get faster?*
 * `00-vision.md` §4 names the three numbers that decide it — S1 (mean
 * concurrent live runs), S2 (wall clock ÷ summed run time), and S3 (the longest
 * stall attributable to numbering). Everything here computes those from rows,
 * and nothing here fetches a row.
 *
 * THE SPLIT. This file is PURE: no `pg`, no `fs`, no `process`, no `Date.now()`,
 * no network. Every input arrives as an argument and every output is a value.
 * The I/O half is `scripts/measure-schedule.ts`, which queries, prints the R60
 * header, and maps a `MeasurementError` to a non-zero exit. It is the same
 * split `project-reconcile.ts` / `project-tick.ts` already uses, for the same
 * reason: the decisions become testable without a database (`03-quality.md`
 * NF3 — the unit suite is hermetic and runs with Postgres stopped).
 *
 * The `import type` below is deliberate and load-bearing. A value import of
 * `db/projects.ts` or `db/runs.ts` opens a pg Pool in the test process.
 *
 * -------------------------------------------------------------------------
 * THE SEVEN SEMANTIC DECISIONS
 * -------------------------------------------------------------------------
 * Each is implemented below beside a doc-comment restating it and its reason.
 * They are decided in the phase-7a brief; they are recorded here because the
 * next reader of this file is the person tempted to change one.
 *
 *   D1  Sub-agent runs are excluded from every number.       → `scopeRuns()`
 *   D2  Archived runs are included, and disclosed.           → `scopeRuns()`
 *   D3  A run's interval is [started_at, completed_at).      → `runIntervals()`
 *   D4  `wake_after` needs no filter.                        → `runIntervals()`
 *   D5  A still-running run is an error, not an estimate.    → `runIntervals()`
 *   D6  The R61 exit conditions.                             → `MeasurementError`
 *   D7  S3 comes from `depends_on` and from nothing else.    → `numberingStall()`
 *
 * -------------------------------------------------------------------------
 * NO SILENT FALLBACKS (`03-quality.md` §3.1 item 6)
 * -------------------------------------------------------------------------
 * This module contains zero `catch` blocks, zero `??` operators and zero `||`
 * value fallbacks. Optional fields are normalised through named predicates
 * (`runIdOf`, `isLegacyRow`) that state the missing case explicitly rather than
 * defaulting it. Every condition this module cannot compute through is a
 * `MeasurementError`, never a smaller, prettier number. That is R61.
 */

import type { TaskStatus } from "../db/projects.ts";
import type { RunStatus } from "../db/runs.ts";

/**
 * `"pending"` pinned to the database's own union. D6's `unresolvable-run` rule
 * turns on this exact literal, so a rename in `db/projects.ts` must break this
 * build rather than quietly reclassify every task as an error.
 */
const PENDING_TASK: TaskStatus = "pending";

/**
 * Documentation by type: `MetricRun.status` carries these values. This module
 * NEVER branches on run status — that is D4's whole point — but the alias is
 * exported so `scripts/measure-schedule.ts` can type its query rows against the
 * same union instead of a bare `string`.
 */
export type MetricRunStatus = RunStatus;

const MINUTE_MS = 60_000;

/**
 * Refuse a measurement window longer than 90 days. The per-minute sampler is a
 * loop over the span; one corrupt `started_at` in 1970 would otherwise spin it
 * ~29 million times and hang the instrument instead of failing it. A refusal
 * with a reason beats a hang, and 90 days is far beyond any real project
 * (the motivating one ran 255 minutes — `00-vision.md` §2).
 */
const MAX_SPAN_MINUTES = 90 * 24 * 60;

/* -------------------------------------------------------------------------- *
 * The row shapes the instrument consumes
 * -------------------------------------------------------------------------- */

/**
 * One `project_tasks` row, narrowed to the fields a measurement needs.
 *
 * `role`, `status` and `created_at` are typed `string` rather than the db
 * unions on purpose: `scripts/measure-schedule.ts` may read a project written
 * before a role existed, and this module has no business rejecting a row for
 * carrying a value it does not itself interpret.
 *
 * `depends_on` is OPTIONAL as well as nullable, and the two mean different
 * things to the caller but the same thing here (see `isLegacyRow`): `null` is
 * the legacy sentinel written by migration 0040's backfill
 * (`02-architecture.md` §3.2), and `undefined` is what a pre-0040 schema hands
 * back because the column does not exist. Both mean "the real dependency set of
 * this row was never recorded".
 */
export interface MetricTask {
  id: string;
  project_id: string;
  round: number;
  role: string;
  title: string;
  status: string;
  created_at: string;
  run_id?: string | null;
  depends_on?: string[] | null;
}

/**
 * One `runs` row, narrowed to the fields a measurement needs. Column set and
 * nullability from migrations 0021 (`started_at`, `completed_at`), 0031
 * (`archived`) and 0036 (`wake_after`) — see `docs/research/round-100-e7548096.md` §1.
 */
export interface MetricRun {
  id: string;
  parent_run_id: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  archived?: boolean;
  wake_after?: string | null;
}

/** Everything one measurement is computed from. No other input exists. */
export interface MetricInput {
  project_id: string;
  tasks: MetricTask[];
  runs: MetricRun[];
}

/** Options for `computeSchedule`. See D5 for `allowUnterminated`. */
export interface ScheduleOptions {
  /**
   * D5's escape hatch. When `true`, runs that started and never terminated are
   * EXCLUDED from durations and concurrency and their ids are returned in
   * `excluded.unterminatedRunIds` instead of throwing. The default is `false`
   * and `scripts/measure-schedule.ts` does not pass it: a measurement of a
   * fleet still in flight is a measurement of an unfinished thing, and R61 says
   * say so rather than print a smaller table.
   *
   * The flag does NOT launder S3. If an unterminated run is the dependency
   * whose completion another task's stall is measured against, `numberingStall`
   * still throws `missing-timestamp` — there is no honest stall arithmetic
   * against a dependency that has not finished.
   */
  allowUnterminated?: boolean;
}

/* -------------------------------------------------------------------------- *
 * D6 — the failure carrier
 * -------------------------------------------------------------------------- */

/**
 * R61's carrier: the instrument fails loudly. Thrown, never swallowed;
 * `scripts/measure-schedule.ts` catches it at the top level exactly once, to
 * print `reason` and `detail` and exit non-zero.
 *
 * The `reason` strings, and what each one means:
 *
 *   "unresolvable-run"   D6 — a task whose `run_id` names a row absent from
 *                        `runs`, or a non-`pending` task with no `run_id` at
 *                        all. `detail` names the task ids (and the missing run
 *                        ids where there are any).
 *   "missing-timestamp"  D6 — a timestamp that fails `Date.parse`, thrown by
 *                        `parseInstant()`; and the DEPENDENCY case in
 *                        `numberingStall()`, where a task's dependency has a
 *                        run with no `completed_at`, so there is no instant to
 *                        measure a stall against. CORRECTED round 215 (round
 *                        214's phase-7 finding 3): this entry used to claim it
 *                        also covered "a run in scope that started and never
 *                        terminated (D5)". It does not, and never did — that
 *                        case throws `"unterminated-run"`, below. A list whose
 *                        whole point is to declare rather than smuggle cannot
 *                        also misattribute; a reader chasing an
 *                        `unterminated-run` through this block found nothing,
 *                        and a reader reading this block expected the wrong
 *                        string.
 *   "too-few-tasks"      D6 — fewer than five tasks. There is no schedule to
 *                        measure in four rows.
 *
 * FOUR FURTHER REASONS, DECLARED RATHER THAN SMUGGLED. D6 names three
 * conditions; the arithmetic below reaches four more states in which it cannot
 * produce an honest number. Each is a REFUSAL, in R61's direction — none of
 * them invents a value, and none of them is reachable by widening D6's three:
 *
 *   "unterminated-run"   D5 — a run in scope with a `started_at` and no
 *                        `completed_at`, thrown by `runIntervals()` unless
 *                        `allowUnterminated` is set, in which case the run is
 *                        dropped and its id disclosed in
 *                        `excluded.unterminatedRunIds`. DECLARED HERE from
 *                        round 215; it was thrown, and named in
 *                        `01-requirements.md`, but this enumeration omitted it.
 *                        An interval with no end has no duration, and the two
 *                        alternatives — treating the run as instantaneous, or
 *                        ending it at the window's edge — both shorten summed
 *                        run time and so flatter S2.
 *
 *   "inverted-interval"  A run whose `completed_at` precedes its `started_at`.
 *                        Neither timestamp is missing and neither fails to
 *                        parse, so D6's "missing-timestamp" would be a lie
 *                        about the cause. The alternative — a negative duration
 *                        silently shortening the summed run time — flatters S2,
 *                        which is precisely the direction a measurement must
 *                        never fail in.
 *   "no-measurable-runs" Every task resolved, yet not one run in scope produced
 *                        a non-zero interval. Mean, wall clock and S2's
 *                        denominator are all undefined here; returning zeroes
 *                        would report a perfectly parallel project.
 *   "span-too-long"      The measurement window exceeds `MAX_SPAN_MINUTES`.
 *                        See that constant.
 */
export class MeasurementError extends Error {
  readonly reason: string;
  readonly detail: string[];

  constructor(reason: string, detail: string[]) {
    super(`schedule-metrics: ${reason} — ${detail.join("; ")}`);
    this.name = "MeasurementError";
    this.reason = reason;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- *
 * R60 — the row counts the header prints
 * -------------------------------------------------------------------------- */

export interface InputCensus {
  tasks: number;
  runs: number;
  topLevelRuns: number;
  subagentRuns: number;
  archivedRuns: number;
  tasksWithoutRun: number;
  legacyRows: number;
  graphRows: number;
  /**
   * Rows whose `depends_on` equals the strictly-lower-round closure — migration
   * 0040's backfill signature. See `isClosureShaped()`. A DISCLOSURE, not an
   * exclusion: when it equals `tasks` and any edge exists, S3 refuses; when it
   * is merely non-zero the measurement proceeds and this count is what tells a
   * reader that part of the graph is tautological.
   */
  closureShapedRows: number;
}

/**
 * The row counts R60 requires in the instrument's first output line, before any
 * number: "a measurement whose provenance is not printed is not a measurement".
 *
 * THIS FUNCTION NEVER THROWS, and that is a requirement rather than a
 * convenience. R60 wants the header printed BEFORE any number and R61 wants a
 * broken project to exit non-zero with its reason — which is only possible in
 * that order if the census can be computed for a project `computeSchedule()`
 * will refuse. So the census counts and classifies; it never parses a timestamp
 * and never resolves a join it could fail.
 *
 * `subagentRuns` is D1's disclosure: the exclusion is visible in the header, so
 * a reader can see what was left out rather than trusting that something was.
 * `archivedRuns` is D2's: those rows ARE counted in every metric, and the count
 * is printed so a reader can subtract them.
 *
 * `tasksWithoutRun` counts tasks for which no run row can be resolved at all —
 * `run_id` absent, or `run_id` present but naming a row not in `runs`. Under
 * D6 the second case is fatal to `computeSchedule()`; here it is merely
 * counted, because the header must survive the project that fails.
 *
 * `legacyRows` + `graphRows` === `tasks`, always. `legacyRows` is what D7's
 * FIRST arm reads to decide S3 is not computable, and printing it in the header
 * is what stops a reader mistaking "not computable" for "nothing to report".
 *
 * `closureShapedRows` is D7's SECOND arm, and it is a header field because
 * round 214's finding 1 was, precisely, that NO header field disclosed that a
 * project's dependency sets came from migration 0040's backfill rather than
 * from a planner. It is NOT a subset of `legacyRows` — it is what those rows
 * become once the backfill has overwritten their NULL, which is exactly when
 * `legacyRows` drops to 0 and stops disclosing anything.
 */
export function inputCensus(input: MetricInput): InputCensus {
  const runIds = new Set(input.runs.map((r) => r.id));

  let topLevelRuns = 0;
  let subagentRuns = 0;
  let archivedRuns = 0;
  for (const run of input.runs) {
    if (run.parent_run_id === null) topLevelRuns += 1;
    else subagentRuns += 1;
    if (run.archived === true) archivedRuns += 1;
  }

  let tasksWithoutRun = 0;
  let legacyRows = 0;
  let graphRows = 0;
  let closureShapedRows = 0;
  for (const task of input.tasks) {
    const runId = runIdOf(task);
    if (runId === null || !runIds.has(runId)) tasksWithoutRun += 1;
    if (isLegacyRow(task)) legacyRows += 1;
    else graphRows += 1;
    // Set comparison per row, O(tasks²) overall. On the corpus this reads (131
    // rows) that is 17k comparisons; the census runs once. Not worth an index,
    // and an index would be a second place for the definition to drift from
    // `isClosureShaped()`, which is the one the refusal reads.
    if (isClosureShaped(task, input.tasks)) closureShapedRows += 1;
  }

  return {
    tasks: input.tasks.length,
    runs: input.runs.length,
    topLevelRuns,
    subagentRuns,
    archivedRuns,
    tasksWithoutRun,
    legacyRows,
    graphRows,
    closureShapedRows,
  };
}

/* -------------------------------------------------------------------------- *
 * The round/task table — `00-vision.md` §2
 * -------------------------------------------------------------------------- */

export interface RoundTableRow {
  round: number;
  tasks: number;
}

export interface RoundSummary {
  rounds: number;
  tasks: number;
  tasksPerRound: number;
}

/**
 * The round/task distribution of `00-vision.md` §2, ascending by round.
 *
 * Requires NO run data at all, which is why it is a separate export: the table
 * is the shape of the *numbering*, and it is readable for a project whose runs
 * are unmeasurable. Under the new engine `round` is a DERIVED depth rather than
 * a hand-written integer, so this table changes meaning between the before and
 * the after — `docs/plan/engine-task-graph/04-phases.md` Phase 7 requires the
 * baseline to say so, since S1 and S2 come from run timestamps and are
 * unaffected by any renumbering of this column.
 */
export function roundTable(tasks: MetricTask[]): RoundTableRow[] {
  const counts = new Map<number, number>();
  for (const task of tasks) {
    const seen = counts.get(task.round);
    if (seen === undefined) counts.set(task.round, 1);
    else counts.set(task.round, seen + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, count]) => ({ round, tasks: count }));
}

/**
 * "12 rounds, 21 tasks, average 1.75 tasks per round" — the one-line form of
 * the table above, and the sentence `00-vision.md` §2 builds its whole argument
 * on.
 *
 * Throws `too-few-tasks` on an empty list rather than returning a zero average.
 * There is no average over no rounds, and `0` would read as "perfectly serial"
 * to anyone comparing a before and an after.
 */
export function roundSummary(tasks: MetricTask[]): RoundSummary {
  if (tasks.length === 0) {
    throw new MeasurementError("too-few-tasks", [
      "roundSummary: 0 tasks — there is no round distribution to summarise",
    ]);
  }
  const table = roundTable(tasks);
  return {
    rounds: table.length,
    tasks: tasks.length,
    tasksPerRound: round2(tasks.length / table.length),
  };
}

/* -------------------------------------------------------------------------- *
 * S1, S2, S3
 * -------------------------------------------------------------------------- */

export interface ConcurrencySample {
  /** ISO-8601 instant of the sample, on a minute boundary. */
  minute: string;
  /** Runs whose [started_at, completed_at) interval contains this instant. */
  live: number;
}

/**
 * S3's result. The `computable: false` arm is D7 and is the most important
 * value this module can return — see `numberingStall()`.
 */
export type NumberingStall =
  | { computable: true; maxMinutes: number; perTask: { task_id: string; minutes: number }[] }
  | { computable: false; reason: string; legacyRows: number; closureRows: number };

export interface ScheduleMetrics {
  runCount: number;
  meanRunMinutes: number;
  sumRunMinutes: number;
  wallClockMinutes: number;
  concurrencySamples: ConcurrencySample[];
  /** S1 — mean concurrent live runs, sampled per minute. */
  meanConcurrency: number;
  peakConcurrency: number;
  /** S2 — wall clock ÷ summed run time. Lower is more parallel. */
  parallelismRatio: number;
  /** S3 — the longest stall attributable to numbering, or a refusal. */
  numberingStall: NumberingStall;
  excluded: {
    /** D1 — sub-agent runs, excluded from every number above. */
    subagentRuns: number;
    /**
     * D2 — archived TOP-LEVEL runs, which are INCLUDED in every number above.
     * The field lives under `excluded` because the contract puts it there; the
     * count is a DISCLOSURE, not an exclusion, so a reader who wants the
     * non-archived view can subtract it. Naming it here and saying this is
     * cheaper than a reader assuming either way.
     */
    archivedRuns: number;
    /** D5 — runs that started and never terminated, dropped only under `allowUnterminated`. */
    unterminatedRunIds: string[];
    /**
     * D4's disclosure: top-level runs in scope that were never claimed, so
     * `started_at` is null. A run parked behind `wake_after` lands here. It
     * contributes nothing to duration or concurrency, and the count says so
     * out loud rather than letting the reader wonder where it went.
     */
    neverStartedRuns: number;
  };
}

/** A resolved, parsed run interval in epoch milliseconds. Half-open — see D3. */
interface RunInterval {
  run_id: string;
  start: number;
  end: number;
}

/**
 * The measurement. Throws `MeasurementError`; never returns a partial.
 *
 * Order of operations is deliberate and is the R61 contract: every refusal is
 * decided before any number is computed, so there is no state in which this
 * function has produced half a `ScheduleMetrics` and then failed.
 */
export function computeSchedule(
  input: MetricInput,
  options: ScheduleOptions = {},
): ScheduleMetrics {
  const allowUnterminated = options.allowUnterminated === true;

  // D6 — too-few-tasks. Checked first because it is the cheapest refusal and
  // because a truncated fixture is the case `03-quality.md` §3.2's phase-7 gate
  // has the reviewer run.
  if (input.tasks.length < 5) {
    throw new MeasurementError("too-few-tasks", [
      `project ${input.project_id} has ${input.tasks.length} tasks, fewer than the 5 R61 requires`,
    ]);
  }

  const runsById = new Map<string, MetricRun>();
  for (const run of input.runs) runsById.set(run.id, run);

  // D6 — unresolvable-run.
  assertRunsResolvable(input, runsById);

  const scoped = scopeRuns(input.runs);
  const { intervals, unterminatedRunIds, neverStartedRuns } = runIntervals(
    scoped,
    allowUnterminated,
  );

  if (intervals.length === 0) {
    throw new MeasurementError("no-measurable-runs", [
      `project ${input.project_id}: ${scoped.length} top-level runs in scope, none of which produced a measurable interval`,
    ]);
  }

  const sumMs = intervals.reduce((acc, iv) => acc + (iv.end - iv.start), 0);
  if (sumMs === 0) {
    throw new MeasurementError("no-measurable-runs", [
      `project ${input.project_id}: ${intervals.length} runs in scope, every one of zero duration — S2 has no denominator`,
    ]);
  }

  const minStart = Math.min(...intervals.map((iv) => iv.start));
  const maxEnd = Math.max(...intervals.map((iv) => iv.end));
  const wallClockMs = maxEnd - minStart;

  const concurrencySamples = sampleConcurrency(intervals, minStart, maxEnd);
  const liveTotal = concurrencySamples.reduce((acc, s) => acc + s.live, 0);
  const peakConcurrency = concurrencySamples.reduce(
    (acc, s) => (s.live > acc ? s.live : acc),
    0,
  );

  return {
    runCount: intervals.length,
    meanRunMinutes: round2(sumMs / intervals.length / MINUTE_MS),
    sumRunMinutes: round2(sumMs / MINUTE_MS),
    wallClockMinutes: round2(wallClockMs / MINUTE_MS),
    concurrencySamples,
    meanConcurrency: round2(liveTotal / concurrencySamples.length),
    peakConcurrency,
    parallelismRatio: round2(wallClockMs / sumMs),
    numberingStall: numberingStall(input, runsById),
    excluded: {
      subagentRuns: input.runs.length - scoped.length,
      archivedRuns: scoped.filter((r) => r.archived === true).length,
      unterminatedRunIds,
      neverStartedRuns,
    },
  };
}

/* -------------------------------------------------------------------------- *
 * D1 / D2 — what is in scope
 * -------------------------------------------------------------------------- */

/**
 * D1 — SUB-AGENT RUNS ARE EXCLUDED from every number.
 *
 * When an agent spawns a sub-agent, a `runs` row is inserted carrying the
 * parent's id in `parent_run_id`. Counting those inflates concurrency by
 * however many tools an agent happened to fan out with, which measures the
 * agent's internal shape rather than the scheduler's — and the scheduler is the
 * thing this project changed. `docs/research/round-100-e7548096.md` §6a names
 * it as the first way a naive concurrency count goes wrong.
 *
 * PRECEDENT: `listManagerRollup()` in `db/projects.ts` already filters
 * `AND parent_run_id IS NULL` for exactly this reason, so this module and the
 * manager rollup count the same population.
 *
 * D2 — ARCHIVED RUNS ARE INCLUDED. Archiving a chat cancels its non-terminal
 * runs, so `archived` marks work deliberately closed, not work that never
 * happened. We are measuring WHAT THE FLEET ATTEMPTED, not what the UI
 * currently shows, and an attempt that was later archived still occupied a
 * worker and still consumed wall clock. The scout (§6d) asked for the choice to
 * be declared rather than defaulted; this is the declaration, and the count
 * rides back in `ScheduleMetrics.excluded.archivedRuns` so a reader who wants
 * the other view can subtract it.
 *
 * Runs are scoped by `parent_run_id` alone, NOT by "is some task pointing at
 * it". A retried task's earlier runs are top-level, really ran, and really
 * consumed wall clock, but `project_tasks.run_id` names only the most recent
 * one. Dropping them would shorten the summed run time and flatter S2.
 */
function scopeRuns(runs: MetricRun[]): MetricRun[] {
  return runs.filter((r) => r.parent_run_id === null);
}

/* -------------------------------------------------------------------------- *
 * D3 / D4 / D5 — intervals
 * -------------------------------------------------------------------------- */

/**
 * D3 — A RUN'S INTERVAL IS [started_at, completed_at). Not `created_at`, which
 * is when the row was queued and would count queue time as work; not
 * `updated_at`, which is refreshed on every status poll and would count a run's
 * whole life up to its last heartbeat. `started_at` is written exactly once, on
 * first claim, by `claimNextRun()` in `executor.ts`
 * (`started_at = COALESCE(r.started_at, now())`), and the scout established in
 * §4 that it is the ONLY writer and therefore the only honest start proxy.
 * The interval is half-open so two back-to-back runs, one ending exactly as the
 * next begins, read as concurrency 1 rather than 2.
 *
 * A run with `started_at === null` never ran: it contributes no interval, and
 * is disclosed as `excluded.neverStartedRuns`.
 *
 * D4 — `wake_after` NEEDS NO FILTER, and here is why. The scout warned (§6b)
 * that counting `status IN ('queued','running')` inflates concurrency with runs
 * parked behind `wake_after` after a usage wall. That warning is aimed at a
 * measurement that counts by STATUS. This one counts by INTERVAL OVERLAP, and a
 * parked run has by definition not been claimed — so `claimNextRun()` has never
 * fired for it, `started_at` is null, and it is already outside every interval
 * this module builds. The filter would be dead code. Note also that this module
 * never reads `MetricRun.status` at all, which is the same fact stated from the
 * other side. The argument is asserted rather than trusted: see the D4 case in
 * `schedule-metrics.test.ts`.
 *
 * D5 — A STUCK OR STILL-RUNNING RUN IS AN R61 CONDITION, NOT AN ESTIMATE. The
 * scout (§6c) offered three ways to guess an end time for a run that started
 * and never terminated: now, `last_heartbeat_at`, or ignore it. Guessing is
 * exactly what R61 forbids — each of the three moves S2 in a different
 * direction and none of them is the truth. So the default throws, naming the
 * run ids, and `allowUnterminated` is the caller's explicit, recorded decision
 * to drop them instead.
 */
function runIntervals(
  scoped: MetricRun[],
  allowUnterminated: boolean,
): { intervals: RunInterval[]; unterminatedRunIds: string[]; neverStartedRuns: number } {
  const intervals: RunInterval[] = [];
  const unterminatedRunIds: string[] = [];
  const inverted: string[] = [];
  let neverStartedRuns = 0;

  for (const run of scoped) {
    if (run.started_at === null) {
      neverStartedRuns += 1;
      continue;
    }
    const start = parseInstant(run.started_at, `run ${run.id}.started_at`);
    if (run.completed_at === null) {
      unterminatedRunIds.push(run.id);
      continue;
    }
    const end = parseInstant(run.completed_at, `run ${run.id}.completed_at`);
    if (end < start) {
      inverted.push(
        `run ${run.id}: completed_at ${run.completed_at} precedes started_at ${run.started_at}`,
      );
      continue;
    }
    intervals.push({ run_id: run.id, start, end });
  }

  if (inverted.length > 0) throw new MeasurementError("inverted-interval", inverted);

  if (unterminatedRunIds.length > 0 && !allowUnterminated) {
    throw new MeasurementError(
      "unterminated-run",
      unterminatedRunIds.map(
        (id) => `run ${id} has started_at but no completed_at — it is still running or stuck`,
      ),
    );
  }

  return { intervals, unterminatedRunIds, neverStartedRuns };
}

/**
 * S1's raw material: one sample per minute, each counting the runs whose
 * half-open interval contains that instant.
 *
 * The sample grid starts at the minute containing the earliest start and steps
 * to — but does not include — `maxEnd`. Sampling the final boundary would
 * always score zero under a half-open interval and would drag S1 down by one
 * sample's worth on every project, which is a bias, not a measurement.
 *
 * Every sample is returned, uncapped and untruncated. A caller that wants a
 * summary can take one; a module that silently dropped samples would be
 * reporting a mean over a window it did not disclose.
 */
function sampleConcurrency(
  intervals: RunInterval[],
  minStart: number,
  maxEnd: number,
): ConcurrencySample[] {
  const spanMinutes = Math.ceil((maxEnd - minStart) / MINUTE_MS);
  if (spanMinutes > MAX_SPAN_MINUTES) {
    throw new MeasurementError("span-too-long", [
      `measurement window is ${spanMinutes} minutes, beyond the ${MAX_SPAN_MINUTES}-minute ceiling`,
      `earliest start ${new Date(minStart).toISOString()}, latest completion ${new Date(maxEnd).toISOString()}`,
    ]);
  }

  const samples: ConcurrencySample[] = [];
  const first = Math.floor(minStart / MINUTE_MS) * MINUTE_MS;
  for (let t = first; t < maxEnd; t += MINUTE_MS) {
    let live = 0;
    for (const iv of intervals) {
      if (iv.start <= t && t < iv.end) live += 1;
    }
    samples.push({ minute: new Date(t).toISOString(), live });
  }
  return samples;
}

/* -------------------------------------------------------------------------- *
 * D6 — run resolution
 * -------------------------------------------------------------------------- */

/**
 * D6's `unresolvable-run` condition: a task whose `run_id` names a row absent
 * from `runs`, or a non-`pending` task carrying no `run_id` at all.
 *
 * The second clause deserves its reason written down, because it is the one a
 * future reader will want to soften. `ready` is a real transient state — the
 * scheduler has promoted the row and `spawnTaskRuns()` has not yet created its
 * run — so a `ready` row with `run_id` null is not corruption. It is, however,
 * a project caught MID-FLIGHT, and a measurement of an unfinished schedule is
 * not the thing R59 asks for. Refusing is the whole of R61: exit non-zero with
 * the reason rather than print a smaller, prettier table over whatever happened
 * to have finished. `scripts/measure-schedule.ts` therefore measures a quiet
 * project, and a noisy one tells the operator so by name.
 */
function assertRunsResolvable(input: MetricInput, runsById: Map<string, MetricRun>): void {
  const detail: string[] = [];
  for (const task of input.tasks) {
    const runId = runIdOf(task);
    if (runId === null) {
      if (task.status !== PENDING_TASK) {
        detail.push(
          `task ${task.id} (status ${task.status}, round ${task.round}) has no run_id, and only a '${PENDING_TASK}' task may have none`,
        );
      }
      continue;
    }
    if (!runsById.has(runId)) {
      detail.push(`task ${task.id} names run ${runId}, which is absent from the run set`);
    }
  }
  if (detail.length > 0) throw new MeasurementError("unresolvable-run", detail);
}

/* -------------------------------------------------------------------------- *
 * D7 — S3, the numbering stall
 * -------------------------------------------------------------------------- */

/**
 * S3 — THE LONGEST STALL ATTRIBUTABLE TO NUMBERING, and the decision that
 * matters most in this module.
 *
 * For a task with a recorded dependency set, the stall is the gap between the
 * moment its last dependency finished and the moment its own run was claimed:
 *
 *     stallMinutes = max(0, start(task) − max(completed_at of its depends_on))
 *
 * S3 is the maximum over every such task. Under the new engine it is ~0 by
 * construction — a task promotes when its dependencies are `done`, not when a
 * round drains — and REPORTING it is what proves the cause was removed rather
 * than merely diluted (`00-vision.md` §4, S3). A number near zero is the claim;
 * printing it is the evidence.
 *
 * THE LEGACY ARM, AND WHY IT REFUSES TO RETURN A NUMBER.
 *
 * If ANY task in the project carries `depends_on === null` — the migration-0040
 * sentinel (`02-architecture.md` §3.2) — this function returns
 * `{ computable: false }`. The sentinel means the row was never graph-scheduled,
 * and the reason that is fatal to S3 rather than merely inconvenient is that a
 * legacy row's REAL dependency set was never recorded anywhere. The `round`
 * integer conflated three unrelated things — ordering, file contention and
 * narrative phase — and no column says which of the three put a given task
 * where it sits. There is nothing to subtract from.
 *
 * DO NOT SUBSTITUTE THE BACKFILLED CLOSURE. The obvious repair is to use
 * migration 0040's backfill — "every task in a strictly lower round" — as the
 * dependency set for legacy rows. It is wrong, and it is wrong in the most
 * expensive possible direction. Under that substitution a legacy task is by
 * definition not ready until its entire lower round has drained, so
 * `max(completed_at of dependencies)` is the moment the round drained, which is
 * the moment the task was promoted. The stall computes to exactly 0. The
 * instrument would report NO NUMBERING STALL for precisely the project whose
 * numbering stall is this project's entire justification — the 32-minute
 * reviewer that held seven unrelated builders (`00-vision.md` §2).
 *
 * That is the instrument-lie failure of standing rule 3 (`00-vision.md` §7):
 * the measuring equipment reporting a pass because it was pointed at its own
 * assumption. Refusing to compute is the correct answer, and it is the answer a
 * future reader will be tempted to "fix". Do not fix it. Give the project real
 * `depends_on` rows and it computes.
 *
 * A dependency that cannot be resolved to a completed run is an error, not a
 * skipped term: a stall measured against a subset of a task's dependencies is
 * smaller than the truth, and smaller is the flattering direction.
 *
 * KNOWN LIMIT, STATED RATHER THAN PAPERED OVER: a task that has not yet started
 * contributes no term, because its stall is "how long it has been waiting so
 * far" and that requires a `Date.now()` this pure module does not have. On a
 * finished project — the only kind `assertRunsResolvable` lets through — there
 * are no such tasks with runs outstanding. On a project measured mid-flight the
 * refusal fires first.
 */
function numberingStall(input: MetricInput, runsById: Map<string, MetricRun>): NumberingStall {
  const legacyRows = input.tasks.filter(isLegacyRow).length;
  if (legacyRows > 0) {
    return {
      computable: false,
      reason:
        `${legacyRows} of ${input.tasks.length} tasks carry depends_on = NULL, the pre-0040 sentinel. ` +
        "Their real dependency set was never recorded — the round integer conflated ordering, file " +
        "contention and narrative phase, and no column says which. Substituting the backfilled " +
        "closure would make every legacy stall compute to exactly 0, i.e. the instrument would " +
        "report no numbering stall for the project whose numbering stall motivated this work.",
      legacyRows,
      closureRows: input.tasks.filter((t) => isClosureShaped(t, input.tasks)).length,
    };
  }

  /* D7's SECOND ARM — the sentinel above no longer exists once migration 0040
   * has backfilled, so the refusal has to be able to read the SHAPE. See
   * `isClosureShaped()` for the full argument and for the measured transcript
   * of this module certifying "no numbering stall" for the exact project that
   * motivated the work.
   *
   * `hasEdge` BUYS A CORRECT REASON, not a different verdict, and the
   * distinction is worth stating because a reader will check. A project whose
   * tasks are ALL roots satisfies the closure test vacuously for every row —
   * the strictly-lower-round set is empty and so is every declared set — and
   * that project is PERFECT FAN-OUT, the single best result this instrument can
   * be handed. S3 is still not computable for it, but for the reason the
   * `perTask.length === 0` arm below already gives: there is no edge to measure
   * a stall across. Without this guard that project would be told its
   * dependency sets came from a migration backfill, which is false. */
  const closureRows = input.tasks.filter((t) => isClosureShaped(t, input.tasks)).length;
  const hasEdge = input.tasks.some((t) => {
    const deps = t.depends_on;
    return deps !== null && deps !== undefined && deps.length > 0;
  });
  if (hasEdge && closureRows === input.tasks.length) {
    return {
      computable: false,
      reason:
        `all ${closureRows} tasks carry a depends_on equal to the set of tasks at a strictly lower ` +
        "round — byte for byte what migration 0040's R6 backfill writes over the pre-0040 NULL " +
        "sentinel. Under that shape every dependency completes exactly when the task's round " +
        "drains, which is exactly when the old engine promoted it, so every stall computes to 0 " +
        "and S3 would certify 'no numbering stall' for a project that may have stalled for hours. " +
        "This is a SIGNATURE, not a proof: a strictly serial graph-scheduled project produces the " +
        "same shape, and for it the honest cost of this refusal is a true 0. Measure a project " +
        "with real fan-out, or read the baseline BEFORE applying 0040 (04-phases.md §12, E-3).",
      legacyRows,
      closureRows,
    };
  }

  const tasksById = new Map<string, MetricTask>();
  for (const task of input.tasks) tasksById.set(task.id, task);

  const perTask: { task_id: string; minutes: number }[] = [];
  const unresolvable: string[] = [];
  const missing: string[] = [];

  for (const task of input.tasks) {
    const deps = task.depends_on;
    // `isLegacyRow` already returned above for null/undefined; this narrows for
    // the type checker and is unreachable at runtime.
    if (deps === null || deps === undefined || deps.length === 0) continue;

    const start = claimedAt(task, runsById);
    if (start === null) continue; // never started — see KNOWN LIMIT above.

    let lastDepEnd = Number.NEGATIVE_INFINITY;
    for (const depId of deps) {
      const dep = tasksById.get(depId);
      if (dep === undefined) {
        unresolvable.push(
          `task ${task.id} depends on ${depId}, which is not a task of project ${input.project_id}`,
        );
        continue;
      }
      const depRunId = runIdOf(dep);
      if (depRunId === null) {
        unresolvable.push(
          `task ${task.id} depends on ${dep.id}, which has no run — its completion time is unknown`,
        );
        continue;
      }
      const depRun = runsById.get(depRunId);
      if (depRun === undefined) {
        unresolvable.push(
          `task ${task.id} depends on ${dep.id}, whose run ${depRunId} is absent from the run set`,
        );
        continue;
      }
      if (depRun.completed_at === null) {
        missing.push(
          `task ${task.id} depends on ${dep.id}, whose run ${depRun.id} has no completed_at — a stall cannot be measured against an unfinished dependency`,
        );
        continue;
      }
      const depEnd = parseInstant(depRun.completed_at, `run ${depRun.id}.completed_at`);
      if (depEnd > lastDepEnd) lastDepEnd = depEnd;
    }

    if (lastDepEnd === Number.NEGATIVE_INFINITY) continue;

    // Clamped at 0: a task whose run was claimed BEFORE its last dependency
    // finished is not evidence of a negative stall, and letting it through
    // would let one such row cancel out a real stall elsewhere in the max.
    const gapMinutes = (start - lastDepEnd) / MINUTE_MS;
    perTask.push({ task_id: task.id, minutes: round2(gapMinutes > 0 ? gapMinutes : 0) });
  }

  if (unresolvable.length > 0) throw new MeasurementError("unresolvable-run", unresolvable);
  if (missing.length > 0) throw new MeasurementError("missing-timestamp", missing);

  if (perTask.length === 0) {
    return {
      computable: false,
      reason:
        "no task in this project has both a non-empty depends_on and a run that was claimed, " +
        "so there is no edge to measure a stall across. Reporting 0 here would read as " +
        "'no numbering stall' when the truth is 'no measurement'.",
      legacyRows: 0,
      closureRows,
    };
  }

  return {
    computable: true,
    maxMinutes: perTask.reduce((acc, t) => (t.minutes > acc ? t.minutes : acc), 0),
    perTask,
  };
}

/* -------------------------------------------------------------------------- *
 * Small shared helpers
 * -------------------------------------------------------------------------- */

/**
 * The legacy sentinel test. `null` is migration 0040's backfill sentinel;
 * `undefined` is a pre-0040 schema with no such column. Both mean "the real
 * dependency set of this row was never recorded", and D7 refuses on both. An
 * empty ARRAY is neither: it is an explicit graph root.
 *
 * IT ONLY ANSWERS FOR A ROW THE MIGRATION HAS NOT REACHED. Once 0040's backfill
 * has run, the sentinel is GONE — see `isClosureShaped()`, which is the other
 * half of D7 and the half that survives the migration.
 */
function isLegacyRow(task: MetricTask): boolean {
  return task.depends_on === null || task.depends_on === undefined;
}

/**
 * D7's SECOND arm, added round 215 for round 214's phase-7 finding 1 (attack
 * A3, which succeeded through the database rather than through the code).
 *
 * THE HOLE THIS CLOSES. `isLegacyRow()` keys on `depends_on IS NULL`. Migration
 * `0040_task_graph.sql`'s final statement — the R6 backfill — WRITES OVER that
 * exact sentinel on every pre-existing row, with "every task in a strictly
 * lower round". After it runs, a legacy project's rows are indistinguishable
 * from graph rows by nullity, `isLegacyRow()` answers false for all of them,
 * and the arithmetic below happily produces a number. That number is 0, always,
 * for the tautological reason the doc-block on `numberingStall()` sets out at
 * length: under the closure a task's dependencies all complete exactly when its
 * round drains, which is exactly when the old engine promoted it.
 *
 * MEASURED, round 214: fed the literal motivating case — one 32-minute
 * reviewer, seven unrelated builders numbered above it, `depends_on` backfilled
 * as 0040 writes it — the module printed `S3 max numbering stall (min) 0 (over
 * 7 tasks with a recorded dependency set)`, `legacy-rows=0`, and exited 0. It
 * certified "no numbering stall" for the project whose numbering stall is this
 * project's entire justification.
 *
 * E-3 pins phase 8's baseline read to run BEFORE the migration, and that
 * sequencing is real. It is not enough. Correctness that rests on the order two
 * steps of a deploy happen to be executed in is correctness that a tired
 * operator can delete by running step 3 first, with no error and no disclosure.
 * This function is the belt: the instrument refuses on the SHAPE of the data,
 * whatever order anything ran in.
 *
 * WHAT IT TESTS, exactly: is this row's `depends_on` equal, AS A SET, to the ids
 * of every task of the project at a strictly lower `round`? That is the
 * backfill's WHERE clause transcribed. Duplicates in a stored array collapse
 * into the set and are forgiven, because a duplicate is R14's problem and not a
 * reason to answer a different question here.
 *
 * IT IS A SIGNATURE, NOT A PROOF, and pretending otherwise would be the same
 * species of overclaim this arm exists to stop. A genuinely graph-scheduled
 * project CAN produce these bytes — a strictly serial one where every task
 * really does depend on everything before it. For such a project the refusal
 * costs a true 0. That trade is one-sided and deliberately so: reporting 0
 * wrongly is a certified lie about the number this whole project is judged on,
 * while refusing wrongly is a visible "NOT COMPUTABLE" that names its own
 * reason and points at the fix. DoD-6's after-measurement wants a project with
 * real fan-out, whose research tasks share no files and no ordering; a
 * closure-shaped one would mean the fan-out never happened, which is itself the
 * finding.
 *
 * A PROJECT WHOSE EVERY TASK IS A ROOT SATISFIES THIS VACUOUSLY. With every
 * task at one round and `depends_on = []`, the strictly-lower-round set is
 * empty and so is every declared set, so this answers `true` for every row —
 * and that project is perfect fan-out, not a backfill. `numberingStall()`'s
 * `hasEdge` guard is what keeps the backfill REASON off it; being stated
 * precisely, S3 is not computable for that project either, but for the honest
 * reason that there is no edge to measure a stall across, which is the refusal
 * that was already there. The guard buys a correct explanation, not a different
 * verdict, and a comment claiming more would be the overclaim this arm exists
 * to stop.
 */
function isClosureShaped(task: MetricTask, tasks: readonly MetricTask[]): boolean {
  const deps = task.depends_on;
  if (deps === null || deps === undefined) return false; // the OTHER arm's case.
  const declared = new Set(deps);
  let closureSize = 0;
  for (const other of tasks) {
    if (other.round >= task.round) continue;
    closureSize += 1;
    if (!declared.has(other.id)) return false;
  }
  return declared.size === closureSize;
}

/** `run_id` normalised to `string | null`. Written out rather than `??` so the
 *  silent-fallback audit of `03-quality.md` §3.1 item 6 has nothing to find. */
function runIdOf(task: MetricTask): string | null {
  if (task.run_id === undefined || task.run_id === null) return null;
  return task.run_id;
}

/** Epoch ms of a task's run claim (D3), or `null` if it was never claimed. */
function claimedAt(task: MetricTask, runsById: Map<string, MetricRun>): number | null {
  const runId = runIdOf(task);
  if (runId === null) return null;
  const run = runsById.get(runId);
  if (run === undefined) return null;
  if (run.started_at === null) return null;
  return parseInstant(run.started_at, `run ${run.id}.started_at`);
}

/**
 * `Date.parse` with D6's `missing-timestamp` refusal attached. Deliberately not
 * wrapped in a try/catch: `Date.parse` signals failure with `NaN`, and a `NaN`
 * flowing into an arithmetic mean is exactly the quiet corruption R61 exists to
 * prevent.
 */
function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new MeasurementError("missing-timestamp", [
      `${label} is "${value}", which Date.parse cannot read`,
    ]);
  }
  return ms;
}

/** Two decimals, applied only at the boundary — every comparison above is made
 *  on unrounded milliseconds. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
