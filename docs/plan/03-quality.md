# 03 — Quality: test strategy and QA gates

Runner facts (verified 2026-08-05): `forge-control` tests run with
`pnpm test` = `tsx --test src/lib/*.test.ts` (node:test + `node:assert/strict`, zero
framework deps — precedent `src/lib/account-health.test.ts`). Typecheck:
`npx tsc --noEmit`. The worktree's `forge-control/` has **no `node_modules`** — every
build/review task starts with `pnpm install --prod=false` there (pnpm only; never
npm/yarn).

**`--prod=false` is mandatory, not decoration** (learned in the round-103 gate): the
executor runs with `NODE_ENV=production` in its environment and every task inherits it,
so a plain `pnpm install` silently skips `devDependencies` — `typescript` and `tsx` are
never installed. It still exits 0 and prints "Already up to date", so the failure
masquerades as a broken repo: `npx tsc --noEmit` answers *"This is not the tsc command
you are looking for"* (Debian's `/usr/bin/tsc` from `node-typescript`) and `pnpm test`
dies with `sh: 1: tsx: not found`. `NODE_ENV=development pnpm install --prod=false` is
the equivalent belt-and-braces form.

## 1. Unit tests (pure logic — the heart of D1)

New file `forge-control/src/lib/project-reconcile.test.ts` covering
`project-reconcile.ts`. Required cases (T-numbers are what phase gates cite):

- **T1 `parseVerdict`:** last-occurrence-wins (reasoning quotes `VERDICT: NEEDS_FIXES`
  then ends `VERDICT: PASS` ⇒ PASS); missing line ⇒ null; case/spacing variance; null/empty
  text ⇒ null.
- **T2 single reviewer PASS** ⇒ `pass`; **single NEEDS_FIXES** ⇒ `fix` cycle 1 with the
  feedback in the merged brief.
- **T3 dual NEEDS_FIXES** ⇒ ONE `fix` decision; merged brief contains BOTH reviewers'
  titles and full texts; chain keys `fix:R:1` / `rereview:R:1`.
- **T4 PASS + NEEDS_FIXES (settled)** ⇒ `fix` (NEEDS_FIXES wins); **all-PASS (N=2)** ⇒ `pass`.
- **T5 unsettled sibling** (one settled PASS or NEEDS_FIXES + one unsettled) ⇒ `wait` —
  the PASS/NEEDS_FIXES race is dead by construction.
- **T6 unparseable verdict in group** ⇒ `block(no_verdict)` naming the task.
- **T7 max cycles:** group with `max(fixCycle) = 3` and a NEEDS_FIXES ⇒ `block(max_cycles)`;
  cycle arithmetic `cycle = max+1` for mixed fixCycle groups.
- **T8 `projectAcceptsWork`:** true only for `active`; false for
  `paused|blocked|done|cancelled`.
- **T9 chainKeys determinism:** same (round, cycle) ⇒ identical keys (idempotency
  contract the DB index relies on).
