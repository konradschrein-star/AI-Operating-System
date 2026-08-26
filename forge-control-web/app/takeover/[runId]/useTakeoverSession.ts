"use client";

/**
 * useTakeoverSession — ONE owner for a takeover viewer's lifecycle, shared by
 * the /takeover/<runId> landing page and the in-chat BrowserStreamViewer:
 * mint → iframe key → noVNC bridge → reconnect-with-re-mint → session clock →
 * Done.
 *
 * Why it exists (PLAN.md §0, §1.3; memory: takeover-socket-death-forensics):
 *   - A ticket is a 120 s BEARER TOKEN in a URL and is verified ONCE at
 *     connect. It is a connect window, not a session length, and it stays
 *     120 s. What killed Konrad's sessions was the RE-connect: noVNC's own
 *     reconnect and a React remount both reuse the URL, so the same ticket is
 *     replayed → `ticket_replayed` / `ticket_expired` (run 2ce31fa484df,
 *     2026-08-25). Every reconnect here mints a FRESH ticket and the iframe is
 *     keyed on it, so no URL is ever loaded twice.
 *   - forge-control restarts on every deploy (114 on the counter, 0 crash
 *     restarts) and each restart resets every open takeover socket. Reconnect
 *     therefore has to survive the backend vanishing and coming back:
 *     immediately, then 2 s, 5 s, 10 s, 10 s — five fresh tickets — then stop
 *     with a Retry button rather than hammer a dead process.
 *   - The SESSION clock lives in the supervisor, not in forge-control and not
 *     here; this hook only polls it (every 15 s) and renders it. When the
 *     route says `ended`, reconnecting stops for good — a viewer that keeps
 *     minting against a torn-down stack would just burn jtis.
 *   - WHAT THE CLOCK SHOWS (B8). The header counts down to the session END:
 *     `takeover_deadline` (the 2 h cap, armed at first connect), else
 *     `hard_deadline`. It does NOT render the route's `remaining_ms`, which is
 *     the EARLIEST of three deadlines — and while a socket is connected the
 *     supervisor slides the 1 h idle deadline forward every tick, so that
 *     minimum is the idle clock and it never arrives: B5 read "ends in 0:59:xx"
 *     on a 2 h session. The idle deadline is rendered only when no socket is
 *     connected (that is the only time it can fire), labelled as such. Both
 *     are measured against the route's own `now`, so the phone's clock skew
 *     cannot move them.
 *
 * Never logs anything. The ticket is a credential and never leaves `ticket`;
 * the bridge it hands out is the path passwords take into the VM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  endTakeoverSession,
  fetchTakeoverSession,
  mintTakeoverTicket,
  vncProxyUrl,
  type TakeoverEndBody,
  type TakeoverSessionBody,
  type TakeoverSessionPoll,
  type TakeoverTicketBody,
} from "../../desktop/chat/browser-shots";
import { attachNoVNC, type NoVNCBridge, type ViewerState } from "./novnc-bridge";

/** Reconnect schedule after a drop: mint at once, then these gaps. Five
 *  attempts in total, each with a fresh ticket. */
export const RECONNECT_DELAYS_MS: readonly number[] = [0, 2_000, 5_000, 10_000, 10_000];
export const RECONNECT_MAX_ATTEMPTS = RECONNECT_DELAYS_MS.length;
/** Session-clock poll cadence — 4 req/min on a page that has nothing else to poll. */
export const SESSION_POLL_MS = 15_000;
/** Under this much remaining time the clock renders in the warn colour. */
export const SESSION_WARN_UNDER_MS = 10 * 60_000;

export type TicketState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; body: TakeoverTicketBody };

export interface ReconnectState {
  /** 1-based attempt currently pending or in flight. */
  attempt: number;
  max: number;
  /** Seconds the previous connection lasted, or null if it never connected. */
  droppedAfterS: number | null;
  /** All attempts used; only Retry re-mints now. */
  exhausted: boolean;
}

export type ClockState =
  | { kind: "none" }
  | { kind: "loading" }
  | {
      kind: "ok";
      body: TakeoverSessionBody;
      /** ms until the session END (takeover cap, else hard cap); null when no cap is armed. */
      remainingMs: number | null;
      /** ms until the supervisor's idle deadline; null when the route carries none.
       *  Rendered only while `body.connected_sockets === 0` — see the header comment. */
      idleRemainingMs: number | null;
    }
  | { kind: "ended"; reason: string; at: string }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export type EndState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; body: TakeoverEndBody }
  | { kind: "error"; message: string };

