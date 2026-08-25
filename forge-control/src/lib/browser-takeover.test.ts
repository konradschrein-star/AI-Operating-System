/**
 * Tests for browser-takeover.ts — backend signal resolution & noVNC takeover proxy.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, WebSocket, type Server } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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
  isTakeoverUpgradeRejection,
  consumeTakeoverTicketJti,
  clearSpentTakeoverTicketJtis,
  handleBrowserTakeoverUpgrade,
  PROFILE_RE,
} from "./browser-takeover.ts";
import { mintTakeoverTicket } from "./takeover-ticket.ts";
import uploadsRoutes from "../routes/uploads.ts";

/**
 * The takeover gate is now ticket-only, so every upgrade test needs a signing
 * secret. It is set here rather than taken from the host: a box that happens to
 * export TAKEOVER_TICKET_SECRET must not be able to make these pass or fail.
 */
const TEST_SECRET = "browser-takeover-test-secret-0123456789";
const originalSecret = process.env.TAKEOVER_TICKET_SECRET;
process.env.TAKEOVER_TICKET_SECRET = TEST_SECRET;
process.on("exit", () => {
  if (originalSecret === undefined) delete process.env.TAKEOVER_TICKET_SECRET;
  else process.env.TAKEOVER_TICKET_SECRET = originalSecret;
});

/** Builds the one URL path the upgrade listener answers on. */
function wsPath(ticket: string): string {
  return `/api/browser-takeover/ws/${ticket}`;
}

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
  test("matches the one ticket route and carries the ticket through", () => {
    assert.deepEqual(matchTakeoverUpgradePath("/api/browser-takeover/ws/abc.def"), {
      kind: "ticket",
      ticket: "abc.def",
    });
    assert.deepEqual(matchTakeoverUpgradePath("/api/browser-takeover/ws/abc.def/"), {
      kind: "ticket",
      ticket: "abc.def",
    });
  });

  test("the deleted unauthenticated arms no longer match anything", () => {
    // These two paths used to open a socket on a bare, guessable id. If either
    // ever matches again, a run id is a credential for a logged-in Chrome.
    assert.equal(matchTakeoverUpgradePath("/api/uploads/browser/perplexity/vnc"), null);
    assert.equal(matchTakeoverUpgradePath("/api/uploads/browser/perplexity/vnc/websockify"), null);
    assert.equal(matchTakeoverUpgradePath("/api/uploads/7a0c6432cde4/vnc"), null);
    assert.equal(matchTakeoverUpgradePath("/api/uploads/7a0c6432cde4/vnc/websockify"), null);
  });

  test("returns null for unrelated paths and for a ticket route with extra segments", () => {
    assert.equal(matchTakeoverUpgradePath("/api/uploads/7a0c6432cde4/shots"), null);
    assert.equal(matchTakeoverUpgradePath("/api/health"), null);
    assert.equal(matchTakeoverUpgradePath("/"), null);
    assert.equal(matchTakeoverUpgradePath("/api/browser-takeover/ws"), null);
    assert.equal(matchTakeoverUpgradePath("/api/browser-takeover/ws/"), null);
    assert.equal(matchTakeoverUpgradePath("/api/browser-takeover/ws/tkt/websockify"), null);
  });

  /**
   * Round-4 review, suggestion S1: the suite asserted what the route DOES but
   * never what it IS, so widening the regex to a second arm
   * (`/api/browser-takeover/(?:ws|run)/…`) left all 76 tests green. The alias
   * would still demand a ticket, so it was never a hole — but the nginx
   * location is a PREFIX match whose comment reads "NOTHING ELSE MAY EVER BE
   * MOUNTED HERE", and an invariant no test can break is a claim, not a
   * guarantee. This pins the shape: one literal segment `ws`, then exactly one
   * more segment, and nothing else in the whole namespace answers.
   */
  test("the route SHAPE is /api/browser-takeover/ws/<one-segment> and nothing else", () => {
    for (const alias of [
      "/api/browser-takeover/run/abc.def",
      "/api/browser-takeover/socket/abc.def",
      "/api/browser-takeover/vnc/abc.def",
      "/api/browser-takeover/abc.def",
      "/api/browser-takeover/wss/abc.def",
      "/api/browser-takeover/ws2/abc.def",
      "/api/browser-takeoverx/ws/abc.def",
      "/browser-takeover/ws/abc.def",
      "/api/browser-takeover/ws/a/b",
    ]) {
      assert.equal(
        matchTakeoverUpgradePath(alias),
        null,
        `${alias} must NOT be an upgrade route — the nginx location is a prefix match`,
      );
    }
    // …and the one real shape still works, so this is not vacuously strict.
    assert.deepEqual(matchTakeoverUpgradePath("/api/browser-takeover/ws/abc.def"), {
      kind: "ticket",
      ticket: "abc.def",
    });
  });
});

