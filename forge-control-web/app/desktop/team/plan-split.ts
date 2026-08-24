/**
 * The bounds for the draggable divider between the team tree and the PLAN
 * board in ChatTeamPanel.
 *
 * The drag mechanics live in `_ui/ResizableSplit` — the same primitive the
 * shell's other splitters use. Only the numbers are here, in their own module
 * so a test can assert them without importing a React component.
 *
 * Values are the PLAN zone's share of the panel, 0..1. The team tree takes the
 * remainder.
 */

/** localStorage key. Per browser, deliberately not per chat — the rail should
 *  keep the shape you dragged it into as you move between chats. */
export const PLAN_FRACTION_KEY = "forge.layout.teamPlanFraction";

/** PlanKanban's old hard `maxHeight: 40%`, kept as the default so an untouched
 *  rail looks exactly as it did before the divider became draggable. This is
 *  also what double-clicking the handle restores. */
export const PLAN_FRACTION_DEFAULT = 0.4;

/* Neither zone may be dragged away entirely: a zone at zero height has no
 * content AND no handle-adjacent content to aim at, so the floors are what keep
 * the gesture reversible. Fractions rather than pixels because that is the unit
 * `useResizablePanel` clamps in — a px floor would need the container height,
 * which the hook only measures at grab time.
 *
 * 0.15/0.85 on a ~900px rail is roughly a 135px floor for either zone, which
 * comfortably holds the PLAN header plus a card, or several team rows. */
export const PLAN_FRACTION_MIN = 0.15;
export const PLAN_FRACTION_MAX = 0.85;
