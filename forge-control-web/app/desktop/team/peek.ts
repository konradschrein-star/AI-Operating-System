/** The shared vocabulary of "this row is hidden, and here is the way back".
 *
 *  ── Why a module and not two copies of a string ──────────────────────────
 *  Round 1350 shipped the peek affordance in the /live panel and left the chat
 *  team panel on a single control labelled "N hidden · show" that called
 *  `restoreAll` — a fleet-wide DELETE of every dismissal, with no peek, no
 *  confirm and no undo. Round 1354's review clicked it and lost eleven
 *  unrelated dismissals made in /live moments before. The label was not the
 *  bug; the label was how the bug got clicked.
 *
 *  So the two surfaces now share the words as well as the store (./dismissals):
 *  the toggle label, the group heading, the fade, and the exact sentence a row
 *  wears when it is hidden only because its parent is. A future round that
 *  wants to reword the affordance rewords it once, and neither panel can drift
 *  into promising something the other does not do.
 *
 *  Pure — no React, no DOM, no tokens (the fade is an opacity, not a colour) —
 *  so `scripts/checks/check-dismiss-peek.tsx` asserts these strings directly
 *  and the panels are checked against the same constants they render.
 */

/** How far a peeked row is faded. Opacity, not a colour: the row keeps every
 *  design token it renders with in both themes, and "this one is hidden" is
 *  said by the whole row being quieter than the live list above it. */
export const PEEK_OPACITY = 0.55;

/** The heading over the peeked rows, on both surfaces. */
export const DISMISSED_GROUP_LABEL = "DISMISSED";

/** The toggle under/over the list: how many ROWS this panel is withholding,
 *  and what a click will do about it.
 *
 *  `hiddenRowCount` is rows, never dismissed ids — the two differ in both
 *  directions (round 505 finding #3), and each surface counts what IT withheld.
 *  The verb is "show"/"hide", never "restore": this control reveals, it never
 *  writes. That distinction is the whole of round 1354's A4 finding. */
export function dismissedToggleLabel(hiddenRowCount: number, peeking: boolean): string {
  return `${hiddenRowCount} dismissed · ${peeking ? "hide" : "show"}`;
}

/** The two surfaces that share the dismissal store, named the way a reader
 *  would name them. Sharing the WORDS is right; sharing a sentence that names
 *  a fixed panel is not — round 1356 hoisted the chat panel's tooltip into one
 *  constant and /live ended up telling the operator, while he stood in /live,
 *  that his dismissals are shared with the Live panel. A vacuous sentence on
 *  the one control whose job that round was to stop it lying.
 *
 *  So the surface is a parameter and each panel passes the OTHER one:
 *  `check-dismiss-peek.tsx` fails if a panel names itself. */
export const DISMISSAL_SURFACES = {
  /** app/desktop/live/AgentActivity.tsx */
  live: "the Live panel",
  /** app/desktop/team/ChatTeamPanel.tsx */
  team: "the chat team panel",
} as const;

export type DismissalSurfaceName =
  (typeof DISMISSAL_SURFACES)[keyof typeof DISMISSAL_SURFACES];

/** What the toggle promises on hover. Says the two things a reader cannot see:
 *  that dismissing never deletes, and WHERE ELSE the dismissal applies — so
 *  `otherSurface` is the panel the reader is NOT standing in. */
export function dismissedToggleTitle(otherSurface: DismissalSurfaceName): string {
  return (
    "Show the rows dismissed from this panel. Dismissing hides a row; it never " +
    `deletes anything, and the set is shared with ${otherSurface}.`
  );
}

/** The per-row way back, worn by every restorable peeked row. */
export const RESTORE_ROW_TITLE = "Bring this row back";

/** A peeked row that is hidden because an ANCESTOR was dismissed, not because
 *  of its own id. It carries no restore control on purpose: deleting its own
 *  dismissal would leave it hidden under the parent, and a control that
 *  changes nothing on screen is the silent no-op NFU6 forbids. */
export const HIDDEN_WITH_PARENT_MARK = "↳";
export const HIDDEN_WITH_PARENT_TITLE =
  "Hidden together with its parent — restore the row it hangs under and this " +
  "one comes back with it.";

/* ── restore-all ──────────────────────────────────────────────────────────
 *
 * It stays, because "I dismissed forty rows over a week and want a clean
 * slate" is a real request. What it may not do is hide behind a label that
 * says "show". It says what it does, it names how many dismissals it will
 * delete across the whole fleet, and it takes two clicks (see
 * `decideRestoreAllClick` in ./confirm).
 */

export const RESTORE_ALL_LABEL = "restore all";

/** The armed label. Carries the GLOBAL id count — the number the operator
 *  cannot see from this panel, and the exact number round 1354's reviewer lost
 *  without being told. */
export function restoreAllArmedLabel(totalDismissedIds: number): string {
  return `restore all ${totalDismissedIds}?`;
}

/** Rendered only by the chat team panel (`ChatTeamPanel.tsx` is the sole
 *  caller), so the panel it names as "elsewhere" is fixed: /live. */
export function restoreAllTitle(totalDismissedIds: number): string {
  return (
    `Un-hide every dismissed row on this machine — all ${totalDismissedIds} ` +
    `of them, including rows in other projects and in ${DISMISSAL_SURFACES.live}. ` +
    "Click twice to confirm. To bring back one row, use its own ↺ below."
  );
}
