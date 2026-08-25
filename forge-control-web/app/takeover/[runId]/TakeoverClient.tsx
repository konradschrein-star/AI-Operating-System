"use client";

/**
 * TakeoverClient — the page a phone notification actually opens.
 *
 * /desktop is a single client-state route with no query deep links (a
 * notification has nowhere else to point), so this route exists purely to
 * give Konrad a one-hop landing spot: mint a ticket, show the live noVNC
 * canvas, done. It is also the ONLY place he finds out the feature broke —
 * a missing secret, an unresolved profile, a dead takeover stack, a network
 * error — so every failure path renders the actual reason and the run id on
 * screen. No spinner that never resolves, no blank canvas standing in for an
 * error nobody wrote down.
 *
 * Tickets last 120s (forge-control/src/lib/takeover-ticket.ts) and noVNC's
 * own reconnect is disabled (`reconnect=0` in vncProxyUrl) specifically so an
 * expired ticket cannot be silently replayed — which means a page left open
 * across a disconnect needs a human-driven re-mint. That is what Retry does.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { tokens } from "../../tokens";
import {
  mintTakeoverTicket,
  vncProxyUrl,
  type TakeoverTicketBody,
} from "../../desktop/chat/browser-shots";

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; body: TakeoverTicketBody };

interface ClipboardFeedback {
  text: string;
  isError?: boolean;
}

export function TakeoverClient({ runId }: { runId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [feedback, setFeedback] = useState<ClipboardFeedback | null>(null);
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [manualPasteText, setManualPasteText] = useState("");
  const [pasteErrorReason, setPasteErrorReason] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const retry = useCallback(() => {
    setStatus({ kind: "loading" });
    setFeedback(null);
    setShowManualPaste(false);
    setAttempt((n) => n + 1);
  }, []);

  const showFeedback = useCallback((text: string, isError = false) => {
    setFeedback({ text, isError });
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => {
      setFeedback(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    let cancelled = false;
    setStatus((prev) => (prev.kind === "loading" ? prev : { kind: "loading" }));
    mintTakeoverTicket(runId)
      .then((body) => {
        if (!cancelled) setStatus({ kind: "ready", body });
      })
      .catch((err: Error) => {
        if (!cancelled) setStatus({ kind: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, attempt]);

  const getRemoteClipboardTextarea = (): HTMLTextAreaElement | null => {
    const iframe = iframeRef.current;
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
      setPasteErrorReason("Browser does not support clipboard reading (e.g. Firefox)");
      setShowManualPaste(true);
      showFeedback("Clipboard read unsupported — paste manually below", true);
      return;
    }

    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Permission denied";
      setPasteErrorReason(`Clipboard read failed: ${msg}`);
      setShowManualPaste(true);
      showFeedback(`Clipboard read failed: ${msg}`, true);
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
      setShowManualPaste(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showFeedback(`Failed to send clipboard to VM: ${msg}`, true);
    }
  };

  const handleManualPasteSubmit = () => {
    const remoteTextarea = getRemoteClipboardTextarea();
    if (!remoteTextarea) return;

    if (manualPasteText.length === 0) {
      showFeedback("No text entered to paste", true);
      return;
    }

    try {
      remoteTextarea.value = manualPasteText;
      remoteTextarea.dispatchEvent(new Event("change", { bubbles: true }));
      showFeedback(`Pasted ${manualPasteText.length} chars`);
      setShowManualPaste(false);
      setManualPasteText("");
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

  if (status.kind === "loading") {
    return (
      <Shell>
        <div className="mono" style={{ color: tokens.textMuted, fontSize: 12 }}>
          minting takeover ticket for run {runId}…
        </div>
      </Shell>
    );
  }

  if (status.kind === "error") {
    return (
      <Shell>
        <div
          className="mono"
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
          <div style={{ fontSize: 11, letterSpacing: "0.12em", color: tokens.warn }}>
            TAKEOVER FAILED
          </div>
          <div style={{ fontSize: 13, color: tokens.text, wordBreak: "break-word" }}>
            {status.message}
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>run id: {runId}</div>
          <button
            type="button"
            onClick={retry}
            className="mono"
            style={{
              alignSelf: "flex-start",
              padding: "8px 16px",
              background: tokens.accent,
              color: tokens.accentInk,
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  const vncUrl = vncProxyUrl(runId, status.body.ticket);
  if (!vncUrl) {
    // Should be unreachable — mintTicket already validated runId and returned a
    // ticket — but vncProxyUrl is the security boundary, not this component,
    // so a mismatch here still renders the failure rather than an empty iframe.
    return (
      <Shell>
        <div className="mono" style={{ color: tokens.warn, fontSize: 12 }}>
          Minted a ticket but could not build the viewer URL for run {runId}.
        </div>
      </Shell>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: tokens.bgBody, display: "flex", flexDirection: "column" }}>
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "6px 10px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgCard,
          flexShrink: 0,
          fontSize: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, overflow: "hidden" }}>
          <span style={{ color: tokens.accent, letterSpacing: "0.1em", flexShrink: 0 }}>
            TAKEOVER &middot; {status.body.profile}
          </span>
          <span style={{ color: tokens.textMuted, flexShrink: 0 }}>
            ticket expires {new Date(status.body.expires_at).toLocaleTimeString()}
          </span>
          {feedback && (
            <span
              style={{
                color: feedback.isError ? tokens.warn : tokens.ok,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {feedback.text}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button
            type="button"
            onClick={handlePasteToVM}
            className="mono"
            style={{
              padding: "4px 10px",
              background: "transparent",
              color: tokens.textMuted,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 4,
              fontSize: 10,
              cursor: "pointer",
            }}
          >
            Paste to VM
          </button>
          <button
            type="button"
            onClick={handleCopyFromVM}
            className="mono"
            style={{
              padding: "4px 10px",
              background: "transparent",
              color: tokens.textMuted,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 4,
              fontSize: 10,
              cursor: "pointer",
            }}
          >
            Copy from VM
          </button>
          <button
            type="button"
            onClick={retry}
            className="mono"
            style={{
              padding: "4px 10px",
              background: "transparent",
              color: tokens.textMuted,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 4,
              fontSize: 10,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      </div>
      {showManualPaste && (
        <div
          className="mono"
          style={{
            padding: "8px 10px",
            background: tokens.bgCard,
            borderBottom: `1px solid ${tokens.borderDivider}`,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: tokens.warn }}>
            <span>{pasteErrorReason || "Clipboard reading unavailable. Paste text manually below:"}</span>
            <button
              type="button"
              onClick={() => {
                setShowManualPaste(false);
                setManualPasteText("");
              }}
              className="mono"
              style={{
                background: "transparent",
                border: "none",
                color: tokens.textMuted,
                cursor: "pointer",
                fontSize: 10,
                padding: 0,
              }}
            >
              ✕ Close
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={manualPasteText}
              onChange={(e) => setManualPasteText(e.target.value)}
              placeholder="Paste text here..."
              className="mono"
              rows={2}
              autoFocus
              style={{
                flex: 1,
                background: tokens.inputBg,
                color: tokens.text,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 10,
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={handleManualPasteSubmit}
              className="mono"
              style={{
                padding: "4px 12px",
                background: tokens.accent,
                color: tokens.accentInk,
                border: "none",
                borderRadius: 4,
                fontSize: 10,
                cursor: "pointer",
                alignSelf: "flex-end",
              }}
            >
              Paste to VM
            </button>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        key={status.body.ticket}
        src={vncUrl}
        title="Live Browser Takeover"
        style={{ flex: 1, width: "100%", border: "none" }}
        allow="clipboard-read; clipboard-write"
      />
    </div>
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
