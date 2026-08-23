"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import { toast } from "./_ui/Toasts";

/* ----------------------------------------------------------------------------
 * Telemetry Types (Matching forge-control/src/routes/control.ts)
 * -------------------------------------------------------------------------- */

export interface HostCpu {
  load_1m: number;
  load_5m: number;
  load_15m: number;
  running_total: string | null;
}

export interface HostMemory {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  free_bytes: number;
  buffers_bytes: number;
  cached_bytes: number;
  used_pct: number;
  swap: {
    total_bytes: number;
    used_bytes: number;
    used_pct: number;
  };
}

export interface DiskMount {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_pct: number;
}

export interface Pm2Process {
  name: string;
  pid: number | null;
  status: string;
  restarts: number;
  uptime_ms: number;
  cpu_pct: number;
  memory_bytes: number;
}

export interface Pm2Summary {
  count: number;
  online: number;
  stopped: number;
  processes: Pm2Process[];
}

export interface SystemdSummary {
  count: number;
  active: number;
  flapping: number;
  failed: number;
}

export interface HostTelemetry {
  ip: string;
  hostname: string;
  uptime_seconds: number;
  cpu: HostCpu;
  memory: HostMemory;
  disks: Record<string, DiskMount>;
  pm2: Pm2Summary;
  systemd: SystemdSummary;
}

export interface WindowsVmTelemetry {
  name: string;
  status: "running" | "stopped";
  pid: number | null;
  memory_allocated: string;
  vcpus: number;
  vnc_internal_port: number;
  novnc_port: number;
  novnc_url: string;
  novnc_active: boolean;
  rdp_address: string;
  rdp_active: boolean;
}

export interface HermesWorkerTelemetry {
  id: string;
  role: string;
  worker_type: string;
  tmux_session: string;
  status: string;
  spawn_count: number;
  last_spawn: string | null;
  created_at: string;
  latest_heartbeat: {
    id: string;
    state: string;
    progress: number;
    failures: number;
    needs_human: boolean;
    recorded_at: string;
    activity_at: string | null;
  } | null;
  heartbeat_age_sec: number | null;
}

export interface HermesFleetTelemetry {
  workers: HermesWorkerTelemetry[];
  counts: {
    running: number;
    dead: number;
    stopped: number;
    suspected: number;
    total: number;
  };
}

export interface VeoWorker {
  id: string;
  name: string;
  unit: string;
  proxy_type: string;
  status: "active" | "inactive" | "failed" | "dead";
  active: boolean;
  description: string;
}

export interface VeoFarmTelemetry {
  workers: VeoWorker[];
  orch_active: boolean;
  proxy_active: boolean;
}

export interface Vps2TargetTelemetry {
  ip: string;
  hostname: string;
  location: string;
  specs: string;
  role: string;
  status: "restricted";
  ssh_status: string;
  access_note: string;
  honest: boolean;
}

export interface GuardrailTripItem {
  id: string;
  rule_id: string;
  rule_label: string;
  ts: string;
  agent: string;
  attempted_action: string;
  resolved: boolean;
}

export interface AutonomyCategory {
  key: string;
  label: string;
  count: number;
}

export interface InvariantTelemetry {
  active_rules_count: number;
  categories: AutonomyCategory[];
  recent_trips: GuardrailTripItem[];
  trips_count: number;
}

export interface ControlDecisionLog {
  ts: string;
  kind: string;
  action: string;
}

export interface ControlTelemetryResponse {
  fleet: {
    status: "running" | "paused";
    updated_at: string;
    updated_by: string;
  };
  host: HostTelemetry;
  windows_vm: WindowsVmTelemetry;
  hermes: HermesFleetTelemetry;
  veo: VeoFarmTelemetry;
  vps2: Vps2TargetTelemetry;
  invariant: InvariantTelemetry;
  decisionLog: ControlDecisionLog[];
}

/* ----------------------------------------------------------------------------
 * HTTP Helpers
 * -------------------------------------------------------------------------- */

const ROOT = "/api/proxy";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

