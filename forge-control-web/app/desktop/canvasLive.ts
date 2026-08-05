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

