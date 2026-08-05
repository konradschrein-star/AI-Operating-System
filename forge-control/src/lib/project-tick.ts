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
import { fileURLToPath } from "node:url";
import {
  promoteReadyTasks,
  claimReadyTasks,
  listSettledRunningTasks,
  createRunForTask,
  attachRun,
  setTaskStatus,
  listReviewerRound,
  createFixChain,
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
import {
  projectAcceptsWork,
  consolidateReviewerRound,
  noteGroupFailure,
  clearGroupFailures,
  FIX_TASK_TITLE,
  REREVIEW_TASK_TITLE,
  rereviewBrief,
  type ReviewerInput,
} from "./project-reconcile.ts";
import { provisionWorkspace, liveCheckoutPath } from "./workspace.ts";
import { getFleetState } from "../db/ai_os.ts";
import { sanitizeModel, sanitizeEffort } from "./cc-runner.ts";
import { queueNotification } from "../db/notifications.ts";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "/root/.claude/agents";

/** The `agents/` directory committed in THIS checkout — resolved from the
 *  module's own URL (src/lib → src → forge-control → repo root), so it points
 *  at the deployed checkout the executor is running from, never at a project
 *  worktree. Second candidate after AGENTS_DIR, see roleFilePaths(). */
export const REPO_AGENTS_DIR = fileURLToPath(new URL("../../../agents", import.meta.url));

const MAX_FIX_CYCLES = 3;
let lastPauseLogAt = 0;

/** Consecutive consolidation failures per `${project_id}:${round}`, and the
 *  count at which a stuck group is pushed to Konrad instead of spinning in the
 *  log. Process-local on purpose: it is a retry heuristic, not state the DB
 *  should own, and a restart legitimately re-starts the count. Entries are
 *  deleted on the first success, so the map holds at most one key per
 *  currently-failing round. */
const groupFailures = new Map<string, number>();
const MAX_GROUP_FAILURES = 3;

/** Model/effort per tier — only architect and builder tasks are ever
 *  assigned one (see docs/superpowers/specs/2026-07-11-manager-orchestration-
 *  model-tiering-design.md). Overrides the role file's static model:/effort:
 *  when a task carries a tier. */
/** Re-pinned 2026-08-05 (Konrad): "standard should be Opus 5; Sonnet stays
 *  for junior-engineer work like tests and boilerplate." Both fable-5 and
 *  sonnet-5 verified live via `claude --model X -p` before pinning. */
const TIER_MODELS: Record<TaskTier, { model: string; effort: string }> = {
  fast: { model: "claude-haiku-4-5-20251001", effort: "medium" },
  junior: { model: "claude-sonnet-5", effort: "high" },
  standard: { model: "claude-opus-5", effort: "high" },
  flagship: { model: "claude-fable-5", effort: "high" },
};

export interface RoleConfig {
  mission: string;
  tools: string[] | null;
  model: string | null;
  effort: string | null;
}

const roleConfigCache = new Map<TaskRole, RoleConfig>();

/** Parse an agents/<role>.md file's raw text into mission body (frontmatter
 *  stripped) and the `tools:`/`model:`/`effort:` fields from the frontmatter.
 *  Pure — no I/O, no cache — so it can be tested directly against the real
 *  agent definition files instead of a hand-copied fixture string. */
export function parseRoleFile(raw: string): RoleConfig {
  const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const frontmatter = fmMatch?.[1] ?? "";
  const mission = (fmMatch?.[2] ?? raw).trim();
  const toolsLine = /^tools:\s*(.+)$/m.exec(frontmatter)?.[1];
  const tools = toolsLine
    ? toolsLine.split(",").map((t) => t.trim()).filter(Boolean)
    : null;
  const model = sanitizeModel(/^model:\s*(.+)$/m.exec(frontmatter)?.[1]);
  const effort = sanitizeEffort(/^effort:\s*(.+)$/m.exec(frontmatter)?.[1]);
  return { mission, tools, model, effort };
}

/** Ordered candidate paths for a role's definition file.
 *
 *  1. `${AGENTS_DIR}/<role>.md` — the shared fleet directory, also read by the
 *     Task-tool subagent system. Wins when present, so a hand-installed or
 *     hot-patched definition still overrides the committed one.
 *  2. `${REPO_AGENTS_DIR}/<role>.md` — the copy committed in this repo.
 *
 *  Candidate 2 exists because AGENTS_DIR lives under /root/.claude, which the
 *  agent harness guards as a sensitive path: the engine's own agents
 *  structurally cannot install a new role file there, so before this fallback
 *  every new role needed a human `cp` (see docs/plan/evidence/p3-smoke.md —
 *  three rounds spent proving exactly that). A role file committed to
 *  `agents/` is now self-installing: it resolves on the next executor restart
 *  with no human in the loop. */
export function roleFilePaths(role: TaskRole): string[] {
  return [`${AGENTS_DIR}/${role}.md`, `${REPO_AGENTS_DIR}/${role}.md`];
}

/** First readable candidate for `role`, or null when the role has no
 *  definition anywhere. Only "not found" is swallowed — a file that exists but
 *  cannot be read (permissions, a directory in its place) is a
 *  misconfiguration that must not degrade silently into the bare fallback
 *  mission, so it throws with the offending path and errno. */
export function readRoleFile(role: TaskRole): { path: string; raw: string } | null {
  for (const path of roleFilePaths(role)) {
    try {
      return { path, raw: readFileSync(path, "utf8") };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error(
        `[project-tick] role file ${path} exists but is unreadable (${code ?? "unknown errno"})`,
        { cause: err },
      );
    }
  }
  return null;
}

/** Roles already warned about, so the bare-fallback warning is logged once per
 *  role rather than once per spawn (the fallback is deliberately not cached). */
const warnedMissingRoles = new Set<TaskRole>();

/** Read an agents/<role>.md file — the SAME file the Task-tool subagent
 *  system reads — and split it into the mission body (frontmatter stripped)
 *  and the `tools:` allowlist from the frontmatter. Single source of truth:
 *  editing agents/reviewer.md's tools line (e.g. dropping Write/Edit so it
 *  can only report findings, never silently fix them) changes both what the
 *  Task-tool subagent can do AND what a top-level project-run for that role
 *  can do. Resolved definitions are cached — restart forge-executor after
 *  editing one of these files.
 *
 *  The bare fallback is deliberately NOT cached: caching it would pin a role to
 *  a mission-less prompt for the rest of the process's life just because one
 *  task happened to run before its definition was installed, and recovering
 *  from that needs an executor restart — the exact restart this project is
 *  forbidden to perform. Re-reading two paths on a cache miss costs two failed
 *  stats per run spawn, which is nothing next to spawning a `claude` child. */
function roleConfig(role: TaskRole): RoleConfig {
  const cached = roleConfigCache.get(role);
  if (cached) return cached;
  const found = readRoleFile(role);
  if (!found) {
    if (!warnedMissingRoles.has(role)) {
      warnedMissingRoles.add(role);
      console.warn(
        `[project-tick] no agent definition for role ${role} in any of ` +
          `[${roleFilePaths(role).join(", ")}], using a bare fallback`,
      );
    }
    return {
      mission: `You are the ${role} for this coding project.`,
      tools: null,
      model: null,
      effort: null,
    };
  }
  const cfg = parseRoleFile(found.raw);
  roleConfigCache.set(role, cfg);
  return cfg;
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
  `Each task's "tier" picks its model: "fast" (Haiku) for trivial mechanical work, "junior" (Sonnet) for ` +
  `well-specified junior-engineer work — writing tests, boilerplate, repetitive edits from a clear spec — ` +
  `"standard" (Opus) for most implementation and review work, "flagship" (Fable) only when a task genuinely ` +
  `needs the strongest model. Omit tier to fall back to the role default (Opus). Flagship is the expensive ` +
  `one — reserve it for design-heavy or genuinely hard tasks.`;

const PARALLELISM_GUIDE =
  `Tasks in the SAME round run in PARALLEL inside the SAME worktree — only put tasks in one round when they ` +
  `touch disjoint files. Anything that could collide goes in consecutive rounds instead. Rounds only gate ` +
  `ordering (round N+1 starts when everything <= N is done); gaps in round numbers are fine and cost nothing.`;

/** R12 — the worktree-only rule, appended to EVERY role prompt on a
 *  repo-backed project. Bug 3 of the first night: fleet agents edited the live
 *  checkout during build phases so reviewers could curl real endpoints, which
 *  hot-applied half-finished code into the running services. The policy is
 *  generated here rather than written into agents/<role>.md because those role
 *  files are shared with the interactive Task-tool subagents, which legitimately
 *  work on live checkouts when Konrad asks. */
export function WORKTREE_POLICY(liveCheckout: string): string {
  return (
    `WORKTREE-ONLY POLICY (non-negotiable):\n` +
    `- The live checkout for this repo is ${liveCheckout}. During build phases you work ONLY in this ` +
    `worktree — the directory you are already in. ${liveCheckout} must NEVER be edited, patched, or ` +
    `"just quickly fixed" during a build phase, no matter how convenient it would be for testing.\n` +
    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
    `Restarting the executor is the deploy phase's job and it has a detached procedure for it.\n` +
    `- Verification against LIVE endpoints, live services, or the live database happens ONLY inside an ` +
    `explicitly-briefed deploy/verify task — never ad hoc from a build task. If your brief does not say ` +
    `"deploy" or "verify against live", you have no business touching ${liveCheckout}.\n` +
    `- Need to prove something works? Run it out of the worktree (tsx, unit tests, a throwaway port). ` +
    `If that is genuinely impossible, say so in your final message and let the deploy/verify task do it.`
  );
}

/** R13 — reviewer-side enforcement of the above. A policy nobody checks is a
 *  suggestion; the reviewer is the only role that reliably looks at the whole
 *  round, so it owns the cleanliness gate. */
export function REVIEWER_LIVE_CHECK(liveCheckout: string): string {
  return (
    `LIVE-CHECKOUT CLEANLINESS CHECK (mandatory, run it before you write your verdict):\n` +
    `  git -C ${liveCheckout} status --porcelain\n` +
    `ANY output at all means someone hot-applied work into the live checkout instead of keeping it in the ` +
    `worktree. That is by itself a NEEDS_FIXES finding: name the dirty files verbatim in your numbered list ` +
    `and require them to be reverted there and redone in the worktree. Empty output is the only pass. ` +
    `Paste the command's output (or its emptiness) into your review — an unexecuted check is not a check.`
  );
}

/** R14 + R17 — deploy guidance for the goal-mode architect's plan. Bug 4 of the
 *  first night: this engine deploys itself, so a naive `pm2 restart
 *  forge-executor` during deploy kills the very fleet that is deploying. */
export const DEPLOY_GUIDE =
  `DEPLOY GUIDANCE (put this verbatim into the final deploy phase's brief):\n` +
  `- EXECUTOR-LOADED CODE. If the diff touches \`src/lib/project-tick.ts\`, \`src/lib/cc-runner.ts\`, ` +
  `\`src/executor.ts\`, \`src/db/*\` or the \`agents/*.md\` role files, the executor is holding the old ` +
  `code in memory and a plain restart would kill every run in flight — including the deploy task itself.\n` +
  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
  `- Instead, after merging, run exactly:\n` +
  `    setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &\n` +
  `  launch it DETACHED and END the task — never wait for it, never poll it, never tail the log until it ` +
  `finishes. The script waits for the fleet to go idle and restarts then; your task must return immediately.\n` +
  `- \`pm2 restart forge-control\` (the API side) remains allowed and is the right way to pick up route/API ` +
  `changes, since nothing long-running lives in that process.\n` +
  `- MERGE vs PR (R17): if the project brief says to open a PR instead of merging, run ` +
  `\`scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"\` and do NOT merge to main — the PR is the ` +
  `deliverable. Otherwise merge per the brief (merge main into the work branch first if main moved, re-run ` +
  `typecheck + tests in the worktree, then merge to main; on conflicts STOP and report the files).`;

/** R16 — push-on-PASS guidance. Deliberately prompt guidance rather than engine
 *  code: the engine has no opinion about which phases are worth publishing, and
 *  a deterministic push would fire on rounds that are mid-fix-cycle. */
export const GITHUB_PUSH_GUIDE =
  `GITHUB PUSH (phase completion):\n` +
  `- When a phase's gating reviewer issues VERDICT: PASS and the repo has an origin remote, run ` +
  `\`scripts/git-sync-branch.sh <worktree-dir>\` to push the work branch so the progress is visible on ` +
  `GitHub.\n` +
  `- Plain push only. NEVER force-push, never \`--force\`, never \`--force-with-lease\` — this branch is ` +
  `shared with whatever else is watching it.\n` +
  `- If the push fails (no origin, gh not authenticated, rejected), report the failure verbatim in your ` +
  `final message and move on. A push failure NEVER changes the verdict.`;

export function buildPrompt(task: ProjectTask, project: Project): string {
  const mission = roleConfig(task.role).mission;
  // null for scratch projects: no live checkout exists, so none of the
  // live-checkout policy blocks apply (and interpolating "null" into a path
  // would be worse than saying nothing).
  const live = liveCheckoutPath(project.repo);
  // Wrap EVERY return through this rather than pasting the block into eight
  // branches — a new role branch that forgets the policy is exactly the kind
  // of omission bug 3 was.
  const withPolicy = (body: string): string =>
    live ? `${body}\n\n${WORKTREE_POLICY(live)}` : body;
  const header =
    `${mission}\n\n---\n\n` +
    `Project: ${project.name}\n` +
    `Repo: ${project.repo} — you are already inside its worktree (branch ${project.work_branch}, off ${project.base_branch}).\n` +
    `Project brief: ${project.brief}\n\n` +
    `Your task (round ${task.round}): ${task.title}\n${task.brief}\n`;

  if (task.role === "architect") {
    if (isGoalMode(project)) {
      return withPolicy(
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
        // R14/R16/R17. Gated on `live` like every other policy block: a scratch
        // project has no live checkout to deploy to and no executor to restart,
        // so this guidance would be noise at best and a wrong instruction at worst.
        (live
          ? `3) GIT/GITHUB + DEPLOY. Plan the final deploy phase around the two blocks below, and copy them ` +
            `into the briefs of the tasks they govern — the deploy task and each phase's gating reviewer:\n\n` +
            `${DEPLOY_GUIDE}\n\n` +
            `${GITHUB_PUSH_GUIDE}\n\n`
          : "") +
        `Do not write implementation code or commit anything outside docs/plan/ — that's the builders' job.`
      );
    }
    return withPolicy(
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
    return withPolicy(
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
      `Do not write implementation code yourself — plan, then fan out.` +
      // R16: the planner writes the reviewer briefs, so it needs the push rule
      // in hand to put it into them.
      (live ? `\n\n${GITHUB_PUSH_GUIDE}` : "")
    );
  }
  if (task.role === "researcher") {
    return withPolicy(
      header +
      `\nDeep research only — no implementation, no task creation. Use every research surface you have ` +
      `(web search/fetch, browser automation skills, external AI services named in your brief). Write your ` +
      `findings to docs/research/round-${task.round}-${task.id.slice(0, 8)}.md in the worktree and commit that ` +
      `one file. Findings must be concrete enough that a planner can act on them without repeating the research.`
    );
  }
  if (task.role === "scout") {
    return withPolicy(
      header +
      `\nResearch only — no implementation, no task creation. Write your findings to ` +
      `docs/research/round-${task.round}-${task.id.slice(0, 8)}.md in the worktree and commit that one file. ` +
      `Findings must be concrete enough that a planner can act on them without repeating the research.`
    );
  }
  if (task.role === "reviewer") {
    return withPolicy(
      header +
      `\nReview the actual diff (git diff ${project.base_branch}...HEAD) and the code itself, not just the ` +
      `plan or commit messages. Run the tests and checks named in your brief (or docs/plan/03-quality.md if it ` +
      `exists) — a review without executed checks is not a review. End your final message with a line starting ` +
      `exactly with "VERDICT: PASS" if it's genuinely ready, or "VERDICT: NEEDS_FIXES" followed by a concrete ` +
      `numbered list (file:line, the problem, the fix) if not. Never skip the VERDICT line.` +
      // R13 + R16: the reviewer is the round's gate, so both the cleanliness
      // check and the push-on-PASS rule land here.
      (live ? `\n\n${REVIEWER_LIVE_CHECK(live)}\n\n${GITHUB_PUSH_GUIDE}` : "")
    );
  }
  if (task.role === "builder") {
    return withPolicy(
      header +
      `\nImplement this directly in the worktree (branch ${project.work_branch} is already checked out). ` +
      `Commit your changes with a clear message when done. Verify your own work before reporting done — run ` +
      `the tests your brief names, and write the tests it asks for.`
    );
  }
  return withPolicy(header);
}

async function spawnTaskRuns(): Promise<void> {
  const claimed = await claimReadyTasks();
  for (const task of claimed) {
    try {
      // Belt to the SQL gate's braces (R10). claimReadyTasks() already joins on
      // `projects.status = 'active'` and THAT is the real gate; this catches the
      // race where the project is paused/blocked between the claim transaction
      // and this loop. The claim already flipped the task to 'running', so hand
      // it back to 'ready' rather than dropping it — the row must stay
      // re-claimable, or pausing a project would silently strand its tasks.
      // No run is spawned and the project is NOT blocked: this is not an error.
      if (!projectAcceptsWork(task.project.status)) {
        await setTaskStatus(task.id, "ready");
        console.log(
          `[project-tick] skipping ${task.role} task ${task.id} — project status ${task.project.status}`,
        );
        continue;
      }
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

/**
 * Decide ONE reviewer round of ONE project, and act on that decision.
 *
 * The unit of decision is the round, never the task: a reviewer round is only
 * ready to be judged when every one of its reviewers has landed, and it then
 * yields at most one fix chain. Deciding per task is what produced two "Fix
 * cycle 1" builders, two re-reviewers, and later two deploy builders on the
 * engine's first night (docs/plan/02-architecture.md §1.1).
 */
async function consolidateReviewerGroup(
  projectId: string,
  round: number,
): Promise<void> {
  const rows = await listReviewerRound(projectId, round);
  const inputs: ReviewerInput[] = rows.map((r) => ({
    taskId: r.id,
    title: r.title,
    fixCycle: r.fix_cycle,
    // 'completed' and nothing else.
    //  - run_status null (no run yet) or 'running' → plainly not settled.
    //  - a reviewer already marked 'done' by an EARLIER tick is still settled
    //    and stays in the group: its verdict is part of this round, and
    //    excluding it would let a late sibling re-decide the round on a
    //    partial view and fire a second chain.
    //  - 'failed'/'cancelled' → deliberately NOT settled here. The per-task
    //    path in reconcileSettledTasks() has already failed that task and
    //    blocked the project; the group must wait rather than fold a broken
    //    round into a verdict it cannot honestly compute.
    settled: r.run_status === "completed",
    lastText: r.last_text,
  }));

  const decision = consolidateReviewerRound(round, inputs, MAX_FIX_CYCLES);

  switch (decision.action) {
    case "wait": {
      // Nothing is marked done — THE invariant. The reviewers stay 'running'
      // with a settled run, so listSettledRunningTasks() re-surfaces them and
      // the group is re-evaluated on the next tick.
      const settledCount = inputs.filter((r) => r.settled).length;
      console.log(
        `[project-tick] round ${round} reviewers → wait (${settledCount}/${inputs.length} settled)`,
      );
      return;
    }

    case "pass": {
      await markGroupDone(inputs);
      console.log(
        `[project-tick] round ${round} reviewers → pass (${inputs.length} reviewer(s))`,
      );
      // Nothing is created here: closeFinishedProjects() owns completion.
      return;
    }

    case "block": {
      // ORDER IS LOAD-BEARING, same argument as the `fix` branch below: the
      // state that STOPS work is written FIRST, the bookkeeping that RELEASES
      // the round second. Marking the reviewers 'done' first opens a window in
      // which round R is fully settled and the project is still 'active' — a
      // crash there (this project's own deploy restarts the executor; the
      // stuck-run watchdog and OOM are other routes) leaves promoteReadyTasks()
      // free to promote the next phase past a review that never produced a
      // verdict, with no notification ever sent.
      //
      // Reversed, a crash is harmless: the reviewers stay 'running' with
      // settled runs, listSettledRunningTasks() has NO project-status filter
      // (db/projects.ts:501-516 — reconciliation is bookkeeping and must run
      // for paused/blocked projects too), so it re-surfaces them next tick,
      // consolidation re-decides `block` identically (the inputs did not move),
      // and meanwhile the already-blocked project promotes and claims nothing.
      //
      // The notification is sent before mark-done for the same reason: a crash
      // after mark-done would leave a blocked project nobody was told about,
      // whereas a replay at worst pushes the same message twice.
      await setProjectStatus(projectId, "blocked");
      console.warn(
        `[project-tick] round ${round} reviewers → block (${decision.reason}): ${decision.detail}`,
      );
      const name = (await getProject(projectId).catch(() => null))?.name ?? projectId;
      await queueNotification(
        `🚫 Project "${name}" blocked — round ${round} review (${decision.reason}): ` +
          `${decision.detail}. Check the run threads.`,
        "project",
      ).catch(() => {});
      await markGroupDone(inputs);
      return;
    }

    case "fix": {
      // ORDER IS LOAD-BEARING: create the chain FIRST, mark the reviewers done
      // SECOND. A crash between the two re-runs consolidation next tick — the
      // reviewers are still 'running' with settled runs, the same (round,
      // cycle) yields the same chain keys, the partial unique index absorbs the
      // duplicate insert, and mark-done proceeds. The reverse order would leave
      // a window where round R is fully 'done' with no fix round in the table,
      // and promoteReadyTasks() would promote the next phase's planner straight
      // past an unfinished fix cycle.
      const created = await createFixChain({
        project_id: projectId,
        round,
        cycle: decision.cycle,
        builderTitle: FIX_TASK_TITLE(decision.cycle),
        builderBrief: decision.mergedBrief,
        builderChainKey: decision.builderChainKey,
        reviewerTitle: REREVIEW_TASK_TITLE(decision.cycle),
        reviewerBrief: rereviewBrief(decision.mergedBrief),
        reviewerChainKey: decision.reviewerChainKey,
      });
      await markGroupDone(inputs);
      const line =
        `[project-tick] round ${round} reviewers → fix cycle ${decision.cycle} ` +
        `(builderCreated=${created.builderCreated}, reviewerCreated=${created.reviewerCreated})`;
      if (created.builderCreated && created.reviewerCreated) {
        console.log(line);
      } else {
        // Not an error: this is the replay guard doing exactly its job.
        console.log(`${line} — replay absorbed by the chain_key guard, no duplicate chain`);
      }
      return;
    }
  }
}

/** Mark every reviewer of a decided group 'done'. Idempotent by construction —
 *  re-marking an already-'done' row is a no-op UPDATE — which is what makes the
 *  crash-replay path above safe to re-run. */
async function markGroupDone(inputs: ReviewerInput[]): Promise<void> {
  for (const r of inputs) {
    await setTaskStatus(r.taskId, "done");
  }
}

async function reconcileSettledTasks(): Promise<void> {
  const settled = await listSettledRunningTasks();
  /** Reviewer rounds touched this tick, keyed `${project_id}:${round}` so a
   *  round is consolidated AT MOST ONCE per tick even when two of its reviewers
   *  settle together. Looping over tasks instead would reintroduce bug 1 in
   *  miniature: two settled siblings, two consolidations, two fix chains (the
   *  second one saved only by the chain_key guard — defense in depth is not a
   *  licence to fire twice). */
  const reviewerRounds = new Map<string, { projectId: string; round: number }>();

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
        reviewerRounds.set(`${task.project_id}:${task.round}`, {
          projectId: task.project_id,
          round: task.round,
        });
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

  for (const [key, { projectId, round }] of reviewerRounds) {
    // Per-group isolation: one unreadable round must not abort the reconcile
    // pass for every other project's rounds. But isolation without escalation
    // is a silent stall — a permanently failing group (e.g. `column
    // "chain_key" does not exist` if forge-control is restarted on this branch
    // before migration 0035 lands) would retry every 10s forever while the
    // project sits frozen and nobody is told. So: count consecutive failures
    // and surface the group once it is clearly stuck.
    try {
      await consolidateReviewerGroup(projectId, round);
      clearGroupFailures(groupFailures, key);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const { count, notify } = noteGroupFailure(groupFailures, key, MAX_GROUP_FAILURES);
      console.error(
        `[project-tick] failed to consolidate reviewer round ${round} of project ${projectId} ` +
          `(consecutive failure ${count}):`,
        message,
      );
      if (notify) {
        const name = (await getProject(projectId).catch(() => null))?.name ?? projectId;
        await queueNotification(
          `🚫 Project "${name}" — reviewer round ${round} has failed to consolidate ` +
            `${count} times in a row and is frozen: ${message}`,
          "project",
        ).catch(() => {});
      }
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
