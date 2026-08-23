"use client";

/**
 * Pipeline Surface — Content Forge Executive Control Room.
 *
 * Provides complete operational visibility and control over Content Forge's
 * automated video production pipeline.
 *
 * Core capabilities:
 * - Production Velocity Strip: Top KPI cards (Ready for Upload, Needs Attention, Active Renders, Fleet Health).
 * - Multi-dimensional Filtering: Search query, Channel, Format, and Stall state.
 * - 6-Phase Kanban Board: Idea, Script, Assets, QC, Render, Publish with calm dark styling (no yellow wallpaper).
 * - Interactive Job Cards: Click opens JobDetailDrawer for scripts, manifests, history, logs & actions.
 * - Deep Links: Direct navigation to Content Forge Hub (https://hub.schreinercontentsystems.com/jobs/:id).
 * - Collapsible Engine Telemetry: pm2 worker health and BullMQ queue matrix adhering strictly to R66/R67/N1.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  fetchPipelineBusiness,
  type BusinessPipelineCard,
  type BusinessPipelinePhase,
  type BusinessPipelineResponse,
  type QueueDepth,
  type QueueSetDepth,
  type WorkerHealth,
} from "../api-business";
import { JobDetailDrawer } from "./pipeline/JobDetailDrawer";

const PHASE_COLOR: Record<string, string> = {
  idea: tokens.info,
  script: tokens.accent,
  voice: tokens.decide,
  assets: tokens.warn,
  qc: tokens.stuck,
  render: tokens.accent,
  publish: tokens.ok,
  other: tokens.textMuted,
};

const HUMAN_GATE = /^AWAITING_/;
const isHumanGate = (status: string): boolean => HUMAN_GATE.test(status);

function formatBytes(bytes: string | number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === "") return "—";
  const num = typeof bytes === "string" ? Number(bytes) : bytes;
  if (Number.isNaN(num) || num <= 0) return "—";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatUptime(ms: number | null): string {
  if (ms === null) return "no start time reported";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

function formatRestarts(n: number | null): string {
  if (n === null) return "restarts not reported";
  return `${n} restarts`;
}

const asOf = (iso: string): string =>
  `${iso.replace("T", " ").slice(0, 19)}Z`;

export function PipelineSurface() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [formatFilter, setFormatFilter] = useState<string>("all");
  const [onlyNeedsAttention, setOnlyNeedsAttention] = useState<boolean>(false);
  const [telemetryExpanded, setTelemetryExpanded] = useState<boolean>(false);

  const q = useQuery<BusinessPipelineResponse, Error>({
    queryKey: ["business", "pipeline"],
    queryFn: fetchPipelineBusiness,
    refetchInterval: 10_000,
    retry: 1,
  });

  // Extract channels and formats for dropdown filters
  const { channels, formats } = useMemo(() => {
    if (!q.data) return { channels: [], formats: [] };
    const allCards = q.data.phases.flatMap((p) => p.cards);
    const chSet = new Set<string>();
    const fmtSet = new Set<string>();
    for (const c of allCards) {
      if (c.channel && c.channel !== "—") chSet.add(c.channel);
      if (c.format && c.format !== "—") fmtSet.add(c.format);
    }
    return {
      channels: Array.from(chSet).sort(),
      formats: Array.from(fmtSet).sort(),
    };
  }, [q.data]);

  // Compute Velocity Strip Metrics
  const velocityMetrics = useMemo(() => {
    if (!q.data) return null;
    const allCards = q.data.phases.flatMap((p) => p.cards);

    // Ready for upload: jobs in publish phase or AWAITING_UPLOADER
    const readyCards = allCards.filter(
      (c) => c.status === "AWAITING_UPLOADER" || c.status === "UPLOADING",
    );
    const totalReadyBytes = readyCards.reduce((acc, c) => {
      const bytes = c.final_video_size_bytes ? Number(c.final_video_size_bytes) : 0;
      return acc + (Number.isNaN(bytes) ? 0 : bytes);
    }, 0);

    // Needs attention: stalled jobs or failed statuses or errors
    const attentionCards = allCards.filter(
      (c) => c.stalled || c.status.startsWith("FAILED_") || Boolean(c.error_message),
    );
    const errorCount = allCards.filter(
      (c) => c.status.startsWith("FAILED_") || Boolean(c.error_message),
    ).length;

    // Active renders: jobs in render phase or active queues
    const renderPhase = q.data.phases.find((p) => p.key === "render");
    const activeRendersCount = renderPhase ? renderPhase.count : 0;

    // Fleet Health summary
    const workers = q.data.workers;
    const workersSummary = workers.ok
      ? `${workers.online}/${workers.expected.length} online`
      : "Probe unavailable";

    return {
      readyCount: readyCards.length,
      readyBytesFormatted: formatBytes(totalReadyBytes),
      attentionCount: attentionCards.length,
      errorCount,
      stalledCount: q.data.stalled_total,
      activeRendersCount,
      workersSummary,
      workersOk: workers.ok && workers.missing.length === 0,
      queuesOk: q.data.queues.ok,
    };
  }, [q.data]);

  // Filter cards per phase
  const filteredPhases = useMemo(() => {
    if (!q.data) return [];
    return q.data.phases.map((p) => {
      const filteredCards = p.cards.filter((card) => {
        if (channelFilter !== "all" && card.channel !== channelFilter) return false;
        if (formatFilter !== "all" && card.format !== formatFilter) return false;
        if (onlyNeedsAttention && !card.stalled && !card.error_message && !card.status.startsWith("FAILED_")) {
          return false;
        }
        if (searchQuery.trim() !== "") {
          const qLower = searchQuery.toLowerCase();
          const matchTitle = card.title.toLowerCase().includes(qLower);
          const matchChannel = card.channel.toLowerCase().includes(qLower);
          const matchFormat = card.format.toLowerCase().includes(qLower);
          const matchStatus = card.status.toLowerCase().includes(qLower);
          const matchId = card.id.toLowerCase().includes(qLower);
          const matchError = card.error_message ? card.error_message.toLowerCase().includes(qLower) : false;
          const matchVa = (card.production_va_name?.toLowerCase().includes(qLower) || card.uploader_va_name?.toLowerCase().includes(qLower));
          if (!matchTitle && !matchChannel && !matchFormat && !matchStatus && !matchId && !matchError && !matchVa) {
            return false;
          }
        }
        return true;
      });

      return {
        ...p,
        filteredCards,
      };
    });
  }, [q.data, channelFilter, formatFilter, onlyNeedsAttention, searchQuery]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: tokens.bgBody,
      }}
    >
      {/* Header Bar */}
      <div
        style={{
          padding: "12px 20px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          background: tokens.bgCard,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi }}>
            Content Forge Control Room
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.borderSoft}`,
              borderRadius: 4,
              padding: "2px 6px",
            }}
          >
            LIVE PIPELINE
          </span>
        </div>

        {q.data && (
          <span className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
            {q.data.total} total jobs · probed {asOf(q.data.as_of)}
          </span>
        )}

        <div style={{ flex: 1 }} />

        <a
          href="https://hub.schreinercontentsystems.com"
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 10px",
            background: tokens.bgBody,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 6,
            color: tokens.textSoft,
            fontSize: 11.5,
            textDecoration: "none",
          }}
          title="Open Content Forge Hub Web App"
        >
          <span>Open Hub</span>
          <span style={{ fontSize: 12 }}>↗</span>
        </a>

        <button
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          style={{
            padding: "5px 10px",
            background: tokens.bgBody,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 6,
            color: tokens.textSoft,
            fontSize: 11.5,
            cursor: q.isFetching ? "not-allowed" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span>{q.isFetching ? "..." : "⟳"}</span>
          <span>Refresh</span>
        </button>
      </div>

      {/* Main Content Area */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          minHeight: 0,
        }}
      >
        {q.isPending && (
          <div className="mono" style={{ fontSize: 11.5, color: tokens.textFaint, padding: 20 }}>
            Loading pipeline control room...
          </div>
        )}

        {q.isError && (
          <div
            style={{
              padding: "14px 16px",
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 9,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600, color: tokens.bleed }}>
              Pipeline unavailable — connection to forge-control failed
            </div>
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.textBody,
                marginTop: 6,
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              GET /api/proxy/pipeline → {q.error.message}
            </div>
          </div>
        )}

        {q.data && velocityMetrics && (
          <>
            {/* Top Production Velocity Strip */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 12,
              }}
            >
              <VelocityCard
                title="READY FOR UPLOAD"
                count={`${velocityMetrics.readyCount} videos`}
                detail={
                  velocityMetrics.readyCount > 0
                    ? `${velocityMetrics.readyBytesFormatted} rendered · awaiting YouTube publish`
                    : "No rendered videos waiting for upload"
                }
                tone={velocityMetrics.readyCount > 0 ? "ok" : "neutral"}
                icon="🚀"
              />

              <VelocityCard
                title="NEEDS ATTENTION"
                count={`${velocityMetrics.attentionCount} items`}
                detail={
                  velocityMetrics.errorCount > 0
                    ? `${velocityMetrics.errorCount} failed / QA freeze · ${velocityMetrics.stalledCount} stalled`
                    : velocityMetrics.stalledCount > 0
                      ? `${velocityMetrics.stalledCount} stalled >${q.data.stall_threshold_hours}h · awaiting VA action`
                      : "All in-flight jobs moving normally"
                }
                tone={velocityMetrics.attentionCount > 0 ? "warn" : "ok"}
                icon="⚠️"
              />

              <VelocityCard
                title="ACTIVE RENDERS"
                count={`${velocityMetrics.activeRendersCount} active`}
                detail="Remotion render & stitching workers in progress"
                tone="neutral"
                icon="🎬"
              />

              <VelocityCard
                title="FLEET HEALTH"
                count={velocityMetrics.workersSummary}
                detail={
                  velocityMetrics.workersOk && velocityMetrics.queuesOk
                    ? "Workers online · BullMQ Redis reachable"
                    : "Telemetry probe warning — check engine telemetry"
                }
                tone={velocityMetrics.workersOk && velocityMetrics.queuesOk ? "ok" : "warn"}
                icon="⚡"
              />
            </div>

            {/* Filter and Search Bar */}
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {/* Search input */}
              <div style={{ flex: "1 1 200px", minWidth: 180 }}>
                <input
                  type="text"
                  placeholder="Filter jobs by title, ID, VA, status, error..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                />
              </div>

              {/* Channel Filter */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textFaint }}>
                  CHANNEL:
                </span>
                <select
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 11.5,
                  }}
                >
                  <option value="all">All Channels ({channels.length})</option>
                  {channels.map((ch) => (
                    <option key={ch} value={ch}>
                      {ch}
                    </option>
                  ))}
                </select>
              </div>

              {/* Format Filter */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textFaint }}>
                  FORMAT:
                </span>
                <select
                  value={formatFilter}
                  onChange={(e) => setFormatFilter(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 11.5,
                  }}
                >
                  <option value="all">All Formats ({formats.length})</option>
                  {formats.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt}
                    </option>
                  ))}
                </select>
              </div>

              {/* Toggle Attention Only */}
              <button
                onClick={() => setOnlyNeedsAttention(!onlyNeedsAttention)}
                style={{
                  padding: "6px 12px",
                  background: onlyNeedsAttention ? tokens.freezeBgWarn : tokens.bgBody,
                  border: `1px solid ${onlyNeedsAttention ? tokens.warn : tokens.borderSoft}`,
                  color: onlyNeedsAttention ? tokens.warn : tokens.textMuted,
                  borderRadius: 6,
                  fontSize: 11.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span>⚠️</span>
                <span>Needs Attention Only</span>
              </button>

              {(searchQuery || channelFilter !== "all" || formatFilter !== "all" || onlyNeedsAttention) && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setChannelFilter("all");
                    setFormatFilter("all");
                    setOnlyNeedsAttention(false);
                  }}
                  style={{
                    padding: "4px 8px",
                    background: "transparent",
                    border: "none",
                    color: tokens.textFaint,
                    fontSize: 11,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Reset filters
                </button>
              )}
            </div>

            {/* Kanban Board (6 Phases) */}
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "stretch",
                minHeight: 380,
                overflowX: "auto",
                paddingBottom: 4,
              }}
            >
              {filteredPhases.map((p) => (
                <PhaseColumn
                  key={p.key}
                  phase={p}
                  cards={p.filteredCards}
                  thresholdHours={q.data.stall_threshold_hours}
                  onSelectJob={(id) => setSelectedJobId(id)}
                />
              ))}
            </div>

            {/* Collapsible Engine Telemetry (PM2 Workers & BullMQ Queues) */}
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                overflow: "hidden",
                marginTop: 4,
              }}
            >
              <div
                onClick={() => setTelemetryExpanded(!telemetryExpanded)}
                style={{
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  userSelect: "none",
                  background: telemetryExpanded ? tokens.bgBody : tokens.bgCard,
                  borderBottom: telemetryExpanded ? `1px solid ${tokens.borderDivider}` : "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13 }}>⚙</span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi, letterSpacing: "0.06em" }}>
                    ENGINE TELEMETRY & QUEUE MATRIX
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
                    {velocityMetrics.workersSummary} · {q.data.queues.ok ? `${q.data.queues.probed_queues} BullMQ queues` : "Queues unreachable"}
                  </span>
                </div>

                <span className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
                  {telemetryExpanded ? "▲ Collapse Telemetry" : "▼ Expand Telemetry (PM2 & Redis)"}
                </span>
              </div>

              {telemetryExpanded && (
                <div
                  style={{
                    padding: 14,
                    display: "grid",
                    gridTemplateColumns: "minmax(300px, 1fr) minmax(420px, 1.35fr)",
                    gap: 12,
                    alignItems: "stretch",
                  }}
                >
                  <WorkerStrip workers={q.data.workers} />
                  <QueuePanel queues={q.data.queues} />
                </div>
              )}
            </div>

            {/* Footnote telemetry metadata */}
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textGhost, lineHeight: 1.6 }}
            >
              counts are true totals from content_jobs · card query scanned {q.data.card_rows_scanned} of {q.data.card_query_limit} rows · stall cutoff {asOf(q.data.stall_cutoff)}
            </div>
          </>
        )}
      </div>

      {/* Slide-over Job Detail Drawer */}
      {selectedJobId && (
        <JobDetailDrawer
          jobId={selectedJobId}
          onClose={() => setSelectedJobId(null)}
          onJobUpdated={() => q.refetch()}
        />
      )}
    </div>
  );
}

/* ===========================================================================
 * VELOCITY STRIP CARD
 * ========================================================================= */

function VelocityCard({
  title,
  count,
  detail,
  tone,
  icon,
}: {
  title: string;
  count: string;
  detail: string;
  tone: "ok" | "warn" | "neutral";
  icon: string;
}) {
  const accentColor =
    tone === "ok" ? tokens.ok : tone === "warn" ? tokens.warn : tokens.accent;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderTop: `3px solid ${accentColor}`,
        borderRadius: 9,
        padding: "12px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint, letterSpacing: "0.08em" }}>
          {title}
        </span>
        <span style={{ fontSize: 14 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tokens.textHi, marginTop: 2 }}>
        {count}
      </div>
      <div style={{ fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.4 }}>
        {detail}
      </div>
    </div>
  );
}

/* ===========================================================================
 * KANBAN PHASE COLUMN
 * ========================================================================= */

function PhaseColumn({
  phase,
  cards,
  thresholdHours,
  onSelectJob,
}: {
  phase: BusinessPipelinePhase;
  cards: BusinessPipelineCard[];
  thresholdHours: number;
  onSelectJob: (id: string) => void;
}) {
  const color = PHASE_COLOR[phase.key] ?? tokens.textMuted;
  const isIdle = phase.state === "no_work_idle";
  const isBlocked = phase.state === "no_work_blocked_upstream";

  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 200,
        maxWidth: 320,
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* Column Header */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{ width: 4, height: 14, background: color, borderRadius: 2 }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
            {phase.label}
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color,
              border: `1px solid ${tokens.borderSoft}`,
              background: tokens.bgBody,
              borderRadius: 4,
              padding: "1px 6px",
            }}
            title="Total count of matching jobs in content_forge"
          >
            {phase.count}
          </span>
          {phase.stalled_count > 0 && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.warn,
                background: tokens.freezeBgWarn,
                border: `1px solid ${tokens.freezeBorderWarn}`,
                borderRadius: 4,
                padding: "1px 6px",
                fontWeight: 600,
              }}
              title={`No status change in over ${thresholdHours}h`}
            >
              {phase.stalled_count} stalled
            </span>
          )}
        </div>

        <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
          {phase.description}
        </div>

        {/* State Reason Box — Calm dark styling */}
        <div
          style={{
            fontSize: 10.5,
            color: isBlocked ? tokens.warn : isIdle ? tokens.textFaint : tokens.textSoft,
            background: isBlocked ? tokens.freezeBgWarn : tokens.bgBody,
            border: `1px solid ${isBlocked ? tokens.freezeBorderWarn : tokens.borderSoft}`,
            borderRadius: 5,
            padding: "4px 6px",
            lineHeight: 1.4,
          }}
        >
          {phase.state_reason}
        </div>
      </div>

      {/* Cards list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 100,
        }}
      >
        {cards.length === 0 ? (
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.06em",
              textAlign: "center",
              padding: "24px 8px",
              border: `1px dashed ${tokens.borderSoft}`,
              borderRadius: 7,
              background: tokens.bgBody,
            }}
          >
            {isBlocked ? "BLOCKED UPSTREAM" : "NO WORK · IDLE"}
          </div>
        ) : (
          cards.map((c) => (
            <InteractiveJobCard
              key={c.id}
              card={c}
              color={color}
              thresholdHours={thresholdHours}
              onClick={() => onSelectJob(c.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ===========================================================================
 * INTERACTIVE JOB CARD
 * ========================================================================= */

function InteractiveJobCard({
  card,
  color,
  thresholdHours,
  onClick,
}: {
  card: BusinessPipelineCard;
  color: string;
  thresholdHours: number;
  onClick: () => void;
}) {
  const isFailed = card.status.startsWith("FAILED_") || Boolean(card.error_message);
  const gate = isHumanGate(card.status);

  return (
    <div
      onClick={onClick}
      // A stable hook for the screenshot harness: the card carries no text a
      // script can anchor on that is not also live job data, and geometry
      // anchors go inert the moment a column reflows.
      data-job-card={card.id}
      style={{
        background: tokens.bgBody,
        border: `1px solid ${
          isFailed
            ? tokens.dangerActionBorder
            : card.stalled
              ? tokens.freezeBorderWarn
              : tokens.border
        }`,
        borderLeft: isFailed
          ? `3px solid ${tokens.bleed}`
          : card.stalled
            ? `3px solid ${tokens.warn}`
            : `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "10px 11px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: "pointer",
        transition: "border-color 0.15s, background-color 0.15s",
      }}
      title="Click to view script, manifests, history & controls"
    >
      {/* Top row: Status pill + Stall badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span
          className="mono"
          style={{
            fontSize: 9,
            fontWeight: 600,
            color,
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          {card.status}
        </span>
        <span style={{ flex: 1 }} />
        {card.stalled ? (
          <span
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: tokens.warn,
              background: tokens.freezeBgWarn,
              border: `1px solid ${tokens.freezeBorderWarn}`,
              borderRadius: 4,
              padding: "1px 5px",
            }}
            title={`No status change since ${card.status_updated_at} (${thresholdHours}h threshold)`}
          >
            STALLED {card.stall_days}d
          </span>
        ) : (
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.ok,
              background: tokens.okActionBg,
              border: `1px solid ${tokens.okActionBorder}`,
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            moving · {card.age}
          </span>
        )}
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: tokens.textHi,
          lineHeight: 1.4,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {card.title}
      </div>

      {/* Error summary if present */}
      {card.error_message && (
        <div
          style={{
            fontSize: 10.5,
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 4,
            padding: "4px 6px",
            lineHeight: 1.35,
          }}
        >
          {card.error_message}
        </div>
      )}

      {/* Human gate notice */}
      {gate && !card.error_message && (
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.warn,
            lineHeight: 1.35,
          }}
        >
          Awaiting human gate claim in Hub
        </div>
      )}

      {/* Media metrics (duration / size) */}
      {(card.final_video_duration_seconds || card.final_video_size_bytes) && (
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textSoft,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          {card.final_video_duration_seconds && (
            <span>⏱ {formatDuration(card.final_video_duration_seconds)}</span>
          )}
          {card.final_video_size_bytes && (
            <span>📦 {formatBytes(card.final_video_size_bytes)}</span>
          )}
        </div>
      )}

      {/* Bottom row: format, channel, VA name */}
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color: tokens.textMuted,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: `1px solid ${tokens.borderDivider}`,
          paddingTop: 5,
          marginTop: 2,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {card.format} · {card.channel}
        </span>
        <span style={{ color: card.production_va_name || card.uploader_va_name ? tokens.textSoft : tokens.textGhost }}>
          👤 {card.uploader_va_name || card.production_va_name || "Unassigned"}
        </span>
      </div>
    </div>
  );
}

