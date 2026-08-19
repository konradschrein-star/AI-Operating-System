import { Hono } from "hono";
import { getPipeline, getWorkerHealth } from "../db/pipeline.ts";
import { probeQueueDepths } from "../lib/redis-probe.ts";

const r = new Hono();

/**
 * GET /api/pipeline — Content Forge state, additively extended by phase 5.
 *
 * The response keeps every field it had (`phases`, `total`, and each phase's
 * card shape) and gains `as_of`, `stall_threshold_hours`, `workers` and
 * `queues`, plus per-card stall verdicts and per-phase state sentences.
 *
 * The three sources fail INDEPENDENTLY and are gathered concurrently:
 *   - Postgres is load-bearing. If `content_jobs` cannot be read there is no
 *     pipeline to render, so that error propagates (Hono answers 500) exactly
 *     as it did before.
 *   - pm2 and redis are ADDITIONS. Each returns a discriminated union and
 *     never throws, so a dead probe degrades that panel and nothing else —
 *     and it degrades to `{ok: false, error}`, never to zeroes. A zero from a
 *     dead probe is how a stuck pipeline looks calm (R66, R67, N1).
 *
 * Read-only: one SELECT, `pm2 jlist`, and TYPE/LLEN/ZCARD on redis (R68).
 */
r.get("/", async (c) => {
  const [pipeline, workers, queues] = await Promise.all([
    getPipeline(),
    getWorkerHealth(),
    probeQueueDepths(),
  ]);
  return c.json({ ...pipeline, workers, queues });
});

export default r;
