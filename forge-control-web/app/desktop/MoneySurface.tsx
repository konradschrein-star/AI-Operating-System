"use client";

import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchBankAccounts,
  fetchLedgerSummary,
  fetchSpendSummaryFiltered,
  type BankAccount,
  type BankBalancesResponse,
  type LedgerSummaryResponse,
  type SpendSummaryResponse,
  type SpendDailyItem,
  type SpendAreaItem,
} from "../api-business";
import { fetchLimitHits, type LimitHit } from "../api";

const DAILY_ALERT_EUR = 15;

const eur = (v: number) =>
  `€${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ARM_COLORS: Record<string, string> = {
  axtrelis: tokens.accent,
  youtube: tokens.warn,
  infra: tokens.info,
  personal: tokens.stuck,
  directory: tokens.decide,
  other: tokens.textMuted,
};

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

type TimeframeOption = 7 | 14 | 30 | 90;
type ComputeMode = "all" | "metered" | "shadow";

export function MoneySurface() {
  const [timeframe, setTimeframe] = useState<TimeframeOption>(30);
  const [computeMode, setComputeMode] = useState<ComputeMode>("all");
  const [selectedLimitHits, setSelectedLimitHits] = useState(false);

  // Queries
  const bankQ = useQuery({
    queryKey: ["bank-balances"],
    queryFn: fetchBankAccounts,
    refetchInterval: 60_000,
  });

  const ledgerQ = useQuery({
    queryKey: ["ledger-summary", timeframe],
    queryFn: () => fetchLedgerSummary(timeframe),
    refetchInterval: 60_000,
  });

  const spendQ = useQuery({
    queryKey: ["spend-summary", timeframe],
    queryFn: () => fetchSpendSummaryFiltered(timeframe),
    refetchInterval: 60_000,
  });

  const limitHitsQ = useQuery({
    queryKey: ["spend-limit-hits"],
    queryFn: () => fetchLimitHits(14),
    refetchInterval: 60_000,
  });

  const bankData: BankBalancesResponse | null = bankQ.data ?? null;
  const ledgerData: LedgerSummaryResponse | null = ledgerQ.data ?? null;
  const spendData: SpendSummaryResponse | null = spendQ.data ?? null;
  const limitHits: LimitHit[] = limitHitsQ.data ?? [];

  // 4 Standard Treasury Accounts normalization
  const treasuryAccounts = useMemo(() => {
    const rawList = bankData?.accounts ?? [];

    const findOrCreate = (
      idPrefix: string,
      defaultName: string,
      type: BankAccount["type"],
      currency: "USD" | "EUR",
      institution: "mercury" | "eg_bank",
    ): BankAccount => {
      const match = rawList.find(
        (a) =>
          a.id.toLowerCase().includes(idPrefix) ||
          a.name.toLowerCase().includes(idPrefix),
      );
      if (match) return match;

      return {
        id: `${institution}-${idPrefix}`,
        name: defaultName,
        institution,
        account_number_mask: null,
        type,
        currency,
        current_balance: 0,
        available_balance: 0,
        balance_usd: 0,
        balance_eur: 0,
        status: "unlinked",
        status_detail: "Unlinked",
        last_synced_at: null,
      };
    };

    return [
      findOrCreate("operating", "Mercury Operating", "checking", "USD", "mercury"),
      findOrCreate("treasury", "Mercury Treasury", "treasury", "USD", "mercury"),
      findOrCreate("tax-reserve", "Mercury Tax Reserve", "savings", "USD", "mercury"),
      findOrCreate("eg-bank", "E&G Private Bank", "private_banking", "EUR", "eg_bank"),
    ];
  }, [bankData]);

  const totalLiquidEur = bankData?.total_liquid_eur ?? treasuryAccounts.reduce((s, a) => s + (a.balance_eur || 0), 0);
  const totalUsd = bankData?.total_usd ?? treasuryAccounts.reduce((s, a) => s + (a.balance_usd || 0), 0);
  const fxRate = bankData?.fx_rate_usd_eur ?? 1.08;

  const ledgerSummary = ledgerData?.summary ?? {
    since: "",
    until: "",
    byArm: [],
    totalInEur: 0,
    totalOutEur: 0,
    netEur: 0,
    shadowEur: 0,
    unconvertedRows: 0,
  };

  const isLoading = bankQ.isLoading || ledgerQ.isLoading || spendQ.isLoading;

  return (
    <div className="slidein" style={{ padding: "16px 20px 48px", maxWidth: 1180, margin: "0 auto" }}>
      {/* Surface Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 16,
          borderBottom: `1px solid ${tokens.borderDivider}`,
          paddingBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi }}>
            Money & Treasury
          </span>
          <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            Live Balances · Cashflow · AI Compute
          </span>
        </div>
        {isLoading && (
          <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
            refreshing…
          </span>
        )}
      </div>

      {/* ── TOP SECTION: Treasury & Bank Balances Strip ── */}
      <section style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginBottom: 10,
          }}
        >
          <div>
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textFaint, letterSpacing: "0.08em" }}
            >
              TOTAL LIQUID TREASURY
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 2 }}>
              <span className="mono" style={{ fontSize: 24, fontWeight: 600, color: tokens.textHi }}>
                {eur(totalLiquidEur)}
              </span>
              <span className="mono" style={{ fontSize: 12, color: tokens.textMuted }}>
                ≈ {usd(totalUsd)} (FX: {fxRate.toFixed(2)})
              </span>
            </div>
          </div>
          <div className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            4 Accounts · Mercury API + Private Banking
          </div>
        </div>

        {/* 4 Accounts Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 10,
          }}
        >
          {treasuryAccounts.map((acc) => (
            <TreasuryCard key={acc.id} account={acc} fxRate={fxRate} />
          ))}
        </div>
      </section>

      {/* ── MIDDLE SECTION: Cashflow & Ledger Summary ── */}
      <section style={{ marginBottom: 24 }}>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          CASHFLOW & LEDGER · LAST {timeframe} DAYS
        </div>

        {/* 3 High-Density Tiles */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "12px 14px",
            }}
          >
            <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
              REVENUE IN (MTD)
            </div>
            <div
              className="mono"
              style={{ fontSize: 20, fontWeight: 600, color: tokens.ok, marginTop: 4 }}
            >
              +{eur(ledgerSummary.totalInEur)}
            </div>
            <div className="mono" style={{ fontSize: 10, color: tokens.textMuted, marginTop: 4 }}>
              Cash collected from clients & sales
            </div>
          </div>

          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "12px 14px",
            }}
          >
            <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
              EXPENSES OUT (MTD)
            </div>
            <div
              className="mono"
              style={{ fontSize: 20, fontWeight: 600, color: tokens.bleed, marginTop: 4 }}
            >
              -{eur(ledgerSummary.totalOutEur)}
            </div>
            <div className="mono" style={{ fontSize: 10, color: tokens.textMuted, marginTop: 4 }}>
              Operations, payroll & infra costs
            </div>
          </div>

          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "12px 14px",
            }}
          >
            <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
              NET CASHFLOW
            </div>
            <div
              className="mono"
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: ledgerSummary.netEur >= 0 ? tokens.ok : tokens.bleed,
                marginTop: 4,
              }}
            >
              {ledgerSummary.netEur >= 0 ? `+${eur(ledgerSummary.netEur)}` : `-${eur(Math.abs(ledgerSummary.netEur))}`}
            </div>
            <div className="mono" style={{ fontSize: 10, color: tokens.textMuted, marginTop: 4 }}>
              {ledgerSummary.netEur >= 0 ? "Net positive cash trajectory" : "Net operating outflow"}
            </div>
          </div>
        </div>

        {/* Arm Segmented Distribution Bar */}
        <ArmDistributionBar byArm={ledgerSummary.byArm} />
      </section>

      {/* ── BOTTOM SECTION: Shrunk AI Compute Cockpit ── */}
      <section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.textFaint,
                letterSpacing: "0.1em",
              }}
            >
              AI COMPUTE COCKPIT
            </span>

            {/* Timeframe selector */}
            <div
              style={{
                display: "inline-flex",
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                padding: 2,
                gap: 2,
              }}
            >
              {([7, 14, 30, 90] as TimeframeOption[]).map((days) => (
                <button
                  key={days}
                  onClick={() => setTimeframe(days)}
                  style={{
                    border: "none",
                    borderRadius: 4,
                    background: timeframe === days ? tokens.borderEmphasis : "transparent",
                    color: timeframe === days ? tokens.textHi : tokens.textMuted,
                    fontSize: 10,
                    fontFamily: "monospace",
                    padding: "3px 8px",
                    cursor: "pointer",
                  }}
                >
                  {days}D
                </button>
              ))}
            </div>

            {/* Mode toggle */}
            <div
              style={{
                display: "inline-flex",
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                padding: 2,
                gap: 2,
              }}
            >
              <button
                onClick={() => setComputeMode("all")}
                style={{
                  border: "none",
                  borderRadius: 4,
                  background: computeMode === "all" ? tokens.primaryActionBg : "transparent",
                  color: computeMode === "all" ? tokens.accent : tokens.textMuted,
                  fontSize: 10,
                  fontFamily: "monospace",
                  padding: "3px 8px",
                  cursor: "pointer",
                }}
              >
                All Compute (Shadow + Metered)
              </button>
              <button
                onClick={() => setComputeMode("metered")}
                style={{
                  border: "none",
                  borderRadius: 4,
                  background: computeMode === "metered" ? tokens.primaryActionBg : "transparent",
                  color: computeMode === "metered" ? tokens.accent : tokens.textMuted,
                  fontSize: 10,
                  fontFamily: "monospace",
                  padding: "3px 8px",
                  cursor: "pointer",
                }}
              >
                Metered Only
              </button>
              <button
                onClick={() => setComputeMode("shadow")}
                style={{
                  border: "none",
                  borderRadius: 4,
                  background: computeMode === "shadow" ? tokens.primaryActionBg : "transparent",
                  color: computeMode === "shadow" ? tokens.stuck : tokens.textMuted,
                  fontSize: 10,
                  fontFamily: "monospace",
                  padding: "3px 8px",
                  cursor: "pointer",
                }}
              >
                Shadow Only
              </button>
            </div>
          </div>

          {/* Compact Quota Limit Hits Pill */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setSelectedLimitHits(!selectedLimitHits)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: `1px solid ${limitHits.length > 0 ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
                background: limitHits.length > 0 ? tokens.freezeBgWarn : tokens.freezeBgOk,
                borderRadius: 14,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              <div
                style={dot(
                  limitHits.length > 0 ? tokens.warn : tokens.ok,
                  limitHits.length > 0,
                )}
              />
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: limitHits.length > 0 ? tokens.warn : tokens.ok,
                }}
              >
                {limitHits.length === 0
                  ? "✓ 0 Claude limit hits (14d)"
                  : `⚠ ${limitHits.length} limit hits in 14d`}
              </span>
            </button>

            {selectedLimitHits && limitHits.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  marginTop: 6,
                  zIndex: 30,
                  width: 320,
                  background: tokens.bgCard,
                  border: `1px solid ${tokens.borderEmphasis}`,
                  borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                  padding: 12,
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: tokens.warn,
                    marginBottom: 8,
                  }}
                >
                  RECENT CLAUDE LIMIT HITS (14D)
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  {limitHits.map((h, i) => (
                    <div
                      key={h.run_id + h.ts + i}
                      style={{
                        padding: "6px 0",
                        borderBottom: i === limitHits.length - 1 ? "none" : `1px solid ${tokens.borderDivider}`,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5 }}>
                        <span className="mono" style={{ color: tokens.textMuted }}>
                          {new Date(h.ts).toLocaleString()}
                        </span>
                        <span className="mono" style={{ color: tokens.warn }}>
                          hit
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: tokens.textSecondary, marginTop: 2 }}>
                        {h.message}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Compute Totals Bar */}
        <ComputeSummaryStrip spendData={spendData} mode={computeMode} />

        {/* Chart + Breakdown 2-Column Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 1fr",
            gap: 14,
            alignItems: "start",
            marginTop: 12,
          }}
        >
          {/* Daily Interactive Bar Chart */}
          <InteractiveDailyChart
            daily={spendData?.daily ?? []}
            mode={computeMode}
            timeframe={timeframe}
          />

          {/* Area Breakdown */}
          <AreaBreakdown areas={spendData?.by_area ?? []} />
        </div>
      </section>
    </div>
  );
}

