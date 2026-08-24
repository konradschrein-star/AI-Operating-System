/**
 * The geometry behind the draggable divider in ChatTeamPanel.
 *
 * Split out of the component so the clamp is testable without a DOM: every
 * interesting case here is arithmetic (a drag past the edge, a panel too short
 * to hold both zones, a corrupt localStorage value) and none of it needs React
 * to be wrong.
 *
 * `fraction` throughout is the PLAN zone's share of the shell, 0..1. The team
 * tree gets the remainder.
 */

/** localStorage key. Per browser, deliberately not per chat — the rail should
 *  keep the shape you dragged it into as you move between chats. */
export const PLAN_FRACTION_KEY = "forge.teamPanel.planFraction";

/** The pre-splitter constant: PlanKanban's old hard `maxHeight: 40%`. Keeping
 *  it as the default means an untouched rail looks exactly as it did. */
export const PLAN_FRACTION_DEFAULT = 0.4;

/** Neither zone may be dragged below this. A zone at zero height has no
 *  content AND no way to grab it back, so the floor is what makes the gesture
 *  reversible. */
export const MIN_ZONE_PX = 96;

/** One arrow-key press. */
export const KEY_STEP = 0.02;

/**
 * Clamp a proposed fraction so both zones keep at least MIN_ZONE_PX.
 *
 * `shellPx <= 0` means we were asked before layout (first paint, or a
 * collapsed panel). There is no pixel floor to honour yet, so fall back to a
 * generous fractional range rather than inventing a measurement.
 */
export function clampPlanFraction(f: number, shellPx: number): number {
  if (!Number.isFinite(f)) return PLAN_FRACTION_DEFAULT;
  if (!Number.isFinite(shellPx) || shellPx <= 0) {
    return Math.min(0.85, Math.max(0.15, f));
  }
  const min = MIN_ZONE_PX / shellPx;
  const max = 1 - MIN_ZONE_PX / shellPx;
  /* Shorter than two floors: `min > max`, and feeding an inverted range to
   * Math.min/Math.max silently returns the WRONG bound rather than erroring.
   * An even split is the only honest answer at that size. */
  if (min >= max) return 0.5;
  return Math.min(max, Math.max(min, f));
}

/**
 * Read a persisted fraction. Anything that is not a real number strictly
 * inside (0, 1) — absent, "", "null", "1.5", NaN, a string someone hand-edited
 * — yields the default instead of propagating a bad layout.
 */
export function parseStoredFraction(raw: string | null): number {
  if (raw === null || raw.trim() === "") return PLAN_FRACTION_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return PLAN_FRACTION_DEFAULT;
  return n;
}
