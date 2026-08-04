"use client";

/**
 * /settings/secrets — reveal, dismiss, and delete stored credentials.
 *
 * Companion to the SecretField in the chat composer. That field is the write
 * path (Konrad → agent); this page is the read path (agent → Konrad) plus
 * housekeeping. The reveal endpoint is the ONLY route in the app that returns
 * a raw secret value; it's a POST, distinct from the list endpoint, so a
 * bookmark or a stray refresh can't leak anything.
 *
 * The value only lives in React state for as long as the user is looking at
 * it — click "reveal" to fetch, click "hide" (or navigate away) and it's
 * dropped. This is hygiene, not protection: a determined attacker with the
 * browser already open has every option they need. But leaving a password
 * mounted for the rest of the session for no reason is pointless risk.
 *
 * Everything on this page runs behind the same NextAuth session that gates
 * the rest of forge-control-web (see middleware.ts). No secondary gate —
 * adding one would be a new moving part with a different failure mode.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { tokens } from "../../tokens";
import {
  fetchSecrets,
  revealSecret,
  clearSecretPending,
  deleteSecret,
  type SecretMeta,
} from "../../api";

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await fetchSecrets();
      setSecrets(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSecrets([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingCount = (secrets ?? []).filter((s) => s.pending).length;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: tokens.bgBody,
        color: tokens.text,
        padding: "28px 32px 64px",
      }}
    >
      <div style={{ maxWidth: 780, margin: "0 auto" }}>
        <Link
          href="/settings"
          className="mono"
          style={{
            color: tokens.textMuted,
            textDecoration: "none",
            fontSize: 12.5,
          }}
        >
          ← BACK TO SETTINGS
        </Link>

        <h1 style={{ fontSize: 26, margin: "14px 0 4px", fontWeight: 600 }}>
          Secrets
        </h1>
        <div style={{ color: tokens.textMuted, fontSize: 13.5, marginBottom: 8 }}>
          Credentials the fleet holds. Stored 0600 under root at{" "}
          <code className="mono" style={{ color: tokens.textLabel }}>
            /opt/ai-os/.secrets/store/
          </code>
          . Values never enter the chat thread, server logs, or backups of{" "}
          <code className="mono" style={{ color: tokens.textLabel }}>
            runs.thread
          </code>
          .
        </div>
        <div style={{ color: tokens.textFaint, fontSize: 12.5, marginBottom: 26 }}>
          Reveal is the only endpoint that returns a value, and it's a POST —
          the name never lands in a URL, an access log, or your browser
          history.
        </div>

        {pendingCount > 0 && (
          <div
            className="mono"
            style={{
              background: tokens.freezeBgWarn,
              border: `1px solid ${tokens.freezeBorderWarn}`,
              color: tokens.warn,
              borderRadius: 8,
              padding: "10px 13px",
              marginBottom: 18,
              fontSize: 12,
            }}
          >
            {pendingCount === 1
              ? "1 credential waiting for you"
              : `${pendingCount} credentials waiting for you`}
            {" — reveal each to mark collected."}
          </div>
        )}

        {error && (
          <div
            style={{
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 10,
              padding: "12px 14px",
              marginBottom: 20,
              fontSize: 13,
            }}
          >
            <strong>Could not load secrets.</strong>
            <div style={{ color: tokens.textSoft, marginTop: 4 }}>{error}</div>
          </div>
        )}

        {secrets && secrets.length === 0 && !error && (
          <div
            className="mono"
            style={{
              background: tokens.bgCard,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 8,
              padding: 24,
              fontSize: 12,
              color: tokens.textFaint,
              textAlign: "center",
            }}
          >
            no secrets stored.
          </div>
        )}

        {(secrets ?? []).map((s) => (
          <SecretRow
            key={s.name}
            secret={s}
            busy={busy}
            setBusy={setBusy}
            reload={load}
          />
        ))}
      </div>
    </div>
  );
}

function SecretRow({
  secret,
  busy,
  setBusy,
  reload,
}: {
  secret: SecretMeta;
  busy: string | null;
  setBusy: (b: string | null) => void;
  reload: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [errText, setErrText] = useState<string | null>(null);

  // Drop the value out of memory the moment this row unmounts (navigation,
  // list reload after delete). Hygiene, not protection — but it's cheap.
  useEffect(() => () => setRevealed(null), []);

  const doReveal = async () => {
    if (busy) return;
    setBusy(`${secret.name}:reveal`);
    setErrText(null);
    try {
      const { value } = await revealSecret(secret.name);
      setRevealed(value);
      // If it was pending, the server just cleared the flag — refresh the
      // list so the badge disappears.
      if (secret.pending) await reload();
    } catch (e) {
      setErrText(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doCopy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied — fall back to a select-all so Konrad
      // can copy manually. The pre element below carries user-select: all.
    }
  };

  const doDismiss = async () => {
    if (busy) return;
    setBusy(`${secret.name}:dismiss`);
    try {
      await clearSecretPending(secret.name);
      await reload();
    } catch (e) {
      setErrText(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    if (busy) return;
    if (
      !confirm(
        `Delete secret "${secret.name}" from disk? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(`${secret.name}:delete`);
    try {
      await deleteSecret(secret.name);
      setRevealed(null);
      await reload();
    } catch (e) {
      setErrText(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${
          secret.pending ? tokens.freezeBorderWarn : tokens.border
        }`,
        borderLeft: `3px solid ${
          secret.pending ? tokens.warn : tokens.borderDivider
        }`,
        borderRadius: 10,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 14, color: tokens.textHi, fontWeight: 500 }}
        >
          {secret.name}
        </span>
        {secret.pending && (
          <span
            className="mono"
            style={{
              background: tokens.freezeBgWarn,
              color: tokens.warn,
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10,
              letterSpacing: "0.06em",
            }}
          >
            FOR YOU
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 10.5, color: tokens.textFaint }}
        >
          {secret.bytes}B · {ago(secret.updatedAt)}
        </span>
      </div>

      {secret.note && (
        <div
          style={{
            color: tokens.textSoft,
            fontSize: 13,
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          {secret.note}
        </div>
      )}

      {revealed !== null && (
        <div
          style={{
            marginTop: 12,
            background: tokens.inputBg,
            border: `1px solid ${tokens.borderEmphasis}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              letterSpacing: "0.1em",
              marginBottom: 6,
            }}
          >
            VALUE — click to select, or use copy
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 0,
              fontSize: 12.5,
              color: tokens.textHi,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "all",
              WebkitUserSelect: "all",
            }}
          >
            {revealed}
          </pre>
        </div>
      )}

      {errText && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: tokens.bleed,
            wordBreak: "break-word",
          }}
        >
          {errText}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          flexWrap: "wrap",
        }}
      >
        {revealed === null ? (
          <button
            onClick={() => void doReveal()}
            disabled={busy !== null}
            style={btn(tokens.primaryActionBg, tokens.accent, tokens.accent)}
          >
            {busy === `${secret.name}:reveal` ? "revealing…" : "Reveal"}
          </button>
        ) : (
          <>
            <button
              onClick={() => void doCopy()}
              style={btn(tokens.okActionBg, tokens.okActionBorder, tokens.ok)}
            >
              {copied ? "copied ✓" : "Copy"}
            </button>
            <button
              onClick={() => setRevealed(null)}
              style={btn(tokens.toolBg, tokens.border, tokens.textMuted)}
            >
              Hide
            </button>
          </>
        )}
        {secret.pending && revealed === null && (
          <button
            onClick={() => void doDismiss()}
            disabled={busy !== null}
            style={btn(tokens.toolBg, tokens.border, tokens.textMuted)}
          >
            {busy === `${secret.name}:dismiss` ? "dismissing…" : "Dismiss flag"}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => void doDelete()}
          disabled={busy !== null}
          style={btn(
            tokens.dangerActionBg,
            tokens.dangerActionBorder,
            tokens.bleed,
          )}
        >
          {busy === `${secret.name}:delete` ? "deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function btn(bg: string, border: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 7,
    color: fg,
    cursor: "pointer",
    fontSize: 12,
    padding: "6px 12px",
  };
}
