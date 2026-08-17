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

import {
  computeSchedule,
  inputCensus,
  roundSummary,
  roundTable,
  MeasurementError,
  type MetricInput,
  type MetricRun,
  type MetricTask,
} from "./schedule-metrics.ts";

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
