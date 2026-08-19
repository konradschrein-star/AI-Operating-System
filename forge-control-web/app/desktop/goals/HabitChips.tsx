"use client";

/**
 * The habit grid — four labelled rows of icon chips (§6 TODAY 4).
 *
 * This is the direct answer to Notion failure §0.3, the 19-column checkbox
 * wall: the columns became four short rows of 64px chips that wrap, so the
 * whole day's habits fit a 390px screen with nothing to scroll sideways.
 *
 * The flip is optimistic and lives in the parent's mutation — a tick that
 * waits on a round trip feels broken, and a habit that feels broken stops
 * being ticked. This component is presentational apart from the tap.
 */

import { tokens } from "../../tokens";
import type { DayHabit, DayHabitWithStreak } from "../../api";
import { EmptyState, TAP } from "./ui";

/** The order §2 seeds them in, which is also the order of the day. */
const GROUP_ORDER = ["morning", "body", "work", "evening"] as const;

const GROUP_LABEL: Record<string, string> = {
  morning: "MORNING",
  body: "BODY",
  work: "WORK",
  evening: "EVENING",
};

/** 70 rather than 64: at 8px mono, "Supplements" and "Stretching" fit on one
 *  line at 70 and break mid-word at 64. Four still fit a 390px row. */
const CHIP = 70;

export function HabitChips({
  habits,
  done,
  onToggle,
  disabled,
}: {
  /** The day bundle's habits, each carrying its own streak — so the badge
   *  never waits on the STATS window to be fetched. */
  habits: DayHabitWithStreak[];
  /** Habit ids ticked for the day being viewed. Absent = not done; there is
   *  no third state. */
  done: Set<string>;
  onToggle: (habit: DayHabit, next: boolean) => void;
  /** True while the day's habits are still loading, so taps can't race. */
  disabled?: boolean;
}) {
  const active = habits.filter((h) => h.active);
  if (active.length === 0) {
    return (
      <EmptyState icon="check_box_outline_blank">
        No habits defined yet — migration 0042 seeds eighteen of them
        (wake 6:00, trained, deep work, read 20 mins …). They appear here as
        soon as the daily API answers.
      </EmptyState>
    );
  }

  const groups = [...GROUP_ORDER, ...new Set(active.map((h) => h.grp))].filter(
    (g, i, arr) => arr.indexOf(g) === i,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {groups.map((grp) => {
        const rows = active
          .filter((h) => h.grp === grp)
          .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
        if (rows.length === 0) return null;
        const hit = rows.filter((h) => done.has(h.id)).length;
        return (
          <div key={grp}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 7,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  letterSpacing: "0.12em",
                  color: tokens.textGhost,
                }}
              >
                {GROUP_LABEL[grp] ?? grp.toUpperCase()}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  color: hit === rows.length ? tokens.ok : tokens.textGhost,
                }}
              >
                {hit}/{rows.length}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {rows.map((h) => (
                <HabitChip
                  key={h.id}
                  habit={h}
                  done={done.has(h.id)}
                  streak={h.streak}
                  disabled={disabled}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HabitChip({
  habit,
  done,
  streak,
  disabled,
  onToggle,
}: {
  habit: DayHabitWithStreak;
  done: boolean;
  streak: number;
  disabled?: boolean;
  onToggle: (habit: DayHabit, next: boolean) => void;
}) {
  const avoid = habit.polarity === "avoid";
  const tone = done ? (avoid ? tokens.ok : tokens.accent) : tokens.textMuted;
  return (
    <button
      type="button"
      aria-pressed={done}
      title={
        `${habit.label}${avoid ? " (avoid)" : ""}` +
        (streak > 0 ? ` — ${streak} day streak` : "")
      }
      disabled={disabled}
      onClick={() => onToggle(habit, !done)}
      style={{
        position: "relative",
        width: CHIP,
        minHeight: Math.max(CHIP, TAP),
        padding: "8px 4px 6px",
        borderRadius: 10,
        border: `1.5px solid ${done ? tone : tokens.border}`,
        background: done ? tokens.selectedBg : tokens.bgCard,
        color: tone,
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      <span
        className="ms"
        style={{
          fontSize: 21,
          color: tone,
          /* A successfully avoided habit shows its icon struck through — the
             point of "No sweets" is the absence, so the glyph is crossed out
             rather than filled in (§6 TODAY 4). */
          textDecoration: done && avoid ? "line-through" : "none",
          fontVariationSettings: done && !avoid ? "'FILL' 1, 'wght' 300" : undefined,
        }}
      >
        {habit.icon}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 8,
          lineHeight: 1.25,
          color: done ? tokens.textSecondary : tokens.textFaint,
          textAlign: "center",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          wordBreak: "break-word",
        }}
      >
        {habit.label}
      </span>
      {streak >= 3 && (
        <span
          className="mono"
          style={{
            position: "absolute",
            top: 3,
            right: 4,
            fontSize: 8.5,
            color: tokens.accent,
          }}
        >
          {streak}
        </span>
      )}
    </button>
  );
}
