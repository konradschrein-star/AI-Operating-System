/**
 * Coding-project orchestrator tick — the "manager" from the multi-agent
 * design, implemented as deterministic code rather than another LLM layer
 * (cheaper, no telephone-game context loss, matches "DB owns state, queues
 * dispatch work"). Called from executor.ts's existing managerLoop() every
 * ~10s, same as managerTick()/reminderTick() — this is NOT a separate
 * process.
 *
 * Per tick:
 *   1. promote 'pending' tasks whose earlier rounds are all 'done' -> 'ready'
 *   2. claim 'ready' tasks with no run yet, spawn a `runs` row for each
 *      (role mission comes straight from agents/<role>.md — single source
 *      of truth shared with the Task-tool subagent definitions)
 *   3. reconcile 'running' tasks whose run has settled: done/failed, and
 *      for reviewer verdicts, spin up the next fix/re-review round or close
 *      the project out
 *
 * Global concurrency is NOT enforced here — every ready task eagerly gets a
 * `runs` row (status='queued'); the executor's own claim loop enforces the
 * agent.spawn_cap ceiling, so there's exactly one place that cap lives.
 */

import { readFileSync } from "node:fs";
import {
  promoteReadyTasks,
  claimReadyTasks,
  listSettledRunningTasks,
  createRunForTask,
  attachRun,
  setTaskStatus,
  createTask,
  setProjectStatus,
  closeFinishedProjects,
  type ProjectTask,
  type Project,
  type TaskRole,
} from "../db/projects.ts";
import { provisionWorkspace } from "./workspace.ts";
import { getFleetState } from "../db/ai_os.ts";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "/root/.claude/agents";
const MAX_FIX_CYCLES = 3;
let lastPauseLogAt = 0;

interface RoleConfig {
  mission: string;
  tools: string[] | null;
}

const roleConfigCache = new Map<TaskRole, RoleConfig>();

/** Read an agents/<role>.md file — the SAME file the Task-tool subagent
 *  system reads — and split it into the mission body (frontmatter stripped)
 *  and the `tools:` allowlist from the frontmatter. Single source of truth:
 *  editing agents/reviewer.md's tools line (e.g. dropping Write/Edit so it
 *  can only report findings, never silently fix them) changes both what the
 *  Task-tool subagent can do AND what a top-level project-run for that role
 *  can do. Cached — restart forge-executor after editing one of these files. */
