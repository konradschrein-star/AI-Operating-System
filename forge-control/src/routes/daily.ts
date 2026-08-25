/**
 * GOALS/TASKS routes — daily planning, habits, tasks, life goals, and Google Calendar.
 *
 *   GET    /api/daily?day=YYYY-MM-DD      → { day, plan, habits[], ticks[], tasks[], score }
 *   POST   /api/daily/:day/plan           { intent?, big3? }  fluid draft editing
 *   POST   /api/daily/:day/commit         marks morning plan committed; idempotent
 *   POST   /api/daily/:day/goal/:goalId   { status, reason? }
 *   POST   /api/daily/:day/reflect        { subjective?:1..10, reflection? }
 *   POST   /api/daily/:day/habit/:habitId { done: boolean }
 *
 *   GET    /api/daily/tasks?view=today|week|backlog|all&area=&status=
 *   POST   /api/daily/tasks
 *   PATCH  /api/daily/tasks/:id
 *   DELETE /api/daily/tasks/:id
 *   POST   /api/daily/rollover            { to? }  idempotent
 *
 *   GET    /api/daily/goals?horizon=&status=&area=
 *   POST   /api/daily/goals
 *   PATCH  /api/daily/goals/:id
 *   DELETE /api/daily/goals/:id
 *
 *   GET    /api/daily/calendar?view=day|week&day=YYYY-MM-DD
 *   GET    /api/daily/calendar?start=...&end=...&max=...   (bare dates OK, Berlin-resolved)
 *   POST   /api/daily/calendar/events     { summary, start, end, location?, description?, task_id? }
 *   PATCH  /api/daily/calendar/events/:id { summary?, start?, end?, location?, description?, task_id? }
 *   DELETE /api/daily/calendar/events/:id
 *   POST   /api/daily/calendar/sync       { day?, view?: day|week, dry_run? }  GCal → tasks, idempotent
 *   POST   /api/daily/gtasks/sync         { tasklist?, dry_run? }  Google Tasks ↔ board, both ways
 *   POST   /api/daily/quick               { kind: todo|appointment, text }  one-line capture
 *   GET    /api/daily/glucose?view=day|week&day=…   blood glucose for the grid overlay
 *
 *   GET    /api/daily/stats?days=90
 *   GET    /api/daily/habits
 *   POST   /api/daily/habits
 *   PATCH  /api/daily/habits/:id
 *
 * ROUTE ORDER IS LOAD-BEARING. The static paths (/tasks, /goals, /calendar, /habits, /stats)
 * are registered BEFORE the /:day/* family so that static names are never matched as day params.
 */

import { Hono } from "hono";
import {
  getPlan,
  upsertPlanDraft,
  commitDay,
  setGoalStatus,
  reflect,
  normaliseBig3,
  listHabits,
  getHabit,
  createHabit,
  updateHabit,
  setTick,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  unlinkTasksFromEvent,
  rolloverTasks,
  listLifeGoals,
  getLifeGoal,
  createLifeGoal,
  updateLifeGoal,
  deleteLifeGoal,
  dayBundle,
  dailyStats,
  PlanCommittedError,
  STALE_AT,
  STATS_DEFAULT_DAYS,
  STATS_MAX_DAYS,
  TASK_STATUSES,
  TASK_VIEWS,
  GOAL_HORIZONS,
  LIFE_GOAL_STATUSES,
  type Big3Goal,
  type TaskStatus,
  type TaskView,
} from "../db/daily.ts";
import { berlinDay, isDay, type Day } from "../lib/day-score.ts";
import {
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  normaliseWindowEdge,
  dayWindow,
  weekWindow,
} from "../lib/calendar.ts";
import { syncCalendarWindow, berlinDayOfInstant } from "../lib/calendar-sync.ts";
import { syncGoogleTasks } from "../lib/gtasks-sync.ts";
import { parseTodo, parseAppointment } from "../lib/quick-parse.ts";
import { listReadings, latestReading } from "../db/glucose.ts";

const r = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BIG3_MAX = 3;
const TITLE_MAX = 300;
const GOAL_STATUSES = ["open", "done", "abandoned"] as const;
type GoalStatusLiteral = (typeof GOAL_STATUSES)[number];

type Body = Record<string, unknown>;

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Body> {
  const parsed = await c.req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" ? (parsed as Body) : {};
}

function has(body: Body, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

function intInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      ok: false,
      error: `${field} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`,
    };
  }
  if (value < min || value > max) {
    return { ok: false, error: `${field} must be between ${min} and ${max}, got ${value}` };
  }
  return { ok: true, value };
}

