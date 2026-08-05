/**
 * CP1-2c — the executor half of the control plane: the pending-input handshake
 * (07 §5) and the completion guard (07 §6).
 *
 * WHY THIS FILE IS A SOURCE-ASSERTION TEST. `executor.ts` opens a pg Pool at
 * import time and there is no test database in this suite, so importing it
 * would open a socket, not run a test. Precedent: reminder-dedup.test.ts. The
 * mechanism under test is therefore asserted where it actually lives — in the
 * SQL text — and the DECISION it rides on is imported and exercised for real,
 * because that half is pure.
 *
 * What can go wrong here, and what each assert below defends:
 *   - the guard silently dropped from the completion UPDATE → an operator's
 *     stop/terminate is overwritten by `completed` (C13);
 *   - the RETURNING clause dropped → the handshake never sees the flag and
 *     every message posted into a running run in the completion window is
 *     LOST (C5: no message is ever silently dropped);
 *   - the requeue losing `AND status = 'completed'` → an operator who
 *     terminated between the two statements is overwritten after all;
 *   - the requeue forgetting `completed_at = NULL` → a run that is going back
 *     to work carries a completion timestamp, and every duration in the UI
 *     lies about it;
 *   - the claim not clearing the flag → the run requeues itself a second time
 *     at the end of the turn it just consumed the message on (07 §5, belt);
 *   - the LEGACY claude-pool path acquiring the guard → scope creep 07 §6
 *     explicitly forbids: that branch is not on this control plane.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { completionTransition } from "./run-control-rules.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const RAW = readSource("../executor.ts");

/** Drop `//` and block comments, so prose ABOUT the SQL is never mistaken for the SQL. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const EXEC = stripComments(RAW);

/** The body of a named function declaration, up to the next top-level `}` + blank line. */
function sliceFrom(src: string, startNeedle: string, endNeedle: string): string {
  const a = src.indexOf(startNeedle);
  assert.notEqual(a, -1, `anchor not found in executor.ts: ${startNeedle}`);
  const b = src.indexOf(endNeedle, a);
  assert.notEqual(b, -1, `end anchor not found after ${startNeedle}: ${endNeedle}`);
  return src.slice(a, b);
}

const COMPLETE_RUN = sliceFrom(
  EXEC,
  "async function completeRun(",
  "async function notifyRunOutcome(",
);
const CLAIM = sliceFrom(EXEC, "async function claimNextRun(", "function buildPromptFromThread(");

/* ========================================================================== *
 * 1. The rule is imported, not re-derived (C5)
 * ========================================================================== */

