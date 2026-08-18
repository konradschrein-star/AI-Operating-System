"use client";

/**
 * What a connection row says — the pure part. Round 1876.
 *
 * Konrad: "the settings are still a bit confusing, especially with connecting
 * accounts, Claude accounts, like wiring them in and wiring in Google
 * accounts. I want to be able to do that also."
 *
 * The confusion was structural. Claude accounts lived in one settings section,
 * Google and Gemini in another, and neither section said what the thing WAS,
 * whether it was connected, or what to type to fix it. So every connection —
 * whatever it is underneath — is now one row that answers the same five
 * questions in the same order:
 *
 *   what it is · connected? · which identity · health · the exact action
 *
 * The row's TEXT is decided here, as pure functions over the same wire shapes
 * the panels already fetch, so `scripts/checks/check-quota-row.ts` can hold
 * each state to its sentence without a DOM — including the one rule that must
 * never regress: an unprobed Claude account is UNKNOWN in amber, NEVER green.
 */

import type { Account } from "./accountRegistry";
import type { GeminiTally } from "../quota/quotaQuery";

/** The four states any connection can be in. `unknown` is amber: it means "we
 *  have not checked", which is NOT "it works" and must never be coloured like
 *  it. `absent` is the honest state for something never wired up at all. */
export type ConnectionState = "connected" | "unknown" | "broken" | "absent";

export interface ConnectionSummary {
  /** Stable row id — also the DOM marker the checks and screenshots look for. */
  id: string;
  /** The name Konrad would use. */
  title: string;
  /** What this connection IS, in one line. Not a restatement of the title. */
  what: string;
  state: ConnectionState;
  /** The chip's word. Deliberately not derived from `state` alone: "UNVERIFIED"
   *  and "NOT CONNECTED" are both `unknown`-ish states with different meanings. */
  stateLabel: string;
  /** Which identity is wired in, or why we do not know it. */
  identity: string;
  /** One line on health — the last real evidence, not a token countdown. */
  health: string;
  /** The exact thing to do next. A command when a command is what it takes:
   *  a button that cannot finish the job is worse than a line to copy. */
  action: string;
}

export const STATE_LABEL: Record<ConnectionState, string> = {
  connected: "CONNECTED",
  unknown: "UNKNOWN",
  broken: "BROKEN",
  absent: "NOT CONNECTED",
};

/** A Claude account, as a connection row. The health mapping is the registry's
 *  own — this adds no second opinion about what healthy means. */
export function claudeConnection(a: Account, serving: boolean): ConnectionSummary {
  const state: ConnectionState =
    a.health === "healthy" ? "connected" : a.health === "broken" ? "broken" : "unknown";
  return {
    id: `claude:${a.slug}`,
    title: a.slug,
    what: "A Claude Code login. Runs execute as this account; the fleet fails over between them by priority.",
    state,
    stateLabel:
      a.health === "healthy"
        ? serving
          ? "SERVING RUNS"
          : "CONNECTED"
        : a.health === "broken"
          ? "BROKEN"
          : "UNKNOWN — NOT PROBED",
    identity: a.login_email ?? "address not recorded — probe it to find out",
    health:
      a.health === "unknown"
        ? "Never confirmed by a run or a probe. Not known to work — that is why this is amber and not green."
        : (a.health_detail ?? "no detail recorded"),
    action:
      a.health === "broken"
        ? `Re-authenticate on the VPS: ${a.reauth_command}`
        : a.health === "unknown"
          ? "Press “Probe now” below to find out whether this login still works."
          : "Nothing to do. Use “Probe now” to re-confirm at any time.",
  };
}

export interface GoogleFacts {
  /** A credential file exists and carries a refresh token. */
  hasAccount: boolean;
  hasRefreshToken: boolean;
  email: string | null;
  scopeCount: number;
  /** Result of the last live check, or null when none has run this process. */
  checkOk: boolean | null;
  checkMessage: string | null;
  reauthCommand: string;
}

