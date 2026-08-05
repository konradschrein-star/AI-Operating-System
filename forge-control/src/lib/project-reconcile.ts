/**
 * Reviewer-round consolidation — the pure logic behind the project engine's
 * fix cycles.
 *
 * Context: on the goal engine's first night (2026-08-04) a single round with
 * two reviewers produced two of everything. `reconcileReviewer()` fires once
 * per settled reviewer task with no awareness of its siblings, so two
 * NEEDS_FIXES verdicts each inserted their own `Fix cycle 1` builder and their
 * own re-reviewer, and those chains later forked again into duplicate deploy
 * builders. A PASS was a bare `return`, so whether a PASS or a sibling's
 * NEEDS_FIXES won was tick-arrival luck. See docs/plan/02-architecture.md §1.
 *
 * The cure is to decide once per ROUND instead of once per TASK: wait until
 * every reviewer in the round has settled, then fold their verdicts into a
 * single decision — one fix builder, one re-review, one merged brief carrying
 * every reviewer's feedback verbatim.
 *
 * Everything here is pure and synchronous so it can be tested without a
 * database, a filesystem, or a network. The I/O lives in db/projects.ts and
 * lib/project-tick.ts. The `import type` below is deliberate: a value import
 * would drag the pg pool into the test process.
 */

import type { ProjectStatus } from "../db/projects.ts";

/* ------------------------------------------------------------------------- *
 * Verdicts
 * ------------------------------------------------------------------------- */

/** What a reviewer declared. `null` means "nothing parseable" — never "fine". */
export type Verdict = "PASS" | "NEEDS_FIXES" | null;

/**
 * Matched globally so the LAST declaration wins.
 *
 * This is load-bearing. The engine's original expression (project-tick.ts:295)
 * was the same pattern without `/g`, taking the FIRST match — and reviewers
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

/** One reviewer task in a round, flattened with its run's settlement state. */
export interface ReviewerInput {
  taskId: string;
  title: string;
  fixCycle: number;
  /** Its run status is 'completed'. An unsettled sibling freezes the round. */
  settled: boolean;
  lastText: string | null;
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
      reviewerChainKey: string;
    };

/**
 * Deterministic chain keys for the fix pair of a round.
 *
 * Purely a function of (round, cycle) because the partial unique index
 * `project_tasks (project_id, chain_key) WHERE chain_key IS NOT NULL` is what
 * makes the insert idempotent: a tick that crashes between the transaction
 * commit and the mark-done recomputes the same decision, produces the same two
 * keys, and the conflict guard absorbs the replay. Any nondeterminism here
 * (timestamps, task ids, counters) would reintroduce the duplicate chains this
 * module exists to prevent.
 */
export function chainKeys(
  round: number,
  cycle: number,
): { builder: string; reviewer: string } {
  return {
    builder: `fix:${round}:${cycle}`,
    reviewer: `rereview:${round}:${cycle}`,
  };
}

/**
 * Fold every reviewer of one round into exactly one decision.
 *
 * The rule order is load-bearing and is the whole fix for the duplicate-chain
 * bug:
 *
 *  a. empty group → `wait`. Defensive; acting on nothing is never right.
 *  b. ANY unsettled sibling → `wait`, decided BEFORE any verdict is read. This
 *     is what makes a PASS unable to race a sibling's NEEDS_FIXES: the round
 *     simply has no verdict at all until all of it has landed.
 *  c. ANY unparseable verdict → `block(no_verdict)`. Never guess at a missing
 *     verdict — a swallowed one silently means "ship it".
 *  d. ANY NEEDS_FIXES → one `fix` at `max(fixCycle) + 1`, or `block(max_cycles)`
 *     if the budget is spent.
 *  e. otherwise (all settled, all PASS) → `pass`.
 */
