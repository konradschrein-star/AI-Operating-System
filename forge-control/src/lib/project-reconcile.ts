/**
 * Verdict-round consolidation — the pure logic behind the project engine's
 * fix cycles.
 *
 * Context: on the goal engine's first night (2026-08-04) a single round with
 * two reviewers produced two of everything. The engine's `reconcileReviewer()`
 * — replaced by this module and `consolidateVerdictGroup()`, and gone from
 * the tree since R308 — fired once per settled reviewer task with no awareness
 * of its siblings, so two NEEDS_FIXES verdicts each inserted their own
 * `Fix cycle 1` builder and their own re-reviewer, and those chains later
 * forked again into duplicate deploy builders. A PASS was a bare `return`, so
 * whether a PASS or a sibling's NEEDS_FIXES won was tick-arrival luck. See
 * docs/plan/02-architecture.md §1.
 *
 * The cure is to decide once per ROUND instead of once per TASK: wait until
 * every gating task in the round has settled, then fold their verdicts into a
 * single decision — one fix builder, one re-check per dissenting role, one
 * merged brief carrying every dissenter's feedback verbatim.
 *
 * R850 widened the unit from "reviewers" to VERDICT ROLES. The tester role
 * (agents/tester.md — customer-perspective QA) closes with the same
 * `VERDICT: PASS / NEEDS_FIXES` contract, but reconciliation parsed verdicts
 * only for role='reviewer', so a tester's NEEDS_FIXES was marked done and the
 * round moved on — the same silent-approval failure as an unparsed verdict,
 * only quieter. Reviewer and tester of one round are now ONE group: they gate
 * together, they merge into one brief, and they yield at most one fix builder.
 * Two groups would have re-created bug 1 with extra steps (two fix builders in
 * the same round, in the same worktree, from two half-briefs).
 *
 * R40 (phase 4) widened the unit a second time, and this time SIDEWAYS rather
 * than by role: the group is `(project_id, round, workstream)`. Verdict tasks
 * depending on the same predecessor set receive the same computed round by
 * construction (`1 + max(dep.round)`, task-graph.ts's `computeRound`), so the
 * round IS the dependency join — and the workstream term separates two teams
 * that happen to sit at the same depth. Without it, two reviewers of different
 * workstreams would consolidate as ONE group and produce ONE merged fix
 * builder, which can only live in one worktree; the other workstream's
 * findings would be delivered nowhere. That is a dropped verdict, the exact
 * silent outcome this module exists to prevent. See
 * docs/plan/engine-task-graph/02-architecture.md §5.
 *
 * Everything here is pure and synchronous so it can be tested without a
 * database, a filesystem, or a network. The I/O lives in db/projects.ts and
 * lib/project-tick.ts. The `import type` below is deliberate: a value import
 * would drag the pg pool into the test process.
 */

import type { ProjectStatus, TaskRole, TaskStatus } from "../db/projects.ts";
import type { RunStatus } from "../db/runs.ts";
import type { GraphTask } from "./task-graph.ts";

/* ------------------------------------------------------------------------- *
 * Verdict roles
 * ------------------------------------------------------------------------- */

/**
 * The roles whose final message ends in a VERDICT line and therefore gate a
 * round: the reviewer (reads the diff) and the tester (uses the product like a
 * customer). Both role files end with the identical contract, so both must be
 * parsed, consolidated and capped identically.
 *
 * ORDER IS PART OF THE CONTRACT: it fixes the order of the re-check tasks a
 * fix cycle spawns, which keeps a replayed consolidation byte-identical to the
 * first attempt. Reviewer first because the diff is what a fix changes.
 *
 * A role NOT in this list keeps the per-task path in project-tick.ts —
 * settled means done, no verdict is read. Adding a role here without giving
 * its role file the VERDICT contract would block every round it sits in
 * (`no_verdict`), which is the safe direction to fail.
 */
export const VERDICT_ROLES = ["reviewer", "tester"] as const;

export type VerdictRole = (typeof VERDICT_ROLES)[number];

/** Narrowing predicate over the DB's role enum — the single gate that decides
 *  whether a settled task is reconciled per-task or deferred to its round. */
export function isVerdictRole(role: TaskRole): role is VerdictRole {
  return (VERDICT_ROLES as readonly string[]).includes(role);
}

/* ------------------------------------------------------------------------- *
 * The group (R40)
 * ------------------------------------------------------------------------- */

/**
 * The workstream every task carries until a planner says otherwise — the
 * schema default (`workstream text NOT NULL DEFAULT 'main'`, migration 0040)
 * and the value every row written before that migration has.
 *
 * It is a NAMED CONSTANT rather than a bare literal because three unrelated
 * rules key on "is this the default workstream?": `chainKeys`'s byte-identical
 * historical form (R41), the notification's byte-identical historical text
 * (R45), and the log label. A future rename would have to move all three
 * together, and a literal in three places is how two of them get missed.
 */
export const MAIN_WORKSTREAM = "main";

/**
 * The consolidation group key (R40) — the ONE place `(round, workstream)` is
 * formatted as a string, so a map key and a log line can never drift apart.
 *
 * WHY IT LIVES HERE AND NOT IN `task-graph.ts`. `02-architecture.md` §1.1
 * exported it from the graph module; that export is RETIRED in the same commit
 * as this function is written (standing rule 4), because it had no graph-side
 * caller and never could have: the group key is a consolidation concern, and
 * every one of its three terms is already in `project-reconcile.ts`'s hand.
 * Exporting it from `task-graph.ts` bought a cross-module dependency and a stub
 * nobody was assigned to fill — round 102's finding, ruled on by the round-221
 * planner after re-checking for a graph-side consumer and finding none.
 *
 * THE FORMAT IS INJECTIVE, and that is a property rather than a hope. `:` can
 * appear in NEITHER term: `round` is an `int4` (digits and, in principle, a
 * leading `-`), and `workstream` is constrained to `^[a-z0-9][a-z0-9-]{0,39}$`
 * by `project_tasks_workstream_chk` (migration 0040) and by
 * `validateWorkstream()` on this side of the wire. The first `:` therefore
 * always splits the tuple back apart, so a workstream named after a number
 * (`groupKey({round: 1, workstream: "2"})` → `"1:2"`) cannot collide with any
 * other pair, and `main` is not privileged in the encoding at all.
 *
 * The PROJECT id is deliberately NOT part of it. Callers hold groups from one
 * project at a time and prefix the id themselves where a map spans projects
 * (project-tick.ts's `verdictRounds`), exactly as they did when the key was
 * `${project_id}:${round}`.
 */
