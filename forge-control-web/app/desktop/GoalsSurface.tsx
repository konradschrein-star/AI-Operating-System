"use client";

/**
 * GOALS / TASKS — the week board.
 *
 * ── What this replaces, and why ───────────────────────────────────────────
 * The previous surface was four tabs (DAY PLAN | TASKS | LIFE GOALS | HABITS &
 * STATS) opening on three empty "Outcome 1/2/3" cards above a COMMIT FOCUS
 * TARGETS button. It was measured before being rewritten:
 *
 *   GET /api/daily/stats?days=30  →  score 0 on all 30 days,
 *                                    habit_pct 0 on all 30,
 *                                    goal_pct and task_pct null throughout.
 *   18 habits defined, never ticked once. `committed_at` null every single day.
 *
 * The same habit list in Notion, over the ten days Konrad screenshotted, was
 * also entirely unticked. Two independent systems, one outcome — so the failure
 * is structural, not cosmetic. The old page demanded input before it returned
 * anything, and a page like that gets abandoned.
 *
 * ── The rule this one is built on ─────────────────────────────────────────
 * The board must be FULL before he touches it. Everything on screen is derived:
 * events from Google Calendar, tasks from the board (which Google Tasks and the
 * calendar both feed), habits from the schema, the score computed. The only
 * things he supplies are a tick, a drag, and one number out of ten.
 *
 * There is no commit gate. Nothing is locked behind a ritual he skipped four
 * days running.
 *
 * ── Layout ───────────────────────────────────────────────────────────────
 *   ┌ habit strip: block-of-the-hour, weighted score, felt-rating 1–10 ┐
 *   ├───────────────┬──────────────────────────────────────────────────┤
 *   │ NEXT (one     │  Mon–Sun, 06:00–24:00                            │
 *   │ task)         │  Google Calendar events + scheduled tasks        │
 *   │ quick add     │  drag from the rail onto an hour to schedule     │
 *   │ pressure list │                                                  │
 *   └───────────────┴──────────────────────────────────────────────────┘
 */

import { useMemo, useState, type CSSProperties } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  createCalendarEvent,
  updateCalendarEvent,
  fetchCalendarView,
  fetchDailyDay,
  fetchDayStats,
  fetchDayTasks,
  fetchLifeGoals,
  quickCapture,
  reflectDay,
  setDayHabit,
  updateDayTask,
  type CalendarEvent,
  type DailyDayResponse,
  type DayTask,
} from "../api";
import { WeekGrid } from "./goals/WeekGrid";
import { TaskRail } from "./goals/TaskRail";
import { HabitStrip } from "./goals/HabitStrip";
import { TaskDetail } from "./goals/TaskDetail";
import { LifeGoalsDrawer } from "./goals/LifeGoalsDrawer";
import { localDayKey, weekDays } from "./goals/pressure";
import { chipStyle } from "./goals/ui";
import { StatsPanel } from "./stats/StatsPanel";
import { usePersistentState } from "./_ui/ResizableSplit";

/** Persisted in localStorage `forge.goals.view` — board is the default every
 *  session opens on; STATS is a deliberate switch, never remembered as "on"
 *  from a previous visit unless Konrad left it that way himself. */
type GoalsView = "board" | "stats";
const isGoalsView = (v: unknown): v is GoalsView => v === "board" || v === "stats";

/** "this week moved: <goal> (n) · … · k done tasks unlinked" (PLAN.md §3.3) —
 *  the same honesty-counter shape as `stats/GoalsWeek.tsx`, compressed to one
 *  line for the header strip. */
export function weekStripText(week: { moved: { title: string; tasks_done: number }[]; unlinked_done: number }): string {
  if (week.moved.length === 0) return "nothing linked to a goal moved this week";
  const parts = week.moved.map((m) => `${m.title} (${m.tasks_done})`);
  const unlinkedWord = week.unlinked_done === 1 ? "task" : "tasks";
  return `this week moved: ${parts.join(" · ")} · ${week.unlinked_done} done ${unlinkedWord} unlinked`;
}

