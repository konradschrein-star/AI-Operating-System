"use client";

/**
 * BrowserShots.tsx — "which UI did you actually look at?", rendered. Round 1350 & Round 1 (Browser Stream Viewer).
 *
 * Three surfaces, one visual grammar:
 *   `BrowserShots`          the transcript block, under the tool row that took or
 *                           opened the shots (AssistantThread.tsx).
 *   `RunShotsIndicator`     the camera indicator on a panel row (TeamRow.tsx,
 *                           live/AgentActivity.tsx).
 *   `ShotStrip`             the thumbnail strip both of them expand into.
 *   `FullscreenShotViewer`  fullscreen modal viewer with manual noVNC takeover.
 *
 * ── LIVE BLUE FLOWING OUTLINE & RED MODE ───────────────────────────────────
 * When a stream is actively producing shots or a browser session is running,
 * components display a live flowing blue outline/sheen (tokens.accent / tokens.decide).
 * When Konrad's action is required (exit code 4 login wall, captcha, or stuck signal),
 * components switch to Red Mode (tokens.bleed / tokens.dangerActionBorder) with
 * clear diagnostics on WHY and WHAT TO DO.
 * Both animations strictly honor @media (prefers-reduced-motion: reduce) with
 * static solid outline/glow fallbacks and zero layout shift.
 *
 * ── WHY NO IMAGE COMES FROM MARKDOWN ──────────────────────────────────────
 * `rehype-forge-allowlist.ts` renders every markdown image as inert text, and
 * that is a closed beacon hole, not an oversight — read its header. Nothing
 * here weakens it. Every `src` on this page is built by `shotSrc()` from a
 * 12-hex directory id and a filename that were both validated against fixed
 * character classes (browser-shots.ts), so the only thing an agent's output
 * can choose is WHICH file under /opt/ai-os/uploads/<12hex>/ is shown — and
 * every one of those was written by this machine. If you are here to "fix"
 * images in the allowlist: don't. This component is the sanctioned path.
 *
 * ── HOVER IS NOT AN INTERACTION HERE (NFU2, DoD #3) ───────────────────────
 * Hover performance is a gate on this project, so nothing in this file mounts,
 * measures or fetches on pointer-enter. There is no `onMouseEnter`, no hover
 * state and no tooltip component anywhere below; the strips open on CLICK, and
 * the only hover affordance is the browser's own native `title`. An
 * indicator's `<img>` tags do not exist in the DOM until its strip is opened,
 * and `/api/uploads/:id/shots` is not requested until then either.
 *
 * ── ONE POLL, NOT ONE PER ROW ─────────────────────────────────────────────
 * `useShotIndex` is a single react-query key (`["uploads-index"]`) with a 30s
 * `refetchInterval`. Every indicator on the page subscribes to that ONE query:
 * react-query dedupes by key, so N rows produce one HTTP request per 30s, not
 * N. Structural sharing (on by default in v5) returns the identical object when
 * the payload has not changed, so a tick that finds no new screenshots
 * re-renders nothing at all.
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
  newestFirst,
  resolveStreamMode,
  resolveStreamWarning,
  shotClock,
  shotSrc,
  shotsNoun,
  stampToIso,
  uploadsDirId,
  vncProxyUrl,
  type BrowserShotRef,
  type BrowserStateSummary,
  type StreamMode,
} from "./browser-shots";
import { BrowserStreamViewer, FullscreenShotViewer } from "./BrowserStreamViewer";


/** The glyph. One camera, both surfaces, so the transcript block and the panel
 *  indicator read as the same fact seen twice. */
const CAMERA = "📷";

/* ── Stream animation styles (Pure tokens, zero raw colour, reduced motion) ── */

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

/* ── The strip ────────────────────────────────────────────────────────────── */

/** What a thumbnail needs. Satisfied by a `BrowserShotRef` from the transcript
 *  and by a `/api/uploads/:id/shots` row alike, which is why both surfaces can
 *  share one strip component. */
export interface ShotLike {
  dirId: string;
  name: string;
  label: string;
  /** ISO-8601 UTC, or null when the filename carries no stamp. */
  ts: string | null;
}

