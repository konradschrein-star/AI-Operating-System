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

import { useCallback, useEffect, useState } from "react";
import { tokens } from "../../tokens";
import { takeoverTicketUrl, vncProxyUrl } from "../../desktop/chat/browser-shots";

interface TicketBody {
  ticket: string;
  expires_at: string;
  novnc_port: number;
  profile: string;
}

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; body: TicketBody };

async function mintTicket(runId: string): Promise<TicketBody> {
  const mintUrl = takeoverTicketUrl(runId);
  if (!mintUrl) {
    throw new Error(`"${runId}" is not a valid run id (expected 12 lowercase hex characters)`);
  }
  let res: Response;
  try {
    res = await fetch(mintUrl, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    throw new Error(`Could not reach forge-control to mint a ticket: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Response body wasn't JSON — fall back to the status line already captured.
    }
    throw new Error(`${res.status} ${detail}`);
  }
  const body = (await res.json()) as Partial<TicketBody>;
  if (typeof body.ticket !== "string" || typeof body.profile !== "string") {
    throw new Error("Ticket mint endpoint returned an unexpected response shape");
  }
  return body as TicketBody;
}

export function TakeoverClient({ runId }: { runId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setStatus({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus((prev) => (prev.kind === "loading" ? prev : { kind: "loading" }));
    mintTicket(runId)
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
        <span style={{ color: tokens.accent, letterSpacing: "0.1em" }}>
          TAKEOVER &middot; {status.body.profile}
        </span>
        <span style={{ color: tokens.textMuted }}>
          ticket expires {new Date(status.body.expires_at).toLocaleTimeString()}
        </span>
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
      <iframe
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
