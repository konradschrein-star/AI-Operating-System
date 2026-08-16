"use client";

/**
 * Credential-request live channel — the half of "the panel opens by itself"
 * that costs no request budget (round 808).
 *
 * WHY THIS FILE EXISTS. Phase 800 wired the composer's secret panel to a 60s
 * poll of `GET /api/secrets`. That is wrong twice over. Konrad asked for the
 * panel to open "automatically ... and there should be text appearing in
 * there" the moment an agent asks — a 60s poll makes him wait up to a minute
 * for an agent that is BLOCKED on him. And it spent 1 req/min out of a surface
 * measured at 39/min against phase 600's ≤40 ceiling (`nav-walk.cjs:310`),
 * which had to be bought back by slowing an unrelated poll. Server push costs
 * neither: one connection, zero requests at rest, arrival in ~50ms.
 *
 * Same shape as `canvasLive.ts`, deliberately — one SSE idiom in this codebase,
 * not two.
 *
 *   EventSource → /api/secret-events (Next route handler, unbuffered)
 *               → forge-control /api/secrets/events
 *
 * THE CONTRACT, and the reason nothing here holds state: every frame — hello,
 * request, cleared — means the same thing, "the pending set may have moved, go
 * re-read `GET /api/secrets`". The list stays the single source of truth, so a
 * dropped stream self-heals on reconnect (EventSource retries by itself and
 * `hello` fires again) and the panel can never render a request the list
 * disagrees with. No frame is ever the only copy of anything.
 *
 * NOTHING FROM THIS STREAM IS EVER SENT ANYWHERE. It carries metadata only —
 * no endpoint reachable from here returns a secret value.
 */

/** An agent's "for Konrad" flag, as it arrives on the wire. Mirrors
 *  `SecretRequestFrame` in forge-control/src/routes/secrets.ts. */
export interface SecretRequestFrame {
  /** Monotonic within the server process. Ordering/diagnostics only — clients
   *  key off the refetched list, never off this. */
  rev: number;
  name: string;
  /** The requesting agent's text. ATTACKER-INFLUENCED: plain text only, never
   *  markdown or HTML. Null when the agent gave no reason. */
  note: string | null;
  requestedByRunId: string | null;
  ts: number;
}

/** A pending flag going away: revealed, dismissed, deleted, or re-stored
 *  without the flag. */
export interface SecretClearedFrame {
  rev: number;
  name: string;
  ts: number;
}

/**
 * How often to re-read the list while the stream is DOWN, and never while it is
 * up. This is the fallback that mirrors `canvas.ts`'s stat loop: a stream that
 * cannot connect (forge-control restarting, a proxy eating the connection)
 * must degrade to the phase-800 behaviour rather than to silence — an agent
 * blocked on a credential is the one thing this surface may not lose.
 *
 * `false` is react-query's "do not poll", so the LIVE cost is exactly zero
 * requests per minute, which is the entire point of the round.
 *
 * 60_000 is phase 800's own number, kept on purpose: it was measured to fit
 * inside the ceiling with the compensating lever, so the degraded path is
 * provably no worse than what shipped.
 */
export const SECRETS_FALLBACK_POLL_MS = 60_000;

/** The poll period the secrets query should run at. Pure, and exported so the
 *  check script can assert the zero-cost claim instead of trusting a comment. */
export function secretsPollInterval(live: boolean): number | false {
  return live ? false : SECRETS_FALLBACK_POLL_MS;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Parse a `request` frame. Returns null for anything that is not a usable
 * request — malformed JSON, a missing name, a frame that is not an object.
 *
 * TOTALITY, for the same reason `secret-requests.ts` insists on it: this runs
 * on data an agent influenced. A throw here would land in an EventSource
 * listener, where nothing catches it, and take the composer's panel with it.
 * A frame that cannot be read is a frame we ignore — the list refetch behind
 * it still tells the truth.
 */
export function parseRequestFrame(raw: string): SecretRequestFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const name = strOrNull(data.name);
  if (name === null) return null;
  return {
    rev: num(data.rev),
    name,
    note: strOrNull(data.note),
    requestedByRunId: strOrNull(data.requestedByRunId),
    ts: num(data.ts),
  };
}

/** Parse a `cleared` frame. Same totality rule as above. */
export function parseClearedFrame(raw: string): SecretClearedFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const name = strOrNull(data.name);
  if (name === null) return null;
  return { rev: num(data.rev), name, ts: num(data.ts) };
}

export interface SecretSubscription {
  close: () => void;
}

/**
 * Subscribe to credential-request events.
 *
 * `onLive` flips both ways: true on every `hello`, false on every error.
 * EventSource reconnects on its own, so the caller's job is simply to tighten
 * its fallback poll whenever it goes false — see `secretsPollInterval`.
 *
 * `onMoved` fires for every request/cleared frame — including one that could
 * not be parsed, because "something changed" survives a malformed payload.
 * `onHello` is kept SEPARATE from it on purpose: the first hello arrives while
 * the caller's own initial fetch is already in flight (a refetch there is pure
 * waste), while every later hello is a RECONNECT and must refetch — that is
 * what closes the outage gap, with no replay buffer on the server.
 */
export function subscribeSecretRequests(handlers: {
  onHello?: () => void;
  onMoved?: () => void;
  onRequest?: (f: SecretRequestFrame) => void;
  onCleared?: (f: SecretClearedFrame) => void;
  onLive?: (live: boolean) => void;
}): SecretSubscription {
  const es = new EventSource("/api/secret-events");
  let closed = false;

  es.addEventListener("hello", () => {
    if (closed) return;
    handlers.onLive?.(true);
    handlers.onHello?.();
  });

  es.addEventListener("request", (ev) => {
    if (closed) return;
    const f = parseRequestFrame((ev as MessageEvent).data);
    // A frame we could not read still means something changed — refetch
    // regardless, and only skip the typed callback.
    if (f) handlers.onRequest?.(f);
    handlers.onMoved?.();
  });

  es.addEventListener("cleared", (ev) => {
    if (closed) return;
    const f = parseClearedFrame((ev as MessageEvent).data);
    if (f) handlers.onCleared?.(f);
    handlers.onMoved?.();
  });

  es.onerror = () => {
    // Not fatal — EventSource retries. Report not-live so the caller leans on
    // the fallback poll until `hello` arrives again.
    if (!closed) handlers.onLive?.(false);
  };

  return {
    close: () => {
      if (closed) return;
      closed = true;
      es.close();
    },
  };
}
