/**
 * Task-graph scheduling — the pure logic behind the project engine's
 * concurrency.
 *
 * Context: on the night of 2026-08-16/17 the project `operator-visibility`
 * spent 255 minutes of wall clock on twelve rounds averaging 1.75 tasks each,
 * for work a concurrency of six would have finished in about 45. One
 * 32-minute reviewer held seven unrelated builders behind it, and hand-editing
 * five `round` values took live runs from 1 to 6 instantly: nothing in the
 * engine required those builders to wait, only the numbering did. A round
 * today conflates three unrelated things — ORDERING (a reviewer must judge a
 * settled tree), FILE CONTENTION (two tasks both write DesktopApp.tsx) and
 * NARRATIVE PHASE (this is phase 4). Only the first is a real dependency.
 * See docs/plan/engine-task-graph/00-vision.md §2.
 *
 * The cure is to make every scheduling DECISION a synchronous function over
 * plain objects, here, and to leave `db/projects.ts` holding only the SQL that
 * mirrors them — the mirror stated in the doc-comment on both sides, exactly
 * as `markVerdictTaskDone` mirrors `verdictMemberSettled` today. `round` stops
 * being an input to scheduling and becomes a derived depth, computed for
 * Kanban grouping and human conversation only (R19, R20).
 *
 * Everything here is pure and synchronous so it can be tested without a
 * database, a filesystem, or a network (R10, NF3). The I/O lives in
 * db/projects.ts, lib/workspace.ts and lib/project-tick.ts. The `import type`
 * below is deliberate: a value import would drag the pg pool into the test
 * process, and the replay proof (R18) has to run under `tsx --test` on a host
 * with Postgres stopped.
 *
 * PHASE 4 STATE — this module is COMPLETE, and the list below is maintained
 * rather than left to rot.
 *
 *  REAL: `legacyRoundReady()` and `GraphIntegrityError` (phase 1); `readyRule()`
 *  (R12), `graphReady()` (R11, R14, R69), `taskDepth()` (R19), `conflicts()`
 *  (R16, R17) and `selectClaimable()` (R16) — phase 2A; `computeRound()`
 *  (R23, R24), `findCycle()` (R25, R26), `normaliseWritePath()` and
 *  `validateWorkstream()` (R28), with `GraphValidationError` — phase 3.
 *
 *  NO STUB REMAINS. `groupKey()` (R40) was the last one and it is RETIRED from
 *  this module rather than filled — round 221 (phase 4B), with the §1.1 export
 *  and both census entries that named it, in one commit. It lives in
 *  `lib/project-reconcile.ts`; the reasoning is at its former site below.
 *  Requirement ids are authoritative over any prose enumeration of phases
 *  (round 102), and `04-phases.md` §10 is the map.
 *
 * TWO ERROR CLASSES, AND THE SPLIT IS THE ROUTE'S (phase 3). A
 * `GraphIntegrityError` means the graph ALREADY IN THE DATABASE is corrupt
 * (R14) and belongs on a `500`; a `GraphValidationError` means the CALLER's
 * input is refused (R24's block overflow, R28's paths and workstreams) and
 * belongs on a `400`. A route that could not tell them apart would answer `400`
 * for a corrupt stored graph — telling the caller their perfectly good request
 * was the problem.
 *
 * A stub returning a plausible default (`graphReady` → `false`) would have let
 * the replay test pass for the wrong reason, so there never were any — every
 * stub this module carried threw, with a message prefixed `task-graph: ` naming
 * its function and its requirement id. None are left.
 */

import type { TaskStatus } from "../db/projects.ts";

/* ------------------------------------------------------------------------- *
 * The row, as the scheduler sees it
 * ------------------------------------------------------------------------- */

/**
 * `project_tasks.depends_on`, whose NULL is the entire migration strategy
 * (`02-architecture.md` §2.2, settled as E2 in §9.1 — E1 is the separate ruling
 * that `round` stays a stored, engine-computed integer).
 *
 *  - `null` — never graph-scheduled. Written by the old engine, or by any
 *    INSERT that does not name the column. Keeps today's round semantics
 *    forever. TODO(R12-retire)
 *  - `[]`   — graph-scheduled, explicitly a root. Promotes immediately.
 *  - `[a]`  — graph-scheduled. Promotes when every named task is `done`.
 *
 * `readyRule()` is the ONLY place this sentinel is interpreted.
 */
export type DepsField = string[] | null;

/**
 * The columns of `project_tasks` that scheduling decisions read, and nothing
 * else — a deliberately narrow projection so a decision cannot quietly start
 * depending on a brief, a run id or a timestamp.
 *
 * NOTE THE ABSENCE OF `project_id`. Every function here that takes a
 * COLLECTION of tasks is defined over the tasks of ONE project; see the
 * precondition on `legacyRoundReady()`. Mixing projects into one array is the
 * caller's bug, and it is not detectable from this type.
 */
export interface GraphTask {
  id: string;
  round: number;
  workstream: string;
  status: TaskStatus;
  depends_on: DepsField;
  write_set: string[];
  /**
   * PROVENANCE OF `depends_on`, not a second sentinel (R71, E4, round 242).
   * `true` on exactly the rows whose closure `0043_task_graph.sql`'s backfill
   * wrote; `false` on every row an engine wrote itself, which is the column
   * default and therefore the answer for every row the migration never touched.
   *
   * It is REQUIRED rather than optional on purpose. `graph_frozen?: boolean`
   * read as `?? false` would be the silent fallback NF1 forbids — a caller that
   * forgot the field would get "not frozen" and the widened R69 term would go
   * quiet on precisely the rows it exists for, with nothing to notice. A missing
   * field is a compile error instead, which is how the three columns of 0040
   * were introduced and for the same reason.
   */
  graph_frozen: boolean;
}

/* ------------------------------------------------------------------------- *
 * Readiness
 * ------------------------------------------------------------------------- */

