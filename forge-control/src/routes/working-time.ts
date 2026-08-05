/**
 * working-time.ts — the ONE definition of `working_ms` (U5).
 *
 * Nothing here talks to the database and nothing here is a route (it lives in
 * `routes/` because that is where phase 300's route-local read-side logic
 * lives, next to `agents-shared.ts`). Round 305's `GET /api/chat/:id/team`
 * imports it; this round only ships and proves the module.
 *
 * ── The model (13-ui-v3-architecture.md §4) ─────────────────────────────
 *
 *   working_ms = Σ gap_i   over consecutive thread-entry timestamps,
 *                          for every gap_i where 0 ≤ gap_i ≤ CAP
 *
 * A gap ABOVE the cap contributes **0**, not CAP. That is the whole point of
 * the number: a two-hour silence is not two minutes of work, it is a queue
 * wait, a stuck run, or a human being asked a question — none of which is the
 * agent working. `min()` appears in exactly one place: the running-node
 * extension below, where the trailing open interval `now − last_ts` IS live
 * work up to the cap.
 *
 * Running nodes:   working_ms += min(now − last_ts, CAP)
 * Settled nodes:   computed once from their own entries; they never see `now`
 *                  (that is the frozen-time guarantee of phases 1–2, restated
 *                  for this unit — a settled row's working time is a constant).
 *
 * ── Why CAP = 120 s ─────────────────────────────────────────────────────
 *
 * A working Claude Code session emits thread events (tool calls, tool
 * results, assistant text) far more often than once every two minutes;
 * silences longer than that are overwhelmingly waits — queue, lock, stuck
 * process, awaiting Konrad. 120 s sits above the noise floor of a slow tool
 * call (a long build, a big grep) and below any real idle period.
 *
 * It is a HEURISTIC, and it is deliberately a visible one:
 *   - the field is named `working_ms`, never `elapsed_ms`;
 *   - the UI labels it "working", never "elapsed";
 *   - the constant lives here, once, and is interpolated into the SQL path
 *     below so the two paths cannot drift apart.
 *
 * Rejected alternatives (13 §4): executor-instrumented true CPU time — needs
 * changes to engine files that are forbidden this cycle; wall-clock — the
 * exact lie Konrad complained about ("elapsed times are still growing even
 * though they are done").
 *
 * ── Two paths, one number ───────────────────────────────────────────────
 *
 * `workingMsFromTimestamps()` is the pure, unit-tested core. `WORKING_MS_SQL`
 * computes the SAME sum Postgres-side so the team endpoint does not ship
 * megabyte threads to node (measured by the planner: 30 ms for all runs of
 * this project). They are proved to agree over real data in
 * `docs/plan/artifacts/phase300/working-time-agreement.md`; the differences
 * that remain are enumerated there and in the comment on `workingMsSql()`.
 * The JS core is the definition of truth; the SQL is an optimisation of it.
 */

/**
 * Gap ceiling, in milliseconds. A gap between consecutive thread entries
 * longer than this counts as idle and contributes nothing. See the header
 * for the rationale — this is a documented heuristic, not a measurement.
 */
export const WORKING_TIME_CAP_MS = 120_000;

/**
 * Where a `working_ms` value came from, per 13 §4's fallback flagging.
 *
 * - `"thread"` — summed from real thread-entry timestamps. Precise.
 * - `"rollup"` — the sub-agent slice was unavailable, so the number is a
 *   wall-clock span from `subagents_v2` started/updated stamps. Imprecise BY
 *   CONSTRUCTION and therefore flagged, so the UI can mark it rather than
 *   present a guess as a measurement.
 */
export type WorkingMsSource = "thread" | "rollup";

/** The two legal `working_ms_source` values, for validation at the wire edge. */
export const WORKING_MS_SOURCES: readonly WorkingMsSource[] = ["thread", "rollup"];

/** Full result of a working-time computation. */
export interface WorkingTime {
  /** Milliseconds of attributed work. Integer, never negative. */
  working_ms: number;
  /** Provenance, per 13 §4. */
  working_ms_source: WorkingMsSource;
  /**
   * Timestamps that could not be parsed and were skipped. A caller that
   * cares about precision should surface a marker when this is non-zero —
   * the number is still computed (skipping is not zeroing), but it was
   * computed over fewer points than the thread contains.
   */
  skipped_ts: number;
}

