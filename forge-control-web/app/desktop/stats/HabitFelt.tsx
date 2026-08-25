"use client";

/**
 * HABIT ↔ FELT RATING — the one tile that can answer a question nothing else
 * on this system can (PLAN.md §3.4, "the interesting one").
 *
 * The day score is derived: habits ticked, tasks closed, goals met. It cannot
 * tell Konrad whether any of that made the day GOOD, because it computed the
 * day from those very inputs. `day_plans.subjective` — 1..10 since
 * 2026-08-25 — is the only signal in the system that is not a function of the
 * others, which makes this the only place that can ever say "meditation moves
 * your felt rating by +1.4 and 'no sweets' moves it by nothing".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNTIL THE SAMPLE EXISTS, THIS TILE IS A SENTENCE
 * ═══════════════════════════════════════════════════════════════════════════
 * With four rated days a bar chart here would be noise wearing a trend's
 * clothes — and this whole project exists because the previous surface showed
 * Konrad thirty days of confident-looking zeros. So below `needed` rated days
 * the tile prints ONE sentence, built and pinned by `stats-math.ts`, and draws
 * nothing. No bars, no greyed-out placeholder chart, no fake zeros.
 *
 * Above it, each ROW still gates itself on its own `sufficient` flag: a habit
 * ticked on 3 of 40 rated days is not evidence even when the window is. Rows
 * arrive sorted by |delta| and are rendered in that order — the sort is the
 * server's, so the surface cannot disagree with the API about what matters
 * most.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DIVERGING, NOT CATEGORICAL
 * ═══════════════════════════════════════════════════════════════════════════
 * `delta` has a sign and a meaningful zero, so it takes a diverging encoding:
 * two hues that read as opposite plus a NEUTRAL midpoint. `accent` (cool) and
 * `bleed` (warm) are the poles — validated all-pairs in both themes, ΔE 21.5
 * CVD / 25.7 normal in dark and 24.6 / 29.8 in light. The zero line is
 * `borderDivider`, a neutral: a hue at the midpoint would make "no effect"
 * look like a third category.
 *
 * Every bar is direct-labelled with its delta and its n counts, so the colour
 * is confirmation rather than the only channel.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchDayStats, type DayHabitFeltRow, type DayStats } from "../../api";
import { CARD, EmptyState, SectionLabel } from "../goals/ui";
import { insufficientFeltSentence, maxAbsDelta, signedBarGeometry } from "./stats-math";

const HEADING = "WHICH HABITS MOVE THE FELT RATING";

/* Row geometry, named once and shared by the row and its axis caption. A bar
 * chart whose caption is measured separately from its track drifts the moment
 * either column width is touched, and the drift is invisible until someone
 * reads a sign off the wrong half. */
const ROW_GAP = 9;
const ICON_W = 18;
const LABEL_W = 116;
const DELTA_W = 40;
const COUNTS_W = 52;
const TRACK_INSET_LEFT = ICON_W + LABEL_W + ROW_GAP * 2;
const TRACK_INSET_RIGHT = DELTA_W + COUNTS_W + ROW_GAP * 2;

/** Own query, shared key — see the note on `ScoreTrend`. */
export function HabitFelt({ days }: { days: number }) {
  const q = useQuery({
    queryKey: ["daily-stats", days],
    queryFn: () => fetchDayStats(days),
    retry: 1,
  });

  if (q.isPending) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="hourglass_empty">Loading {days} days of ratings…</EmptyState>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="error_outline">
          Habit correlation unavailable —{" "}
          {q.error instanceof Error ? q.error.message : String(q.error)}
        </EmptyState>
      </>
    );
  }
  return <HabitFeltView stats={q.data} />;
}

