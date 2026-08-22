"use client";

/**
 * QuotaRow — THE indicator row. One per screen, one query, one cadence.
 *
 * Konrad, 2026-08-17: "Why do we have two indicators and why do we have them?
 * We do not need a weekly and a 5-hour limit twice, especially refreshing at
 * different intervals."
 *
 * His original ask was for a THIRD item beside the two bars ("in these chats I
 * need an indication of how far the context window of the current chat is used
 * up, place it next to the other two usage bars at the bottom so I know when to
 * type /compact"). A later round shipped a second copy of the two bars above
 * the composer instead. This component is the single row he asked for:
 *
 *     5h ▓▓░░ 41%   7d ▓░░░ 12%   ctx ▓▓▓░ 63%   gem not signed in   ⟳ 2m ago
 *
 * ── What each item is, and where its number comes from ───────────────────
 *  5h / 7d  Anthropic's measured utilisation, from /api/oauth/usage through
 *           forge-control. A real percentage of a real limit.
 *  ctx      How full the OPEN CHAT's context window is — its own data path
 *           (ContextGauge reads the chat's cache entry, not this one), which
 *           is why it renders ABSENT on a surface with no chat rather than
 *           "0%". A gauge reading zero when there is no chat is a false
 *           statement, and this row prints no false statements.
 *  gem      What WE counted for Gemini. Not a bar: Google publishes no
 *           denominator for a consumer Ultra subscription — see geminiLine.ts.
 *
 * ── The row is in the status bar, not the composer ───────────────────────
 * The status bar is visible on every surface, so the reading is one glance
 * away from wherever Konrad is. The composer copy was only visible inside a
 * chat and duplicated everything except the context gauge, which is the item
 * that actually belongs to a chat — and that item works from the status bar
 * because ChatSurface publishes its target to it.
 *
 * Tokens only, both themes, no hover state in React (hover here is a native
 * `title`, so pointing at a bar re-renders nothing).
 */

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { tokens } from "../../tokens";
import { ContextGauge } from "../chat/ContextGauge";
import { geminiLine, type GeminiTone } from "./geminiLine";
import { AntigravityMark, GEMINI_ACCENT } from "../gemini-identity";
import {
  readGeminiQuota,
  refreshGeminiQuotaNow,
  type GeminiQuotaReading,
} from "./quotaQuery";
import {
  readingAge,
  resetsIn,
  useMinuteTick,
  useQuotaRefresh,
  useQuotaSnapshot,
  type QuotaWindow,
} from "./quotaQuery";

/** Bar geometry, shared by every gauge in the row — including ContextGauge,
 *  which copies these numbers deliberately so the three read as one row. */
const TRACK_W = 46;
const TRACK_H = 5;

const TONE_COLOUR: Record<GeminiTone, string> = {
  // "We cannot tell" gets the warn colour, never a healthy one — the same rule
  // the account registry keeps for an unprobed account.
  unknown: tokens.warn,
  unsigned: tokens.textGhost,
  counted: tokens.info,
};

export function QuotaRow(): JSX.Element {
  const q = useQuotaSnapshot();
  const refresh = useQuotaRefresh();
  const [refreshing, setRefreshing] = useState(false);

  // Keeps "3m ago" truthful between polls. No request.
  useMinuteTick();

  const run = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const d = q.data;

  // No reading yet, or a hard failure. The context gauge has its OWN data path,
  // so a quota reading that has not landed must not take it down with it — and
  // the refresh control stays reachable, because a single 429 used to leave the
  // row stuck with nothing to click.
  if (!d) {
    return (
      <span data-quota-row style={row()}>
        <span style={{ color: tokens.textGhost }}>
          {q.isError ? "quota unavailable" : "quota…"}
        </span>
        <ContextGauge />
        <Refresh
          refreshing={refreshing}
          onClick={() => void run()}
          title={
            q.isError
              ? `${q.error instanceof Error ? q.error.message : "quota failed"} — click to try again`
              : "waiting for the first quota reading — click to fetch now"
          }
          label={q.isError ? "⟳ retry" : "⟳ …"}
          tone={q.isError ? tokens.warn : tokens.textGhost}
        />
      </span>
    );
  }

  const gem = geminiLine(d.gemini);

  return (
    <span data-quota-row style={row()}>
      <Bar label="5h" w={d.five_hour} />
      <Bar label="7d" w={d.seven_day} />
      {d.seven_day_opus && <Bar label="opus" w={d.seven_day_opus} />}
      {/* Third item, same visual language, its own source of truth: how full
          the open chat's context window is. Renders nothing when no chat is on
          screen — see the header. */}
      <ContextGauge />
      <GeminiBars fallback={gem} />
      <Refresh
        refreshing={refreshing}
        onClick={() => void run()}
        title={
          d.error
            ? `${d.error} — click to try again`
            : `quota updated ${readingAge(d.fetched_at)} — click to refresh`
        }
        label={
          refreshing ? "⟳ …" : d.error ? "⟳ retry" : `⟳ ${readingAge(d.fetched_at)}`
        }
        tone={d.error ? tokens.warn : tokens.textGhost}
      />
    </span>
  );
}

