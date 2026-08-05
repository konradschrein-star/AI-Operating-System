/**
 * serve-agents-7798.ts — worktree test harness for phase 1 (time truth).
 *
 * Serves THIS WORKTREE's `forge-control/src/routes/agents.ts` on
 * 127.0.0.1:7798 and passes every other path through to production :7700,
 * so the phase-1b builder can point the worktree web UI at a patched API
 * without touching pm2, production, or the live checkout.
 *
 * ── Why this is not `pnpm dev` on another port ──────────────────────────
 * NEVER boot `forge-control/src/index.ts` on :7798. index.ts:193-206 starts
 * startCronTick(), startTelegramBridge(), startVaultSyncTick() and
 * startProbeLoop() against the SAME database and the SAME Telegram bot
 * token: a second instance would double-fire cron schedules (spawning real
 * runs), steal Konrad's Telegram long-poll, and write to the vault. This
 * harness mounts the ONE router — `routes/agents.ts` is read-only SQL on its
 * own pool, so running it twice is safe.
 *
 * ── Why node:http and not a Hono app ────────────────────────────────────
 * This file lives in the repo-root `scripts/` tree, which has no
 * `node_modules` — bare `import { Hono } from "hono"` does not resolve from
 * here (verified: MODULE_NOT_FOUND), and NF4 forbids adding a dependency to
 * make it. The agents router is itself fetch-compatible, so node's built-in
 * http server plus `agents.fetch(Request)` gives the same behaviour with
 * zero resolution games. The `/api/agents` prefix that `app.route()` would
 * strip is stripped explicitly below.
 *
 * ── Known limitation ────────────────────────────────────────────────────
 * The pass-through is BUFFERED: it awaits the whole upstream body before
 * replying. SSE / streaming endpoints (`/api/chat/:id/stream` and friends)
 * are therefore NOT supported through :7798 — they will hang until the
 * upstream response ends. Phase 1 does not need them; a phase that does
 * must switch the proxy to a piped stream.
 *
 * Run:
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-agents-7798.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, so it
 * needs its own invocation with the same compiler options):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/serve-agents-7798.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import agents from "../../forge-control/src/routes/agents.ts";

const PORT = 7798;
const HOST = "127.0.0.1";
const UPSTREAM = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";
const MOUNT = "/api/agents";

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

/** `/api/agents` → `/`, `/api/agents/<id>` → `/<id>` — what app.route() does. */
function stripMount(pathname: string): string {
  const rest = pathname.slice(MOUNT.length);
  return rest === "" || rest === "/" ? "/" : rest;
}

const server = createServer((req, res) => {
  void (async () => {
    const rawUrl = req.url ?? "/";
    const method = req.method ?? "GET";
    const url = new URL(rawUrl, `http://${HOST}:${PORT}`);
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readBody(req) : undefined;
    const local = url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`);

    try {
      if (local) {
        const target = `http://${HOST}:${PORT}${stripMount(url.pathname)}${url.search}`;
        const upstream = await agents.fetch(
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
      console.error(`[7798] ${method} ${rawUrl} → ${local ? "local" : "proxy"} failed:`, err);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: local ? "worktree agents router threw" : "upstream proxy failed",
          upstream: local ? null : UPSTREAM,
          path: rawUrl,
          message,
        }),
      );
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`[7798] worktree ${MOUNT} live on http://${HOST}:${PORT}`);
  console.log(`[7798] everything else proxies (buffered, no SSE) to ${UPSTREAM}`);
});
