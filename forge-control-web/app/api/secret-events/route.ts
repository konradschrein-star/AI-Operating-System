/**
 * SSE pass-through to forge-control's credential-request stream.
 *
 * A dedicated route handler rather than a next.config rewrite, for the same
 * reason /api/canvas-events and /api/events/[id] are ones: SSE needs guaranteed
 * unbuffered streaming, and the rewrite path does not promise it. Auth comes
 * from middleware.ts — EventSource sends session cookies on same-origin
 * requests, so this inherits the NextAuth gate every other UI call sits behind.
 *
 * NO PARAMETERS, deliberately. The upstream stream carries metadata only (a
 * name, the requesting agent's note, the run that asked) and never a secret
 * value, so there is nothing here to scope, filter or leak; adding a `name`
 * query would only invent a way to get it wrong.
 */

const FORGE = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const upstream = await fetch(`${FORGE}/api/secrets/events`, {
    headers: { accept: "text/event-stream" },
    signal: req.signal,
    cache: "no-store",
  }).catch((e: unknown) => {
    // Distinguish "forge-control is down" from "forge-control said no" — the
    // composer surfaces this, and a bare 502 tells Konrad nothing about which
    // of the two happened.
    throw new Error(
      `secret event stream: cannot reach forge-control at ${FORGE} (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return new Response(
      `secret event stream upstream ${upstream.status}${
        detail ? `: ${detail.slice(0, 200)}` : ""
      }`,
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
