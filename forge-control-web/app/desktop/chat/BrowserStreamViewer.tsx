"use client";

/**
 * BrowserStreamViewer.tsx — accessible fullscreen modal viewer with manual noVNC takeover.
 *
 * Requirements:
 * 1. Accessible fullscreen modal dialog: role="dialog", aria-modal="true",
 *    aria-label, focus trap & restoration on unmount, Escape listener, explicit close button.
 * 2. Navigation: ArrowLeft/ArrowRight keyboard navigation, previous/next buttons, filmstrip scrubber.
 * 3. Red Mode diagnostics: clear banner explaining WHY (e.g. login wall / stuck signal)
 *    and WHAT TO DO (manual takeover affordance).
 * 4. Manual Mode takeover: embedded authenticated loopback proxy noVNC session.
 * 5. Polling budget: 5_000ms refetchInterval (SHOTS_FULLSCREEN_POLL_MS) active ONLY while
 *    modal is open, 0 when closed.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  resolveStreamMode,
  resolveStreamWarning,
  shotClock,
  shotSrc,
  stampToIso,
  vncProxyUrl,
  type BrowserShotRef,
  type BrowserStateSummary,
  type StreamMode,
} from "./browser-shots";
import { SHOTS_FULLSCREEN_POLL_MS } from "./pollBudget";

const CAMERA = "📷";
const PROXY_ROOT = "/api/proxy";

export interface ShotLike {
  dirId: string;
  name: string;
  label: string;
  /** ISO-8601 UTC, or null when the filename carries no stamp. */
  ts: string | null;
}

export interface UploadsShot {
  name: string;
  url: string;
  label: string | null;
  ts: string | null;
  size: number;
  mtime: string;
  kind?: string;
}

export interface UploadsShotResponse {
  id: string;
  count: number;
  image_count: number;
  shots: UploadsShot[];
  browser_state?: BrowserStateSummary | null;
}

async function fetchRunShots(dirId: string): Promise<UploadsShotResponse> {
  const res = await fetch(`${PROXY_ROOT}/uploads/${dirId}/shots`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on /uploads/${dirId}/shots`);
  }
  const body = (await res.json()) as UploadsShotResponse;
  if (!Array.isArray(body.shots)) {
    throw new Error(`/uploads/${dirId}/shots returned no \`shots\` array`);
  }
  return body;
}

export function StreamStyles() {
  return (
    <style>{`
      @keyframes fg-stream-flow-blue {
        0% {
          box-shadow: 0 0 0 1px var(--fg-accent), 0 0 8px rgba(var(--fg-accent-rgb), 0.25);
        }
        50% {
          box-shadow: 0 0 0 1.5px var(--fg-decide), 0 0 14px rgba(var(--fg-accent-rgb), 0.55);
        }
        100% {
          box-shadow: 0 0 0 1px var(--fg-accent), 0 0 8px rgba(var(--fg-accent-rgb), 0.25);
        }
      }

      @keyframes fg-stream-pulse-red {
        0% {
          box-shadow: 0 0 0 1px var(--fg-bleed), 0 0 6px var(--fg-dangerActionBorder);
        }
        50% {
          box-shadow: 0 0 0 2px var(--fg-bleed), 0 0 14px var(--fg-dangerActionBorder);
        }
        100% {
          box-shadow: 0 0 0 1px var(--fg-bleed), 0 0 6px var(--fg-dangerActionBorder);
        }
      }

      @keyframes fg-badge-pulse {
        0%, 100% {
          opacity: 1;
          transform: scale(1);
        }
        50% {
          opacity: 0.55;
          transform: scale(0.92);
        }
      }

      .fg-stream-live {
        animation: fg-stream-flow-blue 3s ease-in-out infinite;
      }

      .fg-stream-red {
        animation: fg-stream-pulse-red 2s ease-in-out infinite;
      }

      .fg-pulse-badge {
        animation: fg-badge-pulse 2s ease-in-out infinite;
      }

      @media (prefers-reduced-motion: reduce) {
        .fg-stream-live,
        .fg-stream-red,
        .fg-pulse-badge {
          animation: none !important;
        }
        .fg-stream-live {
          box-shadow: 0 0 0 1.5px var(--fg-accent) !important;
        }
        .fg-stream-red {
          box-shadow: 0 0 0 1.5px var(--fg-bleed) !important;
        }
      }
    `}</style>
  );
}

export interface BrowserStreamViewerProps {
  shots: readonly ShotLike[];
  initialIndex?: number;
  dirId: string;
  mode?: StreamMode;
  state?: BrowserStateSummary | null;
  isOpen?: boolean;
  onClose: () => void;
}