export function groupKey(t: Pick<GraphTask, "round" | "workstream">): string {
  return `${t.round}:${t.workstream}`;
}

/**
 * How a group is named to a human — in a log line, and (via
 * `groupCompleteNotification`) on Konrad's phone.
 *
 * `main` reads exactly as a round always did, so every log line and every push
 * about a single-workstream project is byte-identical to the one it replaced;
 * only a project that actually has a second workstream pays the extra words.
 * That is the same argument the `main` special case in `chainKeys` rests on,
 * applied to prose instead of to a key.
 */
export function groupLabel(round: number, workstream: string): string {
  return workstream === MAIN_WORKSTREAM
    ? `round ${round}`
    : `round ${round} · workstream ${workstream}`;
}

/**
 * The `🏁` push a group's LAST task fires (R45).
 *
 * Byte-identical to the historical text for `main` — "🏁 <name> · round N
 * complete." — because a notification is a string Konrad reads at 3am and
 * there is no reason for a single-workstream project's messages to change at
 * all. A named workstream says so, or two teams draining at the same depth
 * would send two identical-looking messages.
 */
export function groupCompleteNotification(
  projectName: string,
  round: number,
  workstream: string,
): string {
  return `🏁 ${projectName} · ${groupLabel(round, workstream)} complete.`;
}

/**
 * R46 — which failed GROUP an operator's `/unwedge` retries.
 *
 * Ordered by round, then by workstream name, and the earliest one wins. The
 * round term is the old rule verbatim (retry the blocker, not the work queued
 * behind it); the workstream term is the new half: unwedging must restart ONE
 * team, because two workstreams retried at once put two builders back into two
 * worktrees on the strength of a single operator keystroke, and the second one
 * is invisible in the response.
 *
 * Pure and total over its input so it is testable without a database (R46's
 * "unit over the pure selection helper"): the caller does the `SELECT DISTINCT`
 * and hands the pairs over. `null` for an empty list — nothing failed, nothing
 * to unwedge — which the caller already reports as `round: null`.
 *
 * `localeCompare` is deliberately NOT used: it is locale-dependent, and the
 * selection an operator gets must not vary with the process's environment.
 * The charset is `[a-z0-9-]`, so a plain `<` is a total order on it.
 */
export function earliestFailedGroup(
  groups: ReadonlyArray<{ round: number; workstream: string }>,
): { round: number; workstream: string } | null {
  let best: { round: number; workstream: string } | null = null;
  for (const g of groups) {
    if (
      best === null ||
      g.round < best.round ||
      (g.round === best.round && g.workstream < best.workstream)
    ) {
      best = { round: g.round, workstream: g.workstream };
    }
  }
  return best;
}

/* ------------------------------------------------------------------------- *
 * Settlement
 * ------------------------------------------------------------------------- */

/** One gating task as the settlement rule sees it — task row plus the two
 *  columns of its run that decide whether its verdict is final. */
export interface VerdictMemberState {
  /** The TASK's status. 'done' means an earlier tick already consumed it. */
  taskStatus: TaskStatus;
  /** The RUN's current status. `null` when the task has no run yet. */
  runStatus: RunStatus | null;
  /** `metadata.pending_input` — the run owes a turn nobody has delivered. */
  pendingInput: boolean;
}

/**
 * Is this member's verdict final enough to decide its round on?
 *
 * The single definition of "settled", extracted from project-tick's inline
 * mapping by R1005 so it can be tested exhaustively and so db/projects.ts's two
 * SQL predicates have something to be the mirror OF. Three layers read it —
 * the decision (consolidateVerdictRound), the pre-check (unsettledVerdictTasks)
 * and the commit (markVerdictTaskDone) — and any disagreement between them is
 * either a partially-closed round or a permanently-wedged one.
 *
 *  - task 'done' → SETTLED, unconditionally. Its verdict was consumed by an
 *    earlier tick's bookkeeping and lives in the round's history; the run is
 *    then free to be resumed, stopped, or to fail, and none of that may
 *    re-open a question already answered. Judging a 'done' member by its run's
 *    CURRENT status was R1005 finding 2: a partially-refused markGroupDone
 *    (R906's documented mixed state) leaves one member 'done' and one
 *    'running'; a `/message` or `/resume-chat` to the done member's run
 *    followed by a failed/paused turn then made it report unsettled forever,
 *    the round returned `wait` on every tick, and — because a 'done' task is
 *    invisible to listSettledRunningTasks — no per-task failure path could ever
 *    fire. Project 'active', one task 'running' forever, no notification, and a
 *    heartbeat that reads it as work in progress.
 *
 *    The accepted trade-off: a resumed 'done' member's NEW last message
 *    re-enters parseVerdict on any re-consolidation of its round, so a reply
 *    that does not restate `VERDICT:` yields block(no_verdict). That is loud,
 *    pushed, and recoverable with /unwedge — which C20 prefers over a silent
 *    wedge. CP3's MANAGER COMMS block closes it at the prompt level by telling
 *    verdict roles to restate their verdict line (docs/plan/09, finding F3).
 *
 *  - run 'completed' AND no pending input → SETTLED. `completed` alone is not
 *    enough: completeRun's E1/E2 handshake can strand a row as `completed`
 *    with an undelivered message (R1005 finding 1), and deciding there buries
 *    the revised verdict in a task nothing reads again.
 *
 *  - everything else → NOT settled. No run yet (`null`), still running, or
 *    failed/cancelled/stuck/paused: the per-task path in project-tick.ts owns
 *    the failure cases and the group must wait rather than fold a broken round
 *    into a verdict it cannot honestly compute.
 */
export function verdictMemberSettled(m: VerdictMemberState): boolean {
  if (m.taskStatus === "done") return true;
  return m.runStatus === "completed" && !m.pendingInput;
}

/* ------------------------------------------------------------------------- *
 * Verdicts
 * ------------------------------------------------------------------------- */

/** What a gating task declared. `null` means "nothing parseable" — never
 *  "fine". */
export type Verdict = "PASS" | "NEEDS_FIXES" | null;

