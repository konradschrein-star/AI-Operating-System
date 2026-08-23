/**
 * Unit tests for lib/excalidraw-graph.ts.
 *
 * Tests:
 * 1. Synthetic drawing fixtures (explicit bindings, proximity bindings, legend-based
 *    and palette status inference, cycle detection, ambiguity discovery).
 * 2. Real drawings in Konrads vault (/opt/obsidian-vault/Excalidraw/).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

import {
  parseDrawingGraph,
  parseDrawingGraphFromMarkdown,
  findCyclesInGraph,
  type ParsedDrawingGraph,
} from "./excalidraw-graph.ts";
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

describe("excalidraw-graph: synthetic fixtures", () => {
  test("status inference: legend overrides palette default", () => {
    const raw = draw([
      text({ id: "t-leg", text: "green = solid path \u00b7 orange = highest-risk", x: 0, y: -50 }),
      shape({ id: "s-green", backgroundColor: "#2f9e44", x: 0, y: 0 }),
      text({ id: "t-green", containerId: "s-green", text: "Solid Engine", x: 10, y: 10 }),
      shape({ id: "s-orange", backgroundColor: "#ffd8a8", x: 150, y: 0 }),
      text({ id: "t-orange", containerId: "s-orange", text: "Risk Feature", x: 160, y: 10 }),
    ]);

    const g = parseDrawingGraphFromMarkdown(raw, "Excalidraw/Test.excalidraw.md");
    const solidNode = g.nodes.find((n) => n.id === "s-green");
    const riskNode = g.nodes.find((n) => n.id === "s-orange");

    assert.ok(solidNode);
    assert.strictEqual(solidNode.status, "built");
    assert.match(solidNode.statusReason, /legend: "green = solid path"/i);

    assert.ok(riskNode);
    assert.strictEqual(riskNode.status, "gap");
    assert.match(riskNode.statusReason, /legend: "orange = highest-risk"/i);
  });

  test("proximity edge resolution: snaps arrow endpoints near shapes", () => {
    const raw = draw([
      shape({ id: "s1", x: 100, y: 100, width: 100, height: 50 }),
      text({ id: "t1", containerId: "s1", text: "Node A", x: 110, y: 110 }),
      shape({ id: "s2", x: 300, y: 100, width: 100, height: 50 }),
      text({ id: "t2", containerId: "s2", text: "Node B", x: 310, y: 110 }),
      // Arrow starts at (205, 125) which is 5px from s1 right edge, ends at (295, 125) 5px from s2 left edge
      arrow({
        id: "arr-prox",
        x: 205,
        y: 125,
        points: [
          [0, 0],
          [90, 0],
        ],
      }),
    ]);

    const g = parseDrawingGraphFromMarkdown(raw, "Excalidraw/Proximity.excalidraw.md");
    const edge = g.edges.find((e) => e.id === "arr-prox");
    assert.ok(edge);
    assert.strictEqual(edge.fromId, "s1");
    assert.strictEqual(edge.toId, "s2");
    assert.strictEqual(edge.resolvedBy, "proximity");
    assert.strictEqual(edge.fromLabel, "Node A");
    assert.strictEqual(edge.toLabel, "Node B");
  });

  test("cycle detection: identifies circular loops and records ambiguity", () => {
    const raw = draw([
      shape({ id: "s1", x: 0, y: 0 }),
      text({ id: "t1", containerId: "s1", text: "Step 1" }),
      shape({ id: "s2", x: 200, y: 0 }),
      text({ id: "t2", containerId: "s2", text: "Step 2" }),
      shape({ id: "s3", x: 200, y: 200 }),
      text({ id: "t3", containerId: "s3", text: "Step 3" }),
      arrow({ id: "a1", startBinding: { elementId: "s1" }, endBinding: { elementId: "s2" } }),
      arrow({ id: "a2", startBinding: { elementId: "s2" }, endBinding: { elementId: "s3" } }),
      arrow({ id: "a3", startBinding: { elementId: "s3" }, endBinding: { elementId: "s1" } }),
    ]);

    const g = parseDrawingGraphFromMarkdown(raw, "Excalidraw/Cycle.excalidraw.md");
    assert.strictEqual(g.stats.cycleCount, 1);

    const cycleAmb = g.ambiguities.find((a) => a.kind === "cycle");
    assert.ok(cycleAmb);
    assert.strictEqual(cycleAmb.severity, "warning");
    assert.match(cycleAmb.description, /Step 1 → Step 2 → Step 3/);
  });

  test("ambiguities: flags unconnected nodes and dangling arrows", () => {
    const raw = draw([
      shape({ id: "s-isolated", x: 500, y: 500, width: 80, height: 40 }),
      text({ id: "t-isolated", containerId: "s-isolated", text: "Orphan Task" }),
      // Dangling arrow out in nowhere
      arrow({
        id: "a-dangle",
        x: 1000,
        y: 1000,
        points: [
          [0, 0],
          [50, 50],
        ],
      }),
    ]);

    const g = parseDrawingGraphFromMarkdown(raw, "Excalidraw/Ambiguous.excalidraw.md");
    const unconn = g.ambiguities.find((a) => a.kind === "unconnected_node");
    assert.ok(unconn);
    assert.strictEqual(unconn.elementIds[0], "s-isolated");

    const dangle = g.ambiguities.find((a) => a.kind === "dangling_arrow");
    assert.ok(dangle);
    assert.strictEqual(dangle.elementIds[0], "a-dangle");
  });
});

describe("excalidraw-graph: real vault drawings", () => {
  const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";

  async function exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  test("Stealth Uploader - System Map.excalidraw.md parses into rich graph", async () => {
    const filePath = path.join(VAULT_DIR, "Excalidraw/Stealth Uploader - System Map.excalidraw.md");
    if (!(await exists(filePath))) return;

    const raw = await readFile(filePath, "utf8");
    const g = parseDrawingGraphFromMarkdown(raw, "Excalidraw/Stealth Uploader - System Map.excalidraw.md");

    assert.ok(g.nodes.length > 30, "expected > 30 nodes");
    assert.ok(g.edges.length > 10, "expected > 10 edges");
    assert.ok(g.legend.length > 0, "expected legend rules");

    // Check legend extraction
    const builtNodes = g.nodes.filter((n) => n.status === "built");
    const gapNodes = g.nodes.filter((n) => n.status === "gap");
    assert.ok(builtNodes.length > 0, "expected some built nodes");
    assert.ok(gapNodes.length > 0, "expected some gap/risk nodes");

    // Suspect drawing protection: corrupted_labels ambiguity is flagged
    const corruptAmb = g.ambiguities.find((a) => a.kind === "corrupted_labels");
    assert.ok(corruptAmb, "suspect drawing must flag corrupted_labels ambiguity");
    assert.strictEqual(corruptAmb.severity, "warning");
  });

  test("Stealth Uploader - Warming Timeline.excalidraw.md parses into phases", async () => {
    const filePath = path.join(VAULT_DIR, "Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md");
    if (!(await exists(filePath))) return;

    const raw = await readFile(filePath, "utf8");
    const g = parseDrawingGraphFromMarkdown(raw, "Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md");

    assert.ok(g.nodes.length > 15);
    assert.ok(g.stats.liveElements > 0);

    const corruptAmb = g.ambiguities.find((a) => a.kind === "corrupted_labels");
    assert.ok(corruptAmb, "warming timeline must flag corrupted_labels ambiguity");
  });
});
