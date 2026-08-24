/**
 * Which tier a fix chain runs on.
 *
 * ## Why this is its own module
 *
 * `createFixChain` takes an optional `tier`, and for a long time the caller in
 * project-tick.ts never passed one. Every fix-cycle builder and re-check row
 * was therefore born `tier: null`, fell past TIER_MODELS, and ran on the
 * DEFAULT engine. Measured over one overnight build: 81 of 213 fleet runs (38%)
 * executed on Claude despite every project being seeded `architect_tier:
 * "gemini"`, which is what Konrad explicitly asked for. Nothing failed, nothing
 * logged, and the ratio only inverted when a watchdog papering over it died.
 *
 * That is the signature of a defect worth a unit test: it is invisible in the
 * output, expensive, and it was reintroduced once already.
 *
 * ## Why `rows.find(...)` was not good enough
 *
 * The first fix read `rows.find((r) => r.tier != null)?.tier`. With rows that
 * all share a tier — the normal case — that is correct. With MIXED tiers it
 * returns whichever non-null tier the query happened to order first, so the
 * engine a fix chain runs on becomes a function of row ordering. Silent, and
 * arbitrary rather than wrong-looking.
 *
 * This picks the most common non-null tier instead, breaking ties toward the
 * tier that appears earliest — a rule that is at least stable and stateable.
 * Mixed tiers stay rare; the point is that when they happen the answer does not
 * depend on an ORDER BY nobody thought about.
 */

import type { TaskTier } from "../db/projects";

/** Just enough of a task row to decide. */
export interface TierBearing {
  tier: TaskTier | null;
}

/**
 * The tier a fix chain should inherit from the tasks it is fixing.
 *
 * Returns `undefined` — not `null` — when there is nothing to inherit, because
 * that is what `createFixChain`'s optional `tier` expects for "unset"; passing
 * `null` would write an explicit null and defeat any default underneath it.
 */
export function inheritTier(rows: readonly TierBearing[]): TaskTier | undefined {
  const counts = new Map<TaskTier, number>();
  for (const r of rows) {
    if (r.tier == null) continue;
    counts.set(r.tier, (counts.get(r.tier) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;

  let best: TaskTier | undefined;
  let bestCount = 0;
  // Map preserves insertion order, which is first-appearance order, so the
  // strict `>` makes the earliest of a tied pair win.
  for (const [tier, n] of counts) {
    if (n > bestCount) {
      best = tier;
      bestCount = n;
    }
  }
  return best;
}
