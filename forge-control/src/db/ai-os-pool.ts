/**
 * The shared connection to the AI OS's own database (host postgres :5434).
 *
 * Extracted when the ledger became the second table to live there. Previously
 * db/claude-accounts.ts owned a private pool; a second private pool would mean
 * two connection limits, two error handlers, and two places to fix when the
 * DSN changes. As the content_forge split proceeds this is the one seam every
 * migrated module should come through.
 *
 * NOTE: db/claude-accounts.ts still has its own pool. It was left untouched
 * deliberately — it shipped hours before this and works; folding it in is a
 * follow-up, not something to risk in the same change as a new table.
 *
 * There is intentionally NO fallback to content_forge. Silently connecting to
 * the wrong database is how you end up with two divergent copies of a table —
 * which already happened here: guardrail_rules exists in BOTH databases and
 * the :5434 copy holds 9 stale rows that nothing reads.
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function aiOsPool(): pg.Pool {
  const url = process.env.AI_OS_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AI_OS_DATABASE_URL is not set. The AI OS owns its data in the ai_os " +
        "database (127.0.0.1:5434), not content_forge. Set it in the pm2 env " +
        "and restart from the ecosystem file. Refusing to fall back.",
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
      console.error("[ai_os pg pool error]", err.message);
    });
  }
  return pool;
}
