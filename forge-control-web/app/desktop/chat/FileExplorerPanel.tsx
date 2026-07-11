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

import { useCallback, useEffect, useRef, useState } from "react";
import { FileManager } from "@cubone/react-file-manager";
import "@cubone/react-file-manager/dist/style.css";
import "./FileExplorerPanel.css";
import { tokens } from "../../tokens";
import {
  fetchFileRoots,
  fetchFileList,
  fileReadUrl,
  attachExistingFile,
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

function FilePreview({ file, roots }: { file: FMFile; roots: FileRoot[] }) {
  const split = splitVirtualPath(file.path, roots);
  if (!split) return null;
  const url = fileReadUrl(split.root, split.rel);
  const e = ext(file.name);

  const [mdText, setMdText] = useState<string | null>(null);
  useEffect(() => {
    if (!MD_EXT.has(e)) return;
    setMdText(null);
    fetch(url)
      .then((r) => r.text())
      .then(setMdText)
      .catch(() => setMdText("(failed to load)"));
  }, [url, e]);

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

export function FileExplorerPanel({
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
    const entries = await fetchFileList(split.root, split.rel).catch(() => []);
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

  const q = query.trim().toLowerCase();
  const visibleFiles = q
    ? files.filter((f) => {
        // Keep every ancestor of the current dir (breadcrumb/tree bookkeeping)
        // plus direct children of the current dir whose name matches.
        const prefix = currentPath === "" ? "/" : `${currentPath}/`;
        if (!f.path.startsWith(prefix) || f.path.slice(prefix.length).includes("/")) return true;
        return f.name.toLowerCase().includes(q);
      })
    : files;

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
          placeholder="filter this folder…"
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
        {onAttach && (
          <>
            <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
              {selected.filter((f) => !f.isDirectory).length} selected
            </span>
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
          </>
        )}
      </div>
      {onAttach && (
        <div
          className="mono"
          style={{ padding: "5px 10px", fontSize: 9.5, color: tokens.textGhost, borderBottom: `1px solid ${tokens.borderSoft}` }}
        >
          drag a file onto the composer to attach it, or select + attach
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <FileManager
          files={visibleFiles}
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
      </div>
    </div>
  );
}
