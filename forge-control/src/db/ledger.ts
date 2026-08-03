/**
 * The cash ledger — data access for ledger_entries (ai_os :5434).
 *
 * This exists to answer one question that has been open in
 * Mentor/Profile/OPEN-QUESTIONS.md since 2026-07-03: what is actually coming in
 * and going out, per arm, per week. Everything here serves that number.
 *
 * The invariant that matters: `is_cash = FALSE` rows NEVER contribute to a cash
 * figure. See the migration header for why (claude-code spend is a shadow price
 * on a flat-rate subscription — real tokens, no money). Every aggregate below
 * filters on is_cash explicitly rather than relying on a caller to remember.
 */

import pg from "pg";
import { aiOsPool } from "./ai-os-pool.ts";

/** Read-only handle on content_forge, purely to import spend_log. Every db
 *  module here owns its own pool rather than sharing one, so this follows the
 *  house style instead of inventing a second convention. */
let cfPool: pg.Pool | null = null;
function contentForgePool(): pg.Pool {
  if (!cfPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set — cannot read spend_log");
    cfPool = new pg.Pool({ connectionString: url, max: 2 });
    cfPool.on("error", (err) =>
      console.error("[ledger cf pool error]", err.message),
    );
  }
  return cfPool;
}

export type Direction = "in" | "out";
export type Arm = "axtrelis" | "youtube" | "infra" | "personal" | "other";

export const ARMS: Arm[] = [
  "axtrelis",
  "youtube",
  "infra",
  "personal",
  "other",
];

export interface LedgerEntryInput {
  occurredOn: string; // YYYY-MM-DD
  direction: Direction;
  amount: number;
  currency?: string;
  amountEur?: number | null;
  arm: Arm;
  category: string;
  counterparty?: string | null;
  memo?: string | null;
  isCash?: boolean;
  source?: string;
  externalRef?: string | null;
}

export interface LedgerEntry extends LedgerEntryInput {
  id: string;
  createdAt: Date;
}

/** Insert one entry. Idempotent when externalRef is supplied: a re-import
 *  updates the existing row instead of creating a second one. Returns null
 *  only if the upsert matched nothing, which should not happen. */