/** ── Sub-Components ── */

function TreasuryCard({ account, fxRate }: { account: BankAccount; fxRate: number }) {
  const isUsd = account.currency === "USD";
  const statusColor =
    account.status === "active"
      ? tokens.ok
      : account.status === "manual"
      ? tokens.info
      : tokens.warn;

  const nativeFormatted = isUsd
    ? usd(account.balance_usd ?? account.current_balance)
    : eur(account.balance_eur ?? account.current_balance);

  const convertedFormatted = isUsd
    ? `≈ ${eur(account.balance_eur || (account.balance_usd || 0) / fxRate)}`
    : `≈ ${usd(account.balance_usd || (account.balance_eur || 0) * fxRate)}`;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "11px 13px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textFaint,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {account.institution === "mercury" ? "Mercury" : "E&G Bank"} · {account.type.replace("_", " ")}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={dot(statusColor)} />
            <span className="mono" style={{ fontSize: 8.5, color: tokens.textFaint }}>
              {account.status}
            </span>
          </div>
        </div>

        <div style={{ fontSize: 12, fontWeight: 500, color: tokens.textHi, marginTop: 4 }}>
          {account.name}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: tokens.textHi }}>
          {nativeFormatted}
        </div>
        <div
          className="mono"
          style={{ fontSize: 10, color: tokens.textMuted, marginTop: 2 }}
        >
          {convertedFormatted}
        </div>
      </div>
    </div>
  );
}

