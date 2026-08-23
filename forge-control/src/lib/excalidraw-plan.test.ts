/**
 * Unit tests for lib/excalidraw-plan.ts.
 *
 * Tests:
 * 1. Actionable plan compilation from synthetic DAGs (topological phases,
 *    workstreams, task specs, role/tier selection, open questions).
 * 2. Plan compilation and markdown rendering from real vault drawings.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

import {
  compileCanvasPlan,
  compileCanvasPlanFromMarkdown,
  serializeCanvasPlanMarkdown,
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
});

