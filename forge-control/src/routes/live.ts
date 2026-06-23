import { Hono } from "hono";
import {
  listWorkers,
  latestHeartbeatPerWorker,
  type Worker,
  type Heartbeat,
} from "../db/hermes.ts";
import { listOpenInbox } from "../db/ai_os.ts";
import { getProviderHealth } from "../lib/provider-health.ts";

const r = new Hono();

/**
 * Live screen state. Workers + heartbeats come from the Hermes ledger;
 * providers + degradation come from a live HTTP probe layer (see
 * `lib/provider-health.ts`), cached briefly so a fast-polling UI doesn't
 * fan out into a probe storm.
 *
 * Tiers:
 *   L0 healthy · L1 cached · L2 rate-limited · L3 degraded · L4 down
 */

r.get("/", async (c) => {
  let workers: Worker[] = [];
  let heartbeats: Heartbeat[] = [];
  try {
    workers = listWorkers();
    heartbeats = latestHeartbeatPerWorker();
  } catch {
    /* hermes ledger absent on this host — fall back to empty fleet. */
  }

  const [inbox, providerHealth] = await Promise.all([
    listOpenInbox(500),
    getProviderHealth(),
  ]);

  const stuck = inbox.filter(
    (i) => i.status === "STUCK" || i.status === "BLEED",
  ).length;
  const activeWorkers = workers.filter((w) => w.status === "running").length;
  const activeJobs = heartbeats.filter(
    (h) => !!h.task_id && (h.state ?? "") !== "idle",
  ).length;
  const queued = Math.max(0, workers.length - activeJobs);

  // Provider table for the bottom of the Live screen — every probed
  // service shows up regardless of status, so green-line latency is
  // visible at a glance.
  const providers = providerHealth.map((p) => ({
    name: p.name,
    badge: p.badge,
    status: p.status,
  }));

  // Degradation list only includes non-ok services, with the actual
  // reason in `why` so the user sees "503 service unavailable", not
  // a stubbed empty array.
  const degradation = providerHealth
    .filter((p) => p.status !== "ok")
    .map((p) => ({
      svc: p.name,
      why: p.why ?? p.badge,
      tier: p.tier,
    }));

  return c.json({
    stats: [
      { label: "WORKERS", value: String(activeWorkers), tone: "neutral" },
      { label: "JOBS", value: String(activeJobs), tone: "accent" },
      { label: "QUEUED", value: String(queued), tone: "soft" },
      { label: "STUCK", value: String(stuck), tone: "stuck" },
    ],
    degradation,
    providers,
  });
});

export default r;