function decorate<T extends { carried: number }>(task: T): T & { stale: boolean } {
  return { ...task, stale: task.carried >= STALE_AT };
}


// ===========================================================================
// Static paths first — see the header note on route order.
// ===========================================================================

// --- Google Calendar -------------------------------------------------------

/**
 * GET /api/daily/calendar
 *
 *   ?view=week&day=YYYY-MM-DD   → the Mon–Sun week containing `day`
 *   ?view=day&day=YYYY-MM-DD    → that whole Berlin day
 *   ?start=…&end=…              → an explicit window; bare dates are resolved
 *                                 through Europe/Berlin, `end` inclusive
 *
 * The window that was actually asked of Google comes back in `window`, because
 * "no events" and "wrong window" are indistinguishable to anyone reading the
 * response — and the previous version of this route made exactly that mistake.
 */
r.get("/calendar", async (c) => {
  const maxRaw = c.req.query("max");
  let max: number | undefined = undefined;
  if (maxRaw !== undefined) {
    const parsed = Number(maxRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
      return c.json({ error: `max must be an integer between 1 and 250, got "${maxRaw}"` }, 400);
    }
    max = parsed;
  }

  const view = c.req.query("view");
  if (view !== undefined && view !== "day" && view !== "week") {
    return c.json({ error: `view must be "day" or "week", got "${view}"` }, 400);
  }

  const rawDay = c.req.query("day");
  if (rawDay !== undefined && !isDay(rawDay)) {
    return c.json({ error: `day must be YYYY-MM-DD, got "${rawDay}"` }, 400);
  }
  const day: Day = rawDay ?? berlinDay();

  let start: string | undefined;
  let end: string | undefined;
  let from: Day | undefined;
  let to: Day | undefined;

  if (view === "week") {
    const w = weekWindow(day);
    ({ start, end, from, to } = w);
  } else if (view === "day") {
    ({ start, end } = dayWindow(day));
    from = day;
    to = day;
  } else {
    start = normaliseWindowEdge(c.req.query("start"), "start");
    end = normaliseWindowEdge(c.req.query("end"), "end");
  }

  try {
    const events = await listCalendarEvents({ start, end, max: max ?? 250 });
    return c.json({
      ok: true,
      count: events.length,
      window: { start: start ?? null, end: end ?? null, from: from ?? null, to: to ?? null },
      events,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to fetch Google Calendar events: ${msg}` }, 502);
  }
});

/** PATCH /api/daily/calendar/events/:id — move or retitle an event in place. */
r.patch("/calendar/events/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readBody(c);

  const patch: Record<string, string> = {};
  for (const field of ["summary", "start", "end", "location", "description"] as const) {
    if (has(body, field)) {
      if (typeof body[field] !== "string") {
        return c.json({ error: `${field} must be a string` }, 400);
      }
      patch[field] = body[field] as string;
    }
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "at least one of summary, start, end, location, description" }, 400);
  }

  try {
    const event = await updateCalendarEvent(id, patch);

    // Keep a linked task's own copy of the time in step, or the board and the
    // calendar disagree until the next full sync.
    if (has(body, "task_id") && typeof body.task_id === "string" && UUID_RE.test(body.task_id)) {
      const taskPatch: Record<string, unknown> = {};
      if (patch.start) {
        taskPatch.start_time = patch.start;
        taskPatch.planned_day = berlinDayOfInstant(patch.start);
      }
      if (Object.keys(taskPatch).length > 0) {
        await updateTask(body.task_id, taskPatch).catch(() => null);
      }
    }

    return c.json({ ok: true, event });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to update Google Calendar event: ${msg}` }, 502);
  }
});

