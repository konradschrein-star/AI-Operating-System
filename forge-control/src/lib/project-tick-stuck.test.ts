/**
 * `deferForStuckRun` — project-tick must stop reading 'stuck' as "the work
 * failed".
 *
 * The defect these tests pin (measured 2026-08-25, not inferred): the executor
 * is ONE pm2 fork-mode process, so `heartbeat()` and `stuckWatchdogTick()` are
 * two timers on one event loop; when it stalls past
 * HEARTBEAT_STUCK_THRESHOLD_MS the watchdog can win the race and flip a run
 * whose engine child is still working. `reconcileSettledTasks` then saw
 * `run_status !== 'completed'`, fell past three guards that all require
 * `'failed'`, and marked the task `failed` + the project `blocked`. 46 flips,
 * 42 finished turns discarded, ≥ $83.01 of already-paid work, 5 tasks at the
 * attempt cap and 18 wedged behind them from 07:03 to 12:00 UTC.
 *
 * WHY THIS FILE CANNOT REACH content_forge, and how that is enforced rather
 * than promised. `db/projects.ts`, `db/runs.ts` and `db/ai_os.ts` each read
 * `process.env.DATABASE_URL` at MODULE LOAD, and the worker shell inherits a
 * live one. So line 1 of the body re-points that variable at a closed port and
 * project-tick.ts is loaded with `await import()` AFTER it — a static import
 * would be hoisted above the assignment and would inherit the live URL. Every
 * pg connection this process could ever open now goes to 127.0.0.1:1 and is
 * refused in about 4ms. Two consequences worth stating:
 *
 *   1. A branch that touches the database is IMPOSSIBLE to mistake for one that
 *      does not: it rejects. `assert.rejects` on the resume branch is therefore
 *      a positive proof that control reached the write, and every `hold` /
 *      `give_up` assertion that simply returns a boolean is proof that it did
 *      NOT — a stub that silently returned `true` could not tell those apart.
 *   2. The one thing this file cannot assert is `requeueRunAfterStuck`'s
 *      rowcount contract (moved → true, did not move → false). That needs real
 *      Postgres and is T6's dry-run harness's job; what is asserted here is the
 *      SQL precondition itself, by source, so a widened guard fails a test.
 *
 * The liveness fixture is a REAL process on the REAL /proc — `/bin/sleep` given
 * an `argv0` of `claude --resume <id>`, which is byte-for-byte the shape
 * `readEngineCmdlines()` scans for. No procfs mock, so a change to the scan
 * rule fails here too. (`sleep` and not `claude`, because spawning the actual
 * engine from a unit test would cost money and a session.)
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  planStuckRecovery,
  STUCK_RECOVERY_MAX_ATTEMPTS,
  type StuckKind,
} from "./stuck-recovery.ts";
import type { Project, SettledRunningTask } from "../db/projects.ts";

/* MUST precede the dynamic import below — see the header. */
process.env.DATABASE_URL = "postgresql://stub:stub@127.0.0.1:1/stub_never_content_forge";

const { deferForStuckRun, deferForUsageWall, deferForApiOverload, demoteAfterEngineFailure } =
  await import("./project-tick.ts");

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Stuck Test Project",
    brief: "Do the thing.",
    repo: "ai-os",
    workspace_dir: null,
    base_branch: "main",
    work_branch: "project/x",
    status: "active",
    metadata: {},
    created_at: "",
    updated_at: "",
    ...over,
  };
}

/** A settled task whose run the watchdog flipped, at the defaults that make the
 *  recoverable case: `stuck` + `heartbeat_stale` + no recovery spent yet. Every
 *  test below states only what it changes. */
