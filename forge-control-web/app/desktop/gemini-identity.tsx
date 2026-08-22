"use client";

/**
 * The Gemini/Antigravity identity — one colour, one mark, one predicate.
 *
 * Konrad asked for Gemini usage in a different colour and for the agents using
 * it to be colour-coded. That is only worth doing if EVERY surface answers "is
 * this Gemini?" the same way and paints it the same colour; two surfaces
 * disagreeing about which engine a run used is worse than no colour at all,
 * because it looks like information.
 *
 * So the predicate, the colour and the mark live here and nowhere else. Adding
 * a Gemini indicator to a new surface is an import, not a decision.
 *
 * ── WHY THIS COLOUR ──────────────────────────────────────────────────────────
 * `#8b7bf0` — the violet from the Antigravity mark's underside. It is picked to
 * be unmistakable against the three colours the quota bars already use for
 * PRESSURE (ok/warn/bleed): a reader must never wonder whether a bar is violet
 * because it is Gemini or because something is wrong. Engine identity and
 * pressure are different axes and must not share a palette.
 */

import type { JSX } from "react";

/** The single Gemini accent. Not a token, deliberately: tokens are themed and
 *  this is a brand identity that must read the same in both palettes. */
export const GEMINI_ACCENT = "#8b7bf0";

/** A dim wash of the same hue, for chip backgrounds. */
export const GEMINI_ACCENT_SOFT = "rgba(139, 123, 240, 0.16)";

/**
 * Is this model id the Gemini engine?
 *
 * Mirrors `isGeminiModel` in forge-control/src/lib/gemini-runner.ts — same
 * prefix rule, so the UI's idea of "this run was Gemini" cannot drift from the
 * dispatcher's. A run that the server sent to `agy` is exactly a run this
 * returns true for.
 */
export function isGeminiModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith("gemini-");
}

/**
 * The Antigravity mark, downscaled.
 *
 * Konrad's own asset, served from /antigravity.png rather than redrawn as SVG:
 * a hand-traced approximation of someone else's logo is a worse likeness AND a
 * thing to maintain. `imageRendering: auto` because the source is a small
 * gradient bitmap — nearest-neighbour would make the gradient banded at these
 * sizes.
 */
export function AntigravityMark({
  size = 12,
  title = "Gemini · Antigravity",
}: {
  size?: number;
  title?: string;
}): JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/antigravity.png"
      alt=""
      aria-hidden="true"
      title={title}
      width={size}
      height={size}
      data-antigravity-mark
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        flex: "none",
        display: "inline-block",
        verticalAlign: "text-bottom",
      }}
    />
  );
}

/**
 * The chip that marks a run/agent as Gemini-powered.
 *
 * Deliberately says the ENGINE, not the model: every Gemini run in this OS is
 * gemini-3.7-flash-high, so printing the full id on every row would be five
 * words of noise repeated down a list. The full id is in the `title`.
 */
export function GeminiChip({
  model,
  size = 11,
}: {
  model?: string | null;
  size?: number;
}): JSX.Element {
  return (
    <span
      data-gemini-chip
      title={model ? `${model} — runs on Antigravity (agy), not the Claude window` : "Gemini via Antigravity"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: size - 1,
        lineHeight: 1,
        padding: "2px 6px",
        borderRadius: 4,
        color: GEMINI_ACCENT,
        background: GEMINI_ACCENT_SOFT,
        border: `1px solid ${GEMINI_ACCENT}`,
        whiteSpace: "nowrap",
      }}
    >
      <AntigravityMark size={size - 1} />
      gemini
    </span>
  );
}