/**
 * Matched globally so the LAST declaration wins.
 *
 * This is load-bearing. The engine's original expression (the `/VERDICT:\s*
 * (PASS|NEEDS_FIXES)/i` in the deleted `reconcileReviewer()`) was the same
 * pattern without `/g`, taking the FIRST match — and reviewers
 * routinely quote the required format while reasoning ("I will answer with
 * VERDICT: NEEDS_FIXES if ...") before declaring at the end. First-match
 * parsing therefore read the rehearsal instead of the verdict. The declaration
 * is also frequently inline inside markup (`**VERDICT: PASS**`), which is why
 * this scans the whole text rather than looking for a line of its own.
 */
const VERDICT_RE = /VERDICT:\s*(PASS|NEEDS_FIXES)/gi;

export function parseVerdict(text: string | null): Verdict {
  if (!text) return null;

  let last: string | null = null;
  // Fresh lastIndex per call — a module-level /g regex is stateful.
  VERDICT_RE.lastIndex = 0;
  for (const m of text.matchAll(VERDICT_RE)) {
    last = m[1]!;
  }
  if (last === null) return null;

  // The capture group admits exactly two words; narrowed by comparison rather
  // than by a cast so the type is proved, not asserted.
  return last.toUpperCase() === "PASS" ? "PASS" : "NEEDS_FIXES";
}

/* ------------------------------------------------------------------------- *
 * Project-status gating
 * ------------------------------------------------------------------------- */

/**
 * Only an `active` project may have new work promoted, claimed, or spawned.
 *
 * The other four statuses — paused, done, blocked, cancelled — all mean "stop
 * spending", and the first night proved the point: blocked projects kept
 * spawning the remainder of their rounds because promotion never looked at the
 * project row at all. Written as an equality rather than a deny-list so a
 * sixth status added later defaults to "no work", not to "work".
 */
export function projectAcceptsWork(status: ProjectStatus): boolean {
  return status === "active";
}

/* ------------------------------------------------------------------------- *
 * Repeated-failure escalation
 * ------------------------------------------------------------------------- */

/**
 * Consolidating a round can throw — a schema drift (`chain_key` missing
 * because migration 0039 has not been applied yet), a dead pool, a constraint
 * nobody anticipated. The per-group `catch` in project-tick.ts must keep the
 * other projects' rounds moving, so it swallows the error and retries on the
 * next tick. Retrying forever with nothing but a `console.error` is the
 * silent-stall shape the plan's N3 forbids: the project freezes, the log grows
 * at one line per 10s, and Konrad is told nothing.
 *
 * So: count consecutive failures per group and escalate ONCE at the threshold.
 * Pure and Map-based rather than a module global so the escalation rule is
 * testable without a tick, a DB, or a clock.
 *
 * `notify` is true only on the exact crossing (`count === threshold`), not on
 * every failure past it — one actionable message beats a notification storm
 * from a group that will keep failing until a human intervenes.
 */
export function noteGroupFailure(
  counters: Map<string, number>,
  key: string,
  threshold: number,
): { count: number; notify: boolean } {
  const count = (counters.get(key) ?? 0) + 1;
  counters.set(key, count);
  return { count, notify: count === threshold };
}

/**
 * A group that consolidates cleanly starts over: the counter tracks
 * CONSECUTIVE failures, so a transient error followed by a success must not
 * accumulate toward the threshold weeks later. Deleting rather than zeroing
 * also keeps the map from retaining an entry per round the engine has ever
 * run.
 */
export function clearGroupFailures(counters: Map<string, number>, key: string): void {
  counters.delete(key);
}

/* ------------------------------------------------------------------------- *
 * Round consolidation
 * ------------------------------------------------------------------------- */

/** One gating task (reviewer or tester) in a round, flattened with its run's
 *  settlement state. */
export interface VerdictInput {
  taskId: string;
  /** Which contract this row speaks — it selects the re-check role and chain
   *  key when this task dissents, and labels its section of the merged brief. */
  role: VerdictRole;
  title: string;
  fixCycle: number;
  /** verdictMemberSettled(): 'done' by bookkeeping, or a 'completed' run owing
   *  no turn. An unsettled sibling freezes the round. */
  settled: boolean;
  lastText: string | null;
}

/** One re-check task a fix cycle must spawn, and the chain key that makes its
 *  insert idempotent. One entry per DISSENTING role — never per dissenting
 *  task, or two unhappy reviewers would again fork the chain. */
export interface CheckerChain {
  role: VerdictRole;
  chainKey: string;
}

export type RoundDecision =
  | { action: "wait" }
  | { action: "pass" }
  | { action: "block"; reason: "no_verdict" | "max_cycles"; detail: string }
  | {
      action: "fix";
      cycle: number;
      mergedBrief: string;
      builderChainKey: string;
      /** Non-empty, ordered by VERDICT_ROLES, at most one entry per role. */
      checkers: CheckerChain[];
    };

/**
 * Deterministic chain keys for the fix chain of a round.
 *
 * Purely a function of (round, cycle) because the partial unique index
 * `project_tasks (project_id, chain_key) WHERE chain_key IS NOT NULL` is what
 * makes the insert idempotent: a tick that crashes between the transaction
 * commit and the mark-done recomputes the same decision, produces the same
 * keys, and the conflict guard absorbs the replay. Any nondeterminism here
 * (timestamps, task ids, counters) would reintroduce the duplicate chains this
 * module exists to prevent.
 *
 * The `reviewer` key keeps its historical `rereview:` prefix rather than being
 * regenerated from the role name: rows written by every engine since 0039 carry
 * it, and changing the string would make a replayed consolidation miss its own
 * chain and insert a second one.
 *
 * ── The workstream namespace (R41, phase 4) ────────────────────────────────
 *
 * `main` KEEPS THE UNPREFIXED FORM, BYTE FOR BYTE, and that is the same
 * argument as the `rereview:` prefix above rather than a new one: every chain
 * row written since migration 0039 carries `fix:<round>:<cycle>`, and a
 * replayed consolidation of one of those rounds must match the row it already
 * wrote — on `chain_key` AND on identity. Namespacing `main` would make the
 * replay miss its own chain and insert a second one, which is the failure this
 * whole module exists to prevent, committed by the fix for it.
 *
 * A NAMED workstream gets `fix:<ws>:<round>:<cycle>`. No historical row can
 * carry one (the column did not exist before 0040 and defaults to `main`), so
 * there is nothing to stay byte-identical to, and the prefix is what keeps two
 * teams at the same computed depth from sharing one chain.
 *
 * THE PARAMETER IS OPTIONAL, defaulting to `MAIN_WORKSTREAM`, for one reason
 * that is not convenience: R43 requires every existing case in
 * `project-reconcile.test.ts` to pass UNMODIFIED, and T9 calls `chainKeys(7, 2)`.
 * A required third parameter would fail typecheck in the very tests that prove
 * this change did not move the historical keys. It is a default-for-omitted and
 * NOT an NF1 fallback-for-invalid — the same distinction `createTask`'s
 * `workstream ?? 'main'` documents in db/projects.ts: nothing is rescued, no
 * error is swallowed, and an INVALID workstream is passed through untouched so
 * it reaches the CHECK constraint loudly. The one production caller
 * (`consolidateVerdictRound`, itself fed by `consolidateVerdictGroup`) always
 * passes the group's workstream explicitly.
 */