- **T15 `createFixChain` conflict arbitration** (added in P3 fix cycle 2, R308): both chain
  INSERTs use a BARE `ON CONFLICT DO NOTHING` — a chain row is subject to two unique
  indexes (`project_tasks_chain_key_uniq`, and `main`'s live `project_tasks_identity_idx`)
  and naming either leaves the other as an unhandled `unique_violation`. Then, because
  `DO NOTHING` reports zero rows whichever index fired, the conflict must be CLASSIFIED
  (`created` / `replay` / `occupied`) by looking the row up — chain_key first, identity
  second, throw if neither explains it — and the caller must block the project on
  `occupied` rather than announce an absorbed replay, or a reviewer round's merged verdict
  is dropped in silence. Live proof: `docs/plan/evidence/0039-conflict-target.md`.
- **T10 prompt policy:** `WORKTREE_POLICY`, `REVIEWER_LIVE_CHECK`, `DEPLOY_GUIDE`
  exported constants: worktree policy text present in built prompts for every role on a
  repo project, absent for scratch; reviewer prompt contains the
  `git -C /opt/forge-ai-os status --porcelain` check for repo `ai-os`; deploy guidance
  contains `safe-restart.sh forge-executor` + `setsid nohup` and forbids
  `pm2 restart forge-executor`. (Test by calling the exported prompt builder pieces with
  fixture project/task objects — refactor `buildPrompt` only as far as needed to make it
  importable without I/O; `roleConfig` file reads may be stubbed via `AGENTS_DIR` env
  pointing at a fixture dir.)
- **T12 group-failure escalation** (added in P1 fix cycle 1): `noteGroupFailure` /
  `clearGroupFailures` — counts consecutive consolidation failures per
  `${project_id}:${round}`, returns `notify` exactly once on the threshold crossing
  (AMENDED at R502: **three** failures ⇒ one message — the shipped threshold is
  `MAX_GROUP_FAILURES = 3` at `forge-control/src/lib/project-tick.ts:81`, not the "ten"
  this line originally claimed; `docs/plan/evidence/0039-conflict-target.md:22-23` already
  described it as three), counts groups independently, and a success clears the counter
  so only CONSECUTIVE failures escalate.
- **T11 researcher frontmatter parse:** run `roleConfig()`'s parsing logic (or its
  extracted equivalent) against the literal content of `agents/researcher.md` — tools
  list parses to exactly the 8 tools of R18.
- **T13 role file resolution + install parity** (added in P3 fix cycle 1, R306): T11 on
  its own is a trap — it parses the worktree's `agents/researcher.md`, which the engine
  did not read before `roleFilePaths()` existed, so it could stay green while a live
  researcher ran on the bare fallback mission. T13 asserts the engine's OWN resolution:
  candidate order is `${AGENTS_DIR}/<role>.md` then `${REPO_AGENTS_DIR}/<role>.md`;
  `readRoleFile("researcher")` resolves to a real definition (8 tools, opus/high, mission
  mentions `docs/research`); if a copy exists under `AGENTS_DIR` it must be byte-identical
  to the committed one — drift means the engine silently loads the stale installed copy,
  since AGENTS_DIR wins. When `AGENTS_DIR` has no copy the parity check does not silently
  pass: it emits a `t.diagnostic` naming the file that will be used and asserts the repo
  fallback is what resolves. Unknown role ⇒ `null`.
- **T14 `parseRoleFile` robustness** (added in P3 fix cycle 2, R308): a SECURITY test, not
  a parsing nicety. `tools: null` is not "no tools" — `cc-runner.ts` reads it as "fall back
  to `CC_ALLOWED_TOOLS`", the full set including `Write`/`Edit`/`MultiEdit`/`Task`/`Skill`,
  and `agents/reviewer.md` omits the write tools on purpose so a reviewer can only report
  findings. A UTF-8 BOM or CRLF line endings — either introduced by an editor with no
  visible change — used to make the frontmatter regex miss and hand the reviewer the full
  toolset, cached for the process's life. T14 mutates the REAL `agents/reviewer.md` bytes
  (BOM, CRLF, both, header truncated) and asserts the allowlist survives, that no tool name
  carries a stray `\r`, that an unclosed frontmatter block THROWS `RoleFileParseError`
  rather than degrading, that a plain no-frontmatter file is still legal, and that every
  committed `agents/*.md` parses. Mutation-tested against the pre-R308 parser: 5 of 9 red.
  **T13's parity case AMENDED at R703** — see §1.1.
