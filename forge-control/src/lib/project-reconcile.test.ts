/**
 * Tests for the reviewer-round consolidation module.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * T-numbers below are quoted from docs/plan/03-quality.md §1; the phase gate
 * cites them by number, so each `describe` block is named after one.
 *
 * The most important test in this file is T3 "dual NEEDS_FIXES" — it is the
 * direct regression guard for the first-night bug: two reviewers each firing
 * their own fix chain. `consolidateReviewerRound()` returns a single
 * `RoundDecision`, not an array, which makes a duplicate chain a type error
 * as much as a logic error.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseVerdict,
  projectAcceptsWork,
  consolidateReviewerRound,
  chainKeys,
  noteGroupFailure,
  clearGroupFailures,
  type ReviewerInput,
} from "./project-reconcile.ts";

function rv(over: Partial<ReviewerInput> = {}): ReviewerInput {
  return {
    taskId: "t1",
    title: "Review",
    fixCycle: 0,
    settled: true,
    lastText: "VERDICT: PASS",
    ...over,
  };
}

/* ========================================================================== *
 * T1 — parseVerdict
 * ========================================================================== */

describe("T1 parseVerdict", () => {
  test("reasoning quotes NEEDS_FIXES mid-text but ENDS with PASS => PASS (last occurrence wins)", () => {
    // This is the exact bug being fixed: the engine's original expression had
    // no /g flag and took the FIRST match, which read the rehearsal instead
    // of the declaration.
    const text =
      "I will answer with VERDICT: NEEDS_FIXES if the tests fail, but they " +
      "all pass.\n\nVERDICT: PASS";
    assert.equal(parseVerdict(text), "PASS");
  });

  test("reverse order — PASS quoted first, NEEDS_FIXES declared last => NEEDS_FIXES", () => {
    const text =
      "VERDICT: PASS is what I'd say if everything were fine, but it's not.\n\n" +
      "VERDICT: NEEDS_FIXES";
    assert.equal(parseVerdict(text), "NEEDS_FIXES");
  });

  test("no VERDICT line => null", () => {
    assert.equal(parseVerdict("Looks fine to me, ship it."), null);
  });

  test("null input => null", () => {
    assert.equal(parseVerdict(null), null);
  });

  test("empty string => null", () => {
    assert.equal(parseVerdict(""), null);
  });

  test("whitespace-only string => null", () => {
    assert.equal(parseVerdict("   \n\t  "), null);
  });

  test("case and spacing variance the module DOES accept", () => {
    assert.equal(parseVerdict("verdict:   pass"), "PASS");
    assert.equal(parseVerdict("**VERDICT: PASS**"), "PASS");
  });

  test("VERDICT:PASS with no space IS matched — \\s* means zero-or-more, not one-or-more", () => {
    // Documenting the real contract, not the intuitive one: \s* in the
    // module's regex admits zero whitespace characters, so the tight form
    // parses too. This is asserted explicitly rather than assumed.
    assert.equal(parseVerdict("VERDICT:PASS"), "PASS");
    assert.equal(parseVerdict("VERDICT:NEEDS_FIXES"), "NEEDS_FIXES");
  });
});

/* ========================================================================== *
 * T2 — single reviewer
 * ========================================================================== */

