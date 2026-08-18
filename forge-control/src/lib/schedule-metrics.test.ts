/**
 * Unit proof for `schedule-metrics.ts` — the pure half of the measurement
 * instrument (R59, R61, and the input side of R60).
 *
 * Run: pnpm test   (node:test via tsx, no test framework dependency)
 *
 * Scope: everything phase 7a owns. `scripts/measure-schedule.ts` (the I/O
 * wrapper, phase 7b) and the committed 8ea0cc08 baseline (R62, phase 7c) are
 * other builders' files and are not exercised here.
 *
 * NF3: `db/*` is imported TYPE-ONLY by the module under test, and this file
 * imports no database module at all. There is no fixture on disk — every row
 * below is hand-built by `mt()` / `mr()` — so the suite runs with Postgres
 * stopped, which is the only reason these decisions are testable at all.
 *
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY (standing rule 3,
 * `00-vision.md` §7):
 *
 *  1. A concurrency assertion computed the same wrong way twice — the test
 *     deriving its expectation from the same overlap arithmetic the module
 *     uses, so a sign error or an off-by-one in the half-open interval agrees
 *     with itself and reports green. GUARDED: the two concurrency cases assert
 *     the ENTIRE `concurrencySamples` array as a hand-written literal, minute
 *     by minute, derived on paper from the run boundaries in the fixture. No
 *     helper, no loop, no expression over the same inputs. The literals are
 *     restated in comments as the count that produced them.
 *  2. `assert.throws(fn, /^schedule-metrics:/)`. Node matches a bare RegExp
 *     against the error's STRING REPRESENTATION ("MeasurementError:
 *     schedule-metrics: …"), not against `.message`, so a `^`-anchored pattern
 *     never matches and every such case reports "did not throw" while the throw
 *     was correct — the failure round 103 hit across ten exports of
 *     `task-graph.ts`. GUARDED: `expectMeasurementError()` below catches the
 *     value itself, asserts it `instanceof MeasurementError`, and asserts on
 *     `.reason` and `.detail` as data. It never pattern-matches a stringified
 *     error, and it fails loudly when nothing was thrown at all.
 *  3. An R61 case that throws for the wrong reason and still counts as a pass —
 *     e.g. the `unterminated-run` fixture also having four tasks, so the
 *     `too-few-tasks` guard fires first and the D5 refusal is never exercised.
 *     GUARDED: `expectMeasurementError` asserts the EXACT `reason` string, and
 *     every R61 fixture is built on a five-task base that is proved to compute
 *     cleanly in the concurrency cases above it.
 *  4. A D7 legacy case that passes because the graph arm was never reached.
 *     GUARDED: the same fixture is asserted twice — once with real `depends_on`
 *     arrays, where it returns `computable: true` with a hand-computed 20
 *     minutes, and once with a single row switched to the NULL sentinel, where
 *     it must refuse. One row is the whole difference between the two.
 *
 * The one `try/catch` in this file lives in `expectMeasurementError` and is
 * disclosed here for the silent-fallback audit (`03-quality.md` §3.1 item 6):
 * it does not swallow anything. It re-asserts on the caught value and calls
 * `assert.fail` when nothing was thrown. The module under test contains no
 * `catch`, no `??` and no `||` fallback at all.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
// Section 11 reads the module's own TEXT to check its declared-refusal list
// against the reasons it can actually throw — a doc-comment is not reachable
// any other way. One file read, no database: NF3 is untouched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  computeSchedule,
  excludeNeverRanTasks,
  inputCensus,
  roundSummary,
  roundTable,
  MeasurementError,
  type MetricInput,
  type MetricRun,
  type MetricTask,
} from "./schedule-metrics.ts";
// Section 7c feeds rows through the REAL narrowing phase 8's live read uses,
// rather than hand-building the pre-0040 shape it is asserting about. `taskRow`
// is pure and builds no pool — the pool lives inside `readProjectRows()`, and
// NF3 forbids a test that opens a connection.
import { taskRow } from "./schedule-source.ts";

/* -------------------------------------------------------------------------- *
 * Fixtures — hand-built rows, no database, no fixture file
 * -------------------------------------------------------------------------- */

const PROJECT = "8ea0cc08-0000-0000-0000-000000000000";

/** An instant on 2026-08-16, the day of the measurement in `00-vision.md` §2. */
function at(hhmm: string): string {
  return `2026-08-16T${hhmm}:00.000Z`;
}

/**
 * One task row. The default is a `pending` graph root with no run — the one
 * shape D6 lets through without a run — so filler rows that only exist to clear
 * R61's five-task floor state nothing they are not about.
 */
function mt(id: string, over: Partial<MetricTask> = {}): MetricTask {
  return {
    id,
    project_id: PROJECT,
    round: 1,
    role: "builder",
    title: `task ${id}`,
    status: "pending",
    created_at: at("09:00"),
    run_id: null,
    depends_on: [],
    ...over,
  };
}

/** One run row. The default is a top-level run that never started. */
function mr(id: string, over: Partial<MetricRun> = {}): MetricRun {
  return {
    id,
    parent_run_id: null,
    status: "completed",
    created_at: at("09:00"),
    started_at: null,
    completed_at: null,
    updated_at: at("09:00"),
    archived: false,
    wake_after: null,
    ...over,
  };
}

/** A done task wired to a run that ran from `from` to `to`. */
function ran(id: string, from: string, to: string, over: Partial<MetricTask> = {}) {
  return {
    task: mt(id, { status: "done", run_id: `run-${id}`, ...over }),
    run: mr(`run-${id}`, { started_at: at(from), completed_at: at(to) }),
  };
}

/** `n` pending, run-less filler tasks — R61's five-task floor, nothing more. */
function filler(n: number): MetricTask[] {
  return Array.from({ length: n }, (_unused, i) => mt(`filler-${i}`, { round: 9 }));
}

function input(tasks: MetricTask[], runs: MetricRun[]): MetricInput {
  return { project_id: PROJECT, tasks, runs };
}

/**
 * Assert that `fn` throws a `MeasurementError` with exactly `reason`, whose
 * `detail` names each needle. Asserts on the error VALUE, never on a
 * stringified form — see instrument-lie 2 in the module doc-comment above.
 */
function expectMeasurementError(
  fn: () => unknown,
  reason: string,
  needles: string[],
): MeasurementError {
  let caught: unknown = undefined;
  let threw = false;
  try {
    fn();
  } catch (err) {
    caught = err;
    threw = true;
  }
  if (!threw) assert.fail(`expected MeasurementError "${reason}", but nothing was thrown`);
  if (!(caught instanceof MeasurementError)) {
    assert.fail(`expected MeasurementError, got ${String(caught)}`);
  }
  assert.equal(caught.reason, reason);
  for (const needle of needles) {
    assert.ok(
      caught.detail.some((line) => line.includes(needle)),
      `no detail line names "${needle}"; detail was ${JSON.stringify(caught.detail)}`,
    );
  }
  return caught;
}

