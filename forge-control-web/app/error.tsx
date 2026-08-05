"use client";

/**
 * Route-level error boundary — the last net under the whole console.
 *
 * Anything the per-surface boundaries don't catch (a throw in DesktopApp's
 * own shell, in Providers, in a route segment) lands here instead of
 * blanking the page with no explanation and no way back.
 *
 * Next requires this file to be a client component and to accept
 * `{error, reset}`.
 */

import { useEffect } from "react";
import { tokens } from "./tokens";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: tokens.bgBody,
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 640,
          width: "100%",
          border: `1px solid ${tokens.bleed}`,
          borderRadius: 10,
          background: tokens.bgCard,
          padding: "24px 26px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          className="mono"
          style={{ fontSize: 10, letterSpacing: "0.12em", color: tokens.bleed }}
        >
          CONSOLE CRASHED
        </div>
        <div style={{ fontSize: 15, color: tokens.text }}>
          The console hit an error it couldn&rsquo;t recover from on its own.
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            lineHeight: 1.6,
            wordBreak: "break-word",
          }}
        >
          {error.message}
          {error.digest && (
            <>
              <br />
              digest {error.digest}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={reset}
            className="mono"
            style={{
              fontSize: 11.5,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "6px 14px",
              cursor: "pointer",
            }}
          >
            retry
          </button>
          <button
            onClick={() => window.location.reload()}
            className="mono"
            style={{
              fontSize: 11.5,
              color: tokens.textMuted,
              background: "transparent",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "6px 14px",
              cursor: "pointer",
            }}
          >
            reload
          </button>
        </div>
      </div>
    </div>
  );
}
