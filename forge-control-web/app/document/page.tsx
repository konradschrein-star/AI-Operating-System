"use client";

/**
 * Full-window document viewer — the "open ↗" target from the file explorer,
 * for when a preview needs more room than the split pane gives it. Renders
 * the exact same FilePreview component as the in-app viewer; this route is
 * chrome around it, not a second implementation.
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FilePreview } from "../desktop/chat/FilePreview";
import { tokens } from "../tokens";

function DocumentWindow() {
  const params = useSearchParams();
  const root = params.get("root");
  const path = params.get("path");
  const name = path ? (path.split("/").pop() ?? path) : null;

  if (!root || !path || !name) {
    return (
      <div
        className="mono"
        style={{
          height: "100dvh",
          display: "grid",
          placeItems: "center",
          background: tokens.bgBody,
          color: tokens.textMuted,
          fontSize: 11,
        }}
      >
        no document specified — pass ?root=&path=
      </div>
    );
  }

  return (
    <div style={{ height: "100dvh", background: tokens.bgBody, display: "flex", flexDirection: "column" }}>
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
          DOCUMENT
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {root} / {path}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <FilePreview root={root} rel={path} name={name} />
      </div>
    </div>
  );
}

export default function DocumentPage() {
  return (
    <Suspense
      fallback={
        <div
          className="mono"
          style={{
            height: "100dvh",
            display: "grid",
            placeItems: "center",
            background: tokens.bgBody,
            color: tokens.textMuted,
            fontSize: 11,
          }}
        >
          loading…
        </div>
      }
    >
      <DocumentWindow />
    </Suspense>
  );
}
