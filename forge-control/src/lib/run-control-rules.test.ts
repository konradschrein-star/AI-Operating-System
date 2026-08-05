/**
 * Tests for the manager control plane's pure decision rules (run-control-rules.ts).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The two most important tests in this file are:
 *  - "COMPLETION TRANSITION — operator status always wins" — this is the 07 §6
 *    completion guard (C13). If a non-running rowStatus ever produced a write,
 *    the executor could overwrite an operator's paused/cancelled verb with a
 *    stale completion from a child process that raced it. Every one of the 42
 *    table cells asserts this holds regardless of outcome or pendingInput.
 *  - "PROPERTY — every status is reachable by /message or /resume-chat" — if a
 *    status were rejected by both verbs without the other's reason naming an
 *    escape hatch, an operator would have NO way to unstick that run from the
 *    UI. This is 08 §1's explicit property test, not just the two matrices.
 *
 * This file does NOT modify run-control-rules.ts. Per the round-902 brief, any
 * genuine bug found here is asserted as a FAILING test with the defect spelled
 * out in a comment, not silently worked around — see the note below the
 * eligibility-matrix section if one turns up.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  messageAction,
  resumeAction,
  stopAction,
  terminateAction,
  completionTransition,
  commsEntries,
  subagentAddressable,
  projectSlug,
  shortId,
  MESSAGE_ELIGIBLE,
  RESUME_ELIGIBLE,
  STOP_ELIGIBLE,
  TERMINATE_ELIGIBLE,
  type RunStatus,
  type CommsFrom,
} from "./run-control-rules.ts";

const ALL_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "paused",
  "stuck",
  "completed",
  "failed",
  "cancelled",
];

/* ========================================================================== *
 * 1. Eligibility matrices — all 28 cells (4 verbs x 7 statuses)
 * ========================================================================== */