describe("T2 single reviewer", () => {
  test("one settled PASS => {action: 'pass'}", () => {
    const decision = consolidateReviewerRound(1, [rv({ lastText: "VERDICT: PASS" })], 3);
    assert.deepEqual(decision, { action: "pass" });
  });

  test("one settled NEEDS_FIXES at fixCycle 0 => fix cycle 1 with title, feedback, and chain keys", () => {
    const decision = consolidateReviewerRound(
      1,
      [
        rv({
          title: "Reviewer A",
          fixCycle: 0,
          lastText: "The error handling is missing.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 1);
    assert.match(decision.mergedBrief, /Reviewer A/);
    assert.match(decision.mergedBrief, /The error handling is missing\./);
    assert.equal(decision.builderChainKey, "fix:1:1");
    assert.equal(decision.reviewerChainKey, "rereview:1:1");
  });
});

/* ========================================================================== *
 * T3 — dual NEEDS_FIXES (the headline case: the duplicate-chain bug)
 * ========================================================================== */

describe("T3 dual NEEDS_FIXES", () => {
  test("two settled NEEDS_FIXES reviewers fold into exactly ONE fix decision carrying both", () => {
    const decision = consolidateReviewerRound(
      5,
      [
        rv({
          taskId: "r1",
          title: "Reviewer A",
          fixCycle: 0,
          lastText: "Missing null check on line 42.\nVERDICT: NEEDS_FIXES",
        }),
        rv({
          taskId: "r2",
          title: "Reviewer B",
          fixCycle: 0,
          lastText: "The migration is not idempotent.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    // `consolidateReviewerRound` returns a single `RoundDecision`, not an
    // array of decisions — that return type is itself what makes duplicate
    // fix/re-review chains impossible: there is no second slot to put one in.
    assert.equal(typeof decision, "object");
    assert.equal(Array.isArray(decision), false);

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;

    assert.match(decision.mergedBrief, /Reviewer A/);
    assert.match(decision.mergedBrief, /Reviewer B/);
    assert.match(decision.mergedBrief, /Missing null check on line 42\./);
    assert.match(decision.mergedBrief, /The migration is not idempotent\./);

    assert.equal(decision.builderChainKey, "fix:5:1");
    assert.equal(decision.reviewerChainKey, "rereview:5:1");
  });
});

/* ========================================================================== *
 * T4 — mixed and all-PASS
 * ========================================================================== */

describe("T4 mixed and all-PASS", () => {
  test("settled PASS + settled NEEDS_FIXES => fix (NEEDS_FIXES wins), PASS text excluded from mergedBrief", () => {
    const decision = consolidateReviewerRound(
      2,
      [
        rv({
          taskId: "p1",
          title: "Reviewer Pass",
          lastText: "All good here, nothing to say — the diff is clean.\nVERDICT: PASS",
        }),
        rv({
          taskId: "f1",
          title: "Reviewer Fix",
          lastText: "The retry loop is unbounded.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.match(decision.mergedBrief, /Reviewer Fix/);
    assert.match(decision.mergedBrief, /The retry loop is unbounded\./);
    assert.doesNotMatch(decision.mergedBrief, /Reviewer Pass/);
    assert.doesNotMatch(decision.mergedBrief, /nothing to say — the diff is clean/);
  });

  test("two settled PASS (N=2) => pass", () => {
    const decision = consolidateReviewerRound(
      2,
      [
        rv({ taskId: "p1", title: "Reviewer 1", lastText: "VERDICT: PASS" }),
        rv({ taskId: "p2", title: "Reviewer 2", lastText: "VERDICT: PASS" }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "pass" });
  });
});

/* ========================================================================== *
 * T5 — unsettled sibling (the race killer)
 * ========================================================================== */

describe("T5 unsettled sibling", () => {
  test("settled PASS + unsettled sibling => wait", () => {
    const decision = consolidateReviewerRound(
      3,
      [
        rv({ taskId: "p1", settled: true, lastText: "VERDICT: PASS" }),
        rv({ taskId: "p2", settled: false, lastText: null }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "wait" });
  });

  test("settled NEEDS_FIXES + unsettled sibling => wait", () => {
    const decision = consolidateReviewerRound(
      3,
      [
        rv({ taskId: "f1", settled: true, lastText: "VERDICT: NEEDS_FIXES" }),
        rv({ taskId: "p2", settled: false, lastText: null }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "wait" });
  });

  test("empty array => wait", () => {
    const decision = consolidateReviewerRound(3, [], 3);
    assert.deepEqual(decision, { action: "wait" });
  });
});

/* ========================================================================== *
 * T6 — unparseable verdict
 * ========================================================================== */

describe("T6 unparseable verdict", () => {
  test("one settled reviewer with no VERDICT line (sibling PASS) => block(no_verdict) naming the offending task", () => {
    const decision = consolidateReviewerRound(
      4,
      [
        rv({ taskId: "u1", title: "Silent Reviewer", lastText: "Looks okay I guess." }),
        rv({ taskId: "p1", title: "Reviewer Pass", lastText: "VERDICT: PASS" }),
      ],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /Silent Reviewer/);
  });

  test("no_verdict takes precedence over a sibling's NEEDS_FIXES (rule order c before d)", () => {
    const decision = consolidateReviewerRound(
      4,
      [
        rv({ taskId: "u1", title: "Silent Reviewer", lastText: "No verdict declared here." }),
        rv({ taskId: "f1", title: "Reviewer Fix", lastText: "VERDICT: NEEDS_FIXES" }),
      ],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /Silent Reviewer/);
  });
});

/* ========================================================================== *
 * T7 — max cycles + arithmetic
 * ========================================================================== */

describe("T7 max cycles and cycle arithmetic", () => {
  test("max fixCycle 3 and a NEEDS_FIXES at maxFixCycles=3 => block(max_cycles)", () => {
    const decision = consolidateReviewerRound(
      6,
      [rv({ taskId: "f1", fixCycle: 3, lastText: "VERDICT: NEEDS_FIXES" })],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "max_cycles");
  });

  test("same group at max fixCycle 2 (below ceiling) => fix at cycle 3", () => {
    const decision = consolidateReviewerRound(
      6,
      [rv({ taskId: "f1", fixCycle: 2, lastText: "VERDICT: NEEDS_FIXES" })],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 3);
  });

  test("mixed fixCycles in one group (0 and 2, one NEEDS_FIXES) => cycle = max+1 = 3, not 1", () => {
    const decision = consolidateReviewerRound(
      6,
      [
        rv({ taskId: "old", title: "Stale Reviewer", fixCycle: 0, lastText: "VERDICT: PASS" }),
        rv({ taskId: "new", title: "Fresh Reviewer", fixCycle: 2, lastText: "VERDICT: NEEDS_FIXES" }),
      ],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 3);
  });

  test("all-PASS group at fixCycle 3 => pass, NOT blocked — the ceiling only bites when fixes are still needed", () => {
    const decision = consolidateReviewerRound(
      6,
      [rv({ taskId: "p1", fixCycle: 3, lastText: "VERDICT: PASS" })],
      3,
    );
    assert.deepEqual(decision, { action: "pass" });
  });
});

/* ========================================================================== *
 * T8 — projectAcceptsWork
 * ========================================================================== */

describe("T8 projectAcceptsWork", () => {
  test("active => true", () => {
    assert.equal(projectAcceptsWork("active"), true);
  });

  test("paused => false", () => {
    assert.equal(projectAcceptsWork("paused"), false);
  });

  test("blocked => false", () => {
    assert.equal(projectAcceptsWork("blocked"), false);
  });

  test("done => false", () => {
    assert.equal(projectAcceptsWork("done"), false);
  });

  test("cancelled => false", () => {
    assert.equal(projectAcceptsWork("cancelled"), false);
  });
});

/* ========================================================================== *
 * T9 — chainKeys determinism
 * ========================================================================== */

describe("T9 chainKeys determinism", () => {
  test("same (round, cycle) called twice => identical strings", () => {
    const a = chainKeys(7, 2);
    const b = chainKeys(7, 2);
    assert.deepEqual(a, b);
  });

  test("different rounds => different strings", () => {
    const a = chainKeys(7, 2);
    const b = chainKeys(8, 2);
    assert.notEqual(a.builder, b.builder);
    assert.notEqual(a.reviewer, b.reviewer);
  });

  test("different cycles => different strings", () => {
    const a = chainKeys(7, 2);
    const b = chainKeys(7, 3);
    assert.notEqual(a.builder, b.builder);
    assert.notEqual(a.reviewer, b.reviewer);
  });

  test("literal formats fix:7:2 / rereview:7:2 — the DB partial unique index depends on these exact strings", () => {
    const keys = chainKeys(7, 2);
    assert.equal(keys.builder, "fix:7:2");
    assert.equal(keys.reviewer, "rereview:7:2");
  });
});

/* ========================================================================== *
 * T12 — repeated-failure escalation
 *
 * Guards finding 3 of the round-103 review: the per-group catch in
 * reconcileSettledTasks() used to log and retry forever, so a permanently
 * failing consolidation froze a project in silence.
 * ========================================================================== */

describe("T12 group-failure escalation", () => {
  const KEY = "proj-1:100";

  test("first failure counts but does not notify", () => {
    const counters = new Map<string, number>();
    assert.deepEqual(noteGroupFailure(counters, KEY, 3), { count: 1, notify: false });
  });

  test("notifies exactly once, on the threshold crossing", () => {
    const counters = new Map<string, number>();
    const notified: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = noteGroupFailure(counters, KEY, 3);
      if (r.notify) notified.push(r.count);
    }
    // Ten consecutive failures, one message — a stuck group must surface, not
    // storm.
    assert.deepEqual(notified, [3]);
    assert.equal(counters.get(KEY), 10);
  });

  test("groups are counted independently", () => {
    const counters = new Map<string, number>();
    noteGroupFailure(counters, "proj-1:100", 3);
    noteGroupFailure(counters, "proj-1:100", 3);
    const other = noteGroupFailure(counters, "proj-2:200", 3);
    assert.deepEqual(other, { count: 1, notify: false });
    assert.equal(counters.get("proj-1:100"), 2);
  });

  test("a success clears the counter — failures must be CONSECUTIVE", () => {
    const counters = new Map<string, number>();
    noteGroupFailure(counters, KEY, 3);
    noteGroupFailure(counters, KEY, 3);
    clearGroupFailures(counters, KEY);
    // Without the clear, this third failure would trip the threshold on a
    // group that recovered in between.
    assert.deepEqual(noteGroupFailure(counters, KEY, 3), { count: 1, notify: false });
  });

  test("clearing an unknown key is a no-op and leaves the map empty", () => {
    const counters = new Map<string, number>();
    clearGroupFailures(counters, "never-failed");
    assert.equal(counters.size, 0);
  });

  test("threshold 1 notifies on the first failure", () => {
    const counters = new Map<string, number>();
    assert.deepEqual(noteGroupFailure(counters, KEY, 1), { count: 1, notify: true });
  });
});
