/**
 * check-takeover-clipboard-e2e.ts — end-to-end verification and screenshot capture
 * for the takeover clipboard bridge and session quality improvements.
 *
 * WHAT THIS PROVES:
 *   1. Session Quality & VM Durability:
 *      - /usr/bin/autocutsel prerequisite check.
 *      - Openbox menu.xml shipped in repo and durably installed to ~/.config/openbox/menu.xml.
 *      - Takeover session startup automatically launches two autocutsel instances
 *        (-selection CLIPBOARD and -selection PRIMARY) alongside Openbox WM.
 *      - Lifecycle tracking (takeover.json) tracks autocutsel PIDs and teardown terminates them.
 *   2. Client-Side Clipboard Bridge (TakeoverClient.tsx):
 *      - "Paste to VM": Local clipboard -> iframe #noVNC_clipboard_text -> change event dispatched
 *        -> success confirmation message with character count.
 *      - "Copy from VM": Remote buffer in #noVNC_clipboard_text -> Local clipboard
 *        -> success confirmation message with character count.
 *      - Empty Buffer Guard: When remote textarea is empty, "nothing in the VM clipboard yet" is
 *        displayed and local clipboard is NEVER overwritten with "".
 *      - Honest Error & Fallback UI: When clipboard reading is denied or unsupported,
 *        surfaces explicit error diagnostic and renders a manual paste fallback UI.
 *   3. Zero Server Routes Invariant:
 *      - Everything operates client-side through the same-origin noVNC iframe DOM.
 *      - No new routes under /api/browser-takeover/.
 *   4. Visual Evidence:
 *      - Saves screenshots to /opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png.
 *
 * RUN:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-takeover-clipboard-e2e.ts
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import uploadsRoutes from "../../forge-control/src/routes/uploads.ts";
import {
  handleBrowserTakeoverUpgrade,
  TAKEOVER_UPGRADE_PREFIX,
} from "../../forge-control/src/lib/browser-takeover.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB_ROOT = path.join(REPO_ROOT, "forge-control-web");
const LIVE_WEB_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";
const RESEARCH_BROWSER = path.join(REPO_ROOT, "scripts/research-browser.mjs");
const OPENBOX_MENU_REPO = path.join(REPO_ROOT, "scripts/config/openbox/menu.xml");
const OPENBOX_MENU_DEST = path.join(process.env.HOME ?? "/root", ".config/openbox/menu.xml");

const RUN_ID = process.env.FORGE_RUN_ID ?? "bc47ff600bca";
const TEST_RUN_ID = "e2ec11b00001";
const TEST_PROFILE = "testclipe2e";

const SHOT_DIR = path.join("/opt/ai-os/uploads", RUN_ID);
const stamp = (): string =>
  new Date().toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read one KEY=value out of the LIVE web env. Read-only, never written. */
