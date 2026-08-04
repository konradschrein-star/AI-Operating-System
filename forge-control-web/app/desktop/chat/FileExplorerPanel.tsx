"use client";

/**
 * VPS file explorer panel — browse the Obsidian vault / agent workspace
 * directly in the desktop UI instead of only ever uploading fresh copies.
 * Read-only browsing + download + drag-to-chat + "attach to this chat"
 * button (which just registers the existing VPS path as an attachment, no
 * re-upload).
 *
 * Modeled as two virtual top-level folders over @cubone/react-file-manager's
 * single flat `files` array, populated lazily per-directory as the user
 * navigates (onFolderChange), since eagerly listing the whole vault tree up
 * front would be wasteful.
 *
 * react-file-manager requires every node's `path` to end with its own
 * `name` (that's how it derives a folder's children — see splitVirtualPath
 * below), so root nodes use the human label ("Obsidian Vault") as both name
 * and trailing path segment; splitVirtualPath resolves that back to the
 * short API root key ("vault") via the fetched roots list.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FileManager } from "@cubone/react-file-manager";
import "@cubone/react-file-manager/dist/style.css";
import "./FileExplorerPanel.css";
import { tokens } from "../../tokens";
import {
  fetchFileRoots,
  fetchFileList,
  fileReadUrl,
  attachExistingFile,
  searchFiles,
  type FileRoot,
  type UploadedFile,
} from "../../api";
import { MessageMarkdown } from "./MessageMarkdown";

interface FMFile {
  name: string;
  isDirectory: boolean;
  path: string;
  updatedAt?: string;
  size?: number;
}

const MD_EXT = new Set([".md", ".txt", ".json", ".csv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a"]);

/** Native drag-out payload mime type — read by useAttachments' dropHandlers. */
export const VPS_FILE_DRAG_MIME = "application/x-forge-vps-file";

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/** "/Obsidian Vault/20_Coding/notes.md" -> { root: "vault", rel: "20_Coding/notes.md" } */
function splitVirtualPath(virtualPath: string, roots: FileRoot[]): { root: string; rel: string } | null {
  const parts = virtualPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const rootEntry = roots.find((r) => r.label === parts[0]);
  if (!rootEntry) return null;
  return { root: rootEntry.key, rel: parts.slice(1).join("/") };
}

/** Hard cap on previewed text.
 *
 *  Why: this preview used to fetch a file whole and hand every byte to
 *  MessageMarkdown, which parses and lays out synchronously on the main
 *  thread. The vault routinely holds files far past the point where that is
 *  free — "AI OS/Operator Log.md" is 65KB and grows every session,
 *  contentforge_archive_report.md is 159KB — so clicking one in the file
 *  explorer froze the whole app. A preview only has to be enough to recognise
 *  the file; anything past a screen or two is cost with no benefit. */
const PREVIEW_MAX_CHARS = 40_000;

function FilePreview({ file, roots }: { file: FMFile; roots: FileRoot[] }) {
  // NOTE: every hook must run before any early return. This component used to
  // `return null` on an unresolvable path BEFORE calling useState/useEffect,
  // which changes hook order between renders — React's "rendered fewer hooks
  // than expected" crash, and a source of stale/duplicated fetches.
  const split = splitVirtualPath(file.path, roots);
  const url = split ? fileReadUrl(split.root, split.rel) : null;
  const e = ext(file.name);

  const [mdText, setMdText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!url || !MD_EXT.has(e)) return;
    let cancelled = false;
    setMdText(null);
    setTruncated(false);
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (cancelled) return;
        // Truncate on a line boundary so markdown isn't cut mid-construct
        // (an unterminated code fence would swallow the rest of the render).
        if (t.length > PREVIEW_MAX_CHARS) {
          const cut = t.slice(0, PREVIEW_MAX_CHARS);
          const lastNl = cut.lastIndexOf("\n");
          setMdText(lastNl > 0 ? cut.slice(0, lastNl) : cut);
          setTruncated(true);
        } else {
          setMdText(t);
        }
      })
      .catch(() => {
        if (!cancelled) setMdText("(failed to load)");
      });
    // Cancel on unmount / file change: clicking through a folder quickly used
    // to leave earlier fetches racing to setState on a dead component.
    return () => {
      cancelled = true;
    };
  }, [url, e]);

  if (!split || !url) return null;

  if (MD_EXT.has(e)) {
    return (
      <div style={{ padding: 16, maxHeight: "70vh", overflowY: "auto" }}>
        {e === ".md" ? (
          mdText === null ? (
            <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
              loading…
            </span>
          ) : (
            <MessageMarkdown source={mdText} />
          )
        ) : (
          <pre
            className="mono"
            style={{ fontSize: 11.5, color: tokens.text, whiteSpace: "pre-wrap" }}
          >
            {mdText ?? "loading…"}
          </pre>
        )}
        {truncated && (
          <div
            className="mono"
            style={{ fontSize: 10.5, color: tokens.textFaint, paddingTop: 12 }}
          >
            preview truncated at {(PREVIEW_MAX_CHARS / 1000) | 0}k characters — open the
            file to read it in full
          </div>
        )}
      </div>
    );
  }
  if (IMAGE_EXT.has(e)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={file.name} style={{ maxWidth: "100%", display: "block" }} />;
  }
  if (VIDEO_EXT.has(e)) {
    return <video controls src={url} style={{ maxWidth: "100%", display: "block" }} />;
  }
  if (AUDIO_EXT.has(e)) {
    return <audio controls src={url} style={{ width: "100%" }} />;
  }
  if (e === ".pdf") {
    return <iframe src={url} style={{ width: "100%", height: "70vh", border: "none" }} />;
  }
  return (
    <div style={{ padding: 24, textAlign: "center" }}>
      <p className="mono" style={{ fontSize: 11.5, color: tokens.textMuted, marginBottom: 12 }}>
        no inline preview for {e || "this file type"}
      </p>
      <a
        href={url}
        download={file.name}
        className="mono"
        style={{
          fontSize: 11.5,
          color: tokens.accent,
          border: `1px solid ${tokens.accent}`,
          borderRadius: 6,
          padding: "8px 14px",
          textDecoration: "none",
        }}
      >
        download {file.name}
      </a>
    </div>
  );
}