describe("eligibility matrices", () => {
  test("messageAction — exact shape for all 7 statuses", () => {
    const expected: Record<RunStatus, unknown> = {
      queued: { kind: "append" },
      running: { kind: "append_and_flag" },
      paused: { kind: "append_and_queue" },
      stuck: { kind: "append_and_queue" },
      completed: { kind: "append_and_queue" },
      failed: {
        kind: "reject",
        status: 409,
        reason: "run failed - use POST /api/runs/:id/resume-chat to reopen it",
      },
      cancelled: {
        kind: "reject",
        status: 409,
        reason:
          "run cancelled - use POST /api/runs/:id/resume-chat to reopen it",
      },
    };
    for (const status of ALL_STATUSES) {
      assert.deepEqual(
        messageAction(status),
        expected[status],
        `messageAction(${status})`,
      );
    }
  });

  test("resumeAction — exact shape for all 7 statuses", () => {
    const expected: Record<RunStatus, unknown> = {
      completed: { kind: "resume" },
      failed: { kind: "resume" },
      cancelled: { kind: "resume" },
      stuck: { kind: "resume" },
      paused: { kind: "resume" },
      running: {
        kind: "reject",
        status: 409,
        reason:
          "run is still running - use POST /api/runs/:id/message to talk to it",
      },
      queued: {
        kind: "reject",
        status: 409,
        reason:
          "run is queued and will start on its own - use POST /api/runs/:id/message to talk to it",
      },
    };
    for (const status of ALL_STATUSES) {
      assert.deepEqual(
        resumeAction(status),
        expected[status],
        `resumeAction(${status})`,
      );
    }
  });

  test("stopAction — exact shape for all 7 statuses", () => {
    const expected: Record<RunStatus, unknown> = {
      queued: { kind: "apply", to: "paused", eligible: STOP_ELIGIBLE },
      running: { kind: "apply", to: "paused", eligible: STOP_ELIGIBLE },
      stuck: { kind: "apply", to: "paused", eligible: STOP_ELIGIBLE },
      paused: { kind: "reject", status: 409, reason: "run is already paused" },
      completed: {
        kind: "reject",
        status: 409,
        reason: "run is already settled (completed)",
      },
      failed: {
        kind: "reject",
        status: 409,
        reason: "run is already settled (failed)",
      },
      cancelled: {
        kind: "reject",
        status: 409,
        reason: "run is already settled (cancelled)",
      },
    };
    for (const status of ALL_STATUSES) {
      assert.deepEqual(
        stopAction(status),
        expected[status],
        `stopAction(${status})`,
      );
    }
    // Named cell: already-paused -> 409 on stop (08 §1).
    assert.deepEqual(stopAction("paused"), {
      kind: "reject",
      status: 409,
      reason: "run is already paused",
    });
  });

  test("terminateAction — exact shape for all 7 statuses", () => {
    const expected: Record<RunStatus, unknown> = {
      queued: { kind: "apply", to: "cancelled", eligible: TERMINATE_ELIGIBLE },
      running: {
        kind: "apply",
        to: "cancelled",
        eligible: TERMINATE_ELIGIBLE,
      },
      paused: {
        kind: "apply",
        to: "cancelled",
        eligible: TERMINATE_ELIGIBLE,
      },
      stuck: { kind: "apply", to: "cancelled", eligible: TERMINATE_ELIGIBLE },
      cancelled: {
        kind: "reject",
        status: 409,
        reason: "run is already cancelled",
      },
      completed: {
        kind: "reject",
        status: 409,
        reason: "run is already settled (completed)",
      },
      failed: {
        kind: "reject",
        status: 409,
        reason: "run is already settled (failed)",
      },
    };
    for (const status of ALL_STATUSES) {
      assert.deepEqual(
        terminateAction(status),
        expected[status],
        `terminateAction(${status})`,
      );
    }
    // Named cell: already-cancelled -> 409 on terminate (08 §1).
    assert.deepEqual(terminateAction("cancelled"), {
      kind: "reject",
      status: 409,
      reason: "run is already cancelled",
    });
  });

  test("exported *_ELIGIBLE arrays agree with the switch statements", () => {
    // These arrays are what the route puts into the SQL WHERE clause, so they
    // must exactly match what the pure functions above decided is eligible.
    for (const status of ALL_STATUSES) {
      const stopEligible = STOP_ELIGIBLE.includes(status);
      const stopApplies = stopAction(status).kind === "apply";
      assert.equal(
        stopApplies,
        stopEligible,
        `STOP_ELIGIBLE disagrees with stopAction for ${status}`,
      );

      const termEligible = TERMINATE_ELIGIBLE.includes(status);
      const termApplies = terminateAction(status).kind === "apply";
      assert.equal(
        termApplies,
        termEligible,
        `TERMINATE_ELIGIBLE disagrees with terminateAction for ${status}`,
      );

      const msgEligible = MESSAGE_ELIGIBLE.includes(status);
      const msgApplies = messageAction(status).kind !== "reject";
      assert.equal(
        msgApplies,
        msgEligible,
        `MESSAGE_ELIGIBLE disagrees with messageAction for ${status}`,
      );

      const resumeEligible = RESUME_ELIGIBLE.includes(status);
      const resumeApplies = resumeAction(status).kind !== "reject";
      assert.equal(
        resumeApplies,
        resumeEligible,
        `RESUME_ELIGIBLE disagrees with resumeAction for ${status}`,
      );
    }
  });
});

/* ========================================================================== *
 * 2. PROPERTY (08 §1) — every status reachable by exactly one of
 *    message/resume, or both reject naming the other verb's route.
 * ========================================================================== */

describe("message/resume-chat coverage property", () => {
  test("every status: exactly one of message/resume accepts, or both reject naming the other verb", () => {
    for (const status of ALL_STATUSES) {
      const msg = messageAction(status);
      const res = resumeAction(status);
      const msgAccepts = msg.kind !== "reject";
      const resAccepts = res.kind !== "reject";

      if (msgAccepts || resAccepts) {
        // At least one accepts. Property is satisfied by definition, but
        // additionally: they must not BOTH accept for the same status (each
        // status has exactly one canonical verb per 06 C1/C6).
        assert.notEqual(
          msgAccepts && resAccepts,
          true,
          `status ${status}: both message and resume-chat accept - ambiguous routing`,
        );
        continue;
      }

      // Both reject: each reason must name the OTHER verb's route so the
      // operator is never stuck with no way forward.
      assert.equal(msg.kind, "reject", `message(${status}) must reject`);
      assert.equal(res.kind, "reject", `resume(${status}) must reject`);
      assert.match(
        msg.reason,
        /resume-chat/,
        `message(${status}) rejection must name resume-chat as the escape hatch: "${msg.reason}"`,
      );
      assert.match(
        res.reason,
        /\/message/,
        `resume(${status}) rejection must name /message as the escape hatch: "${res.reason}"`,
      );
    }
  });
});

