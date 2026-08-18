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
 *
 * ── PHASE 4 / B4c: ALL FOUR CONNECTIONS, ONE SHAPE ───────────────────────
 * Claude, Google, `agy` and GitHub now reach `ConnectionSummary` through the
 * SAME function, `summaryFromStatus()`, over the same four fields the backend
 * persists (`forge-control/src/lib/connection-status.ts`):
 *
 *     state · identity · checked_at · detail
 *
 * and the rule that made this phase worth doing is applied once, there, rather
 * than four times in four components:
 *
 *   R57  `checked_at === null` renders UNKNOWN, in amber, ALWAYS — whatever
 *        `state` the server sent, whatever is on disk. A credential file
 *        proves storage, not authorisation.
 *   R51  a `checked_at` older than STALE_FACTOR × the re-check interval also
 *        renders UNKNOWN. Evidence has a shelf life; a two-day-old 200 is no
 *        more current than a two-day-old 401.
 *   R58  a failure's `detail` is printed VERBATIM, upstream status code and
 *        body included. Never paraphrased: Konrad has to be able to tell an
 *        expired token from a network outage.
 *
 * And `identity` is what the PROBE RETURNED, never what a config file says.
 * Displaying a configured email as if it were verified is the same lie in a
 * smaller font — so `summaryFromStatus` reads the identity only out of the
 * probe status, and there is no parameter through which a caller could supply
 * one from anywhere else.
 *
 * THIS IS LAYER THREE OF R57. Layer one is `effectiveHealth()` in the API
 * (`forge-control/src/lib/account-health.ts`); layer two is
 * `renderSafeAccount()` at the registry boundary (`accountRegistry.tsx`). Both
 * belong to B4a. This layer exists because those two key off `last_probed_at`
 * while the age LABEL keys off `probe_age_ms`, and an API build that emits one
 * without the other slips between them — photographed on 2026-08-18 at
 * `phase4/b4c-before-integrations.png`, where `arved` renders a green
 * SERVING RUNS chip with the words "never probed" beside it. A row whose chip
 * and whose clock disagree is worse than either alone.
 */

import type { Account } from "./accountRegistry";
import type { GeminiTally } from "../quota/quotaQuery";
import type { ConnectionStatus } from "../../api-connections";

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

/* ════════════════════════════════════════════════════════════════════════════
 * THE SHARED LAYER — one shape, one set of rules, four connections.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * How many re-check intervals a probe result may age before it stops counting
 * as evidence.
 *
 * DUPLICATED, DELIBERATELY, from `STALE_FACTOR` in
 * `forge-control/src/lib/connection-status.ts`. The two packages have separate
 * `package.json`s and neither imports the other's `src/`, so there is no
 * import that would make this one number. It is three in both places and the
 * check below asserts the boundary in this file's own terms; if the server's
 * factor ever changes, this rule gets STRICTER or looser than the server's,
 * never silently absent — the server has already demoted a stale record before
 * it reaches here, so this layer can only ever under-claim.
 */
export const STALE_FACTOR = 3;

/** Mirrors `DEFAULT_CONNECTION_RECHECK_INTERVAL_MS` in the API, for the one
 *  caller that has no response to read it from: the Claude registry endpoint
 *  does not report an interval, because its rows carry a server-measured age
 *  instead. Every other connection passes the server's real number. */
export const DEFAULT_RECHECK_INTERVAL_MS = 900_000;

/** The four fields the backend persists per connection, plus the next step it
 *  wrote next to them. Structurally the wire's `ConnectionStatus` minus its
 *  `id`, which the copy below supplies. */
export type ConnectionStatusFacts = Omit<ConnectionStatus, "id">;

/** The words that differ per connection. Everything else about a row is
 *  decided by the state, which is why this is data and not four functions. */
export interface ConnectionCopy {
  id: string;
  title: string;
  what: string;
  /** Per-state chip words. "NOT ANSWERING" and "REJECTED" are both `broken`
   *  and mean different things to the person reading them, which is exactly
   *  why `stateLabel` is not derived from `state` alone. */
  labels: Record<ConnectionState, string>;
  /** What to print for `identity` when there is nothing verified to print.
   *  Never an address from configuration. */
  noIdentity: string;
}

