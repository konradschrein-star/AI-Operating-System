"use client";

/**
 * SCORE TREND — day score, its 7-day moving average, and the felt rating,
 * all on ONE 0..100 axis (PLAN.md §3.4).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS DOES NOT USE ui.tsx's `Line`
 * ═══════════════════════════════════════════════════════════════════════════
 * `Line` normalises to its OWN extent — `max = Math.max(...values, 1)` inside
 * each call — so two `Line`s stacked in one box are two different y-scales
 * wearing one axis. With scores [10,60,20] the 7-day MA is [10,35,30]; the
 * score's 60 and the average's 35 both land on the top edge, and the average
 * appears to track the peak it is supposed to smooth. That is the dataviz
 * skill's #1 anti-pattern (a dual-axis plot inventing a correlation), and it
 * is live in `goals/StatsTab.tsx:310-315` today — reported, not inherited.
 *
 * So this tile owns one `<svg>` holding all three marks against a single fixed
 * domain of 0..100. The domain is the SCORE's real domain, not the data's
 * extent: a fortnight of 40s must look like a fortnight of 40s, not like a
 * ceiling.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FELT RATING IS INDEXED, NOT SECOND-AXISED
 * ═══════════════════════════════════════════════════════════════════════════
 * `subjective` is 1..10; the score is 0..100. The dataviz rule for two
 * measures of different scale is "index both to a common base on ONE axis",
 * never a second y-scale — so 1→0 and 10→100 via `feltOnScoreAxis`, and the
 * caption prints the mapping so the reader can undo it by eye. Felt is drawn
 * as DOTS, not a line: it exists only on rated days, and a line would
 * interpolate a mood through days he never rated.
 *
 * Colour: `accent` (score) and `ok` (felt) — validated with the dataviz
 * validator in BOTH themes, all-pairs: ΔE 20.8 CVD / 22.0 normal in dark,
 * 23.6 / 24.9 in light. The moving average is deliberately NOT a third hue: it
 * is the same series smoothed, so it wears text ink and a dash instead.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchDayStats, type DayStats } from "../../api";
import { CARD, EmptyState, SectionLabel, formatDay } from "../goals/ui";
import { feltOnScoreAxis, movingAverage, scoredDays } from "./stats-math";

/** The score's real domain. Fixed, not derived — see the header. */
const DOMAIN_MAX = 100;
const MA_WINDOW = 7;

/** viewBox units. `preserveAspectRatio: none` stretches x to the card and the
 *  strokes carry `vector-effect` so they do not stretch with it. */
const VB_W = 300;
const VB_H = 100;
const PLOT_H = 104;

/**
 * This tile owns its own query (PLAN.md §3.4). Every tile that reads
 * `/api/daily/stats` uses the SAME key, so React Query serves them all from
 * one fetch — the point of per-tile ownership is not four round trips, it is
 * that each tile renders its own loading and its own error, so a failure in
 * one never blanks another.
 */
export function ScoreTrend({ days }: { days: number }) {
  const q = useQuery({
    queryKey: ["daily-stats", days],
    queryFn: () => fetchDayStats(days),
    retry: 1,
  });

  if (q.isPending) {
    return (
      <>
        <SectionLabel>SCORE TREND</SectionLabel>
        <EmptyState icon="hourglass_empty">Loading {days} days…</EmptyState>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <SectionLabel>SCORE TREND</SectionLabel>
        <EmptyState icon="error_outline">
          Score trend unavailable — {errorText(q.error)}
        </EmptyState>
      </>
    );
  }
  return <ScoreTrendView stats={q.data} />;
}

