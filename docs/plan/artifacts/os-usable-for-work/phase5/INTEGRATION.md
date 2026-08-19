# phase5/INTEGRATION.md — MERGE 2 of 3: the business lane

Integrator: workstream `main`, branch `project/7851068b`, worktree
`/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`.
Merge 2 of a single-session three-lane integration (perf → **business** → connections).

**Outcome: MERGED CLEAN.** Merge commit **`6dde6bd`**.

---

## 0. HEADLINE

| | |
|---|---|
| Lane branch | `project/7851068b-business`, tip `8eed286` |
| Target tip before this merge | `f4aa994` (already carrying merge 1, the perf lane) |
| Conflicts | **none** — `git diff --name-only --diff-filter=U` empty |
| Merge commit | **`6dde6bd`**, 37 paths |
| forge-control tsc / tests | exit 0 / **1404 pass, 0 fail** (1347 before — +57) |
| forge-control-web tsc | exit 0 |
| `gates-808.sh --strict` | EXIT=1, **RED: 1 — gate 6 only, unchanged from merge 1. This merge introduced NO new red.** |

---

## 1. THE PRECONDITION — and the artefact says the opposite of the truth

My brief's precondition is: *"First confirm the phase-5 gating reviewer issued `VERDICT: PASS`. If it
issued NEEDS_FIXES, DO NOT MERGE."*

**Read literally off the artefact, this merge would have been refused — wrongly.**
`phase5/GATE-review.md` line 3 and line 579 both say:

```
**VERDICT: NEEDS_FIXES** — one blocker, and it is a gate regression, not a defect in the product
...
**VERDICT: NEEDS_FIXES** — at tip `f4fa30c52f77492a5d6f35efce09778e082a2baa`.
```

That verdict is **stale, and it names the tip it was issued at**, which is the tell. `f4fa30c` is not
the lane tip; `8eed286` is, and it is two commits later. What happened between them:

| when (UTC) | what |
|---|---|
| 2026-08-18 21:28:24 | `570cde6` — the gate commits NEEDS_FIXES at tip `f4fa30c` |
| 22:04:53 → 22:19:48 | **fix cycle 1** — task `8bc582eb`, run `1de93fee`, status completed |
| 22:18:46 | `8eed286` lands inside that window: *"the gate's four findings, and the zero that was a claim"* |
| 22:19:59 → 22:29:05 | **re-review after fix cycle 1** — task `8e2da884`, run `744facc9`, completed |
| 22:29:05 | its **last assistant message: `VERDICT: PASS`** |

So the PASS was issued **after the current lane tip existed**, by a re-review that read that tip. The
lane is cleared.

Two method notes, because both are ways this check is routinely got wrong:

- The verdict was taken as the **LAST assistant message** of the reviewer's run, not by grepping the
  thread. Every reviewer's brief in this fleet instructs it to emit *"exactly `VERDICT: PASS` or
  `VERDICT: NEEDS_FIXES`"*, so a whole-thread regex returns both strings for every reviewer and
  classifies all of them as both.
- **A task's `done` status proves nothing about a merge or a verdict** — a refusal and a success are
  the same row state. The verdict was read from `runs.thread`, and the commit timestamps above were
  cross-checked against the run windows so that "the re-review ran after the fix landed" is measured
  rather than assumed from task ordering.

```sql
select substring(e->>'content' from 'VERDICT: [A-Z_]+')
from runs r, jsonb_array_elements(r.thread) with ordinality a(e,o)
where (r.metadata->>'task_id')='8e2da884-c94d-410b-9ae4-76cda0b06936'
  and e->>'role'='assistant' and e->>'content' ~ 'VERDICT: '
order by r.created_at desc, o desc limit 1;
--  VERDICT: PASS
```

**Finding for the corpus:** `phase5/GATE-review.md` is now a file whose headline contradicts the lane's
actual state, and it has just been merged into the project branch in that condition. It should not be
edited — it is an accurate record of *its own moment*, and `phase5/fix-cycle-1.md` is the sequel that
closes it. But anyone gating on "what does the phase-5 gate say" by opening one file gets
NEEDS_FIXES. That is the same trap as [[refused-integration-is-never-reseeded]], one layer up.

## 2. THE MERGE

```
$ git merge-tree --write-tree --name-only HEAD project/7851068b-business   # re-probed at f4aa994
probe exit=0                                                               # 0 == no conflict

$ git status --short
                                                                           # clean

$ git log --oneline -1 project/7851068b-business
8eed286 fix(os-usable-for-work/phase 5, fix cycle 1): the gate's four findings, and the zero that was a claim

$ git merge --no-commit --no-ff project/7851068b-business
Automatic merge went well; stopped before committing as requested
merge exit=0

$ git diff --name-only --diff-filter=U
                                                                           # EMPTY — no conflicts

$ git commit ...
6dde6bd
```

The conflict probe was **re-taken against `f4aa994`**, the tip merge 1 produced, not against the tip I
probed at the start of the session. Each merge moves the tip the next probe must be taken against; a
probe taken once at the top of a three-merge session answers a question about a tree that no longer
exists.

### The 37 paths

11 source files, all on this task's declared write-set:

```
forge-control-web/app/api-business.ts
forge-control-web/app/desktop/BusinessesSurface.tsx
forge-control-web/app/desktop/MoneySurface.tsx
forge-control-web/app/desktop/PipelineSurface.tsx
forge-control-web/app/desktop/businesses-inventory.ts
forge-control/src/db/pipeline.ts
forge-control/src/lib/pipeline-health.test.ts
forge-control/src/lib/pipeline-health.ts
forge-control/src/lib/redis-probe.test.ts
forge-control/src/lib/redis-probe.ts
forge-control/src/routes/pipeline.ts
```

