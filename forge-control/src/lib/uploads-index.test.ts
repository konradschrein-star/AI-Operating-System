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

import { parseShotName, listRunShots, ID_RE } from "./uploads-index.ts";

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

    // Run 2: normal clean run
    const run2 = path.join(tempUploadDir, "cccc2222dddd");
    mkdirSync(run2, { recursive: true });
    writeFileSync(path.join(run2, "20260824T051000Z-dashboard.png"), "y");
  });

  after(() => {
    if (oldUploadDir !== undefined) {
      process.env.UPLOAD_DIR = oldUploadDir;
    } else {
      delete process.env.UPLOAD_DIR;
    }
    rmSync(tempUploadDir, { recursive: true, force: true });
  });

  test("listAllRuns enriches summaries with is_live, needs_human, and signal", async () => {
    const { listAllRuns, invalidateRunsCache } = await import("./uploads-index.ts");
    invalidateRunsCache();
    const runs = await listAllRuns();
    assert.equal(runs.length, 2);

    const loginRun = runs.find((r) => r.id === "aaaa1111bbbb");
    assert.ok(loginRun);
    assert.equal(loginRun.needs_human, true);
    assert.equal(loginRun.signal, "login_required");
    assert.ok(loginRun.browser_state);
    assert.equal(loginRun.browser_state.needs_login, true);

    const cleanRun = runs.find((r) => r.id === "cccc2222dddd");
    assert.ok(cleanRun);
    assert.equal(cleanRun.needs_human, false);
    assert.equal(cleanRun.signal, null);
  });
});

