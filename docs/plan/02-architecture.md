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
  `chain_key = fix:R:c`) and re-reviewer (round+2, `chain_key = rereview:R:c`), both with a
  **bare `ON CONFLICT DO NOTHING`** — no conflict target (amended R308). A chain row is
  subject to TWO unique indexes, `project_tasks_chain_key_uniq` (ours, 0039) and
  `project_tasks_identity_idx` (`main`'s, 0035, already live); naming either one leaves
  the other as an unhandled `unique_violation` that aborts the transaction and freezes the
  round. Commit; THEN mark all group reviewers `done`. Crash after commit but before
  mark-done ⇒ next tick recomputes `fix`, the conflict guard absorbs the duplicate
  inserts, mark-done proceeds. Order matters: creating tasks before marking reviewers done
  means `promoteReadyTasks` can never see a fully-done round R with the fix round missing
  (which would wrongly promote round-R+100 phase planners past an unfinished fix cycle).
- Because `DO NOTHING` reports zero rows whichever index fired, `insertChainRow()` then
  looks the row up and CLASSIFIES the conflict: `replay` (the existing row carries our
  chain_key — our own chain, safe) vs `occupied` (a stranger holds our identity tuple, so
  its brief is not the feedback we merged). On `occupied` the `fix` branch blocks the
  project and names the offending task instead of reporting an absorbed replay — the
  alternative drops a reviewer round's verdict in silence. Evidence:
  `docs/plan/evidence/0039-conflict-target.md` §B.

Non-reviewer settled tasks keep the existing per-task path untouched.

### 1.3 Data model — migration `db/migrations/0039_reviewer_chain_key.sql`

```sql
ALTER TABLE project_tasks ADD COLUMN chain_key text;   -- NULL for everything historical
CREATE UNIQUE INDEX project_tasks_chain_key_uniq
  ON project_tasks (project_id, chain_key) WHERE chain_key IS NOT NULL;
```

Additive-only; the running (old) engine never writes `chain_key`, so applying it live at
deploy time is safe, and historical duplicate rows from the first night (all in
terminal projects) are untouched because NULLs are excluded from the index. `chain_key` is
written by `createFixChain()` and by NOTHING else — `createTask()` deliberately does not
accept it (amended R308: a second writer arbitrating on identity alone would raise
`unique_violation` on exactly the replay it was meant to absorb), and the API route does
not expose it, so agents cannot forge chain keys.

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
creation, no live-checkout edits.

**AMENDED at R502** (surfaced by `docs/plan/evidence/p5-integration-sweep.md` must-fix 7).
The original text read: "Installed by copying to `/root/.claude/agents/` — additive;
`roleConfig()`'s per-role cache only misses for never-loaded roles, so a NEW role needs no
executor restart (verified in code, project-tick.ts:84-112)." That contradicts R19's strike
and R306's repo fallback: the `cp` into `/root/.claude/agents/` is a path the agent harness
guards, so no task of this project could ever perform it. **As shipped:** `roleFilePaths()`
(`forge-control/src/lib/project-tick.ts:185-187`) resolves a role in order
`${AGENTS_DIR}/<role>.md` then `${REPO_AGENTS_DIR}/<role>.md`, so a role file committed to
`agents/` in the repo self-installs — no copy, no human step — at the first post-deploy
executor restart. `roleConfig()`'s per-role cache still means the running executor keeps
whatever it loaded first, which is why R20's smoke run is gated behind P6's restart.

### 5.2 The `researcher` prompt branch (already live, project-tick.ts:201) stays as-is
this project only supplies the role file it reads.

**AMENDED at R703 (2026-08-05) — the branch no longer stays as-is.** As written it said only
"use every research surface you have (web search/fetch, browser automation skills, external AI
services named in your brief)", which is a surface an agent cannot act on: nothing in it names
a command. It now appends the exported constant `RESEARCH_INSTRUMENTS`
(`forge-control/src/lib/project-tick.ts`) — the three CLIs with real invocations, the screenshot
convention, and the login-wall protocol (§5.3). It is deliberately terse: this text is prepended
to *every* researcher run. The constant is exported so `project-tick.test.ts` (T16) asserts
against the engine's own output rather than a hand-copied substring, and T16 additionally
executes each named script's `--help` so a quoted invocation cannot drift from what shipped.

