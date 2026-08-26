"use client";

/**
 * TakeoverClient — the page a phone notification actually opens.
 *
 * /desktop is a single client-state route with no query deep links (a
 * notification has nowhere else to point), so this route exists purely to
 * give Konrad a one-hop landing spot: mint a ticket, show the live noVNC
 * canvas, let him type into it, and tell him when it ends. It is also the
 * ONLY place he finds out the feature broke — a missing secret, an unresolved
 * profile, a dead takeover stack, a network error, a bridge that could not
 * reach noVNC — so every failure path renders the actual reason and the run
 * id on screen. No spinner that never resolves, no blank canvas standing in
 * for an error nobody wrote down.
 *
 * v2 (aios-takeover-usable, PLAN.md §1.1/§1.3):
 *   - Layout: fixed inset 0, column flex — header (clock + status + Done),
 *     iframe flex:1, TextToVM panel flex-shrink:0 (a fixed-height bottom sheet
 *     at ≤640 px). The panel is always on screen, never behind a menu.
 *   - Lifecycle is owned by useTakeoverSession: a drop re-mints a FRESH ticket
 *     (never a replay), five attempts, then Retry; the session clock is polled
 *     from the supervisor and rendered in the header; Done ends the session
 *     with a two-tap confirm. Tickets stay 120 s — they are a connect window.
 *   - The Paste-to-VM / Copy-from-VM buttons stay (they work on Chromium
 *     desktop); when readText() is unavailable the message now points at the
 *     panel below instead of unfolding a second textarea.
 *
 * Nothing typed toward the VM is ever logged, fetched or put in a message.
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { tokens } from "../../tokens";
import { TextToVM, bigButton } from "./TextToVM";
import { useTakeoverSession, type TakeoverSession } from "./useTakeoverSession";

interface ClipboardFeedback {
  text: string;
  isError?: boolean;
}

export function TakeoverClient({ runId }: { runId: string }) {
  const session = useTakeoverSession(runId);
  const [feedback, setFeedback] = useState<ClipboardFeedback | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const showFeedback = useCallback((text: string, isError = false) => {
    setFeedback({ text, isError });
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const getRemoteClipboardTextarea = (): HTMLTextAreaElement | null => {
    const iframe = session.iframeRef.current;
    if (!iframe) {
      showFeedback("Viewer not ready", true);
      return null;
    }
    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch (err: unknown) {
      showFeedback(
        `Cannot access viewer DOM: ${err instanceof Error ? err.message : "Security / origin error"}`,
        true,
      );
      return null;
    }
    if (!doc) {
      showFeedback("Viewer document not ready", true);
      return null;
    }
    const el = doc.getElementById("noVNC_clipboard_text") as HTMLTextAreaElement | null;
    if (!el) {
      showFeedback("VM clipboard buffer not ready", true);
      return null;
    }
    return el;
  };

  const handlePasteToVM = async () => {
    const remoteTextarea = getRemoteClipboardTextarea();
    if (!remoteTextarea) return;

    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.readText !== "function"
    ) {
      showFeedback("This browser cannot read the clipboard — paste into the text panel below instead", true);
      return;
    }

    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Permission denied";
      showFeedback(`Clipboard read failed (${msg}) — paste into the text panel below instead`, true);
      return;
    }

    if (text.length === 0) {
      showFeedback("Local clipboard is empty", true);
      return;
    }

    try {
      remoteTextarea.value = text;
      remoteTextarea.dispatchEvent(new Event("change", { bubbles: true }));
      showFeedback(`Pasted ${text.length} chars`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(`Failed to send clipboard to VM: ${msg}`, true);
    }
  };

  const handleCopyFromVM = async () => {
    const remoteTextarea = getRemoteClipboardTextarea();
    if (!remoteTextarea) return;

    const text = remoteTextarea.value;
    if (!text || text.length === 0) {
      showFeedback("nothing in the VM clipboard yet", false);
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== "function"
    ) {
      showFeedback("Browser clipboard write unsupported", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      showFeedback(`Copied ${text.length} chars`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Permission denied";
      showFeedback(`Failed to copy to clipboard: ${msg}`, true);
    }
  };

  const { ticket } = session;

  if (ticket.kind === "idle" || (ticket.kind === "loading" && session.reconnect === null)) {
    return (
      <Shell>
        <div className="mono" style={{ color: tokens.textMuted, fontSize: 12 }}>
          minting takeover ticket for run {runId}…
        </div>
      </Shell>
    );
  }

  if (ticket.kind === "error" && session.reconnect === null) {
    return (
      <Shell>
        <div
          className="mono"
          data-takeover-error
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            maxWidth: 560,
            padding: 20,
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: "0.12em", color: tokens.warn }}>TAKEOVER FAILED</div>
          <div style={{ fontSize: 13, color: tokens.text, wordBreak: "break-word" }}>{ticket.message}</div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>run id: {runId}</div>
          <ClockLine session={session} />
          <button
            type="button"
            onClick={session.retry}
            className="mono"
            style={{ ...bigButton, alignSelf: "flex-start", background: tokens.accent, color: tokens.accentInk, border: "none" }}
          >
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <div
      data-takeover-page
      style={{ position: "fixed", inset: 0, background: tokens.bgBody, display: "flex", flexDirection: "column" }}
    >
      {/* Header: title, clock/status line, Done */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          padding: "6px 10px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgCard,
          flexShrink: 0,
          fontSize: 11,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 160px" }}>
          <span style={{ color: tokens.accent, letterSpacing: "0.1em", whiteSpace: "nowrap" }}>
            TAKEOVER &middot; {ticket.kind === "ready" ? ticket.body.profile : runId}
          </span>
          <ClockLine session={session} />
          {feedback && (
            <span
              data-takeover-feedback
              style={{
                color: feedback.isError ? tokens.warn : tokens.ok,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {feedback.text}
            </span>
          )}
        </div>
        {/* `flex: 1 1 auto` + flex-end: when this group wraps under the title on
            a phone it takes the full header width, so the two-tap confirm row
            ('End session?' [End] [Keep]) has room and nothing is clipped. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flex: "1 1 auto", minWidth: 0, flexWrap: "wrap" }}>
          <HeaderButton onClick={handlePasteToVM} label="Paste to VM" />
          <HeaderButton onClick={handleCopyFromVM} label="Copy from VM" />
          {session.reconnect?.exhausted || ticket.kind === "error" ? (
            <HeaderButton onClick={session.retry} label="Retry" accent />
          ) : null}
          <DoneControl
            session={session}
            confirming={confirmEnd}
            onConfirming={setConfirmEnd}
          />
        </div>
      </div>

      {session.bridgeError && (
        <div
          className="mono"
          data-takeover-bridge-error
          style={{
            padding: "8px 10px",
            background: tokens.dangerActionBg,
            borderBottom: `1px solid ${tokens.dangerActionBorder}`,
            color: tokens.warn,
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          Text input cannot reach the viewer: {session.bridgeError}
        </div>
      )}

      {/* The viewer, or the reason there is none */}
      {session.vncUrl && session.clock.kind !== "ended" ? (
        <iframe
          ref={session.iframeRef}
          key={session.iframeKey}
          src={session.vncUrl}
          onLoad={session.onIframeLoad}
          title="Live Browser Takeover"
          style={{ flex: 1, minHeight: 0, width: "100%", border: "none", background: tokens.bgBody }}
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div
          className="mono"
          data-takeover-stage-message
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: 20,
            textAlign: "center",
            color: session.clock.kind === "ended" ? tokens.text : tokens.textMuted,
            fontSize: 13,
          }}
        >
          <span>{session.statusLine}</span>
          {session.clock.kind === "ended" && (
            <span style={{ fontSize: 11, color: tokens.textMuted }}>
              at {new Date(session.clock.at).toLocaleTimeString()} · the browser stack is torn down; the profile is kept
            </span>
          )}
          {ticket.kind === "error" && (
            <span style={{ fontSize: 11, color: tokens.warn, maxWidth: 520, wordBreak: "break-word" }}>{ticket.message}</span>
          )}
        </div>
      )}

      <TextToVM getBridge={session.getBridge} connected={session.viewer === "connected"} />
    </div>
  );
}