export interface ConnectionClock {
  /** Epoch ms. Passed in rather than read inside, so this layer is pure and a
   *  fixture can sit a record on either side of the staleness boundary. */
  nowMs: number;
  /** The server's own re-check cadence, from `GET /connections`'
   *  `recheck_interval_ms`. Not a constant invented here: a status re-checked
   *  every 15 minutes but demoted only after an hour of some other number is a
   *  lie with extra steps. */
  intervalMs: number;
}

/** "4 min", "3 h", "2 d", "just now" — the same vocabulary `probeAge()` in
 *  accountRegistry.tsx uses, so one surface does not speak two dialects. */
export function ageWords(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const m = Math.floor(ageMs / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** "probed 4 min ago" / "probed just now". */
export function probedAgo(ageMs: number): string {
  return ageMs < 60_000 ? "probed just now" : `probed ${ageWords(ageMs)} ago`;
}

/**
 * THE function every connection's row goes through.
 *
 * Rule order matters and every rule can only move the verdict in the
 * under-claiming direction:
 *
 *   1. state `absent`             → the substrate is missing; nothing to check
 *   2. `checked_at` null          → UNKNOWN (R57, verbatim)
 *   3. `checked_at` unparseable   → THROW. A corrupt store is not a state, and
 *                                   `?? Date.now()` here would silently mint
 *                                   freshness out of a broken record (N1).
 *   4. `checked_at` in the future → UNKNOWN (a clock we cannot trust)
 *   5. age > STALE_FACTOR×interval→ UNKNOWN (R51)
 *   6. state `connected`          → CONNECTED, with the probe's identity
 *   7. otherwise                  → BROKEN, `detail` verbatim (R58)
 */
export function summaryFromStatus(
  copy: ConnectionCopy,
  status: ConnectionStatusFacts,
  clock: ConnectionClock,
): ConnectionSummary {
  if (!Number.isFinite(clock.intervalMs) || clock.intervalMs <= 0) {
    throw new Error(
      `summaryFromStatus needs a positive intervalMs for ${copy.id}, got ${JSON.stringify(clock.intervalMs)}`,
    );
  }

  const base = { id: copy.id, title: copy.title, what: copy.what };

  if (status.state === "absent") {
    return {
      ...base,
      state: "absent",
      stateLabel: copy.labels.absent,
      identity: copy.noIdentity,
      health: status.detail,
      action: status.action,
    };
  }

  const unknown = (health: string): ConnectionSummary => ({
    ...base,
    state: "unknown",
    stateLabel: copy.labels.unknown,
    identity: copy.noIdentity,
    health,
    action: status.action,
  });

  if (status.checked_at === null) {
    return unknown(
      `Never checked — no probe has ever run, so nothing here is evidence that this works. ` +
        `That is why this row is amber and not green.`,
    );
  }

  const at = Date.parse(status.checked_at);
  if (Number.isNaN(at)) {
    throw new Error(
      `the ${copy.id} connection's checked_at ${JSON.stringify(status.checked_at)} is not a parseable timestamp`,
    );
  }

  const ageMs = clock.nowMs - at;
  const staleAfterMs = clock.intervalMs * STALE_FACTOR;

  if (ageMs < 0) {
    return unknown(
      `The last check is dated ${status.checked_at}, which is in the future — this box's clock ` +
        `or that record is wrong, so the verdict is not trustworthy. Stored text: ${status.detail}`,
    );
  }

  if (ageMs > staleAfterMs) {
    return unknown(
      `Stale — ${probedAgo(ageMs)} (${status.checked_at}), past the ${ageWords(staleAfterMs)} shelf ` +
        `life (${STALE_FACTOR} × the ${ageWords(clock.intervalMs)} re-check interval). The last answer ` +
        `was ${status.state === "connected" ? "a success" : "a failure"}: ${status.detail}`,
    );
  }

  if (status.state === "connected") {
    return {
      ...base,
      state: "connected",
      stateLabel: copy.labels.connected,
      // Only ever the probe's own answer. There is no configuration fallback
      // here and no parameter to supply one through.
      identity: status.identity ?? `${copy.noIdentity} — the probe returned no identity`,
      health: `${probedAgo(ageMs)}. ${status.detail}`,
      action: status.action,
    };
  }

  return {
    ...base,
    state: "broken",
    stateLabel: copy.labels.broken,
    identity: copy.noIdentity,
    // VERBATIM (R58). `detail` already carries the upstream's status code and
    // body; nothing here paraphrases it, truncates it or replaces it.
    health: `${probedAgo(ageMs)}. ${status.detail}`,
    action: status.action,
  };
}

/**
 * A Claude account's probe age, or null when there is no USABLE one.
 *
 * "Usable" is deliberately the conjunction of both fields, and this is the
 * predicate that closes the gap between R57's first two layers. `probe_age_ms`
 * alone is not enough — an older forge-control omits it entirely, and
 * `undefined` is not `null`, so a strict null check let it through and the row
 * rendered `probed NaN d ago`. `last_probed_at` alone is not enough either —
 * that is precisely the field layer two keys off, and an API build that sends
 * it WITHOUT `probe_age_ms` renders a green chip beside the words "never
 * probed". Requiring both means every disagreement between the two resolves to
 * "we do not know", which is the safe direction.
 */
export function claudeProbeAgeMs(a: Account): number | null {
  if (!Number.isFinite(a.probe_age_ms) || a.last_probed_at === null) return null;
  return a.probe_age_ms as number;
}

/**
 * A Claude account, as a connection row.
 *
 * The health mapping is the registry's own — this adds no second opinion about
 * what healthy means. It adds two vetoes, both in the under-claiming
 * direction: a positive health word with no probe behind it (R57), and one
 * whose probe has aged past the shelf life (R51).
 *
 * There is no `nowMs` here, unlike the other three connections, and that is
 * deliberate: this row's age is `probe_age_ms`, already measured against the
 * SERVER's clock, so a skewed browser clock cannot invent or erase staleness.
 * `intervalMs` has a default because the accounts endpoint reports no cadence
 * of its own; every other connection is handed the server's real number.
 */
export function claudeConnection(
  a: Account,
  serving: boolean,
  intervalMs: number = DEFAULT_RECHECK_INTERVAL_MS,
): ConnectionSummary {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `claudeConnection needs a positive intervalMs for ${a.slug}, got ${JSON.stringify(intervalMs)}`,
    );
  }
  const ageMs = claudeProbeAgeMs(a);

  // VETO ONE (R57): "healthy" with no usable probe age is not a reading.
  // VETO TWO (R51): "healthy" whose probe has aged past 3× the interval is a
  // reading with an expired shelf life. Both demote, neither promotes, and
  // `broken` is left alone in both — there, unlike here, the stored verdict is
  // durable operator knowledge about a credential rather than one call's result.
  const measured = ageMs !== null;
  const stale = measured && ageMs > intervalMs * STALE_FACTOR;
  const health: Account["health"] =
    a.health === "healthy" && (!measured || stale) ? "unknown" : a.health;
  const vetoed = health !== a.health;

  const state: ConnectionState =
    health === "healthy" ? "connected" : health === "broken" ? "broken" : "unknown";

  // The age travels WITH the health word or the word does not travel (R45).
  const aged = (sentence: string): string =>
    measured ? `${probedAgo(ageMs)}. ${sentence}` : sentence;

  return {
    id: `claude:${a.slug}`,
    title: a.slug,
    what: "A Claude Code login. Runs execute as this account; the fleet fails over between them by priority.",
    state,
    stateLabel:
      health === "healthy"
        ? serving
          ? "SERVING RUNS"
          : "CONNECTED"
        : health === "broken"
          ? "BROKEN"
          : "UNKNOWN — NOT PROBED",
    // R50, AND THE ONE PLACE THIS SURFACE CANNOT SATISFY IT THE USUAL WAY.
    // A Claude account has no probe-returned address AT ALL: `login_email` was
    // typed in when the account was registered, which is why the API ships
    // `login_email_source: "configuration"` beside it, and the cheap-tier probe
    // reads the credential file for PRESENCE and never learns an address. So
    // this is the one identity on the surface that is configuration — and it is
    // labelled as configuration, in every state, rather than sat in a slot the
    // other three fill with a verified answer. `check-connection-states.ts`
    // §5's discrimination control is what found this: the bare address passed
    // "shows the probe's identity" on the never-probed fixture too, which is
    // the definition of a claim that measures nothing.
    identity:
      a.login_email === null
        ? "no address on record — the probe reads the credential file's presence, not its owner"
        : `${a.login_email} — CONFIGURED, not verified: no Claude probe returns an address`,
    health: vetoed
      ? stale
        ? `Stale — ${probedAgo(ageMs as number)}, past the ${ageWords(intervalMs * STALE_FACTOR)} shelf ` +
          `life (${STALE_FACTOR} × the ${ageWords(intervalMs)} re-check interval). The registry stores ` +
          `“${a.health_detail ?? "healthy"}”, but that answer has expired. Not known to work — that is ` +
          `why this is amber and not green.`
        : `The registry stores “${a.health_detail ?? "healthy"}”, but no probe age came with it, so it is ` +
          `not a reading. Not known to work — that is why this is amber and not green.`
      : health === "unknown"
        ? aged(
            "Never confirmed by a run or a probe. Not known to work — that is why this is amber and not green.",
          )
        : aged(a.health_detail ?? "no detail recorded"),
    action:
      health === "broken"
        ? `Re-authenticate on the VPS: ${a.reauth_command}`
        : health === "unknown"
          ? "Press “Probe now” below to find out whether this login still works."
          : "Nothing to do. Use “Probe now” to re-confirm at any time.",
  };
}

