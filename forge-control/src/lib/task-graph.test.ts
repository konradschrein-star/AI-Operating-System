/**
 * Unit proof for the pure scheduling decisions in `task-graph.ts`.
 *
 * Run: pnpm test   (node:test via tsx, no test framework dependency)
 *
 * Scope: the five functions phase 2A implements — `readyRule`, `graphReady`,
 * `taskDepth`, `conflicts`, `selectClaimable` — plus `legacyRoundReady`, which
 * phase 1 wrote and which the graph is measured against. The case list is
 * `03-quality.md` §2.1, and each block below is named after the section that
 * demands it. `computeRound`, `findCycle`, `groupKey`, `normaliseWritePath` and
 * `validateWorkstream` still throw (phases 3 and 4 by requirement id); their
 * cases belong to those phases and are not stubbed out here.
 *
 * THE REPLICA PROOF IS NOT HERE. R18 lives in `task-graph-replay.test.ts`, its
 * own file because it is the most important test in the project and must be
 * findable (`03-quality.md` §2.1). This file proves the *decisions*; that one
 * proves they add up to today's schedule.
 *
 * NF3: `db/*` is imported TYPE-ONLY. A value import would open a pg Pool in the
 * test process; this suite runs with Postgres stopped (R10).
 *
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY (standing rule 3):
 *
 *  1. `assert.throws(fn, /^task-graph:/)`. Node matches a bare RegExp against
 *     the error's STRING REPRESENTATION — `"GraphIntegrityError: task-graph: …"`
 *     — not against `.message`, so a `^`-anchored pattern NEVER matches and
 *     every such case reports "did not throw" while the throw was perfectly
 *     correct. Round 103 hit this across ten exports. Guarded by
 *     `throwsMessageMatching()` below, which asserts on `.message` explicitly.
 *  2. An assertion that has never been observed failing. Both of the two cases
 *     where a wrong implementation would be invisible — the `GraphIntegrityError`
 *     dangling-dep case and R69's legacy-row term — were mutation-tested by
 *     inverting the implementation and observing red before this file was
 *     committed. The observed failures are quoted in the round's report.
 *  3. A `graphReady` case that passes because the row is not `pending` rather
 *     than because the deps say so. Guarded by `gt()` defaulting to `pending`
 *     and by an explicit non-`pending` case that asserts `false`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  legacyRoundReady,
  graphReady,
  readyRule,
  taskDepth,
  conflicts,
  selectClaimable,
  GraphIntegrityError,
  type GraphTask,
} from "./task-graph.ts";
// Type-only, like the module under test: a value import of db/* would open a pg
// Pool in the test process (NF3, R10).
import type { TaskStatus } from "../db/projects.ts";

/* -------------------------------------------------------------------------- *
 * Fixtures — hand-built rows, no database, no fixture file
 * -------------------------------------------------------------------------- */

/**
 * One task row. Defaults are a `pending` graph ROOT in `main` with no declared
 * writes, so every case below states only the field it is actually about.
 * `depends_on: []` rather than `null` is deliberate: a default of `null` would
 * silently route half these cases down the legacy branch.
 */
function gt(id: string, over: Partial<GraphTask> = {}): GraphTask {
  return {
    id,
    round: 1,
    workstream: "main",
    status: "pending" as TaskStatus,
    depends_on: [],
    write_set: [],
    ...over,
  };
}

function byId(...tasks: GraphTask[]): Map<string, GraphTask> {
  return new Map(tasks.map((t) => [t.id, t]));
}

/**
 * COPIED from `task-graph-replay.test.ts`, which is round 202's file — duplicated
 * rather than imported, deliberately, so neither file owns the other's helper.
 *
 * Why it exists at all: `assert.throws(fn, /^task-graph:/)` can never match.
 * Node tests a bare RegExp against `String(err)` — `"Error: task-graph: …"` —
 * so an anchored pattern silently never fires and the case reports "did not
 * throw" while the throw was correct. This form asserts on `.message`.
 */
