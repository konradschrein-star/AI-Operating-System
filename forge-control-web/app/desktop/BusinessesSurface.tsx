"use client";

/**
 * BusinessesSurface — Executive portfolio cockpit and venture command center.
 *
 * Visualizes Konrad's 4 core ventures with high-impact venture cards,
 * live telemetry probes (entities identity registry, content_jobs pipeline),
 * one-click launchpad actions, and cross-portfolio bottleneck resolution.
 *
 * PROVENANCE IS PART OF THE RENDER. Every number on this surface is one of
 * two things and says which:
 *   LIVE    — read from an API this render, badged `LIVE`;
 *   STATED  — a business fact transcribed into businesses-inventory.ts from
 *             the vault, badged `STATED`.
 * A live reading that has not arrived renders `probing…`; one whose fetch
 * failed renders `unreachable` with the error. It NEVER renders as a number.
 * Round 2 shipped `{total: 5, stalled: 5, qcCount: 5}` as the pipeline's
 * pending/failed default — the live values of that hour, frozen into the
 * source, indistinguishable on screen from a real reading. That is the whole
 * reason `Probe<T>` below exists: a fallback number is a lie with a timestamp.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  fetchPipelineBusiness,
  fetchEntitiesSummary,
  type BusinessPipelineResponse,
  type EntitiesSummaryResponse,
} from "../api-business";
import {
  VENTURES,
  CROSS_PORTFOLIO_BOTTLENECKS,
  type Venture,
  type VentureKey,
  type VentureStatus,
  type LaunchpadLink,
  type VentureProperty,
  type BottleneckItem,
} from "./businesses-inventory";

const STATUS_CONFIG: Record<
  VentureStatus,
  { label: string; fg: string; bg: string; border: string }
> = {
  active: {
    label: "Active Production",
    fg: tokens.ok,
    bg: tokens.okActionBg,
    border: tokens.okActionBorder,
  },
  pre_launch: {
    label: "Pre-Launch",
    fg: tokens.warn,
    bg: tokens.freezeBgWarn,
    border: tokens.freezeBorderWarn,
  },
  paused: {
    label: "Paused",
    fg: tokens.textFaint,
    bg: tokens.toolBg,
    border: tokens.borderSoft,
  },
  dormant: {
    label: "Dormant",
    fg: tokens.textGhost,
    bg: tokens.toolBg,
    border: tokens.borderSoft,
  },
};

/** Tones for the stated metrics, in slot order — the same reading order the
 *  round-2 card had (headline, secondary, pricing) without hardcoding which
 *  venture gets which. */
const STATED_TONES = [tokens.textHi, tokens.stuck, tokens.accent];

const SEVERITY_CONFIG: Record<
  BottleneckItem["severity"],
  { label: string; fg: string; bg: string; border: string }
> = {
  critical: {
    label: "CRITICAL STALL",
    fg: tokens.bleed,
    bg: tokens.dangerActionBg,
    border: tokens.dangerActionBorder,
  },
  warning: {
    label: "ACTION NEEDED",
    fg: tokens.warn,
    bg: tokens.freezeBgWarn,
    border: tokens.freezeBorderWarn,
  },
  info: {
    label: "INFO / STRATEGIC",
    fg: tokens.textMuted,
    bg: tokens.toolBg,
    border: tokens.borderSoft,
  },
};

/**
 * The three states a live reading can be in. There is deliberately no fourth
 * state carrying a "default" value: a caller that wants a number has to name
 * what it renders when there isn't one.
 */
type Probe<T> =
  | { state: "pending" }
  | { state: "error"; message: string }
  | { state: "ok"; value: T };

interface PipelineReading {
  total: number;
  stalled: number;
  /** null when the server reports no `qc` phase at all — NOT a zero, and not
   *  `stalled_total` standing in for it. */
  qcCount: number | null;
  thresholdHours: number;
}

interface DirectoryReading {
  /** `kind = 'company'` rows on the directory arm. A real 0 stays 0. */
  companies: number;
  /** All rows on the arm, companies + persons. */
  total: number;
}

