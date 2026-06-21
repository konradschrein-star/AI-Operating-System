import { Hono } from "hono";
import { getTodayPayload, type TodayPayload } from "../db/ai_os.ts";
import {
  listWorkers,
  latestHeartbeatPerWorker,
  type Worker,
  type Heartbeat,
} from "../db/hermes.ts";

const r = new Hono();

function mapHermesToFleet(): TodayPayload["fleet"] {
  let workers: Worker[] = [];
  let heartbeats: Heartbeat[] = [];
  try {
    workers = listWorkers();
    heartbeats = latestHeartbeatPerWorker();
  } catch {
    return [];
  }
  const hbByWorker = new Map(heartbeats.map((h) => [h.worker_id, h]));

  return workers.map((w) => {
    const hb = hbByWorker.get(w.id);
    const hbStateRaw = (hb?.state ?? "").toLowerCase();
    const needsHuman = hb?.needs_human === 1;
    const isStuck =
      w.status === "dead" ||
      w.status === "suspected" ||
      hbStateRaw === "stuck" ||
      needsHuman;

    let status: TodayPayload["fleet"][number]["status"] = "idle";
    let stateLabel = w.status === "stopped" ? "idle" : hbStateRaw || w.status;

    if (isStuck) {
      status = "stuck";
      stateLabel = `stuck${hbStateRaw ? ` · ${hbStateRaw}` : ""}`;
    } else if (
      /orchestrat|router|manager/.test(w.role) ||
      /orchestrat|router/.test(w.worker_type)
    ) {
      status = "routing";
      stateLabel = w.status === "running" ? "routing" : "idle";
    } else if (/render/.test(w.role) || /render/.test(w.worker_type)) {
      status = w.status === "running" && !!hb ? "render" : "idle";
      stateLabel = status;
    } else {
      status = w.status === "running" ? "idle" : "idle";
      stateLabel = "idle";
    }

    return { name: w.id, state: stateLabel, status };
  });
}

r.get("/", async (c) => {
  const fleet = mapHermesToFleet();
  // Spend tracking lives in a future skill; for now we surface a flat zero.
  const payload = await getTodayPayload({
    fleet,
    spendEur: 0,
    spendCapEur: 50,
  });
  return c.json(payload);
});

export default r;