/** Options shared by the computation entry points. */
export interface WorkingTimeOpts {
  /**
   * `Date.now()` for a RUNNING node — adds the open trailing interval
   * `min(now − last_ts, CAP)`. Omit (or pass undefined) for a settled node:
   * a settled node must never see a clock, or it un-freezes.
   */
  runningNowMs?: number;
}

/**
 * Parse one thread timestamp to epoch milliseconds, or `null` if it is not a
 * timestamp at all. Accepts both shapes seen in `runs.thread`: ISO-8601
 * (`2026-08-05T06:47:23.678Z`) and Postgres's own rendering
 * (`2026-07-30 16:21:19.674825+00`) — the latter parses in V8, verified in
 * `scripts/checks/check-working-time.ts`.
 */
export function parseWorkingTs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The unit-testable core: `working_ms` from a list of thread-entry
 * timestamps, in thread order.
 *
 * Malformed / unparseable / non-string timestamps are SKIPPED — not zeroed,
 * not thrown. The surviving stamps stay consecutive, so a bad entry in the
 * middle joins its neighbours into one gap (which the cap then judges like
 * any other). The count of skipped entries is returned so a caller can flag
 * the imprecision instead of silently trusting the number.
 *
 * Out-of-order stamps produce a negative gap; a negative gap contributes 0.
 * The result is therefore monotonically non-negative, always.
 */
export function workingTimeFromTimestamps(
  tsList: readonly unknown[],
  opts: WorkingTimeOpts = {},
): WorkingTime {
  let workingMs = 0;
  let skipped = 0;
  let prevMs: number | null = null;
  let lastMs: number | null = null;

  for (const raw of tsList) {
    const ms = parseWorkingTs(raw);
    if (ms === null) {
      skipped += 1;
      continue;
    }
    if (prevMs !== null) {
      const gap = ms - prevMs;
      // 0 ≤ gap ≤ CAP counts in full; anything else (idle, or clock skew
      // running the thread backwards) counts as nothing.
      if (gap >= 0 && gap <= WORKING_TIME_CAP_MS) workingMs += gap;
    }
    prevMs = ms;
    lastMs = ms;
  }

  // The one place min() applies: a running node's open trailing interval.
  if (opts.runningNowMs !== undefined && lastMs !== null) {
    const open = opts.runningNowMs - lastMs;
    if (open > 0) workingMs += Math.min(open, WORKING_TIME_CAP_MS);
  }

  return { working_ms: workingMs, working_ms_source: "thread", skipped_ts: skipped };
}

/**
 * `workingTimeFromTimestamps()` reduced to the number, for the common caller
 * that has already decided it does not need the provenance fields. The
 * signature pinned by the round-303 brief; `workingTimeFromTimestamps` is the
 * same computation with the skipped-timestamp count a caller needs to flag
 * imprecision (U5 asks for both, and one function cannot return two things).
 */
export function workingMsFromTimestamps(
  tsList: readonly unknown[],
  opts: WorkingTimeOpts = {},
): number {
  return workingTimeFromTimestamps(tsList, opts).working_ms;
}

/**
 * Fallback for a sub-agent whose thread slice is unavailable (13 §4): the
 * wall-clock span between its `subagents_v2` started and updated/ended
 * stamps, flagged `"rollup"`.
 *
 * The CAP is deliberately NOT applied here. The cap judges *gaps between
 * events*; a rollup has no events to put gaps between, so capping it would
 * report every sub-agent that ran longer than two minutes as exactly two
 * minutes — a worse lie than the honest wall-clock span. The imprecision is
 * carried by `working_ms_source: "rollup"` instead, which is what the flag
 * exists for.
 *
 * A running rollup passes `runningNowMs` and no end stamp. Missing or
 * unparseable stamps yield 0 (still flagged `"rollup"`, with the count).
 */
export function workingTimeFromRollup(
  startedAt: unknown,
  endedAt: unknown,
  opts: WorkingTimeOpts = {},
): WorkingTime {
  const startMs = parseWorkingTs(startedAt);
  const endMs = parseWorkingTs(endedAt);
  let skipped = 0;
  if (startMs === null && startedAt !== null && startedAt !== undefined) skipped += 1;
  if (endMs === null && endedAt !== null && endedAt !== undefined) skipped += 1;

  const stopMs = endMs ?? (startMs !== null ? opts.runningNowMs : undefined);
  const span = startMs !== null && stopMs !== undefined ? stopMs - startMs : 0;

  return {
    working_ms: span > 0 ? span : 0,
    working_ms_source: "rollup",
    skipped_ts: skipped,
  };
}

