"use client";

/**
 * The outside-service cards: `GeminiCard`, `GoogleCard`, and — added in phase
 * 4 / B4c — `AgyCard` and `GitHubCard`.
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
 * Four subjects, all backed by `forge-control/src/routes/integrations.ts`:
 *
 *   GEMINI  — paste-in API key (secret store, never the database, never echoed
 *             back), a live reachability test, and OUR OWN spend count.
 *   GOOGLE  — the Gmail/Calendar/Drive consent this box already runs on, and
 *             the exact command to re-authorise it.
 *   AGY     — the Antigravity CLI. A state, the verbatim terminal steps, and a
 *             Verify that runs the real `agy models`. No Connect button: see
 *             the block below for why one would be a lie.
 *   GITHUB  — a write-only PAT field over `POST /api/secrets`, and a status
 *             that comes only from a real `GET https://api.github.com/user`.
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
 * ── AND WHAT PHASE 4 / B4c ADDED TO THAT LIST ────────────────────────────
 * (phase0/S-A-agy-flow.md and phase4/agy-flow-affordance.md — read the second
 * one before adding any button to `AgyCard`)
 *
 *   • THIS ONE WAS TRUE UNTIL THE CLI SIGN-IN BROKER EXISTED, AND IS THE ONLY
 *     ENTRY ON THIS LIST THAT HAS EVER BEEN RETIRED. It read: no "Connect agy"
 *     button and no paste-a-code box, because `agy` has no `login` subcommand,
 *     auth is implicit PKCE with
 *     `redirect_uri=https://antigravity.google/oauth-callback` so nothing on
 *     this box catches the callback, and the code has to be pasted into THAT
 *     process's stdin within a HARD-CODED 60 seconds. Every one of those facts
 *     is still true. What changed is the last step of the argument: a browser
 *     control cannot reach that stdin, but forge-control can — it runs the CLI
 *     on a pty under tmux and pastes the code into the waiting prompt
 *     (`PLAN.md` §3). So `AgyCard` and `GeminiCliCard` render `CliAuthConnect`,
 *     and R54 is satisfied the way it always asked to be: the button finishes
 *     the job, and `connected` is still produced only by a probe.
 *   • No "token present" chip on `GitHubCard`. A stored PAT is storage, not
 *     authorisation; only a 200 from `GET https://api.github.com/user`
 *     carrying a `login` produces the connected word. The two states have
 *     deliberately different labels (`NO TOKEN STORED` vs `UNVERIFIED`) so
 *     they can never be read as the same thing.
 *   • No green dot anywhere without a `checked_at` (R57). Every one of these
 *     cards renders its state through `connections.ts#summaryFromStatus`,
 *     which is the only function in this surface that can produce the word
 *     CONNECTED, and it cannot produce it from a null timestamp.
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
import { storeSecret } from "../../api";
import {
  fetchAgyConnection,
  fetchConnections,
  fetchGeminiCliConnection,
  fetchGithubConnection,
  fetchGoogleConnection,
  probeAgyConnection,
  probeGeminiCliConnection,
  probeGithubConnection,
  probeGoogleConnection,
  type AgyFlow,
  type ConnectionStatus,
  type GoogleAccountView,
  type GoogleCheck,
} from "../../api-connections";
import {
  agyConnection,
  geminiCliConnection,
  githubConnection,
  probedAgo,
  type AgyFacts,
  type ConnectionSummary,
  type GeminiCliFacts,
  type GithubFacts,
  type GoogleFacts,
  type Read,
} from "./connections";
import { CliAuthConnect } from "./CliAuthConnect";

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

/* The Google/agy/GitHub wire shapes used to be re-declared here. They now live
 * in `app/api-connections.ts`, imported above — one declaration, mirroring
 * `forge-control/src/lib/connection-status.ts`, so a field added on the server
 * cannot go on being described two different ways in two files. */

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

/* `btn`, `Banner`, `CommandBlock` and `input` are EXPORTED, and the reason is
 * a rule rather than a convenience: `CliAuthConnect.tsx` renders inside these
 * cards, and a control that brought its own button and its own banner would be
 * a second design language growing inside the first one. One definition, two
 * importers. (`input` moved here from `ConnectionsPanel.tsx`, which now imports
 * it — same field, same style, one copy.) */
