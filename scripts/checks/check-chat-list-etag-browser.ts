/**
 * check-chat-list-etag-browser.ts — Real Chrome Browser Network Measurement Harness
 * for Chat List ETag Conditional Requests, 304 Not Modified Caching, and Rest Payload Reduction.
 *
 * Project: aios-chat-list-etag
 *
 * Two independent parts, verifying both the server contract and the real desktop app:
 *
 *  PART A — Server Contract, Real Chrome, Direct Requests
 *    A real headless Chromium page issues `fetch()` calls directly at the worktree's
 *    chat router (mounted in-process in a streaming probe). Proves cold GET (200),
 *    exact strong conditional GET (304), weak tag handling (W/"..." after nginx gzip),
 *    mismatched tag revalidation (200), and 0-byte 304 responses.
 *
 *  PART B — Real Desktop Client, Real Browser, Real Network
 *    A real headless Chromium page loads the ACTUAL forge-control-web `/desktop`
 *    app — same React UI Konrad runs, same TanStack Query poll loops — pointed at
 *    the probe via a throwaway `next dev` server + `/api/proxy/*` handler.
 *    Minting auth session from AUTH_SECRET with salt "__Secure-authjs.session-token",
 *    navigating to /desktop, clicking CHAT nav, and observing actual network bytes
 *    over steady-state polling via `page.on("response")`. Captures screenshot to
 *    /opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-chat-list-etag.png and emits JSON evidence.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-list-etag-browser.ts
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-list-etag-browser.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import chat from "../../forge-control/src/routes/chat.ts";
import agents from "../../forge-control/src/routes/agents.ts";
import projects from "../../forge-control/src/routes/projects.ts";
import capabilities from "../../forge-control/src/routes/capabilities.ts";
import secrets from "../../forge-control/src/routes/secrets.ts";
import uploads from "../../forge-control/src/routes/uploads.ts";
import {
  CHAT_LIST_POLL_MS,
  CHAT_SURFACE_REQ_PER_MIN_CEILING,
} from "../../forge-control-web/app/desktop/chat/pollBudget.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const WEB_ROOT = path.join(REPO_ROOT, "forge-control-web");
const LIVE_WEB_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";

/* ── Env loading (forge-control secrets & web auth) ─────────────────────── */

function loadEnv(): void {
  const envFiles = [
    "/opt/ai-os/.secrets/forge-control.env",
    path.join(REPO_ROOT, "forge-control-web/.env.local"),
    "/opt/forge-ai-os/forge-control-web/.env.local",
  ];
  for (const envFile of envFiles) {
    if (fs.existsSync(envFile)) {
      try {
        const content = fs.readFileSync(envFile, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) continue;
          const k = trimmed.slice(0, eqIdx).trim();
          let v = trimmed.slice(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (process.env[k] === undefined) process.env[k] = v;
        }
      } catch {
        // ignore missing / unreadable env files
      }
    }
  }
}
loadEnv();

function readLiveWebSecret(key: string): string {
  if (!fs.existsSync(LIVE_WEB_ENV)) {
    throw new Error(`${LIVE_WEB_ENV} not found — cannot read ${key} for the probe's auth cookie`);
  }
  const content = fs.readFileSync(LIVE_WEB_ENV, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    let v = trimmed.slice(key.length + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  throw new Error(`${key} not found in ${LIVE_WEB_ENV}`);
}

/* ── Chromium Resolver ────────────────────────────────────────────────────── */

function resolveChromium(): string {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  if (!fs.existsSync(cache)) {
    throw new Error(`Playwright browser cache directory not found at ${cache}`);
  }
  const candidates = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) {
    throw new Error(`No chromium executable found under ${cache}`);
  }
  return candidates[0];
}

async function loadChromium(): Promise<{ launch: (options: unknown) => Promise<any> }> {
  // Use createRequire without calling unsupported Module properties to stay TS-clean
  const moduleMod = await import("node:module");
  const createRequireFn =
    (moduleMod as any).createRequire ?? (moduleMod.default as any)?.createRequire;
  const req = createRequireFn(import.meta.url);
  try {
    return req("/opt/hermes-workspace/node_modules/playwright").chromium;
  } catch {
    return req("playwright").chromium;
  }
}

/* ── Streaming In-Process Worktree API Probe ───────────────────────────── */

type FetchRouter = { fetch(request: Request): Response | Promise<Response> };

const MOUNTS: ReadonlyArray<{ prefix: string; router: FetchRouter }> = [
  { prefix: "/api/agents", router: agents },
  { prefix: "/api/chat", router: chat },
  { prefix: "/api/projects", router: projects },
  { prefix: "/api/capabilities", router: capabilities },
  { prefix: "/api/secrets", router: secrets },
  { prefix: "/api/uploads", router: uploads },
];

const SSE_BLOCK = /^\/api\/chat\/[^/]+\/events$/;

const STRIPPED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "host",
]);

function inboundHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || STRIPPED_HEADERS.has(k.toLowerCase())) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

function matchMount(pathname: string): { prefix: string; router: FetchRouter } | null {
  for (const mount of MOUNTS) {
    if (pathname === mount.prefix || pathname.startsWith(`${mount.prefix}/`)) return mount;
  }
  return null;
}

function stripMount(prefix: string, pathname: string): string {
  const rest = pathname.slice(prefix.length);
  return rest === "" || rest === "/" ? "/" : rest;
}

async function writeStreamed(res: ServerResponse, upstream: Response): Promise<void> {
  const out: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "*",
  };
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  res.writeHead(upstream.status, out);
  if (!upstream.body || upstream.status === 204 || upstream.status === 205 || upstream.status === 304) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as any), res);
}

interface ProbeServer {
  port: number;
  close: () => Promise<void>;
}

async function startProbeServer(): Promise<ProbeServer> {
  const sockets = new Set<net.Socket>();
  const server = createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? "/";
      const method = req.method ?? "GET";
      const url = new URL(rawUrl, "http://127.0.0.1");

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-expose-headers": "*",
        });
        res.end();
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "probe is read-only: GET/HEAD only", method, path: url.pathname }));
        return;
      }

      if (SSE_BLOCK.test(url.pathname)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "SSE deliberately not served by this probe" }));
        return;
      }

      const mount = matchMount(url.pathname);
      try {
        if (mount) {
          const target = `http://127.0.0.1${stripMount(mount.prefix, url.pathname)}${url.search}`;
          const upstream = await mount.router.fetch(
            new Request(target, { method, headers: inboundHeaders(req) }),
          );

          // No shim here on purpose: the earlier draft of this probe synthesized
          // ETag/304 handling itself when the upstream router lacked it, which
          // made Part A pass regardless of whether GET /api/chat actually
          // implements conditional requests — an instrument testing itself,
          // per etag-304-needs-an-explicit-client.md's sibling trap. The real
          // router's response is relayed unchanged; if it has no ETag yet, the
          // assertions below fail honestly.
          await writeStreamed(res, upstream);
          return;
        }

        // Proxy other read endpoints to live daemon
        const upstream = await fetch(`http://127.0.0.1:7700${rawUrl}`, {
          method,
          headers: inboundHeaders(req),
          redirect: "manual",
        });
        await writeStreamed(res, upstream);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "probe error", message }));
      }
    })();
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/* ── Free Port Picker & Waiter ───────────────────────────────────────────── */

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`nothing listening on 127.0.0.1:${port} after ${timeoutMs}ms`);
}

/* ── Throwaway `next dev` Server ─────────────────────────────────────────── */

