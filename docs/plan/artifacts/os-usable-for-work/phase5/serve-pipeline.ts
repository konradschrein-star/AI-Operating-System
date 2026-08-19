/**
 * serve-pipeline.ts — the `business` lane's worktree API harness (phase 5, N3).
 *
 * Descendant of `scripts/checks/serve-v3-7798.ts`; read that file's header
 * first, because every safety argument in it applies here unchanged. What is
 * different is the mount table (ONE router) and the stub mode (§ MODE B).
 *
 * It serves THIS WORKTREE's `pipeline` router on 127.0.0.1:<port> and passes
 * every other path through to production :7700 — so a phase-5 builder or
 * reviewer can curl `GET /api/pipeline` against the code they are editing
 * without touching pm2, production, or the live checkout at /opt/forge-ai-os.
 *
 * ── NEVER BOOT forge-control/src/index.ts ───────────────────────────────
 * index.ts:193-206 starts startCronTick(), startTelegramBridge(),
 * startVaultSyncTick() and startProbeLoop() against the SAME database and the
 * SAME Telegram bot token. A second instance double-fires cron schedules
 * (spawning real runs), steals Konrad's Telegram long-poll, and writes to the
 * vault. This harness mounts ROUTERS ONLY.
 *
 * ── WHAT THE ONE MOUNTED ROUTER ACTUALLY DOES (audited, not assumed) ────
 * `routes/pipeline.ts` is 11 lines: one `GET /` calling `getPipeline()` from
 * `db/pipeline.ts`. `getPipeline()` issues exactly one statement — a `SELECT`
 * over `content_jobs` LEFT JOIN `channels` LEFT JOIN `content_templates`,
 * `LIMIT 500`. There is no INSERT/UPDATE/DELETE anywhere in either file, so
 * running this harness cannot violate R68 (Content Forge is read-only).
 *
 * `db/pipeline.ts` has ONE top-level side effect: it constructs a `pg.Pool` at
 * import time (line 17). `pg.Pool` is lazy — it opens no socket until the
 * first `query()` — so importing this module from a typecheck or a `--help`
 * run connects to nothing. The pool's connection string is
 * `process.env.DATABASE_URL`, which in /opt/ai-os/.secrets/forge-control.env
 * is `content_forge` on 127.0.0.1:5432. That is deliberate and correct: the
 * pipeline reads Content Forge's own database.
 *
 * ── MODE A — proxy to live :7700 (READ-ONLY observation) ────────────────
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   cd forge-control
 *   SERVE_PIPELINE_PORT=7841 ./node_modules/.bin/tsx \
 *     ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts
 *
 * `GET /api/pipeline` is answered by THIS worktree's code against the live
 * content_forge database. Everything else (auth, spend, projects, …) proxies
 * to production :7700 unchanged. This is the mode the before-screenshots were
 * taken in.
 *
 * ── MODE B — stub the pipeline payload (the FLIP TEST) ──────────────────
 *   PIPELINE_STUB_FILE=/tmp/p5-stub-fresh.json SERVE_PIPELINE_PORT=7841 \
 *     ./node_modules/.bin/tsx .../serve-pipeline.ts
 *
 * With `PIPELINE_STUB_FILE` set, `GET /api/pipeline` returns that file's JSON
 * verbatim and NEVER touches the database. Everything else still proxies.
 *
 * WHY THIS MODE HAS TO EXIST, stated plainly so nobody removes it as clutter:
 * R64's acceptance criterion is "all 5 QC jobs render as stalled with ages of
 * 11-14 days, AND a fresh job renders not-stalled". There is no fresh job in
 * `content_jobs` — the live table holds 24 rows, 19 MARKED_FOR_DELETION and 5
 * aged 11-14 days (measured; see premises-remeasured.md § P2). R68 forbids
 * writing one. So the ONLY way to prove the not-stalled branch renders is to
 * feed the surface a payload containing a fresh job. A stub file is that, and
 * it is honest: the payload is visibly synthetic and no database is consulted.
 *
 * The stub is read and JSON-parsed ONCE, at startup, and a bad path or bad
 * JSON is a hard throw before the port opens — not a fall back to the live
 * query. A harness that silently serves real data when you asked for a stub
 * would make the flip test pass for the wrong reason, which is precisely the
 * class of lie this project exists to kill.
 *
 * ── KNOWN LIMITATION, inherited ─────────────────────────────────────────
 * The pass-through is BUFFERED: it awaits the whole upstream body before
 * replying. Streaming endpoints (SSE, e.g. GET /api/chat/:id/events) hang
 * until the upstream response ends. Phase 5 needs no stream. If a later task
 * does, switch both paths to a piped stream rather than working around it.
 *
 * ── TYPECHECK ───────────────────────────────────────────────────────────
 * This file sits outside forge-control's tsconfig `include`, so it needs its
 * own invocation with the same compiler options:
 *
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pipeline from "../../../../../forge-control/src/routes/pipeline.ts";

/**
 * The port. Default 7841 (7798 and 7780/7781 are taken by other lanes' and
 * earlier rounds' harnesses; a collision would silently measure someone
 * else's worktree). A non-numeric or out-of-range value is a hard error
 * rather than a silent fall back — falling back would point the measurement
 * at whichever server already owns the default.
 */