/* -------------------------------------------------------------------------- *
 * 1. The round/task table — `00-vision.md` §2
 * -------------------------------------------------------------------------- */

describe("roundTable / roundSummary — the §2 table shape", () => {
  // Seven tasks over four rounds, deliberately shuffled on the way in, and
  // deliberately averaging 1.75 — the number `00-vision.md` §2 builds its
  // argument on.
  const shuffled = [
    mt("t1", { round: 1291 }),
    mt("t2", { round: 1350 }),
    mt("t3", { round: 1290 }),
    mt("t4", { round: 1292 }),
    mt("t5", { round: 1291 }),
    mt("t6", { round: 1292 }),
    mt("t7", { round: 1291 }),
  ];

  test("groups by round, ascending, regardless of input order", () => {
    assert.deepEqual(roundTable(shuffled), [
      { round: 1290, tasks: 1 },
      { round: 1291, tasks: 3 },
      { round: 1292, tasks: 2 },
      { round: 1350, tasks: 1 },
    ]);
  });

  test("summarises 7 tasks over 4 rounds as 1.75 per round", () => {
    assert.deepEqual(roundSummary(shuffled), {
      rounds: 4,
      tasks: 7,
      tasksPerRound: 1.75,
    });
  });

  test("rounds tasks-per-round to two decimals", () => {
    // 7 tasks over 3 rounds = 2.3333… → 2.33, not 2.3 and not 2.
    const three = [
      mt("a", { round: 1 }),
      mt("b", { round: 2 }),
      mt("c", { round: 2 }),
      mt("d", { round: 2 }),
      mt("e", { round: 3 }),
      mt("f", { round: 3 }),
      mt("g", { round: 3 }),
    ];
    assert.equal(roundSummary(three).tasksPerRound, 2.33);
  });

  test("an empty task list refuses rather than averaging zero", () => {
    expectMeasurementError(() => roundSummary([]), "too-few-tasks", ["0 tasks"]);
  });

  test("needs no run data at all", () => {
    // The whole point of the separate export: the numbering is readable for a
    // project whose runs are unmeasurable.
    assert.equal(roundTable([mt("x", { round: 4 })]).length, 1);
  });
});

/* -------------------------------------------------------------------------- *
 * 2 + 3. Concurrency and S2 — hand-counted literals
 * -------------------------------------------------------------------------- */

describe("concurrency sampling and S2 (the parallelism ratio)", () => {
  /**
   * TWO RUNS, PERFECTLY OVERLAPPING. Both occupy [10:00, 10:05).
   *
   * Counted on paper, one line per sampled minute, from the run boundaries:
   *   10:00  A live, B live → 2
   *   10:01  A live, B live → 2
   *   10:02  A live, B live → 2
   *   10:03  A live, B live → 2
   *   10:04  A live, B live → 2
   *   10:05  is NOT sampled — the interval is half-open, both runs have ended,
   *          and sampling it would score 0 and drag S1 down on every project.
   */
  const a = ran("a", "10:00", "10:05");
  const b = ran("b", "10:00", "10:05");
  const overlapping = input([a.task, b.task, ...filler(3)], [a.run, b.run]);

  test("two fully overlapping runs give concurrency 2 for every overlap minute", () => {
    const m = computeSchedule(overlapping);
    assert.deepEqual(m.concurrencySamples, [
      { minute: "2026-08-16T10:00:00.000Z", live: 2 },
      { minute: "2026-08-16T10:01:00.000Z", live: 2 },
      { minute: "2026-08-16T10:02:00.000Z", live: 2 },
      { minute: "2026-08-16T10:03:00.000Z", live: 2 },
      { minute: "2026-08-16T10:04:00.000Z", live: 2 },
    ]);
    assert.equal(m.meanConcurrency, 2);
    assert.equal(m.peakConcurrency, 2);
    assert.equal(m.runCount, 2);
    assert.equal(m.meanRunMinutes, 5);
  });

  test("S2: wall clock is strictly less than the summed run time when runs overlap", () => {
    const m = computeSchedule(overlapping);
    assert.equal(m.sumRunMinutes, 10); // 5 + 5
    assert.equal(m.wallClockMinutes, 5); // 10:00 → 10:05
    assert.ok(
      m.wallClockMinutes < m.sumRunMinutes,
      "overlapping runs must compress wall clock below the sum",
    );
    assert.equal(m.parallelismRatio, 0.5);
  });

  /**
   * TWO DISJOINT RUNS, BACK TO BACK. A occupies [10:00, 10:05), B [10:05, 10:10).
   *
   * Counted on paper:
   *   10:00 … 10:04  A live, B not yet started        → 1 each
   *   10:05          A has ENDED (half-open), B starts → 1, and this is the
   *                  minute that would read 2 if the interval were closed
   *   10:06 … 10:09  B live                            → 1 each
   * Never 2, at any sample.
   */
  const c = ran("c", "10:00", "10:05");
  const d = ran("d", "10:05", "10:10");
  const serial = input([c.task, d.task, ...filler(3)], [c.run, d.run]);

  test("two disjoint runs give concurrency 1 throughout and never 2", () => {
    const m = computeSchedule(serial);
    assert.deepEqual(m.concurrencySamples, [
      { minute: "2026-08-16T10:00:00.000Z", live: 1 },
      { minute: "2026-08-16T10:01:00.000Z", live: 1 },
      { minute: "2026-08-16T10:02:00.000Z", live: 1 },
      { minute: "2026-08-16T10:03:00.000Z", live: 1 },
      { minute: "2026-08-16T10:04:00.000Z", live: 1 },
      { minute: "2026-08-16T10:05:00.000Z", live: 1 },
      { minute: "2026-08-16T10:06:00.000Z", live: 1 },
      { minute: "2026-08-16T10:07:00.000Z", live: 1 },
      { minute: "2026-08-16T10:08:00.000Z", live: 1 },
      { minute: "2026-08-16T10:09:00.000Z", live: 1 },
    ]);
    assert.equal(m.peakConcurrency, 1);
    assert.equal(m.meanConcurrency, 1);
  });

  test("S2: wall clock equals the summed run time when runs are perfectly serial", () => {
    const m = computeSchedule(serial);
    assert.equal(m.sumRunMinutes, 10);
    assert.equal(m.wallClockMinutes, 10);
    assert.equal(m.parallelismRatio, 1);
  });
});

/* -------------------------------------------------------------------------- *
 * 4. D1 — sub-agent runs are excluded
 * -------------------------------------------------------------------------- */

