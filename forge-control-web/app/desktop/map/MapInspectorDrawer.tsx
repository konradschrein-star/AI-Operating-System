"use client";

/**
 * MapInspectorDrawer.tsx — Slide-over inspection drawer for nodes in the Visual Mind Map.
 *
 * Displays detailed information about a selected node:
 * - Live health badge and status notes
 * - Ports, domain, upstream proxy target
 * - Codebase repository path & GitHub link
 * - Machine/Host details (VPS1 / VPS2 / External)
 * - Quick-action buttons (Open URL, View in Live, Open in Files/Library, Chat with Agent)
 */

import { useEffect } from "react";
import { tokens } from "../../tokens";

export interface MindMapNode {
  id: string;
  label: string;
  type: "root" | "venture" | "fleet" | "infra" | "service" | "agent" | "database" | "tool";
  status?: "online" | "running" | "stopped" | "dormant" | "warning" | "error" | "active" | "unknown" | "not_deployed";
  statusNote?: string;
  description: string;
  host?: string;
  port?: number | string;
  domain?: string;
  publicUrl?: string | null;
  adminUrl?: string;
  repoPath?: string;
  githubUrl?: string | null;
  upstreamTarget?: string;
  metrics?: {
    cpu?: number;
    ram?: string;
    restarts?: number;
    uptime?: string;
  };
  category?: string;
  tags?: string[];
  children?: MindMapNode[];
}

interface MapInspectorDrawerProps {
  node: MindMapNode | null;
  onClose: () => void;
  onNavigateSurface?: (surface: string) => void;
}

