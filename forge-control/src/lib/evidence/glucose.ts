/**
 * Evidence source: the day's glucose summary.
 *
 * "In range" is not a threshold invented here. `glucose_readings` carries
 * LibreLinkUp's own `is_low` / `is_high` flags per reading, set by the source
 * that owns the target band; in-range is neither. Hardcoding 70–180 mg/dL would
 * quietly disagree with the app Konrad actually reads.
 *
 * With no readings, `mean_mgdl` and `in_range_pct` are null — not 0. The table
 * is empty today (R1 §h), and "average zero" would be a medical statement this
 * surface has no business making.
 */

import { query } from "../../db/journal-day.ts";
import type { Day } from "../day-score.ts";

export interface GlucoseEvidence {
  readings: number;
  mean_mgdl: number | null;
  in_range_pct: number | null;
}

interface GlucoseRow {
  readings: number;
  mean_mgdl: number | null;
  in_range_pct: number | null;
}

export async function glucoseForDay(day: Day): Promise<GlucoseEvidence> {
  const rows = await query<GlucoseRow>(
    `SELECT count(*)::int AS readings,
            round(avg(value_mgdl)::numeric, 1)::float8 AS mean_mgdl,
            round(
              (100.0 * count(*) FILTER (WHERE NOT is_high AND NOT is_low)
                     / nullif(count(*), 0))::numeric, 1)::float8 AS in_range_pct
       FROM glucose_readings
      WHERE (taken_at AT TIME ZONE 'Europe/Berlin')::date = $1::date`,
    [day],
  );

  const row = rows[0];
  if (!row) {
    throw new Error("glucose: aggregate query returned no row — the query did not run");
  }
  return {
    readings: row.readings,
    mean_mgdl: row.readings === 0 ? null : row.mean_mgdl,
    in_range_pct: row.readings === 0 ? null : row.in_range_pct,
  };
}
