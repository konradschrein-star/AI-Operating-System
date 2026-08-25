"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tokens } from "../../tokens";
import type { FileEntry } from "../../api";
import "./VaultFileList.css";

export const VPS_FILE_DRAG_MIME = "application/x-forge-vps-file";

export interface VaultFileListProps {
  root: string | null;
  /** Human-readable label for `root` (e.g. "Obsidian Vault"), shown in the
   *  breadcrumb. Falls back to the root key when omitted. */
  rootLabel?: string;
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
  /** Name of an entry in THIS directory to scroll into view and flash — set
   *  when a click on a path in a chat message opened the file programmatically.
   *  Selection alone is not enough: the list is virtualized, so the selected
   *  row is frequently not rendered at all, and the panel showed the right
   *  preview above a list where the file was nowhere to be seen. */
  revealName?: string;
  /** Bumped on every open request, including a repeat of the same file, so
   *  re-opening re-runs the scroll and restarts the flash animation. Without
   *  it a second click on the same pill would be indistinguishable from a
   *  dead one. */
  revealNonce?: number;
}

/** Flash duration. Must match the `vfl-reveal-flash` animation in
 *  VaultFileList.css — the class is removed by this timer, the animation just
 *  paints while it is on. */
const FLASH_MS = 1200;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Breadcrumbs({
  root,
  rootLabel,
  rel,
  onBreadcrumb,
}: {
  root: string | null;
  rootLabel?: string;
  rel: string;
  onBreadcrumb: (idx: number) => void;
}) {
  const segments: string[] = ["Home"];
  if (root !== null) {
    // Prefer the human-readable label ("Obsidian Vault") over the raw
    // root key ("vault") for the first non-Home crumb.
    segments.push(rootLabel ?? root);
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
  rootLabel,
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
  revealName,
  revealNonce,
}: VaultFileListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  const selectedPaths = new Set(selected.map((e) => e.name));
  /** Whether the virtualized scroll container is on screen at all — the
   *  loading / error / empty branches below render something else entirely,
   *  so `parentRef` is null in those states. */
  const listRendered = entries.length > 0;

  /* ── Reveal the programmatically opened entry ──────────────────────────────
   *
   * The name arrives BEFORE the directory does: the panel dispatches the
   * reveal and fires the fetch in the same tick, so on the first render after
   * an open request `entries` is still the previous folder's. This effect
   * therefore does nothing until `entries` actually contains the name, and
   * re-runs on every `entries` change until it does. `handledNonceRef` is what
   * stops one request being revealed twice across those re-runs. */
  const [revealed, setRevealed] = useState<{ name: string; nonce: number } | null>(null);
  const handledNonceRef = useRef<number | null>(null);
  /* The row to keep in view while the panel is still settling — see the
   * ResizeObserver effect below. Cleared the moment the reader takes over. */
  const stickyNameRef = useRef<string | null>(null);
  /* `entries` read from inside the observer callback, which is installed once
   * and would otherwise close over the first render's array. */
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    if (revealName === undefined || revealNonce === undefined) return;
    if (handledNonceRef.current === revealNonce) return;
    const idx = entries.findIndex((e) => e.name === revealName);
    if (idx === -1) return;
    handledNonceRef.current = revealNonce;
    stickyNameRef.current = revealName;
    virtualizer.scrollToIndex(idx, { align: "center" });
    setRevealed({ name: revealName, nonce: revealNonce });
  }, [revealName, revealNonce, entries, virtualizer]);

  /* ── Keep the revealed row in view while the panel is still settling ───────
   *
   * MEASURED 2026-08-25 and it undid the whole of D4: the preview pane mounts
   * a beat AFTER the reveal (it has its own fetch) and takes up to 70vh, which
   * shrinks this list's viewport from ~700px to ~64px. The scroll OFFSET
   * survives that; the viewport does not, so the file that was just centred
   * drops out of sight again and the list is back to showing two unrelated
   * neighbours — precisely the screenshot the brief complains about.
   *
   * So: re-issue the scroll whenever the scroll element resizes, until the
   * reader takes over. `wheel`/`pointerdown`/`keydown` release the row —
   * NOT `scroll`, which our own scrollToIndex fires and which would release
   * the sticky before it had done anything. */
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const release = () => {
      stickyNameRef.current = null;
    };
    const ro = new ResizeObserver(() => {
      const name = stickyNameRef.current;
      if (name === null) return;
      const idx = entriesRef.current.findIndex((e) => e.name === name);
      if (idx === -1) {
        // The directory changed under the sticky row. Nothing to pin.
        stickyNameRef.current = null;
        return;
      }
      virtualizer.scrollToIndex(idx, { align: "center" });
    });
    ro.observe(el);
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("pointerdown", release);
    el.addEventListener("keydown", release);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", release);
      el.removeEventListener("pointerdown", release);
      el.removeEventListener("keydown", release);
    };
    // `virtualizer` is a stable instance (react-virtual holds it in useState),
    // so this installs once per mount of the scroll element.
  }, [virtualizer, listRendered]);

  /* The un-flash lives in its own effect on purpose. Cleaning the timer up
   * from the effect above would cancel it on that effect's next re-run — which
   * happens on the very next render — and the flash would never end. */
  useEffect(() => {
    if (revealed === null) return;
    const t = setTimeout(() => setRevealed(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Breadcrumbs root={root} rootLabel={rootLabel} rel={rel} onBreadcrumb={onBreadcrumb} />

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
                const isRevealed = revealed !== null && revealed.name === entry.name;
                return (
                  <div
                    /* The nonce is in the key ONLY for the flashing row: a CSS
                     * animation does not restart when the same class is
                     * re-applied to the same element, so re-opening a file
                     * while its previous flash is still running would show
                     * nothing. Remounting one 32px row is cheaper than a
                     * class-toggle-on-rAF dance. */
                    key={isRevealed ? `${entry.name}#${revealed.nonce}` : entry.name}
                    className={`vfl-row${entry.isDir ? " vfl-row--dir" : " vfl-row--file"}${isSelected ? " vfl-row--selected" : ""}${isRevealed ? " vfl-row--revealed" : ""}`}
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
                      /* NO `background` here. The row's background belongs to
                       * VaultFileList.css (base / hover / selected / the
                       * reveal animation). An inline `transparent` forced
                       * every one of those rules to carry `!important` to be
                       * seen at all — and a CSS animation loses to an
                       * `!important` declaration, so the flash would simply
                       * not have painted on a selected row. */
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
