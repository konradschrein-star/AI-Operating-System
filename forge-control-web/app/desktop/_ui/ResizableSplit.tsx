"use client";

/**
 * The app's one resize primitive.
 *
 * Before this, every panel dimension in the console was a magic number
 * (audit §4: nav rail 184, chat rail 300, side panel 260/420, chat↔canvas
 * 55/45 …) and nothing about the layout survived a reload. On a 1280px
 * laptop the chat surface spent 904px on chrome before the thread got a
 * pixel, and there was no way to claw any of it back.
 *
 * Two pieces:
 *   • `useResizablePanel` — owns the size, clamps it, persists it under a
 *     localStorage key, and hands back the props for the grab handle.
 *   • `<ResizeHandle>` — the 5px grab strip. Renders as a hairline that
 *     lights up on hover/drag, so it reads as the panel border it replaces.
 *
 * Sizes come in two units. `px` for panels that should keep their width as
 * the window changes (rails, side panel). `fraction` for splits of the
 * remaining space (chat↔canvas, agents↔board), measured against the
 * handle's parent so the split holds its proportion at any window size.
 *
 * Double-click a handle to reset that panel to its designed default —
 * cheaper than dragging back and the only way out of a size you can no
 * longer see.
 *
 * SSR: the stored size is applied in a layout effect, not in the useState
 * initializer. Reading localStorage during render would make the server
 * and client markup disagree; a layout effect lands before paint, so
 * there's no flash of the default width either.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { tokens } from "../../tokens";

export type ResizeAxis = "x" | "y";

export interface ResizeHandleProps {
  axis: ResizeAxis;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  /** Not named `ref`: React 19 treats a literal `ref` prop specially and we
   *  need this to survive a plain `{...handleProps}` spread. */
  handleRef: (el: HTMLDivElement | null) => void;
  active: boolean;
}

interface PanelOptions {
  /** localStorage key. Namespace with `forge.layout.` for readability. */
  storageKey: string;
  /** Designed default, and the value double-click restores. */
  initial: number;
  min: number;
  max: number;
  /** `x` = horizontal drag (width), `y` = vertical drag (height). */
  axis?: ResizeAxis;
  /** px = absolute size; fraction = 0..1 of the handle's parent. */
  unit?: "px" | "fraction";
  /**
   * True when the panel being sized is *after* the handle (e.g. a
   * right-hand side panel, whose handle sits on its left edge): dragging
   * toward the start of the axis must then grow it, not shrink it.
   */
  invert?: boolean;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function readStored(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // private mode / disabled storage — defaults are fine
  }
}

