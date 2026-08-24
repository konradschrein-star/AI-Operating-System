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