export function btn(bg: string, border: string): CSSProperties {
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

/** The one text field on this surface. */
export function input(): CSSProperties {
  return {
    background: tokens.bgGutter,
    border: `1px solid ${tokens.border}`,
    borderRadius: 7,
    color: tokens.text,
    display: "block",
    fontSize: 12.5,
    marginTop: 3,
    padding: "6px 9px",
    width: "100%",
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

export function Banner({
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

/**
 * A monospaced line to act on, with the sentence that says what to do with it.
 *
 * It began as the re-auth affordance — a command, not a button, because
 * `setup.py` needs a human at a browser (see the file header). `CliAuthConnect`
 * now shows a consent URL in the same box, so `title` and `marker` are
 * parameters and the default is the sentence this block has always carried.
 * Two boxes that look alike because they ARE alike; the alternative was a
 * second copyable-box style, which is how a surface starts to look assembled
 * out of parts.
 */
export function CommandBlock({
  command,
  why,
  title = "Re-authorise this account (interactive — run it on the VPS):",
  marker,
  copyable = false,
}: {
  command: string;
  why: string;
  title?: string;
  /** A `data-` attribute name stamped on the `<code>`, so a browser check can
   *  find this exact box among several. */
  marker?: string;
  copyable?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const markerProps: Record<string, string> = marker === undefined ? {} : { [marker]: "true" };
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
      <div style={{ fontSize: 12.5, marginBottom: 6, color: tokens.textBody, lineHeight: 1.5 }}>
        {title}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <code
          className="mono"
          {...markerProps}
          style={{ fontSize: 12, color: tokens.textHi, wordBreak: "break-all", flex: 1 }}
        >
          {command}
        </code>
        {copyable && (
          <button
            type="button"
            data-command-copy
            onClick={() => {
              void navigator.clipboard?.writeText(command);
              setCopied(true);
            }}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {copied ? "copied" : "copy"}
          </button>
        )}
      </div>
      {why !== "" && (
        <div style={{ fontSize: 11.5, color: tokens.textFaint, marginTop: 6, lineHeight: 1.5 }}>
          {why}
        </div>
      )}
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

/* ── The connection state chip — phase 4 / B4c ───────────────────────────── */

/**
 * The ONE place a connection state becomes a colour.
 *
 * `connected` is the only entry that reaches a positive token, and nothing can
 * reach `connected` except `summaryFromStatus()`, which cannot produce it from
 * a null `checked_at`. So R57 is enforced by the type of the thing being
 * looked up rather than by a rule somebody has to remember at each call site.
 * Amber for unknown, deliberately the same amber the Claude rows use.
 */
const STATE_SKIN: Record<
  ConnectionSummary["state"],
  { fg: string; bg: string }
> = {
  connected: { fg: tokens.ok, bg: tokens.freezeBgOk },
  unknown: { fg: tokens.warn, bg: tokens.freezeBgWarn },
  broken: { fg: tokens.bleed, bg: tokens.dangerActionBg },
  absent: { fg: tokens.textFaint, bg: tokens.bgGutter },
};

function StateChip({ summary }: { summary: ConnectionSummary }): JSX.Element {
  const skin = STATE_SKIN[summary.state];
  return <Chip text={summary.stateLabel} fg={skin.fg} bg={skin.bg} />;
}

/** "verified 4 min ago" / "never checked". The word in front of the age is
 *  the point: an age with no verb reads as "when we last looked at the file". */
function checkedAgo(checkedAt: string | null): string {
  if (checkedAt === null) return "never checked";
  const at = Date.parse(checkedAt);
  if (Number.isNaN(at)) return `unreadable timestamp ${checkedAt}`;
  return `verified ${probedAgo(Date.now() - at).replace(/^probed /, "")}`;
}

/**
 * The server's re-check cadence, fetched once per page load.
 *
 * Memoised because it is CONFIGURATION, not state: it comes from
 * `CONNECTION_RECHECK_INTERVAL_MS` and changes only when someone edits an env
 * file and restarts forge-control. Three cards each firing their own GET for
 * one integer is three requests to learn the same number.
 *
 * It is NOT defaulted on failure. A wrong interval silently widens or narrows
 * the staleness window — the exact class of quiet lie this phase exists to
 * remove — so a failure here throws and the card renders the error (N1).
 */
let intervalPromise: Promise<number> | null = null;
function loadRecheckIntervalMs(): Promise<number> {
  if (intervalPromise === null) {
    intervalPromise = fetchConnections()
      .then((r) => {
        if (!Number.isFinite(r.recheck_interval_ms) || r.recheck_interval_ms <= 0) {
          throw new Error(
            `GET /connections reported recheck_interval_ms=${JSON.stringify(r.recheck_interval_ms)}, ` +
              `which is not a positive number of milliseconds. Staleness cannot be judged against it.`,
          );
        }
        return r.recheck_interval_ms;
      })
      .catch((e: unknown) => {
        // Clear the memo so a transient failure does not poison every later
        // mount for the lifetime of the page.
        intervalPromise = null;
        throw e;
      });
  }
  return intervalPromise;
}

/** Exported so a check can reset the memo between fixtures. */
export function resetRecheckIntervalCache(): void {
  intervalPromise = null;
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The five answers, laid out the same way on every card, under the chip. */
function SummaryFields({ summary }: { summary: ConnectionSummary }): JSX.Element {
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
          fontSize: 12.5,
          marginTop: 4,
        }}
      >
        <Field label="IDENTITY (FROM THE PROBE)" value={summary.identity} />
        <Field label="HEALTH" value={summary.health} />
      </div>
      <div style={{ marginTop: 10 }}>
        <Label text="TO CONNECT / REPAIR" />
        <div style={{ color: tokens.textBody, marginTop: 2, fontSize: 12.5 }}>
          {summary.action}
        </div>
      </div>
    </>
  );
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
  /** The reason the key status could not be READ, if it could not. Null while
   *  the fetch is in flight and after a successful one. Same channel, same
   *  rule as the other four rows — see `AgyCard`'s note. */
  readError: string | null;
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
  /** The read's own error, apart from the actions' — see `AgyCard`. */
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [verdict, setVerdict] = useState<TestVerdict | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await call<GeminiStatus>("/gemini"));
      setReadError(null);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
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
      readError,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, verdict, present, readError]);

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

      {readError && (
        <Banner tone="bad">
          <strong data-gemini-read-error>Could not read this connection&rsquo;s status.</strong>{" "}
          {readError}
        </Banner>
      )}
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


/* ── Google account (R48–R51) ────────────────────────────────────────────── */

/**
 * Three DISTINCT states, and the third one is the reason this card was
 * rewritten in phase 4:
 *
 *   CONNECTED (verified <age>)   a real Gmail profile call came back 200, and
 *                               the address shown is the one IT returned
 *   UNVERIFIED (never checked)   a credential file exists and nobody has asked
 *                               it to prove anything — amber, never green
 *   NOT ANSWERING (<verbatim>)   the probe ran and failed, and Google's own
 *                               status code and body are printed as they came
 *
 * Before this, the third and second states were the same state: the check
 * result lived in a module-level variable in the API and died on every
 * restart, so "connected" and "nobody has ever asked" both rendered as a
 * credential file sitting there looking healthy. B4b persisted the record; this
 * card stops throwing the distinction away at the last step.
 *
 * The card no longer keeps its own `check === null ? UNVERIFIED : …` ladder.
 * It hands the persisted status to `googleConnection()` and renders what comes
 * back, because that function is where R57 and R51 are enforced for all four
 * connections at once.
 */
export function GoogleCard({
  onFacts,
}: {
  onFacts?: (f: Read<GoogleFacts>) => void;
} = {}): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [accounts, setAccounts] = useState<GoogleAccountView[]>([]);
  const [lastCheck, setLastCheck] = useState<GoogleCheck | null>(null);
  const [reauth, setReauth] = useState<{ command: string; why: string } | null>(null);
  const [absentDetail, setAbsentDetail] = useState<string | null>(null);
  const [intervalMs, setIntervalMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The read's own error — see `AgyCard`'s note. It travels upward so the
   *  panel's row head can say READ FAILED instead of READING… forever. */
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // Both, in parallel: the status (state, identity, checked_at) and the
      // cadence its staleness is judged against. Neither is defaulted if the
      // other fails — `Promise.all` rejects and the card shows why.
      const [res, ms] = await Promise.all([
        fetchGoogleConnection(),
        loadRecheckIntervalMs(),
      ]);
      setStatus(res.status);
      setAccounts(res.accounts);
      setLastCheck(res.last_check);
      setReauth({ command: res.reauth.command, why: res.reauth.why });
      setAbsentDetail(res.detail ?? null);
      setIntervalMs(ms);
      setReadError(null);
    } catch (e) {
      setReadError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await probeGoogleConnection();
      setStatus(res.status);
      setLastCheck({
        ok: res.ok,
        email: res.email,
        reason: res.reason,
        message: res.message,
        checked_at: res.checked_at,
        http_status: res.http_status,
        upstream: res.upstream,
      });
      // The probe just learned the verified address; the account view carries
      // it, so reload rather than patch a field and hope the two agree.
      await load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const account = accounts[0] ?? null;

  const facts: GoogleFacts | null =
    status === null || intervalMs === null
      ? null
      : {
          status,
          hasAccount: account !== null,
          hasRefreshToken: account?.has_refresh_token ?? false,
          scopeCount: account?.scopes.length ?? 0,
          reauthCommand: reauth?.command ?? "python3 /opt/ai-os/google-setup/setup.py",
          recheckIntervalMs: intervalMs,
        };

  /* Facts beat a read error: a failed refresh must not erase a real reading. */
  const read: Read<GoogleFacts> =
    facts !== null ? facts : readError === null ? null : { read_error: readError };

  useEffect(() => {
    if (!onFacts) return;
    if (facts === null && readError === null) return;
    onFacts(read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, intervalMs, accounts, reauth, readError]);

  return (
    <div data-google-card style={card()}>
      <CardHead
        title="Google account"
        note="Gmail · Calendar · Drive · Docs · Sheets · Contacts"
        right={
          <button
            data-google-check
            onClick={() => void runCheck()}
            disabled={busy || account === null}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {busy ? "checking…" : "Check connection"}
          </button>
        }
      />

      {readError && (
        <Banner tone="bad">
          <strong data-google-read-error>Could not read this connection&rsquo;s status.</strong>{" "}
          {readError}
        </Banner>
      )}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* THE STATE LINE. The chip's word and the age of the evidence behind it
          travel together — a health word with no clock is the defect this
          whole phase exists to remove. */}
      {status && (
        <div
          data-google-state
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <StateChip
            summary={{
              id: "google",
              title: "Google Workspace",
              what: "",
              state: status.state,
              stateLabel:
                status.state === "connected"
                  ? "CONNECTED"
                  : status.state === "broken"
                    ? "NOT ANSWERING"
                    : status.state === "absent"
                      ? "NOT CONNECTED"
                      : "UNVERIFIED",
              identity: "",
              health: "",
              action: "",
            }}
          />
          <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
            {checkedAgo(status.checked_at)}
          </span>
          <span style={{ fontSize: 13 }}>
            {/* The address the PROBE returned, and nothing else. `identity` is
                null in every non-connected state by construction upstream. */}
            {status.identity ?? "no verified address"}
          </span>
        </div>
      )}

      {status && status.state === "absent" && (
        <Banner tone="bad">
          <strong>No Google account is connected.</strong>
          <div style={{ marginTop: 4 }}>{absentDetail ?? status.detail}</div>
        </Banner>
      )}

      {account && (
        <div
          style={{
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 10,
            padding: 14,
            margin: "12px 0 10px",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
              gap: 10,
              fontSize: 12.5,
            }}
          >
            <Field label="CONSENT WRITTEN" value={stamp(account.connected_at)} />
            <Field
              label="REFRESH TOKEN"
              value={account.has_refresh_token ? "present" : "MISSING"}
            />
            <Field label="SCOPES" value={String(account.scopes.length)} />
            <Field label="LAST CHECK" value={stamp(status?.checked_at ?? null)} />
          </div>

          {/* What the FILE claims, labelled as configuration. It is shown
              because it is useful when the two disagree, and it is labelled
              because showing it unlabelled beside a verified address is how a
              configured email gets read as a probed one (R50). */}
          <div style={{ marginTop: 10, fontSize: 12.5 }}>
            <Field
              label="ADDRESS THE CREDENTIAL FILE CLAIMS (CONFIGURATION, NOT VERIFIED)"
              value={account.configured_account ?? "the file records none"}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <Label text="GRANTED SCOPES" />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {account.scopes.map((s) => (
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
            {account.token_path}
            {account.client_id ? ` · client ${account.client_id}` : ""}
          </div>
        </div>
      )}

      {/* R58. `detail` already carries Google's own status code and body; the
          extra line below is the machine-readable class, not a replacement. */}
      {status && status.state !== "absent" && (
        <Banner tone={status.state === "connected" ? "ok" : status.state === "broken" ? "bad" : "info"}>
          <div style={{ whiteSpace: "pre-wrap" }} data-google-detail>
            {status.detail}
          </div>
          {lastCheck?.reason && (
            <div className="mono" style={{ marginTop: 6, fontSize: 11.5 }}>
              FAILURE CLASS — {lastCheck.reason}
              {lastCheck.http_status === null ? "" : ` · HTTP ${lastCheck.http_status}`}
            </div>
          )}
          <div style={{ marginTop: 6 }}>{status.action}</div>
        </Banner>
      )}

      {reauth && <CommandBlock command={reauth.command} why={reauth.why} />}
    </div>
  );
}

/* ── agy / Antigravity CLI (R52–R54) ─────────────────────────────────────── */

/**
 * THE HONEST AFFORDANCE, and the reasoning is committed at
 * `phase4/agy-flow-affordance.md`.
 *
 * There is no Connect button and no paste-a-code box on this card. Not as a
 * shortcut — as the finding. `agy` authenticates through implicit PKCE with
 * `redirect_uri=https://antigravity.google/oauth-callback`, which is not
 * localhost, so nothing on this box catches the callback. The CLI prints a
 * consent URL, opens a HARD-CODED 60-second window on ONE single-use
 * `code_challenge`, and reads the pasted code from the stdin of THAT process.
 * A browser control has no route to that stdin, and 60 seconds is not enough
 * for a human to open Google's consent screen, grant it and come back.
 *
 * So this card renders three things and refuses to imply a fourth:
 *   1. the state, from the real probe, subject to the same R57/R51 rules as
 *      every other connection;
 *   2. the VERBATIM command and the VERBATIM prompt Konrad will see, so what
 *      is on screen matches what the terminal will say;
 *   3. Verify — which runs `agy models` for real and shows what it printed.
 */
export function AgyCard({
  onFacts,
}: {
  onFacts?: (f: Read<AgyFacts>) => void;
} = {}): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [flow, setFlow] = useState<AgyFlow | null>(null);
  const [intervalMs, setIntervalMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* THE READ'S OWN ERROR, KEPT APART FROM THE ACTIONS' (R5-gate item 3).
     A rejected `fetchAgyConnection()` used to set `error` and nothing else, so
     the row head — which lives on the panel, outside this card — went on
     saying READING… while the reason sat in a banner inside a collapsed body.
     This one travels UPWARD through `onFacts`, so the head can say what
     happened. `error` keeps its old job: whatever Verify just did. */
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((res: { status: ConnectionStatus; flow: AgyFlow }) => {
    setStatus(res.status);
    setFlow(res.flow);
  }, []);

  const load = useCallback(async () => {
    try {
      const [res, ms] = await Promise.all([fetchAgyConnection(), loadRecheckIntervalMs()]);
      apply(res);
      setIntervalMs(ms);
      setReadError(null);
    } catch (e) {
      setReadError(messageOf(e));
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The real probe: `<absolute path>/agy models`. ~0.3s, and it never opens
   *  the 60-second OAuth wait that `agy -p` does. */
  const verify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      apply(await probeAgyConnection());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const facts: AgyFacts | null =
    status === null || intervalMs === null ? null : { status, recheckIntervalMs: intervalMs };
  /* Facts beat a read error, deliberately: a refresh that failed after a
     successful load must not erase the reading it could not replace. The
     banner below still says the refresh failed. */
  const read: Read<AgyFacts> =
    facts !== null ? facts : readError === null ? null : { read_error: readError };
  const summary = agyConnection(read);

  useEffect(() => {
    if (!onFacts) return;
    if (facts === null && readError === null) return;
    onFacts(read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, intervalMs, readError]);

  return (
    <div data-agy-card style={card()}>
      <CardHead
        title="Antigravity CLI (agy)"
        note="Google AI Ultra · signed in at a terminal, never from here"
        right={
          <button
            data-agy-verify
            data-busy={busy ? "true" : "false"}
            onClick={() => void verify()}
            disabled={busy || status?.state === "absent"}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {busy ? "verifying…" : "Verify"}
          </button>
        }
      />

      {readError && (
        <Banner tone="bad">
          <strong data-agy-read-error>Could not read this connection&rsquo;s status.</strong>{" "}
          {readError}
        </Banner>
      )}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* THE ACTION HALF. Until this round the card's honest answer was "you
          must do this at a terminal" — and it was honest, because nothing here
          could reach the CLI's stdin. The broker can: it runs `agy` on a pty
          and pastes the code into the prompt that is waiting for it. So the
          control comes FIRST, above the diagnosis, on every state that is not
          already signed in. The verbatim terminal steps stay below it as the
          fallback, no longer as the only door. */}
      {summary.state !== "connected" && (
        <CliAuthConnect provider="agy" onConnected={() => void load()} />
      )}

      {status && (
        <div
          data-agy-state
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <StateChip summary={summary} />
          <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
            {checkedAgo(status.checked_at)}
          </span>
        </div>
      )}

      {status && <SummaryFields summary={summary} />}

      {/* The flow, VERBATIM, still measured at a terminal — it is what the
          broker automates, and it is the fallback if the broker cannot start
          the CLI at all. R54 forbade a button that could not finish the job;
          it never forbade one that can. */}
      {flow && (
        <Banner tone="info">
          <strong data-agy-flow>
            What Connect does for you, and what to do if it cannot.
          </strong>
          <div style={{ marginTop: 8 }}>
            The consent window is <strong>{flow.window_seconds} seconds</strong> and the
            challenge is single-use, so a URL from an earlier attempt can never be
            completed — that is why a failed attempt offers Relaunch rather than the same
            link again.
          </div>
          <div style={{ marginTop: 10 }}>
            <Label text="THE SAME THING BY HAND, AT A TERMINAL ON THIS BOX" />
            <ol
              style={{
                margin: "6px 0 0",
                paddingInlineStart: 20,
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              <li>
                Run{" "}
                <code className="mono" data-agy-signin-command style={{ color: tokens.textHi }}>
                  {flow.signin_command}
                </code>
              </li>
              <li>Open the Google URL it prints, in any browser, and grant consent.</li>
              <li>
                Copy the authorization code Google shows and paste it back at the CLI&rsquo;s
                own prompt:{" "}
                <code className="mono" data-agy-paste-prompt style={{ color: tokens.textHi }}>
                  {flow.paste_prompt}
                </code>
              </li>
              <li>Come back here and press Verify.</li>
            </ol>
          </div>
          <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, marginTop: 10 }}>
            {flow.flow}
          </div>
        </Banner>
      )}

      {/* The probe's real output, verbatim (R58) — including its exit code and
          the CLI's own words when it refuses. */}
      {status && (
        <div
          style={{
            marginTop: 12,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <Label text="LAST PROBE — VERBATIM OUTPUT" />
          <div
            data-agy-detail
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              color: tokens.textBody,
              marginTop: 4,
            }}
          >
            {status.detail}
          </div>
          {flow && (
            <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, marginTop: 8 }}>
              probe command: {flow.probe_command}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Gemini CLI — the OAuth session, not the API key ─────────────────────── */

/**
 * `/usr/bin/gemini`, signed in with a Google account.
 *
 * ── WHY THIS IS A SECOND GEMINI CARD AND NOT A FIELD ON THE FIRST ───────
 * `GeminiCard` above is an API KEY: a string in the secret store, billed to a
 * Cloud project. This is an OAuth SESSION: a credential file on disk, free
 * tier, written by the CLI's own login. They fail independently and are
 * repaired by completely different actions, and a surface that folded them
 * into one row would have to choose which of the two its chip was about. It
 * had no row at all before this round, which is why there was nothing to put a
 * Connect button on.
 *
 * Everything else is `AgyCard`'s shape, deliberately: one fetch, reported
 * upward through `onFacts`, one Verify that runs the real probe, and the
 * sign-in control on top whenever the row is not already signed in.
 */
export function GeminiCliCard({
  onFacts,
}: {
  onFacts?: (f: Read<GeminiCliFacts>) => void;
} = {}): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [intervalMs, setIntervalMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The read's own error — see `AgyCard`'s note. */
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, ms] = await Promise.all([
        fetchGeminiCliConnection(),
        loadRecheckIntervalMs(),
      ]);
      setStatus(res.status);
      setIntervalMs(ms);
      setReadError(null);
    } catch (e) {
      setReadError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus((await probeGeminiCliConnection()).status);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const facts: GeminiCliFacts | null =
    status === null || intervalMs === null ? null : { status, recheckIntervalMs: intervalMs };
  /* Facts beat a read error: a failed refresh must not erase a real reading. */
  const read: Read<GeminiCliFacts> =
    facts !== null ? facts : readError === null ? null : { read_error: readError };
  const summary = geminiCliConnection(read);

  useEffect(() => {
    if (!onFacts) return;
    if (facts === null && readError === null) return;
    onFacts(read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, intervalMs, readError]);

  return (
    <div data-gemini-cli-card style={card()}>
      <CardHead
        title="Gemini CLI"
        note="a Google account on this box · not the API key"
        right={
          <button
            data-gemini-cli-verify
            data-busy={busy ? "true" : "false"}
            onClick={() => void verify()}
            disabled={busy || status?.state === "absent"}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {busy ? "verifying…" : "Verify"}
          </button>
        }
      />

      {readError && (
        <Banner tone="bad">
          <strong data-gemini-cli-read-error>
            Could not read this connection&rsquo;s status.
          </strong>{" "}
          {readError}
        </Banner>
      )}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* The CLI refuses to authenticate in a non-interactive session, which is
          why nothing before the broker could sign it in from here: it needs a
          real pty and a prompt somebody answers. The broker gives it both. */}
      {summary.state !== "connected" && (
        <CliAuthConnect provider="gemini-cli" onConnected={() => void load()} />
      )}

      {status && (
        <div
          data-gemini-cli-state
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <StateChip summary={summary} />
          <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
            {checkedAgo(status.checked_at)}
          </span>
        </div>
      )}

      {status && <SummaryFields summary={summary} />}

      {status && (
        <div
          style={{
            marginTop: 12,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <Label text="LAST PROBE — VERBATIM OUTPUT" />
          <div
            data-gemini-cli-detail
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              color: tokens.textBody,
              marginTop: 4,
            }}
          >
            {status.detail}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── GitHub (R55, R56) ───────────────────────────────────────────────────── */

/**
 * The token is WRITE-ONLY from the browser's point of view.
 *
 * It goes up in a POST body to `/api/secrets` under the fixed name the server
 * chose, the input is `type=password`, and the value is dropped from state the
 * moment the save resolves. It is never rendered, never put in a URL or a query
 * string, never interpolated into an error message and never logged. Same rule
 * and same reasoning as `desktop/chat/SecretField.tsx`, whose header is the
 * long version.
 *
 * And storing it connects nothing. "Token present" is storage; only a 200 from
 * `GET https://api.github.com/user` carrying a `login` produces the connected
 * word, which is why saving the token leaves this card UNVERIFIED until Probe
 * is pressed.
 */
export function GitHubCard({
  onFacts,
}: {
  onFacts?: (f: Read<GithubFacts>) => void;
} = {}): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [secretName, setSecretName] = useState<string | null>(null);
  const [intervalMs, setIntervalMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The read's own error — see `AgyCard`'s note. */
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, ms] = await Promise.all([fetchGithubConnection(), loadRecheckIntervalMs()]);
      setStatus(res.status);
      setSecretName(res.secret_name);
      setIntervalMs(ms);
      setReadError(null);
    } catch (e) {
      setReadError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const probe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await probeGithubConnection();
      setStatus(res.status);
      setSecretName(res.secret_name);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (secretName === null) {
      setError("the server has not reported which secret name to store under yet");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const meta = await storeSecret(
        secretName,
        token,
        "GitHub personal access token — phase 4 connections panel",
      );
      // Only the NAME comes back into the UI. Clear the value first, so it is
      // gone from state before anything else can run.
      setToken("");
      setSaved(meta.name);
      await load();
    } catch (e) {
      // `e.message` and nothing else. The token is never interpolated into an
      // error string — that is how a credential ends up in a screenshot.
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }, [secretName, token, load]);

  const facts: GithubFacts | null =
    status === null || intervalMs === null || secretName === null
      ? null
      : { status, secretName, recheckIntervalMs: intervalMs };
  /* Facts beat a read error: a failed refresh must not erase a real reading. */
  const read: Read<GithubFacts> =
    facts !== null ? facts : readError === null ? null : { read_error: readError };
  const summary = githubConnection(read);

  useEffect(() => {
    if (!onFacts) return;
    if (facts === null && readError === null) return;
    onFacts(read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, intervalMs, secretName, readError]);

  return (
    <div data-github-card style={card()}>
      <CardHead
        title="GitHub"
        note="push work branches · open pull requests"
        right={
          <button
            data-github-probe
            data-busy={busy ? "true" : "false"}
            onClick={() => void probe()}
            disabled={busy || status?.state === "absent"}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {busy ? "probing…" : "Probe"}
          </button>
        }
      />

      {readError && (
        <Banner tone="bad">
          <strong data-github-read-error>Could not read this connection&rsquo;s status.</strong>{" "}
          {readError}
        </Banner>
      )}
      {error && <Banner tone="bad">{error}</Banner>}

      {status && (
        <div
          data-github-state
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <StateChip summary={summary} />
          <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
            {checkedAgo(status.checked_at)}
          </span>
        </div>
      )}

      {status && <SummaryFields summary={summary} />}

      {/* R56: the login and the scopes come out of the probe's own answer and
          are printed verbatim, because "which scopes does this token actually
          have" is a question no configuration file on this box can answer. */}
      {status && (
        <div
          style={{
            marginTop: 12,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <Label text="LAST PROBE — GET https://api.github.com/user, VERBATIM" />
          <div
            data-github-detail
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              color: tokens.textBody,
              marginTop: 4,
            }}
          >
            {status.detail}
          </div>
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          background: tokens.bgGutter,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          padding: "10px 12px",
        }}
      >
        <Label text={`STORE A PERSONAL ACCESS TOKEN — SECRET NAME ${secretName ?? "…"}`} />
        <div style={{ fontSize: 12.5, color: tokens.textBody, margin: "6px 0 8px" }}>
          The value goes straight to the secure secret store and is never read back into
          this browser, never echoed, and never placed in a URL. Storing it does not
          connect anything: press Probe afterwards and GitHub will say whether it works.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            data-github-token
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_… (write-only)"
            style={{
              flex: 1,
              minWidth: 240,
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 7,
              color: tokens.text,
              fontSize: 12.5,
              padding: "6px 10px",
            }}
          />
          <button
            data-github-save
            onClick={() => void save()}
            disabled={saving || token === "" || secretName === null}
            style={btn(tokens.toolBg, tokens.border)}
          >
            {saving ? "storing…" : "Store token"}
          </button>
        </div>
        {saved && (
          <div style={{ fontSize: 12, color: tokens.textSoft, marginTop: 8 }}>
            Stored under <span className="mono">{saved}</span>. Still UNVERIFIED — press
            Probe.
          </div>
        )}
      </div>
    </div>
  );
}