/* ----------------------------------------------------------------------------
 * Formatters
 * -------------------------------------------------------------------------- */

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fmtUptime(sec: number): string {
  if (!sec || sec <= 0) return "0s";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${sec % 60}s`;
}

function fmtAge(ageSec: number | null): string {
  if (ageSec === null || ageSec === undefined) return "no heartbeat";
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}

function workerStatusColor(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
    case "active":
    case "online":
      return tokens.ok;
    case "suspected":
    case "flapping":
    case "warn":
      return tokens.warn;
    case "dead":
    case "failed":
    case "error":
      return tokens.bleed;
    case "stopped":
    case "inactive":
    default:
      return tokens.textMuted;
  }
}

/* ----------------------------------------------------------------------------
 * Main Component: ControlSurface
 * -------------------------------------------------------------------------- */

export function ControlSurface({
  data: initialData,
  onFreeze: externalOnFreeze,
}: {
  data?: ControlTelemetryResponse;
  onFreeze?: () => void;
}) {
  const qc = useQueryClient();
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [showPm2Processes, setShowPm2Processes] = useState(false);
  const [pm2Filter, setPm2Filter] = useState("");
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  // 10-second auto-polling query
  const controlQ = useQuery<ControlTelemetryResponse>({
    queryKey: ["control"],
    queryFn: () => getJson<ControlTelemetryResponse>("/control"),
    initialData,
    refetchInterval: 10_000,
  });

  const data = controlQ.data;
  const paused = data?.fleet?.status === "paused";

  // Freeze/Resume Mutation
  const freezeMut = useMutation({
    mutationFn: () => (paused ? postJson("/control/resume", { actor: "user" }) : postJson("/control/freeze", { actor: "user" })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["control"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
      toast(paused ? "Fleet resumed" : "Fleet FROZEN", paused ? "ok" : "info", paused ? "Dispatch engine is running" : "All autonomous dispatch held");
    },
    onError: (err) => {
      toast("Freeze toggle failed", "error", err instanceof Error ? err.message : String(err));
    },
  });

  const handleToggleFreeze = () => {
    if (externalOnFreeze) {
      externalOnFreeze();
    } else {
      freezeMut.mutate();
    }
  };

  // Tmux Tail Query
  const tmuxQ = useQuery<{ session: string; lines: string[] }>({
    queryKey: ["control", "tmux-tail", selectedSession],
    queryFn: () => getJson<{ session: string; lines: string[] }>(`/control/tmux-tail/${selectedSession}?lines=35`),
    enabled: Boolean(selectedSession),
    refetchInterval: selectedSession ? 2_500 : false,
  });

  // Worker Restart Mutation
  const restartWorkerMut = useMutation({
    mutationFn: (workerId: string) => postJson<{ ok: boolean; message: string }>(`/control/hermes/restart/${workerId}`),
    onSuccess: (res, workerId) => {
      void qc.invalidateQueries({ queryKey: ["control"] });
      toast(`Worker restarted: ${workerId}`, "ok", res.message);
    },
    onError: (err) => {
      toast("Worker restart failed", "error", err instanceof Error ? err.message : String(err));
    },
  });

  useEffect(() => {
    if (selectedSession && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [selectedSession, tmuxQ.data?.lines?.length]);

  if (!data) {
    return (
      <div className="slidein" style={{ padding: "24px 32px", color: tokens.textMuted }}>
        Loading real fleet telemetry…
      </div>
    );
  }

  const { host, windows_vm, hermes, veo, vps2, invariant, decisionLog } = data;

  const filteredPm2 = (host?.pm2?.processes ?? []).filter((p) =>
    pm2Filter ? p.name.toLowerCase().includes(pm2Filter.toLowerCase()) : true,
  );

  return (
    <div className="slidein" style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Main Telemetry Stream */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          padding: "20px 24px 48px",
        }}
      >
        {/* Header Title */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi }}>
            Fleet Control Room
          </span>
          <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            Host Telemetry · Worker Fleet · Virtual Machines · Egress Nodes
          </span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 20 }}>
          Real device & infrastructure governance. Direct process and node telemetry (no simulated loops).
        </div>

        {/* Global Fleet Freeze / Resume Banner */}
        <div
          onClick={handleToggleFreeze}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            border: `1.5px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
            background: paused ? tokens.freezeBgWarn : tokens.freezeBgOk,
            borderRadius: 12,
            padding: "14px 18px",
            marginBottom: 24,
            cursor: "pointer",
            userSelect: "none",
            transition: "all 0.15s ease",
          }}
        >
          <span
            className="ms"
            style={{ fontSize: 26, color: paused ? tokens.warn : tokens.ok }}
          >
            {paused ? "ac_unit" : "bolt"}
          </span>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: paused ? tokens.warn : tokens.ok,
              }}
            >
              {paused ? "Fleet is FROZEN" : "Fleet is running autonomously"}
            </div>
            <div style={{ fontSize: 11.5, color: tokens.textSecondary, marginTop: 2 }}>
              {paused
                ? "Every worker is held. No new autonomous runs will be dispatched until resumed."
                : "Active dispatch across Hermes workers, AI OS executors, and VEO jobs within trust limits."}
            </div>
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 8,
              padding: "7px 16px",
              color: paused ? tokens.freezeBgOk : tokens.freezeBgWarn,
              background: paused ? tokens.ok : tokens.warn,
              letterSpacing: "0.03em",
            }}
          >
            {paused ? "RESUME FLEET" : "FREEZE ALL"}
          </div>
        </div>

        {/* SECTION 1: PRIMARY HOST VPS (65.108.6.149) */}
        <div style={{ marginBottom: 26 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="ms" style={{ fontSize: 16, color: tokens.accent }}>
                dns
              </span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi, letterSpacing: "0.05em" }}>
                PRIMARY HOST VPS · {host.ip}
              </span>
              <span className="mono" style={{ fontSize: 9.5, color: tokens.textMuted }}>
                ({host.hostname})
              </span>
            </div>
            <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
              Uptime: {fmtUptime(host.uptime_seconds)}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {/* CPU Load Card */}
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                padding: "12px 14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  CPU LOAD AVG
                </span>
                <span className="ms" style={{ fontSize: 14, color: tokens.textFaint }}>
                  speed
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="mono" style={{ fontSize: 18, fontWeight: 600, color: tokens.textHi }}>
                  {host.cpu.load_1m.toFixed(2)}
                </span>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  5m: {host.cpu.load_5m.toFixed(2)} · 15m: {host.cpu.load_15m.toFixed(2)}
                </span>
              </div>
              {host.cpu.running_total && (
                <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 4 }}>
                  Tasks: {host.cpu.running_total}
                </div>
              )}
            </div>

            {/* RAM Card */}
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                padding: "12px 14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  MEMORY (RAM)
                </span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: host.memory.used_pct > 85 ? tokens.warn : tokens.ok }}>
                  {host.memory.used_pct}%
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi }}>
                  {fmtBytes(host.memory.used_bytes)}
                </span>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  / {fmtBytes(host.memory.total_bytes)}
                </span>
              </div>
              {/* Progress bar */}
              <div style={{ height: 4, background: tokens.border, borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, host.memory.used_pct)}%`,
                    background: host.memory.used_pct > 85 ? tokens.warn : tokens.ok,
                  }}
                />
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 4 }}>
                Free: {fmtBytes(host.memory.available_bytes)} · Swap: {fmtBytes(host.memory.swap?.used_bytes ?? 0)}
              </div>
            </div>

            {/* Disk Root Card */}
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                padding: "12px 14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  DISK ( / )
                </span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: (host.disks["/"]?.used_pct ?? 0) > 85 ? tokens.warn : tokens.ok }}>
                  {host.disks["/"]?.used_pct ?? 0}%
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi }}>
                  {fmtBytes(host.disks["/"]?.used_bytes ?? 0)}
                </span>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  / {fmtBytes(host.disks["/"]?.total_bytes ?? 0)}
                </span>
              </div>
              <div style={{ height: 4, background: tokens.border, borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, host.disks["/"]?.used_pct ?? 0)}%`,
                    background: (host.disks["/"]?.used_pct ?? 0) > 85 ? tokens.warn : tokens.ok,
                  }}
                />
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 4 }}>
                /opt: {fmtBytes(host.disks["/opt"]?.used_bytes ?? 0)} ({host.disks["/opt"]?.used_pct ?? 0}%)
              </div>
            </div>

            {/* Systemd & Process Health */}
            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                padding: "12px 14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  SYSTEMD UNITS
                </span>
                <span style={dot(host.systemd.flapping > 0 || host.systemd.failed > 0 ? tokens.bleed : tokens.ok)} />
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <div>
                  <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: tokens.ok }}>
                    {host.systemd.active}
                  </span>
                  <span className="mono" style={{ fontSize: 9.5, color: tokens.textMuted, marginLeft: 4 }}>
                    active
                  </span>
                </div>
                {host.systemd.flapping > 0 && (
                  <div>
                    <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: tokens.warn }}>
                      {host.systemd.flapping}
                    </span>
                    <span className="mono" style={{ fontSize: 9.5, color: tokens.warn, marginLeft: 4 }}>
                      flapping
                    </span>
                  </div>
                )}
                {host.systemd.failed > 0 && (
                  <div>
                    <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: tokens.bleed }}>
                      {host.systemd.failed}
                    </span>
                    <span className="mono" style={{ fontSize: 9.5, color: tokens.bleed, marginLeft: 4 }}>
                      failed
                    </span>
                  </div>
                )}
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 6 }}>
                PM2: {host.pm2.online} online / {host.pm2.count} total
              </div>
            </div>
          </div>

          {/* PM2 Process List Toggle */}
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 9,
              overflow: "hidden",
            }}
          >
            <div
              onClick={() => setShowPm2Processes((s) => !s)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                cursor: "pointer",
                userSelect: "none",
                background: showPm2Processes ? tokens.selectedBg : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="ms" style={{ fontSize: 14, color: tokens.textMuted }}>
                  {showPm2Processes ? "expand_less" : "expand_more"}
                </span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textLabel }}>
                  PM2 PROCESSES ({host.pm2.online} online · {host.pm2.stopped} stopped)
                </span>
              </div>
              <span className="mono" style={{ fontSize: 10, color: tokens.accent }}>
                {showPm2Processes ? "Collapse Process Table" : "View All PM2 Workers"}
              </span>
            </div>

            {showPm2Processes && (
              <div style={{ padding: "10px 14px 14px", borderTop: `1px solid ${tokens.borderSoft}` }}>
                <input
                  type="text"
                  placeholder="Filter PM2 processes by name…"
                  value={pm2Filter}
                  onChange={(e) => setPm2Filter(e.target.value)}
                  className="mono"
                  style={{
                    width: "100%",
                    background: tokens.inputBg,
                    border: `1px solid ${tokens.border}`,
                    borderRadius: 6,
                    padding: "6px 10px",
                    fontSize: 11,
                    color: tokens.textHi,
                    marginBottom: 10,
                    outline: "none",
                  }}
                />

                <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {filteredPm2.map((proc, i) => {
                    const isOnline = proc.status === "online";
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 10px",
                          borderRadius: 6,
                          background: tokens.bgBody,
                          fontSize: 11,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span style={dot(isOnline ? tokens.ok : tokens.bleed)} />
                          <span className="mono" style={{ fontWeight: 600, color: tokens.textHi }}>
                            {proc.name}
                          </span>
                          {proc.pid && (
                            <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
                              PID {proc.pid}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                            CPU: {proc.cpu_pct}%
                          </span>
                          <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                            Mem: {fmtBytes(proc.memory_bytes)}
                          </span>
                          <span className="mono" style={{ fontSize: 10, color: proc.restarts > 5 ? tokens.warn : tokens.textFaint }}>
                            Restarts: {proc.restarts}
                          </span>
                          <span
                            className="mono"
                            style={{
                              fontSize: 9,
                              borderRadius: 4,
                              padding: "2px 6px",
                              background: isOnline ? `${tokens.ok}18` : `${tokens.bleed}18`,
                              color: isOnline ? tokens.ok : tokens.bleed,
                            }}
                          >
                            {proc.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* SECTION 2: HERMES TMUX WORKER FLEET */}
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="ms" style={{ fontSize: 16, color: tokens.decide }}>
                terminal
              </span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi, letterSpacing: "0.05em" }}>
                HERMES TMUX WORKER FLEET ({hermes.counts.running} RUNNING · {hermes.counts.total} SLOTS)
              </span>
            </div>
            <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
              Heartbeat & Tmux session governor
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hermes.workers.map((w) => {
              const statusColor = workerStatusColor(w.status);
              const isAttached = selectedSession === w.tmux_session;

              return (
                <div
                  key={w.id}
                  style={{
                    background: tokens.bgCard,
                    border: `1px solid ${isAttached ? tokens.accent : tokens.border}`,
                    borderRadius: 9,
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    transition: "border 0.15s ease",
                  }}
                >
                  <span style={dot(statusColor, w.status === "running")} />

                  <div style={{ width: 140, flex: "none" }}>
                    <div className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: tokens.textHi }}>
                      {w.id}
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: tokens.textMuted, marginTop: 2 }}>
                      {w.role}
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          borderRadius: 4,
                          padding: "2px 7px",
                          background: `${statusColor}18`,
                          color: statusColor,
                          fontWeight: 600,
                        }}
                      >
                        {w.status.toUpperCase()}
                      </span>
                      <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                        Tmux: {w.tmux_session}
                      </span>
                      <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                        Spawns: {w.spawn_count}
                      </span>
                    </div>

                    <div className="mono" style={{ fontSize: 10, color: tokens.textSecondary, marginTop: 4 }}>
                      Heartbeat: {fmtAge(w.heartbeat_age_sec)}
                      {w.latest_heartbeat?.state && ` · state: ${w.latest_heartbeat.state}`}
                      {w.latest_heartbeat?.needs_human && (
                        <span style={{ color: tokens.bleed, fontWeight: 600, marginLeft: 6 }}>
                          ⚠ NEEDS HUMAN
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                    {/* Tail Tmux Logs Button */}
                    <button
                      onClick={() => setSelectedSession(isAttached ? null : w.tmux_session)}
                      className="mono"
                      style={{
                        fontSize: 10,
                        padding: "5px 10px",
                        borderRadius: 6,
                        border: `1px solid ${tokens.border}`,
                        background: isAttached ? tokens.selectedBg : tokens.bgBody,
                        color: isAttached ? tokens.accent : tokens.textHi,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <span className="ms" style={{ fontSize: 12 }}>
                        segment
                      </span>
                      {isAttached ? "Close Tail" : "Tail Tmux"}
                    </button>

                    {/* Restart Worker Button */}
                    <button
                      onClick={() => restartWorkerMut.mutate(w.id)}
                      disabled={restartWorkerMut.isPending}
                      className="mono"
                      style={{
                        fontSize: 10,
                        padding: "5px 10px",
                        borderRadius: 6,
                        border: `1px solid ${tokens.border}`,
                        background: tokens.bgBody,
                        color: tokens.textMuted,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <span className="ms" style={{ fontSize: 12 }}>
                        restart_alt
                      </span>
                      Restart
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Tmux Tail Terminal Drawer */}
          {selectedSession && (
            <div
              style={{
                marginTop: 12,
                background: tokens.toolBg,
                border: `1px solid ${tokens.border}`,
                borderRadius: 9,
                padding: "14px 16px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 10,
                  borderBottom: `1px solid ${tokens.borderSoft}`,
                  paddingBottom: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="ms" style={{ fontSize: 14, color: tokens.ok }}>
                    terminal
                  </span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi }}>
                    TMUX TAIL: {selectedSession}
                  </span>
                  <span style={dot(tokens.ok, true)} />
                </div>
                <button
                  onClick={() => setSelectedSession(null)}
                  className="mono"
                  style={{
                    background: "none",
                    border: "none",
                    color: tokens.textFaint,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  ✕ Close
                </button>
              </div>

              <div
                style={{
                  maxHeight: 280,
                  overflowY: "auto",
                  fontFamily: "monospace",
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: tokens.textSecondary,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {tmuxQ.isLoading ? (
                  <div style={{ color: tokens.textMuted }}>Reading pane output…</div>
                ) : (
                  tmuxQ.data?.lines?.map((line, idx) => (
                    <div key={idx} style={{ minHeight: 16 }}>
                      {line || " "}
                    </div>
                  ))
                )}
                <div ref={terminalEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* SECTION 3: VIRTUAL MACHINES & SPECIALIZED EGRESS NODES */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 26 }}>
          {/* Card: Windows 11 QEMU VM */}
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 10,
              padding: "16px 18px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="ms" style={{ fontSize: 18, color: tokens.accent }}>
                  computer
                </span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: tokens.textHi }}>
                  {windows_vm.name}
                </span>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  borderRadius: 4,
                  padding: "2px 8px",
                  background: windows_vm.status === "running" ? `${tokens.ok}18` : `${tokens.textMuted}18`,
                  color: windows_vm.status === "running" ? tokens.ok : tokens.textMuted,
                  fontWeight: 600,
                }}
              >
                {windows_vm.status.toUpperCase()}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
                  Host PID:
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textHi }}>
                  {windows_vm.pid ?? "Not running"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
                  Allocated Specs:
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textHi }}>
                  {windows_vm.vcpus} vCPUs · {windows_vm.memory_allocated} RAM
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
                  RDP Forwarding:
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: tokens.textHi }}>
                  {windows_vm.rdp_address}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <a
                href={windows_vm.novnc_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  background: tokens.primaryActionBg,
                  color: tokens.accent,
                  border: `1px solid ${tokens.accent}`,
                  borderRadius: 7,
                  padding: "8px 12px",
                  fontSize: 11,
                  fontWeight: 600,
                  textDecoration: "none",
                  cursor: "pointer",
                }}
              >
                <span className="ms" style={{ fontSize: 14 }}>
                  open_in_new
                </span>
                Launch noVNC (:6080)
              </a>
            </div>
          </div>

          {/* Card: VEO Browser Farm */}
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 10,
              padding: "16px 18px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="ms" style={{ fontSize: 18, color: tokens.decide }}>
                  cloud
                </span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: tokens.textHi }}>
                  VEO BROWSER FARM
                </span>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  borderRadius: 4,
                  padding: "2px 8px",
                  background: veo.orch_active ? `${tokens.ok}18` : `${tokens.warn}18`,
                  color: veo.orch_active ? tokens.ok : tokens.warn,
                  fontWeight: 600,
                }}
              >
                {veo.orch_active ? "FLEET ACTIVE" : "IDLE"}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {veo.workers.map((vw) => (
                <div
                  key={vw.id}
                  style={{
                    background: tokens.bgBody,
                    borderRadius: 6,
                    padding: "8px 10px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div>
                    <div className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi }}>
                      {vw.name}
                    </div>
                    <div className="mono" style={{ fontSize: 9.5, color: tokens.textMuted, marginTop: 2 }}>
                      {vw.proxy_type}
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      borderRadius: 4,
                      padding: "2px 6px",
                      background: vw.active ? `${tokens.ok}18` : `${tokens.textMuted}18`,
                      color: vw.active ? tokens.ok : tokens.textMuted,
                      fontWeight: 600,
                    }}
                  >
                    {vw.status.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>

            <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 10 }}>
              Orchestrator: {veo.orch_active ? "Active" : "Stopped"} · Proxy: {veo.proxy_active ? "Active" : "Stopped"}
            </div>
          </div>
        </div>

        {/* SECTION 4: VPS2 MIGRATION TARGET (HONEST STATUS) */}
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 10,
            padding: "16px 18px",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="ms" style={{ fontSize: 16, color: tokens.warn }}>
                storage
              </span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: tokens.textHi }}>
                VPS2 MIGRATION TARGET · {vps2.ip}
              </span>
              <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                ({vps2.hostname})
              </span>
            </div>
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                borderRadius: 4,
                padding: "2px 8px",
                background: `${tokens.warn}18`,
                color: tokens.warn,
                fontWeight: 600,
              }}
            >
              RESTRICTED ACCESS
            </span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 8 }}>
            <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
              Location: <span style={{ color: tokens.textHi }}>{vps2.location}</span>
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
              Hardware: <span style={{ color: tokens.textHi }}>{vps2.specs}</span>
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
              Key Status: <span style={{ color: tokens.bleed }}>{vps2.ssh_status}</span>
            </div>
          </div>

          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.textSecondary,
              background: tokens.bgBody,
              borderRadius: 6,
              padding: "8px 12px",
              borderLeft: `3px solid ${tokens.warn}`,
            }}
          >
            {vps2.access_note}
          </div>
        </div>
      </div>

      {/* Right Sidebar: Invariant Engine & Decision Stream */}
      <div
        style={{
          width: 330,
          flex: "none",
          borderLeft: `1px solid ${tokens.borderSoft}`,
          overflowY: "auto",
          padding: "18px 18px 48px",
          background: tokens.bgBody,
        }}
      >
        {/* Invariant Engine Safety Cockpit */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.bleed }}>
            lock
          </span>
          <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: tokens.textHi, letterSpacing: "0.08em" }}>
            INVARIANT ENGINE
          </span>
          <span
            className="mono"
            style={{
              fontSize: 9,
              borderRadius: 4,
              padding: "1px 5px",
              background: `${tokens.ok}18`,
              color: tokens.ok,
              marginLeft: "auto",
            }}
          >
            {invariant.active_rules_count} RULES ACTIVE
          </span>
        </div>

        <div className="mono" style={{ fontSize: 10, color: tokens.textMuted, marginBottom: 12, lineHeight: 1.4 }}>
          Pre-dispatch boundary enforcement · Model budget limiters & execution sandbox.
        </div>

        {/* Recent Guardrail Trips */}
        <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, letterSpacing: "0.08em", marginBottom: 8 }}>
          RECENT GUARD TRIPS ({invariant.trips_count})
        </div>

        {invariant.recent_trips.length === 0 ? (
          <div
            className="mono"
            style={{
              background: tokens.bgCard,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 8,
              padding: "12px 14px",
              fontSize: 10.5,
              color: tokens.textFaint,
              textAlign: "center",
              marginBottom: 20,
            }}
          >
            No guardrail violations recorded.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
            {invariant.recent_trips.map((trip) => (
              <div
                key={trip.id}
                style={{
                  background: tokens.bgCard,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 7,
                  padding: "8px 10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: tokens.bleed }}>
                    {trip.rule_label}
                  </span>
                  <span className="mono" style={{ fontSize: 9, color: tokens.textFaint }}>
                    {trip.ts ? trip.ts.substring(11, 16) : ""}
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 9.5, color: tokens.textSecondary }}>
                  Agent: {trip.agent} · Action: {trip.attempted_action}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Live Decision Log */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "22px 0 8px" }}>
          <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: tokens.textHi, letterSpacing: "0.08em" }}>
            DECISION LOG
          </span>
          <span style={dot(tokens.ok, true)} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {decisionLog.length === 0 ? (
            <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint }}>
              No decisions recorded yet.
            </div>
          ) : (
            decisionLog.map((d, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  fontSize: 10.5,
                  padding: "5px 0",
                  borderBottom: `1px solid ${tokens.borderSoft}`,
                }}
              >
                <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, width: 36, flex: "none" }}>
                  {d.ts}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: tokens.accent,
                    borderRadius: 3,
                    padding: "1px 4px",
                    background: `${tokens.accent}14`,
                    flex: "none",
                  }}
                >
                  {d.kind}
                </span>
                <span style={{ color: tokens.textSecondary, flex: 1, minWidth: 0 }}>
                  {d.action}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
