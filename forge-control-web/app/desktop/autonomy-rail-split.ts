/**
 * The bounds for the draggable divider between the category rail and the
 * rules/trips content in AutonomySurface.
 *
 * The drag mechanics live in `_ui/ResizableSplit` — the same primitive the
 * shell's other splitters use. Only the numbers are here, in their own module
 * so a test can assert them without importing a React component.
 *
 * Values are pixel widths for the category rail.
 */

/** localStorage key. Per browser, keeps the category rail width across sessions. */
export const AUTONOMY_RAIL_KEY = "forge.layout.autonomy.categoryRail";

/** AutonomySurface's old hard width: 220, kept as the default so an untouched rail
 *  looks exactly as it did before the divider became draggable. This is also
 *  what double-clicking the handle restores. */
export const AUTONOMY_RAIL_INITIAL = 220;

/** Sane min/max bounds: rail cannot be crushed below 160px (still shows category
 *  labels/badges) or expanded beyond 420px, keeping the main content reachable. */
export const AUTONOMY_RAIL_MIN = 160;
export const AUTONOMY_RAIL_MAX = 420;
