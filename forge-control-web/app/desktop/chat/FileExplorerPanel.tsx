"use client";

/**
 * VPS file explorer panel — browse the Obsidian vault / agent workspace
 * directly in the desktop UI instead of only ever uploading fresh copies.
 * Read-only browsing + download + "attach to this chat" (which just
 * registers the existing VPS path as an attachment, no re-upload).
 *
 * Modeled as two virtual top-level folders ("/vault", "/workspace") over
 * @cubone/react-file-manager's single flat `files` array, populated lazily
 * per-directory as the user navigates (onFolderChange), since eagerly
 * listing the whole vault tree up front would be wasteful.
 */

import { useCallback, useEffect, useState } from "react";
import { FileManager } from "@cubone/react-file-manager";
import "@cubone/react-file-manager/dist/style.css";
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

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/** "/vault/AI OS/Operator Log.md" -> { root: "vault", rel: "AI OS/Operator Log.md" } */
function splitVirtualPath(virtualPath: string): { root: string; rel: string } | null {
  const parts = virtualPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return { root: parts[0], rel: parts.slice(1).join("/") };
}

function FilePreview({ file }: { file: FMFile }) {
  const split = splitVirtualPath(file.path);
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
  const [files, setFiles] = useState<FMFile[]>([]);
  const [selected, setSelected] = useState<FMFile[]>([]);
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    fetchFileRoots().then((roots: FileRoot[]) => {
      setFiles(
        roots.map((r) => ({
          name: r.label,
          isDirectory: true,
          path: `/${r.key}`,
          updatedAt: new Date().toISOString(),
        })),
      );
    });
  }, []);

  const loadDir = useCallback(async (virtualPath: string) => {
    const split = splitVirtualPath(virtualPath);
    if (!split) return; // the virtual "/" root — already seeded
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

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const attachSelected = async () => {
    if (!onAttach || selected.length === 0) return;
    setAttaching(true);
    try {
      for (const f of selected) {
        if (f.isDirectory) continue;
        const split = splitVirtualPath(f.path);
        if (!split) continue;
        const attached = await attachExistingFile(split.root, split.rel);
        onAttach(attached);
      }
    } finally {
      setAttaching(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {onAttach && (
        <div
          style={{
            padding: "8px 10px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
            {selected.filter((f) => !f.isDirectory).length} selected
          </span>
          <span style={{ flex: 1 }} />
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
            }}
          >
            {attaching ? "attaching…" : "attach to chat"}
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <FileManager
          files={files}
          height="100%"
          width="100%"
          layout="list"
          primaryColor={tokens.accent}
          permissions={{
            create: false,
            upload: false,
            move: false,
            copy: false,
            rename: false,
            delete: false,
            download: true,
          }}
          onFolderChange={(path: string) => void loadDir(path)}
          onSelectionChange={(sel: FMFile[]) => setSelected(sel)}
          filePreviewComponent={(file: FMFile) => <FilePreview file={file} />}
        />
      </div>
    </div>
  );
}
