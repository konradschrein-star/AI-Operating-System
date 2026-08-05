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
  `${project_id}:${round}`, returns `notify` exactly once on the threshold crossing (ten
  failures ⇒ one message), counts groups independently, and a success clears the counter
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