function throwsMessageMatching(pattern: RegExp, what: string): (err: unknown) => true {
  return (err: unknown) => {
    assert.ok(err instanceof Error, `${what}() threw a non-Error: ${String(err)}`);
    assert.match(err.message, pattern, `${what}() threw without the expected diagnostic`);
    return true;
  };
}

/* ========================================================================== *
 * READINESS — 03-quality.md §2.1 "Readiness"
 * ========================================================================== */

describe("readyRule — the only interpreter of the NULL sentinel (R12)", () => {
  // Three cases and not one, because the sentinel IS the migration strategy
  // (02-architecture.md §2.2, E2) and a mistake here is silent: a legacy row
  // mistaken for a graph root promotes immediately, past everything below it.
  test("depends_on null → legacy", () => {
    assert.equal(readyRule(gt("a", { depends_on: null })), "legacy");
  });

  test("depends_on [] → graph (an explicit root, NOT the sentinel)", () => {
    assert.equal(readyRule(gt("a", { depends_on: [] })), "graph");
  });

  test("depends_on populated → graph", () => {
    assert.equal(readyRule(gt("a", { depends_on: ["b", "c"] })), "graph");
  });
});

describe("graphReady — the graph branch (R11, R14, R69)", () => {
  test("empty deps → ready", () => {
    const a = gt("a", { depends_on: [] });
    assert.equal(graphReady(a, byId(a)), true);
  });

  test("one done dep → ready", () => {
    const dep = gt("dep", { status: "done" });
    const a = gt("a", { depends_on: ["dep"] });
    assert.equal(graphReady(a, byId(dep, a)), true);
  });

  test("one pending dep → not ready", () => {
    const dep = gt("dep", { status: "pending" });
    const a = gt("a", { depends_on: ["dep"] });
    assert.equal(graphReady(a, byId(dep, a)), false);
  });

  test("mixed done/failed deps → not ready", () => {
    // `failed` is not `done`. A dependency that failed must hold its dependents
    // exactly as a pending one does — the alternative is a reviewer judging a
    // tree its builder never finished.
    const ok = gt("ok", { status: "done" });
    const bad = gt("bad", { status: "failed" });
    const a = gt("a", { depends_on: ["ok", "bad"] });
    assert.equal(graphReady(a, byId(ok, bad, a)), false);
  });

  test("every non-done status holds the dependent", () => {
    const held: TaskStatus[] = ["pending", "ready", "running", "failed", "blocked"];
    for (const status of held) {
      const dep = gt("dep", { status });
      const a = gt("a", { depends_on: ["dep"] });
      assert.equal(graphReady(a, byId(dep, a)), false, `a dep in '${status}' released its dependent`);
    }
  });

  test("a dep id absent from the map throws GraphIntegrityError (R14)", () => {
    const a = gt("a", { depends_on: ["ghost"] });
    // The CLASS as well as the message — that is why R14's failure has its own
    // class: message text is documentation and gets reworded, a class is a
    // contract. Never `false` (silent stall), never `true` (silent promotion).
    assert.throws(
      () => graphReady(a, byId(a)),
      (err: unknown) => {
        assert.ok(err instanceof GraphIntegrityError, `threw ${String(err)}, not GraphIntegrityError`);
        return throwsMessageMatching(/task-graph: graphReady\(\).*ghost/s, "graphReady")(err);
      },
    );
  });

  test("the dangling error names EVERY missing id, not just the first", () => {
    const present = gt("present", { status: "done" });
    const a = gt("a", { depends_on: ["ghost-1", "present", "ghost-2"] });
    assert.throws(
      () => graphReady(a, byId(present, a)),
      (err: unknown) => {
        assert.ok(err instanceof GraphIntegrityError);
        assert.match(err.message, /ghost-1/);
        assert.match(err.message, /ghost-2/);
        assert.match(err.message, /2 dependencies/);
        return true;
      },
    );
  });

  test("dangling is checked BEFORE the deps-done term (R14: integrity beats scheduling)", () => {
    // A pending dep would answer `false` on its own. It must not mask the
    // corruption — a dangling dep read as "not ready yet" is the silent stall
    // this project exists to end.
    const pending = gt("pending-dep", { status: "pending" });
    const a = gt("a", { depends_on: ["pending-dep", "ghost"] });
    assert.throws(() => graphReady(a, byId(pending, a)), GraphIntegrityError);
  });

  test("a non-pending candidate → false (the `pending` term lives in the pure function)", () => {
    // Operator ruling, round 102. `legacyRoundReady()` gates on `pending` in its
    // own body; a `…Ready` function answering `true` for a `done` row is a
    // silent falsehood, and the symmetry is what stops R18 reporting a
    // divergence on rows neither engine would ever promote.
    const done = gt("dep", { status: "done" });
    for (const status of ["ready", "running", "done", "failed", "blocked"] as TaskStatus[]) {
      const a = gt("a", { status, depends_on: ["dep"] });
      assert.equal(graphReady(a, byId(done, a)), false, `a '${status}' row read as ready`);
    }
  });

  test("a non-pending candidate is false, not a throw, even with a dangling dep", () => {
    // The `pending` term is evaluated FIRST. A `done` row with a rotted closure
    // is not a scheduling decision at all, and blocking a project over one would
    // be an alarm on a row nothing will ever promote.
    const a = gt("a", { status: "done", depends_on: ["ghost"] });
    assert.equal(graphReady(a, byId(a)), false);
  });

  test("a legacy row passed to graphReady() throws rather than defaulting (R12)", () => {
    // `?? []` here would be the silent fallback NF1 forbids and would make
    // graphReady() a second interpreter of the sentinel. Both callers dispatch
    // through readyRule(); passing a NULL row is a caller bug and says so.
    const a = gt("a", { depends_on: null });
    assert.throws(
      () => graphReady(a, byId(a)),
      throwsMessageMatching(/task-graph: graphReady\(\) was given the legacy row a/, "graphReady"),
    );
  });
});

