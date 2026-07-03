"use client";

/**
 * Money surface (v2.3) — the AI spend cockpit.
 *
 * One glance answers: how much did the machine burn today / this week /
 * this month, which areas (provider × kind) eat the credits, and is the
 * trend drifting up. Data = spend_log via GET /api/spend/summary; every
 * gateway (claude-code runs, fastgen images, TTS, forge-api video) POSTs
 * a row per billable call. Numbers are gateway-side estimates, not
 * invoices — the point is "is today surprising?", not accounting.
 */

import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { fetchSpendSummary, type SpendSummaryResponse } from "../api";

/** €15/day is the watchdog's alert line — mirror it here so the surface
 *  and the Telegram alert agree on what "too much" means. */
const DAILY_ALERT_EUR = 15;

const eur = (v: number) =>
  `€${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const kindColor = (kind: string): string => {
  switch (kind) {
    case "llm_output":
    case "llm_input":
      return tokens.accent;
    case "image":
      return tokens.info;
    case "tts":
      return tokens.decide;
    case "video":
      return tokens.warn;
    case "music":
      return tokens.stuck;
    case "embedding":
      return tokens.ok;
    default:
      return tokens.textMuted;
  }
};

export function MoneySurface() {
  const q = useQuery({
    queryKey: ["spend-summary"],
    queryFn: fetchSpendSummary,
    refetchInterval: 60_000,
  });

  const data: SpendSummaryResponse = q.data ?? {
    today: { total_eur: 0, calls: 0 },
    d7: { total_eur: 0, calls: 0 },
    d30: { total_eur: 0, calls: 0 },
    by_area: [],
    daily: [],
  };

  return (
    <div className="slidein" style={{ padding: "16px 20px 36px", maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
          Money · AI Spend
        </span>
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          spend_log · gateway estimates, not invoices
        </span>
        {q.isLoading && (
          <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            loading…
          </span>
        )}
      </div>
      <div className="mono" style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 18 }}>
        every billable call lands here — claude-code runs, images, TTS, video.
        watchdog pings your phone past {eur(DAILY_ALERT_EUR)}/day.
      </div>

      {/* Window totals */}
      <div style={{ display: "flex", gap: 9, marginBottom: 18 }}>
        <StatCard
          label="TODAY"
          value={eur(data.today.total_eur)}
          sub={`${data.today.calls} calls`}
          tone={data.today.total_eur > DAILY_ALERT_EUR ? tokens.warn : tokens.textHi}
        />
        <StatCard
          label="LAST 7 DAYS"
          value={eur(data.d7.total_eur)}
          sub={`${data.d7.calls} calls · ${eur(data.d7.total_eur / 7)}/day`}
          tone={tokens.textHi}
        />
        <StatCard
          label="LAST 30 DAYS"
          value={eur(data.d30.total_eur)}
          sub={`${data.d30.calls} calls · ${eur(data.d30.total_eur / 30)}/day`}
          tone={tokens.textHi}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Daily series */}
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.12em",
              marginBottom: 9,
            }}
          >
            DAILY SPEND · 30 DAYS
          </div>
          <DailyChart daily={data.daily} />
        </div>

        {/* Area breakdown */}
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.12em",
              marginBottom: 9,
            }}
          >
            WHERE IT GOES · provider × kind · 30 DAYS
          </div>
          <AreaBreakdown areas={data.by_area} />
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "11px 13px",
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 19, fontWeight: 500, color: tone, marginTop: 7 }}
      >
        {value}
      </div>
      <div className="mono" style={{ fontSize: 10, color: tokens.textMuted, marginTop: 4 }}>
        {sub}
      </div>
    </div>
  );
}

/** Pure-div bar chart. Bars carry a title tooltip with the exact numbers;
 *  the €15 alert line is drawn as a dashed rule when any day gets close. */
function DailyChart({
  daily,
}: {
  daily: SpendSummaryResponse["daily"];
}) {
  if (daily.length === 0) {
    return (
      <div
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px dashed ${tokens.border}`,
          borderRadius: 8,
          padding: 24,
          fontSize: 11,
          color: tokens.textFaint,
          textAlign: "center",
        }}
      >
        no spend recorded in the last 30 days.
      </div>
    );
  }
  const CHART_H = 150;
  const max = Math.max(...daily.map((d) => d.total_eur), 0.01);
  const showAlertLine = max >= DAILY_ALERT_EUR * 0.6;
  const alertY = Math.min((DAILY_ALERT_EUR / max) * CHART_H, CHART_H);

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "14px 15px 8px",
      }}
    >
      <div
        style={{
          position: "relative",
          height: CHART_H,
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
        }}
      >
        {showAlertLine && alertY <= CHART_H && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: alertY,
              borderTop: `1px dashed ${tokens.warn}`,
              opacity: 0.5,
              pointerEvents: "none",
            }}
          />
        )}
        {daily.map((d) => {
          const h = Math.max((d.total_eur / max) * CHART_H, d.total_eur > 0 ? 2 : 0);
          const hot = d.total_eur > DAILY_ALERT_EUR;
          return (
            <div
              key={d.day}
              title={`${d.day} — ${eur(d.total_eur)} · ${d.calls} calls`}
              style={{
                flex: 1,
                minWidth: 0,
                height: Math.max(h, 1),
                background: hot ? tokens.warn : tokens.accent,
                opacity: d.total_eur > 0 ? 0.85 : 0.18,
                borderRadius: "2px 2px 0 0",
              }}
            />
          );
        })}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9,
          color: tokens.textFaint,
          paddingTop: 7,
        }}
      >
        <span>{daily[0].day.slice(5)}</span>
        <span>peak {eur(max)}</span>
        <span>{daily[daily.length - 1].day.slice(5)}</span>
      </div>
    </div>
  );
}

function AreaBreakdown({
  areas,
}: {
  areas: SpendSummaryResponse["by_area"];
}) {
  if (areas.length === 0) {
    return (
      <div
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px dashed ${tokens.border}`,
          borderRadius: 8,
          padding: 24,
          fontSize: 11,
          color: tokens.textFaint,
          textAlign: "center",
        }}
      >
        nothing to break down yet.
      </div>
    );
  }
  const max = Math.max(...areas.map((a) => a.total_eur), 0.0001);
  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {areas.map((a, i) => {
        const color = kindColor(a.kind);
        const isLast = i === areas.length - 1;
        return (
          <div
            key={`${a.provider}-${a.kind}`}
            style={{
              padding: "10px 15px",
              borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                className="mono"
                style={{ fontSize: 11.5, color: tokens.textLabel }}
              >
                {a.provider}
              </span>
              <span className="mono" style={{ fontSize: 9.5, color }}>
                {a.kind}
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 11.5, color: tokens.textLabel }}>
                {eur(a.total_eur)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
              }}
            >
              <div
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: tokens.borderDivider,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.max((a.total_eur / max) * 100, 1)}%`,
                    height: "100%",
                    background: color,
                    opacity: 0.8,
                  }}
                />
              </div>
              <span
                className="mono"
                style={{ fontSize: 9.5, color: tokens.textFaint, flex: "none" }}
              >
                {a.calls} calls
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
