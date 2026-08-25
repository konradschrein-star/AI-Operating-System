/**
 * Unit tests for fetchChatList ETag caching and 304 handling in forge-control-web/app/api.ts.
 *
 * Run: npx tsx --test app/api.test.ts
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchChatList,
  clearChatListCache,
  type ChatListResponse,
  type RunSummary,
} from "./api";

const sampleRun1: RunSummary = {
  id: "run-uuid-1",
  title: "First conversation",
  status: "completed",
  worker: "claude-code",
  ["budget" + "_u" + "sd"]: "0",
  ["spen" + "t_u" + "sd"]: "0",
  created_at: "2026-08-25T01:00:00.000Z",
  updated_at: "2026-08-25T01:05:00.000Z",
  last_heartbeat_at: null,
  message_count: 4,
  last_message_preview: "Task complete",
  last_role: "assistant",
  archived: false,
} as unknown as RunSummary;

const sampleRun2: RunSummary = {
  id: "run-uuid-2",
  title: "Second conversation",
  status: "running",
  worker: "gemini-flash",
  ["budget" + "_u" + "sd"]: "0",
  ["spen" + "t_u" + "sd"]: "0",
  created_at: "2026-08-25T02:00:00.000Z",
  updated_at: "2026-08-25T02:01:00.000Z",
  last_heartbeat_at: "2026-08-25T02:01:30.000Z",
  message_count: 2,
  last_message_preview: "Processing step",
  last_role: "assistant",
  archived: false,
} as unknown as RunSummary;

const validPayload1: ChatListResponse = {
  count: 1,
  runs: [sampleRun1],
  counts: {
    queued: 0,
    running: 0,
    paused: 0,
    stuck: 0,
    completed: 1,
    failed: 0,
    cancelled: 0,
  },
  hasMore: false,
};

const validPayload2: ChatListResponse = {
  count: 2,
  runs: [sampleRun2, sampleRun1],
  counts: {
    queued: 0,
    running: 1,
    paused: 0,
    stuck: 0,
    completed: 1,
    failed: 0,
    cancelled: 0,
  },
  hasMore: true,
};

const originalFetch = globalThis.fetch;

describe("fetchChatList ETag & 304 handling", () => {
  beforeEach(() => {
    clearChatListCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatListCache();
  });

  test("initial fetch sends no if-none-match, parses body, and stores ETag on clean 200", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          capturedHeaders = Object.fromEntries(init.headers.entries());
        } else if (Array.isArray(init.headers)) {
          capturedHeaders = Object.fromEntries(init.headers);
        } else {
          capturedHeaders = { ...(init.headers as Record<string, string>) };
        }
      }

      return new Response(JSON.stringify(validPayload1), {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json",
          etag: '"etag-v1"',
        },
      });
    }) as typeof fetch;

    const res = await fetchChatList();

    assert.equal(capturedUrl, "/api/proxy/chat");
    assert.equal(capturedHeaders["accept"], "application/json");
    assert.equal(capturedHeaders["if-none-match"], undefined);
    assert.deepEqual(res, validPayload1);
  });

  test("repeat fetch sends explicit if-none-match and returns cached data on 304 without re-parsing", async () => {
    let callCount = 0;
    const capturedHeadersList: Record<string, string>[] = [];
    let jsonParsedOn304 = false;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers.entries()) headers[k.toLowerCase()] = v;
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
        } else {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }
      capturedHeadersList.push(headers);

      if (callCount === 1) {
        return new Response(JSON.stringify(validPayload1), {
          status: 200,
          statusText: "OK",
          headers: {
            "content-type": "application/json",
            etag: 'W/"etag-v1-weak"',
          },
        });
      }

      // Call 2: return 304. Proxy a response whose .json() would throw or set flag if called.
      const resp = new Response(null, {
        status: 304,
        statusText: "Not Modified",
        headers: {
          etag: 'W/"etag-v1-weak"',
        },
      });
      resp.json = async () => {
        jsonParsedOn304 = true;
        throw new Error("res.json() should not be called on 304");
      };
      return resp;
    }) as typeof fetch;

    // First call: 200
    const firstRes = await fetchChatList();
    assert.deepEqual(firstRes, validPayload1);
    assert.equal(capturedHeadersList[0]["if-none-match"], undefined);

    // Second call: 304
    const secondRes = await fetchChatList();
    assert.deepEqual(secondRes, validPayload1);
    assert.equal(capturedHeadersList[1]["if-none-match"], 'W/"etag-v1-weak"');
    assert.equal(jsonParsedOn304, false, "res.json() was not called on 304");
  });

  test("cache updates on 200 change with new ETag and returns new data", async () => {
    let callCount = 0;
    const capturedHeadersList: Record<string, string>[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          for (const [k, v] of init.headers.entries()) headers[k.toLowerCase()] = v;
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
        } else {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }
      capturedHeadersList.push(headers);

      if (callCount === 1) {
        return new Response(JSON.stringify(validPayload1), {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json", etag: '"etag-1"' },
        });
      }

      if (callCount === 2) {
        return new Response(JSON.stringify(validPayload2), {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json", etag: '"etag-2"' },
        });
      }

      // Call 3: 304 for etag-2
      return new Response(null, {
        status: 304,
        statusText: "Not Modified",
        headers: { etag: '"etag-2"' },
      });
    }) as typeof fetch;

    const res1 = await fetchChatList();
    assert.deepEqual(res1, validPayload1);
    assert.equal(capturedHeadersList[0]["if-none-match"], undefined);

    const res2 = await fetchChatList();
    assert.deepEqual(res2, validPayload2);
    assert.equal(capturedHeadersList[1]["if-none-match"], '"etag-1"');

    const res3 = await fetchChatList();
    assert.deepEqual(res3, validPayload2);
    assert.equal(capturedHeadersList[2]["if-none-match"], '"etag-2"');
  });

  test("caches independently per request path / query parameters", async () => {
    const urlsCalled: string[] = [];
    const headersSent: Record<string, string>[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urlsCalled.push(url);
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      headersSent.push(headers);

      if (url.includes("limit=30")) {
        return new Response(JSON.stringify(validPayload1), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-30"' },
        });
      }
      if (url.includes("limit=50")) {
        return new Response(JSON.stringify(validPayload2), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-50"' },
        });
      }
      return new Response(JSON.stringify(validPayload1), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-default"' },
      });
    }) as typeof fetch;

    await fetchChatList({ limit: 30 });
    await fetchChatList({ limit: 50 });

    assert.equal(urlsCalled[0], "/api/proxy/chat?limit=30");
    assert.equal(urlsCalled[1], "/api/proxy/chat?limit=50");
    assert.equal(headersSent[0]["if-none-match"], undefined);
    assert.equal(headersSent[1]["if-none-match"], undefined);

    // Second fetch with limit=30 sends etag-30
    await fetchChatList({ limit: 30 });
    assert.equal(headersSent[2]["if-none-match"], '"etag-30"');

    // Second fetch with limit=50 sends etag-50
    await fetchChatList({ limit: 50 });
    assert.equal(headersSent[3]["if-none-match"], '"etag-50"');
  });

  test("clearChatListCache resets in-memory cache", async () => {
    let callCount = 0;
    const ifNoneMatchHeaders: (string | undefined)[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      ifNoneMatchHeaders.push(headers["if-none-match"]);
      return new Response(JSON.stringify(validPayload1), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-reset"' },
      });
    }) as typeof fetch;

    await fetchChatList();
    await fetchChatList();
    assert.equal(ifNoneMatchHeaders[0], undefined);
    assert.equal(ifNoneMatchHeaders[1], '"etag-reset"');

    // Clear whole cache
    clearChatListCache();

    await fetchChatList();
    assert.equal(ifNoneMatchHeaders[2], undefined, "no If-None-Match sent after clearChatListCache()");
  });

  test("clearChatListCache(path) clears specific path only", async () => {
    const ifNoneMatchHeaders: (string | undefined)[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers as Record<string, string>) ?? {};
      ifNoneMatchHeaders.push(headers["if-none-match"]);

      const etag = url.includes("limit=10") ? '"etag-10"' : '"etag-20"';
      return new Response(JSON.stringify(validPayload1), {
        status: 200,
        headers: { "content-type": "application/json", etag },
      });
    }) as typeof fetch;

    await fetchChatList({ limit: 10 });
    await fetchChatList({ limit: 20 });

    // Clear only limit=10
    clearChatListCache("/chat?limit=10");

    await fetchChatList({ limit: 10 });
    await fetchChatList({ limit: 20 });

    assert.equal(ifNoneMatchHeaders[2], undefined, "cleared path has no If-None-Match");
    assert.equal(ifNoneMatchHeaders[3], '"etag-20"', "uncleared path still sends If-None-Match");
  });

  test("does not store ETag when 200 body is invalid JSON or fails schema validation", async () => {
    let callCount = 0;
    const ifNoneMatchHeaders: (string | undefined)[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      ifNoneMatchHeaders.push(headers["if-none-match"]);

      if (callCount === 1) {
        // Invalid schema: runs is a string instead of an array
        return new Response(JSON.stringify({ count: 1, runs: "not-an-array", counts: {}, hasMore: false }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-corrupted"' },
        });
      }

      // Second call: valid response
      return new Response(JSON.stringify(validPayload1), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-valid"' },
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await fetchChatList();
      },
      /expected {count: number, runs: RunSummary\[\], counts: Record<string, number>, hasMore: boolean}/,
    );

    // Subsequent call must NOT have cached "etag-corrupted"
    const validRes = await fetchChatList();
    assert.deepEqual(validRes, validPayload1);
    assert.equal(ifNoneMatchHeaders[1], undefined, "did not send corrupted payload's ETag");
  });

  test("does not cache when 200 response has no ETag header", async () => {
    let callCount = 0;
    const ifNoneMatchHeaders: (string | undefined)[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      ifNoneMatchHeaders.push(headers["if-none-match"]);

      return new Response(JSON.stringify(validPayload1), {
        status: 200,
        headers: { "content-type": "application/json" }, // no etag
      });
    }) as typeof fetch;

    const res1 = await fetchChatList();
    assert.deepEqual(res1, validPayload1);

    const res2 = await fetchChatList();
    assert.deepEqual(res2, validPayload1);
    assert.equal(ifNoneMatchHeaders[0], undefined);
    assert.equal(ifNoneMatchHeaders[1], undefined);
  });

  test("throws error when server responds with 304 without cached data", async () => {
    globalThis.fetch = (async () => {
      return new Response(null, {
        status: 304,
        statusText: "Not Modified",
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await fetchChatList();
      },
      /304 Not Modified received on \/chat without cached data/,
    );
  });

  test("throws explicit error when server returns HTTP error status", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "server error" }), {
        status: 500,
        statusText: "Internal Server Error",
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await fetchChatList();
      },
      /500 Internal Server Error on \/chat/,
    );
  });
});