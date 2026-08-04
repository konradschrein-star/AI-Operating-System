/**
 * Git worktree provisioning for coding projects. Each project gets its own
 * worktree + branch off one of the two known repos (Konrad's call: fixed
 * set of two, not arbitrary clone-any-repo) so parallel projects never
 * collide on files. Tasks within one project still share that project's
 * worktree — see lib/project-tick.ts for why that's an intentional v1
 * simplification (avoids needing real branch-merge logic).
 */

import { run } from "./exec.ts";
import type { ProjectRepo } from "../db/projects.ts";

const REPO_PATHS: Record<Exclude<ProjectRepo, "scratch">, string> = {
  "ai-os": process.env.AI_OS_REPO_DIR ?? "/opt/forge-ai-os",
  "content-forge": process.env.CONTENT_FORGE_REPO_DIR ?? "/opt/content-forge",
};

const WORKTREE_ROOT =
  process.env.PROJECT_WORKTREE_ROOT ?? "/opt/ai-os/workspace/projects";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceInfo {
  workspace_dir: string;
  work_branch: string;
}

/** Idempotent: safe to call again for a project that already has a
 *  worktree (e.g. after an executor restart) — returns the existing one. */
export async function provisionWorkspace(project: {
  id: string;
  repo: ProjectRepo;
  base_branch: string;
}): Promise<WorkspaceInfo> {
  if (!UUID_RE.test(project.id)) {
    throw new Error(`refusing to provision workspace for non-uuid id: ${project.id}`);
  }

  // 'scratch' = a fresh standalone git repo, not a worktree of a known
  // monorepo. For goals that are their own product (new tools, business
  // systems). The project id keeps the path collision-free.
  if (project.repo === "scratch") {
    const dir = `${WORKTREE_ROOT}/${project.id}`;
    const probe = await run(`git -C "${dir}" rev-parse --is-inside-work-tree`, 10_000);
    if (probe.ok) return { workspace_dir: dir, work_branch: "main" };
    await run(`mkdir -p "${dir}"`, 5_000);
    const init = await run(
      `git -C "${dir}" init -b main && git -C "${dir}" commit --allow-empty -m "project scaffold"`,
      30_000,
    );
    if (!init.ok) {
      throw new Error(`scratch repo init failed: ${init.stderr || init.stdout}`);
    }
    return { workspace_dir: dir, work_branch: "main" };
  }

  const repoPath = REPO_PATHS[project.repo];
  if (!repoPath) throw new Error(`unknown project repo: ${project.repo}`);

  const workBranch = `project/${project.id.split("-")[0]}`;
  const workspaceDir = `${WORKTREE_ROOT}/${project.id}`;

  // Two processes can ask for the same workspace at the same moment: the API
  // route provisions right after POST /api/projects, while the executor's
  // project tick may already have claimed the round-0 architect task and hit
  // the "no workspace_dir yet" fallback. On 2026-08-05 that race blocked the
  // first goal-mode run within two seconds of creating it ("fatal: a branch
  // named 'project/7d8d5a55' already exists"). An in-process mutex can't help
  // — these are different processes — so every step below is written to be
  // safe to lose: existing worktree wins, existing branch is adopted, and a
  // failed `worktree add` re-checks before it throws.
  const already = await lookupWorktree(repoPath, workspaceDir);
  if (already) return { workspace_dir: workspaceDir, work_branch: already };

  await run(`mkdir -p "${WORKTREE_ROOT}"`, 5_000);

  const startPoint = await resolveStartPoint(repoPath, project.base_branch);

  // Adopt the branch if it already exists (a previous half-finished attempt,
  // or the other process getting there first). `worktree add -b` on an
  // existing branch is a hard error; `worktree add <dir> <branch>` checks it
  // out, which is exactly what we want.
  const branchExists = await run(
    `git -C "${repoPath}" show-ref --verify --quiet refs/heads/${workBranch}`,
    10_000,
  );
  const add = branchExists.ok
    ? await run(
        `git -C "${repoPath}" worktree add "${workspaceDir}" ${workBranch}`,
        60_000,
      )
    : await run(
        `git -C "${repoPath}" worktree add -b ${workBranch} "${workspaceDir}" ${startPoint}`,
        60_000,
      );

  if (!add.ok) {
    // Lost the race, or a stale registration was in the way. Prune and look
    // again before treating this as fatal.
    await run(`git -C "${repoPath}" worktree prune`, 30_000).catch(() => {});
    const recheck = await lookupWorktree(repoPath, workspaceDir);
    if (recheck) return { workspace_dir: workspaceDir, work_branch: recheck };
    throw new Error(
      `git worktree add failed (repo=${project.repo}, branch=${workBranch}): ${add.stderr || add.stdout}`,
    );
  }
  return { workspace_dir: workspaceDir, work_branch: workBranch };
}

