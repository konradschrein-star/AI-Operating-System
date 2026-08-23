/**
 * Actionable Plan Engine for Excalidraw Drawings.
 *
 * Compiles a typed DrawingGraph into an actionable, phased execution plan
 * (CanvasPlan):
 *  - Topologically sorted phases and workstreams.
 *  - Typed task specs (role, tier, depends_on, brief, write_set).
 *  - Explicit "Ambiguities & Open Questions" section that highlights
 *    unresolved structural uncertainties with concrete questions rather
 *    than guessing.
 *  - Bi-directional Markdown serialization for <drawing>.plan.md vault notes.
 */

import {
  type ExcalidrawDrawing,
  parseExcalidrawMarkdown,
} from "./excalidraw-md.ts";
import {
  parseDrawingGraph,
  parseDrawingGraphFromMarkdown,
  type ParsedDrawingGraph,
  type GraphNode,
  type GraphEdge,
  type GraphAmbiguity,
  type NodeLifecycleStatus,
} from "./excalidraw-graph.ts";
import type { TaskRole, TaskTier } from "../db/projects.ts";

/* ==========================================================================
 * Types
 * ========================================================================== */

export type PlanTaskStatus =
  | "done"
  | "in_progress"
  | "planned"
  | "gap"
  | "blocked"
  | "proposal";

export interface PlanTask {
  id: string;
  nodeId: string;
  title: string;
  workstream: string;
  phase: number;
  status: PlanTaskStatus;
  statusReason: string;
  depends_on: string[];
  role: TaskRole;
  tier: TaskTier;
  write_set: string[];
  brief: string;
  link: string | null;
}

export interface PlanWorkstream {
  id: string;
  name: string;
  containerId: string | null;
  taskIds: string[];
  summary: string;
}

export interface PlanPhase {
  phase: number;
  name: string;
  taskIds: string[];
}

export interface CanvasPlan {
  path: string;
  title: string;
  summary: string;
  workstreams: PlanWorkstream[];
  phases: PlanPhase[];
  tasks: PlanTask[];
  ambiguities: GraphAmbiguity[];
  stats: {
    totalTasks: number;
    totalPhases: number;
    totalWorkstreams: number;
    ambiguityCount: number;
    completedTasks: number;
    blockedTasks: number;
  };
  rawMarkdown: string;
}

/* ==========================================================================
 * Heuristics: Role, Tier, Brief, and Slug
 * ========================================================================== */

function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "task";
}

function mapNodeStatusToPlanStatus(status: NodeLifecycleStatus): PlanTaskStatus {
  switch (status) {
    case "built":
      return "done";
    case "partial":
      return "in_progress";
    case "gap":
      return "gap";
    case "blocked":
      return "blocked";
    case "proposal":
      return "proposal";
    case "planned":
    case "unknown":
    default:
      return "planned";
  }
}

function inferTaskRoleAndTier(
  title: string,
  workstream: string,
  status: PlanTaskStatus,
): { role: TaskRole; tier: TaskTier } {
  const text = (title + " " + workstream).toLowerCase();

  if (/\b(review|reviewer|audit|verify|verification|gate|assert|check|test|eval)\b/.test(text)) {
    return { role: "reviewer", tier: "standard" };
  }
  if (/\b(architect|spec|design|schema|rfc|protocol|boundary|strategy)\b/.test(text)) {
    return { role: "architect", tier: "flagship" };
  }
  if (/\b(scout|explore|recon|survey|inspect|probe|scrape|search|sample)\b/.test(text)) {
    return { role: "scout", tier: "fast" };
  }
  if (/\b(plan|roadmap|schedule|reconcile|triage)\b/.test(text)) {
    return { role: "planner", tier: "standard" };
  }

  // Builders
  if (status === "gap" || /\b(refactor|rewrite|core|engine|compiler|daemon)\b/.test(text)) {
    return { role: "builder", tier: "standard" };
  }
  if (/\b(cleanup|typo|rename|comment|doc|format|lint)\b/.test(text)) {
    return { role: "builder", tier: "fast" };
  }

  return { role: "builder", tier: "standard" };
}

function inferWriteSet(title: string, workstream: string): string[] {
  const out = new Set<string>();
  const combined = title + " " + workstream;
  const pathMatches = combined.match(/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z0-9]+/g);
  if (pathMatches) {
    for (const p of pathMatches) out.add(p);
  }
  return [...out];
}

function generateTaskBrief(
  title: string,
  workstream: string,
  phase: number,
  status: PlanTaskStatus,
  statusReason: string,
  predecessorTitles: string[],
): string {
  const lines: string[] = [];
  lines.push(`Implement / execute [${title}] within workstream "${workstream}" (Phase ${phase}).`);
  if (predecessorTitles.length > 0) {
    lines.push(`Prerequisites: ${predecessorTitles.map((t) => `"${t}"`).join(", ")}.`);
  } else {
    lines.push("Prerequisites: None (root / initial task).");
  }
  lines.push(`Status: ${status} (${statusReason}).`);
  return lines.join("\n");
}