export function googleConnection(f: GoogleFacts | null): ConnectionSummary {
  const base = {
    id: "google",
    title: "Google Workspace",
    what: "The Gmail, Calendar, Drive, Docs and Sheets consent this box runs on. One OAuth credential, shared by every agent that touches Google.",
  };
  if (!f || !f.hasAccount) {
    return {
      ...base,
      state: "absent",
      stateLabel: STATE_LABEL.absent,
      identity: "none",
      health: f
        ? "No credential file was found on this box."
        : "Not read yet.",
      action: f
        ? `Run the consent flow on the VPS: ${f.reauthCommand}`
        : "Loading…",
    };
  }
  const state: ConnectionState =
    f.checkOk === true ? "connected" : f.checkOk === false ? "broken" : "unknown";
  return {
    ...base,
    state,
    stateLabel:
      f.checkOk === true
        ? "CONNECTED"
        : f.checkOk === false
          ? "NOT ANSWERING"
          : "UNVERIFIED",
    identity:
      f.email ??
      "not recorded in the credential file — press “Check connection” and Google will tell us",
    health:
      f.checkMessage ??
      `Credential present with ${f.scopeCount} scopes${
        f.hasRefreshToken ? " and a refresh token" : " but NO refresh token"
      }. Never checked live this process, so it is unverified rather than healthy.`,
    action:
      f.checkOk === false || !f.hasRefreshToken
        ? `Re-authorise on the VPS: ${f.reauthCommand}`
        : "Press “Check connection” below — it calls Gmail and reports what Google answers.",
  };
}

export function geminiKeyConnection(
  present: boolean | null,
  masked: string | null,
  verdict: { ok: boolean; message?: string } | null,
): ConnectionSummary {
  const base = {
    id: "gemini-key",
    title: "Gemini API key",
    what: "An AI Studio key, billed to its Cloud project. The higher-quality opt-in beside the free Gemini Pool — not a way into the Ultra subscription.",
  };
  if (present === null) {
    return {
      ...base,
      state: "unknown",
      stateLabel: "UNKNOWN",
      identity: "not read yet",
      health: "Loading…",
      action: "Loading…",
    };
  }
  if (!present) {
    return {
      ...base,
      state: "absent",
      stateLabel: STATE_LABEL.absent,
      identity: "no key stored",
      health: "Nothing is stored, so nothing can be tested.",
      action: "Paste a key from aistudio.google.com into the field below and press Save.",
    };
  }
  const state: ConnectionState =
    verdict === null ? "unknown" : verdict.ok ? "connected" : "broken";
  return {
    ...base,
    state,
    stateLabel:
      verdict === null ? "UNTESTED" : verdict.ok ? "CONNECTED" : "REJECTED",
    identity: masked ?? "stored",
    health:
      verdict === null
        ? "Stored but never tested this session — unverified, not healthy."
        : (verdict.message ?? (verdict.ok ? "Google answered." : "Google refused the key.")),
    action:
      verdict?.ok === false
        ? "Paste a replacement key below, or remove this one."
        : "Press “Test connection” below to make Google answer for it.",
  };
}

/** The Ultra subscription itself, via the Antigravity CLI. Reads the SAME
 *  tally the indicator row shows — one subscription, one truth, no extra
 *  request. There is no percentage here for the same reason there is none up
 *  there: Google publishes no denominator. */
export function ultraConnection(t: GeminiTally | undefined): ConnectionSummary {
  const base = {
    id: "gemini-ultra",
    title: "Google AI Ultra (Antigravity CLI)",
    what: "Konrad's Google subscription, reachable only through the `agy` CLI. Its quota is real but unpublished — no endpoint returns the remaining share, so this OS counts its own calls instead.",
  };
  if (!t) {
    return {
      ...base,
      state: "unknown",
      stateLabel: "UNKNOWN",
      identity: "not read yet",
      health: "This forge-control does not report a Gemini tally.",
      action: "Loading…",
    };
  }
  if (!t.cli_profile) {
    return {
      ...base,
      state: "absent",
      stateLabel: STATE_LABEL.absent,
      identity: "no local agy profile",
      health: t.auth_note,
      action: t.connect_command
        ? `On the VPS: ${t.connect_command}`
        : "Sign in with the Antigravity CLI on this box.",
    };
  }
  return {
    ...base,
    // A profile on disk is not a live session: the session lives in the OS
    // keyring and no HTTP handler may open it. So this stays UNKNOWN rather
    // than claiming a connection it has not seen.
    state: "unknown",
    stateLabel: "SIGNED IN LOCALLY",
    identity: "the Google account that ran `agy` on this box",
    health: t.auth_note,
    action:
      "Nothing to wire. Run `agy` and type /usage to see Google's own credit figure — it exists only inside that TUI.",
  };
}
