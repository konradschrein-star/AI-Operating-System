"use client";

/**
 * The GOALS/TASKS surface's shared primitives.
 *
 * Everything visual that more than one tab needs lives here: the card shell,
 * the section label, the empty state, the score ring, the one bar renderer,
 * and the colour maps. Two rules govern this file.
 *
 *   1. Every colour comes from ../../tokens. No hex, no rgba, no Tailwind.
 *      Opacity is the only thing modulated locally (the heatmap's five steps),
 *      because a var() cannot be alpha-composited in a string.
 *   2. One renderer per idea. `Bars` draws every bar chart on this surface and
 *      `Meter` draws every 0..1 rate; a second one would drift.
 *
 * Tap targets: TAP (40px) is the floor for anything Konrad touches, because
 * the phone is where habits actually get ticked. The heatmap cell is the one
 * documented exception — §6 requires 13 week-columns inside 390px, which caps
 * a cell at ~26px; it is a drill-in, not a control, and the day sheet it opens
 * is full of real tap targets.
 */

import type { CSSProperties, ReactNode } from "react";
import { tokens } from "../../tokens";
import { fromDayKey } from "./quick-add";

/** Minimum tap target. Nothing interactive is shorter than this. */
export const TAP = 40;

export const CARD: CSSProperties = {
  background: tokens.bgCard,
  border: `1px solid ${tokens.border}`,
  borderRadius: 10,
};

export const MONO_LABEL: CSSProperties = {
  fontSize: 10,
  color: tokens.textFaint,
  letterSpacing: "0.1em",
};

export function SectionLabel({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "18px 0 8px",
        minHeight: 18,
      }}
    >
      <span className="mono" style={MONO_LABEL}>
        {children}
      </span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/** Empty states name what will fill them — an empty box that explains itself
 *  is information; one that doesn't is a dead end (§6). */