export function MapInspectorDrawer({
  node,
  onClose,
  onNavigateSurface,
}: MapInspectorDrawerProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!node) return null;

  const isRunning =
    node.status === "online" ||
    node.status === "running" ||
    node.status === "active";
  const isStopped =
    node.status === "stopped" || node.status === "not_deployed";
  const isWarn = node.status === "warning" || node.status === "error";

  const getStatusColor = () => {
    if (isRunning) return "var(--fg-ok, #10b981)";
    if (isStopped) return "var(--fg-bleed, #ef4444)";
    if (isWarn) return "var(--fg-warn, #f59e0b)";
    return "var(--fg-textMuted, #6b7280)";
  };

  const getStatusLabel = () => {
    if (node.status === "online" || node.status === "running" || node.status === "active") return "Active / Online";
    if (node.status === "stopped") return "Stopped";
    if (node.status === "not_deployed") return "Not Deployed";
    if (node.status === "dormant") return "Dormant";
    if (node.status === "warning") return "Warning";
    if (node.status === "error") return "Error";
    return node.status ?? "Ready";
  };

  return (
    <div
      className="map-drawer-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="map-drawer">
        {/* Drawer Header */}
        <div className="map-drawer-header">
          <div className="map-drawer-title-group">
            <div className="map-drawer-title">
              <span
                className="map-dot"
                style={{ background: getStatusColor() }}
              />
              {node.label}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span className="mindmap-node-badge">{node.type}</span>
              {node.category && (
                <span
                  style={{
                    fontSize: 10.5,
                    color: tokens.textMuted,
                  }}
                >
                  {node.category}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="map-drawer-close"
            onClick={onClose}
            aria-label="Close Inspector"
            title="Close Inspector (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Drawer Body */}
        <div className="map-drawer-body">
          {/* Quick Action Buttons */}
          <div className="map-drawer-actions">
            {node.publicUrl && (
              <a
                href={node.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="map-action-btn primary"
              >
                <span>↗</span> Open URL
              </a>
            )}
            {node.adminUrl && (
              <a
                href={node.adminUrl.startsWith("http") ? node.adminUrl : undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="map-action-btn"
                onClick={
                  node.adminUrl.startsWith("http")
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        navigator.clipboard?.writeText(node.adminUrl ?? "");
                      }
                }
                title={node.adminUrl}
              >
                <span>⚙</span> {node.adminUrl.startsWith("http") ? "Admin" : "Copy Endpoint"}
              </a>
            )}
            {node.githubUrl && (
              <a
                href={node.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="map-action-btn"
              >
                <span>⌥</span> GitHub
              </a>
            )}
            {onNavigateSurface && (
              <>
                <button
                  type="button"
                  className="map-action-btn"
                  onClick={() => onNavigateSurface("live")}
                >
                  <span>●</span> View in Live
                </button>
                <button
                  type="button"
                  className="map-action-btn"
                  onClick={() => onNavigateSurface("live")}
                  title="Inspect runtime logs in Live telemetry"
                >
                  <span>📜</span> View Logs
                </button>
                <button
                  type="button"
                  className="map-action-btn"
                  onClick={() => onNavigateSurface("library")}
                >
                  <span>📁</span> Open in Files/Library
                </button>
                <button
                  type="button"
                  className="map-action-btn"
                  onClick={() => onNavigateSurface("chat")}
                >
                  <span>💬</span> Chat with Agent
                </button>
              </>
            )}
          </div>

          {/* Health & Status Card */}
          <div className="map-drawer-section">
            <div className="map-drawer-section-title">Health & Status</div>
            <div className="map-info-grid">
              <div className="map-info-row">
                <span className="map-info-label">Current State</span>
                <span
                  className="map-info-val"
                  style={{ color: getStatusColor(), fontWeight: 600 }}
                >
                  {getStatusLabel()}
                </span>
              </div>
              {node.statusNote && (
                <div className="map-info-row">
                  <span className="map-info-label">Note</span>
                  <span
                    className="map-info-val"
                    style={{ color: tokens.textSecondary, fontFamily: "inherit" }}
                  >
                    {node.statusNote}
                  </span>
                </div>
              )}
              {node.host && (
                <div className="map-info-row">
                  <span className="map-info-label">Host Machine</span>
                  <span className="map-info-val">{node.host}</span>
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          {node.description && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Overview</div>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: tokens.text,
                  background: tokens.bgGutter,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${tokens.borderSoft}`,
                }}
              >
                {node.description}
              </div>
            </div>
          )}

          {/* Endpoints & Ports */}
          {(node.domain || node.port || node.upstreamTarget || node.publicUrl) && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Network & Ingress</div>
              <div className="map-info-grid">
                {node.domain && (
                  <div className="map-info-row">
                    <span className="map-info-label">Domain</span>
                    <span className="map-info-val">{node.domain}</span>
                  </div>
                )}
                {node.port && (
                  <div className="map-info-row">
                    <span className="map-info-label">Port</span>
                    <span className="map-info-val">:{node.port}</span>
                  </div>
                )}
                {node.upstreamTarget && (
                  <div className="map-info-row">
                    <span className="map-info-label">Upstream Target</span>
                    <span className="map-info-val">{node.upstreamTarget}</span>
                  </div>
                )}
                {node.publicUrl && (
                  <div className="map-info-row">
                    <span className="map-info-label">Public URL</span>
                    <span className="map-info-val">{node.publicUrl}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Repository & Paths */}
          {(node.repoPath || node.githubUrl) && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Codebase & Files</div>
              <div className="map-info-grid">
                {node.repoPath && (
                  <div className="map-info-row">
                    <span className="map-info-label">Filesystem Path</span>
                    <span className="map-info-val">{node.repoPath}</span>
                  </div>
                )}
                {node.githubUrl && (
                  <div className="map-info-row">
                    <span className="map-info-label">Git Remote</span>
                    <span className="map-info-val">{node.githubUrl}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Metrics & Telemetry */}
          {node.metrics && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Runtime Telemetry</div>
              <div className="map-info-grid">
                {node.metrics.cpu !== undefined && (
                  <div className="map-info-row">
                    <span className="map-info-label">CPU Load</span>
                    <span className="map-info-val">{node.metrics.cpu.toFixed(1)}%</span>
                  </div>
                )}
                {node.metrics.ram && (
                  <div className="map-info-row">
                    <span className="map-info-label">Memory</span>
                    <span className="map-info-val">{node.metrics.ram}</span>
                  </div>
                )}
                {node.metrics.restarts !== undefined && (
                  <div className="map-info-row">
                    <span className="map-info-label">Restarts</span>
                    <span className="map-info-val">{node.metrics.restarts}</span>
                  </div>
                )}
                {node.metrics.uptime && (
                  <div className="map-info-row">
                    <span className="map-info-label">Uptime</span>
                    <span className="map-info-val">{node.metrics.uptime}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tags */}
          {node.tags && node.tags.length > 0 && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {node.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontSize: 10.5,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: tokens.bgGutter,
                      border: `1px solid ${tokens.borderSoft}`,
                      color: tokens.textMuted,
                    }}
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
