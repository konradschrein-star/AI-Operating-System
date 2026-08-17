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
  /** HOW MANY ROWS THIS ROW'S ✕ WOULD TAKE OFF THE PANEL, itself included —
   *  this node and its visible sub-agents. Never below 1: a dismissal always
   *  hides at least the row you clicked.
   *
   *  Round 1873, finding 2. One click on the manager's ✕ hid 165 of 166 rows,
   *  with no confirm and no undo, because a dismissal cascades (`resolveCascade`
   *  in forge-control/src/lib/dismissals.ts) and nothing on screen said so. The
   *  panel now guards the click IN PROPORTION to this number — see
   *  `decideXClick` in ./confirm — so it has to be a fact carried on the row
   *  rather than something the handler estimates: it is a prop that changes only
   *  when the row's own subtree changes, which is what keeps
   *  `memo(TeamRowView)` bailing out on a hover sweep (NFU2).
   *
   *  It counts ROWS ON THIS PANEL, and only the ones under THIS row —
   *  `cascadeRowCount` states at length why the manager's project-wide reach is
   *  expressed in words (`widerReach`) rather than folded into this number. */
  hidesRows: number;
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

/** One row of the DISMISSED group — a row this walk withheld, kept so the
 *  panel can PEEK at what it is hiding instead of offering only a fleet-wide
 *  "restore everything" (round 1354 review, A4).
 *
 *  It is a wrapper around a `TeamRow` rather than a flag on it so that nothing
 *  about the visible row model changes: `sameRow`, the wrapper cache and every
 *  identity assertion round 1302 rests on are untouched by peeking. */
export interface HiddenTeamRow {
  row: TeamRow;
  /** True when THIS node's own id is the one in the dismissal set — the row
   *  someone clicked ✕ on. `restore(node.id)` brings it and its whole subtree
   *  back, so it is the row that carries the ↺.
   *
   *  False for a descendant, which is hidden BECAUSE ITS ANCESTOR IS. Deleting
   *  such a row's own dismissal (if it even has one) would leave it hidden
   *  under the parent — a control that changes nothing on screen, which is the
   *  silent no-op NFU6 forbids. It says "restore the parent" instead. A nested
   *  dismissal is not lost: restore the ancestor and the child comes back as a
   *  dismissed root of its own, wearing its own ↺. */
  restorable: boolean;
}

/** What `flattenTeam` produces: the rows to render, how many nodes did not
 *  make it into them because a dismissal covered them, and which ones those
 *  were.
 *
 *  `hiddenCount` exists because the panel's "N dismissed · show" label used to
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
  /** Exactly those skipped nodes, in tree order, at their real depths —
   *  `hiddenRows.length === hiddenCount`, always. The label and the peek list
   *  are therefore two readings of one walk and cannot disagree about what is
   *  hidden. */
  hiddenRows: HiddenTeamRow[];
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
    prev.hidesRows === next.hidesRows &&
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

/** `subtreeSize` counting only what is CURRENTLY ON SCREEN: a node already
 *  covered by a dismissal contributes nothing, and neither does anything under
 *  it (the panel is not rendering it, so hiding it again removes no row). */
function visibleSubtreeSize(node: TeamNode, dismissed: ReadonlySet<string>): number {
  if (dismissed.has(node.id)) return 0;
  let n = 1;
  for (const sub of node.subagents) n += visibleSubtreeSize(sub, dismissed);
  return n;
}

/**
 * The blast radius of one ✕, in rows this panel is showing right now.
 *
 *   • a sub-agent → 1. It has no descendants, by construction.
 *   • a run       → itself plus its visible sub-agents.
 *
 * WHAT IT DELIBERATELY DOES NOT COUNT, and why the manager row says "N+"
 * instead. The server's cascade (`resolveCascade` in
 * forge-control/src/lib/dismissals.ts) reaches further than a subtree when the
 * target is a chat that STARTED a project: every settled run of that project
 * goes too — which is how round 1872's tester turned one click into 174
 * dismissals and 165 vanished rows. This function could add up the settled
 * workers as well, and the first draft of round 1873 did.
 *
 * It was withdrawn for a measured reason. `hidesRows` is a ROW PROP, compared by
 * `sameRow`; a count that reads the manager's SIBLINGS changes the manager's
 * wrapper every time any worker settles or is hidden, which breaks the identity
 * invariant round 1302 established ("one node changed → exactly one fresh
 * wrapper", asserted in scripts/checks/check-team-rows.ts) and makes a row
 * re-render for a fact about a different row. So the count stays local, and the
 * manager's ✕ — which is `kind === "operator"`, the one row this applies to —
 * declares `widerReach` instead: it always takes the confirm, and its words say
 * "and any project this chat started", which is the honest description of a set
 * this panel cannot enumerate anyway (the tree lists the project's CURRENT runs,
 * `ui_dismissals` also collects its finished ones).
 */