/** DELETE /api/daily/calendar/events/:id — also unlinks any task pointing at it. */
r.delete("/calendar/events/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await deleteCalendarEvent(id);
    await unlinkTasksFromEvent(id).catch(() => null);
    return c.json({ ok: true, deleted: id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to delete Google Calendar event: ${msg}` }, 502);
  }
});

/**
 * POST /api/daily/calendar/sync — pull Google Calendar into the task board.
 *
 *   { day?: YYYY-MM-DD, view?: "day"|"week", dry_run?: boolean }
 *
 * Konrad's rule: "if in Google Calendar I enter a time slot, for example going
 * to the doctor, it should automatically turn into a task." So every timed event
 * in the window becomes a task, keyed on `gcal_event_id` — which makes the whole
 * operation idempotent, and makes a moved event an UPDATE rather than a second
 * task.
 *
 * All-day events are skipped on purpose: birthdays, public holidays and
 * multi-day trips are not units of work, and importing them would bury the
 * board on its first run. Cancelled events are skipped for the same reason.
 */
r.post("/calendar/sync", async (c) => {
  const body = await readBody(c);

  const rawDay = has(body, "day") ? body.day : undefined;
  if (rawDay !== undefined && !isDay(rawDay)) {
    return c.json({ error: `day must be YYYY-MM-DD, got ${JSON.stringify(rawDay)}` }, 400);
  }
  const day: Day = (rawDay as Day) ?? berlinDay();
  const view = has(body, "view") ? body.view : "week";
  if (view !== "day" && view !== "week") {
    return c.json({ error: `view must be "day" or "week", got ${JSON.stringify(view)}` }, 400);
  }
  const dryRun = has(body, "dry_run") && body.dry_run === true;

  try {
    const r = await syncCalendarWindow({ day, view, dryRun });
    return c.json({
      ok: true,
      dry_run: r.dry_run,
      window: r.window,
      events: r.events,
      created: r.created.length,
      updated: r.updated.length,
      skipped: r.skipped.length,
      detail: { created: r.created, updated: r.updated, skipped: r.skipped },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Calendar sync failed: ${msg}` }, 502);
  }
});

/**
 * POST /api/daily/gtasks/sync — Google Tasks in both directions.
 *
 * Who wins is decided per row by the cached `gtask_updated` stamp, not by a
 * clock comparison across two machines. See lib/gtasks-sync.ts.
 */
r.post("/gtasks/sync", async (c) => {
  const body = await readBody(c);

  const tasklist =
    has(body, "tasklist") && typeof body.tasklist === "string"
      ? (body.tasklist as string)
      : undefined;
  const dryRun = has(body, "dry_run") && body.dry_run === true;

  try {
    const r2 = await syncGoogleTasks({ tasklist, dryRun });
    return c.json({
      ok: true,
      dry_run: r2.dry_run,
      tasklist: r2.tasklist,
      remote: r2.remote,
      pushed_new: r2.pushed_new.length,
      pushed_update: r2.pushed_update.length,
      pulled_new: r2.pulled_new.length,
      pulled_update: r2.pulled_update.length,
      unchanged: r2.unchanged,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Google Tasks sync failed: ${msg}` }, 502);
  }
});

/**
 * POST /api/daily/quick — one-line capture, shared by every surface.
 *
 *   { kind: "todo",        text: "buy proxies @business !high ~90m due:friday" }
 *   { kind: "appointment", text: "dentist tomorrow 14:00 90m" }
 *
 * The desktop composer, the Telegram bridge and the manager agent all land here
 * rather than each growing their own grammar — the failure mode being that
 * `/todo` means one thing on the phone and another on the desktop.
 */
r.post("/quick", async (c) => {
  const body = await readBody(c);
  const kind = has(body, "kind") ? body.kind : "todo";
  const text = has(body, "text") && typeof body.text === "string" ? (body.text as string) : "";

  if (!text.trim()) {
    return c.json({ error: "text is required" }, 400);
  }

  if (kind === "todo") {
    const parsed = parseTodo(text);
    if (!parsed) return c.json({ error: "could not read a task out of that" }, 400);

    const task = await createTask({
      title: parsed.title,
      area: parsed.area,
      importance: parsed.importance,
      planned_day: parsed.planned_day,
      due_day: parsed.due_day,
      est_min: parsed.est_min,
    });
    // Not synced to Google here on purpose: the 5-minute tick owns that, and
    // doing it inline would make a capture wait on a network round trip.
    return c.json({ ok: true, kind: "todo", task: decorate(task), applied: parsed.applied }, 201);
  }

  if (kind === "appointment") {
    const parsed = parseAppointment(text);
    if (!parsed) {
      return c.json(
        {
          error:
            'no time found — try "dentist tomorrow 14:00 90m" or "call Sem in 2h"',
        },
        400,
      );
    }
    try {
      const event = await createCalendarEvent({
        summary: parsed.summary,
        start: parsed.start,
        end: parsed.end,
      });
      return c.json(
        {
          ok: true,
          kind: "appointment",
          event,
          start: parsed.start,
          end: parsed.end,
          duration_min: parsed.durationMin,
        },
        201,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to create calendar event: ${msg}` }, 502);
    }
  }

  return c.json({ error: `kind must be "todo" or "appointment", got ${JSON.stringify(kind)}` }, 400);
});

