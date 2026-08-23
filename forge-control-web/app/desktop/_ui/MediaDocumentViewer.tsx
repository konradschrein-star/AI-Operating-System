"use client";

/**
 * MediaDocumentViewer — unified multi-format previewer and editor for the AI OS.
 *
 * Used across:
 * - LibrarySurface (artifact / deliverables catalog inspector)
 * - ChatSurface & FileExplorerPanel (file inspection & editing)
 *
 * Supported formats:
 * - Markdown (.md): Rendered view via MessageMarkdown + toggleable edit mode
 *   with mtime/conflict-guarded saves via /api/files/write.
 * - Code & Plain Text (.ts, .js, .py, .json, .sh, .patch, .diff, .log, .txt, .csv...):
 *   Line-numbered pre-wrap viewer with copy-raw and word-wrap toggles.
 * - Images (.png, .jpg, .jpeg, .gif, .webp, .svg...): Zoom/pan viewport with
 *   dimension detection, copy VPS path, and download.
 * - Video (.mp4, .webm, .mov): HTML5 player with Range support, scrubber, speed
 *   selector, and Picture-in-Picture.
 * - Audio (.mp3, .wav, .m4a, .ogg): Inline audio player.
 * - PDF (.pdf): Embedded iframe.
 * - Other: Clear fallback icon, size indicator, VPS path copy, and download button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./MediaDocumentViewer.css";
import { tokens } from "../../tokens";
import {
  fileReadUrl,
  writeFileContent,
  FileConflictError,
} from "../../api";
import { MessageMarkdown } from "../chat/MessageMarkdown";

export interface MediaDocumentViewerProps {
  /** File root key (e.g. 'vault', 'workspace', 'uploads', 'media') if backed by /api/files */
  root?: string;
  /** Relative path within the root (e.g. '90_AI_OS/Spec.md' or 'run-id/file.png') */
  path?: string;
  /** File name (e.g. 'Spec.md') */
  name: string;
  /** Direct URL for previewing/streaming (defaults to fileReadUrl(root, path) if root/path given) */
  url?: string;
  /** Absolute VPS path (e.g. '/opt/obsidian-vault/90_AI_OS/Spec.md') */
  vpsPath?: string;
  /** File size in bytes */
  size?: number;
  /** ISO timestamp string or millisecond epoch */
  mtime?: string | number;
  /** Optional callback invoked after a successful save */
  onSave?: (newContent: string, mtime: number) => void;
  /** Optional callback to close or dismiss the viewer */
  onClose?: () => void;
}

const MD_EXT = new Set([".md", ".markdown"]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".py", ".sh", ".bash", ".zsh",
  ".patch", ".diff", ".log", ".txt", ".csv",
  ".yml", ".yaml", ".css", ".html", ".htm",
  ".sql", ".rs", ".go", ".toml", ".env",
  ".ini", ".conf", ".xml", ".dockerfile",
]);
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac"]);
const PDF_EXT = new Set([".pdf"]);

function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(mtime?: string | number): string {
  if (!mtime) return "";
  try {
    const d = typeof mtime === "number" ? new Date(mtime) : new Date(mtime);
    if (Number.isNaN(d.getTime())) return String(mtime);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return String(mtime);
  }
}