/**
 * Today's promotion rule, extracted verbatim from `promoteReadyTasks()` in
 * db/projects.ts, so that the graph can be proved to be an exact replica of it
 * before anything switches over (R12, R18). TODO(R12-retire)
 *
 * SQL MIRROR — the row-level half of `promoteReadyTasks()`'s WHERE clause:
 *
 *     AND pt.status = 'pending'
 *     AND NOT EXISTS (
 *       SELECT 1 FROM project_tasks earlier
 *        WHERE earlier.project_id = pt.project_id
 *          AND earlier.round < pt.round
 *          AND earlier.status <> 'done'
 *     )
 *
 * EVERY strictly lower round, not the previous one and not the previous
 * non-empty one. That is the difference R18 case (b) exists to catch: with
 * rounds 1290/1291/1292 all drained and an operator retrying a 1290 task back
 * to `ready`, today's rule refuses to promote a new 1292 task, and a
 * previous-round-only backfill would promote it. `retryTask()` and
 * `unwedgeProject()` make that reachable, not theoretical
 * (`02-architecture.md` §3.3).
 *
 * WHAT IS DELIBERATELY NOT HERE. The statement's other two terms are joins
 * this function cannot see and must not guess at:
 *
 *  - `p.status = 'active'` (R13 in this project's `01-requirements.md`; the
 *    `E7` / `R8` pair is `db/projects.ts`'s own lineage pin on `main` and does
 *    NOT resolve in this corpus — carried here as attribution, not as a
 *    citation to follow) is the CALLER's gate. It lives on
 *    the joined `projects` row, not on a task, and it is load-bearing: paused,
 *    blocked, done and cancelled projects promote nothing, and because it is a
 *    filter rather than a state change, a project flipped back to `active`
 *    resumes with the same rows still `pending`, exactly where it stopped.
 *    Smuggling a project status into a per-task predicate would move that gate
 *    somewhere no one looks for it. `GraphTask` carries no project fields, so
 *    the omission is structural rather than a promise.
 *  - `earlier.project_id = pt.project_id` is the PRECONDITION below, for the
 *    same reason.
 *
 * PRECONDITION: `all` is the task list of ONE project. `GraphTask` has no
 * `project_id`, so this cannot be checked here; a caller that mixes projects
 * gets an answer computed against a graph that does not exist. The engine's
 * callers satisfy it by construction — `promoteReadyTasks()` is a set-based
 * UPDATE whose subquery is correlated on `project_id`, and the replay harness
 * loads one project's fixture. `all` MAY contain `task` itself: the row's own
 * round is not strictly lower than itself, so it can never block itself.
 *
 * @param task the candidate row
 * @param all  every task of the SAME project, in any order
 * @returns whether the row would be promoted to `ready` by today's engine,
 *          given an active project
 */
export function legacyRoundReady(task: GraphTask, all: readonly GraphTask[]): boolean {
  if (task.status !== "pending") return false;
  for (const earlier of all) {
    if (earlier.round < task.round && earlier.status !== "done") return false;
  }
  return true;
}