describe("the executor imports the pure decision", () => {
  test("completionTransition comes from ./lib/run-control-rules.ts", () => {
    assert.match(
      EXEC,
      /import \{ completionTransition \} from "\.\/lib\/run-control-rules\.ts";/,
    );
  });

  test("the executor does not reimplement the transition", () => {
    // Anything that decides "queued vs completed" locally is the drift C5 exists
    // to prevent. The only queued-status literal in completeRun is the SQL that
    // EXECUTES the decision, and it sits behind `decision.status === "queued"`.
    assert.match(COMPLETE_RUN, /decision\.status === "queued" && decision\.clearPendingInput/);
    assert.match(COMPLETE_RUN, /completionTransition\(\{/);
  });
});

/* ========================================================================== *
 * 2. The guarded completion write (07 §6, C13)
 * ========================================================================== */

describe("completeRun — the guard", () => {
  test("it takes an options bag and returns what it did", () => {
    assert.match(RAW, /opts: \{ guardRunning\?: boolean \} = \{\}/);
    assert.match(RAW, /Promise<CompletionWrite>/);
    assert.match(RAW, /applied: boolean;\s*\n\s*requeued: boolean;/);
  });

  test("the guarded UPDATE carries AND status = 'running'", () => {
    assert.match(COMPLETE_RUN, /AND status = 'running'/);
    // ...and only when asked for: the guard is a conditional fragment, so the
    // legacy caller's SQL is byte-identical to what it was before this change.
    assert.match(COMPLETE_RUN, /opts\.guardRunning \?[\s\S]{0,80}AND status = 'running'/);
  });

  test("the guarded UPDATE returns the handshake flag", () => {
    assert.match(COMPLETE_RUN, /RETURNING status, metadata->>'pending_input' AS pending_input/);
  });

  test("both branches (stuck and completed/failed) carry guard + returning", () => {
    // Two SQL statements, one guard: 07 §6 gives stuck/failed the same guard
    // for symmetry — a terminated run must not be flipped to `stuck` by a
    // timeout that was already moot.
    const guarded = COMPLETE_RUN.match(/WHERE id = \$1\$\{guard\}\$\{returning\}/g) ?? [];
    assert.equal(guarded.length, 2, "both completion statements must be guardable");
  });

  test("rowCount 0 writes nothing else and reports applied:false", () => {
    assert.match(COMPLETE_RUN, /if \(res\.rowCount === 0\)/);
    assert.match(COMPLETE_RUN, /return \{ applied: false, requeued: false \}/);
  });

  test("the yield log line is verbatim", () => {
    assert.match(
      COMPLETE_RUN,
      /`\[executor\] run \$\{id\}: completion yielded to operator status \$\{actual\}`/,
    );
    // <s> is read back, not guessed — the UPDATE returned no row, so the row's
    // real status is only knowable from a follow-up SELECT.
    assert.match(COMPLETE_RUN, /const actual = await getRunStatus\(id\)/);
  });
});

/* ========================================================================== *
 * 3. The requeue — E2 of the 07 §5 diagram
 * ========================================================================== */

describe("completeRun — the pending-input handshake", () => {
  test("the flag is read from the RETURNING row, as a jsonb text 'true'", () => {
    assert.match(COMPLETE_RUN, /pendingInput: res\.rows\[0\]\.pending_input === "true"/);
  });

  test("the requeue is preconditioned on status = 'completed'", () => {
    assert.match(COMPLETE_RUN, /WHERE id = \$1 AND status = 'completed'/);
  });

  test("the requeue clears completed_at, wake_after and the flag", () => {
    const requeue = COMPLETE_RUN.slice(COMPLETE_RUN.indexOf("SET status = 'queued'"));
    assert.match(requeue, /completed_at = NULL/);
    assert.match(requeue, /wake_after = NULL/);
    assert.match(requeue, /metadata = metadata - 'pending_input'/);
  });

  test("a lost requeue race is a yield, not a completion", () => {
    // An operator terminating between the two statements takes the row out of
    // 'completed'; rowCount 0 there must NOT report a finished run.
    const requeue = COMPLETE_RUN.slice(COMPLETE_RUN.indexOf("const requeue = await pool.query"));
    assert.match(requeue, /if \(requeue\.rowCount === 0\)/);
    assert.match(requeue, /completion yielded to operator status/);
  });

  test("the requeue log line is verbatim", () => {
    assert.match(
      COMPLETE_RUN,
      /`\[executor\] run \$\{id\}: pending input consumed - requeued for next turn`/,
    );
  });

  test("the log strings match the rule's own reason strings — no drift", () => {
    const requeued = completionTransition({
      outcome: "completed",
      rowStatus: "running",
      pendingInput: true,
    });
    const yielded = completionTransition({
      outcome: "completed",
      rowStatus: "cancelled",
      pendingInput: true,
    });
    assert.ok(
      COMPLETE_RUN.includes(requeued.reason),
      `executor log must quote the rule's reason: ${requeued.reason}`,
    );
    assert.ok(
      COMPLETE_RUN.includes(yielded.reason.replace(/cancelled$/, "")),
      "executor log must quote the rule's yield reason prefix",
    );
  });
});

/* ========================================================================== *
 * 4. The belt: claimNextRun
 * ========================================================================== */

describe("claimNextRun", () => {
  test("claiming clears pending_input", () => {
    assert.match(CLAIM, /metadata = COALESCE\(r\.metadata, '\{\}'::jsonb\) - 'pending_input'/);
  });

  test("it is still the same atomic single-statement claim", () => {
    assert.match(CLAIM, /FOR UPDATE SKIP LOCKED/);
    assert.match(CLAIM, /WHERE status = 'queued'/);
  });
});

/* ========================================================================== *
 * 5. Call sites — who is on the control plane and who is not
 * ========================================================================== */

describe("call sites", () => {
  test("the claude-code success path is guarded and skips notify when it yields", () => {
    const cc = sliceFrom(EXEC, "await finalizeRollup(run.id);\n  const written", "\nlet running");
    assert.match(cc, /completeRun\(run\.id, finalEntry, "completed", null, \{\s*guardRunning: true,?\s*\}\)/);
    assert.match(cc, /if \(!written\.applied \|\| written\.requeued\) return;/);
    // The notify must come AFTER the guard check, or a terminated run pushes
    // "completed" to Konrad's phone anyway.
    assert.ok(
      cc.indexOf("written.requeued") < cc.indexOf("notifyRunOutcome"),
      "notifyRunOutcome must be gated by the completion result",
    );
  });

  test("the catch-path completions are guarded only for the claude-code engine", () => {
    assert.match(EXEC, /const guardRunning = engine === "claude-code";/);
    assert.match(EXEC, /"stuck",\s*\n\s*"timeout",\s*\n\s*\{ guardRunning \},/);
    assert.match(EXEC, /"failed",\s*\n\s*null,\s*\n\s*\{ guardRunning \},/);
    const guardedNotifies = EXEC.match(/if \(written\.applied && !written\.requeued\) \{/g) ?? [];
    assert.equal(guardedNotifies.length, 2, "both catch-path notifies must be gated");
  });

  test("the LEGACY claude-pool success path is NOT guarded", () => {
    // 07 §6: the pool branch is not on this control plane and changing it is
    // scope creep. Its completion write and its notify stay unconditional.
    const poolPath = sliceFrom(EXEC, "const text = await callClaudePool(", "} catch (err) {");
    assert.match(poolPath, /"completed",\s*\n\s*\);/);
    assert.doesNotMatch(poolPath, /guardRunning/);
    assert.match(poolPath, /await notifyRunOutcome\(run, "completed", text\);/);
  });
});

/* ========================================================================== *
 * 6. Non-goals — the things this change must NOT have touched
 * ========================================================================== */

describe("non-goals stay untouched", () => {
  test("the stuck watchdog still self-guards on status = 'running'", () => {
    const wd = sliceFrom(EXEC, "async function stuckWatchdogTick(", "async function loop(");
    assert.match(wd, /status = 'running'/);
    assert.doesNotMatch(wd, /pending_input/);
  });

  test("trailingUserBlock is unchanged — it is the delivery path, not a new one", () => {
    const tub = sliceFrom(EXEC, "function trailingUserBlock(", "async function buildCompressedPrompt(");
    assert.match(tub, /thread\[i\]\.role === "assistant" \|\| thread\[i\]\.role === "tool"/);
    assert.doesNotMatch(tub, /pending_input|comms/);
  });

  test("no comms case was added to the executor's local ThreadEntry", () => {
    // executor.ts's copy of the interface is untyped on kind (`kind?: string`),
    // so the new entry kind needs nothing here (07 §3).
    assert.match(EXEC, /kind\?: string;/);
  });
});

/* ========================================================================== *
 * 7. The two transition cells the executor actually depends on
 *    (the full matrix is table-tested in run-control-rules.test.ts)
 * ========================================================================== */

describe("completionTransition — the cells this code rides on", () => {
  test("running + completed + flag → requeue, no notify, flag cleared", () => {
    const d = completionTransition({
      outcome: "completed",
      rowStatus: "running",
      pendingInput: true,
    });
    assert.equal(d.write, true);
    assert.equal(d.status, "queued");
    assert.equal(d.clearPendingInput, true);
    assert.equal(d.notify, false);
    assert.equal(d.stampCompletedAt, false);
    assert.equal(d.yielded, false);
  });

  test("a non-running row yields for every outcome, flag or not", () => {
    for (const rowStatus of ["paused", "cancelled", "completed", "failed", "stuck", "queued"] as const) {
      for (const outcome of ["completed", "failed", "stuck"] as const) {
        for (const pendingInput of [true, false]) {
          const d = completionTransition({ outcome, rowStatus, pendingInput });
          assert.equal(d.write, false, `${outcome}/${rowStatus}/${pendingInput}`);
          assert.equal(d.yielded, true);
          assert.equal(d.notify, false);
          assert.equal(d.status, null);
          assert.match(d.reason, /^completion yielded to operator status /);
        }
      }
    }
  });
});
