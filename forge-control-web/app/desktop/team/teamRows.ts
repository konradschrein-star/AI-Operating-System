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

/** What `flattenTeam` produces: the rows to render, and how many nodes did not
 *  make it into them because a dismissal covered them.
 *
 *  `hiddenCount` exists because the panel's "N hidden · show" label used to
 *  count DISMISSED IDS, which is a different number in both directions (round
 *  505 finding #3): dismissing a worker that owns two sub-agents hides three
 *  rows and counted 1, while a localStorage key holding ids that match nothing
 *  in this tree hid nothing and counted all of them. The only honest source
 *  for "how many rows is this panel currently hiding" is the walk that did the
 *  hiding, so it reports it. */
export interface FlatTeam {
  rows: TeamRow[];
  /** Nodes skipped by `dismissed`, INCLUDING the sub-agents that went down
   *  with a dismissed parent. Zero when nothing in `dismissed` matches this
   *  tree, no matter how many ids it holds. */
  hiddenCount: number;
}

/**
 * The wrapper store that lets `memo(TeamRowView)` bail out (round 1302, L1).
 *
 * `flattenTeam` allocates a `TeamRow` wrapper per node per response. React
 * Query's structural sharing keeps the inner `node` object IDENTICAL across
 * polls for every row whose data did not change — round 1301 measured 428 of
 * 432 compares with `prev.row.node === next.row.node` — but the fresh wrapper
 * threw that identity away, so the shallow compare in `memo` failed on
 * `prev.row !== next.row` for **all** 108 rows, on **every** poll, and the
 * panel re-rendered 432 rows per 25 s to change 4 of them.
 *
 * This cache is the fix, and it is deliberately NOT hidden inside the module:
 * `flattenTeam` stays a pure function of (response, dismissals, cache) with no
 * ambient state, which is what keeps `scripts/checks/check-team-rows.ts` able
 * to assert identity directly — call twice with the same cache, get the same
 * objects back; call twice with two caches, get two sets. A module-level Map
 * would have made "the same input twice" mean different things depending on
 * what ran before it.
 *
 * `byId` is REPLACED on every walk rather than mutated in place, so a node
 * that leaves the tree (a worker whose project is gone, a dismissed subtree)
 * takes its wrapper with it. The cache therefore cannot outgrow the tree.
 */
export interface TeamRowCache {
  byId: Map<string, TeamRow>;
}

/** A fresh, empty wrapper cache. One per mounted panel. */
export function createTeamRowCache(): TeamRowCache {
  return { byId: new Map() };
}

/** Would rendering `prev` be indistinguishable from rendering `next`?
 *
 *  Every field a `TeamRow` carries, compared by identity — `node` included,
 *  which is the whole point: an unchanged node arrives as the SAME object from
 *  react-query, so this is one pointer compare, not a deep walk. A row whose
 *  node object changed is treated as new even if its contents happen to match,
 *  because the cheap answer is the honest one here: re-rendering a row that
 *  did not need it costs a frame, claiming equality that does not hold costs
 *  the truth on screen. */
function sameRow(prev: TeamRow, next: TeamRow): boolean {
  return (
    prev.node === next.node &&
    prev.depth === next.depth &&
    prev.parentDescription === next.parentDescription &&
    prev.displayWorkingMs === next.displayWorkingMs
  );
}

/** Every node in this subtree, the node itself included — what a dismissal at
 *  this node actually removes from the panel. */
function subtreeSize(node: TeamNode): number {
  let n = 1;
  for (const sub of node.subagents) n += subtreeSize(sub);
  return n;
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
 *
 * `cache` is optional and changes nothing about WHAT this returns — only the
 * object identities. With a cache, a row whose every field is unchanged comes
 * back as the PREVIOUS object, so `memo(TeamRowView)` bails out on it (see
 * TeamRowCache above). Without one, every wrapper is fresh, which is the old
 * behaviour and is what the ordering/dismissal assertions exercise.
 */
export function flattenTeam(
  res: TeamResponse,
  dismissed: ReadonlySet<string>,
  cache?: TeamRowCache,
): FlatTeam {
  const rows: TeamRow[] = [];
  let hiddenCount = 0;
  const prevById = cache?.byId;
  const nextById = cache ? new Map<string, TeamRow>() : null;

  const pushSubtree = (
    node: TeamNode,
    depth: number,
    parentDescription: string | null,
  ): void => {
    if (dismissed.has(node.id)) {
      // The whole subtree goes, so the whole subtree counts. A dismissed id
      // nested under an already-dismissed one is never reached and therefore
      // never counted twice.
      hiddenCount += subtreeSize(node);
      return;
    }
    const fresh: TeamRow = {
      node,
      depth,
      parentDescription,
      displayWorkingMs: node.working_ms,
    };
    const prev = prevById?.get(node.id);
    const row = prev !== undefined && sameRow(prev, fresh) ? prev : fresh;
    nextById?.set(node.id, row);
    rows.push(row);
    for (const sub of node.subagents) {
      pushSubtree(sub, depth + 1, node.description);
    }
  };

  pushSubtree(res.manager, 0, null);
  for (const worker of res.workers) {
    pushSubtree(worker, 1, res.manager.description);
  }
  if (cache && nextById) cache.byId = nextById;
  return { rows, hiddenCount };
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
