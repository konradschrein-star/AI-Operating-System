"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  tierColor,
  providerColor,
  liveStatColor,
  type ServiceDegradation,
  type Provider,
} from "../data";
import { AgentActivity } from "./live/AgentActivity";
import { toast } from "./_ui/Toasts";

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

export interface LiveStat {
  label: string;
  value: string;
  tone: "accent" | "soft" | "neutral" | "stuck";
}

export interface LiveResponse {
  stats: LiveStat[];
  degradation: ServiceDegradation[];
  providers: Provider[];
}

export interface SubsystemCheck {
  status: "ok" | "warn" | "error";
  latency_ms: number;
  detail: string;
  [key: string]: unknown;
}

export interface QuickCheckResult {
  ok: boolean;
  duration_ms: number;
  checked_at: string;
  summary: string;
  checks: {
    postgres: SubsystemCheck;
    claude_oauth: SubsystemCheck;
    gemini_cli: SubsystemCheck;
    pm2: SubsystemCheck & { online?: number; total?: number };
    systemd: SubsystemCheck & { flapping?: number };
    disk: SubsystemCheck & { used_gb?: number; total_gb?: number; pct?: number };
  };
}

export interface DeepCheckStep {
  name: string;
  status: "pending" | "running" | "passed" | "failed";
  exit_code: number | null;
  duration_ms: number;
  summary: string;
}

export interface DeepCheckState {
  id: string;
  status: "idle" | "running" | "completed" | "failed";
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number;
  current_step: string;
  steps: DeepCheckStep[];
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  suites_total: number;
  logs: string[];
  failure_output: string;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

const ROOT = "/api/proxy";

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

function statusBadgeColor(
  status: "ok" | "warn" | "error" | "pending" | "running" | "passed" | "failed" | "idle" | "completed",
): string {
  switch (status) {
    case "ok":
    case "passed":
    case "completed":
      return tokens.ok;
    case "warn":
    case "running":
      return tokens.warn;
    case "error":
    case "failed":
      return tokens.bleed;
    default:
      return tokens.textMuted;
  }
}

/* ----------------------------------------------------------------------------
 * LiveSurface Component
 * -------------------------------------------------------------------------- */

export function LiveSurface({ data: initialData }: { data?: LiveResponse }) {
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showLogs, setShowLogs] = useState(true);
  const [quickCheckResult, setQuickCheckResult] = useState<QuickCheckResult | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // Poll live data if initialData not provided or to keep synced
  const liveQ = useQuery<LiveResponse>({
    queryKey: ["live", "poll"],
    queryFn: () => getJson<LiveResponse>("/live"),
    initialData: initialData,
    refetchInterval: 4_000,
  });

  const data = liveQ.data ?? initialData ?? { stats: [], degradation: [], providers: [] };

  // Poll deep check state
  const deepQ = useQuery<DeepCheckState>({
    queryKey: ["live", "deep-check"],
    queryFn: () => getJson<DeepCheckState>("/live/deep-check"),
    refetchInterval: (query) => {
      const state = query.state.data;
      return state?.status === "running" ? 1_000 : 8_000;
    },
  });

  const deepState = deepQ.data;
  const isDeepRunning = deepState?.status === "running";

  // Auto-open drawer when deep check is running
  useEffect(() => {
    if (isDeepRunning) {
      setDrawerOpen(true);
    }
  }, [isDeepRunning]);

