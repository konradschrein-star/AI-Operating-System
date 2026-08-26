/**
 * check-takeover-text-input-e2e.ts — the text-to-VM panel, typed through the
 * REAL stack, with a no-log proof (aios-takeover-usable B5, PLAN.md §1.1/§1.3).
 *
 * WHY THIS EXISTS
 *   The panel exists so Konrad can paste a password on his phone and have it
 *   land in a login form inside the VM. Two things can go wrong that no unit
 *   test sees: the keystrokes can be mangled somewhere between the browser and
 *   Xvfb (umlauts, €, Tab, newlines, emoji), and the text can leak into a log.
 *   check-vm-keys.ts pins the pure rules; THIS file types through noVNC →
 *   front proxy → forge-control's upgrade pipe → websockify → x11vnc → Chrome
 *   on Xvfb and reads the result back from the page inside the VM, then greps
 *   every process output and log file it can reach for the typed sentinel.
 *
 * TWO MODES, BOTH WIRED INTO gates-808.sh (an orphaned check is the defect
 * this brief exists to prevent — 38 of 66 files in scripts/checks/ are run by
 * nothing):
 *   default    fast, no browser, ~2 s: §7 keysym table, the static no-console
 *              scan, the session-view shape and header strings. Runs on every
 *              gates-808 invocation.
 *   --browser  everything below as well. Stands up the whole stack and takes
 *              ~2–3 min (next dev alone is most of it), so it sits behind the
 *              same --browser flag as the other browser gates.
 *
 * WHAT --browser STANDS UP — nothing live is touched, every port is ephemeral
 *   1. A loopback ECHO server: the page inside the VM POSTs its textarea value
 *      (sequence-numbered, text/plain from file:// — CORS-simple, no
 *      preflight) on every input event; the check reads the newest one back.
 *   2. `research-browser.mjs open testtextinput --throwaway --url file://…/echo.html`
 *      — the real supervisor, real Chrome on Xvfb, real x11vnc + websockify.
 *      echo.html is a full-screen <textarea autofocus>; a Tab keydown inserts
 *      "\t" instead of moving focus (a browser textarea does not hold a tab by
 *      default — R1 §2.2 case d — so the page makes it hold one, which is how
 *      an XK_Tab that ARRIVED is distinguished from one that was dropped).
 *   3. xdotool maximises the VM Chrome window and clicks its centre: right
 *      after launch the VM's keyboard focus is Chrome's OMNIBOX, where Return
 *      is a Google search (memory: vm-chrome-focus-starts-in-omnibox…). A
 *      fail-fast "ok" probe through the real panel proves focus before the
 *      sentinel is typed.
 *   4. forge-control PROBE: an http.Server mounting ONLY the uploads router plus
 *      the same `server.on("upgrade")` listener index.ts installs, on a fixed
 *      spare port so it can be RESTARTED in place — the measured real-world
 *      killer is a forge-control deploy resetting every open takeover socket
 *      (memory: takeover-socket-death-forensics; 114 restarts, 0 crashes).
 *   5. `next dev` pointed at the probe, and a front proxy standing in for the
 *      nginx vhost (plain HTTP → Next, `Connection: Upgrade` on the takeover
 *      prefix → the probe).
 *   6. Playwright Chromium as an iPhone: 390×844, iPhone UA, isMobile, hasTouch,
 *      with a minted NextAuth cookie. Every control is TAPPED, not clicked.
 *
 * WHAT IT ASSERTS (numbers are the brief's)
 *   (1) panel + Send visible without scrolling at 390×844; Send ≥ 44 px tall
 *   (2) Type mode: "Pässwörd ßÄÖÜ € tab\there\nline2" arrives byte-exact
 *   (3) Set VM clipboard mode: `xclip -o -selection clipboard` holds the text
 *       (compared as Latin-1 bytes — the VNC clipboard is Latin-1 here, memory:
 *       vnc-clipboard-is-latin1-on-x11vnc-stack)
 *   (4) restart the probe while connected → 'reconnecting n/5' shown →
 *       connected again → a NEW jti accepted (fresh mint, never a replay) →
 *       typing still works through the new iframe
 *   (5) session view: connected_sockets=1, remaining_ms>0, header 'ends in';
 *       Done twice → end route answered ended:true, `status` says takeover.up
 *       false, page says 'Session ended' — AND the VNC/noVNC ports are free
 *       and no x11vnc for the display survives within 15 s. Measured (run 3):
 *       teardownTakeover() fires one SIGTERM and never escalates; an x11vnc
 *       that ignores it (futex_wait_queue, needed SIGKILL) keeps the port and
 *       hangs every later takeover on that profile. E1 refuses to start on
 *       such a leftover and names the pid, so the gate reads "orphan", not
 *       "timeout".
 *   (6) NO-LOG: the sentinel is in none of this process's stdout/stderr (the
 *       probe and front proxy live here), next dev's output, the profile's
 *       .state/*.log files; and the five page modules contain no `console.`
 *       outside comments
 *   (7) keysym table: "\r\n" → one 0xff0d, "\t" → 0xff09, "ä" → 0xe4,
 *       "€" → 0x20ac, "🙂" → one event
 *
 * NEVER PRINTS THE TEXT. A failed comparison reports lengths and the first
 * differing index only. The sentinel appears in this source file and nowhere
 * else — that is the property being checked.
 *
 * RUN
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-takeover-text-input-e2e.ts [--browser]
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { createConnection } from "node:net";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import uploadsRoutes from "../../forge-control/src/routes/uploads.ts";
import {
  handleBrowserTakeoverUpgrade,
  TAKEOVER_UPGRADE_PREFIX,
} from "../../forge-control/src/lib/browser-takeover.ts";
import { computeSessionView } from "../../forge-control/src/lib/takeover-session.ts";
import {
  XK_RETURN,
  XK_TAB,
  textToKeyEvents,
} from "../../forge-control-web/app/takeover/[runId]/vm-keys.ts";
import {
  composeStatusLine,
  formatRemaining,
} from "../../forge-control-web/app/takeover/[runId]/useTakeoverSession.ts";

/* ── constants ──────────────────────────────────────────────────────────── */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB_ROOT = path.join(REPO_ROOT, "forge-control-web");
const TAKEOVER_DIR = path.join(WEB_ROOT, "app/takeover/[runId]");
const LIVE_WEB_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";
const RESEARCH_BROWSER = path.join(REPO_ROOT, "scripts/research-browser.mjs");
const STATE_ROOT = "/opt/ai-os/browser-profiles/.state";
const UPLOADS_ROOT = "/opt/ai-os/uploads";

