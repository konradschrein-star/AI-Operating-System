"use client";

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tokens } from "../../tokens";
import type { FileEntry } from "../../api";
import "./VaultFileList.css";

export const VPS_FILE_DRAG_MIME = "application/x-forge-vps-file";

export interface VaultFileListProps {
  root: string | null;
  rel: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  total: number | undefined;
  selected: FileEntry[];
  onDescend: (entry: FileEntry) => void;
  onBreadcrumb: (segmentIndex: number) => void;
  onToggleSelect: (entry: FileEntry) => void;
  onDragStart: (entry: FileEntry, e: React.DragEvent<HTMLDivElement>) => void;
  onRetry: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Breadcrumbs({
  root,
  rel,
  onBreadcrumb,
}: {
  root: string | null;
  rel: string;
  onBreadcrumb: (idx: number) => void;
}) {
  const segments: string[] = ["Home"];
  if (root !== null) {
    segments.push(root);
    for (const part of rel.split("/").filter(Boolean)) {
      segments.push(part);
    }
  }
  return (
    <div
      className="mono vfl-breadcrumbs"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "nowrap",
        gap: 2,
        padding: "5px 10px",
        fontSize: 10.5,
        color: tokens.textSecondary,
        borderBottom: `1px solid ${tokens.borderSoft}`,
        background: tokens.bgTabBar,
        overflowX: "auto",
        minHeight: 28,
        flex: "none",
      }}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
            {i > 0 && (
              <span style={{ color: tokens.textFaint, margin: "0 2px" }}>/</span>
            )}
            {isLast ? (
              <span style={{ color: tokens.text, fontWeight: 600 }}>{seg}</span>
            ) : (
              <button
                onClick={() => onBreadcrumb(i)}
                className="mono vfl-breadcrumb-btn"
                style={{
                  fontSize: 10.5,
                  color: tokens.textSecondary,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "0 2px",
                  borderRadius: 3,
                }}
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

const ROW_HEIGHT = 32;

export function VaultFileList({
  root,
  rel,
  entries,
  loading,
  error,
  truncated,
  total,
  selected,
  onDescend,
  onBreadcrumb,
  onToggleSelect,
  onDragStart,
  onRetry,
}: VaultFileListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  const selectedPaths = new Set(selected.map((e) => e.name));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Breadcrumbs root={root} rel={rel} onBreadcrumb={onBreadcrumb} />

      {/* Virtualized list area */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {loading && entries.length === 0 ? (
          <div
            className="mono"
            style={{
              height: ROW_HEIGHT,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              fontSize: 11,
              color: tokens.textFaint,
            }}
          >
            loading…
          </div>
        ) : error !== null ? (
          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 12px",
              height: ROW_HEIGHT,
              fontSize: 11,
              color: tokens.bleed,
              background: tokens.dangerActionBg,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {error}
            </span>
            <button
              onClick={onRetry}
              className="mono"
              style={{
                fontSize: 10.5,
                color: tokens.text,
                background: tokens.bgGutter,
                border: `1px solid ${tokens.borderEmphasis}`,
                borderRadius: 6,
                padding: "3px 10px",
                cursor: "pointer",
                flex: "none",
              }}
            >
              retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div
            className="mono"
            style={{
              height: ROW_HEIGHT,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              fontSize: 11,
              color: tokens.textFaint,
            }}
          >
            empty directory
          </div>
        ) : (
          <div
            ref={parentRef}
            style={{ height: "100%", overflowY: "auto" }}
          >
            <div
              style={{
                position: "relative",
                height: virtualizer.getTotalSize(),
              }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const entry = entries[item.index];
                if (!entry) return null;
                const isSelected = !entry.isDir && selectedPaths.has(entry.name);
                return (
                  <div
                    key={entry.name}
                    className={`vfl-row${entry.isDir ? " vfl-row--dir" : " vfl-row--file"}${isSelected ? " vfl-row--selected" : ""}`}
                    draggable={!entry.isDir}
                    onClick={() => {
                      if (entry.isDir) onDescend(entry);
                      else onToggleSelect(entry);
                    }}
                    onDragStart={
                      !entry.isDir
                        ? (e) => {
                            e.stopPropagation();
                            onDragStart(entry, e);
                          }
                        : undefined
                    }
                    style={{
                      position: "absolute",
                      top: item.start,
                      height: item.size,
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "0 12px",
                      cursor: entry.isDir ? "default" : "pointer",
                      boxSizing: "border-box",
                      background: isSelected ? tokens.selectedBg : "transparent",
                      borderBottom: `1px solid ${tokens.borderSoft}`,
                      userSelect: "none",
                    }}
                  >
                    {/* Icon */}
                    <span
                      className="ms"
                      style={{ fontSize: 15, color: tokens.textMuted, flex: "none" }}
                    >
                      {entry.isDir ? "folder" : "description"}
                    </span>

                    {/* Name */}
                    <span
                      className="mono"
                      style={{
                        flex: 1,
                        fontSize: 11.5,
                        color: isSelected ? tokens.text : tokens.textLabel,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {entry.name}
                    </span>

                    {/* Size + mtime (files only) */}
                    {!entry.isDir && (
                      <span
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          color: tokens.textMuted2,
                          whiteSpace: "nowrap",
                          flex: "none",
                        }}
                      >
                        {formatSize(entry.size)}{" "}
                        <span style={{ color: tokens.textGhost }}>
                          {new Date(entry.mtime).toLocaleDateString()}
                        </span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Truncation banner — outside virtualized area */}
      {truncated && (
        <div
          className="mono"
          style={{
            padding: "5px 12px",
            fontSize: 10,
            color: tokens.textFaint,
            background: tokens.bgGutter,
            borderTop: `1px solid ${tokens.borderSoft}`,
            flex: "none",
          }}
        >
          showing first {entries.length}
          {total !== undefined ? ` of ${total}` : ""} entries — narrow your search or use pagination
        </div>
      )}
    </div>
  );
}
