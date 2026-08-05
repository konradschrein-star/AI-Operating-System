# 02 — Architecture

State ownership is unchanged and remains the law of this system: **PostgreSQL owns state**
(`projects`, `project_tasks`, `runs`), **the deterministic tick dispatches work**
(`projectTick()` in `forge-control/src/lib/project-tick.ts`, called from the executor's
manager loop every ~10s), **failure surfaces as blocked status + Telegram notification**
(`queueNotification`), and **Konrad sees it on the Kanban board and heartbeats**. Every
change below is a refinement of that machine, not a new machine.

## 1. Reviewer-round consolidation (bugs 1)

### 1.1 What is wrong today (read from the code, 2026-08-05)

`reconcileReviewer()` (project-tick.ts:290) fires once per settled reviewer task, with no
awareness of sibling reviewers in the same round. Two reviewers in round R that both say
NEEDS_FIXES each insert a `Fix cycle 1` builder at R+1 and a re-reviewer at R+2 — the
first night produced exactly this, plus downstream duplicate deploy builders. A PASS is a
no-op return, so ordering between a PASS and a sibling's NEEDS_FIXES is tick-arrival
luck. Nothing is idempotent: a crash between the two `createTask` calls would replay one
side on the next tick.

### 1.2 Target design

**New pure module `forge-control/src/lib/project-reconcile.ts`** (no DB, no I/O — the
unit-testable core, precedent `account-health.ts`):

```ts
export type Verdict = "PASS" | "NEEDS_FIXES" | null;
export function parseVerdict(text: string | null): Verdict;          // LAST occurrence wins
export function projectAcceptsWork(status: ProjectStatus): boolean;  // status === 'active'

export interface ReviewerInput {
  taskId: string; title: string; fixCycle: number;
  settled: boolean;               // run status is 'completed'
  lastText: string | null;
}
export type RoundDecision =
  | { action: "wait" }                                   // some sibling not settled
  | { action: "pass" }                                   // all settled, all PASS
  | { action: "block"; reason: "no_verdict" | "max_cycles"; detail: string }
  | { action: "fix"; cycle: number; mergedBrief: string; // one builder + one re-reviewer
      builderChainKey: string; reviewerChainKey: string };
export function consolidateReviewerRound(
  round: number, reviewers: ReviewerInput[], maxFixCycles: number,
): RoundDecision;
export function chainKeys(round: number, cycle: number):
  { builder: string; reviewer: string };                 // "fix:R:c" / "rereview:R:c"
```

Decision rules (in order): any unsettled sibling → `wait`; any settled sibling with
unparseable verdict → `block(no_verdict)`; any NEEDS_FIXES with
`max(fixCycle) >= maxFixCycles` → `block(max_cycles)`; any NEEDS_FIXES →
`fix(cycle = max(fixCycle)+1)` with `mergedBrief` = each NEEDS_FIXES reviewer's full text
under a `## Feedback from: <task title>` heading; else → `pass`.

**Orchestration change in `reconcileSettledTasks()`:** settled reviewer tasks are grouped
by `(project_id, round)`; for each group the tick loads ALL reviewer tasks of that
project+round (new query `listReviewerRound(projectId, round)` in db/projects.ts,
returning task + run settlement + last_text), maps them to `ReviewerInput[]`, and applies
the decision:

- `wait` → do nothing this tick (tasks stay `running`; the group re-evaluates next tick).
- `pass` → mark all group reviewers `done`.
- `block` → mark reviewers `done`, set project `blocked`, `queueNotification` with the
  reason and the offending task title(s).
- `fix` → **one transaction**: insert builder (round+1, `fix_cycle = cycle`,
  `chain_key = fix:R:c`) and re-reviewer (round+2, `chain_key = rereview:R:c`), both
  `ON CONFLICT (project_id, chain_key) DO NOTHING`; commit; THEN mark all group reviewers
  `done`. Crash after commit but before mark-done ⇒ next tick recomputes `fix`, the
  conflict guard absorbs the duplicate inserts, mark-done proceeds. Order matters:
  creating tasks before marking reviewers done means `promoteReadyTasks` can never see a
  fully-done round R with the fix round missing (which would wrongly promote round-R+100
  phase planners past an unfinished fix cycle).

