"use client";

import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { tokens } from "../../tokens";
import {
  type JournalEntry,
  uploadJournalPaper,
  deleteJournalEntry,
} from "../../api";
import { ImageLightbox } from "./ImageLightbox";

interface PaperCaptureDeckProps {
  day: string;
  entries: JournalEntry[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRefresh: () => void;
  onUploadSuccess?: () => void;
}

export function PaperCaptureDeck({
  day,
  entries,
  isLoading,
  isError,
  error,
  onRefresh,
  onUploadSuccess,
}: PaperCaptureDeckProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [selectedEntryIndex, setSelectedEntryIndex] = useState<number | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    await uploadFileList(Array.from(files));
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFileList(Array.from(files));
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const uploadFileList = async (files: File[]) => {
    setIsUploading(true);
    setUploadError(null);
    try {
      for (const file of files) {
        await uploadJournalPaper(file, {
          day,
          caption: caption.trim() || undefined,
        });
      }
      setCaption("");
      onUploadSuccess?.();
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadError(msg);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm("Remove this scan from the day's journal timeline?")) {
      return;
    }
    setDeletingId(id);
    try {
      await deleteJournalEntry(id);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Delete failed: ${msg}`);
    } finally {
      setDeletingId(null);
    }
  };

  const selectedEntry =
    selectedEntryIndex !== null && entries[selectedEntryIndex]
      ? entries[selectedEntryIndex]
      : null;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="ms"
            style={{ fontSize: 18, color: tokens.textSecondary }}
          >
            auto_stories
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: tokens.text,
              letterSpacing: "0.06em",
              fontFamily: "monospace",
            }}
          >
            PAPER JOURNAL & VISUAL SCANS
          </span>
        </div>
        <span
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            fontFamily: "monospace",
          }}
        >
          {entries.length} {entries.length === 1 ? "page" : "pages"} captured
        </span>
      </div>

      {/* Upload Dropzone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `1.5px dashed ${isDragging ? tokens.accent : tokens.borderEmphasis}`,
          borderRadius: 8,
          background: isDragging ? tokens.selectedBg : tokens.toolBg,
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />

        <span
          className="ms"
          style={{
            fontSize: 28,
            color: isDragging ? tokens.accent : tokens.textMuted,
          }}
        >
          {isUploading ? "sync" : "cloud_upload"}
        </span>

        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: tokens.text,
              marginBottom: 4,
            }}
          >
            {isUploading
              ? "Storing and indexing photo..."
              : "Drag & drop handwritten paper scans here, or click to browse"}
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            Accepts JPG, PNG, WEBP, HEIC, PDF (max 30MB)
          </div>
        </div>

        {/* Optional caption field inside upload card */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: 360,
            display: "flex",
            gap: 6,
            marginTop: 4,
          }}
        >
          <input
            type="text"
            placeholder="Optional scan caption (e.g. Evening review page 1)..."
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            style={{
              flex: 1,
              background: tokens.inputBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 11,
              color: tokens.text,
              outline: "none",
            }}
          />
          <button
            type="button"
            disabled={isUploading}
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              color: tokens.accent,
              padding: "6px 12px",
              fontSize: 11,
              fontWeight: 600,
              cursor: isUploading ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              whiteSpace: "nowrap",
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              add_photo_alternate
            </span>
            Upload
          </button>
        </div>
      </div>

      {/* Upload Error Banner */}
      {uploadError && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "10px 12px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 6,
            color: tokens.bleed,
            fontSize: 12,
          }}
        >
          <span className="ms" style={{ fontSize: 16, marginTop: 1 }}>
            error
          </span>
          <div style={{ flex: 1 }}>
            <strong>Upload failed:</strong> {uploadError}
          </div>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.bleed,
              cursor: "pointer",
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              close
            </span>
          </button>
        </div>
      )}

      {/* Gallery Section */}
      {isLoading ? (
        /* Loading Skeleton */
        <div style={{ display: "flex", gap: 12, overflowX: "hidden" }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                width: 140,
                height: 180,
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
                animation: "pulse 1.5s ease-in-out infinite",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      ) : isError ? (
        /* Error State */
        <div
          style={{
            padding: "16px 14px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 6,
            color: tokens.bleed,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 18 }}>
              warning
            </span>
            <span>
              Failed to load paper scans: {error?.message || "Unknown error"}
            </span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 4,
              color: tokens.text,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : entries.length === 0 ? (
        /* Honest Empty State */
        <div
          style={{
            padding: "24px 16px",
            border: `1px dashed ${tokens.borderDivider}`,
            borderRadius: 6,
            textAlign: "center",
            background: tokens.bgGutter,
          }}
        >
          <span
            className="ms"
            style={{ fontSize: 24, color: tokens.textGhost, marginBottom: 8 }}
          >
            edit_note
          </span>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: tokens.textMuted,
              marginBottom: 4,
            }}
          >
            No paper journal scans uploaded for {day}
          </div>
          <div
            style={{
              fontSize: 11,
              color: tokens.textFaint,
              maxWidth: 420,
              margin: "0 auto",
              lineHeight: 1.5,
            }}
          >
            Photograph pages from your physical journal or planner and upload
            them here. They will be archived, timestamped, and viewable in
            high-resolution.
          </div>
        </div>
      ) : (
        /* Populated Thumbnail Strip / Gallery */
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
            gap: 12,
          }}
        >
          {entries.map((entry, idx) => {
            const isDeleting = deletingId === entry.id;
            const previewUrl = entry.file_url
              ? `/api/proxy${entry.file_url}`
              : "";
            const isDoneOcr = entry.ocr_status === "done";
            const isPendingOcr = entry.ocr_status === "pending";

            return (
              <div
                key={entry.id}
                onClick={() => setSelectedEntryIndex(idx)}
                style={{
                  position: "relative",
                  borderRadius: 6,
                  border: `1px solid ${tokens.border}`,
                  background: tokens.bgBody,
                  overflow: "hidden",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  transition: "border-color 0.15s ease, transform 0.15s ease",
                  opacity: isDeleting ? 0.4 : 1,
                }}
              >
                {/* Thumbnail Image Container */}
                <div
                  style={{
                    height: 120,
                    background: tokens.toolBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt={entry.caption || entry.file_name || "Scan thumbnail"}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <span
                      className="ms"
                      style={{ fontSize: 32, color: tokens.textGhost }}
                    >
                      image
                    </span>
                  )}

                  {/* Delete button overlay */}
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, entry.id)}
                    title="Delete scan"
                    disabled={isDeleting}
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 24,
                      height: 24,
                      borderRadius: 4,
                      background: tokens.dangerActionBg,
                      border: `1px solid ${tokens.dangerActionBorder}`,
                      color: tokens.bleed,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: isDeleting ? "not-allowed" : "pointer",
                      padding: 0,
                    }}
                  >
                    <span className="ms" style={{ fontSize: 14 }}>
                      delete
                    </span>
                  </button>

                  {/* Magnify badge */}
                  <div
                    style={{
                      position: "absolute",
                      bottom: 4,
                      right: 4,
                      padding: "2px 4px",
                      borderRadius: 4,
                      background: tokens.overlay,
                      color: tokens.textSoft,
                      fontSize: 10,
                      display: "flex",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    <span className="ms" style={{ fontSize: 12 }}>
                      zoom_in
                    </span>
                  </div>
                </div>

                {/* Meta details */}
                <div
                  style={{
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    background: tokens.bgCard,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: tokens.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: "monospace",
                    }}
                  >
                    {entry.caption || entry.file_name || `Scan #${idx + 1}`}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: 10,
                      color: tokens.textMuted,
                      fontFamily: "monospace",
                    }}
                  >
                    <span>
                      {entry.size_bytes
                        ? `${(entry.size_bytes / 1024).toFixed(0)} KB`
                        : "—"}
                    </span>
                    <span
                      style={{
                        color: isDoneOcr
                          ? tokens.ok
                          : isPendingOcr
                            ? tokens.warn
                            : tokens.textFaint,
                      }}
                    >
                      {entry.ocr_status}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox Modal */}
      {selectedEntry && (
        <ImageLightbox
          entry={selectedEntry}
          onClose={() => setSelectedEntryIndex(null)}
          onPrev={() =>
            setSelectedEntryIndex((i) =>
              i !== null && i > 0 ? i - 1 : i,
            )
          }
          onNext={() =>
            setSelectedEntryIndex((i) =>
              i !== null && i < entries.length - 1 ? i + 1 : i,
            )
          }
          hasPrev={selectedEntryIndex !== null && selectedEntryIndex > 0}
          hasNext={
            selectedEntryIndex !== null &&
            selectedEntryIndex < entries.length - 1
          }
        />
      )}
    </div>
  );
}