describe("D1 — sub-agent runs are excluded from every number", () => {
  const a = ran("a", "10:00", "10:05");
  const b = ran("b", "10:00", "10:05");
  // A sub-agent of run-a, running for the whole overlap. A naive count would
  // read concurrency 3 here and credit the scheduler with a parallelism it did
  // not produce.
  const sub = mr("run-sub", {
    parent_run_id: "run-a",
    started_at: at("10:00"),
    completed_at: at("10:05"),
  });
  const withSub = input([a.task, b.task, ...filler(3)], [a.run, b.run, sub]);

  test("a sub-agent overlapping two top-level runs does not raise concurrency to 3", () => {
    const m = computeSchedule(withSub);
    assert.equal(m.peakConcurrency, 2);
    assert.deepEqual(
      m.concurrencySamples.map((s) => s.live),
      [2, 2, 2, 2, 2],
    );
    assert.equal(m.runCount, 2);
    assert.equal(m.sumRunMinutes, 10); // not 15
  });

  test("the exclusion is disclosed, never silent", () => {
    assert.equal(computeSchedule(withSub).excluded.subagentRuns, 1);
    assert.equal(inputCensus(withSub).subagentRuns, 1);
    assert.equal(inputCensus(withSub).topLevelRuns, 2);
  });

  test("D2 — an archived top-level run is INCLUDED, and disclosed", () => {
    const archived = input(
      [a.task, b.task, ...filler(3)],
      [a.run, { ...b.run, archived: true }],
    );
    const m = computeSchedule(archived);
    assert.equal(m.runCount, 2, "archived runs are what the fleet attempted");
    assert.equal(m.sumRunMinutes, 10);
    assert.equal(m.excluded.archivedRuns, 1);
    assert.equal(inputCensus(archived).archivedRuns, 1);
  });
});

/* -------------------------------------------------------------------------- *
 * 5. D4 — wake_after needs no filter
 * -------------------------------------------------------------------------- */

describe("D4 — a parked run contributes 0 because it was never claimed", () => {
  const a = ran("a", "10:00", "10:05");
  const b = ran("b", "10:00", "10:05");
  // Parked behind a usage wall: status 'queued', wake_after in the future,
  // started_at null because claimNextRun() has never fired for it.
  const parked = mr("run-parked", {
    status: "queued",
    started_at: null,
    completed_at: null,
    wake_after: "2099-01-01T00:00:00.000Z",
  });
  const parkedTask = mt("c", { status: "running", run_id: "run-parked" });
  const withParked = input([a.task, b.task, parkedTask, ...filler(2)], [a.run, b.run, parked]);

  test("a run with wake_after in the future and started_at null adds nothing", () => {
    const m = computeSchedule(withParked);
    assert.equal(m.peakConcurrency, 2);
    assert.deepEqual(
      m.concurrencySamples.map((s) => s.live),
      [2, 2, 2, 2, 2],
    );
    assert.equal(m.runCount, 2);
    assert.equal(m.excluded.neverStartedRuns, 1);
  });

  test("it is not mistaken for an unterminated run", () => {
    // completed_at is null on both, but only a run that STARTED is an R61
    // condition. This is the line D5 draws and D4 depends on.
    assert.deepEqual(computeSchedule(withParked).excluded.unterminatedRunIds, []);
  });

  test("the count is by interval, not by status — proved from both sides", () => {
    // A run whose status says 'queued' but which really ran IS counted…
    const misStatused = input(
      [a.task, b.task, ...filler(3)],
      [{ ...a.run, status: "queued" }, b.run],
    );
    assert.equal(computeSchedule(misStatused).runCount, 2);
    // …and a run whose status says 'completed' but which never started is NOT.
    const neverRan = input(
      [a.task, b.task, mt("e", { status: "running", run_id: "run-ghostly" }), ...filler(2)],
      [a.run, b.run, mr("run-ghostly", { status: "completed" })],
    );
    assert.equal(computeSchedule(neverRan).runCount, 2);
    assert.equal(computeSchedule(neverRan).excluded.neverStartedRuns, 1);
  });
});

/* -------------------------------------------------------------------------- *
 * 6. R61 — the instrument fails loudly
 * -------------------------------------------------------------------------- */

describe("R61 / D6 — the exit conditions", () => {
  const a = ran("a", "10:00", "10:05");
  const b = ran("b", "10:00", "10:05");

  test("fewer than 5 tasks throws too-few-tasks and names the project", () => {
    const tiny = input([a.task, b.task, ...filler(2)], [a.run, b.run]);
    expectMeasurementError(() => computeSchedule(tiny), "too-few-tasks", [PROJECT, "4 tasks"]);
  });

  test("a task pointing at a missing run throws unresolvable-run and names both ids", () => {
    const dangling = mt("orphan", { status: "done", run_id: "run-vanished" });
    const broken = input([a.task, b.task, dangling, ...filler(2)], [a.run, b.run]);
    expectMeasurementError(() => computeSchedule(broken), "unresolvable-run", [
      "orphan",
      "run-vanished",
    ]);
  });

  test("a non-pending task with no run_id at all throws unresolvable-run", () => {
    const runless = mt("released", { status: "ready", run_id: null });
    const broken = input([a.task, b.task, runless, ...filler(2)], [a.run, b.run]);
    expectMeasurementError(() => computeSchedule(broken), "unresolvable-run", [
      "released",
      "status ready",
    ]);
  });

  test("a started-but-uncompleted run throws unterminated-run and names the run id", () => {
    const stuck = mr("run-stuck", { status: "running", started_at: at("10:02") });
    const stuckTask = mt("s", { status: "running", run_id: "run-stuck" });
    const inFlight = input([a.task, b.task, stuckTask, ...filler(2)], [a.run, b.run, stuck]);
    expectMeasurementError(() => computeSchedule(inFlight), "unterminated-run", ["run-stuck"]);

    // D5's escape hatch: excluded and NAMED, never estimated.
    const m = computeSchedule(inFlight, { allowUnterminated: true });
    assert.deepEqual(m.excluded.unterminatedRunIds, ["run-stuck"]);
    assert.equal(m.runCount, 2);
    assert.equal(m.sumRunMinutes, 10);
  });

  test("an unparseable timestamp throws missing-timestamp", () => {
    const bad = mr("run-bad", { started_at: "not-a-date", completed_at: at("10:05") });
    const badTask = mt("z", { status: "done", run_id: "run-bad" });
    const broken = input([a.task, b.task, badTask, ...filler(2)], [a.run, b.run, bad]);
    expectMeasurementError(() => computeSchedule(broken), "missing-timestamp", [
      "run-bad.started_at",
      "not-a-date",
    ]);
  });

  test("a run whose completion precedes its start throws inverted-interval", () => {
    // Declared beyond D6's three because it is a refusal, not an invention: a
    // negative duration would shorten the summed run time and flatter S2.
    const backwards = mr("run-back", { started_at: at("10:30"), completed_at: at("10:05") });
    const backTask = mt("bk", { status: "done", run_id: "run-back" });
    const broken = input([a.task, b.task, backTask, ...filler(2)], [a.run, b.run, backwards]);
    expectMeasurementError(() => computeSchedule(broken), "inverted-interval", ["run-back"]);
  });

  test("a project whose runs never started throws no-measurable-runs", () => {
    const idle = input(filler(5), [mr("run-never")]);
    expectMeasurementError(() => computeSchedule(idle), "no-measurable-runs", [PROJECT]);
  });

  test("an absurd measurement window throws span-too-long rather than looping", () => {
    const ancient = {
      task: mt("old", { status: "done", run_id: "run-old" }),
      run: mr("run-old", {
        started_at: "2020-01-01T00:00:00.000Z",
        completed_at: "2020-01-01T00:05:00.000Z",
      }),
    };
    const wide = input([ancient.task, b.task, ...filler(3)], [ancient.run, b.run]);
    expectMeasurementError(() => computeSchedule(wide), "span-too-long", ["minute ceiling"]);
  });

  test("it never returns a partial ScheduleMetrics", () => {
    // Every refusal above is decided before any number is produced. The proof
    // is that the throwing call has no return value to inspect at all.
    const broken = input(
      [a.task, mt("orphan", { status: "done", run_id: "run-vanished" }), ...filler(3)],
      [a.run],
    );
    let result: unknown = "untouched";
    try {
      result = computeSchedule(broken);
    } catch {
      // disclosed: this catch asserts below, it does not swallow.
    }
    assert.equal(result, "untouched");
  });
});

