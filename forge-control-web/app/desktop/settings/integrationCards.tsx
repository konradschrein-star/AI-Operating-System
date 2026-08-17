"use client";

/**
 * The two outside-service cards: `GeminiCard` and `GoogleCard`.
 * (This file was `IntegrationsPanel.tsx` until round 1876.)
 *
 * Round 1876 folded settings' ACCOUNTS and INTEGRATIONS sections into one
 * CONNECTIONS surface, because Konrad could not tell from either of them how
 * to wire an account in ("the settings are still a bit confusing, especially
 * with connecting accounts, Claude accounts, like wiring them in and wiring in
 * Google accounts"). The `IntegrationsPanel` wrapper that used to pair these
 * two is gone with the section it filled: `ConnectionsPanel` now mounts each
 * card UNDER its own summary row, and a component nothing mounts is a lie
 * about the shape of the app. Each card reports its loaded state upward
 * through `onFacts` so the row above it needs no second fetch.
 *
 * Two subjects, both backed by `forge-control/src/routes/integrations.ts`:
 *
 *   GEMINI  — paste-in API key (secret store, never the database, never echoed
 *             back), a live reachability test, and OUR OWN spend count.
 *   GOOGLE  — the Gmail/Calendar/Drive consent this box already runs on, and
 *             the exact command to re-authorise it.
 *
 * ── What this panel deliberately does NOT render ─────────────────────────
 * (round 1302 research, docs/plan/operator-visibility/artifacts/phase1700/
 * gemini-ultra-oauth.md §6 — read it before adding anything here)
 *
 *   • No "Connect Google AI Ultra" button. No OAuth flow turns a consumer
 *     Ultra subscription into programmatic Gemini access; Google closed the
 *     last one on 2026-06-18. A button would lead to a shut door.
 *   • No Gemini percentage bar. The Gemini API publishes no quota endpoint at
 *     all, so a filled bar would need a denominator we would have to invent —
 *     and an invented denominator is worse than no bar. When we have counted
 *     nothing, this panel says so in a sentence.
 *   • No claim that the API key replaces the Gemini Pool on :8090. The pool
 *     stays the free default path; the key is the higher-quality opt-in.
 *
 * ── Honesty rules ───────────────────────────────────────────────────────
 *   • The key is write-only from the browser's point of view. It goes up in a
 *     POST body and comes back as `…last4`; the input is type=password and its
 *     value is dropped from state the moment the save succeeds.
 *   • "We cannot tell" never renders as "zero". A usage query that fails shows
 *     an error, not an empty meter.
 *   • The Google email is null until a live check answers, because the
 *     credential file does not record it. A hardcoded address would be
 *     decoration, not a reading.
 *   • Re-auth is a COMMAND, not a button: setup.py needs a human at a browser
 *     for the localhost:8765 redirect. A button that silently did nothing
 *     would be the fake success state this panel exists to avoid.
 *
 * Colours are `tokens.*` (CSS variables) only — no hex, no rgb, both themes.
 * There is no polling: this surface loads on mount and after each action.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { tokens } from "../../tokens";
import type { GoogleFacts } from "./connections";

/* ── Wire shapes (mirror routes/integrations.ts) ─────────────────────────── */

interface KeyStatus {
  present: boolean;
  masked: string | null;
  stored_at: string | null;
  bytes: number | null;
  path: string;
}

interface GeminiStatus {
  key: KeyStatus;
  default_model: string;
  pool: { url: string; role: string };
  api_role: string;
}

interface ReachableModel {
  id: string;
  display_name: string | null;
  input_token_limit: number | null;
  output_token_limit: number | null;
}

type TestVerdict =
  | {
      ok: true;
      models: ReachableModel[];
      count: number;
      truncated: boolean;
      checked_at: string;
    }
  | {
      ok: false;
      reason: string;
      message: string;
      http_status: number | null;
      upstream: string | null;
      checked_at: string;
    };

interface UsageProvider {
  provider: string;
  rows_5h: number;
  eur_5h: number;
  rows_7d: number;
  eur_7d: number;
  rows_lookback: number;
  eur_lookback: number;
}

interface GeminiUsage {
  counted: boolean;
  lookback_days: number;
  providers: UsageProvider[];
  totals: { rows_5h: number; eur_5h: number; rows_7d: number; eur_7d: number };
  why_empty: string;
  basis: string;
}

