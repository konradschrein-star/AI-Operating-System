/**
 * Unit tests for lib/excalidraw-plan.ts.
 *
 * Tests:
 * 1. Actionable plan compilation from synthetic DAGs (topological phases,
 *    workstreams, task specs, role/tier selection, open questions).
 * 2. Plan compilation and markdown rendering from real vault drawings.
 * 3. Insertion ordering into project_tasks: every representable dependency
 *    survives, and the ones that cannot are named rather than dropped.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

import {
  compileCanvasPlan,
  compileCanvasPlanFromMarkdown,
  serializeCanvasPlanMarkdown,
  resolvePlanInsertionOrder,
  type CanvasPlan,
  type PlanTask,
  type UnresolvableDependency,
} from "./excalidraw-plan.ts";
import { parseDrawingGraphFromMarkdown } from "./excalidraw-graph.ts";
import { serializeExcalidrawMarkdown, EMPTY_DRAWING } from "./excalidraw-md.ts";

type El = Record<string, unknown>;

function shape(over: El): El {
  return {
    type: "rectangle",
    id: "rect-" + Math.random().toString(36).slice(2, 8),
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    groupIds: [],
    frameId: null,
    isDeleted: false,
    link: null,
    locked: false,
    ...over,
  };
}

function text(over: El): El {
  return shape({
    type: "text",
    id: "text-" + Math.random().toString(36).slice(2, 8),
    width: 80,
    height: 20,
    fontSize: 16,
    containerId: null,
    ...over,
  });
}

function arrow(over: El): El {
  return shape({
    type: "arrow",
    id: "arrow-" + Math.random().toString(36).slice(2, 8),
    width: 40,
    height: 0,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    points: [
      [0, 0],
      [40, 0],
    ],
    ...over,
  });
}

function draw(elements: El[], opts: { frontmatter?: string; preamble?: string } = {}): string {
  return serializeExcalidrawMarkdown(
    {
      frontmatter: opts.frontmatter ?? "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n",
      preamble: opts.preamble ?? "==\u26a0  Switch to EXCALIDRAW VIEW ... \u26a0==\n\n",
      otherSections: "",
      drawing: { ...EMPTY_DRAWING(), elements },
      format: "parsed",
    },
    "parsed",
  );
}

describe("excalidraw-plan: synthetic DAG compilation", () => {
  test("sequential pipeline: compiles into sequential phases", () => {
    const raw = draw([
      shape({ id: "s1", x: 0, y: 0 }),
      text({ id: "t1", containerId: "s1", text: "Database Schema Design" }),
      shape({ id: "s2", x: 200, y: 0 }),
      text({ id: "t2", containerId: "s2", text: "Build API Endpoints" }),
      shape({ id: "s3", x: 400, y: 0 }),
      text({ id: "t3", containerId: "s3", text: "Review and Gate Verification" }),
      arrow({ id: "a1", startBinding: { elementId: "s1" }, endBinding: { elementId: "s2" } }),
      arrow({ id: "a2", startBinding: { elementId: "s2" }, endBinding: { elementId: "s3" } }),
    ]);

    const plan = compileCanvasPlanFromMarkdown(raw, "Excalidraw/Pipeline.excalidraw.md");

    assert.strictEqual(plan.tasks.length, 3);
    assert.strictEqual(plan.phases.length, 3);

    const task1 = plan.tasks.find((t) => t.title === "Database Schema Design");
    const task2 = plan.tasks.find((t) => t.title === "Build API Endpoints");
    const task3 = plan.tasks.find((t) => t.title === "Review and Gate Verification");

    assert.ok(task1 && task2 && task3);

    // Phases
    assert.strictEqual(task1.phase, 1);
    assert.strictEqual(task2.phase, 2);
    assert.strictEqual(task3.phase, 3);

    // Dependencies
    assert.deepStrictEqual(task1.depends_on, []);
    assert.deepStrictEqual(task2.depends_on, [task1.id]);
    assert.deepStrictEqual(task3.depends_on, [task2.id]);

    // Roles and Tiers
    assert.strictEqual(task1.role, "architect");
    assert.strictEqual(task1.tier, "flagship");
    assert.strictEqual(task2.role, "builder");
    assert.strictEqual(task2.tier, "standard");
    assert.strictEqual(task3.role, "reviewer");
    assert.strictEqual(task3.tier, "standard");
  });

  test("workstream grouping: assigns child tasks to container sections", () => {
    const raw = draw([
      // Container box (workstream 1)
      shape({ id: "box-backend", x: 0, y: 0, width: 400, height: 200, strokeStyle: "dashed" }),
      text({ id: "title-backend", text: "Backend Services", x: 10, y: 10 }),
      // Tasks inside container
      shape({ id: "s-ingest", x: 30, y: 60, width: 100, height: 40 }),
      text({ id: "t-ingest", containerId: "s-ingest", text: "Ingest Worker" }),
      shape({ id: "s-queue", x: 180, y: 60, width: 100, height: 40 }),
      text({ id: "t-queue", containerId: "s-queue", text: "BullMQ Setup" }),
    ]);

    const plan = compileCanvasPlanFromMarkdown(raw, "Excalidraw/Workstreams.excalidraw.md");

    const ws = plan.workstreams.find((w) => w.name === "Backend Services");
    assert.ok(ws, "expected Backend Services workstream");
    assert.strictEqual(ws.taskIds.length, 2);

    for (const t of plan.tasks) {
      assert.strictEqual(t.workstream, "Backend Services");
    }
  });

  test("ambiguities: rendered prominently in markdown output", () => {
    const raw = draw([
      shape({ id: "s1", x: 0, y: 0 }),
      text({ id: "t1", containerId: "s1", text: "Isolated Task" }),
      arrow({ id: "a-dangle", x: 500, y: 500, points: [[0, 0], [50, 0]] }),
    ]);

    const plan = compileCanvasPlanFromMarkdown(raw, "Excalidraw/Ambiguous.excalidraw.md");
    assert.ok(plan.ambiguities.length >= 2);
    assert.ok(plan.rawMarkdown.includes("## Ambiguities & Open Questions"));
    assert.ok(plan.rawMarkdown.includes("> [!WARNING]"));
  });
});

describe("excalidraw-plan: real vault drawings", () => {
  const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";

  async function exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  test("Stealth Uploader - System Map.excalidraw.md compiles to phased plan", async () => {
    const filePath = path.join(VAULT_DIR, "Excalidraw/Stealth Uploader - System Map.excalidraw.md");
    if (!(await exists(filePath))) return;

    const raw = await readFile(filePath, "utf8");
    const plan = compileCanvasPlanFromMarkdown(raw, "Excalidraw/Stealth Uploader - System Map.excalidraw.md");

    assert.ok(plan.tasks.length > 20, "expected > 20 tasks");
    assert.ok(plan.phases.length >= 2, "expected multi-phase plan");
    assert.ok(plan.workstreams.length >= 3, "expected multiple workstreams");
    assert.ok(plan.rawMarkdown.length > 500);

    // Verify task brief structure
    const sampleTask = plan.tasks[0];
    assert.ok(sampleTask.brief.includes("Implement / execute"));
    assert.ok(sampleTask.brief.includes("Status:"));
  });
});

describe("excalidraw-plan: API routes", async () => {
  const { Hono } = await import("hono");
  const canvasRouter = (await import("../routes/canvas.ts")).default;
  const app = new Hono();
  app.route("/api/canvas", canvasRouter);

  test("GET /api/canvas/plan rejects missing path", async () => {
    const res = await app.request("/api/canvas/plan");
    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /path required/);
  });

  test("GET /api/canvas/plan rejects path traversal", async () => {
    const res = await app.request("/api/canvas/plan?path=../../etc/passwd.excalidraw.md");
    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /escapes the vault/);
  });

  test("GET /api/canvas/plan rejects non-excalidraw files", async () => {
    const res = await app.request("/api/canvas/plan?path=Notes/SomeNote.md");
    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not a drawing/);
  });

  test("GET /api/canvas/plan returns 404 for non-existent drawing", async () => {
    const res = await app.request("/api/canvas/plan?path=Excalidraw/NoSuchFile123.excalidraw.md");
    assert.strictEqual(res.status, 404);
  });

  test("GET /api/canvas/plan derives plan for real vault drawing", async () => {
    const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
    const testPath = path.join(VAULT_DIR, "Excalidraw/Stealth Uploader - System Map.excalidraw.md");
    try {
      await access(testPath);
    } catch {
      return;
    }

    const res = await app.request("/api/canvas/plan?path=Excalidraw/Stealth Uploader - System Map.excalidraw.md");
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      plan: { tasks: unknown[]; phases: unknown[] };
      graph: { nodes: unknown[]; edges: unknown[] };
    };
    assert.strictEqual(body.ok, true);
    assert.ok(body.plan.tasks.length > 0);
    assert.ok(body.graph.nodes.length > 0);
  });

  test("POST /api/canvas/plan/save validates input and guards paths", async () => {
    // Missing path
    const res1 = await app.request("/api/canvas/plan/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res1.status, 400);

    // Path traversal
    const res2 = await app.request("/api/canvas/plan/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../../etc/passwd.excalidraw.md" }),
    });
    assert.strictEqual(res2.status, 400);

    // Non-existent drawing
    const res3 = await app.request("/api/canvas/plan/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "Excalidraw/NoSuchDrawing123.excalidraw.md" }),
    });
    assert.strictEqual(res3.status, 404);
  });

  test("POST /api/canvas/plan/to-project validates input and origin_chat_id", async () => {
    // Missing path and plan
    const res1 = await app.request("/api/canvas/plan/to-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res1.status, 400);

    // Invalid origin_chat_id (not uuid)
    const res2 = await app.request("/api/canvas/plan/to-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "Excalidraw/Stealth Uploader - System Map.excalidraw.md",
        origin_chat_id: "not-a-uuid",
      }),
    });
    assert.strictEqual(res2.status, 400);
    const body2 = (await res2.json()) as { error: string };
    assert.match(body2.error, /origin_chat_id must be a uuid/);
  });
});


/* ==========================================================================
 * Insertion order — the seeded task graph must equal the drawn one
 * ========================================================================== */

