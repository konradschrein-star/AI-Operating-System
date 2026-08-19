/**
 * Client for the RULED reminders retention view — phase 6, task D.
 *
 * Lives beside `api-perf.ts` rather than inside `api.ts` for the reason
 * 02-architecture.md §0.3 gives: each lane owns `app/api-<lane>.ts` and `api.ts`
 * is never modified, so five concurrent lanes never contend on one client file.
 * `api.ts` is imported from, never edited — `Reminder` and the existing
 * `dismissReminder` come from there unchanged, because dismissal is the one
 * retention verb that already worked and this phase does not touch it.
 *
 * WHAT IT TALKS TO. `GET /api/reminders?view=window&days=N`, the third branch of
 * routes/reminders.ts. The two older branches (the unfiltered page and the R705
 * `?contains=` dedup lookup) are untouched and are still served by `api.ts`.
 *
 * WHY IT HARD-ERRORS ON A MISSING `view` KEY. A forge-control that predates this
 * branch ignores `?view=` and answers the UNFILTERED page: 100 rows, oldest
 * first, no history count. Rendered without a check that is not an error — it is
 * a July smoke test at the top of the screen and a history fold that says 0,
 * which is exactly the surface Konrad complained about, restored silently. This
 * is the same version handshake `filter` performs for `?contains=` (R705), and
 * it exists because "the server ignored my parameter" and "there is nothing
 * there" must never render the same.
 */

import type { Reminder } from "./api";

const ROOT = "/api/proxy";

/** Same shape as api.ts's private `getJson` — copied rather than exported from
 *  there, because this lane may not modify api.ts. A failed request throws with
 *  the status and the path; no default, no empty array (N1). */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

/** A row as the retention fold renders it. `repeat_count` is 1 unless a repeat
 *  cluster was collapsed — which, under the current ruling, never happens (see
 *  `ReminderRetentionView.groups` below). */
export type WindowedReminder = Reminder & {
  repeat_count: number;
  repeat_ids: string[];
};

/** A detected cluster of identical texts inside the window. REPORTED always,
 *  COLLAPSED only if Konrad rules for escalation option 4 — `collapsed` says
 *  which, and the surface may not infer one from the other. */
export interface ReminderRepeatGroup {
  text: string;
  count: number;
  ids: string[];
  newest_due_at: string;
  collapsed: boolean;
}

/** Every reminder handed in, placed in exactly one bucket. The invariant the
 *  server enforces and the surface leans on: `dismissed + pending +
 *  delivered_in_window + history === input`. */
export interface ReminderRetentionCounts {
  input: number;
  dismissed: number;
  pending: number;
  delivered_in_window: number;
  history: number;
  visible_rows: number;
  represented: number;
}

export interface ReminderWindowView {
  reminders: WindowedReminder[];
  window_days: number;
  history_count: number;
  groups: ReminderRepeatGroup[];
  counts: ReminderRetentionCounts;
}

/** The ruled default: pending + the last 7 days of delivered
 *  (reminders-policy-escalation.md §3). */
export const REMINDER_WINDOW_DEFAULT_DAYS = 7;

/**
 * The window the "show history" fold asks for — 100 years, i.e. the whole table.
 *
 * Expanding by widening the window rather than by calling a second "history"
 * endpoint is deliberate: one code path decides what a visible row is, so the
 * open list and the expanded list can never disagree about a row, and the
 * expanded view still counts (`history_count` simply becomes 0). Must stay ≤ the
 * server's `REMINDER_VIEW_MAX_DAYS`, which rejects anything larger with a 400.
 */
export const REMINDER_WINDOW_ALL_DAYS = 36_500;

/** Server payload for the third branch. `view` is the version handshake. */
interface WindowResponse {
  count?: number;
  reminders?: WindowedReminder[];
  view?: {
    mode?: string;
    window_days?: number;
    history_count?: number;
    groups?: ReminderRepeatGroup[];
    counts?: ReminderRetentionCounts;
  };
}

export const fetchRemindersWindow = async (
  days: number = REMINDER_WINDOW_DEFAULT_DAYS,
): Promise<ReminderWindowView> => {
  if (!Number.isInteger(days) || days < 1 || days > REMINDER_WINDOW_ALL_DAYS) {
    throw new Error(
      `fetchRemindersWindow: days must be a whole number between 1 and ${REMINDER_WINDOW_ALL_DAYS}, got ${String(days)}`,
    );
  }
  const r = await getJson<WindowResponse>(`/reminders?view=window&days=${days}`);
  const v = r.view;
  if (!v || v.mode !== "window") {
    throw new Error(
      `GET /reminders?view=window returned no view block (mode=${JSON.stringify(v?.mode)}). ` +
        `This forge-control predates the phase-6 retention branch and answered the unfiltered ` +
        `100-row page instead — rendering it would silently restore the oldest-first list with ` +
        `a history count of 0.`,
    );
  }
  if (
    !Array.isArray(r.reminders) ||
    typeof v.window_days !== "number" ||
    typeof v.history_count !== "number" ||
    !v.counts
  ) {
    throw new Error(
      `GET /reminders?view=window returned a malformed view: reminders=${typeof r.reminders}, ` +
        `window_days=${typeof v.window_days}, history_count=${typeof v.history_count}, ` +
        `counts=${typeof v.counts}. Not defaulted to zero — a missing count and a real zero ` +
        `must not look the same on screen.`,
    );
  }
  return {
    reminders: r.reminders,
    window_days: v.window_days,
    history_count: v.history_count,
    groups: v.groups ?? [],
    counts: v.counts,
  };
};
