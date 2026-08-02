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

function shape(a: Awaited<ReturnType<typeof listAccounts>>[number]) {
  return {
    slug: a.slug,
    config_dir: a.configDir,
    login_email: a.loginEmail,
    plan_label: a.planLabel,
    priority: a.priority,
    enabled: a.enabled,
    health: a.health,
    health_detail: a.healthDetail,
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
    const usable = accounts.filter((a) => a.enabled && a.health !== "broken");
    return c.json({
      accounts: accounts.map(shape),
      summary: {
        total: accounts.length,
        enabled: accounts.filter((a) => a.enabled).length,
        healthy: accounts.filter((a) => a.health === "healthy").length,
        unknown: accounts.filter((a) => a.health === "unknown").length,
        broken: accounts.filter((a) => a.health === "broken").length,
        usable: usable.length,
        serving: usable[0]?.slug ?? null,
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
    // Probe immediately so a newly added account never sits at a bare
    // "unknown" with no explanation of why.
    await probeAccount(created).catch(() => {});
    const fresh = await getAccount(slug);
    return c.json(shape(fresh ?? created), 201);
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