export function BusinessesSurface() {
  const [filter, setFilter] = useState<"all" | "active" | "other">("all");

  // Live query for YouTube / Creator pipeline
  const pipelineQ = useQuery<BusinessPipelineResponse, Error>({
    queryKey: ["business", "pipeline"],
    queryFn: fetchPipelineBusiness,
    refetchInterval: 30_000,
    retry: 1,
  });

  // Live query for Entities / Directory prospects
  const entitiesQ = useQuery<EntitiesSummaryResponse, Error>({
    queryKey: ["business", "entities-summary"],
    queryFn: fetchEntitiesSummary,
    refetchInterval: 60_000,
    retry: 1,
  });

  const filteredVentures = useMemo(() => {
    if (filter === "active") return VENTURES.filter((v) => v.status === "active");
    if (filter === "other") return VENTURES.filter((v) => v.status !== "active");
    return VENTURES;
  }, [filter]);

  /* Counted from the inventory, never typed into a label — a fifth venture
   * would otherwise land on a page still announcing four. */
  const activeCount = VENTURES.filter((v) => v.status === "active").length;
  const otherCount = VENTURES.length - activeCount;

  /* `by_arm` is grouped server-side, so an arm with no rows is ABSENT from the
   * map rather than present as 0 — absent therefore means "the registry
   * answered, and it holds nothing for this arm", which is a real 0. What must
   * never happen is `companies || total || <a number from last week>`: `||`
   * cannot tell a genuine 0 from a missing reading, and round 2's version
   * overwrote a real zero with a hardcoded 1053 while still badging it LIVE. */
  const directoryProbe = useMemo<Probe<DirectoryReading>>(() => {
    if (entitiesQ.data) {
      const arm = entitiesQ.data.by_arm?.directory;
      return {
        state: "ok",
        value: { companies: arm?.companies ?? 0, total: arm?.total ?? 0 },
      };
    }
    if (entitiesQ.isError) {
      return {
        state: "error",
        message: entitiesQ.error?.message ?? "entities registry unreachable",
      };
    }
    return { state: "pending" };
  }, [entitiesQ.data, entitiesQ.isError, entitiesQ.error]);

  const pipelineProbe = useMemo<Probe<PipelineReading>>(() => {
    if (pipelineQ.data) {
      const qcPhase = pipelineQ.data.phases.find((p) => p.key === "qc");
      return {
        state: "ok",
        value: {
          total: pipelineQ.data.total,
          stalled: pipelineQ.data.stalled_total,
          qcCount: qcPhase ? qcPhase.count : null,
          thresholdHours: pipelineQ.data.stall_threshold_hours,
        },
      };
    }
    if (pipelineQ.isError) {
      return {
        state: "error",
        message: pipelineQ.error?.message ?? "pipeline probe unreachable",
      };
    }
    return { state: "pending" };
  }, [pipelineQ.data, pipelineQ.isError, pipelineQ.error]);

  return (
    <div
      className="slidein"
      style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 28px 48px" }}
    >
      {/* ═══ Header & Portfolio Overview Strip ═══ */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: tokens.textHi }}>
              Businesses & Ventures
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.accent,
                background: tokens.primaryActionBg,
                border: `1px solid ${tokens.accent}`,
                borderRadius: 4,
                padding: "2px 6px",
              }}
            >
              {VENTURES.length} PORTFOLIO ARMS
            </span>
          </div>
          <div
            style={{
              color: tokens.textMuted,
              fontSize: 12.5,
              marginTop: 4,
              lineHeight: 1.45,
            }}
          >
            Executive venture cockpit: active commercial operations, live telemetry, key next actions, and launchpads.
          </div>
        </div>

        {/* View Filter Pill */}
        <div
          className="mono"
          style={{
            display: "inline-flex",
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 7,
            padding: 3,
            gap: 4,
            fontSize: 11,
          }}
        >
          <button
            type="button"
            onClick={() => setFilter("all")}
            style={filterBtnStyle(filter === "all")}
          >
            All Ventures ({VENTURES.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter("active")}
            style={filterBtnStyle(filter === "active")}
          >
            Active Commercial ({activeCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter("other")}
            style={filterBtnStyle(filter === "other")}
          >
            Pre-Launch / Paused ({otherCount})
          </button>
        </div>
      </div>

      {/* ═══ Portfolio Status Strip ═══ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 22,
        }}
      >
        <PortfolioSummaryTile
          title="Active Ventures"
          origin="stated"
          value={`${activeCount} Commercial`}
          detail="Directory (£49/mo) & YouTube Studio"
          tone={tokens.ok}
        />
        <PortfolioSummaryTile
          title="Prospects & Leads"
          origin="live"
          probe={directoryProbe}
          renderValue={(v) => `${v.companies.toLocaleString()} Enriched`}
          renderDetail={(v) =>
            `Live from ai_os.entities · ${v.total.toLocaleString()} rows on the directory arm`
          }
          tone={tokens.accent}
        />
        <PortfolioSummaryTile
          title="Pipeline In Flight"
          origin="live"
          probe={pipelineProbe}
          renderValue={(v) => `${v.total} Video Jobs`}
          renderDetail={(v) =>
            `${v.stalled} stalled >${v.thresholdHours}h${
              v.qcCount === null ? "" : ` · ${v.qcCount} in QC review`
            }`
          }
          toneFor={(v) => (v.stalled > 0 ? tokens.bleed : tokens.ok)}
          tone={tokens.accent}
        />
        <PortfolioSummaryTile
          title="SaaS & Consulting"
          origin="stated"
          value={`${otherCount} Pre-Launch / Paused`}
          detail="Axtrelis SaaS + ShiftSync Dormant"
          tone={tokens.warn}
        />
      </div>

      {/* ═══ 4 Venture Cards Grid ═══ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(480px, 1fr))",
          gap: 18,
          marginBottom: 32,
        }}
      >
        {filteredVentures.map((venture) => (
          <VentureCard
            key={venture.key}
            venture={venture}
            pipelineProbe={venture.key === "creator" ? pipelineProbe : undefined}
            onRetryPipeline={venture.key === "creator" ? () => void pipelineQ.refetch() : undefined}
            directoryProbe={venture.key === "directory" ? directoryProbe : undefined}
            onRetryDirectory={venture.key === "directory" ? () => void entitiesQ.refetch() : undefined}
          />
        ))}
      </div>

      {/* ═══ Cross-Portfolio Bottlenecks & Action Center ═══ */}
      <section
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderEmphasis}`,
          borderRadius: 12,
          padding: "20px 22px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
            marginBottom: 14,
            paddingBottom: 12,
            borderBottom: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: tokens.textHi }}>
                Cross-Portfolio Bottlenecks & Action Center
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  letterSpacing: "0.08em",
                  color: tokens.bleed,
                  background: tokens.dangerActionBg,
                  border: `1px solid ${tokens.dangerActionBorder}`,
                  borderRadius: 4,
                  padding: "1px 6px",
                }}
              >
                ATTENTION REQUIRED
              </span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: tokens.textMuted,
                marginTop: 3,
              }}
            >
              Primary constraints blocking velocity and commercialization across all 4 arms.
            </div>
          </div>
          <span className="mono" style={{ fontSize: 10.5, color: tokens.textFaint }}>
            {CROSS_PORTFOLIO_BOTTLENECKS.length} strategic items identified
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {CROSS_PORTFOLIO_BOTTLENECKS.map((item) => (
            <BottleneckRow
              key={item.id}
              item={item}
              count={
                item.countSource === "pipelineStalled"
                  ? mapProbe(pipelineProbe, (v) => v.stalled)
                  : item.countSource === "directoryCompanies"
                    ? mapProbe(directoryProbe, (v) => v.companies)
                    : undefined
              }
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
 * Venture Card Component
 * ========================================================================== */

function VentureCard({
  venture,
  pipelineProbe,
  onRetryPipeline,
  directoryProbe,
  onRetryDirectory,
}: {
  venture: Venture;
  pipelineProbe?: Probe<PipelineReading>;
  onRetryPipeline?: () => void;
  directoryProbe?: Probe<DirectoryReading>;
  onRetryDirectory?: () => void;
}) {
  const [showProps, setShowProps] = useState(false);
  const statusCfg = STATUS_CONFIG[venture.status];

  /* The next action is the one line Konrad acts on, so a live probe upgrades
   * it with the real count and a dead probe leaves the inventory's own
   * sentence standing — which carries no number, precisely so a failed fetch
   * cannot dress last week's figure up as today's. */
  const resolvedNextAction = useMemo(() => {
    if (pipelineProbe?.state === "ok") {
      const p = pipelineProbe.value;
      if (p.stalled > 0) {
        return `${p.stalled} of ${p.total} jobs stalled >${p.thresholdHours}h in QC. Human review required in Hub Web.`;
      }
      return `All ${p.total} jobs active with no stalls >${p.thresholdHours}h. Ready for next production batch.`;
    }
    if (directoryProbe?.state === "ok") {
      return `${directoryProbe.value.companies.toLocaleString()} enriched company entities ready in DB. ${venture.defaultNextAction}`;
    }
    return venture.defaultNextAction;
  }, [venture, pipelineProbe, directoryProbe]);

  const probeError =
    pipelineProbe?.state === "error"
      ? { label: "Pipeline", message: pipelineProbe.message, retry: onRetryPipeline }
      : directoryProbe?.state === "error"
        ? { label: "Entities registry", message: directoryProbe.message, retry: onRetryDirectory }
        : null;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 12,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxShadow: tokens.shadowCard,
      }}
    >
      <div>
        {/* Top bar: Title + Category + Status Badge */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: tokens.textHi }}>
              {venture.title}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                color: tokens.textFaint,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 4,
                padding: "1px 5px",
              }}
            >
              {venture.category}
            </span>
          </div>

          <span
            className="mono"
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: statusCfg.fg,
              background: statusCfg.bg,
              border: `1px solid ${statusCfg.border}`,
              borderRadius: 5,
              padding: "2px 7px",
            }}
          >
            {venture.statusLabel}
          </span>
        </div>

        {/* Subtitle / Tagline */}
        <div
          style={{
            fontSize: 12,
            color: tokens.textMuted,
            marginBottom: 14,
            lineHeight: 1.45,
          }}
        >
          {venture.tagline}
        </div>

        {/* Metrics Row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 8,
            padding: "10px 12px",
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            marginBottom: 14,
          }}
        >
          {directoryProbe && (
            <MetricTile
              label="Sourced Prospects"
              value={probeText(directoryProbe, (v) => v.companies.toLocaleString())}
              origin="live"
              tone={directoryProbe.state === "ok" ? tokens.textHi : tokens.textFaint}
            />
          )}

          {venture.metrics.map((m, i) => (
            <MetricTile
              key={m.label}
              label={m.label}
              value={m.value}
              origin="stated"
              tone={
                venture.status === "paused" || venture.status === "dormant"
                  ? tokens.textFaint
                  : STATED_TONES[i % STATED_TONES.length]
              }
            />
          ))}

          {directoryProbe && (
            <MetricTile
              label="Pricing"
              value={venture.pricing}
              origin="stated"
              tone={tokens.accent}
            />
          )}

          {pipelineProbe && (
            <>
              <MetricTile
                label="Pipeline Jobs"
                value={probeText(pipelineProbe, (v) => `${v.total} Jobs`)}
                origin="live"
                tone={pipelineProbe.state === "ok" ? tokens.text : tokens.textFaint}
              />
              <MetricTile
                label={
                  pipelineProbe.state === "ok"
                    ? `QC Stalled (>${pipelineProbe.value.thresholdHours}h)`
                    : "QC Stalled"
                }
                value={probeText(pipelineProbe, (v) => `${v.stalled} Stalled`)}
                origin="live"
                tone={
                  pipelineProbe.state === "ok"
                    ? pipelineProbe.value.stalled > 0
                      ? tokens.bleed
                      : tokens.ok
                    : tokens.textFaint
                }
              />
            </>
          )}
        </div>

        {/* Probe error banner — the live tiles above read `unreachable`, this
            says why and offers the retry. */}
        {probeError && (
          <div
            style={{
              padding: "8px 10px",
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 6,
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span className="mono" style={{ fontSize: 10.5, color: tokens.bleed }}>
              {probeError.label} probe error: {probeError.message}
            </span>
            {probeError.retry && (
              <button
                type="button"
                onClick={probeError.retry}
                className="mono"
                style={smallBtnStyle}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {/* Next Action Box */}
        <div
          style={{
            padding: "10px 12px",
            background: tokens.primaryActionBg,
            border: `1px solid ${tokens.accent}`,
            borderRadius: 8,
            marginBottom: 14,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: tokens.accent,
              marginBottom: 3,
            }}
          >
            NEXT ACTION / IMMEDIATE STEP
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: tokens.textHi,
              lineHeight: 1.45,
            }}
          >
            {resolvedNextAction}
          </div>
        </div>
      </div>

      {/* Bottom Area: Launchpad Buttons & Property Inspection */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          {venture.launchpad.map((link) => (
            <LaunchpadButton key={link.label} link={link} />
          ))}
        </div>

        {/* Compact Infrastructure Drawer */}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => setShowProps((v) => !v)}
            className="mono"
            style={{
              background: "transparent",
              border: "none",
              padding: "4px 0",
              fontSize: 10.5,
              color: tokens.textFaint,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span>{showProps ? "▾ Hide" : "▸ View"} Infrastructure ({venture.properties.length} services)</span>
          </button>

          {showProps && (
            <div
              style={{
                marginTop: 6,
                padding: "8px 10px",
                background: tokens.bgGutter,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 6,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {venture.properties.map((prop) => (
                <PropertyMiniRow key={prop.name} prop={prop} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Subcomponents & Helper Primitives
 * ========================================================================== */

/** Narrow a probe to one of its fields, preserving pending/error. */
function mapProbe<T, U>(probe: Probe<T>, pick: (value: T) => U): Probe<U> {
  return probe.state === "ok" ? { state: "ok", value: pick(probe.value) } : probe;
}

/** The one place a probe becomes a string. `pending` and `error` get WORDS,
 *  never a number, so no reader can mistake either for a reading. */
function probeText<T>(probe: Probe<T>, render: (value: T) => string): string {
  if (probe.state === "ok") return render(probe.value);
  return probe.state === "pending" ? "probing…" : "unreachable";
}

type ValueOrigin = "live" | "stated";

/** `stated` — a business fact transcribed from the vault into
 *  businesses-inventory.ts. `live` — read from an API this render. Rendered as
 *  a badge on every tile so the two can never be confused by eye. */
function OriginBadge({ origin, probe }: { origin: ValueOrigin; probe?: Probe<unknown> }) {
  const spec =
    origin === "stated"
      ? { text: "STATED", fg: tokens.textFaint, bg: tokens.toolBg, border: tokens.borderSoft }
      : probe?.state === "ok"
        ? { text: "LIVE", fg: tokens.ok, bg: tokens.okActionBg, border: tokens.okActionBorder }
        : probe?.state === "error"
          ? { text: "UNREACHABLE", fg: tokens.bleed, bg: tokens.dangerActionBg, border: tokens.dangerActionBorder }
          : { text: "PROBING", fg: tokens.textFaint, bg: tokens.toolBg, border: tokens.borderSoft };

  return (
    <span
      className="mono"
      style={{
        fontSize: 8.5,
        color: spec.fg,
        background: spec.bg,
        border: `1px solid ${spec.border}`,
        borderRadius: 3,
        padding: "0 4px",
        flex: "none",
      }}
    >
      {spec.text}
    </span>
  );
}

type PortfolioSummaryTileProps<T> =
  | {
      title: string;
      origin: "stated";
      value: string;
      detail: string;
      tone: string;
    }
  | {
      title: string;
      origin: "live";
      probe: Probe<T>;
      renderValue: (value: T) => string;
      renderDetail: (value: T) => string;
      /** Tone while the reading has not arrived, or when it carries no signal. */
      tone: string;
      /** Tone once a reading exists — e.g. red only when something is stalled. */
      toneFor?: (value: T) => string;
    };

function PortfolioSummaryTile<T>(props: PortfolioSummaryTileProps<T>) {
  const { title, origin, tone } = props;

  let value: string;
  let detail: string;
  let toneResolved = tone;

  if (props.origin === "stated") {
    value = props.value;
    detail = props.detail;
  } else if (props.probe.state === "ok") {
    value = props.renderValue(props.probe.value);
    detail = props.renderDetail(props.probe.value);
    toneResolved = props.toneFor ? props.toneFor(props.probe.value) : tone;
  } else if (props.probe.state === "pending") {
    value = "probing…";
    detail = "waiting on the first reading";
    toneResolved = tokens.textFaint;
  } else {
    value = "unreachable";
    detail = props.probe.message;
    toneResolved = tokens.bleed;
  }

  const probe = props.origin === "live" ? (props.probe as Probe<unknown>) : undefined;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.borderSoft}`,
        borderRadius: 8,
        padding: "10px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            color: tokens.textLabel,
          }}
        >
          {title}
        </span>
        <OriginBadge origin={origin} probe={probe} />
      </div>
      <div
        className="mono"
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: toneResolved,
          marginBottom: 2,
        }}
      >
        {value}
      </div>
      <div
        title={detail}
        style={{
          fontSize: 11,
          color: tokens.textMuted,
          lineHeight: 1.35,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
  origin,
}: {
  label: string;
  value: string;
  tone: string;
  origin: ValueOrigin;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="mono"
        title={value}
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: tone,
          lineHeight: 1.2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 9,
          color: tokens.textLabel,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginTop: 3,
        }}
      >
        <span
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {label}
        </span>
        <span style={{ color: tokens.textGhost, letterSpacing: 0, flex: "none" }}>
          {origin === "live" ? "· live" : "· stated"}
        </span>
      </div>
    </div>
  );
}