/** The branch checked out at `dir`, or null if `dir` isn't a live worktree of
 *  `repoPath`. Prunes stale registrations first so a directory someone deleted
 *  by hand doesn't masquerade as provisioned. */
async function lookupWorktree(
  repoPath: string,
  dir: string,
): Promise<string | null> {
  await run(`git -C "${repoPath}" worktree prune`, 30_000).catch(() => {});
  const list = await run(`git -C "${repoPath}" worktree list --porcelain`, 10_000);
  if (!list.ok) return null;
  for (const block of list.stdout.split("\n\n")) {
    if (!block.split("\n").some((l) => l === `worktree ${dir}`)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    return branch ?? "HEAD";
  }
  return null;
}

/** Where a new work branch should start.
 *
 *  It used to be `origin/<base>` whenever the fetch succeeded. That is wrong
 *  here: /opt/forge-ai-os is the live checkout and commits land in it directly,
 *  so origin trails local main by days. A goal seeded on 2026-08-05 branched
 *  from a 2026-08-02 commit and would have merged back with three days of
 *  phantom conflicts. Pick whichever side is actually ahead; on divergence
 *  trust local, because local is what gets deployed. */
async function resolveStartPoint(
  repoPath: string,
  baseBranch: string,
): Promise<string> {
  await run(`git -C "${repoPath}" fetch origin ${baseBranch}`, 60_000);

  const local = baseBranch;
  const remote = `origin/${baseBranch}`;
  const hasLocal = (await run(`git -C "${repoPath}" rev-parse --verify --quiet ${local}^{commit}`, 10_000)).ok;
  const hasRemote = (await run(`git -C "${repoPath}" rev-parse --verify --quiet ${remote}^{commit}`, 10_000)).ok;

  if (!hasRemote) return local;
  if (!hasLocal) return remote;

  // local strictly ahead (remote is an ancestor of local) -> local
  const remoteIsAncestor = await run(
    `git -C "${repoPath}" merge-base --is-ancestor ${remote} ${local}`,
    10_000,
  );
  if (remoteIsAncestor.ok) return local;

  const localIsAncestor = await run(
    `git -C "${repoPath}" merge-base --is-ancestor ${local} ${remote}`,
    10_000,
  );
  if (localIsAncestor.ok) return remote;

  return local; // diverged — the deployed checkout wins
}

/** Best-effort cleanup when a project is cancelled. Never throws — a
 *  leftover worktree is a disk-space nuisance, not a correctness issue. */
export async function removeWorkspace(project: {
  id: string;
  repo: ProjectRepo;
}): Promise<void> {
  if (project.repo === "scratch") {
    // A scratch repo IS the project's data — never auto-delete it. Konrad
    // can remove the directory by hand if he truly wants it gone.
    console.log(`[workspace] scratch repo for ${project.id} left in place (never auto-deleted)`);
    return;
  }
  const repoPath = REPO_PATHS[project.repo];
  if (!repoPath || !UUID_RE.test(project.id)) return;
  const workspaceDir = `${WORKTREE_ROOT}/${project.id}`;
  await run(
    `git -C "${repoPath}" worktree remove --force "${workspaceDir}"`,
    30_000,
  ).catch(() => {});
}
