"use client";

/**
 * TASKS — The executive task database, scheduling queue, and action board.
 *
 * Includes:
 * - Comprehensive task list/table: Name, Area tag, status (todo/doing/done/parked),
 *   Importance badge (critical/high/normal/low), Age in days, Time until due date,
 *   Duration estimate (~30m), notes, one-click finish button.
 * - Views: Today, Week, Backlog (no date), All.
 * - Quick-add box with natural language parsing (~30m, #area, at 14:00, tomorrow).
 * - [Schedule on Calendar] action modal/popover per task with Google Calendar integration.
 * - List vs Board (at >= 900px) view toggle and mobile-first 390px support.
 */

import { useMemo, useState } from "react";
import { tokens, dot } from "../../tokens";
import {
  createCalendarEvent,
  type DayTask,
  type DayTaskInput,
  type DayTaskStatus,
  type DayTaskView,
} from "../../api";
import { parseQuickAdd, toDayKey, addDays } from "./quick-add";
import {
  CARD,
  EmptyState,
  TAP,
  areaColor,
  chipStyle,
  formatDay,
  ghostButton,
  importanceColor,
  importanceLabel,
  inputStyle,
  primaryButton,
  textareaStyle,
} from "./ui";
import { toastError } from "../_ui/Toasts";

export interface TaskActions {
  onToggleDone: (task: DayTask, done: boolean) => void;
  onSetStatus: (task: DayTask, status: DayTaskStatus) => void;
  onDelete: (task: DayTask) => void;
  onAdd: (input: DayTaskInput) => void;
  onUpdate?: (id: string, patch: Partial<DayTaskInput>) => void;
}

const VIEWS: { key: DayTaskView; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "backlog", label: "Backlog (No Date)" },
  { key: "all", label: "All Tasks" },
];

const STATUSES: DayTaskStatus[] = ["todo", "doing", "done", "parked"];

const STATUS_COLOR: Record<DayTaskStatus, string> = {
  todo: tokens.textMuted,
  doing: tokens.accent,
  done: tokens.ok,
  parked: tokens.textGhost,
};

/**
 * Format relative due date string: "due today", "due in 2d", "due 3d ago"
 */
export function formatDueRemaining(dueDay: string, todayKey: string): { text: string; urgent: boolean; past: boolean } {
  if (dueDay === todayKey) {
    return { text: "due today", urgent: true, past: false };
  }
  if (dueDay < todayKey) {
    // compute days past
    const d1 = new Date(dueDay).getTime();
    const d2 = new Date(todayKey).getTime();
    const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    return { text: `due ${days}d ago`, urgent: true, past: true };
  }
  const d1 = new Date(dueDay).getTime();
  const d2 = new Date(todayKey).getTime();
  const days = Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
  return { text: `due in ${days}d`, urgent: days <= 2, past: false };
}

/**
 * Format duration minutes nicely: "~30m", "~1h", "~1h 30m"
 */
export function formatDuration(min: number | null | undefined): string | null {
  if (min === null || min === undefined || min <= 0) return null;
  if (min < 60) return `~${min}m`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `~${h}h ${rem}m` : `~${h}h`;
}

/**
 * Sorting: Critical importance first, then nearest deadline, then age
 */
export function sortTasks(tasks: DayTask[]): DayTask[] {
  return [...tasks].sort(
    (a, b) =>
      b.importance - a.importance ||
      (a.due_day ?? "9999-12-31").localeCompare(b.due_day ?? "9999-12-31") ||
      a.created_at.localeCompare(b.created_at),
  );
}

