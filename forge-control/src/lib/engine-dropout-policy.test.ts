/**
 * What happens to a task the free engine dropped.
 *
 * ## Why this exists
 *
 * This path had NO test at all, which is how it stayed wrong for so long.
 * `demoteAfterEngineFailure` handed a dropped gemini task straight to Claude on
 * its FIRST envelope error, and that is the single largest reason Konrad kept
 * finding Claude runs on a fleet he had explicitly pinned to gemini.
 *
 * The measurement that changed the policy, over this fleet's whole history,
 * grouped by task title:
 *
 *     succeeded on the 1st gemini attempt        25
 *     succeeded after 1 retry                    11
 *     succeeded after 2 retries                   3
 *     succeeded after 3+ retries                  3
 *     never succeeded on gemini                  47
 *       ...of those, given only ONE attempt      26
 *       ...of those, later run on claude         44
 *
 * 17 of the 42 titles that were ever retried succeeded ONLY because of the
 * retry, while 26 were demoted after one drop and never got the second attempt
 * that worked for so many of their neighbours.
 *
 * The decision is a pure function precisely so these branches are reachable
 * without a database.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_FALLBACK_TIER,
  ENGINE_RETRIES_BEFORE_FALLBACK,
  decideDropoutAction,
  isEngineDropout,
  tierCanDropOut,
  type DropoutFacts,
} from "./engine-fallback";

/** A genuine dropout on a healthy project, first attempt. */
const base: DropoutFacts = {
  tier: "gemini",
  runStatus: "failed",
  runId: "11111111-1111-1111-1111-111111111111",
  lastError: "agy returned status ERROR with no response text.",
  attempt: 0,
  projectAcceptsWork: true,
};

describe("a dropped gemini task is retried on gemini before Claude sees it", () => {
  test("first drop retries on the same engine", () => {
    assert.equal(decideDropoutAction(base), "retry-same-tier");
  });

  test("once the retries are spent it goes to the fallback", () => {
    assert.equal(
      decideDropoutAction({ ...base, attempt: ENGINE_RETRIES_BEFORE_FALLBACK }),
      "demote",
    );
    assert.equal(
      decideDropoutAction({ ...base, attempt: ENGINE_RETRIES_BEFORE_FALLBACK + 5 }),
      "demote",
    );
  });

  test("the retry budget is bounded — this cannot loop forever", () => {
    assert.ok(Number.isInteger(ENGINE_RETRIES_BEFORE_FALLBACK));
    assert.ok(ENGINE_RETRIES_BEFORE_FALLBACK >= 1, "0 is the old straight-to-Claude behaviour");
    assert.ok(ENGINE_RETRIES_BEFORE_FALLBACK <= 3, "an unbounded retry starves the queue");
  });

  test("the fallback is the cheap Claude, not the expensive one", () => {
    // Documented reason: the daily Claude cap had already been blown (EUR 124
    // of EUR 100). Falling back to `standard` would put the queue on the most
    // expensive model in the ladder.
    assert.equal(ENGINE_FALLBACK_TIER, "junior");
  });
});

describe("what must NOT be laundered into a retry", () => {
  test("a Claude failure is a real failure", () => {
    for (const tier of ["fast", "junior", "standard", "flagship"] as const) {
      assert.equal(decideDropoutAction({ ...base, tier }), "none", `${tier} must not retry`);
      assert.equal(tierCanDropOut(tier), false);
    }
    assert.equal(decideDropoutAction({ ...base, tier: null }), "none");
  });

  test("a task whose WORK failed is not a dropout", () => {
    // The engine ran and the work failed. Retrying it just fails again.
    assert.equal(
      decideDropoutAction({ ...base, lastError: "TypeError: cannot read property 'x' of undefined" }),
      "none",
    );
    assert.equal(decideDropoutAction({ ...base, lastError: null }), "none");
    assert.equal(isEngineDropout("TypeError: boom"), false);
  });

  test("only a failed run with a run id qualifies", () => {
    assert.equal(decideDropoutAction({ ...base, runStatus: "completed" }), "none");
    assert.equal(decideDropoutAction({ ...base, runStatus: null }), "none");
    assert.equal(decideDropoutAction({ ...base, runId: null }), "none");
  });

  test("a project that is not accepting work is never re-queued", () => {
    // The fallback tier is PAID: re-queuing here would smuggle billable work
    // past a gate somebody closed on purpose. Applies to the free retry too —
    // a paused project should not be running anything.
    assert.equal(decideDropoutAction({ ...base, projectAcceptsWork: false }), "none");
    assert.equal(
      decideDropoutAction({ ...base, projectAcceptsWork: false, attempt: 9 }),
      "none",
    );
  });
});

describe("the dropout signatures that count", () => {
  test("all three agy envelope failures are recognised", () => {
    assert.ok(isEngineDropout("agy returned status ERROR with no response text."));
    assert.ok(isEngineDropout("agy produced no parseable JSON"));
    assert.ok(isEngineDropout("agy exceeded 900000ms"));
  });

  test("empty and near-miss text are not", () => {
    assert.equal(isEngineDropout(""), false);
    assert.equal(isEngineDropout(null), false);
    assert.equal(isEngineDropout(undefined), false);
    assert.equal(isEngineDropout("agy returned status ERROR with a response"), false);
  });
});
