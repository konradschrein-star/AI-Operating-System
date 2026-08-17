/**
 * Git worktree provisioning for coding projects. Each project gets its own
 * worktree + branch off one of the two known repos (Konrad's call: fixed
 * set of two, not arbitrary clone-any-repo) so parallel projects never
 * collide on files.
 *
 * WORKSTREAMS (engine-task-graph phase 4, R32–R35). Tasks within one project
 * used to share one worktree unconditionally — an intentional v1 simplification
 * that avoided branch-merge logic. That is now scoped to a WORKSTREAM: tasks of
 * the same workstream share a directory and are serialised by the contention
 * belt, while different workstreams get isolated sibling directories that may
 * write the same file concurrently and merge back through an explicit,
 * reviewed integration task (R38 — there is no auto-merge path in this module
 * or anywhere else in the tree).
 *
 * `provisionWorkstream(project, 'main')` is a PASSTHROUGH to
 * `provisionWorkspace(project)` — same directory, same branch, byte for byte.
 * That is the compatibility property the deploy rests on: no live project
 * changes its branch or its directory when this lands.
 */

import { existsSync, readdirSync } from "node:fs";
import { run } from "./exec.ts";
import { validateWorkstream } from "./task-graph.ts";
import type { ProjectRepo } from "../db/projects.ts";

const REPO_PATHS: Record<Exclude<ProjectRepo, "scratch">, string> = {
  "ai-os": process.env.AI_OS_REPO_DIR ?? "/opt/forge-ai-os",
  "content-forge": process.env.CONTENT_FORGE_REPO_DIR ?? "/opt/content-forge",
};

const WORKTREE_ROOT =
  process.env.PROJECT_WORKTREE_ROOT ?? "/opt/ai-os/workspace/projects";

/** The LIVE checkout a repo-backed project's worktree branches off — the
 *  directory that is actually deployed and running. `null` for 'scratch',
 *  which has no live counterpart (the scratch repo IS the product).
 *
 *  Exists so the mapping lives in exactly one place: lib/project-tick.ts
 *  interpolates it into the worktree-only policy blocks it appends to every
 *  role prompt (R12/R13), and a second copy there would be free to drift from
 *  the one provisionWorkspace() actually branches from. */
export function liveCheckoutPath(repo: ProjectRepo): string | null {
  return repo === "scratch" ? null : REPO_PATHS[repo];
}

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

/* ── Workstreams (R32–R35, R39) ─────────────────────────────────────────── */

/** The workstream every project has and every legacy row carries. It is not a
 *  workstream in the isolation sense: it names the project's ORIGINAL worktree
 *  and ORIGINAL branch, both unchanged by this phase. */
export const WORKSTREAM_MAIN = "main";

/** The separator between a project id and a workstream in a directory name.
 *  DOUBLE hyphen, because a uuid contains single hyphens and the boundary has
 *  to be unambiguous both to `ls` and to the prefix match in
 *  `listProjectWorktrees()` below. */
const WORKSTREAM_DIR_SEP = "--";

