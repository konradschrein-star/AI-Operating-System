"use client";

/**
 * GOALS / TASKS / DAY PLANNER — Daily executive command center, habit tracking,
 * task management, Google Calendar schedule, and strategic life goals.
 *
 * Provides:
 * - 4 core views: DAY PLAN | TASKS | LIFE GOALS | HABITS & STATS.
 * - Live Google Calendar status indicator.
 * - Fluid inline editing for daily intent and Big 3 focus outcomes.
 * - Responsive 390px mobile to 1680px desktop design.
 */

import { useMemo, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  commitDay,
  createDayTask,
  deleteDayTask,
  fetchCalendarEvents,
  fetchDailyDay,
  fetchDayStats,
  fetchDayTasks,
  reflectDay,
  rolloverDayTasks,
  saveDayPlan,
  setDayGoalStatus,
  setDayHabit,
  updateDayTask,
  type DailyDayResponse,
  type DayGoal,
  type DayGoalStatus,
  type DayHabit,
  type DayTask,
  type DayTaskInput,
  type DayTaskStatus,
  type DayTaskView,
} from "../api";
import { useNarrowViewport, usePersistentState } from "./_ui/ResizableSplit";
import { ErrorPanel, errorDetail } from "./_ui/SurfaceErrorBoundary";
import { toastError } from "./_ui/Toasts";
import { TodayTab, type TodayActions } from "./goals/TodayTab";
import { TasksTab, type TaskActions } from "./goals/TasksTab";
import { GoalsTab } from "./goals/GoalsTab";
import { StatsTab } from "./goals/StatsTab";
import { addDays, toDayKey } from "./goals/quick-add";
import { TAP, formatDay, ghostButton } from "./goals/ui";

type Tab = "today" | "tasks" | "goals" | "stats";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "today", label: "DAY PLAN", icon: "calendar_today" },
  { key: "tasks", label: "TASKS", icon: "task_alt" },
  { key: "goals", label: "LIFE GOALS", icon: "flag" },
  { key: "stats", label: "HABITS & STATS", icon: "insights" },
];
const isTab = (v: unknown): v is Tab =>
  v === "today" || v === "tasks" || v === "goals" || v === "stats";