/* ── Google Workspace (R48–R51) ──────────────────────────────────────────── */

const GOOGLE_COPY: ConnectionCopy = {
  id: "google",
  title: "Google Workspace",
  what: "The Gmail, Calendar, Drive, Docs and Sheets consent this box runs on. One OAuth credential, shared by every agent that touches Google.",
  labels: {
    connected: "CONNECTED",
    // "UNVERIFIED", not "UNKNOWN": for Google the credential file is right
    // there on disk, and the honest complaint is that nobody has asked it to
    // prove anything — not that we have never heard of it.
    unknown: "UNVERIFIED",
    broken: "NOT ANSWERING",
    absent: STATE_LABEL.absent,
  },
  noIdentity: "no verified address — only a live check can produce one",
};

/**
 * What the Google card reports upward.
 *
 * `status` is the WHOLE state: it is the persisted probe record
 * (`GET /api/integrations/google` → `status`), which survives a
 * `pm2 restart forge-control` — that is R48, and B4b's
 * `phase4/google-persistence-proof.md` §5 is the before/after transcript.
 *
 * Everything else in here is DECORATION and is labelled as such: scope count
 * and refresh-token presence describe the file, and the file proves storage,
 * not authorisation. Note what is NOT in this interface any more: `email`.
 * There is no way to hand this function an address from configuration, because
 * R50 says the address must be the one Gmail's profile call returned, and the
 * cheapest way to guarantee that is to delete the parameter that could carry
 * anything else.
 */
