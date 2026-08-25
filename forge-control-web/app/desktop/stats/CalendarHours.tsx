"use client";

/**
 * BOOKED VS WORKED — the calendar against the board (PLAN.md §3.4).
 *
 * Two numbers per week that mean different things: hours he BLOCKED OUT on
 * Google Calendar, and hours he actually closed work in. The gap between them
 * is the interesting quantity — a week that books 30 and works 8 is a
 * different failure from a week that books 4 and works 12.
 *
 * Same unit, so ONE axis and two bars per week, never two scales. The area
 * split underneath is a TABLE rather than a stacked chart: `area` is free text
 * on `day_tasks`, so the class count is unbounded, and past ~7 colour classes
 * adjacent segments stop being distinguishable at all. `foldAreas` keeps the
 * top rows and REPORTS the size of the tail rather than truncating it
 * silently.
 *
 * Its own endpoint and its own query, deliberately (PLAN.md §5): a 502 from
 * Google blanks this tile and nothing else. `week.error` is rendered as the
 * message Google returned — a zeroed week that looks like a quiet week is the
 * exact bug that made the calendar read as "not connected" for weeks.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  fetchCalendarStats,
  type DayCalendarStatsResponse,
  type DayCalendarStatsWeek,
} from "../../api";
import { CARD, EmptyState, Meter, SectionLabel, formatDay } from "../goals/ui";
import { foldAreas, hoursText } from "./stats-math";

/** Areas kept before the tail folds into "Other" — the ~7-class ceiling. */
const AREAS_KEPT = 6;
const HEADING = "BOOKED VS WORKED";

/**
 * The ONLY tile on this panel that talks to Google. Its own endpoint and its
 * own query key (PLAN.md §5) precisely so a Google outage cannot blank the
 * five tiles that read nothing but Postgres.
 */
export function CalendarHours({ weeks }: { weeks: number }) {
  const q = useQuery({
    queryKey: ["daily-stats-calendar", weeks],
    queryFn: () => fetchCalendarStats(weeks),
    retry: 1,
  });

  if (q.isPending) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="hourglass_empty">Reading {weeks} weeks of calendar…</EmptyState>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="error_outline">
          Calendar hours unavailable —{" "}
          {q.error instanceof Error ? q.error.message : String(q.error)}. The
          rest of this panel does not read Google and is unaffected.
        </EmptyState>
      </>
    );
  }
  return <CalendarHoursView data={q.data} />;
}

export function CalendarHoursView({ data }: { data: DayCalendarStatsResponse }) {
  if (data.weeks.length === 0) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="calendar_month">
          No calendar weeks returned. Blocks on Google Calendar and tasks closed
          on the board fill both bars here.
        </EmptyState>
      </>
    );
  }

  /* One shared scale across every week, so a bar in week 1 is comparable to a
     bar in week 2 by eye. Per-week normalisation would make a 4h week and a
     40h week draw identically. */
  const scale = Math.max(
    ...data.weeks.flatMap((w) => [w.booked_min, w.worked_min]),
    60,
  );

  return (
    <>
      <SectionLabel right={<Legend />}>
        {HEADING} · {data.weeks.length}{" "}
        {data.weeks.length === 1 ? "WEEK" : "WEEKS"}
      </SectionLabel>
      <div style={{ ...CARD, padding: "14px 14px 11px" }}>
        {data.weeks.map((week, i) => (
          <WeekRow key={week.week_start} week={week} scale={scale} first={i === 0} />
        ))}
      </div>
    </>
  );
}

function WeekRow({
  week,
  scale,
  first,
}: {
  week: DayCalendarStatsWeek;
  scale: number;
  first: boolean;
}) {
  const areas = useMemo(() => foldAreas(week.by_area, AREAS_KEPT), [week.by_area]);

  return (
    <div
      style={{
        paddingTop: first ? 0 : 12,
        marginTop: first ? 0 : 12,
        borderTop: first ? "none" : `1px solid ${tokens.borderDivider}`,
      }}
    >
      <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
        <span style={{ color: tokens.textFaint }}>
          {formatDay(week.week_start)} – {formatDay(week.week_end)}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: tokens.textGhost }}>
          {week.events} {week.events === 1 ? "event" : "events"} · {week.tasks_done} done
        </span>
      </div>

      {/* An errored week prints Google's message and NO bars. A zeroed week
          that looks like a quiet week is worse than a visible failure. */}
      {week.error !== null ? (
        <div
          style={{
            marginTop: 8,
            padding: "9px 11px",
            borderRadius: 8,
            border: `1px solid ${tokens.borderDivider}`,
            background: tokens.toolBg,
            fontSize: 11.5,
            color: tokens.warn,
            lineHeight: 1.5,
          }}
        >
          <span className="ms" style={{ fontSize: 14, verticalAlign: "-2px", marginRight: 6 }}>
            error_outline
          </span>
          Calendar unavailable for this week — {week.error}
        </div>
      ) : (
        <>
          <BarLine
            label="booked"
            minutes={week.booked_min}
            scale={scale}
            color={tokens.accent}
          />
          <BarLine
            label="worked"
            minutes={week.worked_min}
            scale={scale}
            color={tokens.ok}
          />
          {areas.rows.length > 0 && (
            <div style={{ marginTop: 9 }}>
              {areas.rows.map((a) => (
                <div
                  key={a.area}
                  className="mono"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 9.5,
                    color: tokens.textGhost,
                    marginBottom: 3,
                  }}
                >
                  <span
                    style={{
                      flex: "none",
                      width: 92,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={a.area}
                  >
                    {a.area}
                  </span>
                  <Meter value={a.booked_min / scale} color={tokens.accent} height={4} />
                  <Meter value={a.worked_min / scale} color={tokens.ok} height={4} />
                  <span style={{ flex: "none", width: 92, textAlign: "right" }}>
                    {hoursText(a.booked_min)} / {hoursText(a.worked_min)}
                  </span>
                </div>
              ))}
              {/* Never a silent cap: if rows were folded, say how many. */}
              {areas.folded > 0 && (
                <div className="mono" style={{ fontSize: 9, color: tokens.textGhost, paddingTop: 2 }}>
                  {areas.folded} smaller {areas.folded === 1 ? "area" : "areas"} folded into
                  Other
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One measure, direct-labelled — the value never lives only in a tooltip. */
function BarLine({
  label,
  minutes,
  scale,
  color,
}: {
  label: string;
  minutes: number;
  scale: number;
  color: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 7 }}>
      <span
        className="mono"
        style={{ fontSize: 9.5, color: tokens.textGhost, flex: "none", width: 46 }}
      >
        {label}
      </span>
      <Meter value={minutes / scale} color={color} height={7} />
      <span
        className="mono"
        style={{ fontSize: 11, color: tokens.textMuted, flex: "none", width: 52, textAlign: "right" }}
      >
        {hoursText(minutes)}
      </span>
    </div>
  );
}

function Legend() {
  return (
    <span
      className="mono"
      style={{ display: "inline-flex", gap: 10, fontSize: 9, color: tokens.textGhost }}
    >
      <Swatch color={tokens.accent} label="booked" />
      <Swatch color={tokens.ok} label="worked" />
    </span>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}
