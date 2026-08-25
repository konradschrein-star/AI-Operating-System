/**
 * check-chat-pagination-browser.ts — Real Chrome Browser Network Measurement Harness
 * for Chat Thread Pagination, Bounded Initial Window, and Steady-State Delta Polling.
 *
 * Project: aios-chat-thread-pagination (round 2)
 *
 * Two independent parts, because a server that is correct and a client that uses it
 * correctly are two different claims — see
 * /root/.claude/projects/-opt-forge-ai-os/memory/etag-304-needs-an-explicit-client.md
 * ("a correct server-side ETag saved nothing — fetch() never sent the header").
 *
 *  PART A — Server Contract, Real Chrome, Direct Requests
 *    A real headless Chromium page issues `fetch()` calls straight at the worktree's
 *    own chat router (mounted in-process, real production DB rows for 11dd264b and
 *    ece63bdb). This proves the SERVER behaves: bounded initial window, empty
 *    steady-state delta, backward pagination — but the request shape (`since`,
 *    `before`) is chosen by this script, not by the app. It cannot prove the desktop
 *    client actually asks for the small thing.
 *
 *  PART B — Real Desktop Client, Real Browser, Real Network
 *    A real headless Chromium page loads the ACTUAL forge-control-web `/desktop`
 *    app — same React code Konrad's browser runs, same `fetchChatDelta` /
 *    `fetchChatOlder` in app/api.ts, same TanStack Query poll loop — pointed at the
 *    worktree's chat router through a local `next dev` + the real `/api/proxy/*`
 *    route handler. `page.on("response")` observes exactly the bytes the app's own
 *    code requested and received; nothing in this part scripts a `since` or `before`
 *    value. `/api/chat/:id/events` (SSE) is deliberately 404'd by the probe so the
 *    client falls back to its documented 4s polling path deterministically, instead
 *    of waiting out a real 20s live-stream cadence for the same proof.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-pagination-browser.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import net from "node:net";
import { gzipSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getRun } from "../../forge-control/src/db/runs.ts";
import type { RunDetail } from "../../forge-control/src/db/runs.ts";
import chat from "../../forge-control/src/routes/chat.ts";
import agents from "../../forge-control/src/routes/agents.ts";
import projects from "../../forge-control/src/routes/projects.ts";
import capabilities from "../../forge-control/src/routes/capabilities.ts";
import secrets from "../../forge-control/src/routes/secrets.ts";
import uploads from "../../forge-control/src/routes/uploads.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const WEB_ROOT = path.join(REPO_ROOT, "forge-control-web");
const LIVE_WEB_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";

/* ── Env loading (forge-control's own secrets — DATABASE_URL etc) ───────── */

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

/** Read-only parse of the LIVE checkout's .env.local — never written to — for the
 *  three secrets a throwaway `next dev` needs to mint and accept its own session
 *  cookie (AUTH_SECRET) and to construct NextAuth's provider config without
 *  throwing (GITHUB_CLIENT_ID/SECRET; unused for validating an existing token, but
 *  NextAuth() builds the provider list at import time regardless). See
 *  authurl-https-forces-secure-cookie-over-plain-http.md — AUTH_URL is deliberately
 *  NOT read from here; it must point at the probe's own http origin instead. */
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
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  try {
    return req("/opt/hermes-workspace/node_modules/playwright").chromium;
  } catch {
    return req("playwright").chromium;
  }
}

/* ── Streaming In-Process Worktree API Probe ─────────────────────────────
 *
 * Unlike a buffered pass-through (fine for JSON, hangs forever on an SSE
 * body), this one pipes the upstream Response's own ReadableStream straight
 * to the node response with stream/promises' pipeline() — so a router that
 * DOES stream (chat.ts's other SSE route, /:id/events, is blocked below
 * rather than served, but nothing here would break if it weren't) never
 * wedges the harness.
 *
 * GET/HEAD only: this probe backs a live Playwright session driving the
 * real desktop app, and the app calls plenty of endpoints not under test
 * (today, team, search, ...). Rejecting every mutation up front makes the
 * whole probe read-only by construction, matching
 * forge-control-probe-single-router.md's "refuse every non-GET with 405
 * before routing" — never mind that the mounted routers' own write paths
 * are the same handlers production runs (serve-v3-7798.ts's reasoning);
 * this harness has no reason to ever call one. */

