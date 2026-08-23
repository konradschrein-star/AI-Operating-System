"use client";

/**
 * MapSurface.tsx — the Map, Architecture & Topology cockpit of Konrad's AI OS.
 *
 * Three modes over ONE live read:
 * 1. 🗺️ Mind Map      — the vault's project table, pm2, nginx, systemd and the
 *                       metal, as a navigable tree (see map/mapTree.ts).
 * 2. ✏️ Planning Canvas — the Excalidraw canvas from the vault.
 * 3. 📊 System Atlas   — the same measurements as four dense telemetry columns.
 *
 * THIS FILE OWNS THE FETCH. `/api/map` spawns `pm2 jlist`, `ss`, `df` and a
 * vault walk per request, so the surface reads it once and hands the payload to
 * whichever mode is mounted. It also means the header strip and the body can
 * never disagree about what is running.
 *
 * The telemetry strip carries no constants. Round 3 shipped `5 Businesses` and
 * `19 Domains` as hardcoded numbers under a green dot; every chip below is now
 * either a measured figure or a visibly amber "unavailable" — there is no third
 * state in which a plausible number appears.
 */

import { useCallback, useEffect, useState } from "react";
import "./MapSurface.css";
import { CanvasPane } from "./CanvasPane";
import { VisualMindMap } from "./map/VisualMindMap";
import { TopologyAtlasGrid } from "./map/TopologyAtlasGrid";
import { fetchMap, sectionData, type MapPayload } from "./map/mapApi";

export type MapMode = "mindmap" | "canvas" | "atlas";

const STORAGE_KEY_MODE = "forge.map.mode";
const DEFAULT_CANVAS_PATH = "Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md";
const REFRESH_MS = 30_000;

/** A header chip. `value === null` means "not measured" and renders amber. */
interface TelemetryChip {
  key: string;
  value: string | null;
  label: string;
  /** Shown as the chip's title when the figure is missing. */
  unavailable?: string;
}