- **T16 researcher browser lane** (added in P7, R703),
  `forge-control/src/lib/project-tick.test.ts`: the exported `RESEARCH_INSTRUMENTS` constant
  appears in the researcher's built prompt on both a repo and a scratch project, and in **no
  other role's** prompt (it is prepended to every run of its role, so scope is the contract);
  all three instruments are named with a path that exists in the checkout; the screenshot
  convention is stated literally (`/opt/ai-os/uploads/$FORGE_RUN_ID/<timestamp>-<label>.png`
  **and** the `/api/uploads/$FORGE_RUN_ID/<name>` URL form); the login-wall rule is present
  verbatim (`LOGIN WALL = STOP`, `NEVER attempt credentials`, noVNC named so "stop" cannot read
  as "give up"). The anti-drift half **executes** `--help` on each of
  `scripts/research-browser.mjs`, `scripts/perplexity.mjs`, `scripts/gemini-qa.mjs` and asserts
  every invocation, flag and exit code the prompt quotes on their behalf still exists in the
  shipped output (`open <profile>`, `--probe`, `ask "<question>"`, `--backend browser|api`,
  `--backend pool|api`, `4  LOGIN REQUIRED`, `4  NEEDS LOGIN`, `default: pool`,
  `Default backend: api`). Rounds 701/702 own those scripts; if a subcommand is renamed,
  this test is what notices instead of a confused researcher at 3am.
  **T16's perplexity default AMENDED at R776** — see §1.2. The asserted literal was
  `Default backend: browser` until R776 re-ranked the backends; the shipped assertions are now
  `Default backend: api` (`perplexity-cli.test.ts:415`, `project-tick.test.ts:665`), and
  `--help` no longer emits the old string at all. Do not "restore" it: that reads as a
  regression against correct code.
- **T17 the run id reaches the child process** (added in P7, R703), new file
  `forge-control/src/lib/cc-runner.test.ts`: `uploadsRunId()` maps a `runs.id` UUID to its
  first 12 hex characters (the only shape `GET /api/uploads/:id/:name` serves — it gates on
  `/^[a-f0-9]{12}$/`), throws with diagnostics rather than substituting a sentinel when an id
  cannot yield 12, and `runClaudeCode()` really does put `FORGE_RUN_ID` / `FORGE_RUN_UUID` on
  the child's environment. Not mocked: `CC_BIN` is pointed at a stub that writes its own env to
  a file and emits one stream-json result line, then the module is imported dynamically — the
  assertion is about a real child process, which is the only thing that was ever in doubt.
  Also asserts the negative (no `runId` ⇒ both variables *deleted*, never inherited from the
  parent) and that `executor.ts` passes `runId: run.id`.
