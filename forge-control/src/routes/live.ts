import { Hono } from "hono";
import {
  listWorkers,
  latestHeartbeatPerWorker,
  type Worker,
  type Heartbeat,
} from "../db/hermes.ts";
import { listOpenInbox } from "../db/ai_os.ts";

const r = new Hono();

/**
 * Service degradation tiers + providers — for v0 these are hard-coded
 * snapshots. When the gateway health endpoints expose tier metadata, this
 * route reads from there instead.
 *
 * Tiers (per CLAUDE-DESIGN-BRIEF.md §12 and the design):
 *   L0 healthy · L1 cached · L2 rate-limited · L3 degraded · L4 down
 */

type Tier = "L0" | "L1" | "L2" | "L3" | "L4";

interface Service {
  svc: string;
  why: string;
  tier: Tier;
}

interface Provider {
  name: string;
  badge: string;
  status: "ok" | "warn" | "error";
}

// Stubbed for v0 — the gateway health endpoints will populate this.
const STUB_DEGRADATION: Service[] = [];
const STUB_PROVIDERS: Provider[] = [];

r.get("/", async (c) => {
  let workers: Worker[] = [];
  let heartbeats: Heartbeat[] = [];
  try {
    workers = listWorkers();
    heartbeats = latestHeartbeatPerWorker();
  } catch {
    /* hermes ledger absent on this host — fall back to empty fleet. */
  }

  const inbox = await listOpenInbox(500);

  const stuck = inbox.filter(
    (i) => i.status === "STUCK" || i.status === "BLEED",
  ).length;
  const hbByWorker = new Map(heartbeats.map((h) => [h.worker_id, h]));
  const activeWorkers = workers.filter((w) => w.status === "running").length;
  const activeJobs = heartbeats.filter(
    (h) => !!h.task_id && (h.state ?? "") !== "idle",
  ).length;
  const queued = Math.max(0, workers.length - activeJobs);

  return c.json({
    stats: [
      { label: "WORKERS", value: String(activeWorkers), tone: "neutral" },
      { label: "JOBS", value: String(activeJobs), tone: "accent" },
      { label: "QUEUED", value: String(queued), tone: "soft" },
      { label: "STUCK", value: String(stuck), tone: "stuck" },
    ],
    degradation: STUB_DEGRADATION,
    providers: STUB_PROVIDERS,
  });
});

export default r;
