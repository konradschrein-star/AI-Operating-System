/**
 * Unit tests for `run-rollup.ts` — specifically the `pendingTools` map that
 * commit `3e63a45` added to the executor's hot path.
 *
 * WHY THIS FILE EXISTS: round 4's phase-7 finding 5. `run-rollup.ts` is
 * imported by `executor.ts` and `ingestEvent` runs on every streamed CC event
 * of every live run on this box, and the commit gave it its first piece of
 * cross-event STATE — a `Map` remembering which tool each parent
 * `tool_use_id` belongs to, so a `tool_result` can name the tool it answers.
 * The code reviewed clean, but `forge-control/src/lib/` held no test for the
 * module at all, so `pnpm test` (`tsx --test src/lib/*.test.ts`) had nothing
 * to run against it. Zero coverage on a stateful hot path was the finding;
 * this file is the coverage.
 *
 * WHAT IS ASSERTED, one test per bullet of that finding:
 *   §1  call/result pairing — a `tool_result` prints the name of the
 *       `tool_call` it answers, and the entry is gone afterwards.
 *   §2  an unseen `tool_use_id` → `tool: null`. The map must not invent a
 *       name for a result whose call this process never saw (executor
 *       restarted mid-run — the module header's own caveat).
 *   §3  `PENDING_TOOL_CAP` + 1 unanswered calls → the OLDEST is evicted and
 *       the newest survives. The cap is the backstop for results that never
 *       arrive; evicting the newest instead would be the silent inversion.
 *   §4  a SUBAGENT `tool_call` does not pollute the parent's map. Subagent
 *       events carry `parentToolUseId`, and their tool ids share a namespace
 *       with the parent's — crossing them would make a parent `tool_result`
 *       name a tool a child ran.
 *
 * These assertions are written to FAIL against the pre-`3e63a45` behaviour,
 * which wrote `tool: null` on every `tool_result` unconditionally. §1 is the
 * one that discriminates: a test that only checked "does not throw" would
 * pass on both implementations and prove nothing.
 *
 * NOTHING HERE OPENS A DATABASE CONNECTION — and that took one deliberate
 * move, because the module builds its `pg.Pool` at MODULE SCOPE from
 * `DATABASE_URL`, and `ingestEvent` calls `maybeFlush` on the very first
 * event (`lastFlushMs` starts at 0, so the 2 s throttle is already expired).
 * The default DSN in that module is the LIVE `content_forge` database. So
 * `DATABASE_URL` is pointed at a unix socket directory that does not exist
 * BEFORE the module is imported — hence the dynamic `import()` in `before()`
 * rather than a static one, since ESM hoists static imports above every
 * statement in the file. `flush()` then fails with `ENOENT` in about a
 * millisecond, touching no network and no server, and its `catch` re-flags
 * `dirty` exactly as it does in production.
 *
 * SO THE RUN PRINTS ONE LINE PER RUN ID, AND THAT IS EXPECTED OUTPUT:
 *
 *   # [run-rollup] flush run run-pairing failed: connect ENOENT
 *     /nonexistent-run-rollup-test-socket/.s.PGSQL.5432
 *
 * They arrive after the suite finishes, because the flush is a floating
 * promise nothing here can await — `flushInFlight` is private. Leave them.
 * They are the proof that the write path was exercised and degraded the way
 * it is written to, and a shim that swallowed them would fire before they
 * exist and be inert. `flush()` catches its own errors, so none of this can
 * surface as an unhandled rejection or keep the process alive.
 *
 * The alternative — a scratch Postgres, as `check-usage-fold.ts` does — was
 * rejected on purpose: gate 23 runs this glob with no database provisioned,
 * and a test that needs a server to be up is a test that goes yellow for
 * reasons that have nothing to do with the code.
 */

import { strict as assert } from "node:assert";
import { test, describe, before } from "node:test";

import type { CcEvent } from "./cc-runner.ts";

/** A socket directory that cannot exist, so `pg` fails on `connect()` without
 *  emitting a packet. Probed before it was written down here:
 *  `connect ENOENT /nonexistent-run-rollup-test-socket/.s.PGSQL.5432` in 1 ms. */
const DEAD_DSN =
  "postgresql://run-rollup-test@/run-rollup-test?host=/nonexistent-run-rollup-test-socket";

process.env.DATABASE_URL = DEAD_DSN;

type RollupModule = typeof import("./run-rollup.ts");
let rollup: RollupModule;

/** The module's own `PENDING_TOOL_CAP`, restated as a literal rather than
 *  imported: it is not exported, and importing a threshold from the subject
 *  makes the assertion inert at every value. If the module's cap changes,
 *  §3 must fail and be re-read, which is the point. */
const PENDING_TOOL_CAP = 64;

before(async () => {
  // Dynamic, so that `process.env.DATABASE_URL` above is already set when the
  // module builds its pool. A static import would run first and take the live
  // `content_forge` DSN from the module's own default.
  rollup = await import("./run-rollup.ts");
  assert.equal(
    process.env.DATABASE_URL,
    DEAD_DSN,
    "the subject must have been imported against the dead DSN, never the live default",
  );
});