describe("graphReady — R69, the legacy-row term (E3, F13)", () => {
  // The frozen closure cannot name a row the OLD engine inserted after 0040 ran
  // (02-architecture.md §3.2.1). Without this term a backfilled row promotes
  // straight past a fix chain numbered far below it, and R18 case (f) diverges
  // on tick 2. Measured, not argued: evidence/phase1-migration.md §13.4.

  /** A graph row at round 1352 whose frozen closure is entirely `done`. */
  function frozenRow(): GraphTask {
    return gt("frozen", { round: 1352, depends_on: ["settled"] });
  }
  const settled = gt("settled", { round: 1350, status: "done" });

  test("all deps done, but a lower-round legacy row is not done → NOT ready", () => {
    const fixBuilder = gt("fix-1307", { round: 1307, depends_on: null, status: "pending" });
    const row = frozenRow();
    assert.equal(graphReady(row, byId(settled, fixBuilder, row)), false);
  });

  test("… and ready once that legacy row is done", () => {
    const fixBuilder = gt("fix-1307", { round: 1307, depends_on: null, status: "done" });
    const row = frozenRow();
    assert.equal(graphReady(row, byId(settled, fixBuilder, row)), true);
  });

  test("a legacy row of a HIGHER round does not block — strictly lower only", () => {
    // Symmetry with legacyRoundReady()'s `earlier.round < task.round`. A term
    // that blocked on `<=` or on any round would freeze every graph row behind
    // every legacy row for the whole straddling window.
    const later = gt("legacy-1400", { round: 1400, depends_on: null, status: "pending" });
    const row = frozenRow();
    assert.equal(graphReady(row, byId(settled, later, row)), true);
  });

  test("a legacy row of an EQUAL round does not block", () => {
    const same = gt("legacy-1352", { round: 1352, depends_on: null, status: "pending" });
    const row = frozenRow();
    assert.equal(graphReady(row, byId(settled, same, row)), true);
  });

  test("a lower-round GRAPH row does not block — the term reads legacy rows only", () => {
    // This is the whole claim that R69 costs nothing on a project planned after
    // the restart: with no NULL row in the map the term is vacuously true and
    // `round` is never consulted. A term that blocked on any lower-round row
    // would re-serialize exactly the projects this engine exists to parallelise.
    const lower = gt("graph-1300", { round: 1300, depends_on: [], status: "pending" });
    const row = frozenRow();
    assert.equal(graphReady(row, byId(settled, lower, row)), true);
  });

  test("the term does not fire before the deps-done term is satisfied either", () => {
    const openDep = gt("settled", { round: 1350, status: "running" });
    const row = frozenRow();
    assert.equal(graphReady(row, byId(openDep, row)), false);
  });
});

