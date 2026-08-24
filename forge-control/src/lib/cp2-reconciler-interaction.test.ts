/**
 * CP2-2 (round 1001): the structural facts C9's re-verification rests on.
 *
 * Companion to docs/plan/evidence/cp2-c9-reconciler.md, which argues claims
 * A–H of 07 §7 against the round-1001 reconciler. This file pins the code
 * properties that argument quotes, so a later edit that invalidates it fails
 * the suite instead of quietly making the document a lie.
 *
 * SOURCE-ASSERTION, not import-and-call — same reason as
 * run-control-surface.test.ts and project-tick.test.ts's T19 block: there is no
 * test database, and db/projects.ts, db/runs.ts and executor.ts all open a pg
 * Pool at module load, so importing any of them from a test process connects
 * before a single assertion runs. Nothing here imports db/, routes/ or
 * executor.ts; every assertion reads source text with readFileSync.
 *
 * SCOPE DISCIPLINE. Every assertion below names the claim it protects. The
 * overlap with project-tick.test.ts's T19 block is deliberate but narrow: T19
 * spot-checks the R906 guard, this file asserts the properties the CP2 argument
 * adds — that consolidation has exactly ONE entry point, that EVERY branch of
 * it is gated (not just the three T19 samples), that the settled predicate is
 * the shared three-term rule and not an inline run-status test (R1005 findings
 * 1 and 2 rewrote this one: it used to read "run-status-only"), and that no
 * delivery write is split in two.
 *
 * TWO ASSERTIONS DESCRIBE THE HANDSHAKE THE DETECTOR HAS TO SURVIVE — the
 * E1/E2 split and the sweep's 60s floor (claim B / finding F1). They were
 * written as documentation of a hole; R1005 closed the hole in
 * db/projects.ts's predicate rather than in the handshake, which is correct as
 * designed, so both assertions are unchanged and now read as the WHY of the
 * pending_input term rather than as a known defect.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const PROJECTS_DB = readSource("../db/projects.ts");
const RUNS_DB = readSource("../db/runs.ts");
const TICK = readSource("./project-tick.ts");
const RECONCILE = readSource("./project-reconcile.ts");
const EXECUTOR = readSource("../executor.ts");

/** Slice from one marker to the next so an assertion cannot accidentally match
 *  prose in a neighbouring JSDoc block or SQL in the next function. Both
 *  markers must exist and be in order, or the test fails naming the missing
 *  one — a rename must break loudly here, not silently pass an empty string. */
function sliceBetween(src: string, from: string, to: string, label: string): string {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `${label}: start marker ${JSON.stringify(from)} not found`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `${label}: end marker ${JSON.stringify(to)} not found after the start`);
  return src.slice(start, end);
}

/* ========================================================================== *
 * CLAIM A — a `done` task is invisible to the reconciler forever
 *
 * The whole of A (and the "cannot re-consolidate" half of F(i)) is one WHERE
 * clause plus the fact that reconciliation has exactly one entry point.
 * ========================================================================== */