/**
 * resolveProfileForRun — WHICH BROWSER a run's ticket gets signed for.
 *
 * This function had no test at all until round 5; it was imported by this file
 * and never called, which is how round-4 review finding 3 survived: screenshot
 * NAME inference ran ahead of the marker the driver deliberately writes, so a
 * run whose marker said `os-ui` resolved to `perplexity` because a file called
 * `<ts>-perplexity-open.png` happened to sit in its uploads dir. The mint
 * endpoint then signed a ticket for the wrong logged-in Chrome.
 */
describe("resolveProfileForRun — marker beats filename", () => {
  let uploadDir: string;
  let stateRoot: string;

  const runDir = (runId: string) => path.join(uploadDir, runId);
  const writeMarker = (runId: string, profile: string, body: Record<string, unknown>) => {
    const dir = path.join(runDir(runId), "browser-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${profile}.json`), JSON.stringify(body));
  };

  before(() => {
    uploadDir = mkdtempSync(path.join(tmpdir(), "takeover-uploads-"));
    stateRoot = mkdtempSync(path.join(tmpdir(), "takeover-state-"));
    // Both profiles have live state dirs — the ONLY thing separating them is
    // which piece of evidence the resolver believes.
    for (const p of ["perplexity", "os-ui", "r704-loginwall"]) {
      mkdirSync(path.join(stateRoot, p), { recursive: true });
    }
  });

  after(() => {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test("finding 3, reproduced: a stray perplexity screenshot does NOT outrank the marker", async () => {
    const runId = "2ce31fa484df";
    mkdirSync(runDir(runId), { recursive: true });
    // The exact shape measured live on 2026-08-25.
    writeFileSync(path.join(runDir(runId), "20260825T005232Z-perplexity-open.png"), "not-a-png");
    writeMarker(runId, "os-ui", {
      profile: "os-ui",
      service: "os-ui",
      checked_at: "2026-08-25T00:52:00.000Z",
    });

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), "os-ui");
  });

  test("the legacy single-file marker also outranks the screenshot name", async () => {
    const runId = "aaaabbbbcccc";
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(path.join(runDir(runId), "20260825T010000Z-perplexity-open.png"), "not-a-png");
    writeFileSync(
      path.join(runDir(runId), "browser_state.json"),
      JSON.stringify({ profile: "os-ui", service: "os-ui" }),
    );

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), "os-ui");
  });

  test("two profiles in one run: the NEWEST checked_at wins, not the last writer", async () => {
    const runId = "1111222233ff";
    mkdirSync(runDir(runId), { recursive: true });
    // Written in the order os-ui → perplexity, but os-ui carries the later clock.
    writeMarker(runId, "os-ui", { profile: "os-ui", checked_at: "2026-08-25T02:00:00.000Z" });
    writeMarker(runId, "perplexity", {
      profile: "perplexity",
      checked_at: "2026-08-25T01:00:00.000Z",
    });

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), "os-ui");

    // …and the older one is still on disk, which is the whole point of keying
    // the marker by run AND profile: a second takeover ADDS a file.
    writeMarker(runId, "perplexity", {
      profile: "perplexity",
      checked_at: "2026-08-25T03:00:00.000Z",
    });
    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), "perplexity");
  });

  test("a marker whose body names a different profile than its filename is discarded", async () => {
    const runId = "dddd4444eeee";
    mkdirSync(runDir(runId), { recursive: true });
    // Filename says os-ui, body says perplexity. Neither answer is trustworthy,
    // so the resolver must fall through rather than pick one.
    writeMarker(runId, "os-ui", { profile: "perplexity", checked_at: "2026-08-25T02:00:00.000Z" });

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), null);
  });

  test("a marker filename that is not a valid profile name is ignored", async () => {
    const runId = "9999888877ff";
    const dir = path.join(runDir(runId), "browser-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "Perplexity.json"), // capital P — PROFILE_RE rejects it
      JSON.stringify({ profile: "Perplexity", checked_at: "2026-08-25T02:00:00.000Z" }),
    );
    writeFileSync(path.join(dir, "not-json.txt"), "perplexity");

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), null);
  });

  test("auth.json still resolves when there is no marker of either kind", async () => {
    const runId = "5555666677ee";
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(
      path.join(runDir(runId), "auth.json"),
      JSON.stringify({ service: "r704-loginwall", needs_login: true }),
    );

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), "r704-loginwall");
  });

  test("screenshot-name inference still works — as the LAST resort, with no marker present", async () => {
    const runId = "abcdefabcdef";
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(path.join(runDir(runId), "20260825T010000Z-perplexity-login-wall.png"), "x");

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), "perplexity");
  });

  test("a screenshot naming a profile with no state dir resolves to nothing", async () => {
    const runId = "0f0f0f0f0f0f";
    mkdirSync(runDir(runId), { recursive: true });
    writeFileSync(path.join(runDir(runId), "20260825T010000Z-nosuchprofile-open.png"), "x");

    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), null);
  });

  test("an empty run dir resolves to nothing at all", async () => {
    const runId = "c0ffeec0ffee";
    mkdirSync(runDir(runId), { recursive: true });
    assert.equal(await resolveProfileForRun(runId, { uploadDir, stateRoot }), null);
  });
});

