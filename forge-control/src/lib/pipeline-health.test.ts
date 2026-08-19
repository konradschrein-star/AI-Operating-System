/**
 * Tests for the pipeline health classifiers.
 *
 * Run: pnpm test   (`tsx --test src/lib/*.test.ts`, node:test, no framework)
 *
 * THE FLIP TEST is the reason this file exists. The live `content_jobs` table
 * holds five jobs, all 11–14 days stale, and R68 forbids creating a fresh one
 * to prove the other branch. An assertion that those five render `stalled`
 * also passes on a classifier that marks EVERYTHING stalled — so the negative
 * half is asserted here, in the same file, against the same threshold:
 *
 *   - a job whose status_updated_at is NOW renders NOT stalled;
 *   - the boundary is asserted both ways, at threshold−1min and threshold+1min.
 *
 * The five live ages are the ones measured in
 * `docs/plan/artifacts/os-usable-for-work/phase5/premises-remeasured.md` § P2
 * at 2026-08-18T19:27:24Z.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STALL_AFTER_HOURS,
  resolveStallHours,
  stallCutoffMs,
  classifyStall,
  classifyPhaseState,
  parsePm2Jlist,
  CONTENT_FORGE_PM2_PROCESSES,
  type PhaseCount,
} from "./pipeline-health.ts";

const NOW = Date.parse("2026-08-18T19:27:24Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/* ========================================================================== *
 * Threshold configuration
 * ========================================================================== */

describe("resolveStallHours", () => {
  test("unset and empty take the 48h default", () => {
    assert.equal(resolveStallHours(undefined), DEFAULT_STALL_AFTER_HOURS);
    assert.equal(resolveStallHours(""), DEFAULT_STALL_AFTER_HOURS);
    assert.equal(resolveStallHours("   "), DEFAULT_STALL_AFTER_HOURS);
  });

  test("a valid override is honoured", () => {
    assert.equal(resolveStallHours("6"), 6);
    assert.equal(resolveStallHours("0.5"), 0.5);
  });

  test("an unusable value THROWS rather than falling back", () => {
    // A silent fallback here publishes stall_threshold_hours: 48 to an
    // operator who believes they set 6, and every verdict is quietly wrong.
    for (const bad of ["nonsense", "0", "-3", "NaN", "Infinity"]) {
      assert.throws(() => resolveStallHours(bad), /PIPELINE_STALL_HOURS/, `expected ${bad} to throw`);
    }
  });
});

describe("stallCutoffMs", () => {
  test("is now minus the threshold, in ms", () => {
    assert.equal(stallCutoffMs(NOW, 48), NOW - 48 * HOUR);
    assert.equal(stallCutoffMs(NOW, 1), NOW - HOUR);
  });

  test("rejects a non-finite clock or a non-positive threshold", () => {
    assert.throws(() => stallCutoffMs(Number.NaN, 48), /finite epoch-ms/);
    assert.throws(() => stallCutoffMs(NOW, 0), /positive finite/);
    assert.throws(() => stallCutoffMs(NOW, -1), /positive finite/);
  });
});

/* ========================================================================== *
 * classifyStall — R64, and THE FLIP TEST
 * ========================================================================== */