### 5.3 The browser research lane (R701–R703)

Built in phase 7 after Konrad's constraint "no API keys": the way to reach a logged-in service
is a real browser he has logged into once, by hand. Full reference:
`docs/tools/research-browser.md` (and `docs/tools/perplexity.md` §browser backend). The design
facts the rest of the corpus depends on:

- **Profiles.** `/opt/ai-os/browser-profiles/<profile>/` is a Chrome `user-data-dir`, mode
  0700, holding session cookies and Chrome's own profile state and **nothing else** — no
  credential of any kind is written there or anywhere else. This tool's own bookkeeping (pids,
  logs, the pinned display, the last login evaluation, the request/response queue) lives
  *outside* the profile, in `/opt/ai-os/browser-profiles/.state/<profile>/`, so that sentence
  stays literally true. Profile names match `/^[a-z0-9][a-z0-9-]{0,38}$/`; the dot is excluded
  so a profile can never collide with `.state`. Profiles are SHARED and long-lived — one per
  service (`perplexity`), plus `scratch` for one-off pages. A per-run profile would be a
  per-run login wall.
- **Takeover stack.** `Xvfb` → optional `openbox` → `x11vnc` → `websockify` serving
  `/usr/share/novnc/vnc.html`, one display pinned per profile. **`x11vnc` binds `-localhost`
  and `websockify` binds `127.0.0.1` explicitly; the VNC surface is NEVER exposed on a public
  interface.** Konrad reaches it through an SSH tunnel the tool prints for him
  (`ssh -N -L <port>:127.0.0.1:<port> root@65.108.6.149`). Rebinding it to `0.0.0.0` would put
  an unauthenticated desktop that owns his logged-in sessions on the open internet; there is no
  configuration flag for it and there must never be one.
- **Login handshake.** A wall is detected from the `SERVICES` signal table, not guessed. On one,
  the tool screenshots the wall, brings the takeover stack up, queues Konrad a reminder (deduped
  — `docs/tools/research-browser.md` §9.1), leaves the browser running and exits **4**. Exit 4
  means "needs Konrad", not "broke". The agent's contract is: report it, continue with what it
  can still reach, and **never attempt credentials** — no password, no email code, no signup.
  Konrad logs in ONCE per service; the cookie jar in the profile carries every later run.
- **Screenshot convention (a contract with the operator-visibility project).**
  `/opt/ai-os/uploads/<run_id>/<compact-ISO8601>-<label>.png`, served by forge-control at
  `/api/uploads/<run_id>/<name>`, and referenced in `docs/research/*.md` by that URL so the
  Console renders it inline. `<run_id>` resolves as `--run-id`, else `$FORGE_RUN_ID`, else the
  12-hex sentinel `deadbeefcafe`. This project builds **no UI** for it — that repo is the
  operator-visibility project's (`forge-control-web/**` is untouched here).
- **The linchpin, fixed at R703: `FORGE_RUN_ID` did not exist.** Every screenshot path above
  hangs off one environment variable, and `cc-runner.ts` never set it — verified by reading the
  env of a live run's own child process, which had no `FORGE_*` at all. Every screenshot the
  lane took would have landed in the shared `deadbeefcafe` bucket, untraceable to the run that
  took it. `runClaudeCode()` now takes `runId` (passed by `executor.ts` from the claimed run)
  and exports **`FORGE_RUN_ID`** = the run UUID's first 12 hex characters, plus
  **`FORGE_RUN_UUID`** = the id verbatim. The truncation is not cosmetic: `GET /api/uploads/:id`
  gates the id on `/^[a-f0-9]{12}$/` and 400s anything else, so exporting the raw UUID would
  produce screenshots on disk whose URLs never resolve (`docs/tools/research-browser.md` §5.1
  calls a UUID-shaped run id "the realistic case" and flags it `url_servable: false`). The
  prefix is also what executor log lines already print (`run ece63bdb…`), so a directory stays
  greppable back to its run. When a caller has no run, both variables are *deleted* from the
  child env rather than inherited — a stale id would file one run's screenshots under another's.
  Covered by T17 (`forge-control/src/lib/cc-runner.test.ts`), which spawns a stub `CC_BIN` and
  reads what the child actually received.
