"use client";

import type { CSSProperties } from "react";
import { tokens } from "../tokens";

type Status = string;

interface StatusStyle {
  color: string;
  label?: string;
  /** Pulse animation for live/running states. */
  animate?: boolean;
}

/**
 * Compact mapping from canonical run/job/inbox statuses to a colour + label.
 * Mirrors hub-web's pulse-status-badge.tsx STATUS_MAP. Add new statuses here
 * (don't invent ad-hoc inline colors elsewhere).
 */
const STATUS_MAP: Record<string, StatusStyle> = {
  // Run statuses
  queued: { color: tokens.textMuted, label: "QUEUED" },
  running: { color: tokens.accent, label: "RUNNING", animate: true },
  paused: { color: tokens.warn, label: "PAUSED" },
  stuck: { color: tokens.stuck, label: "STUCK" },
  completed: { color: tokens.ok, label: "COMPLETED" },
  failed: { color: tokens.bleed, label: "FAILED" },
  cancelled: { color: tokens.textFaint, label: "CANCELLED" },

  // Inbox statuses
  APPROVE: { color: tokens.ok, label: "APPROVE", animate: true },
  BLEED: { color: tokens.bleed, label: "BLEED", animate: true },
  STUCK: { color: tokens.stuck, label: "STUCK" },
};

const FALLBACK: StatusStyle = { color: tokens.textMuted };

interface PulseStatusBadgeProps {
  status: Status;
  /** Override the displayed label (defaults to STATUS_MAP[status].label || status). */
  label?: string;
  size?: "sm" | "md";
  style?: CSSProperties;
}

/**
 * Animated status pill — coloured dot + uppercase label. Ported from
 * apps/hub-web/src/app/(authenticated)/_components/pulse-status-badge.tsx
 * (v1.6 phase 2). The dot pulses for `animate: true` states (running/live).
 */
export function PulseStatusBadge({
  status,
  label,
  size = "md",
  style,
}: PulseStatusBadgeProps) {
  const s = STATUS_MAP[status] ?? FALLBACK;
  const display = label ?? s.label ?? status.toUpperCase();
  const dotSize = size === "sm" ? 6 : 8;
  const fontSize = size === "sm" ? 9 : 10;
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize,
        letterSpacing: "0.08em",
        color: s.color,
        textTransform: "uppercase",
        ...style,
      }}
    >
      <span
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: "50%",
          background: s.color,
          flex: "none",
          ...(s.animate ? { animation: "pulse 2s infinite" } : {}),
        }}
      />
      {display}
    </span>
  );
}