/**
 * GET /api/daily/glucose — readings for the week board's overlay.
 *
 * Same window grammar as /calendar, so the overlay and the grid can never
 * disagree about which days they are drawing.
 *
 * Answers 200 with an empty array when nothing has been collected yet. An empty
 * chart is a true statement about a sensor that has not reported; a 404 would
 * read as a broken feature.
 */
r.get("/glucose", async (c) => {
  const view = c.req.query("view");
  if (view !== undefined && view !== "day" && view !== "week") {
    return c.json({ error: `view must be "day" or "week", got "${view}"` }, 400);
  }
  const rawDay = c.req.query("day");
  if (rawDay !== undefined && !isDay(rawDay)) {
    return c.json({ error: `day must be YYYY-MM-DD, got "${rawDay}"` }, 400);
  }
  const day: Day = rawDay ?? berlinDay();
  const w = view === "day" ? dayWindow(day) : weekWindow(day);

  try {
    const [readings, latest] = await Promise.all([
      listReadings(w.start, w.end),
      latestReading(),
    ]);
    return c.json({
      ok: true,
      window: { start: w.start, end: w.end },
      count: readings.length,
      latest,
      readings,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to read glucose: ${msg}` }, 500);
  }
});

r.post("/calendar/events", async (c) => {
  const body = await readBody(c);

  if (!has(body, "summary") || typeof body.summary !== "string" || !(body.summary as string).trim()) {
    return c.json({ error: "summary is required and must be a non-empty string" }, 400);
  }
  if (!has(body, "start") || typeof body.start !== "string") {
    return c.json({ error: "start is required (ISO 8601 datetime with timezone)" }, 400);
  }
  if (!has(body, "end") || typeof body.end !== "string") {
    return c.json({ error: "end is required (ISO 8601 datetime with timezone)" }, 400);
  }

  try {
    const result = await createCalendarEvent({
      summary: (body.summary as string).trim(),
      start: body.start as string,
      end: body.end as string,
      location: typeof body.location === "string" ? (body.location as string).trim() : undefined,
      description: typeof body.description === "string" ? (body.description as string).trim() : undefined,
    });

    // Optional task linking
    if (has(body, "task_id") && typeof body.task_id === "string" && UUID_RE.test(body.task_id)) {
      await updateTask(body.task_id, {
        gcal_event_id: result.id,
        start_time: body.start as string,
      }).catch(() => null);
    }

    return c.json({ ok: true, event: result }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to create Google Calendar event: ${msg}` }, 502);
  }
});

// --- Life Goals (Strategic Horizons) ---------------------------------------

r.get("/goals", async (c) => {
  const horizon = c.req.query("horizon") || undefined;
  const status = c.req.query("status") || undefined;
  const area = c.req.query("area") || undefined;

  const goals = await listLifeGoals({ horizon, status, area });
  return c.json({ ok: true, count: goals.length, goals });
});

r.post("/goals", async (c) => {
  const body = await readBody(c);

  if (!has(body, "title") || typeof body.title !== "string" || !(body.title as string).trim()) {
    return c.json({ error: "title is required and must be a non-empty string" }, 400);
  }
  const title = (body.title as string).trim();
  if (title.length > TITLE_MAX) {
    return c.json({ error: `title must be at most ${TITLE_MAX} characters, got ${title.length}` }, 400);
  }

  if (has(body, "progress") && body.progress !== null) {
    const v = intInRange(body.progress, "progress", 0, 100);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }

  for (const field of ["started_day", "target_day"]) {
    if (has(body, field) && body[field] !== null && !isDay(body[field])) {
      return c.json(
        { error: `${field} must be a real calendar day as YYYY-MM-DD or null, got ${JSON.stringify(body[field])}` },
        400,
      );
    }
  }

  const goal = await createLifeGoal({
    title,
    status: typeof body.status === "string" ? (body.status as string).trim() : undefined,
    horizon: typeof body.horizon === "string" ? (body.horizon as string).trim() : undefined,
    area: typeof body.area === "string" ? (body.area as string).trim() : null,
    progress: typeof body.progress === "number" ? body.progress : undefined,
    started_day: (body.started_day as Day | null | undefined) ?? null,
    target_day: (body.target_day as Day | null | undefined) ?? null,
    notes: typeof body.notes === "string" ? body.notes : null,
  });

  return c.json({ ok: true, goal }, 201);
});