describe("classifyStall", () => {
  test("the five live QC jobs render stalled with their real ages", () => {
    // Verbatim from premises-remeasured.md § P2 (CMD-B), pg ::text format.
    const live: { id: string; at: string; days: number }[] = [
      { id: "797bc9b0", at: "2026-08-04 01:01:34.885+00", days: 14 },
      { id: "6a9341e6", at: "2026-08-04 11:53:01.457+00", days: 14 },
      { id: "bd4bfd38", at: "2026-08-05 20:37:24.549+00", days: 12 },
      { id: "75c0cbe8", at: "2026-08-05 21:26:34.847+00", days: 12 },
      { id: "c65abcfe", at: "2026-08-06 21:50:26.252+00", days: 11 },
    ];
    for (const job of live) {
      const v = classifyStall(job.at, NOW, 48);
      assert.equal(v.stalled, true, `${job.id} must be stalled`);
      assert.equal(v.stall_days, job.days, `${job.id} age in days`);
    }
  });

  test("THE FLIP: a job updated NOW is NOT stalled", () => {
    // Without this half, a classifier hardcoded to `stalled: true` passes the
    // test above and ships.
    const v = classifyStall(new Date(NOW).toISOString(), NOW, 48);
    assert.equal(v.stalled, false);
    assert.equal(v.stall_days, 0);

    // A timestamp of exactly `now` takes the zero-age early return, so it
    // alone would NOT catch an always-stalled classifier. One second of age
    // puts the assertion through the threshold comparison itself. (Verified:
    // mutating `stalled` to a literal `true` fails this line.)
    const oneSecondOld = classifyStall(new Date(NOW - 1000).toISOString(), NOW, 48);
    assert.equal(oneSecondOld.stalled, false);
    assert.equal(oneSecondOld.stall_days, 0);
  });

  test("THE FLIP: an hour-old job is not stalled, a fortnight-old one is", () => {
    assert.equal(classifyStall(new Date(NOW - HOUR).toISOString(), NOW, 48).stalled, false);
    assert.equal(classifyStall(new Date(NOW - 14 * DAY).toISOString(), NOW, 48).stalled, true);
  });

  test("the boundary is asserted BOTH ways, one minute either side", () => {
    const justInside = new Date(NOW - (48 * HOUR - MINUTE)).toISOString(); // 47h59m
    const justOutside = new Date(NOW - (48 * HOUR + MINUTE)).toISOString(); // 48h01m
    assert.equal(classifyStall(justInside, NOW, 48).stalled, false, "47h59m must NOT be stalled");
    assert.equal(classifyStall(justOutside, NOW, 48).stalled, true, "48h01m MUST be stalled");
  });

  test("the boundary moves with the threshold", () => {
    const sixHoursOld = new Date(NOW - 6 * HOUR).toISOString();
    assert.equal(classifyStall(sixHoursOld, NOW, 48).stalled, false);
    assert.equal(classifyStall(sixHoursOld, NOW, 4).stalled, true);
  });

  test("stall_days counts whole days, stalled or not", () => {
    assert.equal(classifyStall(new Date(NOW - 3 * HOUR).toISOString(), NOW, 48).stall_days, 0);
    assert.equal(classifyStall(new Date(NOW - 25 * HOUR).toISOString(), NOW, 48).stall_days, 1);
    assert.equal(classifyStall(new Date(NOW - 47 * HOUR).toISOString(), NOW, 48).stall_days, 1);
  });

  test("a Date and its pg ::text rendering agree", () => {
    const iso = "2026-08-04 01:01:34.885+00";
    assert.deepEqual(classifyStall(iso, NOW, 48), classifyStall(new Date(iso), NOW, 48));
  });

  test("a future timestamp is fresh, never negative", () => {
    const v = classifyStall(new Date(NOW + 5 * HOUR).toISOString(), NOW, 48);
    assert.deepEqual(v, { stalled: false, stall_days: 0 });
  });

  test("an unparseable timestamp THROWS with the offending value", () => {
    assert.throws(() => classifyStall("not a timestamp", NOW), /not a parseable timestamp/);
    assert.throws(() => classifyStall(new Date("nope"), NOW), /Invalid Date/);
    assert.throws(() => classifyStall("2026-08-04 01:01:34.885+00", Number.NaN), /finite epoch-ms/);
  });
});

/* ========================================================================== *
 * classifyPhaseState — R65, the two kinds of empty column
 * ========================================================================== */

/** The live shape: everything at the QC gate, nothing anywhere else. */
function livePhases(): PhaseCount[] {
  return [
    { key: "idea", label: "Idea", count: 0 },
    { key: "script", label: "Script", count: 0 },
    { key: "voice", label: "Voice", count: 0 },
    { key: "assets", label: "Assets", count: 0 },
    { key: "qc", label: "QC", count: 5 },
    { key: "render", label: "Render", count: 0 },
    { key: "publish", label: "Publish", count: 0 },
  ];
}