/**
 * Graph rule (R11). Ready when every id in `depends_on` names a task that is
 * `done`; an empty array is trivially satisfied and promotes immediately.
 *
 * Throws `GraphIntegrityError` on a CORRUPT `depends_on` (R14). Never `false`,
 * never `true`: a vanished dependency reading as satisfied is the
 * silent-fallback shape this fleet forbids, and a task stuck at `pending`
 * forever is the failure this project exists to end.
 *
 * TWO SHAPES OF CORRUPTION HERE, THREE IN SQL, AND THEY ARE THE SAME RULE
 * (round 204, red-team finding 2). R14 is written in terms of
 * `cardinality(depends_on)` against the number of same-project rows the array
 * names, and the SQL implements it that way; this function must therefore refuse
 * every input that mismatch refuses, which membership testing alone did not:
 *
 *  - AN ID ABSENT from `byId` — F1's dangling dep. Because `byId` holds the tasks
 *    of ONE project (precondition 2), a CROSS-PROJECT id is absent too, so the
 *    SQL's third shape (`foreign_ids`, a row of another project) lands here as
 *    the same refusal. The SQL distinguishes them only to write a truthful
 *    notification.
 *  - THE SAME ID TWICE. `cardinality` counts elements, the comparison counts
 *    rows, so a duplicate mismatches and the SQL blocks the project over it.
 *    Membership testing called it ready. That divergence made the pure side and
 *    the shipped statement disagree on one input, under a doc-comment declaring
 *    the pure side authoritative — so this arm exists to make the mirror true,
 *    and R14 now states the semantics it settles on.
 *
 * WHY CORRUPTION AND NOT A HARMLESS TIDY-UP: nothing in this engine writes a
 * duplicate. The R6 backfill aggregates over distinct rows of one project, and
 * phase 3's API normalises before storage (R28). A duplicate in the column
 * therefore means an UNVALIDATED writer — an operator `psql`, an import, a
 * script — and the safe reading of an array no validator produced is that the
 * writer's intent is unknown, which is exactly what `blocked` plus a
 * notification is for. `taskDepth()` still treats a duplicate as one edge and
 * still refuses to crash on an absent id, for the reason recorded there: it is
 * DISPLAY code, and R14's hard error belongs to the path where a corrupt array
 * changes what the engine DOES.
 *
 * AND THE STRADDLE TERM (R69). `depends_on` is a FROZEN closure: the backfill
 * (R6) writes the ids of the rows that existed AT MIGRATION TIME, and 0040 is
 * applied before the executor restarts (R64), so rows keep being inserted in
 * the gap and after it — `createFixChain` at `round + 1` and `round + 2` — that
 * NO frozen closure names, because they did not exist to be named. Without a
 * second term a frozen row promotes the moment its frozen deps drain, straight
 * past a fix chain numbered far below it; today's engine holds it. So:
 *
 *     ready = every dep is done
 *             AND NOT ∃ o ∈ byId : o.round < task.round
 *                                  ∧ o.status !== 'done'
 *                                  ∧ (task.graph_frozen ∨ o.depends_on === null)
 *
 * TWO KINDS OF ROW GET HELD, AND THE DISJUNCT IS WHY (E4, round 242):
 *
 *  - A FROZEN candidate (`graph_frozen`, R71) is held behind ANY non-`done`
 *    lower-round row, whatever that row's own provenance. Its closure was
 *    computed against a SNAPSHOT, so "every dep is done" is a statement about a
 *    task list that no longer exists; the round it was born under is the only
 *    ordering it ever declared, and this term replays it. That covers a fix
 *    chain the OLD engine inserted in the deploy gap (F13) and one the NEW
 *    engine creates after the restart with real graph fields (F14) with one
 *    predicate, because the candidate's provenance — not the blocker's — is
 *    what makes the closure untrustworthy.
 *  - A NON-FROZEN candidate is held only behind LEGACY rows (`depends_on IS
 *    NULL`), exactly as before. Its own closure was declared, not derived, so
 *    the ids it names are the whole of its ordering — except against a row
 *    created under the old semantics, which never got the chance to declare
 *    anything and whose round is therefore still binding.
 *
 * The two together are what make the term FREE where it must be. On a project
 * planned entirely after the restart, no row is frozen and no row is NULL, so
 * both sides of the disjunct are false, `round` is never consulted, and eight
 * independent builders stay eight-wide. That is not an argument, it is probe 3
 * of `scripts/checks/check-r69-straddle.sh`: with the marker, 3 ticks / 8-wide;
 * with the widening ungated, 17 ticks / 1-wide, which is today's engine.
 *
 * WHY A RECORDED MARKER AND NOT AN INFERRED ONE. Round 223 built and measured
 * all four ways to infer "this row's closure was written by the migration" from
 * the data — the NULL sentinel, the sentinel plus a settled inert row,
 * `isClosureShaped()`, and a `created_at` horizon — and each either goes blind
 * exactly where sight is needed or convicts ordinary fan-out of being a
 * backfill (`02-architecture.md` §9.3, `evidence/phase4-workstreams.md` §5.7).
 * The fact is now RECORDED by the statement that makes it true (R71), so the
 * predicate reads a column instead of guessing from a shape.
 *
 * `02-architecture.md` §3.2, §3.2.1 and §9.2/§9.3 (E3, E4) carry the ruling;
 * `F13` in §6 is the failure it closes; R18 cases (f) and (g) in
 * `task-graph-replay.test.ts` are the tests that fail without each half.
 *
 * This is the ONE place a graph-branch predicate reads `round`, and it reads it
 * only about the migration's own rows and about legacy rows. It is part of the
 * legacy surface, not of the graph: it is deleted in the same commit as
 * `readyRule()` and R12's legacy branch, when no `depends_on IS NULL` and no
 * `graph_frozen` row remains. TODO(R12-retire)
 *
 * THE `pending` TERM LIVES HERE, not in the caller — operator ruling, round 102,
 * inherited and binding. `legacyRoundReady()` gates on `pending` in its own body
 * and this function gates on it identically, because a function named `…Ready`
 * that answers `true` for a `done` row is a silent falsehood, and
 * `promoteReadyTasks()` cannot promote a non-`pending` row in any case. The
 * symmetry is also load-bearing for the replay proof: without it R18 would
 * report a divergence on rows neither engine would ever promote.
 *
 * ORDER OF EVALUATION, and it is not arbitrary:
 *   1. not `pending`            → `false`
 *   2. a corrupt `depends_on` — an id absent from `byId`, or an id twice →
 *      THROW (R14). Integrity beats scheduling, so it precedes both remaining
 *      terms; never `false`, never `true`.
 *   3. every dep `done`         → otherwise `false`
 *   4. the straddle term (R69)  → otherwise `false`
 *
 * PRECONDITION 1: `readyRule(task) === "graph"`. A `depends_on` of `null` is the
 * LEGACY branch's row and is judged by `legacyRoundReady()`; both callers
 * dispatch through `readyRule()` exactly as §3.1's single statement dispatches
 * on `pt.depends_on IS NOT NULL`. Passing one here is a caller bug and throws.
 * Reading it as `depends_on ?? []` would be the silent fallback NF1 forbids, and
 * would widen `graphReady()` into a second interpreter of the sentinel — the one
 * property that lets the whole legacy surface be deleted in one commit.
 *
 * PRECONDITION 2: `byId` holds the tasks of ONE project, keyed by id. As on
 * `legacyRoundReady()`, `GraphTask` carries no `project_id`, so this is not
 * checkable here.
 *
 * CAN IT CHEAPLY BE MADE ENFORCEABLE? Assessed in phase 2 and DECIDED AGAINST,
 * recorded as a decision rather than left as an omission. Adding `project_id` to
 * `GraphTask` would change the exported shape that `02-architecture.md` §1.1
 * fixes, and with it what phase 3's task API and phase 6's `/plan` endpoint have
 * to marshal into every call — a widening whose cost lands on three phases to
 * catch a bug neither caller can commit. Both engine callers satisfy the
 * precondition by construction: `promoteReadyTasks()`'s subquery is correlated
 * on `project_id` (§3.1), and the replay harness loads a single project's
 * fixture. So the check stays structural — a field that is not there cannot be
 * read — matching the reasoning already recorded on `legacyRoundReady()`.
 */
