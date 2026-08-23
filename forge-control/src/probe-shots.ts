/**
 * Throwaway screenshot probe — READ-ONLY BY CONSTRUCTION.
 *
 * Mounts this branch's pipeline router and proxies every OTHER GET to the live
 * API on :7700, so the desktop chrome around the Pipeline surface renders with
 * real data while the surface itself is served by the code under review. Every
 * non-GET is rejected 405 before routing, so nothing here can write anywhere.
 *
 * Verification scaffolding for round 5's before/after evidence. Delete after.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pipeline from "./routes/pipeline.ts";

const port = Number(process.env.PROBE_PORT ?? 7794);
const upstream = process.env.PROBE_UPSTREAM ?? "http://127.0.0.1:7700";

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") {
    return c.json({ error: "probe-shots is read-only: GET only" }, 405);
  }
  await next();
});

app.route("/api/pipeline", pipeline);

app.get("*", async (c) => {
  const url = new URL(c.req.url);
  const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
    headers: { accept: c.req.header("accept") ?? "application/json" },
  });
  const headers = new Headers(res.headers);
  // Both are computed for the ORIGINAL body; passing them through a re-read
  // body produces a truncated or undecodable response.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(await res.arrayBuffer(), { status: res.status, headers });
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`[probe-shots] :${info.port} → proxying non-pipeline GETs to ${upstream}`);
});
