/**
 * The ordering model for the week board — pure, so it can be reasoned about
 * without a browser.
 *
 * ── Why this file is the centre of the redesign ───────────────────────────
 * The old surface opened on three empty "Outcome 1/2/3" cards and a commit
 * button. Thirty days of measured data: score 0 every day, the commit button
 * never pressed, 18 habits never logged once. A page that demands input before
 * it returns anything gets abandoned, and it was — twice, counting Notion.
 *
 * So the board never asks "what are your goals today". It answers "what do I do
 * next", from data that already exists. Konrad's own words for what he wanted
 * out of a task system: "manage my tasks that well that I never know what NOT to
 * do next" — one answer, not a list to scroll past.
 */

import type { DayTask, CalendarEvent, DayHabitWithStreak } from "../../api";

/* ────────────────────────────────────────────────────────────── pressure ── */

/** Days between two YYYY-MM-DD keys. Negative when `to` is before `from`. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export interface PressureParts {
  importance: number;
  /** Rises as a due date approaches, and keeps rising once it is missed. */
  urgency: number;
  /** Rises with age and with every rollover. */
  rot: number;
  total: number;
}

/**
 * How loudly is this task asking to be done?
 *
 * Three inputs, deliberately — importance alone collapses (everything becomes
 * "really important" within a month, which is exactly what happened in his
 * Notion), and a pure due-date sort buries anything without a deadline forever.
 *
 * `rot` is the term his Notion had and the current OS lost: he tracked *Age*
 * as a first-class column and it was the one he actually read. A task carried
 * three times is a decision he keeps refusing to make, and the board should say
 * so rather than let it sit at the bottom of a list.
 */
export function pressure(task: DayTask, today: string): PressureParts {
  const importance = task.importance * 10;

  let urgency = 0;
  if (task.due_day) {
    const left = daysBetween(today, task.due_day);
    if (left <= 0) urgency = 40 + Math.min(40, -left * 5); // overdue, and growing
    else if (left <= 7) urgency = 30 - left * 3;
    else urgency = Math.max(0, 8 - left / 7);
  }

  // Age is capped: past a fortnight the signal is "this is not really a task",
  // and letting it grow without bound would pin dead weight to the top forever.
  const rot = Math.min(20, task.age_days * 0.6) + task.carried * 4;

  return { importance, urgency, rot, total: importance + urgency + rot };
}

/** Open work only — done and parked are not candidates for anything. */
export function isOpen(t: DayTask): boolean {
  return t.status !== "done" && t.status !== "parked";
}

/** Has a clock time, so it belongs in the grid rather than the rail. */
export function isScheduled(t: DayTask): boolean {
  return Boolean(t.start_time);
}

export function byPressure(today: string) {
  return (a: DayTask, b: DayTask): number =>
    pressure(b, today).total - pressure(a, today).total;
}

/**
 * The single task the board puts at the top.
 *
 * Prefers something already in progress — if he started it, finishing it beats
 * starting something else. Otherwise the highest pressure among unscheduled
 * work; anything already on the calendar has an answer to "when" and does not
 * need to be nominated.
 */
export function nextTask(tasks: DayTask[], today: string): DayTask | null {
  const open = tasks.filter(isOpen);
  const doing = open.filter((t) => t.status === "doing").sort(byPressure(today));
  if (doing.length > 0) return doing[0];
  const loose = open.filter((t) => !isScheduled(t)).sort(byPressure(today));
  return loose[0] ?? null;
}

/* ─────────────────────────────────────────────────────────────── habits ── */

export type HabitBlock = "morning" | "body" | "work" | "evening";

export const BLOCK_ORDER: HabitBlock[] = ["morning", "body", "work", "evening"];

export const BLOCK_LABEL: Record<HabitBlock, string> = {
  morning: "Morning",
  body: "Body",
  work: "Work",
  evening: "Evening",
};

/**
 * Which habit block is live at this hour.
 *
 * Eighteen checkboxes at once is why the tracker read zero for thirty days —
 * and zero in Notion before that, on the same list. Showing the block that is
 * plausible *now* turns one wall of eighteen into three passes of five or six,
 * and means he never opens it to a screen that is mostly failure.
 */
export function currentBlock(hour: number): HabitBlock {
  if (hour < 11) return "morning";
  if (hour < 14) return "body";
  if (hour < 19) return "work";
  return "evening";
}

/** `grp` is free text in the DB; anything unrecognised lands in `work`. */
export function blockOf(habit: DayHabitWithStreak): HabitBlock {
  const g = (habit.grp || "").toLowerCase();
  return (BLOCK_ORDER as string[]).includes(g) ? (g as HabitBlock) : "work";
}

