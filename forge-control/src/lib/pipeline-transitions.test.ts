/**
 * Tests for the pipeline transition guard.
 *
 * Run: pnpm test   (`tsx --test src/lib/*.test.ts`, node:test, no framework)
 *
 * These assert the REFUSALS round 4's reviewer proved were missing — the ones
 * that cannot be demonstrated against live data without destroying a real
 * video. Each destructive/publish-claiming case is asserted twice: once with
 * `confirm: false` and once with `confirm: true`, because a guard that a
 * confirm flag can unlock is not a guard against a scripted POST that simply
 * sets the flag.
 *
 * The positive half matters just as much: an assertion that everything is
 * refused would also pass on a handler that refuses everything, so every
 * transition the drawer's own dropdowns produce is asserted allowed here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTransition,
  DESTRUCTIVE_TARGETS,
  TERMINAL_SOURCES,
  CURATED_ADVANCE_TRANSITIONS,
} from "./pipeline-transitions.ts";

describe("classifyTransition — destructive targets", () => {
  test("every destructive target is refused 403 from a working status", () => {
    for (const target of DESTRUCTIVE_TARGETS) {
      const v = classifyTransition("AWAITING_QC", target, "advance", false);
      assert.equal(v.allowed, false, `${target} was allowed`);
      if (v.allowed) return;
      assert.equal(v.httpStatus, 403);
      assert.equal(v.requiresConfirmation, false);
      assert.match(v.error, /Content Forge/);
    }
  });

  test("confirm: true does NOT unlock a destructive target", () => {
    for (const target of DESTRUCTIVE_TARGETS) {
      for (const action of ["retry", "advance"] as const) {
        const v = classifyTransition("SCRIPTING", target, action, true);
        assert.equal(
          v.allowed,
          false,
          `${action} → ${target} was allowed with confirm:true`,
        );
      }
    }
  });
});

describe("classifyTransition — publish-claiming targets", () => {
  test("PUBLISHED is refused from a mid-pipeline status, confirm or not", () => {
    for (const confirmed of [false, true]) {
      const v = classifyTransition("SCRIPTING", "PUBLISHED", "advance", confirmed);
      assert.equal(v.allowed, false);
      if (v.allowed) return;
      assert.equal(v.httpStatus, 409);
      assert.equal(v.requiresConfirmation, false);
      assert.match(v.error, /AWAITING_UPLOADER/);
    }
  });

  test("PUBLISHED is allowed from the two statuses that precede it", () => {
    for (const from of ["UPLOADING", "AWAITING_UPLOADER"]) {
      assert.deepEqual(
        classifyTransition(from, "PUBLISHED", "advance", false),
        { allowed: true },
        `${from} → PUBLISHED should be the real uploader workflow`,
      );
    }
  });

  test("UPLOADING is only reachable from AWAITING_UPLOADER", () => {
    assert.deepEqual(
      classifyTransition("AWAITING_UPLOADER", "UPLOADING", "advance", false),
      { allowed: true },
    );
    const v = classifyTransition("AWAITING_QC", "UPLOADING", "advance", true);
    assert.equal(v.allowed, false);
  });

  test("FAILED_IRRECOVERABLE cannot be set by any control from any source", () => {
    const v = classifyTransition(
      "FAILED_RENDER",
      "FAILED_IRRECOVERABLE",
      "retry",
      true,
    );
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    assert.match(v.error, /pipeline workers/);
  });
});

describe("classifyTransition — terminal sources", () => {
  test("no job moves out of a terminal status, even with confirm", () => {
    for (const from of TERMINAL_SOURCES) {
      const v = classifyTransition(from, "SCRIPTING", "retry", true);
      assert.equal(v.allowed, false, `${from} → SCRIPTING was allowed`);
      if (v.allowed) return;
      assert.equal(v.httpStatus, 409);
    }
  });

  test("FAILED_IRRECOVERABLE keeps its own wording (the pre-existing 409)", () => {
    const v = classifyTransition("FAILED_IRRECOVERABLE", "SCRIPTING", "retry", false);
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    assert.match(v.error, /requires manual human intervention/);
  });
});

describe("classifyTransition — the ordinary work still passes", () => {
  test("the retry dropdown's five options are allowed from a failed render", () => {
    const dropdown = [
      "ROUTING_RENDER",
      "AWAITING_QC",
      "ASSET_COLLECTION",
      "SCRIPTING",
      "IDEA_GENERATION",
    ];
    for (const target of dropdown) {
      assert.deepEqual(
        classifyTransition("FAILED_RENDER", target, "retry", false),
        { allowed: true },
        `retry → ${target} should need no confirmation`,
      );
    }
  });

  test("every curated advance pair is allowed without confirmation", () => {
    for (const [from, targets] of Object.entries(CURATED_ADVANCE_TRANSITIONS)) {
      for (const to of targets) {
        assert.deepEqual(
          classifyTransition(from, to, "advance", false),
          { allowed: true },
          `${from} → ${to} is curated but was refused`,
        );
      }
    }
  });

  test("the five stalled QC jobs' real move (AWAITING_QC → AWAITING_UPLOADER) is allowed", () => {
    assert.deepEqual(
      classifyTransition("AWAITING_QC", "AWAITING_UPLOADER", "advance", false),
      { allowed: true },
    );
  });
});

describe("classifyTransition — the confirmable middle", () => {
  test("a non-standard advance needs confirm, and confirm grants it", () => {
    const without = classifyTransition("SCRIPTING", "ROUTING_RENDER", "advance", false);
    assert.equal(without.allowed, false);
    if (without.allowed) return;
    assert.equal(without.httpStatus, 409);
    assert.equal(without.requiresConfirmation, true);
    assert.match(without.error, /"confirm": true/);

    assert.deepEqual(
      classifyTransition("SCRIPTING", "ROUTING_RENDER", "advance", true),
      { allowed: true },
    );
  });

  test("a no-op transition is refused and is not confirmable", () => {
    const v = classifyTransition("AWAITING_QC", "AWAITING_QC", "advance", true);
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    assert.equal(v.httpStatus, 409);
    assert.equal(v.requiresConfirmation, false);
    assert.match(v.error, /already in status AWAITING_QC/);
  });
});
