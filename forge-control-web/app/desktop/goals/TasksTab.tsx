"use client";

/**
 * TASKS — one list, four view chips, and the row primitive TODAY reuses.
 *
 * Notion's task DB had eight columns and needed a horizontal scroll on a
 * phone (§0.3), and it grew a graveyard because nothing forced a decision
 * (§0.2). So: two lines per row, everything wraps, and the shaming metadata —
 * age, carried — appears ONLY when it is bad news. There is no permanent
 * "Age 121" column here, because a number that is always there is a number
 * nobody reads.
 *
 * The board (todo | doing | done | parked) exists at >= 900px only. On a
 * phone the view chips ARE the board.
 */

import { useMemo, useState } from "react";
import { tokens, dot } from "../../tokens";
import type { DayTask, DayTaskInput, DayTaskStatus, DayTaskView } from "../../api";
import { parseQuickAdd, toDayKey } from "./quick-add";
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
} from "./ui";

export interface TaskActions {
  onToggleDone: (task: DayTask, done: boolean) => void;
  onSetStatus: (task: DayTask, status: DayTaskStatus) => void;
  onDelete: (task: DayTask) => void;
  onAdd: (input: DayTaskInput) => void;
}

const VIEWS: { key: DayTaskView; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "backlog", label: "Backlog" },
  { key: "all", label: "All" },
];

const STATUSES: DayTaskStatus[] = ["todo", "doing", "done", "parked"];

const STATUS_COLOR: Record<DayTaskStatus, string> = {
  todo: tokens.textMuted,
  doing: tokens.accent,
  done: tokens.ok,
  parked: tokens.textGhost,
};

