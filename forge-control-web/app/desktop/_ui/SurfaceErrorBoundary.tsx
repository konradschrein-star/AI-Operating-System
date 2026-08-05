"use client";

/**
 * Per-surface error boundary + the shared "this failed" panel.
 *
 * The console had no error boundaries at all (audit §1.4): one thrown
 * render error in any of the 19 surfaces blanked the entire app, top nav
 * and all, with no way back other than a reload. A boundary per surface
 * contains the damage to the pane that broke and leaves the rest of the OS
 * usable — you can still reach CONTROL and freeze the fleet while TASKS is
 * throwing.
 *
 * `resetKey` (the active surface) remounts the boundary on navigation, so
 * leaving a broken surface and coming back retries it rather than showing
 * a stale error forever.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { tokens } from "../../tokens";

interface Props {
  /** Shown in the fallback: "TASKS failed to render". */
  label: string;
  /** Changing this clears the error — used to reset on surface change. */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SurfaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack — without it a minified production error is
    // unactionable, and this is the only place it exists.
    console.error(
      `[surface:${this.props.label}] render failed:`,
      error,
      info.componentStack,
    );
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorPanel
        title={`${this.props.label} failed to render`}
        detail={error.message}
        onRetry={() => this.setState({ error: null })}
        retryLabel="try again"
      />
    );
  }
}

/**
 * The one failure panel. Used by the boundary above and by every `isError`
 * branch — a failed fetch must never render as "nothing to report", which
 * is exactly what `q.data ?? emptyX` did.
 */
export function ErrorPanel({
  title,
  detail,
  onRetry,
  retryLabel = "retry",
  compact = false,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
        margin: compact ? 12 : 24,
        padding: compact ? "12px 14px" : "20px 22px",
        border: `1px solid ${tokens.bleed}`,
        borderRadius: 9,
        background: tokens.bgCard,
        maxWidth: 620,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          color: tokens.bleed,
        }}
      >
        ERROR
      </div>
      <div style={{ fontSize: compact ? 12 : 13.5, color: tokens.text }}>
        {title}
      </div>
      {detail && (
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            color: tokens.textMuted,
            lineHeight: 1.55,
            wordBreak: "break-word",
          }}
        >
          {detail}
        </div>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.accent,
            background: tokens.primaryActionBg,
            border: `1px solid ${tokens.accent}`,
            borderRadius: 6,
            padding: "5px 12px",
            cursor: "pointer",
          }}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** Turn whatever a query threw into a one-line detail string. */
export function errorDetail(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "unknown error";
}