/* -------------------------------------------------------------------------- *
 * 7. D7 — S3, both arms
 * -------------------------------------------------------------------------- */

describe("D7 — the numbering stall", () => {
  // dep ran 10:00 → 10:10. waiter was claimed at 10:30, twenty minutes after
  // its only dependency finished. Counted on paper: 10:30 − 10:10 = 20.
  const dep = ran("dep", "10:00", "10:10");
  const waiter = ran("waiter", "10:30", "10:40", { depends_on: ["dep"] });
  const graphTasks = [dep.task, waiter.task, ...filler(3)];
  const graphRuns = [dep.run, waiter.run];

  test("a graph project reports computable:true with the real stall in minutes", () => {
    const stall = computeSchedule(input(graphTasks, graphRuns)).numberingStall;
    assert.equal(stall.computable, true);
    if (!stall.computable) assert.fail("expected the graph arm");
    assert.equal(stall.maxMinutes, 20);
    assert.deepEqual(stall.perTask, [{ task_id: "waiter", minutes: 20 }]);
  });

  test("one NULL depends_on makes the whole project not computable — and NOT 0", () => {
    const withLegacy = graphTasks.map((t) =>
      t.id === "filler-0" ? { ...t, depends_on: null } : t,
    );
    const stall = computeSchedule(input(withLegacy, graphRuns)).numberingStall;
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail("a legacy row must not yield a number");
    assert.equal(stall.legacyRows, 1);
    assert.ok(!("maxMinutes" in stall), "the refusal must carry no minutes field");
    assert.match(stall.reason, /never recorded/);
    assert.match(stall.reason, /backfilled closure/);
  });

  test("an absent depends_on column (pre-0040 schema) refuses identically", () => {
    const preMigration = graphTasks.map((t) =>
      t.id === "filler-1" ? { ...t, depends_on: undefined } : t,
    );
    const stall = computeSchedule(input(preMigration, graphRuns)).numberingStall;
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail("undefined is the same sentinel as null");
    assert.equal(stall.legacyRows, 1);
  });

  test("the refusal is visible in the census too", () => {
    const withLegacy = graphTasks.map((t) =>
      t.id === "filler-0" ? { ...t, depends_on: null } : t,
    );
    const census = inputCensus(input(withLegacy, graphRuns));
    assert.equal(census.legacyRows, 1);
    assert.equal(census.graphRows, 4);
    assert.equal(census.legacyRows + census.graphRows, census.tasks);
  });

  test("a project with edges but no started dependent refuses rather than reporting 0", () => {
    // Every task is a root: there is no edge to measure a stall across, and 0
    // would read as "no numbering stall" when the truth is "no measurement".
    const a = ran("a", "10:00", "10:05");
    const b = ran("b", "10:00", "10:05");
    const stall = computeSchedule(input([a.task, b.task, ...filler(3)], [a.run, b.run]))
      .numberingStall;
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail("no edges means no measurement");
    assert.equal(stall.legacyRows, 0);
    assert.match(stall.reason, /no edge to measure/);
  });

  test("a dependency with no completed run throws rather than dropping the term", () => {
    // A stall measured against a subset of a task's dependencies is smaller
    // than the truth, and smaller is the flattering direction.
    const openDep = {
      task: mt("open", { status: "running", run_id: "run-open" }),
      run: mr("run-open", { status: "running", started_at: at("09:00") }),
    };
    const late = ran("late", "10:30", "10:40", { depends_on: ["dep", "open"] });
    expectMeasurementError(
      () =>
        computeSchedule(
          input([dep.task, openDep.task, late.task, ...filler(2)], [dep.run, openDep.run, late.run]),
          { allowUnterminated: true },
        ),
      "missing-timestamp",
      ["late", "open"],
    );
  });

  test("a dependency naming a task of another project throws unresolvable-run", () => {
    const stray = ran("stray", "10:30", "10:40", { depends_on: ["not-in-this-project"] });
    expectMeasurementError(
      () => computeSchedule(input([dep.task, stray.task, ...filler(3)], [dep.run, stray.run])),
      "unresolvable-run",
      ["not-in-this-project"],
    );
  });
});

/* -------------------------------------------------------------------------- *
 * 7b. D7's SECOND arm — the backfilled closure, which is attack A3 succeeding
 *     through the database instead of through the code.
 *
 * ROUND 214, PHASE-7 FINDINGS 1 AND 2. Finding 2 was about THIS FILE: the only
 * closure-related assertion in the block above is `assert.match(stall.reason,
 * /backfilled closure/)`, which fires on the `depends_on IS NULL` path. NO TEST
 * EVER FED ROWS CARRYING THE CLOSURE — which is precisely why finding 1 survived
 * a suite of 970 green tests. The module's prose warned at length against
 * substituting the closure IN CODE while migration 0040's final UPDATE wrote
 * that same closure over every legacy row IN THE DATABASE, and no test noticed
 * that those are the same substitution arriving by a different door.
 *
 * The fixtures below are the literal motivating case from `00-vision.md` §2:
 * one 32-minute reviewer, seven unrelated builders numbered above it, and
 * `depends_on` exactly as `0040_task_graph.sql`'s R6 backfill writes it
 * (`SELECT e.id … WHERE e.round < pt.round`). The true numbering stall is 32
 * minutes — the builders needed nothing from the reviewer — and the closure
 * makes it compute to 0.
 * -------------------------------------------------------------------------- */