export function chainKeys(
  round: number,
  cycle: number,
  workstream: string = MAIN_WORKSTREAM,
): Record<VerdictRole, string> & { builder: string } {
  const ns = workstream === MAIN_WORKSTREAM ? "" : `${workstream}:`;
  return {
    builder: `fix:${ns}${round}:${cycle}`,
    reviewer: `rereview:${ns}${round}:${cycle}`,
    tester: `retest:${ns}${round}:${cycle}`,
  };
}

/* ------------------------------------------------------------------------- *
 * The fix chain's graph fields (R42) and its identity guard (R41)
 * ------------------------------------------------------------------------- */

/** The graph columns one chain row is born with. `depends_on` is absent from
 *  the re-checker's descriptor on purpose: it is `[builder id]`, and the
 *  builder's id only exists after its INSERT, inside `createFixChain`'s
 *  transaction. A descriptor carrying a placeholder id would be a lie this
 *  layer cannot check. */
export interface ChainRowGraph {
  round: number;
  workstream: string;
  write_set: string[];
}

export interface FixChainGraph {
  builder: ChainRowGraph & { depends_on: string[] };
  /** Shared by every re-checker: they differ only in role, title and brief. */
  checker: ChainRowGraph;
}

/**
 * The graph fields `createFixChain` writes on the rows of one fix chain (R42,
 * `02-architecture.md` §5.2).
 *
 * WITHOUT THIS the chain rows are born as graph ROOTS (`depends_on = '{}'`) and
 * `promoteReadyTasks` releases them on the very next tick — the fix builder
 * running in parallel with the work it is meant to follow, and the re-checkers
 * in parallel with the fix. The whole chain would be scheduled backwards.
 *
 *   fix builder    round + 1   depends_on = the GATING task ids   write_set = the FIXED work's union
 *   each checker   round + 2   depends_on = [builder id]          write_set = {}
 *
 * `round + 1` / `round + 2` STAY LITERAL, as §5.2 says, because the group's
 * round is a real stored value — and `1 + max(dep.round)` yields the same two
 * numbers. That agreement is a PROPERTY of the two rules, not a coincidence,
 * so `project-reconcile.test.ts` asserts it against `computeRound()` itself
 * rather than restating the arithmetic.
 *
 * ── `gating` AND `fixing` ARE TWO DIFFERENT SETS (round 970) ────────────────
 *
 * They used to be one parameter, `members`, carrying both the gating task ids
 * and the write-sets — which is how the fix builder came to inherit THE
 * REVIEWER'S declared write_set. A reviewer's write_set is typically its one
 * report file (often nothing at all); the fix builder's job is to change the
 * SOURCE the reviewer criticised. Measured on 2026-08-18: `connections` fix
 * cycle 1 wrote 20 source files, every one of them undeclared by construction,
 * and `vault` fix cycle 1 had the same shape. So EVERY fix cycle looked like a
 * write-set violation to its own re-checker, which teaches a reviewer to wave
 * the violation through — and a genuinely undeclared write then reads exactly
 * like the normal case. `metadata.strict_write_sets` makes an undeclared write
 * a hard 400 for a hand-seeded task while the engine's own chain rows sailed
 * past it.
 *
 *  - `gating` — the verdict tasks of the group. Their ids are the ORDERING
 *    dependency and R41's immutable identity. Unchanged.
 *  - `fixing` — the tasks WHOSE WORK IS BEING FIXED (the builders the gating
 *    tasks depend on; see `priorBuilderWork()` in project-tick.ts). Their
 *    declared write-sets are what the fix builder will actually touch.
 *
 * The two are SEPARATE PARAMETERS rather than one with a fallback, and the old
 * name is deliberately gone: every call site fails to compile rather than
 * silently keeping the old meaning. There is NO fallback to `gating`'s
 * write-sets when `fixing` is empty — an empty declared set a re-checker can
 * SEE is empty is honest, a wrong one is not, and `emptyWriteSetWarning()`
 * already surfaces the empty case on the spawn path. `fixBuilderBrief()` says
 * so in the row's own brief.
 *
 * The builder's `depends_on` is DEDUPED AND SORTED, which does three jobs at
 * once: it makes the row byte-identical across replays of one decision, it
 * makes `duplicatesFixChain()`'s set comparison well-defined, and it is the
 * immutable identity R41's guard leans on (a task id cannot be renumbered; a
 * round can). The write-set union is sorted for the first of those reasons.
 *
 * An empty `gating` list is REFUSED rather than defaulted: a chain whose
 * builder depends on nothing is a root, which is precisely the bug this
 * function exists to prevent, and it would also make R41's guard match every
 * other root-born chain at the same cycle. The decision layer cannot produce
 * one (`consolidateVerdictRound` returns `wait` for an empty group), so
 * reaching this means a caller built the input by hand. An empty `fixing` list
 * is NOT refused: a legacy group whose gating tasks carry the `depends_on`
 * sentinel has no reachable builders, and blocking a real fix cycle over that
 * would strand the feedback — the failure this module exists to prevent.
 */
export function fixChainGraphFields(group: {
  round: number;
  workstream: string;
  gating: ReadonlyArray<{ taskId: string }>;
  fixing: ReadonlyArray<{ writeSet: readonly string[] }>;
}): FixChainGraph {
  if (group.gating.length === 0) {
    throw new Error(
      `fixChainGraphFields: no gating tasks for ${groupLabel(group.round, group.workstream)} — ` +
        "a fix builder with no dependencies is a graph root and would run immediately, " +
        "in parallel with the work it is meant to follow (R42)",
    );
  }
  const depends_on = [...new Set(group.gating.map((m) => m.taskId))].sort();
  const write_set = inheritedWriteSet(group.fixing);
  return {
    builder: { round: group.round + 1, depends_on, workstream: group.workstream, write_set },
    checker: { round: group.round + 2, workstream: group.workstream, write_set: [] },
  };
}