describe("legacyRoundReady — today's rule, the thing being replicated (R12)", () => {
  test("EVERY strictly lower round, not merely the previous one", () => {
    // The case a previous-round-only backfill gets wrong (02-architecture.md
    // §3.3): 1291 and 1292 drained, an operator retries a 1290 task to `ready`,
    // and a new 1292 task must NOT promote.
    const retried = gt("r1290", { round: 1290, status: "ready", depends_on: null });
    const drained = gt("r1291", { round: 1291, status: "done", depends_on: null });
    const fresh = gt("r1292", { round: 1292, depends_on: null });
    assert.equal(legacyRoundReady(fresh, [retried, drained, fresh]), false);
    assert.equal(
      legacyRoundReady(fresh, [{ ...retried, status: "done" }, drained, fresh]),
      true,
    );
  });

  test("a row never blocks itself", () => {
    const solo = gt("solo", { round: 5, depends_on: null });
    assert.equal(legacyRoundReady(solo, [solo]), true);
  });
});

/* ========================================================================== *
 * DEPTH — 03-quality.md §2.1 "Depth" (R19)
 * ========================================================================== */

describe("taskDepth — longest path from the roots (R19)", () => {
  test("a chain", () => {
    const a = gt("a");
    const b = gt("b", { depends_on: ["a"] });
    const c = gt("c", { depends_on: ["b"] });
    assert.deepEqual([...taskDepth([a, b, c])], [["a", 0], ["b", 1], ["c", 2]]);
  });

  test("a diamond — LONGEST path, not shortest and not a count of deps", () => {
    // a → b → d, a → c → d, plus a long leg a → b → e → d so the two legs differ.
    const a = gt("a");
    const b = gt("b", { depends_on: ["a"] });
    const c = gt("c", { depends_on: ["a"] });
    const e = gt("e", { depends_on: ["b"] });
    const d = gt("d", { depends_on: ["c", "e"] });
    const depth = taskDepth([a, b, c, e, d]);
    assert.equal(depth.get("d"), 3, "d took the short leg — this is longest-path, not shortest");
    assert.equal(depth.get("c"), 1);
  });

  test("a wide fan-out — thirty leaves all sit at depth 1", () => {
    const root = gt("root");
    const leaves = Array.from({ length: 30 }, (_, i) => gt(`leaf-${i}`, { depends_on: ["root"] }));
    const depth = taskDepth([root, ...leaves]);
    assert.equal(depth.size, 31);
    for (const leaf of leaves) assert.equal(depth.get(leaf.id), 1);
  });

  test("two disjoint roots — each subtree is measured from its own root", () => {
    const r1 = gt("r1");
    const r2 = gt("r2");
    const a = gt("a", { depends_on: ["r1"] });
    const b = gt("b", { depends_on: ["r2"] });
    const c = gt("c", { depends_on: ["b"] });
    const depth = taskDepth([r1, r2, a, b, c]);
    assert.deepEqual(
      [...depth],
      [["r1", 0], ["r2", 0], ["a", 1], ["b", 1], ["c", 2]],
    );
  });

  test("a NULL/array mixture — the legacy row contributes its own round", () => {
    // R19's totality clause: a project holding both kinds of row still renders,
    // and a graph row hanging off a legacy one reads at round + 1 rather than
    // restarting the numbering at 0.
    const legacy = gt("legacy", { round: 1290, depends_on: null });
    const graph = gt("graph", { round: 9999, depends_on: ["legacy"] });
    const root = gt("root", { round: 4242, depends_on: [] });
    const depth = taskDepth([legacy, graph, root]);
    assert.equal(depth.get("legacy"), 1290);
    assert.equal(depth.get("graph"), 1291);
    // A GRAPH row's own `round` is never its depth — that is the number this
    // project is removing from scheduling (R20).
    assert.equal(depth.get("root"), 0);
  });

  test("a dep id absent from the collection contributes no edge and drops no row", () => {
    // Display code. R14's hard error belongs to the promotion path, where a
    // dangling dep changes what the engine DOES; taking the Kanban down over a
    // row it could simply draw at the top would be the wrong trade.
    const orphan = gt("orphan", { depends_on: ["ghost"] });
    const child = gt("child", { depends_on: ["orphan"] });
    const depth = taskDepth([orphan, child]);
    assert.deepEqual([...depth], [["orphan", 0], ["child", 1]]);
  });

  test("a duplicate dep id is one edge, not two", () => {
    const a = gt("a");
    const b = gt("b", { depends_on: ["a", "a"] });
    assert.equal(taskDepth([a, b]).get("b"), 1);
  });

  test("an empty collection is an empty map, not a crash", () => {
    assert.equal(taskDepth([]).size, 0);
  });

  test("a cycle throws GraphIntegrityError naming the unorderable ids", () => {
    // Total means every row gets a depth; a cycle has no longest path at all, so
    // the honest answer is a loud throw rather than a partial map a caller would
    // read as complete. R25/R26 make this unreachable through the API.
    const a = gt("a", { depends_on: ["b"] });
    const b = gt("b", { depends_on: ["a"] });
    assert.throws(
      () => taskDepth([a, b]),
      (err: unknown) => {
        assert.ok(err instanceof GraphIntegrityError);
        assert.match(err.message, /cycle/);
        assert.match(err.message, /\ba\b/);
        assert.match(err.message, /\bb\b/);
        return true;
      },
    );
  });

  test("determinism — the same input twice yields an identical map", () => {
    const rows = [
      gt("legacy", { round: 7, depends_on: null }),
      gt("root"),
      gt("mid", { depends_on: ["root", "legacy"] }),
      gt("leaf", { depends_on: ["mid", "root"] }),
    ];
    const first = taskDepth(rows);
    const second = taskDepth(rows);
    // Entry ARRAYS, not just deepEqual on the maps: key order is part of the
    // claim, and assert.deepEqual on two Maps would not see a reordering.
    assert.deepEqual([...first], [...second]);
    assert.deepEqual([...first], [["legacy", 7], ["root", 0], ["mid", 8], ["leaf", 9]]);
  });
});

