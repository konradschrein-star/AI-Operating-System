# Deploy Playbook — engine-v2-research-lane

This is the operational counterpart to `docs/plan/02-architecture.md` §3–4 and
`docs/plan/01-requirements.md` R12–R17. Where those documents argue for the design, this
one is the thing you actually run: what to type, what each exit code means, what happens
if you get it wrong. Every command below is copy-pasteable and was checked by eye against
the code that ships it (see §7 for exactly which strings, and keep it that way).

## 1. Why this exists

The first night this engine ran itself produced two failures that trace to the same root
cause: nothing stopped a fleet agent from touching the **live** checkout instead of its
**worktree**.

- **Hot-applied live checkout.** Build-phase agents edited `/opt/forge-ai-os` directly —
  usually so a reviewer could `curl` a real endpoint instead of standing up a throwaway
  server — which patched half-finished code into the process actually serving traffic.
  forge-control restarted with no corresponding deploy, and nobody watching had an
  explanation until someone diffed the live tree against `main`.
- **Executor suicide.** A builder ran `pm2 restart forge-executor` "just to test" its own
  change. The executor is the process hosting every live agent turn, including the one
  that issued the restart — it killed itself and every sibling run mid-flight, with no
  graceful handoff.

Both failures are instances of one rule getting skipped: **build-phase work never touches
what is live.** §2–4 encode that rule at the point where fleet-agent behavior is actually
generated (the prompts), plus a gate that checks it (the reviewer) and a deploy procedure
that respects it (the detached restart).

## 2. Worktree-only policy

**The rule:** during build phases, every role works *only* in the project's worktree —
the directory it is already checked out into. The live checkout for the project's repo
must never be edited, patched, or "quickly fixed" during a build phase, no matter how
convenient that would be for testing against a real endpoint.

**Live-checkout map** (`REPO_PATHS` in `forge-control/src/lib/workspace.ts:13-16`,
exposed via `liveCheckoutPath(repo)` at `workspace.ts:29-31`):

| `project.repo` | Live checkout |
|---|---|
| `ai-os` | `/opt/forge-ai-os` (override: `AI_OS_REPO_DIR`) |
| `content-forge` | `/opt/content-forge` (override: `CONTENT_FORGE_REPO_DIR`) |
| `scratch` | none — `liveCheckoutPath` returns `null` |

**Where it's enforced:** `WORKTREE_POLICY(liveCheckout: string)` in
`forge-control/src/lib/project-tick.ts:164-177`. `buildPrompt()` (same file, `:227` on)
routes every role's return value through a local `withPolicy()` wrapper
(`project-tick.ts:233-236`) that appends this block whenever `liveCheckoutPath(project.repo)`
is non-null — i.e. for every role, on every repo-backed project, and never for `scratch`
projects (which have nothing live to protect). The block itself, verbatim:

> WORKTREE-ONLY POLICY (non-negotiable):
> - The live checkout for this repo is `<liveCheckout>`. During build phases you work
>   ONLY in this worktree — the directory you are already in. `<liveCheckout>` must
>   NEVER be edited, patched, or "just quickly fixed" during a build phase, no matter how
>   convenient it would be for testing.
> - NEVER run `pm2 restart forge-executor`. That kills every run in flight, including
>   your own. Restarting the executor is the deploy phase's job and it has a detached
>   procedure for it.
> - Verification against LIVE endpoints, live services, or the live database happens
>   ONLY inside an explicitly-briefed deploy/verify task — never ad hoc from a build task.
>   If your brief does not say "deploy" or "verify against live", you have no business
>   touching `<liveCheckout>`.
> - Need to prove something works? Run it out of the worktree (tsx, unit tests, a
>   throwaway port). If that is genuinely impossible, say so in your final message and
>   let the deploy/verify task do it.

**The escape hatch:** live verification is not banned outright — it is confined to a task
whose brief explicitly says "deploy" or "verify against live". That task is the only place
`<liveCheckout>` may legitimately be touched (and even then, only via the detached restart
procedure in §4, never a live edit). Everywhere else, "I need to prove this against a real
endpoint" is answered with a throwaway port or a unit test inside the worktree, not a live
edit.

## 3. Reviewer cleanliness check

The worktree-only rule is only as good as the gate that catches violations, so the
reviewer role owns it. `REVIEWER_LIVE_CHECK(liveCheckout: string)`
(`forge-control/src/lib/project-tick.ts:183-193`) is appended to every reviewer prompt for
repo-backed projects (via the same `withPolicy` gating), verbatim:

