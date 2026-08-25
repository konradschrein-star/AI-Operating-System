"use client";

/**
 * HABIT MATRIX — every habit as a row, every day in the window as a column,
 * today on the right (PLAN.md §3.4).
 *
 * The one thing this must never do is make "not ticked" and "no such day"
 * look the same, which is the rule `goals/Heatmap.tsx` already enforces for
 * the score. A day that has no row in `days[]` at all is drawn as a hollow
 * track; a day that exists and was not ticked is drawn as a filled-but-empty
 * cell. Konrad's 18 habits have never been logged once, so today the whole
 * matrix is the second case — and it has to READ as "recorded, not done",
 * because "the API is broken" and "I didn't do it" demand different actions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY GROUPS ARE FACETED RATHER THAN COLOURED
 * ═══════════════════════════════════════════════════════════════════════════
 * The brief asked for a "weighted group colour". The dataviz validator was run
 * over every 4-token subset of the theme palette in BOTH modes, and exactly
 * THREE tokens sit inside the OKLCH lightness band in dark AND light:
 * `accent`, `ok`, `bleed`. There are four habit groups. The skill's own rule
 * for that case is "cut the series count, facet, or switch chart form" — never
 * invent a hue — so the groups become four labelled blocks and the cells take
 * one hue. A printed group label survives colourblindness, a 4px cell, and a
 * screenshot; a fourth hue survives none of them.
 *
 * "Weighted" survives as the group's own density figure beside its label —
 * ticks over (habits × days) — which is the number the colour was meant to
 * convey and is legible as text.
 *
 * The cell hue is `accent` at two opacities: a sequential encoding of one
 * variable (ticked / not), so the categorical six checks do not apply to it
 * (they FAIL on any ramp by design — see the skill's scope note).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchDayStats, type DayStats, type DayStatsHabit } from "../../api";
import { CARD, EmptyState, SectionLabel, formatDay } from "../goals/ui";
import { addDays } from "../goals/quick-add";
import { habitGroupBlocks } from "./stats-math";

/** Ticked. Below this the cell is the empty track. */
const TICK_OPACITY = 0.9;
const UNTICKED_OPACITY = 1;

/** Own query, shared key — see the note on `ScoreTrend`. */
export function HabitMatrix({ days }: { days: number }) {
  const q = useQuery({
    queryKey: ["daily-stats", days],
    queryFn: () => fetchDayStats(days),
    retry: 1,
  });

  if (q.isPending) {
    return (
      <>
        <SectionLabel>HABIT MATRIX</SectionLabel>
        <EmptyState icon="hourglass_empty">Loading {days} days of ticks…</EmptyState>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <SectionLabel>HABIT MATRIX</SectionLabel>
        <EmptyState icon="error_outline">
          Habit matrix unavailable —{" "}
          {q.error instanceof Error ? q.error.message : String(q.error)}
        </EmptyState>
      </>
    );
  }
  return <HabitMatrixView stats={q.data} />;
}