describe("consumeTakeoverTicketJti — the replay store", () => {
  test("a jti can be spent once and not twice", () => {
    clearSpentTakeoverTicketJtis();
    const exp = Date.now() + 60_000;
    assert.equal(consumeTakeoverTicketJti("jti-one", exp), true);
    assert.equal(consumeTakeoverTicketJti("jti-one", exp), false);
    assert.equal(consumeTakeoverTicketJti("jti-two", exp), true);
  });

  test("entries are swept once their own expiry passes", () => {
    clearSpentTakeoverTicketJtis();
    const shortExp = Date.now() + 1_000;
    assert.equal(consumeTakeoverTicketJti("jti-sweep", shortExp), true);
    // Same jti, evaluated after that expiry: the entry is swept, so it is
    // spendable again. (Verify would already have rejected the ticket itself
    // as expired — this only proves the store does not grow forever.)
    assert.equal(consumeTakeoverTicketJti("jti-sweep", shortExp, shortExp + 1), true);
    clearSpentTakeoverTicketJtis();
  });
});

describe("resolveTakeoverUpgradeTarget — the ticket is the only input", () => {
  test("a valid ticket yields the profile and port from the SIGNED payload", () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "r704-loginwall", port: 6943 });
    const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket });

    assert.ok(!isTakeoverUpgradeRejection(target), `expected a target, got ${JSON.stringify(target)}`);
    assert.equal(target.profile, "r704-loginwall");
    assert.equal(target.targetPort, 6943);
    assert.equal(target.runId, "run-abc");
  });

  test("the same ticket presented twice is refused as a replay", () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6943 });

    const first = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket });
    assert.ok(!isTakeoverUpgradeRejection(first), "the first presentation must succeed");

    const second = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket });
    assert.ok(isTakeoverUpgradeRejection(second), "the second presentation must be refused");
    assert.equal(second.reason, "ticket_replayed");
    assert.equal(second.status, 401);
  });

  test("an expired ticket is refused with 401", () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({
      runId: "run-abc",
      profile: "scratch",
      port: 6943,
      ttlMs: 1,
    });
    // Hand-roll the wait: node:test has no clock control here, and 1ms is real.
    const deadline = Date.now() + 5;
    while (Date.now() < deadline) {
      /* spin */
    }
    const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket });
    assert.ok(isTakeoverUpgradeRejection(target));
    assert.equal(target.reason, "ticket_expired");
    assert.equal(target.status, 401);
  });

  test("a tampered signature is refused with 401 and the payload is never read", () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6943 });
    const [payload, signature] = ticket.split(".");
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);

    const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: `${payload}.${flipped}` });
    assert.ok(isTakeoverUpgradeRejection(target));
    assert.equal(target.reason, "ticket_bad_signature");
    assert.equal(target.status, 401);
    assert.equal(target.profile, undefined, "an unverified payload must not name a profile");
    assert.equal(target.port, undefined, "an unverified payload must not name a port");
  });

  test("a tampered payload cannot re-point the socket at another port", () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6943 });
    const [payloadB64, signature] = ticket.split(".");
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims.port = 7700; // aim it at forge-control itself
    const forged = `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`;

    const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: forged });
    assert.ok(isTakeoverUpgradeRejection(target));
    assert.equal(target.reason, "ticket_bad_signature");
  });

  test("garbage and an empty ticket are refused, never thrown", () => {
    clearSpentTakeoverTicketJtis();
    for (const ticket of ["", "not-a-ticket", "a.b.c", "%%%.%%%", "../../etc/passwd"]) {
      const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket });
      assert.ok(isTakeoverUpgradeRejection(target), `ticket ${JSON.stringify(ticket)} must be refused`);
      assert.equal(target.status, 401);
    }
  });

  test("a missing signing secret fails closed with 503, never open", () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6943 });
    delete process.env.TAKEOVER_TICKET_SECRET;
    try {
      const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket });
      assert.ok(isTakeoverUpgradeRejection(target));
      assert.equal(target.status, 503);
      assert.equal(target.reason, "ticket_secret_unavailable");
    } finally {
      process.env.TAKEOVER_TICKET_SECRET = TEST_SECRET;
    }
  });
});

