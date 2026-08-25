/**
 * Tests for chat-etag.ts — Strong ETag computation and conditional If-None-Match validation
 * for GET /api/chat.
 *
 * Run: pnpm test (or tsx --test src/lib/chat-etag.test.ts)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Hono } from "hono";

import {
  computeChatEtag,
  computeEtag,
  normalizeEtag,
  matchesIfNoneMatch,
  isEtagMatch,
} from "./chat-etag.ts";

describe("computeChatEtag", () => {
  test("returns a strong ETag enclosed in double quotes", () => {
    const etag = computeChatEtag("hello world");
    assert.match(etag, /^"[a-f0-9]{40}"$/);
    assert.equal(etag.startsWith('W/"'), false);
  });

  test("computes SHA-1 correctly for known string input", () => {
    const text = "hello world";
    const expectedSha1 = crypto.createHash("sha1").update(text).digest("hex");
    const etag = computeChatEtag(text);
    assert.equal(etag, `"${expectedSha1}"`);
  });

  test("computes SHA-1 correctly for Buffer input", () => {
    const buf = Buffer.from("hello buffer");
    const expectedSha1 = crypto.createHash("sha1").update(buf).digest("hex");
    const etag = computeChatEtag(buf);
    assert.equal(etag, `"${expectedSha1}"`);
  });

  test("computes SHA-1 correctly for JSON objects", () => {
    const payload = { count: 1, runs: [{ id: "run-1" }], counts: { running: 1 }, hasMore: false };
    const expectedSha1 = crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
    const etag = computeChatEtag(payload);
    assert.equal(etag, `"${expectedSha1}"`);
  });

  test("deterministic for identical objects", () => {
    const obj1 = { count: 2, runs: [{ id: "a" }, { id: "b" }], counts: {}, hasMore: true };
    const obj2 = { count: 2, runs: [{ id: "a" }, { id: "b" }], counts: {}, hasMore: true };
    assert.equal(computeChatEtag(obj1), computeChatEtag(obj2));
  });

  test("changes ETag when payload changes", () => {
    const base = { count: 1, runs: [{ id: "a" }], counts: {}, hasMore: false };
    const modifiedRuns = { count: 1, runs: [{ id: "b" }], counts: {}, hasMore: false };
    const modifiedCounts = { count: 1, runs: [{ id: "a" }], counts: { queued: 1 }, hasMore: false };
    const modifiedHasMore = { count: 1, runs: [{ id: "a" }], counts: {}, hasMore: true };

    const tagBase = computeChatEtag(base);
    assert.notEqual(computeChatEtag(modifiedRuns), tagBase);
    assert.notEqual(computeChatEtag(modifiedCounts), tagBase);
    assert.notEqual(computeChatEtag(modifiedHasMore), tagBase);
  });

  test("computeEtag alias behaves identically", () => {
    const payload = { test: 123 };
    assert.equal(computeEtag(payload), computeChatEtag(payload));
  });
});

describe("normalizeEtag", () => {
  test("strips enclosing double quotes from strong ETag", () => {
    assert.equal(normalizeEtag('"82eeaa62"'), "82eeaa62");
  });

  test("strips W/ prefix and enclosing double quotes from weak ETag", () => {
    assert.equal(normalizeEtag('W/"82eeaa62"'), "82eeaa62");
  });

  test("strips lowercase w/ prefix from weak ETag", () => {
    assert.equal(normalizeEtag('w/"82eeaa62"'), "82eeaa62");
  });

  test("handles unquoted bare ETag", () => {
    assert.equal(normalizeEtag("82eeaa62"), "82eeaa62");
  });

  test("trims leading and trailing whitespace", () => {
    assert.equal(normalizeEtag('  "82eeaa62"  '), "82eeaa62");
    assert.equal(normalizeEtag('  W/"82eeaa62"  '), "82eeaa62");
  });
});

describe("matchesIfNoneMatch", () => {
  const currentTag = '"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"';

  test("exact strong match returns true", () => {
    assert.equal(matchesIfNoneMatch(currentTag, currentTag), true);
  });

  test("weak client tag matches strong server tag (nginx gzip rewrite)", () => {
    const weakClientTag = 'W/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"';
    assert.equal(matchesIfNoneMatch(weakClientTag, currentTag), true);
  });

  test("strong client tag matches weak server tag", () => {
    const weakServerTag = 'W/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"';
    assert.equal(matchesIfNoneMatch(currentTag, weakServerTag), true);
  });

  test("weak client tag matches weak server tag", () => {
    const weakServerTag = 'W/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"';
    const weakClientTag = 'W/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"';
    assert.equal(matchesIfNoneMatch(weakClientTag, weakServerTag), true);
  });

  test("lowercase w/ weak prefix matches", () => {
    const weakClientTag = 'w/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"';
    assert.equal(matchesIfNoneMatch(weakClientTag, currentTag), true);
  });

  test("wildcard * matches any current ETag", () => {
    assert.equal(matchesIfNoneMatch("*", currentTag), true);
  });

  test("comma-separated list matching one tag returns true", () => {
    const header = '"other-tag", W/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", "third-tag"';
    assert.equal(matchesIfNoneMatch(header, currentTag), true);
  });

  test("comma-separated list with whitespace returns true", () => {
    const header = '  "other"  ,   W/"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"  ';
    assert.equal(matchesIfNoneMatch(header, currentTag), true);
  });

  test("comma-separated list containing wildcard returns true", () => {
    const header = '"other", *';
    assert.equal(matchesIfNoneMatch(header, currentTag), true);
  });

  test("mismatched strong tag returns false", () => {
    assert.equal(matchesIfNoneMatch('"different-hash"', currentTag), false);
  });

  test("mismatched weak tag returns false", () => {
    assert.equal(matchesIfNoneMatch('W/"different-hash"', currentTag), false);
  });

  test("mismatched list returns false", () => {
    const header = '"tag1", W/"tag2", "tag3"';
    assert.equal(matchesIfNoneMatch(header, currentTag), false);
  });

  test("null / undefined / empty header returns false", () => {
    assert.equal(matchesIfNoneMatch(null, currentTag), false);
    assert.equal(matchesIfNoneMatch(undefined, currentTag), false);
    assert.equal(matchesIfNoneMatch("", currentTag), false);
    assert.equal(matchesIfNoneMatch("   ", currentTag), false);
  });

  test("empty or invalid server ETag returns false", () => {
    assert.equal(matchesIfNoneMatch(currentTag, ""), false);
    assert.equal(matchesIfNoneMatch(currentTag, '""'), false);
  });

  test("isEtagMatch alias behaves identically", () => {
    assert.equal(isEtagMatch(currentTag, currentTag), matchesIfNoneMatch(currentTag, currentTag));
  });
});

describe("GET /api/chat conditional ETag and 304 HTTP behavior", () => {
  // Test app with conditional ETag handling matching routes/chat.ts logic
  let app: Hono;
  let mockRuns: Array<{ id: string; title: string }>;
  let mockCounts: Record<string, number>;
  let mockHasMore: boolean;

  beforeEach: {
    app = new Hono();
    mockRuns = [{ id: "chat-1", title: "First chat" }];
    mockCounts = { running: 1 };
    mockHasMore = false;

    app.get("/api/chat", (c) => {
      const body = { count: mockRuns.length, runs: mockRuns, counts: mockCounts, hasMore: mockHasMore };
      const tag = computeChatEtag(body);
      const ifNoneMatch = c.req.header("if-none-match");
      if (matchesIfNoneMatch(ifNoneMatch, tag)) {
        return c.body(null, 304, {
          ETag: tag,
          "Cache-Control": "no-cache",
        });
      }
      c.header("ETag", tag);
      c.header("Cache-Control", "no-cache");
      return c.json(body);
    });
  }

  test("cold request returns 200 OK with strong ETag and Cache-Control: no-cache", async () => {
    const res = await app.request("/api/chat");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    const etag = res.headers.get("etag");
    assert.ok(etag, "ETag header must be present");
    assert.match(etag, /^"[a-f0-9]{40}"$/);

    const json = (await res.json()) as { count: number; runs: unknown[] };
    assert.equal(json.count, 1);
    assert.equal(json.runs.length, 1);
  });

  test("conditional request with matching strong ETag returns 304 Not Modified with 0 body bytes", async () => {
    const coldRes = await app.request("/api/chat");
    const etag = coldRes.headers.get("etag")!;

    const condRes = await app.request("/api/chat", {
      headers: { "if-none-match": etag },
    });

    assert.equal(condRes.status, 304);
    assert.equal(condRes.headers.get("etag"), etag);
    assert.equal(condRes.headers.get("cache-control"), "no-cache");
    const bodyText = await condRes.text();
    assert.equal(bodyText, "");
  });

  test("conditional request with weak ETag (nginx gzip rewrite) returns 304 Not Modified", async () => {
    const coldRes = await app.request("/api/chat");
    const strongEtag = coldRes.headers.get("etag")!;
    const weakEtag = `W/${strongEtag}`;

    const condRes = await app.request("/api/chat", {
      headers: { "if-none-match": weakEtag },
    });

    assert.equal(condRes.status, 304);
    assert.equal(condRes.headers.get("etag"), strongEtag);
    assert.equal(condRes.headers.get("cache-control"), "no-cache");
    const bodyText = await condRes.text();
    assert.equal(bodyText, "");
  });

  test("conditional request with wildcard * returns 304 Not Modified", async () => {
    const condRes = await app.request("/api/chat", {
      headers: { "if-none-match": "*" },
    });

    assert.equal(condRes.status, 304);
    const bodyText = await condRes.text();
    assert.equal(bodyText, "");
  });

  test("conditional request with mismatched ETag returns 200 OK with fresh data", async () => {
    const condRes = await app.request("/api/chat", {
      headers: { "if-none-match": '"stale-etag-value"' },
    });

    assert.equal(condRes.status, 200);
    assert.equal(condRes.headers.get("cache-control"), "no-cache");
    const json = (await condRes.json()) as { count: number };
    assert.equal(json.count, 1);
  });

  test("when underlying chat list changes, stale ETag returns 200 OK with new ETag", async () => {
    const firstRes = await app.request("/api/chat");
    const firstEtag = firstRes.headers.get("etag")!;

    // Mutate the mock chat data
    mockRuns.push({ id: "chat-2", title: "Second chat" });

    const secondRes = await app.request("/api/chat", {
      headers: { "if-none-match": firstEtag },
    });

    assert.equal(secondRes.status, 200);
    const secondEtag = secondRes.headers.get("etag")!;
    assert.notEqual(secondEtag, firstEtag);

    const json = (await secondRes.json()) as { count: number; runs: unknown[] };
    assert.equal(json.count, 2);
    assert.equal(json.runs.length, 2);
  });
});
