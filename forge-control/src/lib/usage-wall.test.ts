/**
 * Tests for usage-wall classification, reset parsing, backoff and outage dedup.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The strings in U1 are not invented. They are the exact `content` values of
 * the error entries in `runs.thread` on this host — including the two written
 * during the 2026-08-05 outage this round exists to prevent. If the CLI's
 * wording ever moves, these are the tests that go red, and going red is the
 * point: an unrecognised wall silently reverts the fleet to blocking itself.
 *
 * The most important test in the file is U4 "the real incident": hit at 09:14,
 * resets at 13:10, recovered on the FIRST retry. A naive 15/30/60 ladder fails
 * that case — it exhausts itself at 11:00 and hard-fails — which is why
 * parseResetAt() exists at all.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyUsageWall,
  parseResetAt,
  planUsageWallRetry,
  shouldAnnounceOutage,
  outageMessage,
  formatDelay,
  USAGE_WALL_BACKOFF_MS,
  USAGE_WALL_MAX_RETRIES,
  USAGE_WALL_MAX_DEFER_MS,
  USAGE_WALL_MIN_DEFER_MS,
  USAGE_WALL_RESET_GRACE_MS,
  OUTAGE_ANNOUNCE_WINDOW_MS,
} from "./usage-wall.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Verbatim from the `runs` table. */
const SESSION_WALL =
  "Executor failed: claude-code exit 1: You've hit your session limit · resets 1:10pm (Europe/Berlin)";
const WEEKLY_WALL =
  "Executor failed: claude-code exit 1: You've hit your weekly limit · resets Jul 7, 2pm (Europe/Berlin)";

/* ========================================================================== *
 * U1 — classifyUsageWall
 * ========================================================================== */

describe("U1 classifyUsageWall", () => {
  test("the incident's own error line => session wall, hint captured verbatim", () => {
    assert.deepEqual(classifyUsageWall(SESSION_WALL), {
      kind: "session",
      resetHint: "1:10pm (Europe/Berlin)",
    });
  });

  test("weekly wall => weekly, dated hint captured verbatim", () => {
    assert.deepEqual(classifyUsageWall(WEEKLY_WALL), {
      kind: "weekly",
      resetHint: "Jul 7, 2pm (Europe/Berlin)",
    });
  });

  test("the other two live wordings also classify", () => {
    assert.equal(
      classifyUsageWall(
        "Executor failed: claude-code exit 1: You've hit your session limit · resets 8pm (Europe/Berlin)",
      )?.kind,
      "session",
    );
    assert.equal(
      classifyUsageWall(
        "Executor failed: claude-code exit 1: You've hit your weekly limit · resets 2pm (Europe/Berlin)",
      )?.kind,
      "weekly",
    );
  });

  test("older CLI wording (usage limit reached) => unspecified, still a wall", () => {
    const sig = classifyUsageWall(
      "Executor failed: Claude usage limit reached. Your limit will reset at 3pm (Europe/Berlin)",
    );
    assert.equal(sig?.kind, "unspecified");
    assert.equal(sig?.resetHint, "3pm (Europe/Berlin)");
  });

  test("a wall with no reset clause is still a wall, with a null hint", () => {
    assert.deepEqual(
      classifyUsageWall("Executor failed: claude-code exit 1: You've hit your session limit"),
      { kind: "session", resetHint: null },
    );
  });

  test("typographic apostrophe survives (CLI renders both)", () => {
    assert.equal(classifyUsageWall("You’ve hit your weekly limit")?.kind, "weekly");
  });

  /* --- the negatives, which are the safety-critical half ------------------ */

  test("API rate limiting is NOT a usage wall", () => {
    // account-health.ts already classifies these as `rate_limit`; they clear in
    // seconds. Parking a task 15 minutes over one would be self-inflicted.
    assert.equal(classifyUsageWall("Executor failed: 429 Too Many Requests"), null);
    assert.equal(classifyUsageWall("Executor failed: rate limit exceeded, retry after 2s"), null);
    assert.equal(classifyUsageWall("Error: quota exceeded for requests per minute"), null);
  });

  test("real failures are NOT usage walls", () => {
    assert.equal(classifyUsageWall("Executor failed: claude-code exit 1: ENOENT /tmp/x"), null);
    assert.equal(classifyUsageWall("Run blocked: Daily spend cap — daily spend EUR 202 exceeds cap EUR 200"), null);
    assert.equal(classifyUsageWall("Timed out after 600s. Use Resume to continue from this point."), null);
    assert.equal(classifyUsageWall("Executor failed: failed to authenticate"), null);
  });

  test("empty and absent input are not walls", () => {
    assert.equal(classifyUsageWall(null), null);
    assert.equal(classifyUsageWall(undefined), null);
    assert.equal(classifyUsageWall(""), null);
  });

  test("the hint is read off the LAST line, not an earlier stray 'reset'", () => {
    const sig = classifyUsageWall(
      "Executor failed: reset the session first\nclaude-code exit 1: You've hit your session limit · resets 8pm (Europe/Berlin)",
    );
    assert.equal(sig?.resetHint, "8pm (Europe/Berlin)");
  });
});