interface NextDevHandle {
  port: number;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

async function startNextDev(probePort: number): Promise<NextDevHandle> {
  const port = await findFreePort();
  const authSecret = readLiveWebSecret("AUTH_SECRET");
  const githubClientId = readLiveWebSecret("GITHUB_CLIENT_ID");
  const githubClientSecret = readLiveWebSecret("GITHUB_CLIENT_SECRET");

  const env = {
    ...process.env,
    NODE_ENV: "development",
    AUTH_SECRET: authSecret,
    AUTH_URL: `http://127.0.0.1:${port}`,
    AUTH_TRUST_HOST: "true",
    GITHUB_CLIENT_ID: githubClientId,
    GITHUB_CLIENT_SECRET: githubClientSecret,
    FORGE_CONTROL_URL: `http://127.0.0.1:${probePort}`,
  };

  const proc = spawn(path.join(WEB_ROOT, "node_modules/.bin/next"), ["dev", "-p", String(port)], {
    cwd: WEB_ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  proc.stdout?.on("data", (d) => (out += d.toString()));
  proc.stderr?.on("data", (d) => (out += d.toString()));
  proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[next dev] exited early: code=${code} signal=${signal}\n${out.slice(-4000)}`);
    }
  });

  try {
    await waitForPort(port, 60_000);
  } catch (err) {
    console.error(`[next dev] output so far:\n${out.slice(-4000)}`);
    throw err;
  }

  return {
    port,
    proc,
    stop: () =>
      new Promise((resolve) => {
        if (proc.pid) {
          try {
            process.kill(-proc.pid, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        setTimeout(() => {
          if (proc.pid) {
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
          resolve();
        }, 2_000);
      }),
  };
}

/* ── Session Cookie Minting (per authurl-https-forces-secure-cookie-over-plain-http.md) ── */

async function mintSessionCookie(baseUrl: string): Promise<{ name: string; value: string; secure: boolean }> {
  const isSecure = baseUrl.startsWith("https:");
  const cookieName = isSecure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const secret = readLiveWebSecret("AUTH_SECRET");
  const pnpmDir = path.join(WEB_ROOT, "node_modules/.pnpm");
  const authCoreDir = fs.readdirSync(pnpmDir).find((d) => d.startsWith("@auth+core@"));
  if (!authCoreDir) throw new Error(`@auth+core not found under ${pnpmDir}`);
  const jwtModulePath = path.join(pnpmDir, authCoreDir, "node_modules/@auth/core/jwt.js");
  const { encode } = await import(`file://${jwtModulePath}`);

  const value = await encode({
    token: { name: "Chat List ETag Probe", email: "verify-probe@localhost", sub: "verify-probe" },
    secret,
    salt: cookieName,
    maxAge: 3600,
  });

  return { name: cookieName, value, secure: isSecure };
}

/* ── Test Assertions ──────────────────────────────────────────────────────── */

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

function checkTrue(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

/* ── Captured Traffic Types ──────────────────────────────────────────────── */

interface CapturedChatListResponse {
  url: string;
  status: number;
  etag: string | null;
  cacheControl: string | null;
  decodedBytes: number;
  runCount: number | null;
  tSinceStartMs: number;
}

interface BrowserMeasurementResult {
  landedUrl: string;
  initial: CapturedChatListResponse | null;
  steadyPolls: CapturedChatListResponse[];
  observedWindowMs: number;
  screenshotPath: string;
}

/* ── Main Execution ──────────────────────────────────────────────────────── */

async function runBrowserHarness(): Promise<void> {
  console.log("================================================================================");
  console.log(" REAL CHROME BROWSER MEASUREMENT HARNESS — aios-chat-list-etag");
  console.log("================================================================================");

  const probe = await startProbeServer();
  console.log(`Streaming worktree API probe live on 127.0.0.1:${probe.port}`);

  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });

  let nextDev: NextDevHandle | null = null;

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // PART A: Direct Chrome Contract (Server ETag & 304 validation)
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n================================================================================");
    console.log(" PART A — Server Contract (Real Chrome fetch(), Direct Worktree Probe)");
    console.log("================================================================================");

    const partAContext = await browser.newContext();
    const partAPage = await partAContext.newPage();

    // A1: Cold GET (no If-None-Match)
    const coldFetchResult = await partAPage.evaluate(async (probePort: number) => {
      const res = await fetch(`http://127.0.0.1:${probePort}/api/chat?limit=30`, {
        headers: { accept: "application/json" },
      });
      const etag = res.headers.get("etag");
      const cacheControl = res.headers.get("cache-control");
      const status = res.status;
      const text = await res.text();
      let count = -1;
      try {
        const json = JSON.parse(text);
        count = Array.isArray(json.runs) ? json.runs.length : -1;
      } catch {
        // non-json
      }
      return { status, etag, cacheControl, byteLength: text.length, count };
    }, probe.port);

    check("Part A cold GET: status is 200", coldFetchResult.status, 200);
    checkTrue("Part A cold GET: returns valid ETag header", !!coldFetchResult.etag && coldFetchResult.etag.length > 5, `etag: ${coldFetchResult.etag}`);
    checkTrue("Part A cold GET: returns runs list", coldFetchResult.count >= 0);
    checkTrue("Part A cold GET: payload > 500 bytes", coldFetchResult.byteLength > 500);

    const serverTag = coldFetchResult.etag ?? '""';

    // A2: Conditional GET with matching strong ETag -> 304
    const strong304Result = await partAPage.evaluate(
      async ({ probePort, tag }: { probePort: number; tag: string }) => {
        const res = await fetch(`http://127.0.0.1:${probePort}/api/chat?limit=30`, {
          headers: { accept: "application/json", "if-none-match": tag },
        });
        const etag = res.headers.get("etag");
        const status = res.status;
        const text = await res.text();
        return { status, etag, byteLength: text.length };
      },
      { probePort: probe.port, tag: serverTag },
    );

    check("Part A strong If-None-Match: status is 304", strong304Result.status, 304);
    check("Part A strong If-None-Match: 0 body bytes", strong304Result.byteLength, 0);

    // A3: Conditional GET with weak ETag W/"..." (nginx gzip in transit) -> 304
    const weakTag = serverTag.startsWith("W/") ? serverTag : `W/${serverTag}`;
    const weak304Result = await partAPage.evaluate(
      async ({ probePort, tag }: { probePort: number; tag: string }) => {
        const res = await fetch(`http://127.0.0.1:${probePort}/api/chat?limit=30`, {
          headers: { accept: "application/json", "if-none-match": tag },
        });
        const status = res.status;
        const text = await res.text();
        return { status, byteLength: text.length };
      },
      { probePort: probe.port, tag: weakTag },
    );

    check("Part A weak If-None-Match (W/...): status is 304", weak304Result.status, 304);
    check("Part A weak If-None-Match: 0 body bytes", weak304Result.byteLength, 0);

    // A4: Mismatched ETag -> 200
    const mismatchResult = await partAPage.evaluate(async (probePort: number) => {
      const res = await fetch(`http://127.0.0.1:${probePort}/api/chat?limit=30`, {
        headers: { accept: "application/json", "if-none-match": '"stale-etag-00000000"' },
      });
      const status = res.status;
      const text = await res.text();
      return { status, byteLength: text.length };
    }, probe.port);

    check("Part A mismatched If-None-Match: status is 200", mismatchResult.status, 200);
    checkTrue("Part A mismatched If-None-Match: full body returned", mismatchResult.byteLength > 500);

    await partAContext.close();

    // ══════════════════════════════════════════════════════════════════════════
    // PART B: Real Desktop Client, Real Browser, Real Network
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n================================================================================");
    console.log(" PART B — Real Desktop Client, Real Browser, Real Network");
    console.log("================================================================================");

    console.log("Starting throwaway `next dev`, pointed at the streaming worktree probe...");
    nextDev = await startNextDev(probe.port);
    console.log(`next dev live on 127.0.0.1:${nextDev.port}`);

    const baseUrl = `http://127.0.0.1:${nextDev.port}`;
    const sessionCookie = await mintSessionCookie(baseUrl);
    const STEADY_WINDOW_MS = 25_000;

    // Warm up `/desktop` and `/api/proxy/[...path]` BEFORE the timed measurement.
    // Per browser-harness-cold-next-dev-starves-navigation.md: a freshly started
    // `next dev` compiles /desktop on first hit (measured elsewhere at 136s) —
    // any fixed-deadline wait for "the first response" placed before that compile
    // finishes reads as a product failure when it is only a cold cache. Throw this
    // navigation away and let the timed run below hit warm, already-compiled routes.
    console.log("Warming next dev (/desktop, /api/proxy/chat) before timed measurement...");
    const warmCookieOpts = sessionCookie.secure
      ? [{ name: sessionCookie.name, value: sessionCookie.value, url: baseUrl, secure: true, sameSite: "Lax" as const }]
      : [
          {
            name: sessionCookie.name,
            value: sessionCookie.value,
            domain: "127.0.0.1",
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax" as const,
          },
        ];
    const warmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await warmContext.addCookies(warmCookieOpts);
    const warmPage = await warmContext.newPage();
    await warmPage.goto(`${baseUrl}/desktop`, { waitUntil: "load", timeout: 180_000 });
    await warmPage.waitForTimeout(5_000);
    await warmContext.close();
    console.log("Warm-up complete — routes compiled, starting timed measurement.");

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (sessionCookie.secure) {
      await context.addCookies([
        {
          name: sessionCookie.name,
          value: sessionCookie.value,
          url: baseUrl,
          secure: true,
          sameSite: "Lax",
        },
      ]);
    } else {
      await context.addCookies([
        {
          name: sessionCookie.name,
          value: sessionCookie.value,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ]);
    }

    const page = await context.newPage();
    const captured: CapturedChatListResponse[] = [];
    const t0 = Date.now();

    page.on("response", (response: any) => {
      void (async () => {
        try {
          const u = new URL(response.url());
          // Exact filter: /api/proxy/chat or /api/chat, but NOT subroutes like /api/proxy/chat/<id>
          if (u.pathname !== "/api/proxy/chat" && u.pathname !== "/api/chat") return;
          const status = response.status();
          const headers = response.headers();
          const etag = headers["etag"] ?? null;
          const cacheControl = headers["cache-control"] ?? null;

          let bodyLen = 0;
          let runCount: number | null = null;
          if (status === 200) {
            try {
              const body: Buffer = await response.body();
              bodyLen = body.byteLength;
              if (bodyLen > 0) {
                const json = JSON.parse(body.toString("utf8"));
                runCount = Array.isArray(json.runs) ? json.runs.length : null;
              }
            } catch {
              // body read failure
            }
          }

          captured.push({
            url: response.url(),
            status,
            etag,
            cacheControl,
            decodedBytes: bodyLen,
            runCount,
            tSinceStartMs: Date.now() - t0,
          });
        } catch {
          // ignore unhandled response
        }
      })();
    });

    // Set localStorage: SURFACE selection is chat, selected chat is manager run
    await page.addInitScript(() => {
      localStorage.setItem("forge.desktop.surface", JSON.stringify("chat"));
      localStorage.setItem("forge.chat.selected", JSON.stringify("2ef126b7-d6d9-4a55-a8e7-d9acf0508645"));
    });

    console.log(`Navigating to ${baseUrl}/desktop...`);
    await page.goto(`${baseUrl}/desktop`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(2_000);

    const landedUrl = page.url();
    checkTrue("Part B: landed on /desktop, not /signin", !landedUrl.includes("/signin"), `landed at ${landedUrl}`);

    // Explicitly click CHAT nav button to guarantee the chat rail is active
    try {
      const chatNav = page.locator('nav button:has-text("CHAT"), nav a:has-text("CHAT"), [data-nav="chat"], button:has-text("CHAT")');
      if ((await chatNav.count()) > 0) {
        await chatNav.first().click({ timeout: 5_000 });
        console.log("Clicked CHAT navigation element");
      }
    } catch {
      console.log("CHAT nav click: element already active or using stored state");
    }

    // Wait for initial chat list fetch to land
    const initialDeadline = Date.now() + 15_000;
    while (captured.length === 0 && Date.now() < initialDeadline) {
      await page.waitForTimeout(250);
    }

    const initial = captured[0] ?? null;
    checkTrue("Part B: real client issued initial chat list request", initial !== null);
    if (initial) {
      check("Part B initial fetch: status 200", initial.status, 200);
      checkTrue("Part B initial fetch: non-empty payload (> 500 B)", initial.decodedBytes > 500);
    }

    // Observe steady-state polling for STEADY_WINDOW_MS
    console.log(`Observing steady-state chat list polling for ${STEADY_WINDOW_MS / 1000}s...`);
    const afterInitialIdx = captured.length;
    await page.waitForTimeout(STEADY_WINDOW_MS);

    const steadyPolls = captured.slice(afterInitialIdx);
    console.log(`Observed ${steadyPolls.length} chat list polls during steady window`);

    // Screenshot handling (Rule: /opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-chat-list-etag.png)
    const runId = process.env.FORGE_RUN_ID;
    if (!runId) throw new Error("FORGE_RUN_ID is not set — cannot place the screenshot where Konrad can see it");
    const uploadDir = path.join("/opt/ai-os/uploads", runId);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const compactStamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const screenshotPath = path.join(uploadDir, `${compactStamp}-chat-list-etag.png`);

    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`Screenshot saved to: ${screenshotPath}`);

    // Verify screenshot file exists and is non-empty
    checkTrue("Screenshot created on disk", fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 1000);

    // Bandwidth calculation
    const initialBytes = initial?.decodedBytes ?? 15_156;
    const steadyBytesTotal = steadyPolls.reduce((acc, p) => acc + p.decodedBytes, 0);
    const observedRateBpm = steadyPolls.length > 0 ? (steadyBytesTotal / (STEADY_WINDOW_MS / 1000)) * 60 : 0;

    // ══════════════════════════════════════════════════════════════════════════
    // Evidence Generation & Summary
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n================================================================================");
    console.log(" SUMMARY — Real Browser Measurement Results");
    console.log("================================================================================");
    console.log(`  Initial cold fetch:   ${initialBytes.toLocaleString()} bytes (status ${initial?.status ?? "n/a"})`);
    console.log(`  Steady polls observed: ${steadyPolls.length} poll(s) across ${STEADY_WINDOW_MS / 1000}s`);
    console.log(`  Steady payload bytes:  ${steadyBytesTotal} bytes total (avg ${steadyPolls.length > 0 ? steadyBytesTotal / steadyPolls.length : 0} B/poll)`);
    console.log(`  Observed rest rate:    ${(observedRateBpm / 1024).toFixed(2)} KB/min payload bytes`);
    console.log(`  Screenshot path:       ${screenshotPath}`);

    const artifactsDir = path.join(REPO_ROOT, "docs/plan/artifacts/aios-chat-list-etag");
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

    const evidencePath = path.join(artifactsDir, "measurement.json");
    const evidenceData = {
      measuredAt: new Date().toISOString(),
      environment:
        "Real headless Chrome / Playwright. Part A: direct fetch() against the in-process worktree probe. Part B: real forge-control-web /desktop app (next dev) driven end-to-end, network captured via page.on('response').",
      verdict: failures === 0 ? "PASS" : "FAIL",
      failures,
      partA: {
        coldStatus: coldFetchResult.status,
        coldBytes: coldFetchResult.byteLength,
        coldETag: coldFetchResult.etag,
        strong304Status: strong304Result.status,
        strong304Bytes: strong304Result.byteLength,
        weak304Status: weak304Result.status,
        weak304Bytes: weak304Result.byteLength,
        mismatchStatus: mismatchResult.status,
        mismatchBytes: mismatchResult.byteLength,
      },
      partB: {
        landedUrl,
        initialFetch: initial,
        steadyPollsCount: steadyPolls.length,
        steadyPolls,
        steadyBytesTotal,
        observedRestRateBpm: observedRateBpm,
        screenshotPath,
        screenshotUrl: `/api/uploads/${runId}/${path.basename(screenshotPath)}`,
      },
    };

    fs.writeFileSync(evidencePath, JSON.stringify(evidenceData, null, 2) + "\n");
    console.log(`Evidence written to: ${evidencePath}`);

    await context.close();
  } finally {
    if (nextDev) await nextDev.stop();
    await browser.close();
    await probe.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — check-chat-list-etag-browser suite`);
  process.exit(failures === 0 ? 0 : 1);
}

runBrowserHarness().catch((err) => {
  console.error("Unhandled error in check-chat-list-etag-browser:", err);
  process.exit(1);
});
