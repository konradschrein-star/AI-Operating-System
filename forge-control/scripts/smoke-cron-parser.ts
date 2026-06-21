/**
 * Smoke: validate the minimal cron parser against a handful of common
 * expressions. Run: npx tsx scripts/smoke-cron-parser.ts
 */
import { nextFireFromExpr, parseCron } from "../src/lib/cron-parser.ts";

function isoMin(d: Date): string {
  // YYYY-MM-DD HH:MM in local time so the test is stable on this machine.
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function check(expr: string, fromISO: string, expectedISO: string) {
  const from = new Date(fromISO);
  const got = nextFireFromExpr(expr, from);
  const gotS = isoMin(got);
  const expS = isoMin(new Date(expectedISO));
  if (gotS !== expS) {
    throw new Error(`expr="${expr}" from=${fromISO} → got ${gotS}, expected ${expS}`);
  }
  console.log(`[smoke] "${expr}" from ${fromISO} → ${gotS} ✓`);
}

async function main() {
  // Every minute → next minute.
  check("* * * * *", "2026-06-21T10:00:00", "2026-06-21T10:01:00");

  // Top of every hour.
  check("0 * * * *", "2026-06-21T10:00:00", "2026-06-21T11:00:00");
  check("0 * * * *", "2026-06-21T10:30:00", "2026-06-21T11:00:00");

  // Every 15 minutes.
  check("*/15 * * * *", "2026-06-21T10:07:00", "2026-06-21T10:15:00");
  check("*/15 * * * *", "2026-06-21T10:15:30", "2026-06-21T10:30:00");

  // Daily at 09:30.
  check("30 9 * * *", "2026-06-21T08:00:00", "2026-06-21T09:30:00");
  check("30 9 * * *", "2026-06-21T10:00:00", "2026-06-22T09:30:00");

  // Weekdays at 17:00 (Mon-Fri).
  // 2026-06-21 is a Sunday. Next weekday fire is Monday 22nd 17:00.
  check("0 17 * * 1-5", "2026-06-21T08:00:00", "2026-06-22T17:00:00");

  // Sunday at noon.
  check("0 12 * * 0", "2026-06-21T08:00:00", "2026-06-21T12:00:00");

  // Validation: bad expression → throws.
  let threw = false;
  try {
    parseCron("not a cron");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected parse error on invalid expr");

  threw = false;
  try {
    parseCron("0 0 31 2 *");
    nextFireFromExpr("0 0 31 2 *", new Date("2026-01-01"));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected impossible-expr to throw");

  console.log("[smoke] cron parser invariants passed ✓");
}

main().catch((e) => {
  console.error("[smoke] FAILED:", e);
  process.exit(1);
});
