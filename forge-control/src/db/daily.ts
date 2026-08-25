/**
 * Daily goals / habits / task planner / life goals data access.
 * Schema: db/migrations/0042_daily_goals.sql, 0043_goals_and_calendar.sql,
 * 0050_day_tasks_goal.sql (day_tasks.goal_id — NOT applied to content_forge yet;
 * the deploy phase owns that, and every goal_id read here answers 500 until it
 * has run).
 * Spec: docs/spec-daily-goals.md.
 *
 * All SQL for the GOALS/TASKS surface lives here; routes/daily.ts is thin.
 *
 * Conventions carried over from db/reminders.ts:
 *
 *   1. A module-local pg.Pool on DATABASE_URL (content_forge — the same
 *      database as reminders/runs/ui_dismissals).
 *   2. `::text` on every timestamptz AND every date in the COLS lists. node-pg
 *      otherwise hands back a JS Date for `date` (OID 1082) constructed at
 *      LOCAL midnight, which on this UTC box serialises to "2026-08-18T22:00…"
 *      for the 19th and would put a day on the wrong square of the heatmap.
 *      Days cross the wire as "YYYY-MM-DD" strings, always.
 *
 * Nothing here computes a score or resolves "today" — both come from
 * lib/day-score.ts, which is the single source for each.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  computeDayScore,
  streakEndingToday,
  bestStreak,
  shiftDay,
  daysBack,
  FULFILLED_AT,
  type Day,
  type DayScore,
  type GoalStatus,
} from "../lib/day-score.ts";
// The Mon–Sun week boundary is read through Europe/Berlin, not off the string.
// It already exists in lib/calendar.ts and the goals-week rollup must agree with
// the week the board draws, so it is imported rather than reimplemented here.
import { weekStart } from "../lib/calendar.ts";

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
pool.on("error", (e) => console.error("[daily pool]", e.message));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Big3Goal {
  id: string;
  text: string;
  why: string | null;
  status: GoalStatus;
  reason: string | null;
  done_at: string | null;
}

export interface DayPlan {
  day: Day;
  big3: Big3Goal[];
  intent: string | null;
  committed_at: string | null;
  generated_by: string | null;
  generated_at: string | null;
  subjective: number | null;
  reflection: string | null;
  created_at: string;
  updated_at: string;
}

export interface Habit {
  id: string;
  key: string;
  label: string;
  icon: string;
  grp: string;
  polarity: "do" | "avoid";
  weight: number;
  sort: number;
  active: boolean;
  created_at: string;
}

export interface HabitTick {
  day: Day;
  habit_id: string;
  done: boolean;
  ts: string;
}

export type TaskStatus = "todo" | "doing" | "done" | "parked";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done", "parked"];

export interface DayTask {
  id: string;
  title: string;
  area: string | null;
  importance: number;
  status: TaskStatus;
  planned_day: Day | null;
  due_day: Day | null;
  est_min: number | null;
  carried: number;
  notes: string | null;
  done_at: string | null;
  start_time: string | null;
  duration_min: number | null;
  gcal_event_id: string | null;
  /** Bound Google Tasks entry, for day-precision work (0047). */
  gtask_id: string | null;
  /** Google's own last-modified stamp as we last saw it — the guard against
   *  echoing our own write back as if it were his edit. */
  gtask_updated: string | null;
  /** The life goal this task serves (0050). NULL is the normal case. */
  goal_id: string | null;
  /** Read-time only, never stored: the single `in_progress` life goal sharing
   *  this task's area, when there is exactly one. Two candidates or none give
   *  null — a guess with a coin flip in it is worse than no chip at all. */
  suggested_goal_id: string | null;
  created_at: string;
  updated_at: string;
  /** Calendar days since creation, in Berlin terms. > 14 is bad news (§6). */
  age_days: number;
}

export type GoalHorizon = "quarterly" | "yearly" | "long_term";
export type LifeGoalStatus = "planned" | "in_progress" | "done" | "parked" | "abandoned";

export const GOAL_HORIZONS: readonly string[] = ["quarterly", "yearly", "long_term"];
export const LIFE_GOAL_STATUSES: readonly string[] = ["planned", "in_progress", "done", "parked", "abandoned"];

