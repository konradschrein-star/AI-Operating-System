/**
 * Test fixture for src/lib/uploads-serving.test.ts (R704).
 *
 * Boots the REAL src/routes/uploads.ts router — not a copy of it — on an
 * ephemeral port and prints `listening <port>` on stdout so the test can find it.
 *
 * It runs as a CHILD PROCESS on purpose. The crash this guards against is a race
 * in undici's stream teardown, and it only opens when the client's socket lives
 * on a different event loop than the server's: driving the same-process server
 * with raw sockets never reproduced it, while an out-of-process client
 * reproduced it 3 runs out of 3. An in-process test would be green on the bug.
 *
 * Exits 90 on an uncaught exception, after printing it, so the parent can tell
 * "the handler crashed the process" apart from any other kind of failure.
 *
 * argv[2] — UPLOAD_DIR to serve from.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { writeSync } from "node:fs";

const uploadDir = process.argv[2];
if (!uploadDir) {
  console.error("usage: uploads-serving-server.ts <upload-dir>");
  process.exit(3);
}

// Read at module scope by routes/uploads.ts, so it must be set before the import.
process.env.UPLOAD_DIR = uploadDir;
const uploadsRoute = (await import("../../routes/uploads.ts")).default;

/**
 * writeSync, not console.log: stdout is a PIPE here, so console.log only queues
 * the bytes and process.exit() throws them away. The parent then sees an empty
 * output buffer and reports "the server died" with no reason attached — which is
 * exactly the diagnostic the assertion message promises to show.
 */
function reportAndDie(line: string, code: number): never {
  writeSync(1, `${line}\n`);
  process.exit(code);
}

process.on("uncaughtException", (err: Error) => {
  reportAndDie(`UNCAUGHT ${err.name}: ${err.message}`, 90);
});
process.on("unhandledRejection", (err: unknown) => {
  reportAndDie(`UNHANDLED_REJECTION ${String(err)}`, 91);
});

const app = new Hono();
app.route("/api/uploads", uploadsRoute);

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
  console.log(`listening ${info.port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