22 `phase5/` artefacts, plus **four paths that are NOT on my declared write-set** and arrived because a
merge writes everything the lane committed. Disclosed here and in §6:

```
docs/plan/artifacts/os-usable-for-work/phase0/S-C-content-forge-state.md
docs/plan/artifacts/phase400/dollar-allowlist.md
docs/research/round-499-f5bbf4c8.md
scripts/checks/dollar-allowlist.txt
```

## 3. THE UNIVERSAL BLOCK

Always `--prod=false`: `NODE_ENV=production` is exported here, and a bare `--frozen-lockfile` prunes
devDependencies, exits 0, removes `typescript`, and the typecheck then dies with `tsc: not found`
while the install output still reads like success. The tell is `- typescript` versus `+ typescript`;
neither appeared, and `node_modules/.bin/tsc` resolves.

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Already up to date
Done in 714ms using pnpm v9.15.9

$ npx tsc --noEmit
exit=0

$ pnpm test
# tests 1404
# suites 264
# pass 1404
# fail 0

$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
Already up to date
Done in 963ms using pnpm v9.15.9

$ npx tsc --noEmit
exit=0
```

**1347 → 1404 is +57 tests / +11 suites**, which is business's `pipeline-health` and `redis-probe`
suites actually executing. The count is the cheap proof that the merge carried behaviour and not just
files.

## 4. THE GATE SUITE, AND THE BASELINE RECONCILIATION MY BRIEF ASKED FOR

```
$ bash scripts/checks/gates-808.sh --strict     # Bash timeout 600000
EXIT=1
 6  1      forbidden-file diff — three-dot main...HEAD
 RED: 1
```

23 EXECUTED, 2 SKIPPED by design (23 and 24 need `--browser`), **RED: 1**. The single red is gate 6,
firing on the identical file as after merge 1:

```
forge-control/src/db/projects.ts
>>> FORBIDDEN FILE DIFFERS
```

`db/projects.ts` is a **perf**-lane file (commit `27faa28`), not a business one. **Merge 2 introduced
no new red**, which is exactly what merging one lane at a time and re-running the suite between merges
exists to establish. Transcript: `phase5/gates-after-merge-business.txt`.

### 4.1 Against `phase5/gates-baseline-business.txt`

That baseline was captured at `bd4601c` on the lane worktree, 2026-08-18T19:29:14Z: **RED: 0**, 25
gates, 23 run, 2 skipped. Comparing it to this run: the delta is **+1 red, gate 6**, and gate 6's hit
is attributable by `git log` to a commit that is not on the business lane at all. **No red in this run
belongs to the business lane.**

### 4.2 Against `phase1/gates-baseline.txt` — it still does not exist

My brief said to reconcile the two "if phase 1's baseline has arrived on the target branch by now".
It has not:

```
$ ls docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt
ls: cannot access ...: No such file or directory
```

There is no `phase1/` artefact directory on this branch at all. Reported as measured rather than
quietly skipped, since the brief made it conditional and the condition is false.

### 4.3 The inherited "gate 17 is a known pre-existing red" — IT IS FALSE, and I re-measured it

My brief states *"Gate 17 is a known pre-existing red."* **It is green, and it was green at every
point I measured it in this session:**

| tip | gate 17 |
|---|---|
| `5c8b3e3` — pre-merge baseline, before any lane merged | **0 (green)** |
| after merge 1 (perf), `3330996` | **0 (green)** |
| after merge 2 (business), `6dde6bd` | **0 (green)** |

This matters in the dangerous direction: a reviewer who holds "gate 17 is expected red" will wave
through a true failure. The stale claim is struck. Every inherited red must be re-run at one's own tip
— which is the same instruction the connections brief gives about its own inherited claims, and it
turns out to apply to that brief too (§5 of the phase-4 report).

## 5. BOUNDARIES OBSERVED

- Merged into `project/7851068b` only — **not** into the repo's `main`, and **no deploy**. Phase 7 owns
  the deploy and has a detached procedure.
- No `pm2 restart` of anything — not `forge-executor` (it would kill every run in flight including
  mine), not a Content Forge worker.
- No writes to `content_forge` — the only queries issued against it were read-only `select`s to recover
  the gating verdict from `runs.thread` (§1).
- `/opt/forge-ai-os` untouched.
- No force-push; nothing pushed at all.
- I did not improve, refactor or "just fix" any business-lane code. An integrator that starts editing
  is an integrator that hides which lane broke what.

## 6. WRITE-SET DISCLOSURE

Four paths in `6dde6bd` are outside my declared write-set. All four are the business lane's own
committed files, arriving because a merge writes every path its parent carried — my brief acknowledges
this ("your write_set is the UNION of theirs because a merge writes all of them"), and they are named
here so the reviewer's declared-vs-actual comparison finds them disclosed rather than discovered:

```
docs/plan/artifacts/os-usable-for-work/phase0/S-C-content-forge-state.md   scout S-C's report
docs/plan/artifacts/phase400/dollar-allowlist.md                           dollar-sweep allowlist doc
docs/research/round-499-f5bbf4c8.md                                        round-499 research note
scripts/checks/dollar-allowlist.txt                                        the allowlist gate 8 reads
```

`scripts/checks/dollar-allowlist.txt` is the only executable-consequence one: it feeds gate 8
(`dollar-sweep.sh`), which is **green** in this run. I authored none of these four; I did not edit
them, and I did not edit anything to make a gate pass.
