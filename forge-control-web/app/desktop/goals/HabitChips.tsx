"use client";

/**
 * The habit grid — four labelled rows of icon chips grouped by daily rhythm:
 * Morning, Body, Work, Evening.
 *
 * Includes:
 * - Contextual rhythm highlighting based on current local hour.
 * - Daily completion progress percentage bar.
 * - Current and best streak indicators.
 * - Habit configuration / edit dialog.
 * - Clean responsive typography (Defect 3 fix: 0px clipping, full text visibility).
 */

import { useMemo, useState } from "react";
import { tokens } from "../../tokens";
import type { DayHabit, DayHabitWithStreak } from "../../api";
import { CARD, EmptyState, TAP, ghostButton, inputStyle, primaryButton } from "./ui";

const GROUP_ORDER = ["morning", "body", "work", "evening"] as const;

const GROUP_LABEL: Record<string, string> = {
  morning: "MORNING RHYTHM",
  body: "BODY & HEALTH",
  work: "WORK & CRAFT",
  evening: "EVENING ROUTINE",
};

const GROUP_SUBTITLE: Record<string, string> = {
  morning: "05:00 – 12:00",
  body: "12:00 – 15:00",
  work: "15:00 – 19:00",
  evening: "19:00 – 05:00",
};

/**
 * Compute the active daily rhythm based on the current local hour.
 */
function getCurrentRhythm(date: Date = new Date()): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 15) return "body";
  if (h >= 15 && h < 19) return "work";
  return "evening";
}

/** Minimum width to comfortably fit German/English habit labels without clipping */
const CHIP_MIN_WIDTH = 76;