function ArmDistributionBar({ byArm }: { byArm: LedgerSummaryResponse["summary"]["byArm"] }) {
  if (!byArm || byArm.length === 0) {
    return (
      <div
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px dashed ${tokens.border}`,
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 10.5,
          color: tokens.textFaint,
        }}
      >
        No recent ledger arm transactions recorded in this timeframe.
      </div>
    );
  }

  const totalVol = byArm.reduce((s, a) => s + (Math.abs(a.inEur) + Math.abs(a.outEur)), 0) || 1;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "10px 14px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
          BUSINESS ARM CASH DISTRIBUTION
        </span>
        <span className="mono" style={{ fontSize: 9, color: tokens.textFaint }}>
          {byArm.length} arms active
        </span>
      </div>

      {/* Segmented Bar */}
      <div
        style={{
          display: "flex",
          height: 6,
          borderRadius: 3,
          overflow: "hidden",
          background: tokens.borderDivider,
          marginBottom: 8,
        }}
      >
        {byArm.map((arm) => {
          const armVol = Math.abs(arm.inEur) + Math.abs(arm.outEur);
          const pct = Math.max((armVol / totalVol) * 100, 2);
          const color = ARM_COLORS[arm.arm.toLowerCase()] || tokens.textMuted;
          return (
            <div
              key={arm.arm}
              title={`${arm.arm}: In +${eur(arm.inEur)}, Out -${eur(arm.outEur)}, Net ${eur(arm.netEur)}`}
              style={{
                width: `${pct}%`,
                background: color,
                height: "100%",
                borderRight: `1px solid ${tokens.bgCard}`,
              }}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {byArm.map((arm) => {
          const color = ARM_COLORS[arm.arm.toLowerCase()] || tokens.textMuted;
          return (
            <div key={arm.arm} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
              <span className="mono" style={{ fontSize: 10, color: tokens.textLabel, textTransform: "capitalize" }}>
                {arm.arm}:
              </span>
              <span className="mono" style={{ fontSize: 10, color: arm.netEur >= 0 ? tokens.ok : tokens.bleed }}>
                {arm.netEur >= 0 ? `+${eur(arm.netEur)}` : `-${eur(Math.abs(arm.netEur))}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ComputeSummaryStrip({
  spendData,
  mode,
}: {
  spendData: SpendSummaryResponse | null;
  mode: ComputeMode;
}) {
  const meteredToday = spendData?.today.total_eur ?? 0;
  const shadowToday = spendData?.today.claude_eur ?? 0;
  const totalComputeToday = meteredToday + shadowToday;

  const meteredD30 = spendData?.d30.total_eur ?? 0;
  const shadowD30 = spendData?.d30.claude_eur ?? 0;
  const totalComputeD30 = meteredD30 + shadowD30;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 10,
        marginBottom: 8,
      }}
    >
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: "10px 12px",
        }}
      >
        <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
          METERED BILLED (REAL CASH)
        </div>
        <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: tokens.textHi, marginTop: 3 }}>
          {eur(meteredD30)}
        </div>
        <div className="mono" style={{ fontSize: 9.5, color: tokens.textMuted, marginTop: 2 }}>
          Today: {eur(meteredToday)} · {spendData?.d30.calls ?? 0} billed calls
        </div>
      </div>

      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: "10px 12px",
        }}
      >
        <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
          CLAUDE SHADOW (SUBSCRIPTION)
        </div>
        <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: tokens.stuck, marginTop: 3 }}>
          {eur(shadowD30)}
        </div>
        <div className="mono" style={{ fontSize: 9.5, color: tokens.textMuted, marginTop: 2 }}>
          Today: {eur(shadowToday)} · {spendData?.d30.claude_calls ?? 0} calls
        </div>
      </div>

      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: "10px 12px",
        }}
      >
        <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
          TOTAL COMPUTE FOOTPRINT
        </div>
        <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: tokens.accent, marginTop: 3 }}>
          {eur(totalComputeD30)}
        </div>
        <div className="mono" style={{ fontSize: 9.5, color: tokens.textMuted, marginTop: 2 }}>
          Today: {eur(totalComputeToday)} (Shadow + Metered)
        </div>
      </div>
    </div>
  );
}

