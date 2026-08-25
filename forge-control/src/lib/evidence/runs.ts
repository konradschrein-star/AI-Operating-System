/**
 * Evidence source: agent runs that started that Berlin day — and the decisions
 * stream, which PLAN.md §3.1 folds into the same card.
 *
 * Two exports, two sources in index.ts's map, one module: `DailyDecisionsStream`
 * is being retired as a standalone panel and decisions become one more piece of
 * evidence beside the runs that produced them. They stay independent sources so
 * a failure in one still leaves the other on the page.
 *
 * ── Classification ───────────────────────────────────────────────────────
 * `runs` has no `kind` column; the class is derived from `worker` and
 * `metadata->>'source'` (R1 §e proved these predicates against real rows):
 *
 *   worker  — `worker LIKE 'project:%'`   (builder/reviewer/architect/scout/…)
 *   cron    — `metadata->>'source' = 'cron'`
 *   chat    — `worker = 'forge-executor'` with source null or 'telegram'
 *   other   — anything left (orphan rows with `worker IS NULL`, webhook fires)
 *
 * One deliberate widening of R1's rule, disclosed here because it changes a
 * number: R1 tied `cron` to `worker = 'forge-executor'`, which leaves the 24
 * all-time `cron|skylab-producer` rows classified as neither cron nor chat. A
 * cron fire is a cron fire whichever worker label it carries, so the predicate
 * here is the `source` alone.
 *
 * `other` has no count field — §4.1 pins exactly `{chat, worker, cron, items}` —
 * so such rows appear in `items` with `kind:"other"` and are counted nowhere.
 * That keeps the shape exact without hiding the row: it is visible on the card.
 */

import { query } from "../../db/journal-day.ts";
import { listDecisions } from "../../db/ai_os.ts";
import type { Day } from "../day-score.ts";

export type RunKind = "chat" | "worker" | "cron" | "other";

export interface RunItem {
  id: string;
  title: string | null;
  kind: RunKind;
  status: string;
  started_at: string;
}

export interface RunsEvidence {
  chat: number;
  worker: number;
  cron: number;
  items: RunItem[];
}

export interface DecisionEvidence {
  ts: string;
  kind: string;
  actor: string;
  action: string;
}

/** §4.1: items ≤ 20, newest first. The COUNTS are over the whole day, not over
 *  the capped list — the cap is a display budget, not a sample. */
export const ITEM_CAP = 20;

/** The classification as one SQL expression, shared by the count and the list
 *  so the two can never drift apart. */
const KIND_SQL = `CASE
        WHEN worker LIKE 'project:%' THEN 'worker'
        WHEN metadata->>'source' = 'cron' THEN 'cron'
        WHEN worker = 'forge-executor' THEN 'chat'
        ELSE 'other'
      END`;

interface KindCountRow {
  kind: RunKind;
  n: number;
}

export async function runsForDay(day: Day): Promise<RunsEvidence> {
  // The day filter is on created_at (R1 verified the day's row count against
  // it). started_at is null until the executor picks a run up, so the reported
  // stamp falls back to created_at rather than to null.
  const dayFilter = `(created_at AT TIME ZONE 'Europe/Berlin')::date = $1::date`;

  const [counts, items] = await Promise.all([
    query<KindCountRow>(
      `SELECT ${KIND_SQL} AS kind, count(*)::int AS n
         FROM runs WHERE ${dayFilter} GROUP BY 1`,
      [day],
    ),
    query<RunItem>(
      `SELECT id::text AS id, title, ${KIND_SQL} AS kind, status,
              coalesce(started_at, created_at)::text AS started_at
         FROM runs WHERE ${dayFilter}
        ORDER BY created_at DESC
        LIMIT ${ITEM_CAP}`,
      [day],
    ),
  ]);

  const by = new Map(counts.map((row) => [row.kind, row.n]));
  return {
    chat: by.get("chat") ?? 0,
    worker: by.get("worker") ?? 0,
    cron: by.get("cron") ?? 0,
    items,
  };
}

/** Decisions logged that Berlin day. db/ai_os.ts already scopes `day` through
 *  the zone — reused rather than re-written, so the journal and the search
 *  surface read the same rows. */
export async function decisionsForDay(day: Day): Promise<DecisionEvidence[]> {
  const rows = await listDecisions(200, { day });
  return rows
    .map((d) => ({ ts: d.ts, kind: d.kind, actor: d.actor, action: d.action }))
    .reverse();
}
