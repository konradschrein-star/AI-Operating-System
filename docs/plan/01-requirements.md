# 01 — Requirements

Every requirement is numbered, testable, and owned by exactly one phase (matrix in
04-phases.md). "Engine" = `forge-control/src/lib/project-tick.ts` + `src/db/projects.ts`
unless another file is named. Hard-error policy applies throughout: no silent fallbacks;
anything that swallows an error is a review-blocking defect.

## A. Reviewer-round consolidation (bug 1)

- **R1 — Group settlement.** Reviewer tasks are reconciled as a *(project_id, round)
  group*: no verdict action (fix chain, block, pass) is taken until EVERY reviewer task in
  that group has a settled run (`completed`) or the group is already broken by a
  failed/cancelled run (which takes the existing task-failed → project-blocked path).
  *Verify:* unit test on the pure group-readiness function; a settled reviewer whose
  sibling is still running produces no action and stays reconcilable next tick.
- **R2 — One fix chain per round.** N ≥ 1 NEEDS_FIXES verdicts in one group produce
  exactly ONE `Fix cycle {c}` builder at `round + 1` and exactly ONE
  `Re-review after fix cycle {c}` reviewer at `round + 2`. The builder brief merges ALL
  NEEDS_FIXES feedback, sectioned per source reviewer (task title + its full feedback
  text). The re-review brief instructs re-checking every merged concern against the new
  diff. *Verify:* unit test (two NEEDS_FIXES in ⇒ one builder + one reviewer out, both
  reviewers' text present in the merged brief).
- **R3 — PASS never races NEEDS_FIXES.** Because of R1, a PASS from one reviewer takes no
  effect while a sibling is unsettled; in a settled group, any NEEDS_FIXES wins over any
  number of PASSes. All-PASS ⇒ mark group done, create nothing (project close stays with
  `closeFinishedProjects()`). *Verify:* unit tests for PASS+NEEDS_FIXES and all-PASS groups.
- **R4 — Verdict parsing hardened.** The verdict is the LAST `VERDICT: PASS|NEEDS_FIXES`
  occurrence in the reviewer's final message (reviewers quote the format mid-reasoning;
  the last line is the declaration). Extracted as a pure `parseVerdict(text)` returning
  `'PASS' | 'NEEDS_FIXES' | null`. *Verify:* unit tests incl. quoted-verdict-then-real-verdict,
  missing verdict, case variance.
- **R5 — Unparseable verdict blocks.** Any settled reviewer in the group with no parseable
  verdict ⇒ project `blocked` + notification naming the reviewer task (existing behavior,
  now group-aware: evaluated at group settlement, before fix/pass logic). *Verify:* unit test.
- **R6 — Fix-cycle ceiling.** Chain cycle `c = max(fix_cycle over the group) + 1`; if
  `max(fix_cycle) >= MAX_FIX_CYCLES` (3) and the group still needs fixes ⇒ project
  `blocked` + notification (existing behavior preserved at group level). *Verify:* unit test.
- **R7 — Idempotent, crash-safe creation.** Fix builder + re-reviewer are inserted in ONE
  transaction, each stamped with a deterministic `chain_key`
  (`fix:{round}:{c}` / `rereview:{round}:{c}`), inserted `ON CONFLICT DO NOTHING` against
  a partial unique index `(project_id, chain_key)` (migration 0039 — renumbered from 0035
  at R308: `main` shipped its own 0035, the task-identity index). Reviewers are marked
  `done` only AFTER the insert transaction commits, so a crash between the two steps
  re-runs consolidation and the conflict guard absorbs the replay. Historical rows have
  `chain_key NULL` — the migration adds a nullable column + partial index and touches no
  existing data. *Verify:* unit test on chain_key derivation; SQL review; red-team
  crash-window walk in the review.

## B. Project-status gating (bug 2)

- **R8 — Promotion gated.** `promoteReadyTasks()` promotes `pending → ready` only for
  tasks whose project has `status = 'active'`. *Verify:* SQL clause present + red-team walk;
  behavior covered by the extracted predicate test (R10).
- **R9 — Claiming gated.** `claimReadyTasks()` claims only tasks of `active` projects.
  A task already `running` when its project pauses is NOT killed (run cancellation stays a
  separate, explicit operation); it finishes and reconciles normally, but reconciliation
  spawns nothing new for a non-active project beyond recording (fix-chain tasks MAY be
  created while non-active — they are pending rows, harmless by R8/R9, and resume
  correctly on reactivation). *Verify:* SQL review + unit test of the shared predicate.
- **R10 — Testable predicate.** A pure `projectAcceptsWork(status: ProjectStatus): boolean`
  (true only for `'active'`) exported from the new pure-logic module and used as a
  defense-in-depth TS-side filter in `spawnTaskRuns()` in addition to the SQL clauses —
  the SQL is the gate, the predicate is the belt worn in code and in tests. *Verify:* unit
  tests over all five statuses.
