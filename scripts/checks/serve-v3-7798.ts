/**
 * serve-v3-7798.ts — worktree test harness for phase 300 (read-side API, UI v3).
 *
 * Generalization of the phase-1 harness `serve-agents-7798.ts` (which stays
 * untouched as the phase-1 artifact). Where that one mounted a single router,
 * this one serves THIS WORKTREE's `agents`, `chat` and `projects` routers on
 * 127.0.0.1:7798 and passes every other path through to production :7700 — so
 * phase-300 builders and reviewers can curl the routes under test without
 * touching pm2, production, or the live checkout at /opt/forge-ai-os.
 *
 * ── Why this is not `pnpm dev` on another port ──────────────────────────
 * NEVER import or boot `forge-control/src/index.ts` on :7798. index.ts:193-206
 * starts startCronTick(), startTelegramBridge(), startVaultSyncTick() and
 * startProbeLoop() against the SAME database and the SAME Telegram bot token:
 * a second instance would double-fire cron schedules (spawning real runs),
 * steal Konrad's Telegram long-poll, and write to the vault. This harness
 * mounts ROUTERS ONLY. Each of the three is read-mostly SQL on the shared pool
 * (the write paths — POST /api/chat/:id/message, POST /api/projects — are the
 * same handlers production runs, so they are exactly as safe as calling :7700,
 * no more and no less), and none of the imported modules has a top-level side
 * effect (verified: no top-level timers/loops in db/runs.ts, db/projects.ts,
 * lib/cc-runner.ts, lib/workspace.ts, lib/canvas-context.ts).
 *
 * ── Why node:http and not a Hono app ────────────────────────────────────
 * This file lives in the repo-root `scripts/` tree, which has no
 * `node_modules` — bare `import { Hono } from "hono"` does not resolve from
 * here (verified: MODULE_NOT_FOUND), and NF4 forbids adding a dependency to
 * make it. The routers are themselves fetch-compatible, so node's built-in
 * http server plus `router.fetch(Request)` gives the same behaviour with zero
 * resolution games. The mount prefix that `app.route()` would strip is
 * stripped explicitly below.
 *
 * ── Known limitation ────────────────────────────────────────────────────
 * The pass-through is BUFFERED: it awaits the whole upstream body before
 * replying. Streaming endpoints are therefore NOT supported through :7798 —
 * they hang until the upstream response ends. Locally-mounted routes have the
 * same problem: writeOut() awaits `arrayBuffer()` on the router's own
 * Response, so a locally-served SSE stream would never flush either. Hence the
 * hard exception below. A phase that genuinely needs a live stream through
 * :7798 must switch both paths to a piped stream.
 *
 * Run:
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, so it
 * needs its own invocation with the same compiler options):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/serve-v3-7798.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import agents from "../../forge-control/src/routes/agents.ts";
import chat from "../../forge-control/src/routes/chat.ts";
import projects from "../../forge-control/src/routes/projects.ts";
import capabilities from "../../forge-control/src/routes/capabilities.ts";

const PORT = 7798;
const HOST = "127.0.0.1";
const UPSTREAM = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

/** A fetch-compatible Hono router, narrowed to the one method we call. Typing
 *  it structurally avoids importing `hono` from this node_modules-less tree. */
type FetchRouter = { fetch(request: Request): Response | Promise<Response> };

/** Mount table — the prefixes index.ts gives these same routers. Anything not
 *  listed here proxies to :7700. Order is irrelevant: matchMount() requires an
 *  exact-or-followed-by-slash match, so no prefix can shadow another. */
const MOUNTS: ReadonlyArray<{ prefix: string; router: FetchRouter }> = [
  { prefix: "/api/agents", router: agents },
  { prefix: "/api/chat", router: chat },
  { prefix: "/api/projects", router: projects },
  { prefix: "/api/capabilities", router: capabilities },
];