const BROWSER = process.argv.includes("--browser");
const RUN_ID = process.env.FORGE_RUN_ID ?? "deadbeefcafe";
const TEST_RUN_ID = "e2ec11b00002";
const TEST_PROFILE = "testtextinput";
const SHOT_DIR = path.join(UPLOADS_ROOT, RUN_ID);

/** What Type mode must carry byte-exact: Latin-1 umlauts + ß, € (table hit,
 *  not Latin-1), a Tab, a newline. Appears in this file and nowhere else. */
const SENTINEL = "Pässwörd ßÄÖÜ € tab\there\nline2";
/** A distinctive fragment for the log sweep (the full sentinel spans a line). */
const SENTINEL_FRAGMENT = "Pässwörd ßÄÖÜ";
/** Latin-1 only: the panel refuses €/emoji in clipboard mode by design. */
const CLIP_TEXT = "Clip ÄÖÜ ß é 42";
const PROBE_TEXT = "ok";
const AFTER_RECONNECT_TEXT = "again";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const VIEWPORT = { width: 390, height: 844 };

const stamp = (): string => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ── output tee: everything this process emits, for the no-log sweep ────── */

const captured: string[] = [];
function teeStream(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  const patched = (...args: unknown[]): boolean => {
    const chunk = args[0];
    captured.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return original(...args);
  };
  (stream as { write: unknown }).write = patched;
}
teeStream(process.stdout);
teeStream(process.stderr);

/* ── assertion helpers ──────────────────────────────────────────────────── */

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
}
/** Lengths and first differing index — never the text. */
function diffSummary(expected: string, actual: string): string {
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  return `expected ${expected.length} code units, got ${actual.length}; first difference at index ${i}`;
}
const hex = (events: readonly { keysym: number }[]): string => events.map((e) => e.keysym.toString(16)).join(" ");

function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * FAST SECTIONS — no browser, run on every gates-808 invocation
 * ═══════════════════════════════════════════════════════════════════════════ */

function fastSections(): void {
  /* (7) keysym table */
  section("7. vm-keys unit table — the rules the E2E relies on");
  check('"\\r\\n" → ONE Return (0xff0d)', hex(textToKeyEvents("\r\n")) === XK_RETURN.toString(16) && XK_RETURN === 0xff0d, hex(textToKeyEvents("\r\n")));
  check('"\\t" → Tab (0xff09)', hex(textToKeyEvents("\t")) === XK_TAB.toString(16) && XK_TAB === 0xff09, hex(textToKeyEvents("\t")));
  check('"ä" → 0xe4 (Latin-1 identity)', hex(textToKeyEvents("ä")) === "e4", hex(textToKeyEvents("ä")));
  check('"€" → 0x20ac (noVNC table, XK_EuroSign)', hex(textToKeyEvents("€")) === "20ac", hex(textToKeyEvents("€")));
  check('"🙂" → ONE event (code-point iteration, 0x01000000|cp)', textToKeyEvents("🙂").length === 1 && textToKeyEvents("🙂")[0].keysym === 0x0101f642, hex(textToKeyEvents("🙂")));
  const sentinelEvents = textToKeyEvents(SENTINEL);
  const sentinelCodePoints = Array.from(SENTINEL).length;
  check(
    `sentinel → ${sentinelEvents.length} events = its ${sentinelCodePoints} code points (no drop, no split)`,
    sentinelEvents.length === sentinelCodePoints,
  );
  check(
    "sentinel's Tab and newline map to XK_Tab / XK_Return at the expected positions",
    sentinelEvents[Array.from(SENTINEL).indexOf("\t")]?.keysym === XK_TAB &&
      sentinelEvents[Array.from(SENTINEL).indexOf("\n")]?.keysym === XK_RETURN,
  );

  /* (6, static) no console. in the page modules */
  section("6s. static — no `console.` outside comments in the five page modules");
  const modules = ["TakeoverClient.tsx", "TextToVM.tsx", "novnc-bridge.ts", "useTakeoverSession.ts", "vm-keys.ts"];
  for (const name of modules) {
    const file = path.join(TAKEOVER_DIR, name);
    const exists = fs.existsSync(file);
    check(`${name} exists`, exists, file);
    if (!exists) continue;
    const src = fs.readFileSync(file, "utf8");
    const code = stripComments(src);
    const hits = code.match(/\bconsole\s*\./g) ?? [];
    check(`${name}: no \`console.\` in code (${hits.length} hit${hits.length === 1 ? "" : "s"})`, hits.length === 0);
  }

  /* session-view shape + header strings */
  section("5s. session view shape (pure) + the header strings the page renders");
  const now = new Date("2026-08-26T10:00:00.000Z");
  const live = computeSessionView({
    profile: TEST_PROFILE,
    activity: {
      connected: 1,
      connects: 2,
      first_connect_at: "2026-08-26T09:50:00.000Z",
      last_connect_at: "2026-08-26T09:55:00.000Z",
      last_disconnect_at: "2026-08-26T09:52:00.000Z",
      written_at: "2026-08-26T09:55:00.000Z",
    },
    session: {
      pid: 4242,
      takeover_started_at: "2026-08-26T09:50:00.000Z",
      takeover_deadline: "2026-08-26T11:50:00.000Z",
      hard_deadline: "2026-08-26T17:00:00.000Z",
      idle_deadline: null,
    },
    takeover: { xvfb: { pid: 1 }, x11vnc: { pid: 2 }, websockify: { pid: 3 } },
    lastShutdown: { reason: "stale from an earlier run", at: "2026-08-26T08:00:00.000Z" },
    now,
    pidAlive: () => true,
  });
  const CONTRACT_KEYS = [
    "profile", "stack_up", "supervisor_live", "connected_sockets", "connects", "takeover_started_at",
    "last_disconnect_at", "idle_deadline", "takeover_deadline", "hard_deadline", "remaining_ms", "now", "ended",
  ];
  const keys = Object.keys(live).sort();
  check(
    `view carries exactly the PLAN.md §1.4 keys (${keys.length})`,
    JSON.stringify(keys) === JSON.stringify([...CONTRACT_KEYS].sort()),
    keys.join(","),
  );
  check("live supervisor + 2 h cap → remaining_ms = 1:50:00", live.remaining_ms === 110 * 60_000, String(live.remaining_ms));
  check("live supervisor ⇒ ended is null even with a stale last-shutdown.json", live.ended === null);
  check("connected_sockets/connects come from the activity record", live.connected_sockets === 1 && live.connects === 2);
  const dead = computeSessionView({
    profile: TEST_PROFILE,
    activity: null,
    session: { pid: 4242 },
    takeover: null,
    lastShutdown: { reason: "ended by Done", at: "2026-08-26T09:59:00.000Z" },
    now,
    pidAlive: () => false,
  });
  check("dead supervisor ⇒ remaining_ms null, ended carries the reason", dead.remaining_ms === null && dead.ended?.reason === "ended by Done");
  check("formatRemaining(6 600 000) = '1:50:00'", formatRemaining(6_600_000) === "1:50:00", formatRemaining(6_600_000));
  const connectedLine = composeStatusLine({
    ticket: "ready",
    viewer: "connected",
    reconnect: null,
    clock: { kind: "ok", body: live, remainingMs: live.remaining_ms },
    bridgeError: null,
  });
  check("header: 'connected · ends in 1:50:00'", connectedLine === "connected · ends in 1:50:00", connectedLine);
  const reconnectLine = composeStatusLine({
    ticket: "loading",
    viewer: "disconnected",
    reconnect: { attempt: 2, max: 5, droppedAfterS: 118, exhausted: false },
    clock: { kind: "loading" },
    bridgeError: null,
  });
  check("header: 'reconnecting 2/5 · dropped after 118 s'", reconnectLine === "reconnecting 2/5 · dropped after 118 s", reconnectLine);
  const endedLine = composeStatusLine({
    ticket: "ready",
    viewer: "disconnected",
    reconnect: null,
    clock: { kind: "ended", reason: "ended by Done", at: "2026-08-26T09:59:00.000Z" },
    bridgeError: null,
  });
  check("header: 'Session ended: ended by Done'", endedLine === "Session ended: ended by Done", endedLine);
}

