"use client";

/**
 * ONE stats panel, mounted in BOTH the journal and the goals/tasks surface
 * (PLAN.md §3.4). Not two components that agree today and drift by Friday —
 * the whole point of the shared panel is that a number cannot mean one thing
 * on JOURNAL and another on GOALS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT `mount` DOES AND DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 * It reorders the tiles; it never changes what a tile says. JOURNAL opens on
 * the day and reads backwards, so the trend and the felt-rating correlation
 * lead. GOALS is about whether the week moved anything, so `GoalsWeek` and the
 * calendar lead. Same components, same queries, same arithmetic, different
 * reading order — a tile that computed differently per mount would be exactly
 * the drift this file exists to prevent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE FILTER ROW, ABOVE EVERYTHING IT SCOPES
 * ═══════════════════════════════════════════════════════════════════════════
 * The 30/90 toggle sits above the tiles and scopes all of them, rather than
 * each card carrying its own window control. Per-card filters make two cards
 * silently describe two different time spans, which is how a dashboard starts
 * lying without a single wrong number in it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TILE FAILS ALONE
 * ═══════════════════════════════════════════════════════════════════════════
 * There is no panel-level query, no panel-level loading state and no
 * panel-level error (PLAN.md §3.6). Each tile owns its `useQuery`, its
 * spinner and its own error sentence. The five Postgres tiles share the key
 * `["daily-stats", days]` so React Query serves them from ONE fetch; the
 * calendar tile is on `["daily-stats-calendar", weeks]` and reaches Google, so
 * a Google outage greys one card and leaves the other five reading.
 *
 * This panel does NOT mount itself anywhere. F2 (journal) and F4 (goals) do
 * that; a component that both renders and routes itself cannot be placed twice.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchDayStats } from "../../api";
import { Heatmap, DaySheet } from "../goals/Heatmap";
import { CARD, EmptyState, SectionLabel, chipStyle } from "../goals/ui";
import { ScoreTrend } from "./ScoreTrend";
import { HabitMatrix } from "./HabitMatrix";
import { HabitFelt } from "./HabitFelt";
import { CalendarHours } from "./CalendarHours";
import { GoalsWeek } from "./GoalsWeek";

/** The two windows Konrad actually reasons in. 365 is deliberately absent:
 *  the felt-rating correlation needs ~60 rated days, and offering a year
 *  before there are 60 days of anything advertises a chart that cannot exist
 *  yet. Add it when the data reaches it. */
const WINDOWS = [30, 90] as const;
export type StatsWindow = (typeof WINDOWS)[number];

/** Calendar weeks are their own axis: booked-vs-worked over 90 days is 13
 *  rows nobody reads. Two weeks is the horizon the question lives on. */
const CALENDAR_WEEKS = 2;

export interface StatsPanelProps {
  /** Which surface is rendering it — reorders the tiles, nothing else. */
  mount: "journal" | "goals";
  /**
   * The day the host surface is showing, `YYYY-MM-DD`. Optional: only the
   * heatmap uses it, to pre-select that day's cell so JOURNAL's stats open on
   * the day being read rather than on nothing. GOALS passes nothing.
   */
  day?: string;
}

export function StatsPanel({ mount, day }: StatsPanelProps) {
  const [days, setDays] = useState<StatsWindow>(30);

  const tiles =
    mount === "journal"
      ? (
          <>
            <ScoreTrend days={days} />
            <ScoreHeatmap days={days} day={day} />
            <HabitFelt days={days} />
            <HabitMatrix days={days} />
            <GoalsWeek days={days} />
            <CalendarHours weeks={CALENDAR_WEEKS} />
          </>
        )
      : (
          <>
            <GoalsWeek days={days} />
            <CalendarHours weeks={CALENDAR_WEEKS} />
            <ScoreTrend days={days} />
            <ScoreHeatmap days={days} day={day} />
            <HabitFelt days={days} />
            <HabitMatrix days={days} />
          </>
        );

  return (
    <div>
      <div style={{ display: "flex", gap: 7, marginBottom: 4, flexWrap: "wrap", alignItems: "center" }}>
        {WINDOWS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={days === d}
            style={chipStyle(days === d)}
            onClick={() => setDays(d)}
          >
            {d} days
          </button>
        ))}
        <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, marginLeft: 4 }}>
          scopes every card below
        </span>
      </div>
      {tiles}
    </div>
  );
}

/**
 * The score heatmap — `goals/Heatmap.tsx` REUSED AS-IS, deliberately and
 * without a wrapper prop of its own (PLAN.md §3.4).
 *
 * It already draws the distinction this whole surface is built on: a day with
 * no row is an empty track, never a zero-score cell. Re-implementing that here
 * would mean two components disagreeing about what "nothing recorded" looks
 * like, which is the precise failure the week board was rebuilt to fix. Its
 * `DaySheet` drill-in comes along with it.
 *
 * The one thing this wrapper adds is its own query and its own error, because
 * the panel has none to lend it.
 */
function ScoreHeatmap({ days, day }: { days: StatsWindow; day?: string }) {
  const [picked, setPicked] = useState<string | null>(day ?? null);
  const q = useQuery({
    queryKey: ["daily-stats", days],
    queryFn: () => fetchDayStats(days),
    retry: 1,
  });

  if (q.isPending) {
    return (
      <>
        <SectionLabel>DAY SCORE</SectionLabel>
        <EmptyState icon="hourglass_empty">Loading {days} days…</EmptyState>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <SectionLabel>DAY SCORE</SectionLabel>
        <EmptyState icon="error_outline">
          Day-score heatmap unavailable —{" "}
          {q.error instanceof Error ? q.error.message : String(q.error)}
        </EmptyState>
      </>
    );
  }

  const entry = picked ? q.data.days.find((d) => d.day === picked) ?? null : null;

  return (
    <>
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            tap a day
          </span>
        }
      >
        DAY SCORE · {q.data.days.length} DAYS
      </SectionLabel>
      <div style={{ ...CARD, padding: "13px 13px 10px" }}>
        <Heatmap days={q.data.days} selected={picked} onPick={setPicked} />
      </div>
      {entry && (
        /* `DaySheet` wants a way to open the day in TODAY. This panel is
           mounted inside two different surfaces and owns no router, so the
           drill-in closes instead of navigating — a dead "open" button would
           be worse than none. F2/F4 can lift this when they mount the panel. */
        <DaySheet entry={entry} onClose={() => setPicked(null)} onOpenDay={() => setPicked(null)} />
      )}
    </>
  );
}