export async function addEntry(
  input: LedgerEntryInput,
): Promise<{ id: string; inserted: boolean } | null> {
  const r = await aiOsPool().query<{ id: string; inserted: boolean }>(
    `INSERT INTO ledger_entries
       (occurred_on, direction, amount, currency, amount_eur, arm, category,
        counterparty, memo, is_cash, source, external_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL
     DO UPDATE SET
       amount     = EXCLUDED.amount,
       amount_eur = EXCLUDED.amount_eur,
       memo       = EXCLUDED.memo,
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      input.occurredOn,
      input.direction,
      input.amount,
      input.currency ?? "EUR",
      input.amountEur ?? null,
      input.arm,
      input.category,
      input.counterparty ?? null,
      input.memo ?? null,
      input.isCash ?? true,
      input.source ?? "manual",
      input.externalRef ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

export interface ArmTotals {
  arm: string;
  inEur: number;
  outEur: number;
  netEur: number;
  entries: number;
}

export interface LedgerSummary {
  since: string;
  until: string;
  byArm: ArmTotals[];
  totalInEur: number;
  totalOutEur: number;
  netEur: number;
  /** Notional (is_cash = false) cost in the window — shown, never counted. */
  shadowEur: number;
  /** True when rows exist that have no EUR conversion yet; the totals below
   *  are therefore incomplete and the UI must say so rather than imply
   *  precision. */
  unconvertedRows: number;
}

/** Net cash per arm over a window. The headline the whole table exists for. */
export async function summary(
  sinceDays = 30,
): Promise<LedgerSummary> {
  const pool = aiOsPool();

  const byArm = await pool.query<{
    arm: string;
    in_eur: string;
    out_eur: string;
    entries: string;
  }>(
    `SELECT arm,
            COALESCE(SUM(amount_eur) FILTER (WHERE direction='in'),  0)::text AS in_eur,
            COALESCE(SUM(amount_eur) FILTER (WHERE direction='out'), 0)::text AS out_eur,
            COUNT(*)::text AS entries
       FROM ledger_entries
      WHERE is_cash = TRUE
        AND occurred_on >= current_date - ($1::int - 1)
      GROUP BY arm
      ORDER BY arm`,
    [sinceDays],
  );

  const extra = await pool.query<{
    shadow_eur: string;
    unconverted: string;
    since: string;
    until: string;
  }>(
    `SELECT COALESCE(SUM(amount_eur) FILTER (WHERE is_cash = FALSE), 0)::text AS shadow_eur,
            COUNT(*) FILTER (WHERE amount_eur IS NULL)::text                 AS unconverted,
            (current_date - ($1::int - 1))::text                             AS since,
            current_date::text                                               AS until
       FROM ledger_entries
      WHERE occurred_on >= current_date - ($1::int - 1)`,
    [sinceDays],
  );

  const rows: ArmTotals[] = byArm.rows.map((r) => {
    const inEur = Number(r.in_eur);
    const outEur = Number(r.out_eur);
    return {
      arm: r.arm,
      inEur,
      outEur,
      netEur: Number((inEur - outEur).toFixed(2)),
      entries: Number(r.entries),
    };
  });

  const totalInEur = Number(
    rows.reduce((a, b) => a + b.inEur, 0).toFixed(2),
  );
  const totalOutEur = Number(
    rows.reduce((a, b) => a + b.outEur, 0).toFixed(2),
  );
  const e = extra.rows[0];

  return {
    since: e?.since ?? "",
    until: e?.until ?? "",
    byArm: rows,
    totalInEur,
    totalOutEur,
    netEur: Number((totalInEur - totalOutEur).toFixed(2)),
    shadowEur: Number(e?.shadow_eur ?? 0),
    unconvertedRows: Number(e?.unconverted ?? 0),
  };
}

export interface ImportResult {
  scanned: number;
  imported: number;
  skippedShadow: number;
}

/**
 * Pull infrastructure cost out of content_forge.spend_log into the ledger.
 *
 * Deliberately conservative: 'claude-code' rows are imported with
 * is_cash = FALSE, not skipped. They are real usage worth seeing, they are just
 * not money — a flat-rate subscription was already paid whether or not a token
 * was spent. Anything else is treated as genuine metered spend.
 *
 * Idempotent via external_ref = the spend_log row id, so this can run on a
 * schedule without double-counting.
 */
export async function importSpendLog(
  sinceDays = 90,
): Promise<ImportResult> {
  const src = await contentForgePool().query<{
    id: string;
    created_at: Date;
    provider: string;
    amount_eur: string | null;
  }>(
    `SELECT id, created_at, provider, amount_eur::text
       FROM spend_log
      WHERE created_at >= now() - ($1::int * interval '1 day')
        AND amount_eur IS NOT NULL
        AND amount_eur > 0`,
    [sinceDays],
  );

  let imported = 0;
  let skippedShadow = 0;

  for (const row of src.rows) {
    const isShadow = row.provider === "claude-code";
    if (isShadow) skippedShadow++;
    const amount = Number(row.amount_eur);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    await addEntry({
      occurredOn: row.created_at.toISOString().slice(0, 10),
      direction: "out",
      amount,
      currency: "EUR",
      amountEur: amount,
      arm: "infra",
      category: isShadow ? "ai_usage_notional" : "software",
      counterparty: row.provider,
      memo: `imported from spend_log (${row.provider})`,
      isCash: !isShadow,
      source: "spend_log",
      externalRef: row.id,
    });
    imported++;
  }

  return { scanned: src.rows.length, imported, skippedShadow };
}