/* ========================================================================== *
 * 3. Completion transition — 42 cells (3 outcomes x 7 rowStatus x 2 pendingInput)
 * ========================================================================== */

describe("completionTransition", () => {
  const OUTCOMES = ["completed", "failed", "stuck"] as const;
  const PENDING = [true, false] as const;

  for (const outcome of OUTCOMES) {
    for (const rowStatus of ALL_STATUSES) {
      for (const pendingInput of PENDING) {
        const label = `outcome=${outcome} rowStatus=${rowStatus} pendingInput=${pendingInput}`;

        test(label, () => {
          const d = completionTransition({ outcome, rowStatus, pendingInput });

          // (a) rowStatus !== 'running' always yields, regardless of outcome
          // or pendingInput. The operator's status always wins.
          if (rowStatus !== "running") {
            assert.deepEqual(
              { write: d.write, yielded: d.yielded, notify: d.notify },
              { write: false, yielded: true, notify: false },
              label,
            );
            return;
          }

          // From here on, rowStatus === 'running'.

          // (b) pendingInput redirects ONLY the 'completed' outcome, and only
          // then to status 'queued' with clearPendingInput:true, notify:false.
          if (outcome === "completed" && pendingInput) {
            assert.equal(d.write, true, label);
            assert.equal(d.status, "queued", label);
            assert.equal(d.clearPendingInput, true, label);
            assert.equal(d.notify, false, label);
            assert.equal(d.stampCompletedAt, false, label);
            assert.equal(d.yielded, false, label);
            return;
          }

          // (c) failed/stuck never consume the flag, regardless of pendingInput.
          if (outcome === "failed" || outcome === "stuck") {
            assert.equal(
              d.clearPendingInput,
              false,
              `${label}: failed/stuck must never consume pendingInput`,
            );
          }

          // outcome === 'completed' && !pendingInput, OR outcome is failed/stuck:
          // straight-through settle to the outcome's own status.
          assert.equal(d.write, true, label);
          assert.equal(d.status, outcome, label);
          assert.equal(d.yielded, false, label);
          assert.equal(d.notify, true, label);

          if (outcome === "completed" && !pendingInput) {
            assert.equal(d.clearPendingInput, false, label);
          }

          // (d) stampCompletedAt is true exactly for completed+failed on a
          // running row (and never on the pendingInput-requeue path, already
          // covered above), and never for stuck.
          if (outcome === "stuck") {
            assert.equal(d.stampCompletedAt, false, label);
          } else {
            // outcome === 'completed' (non-pending) or 'failed'
            assert.equal(d.stampCompletedAt, true, label);
          }
        });
      }
    }
  }

  test("reason string is always non-empty", () => {
    for (const outcome of ["completed", "failed", "stuck"] as const) {
      for (const rowStatus of ALL_STATUSES) {
        for (const pendingInput of [true, false]) {
          const d = completionTransition({ outcome, rowStatus, pendingInput });
          assert.ok(
            d.reason.length > 0,
            `empty reason for outcome=${outcome} rowStatus=${rowStatus} pendingInput=${pendingInput}`,
          );
        }
      }
    }
  });
});

/* ========================================================================== *
 * 4. Comms entry construction — the wire contract the UI parses
 * ========================================================================== */

