/**
 * Where a project's planning corpus lives, and which files may be served out
 * of it.
 *
 * Round 901 relocated this project's corpus from the flat `docs/plan/` into
 * `docs/plan/<slug>/`, matching what the engine already does for every new
 * project (`project-tick.ts`: `docs/plan/${projectSlug(name, id)}`). Nothing
 * told the READER. The result was not a 404 but something worse: an
 * operator-visibility chat asking for `00-vision.md` got the flat file — which
 * by then was engine-v2-research-lane's document — served confidently under
 * this project's plan panel. Round 906 fixes that here, in ONE place both the
 * listing and the doc reader call, so the two can never disagree about which
 * directory is "the corpus".
 *
 * The slug is NOT re-derived here: `projectSlug` is imported from
 * run-control-rules.ts, the same function project-tick.ts uses to CREATE the
 * directory. A second implementation would drift the first time either side
 * was edited, and the drift would present as exactly the bug above.
 *
 * `resolvePlanDoc` moved here verbatim from routes/chat.ts (phase 300i / U6)
 * so its four traversal layers are unit-testable without standing up a
 * database — see plan-corpus.test.ts. Its rules are unchanged: a served name
 * is still a BARE FILE NAME, never a path. The subdirectory this module allows
 * comes from the project row, never from the client.
 */

import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { projectSlug } from "./run-control-rules.ts";

/** 2 MB. A plan doc in this corpus is 4–30 kB; the largest file that has ever
 *  lived in a docs/plan tree here is under 200 kB. The guard exists so a stray
 *  multi-megabyte log dropped into the directory cannot be pushed through the
 *  chat surface — the reader gets a named refusal, not a frozen tab. */
export const PLAN_DOC_MAX_BYTES = 2 * 1024 * 1024;

/** `<workspace_dir>/docs/plan` — or a named reason why there is no such path.
 *  An absolute `workspace_dir` is required: a relative one would resolve
 *  against forge-control's cwd, which is a different machine-state entirely
 *  from "the project's worktree", and silently serving files from it is the
 *  exact class of bug the rest of this module exists to prevent. */
export function planDirFor(workspaceDir: string | null): { dir: string } | { error: string } {
  if (!workspaceDir) {
    return { error: "project has no workspace_dir — plan docs cannot be located" };
  }
  if (!path.isAbsolute(workspaceDir)) {
    return { error: `project workspace_dir is not an absolute path: ${workspaceDir}` };
  }
  return { dir: path.join(workspaceDir, "docs", "plan") };
}

/** The one directory that IS this project's corpus. Exactly one — never a
 *  merged view of two, because a merged view is how another project's
 *  `00-vision.md` reached this project's panel. */
export interface PlanCorpus {
  /** Lexical path (not the realpath): it is what error strings quote and what
   *  `resolvePlanDoc` re-resolves for itself. */
  dir: string;
  /** true → `docs/plan/<slug>/`; false → the flat `docs/plan/` that projects
   *  predating C18 were planned into and are forbidden from moving. */
  namespaced: boolean;
  /** The slug that was tried, present in both branches so a caller logging a
   *  fallback can say which directory it looked for. */
  slug: string;
}

/** Why no corpus could be chosen, in the caller's terms rather than HTTP's:
 *  `no-dir` there is nowhere to look (no/relative workspace_dir), `refused`
 *  something on disk failed a safety check and this module will not guess past
 *  it, `fs` an unexpected filesystem fault. routes/chat.ts is the only place
 *  that turns these into 404/400/500 — a lib that knew status codes would be a
 *  lib that could not be reused off the HTTP surface. */
export type PlanCorpusError = { error: string; kind: "no-dir" | "refused" | "fs" };

export type PlanCorpusChoice = PlanCorpus | PlanCorpusError;

