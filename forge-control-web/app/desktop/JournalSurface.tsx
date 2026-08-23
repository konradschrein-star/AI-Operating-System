"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { JournalRetrospectivePane } from "./journal/JournalRetrospectivePane";
import { MentorAgentDeck } from "./journal/MentorAgentDeck";
import { MentorCronSwitch } from "./journal/MentorCronSwitch";
import { useNarrowViewport } from "./_ui/ResizableSplit";

interface MentorDayMetric {
  day: string;
  committed: number;
  completed: number;
  notes: string | null;
}

interface MentorMetricsResponse {
  days: MentorDayMetric[];
  streak: number;
}

async function fetchMentorMetrics(): Promise<MentorMetricsResponse> {
  const res = await fetch("/api/proxy/mentor/metrics", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on /mentor/metrics`);
  }
  return (await res.json()) as MentorMetricsResponse;
}

function getBerlinToday(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function offsetDay(baseDay: string, deltaDays: number): string {
  const [y, m, d] = baseDay.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function formatDayHeader(dayStr: string, todayStr: string): string {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const formatted = dt.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  if (dayStr === todayStr) {
    return `${formatted} (Today)`;
  }
  const yesterdayStr = offsetDay(todayStr, -1);
  if (dayStr === yesterdayStr) {
    return `${formatted} (Yesterday)`;
  }
  return formatted;
}

export function JournalSurface() {
  const todayStr = useMemo(() => getBerlinToday(), []);
  const [selectedDay, setSelectedDay] = useState<string>(todayStr);
  const [narrowTab, setNarrowTab] = useState<"retro" | "mentor">("retro");
  const isNarrow = useNarrowViewport(960);

  // Mentor Metrics Query
  const { data: metricsData, isLoading: isMetricsLoading } = useQuery<
    MentorMetricsResponse,
    Error
  >({
    queryKey: ["mentor", "metrics"],
    queryFn: fetchMentorMetrics,
    staleTime: 30_000,
  });

  const isToday = selectedDay === todayStr;
  const isFuture = selectedDay > todayStr;

  const handlePrevDay = () => {
    setSelectedDay((prev) => offsetDay(prev, -1));
  };

  const handleNextDay = () => {
    if (!isToday && !isFuture) {
      setSelectedDay((prev) => offsetDay(prev, 1));
    }
  };

  const handleToday = () => {
    setSelectedDay(todayStr);
  };

  // Calculate 30-day compliance rate
  const complianceStats = useMemo(() => {
    if (!metricsData?.days || metricsData.days.length === 0) return null;
    let totalCommitted = 0;
    let totalCompleted = 0;
    for (const d of metricsData.days) {
      totalCommitted += d.committed;
      totalCompleted += d.completed;
    }
    if (totalCommitted === 0) return null;
    const rate = Math.round((totalCompleted / totalCommitted) * 100);
    return {
      rate,
      committed: totalCommitted,
      completed: totalCompleted,
    };
  }, [metricsData]);

  // Day specific metric if available
  const dayMetric = metricsData?.days?.find((d) => d.day === selectedDay);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflow: "hidden",
        background: tokens.bgBody,
      }}
    >
      {/* Surface Header Bar */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgTabBar,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {/* Left: Title & Date Stepper */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: tokens.textHi,
                letterSpacing: "0.04em",
              }}
            >
              JOURNAL
            </span>
            <span style={{ fontSize: 13, color: tokens.textGhost }}>/</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: tokens.textSecondary,
              }}
            >
              MENTOR
            </span>
          </div>

          {/* Date Stepper Controls */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: tokens.bgCard,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 6,
              padding: "2px 4px",
            }}
          >
            <button
              type="button"
              onClick={handlePrevDay}
              title="Previous day"
              aria-label="Previous day"
              style={{
                background: "none",
                border: "none",
                color: tokens.textBody,
                fontSize: 12,
                cursor: "pointer",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              ←
            </button>

            <span
              className="mono"
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: isToday ? tokens.accent : tokens.textHi,
                padding: "0 6px",
                minWidth: 140,
                textAlign: "center",
              }}
            >
              {formatDayHeader(selectedDay, todayStr)}
            </span>

            <button
              type="button"
              onClick={handleNextDay}
              disabled={isToday || isFuture}
              title={isToday ? "Cannot navigate to future" : "Next day"}
              aria-label="Next day"
              style={{
                background: "none",
                border: "none",
                color: isToday || isFuture ? tokens.textGhost : tokens.textBody,
                fontSize: 12,
                cursor: isToday || isFuture ? "not-allowed" : "pointer",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              →
            </button>

            {!isToday && (
              <button
                type="button"
                onClick={handleToday}
                className="mono"
                style={{
                  background: tokens.primaryActionBg,
                  border: `1px solid ${tokens.accent}`,
                  color: tokens.accent,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: "2px 6px",
                  borderRadius: 4,
                  marginLeft: 4,
                }}
              >
                Today
              </button>
            )}
          </div>
        </div>

        {/* Right: Metrics & Live Cron Switch */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {/* Streak pill */}
          {!isMetricsLoading && metricsData && (
            <div
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 8px",
                borderRadius: 14,
                background: tokens.bgCard,
                border: `1px solid ${tokens.borderDivider}`,
                fontSize: 11,
                color: metricsData.streak > 0 ? tokens.warn : tokens.textMuted,
              }}
              title="Daily evening mentor debrief streak"
            >
              <span>🔥</span>
              <span style={{ fontWeight: 600 }}>{metricsData.streak}d streak</span>
            </div>
          )}

          {/* 30d Compliance Rate */}
          {complianceStats && (
            <div
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 8px",
                borderRadius: 14,
                background: tokens.bgCard,
                border: `1px solid ${tokens.borderDivider}`,
                fontSize: 11,
                color: tokens.textSecondary,
              }}
              title={`30d Accountability: ${complianceStats.completed}/${complianceStats.committed} tasks completed`}
            >
              <span>🎯</span>
              <span>{complianceStats.rate}% score</span>
            </div>
          )}

          {/* Day-specific score if recorded */}
          {dayMetric && (
            <div
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                borderRadius: 14,
                background: tokens.okActionBg,
                border: `1px solid ${tokens.okActionBorder}`,
                fontSize: 11,
                color: tokens.ok,
              }}
              title={`Day record: ${dayMetric.completed}/${dayMetric.committed} tasks`}
            >
              <span>✓</span>
              <span>
                {dayMetric.completed}/{dayMetric.committed} done
              </span>
            </div>
          )}

          {/* Live Mentor Cron Switch */}
          <MentorCronSwitch />
        </div>
      </div>

      {/* Narrow Viewport Tab Switcher */}
      {isNarrow && (
        <div
          style={{
            display: "flex",
            borderBottom: `1px solid ${tokens.borderDivider}`,
            background: tokens.bgTabBar,
            padding: "6px 12px",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={() => setNarrowTab("retro")}
            className="mono"
            style={{
              flex: 1,
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${narrowTab === "retro" ? tokens.accent : tokens.borderDivider}`,
              background: narrowTab === "retro" ? tokens.primaryActionBg : tokens.bgCard,
              color: narrowTab === "retro" ? tokens.accent : tokens.textMuted,
              cursor: "pointer",
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            📖 Retrospective &amp; Vault
          </button>
          <button
            type="button"
            onClick={() => setNarrowTab("mentor")}
            className="mono"
            style={{
              flex: 1,
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${narrowTab === "mentor" ? tokens.accent : tokens.borderDivider}`,
              background: narrowTab === "mentor" ? tokens.primaryActionBg : tokens.bgCard,
              color: narrowTab === "mentor" ? tokens.accent : tokens.textMuted,
              cursor: "pointer",
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            ⚔️ Mentor Agent
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: isNarrow ? "column" : "row",
          overflow: "hidden",
        }}
      >
        {/* Left Column: Retrospective & Paper Journal Hub (55%) */}
        {(!isNarrow || narrowTab === "retro") && (
          <div
            className="scroll-tinted"
            style={{
              flex: isNarrow ? "1 1 auto" : "1 1 55%",
              minWidth: 0,
              height: "100%",
              overflowY: "auto",
              padding: "16px 16px 24px 16px",
              borderRight: isNarrow ? "none" : `1px solid ${tokens.borderDivider}`,
            }}
          >
            <JournalRetrospectivePane day={selectedDay} />
          </div>
        )}

        {/* Right Column: Mentor Agent Deck (45%) */}
        {(!isNarrow || narrowTab === "mentor") && (
          <div
            style={{
              flex: isNarrow ? "1 1 auto" : "1 1 45%",
              minWidth: 0,
              height: "100%",
              padding: isNarrow ? 12 : 16,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <MentorAgentDeck day={selectedDay} />
          </div>
        )}
      </div>
    </div>
  );
}

export default JournalSurface;
