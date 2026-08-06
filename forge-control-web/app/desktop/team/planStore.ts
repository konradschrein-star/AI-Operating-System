/** The U27 plan store: one array of nodes, and three pure projections over it
 *  (16-ui-v3-graph-research.md §1, 13-ui-v3-architecture.md §7).
 *
 *  THE CONTRACT, and why it is worth a file of its own: every surveyed agent
 *  system converges on tasks-as-nodes plus a dependency edge list, and every
 *  monitoring view is a pure projection of that one structure. The Kanban
 *  (U25) is `groupPlanPhases`. The progress bar is `planProgress`. A future
 *  React-Flow toggle is `planEdges`, which is three lines long. There is no
 *  second store, no reshaping step, and no endpoint beyond `/plan` — that is
 *  the whole claim of U27, and `planEdges` is shipped and covered here to
 *  prove it before anything renders it.
 *
 *  No React, no JSX, no colour: `scripts/checks/check-plan-store.ts` imports
 *  this directly under tsx, and the component turns a token NAME into a token
 *  VALUE — the same split ./TeamRow.tsx and ./live/agentsApi.ts already use.
 *
 *  NO NEW RUNTIME DEPENDENCY (NFU8). `@xyflow/react` and `elkjs` are
 *  explicitly not added this project; the point of the shape is that adding
 *  them later costs nothing here.
 */

import type { PlanPhase, PlanResponse } from "./planApi";

/**
 * The U27 node, verbatim from 16 §1.
 *
 * `status` is a plain `string`, NOT the narrowed union 16 §1 sketches. That is
 * a deliberate departure and the only one. The DB's own CHECK constraint
 * (db/migrations/0030_coding_projects.sql:44) admits six values today, but a
 * migration can widen it tomorrow, and a union would force an unrecognised
 * value through a `default:` branch into a neighbouring bucket — "skipped"
 * quietly rendered as "pending", a count that no longer matches the rail.
 * An unknown status must reach the screen as its own literal: never coerced,
 * never dropped (NFU6). The type is what makes that non-negotiable.
 */
export type PlanNode = {
  id: string;
  title: string;
  status: string;
  round: number;
  role: string;
  deps: string[];
  meta: { tier?: string; run_id?: string };
};

/** One hundreds-block, ready to render as a Kanban column (U25). Counts are
 *  carried on the group so a column header never re-walks its own nodes. */
export interface PlanPhaseGroup {
  round_base: number;
  title?: string;
  doc_path?: string;
  nodes: PlanNode[];
  /** Nodes in this group with `status === "done"`. Same rule as
   *  `planProgress` — see the SQL quoted there. */
  done: number;
  total: number;
}

export interface PlanEdge {
  source: string;
  target: string;
}

/** The literal `planProgress` and every group counter test against. One
 *  constant so the string is written once. */
const DONE = "done";

/**
 * The status vocabulary the engine can emit TODAY, in lifecycle order.
 *
 * Straight off the table constraint, not off a hopeful reading of the engine:
 *   status varchar(16) NOT NULL DEFAULT 'pending'
 *     CHECK (status IN ('pending','ready','running','done','failed','blocked'))
 *   — db/migrations/0030_coding_projects.sql:44-45
 *
 * On this project's real corpus the live distribution is done/pending/running
 * = 50/9/1; `ready` is transient (project-tick promotes and claims in the same
 * pass) and `failed`/`blocked` are real but rare.
 *
 * This list is for LABELLING and for tests — it is NOT a filter. Nothing in
 * this module rejects, warns about, or normalises a status outside it.
 */
export const KNOWN_STATUSES: readonly string[] = [
  "pending",
  "ready",
  "running",
  "done",
  "failed",
  "blocked",
];

/** The token names ./TeamRow.tsx already maps to colours in its `STATUS_COLOR`
 *  record. Hand-written union rather than an import of app/tokens.ts, exactly
 *  as `RoleTokenName` in ./live/agentsApi.ts is: this module names a colour,
 *  it never holds one. */
export type StatusTokenName = "info" | "ok" | "bleed" | "stuck" | "textMuted" | "textFaint";

/**
 * Task status → the SAME token name the team tree's status dots already wear.
 *
 * Read off `STATUS_COLOR` in ./TeamRow.tsx (running→info, planned/queued→
 * textMuted, done/completed→ok, failed→bleed, stuck→stuck, fallback→textFaint)
 * and translated into the project_tasks vocabulary. It is one colour language
 * for two row types, not two:
 *
 *   pending, ready → textMuted   both are "not started"; the chip's own label
 *                                carries the difference between them, and a
 *                                seventh colour to say it would be a second
 *                                vocabulary for no new fact.
 *   running        → info        (/live's AgentActivity.tsx uses `accent` for
 *                                running runs; the right panel uses `info`.
 *                                This file belongs to the right panel, so it
 *                                follows TeamRow. If the two ever converge,
 *                                they converge in TeamRow first.)
 *   done           → ok
 *   failed         → bleed
 *   blocked        → stuck       must NOT read as running; `stuck` is the
 *                                token TeamRow already reserves for that.
 *   anything else  → textFaint   TeamRow's own fallback, unchanged. Note this
 *                                lands `cancelled` on textFaint, which is
 *                                where TeamRow puts it explicitly — the
 *                                neutral answer happens to be the right one.
 *
 * Total by construction: every string has an answer, and the answer for an
 * unknown one is visibly neutral rather than a confident lie.
 */
