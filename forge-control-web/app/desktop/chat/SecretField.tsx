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
 *
 * TWO MODES (U30).
 *   free-form — no `request` prop. Konrad names a secret himself and stores it.
 *               Unchanged from the original field; every addition below is
 *               behind a `request` check so this path stays exactly as it was.
 *   answer    — a `request` prop, produced by `secret-requests.ts` from a
 *               pending `GET /api/secrets` row. An agent asked for a specific
 *               credential and said why. The name is fixed and read-only, the
 *               agent's reason is shown, and storing clears the pending flag.
 *
 * THE NOTE IS UNTRUSTED. `request.note` is text an agent wrote. It is rendered
 * as a plain text node with `white-space: pre-wrap` — no markdown component, no
 * dangerouslySetInnerHTML, no autolinking — and capped at RENDERED_NOTE_CAP.
 * A credential prompt is exactly the place a prompt-injected agent would try to
 * render a convincing "click here to verify" link. Do not soften this.
 *
 * THE VALUE NEVER LEAVES STATE. It is cleared on success, on failure, when the
 * panel closes, and on unmount; and it is never interpolated into an error
 * string, a title, a data-* attribute, or a console call. The error branch
 * renders `e.message` and nothing else.
 */

import { useEffect, useState } from "react";
import { tokens } from "../../tokens";
import { clearSecretPending, storeSecret } from "../../api";
import { capNote, type SecretRequest } from "./secret-requests";

export function SecretField({
  onStored,
  onClose,
  request,
}: {
  /** Called with the stored NAME so the caller can reference it in chat. */
  onStored: (name: string) => void;
  onClose: () => void;
  /** Present → answer mode: an agent is waiting for this exact credential. */
  request?: SecretRequest;
}) {
  const [name, setName] = useState(request ? request.name : "");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** Distinguishes the two things `busy` can mean, so the store button doesn't
   *  claim "storing…" while the "not now" call is the one in flight. Always
   *  false in free-form mode, which is why that mode's labels are unchanged. */
  const [dismissing, setDismissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const answering = request !== undefined;

  // The panel is reused when the surface switches from one pending request to
  // the next. Re-key the fields on that switch — and drop whatever was typed
  // for the previous one, so a half-pasted credential can never be submitted
  // under a different agent's name.
  const requestName = request ? request.name : null;
  useEffect(() => {
    setName(requestName ?? "");
    setValue("");
    setNote("");
    setErr(null);
  }, [requestName]);

  // Hygiene, not protection: React drops the fiber on unmount anyway, but no
  // code path should leave a pasted credential sitting in component state.
  useEffect(() => () => setValue(""), []);

  /** Wipe every field, then hand control back. Used by cancel, "not now", and
   *  the success path — closing must never be the one exit that forgets. */
  const closeClean = () => {
    setValue("");
    setName("");
    setNote("");
    setErr(null);
    onClose();
  };

  const submit = async () => {
    const n = name.trim().toLowerCase();
    if (!n || !value) return;
    setBusy(true);
    setErr(null);
    try {
      // Answer mode: `undefined` note leaves the agent's request text on disk,
      // `false` clears the pending flag so the badge goes away. Free-form mode
      // passes Konrad's own note and leaves the flag alone (it has none).
      const meta = answering
        ? await storeSecret(n, value, undefined, false)
        : await storeSecret(n, value, note.trim() || undefined);
      // Drop the value from memory as soon as it's stored. This is hygiene
      // rather than protection — but leaving a key sitting in React state for
      // the rest of the session is pointless risk.
      setValue("");
      setName("");
      setNote("");
      onStored(meta.name);
      onClose();
    } catch (e) {
      // The value goes even on failure. Konrad re-pastes; the alternative is a
      // credential sitting in state behind an error message for the rest of the
      // session, which is exactly the state this component exists to avoid.
      // The message is rendered as-is: never the value, the name+value, or the
      // request payload.
      setValue("");
      setErr(e instanceof Error ? e.message : "could not store secret");
    } finally {
      setBusy(false);
    }
  };

  /** "not now" — drop the agent's flag without storing anything at all. */
  const decline = async () => {
    if (!request) return;
    setBusy(true);
    setDismissing(true);
    setErr(null);
    try {
      await clearSecretPending(request.name);
      closeClean();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not dismiss the request");
    } finally {
      setBusy(false);
      setDismissing(false);
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

  const noteRender = capNote(request ? request.note : null);

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
      {request && (
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            color: tokens.warn,
            lineHeight: 1.5,
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "baseline",
          }}
        >
          <span>an agent is waiting for</span>
          <span style={{ color: tokens.textHi }}>{request.name}</span>
          {request.requestedByRunId && (
            <span style={{ color: tokens.textFaint }}>
              requested by run {request.requestedByRunId.slice(0, 8)}
            </span>
          )}
        </div>
      )}

      {request && noteRender.text !== "" && (
        <div
          style={{
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 6,
            background: tokens.bgBody,
            padding: "7px 9px",
            fontSize: 11,
            lineHeight: 1.55,
            color: tokens.textSecondary,
            maxHeight: 160,
            overflowY: "auto",
            // Plain text on purpose — see the file header. The agent wrote this.
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {noteRender.text}
          {noteRender.truncated && (
            <span className="mono" style={{ color: tokens.textFaint }}>
              {" "}
              …truncated
            </span>
          )}
        </div>
      )}

      <div
        className="mono"
        style={{ fontSize: 10.5, color: tokens.textMuted, lineHeight: 1.5 }}
      >
        Stored on the server, never written into this conversation. Only the
        name appears in the thread.
      </div>

      <input
        autoFocus={!answering}
        value={name}
        onChange={(e) => setName(e.target.value)}
        readOnly={answering}
        placeholder="name — e.g. vps2_root_ssh_key"
        style={
          answering
            ? { ...field, color: tokens.textMuted, cursor: "default" }
            : field
        }
        className="mono"
      />
      <textarea
        autoFocus={answering}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="paste the secret here (password, API key, private key…)"
        rows={4}
        spellCheck={false}
        autoComplete="off"
        style={{ ...field, resize: "vertical", fontFamily: "ui-monospace, monospace" }}
      />
      {!answering && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="optional note — what it's for"
          style={field}
        />
      )}

      {err && (
        <div className="mono" style={{ fontSize: 10.5, color: tokens.bleed }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {request && (
          <button
            onClick={decline}
            disabled={busy}
            className="mono"
            style={{
              background: "transparent",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              color: tokens.textMuted,
              fontSize: 11,
              padding: "6px 10px",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {dismissing ? "dismissing…" : "not now"}
          </button>
        )}
        <button
          onClick={answering ? closeClean : onClose}
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
          {busy && !dismissing
            ? "storing…"
            : answering
              ? "answer request"
              : "store secret"}
        </button>
      </div>
    </div>
  );
}