/**
 * The union of the write-sets of the tasks whose work is being fixed — deduped
 * and sorted, so a replayed consolidation writes a byte-identical array.
 *
 * Exported because the brief text and the row must agree about what was
 * inherited: `fixBuilderBrief()` reports the same union this writes, and a
 * second implementation of "union, sorted" is how those two drift apart.
 *
 * Sorted with a plain `<` (via `Array.prototype.sort`'s default string order),
 * NOT `localeCompare`: the row a replay writes must not depend on the process's
 * locale — the same argument `earliestFailedGroup` makes above.
 */
export function inheritedWriteSet(
  fixing: ReadonlyArray<{ writeSet: readonly string[] }>,
): string[] {
  return [...new Set(fixing.flatMap((m) => [...m.writeSet]))].sort();
}

/** Two id lists compared as SETS. Order-free and duplicate-free on both sides.
 *
 *  THERE IS NO SQL COUNTERPART TO THIS, and the earlier version of this comment
 *  claiming one — "the exact mirror of the `cardinality(...) = ... AND @> AND
 *  <@` triple in db/projects.ts's guard SQL" — was false and is retracted
 *  (round 224's gating review; `grep -n "@>\|<@" src/db/projects.ts` returns
 *  nothing, and `cardinality` appears there only in `promoteReadyTasks()`'s R14
 *  term, which is a different rule). The guard SQL in `createFixChain()` only
 *  NARROWS — this project, role `builder`, `chain_key IS NOT NULL`, this fix
 *  cycle, `depends_on IS NOT NULL` — and delegates the whole comparison to
 *  `duplicatesFixChain()` below, which calls this. That is R41's own decision
 *  ("called by db/projects.ts rather than restated in SQL, so there is no
 *  second copy to drift"), and inventing a mirror in a comment is the drift the
 *  decision exists to avoid. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/**
 * R41's HAND-RENUMBER GUARD, and the ONLY definition of it. `createFixChain()`
 * in db/projects.ts calls this from inside its transaction; the SELECT beside
 * the call narrows the candidate rows and decides nothing. This is deliberately
 * NOT the `markVerdictTaskDone` / `verdictMemberSettled` shape — that pair is
 * this module's one genuine SQL mirror, where a term really is written twice
 * and kept in step, and confusing the two would send whoever audits R41 looking
 * for a second copy that does not exist. (An earlier version of this header
 * asserted the analogy; round 224's gating review measured it false — there is
 * no `@>`/`<@` set comparison anywhere in db/projects.ts — and it is retracted.)
 *
 * THE HAZARD (recorded round 204 from phase 2's red team, decided round 221).
 * `chainKeys` embeds `round`. An operator who renumbers a group AFTER its fix
 * chain exists — and one did exactly that to this project's own scout task at
 * ~03:31 on 2026-08-17 — makes the next consolidation compute
 * `fix:<new>:<cycle>`, which collides with NEITHER `project_tasks_chain_key_uniq`
 * (the chain_key differs) NOR `project_tasks_identity_idx` (the round differs).
 * `insertChainRow`'s `INSERT … ON CONFLICT DO NOTHING` therefore SUCCEEDS, a
 * SECOND FIX CHAIN LANDS, and the `occupied` branch never fires because it is
 * only reached on a conflict.
 *
 * THE FIX IS A GUARD, NOT A RE-KEYING, and the choice is forced: R41's replay
 * property forbids changing the chain_key STRING for `main`, so the identity
 * cannot simply be rebased onto the gating ids. What R42 hands over free is the
 * immutable identity itself — the fix builder's `depends_on` IS the gating task
 * ids, and a task id cannot be renumbered (R29). A renumbered group therefore
 * computes a DIFFERENT chain_key over an IDENTICAL `(fix_cycle, depends_on)`
 * pair, and that is what this refuses.
 *
 * WHY A DIFFERENT chain_key IS THE TRIGGER RATHER THAN AN EXEMPTION. A crash
 * between COMMIT and mark-done replays the same decision, which computes the
 * SAME chain_key; that row is our own chain and must be absorbed as a `replay`,
 * not refused. So an existing row carrying our key is explicitly NOT a
 * duplicate — the guard fires only on a stranger with our group's identity.
 *
 * ITS BOUNDARY, stated rather than left to be discovered: a PARTIAL renumber —
 * an operator moving some members of a group and not others — changes the
 * gating set, so this returns false and a second chain lands. That is correct
 * rather than a hole: two disjoint member sets are two different joins, and the
 * engine has no way to tell that apart from a genuine second group.
 */
export function duplicatesFixChain(
  candidate: { cycle: number; chainKey: string; dependsOn: readonly string[] },
  existing: { cycle: number; chainKey: string; dependsOn: readonly string[] },
): boolean {
  if (existing.chainKey === candidate.chainKey) return false;
  if (existing.cycle !== candidate.cycle) return false;
  return sameIdSet(candidate.dependsOn, existing.dependsOn);
}

/**
 * Fold every gating task of one round — reviewers AND testers together — into
 * exactly one decision.
 *
 * The rule order is load-bearing and is the whole fix for the duplicate-chain
 * bug:
 *
 *  a. empty group → `wait`. Defensive; acting on nothing is never right.
 *  b. ANY unsettled sibling → `wait`, decided BEFORE any verdict is read. This
 *     is what makes a PASS unable to race a sibling's NEEDS_FIXES: the round
 *     simply has no verdict at all until all of it has landed. It holds across
 *     roles too — a reviewer's PASS cannot close a round whose tester is still
 *     walking the product.
 *  c. ANY unparseable verdict → `block(no_verdict)`. Never guess at a missing
 *     verdict — a swallowed one silently means "ship it".
 *  d. ANY NEEDS_FIXES → one `fix` at `max(fixCycle) + 1`, or `block(max_cycles)`
 *     if the budget is spent. One builder however many dissenters; one re-check
 *     per dissenting ROLE, because only a tester can confirm a customer-facing
 *     complaint is gone and only a reviewer can confirm the diff is sound.
 *  e. otherwise (all settled, all PASS) → `pass`.
 *
 * R40 RESTATED THE GROUP'S DEFINITION AND NOTHING ELSE. `checks` is now the
 * members of one `(project, round, workstream)` group rather than of one
 * `(project, round)` round, and `workstream` reaches exactly one line of this
 * function — the `chainKeys` call. Rules (a)–(e), their order, and every string
 * they produce are untouched (R44). The parameter is optional and defaults to
 * `MAIN_WORKSTREAM` for R43's reason, spelled out on `chainKeys` above: every
 * existing case in project-reconcile.test.ts calls this with three arguments
 * and must keep passing unmodified.
 */
