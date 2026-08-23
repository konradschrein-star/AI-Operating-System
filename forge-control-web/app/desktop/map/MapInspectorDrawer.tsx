"use client";

/**
 * MapInspectorDrawer.tsx — slide-over inspector for a node in the Visual Mind Map.
 *
 * Every row it renders is a MEASURED fact carried on the node itself, plus the
 * producer that measured it and the timestamp of that measurement. There is no
 * field on `MindMapNode` that a component could fill in from belief: round 3
 * shipped a `githubUrl` rendered as a live `<a href>` pointing at repositories
 * that answer 404, and the fix is structural — the field is gone, and the only
 * link this drawer can build is one nginx is configured to serve.
 */

import { useEffect } from "react";
import { tokens } from "../../tokens";
import { formatCheckedAt } from "./mapApi";

/** A measured key/value row. `value` is already formatted for display. */
export interface MindMapFact {
  label: string;
  value: string;
}

export type MindMapNodeKind =
  | "root"
  | "business"
  | "group"
  | "process"
  | "host"
  | "domain"
  | "datastore"
  | "disk"
  | "unit"
  | "canvas";

/** Green / amber / grey is a claim too, so each carries the words behind it. */
export type MindMapStatus = "up" | "down" | "partial" | "neutral";

export interface MindMapNode {
  id: string;
  label: string;
  type: MindMapNodeKind;
  status: MindMapStatus;
  /** What the dot means here, in words — "21/28 pm2 processes online". */
  statusLabel: string;
  description: string;
  /** The producer `/api/map` read for this node: `pm2 jlist`, a vault note… */
  source: string;
  /** ISO timestamp of that read, straight off the section envelope. */
  checkedAt: string;
  facts: MindMapFact[];
  /** Only ever built from a server_name nginx is actually configured with. */
  publicUrl?: string;
  /** A filesystem path `/api/map` reported (and, for businesses, stat'ed). */
  path?: string;
  /** Surface to jump to, when this node corresponds to one. */
  navigateTo?: string;
  tags: string[];
  children?: MindMapNode[];
}

const STATUS_COLOR: Record<MindMapStatus, string> = {
  up: tokens.ok,
  down: tokens.bleed,
  partial: tokens.warn,
  neutral: tokens.textMuted,
};

export function statusColor(status: MindMapStatus): string {
  return STATUS_COLOR[status];
}

/** The `map-dot` modifier class for a status — one mapping, used everywhere. */
export function statusDotClass(status: MindMapStatus): string {
  if (status === "up") return "green";
  if (status === "down") return "red";
  if (status === "partial") return "yellow";
  return "gray";
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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!node) return null;

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
                style={{ background: statusColor(node.status) }}
              />
              {node.label}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span className="mindmap-node-badge">{node.type}</span>
              <span style={{ fontSize: 10.5, color: tokens.textMuted }}>
                measured {formatCheckedAt(node.checkedAt)}
              </span>
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
          {/* Quick actions — only ones that lead somewhere real */}
          <div className="map-drawer-actions">
            {node.publicUrl && (
              <a
                href={node.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="map-action-btn primary"
              >
                <span>↗</span> Open {new URL(node.publicUrl).host}
              </a>
            )}
            {node.path && (
              <button
                type="button"
                className="map-action-btn"
                onClick={() => navigator.clipboard?.writeText(node.path ?? "")}
                title={node.path}
              >
                <span>⧉</span> Copy path
              </button>
            )}
            {onNavigateSurface && node.navigateTo && (
              <button
                type="button"
                className="map-action-btn"
                onClick={() => onNavigateSurface(node.navigateTo ?? "live")}
              >
                <span>●</span> Open {node.navigateTo}
              </button>
            )}
          </div>

          {/* Health & Status */}
          <div className="map-drawer-section">
            <div className="map-drawer-section-title">Health &amp; Status</div>
            <div className="map-info-grid">
              <div className="map-info-row">
                <span className="map-info-label">Current State</span>
                <span
                  className="map-info-val"
                  style={{ color: statusColor(node.status), fontWeight: 600 }}
                >
                  {node.statusLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Description */}
          {node.description && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Overview</div>
              <div className="map-drawer-prose">{node.description}</div>
            </div>
          )}

          {/* Measured facts */}
          {node.facts.length > 0 && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Measured</div>
              <div className="map-info-grid">
                {node.facts.map((f) => (
                  <div className="map-info-row" key={f.label}>
                    <span className="map-info-label">{f.label}</span>
                    <span className="map-info-val">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Provenance — the whole point of the round-4 rework */}
          <div className="map-drawer-section">
            <div className="map-drawer-section-title">Provenance</div>
            <div className="map-info-grid">
              <div className="map-info-row">
                <span className="map-info-label">Source</span>
                <span className="map-info-val">{node.source}</span>
              </div>
              <div className="map-info-row">
                <span className="map-info-label">Checked at</span>
                <span className="map-info-val">{node.checkedAt}</span>
              </div>
            </div>
          </div>

          {/* Tags */}
          {node.tags.length > 0 && (
            <div className="map-drawer-section">
              <div className="map-drawer-section-title">Tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {node.tags.map((tag) => (
                  <span key={tag} className="map-tag-chip">
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