export interface LifeGoal {
  id: string;
  title: string;
  status: string;
  horizon: string;
  area: string | null;
  progress: number;
  started_day: Day | null;
  target_day: Day | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A life goal as the drawer reads it: the row plus what the board has actually
 * done about it (0050's `day_tasks.goal_id`).
 *
 * Derived, never stored. `progress` is a number Konrad types; these four are
 * the ones he cannot fake — which is the whole point of the link.
 */
export interface LifeGoalWithWork extends LifeGoal {
  /** Linked tasks still open (`todo` or `doing`). */
  tasks_open: number;
  /** Linked tasks completed in the last 30 days. */
  tasks_done_30d: number;
  /** `duration_min ?? est_min ?? 0` summed over those completions. */
  minutes_30d: number;
  /** The most recent `done_at` of any linked task, ever. Null = never moved. */
  last_moved_at: string | null;
}

/** carried >= STALE_AT puts a task in the "do it or kill it" strip (§5). */
export const STALE_AT = 3;

const PLAN_COLS = `day::text, big3, intent, committed_at::text, generated_by,
                   generated_at::text, subjective, reflection,
                   created_at::text, updated_at::text`;

const HABIT_COLS = `id::text, key, label, icon, grp, polarity, weight, sort,
                    active, created_at::text`;

/**
 * `age_days` is computed in SQL rather than from created_at in Node.
 *
 * `suggested_goal_id` is likewise a read-time expression and not a column: the
 * suggestion has to change the moment a goal is started or its area edited, and
 * a stored copy would go stale silently. `count(*) = 1` is the whole rule — the
 * aggregate returns exactly one row per task, so an area with no in_progress
 * goal and an area with three both yield NULL.
 */
const TASK_COLS = `id::text, title, area, importance, status, planned_day::text,
                   due_day::text, est_min, carried, notes, done_at::text,
                   start_time::text, duration_min, gcal_event_id,
                   gtask_id, gtask_updated::text, goal_id::text,
                   (SELECT CASE WHEN count(*) = 1 THEN max(g.id::text) END
                      FROM life_goals g
                     WHERE g.status = 'in_progress'
                       AND g.area IS NOT NULL
                       AND g.area = day_tasks.area) AS suggested_goal_id,
                   created_at::text, updated_at::text,
                   ((now() AT TIME ZONE 'Europe/Berlin')::date
                    - (created_at AT TIME ZONE 'Europe/Berlin')::date)::int
                     AS age_days`;

const LIFE_GOAL_COLS = `id::text, title, status, horizon, area, progress,
                         started_day::text, target_day::text, completed_at::text,
                         notes, created_at::text, updated_at::text`;

/**
 * The work a life goal has drawn, as a LATERAL beside LIFE_GOAL_COLS.
 *
 * A LATERAL rather than a GROUP BY join because a goal with no linked tasks
 * must still come back — with zeros, which is a fact about the goal, not an
 * absence of the goal. The 30-day cut is on `done_at`, the same clock the
 * stats window uses.
 */
const LIFE_GOAL_WORK = `LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE t.status IN ('todo','doing'))::int AS tasks_open,
           count(*) FILTER (WHERE t.status = 'done'
                              AND t.done_at >= now() - interval '30 days')::int
             AS tasks_done_30d,
           COALESCE(sum(COALESCE(t.duration_min, t.est_min, 0))
                      FILTER (WHERE t.status = 'done'
                                AND t.done_at >= now() - interval '30 days'), 0)::int
             AS minutes_30d,
           max(t.done_at)::text AS last_moved_at
      FROM day_tasks t
     WHERE t.goal_id = life_goals.id
  ) work ON true`;

/** Phone order: the four rows appear top to bottom as the day runs. */
const GRP_ORDER = `CASE grp WHEN 'morning' THEN 0 WHEN 'body' THEN 1
                            WHEN 'work' THEN 2 WHEN 'evening' THEN 3
                            ELSE 4 END`;

/**
 * Retained for backward-compatibility if referenced.
 */
export class PlanCommittedError extends Error {
  constructor(
    readonly day: Day,
    readonly committedAt: string,
  ) {
    super(
      `day ${day} was committed at ${committedAt} — the Big 3 text is frozen. ` +
        `Complete or abandon a goal instead of editing it.`,
    );
    this.name = "PlanCommittedError";
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function getPlan(day: Day): Promise<DayPlan | null> {
  const r = await pool.query<DayPlan>(
    `SELECT ${PLAN_COLS} FROM day_plans WHERE day = $1`,
    [day],
  );
  return r.rows[0] ?? null;
}

/**
 * Normalise a caller-supplied Big 3 into stored shape.
 */
export function normaliseBig3(
  input: Array<Partial<Big3Goal> & { text: string }>,
  existing: Big3Goal[] = [],
): Big3Goal[] {
  return input.map((g) => {
    const prior = g.id ? existing.find((e) => e.id === g.id) : undefined;
    return {
      id: g.id ?? randomUUID(),
      text: g.text,
      why: g.why ?? prior?.why ?? null,
      status: g.status ?? prior?.status ?? "open",
      reason: g.reason ?? prior?.reason ?? null,
      done_at: g.done_at ?? prior?.done_at ?? null,
    };
  });
}

/**
 * Fluid draft edit. Updating plan text, intent, and goals remains allowed even
 * after morning commit so the user can adapt freely throughout the day.
 */
export async function upsertPlanDraft(
  day: Day,
  patch: {
    intent?: string | null;
    big3?: Big3Goal[] | null;
    generatedBy?: string | null;
  },
): Promise<DayPlan> {
  const big3 = patch.big3 ? JSON.stringify(patch.big3) : null;
  const r = await pool.query<DayPlan>(
    `INSERT INTO day_plans (day, big3, intent, generated_by, generated_at)
     VALUES ($1, COALESCE($2::jsonb, '[]'::jsonb), $3::text, $4::text,
             CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (day) DO UPDATE
        SET big3         = COALESCE($2::jsonb, day_plans.big3),
            intent       = COALESCE($3::text, day_plans.intent),
            generated_by = COALESCE($4::text, day_plans.generated_by),
            generated_at = CASE WHEN $4::text IS NULL THEN day_plans.generated_at
                                ELSE now() END,
            updated_at   = now()
     RETURNING ${PLAN_COLS}`,
    [day, big3, patch.intent ?? null, patch.generatedBy ?? null],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`upsertPlanDraft(${day}): upsert returned no row`);
  return row;
}

/**
 * Freeze the day / mark morning plan committed.
 * Idempotent: a second call keeps the original committed_at.
 */
export async function commitDay(day: Day): Promise<DayPlan> {
  const r = await pool.query<DayPlan>(
    `INSERT INTO day_plans (day, committed_at) VALUES ($1, now())
     ON CONFLICT (day) DO UPDATE
        SET committed_at = COALESCE(day_plans.committed_at, now()),
            updated_at   = now()
     RETURNING ${PLAN_COLS}`,
    [day],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`commitDay(${day}): upsert returned no row`);
  return row;
}

/**
 * Set one goal's status. Legal before AND after commit.
 */
export async function setGoalStatus(
  day: Day,
  goalId: string,
  status: GoalStatus,
  reason: string | null,
): Promise<DayPlan | null> {
  const plan = await getPlan(day);
  if (!plan) return null;
  const idx = plan.big3.findIndex((g) => g.id === goalId);
  if (idx === -1) return null;
  const goal = plan.big3[idx]!;
  const next: Big3Goal[] = [...plan.big3];
  next[idx] = {
    ...goal,
    status,
    done_at: status === "done" ? (goal.done_at ?? new Date().toISOString()) : null,
    reason: status === "abandoned" ? reason : null,
  };
  const r = await pool.query<DayPlan>(
    `UPDATE day_plans SET big3 = $2::jsonb, updated_at = now()
      WHERE day = $1
     RETURNING ${PLAN_COLS}`,
    [day, JSON.stringify(next)],
  );
  return r.rows[0] ?? null;
}

/** Night rating + reflection. */
export async function reflect(
  day: Day,
  patch: { subjective?: number | null; reflection?: string | null },
): Promise<DayPlan> {
  const r = await pool.query<DayPlan>(
    `INSERT INTO day_plans (day, subjective, reflection)
     VALUES ($1, $2::smallint, $3::text)
     ON CONFLICT (day) DO UPDATE
        SET subjective = COALESCE($2::smallint, day_plans.subjective),
            reflection = COALESCE($3::text, day_plans.reflection),
            updated_at = now()
     RETURNING ${PLAN_COLS}`,
    [day, patch.subjective ?? null, patch.reflection ?? null],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`reflect(${day}): upsert returned no row`);
  return row;
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export async function listHabits(opts: { activeOnly?: boolean } = {}): Promise<Habit[]> {
  const r = await pool.query<Habit>(
    `SELECT ${HABIT_COLS} FROM habits
      WHERE ($1::boolean IS NOT TRUE OR active)
      ORDER BY ${GRP_ORDER}, sort, label`,
    [opts.activeOnly ?? false],
  );
  return r.rows;
}

export async function getHabit(id: string): Promise<Habit | null> {
  const r = await pool.query<Habit>(`SELECT ${HABIT_COLS} FROM habits WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function createHabit(input: {
  key: string;
  label: string;
  icon: string;
  grp: string;
  polarity?: "do" | "avoid";
  weight?: number;
  sort?: number;
}): Promise<Habit | null> {
  const r = await pool.query<Habit>(
    `INSERT INTO habits (key, label, icon, grp, polarity, weight, sort)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'do'), COALESCE($6::smallint, 1),
             COALESCE($7::smallint, 0))
     ON CONFLICT (key) DO NOTHING
     RETURNING ${HABIT_COLS}`,
    [
      input.key,
      input.label,
      input.icon,
      input.grp,
      input.polarity ?? null,
      input.weight ?? null,
      input.sort ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

export async function updateHabit(
  id: string,
  patch: Partial<Pick<Habit, "label" | "icon" | "grp" | "polarity" | "weight" | "sort" | "active">>,
): Promise<Habit | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const put = (col: string, v: unknown): void => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.label !== undefined) put("label", patch.label);
  if (patch.icon !== undefined) put("icon", patch.icon);
  if (patch.grp !== undefined) put("grp", patch.grp);
  if (patch.polarity !== undefined) put("polarity", patch.polarity);
  if (patch.weight !== undefined) put("weight", patch.weight);
  if (patch.sort !== undefined) put("sort", patch.sort);
  if (patch.active !== undefined) put("active", patch.active);
  if (sets.length === 0) return getHabit(id);
  const r = await pool.query<Habit>(
    `UPDATE habits SET ${sets.join(", ")} WHERE id = $1 RETURNING ${HABIT_COLS}`,
    vals,
  );
  return r.rows[0] ?? null;
}

export async function listTicks(day: Day): Promise<HabitTick[]> {
  const r = await pool.query<HabitTick>(
    `SELECT day::text, habit_id::text, done, ts::text
       FROM habit_logs WHERE day = $1 ORDER BY ts`,
    [day],
  );
  return r.rows;
}

export async function setTick(day: Day, habitId: string, done: boolean): Promise<HabitTick[]> {
  if (done) {
    await pool.query(
      `INSERT INTO habit_logs (day, habit_id, done, ts) VALUES ($1, $2, true, now())
       ON CONFLICT (day, habit_id) DO UPDATE SET done = true, ts = now()`,
      [day, habitId],
    );
  } else {
    await pool.query(`DELETE FROM habit_logs WHERE day = $1 AND habit_id = $2`, [day, habitId]);
  }
  return listTicks(day);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskView = "today" | "week" | "backlog" | "all";

export const TASK_VIEWS: readonly TaskView[] = ["today", "week", "backlog", "all"];

export async function listTasks(opts: {
  view?: TaskView;
  area?: string;
  status?: TaskStatus;
  today: Day;
}): Promise<DayTask[]> {
  const view = opts.view ?? "all";
  const where: string[] = [];
  const vals: unknown[] = [];
  const put = (v: unknown): string => {
    vals.push(v);
    return `$${vals.length}`;
  };

  if (view === "today") {
    const d = put(opts.today);
    where.push(`(planned_day = ${d}::date
                 OR (planned_day < ${d}::date AND status IN ('todo','doing')))`);
  } else if (view === "week") {
    const d = put(opts.today);
    const end = put(shiftDay(opts.today, 6));
    where.push(`(planned_day BETWEEN ${d}::date AND ${end}::date
                 OR (planned_day < ${d}::date AND status IN ('todo','doing')))`);
  } else if (view === "backlog") {
    where.push(`planned_day IS NULL AND status <> 'done'`);
  }
  if (opts.area) where.push(`area = ${put(opts.area)}`);
  if (opts.status) where.push(`status = ${put(opts.status)}`);

  const r = await pool.query<DayTask>(
    `SELECT ${TASK_COLS} FROM day_tasks
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY importance DESC, due_day ASC NULLS LAST, created_at ASC`,
    vals,
  );
  return r.rows;
}

export async function getTask(id: string): Promise<DayTask | null> {
  const r = await pool.query<DayTask>(`SELECT ${TASK_COLS} FROM day_tasks WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function createTask(input: {
  title: string;
  area?: string | null;
  importance?: number | null;
  status?: TaskStatus | null;
  planned_day?: Day | null;
  due_day?: Day | null;
  est_min?: number | null;
  notes?: string | null;
  start_time?: string | null;
  duration_min?: number | null;
  gcal_event_id?: string | null;
  gtask_id?: string | null;
  gtask_updated?: string | null;
  goal_id?: string | null;
}): Promise<DayTask> {
  const r = await pool.query<DayTask>(
    `INSERT INTO day_tasks (title, area, importance, status, planned_day, due_day,
                            est_min, notes, start_time, duration_min, gcal_event_id,
                            gtask_id, gtask_updated, goal_id, done_at)
     VALUES ($1, $2::text, COALESCE($3::smallint, 2), COALESCE($4::text, 'todo'),
             $5::date, $6::date, $7::smallint, $8::text,
             $9::timestamptz, COALESCE($10::smallint, 30), $11::text,
             $12::text, $13::timestamptz, $14::uuid,
             CASE WHEN $4::text = 'done' THEN now() ELSE NULL END)
     RETURNING ${TASK_COLS}`,
    [
      input.title,
      input.area ?? null,
      input.importance ?? null,
      input.status ?? null,
      input.planned_day ?? null,
      input.due_day ?? null,
      input.est_min ?? null,
      input.notes ?? null,
      input.start_time ?? null,
      input.duration_min ?? null,
      input.gcal_event_id ?? null,
      input.gtask_id ?? null,
      input.gtask_updated ?? null,
      input.goal_id ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error("createTask: insert returned no row");
  return row;
}

export async function updateTask(
  id: string,
  patch: {
    title?: string;
    area?: string | null;
    importance?: number;
    status?: TaskStatus;
    planned_day?: Day | null;
    due_day?: Day | null;
    est_min?: number | null;
    notes?: string | null;
    carried?: number;
    start_time?: string | null;
    duration_min?: number | null;
    gcal_event_id?: string | null;
    gtask_id?: string | null;
    gtask_updated?: string | null;
    goal_id?: string | null;
  },
): Promise<DayTask | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const put = (col: string, v: unknown, cast = ""): void => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (patch.title !== undefined) put("title", patch.title);
  if (patch.area !== undefined) put("area", patch.area, "::text");
  if (patch.importance !== undefined) put("importance", patch.importance, "::smallint");
  if (patch.planned_day !== undefined) put("planned_day", patch.planned_day, "::date");
  if (patch.due_day !== undefined) put("due_day", patch.due_day, "::date");
  if (patch.est_min !== undefined) put("est_min", patch.est_min, "::smallint");
  if (patch.notes !== undefined) put("notes", patch.notes, "::text");
  if (patch.carried !== undefined) put("carried", patch.carried, "::smallint");
  if (patch.start_time !== undefined) put("start_time", patch.start_time, "::timestamptz");
  if (patch.duration_min !== undefined) put("duration_min", patch.duration_min, "::smallint");
  if (patch.gcal_event_id !== undefined) put("gcal_event_id", patch.gcal_event_id, "::text");
  if (patch.gtask_id !== undefined) put("gtask_id", patch.gtask_id, "::text");
  if (patch.gtask_updated !== undefined)
    put("gtask_updated", patch.gtask_updated, "::timestamptz");
  // Explicit null is how a link is CUT, so `undefined` (absent) and `null`
  // (unlink) must stay distinguishable all the way down — hence the
  // `!== undefined` test rather than a truthiness check.
  if (patch.goal_id !== undefined) put("goal_id", patch.goal_id, "::uuid");
  if (patch.status !== undefined) {
    put("status", patch.status, "::text");
    vals.push(patch.status);
    sets.push(
      `done_at = CASE WHEN $${vals.length}::text = 'done'
                      THEN COALESCE(day_tasks.done_at, now()) ELSE NULL END`,
    );
  }
  if (sets.length === 0) return getTask(id);
  const r = await pool.query<DayTask>(
    `UPDATE day_tasks SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 RETURNING ${TASK_COLS}`,
    vals,
  );
  return r.rows[0] ?? null;
}

export async function deleteTask(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM day_tasks WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Every task already bound to a Google Calendar event, keyed by event id.
 *
 * This map is what makes the pull sync idempotent: a second run over the same
 * window finds the event already linked and updates it in place instead of
 * creating a duplicate. Without it, a five-minute poll would grow the board by
 * the size of the week, every five minutes.
 */
export async function tasksByEventId(): Promise<Map<string, DayTask>> {
  const r = await pool.query<DayTask>(
    `SELECT ${TASK_COLS} FROM day_tasks WHERE gcal_event_id IS NOT NULL`,
  );
  return new Map(r.rows.map((t) => [t.gcal_event_id as string, t]));
}

/** Board tasks bound to a Google Tasks entry, keyed by that entry's id. */
export async function tasksByGtaskId(): Promise<Map<string, DayTask>> {
  const r = await pool.query<DayTask>(
    `SELECT ${TASK_COLS} FROM day_tasks WHERE gtask_id IS NOT NULL`,
  );
  return new Map(r.rows.map((t) => [t.gtask_id as string, t]));
}

/**
 * Open board tasks that belong in Google Tasks and are not there yet.
 *
 * `start_time IS NULL` is the whole routing rule: a task with an hour is a
 * calendar event, and Google Tasks would throw that hour away (its `due` is
 * date-precision). Parked tasks stay off the phone deliberately — parking one
 * is how you get it out of sight.
 */
export async function tasksNeedingGtask(): Promise<DayTask[]> {
  const r = await pool.query<DayTask>(
    `SELECT ${TASK_COLS} FROM day_tasks
      WHERE gtask_id IS NULL
        AND start_time IS NULL
        AND status IN ('todo','doing')
      ORDER BY created_at`,
  );
  return r.rows;
}

/** Drop the calendar link from any task pointing at `eventId`. The task itself
 *  survives — deleting the meeting does not mean the work stopped existing. */
export async function unlinkTasksFromEvent(eventId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE day_tasks
        SET gcal_event_id = NULL, start_time = NULL, updated_at = now()
      WHERE gcal_event_id = $1`,
    [eventId],
  );
  return r.rowCount ?? 0;
}

/**
 * Every completed task whose `done_at` falls in a Berlin day range, with the
 * minutes it consumed and whatever it was linked to.
 *
 * Used by the goals-week rollup and by lib/calendar-stats.ts. `minutes` is
 * `duration_min ?? est_min ?? 0` — a done task with neither is real work with
 * an unknown cost, and inventing a default here would put fiction in an hours
 * chart. `gcal_event_id` comes back so the caller can fall back to the length
 * of the linked calendar event, which is the one honest source left.
 */
export interface DoneTaskInRange {
  id: string;
  title: string;
  area: string | null;
  done_at: string;
  minutes: number;
  gcal_event_id: string | null;
  goal_id: string | null;
  goal_title: string | null;
  goal_horizon: string | null;
}

export async function doneTasksInRange(from: Day, to: Day): Promise<DoneTaskInRange[]> {
  const r = await pool.query<DoneTaskInRange>(
    `SELECT t.id::text, t.title, t.area, t.done_at::text,
            COALESCE(t.duration_min, t.est_min, 0)::int AS minutes,
            t.gcal_event_id, t.goal_id::text,
            g.title AS goal_title, g.horizon AS goal_horizon
       FROM day_tasks t
       LEFT JOIN life_goals g ON g.id = t.goal_id
      WHERE t.status = 'done' AND t.done_at IS NOT NULL
        AND (t.done_at AT TIME ZONE 'Europe/Berlin')::date BETWEEN $1 AND $2
      ORDER BY t.done_at`,
    [from, to],
  );
  return r.rows;
}

export async function rolloverTasks(to: Day): Promise<DayTask[]> {
  const r = await pool.query<DayTask>(
    `UPDATE day_tasks
        SET planned_day = $1::date, carried = carried + 1, updated_at = now()
      WHERE status IN ('todo','doing')
        AND planned_day IS NOT NULL
        AND planned_day < $1::date
     RETURNING ${TASK_COLS}`,
    [to],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Life Goals
// ---------------------------------------------------------------------------

export async function listLifeGoals(opts: {
  horizon?: string;
  status?: string;
  area?: string;
} = {}): Promise<LifeGoalWithWork[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const put = (v: unknown): string => {
    vals.push(v);
    return `$${vals.length}`;
  };

  if (opts.horizon) where.push(`life_goals.horizon = ${put(opts.horizon)}`);
  if (opts.status) where.push(`life_goals.status = ${put(opts.status)}`);
  if (opts.area) where.push(`life_goals.area = ${put(opts.area)}`);

  const r = await pool.query<LifeGoalWithWork>(
    `SELECT ${LIFE_GOAL_COLS},
            work.tasks_open, work.tasks_done_30d, work.minutes_30d,
            work.last_moved_at
       FROM life_goals
       ${LIFE_GOAL_WORK}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY CASE life_goals.horizon
                WHEN 'quarterly' THEN 0 WHEN 'yearly' THEN 1 ELSE 2 END,
              life_goals.progress DESC, life_goals.created_at ASC`,
    vals,
  );
  return r.rows;
}

export async function getLifeGoal(id: string): Promise<LifeGoal | null> {
  const r = await pool.query<LifeGoal>(
    `SELECT ${LIFE_GOAL_COLS} FROM life_goals WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function createLifeGoal(input: {
  title: string;
  status?: string | null;
  horizon?: string | null;
  area?: string | null;
  progress?: number | null;
  started_day?: Day | null;
  target_day?: Day | null;
  notes?: string | null;
}): Promise<LifeGoal> {
  const r = await pool.query<LifeGoal>(
    `INSERT INTO life_goals (title, status, horizon, area, progress, started_day, target_day, notes, completed_at)
     VALUES ($1, COALESCE($2::text, 'planned'), COALESCE($3::text, 'quarterly'),
             $4::text, COALESCE($5::smallint, 0), $6::date, $7::date, $8::text,
             CASE WHEN $2::text = 'done' THEN now() ELSE NULL END)
     RETURNING ${LIFE_GOAL_COLS}`,
    [
      input.title,
      input.status ?? null,
      input.horizon ?? null,
      input.area ?? null,
      input.progress ?? null,
      input.started_day ?? null,
      input.target_day ?? null,
      input.notes ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error("createLifeGoal: insert returned no row");
  return row;
}

export async function updateLifeGoal(
  id: string,
  patch: {
    title?: string;
    status?: string;
    horizon?: string;
    area?: string | null;
    progress?: number;
    started_day?: Day | null;
    target_day?: Day | null;
    notes?: string | null;
  },
): Promise<LifeGoal | null> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const put = (col: string, v: unknown, cast = ""): void => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };

  if (patch.title !== undefined) put("title", patch.title);
  if (patch.status !== undefined) {
    put("status", patch.status, "::text");
    vals.push(patch.status);
    sets.push(
      `completed_at = CASE WHEN $${vals.length}::text = 'done' THEN COALESCE(life_goals.completed_at, now()) ELSE NULL END`,
    );
  }
  if (patch.horizon !== undefined) put("horizon", patch.horizon, "::text");
  if (patch.area !== undefined) put("area", patch.area, "::text");
  if (patch.progress !== undefined) put("progress", patch.progress, "::smallint");
  if (patch.started_day !== undefined) put("started_day", patch.started_day, "::date");
  if (patch.target_day !== undefined) put("target_day", patch.target_day, "::date");
  if (patch.notes !== undefined) put("notes", patch.notes, "::text");

  if (sets.length === 0) return getLifeGoal(id);
  const r = await pool.query<LifeGoal>(
    `UPDATE life_goals SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 RETURNING ${LIFE_GOAL_COLS}`,
    vals,
  );
  return r.rows[0] ?? null;
}

export async function deleteLifeGoal(id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM life_goals WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The day bundle + stats
// ---------------------------------------------------------------------------

export interface DayBundle {
  day: Day;
  plan: DayPlan | null;
  habits: Array<Habit & { streak: number }>;
  ticks: HabitTick[];
  tasks: DayTask[];
  score: DayScore & { provisional: boolean };
}

export async function dayBundle(day: Day, today: Day): Promise<DayBundle> {
  const [plan, habits, ticks, tasks, tickHistory] = await Promise.all([
    getPlan(day),
    listHabits({ activeOnly: true }),
    listTicks(day),
    listTasks({ view: "all", today }),
    allTickHistory(),
  ]);

  const tickedIds = new Set(ticks.filter((t) => t.done).map((t) => t.habit_id));
  const byHabit = new Map<string, Day[]>();
  for (const row of tickHistory) {
    const list = byHabit.get(row.habit_id);
    if (list) list.push(row.day);
    else byHabit.set(row.habit_id, [row.day]);
  }

  const dayTasks = tasks.filter((t) => t.planned_day === day);
  const committedBig3 = plan?.committed_at ? plan.big3 : [];

  const score = computeDayScore({
    habits: habits.map((h) => ({ weight: h.weight, done: tickedIds.has(h.id) })),
    big3: committedBig3,
    tasks: dayTasks.map((t) => ({ done: t.status === "done" })),
  });

  return {
    day,
    plan,
    habits: habits.map((h) => ({
      ...h,
      streak: streakEndingToday(byHabit.get(h.id) ?? [], today),
    })),
    ticks,
    tasks: tasks.filter(
      (t) =>
        t.planned_day === day ||
        (t.planned_day !== null &&
          t.planned_day < day &&
          (t.status === "todo" || t.status === "doing")),
    ),
    score: { ...score, provisional: day === today },
  };
}

interface TickRow {
  day: Day;
  habit_id: string;
}

async function allTickHistory(): Promise<TickRow[]> {
  const r = await pool.query<TickRow>(
    `SELECT day::text, habit_id::text FROM habit_logs WHERE done ORDER BY day`,
  );
  return r.rows;
}

/**
 * One habit measured against the felt rating.
 *
 * `mean_with` is the average `day_plans.subjective` of the RATED days on which
 * the habit was ticked; `mean_without` the average of the rated days on which
 * it was not. Both are null when that side has no days at all — a mean of zero
 * days is not zero, and a chart that draws it as zero is a lie the size of the
 * axis.
 */
export interface HabitFeltRow {
  habit_id: string;
  key: string;
  label: string;
  icon: string;
  n_with: number;
  n_without: number;
  mean_with: number | null;
  mean_without: number | null;
  delta: number | null;
  sufficient: boolean;
}

export interface HabitFelt {
  /** Days in the window carrying a felt rating. */
  rated_days: number;
  /** Rated days needed before ANY row can be called sufficient. */
  needed: number;
  /** True when at least one row is sufficient — the tile's draw/don't-draw. */
  sufficient: boolean;
  rows: HabitFeltRow[];
}

/**
 * Sufficiency, the honest version.
 *
 * The felt rating is the only signal the day score cannot derive, and on
 * 2026-08-25 `day_plans.subjective` is non-null on exactly ZERO days. So the
 * first job of this structure is to say "not yet" convincingly enough that
 * nobody draws bars out of three data points. 20 rated days with 8 on each
 * side is not a significance test — it is the floor below which the difference
 * of two means is pure noise, and it is stated here rather than hidden in a
 * chart component so both the API and the UI agree on the same threshold.
 */
export const HABIT_FELT_MIN_RATED_DAYS = 20;
export const HABIT_FELT_MIN_SIDE = 8;

export interface GoalsWeekMoved {
  goal_id: string;
  title: string;
  horizon: string;
  tasks_done: number;
  minutes: number;
}

export interface GoalsWeek {
  week_start: Day;
  week_end: Day;
  /** Every task completed in the week, linked or not. */
  total_done: number;
  /** …of which pointed at no life goal. The number that makes the tile honest. */
  unlinked_done: number;
  moved: GoalsWeekMoved[];
}

export interface DailyStats {
  window: { days: number; from: Day; to: Day };
  days: Array<{
    day: Day;
    score: number | null;
    habit_pct: number | null;
    goal_pct: number | null;
    task_pct: number | null;
    subjective: number | null;
  }>;
  habits: Array<{
    id: string;
    key: string;
    label: string;
    icon: string;
    grp: string;
    rate30: number;
    streak: number;
    best: number;
    ticks30: Day[];
    /** Ticks across the WHOLE requested window. `ticks30` stays exactly what it
     *  was — the 30-day strip on the board reads it — but a 90-day matrix drawn
     *  from a 30-day array is 60 days of false blanks. */
    ticks: Day[];
  }>;
  said_vs_done: {
    committed: number;
    done: number;
    abandoned: number;
    open: number;
    rate: number | null;
  };
  tasks: { done_by_day: Array<{ day: Day; n: number }>; open: number; stale: number };
  streak: { current: number; best: number };
  habit_felt: HabitFelt;
  goals_week: GoalsWeek;
}

/** Two decimals, or null passed straight through. */
function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

/**
 * Which habits go with a good day — computed, not asserted.
 *
 * Pure so it can be tested without a database; `dailyStats` hands it the rows
 * it already has. Ordering: sufficient rows first, biggest |delta| at the top
 * (that is the answer to "which of these 18 matter"), ties broken by label;
 * insufficient rows follow alphabetically, because ordering them by a delta
 * nobody should trust would rank noise.
 */
export function computeHabitFelt(
  days: ReadonlyArray<{ day: Day; subjective: number | null }>,
  habits: ReadonlyArray<{ id: string; key: string; label: string; icon: string }>,
  ticksByHabit: ReadonlyMap<string, readonly Day[]>,
): HabitFelt {
  const rated = days.filter(
    (d): d is { day: Day; subjective: number } => typeof d.subjective === "number",
  );
  const ratedDays = rated.length;

  const rows: HabitFeltRow[] = habits.map((h) => {
    const ticked = new Set(ticksByHabit.get(h.id) ?? []);
    const withVals: number[] = [];
    const withoutVals: number[] = [];
    for (const d of rated) {
      (ticked.has(d.day) ? withVals : withoutVals).push(d.subjective);
    }
    const mean = (xs: number[]): number | null =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    const rawWith = mean(withVals);
    const rawWithout = mean(withoutVals);
    return {
      habit_id: h.id,
      key: h.key,
      label: h.label,
      icon: h.icon,
      n_with: withVals.length,
      n_without: withoutVals.length,
      mean_with: round2(rawWith),
      mean_without: round2(rawWithout),
      delta:
        rawWith === null || rawWithout === null ? null : round2(rawWith - rawWithout),
      sufficient:
        ratedDays >= HABIT_FELT_MIN_RATED_DAYS &&
        withVals.length >= HABIT_FELT_MIN_SIDE &&
        withoutVals.length >= HABIT_FELT_MIN_SIDE,
    };
  });

  rows.sort((a, b) => {
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    if (a.sufficient && b.sufficient) {
      const d = Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0);
      if (d !== 0) return d;
    }
    return a.label.localeCompare(b.label);
  });

  return {
    rated_days: ratedDays,
    needed: HABIT_FELT_MIN_RATED_DAYS,
    sufficient: rows.some((r) => r.sufficient),
    rows,
  };
}

/**
 * "Did this week move anything that matters" — grouped from the week's
 * completed tasks.
 *
 * Pure, for the same reason as above. A row whose `goal_id` is null counts
 * towards `unlinked_done` and appears in no group: the point of the tile is the
 * ratio between what was finished and what was finished *towards something*,
 * and folding the orphans into a bucket called "other" would hide exactly that.
 * Groups are ordered by minutes, then task count, then title — minutes first
 * because an hour is the scarce thing, not a checkbox.
 */
export function groupGoalsWeek(
  from: Day,
  to: Day,
  rows: ReadonlyArray<{
    goal_id: string | null;
    goal_title: string | null;
    goal_horizon: string | null;
    minutes: number;
  }>,
): GoalsWeek {
  const moved = new Map<string, GoalsWeekMoved>();
  let unlinked = 0;

  for (const row of rows) {
    if (row.goal_id === null) {
      unlinked++;
      continue;
    }
    if (row.goal_title === null || row.goal_horizon === null) {
      throw new Error(
        `groupGoalsWeek: task links goal ${row.goal_id} but the join returned no ` +
          `title/horizon for it — a dangling goal_id should be impossible under ` +
          `0050's foreign key`,
      );
    }
    const existing = moved.get(row.goal_id);
    if (existing) {
      existing.tasks_done++;
      existing.minutes += row.minutes;
    } else {
      moved.set(row.goal_id, {
        goal_id: row.goal_id,
        title: row.goal_title,
        horizon: row.goal_horizon,
        tasks_done: 1,
        minutes: row.minutes,
      });
    }
  }

  return {
    week_start: from,
    week_end: to,
    total_done: rows.length,
    unlinked_done: unlinked,
    moved: [...moved.values()].sort(
      (a, b) =>
        b.minutes - a.minutes ||
        b.tasks_done - a.tasks_done ||
        a.title.localeCompare(b.title),
    ),
  };
}

export const STATS_DEFAULT_DAYS = 90;
export const STATS_MAX_DAYS = 366;

export async function dailyStats(days: number, today: Day): Promise<DailyStats> {
  const from = shiftDay(today, -(days - 1));
  const window = daysBack(today, days).reverse();
  const weekFrom = weekStart(today);
  const weekTo = shiftDay(weekFrom, 6);

  const [habits, tickHistory, plans, plannedAgg, doneAgg, taskCounts, weekDone] =
    await Promise.all([
    listHabits({ activeOnly: true }),
    allTickHistory(),
    pool.query<{
      day: Day;
      big3: Big3Goal[];
      subjective: number | null;
      committed_at: string | null;
    }>(
      `SELECT day::text, big3, subjective, committed_at::text
         FROM day_plans WHERE day BETWEEN $1 AND $2 ORDER BY day`,
      [from, today],
    ),
    pool.query<{ day: Day; total: number; done: number }>(
      `SELECT planned_day::text AS day,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'done')::int AS done
         FROM day_tasks
        WHERE planned_day BETWEEN $1 AND $2
        GROUP BY planned_day`,
      [from, today],
    ),
    pool.query<{ day: Day; n: number }>(
      `SELECT (done_at AT TIME ZONE 'Europe/Berlin')::date::text AS day,
              count(*)::int AS n
         FROM day_tasks
        WHERE status = 'done' AND done_at IS NOT NULL
          AND (done_at AT TIME ZONE 'Europe/Berlin')::date BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [from, today],
    ),
    pool.query<{ open: number; stale: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('todo','doing'))::int AS open,
              count(*) FILTER (WHERE status IN ('todo','doing')
                                 AND carried >= $1)::int AS stale
         FROM day_tasks`,
      [STALE_AT],
    ),
    // The goals rollup is the CURRENT Mon–Sun Berlin week, not the tail of the
    // stats window: "did this week move anything that matters" is a question
    // about this week whether the user is looking at 30 days or 90.
    doneTasksInRange(weekFrom, weekTo),
  ]);

  const activeIds = new Set(habits.map((h) => h.id));
  const weightOf = new Map(habits.map((h) => [h.id, h.weight]));
  const doneWeightByDay = new Map<Day, number>();
  const daysByHabit = new Map<string, Day[]>();
  for (const row of tickHistory) {
    if (!activeIds.has(row.habit_id)) continue;
    doneWeightByDay.set(
      row.day,
      (doneWeightByDay.get(row.day) ?? 0) + (weightOf.get(row.habit_id) ?? 0),
    );
    const list = daysByHabit.get(row.habit_id);
    if (list) list.push(row.day);
    else daysByHabit.set(row.habit_id, [row.day]);
  }

  const planByDay = new Map(plans.rows.map((p) => [p.day, p]));
  const plannedByDay = new Map(plannedAgg.rows.map((t) => [t.day, t]));
  const totalWeight = habits.reduce((n, h) => n + h.weight, 0);

  const dayRows: DailyStats["days"] = window.map((day) => {
    const plan = planByDay.get(day);
    const committed = plan?.committed_at ? plan.big3 : [];
    const planned = plannedByDay.get(day);
    const doneWeight = doneWeightByDay.get(day) ?? 0;
    const s = computeDayScore({
      habits:
        totalWeight > 0
          ? [
              { weight: doneWeight, done: true },
              { weight: totalWeight - doneWeight, done: false },
            ]
          : [],
      big3: committed,
      tasks: planned
        ? Array.from({ length: planned.total }, (_, i) => ({ done: i < planned.done }))
        : [],
    });
    return {
      day,
      score: s.score,
      habit_pct: s.habit_pct,
      goal_pct: s.goal_pct,
      task_pct: s.task_pct,
      subjective: plan?.subjective ?? null,
    };
  });

  const last30 = new Set(daysBack(today, 30));
  const inWindow = new Set(window);
  const windowTicks = new Map<string, Day[]>();
  const habitRows: DailyStats["habits"] = habits.map((h) => {
    const all = daysByHabit.get(h.id) ?? [];
    const ticks30 = all.filter((d) => last30.has(d));
    const ticks = all.filter((d) => inWindow.has(d)).sort();
    windowTicks.set(h.id, ticks);
    return {
      id: h.id,
      key: h.key,
      label: h.label,
      icon: h.icon,
      grp: h.grp,
      rate30: Math.round((ticks30.length / 30) * 1000) / 1000,
      streak: streakEndingToday(all, today),
      best: bestStreak(all),
      ticks30: ticks30.slice().sort(),
      ticks,
    };
  });

  let committed = 0;
  let goalsDone = 0;
  let abandoned = 0;
  for (const p of plans.rows) {
    if (!p.committed_at) continue;
    for (const g of p.big3) {
      committed++;
      if (g.status === "done") goalsDone++;
      else if (g.status === "abandoned") abandoned++;
    }
  }

  const fulfilledDays = dayRows
    .filter((d) => d.score !== null && d.score >= FULFILLED_AT)
    .map((d) => d.day);

  return {
    window: { days, from, to: today },
    days: dayRows,
    habits: habitRows,
    said_vs_done: {
      committed,
      done: goalsDone,
      abandoned,
      open: committed - goalsDone - abandoned,
      rate: committed > 0 ? goalsDone / committed : null,
    },
    tasks: {
      done_by_day: doneAgg.rows,
      open: taskCounts.rows[0]?.open ?? 0,
      stale: taskCounts.rows[0]?.stale ?? 0,
    },
    streak: {
      current: streakEndingToday(fulfilledDays, today),
      best: bestStreak(fulfilledDays),
    },
    habit_felt: computeHabitFelt(
      dayRows.map((d) => ({ day: d.day, subjective: d.subjective })),
      habits,
      windowTicks,
    ),
    goals_week: groupGoalsWeek(
      weekFrom,
      weekTo,
      weekDone.map((t) => ({
        goal_id: t.goal_id,
        goal_title: t.goal_title,
        goal_horizon: t.goal_horizon,
        minutes: t.minutes,
      })),
    ),
  };
}
