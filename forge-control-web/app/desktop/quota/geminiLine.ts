"use client";

/**
 * The Gemini line — a tally, never a bar. Round 1876.
 *
 * Konrad asked for his Google subscription's limit next to the Claude ones.
 * The limit does not exist as a number anyone can read: round 1302's research
 * (docs/plan/operator-visibility/artifacts/phase1700/gemini-ultra-oauth.md
 * §3.1–§3.4) proved the Gemini API publishes no quota resource, that the one
 * credits API that ever did was switched off for consumer accounts on
 * 2026-06-18, and that the remaining-credit figure exists only inside the
 * Antigravity CLI's own TUI. A percentage here would need a denominator we
 * would have to invent.
 *
 * So this renders WHAT WE COUNTED, with the missing denominator stated in
 * words, or — before the one-time `agy` sign-in — says that instead. Four
 * states, all of them honest, none of them a zero standing in for a number we
 * do not have. Pure functions so `scripts/checks/check-quota-row.ts` can hold
 * every branch to its sentence without a DOM.
 */

import type { GeminiTally } from "./quotaQuery";

/** How the value should be coloured. `unknown` is the amber-ish "we cannot
 *  tell" state and must never be shown in the same colour as a real count —
 *  the same rule the account registry keeps for an unprobed account. */
export type GeminiTone = "unknown" | "unsigned" | "counted";

export interface GeminiLine {
  /** What sits in the row, after the `gem` label. */
  text: string;
  tone: GeminiTone;
  /** The hover title. Always ends with why there is no percentage. */
  title: string;
}

/** 12_400 → "12.4k". Small numbers stay exact: "7 tok" is a real reading and
 *  rounding it to "0.0k" would erase it. One decimal up to 100k, where the
 *  tenth of a thousand still carries information; none above it, where it is
 *  four digits of noise in a status bar. */
export function humanCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const NO_SERVER =
  "gemini — this forge-control does not report a tally (it predates round 1876).";

export function geminiLine(tally: GeminiTally | undefined): GeminiLine {
  if (!tally) {
    return { text: "—", tone: "unknown", title: NO_SERVER };
  }

  const suffix = ` ${tally.no_limit_note}`;

  // A tally we could not compute. "We cannot tell" and "we spent nothing" are
  // different sentences and must never render the same.
  if (tally.error) {
    return {
      text: "unknown",
      tone: "unknown",
      title: `gemini — ${tally.error}${suffix}`,
    };
  }

  const w = tally.five_hour;
  if (!w) {
    return {
      text: "unknown",
      tone: "unknown",
      title: `gemini — no 5-hour tally came back.${suffix}`,
    };
  }

  // Nothing counted AND no sign-in: the sign-in is the thing to say. A "0" here
  // would read as "you have used none of your Ultra quota", which is a claim
  // this box cannot make.
  if (w.calls === 0 && !tally.cli_profile) {
    return {
      text: "not signed in",
      tone: "unsigned",
      title: `gemini — ${tally.auth_note}${
        tally.connect_command ? ` To connect: ${tally.connect_command}.` : ""
      }${suffix}`,
    };
  }

  const seven = tally.seven_day;
  const body =
    w.tokens === null
      ? `${humanCount(w.calls)} call${w.calls === 1 ? "" : "s"}/5h`
      : `${humanCount(w.tokens)} tok/5h`;
  const detail =
    w.tokens === null
      ? `${w.calls} call(s) in 5h; no caller recorded a token count, so there is no token figure to show.`
      : `${w.tokens.toLocaleString()} tokens across ${w.calls} call(s) in 5h${
          seven
            ? `, ${seven.tokens === null ? "unrecorded" : seven.tokens.toLocaleString()} tokens across ${seven.calls} call(s) in 7d`
            : ""
        }.`;

  return {
    text: body,
    tone: "counted",
    title: `gemini — our own count: ${detail} ${tally.auth_note}${suffix}`,
  };
}