describe("D7 — a project carrying migration 0040's backfilled closure", () => {
  /** The 32-minute reviewer that held everything behind it. Round 1. */
  const blocker = ran("blocker", "10:00", "10:32", { round: 1, role: "reviewer", depends_on: [] });

  /* The seven builders. Round 2, so 0040 backfills each with the set of tasks
   * at a strictly lower round — which is `[blocker]` and nothing else. Every
   * one of them was claimed at 10:32, the instant the round drained, because
   * that is what the OLD engine did. Under the closure, `start − max(dep
   * completed_at)` is therefore 0 for all seven, by construction and not by
   * measurement. */
  const builders = Array.from({ length: 7 }, (_unused, i) =>
    ran(`builder-${i}`, "10:32", "10:44", { round: 2, depends_on: ["blocker"] }),
  );

  const backfilled = input(
    [blocker.task, ...builders.map((b) => b.task)],
    [blocker.run, ...builders.map((b) => b.run)],
  );

  test("S3 REFUSES — it must not report the 0 the closure computes to", () => {
    const stall = computeSchedule(backfilled).numberingStall;
    // The assertion that fails against the pre-round-215 module, where this
    // returned { computable: true, maxMinutes: 0, perTask: 7 entries }.
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail(`expected a refusal, got ${JSON.stringify(stall)}`);
    assert.ok(!("maxMinutes" in stall), "the refusal must carry no minutes field");
    assert.equal(stall.legacyRows, 0, "the sentinel is GONE — that is the whole hazard");
    assert.equal(stall.closureRows, 8);
    assert.match(stall.reason, /strictly lower round/);
    assert.match(stall.reason, /0040/);
  });

  test("the arithmetic it refuses to report really would have been 0", () => {
    // Proves the refusal is protecting against a FLATTERING number and not
    // against an error. Computed here from the fixture, independently of the
    // module: every builder started at 10:32 and its only dependency completed
    // at 10:32, so every term is exactly 0 — while the real stall, the reason
    // this project exists, is the 32 minutes the builders spent waiting for a
    // reviewer they did not depend on.
    for (const b of builders) {
      assert.equal(b.run.started_at, blocker.run.completed_at);
    }
    const trueStallMinutes =
      (Date.parse(builders[0].run.started_at ?? "") - Date.parse(blocker.run.started_at ?? "")) / 60_000;
    assert.equal(trueStallMinutes, 32);
  });

  test("the census discloses it even though no row is legacy any more", () => {
    // Round 214 finding 1's exact words: "No header field discloses that these
    // are backfilled rows." Now one does.
    const census = inputCensus(backfilled);
    assert.equal(census.legacyRows, 0);
    assert.equal(census.graphRows, 8);
    assert.equal(census.closureShapedRows, 8);
  });

  test("ONE row breaking the closure is enough to measure again", () => {
    // The refusal is about a project that is closure-shaped THROUGHOUT. Give
    // one builder a genuine planner-written dependency set — empty, i.e. an
    // explicit root that does NOT wait for the reviewer — and the signature is
    // broken, so the instrument computes. It then reports the real stall of the
    // remaining six as 0, which is honest: those six DID declare the reviewer.
    const [first, ...rest] = builders;
    const partial = input(
      [blocker.task, { ...first.task, depends_on: [] }, ...rest.map((b) => b.task)],
      [blocker.run, ...builders.map((b) => b.run)],
    );
    const stall = computeSchedule(partial).numberingStall;
    assert.equal(stall.computable, true);
    if (!stall.computable) assert.fail("one non-closure row must restore measurability");
    assert.equal(stall.perTask.length, 6);
    // …and the disclosure survives, which is what stops a partial match hiding.
    assert.equal(inputCensus(partial).closureShapedRows, 7);
  });

  test("perfect fan-out is NOT accused of being a backfill", () => {
    // Every task a root at one round: vacuously closure-shaped for every row,
    // and the single best result this instrument can be handed. S3 is still not
    // computable — there is no edge — but the REASON must be that, not a
    // migration it never met.
    const roots = Array.from({ length: 6 }, (_unused, i) =>
      ran(`root-${i}`, "10:00", "10:10", { round: 0, depends_on: [] }),
    );
    const stall = computeSchedule(
      input(roots.map((r) => r.task), roots.map((r) => r.run)),
    ).numberingStall;
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail("no edges means no measurement");
    assert.match(stall.reason, /no edge to measure/);
    assert.doesNotMatch(stall.reason, /0040/);
  });
});

/* -------------------------------------------------------------------------- *
 * 7c. What step 2b ACTUALLY yields — the pre-0040 read, in the shape phase 8
 *     will meet it.
 *
 * ROUND 216'S FINDING 2. `04-phases.md` §8 step 2b justified its ordering with
 * "a refusal you have to redo the deploy to fix is not a substitute for reading
 * the number while it exists", which reads as though S3 is a number before the
 * migration and a refusal after it. It is not. At step 2b, `0040` has not run,
 * so `project_tasks` has NO `depends_on` COLUMN AT ALL; `readProjectRows()` asks
 * `information_schema`, sets `hasDependsOnColumn = false`, and `taskRow()`
 * leaves the key ABSENT. Every row then reaches `isLegacyRow()` as `undefined`
 * and D7's FIRST arm refuses. Step 2b prints a refusal, never a number.
 *
 * The ordering is still right, and this block is what says why in code rather
 * than in prose: read before the migration and the refusal names the LEGACY
 * SENTINEL — "these rows never recorded their real dependency set", which is
 * true and permanent. Read after it and the refusal names the CLOSURE SIGNATURE
 * — a weaker, heuristic reason (7b calls it a signature, not a proof) reached
 * only because round 215 added a second arm, and one that a strictly-serial
 * graph project would also trigger. Same verdict, different quality of reason,
 * and the sentinel is destroyed either way. That is the whole value of 2b.
 *
 * The two arms are joined here rather than left to prose: the rows are built by
 * `taskRow()` — the real narrowing function phase 8's live read runs through —
 * with `hasDependsOn = false`, so the shape is not hand-asserted.
 * -------------------------------------------------------------------------- */

