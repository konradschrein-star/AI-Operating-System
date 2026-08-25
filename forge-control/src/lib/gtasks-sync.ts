/**
 * Google Tasks ↔ board, both directions.
 *
 * Sibling of calendar-sync.ts. Together they make Konrad's phone a complete
 * client without the OS shipping a mobile task UI at all:
 *
 *   task WITH an hour  → Google Calendar  (calendar-sync.ts)
 *   task WITHOUT one   → Google Tasks     (here)
 *
 * ── The conflict rule ─────────────────────────────────────────────────────
 * Every bound row caches `gtask_updated`: Google's own last-modified stamp as we
 * last saw it. That single field decides who wins, with no clocks to compare
 * across two machines:
 *
 *   g.updated !== stored  → it changed on his phone since we last looked → PULL
 *   g.updated === stored  → Google is exactly as we left it → safe to PUSH
 *
 * Without it the two sides ping-pong: we write, Google's `updated` moves, we
 * read it back as "he edited this", we write again, forever. The stamp is
 * re-cached on every write we make, which is what closes that loop.
 *
 * ── Not handled in v1, deliberately ───────────────────────────────────────
 * Deletions. A task vanishing from one side is ambiguous — completed-and-swept,
 * deleted on purpose, or a list the user renamed — and guessing wrong destroys
 * work. Completion propagates; disappearance does not.
 */

import {
  listGoogleTasks,
  createGoogleTask,
  updateGoogleTask,
  DEFAULT_TASKLIST,
  type GoogleTask,
} from "./gtasks.ts";
import { berlinDay, type Day } from "./day-score.ts";
import { sameInstant } from "./calendar-sync.ts";
import {
  createTask,
  updateTask,
  tasksByGtaskId,
  tasksNeedingGtask,
  type DayTask,
  type TaskStatus,
} from "../db/daily.ts";

const TITLE_MAX = 300;

export interface GtaskSyncResult {
  dry_run: boolean;
  tasklist: string;
  remote: number;
  pushed_new: string[];
  pushed_update: string[];
  pulled_new: string[];
  pulled_update: string[];
  unchanged: number;
}

/** Google Tasks has two states; the board has four. */
function toGoogleStatus(status: TaskStatus): "needsAction" | "completed" {
  return status === "done" ? "completed" : "needsAction";
}

/** …and back. An incoming `completed` is unambiguous; `needsAction` must NOT
 *  clobber a local `doing` back down to `todo`, so it only acts on a row that
 *  is currently done. */
function applyGoogleStatus(current: TaskStatus, g: GoogleTask): TaskStatus | undefined {
  if (g.status === "completed") return current === "done" ? undefined : "done";
  if (current === "done") return "todo";
  return undefined;
}

/** The date part of anything Google hands back, or of a board day. */
function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

/** What day should this board task show as due on the phone? An explicit due
 *  date if it has one, otherwise the day it is planned for — a task planned for
 *  Thursday and never given a deadline still wants to surface on Thursday. */
function boardDue(task: DayTask): Day | null {
  return task.due_day ?? task.planned_day;
}

/** Google wants RFC3339 even though it stores only the date. */
function toGoogleDue(day: Day | null): string | undefined {
  return day ? `${day}T00:00:00.000Z` : undefined;
}

export interface GtaskSyncOptions {
  tasklist?: string;
  dryRun?: boolean;
}

