"use client";

/**
 * DID THIS WEEK MOVE ANYTHING THAT MATTERS (PLAN.md §3.4).
 *
 * A list, not a chart, and that is the right form: five goals with two numbers
 * each is a table, and drawing it as bars would use a whole card to say what
 * five rows of text say better. (The dataviz rule — sometimes the answer is
 * not a chart.)
 *
 * `unlinked_done` is the honesty counter and it is deliberately never hidden.
 * A week where twelve tasks closed and none of them pointed at a life goal is
 * a REAL finding about the week, not a gap in the data — and it is the exact
 * number this surface exists to put in front of Konrad. It is printed even
 * when it is the only number there is.
 */

import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchDayStats, type DayGoalsWeek, type DayStats } from "../../api";
import { CARD, EmptyState, Meter, SectionLabel, formatDay } from "../goals/ui";
import { hoursText } from "./stats-math";

const HEADING = "THIS WEEK AGAINST YOUR LIFE GOALS";

/** Own query, shared key — see the note on `ScoreTrend`. */
export function GoalsWeek({ days }: { days: number }) {
  const q = useQuery({
    queryKey: ["daily-stats", days],
    queryFn: () => fetchDayStats(days),
    retry: 1,
  });

  if (q.isPending) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="hourglass_empty">Reading this week's closed tasks…</EmptyState>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="error_outline">
          Goal movement unavailable —{" "}
          {q.error instanceof Error ? q.error.message : String(q.error)}
        </EmptyState>
      </>
    );
  }
  return <GoalsWeekView stats={q.data} />;
}

export function GoalsWeekView({ stats }: { stats: DayStats }) {
  const week: DayGoalsWeek = stats.goals_week;

  if (week.total_done === 0) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="flag">
          Nothing closed between {formatDay(week.week_start)} and{" "}
          {formatDay(week.week_end)}. A task closed against a life goal shows up
          here the moment it is ticked.
        </EmptyState>
      </>
    );
  }

  /* One shared scale so a goal with 6 closed tasks draws six times the bar of
     a goal with 1 — per-row normalisation would make every goal look equal. */
  const scale = Math.max(...week.moved.map((m) => m.tasks_done), 1);
  const linked = week.total_done - week.unlinked_done;
  const linkedPct = Math.round((linked / week.total_done) * 100);

  return (
    <>
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            {formatDay(week.week_start)} – {formatDay(week.week_end)}
          </span>
        }
      >
        {HEADING}
      </SectionLabel>
      <div style={{ ...CARD, padding: "14px 14px 11px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 11 }}>
          <span
            className="mono"
            style={{
              fontSize: 28,
              lineHeight: 1,
              fontWeight: 500,
              color: linkedPct >= 50 ? tokens.ok : tokens.warn,
            }}
          >
            {linkedPct}%
          </span>
          <span style={{ fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.5 }}>
            of the {week.total_done} {week.total_done === 1 ? "task" : "tasks"} you closed
            this week served a life goal.
          </span>
        </div>

        {/* TWO LINES PER GOAL, deliberately. A single row (title | horizon |
            meter | counts) measured 92px of title at a 420px viewport — about
            ten characters of "100k subscribers on TheSkyLab" — and the title
            is the only part of the row that identifies which goal moved. The
            title gets the full width; the numbers share the line beneath it,
            which reads identically at 390px and at 1440. */}
        {week.moved.map((m, i) => (
          <div key={m.goal_id} style={{ paddingTop: i === 0 ? 0 : 9 }}>
            <div
              style={{
                fontSize: 12,
                color: tokens.textSoft,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={m.title}
            >
              {m.title}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4 }}>
              <span
                className="mono"
                style={{ fontSize: 9, color: tokens.textGhost, flex: "none", width: 62 }}
              >
                {m.horizon}
              </span>
              <Meter value={m.tasks_done / scale} color={tokens.accent} height={6} />
              <span
                className="mono"
                style={{ fontSize: 10.5, color: tokens.textMuted, flex: "none", width: 78, textAlign: "right" }}
              >
                {m.tasks_done} · {hoursText(m.minutes)}
              </span>
            </div>
          </div>
        ))}

        {/* The honesty counter. Printed whether or not it is flattering. */}
        <div
          style={{
            marginTop: 11,
            paddingTop: 9,
            borderTop: `1px solid ${tokens.borderDivider}`,
            fontSize: 11,
            color: week.unlinked_done > 0 ? tokens.textMuted : tokens.textGhost,
            lineHeight: 1.5,
          }}
        >
          {week.unlinked_done === 0 ? (
            <>Every task closed this week pointed at a goal.</>
          ) : (
            <>
              <strong style={{ fontWeight: 500, color: tokens.warn }}>
                {week.unlinked_done}
              </strong>{" "}
              closed {week.unlinked_done === 1 ? "task pointed" : "tasks pointed"} at no
              goal at all. Link them from the task drawer and this week starts
              counting.
            </>
          )}
        </div>
      </div>
    </>
  );
}