export interface TakeoverSession {
  ticket: TicketState;
  /** The viewer URL for the current ticket, or null. */
  vncUrl: string | null;
  /** Key the `<iframe>` on this: a new ticket is a new element, never a reload. */
  iframeKey: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Wire to the iframe's onLoad — attaches the bridge to the loaded document. */
  onIframeLoad: () => void;
  viewer: ViewerState;
  /** Rendered hard: the bridge could not reach noVNC inside the iframe. */
  bridgeError: string | null;
  /** The live bridge, for TextToVM. Re-read per send, never cached by callers. */
  getBridge: () => NoVNCBridge | null;
  reconnect: ReconnectState | null;
  /** Seconds since the current connection came up, or null. */
  connectedForS: number | null;
  /** One line for the header: 'connected · ends in 1:52:10' (the cap),
   *  'reconnecting 2/5 · dropped after 118 s · ends in 1:50:02 · idle: stack closes in 0:58:12 unless reconnected', … */
  statusLine: string;
  clock: ClockState;
  /** True when the clock should render in the warn colour. */
  clockWarn: boolean;
  end: EndState;
  /** Manual re-mint (Retry). Resets the reconnect counter. */
  retry: () => void;
  /** Done: POST the end route, then stop reconnecting. */
  endSession: () => Promise<void>;
}

export interface TakeoverSessionOptions {
  /** False ⇒ nothing is minted, nothing polled (the in-chat viewer outside
   *  manual mode). Flipping it back on mints afresh. */
  enabled?: boolean;
}

/** `1:52:10` from milliseconds; clamps at 0. Exported for the check script. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * ms from the route's `now` to an ISO deadline; null when the deadline is
 * null. Throws (with the field named) on a value Date.parse cannot read — a
 * clock that silently counted from NaN would be the bug this file exists to
 * remove. Exported for the check script.
 */
export function msUntil(deadline: string | null, now: string, label: string): number | null {
  if (deadline === null) return null;
  const d = Date.parse(deadline);
  const n = Date.parse(now);
  if (Number.isNaN(d) || Number.isNaN(n)) {
    throw new Error(`session route: ${label} ${JSON.stringify(deadline)} or now ${JSON.stringify(now)} is not an ISO timestamp`);
  }
  return d - n;
}

/**
 * The session END as of `body.now`: the 2 h takeover cap once a connect has
 * armed it, else the supervisor's hard cap; null when neither exists yet.
 * Never `body.remaining_ms` — that is min(idle, cap, hard), i.e. the sliding
 * idle deadline while connected (header comment). Exported for the check script.
 */
export function capRemainingAtFetch(body: TakeoverSessionBody): number | null {
  if (body.takeover_deadline !== null) return msUntil(body.takeover_deadline, body.now, "takeover_deadline");
  return msUntil(body.hard_deadline, body.now, "hard_deadline");
}

/** The supervisor's idle deadline as of `body.now`, or null. Exported for the check script. */
export function idleRemainingAtFetch(body: TakeoverSessionBody): number | null {
  return msUntil(body.idle_deadline, body.now, "idle_deadline");
}

/** Pure: the header line from the pieces, so the check script can pin it. */
export function composeStatusLine(input: {
  ticket: TicketState["kind"];
  viewer: ViewerState;
  reconnect: ReconnectState | null;
  clock: ClockState;
  bridgeError: string | null;
}): string {
  const { ticket, viewer, reconnect, clock, bridgeError } = input;
  if (clock.kind === "ended") return `Session ended: ${clock.reason}`;
  if (bridgeError) return `viewer bridge failed: ${bridgeError}`;
  let head: string;
  if (reconnect && reconnect.exhausted) {
    head = `reconnect failed after ${reconnect.max} attempts${
      reconnect.droppedAfterS !== null ? ` · dropped after ${reconnect.droppedAfterS} s` : ""
    }`;
  } else if (reconnect) {
    head = `reconnecting ${reconnect.attempt}/${reconnect.max}${
      reconnect.droppedAfterS !== null ? ` · dropped after ${reconnect.droppedAfterS} s` : ""
    }`;
  } else if (ticket === "idle") head = "idle";
  else if (ticket === "loading") head = "minting ticket";
  else if (ticket === "error") head = "ticket failed";
  else if (viewer === "init") head = "loading viewer";
  else head = viewer;
  let tail = "";
  if (clock.kind === "ok") {
    // 'ends in' is the CAP — the moment the session really ends. The idle
    // deadline slides while a socket is connected, so it is only shown when
    // none is: then it is the moment the stack closes unless he reconnects.
    tail = clock.remainingMs === null ? " · no session clock armed" : ` · ends in ${formatRemaining(clock.remainingMs)}`;
    if (clock.body.connected_sockets === 0 && clock.idleRemainingMs !== null) {
      tail += ` · idle: stack closes in ${formatRemaining(clock.idleRemainingMs)} unless reconnected`;
    }
  } else if (clock.kind === "unavailable") {
    tail = " · session clock unavailable — forge-control predates this build";
  } else if (clock.kind === "error") {
    tail = ` · session clock: ${clock.message}`;
  }
  return head + tail;
}

