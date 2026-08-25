"use client";

/**
 * The left rail: one nominated task, a quick-add line, then everything else
 * ordered by pressure.
 *
 * Konrad's stated goal for a task system is that he is "occupied around the
 * clock" and never has to work out what is next. A sorted list of forty does not
 * deliver that — it is the thing you scroll past. So the rail names ONE task at
 * the top, and the list below is what you reach for only when you disagree.
 *
 * Every row is draggable onto the week grid; that drop both schedules it and
 * writes the calendar event.
 */

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { IMPORTANCE_SCALE, areaColor, importanceColor, importanceLabel } from "./ui";
import { byPressure, isOpen, isScheduled, nextTask, pressure } from "./pressure";
import { fetchLifeGoals, type DayTask, type LifeGoal } from "../../api";

/** Konrad's task areas. Free text in the DB, so this is a suggestion list and
 *  not a constraint — typing a new one still works. */
const AREA_SUGGESTIONS = [
  "business",
  "youtube",
  "buying-selling",
  "household",
  "relationships",
  "health",
  "admin",
  "other",
];

export interface TaskRailProps {
  tasks: DayTask[];
  today: string;
  onQuickAdd: (text: string) => void | Promise<void>;
  onToggle: (taskId: string, done: boolean) => void | Promise<void>;
  onOpen: (taskId: string) => void;
  onStart: (taskId: string) => void | Promise<void>;
  busy?: boolean;
}