export function GoalsSurface() {
  const qc = useQueryClient();
  const todayKey = localDayKey(new Date());
  const [anchor, setAnchor] = useState<string>(todayKey);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [goalsDrawerOpen, setGoalsDrawerOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [view, setView] = usePersistentState<GoalsView>("forge.goals.view", "board", isGoalsView);

  const days = useMemo(() => weekDays(anchor), [anchor]);
  const weekStart = days[0];
  const weekEnd = days[6];

  /* ── data ──────────────────────────────────────────────────────────── */

  // Every open task, not just this week's: the rail IS the backlog, and a
  // `view=week` filter would hide exactly the aged work that most needs doing.
  const tasksQ = useQuery({
    queryKey: ["daily", "tasks", "all"],
    queryFn: () => fetchDayTasks({ view: "all" }),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });

  const eventsQ = useQuery({
    queryKey: ["daily", "calendar", "week", weekStart],
    queryFn: () => fetchCalendarView("week", anchor),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
    retry: 1,
  });

  const dayQ = useQuery({
    queryKey: ["daily", "day", todayKey],
    queryFn: () => fetchDailyDay(todayKey),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });

  // Same key LifeGoalsDrawer and TaskDetail/TaskRail use — one fetch serves
  // the header count, the drawer's list and every goal chip on the board.
  const lifeGoalsQ = useQuery({
    queryKey: ["life-goals"],
    queryFn: () => fetchLifeGoals(),
  });

  // The header's honesty strip is its own query, independent of the STATS
  // panel below (§3.6 — each source fails alone): closing the panel or never
  // opening it must not hide whether this week moved anything. 7 days so
  // `goals_week`'s server-side week window lines up with "this week", not a
  // rolling 30-day sample.
  const weekStatsQ = useQuery({
    queryKey: ["daily-stats", 7],
    queryFn: () => fetchDayStats(7),
    retry: 1,
  });

  const tasks: DayTask[] = tasksQ.data ?? [];
  const events: CalendarEvent[] = eventsQ.data ?? [];

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["daily"] });
  };

  const flash = (msg: string): void => {
    setBanner(msg);
    window.setTimeout(() => setBanner((b) => (b === msg ? null : b)), 4000);
  };

  /* ── writes ────────────────────────────────────────────────────────── */

  const scheduleM = useMutation({
    mutationFn: async ({ taskId, startIso }: { taskId: string; startIso: string }) => {
      const task = tasks.find((t) => t.id === taskId);
      const mins = task?.duration_min || task?.est_min || 30;
      await updateDayTask(taskId, {
        start_time: startIso,
        planned_day: startIso.slice(0, 10),
        duration_min: mins,
      });
      // Push it to Google so the phone agrees. A task the board thinks is at
      // 14:00 that the calendar has never heard of is the exact failure this
      // surface exists to end, so a calendar error is surfaced, not swallowed.
      const end = new Date(new Date(startIso).getTime() + mins * 60_000).toISOString();
      if (task?.gcal_event_id) {
        // Already on the calendar — this drag is a MOVE. Creating a second
        // event would leave the old one sitting at the old hour on his phone.
        await updateCalendarEvent(task.gcal_event_id, {
          start: startIso,
          end,
          task_id: taskId,
        });
      } else if (task) {
        await createCalendarEvent({
          summary: task.title,
          start: startIso,
          end,
          task_id: taskId,
        });
      }
    },
    onSuccess: () => {
      invalidate();
      flash("scheduled · pushed to Google Calendar");
    },
    onError: (e: unknown) =>
      flash(`could not schedule: ${e instanceof Error ? e.message : String(e)}`),
  });

  const toggleM = useMutation({
    mutationFn: ({ taskId, done }: { taskId: string; done: boolean }) =>
      updateDayTask(taskId, { status: done ? "done" : "todo" }),
    onSuccess: invalidate,
  });

  const startM = useMutation({
    mutationFn: (taskId: string) => updateDayTask(taskId, { status: "doing" }),
    onSuccess: invalidate,
  });

  const quickM = useMutation({
    mutationFn: (text: string) => quickCapture("todo", text),
    onSuccess: (r) => {
      invalidate();
      flash(`added: ${r.task?.title ?? ""}`);
    },
    onError: (e: unknown) => flash(`could not add: ${e instanceof Error ? e.message : String(e)}`),
  });

  const habitM = useMutation({
    mutationFn: ({ habitId, done }: { habitId: string; done: boolean }) =>
      setDayHabit(todayKey, habitId, done),
    // Optimistic. A tick that waits on a round trip is a tick that stops
    // happening, and this is the single most important interaction on the page.
    onMutate: async ({ habitId, done }) => {
      await qc.cancelQueries({ queryKey: ["daily", "day", todayKey] });
      const prev = qc.getQueryData<DailyDayResponse>(["daily", "day", todayKey]);
      if (prev) {
        const ticks = prev.ticks.filter((t) => t.habit_id !== habitId);
        if (done) {
          ticks.push({ day: todayKey, habit_id: habitId, done: true, ts: new Date().toISOString() });
        }
        qc.setQueryData(["daily", "day", todayKey], { ...prev, ticks });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["daily", "day", todayKey], ctx.prev);
    },
    onSettled: invalidate,
  });

  const subjectiveM = useMutation({
    mutationFn: (value: number) => reflectDay(todayKey, { subjective: value }),
    onSuccess: invalidate,
  });

  /* ── header ────────────────────────────────────────────────────────── */

  const shift = (n: number): void => {
    const d = new Date(`${anchor}T12:00:00`);
    d.setDate(d.getDate() + n * 7);
    setAnchor(localDayKey(d));
  };

  const fmt = (key: string): string =>
    new Date(`${key}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const rangeLabel = `${fmt(weekStart)} – ${fmt(weekEnd)}`;

  const openTask = openTaskId ? (tasks.find((t) => t.id === openTaskId) ?? null) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: 14,
        gap: 10,
        background: tokens.bgBody,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: tokens.textHi }}>Week</span>
        <span className="mono" style={{ fontSize: 12, color: tokens.textSoft }}>
          {rangeLabel}
        </span>
        <button onClick={() => shift(-1)} style={navBtn()} title="previous week">
          ‹
        </button>
        <button onClick={() => setAnchor(todayKey)} style={navBtn()} title="this week">
          today
        </button>
        <button onClick={() => shift(1)} style={navBtn()} title="next week">
          ›
        </button>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {banner && (
            <span className="mono" style={{ fontSize: 10, color: tokens.accent }}>
              {banner}
            </span>
          )}
          <button
            onClick={() => setGoalsDrawerOpen(true)}
            style={navBtn()}
            title="Open the Life Goals drawer"
          >
            LIFE GOALS · {lifeGoalsQ.data ? lifeGoalsQ.data.length : "···"}
          </button>
          <button
            type="button"
            aria-pressed={view === "stats"}
            onClick={() => setView(view === "stats" ? "board" : "stats")}
            style={chipStyle(view === "stats")}
            title="Swap the board for the shared stats panel"
          >
            STATS
          </button>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: eventsQ.isError ? tokens.textGhost : tokens.ok,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
            title={
              eventsQ.isError
                ? "Google Calendar unreachable"
                : "Google Calendar and Google Tasks both sync every 5 minutes"
            }
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: eventsQ.isError ? tokens.textGhost : tokens.ok,
              }}
            />
            {eventsQ.isError ? "GCal offline" : `Google synced · ${events.length} events`}
          </span>
        </div>
      </div>

      {/* This week against the life goals — the honesty line, always visible,
          independent of whether the STATS panel is open (§3.6). */}
      <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted, flexShrink: 0 }}>
        {weekStatsQ.isPending && "reading this week…"}
        {weekStatsQ.isError &&
          `week movement unavailable — ${weekStatsQ.error instanceof Error ? weekStatsQ.error.message : String(weekStatsQ.error)}`}
        {weekStatsQ.data &&
          (weekStatsQ.data.goals_week
            ? weekStripText(weekStatsQ.data.goals_week)
            : "week movement unavailable — server has not shipped goals_week yet")}
      </div>

      {/* Habits + the day's two numbers */}
      <div style={{ flexShrink: 0 }}>
        <HabitStrip
          habits={dayQ.data?.habits ?? []}
          ticks={dayQ.data?.ticks ?? []}
          subjective={dayQ.data?.plan?.subjective ?? null}
          onTick={(habitId, done) => habitM.mutate({ habitId, done })}
          onSubjective={(v) => subjectiveM.mutate(v)}
        />
      </div>

      {/* Rail + grid, or STATS — the toggle swaps the whole area, never both
          at once; the habit strip and header above stay put either way. */}
      {view === "stats" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <StatsPanel mount="goals" />
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(230px, 290px) 1fr",
            gap: 10,
          }}
        >
          <TaskRail
            tasks={tasks}
            today={todayKey}
            onQuickAdd={(text) => quickM.mutate(text)}
            onToggle={(taskId, done) => toggleM.mutate({ taskId, done })}
            onOpen={setOpenTaskId}
            onStart={(taskId) => startM.mutate(taskId)}
            busy={toggleM.isPending || startM.isPending}
          />

          <WeekGrid
            day={anchor}
            tasks={tasks}
            events={events}
            onSchedule={(taskId, startIso) => scheduleM.mutate({ taskId, startIso })}
            onToggleTask={(taskId, done) => toggleM.mutate({ taskId, done })}
            onOpenTask={setOpenTaskId}
            onEmptySlot={(startIso) => {
              const when = new Date(startIso).toLocaleString("en-GB", {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              });
              const title = window.prompt(`New event at ${when}`);
              if (!title?.trim()) return;
              void createCalendarEvent({
                summary: title.trim(),
                start: startIso,
                end: new Date(new Date(startIso).getTime() + 60 * 60_000).toISOString(),
              })
                .then(() => {
                  invalidate();
                  flash("added to Google Calendar");
                })
                .catch((e: unknown) =>
                  flash(`could not add: ${e instanceof Error ? e.message : String(e)}`),
                );
            }}
          />
        </div>
      )}

      {openTask && (
        <TaskDetail
          task={openTask}
          onClose={() => setOpenTaskId(null)}
          onSaved={() => {
            invalidate();
            setOpenTaskId(null);
          }}
        />
      )}

      {goalsDrawerOpen && <LifeGoalsDrawer onClose={() => setGoalsDrawerOpen(false)} />}
    </div>
  );
}

function navBtn(): CSSProperties {
  return {
    padding: "3px 9px",
    borderRadius: 6,
    border: `1px solid ${tokens.border}`,
    background: "transparent",
    color: tokens.textSoft,
    fontSize: 11,
    cursor: "pointer",
    lineHeight: 1.6,
  };
}
