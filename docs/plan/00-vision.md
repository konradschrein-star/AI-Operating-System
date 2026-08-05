# 00 — Vision: engine-v2-research-lane

> Goal-mode project `4120f785`, branch `project/4120f785` off `main` of the ai-os repo.
> The previous corpus at this path (files-pane-fast-light, shipped 2026-08-05) is archived
> at `docs/plan/archive/2026-08-files-pane-fast-light/`. Everything below describes the
> NEW goal; the old round map no longer applies.

## The goal, restated precisely

Two halves, strictly ordered:

1. **Harden the goal/project engine** using the four bugs its first night (2026-08-04→05)
   exposed. The engine is `forge-control`'s deterministic orchestrator tick
   (`forge-control/src/lib/project-tick.ts` + `src/db/projects.ts`): it promotes rounds,
   spawns runs, and reconciles reviewer verdicts. All four bugs are
   reconciliation/gating/policy bugs, not model bugs — they get deterministic-code fixes,
   unit-tested where the logic is pure.

2. **Extend the engine with a deep-research lane**: a `researcher` role (already accepted
   by DB migration 0034) that can steer a real browser and must cite what it saw; a
   standalone Gemini video-QA CLI (the future QA backbone of the video pipeline); a thin
   Perplexity helper; and boring GitHub integration (push work branches at phase
   completion, optional PR on project completion).

**Meta-constraint that shapes everything:** this project modifies the engine that is
running it. Build phases are worktree-only. The live checkout `/opt/forge-ai-os` and the
live executor are untouchable until the final deploy phase, and the executor restart must
be the detached `safe-restart.sh` pattern — never `pm2 restart forge-executor`.

## Definition of done (from the brief, made checkable)

| # | Done means |
|---|---|
| D1 | All four engine bugs fixed with the exact behavior in 01-requirements (R1–R11), covered by unit tests where logic is pure — reviewer-verdict consolidation and promotion/claim gating are extracted into testable functions (precedent: `forge-control/src/lib/account-health.test.ts`; runner: `pnpm test` = `tsx --test src/lib/*.test.ts`). |
| D2 | `agents/researcher.md` exists in the repo and is installed at `/root/.claude/agents/researcher.md`; a smoke researcher task has run end-to-end in a scratch project and produced a cited `docs/research/*.md`. |
| D3 | `scripts/gemini-qa.mjs` and `scripts/perplexity.mjs` exist, behave correctly **with and without keys** (hard, actionable errors — never silent fallback), with docs under `docs/tools/`. Missing keys ⇒ a reminder queued to Konrad naming the exact key and where to put it. |
| D4 | GitHub push-at-phase-completion and PR-on-completion implemented (helper script + prompt guidance) and documented. |
| D5 | `npx tsc --noEmit` clean in `forge-control`; existing tests plus the new ones pass. |
| D6 | Deployed per the brief: merge main into branch first if main moved, re-run checks, merge to main (STOP on conflicts and report files), `pm2 restart forge-control`, then detached `setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45` — do not wait. Final report names keys/reminders Konrad owes the system. |

## Measurable success criteria

- **S1 (dedupe):** a round with two reviewers both returning NEEDS_FIXES yields exactly ONE
  "Fix cycle N" builder and ONE re-reviewer — proven by unit tests on the consolidation
  function AND enforced by a DB uniqueness guard (migration 0035, `chain_key`).
- **S2 (gating):** a `paused`/`blocked` project spawns zero new runs from the next tick on;
  its pending/ready tasks sit still and resume when status returns to `active`. Proven by
  unit test on the extracted predicate plus red-team scenario walk of the SQL.
- **S3 (policy):** every role prompt from `buildPrompt()` for a repo-backed project carries
  the worktree-only rule; the reviewer prompt carries the live-checkout cleanliness check
  (`git -C <live checkout> status --porcelain` must be empty) and the deploy guidance
  carries the detached-restart pattern.
- **S4 (researcher):** the smoke scratch project ends with a committed, citation-bearing
  research doc produced by a run whose role file loaded from `/root/.claude/agents/researcher.md`.
- **S5 (tools):** `gemini-qa.mjs`/`perplexity.mjs` without keys exit non-zero naming the
  env var AND the secret-store name; with an invalid key they surface the API's own error
  clearly (proving the request path end-to-end).
- **S6 (github):** work branch `project/4120f785` visible on `origin` (never force-pushed);
  the helper refuses force pushes by construction.

## Explicit non-goals

- **No web UI work.** `forge-control-web/app/desktop/**` belongs to the parallel
  operator-visibility project. API route changes allowed EXCEPT `src/routes/agents.ts` (theirs).
- **No new orchestration framework.** The tick stays deterministic TypeScript; we fix its
  logic, we do not replace it.
- **No fragile scraping.** Perplexity browser-steering fallback is documented, not built.
- **No video-pipeline integration of gemini-qa.** Standalone CLI only; wiring into
  content-forge is a later goal.
- **No multi-repo GitHub generalization.** Only the existing `origin` + authenticated `gh`
  path; no force pushes, no auto-merged PRs.
- **No executor lifecycle redesign.** The idle-budget timeout work is done; we only encode
  the deploy-restart policy.

## Why this matters (design intent, from the vault)

The vault note `AI OS/Goal Mode Design.md` and the 2026-08-05 Operator Log postmortem are
the source of record: goal mode's first night shipped two projects (~$48) but exposed that
reconciliation has no round-group awareness, gating ignores project status, and the fleet
invented a hot-apply deploy pattern that caused mystery forge-control restarts. That
note's "phase 2 planned features" list *is* this project's second half (researcher lane,
Gemini video QA, GitHub deepening). Fixing the engine first, with tests, makes every
future goal-mode night cheaper and safer than the first one.