/** Importance first, then the nearest deadline, then oldest — the order in
 *  which a day should actually be attacked (§6 TASKS). */
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
  /** The day quick-add files onto when the line names no other. */
  day: string;
}) {
  const [board, setBoard] = useState(false);
  const areas = useMemo(
    () =>
      [...new Set(tasks.map((t) => t.area).filter((a): a is string => !!a))].sort(),
    [tasks],
  );
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const showBoard = board && !narrow;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
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
            {board ? "list" : "board"}
          </button>
        )}
        <button
          type="button"
          style={ghostButton()}
          title="Move every open task from a past day onto today and count the carry (§5). Idempotent."
          disabled={rollingOver}
          onClick={onRollover}
        >
          {rollingOver ? "rolling…" : "roll over"}
        </button>
      </div>

      {/* View chips — on a phone these are the whole navigation. */}
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

      <div style={{ marginTop: 14 }}>
        <QuickAddBox day={day} onAdd={actions.onAdd} />
      </div>

      {sorted.length === 0 ? (
        <div style={{ marginTop: 14 }}>
          <EmptyState icon="task_alt">
            {loading
              ? "Loading tasks…"
              : view === "backlog"
                ? "Nothing in the backlog — every task has a day on it."
                : `Nothing in ${view === "all" ? "the list" : view} yet. Add one above; the evening job also schedules tasks onto tomorrow at 20:30.`}
          </EmptyState>
        </div>
      ) : showBoard ? (
        <Board tasks={sorted} actions={actions} />
      ) : (
        <div style={{ ...CARD, marginTop: 14, overflow: "hidden" }}>
          {sorted.map((t, i) => (
            <TaskRow
              key={t.id}
              task={t}
              actions={actions}
              isLast={i === sorted.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Four equal columns in a grid, never a scroll region — at 900px+ each column
 *  gets a quarter of the width and the rows wrap inside it. */
function Board({ tasks, actions }: { tasks: DayTask[]; actions: TaskActions }) {
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
              <span className="mono" style={{ fontSize: 10.5, color: tokens.textLabel }}>
                {s}
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                {rows.length}
              </span>
            </div>
            {rows.length === 0 ? (
              <div
                className="mono"
                style={{ fontSize: 10.5, color: tokens.textGhost, padding: "14px 11px" }}
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
 * One task. Two lines, no columns, nothing clipped: the title wraps rather
 * than truncating, because a task you cannot read is a task you cannot do.
 * Tap the row to expand notes / dates / estimate and the status actions.
 */
export function TaskRow({
  task,
  actions,
  isLast,
}: {
  task: DayTask;
  actions: TaskActions;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const done = task.status === "done";
  const parked = task.status === "parked";
  /* Both numbers come from the server (Berlin calendar days, one stale rule)
     rather than being recomputed here — the browser's clock and the planner's
     day must not be allowed to disagree about what "old" means. */
  const age = task.age_days;
  const stale = task.stale;

  return (
    <div
      style={{
        borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
        opacity: parked ? 0.55 : 1,
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 4,
          padding: "4px 10px 4px 4px",
          cursor: "pointer",
          minHeight: TAP + 8,
        }}
      >
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
              width: 19,
              height: 19,
              borderRadius: 5,
              border: `1.5px solid ${done ? tokens.ok : tokens.borderEmphasis}`,
              background: done ? tokens.ok : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {done && (
              <span className="ms" style={{ fontSize: 14, color: tokens.bgCard }}>
                check
              </span>
            )}
          </span>
        </button>

        <div style={{ flex: 1, minWidth: 0, paddingTop: 9 }}>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              color: done ? tokens.textFaint : tokens.textSoft,
              textDecoration: done ? "line-through" : "none",
              wordBreak: "break-word",
            }}
          >
            {task.title}
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 7,
              marginTop: 4,
            }}
          >
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
            {task.est_min !== null && (
              <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
                ~{task.est_min}m
              </span>
            )}
            {task.due_day && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color:
                    task.due_day < toDayKey(new Date()) && !done
                      ? tokens.bleed
                      : tokens.textGhost,
                }}
              >
                due {formatDay(task.due_day)}
              </span>
            )}
            {/* Bad news only. No permanent shame column (§6 TASKS). */}
            {!done && age > 14 && <WarnChip>{age}d old</WarnChip>}
            {!done && task.carried >= 2 && (
              <WarnChip tone={stale ? tokens.bleed : tokens.warn}>
                carried {task.carried}×
              </WarnChip>
            )}
            {task.status === "doing" && (
              <span className="mono" style={{ fontSize: 9.5, color: tokens.accent }}>
                doing
              </span>
            )}
          </div>
        </div>

        <span
          style={{ ...dot(importanceColor(task.importance)), marginTop: 15 }}
          title={`${importanceLabel(task.importance)} importance`}
        />
      </div>

      {open && (
        <div
          style={{
            padding: "0 12px 12px 48px",
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          {task.notes && (
            <div style={{ fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.5 }}>
              {task.notes}
            </div>
          )}
          <div
            className="mono"
            style={{ fontSize: 10, color: tokens.textGhost, display: "flex", gap: 10, flexWrap: "wrap" }}
          >
            <span>planned {task.planned_day ? formatDay(task.planned_day) : "—"}</span>
            <span>due {task.due_day ? formatDay(task.due_day) : "—"}</span>
            <span>est {task.est_min !== null ? `${task.est_min}m` : "—"}</span>
            <span>age {age}d</span>
            <span>carried {task.carried}×</span>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            <button
              type="button"
              style={{
                ...ghostButton(),
                color: task.status === "doing" ? tokens.accent : tokens.textMuted,
              }}
              onClick={() =>
                actions.onSetStatus(task, task.status === "doing" ? "todo" : "doing")
              }
            >
              {task.status === "doing" ? "stop doing" : "doing now"}
            </button>
            <button
              type="button"
              style={ghostButton()}
              onClick={() => actions.onSetStatus(task, parked ? "todo" : "parked")}
            >
              {parked ? "un-park" : "park it"}
            </button>
            <button
              type="button"
              style={{ ...ghostButton(), color: tokens.bleed }}
              title="Hard delete — for typos. Parking keeps the row for the stats."
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
        opacity: 0.85,
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}

/**
 * The one-line quick add (§6 TODAY 5). Everything parsed out of the line is
 * echoed back as chips underneath while typing — that is how the syntax gets
 * learned, and how a mis-parse is caught before Enter rather than after.
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
  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  const ready = parsed.title.trim().length > 0;

  const submit = () => {
    if (!ready) return;
    onAdd({
      title: parsed.title,
      ...(parsed.area !== null ? { area: parsed.area } : {}),
      ...(parsed.importance !== null ? { importance: parsed.importance } : {}),
      ...(parsed.est_min !== null ? { est_min: parsed.est_min } : {}),
      planned_day: parsed.planned_day ?? day,
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
          placeholder={placeholder ?? "Add a task —  #uni  !!  ~30m  tomorrow"}
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
          <span>{formatDay(parsed.planned_day ?? day)}</span>
        </div>
      )}
    </div>
  );
}