r.patch("/goals/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: `invalid goal id "${id}" — expected a uuid` }, 400);

  const body = await readBody(c);

  if (has(body, "title")) {
    if (typeof body.title !== "string" || !(body.title as string).trim()) {
      return c.json({ error: "title must be a non-empty string" }, 400);
    }
    if ((body.title as string).length > TITLE_MAX) {
      return c.json({ error: `title must be at most ${TITLE_MAX} characters` }, 400);
    }
  }

  if (has(body, "progress") && body.progress !== null) {
    const v = intInRange(body.progress, "progress", 0, 100);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }

  for (const field of ["started_day", "target_day"]) {
    if (has(body, field) && body[field] !== null && !isDay(body[field])) {
      return c.json(
        { error: `${field} must be a real calendar day as YYYY-MM-DD or null, got ${JSON.stringify(body[field])}` },
        400,
      );
    }
  }

  const patch: Parameters<typeof updateLifeGoal>[1] = {};
  if (has(body, "title")) patch.title = (body.title as string).trim();
  if (has(body, "status")) patch.status = (body.status as string).trim();
  if (has(body, "horizon")) patch.horizon = (body.horizon as string).trim();
  if (has(body, "area")) patch.area = body.area as string | null;
  if (has(body, "progress")) patch.progress = body.progress as number;
  if (has(body, "started_day")) patch.started_day = body.started_day as Day | null;
  if (has(body, "target_day")) patch.target_day = body.target_day as Day | null;
  if (has(body, "notes")) patch.notes = body.notes as string | null;

  const goal = await updateLifeGoal(id, patch);
  if (!goal) return c.json({ error: `goal ${id} not found` }, 404);
  return c.json({ ok: true, goal });
});

r.delete("/goals/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: `invalid goal id "${id}" — expected a uuid` }, 400);

  const ok = await deleteLifeGoal(id);
  if (!ok) return c.json({ error: `goal ${id} not found` }, 404);
  return c.json({ ok: true, deleted: id });
});

// --- Tasks -----------------------------------------------------------------

r.get("/tasks", async (c) => {
  const today = berlinDay();
  const rawView = c.req.query("view");
  if (rawView !== undefined && !TASK_VIEWS.includes(rawView as TaskView)) {
    return c.json(
      { error: `view must be one of ${TASK_VIEWS.join(", ")}, got "${rawView}"` },
      400,
    );
  }
  const rawStatus = c.req.query("status");
  if (rawStatus !== undefined && !TASK_STATUSES.includes(rawStatus as TaskStatus)) {
    return c.json(
      { error: `status must be one of ${TASK_STATUSES.join(", ")}, got "${rawStatus}"` },
      400,
    );
  }
  const tasks = await listTasks({
    view: (rawView as TaskView | undefined) ?? "all",
    area: c.req.query("area") || undefined,
    status: rawStatus as TaskStatus | undefined,
    today,
  });
  const decorated = tasks.map(decorate);
  return c.json({
    view: rawView ?? "all",
    day: today,
    count: decorated.length,
    stale_at: STALE_AT,
    tasks: decorated,
  });
});

function validateTaskFields(body: Body): string | null {
  if (has(body, "title")) {
    const t = body.title;
    if (typeof t !== "string" || t.trim() === "") return "title must be a non-empty string";
    if (t.length > TITLE_MAX) {
      return `title must be at most ${TITLE_MAX} characters, got ${t.length}`;
    }
  }
  if (has(body, "importance") && body.importance !== null) {
    const v = intInRange(body.importance, "importance", 0, 5);
    if (!v.ok) return `${v.error} (3 critical / 2 high / 1 normal / 0 low)`;
  }
  if (has(body, "status") && body.status !== null) {
    if (!TASK_STATUSES.includes(body.status as TaskStatus)) {
      return `status must be one of ${TASK_STATUSES.join(", ")}, got ${JSON.stringify(body.status)}`;
    }
  }
  if (has(body, "est_min") && body.est_min !== null) {
    const v = intInRange(body.est_min, "est_min", 0, 24 * 60);
    if (!v.ok) return v.error;
  }
  if (has(body, "duration_min") && body.duration_min !== null) {
    const v = intInRange(body.duration_min, "duration_min", 1, 24 * 60);
    if (!v.ok) return v.error;
  }
  if (has(body, "carried") && body.carried !== null) {
    const v = intInRange(body.carried, "carried", 0, 999);
    if (!v.ok) return v.error;
  }
  for (const field of ["planned_day", "due_day"]) {
    if (has(body, field) && body[field] !== null && !isDay(body[field])) {
      return `${field} must be a real calendar day as YYYY-MM-DD or null, got ${JSON.stringify(body[field])}`;
    }
  }
  for (const field of ["area", "notes", "gcal_event_id"]) {
    if (has(body, field) && body[field] !== null && typeof body[field] !== "string") {
      return `${field} must be a string or null, got ${JSON.stringify(body[field])}`;
    }
  }
  if (has(body, "start_time") && body.start_time !== null) {
    if (typeof body.start_time !== "string" || Number.isNaN(Date.parse(body.start_time as string))) {
      return "start_time must be a valid ISO timestamp or null";
    }
  }
  return null;
}

