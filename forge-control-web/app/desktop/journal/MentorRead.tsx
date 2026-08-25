"use client";

import { useMemo } from "react";
import { tokens } from "../../tokens";
import { CARD, SectionLabel, EmptyState } from "../goals/ui";
import type { JournalMentor, JournalError } from "../../api";

export interface MentorReadProps {
  day: string;
  mentor: JournalMentor | null | undefined;
  errors?: JournalError[];
  isLoading?: boolean;
}

function formatClock(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

export function MentorRead({
  day,
  mentor,
  errors = [],
  isLoading = false,
}: MentorReadProps) {
  const mentorError = useMemo(
    () => errors.find((e) => e.source === "mentor" || e.source === "mentor_read"),
    [errors],
  );

  if (isLoading) {
    return (
      <div>
        <SectionLabel>MENTOR'S READ</SectionLabel>
        <EmptyState icon="hourglass_empty">Loading mentor's read…</EmptyState>
      </div>
    );
  }

  if (!mentor && mentorError) {
    return (
      <div>
        <SectionLabel>MENTOR'S READ</SectionLabel>
        <div
          style={{
            ...CARD,
            padding: "14px 16px",
            border: `1px solid ${tokens.bleed}`,
            background: tokens.bgCard,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: tokens.bleed,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              error_outline
            </span>
            <span>Mentor log read failed</span>
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textMuted,
              marginTop: 6,
              lineHeight: 1.4,
            }}
          >
            {mentorError.message}
          </div>
        </div>
      </div>
    );
  }

  if (!mentor) {
    return (
      <div>
        <SectionLabel>MENTOR'S READ</SectionLabel>
        <EmptyState icon="info">
          No mentor data available for {day}.
        </EmptyState>
      </div>
    );
  }

  const isStale =
    Boolean(mentor.log_day && mentor.log_day !== day) ||
    (mentor.stale_days !== null && mentor.stale_days > 0);

  const streakPill = mentor.streak > 0 ? (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10.5,
        fontWeight: 600,
        color: tokens.warn,
        background: tokens.toolBg,
        border: `1px solid ${tokens.border}`,
        padding: "2px 7px",
        borderRadius: 12,
      }}
      title="Daily mentor debrief streak"
    >
      <span>🔥</span>
      <span>{mentor.streak}d streak</span>
    </span>
  ) : null;

  return (
    <div>
      <SectionLabel right={streakPill}>MENTOR'S READ</SectionLabel>

      {mentor.verdict ? (
        <div
          style={{
            ...CARD,
            padding: "16px 18px",
            borderLeft: `3px solid ${tokens.accent}`,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Status & Metadata Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {isStale ? (
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: tokens.warn,
                    background: tokens.freezeBgWarn,
                    border: `1px solid ${tokens.freezeBorderWarn}`,
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  last mentor entry: {mentor.log_day ?? "earlier"}
                  {mentor.stale_days !== null && mentor.stale_days > 0
                    ? `, ${mentor.stale_days} day${mentor.stale_days === 1 ? "" : "s"} ago`
                    : ""}
                </span>
              ) : (
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: tokens.ok,
                    background: tokens.okActionBg,
                    border: `1px solid ${tokens.okActionBorder}`,
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  ✓ debrief for {day}
                </span>
              )}
            </div>

            {mentor.metrics && (
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: tokens.textSecondary,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>
                  {mentor.metrics.completed}/{mentor.metrics.committed} tasks
                </span>
                <span style={{ color: tokens.textGhost }}>·</span>
                <span>{mentor.metrics.notes} notes</span>
              </div>
            )}
          </div>

          {/* Verdict Content */}
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: tokens.textHi,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {mentor.verdict}
          </div>
        </div>
      ) : (
        <div
          style={{
            ...CARD,
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 13, color: tokens.textMuted, fontWeight: 500 }}>
            No mentor debrief recorded for {day}.
          </div>

          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textGhost,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              schedule
            </span>
            <span>
              {mentor.last_cron_fired_at
                ? `Last evening mentor cron fired: ${formatClock(mentor.last_cron_fired_at)}`
                : "Evening mentor crons have not fired recently / disabled."}
            </span>
          </div>

          {mentor.metrics && (
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.textSecondary,
                marginTop: 4,
                paddingTop: 8,
                borderTop: `1px solid ${tokens.borderDivider}`,
              }}
            >
              Accountability metrics recorded: {mentor.metrics.completed}/{mentor.metrics.committed}{" "}
              tasks completed · {mentor.metrics.notes} notes
            </div>
          )}
        </div>
      )}
    </div>
  );
}