export function graphReady(task: GraphTask, byId: ReadonlyMap<string, GraphTask>): boolean {
  const deps = task.depends_on;
  if (deps === null) {
    throw new Error(
      `task-graph: graphReady() was given the legacy row ${task.id} (depends_on IS NULL); ` +
        "dispatch through readyRule() — a NULL row is legacyRoundReady()'s (R12)",
    );
  }

  // 1. The `pending` term (see the doc-comment's ruling).
  if (task.status !== "pending") return false;

  // 2. R14 — integrity first, both shapes in one pass. Report EVERY offending
  //    id of EVERY shape, not just the first: the operator fixing a corrupt
  //    graph needs the whole list, and F1's notification quotes this wording.
  //    Both clauses appear when both fire, because a row can exhibit both and a
  //    message naming one of two problems sends the operator back twice.
  const missing = deps.filter((id) => !byId.has(id));
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const id of deps) {
    if (seen.has(id)) {
      if (!duplicated.includes(id)) duplicated.push(id);
    } else {
      seen.add(id);
    }
  }
  if (missing.length > 0 || duplicated.length > 0) {
    const clauses: string[] = [];
    if (missing.length > 0) {
      clauses.push(
        `names ${missing.length} dependenc${missing.length === 1 ? "y" : "ies"} ` +
          `that no longer exist${missing.length === 1 ? "s" : ""}: ${missing.join(", ")}`,
      );
    }
    if (duplicated.length > 0) {
      clauses.push(
        `names ${duplicated.length} duplicated dependency ` +
          `id${duplicated.length === 1 ? "" : "s"}: ${duplicated.join(", ")}`,
      );
    }
    throw new GraphIntegrityError(
      `task-graph: graphReady(): task ${task.id} ${clauses.join("; and ")} (R14)`,
    );
  }

  // 3. R11 — every dep done. An empty array is trivially satisfied.
  for (const id of deps) {
    // Non-null by step 2: every id was just proved present.
    if (byId.get(id)!.status !== "done") return false;
  }

  // 4. R69 — the straddle term (E3, §9.2, F13; widened by E4, §9.3, round 242).
  //    The candidate's own marker is read ONCE, outside the loop: on a project
  //    where nothing is frozen and nothing is legacy the loop still runs but no
  //    iteration can return, so `round` decides nothing — which is what probe 3
  //    of check-r69-straddle.sh measures as 3 ticks / 8-wide. A frozen
  //    candidate short-circuits the provenance test on the blocker, because for
  //    it every lower-round row is binding regardless of who wrote that row.
  //    TODO(R12-retire)
  const frozen = task.graph_frozen;
  for (const other of byId.values()) {
    if (other.round >= task.round || other.status === "done") continue;
    if (frozen || other.depends_on === null) return false;
  }

  return true;
}

/**
 * Which rule applies to this row — the ONLY place the `depends_on` NULL
 * sentinel is interpreted (R12). `null` → `"legacy"`; `[]` and any populated
 * array → `"graph"`. TODO(R12-retire)
 *
 * One `=== null` and nothing else: `[]` is a graph root and MUST NOT be confused
 * with the sentinel, which is why this is a named function with three unit cases
 * rather than an inline check at each call site. A truthiness test would read an
 * empty array as truthy and be right by accident here, and wrong the first time
 * it were copied somewhere the operand could be `undefined`.
 */
export function readyRule(task: GraphTask): "graph" | "legacy" {
  return task.depends_on === null ? "legacy" : "graph";
}

/* ------------------------------------------------------------------------- *
 * Depth and round
 * ------------------------------------------------------------------------- */

/**
 * Longest path from the roots, for every task, in one pass over a topological
 * order (R19). TOTAL by construction: a row whose `depends_on` is NULL
 * contributes its own `round` as its depth, so a project holding both kinds of
 * row still renders. Display only — never written to the database.
 *
 * Kahn's algorithm, not a recursive walk: the fixture is ~124 rows today but a
 * closure-backfilled project is a dense DAG, and a recursion whose depth is the
 * chain length is a stack overflow waiting for a long project.
 *
 * THE RULES, each a decision this function had to take:
 *
 *  - A LEGACY row (`depends_on === null`) contributes no edge and seeds its own
 *    `round` as its depth (R19's totality clause). A graph row that depends on
 *    one therefore sits at `round + 1`, which is what makes a straddling
 *    project's Kanban read in one ordering instead of two.
 *  - A DEP ID ABSENT from `all` CONTRIBUTES NO EDGE. It does not crash the walk
 *    and it does not drop the row: a graph row whose deps are all absent is a
 *    root at depth 0 and still appears in the returned map. This is display
 *    code — R14's hard error belongs to the promotion path, where a dangling dep
 *    changes what the engine DOES, and duplicating it here would take the Kanban
 *    down over a row it could simply draw at the top.
 *  - A DUPLICATE dep id inside one `depends_on` is one edge, not two. The
 *    PROMOTION path disagrees deliberately and the split is the same one as
 *    above: `graphReady()` throws on a duplicate (R14 — a mismatched cardinality
 *    means an unvalidated writer), while here it changes nothing that can be
 *    drawn, and refusing to render a board over it would be an outage in place of
 *    a diagram.
 *  - A CYCLE cannot be topologically ordered and so cannot be given a
 *    longest-path depth at all. It throws `GraphIntegrityError` naming the
 *    unorderable ids rather than returning a partial map that a caller would
 *    read as complete. R25/R26 make it unreachable through the API; this is the
 *    display side of the same belt.
 *
 * DETERMINISTIC: the returned map's keys are in the input's first-appearance
 * order, the ready queue is drained in input order, and no value depends on
 * iteration order of anything else. Same input twice → identical map.
 */