function stuckTask(over: Partial<SettledRunningTask> = {}): SettledRunningTask {
  return {
    id: "t1",
    project_id: "p1",
    round: 1,
    role: "builder",
    title: "Teach project-tick that stuck is not failed",
    brief: "Implement the thing.",
    status: "running",
    run_id: "r1",
    fix_cycle: 0,
    tier: "standard",
    attempt: 1,
    chain_key: null,
    depends_on: null,
    workstream: "main",
    write_set: [],
    graph_frozen: false,
    created_at: "",
    updated_at: "",
    run_status: "stuck",
    last_text: null,
    last_error: null,
    usage_wall_attempts: 0,
    api_overload_attempts: 0,
    run_stuck_signal: "heartbeat_stale",
    stuck_recovery_attempts: 0,
    run_session_id: null,
    ...over,
  };
}

/**
 * A live process whose /proc cmdline carries `claude` and this session id —
 * exactly what `readEngineCmdlines()` matches on. Registered for cleanup so a
 * failing assertion cannot leave a `sleep` behind.
 */
const spawned: ChildProcess[] = [];
function liveEngineFixture(sessionId: string): void {
  const child = spawn("/bin/sleep", ["30"], {
    argv0: `claude --resume ${sessionId}`,
    stdio: "ignore",
  });
  child.unref();
  spawned.push(child);
}
after(() => {
  for (const c of spawned) c.kill("SIGKILL");
});

/** Run `fn` with console.warn captured, so the log line the operator reads is
 *  itself an assertion rather than noise scrolling past a green suite. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const SESSION_NOBODY_HAS = "00000000-dead-4000-8000-000000000000";

/* ========================================================================== *
 * THE DECISION TABLE — the four rows of PLAN.md §2(b)
 * ========================================================================== */

describe("decision table row 1 — heartbeat_stale + process ALIVE → hold", () => {
  test("returns true, writes nothing, and says the process is alive", async () => {
    const sid = `11111111-live-4000-8000-${process.pid.toString().padStart(12, "0")}`;
    liveEngineFixture(sid);
    // Give the child a moment to appear in /proc; the scan reads real files.
    await new Promise((r) => setTimeout(r, 250));

    const { value, warnings } = await captureWarnings(() =>
      deferForStuckRun(stuckTask({ run_session_id: sid }), project()),
    );

    // `true` alone would be satisfied by a resume too — but a resume writes,
    // and every write in this process is refused (see the header). Returning
    // rather than rejecting IS the proof that nothing was written.
    assert.equal(value, true, "a run whose process is alive must be held, not failed");
    assert.equal(warnings.length, 1, "exactly one line, like the three siblings");
    assert.match(warnings[0], /ALIVE/);
    assert.match(warnings[0], new RegExp(sid));
    assert.match(warnings[0], /task NOT failed, project NOT blocked/);
  });
});

describe("decision table row 2 — heartbeat_stale + process gone + attempts left → resume", () => {
  test("control reaches requeueRunAfterStuck, and a DB error is not swallowed", async () => {
    // The pool is pointed at a closed port, so reaching the write is visible as
    // a rejection. Rows 1, 3 and 4 all RETURN a boolean from this same call;
    // only this input rejects, which is what makes this a routing assertion and
    // not an assertion about pg.
    await assert.rejects(
      () =>
        deferForStuckRun(
          stuckTask({ run_session_id: SESSION_NOBODY_HAS, stuck_recovery_attempts: 0 }),
          project(),
        ),
      (e: unknown) =>
        e instanceof Error && /ECONNREFUSED|connect|timeout/i.test(e.message),
      "the resume branch must reach the DB write, and must not swallow its failure",
    );
  });

  test("a run with NO session id is 'no evidence of life', so it resumes too", async () => {
    // run_session_id is NULL for a run that never reached saveCcSession — and a
    // FIRST-turn claude child carries no session id in its argv at all. That is
    // absence of evidence, and this path is what stops it costing the work: the
    // run is requeued, not failed. (executor.ts's completeRun reclaim is the
    // other half; see lib/run-liveness.ts.)
    await assert.rejects(() => deferForStuckRun(stuckTask({ run_session_id: null }), project()));
  });

  test("the resume budget is 2 — the second attempt still resumes", async () => {
    assert.equal(STUCK_RECOVERY_MAX_ATTEMPTS, 2);
    await assert.rejects(() =>
      deferForStuckRun(stuckTask({ stuck_recovery_attempts: 1 }), project()),
    );
  });
});