/* ===========================================================================
 * PM2 WORKER STRIP (R66)
 * ========================================================================= */

function WorkerStrip({ workers }: { workers: BusinessPipelineResponse["workers"] }) {
  if (!workers.ok) {
    return (
      <Panel title="WORKERS" tone="error">
        <div style={{ fontSize: 12.5, fontWeight: 600, color: tokens.bleed }}>
          Worker health probe unavailable: {workers.error}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 6 }}>
          Expected processes: {workers.expected.join(", ")}
        </div>
        <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 6 }}>
          Probed {asOf(workers.as_of)}. Deliberately not reported as 0 online.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="WORKERS"
      tone={workers.missing.length > 0 ? "warn" : "plain"}
      meta={`${workers.online}/${workers.expected.length} online · pm2 jlist · ${asOf(workers.as_of)}`}
    >
      {workers.missing.length > 0 && (
        <div style={{ fontSize: 11, color: tokens.warn, marginBottom: 6 }}>
          pm2 has never heard of {workers.missing.join(", ")} — absent is not stopped.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {workers.workers.map((w) => (
          <WorkerRow key={w.name} worker={w} />
        ))}
      </div>
    </Panel>
  );
}

function WorkerRow({ worker }: { worker: WorkerHealth }) {
  const online = worker.status === "online";
  const tone = online ? tokens.ok : tokens.bleed;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flex: "none",
          background: tone,
        }}
      />
      <span className="mono" style={{ fontSize: 11.5, color: tokens.textLabel }}>
        {worker.name}
      </span>
      <span className="mono" style={{ fontSize: 10.5, color: tone }}>
        {worker.status}
      </span>
      <span style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
        up {formatUptime(worker.uptime_ms)}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          color: worker.restarts !== null && worker.restarts > 0 ? tokens.warn : tokens.textGhost,
        }}
      >
        {formatRestarts(worker.restarts)}
      </span>
    </div>
  );
}

