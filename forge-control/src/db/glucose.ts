/**
 * Glucose reading storage. Schema: db/migrations/0048_glucose_readings.sql.
 *
 * Same pool convention as db/daily.ts — DATABASE_URL, `::text` on every
 * timestamptz so days and instants cross the wire as strings rather than as JS
 * Dates built at the box's local midnight.
 */

import pg from "pg";
import type { GlucoseReading } from "../lib/glucose.ts";

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge",
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[glucose pool]", e.message));

const COLS = `taken_at::text, value_mgdl, value_mmol, measurement_color,
              is_high, is_low, trend_id`;

/**
 * Upsert a window of readings.
 *
 * LibreLinkUp's graph endpoint returns a ROLLING ~12h window on every poll, so
 * the overwhelming majority of every batch is already stored. `ON CONFLICT
 * (taken_at) DO UPDATE` makes that a no-op rather than eighty duplicates every
 * quarter of an hour — the reason `taken_at` is the primary key.
 *
 * The live reading is upserted last and wins, because only it carries a trend.
 */
export async function saveReadings(readings: GlucoseReading[]): Promise<number> {
  if (readings.length === 0) return 0;

  const values: unknown[] = [];
  const rows: string[] = [];
  for (const r of readings) {
    const i = values.length;
    rows.push(
      `($${i + 1}::timestamptz, $${i + 2}::real, $${i + 3}::real, $${i + 4}::smallint,
        $${i + 5}::boolean, $${i + 6}::boolean, $${i + 7}::smallint)`,
    );
    values.push(
      r.taken_at,
      r.value_mgdl,
      r.value_mmol,
      r.measurement_color ?? null,
      r.is_high,
      r.is_low,
      r.trend_id ?? null,
    );
  }

  const res = await pool.query(
    `INSERT INTO glucose_readings
       (taken_at, value_mgdl, value_mmol, measurement_color, is_high, is_low, trend_id)
     VALUES ${rows.join(", ")}
     ON CONFLICT (taken_at) DO UPDATE SET
       value_mgdl        = EXCLUDED.value_mgdl,
       value_mmol        = EXCLUDED.value_mmol,
       measurement_color = EXCLUDED.measurement_color,
       is_high           = EXCLUDED.is_high,
       is_low            = EXCLUDED.is_low,
       -- Never overwrite a real trend with the NULL a graph point carries.
       trend_id          = COALESCE(EXCLUDED.trend_id, glucose_readings.trend_id)`,
    values,
  );
  return res.rowCount ?? 0;
}

/** Readings inside a window, oldest first — the order a chart wants. */
export async function listReadings(startIso: string, endIso: string): Promise<GlucoseReading[]> {
  const r = await pool.query<GlucoseReading>(
    `SELECT ${COLS} FROM glucose_readings
      WHERE taken_at >= $1::timestamptz AND taken_at < $2::timestamptz
      ORDER BY taken_at`,
    [startIso, endIso],
  );
  return r.rows;
}

/** The most recent reading, or null when nothing has ever been stored. */
export async function latestReading(): Promise<GlucoseReading | null> {
  const r = await pool.query<GlucoseReading>(
    `SELECT ${COLS} FROM glucose_readings ORDER BY taken_at DESC LIMIT 1`,
  );
  return r.rows[0] ?? null;
}
