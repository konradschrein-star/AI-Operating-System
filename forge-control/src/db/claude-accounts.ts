/**
 * Claude account registry — the AI OS's OWN database.
 *
 * This is the first module in forge-control to talk to `ai_os` (host postgres,
 * :5434) instead of Content Forge's `content_forge` (docker, :5432). It is the
 * pilot for the database split: small, new, no data to migrate. See
 * docs/superpowers/specs/2026-08-02-claude-account-health-failover-design.md §4.1
 *
 * DELIBERATE DEPARTURE FROM THE SURROUNDING CODE: every other db/*.ts module
 * defaults its connection string to
 *   postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge
 * when its env var is missing. Ten pools across eight modules do this. It means
 * a misconfigured deploy does not fail — it silently connects to the wrong
 * database and appears to work. That is precisely the failure mode the split
 * exists to eliminate, so this module has NO fallback and throws instead.
 * Do not "fix" this by adding a default.
 */

import pg from "pg";

const { Pool } = pg;

export interface AccountRow {
  slug: string;
  configDir: string;
  loginEmail: string | null;
  planLabel: string | null;
  priority: number;
  enabled: boolean;
  health: "healthy" | "broken" | "unknown";
  healthDetail: string | null;
  hasRefresh: boolean | null;
  accessExpiresAt: Date | null;
  lastProbedAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  const url = process.env.AI_OS_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AI_OS_DATABASE_URL is not set. The account registry lives in the ai_os " +
        "database (127.0.0.1:5434), not content_forge. Set it in the pm2 env " +
        "(see /root/.ai_os_db_url) and restart with --update-env. Refusing to " +
        "fall back to content_forge.",
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => {
      console.error("[claude-accounts pg pool error]", err.message);
    });
  }
  return pool;
}

const COLS = `
  slug, config_dir, login_email, plan_label, priority, enabled,
  health, health_detail, has_refresh, access_expires_at,
  last_probed_at, last_ok_at, last_error
`;

interface RawRow {
  slug: string;
  config_dir: string;
  login_email: string | null;
  plan_label: string | null;
  priority: number;
  enabled: boolean;
  health: AccountRow["health"];
  health_detail: string | null;
  has_refresh: boolean | null;
  access_expires_at: Date | null;
  last_probed_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

function toAccount(r: RawRow): AccountRow {
  return {
    slug: r.slug,
    configDir: r.config_dir,
    loginEmail: r.login_email,
    planLabel: r.plan_label,
    priority: Number(r.priority),
    enabled: r.enabled,
    health: r.health,
    healthDetail: r.health_detail,
    hasRefresh: r.has_refresh,
    accessExpiresAt: r.access_expires_at,
    lastProbedAt: r.last_probed_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
  };
}

export async function listAccounts(): Promise<AccountRow[]> {
  const { rows } = await getPool().query<RawRow>(
    `SELECT ${COLS} FROM claude_accounts ORDER BY priority ASC, slug ASC`,
  );
  return rows.map(toAccount);
}

export async function getAccount(slug: string): Promise<AccountRow | null> {
  const { rows } = await getPool().query<RawRow>(
    `SELECT ${COLS} FROM claude_accounts WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/** Records the outcome of a probe. Does NOT touch last_ok_at. */
export async function recordProbe(
  slug: string,
  v: {
    health: AccountRow["health"];
    detail: string;
    hasRefresh: boolean | null;
    accessExpiresAt: Date | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE claude_accounts
        SET health = $2, health_detail = $3, has_refresh = $4,
            access_expires_at = $5, last_probed_at = now(), updated_at = now()
      WHERE slug = $1`,
    [slug, v.health, v.detail, v.hasRefresh, v.accessExpiresAt],
  );
}

/**
 * A run completed successfully on this account. This is the only thing that
 * proves an account works — a credential file cannot. Clears any stale error
 * and promotes the account out of `unknown`.
 */
export async function markSuccess(slug: string): Promise<void> {
  await getPool().query(
    `UPDATE claude_accounts
        SET last_ok_at = now(), health = 'healthy',
            health_detail = 'confirmed by a successful run',
            last_error = NULL, updated_at = now()
      WHERE slug = $1`,
    [slug],
  );
}

/**
 * A run failed on this account with an AUTH error. Only ever called for
 * classifyError() === 'auth'; a rate-limited account is busy, not broken, and
 * must never be marked down here.
 */
export async function markAuthFailure(
  slug: string,
  message: string,
): Promise<void> {
  await getPool().query(
    `UPDATE claude_accounts
        SET health = 'broken', health_detail = 'authentication failed during a run',
            last_error = $2, updated_at = now()
      WHERE slug = $1`,
    [slug, message.slice(0, 2_000)],
  );
}

export async function patchAccount(
  slug: string,
  patch: {
    enabled?: boolean;
    priority?: number;
    planLabel?: string | null;
    loginEmail?: string | null;
  },
): Promise<AccountRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [slug];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    sets.push(`${sql} = $${vals.length}`);
  };
  if (patch.enabled !== undefined) add("enabled", patch.enabled);
  if (patch.priority !== undefined) add("priority", patch.priority);
  if (patch.planLabel !== undefined) add("plan_label", patch.planLabel);
  if (patch.loginEmail !== undefined) add("login_email", patch.loginEmail);
  if (sets.length === 0) return getAccount(slug);

  const { rows } = await getPool().query<RawRow>(
    `UPDATE claude_accounts SET ${sets.join(", ")}, updated_at = now()
      WHERE slug = $1 RETURNING ${COLS}`,
    vals,
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

export async function createAccount(a: {
  slug: string;
  configDir: string;
  planLabel?: string | null;
  priority?: number;
  enabled?: boolean;
}): Promise<AccountRow> {
  const { rows } = await getPool().query<RawRow>(
    `INSERT INTO claude_accounts (slug, config_dir, plan_label, priority, enabled, health, health_detail)
     VALUES ($1, $2, $3, $4, $5, 'unknown', 'created — awaiting first probe')
     RETURNING ${COLS}`,
    [
      a.slug,
      a.configDir,
      a.planLabel ?? null,
      a.priority ?? 100,
      a.enabled ?? true,
    ],
  );
  return toAccount(rows[0]!);
}

export async function deleteAccount(slug: string): Promise<boolean> {
  const res = await getPool().query(
    `DELETE FROM claude_accounts WHERE slug = $1`,
    [slug],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Connectivity check for the health endpoint — distinguishes "no rows" from "cannot connect". */
export async function ping(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getPool().query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