export interface GoogleFacts {
  status: ConnectionStatusFacts;
  /** A credential file exists at all. False ⇒ the status is `absent`. */
  hasAccount: boolean;
  hasRefreshToken: boolean;
  scopeCount: number;
  reauthCommand: string;
  /** The server's re-check cadence, from `GET /connections`. */
  recheckIntervalMs: number;
}

export function googleConnection(
  f: GoogleFacts | null,
  nowMs: number = Date.now(),
): ConnectionSummary {
  if (f === null) {
    return {
      id: GOOGLE_COPY.id,
      title: GOOGLE_COPY.title,
      what: GOOGLE_COPY.what,
      state: "unknown",
      stateLabel: "READING…",
      identity: "not read yet",
      health: "Loading the persisted status.",
      action: "Loading…",
    };
  }

  const summary = summaryFromStatus(GOOGLE_COPY, f.status, {
    nowMs,
    intervalMs: f.recheckIntervalMs,
  });

  // The file's own facts ride ALONG with the verdict, never instead of it. A
  // missing refresh token is the one file-level fact that predicts a future
  // failure, so it is said out loud — but it still cannot turn a green row
  // amber or an amber row green, because `summary.state` is already decided.
  if (summary.state === "absent" || f.hasAccount === false) return summary;
  return {
    ...summary,
    health: `${summary.health} Credential file: ${f.scopeCount} scopes${
      f.hasRefreshToken ? " and a refresh token" : " but NO refresh token, so it cannot renew itself"
    }.`,
    action: f.hasRefreshToken
      ? summary.action
      : `Re-authorise on the VPS: ${f.reauthCommand}`,
  };
}

