/**
 * /api/ledger — the cash ledger.
 *
 * GET  /api/ledger/summary?days=30  — net cash per arm. The headline number.
 * GET  /api/ledger/entries?arm=&limit=&offset= — recent ledger rows for the
 *                                     Money surface's transaction list.
 * POST /api/ledger/entries          — record one entry (revenue, payroll, fee).
 * POST /api/ledger/import/spend-log — pull infra cost from content_forge.
 *
 * Validation is strict here in a way the /api/spend ingest route deliberately
 * is not. Spend rows are telemetry: a malformed one is noise. Ledger rows are
 * the system of record for money — a wrong row is worse than a missing one,
 * because it looks like an answer.
 */

import { Hono } from "hono";
import {
  addEntry,
  summary,
  importSpendLog,
  ARMS,
  type Arm,
  type Direction,
  type LedgerEntry,
  type LedgerEntryInput,
} from "../db/ledger.ts";
import { aiOsPool } from "../db/ai-os-pool.ts";

const r = new Hono();

const ARM_SET = new Set<string>(ARMS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseEntry(raw: unknown): LedgerEntryInput | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be an object" };
  const b = raw as Record<string, unknown>;

  const occurredOn = typeof b.occurred_on === "string" ? b.occurred_on : "";
  if (!DATE_RE.test(occurredOn)) {
    return { error: "occurred_on must be YYYY-MM-DD" };
  }

  const direction = b.direction;
  if (direction !== "in" && direction !== "out") {
    return { error: "direction must be 'in' or 'out'" };
  }

  // Reject non-finite and non-positive up front. The DB CHECK would catch it,
  // but a 500 from a constraint violation is a worse answer than a 400.
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "amount must be a positive number" };
  }

  const arm = typeof b.arm === "string" ? b.arm : "";
  if (!ARM_SET.has(arm)) {
    return { error: `arm must be one of: ${ARMS.join(", ")}` };
  }

  const category = typeof b.category === "string" ? b.category.trim() : "";
  if (!category) return { error: "category is required" };

  const currency =
    typeof b.currency === "string" && b.currency.length === 3
      ? b.currency.toUpperCase()
      : "EUR";

  // Only auto-fill the EUR column when the entry IS EUR. Guessing an FX rate
  // silently would produce a confident, wrong total — the one failure mode a
  // ledger must not have. Foreign-currency rows stay unconverted and are
  // reported as such by /summary.
  const amountEur =
    b.amount_eur === undefined || b.amount_eur === null
      ? currency === "EUR"
        ? amount
        : null
      : Number(b.amount_eur);

  if (amountEur !== null && !Number.isFinite(amountEur)) {
    return { error: "amount_eur must be a number when provided" };
  }

  return {
    occurredOn,
    direction: direction as Direction,
    amount,
    currency,
    amountEur,
    arm: arm as Arm,
    category,
    counterparty: typeof b.counterparty === "string" ? b.counterparty : null,
    memo: typeof b.memo === "string" ? b.memo : null,
    isCash: b.is_cash === undefined ? true : Boolean(b.is_cash),
    source: typeof b.source === "string" ? b.source : "manual",
    externalRef: typeof b.external_ref === "string" ? b.external_ref : null,
  };
}

r.get("/summary", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
  try {
    return c.json({ summary: await summary(days) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.get("/entries", async (c) => {
  const armQuery = c.req.query("arm");
  if (armQuery !== undefined && !ARM_SET.has(armQuery)) {
    return c.json({ error: `arm must be one of: ${ARMS.join(", ")}` }, 400);
  }
  const limit = Math.min(
    200,
    Math.max(1, Number(c.req.query("limit") ?? "50") || 50),
  );
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);

  try {
    const params: unknown[] = [limit, offset];
    let where = "";
    if (armQuery) {
      where = "WHERE arm = $3";
      params.push(armQuery);
    }
    const res = await aiOsPool().query<{
      id: string;
      occurred_on: string;
      direction: Direction;
      amount: string;
      currency: string;
      amount_eur: string | null;
      arm: Arm;
      category: string;
      counterparty: string | null;
      memo: string | null;
      is_cash: boolean;
      source: string;
      external_ref: string | null;
      created_at: Date;
    }>(
      `SELECT id, occurred_on::text AS occurred_on, direction,
              amount::text AS amount, currency, amount_eur::text AS amount_eur,
              arm, category, counterparty, memo, is_cash, source,
              external_ref, created_at
         FROM ledger_entries
         ${where}
        ORDER BY occurred_on DESC, created_at DESC
        LIMIT $1 OFFSET $2`,
      params,
    );

    const entries: LedgerEntry[] = res.rows.map((row) => ({
      id: row.id,
      occurredOn: row.occurred_on,
      direction: row.direction,
      amount: Number(row.amount),
      currency: row.currency,
      amountEur: row.amount_eur === null ? null : Number(row.amount_eur),
      arm: row.arm,
      category: row.category,
      counterparty: row.counterparty,
      memo: row.memo,
      isCash: row.is_cash,
      source: row.source,
      externalRef: row.external_ref,
      createdAt: row.created_at,
    }));

    return c.json({ entries, limit, offset });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.post("/entries", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseEntry(body);
  if ("error" in parsed) return c.json(parsed, 400);

  try {
    const res = await addEntry(parsed);
    return c.json({ entry: res }, res?.inserted ? 201 : 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.post("/import/spend-log", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 90) || 90, 1), 730);
  try {
    return c.json({ result: await importSpendLog(days) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default r;
