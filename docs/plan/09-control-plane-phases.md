# 09 — Manager Control Plane: phases (rounds 900+)

The waterfall for the round-800 control-plane mandate. Four phases, planners seeded at rounds 900 /
1000 / 1100 / 1200 (the 100-gap leaves room for fix cycles). Every requirement C1–C24 (06 §3–4) maps
to exactly one phase. Each phase ends with a gating reviewer running the full 08 §4 gate; CP1
additionally gets the 08 §5 red-team reviewer.

Cross-phase invariants (every planner copies into every brief): the WORKTREE-ONLY policy (already
injected by the engine), the boundary doc's never-touch list (05 D1), index.ts append-only shape
(05 D2), no capabilities flips (05 D3), zero migrations (C21), hard errors only (C20).

---

## CP1 — Verbs core + delivery handshake (planner round 900)

**Scope.** `forge-control/src/lib/run-control-rules.ts` (pure rules: eligibility matrices,
`completionTransition`, comms-entry builders, `projectSlug` — slug ships here so CP3 only wires it);
`forge-control/src/db/runs.ts` helpers (`appendComms`, `stopRun`, `terminateRun`, `listComms`,
`markPendingInput`); `forge-control/src/routes/run-control.ts` with `POST /:id/message`,
`POST /:id/stop`, `POST /:id/terminate`, `GET /:id/comms`; the two appended `index.ts` lines
(`import runControl` after the `mentor` import; `app.route("/api/runs", runControl)` after the
`/webhooks` mount — 05 D2/F11b shape exactly); `executor.ts` pending-input handshake (07 §5) and
completion guard (07 §6); `scripts/checks/verify-control-plane.sh` (08 §3b/§6).

**Deliverables.** Code + unit/integration tests per 08 §1–2 + the check script.
**Acceptance.** 08 §4 gate green; red-team reviewer (08 §5, S1–S8) finds nothing standing; every
verb's row effects match 07 §4's table literally.
**Covers.** C1–C5, C11–C14, C20–C24 (invariants henceforth), and `projectSlug`'s share of C18.
**Risk.** Highest of the project — races in the engine that runs us. Hence red-team, hence first.

## CP2 — Resume + sub-agent relay (planner round 1000)

**Scope.** `POST /:id/resume-chat` (in-place, workspace pre-flight, C6–C8) and
`POST /:parentId/subagent-message` (subagents_v2 addressing, relay prefix, honest 409 — C10) in
`run-control.ts` + `db/runs.ts` support; verification that C9's reconciler interactions hold as
07 §7 states them (tests where pure, written argument where not).
**Deliverables.** Code + tests; 07 §7's claims re-verified against the then-current reconciler.
**Acceptance.** 08 §4 gate; resume of completed/failed/cancelled/stuck/paused proven in tests;
workspace-gone 409 proven; unknown-subagent 409 proven; check script extended to both verbs.
**Covers.** C6–C10.

## CP3 — Linkage, prompts, corpus paths (planner round 1100)

**Scope.** The D5 sentence in `lib/cc-runner.ts`'s operator prompt (C15); `origin_chat_id` copy in
`db/projects.ts` `createRunForTask` (C16); MANAGER COMMS block in `project-tick.ts` `buildPrompt`
via a `withComms`-style wrapper mirroring `withPolicy` (C17); slug interpolation into the goal-mode
architect corpus paths + planner corpus references (C18); `docs/tools/run-control.md` documenting
all six endpoints, body shapes, eligibility, and the restart matrix.
**Deliverables.** Prompt/code changes + tests (slug already unit-tested in CP1; here: prompt
snapshot tests asserting the block appears iff `origin_chat_id` present, and the architect prompt
contains `docs/plan/<slug>/` and no flat `docs/plan/0` path).
**Acceptance.** 08 §4 gate incl. the extended `origin_chat_id` grep (matches only
`lib/cc-runner.ts` + `db/projects.ts`); no behavior change for projects without linkage.
**Covers.** C15–C18.

## CP4 — Deploy, live verify, announce (planner round 1200)

