import { Hono } from "hono";
import { getTodayPayload, type TodayPayload } from "../db/ai_os.ts";
import {
  listWorkers,
  latestHeartbeatPerWorker,
  type Worker,
  type Heartbeat,
} from "../db/hermes.ts";
import { todaySpendRollup } from "../db/spend.ts";

const r = new Hono();

const SPEND_CAP_EUR = Number(process.env.SPEND_DAILY_CAP_EUR ?? "50");

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

  // Spend rollup. If gateways haven't started reporting yet (row_count=0),
  // the Today screen surfaces "not tracked yet" instead of lying about €0.
  // The cap is shown either way so the user always sees the budget ceiling.
  const rollup = await todaySpendRollup().catch(() => ({
    total_eur: 0,
    row_count: 0,
    by_provider: [],
  }));

  const payload = await getTodayPayload({
    fleet,
    spendEur: rollup.total_eur,
    spendCapEur: SPEND_CAP_EUR,
  });

  // Override the spend block when there is genuinely no data yet — better
  // to be honest about ignorance than to imply zero burn.
  if (rollup.row_count === 0) {
    payload.spend = {
      value: "— not tracked",
      cap: `of €${SPEND_CAP_EUR} cap`,
    };
  }

  return c.json(payload);
});

export default r;
