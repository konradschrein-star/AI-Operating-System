/**
 * The bounds for the draggable divider between the Excalidraw canvas and the
 * structured-plan drawer in CanvasPane.
 *
 * The drag mechanics live in `_ui/ResizableSplit` — the same primitive the
 * shell's other splitters use. Only the numbers are here, in their own module
 * so a test can assert them without importing a React component.
 *
 * Values are pixel widths for the plan drawer.
 */

/** localStorage key. Per browser, keeps the drawer width across drawings. */
export const CANVAS_PLAN_KEY = "forge.layout.canvas.planDrawer";

/** CanvasPane's old hard width: 520, kept as the default so an untouched pane
 *  looks exactly as it did before the divider became draggable. This is also
 *  what double-clicking the handle restores. */
export const CANVAS_PLAN_INITIAL = 520;

/** Sane min/max bounds: drawer cannot be crushed below 380px (CanvasPane's old
 *  minWidth) or expanded beyond 820px, keeping the canvas reachable. */
export const CANVAS_PLAN_MIN = 380;
export const CANVAS_PLAN_MAX = 820;