/**
 * R39's cap, read at CALL TIME from the ONE place it is defined —
 * `PROJECT_MAX_WORKSTREAMS` in routes/projects.ts, where phase 3 put it because
 * that is where R39's user-facing `400` is enforced. Re-reading
 * `process.env.PROJECT_MAX_WORKSTREAMS` here would give the two refusals two
 * sources of truth and let them disagree about the limit, which R39's amendment
 * (01-requirements.md §D) forbids in as many words.
 *
 * WHY A DYNAMIC `import()` AND NOT A STATIC ONE — THE IMPORT DIRECTION, and
 * NOT a pool count. `lib/` must not statically depend on `routes/`: a static
 * import would make the leaf module of the workspace layer depend on the HTTP
 * layer, and that inversion is the whole reason this is dynamic.
 *
 * THE POOL-COUNT ARGUMENT THIS COMMENT USED TO MAKE IS RETRACTED, and the
 * retraction is restated here rather than only in the doc, because a claim
 * corrected in one place and left standing in another reads as authoritative
 * and is wrong (02-architecture.md §4.3, round 222; round 224's gating review
 * found this file still carrying the retracted version). The old text said a
 * static import "would put THREE pg Pools into `pnpm test`". Measured with a
 * counting `pg.Pool` subclass, twice — 2026-08-17 for §4.3 and again at
 * `HEAD=b201f22` for round 224's review — importing `lib/project-tick.ts`
 * ALONE constructs **5** pools, and `lib/project-tick.test.ts` value-imports
 * that module for `buildPrompt`, so `pnpm test` constructs those 5 today,
 * before any of this. Importing `routes/projects.ts` on top adds **0**: its
 * pools are the same already-loaded db modules. NF3 was never at risk from
 * either import, because a `pg.Pool` constructs lazily and connects only on
 * the first query — the rule is that tests never TOUCH a database, and none
 * does. So the dynamic import buys nothing measurable in pool count; it buys
 * the import direction above, which is a real and sufficient reason on its own.
 *
 * A dynamic import keeps the STATIC graph a leaf — workspace.ts still imports
 * only node:fs, ./exec.ts and ./task-graph.ts, all pure — while the value
 * still has exactly one definition. The module is loaded once and cached, so
 * the cost is paid on the first non-`main` provisioning and never again.
 *
 * THE CLEAN END STATE is for the constant to live in lib/task-graph.ts, the
 * leaf both layers already import statically (it already owns the other
 * workstream-shaped rule, `validateWorkstream()`/R28). Phase 4C REVIEWED that
 * move in round 222 and ruled the constant STAYS here for now
 * (02-architecture.md §4.3): the move writes `lib/task-graph.ts`, which
 * 04-phases.md §10 assigns to phases 1–3, and taking it would be a silent
 * write outside a declared set in the project whose entire deliverable is
 * computing contention from DECLARED write-sets. The phase that owns
 * task-graph.ts should take the constant and delete `maxWorkstreams()`'s
 * dynamic import in one commit.
 */
async function maxWorkstreams(): Promise<number> {
  const routes = await import("../routes/projects.ts");
  return routes.PROJECT_MAX_WORKSTREAMS;
}

/** The git directory `git worktree add` must be run from, the project's own
 *  branch inside it, and the project's `main` worktree directory.
 *
 *  'scratch' is not a worktree of a monorepo — the scratch repo IS the
 *  project's product and lives at the main worktree path itself, with `main`
 *  as its branch (see `provisionWorkspace`). Its workstreams are still ordinary
 *  worktrees, just of that repo, so the only thing that varies is this triple. */
function projectRefs(project: { id: string; repo: ProjectRepo }): {
  repoPath: string;
  projectBranch: string;
  mainDir: string;
} {
  const mainDir = `${WORKTREE_ROOT}/${project.id}`;
  if (project.repo === "scratch") {
    return { repoPath: mainDir, projectBranch: "main", mainDir };
  }
  const repoPath = REPO_PATHS[project.repo];
  if (!repoPath) throw new Error(`unknown project repo: ${project.repo}`);
  return {
    repoPath,
    projectBranch: `project/${project.id.split("-")[0]}`,
    mainDir,
  };
}

/** The directory for a workstream. `main` keeps the project's existing path
 *  UNCHANGED; every other workstream is a SIBLING of it, never a child (R34).
 *  A nested worktree is reported as untracked content by the parent's
 *  `git status --porcelain`, and that output is the literal input to
 *  REVIEWER_LIVE_CHECK in lib/project-tick.ts and to the deploy task's
 *  pre-merge check. A cleanliness gate that cries wolf trains reviewers to
 *  ignore it. */
function workstreamDir(mainDir: string, workstream: string): string {
  return workstream === WORKSTREAM_MAIN
    ? mainDir
    : `${mainDir}${WORKSTREAM_DIR_SEP}${workstream}`;
}

/** The branch for a workstream. `main` keeps the project's existing branch
 *  UNCHANGED; every other workstream gets `project/<id8>-<ws>` (R33).
 *
 *  A HYPHEN AND NOT A SLASH, and this is not a style preference: git refuses
 *  `refs/heads/project/<id8>/<ws>` while `refs/heads/project/<id8>` exists,
 *  because refs are files in a directory tree and the two paths are a file and
 *  a directory at the same name ("fatal: cannot lock ref"). Reproduced on this
 *  host on 2026-08-17; the transcript is in evidence/phase4-workstreams.md §1
 *  and check-workstream-e2e.sh asserts it on every run so the constraint cannot
 *  quietly stop being true. */