/** Memoised on purpose — this is the fix for "opening Files makes everything
 *  lag".
 *
 *  ChatSurface re-renders on every streamed chat event (many per second while
 *  a run is talking). Without memo, each of those re-rendered this entire
 *  third-party file tree — hundreds of rows, its own drag/keyboard wiring and
 *  layout — even though none of its inputs had changed. The panel only takes
 *  `onAttach`, which is a stable useCallback, so a plain memo is enough to cut
 *  the tree out of the chat's render path entirely. */
function FileExplorerPanelImpl({
  onAttach,
}: {
  /** null when there's no active chat to attach into (e.g. composing a new
   *  one) — the attach action is disabled in that case. */
  onAttach: ((file: UploadedFile) => void) | null;
}) {
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [files, setFiles] = useState<FMFile[]>([]);
  const [selected, setSelected] = useState<FMFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FMFile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  /** Records the last failed directory-load so the pane can render an
   *  explicit error row with a retry, instead of the old silent empty
   *  list on 500s / offline / permission errors. */
  const [loadError, setLoadError] = useState<{ path: string; message: string } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filesRef = useRef<FMFile[]>([]);
  const rootsRef = useRef<FileRoot[]>([]);
  filesRef.current = files;
  rootsRef.current = roots;

  const loadRoots = useCallback(async () => {
    const rs = await fetchFileRoots();
    setRoots(rs);
    setFiles(
      rs.map((r) => ({
        name: r.label,
        isDirectory: true,
        path: `/${r.label}`,
        updatedAt: new Date().toISOString(),
      })),
    );
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const loadDir = useCallback(async (virtualPath: string) => {
    const split = splitVirtualPath(virtualPath, rootsRef.current);
    if (!split) return; // the virtual "/" root — already seeded by loadRoots
    let entries: Awaited<ReturnType<typeof fetchFileList>>;
    try {
      entries = await fetchFileList(split.root, split.rel);
    } catch (err) {
      // Surface the failure instead of masking it as an empty directory —
      // a silent .catch(() => []) here used to make network errors,
      // 500s, and permission errors indistinguishable from a genuinely
      // empty folder. See BASELINE-FINDINGS.md §Error handling defect.
      setLoadError({
        path: virtualPath,
        message: err instanceof Error ? err.message : String(err),
      });
      // Clear stale children under the failed directory so the UI does
      // not keep showing whatever was there before the failed reload.
      setFiles((prev) => {
        const prefix = virtualPath.endsWith("/") ? virtualPath : `${virtualPath}/`;
        return prev.filter((f) => {
          if (!f.path.startsWith(prefix)) return true;
          return f.path.slice(prefix.length).includes("/");
        });
      });
      return;
    }
    setLoadError(null);
    setFiles((prev) => {
      const prefix = virtualPath.endsWith("/") ? virtualPath : `${virtualPath}/`;
      // Drop any stale entries directly under this dir, then re-add fresh ones.
      const withoutThisDir = prev.filter((f) => {
        if (!f.path.startsWith(prefix)) return true;
        return f.path.slice(prefix.length).includes("/");
      });
      const fresh: FMFile[] = entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDir,
        path: `${prefix}${e.name}`,
        updatedAt: e.mtime,
        size: e.isDir ? undefined : e.size,
      }));
      return [...withoutThisDir, ...fresh];
    });
  }, []);

  const handleFolderChange = useCallback(
    (path: string) => {
      setCurrentPath(path);
      setQuery("");
      void loadDir(path);
    },
    [loadDir],
  );

  const refresh = useCallback(() => {
    if (currentPath === "") void loadRoots();
    else void loadDir(currentPath);
  }, [currentPath, loadDir, loadRoots]);

  // Real recursive search (debounced), scoped to the current folder — or,
  // at the virtual Home root, across every root at once. Replaces the old
  // "filter" which only ever matched direct children of whatever directory
  // happened to already be loaded — not a real search over a 296-file vault.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setSearchResults(null);
      setSearchTruncated(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      const run = async () => {
        const split = currentPath === "" ? null : splitVirtualPath(currentPath, rootsRef.current);
        const scopes = split
          ? [{ label: currentPath.split("/").filter(Boolean)[0] ?? "", ...split }]
          : rootsRef.current.map((r) => ({ label: r.label, root: r.key, rel: "" }));
        const results = await Promise.all(
          scopes.map((s) =>
            searchFiles(s.root, s.rel, q)
              .then((r) => ({ label: s.label, ...r }))
              .catch(() => ({ label: s.label, entries: [], truncated: false })),
          ),
        );
        if (cancelled) return;
        // Files only — a folder result can't be "opened" from this flat
        // list without re-syncing react-file-manager's own internal nav
        // state (it isn't rendered while searching), so it'd dead-end.
        // The actual use case here is finding a file to copy-path/attach.
        const files: FMFile[] = results.flatMap((r) =>
          r.entries
            .filter((e) => !e.isDir)
            .map((e) => ({
              name: e.name,
              isDirectory: false,
              path: `/${r.label}/${e.path}`,
              updatedAt: e.mtime,
              size: e.size,
            })),
        );
        setSearchResults(files);
        setSearchTruncated(results.some((r) => r.truncated));
        setSearching(false);
      };
      void run();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, currentPath]);

  // react-file-manager only sets the native `draggable` attribute on rows
  // when permissions.move is on (it's built for internal drag-to-move — we
  // leave onPaste/onCut unwired so that stays inert) — we piggyback on that
  // attribute to drag a *file* row out onto the chat composer. Delegated at
  // the panel container so it survives re-renders of the row list.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDragStart = (e: DragEvent) => {
      const row = (e.target as HTMLElement | null)?.closest?.(".file-item-container");
      const name = row?.getAttribute("title");
      if (!name) return;
      const prefix = currentPath === "" ? "/" : `${currentPath}/`;
      const file = filesRef.current.find((f) => f.path === `${prefix}${name}`);
      if (!file || file.isDirectory) {
        e.preventDefault();
        return;
      }
      const split = splitVirtualPath(file.path, rootsRef.current);
      if (!split) return;
      e.dataTransfer?.setData(VPS_FILE_DRAG_MIME, JSON.stringify(split));
    };
    el.addEventListener("dragstart", onDragStart);
    return () => el.removeEventListener("dragstart", onDragStart);
  }, [currentPath]);

  const attachSelected = async () => {
    if (!onAttach || selected.length === 0) return;
    setAttaching(true);
    try {
      for (const f of selected) {
        if (f.isDirectory) continue;
        const split = splitVirtualPath(f.path, roots);
        if (!split) continue;
        const attached = await attachExistingFile(split.root, split.rel);
        onAttach(attached);
      }
    } finally {
      setAttaching(false);
    }
  };

  const [pathCopied, setPathCopied] = useState(false);

  /** Simpler alternative to drag/attach: resolve the selection to absolute
   *  VPS paths and put them on the clipboard — paste directly into any
   *  composer, no drag gesture or attachment round-trip required.
   *  /files/attach is read-only (just stats the file), so reusing it here
   *  has no side effects. */
  const copySelectedPaths = async () => {
    const targets = selected.filter((f) => !f.isDirectory);
    if (targets.length === 0) return;
    const resolved = await Promise.all(
      targets.map((f) => {
        const split = splitVirtualPath(f.path, roots);
        return split ? attachExistingFile(split.root, split.rel).catch(() => null) : null;
      }),
    );
    const paths = resolved.filter((f): f is UploadedFile => f !== null).map((f) => f.path);
    if (paths.length === 0) return;
    await navigator.clipboard.writeText(paths.join("\n"));
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1500);
  };

  const isSearching = query.trim().length >= 2;

  return (
    <div
      ref={containerRef}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            currentPath === "" ? "search the whole vault…" : "search this folder, recursively…"
          }
          className="mono"
          style={{
            flex: 1,
            fontSize: 11,
            color: tokens.text,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 6,
            padding: "5px 8px",
            outline: "none",
          }}
        />
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint, whiteSpace: "nowrap" }}>
          {selected.filter((f) => !f.isDirectory).length} selected
        </span>
        <button
          disabled={selected.filter((f) => !f.isDirectory).length === 0}
          onClick={() => void copySelectedPaths()}
          className="mono"
          style={{
            fontSize: 10.5,
            color: pathCopied ? tokens.ok : tokens.textLabel,
            background: tokens.bgGutter,
            border: `1px solid ${pathCopied ? tokens.ok : tokens.borderEmphasis}`,
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            opacity: selected.filter((f) => !f.isDirectory).length === 0 ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {pathCopied ? "copied ✓" : "copy path"}
        </button>
        {onAttach && (
          <button
            disabled={attaching || selected.filter((f) => !f.isDirectory).length === 0}
            onClick={() => void attachSelected()}
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              opacity: attaching ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {attaching ? "attaching…" : "attach"}
          </button>
        )}
      </div>
      <div
        className="mono"
        style={{ padding: "5px 10px", fontSize: 9.5, color: tokens.textGhost, borderBottom: `1px solid ${tokens.borderSoft}` }}
      >
        {isSearching
          ? searching
            ? "searching…"
            : `${searchResults?.length ?? 0} match${searchResults?.length === 1 ? "" : "es"}${searchTruncated ? " (more exist — narrow the search)" : ""} — click to select`
          : `select a file, then copy path${onAttach ? " or attach" : ""} — or drag it onto the composer`}
      </div>
      {loadError && !isSearching && (
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            fontSize: 11,
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            borderBottom: `1px solid ${tokens.dangerActionBorder}`,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            failed to load {loadError.path || "/"} — {loadError.message}
          </span>
          <button
            onClick={() => {
              if (loadError.path === "") void loadRoots();
              else void loadDir(loadError.path);
            }}
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.text,
              background: tokens.bgGutter,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 6,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            retry
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: isSearching ? "auto" : undefined }}>
        {isSearching ? (
          <SearchResultsList
            results={searchResults ?? []}
            searching={searching}
            selected={selected}
            onToggle={(f) =>
              setSelected((prev) =>
                prev.some((s) => s.path === f.path)
                  ? prev.filter((s) => s.path !== f.path)
                  : [...prev, f],
              )
            }
          />
        ) : (
          <FileManager
            files={files}
            height="100%"
            width="100%"
            layout="list"
            primaryColor={tokens.accent}
            permissions={{
              create: false,
              upload: false,
              move: true,
              copy: false,
              rename: false,
              delete: false,
              download: true,
            }}
            collapsibleNav
            defaultNavExpanded={false}
            onFolderChange={handleFolderChange}
            onRefresh={refresh}
            onSelectionChange={(sel: FMFile[]) => setSelected(sel)}
            filePreviewComponent={(file: FMFile) => <FilePreview file={file} roots={roots} />}
          />
        )}
      </div>
    </div>
  );
}

