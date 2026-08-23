/**
 * Throwaway probe server — mounts ONLY the pipeline router, against whatever
 * DATABASE_URL the caller exports. Used to exercise the retry/advance/assign
 * guards against a real Postgres (a scratch copy of the content_forge schema)
 * without touching the live app, the live database or pm2.
 *
 * Delete after the round's evidence is captured; it is verification scaffolding,
 * not part of the API.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pipeline from "./routes/pipeline.ts";

const port = Number(process.env.PROBE_PORT ?? 7793);
const app = new Hono();
app.route("/api/pipeline", pipeline);

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`[probe-pipeline] listening on 127.0.0.1:${info.port}`);
  console.log(`[probe-pipeline] DATABASE_URL=${process.env.DATABASE_URL}`);
});