export function BrowserStreamViewer({
  shots,
  initialIndex = 0,
  dirId,
  mode = "idle",
  state,
  isOpen = true,
  onClose,
}: BrowserStreamViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(
    Math.max(0, Math.min(initialIndex, Math.max(0, shots.length - 1))),
  );
  const [viewMode, setViewMode] = useState<"screenshot" | "manual">("screenshot");
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Live polling while fullscreen modal is open (budgeted at SHOTS_FULLSCREEN_POLL_MS = 5_000)
  const shotsQ = useQuery({
    queryKey: ["uploads-shots-fullscreen", dirId],
    queryFn: () => fetchRunShots(dirId),
    refetchInterval: isOpen ? SHOTS_FULLSCREEN_POLL_MS : false,
    staleTime: SHOTS_FULLSCREEN_POLL_MS,
    enabled: isOpen && Boolean(dirId),
  });

  const liveShots: ShotLike[] = useMemo(() => {
    if (shotsQ.data?.shots && shotsQ.data.shots.length > 0) {
      return shotsQ.data.shots.map((s) => ({
        dirId,
        name: s.name,
        label: s.label ?? s.name,
        ts: stampToIso(s.ts) ?? s.mtime,
      }));
    }
    return shots as ShotLike[];
  }, [shotsQ.data?.shots, dirId, shots]);

  const effectiveState: BrowserStateSummary | null = useMemo(() => {
    return shotsQ.data?.browser_state ?? state ?? null;
  }, [shotsQ.data?.browser_state, state]);

  const effectiveMode: StreamMode = useMemo(() => {
    if (mode === "needs_human" || effectiveState?.needs_human) return "needs_human";
    if (mode === "live" || effectiveState?.is_live) return "live";
    return resolveStreamMode(effectiveState, liveShots);
  }, [mode, effectiveState, liveShots]);

  const warning = useMemo(
    () => (effectiveMode === "needs_human" ? resolveStreamWarning(effectiveState, liveShots) : null),
    [effectiveMode, effectiveState, liveShots],
  );

  const safeIndex = Math.max(0, Math.min(currentIndex, Math.max(0, liveShots.length - 1)));
  const currentShot = liveShots[safeIndex] ?? liveShots[0];

  // Focus trap and keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    modalRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.stopPropagation();
        e.preventDefault();
        setCurrentIndex((i) => (i > 0 ? i - 1 : liveShots.length - 1));
      } else if (e.key === "ArrowRight") {
        e.stopPropagation();
        e.preventDefault();
        setCurrentIndex((i) => (i < liveShots.length - 1 ? i + 1 : 0));
      } else if (e.key === "Tab") {
        // Focus trap within modal dialog
        if (!modalRef.current) return;
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen, liveShots.length, onClose]);

  if (!isOpen) return null;

  const currentSrc = currentShot ? shotSrc(currentShot.dirId, currentShot.name) : null;
  const vncUrl = vncProxyUrl(dirId);

  return (
    <div
      ref={modalRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Browser Stream Fullscreen Viewer"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: tokens.bgBody,
        display: "flex",
        flexDirection: "column",
        outline: "none",
      }}
    >
      <StreamStyles />

      {/* Top Header Bar */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgTabBar,
          gap: 12,
          flex: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 13 }} aria-hidden>
            {CAMERA}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi }}>
            {dirId}
          </span>
          {liveShots.length > 0 && (
            <span style={{ fontSize: 10.5, color: tokens.textMuted2 }}>
              Shot {safeIndex + 1} of {liveShots.length}
            </span>
          )}
          {currentShot && (
            <span
              style={{
                fontSize: 10.5,
                color: tokens.textLabel,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {currentShot.label}
              {shotClock(currentShot.ts) ? ` · ${shotClock(currentShot.ts)} UTC` : ""}
            </span>
          )}
        </div>

        {/* Center / Status Indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {effectiveMode === "needs_human" ? (
            <div
              className="fg-stream-red mono"
              style={{
                padding: "3px 8px",
                borderRadius: 4,
                background: tokens.dangerActionBg,
                color: tokens.bleed,
                fontSize: 10,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span className="fg-pulse-badge" aria-hidden>
                🔴
              </span>
              <span>NEEDS KONRAD{warning?.service ? `: ${warning.service.toUpperCase()}` : ""}</span>
            </div>
          ) : effectiveMode === "live" ? (
            <div
              className="fg-stream-live mono"
              style={{
                padding: "3px 8px",
                borderRadius: 4,
                background: tokens.primaryActionBg,
                color: tokens.accent,
                fontSize: 10,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span className="fg-pulse-badge" aria-hidden>
                ●
              </span>
              <span>LIVE STREAM</span>
            </div>
          ) : (
            <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
              ARCHIVED STILLS
            </span>
          )}
        </div>

        {/* Right Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            data-toggle-manual-mode
            onClick={() => setViewMode((m) => (m === "screenshot" ? "manual" : "screenshot"))}
            className="mono"
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 10.5,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${viewMode === "manual" ? tokens.accent : tokens.border}`,
              background: viewMode === "manual" ? tokens.primaryActionBg : tokens.bgCard,
              color: viewMode === "manual" ? tokens.accent : tokens.textSoft,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{viewMode === "manual" ? "📷 Stills View" : "🎮 Take Control (Manual Mode)"}</span>
          </button>

          {currentSrc && (
            <a
              href={currentSrc}
              target="_blank"
              rel="noreferrer noopener"
              className="mono"
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                fontSize: 10.5,
                textDecoration: "none",
                background: tokens.bgCard,
                color: tokens.textMuted2,
                border: `1px solid ${tokens.border}`,
              }}
              title="Open raw image in new tab"
            >
              ↗ Raw
            </a>
          )}

          <button
            type="button"
            data-close-fullscreen
            onClick={onClose}
            className="mono"
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              background: tokens.bgCard,
              color: tokens.textHi,
              border: `1px solid ${tokens.borderDivider}`,
            }}
            title="Close (ESC)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Red Mode Diagnostic Banner in Fullscreen */}
      {effectiveMode === "needs_human" && warning && (
        <div
          data-stream-diagnostic-banner
          className="mono"
          style={{
            padding: "8px 16px",
            background: tokens.dangerActionBg,
            borderBottom: `1px solid ${tokens.dangerActionBorder}`,
            color: tokens.bleed,
            fontSize: 11,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flex: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13 }} aria-hidden>
              ⚠️
            </span>
            <span style={{ fontWeight: 700 }}>{warning.title}:</span>
            <span style={{ color: tokens.textSoft, overflow: "hidden", textOverflow: "ellipsis" }}>
              {warning.detail}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
            <span style={{ fontSize: 10, color: tokens.textMuted }}>{warning.action}</span>
            {viewMode !== "manual" && (
              <button
                type="button"
                onClick={() => setViewMode("manual")}
                style={{
                  padding: "3px 8px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 600,
                  background: tokens.bleed,
                  color: tokens.onAccent,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Take Control Now
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Content Stage */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: tokens.bgBody,
          overflow: "hidden",
        }}
      >
        {viewMode === "manual" ? (
          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
            <div
              className="mono"
              style={{
                padding: "4px 12px",
                background: tokens.bgTabBar,
                borderBottom: `1px solid ${tokens.borderDivider}`,
                fontSize: 10,
                color: tokens.textMuted2,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>
                Manual Browser Takeover &middot; Authenticated Loopback Proxy (127.0.0.1)
              </span>
              <span style={{ color: tokens.accent }}>Direct VNC Control Active</span>
            </div>
            {vncUrl ? (
              <iframe
                src={vncUrl}
                title="Live Browser Takeover"
                style={{
                  flex: 1,
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: tokens.bgBody,
                }}
              />
            ) : (
              <div
                className="mono"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: tokens.bleed,
                  fontSize: 12,
                }}
              >
                Could not construct authenticated proxy URL for run {dirId}
              </div>
            )}
          </div>
        ) : (
          <>
            {currentSrc ? (
              <img
                src={currentSrc}
                alt={currentShot?.label ?? "Browser stream fullscreen preview"}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <div className="mono" style={{ color: tokens.textFaint, fontSize: 12 }}>
                No screenshot selected
              </div>
            )}

            {/* Left / Right Nav Arrows */}
            {liveShots.length > 1 && (
              <>
                <button
                  type="button"
                  data-nav-prev-shot
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentIndex((i) => (i > 0 ? i - 1 : liveShots.length - 1));
                  }}
                  className="mono"
                  style={{
                    position: "absolute",
                    left: 16,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: tokens.overlay,
                    color: tokens.textHi,
                    border: `1px solid ${tokens.borderDivider}`,
                    cursor: "pointer",
                    fontSize: 18,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title="Previous Shot (Left Arrow)"
                >
                  ‹
                </button>
                <button
                  type="button"
                  data-nav-next-shot
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentIndex((i) => (i < liveShots.length - 1 ? i + 1 : 0));
                  }}
                  className="mono"
                  style={{
                    position: "absolute",
                    right: 16,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: tokens.overlay,
                    color: tokens.textHi,
                    border: `1px solid ${tokens.borderDivider}`,
                    cursor: "pointer",
                    fontSize: 18,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title="Next Shot (Right Arrow)"
                >
                  ›
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Bottom Thumbnail Scrubber */}
      {liveShots.length > 1 && viewMode === "screenshot" && (
        <div
          data-filmstrip-scrubber
          className="scroll-tinted"
          style={{
            display: "flex",
            gap: 8,
            padding: "8px 16px",
            borderTop: `1px solid ${tokens.borderDivider}`,
            background: tokens.bgTabBar,
            overflowX: "auto",
            flex: "none",
          }}
        >
          {liveShots.map((s, idx) => {
            const src = shotSrc(s.dirId, s.name);
            const isSelected = idx === safeIndex;
            return (
              <button
                key={`${s.dirId}/${s.name}`}
                type="button"
                data-scrubber-item={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentIndex(idx);
                }}
                style={{
                  width: 80,
                  height: 48,
                  flex: "none",
                  border: isSelected ? `2px solid ${tokens.accent}` : `1px solid ${tokens.borderDivider}`,
                  borderRadius: 4,
                  overflow: "hidden",
                  padding: 0,
                  background: tokens.bgCard,
                  cursor: "pointer",
                  opacity: isSelected ? 1 : 0.65,
                }}
                title={s.label}
              >
                {src && (
                  <img
                    src={src}
                    alt={s.label}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Alias export for FullscreenShotViewer */
export const FullscreenShotViewer = BrowserStreamViewer;
