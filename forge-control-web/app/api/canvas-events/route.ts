/**
 * SSE pass-through to forge-control's canvas event stream.
 *
 * A dedicated route handler rather than a next.config rewrite, for the same
 * reason /api/events/[id] is one: SSE needs guaranteed unbuffered streaming,
 * and the rewrite path does not promise it. Auth comes from middleware.ts —
 * EventSource sends session cookies on same-origin requests.
 *
 * `path` is optional. A pane with no drawing open still subscribes, so the
 * agent can park an "open the scraper map" intent and have it appear without
 * Konrad clicking anything first.
 */

const FORGE = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  // Containment is enforced upstream (forge-control's safePath), but a drawing
  // path is the only thing this stream ever accepts — reject the rest here so a
  // malformed subscription fails fast instead of opening a doomed stream.
  if (path && !path.endsWith(".excalidraw.md")) {
    return new Response("path must be a .excalidraw.md drawing", { status: 400 });
  }

  const upstream = await fetch(
    `${FORGE}/api/canvas/events${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    {
      headers: { accept: "text/event-stream" },
      signal: req.signal,
      cache: "no-store",
    },
  ).catch((e: unknown) => {
    // Distinguish "forge-control is down" from "forge-control said no" — the
    // pane surfaces this, and "502" alone tells Konrad nothing.
    throw new Error(
      `canvas event stream: cannot reach forge-control at ${FORGE} (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return new Response(
      `canvas event stream upstream ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
