/**
 * useAutogrow — the composer textarea grows with its content (U28).
 *
 * Two rows at rest, up to `maxRows` as you type, then it stops growing and
 * scrolls internally. Clearing the draft (send, slash dispatch, Esc) puts it
 * back to exactly the two-row height — for free, because the height is derived
 * from the controlled `value` rather than tracked separately.
 *
 * NFU2 (hover/keystroke perf): this hook holds NO React state. A keystroke
 * already re-renders the thread once via the controlled `draft` value; adding a
 * height state would double that for zero benefit. The measured height is
 * written straight onto the element in `useLayoutEffect`, so it lands in the
 * same frame as the character and never causes a second render pass.
 *
 * Measurement protocol (docs/plan/14-ui-v3-quality.md, "Composer autogrow"):
 *   height = 'auto'  →  read scrollHeight ONCE  →  clamp  →  write height +
 *   overflowY. One forced reflow per keystroke, which is the irreducible cost
 *   of measuring wrapped text; nothing else in the effect touches layout.
 *
 * The row→pixel conversion comes from getComputedStyle, cached in a ref: a
 * textarea whose computed line-height is `normal` reports an unmeasurable
 * value, which is why the composer pins `lineHeight: 1.5` in its style object.
 * If the metrics ever read as 0/NaN the cache is not populated, the element is
 * left at its native `rows` height, and one diagnostic is logged — the box
 * visibly stops growing rather than silently mis-sizing itself.
 */

import { useLayoutEffect, useRef, type RefObject } from "react";

export interface AutogrowOptions {
  /** Resting height, in text rows. */
  minRows: number;
  /** Growth cap, in text rows. Past this the textarea scrolls internally. */
  maxRows: number;
}

export interface AutogrowSize {
  /** Value for `style.height`, in px. */
  height: number;
  /** `"auto"` only once the content genuinely exceeds the cap. */
  overflowY: "auto" | "hidden";
}

/**
 * The whole decision, as a pure function so it can be checked without a DOM
 * (scripts/checks/check-composer-v3.ts).
 *
 * `measuredPx` is the content height already normalised to the same box model
 * as `style.height` — the hook derives it from `scrollHeight` (see
 * `normaliseScrollHeight`), because scrollHeight includes padding but never
 * borders, and `style.height` includes both under `box-sizing: border-box`.
 *
 * Exactly at the cap the textarea must NOT show a scrollbar; one pixel over, it
 * must. That boundary is the reason this is a named function with a test table
 * instead of two inline ternaries.
 */
export function clampAutogrow(
  measuredPx: number,
  minPx: number,
  maxPx: number,
): AutogrowSize {
  if (!Number.isFinite(measuredPx) || !Number.isFinite(minPx) || !Number.isFinite(maxPx)) {
    throw new Error(
      `clampAutogrow: non-finite input (measuredPx=${measuredPx}, minPx=${minPx}, maxPx=${maxPx})`,
    );
  }
  if (maxPx < minPx) {
    throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  }
  const height = Math.min(Math.max(measuredPx, minPx), maxPx);
  return { height, overflowY: measuredPx > maxPx ? "auto" : "hidden" };
}

/** Font/box metrics of the textarea, read once and cached. */
export interface BoxMetrics {
  lineHeightPx: number;
  /** paddingTop + paddingBottom. */
  padPx: number;
  /** borderTopWidth + borderBottomWidth. */
  borderPx: number;
  borderBox: boolean;
}

/** `style.height` for a given number of rows, in this element's box model. */
export function rowsToPx(m: BoxMetrics, rows: number): number {
  const chrome = m.borderBox ? m.padPx + m.borderPx : 0;
  return Math.round(m.lineHeightPx * rows + chrome);
}

/** scrollHeight (content + padding, no border) → the same box model as `height`. */
export function normaliseScrollHeight(m: BoxMetrics, scrollHeight: number): number {
  return m.borderBox ? scrollHeight + m.borderPx : scrollHeight - m.padPx;
}

function readMetrics(el: HTMLTextAreaElement): BoxMetrics | null {
  const cs = getComputedStyle(el);
  const lineHeightPx = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
    // `normal`, or an element that isn't laid out yet. Do not guess a number.
    console.warn(
      `useAutogrow: unusable line-height (${cs.lineHeight}); textarea left at its native rows height`,
    );
    return null;
  }
  const num = (raw: string) => {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    lineHeightPx,
    padPx: num(cs.paddingTop) + num(cs.paddingBottom),
    borderPx: num(cs.borderTopWidth) + num(cs.borderBottomWidth),
    borderBox: cs.boxSizing === "border-box",
  };
}

/**
 * Size `ref.current` to fit `value`, between `minRows` and `maxRows`.
 *
 * Attach the ref to a textarea with an explicit numeric `lineHeight` and
 * `resize: "none"`; everything else about the element is left alone.
 */
export function useAutogrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { minRows, maxRows }: AutogrowOptions,
): void {
  const metricsRef = useRef<BoxMetrics | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Cached after the first successful read; a null cache means the last read
    // was unusable, so we try again on the next keystroke (fonts may still
    // have been loading) rather than pinning a bogus row height forever.
    let metrics = metricsRef.current;
    if (!metrics) {
      metrics = readMetrics(el);
      if (!metrics) return;
      metricsRef.current = metrics;
    }

    const minPx = rowsToPx(metrics, minRows);
    const maxPx = rowsToPx(metrics, maxRows);

    el.style.height = "auto";
    const scrollHeight = el.scrollHeight; // read ONCE — every extra read is a reflow
    const next = clampAutogrow(
      normaliseScrollHeight(metrics, scrollHeight),
      minPx,
      maxPx,
    );
    el.style.height = `${next.height}px`;
    el.style.overflowY = next.overflowY;
  }, [ref, value, minRows, maxRows]);
}