/* ========================================================================== *
 * CONTENTION — 03-quality.md §2.1 "Contention" (R16, R17)
 * ========================================================================== */

describe("conflicts — exact-path intersection (R16, R17)", () => {
  test("disjoint → false", () => {
    assert.equal(conflicts(["src/a.ts"], ["src/b.ts"]), false);
  });

  test("identical → true", () => {
    assert.equal(conflicts(["src/a.ts"], ["src/a.ts"]), true);
  });

  test("one shared entry out of many → true", () => {
    assert.equal(
      conflicts(["src/a.ts", "src/b.ts", "docs/x.md"], ["src/c.ts", "src/b.ts"]),
      true,
    );
  });

  test("an EMPTY write-set intersects nothing (R17)", () => {
    // Not a gap to be "improved" later: every row in the replay fixture carries
    // an empty write_set, and an empty set that conflicted would serialize the
    // whole fixture and break the replica on tick 1. It is also today's
    // behaviour exactly — one worktree, everything in parallel.
    assert.equal(conflicts([], ["src/a.ts"]), false);
    assert.equal(conflicts(["src/a.ts"], []), false);
    assert.equal(conflicts([], []), false);
  });

  test("src/a.ts vs src/a.tsx → false (no substring semantics)", () => {
    assert.equal(conflicts(["src/a.ts"], ["src/a.tsx"]), false);
  });

  test("src/ vs src/a.ts → false, DELIBERATELY", () => {
    // A directory prefix does not own a subtree. Prefix semantics would let a
    // task declare `src/` — or `.` — and serialize the project by accident, and
    // the failure would be SILENT under-parallelism, which is the disease this
    // project exists to cure. Declaring a directory is out of scope: declare
    // the files (R16). `normaliseWritePath()` (R28, phase 3) polices the entry.
    assert.equal(conflicts(["src/"], ["src/a.ts"]), false);
    assert.equal(conflicts(["src"], ["src/a.ts"]), false);
  });
});