function workstreamBranch(projectBranch: string, workstream: string): string {
  return workstream === WORKSTREAM_MAIN
    ? projectBranch
    : `${projectBranch}-${workstream}`;
}

/** Every registered worktree of this project, with the workstream each one
 *  belongs to. Used both to count distinct workstreams for R39 and to tear all
 *  of them down for R35.
 *
 *  THE PREFIX HAZARD: `<root>/<id>` is a prefix of `<root>/<id>--ui`, so a bare
 *  `startsWith(mainDir)` would classify the `ui` worktree as `main` and R35
 *  would remove the wrong directory. Match `=== mainDir` or
 *  `startsWith(mainDir + '--')` and nothing else. (Two project ids cannot
 *  collide the same way — they are uuids — but the id/workstream boundary
 *  genuinely can.) */
async function listProjectWorktrees(
  repoPath: string,
  mainDir: string,
): Promise<{ dir: string; workstream: string }[]> {
  await run(`git -C "${repoPath}" worktree prune`, 30_000).catch(() => {});
  const list = await run(`git -C "${repoPath}" worktree list --porcelain`, 10_000);
  if (!list.ok) return [];
  const found: { dir: string; workstream: string }[] = [];
  for (const line of list.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length);
    if (dir === mainDir) {
      found.push({ dir, workstream: WORKSTREAM_MAIN });
    } else if (dir.startsWith(mainDir + WORKSTREAM_DIR_SEP)) {
      found.push({
        dir,
        workstream: dir.slice(mainDir.length + WORKSTREAM_DIR_SEP.length),
      });
    }
  }
  return found;
}

/**
 * The worktree for one workstream of one project (R32). Idempotent, and
 * race-safe by the SAME construction as `provisionWorkspace` — read that
 * function's comment block for the two-process race it documents, observed live
 * on 2026-08-05. The three moves that make losing the race harmless are
 * reproduced here: existing worktree wins, existing branch is adopted rather
 * than `-b`-ed, and a failed `worktree add` prunes and re-checks before
 * throwing.
 */
