"use client";

/** Composer quota strip — round 1350.
 *
 *  Konrad, repeatedly: he wants a small context/quota readout right where he
 *  types, not buried in the status bar he has to look away for. PERCENTAGES
 *  AND RESET TIMES ONLY — no dollar/euro figures near the composer; the
 *  credit tracker in Settings is the one place spend numbers are allowed.
 *
 *  Shares QuotaBars' (DesktopApp.tsx) exact query key, fetcher and intervals
 *  — `["usage","quota"]`, `fetchQuota(false)`, refetchInterval 120s, staleTime
 *  60s — so this reads the SAME react-query cache entry. Two observers, one
 *  poll. Adding a second interval here would be a regression against this
 *  project's poll budget.
 *
 *  Visual language copied from QuotaBars' `Bar` / ContextGauge's `Gauge`:
 *  same track dimensions, same pressure colouring (ok → warn → bleed), tokens
 *  only, both themes.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchQuota, type QuotaWindow } from "../../api";

export function QuotaStrip() {
  const q = useQuery({
    queryKey: ["usage", "quota"],
    queryFn: () => fetchQuota(false),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // Re-render each minute so the reading's age stays truthful between polls
  // — same trick QuotaBars uses, no extra fetch.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const d = q.data;
  // No reading yet (first mount before the shared cache populates, or a hard
  // failure) → render nothing rather than a placeholder row that shifts the
  // composer around once data lands.
  if (!d) return null;

  const nextReset = resetTime(d.five_hour.resets_at) ?? resetTime(d.seven_day.resets_at);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 10.5,
        color: tokens.textFaint,
        padding: "0 2px 6px",
        whiteSpace: "nowrap",
        overflowX: "auto",
      }}
    >
      <Bar label="5h" w={d.five_hour} />
      <Bar label="7d" w={d.seven_day} />
      {d.seven_day_opus && <Bar label="opus" w={d.seven_day_opus} />}
      {nextReset && <span>↻ {nextReset}</span>}
      <span style={{ marginLeft: "auto", color: tokens.textGhost }}>
        {age(d.fetched_at)}
      </span>
    </div>
  );
}

function age(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function resetTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function Bar({ label, w }: { label: string; w: QuotaWindow }) {
  if (w.utilization == null) {
    // Never a 0% bar for a reading we don't have — say so instead.
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span>{label}</span>
        <span style={{ color: tokens.textGhost }}>quota unavailable</span>
      </span>
    );
  }
  const pct = w.utilization;
  const color = pct >= 90 ? tokens.bleed : pct >= 70 ? tokens.warn : tokens.ok;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
      title={`${label}: ${Math.round(pct)}% used`}
    >
      <span>{label}</span>
      <span
        style={{
          width: 34,
          height: 4,
          borderRadius: 2,
          background: tokens.borderEmphasis,
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${Math.min(100, Math.max(0, pct))}%`,
            height: "100%",
            background: color,
          }}
        />
      </span>
      <span style={{ color }}>{Math.round(pct)}%</span>
    </span>
  );
}