r.post("/tasks", async (c) => {
  const body = await readBody(c);
  if (!has(body, "title")) return c.json({ error: "title is required" }, 400);
  const bad = validateTaskFields(body);
  if (bad) return c.json({ error: bad }, 400);
  const task = await createTask({
    title: (body.title as string).trim(),
    area: (body.area as string | null | undefined) ?? null,
    importance: (body.importance as number | null | undefined) ?? null,
    status: (body.status as TaskStatus | null | undefined) ?? null,
    planned_day: (body.planned_day as Day | null | undefined) ?? null,
    due_day: (body.due_day as Day | null | undefined) ?? null,
    est_min: (body.est_min as number | null | undefined) ?? null,
    notes: (body.notes as string | null | undefined) ?? null,
    start_time: (body.start_time as string | null | undefined) ?? null,
    duration_min: (body.duration_min as number | null | undefined) ?? null,
    gcal_event_id: (body.gcal_event_id as string | null | undefined) ?? null,
  });
  return c.json({ ok: true, task: decorate(task) }, 201);
});

r.patch("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: `invalid task id "${id}" — expected a uuid` }, 400);
  const body = await readBody(c);
  const bad = validateTaskFields(body);
  if (bad) return c.json({ error: bad }, 400);

  const patch: Parameters<typeof updateTask>[1] = {};
  if (has(body, "title")) patch.title = (body.title as string).trim();
  if (has(body, "area")) patch.area = body.area as string | null;
  if (has(body, "importance")) {
    // PATCH had no range check at all, which is how the scale could drift
    // silently before 0049 added a CHECK. Validate here so the caller gets a
    // 400 rather than a constraint violation surfacing as a 500.
    const v = intInRange(body.importance, "importance", 0, 5);
    if (!v.ok) return c.json({ error: v.error }, 400);
    patch.importance = v.value;
  }
  if (has(body, "status")) patch.status = body.status as TaskStatus;
  if (has(body, "planned_day")) patch.planned_day = body.planned_day as Day | null;
  if (has(body, "due_day")) patch.due_day = body.due_day as Day | null;
  if (has(body, "est_min")) patch.est_min = body.est_min as number | null;
  if (has(body, "notes")) patch.notes = body.notes as string | null;
  if (has(body, "carried")) patch.carried = body.carried as number;
  if (has(body, "start_time")) patch.start_time = body.start_time as string | null;
  if (has(body, "duration_min")) patch.duration_min = body.duration_min as number | null;
  if (has(body, "gcal_event_id")) patch.gcal_event_id = body.gcal_event_id as string | null;

  const task = await updateTask(id, patch);
  if (!task) return c.json({ error: `task ${id} not found` }, 404);
  return c.json({ ok: true, task: decorate(task) });
});

r.delete("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: `invalid task id "${id}" — expected a uuid` }, 400);
  const ok = await deleteTask(id);
  if (!ok) return c.json({ error: `task ${id} not found` }, 404);
  return c.json({ ok: true, deleted: id });
});

r.post("/rollover", async (c) => {
  const body = await readBody(c);
  const to = has(body, "to") ? body.to : berlinDay();
  if (!isDay(to)) {
    return c.json(
      { error: `to must be a real calendar day as YYYY-MM-DD, got ${JSON.stringify(body.to)}` },
      400,
    );
  }
  const moved = await rolloverTasks(to);
  return c.json({
    ok: true,
    to,
    carried: moved.length,
    stale: moved.filter((t) => t.carried >= STALE_AT).length,
    tasks: moved.map(decorate),
  });
});

// --- Habit definitions -----------------------------------------------------

r.get("/habits", async (c) => {
  const activeOnly = c.req.query("active") === "true";
  const habits = await listHabits({ activeOnly });
  return c.json({ count: habits.length, habits });
});

