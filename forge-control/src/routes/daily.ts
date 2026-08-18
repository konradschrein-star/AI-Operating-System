/**
 * GOALS/TASKS routes — the contract in docs/spec-daily-goals.md §4, verbatim.
 *
 *   GET    /api/daily?day=YYYY-MM-DD      → { day, plan, habits[], ticks[], tasks[], score }
 *   POST   /api/daily/:day/plan           { intent?, big3? }  409 once committed
 *   POST   /api/daily/:day/commit         freezes big3; idempotent
 *   POST   /api/daily/:day/goal/:goalId   { status, reason? }
 *   POST   /api/daily/:day/reflect        { subjective?:1..5, reflection? }
 *   POST   /api/daily/:day/habit/:habitId { done: boolean }
 *
 *   GET    /api/daily/tasks?view=today|week|backlog|all&area=&status=
 *   POST   /api/daily/tasks
 *   PATCH  /api/daily/tasks/:id
 *   DELETE /api/daily/tasks/:id
 *   POST   /api/daily/rollover            { to? }  idempotent
 *
 *   GET    /api/daily/stats?days=90
 *   GET    /api/daily/habits
 *   POST   /api/daily/habits
 *   PATCH  /api/daily/habits/:id
 *
 * Thin handlers, as in routes/autonomy.ts: parse, validate, delegate to
 * db/daily.ts, shape the response. No SQL and no arithmetic here.
 *
 * ROUTE ORDER IS LOAD-BEARING. The static two-segment paths (/tasks/:id,
 * /habits/:id) are registered BEFORE the /:day/* family so that a request for
 * /tasks/<uuid> can never be matched as day="tasks".
 *
 * Every rejection says what was wrong and what would be right. `{"error":"bad
 * request"}` is banned by the spec, and rightly: a 400 he cannot act on is a
 * 500 with better manners.
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
  rolloverTasks,
  dayBundle,
  dailyStats,
  PlanCommittedError,
  STALE_AT,
  STATS_DEFAULT_DAYS,
  STATS_MAX_DAYS,
  TASK_STATUSES,
  TASK_VIEWS,
  type Big3Goal,
  type TaskStatus,
  type TaskView,
} from "../db/daily.ts";
import { berlinDay, isDay, type Day } from "../lib/day-score.ts";

const r = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max Big 3 entries. Three, because attention is the scarce resource (§1). */
const BIG3_MAX = 3;
const TITLE_MAX = 300;
const GOAL_STATUSES = ["open", "done", "abandoned"] as const;
type GoalStatusLiteral = (typeof GOAL_STATUSES)[number];

type Body = Record<string, unknown>;

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Body> {
  const parsed = await c.req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" ? (parsed as Body) : {};
}

/** Present and not null — distinguishes "leave it" from "set it to null". */
function has(body: Body, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

/**
 * An integer in [min, max], or a message naming the field, the bound and what
 * arrived. Returned rather than thrown so the handler stays flat.
 */
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

/**
 * Add the derived flag the stale strip keys on. `age_days` already arrives from
 * SQL (see TASK_COLS); `stale` is a threshold comparison and belongs next to
 * the constant that defines it, which the response also carries as `stale_at`
 * so the client never has to hardcode a 3.
 */
function decorate<T extends { carried: number }>(task: T): T & { stale: boolean } {
  return { ...task, stale: task.carried >= STALE_AT };
}

// ===========================================================================
// Static paths first — see the header note on route order.
// ===========================================================================

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

/** Shared field validation for POST and PATCH. Returns a message or null. */
function validateTaskFields(body: Body): string | null {
  if (has(body, "title")) {
    const t = body.title;
    if (typeof t !== "string" || t.trim() === "") return "title must be a non-empty string";
    if (t.length > TITLE_MAX) {
      return `title must be at most ${TITLE_MAX} characters, got ${t.length}`;
    }
  }
  if (has(body, "importance") && body.importance !== null) {
    const v = intInRange(body.importance, "importance", 0, 3);
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
  if (has(body, "carried") && body.carried !== null) {
    const v = intInRange(body.carried, "carried", 0, 999);
    if (!v.ok) return v.error;
  }
  for (const field of ["planned_day", "due_day"]) {
    if (has(body, field) && body[field] !== null && !isDay(body[field])) {
      return `${field} must be a real calendar day as YYYY-MM-DD or null, got ${JSON.stringify(body[field])}`;
    }
  }
  for (const field of ["area", "notes"]) {
    if (has(body, field) && body[field] !== null && typeof body[field] !== "string") {
      return `${field} must be a string or null, got ${JSON.stringify(body[field])}`;
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
  if (has(body, "importance")) patch.importance = body.importance as number;
  if (has(body, "status")) patch.status = body.status as TaskStatus;
  if (has(body, "planned_day")) patch.planned_day = body.planned_day as Day | null;
  if (has(body, "due_day")) patch.due_day = body.due_day as Day | null;
  if (has(body, "est_min")) patch.est_min = body.est_min as number | null;
  if (has(body, "notes")) patch.notes = body.notes as string | null;
  if (has(body, "carried")) patch.carried = body.carried as number;

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

/**
 * The anti-graveyard sweep (§5). Safe to call repeatedly — the executor's
 * evening job calls it unconditionally at 20:30 and the morning UI may call it
 * again; the second call moves nothing and increments nothing.
 */
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
  // Inactive definitions are included by default: STATS renders history, and a
  // retired habit still owns the ticks it earned.
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

/** Guard shared by every /:day/* handler. */
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
 * Draft edit. 409 once committed — the freeze is the product (§1). The error
 * carries the commit timestamp so the UI can print the exact tooltip the spec
 * asks for ("committed at 08:12 — abandon instead of editing").
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

/** Freeze the day. Idempotent — a second COMMIT keeps the first timestamp. */
r.post("/:day/commit", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);
  const before = await getPlan(day);
  const plan = await commitDay(day);
  return c.json({
    ok: true,
    plan,
    // So the client can tell "I just froze it" from "it was already frozen"
    // without diffing timestamps.
    already_committed: Boolean(before?.committed_at),
  });
});

/**
 * Complete, re-open or abandon one goal. This is the ONLY legal change to a
 * committed day — the text stays where it was, which is what makes the number
 * mean anything.
 */
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

/** The night rating. Legal after commit — it describes the day, not the plan. */
r.post("/:day/reflect", async (c) => {
  const day = c.req.param("day");
  const guard = requireDay(day);
  if (!guard.ok) return c.json({ error: guard.error }, 400);
  const body = await readBody(c);
  if (has(body, "subjective") && body.subjective !== null) {
    const v = intInRange(body.subjective, "subjective", 1, 5);
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

/** Tick or untick a habit. `done: false` removes the row — see db/daily.ts. */
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
  // Checked before the write so an unknown id is a 404 and not a foreign-key
  // 500 — the chip is optimistic in the UI, so its error path has to be exact.
  const habit = await getHabit(habitId);
  if (!habit) return c.json({ error: `habit ${habitId} not found` }, 404);
  const ticks = await setTick(day, habitId, body.done);
  return c.json({ ok: true, day, habit_id: habitId, done: body.done, ticks });
});

export default r;
