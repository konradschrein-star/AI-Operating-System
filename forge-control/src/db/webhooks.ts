/**
 * Webhooks DAO. Schema in migration 0024_webhooks_and_cron.sql.
 *
 * Two halves:
 *   - CRUD for the management UI (list, get, create, update, delete).
 *   - The receiver path: lookupBySlug() + recordFire() / recordError()
 *     consumed by routes/webhook-in.ts.
 */

import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[webhooks pool]", e.message));

export interface Webhook {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  secret: string;
  enabled: boolean;
  prompt_template: string;
  title_template: string | null;
  worker_label: string | null;
  total_calls: number;
  last_called_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type WebhookPublic = Omit<Webhook, "secret"> & { secret_preview: string };

function publicView(w: Webhook): WebhookPublic {
  const { secret, ...rest } = w;
  return {
    ...rest,
    secret_preview: `${secret.slice(0, 4)}…${secret.slice(-4)}`,
  };
}

export function newSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function listWebhooks(): Promise<WebhookPublic[]> {
  const r = await pool.query<Webhook>(
    `SELECT id::text, slug, name, description, secret, enabled, prompt_template,
            title_template, worker_label, total_calls,
            last_called_at::text, last_run_id::text, last_error,
            created_at::text, updated_at::text
       FROM webhooks
       ORDER BY created_at DESC`,
  );
  return r.rows.map(publicView);
}

export async function getWebhookById(id: string): Promise<WebhookPublic | null> {
  const r = await pool.query<Webhook>(
    `SELECT id::text, slug, name, description, secret, enabled, prompt_template,
            title_template, worker_label, total_calls,
            last_called_at::text, last_run_id::text, last_error,
            created_at::text, updated_at::text
       FROM webhooks
       WHERE id = $1
       LIMIT 1`,
    [id],
  );
  return r.rows[0] ? publicView(r.rows[0]) : null;
}

/** Used by the inbound receiver — returns the secret so HMAC can be verified. */
export async function lookupBySlug(slug: string): Promise<Webhook | null> {
  const r = await pool.query<Webhook>(
    `SELECT id::text, slug, name, description, secret, enabled, prompt_template,
            title_template, worker_label, total_calls,
            last_called_at::text, last_run_id::text, last_error,
            created_at::text, updated_at::text
       FROM webhooks
       WHERE slug = $1
       LIMIT 1`,
    [slug],
  );
  return r.rows[0] ?? null;
}

export async function createWebhook(input: {
  slug: string;
  name: string;
  description?: string;
  prompt_template: string;
  title_template?: string;
  worker_label?: string;
  enabled?: boolean;
}): Promise<WebhookPublic> {
  const r = await pool.query<Webhook>(
    `INSERT INTO webhooks (slug, name, description, secret, enabled,
                           prompt_template, title_template, worker_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id::text, slug, name, description, secret, enabled, prompt_template,
               title_template, worker_label, total_calls,
               last_called_at::text, last_run_id::text, last_error,
               created_at::text, updated_at::text`,
    [
      input.slug,
      input.name,
      input.description ?? null,
      newSecret(),
      input.enabled ?? true,
      input.prompt_template,
      input.title_template ?? null,
      input.worker_label ?? null,
    ],
  );
  return publicView(r.rows[0]);
}

export async function updateWebhook(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    prompt_template: string;
    title_template: string | null;
    worker_label: string | null;
    enabled: boolean;
  }>,
): Promise<WebhookPublic | null> {
  // Build SET clause dynamically.
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }
  if (sets.length === 0) return getWebhookById(id);
  sets.push(`updated_at = now()`);
  args.push(id);
  const r = await pool.query<Webhook>(
    `UPDATE webhooks SET ${sets.join(", ")}
        WHERE id = $${args.length}
     RETURNING id::text, slug, name, description, secret, enabled, prompt_template,
               title_template, worker_label, total_calls,
               last_called_at::text, last_run_id::text, last_error,
               created_at::text, updated_at::text`,
    args,
  );
  return r.rows[0] ? publicView(r.rows[0]) : null;
}

export async function rotateSecret(id: string): Promise<string | null> {
  const next = newSecret();
  const r = await pool.query<{ id: string }>(
    `UPDATE webhooks SET secret = $1, updated_at = now()
        WHERE id = $2
     RETURNING id::text`,
    [next, id],
  );
  return r.rows[0] ? next : null;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM webhooks WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function recordFire(
  id: string,
  runId: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE webhooks
        SET total_calls = total_calls + 1,
            last_called_at = now(),
            last_run_id = $2,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [id, runId],
  );
}

export async function recordError(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE webhooks
        SET last_called_at = now(),
            last_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

/**
 * Verify an HMAC-SHA256 signature against the given secret. Signature header
 * format: `sha256=<hex>` (matches GitHub / Stripe convention). Constant-time
 * compare to avoid timing leaks.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const match = signatureHeader.trim().match(/^sha256=([a-f0-9]+)$/i);
  if (!match) return false;
  const presented = Buffer.from(match[1], "hex");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest();
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(presented, expected);
}

/**
 * Render a prompt_template by substituting `{{ body.field }}` placeholders
 * with values from the inbound payload. Missing fields render as empty
 * string. Templates are stored, payloads are caller-controlled — we don't
 * eval, just string-replace.
 */
export function renderTemplate(
  template: string,
  body: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*body\.([\w.-]+)\s*\}\}/g,
    (_m, pathStr: string) => {
      let cur: unknown = body;
      for (const part of pathStr.split(".")) {
        if (cur && typeof cur === "object" && part in (cur as object)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          return "";
        }
      }
      return typeof cur === "string" ? cur : JSON.stringify(cur);
    },
  );
}