describe("selectClaimable — the contention belt (R16)", () => {
  test("two ready tasks sharing a file in one workstream → one claimed", () => {
    const a = gt("a", { write_set: ["src/DesktopApp.tsx"] });
    const b = gt("b", { write_set: ["src/DesktopApp.tsx"] });
    assert.deepEqual(
      selectClaimable([a, b], []).map((t) => t.id),
      ["a"],
    );
  });

  test("input order decides who wins — order-stable, and asserted (R16)", () => {
    // The order is a contract, not an accident: `ready` arrives in
    // claimReadyTasks()'s `ORDER BY pt.round ASC, pt.created_at ASC` (§3.4), so
    // the shallower and older task wins the pass and the loser is claimed on a
    // later tick. A winner decided by set iteration order would make the same
    // tick replay differently.
    const a = gt("a", { write_set: ["src/x.ts"] });
    const b = gt("b", { write_set: ["src/x.ts"] });
    assert.deepEqual(selectClaimable([b, a], []).map((t) => t.id), ["b"]);
  });

  test("the same two in DIFFERENT workstreams → both claimed", () => {
    // The entire point of one worktree per workstream: two teams may write the
    // same path because they are writing it in different directories, and the
    // merge is an explicit reviewed integration task (R38), never automatic.
    const a = gt("a", { workstream: "ui", write_set: ["src/DesktopApp.tsx"] });
    const b = gt("b", { workstream: "api", write_set: ["src/DesktopApp.tsx"] });
    assert.deepEqual(
      selectClaimable([a, b], []).map((t) => t.id),
      ["a", "b"],
    );
  });

  test("a ready task conflicting with a RUNNING task → not claimed", () => {
    const running = gt("r", { status: "running", write_set: ["src/x.ts"] });
    const a = gt("a", { write_set: ["src/x.ts"] });
    const b = gt("b", { write_set: ["src/y.ts"] });
    assert.deepEqual(
      selectClaimable([a, b], [running]).map((t) => t.id),
      ["b"],
    );
  });

  test("a running task of ANOTHER workstream never blocks", () => {
    const running = gt("r", { workstream: "api", status: "running", write_set: ["src/x.ts"] });
    const a = gt("a", { workstream: "ui", write_set: ["src/x.ts"] });
    assert.deepEqual(selectClaimable([a], [running]).map((t) => t.id), ["a"]);
  });

  test("three-way chain a↔b, b↔c, a∌c → a and c claimed, b deferred", () => {
    // Not transitive, deliberately: `c` is compared against the CLAIMED set,
    // which does not contain `b`, so it is claimed. Deferring `c` behind a task
    // that is not running would be under-parallelism bought for nothing.
    const a = gt("a", { write_set: ["src/x.ts"] });
    const b = gt("b", { write_set: ["src/x.ts", "src/y.ts"] });
    const c = gt("c", { write_set: ["src/y.ts"] });
    assert.deepEqual(
      selectClaimable([a, b, c], []).map((t) => t.id),
      ["a", "c"],
    );
  });

  test("empty write-sets are always claimable — today's behaviour, preserved (R17)", () => {
    // The replay fixture's every row looks like this. If this case ever goes
    // red, R18 is already broken.
    const rows = Array.from({ length: 6 }, (_, i) => gt(`t${i}`));
    assert.equal(selectClaimable(rows, [gt("running", { status: "running" })]).length, 6);
  });

  test("nothing ready → nothing claimed, and no crash on an empty running set", () => {
    assert.deepEqual(selectClaimable([], []), []);
  });

  test("the returned rows are the input objects, not copies", () => {
    // claimReadyTasks() marks the returned rows `running` in the same
    // transaction; a copy would flip a row nobody else holds.
    const a = gt("a");
    assert.equal(selectClaimable([a], [])[0], a);
  });
});