function LaunchpadButton({ link }: { link: LaunchpadLink }) {
  if (!link.url || link.url.startsWith("#")) {
    return (
      <span
        className="mono"
        title={link.hint}
        style={{
          background: tokens.toolBg,
          border: `1px solid ${tokens.border}`,
          borderRadius: 6,
          color: tokens.textBody,
          fontSize: 11,
          padding: "5px 9px",
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          cursor: "default",
        }}
      >
        {link.label} ↗
      </span>
    );
  }

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={link.hint}
      className="mono"
      style={{
        background: link.kind === "external" ? tokens.primaryActionBg : tokens.toolBg,
        border: `1px solid ${link.kind === "external" ? tokens.accent : tokens.border}`,
        borderRadius: 6,
        color: link.kind === "external" ? tokens.accent : tokens.textBody,
        fontSize: 11,
        fontWeight: link.kind === "external" ? 600 : 400,
        padding: "5px 9px",
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        cursor: "pointer",
      }}
    >
      {link.label} ↗
    </a>
  );
}

function BottleneckRow({
  item,
  count,
}: {
  item: BottleneckItem;
  count?: Probe<number>;
}) {
  const sev = SEVERITY_CONFIG[item.severity];

  return (
    <div
      style={{
        padding: "10px 14px",
        background: tokens.bgGutter,
        borderLeft: `3px solid ${sev.fg}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: sev.fg,
              background: sev.bg,
              border: `1px solid ${sev.border}`,
              borderRadius: 3,
              padding: "1px 5px",
            }}
          >
            {sev.label}
          </span>
          {count?.state === "ok" && (
            <span
              className="mono"
              title={`${item.countLabel ?? "count"} — read live`}
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: sev.fg,
                background: sev.bg,
                border: `1px solid ${sev.border}`,
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {count.value.toLocaleString()} {item.countLabel ?? ""}
            </span>
          )}
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tokens.textHi,
            }}
          >
            {item.title}
          </span>
          <span
            className="mono"
            style={{ fontSize: 10, color: tokens.textFaint }}
          >
            ({item.ventureTitle})
          </span>
        </div>

        {item.actionUrl && item.actionLabel && (
          <a
            href={item.actionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 5,
              color: tokens.textHi,
              fontSize: 10.5,
              padding: "3px 8px",
              textDecoration: "none",
            }}
          >
            {item.actionLabel}
          </a>
        )}
      </div>

      <div
        style={{
          fontSize: 11.5,
          color: tokens.textMuted,
          lineHeight: 1.4,
        }}
      >
        <strong style={{ color: tokens.text }}>Impact:</strong> {item.impact}
      </div>

      <div
        style={{
          fontSize: 11.5,
          color: tokens.textBody,
          lineHeight: 1.4,
        }}
      >
        <strong style={{ color: tokens.accent }}>Action:</strong>{" "}
        {item.recommendedAction}
      </div>
    </div>
  );
}

function PropertyMiniRow({ prop }: { prop: VentureProperty }) {
  const isRunning = prop.status === "running";
  const dotColor = isRunning ? tokens.ok : tokens.warn;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 11,
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dotColor,
            flex: "none",
          }}
        />
        <span
          style={{
            fontWeight: 500,
            color: tokens.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {prop.name}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: tokens.textGhost,
            textTransform: "uppercase",
          }}
        >
          [{prop.box}]
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {prop.statusNote && (
          <span
            style={{
              fontSize: 10,
              color: tokens.warn,
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={prop.statusNote}
          >
            {prop.statusNote}
          </span>
        )}
        {prop.publicUrl && (
          <a
            href={prop.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{
              color: tokens.accent,
              fontSize: 10,
              textDecoration: "none",
            }}
          >
            open ↗
          </a>
        )}
      </div>
    </div>
  );
}

function filterBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? tokens.toolBg : "transparent",
    color: active ? tokens.textHi : tokens.textMuted,
    border: active ? `1px solid ${tokens.border}` : "1px solid transparent",
    borderRadius: 5,
    padding: "3px 8px",
    fontSize: 11,
    cursor: "pointer",
    transition: "all 120ms ease",
  };
}

const smallBtnStyle: CSSProperties = {
  background: tokens.toolBg,
  border: `1px solid ${tokens.border}`,
  borderRadius: 4,
  color: tokens.textMuted,
  fontSize: 10,
  padding: "2px 6px",
  cursor: "pointer",
};