Non-reviewer settled tasks keep the existing per-task path untouched.

### 1.3 Data model — migration `db/migrations/0039_reviewer_chain_key.sql`

```sql
ALTER TABLE project_tasks ADD COLUMN chain_key text;   -- NULL for everything historical
CREATE UNIQUE INDEX project_tasks_chain_key_uniq
  ON project_tasks (project_id, chain_key) WHERE chain_key IS NOT NULL;
```

Additive-only; the running (old) engine never writes `chain_key`, so applying it live at
deploy time is safe, and historical duplicate rows from the first night (all in
terminal projects) are untouched because NULLs are excluded from the index. `createTask()`
gains an optional `chain_key`; the API route does NOT expose it (only the reconciler sets
it — agents cannot forge chain keys).

## 2. Project-status gating (bug 2)

`promoteReadyTasks()` gains
`AND EXISTS (SELECT 1 FROM projects p WHERE p.id = pt.project_id AND p.status = 'active')`.
`claimReadyTasks()`'s claim SELECT gains the same predicate (JOIN form). `spawnTaskRuns()`
additionally filters claimed tasks through `projectAcceptsWork(task.project.status)` —
defense in depth in code, and the thing unit tests pin down. Semantics decided:

- Pause/block stops NEW promotion and NEW claiming. In-flight runs finish and reconcile
  (bookkeeping is not billable work; the FREEZE switch precedent in `projectTick()`
  already draws this line for fleet-pause).
- Reconciliation MAY create fix-chain tasks for a non-active project — they are inert
  `pending` rows under the gate, and the project resumes exactly where it stopped when
  Konrad flips it back to `active`. This beats dropping verdict outcomes on the floor.

## 3. Worktree-only policy + executor-safe deploy (bugs 3 + 4) — prompt architecture

Policy lives where behavior is generated: `buildPrompt()`. Three new exported prompt
constants (exported so unit tests assert on the same strings the engine emits):

- **`WORKTREE_POLICY(liveCheckout: string)`** — appended to EVERY role prompt for
  non-scratch projects: work only in the worktree; NEVER edit `<liveCheckout>` during
  build phases; never `pm2 restart forge-executor`; live-endpoint verification happens
  only via an explicitly-briefed deploy/verify task. Live checkout path derives from
  `project.repo` (`ai-os` → `/opt/forge-ai-os`, `content-forge` → `/opt/content-forge`) —
  mirror of `REPO_PATHS` in workspace.ts, moved/shared so there is one mapping.
- **`REVIEWER_LIVE_CHECK(liveCheckout: string)`** — appended to reviewer prompts
  (non-scratch): run `git -C <liveCheckout> status --porcelain`; ANY output ⇒ someone
  hot-applied ⇒ that alone is a NEEDS_FIXES finding naming the dirty files.
- **`DEPLOY_GUIDE`** — appended to the goal-mode architect prompt (and quoted in
  `docs/tools/deploy-playbook.md`): executor-loaded code (`src/lib/project-tick.ts`,
  `src/lib/cc-runner.ts`, `src/executor.ts`, `src/db/*`, `agents/*.md`) deploys via
  `setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &`
  launched detached, task ends without waiting; `pm2 restart forge-control` stays allowed
  for API-side code. GitHub guidance (see §4) rides in the same constants.

The role `.md` files in `agents/` are NOT the vehicle for this policy: they are shared
with the interactive Task-tool subagents, which legitimately operate on live checkouts
when Konrad asks. Project-context policy belongs in the project prompt builder.

## 4. GitHub integration — helper + guidance, deliberately not engine code

**`scripts/git-sync-branch.sh <worktree-dir> [--pr "<title>"]`** (bash, repo root):

1. `git -C <dir> remote get-url origin` — missing ⇒ exit 3 "no origin remote".
2. `gh auth status` — failing ⇒ exit 4 "gh not authenticated".
3. `git -C <dir> push origin HEAD` — plain push; the string `--force` appears nowhere in
   the file; a rejected push exits non-zero with git's stderr intact.
4. With `--pr`: if `gh pr list --head <branch>` is empty, `gh pr create --base <base>
   --title …` (base read from `--base` flag, default `main`); body links the project id.