export function EmptyState({
  icon,
  children,
}: {
  icon: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        ...CARD,
        border: `1px dashed ${tokens.border}`,
        padding: "18px 16px",
        display: "flex",
        gap: 11,
        alignItems: "flex-start",
      }}
    >
      <span className="ms" style={{ fontSize: 19, color: tokens.textGhost }}>
        {icon}
      </span>
      <div
        style={{
          fontSize: 12,
          color: tokens.textMuted,
          lineHeight: 1.55,
          flex: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ── colour maps ─────────────────────────────────────────────────────────── */

/** 3 critical / 2 high / 1 normal / 0 low (§2). */
export function importanceColor(n: number): string {
  if (n >= 3) return tokens.bleed;
  if (n === 2) return tokens.warn;
  if (n === 1) return tokens.info;
  return tokens.textGhost;
}

export function importanceLabel(n: number): string {
  if (n >= 3) return "critical";
  if (n === 2) return "high";
  if (n === 1) return "normal";
  return "low";
}

const AREA_COLORS: readonly string[] = [
  tokens.info,
  tokens.decide,
  tokens.ok,
  tokens.accent,
  tokens.warn,
  tokens.stuck,
];

/** `area` is free text (§2), so its colour is derived rather than mapped —
 *  a new area invented at the quick-add box gets a stable colour without a
 *  code change. */
export function areaColor(area: string): string {
  let h = 0;
  for (let i = 0; i < area.length; i++) h = (h * 31 + area.charCodeAt(i)) >>> 0;
  return AREA_COLORS[h % AREA_COLORS.length];
}

/* ── numbers & dates ─────────────────────────────────────────────────────── */

/** A dropped score component prints as an em dash, never as 0% (§3). */
export function pctText(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function weekdayOf(dayKey: string): string {
  return WEEKDAY[fromDayKey(dayKey).getDay()];
}

/** "Wed 19 Aug" — long enough to orient, short enough for 390px. */
export function formatDay(dayKey: string): string {
  const d = fromDayKey(dayKey);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
}

export function clockOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

/* ── controls ────────────────────────────────────────────────────────────── */

export function chipStyle(active: boolean, color?: string): CSSProperties {
  return {
    minHeight: TAP,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "0 13px",
    borderRadius: 8,
    border: `1px solid ${active ? (color ?? tokens.accent) : tokens.border}`,
    background: active ? tokens.selectedBg : tokens.toolBg,
    color: active ? (color ?? tokens.text) : tokens.textMuted,
    fontSize: 11.5,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

export function primaryButton(tone: string = tokens.accent): CSSProperties {
  return {
    minHeight: 48,
    width: "100%",
    borderRadius: 10,
    border: `1px solid ${tone}`,
    background: tokens.primaryActionBg,
    color: tone,
    fontSize: 13.5,
    fontWeight: 600,
    letterSpacing: "0.08em",
    cursor: "pointer",
  };
}

export function ghostButton(): CSSProperties {
  return {
    minHeight: TAP,
    padding: "0 12px",
    borderRadius: 8,
    border: `1px solid ${tokens.border}`,
    background: tokens.toolBg,
    color: tokens.textMuted,
    fontSize: 11.5,
    cursor: "pointer",
  };
}

export function inputStyle(): CSSProperties {
  return {
    width: "100%",
    minHeight: TAP,
    padding: "9px 12px",
    borderRadius: 8,
    border: `1px solid ${tokens.border}`,
    background: tokens.inputBg,
    color: tokens.text,
    fontSize: 13,
    outline: "none",
  };
}

export function textareaStyle(): CSSProperties {
  return {
    width: "100%",
    minHeight: TAP,
    padding: "9px 12px",
    borderRadius: 8,
    border: `1px solid ${tokens.border}`,
    background: tokens.inputBg,
    color: tokens.text,
    fontSize: 13,
    outline: "none",
    resize: "vertical",
    fontFamily: "inherit",
    lineHeight: 1.45,
  };
}

export function borderlessTextareaStyle(): CSSProperties {
  return {
    width: "100%",
    minHeight: 24,
    padding: "4px 4px",
    border: "none",
    background: "transparent",
    color: tokens.text,
    fontSize: 13,
    outline: "none",
    resize: "none",
    fontFamily: "inherit",
    lineHeight: 1.45,
  };
}

/* ── the score ring ──────────────────────────────────────────────────────── */

/**
 * Day score as a ring with the number inside (§6 TODAY 1).
 *
 * Muted grey until the day is committed: an uncommitted day has no "said" to
 * measure "done" against, and a confident-looking number there would be the
 * Notion lie again. `provisional` prints the caveat §3 asks for — today's
 * score is not final until today is over.
 *
 * A conic-gradient rather than an SVG arc, deliberately: `stroke="var(--x)"`
 * is not resolved in an SVG presentation attribute, and the whole palette here
 * is var() strings.
 */
export function ScoreRing({
  score,
  muted,
  size = 62,
}: {
  /** null = nothing had a denominator; the ring shows a dash, not a zero. */
  score: number | null;
  muted: boolean;
  size?: number;
}) {
  const blank = muted || score === null;
  const clamped = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const arc = blank ? 0 : clamped;
  const ring = blank
    ? tokens.borderDivider
    : clamped >= 80
      ? tokens.ok
      : clamped >= 50
        ? tokens.accent
        : tokens.warn;
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: "50%",
        background: `conic-gradient(${ring} ${arc}%, ${tokens.borderDivider} 0)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: size - 9,
          height: size - 9,
          borderRadius: "50%",
          background: tokens.bgCard,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: size * 0.3,
            fontWeight: 500,
            color: blank ? tokens.textFaint : ring,
            lineHeight: 1,
          }}
        >
          {blank ? "–" : clamped}
        </span>
      </div>
    </div>
  );
}

/* ── the one bar renderer, and the one meter ─────────────────────────────── */

export interface BarDatum {
  key: string;
  value: number;
  label: string;
}

/**
 * Every bar chart on this surface. Flex-sized, so 90 columns fit 390px
 * without a scrollbar — the horizontally-scrolling table is the specific
 * Notion failure this surface exists to not repeat (§0.3).
 */
export function Bars({
  data,
  color,
  height = 76,
  markerAt,
  markerLabel,
}: {
  data: BarDatum[];
  color: string;
  height?: number;
  /** Draws a dashed rule at this value — used for the 7-day average. */
  markerAt?: number;
  markerLabel?: string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const markerY =
    markerAt !== undefined ? Math.min((markerAt / max) * height, height) : null;
  return (
    <div style={{ position: "relative", height, display: "flex", alignItems: "flex-end", gap: 2 }}>
      {markerY !== null && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: markerY,
            borderTop: `1px dashed ${tokens.textMuted}`,
            opacity: 0.7,
            pointerEvents: "none",
          }}
        >
          {markerLabel && (
            <span
              className="mono"
              style={{
                position: "absolute",
                right: 0,
                bottom: 2,
                fontSize: 9,
                color: tokens.textMuted,
              }}
            >
              {markerLabel}
            </span>
          )}
        </div>
      )}
      {data.map((d) => (
        <div
          key={d.key}
          title={d.label}
          style={{
            flex: 1,
            minWidth: 0,
            height: Math.max((d.value / max) * height, d.value > 0 ? 2 : 1),
            background: d.value > 0 ? color : tokens.borderDivider,
            opacity: d.value > 0 ? 0.85 : 1,
            borderRadius: "2px 2px 0 0",
          }}
        />
      ))}
    </div>
  );
}

/** A 0..1 rate as a filled track. */
export function Meter({
  value,
  color,
  height = 5,
}: {
  value: number;
  color: string;
  height?: number;
}) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      style={{
        flex: 1,
        minWidth: 30,
        height,
        borderRadius: height / 2,
        background: tokens.borderDivider,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.max(v * 100, v > 0 ? 2 : 0)}%`,
          height: "100%",
          background: color,
          opacity: 0.85,
        }}
      />
    </div>
  );
}

/** A polyline over a fixed viewBox, stretched to the container. The stroke is
 *  set in `style` (not as an attribute) so the var() palette resolves, and
 *  kept unstretched with `vector-effect`. */
export function Line({
  values,
  color,
  height = 90,
  dashed,
}: {
  values: number[];
  color: string;
  height?: number;
  dashed?: boolean;
}) {
  if (values.length < 2) return null;
  const W = 300;
  const H = 100;
  const max = Math.max(...values, 1);
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - (v / max) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height,
        overflow: "visible",
      }}
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={dashed ? 1.5 : 2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{
          stroke: color,
          strokeDasharray: dashed ? "4 3" : undefined,
        }}
      />
    </svg>
  );
}