describe("commsEntries", () => {
  const TS = "2026-08-06T12:00:00.000Z";

  test("receiver is role user / kind comms; echo is role agent / kind comms", () => {
    const { receiver, echo } = commsEntries({
      text: "hello",
      from: "konrad",
      targetRunId: "aaaaaaaa-1111-2222-3333-444444444444",
      senderRunId: "bbbbbbbb-1111-2222-3333-444444444444",
      ts: TS,
    });
    assert.equal(receiver.role, "user");
    assert.equal(receiver.kind, "comms");
    assert.ok(echo);
    assert.equal(echo!.role, "agent");
    assert.equal(echo!.kind, "comms");
  });

  test("prefixes for from in {konrad, manager, worker}, with and without senderRunId", () => {
    const cases: Array<{
      from: CommsFrom;
      senderRunId: string | null | undefined;
      expectedPrefix: string;
    }> = [
      { from: "konrad", senderRunId: undefined, expectedPrefix: "[message from konrad]" },
      { from: "konrad", senderRunId: "aaaaaaaa-0000", expectedPrefix: "[message from konrad]" },
      {
        from: "manager",
        senderRunId: undefined,
        expectedPrefix: "[message from manager]",
      },
      {
        from: "manager",
        senderRunId: "aaaaaaaa-1111-2222",
        expectedPrefix: `[message from manager ${shortId("aaaaaaaa-1111-2222")}]`,
      },
      {
        from: "worker",
        senderRunId: undefined,
        expectedPrefix: "[message from worker]",
      },
      {
        from: "worker",
        senderRunId: "cccccccc-3333-4444",
        expectedPrefix: `[message from worker ${shortId("cccccccc-3333-4444")}]`,
      },
    ];

    for (const c of cases) {
      const { receiver } = commsEntries({
        text: "hi there",
        from: c.from,
        targetRunId: "target-run-id",
        senderRunId: c.senderRunId,
        ts: TS,
      });
      assert.ok(
        receiver.content.startsWith(c.expectedPrefix),
        `from=${c.from} senderRunId=${c.senderRunId}: expected prefix "${c.expectedPrefix}", got "${receiver.content}"`,
      );
    }
  });

  test("echo is null when senderRunId is absent", () => {
    const { echo: noSender } = commsEntries({
      text: "hi",
      from: "konrad",
      targetRunId: "t1",
      ts: TS,
    });
    assert.equal(noSender, null);

    const { echo: emptySender } = commsEntries({
      text: "hi",
      from: "konrad",
      targetRunId: "t1",
      senderRunId: "",
      ts: TS,
    });
    assert.equal(emptySender, null);
  });

  test("echo direction out with peer_run_id=target; receiver direction in with peer_run_id=sender ?? null", () => {
    const sender = "sender-run-1";
    const target = "target-run-1";
    const { receiver, echo } = commsEntries({
      text: "status?",
      from: "manager",
      targetRunId: target,
      senderRunId: sender,
      ts: TS,
    });
    assert.deepEqual(receiver.meta, {
      comms: { direction: "in", from: "manager", peer_run_id: sender },
    });
    assert.deepEqual(echo!.meta, {
      comms: { direction: "out", from: "manager", peer_run_id: target },
    });

    // No sender -> receiver.peer_run_id is null, not undefined.
    const { receiver: r2 } = commsEntries({
      text: "status?",
      from: "konrad",
      targetRunId: target,
      ts: TS,
    });
    assert.deepEqual(r2.meta, {
      comms: { direction: "in", from: "konrad", peer_run_id: null },
    });
  });

  test("relay variant: prefix names the sub-agent, meta.comms.subagent_id set, direction still in/role user", () => {
    const { receiver, echo } = commsEntries({
      text: "check the build",
      from: "manager",
      targetRunId: "parent-run-1",
      senderRunId: "manager-run-1",
      ts: TS,
      relaySubagentId: "subagent-xyz",
    });
    assert.ok(
      receiver.content.startsWith(
        `[relay from manager ${shortId("manager-run-1")} -> sub-agent subagent-xyz] Deliver this to that sub-agent via your harness (SendMessage) and report its reply back here:`,
      ),
      receiver.content,
    );
    assert.equal(receiver.role, "user");
    assert.deepEqual(receiver.meta, {
      comms: {
        direction: "in",
        from: "manager",
        peer_run_id: "manager-run-1",
        subagent_id: "subagent-xyz",
      },
    });
    // The echo is unaffected by relay - it is still the plain echo shape.
    assert.deepEqual(echo!.meta, {
      comms: { direction: "out", from: "manager", peer_run_id: "parent-run-1" },
    });
  });

  test("empty or whitespace-only text throws", () => {
    for (const text of ["", "   ", "\n\t"]) {
      assert.throws(() =>
        commsEntries({
          text,
          from: "konrad",
          targetRunId: "t1",
          ts: TS,
        }),
      );
    }
  });
});

/* ========================================================================== *
 * 5. projectSlug
 * ========================================================================== */

