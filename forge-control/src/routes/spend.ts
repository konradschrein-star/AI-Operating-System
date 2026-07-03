/**
 * /api/spend — gateway-side ingest + UI-side rollup.
 *
 * POST /api/spend         — accepts SpendRow[] or single SpendRow, persists.
 * GET  /api/spend/today   — returns the daily rollup the Today screen consumes.
 * GET  /api/spend/summary — 30-day windows + area breakdown + daily series
 *                           for the Money surface (v2.3).
 *
 * The POST endpoint is intentionally permissive: it accepts both `[row]` and
 * `row` payload shapes so gateways can fire-and-forget without ceremony.
 * Validation is on shape, not provider name — a new gateway can start
 * recording immediately without any AI OS code change.
 */

import { Hono } from "hono";
import {
  recordSpend,
  todaySpendRollup,
  spendSummary,
  type SpendKind,
  type SpendRow,
} from "../db/spend.ts";

const r = new Hono();

const VALID_KINDS: SpendKind[] = [
  "image",
  "tts",
  "llm_input",
  "llm_output",
  "video",
  "music",
  "embedding",
];

const VALID_KIND_SET = new Set<string>(VALID_KINDS);

function parseRow(raw: unknown): SpendRow | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "row must be object" };
  const r = raw as Record<string, unknown>;
  const provider = typeof r.provider === "string" ? r.provider.trim() : "";
  const kind = typeof r.kind === "string" ? r.kind.trim() : "";
  const amount =
    typeof r.amount_eur === "number" ? r.amount_eur : Number(r.amount_eur);
  if (!provider) return { error: "provider required" };
  if (!VALID_KIND_SET.has(kind)) {
    return { error: `kind must be one of ${VALID_KINDS.join(",")}` };
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "amount_eur must be a non-negative number" };
  }
  const job_id =
    typeof r.job_id === "string" && r.job_id.length === 36 ? r.job_id : null;
  const units =
    typeof r.units === "number" && Number.isFinite(r.units) ? r.units : null;
  const meta =
    r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)
      ? (r.meta as Record<string, unknown>)
      : {};
  return { provider, kind: kind as SpendKind, amount_eur: amount, job_id, units, meta };
}

r.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const rawRows = Array.isArray(body) ? body : [body];
  const rows: SpendRow[] = [];
  const errors: { index: number; error: string }[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const parsed = parseRow(rawRows[i]);
    if ("error" in parsed) {
      errors.push({ index: i, error: parsed.error });
    } else {
      rows.push(parsed);
    }
  }
  if (rows.length === 0) {
    return c.json({ error: "no valid rows", errors }, 400);
  }
  const inserted = await recordSpend(rows);
  return c.json({
    inserted,
    skipped: errors.length,
    errors: errors.length > 0 ? errors : undefined,
  });
});

r.get("/today", async (c) => {
  const rollup = await todaySpendRollup();
  return c.json(rollup);
});

r.get("/summary", async (c) => {
  return c.json(await spendSummary());
});

export default r;