- **The `auto-browser` MCP controller does not exist on this host — settled, do not
  re-litigate.** The `auto-browser` SKILL.md documents a controller on `http://127.0.0.1:8000`
  with noVNC on `:6081`; that file lives inside a Hermes docker volume and describes a
  *different machine*. Verified independently at R701 and again at R703 (2026-08-05): both
  ports return connect-failure (`http_code 000`), there is no `/opt/auto-browser`, and
  `mcpServers` in `/root/.claude.json` is `{}` — an empty object, i.e. no MCP server is
  configured for this account at all. Anything that needs a browser here goes through
  `scripts/research-browser.mjs`, which reimplements the skill's *semantics* (named profile,
  save and reuse, takeover URL) on what is actually installed. One-line check before trusting
  this paragraph: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/docs`.

## 6. External service helpers (zero-dependency node ≥ 22, built-in fetch)

### 6.1 Key resolution (shared pattern, ~15 lines duplicated per script — no shared lib,
these must stay standalone-copyable): env var → `/opt/ai-os/.secrets/store/<name>` file
(trimmed) → hard exit 2 printing BOTH locations. Never a partial run. Secret names:
`gemini-api-key`, `perplexity-api-key` (secret-store `NAME_RE`-compatible). As of
2026-08-05 recon NEITHER exists; R24's reminders tell Konrad exactly this.

### 6.2 `scripts/gemini-qa.mjs`

**AMENDED at R702 (2026-08-05) — the Gemini Pool is now the PRIMARY backend; the official
API below is retained as an optional SECONDARY.** Konrad has no personal Gemini key and does
not want to buy one, so the default path must ride pool-account entitlements. The flow
described in 1–3 below is unchanged but now sits behind `--backend api`; the new default is
`--backend pool`:

- **Pool path:** `POST http://127.0.0.1:8090/v1/analyze`, `multipart/form-data` with fields
  `prompt` (string) + `file` (binary), header `x-api-key` → `{"text": string,
  "account": string}`. Internal address only — the public route caps bodies at 200 MB and
  reads at 120 s, and answers 413 with nginx **HTML**, which a real video analysis would hit.
- **Credential, and the trap:** the pool token resolves env `GEMINI_POOL_API_KEY` →
  `/opt/ai-os/.secrets/store/gemini-pool-api-key` → the `GEMINI_API_KEY=` line inside
  `/opt/gemini-pool-api/.env`; exit 2 names all three. ⚠ That third location calls the pool's
  own caller token `GEMINI_API_KEY` — **the same name §6.1's api path uses for a Google AI
  Studio key, for an unrelated credential.** They are kept strictly apart: the pool is never
  read from `process.env.GEMINI_API_KEY`.
- **No structured output on the pool.** It returns free text, so the frozen rubric below is
  requested in words and then *extracted* (fence-stripping, then a string-aware
  brace-balanced scan) and validated. Unparseable, non-object, or missing a required key ⇒
  exit 1 printing the model's raw text verbatim. **Extraction only — never repair.**
- **No automatic fallback between backends, not even opt-in.** R702's brief permits one only
  if pool failures are cleanly distinguishable; `docs/research/round-701-33d8cba3.md` §6
  proves they are not (dead account, bad file and transient fault all return the same opaque
  500 / code 1100). A fallback on an undiagnosable error would quietly ship a video to a
  billed endpoint.
- **Model is unselectable on the pool** (the wrapper never passes `model=`), so `--model` is
  rejected there with exit 3 rather than accepted and ignored. QA verdicts consequently ride
  whatever the pool account's web-UI default is — a stated property of the free path.