export function consolidateVerdictRound(
  round: number,
  checks: VerdictInput[],
  maxFixCycles: number,
  workstream: string = MAIN_WORKSTREAM,
): RoundDecision {
  // (a)
  if (checks.length === 0) return { action: "wait" };

  // (b) — before parsing anything.
  if (checks.some((r) => !r.settled)) return { action: "wait" };

  // (c)
  const parsed = checks.map((r) => ({ ...r, verdict: parseVerdict(r.lastText) }));
  const unparseable = parsed.filter((r) => r.verdict === null);
  if (unparseable.length > 0) {
    return {
      action: "block",
      reason: "no_verdict",
      detail: `no parseable VERDICT line in: ${unparseable
        .map((r) => `${r.role} "${r.title}"`)
        .join(", ")}`,
    };
  }

  // (d)
  const needsFixes = parsed.filter((r) => r.verdict === "NEEDS_FIXES");
  if (needsFixes.length > 0) {
    // Max over the WHOLE group, not just the dissenters: a reviewer added by
    // hand at a different fix_cycle must not drag the next cycle backwards
    // onto a chain key that already exists.
    const maxCycle = Math.max(...checks.map((r) => r.fixCycle));
    const titles = needsFixes.map((r) => `${r.role} "${r.title}"`).join(", ");

    if (maxCycle >= maxFixCycles) {
      return {
        action: "block",
        reason: "max_cycles",
        detail: `${maxFixCycles} fix cycles exhausted; still finding issues: ${titles}`,
      };
    }

    const cycle = maxCycle + 1;
    const keys = chainKeys(round, cycle, workstream);
    // Ordered by VERDICT_ROLES and deduped by construction: N dissenting
    // reviewers produce ONE re-review, and a reviewer+tester round produces
    // exactly one of each, always in the same order — which is what keeps a
    // replayed decision byte-identical to the one that already hit the DB.
    const checkers: CheckerChain[] = VERDICT_ROLES.filter((role) =>
      needsFixes.some((r) => r.role === role),
    ).map((role) => ({ role, chainKey: keys[role] }));

    return {
      action: "fix",
      cycle,
      mergedBrief: mergeFeedback(round, cycle, needsFixes),
      builderChainKey: keys.builder,
      checkers,
    };
  }

  // (e)
  return { action: "pass" };
}

/**
 * Every dissenter's full text must survive into the single fix builder — the
 * consolidation is only safe if nothing is dropped by merging. Sections appear
 * in source order, PASS siblings are omitted, and `lastText` is never
 * truncated: the builder needs the actual reasoning, not a summary of it.
 *
 * The heading names the ROLE as well as the task, because a tester's finding
 * ("the empty state shows a raw stack trace") and a reviewer's ("this catch
 * swallows the error") are answered in different places, and a builder reading
 * a flat list of quotes cannot tell which kind it is holding.
 */
function mergeFeedback(
  round: number,
  cycle: number,
  needsFixes: Array<{ role: VerdictRole; title: string; lastText: string | null }>,
): string {
  const roles = [...new Set(needsFixes.map((r) => r.role))].join(" + ");
  const header =
    `Feedback from round ${round}'s ${roles} (fix cycle ${cycle}). Address EVERY point ` +
    `below; the re-check will go through all of them against your new work.`;

  const sections = needsFixes.map(
    (r) => `## Feedback from ${r.role}: ${r.title}\n${r.lastText ?? ""}`,
  );

  return `${header}\n\n${sections.join("\n\n")}`;
}

/* ------------------------------------------------------------------------- *
 * The first carpenter's knowledge — the previous builders' reports (round 970)
 * ------------------------------------------------------------------------- */

/**
 * One task whose work a fix cycle is fixing, as the brief builder sees it.
 *
 * Konrad, round 970: *"using a second worker who doesn't know what the first
 * worker knew is quite unreasonable — as if for each leg of a table you spawn a
 * new carpenter."* `mergeFeedback()` above already carries every dissenting
 * verdict verbatim, so the INSPECTOR's punch-list survives into the fix builder;
 * what did not survive was anything the ORIGINAL builder did, tried, rejected or
 * learned. Measured on 2026-08-18 over 3,899 Bash calls by this fleet's
 * builders: search 25.5% + read-via-shell 24.1% — half of a builder's shell work
 * is re-deriving a map somebody upstream already drew.
 *
 * `report` is the task's FINAL ASSISTANT MESSAGE and nothing else. Not the
 * thread: a builder's thread runs to ~189 entries, and cost per unit of work
 * rises 2.2x with session length ([[Operator Decisions]] § Cost), so a fix
 * builder handed a transcript is worse off than one handed nothing. `null` when
 * the task has no run, or its run has no assistant turn — reported as such
 * rather than dropped, because a silently missing section reads exactly like a
 * builder that never existed.
 *
 * `createdAt` is carried ONLY as a sort key (see `orderPriorWork`) and never
 * printed: it is immutable, so it cannot make a replay diverge, but a timestamp
 * in a brief invites a reader to treat the brief as a log.
 */
export interface PriorWorkReport {
  taskId: string;
  title: string;
  /** The row's immutable `created_at`, as a sortable ISO string. */
  createdAt: string;
  /** The task's declared `write_set` — what the fix builder inherits. */
  writeSet: readonly string[];
  /** The task's LAST assistant message. Never the thread. */
  report: string | null;
}

/**
 * How many characters of prior-work REPORT TEXT one fix builder's brief may
 * carry, shared across every report in it.
 *
 * Chosen rather than derived, and here is the reasoning so the next round can
 * argue with it instead of guessing: a builder's final report in this fleet runs
 * 2–8k characters, a round fans out to 2–5 builders, and the merged brief
 * already carries every dissenting verdict UNTRUNCATED. 24k characters is
 * roughly 6k tokens — about one fifth of what re-deriving the map costs in tool
 * calls, and small beside the transcript this deliberately does not carry.
 *
 * IT IS A BUDGET ON THE CARRIED TEXT, NOT ON THE SECTION. Headings, write-set
 * lines and truncation notices sit outside it, so the number means one thing
 * ("at most this much of what the builders wrote") and the arithmetic in
 * `allocateReportBudget` has no overhead term to get wrong.
 *
 * WHY A FIX CYCLE DOES NOT ACCUMULATE. Cycle 2's re-checkers depend on cycle 1's
 * FIX BUILDER, so `priorBuilderWork()` finds exactly that one row and cycle 2
 * inherits one report — cycle 1's — not the original round's builders as well.
 * The depth is bounded by the graph, not by this constant; this constant bounds
 * the WIDTH of one round's fan-out.
 */
