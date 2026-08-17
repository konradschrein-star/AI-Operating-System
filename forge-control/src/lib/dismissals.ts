/**
 * dismissals.ts — what a single "hide this row" gesture actually hides.
 *
 * Konrad clicks X on a finished manager and expects its finished team to go
 * with it; he clicks X on a worker and expects its finished sub-agents to go
 * with it. He does NOT expect a running agent to disappear, at any depth —
 * hiding live work is how an operator stops trusting the panel.
 *
 * This module is the rule, and nothing else. No pool, no SQL, no clock: the
 * route fetches the candidate rows and calls `resolveCascade`, so the rule is
 * testable without a database (`dismissals.test.ts`) and the SQL stays where
 * the round's constraints require it — route-local in `routes/agents.ts`,
 * never in the engine files this project may not touch.
 *
 * The write side (`ui_dismissals`, migration 0041) is a HIDE and never a
 * delete: every id this function returns can be handed straight back to
 * `DELETE /api/agents/dismissals/:id`, and the `runs` rows are untouched.
 */

import { SETTLED_STATUSES } from "../routes/agents-shared.ts";

/**
 * One candidate row, as the caller's SELECT must produce it.
 *
 * `project_id` is the run's own `metadata.project_id`. `origin_chat_id` is the
 * chat that STARTED that project (`projects.metadata.origin_chat_id`, joined
 * in by the caller) — carried on every row of the project so this function can
 * answer "is the target the manager of this project?" without a second lookup.
 */
export interface DismissalCandidate {
  id: string;
  parent_run_id: string | null;
  status: string;
  project_id: string | null;
  origin_chat_id: string | null;
}

/**
 * The id set one dismissal hides.
 *
 * Composed of three things, in this order of reasoning:
 *
 *   1. THE TARGET, always — even when it is running, and even when it is not a
 *      run at all. Depth 0 is an explicit gesture on a row Konrad is looking
 *      at (the panel confirms before dismissing a live row), and an id that
 *      matches no row is the normal case for a sub-agent node: sub-agent ids
 *      are `tool_use_id`s from inside `runs.thread`, so `rows` will never
 *      contain them. Returning `[id]` there is the correct answer, not a
 *      miss — the client hides that one node and nothing else.
 *
 *   2. TRANSITIVE `parent_run_id` DESCENDANTS THAT ARE SETTLED. The walk
 *      descends through running nodes but never selects them: a running child
 *      keeps its row, and a settled grandchild under it is still history and
 *      still hidden. Selecting only what is settled is the one invariant this
 *      function has; it holds at every depth.
 *
 *   3. When the target is a project's ORIGIN CHAT — i.e. some row names it in
 *      `origin_chat_id` — that project's SETTLED runs, and their settled
 *      descendants. Dismissing the manager of a finished project is the
 *      gesture that means "this whole project is done, take it off my screen".
 *
 * Order is deterministic and independent of the order `rows` arrives in: the
 * target first (it is the gesture), then every cascaded id sorted ascending.
 * A caller may therefore compare two results for equality directly, which is
 * what makes the POST idempotency check in the route a string comparison.
 *
 * Cycles cannot loop this function: `parent_run_id` has a FK to `runs(id)` and
 * so should be acyclic, but a restored backup or a hand-edited row could say
 * otherwise, and a UI hide is not the place to discover it. The visited set
 * makes a cycle terminate with each node counted once. No throw.
 */
export function resolveCascade(
  targetId: string,
  rows: readonly DismissalCandidate[],
): string[] {
  const childrenOf = new Map<string, DismissalCandidate[]>();
  const projectsOfTarget = new Set<string>();
  for (const row of rows) {
    if (row.parent_run_id) {
      const siblings = childrenOf.get(row.parent_run_id);
      if (siblings) siblings.push(row);
      else childrenOf.set(row.parent_run_id, [row]);
    }
    if (row.origin_chat_id === targetId && row.project_id) {
      projectsOfTarget.add(row.project_id);
    }
  }

  const cascaded = new Set<string>();
  const visited = new Set<string>([targetId]);
  // Seeds: the target's children, plus every run of a project this target is
  // the origin chat of. Project workers are seeded as NODES (not merely as
  // ids) so the walk continues into their own sub-runs from there.
  const queue: DismissalCandidate[] = [...(childrenOf.get(targetId) ?? [])];
  if (projectsOfTarget.size > 0) {
    for (const row of rows) {
      if (row.project_id && projectsOfTarget.has(row.project_id)) queue.push(row);
    }
  }

  while (queue.length > 0) {
    const node = queue.shift() as DismissalCandidate;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    // Running rows are never hidden by a cascade — but their subtree is still
    // walked, so finished work under a live agent does not stay pinned to the
    // panel by its parent.
    if (SETTLED_STATUSES.has(node.status)) cascaded.add(node.id);
    const children = childrenOf.get(node.id);
    if (children) for (const child of children) queue.push(child);
  }

  cascaded.delete(targetId);
  return [targetId, ...Array.from(cascaded).sort()];
}

/** What `kind` column value an id gets in `ui_dismissals`. A run id is a uuid;
 *  a sub-agent node id is the CLI's `tool_use_id` ("toolu_01..."), which never
 *  is. Shape is the only signal available at write time — the sub-agent has no
 *  row to look up — and it is a label, not a load-bearing key. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dismissalKind(nodeId: string): "run" | "subagent" {
  return UUID_RE.test(nodeId) ? "run" : "subagent";
}

/** True when `id` could name a `runs` row, i.e. when the candidate query is
 *  worth running at all. `runs.id` is uuid: passing a `tool_use_id` to a
 *  `WHERE id = $1` comparison is a Postgres cast error, not an empty result. */
export function isRunId(nodeId: string): boolean {
  return UUID_RE.test(nodeId);
}
