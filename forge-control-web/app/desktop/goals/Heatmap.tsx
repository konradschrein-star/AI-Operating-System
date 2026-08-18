"use client";

/**
 * The 90-day score heatmap (§6 STATS 2) — GitHub-style, week columns.
 *
 * The hard constraint is width: thirteen week-columns must fit inside 390px
 * with no horizontal scroll, so every column is `flex: 1` over a
 * `minWidth: 0` track and the cell sizes itself with `aspect-ratio`. Nothing
 * here has a fixed pixel width, which is why the same component is a dense
 * strip on a phone and a comfortable grid at 1440.
 *
 * Five intensity steps, all of them `tokens.accent` at increasing opacity —
 * a var() cannot be alpha-composited inside a colour string, so the opacity
 * lands on the cell itself. A day with no row at all is drawn as an empty
 * track, never as a zero: "nothing recorded" and "scored nothing" are
 * different facts (§3).
 */

import { tokens } from "../../tokens";
import type { DayStatsDay } from "../../api";
import { EmptyState, formatDay, pctText } from "./ui";
import { addDays, fromDayKey, toDayKey } from "./quick-add";

const STEPS = [0.16, 0.34, 0.52, 0.74, 1] as const;

/** 13 week-columns must fit 390px minus the card's padding, which caps a cell
 *  at ~26px; the same cap keeps the grid from ballooning at 1440. */
const CELL_MAX = 26;

function stepFor(score: number): number {
  if (score >= 80) return STEPS[4];
  if (score >= 60) return STEPS[3];
  if (score >= 40) return STEPS[2];
  if (score >= 20) return STEPS[1];
  return STEPS[0];
}

export function Heatmap({
  days,
  selected,
  onPick,
}: {
  days: DayStatsDay[];
  selected: string | null;
  onPick: (day: string) => void;
}) {
  if (days.length === 0) {
    return (
      <EmptyState icon="grid_view">
        No scored days yet. Each committed day drops one cell in here — the
        first column appears the morning after your first COMMIT.
      </EmptyState>
    );
  }

  /* A null score means the day had no denominator at all (§3) — it is drawn as
     an empty track, exactly like a day with no row. "Recorded nothing" and
     "scored zero" must not look the same. */
  const byDay = new Map(
    days
      .filter((d): d is typeof d & { score: number } => d.score !== null)
      .map((d) => [d.day, d]),
  );
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const last = sorted[sorted.length - 1].day;

  // Start the grid on the Monday of the first week so every column is a real
  // calendar week and the rows mean the same weekday all the way across.
  const firstDate = fromDayKey(sorted[0].day);
  const backToMonday = (firstDate.getDay() + 6) % 7;
  let cursor = addDays(sorted[0].day, -backToMonday);

  const weeks: string[][] = [];
  while (cursor <= last) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }

  const today = toDayKey(new Date());
  /* Cells are `flex: 1` so thirteen weeks fit 390px, and capped at CELL_MAX so
     1440px does not inflate them into 80px tiles. A one-year window has 53
     columns and shrinks below the cap on its own. */
  const gridWidth = weeks.length * CELL_MAX + (weeks.length - 1) * 2;

  return (
    <div style={{ maxWidth: gridWidth }}>
      <div style={{ display: "flex", gap: 2, alignItems: "stretch" }}>
        {weeks.map((week) => (
          <div
            key={week[0]}
            style={{
              flex: 1,
              minWidth: 0,
              maxWidth: CELL_MAX,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {week.map((dayKey) => {
              const cell = byDay.get(dayKey);
              const future = dayKey > today;
              const isSel = dayKey === selected;
              return (
                <button
                  key={dayKey}
                  type="button"
                  disabled={!cell}
                  aria-label={
                    cell
                      ? `${formatDay(dayKey)} — score ${cell.score}`
                      : `${formatDay(dayKey)} — no data`
                  }
                  title={
                    cell ? `${dayKey} · score ${cell.score}` : `${dayKey} · nothing recorded`
                  }
                  onClick={() => cell && onPick(dayKey)}
                  style={{
                    width: "100%",
                    aspectRatio: "1 / 1",
                    minHeight: 8,
                    padding: 0,
                    borderRadius: 3,
                    border: isSel ? `1.5px solid ${tokens.text}` : "1px solid transparent",
                    background: cell ? tokens.accent : tokens.borderDivider,
                    opacity: cell ? stepFor(cell.score) : future ? 0.25 : 0.55,
                    cursor: cell ? "pointer" : "default",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 9,
          color: tokens.textGhost,
          marginTop: 8,
        }}
      >
        <span>{formatDay(sorted[0].day)}</span>
        <span style={{ flex: 1 }} />
        <span>less</span>
        {STEPS.map((s) => (
          <span
            key={s}
            style={{
              width: 9,
              height: 9,
              borderRadius: 2,
              background: tokens.accent,
              opacity: s,
            }}
          />
        ))}
        <span>more</span>
        <span style={{ flex: 1 }} />
        <span>{formatDay(last)}</span>
      </div>
    </div>
  );
}

/** The day a heatmap cell opens: the same four numbers TODAY shows, without
 *  leaving STATS. Bottom sheet on a phone, and equally at home centred. */
export function DaySheet({
  entry,
  onClose,
  onOpenDay,
}: {
  entry: DayStatsDay;
  onClose: () => void;
  onOpenDay: (day: string) => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 950,
        background: tokens.overlay,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          background: tokens.bgCard,
          borderTop: `1px solid ${tokens.border}`,
          borderRadius: "14px 14px 0 0",
          padding: "16px 16px 28px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
            {formatDay(entry.day)}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 40,
              height: 40,
              background: "transparent",
              border: "none",
              color: tokens.textMuted,
              cursor: "pointer",
            }}
          >
            <span className="ms" style={{ fontSize: 20 }}>
              close
            </span>
          </button>
        </div>
        <div
          className="mono"
          style={{ fontSize: 30, color: tokens.accent, margin: "6px 0 2px" }}
        >
          {entry.score ?? "—"}
        </div>
        <div
          className="mono"
          style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 10.5, color: tokens.textMuted }}
        >
          <span>goals {pctText(entry.goal_pct)}</span>
          <span>habits {pctText(entry.habit_pct)}</span>
          <span>tasks {pctText(entry.task_pct)}</span>
          <span>felt {entry.subjective ?? "—"}/5</span>
        </div>
        <button
          type="button"
          onClick={() => onOpenDay(entry.day)}
          style={{
            marginTop: 14,
            minHeight: 44,
            width: "100%",
            borderRadius: 9,
            border: `1px solid ${tokens.border}`,
            background: tokens.toolBg,
            color: tokens.textSoft,
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          Open this day in TODAY
        </button>
      </div>
    </div>
  );
}