describe("decision table row 3 — THE NEGATIVE CASE: dead + attempts exhausted → the task still fails", () => {
  test("returns false so the caller fails the task and blocks the project", async () => {
    // This is the assertion that keeps the watchdog doing its job. If it ever
    // goes green on `true`, a genuinely dead run can hold a project open
    // forever and the fix has become a worse bug than the one it replaced.
    const { value, warnings } = await captureWarnings(() =>
      deferForStuckRun(
        stuckTask({
          run_session_id: SESSION_NOBODY_HAS,
          stuck_recovery_attempts: STUCK_RECOVERY_MAX_ATTEMPTS,
        }),
        project(),
      ),
    );
    assert.equal(value, false, "a dead run out of retries must fall through to the failure path");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /falling back to the normal failure path/);
  });

  test("and it did not write on the way out", async () => {
    // Same input as above: it RETURNED rather than rejecting, so no pool.query
    // was issued. Stated as its own test because "returns false" and "wrote
    // nothing" are two different promises and only the second one is what makes
    // an exhausted run safe to fail.
    const returned = await captureWarnings(() =>
      deferForStuckRun(
        stuckTask({ stuck_recovery_attempts: STUCK_RECOVERY_MAX_ATTEMPTS + 5 }),
        project(),
      ),
    );
    assert.equal(returned.value, false);
  });
});

describe("decision table row 4 — a signal that is NOT the watchdog's guess → give up", () => {
  test("'timeout' owns its own manual Resume path and is not reopened here", async () => {
    // PLAN.md §5, deliberately out of scope: a wall-clock timeout is a real
    // decision, not a guess, and zero of the 35 live stuck rows carry it.
    const { value, warnings } = await captureWarnings(() =>
      deferForStuckRun(stuckTask({ run_stuck_signal: "timeout" }), project()),
    );
    assert.equal(value, false);
    assert.match(warnings[0], /signal timeout/);
  });

  test("a NULL or unknown signal is not reopened either", async () => {
    for (const signal of [null, "operator_kill", ""]) {
      const { value } = await captureWarnings(() =>
        deferForStuckRun(stuckTask({ run_stuck_signal: signal }), project()),
      );
      assert.equal(value, false, `stuck_signal ${JSON.stringify(signal)} must fall through`);
    }
  });

  test("skipping the /proc walk for these rows cannot change the outcome", async () => {
    // deferForStuckRun classifies BEFORE it walks /proc, so a non-heartbeat_stale
    // row never pays for a serial readFile over every pid on the box (749
    // measured live; docs/plan/evidence/stuck-heartbeat-latency.md flags that
    // walk as the leading remaining suspect for the >90s gaps, and this code
    // runs on the very event loop whose stalls cause the flips). That
    // optimisation is only sound because the policy ignores liveness for these
    // kinds — so pin it here rather than trust it.
    for (const kind of ["timeout", "unknown"] as StuckKind[]) {
      for (const priorAttempts of [0, 1, 2]) {
        assert.deepEqual(
          planStuckRecovery({ kind, processAlive: true, priorAttempts }),
          planStuckRecovery({ kind, processAlive: false, priorAttempts }),
          `planStuckRecovery must ignore processAlive for kind=${kind}`,
        );
      }
    }
    // ...and it does NOT ignore it for the kind that is walked.
    assert.notDeepEqual(
      planStuckRecovery({ kind: "heartbeat_stale", processAlive: true, priorAttempts: 0 }),
      planStuckRecovery({ kind: "heartbeat_stale", processAlive: false, priorAttempts: 0 }),
    );
  });
});

