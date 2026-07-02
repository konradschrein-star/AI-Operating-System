/**
 * Cron schedules DAO. Schema in migration 0024_webhooks_and_cron.sql.
 *
 * Two halves:
 *   - CRUD for the management UI.
 *   - The scheduler tick: due() returns rows where next_run_at <= now() AND
 *     enabled, then advance() recomputes next_run_at after a successful fire.
 */

import pg from "pg";
import { nextFireFromExpr, parseCron } from "../lib/cron-parser.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[cron pool]", e.message));

export interface CronSchedule {
  id: string;
  name: string;
  description: string | null;
  cron_expr: string;
  enabled: boolean;
  prompt_template: string;
  title_template: string | null;
  worker_label: string | null;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  total_fires: number;
  /** Merged into the metadata of every run this schedule creates
   *  (e.g. {"model": "haiku", "notify": "always"}). */
  run_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Validate that a cron expression parses. Throws a useful error if not. */
export function validateCronExpr(expr: string): void {
  parseCron(expr);
}

export async function listSchedules(): Promise<CronSchedule[]> {
  const r = await pool.query<CronSchedule>(
    `SELECT id::text, name, description, cron_expr, enabled, prompt_template,
            title_template, worker_label,
            next_run_at::text, last_run_at::text, last_run_id::text,
            last_error, total_fires, run_metadata,
            created_at::text, updated_at::text
       FROM cron_schedules
       ORDER BY created_at DESC`,
  );
  return r.rows;
}

export async function getScheduleById(
  id: string,
): Promise<CronSchedule | null> {
  const r = await pool.query<CronSchedule>(
    `SELECT id::text, name, description, cron_expr, enabled, prompt_template,
            title_template, worker_label,
            next_run_at::text, last_run_at::text, last_run_id::text,
            last_error, total_fires, run_metadata,
            created_at::text, updated_at::text
       FROM cron_schedules
       WHERE id = $1
       LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function createSchedule(input: {
  name: string;
  description?: string;
  cron_expr: string;
  prompt_template: string;
  title_template?: string;
  worker_label?: string;
  enabled?: boolean;
  run_metadata?: Record<string, unknown>;
}): Promise<CronSchedule> {
  validateCronExpr(input.cron_expr);
  const next = nextFireFromExpr(input.cron_expr, new Date());
  const r = await pool.query<CronSchedule>(
    `INSERT INTO cron_schedules
        (name, description, cron_expr, enabled, prompt_template,
         title_template, worker_label, next_run_at, run_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id::text, name, description, cron_expr, enabled, prompt_template,
               title_template, worker_label,
               next_run_at::text, last_run_at::text, last_run_id::text,
               last_error, total_fires, run_metadata, run_metadata,
               created_at::text, updated_at::text`,
    [
      input.name,
      input.description ?? null,
      input.cron_expr,
      input.enabled ?? true,
      input.prompt_template,
      input.title_template ?? null,
      input.worker_label ?? null,
      next.toISOString(),
      JSON.stringify(input.run_metadata ?? {}),
    ],
  );
  return r.rows[0];
}

export async function updateSchedule(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    cron_expr: string;
    enabled: boolean;
    prompt_template: string;
    title_template: string | null;
    worker_label: string | null;
  }>,
): Promise<CronSchedule | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }

  // If cron_expr changed, recompute next_run_at to the next match from now.
  if (typeof patch.cron_expr === "string") {
    validateCronExpr(patch.cron_expr);
    const next = nextFireFromExpr(patch.cron_expr, new Date()).toISOString();
    args.push(next);
    sets.push(`next_run_at = $${args.length}`);
  }

  if (sets.length === 0) return getScheduleById(id);
  sets.push(`updated_at = now()`);
  args.push(id);
  const r = await pool.query<CronSchedule>(
    `UPDATE cron_schedules SET ${sets.join(", ")}
        WHERE id = $${args.length}
     RETURNING id::text, name, description, cron_expr, enabled, prompt_template,
               title_template, worker_label,
               next_run_at::text, last_run_at::text, last_run_id::text,
               last_error, total_fires, run_metadata, run_metadata,
               created_at::text, updated_at::text`,
    args,
  );
  return r.rows[0] ?? null;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM cron_schedules WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Find all due schedules (next_run_at <= now AND enabled). Uses
 * FOR UPDATE SKIP LOCKED so concurrent ticks never double-fire.
 */
export async function claimDueSchedules(): Promise<CronSchedule[]> {
  // Atomically advance next_run_at to a far-future placeholder so a second
  // tick in the same window doesn't re-fetch the same rows. The caller
  // computes the *real* next_run_at after firing via recordFire().
  const placeholder = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // +1 year
  const r = await pool.query<CronSchedule>(
    `WITH due AS (
       SELECT id
         FROM cron_schedules
        WHERE enabled AND next_run_at <= now()
        ORDER BY next_run_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED
     )
     UPDATE cron_schedules c
        SET next_run_at = $1::timestamptz
       FROM due
      WHERE c.id = due.id
     RETURNING c.id::text, name, description, cron_expr, enabled, prompt_template,
               title_template, worker_label,
               next_run_at::text, last_run_at::text, last_run_id::text,
               last_error, total_fires, run_metadata, run_metadata,
               created_at::text, updated_at::text`,
    [placeholder.toISOString()],
  );
  return r.rows;
}

/** Mark a schedule as fired and advance next_run_at to the next cron match. */
export async function recordFire(id: string, runId: string): Promise<void> {
  const sched = await getScheduleById(id);
  if (!sched) return;
  const next = nextFireFromExpr(sched.cron_expr, new Date());
  await pool.query(
    `UPDATE cron_schedules
        SET last_run_at = now(),
            last_run_id = $2,
            last_error = NULL,
            total_fires = total_fires + 1,
            next_run_at = $3::timestamptz,
            updated_at = now()
      WHERE id = $1`,
    [id, runId, next.toISOString()],
  );
}

export async function recordError(id: string, error: string): Promise<void> {
  // Even on error we advance next_run_at so we don't spin in a tight loop.
  const sched = await getScheduleById(id);
  if (!sched) return;
  const next = nextFireFromExpr(sched.cron_expr, new Date());
  await pool.query(
    `UPDATE cron_schedules
        SET last_run_at = now(),
            last_error = $2,
            next_run_at = $3::timestamptz,
            updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 500), next.toISOString()],
  );
}