/** What a `projectSlug` result is allowed to look like before this module will
 *  join it onto a filesystem path. `projectSlug` already guarantees it
 *  (lowercase, `[a-z0-9]+` runs joined by `-`, ends stripped), so this is
 *  belt-and-braces against a FUTURE edit to that function: `.`, `..`, a
 *  separator or a NUL can never reach `path.join` from here. Defence in depth
 *  is cheap; a slug regression that quietly re-enables traversal is not. */
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Pick the corpus directory for one project: namespaced first, flat as the
 * fallback.
 *
 * Order and its reasons:
 *
 *  1. `docs/plan/<slug>/` when that directory really exists. Every project
 *     created since C18 is born this way, and this one was relocated into it.
 *  2. the flat `docs/plan/` otherwise. engine-v2-research-lane and everything
 *     before it were planned flat and boundary D6 forbids moving them, so the
 *     fallback is not a courtesy — it is the only correct answer for them.
 *
 * NOT a merge, and no per-file fallback: if the namespaced directory exists,
 * a document missing from it is a 404, NOT a look in the flat directory. The
 * flat directory of a namespaced project's worktree holds ANOTHER project's
 * corpus (it is the copy that lives on `main`), and serving from it is the
 * confidently-wrong answer this fix exists to remove.
 *
 * A symlinked slug directory pointing out of the worktree is an ERROR, not a
 * fallback: falling back would answer a suspicious request with someone else's
 * documents. The check mirrors layer 3/4 of `resolvePlanDoc` — realpath both
 * sides, compare with the separator explicitly in the prefix so
 * `docs/plan-evil` cannot pass as living under `docs/plan`.
 */
export async function selectPlanCorpus(
  workspaceDir: string | null,
  projectName: string,
  projectId: string | null,
): Promise<PlanCorpusChoice> {
  const base = planDirFor(workspaceDir);
  if ("error" in base) return { error: base.error, kind: "no-dir" };

  const slug = projectSlug(projectName, projectId);
  const flat: PlanCorpus = { dir: base.dir, namespaced: false, slug };
  if (!SAFE_SLUG_RE.test(slug)) {
    return {
      error: `refused: project slug ${JSON.stringify(slug)} is not a safe directory name`,
      kind: "refused",
    };
  }

  // The base directory itself may be missing (worktree moved or removed). That
  // is not this function's failure to report: the caller's readdir/realpath
  // names it with the context of what it was trying to do. Hand back the flat
  // path and let the existing error paths speak.
  let realBase: string;
  try {
    realBase = await realpath(base.dir);
  } catch {
    return flat;
  }

  const candidate = path.join(base.dir, slug);
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // No namespaced corpus (or a dangling symlink where one would be): a
    // legacy flat project. Any OTHER errno is a real filesystem fault and must
    // not be laundered into "use the flat directory".
    if (code === "ENOENT" || code === "ENOTDIR") return flat;
    const message = e instanceof Error ? e.message : String(e);
    return { error: `cannot resolve plan corpus at ${candidate}: ${message}`, kind: "fs" };
  }

  if (!realCandidate.startsWith(`${realBase}${path.sep}`)) {
    return {
      error:
        `rejected: plan corpus ${slug} resolves outside the plan directory ` +
        `(${realCandidate} is not under ${realBase})`,
      kind: "refused",
    };
  }

  let info: Stats;
  try {
    info = await stat(realCandidate);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `cannot stat plan corpus at ${candidate}: ${message}`, kind: "fs" };
  }
  // A regular file named after the slug is not a corpus. Treat it as "no
  // namespaced corpus here" rather than an error: for a legacy project that is
  // exactly what it is.
  if (!info.isDirectory()) return flat;

  return { dir: candidate, namespaced: true, slug };
}

/** What `resolvePlanDoc` decided: a file to serve, or a rejection with the
 *  status the caller must answer with. */
export type DocDecision =
  | { ok: true; file: string }
  | { ok: false; status: 400 | 404 | 413 | 500; error: string };

