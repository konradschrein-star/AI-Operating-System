/**
 * Tests for uploads-index.ts — the read-only index over the screenshot
 * convention (scripts/research-browser.mjs:228-312).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseShotName,
  listRunShots,
  ID_RE,
  computeTag,
  getUploadsCacheTag,
  listAllRuns,
  invalidateRunsCache,
  type RunSummary,
} from "./uploads-index.ts";

describe("parseShotName", () => {
  test("a well-formed shot name", () => {
    assert.deepEqual(parseShotName("20260805T101530Z-perplexity-login-wall.png"), {
      ts: "20260805T101530Z",
      label: "perplexity-login-wall",
    });
  });

  test("no timestamp at all", () => {
    assert.deepEqual(parseShotName("perplexity-login-wall.png"), { ts: null, label: null });
  });

  test("timestamp but no label", () => {
    assert.deepEqual(parseShotName("20260805T101530Z.png"), { ts: null, label: null });
  });

  test("an unrelated file name", () => {
    assert.deepEqual(parseShotName("readme.txt"), { ts: null, label: null });
  });

  test("a weird but present extension is still parsed", () => {
    assert.deepEqual(parseShotName("20260805T101530Z-shot.jpeg"), {
      ts: "20260805T101530Z",
      label: "shot",
    });
  });

  test("never throws on garbage input", () => {
    assert.doesNotThrow(() => parseShotName(""));
    assert.doesNotThrow(() => parseShotName("../../etc/passwd"));
  });
});

describe("listRunShots", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "uploads-index-"));
    writeFileSync(path.join(dir, "20260805T101530Z-perplexity-login-wall.png"), "a");
    writeFileSync(path.join(dir, "20260805T101540Z-perplexity-bot-wall.jpg"), "bb");
    writeFileSync(path.join(dir, "notes.txt"), "not an image");
    writeFileSync(path.join(dir, "no-stamp.png"), "c");
    // Force a deterministic mtime order independent of write speed.
    const old = new Date("2026-08-05T10:15:30Z");
    const mid = new Date("2026-08-05T10:15:40Z");
    const newest = new Date("2026-08-05T10:15:50Z");
    utimesSync(path.join(dir, "20260805T101530Z-perplexity-login-wall.png"), old, old);
    utimesSync(path.join(dir, "20260805T101540Z-perplexity-bot-wall.jpg"), mid, mid);
    utimesSync(path.join(dir, "no-stamp.png"), newest, newest);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("only image files are listed, newest first", async () => {
    const shots = await listRunShots(dir);
    assert.deepEqual(
      shots.map((s) => s.name),
      ["no-stamp.png", "20260805T101540Z-perplexity-bot-wall.jpg", "20260805T101530Z-perplexity-login-wall.png"],
    );
  });

  test("each shot carries a servable url under the dir's basename as id", async () => {
    const shots = await listRunShots(dir);
    const id = path.basename(dir);
    for (const shot of shots) {
      assert.equal(shot.url, `/api/uploads/${id}/${encodeURIComponent(shot.name)}`);
    }
  });

  test("label and ts are parsed when the name matches the convention, null otherwise", async () => {
    const shots = await listRunShots(dir);
    const byName = Object.fromEntries(shots.map((s) => [s.name, s]));
    assert.equal(byName["20260805T101530Z-perplexity-login-wall.png"].label, "perplexity-login-wall");
    assert.equal(byName["20260805T101530Z-perplexity-login-wall.png"].ts, "20260805T101530Z");
    assert.equal(byName["no-stamp.png"].label, null);
    assert.equal(byName["no-stamp.png"].ts, null);
  });

  test("size reflects bytes on disk", async () => {
    const shots = await listRunShots(dir);
    const bb = shots.find((s) => s.name === "20260805T101540Z-perplexity-bot-wall.jpg");
    assert.equal(bb?.size, 2);
  });

  /* The library needs the run's patches and logs; the camera strip must never
   * receive them, because BrowserShots.tsx puts every entry it gets into an
   * `<img>`. Both halves of that contract are asserted here — the default
   * being images-only is the load-bearing half. */
  test('include: "all" adds artefacts, and every entry says which kind it is', async () => {
    const all = await listRunShots(dir, { include: "all" });
    const names = all.map((s) => s.name).sort();
    assert.deepEqual(names, [
      "20260805T101530Z-perplexity-login-wall.png",
      "20260805T101540Z-perplexity-bot-wall.jpg",
      "no-stamp.png",
      "notes.txt",
    ]);
    const byName = Object.fromEntries(all.map((s) => [s.name, s]));
    assert.equal(byName["notes.txt"].kind, "artifact");
    assert.equal(byName["no-stamp.png"].kind, "image");
  });

  test("the default is still images only — the camera strip's contract", async () => {
    const shots = await listRunShots(dir);
    assert.equal(
      shots.some((s) => s.kind !== "image"),
      false,
    );
    assert.equal(shots.length, 3);
  });
});

