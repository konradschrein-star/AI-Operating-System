/**
 * Coach accountability metrics (schema: 0028_telegram_coach.sql).
 *
 * The evening coach run reports committed vs completed for the day (it
 * curls POST /api/coach/metrics after reading the daily note's checkboxes).
 * Streak = consecutive days ending today/yesterday where completed >= 1
 * and completed/committed >= 0.5. Deliberately forgiving: the streak is a
 * momentum signal, not a purity test.
 */

import pg from "pg";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[coach pool]", e.message));

export interface CoachDay {
  day: string;
  committed: number;
  completed: number;
  notes: string | null;
}

export async function upsertCoachDay(input: {
  day: string; // YYYY-MM-DD
  committed: number;
  completed: number;
  notes?: string;
}): Promise<CoachDay> {
  const r = await pool.query<CoachDay>(
    `INSERT INTO coach_metrics (day, committed, completed, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (day) DO UPDATE
       SET committed = EXCLUDED.committed,
           completed = EXCLUDED.completed,
           notes = COALESCE(EXCLUDED.notes, coach_metrics.notes),
           updated_at = now()
     RETURNING day::text, committed, completed, notes`,
    [input.day, input.committed, input.completed, input.notes ?? null],
  );
  return r.rows[0];
}

export async function listCoachDays(limit = 30): Promise<CoachDay[]> {
  const r = await pool.query<CoachDay>(
    `SELECT day::text, committed, completed, notes
       FROM coach_metrics
       ORDER BY day DESC
       LIMIT $1`,
    [limit],
  );
  return r.rows;
}

function hitTarget(d: CoachDay): boolean {
  return d.completed >= 1 && (d.committed === 0 || d.completed / d.committed >= 0.5);
}

/** Current streak of target-hitting days. Counts back from the most recent
 *  recorded day, but only if that day is today or yesterday (a stale table
 *  means the streak is dead, not preserved). */
export async function currentStreak(): Promise<number> {
  const days = await listCoachDays(120);
  if (days.length === 0) return 0;
  const newest = new Date(`${days[0].day}T00:00:00Z`).getTime();
  const ageDays = (Date.now() - newest) / 86_400_000;
  if (ageDays > 2) return 0;

  let streak = 0;
  let expected = new Date(`${days[0].day}T00:00:00Z`).getTime();
  for (const d of days) {
    const t = new Date(`${d.day}T00:00:00Z`).getTime();
    if (t !== expected || !hitTarget(d)) break;
    streak += 1;
    expected -= 86_400_000;
  }
  return streak;
}