export function taskDepth(all: readonly GraphTask[]): Map<string, number> {
  const byId = new Map<string, GraphTask>();
  for (const t of all) byId.set(t.id, t);

  // Present, de-duplicated dependency ids per task — the edges that actually
  // exist in this collection.
  const edges = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const depth = new Map<string, number>();

  for (const [id, task] of byId) {
    const present = [...new Set(task.depends_on ?? [])].filter((dep) => byId.has(dep));
    edges.set(id, present);
    indegree.set(id, present.length);
    // A legacy row seeds its own round; every graph row starts at 0 and is
    // raised by relaxation below.
    depth.set(id, task.depends_on === null ? task.round : 0);
    for (const dep of present) {
      const list = dependents.get(dep);
      if (list) list.push(id);
      else dependents.set(dep, [id]);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

  let settled = 0;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    settled++;
    const here = depth.get(id)!;
    for (const child of dependents.get(id) ?? []) {
      if (here + 1 > depth.get(child)!) depth.set(child, here + 1);
      const left = indegree.get(child)! - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }

  if (settled !== byId.size) {
    const stuck = [...indegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id);
    throw new GraphIntegrityError(
      `task-graph: taskDepth(): ${stuck.length} task(s) cannot be topologically ` +
        `ordered — depends_on contains a cycle through: ${stuck.join(", ")} (R19, R25)`,
    );
  }

  // Rebuild in first-appearance order so the map is byte-identical between two
  // calls on the same input regardless of how the relaxation reached it.
  const ordered = new Map<string, number>();
  for (const t of all) ordered.set(t.id, depth.get(t.id)!);
  return ordered;
}

/**
 * `round = 1 + max(dep.round)`, or `0` for no dependencies (R23). Pure, and
 * the API's only writer of `round`: an explicitly supplied round is honoured
 * unchanged, because the architect legitimately seeds one phase-block number
 * per phase (`k*100`) and everything below inherits from it by the `+1` rule.
 *
 * AN EXPLICIT `round` NEVER REACHES THIS FUNCTION. R23's two halves are split
 * across two files on purpose: honouring a supplied round is a decision about a
 * request body, so it lives in the route (`routes/projects.ts`, phase 3), which
 * calls this only when `round` was omitted. Nothing here can tell whether the
 * caller supplied one, and nothing here should try.
 *
 * THE BLOCK GATE (R24). A computed round that would leave its phase block is
 * refused with `GraphValidationError` — a `400`, not a corrupt-graph `500`,
 * because the offending input is the caller's `depends_on`. `base` is the block
 * of the SHALLOWEST dependency, `floor(min(dep.round) / 100)`, in R24's own
 * words; the refusal fires when `floor(computed / 100) !== base`. So a chain 99
 * levels deep inside block `k` passes (`k*100` … `k*100+99`) and the 100th link
 * is refused. That is the gate being satisfiable rather than decorative
 * (00-vision.md §7 rule 2): a phase has 99 depth levels, which no real plan
 * uses, and the test builds the 99 as an actual chain rather than as a
 * hand-picked pair of numbers.
 *
 * WHY THE SHALLOWEST AND NOT THE DEEPEST. Reading `base` off `max` instead
 * would make the gate self-fulfilling: the deepest dependency is the one the
 * `+1` is measured from, so `floor((max+1)/100)` differs from `floor(max/100)`
 * only at a block boundary the deepest dependency has itself already reached,
 * and a task fanning in from block 1 and block 2 would be waved through into
 * block 2 while silently abandoning its block-1 lineage. Measured against
 * deps at rounds `{199, 205}`: shallowest-based refuses (base 1, computed 206),
 * deepest-based accepts. The unit case is written so the two readings disagree.
 *
 * LEGACY ROWS ARE LEGAL MEMBERS OF `deps`. A row whose `depends_on` is `null`
 * carries a real `round` written by the old engine, and it contributes that
 * round here exactly as any other row does. This function reads ONLY `.round`
 * and never interprets the sentinel — `readyRule()` is the only interpreter of
 * it (inherited contract, phase 2A; `02-architecture.md` §2.2, E2).
 */
export function computeRound(deps: readonly GraphTask[]): number {
  // R23 — no dependencies is a root, and a root is round 0. Not `1`, and not
  // the caller's own guess: the route honours an explicit round instead of
  // calling this at all.
  if (deps.length === 0) return 0;

  let deepest = deps[0]!.round;
  let shallowest = deps[0]!.round;
  for (const dep of deps) {
    if (dep.round > deepest) deepest = dep.round;
    if (dep.round < shallowest) shallowest = dep.round;
  }

  const computed = deepest + 1;
  const base = Math.floor(shallowest / 100);
  if (Math.floor(computed / 100) !== base) {
    throw new GraphValidationError(
      `task-graph: computeRound(): computed round ${computed} leaves phase block ${base} ` +
        `(rounds ${base * 100}-${base * 100 + 99}), the block of its shallowest dependency ` +
        `at round ${shallowest}; a phase has 99 depth levels and this would be the 100th (R24)`,
    );
  }
  return computed;
}

/* ------------------------------------------------------------------------- *
 * Cycles
 * ------------------------------------------------------------------------- */

/**
 * `null` when adding `candidate`'s edges keeps the graph acyclic; otherwise
 * the offending path as an ordered list, oldest node first, from the repeated
 * node back to itself (R25). Naming the path is the requirement — a detector
 * that reports only "a cycle exists" fails it.
 *
 * This is a BELT, and R26 requires saying so here rather than leaving a future
 * reader to prove it never fires and delete it. A cycle is structurally
 * unreachable given R27 (a dependency must name an already-existing task of
 * the same project) and R29 (`depends_on` is immutable after insert), which
 * together make every edge point backwards in insert order. The belt exists
 * because a graph that can never drain must not be insertable even if one of
 * those two properties is lost.
 *
 * A node whose own `depends_on` is `null` is a legacy row: it contributes no
 * edges and must not crash the walk.
 *
 * WHAT WAS ACTUALLY IMPLEMENTED, so the belt claim above stays honest (R26):
 * an iterative depth-first walk from `candidate` along dependency edges, with
 * the current path held as an explicit stack. When the walk reaches a node that
 * is already ON that path, the cycle is the slice of the path from that node's
 * first appearance to the end, with the node appended again — the closed walk,
 * so `a → a` returns `[a, a]` and `a → b → c → a` returns `[a, b, c, a]`. The
 * repeated node is named at BOTH ends because R25's phrasing is "from the
 * repeated node back to itself", and because a reader handed `[a, b, c]` cannot
 * tell a cycle from a chain.
 *
 * ITERATIVE, NOT RECURSIVE, for the reason recorded on `taskDepth()`: recursion
 * depth would be the chain length, and a long project is a stack overflow
 * waiting to happen. Fully-explored nodes are remembered, so the diamond and
 * the wide fan-out are linear rather than exponential.
 *
 * THE CANDIDATE'S EDGES WIN over any stored row carrying the same id: the
 * question asked is what the graph BECOMES if these edges are added, and on the
 * insert path the candidate is not in `byId` at all yet. That is also why the
 * title of a node absent from `byId` reads as the task being created — see
 * `titleOf()`.
 *
 * AN ID IN SOME NODE'S `depends_on` THAT IS ABSENT FROM `byId` IS SKIPPED HERE,
 * SILENTLY, AND THAT IS NOT A SWALLOWED ERROR (NF1). A dangling dependency is
 * R27's `400` and belongs to the route (phase 3, builder 3), which validates
 * existence BEFORE asking this question; `graphReady()` throws `R14` on the same
 * shape at promotion time. A cycle detector that also refused dangling ids would
 * report the wrong defect for the wrong reason, at a point where it cannot
 * distinguish "not yet inserted" from "vanished".
 */
export function findCycle(
  candidate: { id: string; depends_on: string[] },
  byId: ReadonlyMap<string, { id: string; title: string; depends_on: DepsField }>,
): Array<{ id: string; title: string }> | null {
  const edgesOf = (id: string): readonly string[] => {
    if (id === candidate.id) return candidate.depends_on;
    const node = byId.get(id);
    // Absent → no edges (see the doc-comment: R27's business, not this one's).
    // A legacy row (`depends_on === null`) contributes no edges either, and must
    // not crash the walk; `readyRule()` stays the only INTERPRETER of the
    // sentinel — this is a structural "it has no edges", not a reading of it.
    if (node === undefined || node.depends_on === null) return [];
    return node.depends_on;
  };

  const titleOf = (id: string): string => {
    const stored = byId.get(id);
    if (stored !== undefined) return stored.title;
    // Only the candidate can be absent from `byId` and still appear on a
    // returned path: every other node on a cycle has an outgoing edge, and a
    // node absent from `byId` has none, so it can never be the node a walk
    // returns to.
    return "(the task being created)";
  };

  const path: string[] = [];
  const onPath = new Set<string>();
  const explored = new Set<string>();
  const stack: Array<{ id: string; edges: readonly string[]; next: number }> = [];

  const descend = (id: string): void => {
    path.push(id);
    onPath.add(id);
    stack.push({ id, edges: edgesOf(id), next: 0 });
  };

  descend(candidate.id);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.edges.length) {
      explored.add(frame.id);
      onPath.delete(frame.id);
      path.pop();
      stack.pop();
      continue;
    }

    const dep = frame.edges[frame.next]!;
    frame.next += 1;
    if (explored.has(dep)) continue;
    if (onPath.has(dep)) {
      // R25 — the offending path, oldest node first, from the repeated node
      // back to itself. Naming it is the requirement; "a cycle exists" is not.
      const from = path.indexOf(dep);
      return [...path.slice(from), dep].map((id) => ({ id, title: titleOf(id) }));
    }
    descend(dep);
  }

  return null;
}