function row(): React.CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 10 };
}

function Refresh({
  refreshing,
  onClick,
  title,
  label,
  tone,
}: {
  refreshing: boolean;
  onClick: () => void;
  title: string;
  label: string;
  tone: string;
}): JSX.Element {
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        cursor: refreshing ? "wait" : "pointer",
        color: tone,
        opacity: refreshing ? 0.5 : 1,
      }}
    >
      {label}
    </span>
  );
}

/**
 * The Gemini bars — the same visual language as the Claude ones, from agy's own
 * /usage screen.
 *
 * ── WHY THIS REPLACED A TOKEN TALLY ──────────────────────────────────────────
 * The `gem` slot used to print what WE had counted, because the research said
 * Google publishes no denominator for a consumer plan. That was true of every
 * HTTP surface and false of the CLI: `agy`'s /usage screen states the limit as a
 * percentage with a reset time. Konrad saw it and asked for a bar. So the
 * denominator was never missing — it was behind a slash command.
 *
 * ── MANUAL, AND THAT IS THE FEATURE ──────────────────────────────────────────
 * Nothing here polls. A reading costs ~20 seconds of a real Antigravity TUI in a
 * pty, so it happens when the button is pressed and not otherwise — Konrad:
 * "I don't even need it to automatically update." The mount does a single cheap
 * GET of whatever the server last read; that is a cache lookup, not a reading.
 *
 * agy reports REMAINING; the shared Bar renders USED, which is what makes a
 * filling bar mean rising pressure across every item in this row. So the
 * conversion happens here, once, rather than by giving the bar a second meaning.
 */
