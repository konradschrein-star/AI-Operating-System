/**
 * Spatial Graph Parser for Excalidraw Drawings.
 *
 * Turns visual elements from .excalidraw.md drawings into a typed DAG
 * (DrawingGraph) with rich structural semantics:
 *  - Frame / container hierarchies and bound/contained text.
 *  - Explicit + spatial proximity arrow binding.
 *  - Status inference from drawing-specific legends and standard palette ramps.
 *  - Explicit ambiguity discovery: unconnected nodes, dangling arrows,
 *    directed cycles, unlabelled elements, and unmapped colors.
 *
 * Rule: Genuinely ambiguous structures are reported as questions, never
 * silently guessed.
 */

import {
  type ExcalidrawDrawing,
  type ExcalidrawDoc,
  parseExcalidrawMarkdown,
  EMPTY_DRAWING,
} from "./excalidraw-md.ts";
import {
  buildGraph,
  extractDrawing,
  colourName,
  type DrawingNode,
  type DrawingEdge,
  type DrawingGraph,
  type NodeRole,
  cleanPreamble,
  drawingTags,
  drawingTitle,
  isDrawingPath,
  isSuspectCorruptedDrawing,
} from "./excalidraw-extract.ts";

/* ==========================================================================
 * Types
 * ========================================================================== */

export type NodeLifecycleStatus =
  | "built"
  | "partial"
  | "planned"
  | "gap"
  | "blocked"
  | "proposal"
  | "unknown";

export interface GraphNode extends DrawingNode {
  status: NodeLifecycleStatus;
  statusReason: string;
}

export type EdgeResolution = "explicit" | "proximity" | "unresolved";

export interface GraphEdge extends DrawingEdge {
  resolvedBy: EdgeResolution;
}

export type AmbiguityKind =
  | "unconnected_node"
  | "dangling_arrow"
  | "cycle"
  | "unexplained_color"
  | "unlabelled_shape"
  | "straddling_node"
  | "corrupted_labels";

export type AmbiguitySeverity = "warning" | "question" | "info";

export interface GraphAmbiguity {
  id: string;
  kind: AmbiguityKind;
  severity: AmbiguitySeverity;
  elementIds: string[];
  label: string;
  description: string;
  question: string;
}

export interface ParsedDrawingGraph extends Omit<DrawingGraph, "nodes" | "edges"> {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ambiguities: GraphAmbiguity[];
  stats: DrawingGraph["stats"] & {
    totalNodes: number;
    totalEdges: number;
    cycleCount: number;
    ambiguityCount: number;
  };
}

/* ==========================================================================
 * Proximity Edge Resolution
 * ========================================================================== */

/** Maximum Euclidean distance (px) from an arrow endpoint to a shape bbox to snap */
const PROXIMITY_SNAP_PX = 50;

interface Point {
  x: number;
  y: number;
}