function roleConfig(role: TaskRole): RoleConfig {
  const cached = roleConfigCache.get(role);
  if (cached) return cached;
  try {
    const raw = readFileSync(`${AGENTS_DIR}/${role}.md`, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    const frontmatter = fmMatch?.[1] ?? "";
    const mission = (fmMatch?.[2] ?? raw).trim();
    const toolsLine = /^tools:\s*(.+)$/m.exec(frontmatter)?.[1];
    const tools = toolsLine
      ? toolsLine.split(",").map((t) => t.trim()).filter(Boolean)
      : null;
    const cfg: RoleConfig = { mission, tools };
    roleConfigCache.set(role, cfg);
    return cfg;
  } catch {
    console.warn(`[project-tick] no agent definition for role ${role}, using a bare fallback`);
    const cfg: RoleConfig = { mission: `You are the ${role} for this coding project.`, tools: null };
    roleConfigCache.set(role, cfg);
    return cfg;
  }
}

function buildPrompt(task: ProjectTask, project: Project): string {
  const mission = roleConfig(task.role).mission;
  const header =
    `${mission}\n\n---\n\n` +
    `Project: ${project.name}\n` +
    `Repo: ${project.repo} — you are already inside its worktree (branch ${project.work_branch}, off ${project.base_branch}).\n` +
    `Project brief: ${project.brief}\n\n` +
    `Your task (round ${task.round}): ${task.title}\n${task.brief}\n`;

  if (task.role === "architect") {
    return (
      header +
      `\nWhen you're done: write a short plan to PLAN.md in the repo root. Then create the next ` +
      `round(s) of work by calling forge-control directly, e.g.:\n` +
      `curl -sX POST http://127.0.0.1:7700/api/projects/${project.id}/tasks -H 'content-type: application/json' ` +
      `-d '{"role":"builder","round":1,"title":"...","brief":"..."}'\n` +
      `Split implementation into focused, independently-completable builder tasks. Always end with exactly one ` +
      `"reviewer" task in the round right after your last builder round, briefed to review the whole diff. ` +
      `Do not write implementation code or commit anything yourself — that's the builder's job.`
    );
  }
  if (task.role === "reviewer") {
    return (
      header +
      `\nReview the actual diff (git diff ${project.base_branch}...HEAD) and the code itself, not just the ` +
      `plan or commit messages. End your final message with a line starting exactly with "VERDICT: PASS" if it's ` +
      `genuinely ready, or "VERDICT: NEEDS_FIXES" followed by a concrete numbered list (file:line, the problem, ` +
      `the fix) if not. Never skip the VERDICT line.`
    );
  }
  if (task.role === "builder") {
    return (
      header +
      `\nImplement this directly in the worktree (branch ${project.work_branch} is already checked out). ` +
      `Commit your changes with a clear message when done. Verify your own work before reporting done.`
    );
  }
  return header;
}

async function spawnTaskRuns(): Promise<void> {
  const claimed = await claimReadyTasks();
  for (const task of claimed) {
    try {
      if (!task.project.workspace_dir || !task.project.work_branch) {
        // Shouldn't normally happen (provisioning is synchronous at project
        // creation) but don't strand the task silently if it does.
        const ws = await provisionWorkspace(task.project);
        task.project.workspace_dir = ws.workspace_dir;
        task.project.work_branch = ws.work_branch;
      }
      const prompt = buildPrompt(task, task.project);
      const tools = roleConfig(task.role).tools;
      const run = await createRunForTask({
        title: `${task.project.name} · ${task.title}`,
        prompt,
        role: task.role,
        project_id: task.project_id,
        task_id: task.id,
        workspace_dir: task.project.workspace_dir,
        ...(tools ? { allowed_tools: tools } : {}),
      });
      await attachRun(task.id, run.id);
    } catch (e) {
      console.error(
        `[project-tick] failed to spawn run for task ${task.id} (${task.role}):`,
        e instanceof Error ? e.message : e,
      );
      await setTaskStatus(task.id, "failed").catch(() => {});
      await setProjectStatus(task.project_id, "blocked").catch(() => {});
    }
  }
}

async function reconcileReviewer(
  task: ProjectTask,
  lastText: string | null,
): Promise<void> {
  await setTaskStatus(task.id, "done");
  const verdict = /VERDICT:\s*(PASS|NEEDS_FIXES)/i.exec(lastText ?? "")?.[1]?.toUpperCase();

  if (verdict === "PASS") {
    return; // closeFinishedProjects() picks this up once every task is done
  }

  if (verdict !== "NEEDS_FIXES") {
    // No parseable verdict — don't guess, surface it instead of looping.
    console.warn(`[project-tick] reviewer task ${task.id} produced no VERDICT line`);
    await setProjectStatus(task.project_id, "blocked");
    return;
  }

  if (task.fix_cycle >= MAX_FIX_CYCLES) {
    await setProjectStatus(task.project_id, "blocked");
    console.warn(
      `[project-tick] project ${task.project_id} blocked — ${MAX_FIX_CYCLES} fix cycles exhausted`,
    );
    return;
  }

  const nextCycle = task.fix_cycle + 1;
  await createTask({
    project_id: task.project_id,
    round: task.round + 1,
    role: "builder",
    title: `Fix cycle ${nextCycle}`,
    brief: `Reviewer feedback from the previous round:\n\n${lastText}`,
    fix_cycle: nextCycle,
  });
  await createTask({
    project_id: task.project_id,
    round: task.round + 2,
    role: "reviewer",
    title: `Re-review after fix cycle ${nextCycle}`,
    brief: "Re-check the same concerns raised in the previous review round against the new diff.",
    fix_cycle: nextCycle,
  });
}

async function reconcileSettledTasks(): Promise<void> {
  const settled = await listSettledRunningTasks();
  for (const task of settled) {
    try {
      if (task.run_status !== "completed") {
        await setTaskStatus(task.id, "failed");
        await setProjectStatus(task.project_id, "blocked");
        continue;
      }
      if (task.role === "reviewer") {
        await reconcileReviewer(task, task.last_text);
      } else {
        await setTaskStatus(task.id, "done");
      }
    } catch (e) {
      console.error(
        `[project-tick] failed to reconcile task ${task.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

export async function projectTick(): Promise<void> {
  try {
    // promote/reconcile/close are pure bookkeeping (no new `runs` rows, no
    // spend) so they always run. spawnTaskRuns() is the one step that
    // creates work — that's the step that must respect the FREEZE switch,
    // exactly like cron-tick.ts gates its fire step but not its next_run_at
    // advancement. See feedback-ai-os-pause-mechanism: "off is off" means
    // EVERY path that can create billable work checks fleet_state, not just
    // the executor's claim loop.
    await promoteReadyTasks();
    const fleet = await getFleetState().catch(
      () => ({ status: "running" }) as { status: string },
    );
    if (fleet.status === "paused") {
      const now = Date.now();
      if (now - lastPauseLogAt > 5 * 60 * 1000) {
        console.log("[project-tick] fleet paused — holding new task runs");
        lastPauseLogAt = now;
      }
    } else {
      await spawnTaskRuns();
    }
    await reconcileSettledTasks();
    await closeFinishedProjects();
  } catch (e) {
    console.error("[project-tick] tick failed:", e instanceof Error ? e.message : e);
  }
}