- **R11 — Typecheck + suite.** After `pnpm install --prod=false` (never a bare `pnpm
  install`: `NODE_ENV=production` is inherited from the executor and silently drops the
  dev deps that ARE the toolchain), `npx tsc --noEmit` clean in `forge-control`; `pnpm test`
  green including the new `project-reconcile.test.ts`. *Verify:* commands run by builder
  and reviewer each phase.

## C. Worktree-only policy + executor-safe deploy (bugs 3 + 4)

- **R12 — Worktree-only rule in prompts.** `buildPrompt()` appends, for every role on a
  repo-backed (non-scratch) project, an explicit policy block: all edits happen in the
  project worktree; the live checkout (`/opt/forge-ai-os` for repo `ai-os`,
  `/opt/content-forge` for `content-forge`) must NEVER be edited during build phases;
  verification against live endpoints happens only via an explicitly-briefed deploy/verify
  task. *Verify:* unit test asserting the policy text appears in builder/planner/
  architect/reviewer/researcher prompts for repo projects and NOT for scratch projects.
- **R13 — Reviewer cleanliness check.** The reviewer prompt for repo-backed projects
  instructs: run `git -C <live checkout> status --porcelain`; any dirt is itself a
  NEEDS_FIXES finding (someone hot-applied). *Verify:* prompt unit test + reviewer
  behavior observed in this very project's later phases.
- **R14 — Executor-safe deploy guidance.** The goal-mode architect prompt's deploy
  guidance (and `docs/tools/deploy-playbook.md`) states: when the diff touches
  executor-loaded code (`src/lib/project-tick.ts`, `src/lib/cc-runner.ts`,
  `src/executor.ts`, `src/db/*`, `agents/*.md` role files), NEVER `pm2 restart
  forge-executor`; instead launch
  `setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &`
  and END the task — the restart lands when the fleet is idle. `pm2 restart forge-control`
  (API side) remains allowed. *Verify:* prompt unit test for the guidance text; deploy
  phase follows it.

## D. GitHub integration

- **R15 — Push helper.** `scripts/git-sync-branch.sh <worktree-dir>` (repo root
  `scripts/`): verifies an `origin` remote exists and `gh auth status` succeeds, then
  `git push origin HEAD` — plain push, no `--force`/`--force-with-lease` anywhere in the
  script; fails loudly (non-zero + stderr) on rejection, never retries with force.
  With `--pr "<title>"` it additionally opens a PR via `gh pr create` (base = project
  base branch) if none exists for the branch. No origin / no auth ⇒ clear non-zero error
  (caller decides whether that matters). *Verify:* run against this repo (push succeeds);
  grep proves no force flag; no-origin case tested in a scratch repo.
- **R16 — Phase-completion push guidance.** Goal-mode prompt guidance (planner + reviewer
  branches of `buildPrompt()`): when a phase's gating reviewer issues PASS on a repo with
  an origin remote, the reviewer runs the push helper so progress is visible on GitHub.
  Deterministic engine-side pushing is explicitly rejected (see 02-architecture,
  rejected alternatives). *Verify:* prompt unit test; observed pushes from later phases
  of this project.
- **R17 — PR-on-completion guidance.** Deploy guidance: if the project brief says "open a
  PR instead of merging", the final phase uses `git-sync-branch.sh --pr` and does NOT
  merge to main; otherwise merge per the brief. *Verify:* guidance text test; this
  project's own brief says merge, so the PR path is proven only via helper dry-run
  against a scratch repo.

## E. Researcher role

- **R18 — Role file.** `agents/researcher.md` exists in-repo. Frontmatter: `name`,
  `description`, `model: claude-opus-5`, `effort: high`,
  `tools: Read, Write, Glob, Grep, Bash, WebSearch, WebFetch, Skill`. Mission: deep
  research with real sources; may steer a real browser via the playwright/hermes browser
  skills for logged-in/web-app work; MUST cite what it saw (URLs, titles, dates, quoted
  snippets); writes findings to `docs/research/*.md`; no implementation, no task creation.
  It also names the two service helpers (`scripts/perplexity.mjs`, `scripts/gemini-qa.mjs`)
  as available instruments with their key protocol. *Verify:* file exists, frontmatter
  parses under `roleConfig()`'s regexes (unit-test the parse against the real file content).
