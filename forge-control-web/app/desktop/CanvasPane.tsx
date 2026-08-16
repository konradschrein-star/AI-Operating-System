"use client";

/**
 * CanvasPane — a real Excalidraw editor inside the AI OS.
 *
 * The point is shared state with the agent: this edits the SAME
 * .excalidraw.md files in the Obsidian vault that the agent reads and writes,
 * and that sync to Konrad's devices via Syncthing. Draw here, it appears in
 * Obsidian; the agent adds a node while you talk, it appears here.
 *
 * Three writers means real concurrency, so this pane is deliberately paranoid:
 *   - saves are debounced and carry the mtime they loaded from (409 on clash)
 *   - a watcher notices external writes; clean panes hot-reload, dirty panes
 *     surface a banner instead of silently losing either side
 *
 * Freshness is a single O(1) `GET /canvas/stat` — the previous version called
 * /canvas/list every 4s, which walks the entire 145 MB vault and stats every
 * drawing in it, purely to read one file's mtime.
 *
 * Excalidraw is imported dynamically with ssr:false — it touches window at
 * module scope and would break Next's server render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { tokens } from "../tokens";
import { useThemeMode } from "../useThemeMode";
import { VPS_FILE_DRAG_MIME } from "./chat/FileExplorerPanel";
import {
  listCanvases,
  getCanvas,
  saveCanvas,
  createCanvas,
  CanvasConflictError,
  type CanvasListItem,
} from "../api";
import { statCanvas, subscribeCanvas } from "./canvasLive";
/**
 * ROUND 806 PUT THIS IMPORT BACK, ON MEASUREMENT. Round 803 moved it into
 * `./ExcalidrawEditor` so the 144,615-byte stylesheet would travel in the
 * editor's async chunk instead of on `/desktop`'s critical path. The bytes did
 * move — round 806 confirmed render-blocking CSS on /desktop dropping
 * 163,317 B → 18,702 B. **It bought nothing and it cost a lot.**
 *
 *   /desktop first-contentful-paint, canvas never opened
 *     loopback  412/408 ms  →  412/408 ms   identical to the millisecond
 *     9 Mbps / 170 ms RTT   568 ms → 568 ms   ZERO, n=6/6
 *   canvas cold open (click → editor on screen)
 *     loopback  768.5 ms → 1215.3 ms   **+447 ms**, n=6/6, distributions
 *               that do not overlap at all (before 753–793, after 1193–1291)
 *
 * FCP on this surface is not gated on this stylesheet — it is gated on the JS
 * bundle and the API round-trips, which take longer than 144 KB does to arrive
 * even on a throttled link. So the split removed a cost nobody was paying and
 * added one everybody who draws pays, on every first open.
 *
 * The operator's standing rule for this metric, honoured rather than argued
 * with: "If the CSS split turns out NOT to move (B) measurably, say so plainly
 * and drop it back down the list — I promoted it on reasoning, and your
 * measurement outranks my reasoning."
 *
 * Evidence: throttled-tradeoff.json, desktop-load-{before,after}-run{1,2}.json,
 * canvas-open-806-*.json, all in
 * docs/plan/artifacts/phase800/, written up in canvas-perf.md §8.
 */
import "@excalidraw/excalidraw/index.css";

/**
 * The editor bundle, started once per page and shared by both callers.
 *
 * `next/dynamic` only asks for its chunk when `<Excalidraw>` first RENDERS, and
 * this pane does not render it until `initial` exists — i.e. until
 * `GET /canvas/file` has come back. So 350 KB of download used to queue behind
 * a 550-byte JSON read that it does not depend on. Measured (round 801, six
 * cold opens across three scenarios, two runs): the first chunk request left
 * 1.9–2.5 ms after the scene fetch resolved, every single time.
 *
 * Giving the eager preload and `dynamic`'s loader the SAME promise is what
 * makes them overlap rather than race: whoever calls first starts the fetch,
 * the second awaits it. Memoised at module scope so it is one request per page
 * no matter how often the pane mounts or re-renders.
 *
 * Retry semantics are deliberately unchanged: a rejected promise stays cached
 * here, exactly as `React.lazy` already cached the rejected `import()` before
 * this indirection existed. This does not make a failed chunk load any less
 * recoverable than it was.
 *
 * This half of round 803's change SURVIVED round 806's measurement; the CSS
 * boundary above it did not. The two were independent and are judged
 * independently.
 */
