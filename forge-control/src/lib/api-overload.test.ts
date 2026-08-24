/**
 * Tests for transient API-overload classification and the retry policy.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * REAL_529 is not invented. It is the exact `content` of the error entry the
 * executor wrote when this actually fired on 2026-08-24, copied out of the
 * failing run. If the CLI's wording drifts, this is the test that goes red,
 * and going red is the point: an unrecognised 529 reverts the fleet to
 * blocking a project over a busy server.
 *
 * The most important tests here are the negative ones. This classifier's
 * output PARKS a task instead of failing it, so a false positive hides a real
 * bug behind a retry loop that looks like progress. A failed task is visible
 * and retryable by hand; a task parked forever is neither.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyApiOverload,
  planApiOverloadRetry,
  API_OVERLOAD_DEFER_MS,
  API_OVERLOAD_MAX_RETRIES,
} from "./api-overload.ts";

const REAL_529 =
  "Executor failed: claude-code exit 1: API Error: 529 Overloaded. This is a " +
  "server-side issue, usually temporary — try again in a moment. If it " +
  "persists, check https://status.claude.com.";

describe("A1 classifyApiOverload", () => {
  test("recognises the real 529 the executor actually emitted", () => {
    assert.deepEqual(classifyApiOverload(REAL_529), {
      kind: "overloaded",
      status: 529,
    });
  });

  test("recognises the bare API-error form, without the executor prefix", () => {
    assert.deepEqual(classifyApiOverload("API Error: 529 Overloaded."), {
      kind: "overloaded",
      status: 529,
    });
  });

  test("recognises 'Overloaded' with no status number", () => {
    assert.deepEqual(classifyApiOverload("the API said Overloaded, try later"), {
      kind: "overloaded",
      status: null,
    });
  });

  test("treats 503 / service unavailable as the same class", () => {
    assert.deepEqual(classifyApiOverload("API Error: 503"), {
      kind: "unavailable",
      status: 503,
    });
    assert.equal(
      classifyApiOverload("503 Service Unavailable")?.kind,
      "unavailable",
    );
  });

  test("returns null for nothing at all", () => {
    assert.equal(classifyApiOverload(null), null);
    assert.equal(classifyApiOverload(undefined), null);
    assert.equal(classifyApiOverload(""), null);
  });
});

describe("A2 the narrowness is the feature", () => {
  test("does NOT claim failures that are not a busy server", () => {
    for (const text of [
      "claude-code exit 1: TypeError: cannot read property 'x' of undefined",
      "claude-code exit 2: tsc found 4 errors",
      "API Error: 500 Internal Server Error",
      "API Error: 429 rate limit",
      "claude-code went idle for 900s (no output at all)",
      "socket hang up",
      "ETIMEDOUT",
      "claude-code hit the 60min absolute ceiling",
    ]) {
      assert.equal(classifyApiOverload(text), null, text);
    }
  });

  test("yields to the usage wall, which knows its own reset time", () => {
    assert.equal(
      classifyApiOverload(
        "Executor failed: claude-code exit 1: You've hit your session limit · resets 1:10pm (Europe/Berlin)",
      ),
      null,
    );
    assert.equal(
      classifyApiOverload("You've hit your weekly limit · resets Monday"),
      null,
    );
  });

  test("prefers the usage wall even when both signatures appear", () => {
    // Contrived but possible. The wall must win: it knows when to come back,
    // this module only knows how to wait a minute.
    assert.equal(
      classifyApiOverload("session limit reached; server also Overloaded"),
      null,
    );
  });
});

describe("A3 planApiOverloadRetry", () => {
  const now = 1_700_000_000_000;

  test("defers a first hit by exactly one minute, as instructed", () => {
    assert.deepEqual(planApiOverloadRetry({ priorAttempts: 0, nowMs: now }), {
      action: "defer",
      attempt: 1,
      delayMs: 60_000,
      wakeAtMs: now + 60_000,
    });
    assert.equal(API_OVERLOAD_DEFER_MS, 60_000);
  });

  test("keeps the delay flat across attempts — no backoff ladder", () => {
    const delays = [0, 1, 2, 3, 4].map((priorAttempts) => {
      const p = planApiOverloadRetry({ priorAttempts, nowMs: now });
      assert.equal(p.action, "defer");
      return p.action === "defer" ? p.delayMs : -1;
    });
    assert.deepEqual(delays, [60_000, 60_000, 60_000, 60_000, 60_000]);
  });

  test("advances the persisted attempt counter", () => {
    const p = planApiOverloadRetry({ priorAttempts: 3, nowMs: now });
    assert.equal(p.action, "defer");
    if (p.action === "defer") assert.equal(p.attempt, 4);
  });

  test("gives up at the ceiling instead of retrying until morning", () => {
    const p = planApiOverloadRetry({
      priorAttempts: API_OVERLOAD_MAX_RETRIES,
      nowMs: now,
    });
    assert.equal(p.action, "give_up");
    if (p.action === "give_up") assert.match(p.reason, /max 5/);
  });

  test("a negative counter means no history, not a bonus retry", () => {
    const p = planApiOverloadRetry({ priorAttempts: -1, nowMs: now });
    assert.equal(p.action, "defer");
    if (p.action === "defer") assert.equal(p.attempt, 1);
  });

  test("non-finite metadata gives up rather than retrying unbounded", () => {
    // Unreachable in practice — the counter is read as `::int` from jsonb — so
    // this is purely about WHICH WAY to be wrong. Failing a task that could
    // have been retried shows up in the Kanban and costs one /retry; retrying
    // forever is invisible and burns a worker slot all night.
    for (const priorAttempts of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = planApiOverloadRetry({ priorAttempts, nowMs: now });
      assert.equal(p.action, "give_up", String(priorAttempts));
    }
  });
});