export function consolidateReviewerRound(
  round: number,
  reviewers: ReviewerInput[],
  maxFixCycles: number,
): RoundDecision {
  // (a)
  if (reviewers.length === 0) return { action: "wait" };

  // (b) — before parsing anything.
  if (reviewers.some((r) => !r.settled)) return { action: "wait" };

  // (c)
  const parsed = reviewers.map((r) => ({ ...r, verdict: parseVerdict(r.lastText) }));
  const unparseable = parsed.filter((r) => r.verdict === null);
  if (unparseable.length > 0) {
    return {
      action: "block",
      reason: "no_verdict",
      detail: `no parseable VERDICT line in: ${unparseable.map((r) => r.title).join(", ")}`,
    };
  }

  // (d)
  const needsFixes = parsed.filter((r) => r.verdict === "NEEDS_FIXES");
  if (needsFixes.length > 0) {
    // Max over the WHOLE group, not just the dissenters: a reviewer added by
    // hand at a different fix_cycle must not drag the next cycle backwards
    // onto a chain key that already exists.
    const maxCycle = Math.max(...reviewers.map((r) => r.fixCycle));
    const titles = needsFixes.map((r) => r.title).join(", ");

    if (maxCycle >= maxFixCycles) {
      return {
        action: "block",
        reason: "max_cycles",
        detail: `${maxFixCycles} fix cycles exhausted; reviewers still find issues: ${titles}`,
      };
    }

    const cycle = maxCycle + 1;
    const keys = chainKeys(round, cycle);
    return {
      action: "fix",
      cycle,
      mergedBrief: mergeFeedback(round, cycle, needsFixes),
      builderChainKey: keys.builder,
      reviewerChainKey: keys.reviewer,
    };
  }

  // (e)
  return { action: "pass" };
}

/**
 * Both reviewers' full text must survive into the single fix builder — the
 * consolidation is only safe if nothing is dropped by merging. Sections appear
 * in source order, PASS siblings are omitted, and `lastText` is never
 * truncated: the builder needs the reviewer's actual reasoning, not a summary
 * of it.
 */
function mergeFeedback(
  round: number,
  cycle: number,
  needsFixes: Array<{ title: string; lastText: string | null }>,
): string {
  const header =
    `Reviewer feedback from round ${round} (fix cycle ${cycle}). Address EVERY point ` +
    `below; the re-review will check all of them against your new diff.`;

  const sections = needsFixes.map(
    (r) => `## Feedback from: ${r.title}\n${r.lastText ?? ""}`,
  );

  return `${header}\n\n${sections.join("\n\n")}`;
}

/* ------------------------------------------------------------------------- *
 * Task titles + briefs — data, kept here so they are testable.
 * ------------------------------------------------------------------------- */

export const FIX_TASK_TITLE = (cycle: number) => `Fix cycle ${cycle}`;

export const REREVIEW_TASK_TITLE = (cycle: number) =>
  `Re-review after fix cycle ${cycle}`;

/**
 * The re-reviewer's brief. It carries the merged feedback verbatim because the
 * re-review's only job is to decide whether each ORIGINAL concern is now
 * answered by the new diff — a re-reviewer that only sees the diff re-reviews
 * from scratch and reliably finds a different set of problems, which is how a
 * fix cycle turns into an endless one.
 */
export function rereviewBrief(mergedBrief: string): string {
  return (
    `A builder has just addressed the reviewer feedback below. Re-review the work.\n\n` +
    `Go through EVERY concern in the original feedback one by one and check it against ` +
    `the new diff. For each concern, state explicitly whether it is fixed, partially ` +
    `fixed, or untouched, and cite the file and line that settles it. Do not raise new ` +
    `preferences as blockers — but a genuine regression introduced by the fix IS a ` +
    `blocker.\n\n` +
    `## Original feedback\n${mergedBrief}\n\n` +
    `Close your review with exactly one line, on its own line, as the LAST verdict ` +
    `declaration in your message:\n` +
    `VERDICT: PASS\n` +
    `or\n` +
    `VERDICT: NEEDS_FIXES`
  );
}