describe("classifyPhaseState", () => {
  test("a phase with jobs has work, and says how many", () => {
    const v = classifyPhaseState(4, livePhases());
    assert.equal(v.state, "has_work");
    assert.match(v.state_reason, /5 jobs in QC/);
  });

  test("THE WHOLE OF R65: two zero columns, two different sentences", () => {
    const phases = livePhases();
    const idea = classifyPhaseState(0, phases); // upstream of the stuck work
    const publish = classifyPhaseState(6, phases); // downstream of it

    assert.equal(idea.state, "no_work_idle");
    assert.equal(publish.state, "no_work_blocked_upstream");
    assert.notEqual(idea.state_reason, publish.state_reason);
    assert.match(publish.state_reason, /5 jobs held further up, in QC \(5\)/);
    assert.match(publish.state_reason, /stuck, not because there is none/);
  });

  test("the first phase says why it is empty in its own terms", () => {
    const empty = livePhases().map((p) => ({ ...p, count: 0 }));
    const v = classifyPhaseState(0, empty);
    assert.equal(v.state, "no_work_idle");
    assert.match(v.state_reason, /first phase/);
  });

  test("a wholly empty pipeline is idle everywhere — never 'blocked'", () => {
    const empty = livePhases().map((p) => ({ ...p, count: 0 }));
    for (let i = 0; i < empty.length; i++) {
      assert.equal(classifyPhaseState(i, empty).state, "no_work_idle", `phase ${i}`);
    }
  });

  test("blocked-upstream names every upstream phase holding work", () => {
    const phases = livePhases();
    phases[1]!.count = 2; // Script
    const v = classifyPhaseState(6, phases);
    assert.equal(v.state, "no_work_blocked_upstream");
    assert.match(v.state_reason, /7 jobs held further up, in Script \(2\), QC \(5\)/);
  });

  test("work DOWNSTREAM does not make an empty phase blocked", () => {
    // Idea is empty and QC is full: Idea is idle. Only earlier phases count.
    assert.equal(classifyPhaseState(0, livePhases()).state, "no_work_idle");
  });

  test("singular/plural is written for a human", () => {
    const phases = livePhases().map((p) => ({ ...p, count: 0 }));
    phases[0]!.count = 1;
    assert.match(classifyPhaseState(0, phases).state_reason, /1 job in Idea\./);
    assert.match(classifyPhaseState(3, phases).state_reason, /1 job held further up/);
  });

  test("an out-of-range index THROWS rather than reporting idle", () => {
    assert.throws(() => classifyPhaseState(9, livePhases()), /out of range/);
    assert.throws(() => classifyPhaseState(-1, livePhases()), /out of range/);
  });
});

/* ========================================================================== *
 * parsePm2Jlist — R66, the pure half of worker health
 * ========================================================================== */

/** A trimmed `pm2 jlist` entry — the fields this parser reads, and no others. */
function proc(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    pid: 1234,
    pm2_env: { status: "online", pm_uptime: NOW - 7.6 * DAY, restart_time: 0, ...over },
  };
}