- **New exit code 4** for pool 503 (no session inside the wrapper's own 60 s acquire window)
  and 429 (~300 s account cooldown) — the only failures worth retrying later. No retry loop
  in the tool. Timeout is `--timeout`, default 900 s.
- **URL inputs are a usage error on the pool** (exit 3): `/v1/analyze` takes an upload, not a
  URI, and a YouTube watch URL is an HTML page. Documented in `--help` and
  `docs/tools/gemini-qa.md` §3.1; `--backend api` remains the URL path.

**Status at amendment time — the pool cannot yet serve this tool.** Measured 2026-08-05
between 19:00 and 20:44 CEST: `POST /v1/chat` (text) returned 200 at 19:00 but 500/code 1096
about a quarter of an hour later, and again at 20:39 — the pool flaps on text — while
`POST /v1/analyze` with a file returned 500/code 1100 on all three attempts (1.3 MB
`video/mp4` twice, 1.5 h apart, and a 40-byte `text/plain` control) — so the
**file-attachment path fails for every file type**, which is narrower than R701's "the
account cannot generate at all" and independent of video. Six generation attempts this round,
one success, text-only. `GET /health` reported `sessions_ready: 4` throughout. The backend is implemented and correct
against the documented wire contract; what it needs is pool-side re-auth (see
`docs/tools/gemini-qa.md` §1.2 and §9).

Flow of the **api** backend (facts researched 2026-08-05 against ai.google.dev docs;
re-verified by the phase scout at build time):

1. Input local path → Files API resumable upload
   (`POST https://generativelanguage.googleapis.com/upload/v1beta/files`,
   `X-Goog-Upload-Protocol: resumable` start/upload/finalize), then poll
   `GET /v1beta/{file.name}` until `state: ACTIVE` (timeout 10 min ⇒ hard error).
   Input URL (incl. YouTube) → passed directly as `file_data.file_uri`.
2. `POST /v1beta/models/{model}:generateContent` (`x-goog-api-key` header), default model
   `gemini-3.6-flash` ($1.50/$7.50 per 1M; video ≈ 300 tok/s standard res) —
   **AMENDED at R502 to `gemini-omni-flash` ($1.50/$9.00 per 1M; video 5,792 tok/sec),
   per `docs/research/round-399-41e8757d.md`: `gemini-3.6-flash` does not accept video
   input at all, so it cannot be this tool's default** — with
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
jump to `at_s`. **This schema is unchanged at R702 and is identical on both backends** — the
rubric is a frozen contract, not a per-backend shape, and it does not get looser because the
free path produced it.

### 6.3 `scripts/perplexity.mjs`

**AMENDED at R702 (2026-08-05) — browser-first, no API key. The `ask` default backend is now
the authenticated browser profile; the API path below is retained unchanged as an optional
`--backend api`.** Konrad has no Perplexity API key and will not buy one (stated 2026-08-05
~09:30): Perplexity is a browser service for him. So `ask` defaults to `--backend browser`,
which drives `perplexity.ai` inside the shared `perplexity` profile owned by R701's
`scripts/research-browser.mjs` — navigate, submit, wait for streaming to settle, extract the
answer **and its numbered citations**. `search` stays API-only; there is no browser surface for
it that this tool is willing to scrape.

- **This overrules §10's "Building Perplexity browser scraping — fragile, bot-defended,
  unmaintainable" and the last sentence of the original §6.3 text below.** The judgement was
  correct and is **not** withdrawn; a constraint overrides it. The response is to MITIGATE, and
  the mitigations are load-bearing, not decorative: EVERY DOM selector lives in ONE marked
  table at the top of the script (nothing else in the file, and nothing in
  `research-browser.mjs`, knows Perplexity's markup); selection prefers `data-testid` /
  `aria-label` / element semantics over class-name soup; citation harvest is anchor-based, not
  layout-based; and a missed selector, an unsettled stream or zero extracted citations are
  **hard errors with a screenshot and a page-text excerpt**. No partial answer is ever emitted
  as if it were complete. `--dump-capture` re-cuts the parser fixture in one command.
- **No credential is stored anywhere.** The browser path reads no key, types no password and
  prompts for nothing. Session cookies live **only** inside Chrome's `user-data-dir` at
  `/opt/ai-os/browser-profiles/perplexity/` (mode 0700). Konrad logs in ONCE, by hand, in a
  real Chrome window over a loopback-only noVNC session reached through an SSH tunnel.
- **New exit code 4 = NEEDS LOGIN**, deliberately the same number as
  `research-browser.mjs`'s `LOGIN_REQUIRED` (asserted at import time). On a wall the tool
  screenshots what it saw, hands the handshake to the harness — which queues the reminder,
  brings up noVNC and leaves the browser running — prints what Konrad must do, and exits 4.
  It never attempts a login. This is the expected first-run outcome, not a failure.
- **Bot wall ≠ login wall.** A Cloudflare interstitial is waited out (`--challenge-timeout`,
  default 90 s) and then, if it persists, is a hard exit 1 with a screenshot and **no
  reminder** — logging in cannot fix a challenge page. Before exiting it parks a headed browser
  on the page via the harness so a human can look at it over noVNC.
- **Screenshots** follow R701's contract verbatim: `/opt/ai-os/uploads/<run_id>/<stamp>-<label>.png`,
  with both the absolute path and the `/api/uploads/<run_id>/<name>` URL in stdout JSON.
- **Output contract:** the R502 keys (`answer`, `citations`, `search_results`, `model`,
  `usage`) are preserved on both backends; the browser adds `backend`, `needs_login`,
  `sources`, `screenshots`, `extraction`, `bot_challenge`, `stream`, `takeover`, `profile`,
  `run_id*`, `lock_actions`. On the browser path `model` and `usage` are `null` — the web UI
  discloses neither — and `search_results` entries carry `{url,title}` only. Documented in
  `docs/tools/perplexity.md` §4.
- **Status at amendment time: not yet usable, for a reason the mitigations predicted.** Nobody
  has logged into the automation browser, so the acceptance target was the exit-4 login wall —
  but on this box Perplexity's Cloudflare managed challenge does not clear at all (HTTP 403,
  "Performing security verification", verified 2026-08-05 through both this tool and the R701
  harness), so runs stop one step earlier at the documented exit-1 bot wall. Details and the
  open question in `docs/tools/perplexity.md` §12.

**AMENDED at R502 — this whole subsection is superseded by `docs/research/perplexity-api.md`
(commit d870320); see 01-requirements R22's amendment for the binding text.** Sonar Chat
Completions was deprecated in July 2026 and `POST /v1/chat/completions` returns 404; there
is no `perplexity/sonar-pro` slug. As shipped: `ask` → `POST https://api.perplexity.ai/v1/agent`
(Bearer auth), default `perplexity/sonar`, emitting
`{ answer, citations, search_results, model, usage }` — `citations` derived, not
vendor-supplied; `search` → `POST https://api.perplexity.ai/search` emitting
`{ search_results }`. The Agent API rejects any unknown request field with a hard HTTP 400,
so the body is an explicit whitelist. The original text follows, kept for the audit trail:

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
  flag-overridable. **AMENDED at R502: the shipped default is `gemini-omni-flash` —
  `gemini-3.6-flash` does not accept video input (`docs/research/round-399-41e8757d.md`).**
- **`sonar-pro` default** — citation-bearing search quality over base `sonar`; flag-overridable.
  **AMENDED at R502: the shipped default is `perplexity/sonar` on the Agent API; no
  `sonar-pro` slug exists (`docs/research/perplexity-api.md`, commit d870320).**

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
  documented manual fallback only. **AMENDED at R702 (2026-08-05): overruled by Konrad's
  constraint — no API key, ever — so it is now the DEFAULT `ask` path. The three risks named
  here stand and are mitigated explicitly (one selector table, semantic-first locators, loud
  failure with a screenshot, never a partial answer); see §6.3's R702 amendment.**
