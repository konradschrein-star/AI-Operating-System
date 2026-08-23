"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tokens } from "../../tokens";
import { GEMINI_ACCENT, isGeminiModel } from "../gemini-identity";
import { modelDisplay } from "../live/agentsApi";
import {
  contextBand,
  contextOccupancy,
  humanTokens,
  type ContextBand,
  type ContextOccupancy,
} from "./context-window";

export interface ChatContextPopoverProps {
  meta?: Record<string, unknown> | null;
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  side?: "top" | "bottom";
  disabled?: boolean;
}

const BAND_TOKEN: Record<ContextBand, string> = {
  calm: tokens.ok,
  noticed: tokens.info,
  warn: tokens.warn,
  danger: tokens.bleed,
};

const BAND_LABELS: Record<ContextBand, { label: string; hint: string }> = {
  calm: { label: "Calm", hint: "Plenty of context headroom" },
  noticed: { label: "Noticed", hint: "Context accumulating" },
  warn: { label: "Warning", hint: "Approaching capacity · consider /compact" },
  danger: { label: "Danger", hint: "Context nearly full · run /compact now" },
};

function extractUsage(meta?: Record<string, unknown> | null) {
  if (!meta) return null;
  const raw = (meta.usage_running ?? meta.usage_last_turn) as
    | Record<string, unknown>
    | undefined;
  if (!raw || typeof raw !== "object") return null;

  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

  const input = num(raw.input_tokens);
  const cacheRead = num(raw.cache_read_input_tokens);
  const cacheCreation = num(raw.cache_creation_input_tokens);
  const output = num(raw.output_tokens);

  if (input === 0 && cacheRead === 0 && cacheCreation === 0 && output === 0) {
    return null;
  }

  return { input, cacheRead, cacheCreation, output };
}

/** Fixed width, so the viewport clamp below is arithmetic and not a measure
 *  of a node that has not been laid out yet. */
const POPOVER_WIDTH = 270;
/** Rough height, used only to decide whether "bottom" would fall off screen. */
const POPOVER_HEIGHT_ESTIMATE = 150;
const VIEWPORT_MARGIN = 8;

interface PopoverPosition {
  top: number;
  left: number;
}

