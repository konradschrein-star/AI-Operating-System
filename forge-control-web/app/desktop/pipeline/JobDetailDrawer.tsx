"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  fetchJobDetail,
  fetchPipelineMeta,
  retryJob,
  assignJob,
  advanceJob,
  type PipelineJobDetail,
  type PipelineMeta,
  type RetryJobRequest,
  type AdvanceJobRequest,
  type AssignJobRequest,
} from "../../api-business";

export interface JobDetailDrawerProps {
  jobId: string | null;
  onClose: () => void;
  onJobUpdated?: () => void;
}

type DrawerTab = "overview" | "script" | "manifests" | "history";

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

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return iso;
  }
}

export function JobDetailDrawer({ jobId, onClose, onJobUpdated }: JobDetailDrawerProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DrawerTab>("overview");
  const [actionFeedback, setActionFeedback] = useState<{
    tone: "ok" | "warn" | "error";
    message: string;
  } | null>(null);

  // Sub-dialog states for Actions
  const [showRetryModal, setShowRetryModal] = useState(false);
  const [retryStage, setRetryStage] = useState<string>("");
  const [retryReason, setRetryReason] = useState<string>("");

  // Set when the server answered 409 `requires_confirmation` — the move is
  // legal but off the curated path, so the same click has to be made twice on
  // purpose. Cleared whenever the chosen target changes, so a confirmation
  // never carries over to a different transition than the one it was given for.
  const [retryNeedsConfirm, setRetryNeedsConfirm] = useState(false);
  const [advanceNeedsConfirm, setAdvanceNeedsConfirm] = useState(false);

  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [advanceStatus, setAdvanceStatus] = useState<string>("");
  const [advanceReason, setAdvanceReason] = useState<string>("");
  const [advanceFeedback, setAdvanceFeedback] = useState<string>("");

  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignRole, setAssignRole] = useState<"production" | "uploader">("production");
  const [selectedVaUserId, setSelectedVaUserId] = useState<string>("");

  const [copiedScript, setCopiedScript] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showRetryModal) setShowRetryModal(false);
        else if (showAdvanceModal) setShowAdvanceModal(false);
        else if (showAssignModal) setShowAssignModal(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, showRetryModal, showAdvanceModal, showAssignModal]);

  const detailQuery = useQuery({
    queryKey: ["business", "pipeline", "job", jobId],
    queryFn: () => (jobId ? fetchJobDetail(jobId) : Promise.reject("No jobId")),
    enabled: Boolean(jobId),
    refetchInterval: 8_000,
  });

  const metaQuery = useQuery({
    queryKey: ["business", "pipeline", "meta"],
    queryFn: fetchPipelineMeta,
    staleTime: 60_000,
  });

  const retryMutation = useMutation({
    mutationFn: (req: { id: string; body: RetryJobRequest }) => retryJob(req.id, req.body),
    onSuccess: (res) => {
      if (res.success) {
        setActionFeedback({
          tone: "ok",
          message: `Job retried successfully: ${res.old_status} → ${res.new_status}${res.queue_dispatched ? ` (dispatched to ${res.queue_name})` : ""}`,
        });
        setShowRetryModal(false);
        setRetryNeedsConfirm(false);
        queryClient.invalidateQueries({ queryKey: ["business", "pipeline"] });
        onJobUpdated?.();
      } else {
        setRetryNeedsConfirm(res.requires_confirmation === true);
        if (res.current_status) {
          // The row moved under this screen; pull the truth back immediately
          // rather than leaving a stale status under an error message.
          queryClient.invalidateQueries({ queryKey: ["business", "pipeline"] });
        }
        setActionFeedback({
          tone: res.requires_confirmation === true ? "warn" : "error",
          message: `Retry ${res.requires_confirmation === true ? "needs confirmation" : "failed"} (${res.status}): ${res.error}${res.details ? ` — ${res.details}` : ""}`,
        });
      }
    },
    onError: (err) => {
      setActionFeedback({
        tone: "error",
        message: `Retry request error: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
  });

  const advanceMutation = useMutation({
    mutationFn: (req: { id: string; body: AdvanceJobRequest }) => advanceJob(req.id, req.body),
    onSuccess: (res) => {
      if (res.success) {
        setActionFeedback({
          tone: "ok",
          message: `Job advanced successfully: ${res.old_status} → ${res.new_status}`,
        });
        setShowAdvanceModal(false);
        setAdvanceNeedsConfirm(false);
        queryClient.invalidateQueries({ queryKey: ["business", "pipeline"] });
        onJobUpdated?.();
      } else {
        setAdvanceNeedsConfirm(res.requires_confirmation === true);
        if (res.current_status) {
          queryClient.invalidateQueries({ queryKey: ["business", "pipeline"] });
        }
        setActionFeedback({
          tone: res.requires_confirmation === true ? "warn" : "error",
          message: `Advance ${res.requires_confirmation === true ? "needs confirmation" : "failed"} (${res.status}): ${res.error}${res.details ? ` — ${res.details}` : ""}`,
        });
      }
    },
    onError: (err) => {
      setActionFeedback({
        tone: "error",
        message: `Advance request error: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
  });

  const assignMutation = useMutation({
    mutationFn: (req: { id: string; body: AssignJobRequest }) => assignJob(req.id, req.body),
    onSuccess: (res) => {
      if (res.success) {
        setActionFeedback({
          tone: "ok",
          message: `VA Assignment updated: ${res.production_va_name ? `Prod VA: ${res.production_va_name}` : ""} ${res.uploader_va_name ? `Uploader VA: ${res.uploader_va_name}` : ""}`,
        });
        setShowAssignModal(false);
        queryClient.invalidateQueries({ queryKey: ["business", "pipeline"] });
        onJobUpdated?.();
      } else {
        setActionFeedback({
          tone: "error",
          message: `Assignment failed (${res.status}): ${res.error}${res.details ? ` — ${res.details}` : ""}`,
        });
      }
    },
    onError: (err) => {
      setActionFeedback({
        tone: "error",
        message: `Assignment request error: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
  });

  if (!jobId) return null;

  const job: PipelineJobDetail | null =
    detailQuery.data && detailQuery.data.ok ? detailQuery.data.job : null;
  const meta: PipelineMeta | null =
    metaQuery.data && metaQuery.data.ok ? metaQuery.data.meta : null;

  const isFailed = job ? job.status.startsWith("FAILED_") || Boolean(job.error_message) : false;
  const isHumanGate = job ? job.status.startsWith("AWAITING_") : false;

  const hubLink = job
    ? job.hub_url || `https://hub.schreinercontentsystems.com/jobs/${job.id}`
    : `https://hub.schreinercontentsystems.com/jobs/${jobId}`;

  const copyScript = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 2000);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 900,
        display: "flex",
        justifyContent: "flex-end",
        background: tokens.overlay,
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 680,
          height: "100%",
          background: tokens.bgCard,
          borderLeft: `1px solid ${tokens.border}`,
          display: "flex",
          flexDirection: "column",
          boxShadow: `-8px 0 32px ${tokens.overlay}`,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* Drawer Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${tokens.borderDivider}`,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            background: tokens.bgBody,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: tokens.accent,
                    background: tokens.primaryActionBg,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 4,
                    padding: "2px 6px",
                  }}
                >
                  {job?.format || "JOB"}
                </span>
                <span className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
                  {job?.channel_name || "Content Forge"}
                </span>
                {job?.status && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: isFailed ? tokens.bleed : isHumanGate ? tokens.warn : tokens.ok,
                      background: isFailed
                        ? tokens.dangerActionBg
                        : isHumanGate
                          ? tokens.freezeBgWarn
                          : tokens.okActionBg,
                      border: `1px solid ${
                        isFailed
                          ? tokens.dangerActionBorder
                          : isHumanGate
                            ? tokens.freezeBorderWarn
                            : tokens.okActionBorder
                      }`,
                      borderRadius: 4,
                      padding: "2px 7px",
                    }}
                  >
                    {job.status}
                  </span>
                )}
              </div>
              <h2
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: tokens.textHi,
                  margin: 0,
                  lineHeight: 1.35,
                  wordBreak: "break-word",
                }}
              >
                {job?.title || `Job ${jobId.slice(0, 8)}`}
              </h2>
              <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 4 }}>
                ID: {jobId} · Template: {job?.template_name || "Default"}
              </div>
            </div>

            <button
              onClick={onClose}
              style={{
                background: "transparent",
                border: `1px solid ${tokens.borderSoft}`,
                color: tokens.textMuted,
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
              }}
              title="Close Drawer (Esc)"
            >
              ✕
            </button>
          </div>

          {/* Direct Hub Link & Action Bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            <a
              href={hubLink}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                background: tokens.primaryActionBg,
                border: `1px solid ${tokens.borderEmphasis}`,
                color: tokens.accent,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              <span>Open in Content Forge Hub</span>
              <span style={{ fontSize: 13 }}>↗</span>
            </a>

            <button
              onClick={() => {
                setRetryStage("");
                setRetryReason("");
                setShowRetryModal(true);
              }}
              style={{
                padding: "6px 12px",
                background: isFailed ? tokens.dangerActionBg : tokens.bgCard,
                border: `1px solid ${isFailed ? tokens.dangerActionBorder : tokens.border}`,
                color: isFailed ? tokens.bleed : tokens.textBody,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span>⟳</span>
              <span>Retry Stage</span>
            </button>

            <button
              onClick={() => {
                setAdvanceStatus("");
                setAdvanceReason("");
                setAdvanceFeedback("");
                setShowAdvanceModal(true);
              }}
              style={{
                padding: "6px 12px",
                background: isHumanGate ? tokens.okActionBg : tokens.bgCard,
                border: `1px solid ${isHumanGate ? tokens.okActionBorder : tokens.border}`,
                color: isHumanGate ? tokens.ok : tokens.textBody,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span>⏩</span>
              <span>Advance Gate</span>
            </button>

            <button
              onClick={() => {
                setAssignRole("production");
                setSelectedVaUserId(job?.assigned_production_va_id || "");
                setShowAssignModal(true);
              }}
              style={{
                padding: "6px 12px",
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                color: tokens.textBody,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span>👤</span>
              <span>Assign VA</span>
            </button>
          </div>

          {/* Action Feedback Banner */}
          {actionFeedback && (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                fontSize: 11.5,
                background:
                  actionFeedback.tone === "ok"
                    ? tokens.okActionBg
                    : actionFeedback.tone === "error"
                      ? tokens.dangerActionBg
                      : tokens.freezeBgWarn,
                border: `1px solid ${
                  actionFeedback.tone === "ok"
                    ? tokens.okActionBorder
                    : actionFeedback.tone === "error"
                      ? tokens.dangerActionBorder
                      : tokens.freezeBorderWarn
                }`,
                color:
                  actionFeedback.tone === "ok"
                    ? tokens.ok
                    : actionFeedback.tone === "error"
                      ? tokens.bleed
                      : tokens.warn,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span style={{ lineHeight: 1.4 }}>{actionFeedback.message}</span>
              <button
                onClick={() => setActionFeedback(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Navigation Tabs */}
          <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${tokens.borderSoft}`, marginTop: 4 }}>
            {(
              [
                { key: "overview", label: "Overview & Media" },
                { key: "script", label: "Script & Topic" },
                { key: "manifests", label: "Manifests & Assets" },
                { key: "history", label: "History & Logs" },
              ] as const
            ).map((t) => {
              const active = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  style={{
                    padding: "8px 14px",
                    background: "transparent",
                    border: "none",
                    borderBottom: active ? `2px solid ${tokens.accent}` : "2px solid transparent",
                    color: active ? tokens.textHi : tokens.textMuted,
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Drawer Body / Tab Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20, minHeight: 0 }}>
          {detailQuery.isLoading && (
            <div className="mono" style={{ fontSize: 12, color: tokens.textMuted, padding: 24, textAlign: "center" }}>
              Loading job details from Content Forge...
            </div>
          )}

          {detailQuery.isError && (
            <div
              style={{
                padding: "14px 16px",
                background: tokens.dangerActionBg,
                border: `1px solid ${tokens.dangerActionBorder}`,
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: tokens.bleed }}>
                Failed to load job details
              </div>
              <div className="mono" style={{ fontSize: 11, color: tokens.textBody, marginTop: 4 }}>
                {detailQuery.error instanceof Error ? detailQuery.error.message : String(detailQuery.error)}
              </div>
            </div>
          )}

          {detailQuery.data && !detailQuery.data.ok && (
            <div
              style={{
                padding: "14px 16px",
                background: tokens.dangerActionBg,
                border: `1px solid ${tokens.dangerActionBorder}`,
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: tokens.bleed }}>
                Job Not Found or Server Error ({detailQuery.data.status})
              </div>
              <div className="mono" style={{ fontSize: 11, color: tokens.textBody, marginTop: 4 }}>
                {detailQuery.data.error}
                {detailQuery.data.details ? ` — ${detailQuery.data.details}` : ""}
              </div>
            </div>
          )}

          {job && (
            <>
              {/* TAB 1: OVERVIEW & MEDIA */}
              {activeTab === "overview" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* QA / Error Alert Box if present */}
                  {job.error_message && (
                    <div
                      style={{
                        padding: "12px 16px",
                        background: tokens.dangerActionBg,
                        border: `1px solid ${tokens.dangerActionBorder}`,
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 14 }}>⚠️</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.bleed }}>
                          Execution / QA Error
                        </span>
                        <span style={{ flex: 1 }} />
                        <span className="mono" style={{ fontSize: 10, color: tokens.bleed }}>
                          Retries: {job.retry_count}
                        </span>
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 11.5,
                          color: tokens.textBody,
                          marginTop: 8,
                          lineHeight: 1.5,
                          wordBreak: "break-word",
                          whiteSpace: "pre-wrap",
                          background: tokens.bgBody,
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: `1px solid ${tokens.borderSoft}`,
                        }}
                      >
                        {job.error_message}
                      </div>
                    </div>
                  )}

                  {/* Render & Output Telemetry Card */}
                  <div
                    style={{
                      background: tokens.bgBody,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: 8,
                      padding: "14px 16px",
                    }}
                  >
                    <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, letterSpacing: "0.08em", marginBottom: 12 }}>
                      RENDER & MEDIA TELEMETRY
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                        gap: 12,
                      }}
                    >
                      <StatTile
                        label="FINAL DURATION"
                        value={formatDuration(job.final_video_duration_seconds ?? job.target_duration_seconds)}
                      />
                      <StatTile
                        label="VIDEO FILE SIZE"
                        value={formatBytes(job.final_video_size_bytes)}
                      />
                      <StatTile
                        label="RENDER TIME"
                        value={formatDuration(job.total_render_time_seconds)}
                      />
                      <StatTile
                        label="RENDER ENGINE"
                        value={job.render_engine || "remotion-local"}
                      />
                      <StatTile
                        label="ASPECT RATIO"
                        value={job.aspect_ratio || "9:16 (Vertical)"}
                      />
                      <StatTile
                        label="DURATION FRAMES"
                        value={job.duration_frames ? `${job.duration_frames} fps30` : "—"}
                      />
                    </div>

                    {job.final_video_path && (
                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${tokens.borderDivider}` }}>
                        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, marginBottom: 4 }}>
                          STORAGE PATH (R2 / LOCAL)
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: tokens.textSoft, wordBreak: "break-all" }}>
                          {job.final_video_path}
                        </div>
                      </div>
                    )}

                    {job.youtube_video_id && (
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${tokens.borderDivider}` }}>
                        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, marginBottom: 4 }}>
                          YOUTUBE PUBLICATION
                        </div>
                        <a
                          href={`https://youtube.com/watch?v=${job.youtube_video_id}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: tokens.accent,
                            fontSize: 12,
                            textDecoration: "none",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <span>https://youtube.com/watch?v={job.youtube_video_id}</span>
                          <span>↗</span>
                        </a>
                      </div>
                    )}
                  </div>

                  {/* Human Assignment & VA Status Card */}
                  <div
                    style={{
                      background: tokens.bgBody,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: 8,
                      padding: "14px 16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span className="mono" style={{ fontSize: 11, color: tokens.textFaint, letterSpacing: "0.08em" }}>
                        VA ASSIGNMENT & HUMAN WORKFLOW
                      </span>
                      <button
                        onClick={() => {
                          setAssignRole("production");
                          setSelectedVaUserId(job.assigned_production_va_id || "");
                          setShowAssignModal(true);
                        }}
                        style={{
                          background: "transparent",
                          border: `1px solid ${tokens.borderSoft}`,
                          color: tokens.textSoft,
                          borderRadius: 4,
                          padding: "2px 8px",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Edit Assignment
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div
                        style={{
                          background: tokens.bgCard,
                          border: `1px solid ${tokens.borderSoft}`,
                          borderRadius: 6,
                          padding: "10px 12px",
                        }}
                      >
                        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                          PRODUCTION VA
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: job.production_va_name ? tokens.textHi : tokens.textMuted, marginTop: 4 }}>
                          {job.production_va_name || "Unassigned"}
                        </div>
                        {job.production_va_email && (
                          <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 2 }}>
                            {job.production_va_email}
                          </div>
                        )}
                        {job.production_va_time_spent_seconds ? (
                          <div className="mono" style={{ fontSize: 10.5, color: tokens.textSoft, marginTop: 4 }}>
                            Time spent: {formatDuration(job.production_va_time_spent_seconds)}
                          </div>
                        ) : null}
                      </div>

                      <div
                        style={{
                          background: tokens.bgCard,
                          border: `1px solid ${tokens.borderSoft}`,
                          borderRadius: 6,
                          padding: "10px 12px",
                        }}
                      >
                        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                          UPLOADER VA
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: job.uploader_va_name ? tokens.textHi : tokens.textMuted, marginTop: 4 }}>
                          {job.uploader_va_name || "Unassigned"}
                        </div>
                        {job.uploader_va_email && (
                          <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 2 }}>
                            {job.uploader_va_email}
                          </div>
                        )}
                        {job.uploader_va_time_spent_seconds ? (
                          <div className="mono" style={{ fontSize: 10.5, color: tokens.textSoft, marginTop: 4 }}>
                            Time spent: {formatDuration(job.uploader_va_time_spent_seconds)}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {job.qc_feedback && (
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${tokens.borderDivider}` }}>
                        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, marginBottom: 4 }}>
                          QC REVIEW FEEDBACK
                        </div>
                        <div style={{ fontSize: 12, color: tokens.textBody, lineHeight: 1.45 }}>
                          {job.qc_feedback}
                        </div>
                        {job.qc_reviewed_at && (
                          <div className="mono" style={{ fontSize: 10, color: tokens.textGhost, marginTop: 2 }}>
                            Reviewed at: {formatTimestamp(job.qc_reviewed_at)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Lifecycle Timestamps Card */}
                  <div
                    style={{
                      background: tokens.bgBody,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: 8,
                      padding: "14px 16px",
                    }}
                  >
                    <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, letterSpacing: "0.08em", marginBottom: 12 }}>
                      LIFECYCLE TIMESTAMPS
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <TimestampRow label="Created At" value={formatTimestamp(job.created_at)} />
                      <TimestampRow label="Status Updated At" value={formatTimestamp(job.status_updated_at)} />
                      <TimestampRow label="Render Started" value={formatTimestamp(job.render_started_at)} />
                      <TimestampRow label="Render Completed" value={formatTimestamp(job.render_completed_at)} />
                      <TimestampRow label="Published At" value={formatTimestamp(job.published_at)} />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: SCRIPT & TOPIC */}
              {activeTab === "script" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {job.initial_topic && (
                    <div
                      style={{
                        background: tokens.bgBody,
                        border: `1px solid ${tokens.border}`,
                        borderRadius: 8,
                        padding: "12px 16px",
                      }}
                    >
                      <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginBottom: 4 }}>
                        INITIAL TOPIC & BRIEF
                      </div>
                      <div style={{ fontSize: 13, color: tokens.textHi, lineHeight: 1.45 }}>
                        {job.initial_topic}
                      </div>
                    </div>
                  )}

                  {job.description && (
                    <div
                      style={{
                        background: tokens.bgBody,
                        border: `1px solid ${tokens.border}`,
                        borderRadius: 8,
                        padding: "12px 16px",
                      }}
                    >
                      <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginBottom: 4 }}>
                        DESCRIPTION
                      </div>
                      <div style={{ fontSize: 12.5, color: tokens.textBody, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                        {job.description}
                      </div>
                    </div>
                  )}

                  {job.generated_tags && job.generated_tags.length > 0 && (
                    <div
                      style={{
                        background: tokens.bgBody,
                        border: `1px solid ${tokens.border}`,
                        borderRadius: 8,
                        padding: "12px 16px",
                      }}
                    >
                      <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginBottom: 8 }}>
                        GENERATED TAGS
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {job.generated_tags.map((tag, i) => (
                          <span
                            key={i}
                            className="mono"
                            style={{
                              fontSize: 10.5,
                              color: tokens.textSoft,
                              background: tokens.bgCard,
                              border: `1px solid ${tokens.borderSoft}`,
                              borderRadius: 4,
                              padding: "2px 8px",
                            }}
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Formatted Script Viewer */}
                  <div
                    style={{
                      background: tokens.bgBody,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: 8,
                      padding: "14px 16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <span className="mono" style={{ fontSize: 11, color: tokens.textFaint, letterSpacing: "0.08em" }}>
                        GENERATED SCRIPT ({job.script ? `${job.script.split(/\s+/).length} words` : "No script"})
                      </span>
                      {job.script && (
                        <button
                          onClick={() => copyScript(job.script || "")}
                          style={{
                            background: copiedScript ? tokens.okActionBg : tokens.bgCard,
                            border: `1px solid ${copiedScript ? tokens.okActionBorder : tokens.borderSoft}`,
                            color: copiedScript ? tokens.ok : tokens.textSoft,
                            borderRadius: 4,
                            padding: "3px 9px",
                            fontSize: 11,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <span>{copiedScript ? "✓ Copied" : "📋 Copy Script"}</span>
                        </button>
                      )}
                    </div>

                    {job.script ? (
                      <div
                        style={{
                          fontSize: 13,
                          color: tokens.textBody,
                          lineHeight: 1.6,
                          whiteSpace: "pre-wrap",
                          background: tokens.bgCard,
                          padding: 14,
                          borderRadius: 6,
                          border: `1px solid ${tokens.borderSoft}`,
                          maxHeight: 500,
                          overflowY: "auto",
                        }}
                      >
                        {job.script}
                      </div>
                    ) : (
                      <div className="mono" style={{ fontSize: 12, color: tokens.textGhost, padding: 20, textAlign: "center" }}>
                        No script has been generated yet for this job.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: MANIFESTS & ASSETS */}
              {activeTab === "manifests" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <JsonViewer title="ASSEMBLY MANIFEST" data={job.assembly_manifest} />
                  <JsonViewer title="R2 ASSET MANIFEST" data={job.r2_asset_manifest} />
                  <JsonViewer title="ERROR DETAILS / METADATA" data={job.error_detail || job.error_metadata} />
                  <JsonViewer title="RAW METADATA" data={job.metadata} />
                </div>
              )}

              {/* TAB 4: HISTORY & LOGS */}
              {activeTab === "history" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <StateHistoryTimeline history={job.state_machine_history} />
                  <JsonViewer title="GENERATION / EXECUTION LOGS" data={job.generation_log} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* =========================================================================
       * SUB-MODALS (Retry, Advance, Assign)
       * ======================================================================= */}
      {showRetryModal && (
        <ModalBackdrop onClose={() => setShowRetryModal(false)}>
          <div style={{ width: 440, background: tokens.bgCard, border: `1px solid ${tokens.border}`, borderRadius: 10, padding: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: tokens.textHi, margin: "0 0 12px 0" }}>
              ⟳ Retry Pipeline Stage
            </h3>
            <p style={{ fontSize: 12, color: tokens.textMuted, lineHeight: 1.45, marginBottom: 14 }}>
              Reset this job&apos;s status to restart execution. If left blank, the server will infer the appropriate stage based on the failure.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  TARGET STAGE (OPTIONAL)
                </label>
                <select
                  value={retryStage}
                  onChange={(e) => {
                    setRetryStage(e.target.value);
                    setRetryNeedsConfirm(false);
                  }}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                >
                  <option value="">Infer target stage automatically</option>
                  <option value="render">Render (ROUTING_RENDER)</option>
                  <option value="qc">QC (AWAITING_QC)</option>
                  <option value="assets">Assets (ASSET_COLLECTION)</option>
                  <option value="script">Script (SCRIPTING)</option>
                  <option value="idea">Idea (IDEA_GENERATION)</option>
                </select>
              </div>

              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  REASON / OPERATOR NOTE
                </label>
                <input
                  type="text"
                  placeholder="e.g. Fixed QA freeze, re-rendering with clean asset"
                  value={retryReason}
                  onChange={(e) => setRetryReason(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => setShowRetryModal(false)}
                  style={{
                    padding: "7px 14px",
                    background: "transparent",
                    border: `1px solid ${tokens.borderSoft}`,
                    color: tokens.textMuted,
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    retryMutation.mutate({
                      id: jobId,
                      body: {
                        target_stage: retryStage || undefined,
                        reason: retryReason || undefined,
                        // What this screen was showing when Konrad decided.
                        expected_status: job?.status,
                        confirm: retryNeedsConfirm || undefined,
                      },
                    });
                  }}
                  disabled={retryMutation.isPending}
                  style={{
                    padding: "7px 16px",
                    background: tokens.accent,
                    border: "none",
                    // Ink on a filled accent button: `bgBody` is the page
                    // colour, so it is near-black on the dark palette's light
                    // accent and near-white on the light palette's deep blue.
                    // A literal #fff is only legible in one of the two themes
                    // (SecretField.tsx settled this the same way).
                    color: tokens.bgBody,
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: retryMutation.isPending ? "not-allowed" : "pointer",
                    opacity: retryMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {retryMutation.isPending
                    ? "Retrying..."
                    : retryNeedsConfirm
                      ? "Force This Retry"
                      : "Confirm Retry"}
                </button>
              </div>
            </div>
          </div>
        </ModalBackdrop>
      )}

      {showAdvanceModal && (
        <ModalBackdrop onClose={() => setShowAdvanceModal(false)}>
          <div style={{ width: 440, background: tokens.bgCard, border: `1px solid ${tokens.border}`, borderRadius: 10, padding: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: tokens.textHi, margin: "0 0 12px 0" }}>
              ⏩ Advance Pipeline Stage
            </h3>
            <p style={{ fontSize: 12, color: tokens.textMuted, lineHeight: 1.45, marginBottom: 14 }}>
              Approve a human gate or push this job to the next lifecycle stage (e.g. approve QC or clear uploader gate).
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  TARGET STATUS (OPTIONAL)
                </label>
                <select
                  value={advanceStatus}
                  onChange={(e) => {
                    setAdvanceStatus(e.target.value);
                    setAdvanceNeedsConfirm(false);
                  }}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                >
                  <option value="">Default next status</option>
                  <option value="ROUTING_RENDER">Approve QC → ROUTING_RENDER</option>
                  <option value="AWAITING_UPLOADER">Finish Render → AWAITING_UPLOADER</option>
                  <option value="PUBLISHED">Confirm Upload → PUBLISHED</option>
                  <option value="UPLOADING">Start Upload → UPLOADING</option>
                </select>
              </div>

              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  QC FEEDBACK / APPROVAL NOTE
                </label>
                <input
                  type="text"
                  placeholder="e.g. Approved visual review and pacing"
                  value={advanceFeedback}
                  onChange={(e) => setAdvanceFeedback(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                />
              </div>

              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  REASON
                </label>
                <input
                  type="text"
                  placeholder="e.g. Human operator manual advance"
                  value={advanceReason}
                  onChange={(e) => setAdvanceReason(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => setShowAdvanceModal(false)}
                  style={{
                    padding: "7px 14px",
                    background: "transparent",
                    border: `1px solid ${tokens.borderSoft}`,
                    color: tokens.textMuted,
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    advanceMutation.mutate({
                      id: jobId,
                      body: {
                        target_status: advanceStatus || undefined,
                        feedback: advanceFeedback || undefined,
                        reason: advanceReason || undefined,
                        expected_status: job?.status,
                        confirm: advanceNeedsConfirm || undefined,
                      },
                    });
                  }}
                  disabled={advanceMutation.isPending}
                  style={{
                    padding: "7px 16px",
                    background: tokens.ok,
                    border: "none",
                    color: tokens.bgBody,
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: advanceMutation.isPending ? "not-allowed" : "pointer",
                    opacity: advanceMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {advanceMutation.isPending
                    ? "Advancing..."
                    : advanceNeedsConfirm
                      ? "Force This Advance"
                      : "Confirm Advance"}
                </button>
              </div>
            </div>
          </div>
        </ModalBackdrop>
      )}

      {showAssignModal && (
        <ModalBackdrop onClose={() => setShowAssignModal(false)}>
          <div style={{ width: 440, background: tokens.bgCard, border: `1px solid ${tokens.border}`, borderRadius: 10, padding: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: tokens.textHi, margin: "0 0 12px 0" }}>
              👤 Assign VA Team Member
            </h3>
            <p style={{ fontSize: 12, color: tokens.textMuted, lineHeight: 1.45, marginBottom: 14 }}>
              Select which Virtual Assistant should take ownership of this job for production review or uploading.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  ASSIGNMENT ROLE
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => {
                      setAssignRole("production");
                      setSelectedVaUserId(job?.assigned_production_va_id || "");
                    }}
                    style={{
                      flex: 1,
                      padding: "8px",
                      background: assignRole === "production" ? tokens.primaryActionBg : tokens.bgBody,
                      border: `1px solid ${assignRole === "production" ? tokens.accent : tokens.borderSoft}`,
                      color: assignRole === "production" ? tokens.accent : tokens.textMuted,
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    Production VA
                  </button>
                  <button
                    onClick={() => {
                      setAssignRole("uploader");
                      setSelectedVaUserId(job?.assigned_uploader_va_id || "");
                    }}
                    style={{
                      flex: 1,
                      padding: "8px",
                      background: assignRole === "uploader" ? tokens.primaryActionBg : tokens.bgBody,
                      border: `1px solid ${assignRole === "uploader" ? tokens.accent : tokens.borderSoft}`,
                      color: assignRole === "uploader" ? tokens.accent : tokens.textMuted,
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    Uploader VA
                  </button>
                </div>
              </div>

              <div>
                <label className="mono" style={{ fontSize: 11, color: tokens.textFaint, display: "block", marginBottom: 4 }}>
                  TEAM MEMBER ({meta?.users.length || 0} active users)
                </label>
                <select
                  value={selectedVaUserId}
                  onChange={(e) => setSelectedVaUserId(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    background: tokens.bgBody,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    color: tokens.textBody,
                    fontSize: 12,
                  }}
                >
                  <option value="">— Unassign (Clear VA) —</option>
                  {meta?.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role}) — {u.email}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => setShowAssignModal(false)}
                  style={{
                    padding: "7px 14px",
                    background: "transparent",
                    border: `1px solid ${tokens.borderSoft}`,
                    color: tokens.textMuted,
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    assignMutation.mutate({
                      id: jobId,
                      body: {
                        role: assignRole,
                        user_id: selectedVaUserId || null,
                        // The assignment this screen was showing. If someone
                        // else reassigned the job in the meantime the server
                        // 409s instead of silently undoing them.
                        ...(assignRole === "production"
                          ? {
                              expected_production_va_id:
                                job?.assigned_production_va_id ?? null,
                            }
                          : {
                              expected_uploader_va_id:
                                job?.assigned_uploader_va_id ?? null,
                            }),
                      },
                    });
                  }}
                  disabled={assignMutation.isPending}
                  style={{
                    padding: "7px 16px",
                    background: tokens.accent,
                    border: "none",
                    // Ink on a filled accent button: `bgBody` is the page
                    // colour, so it is near-black on the dark palette's light
                    // accent and near-white on the light palette's deep blue.
                    // A literal #fff is only legible in one of the two themes
                    // (SecretField.tsx settled this the same way).
                    color: tokens.bgBody,
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: assignMutation.isPending ? "not-allowed" : "pointer",
                    opacity: assignMutation.isPending ? 0.6 : 1,
                  }}
                >
                  {assignMutation.isPending ? "Saving..." : "Save Assignment"}
                </button>
              </div>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </div>
  );
}

/* ===========================================================================
 * HELPER SUB-COMPONENTS
 * ========================================================================= */

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.borderSoft}`,
        borderRadius: 6,
        padding: "8px 10px",
      }}
    >
      <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi, marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}

function TimestampRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
        {label}
      </span>
      <span className="mono" style={{ fontSize: 11, color: tokens.textSoft }}>
        {value}
      </span>
    </div>
  );
}

function JsonViewer({ title, data }: { title: string; data: unknown }) {
  const [open, setOpen] = useState(true);
  const formatted = useMemo(() => {
    if (data === null || data === undefined) return null;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  return (
    <div
      style={{
        background: tokens.bgBody,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span className="mono" style={{ fontSize: 11, color: tokens.textFaint, letterSpacing: "0.08em" }}>
          {title}
        </span>
        <span className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
          {open ? "▲ collapse" : "▼ expand"}
        </span>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {formatted ? (
            <pre
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.textBody,
                background: tokens.bgCard,
                padding: 12,
                borderRadius: 6,
                border: `1px solid ${tokens.borderSoft}`,
                overflowX: "auto",
                maxHeight: 320,
                lineHeight: 1.45,
                margin: 0,
              }}
            >
              {formatted}
            </pre>
          ) : (
            <div className="mono" style={{ fontSize: 11, color: tokens.textGhost, padding: "8px 0" }}>
              No data recorded
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface StateTransition {
  from?: string;
  to?: string;
  timestamp?: string;
  actor?: string;
  reason?: string;
}

function StateHistoryTimeline({ history }: { history: unknown }) {
  const entries: StateTransition[] = useMemo(() => {
    if (!Array.isArray(history)) return [];
    return history.filter((item): item is StateTransition => typeof item === "object" && item !== null);
  }, [history]);

  return (
    <div
      style={{
        background: tokens.bgBody,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "14px 16px",
      }}
    >
      <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, letterSpacing: "0.08em", marginBottom: 12 }}>
        STATE MACHINE TRANSITION TIMELINE ({entries.length} events)
      </div>

      {entries.length === 0 ? (
        <div className="mono" style={{ fontSize: 11, color: tokens.textGhost, padding: 12, textAlign: "center" }}>
          No transition history recorded for this job.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {entries.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                gap: 12,
                padding: "8px 10px",
                background: tokens.bgCard,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 6,
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.accent,
                  flex: "none",
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: tokens.textHi }}>
                    {item.from || "START"} → {item.to || "UNKNOWN"}
                  </span>
                  {item.actor && (
                    <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                      by {item.actor}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {item.timestamp && (
                    <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
                      {formatTimestamp(item.timestamp)}
                    </span>
                  )}
                </div>
                {item.reason && (
                  <div style={{ fontSize: 11.5, color: tokens.textMuted, marginTop: 4 }}>
                    {item.reason}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModalBackdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1000,
        background: tokens.overlay,
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
