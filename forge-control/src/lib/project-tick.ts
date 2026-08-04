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
  setProjectWorkspace,
  closeFinishedProjects,
  getProject,
  type ProjectTask,
  type Project,
  type TaskRole,
  type TaskTier,
} from "../db/projects.ts";
import {
  patchProjectMetadata,
  listGoalProgress,
} from "../db/projects.ts";
import { provisionWorkspace } from "./workspace.ts";
import { getFleetState } from "../db/ai_os.ts";
import { sanitizeModel, sanitizeEffort } from "./cc-runner.ts";
import { queueNotification } from "../db/notifications.ts";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "/root/.claude/agents";
const MAX_FIX_CYCLES = 3;
let lastPauseLogAt = 0;

/** Model/effort per tier — only architect and builder tasks are ever
 *  assigned one (see docs/superpowers/specs/2026-07-11-manager-orchestration-
 *  model-tiering-design.md). Overrides the role file's static model:/effort:
 *  when a task carries a tier. */
const TIER_MODELS: Record<TaskTier, { model: string; effort: string }> = {
  fast: { model: "claude-haiku-4-5-20251001", effort: "medium" },
  standard: { model: "claude-sonnet-4-6", effort: "high" },
  flagship: { model: "claude-opus-4-8", effort: "high" },
};

interface RoleConfig {
  mission: string;
  tools: string[] | null;
  model: string | null;
  effort: string | null;
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
    const model = sanitizeModel(/^model:\s*(.+)$/m.exec(frontmatter)?.[1]);
    const effort = sanitizeEffort(/^effort:\s*(.+)$/m.exec(frontmatter)?.[1]);
    const cfg: RoleConfig = { mission, tools, model, effort };
    roleConfigCache.set(role, cfg);
    return cfg;
  } catch {
    console.warn(`[project-tick] no agent definition for role ${role}, using a bare fallback`);
    const cfg: RoleConfig = {
      mission: `You are the ${role} for this coding project.`,
      tools: null,
      model: null,
      effort: null,
    };
    roleConfigCache.set(role, cfg);
    return cfg;
  }
}

function isGoalMode(project: Project): boolean {
  return (project.metadata as { mode?: string } | null)?.mode === "goal";
}

function taskCurl(projectId: string): string {
  return (
    `curl -sX POST http://127.0.0.1:7700/api/projects/${projectId}/tasks -H 'content-type: application/json' ` +
    `-d '{"role":"builder","round":1,"title":"...","brief":"...","tier":"standard"}'`
  );
}

const TIER_GUIDE =
  `Each task's "tier" picks its model: "fast" (Haiku) for straightforward, well-specified work, ` +
  `"standard" (Sonnet) for most tasks, "flagship" (Opus) only when a task genuinely needs the strongest ` +
  `model. Omit tier to fall back to the default. Don't over-use flagship — it's the expensive one.`;

const PARALLELISM_GUIDE =
  `Tasks in the SAME round run in PARALLEL inside the SAME worktree — only put tasks in one round when they ` +
  `touch disjoint files. Anything that could collide goes in consecutive rounds instead. Rounds only gate ` +
  `ordering (round N+1 starts when everything <= N is done); gaps in round numbers are fine and cost nothing.`;

