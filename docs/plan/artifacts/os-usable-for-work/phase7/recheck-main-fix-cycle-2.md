# Re-check — round 8 — fix cycle 2 · `main`

Task `57f8fdaf-c2c9-4931-8100-eb0392e38d14` ("Fix cycle 2 · main") claims to close all three
`VERDICT: NEEDS_FIXES` blockers reviewer `9afffb14-795f-4f7a-934b-789e18ff1dce` raised against tip
`f283d5b`. This is a RE-CHECK, not a fresh review: no new findings beyond the three numbered
blockers, each verified against the tree rather than against the fix cycle's own summary.

**Tip re-checked: `67638af789ef01acf6d73e2e6de52666586c573f`**, branch `project/7851068b`, worktree
`/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`. Re-read immediately before
writing this verdict — unchanged.

## The verbatim NEEDS_FIXES, recovered

Recovered from `runs.thread` for task `9afffb14` (no `gate-verdict.md` artefact was written, per the
project's standing pattern). Reviewing tip `f283d5b`, round 6. Full text quoted in the task's own
brief; summarised here as the three numbered blockers it closes with:

1. **`/opt/forge-ai-os` dirty again, contradicting phase 3's "GOALS is not built yet" claim** —
   `routes/daily.ts`, `db/daily.ts`, `GoalsSurface.tsx`, `0042_daily_goals.sql` all exist uncommitted,
   while `DesktopApp.tsx:143` and `check-phase3-placeholders.ts:70` (`EXPECTED_UNBUILT` including
   `"goals"`) both still say the opposite.
2. **Three files stranded uncommitted in the `main` worktree** — `01-requirements.md`,
   `03-quality.md`, `phase3/fix-cycle-1-main.md`, containing round 5's unlanded answers (N4 rewrite,
   gate-17 correction, evidence §2.1/§9.1).
3. **`03-quality.md:274` "Gate 17 is a known pre-existing red" is false**, in the dangerous direction —
   a reviewer briefed with it waves through a real failure.

## Per-blocker verification

### Blocker 1 (stranded files) — CLOSED

`git show 67638af -- docs/plan/os-usable-for-work/01-requirements.md
docs/plan/os-usable-for-work/03-quality.md
docs/plan/artifacts/os-usable-for-work/phase3/fix-cycle-1-main.md` — all three land in this commit.

- `01-requirements.md` N4 now reads: *"If you FIND the live checkout dirty, N4 tells you not to touch
  it but not what to do — follow the standing ruling `AI OS/Operator Decisions.md` § 'When the live
  checkout goes dirty': check whether the change exists anywhere else, preserve it as a patch in your
  phase artefacts, escalate it in your report as a blocker naming whether it is the sole copy, and
  never revert, discard or stash it."* Verified the cited vault section exists on disk at
  `/opt/obsidian-vault/AI OS/Operator Decisions.md:297` ("## When the live checkout goes dirty").
- `fix-cycle-1-main.md` gained §2.1 (the ruling, quoted), §9.1 (gate-17 correction rationale), and
  §10 (round 7's own record, 259 added lines total in this commit's diff).

### Blocker 2 (gate-17 stale claim) — CLOSED, and re-measured independently

`03-quality.md:274` diff: `~~**Gate 17 is a known pre-existing red.**~~` struck (not deleted), with a
correction dated 2026-08-18 citing three independent `EXIT=0` runs. Not taken on the brief's word: I
ran the full gate suite myself at tip `67638af` (below) — **gate 17 (`verify-notification-gap-pins.mjs`)
is EXIT=0**, a fifth independent green measurement.

### Blocker 3 (the `goals` ownership question) — SETTLED, correctly not re-opened here

The fix cycle claims the dirt was Konrad's own feature (chat run `765e56ad`, landed as `553fa38` on
`main`, live checkout clean at `9c3f63a`) and defers the *consequence* — `main` now renders
`<GoalsSurface />` while the `surfaces` lane's `EXPECTED_UNBUILT` still lists `"goals"` — to phase 7,
since fixing it here would be an undeclared write into the surfaces lane's write-set.

Verified independently, not on the commit's word:
- `git -C /opt/forge-ai-os rev-parse HEAD` → `9c3f63aa161a29b844699fcf537e9c8ae22f374d`, matching the
  claim. `git -C /opt/forge-ai-os status --porcelain` → empty.
- `git log -1 553fa38` → `VPS Cat`, `2026-08-19 01:16:03 +0200`,
  "feat(daily): Goals/Tasks daily surface — commit the work that was already live". Matches.
- `git branch --contains 553fa38` → `main`, `operator/cheaper-verification`,
  `project/7851068b-surfaces`, `project/8c591d6c`. On `main`, as claimed.