function InteractiveDailyChart({
  daily,
  mode,
  timeframe,
}: {
  daily: SpendDailyItem[];
  mode: ComputeMode;
  timeframe: number;
}) {
  const [hoveredDay, setHoveredDay] = useState<SpendDailyItem | null>(null);

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
        No compute logs recorded in the selected {timeframe}-day window.
      </div>
    );
  }

  const CHART_H = 140;

  const getDayValue = (d: SpendDailyItem) => {
    if (mode === "metered") return d.total_eur;
    if (mode === "shadow") return d.shadow_eur ?? 0;
    return d.total_compute_eur ?? (d.total_eur + (d.shadow_eur ?? 0));
  };

  const values = daily.map(getDayValue);
  const max = Math.max(...values, 0.01);
  const showAlertLine = mode !== "shadow" && max >= DAILY_ALERT_EUR * 0.5;
  const alertY = Math.min((DAILY_ALERT_EUR / max) * CHART_H, CHART_H);

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "12px 14px 8px",
        position: "relative",
      }}
    >
      {/* Tooltip Header / Active Hover Bar Info */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          minHeight: 20,
          marginBottom: 8,
        }}
      >
        <span className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
          DAILY COMPUTE SERIES · {mode.toUpperCase()}
        </span>
        {hoveredDay ? (
          <div className="mono" style={{ fontSize: 10.5, color: tokens.textHi }}>
            <span style={{ color: tokens.accent }}>{hoveredDay.day}</span>:{" "}
            <span style={{ color: tokens.textHi }}>
              {eur(getDayValue(hoveredDay))}
            </span>{" "}
            <span style={{ color: tokens.textMuted }}>
              ({hoveredDay.calls} calls · Metered: {eur(hoveredDay.total_eur)} · Shadow: {eur(hoveredDay.shadow_eur ?? 0)})
            </span>
          </div>
        ) : (
          <span className="mono" style={{ fontSize: 9, color: tokens.textFaint }}>
            hover a bar for details
          </span>
        )}
      </div>

      {/* Bar container */}
      <div
        style={{
          position: "relative",
          height: CHART_H,
          display: "flex",
          alignItems: "flex-end",
          gap: daily.length > 45 ? 1 : 3,
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
              opacity: 0.6,
              pointerEvents: "none",
            }}
          />
        )}

        {daily.map((d) => {
          const val = getDayValue(d);
          const h = Math.max((val / max) * CHART_H, val > 0 ? 3 : 1);
          const isHot = mode !== "shadow" && d.total_eur > DAILY_ALERT_EUR;
          const isHovered = hoveredDay?.day === d.day;

          let barBg = tokens.accent;
          if (mode === "shadow") barBg = tokens.stuck;
          else if (isHot) barBg = tokens.warn;

          return (
            <div
              key={d.day}
              onMouseEnter={() => setHoveredDay(d)}
              onMouseLeave={() => setHoveredDay(null)}
              style={{
                flex: 1,
                minWidth: 0,
                height: Math.max(h, 1),
                background: barBg,
                opacity: isHovered ? 1 : val > 0 ? 0.85 : 0.2,
                borderRadius: "2px 2px 0 0",
                cursor: "pointer",
                transition: "opacity 0.1s ease",
              }}
            />
          );
        })}
      </div>

      {/* X-axis labels */}
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9,
          color: tokens.textFaint,
          paddingTop: 6,
        }}
      >
        <span>{daily[0].day.slice(5)}</span>
        <span>Peak {eur(max)}</span>
        <span>{daily[daily.length - 1].day.slice(5)}</span>
      </div>
    </div>
  );
}