/* ===========================================================================
 * BULLMQ QUEUE MATRIX (R67)
 * ========================================================================= */

function QueuePanel({ queues }: { queues: BusinessPipelineResponse["queues"] }) {
  if (!queues.ok) {
    return (
      <Panel title="QUEUES" tone="error">
        <div style={{ fontSize: 12.5, fontWeight: 600, color: tokens.bleed }}>
          Redis BullMQ queue probe unreachable: {queues.error}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 6 }}>
          Endpoint {queues.endpoint} · probed {asOf(queues.as_of)}
        </div>
      </Panel>
    );
  }

  const sets = setOrder(queues.queues);
  const columns = `minmax(130px, 1fr) repeat(${sets.length}, 74px)`;

  return (
    <Panel
      title="QUEUES"
      tone="plain"
      meta={`${queues.probed_queues} queues · redis ${queues.endpoint} · ${asOf(queues.as_of)}`}
    >
      <div style={{ display: "grid", gridTemplateColumns: columns, rowGap: 3 }}>
        <span />
        {sets.map((s) => (
          <span
            key={s}
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textFaint,
              letterSpacing: "0.06em",
              textAlign: "right",
            }}
          >
            {s.toUpperCase()}
          </span>
        ))}
        {queues.queues.map((qu) => (
          <QueueRow key={qu.queue} queue={qu} sets={sets} />
        ))}
      </div>
      <div className="mono" style={{ fontSize: 10, color: tokens.textGhost, marginTop: 8 }}>
        Hover any cell for full key and redis TYPE. Absent keys in BullMQ indicate empty queues.
      </div>
    </Panel>
  );
}

