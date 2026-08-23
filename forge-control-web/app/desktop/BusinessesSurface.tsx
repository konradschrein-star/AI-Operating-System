"use client";

/**
 * BusinessesSurface — Executive portfolio cockpit and venture command center.
 *
 * Visualizes Konrad's 4 core ventures with high-impact venture cards,
 * live telemetry probes (entities identity registry, content_jobs pipeline),
 * one-click launchpad actions, and cross-portfolio bottleneck resolution.
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

  const liveDirectoryCount = useMemo(() => {
    if (entitiesQ.data?.by_arm?.directory) {
      return entitiesQ.data.by_arm.directory.companies || entitiesQ.data.by_arm.directory.total || 1053;
    }
    return 1053;
  }, [entitiesQ.data]);

  const pipelineMetrics = useMemo(() => {
    if (!pipelineQ.data) {
      return { total: 5, stalled: 5, qcCount: 5 };
    }
    const qcPhase = pipelineQ.data.phases.find((p) => p.key === "qc");
    return {
      total: pipelineQ.data.total,
      stalled: pipelineQ.data.stalled_total,
      qcCount: qcPhase?.count ?? pipelineQ.data.stalled_total,
    };
  }, [pipelineQ.data]);

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
              4 PORTFOLIO ARMS
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
            All Ventures (4)
          </button>
          <button
            type="button"
            onClick={() => setFilter("active")}
            style={filterBtnStyle(filter === "active")}
          >
            Active Commercial (2)
          </button>
          <button
            type="button"
            onClick={() => setFilter("other")}
            style={filterBtnStyle(filter === "other")}
          >
            Pre-Launch / Paused (2)
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
          value="2 Commercial"
          detail="Directory (£49/mo) & YouTube Studio"
          tone={tokens.ok}
        />
        <PortfolioSummaryTile
          title="Prospects & Leads"
          value={`${liveDirectoryCount.toLocaleString()} Enriched`}
          detail={
            entitiesQ.data ? "Live from ai_os.entities" : "1,053 in DB · Ready for outreach"
          }
          tone={tokens.accent}
          isLive={!!entitiesQ.data}
        />
        <PortfolioSummaryTile
          title="Pipeline In Flight"
          value={`${pipelineMetrics.total} Video Jobs`}
          detail={`${pipelineMetrics.stalled} stalled >48h in QC review`}
          tone={pipelineMetrics.stalled > 0 ? tokens.bleed : tokens.ok}
          isLive={!!pipelineQ.data}
        />
        <PortfolioSummaryTile
          title="SaaS & Consulting"
          value="Pre-Launch / Paused"
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
            pipelineData={venture.key === "creator" ? pipelineQ.data : undefined}
            isPipelinePending={venture.key === "creator" && pipelineQ.isPending}
            pipelineError={venture.key === "creator" && pipelineQ.isError ? pipelineQ.error?.message : undefined}
            onRetryPipeline={venture.key === "creator" ? () => void pipelineQ.refetch() : undefined}
            liveProspectsCount={venture.key === "directory" ? liveDirectoryCount : undefined}
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
            4 strategic items identified
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {CROSS_PORTFOLIO_BOTTLENECKS.map((item) => (
            <BottleneckRow key={item.id} item={item} />
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
  pipelineData,
  isPipelinePending,
  pipelineError,
  onRetryPipeline,
  liveProspectsCount,
}: {
  venture: Venture;
  pipelineData?: BusinessPipelineResponse;
  isPipelinePending?: boolean;
  pipelineError?: string;
  onRetryPipeline?: () => void;
  liveProspectsCount?: number;
}) {
  const [showProps, setShowProps] = useState(false);
  const statusCfg = STATUS_CONFIG[venture.status];

  // Dynamic next action and metrics resolution
  const resolvedNextAction = useMemo(() => {
    if (venture.key === "creator") {
      if (pipelineData) {
        if (pipelineData.stalled_total > 0) {
          return `${pipelineData.stalled_total} of ${pipelineData.total} jobs stalled >${pipelineData.stall_threshold_hours}h in QC. Human review required in Hub Web.`;
        }
        return `All ${pipelineData.total} jobs active with no stalls >${pipelineData.stall_threshold_hours}h. Ready for next production batch.`;
      }
      return venture.defaultNextAction;
    }
    if (venture.key === "directory" && liveProspectsCount !== undefined) {
      return `${liveProspectsCount.toLocaleString()} enriched company entities ready in DB. First 100 cold outreach calls not yet initiated.`;
    }
    return venture.defaultNextAction;
  }, [venture, pipelineData, liveProspectsCount]);

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
        boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
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
          {venture.key === "directory" ? (
            <>
              <MetricTile
                label="Sourced Prospects"
                value={(liveProspectsCount ?? 1053).toLocaleString()}
                tone={tokens.textHi}
              />
              <MetricTile label="Contacted" value="0" tone={tokens.stuck} />
              <MetricTile label="Pricing" value={venture.pricing} tone={tokens.accent} />
            </>
          ) : venture.key === "creator" ? (
            <>
              <MetricTile
                label="Active Channels"
                value="3 Channels"
                tone={tokens.textHi}
              />
              <MetricTile
                label="Pipeline Jobs"
                value={
                  pipelineData
                    ? `${pipelineData.total} Jobs`
                    : isPipelinePending
                      ? "Probing…"
                      : "5 In Flight"
                }
                tone={tokens.text}
              />
              <MetricTile
                label="QC Stalled (>48h)"
                value={
                  pipelineData
                    ? `${pipelineData.stalled_total} Stalled`
                    : isPipelinePending
                      ? "Probing…"
                      : "5 Stalled"
                }
                tone={
                  (pipelineData?.stalled_total ?? 5) > 0
                    ? tokens.bleed
                    : tokens.ok
                }
              />
            </>
          ) : (
            <>
              <MetricTile
                label={venture.metrics.label1}
                value={String(venture.metrics.value1)}
                tone={tokens.textHi}
              />
              <MetricTile
                label={venture.metrics.label2}
                value={String(venture.metrics.value2)}
                tone={venture.status === "paused" ? tokens.textFaint : tokens.stuck}
              />
              <MetricTile
                label={venture.metrics.label3}
                value={String(venture.metrics.value3)}
                tone={tokens.accent}
              />
            </>
          )}
        </div>

        {/* Pipeline Error state banner (if probe failed) */}
        {pipelineError && (
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
            }}
          >
            <span className="mono" style={{ fontSize: 10.5, color: tokens.bleed }}>
              Pipeline probe error: {pipelineError}
            </span>
            {onRetryPipeline && (
              <button
                type="button"
                onClick={onRetryPipeline}
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

function PortfolioSummaryTile({
  title,
  value,
  detail,
  tone,
  isLive,
}: {
  title: string;
  value: string;
  detail: string;
  tone: string;
  isLive?: boolean;
}) {
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
        {isLive && (
          <span
            className="mono"
            style={{
              fontSize: 8.5,
              color: tokens.ok,
              background: tokens.okActionBg,
              border: `1px solid ${tokens.okActionBorder}`,
              borderRadius: 3,
              padding: "0 4px",
            }}
          >
            LIVE
          </span>
        )}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: tone,
          marginBottom: 2,
        }}
      >
        {value}
      </div>
      <div
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
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: tone,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 9,
          color: tokens.textLabel,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginTop: 3,
        }}
      >
        {label}
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

function BottleneckRow({ item }: { item: BottleneckItem }) {
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