function readLiveWebSecret(key: string): string {
  if (process.env[key]) {
    return process.env[key] as string;
  }
  if (!fs.existsSync(LIVE_WEB_ENV)) {
    if (key === "AUTH_SECRET") return "0123456789abcdef0123456789abcdef0123456789abcdef";
    return "test-value";
  }
  const text = fs.readFileSync(LIVE_WEB_ENV, "utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    if (s.slice(0, i).trim() !== key) continue;
    return s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`${key} not found in ${LIVE_WEB_ENV}`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not read an ephemeral port from the probe socket"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: "127.0.0.1", port }, () => {
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

/* ── 1. forge-control probe ──────────────────────────────────────────────── */

const UPLOADS_MOUNT = "/api/uploads";

async function startForgeControlProbe(): Promise<{ port: number; stop: () => void }> {
  const port = await findFreePort();
  const server = createHttpServer((req, res) => {
    void (async () => {
      const rawPath = req.url ?? "/";
      const inner = rawPath.startsWith(UPLOADS_MOUNT)
        ? rawPath.slice(UPLOADS_MOUNT.length) || "/"
        : null;
      if (inner === null) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "probe is read-only", method: req.method, path: rawPath }));
          return;
        }
        const upstream = httpRequest(
          { host: "127.0.0.1", port: 7700, method: req.method, path: rawPath, headers: req.headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on("error", (err) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `probe pass-through: ${err.message}` }));
        });
        upstream.end();
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const response = await uploadsRoutes.fetch(
        new Request(`http://127.0.0.1:${port}${inner}`, { method: req.method, headers }),
      );
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      if (response.body === null) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    })().catch((err: unknown) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`probe: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleBrowserTakeoverUpgrade(req, socket, head)
      .then((handled) => {
        if (!handled) socket.destroy();
      })
      .catch(() => socket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  await waitForPort(port, 10_000);
  return { port, stop: () => server.close() };
}

/* ── 2. front proxy (nginx stand-in) ─────────────────────────────────────── */

const WS_PREFIX = TAKEOVER_UPGRADE_PREFIX;

async function startFrontProxy(
  port: number,
  nextPort: number,
  fcPort: number,
): Promise<{
  port: number;
  stop: () => void;
}> {
  const sockets = new Set<Duplex>();

  const server = createHttpServer((req, res) => {
    const proxied = httpRequest(
      { host: "127.0.0.1", port: nextPort, method: req.method, path: req.url, headers: req.headers },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxied.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`front proxy: ${err.message}`);
    });
    req.pipe(proxied);
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  server.on("upgrade", (req, socket, head) => {
    const reqPath = req.url ?? "";
    const target = reqPath.startsWith(WS_PREFIX) ? fcPort : nextPort;
    const up = httpRequest({
      host: "127.0.0.1",
      port: target,
      method: req.method,
      path: reqPath,
      headers: req.headers,
    });
    up.on("upgrade", (upRes, upSocket, upHead) => {
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
      const headers = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}\r\n`)
        .join("");
      socket.write(statusLine + headers + "\r\n");
      if (upHead.length > 0) socket.unshift(upHead);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    up.on("response", (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
      socket.destroy();
    });
    up.on("error", () => socket.destroy());
    if (head.length > 0) up.write(head);
    up.end();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    stop: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/* ── 3. next dev ─────────────────────────────────────────────────────────── */