export function useTakeoverSession(dirId: string, options: TakeoverSessionOptions = {}): TakeoverSession {
  const enabled = options.enabled ?? true;

  const [ticket, setTicket] = useState<TicketState>({ kind: "idle" });
  const [mintSeq, setMintSeq] = useState(0);
  const [viewer, setViewer] = useState<ViewerState>("init");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState<ReconnectState | null>(null);
  const [poll, setPoll] = useState<TakeoverSessionPoll | null>(null);
  const [localEnd, setLocalEnd] = useState<{ reason: string; at: string } | null>(null);
  const [end, setEnd] = useState<EndState>({ kind: "idle" });
  const [nowTick, setNowTick] = useState(() => Date.now());

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<NoVNCBridge | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const connectedSinceRef = useRef<number | null>(null);
  const endedRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const disposeBridge = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    bridgeRef.current?.dispose();
    bridgeRef.current = null;
  }, []);

  /* ── mint ──────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!enabled) {
      setTicket((prev) => (prev.kind === "idle" ? prev : { kind: "idle" }));
      clearReconnectTimer();
      disposeBridge();
      setViewer("init");
      setBridgeError(null);
      setReconnect(null);
      attemptRef.current = 0;
      connectedSinceRef.current = null;
      return;
    }
    let cancelled = false;
    setTicket({ kind: "loading" });
    setBridgeError(null);
    mintTakeoverTicket(dirId)
      .then((body) => {
        if (!cancelled) setTicket({ kind: "ready", body });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setTicket({ kind: "error", message: err.message });
        // A failed mint mid-reconnect counts as a failed attempt: the schedule
        // continues (forge-control may still be restarting) until exhausted.
        if (attemptRef.current > 0) scheduleReconnectRef.current();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dirId, mintSeq]);

  /* ── reconnect scheduling ─────────────────────────────────────────────── */
  const scheduleReconnect = useCallback(() => {
    if (endedRef.current) return;
    if (reconnectTimerRef.current !== null) return; // an attempt is already pending
    const used = attemptRef.current;
    const dropped = connectedSinceRef.current;
    const droppedAfterS = dropped !== null ? Math.max(0, Math.round((Date.now() - dropped) / 1000)) : null;
    connectedSinceRef.current = null;
    if (used >= RECONNECT_MAX_ATTEMPTS) {
      setReconnect({ attempt: used, max: RECONNECT_MAX_ATTEMPTS, droppedAfterS, exhausted: true });
      return;
    }
    const delay = RECONNECT_DELAYS_MS[used];
    attemptRef.current = used + 1;
    setReconnect((prev) => ({
      attempt: used + 1,
      max: RECONNECT_MAX_ATTEMPTS,
      droppedAfterS: droppedAfterS ?? prev?.droppedAfterS ?? null,
      exhausted: false,
    }));
    clearReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (endedRef.current) return;
      setMintSeq((n) => n + 1);
    }, delay);
  }, [clearReconnectTimer]);
  const scheduleReconnectRef = useRef(scheduleReconnect);
  scheduleReconnectRef.current = scheduleReconnect;

  /* ── bridge attach (iframe onLoad) ────────────────────────────────────── */
  const onIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      if (iframe.contentDocument?.location.href === "about:blank") return; // the pre-src load
    } catch {
      /* cross-origin — attachNoVNC will report it in words */
    }
    disposeBridge();
    setBridgeError(null);
    attachNoVNC(iframe)
      .then((bridge) => {
        if (iframeRef.current !== iframe) {
          bridge.dispose(); // the iframe was replaced while we waited
          return;
        }
        bridgeRef.current = bridge;
        unsubscribeRef.current = bridge.onState((state, previous) => {
          setViewer(state);
          if (state === "connected") {
            connectedSinceRef.current = Date.now();
            attemptRef.current = 0;
            clearReconnectTimer();
            setReconnect(null);
            return;
          }
          // `previous === state` is the synchronous first call on subscribe:
          // noVNC may already have failed (expired ticket → close 1006) before
          // the bridge attached, and that drop must be retried too.
          if (state === "disconnected" && (previous !== "disconnected" || previous === state)) {
            scheduleReconnectRef.current();
          }
        });
      })
      .catch((err: Error) => {
        if (iframeRef.current !== iframe) return;
        setBridgeError(err.message);
      });
  }, [disposeBridge, clearReconnectTimer]);

  /* ── session clock poll ───────────────────────────────────────────────── */
  useEffect(() => {
    if (!enabled) {
      setPoll(null);
      return;
    }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const result = await fetchTakeoverSession(dirId);
      if (cancelled) return;
      setPoll(result);
      if (result.kind === "ok" && result.body.ended !== null) {
        endedRef.current = true;
        clearReconnectTimer();
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SESSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, dirId, clearReconnectTimer]);

  /* ── 1 s display tick while a clock is armed ──────────────────────────── */
  const clockArmed =
    poll?.kind === "ok" &&
    poll.body.ended === null &&
    (poll.body.takeover_deadline !== null || poll.body.hard_deadline !== null || poll.body.idle_deadline !== null);
  useEffect(() => {
    if (!clockArmed) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [clockArmed]);

  /* ── teardown ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    return () => {
      clearReconnectTimer();
      disposeBridge();
    };
  }, [clearReconnectTimer, disposeBridge]);

  /* ── actions ──────────────────────────────────────────────────────────── */
  const retry = useCallback(() => {
    if (!enabled) return;
    clearReconnectTimer();
    attemptRef.current = 0;
    connectedSinceRef.current = null;
    setReconnect(null);
    setBridgeError(null);
    setMintSeq((n) => n + 1);
  }, [enabled, clearReconnectTimer]);

  const endSession = useCallback(async () => {
    setEnd({ kind: "pending" });
    try {
      const body = await endTakeoverSession(dirId);
      endedRef.current = true;
      clearReconnectTimer();
      setLocalEnd({ reason: "ended by Done", at: new Date().toISOString() });
      setEnd({ kind: "done", body });
    } catch (err) {
      setEnd({ kind: "error", message: (err as Error).message });
    }
  }, [dirId, clearReconnectTimer]);

  /* ── derived ──────────────────────────────────────────────────────────── */
  const clock: ClockState = useMemo(() => {
    if (localEnd) return { kind: "ended", reason: localEnd.reason, at: localEnd.at };
    if (!enabled) return { kind: "none" };
    if (poll === null) return { kind: "loading" };
    if (poll.kind === "unavailable") return { kind: "unavailable" };
    if (poll.kind === "error") return { kind: "error", message: poll.message };
    if (poll.body.ended !== null) return { kind: "ended", reason: poll.body.ended.reason, at: poll.body.ended.at };
    // Both clocks are anchored on the route's `now`, then aged by the time
    // since the fetch — the phone's own clock never enters the arithmetic.
    const elapsed = nowTick - poll.fetchedAt;
    let capAtFetch: number | null;
    let idleAtFetch: number | null;
    try {
      capAtFetch = capRemainingAtFetch(poll.body);
      idleAtFetch = idleRemainingAtFetch(poll.body);
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
    return {
      kind: "ok",
      body: poll.body,
      remainingMs: capAtFetch === null ? null : Math.max(0, capAtFetch - elapsed),
      idleRemainingMs: idleAtFetch === null ? null : Math.max(0, idleAtFetch - elapsed),
    };
  }, [localEnd, enabled, poll, nowTick]);

  const clockWarn = clock.kind === "ok" && clock.remainingMs !== null && clock.remainingMs < SESSION_WARN_UNDER_MS;

  const vncUrl = ticket.kind === "ready" ? vncProxyUrl(dirId, ticket.body.ticket) : null;
  const iframeKey = ticket.kind === "ready" ? ticket.body.ticket : "no-ticket";

  const statusLine = composeStatusLine({ ticket: ticket.kind, viewer, reconnect, clock, bridgeError });

  const connectedForS =
    viewer === "connected" && connectedSinceRef.current !== null
      ? Math.max(0, Math.round((nowTick - connectedSinceRef.current) / 1000))
      : null;

  const getBridge = useCallback(() => bridgeRef.current, []);

  return {
    ticket,
    vncUrl,
    iframeKey,
    iframeRef,
    onIframeLoad,
    viewer,
    bridgeError,
    getBridge,
    reconnect,
    connectedForS,
    statusLine,
    clock,
    clockWarn,
    end,
    retry,
    endSession,
  };
}
