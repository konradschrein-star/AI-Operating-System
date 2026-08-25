/**
 * Evidence source: tasks closed that Berlin day.
 *
 * `done_at` is a timestamptz and this box's clock is UTC, so the day filter goes
 * through `AT TIME ZONE 'Europe/Berlin'` — the same device db/ai_os.ts's
 * listDecisions() uses, and for the same reason (a naive UTC range files
 * 22:00–00:00 under the wrong date).
 *
 * `goal_id` / `goal_title` come from the §3.3 goal link. The column
 * (`day_tasks.goal_id uuid REFERENCES life_goals(id) ON DELETE SET NULL`, plus
 * its partial index) is LIVE on the shared content_forge database, applied by
 * the sibling lane that owns migration 0050 — it is deliberately queried
 * directly here rather than through db/daily.ts's TASK_COLS, which does not
 * carry it on this branch. If the migration is ever absent, this source fails
 * loudly into errors[] rather than quietly dropping the field.
 */

import { query } from "../../db/journal-day.ts";
import type { Day } from "../day-score.ts";

export interface TaskDoneEvidence {
  id: string;
  title: string;
  area: string | null;
  done_at: string;
  goal_id: string | null;
  goal_title: string | null;
}

export async function tasksDone(day: Day): Promise<TaskDoneEvidence[]> {
  return query<TaskDoneEvidence>(
    `SELECT t.id::text        AS id,
            t.title,
            t.area,
            t.done_at::text   AS done_at,
            t.goal_id::text   AS goal_id,
            g.title           AS goal_title
       FROM day_tasks t
       LEFT JOIN life_goals g ON g.id = t.goal_id
      WHERE t.done_at IS NOT NULL
        AND (t.done_at AT TIME ZONE 'Europe/Berlin')::date = $1::date
      ORDER BY t.done_at`,
    [day],
  );
}
