/**
 * THOUGHTS — the pool's pure vocabulary and its two derived readings.
 *
 * No React and no fetch, deliberately: everything here is a total function of
 * an `Idea`, so `pool.test.ts` runs it under `node --test` without a DOM and
 * without a server, exactly as `goals/quick-add.ts` does for the quick-add
 * parser.
 *
 * What is NOT here: sorting. The server owns every view's order (PLAN.md
 * §4.3 — `applyView` in forge-control/src/lib/thoughts.ts) and re-deriving it
 * client-side is how two orderings drift apart. The list renders `ideas[]` in
 * the order it arrived.
 */

import type { Idea, IdeaExecutionStatus, ThoughtArea, ThoughtsView } from "../../api";
import { IDEA_STATUSES, THOUGHT_AREAS } from "../../api";

export const VIEWS: readonly { key: ThoughtsView; label: string; hint: string }[] = [
  {
    key: "unexecuted",
    label: "UNEXECUTED",
    hint: "not started, oldest first — un-executed ideas are of course bullshit",
  },
  { key: "area", label: "BY AREA", hint: "one life area at a time, oldest first" },
  { key: "importance", label: "BY IMPORTANCE", hint: "the whole pool, 10 down to 1" },
  { key: "executed", label: "EXECUTED", hint: "started, executing or done" },
];

/** The five life areas, in Konrad's own order. `relationships` covers friends,
 *  business partners and family — he renamed it from "girlfriend". */
export const AREAS: readonly ThoughtArea[] = THOUGHT_AREAS;

export const STATUSES: readonly IdeaExecutionStatus[] = IDEA_STATUSES;

/** An agent-derived seed, not something Konrad wrote. The badge and the Adopt
 *  button both hang off this, and `author` is the only honest test: the path
 *  moves when the vault split lands (PLAN.md §3.5), the author does not. */
export function isSeed(idea: Idea): boolean {
  return idea.author === "forge";
}

/** Is this idea still un-executed? The UNEXECUTED view's own predicate,
 *  mirrored here only so a row can be shown as still-open outside that view
 *  (BY AREA and BY IMPORTANCE return the whole pool). */
export function isUnexecuted(idea: Idea): boolean {
  return idea.status === "not-started";
}

/**
 * The leading number on a row — big and unflattering, per the brief. Age is in
 * whole days as the server computed it; this only chooses the words.
 *
 * "today" rather than "0d" for a fresh capture: a zero in the position where
 * every other row shows a rebuke reads like a bug.
 */
export function ageText(ageDays: number): string {
  if (!Number.isFinite(ageDays)) {
    throw new Error(`age_days must be a finite number, received ${String(ageDays)}`);
  }
  if (ageDays <= 0) return "today";
  return `${ageDays}d`;
}

/** How loudly a row's age is drawn. The bands are the point of the default
 *  view: an idea that has sat un-executed for a season should not look like
 *  one captured on Tuesday. Executed ideas are never shamed — their age is
 *  just a date. */
export type AgeTone = "fresh" | "ageing" | "stale" | "settled";

export function ageTone(idea: Idea): AgeTone {
  if (!isUnexecuted(idea)) return "settled";
  if (idea.age_days >= 90) return "stale";
  if (idea.age_days >= 30) return "ageing";
  return "fresh";
}

/** The one line under the header: what this view is actually showing. Written
 *  as a count of the pool that arrived, never as a promise about the pool that
 *  exists — the server filtered it. */
export function viewSummary(view: ThoughtsView, ideas: readonly Idea[]): string {
  const n = ideas.length;
  const noun = n === 1 ? "idea" : "ideas";
  switch (view) {
    case "unexecuted": {
      if (n === 0) return "nothing un-executed";
      const oldest = ideas.reduce((max, i) => Math.max(max, i.age_days), 0);
      return `${n} un-executed ${noun} · oldest ${ageText(oldest)}`;
    }
    case "area":
      return `${n} ${noun} in this area`;
    case "importance":
      return `${n} ${noun}, most important first`;
    case "executed":
      return n === 0 ? "nothing executed yet" : `${n} ${noun} started or done`;
  }
}

/** Counts per area for the BY AREA chips. Takes whatever the current response
 *  holds, so it is a count OF THE VIEW and never claims to be the pool total —
 *  the chips read `—` when the current view cannot know (see IdeaList). */
export function countByArea(ideas: readonly Idea[]): Record<ThoughtArea, number> {
  const out = { business: 0, youtube: 0, life: 0, health: 0, relationships: 0 };
  for (const i of ideas) out[i.area] += 1;
  return out;
}
