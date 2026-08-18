/**
 * serve-sse-808.ts — the worktree harness for round 808, because the existing
 * one CANNOT serve a stream.
 *
 * `serve-v3-7798.ts` is a hand-rolled node http server whose `writeOut()`
 * buffers every response through `arrayBuffer()` before writing a byte. That is
 * fine for JSON and fatal for SSE: the route's headers never leave the process,
 * so a client waits forever. The file says so itself (see its SSE_EXCEPTION
 * block) and routes `/api/chat/:id/events` to production to avoid the hang.
 *
 * Round 808 replaces the composer's credential poll with a server-push stream
 * (`GET /api/secrets/events`), so "the harness cannot stream" stopped being an
 * acceptable limitation — every measurement of the round would otherwise be
 * taken against a client stuck in fallback mode, which is exactly the state the
 * round exists to leave.
 *
 * This is that harness. Same mount table, same isolate-the-store rule, but
 * built on `@hono/node-server` — the adapter forge-control's own index.ts uses,
 * which streams a Response body instead of buffering it. Everything not mounted
 * is proxied to :7700 with the body passed through untouched, so an SSE route
 * that lives upstream (canvas, chat events) also streams rather than hanging.
 *
 * serve-v3-7798.ts is left ALONE: it is a phase-300 artifact, other rounds are
 * running against it right now, and its buffering is load-bearing for the
 * pass-through behaviour they measured.
 *
 * ── THE STORE IS PART OF THE PORT DECISION (inherited from round 802) ──────
 * `POST /api/secrets/...` writes to whatever `SECRET_STORE_DIR` this process
 * was started with, and secret-store.ts defaults to /opt/ai-os/.secrets/store —
 * Konrad's REAL credentials. This harness exercises the write paths, so point
 * it somewhere else, and never borrow another round's server to find out where
 * it was pointed:
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   export SECRET_STORE_DIR=/tmp/p808-store
 *   cd forge-control && SERVE_SSE_PORT=7845 \
 *     ./node_modules/.bin/tsx ../scripts/checks/serve-sse-808.ts
 *
 * NEVER import forge-control/src/index.ts here. index.ts boots the cron tick,
 * the Telegram bridge, the vault sync and the probe loop against the SAME
 * database and the SAME bot token — a second instance would fire real cron
 * runs and steal Konrad's Telegram long-poll. Routers only, like serve-v3.
 */

/* `scripts/` has no node_modules of its own, so bare specifiers do not resolve
 * from here — serve-v3-7798.ts sidesteps that by importing nothing but node
 * builtins. This harness needs the real adapter, so it reaches into
 * forge-control's tree by path. Same packages, same versions, same resolution
 * pnpm gives index.ts; only the specifier is spelled differently.
 *
 * Both specifiers name the PACKAGE DIRECTORY, and that is load-bearing rather
 * than tidy. They used to end in `/dist/index.js`, which reaches the same
 * runtime file and steps straight past the package's own `types` field
 * (`dist/types/index.d.ts` for hono) — so `Hono` came out as `any` (TS7016) and
 * the `c` of the proxy handler below followed it (TS7006), in a file nothing
 * ever compiled. Naming the directory lets Node resolve `main`/`exports` and
 * tsc resolve `types`, which is the only spelling that satisfies both. Pointing
 * at the .d.ts instead does not: TS2846, a declaration file cannot be imported
 * without `import type`, and `import type` cannot construct a server. */
import { serve } from "../../forge-control/node_modules/@hono/node-server";
import { Hono } from "../../forge-control/node_modules/hono";
import agents from "../../forge-control/src/routes/agents.ts";
import chat from "../../forge-control/src/routes/chat.ts";
import projects from "../../forge-control/src/routes/projects.ts";
import capabilities from "../../forge-control/src/routes/capabilities.ts";
import secrets from "../../forge-control/src/routes/secrets.ts";

const PORT = ((): number => {
  const raw = process.env.SERVE_SSE_PORT;
  if (raw === undefined || raw === "") {
    throw new Error(
      "SERVE_SSE_PORT is required — this harness has no default port on purpose, so it can never collide with another round's server",
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(
      `SERVE_SSE_PORT must be an integer in [1024, 65535]; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
})();

const UPSTREAM = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

const app = new Hono();

/* Mount table — the prefixes index.ts gives these same routers. Anything not
 * listed proxies to :7700. */
app.route("/api/agents", agents);
app.route("/api/chat", chat);
app.route("/api/projects", projects);
app.route("/api/capabilities", capabilities);
app.route("/api/secrets", secrets);

/** Everything else: a transparent proxy that hands the upstream Response back
 *  whole. No `arrayBuffer()` anywhere — that is the entire point of this file.
 *  A failure to reach :7700 is reported as a 502 WITH the reason; a silent
 *  empty body here would look exactly like a stream that never spoke. */
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const target = `${UPSTREAM}${url.pathname}${url.search}`;
  const method = c.req.method;
  const body =
    method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
  try {
    const upstream = await fetch(target, {
      method,
      headers: c.req.raw.headers,
      body,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `harness proxy to ${UPSTREAM} failed: ${msg}` }, 502);
  }
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
console.log(
  `[serve-sse-808] :${PORT} — worktree routers + streaming proxy to ${UPSTREAM}\n` +
    `[serve-sse-808] SECRET_STORE_DIR=${process.env.SECRET_STORE_DIR ?? "(default — REAL STORE, stop)"}`,
);
