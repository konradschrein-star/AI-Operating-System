/**
 * Transparent HTTP reverse proxy to forge-control ($FORGE_CONTROL_URL/api/*).
 *
 * Split out of route.ts: Next.js's route typechecker rejects any export from
 * a route.ts file other than the recognized HTTP-verb handlers and a small
 * set of route config keys (dynamic, revalidate, ...) — an extra named
 * export like `handleProxy` fails `tsc` against `.next/types/**` even though
 * the code itself is correct. Keeping the implementation here, and re-exporting
 * only the verb handlers from route.ts, keeps that typegen happy while still
 * letting proxy-route.test.ts import handleProxy directly.
 *
 * Why a Route Handler instead of next.config rewrites():
 * Next.js rewrites strip conditional caching headers (ETag, If-None-Match) on
 * proxied responses, preventing 304 Not Modified caching. This forwards
 * request conditional headers (If-None-Match, If-Match, If-Modified-Since,
 * If-Unmodified-Since), Accept, Content-Type, Authorization, Cookie, and
 * passes upstream response status (notably HTTP 304) and headers (ETag,
 * Cache-Control, Content-Type, Content-Length) directly back.
 *
 * Manager Constraint:
 * Route Handlers cannot host or proxy WebSockets (NextRequest lacks raw socket
 * access and Response rejects status 101). Any request carrying
 * `Connection: Upgrade` or targeting `/vnc/` bails out early (502 with
 * x-proxy-bailout header) so it does not swallow paths intended for
 * dedicated WebSocket reverse proxies.
 */

// Read per-request, not captured at module-import time: a top-level const
// would freeze in whatever FORGE_CONTROL_URL was set at first import, which
// silently sends every proxied request to the default (or leftover live)
// target even after a caller reassigns the env var later (e.g. in tests).
function forgeControlBase(): string {
  return (process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700").replace(/\/+$/, "");
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface RouteContext {
  params: Promise<{ path?: string[] | string }>;
}

export async function handleProxy(req: Request, ctx?: RouteContext): Promise<Response> {
  const resolvedParams = ctx ? await ctx.params : undefined;
  const pathSegments = resolvedParams?.path;
  const subpath = Array.isArray(pathSegments) ? pathSegments.join("/") : (pathSegments ?? "");

  // WebSocket / VNC bailout constraint
  const connectionHeader = req.headers.get("connection")?.toLowerCase() ?? "";
  const upgradeHeader = req.headers.get("upgrade")?.toLowerCase() ?? "";
  const isUpgrade = connectionHeader.includes("upgrade") || upgradeHeader.length > 0;
  const isVnc = subpath.includes("vnc") || (Array.isArray(pathSegments) && pathSegments.includes("vnc"));

  if (isUpgrade || isVnc) {
    return new Response(
      JSON.stringify({
        error: "WebSocket upgrades and VNC paths are not supported by the Route Handler",
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-proxy-bailout": "upgrade",
          connection: "close",
        },
      },
    );
  }

  const url = new URL(req.url);
  const targetUrl = `${forgeControlBase()}/api/${subpath}${url.search}`;

  // Forward incoming headers (filtering hop-by-hop)
  const forwardHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  // Untyped `init` deliberately: this module is typechecked twice, once under
  // forge-control-web's DOM lib (RequestInit has `cache`) and once under
  // forge-control's Node-only lib (undici-types' RequestInit does not). An
  // explicit `RequestInit` annotation would trigger an excess-property error
  // in the latter; passing an inferred object literal by reference does not.
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const init = {
    method: req.method,
    headers: forwardHeaders,
    signal: req.signal,
    cache: "no-store" as const,
    redirect: "manual" as const,
    ...(hasBody ? { body: req.body, duplex: "half" as const } : {}),
  };

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, init);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `upstream fetch failed: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  // Null-body HTTP statuses in Fetch API standard
  if (
    upstreamResponse.status === 204 ||
    upstreamResponse.status === 205 ||
    upstreamResponse.status === 304 ||
    req.method === "HEAD"
  ) {
    return new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