interface GoogleAccount {
  id: string;
  email: string | null;
  scopes: string[];
  has_refresh_token: boolean;
  client_id: string | null;
  connected_at: string | null;
  access_expires_at: string | null;
  token_path: string;
}

interface GoogleCheck {
  ok: boolean;
  email: string | null;
  reason: string | null;
  message: string;
  checked_at: string;
}

interface GoogleStatus {
  accounts: GoogleAccount[];
  last_check: GoogleCheck | null;
  reauth: { command: string; interactive: boolean; why: string };
  detail?: string;
}

/* ── Fetch helpers ───────────────────────────────────────────────────────── */

const API = "/api/proxy/integrations";

/** One reader for every call on this panel. Throws with the server's own
 *  diagnostic rather than a bare status — a settings panel that says "failed"
 *  and nothing else is why the last two rounds of this project exist. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `${path} answered ${res.status} with a body that is not JSON: ${text.slice(0, 160)}`,
    );
  }
  if (!res.ok) {
    const body = parsed as { error?: string; detail?: string; message?: string };
    const why = body?.detail ?? body?.error ?? body?.message ?? `HTTP ${res.status}`;
    throw new Error(why);
  }
  return parsed as T;
}

/* ── Small presentational pieces ─────────────────────────────────────────── */

function card(): CSSProperties {
  return {
    background: tokens.bgCard,
    border: `1px solid ${tokens.border}`,
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
  };
}

function btn(bg: string, border: string): CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 7,
    color: tokens.text,
    cursor: "pointer",
    fontSize: 12,
    padding: "6px 12px",
  };
}

function Label({ text }: { text: string }): JSX.Element {
  return (
    <div className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
      {text}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <Label text={label} />
      <div style={{ color: tokens.textBody, marginTop: 2, wordBreak: "break-word" }}>
        {value}
      </div>
    </div>
  );
}

function Chip({
  text,
  fg,
  bg,
}: {
  text: string;
  fg: string;
  bg: string;
}): JSX.Element {
  return (
    <span
      className="mono"
      style={{
        background: bg,
        color: fg,
        borderRadius: 5,
        padding: "2px 7px",
        fontSize: 10.5,
      }}
    >
      {text}
    </span>
  );
}