/* ========================================================================== *
 * REFUSALS — the three the siblings share
 * ========================================================================== */

describe("refusals", () => {
  test("a run that is not 'stuck' is none of this function's business", async () => {
    for (const run_status of ["failed", "cancelled", "completed"] as const) {
      const { value, warnings } = await captureWarnings(() =>
        deferForStuckRun(stuckTask({ run_status }), project()),
      );
      assert.equal(value, false, `run_status ${run_status} must fall through`);
      assert.equal(warnings.length, 0, "a refusal on the wrong status must be silent");
    }
  });

  test("no run row — nothing to requeue", async () => {
    const { value } = await captureWarnings(() =>
      deferForStuckRun(stuckTask({ run_id: null }), project()),
    );
    assert.equal(value, false);
  });

  /* THE PROJECT-STATUS TERM. Round 3's reviewer found this refusal sitting
   * ABOVE the plan, where it caught `hold` as well as `resume`: on a
   * blocked/paused/cancelled project a demonstrably ALIVE run was hard-failed
   * and its attempt burned, the child then finished and landed through
   * completeRun's reclaim, and the row pair `run='completed'` (carrying real
   * work) beside `task='failed'` was PERMANENT — `listSettledRunningTasks`
   * only ever re-reads `pt.status='running'`. That is the original defect
   * surviving inside its own fix. The two tests below are what the one test
   * that pinned the old behaviour split into. */

  test("RESUME is refused on a project that is not accepting work", async () => {
    // The re-queue really would smuggle billable work past the gate: a queued
    // run is invisible to project status (the executor's claim loop knows about
    // runs, not projects). Session nobody has ⇒ no evidence of life ⇒ the plan
    // is `resume` ⇒ this is exactly the input the refusal is FOR.
    for (const status of ["cancelled", "paused", "blocked", "done"] as const) {
      const { value, warnings } = await captureWarnings(() =>
        deferForStuckRun(
          stuckTask({ run_session_id: SESSION_NOBODY_HAS }),
          project({ status }),
        ),
      );
      assert.equal(value, false, `project status ${status} must not accept a re-queue`);
      assert.match(warnings[0], new RegExp(`its project is ${status}`));
      assert.match(warnings[0], /failing it rather than re-queuing work/);
      // It RETURNED instead of rejecting — with the pool pointed at a closed
      // port (see the header) that is positive proof the refusal happened
      // BEFORE requeueRunAfterStuck, not after a write that already landed.
    }
  });

  test("an ALIVE run is still HELD on a blocked, paused or cancelled project", async () => {
    // Holding starts nothing and spends nothing. The money is already spent —
    // the process is running right now — so the only question is whether the
    // task row tells the truth about it. Self-terminating, too: liveness is
    // re-proven every tick, so when the process dies this same row falls to
    // `resume`, which the test above proves is still gated, and then to
    // `give_up`.
    const sid = `22222222-live-4000-8000-${process.pid.toString().padStart(12, "0")}`;
    liveEngineFixture(sid);
    await new Promise((r) => setTimeout(r, 250));

    for (const status of ["cancelled", "paused", "blocked", "done"] as const) {
      const { value, warnings } = await captureWarnings(() =>
        deferForStuckRun(stuckTask({ run_session_id: sid }), project({ status })),
      );
      assert.equal(
        value,
        true,
        `a live process must be held on a ${status} project, not failed with its attempt burned`,
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /ALIVE/);
      assert.match(warnings[0], /task NOT failed, project NOT blocked/);
    }
  });

  test("an unreadable project refuses the resume but does not break the hold", async () => {
    const { value, warnings } = await captureWarnings(() =>
      deferForStuckRun(stuckTask({ run_session_id: SESSION_NOBODY_HAS }), null),
    );
    assert.equal(value, false);
    assert.match(warnings[0], /its project is unreadable/);

    // `project === null` must not turn a live run into a failure either — the
    // hold path never dereferences it.
    const sid = `33333333-live-4000-8000-${process.pid.toString().padStart(12, "0")}`;
    liveEngineFixture(sid);
    await new Promise((r) => setTimeout(r, 250));
    const held = await captureWarnings(() =>
      deferForStuckRun(stuckTask({ run_session_id: sid }), null),
    );
    assert.equal(held.value, true);
    assert.match(held.warnings[0], /ALIVE/);
  });
});