describe("D7 — the pre-0040 read at step 2b refuses on the legacy sentinel", () => {
  /* The same motivating case as 7b: one 32-minute reviewer, seven builders
   * numbered above it. The ONLY difference is the schema — the migration has
   * not run, so no row carries a depends_on key at all. */
  const blocker = ran("blocker", "10:00", "10:32", { round: 1, role: "reviewer" });
  const builders = Array.from({ length: 7 }, (_unused, i) =>
    ran(`builder-${i}`, "10:32", "10:44", { round: 2 }),
  );

  /** Every row through the real narrowing, with the column absent. */
  function preMigrationRows(): MetricTask[] {
    return [blocker.task, ...builders.map((b) => b.task)].map((task, i) =>
      taskRow(
        {
          id: task.id,
          project_id: task.project_id,
          round: task.round,
          role: task.role,
          title: task.title,
          status: task.status,
          created_at: task.created_at,
          run_id: task.run_id,
        },
        i,
        false, // hasDependsOnColumn — pre-0040, exactly what step 2b meets
        PROJECT,
      ),
    );
  }

  const preMigration = input(preMigrationRows(), [blocker.run, ...builders.map((b) => b.run)]);

  test("taskRow leaves the key ABSENT, not null — the two say different things", () => {
    for (const row of preMigration.tasks) {
      assert.equal("depends_on" in row, false, `${row.id} must carry no depends_on key`);
    }
  });

  // DELIBERATELY ROBUST, and recorded as such so it is not read as vacuous.
  // Round 217 mutated `isLegacyRow` to ignore `undefined`, and `taskRow` to
  // fabricate `depends_on: []` for a pre-0040 row; this test stayed GREEN under
  // both, because each mutation only downgrades the refusal to "no edge to
  // measure". That is the finding: no reachable defect turns step 2b into a
  // number. The two tests below are the ones that discriminate — they pin the
  // REASON, and both went red on both mutations.
  test("S3 is NOT COMPUTABLE at step 2b — a refusal, never a number", () => {
    const stall = computeSchedule(preMigration).numberingStall;
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail(`step 2b must not yield a number, got ${JSON.stringify(stall)}`);
    assert.ok(!("maxMinutes" in stall), "the refusal must carry no minutes field");
  });

  test("the refusal is D7's FIRST arm — the sentinel, not the closure signature", () => {
    // This is the assertion that carries 04-phases.md §8 step 2b's amended
    // justification. Before the migration the reason is the strong one.
    const stall = computeSchedule(preMigration).numberingStall;
    if (stall.computable) assert.fail("expected the legacy arm");
    assert.equal(stall.legacyRows, 8, "every row is legacy — the column does not exist yet");
    assert.equal(stall.closureRows, 0, "nothing has been backfilled yet");
    assert.match(stall.reason, /never recorded/);
    assert.doesNotMatch(stall.reason, /strictly lower round/);
  });

  test("the census header phase 8 pastes discloses the same thing", () => {
    // `03-quality.md` §3.2's phase-8 gate reads these two fields off the pasted
    // header to decide whether the read really happened before the migration.
    const census = inputCensus(preMigration);
    assert.equal(census.tasks, 8);
    assert.equal(census.legacyRows, 8);
    assert.equal(census.graphRows, 0);
    assert.equal(census.closureShapedRows, 0);
  });

  test("after the migration the SAME project refuses for the weaker reason", () => {
    // The contrast that makes the ordering load-bearing rather than tidy. Apply
    // 0040's backfill by hand — the strictly-lower-round closure — and the
    // verdict is unchanged while the reason degrades from the sentinel to the
    // signature, and `legacyRows` drops to 0 so nothing is left saying these
    // rows never declared anything.
    const backfilled = input(
      [
        { ...blocker.task, depends_on: [] },
        ...builders.map((b) => ({ ...b.task, depends_on: ["blocker"] })),
      ],
      preMigration.runs,
    );
    const stall = computeSchedule(backfilled).numberingStall;
    assert.equal(stall.computable, false);
    if (stall.computable) assert.fail("7b already pins this refusal");
    assert.equal(stall.legacyRows, 0);
    assert.match(stall.reason, /strictly lower round/);
    assert.equal(inputCensus(backfilled).closureShapedRows, 8);
  });
});

/* -------------------------------------------------------------------------- *
 * 8. The negative-stall guard
 * -------------------------------------------------------------------------- */