export function GoalsSurface() {
  const qc = useQueryClient();
  const narrow = useNarrowViewport();
  const [tab, setTab] = usePersistentState<Tab>("forge.goals.tab", "today", isTab);
  const [day, setDay] = useState<string>(() => toDayKey(new Date()));
  const [view, setView] = useState<DayTaskView>("today");
  const [area, setArea] = useState<string | null>(null);
  const [status, setStatus] = useState<DayTaskStatus | null>(null);
  const [windowDays, setWindowDays] = useState(90);

  const dayKey = useMemo(() => ["daily", "day", day] as const, [day]);
  const tasksKey = useMemo(
    () => ["daily", "tasks", view, area, status] as const,
    [view, area, status],
  );

  const dayQ = useQuery({
    queryKey: dayKey,
    queryFn: () => fetchDailyDay(day),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const statsQ = useQuery({
    queryKey: ["daily-stats", windowDays],
    queryFn: () => fetchDayStats(windowDays),
    enabled: tab === "stats",
    placeholderData: keepPreviousData,
  });

  const tasksQ = useQuery({
    queryKey: tasksKey,
    queryFn: () =>
      fetchDayTasks({
        view,
        ...(area ? { area } : {}),
        ...(status ? { status } : {}),
      }),
    enabled: tab === "tasks",
    placeholderData: keepPreviousData,
  });

  const calendarQ = useQuery({
    queryKey: ["daily-calendar-status"],
    queryFn: () => fetchCalendarEvents(),
    staleTime: 60_000,
    retry: 1,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["daily"] });
    void qc.invalidateQueries({ queryKey: ["daily-stats"] });
    void qc.invalidateQueries({ queryKey: ["life-goals"] });
  };

  /* ── optimistic plumbing ────────────────────────────────────────────────
     One snapshot type for every write that touches a task, because a task can
     be on screen twice — TODAY's list and the TASKS list — and both copies
     must flip together or the surface contradicts itself. */
  interface TaskSnapshot {
    prevDay: DailyDayResponse | undefined;
    prevTasks: DayTask[] | undefined;
  }

  const patchTask = (id: string, patch: Partial<DayTask>): TaskSnapshot => {
    const prevDay = qc.getQueryData<DailyDayResponse>(dayKey);
    const prevTasks = qc.getQueryData<DayTask[]>(tasksKey);
    if (prevDay) {
      qc.setQueryData<DailyDayResponse>(dayKey, {
        ...prevDay,
        tasks: prevDay.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      });
    }
    if (prevTasks) {
      qc.setQueryData<DayTask[]>(
        tasksKey,
        prevTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    }
    return { prevDay, prevTasks };
  };

  const dropTask = (id: string): TaskSnapshot => {
    const prevDay = qc.getQueryData<DailyDayResponse>(dayKey);
    const prevTasks = qc.getQueryData<DayTask[]>(tasksKey);
    if (prevDay) {
      qc.setQueryData<DailyDayResponse>(dayKey, {
        ...prevDay,
        tasks: prevDay.tasks.filter((t) => t.id !== id),
      });
    }
    if (prevTasks) {
      qc.setQueryData<DayTask[]>(
        tasksKey,
        prevTasks.filter((t) => t.id !== id),
      );
    }
    return { prevDay, prevTasks };
  };

  const restore = (snap: TaskSnapshot | undefined) => {
    if (!snap) return;
    if (snap.prevDay) qc.setQueryData(dayKey, snap.prevDay);
    if (snap.prevTasks) qc.setQueryData(tasksKey, snap.prevTasks);
  };

  const patchPlan = (
    mutate: (plan: NonNullable<DailyDayResponse["plan"]>) => DailyDayResponse["plan"],
  ): DailyDayResponse | undefined => {
    const prev = qc.getQueryData<DailyDayResponse>(dayKey);
    if (prev?.plan) {
      qc.setQueryData<DailyDayResponse>(dayKey, { ...prev, plan: mutate(prev.plan) });
    }
    return prev;
  };

  /* ── mutations ─────────────────────────────────────────────────────────── */

  const habitM = useMutation({
    mutationFn: (v: { habit: DayHabit; next: boolean }) =>
      setDayHabit(day, v.habit.id, v.next),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: dayKey });
      const prev = qc.getQueryData<DailyDayResponse>(dayKey);
      if (prev) {
        const without = prev.ticks.filter((t) => t.habit_id !== v.habit.id);
        qc.setQueryData<DailyDayResponse>(dayKey, {
          ...prev,
          ticks: v.next
            ? [
                ...without,
                { day, habit_id: v.habit.id, done: true, ts: new Date().toISOString() },
              ]
            : without,
        });
      }
      return { prev };
    },
    onError: (e, v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dayKey, ctx.prev);
      toastError(`"${v.habit.label}" didn't save — the tick was rolled back.`, e);
    },
    onSettled: invalidate,
  });

  const goalM = useMutation({
    mutationFn: (v: { goalId: string; status: DayGoalStatus; reason?: string }) =>
      setDayGoalStatus(day, v.goalId, {
        status: v.status,
        ...(v.reason ? { reason: v.reason } : {}),
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: dayKey });
      const prev = patchPlan((plan) => ({
        ...plan,
        big3: plan.big3.map((g) =>
          g.id === v.goalId
            ? {
                ...g,
                status: v.status,
                reason: v.status === "abandoned" ? (v.reason ?? g.reason) : null,
                done_at: v.status === "done" ? new Date().toISOString() : null,
              }
            : g,
        ),
      }));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dayKey, ctx.prev);
      toastError("That goal didn't save — it's back as it was.", e);
    },
    onSettled: invalidate,
  });

  const planM = useMutation({
    mutationFn: (v: { intent: string | null; big3: DayGoal[] }) => saveDayPlan(day, v),
    onError: (e) =>
      toastError("The plan draft didn't save.", e),
    onSettled: invalidate,
  });

  const commitM = useMutation({
    mutationFn: async (v: { intent: string | null; big3: DayGoal[] }) => {
      await saveDayPlan(day, v);
      return commitDay(day);
    },
    onError: (e) => toastError("Commit failed — day is still in draft.", e),
    onSettled: invalidate,
  });

  const reflectM = useMutation({
    mutationFn: (v: { subjective?: number; reflection?: string }) => reflectDay(day, v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: dayKey });
      const prev = patchPlan((plan) => ({
        ...plan,
        subjective: v.subjective ?? plan.subjective,
        reflection: v.reflection ?? plan.reflection,
      }));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dayKey, ctx.prev);
      toastError("That rating didn't save.", e);
    },
    onSettled: invalidate,
  });

  const taskPatchM = useMutation({
    mutationFn: (v: {
      id: string;
      patch: Partial<DayTaskInput> & { status?: DayTaskStatus; carried?: number };
    }) => updateDayTask(v.id, v.patch),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["daily"] });
      return patchTask(v.id, v.patch as Partial<DayTask>);
    },
    onError: (e, _v, ctx) => {
      restore(ctx);
      toastError("That task didn't save — the row was put back.", e);
    },
    onSettled: invalidate,
  });

  const taskDeleteM = useMutation({
    mutationFn: (v: { id: string }) => deleteDayTask(v.id),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["daily"] });
      return dropTask(v.id);
    },
    onError: (e, _v, ctx) => {
      restore(ctx);
      toastError("Couldn't delete that task — it's still there.", e);
    },
    onSettled: invalidate,
  });

  const taskAddM = useMutation({
    mutationFn: (input: DayTaskInput) => createDayTask(input),
    onError: (e) => toastError("That task didn't get added.", e),
    onSettled: invalidate,
  });

  const rolloverM = useMutation({
    mutationFn: () => rolloverDayTasks(day),
    onError: (e) => toastError("Rollover failed — nothing was moved.", e),
    onSettled: invalidate,
  });

  const taskActions: TaskActions = {
    onToggleDone: (task, done) =>
      taskPatchM.mutate({ id: task.id, patch: { status: done ? "done" : "todo" } }),
    onSetStatus: (task, next) =>
      taskPatchM.mutate({ id: task.id, patch: { status: next } }),
    onDelete: (task) => taskDeleteM.mutate({ id: task.id }),
    onAdd: (input) => taskAddM.mutate(input),
    onUpdate: (id, patch) => taskPatchM.mutate({ id, patch }),
  };

  const todayActions: TodayActions = {
    onSavePlan: (v) => planM.mutate(v),
    onCommit: (v) => commitM.mutate(v),
    onGoalStatus: (goalId, next, reason) =>
      goalM.mutate({ goalId, status: next, ...(reason ? { reason } : {}) }),
    onHabit: (habit, next) => habitM.mutate({ habit, next }),
    onReflect: (v) => reflectM.mutate(v),
    onPinTask: (task) =>
      taskPatchM.mutate({ id: task.id, patch: { planned_day: day, carried: 0 } }),
    tasks: taskActions,
  };

  const today = toDayKey(new Date());

  return (
    <div
      className="slidein"
      style={{
        padding: narrow ? "12px 12px 72px" : "16px 22px 48px",
        maxWidth: 1240,
        margin: "0 auto",
      }}
    >
      {/* Top Header: Title & Google Calendar Status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi }}>
            Goals & Day Command
          </span>
          <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            intent · execution · habits · momentum
          </span>
        </div>

        {/* Google Calendar Sync Status Badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 8px",
            borderRadius: 6,
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderDivider}`,
          }}
          title={calendarQ.isError ? "Calendar offline (check OAuth / google_api.py)" : "Google Calendar: konrad.schrein@gmail.com connected"}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: calendarQ.isError ? tokens.warn : tokens.ok,
              boxShadow: calendarQ.isError ? `0 0 5px ${tokens.warn}` : `0 0 5px ${tokens.ok}`,
              display: "inline-block",
            }}
          />
          <span className="mono" style={{ fontSize: 10, color: calendarQ.isError ? tokens.warn : tokens.textSoft }}>
            {calendarQ.isError ? "GCal Offline" : "Google Calendar Synced"}
          </span>
        </div>
      </div>

      {/* Modern View Switcher Tabs */}
      <div style={{ display: "flex", gap: 6, margin: "0 0 12px", overflowX: "auto" }}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              data-goals-tab={t.key}
              aria-current={on ? "page" : undefined}
              onClick={() => setTab(t.key)}
              className="mono"
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 9,
                border: `1px solid ${on ? tokens.accent : tokens.border}`,
                background: on ? tokens.selectedBg : tokens.toolBg,
                color: on ? tokens.accent : tokens.textMuted,
                fontSize: 11,
                fontWeight: on ? 600 : 400,
                letterSpacing: "0.08em",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "0 8px",
                whiteSpace: "nowrap",
                transition: "border-color 0.12s, background 0.12s, color 0.12s",
              }}
            >
              <span className="ms" style={{ fontSize: 16 }}>
                {t.icon}
              </span>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Day Step navigation when on Day Plan */}
      {tab === "today" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 12px" }}>
          <DayStep
            icon="chevron_left"
            label="Previous day"
            onClick={() => setDay(addDays(day, -1))}
          />
          <span
            className="mono"
            style={{ flex: 1, textAlign: "center", fontSize: 12, fontWeight: 500, color: tokens.textMuted }}
          >
            {formatDay(day)}
            {dayQ.isFetching && <span style={{ color: tokens.textGhost }}> · syncing</span>}
          </span>
          <DayStep
            icon="chevron_right"
            label="Next day"
            onClick={() => setDay(addDays(day, 1))}
          />
          {day !== today && (
            <button type="button" style={ghostButton()} onClick={() => setDay(today)}>
              today
            </button>
          )}
        </div>
      )}

      {/* Surface Content */}
      <div>
        {tab === "today" &&
          (dayQ.isError ? (
            <ErrorPanel
              title="The day didn't load — this is NOT an empty day."
              detail={errorDetail(dayQ.error)}
              onRetry={() => void dayQ.refetch()}
            />
          ) : (
            <TodayTab
              day={day}
              data={dayQ.data}
              loading={dayQ.isLoading}
              actions={todayActions}
              narrow={narrow}
            />
          ))}

        {tab === "tasks" &&
          (tasksQ.isError ? (
            <ErrorPanel
              title="Tasks didn't load — this is NOT an empty list."
              detail={errorDetail(tasksQ.error)}
              onRetry={() => void tasksQ.refetch()}
            />
          ) : (
            <TasksTab
              tasks={tasksQ.data ?? []}
              view={view}
              onView={setView}
              area={area}
              onArea={setArea}
              status={status}
              onStatus={setStatus}
              actions={taskActions}
              loading={tasksQ.isLoading || tasksQ.isFetching}
              narrow={narrow}
              onRollover={() => rolloverM.mutate()}
              rollingOver={rolloverM.isPending}
              day={day}
            />
          ))}

        {tab === "goals" && (
          <GoalsTab narrow={narrow} />
        )}

        {tab === "stats" &&
          (statsQ.isError ? (
            <ErrorPanel
              title="Stats didn't load."
              detail={errorDetail(statsQ.error)}
              onRetry={() => void statsQ.refetch()}
            />
          ) : (
            <StatsTab
              stats={statsQ.data}
              loading={statsQ.isLoading}
              windowDays={windowDays}
              narrow={narrow}
              onWindow={setWindowDays}
              onOpenDay={(d) => {
                setDay(d);
                setTab("today");
              }}
            />
          ))}
      </div>
    </div>
  );
}

function DayStep({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: TAP,
        height: TAP,
        flex: "none",
        borderRadius: 8,
        border: `1px solid ${tokens.border}`,
        background: tokens.toolBg,
        color: tokens.textMuted,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span className="ms" style={{ fontSize: 18 }}>
        {icon}
      </span>
    </button>
  );
}