const THUMB_W = 148;
const THUMB_H = 84;

const THUMB_FRAME: CSSProperties = {
  width: THUMB_W,
  flex: "none",
  border: `1px solid ${tokens.borderDivider}`,
  borderRadius: 6,
  overflow: "hidden",
  background: tokens.bgGutter,
  textDecoration: "none",
  display: "block",
  cursor: "pointer",
  position: "relative",
};

/**
 * The thumbnail row. Horizontally scrollable rather than wrapping: this thing
 * renders inside a 260px side panel as well as a full-width transcript, and a
 * wrapping grid in the panel would push the rows below it down by a variable
 * amount every time one opened.
 */
export function ShotStrip({
  shots,
  mode = "idle",
  onSelectShot,
}: {
  shots: readonly ShotLike[];
  mode?: StreamMode;
  onSelectShot?: (index: number) => void;
}) {
  if (shots.length === 0) {
    return (
      <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, padding: "6px 10px" }}>
        no image files in this run&apos;s upload directory
      </div>
    );
  }

  const frameBorder =
    mode === "needs_human"
      ? `1px solid ${tokens.dangerActionBorder}`
      : mode === "live"
        ? `1px solid ${tokens.accent}`
        : `1px solid ${tokens.borderDivider}`;

  return (
    <div
      data-shot-strip
      className="scroll-tinted"
      style={{
        display: "flex",
        gap: 8,
        padding: "8px 10px",
        overflowX: "auto",
        alignItems: "flex-start",
      }}
    >
      {shots.map((s, idx) => {
        const src = shotSrc(s.dirId, s.name);
        if (src === null) {
          /* A name that fails validation is REPORTED, not hidden: silently
             dropping it would make a missing screenshot look like a screenshot
             that was never taken. */
          return (
            <div
              key={`${s.dirId}/${s.name}`}
              className="mono"
              style={{ ...THUMB_FRAME, padding: 6, fontSize: 9, color: tokens.warn }}
            >
              unservable filename — {s.name.slice(0, 60)}
            </div>
          );
        }
        const clock = shotClock(s.ts);
        return (
          <a
            key={`${s.dirId}/${s.name}`}
            href={src}
            title={`${s.label}${clock ? ` · ${clock} UTC` : ""} — click for fullscreen viewer`}
            style={{ ...THUMB_FRAME, border: frameBorder }}
            onClick={(e) => {
              e.stopPropagation();
              if (onSelectShot) {
                e.preventDefault();
                onSelectShot(idx);
              }
            }}
          >
            {/* `loading="lazy"` on top of the mount gate: the strip may hold a
                dozen shots and only the first few are on screen. */}
            <img
              src={src}
              alt={s.label}
              loading="lazy"
              decoding="async"
              width={THUMB_W}
              height={THUMB_H}
              style={{
                display: "block",
                width: THUMB_W,
                height: THUMB_H,
                objectFit: "cover",
                objectPosition: "top left",
                background: tokens.bgCard,
              }}
            />
            {/* Label and time are a flex ROW, not one text flow */}
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 4,
                fontSize: 9,
                color: tokens.textMuted2,
                padding: "3px 5px",
                borderTop: `1px solid ${tokens.borderDivider}`,
                background: tokens.bgCard,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.label}
              </span>
              {clock && (
                <span style={{ flex: "none", color: tokens.textGhost }}>{clock.slice(0, 5)}</span>
              )}
            </div>
          </a>
        );
      })}
    </div>
  );
}

/* ── Fullscreen Viewer Modal ──────────────────────────────────────────────── */

export {
  BrowserStreamViewer,
  FullscreenShotViewer,
  type BrowserStreamViewerProps,
} from "./BrowserStreamViewer";


/* ── The transcript block ─────────────────────────────────────────────────── */

/**
 * Collapsed: one line — camera, count, newest label. Expanded: the strip.
 *
 * Deliberately shaped like `ToolCallRow` (AssistantThread.tsx:373): same
 * border radius, same left tone rule, same ▸/▾ affordance, same monospace
 * 10.5px header. It sits directly under the tool row it came from and must
 * read as part of that row's story, not as a new kind of card.
 */
