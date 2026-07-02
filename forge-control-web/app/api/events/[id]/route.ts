/**
 * SSE pass-through to forge-control's run event stream.
 *
 * A dedicated route handler (not a next.config rewrite) because SSE needs
 * guaranteed unbuffered streaming. Auth is enforced by middleware.ts —
 * EventSource sends session cookies on same-origin requests.
 */

const FORGE = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return new Response("invalid run id", { status: 400 });
  }
  const upstream = await fetch(`${FORGE}/api/chat/${id}/events`, {
    headers: { accept: "text/event-stream" },
    signal: req.signal,
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(`upstream ${upstream.status}`, { status: 502 });
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