> LIVE-CHECKOUT CLEANLINESS CHECK (mandatory, run it before you write your verdict):
> ```
> git -C <liveCheckout> status --porcelain
> ```
> ANY output at all means someone hot-applied work into the live checkout instead of
> keeping it in the worktree. That is by itself a NEEDS_FIXES finding: name the dirty
> files verbatim in your numbered list and require them to be reverted there and redone
> in the worktree. Empty output is the only pass. Paste the command's output (or its
> emptiness) into your review — an unexecuted check is not a check.

For this project, that literally means:

```
git -C /opt/forge-ai-os status --porcelain
```

Any non-empty output is a NEEDS_FIXES verdict, full stop — it does not matter whether the
rest of the diff is otherwise ready.

## 4. Executor-safe deploy

**Executor-loaded paths.** The forge-executor process reads these into memory and holds
them for the life of the process; a plain restart while any of them differ from what's
live drops every in-flight run. Role files specifically are cached in-process by
`roleConfig()` (`forge-control/src/lib/project-tick.ts:104-121`) the first time each role
is used — its own comment says it plainly: "Cached — restart forge-executor after editing
one of these files." Executor-loaded paths:

- `forge-control/src/lib/project-tick.ts`
- `forge-control/src/lib/cc-runner.ts`
- `forge-control/src/executor.ts`
- `forge-control/src/db/*`
- `agents/*.md` (role files, loaded from `AGENTS_DIR`, default `/root/.claude/agents`)

**What's allowed:** `pm2 restart forge-control` — the API side. Nothing long-running lives
in that process, so a plain restart is fine and is how route/API changes actually take
effect.

**What's forbidden, unconditionally:** `pm2 restart forge-executor`. Not to deploy, not to
test, not "just this once" — from `DEPLOY_GUIDE` (`project-tick.ts:197-215`). It is the
process hosting every live agent turn; restarting it kills whatever is running, including
the deploy task itself if it issued the command.

**The detached procedure** (`DEPLOY_GUIDE`, `project-tick.ts:203`), the exact command to
run after merging:

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
```

Launch it detached and **end the task** — never wait for it, never poll it, never tail
the log until it finishes. The script waits for the fleet to go idle and restarts then;
your task must return immediately.

**What `safe-restart.sh` actually does** (read from `/opt/ai-os/scripts/safe-restart.sh`,
invoked here as `safe-restart.sh forge-executor 43200 45`, i.e. `SVC=forge-executor`,
`MAX_WAIT=43200` seconds (12h), `IDLE_SECS=45`, no `ECOSYSTEM` arg):

- Every 15s (`POLL=15`) it queries Postgres directly
  (`SELECT count(*) FROM runs WHERE last_heartbeat_at > now() - interval '45 seconds'`)
  for runs that heartbeat inside the idle window. It does **not** trust run `status` —
  the script's own comment notes a run can sit in `'stuck'` while its process is still
  very much alive, which is exactly what the old wall-clock timeout used to produce.
- It requires **two consecutive** quiet polls (`STABLE_NEEDED=2`, so ~30s of confirmed
  silence, not just one lucky sample) before acting. Any run resuming activity resets the
  counter to zero and it goes back to waiting.
- Once idle is confirmed it runs `pm2 restart forge-executor --update-env` and, after a
  4s settle, checks `pm2 jlist` for that process's status.
- If the DB is unreachable mid-poll, it treats that as "not confirmed idle" (resets the
  stability counter) rather than restarting blind.
- **Exit codes** (verified against the script, not paraphrased from an earlier draft):
  `0` — restarted and pm2 reports the process `online`; `1` — either the `pm2 restart`
  command itself failed, or it succeeded but the process is not `online` afterward
  (logged as `WARNING: ... is '<state>' after restart`); `2` — gave up after `MAX_WAIT`
  (43200s here) because the system never went quiet — it never force-kills a live turn.
- Internal progress is logged to `/var/log/forge-safe-restart.log` (the script's own
  `log()` calls); the `>> /tmp/safe-restart.log 2>&1` in the launch command separately
  captures the detached process's stdout/stderr (mostly the pm2 restart output and the
  final `python3` status check) — check both if you need to know what happened.

**The rule:** launch it and walk away. The restart lands on its own schedule once the
fleet is idle; a deploy task that waits for it defeats the entire point of making it
detached.

## 5. GitHub lane

`scripts/git-sync-branch.sh <worktree-dir> [--pr "<title>"] [--base <branch>] [--project <project-id>]`

Deliberately boring (from the script's own header comment): plain push only, every
failure is loud, nothing is ever retried or escalated. A rejected push is the caller's
problem to resolve by hand.

**Exit codes** (verified against the script's header comment and control flow):

| Code | Meaning |
|---|---|
| 0 | Branch pushed (and PR created, or one already existed for the branch) |
| 1 | Push rejected, or a `gh pr` operation failed — git/gh stderr reaches the caller intact |
| 2 | Bad arguments, not a git worktree, or detached HEAD |
| 3 | No `origin` remote |
| 4 | `gh` not authenticated (not on `PATH`, or `gh auth status` failed) |

**The force-free guarantee:** the string `--force` does not appear anywhere in the script
— `grep -c -- "--force" scripts/git-sync-branch.sh` returns `0`. Every push is
`git -C "$dir" push origin HEAD`. This matters specifically because the fleet runs
autonomously: a force push from an agent with no human in the loop to notice a rewritten
remote history is unrecoverable, so the helper is built to be structurally incapable of
it rather than merely instructed not to.

**When reviewers push:** `GITHUB_PUSH_GUIDE` (`project-tick.ts:217-225`), appended to
reviewer and planner prompts for repo-backed projects — when a phase's gating reviewer
issues `VERDICT: PASS` and the repo has an origin remote, it runs
`scripts/git-sync-branch.sh <worktree-dir>` to push the work branch so progress is
visible on GitHub. Plain push only — the guidance repeats the force ban explicitly (never
`--force`, never `--force-with-lease`) because the branch is shared with whatever else is
watching it. A push failure (no origin, no auth, rejected) is reported verbatim in the
reviewer's final message and never changes the verdict.

**PR instead of merge (R17):** from `DEPLOY_GUIDE` — if the project brief says to open a
PR instead of merging, the deploy phase runs
`scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"` and does **not** merge to
main; the PR is the deliverable. `--pr` is idempotent: it lists existing PRs for the
branch first (`gh pr list --head <branch>`) and only calls `gh pr create` if none exists,
so re-running a deploy task after a partial failure never opens duplicates.