function buildPrompt(task: ProjectTask, project: Project): string {
  const mission = roleConfig(task.role).mission;
  const header =
    `${mission}\n\n---\n\n` +
    `Project: ${project.name}\n` +
    `Repo: ${project.repo} — you are already inside its worktree (branch ${project.work_branch}, off ${project.base_branch}).\n` +
    `Project brief: ${project.brief}\n\n` +
    `Your task (round ${task.round}): ${task.title}\n${task.brief}\n`;

  if (task.role === "architect") {
    if (isGoalMode(project)) {
      return (
        header +
        `\nThis is a GOAL-MODE project: a long-horizon goal that may take many hours or days of autonomous ` +
        `multi-agent work. You are the architect; your job tonight is the waterfall plan, done so thoroughly ` +
        `that implementation never has to loop back to re-litigate scope.\n\n` +
        `1) PLANNING CORPUS. Write an exhaustive set of planning documents under docs/plan/ in the worktree ` +
        `and commit them:\n` +
        `   - docs/plan/00-vision.md — the goal restated precisely, definition of done, measurable success criteria, explicit non-goals.\n` +
        `   - docs/plan/01-requirements.md — every functional and non-functional requirement, numbered (R1, R2, ...), each testable.\n` +
        `   - docs/plan/02-architecture.md — system design: components, data models, interfaces, technology choices with one-line rationale, failure modes, how progress/state is observable.\n` +
        `   - docs/plan/03-quality.md — test strategy (unit, integration, end-to-end), QA gates per phase, what the reviewer must run and check.\n` +
        `   - docs/plan/04-phases.md — the waterfall itself: numbered phases, each with scope, deliverables, acceptance criteria, and which requirement IDs it covers. Every requirement maps to exactly one phase.\n` +
        `   Depth beats brevity here — thousands of lines across the corpus is normal for a real goal. ` +
        `Research with your tools (codebase, vault, web) before deciding; never plan from guesswork.\n\n` +
        `2) SEED THE PIPELINE. Create ONE planner task per phase via the API:\n${taskCurl(project.id)}\n` +
        `   Phase k's planner goes at round k*100 (100, 200, 300, ...) — the gaps leave room for fix cycles ` +
        `without colliding with the next phase. Each planner brief: "Plan phase k per docs/plan/04-phases.md" ` +
        `plus anything phase-specific the corpus doesn't capture. If a phase needs research first, add a scout ` +
        `task at round k*100 - 1. For high-risk phases, tell the planner to add adversarial review (a red-team ` +
        `reviewer briefed to attack, not just check).\n` +
        `   ${PARALLELISM_GUIDE}\n   ${TIER_GUIDE}\n\n` +
        `3) GIT/GITHUB. If the repo has an origin remote you may push the work branch so progress is visible ` +
        `on GitHub; never force-push, never open PRs unless the brief asks.\n\n` +
        `Do not write implementation code or commit anything outside docs/plan/ — that's the builders' job.`
      );
    }
    return (
      header +
      `\nWhen you're done: write a short plan to PLAN.md in the repo root. Then create the next ` +
      `round(s) of work by calling forge-control directly, e.g.:\n` +
      `${taskCurl(project.id)}\n` +
      `Split implementation into focused, independently-completable builder tasks. Always end with exactly one ` +
      `"reviewer" task in the round right after your last builder round, briefed to review the whole diff. ` +
      `Do not write implementation code or commit anything yourself — that's the builder's job.\n` +
      TIER_GUIDE
    );
  }
  if (task.role === "planner") {
    return (
      header +
      `\nRead the planning corpus under docs/plan/ (if present) and the current state of the worktree, then ` +
      `break YOUR assigned scope into concrete builder tasks by calling forge-control:\n` +
      `${taskCurl(project.id)}\n` +
      `Your round is ${task.round}. Create builder tasks at round ${task.round + 1} (and ${task.round + 2}, ` +
      `${task.round + 3}, ... if they must run sequentially), and ALWAYS finish with exactly one reviewer task ` +
      `in the round after your last builder round, briefed with the phase's acceptance criteria and exactly ` +
      `which tests/commands to run. Each builder brief must be self-contained: files to touch, the approach, ` +
      `and how the builder verifies its own work (tests to write/run). Do not exceed round ${task.round + 20} — ` +
      `the space beyond that belongs to fix cycles and the next phase.\n` +
      `${PARALLELISM_GUIDE}\n${TIER_GUIDE}\n` +
      `Do not write implementation code yourself — plan, then fan out.`
    );
  }
  if (task.role === "scout") {
    return (
      header +
      `\nResearch only — no implementation, no task creation. Write your findings to ` +
      `docs/research/round-${task.round}-${task.id.slice(0, 8)}.md in the worktree and commit that one file. ` +
      `Findings must be concrete enough that a planner can act on them without repeating the research.`
    );
  }
  if (task.role === "reviewer") {
    return (
      header +
      `\nReview the actual diff (git diff ${project.base_branch}...HEAD) and the code itself, not just the ` +
      `plan or commit messages. Run the tests and checks named in your brief (or docs/plan/03-quality.md if it ` +
      `exists) — a review without executed checks is not a review. End your final message with a line starting ` +
      `exactly with "VERDICT: PASS" if it's genuinely ready, or "VERDICT: NEEDS_FIXES" followed by a concrete ` +
      `numbered list (file:line, the problem, the fix) if not. Never skip the VERDICT line.`
    );
  }
  if (task.role === "builder") {
    return (
      header +
      `\nImplement this directly in the worktree (branch ${project.work_branch} is already checked out). ` +
      `Commit your changes with a clear message when done. Verify your own work before reporting done — run ` +
      `the tests your brief names, and write the tests it asks for.`
    );
  }
  return header;
}

