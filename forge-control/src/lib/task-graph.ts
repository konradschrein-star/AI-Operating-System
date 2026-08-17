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
 * PHASE 2 STATE — this module is still deliberately incomplete, and the list
 * below is maintained rather than left to rot.
 *
 *  REAL: `legacyRoundReady()` and `GraphIntegrityError` (phase 1); `readyRule()`
 *  (R12), `graphReady()` (R11, R14, R69), `taskDepth()` (R19), `conflicts()`
 *  (R16, R17) and `selectClaimable()` (R16) — phase 2A.
 *
 *  STILL STUBS THAT THROW: `computeRound()` (R23) and `findCycle()` (R25, R26)
 *  land in phase 3 with `normaliseWritePath()` and `validateWorkstream()` (R28);
 *  `groupKey()` (R40) lands in phase 4. Requirement ids are authoritative over
 *  any prose enumeration of phases (round 102), and `04-phases.md` §10 is the
 *  map. Their throwing is not a defect.
 *
 * A stub returning a plausible default (`graphReady` → `false`) would let the
 * replay test pass for the wrong reason, so there are none. Every message is
 * prefixed `task-graph: ` and names its function and its requirement id.
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
 * Throws `GraphIntegrityError` on a dangling dep — an id absent from `byId`
 * (R14). Never `false`, never `true`: a vanished dependency reading as
 * satisfied is the silent-fallback shape this fleet forbids, and a task stuck
 * at `pending` forever is the failure this project exists to end.
 *
 * AND THE LEGACY-ROW TERM (R69). `depends_on` is a FROZEN closure: the backfill
 * (R6) writes the ids of the rows that existed AT MIGRATION TIME, and 0040 is
 * applied before the executor restarts (R64), so the old engine keeps inserting
 * rows — `createFixChain` at `round + 1` and `round + 2` — in the gap. Those
 * rows are born `depends_on IS NULL` (E2, §2.2) and NO frozen closure names
 * them. Without a second term a frozen row promotes the moment its frozen deps
 * drain, straight past a fix chain numbered far below it; today's engine holds
 * it. So a graph row is ALSO not ready while any LEGACY row of the same project
 * in a strictly lower round is not `done`:
 *
 *     ready = every dep is done
 *             AND NOT ∃ l ∈ byId : l.depends_on === null
 *                                  ∧ l.round < task.round
 *                                  ∧ l.status !== 'done'
 *
 * On a project planned entirely after the restart the term is free — no row has
 * a NULL `depends_on`, so it is vacuously true and `round` is never consulted.
 * It costs something only where it must: a project that straddles the deploy.
 * `02-architecture.md` §3.2 and §9.2 (E3) carry the ruling and the two
 * alternatives it was chosen over; `F13` in §6 is the failure it closes; R18
 * case (f) in `task-graph-replay.test.ts` is the test that fails without it.
 *
 * This is the ONE place a graph-branch predicate reads `round`, and it reads it
 * only about legacy rows. It is part of the legacy surface, not of the graph:
 * it is deleted in the same commit as `readyRule()` and R12's legacy branch,
 * when no `depends_on IS NULL` row remains. TODO(R12-retire)
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
 *   2. a dep id absent from `byId` → THROW (R14). Integrity beats scheduling, so
 *      it precedes both remaining terms; never `false`, never `true`.
 *   3. every dep `done`         → otherwise `false`
 *   4. the legacy-row term (R69) → otherwise `false`
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

  // 2. R14 — dangling first. Report EVERY missing id, not just the first one:
  //    the operator fixing a corrupt graph needs the whole list, and F1's
  //    notification quotes this message.
  const missing = deps.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new GraphIntegrityError(
      `task-graph: graphReady(): task ${task.id} names ${missing.length} ` +
        `dependenc${missing.length === 1 ? "y" : "ies"} that no longer exist: ` +
        `${missing.join(", ")} (R14)`,
    );
  }

  // 3. R11 — every dep done. An empty array is trivially satisfied.
  for (const id of deps) {
    // Non-null by step 2: every id was just proved present.
    if (byId.get(id)!.status !== "done") return false;
  }

  // 4. R69 — the legacy-row term (E3, §9.2; F13). The sentinel test comes FIRST
  //    in the conjunction, so on a project with no legacy row left `round` is
  //    never consulted at all and the term costs nothing. TODO(R12-retire)
  for (const legacy of byId.values()) {
    if (legacy.depends_on !== null) continue;
    if (legacy.round < task.round && legacy.status !== "done") return false;
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
 *  - A DUPLICATE dep id inside one `depends_on` is one edge, not two.
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
 */
export function computeRound(deps: readonly GraphTask[]): number {
  throw new Error("task-graph: computeRound() lands in phase 3 (R23)");
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
 */
export function findCycle(
  candidate: { id: string; depends_on: string[] },
  byId: ReadonlyMap<string, { id: string; title: string; depends_on: DepsField }>,
): Array<{ id: string; title: string }> | null {
  throw new Error("task-graph: findCycle() lands in phase 3 (R25, R26)");
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
 * and runs in parallel — and it is what keeps R18's replica exact, because the
 * replay fixture's rows all carry empty write-sets.
 */
export function conflicts(a: readonly string[], b: readonly string[]): boolean {
  // R17, stated before anything else because it is the clause that keeps the
  // replica exact: the replay fixture's every row has an empty write-set, and an
  // empty set that conflicted would serialize the whole fixture and diverge on
  // tick 1. The loop below would already return false here; the early exit is
  // the requirement made visible.
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
 * Grouping and validation
 * ------------------------------------------------------------------------- */

/**
 * The consolidation group key (R40). Two reviewers of different workstreams
 * that happen to land on the same computed round are two groups, not one: a
 * single merged fix builder could only live in one worktree and would silently
 * drop the other workstream's findings.
 */
export function groupKey(t: Pick<GraphTask, "round" | "workstream">): string {
  throw new Error("task-graph: groupKey() lands in phase 4 (R40)");
}

/**
 * Normalise and validate one `write_set` entry (R28): repo-relative POSIX,
 * non-empty, no leading `/`, no `..` segment, no NUL, at most 400 characters,
 * with `./` stripped and duplicate slashes collapsed. Throws naming the
 * offending entry — never a warning, never a silent drop.
 */
export function normaliseWritePath(raw: string): string {
  throw new Error("task-graph: normaliseWritePath() lands in phase 3 (R28)");
}

/**
 * Validate a workstream name against R4's regex, `^[a-z0-9][a-z0-9-]{0,39}$`,
 * character for character the same charset the migration's CHECK enforces —
 * the intersection of "safe in a git branch name", "safe in a directory name"
 * and "readable in a Kanban chip" (R28). Throws naming the offender.
 */
export function validateWorkstream(raw: string): string {
  throw new Error("task-graph: validateWorkstream() lands in phase 3 (R28)");
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
