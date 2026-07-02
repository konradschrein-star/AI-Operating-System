"use client";

/**
 * Attachment state for the chat composers — one hook powers both the
 * thread composer and the new-chat form. Files arrive via drag & drop or
 * paste, upload immediately to /api/uploads, and render as chips (image
 * thumbnails when applicable). On send, api.attachmentsBlock() embeds the
 * VPS paths so the CC engine can Read them.
 */

import { useCallback, useState } from "react";
import { tokens } from "../../tokens";
import { uploadFiles, type UploadedFile } from "../../api";

export function previewUrl(f: UploadedFile): string {
  // backend returns /api/uploads/... — the browser reaches it via the proxy
  return f.url.replace(/^\/api\//, "/api/proxy/");
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const addFiles = useCallback(async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const up = await uploadFiles(files);
      setAttachments((prev) => [...prev, ...up]);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setUploadError(null);
  }, []);

  /** Wire to any container: onDragOver + onDrop. */
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      if (e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    },
  };

  /** Wire to the textarea: intercepts pasted images/files. */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  return {
    attachments,
    uploading,
    uploadError,
    addFiles,
    remove,
    clear,
    dropHandlers,
    onPaste,
  };
}

export function AttachmentChips({
  attachments,
  uploading,
  uploadError,
  onRemove,
}: {
  attachments: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0 && !uploading && !uploadError) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        padding: "8px 0 0",
        alignItems: "center",
      }}
    >
      {attachments.map((f) => {
        const isImage = f.mime.startsWith("image/");
        return (
          <div
            key={f.id}
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 8,
              padding: isImage ? 4 : "5px 9px",
              fontSize: 10.5,
              color: tokens.textLabel,
              background: tokens.bgCard,
              maxWidth: 260,
            }}
          >
            {isImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl(f)}
                alt={f.name}
                style={{
                  width: 40,
                  height: 40,
                  objectFit: "cover",
                  borderRadius: 5,
                  display: "block",
                }}
              />
            )}
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {f.name}
            </span>
            <span
              onClick={() => onRemove(f.id)}
              style={{
                color: tokens.textFaint,
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
                padding: "0 2px",
              }}
            >
              ✕
            </span>
          </div>
        );
      })}
      {uploading && (
        <span className="mono" style={{ fontSize: 10.5, color: tokens.accent }}>
          uploading…
        </span>
      )}
      {uploadError && (
        <span className="mono" style={{ fontSize: 10.5, color: tokens.bleed }}>
          {uploadError}
        </span>
      )}
    </div>
  );
}