interface Rect {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Distance from point to axis-aligned bounding box. 0 if inside. */
function distancePointToRect(p: Point, r: Rect): number {
  const minX = r.x;
  const maxX = r.x + Math.abs(r.width);
  const minY = r.y;
  const maxY = r.y + Math.abs(r.height);

  const dx = Math.max(minX - p.x, 0, p.x - maxX);
  const dy = Math.max(minY - p.y, 0, p.y - maxY);

  return Math.sqrt(dx * dx + dy * dy);
}

function resolveEndpointProximity(
  p: Point,
  candidates: Rect[],
  maxDist = PROXIMITY_SNAP_PX,
): Rect | null {
  let closest: Rect | null = null;
  let minDist = Number.POSITIVE_INFINITY;
  let secondMinDist = Number.POSITIVE_INFINITY;

  for (const c of candidates) {
    const d = distancePointToRect(p, c);
    if (d < minDist) {
      secondMinDist = minDist;
      minDist = d;
      closest = c;
    } else if (d < secondMinDist) {
      secondMinDist = d;
    }
  }

  if (closest && minDist <= maxDist) {
    if (secondMinDist - minDist < 5 && secondMinDist <= maxDist) {
      return null;
    }
    return closest;
  }

  return null;
}

/* ==========================================================================
 * Status Interpretation (Legend & Palette)
 * ========================================================================== */

interface LegendRule {
  colorName: string;
  status: NodeLifecycleStatus;
  rawMeaning: string;
}

function parseLegendRules(legendLines: string[]): LegendRule[] {
  const rules: LegendRule[] = [];
  const PATTERN = /([a-z]+)\s*=\s*([^·,;|\n]+)/gi;

  for (const line of legendLines) {
    let m;
    while ((m = PATTERN.exec(line)) !== null) {
      const colorRaw = m[1].toLowerCase().trim();
      const meaningRaw = m[2].toLowerCase().trim();
      const cName = colourName(colorRaw) ?? colorRaw;

      let status: NodeLifecycleStatus = "unknown";
      if (/solid|built|done|existing|resolved|live|prod/i.test(meaningRaw)) {
        status = "built";
      } else if (/risk|highest-risk|danger|gap|wip|missing|investigate/i.test(meaningRaw)) {
        status = "gap";
      } else if (/phase|planned|future|todo|next|roadmap/i.test(meaningRaw)) {
        status = "planned";
      } else if (/block|stuck|stop|question|issue|bug/i.test(meaningRaw)) {
        status = "blocked";
      } else if (/partial|in-progress|active|draft/i.test(meaningRaw)) {
        status = "partial";
      } else if (/proposal|idea|branch|maybe|rfc/i.test(meaningRaw)) {
        status = "proposal";
      }

      rules.push({
        colorName: cName,
        status,
        rawMeaning: m[2].trim(),
      });
    }
  }

  return rules;
}

function inferNodeStatus(
  node: DrawingNode,
  legendRules: LegendRule[],
): { status: NodeLifecycleStatus; reason: string; unmappedColor: string | null } {
  const color = node.fill ?? (node.stroke !== "black" && node.stroke !== "grey" ? node.stroke : null);

  if (!color) {
    return {
      status: "planned",
      reason: "default (uncoloured / neutral)",
      unmappedColor: null,
    };
  }

  const match = legendRules.find((r) => r.colorName === color);
  if (match) {
    return {
      status: match.status !== "unknown" ? match.status : "planned",
      reason: "legend: " + JSON.stringify(color + " = " + match.rawMeaning),
      unmappedColor: null,
    };
  }

  switch (color) {
    case "green":
      return {
        status: "built",
        reason: "palette: green (standard convention: solid/built)",
        unmappedColor: null,
      };
    case "orange":
    case "amber":
    case "yellow":
      return {
        status: "gap",
        reason: "palette: " + color + " (standard convention: risk/gap/in-progress)",
        unmappedColor: color,
      };
    case "red":
      return {
        status: "blocked",
        reason: "palette: red (standard convention: blocked/critical/question)",
        unmappedColor: color,
      };
    case "blue":
      return {
        status: "planned",
        reason: "palette: blue (standard convention: planned/phase)",
        unmappedColor: null,
      };
    case "violet":
    case "cyan":
      return {
        status: "proposal",
        reason: "palette: " + color + " (standard convention: proposal/concept)",
        unmappedColor: color,
      };
    default:
      return {
        status: "planned",
        reason: "palette: " + color + " (no legend rule)",
        unmappedColor: color,
      };
  }
}

/* ==========================================================================
 * Directed Cycle Detection
 * ========================================================================== */

export function findCyclesInGraph(
  nodes: Array<{ id: string; label: string }>,
  edges: Array<{ fromId: string | null; toId: string | null; directed?: boolean }>,
): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    adj.set(n.id, []);
  }

  for (const e of edges) {
    if (e.fromId && e.toId && (e.directed !== false)) {
      if (!adj.has(e.fromId)) adj.set(e.fromId, []);
      adj.get(e.fromId)!.push(e.toId);
    }
  }

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function dfs(curr: string) {
    visited.add(curr);
    onStack.add(curr);
    stack.push(curr);

    const neighbors = adj.get(curr) ?? [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        dfs(next);
      } else if (onStack.has(next)) {
        const cycleStartIndex = stack.indexOf(next);
        if (cycleStartIndex !== -1) {
          cycles.push(stack.slice(cycleStartIndex));
        }
      }
    }

    stack.pop();
    onStack.delete(curr);
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) {
      dfs(n.id);
    }
  }

  return cycles;
}

/* ==========================================================================
 * Main Graph Parser
 * ========================================================================== */