/** Search results span multiple folders, so they can't be rendered through
 *  react-file-manager's own list (it derives a folder's children from path
 *  prefix matching against the current directory — a flat cross-folder
 *  result set isn't a "folder" it can express). Own lightweight list
 *  instead, reusing the same `selected` state so copy-path/attach need no
 *  special-casing for where a file came from. Files only — folders are
 *  filtered out before this ever renders (see the search effect above). */
function SearchResultsList({
  results,
  searching,
  selected,
  onToggle,
}: {
  results: FMFile[];
  searching: boolean;
  selected: FMFile[];
  onToggle: (f: FMFile) => void;
}) {
  if (results.length === 0) {
    return (
      <div
        className="mono"
        style={{ padding: "48px 24px", fontSize: 11.5, color: tokens.textFaint, textAlign: "center" }}
      >
        {searching ? "searching…" : "no matches."}
      </div>
    );
  }
  return (
    <div>
      {results.map((f) => {
        const parts = f.path.split("/").filter(Boolean);
        const rootLabel = parts[0] ?? "";
        const dir = parts.slice(1, -1).join("/");
        const seld = selected.some((s) => s.path === f.path);
        return (
          <div
            key={f.path}
            onClick={() => onToggle(f)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              cursor: "pointer",
              borderBottom: `1px solid ${tokens.borderSoft}`,
              background: seld ? tokens.selectedBg : "transparent",
            }}
          >
            <span className="ms" style={{ fontSize: 15, color: tokens.textMuted }}>
              description
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: seld ? tokens.text : tokens.textLabel,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {f.name}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textGhost,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {rootLabel}
                {dir ? ` / ${dir}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const FileExplorerPanel = memo(FileExplorerPanelImpl);