describe("ID_RE", () => {
  test("accepts both directory shapes that exist under /opt/ai-os/uploads", () => {
    assert.equal(ID_RE.test("87464f95d9e2"), true, "12-hex FORGE_RUN_ID");
    assert.equal(
      ID_RE.test("87464f95-d9e2-4b04-95fd-d90ccbf9af8f"),
      true,
      "full run UUID",
    );
  });

  test("still refuses anything that could leave the upload directory", () => {
    for (const bad of [
      "..",
      "../etc",
      "87464f95d9e2/..",
      "87464f95d9e",
      "87464f95d9e2x",
      "not-a-run",
      "",
      "87464f95-d9e2-4b04-95fd-d90ccbf9af8",
      // Uppercase stays a 400: no directory on disk is spelled this way, and
      // uploads-serving.test.ts pins the rejection. See ID_RE's comment.
      "87464F95D9E2",
      "87464F95-D9E2-4B04-95FD-D90CCBF9AF8F",
    ]) {
      assert.equal(ID_RE.test(bad), false, `must reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("listAllRuns & browser_state enrichment", () => {
  let tempUploadDir: string;
  let oldUploadDir: string | undefined;

  before(() => {
    oldUploadDir = process.env.UPLOAD_DIR;
    tempUploadDir = mkdtempSync(path.join(tmpdir(), "uploads-all-runs-"));
    process.env.UPLOAD_DIR = tempUploadDir;

    // Run 1: with login wall screenshot (Exit 4 signal)
    const run1 = path.join(tempUploadDir, "aaaa1111bbbb");
    mkdirSync(run1, { recursive: true });
    writeFileSync(path.join(run1, "20260824T050000Z-perplexity-login-wall.png"), "x");

    // Run 2: normal clean run (idle)
    const run2 = path.join(tempUploadDir, "cccc2222dddd");
    mkdirSync(run2, { recursive: true });
    writeFileSync(path.join(run2, "20260824T051000Z-dashboard.png"), "y");

    // Run 3: active live streaming browser session
    const run3 = path.join(tempUploadDir, "eeee3333ffff");
    mkdirSync(run3, { recursive: true });
    writeFileSync(path.join(run3, "20260824T052000Z-github-live.png"), "z");
    writeFileSync(
      path.join(run3, "browser_state.json"),
      JSON.stringify({ is_live: true, service: "github" }),
    );
  });

  after(() => {
    if (oldUploadDir !== undefined) {
      process.env.UPLOAD_DIR = oldUploadDir;
    } else {
      delete process.env.UPLOAD_DIR;
    }
    rmSync(tempUploadDir, { recursive: true, force: true });
  });

  test("idle runs omit browser_state, is_live, needs_human, and signal from memory and serialized JSON", async () => {
    invalidateRunsCache();
    const runs = await listAllRuns();
    assert.equal(runs.length, 3);

    const cleanRun = runs.find((r) => r.id === "cccc2222dddd");
    assert.ok(cleanRun);
    assert.equal(cleanRun.browser_state, undefined);
    assert.equal(cleanRun.is_live, undefined);
    assert.equal(cleanRun.needs_human, undefined);
    assert.equal(cleanRun.signal, undefined);
    assert.equal("browser_state" in cleanRun, false);
    assert.equal("is_live" in cleanRun, false);
    assert.equal("needs_human" in cleanRun, false);
    assert.equal("signal" in cleanRun, false);

    const cleanJson = JSON.stringify(cleanRun);
    assert.equal(cleanJson.includes("browser_state"), false);
    assert.equal(cleanJson.includes("is_live"), false);
    assert.equal(cleanJson.includes("needs_human"), false);
    assert.equal(cleanJson.includes("signal"), false);
  });

  test("alerting runs (needs_human) retain full browser_state and indicator fields", async () => {
    invalidateRunsCache();
    const runs = await listAllRuns();
    const loginRun = runs.find((r) => r.id === "aaaa1111bbbb");
    assert.ok(loginRun);
    assert.equal(loginRun.needs_human, true);
    assert.equal(loginRun.signal, "login_required");
    assert.equal(loginRun.is_live, false);
    assert.ok(loginRun.browser_state);
    assert.equal(loginRun.browser_state.needs_login, true);

    const loginJson = JSON.stringify(loginRun);
    assert.equal(loginJson.includes('"needs_human":true'), true);
    assert.equal(loginJson.includes('"signal":"login_required"'), true);
    assert.equal(loginJson.includes('"browser_state":'), true);
  });

  test("live streaming runs retain full browser_state and is_live flag", async () => {
    invalidateRunsCache();
    const runs = await listAllRuns();
    const liveRun = runs.find((r) => r.id === "eeee3333ffff");
    assert.ok(liveRun);
    assert.equal(liveRun.is_live, true);
    assert.equal(liveRun.needs_human, false);
    assert.ok(liveRun.browser_state);
    assert.equal(liveRun.browser_state.is_live, true);

    const liveJson = JSON.stringify(liveRun);
    assert.equal(liveJson.includes('"is_live":true'), true);
    assert.equal(liveJson.includes('"browser_state":'), true);
  });
});

describe("computeTag & ETag cache invalidation on state transitions", () => {
  test("computeTag is deterministic and returns valid 16-hex quoted tag", () => {
    const base: RunSummary[] = [
      {
        id: "111122223333",
        count: 5,
        image_count: 5,
        artifact_count: 1,
        file_count: 6,
        latest_ts: "2026-08-24T10:00:00.000Z",
      },
    ];
    const tag1 = computeTag(base);
    const tag2 = computeTag(base);
    assert.equal(tag1, tag2);
    assert.match(tag1, /^"[a-f0-9]{16}"$/);
  });

  test("computeTag incorporates is_live, needs_human, and signal into hash", () => {
    const base: RunSummary = {
      id: "111122223333",
      count: 5,
      image_count: 5,
      artifact_count: 1,
      file_count: 6,
      latest_ts: "2026-08-24T10:00:00.000Z",
    };
    const tagIdle = computeTag([base]);

    const liveRun: RunSummary = { ...base, is_live: true, needs_human: false, signal: null };
    const tagLive = computeTag([liveRun]);
    assert.notEqual(tagLive, tagIdle, "transition to live must change ETag");

    const alertRun: RunSummary = { ...base, is_live: false, needs_human: true, signal: "login_required" };
    const tagAlert = computeTag([alertRun]);
    assert.notEqual(tagAlert, tagIdle, "transition to alert must change ETag");
    assert.notEqual(tagAlert, tagLive, "alert ETag must differ from live ETag");

    const signalChangeRun: RunSummary = { ...base, is_live: false, needs_human: true, signal: "heartbeat_stale" };
    const tagSignalChange = computeTag([signalChangeRun]);
    assert.notEqual(tagSignalChange, tagAlert, "signal change must invalidate ETag");

    const filesChangeRun: RunSummary = { ...base, count: 6, image_count: 6, file_count: 7 };
    const tagFilesChange = computeTag([filesChangeRun]);
    assert.notEqual(tagFilesChange, tagIdle, "file addition must invalidate ETag");
  });

  test("filesystem state transition invalidates getUploadsCacheTag via listAllRuns", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "uploads-etag-test-"));
    const oldDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = tempDir;

    try {
      const runDir = path.join(tempDir, "123456abcdef");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, "20260824T060000Z-screen.png"), "test-image");

      invalidateRunsCache();
      const initialRuns = await listAllRuns();
      assert.equal(initialRuns.length, 1);
      assert.equal(initialRuns[0].is_live, undefined);
      assert.equal(initialRuns[0].needs_human, undefined);
      const tag1 = getUploadsCacheTag();

      // Transition to live by dropping browser_state.json
      const stateFile = path.join(runDir, "browser_state.json");
      writeFileSync(stateFile, JSON.stringify({ is_live: true, service: "github" }));
      invalidateRunsCache();

      const liveRuns = await listAllRuns();
      assert.equal(liveRuns.length, 1);
      assert.equal(liveRuns[0].is_live, true);
      assert.ok(liveRuns[0].browser_state);
      const tag2 = getUploadsCacheTag();
      assert.notEqual(tag2, tag1, "live transition must produce new ETag");

      // Transition to needs_human by dropping auth.json with needs_login
      writeFileSync(path.join(runDir, "auth.json"), JSON.stringify({ needs_login: true, service: "github" }));
      invalidateRunsCache();

      const alertRuns = await listAllRuns();
      assert.equal(alertRuns[0].needs_human, true);
      assert.equal(alertRuns[0].signal, "login_required");
      const tag3 = getUploadsCacheTag();
      assert.notEqual(tag3, tag2, "alert transition must produce new ETag");
      assert.notEqual(tag3, tag1, "alert ETag must differ from idle ETag");

      // Clean up state files -> back to idle
      rmSync(stateFile, { force: true });
      rmSync(path.join(runDir, "auth.json"), { force: true });
      invalidateRunsCache();

      const settledRuns = await listAllRuns();
      assert.equal(settledRuns[0].browser_state, undefined);
      assert.equal(settledRuns[0].is_live, undefined);
      assert.equal(settledRuns[0].needs_human, undefined);
      const tag4 = getUploadsCacheTag();
      assert.equal(tag4, tag1, "reverting to idle restores original ETag");
    } finally {
      if (oldDir !== undefined) {
        process.env.UPLOAD_DIR = oldDir;
      } else {
        delete process.env.UPLOAD_DIR;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