export function BrowserShots({
  refs,
  isLive,
  needsHuman,
  signal,
  reason,
}: {
  refs: readonly BrowserShotRef[];
  isLive?: boolean;
  needsHuman?: boolean;
  signal?: string | null;
  reason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);

  const ordered = useMemo(() => newestFirst(refs), [refs]);
  const dirId = ordered[0]?.dirId ?? null;

  const index = useShotIndex();
  const runInfo = dirId ? index.get(dirId) : undefined;

  const browserState: BrowserStateSummary | null = useMemo(() => {
    if (runInfo?.browser_state) return runInfo.browser_state;
    return {
      is_live: isLive ?? runInfo?.is_live,
      needs_human: needsHuman ?? runInfo?.needs_human,
      signal: signal ?? runInfo?.signal,
      reason,
    };
  }, [runInfo, isLive, needsHuman, signal, reason]);

  const mode = useMemo(() => {
    if (needsHuman === true) return "needs_human";
    if (isLive === true) return "live";
    return resolveStreamMode(browserState, ordered);
  }, [needsHuman, isLive, browserState, ordered]);

  const warning = useMemo(
    () => (mode === "needs_human" ? resolveStreamWarning(browserState, ordered) : null),
    [mode, browserState, ordered],
  );

  if (ordered.length === 0) return null;
  const newest = ordered[0];
  const noun = shotsNoun(ordered);

  const leftBorderColor =
    mode === "needs_human"
      ? tokens.bleed
      : mode === "live"
        ? tokens.accent
        : tokens.decide;

  const containerClass =
    mode === "needs_human"
      ? "fg-stream-red"
      : mode === "live"
        ? "fg-stream-live"
        : "";

  return (
    <>
      <StreamStyles />
      <div
        data-browser-shots={ordered.length}
        data-stream-mode={mode}
        className={containerClass}
        style={{
          border: `1px solid ${open ? tokens.borderDivider : "transparent"}`,
          borderLeft: `2px solid ${leftBorderColor}`,
          borderRadius: 8,
          background: open ? tokens.toolBg : "transparent",
          overflow: "hidden",
          transition: "box-shadow 0.2s ease",
        }}
      >
        <div
          onClick={() => setOpen((v) => !v)}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            cursor: "pointer",
            fontSize: 10.5,
            userSelect: "none",
          }}
        >
          <span style={{ flex: "none" }} aria-hidden>
            {CAMERA}
          </span>
          <span style={{ flex: "none", color: tokens.textLabel, fontWeight: 600 }}>
            {ordered.length} {noun}
          </span>

          {/* Mode Badges */}
          {mode === "needs_human" && (
            <span
              className="mono"
              style={{
                flex: "none",
                fontSize: 9,
                fontWeight: 700,
                color: tokens.bleed,
                background: tokens.dangerActionBg,
                padding: "1px 5px",
                borderRadius: 3,
                border: `1px solid ${tokens.dangerActionBorder}`,
              }}
            >
              ⚠️ NEEDS KONRAD
            </span>
          )}
          {mode === "live" && (
            <span
              className="mono"
              style={{
                flex: "none",
                fontSize: 9,
                fontWeight: 700,
                color: tokens.accent,
                background: tokens.primaryActionBg,
                padding: "1px 5px",
                borderRadius: 3,
                border: `1px solid ${tokens.accent}`,
              }}
            >
              ● LIVE
            </span>
          )}

          <span
            style={{
              color: mode === "needs_human" ? tokens.bleed : tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {warning ? `${warning.title} — ${warning.detail}` : newest.label}
            {!warning && shotClock(newest.ts) ? ` · ${shotClock(newest.ts)}` : ""}
          </span>
          <span style={{ flex: "none", color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
        </div>

        {/* Expanded View */}
        {open && (
          <div style={{ borderTop: `1px solid ${tokens.borderDivider}` }}>
            {mode === "needs_human" && warning && (
              <div
                className="mono"
                style={{
                  padding: "6px 10px",
                  background: tokens.dangerActionBg,
                  borderBottom: `1px solid ${tokens.dangerActionBorder}`,
                  color: tokens.bleed,
                  fontSize: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span>
                  <strong>{warning.title}:</strong> {warning.detail} ({warning.action})
                </span>
                {dirId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFullscreenIndex(0);
                    }}
                    style={{
                      padding: "2px 6px",
                      borderRadius: 3,
                      fontSize: 9.5,
                      background: tokens.bleed,
                      color: tokens.onAccent,
                      border: "none",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Take Control
                  </button>
                )}
              </div>
            )}
            <ShotStrip
              shots={ordered}
              mode={mode}
              onSelectShot={(idx) => setFullscreenIndex(idx)}
            />
          </div>
        )}
      </div>

      {fullscreenIndex !== null && dirId && (
        <FullscreenShotViewer
          shots={ordered}
          initialIndex={fullscreenIndex}
          dirId={dirId}
          mode={mode}
          state={browserState}
          onClose={() => setFullscreenIndex(null)}
        />
      )}
    </>
  );
}

/* ── The panel indicator ──────────────────────────────────────────────────── */

/**
 * Local fetchers rather than app/api.ts entries: these two GETs exist for this
 * component and nothing else, and the typed client is not the place for a
 * private read. Same `/api/proxy` rewrite every other call uses
 * (next.config.mjs).
 */
const PROXY_ROOT = "/api/proxy";

export interface UploadsIndexRun {
  id: string;
  count: number;
  image_count?: number;
  artifact_count?: number;
  file_count?: number;
  latest_ts: string | null;
  is_live?: boolean;
  needs_human?: boolean;
  signal?: string | null;
  browser_state?: BrowserStateSummary | null;
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

/* THE CONDITIONAL REQUEST IS MADE EXPLICITLY, not left to the HTTP cache.
 *
 * The server side of this is correct and was verified end to end: the origin
 * emits an ETag, honours `If-None-Match` in both strong and weak form, and the
 * Route Handler now carries both directions through (the old next.config
 * rewrite did not, which is why this endpoint cost 121 KB/min).
 *
 * The browser still never used it. Measured in a real page, three consecutive
 * fetches of this exact URL:
 *
 *   req 1: If-None-Match=(NOT SENT) -> HTTP 200  etag=W/"a37..."  enc=gzip
 *   req 2: If-None-Match=(NOT SENT) -> HTTP 200  etag=W/"a37..."  enc=gzip
 *   req 3: If-None-Match=(NOT SENT) -> HTTP 200  etag=W/"a37..."  enc=gzip
 *
 * `fetch()` leaves revalidation to the HTTP cache, and whether the cache
 * revalidates depends on heuristics, the `Vary` set Next attaches, and the
 * profile's cache state. A saving that only materialises when a heuristic
 * happens to agree is not a saving you can measure or rely on.
 *
 * So we hold the last ETag and send it ourselves. Then the 304 is a property
 * of OUR code, observable in any browser and in any harness, rather than a
 * hope about someone's cache. On 304 there is no body to parse — return the
 * rows we already have.
 *
 * Module-scope, not a ref: every mount of every indicator shares one poll of
 * one URL, so they should share one validator too. */
let uploadsIndexEtag: string | null = null;
let uploadsIndexCache: UploadsIndexRun[] = [];

async function fetchUploadsIndex(): Promise<UploadsIndexRun[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (uploadsIndexEtag) headers["if-none-match"] = uploadsIndexEtag;

  const res = await fetch(`${PROXY_ROOT}/uploads/index`, { headers });

  if (res.status === 304) return uploadsIndexCache;

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on /uploads/index`);
  }
  const body = (await res.json()) as { runs?: UploadsIndexRun[] };
  if (!Array.isArray(body.runs)) {
    throw new Error("/uploads/index returned no `runs` array");
  }
  // Only remember the validator once the payload it describes parsed cleanly —
  // caching an ETag for a body we rejected would answer every later 304 with
  // rows we never accepted.
  uploadsIndexEtag = res.headers.get("etag");
  uploadsIndexCache = body.runs;
  return body.runs;
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

/** 30s, as briefed. One key, therefore one poll for the whole page. The
 *  number itself lives in ./pollBudget with the surface's other polls, so the
 *  budget check can add up the real ones. */
import { SHOTS_INDEX_POLL_MS as INDEX_POLL_MS } from "./pollBudget";

/**
 * The shared index: `12-hex dir id → run summary with count & live/stuck signals`.
 *
 * A Map rather than the raw array so a row's lookup is O(1) — the panel can
 * hold ~40 rows and the index ~40 runs, and the quadratic version of that is a
 * scan per row per render on the surface whose hover cost is a project gate.
 */
export function useShotIndex(): ReadonlyMap<string, UploadsIndexRun> {
  const q = useQuery({
    queryKey: ["uploads-index"],
    queryFn: fetchUploadsIndex,
    refetchInterval: INDEX_POLL_MS,
    staleTime: INDEX_POLL_MS,
  });
  return useMemo(() => {
    const m = new Map<string, UploadsIndexRun>();
    for (const r of q.data ?? []) m.set(r.id, r);
    return m;
  }, [q.data]);
}

/**
 * The camera on a panel row. Renders NOTHING — no glyph, no reserved box —
 * for a run with no screenshots, which is most of them.
 *
 * `runId` is the run's UUID; sub-agent rows must pass `null`, because a
 * sub-agent's node id is a `tool_use_id` and shares no directory (its
 * screenshots, if any, land in its PARENT's run directory — the sub-agent
 * inherits `FORGE_RUN_ID` from the process it lives in).
 */
export function RunShotsIndicator({
  runId,
  paddingLeft = 8,
  isLive,
  needsHuman,
  signal,
  reason,
}: {
  runId: string | null;
  /** Aligns the indicator with the row's text column. Rows differ in indent. */
  paddingLeft?: number;
  isLive?: boolean;
  needsHuman?: boolean;
  signal?: string | null;
  reason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);

  const index = useShotIndex();
  const dirId = uploadsDirId(runId);
  const runInfo = dirId === null ? undefined : index.get(dirId);
  const count = runInfo?.count;

  /* Not fetched until the strip is open — the index already told us the count,
   * which is all the collapsed row claims. */
  const shotsQ = useQuery({
    queryKey: ["uploads-shots", dirId],
    queryFn: () => fetchRunShots(dirId as string),
    enabled: open && dirId !== null,
    staleTime: INDEX_POLL_MS,
  });

  if (dirId === null || count === undefined || count === 0) return null;

  const browserState: BrowserStateSummary | null =
    shotsQ.data?.browser_state ??
    runInfo?.browser_state ?? {
      is_live: isLive ?? runInfo?.is_live,
      needs_human: needsHuman ?? runInfo?.needs_human,
      signal: signal ?? runInfo?.signal,
      reason,
    };

  const mode =
    needsHuman === true
      ? "needs_human"
      : isLive === true
        ? "live"
        : resolveStreamMode(browserState);

  const warning = mode === "needs_human" ? resolveStreamWarning(browserState) : null;

  const shots: ShotLike[] = (shotsQ.data?.shots ?? []).map((s) => ({
    dirId,
    name: s.name,
    label: s.label ?? s.name,
    ts: stampToIso(s.ts) ?? s.mtime,
  }));

  const buttonClass =
    mode === "needs_human"
      ? "fg-stream-red"
      : mode === "live"
        ? "fg-stream-live"
        : "";

  const buttonBg =
    mode === "needs_human"
      ? tokens.dangerActionBg
      : mode === "live"
        ? tokens.primaryActionBg
        : "transparent";

  const buttonBorder =
    mode === "needs_human"
      ? `1px solid ${tokens.dangerActionBorder}`
      : mode === "live"
        ? `1px solid ${tokens.accent}`
        : "none";

  const buttonColor =
    mode === "needs_human"
      ? tokens.bleed
      : mode === "live"
        ? tokens.accent
        : tokens.textMuted2;

  const titlePrefix =
    mode === "needs_human"
      ? `[Needs Konrad: ${warning?.detail ?? "Action required"}] `
      : mode === "live"
        ? "[Live Stream] "
        : "";

  return (
    <>
      <StreamStyles />
      <div data-run-shots={dirId} data-stream-mode={mode} style={{ paddingLeft }}>
        <button
          type="button"
          data-run-shots-toggle
          title={`${titlePrefix}${count} image${count === 1 ? "" : "s"} under /opt/ai-os/uploads/${dirId} — click to ${open ? "hide" : "show"}`}
          onClick={(e) => {
            /* The row itself drills into the run on click. This button is a
               different verb and must not trigger it. */
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={`mono ${buttonClass}`}
          style={{
            background: buttonBg,
            border: buttonBorder,
            borderRadius: 4,
            padding: "0 4px",
            margin: 0,
            fontFamily: "inherit",
            fontSize: 9.5,
            lineHeight: 1.6,
            height: 18,
            color: buttonColor,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            transition: "box-shadow 0.2s ease",
          }}
        >
          <span aria-hidden>{mode === "needs_human" ? "⚠️" : CAMERA}</span>
          <span>{count}</span>
          {mode === "needs_human" && (
            <span style={{ fontWeight: 700, fontSize: 8.5 }}>NEEDS KONRAD</span>
          )}
          {mode === "live" && (
            <span style={{ fontWeight: 700, fontSize: 8.5 }}>LIVE</span>
          )}
          <span style={{ color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              border: `1px solid ${mode === "needs_human" ? tokens.dangerActionBorder : mode === "live" ? tokens.accent : tokens.borderDivider}`,
              borderRadius: 6,
              background: tokens.toolBg,
              marginTop: 3,
              overflow: "hidden",
            }}
          >
            {/* Header bar with Fullscreen trigger */}
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "4px 8px",
                borderBottom: `1px solid ${tokens.borderDivider}`,
                background: tokens.bgCard,
                fontSize: 9,
              }}
            >
              <span style={{ color: tokens.textMuted2 }}>
                {mode === "needs_human" ? (
                  <strong style={{ color: tokens.bleed }}>⚠️ Action required</strong>
                ) : mode === "live" ? (
                  <strong style={{ color: tokens.accent }}>● Live Browser Stream</strong>
                ) : (
                  "Browser Shots"
                )}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFullscreenIndex(0);
                }}
                style={{
                  background: "transparent",
                  border: `1px solid ${tokens.borderDivider}`,
                  borderRadius: 3,
                  padding: "1px 5px",
                  fontSize: 9,
                  color: tokens.textSoft,
                  cursor: "pointer",
                }}
              >
                ⤢ Fullscreen
              </button>
            </div>

            {/* Red Mode Warning Header */}
            {mode === "needs_human" && warning && (
              <div
                className="mono"
                style={{
                  padding: "4px 8px",
                  background: tokens.dangerActionBg,
                  borderBottom: `1px solid ${tokens.dangerActionBorder}`,
                  color: tokens.bleed,
                  fontSize: 9.5,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span>{warning.detail}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFullscreenIndex(0);
                  }}
                  style={{
                    padding: "1px 5px",
                    borderRadius: 3,
                    fontSize: 8.5,
                    background: tokens.bleed,
                    color: tokens.onAccent,
                    border: "none",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Take Control
                </button>
              </div>
            )}

            {shotsQ.isError ? (
              <div className="mono" style={{ fontSize: 9.5, color: tokens.bleed, padding: "6px 8px" }}>
                could not load shots — {String(shotsQ.error)}
              </div>
            ) : shotsQ.isPending ? (
              <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, padding: "6px 8px" }}>
                loading {count} image{count === 1 ? "" : "s"}…
              </div>
            ) : (
              <ShotStrip
                shots={shots}
                mode={mode}
                onSelectShot={(idx) => setFullscreenIndex(idx)}
              />
            )}
          </div>
        )}
      </div>

      {fullscreenIndex !== null && dirId && (
        <FullscreenShotViewer
          shots={shots}
          initialIndex={fullscreenIndex}
          dirId={dirId}
          mode={mode}
          state={browserState}
          onClose={() => setFullscreenIndex(null)}
        />
      )}
    </>
  );
}

