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
  /* null = every provider / every kind. Sent to the server, which narrows
   * `by_area` and `daily` in SQL — filtering client-side would leave the
   * "Peak" and call counts computed over rows the chart no longer draws. */
  const [provider, setProvider] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);

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
    queryKey: ["spend-summary", timeframe, provider, kind],
    queryFn: () => fetchSpendSummaryFiltered({ days: timeframe, provider, kind }),
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
  /* "0 limit hits" and "we could not ask" are different sentences. Without
   * this, a failed probe renders the reassuring green tick. */
  const limitHitsUnknown = limitHitsQ.data === undefined;

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

  /* An UNLINKED account has an unknown balance, not a zero one. The route
   * fills `balance_*: 0` for the three Mercury accounts and E&G because the
   * shape needs a number, but nothing has ever read them — rendering that as
   * "$0.00" tells Konrad his accounts are empty. Only a linked account
   * contributes to a total, and the tile says how many did. */
  const linkedAccounts = treasuryAccounts.filter(
    (a) => a.status === "active" || a.status === "manual",
  );
  const treasuryKnown = linkedAccounts.length > 0;
  const totalLiquidEur = linkedAccounts.reduce((s, a) => s + a.balance_eur, 0);
  const totalUsd = linkedAccounts.reduce((s, a) => s + a.balance_usd, 0);
  /* The published rate, with its provenance, or nothing. forge-control has no
   * FX feed — it ships a constant — so the rate is rendered with the word
   * "static" attached rather than as a quote. */
  const fxRate: number | null = bankData?.fx_rate_usd_eur ?? null;
  const fxNote =
    fxRate === null
      ? ""
      : ` (FX ${fxRate.toFixed(2)}${
          bankData?.fx_rate_source === "live_quote" ? "" : " · static, not a quote"
        })`;

  const ledgerSummary = ledgerData?.summary ?? null;
  const ledgerError = ledgerQ.isError ? (ledgerQ.error as Error).message : null;
  const bankError = bankQ.isError ? (bankQ.error as Error).message : null;
  const spendError = spendQ.isError ? (spendQ.error as Error).message : null;

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
              <span
                className="mono"
                style={{
                  fontSize: 24,
                  fontWeight: 600,
                  color: bankError || !treasuryKnown ? tokens.textFaint : tokens.textHi,
                }}
              >
                {bankError
                  ? "unreachable"
                  : treasuryKnown
                    ? eur(totalLiquidEur)
                    : "unknown"}
              </span>
              <span className="mono" style={{ fontSize: 12, color: tokens.textMuted }}>
                {bankError
                  ? bankError
                  : treasuryKnown
                    ? `≈ ${usd(totalUsd)}${fxNote}`
                    : "no account is linked yet — nothing has been read"}
              </span>
            </div>
          </div>
          <div className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            {linkedAccounts.length} of {treasuryAccounts.length} accounts linked ·
            Mercury API + Private Banking
          </div>
        </div>

        {/* 4 Accounts Grid. minmax(0, 1fr), not 1fr: a bare `1fr` floors at
            min-content, so the long "credential required…" status line pushed
            the fourth card past the container edge. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {treasuryAccounts.map((acc) => (
            <TreasuryCard key={acc.id} account={acc} unreachable={bankError} />
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
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <CashTile
            label="REVENUE IN (MTD)"
            error={ledgerError}
            value={ledgerSummary && `+${eur(ledgerSummary.totalInEur)}`}
            tone={tokens.ok}
            detail="Cash collected from clients & sales"
          />
          <CashTile
            label="EXPENSES OUT (MTD)"
            error={ledgerError}
            value={ledgerSummary && `-${eur(ledgerSummary.totalOutEur)}`}
            tone={tokens.bleed}
            detail="Operations, payroll & infra costs"
          />
          <CashTile
            label="NET CASHFLOW"
            error={ledgerError}
            value={
              ledgerSummary &&
              (ledgerSummary.netEur >= 0
                ? `+${eur(ledgerSummary.netEur)}`
                : `-${eur(Math.abs(ledgerSummary.netEur))}`)
            }
            tone={
              ledgerSummary && ledgerSummary.netEur < 0 ? tokens.bleed : tokens.ok
            }
            detail={
              ledgerSummary === null
                ? "no reading yet"
                : ledgerSummary.netEur >= 0
                  ? "Net positive cash trajectory"
                  : "Net operating outflow"
            }
          />
        </div>

        {/* Arm Segmented Distribution Bar */}
        <ArmDistributionBar byArm={ledgerSummary?.byArm ?? []} error={ledgerError} />
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

            {/* Provider × category filters. Options come from the response's
                own unfiltered pick lists, so they cannot drift from the data
                and cannot strand you on an empty selection. */}
            <FilterSelect
              label="provider"
              plural="providers"
              value={provider}
              options={spendData?.filters.providers ?? []}
              onChange={setProvider}
            />
            <FilterSelect
              label="category"
              plural="categories"
              value={kind}
              options={spendData?.filters.kinds ?? []}
              onChange={setKind}
            />
            {(provider || kind) && (
              <button
                onClick={() => {
                  setProvider(null);
                  setKind(null);
                }}
                className="mono"
                style={{
                  border: `1px solid ${tokens.border}`,
                  background: tokens.toolBg,
                  color: tokens.textMuted,
                  borderRadius: 5,
                  fontSize: 10,
                  padding: "3px 8px",
                  cursor: "pointer",
                }}
              >
                clear
              </button>
            )}
          </div>

          {/* Compact Quota Limit Hits Pill */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setSelectedLimitHits(!selectedLimitHits)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: `1px solid ${
                  limitHitsUnknown
                    ? tokens.borderSoft
                    : limitHits.length > 0
                      ? tokens.freezeBorderWarn
                      : tokens.freezeBorderOk
                }`,
                background: limitHitsUnknown
                  ? tokens.toolBg
                  : limitHits.length > 0
                    ? tokens.freezeBgWarn
                    : tokens.freezeBgOk,
                borderRadius: 14,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              <div
                style={dot(
                  limitHitsUnknown
                    ? tokens.textFaint
                    : limitHits.length > 0
                      ? tokens.warn
                      : tokens.ok,
                  !limitHitsUnknown && limitHits.length > 0,
                )}
              />
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: limitHitsUnknown
                    ? tokens.textFaint
                    : limitHits.length > 0
                      ? tokens.warn
                      : tokens.ok,
                }}
              >
                {limitHitsUnknown
                  ? "Claude limit hits — unknown"
                  : limitHits.length === 0
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
                  boxShadow: tokens.shadowPopover,
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
        <ComputeSummaryStrip spendData={spendData} error={spendError} />

        {(provider || kind) && (
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              marginBottom: 8,
              lineHeight: 1.4,
            }}
          >
            Filtered to {provider ?? "every provider"} × {kind ?? "every category"}.
            The three totals above stay portfolio-wide — only the chart and the
            breakdown below are narrowed.
          </div>
        )}

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
            isPending={spendQ.isPending}
            error={spendQ.isError ? (spendQ.error as Error).message : null}
            filterLabel={
              provider || kind
                ? `${provider ?? "all"} × ${kind ?? "all"}`
                : null
            }
          />

          {/* Area Breakdown */}
          <AreaBreakdown
            areas={spendData?.by_area ?? []}
            isPending={spendQ.isPending}
            error={spendQ.isError ? (spendQ.error as Error).message : null}
          />
        </div>
      </section>
    </div>
  );
}

