# 04 — Phases (the waterfall)

Round scheduling per goal-mode convention: phase k's planner sits at round k·100; the
99-round gap absorbs fix cycles (each costs rounds +1/+2 from its reviewer) without ever
colliding with the next phase. Rounds only gate ordering; gaps are free. Tasks in the
same round run in parallel in the SAME worktree — same-round tasks must touch disjoint
files; anything that could collide goes in consecutive rounds.

**File-collision note across phases:** P1 and P2 both edit
`forge-control/src/lib/project-tick.ts`. That is safe because phases are strictly
sequential (P2's planner cannot promote until P1's rounds — including its fix cycles —
are all done). Within each phase, planners must keep same-round builders off shared files.

**Standing constraints for every phase (planners: copy these into builder briefs):**
worktree-only (never edit `/opt/forge-ai-os`; never `pm2 restart forge-executor` — not
even "just to test"); no `forge-control-web/app/desktop/**`, no `src/routes/agents.ts`;
pnpm only, `pnpm install --prod=false` first (worktree has no `node_modules`, and a bare
install skips `tsx`/`typescript` under the executor's `NODE_ENV=production`); no new npm deps;
hard errors, no silent fallbacks; commit per task with clear messages.

---

## Phase 1 — Engine hardening: reviewer consolidation + status gating (round 100)

- **Goal:** kill bugs 1 and 2 at the reconciler/DB layer, with the pure logic extracted
  and unit-tested.
- **Scope (files):** `forge-control/src/lib/project-reconcile.ts` (new),
  `forge-control/src/lib/project-reconcile.test.ts` (new),
  `forge-control/src/lib/project-tick.ts` (reconcile + spawn paths),
  `forge-control/src/db/projects.ts` (promote/claim SQL, `listReviewerRound`,
  fix-chain transaction), `db/migrations/0039_reviewer_chain_key.sql` (new).
- **Deliverables:** pure module + tests T1–T9; group consolidation wired into
  `reconcileSettledTasks()`; gated promote/claim; migration 0039 (NOT applied to live DB —
  dry-run only per 03-quality I2).
- **Acceptance / gates:** T1–T9 green; `tsc --noEmit` clean; existing tests still green;
  red-team review per 03-quality §4 (all 12 scenarios walked, three named failure-mode
  paragraphs); I2 migration dry-run evidence.
- **Requirements covered:** R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 R11.
- **Risk: HIGH (this is the engine running us) → planner MUST add a red-team reviewer**
  (attack brief, 03-quality §4) alongside the standard gating reviewer, same round —
  which also live-exercises the new dedupe the moment both report.

## Phase 2 — Policy encoding + GitHub lane (round 200)

- **Goal:** kill bugs 3 and 4 where behavior is generated (prompts), and ship the boring
  GitHub helper + guidance.
- **Scope (files):** `forge-control/src/lib/project-tick.ts` (exported
  `WORKTREE_POLICY` / `REVIEWER_LIVE_CHECK` / `DEPLOY_GUIDE` constants wired into
  `buildPrompt()`, incl. push/PR guidance in planner/reviewer/architect branches),
  prompt tests (T10) in `project-reconcile.test.ts` or a sibling test file,
  `scripts/git-sync-branch.sh` (new), `docs/tools/deploy-playbook.md` (new).
- **Deliverables:** policy constants + tests; helper script (push + `--pr`, force-free by
  construction); deploy playbook doc; guidance text landed in all role branches.
- **Acceptance / gates:** T10 green; helper pushes THIS work branch to origin (S6 proven);
  `grep -c force scripts/git-sync-branch.sh` = 0; no-origin/no-auth exit codes proven in
  a scratch dir; tsc + suite green.
- **Requirements covered:** R12 R13 R14 R15 R16 R17.

## Phase 3 — Researcher role + smoke (round 300)

- **Goal:** the researcher lane exists and demonstrably works end-to-end.
- **Scope (files):** `agents/researcher.md` (new, in-repo); `roleFilePaths()` repo
  fallback + T13; T11 frontmatter-parse test; T14 allowlist robustness. No live-system
  write at all — R308 struck the `/root/.claude/agents/` install step (R19).
- **Deliverables:** role file (R18); the file resolves through the ENGINE's own path
  order, proven by T13 against `REPO_AGENTS_DIR` rather than a hand-installed copy.
- **Acceptance / gates:** T11 + T13 + T14 green; tsc + suite green.
- **Requirements covered:** R18. (R19 struck, R20 moved to P6 — 03-quality §3.1.)

## Phase 4 — External service tools: gemini-qa + perplexity (round 400)

- **Round 399 scout (seeded by this corpus):** re-verify BOTH API surfaces against
  official docs on build day (endpoints, model names, upload flow, response fields,
  pricing) → `docs/research/` note; the 02-architecture §6 facts are from 2026-08-05 and
  drift is expected. Planner folds any deltas into builder briefs.
- **Goal:** both helpers exist, correct with AND without keys, documented, reminders queued.
- **Scope (files):** `scripts/gemini-qa.mjs` (new), `scripts/perplexity.mjs` (new),
  `docs/tools/gemini-qa.md` (new), `docs/tools/perplexity.md` (new). Disjoint pairs —
  gemini and perplexity builders may share a round.
- **Deliverables:** CLIs per 02-architecture §6 (rubric schema verbatim = the pipeline
  contract); docs; one reminder per still-missing key via `POST /api/reminders`
  (recon 2026-08-05: both `gemini-api-key` and `perplexity-api-key` missing from
  `/opt/ai-os/.secrets/store/` — expect two reminders).
- **Acceptance / gates:** I4 error-path proofs re-run by reviewer (exit 2 no-key naming
  both locations; invalid-key surfaces API error, exit 1); live smoke IF a key appeared;
  docs match `--help`; zero dependency changes; reminders visible via GET; tsc + suite green.
- **Requirements covered:** R21 R22 R23 R24 R25.

## Phase 5 — Integration sweep + knowledge capture (round 500)

- **Goal:** the whole diff coheres; the system's own documentation knows what changed.
- **Scope (files):** fixes surfaced by the sweep (any file already in scope above);
  vault appends (`AI OS/Goal Mode Design.md`, `AI OS/Operator Log.md`); final branch push.
- **Deliverables:** requirements matrix walked with evidence per R (checklist in the
  reviewer brief); vault notes appended; branch pushed via the P2 helper.
- **Acceptance / gates:** full-diff review of `git diff main...HEAD`; N2 boundary check
  (`git diff --name-only` clean of forbidden paths); `pnpm install --prod=false && npx tsc
  --noEmit && pnpm test` green from a clean state; vault notes appended, nothing truncated.
- **Requirements covered:** R26 R27.

## Phase 6 — Deploy (round 600, only after P5 PASS)

- **Goal:** land it, restart safely, report.
- **Scope:** `/opt/forge-ai-os` (the ONE phase allowed to touch it), live DB (migration
  0039), pm2 (forge-control only), detached safe-restart for the executor.
- **Deliverables / protocol (verbatim from the brief + R28):**
  1. In `/opt/forge-ai-os`: `git merge main` into `project/4120f785` first if main moved;
     re-run `pnpm install --prod=false && npx tsc --noEmit && pnpm test` in the WORKTREE; then merge
     the branch to main. Conflicts ⇒ STOP, report the files, do not improvise.
  2. Apply `db/migrations/0039_reviewer_chain_key.sql` (additive; safe under the running
     old engine).
  3. `pm2 restart forge-control` (API side — allowed).
  4. `setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &`
     — launch DETACHED and END; never wait, never `pm2 restart forge-executor`.
  5. **R20 smoke, carried over from P3 (03-quality §3.1).** Only AFTER step 4's restart
     has landed — the pre-restart engine has no repo fallback and would cache a bare
     mission. Create a scratch-repo project whose brief tells its round-0 architect
     (tier `fast`) to create exactly ONE researcher task (suggested topic: "current
     Perplexity API surface + pricing, cited" — the output doubles as fresh input for P4)
     and stop. The researcher run must complete and commit a `docs/research/*.md` with
     ≥ 3 cited sources; the reviewer spot-checks ≥ 2 URLs against the claims made; the
     scratch project is then closed. Executor logs must show no
     `no agent definition for role researcher` warning.
  6. Final message: what changed, test results, which keys/reminders Konrad owes the
     system (expected: `gemini-api-key`, `perplexity-api-key` unless added meanwhile).
- **Acceptance / gates:** 03-quality §3 P6 row (which now includes the R20 carry-over);
  the deploy task's transcript is the evidence.
- **Requirements covered:** R28, R20 (carried from P3).

---

## Requirement → phase coverage matrix

| Phase | Requirements owned |
|---|---|
| P1 | R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 R11 |
| P2 | R12 R13 R14 R15 R16 R17 |
| P3 | R18 (R19 struck at R308; R20 moved to P6) |
| P4 | R21 R22 R23 R24 R25 |
| P5 | R26 R27 |
| P6 | R28 + R20 (carried from P3 at R308) |

(N1–N5 are standing constraints enforced by every phase's gates, not owned by one phase.)

## Round map

| Round | Task | Tier |
|---|---|---|
| 0 | Architect: this corpus + seeding | flagship (done) |
| 100 | Planner: Phase 1 (engine hardening; MUST add red-team reviewer) | standard |
| 200 | Planner: Phase 2 (policy + GitHub) | standard |
| 300 | Planner: Phase 3 (researcher) | standard |
| 399 | Scout: re-verify Gemini + Perplexity API surfaces | (role default) |
| 400 | Planner: Phase 4 (external tools) | standard |
| 500 | Planner: Phase 5 (integration sweep) | standard |
| 600 | Planner: Phase 6 (deploy) | standard |