- **T18 escalation protocol reaches every role** (added at R870),
  `forge-control/src/lib/project-tick.test.ts`: `ESCALATION_POLICY` — the condensed form of
  Konrad's 2026-08-05 autonomy rule, whose verbatim source is committed at
  `docs/plan/10-policy-agent-autonomy-and-escalation.md` — appears in the built prompt of
  **every member of `TaskRole`**, on `ai-os`, `content-forge` *and* `scratch`. The role list is
  built through `satisfies Record<TaskRole, true>`, so adding a role to the union is a compile
  error in the test rather than an unchecked role at 3am; it deliberately includes `steward`,
  which has no branch in `buildPrompt()` and falls through to the bare header. The scratch case
  is its own test: `withPolicy()` gates `WORKTREE_POLICY` on a live checkout and reusing that
  gate for R870 would have been the easy mistake — a scratch project can still spend money or
  burn Konrad's attention. All four clauses are asserted through a RENDERED prompt (autonomy
  default + the browser named, every category-1 trigger Konrad listed, the build-once-use-many
  wording with the "restate in 2-3 sentences / state your default" shape, and the reminders
  curl with its 500-char cap and the keep-working clause). `BROWSER_FIRST` is scoped to scout
  and builder — the researcher has the fuller `RESEARCH_INSTRUMENTS` plus a first-resort clause
  in its own branch — its example invocation is checked against the shipped
  `research-browser.mjs --help`, and `agents/scout.md` / `agents/builder.md` must name the
  browser too, since the interactive Task-tool subagents read those files and never run
  `buildPrompt()`. Note the T-number: T17 was already taken twice (R703's `cc-runner` suite and
  R850's tester verdicts), so this suite is T18.
  **Deviation from the vault note, deliberate:** the note says "playwright / auto-browser"; the
  auto-browser controller is not installed on this host (`docs/tools/research-browser.md` §2.1),
  so `ESCALATION_POLICY` names `scripts/research-browser.mjs` and `playwright-skill` instead,
  and T18 asserts the string `auto-browser` never appears — pointing the fleet at a dead end
  would defeat clause 1.

### 1.1 T13's install-parity case, amended at R703

The original assertion was `AGENTS_DIR copy === the committed agents/researcher.md`. It is
unsatisfiable from inside any build phase that legitimately EDITS a role file — as R703 does —
because the worktree is ahead of the deployed engine by design and **no task of this project
may write into `AGENTS_DIR`**: `/root/.claude` is the guarded path that got R19 struck, and
hot-installing a mission that names scripts the live checkout does not have yet would be worse
than the drift.

The invariant that actually protects the engine is narrower, and is now stated exactly: the
installed copy must match the **deployed** definition (`/opt/forge-ai-os/agents/researcher.md`).
If it does, the running engine is loading what was last deployed and nothing is stale. A
worktree ahead of both is a pending **deploy obligation** and is reported as a `t.diagnostic`
naming the file to refresh. Genuine rot (installed ≠ deployed) still fails, and so does the
case where the deployed copy is unreadable and the drift therefore cannot be classified.

**The obligation itself is real and belongs to P7's deploy round (R715):** `roleFilePaths()`
tries `AGENTS_DIR` *first*, so merging `agents/researcher.md` to `main` does **not** land the
new mission — `/root/.claude/agents/researcher.md` (installed 2026-08-05 17:26, byte-identical
to the pre-R703 file) would keep winning after the restart. The deploy must copy the merged file
over it, or delete the installed copy so the repo fallback resolves. Konrad may have to do that
one `cp` by hand if the harness refuses the path.

### 1.2 T16's perplexity anti-drift literal, amended at R776

R702 shipped `perplexity.mjs` browser-first, and T16 pinned that by asserting the literal
`Default backend: browser` in the shipped `--help`. R776 re-ranked the backends on measured
evidence — `POST api.perplexity.ai/search` answers **401** (reachable, no key) while
`GET www.perplexity.ai/` answers **403** (Cloudflare edge block on this VPS's egress IP), so
the API path is the reachable one and the browser path is a documented fallback. See
`docs/tools/perplexity.md` §12.1.

What T16 asserts now, and why each half is load-bearing:

| Assertion | Where | What it protects |
|---|---|---|
| `Default backend: api` | `perplexity-cli.test.ts:415`, `project-tick.test.ts:665` | the re-rank actually reached the shipped `--help`, not only the docs |
| `--backend browser\|api` in `--help` | `perplexity-cli.test.ts:418`, `project-tick.test.ts:631` (token list), `:671` | demoted is not deleted — a bare "api" would read as "the browser backend is gone" |
| `--backend browser` parses, with `--allow-uncited`, `--keep-open`, `--label` | `perplexity-cli.test.ts:299-315` | the whole browser flag surface is still wired to the backend, not just the string |
| `--backend browser` present in `RESEARCH_INSTRUMENTS` | `project-tick.test.ts:676` | the researcher prompt still names the fallback for logged-in work |
| `research-browser and gemini-qa need no key on their default path, perplexity does` | `project-tick.test.ts:654` | R702's blanket "none of them needs a key" became false at R776; a researcher told otherwise would read exit 2 as a broken tool |
| `FALLBACK` and `403` in `--help` | `perplexity-cli.test.ts:419-420` | the demotion states its own reason, so a future round can tell whether the reason still holds |

The ranking is a property of **this host's egress**, not of Perplexity: on a box Cloudflare
scores differently it could reasonably flip back. If it does, this table and the literals move
together — a round that changes one without the other is the drift T16 exists to catch.

## 2. Integration checks (real DB, careful scope)

The engine talks to the live `content_forge` PostgreSQL — there is no throwaway test DB.
Policy: **no destructive integration fixtures against live tables.** Integration
confidence comes from:

- **I1 SQL review as a first-class review item:** the phase reviewer reads the exact
  promote/claim SQL and the consolidation transaction and walks the red-team scenarios
  (§4) against them line by line.
- **I2 Migration dry-run:** apply **`db/migrations/0039_reviewer_chain_key.sql`** — this
  project's migration, renumbered from 0035 at R308 because `main` shipped its own 0035 —
  to a scratch database (`createdb` a temp DB, apply the 0030→0039 chain, or minimally
  0039 against a cloned `project_tasks` DDL that also carries `main`'s
  `project_tasks_identity_idx`) to prove it runs; drop it after. Never applied to the live
  DB before the deploy phase. Transcripts: `docs/plan/evidence/0035-dryrun.md` (the DDL
  itself) and `docs/plan/evidence/0039-conflict-target.md` (both indexes together).
- **I3 Scratch-project smoke (R20):** the researcher end-to-end run doubles as the live
  integration test of task→run→role-file→commit for a NEW role. Runs in P6 against the
  POST-restart engine, not the current one — see §3.1 for why the current one cannot
  host it.
- **I4 Helper error-path runs (R23):** executed by builder AND re-executed by reviewer:
  no key ⇒ exit 2 + both locations named; `GEMINI_API_KEY=definitely-invalid` ⇒ API error
  surfaced verbatim, exit 1; same for Perplexity.

## 3. QA gates per phase (reviewer MUST run, not read)

Every phase's gating reviewer runs, inside the worktree:

```
cd forge-control && pnpm install --prod=false && npx tsc --noEmit && pnpm test
```

(`--prod=false` for the `NODE_ENV=production` reason at the top of this file. Without it
the gate is unrunnable and reports a repo failure that does not exist.)

plus `git -C /opt/forge-ai-os status --porcelain` (must be empty — the policy this very
project encodes, applied to itself from phase 1 onward), plus the phase-specific items:

| Phase | Extra gate |
|---|---|
| P1 engine logic | T1–T9 + T12 green; I1 red-team walk (§4) with findings addressed; I2 migration dry-run output in the review |
| P2 policy/prompts + GitHub | T10 green; helper pushed THIS branch to origin (S6); grep proves no `--force` in helper; no-origin + no-auth exits proven in a scratch dir |
| P3 researcher | T11 + T13 + T14 green; **R19 struck** (see §3.1); **R20 moved to P6** (see §3.1) |
| P4 external tools | I4 re-run by reviewer; docs match `--help`; reminders exist via `GET /api/reminders` (R24); zero new deps (`git diff main...HEAD -- '**/package.json' 'pnpm-lock.yaml'` is empty) |
| P5 integration | full-diff review `git diff main...HEAD`; N2 verified (`git diff --name-only main...HEAD` touches no `forge-control-web/` path and not `src/routes/agents.ts`); vault notes appended not truncated |
| P6 deploy | brief's protocol followed verbatim; post-deploy `pm2 ls`; migration applied; detached restart launched, NOT awaited; **plus the R20 smoke carried over from P3 (§3.1)** |
| P7 browser lane | T16 + T17 green; the RENDERED researcher prompt pasted into the review (not the source string); `agents/researcher.md`'s Instruments section matches the three scripts' shipped `--help` — reviewer re-runs `--help` on each and diffs the claims; the `AGENTS_DIR` deploy obligation (§1.1) is carried into R715's protocol; zero new deps; `forge-control-web/**` and `src/routes/agents.ts` untouched |

A review without executed checks is not a review — VERDICT must cite command outputs.

### 3.1 P3's gate, amended at R308

The P3 row originally read *"T11 green; R19 install verified; R20 smoke artifacts
inspected …; scratch project closed"*. As specified it could never go green in P3, and
three rounds (R302–R304, `docs/plan/evidence/p3-smoke.md`) were spent discovering why.
Both halves are now resolved rather than retried:

**R19 is struck, not deferred.** It required a human `cp` of `agents/researcher.md` into
`/root/.claude/agents/`, because the agent harness guards `/root/.claude` as a sensitive
path and the engine's own agents structurally cannot write there. R306's `roleFilePaths()`
fallback removed the need: a role file committed to `agents/` resolves from
`REPO_AGENTS_DIR` on the next executor restart. The P6 merge puts `researcher.md` in
`/opt/forge-ai-os/agents/`, and the detached `safe-restart.sh` in the same phase picks it
up. Nothing is owed by Konrad. The reminder asking him for the `cp` was cancelled at R308
and replaced with an accurate one.

**R20 moves to P6 and stays a hard gate.** It cannot honestly run before the deploy: the
LIVE engine predates the fallback, so launching a researcher on it would resolve nothing,
cache the bare mission for the executor's lifetime, and force exactly the restart this
project is forbidden to perform. Running it AFTER the P6 restart is not a weaker test —
it is the stronger one, because it exercises the deployed engine rather than the worktree.
Its acceptance is unchanged and is now a P6 exit criterion: scratch project created, the
researcher run completes, a `docs/research/*.md` with ≥ 3 cited sources is committed, the
reviewer spot-checks ≥ 2 URLs against the claims made, scratch project closed.

**What P3 keeps.** T11 (frontmatter parses), T13 (the engine's own resolution order finds
a real definition, plus install-drift parity) and T14 (the allowlist survives a BOM/CRLF
and an unclosed header throws). These are the checkable half of the phase, and they run in
the worktree with no live-system write at all.

## 4. Red-team review (P1, mandatory — the quality bar's named requirement)

A dedicated adversarial reviewer, briefed to ATTACK the reconciliation with concrete
scenarios, not to check style. Scenario list it must walk (and try to break beyond):

1. Two reviewers, both NEEDS_FIXES, settling in the SAME tick — count resulting tasks.
2. Same, settling in DIFFERENT ticks (staggered by minutes) — the `wait` path's job.
3. PASS settles first, NEEDS_FIXES second; then the reverse order.
4. Crash injected between chain-insert commit and reviewers-marked-done — replay must
   produce zero extra rows (chain_key guard) and still mark done.
5. Crash BEFORE the insert commits — nothing marked done, full redo next tick.
6. Fix cycle at ceiling: cycle-3 re-reviewer says NEEDS_FIXES — block, not cycle 4.
7. Project paused mid-round while a builder runs — builder finishes, reconciles; nothing
   new spawns; unpause resumes the round intact.
8. Project blocked by reviewer A's no-verdict while reviewer B still running — B settles
   later: no fix chain spawns for a blocked project's group? (Decision per R9: chain rows
   may be created but must stay inert `pending`. Verify inertness, and that unblocking
   does not double-create.)
9. Round with reviewers at DIFFERENT fix_cycles (a stray manual reviewer added mid-round)
   — cycle arithmetic must still be sane (max+1).
10. `closeFinishedProjects()` interplay: all-PASS group marked done while a later-round
    phase planner is pending — project must NOT close (pending tasks exist), waterfall
    continues.
11. Promotion gating vs fix chains: fix builder at R+1 pending, phase planner at next
    hundred — planner must not promote before the fix chain completes (round ordering
    holds because R+1, R+2 < next k*100).
12. Two goal projects active simultaneously — all queries are project-scoped; prove no
    cross-project bleed in group loading.

Verdict rules for the red-teamer are the same VERDICT: contract; its NEEDS_FIXES merges
into the normal consolidation flow (it IS a reviewer task in the same round as the
primary reviewer — which also dogfoods R2 the moment both reviewers report).

## 5. End-to-end proof (P5)

The ultimate e2e for the engine changes is deferred to POST-deploy reality (next goal-mode
night runs on this code). Pre-deploy, P5's reviewer asserts the full diff coheres:
requirements matrix satisfied (each R checked off with evidence link into code/tests),
no dead code from the refactor, docs/tools/* accurate, and the branch pushed. The deploy
phase (P6) then carries its own gate (§3 table).

## 6. Failure-mode reasoning requirement (quality bar, verbatim)

For engine changes, every reviewer verdict must explicitly reason through: double-fire
(same decision applied twice), tick-overlap races, and blocked-status transitions
mid-round — three named paragraphs in the review, each ending "defended by: <code/test>".
Skipping them is grounds for the meta-reviewer (P5) to bounce the phase.
