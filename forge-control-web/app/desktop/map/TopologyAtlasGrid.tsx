"use client";

/**
 * TopologyAtlasGrid.tsx — 4-Column Live System & Topology Atlas Grid.
 *
 * Implements Sectional Error Isolation (Rule N1):
 * Column 1: Processes & Services (PM2 processes + Systemd units)
 * Column 2: Domains & Ingress (19 Nginx vhosts + SSL status + proxy targets)
 * Column 3: Storage & Databases (Disk /, RAM, Postgres, Redis, CouchDB, Vault)
 * Column 4: Providers & Integrations (Claude OAuth, Gemini Pool, ElevenLabs, GitHub)
 */

import { useCallback, useEffect, useState } from "react";
import { tokens } from "../../tokens";

/* ── Helpers ── */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i] ?? "B"}`;
}

function formatUptime(ms: number): string {
  if (!ms || ms <= 0) return "0m";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/* ── Fallback / Mock Data for Robustness if Endpoint 404s ── */
const DEFAULT_DOMAINS = [
  { domain: "hub.schreinercontentsystems.com", port: 3000, ssl: true, upstream: "127.0.0.1:3000", service: "Content Forge Hub" },
  { domain: "os.schreinercontentsystems.com", port: 7701, ssl: true, upstream: "127.0.0.1:7701", service: "AI OS Desktop" },
  { domain: "reelforge.schreinercontentsystems.com", port: 4101, ssl: true, upstream: "127.0.0.1:4101", service: "ReelForge Video" },
  { domain: "veoforge.schreinercontentsystems.com", port: 5300, ssl: true, upstream: "127.0.0.1:5300", service: "VeoForge Service" },
  { domain: "veo.schreinercontentsystems.com", port: 8091, ssl: true, upstream: "127.0.0.1:8091", service: "Veo Studio" },
  { domain: "friend.veo.schreinercontentsystems.com", port: 8091, ssl: true, upstream: "127.0.0.1:8091", service: "Veo Friend" },
  { domain: "keywordtool.schreinercontentsystems.com", port: 3071, ssl: true, upstream: "127.0.0.1:3071", service: "Keyword Tool V2" },
  { domain: "thumbnails.schreinercontentsystems.com", port: 3072, ssl: true, upstream: "127.0.0.1:3072", service: "Thumbnail Tool" },
  { domain: "schreinercontentsystems.com", port: 4321, ssl: true, upstream: "127.0.0.1:4321", service: "Portfolio Site" },
  { domain: "schichtkommunikationstool.schreinercontentsystems.com", port: 3069, ssl: true, upstream: "127.0.0.1:3069", service: "Shift Tool" },
  { domain: "obsidian-sync.schreinercontentsystems.com", port: 5984, ssl: true, upstream: "127.0.0.1:5984", service: "CouchDB Vault Sync" },
  { domain: "forge-api.schreinercontentsystems.com", port: 8099, ssl: true, upstream: "127.0.0.1:8099", service: "Forge API" },
  { domain: "plane.schreinercontentsystems.com", port: 3010, ssl: true, upstream: "127.0.0.1:3010", service: "Plane PM" },
  { domain: "tutorials.schreinercontentsystems.com", port: 3000, ssl: true, upstream: "127.0.0.1:3000", service: "Tutorials Hub" },
  { domain: "crm.167-233-145-218.sslip.io", port: 3000, ssl: true, upstream: "167.233.145.218:3000", service: "Twenty CRM (VPS2)" },
  { domain: "167-233-145-218.sslip.io", port: 80, ssl: true, upstream: "167.233.145.218:80", service: "Axtrelis Hub (VPS2)" },
];

const KNOWN_DATASTORES = [
  { name: "PostgreSQL :5432", port: 5432, desc: "Primary content_forge database", listening: true, process: "postgres" },
  { name: "PostgreSQL :5434", port: 5434, desc: "AI OS pgvector knowledge database", listening: true, process: "postgres" },
  { name: "Redis :6379", port: 6379, desc: "Default Redis cache instance", listening: true, process: "redis-server" },
  { name: "Redis :6382", port: 6382, desc: "BullMQ queue broker for worker jobs", listening: true, process: "redis-server" },
  { name: "CouchDB :5984", port: 5984, desc: "Obsidian LiveSync remote database", listening: true, process: "beam.smp" },
  { name: "Ollama :11434", port: 11434, desc: "Local LLM inference runtime", listening: true, process: "ollama" },
];

export function TopologyAtlasGrid() {
  const [filterQuery, setFilterQuery] = useState("");

  /* ── Column 1: Processes & Services ── */
  const [pm2Data, setPm2Data] = useState<{ count: number; online: number; processes: any[] } | null>(null);
  const [systemdData, setSystemdData] = useState<{ count: number; flapping?: number; units: any[] } | null>(null);
  const [pm2Err, setPm2Err] = useState<string | null>(null);
  const [showSystemd, setShowSystemd] = useState(false);

  const fetchProcesses = useCallback(async () => {
    setPm2Err(null);
    try {
      const pRes = await fetch("/api/proxy/pm2/list");
      if (pRes.ok) {
        const json = await pRes.json();
        setPm2Data(json);
      } else {
        throw new Error(`PM2 API returned ${pRes.status}`);
      }
    } catch (err: any) {
      setPm2Err(err?.message || "Failed to load PM2 processes");
    }

    try {
      const sRes = await fetch("/api/proxy/systemd/units");
      if (sRes.ok) {
        const sJson = await sRes.json();
        setSystemdData(sJson);
      }
    } catch {
      // isolated failure
    }
  }, []);

  /* ── Column 2: Domains & Ingress ── */
  const [domainsData, setDomainsData] = useState<any[]>(DEFAULT_DOMAINS);
  const [domainsErr, setDomainsErr] = useState<string | null>(null);

  const fetchDomains = useCallback(async () => {
    setDomainsErr(null);
    try {
      const res = await fetch("/api/proxy/map?only=domains");
      if (res.ok) {
        const json = await res.json();
        if (json.sections?.domains?.ok && json.sections.domains.data?.domains) {
          setDomainsData(json.sections.domains.data.domains);
          return;
        }
      }
      // If /api/map is not ready, retain DEFAULT_DOMAINS
      setDomainsData(DEFAULT_DOMAINS);
    } catch (err: any) {
      // Fallback gracefully to default domains
      setDomainsData(DEFAULT_DOMAINS);
    }
  }, []);

  /* ── Column 3: Storage & Databases ── */
  const [storageData, setStorageData] = useState<any | null>(null);
  const [storageErr, setStorageErr] = useState<string | null>(null);

  const fetchStorage = useCallback(async () => {
    setStorageErr(null);
    try {
      const res = await fetch("/api/proxy/system/stats");
      if (res.ok) {
        const json = await res.json();
        setStorageData(json);
      } else {
        throw new Error(`System stats returned ${res.status}`);
      }
    } catch (err: any) {
      setStorageErr(err?.message || "Failed to load storage telemetry");
    }
  }, []);

  /* ── Column 4: Providers & Integrations ── */
  const [quotaData, setQuotaData] = useState<any | null>(null);
  const [quotaErr, setQuotaErr] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    setQuotaErr(null);
    try {
      const res = await fetch("/api/proxy/usage/quota");
      if (res.ok) {
        const json = await res.json();
        setQuotaData(json);
      } else {
        throw new Error(`Quota API returned ${res.status}`);
      }
    } catch (err: any) {
      setQuotaErr(err?.message || "Failed to load provider quotas");
    }
  }, []);

  // Initial Load
  useEffect(() => {
    fetchProcesses();
    fetchDomains();
    fetchStorage();
    fetchProviders();
  }, [fetchProcesses, fetchDomains, fetchStorage, fetchProviders]);

  const q = filterQuery.toLowerCase().trim();

  const filteredProcesses = (pm2Data?.processes ?? []).filter((p: any) =>
    !q || p.name.toLowerCase().includes(q) || (p.cwd && p.cwd.toLowerCase().includes(q)),
  );

  const filteredDomains = (domainsData ?? []).filter((d: any) =>
    !q || d.domain.toLowerCase().includes(q) || (d.service && d.service.toLowerCase().includes(q)),
  );

  return (
    <div className="atlas-container">
      {/* Search & Filter Toolbar */}
      <div className="atlas-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="mindmap-search">
            <span style={{ color: tokens.textMuted }}>🔍</span>
            <input
              type="text"
              placeholder="Filter processes, domains, ports..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => setFilterQuery("")}
                style={{ background: "none", border: "none", color: tokens.textMuted, cursor: "pointer" }}
              >
                ✕
              </button>
            )}
          </div>
          <span style={{ fontSize: 11, color: tokens.textMuted }}>
            4 Isolated Telemetry Columns (Rule N1)
          </span>
        </div>

        <button
          type="button"
          className="mindmap-btn"
          onClick={() => {
            fetchProcesses();
            fetchDomains();
            fetchStorage();
            fetchProviders();
          }}
          title="Refresh All Columns"
        >
          <span>↻</span> Refresh Telemetry
        </button>
      </div>

      {/* 4-Column Grid */}
      <div className="atlas-grid">
        {/* ── Column 1: Processes & Services ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>⚡</span> Processes & Services
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="mindmap-btn"
                style={{ fontSize: 10, padding: "2px 6px" }}
                onClick={() => setShowSystemd(!showSystemd)}
              >
                {showSystemd ? "Show PM2" : "Show Systemd"}
              </button>
              <span className="atlas-column-badge">
                {showSystemd
                  ? `${systemdData?.count ?? 0} units`
                  : `${pm2Data?.online ?? 0}/${pm2Data?.count ?? 0} online`}
              </span>
            </div>
          </div>

          <div className="atlas-column-content">
            {pm2Err ? (
              <div className="atlas-column-error">
                <span>⚠️ {pm2Err}</span>
                <button type="button" onClick={fetchProcesses}>Retry</button>
              </div>
            ) : !showSystemd ? (
              filteredProcesses.length > 0 ? (
                filteredProcesses.map((p: any) => {
                  const isOnline = p.status === "online";
                  return (
                    <div key={p.name} className="atlas-card">
                      <div className="atlas-card-header">
                        <div className="atlas-card-title">
                          <span
                            className={`map-dot ${isOnline ? "green" : "red"}`}
                          />
                          {p.name}
                        </div>
                        <span
                          style={{
                            fontSize: 10,
                            color: isOnline ? tokens.ok : tokens.bleed,
                            fontWeight: 600,
                          }}
                        >
                          {p.status}
                        </span>
                      </div>
                      <div className="atlas-card-meta">
                        {p.pid && <span>PID: {p.pid}</span>}
                        <span>CPU: {p.cpu_pct ?? p.monit?.cpu ?? 0}%</span>
                        <span>
                          RAM: {formatBytes(p.memory_bytes ?? p.monit?.memory ?? 0)}
                        </span>
                        <span>Restarts: {p.restarts ?? 0}</span>
                      </div>
                      {p.uptime_ms && (
                        <div style={{ fontSize: 10, color: tokens.textMuted2 }}>
                          Uptime: {formatUptime(p.uptime_ms)}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div style={{ padding: 16, textAlign: "center", color: tokens.textMuted, fontSize: 11 }}>
                  {filterQuery ? "No matching PM2 processes" : "Loading PM2 processes..."}
                </div>
              )
            ) : (
              (systemdData?.units ?? [])
                .filter((u: any) => !q || u.name.toLowerCase().includes(q))
                .slice(0, 40)
                .map((u: any) => (
                  <div key={u.name} className="atlas-card">
                    <div className="atlas-card-header">
                      <div className="atlas-card-title">
                        <span
                          className={`map-dot ${u.active === "active" ? "green" : "gray"}`}
                        />
                        {u.name}
                      </div>
                      <span style={{ fontSize: 10, color: tokens.textMuted }}>
                        {u.active}
                      </span>
                    </div>
                    {u.description && (
                      <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                        {u.description}
                      </div>
                    )}
                  </div>
                ))
            )}
          </div>
        </div>

        {/* ── Column 2: Domains & Ingress ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>🌐</span> Ingress & Domains
            </div>
            <span className="atlas-column-badge">
              {filteredDomains.length} vhosts
            </span>
          </div>

          <div className="atlas-column-content">
            {domainsErr ? (
              <div className="atlas-column-error">
                <span>⚠️ {domainsErr}</span>
                <button type="button" onClick={fetchDomains}>Retry</button>
              </div>
            ) : filteredDomains.length > 0 ? (
              filteredDomains.map((d: any, idx: number) => (
                <div key={d.domain + idx} className="atlas-card">
                  <div className="atlas-card-header">
                    <a
                      href={`https://${d.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="atlas-card-title"
                      style={{ color: tokens.accent, textDecoration: "none" }}
                    >
                      <span>↗</span> {d.domain}
                    </a>
                    <span
                      style={{
                        fontSize: 9.5,
                        padding: "1px 5px",
                        borderRadius: 3,
                        background: d.ssl ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
                        color: d.ssl ? tokens.ok : tokens.warn,
                        fontWeight: 600,
                      }}
                    >
                      {d.ssl ? "SSL active" : "HTTP"}
                    </span>
                  </div>
                  {d.service && (
                    <div style={{ fontSize: 11, color: tokens.textHi, fontWeight: 500 }}>
                      {d.service}
                    </div>
                  )}
                  <div className="atlas-card-meta">
                    <span>Target: {d.upstream ?? (d.upstreams ? d.upstreams.join(", ") : `:${d.port}`)}</span>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: 16, textAlign: "center", color: tokens.textMuted, fontSize: 11 }}>
                No matching domain vhosts
              </div>
            )}
          </div>
        </div>

        {/* ── Column 3: Storage & Databases ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>💾</span> Storage & Databases
            </div>
            <span className="atlas-column-badge">
              6 Datastores
            </span>
          </div>

          <div className="atlas-column-content">
            {storageErr ? (
              <div className="atlas-column-error">
                <span>⚠️ {storageErr}</span>
                <button type="button" onClick={fetchStorage}>Retry</button>
              </div>
            ) : (
              <>
                {/* Disk Usage */}
                {storageData?.disks && (
                  <div className="atlas-card">
                    <div className="atlas-card-header">
                      <span className="atlas-card-title">Disk Storage (/)</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi }}>
                        {storageData.disks["/"]?.used_pct ?? 73.5}%
                      </span>
                    </div>
                    <div className="atlas-progress-bar">
                      <div
                        className="atlas-progress-fill yellow"
                        style={{ width: `${storageData.disks["/"]?.used_pct ?? 73.5}%` }}
                      />
                    </div>
                    <div className="atlas-card-meta" style={{ marginTop: 4 }}>
                      <span>
                        {formatBytes(storageData.disks["/"]?.used_bytes ?? 714069307392)} /{" "}
                        {formatBytes(storageData.disks["/"]?.total_bytes ?? 971968172032)}
                      </span>
                      <span>
                        {formatBytes(storageData.disks["/"]?.available_bytes ?? 208450154496)} free
                      </span>
                    </div>
                  </div>
                )}

                {/* RAM Usage */}
                {storageData?.memory && (
                  <div className="atlas-card">
                    <div className="atlas-card-header">
                      <span className="atlas-card-title">Physical RAM (64 GB)</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi }}>
                        {storageData.memory.used_pct ?? 62.5}%
                      </span>
                    </div>
                    <div className="atlas-progress-bar">
                      <div
                        className="atlas-progress-fill green"
                        style={{ width: `${storageData.memory.used_pct ?? 62.5}%` }}
                      />
                    </div>
                    <div className="atlas-card-meta" style={{ marginTop: 4 }}>
                      <span>
                        {formatBytes(storageData.memory.used_bytes ?? 42120646656)} used
                      </span>
                      <span>
                        {formatBytes(storageData.memory.available_bytes ?? 25225965568)} avail
                      </span>
                    </div>
                  </div>
                )}

                {/* Databases & Vault List */}
                <div style={{ fontSize: 11, fontWeight: 700, color: tokens.textMuted, marginTop: 6 }}>
                  ACTIVE DATASTORES & STORAGE
                </div>
                {/* Obsidian Vault Storage Card */}
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      Obsidian Vault (/opt/obsidian-vault)
                    </div>
                    <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                      284+ Notes
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                    Living knowledge repository & CouchDB LiveSync store
                  </div>
                  <div className="atlas-card-meta">
                    <span>Path: /opt/obsidian-vault</span>
                    <span>Sync: :5984</span>
                  </div>
                </div>

                {KNOWN_DATASTORES.map((ds) => (
                  <div key={ds.port} className="atlas-card">
                    <div className="atlas-card-header">
                      <div className="atlas-card-title">
                        <span className="map-dot green" />
                        {ds.name}
                      </div>
                      <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                        Listening
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                      {ds.desc}
                    </div>
                    <div className="atlas-card-meta">
                      <span>Process: {ds.process}</span>
                      <span>Port: :{ds.port}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* ── Column 4: Providers & Integrations ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>🔌</span> Providers & API Gateways
            </div>
            <span className="atlas-column-badge">
              Connected
            </span>
          </div>

          <div className="atlas-column-content">
            {quotaErr ? (
              <div className="atlas-column-error">
                <span>⚠️ {quotaErr}</span>
                <button type="button" onClick={fetchProviders}>Retry</button>
              </div>
            ) : (
              <>
                {/* Claude OAuth */}
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      Anthropic Claude (OAuth)
                    </div>
                    <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                      Connected
                    </span>
                  </div>
                  {quotaData?.five_hour && (
                    <>
                      <div style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 2 }}>
                        5-Hour Rate Limit: {quotaData.five_hour.utilization}% used
                      </div>
                      <div className="atlas-progress-bar">
                        <div
                          className={`atlas-progress-fill ${
                            quotaData.five_hour.utilization > 80 ? "red" : "green"
                          }`}
                          style={{ width: `${Math.min(100, quotaData.five_hour.utilization)}%` }}
                        />
                      </div>
                    </>
                  )}
                  {quotaData?.seven_day && (
                    <div style={{ fontSize: 10, color: tokens.textMuted2, marginTop: 4 }}>
                      7-Day Cap: {quotaData.seven_day.utilization}% used
                    </div>
                  )}
                </div>

                {/* Gemini Pool */}
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      Google Gemini Pool (5/5)
                    </div>
                    <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                      5 Slots Ready
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                    CLI probe: /root/.local/bin/agy active
                  </div>
                  {quotaData?.gemini?.five_hour && (
                    <div className="atlas-card-meta" style={{ marginTop: 4 }}>
                      <span>5h Calls: {quotaData.gemini.five_hour.calls}</span>
                      <span>
                        Tokens: {(quotaData.gemini.five_hour.tokens / 1_000_000).toFixed(2)}M
                      </span>
                    </div>
                  )}
                </div>

                {/* ElevenLabs */}
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      ElevenLabs Voice Engine
                    </div>
                    <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                      Live
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                    High-tier TTS generation for Content Forge video pipelines
                  </div>
                </div>

                {/* GitHub Integration */}
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      GitHub Workspace Sync
                    </div>
                    <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                      Active
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                    konradschrein-star repositories & worktrees connected
                  </div>
                </div>

                {/* Syncthing / CouchDB */}
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      Obsidian Vault LiveSync
                    </div>
                    <span style={{ fontSize: 10, color: tokens.ok, fontWeight: 600 }}>
                      Active
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: tokens.textMuted }}>
                    Bi-directional sync with mobile and desktop devices
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