/* ── agy / Antigravity CLI (R52–R54) ─────────────────────────────────────── */

const AGY_COPY: ConnectionCopy = {
  id: "agy",
  title: "Antigravity CLI (agy)",
  what: "Google's `agy` CLI, the only path from this box to Konrad's AI Ultra subscription. Signing it in needs a human at a terminal: there is no login subcommand and no callback this OS can catch.",
  labels: {
    connected: "SIGNED IN",
    unknown: "UNKNOWN",
    // The probe RAN and the CLI said no. That is a different sentence from
    // "we have not asked", and it deserves a different word.
    broken: "NOT SIGNED IN",
    absent: "NOT INSTALLED",
  },
  noIdentity: "no signed-in Google account — `agy models` is what would reveal one",
};

export interface AgyFacts {
  status: ConnectionStatusFacts;
  recheckIntervalMs: number;
}

export function agyConnection(
  f: AgyFacts | null,
  nowMs: number = Date.now(),
): ConnectionSummary {
  if (f === null) {
    return {
      id: AGY_COPY.id,
      title: AGY_COPY.title,
      what: AGY_COPY.what,
      state: "unknown",
      stateLabel: "READING…",
      identity: "not read yet",
      health: "Loading the persisted status.",
      action: "Loading…",
    };
  }
  return summaryFromStatus(AGY_COPY, f.status, {
    nowMs,
    intervalMs: f.recheckIntervalMs,
  });
}

/* ── GitHub (R55, R56) ───────────────────────────────────────────────────── */

const GITHUB_COPY: ConnectionCopy = {
  id: "github",
  title: "GitHub",
  what: "A personal access token, used to push work branches and open pull requests. Stored in the secure secret store; the browser can write it and can never read it back.",
  labels: {
    connected: "CONNECTED",
    unknown: "UNVERIFIED",
    // "REJECTED", because the only thing that gets here is a real
    // GET /user that came back with something other than a 200 and a login.
    broken: "REJECTED",
    // NOT "no token": absent means no secret is stored at all. A stored token
    // that has never been probed is UNVERIFIED, above — "token present" is
    // storage, not authorisation, and the two must not share a word.
    absent: "NO TOKEN STORED",
  },
  noIdentity: "no verified login — only GET https://api.github.com/user produces one",
};

export interface GithubFacts {
  status: ConnectionStatusFacts;
  /** The NAME the token is stored under. The name travels; the value never
   *  leaves the server, is never echoed, and is never in a URL (R55). */
  secretName: string;
  recheckIntervalMs: number;
}

export function githubConnection(
  f: GithubFacts | null,
  nowMs: number = Date.now(),
): ConnectionSummary {
  if (f === null) {
    return {
      id: GITHUB_COPY.id,
      title: GITHUB_COPY.title,
      what: GITHUB_COPY.what,
      state: "unknown",
      stateLabel: "READING…",
      identity: "not read yet",
      health: "Loading the persisted status.",
      action: "Loading…",
    };
  }
  return summaryFromStatus(GITHUB_COPY, f.status, {
    nowMs,
    intervalMs: f.recheckIntervalMs,
  });
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
