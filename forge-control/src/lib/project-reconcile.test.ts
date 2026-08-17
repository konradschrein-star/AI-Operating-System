/**
 * Tests for the verdict-round consolidation module.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * T-numbers below are quoted from docs/plan/03-quality.md §1; the phase gate
 * cites them by number, so each `describe` block is named after one.
 *
 * The most important test in this file is T3 "dual NEEDS_FIXES" — it is the
 * direct regression guard for the first-night bug: two reviewers each firing
 * their own fix chain. `consolidateVerdictRound()` returns a single
 * `RoundDecision`, not an array, which makes a duplicate chain a type error
 * as much as a logic error. T17 extends the same guarantee across ROLES: a
 * reviewer and a tester in one round are one group, one decision, one builder.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseVerdict,
  projectAcceptsWork,
  consolidateVerdictRound,
  verdictMemberSettled,
  isVerdictRole,
  chainKeys,
  noteGroupFailure,
  clearGroupFailures,
  RECHECK_TASK_TITLE,
  recheckBrief,
  VERDICT_ROLES,
  type VerdictInput,
} from "./project-reconcile.ts";
// Type-only, like the module under test: a value import of db/* would open a
// pg Pool in the test process.
import type { TaskStatus } from "../db/projects.ts";
import type { RunStatus } from "../db/runs.ts";

/** A reviewer row. `tv()` below is its tester twin — both default to a settled
 *  PASS so each test only states the field it is actually about. */
function rv(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    taskId: "t1",
    role: "reviewer",
    title: "Review",
    fixCycle: 0,
    settled: true,
    lastText: "VERDICT: PASS",
    ...over,
  };
}

function tv(over: Partial<VerdictInput> = {}): VerdictInput {
  return rv({ taskId: "t2", role: "tester", title: "Test", ...over });
}

/* ========================================================================== *
 * T1 — parseVerdict
 * ========================================================================== */

describe("T1 parseVerdict", () => {
  test("reasoning quotes NEEDS_FIXES mid-text but ENDS with PASS => PASS (last occurrence wins)", () => {
    // This is the exact bug being fixed: the engine's original expression had
    // no /g flag and took the FIRST match, which read the rehearsal instead
    // of the declaration.
    const text =
      "I will answer with VERDICT: NEEDS_FIXES if the tests fail, but they " +
      "all pass.\n\nVERDICT: PASS";
    assert.equal(parseVerdict(text), "PASS");
  });

  test("reverse order — PASS quoted first, NEEDS_FIXES declared last => NEEDS_FIXES", () => {
    const text =
      "VERDICT: PASS is what I'd say if everything were fine, but it's not.\n\n" +
      "VERDICT: NEEDS_FIXES";
    assert.equal(parseVerdict(text), "NEEDS_FIXES");
  });

  test("no VERDICT line => null", () => {
    assert.equal(parseVerdict("Looks fine to me, ship it."), null);
  });

  test("null input => null", () => {
    assert.equal(parseVerdict(null), null);
  });

  test("empty string => null", () => {
    assert.equal(parseVerdict(""), null);
  });

  test("whitespace-only string => null", () => {
    assert.equal(parseVerdict("   \n\t  "), null);
  });

  test("case and spacing variance the module DOES accept", () => {
    assert.equal(parseVerdict("verdict:   pass"), "PASS");
    assert.equal(parseVerdict("**VERDICT: PASS**"), "PASS");
  });

  test("VERDICT:PASS with no space IS matched — \\s* means zero-or-more, not one-or-more", () => {
    // Documenting the real contract, not the intuitive one: \s* in the
    // module's regex admits zero whitespace characters, so the tight form
    // parses too. This is asserted explicitly rather than assumed.
    assert.equal(parseVerdict("VERDICT:PASS"), "PASS");
    assert.equal(parseVerdict("VERDICT:NEEDS_FIXES"), "NEEDS_FIXES");
  });
});

/* ========================================================================== *
 * T2 — single reviewer
 * ========================================================================== */

