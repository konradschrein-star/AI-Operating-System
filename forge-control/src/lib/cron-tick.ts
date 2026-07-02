/**
 * Cron scheduler tick — runs alongside forge-control's HTTP server.
 *
 * Every CRON_TICK_INTERVAL_MS (default 15s) we call claimDueSchedules() which
 * atomically advances next_run_at on every row past due so a second tick in
 * the same window can't double-fire. We then create a run per row and
 * record the fire (which sets the real next_run_at via cron-parser).
 *
 * Single in-process scheduler is fine for a personal AI OS — we don't need
 * cluster coordination. If we ever scale out, the FOR UPDATE SKIP LOCKED in
 * claimDueSchedules() makes multi-instance coordination automatic.
 */
import {
  claimDueSchedules,
  recordFire,
  recordError,
} from "../db/cron.ts";
import { createRun } from "../db/runs.ts";

const TICK_INTERVAL_MS = Number(process.env.CRON_TICK_INTERVAL_MS ?? "15000");

let running = false;
let tickHandle: NodeJS.Timeout | null = null;

async function fireSchedule(s: {
  id: string;
  name: string;
  prompt_template: string;
  title_template: string | null;
  worker_label: string | null;
  run_metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    const prompt = s.prompt_template;
    const title = (s.title_template ?? `cron: ${s.name}`).slice(0, 200);
    const run = await createRun({
      title,
      prompt,
      worker: s.worker_label ?? undefined,
      metadata: {
        // Schedule-provided keys first (model, notify, …); reserved keys win.
        ...(s.run_metadata ?? {}),
        source: "cron",
        cron_id: s.id,
        cron_name: s.name,
        fired_at: new Date().toISOString(),
      },
    });
    await recordFire(s.id, run.id);
    console.log(
      `[cron-tick] fired schedule ${s.name} (${s.id}) → run ${run.id}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[cron-tick] failed to fire ${s.name}: ${msg}`);
    await recordError(s.id, msg).catch(() => {});
  }
}

async function tickOnce(): Promise<void> {
  let due: Awaited<ReturnType<typeof claimDueSchedules>>;
  try {
    due = await claimDueSchedules();
  } catch (e) {
    console.error(
      "[cron-tick] claimDueSchedules failed:",
      e instanceof Error ? e.message : e,
    );
    return;
  }
  if (due.length === 0) return;
  await Promise.allSettled(due.map(fireSchedule));
}

/** Start the scheduler. Safe to call multiple times — only the first start
 *  installs an interval. */
export function startCronTick(): void {
  if (running) return;
  running = true;
  console.log(
    `[cron-tick] starting · interval=${TICK_INTERVAL_MS}ms`,
  );
  // Run once immediately so a schedule created seconds before startup fires
  // without waiting a full interval.
  void tickOnce();
  tickHandle = setInterval(() => {
    void tickOnce();
  }, TICK_INTERVAL_MS);
}

export function stopCronTick(): void {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
  running = false;
}