/* ========================================================================== *
 * DISJOINTNESS — why putting the new guard FIRST is safe
 *
 * The four guards in reconcileSettledTasks are now:
 *   deferForStuckRun · deferForUsageWall · demoteAfterEngineFailure · deferForApiOverload
 * The first fires only on `run_status === 'stuck'`, the other three only on
 * `run_status === 'failed'`. Disjoint predicates, so at most one can fire for a
 * given task and the ORDER cannot change any outcome. That is the whole safety
 * argument for the placement, so it is measured, not asserted in a comment.
 * ========================================================================== */

describe("disjointness of the four settled-loop guards", () => {
  test("none of the three existing guards fires on a 'stuck' run", async () => {
    // Each input is built so that the ONLY thing refusing it is the run status
    // — otherwise the test would pass for an unrelated reason and rot silently.
    const wall = stuckTask({
      last_error: "Executor failed: claude-code exit 1: You've hit your session limit · resets 1:10pm",
    });
    const dropout = stuckTask({
      tier: "gemini",
      attempt: 0,
      last_error: "Executor failed: agy returned status ERROR with no response text.",
    });
    const overload = stuckTask({
      last_error: "API Error: 529 {\"type\":\"overloaded_error\"}",
    });

    // Sanity: with run_status flipped to 'failed', each of these WOULD fire —
    // proven by the fact that each then reaches its DB write and rejects. This
    // is the mutation control: without it, `false` below proves nothing.
    await assert.rejects(
      () => deferForUsageWall({ ...wall, run_status: "failed" }, project()),
      "the usage-wall fixture must be one the wall guard actually claims",
    );
    await assert.rejects(
      () => demoteAfterEngineFailure({ ...dropout, run_status: "failed" }, project()),
      "the dropout fixture must be one the engine guard actually claims",
    );
    await assert.rejects(
      () => deferForApiOverload({ ...overload, run_status: "failed" }, project()),
      "the overload fixture must be one the API-overload guard actually claims",
    );

    // And on 'stuck' — the same fixtures — all three decline, silently.
    assert.equal((await captureWarnings(() => deferForUsageWall(wall, project()))).value, false);
    assert.equal(
      (await captureWarnings(() => demoteAfterEngineFailure(dropout, project()))).value,
      false,
    );
    assert.equal(
      (await captureWarnings(() => deferForApiOverload(overload, project()))).value,
      false,
    );
  });

  test("deferForStuckRun does not fire on a 'failed' run", async () => {
    const failed = stuckTask({
      run_status: "failed",
      run_stuck_signal: "heartbeat_stale",
      run_session_id: null,
    });
    assert.equal((await captureWarnings(() => deferForStuckRun(failed, project()))).value, false);
  });
});

/* ========================================================================== *
 * SOURCE ASSERTIONS — the two contracts a test process cannot execute
 *
 * `requeueRunAfterStuck`'s rowcount contract needs real Postgres (T6's dry-run
 * harness). What CAN be pinned here is the SQL precondition it carries and the
 * shape of the call site, so a widened guard or a dropped fallback fails the
 * suite instead of quietly becoming a way to resurrect a cancelled run.
 * Same technique, and the same reason, as cp2-reconciler-interaction.test.ts.
 * ========================================================================== */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function sliceBetween(src: string, from: string, to: string, label: string): string {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `${label}: start marker ${JSON.stringify(from)} not found`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `${label}: end marker ${JSON.stringify(to)} not found after the start`);
  return src.slice(start, end);
}

