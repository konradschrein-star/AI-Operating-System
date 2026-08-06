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
 * Everything here is pure and synchronous so it can be tested without a
 * database, a filesystem, or a network. The I/O lives in db/projects.ts and
 * lib/project-tick.ts. The `import type` below is deliberate: a value import
 * would drag the pg pool into the test process.
 */

import type { ProjectStatus, TaskRole, TaskStatus } from "../db/projects.ts";
import type { RunStatus } from "../db/runs.ts";

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
  /** Its run status is 'completed'. An unsettled sibling freezes the round. */
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
 */
export function chainKeys(
  round: number,
  cycle: number,
): Record<VerdictRole, string> & { builder: string } {
  return {
    builder: `fix:${round}:${cycle}`,
    reviewer: `rereview:${round}:${cycle}`,
    tester: `retest:${round}:${cycle}`,
  };
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
 */
export function consolidateVerdictRound(
  round: number,
  checks: VerdictInput[],
  maxFixCycles: number,
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
    const keys = chainKeys(round, cycle);
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
 * Task titles + briefs — data, kept here so they are testable.
 * ------------------------------------------------------------------------- */

export const FIX_TASK_TITLE = (cycle: number) => `Fix cycle ${cycle}`;

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
 */
export const RECHECK_TASK_TITLE = (role: VerdictRole, cycle: number): string =>
  role === "reviewer"
    ? `Re-review after fix cycle ${cycle}`
    : `Re-test after fix cycle ${cycle}`;

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
