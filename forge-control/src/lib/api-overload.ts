/**
 * Transient API-overload survival — the pure logic behind "wait a minute and
 * try again".
 *
 * Context (2026-08-24, this chat's own executor turn): a run died with
 *
 *   Executor failed: claude-code exit 1: API Error: 529 Overloaded. This is a
 *   server-side issue, usually temporary — try again in a moment. If it
 *   persists, check https://status.claude.com.
 *
 * project-tick's reconcile did what it does for any failure it does not
 * recognise: marked the task `failed` and flipped the project to `blocked`.
 * That is the 2026-08-05 usage-wall incident again with a different signature —
 * a self-clearing, server-side condition being written up as a broken task, on
 * a fleet that runs unattended overnight and cannot un-wedge itself.
 *
 * Nothing is broken when this fires. Anthropic's own error text says
 * "usually temporary — try again in a moment", and KONRAD'S INSTRUCTION IS
 * EXACTLY THAT: "if this error occurs, make sure that you retry after one
 * minute". So one minute is the delay, and it is not a ladder: a 529 is not
 * a quota with a published reset time (that is `usage-wall.ts`, which parses
 * the reset out of the message and can defer for hours). It is a busy server.
 * The right response is a short, flat wait, repeated a bounded number of times.
 *
 * MEASURED SCOPE, so nobody over-reads this file: across 1093 historical runs,
 * three ever ENDED on this signature and two of those failed. The string
 * appears in ~330 threads, but almost all of those are a builder's own prompt
 * quoting the error. This is a rare failure with an outsized blast radius (one
 * unhandled 529 blocks a project until a human calls /unwedge), not a hot path.
 *
 * Kept separate from `usage-wall.ts` on purpose. Same machinery — park the run
 * behind `runs.wake_after`, leave the task `running` and the project `active` —
 * but a different cause, a different delay policy and a SEPARATE attempt
 * counter. Sharing `metadata.usage_wall_attempts` between the two would let a
 * busy-server blip burn the retries that a real quota wall needs, and would
 * make each outage's give-up decision depend on the other's history.
 */

/** What kind of transient server condition the error text describes. */
export type ApiOverloadKind = "overloaded" | "unavailable";

export interface ApiOverloadSignature {
  kind: ApiOverloadKind;
  /** The HTTP status actually seen in the text, when one was. */
  status: number | null;
}

/**
 * Recognise a transient, server-side API failure in an executor error string.
 *
 * DELIBERATELY NARROW. This function's output parks a task instead of failing
 * it, so a false positive hides a real bug behind a retry loop that looks like
 * progress. It matches only what Anthropic's client actually emits for a busy
 * or unreachable API:
 *
 *   - `529` / "Overloaded"  — the API is over capacity
 *   - `503` / "Service Unavailable" — same class, same remedy
 *
 * It does NOT match a bare 5xx, "internal server error", a timeout, or a
 * network reset. Those can equally be a genuine defect in what the worker
 * asked for, and a wrong guess here is worse than a failed task: a task that
 * fails is visible and retryable by hand, a task parked forever is not.
 *
 * It also does not match the usage-wall wording — `classifyUsageWall` owns
 * that, runs first in the reconcile, and parses a reset time this function has
 * no business inventing.
 *
 * @param text `last_error` — the run's final `error`/`stuck_notice` entry, or
 *   null when the run left none.
 */
export function classifyApiOverload(
  text: string | null | undefined,
): ApiOverloadSignature | null {
  if (!text) return null;

  // A usage wall is the narrower, better-informed signature and has its own
  // handler. Bail rather than race it, even though the reconcile already
  // orders us second — this function is exported and unit-tested on its own,
  // and must not be a trap for the next caller.
  if (/\b(session|weekly)\s+limit\b/i.test(text)) return null;

  if (/\b529\b/.test(text) || /\boverloaded\b/i.test(text)) {
    const m = text.match(/\b(529)\b/);
    return { kind: "overloaded", status: m ? Number(m[1]) : null };
  }
  if (/\b503\b/.test(text) || /\bservice unavailable\b/i.test(text)) {
    const m = text.match(/\b(503)\b/);
    return { kind: "unavailable", status: m ? Number(m[1]) : null };
  }
  return null;
}

/** Konrad's instruction, literally: "retry after one minute". Flat, not a
 *  ladder — see the module header for why a busy server is not a quota. */
export const API_OVERLOAD_DEFER_MS = 60_000;

/**
 * How many times one run may be parked for this before it is allowed to fail.
 *
 * Five minutes of total patience. Anthropic's 529s clear in seconds to a
 * couple of minutes; a condition still firing after five consecutive
 * one-minute waits is an outage, and an outage should surface as a failed task
 * Konrad can see rather than a task that quietly retries until morning. The
 * give-up path is the honest end of a retry policy, not its failure.
 */
export const API_OVERLOAD_MAX_RETRIES = 5;

export type ApiOverloadRetryPlan =
  | {
      action: "defer";
      /** 1-based attempt number to persist for the next reconcile. */
      attempt: number;
      wakeAtMs: number;
      delayMs: number;
    }
  | { action: "give_up"; reason: string };

/**
 * Decide whether to park this run again, given how often it has already been
 * parked for the same reason.
 *
 * Pure and clock-injected so the policy is testable without waiting a minute.
 */
export function planApiOverloadRetry(input: {
  /** `metadata.api_overload_attempts` of the run that just died; 0 first time. */
  priorAttempts: number;
  nowMs: number;
}): ApiOverloadRetryPlan {
  // Corrupt metadata is not a licence to retry forever. The counter comes from
  // `(metadata->>'api_overload_attempts')::int` so a non-finite value should be
  // unreachable — but if it ever happens, GIVE UP rather than defer. Of the two
  // ways to be wrong here, failing a task that could have been retried is
  // visible in the Kanban and fixable with one /retry; retrying a task forever
  // is neither, and it burns a worker slot all night.
  if (!Number.isFinite(input.priorAttempts)) {
    return {
      action: "give_up",
      reason: `api_overload_attempts is not a finite number (${String(input.priorAttempts)})`,
    };
  }
  // Negative means "no history" — a floor of 0, not a bonus retry.
  const prior = input.priorAttempts > 0 ? Math.floor(input.priorAttempts) : 0;

  if (prior >= API_OVERLOAD_MAX_RETRIES) {
    return {
      action: "give_up",
      reason: `already parked ${prior}x for a transient API overload (max ${API_OVERLOAD_MAX_RETRIES})`,
    };
  }

  return {
    action: "defer",
    attempt: prior + 1,
    delayMs: API_OVERLOAD_DEFER_MS,
    wakeAtMs: input.nowMs + API_OVERLOAD_DEFER_MS,
  };
}