describe("requeueRunAfterStuck's SQL is the safety argument", () => {
  /* The end marker is the NEXT function, not `runCounts`. cp2-reconciler-
   * interaction.test.ts states the rule this file had to learn the hard way: a
   * new thread writer goes ABOVE a marker, never between a marker and its
   * terminator — landing this function between `requeueRunAfterUsageWall` and
   * `runCounts` put two `pool.query` calls inside that test's slice and turned
   * its one-statement assertion red. */
  const body = sliceBetween(
    readSource("../db/runs.ts"),
    "export async function requeueRunAfterStuck",
    "export async function requeueRunAfterApiOverload",
    "requeueRunAfterStuck",
  );

  test("it may un-terminate a stale-heartbeat 'stuck' row and NOTHING else", () => {
    // A 'cancelled' run was killed on purpose; a 'timeout' stuck owns its own
    // manual Resume path. Both terms must be in the WHERE, not in a caller.
    assert.match(body, /WHERE id = \$1\s*\n\s*AND status = 'stuck'\s*\n\s*AND stuck_signal = 'heartbeat_stale'/);
  });

  test("it is exactly one statement — no read-then-write window", () => {
    assert.equal((body.match(/pool\.query/g) ?? []).length, 1);
  });

  test("it clears the flip and does not park behind wake_after", () => {
    // There is no outage to wait out: the stall has already passed, so the work
    // should resume at the next claim.
    assert.match(body, /SET status = 'queued'/);
    assert.match(body, /wake_after = NULL/);
    assert.match(body, /completed_at = NULL/);
    assert.match(body, /stuck_signal = NULL/);
  });

  test("its counter is its own, not shared with the other two outages", () => {
    assert.match(body, /jsonb_build_object\('stuck_recovery_attempts', \$3::int\)/);
    assert.doesNotMatch(body, /usage_wall_attempts|api_overload_attempts/);
  });

  test("it reports whether the row actually moved", () => {
    assert.match(body, /return \(r\.rowCount \?\? 0\) > 0;/);
  });
});