r.post("/habits", async (c) => {
  const body = await readBody(c);
  for (const field of ["key", "label", "icon", "grp"]) {
    if (typeof body[field] !== "string" || (body[field] as string).trim() === "") {
      return c.json({ error: `${field} is required and must be a non-empty string` }, 400);
    }
  }
  if (has(body, "polarity") && body.polarity !== "do" && body.polarity !== "avoid") {
    return c.json(
      { error: `polarity must be "do" or "avoid", got ${JSON.stringify(body.polarity)}` },
      400,
    );
  }
  if (has(body, "weight")) {
    const v = intInRange(body.weight, "weight", 1, 5);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  if (has(body, "sort")) {
    const v = intInRange(body.sort, "sort", 0, 999);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  const habit = await createHabit({
    key: (body.key as string).trim(),
    label: (body.label as string).trim(),
    icon: (body.icon as string).trim(),
    grp: (body.grp as string).trim(),
    polarity: body.polarity as "do" | "avoid" | undefined,
    weight: body.weight as number | undefined,
    sort: body.sort as number | undefined,
  });
  if (!habit) {
    return c.json(
      {
        error: `habit key "${(body.key as string).trim()}" already exists — keys are stable slugs and are never reused. PATCH the existing habit instead.`,
      },
      409,
    );
  }
  return c.json({ ok: true, habit }, 201);
});

r.patch("/habits/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: `invalid habit id "${id}" — expected a uuid` }, 400);
  const body = await readBody(c);
  if (has(body, "polarity") && body.polarity !== "do" && body.polarity !== "avoid") {
    return c.json(
      { error: `polarity must be "do" or "avoid", got ${JSON.stringify(body.polarity)}` },
      400,
    );
  }
  if (has(body, "active") && typeof body.active !== "boolean") {
    return c.json({ error: `active must be a boolean, got ${JSON.stringify(body.active)}` }, 400);
  }
  if (has(body, "weight")) {
    const v = intInRange(body.weight, "weight", 1, 5);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  if (has(body, "sort")) {
    const v = intInRange(body.sort, "sort", 0, 999);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  for (const field of ["label", "icon", "grp"]) {
    if (has(body, field) && (typeof body[field] !== "string" || (body[field] as string).trim() === "")) {
      return c.json({ error: `${field} must be a non-empty string` }, 400);
    }
  }
  const habit = await updateHabit(id, {
    label: has(body, "label") ? (body.label as string).trim() : undefined,
    icon: has(body, "icon") ? (body.icon as string).trim() : undefined,
    grp: has(body, "grp") ? (body.grp as string).trim() : undefined,
    polarity: body.polarity as "do" | "avoid" | undefined,
    weight: body.weight as number | undefined,
    sort: body.sort as number | undefined,
    active: body.active as boolean | undefined,
  });
  if (!habit) return c.json({ error: `habit ${id} not found` }, 404);
  return c.json({ ok: true, habit });
});

// --- Stats -----------------------------------------------------------------

r.get("/stats", async (c) => {
  const raw = c.req.query("days");
  let days = STATS_DEFAULT_DAYS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > STATS_MAX_DAYS) {
      return c.json(
        { error: `days must be an integer between 1 and ${STATS_MAX_DAYS}, got "${raw}"` },
        400,
      );
    }
    days = n;
  }
  return c.json(await dailyStats(days, berlinDay()));
});

// ===========================================================================
// The day itself
// ===========================================================================

r.get("/", async (c) => {
  const today = berlinDay();
  const raw = c.req.query("day");
  if (raw !== undefined && !isDay(raw)) {
    return c.json(
      { error: `day must be a real calendar day as YYYY-MM-DD, got "${raw}"` },
      400,
    );
  }
  const day = raw ?? today;
  const bundle = await dayBundle(day, today);
  return c.json({ ...bundle, tasks: bundle.tasks.map(decorate), stale_at: STALE_AT });
});

function requireDay(day: string): { ok: true } | { ok: false; error: string } {
  if (!isDay(day)) {
    return {
      ok: false,
      error: `day must be a real calendar day as YYYY-MM-DD, got "${day}"`,
    };
  }
  return { ok: true };
}

/**
 * Plan draft update. Fluid editing is permitted throughout the day.
 */
r.post("/:day/plan", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);

  const body = await readBody(c);
  if (has(body, "intent") && body.intent !== null && typeof body.intent !== "string") {
    return c.json({ error: `intent must be a string, got ${JSON.stringify(body.intent)}` }, 400);
  }

  let big3: Big3Goal[] | null = null;
  if (has(body, "big3")) {
    if (!Array.isArray(body.big3)) {
      return c.json({ error: "big3 must be an array of { text, why? } objects" }, 400);
    }
    if (body.big3.length > BIG3_MAX) {
      return c.json(
        {
          error: `the Big 3 is three: ${body.big3.length} entries were sent, at most ${BIG3_MAX} are accepted. Attention is the scarce resource — cut one, do not stack four.`,
        },
        400,
      );
    }
    for (const [i, entry] of body.big3.entries()) {
      if (!entry || typeof entry !== "object") {
        return c.json({ error: `big3[${i}] must be an object with a text field` }, 400);
      }
      const g = entry as Record<string, unknown>;
      if (typeof g.text !== "string" || g.text.trim() === "") {
        return c.json({ error: `big3[${i}].text must be a non-empty string` }, 400);
      }
      if (g.text.length > TITLE_MAX) {
        return c.json(
          { error: `big3[${i}].text must be at most ${TITLE_MAX} characters, got ${g.text.length}` },
          400,
        );
      }
      if (g.status !== undefined && !GOAL_STATUSES.includes(g.status as GoalStatusLiteral)) {
        return c.json(
          { error: `big3[${i}].status must be one of ${GOAL_STATUSES.join(", ")}` },
          400,
        );
      }
    }
    const existing = (await getPlan(day))?.big3 ?? [];
    big3 = normaliseBig3(
      body.big3 as Array<Partial<Big3Goal> & { text: string }>,
      existing,
    );
  }

  try {
    const plan = await upsertPlanDraft(day, {
      intent: has(body, "intent") ? (body.intent as string | null) : null,
      big3,
      generatedBy: typeof body.generated_by === "string" ? body.generated_by : null,
    });
    return c.json({ ok: true, plan });
  } catch (e) {
    if (e instanceof PlanCommittedError) {
      return c.json({ error: e.message, day: e.day, committed_at: e.committedAt }, 409);
    }
    throw e;
  }
});