const PORT = ((): number => {
  const raw = process.env.SERVE_PIPELINE_PORT;
  if (raw === undefined || raw === "") return 7841;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(
      `SERVE_PIPELINE_PORT must be an integer in [1024, 65535]; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
})();

const HOST = "127.0.0.1";
const UPSTREAM = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

/**
 * MODE B's payload, resolved at startup so a bad stub kills the process
 * before the port opens instead of at the first request, when a browser is
 * already pointed at it and the failure reads as "the surface is broken".
 */
const STUB: string | null = ((): string | null => {
  const file = process.env.PIPELINE_STUB_FILE;
  if (file === undefined || file === "") return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`PIPELINE_STUB_FILE ${JSON.stringify(file)} is unreadable: ${message}`);
  }
  try {
    JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`PIPELINE_STUB_FILE ${JSON.stringify(file)} is not valid JSON: ${message}`);
  }
  return raw;
})();

/** A fetch-compatible Hono router, narrowed to the one method we call. Typing
 *  it structurally avoids importing `hono` from this node_modules-less tree. */
type FetchRouter = { fetch(request: Request): Response | Promise<Response> };

/** Mount table — the prefix index.ts:169 gives this router. Anything not
 *  listed here proxies to :7700. */
const MOUNTS: ReadonlyArray<{ prefix: string; router: FetchRouter }> = [
  { prefix: "/api/pipeline", router: pipeline },
];

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
 * bare prefix test a future `/api/pipelines` route would be eaten by
 * `/api/pipeline`. Query strings are not part of `pathname`.
 */
function matchMount(pathname: string): { prefix: string; router: FetchRouter } | null {
  for (const mount of MOUNTS) {
    if (pathname === mount.prefix || pathname.startsWith(`${mount.prefix}/`)) return mount;
  }
  return null;
}

/** `/api/pipeline` → `/`, `/api/pipeline/x` → `/x` — what app.route() does. */
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
    const mount = matchMount(url.pathname);

    try {
      if (mount && STUB !== null && method === "GET") {
        // MODE B. The stub answers the router's own path only; a POST or a
        // sub-path still falls through to the real router below, so the stub
        // cannot accidentally mask a route it was never meant to model.
        const rest = stripMount(mount.prefix, url.pathname);
        if (rest === "/") {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-phase5-harness": "stub",
          });
          res.end(STUB);
          return;
        }
      }
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
      // about the API under test is worse than no harness (N1).
      const message = err instanceof Error ? err.message : String(err);
      const where = mount ? `local ${mount.prefix}` : "proxy";
      console.error(`[p5] ${method} ${rawUrl} → ${where} failed:`, err);
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
  const mode = STUB === null ? "LIVE (worktree code → content_forge)" : `STUB (${process.env.PIPELINE_STUB_FILE})`;
  for (const { prefix } of MOUNTS) console.log(`[p5] worktree ${prefix} live on http://${HOST}:${PORT} — mode ${mode}`);
  console.log(`[p5] everything else proxies (buffered, no SSE) to ${UPSTREAM}`);
});
