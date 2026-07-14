/**
 * Vault sync scheduler — runs alongside forge-control's HTTP server, same
 * shape as cron-tick.ts. Keeps hcp.knowledge_note in sync with the real
 * on-disk Obsidian vault (see syncVaultNotes() in db/memory.ts for why this
 * exists — km-indexer.js never wrote to that table).
 */
import { syncVaultNotes } from "../db/memory.ts";

const TICK_INTERVAL_MS = Number(
  process.env.VAULT_SYNC_INTERVAL_MS ?? String(5 * 60 * 1000),
);

let running = false;
let tickHandle: NodeJS.Timeout | null = null;

async function tickOnce(): Promise<void> {
  try {
    const r = await syncVaultNotes();
    console.log(
      `[vault-sync] scanned=${r.scanned} upserted=${r.upserted} deleted=${r.deleted} errors=${r.errors}`,
    );
  } catch (e) {
    console.error(
      "[vault-sync] pass failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/** Start the scheduler. Safe to call multiple times — only the first start
 *  installs an interval. */
export function startVaultSyncTick(): void {
  if (running) return;
  running = true;
  console.log(`[vault-sync] starting · interval=${TICK_INTERVAL_MS}ms`);
  void tickOnce();
  tickHandle = setInterval(() => {
    void tickOnce();
  }, TICK_INTERVAL_MS);
}

export function stopVaultSyncTick(): void {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
  running = false;
}
