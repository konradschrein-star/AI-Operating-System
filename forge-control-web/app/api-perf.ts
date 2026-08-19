/**
 * Client calls owned by the `perf` workstream (02-architecture.md §0.3: each
 * lane owns `app/api-<lane>.ts` and `app/api.ts` is never modified, so five
 * concurrent lanes never contend on one client file).
 *
 * Everything here exists because of ONE measured defect: `GET /api/projects/board`
 * returned 1,843,144 bytes to render 34,834 of them, and 88.2% of the response
 * was the `brief` column that no card on the board reads
 * (`docs/plan/artifacts/os-usable-for-work/phase6/projects-lag-before.md §2.1`).
 * The server now omits it. Two consequences land here:
 *
 *  1. the board's row type must SAY the field is gone — `ProjectBoardTask`;
 *  2. the one pane that genuinely wanted a brief must fetch the one brief it
 *     shows — `fetchTaskBrief`.
 *
 * `api.ts` exports `fetchProjectBoard` returning `ProjectTaskWithProject[]`,
 * whose `brief: string` is now an over-promise for board rows. It is not called
 * from anywhere after this change (it had exactly one caller, ProjectsSurface)
 * and this lane may not edit `api.ts` to remove it; whoever next owns that file
 * should delete it. Recorded in phase6/projects-lag-after.md §6.
 */

import type { ProjectTask, ProjectTaskWithProject } from "./api";

const ROOT = "/api/proxy";

/** Same shape as api.ts's private `getJson` — a failed request throws with the
 *  status and the path. No default, no empty array: a board that renders zero
 *  cards because a fetch failed is the defect this project exists to abolish
 *  (N1), and React Query surfaces the thrown error as `isError`. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

/**
 * One row of the Kanban board feed, as `GET /api/projects/board` serves it
 * SINCE the phase-6 payload fix: every field of `ProjectTaskWithProject` except
 * `brief`.
 *
 * HAND-MIRRORED from `type ProjectBoardTask` in
 * forge-control/src/db/projects.ts (there is no shared build across the two
 * repos), so it moves in the same commit the server type does — the same
 * contract the `ProjectTask` mirror in api.ts documents.
 *
 * `Omit`, not `brief: string | null`: the key is ABSENT from the JSON. A
 * nullable field would invite `task.brief ?? ""`, which renders an empty pane
 * that looks exactly like a task whose brief is empty.
 */
export type ProjectBoardTask = Omit<ProjectTaskWithProject, "brief">;

/** The board feed. Every active/blocked task, every column but `brief` — no
 *  row limit, because R75 requires all of them to stay reachable. */
export const fetchProjectBoardCards = async (): Promise<ProjectBoardTask[]> => {
  const r = await getJson<{ count: number; tasks: ProjectBoardTask[] }>(
    "/projects/board",
  );
  return r.tasks;
};

/**
 * One task's brief, fetched when a task is actually selected.
 *
 * `GET /api/tasks/:id` (routes/tasks.ts) serves the whole row, brief included —
 * so this needs no new endpoint. It replaces a field that used to ride on all
 * 149 board cards to be read on at most one of them, and only when that one has
 * no run yet.
 */
export const fetchTaskBrief = async (taskId: string): Promise<string> => {
  const r = await getJson<{ task: ProjectTask }>(`/tasks/${taskId}`);
  if (typeof r.task?.brief !== "string") {
    throw new Error(
      `GET /tasks/${taskId} returned no brief — the row exists but its brief is ` +
        `${JSON.stringify(r.task?.brief)}. Not defaulted to an empty string: an empty pane ` +
        `and a missing field must not look the same.`,
    );
  }
  return r.task.brief;
};