- **R19 — Installation. STRUCK at R308 — superseded by R306's repo fallback.** It required
  a human `cp` into `/root/.claude/agents/`, which the agent harness guards as a sensitive
  path, so no task of this project could satisfy it (three rounds proved exactly that —
  `docs/plan/evidence/p3-smoke.md`). `roleFilePaths()` now falls back to `REPO_AGENTS_DIR`,
  so a role file committed to `agents/` self-installs at the first post-deploy executor
  restart. *Superseded by:* R18 (file exists, frontmatter parses) + T13 (the ENGINE's own
  resolution order finds a real definition, and any hand-installed copy is byte-identical).
  Konrad is owed nothing; the reminder asking him for the `cp` was cancelled at R308.
- **R20 — Smoke run. MOVED to P6 at R308** (acceptance unchanged; see 03-quality §3.1).
  It cannot run before the deploy: the live engine predates the repo fallback, so a
  researcher launched on it would cache the bare mission for the executor's lifetime and
  force the one restart this project must not perform. After P6's detached restart it
  tests the deployed engine, which is the stronger check.
  A scratch-repo project is created whose brief instructs its
  round-0 architect (tier `fast`) to create exactly one researcher task and stop. The
  researcher task runs end-to-end: run completes, a `docs/research/*.md` with ≥ 3 cited
  sources is committed in the scratch repo. The scratch project is then closed
  (status → done/cancelled via API). *Verify:* file content inspected by the phase
  reviewer; run row completed; project closed.

## F. External research services

- **R21 — gemini-qa CLI.** `scripts/gemini-qa.mjs` (node ≥ 22, zero npm dependencies,
  built-in `fetch` only): input = local video path OR public/YouTube URL; local files
  upload via the Gemini Files API resumable flow, poll until `ACTIVE`, then
  `generateContent` with `responseMimeType: application/json` + `responseSchema`; URLs
  pass as `file_data.file_uri` directly. Output: the structured QA JSON (rubric in
  02-architecture §5) on stdout; `--out <file>` optional. Default model
  `gemini-3.6-flash`, `--model` override. *Verify:* error-path proof (R23) plus, if a key
  exists by then, one real run on a short sample video.
  **AMENDED at R502 — superseded by `docs/research/round-399-41e8757d.md`** (build-day
  re-verification, surfaced by `docs/plan/evidence/p5-integration-sweep.md` §2b). Two
  corrections, both because the original text predates the model research; the shipped
  code is right and must not be changed to match it. (a) The default model is
  **`gemini-omni-flash`**, not `gemini-3.6-flash`: `gemini-3.6-flash` does **not accept
  video input**, so the tool's primary use case would fail on every invocation
  (`scripts/gemini-qa.mjs:68-72`; research at `docs/research/round-399-41e8757d.md:15,22,198,233`).
  (b) The rubric lives in **02-architecture §6.2**, not §5 — §5 is the researcher lane.
  Everything else in R21 stands as written.
- **R22 — perplexity helper.** `scripts/perplexity.mjs` (same zero-dep rules): modes
  `ask "<question>"` (chat completions, model default `sonar-pro`, `--model` override) and
  `search "<query>"` (dedicated search endpoint); output JSON
  `{ answer?, citations[], search_results[] }` on stdout. Browser-steering fallback is
  DOCUMENTED in `docs/tools/perplexity.md` as manual procedure, not built. *Verify:*
  error-path proof (R23); live smoke if a key exists.
  **AMENDED at R502 — superseded by `docs/research/perplexity-api.md` (commit d870320),**
  surfaced by `docs/plan/evidence/p5-integration-sweep.md` §2c. The original text
  specified `ask` as Sonar chat completions with model default `sonar-pro`. Live probing
  on 2026-08-05 found Sonar Chat Completions deprecated (July 2026) and
  `POST /v1/chat/completions` returning 404; there is no `perplexity/sonar-pro` slug.
  **New binding text — as built:** `scripts/perplexity.mjs` (same zero-dep rules): modes
  `ask "<question>"` (Perplexity **Agent API**, `POST https://api.perplexity.ai/v1/agent`,
  model default `perplexity/sonar`, `--model`/`--preset` override, web search attached and
  forced by default) and `search "<query>"` (`POST https://api.perplexity.ai/search`);
  output JSON `{ answer, citations[], search_results[], model, usage }` for `ask` and
  `{ search_results[] }` for `search`, on stdout — a superset of the original shape, no
  field lost. The Agent API is strict — any unknown field is a hard HTTP 400 — so the
  request body is an explicit whitelist, never a pass-through of user options.
  Browser-steering fallback is DOCUMENTED in `docs/tools/perplexity.md` §11 as manual
  procedure, not built. *Verify:* error-path proof (R23); live smoke if a key exists.