type FetchRouter = { fetch(request: Request): Response | Promise<Response> };

const MOUNTS: ReadonlyArray<{ prefix: string; router: FetchRouter }> = [
  { prefix: "/api/agents", router: agents },
  { prefix: "/api/chat", router: chat },
  { prefix: "/api/projects", router: projects },
  { prefix: "/api/capabilities", router: capabilities },
  { prefix: "/api/secrets", router: secrets },
  { prefix: "/api/uploads", router: uploads },
];

/** `/api/chat/:id/events` (SSE) is a 404 by design, not an oversight — see
 *  the file header. Forcing it to fail fast (rather than either hanging or
 *  quietly proxying to live production's OLD unbounded snapshot) makes the
 *  client's fallback to 4s polling immediate and deterministic. */
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
  const out: Record<string, string> = { "access-control-allow-origin": "*" };
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
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? "/";
      const method = req.method ?? "GET";
      const url = new URL(rawUrl, "http://127.0.0.1");

      // Part A drives fetch() from an unnavigated page (Origin: null) straight
      // at this probe — needs its own CORS grant. Part B never crosses origins
      // (the real /api/proxy route handler calls this probe server-side), so
      // this is purely for Part A's benefit.
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "*",
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
        res.end(JSON.stringify({ error: "SSE deliberately not served by this probe — see file header" }));
        return;
      }

      const mount = matchMount(url.pathname);
      try {
        if (mount) {
          const target = `http://127.0.0.1${stripMount(mount.prefix, url.pathname)}${url.search}`;
          const upstream = await mount.router.fetch(
            new Request(target, { method, headers: inboundHeaders(req) }),
          );
          await writeStreamed(res, upstream);
          return;
        }
        // Anything else the desktop shell needs on load (today, team, search,
        // spend, pipeline, memory, reminders, vault, ...) proxies GET-only to
        // real production, unmodified — this project never touched those.
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

/* ── Free port picker (for `next dev`) ───────────────────────────────────── */

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

/* ── Throwaway `next dev`, pointed at the probe ──────────────────────────── */

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
    // Deliberately NOT the live checkout's https AUTH_URL — NextAuth derives
    // useSecureCookies from its scheme, and this probe serves plain http.
    // See authurl-https-forces-secure-cookie-over-plain-http.md.
    AUTH_URL: `http://127.0.0.1:${port}`,
    AUTH_TRUST_HOST: "true",
    GITHUB_CLIENT_ID: githubClientId,
    GITHUB_CLIENT_SECRET: githubClientSecret,
    FORGE_CONTROL_URL: `http://127.0.0.1:${probePort}`,
  };

  const proc = spawn(path.join(WEB_ROOT, "node_modules/.bin/next"), ["dev", "-p", String(port)], {
    cwd: WEB_ROOT,
    env,
    detached: true, // own process group, so cleanup can kill Next's worker children too
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

/* ── Session cookie, minted the way frozen-dom.cjs and
 *    stale-session-cookie-fakes-a-perfect-score.md document ──────────────── */

async function mintSessionCookie(): Promise<string> {
  const secret = readLiveWebSecret("AUTH_SECRET");
  const pnpmDir = path.join(WEB_ROOT, "node_modules/.pnpm");
  const authCoreDir = fs.readdirSync(pnpmDir).find((d) => d.startsWith("@auth+core@"));
  if (!authCoreDir) throw new Error(`@auth+core not found under ${pnpmDir}`);
  const jwtModulePath = path.join(pnpmDir, authCoreDir, "node_modules/@auth/core/jwt.js");
  const { encode } = await import(`file://${jwtModulePath}`);
  return encode({
    token: { name: "Chat Pagination Verify Probe", email: "verify-probe@localhost", sub: "verify-probe" },
    secret,
    salt: "authjs.session-token", // NOT __Secure- prefixed: probe serves plain http
    maxAge: 3600,
  });
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

/* ── Part B: captured-traffic types ──────────────────────────────────────── */

interface CapturedResponse {
  url: string;
  since: number | null;
  before: number | null;
  status: number;
  decodedBytes: number;
  threadCount: number;
  hasPrompt: boolean;
  tSinceStart: number;
}

interface DesktopClientMeasurement {
  chatId: string;
  landedUrl: string;
  initial: CapturedResponse | null;
  steadyPolls: CapturedResponse[];
  olderPage: CapturedResponse | null;
  observedWindowMs: number;
}

/** Drives the REAL desktop app for one chat: opens it via the same localStorage
 *  keys ChatSurface itself reads (forge.desktop.surface / forge.chat.selected —
 *  stored-nav.ts), watches real network traffic for `STEADY_WINDOW_MS`, then
 *  clicks the app's own "show N older" button (AssistantThread.tsx) and captures
 *  that response too. Nothing here chooses a `since` or `before` value — the
 *  React app does, exactly as Konrad's browser would. */
async function measureDesktopClient(
  browser: { newContext: (opts?: unknown) => Promise<any> },
  baseUrl: string,
  cookie: string,
  chatId: string,
  steadyWindowMs: number,
): Promise<DesktopClientMeasurement> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: cookie,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();

  const captured: CapturedResponse[] = [];
  const t0 = Date.now();
  const chatPathname = `/api/proxy/chat/${chatId}`;

  page.on("response", (response: any) => {
    void (async () => {
      try {
        const u = new URL(response.url());
        if (u.pathname !== chatPathname) return;
        const body: Buffer = await response.body();
        const json = JSON.parse(body.toString("utf8"));
        captured.push({
          url: response.url(),
          since: u.searchParams.has("since") ? Number(u.searchParams.get("since")) : null,
          before: u.searchParams.has("before") ? Number(u.searchParams.get("before")) : null,
          status: response.status(),
          decodedBytes: body.byteLength,
          threadCount: Array.isArray(json.run?.thread) ? json.run.thread.length : -1,
          hasPrompt: !!json.run && "prompt" in json.run && json.run.prompt !== undefined,
          tSinceStart: Date.now() - t0,
        });
      } catch {
        // A response Playwright can no longer read (page navigated away, etc.) —
        // not a measurement failure, just an entry we drop.
      }
    })();
  });

  await page.addInitScript(
    ({ chatId }: { chatId: string }) => {
      localStorage.setItem("forge.desktop.surface", JSON.stringify("chat"));
      localStorage.setItem("forge.chat.selected", JSON.stringify(chatId));
    },
    { chatId },
  );

  await page.goto(`${baseUrl}/desktop`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1_500); // let the layout-effect restore + first fetch fire

  const landedUrl = page.url();
  if (landedUrl.includes("/signin")) {
    await context.close();
    return { chatId, landedUrl, initial: null, steadyPolls: [], olderPage: null, observedWindowMs: 0 };
  }

  // Wait for the initial bounded fetch to land.
  const initialDeadline = Date.now() + 20_000;
  while (captured.length === 0 && Date.now() < initialDeadline) {
    await page.waitForTimeout(250);
  }
  const initial = captured[0] ?? null;
  const afterInitialMark = captured.length;

  // Observe real, unscripted steady-state polling for the requested window.
  await page.waitForTimeout(steadyWindowMs);
  const steadyPolls = captured.slice(afterInitialMark).filter((c) => c.since !== null);

  // Trigger the app's OWN backward-pagination control.
  let olderPage: CapturedResponse | null = null;
  const beforeClickMark = captured.length;
  try {
    const olderButton = page.getByRole("button", { name: /^show \d+ older$/ });
    await olderButton.first().click({ timeout: 10_000 });
    const clickDeadline = Date.now() + 15_000;
    while (
      captured.slice(beforeClickMark).every((c) => c.before === null) &&
      Date.now() < clickDeadline
    ) {
      await page.waitForTimeout(250);
    }
    olderPage = captured.slice(beforeClickMark).find((c) => c.before !== null) ?? null;
  } catch (err) {
    console.log(
      `  (no "show older" control clicked for ${chatId}: ${err instanceof Error ? err.message : err})`,
    );
  }

  await context.close();
  return { chatId, landedUrl, initial, steadyPolls, olderPage, observedWindowMs: steadyWindowMs };
}

/* ── Main Execution ──────────────────────────────────────────────────────── */

export interface MeasurementRecord {
  chatId: string;
  title: string;
  totalMessages: number;
  before: {
    fullFetchDecodedBytes: number;
    fullFetchGzipBytes: number;
    restRateFallbackDecodedBpm: number;
  };
  partA: {
    initialBoundedDecodedBytes: number;
    initialBoundedGzipBytes: number;
    initialThreadCount: number;
    initialFrom: number;
    steadyStateDecodedBytes: number;
    steadyStateGzipBytes: number;
    steadyStateThreadCount: number;
    steadyStatePromptOmitted: boolean;
    backwardPageDecodedBytes: number;
    backwardPageGzipBytes: number;
    backwardPageThreadCount: number;
    backwardPageFrom: number;
  };
  partB: {
    landedUrl: string;
    initialDecodedBytes: number | null;
    initialThreadCount: number | null;
    steadyPollCount: number;
    steadyPollDecodedBytesEach: number[];
    steadyPollAllPromptOmitted: boolean;
    steadyPollAllThreadEmpty: boolean;
    observedRestRateDecodedBpm: number | null;
    olderPageDecodedBytes: number | null;
    olderPageThreadCount: number | null;
    olderPagePromptOmitted: boolean | null;
  };
}

async function runBrowserChecks(): Promise<void> {
  console.log("================================================================================");
  console.log(" REAL CHROME BROWSER MEASUREMENT HARNESS — aios-chat-thread-pagination (round 2)");
  console.log("================================================================================");

  const CHAT_IDS = ["11dd264b-f173-44d7-ada4-f1eb39fb4abd", "ece63bdb-884c-4d2c-9680-deca13cf2dda"];

  const probe = await startProbeServer();
  console.log(`Streaming worktree API probe live on 127.0.0.1:${probe.port}`);

  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });

  const measurements: Record<string, MeasurementRecord> = {};
  let nextDev: NextDevHandle | null = null;

  try {
    // ── PART A ──────────────────────────────────────────────────────────────
    console.log("\n================================================================================");
    console.log(" PART A — Server Contract (real Chrome, scripted requests, real DB rows)");
    console.log("================================================================================");

    const context = await browser.newContext();
    const page = await context.newPage();

    for (const chatId of CHAT_IDS) {
      console.log(`\n── Chat ${chatId} ──`);
      const run = await getRun(chatId);
      if (!run) throw new Error(`Run ${chatId} not found in database`);
      const total = run.thread.length;
      console.log(`Database run: totalTurns=${total}, title="${run.title.slice(0, 50)}..."`);

      const legacyFullJson = JSON.stringify({ run, from: 0, total });
      const legacyFullDecoded = Buffer.byteLength(legacyFullJson, "utf8");
      const legacyFullGzip = gzipSync(Buffer.from(legacyFullJson)).byteLength;

      const apiOrigin = `http://127.0.0.1:${probe.port}`;

      const initialResp = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        const text = await res.text();
        const json = JSON.parse(text);
        return {
          status: res.status,
          text,
          bytes: new Blob([text]).size,
          from: json.from,
          total: json.total,
          threadCount: json.run?.thread?.length ?? 0,
          hasPrompt: "prompt" in json.run && json.run.prompt !== undefined,
        };
      }, `${apiOrigin}/api/chat/${chatId}`);
      const initialGzip = gzipSync(Buffer.from(initialResp.text)).byteLength;

      check(`${chatId} Part A initial: HTTP 200`, initialResp.status, 200);
      check(`${chatId} Part A initial: from === total - 60 (clamped at 0)`, initialResp.from, Math.max(0, total - 60));
      check(`${chatId} Part A initial: total === ${total}`, initialResp.total, total);
      checkTrue(`${chatId} Part A initial: thread count <= 60`, initialResp.threadCount <= 60);
      checkTrue(`${chatId} Part A initial: prompt is present`, initialResp.hasPrompt);
      checkTrue(`${chatId} Part A initial: decoded payload < 90 KB (legacy ${(legacyFullDecoded / 1024).toFixed(0)} KB)`, initialResp.bytes < 90_000);

      const steadyResp = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        const text = await res.text();
        const json = JSON.parse(text);
        return {
          status: res.status,
          text,
          bytes: new Blob([text]).size,
          from: json.from,
          total: json.total,
          threadCount: json.run?.thread?.length ?? 0,
          hasPrompt: "prompt" in json.run && json.run.prompt !== undefined,
        };
      }, `${apiOrigin}/api/chat/${chatId}?since=${total}`);
      const steadyGzip = gzipSync(Buffer.from(steadyResp.text)).byteLength;

      check(`${chatId} Part A steady delta: HTTP 200`, steadyResp.status, 200);
      check(`${chatId} Part A steady delta: from === total`, steadyResp.from, total);
      check(`${chatId} Part A steady delta: thread count === 0`, steadyResp.threadCount, 0);
      checkTrue(`${chatId} Part A steady delta: prompt omitted`, !steadyResp.hasPrompt);
      checkTrue(`${chatId} Part A steady delta: decoded payload < 2 KB`, steadyResp.bytes < 2048);

      const from = Math.max(0, total - 60);
      const olderResp = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        const text = await res.text();
        const json = JSON.parse(text);
        return {
          status: res.status,
          text,
          bytes: new Blob([text]).size,
          from: json.from,
          total: json.total,
          threadCount: json.run?.thread?.length ?? 0,
          hasPrompt: "prompt" in json.run && json.run.prompt !== undefined,
        };
      }, `${apiOrigin}/api/chat/${chatId}?before=${from}&limit=60`);
      const olderGzip = gzipSync(Buffer.from(olderResp.text)).byteLength;

      check(`${chatId} Part A older page: HTTP 200`, olderResp.status, 200);
      checkTrue(`${chatId} Part A older page: thread count > 0`, olderResp.threadCount > 0);
      checkTrue(`${chatId} Part A older page: prompt omitted`, !olderResp.hasPrompt);

      const fallbackPollsPerMin = 15; // 4s fallback interval
      measurements[chatId] = {
        chatId,
        title: run.title,
        totalMessages: total,
        before: {
          fullFetchDecodedBytes: legacyFullDecoded,
          fullFetchGzipBytes: legacyFullGzip,
          restRateFallbackDecodedBpm: legacyFullDecoded * fallbackPollsPerMin,
        },
        partA: {
          initialBoundedDecodedBytes: initialResp.bytes,
          initialBoundedGzipBytes: initialGzip,
          initialThreadCount: initialResp.threadCount,
          initialFrom: initialResp.from,
          steadyStateDecodedBytes: steadyResp.bytes,
          steadyStateGzipBytes: steadyGzip,
          steadyStateThreadCount: steadyResp.threadCount,
          steadyStatePromptOmitted: !steadyResp.hasPrompt,
          backwardPageDecodedBytes: olderResp.bytes,
          backwardPageGzipBytes: olderGzip,
          backwardPageThreadCount: olderResp.threadCount,
          backwardPageFrom: olderResp.from,
        },
        // filled in below, Part B
        partB: {
          landedUrl: "",
          initialDecodedBytes: null,
          initialThreadCount: null,
          steadyPollCount: 0,
          steadyPollDecodedBytesEach: [],
          steadyPollAllPromptOmitted: false,
          steadyPollAllThreadEmpty: false,
          observedRestRateDecodedBpm: null,
          olderPageDecodedBytes: null,
          olderPageThreadCount: null,
          olderPagePromptOmitted: null,
        },
      };
    }
    await context.close();

    // ── PART B ──────────────────────────────────────────────────────────────
    console.log("\n================================================================================");
    console.log(" PART B — Real Desktop Client, Real Browser, Real Network");
    console.log("================================================================================");
    console.log("Starting throwaway `next dev`, pointed at the streaming worktree probe...");
    nextDev = await startNextDev(probe.port);
    console.log(`next dev live on 127.0.0.1:${nextDev.port}`);
    const cookie = await mintSessionCookie();
    const baseUrl = `http://127.0.0.1:${nextDev.port}`;
    const STEADY_WINDOW_MS = 26_000; // >= 6 polls at the 4s fallback cadence

    for (const chatId of CHAT_IDS) {
      console.log(`\n── Chat ${chatId}: driving the real /desktop app ──`);
      const m = await measureDesktopClient(browser, baseUrl, cookie, chatId, STEADY_WINDOW_MS);

      checkTrue(`${chatId} Part B: landed on /desktop, not /signin`, m.landedUrl.includes("/desktop"), `landed at ${m.landedUrl}`);
      checkTrue(`${chatId} Part B: real client issued an initial GET /api/proxy/chat/${chatId}`, m.initial !== null);

      if (m.initial) {
        check(`${chatId} Part B initial: HTTP 200`, m.initial.status, 200);
        checkTrue(`${chatId} Part B initial: thread count <= 60`, m.initial.threadCount <= 60 && m.initial.threadCount > 0);
        checkTrue(`${chatId} Part B initial: decoded payload < 90 KB`, m.initial.decodedBytes < 90_000);
      }

      checkTrue(
        `${chatId} Part B: real client polled at least once in ${STEADY_WINDOW_MS / 1000}s (since= present)`,
        m.steadyPolls.length > 0,
      );
      checkTrue(
        `${chatId} Part B: every observed steady poll carries thread: []`,
        m.steadyPolls.every((p) => p.threadCount === 0),
        `counts: ${JSON.stringify(m.steadyPolls.map((p) => p.threadCount))}`,
      );
      checkTrue(
        `${chatId} Part B: every observed steady poll omits prompt`,
        m.steadyPolls.every((p) => !p.hasPrompt),
      );
      checkTrue(
        `${chatId} Part B: every observed steady poll < 2 KB decoded`,
        m.steadyPolls.every((p) => p.decodedBytes < 2048),
        `sizes: ${JSON.stringify(m.steadyPolls.map((p) => p.decodedBytes))}`,
      );

      checkTrue(`${chatId} Part B: real client's own "show older" fetched a backward page`, m.olderPage !== null);
      if (m.olderPage) {
        check(`${chatId} Part B older page: HTTP 200`, m.olderPage.status, 200);
        checkTrue(`${chatId} Part B older page: thread count > 0`, m.olderPage.threadCount > 0);
        checkTrue(`${chatId} Part B older page: prompt omitted`, !m.olderPage.hasPrompt);
      }

      const steadyBytesTotal = m.steadyPolls.reduce((s, p) => s + p.decodedBytes, 0);
      const observedRateBpm =
        m.steadyPolls.length > 0 ? (steadyBytesTotal / (STEADY_WINDOW_MS / 1000)) * 60 : null;

      const rec = measurements[chatId];
      rec.partB = {
        landedUrl: m.landedUrl,
        initialDecodedBytes: m.initial?.decodedBytes ?? null,
        initialThreadCount: m.initial?.threadCount ?? null,
        steadyPollCount: m.steadyPolls.length,
        steadyPollDecodedBytesEach: m.steadyPolls.map((p) => p.decodedBytes),
        steadyPollAllPromptOmitted: m.steadyPolls.length > 0 && m.steadyPolls.every((p) => !p.hasPrompt),
        steadyPollAllThreadEmpty: m.steadyPolls.length > 0 && m.steadyPolls.every((p) => p.threadCount === 0),
        observedRestRateDecodedBpm: observedRateBpm,
        olderPageDecodedBytes: m.olderPage?.decodedBytes ?? null,
        olderPageThreadCount: m.olderPage?.threadCount ?? null,
        olderPagePromptOmitted: m.olderPage ? !m.olderPage.hasPrompt : null,
      };

      console.log(
        `  landed=${m.landedUrl.includes("/desktop") ? "OK" : "SIGNIN"}  ` +
          `initial=${m.initial?.decodedBytes ?? "n/a"}B (${m.initial?.threadCount ?? "n/a"} turns)  ` +
          `polls=${m.steadyPolls.length} sizes=${JSON.stringify(m.steadyPolls.map((p) => p.decodedBytes))}  ` +
          `older=${m.olderPage?.decodedBytes ?? "n/a"}B (${m.olderPage?.threadCount ?? "n/a"} turns)`,
      );
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log("\n================================================================================");
    console.log(" SUMMARY — BEFORE (legacy full fetch) vs AFTER (real client, real network)");
    console.log("================================================================================");
    for (const chatId of CHAT_IDS) {
      const r = measurements[chatId];
      console.log(`\nChat ${chatId} (${r.totalMessages} entries):`);
      console.log(`  BEFORE  full fetch (legacy):      ${r.before.fullFetchDecodedBytes.toLocaleString()} B`);
      console.log(`  BEFORE  4s-fallback rest rate:     ${(r.before.restRateFallbackDecodedBpm / (1024 * 1024)).toFixed(2)} MB/min`);
      console.log(`  AFTER   Part A initial (scripted): ${r.partA.initialBoundedDecodedBytes.toLocaleString()} B, gzip ${r.partA.initialBoundedGzipBytes.toLocaleString()} B`);
      console.log(`  AFTER   Part A steady (scripted):  ${r.partA.steadyStateDecodedBytes.toLocaleString()} B`);
      console.log(`  AFTER   Part B initial (real app): ${r.partB.initialDecodedBytes ?? "n/a"} B, ${r.partB.initialThreadCount ?? "n/a"} turns`);
      console.log(
        `  AFTER   Part B steady (real app):  ${r.partB.steadyPollCount} polls observed in ${STEADY_WINDOW_MS / 1000}s, ` +
          `sizes ${JSON.stringify(r.partB.steadyPollDecodedBytesEach)} B, ` +
          `observed rest rate ${r.partB.observedRestRateDecodedBpm !== null ? (r.partB.observedRestRateDecodedBpm / 1024).toFixed(2) : "n/a"} KB/min`,
      );
      console.log(`  AFTER   Part B older page (real app): ${r.partB.olderPageDecodedBytes ?? "n/a"} B, ${r.partB.olderPageThreadCount ?? "n/a"} turns`);
    }

    const outDir = path.join(REPO_ROOT, "docs/plan/artifacts/chat-thread-pagination");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const evidencePath = path.join(outDir, "chat-pagination-browser.json");
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          environment:
            "Real headless Chrome / Playwright. Part A: scripted fetch() against the worktree's own chat router (in-process). Part B: real forge-control-web /desktop app (next dev) driven end to end, pointed at the same worktree router through the real /api/proxy route handler — network captured via page.on('response'), not scripted.",
          verdict: failures === 0 ? "PASS" : "FAIL",
          failures,
          steadyWindowMs: STEADY_WINDOW_MS,
          chats: measurements,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`\nEvidence written to: ${evidencePath}`);
  } finally {
    if (nextDev) await nextDev.stop();
    await browser.close();
    await probe.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — check-chat-pagination-browser suite`);
  process.exit(failures === 0 ? 0 : 1);
}

runBrowserChecks().catch((err) => {
  console.error("Unhandled error in check-chat-pagination-browser:", err);
  process.exit(1);
});