/**
 * Weighted completion, 0..100.
 *
 * Weighted rather than raw, because a raw 12/18 reads as 67% — a failing grade
 * for a good day — and a number that always says you failed is a number you
 * stop looking at. `weight` already exists on every habit row and was unused.
 */
export function habitScore(
  habits: DayHabitWithStreak[],
  done: Set<string>,
): number {
  const active = habits.filter((h) => h.active !== false);
  if (active.length === 0) return 0;
  const total = active.reduce((s, h) => s + (h.weight || 1), 0);
  const hit = active.reduce((s, h) => s + (done.has(h.id) ? h.weight || 1 : 0), 0);
  return total === 0 ? 0 : Math.round((hit / total) * 100);
}

/* ───────────────────────────────────────────────────────────────── grid ── */

/** First and last hour the grid renders. Nobody schedules 03:00, and rendering
 *  it is how half the old timeline ended up as empty night. */
export const GRID_START_HOUR = 6;
export const GRID_END_HOUR = 24;

export interface GridItem {
  key: string;
  title: string;
  /** Minutes from midnight. */
  startMin: number;
  durationMin: number;
  kind: "event" | "task";
  area: string | null;
  done: boolean;
  taskId?: string;
  eventId?: string;
  location?: string;
}

/** Local YYYY-MM-DD for a Date, in the browser's own zone (which is Konrad's). */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function minutesInto(iso: string): number {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 0 : d.getHours() * 60 + d.getMinutes();
}

/** The seven day keys of the Mon–Sun week containing `day`. */
export function weekDays(day: string): string[] {
  const base = new Date(`${day}T12:00:00`);
  const dow = (base.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(base.getTime() - dow * 86_400_000);
  return Array.from({ length: 7 }, (_, i) =>
    localDayKey(new Date(monday.getTime() + i * 86_400_000)),
  );
}

/**
 * Everything that occupies a slot on one day, from both sources.
 *
 * A scheduled task that already has a calendar event is dropped in favour of
 * the event: they are the same commitment and drawing both would double-book
 * the hour visually.
 */
export function itemsForDay(
  day: string,
  tasks: DayTask[],
  events: CalendarEvent[],
): GridItem[] {
  const out: GridItem[] = [];
  const linked = new Set(
    tasks.map((t) => t.gcal_event_id).filter((x): x is string => Boolean(x)),
  );

  for (const e of events) {
    if (e.all_day) continue;
    const d = new Date(e.start);
    if (Number.isNaN(d.getTime()) || localDayKey(d) !== day) continue;
    const end = new Date(e.end);
    const dur = Number.isNaN(end.getTime())
      ? 60
      : Math.max(15, Math.round((end.getTime() - d.getTime()) / 60_000));
    out.push({
      key: `e:${e.id}`,
      title: e.summary,
      startMin: minutesInto(e.start),
      durationMin: dur,
      kind: "event",
      area: null,
      done: false,
      eventId: e.id,
      location: e.location || undefined,
    });
  }

  for (const t of tasks) {
    if (!t.start_time) continue;
    if (t.gcal_event_id && linked.has(t.gcal_event_id)) {
      // Only skip it if the event is actually in this window; otherwise the
      // task would vanish entirely rather than be drawn once.
      if (events.some((e) => e.id === t.gcal_event_id)) continue;
    }
    const d = new Date(t.start_time);
    if (Number.isNaN(d.getTime()) || localDayKey(d) !== day) continue;
    out.push({
      key: `t:${t.id}`,
      title: t.title,
      startMin: minutesInto(t.start_time),
      durationMin: t.duration_min || t.est_min || 30,
      kind: "task",
      area: t.area,
      done: t.status === "done",
      taskId: t.id,
    });
  }

  return out.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Side-by-side lanes for items that overlap in time.
 *
 * Without this two 14:00 meetings draw exactly on top of each other and the
 * board silently hides one — the worst possible failure for a calendar.
 */
export function layoutLanes(items: GridItem[]): Map<string, { lane: number; lanes: number }> {
  const result = new Map<string, { lane: number; lanes: number }>();
  let cluster: GridItem[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assigned: { item: GridItem; lane: number }[] = [];
    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = it.startMin + it.durationMin;
      assigned.push({ item: it, lane });
    }
    for (const a of assigned) {
      result.set(a.item.key, { lane: a.lane, lanes: laneEnds.length });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const it of items) {
    if (cluster.length > 0 && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.startMin + it.durationMin);
  }
  flush();
  return result;
}