/** Drop block comments and whole-token line comments; keep strings. `http://`
 *  survives because the `//` there is preceded by `:`, not whitespace. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/* ═══════════════════════════════════════════════════════════════════════════
 * E2E HARNESS — copied from check-takeover-clipboard-e2e.ts, restart added
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Read one KEY=value out of the LIVE web env. Read-only, never written. */
function readLiveWebSecret(key: string): string {
  if (process.env[key]) return process.env[key] as string;
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
    await sleep(500);
  }
  throw new Error(`nothing listening on 127.0.0.1:${port} after ${timeoutMs}ms`);
}

async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/* ── 1. echo server: what the page INSIDE the VM reports ─────────────────── */

interface EchoState {
  seq: number;
  last: string;
  count: number;
}

async function startEchoServer(): Promise<{ port: number; state: () => EchoState; reset: () => void; stop: () => Promise<void> }> {
  const port = await findFreePort();
  let state: EchoState = { seq: -1, last: "", count: 0 };
  const server = createHttpServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "POST" && req.url === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const nl = body.indexOf("\n");
        const seq = Number.parseInt(body.slice(0, nl), 10);
        const value = body.slice(nl + 1);
        // Requests race each other; the highest sequence number is the newest state.
        if (Number.isInteger(seq) && seq > state.seq) state = { seq, last: value, count: state.count + 1 };
        else state = { ...state, count: state.count + 1 };
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    state: () => state,
    reset: () => {
      state = { seq: -1, last: "", count: 0 };
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeEchoPage(dir: string, echoPort: number): string {
  const file = path.join(dir, "echo.html");
  // The textarea fills the window so the focus click cannot miss. Tab is made
  // to INSERT a tab (a browser textarea moves focus on Tab by default; R1 §2.2
  // case d), so an XK_Tab that arrived is visible in the value, and one that
  // was dropped is a missing character rather than a focus mystery.
  const html = `<!doctype html><meta charset="utf-8"><title>text-input echo</title>
<style>html,body{margin:0;height:100%;background:#fff}textarea{position:fixed;inset:0;width:100%;height:100%;box-sizing:border-box;font:28px monospace;border:0;padding:24px;outline:none}</style>
<textarea id="t" autofocus spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
<script>
const t = document.getElementById('t');
let seq = 0;
t.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    t.setRangeText('\\t', t.selectionStart, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
t.addEventListener('input', () => {
  fetch('http://127.0.0.1:${echoPort}/echo', { method: 'POST', mode: 'no-cors', body: (seq++) + '\\n' + t.value }).catch(() => {});
});
</script>
`;
  fs.writeFileSync(file, html, "utf8");
  return file;
}

/* ── 2. forge-control probe — restartable in place ───────────────────────── */

const UPLOADS_MOUNT = "/api/uploads";

interface Probe {
  port: number;
  /** Destroy every open socket (incl. upgraded takeover pipes), close, listen again. */
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

async function startForgeControlProbe(): Promise<Probe> {
  const port = await findFreePort();
  let server: Server | null = null;
  let sockets = new Set<Duplex>();

  const build = (): Server => {
    const s = createHttpServer((req, res) => {
      void (async () => {
        const rawPath = req.url ?? "/";
        const inner = rawPath.startsWith(UPLOADS_MOUNT) ? rawPath.slice(UPLOADS_MOUNT.length) || "/" : null;
        if (inner === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "probe mounts only /api/uploads", path: rawPath }));
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
    s.on("connection", (sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
    });
    s.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      handleBrowserTakeoverUpgrade(req, socket, head)
        .then((handled) => {
          if (!handled) socket.destroy();
        })
        .catch(() => socket.destroy());
    });
    return s;
  };

  const listen = async (): Promise<void> => {
    server = build();
    const s = server;
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => resolve());
    });
    await waitForPort(port, 10_000);
  };
  const close = async (): Promise<void> => {
    const s = server;
    if (!s) return;
    server = null;
    for (const sock of sockets) sock.destroy();
    sockets = new Set<Duplex>();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  };

  await listen();
  return {
    port,
    restart: async () => {
      await close();
      await listen();
    },
    stop: close,
  };
}

