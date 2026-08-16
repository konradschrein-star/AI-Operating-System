/**
 * R704 regression — GET /api/uploads/:id/:name must not kill forge-control.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * THE BUG, found while proving the screenshot convention for
 * docs/plan/evidence/p7-browser-lane.md §6. The handler built its response as
 *
 *     new Response(createReadStream(abs) as unknown as ReadableStream, ...)
 *
 * A Node `Readable` is not a web `ReadableStream`. undici accepts it anyway — a
 * Readable is async-iterable, so the happy path works and the cast looks
 * harmless. It is not: when a client goes away MID-BODY, undici's teardown calls
 * close() on a stream controller the Node stream has already closed, and throws
 * `ERR_INVALID_STATE: Invalid state: ReadableStream is already closed` from a
 * microtask. That is outside every request scope — Hono cannot catch it,
 * @hono/node-server cannot catch it — so the process dies and pm2 restarts
 * forge-control, taking every open SSE stream with it. It happened for real: one
 * `curl` of a research screenshot restarted the live API on 2026-08-05.
 *
 * WHAT ACTUALLY TRIGGERS IT, established by bisection on a throwaway port. Each
 * of these was tried, and the ones marked clean stay GREEN on the broken handler:
 *   - undici `fetch`, body drained ................. clean, 10/10
 *   - raw client that waits for 'end', then destroys  clean, 10/10
 *   - abort after headers, before any body byte ..... clean, 10/10
 *   - abort MID-BODY, from another process .......... CRASHES, 3 runs of 3
 *   - `curl` (its process exits, RSTing the socket).. CRASHES, 5 flag variants of 5
 * Two ingredients are both required, and dropping either one loses the bug:
 *   1. the abort lands INSIDE the body, and
 *   2. the client is in a DIFFERENT PROCESS. Same-process raw sockets never
 *      reproduced it — the event loops interleave too tightly for the race to
 *      open. Hence the child-process fixture; an in-process test is theatre.
 *
 * A browser hits this by navigating away from a half-loaded <img>, which is
 * exactly how the research lane's screenshots get viewed.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/** 12 lowercase hex — the only shape /api/uploads/:id accepts. */
const RUN_ID = "704ba5e11ce0";
const FILE_NAME = "shot.png";

/**
 * 256 KB. It must be comfortably larger than the stream highWaterMark and the
 * socket buffer, or the whole body lands in a single write and there is no
 * "mid-body" left to abort in — which is the only window that crashes.
 */
const PAYLOAD = Buffer.alloc(256 * 1024, 0x7a);

/** Abort once this many bytes have arrived: past the headers, inside the body. */
const ABORT_AFTER_BYTES = 8 * 1024;

/** Bisection crashed within ~12; 24 keeps it certain without being slow. */
const ABORT_REQUESTS = 24;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "uploads-serving-server.ts");

let uploadDir: string;

before(() => {
  uploadDir = mkdtempSync(path.join(tmpdir(), "r704-uploads-"));
  mkdirSync(path.join(uploadDir, RUN_ID), { recursive: true });
  writeFileSync(path.join(uploadDir, RUN_ID, FILE_NAME), PAYLOAD);
});

after(() => {
  if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
});

/** stdin is "ignore", stdout and stderr are pipes — spawn's type says so exactly. */
type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;

interface Child {
  proc: FixtureProcess;
  port: number;
  /** Everything the child printed — the crash message lands here. */
  output: () => string;
  alive: () => boolean;
  stop: () => void;
}

/** Boot the fixture server and wait for its `listening <port>` line. */
async function startServer(): Promise<Child> {
  const proc: FixtureProcess = spawn(
    process.execPath,
    ["--import", "tsx", FIXTURE, uploadDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let out = "";
  let exited = false;
  proc.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    const m = out.match(/listening (\d+)/);
    if (m) {
      return {
        proc,
        port: Number(m[1]),
        output: () => out,
        alive: () => !exited,
        stop: () => {
          if (!exited) proc.kill("SIGTERM");
        },
      };
    }
    if (exited) throw new Error(`fixture server exited before listening:\n${out}`);
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`fixture server never listened within 30s:\n${out}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * One raw HTTP/1.1 GET, RST as soon as `abortAfterBytes` of response have
 * arrived. Raw TCP rather than fetch: fetch always drains the body and so never
 * reproduces. RST rather than FIN: that is what an exiting `curl` sends.
 * Resolves with the status line; never rejects — a dead server is the thing
 * under test, not an error to propagate.
 */
function abortMidBody(port: number, url: string, abortAfterBytes: number): Promise<string> {
  return new Promise((resolve) => {
    let status = "no-response";
    let seen = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(status);
    };

    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `User-Agent: r704-regression\r\nAccept: */*\r\n\r\n`,
      );
    });

    socket.on("data", (chunk: Buffer) => {
      if (status === "no-response") status = chunk.toString("latin1").slice(0, 12).trim();
      seen += chunk.length;
      if (seen > abortAfterBytes) {
        socket.resetAndDestroy();
        finish();
      }
    });
    socket.on("error", finish);
    socket.on("close", finish);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      finish();
    });
  });
}

describe("R704 — /api/uploads/:id/:name survives clients that leave mid-download", () => {
  test(`${ABORT_REQUESTS} mid-body aborts do not kill the server process`, async () => {
    const server = await startServer();
    try {
      const url = `/api/uploads/${RUN_ID}/${FILE_NAME}`;
      for (let i = 0; i < ABORT_REQUESTS; i++) {
        const status = await abortMidBody(server.port, url, ABORT_AFTER_BYTES);
        assert.ok(
          server.alive(),
          `the server died on abort ${i + 1} of ${ABORT_REQUESTS}. Its output was:\n` +
            `${server.output()}\n` +
            `If that says ERR_INVALID_STATE, routes/uploads.ts is handing undici a Node ` +
            `stream cast to ReadableStream again. It must use Readable.toWeb().`,
        );
        assert.equal(
          status,
          "HTTP/1.1 200",
          `abort ${i + 1} of ${ABORT_REQUESTS} got "${status}" instead of a 200`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // The throw arrives on a microtask and can land after the socket is gone.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(
        server.alive(),
        `the server died after the last abort. Its output was:\n${server.output()}`,
      );
      assert.equal(
        server.output().includes("ERR_INVALID_STATE") ||
          server.output().includes("UNCAUGHT") ||
          server.output().includes("UNHANDLED_REJECTION"),
        false,
        `the server survived but logged a fault:\n${server.output()}`,
      );
    } finally {
      server.stop();
    }
  });

  test("a complete GET returns the exact bytes on disk", async () => {
    const server = await startServer();
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/uploads/${RUN_ID}/${FILE_NAME}`,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("content-length"), String(PAYLOAD.length));

      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.length, PAYLOAD.length, "the whole file must arrive");
      assert.ok(bytes.equals(PAYLOAD), "served bytes must match the file on disk");
    } finally {
      server.stop();
    }
  });

  test("a bad run id is 400 and a missing file is 404", async () => {
    const server = await startServer();
    try {
      const base = `http://127.0.0.1:${server.port}/api/uploads`;
      for (const bad of ["704b0f5e1a2", "704B0F5E1A2C", "704b0f5e1a2cc", "zzzzzzzzzzzz"]) {
        const res = await fetch(`${base}/${encodeURIComponent(bad)}/${FILE_NAME}`);
        assert.equal(res.status, 400, `run id "${bad}" should have been rejected with 400`);
      }
      const missing = await fetch(`${base}/${RUN_ID}/absent.png`);
      assert.equal(missing.status, 404);
    } finally {
      server.stop();
    }
  });
});