export function useResizablePanel(opts: PanelOptions): {
  size: number;
  handleProps: ResizeHandleProps;
  reset: () => void;
} {
  const {
    storageKey,
    initial,
    min,
    max,
    axis = "x",
    unit = "px",
    invert = false,
  } = opts;
  const [size, setSize] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const elRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ origin: number; startSize: number; scale: number } | null>(
    null,
  );

  // Re-reads when the key changes, so a panel whose identity depends on
  // which tab is showing (the side panel: Live and Files want different
  // widths) picks up that tab's remembered size — and falls back to that
  // tab's default rather than inheriting the other tab's width.
  useLayoutEffect(() => {
    const stored = readStored(storageKey);
    setSize(clamp(stored ?? initial, min, max));
  }, [storageKey, initial, min, max]);

  const persist = useCallback(
    (v: number) => {
      try {
        localStorage.setItem(storageKey, String(v));
      } catch {
        /* storage unavailable — the size just won't survive a reload */
      }
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    setSize(initial);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* nothing to clean up */
    }
  }, [initial, storageKey]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = elRef.current;
      // For fractional splits every pixel of pointer travel is worth
      // 1/containerSize of the split — measure the container once, at
      // grab time, rather than per move event.
      let scale = 1;
      if (unit === "fraction") {
        const parent = el?.parentElement;
        const box = parent?.getBoundingClientRect();
        const span = axis === "x" ? (box?.width ?? 0) : (box?.height ?? 0);
        if (span <= 0) return; // not laid out yet — a drag would be nonsense
        scale = 1 / span;
      }
      dragRef.current = {
        origin: axis === "x" ? e.clientX : e.clientY,
        startSize: size,
        scale,
      };
      el?.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [axis, size, unit],
  );

  // Move/up live on the captured element, attached imperatively so the
  // listeners exist only while a drag is in flight.
  useEffect(() => {
    if (!dragging) return;
    const el = elRef.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const pos = axis === "x" ? e.clientX : e.clientY;
      const delta = (pos - d.origin) * (invert ? -1 : 1) * d.scale;
      setSize(clamp(d.startSize + delta, min, max));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    // Kill text selection and keep the resize cursor while dragging, even
    // when the pointer outruns the 5px handle.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, axis, invert, min, max]);

  // Persist on release rather than per move — one write per drag.
  const wasDragging = useRef(false);
  useEffect(() => {
    if (wasDragging.current && !dragging) persist(size);
    wasDragging.current = dragging;
  }, [dragging, size, persist]);

  return {
    size,
    handleProps: {
      axis,
      onPointerDown,
      onDoubleClick: reset,
      handleRef: (el) => {
        elRef.current = el;
      },
      active: dragging,
    },
    reset,
  };
}

/** Invisible padding on each side of the visible rule, in px. Total grab
 *  target is 2*HIT_PAD + the rule. Chosen to clear the ~5px that pointer
 *  studies treat as the floor for a reliable target without letting the strip
 *  swallow clicks aimed at the rows either side of it. */
const HIT_PAD = 5;

/** The grab strip. Sits between two flex children and replaces their border. */
export function ResizeHandle({
  axis,
  onPointerDown,
  onDoubleClick,
  handleRef,
  active,
  title = "Drag to resize · double-click to reset",
}: ResizeHandleProps & { title?: string }) {
  const [hover, setHover] = useState(false);
  const lit = active || hover;
  /* The visible rule is 1px. The GRAB TARGET is not: a 1px strip is a
   * pixel-hunt with a pointer, and a divider you cannot reliably catch reads
   * as a divider that does not move — which is exactly how these were being
   * experienced.
   *
   * Under global `box-sizing: border-box`, a 1px element with 5px horizontal
   * padding collapses its content box to 0px (max(0, 1 - 10)). Because
   * `backgroundClip: content-box` restricts painting to the content box,
   * the line painted 0px (invisible). Setting `boxSizing: content-box`
   * guarantees a 1px painted content box while padding creates an 11px
   * grab target (1px + 2*5px). Negative margins (-5px each side) cancel
   * the padding so the net layout footprint remains strictly 1px.
   *
   * Hover/active emphasis uses `tokens.borderEmphasis` instead of the old
   * saturated blue accent slab. */
  const base: CSSProperties = {
    flex: "none",
    boxSizing: "content-box",
    /* `backgroundColor`, not the `background` SHORTHAND: `background` is a
     * shorthand for backgroundClip/Origin/Image/… too, and React's style
     * diffing only re-applies props that changed between renders. Hover
     * toggles `lit`, so `background` is the one prop that changes on every
     * hover — React re-sets *only* that key, and the browser's shorthand
     * setter resets every OTHER background-* longhand (including the
     * `backgroundClip: "content-box"` below, which never itself changes and
     * so is never re-applied) back to its initial value. Net effect: the
     * first hover of any divider's lifetime silently and permanently flips
     * backgroundClip to border-box, so the "1px hairline" paints the full
     * 11px hit-pad forever after — a live, browser-only regression a
     * source-regex/arithmetic test cannot see, since it only exists after
     * React re-renders a real DOM node. `backgroundColor` is a longhand: it
     * never touches backgroundClip. */
    /* `borderHandle`, NOT `borderSoft`. Making the line paint again was only
     * half the fix. Measured on the real render (2026-08-24), `borderSoft` is
     * 1.16:1 against this theme's #000 body and `borderEmphasis` is 1.32:1 —
     * pixel-correct, and invisible to an eye. A card's edge may whisper
     * because the shape it encloses gives it away; a divider encloses nothing
     * and IS the affordance, so it gets its own tone. See theme.css. */
    backgroundColor: lit ? tokens.borderHandleHover : tokens.borderHandle,
    backgroundClip: "content-box",
    transition: active ? "none" : "background 120ms ease",
    touchAction: "none",
    /* `position` is what makes the `zIndex` below mean anything. Without it the
     * handle is statically positioned, z-index does not apply to a static box,
     * and the declaration has been decorative since it was written.
     *
     * Harmless while the handle was a 1px line between two unpositioned
     * siblings. It stopped being harmless with HIT_PAD: the pad reaches 5px
     * INTO each neighbour, so any sibling that carries its own
     * position+z-index — CanvasPane's plan drawer is `position: relative;
     * z-index: 10` — paints over roughly half the grab target. Found by the
     * layout lane's round-0 worker, which measured it with `elementFromPoint`
     * across the pad rather than assuming the drag worked because the visible
     * line did.
     *
     * `relative` with no offsets moves nothing; it only lets the stacking
     * order be stated. */
    position: "relative",
    zIndex: 2,
  };
  const style: CSSProperties =
    axis === "x"
      ? {
          ...base,
          width: 1,
          padding: `0 ${HIT_PAD}px`,
          margin: `0 -${HIT_PAD}px`,
          cursor: "col-resize",
          alignSelf: "stretch",
        }
      : {
          ...base,
          height: 1,
          padding: `${HIT_PAD}px 0`,
          margin: `-${HIT_PAD}px 0`,
          cursor: "row-resize",
          alignSelf: "stretch",
        };
  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      title={title}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    />
  );
}