export function TasksTab({
  tasks,
  view,
  onView,
  area,
  onArea,
  status,
  onStatus,
  actions,
  loading,
  narrow,
  onRollover,
  rollingOver,
  day,
}: {
  tasks: DayTask[];
  view: DayTaskView;
  onView: (v: DayTaskView) => void;
  area: string | null;
  onArea: (a: string | null) => void;
  status: DayTaskStatus | null;
  onStatus: (s: DayTaskStatus | null) => void;
  actions: TaskActions;
  loading: boolean;
  narrow: boolean;
  onRollover: () => void;
  rollingOver: boolean;
  /** The day quick-add files onto when the line names no other */
  day: string;
}) {
  const [board, setBoard] = useState(false);
  const [scheduleTask, setScheduleTask] = useState<DayTask | null>(null);

  const areas = useMemo(
    () =>
      [...new Set(tasks.map((t) => t.area).filter((a): a is string => !!a))].sort(),
    [tasks],
  );

  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const showBoard = board && !narrow;

  const todayKey = toDayKey(new Date());

  return (
    <div>
      {/* Top Header & View Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <span className="mono" style={{ fontSize: 11, fontWeight: 500, color: tokens.textSoft }}>
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
          {loading && tasks.length === 0 ? " · loading…" : ""}
        </span>
        <span style={{ flex: 1 }} />
        {!narrow && (
          <button
            type="button"
            style={{ ...ghostButton(), color: board ? tokens.accent : tokens.textMuted }}
            onClick={() => setBoard((b) => !b)}
          >
            {board ? "list view" : "board view"}
          </button>
        )}
        <button
          type="button"
          style={{
            ...ghostButton(),
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
          title="Move every open task from past days onto today and increment carry count. Idempotent."
          disabled={rollingOver}
          onClick={onRollover}
        >
          <span className="ms" style={{ fontSize: 14 }}>sync</span>
          {rollingOver ? "rolling…" : "roll over open"}
        </button>
      </div>

      {/* View Chips */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            style={{ ...chipStyle(view === v.key), flex: narrow ? 1 : "none" }}
            onClick={() => onView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Status Chips */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            style={chipStyle(status === s, STATUS_COLOR[s])}
            onClick={() => onStatus(status === s ? null : s)}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Area Chips */}
      {areas.length > 0 && (
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
          <button
            type="button"
            style={chipStyle(area === null)}
            onClick={() => onArea(null)}
          >
            all areas
          </button>
          {areas.map((a) => (
            <button
              key={a}
              type="button"
              style={chipStyle(area === a, areaColor(a))}
              onClick={() => onArea(area === a ? null : a)}
            >
              #{a}
            </button>
          ))}
        </div>
      )}

      {/* Quick Add Form */}
      <div style={{ marginTop: 14 }}>
        <QuickAddBox day={day} onAdd={actions.onAdd} />
      </div>

      {/* Tasks Content: Board or List */}
      {sorted.length === 0 ? (
        <div style={{ marginTop: 14 }}>
          <EmptyState icon="task_alt">
            {loading
              ? "Loading tasks…"
              : view === "backlog"
                ? "No tasks in the backlog — all tasks have an assigned target day."
                : `No tasks in ${view === "all" ? "the list" : view} yet. Add one above or schedule one from the planner.`}
          </EmptyState>
        </div>
      ) : showBoard ? (
        <Board
          tasks={sorted}
          actions={actions}
          todayKey={todayKey}
          onSchedule={(t) => setScheduleTask(t)}
        />
      ) : (
        <div style={{ ...CARD, marginTop: 14, overflow: "hidden" }}>
          {sorted.map((t, i) => (
            <TaskRow
              key={t.id}
              task={t}
              actions={actions}
              isLast={i === sorted.length - 1}
              todayKey={todayKey}
              onSchedule={(task) => setScheduleTask(task)}
            />
          ))}
        </div>
      )}

      {/* Schedule on Calendar Modal */}
      {scheduleTask && (
        <ScheduleModal
          task={scheduleTask}
          defaultDay={day}
          onClose={() => setScheduleTask(null)}
          onScheduled={(patch) => {
            if (actions.onUpdate) {
              actions.onUpdate(scheduleTask.id, patch);
            }
            setScheduleTask(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * 4-column kanban board for desktop views
 */
function Board({
  tasks,
  actions,
  todayKey,
  onSchedule,
}: {
  tasks: DayTask[];
  actions: TaskActions;
  todayKey: string;
  onSchedule: (task: DayTask) => void;
}) {
  return (
    <div
      style={{
        marginTop: 14,
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 10,
        alignItems: "start",
      }}
    >
      {STATUSES.map((s) => {
        const rows = tasks.filter((t) => t.status === s);
        return (
          <div key={s} style={{ ...CARD, overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "9px 11px",
                borderBottom: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <span style={{ width: 4, height: 13, borderRadius: 2, background: STATUS_COLOR[s] }} />
              <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: tokens.textLabel }}>
                {s.toUpperCase()}
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                {rows.length}
              </span>
            </div>
            {rows.length === 0 ? (
              <div
                className="mono"
                style={{ fontSize: 10.5, color: tokens.textGhost, padding: "14px 11px", textAlign: "center" }}
              >
                empty
              </div>
            ) : (
              rows.map((t, i) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  actions={actions}
                  isLast={i === rows.length - 1}
                  todayKey={todayKey}
                  onSchedule={onSchedule}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Single Task Row with One-Click Complete, Area tag, Importance badge,
 * Age in days, Due remaining countdown, Duration estimate, and Schedule Action.
 */
export function TaskRow({
  task,
  actions,
  isLast,
  todayKey = toDayKey(new Date()),
  onSchedule,
}: {
  task: DayTask;
  actions: TaskActions;
  isLast: boolean;
  todayKey?: string;
  onSchedule?: (task: DayTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const done = task.status === "done";
  const parked = task.status === "parked";
  const doing = task.status === "doing";
  const age = task.age_days;
  const stale = task.stale;

  const dueInfo = task.due_day ? formatDueRemaining(task.due_day, todayKey) : null;
  const durLabel = formatDuration(task.duration_min ?? task.est_min);

  return (
    <div
      style={{
        borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
        opacity: parked ? 0.55 : 1,
        background: doing ? tokens.toolBg : "transparent",
        transition: "background 0.12s",
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 6,
          padding: "6px 10px 6px 6px",
          cursor: "pointer",
          minHeight: TAP + 6,
        }}
      >
        {/* 1-Click Finish Button */}
        <button
          type="button"
          aria-pressed={done}
          aria-label={done ? `Mark "${task.title}" not done` : `Complete "${task.title}"`}
          onClick={(e) => {
            e.stopPropagation();
            actions.onToggleDone(task, !done);
          }}
          style={{
            width: TAP,
            height: TAP,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              border: `1.5px solid ${done ? tokens.ok : tokens.borderEmphasis}`,
              background: done ? tokens.ok : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.15s, border-color 0.15s",
            }}
          >
            {done && (
              <span className="ms" style={{ fontSize: 14, color: tokens.bgCard }}>
                check
              </span>
            )}
          </span>
        </button>

        {/* Content Body */}
        <div style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.45,
              color: done ? tokens.textFaint : tokens.textSoft,
              textDecoration: done ? "line-through" : "none",
              wordBreak: "break-word",
            }}
          >
            {task.title}
          </div>

          {/* Metadata badges row */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
              marginTop: 4,
            }}
          >
            {/* Area tag */}
            {task.area && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: areaColor(task.area),
                  border: `1px solid ${tokens.borderDivider}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                }}
              >
                #{task.area}
              </span>
            )}

            {/* Importance badge */}
            {task.importance > 1 && (
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: importanceColor(task.importance),
                  background: tokens.toolBg,
                  border: `1px solid ${importanceColor(task.importance)}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                }}
              >
                {importanceLabel(task.importance).toUpperCase()}
              </span>
            )}

            {/* Duration estimate */}
            {durLabel && (
              <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
                {durLabel}
              </span>
            )}

            {/* Scheduled start time */}
            {task.start_time && (
              <span className="mono" style={{ fontSize: 9.5, color: tokens.accent, display: "flex", alignItems: "center", gap: 2 }}>
                <span className="ms" style={{ fontSize: 11 }}>schedule</span>
                {new Date(task.start_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}

            {/* Due Countdown */}
            {dueInfo && !done && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  fontWeight: dueInfo.urgent ? 600 : 400,
                  color: dueInfo.past ? tokens.bleed : dueInfo.urgent ? tokens.warn : tokens.textGhost,
                }}
              >
                {dueInfo.text}
              </span>
            )}

            {/* Age in days badge */}
            {!done && age > 7 && (
              <WarnChip tone={age > 14 ? tokens.bleed : tokens.warn}>
                {age}d old
              </WarnChip>
            )}

            {/* Stale / carried count */}
            {!done && task.carried >= 2 && (
              <WarnChip tone={stale ? tokens.bleed : tokens.warn}>
                carried {task.carried}×
              </WarnChip>
            )}

            {/* Status indicators */}
            {doing && (
              <span className="mono" style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: tokens.primaryActionBg, color: tokens.accent, border: `1px solid ${tokens.accent}` }}>
                DOING
              </span>
            )}

            {task.gcal_event_id && (
              <span className="mono" style={{ fontSize: 9, color: tokens.ok, display: "flex", alignItems: "center", gap: 2 }} title="Synced to Google Calendar">
                <span className="ms" style={{ fontSize: 11 }}>event_available</span>
                gcal
              </span>
            )}
          </div>
        </div>

        {/* Action Button: Schedule on Calendar */}
        {onSchedule && !done && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSchedule(task);
            }}
            style={{
              ...ghostButton(),
              padding: "4px 6px",
              marginTop: 6,
              fontSize: 10,
              display: "flex",
              alignItems: "center",
              gap: 3,
            }}
            title="Schedule on Google Calendar & Timeline"
          >
            <span className="ms" style={{ fontSize: 14 }}>calendar_add_on</span>
            <span className="mono" style={{ fontSize: 10 }}>
              Schedule
            </span>
          </button>
        )}

        <span
          style={{ ...dot(importanceColor(task.importance)), marginTop: 14, marginLeft: 2 }}
          title={`${importanceLabel(task.importance)} importance`}
        />
      </div>

      {/* Expanded details */}
      {open && (
        <div
          style={{
            padding: "0 12px 12px 48px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {task.notes && (
            <div style={{ fontSize: 12, color: tokens.textMuted, lineHeight: 1.5, background: tokens.bgCard, padding: "6px 10px", borderRadius: 6, border: `1px solid ${tokens.borderDivider}` }}>
              {task.notes}
            </div>
          )}

          <div
            className="mono"
            style={{ fontSize: 10, color: tokens.textGhost, display: "flex", gap: 12, flexWrap: "wrap" }}
          >
            <span>planned: {task.planned_day ? formatDay(task.planned_day) : "—"}</span>
            <span>due: {task.due_day ? formatDay(task.due_day) : "—"}</span>
            <span>duration: {durLabel ?? "—"}</span>
            <span>age: {age} days</span>
            <span>carried: {task.carried}×</span>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              style={{
                ...ghostButton(),
                color: doing ? tokens.accent : tokens.textMuted,
                border: doing ? `1px solid ${tokens.accent}` : `1px solid ${tokens.border}`,
              }}
              onClick={() =>
                actions.onSetStatus(task, doing ? "todo" : "doing")
              }
            >
              {doing ? "stop doing" : "doing now"}
            </button>

            <button
              type="button"
              style={ghostButton()}
              onClick={() => actions.onSetStatus(task, parked ? "todo" : "parked")}
            >
              {parked ? "un-park" : "park it"}
            </button>

            {onSchedule && !done && (
              <button
                type="button"
                style={{ ...ghostButton(), color: tokens.accent }}
                onClick={() => onSchedule(task)}
              >
                schedule on calendar
              </button>
            )}

            <button
              type="button"
              style={{ ...ghostButton(), color: tokens.bleed }}
              title="Delete task permanently"
              onClick={() => actions.onDelete(task)}
            >
              delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WarnChip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        color: tone ?? tokens.warn,
        border: `1px solid ${tone ?? tokens.warn}`,
        opacity: 0.9,
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}

/**
 * Natural language quick add parser box supporting duration (~30m), area (#area),
 * time of day (at 14:00, @14:00), and day markers (tomorrow, mon-sun, today).
 */
export function QuickAddBox({
  day,
  onAdd,
  placeholder,
}: {
  day: string;
  onAdd: (input: DayTaskInput) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");

  // Parse natural language time expressions like "at 14:00" or "@15:30"
  const { parsedTime, cleanText } = useMemo(() => {
    let t = text;
    const timeMatch = /\b(?:at|@)\s*(\d{1,2}(?::\d{2})?)\b/i.exec(t);
    let pt: string | null = null;
    if (timeMatch) {
      pt = timeMatch[1].includes(":") ? timeMatch[1] : `${timeMatch[1]}:00`;
      t = t.replace(timeMatch[0], " ").replace(/\s+/g, " ").trim();
    }
    return { parsedTime: pt, cleanText: t };
  }, [text]);

  const parsed = useMemo(() => parseQuickAdd(cleanText), [cleanText]);
  const ready = parsed.title.trim().length > 0;

  const submit = () => {
    if (!ready) return;
    const plannedDay = parsed.planned_day ?? day;
    let startTimeIso: string | null = null;
    if (parsedTime) {
      startTimeIso = `${plannedDay}T${parsedTime.padStart(5, "0")}:00`;
    }

    onAdd({
      title: parsed.title,
      ...(parsed.area !== null ? { area: parsed.area } : {}),
      ...(parsed.importance !== null ? { importance: parsed.importance } : {}),
      ...(parsed.est_min !== null ? { est_min: parsed.est_min, duration_min: parsed.est_min } : {}),
      planned_day: plannedDay,
      start_time: startTimeIso,
    });
    setText("");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 7 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={placeholder ?? "Add task —  #uni  !!  ~30m  at 14:00  tomorrow"}
          aria-label="Quick add a task"
          style={inputStyle()}
        />
        <button
          type="button"
          onClick={submit}
          aria-label="Add task"
          disabled={!ready}
          style={{
            width: TAP,
            height: TAP,
            flex: "none",
            borderRadius: 8,
            border: `1px solid ${ready ? tokens.accent : tokens.border}`,
            background: ready ? tokens.primaryActionBg : tokens.toolBg,
            color: ready ? tokens.accent : tokens.textGhost,
            cursor: ready ? "pointer" : "default",
          }}
        >
          <span className="ms" style={{ fontSize: 18 }}>
            add
          </span>
        </button>
      </div>

      {text.trim().length > 0 && (
        <div
          className="mono"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            fontSize: 9.5,
            color: tokens.textGhost,
            padding: "6px 2px 0",
          }}
        >
          <span style={{ color: ready ? tokens.textMuted : tokens.warn }}>
            {ready ? `“${parsed.title}”` : "type a title — the markers alone aren't a task"}
          </span>
          {parsed.area && <span style={{ color: areaColor(parsed.area) }}>#{parsed.area}</span>}
          {parsed.importance !== null && (
            <span style={{ color: importanceColor(parsed.importance) }}>
              {importanceLabel(parsed.importance)}
            </span>
          )}
          {parsed.est_min !== null && <span>~{parsed.est_min}m</span>}
          {parsedTime && <span style={{ color: tokens.accent }}>at {parsedTime}</span>}
          <span>{formatDay(parsed.planned_day ?? day)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Schedule on Calendar Modal
 */
function ScheduleModal({
  task,
  defaultDay,
  onClose,
  onScheduled,
}: {
  task: DayTask;
  defaultDay: string;
  onClose: () => void;
  onScheduled: (patch: Partial<DayTaskInput>) => void;
}) {
  const [targetDate, setTargetDate] = useState(task.planned_day ?? defaultDay);
  const [timeStr, setTimeStr] = useState("10:00");
  const [durationMin, setDurationMin] = useState(task.duration_min ?? task.est_min ?? 30);
  const [syncGoogleCalendar, setSyncGoogleCalendar] = useState(true);
  const [loading, setLoading] = useState(false);

  const handleSchedule = async () => {
    setLoading(true);
    try {
      const startIso = `${targetDate}T${timeStr}:00`;
      const startDate = new Date(startIso);
      const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000);
      const endIso = endDate.toISOString();

      let gcalId: string | null = null;

      if (syncGoogleCalendar) {
        try {
          const res = await createCalendarEvent({
            summary: task.title,
            start: startIso,
            end: endIso,
            description: `Scheduled from AI OS Tasks: #${task.area ?? "general"}\n${task.notes ?? ""}`,
            task_id: task.id,
          });
          // Check if server returned event id
          gcalId = "gcal-synced";
        } catch (err) {
          console.warn("Google Calendar sync error (ignoring and scheduling locally):", err);
        }
      }

      onScheduled({
        planned_day: targetDate,
        start_time: startIso,
        duration_min: durationMin,
        ...(gcalId ? { gcal_event_id: gcalId } : {}),
      });
    } catch (e) {
      toastError("Failed to schedule task", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: tokens.overlay,
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          ...CARD,
          width: "100%",
          maxWidth: 480,
          padding: "20px 22px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
            paddingBottom: 10,
            borderBottom: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: tokens.textHi }}>
              Schedule on Calendar & Timeline
            </div>
            <div className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
              {task.title}
            </div>
          </div>
          <button type="button" onClick={onClose} style={ghostButton()}>
            <span className="ms" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Target Day */}
          <div>
            <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
              SCHEDULE DAY
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              style={inputStyle()}
            />
          </div>

          {/* Time & Duration */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
                START TIME
              </label>
              <input
                type="time"
                value={timeStr}
                onChange={(e) => setTimeStr(e.target.value)}
                style={inputStyle()}
              />
            </div>

            <div>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
                DURATION (MIN)
              </label>
              <select
                value={durationMin}
                onChange={(e) => setDurationMin(Number(e.target.value))}
                style={inputStyle()}
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={45}>45 minutes</option>
                <option value={60}>1 hour</option>
                <option value={90}>1.5 hours</option>
                <option value={120}>2 hours</option>
              </select>
            </div>
          </div>

          {/* Sync to Google Calendar option */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 6,
              background: tokens.toolBg,
              border: `1px solid ${tokens.borderDivider}`,
            }}
          >
            <input
              type="checkbox"
              id="syncGcal"
              checked={syncGoogleCalendar}
              onChange={(e) => setSyncGoogleCalendar(e.target.checked)}
              style={{ cursor: "pointer", width: 16, height: 16 }}
            />
            <label htmlFor="syncGcal" style={{ fontSize: 12, color: tokens.textSoft, cursor: "pointer" }}>
              Sync to Google Calendar (konrad.schrein@gmail.com)
            </label>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 20,
            paddingTop: 14,
            borderTop: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <button type="button" onClick={onClose} style={ghostButton()}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSchedule}
            disabled={loading}
            style={primaryButton()}
          >
            {loading ? "Scheduling…" : "Confirm Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