export async function syncGoogleTasks(
  options: GtaskSyncOptions = {},
): Promise<GtaskSyncResult> {
  const tasklist = options.tasklist ?? DEFAULT_TASKLIST;
  const dryRun = options.dryRun === true;

  // showCompleted, so that a task he ticked off on the phone comes back at all —
  // Google hides completed entries from the default listing, and an invisible
  // task is indistinguishable from a deleted one.
  const remote = await listGoogleTasks({ tasklist, max: 250, showCompleted: true });
  const bound = await tasksByGtaskId();

  const pushedNew: string[] = [];
  const pushedUpdate: string[] = [];
  const pulledNew: string[] = [];
  const pulledUpdate: string[] = [];
  let unchanged = 0;

  // ── Google → board ──────────────────────────────────────────────────────
  for (const g of remote) {
    if (g.deleted) continue;

    const local = bound.get(g.id);

    if (!local) {
      // Only OPEN work becomes a new board row.
      //
      // We ask Google for completed entries so that a task he ticked off on the
      // phone can be matched and closed here — but an unbound completed entry is
      // history, not work. Measured the hard way: the first run of this pulled
      // 31 finished tasks going back months onto the board, which is precisely
      // the "buries the board on first contact" failure the all-day skip in
      // calendar-sync.ts exists to prevent.
      if (g.status === "completed" || g.hidden) {
        continue;
      }
      if (!dryRun) {
        await createTask({
          title: (g.title || "(untitled)").slice(0, TITLE_MAX),
          area: "other",
          status: g.status === "completed" ? "done" : "todo",
          planned_day: dateOnly(g.due) ?? berlinDay(),
          due_day: dateOnly(g.due),
          notes: g.notes || null,
          gtask_id: g.id,
          gtask_updated: g.updated || null,
        });
      }
      pulledNew.push(g.id);
      continue;
    }

    // Compare INSTANTS. Postgres returns `2026-08-24 22:39:42.493+00`, Google
    // sends `2026-08-24T22:39:42.493Z` — the same moment, never the same
    // characters. Measured: a string compare here reported all 34 rows as
    // remotely edited on the very next pass, so nothing was ever idempotent and
    // every local edit was silently overwritten by a stale remote copy.
    // (Same trap as calendar-sync.ts; hence the shared helper.)
    const remoteMoved = !sameInstant(local.gtask_updated, g.updated || null);

    if (remoteMoved) {
      // His phone is newer. Take everything from Google and re-cache the stamp.
      const patch: Parameters<typeof updateTask>[1] = { gtask_updated: g.updated || null };
      if (g.title && g.title !== local.title) patch.title = g.title.slice(0, TITLE_MAX);
      if ((g.notes || null) !== local.notes) patch.notes = g.notes || null;
      const nextStatus = applyGoogleStatus(local.status, g);
      if (nextStatus) patch.status = nextStatus;
      const gDue = dateOnly(g.due);
      if (gDue !== dateOnly(boardDue(local))) patch.due_day = gDue;

      if (!dryRun) await updateTask(local.id, patch);
      pulledUpdate.push(g.id);
      continue;
    }

    // ── board → Google ────────────────────────────────────────────────────
    // Google is exactly as we left it, so any difference is a local edit.
    const wantStatus = toGoogleStatus(local.status);
    const wantDue = dateOnly(toGoogleDue(boardDue(local)) ?? null);
    const patch: Parameters<typeof updateGoogleTask>[1] = { tasklist };
    let dirty = false;

    if (local.title !== g.title) {
      patch.title = local.title;
      dirty = true;
    }
    if ((local.notes || "") !== (g.notes || "")) {
      patch.notes = local.notes || "";
      dirty = true;
    }
    if (wantStatus !== g.status) {
      patch.status = wantStatus;
      dirty = true;
    }
    if (wantDue !== dateOnly(g.due)) {
      const due = toGoogleDue(boardDue(local));
      if (due) {
        patch.due = due;
        dirty = true;
      }
    }

    if (!dirty) {
      unchanged += 1;
      continue;
    }

    if (!dryRun) {
      const written = await updateGoogleTask(g.id, patch);
      // Re-cache immediately, or the next pass reads our own write as his edit.
      await updateTask(local.id, { gtask_updated: written.updated || null });
    }
    pushedUpdate.push(g.id);
  }

  // ── New board tasks that have never been to the phone ───────────────────
  for (const t of await tasksNeedingGtask()) {
    if (!dryRun) {
      const created = await createGoogleTask({
        title: t.title,
        notes: t.notes ?? undefined,
        due: toGoogleDue(boardDue(t)),
        tasklist,
      });
      await updateTask(t.id, {
        gtask_id: created.id,
        gtask_updated: created.updated || null,
      });
    }
    pushedNew.push(t.id);
  }

  return {
    dry_run: dryRun,
    tasklist,
    remote: remote.length,
    pushed_new: pushedNew,
    pushed_update: pushedUpdate,
    pulled_new: pulledNew,
    pulled_update: pulledUpdate,
    unchanged,
  };
}