/** ── Sub-Components ── */

/** A native select, styled to the console's chrome. `options` is whatever the
 *  server said exists in the window — an empty list disables the control
 *  rather than offering a choice of nothing. */
function FilterSelect({
  label,
  plural,
  value,
  options,
  onChange,
}: {
  label: string;
  /** Written out rather than `${label}s` — that produced "all categorys". */
  plural: string;
  value: string | null;
  options: string[];
  onChange: (next: string | null) => void;
}) {
  const active = value !== null;
  return (
    <select
      aria-label={label}
      value={value ?? "all"}
      disabled={options.length === 0}
      onChange={(e) => onChange(e.target.value === "all" ? null : e.target.value)}
      className="mono"
      style={{
        background: active ? tokens.primaryActionBg : tokens.bgCard,
        color: active ? tokens.accent : tokens.textMuted,
        border: `1px solid ${active ? tokens.accent : tokens.border}`,
        borderRadius: 6,
        fontSize: 10,
        padding: "3px 6px",
        cursor: options.length === 0 ? "default" : "pointer",
      }}
    >
      <option value="all">{`all ${plural}`}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** Pending and failed both have to look like themselves. An empty array
 *  rendered as "no data" would tell Konrad he spent nothing when in fact the
 *  API never answered. */
function ProbePanel({ text, tone }: { text: string; tone: string }) {
  return (
    <div
      className="mono"
      style={{
        background: tokens.bgCard,
        border: `1px dashed ${tokens.border}`,
        borderRadius: 8,
        padding: 24,
        fontSize: 10.5,
        color: tone,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

/** One cashflow figure, or the reason there isn't one. `value === null` means
 *  the ledger has not answered yet; `error` means it failed. Neither renders
 *  as €0.00 — a zero here would read as "no money moved", which is a
 *  materially different claim from "we could not look". */
function CashTile({
  label,
  value,
  detail,
  tone,
  error,
}: {
  label: string;
  value: string | null;
  detail: string;
  tone: string;
  error: string | null;
}) {
  const unresolved = error !== null || value === null;
  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: error ? tokens.bleed : unresolved ? tokens.textFaint : tone,
          marginTop: 4,
        }}
      >
        {error ? "unreachable" : (value ?? "reading…")}
      </div>
      <div
        className="mono"
        title={error ?? detail}
        style={{
          fontSize: 10,
          color: tokens.textMuted,
          marginTop: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {error ?? detail}
      </div>
    </div>
  );
}

function TreasuryCard({
  account,
  unreachable,
}: {
  account: BankAccount;
  unreachable: string | null;
}) {
  const isUsd = account.currency === "USD";
  const linked = account.status === "active" || account.status === "manual";
  const statusColor =
    account.status === "active"
      ? tokens.ok
      : account.status === "manual"
      ? tokens.info
      : tokens.warn;

  /* An unlinked account's balance fields are placeholders the route had to
   * fill, not readings. Formatting them as currency is the single most
   * misleading thing this surface could do. */
  const nativeFormatted = unreachable
    ? "unreachable"
    : !linked
      ? "not linked"
      : isUsd
        ? usd(account.balance_usd)
        : eur(account.balance_eur);

  const convertedFormatted = unreachable
    ? unreachable
    : !linked
      ? (account.status_detail ?? "no balance has been read")
      : isUsd
        ? `≈ ${eur(account.balance_eur)}`
        : `≈ ${usd(account.balance_usd)}`;

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
        <div
          className="mono"
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: unreachable
              ? tokens.bleed
              : linked
                ? tokens.textHi
                : tokens.textFaint,
          }}
        >
          {nativeFormatted}
        </div>
        <div
          className="mono"
          title={convertedFormatted}
          style={{
            fontSize: 10,
            color: tokens.textMuted,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {convertedFormatted}
        </div>
      </div>
    </div>
  );
}

function ArmDistributionBar({
  byArm,
  error,
}: {
  byArm: LedgerSummaryResponse["summary"]["byArm"];
  error: string | null;
}) {
  if (error) {
    return (
      <div
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px dashed ${tokens.dangerActionBorder}`,
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 10.5,
          color: tokens.bleed,
        }}
      >
        Ledger unreachable: {error}
      </div>
    );
  }
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

/** The three headline compute figures. They are ALWAYS the whole portfolio —
 *  the provider/category filter narrows the chart below, never these. */
function ComputeSummaryStrip({
  spendData,
  error,
}: {
  spendData: SpendSummaryResponse | null;
  error: string | null;
}) {
  const tiles: Array<{ label: string; tone: string; value: string; detail: string }> =
    spendData === null
      ? [
          { label: "METERED BILLED (REAL CASH)", tone: tokens.textHi, value: "", detail: "" },
          { label: "CLAUDE SHADOW (SUBSCRIPTION)", tone: tokens.stuck, value: "", detail: "" },
          { label: "TOTAL COMPUTE FOOTPRINT", tone: tokens.accent, value: "", detail: "" },
        ]
      : [
          {
            label: "METERED BILLED (REAL CASH)",
            tone: tokens.textHi,
            value: eur(spendData.d30.total_eur),
            detail: `Today: ${eur(spendData.today.total_eur)} · ${spendData.d30.calls} billed calls`,
          },
          {
            label: "CLAUDE SHADOW (SUBSCRIPTION)",
            tone: tokens.stuck,
            value: eur(spendData.d30.claude_eur),
            detail: `Today: ${eur(spendData.today.claude_eur)} · ${spendData.d30.claude_calls} calls`,
          },
          {
            label: "TOTAL COMPUTE FOOTPRINT",
            tone: tokens.accent,
            value: eur(spendData.d30.total_eur + spendData.d30.claude_eur),
            detail: `Today: ${eur(spendData.today.total_eur + spendData.today.claude_eur)} (Shadow + Metered)`,
          },
        ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 10,
        marginBottom: 8,
      }}
    >
      {tiles.map((t) => (
        <div
          key={t.label}
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <div className="mono" style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" }}>
            {t.label}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: error ? tokens.bleed : spendData ? t.tone : tokens.textFaint,
              marginTop: 3,
            }}
          >
            {error ? "unreachable" : spendData ? t.value : "reading…"}
          </div>
          <div
            className="mono"
            title={error ?? t.detail}
            style={{
              fontSize: 9.5,
              color: tokens.textMuted,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {error ?? (spendData ? t.detail : "waiting on the first reading")}
          </div>
        </div>
      ))}
    </div>
  );
}

function InteractiveDailyChart({
  daily,
  mode,
  timeframe,
  isPending,
  error,
  filterLabel,
}: {
  daily: SpendDailyItem[];
  mode: ComputeMode;
  timeframe: number;
  isPending: boolean;
  error: string | null;
  filterLabel: string | null;
}) {
  const [hoveredDay, setHoveredDay] = useState<SpendDailyItem | null>(null);

  if (error) return <ProbePanel text={`Spend series unreachable: ${error}`} tone={tokens.bleed} />;
  if (isPending) return <ProbePanel text="reading the compute series…" tone={tokens.textFaint} />;

  if (daily.length === 0) {
    return (
      <ProbePanel
        text={
          filterLabel
            ? `No compute logs matching ${filterLabel} in the selected ${timeframe}-day window.`
            : `No compute logs recorded in the selected ${timeframe}-day window.`
        }
        tone={tokens.textFaint}
      />
    );
  }

  const CHART_H = 140;

  const getDayValue = (d: SpendDailyItem) => {
    if (mode === "metered") return d.total_eur;
    if (mode === "shadow") return d.shadow_eur;
    return d.total_compute_eur;
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
              ({hoveredDay.calls} calls · Metered: {eur(hoveredDay.total_eur)} · Shadow: {eur(hoveredDay.shadow_eur)})
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

function AreaBreakdown({
  areas,
  isPending,
  error,
}: {
  areas: SpendAreaItem[];
  isPending: boolean;
  error: string | null;
}) {
  if (error) return <ProbePanel text={`Breakdown unreachable: ${error}`} tone={tokens.bleed} />;
  if (isPending) return <ProbePanel text="reading the breakdown…" tone={tokens.textFaint} />;
  if (areas.length === 0) {
    return <ProbePanel text="No breakdown telemetry recorded." tone={tokens.textFaint} />;
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