export function TaskRail({
  tasks,
  today,
  onQuickAdd,
  onToggle,
  onOpen,
  onStart,
  busy,
}: TaskRailProps) {
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ kind: "imp" | "area"; query: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const lifeGoalsQ = useQuery({
    queryKey: ["life-goals"],
    queryFn: () => fetchLifeGoals(),
  });
  const goals = lifeGoalsQ.data ?? [];
  const goalMap = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);

  const next = nextTask(tasks, today);
  const nextGoal = next?.goal_id ? goalMap.get(next.goal_id) : null;
  const loose = tasks
    .filter(isOpen)
    .filter((t) => !isScheduled(t))
    .filter((t) => t.id !== next?.id)
    .sort(byPressure(today));

  const visible = showAll ? loose : loose.slice(0, 14);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setMenu(null);
    void onQuickAdd(text);
  };

  /**
   * `!` opens the importance menu, `@` the area menu — the levels appear as you
   * type instead of having to be remembered. Konrad: "I also want them to be
   * colorcoded and appear automatically as sort of options when typing."
   *
   * Anchored to the LAST unfinished token so it never fires on a `!` sitting in
   * the middle of a sentence someone already finished typing.
   */
  const readMenu = (value: string): { kind: "imp" | "area"; query: string } | null => {
    const m = /(?:^|\s)([!@])([\w-]*)$/.exec(value);
    if (!m) return null;
    return { kind: m[1] === "!" ? "imp" : "area", query: m[2].toLowerCase() };
  };

  const applyToken = (token: string): void => {
    const next = draft.replace(/(?:^|\s)([!@])([\w-]*)$/, (full, sigil: string) => {
      const lead = full.startsWith(" ") ? " " : "";
      return `${lead}${sigil}${token} `;
    });
    setDraft(next);
    setMenu(null);
    inputRef.current?.focus();
  };

  const impOptions = menu?.kind === "imp"
    ? IMPORTANCE_SCALE.filter((l) => !menu.query || l.short.startsWith(menu.query))
    : [];
  const areaOptions = menu?.kind === "area"
    ? AREA_SUGGESTIONS.filter((a) => !menu.query || a.startsWith(menu.query))
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 10 }}>
      {/* ── The one task ────────────────────────────────────────────────── */}
      <div
        style={{
          border: `1px solid ${next ? tokens.accent : tokens.border}`,
          borderRadius: 10,
          padding: 12,
          background: next ? `${tokens.accent}12` : tokens.bgCard,
          flexShrink: 0,
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 9,
            letterSpacing: "0.14em",
            color: tokens.accent,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Next
        </div>
        {next ? (
          <>
            <div
              onClick={() => onOpen(next.id)}
              style={{
                fontSize: 15,
                lineHeight: 1.35,
                color: tokens.textHi,
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: 8,
              }}
            >
              {next.title}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <Tag text={importanceLabel(next.importance)} color={importanceColor(next.importance)} />
              {next.area && <Tag text={next.area} color={areaColor(next.area)} />}
              {nextGoal && <Tag text={nextGoal.title} color={tokens.accent} />}
              {next.due_day && <Tag text={`due ${next.due_day}`} color={tokens.warn} />}
              {next.carried >= 3 && (
                <Tag text={`carried ${next.carried}×`} color={tokens.bleed} />
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => void onStart(next.id)}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: tokens.accent,
                  color: tokens.onAccent,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {next.status === "doing" ? "In progress" : "Start"}
              </button>
              <button
                onClick={() => void onToggle(next.id, true)}
                disabled={busy}
                style={{
                  padding: "7px 12px",
                  borderRadius: 6,
                  border: `1px solid ${tokens.okActionBorder}`,
                  background: tokens.okActionBg,
                  color: tokens.ok,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: tokens.textSoft, lineHeight: 1.5 }}>
            Nothing open. Everything is either scheduled or finished.
          </div>
        )}
      </div>

      {/* ── Quick add ───────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, position: "relative" }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setMenu(readMenu(e.target.value));
          }}
          onBlur={() => window.setTimeout(() => setMenu(null), 120)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMenu(null);
              return;
            }
            if (e.key === "Enter") {
              // With the menu open, Enter takes the first suggestion rather
              // than submitting a half-typed `!ult`.
              if (impOptions.length > 0) {
                e.preventDefault();
                applyToken(impOptions[0].short);
                return;
              }
              if (areaOptions.length > 0) {
                e.preventDefault();
                applyToken(areaOptions[0]);
                return;
              }
              submit();
            }
          }}
          placeholder="add a task…  type ! or @ for options"
          style={{
            width: "100%",
            padding: "9px 11px",
            borderRadius: 7,
            border: `1px solid ${menu ? tokens.accent : tokens.border}`,
            background: tokens.inputBg,
            color: tokens.textHi,
            fontSize: 12.5,
            outline: "none",
          }}
        />

        {impOptions.length > 0 && (
          <div style={menuStyle()}>
            {impOptions.map((l) => (
              <button
                key={l.value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyToken(l.short)}
                style={menuItemStyle()}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    background: l.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: tokens.textHi, fontSize: 12 }}>{l.label}</span>
                <span className="mono" style={{ marginLeft: "auto", fontSize: 9, color: tokens.textGhost }}>
                  !{l.short}
                </span>
              </button>
            ))}
          </div>
        )}

        {areaOptions.length > 0 && (
          <div style={menuStyle()}>
            {areaOptions.map((a) => (
              <button
                key={a}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyToken(a)}
                style={menuItemStyle()}
              >
                <span
                  style={{ width: 9, height: 9, borderRadius: 2, background: areaColor(a), flexShrink: 0 }}
                />
                <span style={{ color: tokens.textHi, fontSize: 12 }}>{a}</span>
              </button>
            ))}
          </div>
        )}
        <div
          className="mono"
          style={{ fontSize: 9, color: tokens.textGhost, marginTop: 4, paddingLeft: 2 }}
        >
          same grammar as /todo · Enter to add
        </div>
      </div>

      {/* ── The rest, by pressure ───────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {loose.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.textGhost, padding: "12px 2px" }}>
            Nothing unscheduled.
          </div>
        ) : (
          visible.map((t) => (
            <Row
              key={t.id}
              task={t}
              today={today}
              goal={t.goal_id ? (goalMap.get(t.goal_id) ?? null) : null}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        )}
        {loose.length > 14 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            style={{
              width: "100%",
              marginTop: 6,
              padding: "6px",
              borderRadius: 6,
              border: `1px solid ${tokens.border}`,
              background: "transparent",
              color: tokens.textSoft,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {showAll ? "show less" : `show all ${loose.length}`}
          </button>
        )}
      </div>
    </div>
  );
}

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9,
        padding: "2px 6px",
        borderRadius: 4,
        border: `1px solid ${color}66`,
        color,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {text}
    </span>
  );
}

function Row({
  task,
  today,
  goal,
  onToggle,
  onOpen,
}: {
  task: DayTask;
  today: string;
  goal?: LifeGoal | null;
  onToggle: (id: string, done: boolean) => void | Promise<void>;
  onOpen: (id: string) => void;
}) {
  const p = pressure(task, today);
  const overdue = Boolean(task.due_day && task.due_day < today);

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/forge-task", task.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onOpen(task.id)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "7px 8px",
        borderRadius: 6,
        marginBottom: 3,
        cursor: "grab",
        borderLeft: `3px solid ${importanceColor(task.importance)}`,
        background: tokens.bgGutter,
      }}
    >
      <input
        type="checkbox"
        checked={false}
        onClick={(e) => e.stopPropagation()}
        onChange={() => void onToggle(task.id, true)}
        style={{ marginTop: 2, cursor: "pointer", accentColor: tokens.ok }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: tokens.textHi, lineHeight: 1.35 }}>{task.title}</div>
        <div
          className="mono"
          style={{ fontSize: 9, color: tokens.textGhost, marginTop: 2, display: "flex", gap: 7 }}
        >
          {task.area && <span style={{ color: areaColor(task.area) }}>@{task.area}</span>}
          {goal && (
            <span
              style={{
                color: tokens.accent,
                maxWidth: 90,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={goal.title}
            >
              ◆ {goal.title}
            </span>
          )}
          {task.due_day && (
            <span style={{ color: overdue ? tokens.bleed : tokens.textGhost }}>
              due {task.due_day}
            </span>
          )}
          {task.age_days > 0 && <span>{task.age_days}d old</span>}
          {task.carried >= 3 && <span style={{ color: tokens.bleed }}>×{task.carried}</span>}
          <span style={{ marginLeft: "auto", opacity: 0.6 }}>{Math.round(p.total)}</span>
        </div>
      </div>
    </div>
  );
}

function menuStyle(): React.CSSProperties {
  return {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    right: 0,
    zIndex: 30,
    background: tokens.bgCard,
    border: `1px solid ${tokens.borderEmphasis}`,
    borderRadius: 8,
    boxShadow: tokens.shadowPopover,
    padding: 4,
    display: "flex",
    flexDirection: "column",
    gap: 1,
    maxHeight: 220,
    overflowY: "auto",
  };
}

function menuItemStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    borderRadius: 5,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  };
}
