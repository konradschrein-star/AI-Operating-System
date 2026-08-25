/**
 * Tests for the stuck-run recovery classifier and planner.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * One test per row of PLAN.md §2(b)'s decision table, plus the negative case
 * (a genuinely dead, attempt-exhausted run still fails) and the hostile
 * `priorAttempts` case (NaN, -1) — a non-finite counter must not buy infinite
 * retries.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyStuck,
  planStuckRecovery,
  stuckResumeNote,
  STUCK_RECOVERY_MAX_ATTEMPTS,
} from "./stuck-recovery.ts";

describe("S1 classifyStuck", () => {
  test("recognises the watchdog's own signal", () => {
    assert.equal(classifyStuck("heartbeat_stale"), "heartbeat_stale");
  });

  test("recognises the wall-clock timeout signal", () => {
    assert.equal(classifyStuck("timeout"), "timeout");
  });

  test("falls back to unknown for anything else, including null", () => {
    assert.equal(classifyStuck(null), "unknown");
    assert.equal(classifyStuck(""), "unknown");
    assert.equal(classifyStuck("some_future_signal"), "unknown");
  });
});

describe("S2 planStuckRecovery — the decision table", () => {
  test("row 1: kind !== heartbeat_stale -> give_up naming the kind (timeout)", () => {
    const plan = planStuckRecovery({
      kind: "timeout",
      processAlive: true,
      priorAttempts: 0,
    });
    assert.equal(plan.action, "give_up");
    assert.match(plan.reason, /timeout/);
  });

  test("row 1b: kind === unknown -> give_up naming the kind", () => {
    const plan = planStuckRecovery({
      kind: "unknown",
      processAlive: false,
      priorAttempts: 0,
    });
    assert.equal(plan.action, "give_up");
    assert.match(plan.reason, /unknown/);
  });

  test("row 2: heartbeat_stale + processAlive -> hold, regardless of attempts", () => {
    const plan = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: true,
      priorAttempts: 1,
    });
    assert.deepEqual(plan, {
      action: "hold",
      reason:
        "process is alive: the watchdog mistook a latency stall for a dead run, the turn will land its own completion",
    });
  });

  test("row 3: heartbeat_stale + !processAlive + priorAttempts < max -> resume, attempt+1", () => {
    const plan = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: false,
      priorAttempts: 0,
    });
    assert.equal(plan.action, "resume");
    assert.equal((plan as { attempt: number }).attempt, 1);

    const plan2 = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: false,
      priorAttempts: 1,
    });
    assert.equal(plan2.action, "resume");
    assert.equal((plan2 as { attempt: number }).attempt, 2);
  });

  test("row 4 (negative case): dead run, attempts exhausted -> give_up, ordinary failure path still runs", () => {
    const plan = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: false,
      priorAttempts: STUCK_RECOVERY_MAX_ATTEMPTS,
    });
    assert.equal(plan.action, "give_up");
    assert.match(plan.reason, /exhausted|already resumed/i);
  });

  test("hostile priorAttempts: NaN normalises to 0 and still gets a resume", () => {
    const plan = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: false,
      priorAttempts: NaN,
    });
    assert.equal(plan.action, "resume");
    assert.equal((plan as { attempt: number }).attempt, 1);
  });

  test("hostile priorAttempts: -1 normalises to 0, not a bonus retry", () => {
    const plan = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: false,
      priorAttempts: -1,
    });
    assert.equal(plan.action, "resume");
    assert.equal((plan as { attempt: number }).attempt, 1);
  });

  test("hostile priorAttempts: +Infinity normalises to 0, not to infinite retries", () => {
    // Non-finite is normalised to a floor of 0 attempts USED — it does not
    // buy the run infinite resumes; STUCK_RECOVERY_MAX_ATTEMPTS still applies
    // on every subsequent call, since a stored attempt count only ever grows
    // by the plan's own `attempt` field, never by re-reading Infinity.
    const plan = planStuckRecovery({
      kind: "heartbeat_stale",
      processAlive: false,
      priorAttempts: Infinity,
    });
    assert.equal(plan.action, "resume");
    assert.equal((plan as { attempt: number }).attempt, 1);
  });
});

describe("S3 stuckResumeNote", () => {
  test("tells the agent it was not its fault, and to check before redoing", () => {
    const note = stuckResumeNote({ attempt: 1 });
    assert.match(note, /\[Fleet notice\]/);
    assert.match(note, /not by anything you did/);
    assert.match(note, /git status/);
    assert.match(note, /git log/);
    assert.match(note, /check what you already committed/i);
    assert.match(note, /do not redo work that is already done/i);
  });

  test("reports the attempt number and the ceiling", () => {
    const note = stuckResumeNote({ attempt: 2 });
    assert.match(note, new RegExp(`2/${STUCK_RECOVERY_MAX_ATTEMPTS}`));
  });
});
