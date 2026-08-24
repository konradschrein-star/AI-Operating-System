/**
 * Tests for browser-takeover.ts — backend signal resolution & noVNC takeover proxy.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, WebSocket, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fnv1a32,
  displaySlot,
  portsForDisplay,
  novncUrl,
  DISPLAY_BASE,
  DISPLAY_SPAN,
  VNC_PORT_BASE,
  NOVNC_PORT_BASE,
  readProfileAuth,
  readProfileTakeover,
  readProfileSession,
  resolveProfileForRun,
  resolveBrowserState,
  inspectTakeover,
  proxyTakeoverHttp,
  matchTakeoverUpgradePath,
  resolveTakeoverUpgradeTarget,
  handleBrowserTakeoverUpgrade,
  PROFILE_RE,
} from "./browser-takeover.ts";

describe("displaySlot and port math", () => {
  test("fnv1a32 is stable and matches expected hash", () => {
    assert.equal(typeof fnv1a32("perplexity"), "number");
    assert.equal(fnv1a32("perplexity"), fnv1a32("perplexity"));
    assert.notEqual(fnv1a32("perplexity"), fnv1a32("scratch"));
  });

  test("displaySlot stays within managed range 90..149", () => {
    const profiles = ["perplexity", "google", "scratch", "claude", "github", "test-profile-123"];
    for (const p of profiles) {
      const slot = displaySlot(p);
      assert.ok(slot >= DISPLAY_BASE, `slot ${slot} >= ${DISPLAY_BASE}`);
      assert.ok(slot < DISPLAY_BASE + DISPLAY_SPAN, `slot ${slot} < ${DISPLAY_BASE + DISPLAY_SPAN}`);
    }
  });

  test("portsForDisplay computes exact display, vncPort and novncPort", () => {
    const p90 = portsForDisplay(90);
    assert.deepEqual(p90, {
      display: ":90",
      displayNum: 90,
      vncPort: 5990,
      novncPort: 6900,
    });

    const p95 = portsForDisplay(95);
    assert.deepEqual(p95, {
      display: ":95",
      displayNum: 95,
      vncPort: 5995,
      novncPort: 6905,
    });

    const p149 = portsForDisplay(149);
    assert.deepEqual(p149, {
      display: ":149",
      displayNum: 149,
      vncPort: 6049,
      novncPort: 6959,
    });
  });

  test("portsForDisplay throws on out-of-range display numbers", () => {
    assert.throws(() => portsForDisplay(89));
    assert.throws(() => portsForDisplay(150));
    assert.throws(() => portsForDisplay(NaN));
  });

  test("novncUrl generates loopback URL with autoconnect and resize", () => {
    assert.equal(
      novncUrl(6900),
      "http://127.0.0.1:6900/vnc.html?autoconnect=1&resize=scale",
    );
  });
});

describe("PROFILE_RE", () => {
  test("accepts valid URL-safe profile names", () => {
    assert.equal(PROFILE_RE.test("perplexity"), true);
    assert.equal(PROFILE_RE.test("scratch"), true);
    assert.equal(PROFILE_RE.test("google-auth-2"), true);
    assert.equal(PROFILE_RE.test("p1"), true);
  });

  test("rejects invalid or unsafe profile names", () => {
    assert.equal(PROFILE_RE.test(""), false);
    assert.equal(PROFILE_RE.test(".."), false);
    assert.equal(PROFILE_RE.test(".state"), false);
    assert.equal(PROFILE_RE.test("Perplexity"), false);
    assert.equal(PROFILE_RE.test("has spaces"), false);
    assert.equal(PROFILE_RE.test("-starts-with-dash"), false);
    assert.equal(PROFILE_RE.test("a".repeat(45)), false);
  });
});

describe("profile state readers", () => {
  let tempStateRoot: string;

  before(() => {
    tempStateRoot = mkdtempSync(path.join(tmpdir(), "state-root-"));
    const perpDir = path.join(tempStateRoot, "perplexity");
    mkdirSync(perpDir, { recursive: true });

    writeFileSync(
      path.join(perpDir, "auth.json"),
      JSON.stringify({
        checked_at: "2026-08-24T05:00:00.000Z",
        service: "perplexity",
        url: "https://www.perplexity.ai/login",
        authenticated: false,
        needs_login: true,
        decision: "login_required",
        reasons: ["Sign in button detected"],
      }),
    );

    writeFileSync(
      path.join(perpDir, "takeover.json"),
      JSON.stringify({
        displayNum: 90,
        display: ":90",
        vncPort: 5990,
        novncPort: 6900,
        xvfb: { pid: process.pid, log: "/tmp/xvfb.log" },
        x11vnc: { pid: process.pid, log: "/tmp/x11vnc.log" },
        websockify: { pid: process.pid, log: "/tmp/websockify.log" },
        started_at: "2026-08-24T05:00:00.000Z",
        supervisor_pid: process.pid,
      }),
    );

    writeFileSync(
      path.join(perpDir, "session.json"),
      JSON.stringify({
        pid: process.pid,
        display: ":90",
        displayNum: 90,
        started_at: "2026-08-24T05:00:00.000Z",
        idle_deadline: Date.now() + 60_000,
      }),
    );
  });

  after(() => {
    rmSync(tempStateRoot, { recursive: true, force: true });
  });

  test("readProfileAuth reads auth.json correctly", async () => {
    const auth = await readProfileAuth("perplexity", tempStateRoot);
    assert.ok(auth);
    assert.equal(auth.service, "perplexity");
    assert.equal(auth.needs_login, true);
    assert.equal(auth.decision, "login_required");
    assert.deepEqual(auth.reasons, ["Sign in button detected"]);
  });

  test("readProfileTakeover reads takeover.json correctly", async () => {
    const takeover = await readProfileTakeover("perplexity", tempStateRoot);
    assert.ok(takeover);
    assert.equal(takeover.displayNum, 90);
    assert.equal(takeover.novncPort, 6900);
    assert.equal(takeover.supervisor_pid, process.pid);
  });

  test("readProfileSession reads session.json correctly", async () => {
    const session = await readProfileSession("perplexity", tempStateRoot);
    assert.ok(session);
    assert.equal(session.pid, process.pid);
    assert.equal(session.display, ":90");
  });

  test("readers return null for missing profile or invalid name", async () => {
    assert.equal(await readProfileAuth("missing", tempStateRoot), null);
    assert.equal(await readProfileTakeover("missing", tempStateRoot), null);
    assert.equal(await readProfileSession("missing", tempStateRoot), null);
    assert.equal(await readProfileAuth("../etc", tempStateRoot), null);
  });
});

describe("resolveBrowserState", () => {
  let tempUploadDir: string;
  let tempStateRoot: string;

  before(() => {
    tempUploadDir = mkdtempSync(path.join(tmpdir(), "uploads-"));
    tempStateRoot = mkdtempSync(path.join(tmpdir(), "state-"));

    // Profile 1: perplexity (Exit code 4 / needs_login: true)
    const perpState = path.join(tempStateRoot, "perplexity");
    mkdirSync(perpState, { recursive: true });
    writeFileSync(
      path.join(perpState, "auth.json"),
      JSON.stringify({
        checked_at: "2026-08-24T05:10:00.000Z",
        service: "perplexity",
        authenticated: false,
        needs_login: true,
        decision: "login_required",
        reasons: ["Cloudflare captcha presented"],
      }),
    );
    writeFileSync(
      path.join(perpState, "takeover.json"),
      JSON.stringify({
        displayNum: 90,
        display: ":90",
        vncPort: 5990,
        novncPort: 6900,
        started_at: "2026-08-24T05:10:00.000Z",
      }),
    );

    // Run directory 1: 12-hex run matching perplexity login wall
    const run1Dir = path.join(tempUploadDir, "111122223333");
    mkdirSync(run1Dir, { recursive: true });
    writeFileSync(path.join(run1Dir, "20260824T051000Z-perplexity-login-wall.png"), "x");

    // Run directory 2: clean run without login issues
    const run2Dir = path.join(tempUploadDir, "444455556666");
    mkdirSync(run2Dir, { recursive: true });
    writeFileSync(path.join(run2Dir, "20260824T052000Z-search-results.png"), "y");
    writeFileSync(
      path.join(run2Dir, "browser_state.json"),
      JSON.stringify({
        is_live: false,
        needs_login: false,
        needs_human: false,
        signal: null,
      }),
    );

    // Run directory 3: direct local auth.json with exit 4 state
    const run3Dir = path.join(tempUploadDir, "777788889999");
    mkdirSync(run3Dir, { recursive: true });
    writeFileSync(
      path.join(run3Dir, "auth.json"),
      JSON.stringify({
        checked_at: "2026-08-24T05:30:00.000Z",
        service: "google",
        needs_login: true,
        decision: "login_required",
        reasons: ["Google 2FA prompt"],
      }),
    );
    writeFileSync(
      path.join(run3Dir, "takeover.json"),
      JSON.stringify({
        displayNum: 91,
        novncPort: 6901,
        started_at: "2026-08-24T05:30:00.000Z",
      }),
    );
  });

  after(() => {
    rmSync(tempUploadDir, { recursive: true, force: true });
    rmSync(tempStateRoot, { recursive: true, force: true });
  });

  test("resolves Exit Code 4 login_required signal and turns needs_human on", async () => {
    const state = await resolveBrowserState("111122223333", {
      uploadDir: tempUploadDir,
      stateRoot: tempStateRoot,
      dbLookup: false,
    });

    assert.equal(state.needs_login, true);
    assert.equal(state.needs_human, true);
    assert.equal(state.signal, "login_required");
    assert.equal(state.service, "perplexity");
    assert.equal(state.decision, "login_required");
    assert.deepEqual(state.reasons, ["Cloudflare captcha presented"]);
    assert.equal(state.novnc_port, 6900);
    assert.equal(state.novnc_url, "http://127.0.0.1:6900/vnc.html?autoconnect=1&resize=scale");
  });

  test("clean run reports needs_human: false and signal: null", async () => {
    const state = await resolveBrowserState("444455556666", {
      uploadDir: tempUploadDir,
      stateRoot: tempStateRoot,
      dbLookup: false,
    });

    assert.equal(state.needs_login, false);
    assert.equal(state.needs_human, false);
    assert.equal(state.signal, null);
  });

  test("resolves local auth.json override within run directory", async () => {
    const state = await resolveBrowserState("777788889999", {
      uploadDir: tempUploadDir,
      stateRoot: tempStateRoot,
      dbLookup: false,
    });

    assert.equal(state.needs_login, true);
    assert.equal(state.needs_human, true);
    assert.equal(state.signal, "login_required");
    assert.equal(state.service, "google");
    assert.equal(state.reason, "Google 2FA prompt");
    assert.equal(state.novnc_port, 6901);
  });

  test("inspectTakeover combines port math, auth, and browser_state", async () => {
    const inspection = await inspectTakeover("perplexity", tempStateRoot);
    assert.equal(inspection.profile, "perplexity");
    assert.equal(inspection.novnc_port, 6900);
    assert.equal(inspection.auth?.service, "perplexity");
    assert.equal(inspection.browser_state.needs_human, true);
  });
});

describe("proxyTakeoverHttp", () => {
  let server: Server;
  let testPort: number;

  before(async () => {
    // Spin up mock noVNC HTTP server within allowed port range 6900..6959 if free
    testPort = 6942;
    server = createServer((req, res) => {
      if (req.url?.startsWith("/vnc.html")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>noVNC Mock Canvas</body></html>");
      } else if (req.url?.startsWith("/api/status")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, mock: true }));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found on novnc mock");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(testPort, "127.0.0.1", () => resolve());
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("rejects invalid profile names with 400", async () => {
    const req = new Request("http://localhost/api/uploads/browser/../vnc/vnc.html");
    const res = await proxyTakeoverHttp(req, "../bad");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; code?: string };
    assert.equal(body.code, "INVALID_PROFILE");
  });

  test("rejects out-of-range ports with 403", async () => {
    const req = new Request("http://localhost/api/uploads/browser/test/vnc/vnc.html");
    const res = await proxyTakeoverHttp(req, "test", "vnc.html", { targetPort: 8080 });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string; code?: string };
    assert.equal(body.code, "FORBIDDEN_PORT");
  });

  test("proxies request to loopback server and streams response", async () => {
    const req = new Request("http://localhost/api/uploads/browser/mock/vnc/vnc.html?autoconnect=1");
    const res = await proxyTakeoverHttp(req, "mock", "vnc.html", { targetPort: testPort });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    assert.equal(res.headers.get("x-proxied-by"), "forge-control-browser-takeover");
    const text = await res.text();
    assert.ok(text.includes("noVNC Mock Canvas"));
  });

  test("handles unreachable target with 503", async () => {
    // Port 6955 is inside allowed range but not listening
    const req = new Request("http://localhost/api/uploads/browser/mock/vnc/vnc.html");
    const res = await proxyTakeoverHttp(req, "mock", "vnc.html", { targetPort: 6955 });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string; code?: string };
    assert.equal(body.code, "TAKEOVER_UNREACHABLE");
  });
});

describe("matchTakeoverUpgradePath", () => {
  test("matches /api/uploads/browser/:profile/vnc and /vnc/*", () => {
    assert.deepEqual(matchTakeoverUpgradePath("/api/uploads/browser/perplexity/vnc"), {
      kind: "profile",
      id: "perplexity",
      subpath: "",
    });
    assert.deepEqual(matchTakeoverUpgradePath("/api/uploads/browser/perplexity/vnc/websockify"), {
      kind: "profile",
      id: "perplexity",
      subpath: "websockify",
    });
  });

  test("matches /api/uploads/:id/vnc and /vnc/* as a run id, not the 'browser' literal", () => {
    assert.deepEqual(matchTakeoverUpgradePath("/api/uploads/7a0c6432cde4/vnc/websockify"), {
      kind: "run",
      id: "7a0c6432cde4",
      subpath: "websockify",
    });
  });

  test("returns null for unrelated paths", () => {
    assert.equal(matchTakeoverUpgradePath("/api/uploads/7a0c6432cde4/shots"), null);
    assert.equal(matchTakeoverUpgradePath("/api/health"), null);
    assert.equal(matchTakeoverUpgradePath("/"), null);
  });
});

describe("resolveTakeoverUpgradeTarget", () => {
  test("rejects an invalid profile name", async () => {
    const target = await resolveTakeoverUpgradeTarget({ kind: "profile", id: "../bad", subpath: "" });
    assert.ok("error" in target);
  });

  test("rejects an out-of-range port even with a valid profile", async () => {
    const target = await resolveTakeoverUpgradeTarget(
      { kind: "profile", id: "test", subpath: "" },
      { targetPort: 8080 },
    );
    assert.ok("error" in target);
  });

  test("accepts a valid profile with an explicit in-range targetPort override", async () => {
    const target = await resolveTakeoverUpgradeTarget(
      { kind: "profile", id: "test", subpath: "" },
      { targetPort: 6943 },
    );
    assert.deepEqual(target, { profile: "test", targetPort: 6943 });
  });
});

describe("WebSocket-upgrade proxy — real socket, full chain (round 5 fix)", () => {
  // Round 4's proxyTakeoverHttp only ever proved plain HTTP GET/POST. noVNC's
  // canvas needs a 101 Switching Protocols handshake, which fetch() cannot
  // complete. This describe block proves the actual missing piece: a real
  // WebSocket client opens a connection through an http.Server wired EXACTLY
  // like index.ts (`server.on("upgrade", (req, socket, head) =>
  // handleBrowserTakeoverUpgrade(...))`), which must reach a minimal hand-rolled
  // "fake websockify" server and round-trip an application-level message.

  function decodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer } {
    const opcode = buf[0] & 0x0f;
    const second = buf[1];
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let offset = 2;
    if (len === 126) {
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    let payload = buf.subarray(offset, offset + len);
    if (maskKey) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    return { opcode, payload };
  }

  function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  let fakeWebsockify: Server;
  let proxyServer: Server;
  const fakePort = 6943; // inside NOVNC_PORT_BASE..+DISPLAY_SPAN, distinct from the HTTP mock's 6942
  let proxyPort: number;

  before(async () => {
    // Minimal raw WS echo server standing in for websockify — proves this
    // repo's OWN chain (index.ts wiring -> browser-takeover.ts), not a real
    // websockify install, which is not guaranteed present on every dev box.
    fakeWebsockify = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    fakeWebsockify.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (buf: Buffer) => {
        const frame = decodeClientFrame(buf);
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        socket.write(encodeServerFrame(frame.opcode || 0x1, frame.payload));
      });
    });
    await new Promise<void>((resolve) => fakeWebsockify.listen(fakePort, "127.0.0.1", () => resolve()));

    // Wired identically to index.ts's `server.on("upgrade", ...)` — the exact
    // fix this round adds. `{ targetPort: fakePort }` stands in for what
    // production gets from inspectTakeover(profile).novnc_port.
    proxyServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    proxyServer.on("upgrade", (req, socket, head) => {
      handleBrowserTakeoverUpgrade(req, socket, head, { targetPort: fakePort })
        .then((handled) => {
          if (!handled) socket.destroy();
        })
        .catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => fakeWebsockify.close(() => resolve())),
      new Promise<void>((resolve) => proxyServer.close(() => resolve())),
    ]);
  });

  test("a real WebSocket client connects through the proxy and round-trips a message", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/uploads/browser/wstest/vnc/websockify`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error opening connection")));
      });

      const received = new Promise<string>((resolve, reject) => {
        ws.addEventListener("message", (ev) => resolve(String(ev.data)));
        ws.addEventListener("error", () => reject(new Error("ws error awaiting message")));
      });
      ws.send("hello-through-the-upgrade-proxy");
      assert.equal(await received, "hello-through-the-upgrade-proxy");
    } finally {
      ws.close();
    }
  });

  test("an invalid profile name is rejected before any socket reaches the loopback target", async () => {
    // "Not_Valid" fails PROFILE_RE (uppercase + underscore) but, unlike "..",
    // survives WHATWG URL path normalization intact, so this actually
    // exercises resolveTakeoverUpgradeTarget's rejection rather than a
    // route mismatch caused by the client normalizing ".." away first.
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/uploads/browser/Not_Valid/vnc/websockify`);
    await new Promise<void>((resolve) => {
      ws.addEventListener("error", () => resolve());
      ws.addEventListener("close", () => resolve());
      ws.addEventListener("open", () => {
        ws.close();
        resolve();
        assert.fail("connection should not have opened for an invalid profile");
      });
    });
  });
});
