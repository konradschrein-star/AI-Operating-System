"use client";

/**
 * VisualMindMap.tsx — the Mind Map view of the MAP surface.
 *
 * A VIEW, and only a view. Every node it draws comes from `buildMapTree()`,
 * which takes one `/api/map` payload and nothing else; this file holds no data
 * of its own. That is the round-4 correction: round 3 hand-authored the tree,
 * and shipped GitHub links that 404 and domains that are in no nginx config.
 *
 * Three columns, each with its own error state and its own retry, because a
 * dead pm2 must not blank the vault's project table (the aggregator isolates
 * sections; throwing that away in the UI would waste it).
 */

import { useMemo, useState } from "react";
import { tokens } from "../../tokens";
import { MapInspectorDrawer, statusDotClass, type MindMapNode } from "./MapInspectorDrawer";
import { formatCheckedAt, type MapPayload } from "./mapApi";
import { buildMapTree, nodeMatches, type MapBranch } from "./mapTree";

interface VisualMindMapProps {
  /** The one `/api/map` read MapSurface owns — never fetched twice per screen. */
  payload: MapPayload | null;
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  onNavigateSurface?: (surface: string) => void;
  onOpenCanvas?: () => void;
}

export function VisualMindMap({
  payload,
  loading,
  loadError,
  onReload,
  onNavigateSurface,
  onOpenCanvas,
}: VisualMindMapProps) {
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const tree = useMemo(() => (payload ? buildMapTree(payload) : null), [payload]);

  const toggleExpand = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const q = searchQuery.toLowerCase().trim();

  const renderNodeCard = (node: MindMapNode, isRoot = false) => {
    const isSelected = selectedNode?.id === node.id;
    const directHit =
      q.length > 0 &&
      (node.label.toLowerCase().includes(q) ||
        node.description.toLowerCase().includes(q) ||
        node.tags.some((t) => t.includes(q)));
    const children = (node.children ?? []).filter((c) => nodeMatches(c, q));
    const expanded = expandedNodes.has(node.id) || (q.length > 0 && children.length > 0);

    return (
      <div
        key={node.id}
        className={`mindmap-node ${isRoot ? "root" : ""} ${isSelected ? "selected" : ""} ${directHit ? "hit" : ""}`}
        onClick={() => setSelectedNode(node)}
      >
        <div className="mindmap-node-header">
          <div className="mindmap-node-title">
            <span className={`map-dot ${statusDotClass(node.status)}`} />
            {node.label}
          </div>
          <span className="mindmap-node-badge">{node.type}</span>
        </div>

        <div className="mindmap-node-desc">{node.description}</div>
        <div className="mindmap-node-status">{node.statusLabel}</div>

        <div className="mindmap-node-footer">
          {node.publicUrl && <span>🌐 {new URL(node.publicUrl).host}</span>}
          {node.path && <span>📁 {node.path}</span>}
        </div>

        {children.length > 0 && (
          <div className="mindmap-node-children">
            <button
              type="button"
              className="mindmap-btn mindmap-btn-tiny"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.id);
              }}
            >
              {expanded
                ? `Hide ${children.length} sub-items ▲`
                : `Show ${children.length} sub-items ▼`}
            </button>

            {expanded && (
              <div className="mindmap-subtree">
                {children.map((child) => renderNodeCard(child))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderBranch = (branch: MapBranch) => {
    const visible = branch.nodes.filter((n) => nodeMatches(n, q));
    return (
      <div className="mindmap-branch-column" key={branch.key}>
        <div className="mindmap-branch-header">
          <span>{branch.icon}</span> {branch.title}
          <span className="mindmap-branch-count">{visible.length}</span>
        </div>
        <div className="mindmap-children-list">
          {branch.error ? (
            <div className="atlas-column-error">
              <span>⚠️ {branch.error}</span>
              <button type="button" onClick={onReload}>
                Retry
              </button>
            </div>
          ) : visible.length > 0 ? (
            visible.map((n) => renderNodeCard(n))
          ) : (
            <div className="mindmap-empty">
              {q ? "No node matches this filter." : "Nothing measured in this column."}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mindmap-container">
      {/* Toolbar */}
      <div className="mindmap-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="mindmap-search">
            <span style={{ color: tokens.textMuted }}>🔍</span>
            <input
              type="text"
              placeholder="Search projects, processes, domains, ports..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="mindmap-search-clear"
                onClick={() => setSearchQuery("")}
              >
                ✕
              </button>
            )}
          </div>
          <span className="mindmap-hint">
            {payload
              ? `Live from /api/map · read ${formatCheckedAt(payload.generated_at)}`
              : loading
                ? "Reading /api/map…"
                : "No data"}
          </span>
        </div>

        <div className="mindmap-controls">
          {onOpenCanvas && (
            <button
              type="button"
              className="mindmap-btn"
              onClick={onOpenCanvas}
              title="Open the Excalidraw planning canvas"
            >
              <span>✏️</span> Planning Canvas
            </button>
          )}
          <button
            type="button"
            className="mindmap-btn"
            onClick={onReload}
            disabled={loading}
          >
            <span>↻</span> {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mindmap-banner error">
          ⚠️ {loadError}
          {payload && (
            <span className="mindmap-banner-note">
              Showing the last successful read ({formatCheckedAt(payload.generated_at)}).
            </span>
          )}
        </div>
      )}

      {/* Canvas */}
      <div className="mindmap-canvas">
        {tree === null ? (
          <div className="mindmap-empty-full">
            {loading ? "Reading /api/map…" : "No map data — retry above."}
          </div>
        ) : (
          <div className="mindmap-tree">
            {tree.root && renderNodeCard(tree.root, true)}
            <div className="mindmap-branches">{tree.branches.map(renderBranch)}</div>
            <div className="mindmap-provenance">
              Measured on {payload?.host.name} ({payload?.host.ip}) only. VPS2
              (167.233.145.218) is deliberately absent: its management key was
              revoked server-side on 2026-08-06 and the surviving key is pinned to a
              forced command, so nothing there can be measured from this host — and an
              unmeasurable node does not belong on a live map.
            </div>
          </div>
        )}
      </div>

      <MapInspectorDrawer
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onNavigateSurface={onNavigateSurface}
      />
    </div>
  );
}