export async function provisionWorkstream(
  project: { id: string; repo: ProjectRepo; base_branch: string },
  workstream: string,
): Promise<WorkspaceInfo> {
  if (!UUID_RE.test(project.id)) {
    throw new Error(`refusing to provision workstream for non-uuid id: ${project.id}`);
  }

  // NOT COSMETIC. `run()` in lib/exec.ts executes a SHELL STRING, so this name
  // is interpolated straight into `git worktree add`. A name containing `;`, a
  // backtick or `$(` is command injection with the executor's privileges, not a
  // naming nit. R28's validator is the single definition of a legal name — it
  // is character-for-character the CHECK constraint the migration enforces —
  // and it is deliberately called rather than re-spelled here.
  validateWorkstream(workstream);

  // `main` is the project's existing worktree, unchanged in directory and in
  // branch. Delegating rather than reimplementing is what makes that true by
  // construction instead of by two code paths agreeing today and drifting
  // tomorrow. No cap check and no node_modules work: `main` is not a new
  // workstream and its worktree is provisioned exactly as it was before phase 4.
  if (workstream === WORKSTREAM_MAIN) return provisionWorkspace(project);

  const { repoPath, projectBranch, mainDir } = projectRefs(project);
  const workspaceDir = workstreamDir(mainDir, workstream);
  const workBranch = workstreamBranch(projectBranch, workstream);

  const already = await lookupWorktree(repoPath, workspaceDir);
  if (already) {
    // Self-healing, and NOT a bare early return: a worktree can exist while its
    // node_modules do not (the install below threw last time, or a previous
    // round predates this code). `ensureNodeModules` is a few statSync calls
    // when there is nothing to do, so paying it on the idempotent path costs
    // nothing and closes the half-provisioned state.
    await ensureNodeModules(workspaceDir, project.repo);
    return { workspace_dir: workspaceDir, work_branch: already };
  }

  // R39, the provisioning half. The API refuses at task creation
  // (routes/projects.ts) and its count is a TOCTOU snapshot — two concurrent
  // POSTs proposing two different new workstreams can both pass it.
  //
  // THIS REFUSAL HAS THE SAME TOCTOU, AND THAT IS ACCEPTED — ruled by phase 4's
  // red team in round 224, which R39 explicitly left to it. The count below is
  // read from `git worktree list` and the `worktree add` happens after, with no
  // lock, so two PROCESSES provisioning two different new workstreams can both
  // pass: measured on this host at HEAD=b201f22, cap 4, three streams present,
  // both calls returned 0 and the project ended with 5 distinct workstreams.
  // This check therefore defends against SERIAL excess — a fourth, fifth, sixth
  // spawn arriving one after another — and NOT against concurrent provisioning.
  // The earlier wording here claimed the latter ("the checkout that would
  // consume it cannot be created without passing here"); that was measured
  // false and is retracted.
  //
  // WHY ACCEPTED RATHER THAN MADE TRANSACTIONAL. (a) The race is unreachable in
  // the deployed topology: `provisionWorkstream` has exactly two call sites,
  // both inside `spawnTaskRuns()`'s sequential `for … await` loop in a single
  // executor process, so reaching it needs two executors overlapping across a
  // deploy. (b) The measured slip is CLEAN — both streams got a consistent
  // branch+worktree pair, no orphan branch, no orphan directory, nothing
  // half-provisioned, and `removeWorkspace()` enumerates from the registry so
  // teardown still reaches every one of them. (c) The priced cost is one extra
  // full checkout of disk, never a corrupt workspace or a wrong answer. A
  // transactional count would need a lock over a git repository, which is a
  // real mechanism bought against a disk-space nuisance.
  //
  // What the check DOES guarantee unconditionally: it runs before any git
  // write, so a refusal writes nothing at all (e2e §12.6).
  const existing = await listProjectWorktrees(repoPath, mainDir);
  const distinct = new Set(existing.map((w) => w.workstream));
  const limit = await maxWorkstreams();
  if (!distinct.has(workstream) && distinct.size >= limit) {
    throw new Error(
      `refusing to provision workstream "${workstream}" for project ${project.id}: ` +
        `${distinct.size} workstream worktree(s) already exist (limit ` +
        `PROJECT_MAX_WORKSTREAMS=${limit}): ${[...distinct].sort().join(", ")}. ` +
        "A full checkout is not free; raise PROJECT_MAX_WORKSTREAMS or integrate " +
        "and retire a workstream first (R39).",
    );
  }

  // START POINT: the project branch's CURRENT TIP, and deliberately NOT
  // `resolveStartPoint()`. That function chooses between a live checkout and a
  // possibly-stale origin, a question that arises only for the project branch
  // itself; calling it here would fetch origin and could branch a workstream
  // off a commit the project branch has never seen (02-architecture.md §4.3).
  const tip = await run(
    `git -C "${repoPath}" rev-parse --verify --quiet ${projectBranch}^{commit}`,
    10_000,
  );
  if (!tip.ok) {
    throw new Error(
      `cannot provision workstream "${workstream}" for project ${project.id}: ` +
        `its project branch ${projectBranch} does not exist in ${repoPath}. ` +
        "A workstream cannot precede its project's own branch — call " +
        "provisionWorkspace(project) first.",
    );
  }
  const startPoint = tip.stdout.trim();

  await run(`mkdir -p "${WORKTREE_ROOT}"`, 5_000);

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
    await run(`git -C "${repoPath}" worktree prune`, 30_000).catch(() => {});
    const recheck = await lookupWorktree(repoPath, workspaceDir);
    if (recheck) {
      await ensureNodeModules(workspaceDir, project.repo);
      return { workspace_dir: workspaceDir, work_branch: recheck };
    }
    throw new Error(
      `git worktree add failed (repo=${project.repo}, workstream=${workstream}, ` +
        `branch=${workBranch}): ${add.stderr || add.stdout}`,
    );
  }

  // NF1, THE ASYMMETRY ROUND 224'S RED TEAM MEASURED. Reaching here with
  // `branchExists.ok` means the branch already had a checkout that this call
  // did not find — deleted from disk, or a crash part-way through a previous
  // provisioning. Committed work is safe (the branch tip is untouched and is
  // what we just checked out); anything UNCOMMITTED in the old directory is
  // gone, and before this line it went with zero output. The equivalent `main`
  // recovery has always warned — `wsMissing` in `resolveTaskWorkspace()`,
  // lib/project-tick.ts — and a workstream losing work more quietly than
  // `main` does is the silent half of a pair whose other half is loud.
  //
  // NOT reached by the race-loser, and that is by construction rather than by
  // hope: git refuses `worktree add` for a branch already checked out
  // elsewhere, so a racer whose rival won lands in the `!add.ok` branch above
  // and returns from the re-check. Only a checkout that is genuinely no longer
  // registered gets past `add.ok`.
  if (branchExists.ok) {
    console.warn(
      `[workspace] project ${project.id} workstream "${workstream}": a previous ` +
        `checkout of branch ${workBranch} existed and is no longer registered — ` +
        `re-created at ${workspaceDir}. Commits on ${workBranch} are intact; any ` +
        `UNCOMMITTED state in the old checkout is unrecoverable.`,
    );
  }

  await ensureNodeModules(workspaceDir, project.repo);
  return { workspace_dir: workspaceDir, work_branch: workBranch };
}