Guidance (in the planner/reviewer prompt branches): on a gating reviewer's PASS for a
repo with origin, run the helper to push the branch; at project completion, the brief
decides merge vs `--pr`. Failures are reported in the reviewer's message (visible in the
run thread + Kanban) — a push failure never blocks the verdict.

## 5. Researcher lane

### 5.1 Role file `agents/researcher.md`

Frontmatter per R18 (`model: claude-opus-5`, `effort: high`, tools incl. `Skill` for
playwright/hermes browser skills — note the parser in `roleConfig()` is a plain
`tools:` line regex, so the line stays single-line comma-separated). Mission core:
research with real sources; steer a real browser for logged-in/web-app surfaces; every
claim carries a citation (URL, title, access date, quoted snippet for load-bearing
claims); output to `docs/research/*.md`; the Perplexity/gemini-qa helpers are named
instruments with their key protocol; explicit refusals: no implementation, no task
creation, no live-checkout edits. Installed by copying to `/root/.claude/agents/` —
additive; `roleConfig()`'s per-role cache only misses for never-loaded roles, so a NEW
role needs no executor restart (verified in code, project-tick.ts:84-112).

### 5.2 The `researcher` prompt branch (already live, project-tick.ts:201) stays as-is
this project only supplies the role file it reads.

## 6. External service helpers (zero-dependency node ≥ 22, built-in fetch)

### 6.1 Key resolution (shared pattern, ~15 lines duplicated per script — no shared lib,
these must stay standalone-copyable): env var → `/opt/ai-os/.secrets/store/<name>` file
(trimmed) → hard exit 2 printing BOTH locations. Never a partial run. Secret names:
`gemini-api-key`, `perplexity-api-key` (secret-store `NAME_RE`-compatible). As of
2026-08-05 recon NEITHER exists; R24's reminders tell Konrad exactly this.

### 6.2 `scripts/gemini-qa.mjs`

Flow (facts researched 2026-08-05 against ai.google.dev docs; re-verified by the phase
scout at build time):

1. Input local path → Files API resumable upload
   (`POST https://generativelanguage.googleapis.com/upload/v1beta/files`,
   `X-Goog-Upload-Protocol: resumable` start/upload/finalize), then poll
   `GET /v1beta/{file.name}` until `state: ACTIVE` (timeout 10 min ⇒ hard error).
   Input URL (incl. YouTube) → passed directly as `file_data.file_uri`.
2. `POST /v1beta/models/{model}:generateContent` (`x-goog-api-key` header), default model
   `gemini-3.6-flash` ($1.50/$7.50 per 1M; video ≈ 300 tok/s standard res), with
   `generationConfig.responseMimeType = "application/json"` +
   `generationConfig.responseSchema` = the rubric schema.
3. Print parsed JSON; schema-invalid response ⇒ hard error with raw body (no repair loop).

**QA rubric schema (the contract the video pipeline will consume later):**

```jsonc
{
  "verdict": "pass | needs_work | reject",
  "confidence": 0.0-1.0,
  "hook": { "score": 0-10, "first_seconds_analysis": "...", "notes": "..." },
  "pacing": { "score": 0-10, "dead_spots": [{ "start_s": n, "end_s": n, "note": "..." }] },
  "audio": { "score": 0-10, "glitches": [{ "at_s": n, "type": "click|dropout|desync|clipping|other", "note": "..." }] },
  "visual": { "score": 0-10, "artifacts": [{ "at_s": n, "type": "flicker|blur|caption_error|broken_asset|other", "note": "..." }] },
  "factual": { "red_flags": [{ "at_s": n, "claim": "...", "concern": "..." }] },
  "top_fixes": ["ordered, concrete, max 5"],
  "summary": "2-3 sentences"
}
```

Timestamped findings are the point — a human (or later, a repair agent) must be able to
jump to `at_s`.

### 6.3 `scripts/perplexity.mjs`

`ask` → `POST https://api.perplexity.ai/chat/completions` (Bearer auth), default
`sonar-pro` ($3/$15 per 1M + per-request search fee); emit
`{ answer, citations, search_results }` from the response fields of the same names.
`search` → the dedicated `POST /search` endpoint (`query`, `max_results` ≤ 20) emitting
`{ search_results }`. Exact endpoint paths re-verified by the phase scout at build time
(docs.perplexity.ai) — API surface drift is the risk, not the design. Browser-steering
fallback: documented manual procedure only (perplexity.ai via playwright skill), because
scraping a bot-defended SPA is exactly the fragile artifact this system refuses to own.