/** 'connected · ends in 1:52:10' — warn colour under 10 min, ended in words. */
function ClockLine({ session }: { session: TakeoverSession }) {
  const ended = session.clock.kind === "ended";
  return (
    <span
      data-takeover-status
      data-takeover-clock={session.clock.kind}
      style={{
        color: ended ? tokens.warn : session.clockWarn ? tokens.warn : session.viewer === "connected" ? tokens.ok : tokens.textMuted,
        // Wraps rather than truncates: 'session clock unavailable — forge-control
        // predates this build' is 60+ characters and a phone must show all of it.
        overflowWrap: "anywhere",
      }}
    >
      {session.statusLine}
    </span>
  );
}

/** Done → 'End session?' [End] [Keep] → result. Every button ≥44 px. */
function DoneControl({
  session,
  confirming,
  onConfirming,
}: {
  session: TakeoverSession;
  confirming: boolean;
  onConfirming: (v: boolean) => void;
}) {
  if (session.clock.kind === "ended") {
    return (
      <span data-takeover-done-state="done" className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
        ended
      </span>
    );
  }
  if (session.end.kind === "pending") {
    return (
      <span data-takeover-done-state="pending" className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
        ending…
      </span>
    );
  }
  if (confirming) {
    return (
      <span
        data-takeover-done-state="confirm"
        // Its own full-width row: on a 390 px phone the three pieces do not fit
        // beside Paste/Copy, and a clipped [Keep] is exactly the wrong button to lose.
        style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flex: "1 1 100%" }}
      >
        <span className="mono" style={{ fontSize: 11, color: tokens.text }}>
          End session?
        </span>
        <button
          type="button"
          data-takeover-done-confirm
          onClick={() => {
            onConfirming(false);
            void session.endSession();
          }}
          className="mono"
          style={{ ...bigButton, background: tokens.bleed, color: tokens.onAccent, border: "none" }}
        >
          End
        </button>
        <button
          type="button"
          data-takeover-done-keep
          onClick={() => onConfirming(false)}
          className="mono"
          style={{ ...bigButton, background: "transparent", color: tokens.text, border: `1px solid ${tokens.borderEmphasis}` }}
        >
          Keep
        </button>
      </span>
    );
  }
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {session.end.kind === "error" && (
        <span data-takeover-done-state="error" className="mono" style={{ fontSize: 11, color: tokens.warn, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          end failed: {session.end.message}
        </span>
      )}
      <button
        type="button"
        data-takeover-done
        onClick={() => onConfirming(true)}
        className="mono"
        style={{ ...bigButton, background: tokens.dangerActionBg, color: tokens.bleed, border: `1px solid ${tokens.dangerActionBorder}` }}
      >
        Done
      </button>
    </span>
  );
}

function HeaderButton({ onClick, label, accent = false }: { onClick: () => void; label: string; accent?: boolean }) {
  const style: CSSProperties = accent
    ? { ...bigButton, background: tokens.accent, color: tokens.accentInk, border: "none" }
    : { ...bigButton, background: "transparent", color: tokens.textMuted, border: `1px solid ${tokens.borderDivider}` };
  return (
    <button type="button" onClick={onClick} className="mono" style={{ ...style, fontSize: 12, padding: "0 10px" }}>
      {label}
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: tokens.bgBody,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      {children}
    </div>
  );
}