type ExcalidrawModule = typeof import("@excalidraw/excalidraw");
let excalidrawModule: Promise<ExcalidrawModule> | null = null;
function loadExcalidraw(): Promise<ExcalidrawModule> {
  excalidrawModule ??= import("@excalidraw/excalidraw");
  return excalidrawModule;
}

const Excalidraw = dynamic(
  async () => (await loadExcalidraw()).Excalidraw,
  {
    ssr: false,
    loading: () => (
      <div
        className="mono"
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: tokens.textMuted,
          fontSize: 11,
        }}
      >
        loading canvas…
      </div>
    ),
  },
);

/** Only view-level appState belongs in the file. Everything else Excalidraw
 *  hands us is transient editor state (selection, cursors, pointers) and would
 *  churn the file on every mouse move. */
const PERSISTED_APPSTATE = [
  "viewBackgroundColor",
  "gridSize",
  "gridModeEnabled",
  "theme",
  "zenModeEnabled",
  "objectsSnapModeEnabled",
] as const;

function pickAppState(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PERSISTED_APPSTATE) if (k in s) out[k] = s[k];
  return out;
}

const SAVE_DEBOUNCE_MS = 1200;
/** Freshness poll while the event stream is down. 2s is affordable now that a
 *  check is one stat() instead of a recursive vault walk. */
const POLL_MS = 2000;
/** Freshness poll while SSE is live — a backstop for the case where fs.watch
 *  drops an event, not the primary mechanism. */
const POLL_MS_LIVE = 20_000;
/** Three consecutive stat failures means the pane has genuinely lost touch with
 *  the file — say so rather than letting Konrad draw on a stale scene. */
const POLL_FAIL_LIMIT = 3;

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return `${Math.round(diff / (7 * 86_400_000))}w ago`;
}