/** Mark morning plan committed. Idempotent. */
r.post("/:day/commit", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);
  const before = await getPlan(day);
  const plan = await commitDay(day);
  return c.json({
    ok: true,
    plan,
    already_committed: Boolean(before?.committed_at),
  });
});

/** Complete, re-open or abandon one goal. */
r.post("/:day/goal/:goalId", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);
  const goalId = c.req.param("goalId");
  const body = await readBody(c);
  const status = body.status;
  if (!GOAL_STATUSES.includes(status as GoalStatusLiteral)) {
    return c.json(
      { error: `status must be one of ${GOAL_STATUSES.join(", ")}, got ${JSON.stringify(status)}` },
      400,
    );
  }
  if (has(body, "reason") && body.reason !== null && typeof body.reason !== "string") {
    return c.json({ error: `reason must be a string, got ${JSON.stringify(body.reason)}` }, 400);
  }
  const plan = await setGoalStatus(
    day,
    goalId,
    status as GoalStatusLiteral,
    (body.reason as string | null | undefined) ?? null,
  );
  if (!plan) {
    return c.json({ error: `no goal ${goalId} on day ${day}` }, 404);
  }
  return c.json({ ok: true, plan });
});

/** The night rating. */
r.post("/:day/reflect", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);
  const body = await readBody(c);
  if (has(body, "subjective") && body.subjective !== null) {
    const v = intInRange(body.subjective, "subjective", 1, 10);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  if (has(body, "reflection") && body.reflection !== null && typeof body.reflection !== "string") {
    return c.json(
      { error: `reflection must be a string, got ${JSON.stringify(body.reflection)}` },
      400,
    );
  }
  const plan = await reflect(day, {
    subjective: (body.subjective as number | null | undefined) ?? null,
    reflection: (body.reflection as string | null | undefined) ?? null,
  });
  return c.json({ ok: true, plan });
});

/** Tick or untick a habit. */
r.post("/:day/habit/:habitId", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);
  const habitId = c.req.param("habitId");
  if (!UUID_RE.test(habitId)) {
    return c.json({ error: `invalid habit id "${habitId}" — expected a uuid` }, 400);
  }
  const body = await readBody(c);
  if (typeof body.done !== "boolean") {
    return c.json({ error: `done must be a boolean, got ${JSON.stringify(body.done)}` }, 400);
  }
  const habit = await getHabit(habitId);
  if (!habit) return c.json({ error: `habit ${habitId} not found` }, 404);
  const ticks = await setTick(day, habitId, body.done);
  return c.json({ ok: true, day, habit_id: habitId, done: body.done, ticks });
});

export default r;