export function HabitFeltView({ stats }: { stats: DayStats }) {
  const felt = stats.habit_felt;

  const sufficientRows = useMemo(
    () => felt.rows.filter((r): r is DayHabitFeltRow & { delta: number } => r.sufficient && r.delta !== null),
    [felt.rows],
  );
  const scale = useMemo(() => maxAbsDelta(sufficientRows), [sufficientRows]);

  /* The window-wide gate. Exactly the brief's sentence, exactly once, with N
     from the payload — never a hard-coded 0 and never a chart. */
  if (!felt.sufficient) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="query_stats">
          {insufficientFeltSentence(felt.rated_days, felt.needed)}
        </EmptyState>
      </>
    );
  }

  /* The window has enough rated days but no individual habit does — or every
     delta is exactly zero, which would divide by zero in the bar geometry.
     Both are real answers and both are stated, not drawn. */
  if (sufficientRows.length === 0 || scale === 0) {
    return (
      <>
        <SectionLabel>{HEADING}</SectionLabel>
        <EmptyState icon="query_stats">
          {felt.rated_days} rated days, enough for the window — but no single
          habit yet has both enough days with it and enough without it to
          compare. Keep ticking; the rows appear one at a time.
        </EmptyState>
      </>
    );
  }

  const insufficient = felt.rows.length - sufficientRows.length;

  return (
    <>
      <SectionLabel
        right={
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            {felt.rated_days} rated days
          </span>
        }
      >
        {HEADING}
      </SectionLabel>
      <div style={{ ...CARD, padding: "14px 14px 11px" }}>
        {/* The two halves of this caption must sit over the two halves of the
            BAR TRACK, not of the card. `FeltRow` insets that track by the icon
            and label on the left (18 + 116 + two 9px gaps) and by the delta and
            n-counts on the right (40 + 52 + two 9px gaps); a caption spanning
            the full card puts "better" above the n-counts and leaves the zero
            line unlabelled — the reader then has no idea where zero is. These
            two paddings are those two sums, and they are why the divider below
            lands exactly on the centre line. */}
        <div
          className="mono"
          style={{
            display: "flex",
            fontSize: 9,
            color: tokens.textGhost,
            letterSpacing: "0.08em",
            marginBottom: 8,
            paddingLeft: TRACK_INSET_LEFT,
            paddingRight: TRACK_INSET_RIGHT,
          }}
        >
          {/* Terse deliberately: once the caption is constrained to the track
              (rather than the card) there is only ~270px for both halves, and
              the long form wrapped onto two lines and collided in the middle.
              The footnote below carries the full definition of Δ. */}
          <span style={{ flex: 1, whiteSpace: "nowrap" }}>← worse</span>
          <span style={{ flex: 1, textAlign: "right", whiteSpace: "nowrap" }}>better →</span>
        </div>
        {sufficientRows.map((row) => (
          <FeltRow key={row.habit_id} row={row} scale={scale} />
        ))}
        <div style={{ fontSize: 10.5, color: tokens.textGhost, lineHeight: 1.5, paddingTop: 8 }}>
          Δ is the mean felt rating on days the habit was ticked minus the mean
          on days it was not, over the {felt.rated_days} rated days in this
          window. Association, not proof — a good week ticks more habits AND
          feels better.
          {insufficient > 0 && (
            <>
              {" "}
              {insufficient} further {insufficient === 1 ? "habit is" : "habits are"} held
              back for too small a sample.
            </>
          )}
        </div>
      </div>
    </>
  );
}

function FeltRow({ row, scale }: { row: DayHabitFeltRow & { delta: number }; scale: number }) {
  const { leftPct, widthPct, positive } = signedBarGeometry(row.delta, scale);
  const tone = positive ? tokens.accent : tokens.bleed;
  const sign = row.delta > 0 ? "+" : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: ROW_GAP, marginBottom: 6 }}>
      <span className="ms" style={{ fontSize: 15, color: tone, flex: "none", width: ICON_W }} aria-hidden>
        {row.icon}
      </span>
      <span
        style={{
          fontSize: 11.5,
          color: tokens.textSoft,
          flex: "none",
          width: LABEL_W,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={row.label}
      >
        {row.label}
      </span>
      <div
        style={{ position: "relative", flex: 1, minWidth: 60, height: 13 }}
        role="img"
        aria-label={`${row.label}: ${sign}${row.delta.toFixed(1)} felt rating, ${row.n_with} days with, ${row.n_without} without`}
      >
        {/* Neutral zero line — a hue here would read as a third category. */}
        <span
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: 1,
            background: tokens.borderDivider,
          }}
        />
        <span
          style={{
            position: "absolute",
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            top: 2,
            bottom: 2,
            background: tone,
            opacity: 0.85,
            borderRadius: positive ? "0 3px 3px 0" : "3px 0 0 3px",
          }}
        />
      </div>
      <span
        className="mono"
        style={{ fontSize: 11, color: tone, flex: "none", width: DELTA_W, textAlign: "right" }}
      >
        {sign}
        {row.delta.toFixed(1)}
      </span>
      <span
        className="mono"
        style={{ fontSize: 9, color: tokens.textGhost, flex: "none", width: COUNTS_W, textAlign: "right" }}
        title={`${row.n_with} rated days with it, ${row.n_without} without`}
      >
        {row.n_with}/{row.n_without}
      </span>
    </div>
  );
}
