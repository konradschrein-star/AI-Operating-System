"use client";

/**
 * SecretField — paste a credential without it entering the conversation.
 *
 * Why this exists: runs.thread is plain JSONB in postgres. It is replayed into
 * the model's context on every turn and it is captured in the nightly backup.
 * A password or SSH key typed into the message box therefore lives in the
 * database, in every future prompt, and in every backup, permanently. Konrad
 * stopped mid-paste with an SSH private key and asked for this instead.
 *
 * The value goes straight to POST /api/secrets and never touches component
 * state that gets sent anywhere else. What lands in the chat is only the NAME,
 * so the agent can refer to the credential and read it from disk when it needs
 * it — which is usually never, because most of the time it just passes the name
 * to a command.
 */

import { useState } from "react";
import { tokens } from "../../tokens";
import { storeSecret } from "../../api";

export function SecretField({
  onStored,
  onClose,
}: {
  /** Called with the stored NAME so the caller can reference it in chat. */
  onStored: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const n = name.trim().toLowerCase();
    if (!n || !value) return;
    setBusy(true);
    setErr(null);
    try {
      const meta = await storeSecret(n, value, note.trim() || undefined);
      // Drop the value from memory as soon as it's stored. This is hygiene
      // rather than protection — but leaving a key sitting in React state for
      // the rest of the session is pointless risk.
      setValue("");
      setName("");
      setNote("");
      onStored(meta.name);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not store secret");
    } finally {
      setBusy(false);
    }
  };

  const field: React.CSSProperties = {
    background: tokens.bgBody,
    border: `1px solid ${tokens.border}`,
    borderRadius: 6,
    padding: "7px 9px",
    color: tokens.text,
    fontSize: 12,
    outline: "none",
    width: "100%",
  };

  return (
    <div
      style={{
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        background: tokens.bgCard,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 8,
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 10.5, color: tokens.textMuted, lineHeight: 1.5 }}
      >
        Stored on the server, never written into this conversation. Only the
        name appears in the thread.
      </div>

      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name — e.g. vps2_root_ssh_key"
        style={field}
        className="mono"
      />
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="paste the secret here (password, API key, private key…)"
        rows={4}
        spellCheck={false}
        autoComplete="off"
        style={{ ...field, resize: "vertical", fontFamily: "ui-monospace, monospace" }}
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="optional note — what it's for"
        style={field}
      />

      {err && (
        <div className="mono" style={{ fontSize: 10.5, color: tokens.bleed }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onClose}
          className="mono"
          style={{
            background: "transparent",
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            color: tokens.textMuted,
            fontSize: 11,
            padding: "6px 10px",
            cursor: "pointer",
          }}
        >
          cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !name.trim() || !value}
          className="mono"
          style={{
            background: tokens.accent,
            border: "none",
            borderRadius: 6,
            color: tokens.bgBody,
            fontSize: 11,
            padding: "6px 12px",
            cursor: busy ? "default" : "pointer",
            opacity: busy || !name.trim() || !value ? 0.5 : 1,
          }}
        >
          {busy ? "storing…" : "store secret"}
        </button>
      </div>
    </div>
  );
}
