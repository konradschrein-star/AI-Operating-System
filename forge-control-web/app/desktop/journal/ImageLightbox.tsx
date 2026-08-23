"use client";

import { useEffect, useState, type MouseEvent, type WheelEvent } from "react";
import { tokens } from "../../tokens";
import type { JournalEntry } from "../../api";

interface ImageLightboxProps {
  entry: JournalEntry | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export function ImageLightbox({
  entry,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showOcr, setShowOcr] = useState(false);

  // Reset transform when entry changes
  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setShowOcr(false);
  }, [entry?.id]);

  // Keyboard navigation & controls
  useEffect(() => {
    if (!entry) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && hasPrev && onPrev) {
        onPrev();
      } else if (e.key === "ArrowRight" && hasNext && onNext) {
        onNext();
      } else if (e.key === "+" || e.key === "=") {
        setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100));
      } else if (e.key === "-") {
        setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100));
      } else if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setRotation(0);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [entry, onClose, onPrev, onNext, hasPrev, hasNext]);

  const handleMouseDown = (e: MouseEvent) => {
    if (zoom <= 1) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging || zoom <= 1) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    setZoom((z) => Math.min(4, Math.max(0.5, Math.round((z + delta) * 100) / 100)));
  };

  if (!entry) return null;

  const imageUrl = entry.file_url ? `/api/proxy${entry.file_url}` : "";
  const formattedSize =
    entry.size_bytes !== null && entry.size_bytes !== undefined
      ? `${(entry.size_bytes / (1024 * 1024)).toFixed(2)} MB`
      : "Unknown size";

  const ocrStatusColor =
    entry.ocr_status === "done"
      ? tokens.ok
      : entry.ocr_status === "pending"
        ? tokens.warn
        : entry.ocr_status === "failed"
          ? tokens.bleed
          : tokens.textMuted;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: tokens.overlay,
        backdropFilter: "blur(6px)",
        display: "flex",
        flexDirection: "column",
        userSelect: isDragging ? "none" : "auto",
      }}
      onMouseUp={handleMouseUp}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          background: tokens.bgCard,
          borderBottom: `1px solid ${tokens.border}`,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tokens.text,
              fontFamily: "monospace",
            }}
          >
            {entry.file_name || "Journal Scan"}
          </span>
          <span
            style={{
              fontSize: 11,
              color: tokens.textMuted,
              fontFamily: "monospace",
            }}
          >
            {entry.day} · {formattedSize}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontFamily: "monospace",
              padding: "2px 8px",
              borderRadius: 4,
              border: `1px solid ${tokens.borderDivider}`,
              background: tokens.toolBg,
              color: ocrStatusColor,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: ocrStatusColor,
              }}
            />
            OCR: {entry.ocr_status}
          </span>
        </div>

        {/* Toolbar controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
            title="Zoom Out (-)"
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              color: tokens.text,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              zoom_out
            </span>
          </button>

          <span
            style={{
              fontSize: 12,
              fontFamily: "monospace",
              color: tokens.textMuted,
              minWidth: 44,
              textAlign: "center",
            }}
          >
            {Math.round(zoom * 100)}%
          </span>

          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
            title="Zoom In (+)"
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              color: tokens.text,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              zoom_in
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
              setRotation(0);
            }}
            title="Reset Zoom (0)"
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              color: tokens.text,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Reset
          </button>

          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            title="Rotate 90°"
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              color: tokens.text,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              rotate_right
            </span>
          </button>

          {entry.ocr_text && (
            <button
              type="button"
              onClick={() => setShowOcr((s) => !s)}
              title="Toggle OCR Text"
              style={{
                background: showOcr ? tokens.selectedBg : tokens.toolBg,
                border: `1px solid ${showOcr ? tokens.accent : tokens.border}`,
                borderRadius: 6,
                color: showOcr ? tokens.accent : tokens.text,
                padding: "6px 10px",
                fontSize: 12,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span className="ms" style={{ fontSize: 16 }}>
                description
              </span>
              OCR
            </button>
          )}

          <div
            style={{
              width: 1,
              height: 20,
              background: tokens.borderDivider,
              margin: "0 4px",
            }}
          />

          <button
            type="button"
            onClick={onClose}
            title="Close Lightbox (Esc)"
            style={{
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 6,
              color: tokens.bleed,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              close
            </span>
            Close
          </button>
        </div>
      </div>

      {/* Main viewport canvas */}
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
      >
        {/* Navigation arrows */}
        {hasPrev && onPrev && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            title="Previous scan (Left arrow)"
            style={{
              position: "absolute",
              left: 24,
              zIndex: 20,
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: tokens.bgCard,
              border: `1px solid ${tokens.borderEmphasis}`,
              color: tokens.text,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <span className="ms" style={{ fontSize: 24 }}>
              chevron_left
            </span>
          </button>
        )}

        {hasNext && onNext && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            title="Next scan (Right arrow)"
            style={{
              position: "absolute",
              right: 24,
              zIndex: 20,
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: tokens.bgCard,
              border: `1px solid ${tokens.borderEmphasis}`,
              color: tokens.text,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <span className="ms" style={{ fontSize: 24 }}>
              chevron_right
            </span>
          </button>
        )}

        {/* High-res Image */}
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            transition: isDragging ? "none" : "transform 0.15s ease-out",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            maxWidth: "90%",
            maxHeight: "90%",
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={entry.caption || entry.file_name || "Handwritten journal page"}
              style={{
                maxWidth: "100%",
                maxHeight: "85vh",
                objectFit: "contain",
                borderRadius: 4,
                border: `1px solid ${tokens.borderEmphasis}`,
                pointerEvents: "none",
              }}
            />
          ) : (
            <div
              style={{
                padding: 32,
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 8,
                color: tokens.textMuted,
                fontSize: 13,
              }}
            >
              No image URL available for this entry.
            </div>
          )}
        </div>

        {/* OCR Sidebar overlay if active */}
        {showOcr && entry.ocr_text && (
          <div
            style={{
              position: "absolute",
              top: 20,
              right: 20,
              bottom: 20,
              width: 360,
              background: tokens.bgCard,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 8,
              padding: 16,
              zIndex: 30,
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: tokens.text,
                  letterSpacing: "0.05em",
                }}
              >
                EXTRACTED OCR TEXT
              </span>
              <button
                type="button"
                onClick={() => setShowOcr(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: tokens.textMuted,
                  cursor: "pointer",
                }}
              >
                <span className="ms" style={{ fontSize: 18 }}>
                  close
                </span>
              </button>
            </div>
            <pre
              style={{
                flex: 1,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 12,
                color: tokens.textSoft,
                fontFamily: "monospace",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              {entry.ocr_text}
            </pre>
          </div>
        )}
      </div>

      {/* Caption bar if exists */}
      {entry.caption && (
        <div
          style={{
            padding: "10px 20px",
            background: tokens.bgCard,
            borderTop: `1px solid ${tokens.border}`,
            color: tokens.textSoft,
            fontSize: 12,
            textAlign: "center",
          }}
        >
          {entry.caption}
        </div>
      )}
    </div>
  );
}
