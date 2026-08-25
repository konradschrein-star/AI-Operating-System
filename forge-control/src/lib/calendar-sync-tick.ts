/**
 * Calendar sync scheduler — same shape as vault-sync-tick.ts.
 *
 * Pulls the current Berlin week out of Google Calendar and into the task board
 * so that something Konrad schedules on his phone is on the board without him
 * opening the OS. Deliberately NOT a cron-tick entry: those spawn an agent run
 * with a prompt, and paying for a model every five minutes to do a diff that
 * plain code does exactly is the kind of spend that shows up in a usage window
 * as a mystery.
 *
 * The pass is idempotent (keyed on `gcal_event_id`), so a missed tick costs
 * nothing and a double tick costs nothing.
 */

import { syncCalendarWindow } from "./calendar-sync.ts";
import { syncGoogleTasks } from "./gtasks-sync.ts";

const TICK_INTERVAL_MS = Number(
  process.env.CALENDAR_SYNC_INTERVAL_MS ?? String(5 * 60 * 1000),
);

/** Set CALENDAR_SYNC_ENABLED=0 to leave the board alone entirely. */
const ENABLED = process.env.CALENDAR_SYNC_ENABLED !== "0";

let running = false;
let tickHandle: NodeJS.Timeout | null = null;

async function tickOnce(): Promise<void> {
  // The two halves are independent: Google Tasks being down must not stop the
  // calendar pull, and vice versa. Separate try blocks, not one.
  try {
    const r = await syncCalendarWindow({ view: "week" });
    // Quiet on a no-op. A line every five minutes saying nothing happened is
    // how a log stops being read.
    if (r.created.length || r.updated.length) {
      console.log(
        `[calendar-sync] events=${r.events} created=${r.created.length} updated=${r.updated.length} skipped=${r.skipped.length}`,
      );
    }
  } catch (e) {
    console.error("[calendar-sync] pass failed:", e instanceof Error ? e.message : e);
  }

  try {
    const g = await syncGoogleTasks({});
    const touched =
      g.pushed_new.length + g.pushed_update.length + g.pulled_new.length + g.pulled_update.length;
    if (touched > 0) {
      console.log(
        `[gtasks-sync] remote=${g.remote} pushed=${g.pushed_new.length}+${g.pushed_update.length} pulled=${g.pulled_new.length}+${g.pulled_update.length} unchanged=${g.unchanged}`,
      );
    }
  } catch (e) {
    console.error("[gtasks-sync] pass failed:", e instanceof Error ? e.message : e);
  }
}

/** Start the scheduler. Safe to call multiple times — only the first installs
 *  an interval. */
export function startCalendarSyncTick(): void {
  if (running) return;
  if (!ENABLED) {
    console.log("[calendar-sync] disabled by CALENDAR_SYNC_ENABLED=0");
    return;
  }
  running = true;
  console.log(`[calendar-sync] starting · interval=${TICK_INTERVAL_MS}ms`);
  void tickOnce();
  tickHandle = setInterval(() => {
    void tickOnce();
  }, TICK_INTERVAL_MS);
}

/** Stop the scheduler — used by tests and by a graceful shutdown. */
export function stopCalendarSyncTick(): void {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
  running = false;
}
