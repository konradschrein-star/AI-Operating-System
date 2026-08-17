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

import { parseShotName, listRunShots } from "./uploads-index.ts";

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
});
