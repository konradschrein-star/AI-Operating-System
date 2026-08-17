/**
 * Single-router probe for /api/usage — round 1352.
 *
 * Mounts ONLY routes/usage.ts. It deliberately does not import src/index.ts,
 * which would start the cron, telegram and vault ticks and the project engine
 * alongside the router — a build-phase task has no business doing that.
 *
 *   DATABASE_URL=postgresql://…/usage_probe_1352 \
 *   PORT=7791 npx tsx scripts/probe-usage-router.ts
 *
 * Point it at a scratch database seeded from db/migrations/0040_usage_hourly.sql,
 * never at content_forge — PUT /usage/rate writes app_settings.
 *
 * /usage/quota reaches out to Anthropic with the OAuth token on disk. Set
 * CLAUDE_CREDENTIALS=/nonexistent to keep the probe offline; the route then
 * answers its documented "no oauth token on disk" shape, which is exactly the
 * degraded case the panel has to render.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import usage from "../src/routes/usage.ts";

const port = Number(process.env.PORT ?? "7791");
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Give the probe a SCRATCH database " +
      "(e.g. usage_probe_1352) — PUT /usage/rate writes app_settings.",
  );
}

const app = new Hono();
app.use("*", cors({ origin: "*", allowMethods: ["GET", "PUT", "OPTIONS"] }));
app.get("/api/health", (c) => c.json({ ok: true, probe: "usage-router" }));
app.route("/api/usage", usage);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[probe-usage] :${info.port} — /api/usage/{quota,series,rate}`);
  console.log(`[probe-usage] db=${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@")}`);
});