/**
 * HARD EXCEPTION — `GET /api/chat/:id/events` must never be served locally.
 *
 * chat.ts:79 answers that path with `streamSSE()`: a Response whose body is an
 * open-ended stream that only ends when the run ends (minutes, or never for an
 * idle chat). writeOut() below buffers the whole body via `arrayBuffer()`
 * before writing a single byte, so serving it locally would hang the request
 * forever AND wedge the harness. Routing it to the upstream proxy does not fix
 * the buffering — it hangs there too — but it keeps the failure identical to
 * the pre-existing phase-1 limitation instead of making the worktree router
 * look broken, and it means a curl against :7798/api/chat/<id>/events is
 * talking to production's stream, which is the only thing that can serve it.
 * Phase 300 is read-side JSON only and never needs this path.
 */
const SSE_EXCEPTION = /^\/api\/chat\/[^/]+\/events$/;

/** Hop-by-hop and length/encoding headers we must not copy verbatim: the
 *  bodies here are already decoded and re-framed by node. */
const STRIPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "host",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function inboundHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || STRIPPED.has(k.toLowerCase())) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

async function writeOut(res: ServerResponse, upstream: Response): Promise<void> {
  const body = Buffer.from(await upstream.arrayBuffer());
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) out[key] = value;
  });
  res.writeHead(upstream.status, out);
  res.end(body);
}

/**
 * Pick the mount that owns `pathname`, or null to proxy.
 *
 * The match is exact-or-followed-by-slash, never a bare `startsWith`: with a
 * bare prefix test `/api/projects` would swallow `/api/projectsomething`, and
 * a future `/api/chats` route would be eaten by `/api/chat`. Query strings are
 * not part of `pathname`, so they need no special handling.
 */
function matchMount(
  method: string,
  pathname: string,
): { prefix: string; router: FetchRouter } | null {
  if (method === "GET" && SSE_EXCEPTION.test(pathname)) return null;
  for (const mount of MOUNTS) {
    if (pathname === mount.prefix || pathname.startsWith(`${mount.prefix}/`)) return mount;
  }
  return null;
}

/** `/api/agents` → `/`, `/api/agents/<id>` → `/<id>` — what app.route() does. */
function stripMount(prefix: string, pathname: string): string {
  const rest = pathname.slice(prefix.length);
  return rest === "" || rest === "/" ? "/" : rest;
}

const server = createServer((req, res) => {
  void (async () => {
    const rawUrl = req.url ?? "/";
    const method = req.method ?? "GET";
    const url = new URL(rawUrl, `http://${HOST}:${PORT}`);
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readBody(req) : undefined;
    const mount = matchMount(method, url.pathname);

    try {
      if (mount) {
        const target = `http://${HOST}:${PORT}${stripMount(mount.prefix, url.pathname)}${url.search}`;
        const upstream = await mount.router.fetch(
          new Request(target, { method, headers: inboundHeaders(req), body }),
        );
        await writeOut(res, upstream);
        return;
      }
      const upstream = await fetch(`${UPSTREAM}${rawUrl}`, {
        method,
        headers: inboundHeaders(req),
        body,
        redirect: "manual",
      });
      await writeOut(res, upstream);
    } catch (err) {
      // Explicit diagnostics, never a silent empty 200 — a harness that lies
      // about the API under test is worse than no harness.
      const message = err instanceof Error ? err.message : String(err);
      const where = mount ? `local ${mount.prefix}` : "proxy";
      console.error(`[7798] ${method} ${rawUrl} → ${where} failed:`, err);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: mount ? `worktree router ${mount.prefix} threw` : "upstream proxy failed",
          upstream: mount ? null : UPSTREAM,
          path: rawUrl,
          message,
        }),
      );
    }
  })();
});

server.listen(PORT, HOST, () => {
  for (const { prefix } of MOUNTS) console.log(`[7798] worktree ${prefix} live on http://${HOST}:${PORT}`);
  console.log(`[7798] GET /api/chat/:id/events is proxied on purpose (buffered writer cannot stream SSE)`);
  console.log(`[7798] everything else proxies (buffered, no SSE) to ${UPSTREAM}`);
});