## 6. Deploy checklist

The final phase of a repo-backed project, only after the gating reviewer's `VERDICT:
PASS`:

1. In the live checkout (`/opt/forge-ai-os` for this project): merge `main` into the work
   branch first if `main` moved since the branch was cut.
2. Re-run the full gate in the worktree: `pnpm install --prod=false && npx tsc --noEmit && pnpm test`
   (this repo has no `node_modules` checked in, and a bare `pnpm install` silently skips
   `devDependencies` — including `typescript` and `tsx` — under the executor's inherited
   `NODE_ENV=production`; see `docs/plan/03-quality.md`).
3. Merge the work branch to `main`. On conflicts: **STOP** and report the conflicting
   files — do not resolve them unilaterally in a deploy task.
4. Apply any pending migrations added by the project (e.g. `db/migrations/0035_reviewer_chain_key.sql`
   from Phase 1) before restarting either process.
5. `pm2 restart forge-control` to pick up API/route changes — always safe.
6. For executor-loaded code (§4's path list): launch the detached restart —
   `setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &`
   — and end the task without waiting.
7. Final message: what changed (files), the test results from step 2, and which API keys
   or reminders Konrad owes the system (e.g. missing `GEMINI_API_KEY` /
   `PERPLEXITY_API_KEY` from later phases of this project).

## 7. Keeping this doc honest

Every command and code block above is quoted from, not paraphrased from, the shipped
source — `WORKTREE_POLICY`, `REVIEWER_LIVE_CHECK`, `DEPLOY_GUIDE`, and `GITHUB_PUSH_GUIDE`
in `forge-control/src/lib/project-tick.ts` are the actual constants the engine
interpolates into prompts; `scripts/git-sync-branch.sh` and
`/opt/ai-os/scripts/safe-restart.sh` are read directly, not summarized from
`docs/plan/`. If those constants or scripts change, update this file in the same commit —
it is documentation of what ships, not a second source of truth to keep in sync by hand.
The prompt-text unit tests in `forge-control/src/lib/project-tick.test.ts` (T10, this
project's Phase 2) guard that the constants exist and are wired into `buildPrompt()`
correctly; they do not check this document. A drift between this file and the code it
quotes is a doc bug, not a test failure — nothing will catch it automatically.