const STATUS_TOKEN: Record<string, StatusTokenName> = {
  pending: "textMuted",
  ready: "textMuted",
  running: "info",
  done: "ok",
  failed: "bleed",
  blocked: "stuck",
};

export function statusTokenName(status: string): StatusTokenName {
  return STATUS_TOKEN[status] ?? "textFaint";
}

/** The hundreds-block of a round — the SAME arithmetic the server applies in
 *  `groupPlanPhases` (forge-control/src/routes/chat.ts). Exported because the
 *  check exercises it and because a caller that needs a node's column should
 *  not re-type the expression. */
export function phaseBase(round: number): number {
  return Math.floor(round / 100) * 100;
}

/**
 * Flatten the wire response into the node array everything else reads.
 *
 * SERVER ORDER IS PRESERVED, phase by phase and task by task. The server
 * ordered them `ORDER BY round, created_at` (chat.ts:`PLAN_TASKS_SQL`) so that
 * the four siblings of one round keep the order the planner wrote them in; a
 * client-side re-sort would throw that away and gain nothing.
 *
 * `meta.tier` is set only when the wire carries one — `tier: null` means the
 * engine will pick a default, so the key is ABSENT rather than present-and-
 * empty. `meta.run_id` is in the U27 contract and the wire does NOT carry it
 * today (chat.ts's PlanTask has no run_id column in `PLAN_TASKS_SQL`), so it
 * is left optional and unset; the day the server adds it, one line here fills
 * it and no consumer changes.
 */
export function toPlanNodes(res: PlanResponse): PlanNode[] {
  const nodes: PlanNode[] = [];
  for (const phase of res.phases) {
    for (const t of phase.tasks) {
      const meta: PlanNode["meta"] = {};
      if (t.tier != null) meta.tier = t.tier;
      nodes.push({
        id: t.id,
        title: t.title,
        status: t.status,
        round: t.round,
        role: t.role,
        // Copied, not aliased: the store owns its arrays, so a consumer that
        // sorts or splices deps cannot reach back into the fetch response.
        deps: [...t.deps],
        meta,
      });
    }
  }
  return nodes;
}

/**
 * Group nodes into Kanban columns, ascending by block.
 *
 * `round_base`, `title` and `doc_path` come from `res.phases` — they are NOT
 * re-derived. The server decided which task titles a block, and whether a file
 * in docs/plan/ carries this block's number (chat.ts:`matchPhaseDoc`, which
 * matches on digit runs and refuses to guess); a client that re-derived either
 * would eventually disagree with the server and 404 in the reader's face.
 *
 * Membership, on the other hand, is driven by the NODES, so no node can fall
 * out of the panel: the lookup into `res.phases` is by the block a node's own
 * round names. For any response that actually came from `/plan` the two agree
 * exactly — the server grouped by the same expression. A node the server did
 * not place still gets a column, carrying its derived base and no title or
 * doc_path, rather than disappearing (NFU6).
 *
 * A server phase with zero tasks yields no column. That is not a lost fact:
 * the server only ever creates a phase from a task row, so a task-less phase
 * cannot appear on the wire.
 */
export function groupPlanPhases(nodes: PlanNode[], res: PlanResponse): PlanPhaseGroup[] {
  const wire = new Map<number, PlanPhase>();
  for (const phase of res.phases) wire.set(phase.round_base, phase);

  const groups = new Map<number, PlanPhaseGroup>();
  for (const node of nodes) {
    const base = phaseBase(node.round);
    let group = groups.get(base);
    if (!group) {
      const source = wire.get(base);
      group = { round_base: source ? source.round_base : base, nodes: [], done: 0, total: 0 };
      if (source?.title !== undefined) group.title = source.title;
      if (source?.doc_path !== undefined) group.doc_path = source.doc_path;
      groups.set(base, group);
    }
    group.nodes.push(node);
    group.total += 1;
    if (node.status === DONE) group.done += 1;
  }

  return [...groups.values()].sort((a, b) => a.round_base - b.round_base);
}

/**
 * done / total over the whole plan — the panel's progress bar (U25).
 *
 * This must BYTE-MATCH the rail badge, which the server computes as:
 *
 *   count(t.*)::text AS total,
 *   count(t.*) FILTER (WHERE t.status = 'done')::text AS done
 *     FROM projects p LEFT JOIN project_tasks t ON t.project_id = p.id
 *   — forge-control/src/routes/chat-linkage.ts:400-410
 *
 * So: `total` is EVERY node, no status excluded, and `done` is EXACTLY
 * `status === 'done'` — not "settled", not "done or failed", not "not
 * pending". A failed task is counted in the denominator and not in the
 * numerator, because that is what the SQL does. The three-way agreement check
 * (rail badge ↔ this ↔ the endpoint) in round 704 hangs on the two staying
 * literally the same rule.
 */
export function planProgress(nodes: PlanNode[]): { done: number; total: number } {
  let done = 0;
  for (const node of nodes) if (node.status === DONE) done += 1;
  return { done, total: nodes.length };
}

/**
 * The entire graph projection (U27).
 *
 * Three lines, and that is the point of the phase: React-Flow consumes
 * `PlanNode[]` as nodes and this as edges, with no reshaping, no second store
 * and no second endpoint. An edge points dep → dependent, so it reads in the
 * direction work flows. Exported and covered by the check even though nothing
 * renders it yet — an unexercised claim is not a proven one.
 */
export function planEdges(nodes: PlanNode[]): PlanEdge[] {
  return nodes.flatMap((n) => n.deps.map((d) => ({ source: d, target: n.id })));
}