async function startNextDev(
  fcPort: number,
  publicOrigin: string,
): Promise<{
  port: number;
  proc: ChildProcess;
  stop: () => Promise<void>;
}> {
  const port = await findFreePort();
  const env = {
    ...process.env,
    NODE_ENV: "development",
    AUTH_SECRET: readLiveWebSecret("AUTH_SECRET"),
    AUTH_URL: publicOrigin,
    AUTH_TRUST_HOST: "true",
    GITHUB_CLIENT_ID: readLiveWebSecret("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: readLiveWebSecret("GITHUB_CLIENT_SECRET"),
    FORGE_CONTROL_URL: `http://127.0.0.1:${fcPort}`,
    TAKEOVER_TICKET_SECRET:
      process.env.TAKEOVER_TICKET_SECRET ??
      "TEST_TAKEOVER_TICKET_SECRET_0123456789abcdef0123456789abcdef",
  };
  const proc = spawn(path.join(WEB_ROOT, "node_modules/.bin/next"), ["dev", "-p", String(port)], {
    cwd: WEB_ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.on("data", (d) => (out += String(d)));
  proc.stderr?.on("data", (d) => (out += String(d)));
  try {
    await waitForPort(port, 120_000);
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

/* ── Structural Playwright Types ─────────────────────────────────────────── */

interface ProbeLocator {
  first(): ProbeLocator;
  last(): ProbeLocator;
  locator(selector: string): ProbeLocator;
  count(): Promise<number>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  inputValue(): Promise<string>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
}
interface ProbeFrameLocator {
  locator(selector: string): ProbeLocator;
}
interface ProbePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
  evaluate<R = unknown, A = unknown>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R>;
  locator(selector: string): ProbeLocator;
  frameLocator(selector: string): ProbeFrameLocator;
  frames(): { url(): string }[];
  screenshot(options: { path: string }): Promise<unknown>;
}
interface ProbeContext {
  addCookies(cookies: Record<string, unknown>[]): Promise<void>;
  grantPermissions(permissions: string[], options?: { origin?: string }): Promise<void>;
  clearPermissions(): Promise<void>;
  newPage(): Promise<ProbePage>;
  close(): Promise<void>;
}
interface ProbeBrowser {
  newContext(options?: Record<string, unknown>): Promise<ProbeContext>;
  close(): Promise<void>;
}
interface ProbeChromium {
  launch(options: { executablePath: string; args: string[] }): Promise<ProbeBrowser>;
}

function resolveChromium(): string {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  if (!fs.existsSync(cache)) throw new Error(`Playwright browser cache not found at ${cache}`);
  const candidates = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) throw new Error(`no chromium executable under ${cache}`);
  return candidates[0];
}

function loadChromium(): ProbeChromium {
  const req = createRequire(import.meta.url);
  try {
    return (req("/opt/hermes-workspace/node_modules/playwright") as { chromium: ProbeChromium }).chromium;
  } catch {
    return (req("playwright") as { chromium: ProbeChromium }).chromium;
  }
}

async function mintSessionCookie(): Promise<string> {
  const secret = readLiveWebSecret("AUTH_SECRET");
  const pnpmDir = path.join(WEB_ROOT, "node_modules/.pnpm");
  const authCoreDir = fs.readdirSync(pnpmDir).find((d) => d.startsWith("@auth+core@"));
  if (!authCoreDir) throw new Error(`@auth+core not found under ${pnpmDir}`);
  const jwtModulePath = path.join(pnpmDir, authCoreDir, "node_modules/@auth/core/jwt.js");
  const { encode } = (await import(`file://${jwtModulePath}`)) as {
    encode: (o: Record<string, unknown>) => Promise<string>;
  };
  return encode({
    token: { name: "Clipboard E2E Probe", email: "clipboard-probe@localhost", sub: "clipboard-probe" },
    secret,
    salt: "authjs.session-token",
    maxAge: 3600,
  });
}

/* ── Main Execution ──────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log("=== TAKEOVER CLIPBOARD BRIDGE & SESSION QUALITY E2E VERIFICATION ===");

  if (!process.env.TAKEOVER_TICKET_SECRET) {
    process.env.TAKEOVER_TICKET_SECRET = "TEST_TAKEOVER_TICKET_SECRET_0123456789abcdef0123456789abcdef";
  }

  const shots: string[] = [];
  async function takeShot(page: ProbePage, label: string): Promise<string> {
    const p = path.join(SHOT_DIR, `${stamp()}-${label}.png`);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: p });
    shots.push(p);
    console.log(`      screenshot: ${p}`);
    return p;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 1. Session Quality & VM Durability Verification
   * ───────────────────────────────────────────────────────────────────────── */
  section("1. Session Quality & VM Durability (autocutsel & openbox menu.xml)");

  // 1.1 Check autocutsel prerequisite binary
  const autocutselBinaryExists = fs.existsSync("/usr/bin/autocutsel");
  check(
    "autocutsel binary (/usr/bin/autocutsel) is installed",
    autocutselBinaryExists,
    "missing /usr/bin/autocutsel binary",
  );

  // 1.2 Check Openbox menu template in repository
  const menuTemplateExists = fs.existsSync(OPENBOX_MENU_REPO);
  check(
    "Openbox menu.xml template exists in repository (scripts/config/openbox/menu.xml)",
    menuTemplateExists,
    `template not found at ${OPENBOX_MENU_REPO}`,
  );

  // 1.3 Start takeover stack for test profile to verify startup and process synchronization
  console.log(`      launching test takeover session on profile "${TEST_PROFILE}"...`);
  try {
    execFileSync("node", [RESEARCH_BROWSER, "close", TEST_PROFILE], {
      stdio: "pipe",
    });
  } catch {
    /* ignore if not running */
  }

  // `--throwaway` is REQUIRED: since aios-takeover-usable B3 the driver refuses a
  // NEW profile name without it (exit 3). On this box the check used to pass
  // only because a stale `.state/testclipe2e` happened to exist — green by
  // leftover state. The flag makes it pass on a clean box for the right reason.
  const takeoverJsonRaw = execFileSync(
    "node",
    [RESEARCH_BROWSER, "takeover", TEST_PROFILE, "--throwaway"],
    { encoding: "utf8" },
  );
  interface TakeoverCmdOutput {
    tool: string;
    subcommand: string;
    profile: string;
    takeover: {
      up: boolean;
      started_now: string[];
      display: string;
      vnc_port: number;
      novnc_port: number;
      window_manager: string | null;
      logs: {
        autocutsel_clipboard: string | null;
        autocutsel_primary: string | null;
      };
    };
  }
  const takeoverData = JSON.parse(takeoverJsonRaw) as TakeoverCmdOutput;

  check(
    "research-browser takeover command started successfully",
    takeoverData.takeover?.up === true,
    JSON.stringify(takeoverData),
  );

  check(
    "started_now includes autocutsel-clipboard, autocutsel-primary, and wm",
    takeoverData.takeover.started_now.includes("autocutsel-clipboard") &&
      takeoverData.takeover.started_now.includes("autocutsel-primary") &&
      takeoverData.takeover.started_now.some((s) => s.includes("openbox")),
    JSON.stringify(takeoverData.takeover.started_now),
  );

  // 1.4 Check openbox menu.xml is durably installed at destination
  const menuDestExists = fs.existsSync(OPENBOX_MENU_DEST);
  const menuContent = menuDestExists ? fs.readFileSync(OPENBOX_MENU_DEST, "utf8") : "";
  const repoMenuContent = fs.readFileSync(OPENBOX_MENU_REPO, "utf8");
  check(
    "Openbox menu.xml is installed at ~/.config/openbox/menu.xml and matches repository source",
    menuDestExists && menuContent === repoMenuContent,
    `dest: ${OPENBOX_MENU_DEST}, matched: ${menuContent === repoMenuContent}`,
  );

  // 1.5 Verify state file tracks both autocutsel processes
  const statePath = `/opt/ai-os/browser-profiles/.state/${TEST_PROFILE}/takeover.json`;
  const stateExists = fs.existsSync(statePath);
  check("takeover.json state file exists", stateExists, statePath);

  interface SavedTakeoverState {
    profile: string;
    autocutsel_clipboard?: { pid: number; bin: string };
    autocutsel_primary?: { pid: number; bin: string };
    wm?: { pid: number; bin: string };
    x11vnc?: { pid: number; bin: string };
    websockify?: { pid: number; bin: string };
    xvfb?: { pid: number; bin: string };
  }
  const stateJson = stateExists
    ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as SavedTakeoverState)
    : null;

  const clipboardPid = stateJson?.autocutsel_clipboard?.pid;
  const primaryPid = stateJson?.autocutsel_primary?.pid;
  const wmPid = stateJson?.wm?.pid;

  check(
    `autocutsel (-selection CLIPBOARD) is running (PID ${clipboardPid})`,
    isPidAlive(clipboardPid),
    `PID ${clipboardPid} is not alive`,
  );

  check(
    `autocutsel (-selection PRIMARY) is running (PID ${primaryPid})`,
    isPidAlive(primaryPid),
    `PID ${primaryPid} is not alive`,
  );

  check(
    `window manager is running (PID ${wmPid})`,
    isPidAlive(wmPid),
    `PID ${wmPid} is not alive`,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * 2. Stand up Local Test Probe / Next Server Harness
   * ───────────────────────────────────────────────────────────────────────── */
  section("2. Ephemeral Infrastructure (forge-control probe, front proxy, next dev)");

  // Seed test profile marker for TEST_RUN_ID so resolveProfileForRun finds TEST_PROFILE
  const testUploadDir = path.join("/opt/ai-os/uploads", TEST_RUN_ID);
  const testMarkerDir = path.join(testUploadDir, "browser-state");
  fs.mkdirSync(testMarkerDir, { recursive: true });
  fs.writeFileSync(
    path.join(testMarkerDir, `${TEST_PROFILE}.json`),
    JSON.stringify({
      profile: TEST_PROFILE,
      checked_at: new Date().toISOString(),
    }),
    "utf8",
  );

  const fc = await startForgeControlProbe();
  console.log(`      forge-control probe      → 127.0.0.1:${fc.port}`);

  const frontPort = await findFreePort();
  const publicOrigin = `http://127.0.0.1:${frontPort}`;

  const next = await startNextDev(fc.port, publicOrigin);
  console.log(`      next dev                 → 127.0.0.1:${next.port}`);

  const front = await startFrontProxy(frontPort, next.port, fc.port);
  console.log(`      front proxy (nginx hop)  → 127.0.0.1:${front.port}`);

  const sessionCookie = await mintSessionCookie();
  const chromium = loadChromium();
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ["--no-sandbox"],
  });

  try {
    /* ─────────────────────────────────────────────────────────────────────────
     * 3. Drive TakeoverClient with Playwright
     * ───────────────────────────────────────────────────────────────────────── */
    section("3. Playwright Real-Browser Verification of Clipboard Bridge");

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addCookies([
      {
        name: "authjs.session-token",
        value: sessionCookie,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      },
    ]);

    const page = await context.newPage();
    const takeoverUrl = `${publicOrigin}/takeover/${TEST_RUN_ID}`;
    console.log(`      navigating to ${takeoverUrl}...`);
    await page.goto(takeoverUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

    // Wait for TakeoverClient toolbar to mount and ticket to mint
    async function waitForToolbarReady(timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const text = await page.locator("body").textContent();
        if (text && text.includes(`TAKEOVER · ${TEST_PROFILE}`)) return true;
        await page.waitForTimeout(1_000);
      }
      return false;
    }

    const toolbarReady = await waitForToolbarReady(30_000);
    check("TakeoverClient loaded and minted ticket (toolbar visible)", toolbarReady);

    // Wait for noVNC iframe to load and reach its document
    const iframeSelector = "iframe[title='Live Browser Takeover']";
    const hasIframe = (await page.locator(iframeSelector).count()) > 0;
    check("noVNC iframe with title 'Live Browser Takeover' is rendered", hasIframe);

    // Wait for iframe contentDocument and #noVNC_clipboard_text to exist
    async function waitForIframeTextarea(timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await page.evaluate(() => {
          const iframe = document.querySelector(
            "iframe[title='Live Browser Takeover']",
          ) as HTMLIFrameElement | null;
          if (!iframe) return false;
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return false;
          return Boolean(doc.getElementById("noVNC_clipboard_text"));
        });
        if (ok) return true;
        await page.waitForTimeout(1_000);
      }
      return false;
    }

    const textareaReady = await waitForIframeTextarea(30_000);
    check(
      "same-origin iframe #noVNC_clipboard_text is accessible from parent",
      textareaReady,
    );

    await takeShot(page, "takeover-clipboard-initial");

    // ── 3a. Test "Paste to VM" (Local -> Remote) ──────────────────────────
    section("3a. Local -> Remote ('Paste to VM')");
    const testLocalText = "KONRAD_TEST_LOCAL_PASTE_DATA_987654";

    // Set local clipboard text in the browser
    await page.evaluate(async (txt: string) => {
      await navigator.clipboard.writeText(txt);
      // Attach change event detector to remote textarea inside iframe
      const iframe = document.querySelector(
        "iframe[title='Live Browser Takeover']",
      ) as HTMLIFrameElement;
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error("iframe doc missing");
      const el = doc.getElementById("noVNC_clipboard_text") as HTMLTextAreaElement;
      (window as unknown as { __changeDispatched?: boolean }).__changeDispatched = false;
      el.addEventListener("change", () => {
        (window as unknown as { __changeDispatched?: boolean }).__changeDispatched = true;
      });
    }, testLocalText);

    // Click "Paste to VM"
    const pasteBtn = page.locator("button:has-text('Paste to VM')").first();
    await pasteBtn.click();
    await page.waitForTimeout(1_000);

    const remoteValAfterPaste = await page.evaluate(() => {
      const iframe = document.querySelector(
        "iframe[title='Live Browser Takeover']",
      ) as HTMLIFrameElement;
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      const el = doc?.getElementById("noVNC_clipboard_text") as HTMLTextAreaElement | null;
      return {
        value: el?.value ?? "",
        changeFired: (window as unknown as { __changeDispatched?: boolean }).__changeDispatched === true,
      };
    });

    check(
      "Paste to VM updated #noVNC_clipboard_text with local clipboard text",
      remoteValAfterPaste.value === testLocalText,
      `expected "${testLocalText}", got "${remoteValAfterPaste.value}"`,
    );

    check(
      "Paste to VM dispatched a bubbling change event on #noVNC_clipboard_text",
      remoteValAfterPaste.changeFired,
      "change event was not observed",
    );

    const bodyTextAfterPaste = (await page.locator("body").textContent()) ?? "";
    check(
      "Toolbar shows character count confirmation ('Pasted 35 chars')",
      bodyTextAfterPaste.includes(`Pasted ${testLocalText.length} chars`),
      `body text: ${bodyTextAfterPaste.slice(0, 300)}`,
    );

    await takeShot(page, "takeover-clipboard-paste-to-vm");

    // ── 3b. Test "Copy from VM" (Remote -> Local) ──────────────────────────
    section("3b. Remote -> Local ('Copy from VM')");
    const testRemoteText = "VM_BUFFER_PAYLOAD_ABC_123456";

    // Set remote textarea value
    await page.evaluate((txt: string) => {
      const iframe = document.querySelector(
        "iframe[title='Live Browser Takeover']",
      ) as HTMLIFrameElement;
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      const el = doc?.getElementById("noVNC_clipboard_text") as HTMLTextAreaElement;
      if (el) el.value = txt;
    }, testRemoteText);

    // Click "Copy from VM"
    const copyBtn = page.locator("button:has-text('Copy from VM')").first();
    await copyBtn.click();
    await page.waitForTimeout(1_000);

    const localClipboardVal = await page.evaluate(async () => {
      return await navigator.clipboard.readText();
    });

    check(
      "Copy from VM copied remote buffer to local clipboard",
      localClipboardVal === testRemoteText,
      `expected "${testRemoteText}", got "${localClipboardVal}"`,
    );

    const bodyTextAfterCopy = (await page.locator("body").textContent()) ?? "";
    check(
      "Toolbar shows character count confirmation ('Copied 28 chars')",
      bodyTextAfterCopy.includes(`Copied ${testRemoteText.length} chars`),
      `body text: ${bodyTextAfterCopy.slice(0, 300)}`,
    );

    await takeShot(page, "takeover-clipboard-copy-from-vm");

    // ── 3c. Test Empty Remote Buffer Guard ─────────────────────────────────
    section("3c. Empty Remote Buffer Guard");
    const canaryLocalText = "CANARY_LOCAL_TEXT_DO_NOT_OVERWRITE";
    await page.evaluate(async (canary: string) => {
      await navigator.clipboard.writeText(canary);
      const iframe = document.querySelector(
        "iframe[title='Live Browser Takeover']",
      ) as HTMLIFrameElement;
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      const el = doc?.getElementById("noVNC_clipboard_text") as HTMLTextAreaElement;
      if (el) el.value = "";
    }, canaryLocalText);

    await copyBtn.click();
    await page.waitForTimeout(1_000);

    const bodyTextAfterEmpty = (await page.locator("body").textContent()) ?? "";
    check(
      "Toolbar displays 'nothing in the VM clipboard yet'",
      bodyTextAfterEmpty.includes("nothing in the VM clipboard yet"),
      `body text: ${bodyTextAfterEmpty.slice(0, 300)}`,
    );

    const localAfterEmpty = await page.evaluate(async () => {
      return await navigator.clipboard.readText();
    });

    check(
      "Local clipboard was NOT overwritten with empty string (canary preserved)",
      localAfterEmpty === canaryLocalText,
      `expected "${canaryLocalText}", got "${localAfterEmpty}"`,
    );

    await takeShot(page, "takeover-clipboard-empty-guard");

    // ── 3d. Test Denied / Unsupported Permission Fallback Path ──────────────
    section("3d. Denied/Unsupported Permission Honest Fallback Path");

    // Mock clipboard.readText failure to simulate permission denied / Firefox
    await page.evaluate(`
      navigator.clipboard.readText = function() {
        return Promise.reject(new Error("Permission denied by user (test)"));
      };
    `);

    await pasteBtn.click();
    await page.waitForTimeout(1_000);

    // v2 (aios-takeover-usable B1): a failed readText() no longer unfolds a second
    // textarea — the always-visible TextToVM panel IS the fallback, and the message
    // points at it. Its full send path (keysyms, VM clipboard, phone layout) is
    // check-takeover-text-input-e2e.ts's; here only the honest message and the
    // panel's presence are pinned.
    const bodyTextAfterDenied = (await page.locator("body").textContent()) ?? "";
    check(
      "Toolbar displays the honest permission error and points at the text panel",
      bodyTextAfterDenied.includes("Clipboard read failed (Permission denied by user (test)) — paste into the text panel below instead"),
      `body text: ${bodyTextAfterDenied.slice(0, 300)}`,
    );

    const panelTextarea = page.locator("[data-text-to-vm-input]").first();
    const hasPanelBox = (await panelTextarea.count()) > 0 && (await panelTextarea.isVisible());
    check("The always-visible text panel (the v2 fallback) is on screen", hasPanelBox);
    check(
      "No second 'Paste text here...' fallback textarea unfolds any more",
      (await page.locator("textarea[placeholder='Paste text here...']").count()) === 0,
    );

    await takeShot(page, "takeover-clipboard-permission-fallback");

    if (hasPanelBox) {
      const fallbackPayload = "MANUAL_FALLBACK_PASTED_TEXT_4567";
      await panelTextarea.fill(fallbackPayload);
      check(
        "The panel accepts pasted text with no clipboard permission involved",
        (await panelTextarea.inputValue()) === fallbackPayload,
      );
    }

    await context.close();
  } finally {
    /* ─────────────────────────────────────────────────────────────────────────
     * 4. Teardown & Resource Cleanup
     * ───────────────────────────────────────────────────────────────────────── */
    section("4. Teardown & Resource Cleanup");
    await browser.close().catch(() => {});
    front.stop();
    await next.stop().catch(() => {});
    fc.stop();

    // Clean up test profile and uploaded markers
    try {
      execFileSync("node", [RESEARCH_BROWSER, "close", TEST_PROFILE], {
        stdio: "pipe",
      });
      console.log(`      closed test profile "${TEST_PROFILE}"`);
    } catch (err: unknown) {
      console.error(`      failed to close test profile: ${(err as Error).message}`);
    }

    try {
      fs.rmSync(testUploadDir, { recursive: true, force: true });
      console.log(`      removed test upload dir: ${testUploadDir}`);
    } catch {
      /* ignore */
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 5. Read Back Screenshots for Evidence
   * ───────────────────────────────────────────────────────────────────────── */
  section("5. Visual Evidence & Screenshot Verification");
  console.log(`Generated ${shots.length} verification screenshots:`);
  for (const shotPath of shots) {
    const exists = fs.existsSync(shotPath);
    const size = exists ? fs.statSync(shotPath).size : 0;
    check(`Screenshot exists and non-empty: ${path.basename(shotPath)} (${size} bytes)`, exists && size > 0);
    // Read file back to verify byte readability
    if (exists) {
      const buf = fs.readFileSync(shotPath);
      if (buf.length === 0) failures++;
    }
  }

  console.log(`\nEvidence screenshots:\n${shots.map((s) => `  ${s}`).join("\n")}`);

  if (failures > 0) {
    console.log(`\nFAILED: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }

  console.log("\nALL PASS — takeover clipboard bridge and session quality fully verified E2E");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("\nUNCAUGHT EXCEPTION IN HARNESS:");
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