/**
 * Give the workstream its OWN `node_modules`, so it gets its own build output.
 *
 * WHY THIS EXISTS AT ALL — the failure it prevents is not hypothetical. On
 * 2026-08-17 two runs of project operator-visibility died on what looked like a
 * corrupt bundle: r1353 saw `next build` print "Compiled successfully" and then
 * throw `SyntaxError: Unexpected end of JSON input`; r1357 saw two builds die on
 * ENOENT for `pages-manifest.json` and `_not-found/page.js.nft.json` with `ps`
 * showing a sibling task building against the same `.next`. Both pairs of tasks
 * had entirely DISJOINT source write-sets. They collided on shared build output.
 *
 * That is the bound on write-set declaration, and it is worth stating where
 * someone will read it: DECLARED WRITE-SETS PREVENT SOURCE CONFLICTS ONLY.
 * Nobody declares their compiler's scratch space. Only real directory isolation
 * prevents artifact conflicts, and a reader who believes write-sets are
 * sufficient will eventually reintroduce a shared build directory for speed.
 *
 * WHY A REAL INSTALL AND NOT A SYMLINKED SHARED `node_modules` (the r1357
 * mitigation, and the option the phase planner leaned toward). Priced on this
 * box, 2026-08-17, warm pnpm store — full numbers and method in
 * evidence/phase4-workstreams.md §2:
 *
 *   real install, `--prod=false`, scripts on:  forge-control 0.98 s / 34 MB,
 *     forge-control-web 1.35 s / 23 MB actual disk (919 MB apparent — pnpm
 *     hardlinks from the store, so `du` counts blocks the store already owns)
 *   symlink:                                    0.001 s / 0 bytes
 *
 * The symlink is cheaper, but ~2.5 s and ~60 MB per workstream — ~15 s and
 * ~360 MB at R39's cap of six, against 277 GB free — is not a cost worth
 * buying anything with. And what the symlink buys is a SHARED MUTABLE
 * DIRECTORY, which is the disease this function exists to cure. Node resolves
 * through a symlinked `node_modules` to the real path (measured: a package
 * loaded from a symlinked tree reports the SHARED directory as its `__dirname`),
 * so a tool that locates its project root from a module's location writes back
 * into the shared checkout; and a `pnpm install` run inside one workstream
 * writes THROUGH the symlink into the directory every other workstream is
 * building against. Its named failure mode — one workstream edits package.json
 * and the shared store is now wrong for all of them — is not a corner case
 * either: adding a dependency is ordinary work.
 *
 * NODE_ENV=production IS WHY `--prod=false` IS NOT OPTIONAL (round 101). The
 * executor runs production, `run()` inherits its environment, and pnpm then
 * prints "devDependencies: skipped because NODE_ENV is set to production",
 * omits `tsx` and `typescript`, AND EXITS 0. Every agent in that worktree would
 * then fail to run a single test for a reason that looks nothing like the cause.
 *
 * A failed install THROWS with the directory and stderr rather than leaving a
 * worktree that looks provisioned and cannot build (NF1). The caller above
 * re-runs this on the idempotent path, so a throw here is retried rather than
 * cemented.
 */
