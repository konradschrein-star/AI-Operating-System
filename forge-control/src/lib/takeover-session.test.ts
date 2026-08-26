/**
 * Tests for takeover-session.ts — the activity file contract, the session
 * view, and endSession's error path.
 *
 * Run: pnpm test   (node --test via tsx; this file sits in src/lib so the
 * gates-808 flat glob actually executes it — a routes/ test would compile
 * and never run).
 *
 * Every write goes to a mktemp stateRoot. The live tree under
 * /opt/ai-os/browser-profiles/.state is never touched.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ACTIVITY_FILE,
  LAST_SHUTDOWN_FILE,
  activityPath,
  lastShutdownPath,
  readActivity,
  recordConnect,
  recordDisconnect,
  liveSocketCount,
  liveSocketJtis,
  resetLiveSocketsForTests,
  computeSessionView,
  loadSessionView,
  endSession,
  isEndSessionError,
  defaultResearchBrowserScript,
  type TakeoverActivity,
} from "./takeover-session.ts";

const NOW = new Date("2026-08-26T02:00:00.000Z");
const alwaysAlive = () => true;
const neverAlive = () => false;

function readFile(p: string): TakeoverActivity {
  return JSON.parse(readFileSync(p, "utf8")) as TakeoverActivity;
}

describe("module boot order — the cycle with browser-takeover.ts is TDZ-safe both ways", () => {
  // browser-takeover.ts ⇄ takeover-session.ts is an import cycle. ESM
  // evaluates depth-first, so whichever file is requested first has its
  // partner run BEFORE its own body — any module-scope use of the partner's
  // exports throws a TDZ ReferenceError, and only in one of the two orders.
  // index.ts reaches browser-takeover.ts first (production); this test file
  // reaches takeover-session.ts first. Each order gets a fresh process.
  const tsx = path.resolve(process.cwd(), "node_modules/.bin/tsx");

  function bootsCleanly(first: string): void {
    const out = execFileSync(
      tsx,
      ["--eval", `import("${first}").then(() => console.log("booted"))`],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test" }, timeout: 30_000 },
    );
    assert.match(out, /booted/);
  }

  test("browser-takeover.ts first (the production order)", () => {
    bootsCleanly("./src/lib/browser-takeover.ts");
  });

  test("takeover-session.ts first", () => {
    bootsCleanly("./src/lib/takeover-session.ts");
  });
});

describe("activityPath / lastShutdownPath", () => {
  test("lands under <stateRoot>/<profile>/", () => {
    assert.equal(activityPath("konrad-main", "/tmp/x"), path.join("/tmp/x", "konrad-main", ACTIVITY_FILE));
    assert.equal(lastShutdownPath("konrad-main", "/tmp/x"), path.join("/tmp/x", "konrad-main", LAST_SHUTDOWN_FILE));
  });

  test("refuses a profile name that fails PROFILE_RE before touching a path", () => {
    for (const bad of ["../etc", "Upper", "has space", ""]) {
      assert.throws(() => activityPath(bad, "/tmp/x"), /invalid profile name/);
    }
  });
});

describe("readActivity", () => {
  let stateRoot: string;
  before(() => {
    stateRoot = mkdtempSync(path.join(tmpdir(), "takeover-session-read-"));
  });
  after(() => rmSync(stateRoot, { recursive: true, force: true }));

  test("null only when the file does not exist", async () => {
    assert.equal(await readActivity("nofile", stateRoot), null);
  });

  test("throws, naming the path, when the file is not JSON", async () => {
    mkdirSync(path.join(stateRoot, "corrupt"), { recursive: true });
    writeFileSync(activityPath("corrupt", stateRoot), "{not json");
    await assert.rejects(() => readActivity("corrupt", stateRoot), /corrupt\/takeover-activity\.json is not JSON/);
  });

  test("throws, naming the fields, when the shape is wrong", async () => {
    mkdirSync(path.join(stateRoot, "shape"), { recursive: true });
    writeFileSync(
      activityPath("shape", stateRoot),
      JSON.stringify({ connected: -1, connects: "2", first_connect_at: "yesterday", last_connect_at: null, last_disconnect_at: null, written_at: NOW.toISOString() }),
    );
    await assert.rejects(() => readActivity("shape", stateRoot), /malformed field\(s\): connected, connects, first_connect_at/);
  });
});

describe("recordConnect / recordDisconnect — the file shape contract", () => {
  let stateRoot: string;
  before(() => {
    stateRoot = mkdtempSync(path.join(tmpdir(), "takeover-session-rec-"));
  });
  after(() => rmSync(stateRoot, { recursive: true, force: true }));
  beforeEach(() => resetLiveSocketsForTests());

  test("connect twice, disconnect twice: counts, timestamps and exact keys", async () => {
    const t1 = new Date("2026-08-26T02:00:00.000Z");
    const t2 = new Date("2026-08-26T02:00:30.000Z");
    const t3 = new Date("2026-08-26T02:05:00.000Z");
    const t4 = new Date("2026-08-26T02:06:00.000Z");

    const a1 = await recordConnect("p1", "jti-a", { stateRoot, now: t1 });
    assert.deepEqual(a1, {
      connected: 1,
      connects: 1,
      first_connect_at: t1.toISOString(),
      last_connect_at: t1.toISOString(),
      last_disconnect_at: null,
      written_at: t1.toISOString(),
    });
    // The exact key set IS the contract with research-browser.mjs.
    assert.deepEqual(Object.keys(readFile(activityPath("p1", stateRoot))).sort(), [
      "connected",
      "connects",
      "first_connect_at",
      "last_connect_at",
      "last_disconnect_at",
      "written_at",
    ]);

    const a2 = await recordConnect("p1", "jti-b", { stateRoot, now: t2 });
    assert.equal(a2.connected, 2);
    assert.equal(a2.connects, 2);
    assert.equal(a2.first_connect_at, t1.toISOString(), "first_connect_at must not move");
    assert.equal(a2.last_connect_at, t2.toISOString());
    assert.equal(liveSocketCount("p1"), 2);
    assert.deepEqual(liveSocketJtis("p1").sort(), ["jti-a", "jti-b"]);

    const d1 = await recordDisconnect("p1", "jti-a", { stateRoot, now: t3 });
    assert.equal(d1.connected, 1);
    assert.equal(d1.connects, 2, "a disconnect never changes connects");
    assert.equal(d1.last_disconnect_at, t3.toISOString());
    assert.equal(d1.first_connect_at, t1.toISOString());

    const d2 = await recordDisconnect("p1", "jti-b", { stateRoot, now: t4 });
    assert.equal(d2.connected, 0);
    assert.equal(d2.last_disconnect_at, t4.toISOString());
    assert.equal(liveSocketCount("p1"), 0);
    assert.deepEqual(readFile(activityPath("p1", stateRoot)), d2);
  });

  test("first_connect_at and connects survive a simulated forge-control restart; connected is rebuilt from memory", async () => {
    const t1 = new Date("2026-08-26T03:00:00.000Z");
    await recordConnect("p2", "old-1", { stateRoot, now: t1 });
    await recordConnect("p2", "old-2", { stateRoot, now: t1 });
    assert.equal(readFile(activityPath("p2", stateRoot)).connected, 2);

    // The process dies with two sockets open: the file still says 2, memory is empty.
    resetLiveSocketsForTests();
    assert.equal(liveSocketCount("p2"), 0);

    const t2 = new Date("2026-08-26T03:10:00.000Z");
    const after = await recordConnect("p2", "new-1", { stateRoot, now: t2 });
    assert.equal(after.connected, 1, "the first write after boot resets connected to what THIS process knows");
    assert.equal(after.connects, 3, "connects is cumulative across restarts");
    assert.equal(after.first_connect_at, t1.toISOString(), "the takeover clock's origin survives the restart");
    assert.equal(after.last_connect_at, t2.toISOString());
  });

  test("concurrent connects on one profile are serialised — no lost update", async () => {
    const jtis = Array.from({ length: 6 }, (_, i) => `par-${i}`);
    await Promise.all(jtis.map((jti) => recordConnect("p3", jti, { stateRoot, now: NOW })));
    const file = readFile(activityPath("p3", stateRoot));
    assert.equal(file.connects, 6);
    assert.equal(file.connected, 6);
    // Atomic rename leaves no temp files behind.
    assert.deepEqual(readdirSync(path.join(stateRoot, "p3")), [ACTIVITY_FILE]);
  });

  test("a write failure rejects and leaves nothing marked connected (the 503 path)", async () => {
    // A FILE where the state root should be: mkdir -p then fails with ENOTDIR
    // even for root, which chmod 000 would not.
    const notADir = path.join(stateRoot, "not-a-dir");
    writeFileSync(notADir, "");
    // The read-modify-write fails at the READ (ENOTDIR) before the write gets
    // its turn; either way the error names the path and the caller 503s.
    await assert.rejects(
      () => recordConnect("p4", "jti-x", { stateRoot: notADir, now: NOW }),
      /cannot (read|write) .*not-a-dir\/p4\/takeover-activity\.json: ENOTDIR/,
    );
    assert.equal(liveSocketCount("p4"), 0, "a refused socket must not linger as connected");
    assert.equal(existsSync(path.join(stateRoot, "p4")), false);
  });

  test("a duplicate connect and an unknown disconnect are bookkeeping bugs and throw", async () => {
    await recordConnect("p5", "dup", { stateRoot, now: NOW });
    await assert.rejects(() => recordConnect("p5", "dup", { stateRoot, now: NOW }), /already recorded as connected/);
    await assert.rejects(() => recordDisconnect("p5", "never", { stateRoot, now: NOW }), /not recorded as connected/);
    await recordDisconnect("p5", "dup", { stateRoot, now: NOW });
    await assert.rejects(() => recordDisconnect("p5", "dup", { stateRoot, now: NOW }), /not recorded as connected/);
  });
});

describe("computeSessionView — PLAN.md §1.4 body", () => {
  const activity: TakeoverActivity = {
    connected: 1,
    connects: 4,
    first_connect_at: "2026-08-26T01:00:00.000Z",
    last_connect_at: "2026-08-26T01:50:00.000Z",
    last_disconnect_at: "2026-08-26T01:40:00.000Z",
    written_at: "2026-08-26T01:50:00.000Z",
  };
  const takeover = {
    displayNum: 126,
    xvfb: { pid: 11 },
    x11vnc: { pid: 12 },
    websockify: { pid: 13 },
    started_at: "2026-08-26T00:59:00.000Z",
  };

  test("live supervisor: remaining_ms is the nearest of the three deadlines, ended is null", () => {
    const view = computeSessionView({
      profile: "konrad-main",
      activity,
      session: {
        pid: 10,
        idle_deadline: "2026-08-26T02:30:00.000Z", // +30 min
        takeover_deadline: "2026-08-26T03:00:00.000Z", // +60 min
        hard_deadline: "2026-08-26T09:00:00.000Z",
        takeover_started_at: "2026-08-26T01:00:00.000Z",
      },
      takeover,
      lastShutdown: { reason: "should be ignored while live", at: "2026-08-25T00:00:00.000Z" },
      now: NOW,
      pidAlive: alwaysAlive,
    });
    assert.deepEqual(view, {
      profile: "konrad-main",
      stack_up: true,
      supervisor_live: true,
      connected_sockets: 1,
      connects: 4,
      takeover_started_at: "2026-08-26T01:00:00.000Z",
      last_disconnect_at: "2026-08-26T01:40:00.000Z",
      idle_deadline: "2026-08-26T02:30:00.000Z",
      takeover_deadline: "2026-08-26T03:00:00.000Z",
      hard_deadline: "2026-08-26T09:00:00.000Z",
      remaining_ms: 30 * 60_000,
      now: NOW.toISOString(),
      ended: null,
    });
  });

  test("a supervisor that predates takeover_deadline: absent reads as null, remaining_ms uses what exists", () => {
    const view = computeSessionView({
      profile: "os-ui",
      activity,
      session: { pid: 10, idle_deadline: "2026-08-26T02:45:00.000Z", hard_deadline: "2026-08-26T09:00:00.000Z" },
      takeover,
      lastShutdown: null,
      now: NOW,
      pidAlive: alwaysAlive,
    });
    assert.equal(view.takeover_deadline, null);
    assert.equal(view.remaining_ms, 45 * 60_000);
    assert.equal(view.takeover_started_at, activity.first_connect_at, "falls back to the activity file's origin");
  });

  test("dead supervisor: remaining_ms null, ended carries last-shutdown.json, stack_up false", () => {
    const view = computeSessionView({
      profile: "os-ui",
      activity: { ...activity, connected: 0 },
      session: { pid: 10, idle_deadline: "2026-08-26T02:30:00.000Z" },
      takeover,
      lastShutdown: { reason: "takeover cap 2h", at: "2026-08-26T01:59:00.000Z" },
      now: NOW,
      pidAlive: neverAlive,
    });
    assert.equal(view.supervisor_live, false);
    assert.equal(view.stack_up, false);
    assert.equal(view.remaining_ms, null);
    assert.deepEqual(view.ended, { reason: "takeover cap 2h", at: "2026-08-26T01:59:00.000Z" });
  });

  test("nothing on disk at all: zeros and nulls, never a throw", () => {
    const view = computeSessionView({
      profile: "fresh",
      activity: null,
      session: null,
      takeover: null,
      lastShutdown: null,
      now: NOW,
      pidAlive: alwaysAlive,
    });
    assert.equal(view.supervisor_live, false);
    assert.equal(view.stack_up, false);
    assert.equal(view.connected_sockets, 0);
    assert.equal(view.connects, 0);
    assert.equal(view.remaining_ms, null);
    assert.equal(view.ended, null);
  });

  test("stack_up is strict: one dead process in the trio is down", () => {
    const view = computeSessionView({
      profile: "x",
      activity: null,
      session: { pid: 10 },
      takeover,
      lastShutdown: null,
      now: NOW,
      pidAlive: (pid) => pid !== 13, // websockify gone
    });
    assert.equal(view.stack_up, false);
    assert.equal(view.supervisor_live, true);
  });

  test("a deadline that is not a timestamp is a diagnostic, not a silent null", () => {
    assert.throws(
      () =>
        computeSessionView({
          profile: "x",
          activity: null,
          session: { pid: 10, idle_deadline: "soon" },
          takeover: null,
          lastShutdown: null,
          now: NOW,
          pidAlive: alwaysAlive,
        }),
      /idle_deadline is not a timestamp: "soon"/,
    );
  });
});

describe("loadSessionView — reads the four files, trusts memory for connected", () => {
  let stateRoot: string;
  before(() => {
    stateRoot = mkdtempSync(path.join(tmpdir(), "takeover-session-view-"));
    resetLiveSocketsForTests();
  });
  after(() => rmSync(stateRoot, { recursive: true, force: true }));

  test("a stale file after a restart does not report phantom sockets", async () => {
    mkdirSync(path.join(stateRoot, "stale"), { recursive: true });
    writeFileSync(
      activityPath("stale", stateRoot),
      JSON.stringify({
        connected: 7,
        connects: 9,
        first_connect_at: "2026-08-26T01:00:00.000Z",
        last_connect_at: "2026-08-26T01:00:00.000Z",
        last_disconnect_at: null,
        written_at: "2026-08-26T01:00:00.000Z",
      }),
    );
    writeFileSync(lastShutdownPath("stale", stateRoot), JSON.stringify({ reason: "idle 30m", at: "2026-08-26T01:31:00.000Z" }));
    const view = await loadSessionView("stale", { stateRoot, now: NOW });
    assert.equal(view.connected_sockets, 0, "memory says 0; the file's 7 is the dead process's memory");
    assert.equal(view.connects, 9);
    assert.equal(view.supervisor_live, false);
    assert.deepEqual(view.ended, { reason: "idle 30m", at: "2026-08-26T01:31:00.000Z" });
  });

  test("a live connect is visible at once", async () => {
    await recordConnect("livep", "j1", { stateRoot, now: NOW });
    const view = await loadSessionView("livep", { stateRoot, now: NOW });
    assert.equal(view.connected_sockets, 1);
    assert.equal(view.connects, 1);
    assert.equal(view.takeover_started_at, NOW.toISOString());
    await recordDisconnect("livep", "j1", { stateRoot, now: NOW });
  });
});

describe("endSession — spawns `close <profile>`, error path carries the stderr tail", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "takeover-session-end-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function fakeScript(name: string, body: string): string {
    const p = path.join(dir, name);
    writeFileSync(p, body);
    return p;
  }

  test("the default script path resolves to scripts/research-browser.mjs at the repo root", () => {
    const saved = process.env.RESEARCH_BROWSER_SCRIPT;
    delete process.env.RESEARCH_BROWSER_SCRIPT;
    try {
      const p = defaultResearchBrowserScript();
      assert.ok(p.endsWith(path.join("scripts", "research-browser.mjs")), p);
      assert.ok(existsSync(p), `${p} must exist in this checkout`);
    } finally {
      if (saved !== undefined) process.env.RESEARCH_BROWSER_SCRIPT = saved;
    }
  });

  test("success: returns the script's actions and the profile", async () => {
    const script = fakeScript(
      "ok.mjs",
      `const [cmd, profile] = process.argv.slice(2);
       if (cmd !== "close") { console.error("expected close, got " + cmd); process.exit(2); }
       console.log(JSON.stringify({ profile, actions: [{ what: "supervisor", result: "not-running" }] }, null, 2));`,
    );
    const result = await endSession("konrad-main", { scriptPath: script });
    assert.deepEqual(result, {
      ended: true,
      profile: "konrad-main",
      actions: [{ what: "supervisor", result: "not-running" }],
    });
  });

  test("non-zero exit: rejects with an EndSessionError carrying the stderr tail", async () => {
    const script = fakeScript(
      "fail.mjs",
      `console.error("line one\\nsupervisor pid 4242 refused the stop file"); process.exit(3);`,
    );
    await assert.rejects(
      () => endSession("konrad-main", { scriptPath: script }),
      (err: unknown) => {
        assert.ok(isEndSessionError(err), "must be an EndSessionError");
        assert.match(err.message, /close konrad-main exited 3/);
        assert.match(err.stderrTail, /supervisor pid 4242 refused the stop file/);
        assert.equal(err.exitCode, 3);
        return true;
      },
    );
  });

  test("a script that is not there: rejects with node's own stderr, never hangs", async () => {
    await assert.rejects(
      () => endSession("konrad-main", { scriptPath: path.join(dir, "missing.mjs") }),
      (err: unknown) => {
        assert.ok(isEndSessionError(err));
        assert.match(err.stderrTail, /missing\.mjs/);
        return true;
      },
    );
  });

  test("stdout that is not the JSON status is an error, not a success", async () => {
    const script = fakeScript("nojson.mjs", `console.log("closed, probably"); process.exit(0);`);
    await assert.rejects(() => endSession("konrad-main", { scriptPath: script }), /printed no JSON status/);
    const noActions = fakeScript("noactions.mjs", `console.log(JSON.stringify({ ok: true }));`);
    await assert.rejects(() => endSession("konrad-main", { scriptPath: noActions }), /carries no actions array/);
  });

  test("timeout: the child is killed and the error says so", async () => {
    const script = fakeScript("hang.mjs", `setTimeout(() => {}, 60_000);`);
    const started = Date.now();
    await assert.rejects(
      () => endSession("konrad-main", { scriptPath: script, timeoutMs: 300 }),
      /did not finish within 300 ms/,
    );
    assert.ok(Date.now() - started < 5_000, "must not wait for the child's own timer");
  });

  test("a bad profile never reaches spawn", async () => {
    await assert.rejects(() => endSession("../etc", { scriptPath: path.join(dir, "never-run.mjs") }), /invalid profile name/);
  });
});
