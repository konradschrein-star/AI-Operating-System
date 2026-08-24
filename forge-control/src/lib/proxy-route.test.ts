/**
 * Tests for App Router proxy route handler:
 * forge-control-web/app/api/proxy/[...path]/route.ts
 *
 * Verifies:
 * - Transparent proxying across HTTP verbs (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD)
 * - Request conditional headers forwarding (If-None-Match, If-Match, If-Modified-Since, If-Unmodified-Since)
 * - Upstream response status & header passthrough (notably 304 Not Modified + ETag + Cache-Control)
 * - WebSocket upgrade bailout (Connection: Upgrade, Upgrade: websocket) -> 502 with x-proxy-bailout: upgrade
 * - VNC path bailout (/api/proxy/uploads/<id>/vnc/websockify) -> 502 with x-proxy-bailout: upgrade
 * - Network failure handling -> 502
 *
 * Run: pnpm test   (node --test via tsx)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  GET,
  POST,
  PUT,
  DELETE,
  PATCH,
  OPTIONS,
  HEAD,
} from "../../../forge-control-web/app/api/proxy/[...path]/route.ts";
import { handleProxy } from "../../../forge-control-web/app/api/proxy/[...path]/proxy-handler.ts";

describe("Next.js Proxy Route Handler (app/api/proxy/[...path]/route.ts)", () => {
  let upstreamServer: Server;
  let upstreamPort: number;
  let originalForgeControlUrl: string | undefined;

  before(async () => {
    originalForgeControlUrl = process.env.FORGE_CONTROL_URL;

    upstreamServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // uploads index simulation with ETag support
      if (url.pathname === "/api/uploads/index") {
        const testEtag = '"73fc7b488cab2a5c"';
        const ifNoneMatch = req.headers["if-none-match"];

        if (ifNoneMatch === testEtag) {
          res.writeHead(304, {
            etag: testEtag,
            "cache-control": "private, max-age=0, must-revalidate",
          });
          res.end();
          return;
        }

        const payload = JSON.stringify([{ id: "run-001", count: 3 }]);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          etag: testEtag,
          "cache-control": "private, max-age=0, must-revalidate",
        });
        res.end(payload);
        return;
      }

      // Echo endpoint for request inspections
      if (url.pathname === "/api/echo") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-received-method": req.method ?? "",
            "x-received-query": url.search,
          });
          res.end(
            JSON.stringify({
              method: req.method,
              query: url.search,
              headers: req.headers,
              body,
            }),
          );
        });
        return;
      }

      // 204 No content endpoint
      if (url.pathname === "/api/empty") {
        res.writeHead(204, { "x-custom-empty": "true" });
        res.end();
        return;
      }

      // Default fallback
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => {
        upstreamPort = (upstreamServer.address() as AddressInfo).port;
        process.env.FORGE_CONTROL_URL = `http://127.0.0.1:${upstreamPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (originalForgeControlUrl !== undefined) {
      process.env.FORGE_CONTROL_URL = originalForgeControlUrl;
    } else {
      delete process.env.FORGE_CONTROL_URL;
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  test("GET /api/proxy/uploads/index returns 200 with ETag and Cache-Control on cold fetch", async () => {
    const req = new Request("http://localhost:7701/api/proxy/uploads/index", {
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: "authjs.session-token=mock-cookie",
      },
    });

    const res = await GET(req, {
      params: Promise.resolve({ path: ["uploads", "index"] }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("etag"), '"73fc7b488cab2a5c"');
    assert.equal(
      res.headers.get("cache-control"),
      "private, max-age=0, must-revalidate",
    );
    const body = (await res.json()) as Array<{ id: string; count: number }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "run-001");
  });

  test("GET /api/proxy/uploads/index returns 304 Not Modified on If-None-Match match", async () => {
    const req = new Request("http://localhost:7701/api/proxy/uploads/index", {
      method: "GET",
      headers: {
        "if-none-match": '"73fc7b488cab2a5c"',
        accept: "application/json",
      },
    });

    const res = await GET(req, {
      params: Promise.resolve({ path: ["uploads", "index"] }),
    });

    assert.equal(res.status, 304);
    assert.equal(res.headers.get("etag"), '"73fc7b488cab2a5c"');
    assert.equal(
      res.headers.get("cache-control"),
      "private, max-age=0, must-revalidate",
    );
    const text = await res.text();
    assert.equal(text, "");
  });

  test("GET forwards query parameters accurately to upstream", async () => {
    const req = new Request("http://localhost:7701/api/proxy/echo?since=100&limit=5", {
      method: "GET",
    });

    const res = await GET(req, {
      params: Promise.resolve({ path: ["echo"] }),
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { query: string };
    assert.equal(data.query, "?since=100&limit=5");
  });

  test("Forwards conditional and auth headers while stripping hop-by-hop headers", async () => {
    const req = new Request("http://localhost:7701/api/proxy/echo", {
      method: "GET",
      headers: {
        "if-none-match": '"xyz"',
        "if-match": '"abc"',
        "if-modified-since": "Mon, 24 Aug 2026 08:00:00 GMT",
        authorization: "Bearer test-token",
        cookie: "session=123",
        "custom-header": "custom-val",
        "keep-alive": "timeout=5",
        te: "trailers",
      },
    });

    const res = await GET(req, {
      params: Promise.resolve({ path: ["echo"] }),
    });

    const data = (await res.json()) as { headers: Record<string, string> };
    assert.equal(data.headers["if-none-match"], '"xyz"');
    assert.equal(data.headers["if-match"], '"abc"');
    assert.equal(data.headers["if-modified-since"], "Mon, 24 Aug 2026 08:00:00 GMT");
    assert.equal(data.headers["authorization"], "Bearer test-token");
    assert.equal(data.headers["cookie"], "session=123");
    assert.equal(data.headers["custom-header"], "custom-val");
    assert.equal(data.headers["keep-alive"], undefined);
    assert.equal(data.headers["te"], undefined);
  });

  test("POST forwards request method and payload correctly", async () => {
    const payload = JSON.stringify({ message: "hello-proxy" });
    const req = new Request("http://localhost:7701/api/proxy/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    const res = await POST(req, {
      params: Promise.resolve({ path: ["echo"] }),
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { method: string; body: string };
    assert.equal(data.method, "POST");
    assert.equal(data.body, payload);
  });

  test("PUT, DELETE, PATCH, OPTIONS, HEAD verbs are supported", async () => {
    // PUT
    const putReq = new Request("http://localhost:7701/api/proxy/echo", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "put-data",
    });
    const putRes = await PUT(putReq, { params: Promise.resolve({ path: ["echo"] }) });
    assert.equal(putRes.status, 200);
    assert.equal(((await putRes.json()) as { method: string }).method, "PUT");

    // DELETE
    const delReq = new Request("http://localhost:7701/api/proxy/echo", { method: "DELETE" });
    const delRes = await DELETE(delReq, { params: Promise.resolve({ path: ["echo"] }) });
    assert.equal(delRes.status, 200);
    assert.equal(((await delRes.json()) as { method: string }).method, "DELETE");

    // PATCH
    const patchReq = new Request("http://localhost:7701/api/proxy/echo", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "patch-data",
    });
    const patchRes = await PATCH(patchReq, { params: Promise.resolve({ path: ["echo"] }) });
    assert.equal(patchRes.status, 200);
    assert.equal(((await patchRes.json()) as { method: string }).method, "PATCH");

    // OPTIONS
    const optReq = new Request("http://localhost:7701/api/proxy/echo", { method: "OPTIONS" });
    const optRes = await OPTIONS(optReq, { params: Promise.resolve({ path: ["echo"] }) });
    assert.equal(optRes.status, 200);
    assert.equal(((await optRes.json()) as { method: string }).method, "OPTIONS");

    // HEAD
    const headReq = new Request("http://localhost:7701/api/proxy/uploads/index", { method: "HEAD" });
    const headRes = await HEAD(headReq, { params: Promise.resolve({ path: ["uploads", "index"] }) });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("etag"), '"73fc7b488cab2a5c"');
    assert.equal(await headRes.text(), "");
  });

  test("HTTP 204 No Content response is returned with null body", async () => {
    const req = new Request("http://localhost:7701/api/proxy/empty", { method: "GET" });
    const res = await GET(req, { params: Promise.resolve({ path: ["empty"] }) });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("x-custom-empty"), "true");
    assert.equal(await res.text(), "");
  });

  test("Bails out on Connection: Upgrade request with 502 and x-proxy-bailout: upgrade", async () => {
    const req = new Request("http://localhost:7701/api/proxy/ws-endpoint", {
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
      },
    });

    const res = await GET(req, {
      params: Promise.resolve({ path: ["ws-endpoint"] }),
    });

    assert.equal(res.status, 502);
    assert.equal(res.headers.get("x-proxy-bailout"), "upgrade");
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("WebSocket upgrades are not supported"));
  });

  test("Bails out on Upgrade: websocket header with 502", async () => {
    const req = new Request("http://localhost:7701/api/proxy/stream", {
      method: "GET",
      headers: {
        upgrade: "websocket",
      },
    });

    const res = await GET(req, {
      params: Promise.resolve({ path: ["stream"] }),
    });

    assert.equal(res.status, 502);
    assert.equal(res.headers.get("x-proxy-bailout"), "upgrade");
  });

  /* The bail is on the UPGRADE, not on the path.
   *
   * A real websockify request always carries `Connection: Upgrade`, so it is
   * caught by the two tests above. noVNC's SHELL — `vnc.html` and its assets —
   * is ordinary HTTP under the same `/vnc/` prefix, and bailing on the whole
   * subtree left the viewer unable to render even the page that would explain
   * the failure. Strictly worse than the rewrite this replaced, which served
   * the shell fine and failed only the socket.
   *
   * So: a plain GET under /vnc/ must be PROXIED like any other path. It is
   * proxied here to an unreachable upstream purely to prove it reached the
   * proxy path rather than the bailout — the 502 that comes back carries no
   * `x-proxy-bailout` header, which is the distinction that matters. */
  test("does NOT bail on a plain HTTP GET under /vnc/ — only upgrades bail", async () => {
    const oldUrl = process.env.FORGE_CONTROL_URL;
    process.env.FORGE_CONTROL_URL = "http://127.0.0.1:59998";
    try {
      const req = new Request("http://localhost:7701/api/proxy/uploads/run-123/vnc/vnc.html", {
        method: "GET",
      });

      const res = await GET(req, {
        params: Promise.resolve({ path: ["uploads", "run-123", "vnc", "vnc.html"] }),
      });

      assert.equal(
        res.headers.get("x-proxy-bailout"),
        null,
        "a plain GET under /vnc/ must go through the proxy, not the upgrade bailout",
      );
      const body = (await res.json()) as { error: string };
      assert.ok(
        body.error.includes("upstream fetch failed"),
        `expected an upstream-fetch failure, got: ${body.error}`,
      );
    } finally {
      if (oldUrl === undefined) delete process.env.FORGE_CONTROL_URL;
      else process.env.FORGE_CONTROL_URL = oldUrl;
    }
  });

  test("Handles upstream connection failure gracefully with 502", async () => {
    // Point to an unused loopback port
    const oldUrl = process.env.FORGE_CONTROL_URL;
    process.env.FORGE_CONTROL_URL = "http://127.0.0.1:59999";

    try {
      const req = new Request("http://localhost:7701/api/proxy/uploads/index", { method: "GET" });
      const res = await handleProxy(req, { params: Promise.resolve({ path: ["uploads", "index"] }) });

      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.ok(body.error.includes("upstream fetch failed"));
    } finally {
      process.env.FORGE_CONTROL_URL = oldUrl;
    }
  });
});