describe("uploads route ordering — /vnc/ticket is not swallowed by /vnc/*", () => {
  // Lives in this file rather than a new uploads test because the declared
  // write-set for this round is browser-takeover.ts, its test, and uploads.ts.
  //
  // The trap: Hono matches in registration order, so `r.all("/:id/vnc/*")` —
  // registered since round 4 — will proxy "ticket" to websockify as a filename
  // unless the mint route is registered above it. Asserting on the RESPONSE
  // proves the ordering; asserting that the code contains a route would not.

  test("GET /browser/:profile/vnc/ticket mints instead of proxying to noVNC", async () => {
    clearSpentTakeoverTicketJtis();
    const res = await uploadsRoutes.request("/browser/scratch/vnc/ticket");
    assert.equal(res.status, 200, `expected a minted ticket, got ${res.status}`);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = (await res.json()) as {
      ticket: string;
      expires_at: string;
      ws_path: string;
      novnc_port: number;
    };
    assert.match(body.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(body.ws_path, `api/browser-takeover/ws/${body.ticket}`);
    assert.ok(!body.ws_path.startsWith("/"), "ws_path must have no leading slash");
    assert.ok(
      body.novnc_port >= NOVNC_PORT_BASE && body.novnc_port < NOVNC_PORT_BASE + DISPLAY_SPAN,
      `novnc_port ${body.novnc_port} must be inside the loopback allowlist`,
    );
    assert.ok(Date.parse(body.expires_at) > Date.now(), "expires_at must be in the future");

    // And the ticket it handed out actually opens the gate.
    const target = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: body.ticket });
    assert.ok(!isTakeoverUpgradeRejection(target), `minted ticket must verify: ${JSON.stringify(target)}`);
    assert.equal(target.profile, "scratch");
    assert.equal(target.targetPort, body.novnc_port);
  });

  test("GET /:id/vnc/ticket 404s for a run with no profile, rather than 400 from the catch-all", async () => {
    // A well-formed 12-hex id that owns no upload directory: the mint route was
    // reached (it resolved the profile and found none) rather than the catch-all.
    const res = await uploadsRoutes.request("/aaaabbbbcccc/vnc/ticket");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /No browser profile found for run aaaabbbbcccc/);
  });

  test("a bad run id is rejected before any profile lookup", async () => {
    const res = await uploadsRoutes.request("/NOT-AN-ID/vnc/ticket");
    assert.equal(res.status, 400);
  });

  test("the mint route answers 503 when the signing secret is missing", async () => {
    delete process.env.TAKEOVER_TICKET_SECRET;
    try {
      const res = await uploadsRoutes.request("/browser/scratch/vnc/ticket");
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /TAKEOVER_TICKET_SECRET/);
      assert.ok(!("ticket" in body), "a 503 must not carry an unsigned ticket");
    } finally {
      process.env.TAKEOVER_TICKET_SECRET = TEST_SECRET;
    }
  });
});

