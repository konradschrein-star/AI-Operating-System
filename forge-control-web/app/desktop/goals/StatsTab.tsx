"use client";

/**
 * STATS — the part Notion did badly (§0.4: "accurate, inert").
 *
 * Order is an argument. SAID VS DONE is first and biggest, because §1 says it
 * is the only scoreboard; everything under it is diagnosis. Every panel here
 * reads a number the server computed — nothing on this tab recomputes a score
 * (§3), so the heatmap, TODAY's ring and the trend line cannot disagree.
 */

import { useMemo, useState } from "react";
import { tokens } from "../../tokens";
import type { DayStats, DayStatsHabit } from "../../api";
import { Heatmap, DaySheet } from "./Heatmap";
import { addDays } from "./quick-add";
import { movingAverage } from "../stats/stats-math";
import {
  Bars,
  CARD,
  EmptyState,
  Line,
  Meter,
  SectionLabel,
  chipStyle,
  formatDay,
} from "./ui";

type HabitSort = "weakest" | "strongest";

export function StatsTab({
  stats,
  loading,
  windowDays,
  narrow,
  onWindow,
  onOpenDay,
}: {
  stats: DayStats | undefined;
  loading: boolean;
  windowDays: number;
  /** Below 900px everything stacks; above it the two charts pair up so the
   *  tab is a page rather than a mile-long ribbon. */
  narrow: boolean;
  onWindow: (days: number) => void;
  onOpenDay: (day: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [habitSort, setHabitSort] = useState<HabitSort>("weakest");

  const days = stats?.days ?? [];
  /* A day whose score is null had no denominator at all (§3) — it is left OUT
     of the trend rather than plotted as a zero, which is the difference
     between "did nothing" and "recorded nothing". */
  const scoredDays = useMemo(
    () =>
      days
        .filter((d): d is typeof d & { score: number } => d.score !== null)
        .sort((a, b) => a.day.localeCompare(b.day)),
    [days],
  );
  const habits = useMemo(() => {
    const rows = [...(stats?.habits ?? [])];
    rows.sort((a, b) =>
      habitSort === "weakest" ? a.rate30 - b.rate30 : b.rate30 - a.rate30,
    );
    return rows;
  }, [stats, habitSort]);

  const pickedEntry = picked ? days.find((d) => d.day === picked) ?? null : null;

  if (!stats && loading) {
    return <EmptyState icon="hourglass_empty">Loading {windowDays} days…</EmptyState>;
  }
  if (!stats) {
    return (
      <EmptyState icon="insights">
        No stats yet — they fill in as days are committed and ticked. The window
        below is {windowDays} days.
      </EmptyState>
    );
  }

  const said = stats.said_vs_done;
  const rateTone =
    said.rate === null
      ? tokens.textFaint
      : said.rate >= 0.8
        ? tokens.ok
        : said.rate >= 0.5
          ? tokens.accent
          : tokens.warn;
  const doneByDay = stats.tasks.done_by_day;
  const avg7 =
    doneByDay.length === 0
      ? 0
      : doneByDay.slice(-7).reduce((n, d) => n + d.n, 0) /
        Math.min(7, doneByDay.length);

  return (
    <div>
      <div style={{ display: "flex", gap: 7, marginBottom: 12, flexWrap: "wrap" }}>
        {[30, 90, 365].map((d) => (
          <button
            key={d}
            type="button"
            style={chipStyle(windowDays === d)}
            onClick={() => onWindow(d)}
          >
            {d === 365 ? "1 year" : `${d} days`}
          </button>
        ))}
      </div>

      {/* 1 — SAID VS DONE. Nothing on this surface matters as much. */}
      <div style={{ ...CARD, padding: "16px 16px 15px" }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", color: tokens.textFaint }}>
          SAID VS DONE · {windowDays} DAYS
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginTop: 8 }}>
          <span
            className="mono"
            style={{
              /* The dash is the "no denominator" case — printed smaller so a
                 44px em dash doesn't read as a broken loading bar. */
              fontSize: said.rate === null ? 26 : 44,
              lineHeight: 1,
              fontWeight: 500,
              color: rateTone,
            }}
          >
            {said.rate === null ? "—" : `${Math.round(said.rate * 100)}%`}
          </span>
          <span
            style={{
              fontSize: 12,
              color: tokens.textMuted,
              lineHeight: 1.5,
              paddingBottom: 3,
            }}
          >
            of the goals you committed to,
            <br />
            you actually did.
          </span>
        </div>
        <div
          className="mono"
          style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 10.5, color: tokens.textMuted, marginTop: 11 }}
        >
          <span>{said.committed} committed</span>
          <span style={{ color: tokens.ok }}>{said.done} done</span>
          <span style={{ color: said.abandoned > 0 ? tokens.warn : tokens.textGhost }}>
            {said.abandoned} abandoned
          </span>
          <span style={{ color: tokens.textGhost }}>{said.open} still open</span>
          <span style={{ flex: 1 }} />
          <span>
            streak {stats.streak.current}d · best {stats.streak.best}d
          </span>
        </div>
        {said.rate === null && (
          <div style={{ fontSize: 11.5, color: tokens.textGhost, marginTop: 9, lineHeight: 1.5 }}>
            Nothing committed in this window yet. Tap COMMIT THE DAY on TODAY and
            this becomes the number you live by.
          </div>
        )}
      </div>

      {/* 2 — heatmap */}
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            tap a day
          </span>
        }
      >
        DAY SCORE · {days.length} DAYS
      </SectionLabel>
      <div style={{ ...CARD, padding: "13px 13px 10px" }}>
        <Heatmap days={days} selected={picked} onPick={setPicked} />
      </div>

      {/* 3 — habits */}
      <SectionLabel
        right={
          <button
            type="button"
            className="mono"
            onClick={() =>
              setHabitSort((s) => (s === "weakest" ? "strongest" : "weakest"))
            }
            style={{
              background: "transparent",
              border: "none",
              color: tokens.textMuted,
              fontSize: 9.5,
              cursor: "pointer",
              minHeight: 24,
            }}
          >
            {habitSort === "weakest" ? "weakest first ↑" : "strongest first ↓"}
          </button>
        }
      >
        HABITS · 30-DAY RATE
      </SectionLabel>
      {habits.length === 0 ? (
        <EmptyState icon="checklist">
          No habit history yet — every chip you tap on TODAY writes a row here.
        </EmptyState>
      ) : (
        <div
          style={{
            ...CARD,
            overflow: "hidden",
            /* Eighteen habits is a long single column on a wide screen, and a
               30-cell sparkline stretched to 1200px reads as dashes rather
               than a week rhythm. Two columns at desktop, one on a phone. */
            ...(narrow
              ? {}
              : { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }),
          }}
        >
          {habits.map((h, i) => (
            <HabitStatRow
              key={h.key}
              habit={h}
              to={stats.window.to}
              divider={!narrow && i % 2 === 1}
              isLast={i >= habits.length - (narrow ? 1 : 2)}
            />
          ))}
        </div>
      )}

      {/* 4 and 5 — output and trend. Same window, same x-axis; side by side
          wherever there is room to read them against each other. */}
      <div
        style={{
          display: narrow ? "block" : "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          columnGap: 18,
          alignItems: "start",
        }}
      >
      <div>
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            {avg7.toFixed(1)}/day over the last 7
          </span>
        }
      >
        OUTPUT · TASKS COMPLETED
      </SectionLabel>
      {doneByDay.length === 0 ? (
        <EmptyState icon="bar_chart">
          No completed tasks in this window. Every tick on TODAY raises a bar
          here.
        </EmptyState>
      ) : (
        <div style={{ ...CARD, padding: "14px 14px 10px" }}>
          <Bars
            data={doneByDay.map((d) => ({
              key: d.day,
              value: d.n,
              label: `${d.day} — ${d.n} done`,
            }))}
            color={tokens.ok}
            markerAt={avg7}
            markerLabel={`7d avg ${avg7.toFixed(1)}`}
          />
          <div
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 9,
              color: tokens.textGhost,
              paddingTop: 7,
            }}
          >
            <span>{formatDay(doneByDay[0].day)}</span>
            <span>
              {stats.tasks.open} open · {stats.tasks.stale} stale
            </span>
            <span>{formatDay(doneByDay[doneByDay.length - 1].day)}</span>
          </div>
        </div>
      )}
      </div>

      <div>
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            solid = day · dashed = 7-day average
          </span>
        }
      >
        SCORE TREND
      </SectionLabel>
      {scoredDays.length < 2 ? (
        <EmptyState icon="show_chart">
          Two scored days draw the first line. Come back tomorrow.
        </EmptyState>
      ) : (
        <div style={{ ...CARD, padding: "14px 14px 10px" }}>
          <div style={{ position: "relative", height: 90 }}>
            <Line values={scoredDays.map((d) => d.score)} color={tokens.accent} />
            <Line
              values={movingAverage(scoredDays.map((d) => d.score), 7)}
              color={tokens.textMuted}
              dashed
            />
          </div>
          <div
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 9,
              color: tokens.textGhost,
              paddingTop: 7,
            }}
          >
            <span>{formatDay(scoredDays[0].day)}</span>
            <span>peak {Math.max(...scoredDays.map((d) => d.score))}</span>
            <span>{formatDay(scoredDays[scoredDays.length - 1].day)}</span>
          </div>
        </div>
      )}
      </div>
      </div>

      {pickedEntry && (
        <DaySheet
          entry={pickedEntry}
          onClose={() => setPicked(null)}
          onOpenDay={(d) => {
            setPicked(null);
            onOpenDay(d);
          }}
        />
      )}
    </div>
  );
}

