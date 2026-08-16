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
