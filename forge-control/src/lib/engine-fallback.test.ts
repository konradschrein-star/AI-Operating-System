import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isEngineDropout,
  tierCanDropOut,
  ENGINE_FALLBACK_TIER,
} from "./engine-fallback.ts";

/* The strings below are VERBATIM from `runs.thread` on the night of
 * 2026-08-22/23 — copied out of the incident, not invented — so a reword of
 * lib/gemini-runner.ts's throws fails these tests rather than silently
 * un-matching in production. */

test("E1: the three agy envelope failures are dropouts", () => {
  assert.equal(
    isEngineDropout("Executor failed: agy returned status ERROR with no response text."),
    true,
  );
  assert.equal(isEngineDropout("Executor failed: agy exceeded 600000ms"), true);
  assert.equal(
    isEngineDropout("Executor failed: agy produced no parseable JSON (exit 1)."),
    true,
  );
});

test("E2: a dropout is still a dropout with STDERR appended", () => {
  assert.equal(
    isEngineDropout(
      "Executor failed: agy returned status ERROR with no response text. STDERR: " +
        "invalid tool call error (invalid_args)",
    ),
    true,
  );
});

test("E3: the WORK failing is not a dropout — it keeps the 🚫 and the operator", () => {
  // The whole safety argument of the module: these must reach the normal
  // failure path. A gemini run that reports a broken build is a real failure.
  assert.equal(isEngineDropout("Executor failed: typecheck failed with 3 errors"), false);
  assert.equal(
    isEngineDropout("agy: the tests do not pass, I could not finish the task"),
    false,
  );
  assert.equal(isEngineDropout("Run blocked: Daily spend cap — daily spend EUR 124"), false);
  assert.equal(
    isEngineDropout("Executor failed: claude-code exit 1: You've hit your session limit"),
    false,
  );
  assert.equal(isEngineDropout(null), false);
  assert.equal(isEngineDropout(""), false);
  assert.equal(isEngineDropout(undefined), false);
});

test("E4: only the gemini tier routes to an engine that can drop out", () => {
  assert.equal(tierCanDropOut("gemini"), true);
  assert.equal(tierCanDropOut("junior"), false);
  assert.equal(tierCanDropOut("standard"), false);
  assert.equal(tierCanDropOut("flagship"), false);
  assert.equal(tierCanDropOut("fast"), false);
  assert.equal(tierCanDropOut(null), false);
});

test("E5: the fallback is a Claude tier, and NOT one that can drop out again", () => {
  // Two properties in one assertion pair, both load-bearing: a fallback that
  // could itself drop out would let `demoteTaskTier`'s once-only guard be
  // bypassed on the second hop, and a fallback to `standard` (Opus) would move
  // fifty queued tasks off a free subscription onto the most expensive model
  // in the ladder while the daily spend cap was already blown.
  assert.equal(tierCanDropOut(ENGINE_FALLBACK_TIER), false);
  assert.equal(ENGINE_FALLBACK_TIER, "junior");
});