## 7. Failure modes (each answers: what breaks, who notices, how)

| Failure | Behavior | Konrad sees |
|---|---|---|
| Reviewer run dies (`failed`/`cancelled`) | Existing path: task `failed`, project `blocked` (unchanged; group consolidation only handles all-settled groups) | 🚫 notification + red Kanban card |
| Reviewer emits no VERDICT | Group `block(no_verdict)` | 🚫 notification naming the task |
| 3 fix cycles exhausted | Group `block(max_cycles)` | 🚫 notification |
| Tick crashes mid-consolidation | Re-runs next tick; `chain_key` conflict guard absorbs replays; reviewers still `running`-with-settled-run so the group re-evaluates | nothing (self-heals), log line |
| Two ticks overlap (defensive) | Claim path already `FOR UPDATE SKIP LOCKED`; consolidation inserts are conflict-guarded | nothing |
| Project paused mid-round | In-flight runs finish; nothing new promotes/claims; resumes on `active` | Kanban status + (existing) heartbeat wording |
| gemini/perplexity key missing | Tool exits 2 with both locations; build task queued a reminder | ⏰ reminder + tool stderr |
| Gemini file stuck processing | 10-min poll timeout ⇒ hard error, non-zero exit | tool stderr (and phase reviewer) |
| Push rejected (non-FF) | Helper exits non-zero, never forces; reviewer reports it | reviewer message in run thread |
| Executor restart needed post-deploy | Detached safe-restart waits for fleet idle (≤ 12h, 45s quiet) | safe-restart log + eventual restart; deploy task's final message says it was launched |

## 8. Observability

Unchanged surfaces, richer content: Kanban board (`GET /api/projects/board`) shows the
single fix chain instead of duplicate chains; goal heartbeats keep firing every
`checkin_hours`; every block path already notifies. New: consolidation logs one line per
group decision (`[project-tick] round R reviewers → fix cycle c` etc.) — grep-able in
executor logs; the helpers are CLIs whose stdout/stderr land in run threads.

## 9. Technology choices (one line each)

- **Pure-function module + node:test** — matches `account-health.ts` precedent; no framework.
- **Partial unique index on `chain_key`** — DB-enforced idempotency without mutating
  historical rows; NULL-excluded so migration is additive.
- **Prompt constants exported from project-tick.ts** — policy testable as data, single source.
- **Bash for git helper** — it is five git/gh commands; a TS wrapper would add nothing.
- **Zero-dep `.mjs` CLIs** — standalone-copyable, no lockfile churn, node 22 fetch suffices.
- **`gemini-3.6-flash` default** — current video-leaderboard flash model at flash pricing;
  flag-overridable.
- **`sonar-pro` default** — citation-bearing search quality over base `sonar`; flag-overridable.

## 10. Rejected alternatives (one line each)

- **Advisory lock / serialize whole tick** — tick is already effectively serial; the real
  bug is group-blindness, not concurrency.
- **Forbid parallel reviewers in prompts** — prompt-only guarantees are what just failed;
  fix the reconciler, keep parallel review legal.
- **Unique index on `(project_id, round, role, fix_cycle)`** — collides with historical
  duplicate rows and overloads `fix_cycle` semantics; a dedicated `chain_key` is explicit.
- **Cancel in-flight runs on pause** — destructive semantics hiding behind a status flip;
  cancellation stays an explicit per-run act.
- **Engine-side automatic git push on PASS** — puts shelling-to-git (auth, network, hooks)
  inside the tick's failure domain for a cosmetic feature; guidance + helper keeps the
  tick pure bookkeeping.
- **Researcher policy inside agents/*.md role files** — those files are shared with
  interactive subagents that legitimately touch live checkouts; project policy belongs in
  buildPrompt().
- **npm SDKs (@google/genai etc.) for the helpers** — dependency + lockfile churn for two
  HTTP calls; raw fetch is smaller than the SDK's README.
- **Building Perplexity browser scraping** — fragile, bot-defended, unmaintainable;
  documented manual fallback only.