export const PRIOR_WORK_BUDGET = 24_000;

/**
 * The order prior-work sections appear in, and the ONLY thing that decides it:
 * `(createdAt, taskId)` ascending, both immutable columns of the task row.
 *
 * IDEMPOTENCY IS LOAD-BEARING HERE. `mergeFeedback` feeds `createFixChain`,
 * whose safety rests on a replayed consolidation producing a byte-identical
 * brief; ordering by anything that can move between two ticks — arrival order,
 * `updated_at`, a run's status — reintroduces the duplicate-chain bug that once
 * ran an entire project twice. `created_at` is written once at INSERT and never
 * updated, and a task id cannot be renumbered (R29), so the pair is a total
 * order that is fixed for the life of the row. `<` rather than `localeCompare`
 * for the same reason as `earliestFailedGroup`: a locale must not change what a
 * replay writes.
 *
 * Sorted HERE rather than trusted from the caller's `ORDER BY` so the property
 * is a property of this module — the caller's query can be edited by someone
 * who never reads this file.
 */
function orderPriorWork(reports: readonly PriorWorkReport[]): PriorWorkReport[] {
  return [...reports].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    return 0;
  });
}

/**
 * Split `budget` characters across reports of the given lengths, so that no
 * report is cut while another is padded — the classic fair share, and it is
 * worth the ten lines because the common case is one long report beside one
 * short one, where an equal split throws away half the budget.
 *
 * Shortest first: each report takes the lesser of its own length and an equal
 * share of what is LEFT, and whatever a short report does not use is
 * redistributed to the ones still competing. A remainder that does not divide
 * evenly falls to the reports considered later, which is why the tie-break on
 * equal lengths is the ALREADY-ORDERED index rather than anything about the
 * task: the result is then a pure function of (ordered lengths, budget), which
 * is what makes two consolidations of one group byte-identical.
 *
 * Returns one allowance per input position, in input order. A zero budget or an
 * empty list yields all zeroes — no special case, the loop simply allocates
 * nothing.
 */
export function allocateReportBudget(lengths: readonly number[], budget: number): number[] {
  const share = new Array<number>(lengths.length).fill(0);
  const byLength = lengths
    .map((length, index) => ({ length, index }))
    .sort((a, b) => (a.length !== b.length ? a.length - b.length : a.index - b.index));

  let left = budget;
  let competing = byLength.length;
  for (const { length, index } of byLength) {
    const fair = Math.floor(left / competing);
    const take = Math.min(length, Math.max(fair, 0));
    share[index] = take;
    left -= take;
    competing -= 1;
  }
  return share;
}

/**
 * The notice a truncated report carries AT ITS CUT POINT.
 *
 * "Cap it, and say when you truncated" — a truncated report that looks complete
 * is the failure this project has hit five times. So the omission is stated
 * where the text stops, in the units it was measured in, and it names where the
 * full text still is. A fix builder that decides it needs the rest can go and
 * read that run; one that never sees this line assumes it has the whole account
 * and reasons from a half of it.
 *
 * Every number in it is a pure function of the inputs, so it cannot make a
 * replay diverge.
 */
function truncationNotice(kept: number, total: number, taskId: string): string {
  return (
    `\n\n[… TRUNCATED — ${total - kept} of ${total} characters of this report were omitted to ` +
    `fit the ${PRIOR_WORK_BUDGET}-character prior-work budget. The full report is the last ` +
    `assistant message of task ${taskId}'s run; read it only if this excerpt leaves you guessing.]`
  );
}

/** One report's section, cut to its allowance. The heading names the task, the
 *  write-set line is what the fix builder has INHERITED from it, and a missing
 *  report is stated rather than rendered as an empty section. */
function priorWorkEntry(r: PriorWorkReport, allowance: number): string {
  const declared =
    r.writeSet.length > 0 ? [...r.writeSet].sort().join(", ") : "(none declared)";
  const head = `### Previous builder: ${r.title}\nIts declared write-set: ${declared}\n`;

  if (r.report === null) {
    return (
      `${head}(No final report was recorded for this task — its run produced no assistant ` +
      `message, so there is nothing to carry. This is stated rather than omitted: a missing ` +
      `section is indistinguishable from a builder that never ran.)`
    );
  }
  if (r.report.length <= allowance) return `${head}${r.report}`;
  return `${head}${r.report.slice(0, allowance)}${truncationNotice(allowance, r.report.length, r.taskId)}`;
}

/**
 * The fix builder's brief: the merged feedback, then the previous builders'
 * accounts.
 *
 * ORDER IS THE AUTHORITY ORDER. The verdicts come first and are untouched —
 * `mergeFeedback`'s bytes are exactly what they were — and the accounts follow,
 * headed as CONTEXT and explicitly subordinate to the findings. A fix builder
 * that reads its predecessor's confident "this is handled by X" before it reads
 * the reviewer's "X does not fire" will believe the wrong one; a reviewer's
 * finding is evidence about the tree as it stands, a builder's report is a
 * claim about the tree as it was believed to be.
 *
 * THE RE-CHECKERS DO NOT GET THIS. `recheckBrief()` is still fed
 * `RoundDecision.mergedBrief` — the verdicts alone — because a re-checker's job
 * is to decide whether each ORIGINAL concern is now answered, and handing it the
 * builder's own account of its work is handing the defence to the judge. It also
 * keeps every re-check brief byte-identical to the one it replaced.
 *
 * DETERMINISM, stated: the output is a pure function of `(mergedBrief, reports)`
 * with the reports ordered by `(createdAt, taskId)` and each cut by
 * `allocateReportBudget` over the ordered lengths. No clock, no task ordering
 * from the caller, no counter. Task ids appear only inside a truncation notice,
 * and a task id is immutable.
 *
 * An EMPTY report list is not silence: it says so, and it says WHY the row's
 * `write_set` is empty, because "this task writes nothing" and "nothing could be
 * inherited" look identical in a row and mean opposite things.
 */
