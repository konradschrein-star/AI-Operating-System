"use client";

/**
 * TopologyAtlasGrid.tsx — the System Atlas: four dense telemetry columns.
 *
 * Column 1  Processes & Services   — pm2 jlist / systemctl list-units
 * Column 2  Ingress & Domains      — /etc/nginx/sites-enabled
 * Column 3  Storage & Databases    — df, /proc/meminfo, ss -ltnpH
 * Column 4  Providers              — /api/usage/quota
 *
 * SECTIONAL ERROR ISOLATION, honestly. `/api/map` answers 200 with a per-section
 * `{ ok:false, error }` when a producer dies, and each column renders ITS error
 * with a retry. Round 3 had this backwards: a failed fetch silently swapped in a
 * 16-row `DEFAULT_DOMAINS` constant and a `KNOWN_DATASTORES` list that always
 * read "Listening", with an error banner wired to state nothing ever set. There
 * are no fallback constants in this file any more — if it is not measured it is
 * not drawn, and the reason it is not drawn is on screen.
 */

import { useCallback, useEffect, useState } from "react";
import {
  formatBytes,
  formatCheckedAt,
  formatUptime,
  isNamedVhost,
  sectionData,
  sectionError,
  type MapPayload,
} from "./mapApi";

/* ── Column 4's producer: /api/usage/quota ───────────────────────────────── */

interface QuotaWindow {
  utilization: number;
  resets_at: string | null;
}

interface GeminiUsage {
  cli_installed: boolean;
  probe_state: string;
  probe_checked_at: string | null;
  session_probed_ok: boolean;
  five_hour: { calls: number; tokens: number | null } | null;
  seven_day: { calls: number; tokens: number | null } | null;
  no_limit_note: string | null;
}

