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
 * PHASE 1 STATE — this module is deliberately incomplete. `legacyRoundReady()`
 * and `GraphIntegrityError` are real; every other export is a stub that
 * THROWS. A stub returning a plausible default (`graphReady` → `false`) would
 * let phase 2's replay test pass for the wrong reason, so there are none.
 * Every message is prefixed `task-graph: ` and names its function and its
 * requirement id. See docs/plan/engine-task-graph/04-phases.md §10 for which
 * phase fills which stub.
 */

import type { TaskStatus } from "../db/projects.ts";

/* ------------------------------------------------------------------------- *
 * The row, as the scheduler sees it
 * ------------------------------------------------------------------------- */

/**
 * `project_tasks.depends_on`, whose NULL is the entire migration strategy
 * (`02-architecture.md` §2.2, settled as E1 in §9.1).
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
 *  - `p.status = 'active'` (E7 / R8 / R13) is the CALLER's gate. It lives on
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
 */
export function graphReady(task: GraphTask, byId: ReadonlyMap<string, GraphTask>): boolean {
  throw new Error("task-graph: graphReady() lands in phase 2 (R11, R14)");
}

/**
 * Which rule applies to this row — the ONLY place the `depends_on` NULL
 * sentinel is interpreted (R12). `null` → `"legacy"`; `[]` and any populated
 * array → `"graph"`. TODO(R12-retire)
 */
export function readyRule(task: GraphTask): "graph" | "legacy" {
  throw new Error("task-graph: readyRule() lands in phase 2 (R12)");
}

/* ------------------------------------------------------------------------- *
 * Depth and round
 * ------------------------------------------------------------------------- */

/**
 * Longest path from the roots, for every task, in one pass over a topological
 * order (R19). TOTAL by construction: a row whose `depends_on` is NULL
 * contributes its own `round` as its depth, so a project holding both kinds of
 * row still renders. Display only — never written to the database.
 */
export function taskDepth(all: readonly GraphTask[]): Map<string, number> {
  throw new Error("task-graph: taskDepth() lands in phase 2 (R19)");
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
  throw new Error("task-graph: conflicts() lands in phase 2 (R16, R17)");
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
 */
export function selectClaimable(
  ready: readonly GraphTask[],
  running: readonly GraphTask[],
): GraphTask[] {
  throw new Error("task-graph: selectClaimable() lands in phase 2 (R16)");
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
