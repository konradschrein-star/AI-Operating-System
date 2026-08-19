/**
 * Reminder retention and presentation — the pure half of phase 6's reminders fix
 * (R79, R80, R81, R82).
 *
 * ── WHAT THIS IMPLEMENTS, AND WHOSE DECISION IT IS ───────────────────────────
 *
 * `docs/plan/artifacts/os-usable-for-work/phase6/reminders-policy-escalation.md`
 * §3 is the ruling, and this file implements that and nothing wider:
 *
 *   "pending + last 7 days delivered; older collapsed into a counted history
 *    fold; recurring renders as one row; per-item dismissal persists."
 *
 * The escalation offered Konrad four options and recorded the default when he did
 * not answer within the escalation's own window. Two consequences are load-bearing
 * here and are NOT free choices of this module:
 *
 *   • the window is measured from `due_at` — the ruling decides this explicitly
 *     (§3.1) because `delivered_at` is NULL on every pending row and a NULL in a
 *     window predicate silently drops exactly the class of row that must never be
 *     hidden;
 *   • repeat-grouping is option 4 of the block and Konrad did NOT pick it (§3.2,
 *     "No repeat-grouping"). So `groupRepeats` defaults to FALSE and the shipped
 *     caller leaves it false. The logic exists, is tested, and is one flag away —
 *     it does not run until he rules for it. `groups` is still REPORTED whatever
 *     the flag says, because a repeat cluster the surface can see is information;
 *     collapsing it is the part that needed a ruling.
 *
 * ── WHAT MAY NEVER HAPPEN HERE ───────────────────────────────────────────────
 *
 * NOTHING IS DELETED. This module has no DB access at all, and the retention verb
 * for the whole phase is "hide, group, collapse, count" — never DELETE and never
 * an automatic dismissal. `SELECT count(*) FROM reminders` is identical before and
 * after phase 6 by construction: nothing downstream of this file writes.
 *
 * RULE (a) IS THE INVARIANT THE REST BENDS AROUND: every row with
 * `status = 'pending'` is ALWAYS visible, as its OWN row — outside the window,
 * inside a repeat cluster, recurring, whatever. A pending reminder has not fired
 * yet; a presentation rule that can hide one is a blocker, not a cosmetic bug.
 * Two separate places enforce it (the window predicate and the grouping key) and
 * `reminder-retention.test.ts` attacks both.
 *
 * RULE (e): nothing is dropped without being counted somewhere the UI shows. The
 * arithmetic is asserted at the end of every fold — `input === dismissed +
 * pending + delivered_in_window + history` — and a mismatch THROWS rather than
 * returning a view with a number missing from it. A count that quietly fails to
 * add up is the defect this phase exists to end.
 *
 * Pure: no `pg` import, no `Date.now()`, no I/O. The clock is a parameter, so the
 * tests drive fixtures at fixed instants rather than racing a live table (N2).
 */

/** Every retention failure. Thrown, never softened into a default view: a
 *  reminders list rendered from a half-understood input is indistinguishable on
 *  screen from "you have no reminders", and that is the lie this file exists to
 *  prevent (N1). */
export class ReminderRetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderRetentionError";
  }
}

/** The ruled default window, in days (escalation §3, option 1). Exported so the
 *  route and the tests read the ruling from one place instead of each carrying a
 *  literal 7 that can drift from the other. */
export const REMINDER_VIEW_DEFAULT_DAYS = 7;

/**
 * Ceiling for an explicit `days`, and the mechanism behind "show history": the
 * fold expands by asking for a window wide enough to contain the whole table
 * (100 years), rather than by a second endpoint that could disagree with the
 * first about what a row is. Anything larger is a caller mistake and is a 400,
 * not a silently clamped number.
 */
export const REMINDER_VIEW_MAX_DAYS = 36_500;

export type ReminderRetentionStatus = "pending" | "delivered" | "dismissed";

/** The fields retention actually reads. Deliberately narrower than
 *  `db/reminders.ts`'s `Reminder`, and generic below, so the full row — `source`,
 *  `created_at`, `delivered_at` — travels to the client untouched while this
 *  module stays testable from literals. */
export interface ReminderRetentionRow {
  id: string;
  text: string;
  /** Timestamp text as Postgres `::text` renders it, e.g. `2026-08-18 20:16:06+00`. */
  due_at: string;
  recur: "daily" | "weekly" | null;
  status: ReminderRetentionStatus;
}

