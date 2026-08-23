/**
 * /api/accounts — Claude account registry.
 *
 *   GET    /api/accounts              list + policy summary
 *   POST   /api/accounts/probe        probe every enabled account now
 *   POST   /api/accounts/:slug/probe  probe one (works on disabled ones too)
 *   PATCH  /api/accounts/:slug        enabled | priority | plan_label
 *   POST   /api/accounts              register a new config dir
 *   DELETE /api/accounts/:slug        remove from the registry (never touches disk)
 *
 * Reads the ai_os database, NOT content_forge. Holds no credential material —
 * only directory paths and health metadata.
 */

import { Hono } from "hono";

import {
  listAccounts,
  getAccount,
  patchAccount,
  createAccount,
  deleteAccount,
  ping,
} from "../db/claude-accounts.ts";
import { probeAll, probeAccount, readCredentialSnapshot } from "../lib/accounts.ts";
import { effectiveHealth, rankAccounts } from "../lib/account-health.ts";
import { getBankBalances } from "../lib/mercury.ts";

const r = new Hono();

/** The registry lives in a database that may not be configured yet. Say so
 *  precisely instead of returning a 500 with a stack trace. */
function dbError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return {
    error: "account registry unavailable",
    detail: message,
    hint: message.includes("AI_OS_DATABASE_URL")
      ? "Set AI_OS_DATABASE_URL (see /root/.ai_os_db_url) and pm2 restart --update-env"
      : undefined,
  };
}

/**
 * One registry row, as the surface sees it.
 *
 * ── `health` HERE IS THE EFFECTIVE HEALTH, NOT THE RAW COLUMN (R45, R57) ──
 * `claude_accounts.health` is stored, and `markSuccess()` writes `'healthy'`
 * without ever touching `last_probed_at`, so the column can say `healthy` about
 * an account nothing has ever measured. Applying `effectiveHealth()` HERE, at
 * the one place the registry becomes JSON, means every consumer — the row
 * chips, the account card, `settings/connections.ts`, anything written later —
 * inherits the invariant instead of each re-deriving it and one of them getting
 * it wrong. That is exactly what happened before this round: a fixture row with
 * `health='healthy'` and `last_probed_at=NULL` rendered CONNECTED in green
 * (`docs/plan/artifacts/os-usable-for-work/phase4/b4a-before-connections.png`).
 *
 * The raw column is still published as `stored_health`, and `health_downgraded`
 * says whether the two differ, so nothing is hidden — a demotion is visible AND
 * explained rather than silently swapped.
 *
 * `measured_at` is this server's clock at the moment of the response. The UI
 * renders probe age against it rather than the browser's clock, which may be
 * minutes off and would then invent or erase staleness.
 */
function shape(a: Awaited<ReturnType<typeof listAccounts>>[number]) {
  const eff = effectiveHealth(
    {
      health: a.health,
      detail: a.healthDetail,
      lastProbedAt: a.lastProbedAt ? a.lastProbedAt.getTime() : null,
    },
    { now: Date.now() },
  );
  return {
    slug: a.slug,
    config_dir: a.configDir,
    // CONFIGURATION, not a probe result. The cheap-tier probe reads the
    // credential file for PRESENCE only (lib/accounts.ts:42-80) and never
    // learns an address, so this value was typed in via PATCH login_email. The
    // surface must label it as configured; presenting it as verified is the
    // same lie in a smaller font (02-architecture.md §3).
    login_email: a.loginEmail,
    login_email_source: "configuration" as const,
    plan_label: a.planLabel,
    priority: a.priority,
    enabled: a.enabled,
    health: eff.health,
    health_detail: eff.detail,
    stored_health: eff.storedHealth,
    health_downgraded: eff.downgraded,
    probe_age_ms: eff.probeAgeMs,
    measured_at: new Date().toISOString(),
    has_refresh: a.hasRefresh,
    // Exposed for display only. This is an ~8h token that the refresh token
    // renews continuously; it is NOT a health signal and the UI must not
    // present it as a countdown to failure.
    access_expires_at: a.accessExpiresAt,
    last_probed_at: a.lastProbedAt,
    last_ok_at: a.lastOkAt,
    last_error: a.lastError,
    /** Command Konrad runs to fix a broken account. */
    reauth_command:
      a.configDir === "/root/.claude"
        ? "claude auth login --claudeai"
        : `CLAUDE_CONFIG_DIR=${a.configDir} claude auth login --claudeai`,
  };
}

r.get("/", async (c) => {
  try {
    const accounts = await listAccounts();
    const shaped = accounts.map(shape);
    // Counts are derived from the SHAPED rows so the summary and the rows
    // cannot disagree: a demoted `healthy` must be counted as unknown, or the
    // header says "2 usable of 3" beside a row that reads UNKNOWN.
    const usable = shaped.filter((a) => a.enabled && a.health !== "broken");
    // `serving` is the account that will ACTUALLY serve the next run, so it is
    // computed by the same ranking the executor uses (rankAccounts → best
    // health, then priority, then slug) against the RAW column, not by taking
    // the first row of a priority-ordered list. Those differ whenever a
    // lower-priority account is healthy and a higher-priority one is not.
    const serving =
      rankAccounts(
        accounts.map((a) => ({
          slug: a.slug,
          configDir: a.configDir,
          enabled: a.enabled,
          health: a.health,
          priority: a.priority,
          healthDetail: a.healthDetail,
        })),
      )[0]?.slug ?? null;
    return c.json({
      accounts: shaped,
      summary: {
        total: shaped.length,
        enabled: shaped.filter((a) => a.enabled).length,
        healthy: shaped.filter((a) => a.health === "healthy").length,
        unknown: shaped.filter((a) => a.health === "unknown").length,
        broken: shaped.filter((a) => a.health === "broken").length,
        usable: usable.length,
        serving,
      },
      policy: {
        mode: "health-failover-only",
        // Stated in the API so the behaviour is discoverable rather than
        // surprising when an account hits its limit.
        description:
          "A BROKEN account (expired/revoked/blanked credentials) is skipped " +
          "automatically. A RATE-LIMITED account is not: it is busy, not broken, " +
          "so the run fails visibly and falls through to the DeepSeek chain " +
          "instead of consuming another account's capacity.",
      },
    });
  } catch (e) {
    return c.json(dbError(e), 503);
  }
});

