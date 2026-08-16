"use client";

/**
 * Renders the content of one file — used both inline (FileExplorerPanel, when
 * exactly one file is selected) and standalone (app/document/page.tsx, the
 * "open in a separate tab" target). Same component either way: the standalone
 * route is not a fork of this renderer, just a different chrome around it.
 */

import { useEffect, useState } from "react";
import { tokens } from "../../tokens";
import { fileReadUrl } from "../../api";
import { MessageMarkdown } from "./MessageMarkdown";

const MD_EXT = new Set([".md", ".txt", ".json", ".csv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a"]);

/** Hard cap on previewed text — large files (65KB+) froze the UI. */
const PREVIEW_MAX_CHARS = 40_000;

export function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export function FilePreview({ root, rel, name }: { root: string; rel: string; name: string }) {
  const url = fileReadUrl(root, rel);
  const e = ext(name);

  const [mdText, setMdText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!MD_EXT.has(e)) return;
    let cancelled = false;
    setMdText(null);
    setTruncated(false);
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (cancelled) return;
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
    return () => {
      cancelled = true;
    };
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
    return <img src={url} alt={name} style={{ maxWidth: "100%", display: "block" }} />;
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
        download={name}
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
        download {name}
      </a>
    </div>
  );
}
