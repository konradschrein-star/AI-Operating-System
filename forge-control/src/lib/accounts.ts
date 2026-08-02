/**
 * Account service — joins the pure health logic (lib/account-health.ts) to the
 * filesystem (credential files) and the registry (db/claude-accounts.ts).
 *
 * Health-failover only: a BROKEN account is skipped, a RATE-LIMITED account is
 * not. See the design spec §3 non-goal 1 and §6.3.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  classifyCredential,
  classifyError,
  pickAccount,
  pickFailoverAccount,
  NoHealthyAccountError,
  type CredentialSnapshot,
  type SelectableAccount,
} from "./account-health.ts";
import {
  listAccounts,
  recordProbe,
  markSuccess,
  markAuthFailure,
  type AccountRow,
} from "../db/claude-accounts.ts";
import { queueNotification } from "../db/notifications.ts";

export { NoHealthyAccountError };

interface OauthBlob {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Inspect `<configDir>/.credentials.json`. Presence only — no token material
 * is returned, logged, or stored.
 */
export async function readCredentialSnapshot(
  configDir: string,
): Promise<CredentialSnapshot> {
  const path = join(configDir, ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      exists: false,
      parseable: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      expiresAt: null,
    };
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OauthBlob };
    const o = parsed.claudeAiOauth ?? {};
    return {
      exists: true,
      parseable: true,
      // Length checks, not truthiness: the 2026-08-02 failure left the keys
      // present with empty-string values, which is truthy-adjacent enough to
      // fool a sloppy check.
      hasAccessToken: (o.accessToken ?? "").length > 0,
      hasRefreshToken: (o.refreshToken ?? "").length > 0,
      expiresAt: typeof o.expiresAt === "number" && o.expiresAt > 0 ? o.expiresAt : null,
    };
  } catch {
    return {
      exists: true,
      parseable: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      expiresAt: null,
    };
  }
}

function toSelectable(a: AccountRow): SelectableAccount {
  return {
    slug: a.slug,
    configDir: a.configDir,
    enabled: a.enabled,
    health: a.health,
    priority: a.priority,
    healthDetail: a.healthDetail,
  };
}

/** Probe one account (cheap tier) and persist the verdict. */
export async function probeAccount(a: AccountRow): Promise<{
  slug: string;
  health: string;
  previous: string;
  detail: string;
  changed: boolean;
}> {
  const snap = await readCredentialSnapshot(a.configDir);
  const verdict = classifyCredential(snap, {
    now: Date.now(),
    lastOkAt: a.lastOkAt ? a.lastOkAt.getTime() : null,
  });
  await recordProbe(a.slug, {
    health: verdict.health,
    detail: verdict.detail,
    hasRefresh: snap.exists && snap.parseable ? snap.hasRefreshToken : null,
    accessExpiresAt: snap.expiresAt ? new Date(snap.expiresAt) : null,
  });
  const result = {
    slug: a.slug,
    health: verdict.health,
    previous: a.health,
    detail: verdict.detail,
    changed: a.health !== verdict.health,
  };

  // Alert HERE, where the transition is detected, rather than in the caller.
  // An earlier version alerted only inside probeAll(), which meant a manual
  // probe from the settings page could discover a broken account and say
  // nothing — the same "detected but not surfaced" gap this whole feature
  // exists to close.
  await alertOnTransition({ ...result, configDir: a.configDir }).catch((e) =>
    console.error("[accounts] alert failed:", e.message),
  );

  return result;
}

/* ------------------------------------------------------------------------- *
 * Alerting
 * ------------------------------------------------------------------------- */

const ALERT_DEBOUNCE_MS = 6 * 60 * 60_000;
/** slug:state → last alert time. In-memory: a restart may re-alert, which is
 *  the safe direction to be wrong in. */
const lastAlerted = new Map<string, number>();

function reauthCommand(configDir: string): string {
  return configDir === "/root/.claude"
    ? "claude auth login --claudeai"
    : `CLAUDE_CONFIG_DIR=${configDir} claude auth login --claudeai`;
}

/**
 * Alert on health TRANSITIONS only, debounced per account+state.
 *
 * There is deliberately no "token expires soon" alert: a Claude access token
 * expires roughly every 8 hours by design and is renewed automatically, so
 * such an alert would fire permanently and train the reader to ignore the
 * channel. The alerts here fire on states that actually need a human.
 */
