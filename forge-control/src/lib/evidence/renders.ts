/**
 * Evidence source: ReelForge renders completed that Berlin day.
 *
 * `content_jobs` lives in the SAME database as `runs` and `day_tasks` — there is
 * no separate content-forge database to hop to (verified live, R1 header). So
 * this goes through the shared journal-day pool like every other SQL source.
 *
 * "Completed" is the `render_completed_at` timestamp, NOT a status. The
 * `job_status` enum has 50-odd values and no `RENDER_COMPLETE` among them: a job
 * moves on to AWAITING_QC, UPLOADING, PUBLISHED after its render lands, so
 * filtering on status would report zero renders on the day a video was finished
 * and published. The stamp is set once and survives every later transition.
 */

import { query } from "../../db/journal-day.ts";
import type { Day } from "../day-score.ts";

export interface RenderEvidence {
  id: string;
  title: string | null;
  status: string;
  completed_at: string;
}

export async function rendersForDay(day: Day): Promise<RenderEvidence[]> {
  return query<RenderEvidence>(
    `SELECT id::text                   AS id,
            title,
            status::text               AS status,
            render_completed_at::text  AS completed_at
       FROM content_jobs
      WHERE render_completed_at IS NOT NULL
        AND (render_completed_at AT TIME ZONE 'Europe/Berlin')::date = $1::date
      ORDER BY render_completed_at`,
    [day],
  );
}