/**
 * Decide whether `name` may be served out of `planDir`. Four layers, in this
 * order, because each one only holds if the ones above it already ran:
 *
 *  1. LEXICAL. A path separator (`/` or `\`) or a NUL in `name` is refused
 *     outright — a plan doc is a FILE NAME, never a path. Hono has already
 *     percent-decoded the query, so `..%2f..%2fsecrets` arrives as
 *     `../../secrets` and dies here, on the same rule as `/etc/passwd`. NUL is
 *     checked because a truncating layer below (none today, but the check
 *     costs nothing) would see a different string than this one validated.
 *     `.md` is required here too: a name that cannot be a plan doc never
 *     reaches the filesystem.
 *
 *     Round 906 note: the per-project subdirectory did NOT relax this rule.
 *     `planDir` arrives already chosen from the PROJECT ROW by
 *     `selectPlanCorpus`; the client still cannot express a directory at all,
 *     so `?name=operator-visibility/00-vision.md` is still a 400.
 *  2. RESOLUTION. `path.resolve(planDir, name)` — with layer 1 passed this is
 *     always a direct child lexically, but resolve is what makes the string
 *     canonical before anything compares it.
 *  3. REALPATH, BOTH SIDES. The plan dir AND the candidate are resolved
 *     through symlinks. This is the layer that stops the attack `resolve`
 *     cannot see: a symlink sitting INSIDE the plan dir whose target is
 *     /etc/passwd is lexically a perfect child and physically an escape.
 *     Resolving the dir too is what keeps the comparison valid when the
 *     worktree path itself runs through a symlink (/tmp → /private/tmp and
 *     friends) — otherwise every request would fail closed for the wrong
 *     reason.
 *  4. CONTAINMENT. `resolved === dir + sep + …`, with the separator explicitly
 *     part of the prefix. A bare `startsWith(dir)` would accept
 *     `/…/docs/plan-evil/secrets.md` as living under `/…/docs/plan`. The dir
 *     itself is also not a file and is rejected by the same comparison.
 *
 * Then a stat: only a regular file (a directory named `x.md`, a fifo, a device
 * are all refusals) and only under the size cap.
 *
 * Every rejection names itself. A path-restriction that answers "400" with no
 * body teaches the operator nothing and teaches an attacker exactly as much.
 */
export async function resolvePlanDoc(planDir: string, name: string): Promise<DocDecision> {
  if (!name) return { ok: false, status: 400, error: "missing ?name=" };
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, status: 400, error: `rejected: name must be a bare file name, got a path: ${name}` };
  }
  if (name.includes("\0")) {
    return { ok: false, status: 400, error: "rejected: name contains a NUL byte" };
  }
  if (name === "." || name === "..") {
    return { ok: false, status: 400, error: `rejected: name is a directory reference: ${name}` };
  }
  if (!name.toLowerCase().endsWith(".md")) {
    return { ok: false, status: 400, error: `rejected: only .md documents are served, got: ${name}` };
  }

  let realDir: string;
  try {
    realDir = await realpath(planDir);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT" ||
      (e as NodeJS.ErrnoException).code === "ENOTDIR";
    return {
      ok: false,
      status: missing ? 404 : 500,
      error: `plan directory unavailable at ${planDir}: ${message}`,
    };
  }

  const candidate = path.resolve(realDir, name);
  let realFile: string;
  try {
    realFile = await realpath(candidate);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message = e instanceof Error ? e.message : String(e);
    // ENOENT covers both "no such file" and "dangling symlink"; both are 404 —
    // the name was well-formed, the document is not there.
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, status: 404, error: `no such plan document: ${name}` };
    }
    return { ok: false, status: 500, error: `cannot resolve ${name}: ${message}` };
  }

  if (!realFile.startsWith(`${realDir}${path.sep}`)) {
    return {
      ok: false,
      status: 400,
      error: `rejected: ${name} resolves outside the plan directory (${realFile} is not under ${realDir})`,
    };
  }

  let info: Stats;
  try {
    info = await stat(realFile);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, error: `cannot stat ${name}: ${message}` };
  }
  if (!info.isFile()) {
    return { ok: false, status: 400, error: `rejected: ${name} is not a regular file` };
  }
  if (info.size > PLAN_DOC_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `refused: ${name} is ${info.size} bytes, over the ${PLAN_DOC_MAX_BYTES}-byte plan-doc limit`,
    };
  }
  return { ok: true, file: realFile };
}