describe("T2 single reviewer", () => {
  test("one settled PASS => {action: 'pass'}", () => {
    const decision = consolidateVerdictRound(1, [rv({ lastText: "VERDICT: PASS" })], 3);
    assert.deepEqual(decision, { action: "pass" });
  });

  test("one settled NEEDS_FIXES at fixCycle 0 => fix cycle 1 with title, feedback, and chain keys", () => {
    const decision = consolidateVerdictRound(
      1,
      [
        rv({
          title: "Reviewer A",
          fixCycle: 0,
          lastText: "The error handling is missing.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 1);
    assert.match(decision.mergedBrief, /Reviewer A/);
    assert.match(decision.mergedBrief, /The error handling is missing\./);
    assert.equal(decision.builderChainKey, "fix:1:1");
    // One dissenter, one re-check, and it speaks the dissenter's role.
    assert.deepEqual(decision.checkers, [
      { role: "reviewer", chainKey: "rereview:1:1" },
    ]);
  });
});

/* ========================================================================== *
 * T3 — dual NEEDS_FIXES (the headline case: the duplicate-chain bug)
 * ========================================================================== */

describe("T3 dual NEEDS_FIXES", () => {
  test("two settled NEEDS_FIXES reviewers fold into exactly ONE fix decision carrying both", () => {
    const decision = consolidateVerdictRound(
      5,
      [
        rv({
          taskId: "r1",
          title: "Reviewer A",
          fixCycle: 0,
          lastText: "Missing null check on line 42.\nVERDICT: NEEDS_FIXES",
        }),
        rv({
          taskId: "r2",
          title: "Reviewer B",
          fixCycle: 0,
          lastText: "The migration is not idempotent.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    // `consolidateVerdictRound` returns a single `RoundDecision`, not an
    // array of decisions — that return type is itself what makes duplicate
    // fix/re-review chains impossible: there is no second slot to put one in.
    assert.equal(typeof decision, "object");
    assert.equal(Array.isArray(decision), false);

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;

    assert.match(decision.mergedBrief, /Reviewer A/);
    assert.match(decision.mergedBrief, /Reviewer B/);
    assert.match(decision.mergedBrief, /Missing null check on line 42\./);
    assert.match(decision.mergedBrief, /The migration is not idempotent\./);

    assert.equal(decision.builderChainKey, "fix:5:1");
    // TWO dissenters of the SAME role collapse to ONE re-review — the dedupe is
    // per role, not per task, which is the property that keeps two unhappy
    // reviewers from forking the chain again.
    assert.deepEqual(decision.checkers, [
      { role: "reviewer", chainKey: "rereview:5:1" },
    ]);
  });
});

/* ========================================================================== *
 * T4 — mixed and all-PASS
 * ========================================================================== */

describe("T4 mixed and all-PASS", () => {
  test("settled PASS + settled NEEDS_FIXES => fix (NEEDS_FIXES wins), PASS text excluded from mergedBrief", () => {
    const decision = consolidateVerdictRound(
      2,
      [
        rv({
          taskId: "p1",
          title: "Reviewer Pass",
          lastText: "All good here, nothing to say — the diff is clean.\nVERDICT: PASS",
        }),
        rv({
          taskId: "f1",
          title: "Reviewer Fix",
          lastText: "The retry loop is unbounded.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.match(decision.mergedBrief, /Reviewer Fix/);
    assert.match(decision.mergedBrief, /The retry loop is unbounded\./);
    assert.doesNotMatch(decision.mergedBrief, /Reviewer Pass/);
    assert.doesNotMatch(decision.mergedBrief, /nothing to say — the diff is clean/);
  });

  test("two settled PASS (N=2) => pass", () => {
    const decision = consolidateVerdictRound(
      2,
      [
        rv({ taskId: "p1", title: "Reviewer 1", lastText: "VERDICT: PASS" }),
        rv({ taskId: "p2", title: "Reviewer 2", lastText: "VERDICT: PASS" }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "pass" });
  });
});

/* ========================================================================== *
 * T5 — unsettled sibling (the race killer)
 * ========================================================================== */

describe("T5 unsettled sibling", () => {
  test("settled PASS + unsettled sibling => wait", () => {
    const decision = consolidateVerdictRound(
      3,
      [
        rv({ taskId: "p1", settled: true, lastText: "VERDICT: PASS" }),
        rv({ taskId: "p2", settled: false, lastText: null }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "wait" });
  });

  test("settled NEEDS_FIXES + unsettled sibling => wait", () => {
    const decision = consolidateVerdictRound(
      3,
      [
        rv({ taskId: "f1", settled: true, lastText: "VERDICT: NEEDS_FIXES" }),
        rv({ taskId: "p2", settled: false, lastText: null }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "wait" });
  });

  test("empty array => wait", () => {
    const decision = consolidateVerdictRound(3, [], 3);
    assert.deepEqual(decision, { action: "wait" });
  });
});

/* ========================================================================== *
 * T6 — unparseable verdict
 * ========================================================================== */

describe("T6 unparseable verdict", () => {
  test("one settled reviewer with no VERDICT line (sibling PASS) => block(no_verdict) naming the offending task", () => {
    const decision = consolidateVerdictRound(
      4,
      [
        rv({ taskId: "u1", title: "Silent Reviewer", lastText: "Looks okay I guess." }),
        rv({ taskId: "p1", title: "Reviewer Pass", lastText: "VERDICT: PASS" }),
      ],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /Silent Reviewer/);
  });

  test("no_verdict takes precedence over a sibling's NEEDS_FIXES (rule order c before d)", () => {
    const decision = consolidateVerdictRound(
      4,
      [
        rv({ taskId: "u1", title: "Silent Reviewer", lastText: "No verdict declared here." }),
        rv({ taskId: "f1", title: "Reviewer Fix", lastText: "VERDICT: NEEDS_FIXES" }),
      ],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /Silent Reviewer/);
  });
});

/* ========================================================================== *
 * T7 — max cycles + arithmetic
 * ========================================================================== */

describe("T7 max cycles and cycle arithmetic", () => {
  test("max fixCycle 3 and a NEEDS_FIXES at maxFixCycles=3 => block(max_cycles)", () => {
    const decision = consolidateVerdictRound(
      6,
      [rv({ taskId: "f1", fixCycle: 3, lastText: "VERDICT: NEEDS_FIXES" })],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "max_cycles");
  });

  test("same group at max fixCycle 2 (below ceiling) => fix at cycle 3", () => {
    const decision = consolidateVerdictRound(
      6,
      [rv({ taskId: "f1", fixCycle: 2, lastText: "VERDICT: NEEDS_FIXES" })],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 3);
  });

  test("mixed fixCycles in one group (0 and 2, one NEEDS_FIXES) => cycle = max+1 = 3, not 1", () => {
    const decision = consolidateVerdictRound(
      6,
      [
        rv({ taskId: "old", title: "Stale Reviewer", fixCycle: 0, lastText: "VERDICT: PASS" }),
        rv({ taskId: "new", title: "Fresh Reviewer", fixCycle: 2, lastText: "VERDICT: NEEDS_FIXES" }),
      ],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 3);
  });

  test("all-PASS group at fixCycle 3 => pass, NOT blocked — the ceiling only bites when fixes are still needed", () => {
    const decision = consolidateVerdictRound(
      6,
      [rv({ taskId: "p1", fixCycle: 3, lastText: "VERDICT: PASS" })],
      3,
    );
    assert.deepEqual(decision, { action: "pass" });
  });
});

/* ========================================================================== *
 * T8 — projectAcceptsWork
 * ========================================================================== */

describe("T8 projectAcceptsWork", () => {
  test("active => true", () => {
    assert.equal(projectAcceptsWork("active"), true);
  });

  test("paused => false", () => {
    assert.equal(projectAcceptsWork("paused"), false);
  });

  test("blocked => false", () => {
    assert.equal(projectAcceptsWork("blocked"), false);
  });

  test("done => false", () => {
    assert.equal(projectAcceptsWork("done"), false);
  });

  test("cancelled => false", () => {
    assert.equal(projectAcceptsWork("cancelled"), false);
  });
});

/* ========================================================================== *
 * T9 — chainKeys determinism
 * ========================================================================== */

describe("T9 chainKeys determinism", () => {
  test("same (round, cycle) called twice => identical strings", () => {
    const a = chainKeys(7, 2);
    const b = chainKeys(7, 2);
    assert.deepEqual(a, b);
  });

  test("different rounds => different strings", () => {
    const a = chainKeys(7, 2);
    const b = chainKeys(8, 2);
    assert.notEqual(a.builder, b.builder);
    for (const role of VERDICT_ROLES) assert.notEqual(a[role], b[role]);
  });

  test("different cycles => different strings", () => {
    const a = chainKeys(7, 2);
    const b = chainKeys(7, 3);
    assert.notEqual(a.builder, b.builder);
    for (const role of VERDICT_ROLES) assert.notEqual(a[role], b[role]);
  });

  test("literal formats fix:7:2 / rereview:7:2 / retest:7:2 — the DB partial unique index depends on these exact strings", () => {
    const keys = chainKeys(7, 2);
    assert.equal(keys.builder, "fix:7:2");
    // FROZEN: rows written since migration 0039 carry "rereview:R:c". Changing
    // it would make a replayed consolidation miss its own chain and write a
    // second one — the duplicate-chain bug, re-entered through the back door.
    assert.equal(keys.reviewer, "rereview:7:2");
    assert.equal(keys.tester, "retest:7:2");
  });

  test("every verdict role has a key, and no two roles share one", () => {
    const keys = chainKeys(7, 2);
    const all = [keys.builder, ...VERDICT_ROLES.map((role) => keys[role])];
    assert.equal(
      new Set(all).size,
      all.length,
      "two roles sharing a chain key would make the second insert look like the first's replay",
    );
  });
});

/* ========================================================================== *
 * T12 — repeated-failure escalation
 *
 * Guards finding 3 of the round-103 review: the per-group catch in
 * reconcileSettledTasks() used to log and retry forever, so a permanently
 * failing consolidation froze a project in silence.
 * ========================================================================== */

describe("T12 group-failure escalation", () => {
  const KEY = "proj-1:100";

  test("first failure counts but does not notify", () => {
    const counters = new Map<string, number>();
    assert.deepEqual(noteGroupFailure(counters, KEY, 3), { count: 1, notify: false });
  });

  test("notifies exactly once, on the threshold crossing", () => {
    const counters = new Map<string, number>();
    const notified: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = noteGroupFailure(counters, KEY, 3);
      if (r.notify) notified.push(r.count);
    }
    // Ten consecutive failures, one message — a stuck group must surface, not
    // storm.
    assert.deepEqual(notified, [3]);
    assert.equal(counters.get(KEY), 10);
  });

  test("groups are counted independently", () => {
    const counters = new Map<string, number>();
    noteGroupFailure(counters, "proj-1:100", 3);
    noteGroupFailure(counters, "proj-1:100", 3);
    const other = noteGroupFailure(counters, "proj-2:200", 3);
    assert.deepEqual(other, { count: 1, notify: false });
    assert.equal(counters.get("proj-1:100"), 2);
  });

  test("a success clears the counter — failures must be CONSECUTIVE", () => {
    const counters = new Map<string, number>();
    noteGroupFailure(counters, KEY, 3);
    noteGroupFailure(counters, KEY, 3);
    clearGroupFailures(counters, KEY);
    // Without the clear, this third failure would trip the threshold on a
    // group that recovered in between.
    assert.deepEqual(noteGroupFailure(counters, KEY, 3), { count: 1, notify: false });
  });

  test("clearing an unknown key is a no-op and leaves the map empty", () => {
    const counters = new Map<string, number>();
    clearGroupFailures(counters, "never-failed");
    assert.equal(counters.size, 0);
  });

  test("threshold 1 notifies on the first failure", () => {
    const counters = new Map<string, number>();
    assert.deepEqual(noteGroupFailure(counters, KEY, 1), { count: 1, notify: true });
  });
});

/* ========================================================================== *
 * T15 — createFixChain must arbitrate on EVERY unique index, not just ours
 *
 * Finding 3 of the round-307 review. `main` shipped `project_tasks_identity_idx
 * UNIQUE (project_id, round, role, title)` while this branch was out, and it is
 * live. createFixChain named only the chain_key index as its conflict target,
 * so an identity collision was an unhandled `unique_violation` that aborted the
 * whole transaction — and the collision is reachable, not theoretical: every
 * fix chain the PRE-0039 engine wrote has chain_key NULL and a generated title
 * of the same shape. This project's own `(4120f785, 306, 'builder',
 * 'Fix cycle 1')` is one of them.
 *
 * These assertions are on SQL TEXT because the property is a property of the
 * SQL, and this suite has no database. That is not the whole proof — the fix
 * was also exercised against a throwaway Postgres carrying BOTH live indexes,
 * with the real createFixChain, both before and after:
 *
 *   old form → error: duplicate key value violates unique constraint
 *              "project_tasks_identity_idx"
 *   new form → {builderCreated:false, reviewerCreated:false}   (replay absorbed)
 *   new form, fresh cycle → {builderCreated:true, reviewerCreated:true}
 *
 * Full transcript: docs/plan/evidence/0039-conflict-target.md. This test is the
 * cheap guard that stops the targeted form from coming back between dry runs.
 * ========================================================================== */

describe("T15 createFixChain conflict arbitration", () => {
  const projectsSrc = readFileSync(new URL("../db/projects.ts", import.meta.url), "utf8");
  const fixChainSrc = (() => {
    const start = projectsSrc.indexOf("export async function createFixChain(");
    assert.ok(start > 0, "createFixChain not found in db/projects.ts — this test has gone stale");
    const end = projectsSrc.indexOf("\n/**", start);
    return projectsSrc.slice(start, end === -1 ? undefined : end);
  })();

  const insertRowSrc = (() => {
    const start = projectsSrc.indexOf("async function insertChainRow(");
    assert.ok(start > 0, "insertChainRow not found in db/projects.ts — this test has gone stale");
    return projectsSrc.slice(start, projectsSrc.indexOf("\n/**", start));
  })();

  test("the chain INSERT uses a bare ON CONFLICT DO NOTHING", () => {
    assert.equal(
      (insertRowSrc.match(/INSERT INTO project_tasks/g) ?? []).length,
      1,
      "one parameterised insert, called for the builder and for each re-checker",
    );
    assert.equal((insertRowSrc.match(/ON CONFLICT DO NOTHING/g) ?? []).length, 1);
    // Two call sites since R850, not two calls: the builder, then a loop over
    // `checkers` (one entry per dissenting role). Asserting on call sites keeps
    // the guard meaningful — a third hand-written insert would be a third
    // chain row nothing consolidates.
    assert.equal(
      (fixChainSrc.match(/await insertChainRow\(/g) ?? []).length,
      2,
      "createFixChain must write exactly the builder and the checker loop",
    );
    assert.match(
      fixChainSrc,
      /for \(const c of input\.checkers\)/,
      "the re-checkers must all be written, not just the first",
    );
    assert.match(
      fixChainSrc,
      /input\.checkers\.length === 0/,
      "a fix builder with no re-checker would close the round unverified — it must throw",
    );
  });

  test("no conflict target is named — a target ignores the other unique index", () => {
    for (const [label, src] of [["insertChainRow", insertRowSrc], ["createFixChain", fixChainSrc]] as const) {
      assert.ok(
        !/ON CONFLICT\s*\(/.test(src),
        `${label}: a parenthesised conflict target only arbitrates ONE index; the row is subject ` +
          "to project_tasks_chain_key_uniq AND project_tasks_identity_idx, and an unhandled " +
          "violation on the other one aborts the transaction and freezes the round",
      );
      assert.ok(
        !/ON CONFLICT ON CONSTRAINT/.test(src),
        `${label}: the constraint form is doubly wrong — a partial unique index is not a constraint`,
      );
    }
  });

  test("a swallowed conflict is CLASSIFIED, never reduced to a boolean", () => {
    // `replay` (our own chain, re-created after a crash) and `occupied` (a
    // stranger holds our identity tuple, so the merged feedback would reach
    // nobody) are the same rowCount and completely different situations.
    // Collapsing them — which a `rowCount > 0` flag does — drops a reviewer
    // round's verdict in silence. Reachable in the deploy window: the live
    // pre-0039 engine writes ("Fix cycle 1", round R+1, chain_key NULL) for
    // the first reviewer of a round, and the second lands on the new engine.
    assert.match(insertRowSrc, /kind: "created"/);
    assert.match(insertRowSrc, /kind: "replay"/);
    assert.match(insertRowSrc, /kind: "occupied"/);
    assert.ok(
      !/rowCount/.test(insertRowSrc),
      "rowCount cannot distinguish which unique index fired — look the row up instead",
    );
    assert.match(
      insertRowSrc,
      /WHERE project_id = \$1 AND chain_key = \$2/,
      "chain_key must be checked FIRST: a row with our chain_key is our own chain",
    );
    assert.match(
      insertRowSrc,
      /WHERE project_id = \$1 AND round = \$2 AND role = \$3 AND title = \$4/,
      "then the identity tuple, which tells a stranger apart from a replay",
    );
    assert.match(
      insertRowSrc,
      /throw new Error\(/,
      "a conflict neither lookup explains means the indexes are not what this code believes",
    );
  });

  test("the caller refuses to mark a round done on an unexplained collision", () => {
    const tickSrc = readFileSync(new URL("./project-tick.ts", import.meta.url), "utf8");
    const start = tickSrc.indexOf('case "fix": {');
    assert.ok(start > 0, "the fix branch moved — this test has gone stale");
    const fixBranch = tickSrc.slice(start, tickSrc.indexOf("\n    }", start));
    assert.match(fixBranch, /kind === "occupied"/, "the occupied case must be handled explicitly");
    assert.match(
      fixBranch,
      /setProjectStatus\(projectId, "blocked"\)/,
      "an undeliverable verdict must stop the project, not be logged as an absorbed replay",
    );
    assert.ok(
      fixBranch.indexOf("occupied") < fixBranch.indexOf("🔁"),
      "the collision check must run BEFORE the fix-cycle push, or a lost verdict is announced as progress",
    );
  });

  test("createTask does NOT write chain_key — one writer for chain rows", () => {
    const start = projectsSrc.indexOf("export async function createTask(");
    const end = projectsSrc.indexOf("\n/**", start);
    const createTaskSrc = projectsSrc.slice(start, end === -1 ? undefined : end);
    assert.ok(
      !createTaskSrc.includes("chain_key"),
      "a second entry point writing chain_key while arbitrating on identity alone would " +
        "raise unique_violation on exactly the replay it was meant to absorb",
    );
    assert.match(
      createTaskSrc,
      /ON CONFLICT \(project_id, round, role, title\) DO NOTHING/,
      "createTask keeps main's identity arbitration — it is the fan-out path, not a chain path",
    );
  });
});

/* ========================================================================== *
 * T17 — the tester gates a round exactly like the reviewer (R850)
 *
 * agents/tester.md closes with the identical `VERDICT: PASS / NEEDS_FIXES`
 * contract, but reconciliation parsed verdicts only for role='reviewer', so a
 * settled tester fell through the per-task path in reconcileSettledTasks() and
 * was marked 'done' with its verdict never read. A customer-facing
 * NEEDS_FIXES therefore became a silent approval — the same failure `no_verdict`
 * exists to prevent for reviewers, only quieter, because nothing was logged and
 * nothing was pushed.
 *
 * The tests below pin the three cases the wiring has to get right: a tester
 * alone passes a round, a tester alone opens a fix cycle that is RE-TESTED (not
 * re-reviewed — a code reviewer cannot confirm a broken checkout flow is
 * fixed), and a tester next to a reviewer is ONE group with ONE builder.
 * ========================================================================== */

describe("T17 tester verdicts", () => {
  test("isVerdictRole gates exactly the two roles that end in a VERDICT line", () => {
    assert.equal(isVerdictRole("reviewer"), true);
    assert.equal(isVerdictRole("tester"), true);
    for (const role of ["architect", "planner", "scout", "researcher", "builder", "steward"] as const) {
      assert.equal(isVerdictRole(role), false, `${role} must keep the per-task path`);
    }
    assert.deepEqual([...VERDICT_ROLES], ["reviewer", "tester"]);
  });

  test("tester PASS alone => pass (a tester can close a round on its own)", () => {
    const decision = consolidateVerdictRound(
      100,
      [tv({ title: "Customer journey sweep", lastText: "Everything worked.\nVERDICT: PASS" })],
      3,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  test("tester NEEDS_FIXES alone => ONE fix builder re-checked by a TESTER, not a reviewer", () => {
    const decision = consolidateVerdictRound(
      100,
      [
        tv({
          title: "Customer journey sweep",
          fixCycle: 0,
          lastText:
            "1. Checkout: the Pay button does nothing on mobile (blocker).\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.equal(decision.cycle, 1);
    assert.equal(decision.builderChainKey, "fix:100:1");
    // The re-check role is the whole point: only the tester can walk the
    // journey again and see the button work.
    assert.deepEqual(decision.checkers, [{ role: "tester", chainKey: "retest:100:1" }]);
    assert.match(decision.mergedBrief, /## Feedback from tester: Customer journey sweep/);
    assert.match(decision.mergedBrief, /the Pay button does nothing on mobile/);
  });

  test("tester with no parseable VERDICT => block(no_verdict), never a silent done", () => {
    const decision = consolidateVerdictRound(
      100,
      [tv({ title: "Customer journey sweep", lastText: "Tried a few things, felt okay." })],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /tester "Customer journey sweep"/);
  });

  test("tester is capped by the same fix-cycle ceiling as a reviewer", () => {
    const decision = consolidateVerdictRound(
      100,
      [tv({ fixCycle: 3, lastText: "VERDICT: NEEDS_FIXES" })],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "max_cycles");
    assert.match(decision.detail, /tester "Test"/);
  });

  test("tester + reviewer, BOTH NEEDS_FIXES => one builder, one merged brief, one re-check EACH", () => {
    const decision = consolidateVerdictRound(
      200,
      [
        rv({
          taskId: "r1",
          title: "Diff review",
          lastText: "The catch swallows the error.\nVERDICT: NEEDS_FIXES",
        }),
        tv({
          taskId: "t1",
          title: "Customer sweep",
          lastText: "The empty state shows a raw stack trace.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;

    // ONE builder — the regression guard from T3, now across roles. Two fix
    // builders in one round would land in the same worktree with half a brief
    // each, which is bug 1 wearing a different hat.
    assert.equal(decision.builderChainKey, "fix:200:1");
    // One re-check per dissenting role, in VERDICT_ROLES order so a replayed
    // decision is byte-identical to the one already in the DB.
    assert.deepEqual(decision.checkers, [
      { role: "reviewer", chainKey: "rereview:200:1" },
      { role: "tester", chainKey: "retest:200:1" },
    ]);
    // Nothing merged away: the builder gets both voices, each labelled with the
    // role that raised it, because they are answered in different places.
    assert.match(decision.mergedBrief, /## Feedback from reviewer: Diff review/);
    assert.match(decision.mergedBrief, /## Feedback from tester: Customer sweep/);
    assert.match(decision.mergedBrief, /The catch swallows the error\./);
    assert.match(decision.mergedBrief, /The empty state shows a raw stack trace\./);
  });

  test("reviewer PASS + tester NEEDS_FIXES => fix; a reviewer's PASS cannot outvote the customer", () => {
    const decision = consolidateVerdictRound(
      200,
      [
        rv({ taskId: "r1", title: "Diff review", lastText: "Clean diff.\nVERDICT: PASS" }),
        tv({
          taskId: "t1",
          title: "Customer sweep",
          lastText: "The upload silently drops files over 2 MB.\nVERDICT: NEEDS_FIXES",
        }),
      ],
      3,
    );

    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    // Only the DISSENTER re-checks. Re-running the reviewer that already passed
    // would spend a run to re-confirm what it just said.
    assert.deepEqual(decision.checkers, [{ role: "tester", chainKey: "retest:200:1" }]);
    assert.doesNotMatch(decision.mergedBrief, /Diff review/);
  });

  test("reviewer NEEDS_FIXES + tester PASS => fix re-checked by the reviewer only", () => {
    const decision = consolidateVerdictRound(
      200,
      [
        rv({
          taskId: "r1",
          title: "Diff review",
          lastText: "Unbounded retry loop.\nVERDICT: NEEDS_FIXES",
        }),
        tv({ taskId: "t1", title: "Customer sweep", lastText: "VERDICT: PASS" }),
      ],
      3,
    );
    assert.equal(decision.action, "fix");
    if (decision.action !== "fix") return;
    assert.deepEqual(decision.checkers, [{ role: "reviewer", chainKey: "rereview:200:1" }]);
  });

  test("an unsettled tester freezes the round even when the reviewer already PASSED", () => {
    // The cross-role half of rule (b). Without it, the reviewer's PASS would
    // close a round whose tester is still walking the product — the exact race
    // the round-level decision exists to remove.
    const decision = consolidateVerdictRound(
      200,
      [
        rv({ taskId: "r1", lastText: "VERDICT: PASS" }),
        tv({ taskId: "t1", settled: false, lastText: null }),
      ],
      3,
    );
    assert.deepEqual(decision, { action: "wait" });
  });

  test("a tester's no_verdict outranks a reviewer's NEEDS_FIXES (rule order c before d)", () => {
    const decision = consolidateVerdictRound(
      200,
      [
        rv({ taskId: "r1", title: "Diff review", lastText: "VERDICT: NEEDS_FIXES" }),
        tv({ taskId: "t1", title: "Customer sweep", lastText: "No verdict here." }),
      ],
      3,
    );
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /tester "Customer sweep"/);
  });

  test("the same group decided twice is byte-identical — replays must not fork the chain", () => {
    const group = () => [
      rv({ taskId: "r1", title: "Diff review", lastText: "Nope.\nVERDICT: NEEDS_FIXES" }),
      tv({ taskId: "t1", title: "Customer sweep", lastText: "Also nope.\nVERDICT: NEEDS_FIXES" }),
    ];
    assert.deepEqual(
      consolidateVerdictRound(200, group(), 3),
      consolidateVerdictRound(200, group(), 3),
    );
  });

  test("re-check titles and briefs are role-specific — a re-test is not a second review", () => {
    assert.equal(RECHECK_TASK_TITLE("reviewer", 2), "Re-review after fix cycle 2");
    assert.equal(RECHECK_TASK_TITLE("tester", 2), "Re-test after fix cycle 2");
    assert.notEqual(RECHECK_TASK_TITLE("reviewer", 2), RECHECK_TASK_TITLE("tester", 2));

    const merged = "## Feedback from tester: Customer sweep\nThe Pay button does nothing.";
    const testerBrief = recheckBrief("tester", merged);
    const reviewerBrief = recheckBrief("reviewer", merged);

    // Both carry the original feedback verbatim — a re-checker that only sees
    // the current state starts from scratch and finds a different set of
    // problems, which is how a fix cycle becomes an endless one.
    for (const brief of [testerBrief, reviewerBrief]) {
      assert.ok(brief.includes(merged), "the merged feedback must survive verbatim");
      assert.match(brief, /VERDICT: PASS/);
      assert.match(brief, /VERDICT: NEEDS_FIXES/);
    }
    assert.match(testerBrief, /Re-test the product/);
    assert.match(testerBrief, /as a customer would/);
    assert.match(reviewerBrief, /Re-review the work/);
    assert.match(reviewerBrief, /against the new diff/);
  });
});

/* ========================================================================== *
 * T20 — verdictMemberSettled (added at R1005, findings 1 and 2)
 *
 * The settlement rule, extracted from project-tick's inline mapping so it can
 * be driven exhaustively instead of asserted as a source string. Three layers
 * consume it — the decision here, the pre-check `unsettledVerdictTasks` and the
 * commit `markVerdictTaskDone` — and the two SQL halves are its mirror
 * (pinned structurally in cp2-reconciler-interaction.test.ts).
 *
 * The table below is the WHOLE cross product: 6 task statuses × 8 run statuses
 * (7 + null) × pendingInput. 96 cases, no sampling — the two defects it closes
 * were both single cells nobody had enumerated.
 * ========================================================================== */

describe("T20 verdictMemberSettled", () => {
  const TASK_STATUSES: TaskStatus[] = [
    "pending",
    "ready",
    "running",
    "done",
    "failed",
    "blocked",
  ];
  const RUN_STATUSES: Array<RunStatus | null> = [
    null,
    "queued",
    "running",
    "paused",
    "stuck",
    "completed",
    "failed",
    "cancelled",
  ];

  test("the full cross product matches the documented rule, cell for cell", () => {
    let done = 0;
    let clean = 0;
    let unsettled = 0;
    for (const taskStatus of TASK_STATUSES) {
      for (const runStatus of RUN_STATUSES) {
        for (const pendingInput of [false, true]) {
          const actual = verdictMemberSettled({ taskStatus, runStatus, pendingInput });
          const expected =
            taskStatus === "done" || (runStatus === "completed" && !pendingInput);
          assert.equal(
            actual,
            expected,
            `task=${taskStatus} run=${runStatus} pending=${pendingInput}`,
          );
          if (taskStatus === "done") done++;
          else if (expected) clean++;
          else unsettled++;
        }
      }
    }
    // Guards the guard: if the loops ever stop covering the cross product, the
    // assertion above passes vacuously. 6 × 8 × 2 = 96.
    assert.equal(done + clean + unsettled, 96);
    assert.equal(done, 16); // one task status × 8 run statuses × 2 flags
    assert.equal(clean, 5); // the other 5 task statuses, completed, no flag
  });

  test("a 'done' member is settled whatever its run has done since (finding 2)", () => {
    // R1005 finding 2, the wedge: a partially-refused markGroupDone leaves
    // member A 'done' and member B 'running'; A's run is then resumed and its
    // follow-up turn fails/pauses/is cancelled. Judged by run status alone, A
    // reported unsettled forever, its round returned `wait` on every tick, and
    // — because a 'done' task is invisible to listSettledRunningTasks — no
    // per-task failure path could ever fire. Silent, indefinite, project still
    // 'active'.
    for (const runStatus of RUN_STATUSES) {
      for (const pendingInput of [false, true]) {
        assert.equal(
          verdictMemberSettled({ taskStatus: "done", runStatus, pendingInput }),
          true,
          `a 'done' member must stay settled with run=${runStatus} pending=${pendingInput}`,
        );
      }
    }
  });

  test("a `completed` run that still owes a turn is NOT settled (finding 1)", () => {
    // R1005 finding 1: completeRun is E1 (complete + RETURN the flag) then E2
    // (requeue). A /message to a RUNNING reviewer sets the flag; if the
    // executor dies between the statements the row sits `completed` +
    // pending_input for ≥60s and unboundedly while it is down. Deciding there
    // closes the round on a verdict the operator has already moved to withdraw.
    assert.equal(
      verdictMemberSettled({
        taskStatus: "running",
        runStatus: "completed",
        pendingInput: true,
      }),
      false,
    );
    assert.equal(
      verdictMemberSettled({
        taskStatus: "running",
        runStatus: "completed",
        pendingInput: false,
      }),
      true,
    );
  });

  test("a round wedged by a resumed 'done' member now decides instead of waiting", () => {
    // The end-to-end shape of finding 2, through the decision function: A is
    // 'done' (its run resumed and failed), B is 'running' with a settled PASS.
    // Before the fix this was `wait` on every tick, forever.
    const a = rv({
      taskId: "a",
      title: "Diff review",
      settled: verdictMemberSettled({
        taskStatus: "done",
        runStatus: "failed",
        pendingInput: false,
      }),
      lastText: "VERDICT: PASS",
    });
    const b = tv({
      taskId: "b",
      title: "Customer sweep",
      settled: verdictMemberSettled({
        taskStatus: "running",
        runStatus: "completed",
        pendingInput: false,
      }),
      lastText: "VERDICT: PASS",
    });
    assert.deepEqual(consolidateVerdictRound(7, [a, b], 3), { action: "pass" });
  });

  test("the accepted trade-off: a resumed 'done' member with no verdict line blocks, loudly", () => {
    // Settled-by-bookkeeping means the member's CURRENT last message re-enters
    // parseVerdict on a re-consolidation, and a follow-up answer rarely
    // restates `VERDICT:`. The outcome is block(no_verdict) — pushed, and
    // recoverable with /unwedge — which C20 prefers over the silent wedge it
    // replaces. CP3's MANAGER COMMS block closes it at the prompt level
    // (docs/plan/09, F3).
    const a = rv({
      taskId: "a",
      title: "Diff review",
      settled: verdictMemberSettled({
        taskStatus: "done",
        runStatus: "completed",
        pendingInput: false,
      }),
      lastText: "Yes — I checked the migration, it is idempotent.",
    });
    const decision = consolidateVerdictRound(7, [a], 3);
    assert.equal(decision.action, "block");
    if (decision.action !== "block") return;
    assert.equal(decision.reason, "no_verdict");
    assert.match(decision.detail, /reviewer "Diff review"/);
  });
});

/* ========================================================================== *
 * PHASE 4B ADDENDUM (round 221) — APPENDED, never edited.
 *
 * Everything above this line is byte-identical to the commit phase 4B started
 * from, which is R43's acceptance gate:
 *
 *   git diff main -- forge-control/src/lib/project-reconcile.test.ts
 *
 * must show appended cases only. The blocks below cover the group's new
 * DEFINITION (R40, R41, R42, R45, R46). The group's DECISION is R44's, is
 * untouched, and is still proved by T1–T20 above — which is exactly why those
 * cases must keep passing unmodified: they are the evidence that restating the
 * group's definition did not move its decision.
 *
 * WHAT WOULD MAKE THIS ADDENDUM REPORT A PASS WRONGLY (standing rule 3):
 *
 *  1. "The new cases assert on a helper nothing in the engine actually calls."
 *     Every function exercised below has a production caller, and T27 pins each
 *     one BY SOURCE so the pin fails if a call site is deleted: `groupKey` and
 *     `groupLabel` and `groupCompleteNotification` and `fixChainGraphFields` in
 *     project-tick.ts, `earliestFailedGroup` and `duplicatesFixChain` in
 *     db/projects.ts. A green suite over a dead helper is the failure mode this
 *     project keeps finding, so the call sites are asserted, not assumed.
 *  2. "A chainKeys case passed because both sides of the assertion were
 *     computed by the same changed function." T22's `main` cases compare
 *     against THREE STRING LITERALS typed out by hand from migration 0039's
 *     historical form — never against `chainKeys(...)` with different
 *     arguments, and never against a template that shares a variable with the
 *     implementation. If the implementation and the expectation ever agree
 *     wrongly, they have to agree with a literal that was written before the
 *     change.
 *  3. An R42 case that "proves" round+1/round+2 by restating the arithmetic.
 *     T23 asserts the agreement against `computeRound()` — the graph's own
 *     rule, imported from task-graph.ts and not reimplemented here — so the
 *     literal and the rule are two independent computations of one number.
 * ========================================================================== */

import {
  groupKey,
  groupLabel,
  groupCompleteNotification,
  earliestFailedGroup,
  fixChainGraphFields,
  duplicatesFixChain,
  FIX_TASK_TITLE,
  MAIN_WORKSTREAM,
} from "./project-reconcile.ts";
import { computeRound, type GraphTask } from "./task-graph.ts";

/** A graph row at `round`, for feeding `computeRound()`. Only `round` is read
 *  by it; the rest is filled so the object is a real GraphTask rather than a
 *  cast. */
function gt(round: number, over: Partial<GraphTask> = {}): GraphTask {
  return {
    id: `00000000-0000-4000-8000-${String(round).padStart(12, "0")}`,
    round,
    workstream: MAIN_WORKSTREAM,
    status: "done",
    depends_on: [],
    write_set: [],
    ...over,
  };
}

/* ========================================================================== *
 * T21 — groupKey (R40)
 * ========================================================================== */

describe("T21 groupKey", () => {
  test("formats the tuple as round:workstream", () => {
    assert.equal(groupKey({ round: 7, workstream: "main" }), "7:main");
    assert.equal(groupKey({ round: 412, workstream: "ui" }), "412:ui");
  });

  test("two groups differing only in workstream get different keys", () => {
    // The whole of R40 in one assertion: without this, two reviewers at the
    // same depth in two workstreams collapse into one consolidation, one
    // merged fix builder, one worktree — and one workstream's findings are
    // delivered nowhere.
    assert.notEqual(
      groupKey({ round: 7, workstream: "main" }),
      groupKey({ round: 7, workstream: "ui" }),
    );
  });

  test("a workstream named like a round cannot collide with any other pair", () => {
    // The named hazard: the separator must be a character neither term can
    // contain. `round` is an integer; `workstream` is `^[a-z0-9][a-z0-9-]{0,39}$`
    // (project_tasks_workstream_chk), so no ':' on either side and the first
    // ':' always splits the tuple back apart.
    const keys = [
      groupKey({ round: 1, workstream: "2" }), // "1:2"
      groupKey({ round: 12, workstream: "main" }), // "12:main"
      groupKey({ round: 1, workstream: "23" }), // "1:23"
      groupKey({ round: 123, workstream: "main" }), // "123:main"
      groupKey({ round: 12, workstream: "3" }), // "12:3"
    ];
    assert.equal(new Set(keys).size, keys.length, `keys collided: ${keys.join(" ")}`);
  });

  test("'main' is not privileged in the encoding", () => {
    // chainKeys DOES privilege it (T22, for a replay reason). The KEY must not,
    // or a project with a workstream literally named "main-2" would have to
    // reason about two encodings.
    assert.equal(groupKey({ round: 3, workstream: MAIN_WORKSTREAM }), "3:main");
    assert.equal(groupKey({ round: 3, workstream: "main-2" }), "3:main-2");
    assert.notEqual(
      groupKey({ round: 3, workstream: MAIN_WORKSTREAM }),
      groupKey({ round: 3, workstream: "main-2" }),
    );
  });
});

/* ========================================================================== *
 * T22 — chainKeys and the workstream namespace (R41)
 * ========================================================================== */

describe("T22 chainKeys workstream namespace", () => {
  test("'main' is BYTE-IDENTICAL to the historical three strings", () => {
    // Written as literals ON PURPOSE (standing rule 3, defect 2 of this
    // addendum's header): comparing chainKeys(7,2,"main") to chainKeys(7,2)
    // would compare the function to itself and pass however the format moved.
    // These three strings are the form every chain row written since migration
    // 0039 carries.
    const keys = chainKeys(7, 2, MAIN_WORKSTREAM);
    assert.equal(keys.builder, "fix:7:2");
    assert.equal(keys.reviewer, "rereview:7:2");
    assert.equal(keys.tester, "retest:7:2");
  });

  test("the omitted argument is the same as 'main' — the historical call site", () => {
    // T9 above calls chainKeys(7, 2) and must keep passing unmodified (R43).
    // This states WHY that is safe rather than leaving it to the type default.
    assert.deepEqual(chainKeys(7, 2), chainKeys(7, 2, MAIN_WORKSTREAM));
  });

  test("a named workstream gets the prefixed form", () => {
    const keys = chainKeys(7, 2, "ui");
    assert.equal(keys.builder, "fix:ui:7:2");
    assert.equal(keys.reviewer, "rereview:ui:7:2");
    assert.equal(keys.tester, "retest:ui:7:2");
  });

  test("two workstreams at one round produce three disjoint keys each", () => {
    const main = chainKeys(7, 1, MAIN_WORKSTREAM);
    const ui = chainKeys(7, 1, "ui");
    const all = [...Object.values(main), ...Object.values(ui)];
    assert.equal(new Set(all).size, all.length, `chain keys collided: ${all.join(" ")}`);
  });

  test("determinism and cycle/round sensitivity survive the new argument", () => {
    assert.deepEqual(chainKeys(7, 2, "ui"), chainKeys(7, 2, "ui"));
    assert.notEqual(chainKeys(7, 2, "ui").builder, chainKeys(8, 2, "ui").builder);
    assert.notEqual(chainKeys(7, 2, "ui").builder, chainKeys(7, 3, "ui").builder);
  });
});

/* ========================================================================== *
 * T23 — the fix chain's graph fields (R42)
 * ========================================================================== */

describe("T23 fixChainGraphFields", () => {
  const members = [
    { taskId: "b0000000-0000-4000-8000-000000000002", writeSet: ["src/b.ts", "src/a.ts"] },
    { taskId: "a0000000-0000-4000-8000-000000000001", writeSet: ["src/a.ts"] },
  ];

  test("the builder waits on the gating tasks and inherits the group's workstream", () => {
    const g = fixChainGraphFields({ round: 7, workstream: "ui", members });
    assert.equal(g.builder.round, 8);
    assert.equal(g.builder.workstream, "ui");
    assert.deepEqual(g.builder.depends_on, [
      "a0000000-0000-4000-8000-000000000001",
      "b0000000-0000-4000-8000-000000000002",
    ]);
    assert.deepEqual(g.builder.write_set, ["src/a.ts", "src/b.ts"]);
  });

  test("depends_on is NEVER empty — an empty group is refused, not defaulted", () => {
    // An empty depends_on is a graph ROOT: the fix builder would promote on the
    // next tick and run in parallel with the work it exists to follow. It would
    // also make R41's guard match every other root-born chain at the same cycle.
    assert.throws(
      () => fixChainGraphFields({ round: 7, workstream: "main", members: [] }),
      /no gating tasks/,
    );
  });

  test("the checker sits one round further out with an empty write-set", () => {
    const g = fixChainGraphFields({ round: 7, workstream: "ui", members });
    assert.equal(g.checker.round, 9);
    assert.equal(g.checker.workstream, "ui");
    assert.deepEqual(g.checker.write_set, []);
  });

  test("round+1 and round+2 AGREE with computeRound's 1 + max(dep.round)", () => {
    // 02-architecture.md §5.2 keeps the literals because the group's round is a
    // real stored value; that the arithmetic and the graph rule yield the same
    // two numbers is a PROPERTY, asserted here against task-graph.ts's own
    // function rather than against a restatement of `+1` in this file.
    const round = 7;
    const g = fixChainGraphFields({ round, workstream: "ui", members });
    const gatingRows = members.map(() => gt(round, { workstream: "ui" }));
    assert.equal(g.builder.round, computeRound(gatingRows));
    const builderRow = gt(g.builder.round, { workstream: "ui" });
    assert.equal(g.checker.round, computeRound([builderRow]));
  });

  test("the agreement is not an artefact of round 7", () => {
    // Every round tried here is at least two below its phase block's ceiling,
    // which is the domain the next case explains.
    for (const round of [0, 1, 50, 200, 412]) {
      const g = fixChainGraphFields({ round, workstream: "main", members });
      assert.equal(g.builder.round, computeRound([gt(round)]));
      assert.equal(g.checker.round, computeRound([gt(g.builder.round)]));
    }
  });

  test("THE BOUNDARY the agreement does NOT hold at, found by asserting it (R24)", () => {
    // R42 says round+1/round+2 agree with `1 + max(dep.round)`. They do —
    // everywhere except the last two rounds of a phase block, where
    // computeRound() REFUSES rather than answers: R24 caps a phase at 99 depth
    // levels, so a group at round 99 would put its fix builder at 100, in phase
    // block 1. This case exists because writing the agreement test is what
    // turned the assumption up as false; recorded in 01-requirements.md R42.
    //
    // The chain is still created, deliberately. Promotion is by `depends_on`,
    // never by round (that is this project's whole point), so the schedule is
    // unaffected and only the phase LABEL moves. Refusing here would block a
    // real fix cycle to protect a numbering convention, and the group would
    // wedge with its feedback undelivered — trading a cosmetic defect for the
    // exact failure the reconcile module exists to prevent.
    const g = fixChainGraphFields({ round: 99, workstream: "main", members });
    assert.equal(g.builder.round, 100);
    assert.equal(g.checker.round, 101);
    assert.throws(() => computeRound([gt(99)]), /leaves phase block 0/);
  });

  test("REACHABILITY of that boundary, stated rather than hand-waved", () => {
    // It takes 99 dependency levels inside ONE phase for a group to sit at 99.
    // The architect seeds one planner per phase at k*100 (R51) and every other
    // round is computed as 1 + max(dep.round), so the depth of a phase is the
    // longest chain its planner creates — a dozen at most in every project this
    // engine has run. The boundary is therefore documented, not defended.
    assert.equal(fixChainGraphFields({ round: 98, workstream: "main", members }).checker.round, 100);
    assert.equal(computeRound([gt(97)]), 98);
  });

  test("duplicate gating ids and duplicate paths are folded, not repeated", () => {
    const g = fixChainGraphFields({
      round: 1,
      workstream: "main",
      members: [
        { taskId: "a0000000-0000-4000-8000-000000000001", writeSet: ["src/a.ts"] },
        { taskId: "a0000000-0000-4000-8000-000000000001", writeSet: ["src/a.ts"] },
      ],
    });
    assert.deepEqual(g.builder.depends_on, ["a0000000-0000-4000-8000-000000000001"]);
    assert.deepEqual(g.builder.write_set, ["src/a.ts"]);
  });

  test("the same group yields byte-identical fields however its members are ordered", () => {
    // Replay safety: a re-consolidation after a crash must produce the same row,
    // and listVerdictRound's ORDER BY is not the only thing that can reorder a
    // group (a member added by hand carries a later created_at).
    const a = fixChainGraphFields({ round: 3, workstream: "main", members });
    const b = fixChainGraphFields({ round: 3, workstream: "main", members: [...members].reverse() });
    assert.deepEqual(a, b);
  });
});

/* ========================================================================== *
 * T24 — the hand-renumber hazard (R41)
 * ========================================================================== */

describe("T24 duplicatesFixChain — a renumbered group cannot produce a second chain", () => {
  const deps = ["a0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002"];

  test("a group renumbered after its chain exists is REFUSED", () => {
    // The hazard, exactly: the operator moved the group from round 7 to round
    // 9, so consolidation computes fix:9:1 where fix:7:1 already exists. Both
    // unique indexes let that through — the chain_key differs AND the round
    // differs — so `ON CONFLICT DO NOTHING` would insert a SECOND chain and
    // `occupied` would never fire, because it is only reached on a conflict.
    // The immutable half is the gating ids (R29), which R42 puts on the row.
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:9:1", dependsOn: deps },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: deps },
      ),
      true,
    );
  });

  test("the order of the two dependency lists is irrelevant", () => {
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:9:1", dependsOn: deps },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: [...deps].reverse() },
      ),
      true,
    );
  });

  test("OUR OWN chain replayed is NOT a duplicate", () => {
    // The crash-replay path: a tick that dies between COMMIT and mark-done
    // recomputes the same decision, the same (round, cycle) and therefore the
    // same chain_key. That row is ours and insertChainRow must absorb it as
    // `replay`. Refusing it here would turn the guard into the wedge.
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:7:1", dependsOn: deps },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: deps },
      ),
      false,
    );
  });

  test("a later fix cycle over the same group is NOT a duplicate", () => {
    // Cycle 2 of the same group is the legitimate next chain: the same gating
    // tasks are re-checked, and MAX_FIX_CYCLES is what bounds it, not this.
    assert.equal(
      duplicatesFixChain(
        { cycle: 2, chainKey: "fix:7:2", dependsOn: deps },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: deps },
      ),
      false,
    );
  });

  test("a different group at the same cycle is NOT a duplicate", () => {
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:ui:7:1", dependsOn: ["c0000000-0000-4000-8000-000000000003"] },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: deps },
      ),
      false,
    );
  });

  test("THE BOUNDARY, asserted rather than left to be discovered: a PARTIAL renumber is not caught", () => {
    // An operator who moves SOME members of a group changes the gating set, so
    // the two chains have different identities and this returns false. That is
    // correct rather than a hole — two disjoint member sets are two different
    // dependency joins, and nothing distinguishes that from a genuine second
    // group. R41 records it as the guard's stated limit.
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:9:1", dependsOn: [deps[0]!] },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: deps },
      ),
      false,
    );
  });

  test("a subset is not a set-equal — cardinality is part of the comparison", () => {
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:9:1", dependsOn: deps },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: [deps[0]!] },
      ),
      false,
    );
  });
});

/* ========================================================================== *
 * T25 — the unwedge group selection (R46)
 * ========================================================================== */

describe("T25 earliestFailedGroup", () => {
  test("nothing failed → null", () => {
    assert.equal(earliestFailedGroup([]), null);
  });

  test("the earliest ROUND wins", () => {
    assert.deepEqual(
      earliestFailedGroup([
        { round: 9, workstream: "main" },
        { round: 7, workstream: "ui" },
        { round: 8, workstream: "main" },
      ]),
      { round: 7, workstream: "ui" },
    );
  });

  test("at one round, the earliest WORKSTREAM NAME wins — one group, never two", () => {
    // The point of R46: an operator's single /unwedge must not restart two
    // teams in two worktrees, with only one of them named in the response.
    assert.deepEqual(
      earliestFailedGroup([
        { round: 7, workstream: "ui" },
        { round: 7, workstream: "api" },
        { round: 7, workstream: "main" },
      ]),
      { round: 7, workstream: "api" },
    );
  });

  test("the answer does not depend on input order", () => {
    const groups = [
      { round: 7, workstream: "ui" },
      { round: 7, workstream: "api" },
      { round: 6, workstream: "zeta" },
    ];
    assert.deepEqual(earliestFailedGroup(groups), { round: 6, workstream: "zeta" });
    assert.deepEqual(earliestFailedGroup([...groups].reverse()), { round: 6, workstream: "zeta" });
  });

  test("a single group is returned as itself, and by value", () => {
    const only = { round: 3, workstream: "main" };
    const got = earliestFailedGroup([only]);
    assert.deepEqual(got, only);
    assert.notEqual(got, only, "the selection must not hand back the caller's row by reference");
  });
});

/* ========================================================================== *
 * T26 — group completion, named for a human (R45)
 * ========================================================================== */

describe("T26 groupLabel and groupCompleteNotification", () => {
  test("'main' reads exactly as a round always did", () => {
    assert.equal(groupLabel(7, MAIN_WORKSTREAM), "round 7");
  });

  test("the 'main' notification is BYTE-IDENTICAL to the historical string", () => {
    // Literal, for the same reason T22's are: a template sharing a variable
    // with the implementation would agree with itself however it moved.
    assert.equal(
      groupCompleteNotification("operator-visibility", 12, MAIN_WORKSTREAM),
      "🏁 operator-visibility · round 12 complete.",
    );
  });

  test("a named workstream says so, in both", () => {
    assert.equal(groupLabel(7, "ui"), "round 7 · workstream ui");
    assert.equal(
      groupCompleteNotification("engine-task-graph", 7, "ui"),
      "🏁 engine-task-graph · round 7 · workstream ui complete.",
    );
  });

  test("workstream A draining cannot be mistaken for workstream B's completion", () => {
    // The message is the only thing Konrad sees at 3am. Two groups at one depth
    // must not push the same sentence twice.
    assert.notEqual(
      groupCompleteNotification("p", 7, "ui"),
      groupCompleteNotification("p", 7, "api"),
    );
    assert.notEqual(
      groupCompleteNotification("p", 7, MAIN_WORKSTREAM),
      groupCompleteNotification("p", 7, "ui"),
    );
  });
});

/* ========================================================================== *
 * T27 — every helper above has a production caller
 *
 * Standing rule 3, defect 1 of this addendum's header: a green case over a
 * function nothing calls proves the function, not the engine. These assertions
 * are SOURCE assertions (readFileSync, like cp2-reconciler-interaction.test.ts)
 * because the call sites are in modules that open a pg Pool at import.
 * ========================================================================== */

describe("T27 the phase-4B helpers are on the engine's path", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const TICK = readFileSync(`${repoRoot}forge-control/src/lib/project-tick.ts`, "utf8");
  const PROJECTS_DB = readFileSync(`${repoRoot}forge-control/src/db/projects.ts`, "utf8");

  test("project-tick keys its group map and its failure counter with groupKey", () => {
    assert.match(TICK, /verdictRounds\.set\(`\$\{task\.project_id\}:\$\{groupKey\(task\)\}`/);
    // Same `key`, so a failure is counted against the group it is about.
    assert.match(TICK, /noteGroupFailure\(groupFailures, key, MAX_GROUP_FAILURES\)/);
  });

  test("project-tick consolidates per workstream and passes it down", () => {
    assert.match(TICK, /await consolidateVerdictGroup\(projectId, round, workstream\)/);
    assert.match(TICK, /listVerdictRound\(projectId, round, workstream, VERDICT_ROLES\)/);
    assert.match(TICK, /consolidateVerdictRound\(round, inputs, MAX_FIX_CYCLES, workstream\)/);
  });

  test("project-tick builds the chain's graph fields with fixChainGraphFields", () => {
    assert.match(TICK, /const graph = fixChainGraphFields\(\{/);
    assert.match(TICK, /members: rows\.map\(\(r\) => \(\{ taskId: r\.id, writeSet: r\.write_set \}\)\)/);
    assert.match(TICK, /^\s+graph,$/m);
  });

  test("project-tick reports completion per group, through groupCompleteNotification", () => {
    assert.match(TICK, /roundIsComplete\(projectId, round, workstream\)/);
    assert.match(TICK, /roundIsComplete\(task\.project_id, task\.round, task\.workstream\)/);
    const pushes = TICK.match(/groupCompleteNotification\(/g) ?? [];
    assert.equal(pushes.length, 2, "both 🏁 pushes must go through the one formatter");
    assert.doesNotMatch(
      TICK,
      /🏁 \$\{name\} · round/,
      "a hand-written 🏁 string is how the two paths drift apart",
    );
  });

  test("db/projects.ts selects the unwedge group with earliestFailedGroup", () => {
    assert.match(PROJECTS_DB, /const group = earliestFailedGroup\(blocking\.rows\)/);
    assert.match(PROJECTS_DB, /AND status IN \('failed','blocked'\)/);
    assert.match(PROJECTS_DB, /WHERE project_id = \$1 AND round = \$2 AND workstream = \$3/);
  });

  test("createFixChain refuses a second chain through duplicatesFixChain, BEFORE inserting", () => {
    const body = PROJECTS_DB.slice(PROJECTS_DB.indexOf("export async function createFixChain"));
    const guard = body.indexOf("duplicatesFixChain(candidate,");
    const insert = body.indexOf("const builder = await insertChainRow(");
    assert.ok(guard > 0, "createFixChain does not call duplicatesFixChain");
    assert.ok(insert > 0, "createFixChain no longer inserts a builder");
    assert.ok(guard < insert, "the R41 guard must run before the first INSERT, or it writes half a chain");
  });

  test("insertChainRow names all three graph columns — a chain row is never born legacy", () => {
    const body = PROJECTS_DB.slice(
      PROJECTS_DB.indexOf("async function insertChainRow"),
      PROJECTS_DB.indexOf("/** Insert a fix builder"),
    );
    assert.match(body, /INSERT INTO project_tasks \(project_id, round, role, title, brief, fix_cycle, tier, chain_key,\s*\n\s*depends_on, workstream, write_set\)/);
    assert.match(body, /\$9::uuid\[\], \$10, \$11::text\[\]/);
  });

  test("the checkers depend on the builder row this transaction wrote", () => {
    const body = PROJECTS_DB.slice(PROJECTS_DB.indexOf("export async function createFixChain"));
    assert.match(body, /depends_on: \[builder\.id\]/);
    assert.match(body, /round: input\.graph\.checker\.round/);
  });
});

/* ========================================================================== *
 * T28 — the identity index has no workstream term (round 221's finding)
 *
 * R40 and R41 as written namespace the CHAIN KEY. `project_tasks_identity_idx`
 * (migration 0035) is `(project_id, round, role, title)` and migration 0040 did
 * not add a workstream term, so two groups at one round produce two chain rows
 * with distinct chain_keys and IDENTICAL identity tuples: the second INSERT
 * conflicts, `insertChainRow` classifies it `occupied`, and the project is
 * blocked with that workstream's merged feedback undelivered — R40's own
 * motivating failure, arriving through the other index. The titles carry the
 * workstream for exactly that reason.
 * ========================================================================== */

describe("T28 chain-row titles are distinct per workstream", () => {
  test("'main' titles are BYTE-IDENTICAL to the historical strings", () => {
    // Literals, not a call with different arguments — the two must agree with
    // something written before this change, not with each other.
    assert.equal(FIX_TASK_TITLE(1, MAIN_WORKSTREAM), "Fix cycle 1");
    assert.equal(RECHECK_TASK_TITLE("reviewer", 1, MAIN_WORKSTREAM), "Re-review after fix cycle 1");
    assert.equal(RECHECK_TASK_TITLE("tester", 1, MAIN_WORKSTREAM), "Re-test after fix cycle 1");
  });

  test("the omitted argument is 'main' — every historical call site is unmoved", () => {
    assert.equal(FIX_TASK_TITLE(2), FIX_TASK_TITLE(2, MAIN_WORKSTREAM));
    assert.equal(
      RECHECK_TASK_TITLE("reviewer", 2),
      RECHECK_TASK_TITLE("reviewer", 2, MAIN_WORKSTREAM),
    );
  });

  test("two workstreams at one round cannot share an identity tuple", () => {
    // The identity tuple is (project, round, role, title). Two groups at round
    // 7 both put a builder at round 8 with role 'builder'; only the title can
    // separate them.
    const identities = [
      FIX_TASK_TITLE(1, MAIN_WORKSTREAM),
      FIX_TASK_TITLE(1, "ui"),
      FIX_TASK_TITLE(1, "api"),
    ];
    assert.equal(new Set(identities).size, 3, `titles collided: ${identities.join(" | ")}`);

    for (const role of VERDICT_ROLES) {
      const checkers = [
        RECHECK_TASK_TITLE(role, 1, MAIN_WORKSTREAM),
        RECHECK_TASK_TITLE(role, 1, "ui"),
        RECHECK_TASK_TITLE(role, 1, "api"),
      ];
      assert.equal(new Set(checkers).size, 3, `${role} titles collided: ${checkers.join(" | ")}`);
    }
  });

  test("a title stays inside the 200 characters db/projects.ts slices to", () => {
    // A workstream is at most 40 characters (project_tasks_workstream_chk), so
    // the suffix cannot push a generated title into the slice — which would
    // silently truncate two long workstreams back into one identity.
    const longest = "a".repeat(40);
    assert.ok(FIX_TASK_TITLE(3, longest).length <= 200);
    assert.ok(RECHECK_TASK_TITLE("reviewer", 3, longest).length <= 200);
    assert.notEqual(FIX_TASK_TITLE(3, longest), FIX_TASK_TITLE(3, `${longest.slice(0, 39)}b`));
  });
});

/* ========================================================================== *
 * T29 — R40 end to end, in the pure layer: two same-round reviewers in two
 * workstreams are TWO decisions, TWO chains, and nothing is shared.
 * ========================================================================== */

describe("T29 two workstreams at one round consolidate independently", () => {
  const mainReviewer = rv({ taskId: "m1", title: "Review main", lastText: "VERDICT: NEEDS_FIXES" });
  const uiReviewer = rv({ taskId: "u1", title: "Review ui", lastText: "VERDICT: NEEDS_FIXES" });

  test("each group yields its own fix decision, with its own chain keys", () => {
    const a = consolidateVerdictRound(7, [mainReviewer], 3, MAIN_WORKSTREAM);
    const b = consolidateVerdictRound(7, [uiReviewer], 3, "ui");
    assert.equal(a.action, "fix");
    assert.equal(b.action, "fix");
    if (a.action !== "fix" || b.action !== "fix") return;

    assert.equal(a.builderChainKey, "fix:7:1");
    assert.equal(b.builderChainKey, "fix:ui:7:1");
    assert.notEqual(a.builderChainKey, b.builderChainKey);
    assert.notEqual(a.checkers[0]!.chainKey, b.checkers[0]!.chainKey);
  });

  test("neither brief carries the other's feedback — no delivery into the wrong worktree", () => {
    const a = consolidateVerdictRound(7, [mainReviewer], 3, MAIN_WORKSTREAM);
    const b = consolidateVerdictRound(7, [uiReviewer], 3, "ui");
    if (a.action !== "fix" || b.action !== "fix") throw new Error("expected two fix decisions");
    assert.match(a.mergedBrief, /Review main/);
    assert.doesNotMatch(a.mergedBrief, /Review ui/);
    assert.match(b.mergedBrief, /Review ui/);
    assert.doesNotMatch(b.mergedBrief, /Review main/);
  });

  test("their chain rows are two disjoint graphs, in two workstreams", () => {
    const ga = fixChainGraphFields({
      round: 7,
      workstream: MAIN_WORKSTREAM,
      members: [{ taskId: "m1", writeSet: ["src/a.ts"] }],
    });
    const gb = fixChainGraphFields({
      round: 7,
      workstream: "ui",
      // The SAME file, deliberately: different workstreams are isolated
      // worktrees and may write it concurrently — that is the whole point of
      // the design, and it is why the merge is an explicit integration task.
      members: [{ taskId: "u1", writeSet: ["src/a.ts"] }],
    });
    assert.equal(ga.builder.workstream, "main");
    assert.equal(gb.builder.workstream, "ui");
    assert.deepEqual(ga.builder.depends_on, ["m1"]);
    assert.deepEqual(gb.builder.depends_on, ["u1"]);
    assert.equal(
      duplicatesFixChain(
        { cycle: 1, chainKey: "fix:ui:7:1", dependsOn: gb.builder.depends_on },
        { cycle: 1, chainKey: "fix:7:1", dependsOn: ga.builder.depends_on },
      ),
      false,
      "two workstreams' chains must not read as one renumbered group",
    );
  });

  test("their titles differ, so the identity index admits both", () => {
    assert.notEqual(FIX_TASK_TITLE(1, MAIN_WORKSTREAM), FIX_TASK_TITLE(1, "ui"));
    assert.notEqual(
      RECHECK_TASK_TITLE("reviewer", 1, MAIN_WORKSTREAM),
      RECHECK_TASK_TITLE("reviewer", 1, "ui"),
    );
  });
});
