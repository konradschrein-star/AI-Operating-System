"use client";

/**
 * SecretsPanel — native high-density secrets and credentials management.
 *
 * Encrypted at rest (AES-256-GCM) under /opt/ai-os/.secrets/store/.
 * Add, reveal, copy, rotate, and delete credentials. Values are held
 * ephemerally in React state only while active.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { tokens } from "../../tokens";

export interface SecretMetaItem {
  name: string;
  bytes: number;
  createdAt?: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  accessCount?: number;
  serviceTag?: string | null;
  note: string | null;
  pending: boolean;
  requestedByRunId: string | null;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function SecretsPanel(): JSX.Element {
  const [secrets, setSecrets] = useState<SecretMetaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Ephemeral in-memory reveal store: map of name -> plaintext value.
  // Values are dropped immediately on unmount, Hide, or list reload.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<Record<string, boolean>>({});

  // Modals state
  const [showAddModal, setShowAddModal] = useState(false);
  const [rotatingSecret, setRotatingSecret] = useState<SecretMetaItem | null>(null);

  // Form states
  const [formName, setFormName] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formTag, setFormTag] = useState("");
  const [formNote, setFormNote] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/secrets", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { secrets?: SecretMetaItem[] };
      setSecrets(data.secrets ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSecrets([]);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      // Clear in-memory secrets on unmount
      setRevealed({});
    };
  }, [load]);

  const handleReveal = async (name: string) => {
    if (busy) return;
    setBusy(`${name}:reveal`);
    setError(null);
    try {
      const res = await fetch(`/api/proxy/secrets/${encodeURIComponent(name)}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { value: string };
      setRevealed((prev) => ({ ...prev, [name]: data.value }));
      // Reload to update lastUsedAt, accessCount, and clear pending badge if it was set
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleHide = (name: string) => {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleCopy = async (name: string) => {
    const val = revealed[name];
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      setCopied((prev) => ({ ...prev, [name]: true }));
      setTimeout(() => {
        setCopied((prev) => ({ ...prev, [name]: false }));
      }, 1500);
    } catch {
      // Clipboard write failed
    }
  };

  const handleDismissPending = async (name: string) => {
    if (busy) return;
    setBusy(`${name}:dismiss`);
    try {
      const res = await fetch(`/api/proxy/secrets/${encodeURIComponent(name)}/clear-pending`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (name: string) => {
    if (busy) return;
    if (!confirm(`Delete secret "${name}"? Ciphertext and metadata will be permanently removed.`)) {
      return;
    }
    setBusy(`${name}:delete`);
    try {
      const res = await fetch(`/api/proxy/secrets/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      handleHide(name);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submitAddSecret = async () => {
    if (!formName.trim() || !formValue) {
      setModalError("Secret name and value are required.");
      return;
    }
    setBusy("add:submit");
    setModalError(null);
    try {
      const res = await fetch("/api/proxy/secrets", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          value: formValue,
          service_tag: formTag.trim() || undefined,
          note: formNote.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      setShowAddModal(false);
      setFormName("");
      setFormValue("");
      setFormTag("");
      setFormNote("");
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submitRotateSecret = async () => {
    if (!rotatingSecret || !formValue) {
      setModalError("New secret value is required.");
      return;
    }
    setBusy("rotate:submit");
    setModalError(null);
    try {
      const res = await fetch(`/api/proxy/secrets/${encodeURIComponent(rotatingSecret.name)}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        /* ALWAYS SEND BOTH FIELDS, even when blank. The modal seeds these
           inputs from the stored tag and note, so what is in them when Rotate
           is pressed is the intended end state — and clearing one has to mean
           "remove it". Sending `undefined` here omits the key entirely, which
           the route reads as "leave alone", so a tag could be changed but
           never removed. `""` is the explicit clear; `null` works too. */
        body: JSON.stringify({
          value: formValue,
          service_tag: formTag.trim(),
          note: formNote.trim(),
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      handleHide(rotatingSecret.name);
      setRotatingSecret(null);
      setFormValue("");
      setFormTag("");
      setFormNote("");
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const filtered = useMemo(() => {
    if (!secrets) return [];
    const q = search.trim().toLowerCase();
    if (!q) return secrets;
    return secrets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.serviceTag && s.serviceTag.toLowerCase().includes(q)) ||
        (s.note && s.note.toLowerCase().includes(q)),
    );
  }, [secrets, search]);

  const pendingCount = (secrets ?? []).filter((s) => s.pending).length;

  return (
    <div data-settings-secrets style={{ maxWidth: 940 }}>
      {/* Top Header & Actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi }}>
            Encrypted Secrets Store
          </div>
          <div style={{ fontSize: 12, color: tokens.textSoft, marginTop: 2 }}>
            Encrypted at rest (AES-256-GCM) under <span className="mono">/opt/ai-os/.secrets/store/</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="text"
            placeholder="Filter secrets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              color: tokens.text,
              fontSize: 12,
              padding: "6px 10px",
              width: 180,
            }}
          />
          <button
            type="button"
            onClick={() => {
              setFormName("");
              setFormValue("");
              setFormTag("");
              setFormNote("");
              setModalError(null);
              setShowAddModal(true);
            }}
            style={{
              background: tokens.accent,
              color: tokens.bgBody,
              border: "none",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            + Add Secret
          </button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div
          className="mono"
          style={{
            background: tokens.freezeBgWarn,
            border: `1px solid ${tokens.freezeBorderWarn}`,
            color: tokens.warn,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>
            ⚡ {pendingCount} credential{pendingCount === 1 ? "" : "s"} waiting for you — reveal to mark collected.
          </span>
        </div>
      )}

      {error && (
        <div
          style={{
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 12.5,
            color: tokens.bleed,
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Secrets Table / List */}
      {secrets && secrets.length === 0 && !error && (
        <div
          className="mono"
          style={{
            background: tokens.bgCard,
            border: `1px dashed ${tokens.border}`,
            borderRadius: 8,
            padding: 32,
            textAlign: "center",
            fontSize: 12,
            color: tokens.textFaint,
          }}
        >
          No secrets stored in vault yet. Click "+ Add Secret" to register a credential.
        </div>
      )}

      {secrets && secrets.length > 0 && filtered.length === 0 && (
        <div
          className="mono"
          style={{
            background: tokens.bgCard,
            border: `1px dashed ${tokens.border}`,
            borderRadius: 8,
            padding: 24,
            textAlign: "center",
            fontSize: 12,
            color: tokens.textFaint,
          }}
        >
          No secrets match &ldquo;{search}&rdquo;.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map((s) => {
          const isRevealed = revealed[s.name] !== undefined;
          const secretVal = revealed[s.name];
          const isCopied = copied[s.name] === true;
          const isBusy = busy?.startsWith(`${s.name}:`);

          return (
            <div
              key={s.name}
              style={{
                background: tokens.bgCard,
                border: `1px solid ${s.pending ? tokens.freezeBorderWarn : tokens.border}`,
                borderLeft: `3px solid ${s.pending ? tokens.warn : tokens.borderEmphasis}`,
                borderRadius: 10,
                padding: "12px 16px",
              }}
            >
              {/* Row Header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="ms" style={{ fontSize: 16, color: tokens.textMuted }}>
                    key
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 13.5, fontWeight: 600, color: tokens.textHi }}
                  >
                    {s.name}
                  </span>
                  {s.serviceTag && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        background: tokens.bgGutter,
                        border: `1px solid ${tokens.borderSoft}`,
                        borderRadius: 4,
                        padding: "1px 6px",
                        color: tokens.textSoft,
                      }}
                    >
                      {s.serviceTag}
                    </span>
                  )}
                  {s.pending && (
                    <span
                      className="mono"
                      style={{
                        background: tokens.freezeBgWarn,
                        color: tokens.warn,
                        borderRadius: 4,
                        padding: "1px 6px",
                        fontSize: 10,
                        fontWeight: 600,
                      }}
                    >
                      FOR YOU
                    </span>
                  )}
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      background: tokens.bgGutter,
                      color: tokens.textFaint,
                      borderRadius: 4,
                      padding: "1px 5px",
                    }}
                  >
                    AES-256-GCM
                  </span>
                </div>

                {/* Metadata badges & timestamps */}
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: tokens.textFaint,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span>{formatBytes(s.bytes)}</span>
                  <span>updated {timeAgo(s.updatedAt)}</span>
                  {s.lastUsedAt && <span>used {timeAgo(s.lastUsedAt)}</span>}
                </div>
              </div>

              {/* Note or Lineage */}
              {s.note && (
                <div
                  style={{
                    fontSize: 12,
                    color: tokens.textSoft,
                    marginTop: 6,
                    lineHeight: 1.45,
                  }}
                >
                  {s.note}
                </div>
              )}

              {/* Ephemeral Reveal Box */}
              {isRevealed && (
                <div
                  style={{
                    marginTop: 10,
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
                      letterSpacing: "0.08em",
                      marginBottom: 4,
                    }}
                  >
                    VALUE (IN-MEMORY ONLY)
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 0,
                      fontSize: 12,
                      color: tokens.textHi,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      userSelect: "all",
                      WebkitUserSelect: "all",
                    }}
                  >
                    {secretVal}
                  </pre>
                </div>
              )}

              {/* Action Buttons */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 10,
                  flexWrap: "wrap",
                }}
              >
                {!isRevealed ? (
                  <button
                    type="button"
                    onClick={() => void handleReveal(s.name)}
                    disabled={isBusy}
                    style={actionBtnStyle(tokens.primaryActionBg, tokens.border, tokens.textHi)}
                  >
                    {busy === `${s.name}:reveal` ? "revealing…" : "Reveal"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCopy(s.name)}
                      style={actionBtnStyle(tokens.okActionBg, tokens.okActionBorder, tokens.ok)}
                    >
                      {isCopied ? "copied ✓" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleHide(s.name)}
                      style={actionBtnStyle(tokens.toolBg, tokens.border, tokens.textMuted)}
                    >
                      Hide
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setRotatingSecret(s);
                    setFormValue("");
                    setFormTag(s.serviceTag ?? "");
                    setFormNote(s.note ?? "");
                    setModalError(null);
                  }}
                  disabled={isBusy}
                  style={actionBtnStyle(tokens.toolBg, tokens.border, tokens.textMuted)}
                >
                  Rotate
                </button>

                {s.pending && (
                  <button
                    type="button"
                    onClick={() => void handleDismissPending(s.name)}
                    disabled={isBusy}
                    style={actionBtnStyle(tokens.toolBg, tokens.border, tokens.textMuted)}
                  >
                    {busy === `${s.name}:dismiss` ? "dismissing…" : "Dismiss flag"}
                  </button>
                )}

                <span style={{ flex: 1 }} />

                <button
                  type="button"
                  onClick={() => void handleDelete(s.name)}
                  disabled={isBusy}
                  style={actionBtnStyle(tokens.dangerActionBg, tokens.dangerActionBorder, tokens.bleed)}
                >
                  {busy === `${s.name}:delete` ? "deleting…" : "Delete"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Secret Modal */}
      {showAddModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: tokens.overlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 12,
              padding: 22,
              maxWidth: 520,
              width: "100%",
              boxShadow: `0 12px 36px ${tokens.shadowLift}`,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi, marginBottom: 4 }}>
              Add New Secret
            </div>
            <div style={{ fontSize: 12, color: tokens.textSoft, marginBottom: 16 }}>
              Value is encrypted with AES-256-GCM immediately and never written to transcripts or logs.
            </div>

            {modalError && (
              <div
                style={{
                  background: tokens.dangerActionBg,
                  border: `1px solid ${tokens.dangerActionBorder}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  fontSize: 12,
                  color: tokens.bleed,
                  marginBottom: 14,
                }}
              >
                {modalError}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label
                  className="mono"
                  style={{ fontSize: 11, color: tokens.textLabel, display: "block", marginBottom: 4 }}
                >
                  SECRET NAME *
                </label>
                <input
                  type="text"
                  placeholder="e.g. stripe-api-key, github-pat-konrad"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  style={inputStyle()}
                />
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <label className="mono" style={{ fontSize: 11, color: tokens.textLabel }}>
                    SECRET VALUE *
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    style={{
                      background: "none",
                      border: "none",
                      color: tokens.accent,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {showPassword ? "Hide Mask" : "Show Value"}
                  </button>
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Paste secret / API key / token value…"
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  style={inputStyle()}
                />
              </div>

              <div>
                <label
                  className="mono"
                  style={{ fontSize: 11, color: tokens.textLabel, display: "block", marginBottom: 4 }}
                >
                  SERVICE TAG (OPTIONAL)
                </label>
                <input
                  type="text"
                  placeholder="e.g. github, stripe, twenty-crm, telegram"
                  value={formTag}
                  onChange={(e) => setFormTag(e.target.value)}
                  style={inputStyle()}
                />
              </div>

              <div>
                <label
                  className="mono"
                  style={{ fontSize: 11, color: tokens.textLabel, display: "block", marginBottom: 4 }}
                >
                  NOTE / PURPOSE (OPTIONAL)
                </label>
                <textarea
                  placeholder="Short description of what this credential is for…"
                  value={formNote}
                  onChange={(e) => setFormNote(e.target.value)}
                  rows={2}
                  style={{ ...inputStyle(), resize: "vertical" }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                disabled={busy === "add:submit"}
                style={actionBtnStyle(tokens.toolBg, tokens.border, tokens.textMuted)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitAddSecret()}
                disabled={busy === "add:submit"}
                style={{
                  background: tokens.accent,
                  color: tokens.bgBody,
                  border: "none",
                  borderRadius: 6,
                  padding: "7px 16px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {busy === "add:submit" ? "Saving…" : "Save Secret"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rotate Secret Modal */}
      {rotatingSecret && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: tokens.overlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 12,
              padding: 22,
              maxWidth: 520,
              width: "100%",
              boxShadow: `0 12px 36px ${tokens.shadowLift}`,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600, color: tokens.textHi, marginBottom: 4 }}>
              Rotate Secret: <span className="mono">{rotatingSecret.name}</span>
            </div>
            <div style={{ fontSize: 12, color: tokens.textSoft, marginBottom: 16 }}>
              Replaces the encrypted ciphertext in place and updates metadata.
            </div>

            {modalError && (
              <div
                style={{
                  background: tokens.dangerActionBg,
                  border: `1px solid ${tokens.dangerActionBorder}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  fontSize: 12,
                  color: tokens.bleed,
                  marginBottom: 14,
                }}
              >
                {modalError}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <label className="mono" style={{ fontSize: 11, color: tokens.textLabel }}>
                    NEW SECRET VALUE *
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    style={{
                      background: "none",
                      border: "none",
                      color: tokens.accent,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    {showPassword ? "Hide Mask" : "Show Value"}
                  </button>
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Paste rotated secret value…"
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  style={inputStyle()}
                />
              </div>

              <div>
                <label
                  className="mono"
                  style={{ fontSize: 11, color: tokens.textLabel, display: "block", marginBottom: 4 }}
                >
                  SERVICE TAG
                </label>
                <input
                  type="text"
                  placeholder="e.g. github, stripe, twenty-crm"
                  value={formTag}
                  onChange={(e) => setFormTag(e.target.value)}
                  style={inputStyle()}
                />
              </div>

              <div>
                <label
                  className="mono"
                  style={{ fontSize: 11, color: tokens.textLabel, display: "block", marginBottom: 4 }}
                >
                  NOTE / PURPOSE
                </label>
                <textarea
                  placeholder="Updated note or context…"
                  value={formNote}
                  onChange={(e) => setFormNote(e.target.value)}
                  rows={2}
                  style={{ ...inputStyle(), resize: "vertical" }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
              <button
                type="button"
                onClick={() => setRotatingSecret(null)}
                disabled={busy === "rotate:submit"}
                style={actionBtnStyle(tokens.toolBg, tokens.border, tokens.textMuted)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitRotateSecret()}
                disabled={busy === "rotate:submit"}
                style={{
                  background: tokens.accent,
                  color: tokens.bgBody,
                  border: "none",
                  borderRadius: 6,
                  padding: "7px 16px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {busy === "rotate:submit" ? "Rotating…" : "Rotate Secret"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    background: tokens.bgBody,
    border: `1px solid ${tokens.border}`,
    borderRadius: 6,
    color: tokens.text,
    fontSize: 12.5,
    padding: "7px 10px",
    boxSizing: "border-box",
  };
}

function actionBtnStyle(bg: string, border: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 6,
    color: fg,
    cursor: "pointer",
    fontSize: 11.5,
    padding: "4px 10px",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  };
}