/* ==========================================================================
 * Plan Compilation (Topological Sorting & Workstreams)
 * ========================================================================== */

export function compileCanvasPlan(graph: ParsedDrawingGraph): CanvasPlan {
  const containerMap = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (n.role === "container" || n.role === "frame") {
      containerMap.set(n.id, n);
    }
  }

  // Actionable nodes: shapes and texts that are not pure container frames or container titles
  const actionableNodes = graph.nodes.filter((n) => {
    if (n.isParentTitle) return false;
    if (n.role === "frame") return false;
    if (n.role === "container" && containerMap.has(n.id)) return false;
    return Boolean(n.label.trim());
  });

  const nodeToTaskId = new Map<string, string>();
  const slugCounts = new Map<string, number>();

  let seq = 0;
  for (const n of actionableNodes) {
    seq++;
    const baseSlug = slugify(n.label).slice(0, 30);
    const count = (slugCounts.get(baseSlug) ?? 0) + 1;
    slugCounts.set(baseSlug, count);
    const id = count === 1 ? `t${seq}-${baseSlug}` : `t${seq}-${baseSlug}-${count}`;
    nodeToTaskId.set(n.id, id);
  }

  // Map graph edges to task dependencies
  const incomingTaskDeps = new Map<string, Set<string>>();
  const outgoingTaskEdges = new Map<string, Set<string>>();

  for (const tid of nodeToTaskId.values()) {
    incomingTaskDeps.set(tid, new Set());
    outgoingTaskEdges.set(tid, new Set());
  }

  for (const e of graph.edges) {
    if (e.fromId && e.toId && e.directed !== false) {
      const fromTask = nodeToTaskId.get(e.fromId);
      const toTask = nodeToTaskId.get(e.toId);
      if (fromTask && toTask && fromTask !== toTask) {
        incomingTaskDeps.get(toTask)?.add(fromTask);
        outgoingTaskEdges.get(fromTask)?.add(toTask);
      }
    }
  }

  // Topological sorting & Phase assignment (DAG Layering)
  const inDegree = new Map<string, number>();
  for (const [tid, deps] of incomingTaskDeps) {
    inDegree.set(tid, deps.size);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];

  for (const [tid, deg] of inDegree) {
    if (deg === 0) {
      depth.set(tid, 1);
      queue.push(tid);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currDepth = depth.get(curr) ?? 1;

    const nextTasks = outgoingTaskEdges.get(curr) ?? new Set();
    for (const next of nextTasks) {
      const nextCurrentDepth = depth.get(next) ?? 1;
      depth.set(next, Math.max(nextCurrentDepth, currDepth + 1));

      const deg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        queue.push(next);
      }
    }
  }

  // Handle tasks in cycles or unreached tasks
  for (const tid of nodeToTaskId.values()) {
    if (!depth.has(tid)) {
      depth.set(tid, 1);
    }
  }

  // Build Workstreams
  const workstreamTasks = new Map<string, string[]>();
  const workstreamContainers = new Map<string, string | null>();

  for (const n of actionableNodes) {
    const tid = nodeToTaskId.get(n.id)!;
    let wsName = "Core";
    let wsContainerId: string | null = null;

    if (n.parentId && containerMap.has(n.parentId)) {
      const parent = containerMap.get(n.parentId)!;
      wsName = parent.label.trim() || `Workstream ${parent.id}`;
      wsContainerId = parent.id;
    }

    const list = workstreamTasks.get(wsName) ?? [];
    list.push(tid);
    workstreamTasks.set(wsName, list);
    workstreamContainers.set(wsName, wsContainerId);
  }

  const workstreams: PlanWorkstream[] = [];
  for (const [name, taskIds] of workstreamTasks) {
    workstreams.push({
      id: slugify(name),
      name,
      containerId: workstreamContainers.get(name) ?? null,
      taskIds,
      summary: `Contains ${taskIds.length} actionable tasks.`,
    });
  }

  // Build Tasks
  const taskMap = new Map<string, PlanTask>();
  const tasks: PlanTask[] = [];

  for (const n of actionableNodes) {
    const tid = nodeToTaskId.get(n.id)!;
    const planStatus = mapNodeStatusToPlanStatus(n.status);
    const wsName = n.parentId && containerMap.has(n.parentId)
      ? containerMap.get(n.parentId)!.label.trim() || "Core"
      : "Core";
    const phase = depth.get(tid) ?? 1;
    const { role, tier } = inferTaskRoleAndTier(n.label, wsName, planStatus);
    const prereqIds = Array.from(incomingTaskDeps.get(tid) ?? []);
    const writeSet = inferWriteSet(n.label, wsName);

    const task: PlanTask = {
      id: tid,
      nodeId: n.id,
      title: n.label,
      workstream: wsName,
      phase,
      status: planStatus,
      statusReason: n.statusReason,
      depends_on: prereqIds,
      role,
      tier,
      write_set: writeSet,
      brief: "",
      link: n.link,
    };
    tasks.push(task);
    taskMap.set(tid, task);
  }

  // Populate briefs with resolved predecessor titles
  for (const t of tasks) {
    const predTitles = t.depends_on.map((pid) => taskMap.get(pid)?.title || pid);
    t.brief = generateTaskBrief(t.title, t.workstream, t.phase, t.status, t.statusReason, predTitles);
  }

  // Sort tasks by phase, then workstream, then id
  tasks.sort((a, b) => a.phase - b.phase || a.workstream.localeCompare(b.workstream) || a.id.localeCompare(b.id));

  // Build Phases
  const phaseMap = new Map<number, string[]>();
  for (const t of tasks) {
    const list = phaseMap.get(t.phase) ?? [];
    list.push(t.id);
    phaseMap.set(t.phase, list);
  }

  const phases: PlanPhase[] = Array.from(phaseMap.entries())
    .sort(([p1], [p2]) => p1 - p2)
    .map(([phaseNum, taskIds]) => ({
      phase: phaseNum,
      name: `Phase ${phaseNum}`,
      taskIds,
    }));

  const completedCount = tasks.filter((t) => t.status === "done").length;
  const blockedCount = tasks.filter((t) => t.status === "blocked").length;

  const planSummary = `Actionable execution plan compiled from drawing "${graph.title}" with ${tasks.length} tasks across ${phases.length} phases and ${workstreams.length} workstreams.`;

  const plan: CanvasPlan = {
    path: graph.path,
    title: graph.title,
    summary: planSummary,
    workstreams,
    phases,
    tasks,
    ambiguities: graph.ambiguities,
    stats: {
      totalTasks: tasks.length,
      totalPhases: phases.length,
      totalWorkstreams: workstreams.length,
      ambiguityCount: graph.ambiguities.length,
      completedTasks: completedCount,
      blockedTasks: blockedCount,
    },
    rawMarkdown: "",
  };

  plan.rawMarkdown = serializeCanvasPlanMarkdown(plan);
  return plan;
}

