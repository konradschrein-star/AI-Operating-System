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
import { getFleetState } from "../db/ai_os.ts";
import {
  DEFAULT_CONNECTION_RECHECK_INTERVAL_MS,
  connectionRecheckIntervalMs,
  recheckAllConnections,
} from "./connection-status.ts";
import { getSecret, listSecrets } from "./secret-store.ts";

const TICK_INTERVAL_MS = Number(process.env.CRON_TICK_INTERVAL_MS ?? "15000");

let running = false;
let tickHandle: NodeJS.Timeout | null = null;
let lastPauseLogAt = 0;

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

/* ── Connection re-check pass (R51) ──────────────────────────────────────── */

/**
 * Google, agy and GitHub are re-probed on this tick rather than on a process of
 * their own. Hanging it here costs nothing — the timer already exists and fires
 * every 15s — and it means the re-check inherits the same lifecycle, the same
 * logs and the same restart semantics as everything else in forge-control.
 *
 * Cadence is CONNECTION_RECHECK_INTERVAL_MS (default 900_000 = 15 minutes),
 * named in lib/connection-status.ts so that this scheduler and the staleness
 * rule in renderState() read literally the same number: a status re-checked
 * every 15 minutes but only demoted after some other constant would age into a
 * lie in the gap between them.
 *
 * NOTHING HERE THROWS INTO THE TICK. An upstream saying no is persisted as
 * ok:false with the verbatim error — a recorded failure, not a silent fallback.
 * An internal failure (an unwritable status store, a probe function faulting)
 * is logged with its message, exactly as fireSchedule() already does, and never
 * converted into a health verdict.
 */
let recheckInFlight = false;
let lastConnectionRecheckAt = 0;

async function maybeRecheckConnections(): Promise<void> {
  if (recheckInFlight) return;

  let intervalMs: number;
  try {
    intervalMs = connectionRecheckIntervalMs();
  } catch (e) {
    console.error(
      "[cron-tick] connection re-check disabled:",
      e instanceof Error ? e.message : e,
    );
    return;
  }

  const now = Date.now();
  // lastConnectionRecheckAt starts at 0, so the first tick after boot probes
  // immediately. That is deliberate: a restart is exactly when the persisted
  // checked_at is most likely to be about to go stale, and it is one cheap
  // read per integration.
  if (now - lastConnectionRecheckAt < intervalMs) return;

  recheckInFlight = true;
  lastConnectionRecheckAt = now;
  try {
    const results = await recheckAllConnections({
      listSecretNames: async () => (await listSecrets()).map((s) => s.name),
      readSecret: getSecret,
    });
    for (const res of results) {
      if (res.error !== null) {
        console.error(`[cron-tick] connection re-check ${res.id} FAILED: ${res.error}`);
      } else if (!res.ok) {
        console.log(
          `[cron-tick] connection re-check ${res.id} recorded a failure (see the persisted detail)`,
        );
      }
    }
    const good = results.filter((x) => x.error === null && x.ok).map((x) => x.id);
    console.log(
      `[cron-tick] connection re-check done · ${good.length}/${results.length} connected${good.length ? ` (${good.join(", ")})` : ""}`,
    );
  } catch (e) {
    console.error(
      "[cron-tick] connection re-check pass threw:",
      e instanceof Error ? e.message : e,
    );
  } finally {
    recheckInFlight = false;
  }
}

async function tickOnce(): Promise<void> {
  // First, and not awaited into the schedule path: a slow upstream must not
  // delay a due cron fire, and claimDueSchedules() returning early below must
  // not skip the re-check.
  void maybeRecheckConnections();

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

  // claimDueSchedules() already advanced next_run_at for every row above —
  // that happens unconditionally so a paused fleet never builds a firing
  // backlog to burst-process on resume. We only gate the actual fire here.
  const fleet = await getFleetState().catch(
    () => ({ status: "running" }) as { status: string },
  );
  if (fleet.status === "paused") {
    const now = Date.now();
    if (now - lastPauseLogAt > 5 * 60 * 1000) {
      console.log(
        `[cron-tick] fleet paused — skipped ${due.length} due schedule(s): ${due.map((s) => s.name).join(", ")}`,
      );
      lastPauseLogAt = now;
    }
    return;
  }
  await Promise.allSettled(due.map(fireSchedule));
}

/** Start the scheduler. Safe to call multiple times — only the first start
 *  installs an interval. */
export function startCronTick(): void {
  if (running) return;
  running = true;
  // Deliberately quoting the RAW configuration rather than calling
  // connectionRecheckIntervalMs(), which throws on a malformed value: a bad
  // env var for a status widget must not make forge-control unbootable. The
  // throw is still surfaced — loudly, once per tick — from
  // maybeRecheckConnections() below.
  console.log(
    `[cron-tick] starting · interval=${TICK_INTERVAL_MS}ms · connection re-check every ${
      process.env.CONNECTION_RECHECK_INTERVAL_MS ??
      `${DEFAULT_CONNECTION_RECHECK_INTERVAL_MS} (default)`
    }ms`,
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
