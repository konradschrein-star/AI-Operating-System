"use client";

/**
 * Full-window canvas — the "open ↗" target from the split view, so a drawing
 * can have the whole screen when the split gets cramped. Same file, same
 * autosave, same conflict handling as the pane; only the chrome differs.
 */

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CanvasPane } from "../desktop/CanvasPane";
import { tokens } from "../tokens";

function CanvasWindow() {
  const params = useSearchParams();
  const [path, setPath] = useState<string | null>(params.get("path"));
  return (
    <div style={{ height: "100dvh", background: tokens.bgBody }}>
      <CanvasPane path={path} onPathChange={setPath} />
    </div>
  );
}

export default function CanvasPage() {
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
      <CanvasWindow />
    </Suspense>
  );
}