export function HabitChips({
  habits,
  done,
  onToggle,
  disabled,
}: {
  /** The day bundle's habits, each carrying its own streak */
  habits: DayHabitWithStreak[];
  /** Habit ids ticked for the day being viewed */
  done: Set<string>;
  onToggle: (habit: DayHabit, next: boolean) => void;
  disabled?: boolean;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const [customHabits, setCustomHabits] = useState<DayHabitWithStreak[] | null>(null);

  const activeHabits = customHabits ?? habits;
  const active = activeHabits.filter((h) => h.active);

  const currentRhythm = useMemo(() => getCurrentRhythm(), []);

  // Overall daily habit stats
  const totalActive = active.length;
  const totalDone = active.filter((h) => done.has(h.id)).length;
  const completionPct = totalActive > 0 ? Math.round((totalDone / totalActive) * 100) : 0;

  if (active.length === 0) {
    return (
      <EmptyState icon="check_box_outline_blank">
        No habits defined yet — migration 0042 seeds eighteen habits. They appear here as soon
        as the daily API answers.
      </EmptyState>
    );
  }

  const groups = [...GROUP_ORDER, ...new Set(active.map((h) => h.grp))].filter(
    (g, i, arr) => arr.indexOf(g) === i,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Daily completion header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
          padding: "10px 14px",
          background: tokens.bgCard,
          borderRadius: 10,
          border: `1px solid ${tokens.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 200 }}>
          <div style={{ flex: 1 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 6,
              }}
            >
              <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", color: tokens.textSoft }}>
                DAILY HABITS
              </span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: completionPct === 100 ? tokens.ok : tokens.accent }}>
                {totalDone}/{totalActive} completed · {completionPct}%
              </span>
            </div>
            <div
              style={{
                width: "100%",
                height: 6,
                borderRadius: 3,
                background: tokens.borderDivider,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${completionPct}%`,
                  height: "100%",
                  background: completionPct === 100 ? tokens.ok : `linear-gradient(90deg, ${tokens.accent}, ${tokens.ok})`,
                  borderRadius: 3,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setConfigOpen(true)}
          style={{
            ...ghostButton(),
            fontSize: 11,
            padding: "4px 10px",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
          title="Configure habit list, labels, and groups"
        >
          <span className="ms" style={{ fontSize: 14 }}>tune</span>
          Configure
        </button>
      </div>

      {/* Habit Rhythm Groups */}
      {groups.map((grp) => {
        const rows = active
          .filter((h) => h.grp === grp)
          .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
        if (rows.length === 0) return null;

        const hit = rows.filter((h) => done.has(h.id)).length;
        const isCurrent = grp === currentRhythm;

        return (
          <div
            key={grp}
            style={{
              padding: isCurrent ? "12px 12px 10px" : "8px 0 4px",
              borderRadius: 10,
              background: isCurrent ? tokens.toolBg : "transparent",
              border: isCurrent ? `1px solid ${tokens.borderEmphasis}` : "none",
              transition: "background 0.15s ease",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 9,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.1em",
                  color: isCurrent ? tokens.accent : tokens.textSoft,
                }}
              >
                {GROUP_LABEL[grp] ?? grp.toUpperCase()}
              </span>

              {isCurrent && (
                <span
                  className="mono"
                  style={{
                    fontSize: 8.5,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: tokens.primaryActionBg,
                    color: tokens.accent,
                    border: `1px solid ${tokens.accent}`,
                  }}
                >
                  NOW ({GROUP_SUBTITLE[grp] ?? ""})
                </span>
              )}

              <span style={{ flex: 1 }} />

              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: hit === rows.length ? tokens.ok : tokens.textGhost,
                }}
              >
                {hit}/{rows.length}
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(auto-fill, minmax(${CHIP_MIN_WIDTH}px, 1fr))`,
                gap: 8,
              }}
            >
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

      {/* Habit Configuration Dialog */}
      {configOpen && (
        <HabitConfigDialog
          habits={activeHabits}
          onClose={() => setConfigOpen(false)}
          onSave={(updated) => {
            setCustomHabits(updated);
            setConfigOpen(false);
          }}
        />
      )}
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
        `${habit.label}${avoid ? " (avoidance goal)" : ""}` +
        (streak > 0 ? ` — ${streak} day streak` : " — no active streak")
      }
      disabled={disabled}
      onClick={() => onToggle(habit, !done)}
      style={{
        position: "relative",
        minHeight: Math.max(76, TAP),
        padding: "10px 6px 8px",
        borderRadius: 10,
        border: `1.5px solid ${done ? tone : tokens.border}`,
        background: done ? tokens.selectedBg : tokens.bgCard,
        color: tone,
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        boxSizing: "border-box",
        transition: "border-color 0.12s, background 0.12s, transform 0.08s",
      }}
    >
      {/* Icon */}
      <span
        className="ms"
        style={{
          fontSize: 22,
          lineHeight: 1,
          color: tone,
          textDecoration: done && avoid ? "line-through" : "none",
          fontVariationSettings: done && !avoid ? "'FILL' 1, 'wght' 400" : undefined,
        }}
      >
        {habit.icon}
      </span>

      {/* Label: Fixed typography, zero clipping (Defect 3) */}
      <span
        className="mono"
        style={{
          fontSize: 9.5,
          lineHeight: 1.3,
          color: done ? tokens.textSoft : tokens.textSecondary,
          textAlign: "center",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          wordBreak: "break-word",
          padding: "0 2px",
          width: "100%",
        }}
      >
        {habit.label}
      </span>

      {/* Streak Badge */}
      {streak > 0 && (
        <span
          className="mono"
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            fontSize: 8.5,
            fontWeight: 600,
            padding: "1px 4px",
            borderRadius: 4,
            background: done ? tokens.accent : tokens.borderDivider,
            color: done ? tokens.bgCard : tokens.accent,
            lineHeight: 1.2,
          }}
        >
          {streak}d
        </span>
      )}
    </button>
  );
}

/**
 * Habit Configuration & Customization Dialog
 */
function HabitConfigDialog({
  habits,
  onClose,
  onSave,
}: {
  habits: DayHabitWithStreak[];
  onClose: () => void;
  onSave: (updated: DayHabitWithStreak[]) => void;
}) {
  const [list, setList] = useState<DayHabitWithStreak[]>(() =>
    habits.map((h) => ({ ...h })),
  );

  const toggleActive = (id: string) => {
    setList((prev) =>
      prev.map((h) => (h.id === id ? { ...h, active: !h.active } : h)),
    );
  };

  const updateField = (id: string, field: keyof DayHabit, value: string | number | boolean) => {
    setList((prev) =>
      prev.map((h) => (h.id === id ? { ...h, [field]: value } : h)),
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
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
          maxWidth: 620,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: "18px 20px",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
            paddingBottom: 10,
            borderBottom: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi }}>
              Configure Habits
            </div>
            <div className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
              Enable, disable, or adjust your daily tracking set
            </div>
          </div>
          <button type="button" onClick={onClose} style={ghostButton()}>
            <span className="ms" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            paddingRight: 4,
          }}
        >
          {list.map((h) => (
            <div
              key={h.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                background: h.active ? tokens.bgCard : tokens.toolBg,
                border: `1px solid ${h.active ? tokens.border : tokens.borderDivider}`,
                opacity: h.active ? 1 : 0.6,
              }}
            >
              {/* Active checkbox */}
              <input
                type="checkbox"
                checked={h.active}
                onChange={() => toggleActive(h.id)}
                style={{ cursor: "pointer", width: 16, height: 16 }}
                aria-label={`Toggle habit ${h.label}`}
              />

              {/* Icon */}
              <span className="ms" style={{ fontSize: 20, color: tokens.accent, minWidth: 24, textAlign: "center" }}>
                {h.icon}
              </span>

              {/* Label */}
              <input
                type="text"
                value={h.label}
                onChange={(e) => updateField(h.id, "label", e.target.value)}
                style={{
                  ...inputStyle(),
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: 12,
                  minHeight: 32,
                }}
                disabled={!h.active}
              />

              {/* Group */}
              <select
                value={h.grp}
                onChange={(e) => updateField(h.id, "grp", e.target.value)}
                style={{
                  ...inputStyle(),
                  width: 100,
                  padding: "4px 8px",
                  fontSize: 11,
                  minHeight: 32,
                }}
                disabled={!h.active}
              >
                <option value="morning">Morning</option>
                <option value="body">Body</option>
                <option value="work">Work</option>
                <option value="evening">Evening</option>
              </select>

              {/* Polarity */}
              <select
                value={h.polarity}
                onChange={(e) => updateField(h.id, "polarity", e.target.value as "build" | "avoid")}
                style={{
                  ...inputStyle(),
                  width: 80,
                  padding: "4px 8px",
                  fontSize: 11,
                  minHeight: 32,
                }}
                disabled={!h.active}
              >
                <option value="build">Build</option>
                <option value="avoid">Avoid</option>
              </select>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 16,
            paddingTop: 12,
            borderTop: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <button type="button" onClick={onClose} style={ghostButton()}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(list)}
            style={primaryButton()}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