describe("the call site", () => {
  const TICK = readSource("./project-tick.ts");

  test("deferForStuckRun is the FIRST of the four guards", () => {
    const branch = sliceBetween(
      TICK,
      'if (task.run_status !== "completed") {',
      'await setTaskStatus(task.id, "failed");',
      "settled non-completed branch",
    );
    const order = [
      "deferForStuckRun",
      "deferForUsageWall",
      "demoteAfterEngineFailure",
      "deferForApiOverload",
    ].map((fn) => branch.indexOf(`if (await ${fn}(task, project)) continue;`));
    for (const [i, at] of order.entries()) {
      assert.ok(at >= 0, `guard ${i} is not wired into the settled loop`);
    }
    assert.deepEqual([...order].sort((a, b) => a - b), order, "guards must run in this order");
  });

  test("the failure path is still there behind all four", () => {
    // The point of the change is that a stuck run stops REACHING this — not
    // that it stopped existing.
    const branch = sliceBetween(
      TICK,
      'if (task.run_status !== "completed") {',
      "if (isVerdictRole(task.role)) {",
      "settled non-completed branch",
    );
    assert.match(branch, /await setTaskStatus\(task\.id, "failed"\);/);
    assert.match(branch, /await setProjectStatus\(task\.project_id, "blocked"\);/);
  });

  test("the resume falls back rather than assuming a park that never happened", () => {
    const body = sliceBetween(
      TICK,
      "export async function deferForStuckRun(",
      "/** Notification source for the engine-fallback push",
      "deferForStuckRun",
    );
    assert.match(body, /const resumed = await requeueRunAfterStuck\(\{/);
    assert.match(body, /if \(!resumed\) \{/);
    assert.match(body, /return false;/);
    // The note is the fleet's answer to the "already done" redispatch defect —
    // it must come from stuck-recovery.ts, not be re-worded inline here.
    assert.match(body, /note: stuckResumeNote\(\{ attempt: plan\.attempt \}\)/);
  });

  test("the projectAcceptsWork refusal sits BELOW the plan, gating resume only", () => {
    // The behavioural halves of this are the two refusal tests above; this is
    // the structural pin, because the defect was a matter of ORDER and a
    // future edit that moves the guard back to the top of the function would
    // otherwise only be caught by whichever of those two tests someone happened
    // to keep. Reverting the order reddens this immediately.
    const body = sliceBetween(
      TICK,
      "export async function deferForStuckRun(",
      "/** Notification source for the engine-fallback push",
      "deferForStuckRun",
    );
    const plan = body.indexOf("const plan = planStuckRecovery({");
    const hold = body.indexOf('if (plan.action === "hold") {');
    const gate = body.indexOf("if (!project || !projectAcceptsWork(project.status)) {");
    const requeue = body.indexOf("const resumed = await requeueRunAfterStuck({");
    assert.ok(plan >= 0 && hold >= 0 && gate >= 0 && requeue >= 0, "all four anchors present");
    assert.ok(plan < gate, "the project-status refusal must not run before the plan is known");
    assert.ok(hold < gate, "the hold path must return before the project-status refusal");
    assert.ok(gate < requeue, "…and the refusal must still precede the re-queue write");
    assert.equal(
      (body.match(/projectAcceptsWork\(/g) ?? []).length,
      1,
      "exactly one project-status term in this function — a second one would re-open the hold",
    );
  });

  test("project-tick does not import from executor.ts", () => {
    // projectTick() is CALLED from executor.ts, so a back-import would close a
    // module cycle — and a top-level const on either side of one throws TDZ at
    // BOOT, which no typecheck and no unit test would have shown.
    assert.doesNotMatch(TICK, /from "\.\.\/executor\.ts"/);
  });
});

describe("listSettledRunningTasks projects what the guard reads", () => {
  const body = sliceBetween(
    readSource("../db/projects.ts"),
    "export async function listSettledRunningTasks",
    "/** Every gating task of one project+round",
    "listSettledRunningTasks",
  );

  test("the three new columns are in the projection", () => {
    assert.match(body, /r\.stuck_signal AS run_stuck_signal/);
    assert.match(
      body,
      /COALESCE\(\(r\.metadata->>'stuck_recovery_attempts'\)::int, 0\) AS stuck_recovery_attempts/,
    );
    assert.match(body, /r\.metadata->>'cc_session_id' AS run_session_id/);
  });

  test("'stuck' is still returned as settled", () => {
    // The fix is in how it is READ, not in hiding it: a stuck task that is
    // invisible here goes back to sitting 'running' forever with no owner (E4).
    assert.match(body, /AND r\.status IN \('completed','failed','cancelled','stuck'\)/);
  });

  test("the docstring no longer claims a stuck process is gone or hung", () => {
    // That sentence WAS the bug, in prose, and a future reader who believes it
    // will re-introduce the failure path. safe-restart.sh:11-13 has said the
    // opposite verbatim all along.
    const doc = sliceBetween(
      readSource("../db/projects.ts"),
      "/** Tasks whose run has settled",
      "export interface SettledRunningTask",
      "SettledRunningTask docstring",
    );
    assert.match(doc, /safe-restart\.sh:11-13/);
    assert.match(doc, /very much alive and working/);
    // The old sentence is still there — quoted, and labelled. Retiring it
    // silently would let the next reader re-derive it; naming it as the defect
    // is what stops that.
    assert.match(doc, /THAT SENTENCE WAS THE BUG, IN PROSE/);
    assert.match(doc, /may NOT read `run_status = 'stuck'` as "the work\s+\*\s+failed"/);
  });
});