/* ── 3. front proxy (nginx stand-in) ─────────────────────────────────────── */

async function startFrontProxy(port: number, nextPort: number, fcPort: number): Promise<{ port: number; stop: () => void }> {
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
    const target = reqPath.startsWith(TAKEOVER_UPGRADE_PREFIX) ? fcPort : nextPort;
    const up = httpRequest({ host: "127.0.0.1", port: target, method: req.method, path: reqPath, headers: req.headers });
    up.on("upgrade", (upRes, upSocket, upHead) => {
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
      const headers = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}\r\n`)
        .join("");
      socket.write(statusLine + headers + "\r\n");
      if (upHead.length > 0) socket.unshift(upHead);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
      upSocket.on("close", () => socket.destroy());
      socket.on("close", () => upSocket.destroy());
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

/* ── 4. next dev ─────────────────────────────────────────────────────────── */

async function startNextDev(fcPort: number, publicOrigin: string): Promise<{
  port: number;
  proc: ChildProcess;
  output: () => string;
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
    TAKEOVER_TICKET_SECRET: process.env.TAKEOVER_TICKET_SECRET ?? "",
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
    output: () => out,
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

/* ── 5. Playwright, structurally typed ──────────────────────────────────── */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ProbeLocator {
  first(): ProbeLocator;
  count(): Promise<number>;
  tap(options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  inputValue(): Promise<string>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
  boundingBox(): Promise<Box | null>;
}
interface ProbePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
  evaluate<R = unknown, A = unknown>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R>;
  locator(selector: string): ProbeLocator;
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

/** The bundled headless shell if the cache holds one, else system Chrome
 *  (R1 §4.2: the driver's pinned build may be absent — never `launch()` bare). */
function resolveChromium(): string {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  if (fs.existsSync(cache)) {
    const candidates = fs
      .readdirSync(cache)
      .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
      .map((d) =>
        d.startsWith("chromium_headless_shell-")
          ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
          : path.join(cache, d, "chrome-linux64", "chrome"),
      )
      .filter((p) => fs.existsSync(p));
    if (candidates.length > 0) return candidates[0];
  }
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no Chromium under ${cache} and no system Chrome`);
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
  // The salt MUST equal the cookie name (memory: nextauth-salt-must-equal-cookie-name).
  return encode({
    token: { name: "Text-input E2E Probe", email: "text-input-probe@localhost", sub: "text-input-probe" },
    secret,
    salt: "authjs.session-token",
    maxAge: 3600,
  });
}

/* ── 6. the VM side: research-browser + xdotool + xclip ──────────────────── */

interface OpenOutput {
  takeover?: { up?: boolean; display?: string; novnc_port?: number; vnc_port?: number };
  session?: { live?: boolean; pid?: number | null };
  login?: { needs_login?: boolean };
  throwaway?: boolean;
}
interface StatusOutput {
  takeover?: { up?: boolean };
  session?: { live?: boolean };
  last_shutdown?: { reason?: string } | null;
}

function researchBrowser<T>(args: string[], timeoutMs: number): { json: T; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [RESEARCH_BROWSER, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { json: JSON.parse(stdout) as T, code: 0 };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    if (typeof e.stdout === "string" && e.stdout.trim().startsWith("{")) {
      return { json: JSON.parse(e.stdout) as T, code: e.status ?? 1 };
    }
    throw new Error(`research-browser ${args[0]} ${args[1]} failed (exit ${e.status ?? "?"}): ${(e.stderr ?? e.message ?? "").slice(-1500)}`);
  }
}

