# Evidence — P5 integration sweep (round 501, sweep A)

Coherence audit of the whole branch `project/4120f785` against
`docs/plan/01-requirements.md`. Nothing is deployed; Phase 6 owns the deploy.
Every status below carries evidence I read or ran with my own tools in this run —
a `file:line`, a test name from the suite, or a command with its pasted output.

Head under audit: `bc0b3fa`. Diff: `git diff --stat main...HEAD` = 39 files,
9175 insertions, 827 deletions; `git log --oneline main..HEAD` = 28 commits.

Worktree state at the time of the sweep (a sibling round-501 task owns
`docs/tools/*.md` and had `deploy-playbook.md` open):

```
$ git status --porcelain
 M docs/tools/deploy-playbook.md
```

---

## 1. Requirements matrix

| # | Status | Evidence |
|---|---|---|
| R1 | SATISFIED | `forge-control/src/lib/project-reconcile.ts:196`; `project-tick.ts:589`; test `T5 unsettled sibling` (`project-reconcile.test.ts:217`) |
| R2 | SATISFIED | `project-reconcile.ts:210-234`, `mergeFeedback` at `:248`; test `T3 dual NEEDS_FIXES` (`project-reconcile.test.ts:129`) |
| R3 | SATISFIED | `project-reconcile.ts:196` (before any parse), `:238`; test `T4 mixed and all-PASS` (`project-reconcile.test.ts:173`) |
| R4 | SATISFIED | `project-reconcile.ts:47` (`/gi`), `:49-63`; test `T1 parseVerdict` (`project-reconcile.test.ts:45`) |
| R5 | SATISFIED | `project-reconcile.ts:199-207`; `project-tick.ts:637-670`; test `T6 unparseable verdict` (`project-reconcile.test.ts:252`) |
| R6 | SATISFIED | `project-reconcile.ts:215-225`; `project-tick.ts:71` (`MAX_FIX_CYCLES = 3`); test `T7 max cycles and cycle arithmetic` (`project-reconcile.test.ts:288`) |
| R7 | SATISFIED | `db/migrations/0039_reviewer_chain_key.sql:16-18`; `db/projects.ts:728-786` (`insertChainRow`), `:823-868` (`createFixChain`); `project-tick.ts:672-732` (chain first, mark-done second); tests `T9 chainKeys determinism` (`:365`), `T15 createFixChain conflict arbitration` (`:479`) |
| R8 | SATISFIED | `db/projects.ts:438-455`, clause `AND p.status = 'active'` at `:444` |
| R9 | SATISFIED | `db/projects.ts:471-490`, clause `AND p.status = 'active'` at `:483`; `FOR UPDATE OF pt SKIP LOCKED` at `:486` |
| R10 | SATISFIED | `project-reconcile.ts:78-80`; belt in `project-tick.ts:486-492`; test `T8 projectAcceptsWork` (`project-reconcile.test.ts:339`) |
| R11 | SATISFIED | Full gate, §5 below: `npx tsc --noEmit` clean, `pnpm test` 167/167 pass, 0 fail, 36 suites |
| R12 | SATISFIED | `project-tick.ts:288-302` (`WORKTREE_POLICY`), applied via `withPolicy` at `:360-361` wrapping every role branch; tests `T10 prompt policy` cases at `project-tick.test.ts:72`, `:84`, `:96` |
| R13 | SATISFIED | `project-tick.ts:307-316` (`REVIEWER_LIVE_CHECK`), wired at `:461`; test `project-tick.test.ts:120` ("reviewer prompt carries the live-checkout cleanliness check; builder and planner do not") |
| R14 | SATISFIED | `project-tick.ts:321-336` (`DEPLOY_GUIDE`), wired at `:398`; `docs/tools/deploy-playbook.md`; test `project-tick.test.ts:138` ("goal-mode architect prompt carries DEPLOY_GUIDE with the detached-restart contract") |
| R15 | SATISFIED | `scripts/git-sync-branch.sh:121` (`git push origin HEAD`); `grep -c force scripts/git-sync-branch.sh` = **0**; push proven by `git ls-remote`; no-origin exit 3 re-proven below |
| R16 | SATISFIED | `project-tick.ts:341-349` (`GITHUB_PUSH_GUIDE`), wired into planner `:431` and reviewer `:461`; test `project-tick.test.ts:169` ("GITHUB_PUSH_GUIDE appears in planner and reviewer prompts for repo 'ai-os', absent for 'scratch'") |
| R17 | SATISFIED | `DEPLOY_GUIDE` merge-vs-PR paragraph, `project-tick.ts:333-336`; `scripts/git-sync-branch.sh:146` (`gh pr create --base … --head …`); test `project-tick.test.ts:160` (regression guard: the old contradictory PR paragraph is gone) |
| R18 | SATISFIED | `agents/researcher.md:1-7` frontmatter (8 tools, `claude-opus-5`, `high`); tests `T11 researcher frontmatter parse` (`project-tick.test.ts:238`), `T13 role file resolution + install parity` (`:281`), `T14 parseRoleFile robustness` (`:359`) |
| R19 | **STRUCK** | `01-requirements.md:127-134`; `03-quality.md:145-153`; superseded by `roleFilePaths()` at `project-tick.ts:185-187` |
| R20 | **NOT-DUE** (P6) | `04-phases.md:118-123`; `03-quality.md:155-162` |
| R21 | **DIVERGED** | Requirement pins `gemini-3.6-flash` (`01-requirements.md:155`); shipped default is `gemini-omni-flash` (`scripts/gemini-qa.mjs:72`). Also a stale cross-reference: R21 says "rubric in 02-architecture §5", the rubric is at §6.2 (`02-architecture.md:201`) |
| R22 | **DIVERGED** | Requirement describes Sonar chat completions + `sonar-pro` (`01-requirements.md:157-160`); shipped helper targets the Agent API `POST /v1/agent` with `perplexity/sonar` (`scripts/perplexity.mjs:26,29`) |
| R23 | SATISFIED | Live runs below: no-key exit **2** naming both locations for both tools; invalid key surfaces the API's status + body verbatim, exit **1** |
| R24 | SATISFIED | `GET /api/reminders` — ids `4c4532af-…` and `c88f6e19-…`, both pending, both naming the key and both locations (quoted below) |
| R25 | SATISFIED | `docs/tools/gemini-qa.md`, `docs/tools/perplexity.md`; flag sets cross-checked against live `--help` output (below) |
| R26 | SATISFIED | This document + the gate in §5 |
| R27 | **DEFECT** | `AI OS/Operator Log.md` appended (2026-08-05 midday entry, R308) and `docs/tools/deploy-playbook.md` exists — but `AI OS/Goal Mode Design.md` has **not** been appended (29 lines, mtime `Aug 5 00:49`, predates all of this project's work) |
| R28 | **NOT-DUE** (P6) | `01-requirements.md:195-202`; `04-phases.md:106-125` |
| N1 | SATISFIED | `git diff main...HEAD -- '**/package.json' 'pnpm-lock.yaml'` prints nothing (pasted below) |
| N2 | SATISFIED | Boundary grep exits 1 with no output (pasted below) |
| N3 | SATISFIED | Every added `catch` in `project-tick.ts` is either a notification-queue `.catch(() => {})` (explicitly permitted) or an escalating path; `readRoleFile` throws on unreadable-but-present (`project-tick.ts:198-205`); `insertChainRow` throws on an unexplained conflict (`db/projects.ts:780-786`) |
| N4 | **DEFECT** | Text still reads "0035 is additive-only …" (`01-requirements.md:212`) while the shipped migration is `db/migrations/0039_reviewer_chain_key.sql` |
| N5 | SATISFIED | `git -C /opt/forge-ai-os status --porcelain` empty (pasted below); live DB has no `chain_key` column, so 0039 has not been applied early |

### Per-requirement notes

**R1 — group settlement.** `consolidateReviewerRound` returns `{action:"wait"}` the moment
any member has `settled: false`, and it does so at `project-reconcile.ts:196`, *before* a
single verdict is parsed. `project-tick.ts:589` is where settlement is computed:
`settled: r.run_status === "completed"` — `null` (no run yet), `running`, `failed` and
`cancelled` all fall to `false`, so a broken round waits rather than folding a verdict it
cannot honestly compute. The `wait` branch (`project-tick.ts:596-605`) marks nothing done,
so `listSettledRunningTasks()` re-surfaces the same reviewers next tick.

**R2 — one fix chain per round.** The `fix` arm builds exactly one builder title and one
re-review title from `chainKeys(round, cycle)` and hands both to a single `createFixChain`
call (`project-tick.ts:682-692`), which inserts both rows in one transaction. `mergeFeedback`
(`project-reconcile.ts:248-262`) emits one `## Feedback from: <title>` section per
NEEDS_FIXES reviewer with `lastText` untruncated, in source order — and
`listReviewerRound` orders by `pt.created_at ASC` (`db/projects.ts:695`), which is what
makes the merged brief byte-identical across replays.

**R3 — PASS never races NEEDS_FIXES.** The race is dead by construction, not by tie-break:
rule (b) fires before rule (c)/(d), so a settled PASS with an unsettled sibling produces no
decision at all. Once the group is whole, `needsFixes.length > 0` wins over any number of
PASSes (`project-reconcile.ts:211`).

**R4 — verdict parsing.** `VERDICT_RE` is `/VERDICT:\s*(PASS|NEEDS_FIXES)/gi` with `matchAll`
keeping the last capture (`project-reconcile.ts:47-63`). `lastIndex` is reset per call —
a module-level `/g` regex is stateful and would otherwise skip alternate calls.

**R5 — unparseable verdict blocks.** Any `verdict === null` in a settled group yields
`block(no_verdict)` naming every offending task title. The caller writes
`setProjectStatus(projectId,"blocked")` and sends the notification *before*
`markGroupDone` (`project-tick.ts:658-668`) — the stop-work state is committed first, so a
crash in the window cannot let `promoteReadyTasks()` walk past an unjudged round.

**R6 — fix-cycle ceiling.** `maxCycle` is taken over the whole group, not just the
dissenters (`project-reconcile.ts:215`), so a hand-added reviewer at a lower `fix_cycle`
cannot drag the next cycle backwards onto a chain key that already exists.

**R7 — idempotent, crash-safe creation.** Migration 0039 is `ALTER TABLE project_tasks ADD
COLUMN chain_key text` plus `CREATE UNIQUE INDEX project_tasks_chain_key_uniq ON
project_tasks (project_id, chain_key) WHERE chain_key IS NOT NULL` — additive, NULL for
every historical row. See §4f for the conflict-classification audit.

**R8 / R9 / R10 — status gating.** Both SQL gates are present and identical in form
(`p.status = 'active'`). The TS-side belt in `spawnTaskRuns()` hands a task back to `ready`
rather than dropping it, so pausing a project cannot strand rows.

**R11.** See §5.

**R12 — worktree-only rule.** Generated in `project-tick.ts` rather than written into
`agents/<role>.md` because those role files are shared with the interactive Task-tool
subagents, which legitimately work on live checkouts. `withPolicy()` wraps *every* return
of `buildPrompt` including the fallthrough at `:472`, so a future role branch cannot forget
it. `liveCheckoutPath()` (`forge-control/src/lib/workspace.ts:28-30`) returns `null` for
`scratch`, which is what suppresses all three policy blocks there.

**R13.** The reviewer prompt is the only branch that gets `REVIEWER_LIVE_CHECK`, and the
text demands the output be pasted into the review ("an unexecuted check is not a check").

**R14.** `DEPLOY_GUIDE` names the four executor-loaded paths, forbids
`pm2 restart forge-executor` in three separate sentences, and gives the exact
`setsid nohup … safe-restart.sh forge-executor 43200 45 … &` line.

**R15 — push helper.** Force-free by construction, verified twice:

```
$ grep -c force scripts/git-sync-branch.sh
0
```

The push path is proven live — origin carries the branch:

```
$ git remote -v
origin	git@github.com:konradschrein-star/AI-Operating-System.git (fetch)
origin	git@github.com:konradschrein-star/AI-Operating-System.git (push)
$ git ls-remote origin 'refs/heads/project/4120f785'
17a30aa91ac8074d11f0533f6f4e36e8e0a23c3b	refs/heads/project/4120f785
```

Note the remote tip is `17a30aa` while local `HEAD` is `bc0b3fa` — **11 commits behind**.
The helper works; the P5 deliverable "final branch push" (`04-phases.md:95`) has not been
executed. Recorded as must-fix 4.

The no-origin contract re-proven in a throwaway dir (not the worktree):

```
$ rm -rf /tmp/p5-noorigin && mkdir -p /tmp/p5-noorigin && cd /tmp/p5-noorigin \
  && git init -q -b work . && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init \
  && /opt/ai-os/.../scripts/git-sync-branch.sh /tmp/p5-noorigin
git-sync-branch.sh: no origin remote in /tmp/p5-noorigin
exit=3
```

Matches the documented exit table at `scripts/git-sync-branch.sh:28`.

**R16 / R17.** Both are prompt guidance, deliberately not engine code
(`02-architecture.md` §4, rejected alternatives). The PR path is exercised only as far as
`gh pr create` argument construction; no PR was opened, which is correct — this project's
brief says merge.

**R18 — researcher role file.** Frontmatter parses under the engine's own
`parseRoleFile()`, and T13 additionally asserts the engine's *resolution order*
(`${AGENTS_DIR}/<role>.md` then `${REPO_AGENTS_DIR}/<role>.md`) finds a real definition
rather than the bare fallback. The file names both helpers as instruments with their key
protocol (`agents/researcher.md:22-25`) and carries explicit refusals (`:32-36`).

**R19 — STRUCK, and correctly so.** It required a human `cp` into `/root/.claude/agents/`,
which the agent harness guards as a sensitive path — so *no task of this project could ever
satisfy it*, and three rounds (R302–R304, `docs/plan/evidence/p3-smoke.md`) were spent
discovering that. R306's `roleFilePaths()` fallback removed the need entirely: a role file
committed to `agents/` self-installs from `REPO_AGENTS_DIR` at the first post-deploy
executor restart. The strike is recorded in the requirement itself with a visible
"STRUCK at R308 — superseded by" note (`01-requirements.md:127`), in the phase table
(`04-phases.md:68,138`) and in `03-quality.md:145-153`. Konrad is owed nothing; the
reminder asking for the `cp` was cancelled. This is the corpus precedent for how R21/R22
should be amended — an annotated supersession, never a silent rewrite.

**R20 — NOT-DUE, owned by P6.** What P6 must still do, exactly: *after* step 4's detached
`safe-restart.sh` has landed (not before — the pre-restart engine has no repo fallback and
would cache the bare mission for the executor's lifetime), create a scratch-repo project
whose brief tells its round-0 architect at tier `fast` to create exactly ONE researcher
task and stop; the researcher run must complete and commit a `docs/research/*.md` with ≥ 3
cited sources; the phase reviewer spot-checks ≥ 2 URLs against the claims made; executor
logs must show no `no agent definition for role researcher` warning; the scratch project is
then closed (status → done/cancelled via the API).

**R21 — DIVERGED.** See §4b. The shipped default is right and the requirement is stale.

**R22 — DIVERGED.** See §4c. Same shape: shipped behaviour is right, requirement text is
pre-research.

**R23 — key protocol.** Neither key exists:

```
$ ls /opt/ai-os/.secrets/store/ | grep -iE "gemini|perplex|google"
(no output)
```

No-key path, both tools:

```
$ env -u GEMINI_API_KEY node scripts/gemini-qa.mjs /tmp/nope.mp4
gemini-qa.mjs: no Gemini API key found.
  Set the environment variable GEMINI_API_KEY, or write the key to the secret-store file /opt/ai-os/.secrets/store/gemini-api-key.
  Key name: GEMINI_API_KEY (secret-store name: gemini-api-key).
  No request was made.
exit=2

$ env -u PERPLEXITY_API_KEY node scripts/perplexity.mjs ask "test"
No Perplexity API key found. Nothing was sent.
Set the key named PERPLEXITY_API_KEY in ONE of these two locations:
  1. environment variable: PERPLEXITY_API_KEY
  2. secret-store file:    /opt/ai-os/.secrets/store/perplexity-api-key
The file must contain the raw key and nothing else; surrounding whitespace is trimmed.
exit=2
```

Invalid-key path, both tools — the API's own status and body reach stderr verbatim:

```
$ GEMINI_API_KEY=definitely-invalid node scripts/gemini-qa.mjs "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
gemini-qa.mjs: generateContent failed
HTTP 400 Bad Request
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
exit=1

$ PERPLEXITY_API_KEY=definitely-invalid node scripts/perplexity.mjs ask "test"
HTTP 401 Unauthorized from https://api.perplexity.ai/v1/agent
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}
exit=1
```

Exit codes 2 / 1 as specified, and the request path is proven without a valid key.

**R24 — reminders.** See §4d.

**R25 — tool docs.** Flag sets cross-checked against live `--help`:

```
$ node scripts/perplexity.mjs --help | grep -oE '^\s+--[a-z-]+' | sort -u
--instructions --max-results --max-steps --max-tool-calls --model --no-force-search --out --preset
$ grep -oE '\-\-[a-z-]+' docs/tools/perplexity.md | sort -u
--help --import --instructions --max-results --max-steps --max-tool-calls --model --no-force-search --out --preset

$ node scripts/gemini-qa.mjs --help | grep -oE '^\s+--[a-z-]+' | sort -u
--help --model --out --prompt-extra
$ grep -oE '\-\-[a-z-]+' docs/tools/gemini-qa.md | sort -u
--help --import --model --out --prompt-extra
```

Every CLI flag appears in its doc and no doc invents a flag the CLI lacks (`--import` is
prose in both docs, not a flag). `docs/tools/perplexity.md:294` carries the browser-steering
fallback as documented-only procedure, per R22's "documented, not built". `docs/tools/
gemini-qa.md:184-188` already flags the `02-architecture.md` §6.2 model/pricing error.
Caveat: `docs/tools/deploy-playbook.md` was uncommitted-modified by a sibling task during
this sweep, so its final content is not part of what I read.

**R26.** This document. The gate is in §5; the boundary check in §3; the dead-code hunt in §4.

**R27 — DEFECT.** Two of three landed:

```
$ ls -la "/opt/obsidian-vault/AI OS/"
-rw-r--r-- 1 root root  3969 Aug  5 00:49 Goal Mode Design.md
-rw-r--r-- 1 root root 92542 Aug  5 16:11 Operator Log.md
$ grep -n "^#" "/opt/obsidian-vault/AI OS/Goal Mode Design.md"
1:# Goal Mode — long-horizon autonomous development
5:## Decision
9:## What shipped
18:## How to use
22:## Phase 2 (not built yet)
$ grep -c "consolidat\|worktree-only\|chain_key\|safe-restart" "/opt/obsidian-vault/AI OS/Goal Mode Design.md"
0
```

`Operator Log.md` has the dated 2026-08-05 midday entry covering the R308 findings
(two unique indexes, `POST /api/inbox` 404, the BOM/CRLF role-file security bug, the
`roleFilePaths()` self-install). `docs/tools/deploy-playbook.md` exists. But
`Goal Mode Design.md` is untouched — 29 lines, mtime `Aug 5 00:49`, which predates
this project's first commit. R27's first named deliverable (consolidation/gating
semantics, worktree-only policy, deploy pattern, researcher lane) is not done.

**R28 — NOT-DUE, owned by P6.** What P6 must still do, exactly: in `/opt/forge-ai-os`,
merge `main` into `project/4120f785` first if main moved; re-run
`pnpm install --prod=false && npx tsc --noEmit && pnpm test` **in the worktree**; merge the
branch to main; on conflicts STOP and report the file list without improvising; apply
`db/migrations/0039_reviewer_chain_key.sql` to the live DB (still unapplied — verified:
`SELECT column_name FROM information_schema.columns WHERE table_name='project_tasks' AND
column_name='chain_key'` returns nothing); `pm2 restart forge-control`; launch
`setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &`
detached and END without waiting; then the R20 smoke; final message listing changes, test
results, and the keys owed (`gemini-api-key`, `perplexity-api-key`).

**N1.** See §4e. **N2.** See §3. **N3.** Every `catch` added to `project-tick.ts` in this
diff is one of: `.catch(() => {})` around `queueNotification` (explicitly permitted by N3),
`getProject(...).catch(() => null)` whose only consequence is falling back from a project
name to its id, or the per-group `catch` at `project-tick.ts:861` which is exactly the
opposite of silent — it counts consecutive failures and escalates once at the threshold
(`noteGroupFailure`, tested as `T12 group-failure escalation`). The genuinely new failure
paths throw: `readRoleFile` on a present-but-unreadable file (`:198-205`), `parseRoleFile`
on an unclosed frontmatter block (`:151`), `insertChainRow` on a conflict neither index
explains (`db/projects.ts:780-786`).

**N4.** See §4a. **N5.** See §6; plus the migration is provably not applied to the live DB,
and the only live-system writes this project made are the two reminders (R24) and the
`Operator Log.md` append (R27) — both permitted.

---

## 2. Known suspects

### 2a. N4 names the wrong migration — CONFIRMED STALE

`01-requirements.md:212-214` reads:

```
- **N4 — Migration discipline:** 0035 is additive-only (nullable column + partial unique
  index), applied to the live DB only at deploy phase, safe for the running engine
  (old code never writes `chain_key`).
```

The shipped migration is `db/migrations/0039_reviewer_chain_key.sql`; `0035` in this repo is
`0035_task_idempotency.sql`, which came from `main` and is already live. So N4 as written
tells a deploy engineer to treat *main's* migration as this project's — precisely the
ambiguity the R308 renumber existed to remove. Every other corpus site was updated
(`01-requirements.md:41`, `03-quality.md:99`, `04-phases.md:31`); N4 was missed.

**Exact replacement wording for round 502** (replace `01-requirements.md:212-214` verbatim):

```
- **N4 — Migration discipline:** `db/migrations/0039_reviewer_chain_key.sql` — renumbered
  from 0035 at R308, because `main` shipped its own `0035_task_idempotency.sql` while this
  branch was out and `db/migrations/` has no ledger to disambiguate two `0035_*` files — is
  additive-only (nullable column + partial unique index), applied to the live DB only at
  deploy phase, safe for the running engine (old code never writes `chain_key`).
```

### 2b. R21's `gemini-3.6-flash` — DIVERGED, shipped code is right

`scripts/gemini-qa.mjs` does **not** default to `gemini-3.6-flash`:

```
$ grep -n "DEFAULT_MODEL =" scripts/gemini-qa.mjs
72:const DEFAULT_MODEL = 'gemini-omni-flash';
```

with the reason in the three comment lines above it (`scripts/gemini-qa.mjs:68-71`):
`gemini-3.6-flash` does not accept video input, so the tool's primary use case would fail on
every invocation.

`docs/research/round-399-41e8757d.md` still agrees after the build-day re-verification, and
is the source of the change:

- `:15` — "**Current reality:** `gemini-3.6-flash` does **NOT support video input**."
- `:22` — "`gemini-omni-flash` (multimodal + video, text pricing $1.50/$9.00 per 1M tokens; video at 5,792 tok/sec ≈ $0.10/sec at standard pricing)"
- `:198` — the deltas table: "`gemini-3.6-flash` is video-capable default | §6.2 | ✗ WRONG | **CRITICAL** | Switch to `gemini-omni-flash`"
- `:233` — "Revise `scripts/gemini-qa.mjs` model default to `gemini-omni-flash`"

`docs/tools/gemini-qa.md:45,63,167,184-188` and `docs/plan/evidence/p4-gemini-errorpaths.md:11-12`
all carry the corrected default. The only places still asserting `gemini-3.6-flash` as the
default are the **plan corpus**: `01-requirements.md:155` and `02-architecture.md:196,262`.
R21 additionally mis-cites the rubric location: it says "rubric in 02-architecture §5", but
§5 is the researcher lane and the rubric schema is at §6.2 (`02-architecture.md:201`). The
rubric itself matches the shipped `RUBRIC_SCHEMA` field-for-field
(`scripts/gemini-qa.mjs:101-224` vs `02-architecture.md:203-214`) — verdict/confidence/hook/
pacing/audio/visual/factual/top_fixes/summary, all nine required.

### 2c. R22 vs the Agent API — DIVERGED, recorded precisely

**Requirement text** (`01-requirements.md:157-162`):

> **R22 — perplexity helper.** `scripts/perplexity.mjs` (same zero-dep rules): modes
> `ask "<question>"` (chat completions, model default `sonar-pro`, `--model` override) and
> `search "<query>"` (dedicated search endpoint); output JSON
> `{ answer?, citations[], search_results[] }` on stdout. Browser-steering fallback is
> DOCUMENTED in `docs/tools/perplexity.md` as manual procedure, not built.

**Shipped behaviour** (`scripts/perplexity.mjs:26-29`):

```
const AGENT_URL = 'https://api.perplexity.ai/v1/agent';
const SEARCH_URL = 'https://api.perplexity.ai/search';

const DEFAULT_MODEL = 'perplexity/sonar';
```

and the header comment at `:9-14`: "Sonar Chat Completions was deprecated July 2026; the
target is the Agent API POST /v1/agent. (POST /v1/chat/completions returns 404 — it does not
exist.)". The `--model` help line is explicit: "There is NO perplexity/sonar-pro slug"
(`scripts/perplexity.mjs:60`).

**The divergence, precisely:**

| R22 says | Shipped |
|---|---|
| `ask` uses chat completions | `ask` POSTs `https://api.perplexity.ai/v1/agent` |
| model default `sonar-pro` | model default `perplexity/sonar`; `sonar-pro` is not a valid slug |
| (nothing about search path) | `search` POSTs `https://api.perplexity.ai/search`, chosen empirically at build time (`:16-21`) |
| output `{ answer?, citations[], search_results[] }` | `ask` → `{ answer, citations, search_results, model, usage }`; `search` → `{ search_results }` — a superset, no field lost |
| browser fallback documented not built | `docs/tools/perplexity.md:294` "## 11. Browser-steering fallback — documented only, deliberately not built" — **satisfied as written** |

Sources for the supersession: commit `d870320` "docs(research): current Perplexity API
state — Agent API supersedes Sonar chat completions", `docs/research/perplexity-api.md`
(live-probed 2026-08-05), and the endpoint probe transcript in
`docs/plan/evidence/p4-perplexity-errorpaths.md`. The shipped behaviour is correct; the
requirement is pre-research text.

**Exact amended requirement wording for round 502** — following the R19/R20 precedent of a
visible supersession note rather than a silent rewrite. Replace `01-requirements.md:157-162`
with:

```
- **R22 — perplexity helper. AMENDED at R501 — superseded by `docs/research/perplexity-api.md`
  (commit d870320).** The original text specified `ask` as Sonar chat completions with model
  default `sonar-pro`. Live probing on 2026-08-05 found Sonar Chat Completions deprecated
  (July 2026) and `POST /v1/chat/completions` returning 404; there is no `perplexity/sonar-pro`
  slug. As built: `scripts/perplexity.mjs` (same zero-dep rules): modes
  `ask "<question>"` (Perplexity **Agent API**, `POST https://api.perplexity.ai/v1/agent`,
  model default `perplexity/sonar`, `--model`/`--preset` override, web search attached and
  forced by default) and `search "<query>"`
  (`POST https://api.perplexity.ai/search`); output JSON
  `{ answer, citations[], search_results[], model, usage }` for `ask` and
  `{ search_results[] }` for `search`, on stdout. The Agent API is strict — any unknown
  field is a hard HTTP 400 — so the request body is an explicit whitelist, never a
  pass-through of user options. Browser-steering fallback is DOCUMENTED in
  `docs/tools/perplexity.md` §11 as manual procedure, not built. *Verify:*
  error-path proof (R23); live smoke if a key exists.
```

### 2d. R24 reminders — both present, both correct

```
$ curl -s http://127.0.0.1:7700/api/reminders
```

Both expected ids are in the payload, both `"status":"pending"`:

**`4c4532af-24ed-4642-a7ef-15ae291391e7`** (created `2026-08-05 13:57:10`):

> "Add PERPLEXITY_API_KEY — put the raw key in /opt/ai-os/.secrets/store/perplexity-api-key
> (or export the env var PERPLEXITY_API_KEY instead; the tool checks the env var first, then
> that file). It unlocks scripts/perplexity.mjs, the researcher lane search instrument: cited
> web answers via the Perplexity Agent API plus raw search results. Until the key lands, both
> modes hard-exit 2 and no research call can be made."

Names the key (`PERPLEXITY_API_KEY`), the secret-store path
(`/opt/ai-os/.secrets/store/perplexity-api-key`) **and** the env-var alternative, plus the
resolution order and what it unlocks. ✅

**`c88f6e19-0b41-4d43-92af-48ba5eb4f476`** (created `2026-08-05 13:57:16`):

> "Add the Gemini API key: env var GEMINI_API_KEY, or the secret-store file
> /opt/ai-os/.secrets/store/gemini-api-key (secret name gemini-api-key). It unlocks
> scripts/gemini-qa.mjs — automated video QA (hook, pacing, audio, visual, factual red
> flags) as the QA backbone for the video pipeline."

Names the key (`GEMINI_API_KEY`), both locations (env var + secret-store file, with the
secret name spelled out) and what it unlocks. ✅

One reminder per still-missing key, queued by the build task, not by the tools at runtime —
exactly R24. Both keys are still missing (`ls /opt/ai-os/.secrets/store/` shows only the
github/twenty secrets), so both reminders remain owed.

### 2e. N1 zero new deps — CONFIRMED

```
$ git diff main...HEAD -- '**/package.json' 'pnpm-lock.yaml'
$ git diff --stat main...HEAD -- '**/package.json' 'pnpm-lock.yaml'
$
```

Both commands print **nothing**. No manifest and no lockfile changed across the whole
branch. Consistent with the design: both helpers are zero-dep `node:*`-only scripts and the
test suite runs on `node:test` + `node:assert/strict` via the already-present `tsx`.

### 2f. R7/T15 — bare `ON CONFLICT DO NOTHING` + classification — CONFIRMED

The INSERT (`db/projects.ts:740-756`):

```sql
INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier, chain_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT DO NOTHING
RETURNING id::text
```

`ON CONFLICT DO NOTHING` at `db/projects.ts:744` — bare, no parenthesised target, no
`ON CONSTRAINT`. Classification follows immediately:

- `:757` — `if (ins.rows[0]) return { kind: "created", id: … }`
- `:759-764` — lookup by `(project_id, chain_key)` → `{ kind: "replay" }`. **Checked first**, because a row carrying our chain_key is our own chain even if its round or title were since edited.
- `:766-778` — lookup by `(project_id, round, role, title)` → `{ kind: "occupied", id, title, chain_key }`. A stranger holds our identity tuple.
- `:780-786` — neither explains it ⇒ `throw new Error(...)` naming both indexes and the full tuple. No guess, no degrade.

The caller acts on the distinction rather than collapsing it: `project-tick.ts:708-730`
filters for `kind === "occupied"`, blocks the project, and pushes a message naming the
occupying task id/title/chain_key — instead of announcing an absorbed replay and losing the
merged verdict in silence.

**Does `docs/plan/evidence/0039-conflict-target.md` match the shipped code?** Yes.

- Its index table (`:14-17`) matches the live catalog dump at `:29-36` — `project_tasks_identity_idx` live, `chain_key` not — which I re-verified independently: `SELECT column_name FROM information_schema.columns WHERE table_name='project_tasks' AND column_name='chain_key'` returns nothing on the live DB.
- Its stated fix (`:19-25` and the S1–S5 transcripts) is exactly the bare form + chain_key-first / identity-second classification / throw-if-neither that `insertChainRow` implements.
- Its `occupied` prescription (`:152-158`) — "blocks the project and pushes a message naming the occupying task id and title … The group is still marked done, deliberately" — matches `project-tick.ts:711-730` line for line, including the deliberate `markGroupDone` at `:728`.
- Its regression-guard paragraph (`:160-168`) names `T15 createFixChain conflict arbitration` with five cases; the suite has exactly five `test(` blocks under that describe (`project-reconcile.test.ts:479` ff.), asserting the bare form survives, no target is named, the conflict is classified with `rowCount` banned and the lookups in order, `createTask` never writes `chain_key`, and the caller refuses to mark a round done on an unexplained collision.

The doc's own concrete colliding row (`:46-53`: round 306 `builder` "Fix cycle 1",
`chain_key` NULL, written by the live pre-0039 engine in *this* project) is the reachable
case, not a hypothetical — which is what makes the `occupied` branch load-bearing rather
than defensive.

---

## 3. N2 boundary check

Run verbatim:

```
$ git diff --name-only main...HEAD | grep -E '^forge-control-web/|^forge-control/src/routes/agents\.ts$'
GREP EXIT: 1
```

No output; grep exits 1 (no match). Not one path under `forge-control-web/` and not
`forge-control/src/routes/agents.ts` appears anywhere in the branch's 39 changed files.
**N2 clean — no blocking defect.**

---

## 4. Dead-code hunt (03-quality §5)

Method: extracted every `export` from `forge-control/src/db/projects.ts`,
`src/lib/project-tick.ts` and `src/lib/project-reconcile.ts`, then counted references
across all of `forge-control/src`. A count of 1 means "only its own definition line".

```
$ for s in $(cat src/db/projects.ts src/lib/project-tick.ts src/lib/project-reconcile.ts \
    | grep -oP '^export (async function|function|const|class|interface|type) \K[A-Za-z_]+' | sort -u); do
      echo "$(grep -rn "\b$s\b" src --include=*.ts | wc -l)  $s"; done | sort -n | head
1  bumpFixCycle
2  RetryOutcome
2  Verdict
3  ChainRowOutcome
3  createProject
3  createRunForTask
3  FIX_TASK_TITLE
...
```

Exactly one symbol comes back with a single reference. Verdicts on every suspect:

| Symbol | Verdict | Evidence |
|---|---|---|
| `bumpFixCycle` (`db/projects.ts:616`) | **dead — but pre-existing, NOT a refactor artifact** | `grep -rn "bumpFixCycle" --include=*.ts --include=*.mjs .` → only `forge-control/src/db/projects.ts:616`. And on main: `git grep -n "bumpFixCycle" main -- '*.ts'` → only `main:forge-control/src/db/projects.ts:575`. It had no caller before this branch either. |
| `reconcileReviewer` (the old path) | **fully removed — no orphan** | `grep -rn "reconcileReviewer" src` matches only two *prose* lines in `project-reconcile.ts:6,39` explaining what it did. Present on main at `project-tick.ts:322`; gone from HEAD's outline. |
| `RetryOutcome` | still used | `db/projects.ts:540` (def) + `retryTask` return type `:551` |
| `Verdict` | still used | `project-reconcile.ts:33` (def) + `parseVerdict` return type `:49` |
| `ChainRowOutcome` | still used | `db/projects.ts:712` (def), `insertChainRow` return `:740`, `createFixChain` return `:834` |
| `TASK_COLS` | still used | 8 call sites (`db/projects.ts:159,199,223,257,271,568,600`) |
| `TASK_COLS_PT` (new) | still used | 4 call sites (`:212,478,656,686`) — introduced precisely so a new column can't be forgotten in a hand-written joined SELECT |
| `LAST_ASSISTANT_TEXT` (new) | still used | 2 call sites (`:658,688`) — shared by `listSettledRunningTasks` and `listReviewerRound` so the two can't drift |
| `REPO_AGENTS_DIR`, `parseRoleFile`, `roleFilePaths`, `readRoleFile`, `RoleFileParseError` | still used **and** test-covered | all reached from `roleConfig()` (`project-tick.ts:229-252`) and asserted by T11/T13/T14 |
| `WORKTREE_POLICY`, `REVIEWER_LIVE_CHECK`, `DEPLOY_GUIDE`, `GITHUB_PUSH_GUIDE` | still used | wired into `buildPrompt` at `:361,398,399,431,461`; T10 asserts each |
| `chainKeys`, `parseVerdict`, `noteGroupFailure`, `clearGroupFailures`, `projectAcceptsWork`, `consolidateReviewerRound`, `FIX_TASK_TITLE`, `REREVIEW_TASK_TITLE`, `rereviewBrief` | still used | all imported by `project-tick.ts:47-56` or called internally in `project-reconcile.ts`; each has a T-numbered test |
| `MAX_TASK_ATTEMPTS` | still used | `db/projects.ts:560`, `src/routes/tasks.ts:18,50,58` |

Branches: `buildPrompt` has no unreachable arm — every role branch is exercised by T10 and
the fallthrough at `:472` still routes through `withPolicy`. `consolidateReviewerGroup`'s
switch is exhaustive over `RoundDecision`'s four actions with no `default`, so TypeScript
would flag a missing arm rather than let one rot.

**Verdict: the P1 refactor left no dead code.** The single dead export, `bumpFixCycle`,
predates this branch and is dead on `main` too — out of scope for the refactor, but worth
one line in a future cleanup rather than in this project's diff.

---

## 5. Full gate

Run once, from the worktree root:

```
$ cd forge-control && pnpm install --prod=false && npx tsc --noEmit && pnpm test
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 684ms using pnpm v9.15.9
=== TSC ===
TSC_EXIT=0 (clean)
=== TEST ===
...
ok 53 - T14 parseRoleFile robustness — BOM, CRLF, malformed header
  ---
  duration_ms: 2.230551
  type: 'suite'
  ...
1..53
# tests 167
# suites 36
# pass 167
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 975.737299
```

`npx tsc --noEmit` produced **no output** and exit 0 — clean.
`pnpm test` = **167 tests, 167 pass, 0 fail, 36 suites**.

Planner baseline at round 500 on this same HEAD: tsc clean; 167 tests / 167 pass / 0 fail /
36 suites. **Exact match — no regression.**

The 53 top-level suites present in this file's own run include T1–T15 by name
(`project-reconcile.test.ts:45,97,129,173,217,252,288,339,365,401,479`;
`project-tick.test.ts:71,238,281,359`) plus the P4 CLI suites
(`gemini-qa-cli.test.ts:134,167,240`; `perplexity-cli.test.ts:118,173,228,306`).

---

## 6. Live-checkout cleanliness (this project's own policy, applied to itself)

```
$ git -C /opt/forge-ai-os status --porcelain
EXIT: 0 (no lines above = clean)
```

Empty. No task of this project has hot-applied anything into the live checkout, from
Phase 1 through Phase 5.

---

## Must-fix for round 502

1. **`docs/plan/01-requirements.md:212-214` (N4)** — replace the stale "0035 is
   additive-only …" text with the exact replacement wording given in §2a, which names
   `db/migrations/0039_reviewer_chain_key.sql` and records why it was renumbered.
2. **`docs/plan/01-requirements.md:157-162` (R22)** — replace with the exact amended
   wording given in §2c: Agent API `POST /v1/agent`, default `perplexity/sonar`, search at
   `POST /search`, the `{answer, citations, search_results, model, usage}` output shape,
   carrying a visible "AMENDED at R501 — superseded by …" note per the R19/R20 precedent.
3. **`docs/plan/01-requirements.md:155` (R21)** — change the pinned default model from
   `gemini-3.6-flash` to `gemini-omni-flash` with a visible "AMENDED at R501 — superseded by
   `docs/research/round-399-41e8757d.md`" note stating that `gemini-3.6-flash` does not
   accept video input; and fix the rubric cross-reference from "02-architecture §5" to
   "02-architecture §6.2".
4. **Push the branch** — origin is at `17a30aa`, local HEAD at `bc0b3fa`, 11 commits behind.
   Run `scripts/git-sync-branch.sh /opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
   (plain push, never `--force`). This is the P5 deliverable "final branch push" /
   "branch pushed via the P2 helper" (`docs/plan/04-phases.md:93,95`).
5. **`/opt/obsidian-vault/AI OS/Goal Mode Design.md` (R27)** — **append** (never truncate) a
   dated section covering: reviewer-round consolidation semantics (one fix chain per round,
   `wait` until every reviewer settles, NEEDS_FIXES beats PASS), project-status gating
   (promote + claim gated on `projects.status='active'`, in-flight runs not killed), the
   worktree-only policy and the reviewer cleanliness check, the executor-safe detached
   `safe-restart.sh` deploy pattern, and the researcher lane (`agents/researcher.md`,
   `roleFilePaths()` repo fallback, the perplexity/gemini-qa instruments and their key
   protocol).
6. **`docs/plan/02-architecture.md:196,262`** — correct the `gemini-3.6-flash` default and
   its `$1.50/$7.50 per 1M; video ≈ 300 tok/s` pricing to `gemini-omni-flash` and the
   round-399 figures ($1.50/$9.00 per 1M; video 5,792 tok/sec), citing
   `docs/research/round-399-41e8757d.md`.
7. **`docs/plan/02-architecture.md:170-172` (§5.1)** — the sentence "Installed by copying to
   `/root/.claude/agents/` — additive; `roleConfig()`'s per-role cache only misses for
   never-loaded roles, so a NEW role needs no executor restart" contradicts R19's strike and
   R306's repo fallback. Replace it with the shipped resolution order
   (`${AGENTS_DIR}/<role>.md` then `${REPO_AGENTS_DIR}/<role>.md`) and the fact that a role
   file committed to `agents/` self-installs at the first post-deploy executor restart.
8. **`docs/plan/02-architecture.md` §6.3** — annotate the Perplexity section as superseded by
   `docs/research/perplexity-api.md` (Agent API, not Sonar chat completions), matching
   must-fix 2.
9. **`docs/plan/03-quality.md:61` (T12)** — the parenthetical reads "ten failures ⇒ one
   message", but the shipped threshold is `MAX_GROUP_FAILURES = 3`
   (`forge-control/src/lib/project-tick.ts:81`), and `docs/plan/evidence/0039-conflict-target.md:22-23`
   already describes the behaviour as "after `MAX_GROUP_FAILURES` strikes freezes the round
   with a 'failed to consolidate 3 times in a row' push". Change "ten failures" to
   "three failures (`MAX_GROUP_FAILURES`)".

Items 1, 2, 3, 6, 7, 8 and 9 are documentation-truth defects — the shipped code is correct in
every case and must not be changed to match the stale text. Item 4 is an unexecuted P5
deliverable. Item 5 is the one genuinely incomplete R (R27).

No code defect was found: the four engine bugs are fixed as specified, N1/N2/N3/N5 hold,
the gate matches baseline exactly, and `/opt/forge-ai-os` is clean.

---

## Resolution (round 502)

Round 501's text above is untouched; this section is appended only. Nine must-fix
items, all closed. Seven were documentation-truth defects where the shipped code was
already correct — no code was changed to match stale text, per the sweep's own
instruction. Amendments follow the R19/R20 precedent: the original wording stays
visible and an `AMENDED at R502` note carries the reason and the new binding text.

| # | Item | Resolution |
|---|---|---|
| 1 | N4 names migration 0035 | **FIXED** — `docs/plan/01-requirements.md` N4, commit `5e31be0`. Original line kept; `AMENDED at R502` block names `db/migrations/0039_reviewer_chain_key.sql` and records the R308 renumber and why (`main` shipped its own `0035_task_idempotency.sql`; `db/migrations/` has no ledger to disambiguate two `0035_*` files). |
| 2 | R22 describes Sonar chat completions | **FIXED** — `docs/plan/01-requirements.md` R22, commit `5e31be0`. `AMENDED at R502 — superseded by docs/research/perplexity-api.md (commit d870320)`: Agent API `POST /v1/agent`, default `perplexity/sonar`, search at `POST /search`, output `{answer, citations[], search_results[], model, usage}`, strict-whitelist request body, browser fallback documented in `docs/tools/perplexity.md` §11 not built. |
| 3 | R21 pins `gemini-3.6-flash`; rubric cross-ref | **FIXED** — `docs/plan/01-requirements.md` R21, commit `5e31be0`. `AMENDED at R502 — superseded by docs/research/round-399-41e8757d.md`: default is `gemini-omni-flash` because `gemini-3.6-flash` does not accept video input; rubric cross-reference corrected from "02-architecture §5" to "§6.2". |
| 4 | Push the branch | **FIXED** — `scripts/git-sync-branch.sh` run against this worktree, plain push, no `--force`. Transcript in §R502.1 below. |
| 5 | `AI OS/Goal Mode Design.md` not appended (R27) | **FIXED** — appended, never truncated. Verification in §R502.2 below: the original 29 lines are byte-identical after the append (`head -29 | diff` against a pre-append copy = no output). New section `## Engine v2 — hardening + the research lane (2026-08-05, project engine-v2-research-lane)` covers all five required topics: consolidation semantics (group-settle, NEEDS_FIXES beats PASS, one fix chain, block-before-mark-done, `chain_key` idempotency, 3-cycle cap), status gating (`AND p.status = 'active'` on both paths, in-flight runs not killed), the worktree-only policy + `REVIEWER_LIVE_CHECK`, the detached `safe-restart.sh` deploy pattern with the exact command, and the researcher lane (`agents/researcher.md`, `roleFilePaths()` repo fallback, both helpers with their key protocol, `git-sync-branch.sh`). |
| 6 | `02-architecture.md:196,262` model + pricing | **FIXED** — commit `5e31be0`. §6.2 step 2 and §9 both annotated `AMENDED at R502`: `gemini-omni-flash`, $1.50/$9.00 per 1M, video 5,792 tok/sec, citing `docs/research/round-399-41e8757d.md`. |
| 7 | `02-architecture.md` §5.1 role-file install | **FIXED** — commit `5e31be0`. The `cp` into `/root/.claude/agents/` sentence is quoted as the original and superseded: the shipped resolution order is `${AGENTS_DIR}/<role>.md` then `${REPO_AGENTS_DIR}/<role>.md` (`project-tick.ts:185-187`), so a role file committed to `agents/` self-installs at the first post-deploy executor restart. The note also keeps the true half of the old claim — `roleConfig()`'s per-role cache is why R20's smoke is gated behind P6's restart. |
| 8 | `02-architecture.md` §6.3 Perplexity | **FIXED** — commit `5e31be0`. §6.3 headed with an `AMENDED at R502` supersession pointing at `docs/research/perplexity-api.md` and R22's amendment; the original paragraph is retained beneath it for the audit trail. §9's `sonar-pro` bullet annotated to match. |
| 9 | `03-quality.md:61` T12 "ten failures" | **FIXED** — commit `5e31be0`. Corrected to three, naming `MAX_GROUP_FAILURES = 3` at `forge-control/src/lib/project-tick.ts:81` and the pre-existing agreement in `docs/plan/evidence/0039-conflict-target.md:22-23`. |

**Deliberately not fixed — `bumpFixCycle` (`forge-control/src/db/projects.ts:616`).** §4
found it dead and ruled it out of scope; round 502 agrees and re-verified rather than
assuming. It has exactly one reference, its own definition
(`grep -rn "bumpFixCycle" --include=*.ts --include=*.mjs .` → one line), and it is dead on
`main` too, so it is not a P1-refactor artifact. Deleting it would be an unrelated cleanup
inside a diff whose reviewability is the point. Left for a future cleanup commit, and it is
now recorded in two places rather than one.

**No code change was needed or made in round 502.** Every must-fix was corpus text, an
unexecuted deliverable, or a vault append — so the "extend the existing suites" rule
(task step 3) has no target: the test count neither grew nor dropped, which is the
correct outcome when `forge-control/src/**` is untouched. Verified:
`git diff --stat main...HEAD -- forge-control/src` is byte-identical before and after
this round's commits.

### §R502.1 — gate, boundary, live checkout, branch push (all re-run this round)

```
$ cd forge-control && pnpm install --prod=false && npx tsc --noEmit && pnpm test
Already up to date
Done in 724ms using pnpm v9.15.9
=== TSC ===
TSC_EXIT=0
=== TEST ===
1..53
# tests 167
# suites 36
# pass 167
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1093.215162
```

**167 tests / 167 pass / 0 fail / 36 suites — exact match to the round-500 planner
baseline and to §5's own run. No regression, no test-count drop.**

```
$ git diff --name-only main...HEAD | grep -E '^forge-control-web/|^forge-control/src/routes/agents\.ts$'
GREP_EXIT=1        (no output, no match)

$ git -C /opt/forge-ai-os status --porcelain
LIVE_EXIT=0        (no lines above = clean)
```

N2 still clean; the live checkout is still untouched, now including round 502's own work
(the only live-system write this round is the permitted vault append).

### §R502.2 — vault append verified non-destructive

```
$ cp "/opt/obsidian-vault/AI OS/Goal Mode Design.md" /tmp/goal-mode-design.bak
$ wc -l /tmp/goal-mode-design.bak
29
   ... append via `cat >> ` ...
$ wc -l "/opt/obsidian-vault/AI OS/Goal Mode Design.md"
80
$ head -29 "/opt/obsidian-vault/AI OS/Goal Mode Design.md" | diff - /tmp/goal-mode-design.bak
ORIGINAL 29 LINES INTACT      (diff produced no output)
```

R27's first named deliverable is now done. The `Operator Log.md` entry and
`docs/tools/deploy-playbook.md` were already in place per §1, so R27 moves DEFECT →
SATISFIED.