async function ensureNodeModules(
  workspaceDir: string,
  repo: ProjectRepo,
): Promise<void> {
  for (const dir of packageDirsMissingModules(workspaceDir)) {
    const install = await run(
      `cd "${dir}" && pnpm install --frozen-lockfile --prod=false`,
      600_000,
    );
    if (!install.ok) {
      throw new Error(
        `pnpm install failed while provisioning workstream worktree ` +
          `(repo=${repo}, dir=${dir}): ${install.stderr || install.stdout}`,
      );
    }
  }
}

/** The package directories inside a fresh worktree that own a lockfile and have
 *  no `node_modules` yet.
 *
 *  A pnpm WORKSPACE root governs its members from one lockfile, so when
 *  `pnpm-workspace.yaml` is present the root is the only install — installing
 *  per-member under a workspace root is what pnpm refuses. That is
 *  content-forge (root `pnpm-lock.yaml` + `pnpm-workspace.yaml`). ai-os has no
 *  root lockfile and three independent packages one level down
 *  (forge-control, forge-control-web, forge-control-mcp), so it is the
 *  depth-1 case. Both layouts verified on disk 2026-08-17. */
function packageDirsMissingModules(root: string): string[] {
  const needsInstall = (dir: string): boolean =>
    existsSync(`${dir}/pnpm-lock.yaml`) && !existsSync(`${dir}/node_modules`);

  if (existsSync(`${root}/pnpm-workspace.yaml`)) {
    return needsInstall(root) ? [root] : [];
  }

  const dirs = needsInstall(root) ? [root] : [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const child = `${root}/${entry.name}`;
    if (needsInstall(child)) dirs.push(child);
  }
  return dirs;
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
 *  leftover worktree is a disk-space nuisance, not a correctness issue.
 *
 *  R35: removes EVERY workstream worktree of the project, not just `main`.
 *  Before phase 4 this removed one hard-coded directory, which after phase 4
 *  would leave `<id>--ui`, `<id>--api` and the rest on disk forever — six full
 *  checkouts per cancelled project at R39's cap, which is exactly the disk
 *  R39 exists to defend.
 *
 *  Both existing properties are kept deliberately:
 *   - BEST-EFFORT, NEVER THROWS. The `.catch(() => {})` on each removal is not
 *     a swallowed error in NF1's sense: this function's contract is that
 *     cancelling a project must not fail because a directory is busy, and every
 *     failure is announced on the line below rather than hidden.
 *   - A 'scratch' REPO IS NEVER AUTO-DELETED, because a scratch repo IS the
 *     project's data. Its workstream worktrees are checkouts of that repo
 *     rather than the data itself, but they live INSIDE it (its own
 *     `.git/worktrees`), and removing them here would be a new behaviour on the
 *     one path this comment says to leave alone. They stay too, and
 *     `git worktree list` inside the scratch repo shows them to whoever removes
 *     it by hand. */
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
  const mainDir = `${WORKTREE_ROOT}/${project.id}`;

  // Enumerated rather than guessed: a workstream name is not derivable from the
  // project id, and the worktree registry is the only place that knows which
  // ones were ever created. `main` last, so a failure part-way through leaves
  // the directory the rest of the engine still recognises.
  const worktrees = await listProjectWorktrees(repoPath, mainDir).catch(() => []);
  const ordered = [
    ...worktrees.filter((w) => w.workstream !== WORKSTREAM_MAIN),
    ...worktrees.filter((w) => w.workstream === WORKSTREAM_MAIN),
  ];

  // If the registry could not be read at all, fall back to the one directory
  // this function has always removed. Silently doing nothing would be a
  // regression dressed as caution.
  const targets = ordered.length > 0 ? ordered : [{ dir: mainDir, workstream: WORKSTREAM_MAIN }];

  for (const { dir, workstream } of targets) {
    const removed = await run(
      `git -C "${repoPath}" worktree remove --force "${dir}"`,
      30_000,
    ).catch(() => ({ ok: false, stdout: "", stderr: "worktree remove threw" }));
    if (!removed.ok) {
      console.log(
        `[workspace] could not remove worktree ${dir} (project ${project.id}, ` +
          `workstream ${workstream}): ${removed.stderr || removed.stdout}`,
      );
    }
  }
}