export function CanvasPane({
  path,
  onPathChange,
  onClose,
  showChrome = true,
}: {
  path: string | null;
  onPathChange: (p: string) => void;
  onClose?: () => void;
  showChrome?: boolean;
}) {
  // Excalidraw paints its own canvas and never sees `var(--fg-*)`, so unlike
  // every other colour in this file its theme has to be handed to it as a
  // value. Read live rather than at mount: the toggle flips the theme on an
  // open pane and the editor has to follow without remounting.
  const themeMode = useThemeMode();

  // Drop-target feedback: dragOver = a droppable drawing is hovering,
  // dropHint = we rejected something and are explaining why.
  const [dragOver, setDragOver] = useState(false);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [api, setApi] = useState<{
    updateScene: (s: Record<string, unknown>) => void;
    getSceneElements: () => readonly Record<string, unknown>[];
    getAppState: () => Record<string, unknown>;
    getFiles: () => Record<string, unknown>;
  } | null>(null);

  const [list, setList] = useState<CanvasListItem[]>([]);
  const [initial, setInitial] = useState<{
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  } | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [conflict, setConflict] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Set when the freshness watcher has failed repeatedly — a silent watcher is
  // worse than no watcher, because the pane looks live while it is blind.
  const [watchErr, setWatchErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const filteredList = useMemo(() => {
    const q = pickerQuery.toLowerCase();
    if (!q) return list;
    return list.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.folder.toLowerCase().includes(q),
    );
  }, [list, pickerQuery]);

  // mtime we loaded from — the optimistic-concurrency token.
  const baseMtime = useRef(0);
  // Set on local edits, cleared once persisted. Gates the hot-reload poller.
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every load so a slow in-flight load can't overwrite a newer one.
  const loadSeq = useRef(0);

  const refreshList = useCallback(() => {
    listCanvases()
      .then((r) => setList(r.items))
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  useEffect(refreshList, [refreshList]);

  /** Load a drawing into the editor, replacing whatever is there. */
  const load = useCallback(
    async (p: string, into: typeof api) => {
      const seq = ++loadSeq.current;
      try {
        const doc = await getCanvas(p);
        if (seq !== loadSeq.current) return; // superseded
        baseMtime.current = doc.mtime;
        dirty.current = false;
        setConflict(null);
        setErr(null);
        const scene = {
          elements: doc.elements,
          appState: pickAppState(doc.appState),
          files: doc.files,
        };
        if (into) into.updateScene(scene);
        else setInitial(scene);
      } catch (e) {
        if (seq === loadSeq.current) setErr(String((e as Error).message ?? e));
      }
    },
    [],
  );

  // Load whenever the selected drawing changes.
  useEffect(() => {
    if (!path) return;
    // A `path` is exactly the condition under which <Excalidraw> will mount
    // below, so this is the earliest honest moment to start its bundle — and
    // it starts here rather than after the await, so the download runs BESIDE
    // the scene read instead of behind it. Nothing about the bundle depends on
    // the scene. Not started when `path` is null: a pane with no drawing never
    // mounts the editor and must not pay 350 KB for one.
    //
    // No handler on the rejection: this is the same promise `dynamic` awaits,
    // so a chunk that fails to load still surfaces through the editor's own
    // render path. The catch exists only so one failure is not ALSO reported
    // as an unhandled rejection.
    void loadExcalidraw().catch(() => {});
    void load(path, api);
    // `api` intentionally omitted: when it arrives we push via initialData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, load]);

  const flush = useCallback(async () => {
    if (!path || !api || !dirty.current) return;
    setStatus("saving");
    try {
      const res = await saveCanvas({
        path,
        elements: api.getSceneElements() as Record<string, unknown>[],
        appState: pickAppState(api.getAppState()),
        files: api.getFiles(),
        baseMtime: baseMtime.current,
      });
      baseMtime.current = res.mtime;
      dirty.current = false;
      setStatus("saved");
    } catch (e) {
      if (e instanceof CanvasConflictError) {
        setConflict(e.message);
        setStatus("error");
      } else {
        setErr(String((e as Error).message ?? e));
        setStatus("error");
      }
    }
  }, [path, api]);

  const onChange = useCallback(() => {
    if (!path || !api) return;
    dirty.current = true;
    setStatus("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [path, api, flush]);

  // Adopt an external write (Obsidian / the agent / another tab). Only ever
  // called on a clean pane — a dirty pane must reach the 409 banner instead, so
  // neither side's work disappears.
  const adoptIfMoved = useCallback(
    async (mtime: number) => {
      if (!path) return;
      if (dirty.current || conflict) return; // never stomp unsaved work
      if (!baseMtime.current) return; // nothing loaded yet
      if (Math.abs(mtime - baseMtime.current) <= 1) return;
      await load(path, api);
    },
    [path, api, conflict, load],
  );

  // Handlers the event stream calls. Held in refs so the subscription's only
  // dependency is `path` — an EventSource that tears down and reconnects every
  // time a parent re-renders is worse than the polling it replaced.
  const adoptRef = useRef(adoptIfMoved);
  adoptRef.current = adoptIfMoved;
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;

  // Live push. An agent draw reaches the screen in ~1s: patch → fs.watch (300ms
  // debounce) → SSE `changed` → this reload. The stat poll below stays as a
  // backstop for filesystems where fs.watch drops events.
  const [sseLive, setSseLive] = useState(false);
  const lastIntentSeq = useRef(0);
  useEffect(() => {
    const applyIntent = (i: { seq: number; path: string }) => {
      // Only newer sequence numbers act, so a still-live intent from before
      // this connection can't yank the view, and a reconnect can't replay one.
      if (i.seq <= lastIntentSeq.current) return;
      lastIntentSeq.current = i.seq;
      if (dirty.current) return; // never interrupt unsaved drawing
      if (i.path !== path) onPathChangeRef.current(i.path);
    };

    const sub = subscribeCanvas(path, {
      onHello: (h) => {
        // First connection adopts the current seq without acting; later hellos
        // (reconnects) act, so an intent parked during an outage still lands.
        if (lastIntentSeq.current === 0) lastIntentSeq.current = h.intentSeq;
        else if (h.intent) applyIntent(h.intent);
      },
      onChanged: (c) => {
        if (c.path !== path) return;
        void adoptRef.current(c.mtime);
      },
      onIntent: applyIntent,
      onLive: setSseLive,
    });
    return () => sub.close();
  }, [path]);

  // Freshness fallback: one stat(). Fast while the stream is down, slow while
  // it is up. The old version called /canvas/list — a recursive walk of the
  // whole vault — every 4s, for the same one number.
  useEffect(() => {
    if (!path) return;
    let stopped = false;
    let failures = 0;
    const t = setInterval(
      async () => {
        if (stopped) return;
        if (dirty.current || conflict) return;
        try {
          const s = await statCanvas(path);
          failures = 0;
          setWatchErr(null);
          await adoptRef.current(s.mtime);
        } catch (e) {
          // A poller that swallows every error stops noticing external writes
          // and says nothing — that is how you lose a drawing. Speak up at 3.
          failures++;
          if (failures >= POLL_FAIL_LIMIT) {
            setWatchErr(
              `not tracking changes to this drawing (${String((e as Error).message ?? e)}) — reload before trusting what you see`,
            );
          }
        }
      },
      sseLive ? POLL_MS_LIVE : POLL_MS,
    );
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [path, conflict, sseLive]);

  // Persist on unmount so closing the pane never drops the last stroke.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void flush();
    },
    [flush],
  );

  const current = useMemo(
    () => list.find((i) => i.path === path) ?? null,
    [list, path],
  );

  const statusLabel =
    status === "saving"
      ? "saving…"
      : status === "saved"
        ? "saved"
        : status === "error"
          ? "unsaved"
          : dirty.current
            ? "editing"
            : "";

  // Drag a .excalidraw.md out of the file explorer and drop it here to open
  // it — hunting for a drawing in a flat dropdown doesn't scale past a dozen
  // files, but the explorer already has folders, search and preview.
  const onDrop = (e: React.DragEvent) => {
    setDragOver(false);
    const raw = e.dataTransfer.getData(VPS_FILE_DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const { root, rel } = JSON.parse(raw) as { root: string; rel: string };
      // Canvases are vault-relative by definition; a workspace file has no
      // drawing to open, so say so instead of failing silently.
      if (root !== "vault" || !rel.endsWith(".excalidraw.md")) {
        setDropHint("only .excalidraw.md files from the vault open here");
        setTimeout(() => setDropHint(null), 2600);
        return;
      }
      onPathChange(rel);
    } catch {
      /* malformed payload — ignore */
    }
  };

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(VPS_FILE_DRAG_MIME)) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the pane, not when it
        // crosses between children.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={onDrop}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
        borderLeft: showChrome ? `1px solid ${tokens.borderDivider}` : undefined,
        outline: dragOver ? `2px dashed ${tokens.accent}` : undefined,
        outlineOffset: -2,
      }}
    >
      {(dragOver || dropHint) && (
        <div
          className="mono"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 5,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
            background: tokens.overlay,
            color: dropHint ? tokens.warn : tokens.accent,
            fontSize: 12,
            textAlign: "center",
            padding: 20,
          }}
        >
          {dropHint ?? "drop a drawing to open it"}
        </div>
      )}
      {showChrome && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderBottom: `1px solid ${tokens.borderDivider}`,
            background: tokens.bgCard,
            flexShrink: 0,
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 10, color: tokens.accent, letterSpacing: "0.12em" }}
          >
            CANVAS
          </span>
          <button
            onClick={() => {
              setPicking((v) => !v);
              setPickerQuery("");
            }}
            className="mono"
            title="Switch drawing"
            style={{
              fontSize: 11,
              color: tokens.text,
              background: "transparent",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "3px 8px",
              cursor: "pointer",
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {current?.name ?? (path ? path : "pick a drawing")} ▾
          </button>
          {statusLabel && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: status === "error" ? tokens.bleed : tokens.textMuted,
              }}
            >
              {statusLabel}
            </span>
          )}
          {path && (
            <span
              className="mono"
              title={
                sseLive
                  ? "live: agent draws appear here as they happen"
                  : "event stream down — falling back to a 2s poll"
              }
              style={{
                fontSize: 9,
                letterSpacing: "0.1em",
                color: sseLive ? tokens.accent : tokens.textMuted,
                opacity: sseLive ? 0.9 : 0.5,
              }}
            >
              {sseLive ? "● LIVE" : "○ POLL"}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {path && (
            <a
              href={`/canvas?path=${encodeURIComponent(path)}`}
              target="_blank"
              rel="noreferrer"
              className="mono"
              title="Open in a separate tab (full width)"
              style={{
                fontSize: 10.5,
                color: tokens.textMuted,
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                padding: "3px 8px",
                textDecoration: "none",
              }}
            >
              open ↗
            </a>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="mono"
              title="Close canvas"
              style={{
                fontSize: 12,
                color: tokens.textMuted,
                background: "transparent",
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {picking && (
        <div
          style={{
            borderBottom: `1px solid ${tokens.borderDivider}`,
            background: tokens.bgCard,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              borderBottom: `1px solid ${tokens.borderDivider}`,
            }}
          >
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="search drawings…"
              className="mono"
              style={{
                flex: 1,
                fontSize: 11,
                background: "transparent",
                border: `1px solid ${tokens.border}`,
                borderRadius: 4,
                padding: "4px 8px",
                color: tokens.text,
                outline: "none",
              }}
            />
            <div
              onClick={async () => {
                const name = window.prompt("New drawing name");
                if (!name) return;
                try {
                  const r = await createCanvas({ name });
                  refreshList();
                  setPicking(false);
                  setPickerQuery("");
                  onPathChange(r.path);
                } catch (e) {
                  setErr(String((e as Error).message ?? e));
                }
              }}
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.accent,
                cursor: "pointer",
                whiteSpace: "nowrap",
                padding: "4px 6px",
              }}
            >
              + new
            </div>
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {filteredList.length === 0 && (
              <div
                className="mono"
                style={{
                  padding: "10px 12px",
                  fontSize: 11,
                  color: tokens.textMuted,
                }}
              >
                no matches
              </div>
            )}
            {filteredList.map((i) => (
              <div
                key={i.path}
                onClick={() => {
                  setPicking(false);
                  setPickerQuery("");
                  onPathChange(i.path);
                }}
                className="mono"
                style={{
                  padding: "6px 12px",
                  fontSize: 11,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  color: i.path === path ? tokens.accent : tokens.text,
                  background: i.path === path ? tokens.primaryActionBg : "transparent",
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {i.folder ? `${i.folder} / ${i.name}` : i.name}
                </span>
                <span style={{ color: tokens.textMuted, fontSize: 10, flexShrink: 0 }}>
                  {relTime(i.mtime)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {conflict && (
        <div
          className="mono"
          style={{
            padding: "8px 12px",
            fontSize: 10.5,
            // The warn family, not a literal. `#ffd8a8` on `#5c3a0033` measured
            // 1.13:1 in light mode — a save conflict announced itself to nobody.
            color: tokens.warn,
            background: tokens.freezeBgWarn,
            borderLeft: `3px solid ${tokens.warn}`,
            borderBottom: `1px solid ${tokens.borderDivider}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1 }}>{conflict}</span>
          <button
            onClick={() => path && load(path, api)}
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.accent,
              background: "transparent",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            reload theirs
          </button>
          <button
            onClick={async () => {
              // Deliberate override: drop the guard and win the race.
              baseMtime.current = 0;
              setConflict(null);
              await flush();
            }}
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.textMuted,
              background: "transparent",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            keep mine
          </button>
        </div>
      )}

      {err && (
        <div
          className="mono"
          style={{
            padding: "6px 12px",
            fontSize: 10.5,
            // `#ffa8a8` on `#5c000033` measured 1.12:1 in light mode.
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            borderLeft: `3px solid ${tokens.bleed}`,
            flexShrink: 0,
          }}
        >
          {err}
        </div>
      )}

      {watchErr && (
        <div
          className="mono"
          style={{
            padding: "6px 12px",
            fontSize: 10.5,
            // Same pair, same 1.13:1 — a dead freshness watcher, invisible.
            color: tokens.warn,
            background: tokens.freezeBgWarn,
            borderLeft: `3px solid ${tokens.warn}`,
            flexShrink: 0,
          }}
        >
          {watchErr}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {!path ? (
          <div
            className="mono"
            style={{
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: tokens.textMuted,
              fontSize: 11,
              textAlign: "center",
              padding: 20,
            }}
          >
            no drawing open — pick one above,
            <br />
            or ask the agent to draw something.
          </div>
        ) : initial ? (
          <Excalidraw
            excalidrawAPI={(a: unknown) => setApi(a as typeof api)}
            // Scene data crosses an untyped boundary (the vault file), so it
            // arrives as plain JSON. Excalidraw validates/normalises it on
            // load; asserting here is the honest place to bridge the two.
            initialData={initial as never}
            onChange={onChange}
            theme={themeMode}
          />
        ) : null}
      </div>
    </div>
  );
}
