/**
 * check-takeover-e2e-browser.ts — drive the IN-CHAT "Take Control" path in a real
 * browser, all the way to a live noVNC canvas, with nothing stubbed.
 *
 * WHY THIS EXISTS
 *   Round-4 review, finding 4: `BrowserStreamViewer` called `vncProxyUrl(dirId)`
 *   with one argument. That function returns null without a ticket, by design, so
 *   the in-chat takeover pane was unconditionally its own error branch — for every
 *   run, forever — while the /takeover/<runId> landing page worked. It typechecked,
 *   it built, it rendered, and every gate was green. The only instrument that would
 *   have caught it is a browser that clicks the button.
 *
 *   The feature also has a documented history of confident reports with nothing
 *   behind them (fleet note: browser-stream-viewer-round3-fabricated-evidence).
 *   So this harness screenshots what it claims and prints the paths.
 *
 * WHAT IT STANDS UP — nothing live is touched, every port is ephemeral
 *   1. forge-control PROBE: a Hono app on a spare port mounting ONLY the uploads
 *      router plus the same `server.on("upgrade")` listener index.ts installs.
 *      NOT `src/index.ts` — that boots the Telegram bridge, the cron tick and the
 *      calendar/glucose ticks, and a second copy of those on this host is an
 *      incident (fleet note: full-server-incident-telegram-and-vault-write).
 *   2. `next dev` on a spare port, FORGE_CONTROL_URL pointed at the probe.
 *   3. A loopback front proxy standing in for the nginx vhost: ordinary HTTP to
 *      Next, and `Connection: Upgrade` on the takeover prefix straight to the
 *      probe. This is the ONE hop the whole project is about. The live nginx
 *      location is not exercised here — it is deploy's to verify, and round 4
 *      already reproduced its 401s at the public origin.
 *   4. Playwright with a minted session cookie, because /desktop is behind
 *      NextAuth middleware and weakening middleware is forbidden.
 *
 * WHAT MUST ALREADY BE RUNNING
 *   A takeover stack for some profile, and an uploads dir whose marker resolves to
 *   it. Create both with the real driver:
 *     node scripts/research-browser.mjs open <profile> --url https://accounts.google.com/ \
 *       --service perplexity --run-id <12-hex> --label wall --no-reminder
 *   which exits 4, leaves Chrome running on its own X display, and writes the
 *   per-profile marker resolveProfileForRun reads first.
 *
 * RUN
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-takeover-e2e-browser.ts <run-id>
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import uploadsRoutes from "../../forge-control/src/routes/uploads.ts";
import { handleBrowserTakeoverUpgrade } from "../../forge-control/src/lib/browser-takeover.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB_ROOT = path.join(REPO_ROOT, "forge-control-web");
const LIVE_WEB_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";

const RUN_ID = process.argv[2] ?? process.env.FORGE_RUN_ID ?? "";
if (!/^[0-9a-f]{12}$/.test(RUN_ID)) {
  throw new Error(
    `usage: check-takeover-e2e-browser.ts <12-hex run id>  (got ${JSON.stringify(RUN_ID)})`,
  );
}

const SHOT_DIR = path.join("/opt/ai-os/uploads", process.env.FORGE_RUN_ID ?? RUN_ID);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}

/** Read one KEY=value out of the LIVE web env. Read-only, never written. */
function readLiveWebSecret(key: string): string {
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

/* ── 1. the forge-control probe ───────────────────────────────────────────── */

const UPLOADS_MOUNT = "/api/uploads";

async function startForgeControlProbe(): Promise<{ port: number; stop: () => void }> {
  const port = await findFreePort();
  // index.ts does `app.route("/api/uploads", uploads)` on a Hono instance. Hono
  // is not resolvable from scripts/ (no node_modules above this directory —
  // fleet note: tmp-probe-cannot-resolve-bare-imports), so the mount is done by
  // stripping the prefix and handing the REAL router the REAL request. Same
  // routing outcome, one fewer import.
  const server = createHttpServer((req, res) => {
    void (async () => {
      const rawPath = req.url ?? "/";
      const inner = rawPath.startsWith(UPLOADS_MOUNT)
        ? rawPath.slice(UPLOADS_MOUNT.length) || "/"
        : null;
      if (inner === null) {
        // Everything that is NOT the router under test is read through to the
        // live forge-control, GET/HEAD only. The desktop console calls /api/live,
        // /api/today, /api/team and a dozen more before it will render a row at
        // all, and a probe that 404s them shows an empty console with nothing to
        // click — which is exactly how a harness ends up "proving" a feature is
        // dead when it is the harness that is. Reads only, by construction: a
        // mutation is refused here rather than reaching the live control plane.
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
  // Byte-for-byte the listener index.ts installs, for the same reason.
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

/* ── 2. the nginx stand-in ────────────────────────────────────────────────── */

/**
 * The ONE HOP. Ordinary HTTP goes to Next; a `Connection: Upgrade` whose path is
 * under the takeover prefix goes STRAIGHT to forge-control, never touching the
 * Next Route Handler (which answers every upgrade with 502 + x-proxy-bailout,
 * because a Route Handler cannot host a WebSocket). Same shape as the live
 * `location /api/browser-takeover/ws/` block.
 */
const WS_PREFIX = "/api/browser-takeover/ws/";

async function startFrontProxy(port: number, nextPort: number, fcPort: number): Promise<{
  port: number;
  upgrades: { path: string; target: "forge-control" | "next" }[];
  stop: () => void;
}> {
  const upgrades: { path: string; target: "forge-control" | "next" }[] = [];
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
    upgrades.push({ path: reqPath, target: target === fcPort ? "forge-control" : "next" });
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
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    up.on("response", (upRes) => {
      // Not a 101 — relay the refusal verbatim so a rejection is visible rather
      // than looking like a network fault.
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
    upgrades,
    stop: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/* ── 3. next dev ──────────────────────────────────────────────────────────── */

async function startNextDev(fcPort: number, publicOrigin: string): Promise<{
  port: number;
  proc: ChildProcess;
  stop: () => Promise<void>;
}> {
  const port = await findFreePort();
  const env = {
    ...process.env,
    NODE_ENV: "development",
    AUTH_SECRET: readLiveWebSecret("AUTH_SECRET"),
    // NOT the live https AUTH_URL: NextAuth derives useSecureCookies from the
    // scheme, and this harness serves plain http.
    AUTH_URL: publicOrigin,
    AUTH_TRUST_HOST: "true",
    GITHUB_CLIENT_ID: readLiveWebSecret("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: readLiveWebSecret("GITHUB_CLIENT_SECRET"),
    FORGE_CONTROL_URL: `http://127.0.0.1:${fcPort}`,
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

/* ── playwright, resolved the way the sibling browser checks resolve it ─────
 *
 * Playwright is not a dependency of either package here — it is borrowed from
 * /opt/hermes-workspace, so there are no type declarations to import. Rather
 * than `any`, the handful of methods this harness actually calls are declared
 * structurally: if playwright's shape ever changes under one of them, this
 * stops compiling instead of failing at 2am inside a browser. */

interface ProbeLocator {
  first(): ProbeLocator;
  locator(selector: string): ProbeLocator;
  count(): Promise<number>;
  click(): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
}
interface ProbeFrameLocator {
  locator(selector: string): ProbeLocator;
}
interface ProbePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>;
  locator(selector: string): ProbeLocator;
  frameLocator(selector: string): ProbeFrameLocator;
  frames(): { url(): string }[];
  screenshot(options: { path: string }): Promise<unknown>;
}
interface ProbeContext {
  addCookies(cookies: Record<string, unknown>[]): Promise<void>;
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
    token: { name: "Takeover E2E Probe", email: "takeover-probe@localhost", sub: "takeover-probe" },
    secret,
    salt: "authjs.session-token", // plain http ⇒ no __Secure- prefix
    maxAge: 3600,
  });
}

/* ── main ─────────────────────────────────────────────────────────────────── */

/* tsconfig.checks.json emits CJS, where top-level await is a transform error
 * (fleet note: tsx-eval-has-no-top-level-await). Hence one async main(). */
async function main(): Promise<void> {

  const fc = await startForgeControlProbe();
  console.log(`forge-control probe      → 127.0.0.1:${fc.port}`);

  // The front proxy's port has to be known before Next starts, because AUTH_URL
  // must equal the origin the browser actually uses.
  const frontPort = await findFreePort();
  const publicOrigin = `http://127.0.0.1:${frontPort}`;

  const next = await startNextDev(fc.port, publicOrigin);
  console.log(`next dev                 → 127.0.0.1:${next.port}`);

  const front = await startFrontProxy(frontPort, next.port, fc.port);
  console.log(`front proxy (nginx hop)  → 127.0.0.1:${front.port}`);

  const cookie = await mintSessionCookie();

  const chromium = loadChromium();
  // Pinned executable, not whatever the driver would pick: an installed chromium
  // is not necessarily the one the driver asks for (fleet note:
  // playwright-driver-two-launch-traps).
  const browser = await chromium.launch({ executablePath: resolveChromium(), args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: "authjs.session-token", value: cookie, domain: "127.0.0.1", path: "/", httpOnly: true },
  ]);
  const page = await context.newPage();

  const shots: string[] = [];
  async function shot(label: string): Promise<void> {
    const p = path.join(SHOT_DIR, `${stamp()}-${label}.png`);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: p });
    shots.push(p);
    console.log(`      shot: ${p}`);
  }

  try {
    const base = `http://127.0.0.1:${front.port}`;

    /* Positive control on the session first: an unauthenticated context must be
     * bounced, or a "the page rendered" claim proves nothing about auth. */
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`${base}/desktop`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    check(
      "control · no cookie ⇒ /desktop redirects to /signin",
      anonPage.url().includes("/signin"),
      anonPage.url(),
    );
    await anon.close();

    await page.goto(`${base}/desktop`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForTimeout(3_000);
    check("signed in ⇒ /desktop renders the console", !page.url().includes("/signin"), page.url());
    await shot("takeover-e2e-desktop");

    /* The in-chat affordance. The transcript block and the panel indicator are the
     * same component; this drives whichever is present for this run. */
    await page.goto(`${base}/desktop`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.evaluate<string, void>((surface: string) => {
      window.localStorage.setItem("forge.desktop.surface", JSON.stringify(surface));
    }, "live");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 180_000 });
    /* `next dev` compiles each API route on its first request, so the console's
     * queries can take tens of seconds to land the first time. Poll instead of
     * sleeping a guessed interval — a fixed wait here is how a harness reports a
     * working feature as dead. */
    async function waitForCount(sel: string, timeoutMs: number): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const n = await page.locator(sel).count();
        if (n > 0 || Date.now() > deadline) return n;
        await page.waitForTimeout(2_000);
      }
    }

    await waitForCount("[data-run-shots-indicator]", 120_000);
    await shot("takeover-e2e-live-surface");

    /* The camera badge on this run's row. RunShotsIndicator renders nothing at
     * all when the shot index has no entry for the run, so a miss here means the
     * shots never reached the index — not that the button is broken. */
    const indicator = page.locator(`[data-run-shots-indicator="${RUN_ID}"]`).first();
    const haveIndicator = (await waitForCount(`[data-run-shots-indicator="${RUN_ID}"]`, 60_000)) > 0;
    check(
      `the run's camera indicator is on the LIVE panel (run ${RUN_ID})`,
      haveIndicator,
      "no [data-run-shots-indicator] for this run — is the run still live and are its shots indexed?",
    );
    if (haveIndicator) {
      await indicator.click();
      await page.waitForTimeout(3_000);
      await shot("takeover-e2e-indicator-open");
    }

    const takeControl = page.locator("[data-take-control]").first();
    const found = (await takeControl.count()) > 0;
    check("an in-chat 'Take Control' affordance is on screen", found, "none found on the live surface");
    if (found) {
      await takeControl.click();
      await page.waitForTimeout(12_000);
      await shot("takeover-e2e-canvas");
      const state = await page.locator("[data-takeover-ticket-state]").first().getAttribute("data-takeover-ticket-state");
      check("…and clicking it minted a ticket", state === "ready", `ticket state: ${state}`);
      const iframes = page.frames().map((f: { url(): string }) => f.url());
      check(
        "…and the pane embedded the ticketed noVNC URL",
        iframes.some((u: string) => u.includes("/vnc/vnc.html") && u.includes("path=api/browser-takeover/ws/")),
        iframes.join("\n        "),
      );
      const canvas = page.frameLocator("iframe[title='Live Browser Takeover']").locator("canvas");
      const canvasVisible = await canvas.count().catch(() => 0);
      check("…and noVNC put a canvas on screen", canvasVisible > 0, `canvas count: ${canvasVisible}`);
    }

    check(
      "the WebSocket went to forge-control, NOT through the Next route handler",
      front.upgrades.some((u) => u.target === "forge-control"),
      JSON.stringify(front.upgrades),
    );
    console.log(`      upgrades seen by the hop: ${JSON.stringify(front.upgrades)}`);
  } finally {
    await browser.close();
    front.stop();
    await next.stop();
    fc.stop();
  }

  console.log(`\nscreenshots:\n${shots.map((s) => `  ${s}`).join("\n")}`);
  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS — the in-chat Take Control button reaches a live browser");
  process.exit(0);

}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