interface QuotaPayload {
  five_hour: QuotaWindow | null;
  seven_day: QuotaWindow | null;
  seven_day_opus: QuotaWindow | null;
  fetched_at: string | null;
  gemini: GeminiUsage | null;
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return "not reported";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/* ── The grid ────────────────────────────────────────────────────────────── */

interface TopologyAtlasGridProps {
  payload: MapPayload | null;
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
}

export function TopologyAtlasGrid({
  payload,
  loading,
  loadError,
  onReload,
}: TopologyAtlasGridProps) {
  const [filterQuery, setFilterQuery] = useState("");
  const [showSystemd, setShowSystemd] = useState(false);

  const [quota, setQuota] = useState<QuotaPayload | null>(null);
  const [quotaErr, setQuotaErr] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    setQuotaErr(null);
    try {
      const res = await fetch("/api/proxy/usage/quota");
      if (!res.ok) throw new Error(`/api/usage/quota → HTTP ${res.status}`);
      const json: unknown = await res.json();
      if (typeof json !== "object" || json === null) {
        throw new Error("/api/usage/quota returned a non-object body");
      }
      setQuota(json as QuotaPayload);
    } catch (err) {
      setQuotaErr(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void fetchProviders();
  }, [fetchProviders]);

  const q = filterQuery.toLowerCase().trim();

  const processes = sectionData(payload?.sections.processes);
  const units = sectionData(payload?.sections.units);
  const domains = sectionData(payload?.sections.domains);
  const storage = sectionData(payload?.sections.storage);

  const processesErr = payload ? sectionError(payload.sections.processes, "processes") : null;
  const unitsErr = payload ? sectionError(payload.sections.units, "units") : null;
  const domainsErr = payload ? sectionError(payload.sections.domains, "domains") : null;
  const storageErr = payload ? sectionError(payload.sections.storage, "storage") : null;

  const filteredProcesses = (processes?.processes ?? []).filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.cwd !== null && p.cwd.toLowerCase().includes(q)),
  );

  const filteredUnits = (units?.units ?? []).filter(
    (u) => !q || u.name.toLowerCase().includes(q) || u.description.toLowerCase().includes(q),
  );

  const filteredDomains = (domains?.domains ?? []).filter(
    (d) =>
      !q ||
      d.domain.toLowerCase().includes(q) ||
      d.upstreams.some((u) => u.toLowerCase().includes(q)) ||
      d.ports.some((p) => String(p).includes(q)),
  );

  /** One place decides what a column shows when it has nothing to show. */
  const columnBody = (
    error: string | null,
    empty: string,
    rows: React.ReactNode[],
  ): React.ReactNode => {
    if (error) {
      return (
        <div className="atlas-column-error">
          <span>⚠️ {error}</span>
          <button type="button" onClick={onReload}>
            Retry
          </button>
        </div>
      );
    }
    if (payload === null) {
      return (
        <div className="atlas-column-empty">
          {loading ? "Reading /api/map…" : "No reading yet."}
        </div>
      );
    }
    if (rows.length === 0) return <div className="atlas-column-empty">{empty}</div>;
    return rows;
  };

  return (
    <div className="atlas-container">
      {/* Search & Filter Toolbar */}
      <div className="atlas-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="mindmap-search">
            <span className="mindmap-search-icon">🔍</span>
            <input
              type="text"
              placeholder="Filter processes, domains, ports..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
            {filterQuery && (
              <button
                type="button"
                className="mindmap-search-clear"
                onClick={() => setFilterQuery("")}
              >
                ✕
              </button>
            )}
          </div>
          <span className="mindmap-hint">
            {loadError
              ? `⚠️ ${loadError}`
              : payload
                ? `Four isolated columns · /api/map read ${formatCheckedAt(payload.generated_at)}`
                : "Four isolated columns"}
          </span>
        </div>

        <button
          type="button"
          className="mindmap-btn"
          disabled={loading}
          onClick={() => {
            onReload();
            void fetchProviders();
          }}
          title="Re-read every producer"
        >
          <span>↻</span> {loading ? "Refreshing…" : "Refresh telemetry"}
        </button>
      </div>

      {/* 4-Column Grid */}
      <div className="atlas-grid">
        {/* ── Column 1: Processes & Services ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>⚡</span> Processes &amp; Services
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="mindmap-btn mindmap-btn-tiny"
                onClick={() => setShowSystemd(!showSystemd)}
              >
                {showSystemd ? "Show PM2" : "Show systemd"}
              </button>
              <span className="atlas-column-badge">
                {showSystemd
                  ? units
                    ? `${units.count} units`
                    : "—"
                  : processes
                    ? `${processes.online}/${processes.count} online`
                    : "—"}
              </span>
            </div>
          </div>

          <div className="atlas-column-content">
            {showSystemd
              ? columnBody(
                  unitsErr,
                  q ? "No matching systemd unit." : "No running units reported.",
                  filteredUnits.map((u) => (
                    <div key={u.name} className="atlas-card">
                      <div className="atlas-card-header">
                        <div className="atlas-card-title">
                          <span
                            className={`map-dot ${u.active === "active" ? "green" : "gray"}`}
                          />
                          {u.name}
                        </div>
                        <span className="atlas-card-state">{u.active}</span>
                      </div>
                      {u.description && (
                        <div className="atlas-card-note">{u.description}</div>
                      )}
                    </div>
                  )),
                )
              : columnBody(
                  processesErr,
                  q ? "No matching pm2 process." : "pm2 reported no processes.",
                  filteredProcesses.map((p) => {
                    const isOnline = p.status === "online";
                    return (
                      <div key={p.name} className="atlas-card">
                        <div className="atlas-card-header">
                          <div className="atlas-card-title">
                            <span className={`map-dot ${isOnline ? "green" : "red"}`} />
                            {p.name}
                          </div>
                          <span
                            className={`atlas-card-state ${isOnline ? "ok" : "bad"}`}
                          >
                            {p.status}
                          </span>
                        </div>
                        <div className="atlas-card-meta">
                          {p.pid !== null && <span>PID: {p.pid}</span>}
                          <span>CPU: {p.cpu_pct}%</span>
                          <span>RAM: {formatBytes(p.memory_bytes)}</span>
                          <span>Restarts: {p.restarts}</span>
                        </div>
                        <div className="atlas-card-note">
                          {isOnline ? `Uptime: ${formatUptime(p.uptime_ms)}` : "Not running"}
                          {p.cwd !== null && ` · ${p.cwd}`}
                        </div>
                      </div>
                    );
                  }),
                )}
          </div>
        </div>

        {/* ── Column 2: Domains & Ingress ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>🌐</span> Ingress &amp; Domains
            </div>
            <span className="atlas-column-badge">
              {/* "entries", not "names": unlike the header chip and the Mind
                  Map's ingress node, this raw configuration view keeps the
                  catch-all servers, so it is counting a different set. */}
              {domains ? `${filteredDomains.length}/${domains.count} vhost entries` : "—"}
            </span>
          </div>

          <div className="atlas-column-content">
            {columnBody(
              domainsErr,
              q ? "No matching vhost." : "nginx declared no server names.",
              filteredDomains.map((d, idx) => (
                <div key={`${d.domain}-${d.file}-${idx}`} className="atlas-card">
                  <div className="atlas-card-header">
                    {d.ssl ? (
                      <a
                        href={`https://${d.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="atlas-card-title atlas-card-link"
                      >
                        <span>↗</span> {d.domain}
                      </a>
                    ) : (
                      <span className="atlas-card-title">
                        {isNamedVhost(d) ? d.domain : `${d.domain} · catch-all, answers for no name`}
                      </span>
                    )}
                    <span className={`atlas-badge ${d.ssl ? "ok" : "warn"}`}>
                      {d.ssl
                        ? d.ssl_days_left === null
                          ? "TLS"
                          : `TLS ${d.ssl_days_left}d`
                        : "HTTP"}
                    </span>
                  </div>
                  <div className="atlas-card-meta">
                    <span>Ports: {d.ports.length > 0 ? d.ports.join(", ") : "—"}</span>
                    <span>
                      Upstream: {d.upstreams.length > 0 ? d.upstreams.join(", ") : "static"}
                    </span>
                  </div>
                  <div className="atlas-card-note">
                    {d.file}
                    {d.ssl_error !== null && ` · certificate: ${d.ssl_error}`}
                  </div>
                </div>
              )),
            )}
            {domains && domains.errors.length > 0 && (
              <div className="atlas-column-error">
                <span>
                  ⚠️ {domains.errors.length} vhost file(s) failed to parse:{" "}
                  {domains.errors.map((e) => `${e.file} (${e.error})`).join("; ")}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Column 3: Storage & Databases ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>💾</span> Storage &amp; Databases
            </div>
            <span className="atlas-column-badge">
              {storage
                ? `${storage.datastores.filter((d) => d.listening).length}/${storage.datastores.length} listening`
                : "—"}
            </span>
          </div>

          <div className="atlas-column-content">
            {columnBody(storageErr, "No storage telemetry returned.", [
              ...(storage?.disks ?? []).map((disk) => (
                <div key={`disk-${disk.mount}`} className="atlas-card">
                  <div className="atlas-card-header">
                    <span className="atlas-card-title">Disk {disk.mount}</span>
                    <span className="atlas-card-state">{disk.used_pct}%</span>
                  </div>
                  <div className="atlas-progress-bar">
                    <div
                      className={`atlas-progress-fill ${disk.used_pct > 90 ? "red" : disk.used_pct > 80 ? "yellow" : "green"}`}
                      style={{ width: `${Math.min(100, disk.used_pct)}%` }}
                    />
                  </div>
                  <div className="atlas-card-meta">
                    <span>
                      {formatBytes(disk.used_bytes)} / {formatBytes(disk.total_bytes)}
                    </span>
                    <span>{formatBytes(disk.available_bytes)} free</span>
                  </div>
                </div>
              )),
              ...(storage
                ? [
                    <div key="ram" className="atlas-card">
                      <div className="atlas-card-header">
                        <span className="atlas-card-title">
                          Physical RAM ({formatBytes(storage.memory.total_bytes)})
                        </span>
                        <span className="atlas-card-state">
                          {storage.memory.used_pct}%
                        </span>
                      </div>
                      <div className="atlas-progress-bar">
                        <div
                          className={`atlas-progress-fill ${storage.memory.used_pct > 90 ? "red" : "green"}`}
                          style={{ width: `${Math.min(100, storage.memory.used_pct)}%` }}
                        />
                      </div>
                      <div className="atlas-card-meta">
                        <span>{formatBytes(storage.memory.used_bytes)} used</span>
                        <span>{formatBytes(storage.memory.available_bytes)} available</span>
                      </div>
                    </div>,
                    <div key="ds-heading" className="atlas-subheading">
                      DOCUMENTED DATA PORTS — listening state measured with ss -ltnpH
                    </div>,
                    ...storage.datastores.map((ds) => (
                      <div key={`ds-${ds.port}`} className="atlas-card">
                        <div className="atlas-card-header">
                          <div className="atlas-card-title">
                            <span className={`map-dot ${ds.listening ? "green" : "red"}`} />
                            {ds.name}
                          </div>
                          <span
                            className={`atlas-card-state ${ds.listening ? "ok" : "bad"}`}
                          >
                            {ds.listening ? "listening" : "not listening"}
                          </span>
                        </div>
                        <div className="atlas-card-meta">
                          <span>Port: :{ds.port}</span>
                          <span>Process: {ds.process ?? "unknown"}</span>
                        </div>
                      </div>
                    )),
                    <div key="listeners" className="atlas-card">
                      <div className="atlas-card-header">
                        <span className="atlas-card-title">All TCP listeners</span>
                        <span className="atlas-card-state">
                          {storage.listeners.length}
                        </span>
                      </div>
                      <div className="atlas-card-note">
                        Every port answering on this host, as reported by ss -ltnpH.
                      </div>
                    </div>,
                  ]
                : []),
            ])}
          </div>
        </div>

        {/* ── Column 4: Providers & Integrations ── */}
        <div className="atlas-column">
          <div className="atlas-column-header">
            <div className="atlas-column-title">
              <span>🔌</span> Model Providers
            </div>
            <span className="atlas-column-badge">
              {quotaErr ? "—" : quota ? "measured" : "…"}
            </span>
          </div>

          <div className="atlas-column-content">
            {quotaErr ? (
              <div className="atlas-column-error">
                <span>⚠️ {quotaErr}</span>
                <button type="button" onClick={() => void fetchProviders()}>
                  Retry
                </button>
              </div>
            ) : quota === null ? (
              <div className="atlas-column-empty">Reading /api/usage/quota…</div>
            ) : (
              <>
                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <div className="atlas-card-title">
                      <span className="map-dot green" />
                      Anthropic Claude
                    </div>
                    <span className="atlas-card-state ok">OAuth</span>
                  </div>
                  {quota.five_hour ? (
                    <>
                      <div className="atlas-card-note">
                        5-hour window: {quota.five_hour.utilization}% used
                      </div>
                      <div className="atlas-progress-bar">
                        <div
                          className={`atlas-progress-fill ${quota.five_hour.utilization > 80 ? "red" : "green"}`}
                          style={{ width: `${Math.min(100, quota.five_hour.utilization)}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="atlas-card-note">
                      No 5-hour window reported by /api/usage/quota.
                    </div>
                  )}
                  {quota.seven_day && (
                    <div className="atlas-card-meta">
                      <span>7-day cap: {quota.seven_day.utilization}%</span>
                      {quota.seven_day_opus && (
                        <span>7-day Opus: {quota.seven_day_opus.utilization}%</span>
                      )}
                    </div>
                  )}
                </div>

                {quota.gemini && (
                  <div className="atlas-card">
                    <div className="atlas-card-header">
                      <div className="atlas-card-title">
                        <span
                          className={`map-dot ${quota.gemini.probe_state === "connected" ? "green" : "red"}`}
                        />
                        Google Gemini (agy CLI)
                      </div>
                      <span
                        className={`atlas-card-state ${quota.gemini.probe_state === "connected" ? "ok" : "bad"}`}
                      >
                        {quota.gemini.probe_state}
                      </span>
                    </div>
                    <div className="atlas-card-note">
                      CLI installed: {quota.gemini.cli_installed ? "yes" : "no"} · last
                      probe{" "}
                      {quota.gemini.probe_checked_at
                        ? formatCheckedAt(quota.gemini.probe_checked_at)
                        : "never"}
                    </div>
                    {quota.gemini.seven_day && (
                      <div className="atlas-card-meta">
                        <span>7d calls: {quota.gemini.seven_day.calls}</span>
                        <span>
                          7d tokens: {formatTokens(quota.gemini.seven_day.tokens)}
                        </span>
                      </div>
                    )}
                    {quota.gemini.no_limit_note && (
                      <div className="atlas-card-note">{quota.gemini.no_limit_note}</div>
                    )}
                  </div>
                )}

                <div className="atlas-card">
                  <div className="atlas-card-header">
                    <span className="atlas-card-title">Scope of this column</span>
                  </div>
                  <div className="atlas-card-note">
                    Only providers /api/usage/quota actually measures appear here. Other
                    integrations (ElevenLabs, GitHub, Obsidian LiveSync) have no usage
                    endpoint wired into forge-control yet, so they are absent rather than
                    shown with an assumed green light.
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