describe("resolvePlanInsertionOrder", () => {
  function planTask(over: Partial<PlanTask> & { id: string }): PlanTask {
    return {
      nodeId: "node-" + over.id,
      title: "Task " + over.id,
      workstream: "Core",
      phase: 1,
      status: "planned",
      statusReason: "",
      depends_on: [],
      role: "builder",
      tier: "standard",
      write_set: [],
      brief: "",
      link: null,
      ...over,
    };
  }

  /** Replay the route's insert loop over `order` and assert that the edges it
   *  actually fails to write are exactly the ones reported. This is the whole
   *  contract: `unresolvable` may neither miss a loss nor invent one. */
  function assertReportMatchesInsert(
    order: PlanTask[],
    unresolvable: UnresolvableDependency[],
  ): void {
    const inserted = new Set<string>();
    const lost: string[] = [];
    for (const t of order) {
      for (const d of t.depends_on) if (!inserted.has(d)) lost.push(`${t.id}<-${d}`);
      inserted.add(t.id);
    }
    assert.deepStrictEqual(
      lost.sort(),
      unresolvable.map((u) => `${u.task}<-${u.dependsOn}`).sort(),
    );
  }

  test("keeps every edge of an acyclic plan and orders dependencies first", () => {
    // c depends on b depends on a, but the plan lists them in reverse — the
    // exact shape that used to drop two edges on the floor.
    const tasks = [
      planTask({ id: "c", depends_on: ["b"] }),
      planTask({ id: "b", depends_on: ["a"] }),
      planTask({ id: "a" }),
    ];

    const { order, unresolvable } = resolvePlanInsertionOrder(tasks);

    assert.deepStrictEqual(unresolvable, []);
    assert.deepStrictEqual(order.map((t) => t.id), ["a", "b", "c"]);

    // Simulate the route's insert loop: no edge may be lost.
    const inserted = new Set<string>();
    let kept = 0;
    let lost = 0;
    for (const t of order) {
      for (const d of t.depends_on) (inserted.has(d) ? kept++ : lost++);
      inserted.add(t.id);
    }
    assert.strictEqual(lost, 0, "no edge may be dropped for an acyclic plan");
    assert.strictEqual(kept, 2);
  });

  test("preserves a cross-workstream edge inside one phase", () => {
    // Same phase number, different workstreams: plan.tasks is sorted by
    // (phase, workstream, id), so "alpha" sorts before "zulu" and the edge
    // alpha <- zulu pointed at a task that did not exist yet.
    const tasks = [
      planTask({ id: "alpha", workstream: "Alpha", phase: 2, depends_on: ["zulu"] }),
      planTask({ id: "zulu", workstream: "Zulu", phase: 2 }),
    ];

    const { order, unresolvable } = resolvePlanInsertionOrder(tasks);

    assert.deepStrictEqual(unresolvable, []);
    assert.deepStrictEqual(order.map((t) => t.id), ["zulu", "alpha"]);
  });

  test("names the edge a 2-node cycle loses instead of dropping it silently", () => {
    const tasks = [
      planTask({ id: "a", title: "Ship it", depends_on: ["b"] }),
      planTask({ id: "b", title: "Review it", depends_on: ["a"] }),
    ];

    const { order, unresolvable } = resolvePlanInsertionOrder(tasks);

    // Both tasks are still created — only the back edge is unrepresentable.
    assert.deepStrictEqual(order.map((t) => t.id), ["a", "b"]);
    assert.deepStrictEqual(unresolvable, [
      {
        task: "a",
        taskTitle: "Ship it",
        dependsOn: "b",
        // The title travels with the edge so the refusal reads without the ids.
        dependsOnTitle: "Review it",
        reason: "cycle",
      },
    ]);

    // And the report is exact: replaying the insert loses that edge and no other.
    assertReportMatchesInsert(order, unresolvable);
  });

  test("reports a self-edge as a cycle", () => {
    const tasks = [planTask({ id: "a", depends_on: ["a"] })];
    const { order, unresolvable } = resolvePlanInsertionOrder(tasks);
    assert.deepStrictEqual(order.map((t) => t.id), ["a"]);
    assert.deepStrictEqual(unresolvable, [
      {
        task: "a",
        taskTitle: "Task a",
        dependsOn: "a",
        dependsOnTitle: "Task a",
        reason: "cycle",
      },
    ]);
  });

  test("reports an edge pointing outside the plan as unknown_task", () => {
    const tasks = [planTask({ id: "a", depends_on: ["ghost"] })];
    const { unresolvable } = resolvePlanInsertionOrder(tasks);
    assert.strictEqual(unresolvable.length, 1);
    assert.strictEqual(unresolvable[0].reason, "unknown_task");
    assert.strictEqual(unresolvable[0].dependsOnTitle, null);
  });

  test("a cycle does not cost the acyclic edges hanging off it", () => {
    //   root -> a <-> b -> leaf   (a and b cycle; root and leaf are fine)
    const tasks = [
      planTask({ id: "root" }),
      planTask({ id: "a", depends_on: ["root", "b"] }),
      planTask({ id: "b", depends_on: ["a"] }),
      planTask({ id: "leaf", depends_on: ["b"] }),
    ];

    const { order, unresolvable } = resolvePlanInsertionOrder(tasks);

    assert.strictEqual(order.length, 4, "every task is still created");
    assert.strictEqual(order[0].id, "root");

    // Exactly one edge is unrepresentable: the one closing the cycle. `leaf`
    // hangs downstream of the cycle but keeps its edge, because `b` exists by
    // the time it is inserted — reporting leaf<-b as lost would be a lie.
    assert.deepStrictEqual(
      unresolvable.map((u) => `${u.task}<-${u.dependsOn}`),
      ["a<-b"],
    );
    assertReportMatchesInsert(order, unresolvable);

    const inserted = new Set<string>();
    const keptEdges: string[] = [];
    for (const t of order) {
      for (const d of t.depends_on) if (inserted.has(d)) keptEdges.push(`${t.id}<-${d}`);
      inserted.add(t.id);
    }
    assert.ok(keptEdges.includes("a<-root"), "acyclic edge into the cycle survives");
    assert.ok(keptEdges.includes("b<-a"), "the forward edge of the cycle survives");
    assert.ok(keptEdges.includes("leaf<-b"), "acyclic edge out of the cycle survives");
  });

  test("empty plan resolves to an empty order", () => {
    assert.deepStrictEqual(resolvePlanInsertionOrder([]), { order: [], unresolvable: [] });
  });
});

