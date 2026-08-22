"use client";

/**
 * CliAuthConnect — sign a CLI in from the Connections panel, with clicks and
 * one paste. `PLAN.md` §5, and the six steps there are PINNED: this file
 * implements them, it does not re-decide them.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────
 * Until now every broken CLI row on this surface ended in the same sentence:
 * open a terminal, SSH into the VPS, run this command, paste the code there.
 * The diagnosis half of the panel was finished and honest; the ACTION half did
 * not exist. It does now — the server drives the CLI on a real pty, this
 * control shows Konrad the consent URL the CLI printed, takes the code Google
 * showed him, and hands it to the waiting prompt.
 *
 * ── THE THREE RULES THIS FILE EXISTS TO KEEP ─────────────────────────────
 *
 *  1. THE CODE IS A SECRET AND IT LIVES IN EXACTLY TWO PLACES: this
 *     component's `code` state, and the POST body that carries it upstream.
 *     Never in a URL, never in a `data-` attribute, never in a `console.*`,
 *     never in an error message, never in a `JSON.stringify` of anything
 *     wider than that one body. The input is `type="password"` with
 *     `autoComplete="off"`, and the value is dropped from state the moment the
 *     submit resolves — success OR failure, because a rejected code is a
 *     single-use secret that is now worthless AND still sensitive.
 *
 *  2. THIS CONTROL NEVER PAINTS THE ROW'S CHIP. `connected` here does not mean
 *     the row goes green; it means the server's probe already ran and wrote a
 *     `ConnectionRecord`, so the control calls `onConnected()` and the CARD
 *     re-reads that persisted record. The chip comes from the record or it does
 *     not come at all — which is how R57 ("unprobed is amber, never green")
 *     survives a feature whose entire purpose is to turn a row green.
 *
 *  3. A STALE URL IS NEVER OFFERED. The PKCE verifier is minted per launch, so
 *     the URL from an expired session cannot be completed by anyone, ever. The
 *     server nulls it outside `awaiting_code`; `visibleUrl()` below nulls it
 *     again on the client, in code rather than in a comment, so a server that
 *     forgot cannot put a dead link in front of Konrad.
 *
 * ── WHY IT IMPORTS FROM `integrationCards.tsx`, WHICH IMPORTS IT BACK ────
 * `AgyCard` and `GeminiCliCard` render this control; this control renders their
 * `Banner`, `btn()`, `CommandBlock` and `input()`. That is an import cycle, and
 * it is the deliberate price of the rule that this surface gets no second
 * design language: the alternative was a private copy of four primitives that
 * would drift the first time one of them changed. It is safe because every
 * binding crossing the cycle is a hoisted function declaration that is only
 * CALLED during render — neither module touches the other while its own body is
 * evaluating. `check-settings-surface.tsx` renders both sides through
 * `react-dom/server`, so a regression here is a red check rather than a theory.
 *
 * ── THE SEAM ─────────────────────────────────────────────────────────────
 * `CliAuthConnectView` is pure and takes a `CliAuthView`; `CliAuthConnect` owns
 * the fetching, polling and the one-second clock and renders the view. That
 * split is the same one `ClaudeAccountsSection` already uses for its registry,
 * and for the same reason: under `renderToStaticMarkup` no effect runs and no
 * fetch resolves, so a self-driving component is permanently stuck at `idle`
 * and six of its seven states would be unreachable by any check in this repo.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { tokens } from "../../tokens";
import {
  cancelCliAuth,
  readCliAuth,
  startCliAuth,
  submitCliAuthCode,
  type CliAuthProvider,
  type CliAuthState,
  type CliAuthStatus,
  type CliAuthTarget,
} from "../../api-connections";
import { Banner, CommandBlock, btn, input, messageOf } from "./integrationCards";

/** How often the control re-reads a live login. Two seconds: fast enough that
 *  a 60-second window is not half gone before the UI notices it expired, slow
 *  enough that it is not a poll storm on a panel with three of these. */
const POLL_MS = 2_000;

/** The name Konrad reads. The provider ids are wire values, not English. */
const PROVIDER_LABEL: Record<CliAuthProvider, string> = {
  agy: "the Antigravity CLI",
  "gemini-cli": "the Gemini CLI",
  claude: "Claude Code",
};

/** WHOSE consent page shows the code. Two of the three are Google; Claude is
 *  Anthropic's own, and telling Konrad to look for a Google page while
 *  Anthropic's is open in the tab is a small lie that costs a whole attempt —
 *  and with a 60-second window, an attempt is expensive. */
const PROVIDER_CONSENT: Record<CliAuthProvider, string> = {
  agy: "Google",
  "gemini-cli": "Google",
  claude: "Anthropic",
};

/** Which call is in flight. `null` is "none" and never "unknown". */
export type CliAuthBusy = "start" | "code" | "cancel" | null;