  // Auto-scroll logs when drawer is open and running
  useEffect(() => {
    if (drawerOpen && isDeepRunning && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [drawerOpen, isDeepRunning, deepState?.logs?.length]);

  // Quick Check Mutation (⚡ Check Everything)
  const quickCheckM = useMutation({
    mutationFn: () => postJson<QuickCheckResult>("/live/check"),
    onSuccess: (res) => {
      setQuickCheckResult(res);
      void queryClient.invalidateQueries({ queryKey: ["live"] });
      if (res.ok) {
        toast(`⚡ ${res.summary}`, "ok", `All 6 subsystems probed in ${res.duration_ms}ms`);
      } else {
        toast(`⚠ ${res.summary}`, "error", "Degraded subsystems detected");
      }
    },
    onError: (err) => {
      toast("Health sweep failed", "error", err instanceof Error ? err.message : String(err));
    },
  });

  // Deep Check Mutation (🔬 Deep Check)
  const deepCheckM = useMutation({
    mutationFn: () => postJson<DeepCheckState>("/live/deep-check"),
    onSuccess: (state) => {
      setDrawerOpen(true);
      void queryClient.setQueryData(["live", "deep-check"], state);
      toast("🔬 Deep check suite started", "info", "Executing unit tests (src/lib/*.test.ts) + gates-808.sh");
    },
    onError: (err) => {
      toast("Failed to start deep check", "error", err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <div className="slidein" style={{ padding: "18px 24px 48px" }}>
      {/* Top Header & Action Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: tokens.textHi,
              letterSpacing: "-0.01em",
            }}
          >
            Live · The Machine
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textFaint,
              marginTop: 2,
            }}
          >
            Fleet concurrency · subsystem telemetry · universal gates
          </div>
        </div>

        {/* Primary Health Action Buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* ⚡ Check Everything Button */}
          <button
            type="button"
            onClick={() => quickCheckM.mutate()}
            disabled={quickCheckM.isPending}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              height: 36,
              padding: "0 16px",
              fontSize: 13,
              fontWeight: 600,
              color: tokens.accentInk,
              background: tokens.accent,
              border: "none",
              borderRadius: 6,
              cursor: quickCheckM.isPending ? "not-allowed" : "pointer",
              opacity: quickCheckM.isPending ? 0.75 : 1,
              boxShadow: `0 1px 2px ${tokens.shadowSm}`,
              transition: "transform 0.1s ease, opacity 0.1s ease",
            }}
          >
            <span>⚡</span>
            <span>{quickCheckM.isPending ? "Checking 6 Subsystems..." : "Check Everything"}</span>
          </button>

          {/* 🔬 Deep Check Button */}
          <button
            type="button"
            onClick={() => deepCheckM.mutate()}
            disabled={deepCheckM.isPending || isDeepRunning}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              height: 36,
              padding: "0 16px",
              fontSize: 13,
              fontWeight: 500,
              color: tokens.textHi,
              background: "transparent",
              border: `1px solid ${tokens.borderEmphasis ?? tokens.border}`,
              borderRadius: 6,
              cursor: (deepCheckM.isPending || isDeepRunning) ? "not-allowed" : "pointer",
              opacity: (deepCheckM.isPending || isDeepRunning) ? 0.8 : 1,
              transition: "border-color 0.1s ease, background 0.1s ease",
            }}
          >
            <span>🔬</span>
            <span>
              {isDeepRunning
                ? `Running Tests (${Math.round((deepState?.duration_ms ?? 0) / 1000)}s)...`
                : "Deep Check"}
            </span>
          </button>

          {/* Drawer Toggle */}
          {deepState && deepState.status !== "idle" && (
            <button
              type="button"
              onClick={() => setDrawerOpen(!drawerOpen)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 36,
                padding: "0 12px",
                fontSize: 12,
                color: tokens.textMuted,
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: statusBadgeColor(deepState.status),
                }}
              />
              <span className="mono">
                {drawerOpen ? "Hide Drawer" : `Deep Check (${deepState.status.toUpperCase()})`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Quick Check Inline Banner (when recently checked) */}
      {quickCheckResult && (
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${quickCheckResult.ok ? tokens.ok : tokens.warn}`,
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: quickCheckResult.ok ? tokens.ok : tokens.warn,
                }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
                {quickCheckResult.summary}
              </span>
              <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                probed in {quickCheckResult.duration_ms}ms at{" "}
                {new Date(quickCheckResult.checked_at).toLocaleTimeString()}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setQuickCheckResult(null)}
              style={{
                background: "transparent",
                border: "none",
                color: tokens.textFaint,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              ✕
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 8,
            }}
          >
            {Object.entries(quickCheckResult.checks).map(([key, check]) => (
              <div
                key={key}
                style={{
                  background: tokens.bgBody,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 11, fontWeight: 500, color: tokens.textLabel }}>
                    {key.toUpperCase().replace("_", " ")}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: tokens.textFaint,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={check.detail}
                  >
                    {check.detail}
                  </div>
                </div>
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    padding: "2px 6px",
                    borderRadius: 4,
                    color: statusBadgeColor(check.status),
                    border: `1px solid ${tokens.border}`,
                    background: tokens.bgCard,
                  }}
                >
                  {check.status.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expandable Deep Check Drawer / Modal Panel */}
      {drawerOpen && deepState && (
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderEmphasis ?? tokens.border}`,
            borderRadius: 8,
            padding: "16px 20px",
            marginBottom: 16,
            boxShadow: `0 4px 12px ${tokens.shadowMd}`,
          }}
        >
          {/* Drawer Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
              paddingBottom: 10,
              borderBottom: `1px solid ${tokens.borderDivider}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: statusBadgeColor(deepState.status),
                }}
              />
              <span style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi }}>
                Deep Test Runner & Gates
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 4,
                  fontWeight: 600,
                  color: statusBadgeColor(deepState.status),
                  background: tokens.bgBody,
                  border: `1px solid ${tokens.border}`,
                }}
              >
                {deepState.status.toUpperCase()}
              </span>
              {deepState.tests_total > 0 && (
                <span className="mono" style={{ fontSize: 12, color: tokens.textMuted }}>
                  {deepState.tests_passed} / {deepState.tests_total} tests passed (
                  {(deepState.duration_ms / 1000).toFixed(1)}s)
                </span>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowLogs(!showLogs)}
                style={{
                  background: "transparent",
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 4,
                  padding: "4px 8px",
                  fontSize: 11,
                  color: tokens.textMuted,
                  cursor: "pointer",
                }}
              >
                {showLogs ? "Hide Logs" : "Show Transcript"}
              </button>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: tokens.textFaint,
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "4px 8px",
                }}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Current Step Progress */}
          {isDeepRunning && (
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span className="mono" style={{ fontSize: 11, color: tokens.textLabel }}>
                  CURRENT STEP: {deepState.current_step}
                </span>
                <span className="mono" style={{ fontSize: 11, color: tokens.accent }}>
                  Elapsed: {(deepState.duration_ms / 1000).toFixed(1)}s
                </span>
              </div>
              <div
                style={{
                  width: "100%",
                  height: 4,
                  background: tokens.bgBody,
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: deepState.current_step.includes("Gates") ? "75%" : "35%",
                    height: "100%",
                    background: tokens.accent,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          )}

          {/* Step Cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {deepState.steps.map((step, idx) => (
              <div
                key={idx}
                style={{
                  background: tokens.bgBody,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div className="mono" style={{ fontSize: 12, fontWeight: 500, color: tokens.textLabel }}>
                    {step.name}
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 2 }}>
                    {step.summary}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {step.duration_ms > 0 && (
                    <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                      {(step.duration_ms / 1000).toFixed(1)}s
                    </span>
                  )}
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 4,
                      color: statusBadgeColor(step.status),
                      background: tokens.bgCard,
                      border: `1px solid ${tokens.border}`,
                    }}
                  >
                    {step.status.toUpperCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Failure Alert Box (if tests or gates failed) */}
          {deepState.failure_output && (
            <div
              style={{
                background: tokens.bgBody,
                border: `1px solid ${tokens.bleed}`,
                borderRadius: 6,
                padding: "12px 14px",
                marginBottom: 12,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: tokens.bleed,
                  marginBottom: 6,
                }}
              >
                VERBATIM FAILURE REPORT
              </div>
              <pre
                className="mono"
                style={{
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: tokens.textHi,
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              >
                {deepState.failure_output}
              </pre>
            </div>
          )}

          {/* Execution Logs Terminal */}
          {showLogs && (
            <div
              style={{
                background: tokens.toolBg,
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                padding: "12px 14px",
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textFaint,
                  marginBottom: 6,
                  letterSpacing: "0.05em",
                }}
              >
                TERMINAL OUTPUT ({deepState.logs.length} LINES)
              </div>
              <pre
                className="mono"
                style={{
                  fontSize: 10.5,
                  lineHeight: 1.4,
                  color: tokens.textBody,
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {deepState.logs.join("\n") || "No log output recorded."}
                <div ref={logsEndRef} />
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Agent Activity Section (Live Agent Runs) */}
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          marginBottom: 16,
          display: "flex",
          flexDirection: "column",
          minHeight: 280,
          maxHeight: 460,
          overflow: "hidden",
        }}
      >
        <AgentActivity />
      </div>

      {/* Unified Operational KPI Strip */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {data.stats.map((s, i) => (
          <div
            key={i}
            style={{
              flex: "1 1 140px",
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "11px 14px",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 9.5,
                color: tokens.textFaint,
                letterSpacing: "0.06em",
              }}
            >
              {s.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 19,
                fontWeight: 600,
                color: liveStatColor(s.tone),
                marginTop: 6,
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Lower Two-Column Grid: Pulse & Host Telemetry */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Left Column: System & Provider Pulse */}
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              color: tokens.textFaint,
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            SYSTEM & PROVIDER PULSE
          </div>

          {data.providers.length === 0 ? (
            <div
              className="mono"
              style={{
                background: tokens.bgCard,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 8,
                padding: 18,
                fontSize: 11,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              No providers configured.
            </div>
          ) : (
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 8,
                overflow: "hidden",
                marginBottom: 14,
              }}
            >
              {data.providers.map((p, i) => {
                const color = providerColor(p.status);
                const isLast = i === data.providers.length - 1;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "11px 15px",
                      borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    <span style={dot(color, p.status !== "ok")} />
                    <span
                      className="mono"
                      style={{ fontSize: 11.5, color: tokens.textLabel }}
                    >
                      {p.name}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 10, color }}>
                      {p.badge}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Degradation List */}
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              color: tokens.textFaint,
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            SERVICE DEGRADATION
          </div>
          {data.degradation.length === 0 ? (
            <div
              className="mono"
              style={{
                background: tokens.bgCard,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 8,
                padding: 16,
                fontSize: 11,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              No service degradation reported.
            </div>
          ) : (
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {data.degradation.map((d, i) => {
                const color = tierColor(d.tier);
                const isLast = i === data.degradation.length - 1;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "11px 15px",
                      borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 11.5, color: tokens.textLabel }}>
                        {d.svc}
                      </div>
                      <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 2 }}>
                        {d.why}
                      </div>
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color,
                        border: `1px solid ${tokens.border}`,
                        borderRadius: 5,
                        padding: "2px 7px",
                      }}
                    >
                      {d.tier}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Subsystems & Test History */}
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              color: tokens.textFaint,
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            HOST SUBSYSTEMS & GATES
          </div>

          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {/* Quick Summary Rows */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 8,
                borderBottom: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                PostgreSQL 16
              </span>
              <span className="mono" style={{ fontSize: 11, color: tokens.ok }}>
                Connected (:5432)
              </span>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 8,
                borderBottom: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                Claude OAuth
              </span>
              <span className="mono" style={{ fontSize: 11, color: tokens.textLabel }}>
                /root/.claude
              </span>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 8,
                borderBottom: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                Gemini CLI (agy)
              </span>
              <span className="mono" style={{ fontSize: 11, color: tokens.textLabel }}>
                /root/.local/bin/agy
              </span>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 8,
                borderBottom: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                Unit Test Suite
              </span>
              <span className="mono" style={{ fontSize: 11, color: deepState?.status === "completed" ? tokens.ok : tokens.textLabel }}>
                {deepState && deepState.tests_total > 0
                  ? `${deepState.tests_passed} / ${deepState.tests_total} PASS`
                  : "Not run yet"}
              </span>
            </div>

            <div style={{ paddingTop: 4 }}>
              <button
                type="button"
                onClick={() => {
                  setDrawerOpen(true);
                  if (!isDeepRunning && deepState?.status === "idle") {
                    deepCheckM.mutate();
                  }
                }}
                style={{
                  width: "100%",
                  height: 32,
                  background: tokens.bgBody,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  color: tokens.textLabel,
                  fontSize: 11,
                  fontFamily: "monospace",
                  cursor: "pointer",
                }}
              >
                {deepState?.status && deepState.status !== "idle" ? "Inspect Full Test Log →" : "Run Full Test Suite →"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LiveSurface;