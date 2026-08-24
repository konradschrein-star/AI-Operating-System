/**
 * Tests for project status reconciliation (Defect 3 — stale blocked and finished projects).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Verifies:
 * 1. Blocked project with 12/12 done -> auto-closes to done
 * 2. Blocked project with 10 done, 2 cancelled -> auto-closes to done
 * 3. Blocked project with 1 failed task -> remains blocked (no auto-close)
 * 4. Paused project with 4/4 done -> remains paused, reported in disagreements
 * 5. Active project with 88/88 done -> remains active, reported in disagreements
 * 6. Edge cases (0 tasks, mixed statuses, terminal projects)
 * 7. Wiring and route placement source invariants (registered before /:id)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  evaluateProjectStatusReconciliation,
  evaluateProjectTasksReconciliation,
  type ProjectStatus,
  type TaskStatus,
} from "../db/projects.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("project status reconciliation — core evaluation rules", () => {
  test("1. Blocked project with 12/12 done -> auto-closed to done", () => {
    const tasks: Array<{ status: TaskStatus }> = Array.from({ length: 12 }, () => ({
      status: "done" as const,
    }));
    const result = evaluateProjectTasksReconciliation(
      { id: "p-blocked-12", name: "aios-projects-and-chat", status: "blocked" },
      tasks,
    );

    assert.equal(result.action, "close");
    assert.equal(result.disagreement, undefined);
  });

  test("2. Blocked project with 10 done, 2 cancelled -> auto-closed to done", () => {
    const tasks: Array<{ status: TaskStatus }> = [
      ...Array.from({ length: 10 }, () => ({ status: "done" as const })),
      { status: "cancelled" as const },
      { status: "cancelled" as const },
    ];
    const result = evaluateProjectTasksReconciliation(
      { id: "p-blocked-cancelled", name: "legacy-cleanup", status: "blocked" },
      tasks,
    );

    assert.equal(result.action, "close");
    assert.equal(result.disagreement, undefined);
  });

  test("3. Blocked project with 1 failed task -> remains blocked", () => {
    const tasks: Array<{ status: TaskStatus }> = [
      ...Array.from({ length: 5 }, () => ({ status: "done" as const })),
      { status: "failed" as const },
    ];
    const result = evaluateProjectTasksReconciliation(
      { id: "p-blocked-failed", name: "failing-build", status: "blocked" },
      tasks,
    );

    assert.equal(result.action, "none");
    assert.equal(result.disagreement, undefined);
  });

  test("4. Paused project with 4/4 done -> remains paused, reported in disagreements", () => {
    const tasks: Array<{ status: TaskStatus }> = Array.from({ length: 4 }, () => ({
      status: "done" as const,
    }));
    const result = evaluateProjectTasksReconciliation(
      { id: "p-paused-4", name: "connect-clis-from-settings", status: "paused" },
      tasks,
    );

    assert.equal(result.action, "disagreement");
    assert.ok(result.disagreement, "expected disagreement report");
    assert.equal(result.disagreement.projectId, "p-paused-4");
    assert.equal(result.disagreement.projectName, "connect-clis-from-settings");
    assert.equal(result.disagreement.status, "paused");
    assert.equal(result.disagreement.tasksDone, 4);
    assert.equal(result.disagreement.tasksCancelled, 0);
    assert.equal(result.disagreement.tasksTotal, 4);
    assert.match(result.disagreement.reason, /paused/);
    assert.match(result.disagreement.reason, /status preserved/);
  });

  test("5. Active project with 88/88 done -> remains active, reported in disagreements", () => {
    const tasks: Array<{ status: TaskStatus }> = Array.from({ length: 88 }, () => ({
      status: "done" as const,
    }));
    const result = evaluateProjectTasksReconciliation(
      { id: "p-active-88", name: "os-usable-for-work", status: "active" },
      tasks,
    );

    assert.equal(result.action, "disagreement");
    assert.ok(result.disagreement, "expected disagreement report");
    assert.equal(result.disagreement.projectId, "p-active-88");
    assert.equal(result.disagreement.projectName, "os-usable-for-work");
    assert.equal(result.disagreement.status, "active");
    assert.equal(result.disagreement.tasksDone, 88);
    assert.equal(result.disagreement.tasksCancelled, 0);
    assert.equal(result.disagreement.tasksTotal, 88);
    assert.match(result.disagreement.reason, /active/);
    assert.match(result.disagreement.reason, /status preserved/);
  });
});

describe("project status reconciliation — edge cases and summary evaluator", () => {
  test("Blocked project with 0 tasks remains blocked (no auto-close on empty)", () => {
    const result = evaluateProjectTasksReconciliation(
      { id: "p-empty", name: "empty-project", status: "blocked" },
      [],
    );
    assert.equal(result.action, "none");
  });

  test("Blocked project with in-progress tasks (pending, ready, running, blocked) remains blocked", () => {
    const statuses: TaskStatus[] = ["pending", "ready", "running", "blocked"];
    for (const st of statuses) {
      const result = evaluateProjectTasksReconciliation(
        { id: `p-blocked-${st}`, name: `project-${st}`, status: "blocked" },
        [{ status: "done" }, { status: st }],
      );
      assert.equal(result.action, "none", `expected none for task with status ${st}`);
    }
  });

  test("Paused project with done + cancelled tasks reported in disagreements", () => {
    const tasks: Array<{ status: TaskStatus }> = [
      { status: "done" },
      { status: "done" },
      { status: "cancelled" },
    ];
    const result = evaluateProjectTasksReconciliation(
      { id: "p-paused-mixed", name: "paused-mixed", status: "paused" },
      tasks,
    );
    assert.equal(result.action, "disagreement");
    assert.equal(result.disagreement?.tasksDone, 2);
    assert.equal(result.disagreement?.tasksCancelled, 1);
    assert.equal(result.disagreement?.tasksTotal, 3);
  });

  test("Active project with in-progress tasks is NOT a disagreement", () => {
    const tasks: Array<{ status: TaskStatus }> = [
      ...Array.from({ length: 10 }, () => ({ status: "done" as const })),
      { status: "running" as const },
    ];
    const result = evaluateProjectTasksReconciliation(
      { id: "p-active-running", name: "active-running", status: "active" },
      tasks,
    );
    assert.equal(result.action, "none");
    assert.equal(result.disagreement, undefined);
  });

  test("Terminal projects (done, cancelled) evaluate to none", () => {
    const doneResult = evaluateProjectStatusReconciliation({
      projectId: "p-done",
      projectName: "done-project",
      status: "done" as ProjectStatus,
      tasksTotal: 10,
      tasksDone: 10,
      tasksCancelled: 0,
      tasksNonTerminal: 0,
    });
    assert.equal(doneResult.action, "none");

    const cancelledResult = evaluateProjectStatusReconciliation({
      projectId: "p-cancelled",
      projectName: "cancelled-project",
      status: "cancelled" as ProjectStatus,
      tasksTotal: 10,
      tasksDone: 8,
      tasksCancelled: 2,
      tasksNonTerminal: 0,
    });
    assert.equal(cancelledResult.action, "none");
  });
});

describe("project status reconciliation — source invariants and routing", () => {
  const PROJECTS_DB_SRC = readSource("../db/projects.ts");
  const PROJECTS_ROUTE_SRC = readSource("../routes/projects.ts");
  const PROJECT_TICK_SRC = readSource("./project-tick.ts");

  test("reconcileProjectStatuses is exported from db/projects.ts", () => {
    assert.match(
      PROJECTS_DB_SRC,
      /export async function reconcileProjectStatuses\(/,
      "reconcileProjectStatuses must be exported from db/projects.ts",
    );
  });

  test("reconcileProjectStatuses only queries active, blocked, and paused projects", () => {
    assert.match(
      PROJECTS_DB_SRC,
      /WHERE p\.status IN \('active',\s*'blocked',\s*'paused'\)/,
      "reconcileProjectStatuses query must filter on active, blocked, paused",
    );
  });

  test("reconcileProjectStatuses ONLY mutates blocked projects (never active or paused)", () => {
    assert.match(
      PROJECTS_DB_SRC,
      /UPDATE projects\s+SET status = 'done',\s+updated_at = now\(\)\s+WHERE id = \$1 AND status = 'blocked'/,
      "UPDATE statement must guard on status = 'blocked' — never mutate paused or active projects",
    );
  });

  test("reconcileProjectStatuses queues notification on auto-close", () => {
    assert.match(
      PROJECTS_DB_SRC,
      /queueNotification\(\s*`✅ Project "\${closedProject\.name}" is done — auto-closed from blocked state/,
      "auto-close must queue a completion notification",
    );
  });

  test("reconcileProjectStatuses is wired into projectTick in lib/project-tick.ts", () => {
    assert.match(
      PROJECT_TICK_SRC,
      /reconcileProjectStatuses/,
      "project-tick.ts must import and call reconcileProjectStatuses",
    );
    assert.match(
      PROJECT_TICK_SRC,
      /await reconcileProjectStatuses\(\);/,
      "projectTick must call await reconcileProjectStatuses()",
    );
  });

  test("GET /reconcile is exposed in routes/projects.ts BEFORE GET /:id", () => {
    assert.match(
      PROJECTS_ROUTE_SRC,
      /r\.get\("\/reconcile",/,
      "routes/projects.ts must define r.get('/reconcile')",
    );
    const reconcileIdx = PROJECTS_ROUTE_SRC.indexOf('r.get("/reconcile"');
    const paramIdx = PROJECTS_ROUTE_SRC.indexOf('r.get("/:id"');
    assert.ok(reconcileIdx > 0, "r.get('/reconcile') not found");
    assert.ok(paramIdx > 0, "r.get('/:id') not found");
    assert.ok(
      reconcileIdx < paramIdx,
      "r.get('/reconcile') must be registered BEFORE r.get('/:id') so Hono does not parse 'reconcile' as an id param",
    );
  });
});

/* ==========================================================================
 * Queue truth (2026-08-25). Three defects, one root: 'cancelled' was a
 * TaskStatus in TypeScript that the DB CHECK constraint had never heard of, so
 * there was no way to retire a task row. Operators retired them as 'blocked'
 * instead — a status that is NOT terminal — and every such row silently held
 * back every round above it.
 *
 * These are source invariants rather than behavioural tests because the rules
 * they guard live in SQL string literals: no fake Querier can prove what
 * Postgres will do with them, and a test that mocked the answer would be
 * asserting its own fixture. What CAN be proved here is that the rule is
 * written once and that no site has drifted back to the old one.
 * ========================================================================== */