/** Everything the control renders from — pure data, no functions, no fetch.
 *  A fixture can hold any of the seven states still without a server. */
export interface CliAuthView {
  provider: CliAuthProvider;
  /** `null` means this control has never launched anything. It renders as
   *  `idle`, which is a statement about THIS BROWSER, not about the box. */
  status: CliAuthStatus | null;
  busy: CliAuthBusy;
  /** A fetch that REJECTED, verbatim. Deliberately a different channel from
   *  `status.detail`: one is the broker's report about the CLI, the other is
   *  this browser failing to reach the broker at all, and reading the second
   *  as the first is how "the API is down" gets blamed on Google. */
  error: string | null;
  /** The code field's value. Rendered into the password input and NOWHERE
   *  else — see rule 1 in the header. */
  code: string;
  /** The clock the countdown is drawn against, or null when there is nothing
   *  to count. Passed in rather than read here so the view stays pure. */
  nowMs: number | null;
  /** Why Connect cannot be pressed yet — Claude needs a slug and a config
   *  directory before there is anything to sign in. Null when it can. */
  blocked: string | null;
}

/** What the view can ask for. Every one of these is a click. */
export interface CliAuthActions {
  connect: () => void;
  submit: () => void;
  cancel: () => void;
  setCode: (value: string) => void;
}

/** The state to render when nothing has been launched. Not a server value:
 *  the server has no opinion about a control that has never called it. */
const IDLE: CliAuthState = "idle";

export function stateOf(view: CliAuthView): CliAuthState {
  return view.status === null ? IDLE : view.status.state;
}

/**
 * THE URL, AND THE ENFORCEMENT OF RULE 3.
 *
 * The server sends `url: null` outside `awaiting_code`. This says it again on
 * the client, so the box disappears on expiry even if a future server build
 * keeps sending the dead one. Two layers, both cheap, and the failure mode
 * they prevent — Konrad completing a consent screen whose challenge died
 * minutes ago and being told his code is wrong — is the single most confusing
 * thing this flow could do to him.
 */
export function visibleUrl(view: CliAuthView): string | null {
  const s = view.status;
  if (s === null || s.state !== "awaiting_code") return null;
  return s.url;
}

/**
 * The countdown, in words, for every shape the window can take.
 *
 * There is no branch here that renders nothing: a provider with no measured
 * window says so, and an `expires_at` this browser cannot parse says THAT,
 * rather than quietly drawing no countdown and letting the absence read as
 * "there is no hurry". Pure, so the check can pin each sentence.
 */
export function countdownWords(status: CliAuthStatus, nowMs: number | null): string {
  if (status.expires_at === null) {
    return status.window_seconds === null
      ? "no consent window has been measured for this CLI, so no countdown is drawn from a guess — treat it as urgent anyway"
      : `the consent window is ${status.window_seconds} s, but the server sent no expiry time, so there is nothing to count down`;
  }
  const at = Date.parse(status.expires_at);
  if (Number.isNaN(at)) {
    return `the server's expiry time ${JSON.stringify(status.expires_at)} is not a timestamp this browser can read`;
  }
  if (nowMs === null) return `expires at ${status.expires_at}`;
  const left = Math.ceil((at - nowMs) / 1000);
  return left > 0
    ? `expires in ${left} s`
    : "the window has passed — press Relaunch for a fresh URL";
}

/* ── The pure view ───────────────────────────────────────────────────────── */

