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
  CURATED_RETRY_TARGETS,
  STAGE_QUEUES,
  isQueueBackedStage,
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

  test("an advance to the status the job is already in stays a hard refusal", () => {
    const v = classifyTransition("AWAITING_QC", "AWAITING_QC", "advance", true);
    assert.equal(v.allowed, false);
    if (v.allowed) return;
    assert.equal(v.httpStatus, 409);
    assert.equal(v.requiresConfirmation, false);
    assert.match(v.error, /already in status AWAITING_QC/);
  });
});

/**
 * Round 6's blocker: the first `from === to` rule refused re-queue/unstick and
 * sat ABOVE the confirm fallthrough, so "Force This Retry" could not reach it
 * either. These assert the control the brief actually asks for — "retry a
 * failed job, re-queue, unstick" — for the exact statuses the reviewer named.
 */
describe("classifyTransition — re-dispatch into the current stage", () => {
  test("every queue-backed stage may be retried into itself, unconfirmed", () => {
    for (const stage of Object.keys(STAGE_QUEUES)) {
      assert.deepEqual(
        classifyTransition(stage, stage, "retry", false),
        { allowed: true },
        `${stage} → ${stage} is the re-queue control and must not need a force`,
      );
    }
  });

  test("the wedged-render case the reviewer described now dispatches", () => {
    // Render worker died, nothing consumed queue-render-heavy, job sits in
    // ROUTING_RENDER. Drawer → Retry Stage → "Render (ROUTING_RENDER)".
    assert.deepEqual(
      classifyTransition("ROUTING_RENDER", "ROUTING_RENDER", "retry", false),
      { allowed: true },
    );
    // And the default "infer automatically" path, which `determineRetryStage`
    // resolves to the job's own status for a scripted job in ASSET_COLLECTION.
    assert.deepEqual(
      classifyTransition("ASSET_COLLECTION", "ASSET_COLLECTION", "retry", false),
      { allowed: true },
    );
  });

  test("a stage with no queue is confirmable, not a dead end", () => {
    const without = classifyTransition(
      "AWAITING_UPLOADER",
      "AWAITING_UPLOADER",
      "retry",
      false,
    );
    assert.equal(without.allowed, false);
    if (without.allowed) return;
    assert.equal(without.httpStatus, 409);
    assert.equal(
      without.requiresConfirmation,
      true,
      "Force This Retry must be able to reach it",
    );
    assert.match(without.error, /no worker queue/);

    assert.deepEqual(
      classifyTransition("AWAITING_UPLOADER", "AWAITING_UPLOADER", "retry", true),
      { allowed: true },
    );
  });

  test("a terminal or publish-claiming status is NOT re-dispatchable by the same-status door", () => {
    // Ordering proof: these must answer with their own rule, not the new one.
    const published = classifyTransition("PUBLISHED", "PUBLISHED", "retry", true);
    assert.equal(published.allowed, false);
    if (published.allowed) return;
    assert.match(published.error, /terminal status PUBLISHED/);

    const uploading = classifyTransition("UPLOADING", "UPLOADING", "retry", true);
    assert.equal(uploading.allowed, false);
    if (uploading.allowed) return;
    assert.match(uploading.error, /only reachable from AWAITING_UPLOADER/);

    for (const target of DESTRUCTIVE_TARGETS) {
      const v = classifyTransition(target, target, "retry", true);
      assert.equal(v.allowed, false, `${target} → ${target} was allowed`);
    }
  });
});

describe("STAGE_QUEUES is the single source of truth", () => {
  test("the five queue-backed stages match Content Forge's dispatcher", () => {
    // worker-orchestrator/src/utils/dispatch-next.ts, `switch (newStatus)`:
    // these five cases are the complete set that call `queue.add()`.
    assert.deepEqual(STAGE_QUEUES, {
      SCRIPTING: "queue-ai-generation",
      ASSET_COLLECTION: "queue-asset-collection",
      QMS_VALIDATING: "queue-qms-validation",
      ROUTING_RENDER: "queue-render-heavy",
      CLIP_SELECTION: "queue-clip-selection",
    });
  });

  test("every queue-backed stage is also a curated retry target", () => {
    // Otherwise a re-dispatch would be allowed same-status but refused from a
    // failed status, which is the inconsistency that produced round 6's dead end.
    for (const stage of Object.keys(STAGE_QUEUES)) {
      assert.equal(
        CURATED_RETRY_TARGETS.has(stage),
        true,
        `${stage} dispatches to a queue but is not a curated retry target`,
      );
    }
  });

  test("isQueueBackedStage does not answer for inherited Object keys", () => {
    // `"constructor" in STAGE_QUEUES` is true; a naive `in` check would call
    // every unknown status queue-backed and allow a no-op retry as a dispatch.
    assert.equal(isQueueBackedStage("constructor"), false);
    assert.equal(isQueueBackedStage("toString"), false);
    assert.equal(isQueueBackedStage("AWAITING_QC"), false);
    assert.equal(isQueueBackedStage("ROUTING_RENDER"), true);
  });
});