/** A parent-run tool call. `parentToolUseId` absent === the parent's own event. */
function parentCall(toolUseId: string, toolName: string): CcEvent {
  return { type: "tool_call", toolUseId, toolName };
}

/** The result that answers it. */
function parentResult(toolUseId: string): CcEvent {
  return { type: "tool_result", toolUseId };
}

/** The same pair as seen from inside a Task subagent. */
function subCall(
  parentToolUseId: string,
  toolUseId: string,
  toolName: string,
): CcEvent {
  return { type: "tool_call", toolUseId, toolName, parentToolUseId };
}

/** Fails loudly rather than returning `null` — every test below has just fed
 *  the run at least one event, so an absent snapshot is a broken subject, not
 *  an expected branch. */
function snap(runId: string): NonNullable<ReturnType<RollupModule["_snapshotForTests"]>> {
  const s = rollup._snapshotForTests(runId);
  assert.notEqual(s, null, `no rollup state for run ${runId} — ingestEvent did nothing`);
  return s!;
}

describe("run-rollup pendingTools", () => {
  test("§1 a tool_result names the tool_call it answers, and clears the entry", () => {
    rollup._resetForTests();
    const run = "run-pairing";

    rollup.ingestEvent(run, parentCall("toolu_01", "Bash"));
    const afterCall = snap(run);
    assert.deepEqual(
      afterCall.pendingTools,
      [["toolu_01", "Bash"]],
      "the call must be remembered while it is in flight",
    );
    assert.equal(afterCall.currentActivity?.kind, "tool_call");
    assert.equal(afterCall.currentActivity?.tool, "Bash");

    rollup.ingestEvent(run, parentResult("toolu_01"));
    const afterResult = snap(run);
    // THE discriminating assertion: pre-3e63a45 this was null.
    assert.equal(afterResult.currentActivity?.kind, "tool_result");
    assert.equal(
      afterResult.currentActivity?.tool,
      "Bash",
      "the answering tool's name is what makes the activity cell non-blank",
    );
    assert.deepEqual(
      afterResult.pendingTools,
      [],
      "self-bounding: the entry is deleted the moment its result arrives",
    );
  });

  test("§1b parallel calls each resolve to their own tool, in any order", () => {
    rollup._resetForTests();
    const run = "run-parallel";

    rollup.ingestEvent(run, parentCall("toolu_a", "Read"));
    rollup.ingestEvent(run, parentCall("toolu_b", "Grep"));
    rollup.ingestEvent(run, parentCall("toolu_c", "Edit"));
    assert.equal(snap(run).pendingTools.length, 3);

    // Results come back out of order, as batched calls do.
    rollup.ingestEvent(run, parentResult("toolu_b"));
    assert.equal(snap(run).currentActivity?.tool, "Grep");
    rollup.ingestEvent(run, parentResult("toolu_c"));
    assert.equal(snap(run).currentActivity?.tool, "Edit");
    rollup.ingestEvent(run, parentResult("toolu_a"));
    assert.equal(snap(run).currentActivity?.tool, "Read");

    assert.deepEqual(snap(run).pendingTools, [], "all three drained");
  });

  test("§2 a result for an unseen tool_use_id degrades to tool: null, it does not guess", () => {
    rollup._resetForTests();
    const run = "run-restarted-midflight";

    // Exactly the executor-restart case the module header warns about: the
    // call happened in a previous process, the result lands in this one.
    rollup.ingestEvent(run, parentResult("toolu_from_a_dead_process"));
    const s = snap(run);
    assert.equal(s.currentActivity?.kind, "tool_result");
    assert.equal(
      s.currentActivity?.tool,
      null,
      "an unknown id must produce null, never another call's tool name",
    );
    assert.deepEqual(s.pendingTools, [], "an unseen id must not be inserted by its result");
  });

  test("§2b a stale result does not consume a different call's entry", () => {
    rollup._resetForTests();
    const run = "run-stale-result";

    rollup.ingestEvent(run, parentCall("toolu_live", "Write"));
    rollup.ingestEvent(run, parentResult("toolu_ghost"));

    const s = snap(run);
    assert.equal(s.currentActivity?.tool, null);
    assert.deepEqual(
      s.pendingTools,
      [["toolu_live", "Write"]],
      "the in-flight call must survive an unrelated result",
    );
  });

  test(`§3 at PENDING_TOOL_CAP+1 unanswered calls the OLDEST is evicted`, () => {
    rollup._resetForTests();
    const run = "run-never-answered";

    const total = PENDING_TOOL_CAP + 1; // 65
    for (let i = 0; i < total; i += 1) {
      rollup.ingestEvent(run, parentCall(`toolu_${i}`, `Tool${i}`));
    }

    const s = snap(run);
    assert.equal(
      s.pendingTools.length,
      PENDING_TOOL_CAP,
      "the map must be bounded, not merely small",
    );

    const keys = s.pendingTools.map(([k]) => k);
    assert.equal(keys.includes("toolu_0"), false, "the oldest un-answered call is forgotten");
    assert.equal(keys[0], "toolu_1", "eviction is from the front, in insertion order");
    assert.equal(
      keys[keys.length - 1],
      `toolu_${total - 1}`,
      "the newest call survives — evicting it instead would be the silent inversion",
    );

    // And the survivors still resolve: eviction must not corrupt the rest.
    rollup.ingestEvent(run, parentResult("toolu_64"));
    assert.equal(snap(run).currentActivity?.tool, "Tool64");

    // The evicted one now behaves exactly like §2 — null, not a wrong name.
    rollup.ingestEvent(run, parentResult("toolu_0"));
    assert.equal(
      snap(run).currentActivity?.tool,
      null,
      "an evicted call resolves to null, which is the honest answer",
    );
  });

  test("§3b the cap is not reached in the ordinary call/result rhythm", () => {
    rollup._resetForTests();
    const run = "run-normal-rhythm";

    // 500 calls, each answered before the next — the real shape of a run.
    for (let i = 0; i < 500; i += 1) {
      rollup.ingestEvent(run, parentCall(`toolu_${i}`, "Bash"));
      rollup.ingestEvent(run, parentResult(`toolu_${i}`));
    }
    assert.deepEqual(
      snap(run).pendingTools,
      [],
      "self-bounding means the cap is a backstop, not the normal steady state",
    );
  });

  test("§4 a subagent tool_call does not enter the parent's pendingTools", () => {
    rollup._resetForTests();
    const run = "run-with-subagent";

    // The parent spawns a Task; that IS a parent call and is remembered.
    rollup.ingestEvent(run, {
      type: "tool_call",
      toolUseId: "toolu_task",
      toolName: "Task",
      toolInput: JSON.stringify({ subagent_type: "builder", description: "wire the badge" }),
    });
    assert.deepEqual(snap(run).pendingTools, [["toolu_task", "Task"]]);
    assert.equal(snap(run).subagents.length, 1, "the Task spawn seeds a subagent row");

    // Everything the child then does carries parentToolUseId and must not
    // land in the parent's map.
    rollup.ingestEvent(run, subCall("toolu_task", "toolu_child_1", "Grep"));
    rollup.ingestEvent(run, subCall("toolu_task", "toolu_child_2", "Read"));
    assert.deepEqual(
      snap(run).pendingTools,
      [["toolu_task", "Task"]],
      "subagent calls must not pollute the parent's map",
    );
    assert.equal(
      snap(run).subagents[0]?.latest_activity?.tool,
      "Read",
      "they belong to the subagent's latest_activity instead",
    );

    // A child id colliding with the parent's namespace must still resolve to
    // null on the parent, not to the child's tool.
    rollup.ingestEvent(run, parentResult("toolu_child_1"));
    assert.equal(
      snap(run).currentActivity?.tool,
      null,
      "a parent result must never be answered by a tool the CHILD ran",
    );

    // The Task's own result closes the subagent AND resolves the label.
    rollup.ingestEvent(run, parentResult("toolu_task"));
    const s = snap(run);
    assert.equal(s.currentActivity?.tool, "Task");
    assert.equal(s.subagents[0]?.status, "done");
    assert.deepEqual(s.pendingTools, []);
  });

  test("§5 pendingTools is per-run — two live runs do not read each other", () => {
    rollup._resetForTests();

    rollup.ingestEvent("run-x", parentCall("toolu_same", "Bash"));
    rollup.ingestEvent("run-y", parentCall("toolu_same", "WebFetch"));

    rollup.ingestEvent("run-y", parentResult("toolu_same"));
    assert.equal(snap("run-y").currentActivity?.tool, "WebFetch");
    assert.deepEqual(
      snap("run-x").pendingTools,
      [["toolu_same", "Bash"]],
      "run-x's in-flight call is untouched by run-y's result",
    );
  });

  test("§6 a nameless or id-less tool_call is not remembered, and never throws", () => {
    rollup._resetForTests();
    const run = "run-degenerate";

    // toolName absent — nothing worth remembering, and null is the honest label.
    rollup.ingestEvent(run, { type: "tool_call", toolUseId: "toolu_nameless" });
    assert.deepEqual(snap(run).pendingTools, []);
    assert.equal(snap(run).currentActivity?.tool, null);

    // toolUseId absent — no key to file it under.
    rollup.ingestEvent(run, { type: "tool_call", toolName: "Bash" });
    assert.deepEqual(snap(run).pendingTools, []);
    assert.equal(snap(run).currentActivity?.tool, "Bash");

    // Empty-string id — the module rejects it explicitly; assert that.
    rollup.ingestEvent(run, { type: "tool_call", toolUseId: "", toolName: "Edit" });
    assert.deepEqual(snap(run).pendingTools, []);
  });
});