/* ========================================================================== *
 * U2 — parseResetAt
 * ========================================================================== */

describe("U2 parseResetAt", () => {
  test("session hint resolves to the right instant in Europe/Berlin (CEST, +2)", () => {
    const now = Date.UTC(2026, 7, 5, 9, 14, 17); // the incident
    assert.equal(parseResetAt("1:10pm (Europe/Berlin)", now), Date.UTC(2026, 7, 5, 11, 10));
  });

  test("dated weekly hint: the day is a DATE, never the hour", () => {
    // The trap this regression guards: reading "Jul 7, 2pm" as 07:00 parses
    // cleanly, looks right in the log, and wakes the fleet seven hours early.
    const now = Date.UTC(2026, 6, 6, 12, 0);
    assert.equal(parseResetAt("Jul 7, 2pm (Europe/Berlin)", now), Date.UTC(2026, 6, 7, 12, 0));
  });

  test("a time already past today rolls to tomorrow", () => {
    const now = Date.UTC(2026, 7, 5, 20, 0); // 22:00 Berlin
    assert.equal(parseResetAt("9pm (Europe/Berlin)", now), Date.UTC(2026, 7, 6, 19, 0));
  });

  test("the offset is sampled at the target instant, not hardcoded (CET, +1)", () => {
    const now = Date.UTC(2026, 10, 10, 6, 0);
    assert.equal(parseResetAt("2pm (Europe/Berlin)", now), Date.UTC(2026, 10, 10, 13, 0));
  });

  test("a target on the spring-forward day resolves through the DST gap", () => {
    // 2026-03-29: Berlin jumps 02:00 CET -> 03:00 CEST at 01:00 UTC.
    const now = Date.UTC(2026, 2, 29, 0, 30);
    assert.equal(parseResetAt("3:30am (Europe/Berlin)", now), Date.UTC(2026, 2, 29, 1, 30));
  });

  test("a dated hint far in the past means the year wrapped", () => {
    const now = Date.UTC(2026, 11, 30, 12, 0);
    assert.equal(parseResetAt("Jan 3, 9am (Europe/Berlin)", now), Date.UTC(2027, 0, 3, 8, 0));
  });

  test("midnight and noon", () => {
    const now = Date.UTC(2026, 7, 5, 9, 0); // 11:00 Berlin
    assert.equal(parseResetAt("12am (Europe/Berlin)", now), Date.UTC(2026, 7, 5, 22, 0)); // tomorrow 00:00
    assert.equal(parseResetAt("12pm (Europe/Berlin)", now), Date.UTC(2026, 7, 5, 10, 0)); // today 12:00
  });

  test("24h rendering parses", () => {
    const now = Date.UTC(2026, 7, 5, 9, 0);
    assert.equal(parseResetAt("13:10 (Europe/Berlin)", now), Date.UTC(2026, 7, 5, 11, 10));
  });

  test("a zone name with digits does not leak into the time", () => {
    // Etc/GMT+2 is a real IANA zone and its offset is UTC-2 (POSIX sign flip);
    // what matters here is that the '2' never becomes the hour.
    const now = Date.UTC(2026, 7, 5, 9, 0);
    const at = parseResetAt("5pm (Etc/GMT+2)", now);
    assert.equal(at, Date.UTC(2026, 7, 5, 19, 0));
  });

  /* --- refusals: null is a valid, expected answer ------------------------- */

  test("no zone => null (never guess UTC)", () => {
    assert.equal(parseResetAt("1:10pm", Date.UTC(2026, 7, 5, 9, 0)), null);
  });

  test("unknown zone => null", () => {
    assert.equal(parseResetAt("1:10pm (Mars/Olympus)", Date.UTC(2026, 7, 5, 9, 0)), null);
  });

  test("a bare integer is not a time => null", () => {
    assert.equal(parseResetAt("soon (Europe/Berlin)", Date.UTC(2026, 7, 5, 9, 0)), null);
    assert.equal(parseResetAt("in 3 (Europe/Berlin)", Date.UTC(2026, 7, 5, 9, 0)), null);
  });

  test("out-of-range clock values are refused, not clamped", () => {
    const now = Date.UTC(2026, 7, 5, 9, 0);
    assert.equal(parseResetAt("25:00 (Europe/Berlin)", now), null);
    assert.equal(parseResetAt("13pm (Europe/Berlin)", now), null);
    assert.equal(parseResetAt("1:99pm (Europe/Berlin)", now), null);
  });

  test("null/empty hint => null", () => {
    assert.equal(parseResetAt(null, 0), null);
    assert.equal(parseResetAt(undefined, 0), null);
    assert.equal(parseResetAt("", 0), null);
  });
});