function GeminiBars({ fallback }: { fallback: { text: string; tone: GeminiTone; title: string } }): JSX.Element {
  const [reading, setReading] = useState<GeminiQuotaReading | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    void readGeminiQuota()
      .then((r) => {
        if (!off) setReading(r);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);

  const refresh = async () => {
    setBusy(true);
    try {
      setReading(await refreshGeminiQuotaNow());
    } catch {
      /* leave the previous reading on screen — it is still the last true one */
    } finally {
      setBusy(false);
    }
  };

  const asWindow = (w: { remaining_pct: number } | null): QuotaWindow => ({
    // remaining -> used. A missing reading stays null so Bar draws no fill at
    // all: a 0%-wide bar and a real 0% look identical and only one is a fact.
    utilization: w === null ? null : Math.max(0, Math.min(100, 100 - w.remaining_pct)),
    resets_at: null,
  });

  const t = (label: string, w: { remaining_pct: number; refreshes_in: string | null } | null): string => {
    if (reading === null) return `gemini ${label}: never read — press ⟳`;
    if (!reading.ok) return `gemini ${label}: ${reading.error ?? "no reading"}`;
    if (w === null) return `gemini ${label}: agy's screen did not state this limit`;
    return (
      `gemini ${label}: ${w.remaining_pct}% remaining` +
      (w.refreshes_in ? ` · refreshes in ${w.refreshes_in}` : "") +
      (reading.account ? `\n${reading.account}` : "") +
      (reading.plan ? ` (${reading.plan})` : "") +
      (reading.read_at ? `\nread ${readingAge(reading.read_at)}` : "")
    );
  };

  // Nothing has ever been read AND the server has no cached reading: keep the
  // old honest sentence rather than drawing two empty tracks that look broken.
  const nothingYet = reading === null || (!reading.ok && reading.read_at === null);

  return (
    <span data-gemini-quota style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {nothingYet ? (
        <span
          data-gemini-line
          data-gemini-tone={fallback.tone}
          title={fallback.title}
          style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
        >
          <span style={{ color: tokens.textFaint }}>gem</span>
          <span style={{ color: TONE_COLOUR[fallback.tone] }}>{fallback.text}</span>
        </span>
      ) : (
        <>
          <Bar label="5h" w={asWindow(reading.five_hour)} titleOverride={t("5h", reading.five_hour)} accent={GEMINI_ACCENT} />
          <Bar label="7d" w={asWindow(reading.weekly)} titleOverride={t("7d", reading.weekly)} accent={GEMINI_ACCENT} />
        </>
      )}
      <button
        data-gemini-refresh
        onClick={() => void refresh()}
        disabled={busy}
        title={
          busy
            ? "reading agy's /usage screen — this takes about 20 seconds"
            : reading?.read_at
              ? `gemini quota read ${readingAge(reading.read_at)} — click to read again (~20s)`
              : "read the gemini quota from agy (~20s)"
        }
        style={{
          fontSize: 10,
          lineHeight: 1,
          padding: "2px 5px",
          borderRadius: 4,
          cursor: busy ? "default" : "pointer",
          color: busy ? tokens.textFaint : GEMINI_ACCENT,
          background: "transparent",
          border: `1px solid ${busy ? tokens.border : GEMINI_ACCENT}`,
        }}
      >
        {busy ? "…" : "⟳"}
      </button>
    </span>
  );
}

function Bar({
  label,
  w,
  titleOverride,
  accent,
}: {
  label: string;
  w: QuotaWindow;
  /** Used by the Gemini bars, whose reset is a duration agy prints ("2h 19m")
   *  rather than a timestamp this row can compute from. */
  titleOverride?: string;
  /** Engine identity colour, used while the bar is HEALTHY.
   *
   *  Pressure still wins above 70%: engine and pressure are different axes, and
   *  a reader must never have to wonder whether a bar is violet because it is
   *  Gemini or because something is wrong. So identity colours the calm state —
   *  which is almost all of the time — and pressure takes over exactly when it
   *  needs to be noticed. */
  accent?: string;
}): JSX.Element {
  const pct = w.utilization ?? 0;
  // Colour by pressure, not by brand — the point is to notice at a glance.
  const colour =
    pct >= 90 ? tokens.bleed : pct >= 70 ? tokens.warn : (accent ?? tokens.ok);
  return (
    <span
      data-quota-bar={label}
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
      title={
        titleOverride ??
        `${label}: ${w.utilization == null ? "no reading" : `${Math.round(pct)}% used`}${
          w.resets_at ? ` · ${resetsIn(w.resets_at)}` : ""
        }`
      }
    >
      <span style={{ color: accent ?? tokens.textFaint, display: "inline-flex", alignItems: "center", gap: 3 }}>
        {accent !== undefined && <AntigravityMark size={10} />}
        {label}
      </span>
      <span
        style={{
          width: TRACK_W,
          height: TRACK_H,
          borderRadius: 3,
          background: tokens.borderEmphasis,
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        {/* No fill at all for a missing reading — a 0%-wide bar and a real 0%
            look identical, and only one of them is a measurement. */}
        {w.utilization != null && (
          <span
            style={{
              display: "block",
              width: `${Math.min(100, Math.max(0, pct))}%`,
              height: "100%",
              background: colour,
            }}
          />
        )}
      </span>
      <span style={{ color: w.utilization == null ? tokens.textGhost : colour }}>
        {w.utilization == null ? "—" : `${Math.round(pct)}%`}
      </span>
    </span>
  );
}