function CardHead({
  title,
  note,
  right,
}: {
  title: string;
  note?: string;
  right?: JSX.Element;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        marginBottom: 12,
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
      {note && (
        <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
          {note}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "bad" | "ok" | "info";
  children: React.ReactNode;
}): JSX.Element {
  /* `info` is deliberately the NEUTRAL gutter surface rather than
   * `invariantBg`: in the light palette that token is a warm pink, which sat
   * next to the red failure banner and read as a second warning. Verified in
   * both themes with a screenshot before it was changed. */
  const skin =
    tone === "bad"
      ? { bg: tokens.dangerActionBg, border: tokens.dangerActionBorder }
      : tone === "ok"
        ? { bg: tokens.okActionBg, border: tokens.okActionBorder }
        : { bg: tokens.bgGutter, border: tokens.borderSoft };
  return (
    <div
      style={{
        background: skin.bg,
        border: `1px solid ${skin.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        marginTop: 12,
        fontSize: 12.5,
        lineHeight: 1.55,
        color: tokens.textBody,
      }}
    >
      {children}
    </div>
  );
}

/** The re-auth affordance: a command, not a button. See the file header. */
function CommandBlock({ command, why }: { command: string; why: string }): JSX.Element {
  return (
    <div
      style={{
        marginTop: 12,
        background: tokens.bgGutter,
        border: `1px solid ${tokens.borderSoft}`,
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 12.5, marginBottom: 6, color: tokens.textBody }}>
        Re-authorise this account (interactive — run it on the VPS):
      </div>
      <code
        className="mono"
        style={{ fontSize: 12, color: tokens.textHi, wordBreak: "break-all" }}
      >
        {command}
      </code>
      <div style={{ fontSize: 11.5, color: tokens.textFaint, marginTop: 6 }}>{why}</div>
    </div>
  );
}

function stamp(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString();
}

function eur(n: number): string {
  return `€${n.toFixed(n < 1 ? 4 : 2)}`;
}

/* ── Gemini ──────────────────────────────────────────────────────────────── */

/** What the summary row above this card needs to know. Reported upward
 *  instead of re-fetched: the Connections surface renders one row and one card
 *  per subject, and two fetches for one subject is the shape round 1876 is
 *  busy deleting. */
export interface GeminiKeyFacts {
  present: boolean | null;
  masked: string | null;
  verdict: { ok: boolean; message?: string } | null;
}

export function GeminiCard({
  onFacts,
}: {
  onFacts?: (f: GeminiKeyFacts) => void;
} = {}): JSX.Element {
  const [status, setStatus] = useState<GeminiStatus | null>(null);
  const [usage, setUsage] = useState<GeminiUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [verdict, setVerdict] = useState<TestVerdict | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await call<GeminiStatus>("/gemini"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // The usage query has its own error slot on purpose: a database that will
    // not answer must not blank out the key controls, and must not render as
    // "we spent nothing" either.
    try {
      setUsage(await call<GeminiUsage>("/gemini/usage"));
      setUsageError(null);
    } catch (e) {
      setUsage(null);
      setUsageError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy("save");
    setError(null);
    try {
      const res = await call<{ key: KeyStatus }>("/gemini/key", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      setStatus((s) => (s ? { ...s, key: res.key } : s));
      // Drop the value from React state the moment it is stored. It exists in
      // exactly one place afterwards: the 0600 file on disk.
      setDraft("");
      setVerdict(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [draft]);

  const test = useCallback(async () => {
    setBusy("test");
    setError(null);
    try {
      setVerdict(await call<TestVerdict>("/gemini/test", { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const remove = useCallback(async () => {
    setBusy("remove");
    setError(null);
    try {
      const res = await call<{ deleted: boolean; key: KeyStatus }>("/gemini/key", {
        method: "DELETE",
      });
      setStatus((s) => (s ? { ...s, key: res.key } : s));
      setVerdict(null);
      setConfirmRemove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const present = status?.key.present === true;

  // Report after paint, never during render. The dependency list settles after
  // one pass because these three values only change on a load or an action.
  useEffect(() => {
    if (!onFacts) return;
    onFacts({
      present: status === null ? null : present,
      masked: status?.key.masked ?? null,
      verdict:
        verdict === null
          ? null
          : { ok: verdict.ok, message: verdict.ok ? undefined : verdict.message },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, verdict, present]);

  const models = verdict?.ok ? verdict.models : [];
  const shown = showAllModels ? models : models.slice(0, 12);

  return (
    <div data-gemini-card style={card()}>
      <CardHead
        title="Gemini API"
        note={status ? `default model ${status.default_model}` : undefined}
        right={
          status ? (
            present ? (
              <Chip text="KEY STORED" fg={tokens.ok} bg={tokens.freezeBgOk} />
            ) : (
              <Chip text="NO KEY" fg={tokens.warn} bg={tokens.freezeBgWarn} />
            )
          ) : undefined
        }
      />

      {status && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
            gap: 10,
            fontSize: 12.5,
            marginBottom: 14,
          }}
        >
          <Field label="KEY" value={present ? (status.key.masked ?? "…") : "not stored"} />
          <Field label="STORED AT" value={stamp(status.key.stored_at)} />
          <Field label="LOCATION" value={status.key.path} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={present ? "paste a new key to replace it" : "paste your AI Studio API key"}
          style={{
            flex: "1 1 280px",
            background: tokens.inputBg,
            border: `1px solid ${tokens.border}`,
            borderRadius: 7,
            color: tokens.text,
            fontSize: 12.5,
            padding: "7px 10px",
          }}
        />
        <button
          onClick={() => void save()}
          disabled={busy !== null || draft.trim() === ""}
          style={btn(tokens.primaryActionBg, tokens.border)}
        >
          {busy === "save" ? "saving…" : "Save"}
        </button>
        <button
          onClick={() => void test()}
          disabled={busy !== null || !present}
          style={btn(tokens.toolBg, tokens.border)}
        >
          {busy === "test" ? "testing…" : "Test connection"}
        </button>
        {present &&
          (confirmRemove ? (
            <>
              <button
                onClick={() => void remove()}
                disabled={busy !== null}
                style={btn(tokens.dangerActionBg, tokens.dangerActionBorder)}
              >
                {busy === "remove" ? "removing…" : "Confirm remove"}
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                disabled={busy !== null}
                style={btn(tokens.toolBg, tokens.border)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={busy !== null}
              style={btn(tokens.toolBg, tokens.border)}
            >
              Remove
            </button>
          ))}
      </div>

      <div style={{ fontSize: 11.5, color: tokens.textFaint, marginTop: 8 }}>
        The key is written to the secret store on disk (0600, root). It never
        enters the database, a chat thread, or any response from this panel —
        reads show the last four characters only.
      </div>

      {error && <Banner tone="bad">{error}</Banner>}

      {verdict && !verdict.ok && (
        <Banner tone="bad">
          <strong>Not connected.</strong>
          <div style={{ marginTop: 4 }}>{verdict.message}</div>
          {verdict.upstream && (
            <pre
              className="mono"
              style={{
                marginTop: 8,
                marginBottom: 0,
                fontSize: 11,
                color: tokens.textSoft,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 160,
                overflow: "auto",
              }}
            >
              {verdict.upstream}
            </pre>
          )}
          <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, marginTop: 6 }}>
            checked {stamp(verdict.checked_at)}
          </div>
        </Banner>
      )}

      {verdict?.ok && (
        <Banner tone="ok">
          <strong>
            Connected — {verdict.count} model{verdict.count === 1 ? "" : "s"} reachable
            {verdict.truncated ? " (list paged by Google — more exist)" : ""}.
          </strong>
          {status && (
            <div style={{ marginTop: 4 }}>
              {models.some((m) => m.id === status.default_model)
                ? `Including ${status.default_model}, the model this OS defaults to.`
                : `${status.default_model} was NOT in the list — this key cannot serve the default model.`}
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
              gap: "2px 12px",
              marginTop: 8,
            }}
          >
            {shown.map((m) => (
              <div
                key={m.id}
                className="mono"
                style={{ fontSize: 11.5, color: tokens.textSoft }}
                title={
                  m.input_token_limit !== null
                    ? `${m.display_name ?? m.id} · ${m.input_token_limit.toLocaleString()} in / ${(m.output_token_limit ?? 0).toLocaleString()} out`
                    : (m.display_name ?? m.id)
                }
              >
                {m.id}
              </div>
            ))}
          </div>
          {models.length > 12 && (
            <button
              onClick={() => setShowAllModels((v) => !v)}
              style={{ ...btn(tokens.toolBg, tokens.border), marginTop: 8 }}
            >
              {showAllModels ? "Show fewer" : `Show all ${models.length}`}
            </button>
          )}
          <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, marginTop: 6 }}>
            checked {stamp(verdict.checked_at)}
          </div>
        </Banner>
      )}

      {status && (
        <Banner tone="info">
          <div>
            <strong>The Gemini Pool stays the default.</strong> {status.pool.url} —{" "}
            {status.pool.role}. It is not removed and nothing here routes around it.
          </div>
          <div style={{ marginTop: 4 }}>
            The API key is the other half of the split — {status.api_role}.
          </div>
        </Banner>
      )}

      {/* Usage — our own count, or an honest sentence. Never a bar. */}
      <div style={{ marginTop: 16 }}>
        <Label text="GEMINI USAGE" />
        {usageError && (
          <Banner tone="bad">
            <strong>Usage unknown.</strong> The spend log did not answer, so this
            is not zero — it is unread. {usageError}
          </Banner>
        )}
        {usage && !usage.counted && (
          <div
            style={{
              fontSize: 12.5,
              color: tokens.textSoft,
              lineHeight: 1.55,
              marginTop: 6,
            }}
          >
            {usage.why_empty}
            <div style={{ color: tokens.textFaint, marginTop: 4 }}>
              No percentage is drawn here on purpose: Google publishes no quota
              endpoint for the Gemini API, so any filled bar would need a
              denominator we invented.
            </div>
          </div>
        )}
        {usage?.counted && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
                gap: 10,
                fontSize: 12.5,
                marginTop: 6,
              }}
            >
              <Field
                label="LAST 5 HOURS (OUR COUNT)"
                value={`${usage.totals.rows_5h} calls · ${eur(usage.totals.eur_5h)}`}
              />
              <Field
                label="LAST 7 DAYS (OUR COUNT)"
                value={`${usage.totals.rows_7d} calls · ${eur(usage.totals.eur_7d)}`}
              />
            </div>
            <div style={{ fontSize: 11.5, color: tokens.textFaint, marginTop: 6 }}>
              {usage.basis}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Google account ──────────────────────────────────────────────────────── */

export function GoogleCard({
  onFacts,
}: {
  onFacts?: (f: GoogleFacts) => void;
} = {}): JSX.Element {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<GoogleCheck | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await call<GoogleStatus>("/google");
      setStatus(res);
      setCheck(res.last_check);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await call<GoogleCheck>("/google/test", { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const accounts = status?.accounts ?? [];

  useEffect(() => {
    if (!onFacts || !status) return;
    const a = accounts[0];
    onFacts({
      hasAccount: a !== undefined,
      hasRefreshToken: a?.has_refresh_token ?? false,
      email: check?.email ?? a?.email ?? null,
      scopeCount: a?.scopes.length ?? 0,
      checkOk: check === null ? null : check.ok,
      checkMessage: check?.message ?? null,
      reauthCommand: status.reauth.command,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, check]);

  return (
    <div data-google-card style={card()}>
      <CardHead
        title="Google account"
        note="Gmail · Calendar · Drive · Docs · Sheets · Contacts"
        right={
          <button
            onClick={() => void runCheck()}
            disabled={busy || accounts.length === 0}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {busy ? "checking…" : "Check connection"}
          </button>
        }
      />

      {error && <Banner tone="bad">{error}</Banner>}

      {status && accounts.length === 0 && (
        <Banner tone="bad">
          <strong>No Google account is connected.</strong>
          <div style={{ marginTop: 4 }}>{status.detail ?? "No credential file was found."}</div>
        </Banner>
      )}

      {/* One account today. The list shape is plural so a second credential
          needs no new contract — and there is deliberately no second OAuth
          client to add one with. */}
      {accounts.map((a) => (
        <div
          key={a.id}
          style={{
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 14 }}>
              {a.email ?? "address not recorded in the credential file"}
            </span>
            {check?.ok === true && (
              <Chip text="CONNECTED" fg={tokens.ok} bg={tokens.freezeBgOk} />
            )}
            {check?.ok === false && (
              <Chip
                text={check.reason === "invalid_grant" ? "INVALID GRANT" : "NOT ANSWERING"}
                fg={tokens.bleed}
                bg={tokens.dangerActionBg}
              />
            )}
            {check === null && (
              <Chip text="UNVERIFIED" fg={tokens.warn} bg={tokens.freezeBgWarn} />
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
              gap: 10,
              fontSize: 12.5,
            }}
          >
            <Field label="CONSENT WRITTEN" value={stamp(a.connected_at)} />
            <Field
              label="REFRESH TOKEN"
              value={a.has_refresh_token ? "present" : "MISSING"}
            />
            <Field label="SCOPES" value={String(a.scopes.length)} />
            <Field label="LAST CHECK" value={check ? stamp(check.checked_at) : "never"} />
          </div>

          <div style={{ marginTop: 12 }}>
            <Label text="GRANTED SCOPES" />
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginTop: 6,
              }}
            >
              {a.scopes.map((s) => (
                <span
                  key={s}
                  className="mono"
                  style={{
                    background: tokens.bgGutter,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 5,
                    color: tokens.textSoft,
                    fontSize: 10.5,
                    padding: "2px 7px",
                  }}
                  title={s}
                >
                  {s.replace("https://www.googleapis.com/auth/", "")}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: tokens.textFaint, marginTop: 8 }}>
              No cloud-platform scope, by decision: it would widen this box&rsquo;s
              longest-lived credential to full Google Cloud access and would still
              buy no Gemini access — there is no path from an AI Ultra
              subscription to the API.
            </div>
          </div>

          <div
            className="mono"
            style={{ fontSize: 11, color: tokens.textFaint, marginTop: 10 }}
          >
            {a.token_path}
            {a.client_id ? ` · client ${a.client_id}` : ""}
          </div>

          {check && (
            <Banner tone={check.ok ? "ok" : "bad"}>
              {check.message}
              {check.email && !check.ok && (
                <div style={{ marginTop: 4 }}>Address of record: {check.email}</div>
              )}
            </Banner>
          )}
        </div>
      ))}

      {status && (
        <CommandBlock command={status.reauth.command} why={status.reauth.why} />
      )}
    </div>
  );
}