- The named collision is real: `main` has `GoalsSurface` wired at `DesktopApp.tsx:468`; this
  workstream's own tree (`project/7851068b`, which does not touch `DesktopApp.tsx` or
  `check-phase3-placeholders.ts` at all) confirms those two files are untouched here — they belong to
  `project/7851068b-surfaces`, which already carries phase-7 reconciliation commits
  (`742a34c` "retire GOALS from the unbuilt determination", `823db93` "merge(phase7): reconcile
  surfaces with main — GOALS wins, JOURNAL/MAP/LIBRARY stay unbuilt", `b29ceb8`). The collision this
  task correctly declined to fix is already being resolved on the lane that owns it — consistent with,
  not contradicting, this task's deferral.

None of the three blockers is open at `67638af`.

## Universal gate block (run at `67638af`)

```
cd forge-control && pnpm install --frozen-lockfile --prod=false
  Lockfile is up to date, resolution step is skipped / Already up to date (761ms)
  node_modules/.bin/tsc and .bin/tsx present
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
  Lockfile is up to date, resolution step is skipped / Already up to date (1s)
  node_modules/.bin/tsc present
cd ../forge-control && npx tsc --noEmit        → EXIT 0
cd ../forge-control-web && npx tsc --noEmit    → EXIT 0
cd ../forge-control && pnpm test               → 1293/1293 pass, 0 fail, 239 suites, EXIT 0
cd .. && bash scripts/checks/gates-808.sh --strict   → GATES_EXIT=0
```

### gates-808.sh --strict — full table

25 gates total · 23 EXECUTED · 2 SKIPPED-by-design (23, 24 — browser harness, need `--browser`,
results tracked separately per README §8) · **RED: 0**.

| # | EXIT | gate |
|---|---|---|
| 1 | 0 | npx tsc --noEmit — forge-control |
| 2 | 0 | npx tsc --noEmit — forge-control-web |
| 3 | 0 | NODE_ENV=production pnpm build — forge-control-web |
| 4 | 0 | token purity — round 808's own files |
| 5 | 0 | no-raw-colours.cjs (whole app) |
| 6 | 0 | forbidden-file diff — three-dot main...HEAD |
| 7 | 0 | forge-control/ untouched by round 808's own commits |
| 8 | 0 | dollar-sweep.sh |
| 9 | 0 | check-composer-v3.ts |
| 10 | 0 | check-secret-requests.ts |
| 11 | 0 | contrast-canvas-banners.cjs |
| 12 | 0 | check-working-sql-agreement.ts — standalone typecheck |
| 13 | 0 | check-stop-affordance.tsx |
| 14 | 0 | check-dismiss-peek.tsx |
| 15 | 0 | check-team-rows.ts |
| 16 | 0 | check-team-confirm.ts |
| 17 | 0 | verify-notification-gap-pins.mjs (blocker 2's subject — green) |
| 18 | 0 | check-usage-fold.ts — hourly token fold vs real Postgres |
| 19 | 0 | check-usage-fold.ts — standalone typecheck |
| 20 | 0 | pnpm test — forge-control unit suite |
| 21 | 0 | psql-argv-leak.cjs |
| 22 | 0 | nav-walk-sampling.cjs |
| 23 | — | phase700/network-700.cjs (SKIPPED — needs --browser) |
| 24 | — | phase600/nav-walk.cjs (SKIPPED — needs --browser) |
| 25 | 0 | reproduce-cleanliness |

**Baseline comparison.** Phase-1 baseline (`git show
project/7851068b-vault:docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt`, captured
2026-08-18T19:28:21Z at `9d63480`): 25 gates, 23 GREEN, 2 SKIPPED, 0 RED. This run: identical shape,
23 GREEN / 2 SKIPPED / 0 RED. **No new red versus baseline.**

Quality doc used: `docs/plan/os-usable-for-work/03-quality.md` (per-project layout; this project's
corpus has it, so the round-808 `docs/plan/03-quality.md` was not used).

## Write-set audit — against the task's own declared write_set

`project_tasks` row `57f8fdaf-c2c9-4931-8100-eb0392e38d14` declares:
```
docs/plan/os-usable-for-work/01-requirements.md
docs/plan/os-usable-for-work/03-quality.md
docs/plan/artifacts/os-usable-for-work/phase3/fix-cycle-1-main.md
```
(This row carries its own explicit write_set — it was seeded from the work, not inherited empty from
its `depends_on` reviewer `9afffb14` — so auditing it directly is satisfiable; unlike `d2856cf`
earlier in this project, there is no parent-row substitution needed here.)

`git show --stat 67638af` / `git log --name-only 67638af -1` touches exactly:
```
docs/plan/artifacts/os-usable-for-work/phase3/fix-cycle-1-main.md
docs/plan/os-usable-for-work/01-requirements.md
docs/plan/os-usable-for-work/03-quality.md
```
**Exact match. No undeclared writes.**

## Live-checkout cleanliness check

```
$ git -C /opt/forge-ai-os status --porcelain
(empty)
```
PASS.

## VERDICT

**VERDICT: PASS**

Tip reviewed: `67638af789ef01acf6d73e2e6de52666586c573f` on `project/7851068b`.