async function spawnTaskRuns(): Promise<void> {
  const claimed = await claimReadyTasks();
  for (const task of claimed) {
    try {
      if (!task.project.workspace_dir || !task.project.work_branch) {
        // Normally the API route provisions synchronously at project creation,
        // but this tick can claim the round-0 architect task inside that
        // window, so the fallback is a real path — and it must write the
        // result back, or every later tick re-provisions from scratch.
        const ws = await provisionWorkspace(task.project);
        task.project.workspace_dir = ws.workspace_dir;
        task.project.work_branch = ws.work_branch;
        await setProjectWorkspace(task.project_id, ws).catch(() => {});
      }
      const prompt = buildPrompt(task, task.project);
      const cfg = roleConfig(task.role);
      const tierCfg = task.tier ? TIER_MODELS[task.tier] : null;
      const run = await createRunForTask({
        title: `${task.project.name} · ${task.title}`,
        prompt,
        role: task.role,
        project_id: task.project_id,
        task_id: task.id,
        workspace_dir: task.project.workspace_dir,
        ...(cfg.tools ? { allowed_tools: cfg.tools } : {}),
        ...(tierCfg?.model ?? cfg.model ? { model: tierCfg?.model ?? cfg.model! } : {}),
        ...(tierCfg?.effort ?? cfg.effort ? { effort: tierCfg?.effort ?? cfg.effort! } : {}),
        // Only architect gets Konrad's vault — the other four roles don't
        // need his whole knowledge base to implement/review/research a task.
        vault_access: task.role === "architect",
      });
      await attachRun(task.id, run.id);
    } catch (e) {
      console.error(
        `[project-tick] failed to spawn run for task ${task.id} (${task.role}):`,
        e instanceof Error ? e.message : e,
      );
      await setTaskStatus(task.id, "failed").catch(() => {});
      await setProjectStatus(task.project_id, "blocked").catch(() => {});
      // A spawn failure used to be log-only. The first goal-mode run died two
      // seconds after being seeded and Konrad had no signal until he asked.
      // Every path that blocks a project now tells him.
      await queueNotification(
        `🚫 Project "${task.project.name}" blocked — could not start ${task.role} task ` +
          `"${task.title}": ${e instanceof Error ? e.message : String(e)}`,
        "project",
      ).catch(() => {});
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
    const name = (await getProject(task.project_id).catch(() => null))?.name ?? task.project_id;
    await queueNotification(
      `🚫 Project "${name}" blocked — reviewer produced no parseable VERDICT line. Check the run's last message.`,
      "project",
    ).catch(() => {});
    return;
  }

  if (task.fix_cycle >= MAX_FIX_CYCLES) {
    await setProjectStatus(task.project_id, "blocked");
    console.warn(
      `[project-tick] project ${task.project_id} blocked — ${MAX_FIX_CYCLES} fix cycles exhausted`,
    );
    const name = (await getProject(task.project_id).catch(() => null))?.name ?? task.project_id;
    await queueNotification(
      `🚫 Project "${name}" blocked — ${MAX_FIX_CYCLES} fix cycles exhausted, reviewer still finds issues.`,
      "project",
    ).catch(() => {});
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
        const name = (await getProject(task.project_id).catch(() => null))?.name ?? task.project_id;
        await queueNotification(
          `🚫 Project "${name}" blocked — ${task.role} task "${task.title}" ${task.run_status}. Check its run.`,
          "project",
        ).catch(() => {});
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

const DEFAULT_CHECKIN_HOURS = 3;

/** Periodic progress push for goal-mode projects — Konrad wakes up to a
 *  trail of "where the overnight run is" messages instead of silence.
 *  Time-gated per project via metadata.last_checkin_at; deterministic code,
 *  no LLM in the loop. */
async function goalHeartbeats(): Promise<void> {
  const goals = await listGoalProgress();
  const now = Date.now();
  for (const g of goals) {
    const meta = g.metadata as { checkin_hours?: number; last_checkin_at?: string };
    const hours = Number(meta.checkin_hours) > 0 ? Number(meta.checkin_hours) : DEFAULT_CHECKIN_HOURS;
    const last = Date.parse(meta.last_checkin_at ?? g.created_at);
    if (Number.isFinite(last) && now - last < hours * 3_600_000) continue;
    const active = g.running_titles.slice(0, 3).join("; ") || "none (between rounds)";
    await queueNotification(
      `📊 Goal "${g.name}": ${g.done}/${g.total} tasks done` +
        (g.failed ? `, ${g.failed} failed` : "") +
        `. Running: ${active}.` +
        (g.last_done_title ? ` Last finished: ${g.last_done_title}.` : ""),
      "goal",
    ).catch(() => {});
    await patchProjectMetadata(g.id, {
      last_checkin_at: new Date(now).toISOString(),
    }).catch(() => {});
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
    const finished = await closeFinishedProjects();
    for (const p of finished) {
      await queueNotification(
        `✅ Project "${p.name}" is done — every task completed and the reviewer passed it.`,
        "project",
      ).catch(() => {});
    }
    await goalHeartbeats();
  } catch (e) {
    console.error("[project-tick] tick failed:", e instanceof Error ? e.message : e);
  }
}