describe("WebSocket-upgrade proxy — real socket, ticket-gated, full chain", () => {
  // Round 4's proxyTakeoverHttp only ever proved plain HTTP GET/POST. noVNC's
  // canvas needs a 101 Switching Protocols handshake, which fetch() cannot
  // complete. This describe block proves the actual missing piece: a real
  // WebSocket client opens a connection through an http.Server wired EXACTLY
  // like index.ts (`server.on("upgrade", (req, socket, head) =>
  // handleBrowserTakeoverUpgrade(...))`), which must reach a minimal hand-rolled
  // "fake websockify" server and round-trip an application-level message.
  //
  // This round adds the gate: every one of those sockets must now present a
  // valid, unspent, unexpired ticket. The negative cases below are the point —
  // a takeover route that cannot be shown to REJECT is not secured.

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

  /**
   * Every socket either server accepts, so teardown can destroy them.
   *
   * `server.close()` waits for open connections. These tests deliberately
   * abandon upgraded sockets mid-flight (that is what a refused or replayed
   * takeover looks like), which leaves the upstream half of the pipe dangling
   * and makes close() never call back — the test process then hangs after the
   * last assertion has already passed. Measured: without this, the file ran
   * green and never exited.
   */
  const openSockets = new Set<Duplex>();
  function trackSockets(server: Server): void {
    server.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });
  }

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
    trackSockets(fakeWebsockify);
    await new Promise<void>((resolve) => fakeWebsockify.listen(fakePort, "127.0.0.1", () => resolve()));

    // Wired identically to index.ts's `server.on("upgrade", ...)`, with NO
    // options argument — exactly as index.ts calls it. The target port can
    // therefore only come from the signed ticket, which is the property under
    // test; `fakePort` is baked into the tickets these tests mint.
    proxyServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    proxyServer.on("upgrade", (req, socket, head) => {
      handleBrowserTakeoverUpgrade(req, socket, head)
        .then((handled) => {
          if (!handled) socket.destroy();
        })
        .catch(() => socket.destroy());
    });
    trackSockets(proxyServer);
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  after(async () => {
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    await Promise.all([
      new Promise<void>((resolve) => fakeWebsockify.close(() => resolve())),
      new Promise<void>((resolve) => proxyServer.close(() => resolve())),
    ]);
  });

  /**
   * Attempts a raw upgrade and reports what actually came back. A WebSocket
   * client only surfaces "error" or "close" for a refusal, which cannot tell
   * 401 apart from a destroyed socket — and the difference is exactly what
   * these tests are here to pin.
   */
  function attemptUpgrade(
    urlPath: string,
  ): Promise<{ upgraded: true } | { upgraded: false; status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort,
        path: urlPath,
        // No connection pooling: Node's global agent keeps sockets alive, and a
        // pooled socket to a server this file is about to close is one more way
        // for the process to outlive its own tests.
        agent: false,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        resolve({ upgraded: true });
      });
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ upgraded: false, status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  /** Correctly signs arbitrary claims — the only way to test a signed-but-bad payload. */
  function forgeTicket(claims: Record<string, unknown>): string {
    const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const sig = createHmac("sha256", TEST_SECRET).update(payloadB64).digest("base64url");
    return `${payloadB64}.${sig}`;
  }

  test("a valid ticket carries a real WebSocket through to the loopback target", async () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "wstest", port: fakePort });
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}${wsPath(ticket)}`);
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

  test("the port comes from the signed payload, not from the caller", async () => {
    clearSpentTakeoverTicketJtis();
    // 6944 is inside the allowlist and nothing is listening there. If the
    // handler took its port from anywhere but the ticket, this would reach the
    // fake websockify on 6943 and succeed.
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "wstest", port: 6944 });
    const result = await attemptUpgrade(wsPath(ticket)).catch(() => ({ upgraded: false as const, status: 0, body: "socket destroyed" }));
    assert.equal(result.upgraded, false, "a ticket for a dead port must not upgrade");
  });

  test("NO ticket: the deleted unauthenticated arms are refused outright", async () => {
    clearSpentTakeoverTicketJtis();
    // The exact paths that used to open a socket on a bare, guessable id. The
    // handler no longer claims them, so index.ts's wiring destroys the socket.
    for (const urlPath of [
      "/api/uploads/browser/wstest/vnc/websockify",
      "/api/uploads/7a0c6432cde4/vnc/websockify",
      "/api/browser-takeover/ws/",
      "/api/browser-takeover/ws",
    ]) {
      await assert.rejects(
        () => attemptUpgrade(urlPath),
        `${urlPath} must not open a socket`,
      );
    }
  });

  test("EXPIRED ticket: refused with 401, no socket", async () => {
    clearSpentTakeoverTicketJtis();
    const ticket = forgeTicket({
      v: 1,
      rid: "run-abc",
      prof: "wstest",
      port: fakePort,
      exp: Date.now() - 1_000,
      jti: "expired0123456789abcdef0123456789",
    });
    const result = await attemptUpgrade(wsPath(ticket));
    assert.equal(result.upgraded, false);
    assert.equal(result.status, 401);
  });

  test("REPLAYED ticket: the second presentation of a valid ticket is refused with 401", async () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "wstest", port: fakePort });

    const first = await attemptUpgrade(wsPath(ticket));
    assert.equal(first.upgraded, true, "the first presentation must open the socket");

    const second = await attemptUpgrade(wsPath(ticket));
    assert.equal(second.upgraded, false, "a replayed ticket must not open a second socket");
    assert.equal(second.status, 401);
  });

  test("TAMPERED signature: refused with 401", async () => {
    clearSpentTakeoverTicketJtis();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "wstest", port: fakePort });
    const [payload, signature] = ticket.split(".");
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);

    const result = await attemptUpgrade(wsPath(`${payload}.${flipped}`));
    assert.equal(result.upgraded, false);
    assert.equal(result.status, 401);
  });

  test("a correctly SIGNED ticket cannot aim the socket outside the loopback allowlist", async () => {
    clearSpentTakeoverTicketJtis();
    // These payloads carry a valid signature — they are past every crypto
    // check — and each names a port the socket must never reach, including
    // forge-control's own listener. The assertion is on the OUTCOME, not on
    // which layer catches it: the port range is enforced both inside
    // verifyTakeoverTicket and again at use time, and either is a pass.
    for (const port of [proxyPort, 22, 5432, 7700, 6899, 6960]) {
      const ticket = forgeTicket({
        v: 1,
        rid: "run-abc",
        prof: "wstest",
        port,
        exp: Date.now() + 60_000,
        jti: `badport-${port}-0123456789abcdef`,
      });
      const result = await attemptUpgrade(wsPath(ticket));
      assert.equal(result.upgraded, false, `port ${port} must not open a socket`);
      assert.ok(
        result.status === 401 || result.status === 404,
        `port ${port}: expected a refusal status, got ${result.status}`,
      );
    }
  });

  test("a correctly SIGNED ticket carrying a forbidden profile is refused", async () => {
    clearSpentTakeoverTicketJtis();
    for (const prof of ["../../etc", "Not_Valid", "has space", ""]) {
      const ticket = forgeTicket({
        v: 1,
        rid: "run-abc",
        prof,
        port: fakePort,
        exp: Date.now() + 60_000,
        jti: `badprof-${prof}-0123456789abcdef`,
      });
      const result = await attemptUpgrade(wsPath(ticket));
      assert.equal(result.upgraded, false, `profile ${JSON.stringify(prof)} must not open a socket`);
      assert.ok(
        result.status === 401 || result.status === 404,
        `profile ${JSON.stringify(prof)}: expected a refusal status, got ${result.status}`,
      );
    }
  });
});