function AreaBreakdown({ areas }: { areas: SpendAreaItem[] }) {
  if (areas.length === 0) {
    return (
      <div
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px dashed ${tokens.border}`,
          borderRadius: 8,
          padding: 24,
          fontSize: 10.5,
          color: tokens.textFaint,
          textAlign: "center",
        }}
      >
        No breakdown telemetry recorded.
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
      <div
        className="mono"
        style={{
          fontSize: 9,
          color: tokens.textFaint,
          letterSpacing: "0.06em",
          padding: "8px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
        }}
      >
        WHERE IT GOES · PROVIDER × KIND
      </div>
      <div style={{ maxHeight: 180, overflowY: "auto" }}>
        {areas.map((a, i) => {
          const color = kindColor(a.kind);
          const isLast = i === areas.length - 1;
          return (
            <div
              key={`${a.provider}-${a.kind}`}
              style={{
                padding: "7px 12px",
                borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, color: tokens.textLabel }}>
                  {a.provider}
                </span>
                <span className="mono" style={{ fontSize: 9, color }}>
                  {a.kind}
                </span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 11, color: tokens.textHi }}>
                  {eur(a.total_eur)}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 3,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    height: 3,
                    borderRadius: 1.5,
                    background: tokens.borderDivider,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max((a.total_eur / max) * 100, 1)}%`,
                      height: "100%",
                      background: color,
                      opacity: 0.85,
                    }}
                  />
                </div>
                <span className="mono" style={{ fontSize: 9, color: tokens.textFaint, flex: "none" }}>
                  {a.calls} calls
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