export function CliAuthConnectView({
  view,
  actions,
}: {
  view: CliAuthView;
  actions: CliAuthActions;
}): JSX.Element {
  const state = stateOf(view);
  const status = view.status;
  const url = visibleUrl(view);
  const who = PROVIDER_LABEL[view.provider];
  const consent = PROVIDER_CONSENT[view.provider];
  const live = state === "awaiting_code" || state === "exchanging";

  return (
    <div
      data-cli-auth={view.provider}
      data-cli-auth-state={state}
      style={{
        background: tokens.bgGutter,
        border: `1px solid ${tokens.borderSoft}`,
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 14,
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 10, color: tokens.textLabel, marginBottom: 6 }}
      >
        SIGN IN FROM HERE — NO TERMINAL
      </div>

      {/* Step 6: a fetch that rejected, verbatim, in the same banner every
          other failure on this surface uses. Never a friendly stand-in, and
          never a toast that claims something was "submitted". */}
      {view.error !== null && (
        <Banner tone="bad">
          <strong data-cli-auth-error>This browser could not reach the sign-in broker.</strong>{" "}
          {view.error}
        </Banner>
      )}

      {/* Steps 1 and 5 share a button, because Relaunch IS step 1 again — with
          a fresh PKCE challenge, which is the only way a second attempt can
          work at all. */}
      {(state === "idle" || state === "starting" || state === "failed" || state === "expired") && (
        <>
          <div style={{ fontSize: 12.5, color: tokens.textBody, lineHeight: 1.55 }}>
            {state === "idle"
              ? `Press Connect and the OS starts ${who} here, on this box, and opens the ${consent} page it asks for. Copy the code that page displays, paste it below, and the OS types it into the prompt that is waiting for it.`
              : state === "starting"
                ? `Starting ${who} and waiting for it to print its URL…`
                : `That attempt is over. Relaunch starts ${who} again with a brand-new URL — the old one cannot be completed by anybody, including you, because its challenge died with the session.`}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              {...(state === "failed" || state === "expired"
                ? { "data-cli-auth-relaunch": view.provider }
                : { "data-cli-auth-connect": view.provider })}
              data-busy={view.busy === "start" ? "true" : "false"}
              onClick={actions.connect}
              disabled={view.busy !== null || view.blocked !== null || state === "starting"}
              style={btn(tokens.okActionBg, tokens.okActionBorder)}
            >
              {view.busy === "start" || state === "starting"
                ? "launching…"
                : state === "failed" || state === "expired"
                  ? "Relaunch"
                  : "Connect"}
            </button>
            {view.blocked !== null && (
              <span data-cli-auth-blocked style={{ fontSize: 11.5, color: tokens.textFaint }}>
                {view.blocked}
              </span>
            )}
          </div>
        </>
      )}

      {/* Step 2: the URL, copyable, and the countdown beside it. */}
      {url !== null && (
        <>
          <CommandBlock
            title={`Open this page, grant consent, and copy the code ${consent} shows you. It is ${who} that is waiting for it — not this browser.`}
            command={url}
            marker="data-cli-auth-url"
            copyable
            why={
              status === null
                ? ""
                : `The CLI is sitting at its own prompt: ${
                    status.prompt ?? "no prompt line was reported"
                  }`
            }
          />
          <div
            data-cli-auth-countdown
            className="mono"
            style={{ fontSize: 11, color: tokens.warn, marginTop: 8 }}
          >
            {status === null ? "" : countdownWords(status, view.nowMs)}
          </div>
        </>
      )}

      {/* Steps 2 and 3: one field, and it is disabled — not hidden — while the
          exchange runs, so the box does not jump under the cursor. */}
      {live && (
        <div style={{ marginTop: 10 }}>
          <label style={{ display: "block" }}>
            <span className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
              THE CODE {consent.toUpperCase()} SHOWED YOU
            </span>
            <input
              data-cli-auth-code={view.provider}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={view.code}
              disabled={state === "exchanging" || view.busy !== null}
              onChange={(e) => actions.setCode(e.target.value)}
              placeholder="paste it here — it goes straight to the waiting prompt"
              style={input()}
            />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              data-cli-auth-submit={view.provider}
              onClick={actions.submit}
              disabled={state === "exchanging" || view.busy !== null || view.code.trim() === ""}
              style={btn(tokens.okActionBg, tokens.okActionBorder)}
            >
              {view.busy === "code" || state === "exchanging" ? "delivering…" : "Submit code"}
            </button>
            <button
              type="button"
              data-cli-auth-cancel={view.provider}
              onClick={actions.cancel}
              disabled={view.busy !== null}
              style={btn(tokens.toolBg, tokens.border)}
            >
              {view.busy === "cancel" ? "cancelling…" : "Cancel"}
            </button>
            {state === "exchanging" && (
              <span
                data-cli-auth-exchanging
                style={{ fontSize: 12, color: tokens.textSoft }}
              >
                checking with {who}… this is the CLI talking to {consent}, not a spinner.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Step 4: connected, and the words come from the PROBE. The row's chip
          is not touched here — `onConnected()` has already asked the card to
          re-read the record the server persisted. */}
      {state === "connected" && status !== null && (
        <Banner tone="ok">
          <strong data-cli-auth-connected={view.provider}>Signed in.</strong>{" "}
          <span data-cli-auth-identity>
            {status.probe === null
              ? "The broker reported success but sent no probe record — the row above stays amber until a probe answers, which is the correct outcome, not a display bug."
              : status.probe.identity === null
                ? `The probe answered: ${status.probe.detail}`
                : `${status.probe.identity} — ${status.probe.detail}`}
          </span>
        </Banner>
      )}

      {/* Step 5: the CLI's own last words, VERBATIM. A wrong code renders here
          exactly as the CLI wrote it, because "that did not work" is not a
          diagnosis, and three rounds of this surface went into deleting
          sentences like it. */}
      {(state === "failed" || state === "expired") && status !== null && (
        <Banner tone="bad">
          <strong data-cli-auth-failed={view.provider}>
            {state === "expired"
              ? "The consent window closed before the code arrived."
              : "That sign-in did not complete."}
          </strong>
          <div
            data-cli-auth-detail
            style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {status.detail}
          </div>
        </Banner>
      )}

      {/* The broker's own next-step sentence, in the same slot and the same
          voice the connection rows use. */}
      {status !== null && status.action.trim() !== "" && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.textSoft, lineHeight: 1.5 }}>
          <span className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
            NEXT{" "}
          </span>
          <span data-cli-auth-action>{status.action}</span>
        </div>
      )}
    </div>
  );
}

