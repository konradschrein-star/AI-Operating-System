/**
 * effort-ramp.ts — the reasoning-effort colour ramp (U29).
 *
 * Ordering, and why: the ramp runs calm → hot in exactly the order the cost and
 * the latency of a turn climb. `low` is the neutral text colour — it is the
 * cheap, unremarkable setting and gets no hue at all. `medium` picks up `info`
 * (cool cyan): informational, still routine. `high` steps to `warn` (amber):
 * this is the default the manager chat runs on, and it should read as "you are
 * spending real tokens". `xhigh` takes `bleed` (red): the setting that burns
 * minutes and dollars per turn, coloured like every other expensive thing in
 * this console. A reader who knows nothing about the engine can tell which end
 * of the row is expensive without a legend — that is the whole job of the ramp.
 *
 * Colours are token references only (NFU1); nothing here is a literal. The fill
 * used for the selected state comes from the existing tinted-surface family —
 * there are only three `*ActionBg` tokens for four levels, so `low` borrows
 * `selectedBg` (the neutral "this row is selected" wash) and `high` borrows
 * `freezeBgWarn` (the amber wash that already pairs with `warn` on the freeze
 * card). No new colour is introduced in either theme.
 */

import { tokens } from "../../tokens";
import { ENGINE_EFFORT_CHOICES } from "../../api";

export type EffortLevel = (typeof ENGINE_EFFORT_CHOICES)[number];

export interface EffortRamp {
  /** Text colour — also the effort word in the `{model} · {effort} ▾` label. */
  fg: string;
  /** Outline. Carries the ramp on unselected chips, where there is no fill. */
  border: string;
  /** Fill for the selected chip only. */
  bg: string;
}

/**
 * Cheapest → most expensive. The array is the ramp's own statement of order;
 * scripts/checks/check-composer-v3.ts asserts it still matches
 * `ENGINE_EFFORT_CHOICES` so the two cannot drift apart unnoticed.
 */
export const EFFORT_RAMP_ORDER = ["low", "medium", "high", "xhigh"] as const;

/** `Record<EffortLevel, …>` — adding a choice in api.ts fails tsc until it is
 *  given a rung on the ramp. That is deliberate: an uncoloured effort level
 *  would silently render as an unstyled chip. */
export const EFFORT_RAMP: Record<EffortLevel, EffortRamp> = {
  low: { fg: tokens.textMuted, border: tokens.textMuted, bg: tokens.selectedBg },
  medium: { fg: tokens.info, border: tokens.info, bg: tokens.primaryActionBg },
  high: { fg: tokens.warn, border: tokens.warn, bg: tokens.freezeBgWarn },
  xhigh: { fg: tokens.bleed, border: tokens.bleed, bg: tokens.dangerActionBg },
};

/**
 * Ramp for an effort string. The run's stored effort is a plain string that can
 * hold values the UI never offers (`"max"` is API/Telegram-only), so unknown
 * values fall to the calm end rather than throwing inside a render — an
 * unrecognised effort is a display question, not a broken app. It is still
 * visible: the label shows the raw string next to a muted colour.
 */
export function effortRamp(effort: string): EffortRamp {
  return (EFFORT_RAMP as Record<string, EffortRamp | undefined>)[effort] ?? EFFORT_RAMP.low;
}
