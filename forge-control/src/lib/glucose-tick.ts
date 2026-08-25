/**
 * Glucose poller.
 *
 * 15 minutes, matching the sensor: a Libre produces one reading per quarter
 * hour, and LibreLinkUp's graph endpoint hands back a rolling ~12h window, so a
 * missed tick back-fills itself on the next one and polling faster buys nothing.
 *
 * A `rate_limited` result is logged ONCE and then swallowed. Abbott's block is
 * 24 hours; the bridge already refuses locally for its duration, and a warning
 * every fifteen minutes for a day would bury the log it is written into.
 */

import { fetchGlucose, GlucoseRateLimited } from "./glucose.ts";
import { saveReadings } from "../db/glucose.ts";

const TICK_INTERVAL_MS = Number(
  process.env.GLUCOSE_SYNC_INTERVAL_MS ?? String(15 * 60 * 1000),
);

/** Set GLUCOSE_SYNC_ENABLED=0 to stop polling entirely. */
const ENABLED = process.env.GLUCOSE_SYNC_ENABLED !== "0";

let running = false;
let tickHandle: NodeJS.Timeout | null = null;
let quietUntil = 0;

async function tickOnce(): Promise<void> {
  if (Date.now() < quietUntil) return;
  try {
    const { latest, graph } = await fetchGlucose();
    // The live reading last: only it carries a trend, and saveReadings()
    // deliberately will not overwrite a real trend with a graph point's null.
    const n = await saveReadings([...graph, latest]);
    if (n > 0) {
      console.log(
        `[glucose] ${graph.length + 1} readings · latest ${latest.value_mgdl} mg/dL ` +
          `(${latest.value_mmol} mmol) ${latest.trend_symbol ?? ""} at ${latest.taken_at}`,
      );
    }
  } catch (e) {
    if (e instanceof GlucoseRateLimited) {
      // Say it once, then go quiet for an hour before even re-checking.
      console.warn(`[glucose] ${e.message}`);
      quietUntil = Date.now() + 60 * 60 * 1000;
      return;
    }
    console.error("[glucose] pass failed:", e instanceof Error ? e.message : e);
  }
}

export function startGlucoseTick(): void {
  if (running) return;
  if (!ENABLED) {
    console.log("[glucose] disabled by GLUCOSE_SYNC_ENABLED=0");
    return;
  }
  running = true;
  console.log(`[glucose] starting · interval=${TICK_INTERVAL_MS}ms`);
  void tickOnce();
  tickHandle = setInterval(() => {
    void tickOnce();
  }, TICK_INTERVAL_MS);
}

export function stopGlucoseTick(): void {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
  running = false;
}