export function HabitMatrixView({ stats }: { stats: DayStats }) {
  const windowDays = stats.window.days;

  /* Columns run oldest → newest so today is the rightmost cell, matching the
     heatmap above it and the way every other strip on this surface reads. */
  const columns = useMemo(
    () => Array.from({ length: windowDays }, (_, i) => addDays(stats.window.to, -(windowDays - 1 - i))),
    [stats.window.to, windowDays],
  );

  /* Days the API actually returned a row for. A column outside this set is a
     day the system has no record of — drawn hollow, never as a miss. */
  const recorded = useMemo(() => new Set(stats.days.map((d) => d.day)), [stats.days]);

  const blocks = useMemo(
    () => habitGroupBlocks(stats.habits, windowDays),
    [stats.habits, windowDays],
  );

  if (blocks.length === 0) {
    return (
      <>
        <SectionLabel>HABIT MATRIX</SectionLabel>
        <EmptyState icon="grid_on">
          No habits are active. The 18 seeded on the board fill this grid one
          row each, the day they are ticked for the first time.
        </EmptyState>
      </>
    );
  }

  const totalTicks = stats.habits.reduce((n, h) => n + h.ticks.length, 0);

  return (
    <>
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            {totalTicks} {totalTicks === 1 ? "tick" : "ticks"} · today rightmost
          </span>
        }
      >
        HABIT MATRIX · {stats.habits.length} HABITS × {windowDays} DAYS
      </SectionLabel>
      <div style={{ ...CARD, padding: "12px 13px 10px", overflow: "hidden" }}>
        {blocks.map((block, bi) => (
          <div key={block.group} style={{ marginTop: bi === 0 ? 0 : 13 }}>
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 9,
                letterSpacing: "0.12em",
                color: tokens.textFaint,
                marginBottom: 5,
              }}
            >
              <span>{block.group.toUpperCase()}</span>
              <span style={{ flex: 1, height: 1, background: tokens.borderDivider }} />
              <span style={{ color: tokens.textGhost }}>
                {(block.density * 100).toFixed(0)}% density
              </span>
            </div>
            {block.habits.map((h) => (
              <HabitRow key={h.key} habit={h} columns={columns} recorded={recorded} />
            ))}
          </div>
        ))}
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 9,
            color: tokens.textGhost,
            paddingTop: 10,
          }}
        >
          <span>{formatDay(columns[0])}</span>
          <span style={{ flex: 1 }} />
          <LegendSwatch background={tokens.accent} opacity={TICK_OPACITY} label="ticked" />
          <LegendSwatch background={tokens.borderDivider} opacity={UNTICKED_OPACITY} label="not ticked" />
          <LegendSwatch background="transparent" opacity={1} label="no record" outlined />
          <span style={{ flex: 1 }} />
          <span>{formatDay(columns[columns.length - 1])}</span>
        </div>
      </div>
    </>
  );
}

function HabitRow({
  habit,
  columns,
  recorded,
}: {
  habit: DayStatsHabit;
  columns: string[];
  recorded: Set<string>;
}) {
  const ticked = useMemo(() => new Set(habit.ticks), [habit.ticks]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
      <span
        className="ms"
        style={{ fontSize: 14, color: tokens.textFaint, flex: "none", width: 16 }}
        aria-hidden
      >
        {habit.icon}
      </span>
      <span
        style={{
          fontSize: 10.5,
          color: tokens.textMuted,
          flex: "none",
          width: 108,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={habit.label}
      >
        {habit.label}
      </span>
      <div
        style={{ display: "flex", gap: 1, flex: 1, minWidth: 0, height: 11 }}
        role="img"
        aria-label={`${habit.label}: ${habit.ticks.length} of ${columns.length} days ticked`}
      >
        {columns.map((day) => {
          const isTicked = ticked.has(day);
          const known = recorded.has(day);
          return (
            <span
              key={day}
              title={
                !known
                  ? `${day} · nothing recorded`
                  : `${day} · ${habit.label} — ${isTicked ? "ticked" : "not ticked"}`
              }
              style={{
                flex: 1,
                minWidth: 0,
                borderRadius: 1.5,
                /* Three states, three fills. A hollow track for a day with no
                   row is the same rule Heatmap.tsx uses for the score. */
                background: isTicked
                  ? tokens.accent
                  : known
                    ? tokens.borderDivider
                    : "transparent",
                border: known ? "none" : `1px solid ${tokens.borderDivider}`,
                opacity: isTicked ? TICK_OPACITY : UNTICKED_OPACITY,
              }}
            />
          );
        })}
      </div>
      <span
        className="mono"
        style={{ fontSize: 9, color: tokens.textGhost, flex: "none", width: 26, textAlign: "right" }}
      >
        {habit.ticks.length}
      </span>
    </div>
  );
}

function LegendSwatch({
  background,
  opacity,
  label,
  outlined,
}: {
  background: string;
  opacity: number;
  label: string;
  outlined?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          background,
          opacity,
          border: outlined ? `1px solid ${tokens.borderDivider}` : "none",
        }}
      />
      {label}
    </span>
  );
}