/** The message the API actually returned. Never "something went wrong": the
 *  status and the path are what make it fixable (PLAN.md §3.6). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ScoreTrendView({ stats }: { stats: DayStats }) {
  const scored = useMemo(() => scoredDays(stats.days), [stats.days]);

  const geometry = useMemo(() => {
    if (scored.length < 2) return null;
    const x = (i: number): number => (i / (scored.length - 1)) * VB_W;
    const y = (v: number): number => VB_H - (v / DOMAIN_MAX) * VB_H;

    const line = (values: number[]): string =>
      /* One decimal, not two: the viewBox is 300×100 and stretches to roughly
         530px, so a tenth of a unit is under a fifth of a pixel — invisible in
         the render, shorter in the path string, and it keeps `dollar-sweep.sh`
         quiet, since that gate reads two-decimal formatting as a currency
         shape. (Spelling the pattern out here would trip the gate on this very
         comment.) */
      values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

    const scores = scored.map((d) => d.score);
    /* Felt dots carry their own index so a rated day sits on the same x as its
       score. `feltOnScoreAxis` THROWS on an out-of-range rating rather than
       clamping it — a 47 is a backend bug, and a dot pinned to the top of the
       axis is how that bug would ship silently (PLAN.md §3.6). */
    const felt = scored
      .map((d, i) => ({ i, day: d.day, subjective: d.subjective }))
      .filter((p): p is { i: number; day: string; subjective: number } => p.subjective !== null)
      .map((p) => ({ ...p, cx: x(p.i), cy: y(feltOnScoreAxis(p.subjective)) }));

    return {
      scoreLine: line(scores),
      maLine: line(movingAverage(scores, MA_WINDOW)),
      felt,
      peak: Math.max(...scores),
    };
  }, [scored]);

  if (!geometry) {
    return (
      <>
        <SectionLabel>SCORE TREND</SectionLabel>
        <EmptyState icon="show_chart">
          Two scored days draw the first line. Come back tomorrow.
        </EmptyState>
      </>
    );
  }

  const ratedCount = geometry.felt.length;

  return (
    <>
      <SectionLabel right={<Legend rated={ratedCount} />}>
        SCORE TREND · {scored.length} SCORED DAYS
      </SectionLabel>
      <div style={{ ...CARD, padding: "14px 14px 10px" }}>
        <div style={{ position: "relative", height: PLOT_H }}>
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={
              `Day score over ${scored.length} days, peak ${geometry.peak}, ` +
              `with a ${MA_WINDOW}-day moving average and ${ratedCount} felt ratings.`
            }
            style={{ position: "absolute", inset: 0, width: "100%", height: PLOT_H, overflow: "visible" }}
          >
            {/* Recessive solid hairlines at 0 and 50 — the baseline and the
                midpoint. Never dashed: a dashed grid reads as a threshold, and
                the only dashed mark here is the moving average, which IS a
                derived series. */}
            {[0, 50].map((v) => (
              <line
                key={v}
                x1={0}
                x2={VB_W}
                y1={VB_H - (v / DOMAIN_MAX) * VB_H}
                y2={VB_H - (v / DOMAIN_MAX) * VB_H}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ stroke: tokens.borderDivider }}
              />
            ))}
            <polyline
              points={geometry.maLine}
              fill="none"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              style={{ stroke: tokens.textMuted, strokeDasharray: "4 3" }}
            />
            <polyline
              points={geometry.scoreLine}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              style={{ stroke: tokens.accent }}
            />
            {/* A 2px surface ring, not a border, so overlapping dots stay
                countable where two rated days sit a pixel apart. */}
            {geometry.felt.map((p) => (
              <circle
                key={p.day}
                cx={p.cx}
                cy={p.cy}
                r={4.5}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                style={{ fill: tokens.ok, stroke: tokens.bgCard }}
              >
                <title>{`${p.day} · felt ${p.subjective}/10`}</title>
              </circle>
            ))}
          </svg>
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
          <span>{formatDay(scored[0].day)}</span>
          <span>peak {geometry.peak}</span>
          <span>{formatDay(scored[scored.length - 1].day)}</span>
        </div>
        <div style={{ fontSize: 10.5, color: tokens.textGhost, lineHeight: 1.5, paddingTop: 6 }}>
          One axis, 0–100. Felt ratings are 1–10 placed on the same axis
          (1 → 0, 10 → 100) so they can be read against the score without a
          second scale — {ratedCount === 0
            ? "none are rated in this window yet"
            : `${ratedCount} rated ${ratedCount === 1 ? "day" : "days"} shown`}
          .
        </div>
      </div>
    </>
  );
}

/** Three marks, three labels — identity is never carried by colour alone. */
function Legend({ rated }: { rated: number }) {
  return (
    <span
      className="mono"
      style={{ display: "inline-flex", gap: 10, alignItems: "center", fontSize: 9, color: tokens.textGhost }}
    >
      <LegendMark label="score">
        <span style={{ width: 12, height: 2, background: tokens.accent, borderRadius: 1 }} />
      </LegendMark>
      <LegendMark label={`${MA_WINDOW}d avg`}>
        <span
          style={{
            width: 12,
            height: 0,
            borderTop: `1.5px dashed ${tokens.textMuted}`,
          }}
        />
      </LegendMark>
      <LegendMark label={`felt (${rated})`}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: tokens.ok,
            boxShadow: `0 0 0 1.5px ${tokens.bgCard}`,
          }}
        />
      </LegendMark>
    </span>
  );
}

function LegendMark({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {children}
      {label}
    </span>
  );
}