export function cascadeRowCount(
  node: TeamNode,
  dismissed: ReadonlySet<string>,
): number {
  return Math.max(1, visibleSubtreeSize(node, dismissed));
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
 *
 * `hiddenRows` is built OUTSIDE the cache, deliberately. The cache exists to
 * make `memo(TeamRowView)` bail out on the list that re-renders every 6s poll;
 * it holds exactly the rows the panel is rendering as its tree, which is the
 * invariant round 1302's identity assertions are written against. Peeked rows
 * are a handful of nodes shown only while the operator is explicitly looking at
 * them, so they get fresh wrappers and re-render with the poll — the cheaper
 * trade than widening a cache whose whole claim is "these are the rendered
 * rows".
 */
export function flattenTeam(
  res: TeamResponse,
  dismissed: ReadonlySet<string>,
  cache?: TeamRowCache,
): FlatTeam {
  const rows: TeamRow[] = [];
  const hiddenRows: HiddenTeamRow[] = [];
  let hiddenCount = 0;
  const prevById = cache?.byId;
  const nextById = cache ? new Map<string, TeamRow>() : null;

  /** Everything under a dismissed node, in the same order and at the same
   *  depths the main list would have used, so the peek list reads as the piece
   *  of the org chart it is rather than as a flat pile. Only the root is
   *  `restorable` — see HiddenTeamRow. */
  const pushHidden = (
    node: TeamNode,
    depth: number,
    parentDescription: string | null,
    isRoot: boolean,
  ): void => {
    hiddenRows.push({
      /* `hidesRows: 0` — a row that is already hidden hides nothing further,
         and its ✕ is not what a peeked row wears anyway (it wears ↺). */
      row: {
        node,
        depth,
        parentDescription,
        hidesRows: 0,
        displayWorkingMs: node.working_ms,
      },
      restorable: isRoot,
    });
    for (const sub of node.subagents) {
      pushHidden(sub, depth + 1, node.description, false);
    }
  };

  const pushSubtree = (
    node: TeamNode,
    depth: number,
    parentDescription: string | null,
  ): void => {
    if (dismissed.has(node.id)) {
      // The whole subtree goes, so the whole subtree counts — and the whole
      // subtree is kept, so "N dismissed · show" shows exactly the N rows it
      // claims. A dismissed id nested under an already-dismissed one is never
      // reached by this branch and therefore never counted twice.
      hiddenCount += subtreeSize(node);
      pushHidden(node, depth, parentDescription, true);
      return;
    }
    const fresh: TeamRow = {
      node,
      depth,
      parentDescription,
      hidesRows: cascadeRowCount(node, dismissed),
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
  return { rows, hiddenCount, hiddenRows };
}

/**
 * How many rows THIS TREE loses when `added` join the dismissal set — round
 * 1874, finding 2.
 *
 * The toast used to print the length of the server's cascade (180) beside a
 * tray that had just grown to 21, and nothing on screen reconciled the two.
 * They measure different things: the cascade is fleet-wide, the tray is this
 * panel. This is the second number, computed the only way that cannot drift
 * from the tray — by running THE SAME WALK the tray's `hiddenCount` comes from,
 * once with the ids and once without, and subtracting.
 *
 * No cache is passed on purpose: this runs on a click, not on a poll, and
 * feeding a second walk into the wrapper cache would replace the identities
 * `memo(TeamRowView)` bails out on (round 1302, L1) for rows nobody re-rendered.
 */
export function rowsHiddenBy(
  res: TeamResponse,
  dismissed: ReadonlySet<string>,
  added: readonly string[],
): number {
  if (added.length === 0) return 0;
  const after = new Set(dismissed);
  for (const id of added) after.add(id);
  if (after.size === dismissed.size) return 0;
  const before = flattenTeam(res, dismissed).rows.length;
  return Math.max(0, before - flattenTeam(res, after).rows.length);
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