describe("POST /api/canvas/plan/to-project: unresolvable dependencies", async () => {
  const { Hono } = await import("hono");
  const canvasRouter = (await import("../routes/canvas.ts")).default;
  const app = new Hono();
  app.route("/api/canvas", canvasRouter);

  /** A two-task plan whose tasks depend on each other — a drawing with an
   *  A→B→A arrow loop, which the graph parser already flags as a `cycle`
   *  ambiguity. Passed inline so the route never reaches the filesystem. */
  function cyclicPlan(): CanvasPlan {
    const mk = (id: string, dep: string): PlanTask => ({
      id,
      nodeId: "n-" + id,
      title: "Task " + id.toUpperCase(),
      workstream: "Core",
      phase: 1,
      status: "planned",
      statusReason: "",
      depends_on: [dep],
      role: "builder",
      tier: "standard",
      write_set: [],
      brief: "brief for " + id,
      link: null,
    });
    const tasks = [mk("a", "b"), mk("b", "a")];
    return {
      path: "Excalidraw/Cyclic.excalidraw.md",
      title: "Cyclic",
      summary: "two tasks pointing at each other",
      workstreams: [
        { id: "core", name: "Core", containerId: null, taskIds: ["a", "b"], summary: "" },
      ],
      phases: [{ phase: 1, name: "Phase 1", taskIds: ["a", "b"] }],
      tasks,
      ambiguities: [
        {
          id: "cycle-1",
          kind: "cycle",
          severity: "warning",
          elementIds: ["n-a", "n-b"],
          label: "Task A ↔ Task B",
          description: "these two point at each other",
          question: "which one runs first?",
        },
      ],
      stats: {
        totalTasks: 2,
        totalPhases: 1,
        totalWorkstreams: 1,
        ambiguityCount: 1,
        completedTasks: 0,
        blockedTasks: 0,
      },
      rawMarkdown: "# Plan: Cyclic\n",
    };
  }

  test("refuses a cyclic plan with 409 and names every lost edge", async () => {
    const res = await app.request("/api/canvas/plan/to-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cyclic push", plan: cyclicPlan() }),
    });

    assert.strictEqual(res.status, 409);
    const body = (await res.json()) as {
      error: string;
      reason: string;
      unresolvable: Array<{ task: string; dependsOn: string; reason: string }>;
      hint: string;
    };
    assert.strictEqual(body.reason, "unresolvable_dependencies");
    assert.match(body.error, /cannot be written as a task graph/);
    // Singular here — one edge closes the cycle; the plural branch reads "close".
    assert.match(body.error, /1 of them closes a cycle/);
    assert.deepStrictEqual(
      body.unresolvable.map((u) => `${u.task}<-${u.dependsOn}`),
      ["a<-b"],
    );
    assert.strictEqual(body.unresolvable[0].reason, "cycle");
    assert.match(body.hint, /allow_unresolved_dependencies/);
  });

  test("the refusal happens before any project is created", async () => {
    // A refusal that had already called createProject() would need a live
    // database to get as far as 409. There is none here: the route answers
    // from the plan alone, which is exactly the ordering being asserted.
    const res = await app.request("/api/canvas/plan/to-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cyclic push", plan: cyclicPlan() }),
    });
    assert.strictEqual(res.status, 409);
    const body = (await res.json()) as { reason?: string; error: string };
    assert.strictEqual(body.reason, "unresolvable_dependencies");
    assert.doesNotMatch(body.error, /ECONNREFUSED|pool|database/i);
  });
});