export function compileCanvasPlanFromDrawing(
  drawing: ExcalidrawDrawing,
  opts?: { path?: string; title?: string; tags?: string[]; prose?: string },
): CanvasPlan {
  const g = parseDrawingGraph(drawing, opts);
  return compileCanvasPlan(g);
}

export function compileCanvasPlanFromMarkdown(
  rawMarkdown: string,
  vaultPath = "",
): CanvasPlan {
  const g = parseDrawingGraphFromMarkdown(rawMarkdown, vaultPath);
  return compileCanvasPlan(g);
}

/* ==========================================================================
 * Markdown Serialization
 * ========================================================================== */

export function serializeCanvasPlanMarkdown(plan: CanvasPlan): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${plan.title}`);
  lines.push("");
  lines.push(plan.summary);
  lines.push("");

  // Ambiguities & Open Questions section — PROMINENT
  if (plan.ambiguities.length > 0) {
    lines.push("## Ambiguities & Open Questions");
    lines.push("");
    lines.push("> [!WARNING]");
    lines.push(`> The drawing contains ${plan.ambiguities.length} unresolved questions or structural ambiguities that should be clarified rather than guessed:`);
    lines.push("");
    for (const amb of plan.ambiguities) {
      lines.push(`- **${amb.label}** (${amb.kind}, ${amb.severity}): ${amb.question}`);
    }
    lines.push("");
  }

  // Workstreams overview
  lines.push("## Workstreams");
  lines.push("");
  for (const ws of plan.workstreams) {
    lines.push(`- **${ws.name}** (${ws.taskIds.length} tasks)`);
  }
  lines.push("");

  // Phased execution plan
  lines.push("## Phased Execution Plan");
  lines.push("");

  for (const p of plan.phases) {
    lines.push(`### ${p.name}`);
    lines.push("");
    for (const tid of p.taskIds) {
      const t = plan.tasks.find((task) => task.id === tid);
      if (!t) continue;

      const checkbox = t.status === "done" ? "[x]" : "[ ]";
      const statusBadge = t.status !== "planned" ? ` [${t.status.toUpperCase()}]` : "";
      lines.push(`${checkbox} **${t.title}**${statusBadge} (\`${t.role}\`, tier: \`${t.tier}\`, workstream: \`${t.workstream}\`)`);
      if (t.depends_on.length > 0) {
        lines.push(`  - **Depends on**: ${t.depends_on.join(", ")}`);
      } else {
        lines.push("  - **Depends on**: None (root)");
      }
      lines.push(`  - **Brief**: ${t.brief.replace(/\n/g, " ")}`);
      if (t.write_set.length > 0) {
        lines.push(`  - **Write set**: ${t.write_set.join(", ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
