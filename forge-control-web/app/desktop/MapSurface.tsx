"use client";

/**
 * MapSurface.tsx — The unified Map, Architecture & Topology Cockpit of Konrad's AI OS.
 *
 * Provides 3 distinct interactive modes:
 * 1. 🗺️ Mind Map — Hierarchical visual mind map of Commercial Ventures, AI OS Fleet, and Infrastructure.
 * 2. ✏️ Planning Canvas — Embedded Excalidraw planning canvas (AI OS - Life & Company OS - Planning Canvas.excalidraw.md).
 * 3. 📊 System Atlas — 4-Column live topology grid with sectional error isolation (Processes, Domains, Storage, Providers).
 *
 * Live Telemetry Status Strip displays macro totals:
 * - 5 Businesses
 * - 5 Active Agents
 * - 22/28 PM2 Online
 * - 19 Domains
 * - 64 GB RAM (62.5% used)
 */

import { useCallback, useEffect, useState } from "react";
import "./MapSurface.css";
import { tokens } from "../tokens";
import { CanvasPane } from "./CanvasPane";
import { VisualMindMap } from "./map/VisualMindMap";
import { TopologyAtlasGrid } from "./map/TopologyAtlasGrid";

export type MapMode = "mindmap" | "canvas" | "atlas";

const STORAGE_KEY_MODE = "forge.map.mode";
const DEFAULT_CANVAS_PATH = "Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md";

interface TelemetrySummary {
  businessesCount: number;
  activeAgents: number;
  pm2Online: number;
  pm2Total: number;
  domainsCount: number;
  ramUsagePct: number;
  ramTotalGb: number;
}

export function MapSurface({
  onNavigateSurface,
}: {
  onNavigateSurface?: (surface: string) => void;
}) {
  // Restore mode from localStorage if available
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

  // Telemetry status strip data
  const [telemetry, setTelemetry] = useState<TelemetrySummary>({
    businessesCount: 5,
    activeAgents: 5,
    pm2Online: 22,
    pm2Total: 28,
    domainsCount: 19,
    ramUsagePct: 62.5,
    ramTotalGb: 64,
  });

  // Sync mode changes to localStorage
  const handleModeChange = (newMode: MapMode) => {
    setMode(newMode);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_MODE, newMode);
    }
  };

  // Poll live telemetry
  const fetchLiveTelemetry = useCallback(async () => {
    try {
      const [pm2Res, statsRes, todayRes] = await Promise.allSettled([
        fetch("/api/proxy/pm2/list"),
        fetch("/api/proxy/system/stats"),
        fetch("/api/proxy/today"),
      ]);

      let online = 22;
      let total = 28;
      if (pm2Res.status === "fulfilled" && pm2Res.value.ok) {
        const pm2Json = await pm2Res.value.json();
        if (typeof pm2Json.online === "number") online = pm2Json.online;
        if (typeof pm2Json.count === "number") total = pm2Json.count;
      }

      let ramPct = 62.5;
      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        const statsJson = await statsRes.value.json();
        if (statsJson.memory?.used_pct) ramPct = statsJson.memory.used_pct;
      }

      let agents = 5;
      if (todayRes.status === "fulfilled" && todayRes.value.ok) {
        const todayJson = await todayRes.value.json();
        if (Array.isArray(todayJson.fleet)) agents = todayJson.fleet.length;
      }

      setTelemetry({
        businessesCount: 5,
        activeAgents: agents,
        pm2Online: online,
        pm2Total: total,
        domainsCount: 19,
        ramUsagePct: ramPct,
        ramTotalGb: 64,
      });
    } catch {
      // Retain existing telemetry state on network error
    }
  }, []);

  useEffect(() => {
    fetchLiveTelemetry();
    const timer = setInterval(fetchLiveTelemetry, 30_000);
    return () => clearInterval(timer);
  }, [fetchLiveTelemetry]);

  return (
    <div className="map-surface">
      {/* ── Top Header & Telemetry Strip ── */}
      <div className="map-header">
        <div className="map-header-top">
          <div className="map-title-group">
            <span style={{ fontSize: 18 }}>🗺️</span>
            <div>
              <div className="map-title">
                MAP · AI OS & Business Universe
              </div>
              <div className="map-subtitle">
                System topology, physical infrastructure & enterprise mind map
              </div>
            </div>
          </div>

          {/* Mode Selector Tabs */}
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

        {/* Live Telemetry Status Strip */}
        <div className="map-telemetry-strip">
          <div className="map-telemetry-chip">
            <span className="map-dot green" />
            <span>● <strong>{telemetry.businessesCount}</strong> Businesses</span>
          </div>

          <div className="map-telemetry-chip">
            <span className="map-dot green" />
            <span>● <strong>{telemetry.activeAgents}</strong> Active Agents</span>
          </div>

          <div className="map-telemetry-chip">
            <span className={`map-dot ${telemetry.pm2Online > 0 ? "green" : "yellow"}`} />
            <span>
              ● <strong>{telemetry.pm2Online}/{telemetry.pm2Total}</strong> PM2 online
            </span>
          </div>

          <div className="map-telemetry-chip">
            <span className="map-dot green" />
            <span>● <strong>{telemetry.domainsCount}</strong> Domains Ingress</span>
          </div>

          <div className="map-telemetry-chip">
            <span className="map-dot blue" />
            <span>
              ● <strong>{telemetry.ramTotalGb} GB RAM</strong> ({telemetry.ramUsagePct.toFixed(1)}% used)
            </span>
          </div>
        </div>
      </div>

      {/* ── Viewport Body ── */}
      <div className="map-content">
        {mode === "mindmap" && (
          <VisualMindMap
            onNavigateSurface={onNavigateSurface}
            onOpenCanvas={() => handleModeChange("canvas")}
          />
        )}

        {mode === "canvas" && (
          <div style={{ width: "100%", height: "100%", position: "relative" }}>
            <CanvasPane
              path={canvasPath}
              onPathChange={setCanvasPath}
              showChrome={true}
            />
          </div>
        )}

        {mode === "atlas" && (
          <TopologyAtlasGrid />
        )}
      </div>
    </div>
  );
}

export default MapSurface;