/* ========================================================================== *
 * U3 — planUsageWallRetry
 * ========================================================================== */

describe("U3 planUsageWallRetry", () => {
  const NOW = Date.UTC(2026, 7, 5, 9, 14, 17);

  test("no reset hint => the 15/30/60 ladder, in order", () => {
    const delays = [0, 1, 2].map((prior) => {
      const p = planUsageWallRetry({ priorAttempts: prior, nowMs: NOW, resetAtMs: null });
      assert.equal(p.action, "defer");
      assert.equal(p.action === "defer" && p.basis, "backoff_ladder");
      return p.action === "defer" ? p.delayMs : -1;
    });
    assert.deepEqual(delays, [15 * MIN, 30 * MIN, 60 * MIN]);
    assert.deepEqual(delays, [...USAGE_WALL_BACKOFF_MS]);
  });

  test("attempt is 1-based and advances with the ladder", () => {
    const p = planUsageWallRetry({ priorAttempts: 1, nowMs: NOW, resetAtMs: null });
    assert.equal(p.attempt, 2);
  });

  test("the cap gives up rather than retrying forever", () => {
    const p = planUsageWallRetry({
      priorAttempts: USAGE_WALL_MAX_RETRIES,
      nowMs: NOW,
      resetAtMs: null,
    });
    assert.equal(p.action, "give_up");
    assert.match(p.action === "give_up" ? p.reason : "", /retries already spent/);
  });

  test("a later reset time beats the ladder rung", () => {
    const reset = NOW + 4 * HOUR;
    const p = planUsageWallRetry({ priorAttempts: 0, nowMs: NOW, resetAtMs: reset });
    assert.equal(p.action, "defer");
    if (p.action !== "defer") return;
    assert.equal(p.basis, "reset_time");
    assert.equal(p.delayMs, 4 * HOUR + USAGE_WALL_RESET_GRACE_MS);
    assert.equal(p.wakeAtMs, reset + USAGE_WALL_RESET_GRACE_MS);
  });

  test("an EARLIER reset time does not shorten the rung", () => {
    // The published time is when the window rolls, not when capacity is free.
    const p = planUsageWallRetry({ priorAttempts: 0, nowMs: NOW, resetAtMs: NOW + 30_000 });
    assert.equal(p.action, "defer");
    assert.equal(p.action === "defer" && p.basis, "backoff_ladder");
    assert.equal(p.action === "defer" && p.delayMs, 15 * MIN);
  });

  test("a reset time in the past still costs the rung, never zero", () => {
    const p = planUsageWallRetry({ priorAttempts: 0, nowMs: NOW, resetAtMs: NOW - 3 * HOUR });
    assert.equal(p.action === "defer" && p.delayMs, 15 * MIN);
  });

  test("a multi-day reset is clamped to the deferral ceiling", () => {
    const p = planUsageWallRetry({
      priorAttempts: 0,
      nowMs: NOW,
      resetAtMs: NOW + 3 * 24 * HOUR,
    });
    assert.equal(p.action === "defer" && p.delayMs, USAGE_WALL_MAX_DEFER_MS);
  });

  test("the floor holds even against an absurd ladder", () => {
    const p = planUsageWallRetry({
      priorAttempts: 0,
      nowMs: NOW,
      resetAtMs: null,
      ladderMs: [0],
    });
    assert.equal(p.action === "defer" && p.delayMs, USAGE_WALL_MIN_DEFER_MS);
  });

  test("a corrupt attempt counter reads as zero, not as exhausted", () => {
    // Failing closed here would refuse to recover from the very outage this is
    // for. Failing open costs at most one extra park.
    for (const bad of [NaN, -3, Number.POSITIVE_INFINITY * 0]) {
      const p = planUsageWallRetry({ priorAttempts: bad, nowMs: NOW, resetAtMs: null });
      assert.equal(p.action, "defer");
      assert.equal(p.action === "defer" && p.attempt, 1);
    }
  });

  test("past the end of the ladder the last rung repeats", () => {
    const p = planUsageWallRetry({
      priorAttempts: 4,
      nowMs: NOW,
      resetAtMs: null,
      maxRetries: 6,
    });
    assert.equal(p.action === "defer" && p.delayMs, 60 * MIN);
  });

  test("an empty ladder gives up instead of dividing by nothing", () => {
    const p = planUsageWallRetry({
      priorAttempts: 0,
      nowMs: NOW,
      resetAtMs: null,
      ladderMs: [],
    });
    assert.equal(p.action, "give_up");
  });
});