/* ------------------------------------------------------------------------- *
 * Contention
 * ------------------------------------------------------------------------- */

/**
 * Do two write-sets intersect? Exact string equality on normalised
 * repo-relative POSIX paths; a directory prefix does NOT count (R16). Prefix
 * semantics would invite a task to declare `src/` — or `.` — and serialize the
 * project by accident, and the failure would be silent under-parallelism,
 * which is the disease.
 *
 * An EMPTY write-set intersects nothing and is therefore always claimable
 * (R17). That is today's behaviour exactly — every task shares one worktree
 * and runs in parallel.
 *
 * WHAT PROVES R17, precisely (corrected round 204, gating finding 2): this
 * function's own empty-set cases in `task-graph.test.ts`, and case 7 of
 * `scripts/checks/check-scheduler-sql.sh`, which drives the shipped
 * `claimReadyTasks()` against a real Postgres and asserts the empty-write-set
 * row is claimed. NOT the R18 replay, which was credited here and in three other
 * places until round 204: `task-graph-replay.test.ts` imports neither
 * `conflicts` nor `selectClaimable`, and its `simulate()` moves rows
 * `pending → running` with no claim step, so it cannot observe contention at
 * all. Measured before striking the claim: inverting the empty-set rule to
 * `return true` leaves all 35 replay tests green, including every R18 case.
 */
export function conflicts(a: readonly string[], b: readonly string[]): boolean {
  // R17, stated before anything else because it is a requirement rather than an
  // optimisation: an empty write-set is today's every task, and a `conflicts()`
  // that answered `true` for one would serialize a whole project. The loop below
  // would already return false here; the early exit is the requirement made
  // visible.
  if (a.length === 0 || b.length === 0) return false;

  // R16 — EXACT string equality, never a prefix test. `src/` does not own
  // `src/a.ts`: prefix semantics invite a task to declare `src/` (or `.`) and
  // serialize the project by accident, and the failure would be silent
  // under-parallelism, which is the disease this project exists to cure.
  // Normalisation is `normaliseWritePath()`'s job at insert time (R28, phase 3),
  // so both sides are already repo-relative POSIX by the time they get here.
  const left = new Set(a);
  for (const path of b) if (left.has(path)) return true;
  return false;
}

/**
 * The contention belt (R16): which of `ready` may be claimed on this pass,
 * given the tasks currently `running`. A candidate is dropped when its
 * `write_set` intersects that of a running task, or of an
 * earlier-in-this-pass candidate, WITHIN THE SAME WORKSTREAM. Dropped
 * candidates stay `ready` and are claimed on a later tick.
 *
 * Two tasks in DIFFERENT workstreams never conflict, whatever they write —
 * that is the entire point of one worktree per workstream.
 *
 * ORDER-STABLE, and the order is a contract rather than an accident: `ready`
 * arrives in `claimReadyTasks()`'s `ORDER BY pt.round ASC, pt.created_at ASC`
 * (§3.4), so the shallower and older of two contending tasks wins the pass and
 * the loser is claimed on a later tick. A conflict resolved by set iteration
 * order would make which builder starts first depend on nothing a reader could
 * see, and would make the same tick replay differently.
 *
 * NOT TRANSITIVE, deliberately. In a chain a↔b, b↔c with a and c disjoint, `a`
 * is claimed, `b` is dropped against `a`, and `c` is then compared against the
 * CLAIMED set — which does not contain `b` — so `c` is claimed too. Comparing
 * against all earlier CANDIDATES instead would defer `c` behind a task that is
 * not running, which is under-parallelism bought for nothing.
 */