describe("D7 — the stall clamps at 0 and never goes negative", () => {
  // dep finished at 10:10.
  //   early was claimed at 10:05, BEFORE its dependency finished → −5 → 0.
  //   late  was claimed at 10:17, seven minutes after            → 7.
  // Hand-counted maximum: 7. An unclamped implementation would compute
  // max(−5, 7) = 7 here too, so the clamp is proved by `early`'s own entry
  // being exactly 0 rather than by the maximum alone.
  const dep = ran("dep", "10:00", "10:10");
  const early = ran("early", "10:05", "10:15", { depends_on: ["dep"] });
  const late = ran("late", "10:17", "10:27", { depends_on: ["dep"] });
  const clamped = input(
    [dep.task, early.task, late.task, ...filler(2)],
    [dep.run, early.run, late.run],
  );

  test("a task that started before its dependency completed contributes 0", () => {
    const stall = computeSchedule(clamped).numberingStall;
    assert.equal(stall.computable, true);
    if (!stall.computable) assert.fail("expected the graph arm");
    assert.deepEqual(stall.perTask, [
      { task_id: "early", minutes: 0 },
      { task_id: "late", minutes: 7 },
    ]);
    assert.equal(stall.maxMinutes, 7);
    assert.ok(
      stall.perTask.every((t) => t.minutes >= 0),
      "no per-task stall may be negative",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * R60 — the census the header prints
 * -------------------------------------------------------------------------- */

describe("R60 — inputCensus", () => {
  const a = ran("a", "10:00", "10:05");
  const b = ran("b", "10:00", "10:05");
  const sub = mr("run-sub", {
    parent_run_id: "run-a",
    started_at: at("10:01"),
    completed_at: at("10:02"),
  });

  test("counts every population the header names", () => {
    const census = inputCensus(
      input(
        [a.task, b.task, mt("legacy", { depends_on: null }), ...filler(2)],
        [a.run, { ...b.run, archived: true }, sub],
      ),
    );
    assert.deepEqual(census, {
      tasks: 5,
      runs: 3,
      topLevelRuns: 2,
      subagentRuns: 1,
      archivedRuns: 1,
      tasksWithoutRun: 3, // legacy + two filler, all run-less
      legacyRows: 1,
      graphRows: 4,
      /* Round 215, for round 214's phase-7 finding 1. `a` and `b` sit at the
       * lowest round present (1) with `depends_on: []`, so the
       * strictly-lower-round set is empty for both and they match the backfill
       * signature VACUOUSLY. `legacy` carries the NULL sentinel and is excluded
       * by construction; the two filler rows at round 9 declare `[]` while
       * three tasks sit below them, so they do not match. Two is the honest
       * count, and it is exactly why this field is a DISCLOSURE rather than a
       * verdict — the refusal in `numberingStall()` fires only when every row
       * matches AND some row declares an edge. */
      closureShapedRows: 2,
    });
  });

  test("never throws, so the header survives the project computeSchedule refuses", () => {
    // R60 wants the header printed BEFORE any number; R61 wants a broken
    // project to exit non-zero with its reason. Both are only possible in that
    // order if the census can be computed for a project that will be refused.
    const broken = input(
      [
        mt("ghost", { status: "done", run_id: "run-vanished" }),
        mt("rotten", { status: "done", run_id: "run-rotten" }),
        ...filler(3),
      ],
      [mr("run-rotten", { started_at: "not-a-date", completed_at: "also-not-a-date" })],
    );
    const census = inputCensus(broken);
    assert.equal(census.tasks, 5);
    assert.equal(census.tasksWithoutRun, 4); // ghost's run is absent; filler have none
    assert.equal(census.legacyRows + census.graphRows, census.tasks);
    // …and only then does the measurement itself refuse.
    expectMeasurementError(() => computeSchedule(broken), "unresolvable-run", ["run-vanished"]);
  });
});

/* -------------------------------------------------------------------------- *
 * 10. D8 — a never-ran task leaves by id, with a reason
 * -------------------------------------------------------------------------- */

describe("D8 — --exclude-task drops a never-ran row, and only a never-ran row", () => {
  // Five rows that really ran, 10:00 → 10:05 each. This is the base the whole
  // section is built on: it computes cleanly, so every refusal below is caused
  // by the ONE row added to it and never by the base being malformed. (Guard 3
  // of the module doc-comment: an R61 case that throws for the wrong reason.)
  const ran5 = ["a", "b", "c", "d", "e"].map((id) => ran(id, "10:00", "10:05"));
  const RAN_TASKS = ran5.map((r) => r.task);
  const RAN_RUNS = ran5.map((r) => r.run);

  /**
   * The row the operator excludes: `done`, no run, at a round of its own so its
   * departure is visible in the round table as a whole row rather than a
   * decrement. This is the shape of all three 8ea0cc08 rows — a task a human
   * closed without it ever promoting.
   */
  const ghost = mt("ghost-1350", { status: "done", run_id: null, round: 1350 });

  const withGhost = input([...RAN_TASKS, ghost], RAN_RUNS);
  const withoutGhost = input(RAN_TASKS, RAN_RUNS);

  test("the D6 refusal still fires for a never-ran task that was NOT excluded", () => {
    // The blocker measured at round 800, reproduced. Without this the whole
    // flag would be solving a problem the test file never demonstrated.
    expectMeasurementError(() => computeSchedule(withGhost), "unresolvable-run", [
      "ghost-1350",
      "status done",
      "only a 'pending' task may have none",
    ]);
    // …and it still fires when the flag is present but names a DIFFERENT row.
    const other = mt("ghost-101", { status: "done", run_id: null, round: 101 });
    expectMeasurementError(
      () =>
        computeSchedule(input([...RAN_TASKS, ghost, other], RAN_RUNS), {
          excludeTaskIds: ["ghost-101"],
        }),
      "unresolvable-run",
      ["ghost-1350"],
    );
  });

  test("excluding it changes the round table — and NOTHING else", () => {
    const excluded = computeSchedule(withGhost, { excludeTaskIds: ["ghost-1350"] });
    const never = computeSchedule(withoutGhost);

    // The round table: round 1350 is gone, and the five ran rows are untouched.
    assert.deepEqual(roundTable(RAN_TASKS.concat(ghost)), [
      { round: 1, tasks: 5 },
      { round: 1350, tasks: 1 },
    ]);
    assert.deepEqual(roundTable(RAN_TASKS), [{ round: 1, tasks: 5 }]);
    assert.deepEqual(roundSummary(RAN_TASKS), { rounds: 1, tasks: 5, tasksPerRound: 5 });

    // "and nothing else", asserted as a whole-object comparison rather than
    // field by field: a new metric added later is covered by this line without
    // anyone remembering to extend it. The ONLY permitted difference is the
    // disclosure itself.
    assert.deepEqual(
      { ...excluded, excluded: { ...excluded.excluded, neverRan: [] } },
      never,
    );
    // Stated positively too, so a reader does not have to decode the spread:
    // an excluded row names no run, so no interval and no ratio can move.
    assert.equal(excluded.runCount, 5);
    assert.equal(excluded.sumRunMinutes, 25);
    assert.equal(excluded.wallClockMinutes, 5);
    assert.equal(excluded.meanConcurrency, 5);
    assert.equal(excluded.parallelismRatio, 0.2);
  });

  test("excluded.neverRan is populated, in the order the ids were given", () => {
    const second = mt("ghost-101", { status: "done", run_id: null, round: 101 });
    const m = computeSchedule(input([...RAN_TASKS, ghost, second], RAN_RUNS), {
      excludeTaskIds: ["ghost-1350", "ghost-101"],
    });
    assert.deepEqual(m.excluded.neverRan, ["ghost-1350", "ghost-101"]);
    // Order is the operator's, not the task set's — `ghost-101` sits earlier in
    // `tasks` and later in the disclosure, which is what makes this an echo of
    // the request rather than a re-derivation of it.
    const reversed = computeSchedule(input([...RAN_TASKS, ghost, second], RAN_RUNS), {
      excludeTaskIds: ["ghost-101", "ghost-1350"],
    });
    assert.deepEqual(reversed.excluded.neverRan, ["ghost-101", "ghost-1350"]);
  });

  test("no ids given: neverRan is empty and every number is unchanged", () => {
    const bare = computeSchedule(withoutGhost);
    assert.deepEqual(bare.excluded.neverRan, []);
    assert.deepEqual(computeSchedule(withoutGhost, { excludeTaskIds: [] }), bare);
  });

  test("excluding a task that HAS a run_id refuses, naming the id and its run", () => {
    // THE GUARD, and the whole reason this is not a blanket flag: `a` really
    // ran, so it may not be laundered out of the denominator.
    expectMeasurementError(
      () => computeSchedule(withGhost, { excludeTaskIds: ["a"] }),
      "excluded-task-has-run",
      ["task a", "run-a", "so it RAN"],
    );
    // …and it refuses even when a legitimate exclusion is passed beside it, so
    // one good id cannot carry a bad one through.
    expectMeasurementError(
      () => computeSchedule(withGhost, { excludeTaskIds: ["ghost-1350", "a"] }),
      "excluded-task-has-run",
      ["task a"],
    );
  });

  test("excluding an unknown id refuses — a typo must not exclude nothing quietly", () => {
    expectMeasurementError(
      () => computeSchedule(withGhost, { excludeTaskIds: ["ghost-1530"] }),
      "excluded-task-unknown",
      ["ghost-1530", "is not one of the 6 tasks in the measured set"],
    );
  });

  test("a duplicate id refuses — neverRan.length is a count a reader subtracts", () => {
    expectMeasurementError(
      () => computeSchedule(withGhost, { excludeTaskIds: ["ghost-1350", "ghost-1350"] }),
      "excluded-task-duplicate",
      ["ghost-1350", "named more than once"],
    );
  });

  test("too-few-tasks is evaluated AFTER the exclusion, never before", () => {
    // Five rows clear R61's floor; excluding one leaves four, and there is no
    // schedule in four rows. Were the floor checked first, the flag could
    // smuggle a two-row project past it and report an S1 over two rows.
    const five = input([...RAN_TASKS.slice(0, 4), ghost], RAN_RUNS.slice(0, 4));
    assert.equal(five.tasks.length, 5);
    computeSchedule(input([...RAN_TASKS, ghost], RAN_RUNS), { excludeTaskIds: ["ghost-1350"] });
    expectMeasurementError(
      () => computeSchedule(five, { excludeTaskIds: ["ghost-1350"] }),
      "too-few-tasks",
      ["4 tasks", "5 rows were handed in and 1 were excluded by id", "never on what arrived"],
    );
  });

  test("it does not mutate the caller's array — the exclusion runs TWICE on it", () => {
    // Load-bearing rather than tidy, and it is what makes the two-call-sites
    // design safe. `scripts/measure-schedule.ts` excludes once for its census
    // and round table, then hands computeSchedule() the SAME array plus the
    // same ids so D6 excludes again. An in-place filter would leave the second
    // call looking at a set the row had already left, and every id would come
    // back `excluded-task-unknown` — on the live read, not here.
    const tasks = [...RAN_TASKS, ghost];
    const before = tasks.map((t) => t.id);

    const first = excludeNeverRanTasks(tasks, ["ghost-1350"]);
    assert.deepEqual(tasks.map((t) => t.id), before, "the input array was modified");

    const second = excludeNeverRanTasks(tasks, ["ghost-1350"]);
    assert.deepEqual(
      second.kept.map((t) => t.id),
      first.kept.map((t) => t.id),
    );
    // …and the whole pair, as the wrapper actually performs it.
    const metrics = computeSchedule({ ...withGhost, tasks }, { excludeTaskIds: ["ghost-1350"] });
    assert.deepEqual(metrics.excluded.neverRan, ["ghost-1350"]);
  });

  test("excludeNeverRanTasks is the one definition, and it preserves input order", () => {
    // The wrapper calls this for its census and round table while
    // computeSchedule() calls it for D6. Two implementations would be the
    // failure the brief names; this asserts the exported one behaves as both
    // callers need — kept rows in input order, ids echoed in request order.
    const tasks = [...RAN_TASKS, ghost];
    const { kept, neverRan } = excludeNeverRanTasks(tasks, ["ghost-1350"]);
    assert.deepEqual(
      kept.map((t) => t.id),
      ["a", "b", "c", "d", "e"],
    );
    assert.deepEqual(neverRan, ["ghost-1350"]);
    // The empty request is identity, and returns the very same array object —
    // so the no-flag path cannot differ from the pre-D8 behaviour by a copy.
    const untouched = excludeNeverRanTasks(tasks, []);
    assert.equal(untouched.kept, tasks);
    assert.deepEqual(untouched.neverRan, []);
  });
});

/* -------------------------------------------------------------------------- *
 * 11. The declared-refusal list, checked against what the module can throw
 * -------------------------------------------------------------------------- */

describe("the declared-refusal list is complete in BOTH directions", () => {
  // Round 214's phase-7 review found `unterminated-run` thrown and NOT declared
  // in `MeasurementError`'s doc-block — "a list of refusals that is itself
  // incomplete is the same defect one level up". Round 802 adds three more
  // reasons, so the list is now checked rather than remembered.
  //
  // It reads the module's TEXT, which is the only way to see a doc-comment at
  // all. NF3 is untouched: no database, no network, one file read.
  const source = readFileSync(
    fileURLToPath(new URL("./schedule-metrics.ts", import.meta.url)),
    "utf8",
  );

  /** The block between `R61's carrier` and the class it documents. */
  function declaredBlock(): string {
    const start = source.indexOf("R61's carrier");
    const end = source.indexOf("export class MeasurementError");
    assert.ok(start > 0, "the MeasurementError doc-block no longer opens with \"R61's carrier\"");
    assert.ok(end > start, "the MeasurementError class no longer follows its doc-block");
    return source.slice(start, end);
  }

  /** Reasons DECLARED: a doc-comment line whose only content is a quoted name. */
  function declaredReasons(): Set<string> {
    return new Set(
      [...declaredBlock().matchAll(/^\s*\*\s+"([a-z-]+)"/gm)].map((m) => m[1]),
    );
  }

  /** Reasons THROWN: every `new MeasurementError("…")` literal in the module. */
  function thrownReasons(): Set<string> {
    return new Set(
      [...source.matchAll(/new MeasurementError\(\s*"([a-z-]+)"/g)].map((m) => m[1]),
    );
  }

  test("the probes are not vacuous — both sets are non-trivially populated", () => {
    // `00-vision.md` §7 rule 2: a sweep whose probes miss must fail, not
    // certify itself. Two regexes over one file is exactly the instrument that
    // reports a clean pass when its pattern stops matching.
    assert.ok(declaredReasons().size >= 10, `declared: ${[...declaredReasons()].join(", ")}`);
    assert.ok(thrownReasons().size >= 10, `thrown: ${[...thrownReasons()].join(", ")}`);
  });

  test("every reason the module throws is declared", () => {
    const declared = declaredReasons();
    const undeclared = [...thrownReasons()].filter((r) => !declared.has(r)).sort();
    assert.deepEqual(undeclared, []);
  });

  test("every declared reason is one the module can actually throw", () => {
    // The mirror defect, and the one nobody looks for: a declared reason that
    // no line can produce reads as authoritative and is wrong.
    const thrown = thrownReasons();
    const unthrowable = [...declaredReasons()].filter((r) => !thrown.has(r)).sort();
    assert.deepEqual(unthrowable, []);
  });

  test("D8's three reasons are in the list by name", () => {
    // Named individually so a regex that silently stopped matching them cannot
    // pass by leaving both sets equally empty.
    const declared = declaredReasons();
    for (const reason of [
      "excluded-task-has-run",
      "excluded-task-unknown",
      "excluded-task-duplicate",
    ]) {
      assert.ok(declared.has(reason), `"${reason}" is thrown but not declared`);
    }
  });
});