- **R23 — Key protocol (both tools).** Key resolution order: env (`GEMINI_API_KEY` /
  `PERPLEXITY_API_KEY`) → secret store file (`/opt/ai-os/.secrets/store/gemini-api-key` /
  `perplexity-api-key`). Missing ⇒ exit code 2 with a message naming BOTH locations and
  the exact key name; no partial behavior. Invalid key ⇒ surface the API's HTTP status +
  error body verbatim, exit 1 — this proves the request path without a valid key.
  *Verify:* run both tools with no key and with `GEMINI_API_KEY=invalid` etc.; assert
  messages and exit codes (scriptable check the reviewer re-runs).
- **R24 — Reminders for missing keys.** As of recon (2026-08-05) NEITHER key exists in
  `/opt/ai-os/.secrets/store/`. For each key still missing at build time, the builder
  queues ONE reminder via `POST http://127.0.0.1:7700/api/reminders` telling Konrad the
  exact key name, where to put it (secret store name + path, or env var), and what it
  unlocks. Queued once per key by the build task — NOT by the tools at runtime. *Verify:*
  reminder rows exist (GET the reminders API); text names key + location.
- **R25 — Tool docs.** `docs/tools/gemini-qa.md` and `docs/tools/perplexity.md`: usage,
  flags, key setup (both locations), rubric semantics / response fields, cost notes
  (models + rough pricing from research), error-path examples, and (perplexity) the
  documented browser fallback. *Verify:* docs exist and match actual CLI behavior
  (reviewer cross-checks `--help` output against docs).

## G. Integration, documentation, deploy

- **R26 — Full regression + whole-diff review.** Final build phase: `pnpm install
  --prod=false` (worktree `forge-control` has no `node_modules`, and `NODE_ENV=production`
  in the executor env makes a plain install skip `tsx`/`typescript` — see 03-quality
  §preamble), `npx tsc --noEmit`, `pnpm test`, and a
  reviewer sweep over `git diff main...HEAD` for the whole project. *Verify:* reviewer
  runs the commands and reasons through the failure-mode checklist in 03-quality.
- **R27 — Knowledge capture.** Vault updates appended (never overwritten): `AI OS/Goal
  Mode Design.md` gains the consolidation/gating semantics, worktree-only policy, deploy
  pattern, and researcher lane; `AI OS/Operator Log.md` gains a dated entry. A
  `docs/tools/deploy-playbook.md` in-repo records the executor-safe deploy steps.
  *Verify:* notes contain the new sections; nothing deleted.
- **R28 — Deploy protocol.** Exactly the brief's: in `/opt/forge-ai-os`, merge `main` into
  `project/4120f785` first if main moved; re-run tsc + tests in the WORKTREE; merge to
  main; on conflicts STOP and report files; `pm2 restart forge-control`; detached
  `safe-restart.sh forge-executor 43200 45` via `setsid nohup … &` without waiting;
  apply migration 0039 before restarting (additive: nullable column + partial index);
  final message lists changes, test results, and keys/reminders owed. *Verify:* deploy
  task transcript; post-deploy `pm2 ls` shows forge-control online; safe-restart log
  exists.

## Non-functional requirements

- **N1 — No new npm dependencies** anywhere (helpers are zero-dep; engine changes use
  what's installed). pnpm only, per repo rules.
- **N2 — Do not touch** `forge-control-web/app/desktop/**` or `src/routes/agents.ts`.
- **N3 — Hard errors everywhere:** no catch-and-continue on new paths except where the
  existing code deliberately degrades (notification queueing`.catch(() => {})` may stay);
  every new failure path either throws or notifies Konrad.
- **N4 — Migration discipline:** 0035 is additive-only (nullable column + partial unique
  index), applied to the live DB only at deploy phase, safe for the running engine
  (old code never writes `chain_key`).
  **AMENDED at R502 — the migration number is stale** (surfaced by
  `docs/plan/evidence/p5-integration-sweep.md` §2a). As written, N4 tells a deploy
  engineer to treat *main's* `0035_task_idempotency.sql` — already live — as this
  project's migration, which is exactly the ambiguity the R308 renumber existed to
  remove. Every other corpus site was updated (`01-requirements.md:41`,
  `03-quality.md:99`, `04-phases.md:31`); N4 was missed. **New binding text:**
  `db/migrations/0039_reviewer_chain_key.sql` — renumbered from 0035 at R308, because
  `main` shipped its own `0035_task_idempotency.sql` while this branch was out and
  `db/migrations/` has no ledger to disambiguate two `0035_*` files — is additive-only
  (nullable column + partial unique index), applied to the live DB only at deploy phase,
  safe for the running engine (old code never writes `chain_key`).
- **N5 — Worktree discipline (self-referential):** every build task of THIS project works
  only in `/opt/ai-os/workspace/projects/4120f785-…`; the only live-system writes allowed
  before deploy are: queueing reminders (R24), applying nothing to
  `/opt/forge-ai-os`, and vault appends (R27).