function formatSeconds(secs: number): string {
  if (Number.isNaN(secs) || secs < 0) return "00:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function MediaDocumentViewer({
  root,
  path,
  name,
  url,
  vpsPath,
  size,
  mtime,
  onSave,
  onClose,
}: MediaDocumentViewerProps) {
  const resolvedUrl = useMemo(() => {
    if (url) return url;
    if (root && path !== undefined) return fileReadUrl(root, path);
    return "";
  }, [url, root, path]);

  const fileExt = useMemo(() => getExt(name), [name]);
  const isMarkdown = MD_EXT.has(fileExt);
  const isCodeOrText = CODE_EXT.has(fileExt);
  const isImage = IMAGE_EXT.has(fileExt);
  const isVideo = VIDEO_EXT.has(fileExt);
  const isAudio = AUDIO_EXT.has(fileExt);
  const isPdf = PDF_EXT.has(fileExt);
  const isEditable = (isMarkdown || isCodeOrText) && !!root && path !== undefined;

  // Text loading and editing state
  const [textContent, setTextContent] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState<string>("");
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [baseMtime, setBaseMtime] = useState<number | undefined>(
    typeof mtime === "number" ? mtime : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "conflict" | "error"
  >("idle");
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  // Image viewport state
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);

  // Video playback state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  // Fetch text content for Markdown and Code files
  const loadTextContent = useCallback(async () => {
    if (!resolvedUrl || (!isMarkdown && !isCodeOrText)) return;
    setTextLoading(true);
    setTextError(null);
    try {
      const res = await fetch(resolvedUrl);
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      setTextContent(text);
      setDraftContent(text);
      // Attempt to extract mtime from Last-Modified header if not supplied
      const lastMod = res.headers.get("last-modified");
      if (lastMod && baseMtime === undefined) {
        const parsed = Date.parse(lastMod);
        if (!Number.isNaN(parsed)) setBaseMtime(parsed);
      }
    } catch (err) {
      setTextError(err instanceof Error ? err.message : String(err));
      setTextContent(null);
    } finally {
      setTextLoading(false);
    }
  }, [resolvedUrl, isMarkdown, isCodeOrText, baseMtime]);

  useEffect(() => {
    if (isMarkdown || isCodeOrText) {
      void loadTextContent();
      setIsEditing(false);
      setSaveStatus("idle");
      setSaveErrorMsg(null);
    }
  }, [resolvedUrl, isMarkdown, isCodeOrText, loadTextContent]);

  // Handle Save
  const handleSave = async () => {
    if (!root || path === undefined) return;
    setSaveStatus("saving");
    setSaveErrorMsg(null);
    try {
      const result = await writeFileContent({
        root,
        path,
        content: draftContent,
        baseMtime,
      });
      setTextContent(draftContent);
      setBaseMtime(result.mtime);
      setSaveStatus("saved");
      onSave?.(draftContent, result.mtime);
      setTimeout(() => {
        setSaveStatus("idle");
      }, 2500);
    } catch (err) {
      if (err instanceof FileConflictError) {
        setSaveStatus("conflict");
        setSaveErrorMsg(
          err.message || "File changed on disk since load. Reload to avoid clobbering.",
        );
      } else {
        setSaveStatus("error");
        setSaveErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
  };

  // Keyboard shortcut: Ctrl/Cmd + S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        if (isEditing && isEditable) {
          e.preventDefault();
          void handleSave();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const handleCopyRaw = async () => {
    const textToCopy = isEditing ? draftContent : (textContent ?? "");
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedRaw(true);
      setTimeout(() => setCopiedRaw(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleCopyPath = async () => {
    const pathToCopy = vpsPath || (root && path ? `/${root}/${path}` : name);
    try {
      await navigator.clipboard.writeText(pathToCopy);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // ignore
    }
  };

  // Image zoom & pan handlers
  const handleZoom = (delta: number) => {
    setZoomLevel((prev) => Math.min(5, Math.max(0.2, Number((prev + delta).toFixed(2)))));
  };

  const handleResetZoom = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoomLevel <= 1) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    setPanOffset({
      x: e.clientX - panStartRef.current.x,
      y: e.clientY - panStartRef.current.y,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsPanning(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // Video controls
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      void videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = Number(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
      setCurrentTime(targetTime);
    }
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  const togglePiP = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch {
      // PiP not supported or blocked
    }
  };

  const toggleFullscreen = () => {
    if (!videoRef.current) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void videoRef.current.requestFullscreen();
    }
  };

  // Compute file icon
  const iconName = useMemo(() => {
    if (isMarkdown) return "article";
    if (isCodeOrText) return "code";
    if (isImage) return "image";
    if (isVideo) return "movie";
    if (isAudio) return "audiotrack";
    if (isPdf) return "picture_as_pdf";
    return "description";
  }, [isMarkdown, isCodeOrText, isImage, isVideo, isAudio, isPdf]);

  const isDirty = isEditing && draftContent !== textContent;

  return (
    <div className="media-doc-viewer">
      {/* ── Header Bar ── */}
      <div className="mdv-header">
        <div className="mdv-header-left">
          <span className="ms mdv-file-icon">{iconName}</span>
          <span className="mono mdv-file-name" title={name}>
            {name}
          </span>
          {fileExt && (
            <span className="mono mdv-chip mdv-chip-accent">
              {fileExt.toUpperCase().replace(".", "")}
            </span>
          )}
          {size !== undefined && size > 0 && (
            <span className="mono mdv-chip">{formatBytes(size)}</span>
          )}
          {mtime && (
            <span className="mono mdv-chip">{formatTimestamp(mtime)}</span>
          )}
          {imgDimensions && (
            <span className="mono mdv-chip">
              {imgDimensions.width} × {imgDimensions.height} px
            </span>
          )}
          {isDirty && (
            <span className="mono mdv-chip mdv-chip-warn">● Unsaved edits</span>
          )}
          {saveStatus === "saved" && (
            <span className="mono mdv-chip mdv-chip-ok">✓ Saved</span>
          )}
          {saveStatus === "conflict" && (
            <span className="mono mdv-chip mdv-chip-danger">⚠ Conflict</span>
          )}
        </div>

        <div className="mdv-header-actions">
          {/* Markdown & Code actions */}
          {(isMarkdown || isCodeOrText) && (
            <>
              <button
                type="button"
                onClick={() => setWordWrap((w) => !w)}
                className={`mono mdv-btn ${wordWrap ? "mdv-btn-active" : ""}`}
                title="Toggle Word Wrap"
              >
                <span className="ms" style={{ fontSize: 13 }}>
                  wrap_text
                </span>
                wrap
              </button>

              <button
                type="button"
                onClick={() => void handleCopyRaw()}
                className="mono mdv-btn"
                title="Copy Raw Content"
              >
                <span className="ms" style={{ fontSize: 13 }}>
                  {copiedRaw ? "done" : "content_copy"}
                </span>
                {copiedRaw ? "copied ✓" : "copy raw"}
              </button>

              {isEditable && (
                <button
                  type="button"
                  onClick={() => setIsEditing((e) => !e)}
                  className={`mono mdv-btn ${isEditing ? "mdv-btn-primary" : ""}`}
                  title={isEditing ? "View formatted output" : "Edit document"}
                >
                  <span className="ms" style={{ fontSize: 13 }}>
                    {isEditing ? "visibility" : "edit"}
                  </span>
                  {isEditing ? "view" : "edit"}
                </button>
              )}

              {isEditing && (
                <button
                  type="button"
                  disabled={!isDirty || saveStatus === "saving"}
                  onClick={() => void handleSave()}
                  className="mono mdv-btn mdv-btn-primary"
                  title="Save (Ctrl+S / Cmd+S)"
                >
                  <span className="ms" style={{ fontSize: 13 }}>
                    save
                  </span>
                  {saveStatus === "saving" ? "saving…" : "save"}
                </button>
              )}
            </>
          )}

          {/* Copy VPS Path */}
          <button
            type="button"
            onClick={() => void handleCopyPath()}
            className="mono mdv-btn"
            title="Copy Absolute VPS Path"
          >
            <span className="ms" style={{ fontSize: 13 }}>
              {copiedPath ? "done" : "terminal"}
            </span>
            {copiedPath ? "copied ✓" : "copy path"}
          </button>

          {/* Download button */}
          {resolvedUrl && (
            <a
              href={resolvedUrl}
              download={name}
              className="mono mdv-btn"
              title="Download File"
            >
              <span className="ms" style={{ fontSize: 13 }}>
                download
              </span>
              download
            </a>
          )}

          {/* Close button if provided */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="mono mdv-btn"
              title="Close Preview"
            >
              <span className="ms" style={{ fontSize: 13 }}>
                close
              </span>
            </button>
          )}
        </div>
      </div>

      {/* ── Error Banner for Conflicts or Save Errors ── */}
      {saveErrorMsg && (
        <div
          className="mono"
          style={{
            padding: "8px 14px",
            fontSize: 11,
            background: tokens.dangerActionBg,
            borderBottom: `1px solid ${tokens.dangerActionBorder}`,
            color: tokens.bleed,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{saveErrorMsg}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {saveStatus === "conflict" && (
              <button
                type="button"
                onClick={() => void loadTextContent()}
                className="mono mdv-btn"
                style={{ fontSize: 10.5, borderColor: tokens.dangerActionBorder }}
              >
                reload from disk
              </button>
            )}
            <button
              type="button"
              onClick={() => setSaveErrorMsg(null)}
              className="mono mdv-btn"
              style={{ fontSize: 10.5 }}
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── Viewport Content ── */}
      <div className="mdv-viewport">
        {/* Markdown View / Edit */}
        {isMarkdown && (
          <>
            {textLoading && (
              <div
                className="mono"
                style={{ padding: 24, fontSize: 11.5, color: tokens.textFaint }}
              >
                loading markdown…
              </div>
            )}
            {textError && (
              <div
                className="mono"
                style={{ padding: 24, fontSize: 11.5, color: tokens.bleed }}
              >
                failed to load: {textError}
              </div>
            )}
            {!textLoading && !textError && (
              <>
                {isEditing ? (
                  <div className="mdv-markdown-edit">
                    <textarea
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      spellCheck={false}
                      className="mdv-textarea"
                      placeholder="Type markdown content…"
                    />
                    <div className="mdv-editor-status mono">
                      <span style={{ color: tokens.textFaint }}>
                        {draftContent.length} chars · {draftContent.split("\n").length} lines
                      </span>
                      <span style={{ color: tokens.textGhost }}>
                        Save with Ctrl+S / Cmd+S · Atomic conflict-guarded
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="mdv-markdown-view">
                    <MessageMarkdown source={textContent ?? ""} />
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* Code & Plain Text Viewer */}
        {isCodeOrText && !isMarkdown && (
          <>
            {textLoading && (
              <div
                className="mono"
                style={{ padding: 24, fontSize: 11.5, color: tokens.textFaint }}
              >
                loading file…
              </div>
            )}
            {textError && (
              <div
                className="mono"
                style={{ padding: 24, fontSize: 11.5, color: tokens.bleed }}
              >
                failed to load: {textError}
              </div>
            )}
            {!textLoading && !textError && (
              <>
                {isEditing ? (
                  <div className="mdv-markdown-edit">
                    <textarea
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      spellCheck={false}
                      className="mdv-textarea"
                    />
                    <div className="mdv-editor-status mono">
                      <span style={{ color: tokens.textFaint }}>
                        {draftContent.length} chars · {draftContent.split("\n").length} lines
                      </span>
                      <span style={{ color: tokens.textGhost }}>
                        Save with Ctrl+S / Cmd+S · Atomic conflict-guarded
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="mdv-code-container">
                    <div className="mdv-line-numbers">
                      {(textContent ?? "").split("\n").map((_, i) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <div key={i}>{i + 1}</div>
                      ))}
                    </div>
                    <pre
                      className="mdv-code-content"
                      style={{
                        whiteSpace: wordWrap ? "pre-wrap" : "pre",
                        wordBreak: wordWrap ? "break-word" : "normal",
                      }}
                    >
                      {textContent ?? ""}
                    </pre>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* Image Preview with Zoom & Pan */}
        {isImage && (
          <div
            className="mdv-image-viewport"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={resolvedUrl}
              alt={name}
              className="mdv-image-img"
              style={{
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
              }}
              onLoad={(e) => {
                const img = e.currentTarget;
                setImgDimensions({ width: img.naturalWidth, height: img.naturalHeight });
              }}
              draggable={false}
            />

            {/* Floating Zoom Bar */}
            <div className="mdv-zoom-bar">
              <button
                type="button"
                onClick={() => handleZoom(-0.25)}
                className="mono mdv-btn"
                title="Zoom Out"
              >
                <span className="ms" style={{ fontSize: 13 }}>
                  zoom_out
                </span>
              </button>
              <span
                className="mono"
                style={{ fontSize: 11, minWidth: 42, textAlign: "center", color: tokens.textHi }}
              >
                {Math.round(zoomLevel * 100)}%
              </span>
              <button
                type="button"
                onClick={() => handleZoom(0.25)}
                className="mono mdv-btn"
                title="Zoom In"
              >
                <span className="ms" style={{ fontSize: 13 }}>
                  zoom_in
                </span>
              </button>
              <button
                type="button"
                onClick={handleResetZoom}
                className="mono mdv-btn"
                title="Reset Zoom (100%)"
              >
                1:1
              </button>
            </div>
          </div>
        )}

        {/* Video Player */}
        {isVideo && (
          <div className="mdv-video-container">
            <video
              ref={videoRef}
              src={resolvedUrl}
              preload="metadata"
              className="mdv-video-element"
              onClick={togglePlay}
              onTimeUpdate={() => {
                if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
              }}
              onLoadedMetadata={() => {
                if (videoRef.current) setDuration(videoRef.current.duration);
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />

            {/* Custom Range-seek Video Controls */}
            <div className="mdv-video-controls">
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={handleSeek}
                className="mdv-video-scrubber"
                title="Seek"
              />

              <div className="mdv-video-control-row">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="mdv-video-btn"
                    title={isPlaying ? "Pause" : "Play"}
                  >
                    <span className="ms" style={{ fontSize: 20 }}>
                      {isPlaying ? "pause" : "play_arrow"}
                    </span>
                  </button>

                  <span className="mono" style={{ fontSize: 11, color: "#ccc" }}>
                    {formatSeconds(currentTime)} / {formatSeconds(duration)}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.muted = !isMuted;
                        setIsMuted(!isMuted);
                      }
                    }}
                    className="mdv-video-btn"
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    <span className="ms" style={{ fontSize: 18 }}>
                      {isMuted ? "volume_off" : "volume_up"}
                    </span>
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {/* Playback speed selector */}
                  {[0.75, 1, 1.25, 1.5, 2].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => handleSpeedChange(s)}
                      className="mono"
                      style={{
                        fontSize: 10,
                        padding: "2px 5px",
                        borderRadius: 3,
                        background: playbackSpeed === s ? tokens.accent : "rgba(255,255,255,0.1)",
                        color: playbackSpeed === s ? "#000" : "#fff",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {s}x
                    </button>
                  ))}

                  <button
                    type="button"
                    onClick={() => void togglePiP()}
                    className="mdv-video-btn"
                    title="Picture in Picture"
                  >
                    <span className="ms" style={{ fontSize: 18 }}>
                      picture_in_picture_alt
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="mdv-video-btn"
                    title="Fullscreen"
                  >
                    <span className="ms" style={{ fontSize: 18 }}>
                      fullscreen
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audio Player */}
        {isAudio && (
          <div className="mdv-audio-container">
            <div className="mdv-audio-disc">
              <span className="ms" style={{ fontSize: 36 }}>
                audiotrack
              </span>
            </div>
            <div className="mono" style={{ fontSize: 13, color: tokens.textHi }}>
              {name}
            </div>
            <audio controls src={resolvedUrl} className="mdv-audio-element" />
          </div>
        )}

        {/* PDF Viewer */}
        {isPdf && (
          <iframe
            src={resolvedUrl}
            title={name}
            className="mdv-pdf-frame"
          />
        )}

        {/* Fallback for unsupported / binary formats */}
        {!isMarkdown && !isCodeOrText && !isImage && !isVideo && !isAudio && !isPdf && (
          <div className="mdv-fallback-container">
            <div className="mdv-fallback-icon">
              <span className="ms">draft</span>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
                {name}
              </div>
              <div className="mono" style={{ fontSize: 11, color: tokens.textMuted, marginTop: 4 }}>
                {formatBytes(size)} {fileExt ? `· ${fileExt.toUpperCase()} file` : ""}
              </div>
            </div>
            <p className="mono" style={{ fontSize: 11, color: tokens.textFaint, maxWidth: 360 }}>
              No direct browser preview available for this file type. You can download it or copy the VPS path to inspect via terminal.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              {resolvedUrl && (
                <a
                  href={resolvedUrl}
                  download={name}
                  className="mono mdv-btn mdv-btn-primary"
                  style={{ padding: "6px 14px", fontSize: 11.5 }}
                >
                  <span className="ms" style={{ fontSize: 14 }}>
                    download
                  </span>
                  Download {name}
                </a>
              )}
              <button
                type="button"
                onClick={() => void handleCopyPath()}
                className="mono mdv-btn"
                style={{ padding: "6px 14px", fontSize: 11.5 }}
              >
                <span className="ms" style={{ fontSize: 14 }}>
                  {copiedPath ? "done" : "terminal"}
                </span>
                {copiedPath ? "Copied ✓" : "Copy VPS Path"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