/* ========================================================================== *
 * U4 — the real incident, end to end through the pure layer
 * ========================================================================== */

describe("U4 the 2026-08-05 outage", () => {
  test("classify -> parse -> plan recovers on the FIRST retry, no human", () => {
    const now = Date.UTC(2026, 7, 5, 9, 14, 17); // when run 8159ee4f died

    const sig = classifyUsageWall(SESSION_WALL);
    assert.ok(sig, "the incident's error must be recognised as a wall");

    const resetAt = parseResetAt(sig.resetHint, now);
    assert.equal(resetAt, Date.UTC(2026, 7, 5, 11, 10), "13:10 Berlin");

    const plan = planUsageWallRetry({ priorAttempts: 0, nowMs: now, resetAtMs: resetAt });
    assert.equal(plan.action, "defer");
    if (plan.action !== "defer") return;
    assert.equal(plan.basis, "reset_time");
    assert.equal(plan.wakeAtMs, Date.UTC(2026, 7, 5, 11, 12));
    // Under the ceiling, so the fleet really does sleep through and wake once.
    assert.ok(plan.delayMs < USAGE_WALL_MAX_DEFER_MS);
    assert.equal(formatDelay(plan.delayMs), "1h58m");
  });

  test("the ladder ALONE would not have recovered it — why parseResetAt exists", () => {
    const now = Date.UTC(2026, 7, 5, 9, 14, 17);
    const resetAt = Date.UTC(2026, 7, 5, 11, 10);
    let at = now;
    for (let prior = 0; prior < USAGE_WALL_MAX_RETRIES; prior++) {
      const p = planUsageWallRetry({ priorAttempts: prior, nowMs: at, resetAtMs: null });
      assert.equal(p.action, "defer");
      at = p.action === "defer" ? p.wakeAtMs : at;
    }
    // 09:14:17 + 15m + 30m + 60m = 10:59:17 UTC. The wall lifts at 11:10 UTC.
    // Eleven minutes short: the ladder alone hard-fails the task and blocks
    // both projects all over again, and it does so having burned three retries.
    assert.ok(at < resetAt, `ladder exhausts at ${new Date(at).toISOString()}`);
    assert.ok(resetAt - at < 15 * MIN, "and only just — the near-miss is the point");
  });
});