export function ChatContextPopover({
  meta,
  children,
  align = "left",
  side = "bottom",
  disabled = false,
}: ChatContextPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const occ: ContextOccupancy | null = contextOccupancy(meta);
  const usage = extractUsage(meta);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  /* The popover used to be `position: absolute` inside the row. The chat rail
   * is a scroll container, so it clipped the right-hand 40% of the card —
   * "Free: 331k (34%)", the cache-read figure and the headroom hint were all
   * cut off at the rail's edge. Measured in the round-4 DoD screenshot pass.
   * Fixed positioning in a portal is the only way out of an ancestor's
   * overflow; the trade is that the coordinates have to be measured, and
   * re-measured whenever anything scrolls under an open popover. */
  const measure = useCallback((): void => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();

    const rawLeft =
      align === "right"
        ? rect.right - POPOVER_WIDTH
        : align === "center"
          ? rect.left + rect.width / 2 - POPOVER_WIDTH / 2
          : rect.left;
    const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, maxLeft));

    // "bottom" means below the gauge, unless that would run off the foot of
    // the window — a popover the user cannot read is worse than a flipped one.
    const wantsTop =
      side === "top" ||
      rect.bottom + 6 + POPOVER_HEIGHT_ESTIMATE > window.innerHeight - VIEWPORT_MARGIN;
    const top = wantsTop ? rect.top - 6 - POPOVER_HEIGHT_ESTIMATE : rect.bottom + 6;

    setPosition({ top: Math.max(VIEWPORT_MARGIN, top), left });
  }, [align, side]);

  useEffect(() => {
    if (!isMounted) return;
    // `capture: true` — the rail scrolls, not the window, and a scroll event
    // on an inner element does not bubble.
    const onMove = () => measure();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [isMounted, measure]);

  const handleMouseEnter = () => {
    if (disabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    // Deliberate 450ms delay to prevent jitter during fast mouse traversal
    timerRef.current = setTimeout(() => {
      measure();
      setIsMounted(true);
      requestAnimationFrame(() => {
        setIsOpen(true);
      });
    }, 450);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsOpen(false);
    // 250ms CSS fade-out before unmounting DOM nodes
    timerRef.current = setTimeout(() => {
      setIsMounted(false);
    }, 250);
  };

  const band: ContextBand = occ ? contextBand(occ.fraction) : "calm";
  const gemini = occ ? isGeminiModel(occ.model) : false;
  const color =
    gemini && (band === "calm" || band === "noticed")
      ? GEMINI_ACCENT
      : BAND_TOKEN[band];

  const modelName = occ?.model ? modelDisplay(occ.model) : "unknown model";
  const windowTokens = occ ? humanTokens(occ.windowTokens) : "—";
  const usedTokens = occ ? humanTokens(occ.usedTokens) : "—";
  const pct = occ ? Math.round(occ.fraction * 100) : 0;
  const remainingTokens = occ
    ? humanTokens(Math.max(0, occ.windowTokens - occ.usedTokens))
    : "—";
  const remainingPct = Math.max(0, 100 - pct);

  const card = isMounted && position && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="mono"
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            transform: isOpen ? "translateY(0)" : "translateY(3px)",
            zIndex: 1200,
            width: POPOVER_WIDTH,
            padding: "10px 12px",
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderEmphasis}`,
            borderRadius: 7,
            boxShadow: `0 8px 24px ${tokens.shadowSoft}`,
            opacity: isOpen ? 1 : 0,
            transition:
              "opacity 250ms cubic-bezier(0.16, 1, 0.3, 1), transform 250ms cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: isOpen ? "auto" : "none",
            userSelect: "none",
          }}
        >
          {/* Header: Model & Context Window */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              borderBottom: `1px solid ${tokens.borderSoft}`,
              paddingBottom: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: color,
                  display: "inline-block",
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: tokens.text,
                  letterSpacing: "0.02em",
                }}
              >
                {modelName}
              </span>
            </div>
            <span
              style={{
                fontSize: 10,
                color: tokens.textFaint,
              }}
            >
              {windowTokens} max{occ?.assumedWindow ? " (assumed)" : ""}
            </span>
          </div>

          {occ ? (
            <>
              {/* Progress meter */}
              <div style={{ marginBottom: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 10,
                    color: tokens.textMuted,
                    marginBottom: 4,
                  }}
                >
                  <span>
                    Used: <strong style={{ color }}>{usedTokens}</strong> ({pct}%)
                  </span>
                  <span>
                    Free: <strong>{remainingTokens}</strong> ({remainingPct}%)
                  </span>
                </div>
                <div
                  style={{
                    width: "100%",
                    height: 5,
                    borderRadius: 3,
                    background: tokens.borderEmphasis,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.max(0, occ.fraction * 100))}%`,
                      height: "100%",
                      background: color,
                      transition: "width 200ms ease",
                    }}
                  />
                </div>
              </div>

              {/* Token breakdown */}
              {usage && (
                <div
                  style={{
                    background: tokens.bgGutter,
                    borderRadius: 5,
                    padding: "6px 8px",
                    marginBottom: 8,
                    fontSize: 9.5,
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "4px 8px",
                    border: `1px solid ${tokens.borderSoft}`,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: tokens.textFaint }}>Input:</span>
                    <span style={{ color: tokens.text }}>{humanTokens(usage.input)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: tokens.textFaint }}>Cache read:</span>
                    <span style={{ color: tokens.text }}>{humanTokens(usage.cacheRead)}</span>
                  </div>
                  {usage.cacheCreation > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: tokens.textFaint }}>Cache write:</span>
                      <span style={{ color: tokens.text }}>{humanTokens(usage.cacheCreation)}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: tokens.textFaint }}>Output:</span>
                    <span style={{ color: tokens.text }}>{humanTokens(usage.output)}</span>
                  </div>
                </div>
              )}

              {/* Headroom status */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 9.5,
                  paddingTop: 2,
                }}
              >
                <span
                  style={{
                    color,
                    fontWeight: 500,
                  }}
                >
                  {BAND_LABELS[band].label}
                </span>
                <span
                  style={{
                    color: tokens.textFaint,
                    textAlign: "right",
                  }}
                >
                  {BAND_LABELS[band].hint}
                </span>
              </div>
            </>
          ) : (
            <div
              style={{
                fontSize: 10,
                color: tokens.textFaint,
                padding: "8px 0",
                textAlign: "center",
              }}
            >
              Token usage not recorded yet for this chat.
            </div>
          )}
        </div>
  );

  return (
    <span
      ref={anchorRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
    >
      {children}
      {/* Portalled to <body>: see `measure` for why absolute positioning
       *  inside the rail could not work. `document` is guaranteed here —
       *  `card` is only truthy after a mouseenter, which never runs on the
       *  server. */}
      {card ? createPortal(card, document.body) : null}
    </span>
  );
}
