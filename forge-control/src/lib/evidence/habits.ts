/**
 * Evidence sources: habits ticked that day, and the day's score.
 *
 * Two exports because both answers come out of the same pair of tables and both
 * belong on the same card — but they are registered as two sources in index.ts,
 * so a scoring failure still leaves the tick list on the page.
 *
 * ── Which habit tables ───────────────────────────────────────────────────
 * `habits` / `habit_logs`. NOT `daily_habits` / `daily_habit_log`, which also
 * exist in this database, also hold rows (7 of them), and are referenced by no
 * line of forge-control (R1 §g verified both facts). Querying the dead pair
 * would print "7 ticks" on a surface whose heatmap, streaks and day score are
 * all computed from the live pair's zero — two numbers, one truth, and the
 * journal would be the one that lies.
 *
 * The score is not recomputed here: `dayBundle()` in db/daily.ts is what the
 * board and the stats endpoint already use, so the journal shows the same
 * number they do or it shows nothing.
 */

import { query } from "../../db/journal-day.ts";
import { dayBundle } from "../../db/daily.ts";
import { berlinDay, type Day } from "../day-score.ts";

export interface HabitsEvidence {
  ticked: Array<{ key: string; label: string; icon: string }>;
  total_active: number;
}

export interface ScoreEvidence {
  score: number | null;
  habit_pct: number | null;
  task_pct: number | null;
}

interface TickedRow {
  key: string;
  label: string;
  icon: string;
}

interface ActiveRow {
  total_active: number;
}

export async function habitsTicked(day: Day): Promise<HabitsEvidence> {
  const [ticked, active] = await Promise.all([
    query<TickedRow>(
      `SELECT h.key, h.label, h.icon
         FROM habit_logs hl
         JOIN habits h ON h.id = hl.habit_id
        WHERE hl.day = $1::date AND hl.done
        ORDER BY h.sort, h.label`,
      [day],
    ),
    query<ActiveRow>(`SELECT count(*)::int AS total_active FROM habits WHERE active`),
  ]);

  const total = active[0]?.total_active;
  if (total === undefined) {
    throw new Error("habits: count(*) returned no row — the query did not run");
  }

  return { ticked, total_active: total };
}

export async function scoreForDay(day: Day): Promise<ScoreEvidence> {
  const bundle = await dayBundle(day, berlinDay());
  return {
    score: bundle.score.score,
    habit_pct: bundle.score.habit_pct,
    task_pct: bundle.score.task_pct,
  };
}