function xdotool(display: string, args: string[]): string {
  return execFileSync("/usr/bin/xdotool", args, {
    encoding: "utf8",
    env: { ...process.env, DISPLAY: display },
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Give the echo textarea VM keyboard focus: maximise the Chrome window that
 *  shows it and click its middle. Returns what it did, for the transcript. */
function focusEchoTextarea(display: string): string {
  const ids = xdotool(display, ["search", "--onlyvisible", "--name", "text-input echo"]).split(/\s+/).filter(Boolean);
  if (ids.length === 0) throw new Error(`xdotool found no visible window titled 'text-input echo' on ${display}`);
  const id = ids[0];
  xdotool(display, ["windowactivate", "--sync", id]);
  xdotool(display, ["windowmove", id, "0", "0"]);
  xdotool(display, ["windowsize", id, "1600", "1000"]);
  xdotool(display, ["mousemove", "800", "600", "click", "1"]);
  return `window ${id} maximised to 1600×1000, clicked (800,600)`;
}

/** Select-all + BackSpace inside the VM textarea (focus is already there). */
function clearVmTextarea(display: string): void {
  xdotool(display, ["key", "--clearmodifiers", "ctrl+a", "BackSpace"]);
}

/** Who listens on a loopback TCP port (`ss -ltnp`), with its cmdline — or null. */
function listenerOn(port: number): { pid: number; cmd: string } | null {
  const out = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8", timeout: 5_000 });
  const m = out.match(/pid=(\d+)/);
  if (!m) return null;
  const pid = Number.parseInt(m[1], 10);
  let cmd = "?";
  try {
    cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ").trim();
  } catch {
    /* it may have exited between ss and the read */
  }
  return { pid, cmd };
}

/** Every x11vnc process for a display, as `pid cmd` lines. */
function x11vncProcessesFor(display: string): string[] {
  return execFileSync("ps", ["-eo", "pid,cmd"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(`x11vnc -display ${display} `));
}

/**
 * Measured 2026-08-26 (B5 run 3): `teardownTakeover()` (research-browser.mjs:1276)
 * sends ONE SIGTERM per process and neither waits nor escalates. x11vnc logged
 * `caught signal: 15` and stayed alive in futex_wait_queue holding :6029 — a
 * second SIGTERM did nothing, SIGKILL was needed. Every later `open` on the
 * profile then logs `could not obtain listening port`, websockify connects to
 * the zombie, and noVNC hangs before ServerInit. Named here BEFORE `open`, so
 * the gate says "orphan pid N" instead of timing out 60 s later.
 */
function refuseIfPortsAreHeld(profile: string): void {
  const pin = path.join(STATE_ROOT, profile, "display");
  if (!fs.existsSync(pin)) return; // first run on this box: nothing can be held yet
  const n = Number.parseInt(fs.readFileSync(pin, "utf8").trim(), 10);
  if (!Number.isInteger(n)) return;
  for (const port of [5900 + n, 6900 + (n - 90)]) {
    const holder = listenerOn(port);
    check(
      `no leftover listener on :${port} before open (display :${n})`,
      holder === null,
      holder ? `pid ${holder.pid} (${holder.cmd}) still holds it — a previous session's teardown did not finish; kill it and re-run` : "",
    );
    if (holder) throw new Error(`port :${port} is held by pid ${holder.pid} from a previous session — the stack cannot come up cleanly`);
  }
}

function readVmClipboardHex(display: string): string {
  const out = execFileSync("/usr/bin/xclip", ["-o", "-selection", "clipboard", "-display", display], {
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.toString("hex");
}

/* ── 7. page helpers ─────────────────────────────────────────────────────── */

const IFRAME = "iframe[title='Live Browser Takeover']";

async function viewerClasses(page: ProbePage): Promise<string> {
  return page.evaluate<string, string>((sel) => {
    const f = document.querySelector(sel) as HTMLIFrameElement | null;
    const doc = f?.contentDocument ?? null;
    return doc?.documentElement?.className ?? "";
  }, IFRAME);
}

async function statusText(page: ProbePage): Promise<string> {
  return (await page.locator("[data-takeover-status]").first().textContent()) ?? "";
}

async function waitForConnected(page: ProbePage, timeoutMs: number): Promise<void> {
  await waitUntil(
    "noVNC_connected on the iframe and 'connected' in the header",
    async () => {
      const cls = await viewerClasses(page);
      const st = await statusText(page);
      return cls.split(/\s+/).includes("noVNC_connected") && st.startsWith("connected") ? true : null;
    },
    timeoutMs,
    250,
  );
}

async function waitForEcho(
  echo: { state: () => EchoState },
  expected: string,
  timeoutMs: number,
): Promise<EchoState> {
  const deadline = Date.now() + timeoutMs;
  let last = echo.state();
  while (Date.now() < deadline) {
    last = echo.state();
    if (last.last === expected) return last;
    await sleep(200);
  }
  return last;
}

function acceptedJtis(): string[] {
  const out: string[] = [];
  for (const line of captured.join("").split("\n")) {
    const m = line.match(/\[browser-takeover\] upgrade accepted .*\bjti=(\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}
function closedJtis(): string[] {
  const out: string[] = [];
  for (const line of captured.join("").split("\n")) {
    const m = line.match(/\[browser-takeover\] upgrade closed .*\bjti=(\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * E2E
 * ═══════════════════════════════════════════════════════════════════════════ */

const cleanups: Array<{ what: string; run: () => Promise<void> | void }> = [];
async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (!c) break;
    try {
      await c.run();
      console.log(`      cleanup: ${c.what}`);
    } catch (err) {
      console.error(`      cleanup FAILED (${c.what}): ${(err as Error).message}`);
    }
  }
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(sig, () => {
    console.error(`\n${sig} — tearing down the harness before exiting`);
    void runCleanups().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  });
}

async function e2e(): Promise<string[]> {
  const shots: string[] = [];
  const startedAt = Date.now();
  if (!process.env.TAKEOVER_TICKET_SECRET) {
    process.env.TAKEOVER_TICKET_SECRET = "TEST_TAKEOVER_TICKET_SECRET_0123456789abcdef0123456789abcdef";
  }

  section("E0. preflight");
  for (const bin of ["/usr/bin/xdotool", "/usr/bin/xclip", "/usr/share/novnc/vnc.html", RESEARCH_BROWSER]) {
    check(`${bin} present`, fs.existsSync(bin));
  }
  if (failures > 0) throw new Error("preflight failed — the E2E cannot run on this box");

  /* echo server + page */
  const echo = await startEchoServer();
  cleanups.push({ what: "echo server closed", run: () => echo.stop() });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "takeover-text-input-"));
  cleanups.push({ what: `removed ${tmp}`, run: () => fs.rmSync(tmp, { recursive: true, force: true }) });
  const echoPage = writeEchoPage(tmp, echo.port);
  console.log(`      echo server              → 127.0.0.1:${echo.port}`);

  /* VM: real Chrome on Xvfb via the real driver */
  section("E1. VM — research-browser open (throwaway) + focus the echo textarea");
  refuseIfPortsAreHeld(TEST_PROFILE);
  const opened = researchBrowser<OpenOutput>(
    ["open", TEST_PROFILE, "--throwaway", "--url", `file://${echoPage}`, "--label", "text-input-echo", "--run-id", TEST_RUN_ID, "--no-reminder"],
    120_000,
  );
  cleanups.push({
    what: `research-browser close ${TEST_PROFILE}`,
    run: () => {
      researchBrowser<unknown>(["close", TEST_PROFILE], 60_000);
    },
  });
  const display = opened.json.takeover?.display ?? "";
  const novncPort = opened.json.takeover?.novnc_port ?? 0;
  const vncPort = opened.json.takeover?.vnc_port ?? 0;
  check(`open exited 0 with the stack up (display ${display}, vnc ${vncPort}, novnc ${novncPort})`, opened.code === 0 && opened.json.takeover?.up === true, JSON.stringify(opened.json.takeover));
  const vncHolder = listenerOn(vncPort);
  check(
    `:${vncPort} is held by an x11vnc for ${display} (pid ${vncHolder?.pid ?? "none"})`,
    vncHolder !== null && vncHolder.cmd.includes(`x11vnc -display ${display} `),
    vncHolder ? vncHolder.cmd : "no listener",
  );
  check("profile is marked throwaway", opened.json.throwaway === true);
  check("a supervisor is live for the profile", opened.json.session?.live === true, JSON.stringify(opened.json.session));
  if (!/^:\d+$/.test(display)) throw new Error(`open did not report a display (got ${JSON.stringify(display)})`);
  await sleep(1_000);
  const focused = focusEchoTextarea(display);
  console.log(`      focus: ${focused}`);

  /* marker so resolveProfileForRun(TEST_RUN_ID) → TEST_PROFILE */
  const testUploadDir = path.join(UPLOADS_ROOT, TEST_RUN_ID);
  const markerDir = path.join(testUploadDir, "browser-state");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(
    path.join(markerDir, `${TEST_PROFILE}.json`),
    JSON.stringify({ profile: TEST_PROFILE, checked_at: new Date().toISOString() }),
    "utf8",
  );
  cleanups.push({ what: `removed ${testUploadDir}`, run: () => fs.rmSync(testUploadDir, { recursive: true, force: true }) });

  /* stack */
  section("E2. stack — forge-control probe, next dev, front proxy, iPhone context");
  const fc = await startForgeControlProbe();
  cleanups.push({ what: "forge-control probe stopped", run: () => fc.stop() });
  console.log(`      forge-control probe      → 127.0.0.1:${fc.port}`);
  const frontPort = await findFreePort();
  const publicOrigin = `http://127.0.0.1:${frontPort}`;
  const next = await startNextDev(fc.port, publicOrigin);
  cleanups.push({ what: "next dev killed (process group)", run: () => next.stop() });
  console.log(`      next dev                 → 127.0.0.1:${next.port}`);
  const front = await startFrontProxy(frontPort, next.port, fc.port);
  cleanups.push({ what: "front proxy stopped", run: () => front.stop() });
  console.log(`      front proxy (nginx hop)  → 127.0.0.1:${front.port}`);

  const sessionCookie = await mintSessionCookie();
  const browser = await loadChromium().launch({ executablePath: resolveChromium(), args: ["--no-sandbox"] });
  cleanups.push({ what: "playwright browser closed", run: () => browser.close() });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
  });
  await context.addCookies([
    { name: "authjs.session-token", value: sessionCookie, domain: "127.0.0.1", path: "/", httpOnly: true },
  ]);
  const page = await context.newPage();

  async function shot(label: string): Promise<void> {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const p = path.join(SHOT_DIR, `${stamp()}-${label}.png`);
    await page.screenshot({ path: p });
    shots.push(p);
    console.log(`      screenshot: ${p}`);
  }

  const takeoverUrl = `${publicOrigin}/takeover/${TEST_RUN_ID}`;
  console.log(`      navigating to ${takeoverUrl}`);
  await page.goto(takeoverUrl, { waitUntil: "commit", timeout: 120_000 });
  await waitUntil(
    "the takeover header (ticket minted)",
    async () => ((await page.locator("body").first().textContent()) ?? "").includes(`TAKEOVER · ${TEST_PROFILE}`) || null,
    120_000,
    1_000,
  );
  try {
    await waitForConnected(page, 60_000);
  } catch (err) {
    await shot("text-input-connect-timeout");
    console.error(`      viewer classes: ${JSON.stringify(await viewerClasses(page))}; header: ${JSON.stringify(await statusText(page))}`);
    throw err;
  }
  check("noVNC connected through front proxy → probe upgrade pipe → websockify", true);
  const firstJtis = acceptedJtis();
  check(`probe accepted exactly one ticket so far (jti count ${firstJtis.length})`, firstJtis.length === 1);

  /* (1) layout on a phone */
  section("1. the panel and Send are on screen at 390×844 without scrolling; Send ≥ 44 px");
  const input = page.locator("[data-text-to-vm-input]").first();
  const send = page.locator("[data-text-to-vm-send]").first();
  const inputBox = await input.boundingBox();
  const sendBox = await send.boundingBox();
  const scrollTop = await page.evaluate<number>(() => document.scrollingElement?.scrollTop ?? 0);
  const inside = (b: Box | null): boolean =>
    b !== null && b.x >= 0 && b.y >= 0 && b.x + b.width <= VIEWPORT.width + 0.5 && b.y + b.height <= VIEWPORT.height + 0.5;
  check("textarea bounding box lies inside the 390×844 viewport", inside(inputBox), JSON.stringify(inputBox));
  check("Send bounding box lies inside the 390×844 viewport", inside(sendBox), JSON.stringify(sendBox));
  check(`Send is ≥ 44 px tall (${sendBox?.height ?? "?"} px)`, (sendBox?.height ?? 0) >= 44);
  check("page is not scrolled (scrollTop 0)", scrollTop === 0, String(scrollTop));
  check("panel is shown (not collapsed behind a toggle)", (await page.locator("[data-text-to-vm='shown']").count()) === 1);
  check("Type keys is the default mode", (await page.locator("[data-text-to-vm-mode='type']").count()) === 1);
  await shot("text-input-phone-connected");

  /* focus probe through the real panel, then (2) */
  section("2. Type mode — sentinel typed through the real stack, read back from inside the VM");
  echo.reset();
  await input.fill(PROBE_TEXT);
  await send.tap();
  const probeEcho = await waitForEcho(echo, PROBE_TEXT, 15_000);
  check(
    "focus probe: a short word typed via Send arrives in the VM textarea",
    probeEcho.last === PROBE_TEXT,
    `VM focus is not in the echo textarea (${diffSummary(PROBE_TEXT, probeEcho.last)}, ${probeEcho.count} input events)`,
  );
  if (probeEcho.last !== PROBE_TEXT) {
    await shot("text-input-focus-probe-failed");
    throw new Error("focus probe failed — the VM's keyboard focus is not in the echo textarea; nothing below would measure the panel");
  }
  clearVmTextarea(display);
  await waitForEcho(echo, "", 5_000);
  echo.reset();

  await input.fill(SENTINEL);
  const filled = await input.inputValue();
  check("panel textarea holds the sentinel verbatim after paste (tab and newline intact)", filled === SENTINEL, diffSummary(SENTINEL, filled));
  const expectedEvents = textToKeyEvents(SENTINEL).length;
  await send.tap();
  const typedMsg = await waitUntil(
    "the 'typed N keys' feedback",
    async () => {
      const t = (await page.locator("[data-text-to-vm-feedback]").first().textContent()) ?? "";
      return /typed \d+ keys? into the VM/.test(t) ? t : null;
    },
    30_000,
    100,
  );
  const typedCount = Number.parseInt(typedMsg.match(/typed (\d+)/)?.[1] ?? "-1", 10);
  check(`panel reports 'typed ${expectedEvents} keys into the VM' (counts only, never the text)`, typedCount === expectedEvents, typedMsg);
  const sentinelEcho = await waitForEcho(echo, SENTINEL, 20_000);
  check(
    "the VM textarea holds the sentinel byte-exact — umlauts, ß, €, Tab, newline",
    sentinelEcho.last === SENTINEL,
    diffSummary(SENTINEL, sentinelEcho.last),
  );
  check("panel textarea was cleared after a successful send", (await input.inputValue()) === "");
  await shot("text-input-sentinel-typed");

  /* (3) clipboard mode */
  section("3. Set VM clipboard mode — the X CLIPBOARD on the VM display holds the text");
  await page.locator("[role='radio']:has-text('Set VM clipboard')").first().tap();
  check("mode switched to clipboard", (await page.locator("[data-text-to-vm-mode='clipboard']").count()) === 1);
  await input.fill(CLIP_TEXT);
  await send.tap();
  const clipMsg = await waitUntil(
    "the 'VM clipboard set' feedback",
    async () => {
      const t = (await page.locator("[data-text-to-vm-feedback]").first().textContent()) ?? "";
      return t.includes("VM clipboard set") ? t : null;
    },
    15_000,
    100,
  );
  check(`panel reports 'VM clipboard set (${CLIP_TEXT.length} chars)'`, clipMsg.includes(`(${CLIP_TEXT.length} chars)`), clipMsg);
  const wantHex = Buffer.from(CLIP_TEXT, "latin1").toString("hex");
  let gotHex = "";
  for (let i = 0; i < 20 && gotHex !== wantHex; i++) {
    await sleep(250);
    try {
      gotHex = readVmClipboardHex(display);
    } catch {
      gotHex = "";
    }
  }
  check(
    "xclip -o -selection clipboard on the VM display == the text as Latin-1 bytes",
    gotHex === wantHex,
    `expected ${wantHex.length / 2} bytes, got ${gotHex.length / 2}`,
  );
  await page.locator("[role='radio']:has-text('Type keys')").first().tap();
  await shot("text-input-clipboard-set");

  /* (4) reconnect across a forge-control restart */
  section("4. forge-control restart while connected → reconnecting → connected with a NEW jti");
  const before = acceptedJtis();
  const statusBefore = await statusText(page);
  await fc.restart();
  const reconnecting = await waitUntil(
    "'reconnecting n/5' in the header",
    async () => {
      const t = await statusText(page);
      return /reconnecting \d\/5/.test(t) ? t : null;
    },
    20_000,
    50,
  ).catch(() => "");
  check("header showed 'reconnecting n/5' after the probe reset the socket", /reconnecting \d\/5/.test(reconnecting), `saw: ${reconnecting || "(nothing)"}; before: ${statusBefore}`);
  if (/reconnecting/.test(reconnecting)) await shot("text-input-reconnecting");
  await waitForConnected(page, 60_000);
  const after = acceptedJtis();
  check(`a new ticket was accepted after the restart (${before.length} → ${after.length} accepted)`, after.length > before.length);
  check("every accepted jti is distinct — fresh mints, never a replay", new Set(after).size === after.length, after.join(","));
  check("the first socket's close was logged with its jti", closedJtis().includes(before[0] ?? "-"), closedJtis().join(","));
  check("no 'ticket_replayed' anywhere in the probe output", !captured.join("").includes("ticket_replayed"));
  echo.reset();
  await input.fill(AFTER_RECONNECT_TEXT);
  await send.tap();
  const againEcho = await waitForEcho(echo, SENTINEL + AFTER_RECONNECT_TEXT, 20_000);
  check(
    "typing still works through the NEW iframe (VM textarea = sentinel + the new word)",
    againEcho.last === SENTINEL + AFTER_RECONNECT_TEXT,
    diffSummary(SENTINEL + AFTER_RECONNECT_TEXT, againEcho.last),
  );
  await shot("text-input-reconnected");

  /* (5) session view, Done */
  section("5. session view + header clock; Done twice ends the session");
  const sessionRes = await fetch(`${publicOrigin}/api/proxy/uploads/${TEST_RUN_ID}/takeover/session`, {
    headers: { cookie: `authjs.session-token=${sessionCookie}`, accept: "application/json" },
  });
  const sessionBody = (await sessionRes.json()) as {
    connected_sockets?: number;
    remaining_ms?: number | null;
    supervisor_live?: boolean;
    stack_up?: boolean;
    ended?: unknown;
  };
  check("GET /api/proxy/uploads/<id>/takeover/session is 200", sessionRes.status === 200, String(sessionRes.status));
  check(`connected_sockets = 1 (got ${sessionBody.connected_sockets})`, sessionBody.connected_sockets === 1);
  check(`remaining_ms > 0 (got ${sessionBody.remaining_ms})`, typeof sessionBody.remaining_ms === "number" && sessionBody.remaining_ms > 0);
  check("supervisor_live and stack_up are true, ended is null", sessionBody.supervisor_live === true && sessionBody.stack_up === true && sessionBody.ended === null);
  const clockLine = await waitUntil(
    "'ends in' in the header",
    async () => {
      const t = await statusText(page);
      return t.includes("ends in") ? t : null;
    },
    20_000,
    250,
  ).catch(async () => statusText(page));
  check("header shows 'connected · ends in h:mm:ss'", /^connected · ends in \d+:\d\d:\d\d$/.test(clockLine), clockLine);

  await page.evaluate(() => {
    const w = window as unknown as { __endBody?: unknown; fetch: typeof fetch };
    const orig = w.fetch.bind(window);
    w.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await orig(...args);
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (url.includes("/takeover/end")) {
        w.__endBody = await res.clone().json().catch(() => null);
      }
      return res;
    };
  });
  await page.locator("[data-takeover-done]").first().tap();
  const confirmVisible = await page.locator("[data-takeover-done-confirm]").first().isVisible();
  check("first tap on Done shows the 'End session?' confirm row", confirmVisible);
  await shot("text-input-done-confirm");
  await page.locator("[data-takeover-done-confirm]").first().tap();
  const endedLine = await waitUntil(
    "'Session ended' in the header",
    async () => {
      const t = await statusText(page);
      return t.startsWith("Session ended") ? t : null;
    },
    60_000,
    500,
  ).catch(async () => statusText(page));
  check("header says 'Session ended: …'", endedLine.startsWith("Session ended"), endedLine);
  const endBody = await page.evaluate<{ ended?: unknown; profile?: unknown } | null>(
    () => ((window as unknown as { __endBody?: { ended?: unknown; profile?: unknown } | null }).__endBody ?? null),
  );
  check("POST …/takeover/end answered ended:true for the profile", endBody?.ended === true && endBody?.profile === TEST_PROFILE, JSON.stringify(endBody));
  check("the iframe is gone once the session has ended", (await page.locator(IFRAME).count()) === 0);
  check("Done control now reads 'ended'", (await page.locator("[data-takeover-done-state='done']").count()) === 1);
  const status = researchBrowser<StatusOutput>(["status", TEST_PROFILE], 30_000);
  check("research-browser status: takeover.up is false", status.json.takeover?.up === false, JSON.stringify(status.json.takeover));
  check("research-browser status: no live supervisor, last_shutdown recorded", status.json.session?.live === false && typeof status.json.last_shutdown?.reason === "string", JSON.stringify(status.json.last_shutdown));
  // "Tears down Xvfb/x11vnc/websockify cleanly" means the PORTS are free and no
  // x11vnc for the display survives — not that a SIGTERM was sent. See
  // refuseIfPortsAreHeld() for the measured failure this pins.
  const leftovers = await waitUntil(
    "the VNC and noVNC ports to be free and no x11vnc for the display",
    async () => {
      const held = [listenerOn(vncPort), listenerOn(novncPort)].filter((h): h is { pid: number; cmd: string } => h !== null);
      const procs = x11vncProcessesFor(display);
      return held.length === 0 && procs.length === 0 ? { held, procs } : null;
    },
    15_000,
    500,
  ).catch(() => ({ held: [listenerOn(vncPort), listenerOn(novncPort)].filter((h) => h !== null), procs: x11vncProcessesFor(display) }));
  check(
    `Done freed :${vncPort} and :${novncPort} and left no x11vnc for ${display} within 15 s`,
    leftovers.held.length === 0 && leftovers.procs.length === 0,
    `still held: ${JSON.stringify(leftovers.held)}; x11vnc: ${leftovers.procs.join(" | ") || "none"}`,
  );
  await shot("text-input-session-ended");

  await context.close();
  console.log(`      E2E body took ${Math.round((Date.now() - startedAt) / 1000)} s`);

  /* (6) NO-LOG sweep — after teardown so every log has been flushed */
  section("6. NO-LOG — the typed text is in none of the outputs and logs");
  await runCleanups();
  const nextOut = next.output();
  const ownOut = captured.join("");
  const stateDir = path.join(STATE_ROOT, TEST_PROFILE);
  const logFiles = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((n) => n.endsWith(".log")) : [];
  const needles: Array<[string, string]> = [
    ["sentinel fragment", SENTINEL_FRAGMENT],
    ["clipboard text", CLIP_TEXT],
    ["after-reconnect word inside the sentinel line", SENTINEL + AFTER_RECONNECT_TEXT],
  ];
  for (const [what, needle] of needles) {
    check(`${what}: absent from this process's stdout+stderr (probe + front proxy live here; ${ownOut.length} chars scanned)`, !ownOut.includes(needle));
    check(`${what}: absent from next dev output (${nextOut.length} chars scanned)`, !nextOut.includes(needle));
    for (const name of logFiles) {
      const text = fs.readFileSync(path.join(stateDir, name), "latin1") + fs.readFileSync(path.join(stateDir, name), "utf8");
      check(`${what}: absent from .state/${TEST_PROFILE}/${name}`, !text.includes(needle) && !text.includes(Buffer.from(needle, "utf8").toString("latin1")));
    }
  }
  check(`state logs were actually scanned (${logFiles.length} files: ${logFiles.join(", ")})`, logFiles.length >= 3);

  return shots;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * MAIN
 * ═══════════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log(`=== TAKEOVER TEXT-TO-VM ${BROWSER ? "E2E (--browser)" : "FAST (no browser; pass --browser for the stack)"} ===`);
  fastSections();

  let shots: string[] = [];
  if (BROWSER) {
    try {
      shots = await e2e();
    } finally {
      await runCleanups();
    }
    section("screenshots");
    for (const p of shots) {
      const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
      check(`screenshot exists and is non-empty: ${path.basename(p)} (${size} bytes)`, size > 0);
    }
    // Orphan sweep: a harness that dies mid-turn leaves its next dev behind
    // (memory: clipboard-e2e-harness-was-already-complete).
    const orphans = execFileSync("ps", ["-eo", "pid,ppid,cmd"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(WEB_ROOT) && l.includes("next dev") && !l.includes("grep"));
    check(`no next dev for this worktree left running (${orphans.length})`, orphans.length === 0, orphans.join("\n"));
  }

  if (failures > 0) {
    console.log(`\nFAILED: ${failures} CHECK(S) FAILED (${passes} passed)`);
    process.exit(1);
  }
  console.log(`\nALL PASS — ${passes} checks (${BROWSER ? "fast + browser E2E" : "fast sections only"})`);
  process.exit(0);
}

main().catch(async (err: unknown) => {
  console.error("\nUNCAUGHT EXCEPTION IN HARNESS:");
  console.error(err instanceof Error ? err.stack : String(err));
  await runCleanups();
  process.exit(1);
});
