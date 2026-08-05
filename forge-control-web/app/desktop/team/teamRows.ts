/** The team tree, flattened — and the one place client-side time policy lives.
 *
 *  13-ui-v3-architecture.md §6 asks for "one flat render pass over a memoized
 *  array … no recursive component nesting; depth → padding-left". This module
 *  produces that array. It is pure: no React, no DOM, no clock of its own
 *  (every `now` arrives as an argument), which is what lets
 *  `scripts/checks/check-team-rows.ts` assert it directly under tsx.
 */

import { parseTs } from "../live/agentsApi";
import type { TeamNode, TeamResponse } from "./teamApi";

/** How far a row is indented, in levels. The manager is 0; anything hanging
 *  under it is its parent's depth + 1. Sub-agents never nest further, so 2 is
 *  the ceiling for a worker's children — but the type stays `number` because
 *  depth is derived from lineage, not asserted from a literal union. */
export interface TeamRow {
  node: TeamNode;
  depth: number;
  /** The parent node's `description`, carried down so a row can name its
   *  lineage in a native `title` attribute with no lookup and no React state
   *  (13 §6: hover is CSS + `title`, never a mounted tooltip). Null on the
   *  manager, which has no parent. */
  parentDescription: string | null;
  /** The working-time value this row displays BEFORE any client
   *  interpolation: `node.working_ms` verbatim, null included.
   *
   *  It exists so that `flattenTeam` is the only site that reads working time
   *  off a node. `interpolatedWorkingMs` consumes this field, the leaf time
   *  component consumes that — so a future change to what a row is allowed to
   *  show (say, suppressing time on settled rows) has exactly one place to
   *  happen instead of being scattered across the render tree. */
  displayWorkingMs: number | null;
}

/**
 * The whole tree as ONE ordered array.
 *
 * Order — every node is immediately followed by its own children, so reading
 * the array top to bottom reads the org chart top to bottom:
 *
 *   manager                        depth 0
 *     manager's sub-agents         depth 1
 *   worker A                       depth 1
 *     worker A's sub-agents        depth 2
 *   worker B                       depth 1
 *     …
 *
 * The manager's own sub-agents are included deliberately. The operator chat is
 * a real Claude Code session and spawns Task sub-agents like any worker does;
 * dropping them would hide exactly the rows Konrad asked to see ("whether
 * these are sub-agents … or actually whole Claude Code sessions"). They sit at
 * depth 1 by the same rule as everyone else: one level under their parent.
 *
 * `dismissed` filters by node id. Dismissing a node takes its sub-agents with
 * it — they cannot outlive the row they hang under, and leaving orphans
 * indented under nothing would misread as a new top-level agent. Dismissal is
 * reversible (see ./dismissals), so this hides rows; it never destroys data.
 */
export function flattenTeam(
  res: TeamResponse,
  dismissed: ReadonlySet<string>,
): TeamRow[] {
  const rows: TeamRow[] = [];

  const pushSubtree = (
    node: TeamNode,
    depth: number,
    parentDescription: string | null,
  ): void => {
    if (dismissed.has(node.id)) return;
    rows.push({
      node,
      depth,
      parentDescription,
      displayWorkingMs: node.working_ms,
    });
    for (const sub of node.subagents) {
      pushSubtree(sub, depth + 1, node.description);
    }
  };

  pushSubtree(res.manager, 0, null);
  for (const worker of res.workers) {
    pushSubtree(worker, 1, res.manager.description);
  }
  return rows;
}

/** Ceiling on client-side interpolation, in ms.
 *
 *  The panel polls the team endpoint every 5-8s (NFU3) and each response
 *  replaces the value outright, so in practice the clamp is never reached. It
 *  exists for the case where polling stalls — a dropped connection, a
 *  backgrounded tab — where an unbounded `now - responseNow` would keep adding
 *  wall-clock to a number that is explicitly NOT wall-clock. 15s also keeps
 *  the client's addition strictly under the server's own 120s per-gap working
 *  cap (13 §4), so interpolation can never invent time the server would have
 *  refused to count. */
export const CLIENT_INTERPOLATION_CAP_MS = 15_000;

/** The server clock at response time, in ms. NaN if `now` is unparsable —
 *  callers should treat that as "cannot interpolate" and render the frozen
 *  base value rather than guessing an anchor. */
export function responseNowMs(res: TeamResponse): number {
  return parseTs(res.now);
}

/**
 * What a row's working time reads RIGHT NOW.
 *
 * Three rules, in order:
 *
 *  1. `displayWorkingMs === null` → null. Unknown stays unknown; there is no
 *     value to grow from and inventing one would print "0s" for "we could not
 *     measure this" (NFU6).
 *  2. `node.settled` → the value UNCHANGED, at every clock, forever (U16).
 *     This is the frozen truth the whole project turns on: a finished agent's
 *     number is history, not a stopwatch. No `now`, no extension, no
 *     exceptions.
 *  3. running → `displayWorkingMs + clamp(nowMs - responseNowMs, 0, CAP)`.
 *     The row keeps moving between polls so it looks alive; the next response
 *     replaces the whole value, so drift cannot accumulate across polls.
 *
 * A non-finite `responseNowMs` (unparsable `now`) yields no extension rather
 * than NaN — the row shows its last honest value instead of "—".
 */
export function interpolatedWorkingMs(
  row: TeamRow,
  responseNow: number,
  nowMs: number,
): number | null {
  const base = row.displayWorkingMs;
  if (base === null) return null;
  if (row.node.settled) return base;
  if (!Number.isFinite(responseNow) || !Number.isFinite(nowMs)) return base;
  const elapsed = Math.min(
    Math.max(0, nowMs - responseNow),
    CLIENT_INTERPOLATION_CAP_MS,
  );
  return base + elapsed;
}