r.get("/health", async (c) => {
  const p = await ping();
  return c.json(p, p.ok ? 200 : 503);
});

r.get("/bank", async (c) => {
  try {
    const balances = await getBankBalances();
    return c.json(balances);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: "bank balance retrieval failed", detail: message }, 500);
  }
});

r.post("/probe", async (c) => {
  try {
    return c.json({ probed: await probeAll() });
  } catch (e) {
    return c.json(dbError(e), 503);
  }
});

r.post("/:slug/probe", async (c) => {
  const slug = c.req.param("slug");
  try {
    const a = await getAccount(slug);
    if (!a) return c.json({ error: `no account "${slug}"` }, 404);
    return c.json(await probeAccount(a));
  } catch (e) {
    return c.json(dbError(e), 503);
  }
});

/** Raw credential-file inspection for one account. Presence only, no secrets. */
r.get("/:slug/credential", async (c) => {
  const slug = c.req.param("slug");
  try {
    const a = await getAccount(slug);
    if (!a) return c.json({ error: `no account "${slug}"` }, 404);
    return c.json({ slug, ...(await readCredentialSnapshot(a.configDir)) });
  } catch (e) {
    return c.json(dbError(e), 503);
  }
});

r.patch("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    priority?: number;
    plan_label?: string | null;
  };
  const patch: Parameters<typeof patchAccount>[1] = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.priority === "number" && Number.isFinite(body.priority)) {
    patch.priority = Math.trunc(body.priority);
  }
  if (body.plan_label !== undefined) patch.planLabel = body.plan_label;

  try {
    const updated = await patchAccount(slug, patch);
    if (!updated) return c.json({ error: `no account "${slug}"` }, 404);
    return c.json(shape(updated));
  } catch (e) {
    return c.json(dbError(e), 503);
  }
});

r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    config_dir?: string;
    plan_label?: string | null;
    priority?: number;
  };
  const slug = (body.slug ?? "").trim();
  const configDir = (body.config_dir ?? "").trim();
  if (!slug || !configDir) {
    return c.json({ error: "slug and config_dir are required" }, 400);
  }
  if (!configDir.startsWith("/")) {
    return c.json({ error: "config_dir must be an absolute path" }, 400);
  }
  try {
    const created = await createAccount({
      slug,
      configDir,
      planLabel: body.plan_label ?? null,
      priority: body.priority,
    });

    // R46's fail condition is "accepts a directory without probing it", and
    // until this round that is exactly what happened on the unhappy path: the
    // probe ran behind `.catch(() => {})`, so a probe that threw left the row
    // at the bare INSERT default — health `unknown`, detail "created — awaiting
    // first probe" — with the registration reported as a clean 201. A silently
    // swallowed probe is indistinguishable from an account that has simply not
    // been probed yet, which is precisely the confusion this phase exists to
    // end (N1: no catch returning a default).
    //
    // So the probe failure is now REPORTED, verbatim, and the caller is told
    // the row exists but is unverified. 201 remains correct — the registration
    // DID happen and the row must not be silently rolled back — and
    // `probe_error` is how the UI knows not to present it as a fresh reading.
    let probeError: string | null = null;
    try {
      await probeAccount(created);
    } catch (e) {
      probeError = e instanceof Error ? e.message : String(e);
      console.error(`[accounts] registered "${slug}" but the probe failed: ${probeError}`);
    }

    const fresh = await getAccount(slug);
    if (!fresh) {
      // The row was inserted a moment ago; if it cannot be read back, the
      // registry is lying to us and a 201 would be a fabrication.
      return c.json(
        {
          error: `registered "${slug}" but it could not be read back from the registry`,
          detail:
            "createAccount() returned a row and the immediately following getAccount() found none. " +
            "The registry is inconsistent; do not trust the account list until this is explained.",
        },
        500,
      );
    }
    return c.json({ ...shape(fresh), probe_error: probeError }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key/i.test(msg)) {
      return c.json({ error: `account "${slug}" or that config_dir already exists` }, 409);
    }
    return c.json(dbError(e), 503);
  }
});

r.delete("/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    const ok = await deleteAccount(slug);
    if (!ok) return c.json({ error: `no account "${slug}"` }, 404);
    // Registry only. The credential directory on disk is left untouched —
    // deleting someone's OAuth session as a side effect of a UI click would be
    // both surprising and unrecoverable without a fresh interactive login.
    return c.json({ deleted: slug, note: "registry entry removed; credential directory left on disk" });
  } catch (e) {
    return c.json(dbError(e), 503);
  }
});

export default r;
