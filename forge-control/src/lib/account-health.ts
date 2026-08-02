/**
 * Claude account health — the pure logic behind health-failover.
 *
 * Context: on 2026-08-02 the whole AI OS stopped because /root/.claude's
 * credentials were zeroed (access token 0 bytes, refresh token 0 bytes,
 * expiresAt 0) and nothing noticed. A second account had been dead since
 * 2026-06-03 — for two months — because nothing ever exercised it and nothing
 * ever asked. See docs/superpowers/specs/2026-08-02-claude-account-health-
 * failover-design.md.
 *
 * Everything here is pure and synchronous so it can be tested without a
 * database, a filesystem, or a network. The I/O lives in db/claude-accounts.ts
 * and lib/account-prober.ts.
 */

/** Three states, and `unknown` is NEVER rendered or treated as healthy. */
export type Health = "healthy" | "broken" | "unknown";

/** What `<config_dir>/.credentials.json` told us. No secrets — presence only. */
export interface CredentialSnapshot {
  exists: boolean;
  parseable: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  /** Epoch ms. Deliberately NOT used for health — see classifyCredential. */
  expiresAt: number | null;
}

export interface HealthVerdict {
  health: Health;
  detail: string;
}

/**
 * Default window after which an account with no CONFIRMED successful run is
 * demoted to `unknown`. This is the check that catches a silently-revoked
 * account whose credential file still looks structurally fine.
 */
export const DEFAULT_UNEXERCISED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cheap-tier classification: credential file + last-known-good run.
 *
 * On the access-token clock: a healthy Claude credential expires roughly EIGHT
 * HOURS after it is issued, and the refresh token renews it silently and
 * continuously. An earlier draft of the design classified "expires within 7
 * days" as `expiring`, which would have marked every healthy account as
 * expiring permanently, forever. That number looks meaningful and is not, so
 * `expiresAt` is recorded for display but deliberately does NOT feed health.
 *
 * What actually separates a corpse from a working account is whether a refresh
 * token exists at all, and whether anything has successfully used the account
 * recently.
 */
export function classifyCredential(
  snap: CredentialSnapshot,
  opts: {
    now: number;
    /** Last CONFIRMED successful run on this account, epoch ms. */
    lastOkAt: number | null;
    unexercisedAfterMs?: number;
  },
): HealthVerdict {
  if (!snap.exists) {
    return { health: "broken", detail: "no credential file — never logged in" };
  }
  if (!snap.parseable) {
    return { health: "broken", detail: "credential file is not valid JSON" };
  }
  // The exact shape of the 2026-08-02 outage: the CLI zeroed the tokens in
  // place after a refresh failed, leaving a credential object with no
  // credentials in it. Nothing left to refresh with — only a re-login fixes it.
  if (!snap.hasRefreshToken) {
    return {
      health: "broken",
      detail: "credentials blanked (no refresh token) — re-login required",
    };
  }
  if (!snap.hasAccessToken) {
    return {
      health: "broken",
      detail: "no access token — re-login required",
    };
  }

  const window = opts.unexercisedAfterMs ?? DEFAULT_UNEXERCISED_MS;
  if (opts.lastOkAt === null) {
    return {
      health: "unknown",
      detail: "never confirmed working — no successful run on record",
    };
  }
  const idleMs = opts.now - opts.lastOkAt;
  if (idleMs > window) {
    const days = Math.floor(idleMs / 86_400_000);
    return {
      health: "unknown",
      detail: `unexercised — no confirmed successful run in ${days} days`,
    };
  }

  return { health: "healthy", detail: "credential present, recently confirmed" };
}

/* ------------------------------------------------------------------------- *
 * Error classification — the safety-critical function.
 * ------------------------------------------------------------------------- */

export type ErrorClass = "auth" | "rate_limit" | "other";

/**
 * Rate-limit patterns are checked FIRST and win over auth patterns when both
 * match. This ordering is load-bearing.
 *
 * Failover on `auth` moves off a BROKEN account. Failing over on `rate_limit`
 * would move off a BUSY account onto another account to obtain more capacity
 * than one account provides — the limit-circumvention behaviour this system
 * deliberately does not implement (design §3, non-goal 1). A misclassification
 * of rate-limit as auth silently builds exactly that. So when a message is
 * ambiguous, rate_limit wins, and anything unrecognised is `other`, which does
 * not fail over at all.
 */
const RATE_LIMIT_RE =
  /rate[ _-]?limit|\b429\b|usage limit|quota exceeded|too many requests|limit reached|resets? at/i;

const AUTH_RE =
  /failed to authenticate|oauth session expired|could not be refreshed|invalid[ _-]?grant|unauthorized|authentication failed|not logged in|\b401\b/i;

export function classifyError(message: string | null | undefined): ErrorClass {
  if (!message) return "other";
  if (RATE_LIMIT_RE.test(message)) return "rate_limit";
  if (AUTH_RE.test(message)) return "auth";
  return "other";
}

/** Only an auth failure justifies moving to a different account. */
export function shouldFailover(message: string | null | undefined): boolean {
  return classifyError(message) === "auth";
}

/* ------------------------------------------------------------------------- *
 * Selection
 * ------------------------------------------------------------------------- */

export interface SelectableAccount {
  slug: string;
  configDir: string;
  enabled: boolean;
  health: Health;
  /** Lower wins. */
  priority: number;
  healthDetail?: string | null;
}

export class NoHealthyAccountError extends Error {
  readonly diagnosis: string;
  constructor(accounts: SelectableAccount[]) {
    const lines =
      accounts.length === 0
        ? ["  (no accounts are registered at all)"]
        : accounts.map(
            (a) =>
              `  - ${a.slug} [${a.enabled ? a.health : "disabled"}] ${a.configDir}` +
              (a.healthDetail ? ` — ${a.healthDetail}` : ""),
          );
    const diagnosis = `No usable Claude account.\n${lines.join("\n")}`;
    super(diagnosis);
    this.name = "NoHealthyAccountError";
    this.diagnosis = diagnosis;
  }
}

const RANK: Record<Health, number> = { healthy: 0, unknown: 1, broken: 99 };

/**
 * Deterministic selection: best health first, then lowest priority, then slug
 * so the choice never depends on row order.
 *
 * `unknown` accounts remain selectable — unproven is not condemned, and
 * selecting one is exactly how it becomes proven. They simply lose to any
 * account known to work. `broken` accounts are excluded outright.
 */
export function rankAccounts(
  accounts: SelectableAccount[],
): SelectableAccount[] {
  return accounts
    .filter((a) => a.enabled && a.health !== "broken")
    .sort(
      (x, y) =>
        RANK[x.health] - RANK[y.health] ||
        x.priority - y.priority ||
        x.slug.localeCompare(y.slug),
    );
}

/** Throws NoHealthyAccountError with a full per-account diagnosis. */
export function pickAccount(accounts: SelectableAccount[]): SelectableAccount {
  const ranked = rankAccounts(accounts);
  if (ranked.length === 0) throw new NoHealthyAccountError(accounts);
  return ranked[0]!;
}

/**
 * The account to retry on after `failed` died with an auth error, or null when
 * there is nowhere left to go. Failover is capped at one hop per run by the
 * caller, so this is only ever consulted once.
 */
export function pickFailoverAccount(
  accounts: SelectableAccount[],
  failedSlug: string,
): SelectableAccount | null {
  const ranked = rankAccounts(accounts).filter((a) => a.slug !== failedSlug);
  return ranked[0] ?? null;
}