describe("queue truth — cancelled is terminal, and terminality is written once", () => {
  const PROJECTS_DB_SRC = readSource("../db/projects.ts");
  const MIGRATION_SRC = readSource("../../../db/migrations/0046_task_status_cancelled.sql");

  test("0046 widens the CHECK constraint to admit 'cancelled'", () => {
    assert.match(
      MIGRATION_SRC,
      /ADD CONSTRAINT project_tasks_status_check[\s\S]*'cancelled'/,
      "migration 0046 must add 'cancelled' to project_tasks_status_check",
    );
    for (const kept of ["pending", "ready", "running", "done", "failed", "blocked"]) {
      assert.match(
        MIGRATION_SRC,
        new RegExp(`'${kept}'`),
        `widening a CHECK must be additive — '${kept}' may not be dropped`,
      );
    }
  });

  test("TERMINAL_TASK_STATUSES is the single definition and holds both statuses", () => {
    assert.match(
      PROJECTS_DB_SRC,
      /export const TERMINAL_TASK_STATUSES: readonly TaskStatus\[\] = \["done", "cancelled"\]/,
      "TERMINAL_TASK_STATUSES must be exported with exactly done + cancelled",
    );
  });

  test("no site in db/projects.ts still treats 'done' as the only terminal status", () => {
    // The drift guard. Six SQL literals said this before the rule was written
    // once; the helper exists so a seventh cannot be added by copy-paste.
    // Matches the SQL comparison only — the prose in comments is not code, so
    // the pattern is anchored on a column reference before it.
    const drifted = PROJECTS_DB_SRC.match(/\w+\.status <> 'done'/g) ?? [];
    assert.deepEqual(
      drifted,
      [],
      `these sites still exclude only 'done': ${drifted.join(", ")}`,
    );
  });

  test("the two claims of ACHIEVEMENT additionally require a finished row", () => {
    // Terminal is not the same as carried. A project whose every task was
    // cancelled must not close as 'done', and a round whose every task was
    // cancelled must not fire 🏁 — so both sites need a positive 'done' test
    // on top of the not-still-open test.
    const closeBody = PROJECTS_DB_SRC.slice(
      PROJECTS_DB_SRC.indexOf("export async function closeFinishedProjects"),
      PROJECTS_DB_SRC.indexOf("export function evaluateProjectStatusReconciliation"),
    );
    assert.ok(closeBody.length > 0, "closeFinishedProjects body not found");
    assert.match(
      closeBody,
      /WHERE project_id = p\.id AND status = 'done'/,
      "closeFinishedProjects must require at least one 'done' task row",
    );

    const roundBody = PROJECTS_DB_SRC.slice(
      PROJECTS_DB_SRC.indexOf("export async function roundIsComplete"),
    ).slice(0, 1200);
    assert.match(
      roundBody,
      /AND EXISTS \([\s\S]*t\.status = 'done'/,
      "roundIsComplete must require at least one 'done' task row before it reports complete",
    );
  });

  test("sweepClosedProjectTasks mutates only CANCELLED projects, never done ones", () => {
    const body = PROJECTS_DB_SRC.slice(
      PROJECTS_DB_SRC.indexOf("export async function sweepClosedProjectTasks"),
      PROJECTS_DB_SRC.indexOf("/** Shallow-merge a patch into projects.metadata"),
    );
    assert.ok(body.length > 0, "sweepClosedProjectTasks body not found");

    const update = body.slice(body.indexOf("UPDATE project_tasks"), body.indexOf("SELECT p.id::text"));
    assert.match(
      update,
      /p\.status = 'cancelled'/,
      "the only rows this may cancel belong to a cancelled project",
    );
    assert.ok(
      !/p\.status = 'done'/.test(update),
      "a project asserted done must be REPORTED, never silently rewritten",
    );
    assert.match(
      update,
      /t\.status IN \('pending', 'ready', 'blocked', 'failed'\)/,
      "'running' rows are owned by a live run and must be left alone",
    );
  });

  test("reconcileProjectStatuses actually runs the closed-project sweep", () => {
    assert.match(
      PROJECTS_DB_SRC,
      /const orphans = await sweepClosedProjectTasks\(\);/,
      "the sweep is dead code unless reconcileProjectStatuses calls it",
    );
  });

  test("cancelTask refuses 'running' and 'done'", () => {
    const body = PROJECTS_DB_SRC.slice(
      PROJECTS_DB_SRC.indexOf("export async function cancelTask"),
    ).slice(0, 1400);
    assert.match(
      body,
      /AND status IN \('pending', 'ready', 'blocked', 'failed'\)/,
      "cancelTask must not touch a running row (a live run owns it) or a done one",
    );
  });
});