async function alertOnTransition(r: {
  slug: string;
  health: string;
  previous: string;
  detail: string;
  configDir: string;
  changed: boolean;
}): Promise<void> {
  if (!r.changed) return;
  const key = `${r.slug}:${r.health}`;
  const last = lastAlerted.get(key) ?? 0;
  if (Date.now() - last < ALERT_DEBOUNCE_MS) return;

  let text: string | null = null;
  if (r.health === "broken") {
    text =
      `🔴 Claude account "${r.slug}" is BROKEN.\n${r.detail}\n\n` +
      `The AI OS will skip it. Fix with:\n${reauthCommand(r.configDir)}`;
  } else if (r.health === "unknown") {
    // The alert that would have caught the account which died in June and sat
    // unnoticed until August.
    text =
      `🟡 Claude account "${r.slug}" is unverified.\n${r.detail}\n\n` +
      `Its credential file looks fine, but a dead account's file looks ` +
      `identical to a live one's — only a successful run proves it works.`;
  } else if (r.health === "healthy" && r.previous === "broken") {
    text = `🟢 Claude account "${r.slug}" is working again.`;
  }
  if (!text) return;

  lastAlerted.set(key, Date.now());
  await queueNotification(text, "accounts");
}

/**
 * Probe every ENABLED account.
 *
 * Disabled accounts are skipped deliberately. The cheap tier cannot tell a
 * revoked account from a working one — it can only say "I don't know" — so
 * probing a disabled account would overwrite operator knowledge ("expired
 * 2026-06-03, not re-authenticated by choice") with a less informative
 * `unknown`. Re-enabling an account, or an explicit probe from the settings
 * page, still probes it via probeAccount().
 */
export async function probeAll(): Promise<
  Array<{ slug: string; health: string; detail: string; changed: boolean }>
> {
  const accounts = (await listAccounts()).filter((a) => a.enabled);
  const out = [];
  // probeAccount alerts on its own transitions.
  for (const a of accounts) out.push(await probeAccount(a));
  return out;
}

/**
 * Choose the account for a run. Throws NoHealthyAccountError naming every
 * account and why it was rejected — the diagnosis that was missing on the
 * morning of 2026-08-02, when the only message was a bare auth failure.
 */
export async function resolveAccount(): Promise<SelectableAccount> {
  const accounts = (await listAccounts()).map(toSelectable);
  return pickAccount(accounts);
}

/** The account to retry on after an AUTH failure, or null if there is none. */
export async function resolveFailoverAccount(
  failedSlug: string,
): Promise<SelectableAccount | null> {
  const accounts = (await listAccounts()).map(toSelectable);
  return pickFailoverAccount(accounts, failedSlug);
}

/**
 * Record a run outcome against the account that served it.
 *
 * Returns whether the caller should fail over. Only an auth failure qualifies.
 * A rate-limited account is deliberately left untouched: it is busy, not
 * broken, and switching away from it to obtain more capacity is the behaviour
 * this system does not implement.
 */
export async function recordRunOutcome(
  slug: string,
  outcome: { ok: boolean; errorMessage?: string | null },
): Promise<{ failover: boolean; classification: string }> {
  if (outcome.ok) {
    await markSuccess(slug);
    return { failover: false, classification: "ok" };
  }
  const cls = classifyError(outcome.errorMessage);
  if (cls === "auth") {
    await markAuthFailure(slug, outcome.errorMessage ?? "unknown auth failure");
    // Page immediately — this is the live version of the 2026-08-02 failure,
    // caught at the moment it happens rather than up to 10 minutes later at
    // the next probe.
    const acct = (await listAccounts()).find((a) => a.slug === slug);
    await alertOnTransition({
      slug,
      health: "broken",
      previous: "healthy",
      detail: `authentication failed during a run: ${(outcome.errorMessage ?? "").slice(0, 300)}`,
      configDir: acct?.configDir ?? "/root/.claude",
      changed: true,
    }).catch(() => {});
    return { failover: true, classification: cls };
  }
  return { failover: false, classification: cls };
}

/** Periodic cheap-tier probing. Returns a stop function. */
export function startProbeLoop(intervalMs = 10 * 60_000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const results = await probeAll();
      for (const r of results) {
        if (r.changed) {
          console.log(`[accounts] ${r.slug}: ${r.health} — ${r.detail}`);
        }
      }
    } catch (err) {
      // Never let a probe failure take down the service. An unreachable
      // registry is itself a condition worth logging loudly.
      console.error(
        "[accounts] probe loop error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