describe("parsePm2Jlist", () => {
  test("selects the four Content Forge workers, in the named order", () => {
    const jlist = JSON.stringify([
      proc("pm2-logrotate"),
      proc("worker-render"),
      proc("hub-web"),
      proc("claude-pool"),
      proc("worker-orchestrator"),
      proc("tl-worker-orchestrator"),
      proc("worker-video-stitch"),
    ]);
    const { workers, missing } = parsePm2Jlist(jlist, NOW);
    assert.deepEqual(
      workers.map((w) => w.name),
      [...CONTENT_FORGE_PM2_PROCESSES],
    );
    assert.deepEqual(missing, []);
    assert.equal(workers[0]!.status, "online");
    assert.equal(workers[0]!.uptime_ms, 7.6 * DAY);
    assert.equal(workers[0]!.restarts, 0);
  });

  test("a name pm2 does not know is MISSING, not stopped", () => {
    const { workers, missing } = parsePm2Jlist(JSON.stringify([proc("worker-render")]), NOW);
    assert.deepEqual(workers.map((w) => w.name), ["worker-render"]);
    assert.deepEqual(missing, ["worker-orchestrator", "worker-video-stitch", "claude-pool"]);
  });

  test("a non-online process reports uptime null, NEVER 0", () => {
    // 0 reads as "just restarted"; the truth is "not running".
    const jlist = JSON.stringify([proc("worker-render", { status: "stopped", restart_time: 2 })]);
    const { workers } = parsePm2Jlist(jlist, NOW);
    assert.equal(workers[0]!.status, "stopped");
    assert.equal(workers[0]!.uptime_ms, null);
    assert.equal(workers[0]!.restarts, 2);
  });

  test("a missing status is 'unknown', not assumed online", () => {
    const jlist = JSON.stringify([{ name: "claude-pool", pm2_env: { pm_uptime: NOW - HOUR } }]);
    const { workers } = parsePm2Jlist(jlist, NOW);
    assert.equal(workers[0]!.status, "unknown");
    assert.equal(workers[0]!.uptime_ms, null);
  });

  test("a missing restart_time reports null, NEVER 0", () => {
    // Same rule as uptime_ms, and the reason is the same: `0 restarts` is a
    // CLAIM ("this worker has never restarted") rendered on the surface. pm2
    // omitting the field must not be able to make that claim. `restart_time`
    // is deleted here rather than merely overridden, because `proc()`'s
    // default supplies 0 — which is exactly the value under test.
    const entry = proc("worker-render");
    const env = entry["pm2_env"] as Record<string, unknown>;
    delete env["restart_time"];
    assert.equal("restart_time" in env, false, "the fixture must not carry restart_time at all");

    const { workers } = parsePm2Jlist(JSON.stringify([entry]), NOW);
    assert.equal(workers[0]!.restarts, null);
    // The worker is otherwise perfectly healthy: this is missing DATA, not a
    // missing worker, and the two must not collapse into the same rendering.
    assert.equal(workers[0]!.status, "online");
    assert.equal(workers[0]!.uptime_ms, 7.6 * DAY);
  });

  test("a non-numeric restart_time reports null, not a coerced 0", () => {
    const jlist = JSON.stringify([proc("claude-pool", { restart_time: "3" })]);
    const { workers } = parsePm2Jlist(jlist, NOW);
    assert.equal(workers[0]!.restarts, null);
  });

  test("a real 0 from pm2 is still 0 — null and 0 are different answers", () => {
    // The null above must not have swallowed the honest zero: pm2 saying
    // "restart_time: 0" IS the claim "never restarted", and it stays.
    const { workers } = parsePm2Jlist(JSON.stringify([proc("worker-render")]), NOW);
    assert.equal(workers[0]!.restarts, 0);
    assert.notEqual(workers[0]!.restarts, null);
  });

  test("garbage from pm2 THROWS with what it was handed", () => {
    // pm2 prints warnings to stdout under some node versions. A parser that
    // swallowed that would report "no workers" for a healthy fleet.
    assert.throws(() => parsePm2Jlist("[PM2] spawning...", NOW), /did not return JSON/);
    assert.throws(() => parsePm2Jlist('{"not":"an array"}', NOW), /expected a JSON array/);
    assert.throws(() => parsePm2Jlist("[null]", NOW), /expected a pm2 jlist entry/);
  });

  test("an empty jlist is four missing workers, not four healthy ones", () => {
    const { workers, missing } = parsePm2Jlist("[]", NOW);
    assert.deepEqual(workers, []);
    assert.deepEqual(missing, [...CONTENT_FORGE_PM2_PROCESSES]);
  });
});