/* ── Narrow viewports (round 1871, finding 8) ────────────────────────────────
 *
 * "At 390×844 the chat surface and team panel are entirely unreachable
 * (clipped, no horizontal scroll)."
 *
 * WHAT WAS ACTUALLY HAPPENING. `app/page.tsx` picks `MobileApp` from the
 * User-Agent, so a real phone was never in this state — but `/desktop` is an
 * explicit route that renders the desktop shell whatever the device, and that
 * shell is three fixed columns: a 184px nav rail, a ~200px chat rail and a
 * 260px side panel. At 390px the first two consume the whole width and the
 * transcript is laid out past the right edge of a container with
 * `overflow: hidden`. Nothing was scrollable to, so nothing was reachable.
 *
 * THE FIX IS TO DROP COLUMNS, NOT TO ADD SCROLL. A horizontally scrolling
 * console is a worse answer than one that shows you a single column at a time,
 * and the shell already has the vocabulary for it: the nav rail collapses, the
 * side panel collapses, and the chat surface already knows how to show a list
 * and a thread. Below the breakpoint it shows ONE of them.
 *
 * NOT A MEDIA QUERY, because every layout decision in this app is a JS value
 * (widths come from `useResizablePanel`, panels from `usePersistentState`) and
 * a CSS breakpoint could not reach them. `matchMedia` is the same information
 * on the same clock, delivered where the decisions are.
 *
 * SSR: `false` on the server and on the first client paint, then corrected in
 * a layout effect before the browser paints. The desktop layout is the safe
 * default to be briefly wrong about — it is what every existing session gets.
 */
export const NARROW_MAX_PX = 900;

export function useNarrowViewport(maxPx: number = NARROW_MAX_PX): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${maxPx}px)`);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [maxPx]);
  return narrow;
}

/**
 * localStorage-backed useState for small layout flags (panel collapsed,
 * active tab). Same SSR discipline as useResizablePanel: default on the
 * server, stored value applied before paint.
 */
export function usePersistentState<T>(
  storageKey: string,
  initial: T,
  isValid: (v: unknown) => v is T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useLayoutEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (isValid(parsed)) setValue(parsed);
    } catch {
      /* unreadable or malformed — keep the default */
    }
    // isValid is a stable type-guard by construction; re-running on its
    // identity would reset the panel on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(storageKey, JSON.stringify(v));
      } catch {
        /* storage unavailable — flag just won't survive a reload */
      }
    },
    [storageKey],
  );

  return [value, set];
}

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
