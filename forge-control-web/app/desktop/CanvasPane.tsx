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
 *   - a poller notices external writes; clean panes hot-reload, dirty panes
 *     surface a banner instead of silently losing either side
 *
 * Excalidraw is imported dynamically with ssr:false — it touches window at
 * module scope and would break Next's server render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { tokens } from "../tokens";
import { VPS_FILE_DRAG_MIME } from "./chat/FileExplorerPanel";
import {
  listCanvases,
  getCanvas,
  saveCanvas,
  createCanvas,
  CanvasConflictError,
  type CanvasListItem,
} from "../api";
import "@excalidraw/excalidraw/index.css";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
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
const POLL_MS = 4000;

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

  // Watch for writes from Obsidian / the agent / another tab.
  useEffect(() => {
    if (!path) return;
    const t = setInterval(async () => {
      if (dirty.current || conflict) return; // never stomp unsaved work
      try {
        const r = await listCanvases();
        const hit = r.items.find((i) => i.path === path);
        if (hit && baseMtime.current && Math.abs(hit.mtime - baseMtime.current) > 1) {
          await load(path, api); // clean pane → adopt their version silently
        }
      } catch {
        /* transient — the next tick retries */
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [path, api, conflict, load]);

  // "Open the scraper map" — the agent parks an intent server-side and the
  // pane acts on it, so Konrad never has to go find the file himself. Only
  // newer sequence numbers act, so re-polling the same intent doesn't yank the
  // view; unsaved work is never interrupted.
  const lastIntentSeq = useRef<number>(0);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/proxy/canvas/intent", {
          headers: { accept: "application/json" },
        });
        if (!r.ok) return;
        const { intent } = (await r.json()) as {
          intent: { seq: number; path: string } | null;
        };
        if (!intent) return;
        // First poll of a session adopts the current seq without acting, so a
        // still-live intent from earlier doesn't hijack the pane on mount.
        if (lastIntentSeq.current === 0) {
          lastIntentSeq.current = intent.seq;
          return;
        }
        if (intent.seq <= lastIntentSeq.current) return;
        lastIntentSeq.current = intent.seq;
        if (dirty.current) return; // don't interrupt unsaved drawing
        if (intent.path !== path) onPathChange(intent.path);
      } catch {
        /* transient */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [path, onPathChange]);

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
            color: "#ffd8a8",
            background: "#5c3a0033",
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
            color: "#ffa8a8",
            background: "#5c000033",
            flexShrink: 0,
          }}
        >
          {err}
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
            theme="dark"
          />
        ) : null}
      </div>
    </div>
  );
}