/**
 * Matches the timestamp shapes `parseWorkingTs()` accepts, as a POSIX regex
 * for the SQL path: `YYYY-MM-DD` then `T` or a space, then `HH:MM:SS`.
 * Written with `[0-9]` rather than `\d` on purpose — this string is embedded
 * in a JS template literal, where `\d` would silently become `d`.
 */
const SQL_TS_SHAPE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}";

/**
 * The SQL half of the same definition: a scalar sub-select computing
 * `working_ms` over a `jsonb` thread column, so the team endpoint can read
 * one number per run instead of shipping megabyte threads to node.
 * (Planner measurement: 30 ms for every run of this project.)
 *
 * @param threadExpr the jsonb thread expression in the enclosing query —
 *   the default assumes `FROM runs r`. Pass your own alias if it differs.
 * @returns a parenthesised scalar expression, safe to drop into a SELECT
 *   list. It interpolates NOTHING from user input: the only interpolated
 *   values are `WORKING_TIME_CAP_MS`, the fixed regex above, and the caller's
 *   own literal column expression. Do not pass request data as `threadExpr`.
 *
 * Differences from the JS core, stated rather than hidden:
 *
 *  1. **Over-cap gaps.** The planner's draft used `least(gap, CAP)`, which
 *     credits an over-cap gap with a full CAP. That contradicts the binding
 *     model, so this fragment uses a `CASE` instead: `0 ≤ gap ≤ CAP` counts
 *     in full, everything else counts 0 — exactly what the JS core does.
 *  2. **Ordering.** `WITH ORDINALITY` instead of a bare `row_number() OVER ()`:
 *     array order is then guaranteed by the standard rather than by the
 *     observed behaviour of a set-returning function in a window frame.
 *  3. **Malformed timestamps.** `::timestamptz` throws on garbage and would
 *     fail the whole query, so entries whose `ts` does not match
 *     `SQL_TS_SHAPE` are filtered out BEFORE the cast and before the
 *     re-numbering — the same "skip, don't zero, don't throw" semantics as
 *     the core, and the surviving stamps stay consecutive. The count of
 *     skipped entries is NOT returned by this path (a scalar sub-select
 *     returns one number); a caller that needs `skipped_ts` must use the JS
 *     core. Divergence risk: a string that matches the shape but is not a
 *     real date (`2026-13-45T99:99:99`) still throws in Postgres where the
 *     core would skip it. That is an explicit loud failure, not a wrong
 *     number — the caller should catch it and fall back to the JS core.
 *  4. **Running nodes.** This fragment sums entry gaps only. The running
 *     extension needs `now`, which belongs on the node side where the frozen
 *     /live decision is already made: add
 *     `workingMsRunningExtension(lastTs, nowMs)` to the SQL result for
 *     running rows.
 */
export function workingMsSql(threadExpr = "r.thread"): string {
  return `(
    SELECT coalesce(sum(
             CASE WHEN g.gap_ms >= 0 AND g.gap_ms <= ${WORKING_TIME_CAP_MS}
                  THEN g.gap_ms ELSE 0 END), 0)::bigint
      FROM (
        SELECT extract(epoch FROM (p.ts - lag(p.ts) OVER (ORDER BY p.ord))) * 1000 AS gap_ms
          FROM (
            SELECT (e.val->>'ts')::timestamptz AS ts, e.ord
              FROM jsonb_array_elements(${threadExpr}) WITH ORDINALITY AS e(val, ord)
             WHERE e.val->>'ts' ~ '${SQL_TS_SHAPE}'
          ) p
      ) g
  )`;
}

/**
 * The fragment for the default `FROM runs r` shape. One constant so callers
 * that do not need a custom alias cannot accidentally write a second
 * definition of the number.
 */
export const WORKING_MS_SQL = workingMsSql();

/**
 * The running-node extension, separated so it can be added to EITHER path's
 * entry-gap sum: `min(now − last_ts, CAP)`, and 0 if the last stamp is
 * missing, unparseable, or in the future.
 *
 * Call this ONLY for a run whose status is running. Passing a settled run's
 * last stamp would make its working time grow with the wall clock — the
 * exact bug U5 exists to kill.
 */
export function workingMsRunningExtension(lastTs: unknown, nowMs: number): number {
  const lastMs = parseWorkingTs(lastTs);
  if (lastMs === null) return 0;
  const open = nowMs - lastMs;
  return open > 0 ? Math.min(open, WORKING_TIME_CAP_MS) : 0;
}