export function selectClaimable(
  ready: readonly GraphTask[],
  running: readonly GraphTask[],
): GraphTask[] {
  const claimed: GraphTask[] = [];

  for (const candidate of ready) {
    const contends = (other: GraphTask): boolean =>
      // The workstream test comes first: two tasks in different workstreams hold
      // different worktrees and cannot clobber each other, whatever they write.
      other.workstream === candidate.workstream &&
      conflicts(candidate.write_set, other.write_set);

    if (running.some(contends)) continue;
    if (claimed.some(contends)) continue;
    claimed.push(candidate);
  }

  return claimed;
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

/*
 * `groupKey()` (R40) STOOD HERE AND IS RETIRED — round 221, phase 4B, in the
 * same commit that writes the real one and removes both census entries that
 * named this stub (standing rule 4: a requirement and its gate clause retire
 * together).
 *
 * It lives in `lib/project-reconcile.ts` now. `02-architecture.md` §1.1
 * declared it here; round 102 found that `04-phases.md` §10 assigns R40 to
 * `project-reconcile.ts` instead, so nobody was ever going to fill this stub
 * and every caller would have met a throw. The ruling — re-checked at round 221
 * against the tree, which has no graph-side caller of a group key and never
 * had one — is that the export was the mistake, not the phase map: the group
 * key is a CONSOLIDATION concern, and all three of its terms are already in
 * project-reconcile.ts's hand. Exporting it from here bought a cross-module
 * dependency and no caller.
 *
 * Nothing in this module is a stub any more. `task-graph-replay.test.ts`'s
 * stub census, which existed to prove the remaining stubs threw, now asserts
 * over the SOURCE that no stub marker survives here — a census looping over an
 * empty list would have certified itself (00-vision.md §7 rule 3). The marker
 * it looks for is the phrase every stub in this module's history threw with;
 * this comment deliberately does not quote it, because a mention would be
 * indistinguishable from a stub to a substring scan.
 */

/**
 * Normalise and validate one `write_set` entry (R28): repo-relative POSIX,
 * non-empty, no leading `/`, no `..` segment, no NUL, at most 400 characters,
 * with every `.` SEGMENT stripped — leading or interior — and duplicate slashes
 * collapsed. Throws naming the offending entry — never a warning, never a
 * silent drop.
 *
 * NORMALISE, THEN VALIDATE THE RESULT, in that order: `./src//a.ts` is a legal
 * entry that happens to be written badly, and refusing it would push planners
 * into hand-normalising paths, which is how two spellings of one file end up in
 * two write-sets and stop conflicting (R16 is exact string equality — the whole
 * contention belt rests on one spelling per file).
 *
 * THE THREE NORMALISATION RULES ARE APPLIED TO A FIXPOINT, COLLAPSE FIRST, and
 * that ordering is a decision rather than a transcription. Applied strip-first
 * in a single pass, `.//a.ts` becomes `/a.ts` and is then refused as absolute —
 * a refusal produced by the order of three rules rather than by anything wrong
 * with the entry. Collapsing first, and looping until nothing changes, makes the
 * result independent of the order the rules are written in, and leaves every
 * case R28 names identical: `./src/a.ts` → `src/a.ts`, `src//a.ts` →
 * `src/a.ts`, `./././a.ts` → `a.ts`. `../x` is untouched by all three: the
 * leading strip matches a `.` segment (`^./`) and the interior rule matches
 * `/./`, never a `..` one — `/../` contains no `/./` substring — so `..` still
 * reaches the refusal below.
 *
 * THE INTERIOR `/./` RULE IS ROUND 214 FINDING 3, and it retires the "WHAT IS
 * *NOT* REFUSED" paragraph that used to stand below (retire a rule and the
 * clause that documents it in one commit). That paragraph reasoned that
 * `src/./a.ts` is "harmless under exact-equality contention — it conflicts only
 * with an identical spelling". That reasoning was exactly backwards. R16/R17
 * judge contention BY EXACT STRING EQUALITY, so two builders in the SAME
 * workstream declaring `src/a.ts` and `src/./a.ts` did not conflict, were both
 * claimable in one round, and landed in ONE worktree writing ONE file —
 * 03-quality.md §6's "contention belt too loose → two agents clobbering in one
 * worktree", which is the failure this belt exists to prevent. Measured before
 * the fix: `conflicts(["src/a.ts"], ["src/./a.ts"]) === false`. Phase 4's
 * worktree isolation rests on this function being canonical, so canonical is
 * what it now is. The fixpoint loop is what makes it complete rather than
 * one-deep: `src/././a.ts` needs two passes, and it gets them.
 *
 * WHAT IS STILL NOT REFUSED, recorded rather than left for a reader to
 * discover: a bare `.`, and a TRAILING `.` segment (`src/.`), because neither
 * contains the `/./` the interior rule matches and neither is a leading `./`.
 * Both are nonsense a planner would have to type deliberately, and — unlike the
 * interior case — neither is a second spelling of a path any sane planner would
 * also write plainly: `src/.` names a directory, not a file, and R28 already
 * refuses directories that end in `/`. They are two spellings of nothing.
 *
 * A TRAILING SLASH IS REFUSED — the decision R28 leaves open, taken here. A
 * `write_set` entry names a FILE. `conflicts()` already records why declaring a
 * directory is out of scope: prefix semantics would let a task declare `src/`
 * and serialize the project by accident. The two alternatives were worse.
 * Stripping the slash silently turns `src/` into `src`, a path that exists, that
 * conflicts with nothing under exact equality, and that therefore buys the
 * declarer no protection at all while looking like it did — the opposite number
 * of silent under-parallelism, a silent CLOBBER. Accepting `src/`
 * verbatim leaves the same hole with a slash on the end. Refusing it is the only
 * option that tells the planner the thing it needs to know: declare the files.
 *
 * THE MESSAGE QUOTES THE ENTRY WITH `JSON.stringify`, not raw. R28 asks the
 * refusal to name the entry; two of the entries it refuses are an empty string
 * and one containing a NUL, and a message naming those verbatim names them
 * invisibly — a raw NUL also truncates the message in some log readers. Quoted,
 * `""` and `"a\u0000b"` are legible, and every other entry still appears
 * literally inside the quotes. The normalised form is shown alongside when it
 * differs, so a caller reading the refusal knows which string was judged.
 */
export function normaliseWritePath(raw: string): string {
  let path = raw;
  for (;;) {
    const before = path;
    path = path
      .replace(/\/{2,}/g, "/")
      // Interior `.` segments (round 214 finding 3). A global replace cannot
      // consume `src/././a.ts` in one pass — the second `/./` overlaps the
      // slash the first match already ate — which is exactly why this sits
      // inside the fixpoint loop rather than beside it.
      .replace(/\/\.\//g, "/")
      .replace(/^(?:\.\/)+/, "");
    if (path === before) break;
  }

  const refuse = (why: string): never => {
    const shown = JSON.stringify(raw);
    const also = path === raw ? "" : ` (normalised: ${JSON.stringify(path)})`;
    throw new GraphValidationError(
      `task-graph: normaliseWritePath(): ${why}: ${shown}${also} (R28)`,
    );
  };

  if (path.trim() === "") refuse("a write_set entry must not be empty or whitespace-only");
  if (path.includes("\0")) refuse("a write_set entry must not contain a NUL");
  if (path.startsWith("/")) refuse("a write_set entry must be repo-relative, never absolute");
  // A SEGMENT test, not a substring test. `a..b.ts` is a legal file name and
  // `src/..x/a.ts` is a legal directory; only `..` standing alone between
  // separators escapes the repo, and only that is refused.
  if (path.split("/").includes("..")) {
    refuse("a write_set entry must not contain a '..' path segment");
  }
  if (path.endsWith("/")) {
    refuse("a write_set entry must name a file, not a directory (it ends in '/')");
  }
  if (path.length > 400) {
    refuse(`a write_set entry must be at most 400 characters (this one is ${path.length})`);
  }

  return path;
}

/**
 * R4's workstream regex, and the ONLY copy of it on this side of the wire.
 *
 * Character for character `project_tasks_workstream_chk` in
 * `db/migrations/0043_task_graph.sql`: `CHECK (workstream ~
 * '^[a-z0-9][a-z0-9-]{0,39}$')`. Confirmed by reading that file in round 211;
 * they match. If they ever diverge, the divergence is a FINDING — the database
 * would answer a violation with a constraint error at INSERT time, which is a
 * `500` on a request this validator was supposed to refuse with a `400`.
 *
 * `$` MEANS END-OF-INPUT ON BOTH SIDES, which is the one place the two dialects
 * could have differed silently: JavaScript without the `m` flag anchors `$` at
 * the end of the string (unlike Python, where it also matches before a trailing
 * newline), and POSIX `~` in Postgres does the same. So `"ui\n"` is refused here
 * AND by the CHECK. There is a unit case for it.
 *
 * No `g` flag, so `lastIndex` is never carried between calls and this constant
 * is safe to share.
 */
const WORKSTREAM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Validate a workstream name against R4's regex, `^[a-z0-9][a-z0-9-]{0,39}$`,
 * character for character the same charset the migration's CHECK enforces —
 * the intersection of "safe in a git branch name", "safe in a directory name"
 * and "readable in a Kanban chip" (R28). Throws naming the offender.
 *
 * `GraphValidationError`, not `GraphIntegrityError`: a bad name is the caller's
 * input and is a `400`. Quoted with `JSON.stringify` for the same reason as
 * `normaliseWritePath()` — the empty string is one of the values it refuses.
 */
export function validateWorkstream(raw: string): string {
  if (!WORKSTREAM_RE.test(raw)) {
    throw new GraphValidationError(
      `task-graph: validateWorkstream(): ${JSON.stringify(raw)} is not a legal workstream name; ` +
        `it must match ${WORKSTREAM_RE.source} — character for character the CHECK constraint ` +
        "project_tasks_workstream_chk in db/migrations/0043_task_graph.sql (R28, R4)",
    );
  }
  return raw;
}

/* ------------------------------------------------------------------------- *
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * A corrupt graph: today, a `depends_on` id naming a task that does not exist
 * (R14).
 *
 * Its own class for the same reason `RoleFileParseError` in project-tick.ts is
 * one: the caller must distinguish a corrupt graph from an I/O failure, and a
 * test must be able to assert on the CLASS rather than on message text.
 * Message text is documentation and gets reworded; a class is a contract.
 */
export class GraphIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphIntegrityError";
  }
}

/**
 * REFUSED CALLER INPUT — R24's block overflow, and R28's write paths and
 * workstream names. Added in phase 3 (round 211) and declared in
 * `02-architecture.md` §1.1 in the same commit.
 *
 * Its own class, and not `GraphIntegrityError`, because the route (phase 3)
 * must map the two to different statuses and cannot do that on message text.
 * `GraphIntegrityError` says the graph ALREADY IN THE DATABASE is corrupt (R14):
 * the caller did nothing wrong, nothing they can retype will help, and it is a
 * `500`. This one says the request body is refused: it is a `400` naming the
 * offending value, which is what R24, R27 and R28 each demand. Collapsing them
 * would answer `400` for a corrupt stored graph — blaming the caller for the
 * one failure that is definitely not theirs.
 *
 * Same precedent as `GraphIntegrityError`'s own: `ProjectMetadataError` in
 * `routes/projects.ts` and `RoleFileParseError` in `lib/project-tick.ts`. A test
 * asserts on the CLASS; message text is documentation and gets reworded.
 */
export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}
