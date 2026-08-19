"use client";

/**
 * GOALS/TASKS — daily goals, the task planner, habits, and the stats that make
 * them mean something. Replaces the `goals` placeholder.
 *
 * Spec: docs/spec-daily-goals.md; the API is §4 of it, served by
 * forge-control/src/routes/daily.ts. The surface exists because a Notion setup
 * died of four things, each of which has an answer here:
 *
 *   blank page every evening   the operator drafts the plan; he only commits
 *   a task graveyard           rollover plus the stale strip force a decision
 *   a 19-column checkbox wall  four short rows of chips, 390px first
 *   passive stats              SAID VS DONE, first and biggest
 *
 * This file is the shell: three tabs, the day cursor, every query and every
 * mutation. The tabs themselves live in ./goals/*.
 *
 * Two rules about the data flow, both load-bearing:
 *
 *   • Ticks are OPTIMISTIC. The habit chip and the Big-3 circle flip on touch
 *     and reconcile against the refetch; on failure they roll back and say so.
 *     A tick that waits on a round trip is a tick that stops happening.
 *   • Loading never flashes an empty state. Every query holds its previous
 *     data (`placeholderData: keepPreviousData`), so stepping a day or
 *     switching a tab dims rather than blanks — an empty state that appears
 *     for 300ms reads as data loss.
 *
 * Nothing here computes a score. §3 gives that to `lib/day-score.ts`, and the
 * ring, the heatmap and the trend all print the same server number.
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
import { StatsTab } from "./goals/StatsTab";
import { addDays, toDayKey } from "./goals/quick-add";
import { TAP, formatDay, ghostButton } from "./goals/ui";

type Tab = "today" | "tasks" | "stats";
const TABS: { key: Tab; label: string }[] = [
  { key: "today", label: "TODAY" },
  { key: "tasks", label: "TASKS" },
  { key: "stats", label: "STATS" },
];
const isTab = (v: unknown): v is Tab =>
  v === "today" || v === "tasks" || v === "stats";

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

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["daily"] });
    void qc.invalidateQueries({ queryKey: ["daily-stats"] });
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
      toastError(
        "The draft didn't save. If this day is already committed, abandon a goal instead of editing it.",
        e,
      ),
    onSettled: invalidate,
  });

  const commitM = useMutation({
    mutationFn: async (v: { intent: string | null; big3: DayGoal[] }) => {
      await saveDayPlan(day, v);
      return commitDay(day);
    },
    onError: (e) => toastError("COMMIT FAILED — the day is still a draft.", e),
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
        maxWidth: 1180,
        margin: "0 auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
          Goals / Tasks
        </span>
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          said vs done — the only scoreboard
        </span>
      </div>

      {/* Tabs. At 390px these are the primary navigation of the surface, so
          they are full-width and 44px tall before they are anything else. */}
      <div style={{ display: "flex", gap: 6, margin: "12px 0 4px" }}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              /* Same convention as `data-nav-menu-item` in DesktopApp: a
                 stable hook so a check script or a screenshot run can reach a
                 tab without matching on a label that also exists in the nav. */
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
                fontSize: 11.5,
                letterSpacing: "0.1em",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "today" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "10px 0 4px" }}>
          <DayStep
            icon="chevron_left"
            label="Previous day"
            onClick={() => setDay(addDays(day, -1))}
          />
          <span
            className="mono"
            style={{ flex: 1, textAlign: "center", fontSize: 11.5, color: tokens.textMuted }}
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

      <div style={{ marginTop: 10 }}>
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
      }}
    >
      <span className="ms" style={{ fontSize: 18 }}>
        {icon}
      </span>
    </button>
  );
}
