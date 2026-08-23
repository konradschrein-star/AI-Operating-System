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

  const isCorrupted =
    graph.ambiguities.some((a) => a.kind === "corrupted_labels") ||
    Boolean(graph.degraded && graph.degraded.includes("Suspect"));

  const planSummary = isCorrupted
    ? `⚠️ SUSPECT DRAWING: Actionable execution plan compiled from drawing "${graph.title}" with ${tasks.length} tasks across ${phases.length} phases and ${workstreams.length} workstreams. NOTE: Drawing exhibits systematic dropped-first-character label corruption; plan is provisional pending approved vault repair.`
    : `Actionable execution plan compiled from drawing "${graph.title}" with ${tasks.length} tasks across ${phases.length} phases and ${workstreams.length} workstreams.`;

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
 * Insertion Order — turning a plan into a real task graph without lying
 * ========================================================================== */

/** One `depends_on` edge that CANNOT survive the trip into `project_tasks`.
 *
 *  `project_tasks.depends_on` holds uuids of rows that already exist, so an
 *  edge can only be written once its target row has been inserted. Two edges
 *  can never satisfy that:
 *   - `cycle` — the target sits on a dependency cycle with the source, so no
 *     insertion order exists in which both edges point backwards. A cycle also
 *     makes the project unexecutable: `promoteReadyTasks()` waits for every
 *     dependency to be 'done', and neither member can ever get there.
 *   - `unknown_task` — the edge points at an id that is not in `plan.tasks`
 *     at all (a hand-edited plan, or a task deleted from the markdown while
 *     its dependents kept the reference). */
export interface UnresolvableDependency {
  /** Plan-local id of the task carrying the edge. */
  task: string;
  taskTitle: string;
  /** Plan-local id the edge points at. */
  dependsOn: string;
  /** Title of the target, or null when the target is not in the plan. */
  dependsOnTitle: string | null;
  reason: "cycle" | "unknown_task";
}

export interface PlanInsertionOrder {
  /** Every task in `plan.tasks`, reordered so that each task follows all of
   *  its resolvable dependencies. Cycle members come last, in plan order. */
  order: PlanTask[];
  /** EXACTLY the edges a sequential insert over `order` will fail to write —
   *  derived from `order` itself, not predicted, so it can neither miss a loss
   *  nor invent one. Empty means the task graph written to the database is
   *  edge-for-edge identical to the plan. */
  unresolvable: UnresolvableDependency[];
}

/** Order plan tasks for insertion so that no `depends_on` edge is silently
 *  lost, and NAME the edges that no order can save.
 *
 *  The caller used to insert in `plan.tasks` order (phase, then workstream,
 *  then id) and `.filter()` out any dependency whose row did not exist yet.
 *  That is correct only by luck: `phase` is graph depth, and two tasks at the
 *  same depth in different workstreams can still depend on one another, so a
 *  real edge could vanish with no error and no log — the drawing said "A then
 *  B" and the seeded project did not. Kahn's algorithm removes that class of
 *  loss entirely; what is left over is genuinely unrepresentable and is
 *  returned rather than dropped.
 *
 *  The returned `unresolvable` set is a REPLAY of the caller's insert over the
 *  returned `order`, not a prediction, so it is exactly the set of edges that
 *  will be missing from `project_tasks` — no more and no less. */
export function resolvePlanInsertionOrder(tasks: PlanTask[]): PlanInsertionOrder {
  const byId = new Map<string, PlanTask>();
  for (const t of tasks) byId.set(t.id, t);

  const titleOf = (id: string): string | null => byId.get(id)?.title ?? null;

  const unresolvable: UnresolvableDependency[] = [];
  /** Dependencies that CAN be honoured, i.e. point at a task in this plan. */
  const deps = new Map<string, string[]>();

  for (const t of tasks) {
    const keep: string[] = [];
    for (const d of t.depends_on) {
      if (d === t.id) {
        // A self-edge is a one-node cycle; report it in the same vocabulary.
        unresolvable.push({
          task: t.id,
          taskTitle: t.title,
          dependsOn: d,
          dependsOnTitle: t.title,
          reason: "cycle",
        });
        continue;
      }
      if (!byId.has(d)) {
        unresolvable.push({
          task: t.id,
          taskTitle: t.title,
          dependsOn: d,
          dependsOnTitle: null,
          reason: "unknown_task",
        });
        continue;
      }
      keep.push(d);
    }
    deps.set(t.id, keep);
  }

  const order: PlanTask[] = [];
  const emitted = new Set<string>();

  // Kahn, iterated in plan order so the output stays stable and still reads
  // phase-by-phase for everything the ordering does not force.
  let progressed = true;
  while (emitted.size < tasks.length && progressed) {
    progressed = false;
    for (const t of tasks) {
      if (emitted.has(t.id)) continue;
      const ready = deps.get(t.id)!.every((d) => emitted.has(d));
      if (!ready) continue;
      order.push(t);
      emitted.add(t.id);
      progressed = true;
    }
  }

  // Whatever Kahn could not place is blocked by a cycle — either it sits on
  // one, or it hangs downstream of one. Append it in plan order so the tasks
  // themselves are still created; the loss is confined to edges.
  for (const t of tasks) {
    if (emitted.has(t.id)) continue;
    order.push(t);
    emitted.add(t.id);
  }

  // Now REPLAY the insert the caller is about to do and record every edge it
  // will actually fail to write. Deriving the report from the final order —
  // rather than from the point Kahn stalled — is what keeps it exact: a task
  // downstream of a cycle (leaf <- b, where a <-> b) keeps its edge, because
  // by the time `leaf` is inserted `b` exists. Predicting instead of replaying
  // reported that surviving edge as lost, which is its own kind of lie.
  const inserted = new Set<string>();
  for (const t of order) {
    for (const d of deps.get(t.id)!) {
      if (inserted.has(d)) continue;
      unresolvable.push({
        task: t.id,
        taskTitle: t.title,
        dependsOn: d,
        dependsOnTitle: titleOf(d),
        reason: "cycle",
      });
    }
    inserted.add(t.id);
  }

  return { order, unresolvable };
}

/* ==========================================================================
 * Markdown Serialization
 * ========================================================================== */

export function serializeCanvasPlanMarkdown(plan: CanvasPlan): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${plan.title}`);
  lines.push("");

  const hasCorrupted = plan.ambiguities.some((a) => a.kind === "corrupted_labels");
  if (hasCorrupted) {
    lines.push("> [!CAUTION]");
    lines.push("> **SUSPECT DRAWING — PROVISIONAL PLAN ONLY**");
    lines.push("> This drawing exhibits systematic dropped-first-character label corruption on disk (e.g. `ontent Forge`, `HASE 1`).");
    lines.push("> A proposed repair table has been prepared in `HANDOFF.md` for Konrad to approve.");
    lines.push("> Do NOT execute or present truncated labels as ground truth until repair is approved.");
    lines.push("");
  }

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