export function parseDrawingGraph(
  drawing: ExcalidrawDrawing,
  opts: {
    path?: string;
    title?: string;
    tags?: string[];
    prose?: string;
    degraded?: string | null;
  } = {},
): ParsedDrawingGraph {
  const base = buildGraph(drawing);
  const elements = Array.isArray(drawing.elements) ? drawing.elements : [];

  const rawElementById = new Map<string, Record<string, unknown>>();
  for (const el of elements) {
    if (el && typeof el === "object" && typeof el.id === "string") {
      rawElementById.set(el.id, el as Record<string, unknown>);
    }
  }

  const legendRules = parseLegendRules(base.legend);

  const candidateRects: Rect[] = [];
  const unmappedColorsSeen = new Map<string, string[]>();

  const enrichedNodes: GraphNode[] = base.nodes.map((n) => {
    const { status, reason, unmappedColor } = inferNodeStatus(n, legendRules);
    if (unmappedColor && n.label) {
      const arr = unmappedColorsSeen.get(unmappedColor) ?? [];
      arr.push(n.label || n.id);
      unmappedColorsSeen.set(unmappedColor, arr);
    }

    if (n.role === "shape" || n.role === "container" || n.role === "frame") {
      candidateRects.push({
        id: n.id,
        label: n.label,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
      });
    }

    return {
      ...n,
      status,
      statusReason: reason,
    };
  });

  const nodeById = new Map(enrichedNodes.map((n) => [n.id, n]));

  const enrichedEdges: GraphEdge[] = [];
  for (const e of base.edges) {
    let fromId = e.fromId;
    let toId = e.toId;
    let fromLabel = e.fromLabel;
    let toLabel = e.toLabel;
    let resolution: EdgeResolution = "explicit";

    const raw = rawElementById.get(e.id);

    if ((!fromId || !toId) && raw) {
      const x = typeof raw.x === "number" ? raw.x : 0;
      const y = typeof raw.y === "number" ? raw.y : 0;
      const points = Array.isArray(raw.points) ? (raw.points as number[][]) : [];

      if (points.length >= 2) {
        const startPt: Point = { x: x + (points[0][0] ?? 0), y: y + (points[0][1] ?? 0) };
        const endPt: Point = {
          x: x + (points[points.length - 1][0] ?? 0),
          y: y + (points[points.length - 1][1] ?? 0),
        };

        if (!fromId) {
          const matched = resolveEndpointProximity(startPt, candidateRects);
          if (matched) {
            fromId = matched.id;
            fromLabel = matched.label || null;
            resolution = "proximity";
          }
        }

        if (!toId) {
          const matched = resolveEndpointProximity(endPt, candidateRects);
          if (matched) {
            toId = matched.id;
            toLabel = matched.label || null;
            resolution = "proximity";
          }
        }
      }
    }

    if (!fromId || !toId) {
      resolution = "unresolved";
    }

    enrichedEdges.push({
      ...e,
      fromId,
      toId,
      fromLabel: fromLabel ?? (fromId ? nodeById.get(fromId)?.label || null : null),
      toLabel: toLabel ?? (toId ? nodeById.get(toId)?.label || null : null),
      resolvedBy: resolution,
    });
  }

  const ambiguities: GraphAmbiguity[] = [];
  let ambSeq = 0;
  const nextAmbId = (prefix: string) => prefix + "-" + (++ambSeq);

  const cycles = findCyclesInGraph(enrichedNodes, enrichedEdges);
  for (const cycle of cycles) {
    const cycleLabels = cycle.map((id) => nodeById.get(id)?.label || id);
    ambiguities.push({
      id: nextAmbId("cycle"),
      kind: "cycle",
      severity: "warning",
      elementIds: cycle,
      label: "Circular dependency (" + cycleLabels.length + " nodes)",
      description: "Cycle detected: " + cycleLabels.join(" → ") + " → " + cycleLabels[0],
      question: "Circular execution dependency detected across: " + cycleLabels.join(" → ") + ". Which step must execute first?",
    });
  }

  for (const edge of enrichedEdges) {
    if (edge.resolvedBy === "unresolved") {
      const fromDesc = edge.fromLabel ? JSON.stringify(edge.fromLabel) : "(unbound origin)";
      const toDesc = edge.toLabel ? JSON.stringify(edge.toLabel) : "(unbound target)";
      const arrowDesc = edge.label ? "labeled " + JSON.stringify(edge.label) : "arrow (" + edge.id + ")";

      ambiguities.push({
        id: nextAmbId("arrow"),
        kind: "dangling_arrow",
        severity: "question",
        elementIds: [edge.id, ...(edge.fromId ? [edge.fromId] : []), ...(edge.toId ? [edge.toId] : [])],
        label: "Dangling arrow: " + fromDesc + " → " + toDesc,
        description: "The " + arrowDesc + " has at least one unconnected endpoint.",
        question: "Arrow from " + fromDesc + " to " + toDesc + " is not clearly connected. Which shapes should it connect?",
      });
    }
  }

  const connectedNodeIds = new Set<string>();
  for (const edge of enrichedEdges) {
    if (edge.fromId) connectedNodeIds.add(edge.fromId);
    if (edge.toId) connectedNodeIds.add(edge.toId);
  }

  const containersWithChildren = new Set<string>();
  for (const node of enrichedNodes) {
    if (node.parentId) containersWithChildren.add(node.parentId);
  }

  for (const node of enrichedNodes) {
    if (node.isParentTitle) continue;
    if (node.role === "frame") continue;
    if (containersWithChildren.has(node.id)) continue;
    if (!node.label.trim()) continue;

    if (!connectedNodeIds.has(node.id) && !node.parentId) {
      ambiguities.push({
        id: nextAmbId("unconnected"),
        kind: "unconnected_node",
        severity: "info",
        elementIds: [node.id],
        label: "Unconnected node: " + JSON.stringify(node.label),
        description: "Node " + JSON.stringify(node.label) + " (" + node.role + ") has no incoming or outgoing arrows.",
        question: "Node " + JSON.stringify(node.label) + " stands alone without incoming/outgoing dependencies. What triggers or depends on it?",
      });
    }
  }

  for (const node of enrichedNodes) {
    if (node.role === "shape" && !node.label.trim() && !containersWithChildren.has(node.id)) {
      ambiguities.push({
        id: nextAmbId("unlabelled"),
        kind: "unlabelled_shape",
        severity: "info",
        elementIds: [node.id],
        label: "Unlabelled " + node.kind,
        description: "Shape " + node.id + " at (" + node.x + ", " + node.y + ") has no label or attached text.",
        question: "Unlabelled " + node.kind + " at (" + node.x + ", " + node.y + "). Is this an intentional placeholder or scratch element?",
      });
    }
  }

  if (base.legend.length === 0) {
    for (const [color, labels] of unmappedColorsSeen) {
      if (labels.length > 0) {
        const sample = labels.slice(0, 3).map((l) => JSON.stringify(l)).join(", ");
        ambiguities.push({
          id: nextAmbId("color"),
          kind: "unexplained_color",
          severity: "info",
          elementIds: [],
          label: "Unexplained colour: " + color,
          description: "Drawing uses colour " + JSON.stringify(color) + " on " + labels.length + " items (" + sample + ") without a legend.",
          question: "Colour " + JSON.stringify(color) + " is used on " + sample + " without an explicit legend. Does it denote risk, completion, or a specific phase?",
        });
      }
    }
  }

  const suspect = isSuspectCorruptedDrawing(opts.path ?? "", enrichedNodes);
  if (
    suspect.isSuspect ||
    (opts.degraded && (opts.degraded.includes("Suspect") || opts.degraded.includes("corrupt")))
  ) {
    ambiguities.unshift({
      id: nextAmbId("suspect"),
      kind: "corrupted_labels",
      severity: "warning",
      elementIds: [],
      label: "Suspect Drawing: First-character corruption detected",
      description:
        "This drawing exhibits systematic dropped-first-character label corruption (e.g. 'ontent Forge', 'HASE 1'). A proposed repair table has been prepared in HANDOFF.md pending approval.",
      question:
        "Drawing labels have lost their initial character (e.g. 'ontent Forge', 'HASE 1'). Do not treat derived plans as authoritative until repair is approved. Should proposed corrections be applied?",
    });
  }

  return {
    path: opts.path ?? (base.stats ? "" : ""),
    title: opts.title ?? (opts.path ? drawingTitle(opts.path) : "Untitled Drawing"),
    tags: opts.tags ?? [],
    prose: opts.prose ?? "",
    legend: base.legend,
    wikilinks: base.wikilinks,
    nodes: enrichedNodes,
    edges: enrichedEdges,
    ambiguities,
    degraded: opts.degraded ?? null,
    stats: {
      ...base.stats,
      totalNodes: enrichedNodes.length,
      totalEdges: enrichedEdges.length,
      cycleCount: cycles.length,
      ambiguityCount: ambiguities.length,
    },
  };
}

export function parseDrawingGraphFromMarkdown(
  raw: string,
  vaultPath = "",
): ParsedDrawingGraph {
  const doc = parseExcalidrawMarkdown(raw);
  const title = vaultPath ? drawingTitle(vaultPath) : "Drawing";
  const tags = drawingTags(doc.frontmatter);
  const prose = cleanPreamble(doc.preamble);

  return parseDrawingGraph(doc.drawing, {
    path: vaultPath,
    title,
    tags,
    prose,
  });
}