const SPARK_DAYS = 30;

/**
 * One habit, three lines — the icon-and-table view he explicitly asked to
 * keep, folded so it never needs a sideways scroll.
 *
 * The sparkline is real per-day history (`ticks30` from the stats route), not
 * a shape derived from the rate: thirty cells, oldest on the left, filled on
 * the days it was actually ticked. A "sparkline" synthesised from one ratio
 * would be decoration pretending to be evidence.
 */
function HabitStatRow({
  habit,
  to,
  isLast,
  divider,
}: {
  habit: DayStatsHabit;
  /** Last day of the stats window — the sparkline's right-hand edge. */
  to: string;
  isLast: boolean;
  /** Rule on the left edge, for the right-hand column of the desktop grid. */
  divider?: boolean;
}) {
  const tone =
    habit.rate30 >= 0.8 ? tokens.ok : habit.rate30 >= 0.4 ? tokens.accent : tokens.warn;
  const ticked = new Set(habit.ticks30);
  const cells = Array.from({ length: SPARK_DAYS }, (_, i) =>
    addDays(to, -(SPARK_DAYS - 1 - i)),
  );
  return (
    <div
      style={{
        padding: "10px 13px",
        borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
        borderLeft: divider ? `1px solid ${tokens.borderDivider}` : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span className="ms" style={{ fontSize: 18, color: tone, flex: "none" }}>
          {habit.icon}
        </span>
        <span
          style={{
            fontSize: 12.5,
            color: tokens.textSoft,
            flex: 1,
            minWidth: 0,
            wordBreak: "break-word",
          }}
        >
          {habit.label}
        </span>
        <span className="mono" style={{ fontSize: 12, color: tone, flex: "none" }}>
          {Math.round(habit.rate30 * 100)}%
        </span>
      </div>
      <div
        style={{ display: "flex", gap: 1.5, marginTop: 8, height: 13, maxWidth: 340 }}
        title={`last ${SPARK_DAYS} days — ${habit.ticks30.length} ticked`}
      >
        {cells.map((d) => (
          <span
            key={d}
            style={{
              flex: 1,
              minWidth: 0,
              borderRadius: 1.5,
              background: ticked.has(d) ? tone : tokens.borderDivider,
              opacity: ticked.has(d) ? 0.9 : 1,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 7 }}>
        <Meter value={habit.rate30} color={tone} />
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textGhost, flex: "none" }}
        >
          streak {habit.streak} · best {habit.best}
        </span>
      </div>
    </div>
  );
}

/**
 * Trailing moving average — MOVED to `../stats/stats-math.ts`, where it is
 * covered by `stats-math.test.ts`, and re-exported here so existing importers
 * keep working (PLAN.md §5: "extract the primitives, delete nothing yet").
 *
 * This tab is unmounted since the week board shipped. The live `StatsPanel`
 * must not import from a file that is queued for deletion, so the definition
 * moved and this line is the forwarding address.
 */
export { movingAverage } from "../stats/stats-math";