function setOrder(queues: QueueDepth[]): string[] {
  const seen: string[] = [];
  for (const q of queues) {
    for (const s of q.sets) if (!seen.includes(s.set)) seen.push(s.set);
  }
  return seen;
}

function QueueRow({ queue, sets }: { queue: QueueDepth; sets: string[] }) {
  return (
    <>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          color: tokens.textLabel,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={queue.queue}
      >
        {queue.queue.replace(/^queue-/, "")}
      </span>
      {sets.map((name) => {
        const cell = queue.sets.find((s) => s.set === name);
        if (cell === undefined) {
          return (
            <span
              key={name}
              className="mono"
              style={{ fontSize: 10.5, color: tokens.textGhost, textAlign: "right" }}
            >
              –
            </span>
          );
        }
        const d = depthCell(cell);
        return (
          <span
            key={name}
            className="mono"
            style={{ fontSize: 10.5, color: d.tone, textAlign: "right" }}
            title={d.title}
          >
            {d.text}
          </span>
        );
      })}
    </>
  );
}

function depthCell(s: QueueSetDepth): { text: string; tone: string; title: string } {
  if (s.depth !== null) {
    const hot = s.depth > 0 && (s.set === "failed" || s.set === "wait");
    return {
      text: String(s.depth),
      tone: hot ? tokens.warn : s.depth > 0 ? tokens.textHi : tokens.textFaint,
      title: `${s.key} · redis TYPE ${s.redis_type} · depth ${s.depth}`,
    };
  }
  if (s.redis_type === "none") {
    return {
      text: "0",
      tone: tokens.textFaint,
      title: `${s.key} does not exist (absent is empty)`,
    };
  }
  return {
    text: `${s.redis_type}?`,
    tone: tokens.warn,
    title: `${s.key} holds redis TYPE ${s.redis_type}`,
  };
}

function Panel({
  title,
  tone,
  meta,
  children,
}: {
  title: string;
  tone: "plain" | "warn" | "error";
  meta?: string;
  children: React.ReactNode;
}) {
  const background =
    tone === "error"
      ? tokens.dangerActionBg
      : tone === "warn"
        ? tokens.freezeBgWarn
        : tokens.bgBody;
  const border =
    tone === "error"
      ? tokens.dangerActionBorder
      : tone === "warn"
        ? tokens.freezeBorderWarn
        : tokens.border;

  return (
    <div
      style={{
        background,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: "10px 12px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
          }}
        >
          {title}
        </span>
        {meta !== undefined && (
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            {meta}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
