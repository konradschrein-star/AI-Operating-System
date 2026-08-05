"use client";

/**
 * Canvas live-sync client — the half of co-drawing that costs nothing.
 *
 * Deliberately kept out of `app/api.ts` so the canvas surface owns its own wire
 * format.
 *
 *   statCanvas(path)  O(1) mtime read. Replaces the old freshness poller, which
 *                     called /canvas/list — a full recursive walk of the 145 MB
 *                     vault, every 4 seconds, to learn one number.
 */

const ROOT = "/api/proxy";

export interface CanvasStat {
  path: string;
  mtime: number;
  size: number;
}

/** Read one drawing's mtime. Throws with the server's own diagnostic — a
 *  silently-swallowed 404 here is how a pane ends up drawing on a stale scene. */
export async function statCanvas(path: string): Promise<CanvasStat> {
  const res = await fetch(
    `${ROOT}/canvas/stat?path=${encodeURIComponent(path)}`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `canvas/stat ${res.status} on ${path}${body.error ? `: ${body.error}` : ""}`,
    );
  }
  return (await res.json()) as CanvasStat;
}

export interface CanvasIntent {
  seq: number;
  path: string;
  reason: string | null;
  ts: number;
}

export interface CanvasHello {
  path: string | null;
  mtime: number;
  intentSeq: number;
  intent: CanvasIntent | null;
}

export interface CanvasSubscription {
  close: () => void;
}

/**
 * Subscribe to a drawing's change stream: `changed` when the file moves on
 * disk, `intent` when the agent asks for a drawing to be shown.
 *
 * `path` may be null — a pane with nothing open still wants intents, so the
 * agent can put a drawing on screen without Konrad clicking first.
 *
 * Wire: EventSource → /api/canvas-events (Next route handler, unbuffered) →
 * forge-control /api/canvas/events → fs.watch on the vault file. An agent draw
 * lands on screen in about a second.
 *
 * EventSource reconnects on its own, so `onLive` flips both ways and the
 * caller's stat fallback should tighten whenever it goes false.
 */
export function subscribeCanvas(
  path: string | null,
  handlers: {
    onHello?: (h: CanvasHello) => void;
    onChanged?: (c: { path: string; mtime: number }) => void;
    onIntent?: (i: CanvasIntent) => void;
    onLive?: (live: boolean) => void;
  },
): CanvasSubscription {
  const es = new EventSource(
    path ? `/api/canvas-events?path=${encodeURIComponent(path)}` : "/api/canvas-events",
  );
  let closed = false;

  function parse<T>(ev: Event): T | null {
    try {
      return JSON.parse((ev as MessageEvent).data) as T;
    } catch {
      // A malformed frame is not worth tearing the stream down for — the stat
      // fallback still guarantees freshness.
      return null;
    }
  }

  es.addEventListener("hello", (ev) => {
    const h = parse<CanvasHello>(ev);
    if (!h || closed) return;
    handlers.onLive?.(true);
    handlers.onHello?.(h);
  });
  es.addEventListener("changed", (ev) => {
    const c = parse<{ path: string; mtime: number }>(ev);
    if (c && !closed) handlers.onChanged?.(c);
  });
  es.addEventListener("intent", (ev) => {
    const i = parse<CanvasIntent>(ev);
    if (i && !closed) handlers.onIntent?.(i);
  });
  es.onerror = () => {
    // Not fatal — EventSource retries. Report not-live so the pane leans on the
    // stat fallback until `hello` arrives again.
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

