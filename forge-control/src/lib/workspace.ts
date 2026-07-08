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

const REPO_PATHS: Record<ProjectRepo, string> = {
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
  const repoPath = REPO_PATHS[project.repo];
  if (!repoPath) throw new Error(`unknown project repo: ${project.repo}`);

  const workBranch = `project/${project.id.split("-")[0]}`;
  const workspaceDir = `${WORKTREE_ROOT}/${project.id}`;

  const existing = await run(
    `git -C "${repoPath}" worktree list --porcelain`,
    10_000,
  );
  if (existing.ok && existing.stdout.includes(`worktree ${workspaceDir}`)) {
    return { workspace_dir: workspaceDir, work_branch: workBranch };
  }

  await run(`mkdir -p "${WORKTREE_ROOT}"`, 5_000);

  // Fetch the base branch so the worktree starts from a current commit.
  // Non-fatal if it fails (e.g. detached/offline repo) — fall back to
  // whatever the local base_branch ref already points at.
  const fetch = await run(
    `git -C "${repoPath}" fetch origin ${project.base_branch}`,
    60_000,
  );
  const startPoint = fetch.ok
    ? `origin/${project.base_branch}`
    : project.base_branch;

  const add = await run(
    `git -C "${repoPath}" worktree add -b ${workBranch} "${workspaceDir}" ${startPoint}`,
    60_000,
  );
  if (!add.ok) {
    throw new Error(
      `git worktree add failed (repo=${project.repo}, branch=${workBranch}): ${add.stderr || add.stdout}`,
    );
  }
  return { workspace_dir: workspaceDir, work_branch: workBranch };
}

/** Best-effort cleanup when a project is cancelled. Never throws — a
 *  leftover worktree is a disk-space nuisance, not a correctness issue. */
export async function removeWorkspace(project: {
  id: string;
  repo: ProjectRepo;
}): Promise<void> {
  const repoPath = REPO_PATHS[project.repo];
  if (!repoPath || !UUID_RE.test(project.id)) return;
  const workspaceDir = `${WORKTREE_ROOT}/${project.id}`;
  await run(
    `git -C "${repoPath}" worktree remove --force "${workspaceDir}"`,
    30_000,
  ).catch(() => {});
}