/** A row as the surface renders it. `repeat_count` is 1 for an ordinary row and
 *  is the honest cluster size for a collapsed one — never a count of anything
 *  the user cannot reach, because `repeat_ids` names every row it stands for. */
export type FoldedReminder<T extends ReminderRetentionRow> = T & {
  repeat_count: number;
  repeat_ids: string[];
};

/** A detected cluster of identical texts among the visible DELIVERED rows.
 *  Reported whether or not it was collapsed — `collapsed` says which. */
export interface ReminderRepeatGroup {
  text: string;
  count: number;
  ids: string[];
  /** The newest `due_at` in the cluster; the one a collapsed row carries. */
  newest_due_at: string;
  collapsed: boolean;
}

export interface ReminderRetentionCounts {
  /** Rows handed in, before anything was excluded. */
  input: number;
  /** Excluded as today — dismissal is the archive verb and it already works. */
  dismissed: number;
  /** Always visible, window or no window (rule a). */
  pending: number;
  /** Delivered and inside the window. */
  delivered_in_window: number;
  /** Delivered and older — the number behind "104 older · show". */
  history: number;
  /** Rows actually on screen. Below `pending + delivered_in_window` only when a
   *  cluster was collapsed, and then `represented` says by how much. */
  visible_rows: number;
  /** Rows those visible rows stand for. Must equal pending + delivered_in_window. */
  represented: number;
}

export interface ReminderRetentionView<T extends ReminderRetentionRow> {
  visible: FoldedReminder<T>[];
  groups: ReminderRepeatGroup[];
  history_count: number;
  window_days: number;
  counts: ReminderRetentionCounts;
}

export interface FoldRemindersOptions {
  /** Whole days of delivered history to keep open. Validated, never defaulted
   *  here — the caller states it and the response echoes it back. */
  windowDays: number;
  /** The clock, as a parameter. No `Date.now()` in this file. */
  now: Date;
  /** Escalation option 4, unruled. False until Konrad picks it. */
  groupRepeats?: boolean;
}

const MS_PER_DAY = 86_400_000;

/** Parse a Postgres timestamp text into epoch ms, or throw naming the row.
 *  `new Date(x).getTime()` returning NaN would otherwise compare false against
 *  every bound, which silently sorts the row to one end and can hide it. */
function dueAtMs(row: ReminderRetentionRow): number {
  const ms = new Date(row.due_at).getTime();
  if (!Number.isFinite(ms)) {
    throw new ReminderRetentionError(
      `reminder ${row.id} has an unparseable due_at ${JSON.stringify(row.due_at)} — ` +
        `expected a Postgres timestamp text such as "2026-08-18 20:16:06+00". Not skipped: ` +
        `a row that cannot be placed in time must not be dropped from a list silently.`,
    );
  }
  return ms;
}

function assertValidOptions(opts: FoldRemindersOptions): void {
  const { windowDays, now } = opts;
  if (!Number.isInteger(windowDays)) {
    // String(), not JSON.stringify(): `JSON.stringify(NaN)` is the text "null",
    // which would report the one value most likely to arrive from a parsed query
    // string as something it is not.
    throw new ReminderRetentionError(
      `windowDays must be a whole number of days, got ${String(windowDays)}`,
    );
  }
  if (windowDays < 1 || windowDays > REMINDER_VIEW_MAX_DAYS) {
    throw new ReminderRetentionError(
      `windowDays must be between 1 and ${REMINDER_VIEW_MAX_DAYS}, got ${windowDays}`,
    );
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ReminderRetentionError(
      `now must be a valid Date — the clock is a parameter here, never Date.now(), so a ` +
        `test can pin it. Got ${JSON.stringify(String(now))}.`,
    );
  }
}

/**
 * Fold a list of reminder rows into what the surface renders.
 *
 * Order on screen: pending first, soonest due first (they are the only rows that
 * are still going to do something), then delivered NEWEST FIRST. The newest-first
 * half is escalation §3.3 fix 1 — `listReminders()` orders `due_at ASC`, which is
 * why Konrad's phone opens on a 2 July smoke test. That existing query is NOT
 * touched (the R705 dedup test asserts its text); this is the new path.
 */