export function fixBuilderBrief(
  mergedBrief: string,
  reports: readonly PriorWorkReport[],
): string {
  if (reports.length === 0) {
    return (
      `${mergedBrief}\n\n` +
      `## What the previous builders reported — NOTHING COULD BE CARRIED\n` +
      `No builder task was reachable from this round's verdict tasks (they declare no ` +
      `dependencies, or none of their dependencies is a builder), so no previous account ` +
      `could be carried into this brief and NO WRITE-SET COULD BE INHERITED. This task's ` +
      `declared write_set is empty for that reason — not because it writes nothing. Declare ` +
      `what you touch in your final report.`
    );
  }

  const ordered = orderPriorWork(reports);
  const allowances = allocateReportBudget(
    ordered.map((r) => r.report?.length ?? 0),
    PRIOR_WORK_BUDGET,
  );
  const inherited = inheritedWriteSet(ordered);

  const header =
    `## What the previous builders reported — CONTEXT, NOT INSTRUCTION\n` +
    `Below is the FINAL REPORT of each builder whose work this fix cycle is fixing, so you ` +
    `do not have to re-derive the map they already drew — where things live, what was tried, ` +
    `what was rejected and why. It is their account, written BEFORE the review, and it MAY BE ` +
    `WRONG: where it and the feedback above disagree, THE FEEDBACK IS AUTHORITATIVE, and ` +
    `nothing here excuses leaving a finding unaddressed. Verify anything you rely on.\n` +
    `Your declared write_set is the union of their write-sets: ` +
    `${inherited.length > 0 ? inherited.join(", ") : "EMPTY — none of them declared one, so nothing could be inherited"}.`;

  const sections = ordered.map((r, i) => priorWorkEntry(r, allowances[i]!));
  return `${mergedBrief}\n\n${header}\n\n${sections.join("\n\n")}`;
}

/* ------------------------------------------------------------------------- *
 * Task titles + briefs — data, kept here so they are testable.
 * ------------------------------------------------------------------------- */

/**
 * THE WORKSTREAM SUFFIX ON A CHAIN ROW'S TITLE — round 221, and it is R40's
 * missing half rather than decoration.
 *
 * `project_tasks_identity_idx` (migration 0035) is
 * `(project_id, round, role, title)` and has NO workstream term; migration 0040
 * did not add one. So two groups at the same round in two workstreams, each
 * producing a fix builder at `round + 1` titled "Fix cycle 1", present the DB
 * with the SAME identity tuple. `insertChainRow` sees the conflict, correctly
 * classifies the second one `occupied` — a stranger holds our identity — and
 * `consolidateVerdictGroup` BLOCKS THE PROJECT with the second workstream's
 * merged feedback undelivered. That is precisely the dropped verdict R40 exists
 * to prevent, arriving by a different door: namespacing the chain_key alone
 * (R41) makes the two chains distinguishable to the replay guard and still
 * indistinguishable to the identity index.
 *
 * `main` KEEPS ITS TITLES BYTE FOR BYTE, for the same reason `chainKeys` does:
 * every chain row written since 0039 carries the bare form, a replay must match
 * the row it already wrote ON IDENTITY as well as on chain_key, and the
 * reviewer wording in particular is frozen back to pre-R850 chains.
 */
function titleSuffix(workstream: string): string {
  return workstream === MAIN_WORKSTREAM ? "" : ` · ${workstream}`;
}

export const FIX_TASK_TITLE = (cycle: number, workstream: string = MAIN_WORKSTREAM) =>
  `Fix cycle ${cycle}${titleSuffix(workstream)}`;

/**
 * The re-check task's title. Distinct per role — the pair lands in the SAME
 * (project, round) and `project_tasks_identity_idx` is
 * (project_id, round, role, title), so identical titles across two roles are
 * legal in the DB but indistinguishable in the Kanban and in Konrad's
 * notifications, which is its own kind of first-night confusion.
 *
 * The reviewer wording is frozen: pre-R850 chains carry "Re-review after fix
 * cycle N" and a replay must match the row it already wrote on identity, not
 * just on chain_key.
 *
 * Distinct per WORKSTREAM too, since round 221 — see `titleSuffix` above: two
 * workstreams' re-checkers land in the same `round + 2` with the same role and
 * would otherwise collide on the identity index, blocking the project.
 */
export const RECHECK_TASK_TITLE = (
  role: VerdictRole,
  cycle: number,
  workstream: string = MAIN_WORKSTREAM,
): string =>
  role === "reviewer"
    ? `Re-review after fix cycle ${cycle}${titleSuffix(workstream)}`
    : `Re-test after fix cycle ${cycle}${titleSuffix(workstream)}`;

/**
 * The re-checker's brief. It carries the merged feedback verbatim because the
 * re-check's only job is to decide whether each ORIGINAL concern is now
 * answered — a re-checker that only sees the current state starts from scratch
 * and reliably finds a different set of problems, which is how a fix cycle
 * turns into an endless one.
 *
 * The two roles get different instructions for the same reason they are
 * separate roles: a reviewer settles a concern by citing a file and line, a
 * tester settles it by walking the journey again and showing what happened.
 * Telling a tester to "check it against the new diff" would turn it into a
 * second reviewer and lose the only customer-side evidence in the round.
 */
export function recheckBrief(role: VerdictRole, mergedBrief: string): string {
  const opening =
    role === "reviewer"
      ? `A builder has just addressed the feedback below. Re-review the work.\n\n` +
        `Go through EVERY concern in the original feedback one by one and check it against ` +
        `the new diff. For each concern, state explicitly whether it is fixed, partially ` +
        `fixed, or untouched, and cite the file and line that settles it. Do not raise new ` +
        `preferences as blockers — but a genuine regression introduced by the fix IS a ` +
        `blocker.`
      : `A builder has just addressed the feedback below. Re-test the product.\n\n` +
        `Walk the journeys the original findings came from again, as a customer would, and ` +
        `go through EVERY finding one by one. For each, state explicitly whether it is fixed, ` +
        `partially fixed, or untouched, and give the evidence that settles it (what you did, ` +
        `what happened, the screenshot or transcript). Re-check the neighbouring steps too — ` +
        `a fix that breaks an adjacent journey IS a blocker. Do not review the diff; that is ` +
        `the reviewer's job.`;

  return (
    `${opening}\n\n` +
    `## Original feedback\n${mergedBrief}\n\n` +
    `Close with exactly one line, on its own line, as the LAST verdict declaration in your ` +
    `message:\n` +
    `VERDICT: PASS\n` +
    `or\n` +
    `VERDICT: NEEDS_FIXES`
  );
}
