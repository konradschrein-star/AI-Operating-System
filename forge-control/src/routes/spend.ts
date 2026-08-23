/**
 * /api/spend — gateway-side ingest + UI-side rollup.
 *
 * POST /api/spend         — accepts SpendRow[] or single SpendRow, persists.
 * GET  /api/spend/today   — returns the daily rollup the Today screen consumes.
 * GET  /api/spend/summary?days=N&provider=P&kind=K
 *                         — fixed today/d7/d30 windows + an area breakdown and
 *                           daily series over the last N days (default 30,
 *                           clamped 1-365) for the Money surface. `provider`
 *                           and `kind` narrow the breakdown and the series
 *                           only; `all` or omitted means no filter, and a
 *                           malformed value is a 400 rather than a silently
 *                           unfiltered result (see lib/spend-filters.ts). The
 *                           response's `filters.providers` / `filters.kinds`
 *                           carry the unfiltered pick lists.
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
import { recentLimitHits } from "../db/runs.ts";
import { parseSpendFilters } from "../lib/spend-filters.ts";

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
  const parsed = parseSpendFilters({
    days: c.req.query("days"),
    provider: c.req.query("provider"),
    kind: c.req.query("kind"),
  });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { days, provider, kind } = parsed.value;
  return c.json(await spendSummary(days, { provider, kind }));
});

/* Claude Code has no proactive quota API — the CLI only ever tells you
 * you're out when a run actually bounces off the weekly/5-hour wall. This
 * surfaces those bounces so Money can show subscription pressure instead of
 * pretending the claude-code $ figures above are a real bill. */
r.get("/limit-hits", async (c) => {
  const days = Math.min(60, Math.max(1, Number(c.req.query("days") ?? "14")));
  const hits = await recentLimitHits(days);
  return c.json({ days, hits });
});

export default r;