**Scope.** The project's standard deploy per boundary D4 (merge main → worktree first; re-run
typecheck + tests AFTER the merge; then merge to main; conflicts = STOP and report files), then
`pm2 restart forge-control`, then live verification per 08 §6 with transcript to
`docs/plan/evidence/cp4-deploy.md`, then announcement-table rows (05 D3's five-column format,
`flipped?` EMPTY) for the verbs proven live, then the reminder for the post-restart half
(message→running, subagent→running), then the detached executor restart, then END.

The planner puts the following two blocks VERBATIM into the deploy task's brief (and the push block
into every CP phase's gating-reviewer brief it plans):

DEPLOY GUIDANCE (put this verbatim into the final deploy phase's brief):
- EXECUTOR-LOADED CODE. If the diff touches `src/lib/project-tick.ts`, `src/lib/cc-runner.ts`,
`src/executor.ts`, `src/db/*` or the `agents/*.md` role files, the executor is holding the old code
in memory and a plain restart would kill every run in flight — including the deploy task itself.
- NEVER `pm2 restart forge-executor`. Not to deploy, not to test, not "just this once".
- Instead, after merging, run exactly:
    setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
  launch it DETACHED and END the task — never wait for it, never poll it, never tail the log until
it finishes. The script waits for the fleet to go idle and restarts then; your task must return
immediately.
- `pm2 restart forge-control` (the API side) remains allowed and is the right way to pick up
route/API changes, since nothing long-running lives in that process.
- MERGE vs PR (R17): if the project brief says to open a PR instead of merging, run
`scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"` and do NOT merge to main — the PR is the
deliverable. Otherwise merge per the brief (merge main into the work branch first if main moved,
re-run typecheck + tests in the worktree, then merge to main; on conflicts STOP and report the
files).

GITHUB PUSH (phase completion):
- When a phase's gating reviewer issues VERDICT: PASS and the repo has an origin remote, run
`scripts/git-sync-branch.sh <worktree-dir>` to push the work branch so the progress is visible on
GitHub.
- Plain push only. NEVER force-push, never `--force`, never `--force-with-lease` — this branch is
shared with whatever else is watching it.
- If the push fails (no origin, gh not authenticated, rejected), report the failure verbatim in your
final message and move on. A push failure NEVER changes the verdict.

**Additional CP4 merge notes for the planner.** If `project/8ea0cc08` (operator-visibility) has
landed on main by then, the merge WILL conflict per boundary F11 — resolve `index.ts` by keeping
BOTH sides of both hunks, corpus files per the D6 recipe, and re-run
`git merge-tree --write-tree --name-only main project/8ea0cc08`-equivalents on the day rather than
trusting the snapshot. Re-read `Contract - Manager Control Plane API.md` before announcing: the
other lane may have edited it since round 800.

**Acceptance.** Everything in 08 §6; deploy reviewer verifies evidence file, announcement rows
(exactly the proven verbs, `flipped?` empty), the reminder's existence, and that the deploy task's
final message reports what changed, test results, and what Konrad owes the system.
**Covers.** C19 (+ D4 compliance).

---

## Requirement → phase map (completeness check)

| phase | requirements |
|---|---|
| CP1 | C1 C2 C3 C4 C5 C11 C12 C13 C14 C20 C21 C22 C23 C24 (+projectSlug of C18) |
| CP2 | C6 C7 C8 C9 C10 |
| CP3 | C15 C16 C17 C18 |
| CP4 | C19 |

All 24 requirements appear exactly once (C18 implemented CP1, wired CP3 — owned by CP3 for
acceptance). Non-functional C20–C24 are gated in every phase but owned by CP1's reviewer.

## Round arithmetic

Planner k at round k; its builders at k+1…k+n (disjoint files per round or consecutive rounds);
gating reviewer after the last builder round; fix cycles land at reviewer-round+1 via the engine's
consolidation; hard ceiling per planner: round k+20. The 900/1000/1100/1200 spacing means even a
3-cycle fix chain cannot collide with the next phase's planner.