describe("projectSlug", () => {
  test("normal names lowercase and hyphenate", () => {
    assert.equal(projectSlug("Engine V2 Research Lane"), "engine-v2-research-lane");
    assert.equal(projectSlug("simple"), "simple");
  });

  test("umlauts and accents are stripped via NFKD, not dropped whole", () => {
    assert.equal(projectSlug("Übungs-Projekt"), "ubungs-projekt");
    assert.equal(projectSlug("café résumé"), "cafe-resume");
  });

  test("punctuation runs collapse to a single hyphen", () => {
    assert.equal(projectSlug("foo!!!bar???baz"), "foo-bar-baz");
    assert.equal(projectSlug("a...b---c"), "a-b-c");
    assert.equal(projectSlug("--leading and trailing--"), "leading-and-trailing");
  });

  test("an all-symbol name falls back to project-<id8>", () => {
    assert.equal(projectSlug("!!!???***", "abcdefgh12345"), "project-abcdefgh");
  });

  test("no id and a degenerate name falls back to project-unnamed", () => {
    assert.equal(projectSlug("!!!???***"), "project-unnamed");
    assert.equal(projectSlug(""), "project-unnamed");
    assert.equal(projectSlug("   ", null), "project-unnamed");
  });

  test("the 48-char cap never leaves a trailing hyphen", () => {
    const long = "a".repeat(60);
    const slug = projectSlug(long);
    assert.ok(slug.length <= 48, `length ${slug.length}`);
    assert.ok(!slug.endsWith("-"), `slug ends with hyphen: "${slug}"`);

    // A name whose 48-char truncation point lands mid-hyphen-run.
    const trickyLong = "word " + "b".repeat(44) + " word";
    const trickySlug = projectSlug(trickyLong);
    assert.ok(trickySlug.length <= 48);
    assert.ok(!trickySlug.endsWith("-"), `slug ends with hyphen: "${trickySlug}"`);
  });

  test("idempotence: projectSlug(projectSlug(x)) === projectSlug(x)", () => {
    const inputs = [
      "Engine V2 Research Lane",
      "Übungs-Projekt",
      "!!!weird***",
      "already-a-slug",
      "  spaced -- out  ",
      "a".repeat(80),
    ];
    for (const x of inputs) {
      const once = projectSlug(x);
      const twice = projectSlug(once);
      assert.equal(twice, once, `not idempotent for input: "${x}"`);
    }
  });
});

/* ========================================================================== *
 * 6. subagentAddressable — must never throw
 * ========================================================================== */

describe("subagentAddressable", () => {
  test("id present in metadata.subagents_v2 -> true", () => {
    const metadata = { subagents_v2: [{ id: "sub-1" }, { id: "sub-2" }] };
    assert.equal(subagentAddressable(metadata, "sub-2"), true);
  });

  test("id absent from a present subagents_v2 -> false", () => {
    const metadata = { subagents_v2: [{ id: "sub-1" }] };
    assert.equal(subagentAddressable(metadata, "sub-nope"), false);
  });

  test("subagents_v2 missing entirely (pre-rollup run) -> false, not throw", () => {
    assert.doesNotThrow(() => {
      assert.equal(subagentAddressable({}, "sub-1"), false);
    });
  });

  test("metadata null/undefined -> false, not throw", () => {
    assert.doesNotThrow(() => {
      assert.equal(subagentAddressable(null, "sub-1"), false);
    });
    assert.doesNotThrow(() => {
      assert.equal(subagentAddressable(undefined, "sub-1"), false);
    });
  });

  test("subagents_v2 not an array -> false, not throw", () => {
    for (const bogus of [
      "not-an-array",
      42,
      { id: "sub-1" },
      null,
      true,
    ]) {
      assert.doesNotThrow(() => {
        assert.equal(
          subagentAddressable({ subagents_v2: bogus }, "sub-1"),
          false,
        );
      });
    }
  });

  test("empty or non-string subagentId -> false, not throw", () => {
    const metadata = { subagents_v2: [{ id: "sub-1" }] };
    assert.doesNotThrow(() => {
      assert.equal(subagentAddressable(metadata, ""), false);
    });
    assert.doesNotThrow(() => {
      // @ts-expect-error deliberately wrong type at the boundary
      assert.equal(subagentAddressable(metadata, 123), false);
    });
  });

  test("entries that are not objects, or lack a string id, are skipped without throwing", () => {
    const metadata = { subagents_v2: [null, "not-an-object", { id: 42 }, { noId: true }, { id: "sub-real" }] };
    assert.doesNotThrow(() => {
      assert.equal(subagentAddressable(metadata, "sub-real"), true);
    });
  });
});