export function foldReminders<T extends ReminderRetentionRow>(
  rows: readonly T[],
  opts: FoldRemindersOptions,
): ReminderRetentionView<T> {
  assertValidOptions(opts);
  const { windowDays, now } = opts;
  const groupRepeats = opts.groupRepeats ?? false;
  const cutoffMs = now.getTime() - windowDays * MS_PER_DAY;

  const pending: T[] = [];
  const deliveredInWindow: T[] = [];
  let dismissed = 0;
  let history = 0;

  for (const row of rows) {
    // An unknown status is a schema change this module has not been taught. It
    // must not fall through to "not pending, therefore hideable".
    if (row.status !== "pending" && row.status !== "delivered" && row.status !== "dismissed") {
      throw new ReminderRetentionError(
        `reminder ${row.id} has status ${JSON.stringify(row.status)}, which retention does ` +
          `not know how to place. Teach this function before adding a status, or a new ` +
          `lifecycle state disappears from the surface without a count.`,
      );
    }
    if (row.status === "dismissed") {
      dismissed++;
      continue;
    }
    if (row.status === "pending") {
      // RULE (a). Deliberately NOT inside the window test: a pending row 60 days
      // old is still a thing that has not happened yet.
      dueAtMs(row); // validate now, so an unparseable date cannot reach the sort
      pending.push(row);
      continue;
    }
    if (dueAtMs(row) >= cutoffMs) deliveredInWindow.push(row);
    else history++;
  }

  pending.sort((a, b) => dueAtMs(a) - dueAtMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  deliveredInWindow.sort(
    (a, b) => dueAtMs(b) - dueAtMs(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Clusters are computed over the DELIVERED visible rows only. Pending rows are
  // never a grouping key and never join one — rule (a) again, and rule (c)'s
  // "a group containing a pending row renders the pending row separately" is
  // therefore true by construction rather than by a second test downstream.
  const byText = new Map<string, T[]>();
  for (const row of deliveredInWindow) {
    const bucket = byText.get(row.text);
    if (bucket) bucket.push(row);
    else byText.set(row.text, [row]);
  }

  const groups: ReminderRepeatGroup[] = [];
  for (const [text, bucket] of byText) {
    if (bucket.length < 2) continue;
    groups.push({
      text,
      count: bucket.length,
      ids: bucket.map((r) => r.id),
      // deliveredInWindow is newest-first, so the head of a bucket is the newest.
      newest_due_at: bucket[0].due_at,
      collapsed: groupRepeats,
    });
  }
  groups.sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  const foldedPending: FoldedReminder<T>[] = pending.map((r) => ({
    ...r,
    repeat_count: 1,
    repeat_ids: [r.id],
  }));

  const foldedDelivered: FoldedReminder<T>[] = [];
  const consumed = new Set<string>();
  for (const row of deliveredInWindow) {
    if (consumed.has(row.id)) continue;
    const bucket = byText.get(row.text);
    if (groupRepeats && bucket && bucket.length > 1) {
      for (const r of bucket) consumed.add(r.id);
      foldedDelivered.push({
        ...row, // the newest of the cluster: it is first in this newest-first list
        repeat_count: bucket.length,
        repeat_ids: bucket.map((r) => r.id),
      });
      continue;
    }
    foldedDelivered.push({ ...row, repeat_count: 1, repeat_ids: [row.id] });
  }

  const visible = [...foldedPending, ...foldedDelivered];
  const counts: ReminderRetentionCounts = {
    input: rows.length,
    dismissed,
    pending: pending.length,
    delivered_in_window: deliveredInWindow.length,
    history,
    visible_rows: visible.length,
    represented: visible.reduce((n, r) => n + r.repeat_count, 0),
  };

  // RULE (e), enforced rather than documented. Both directions: every input row
  // is accounted for, and every row that is not history or dismissed is standing
  // on the screen either as itself or inside a count.
  const accounted = counts.dismissed + counts.pending + counts.delivered_in_window + counts.history;
  if (accounted !== counts.input) {
    throw new ReminderRetentionError(
      `retention arithmetic does not add up: ${counts.input} rows in, but ` +
        `${counts.dismissed} dismissed + ${counts.pending} pending + ` +
        `${counts.delivered_in_window} delivered-in-window + ${counts.history} history = ` +
        `${accounted}. A reminder has gone missing from the counts and would vanish from the UI.`,
    );
  }
  if (counts.represented !== counts.pending + counts.delivered_in_window) {
    throw new ReminderRetentionError(
      `retention grouping does not add up: ${counts.visible_rows} visible rows represent ` +
        `${counts.represented} reminders, expected ${counts.pending + counts.delivered_in_window}. ` +
        `A collapsed group is under- or over-counting the rows it stands for.`,
    );
  }

  return { visible, groups, history_count: history, window_days: windowDays, counts };
}
