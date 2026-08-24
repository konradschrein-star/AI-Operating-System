/**
 * The bounds for the draggable divider between the retrospective pane and the
 * mentor agent deck in JournalSurface.
 *
 * The drag mechanics live in `_ui/ResizableSplit` — the same primitive the
 * shell's other splitters use. Only the numbers are here, in their own module
 * so a test can assert them without importing a React component.
 *
 * Values are fractions of the total workspace width (0..1) allocated to the
 * retrospective pane (left column). The mentor deck takes the remainder (1 - size).
 */

/** localStorage key. Per browser, keeps the journal split ratio across sessions. */
export const JOURNAL_SPLIT_KEY = "forge.layout.journal.split";

/** JournalSurface's old hard 55%/45% split, kept as the default so an untouched
 *  surface looks exactly as it did before the divider became draggable. This is
 *  also what double-clicking the handle restores. */
export const JOURNAL_SPLIT_INITIAL = 0.55;

/** Sane min/max bounds: retro pane cannot be crushed below 35% (still readable)
 *  or expanded beyond 70%, keeping the mentor deck reachable. */
export const JOURNAL_SPLIT_MIN = 0.35;
export const JOURNAL_SPLIT_MAX = 0.70;