/* ========================================================================== *
 * U5 — one push per outage
 * ========================================================================== */

describe("U5 shouldAnnounceOutage", () => {
  const NOW = Date.UTC(2026, 7, 5, 9, 14, 17);

  test("nothing on record => announce", () => {
    assert.equal(shouldAnnounceOutage(null, NOW), true);
  });

  test("an unreadable timestamp => announce (silence is the worse failure)", () => {
    assert.equal(shouldAnnounceOutage(NaN, NOW), true);
  });

  test("the other ten tasks of the same wall are suppressed", () => {
    // 2026-08-05: eleven runs across two projects died inside 90 seconds.
    assert.equal(shouldAnnounceOutage(NOW - 80_000, NOW), false);
    assert.equal(shouldAnnounceOutage(NOW - 3 * HOUR, NOW), false);
  });

  test("a genuinely new outage past the window is announced again", () => {
    assert.equal(shouldAnnounceOutage(NOW - OUTAGE_ANNOUNCE_WINDOW_MS, NOW), true);
    assert.equal(shouldAnnounceOutage(NOW - 2 * OUTAGE_ANNOUNCE_WINDOW_MS, NOW), true);
  });

  test("the window is exactly one park, so one wall can only speak once", () => {
    assert.equal(OUTAGE_ANNOUNCE_WINDOW_MS, USAGE_WALL_MAX_DEFER_MS);
  });
});

/* ========================================================================== *
 * U6 — the human-facing strings
 * ========================================================================== */

describe("U6 formatDelay / outageMessage", () => {
  test("formatDelay", () => {
    assert.equal(formatDelay(15 * MIN), "15m");
    assert.equal(formatDelay(59 * MIN), "59m");
    assert.equal(formatDelay(60 * MIN), "1h");
    assert.equal(formatDelay(3 * HOUR + 58 * MIN), "3h58m");
    assert.equal(formatDelay(6 * HOUR), "6h");
  });

  test("the push names the wall, the reset and the return, and says do nothing", () => {
    const msg = outageMessage({
      kind: "session",
      resetHint: "1:10pm (Europe/Berlin)",
      delayMs: HOUR + 58 * MIN,
      wakeAtLabel: "05.08.26, 13:12",
    });
    assert.match(msg, /5-hour session limit/);
    assert.match(msg, /resets 1:10pm \(Europe\/Berlin\)/);
    assert.match(msg, /1h58m/);
    assert.match(msg, /05\.08\.26, 13:12/);
    assert.match(msg, /auto-resume/);
    // The two facts that separate this from the old 🚫: nothing failed and
    // nothing is blocked.
    assert.match(msg, /not failed/);
    assert.match(msg, /no project was blocked/);
    // Telegram turns are capped around 1200 chars.
    assert.ok(msg.length < 400, `push is ${msg.length} chars`);
  });

  test("a wall with no reset clause still produces a clean sentence", () => {
    const msg = outageMessage({
      kind: "weekly",
      resetHint: null,
      delayMs: 15 * MIN,
      wakeAtLabel: "05.08.26, 09:29",
    });
    assert.match(msg, /weekly limit hit\./);
    assert.doesNotMatch(msg, /resets/);
  });
});