export function MapSurface({
  onNavigateSurface,
}: {
  onNavigateSurface?: (surface: string) => void;
}) {
  const [mode, setMode] = useState<MapMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY_MODE);
      if (saved === "mindmap" || saved === "canvas" || saved === "atlas") {
        return saved;
      }
    }
    return "mindmap";
  });

  const [canvasPath, setCanvasPath] = useState<string>(DEFAULT_CANVAS_PATH);

  const [payload, setPayload] = useState<MapPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Agents at work today — a different producer, so a different fetch. */
  const [activeAgents, setActiveAgents] = useState<number | null>(null);

  const handleModeChange = (newMode: MapMode) => {
    setMode(newMode);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_MODE, newMode);
    }
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchMap();
      setPayload(next);
      setLoadError(null);
    } catch (err) {
      // Keep whatever we last read on screen and say the refresh failed. The
      // one thing not allowed is replacing a real figure with an invented one.
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/today");
      if (!res.ok) throw new Error(`/api/today → HTTP ${res.status}`);
      const json: unknown = await res.json();
      const fleet =
        typeof json === "object" && json !== null
          ? (json as { fleet?: unknown }).fleet
          : undefined;
      setActiveAgents(Array.isArray(fleet) ? fleet.length : null);
    } catch {
      // One chip goes amber; the map itself is unaffected.
      setActiveAgents(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadAgents();
    const timer = setInterval(() => {
      void reload();
      void reloadAgents();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload, reloadAgents]);

  const businesses = sectionData(payload?.sections.businesses);
  const processes = sectionData(payload?.sections.processes);
  const domains = sectionData(payload?.sections.domains);
  const storage = sectionData(payload?.sections.storage);

  const chips: TelemetryChip[] = [
    {
      key: "businesses",
      value: businesses ? String(businesses.active) : null,
      label: "active projects",
      unavailable: "the vault project table could not be read",
    },
    {
      key: "agents",
      value: activeAgents === null ? null : String(activeAgents),
      label: "agents today",
      unavailable: "/api/today did not answer",
    },
    {
      key: "pm2",
      value: processes ? `${processes.online}/${processes.count}` : null,
      label: "pm2 online",
      unavailable: "pm2 jlist failed",
    },
    {
      key: "domains",
      value: domains ? String(domains.count) : null,
      label: `server names${domains ? ` · ${domains.files} vhosts` : ""}`,
      unavailable: "/etc/nginx could not be parsed",
    },
    {
      key: "ram",
      value: storage
        ? `${Math.round(storage.memory.total_bytes / 1024 ** 3)} GB`
        : null,
      label: storage ? `RAM · ${storage.memory.used_pct}% used` : "RAM",
      unavailable: "/proc/meminfo could not be read",
    },
    {
      key: "disk",
      value: storage && storage.disks.length > 0
        ? `${storage.disks[0].used_pct}%`
        : null,
      label: storage && storage.disks.length > 0
        ? `disk ${storage.disks[0].mount}`
        : "disk",
      unavailable: "df returned no parseable rows",
    },
  ];

  return (
    <div className="map-surface">
      {/* ── Top Header & Telemetry Strip ── */}
      <div className="map-header">
        <div className="map-header-top">
          <div className="map-title-group">
            <span className="map-title-icon">🗺️</span>
            <div>
              <div className="map-title">MAP · AI OS &amp; Business Universe</div>
              <div className="map-subtitle">
                System topology, physical infrastructure &amp; project map — measured live
              </div>
            </div>
          </div>

          <div className="map-mode-tabs">
            <button
              type="button"
              className={`map-mode-tab ${mode === "mindmap" ? "active" : ""}`}
              onClick={() => handleModeChange("mindmap")}
            >
              <span>🗺️</span> Mind Map
            </button>
            <button
              type="button"
              className={`map-mode-tab ${mode === "canvas" ? "active" : ""}`}
              onClick={() => handleModeChange("canvas")}
            >
              <span>✏️</span> Planning Canvas
            </button>
            <button
              type="button"
              className={`map-mode-tab ${mode === "atlas" ? "active" : ""}`}
              onClick={() => handleModeChange("atlas")}
            >
              <span>📊</span> System Atlas
            </button>
          </div>
        </div>

        <div className="map-telemetry-strip">
          {chips.map((chip) => (
            <div
              key={chip.key}
              className="map-telemetry-chip"
              title={chip.value === null ? chip.unavailable : undefined}
            >
              <span className={`map-dot ${chip.value === null ? "yellow" : "green"}`} />
              <span>
                <strong>{chip.value ?? "—"}</strong> {chip.label}
              </span>
            </div>
          ))}

          <div className="map-telemetry-source">
            {loadError
              ? `⚠️ ${loadError}`
              : payload
                ? `/api/map · ${new Date(payload.generated_at).toLocaleTimeString(undefined, { hour12: false })}`
                : loading
                  ? "reading /api/map…"
                  : "no reading yet"}
          </div>
        </div>
      </div>

      {/* ── Viewport Body ── */}
      <div className="map-content">
        {mode === "mindmap" && (
          <VisualMindMap
            payload={payload}
            loading={loading}
            loadError={loadError}
            onReload={() => void reload()}
            onNavigateSurface={onNavigateSurface}
            onOpenCanvas={() => handleModeChange("canvas")}
          />
        )}

        {mode === "canvas" && (
          <div className="map-canvas-host">
            <CanvasPane
              path={canvasPath}
              onPathChange={setCanvasPath}
              showChrome={true}
            />
          </div>
        )}

        {mode === "atlas" && (
          <TopologyAtlasGrid
            payload={payload}
            loading={loading}
            loadError={loadError}
            onReload={() => void reload()}
          />
        )}
      </div>
    </div>
  );
}

export default MapSurface;