describe("claim A — listSettledRunningTasks is the only door, and it filters the TASK", () => {
  const body = sliceBetween(
    PROJECTS_DB,
    "export async function listSettledRunningTasks",
    "/** Every gating task of one project+round",
    "listSettledRunningTasks",
  );

  test("the WHERE filters on pt.status = 'running'", () => {
    // A task already marked 'done' can never be returned again, so resuming its
    // run later cannot re-reconcile, double-notify or re-consolidate it.
    assert.match(body, /WHERE pt\.status = 'running'/);
  });

  test("the settled-run set is exactly completed|failed|cancelled|stuck", () => {
    // Claim D rides on the same list: 'paused' and 'queued' are absent, which is
    // why a stopped run is ignored by the reconciler and its task sits 'running'.
    assert.match(body, /AND r\.status IN \('completed','failed','cancelled','stuck'\)/);
    assert.doesNotMatch(body, /'paused'/);
  });

  test("consolidateVerdictGroup has exactly one call site, fed by that query", () => {
    // If consolidation could be entered from anywhere else — an API route, a
    // retry path — claim A would protect nothing, because that door would not
    // carry the pt.status='running' filter.
    const callSites = (TICK.match(/await consolidateVerdictGroup\(/g) ?? []).length;
    assert.equal(callSites, 1, "consolidateVerdictGroup must have exactly one call site");

    const reconcile = sliceBetween(
      TICK,
      "async function reconcileSettledTasks(",
      "const DEFAULT_CHECKIN_HOURS",
      "reconcileSettledTasks",
    );
    assert.match(reconcile, /const settled = await listSettledRunningTasks\(\);/);
    // The round keys are built inside the loop over `settled` and consumed
    // after it; nothing else writes to the map.
    const keyWrites = (reconcile.match(/verdictRounds\.set\(/g) ?? []).length;
    assert.equal(keyWrites, 1, "verdictRounds must be populated from the settled loop only");
  });

  test("retryTask cannot bring a 'done' task back to 'running'", () => {
    // 'done' is terminal for the row: the only status writer that moves a task
    // backwards is retryTask, and its precondition excludes 'done'.
    const retry = sliceBetween(
      PROJECTS_DB,
      "export async function retryTask(",
      "export async function",
      "retryTask",
    );
    assert.match(retry, /WHERE id = \$1 AND status IN \('failed','blocked'\)/);
  });
});

/* ========================================================================== *
 * CLAIM B — the settled-but-not-consolidated reviewer
 *
 * Two halves: the group waits while the run is out of `completed` (the settled
 * predicate), and the R906 optimistic concurrency that covers the window after
 * listVerdictRound's read.
 * ========================================================================== */

describe("claim B — the group's settled predicate has ONE definition", () => {
  test("listVerdictRound is a LEFT JOIN and does NOT filter pt.status", () => {
    // LEFT JOIN so a task with no run yet surfaces as run_status NULL (→ not
    // settled → wait). No pt.status filter, so a member already marked 'done'
    // stays in the group's history — the caller decides what that means, and
    // since R1005 finding 2 it means SETTLED, unconditionally.
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function listVerdictRound",
      "/** What became of one chain row",
      "listVerdictRound",
    );
    assert.match(body, /LEFT JOIN runs r ON r\.id = pt\.run_id/);
    assert.match(body, /WHERE pt\.project_id = \$1/);
    assert.doesNotMatch(
      body,
      /pt\.status/,
      "listVerdictRound must not filter on task status - the caller decides what 'done' means",
    );
  });

  test("listVerdictRound projects pending_input as a boolean", () => {
    // R1005 finding 1: the decision layer cannot call a `completed` run settled
    // without knowing whether it still owes an undelivered turn, so the flag
    // has to travel with the row. COALESCE, not a bare comparison: a run with
    // no flag must read `false`, not NULL.
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function listVerdictRound",
      "/** What became of one chain row",
      "listVerdictRound",
    );
    assert.match(
      body,
      /COALESCE\(r\.metadata->>'pending_input' = 'true', false\) AS pending_input,/,
    );
  });

  test("project-tick delegates settled to verdictMemberSettled, all three inputs", () => {
    const consolidate = sliceBetween(
      TICK,
      "async function consolidateVerdictGroup(",
      "async function markGroupDone(",
      "consolidateVerdictGroup",
    );
    // The rule is pure and table-tested in project-reconcile.test.ts. What is
    // asserted here is that consolidation actually ROUTES through it and feeds
    // it the task status and the pending flag, not just the run status — an
    // inline predicate here is how the two halves drifted apart in the first
    // place (R1005 findings 1 and 2).
    assert.match(consolidate, /settled: verdictMemberSettled\(\{/);
    assert.match(consolidate, /taskStatus: r\.status,/);
    assert.match(consolidate, /runStatus: r\.run_status,/);
    assert.match(consolidate, /pendingInput: r\.pending_input,/);
    assert.doesNotMatch(
      consolidate,
      /settled: r\.run_status === "completed",/,
      "the run-status-only predicate is R1005 finding 2 - it must not come back",
    );
  });
});

describe("claim B — R906 optimistic concurrency (the detector and its consumers)", () => {
  const markDone = sliceBetween(
    PROJECTS_DB,
    "export async function markVerdictTaskDone",
    "/**",
    "markVerdictTaskDone",
  );

  const unsettled = sliceBetween(
    PROJECTS_DB,
    "export async function unsettledVerdictTasks",
    "/** Automatic-retry ceiling",
    "unsettledVerdictTasks",
  );

  test("the UPDATE carries r.status = 'completed' and returns a rowCount boolean", () => {
    assert.match(markDone, /AND r\.status = 'completed'/);
    assert.match(markDone, /return \(r\.rowCount \?\? 0\) > 0;/);
  });

  test("the detector excludes a `completed` run that still owes a turn (F1)", () => {
    // R1005 finding 1. completeRun is E1+E2; a crash between them leaves the
    // row `completed` with pending_input='true' and an undelivered message.
    // Closing a round there buries the revised verdict in a 'done' task.
    // IS DISTINCT FROM, not <>: no flag means NULL, which must PASS the test.
    assert.match(markDone, /AND \(r\.metadata->>'pending_input'\) IS DISTINCT FROM 'true'/);
    assert.match(unsettled, /OR r\.metadata->>'pending_input' = 'true'/);
  });

  test("an already-'done' task re-confirms without consulting its run (F2)", () => {
    // R1005 finding 2(b)/(c): a member marked 'done' by an earlier tick was
    // settled by BOOKKEEPING. Its run may since have been resumed, stopped or
    // failed, and none of that may make the round un-closeable. EXISTS rather
    // than `FROM runs r`, because an UPDATE ... FROM is an inner join and would
    // drop a done task whose run reference was cleared.
    assert.match(markDone, /AND \(pt\.status = 'done'/);
    assert.match(markDone, /OR EXISTS \(SELECT 1/);
    // The join must live INSIDE the EXISTS, never between the UPDATE's SET and
    // its WHERE: `UPDATE ... FROM runs r` is an inner join, and a 'done' task
    // whose run reference was cleared would then be unable to re-confirm.
    const updateHead = sliceBetween(
      markDone,
      "UPDATE project_tasks pt",
      "WHERE pt.id = $1",
      "markVerdictTaskDone UPDATE head",
    );
    assert.doesNotMatch(updateHead, /FROM runs/);
    assert.match(unsettled, /AND pt\.status IS DISTINCT FROM 'done'/);
  });

  test("the two predicates are exact complements, term for term", () => {
    // THE property. The pre-check runs immediately before the irreversible step
    // and the mark-done is the backstop behind it, so a term in one and not the
    // other is either a round that half-closes (pre-check passes, mark-done
    // refuses) or one that never closes (the reverse). Asserted structurally:
    // each of the three terms appears in both, in its negated form.
    for (const [positive, negated] of [
      [/pt\.status = 'done'/, /pt\.status IS DISTINCT FROM 'done'/],
      [/r\.status = 'completed'/, /r\.status IS DISTINCT FROM 'completed'/],
      [
        /\(r\.metadata->>'pending_input'\) IS DISTINCT FROM 'true'/,
        /r\.metadata->>'pending_input' = 'true'/,
      ],
    ] as const) {
      assert.match(markDone, positive);
      assert.match(unsettled, negated);
    }
  });

  test("unsettledVerdictTasks treats a run-less task as unsettled", () => {
    assert.match(unsettled, /LEFT JOIN runs r ON r\.id = pt\.run_id/);
    assert.match(unsettled, /r\.status IS DISTINCT FROM 'completed'/);
  });

  test("EVERY branch of the consolidation switch is gated on the detector", () => {
    // T19 in project-tick.test.ts spot-checks pass/block/fix. This asserts
    // TOTALITY: the set of branches is exactly the four the argument in
    // cp2-c9-reconciler.md walks, and each one either has no side effect
    // (`wait`) or routes its side effect through markGroupDone — so a FIFTH
    // branch added later cannot quietly close a round unguarded.
    const consolidate = sliceBetween(
      TICK,
      "async function consolidateVerdictGroup(",
      "async function markGroupDone(",
      "consolidateVerdictGroup",
    );
    const branches = [...consolidate.matchAll(/^\s{4}case "([a-z ]+)": \{$/gm)].map((m) => m[1]);
    assert.deepEqual(
      branches,
      ["wait", "pass", "block", "fix"],
      "the consolidation switch's branches changed - re-argue docs/plan/evidence/cp2-c9-reconciler.md",
    );

    const bodyOf = (name: string, next: string | null): string =>
      next
        ? sliceBetween(consolidate, `case "${name}": {`, `case "${next}": {`, `${name} branch`)
        : consolidate.slice(consolidate.indexOf(`case "${name}": {`));

    // `wait` is the invariant: nothing is marked, created, blocked or pushed.
    const wait = bodyOf("wait", "pass");
    for (const forbidden of [
      "markGroupDone",
      "createFixChain",
      "setProjectStatus",
      "queueNotification",
    ]) {
      assert.ok(
        !wait.includes(forbidden),
        `the wait branch must have no side effect, found ${forbidden}`,
      );
    }

    // Every acting branch consumes markGroupDone's verdict.
    for (const [name, next] of [
      ["pass", "block"],
      ["block", "fix"],
      ["fix", null],
    ] as const) {
      const branch = bodyOf(name, next);
      assert.match(
        branch,
        /const refused[A-Za-z]* = await markGroupDone\(inputs\);/,
        `the ${name} branch must capture markGroupDone's refusals`,
      );
      assert.match(
        branch,
        /logGroupNotReleased\(/,
        `the ${name} branch must report a refusal instead of swallowing it`,
      );
    }

    // The two irreversible branches pre-check immediately before the step that
    // cannot be taken back (block: the project + the push; fix: the chain).
    const block = bodyOf("block", "fix");
    assert.ok(
      block.indexOf("unsettledVerdictTasks") < block.indexOf("await setProjectStatus("),
      "block must pre-check before blocking the project",
    );
    const fix = bodyOf("fix", null);
    assert.ok(
      fix.indexOf("unsettledVerdictTasks") < fix.indexOf("await createFixChain("),
      "fix must pre-check before inserting the chain",
    );
  });

  test("markGroupDone routes every write through the preconditioned helper", () => {
    const body = sliceBetween(
      TICK,
      "async function markGroupDone(",
      "function logGroupNotReleased(",
      "markGroupDone",
    );
    assert.match(body, /if \(!\(await markVerdictTaskDone\(r\.taskId\)\)\) refused\.push\(r\);/);
    assert.doesNotMatch(body, /setTaskStatus\(/);
  });
});

/* ========================================================================== *
 * R1007 — the PROSE around the settlement rule, pinned like the SQL
 *
 * R1006 blocked this lane on three comments that the R1005 fix falsified and
 * left behind, one of which restated verbatim the claim the fix existed to
 * refute. A stale comment here is not cosmetic: the specific trap named in the
 * review is a maintainer restoring consistency between comment and code by
 * re-adding `AND r.status='completed'` to the done branch, which reinstates the
 * forever-wedge R1005 finding 2 removed. The three predicates are already
 * pinned above; these assertions pin the sentences that TELL A READER what the
 * predicates mean, so prose and rule can only drift apart through a failing
 * test.
 * ========================================================================== */

describe("R1007 — the settlement rule's prose cannot drift back", () => {
  /** Strip JSDoc leaders and collapse the wrapping so an assertion matches a
   *  SENTENCE rather than a particular line break — otherwise re-flowing a
   *  paragraph fails a test that has no opinion about line width. */
  const prose = (s: string): string => s.replace(/^\s*\*+\/?/gm, " ").replace(/\s+/g, " ").trim();

  test("markGroupDone's docstring describes the three-term rule, not `completed`", () => {
    const doc = prose(
      sliceBetween(
        TICK,
        "/** Mark every gating task of a decided group 'done'",
        "async function markGroupDone(",
        "markGroupDone docstring",
      ),
    );
    // Positive: it names the shared rule and its two arms.
    assert.match(doc, /verdictMemberSettled/);
    assert.match(doc, /'done' already, or a `completed` run owing no undelivered turn/);
    // Negative: the three sentences R1006 finding 1 struck. Each one asserted a
    // run-status precondition that the done branch no longer has.
    assert.doesNotMatch(
      doc,
      /still being settled \(`completed`\)/,
      "the done branch is NOT preconditioned on its run - R1005 finding 2(b)",
    );
    assert.doesNotMatch(
      doc,
      /whose run is still completed/,
      "re-marking a 'done' row is a no-op regardless of its run - do not re-qualify this",
    );
    assert.doesNotMatch(
      doc,
      /exact detector/,
      "db/projects.ts now states the opposite in as many words - R1005 finding 1",
    );
  });

  test("VerdictInput.settled's comment matches verdictMemberSettled", () => {
    const iface = prose(
      sliceBetween(RECONCILE, "export interface VerdictInput {", "/** One re-check task", "VerdictInput"),
    );
    assert.match(iface, /verdictMemberSettled\(\)/);
    assert.doesNotMatch(
      iface,
      /Its run status is 'completed'\./,
      "`settled` is true for a 'done' member with any run status, and false for a " +
        "`completed` run carrying pending_input - R1006 finding 2",
    );
  });

  test("the refusal log names BOTH causes a refusal can have", () => {
    // R1006 finding 3: this line is the only trace the abandoned round leaves,
    // so a refusal caused by an undelivered turn must not tell Konrad a message
    // requeued a run that never moved.
    const body = prose(
      sliceBetween(
        TICK,
        "function logGroupNotReleased(",
        "/** Per-task and per-round progress pushes",
        "logGroupNotReleased",
      ),
    );
    assert.match(body, /a message requeued the run/);
    assert.match(body, /'completed' still owing an undelivered turn/);
    assert.doesNotMatch(
      body,
      /left 'completed' while the/,
      "a refusal no longer implies the run left 'completed' - R1006 finding 3",
    );
  });
});

/* ========================================================================== *
 * CLAIM C — terminate → cancelled → task failed, project blocked, ONE push
 * CLAIM D — stop → paused → ignored, task stays 'running', heartbeat reports it
 * ========================================================================== */

describe("claim C — a non-completed run fails its task before any verdict handling", () => {
  const reconcile = sliceBetween(
    TICK,
    "async function reconcileSettledTasks(",
    "const DEFAULT_CHECKIN_HOURS",
    "reconcileSettledTasks",
  );
  const nonCompleted = sliceBetween(
    reconcile,
    'if (task.run_status !== "completed") {',
    "if (isVerdictRole(task.role)) {",
    "non-completed branch",
  );

  test("the branch precedes the verdict-role branch and ends in `continue`", () => {
    // Order is the claim: a CANCELLED reviewer must take the failure path, not
    // the consolidation path, or terminate would be decided on as a verdict.
    assert.ok(
      reconcile.indexOf('if (task.run_status !== "completed") {') <
        reconcile.indexOf("if (isVerdictRole(task.role)) {"),
      "the failure branch must be evaluated before the verdict-role branch",
    );
    assert.match(nonCompleted, /continue;\s*\}\s*$/);
  });

  test("it fails the task, blocks the project, and pushes exactly once", () => {
    assert.match(nonCompleted, /await setTaskStatus\(task\.id, "failed"\);/);
    assert.match(nonCompleted, /await setProjectStatus\(task\.project_id, "blocked"\);/);
    const pushes = (nonCompleted.match(/await queueNotification\(/g) ?? []).length;
    assert.equal(pushes, 1, "a cancelled/failed task must notify exactly once - not twice, not zero");
  });

  test("deferForUsageWall cannot divert a cancelled run away from that path", () => {
    // A terminate must not be mistaken for a usage wall and parked: the first
    // refusal is an equality on 'failed'.
    const defer = sliceBetween(
      TICK,
      "export async function deferForUsageWall(",
      "async function reconcileSettledTasks(",
      "deferForUsageWall",
    );
    assert.match(defer, /if \(task\.run_status !== "failed" \|\| !task\.run_id\) return false;/);
  });
});

describe("claim D — a paused task stays visible to Konrad through the heartbeat", () => {
  test("listGoalProgress reports titles of tasks in status 'running'", () => {
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function listGoalProgress",
      "/** Promote every 'pending' task",
      "listGoalProgress",
    );
    assert.match(body, /FILTER \(WHERE pt\.status = 'running'\)\s*,\s*'\{\}'\)\s*AS running_titles/);
    assert.match(body, /WHERE p\.status = 'active'/);
  });
});

/* ========================================================================== *
 * CLAIMS E + G — no delivery write may leave a settled run `completed`
 *
 * The detector in markVerdictTaskDone is exact only while every write that can
 * deliver a message to a settled run moves it out of `completed` in the SAME
 * statement as the append. resume-chat (CP2-1) and subagent-message (CP2-3)
 * both ride appendCommsEntry, so this is where that invariant is pinned.
 * ========================================================================== */

describe("claim E/G — appendCommsEntry is exactly one statement", () => {
  const body = sliceBetween(
    RUNS_DB,
    "export async function appendCommsEntry",
    "/**",
    "appendCommsEntry",
  );

  test("the function body issues exactly one pool.query", () => {
    // One write means no interleaving is possible between the append and the
    // status move. The rowcount-0 re-read is readRunStatus(), a SELECT called
    // only when nothing was written, so it cannot be a second write path.
    const queries = (body.match(/pool\.query/g) ?? []).length;
    assert.equal(queries, 1, "appendCommsEntry must issue exactly one pool.query");
    assert.match(body, /UPDATE runs SET \$\{sets\.join\(", "\)\} WHERE \$\{where\}/);
  });

  test("append, status, pending_input and both stamps are fragments of that ONE statement", () => {
    const setsBlock = sliceBetween(body, "const sets = [", "let where =", "sets assembly");
    assert.match(setsBlock, /thread = thread \|\| \$2::jsonb/);
    assert.match(setsBlock, /sets\.push\(`status = \$\$\{params\.length\}`\)/);
    assert.match(setsBlock, /'\{"pending_input":true\}'::jsonb/);
    assert.match(setsBlock, /- 'pending_input'/); // clearPendingInput (CP2-1)
    assert.match(setsBlock, /completed_at = NULL/);
    assert.match(setsBlock, /wake_after = NULL/);
  });

  test("setPendingInput + clearPendingInput throws rather than letting order decide", () => {
    // C20: two conflicting SET fragments on one jsonb column in one statement is
    // a programming error and must surface, not resolve itself.
    assert.match(body, /if \(opts\.setPendingInput && opts\.clearPendingInput\) \{/);
    assert.match(body, /throw new Error\(/);
  });

  test("the WHERE carries the caller's eligibility precondition", () => {
    assert.match(body, /AND status = ANY\(\$\$\{params\.length\}::text\[\]\)/);
  });
});

describe("claim G — every other thread writer is single-statement or cannot touch a settled run", () => {
  test("appendMessage sets thread and status in the SAME statement", () => {
    // The pre-existing delivery path (POST /api/chat/:id/message, the telegram
    // bridge, POST /:id/resume) that subagent-message's relay inherits nothing
    // from but which targets the same rows.
    const body = sliceBetween(
      RUNS_DB,
      "export async function appendMessage",
      "/** Set (or clear with null) metadata.model",
      "appendMessage",
    );
    const withStatus = sliceBetween(body, "const sql = newStatus", ": `UPDATE runs", "sql variant");
    assert.match(withStatus, /SET thread = thread \|\| \$2::jsonb,\s*\n\s*status = \$3,/);
  });

  test("requeueRunAfterUsageWall is one statement and only ever touches a 'failed' row", () => {
    const body = sliceBetween(
      RUNS_DB,
      "export async function requeueRunAfterUsageWall",
      "export async function runCounts",
      "requeueRunAfterUsageWall",
    );
    assert.equal((body.match(/pool\.query/g) ?? []).length, 1);
    assert.match(body, /thread = thread \|\| \$3::jsonb/);
    assert.match(body, /AND status = 'failed'/);
  });

  /* The API-overload park (529/503) is the same kind of writer as the
   * usage-wall park and is held to the same invariant.
   *
   * Its slice ENDS at the usage-wall function because it sits immediately
   * above it — which is also why it sits there. Inserting it between the
   * usage-wall marker and `runCounts` put two `pool.query` calls inside the
   * slice above and turned that assertion red. The boundary markers in this
   * file are load-bearing: a new thread writer goes ABOVE a marker, never
   * between a marker and its terminator. */
  test("requeueRunAfterApiOverload is one statement and only ever touches a 'failed' row", () => {
    const body = sliceBetween(
      RUNS_DB,
      "export async function requeueRunAfterApiOverload",
      "export async function requeueRunAfterUsageWall",
      "requeueRunAfterApiOverload",
    );
    assert.equal((body.match(/pool\.query/g) ?? []).length, 1);
    assert.match(body, /thread = thread \|\| \$3::jsonb/);
    assert.match(body, /AND status = 'failed'/);
    // Its own counter. Sharing `usage_wall_attempts` would let a busy-server
    // blip spend the retries a real quota wall needs.
    assert.match(body, /api_overload_attempts/);
    assert.doesNotMatch(body, /usage_wall_attempts/);
  });

  test("the executor's streamed append never moves status", () => {
    const body = sliceBetween(
      EXECUTOR,
      "async function appendThreadEntry(",
      "async function saveCcSession(",
      "appendThreadEntry",
    );
    assert.match(body, /SET thread = thread \|\| \$2::jsonb/);
    assert.doesNotMatch(body, /status =/);
  });
});

/* ========================================================================== *
 * FINDING F1 (FIXED IN R1005) — the window in which a `completed` row still
 * owes a turn
 *
 * These two assertions describe the window, not a guarantee about it. The
 * repair went into db/projects.ts's detector predicate (the pending_input term
 * asserted under claim B above), not into the handshake, which is correct as
 * designed — so both still hold, and they are what makes that term necessary.
 * If the handshake ever becomes one statement, the term becomes redundant
 * rather than wrong, and these tests are where that is noticed.
 * ========================================================================== */

describe("finding F1 — E1/E2 is a two-statement handshake with a 60s sweep floor", () => {
  const complete = sliceBetween(
    EXECUTOR,
    "async function completeRun(",
    "* v2.2: push run outcomes to Telegram",
    "completeRun",
  );

  test("E1 and E2 are separate statements, so a crash can strand `completed`+pending_input", () => {
    // E1 completes the run and RETURNs the flag; E2 requeues it. Both guarded,
    // but between them the row is `completed` with an undelivered message in
    // its thread. markVerdictTaskDone used to accept exactly that row; since
    // R1005 its predicate carries the pending_input term, so the round waits
    // for the sweep instead of closing on the pre-message verdict.
    assert.match(complete, /RETURNING status, metadata->>'pending_input' AS pending_input/);
    assert.match(complete, /WHERE id = \$1 AND status = 'completed'/); // E2's own guard
    assert.ok(
      (complete.match(/await pool\.query/g) ?? []).length >= 2,
      "completeRun's handshake is two statements - this test documents the F1 window",
    );
  });

  test("the sweep's scope is exactly the F1 window, and it waits 60s", () => {
    const sweep = sliceBetween(
      EXECUTOR,
      "async function pendingInputSweepTick(",
      "async function managerLoop(",
      "pendingInputSweepTick",
    );
    assert.match(sweep, /WHERE status = 'completed'\s*\n\s*AND metadata->>'pending_input' = 'true'/);
    assert.match(sweep, /AND updated_at < now\(\) - \(interval '1 millisecond' \* \$1\)/);
    assert.match(EXECUTOR, /const PENDING_INPUT_STRANDED_MS = 60_000;/);
    // ≥60s during which a settled-looking reviewer run owes another turn: the
    // interleaving in docs/plan/evidence/cp2-c9-reconciler.md §B, steps 1-6.
  });
});

/* ========================================================================== *
 * R40 (round 221, phase 4B) — THE GROUP IS (project, round, workstream)
 *
 * APPENDED, never edited: everything above this line is byte-identical to the
 * commit this phase started from, which is R43's acceptance gate. Claims A–H
 * above are about the group's DECISION and are untouched by this change; what
 * is asserted here is that the group's DEFINITION carries the workstream all
 * the way down the delivery path — the query, the map key, the failure
 * counter, the chain keys and the row identities.
 *
 * WHY IT IS A DEFINITION AND NOT A DECISION. Without the workstream term, two
 * reviewers at the same computed depth in different workstreams consolidate as
 * ONE group and produce ONE merged fix builder. A fix builder can only be
 * spawned into one worktree, so the other workstream's findings are delivered
 * NOWHERE — a dropped verdict, which is the exact silent outcome this module
 * exists to prevent (02-architecture.md §5).
 *
 * SOURCE-ASSERTION for the same reason as every block above: db/projects.ts and
 * project-tick.ts both reach a pg Pool at import, and there is no test
 * database. The pure half — `groupKey`, `chainKeys`, `fixChainGraphFields`,
 * `duplicatesFixChain`, the titles — is imported and CALLED in
 * project-reconcile.test.ts's T21–T29.
 * ========================================================================== */

import {
  consolidateVerdictRound,
  chainKeys,
  FIX_TASK_TITLE,
  RECHECK_TASK_TITLE,
  MAIN_WORKSTREAM,
  type VerdictInput,
} from "./project-reconcile.ts";

describe("R40 — two same-round reviewers in different workstreams are TWO chains", () => {
  /** A settled reviewer that wants fixes. Deliberately built here rather than
   *  shared with the file above: nothing in claims A–H may move. */
  function dissenter(taskId: string, title: string): VerdictInput {
    return {
      taskId,
      role: "reviewer",
      title,
      fixCycle: 0,
      settled: true,
      lastText: "VERDICT: NEEDS_FIXES",
    };
  }

  test("the two groups produce two independent chains, sharing no key", () => {
    const main = consolidateVerdictRound(7, [dissenter("m1", "Review main")], 3, MAIN_WORKSTREAM);
    const ui = consolidateVerdictRound(7, [dissenter("u1", "Review ui")], 3, "ui");
    assert.equal(main.action, "fix");
    assert.equal(ui.action, "fix");
    if (main.action !== "fix" || ui.action !== "fix") return;

    const keys = [
      main.builderChainKey,
      ...main.checkers.map((c) => c.chainKey),
      ui.builderChainKey,
      ...ui.checkers.map((c) => c.chainKey),
    ];
    assert.equal(new Set(keys).size, keys.length, `chain keys collided: ${keys.join(" ")}`);
    // ...and `main`'s three are the historical strings, byte for byte, so a
    // pre-0040 round replays against the row it already wrote (R41).
    assert.equal(main.builderChainKey, chainKeys(7, 1).builder);
    assert.equal(main.builderChainKey, "fix:7:1");
  });

  test("neither group's merged feedback reaches the other's builder", () => {
    const main = consolidateVerdictRound(7, [dissenter("m1", "Review main")], 3, MAIN_WORKSTREAM);
    const ui = consolidateVerdictRound(7, [dissenter("u1", "Review ui")], 3, "ui");
    if (main.action !== "fix" || ui.action !== "fix") throw new Error("expected two fix decisions");
    assert.doesNotMatch(main.mergedBrief, /Review ui/);
    assert.doesNotMatch(ui.mergedBrief, /Review main/);
  });

  test("their rows cannot collide on project_tasks_identity_idx either", () => {
    // (project_id, round, role, title), migration 0035 — no workstream term,
    // and 0040 added none. Both builders land at round 8 with role 'builder',
    // so the TITLE is the only thing that can separate them. If it could not,
    // insertChainRow would classify the second `occupied` and the project would
    // block with that workstream's feedback undelivered — R40's own failure,
    // through the other index.
    assert.notEqual(FIX_TASK_TITLE(1, MAIN_WORKSTREAM), FIX_TASK_TITLE(1, "ui"));
    assert.notEqual(
      RECHECK_TASK_TITLE("reviewer", 1, MAIN_WORKSTREAM),
      RECHECK_TASK_TITLE("reviewer", 1, "ui"),
    );
    // The historical form is unmoved for `main`.
    assert.equal(FIX_TASK_TITLE(1), "Fix cycle 1");
    assert.equal(RECHECK_TASK_TITLE("reviewer", 1), "Re-review after fix cycle 1");
  });
});

describe("R40 — the workstream term reaches every site that keys on (project, round)", () => {
  test("listVerdictRound filters the workstream, and still does not filter pt.status", () => {
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function listVerdictRound",
      "/** What became of one chain row",
      "listVerdictRound",
    );
    assert.match(body, /AND pt\.workstream = \$3/);
    assert.match(body, /AND pt\.role = ANY\(\$4::text\[\]\)/);
    // Claim B's property, re-asserted because this edit touched the WHERE it
    // lives in: the caller decides what 'done' means, not the query.
    assert.doesNotMatch(
      body,
      /pt\.status/,
      "listVerdictRound must not filter on task status - the caller decides what 'done' means",
    );
  });

  test("the reconcile pass keys its group map — and the failure counter — on the workstream", () => {
    const body = sliceBetween(
      TICK,
      "async function reconcileSettledTasks(",
      "const DEFAULT_CHECKIN_HOURS",
      "reconcileSettledTasks",
    );
    assert.match(body, /verdictRounds\.set\(`\$\{task\.project_id\}:\$\{groupKey\(task\)\}`/);
    assert.match(body, /workstream: task\.workstream,/);
    // The SAME `key` feeds noteGroupFailure, so a workstream wedged on a schema
    // drift escalates on its own behalf and not on a healthy neighbour's.
    assert.match(body, /noteGroupFailure\(groupFailures, key, MAX_GROUP_FAILURES\)/);
    assert.match(body, /await consolidateVerdictGroup\(projectId, round, workstream\)/);
    assert.doesNotMatch(
      body,
      /verdictRounds\.set\(`\$\{task\.project_id\}:\$\{task\.round\}`/,
      "the round-only group key is R40's bug - it must not come back",
    );
  });

  test("consolidation still has exactly one entry point, now taking three arguments", () => {
    // Claim A rests on this. A second door would mean a group could be decided
    // without the workstream that names its worktree.
    const calls = TICK.match(/await consolidateVerdictGroup\(/g) ?? [];
    assert.equal(calls.length, 1, "consolidateVerdictGroup must have exactly one call site");
    assert.match(TICK, /async function consolidateVerdictGroup\(\s*\n\s*projectId: string,\s*\n\s*round: number,\s*\n\s*workstream: string,/);
  });

  test("roundIsComplete is group completion, at BOTH of its call sites (R45)", () => {
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function roundIsComplete",
      "export interface SettledRunningTask",
      "roundIsComplete",
    );
    // 2026-08-25: roundIsComplete became TWO subqueries — "nothing still open"
    // AND "at least one row actually finished" — so that a group whose every
    // task was CANCELLED reports incomplete instead of firing 🏁 at Konrad for
    // work nobody carried. The single-literal match that used to stand here
    // could not survive that. R45's claim is unchanged and is now asserted over
    // BOTH subqueries: if either lost the workstream term, one workstream's
    // rows would answer for another's.
    const keyed =
      body.match(/t\.project_id = \$1 AND t\.round = \$2 AND t\.workstream = \$3/g) ?? [];
    assert.equal(
      keyed.length,
      2,
      "every subquery in roundIsComplete must key on (project, round, workstream) — R45",
    );
    assert.match(
      body,
      /AND \$\{stillOpen\("t"\)\}/,
      "the open-rows test must use the one terminality rule, not a literal of its own",
    );
    assert.match(
      body,
      /AND EXISTS \([\s\S]*t\.status = 'done'/,
      "terminal is not carried: a group of only-cancelled rows must not report complete",
    );
    // Both callers pass one: the group path in consolidation, and the per-task
    // path for non-verdict roles. A caller that forgot would announce a round
    // another workstream is still working inside.
    assert.match(TICK, /roundIsComplete\(projectId, round, workstream\)/);
    assert.match(TICK, /roundIsComplete\(task\.project_id, task\.round, task\.workstream\)/);
    const calls = TICK.match(/roundIsComplete\(/g) ?? [];
    assert.equal(calls.length, 2, "roundIsComplete's call sites changed - re-check R45");
  });

  test("unwedgeProject retries ONE group, chosen by the pure helper (R46)", () => {
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function unwedgeProject",
      "export async function bumpFixCycle",
      "unwedgeProject",
    );
    assert.match(body, /SELECT DISTINCT round, workstream FROM project_tasks/);
    assert.match(body, /const group = earliestFailedGroup\(blocking\.rows\)/);
    assert.match(body, /WHERE project_id = \$1 AND round = \$2 AND workstream = \$3/);
    assert.doesNotMatch(
      body,
      /SELECT MIN\(round\)/,
      "the round-only selection restarts two workstreams at once - R46 replaced it",
    );
  });

  test("createFixChain writes the graph fields and guards the renumber hazard", () => {
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function createFixChain",
      "const ORIGIN_CHAT_KEY",
      "createFixChain",
    );
    // R42: without these the chain rows are graph roots and run immediately,
    // in parallel with the work they follow.
    assert.match(body, /round: input\.graph\.builder\.round,/);
    assert.match(body, /depends_on: input\.graph\.builder\.depends_on,/);
    assert.match(body, /workstream: input\.graph\.builder\.workstream,/);
    assert.match(body, /write_set: input\.graph\.builder\.write_set,/);
    assert.match(body, /depends_on: \[builder\.id\],/);
    /* BOTH inserts carry the inherited tier. The builder's was changed and the
     * checker's was left `tier: null`, so every re-check row was born untiered
     * and ran on the default engine — measured 100% NULL on rows created after
     * the first half of the fix went live, while the builders beside them
     * inherited fine. Two occurrences, and no bare `tier: null` left, is the
     * assertion that would have caught it. */
    assert.equal(
      (body.match(/tier: input\.tier \?\? null,/g) ?? []).length,
      2,
      "both the fix builder and every re-check row must inherit the chain's tier",
    );
    assert.doesNotMatch(
      body,
      /^\s*tier: null,\s*$/m,
      "a hardcoded `tier: null` in createFixChain sends that row to the default engine",
    );
    // R41: the guard runs inside the transaction, before anything is written.
    assert.ok(
      body.indexOf('await client.query("BEGIN")') < body.indexOf("duplicatesFixChain(candidate,"),
      "the guard must be inside the transaction",
    );
    assert.ok(
      body.indexOf("duplicatesFixChain(candidate,") <
        body.indexOf("const builder = await insertChainRow("),
      "the guard must run before the first INSERT, or a refusal writes half a chain",
    );
    // R44: the three-way classification is what catches a chain-key MISTAKE and
    // is deliberately not the thing carrying the hazard, so it stays exactly as
    // it was — in insertChainRow, which createFixChain calls.
    const insert = sliceBetween(
      PROJECTS_DB,
      "async function insertChainRow(",
      "/** Insert a fix builder",
      "insertChainRow",
    );
    assert.match(insert, /ON CONFLICT DO NOTHING/);
    assert.match(insert, /return \{ kind: "created", id: ins\.rows\[0\]\.id \};/);
    assert.match(insert, /return \{ kind: "replay", id: mine\.rows\[0\]\.id \};/);
    assert.match(insert, /kind: "occupied",/);
  });

  test("the empty-checkers refusal and the transaction shape are unchanged (R44)", () => {
    const body = sliceBetween(
      PROJECTS_DB,
      "export async function createFixChain",
      "const ORIGIN_CHAT_KEY",
      "createFixChain",
    );
    assert.match(body, /a fix cycle must be re-checked by at least one verdict role/);
    assert.match(body, /await client\.query\("BEGIN"\)/);
    assert.match(body, /await client\.query\("COMMIT"\)/);
    assert.match(body, /await client\.query\("ROLLBACK"\)/);
    // Sequential inserts: one client, one transaction, one statement in flight.
    // Asserted as the LOOP rather than as the absence of Promise.all, because
    // the comment beside it names Promise.all and a doesNotMatch would be
    // reading the explanation instead of the code.
    assert.match(body, /for \(const c of input\.checkers\) \{/);
    assert.doesNotMatch(body, /await Promise\.all\(/);
  });
});