/* ── The stateful control ────────────────────────────────────────────────── */

export function CliAuthConnect({
  provider,
  target = null,
  blocked = null,
  onConnected,
}: {
  provider: CliAuthProvider;
  /** Claude only: which registry slug and config directory this login is for. */
  target?: CliAuthTarget | null;
  /** Why Connect cannot be pressed yet, if it cannot. */
  blocked?: string | null;
  /** Re-read the persisted record so the ROW's chip updates. This control
   *  never sets a chip itself — see rule 2 in the header. */
  onConnected: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<CliAuthStatus | null>(null);
  const [busy, setBusy] = useState<CliAuthBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [nowMs, setNowMs] = useState<number | null>(null);

  const slug = target === null ? null : target.slug;

  /* `onConnected` is called from inside effects and handlers. Through a ref so
   * that a parent which re-creates the callback on every render cannot restart
   * the poll interval — that is a 2-second loop rebuilt 30 times a minute, and
   * it is the classic way a polling effect quietly becomes a fetch storm. */
  const connectedRef = useRef(onConnected);
  useEffect(() => {
    connectedRef.current = onConnected;
  }, [onConnected]);

  const connect = useCallback(() => {
    /* SYNCHRONOUSLY, inside the click (PLAN §5 step 1). A window opened after
     * an `await` is a popup the browser blocks, and the whole flow then dies
     * on a blocked-popup icon Konrad never sees. It is opened blank and
     * re-pointed once the URL exists. */
    const tab = typeof window === "undefined" ? null : window.open("", "_blank");
    setBusy("start");
    setError(null);
    setCode("");
    void (async () => {
      try {
        const next = await startCliAuth(provider, target);
        setStatus(next);
        if (next.state === "awaiting_code" && next.url !== null) {
          if (tab !== null) tab.location.href = next.url;
        } else {
          // Nothing to show it: close the blank tab rather than leaving an
          // empty window as the only evidence that anything happened.
          tab?.close();
        }
      } catch (e) {
        tab?.close();
        setError(messageOf(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [provider, target]);

  const submit = useCallback(() => {
    const live = status;
    if (live === null || live.session_id === null) {
      setError(
        `there is no live ${provider} session to deliver a code to — press Connect to start one`,
      );
      return;
    }
    const sessionId = live.session_id;
    setBusy("code");
    setError(null);
    void (async () => {
      try {
        const next = await submitCliAuthCode(provider, {
          session_id: sessionId,
          code,
          slug,
        });
        // RULE 1: the value leaves this browser's state the moment it has been
        // delivered — on success and on failure alike. A rejected code is
        // single-use and worthless, and still a secret.
        setCode("");
        setStatus(next);
        if (next.state === "connected") connectedRef.current();
      } catch (e) {
        setCode("");
        // `messageOf(e)` and nothing else. The code is not in scope for this
        // string and must never be added to it.
        setError(messageOf(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [provider, status, code, slug]);

  const cancel = useCallback(() => {
    setBusy("cancel");
    setError(null);
    setCode("");
    void (async () => {
      try {
        setStatus(await cancelCliAuth(provider, slug));
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [provider, slug]);

  /* Poll while the login is live, and only then. A control sitting at `idle`
   * costs nothing, which matters because three of these are mounted (and
   * hidden) on every settings visit. */
  const liveState = status === null ? null : status.state;
  useEffect(() => {
    if (liveState !== "awaiting_code" && liveState !== "exchanging") return;
    if (busy !== null) return; // never race a request that is already in flight
    const id = setInterval(() => {
      void readCliAuth(provider, slug)
        .then((next) => {
          setStatus(next);
          if (next.state === "connected") connectedRef.current();
        })
        .catch((e: unknown) => setError(messageOf(e)));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [liveState, busy, provider, slug]);

  /* The one-second clock, mounted only while there is a window to count down.
   * `nowMs` is null everywhere else, and `countdownWords` prints the absolute
   * expiry then rather than a countdown that is not ticking. */
  const expiresAt = status === null ? null : status.expires_at;
  useEffect(() => {
    if (liveState !== "awaiting_code" || expiresAt === null) {
      setNowMs(null);
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [liveState, expiresAt]);

  return (
    <CliAuthConnectView
      view={{ provider, status, busy, error, code, nowMs, blocked }}
      actions={{ connect, submit, cancel, setCode }}
    />
  );
}
