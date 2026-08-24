"use client";

/**
 * BrowserShots.tsx — "which UI did you actually look at?", rendered. Round 1350.
 *
 * Three surfaces, one visual grammar:
 *   `BrowserShots`        the transcript block, under the tool row that took or
 *                         opened the shots (AssistantThread.tsx).
 *   `RunShotsIndicator`   the camera indicator on a panel row (TeamRow.tsx,
 *                         live/AgentActivity.tsx).
 *   `ShotStrip`           the thumbnail strip both of them expand into.
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

import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  newestFirst,
  shotClock,
  shotSrc,
  shotsNoun,
  stampToIso,
  uploadsDirId,
  type BrowserShotRef,
} from "./browser-shots";

/** The glyph. One camera, both surfaces, so the transcript block and the panel
 *  indicator read as the same fact seen twice. */
const CAMERA = "📷";

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
};

/**
 * The thumbnail row. Horizontally scrollable rather than wrapping: this thing
 * renders inside a 260px side panel as well as a full-width transcript, and a
 * wrapping grid in the panel would push the rows below it down by a variable
 * amount every time one opened.
 */
export function ShotStrip({ shots }: { shots: readonly ShotLike[] }) {
  if (shots.length === 0) {
    return (
      <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, padding: "6px 10px" }}>
        no image files in this run&apos;s upload directory
      </div>
    );
  }
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
      {shots.map((s) => {
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
            target="_blank"
            rel="noreferrer noopener"
            title={`${s.label}${clock ? ` · ${clock} UTC` : ""} — open full size`}
            style={THUMB_FRAME}
            onClick={(e) => e.stopPropagation()}
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
            {/* Label and time are a flex ROW, not one text flow: the label is
                the part that may be arbitrarily long, so it is the part that
                ellipses. A time that gets truncated away is the one thing this
                caption may not do — "which shot is this, and when" is the whole
                question the strip answers. */}
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

/* ── The transcript block ─────────────────────────────────────────────────── */

/**
 * Collapsed: one line — camera, count, newest label. Expanded: the strip.
 *
 * Deliberately shaped like `ToolCallRow` (AssistantThread.tsx:373): same
 * border radius, same left tone rule, same ▸/▾ affordance, same monospace
 * 10.5px header. It sits directly under the tool row it came from and must
 * read as part of that row's story, not as a new kind of card.
 */
export function BrowserShots({ refs }: { refs: readonly BrowserShotRef[] }) {
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => newestFirst(refs), [refs]);
  if (ordered.length === 0) return null;
  const newest = ordered[0];
  const noun = shotsNoun(ordered);

  return (
    <div
      data-browser-shots={ordered.length}
      style={{
        border: `1px solid ${open ? tokens.borderDivider : "transparent"}`,
        borderLeft: `2px solid ${tokens.decide}`,
        borderRadius: 8,
        background: open ? tokens.toolBg : "transparent",
        overflow: "hidden",
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
        <span
          style={{
            color: tokens.textMuted2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {newest.label}
          {shotClock(newest.ts) ? ` · ${shotClock(newest.ts)}` : ""}
        </span>
        <span style={{ flex: "none", color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
      </div>
      {/* The `<img>` tags do not exist until this branch renders. */}
      {open && (
        <div style={{ borderTop: `1px solid ${tokens.borderDivider}` }}>
          <ShotStrip shots={ordered} />
        </div>
      )}
    </div>
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

interface UploadsIndexRun {
  id: string;
  count: number;
  latest_ts: string | null;
}

interface UploadsShot {
  name: string;
  url: string;
  label: string | null;
  ts: string | null;
  size: number;
  mtime: string;
}

async function fetchUploadsIndex(): Promise<UploadsIndexRun[]> {
  const res = await fetch(`${PROXY_ROOT}/uploads/index`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on /uploads/index`);
  }
  const body = (await res.json()) as { runs?: UploadsIndexRun[] };
  if (!Array.isArray(body.runs)) {
    throw new Error("/uploads/index returned no `runs` array");
  }
  return body.runs;
}

async function fetchRunShots(dirId: string): Promise<UploadsShot[]> {
  const res = await fetch(`${PROXY_ROOT}/uploads/${dirId}/shots`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on /uploads/${dirId}/shots`);
  }
  const body = (await res.json()) as { shots?: UploadsShot[] };
  if (!Array.isArray(body.shots)) {
    throw new Error(`/uploads/${dirId}/shots returned no \`shots\` array`);
  }
  return body.shots;
}

/** 30s, as briefed. One key, therefore one poll for the whole page. The
 *  number itself lives in ./pollBudget with the surface's other polls, so the
 *  budget check can add up the real ones. */
import { SHOTS_INDEX_POLL_MS as INDEX_POLL_MS } from "./pollBudget";

/**
 * The shared index: `12-hex dir id → how many images it holds`.
 *
 * A Map rather than the raw array so a row's lookup is O(1) — the panel can
 * hold ~40 rows and the index ~40 runs, and the quadratic version of that is a
 * scan per row per render on the surface whose hover cost is a project gate.
 */
export function useShotIndex(): ReadonlyMap<string, number> {
  const q = useQuery({
    queryKey: ["uploads-index"],
    queryFn: fetchUploadsIndex,
    refetchInterval: INDEX_POLL_MS,
    staleTime: INDEX_POLL_MS,
  });
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const r of q.data ?? []) m.set(r.id, r.count);
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
}: {
  runId: string | null;
  /** Aligns the indicator with the row's text column. Rows differ in indent. */
  paddingLeft?: number;
}) {
  const [open, setOpen] = useState(false);
  const index = useShotIndex();
  const dirId = uploadsDirId(runId);
  const count = dirId === null ? undefined : index.get(dirId);

  /* Not fetched until the strip is open — the index already told us the count,
   * which is all the collapsed row claims. */
  const shotsQ = useQuery({
    queryKey: ["uploads-shots", dirId],
    queryFn: () => fetchRunShots(dirId as string),
    enabled: open && dirId !== null,
    staleTime: INDEX_POLL_MS,
  });

  if (dirId === null || count === undefined || count === 0) return null;

  const shots: ShotLike[] = (shotsQ.data ?? []).map((s) => ({
    dirId,
    name: s.name,
    label: s.label ?? s.name,
    /* The server sends the convention's compact stamp; `mtime` is the fallback
     * for a file whose name carries none. */
    ts: stampToIso(s.ts) ?? s.mtime,
  }));

  return (
    <div data-run-shots={dirId} style={{ paddingLeft }}>
      <button
        type="button"
        data-run-shots-toggle
        title={`${count} image${count === 1 ? "" : "s"} under /opt/ai-os/uploads/${dirId} — click to ${open ? "hide" : "show"}`}
        onClick={(e) => {
          /* The row itself drills into the run on click. This button is a
             different verb and must not trigger it. */
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="mono"
        style={{
          background: "transparent",
          border: "none",
          padding: "0 2px",
          margin: 0,
          fontFamily: "inherit",
          fontSize: 9.5,
          lineHeight: 1.6,
          color: tokens.textMuted2,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span aria-hidden>{CAMERA}</span>
        <span>{count}</span>
        <span style={{ color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            border: `1px solid ${tokens.borderDivider}`,
            borderRadius: 6,
            background: tokens.toolBg,
            marginTop: 3,
          }}
        >
          {shotsQ.isError ? (
            <div className="mono" style={{ fontSize: 9.5, color: tokens.bleed, padding: "6px 8px" }}>
              could not load shots — {String(shotsQ.error)}
            </div>
          ) : shotsQ.isPending ? (
            <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, padding: "6px 8px" }}>
              loading {count} image{count === 1 ? "" : "s"}…
            </div>
          ) : (
            <ShotStrip shots={shots} />
          )}
        </div>
      )}
    </div>
  );
}
