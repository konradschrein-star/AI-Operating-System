# Phase 3 integration review — workstream `main`, round 4

**VERDICT: NEEDS_FIXES**

**Tip reviewed: `8ae6c7a6005e257ba85e8b746405e4b32f7ac701`** (`project/7851068b`), re-read
immediately before this blocker was written — unchanged. Live checkout `/opt/forge-ai-os`
at `22967d6`, branch `main`.

Reviewer task `a30becc8-659d-41f3-91ab-683f5efaad37`. Reviewing the integration task
`6e20693f-1eac-4813-8378-712ca1f1a6d7` and nothing else.

Quality document used: **`docs/plan/os-usable-for-work/03-quality.md`** (per-project
layout). `docs/plan/03-quality.md` also exists and belongs to the round-808 corpus; I
read the per-project one, as the phase-3 gating reviewer did.

---

## Summary — the integration task did its job; the phase is still blocked

The integration task **correctly refused to merge.** The gating reviewer issued
`VERDICT: NEEDS_FIXES`; N9 forbids a merge without a PASS; no merge was attempted, none
was faked, nothing was resolved, no `-X ours`/`-X theirs`, no force-push. On the four
questions my brief asks about the *merge*, the task is clean and I would pass its conduct.

I nevertheless issue **NEEDS_FIXES**, because a review reports the state of the tree, not
the diligence of the author. Two independent grounds:

1. **The precondition my brief names is not satisfied.** It asks me to "confirm the gating
   reviewer issued `VERDICT: PASS` before the merge happened." It did not. Phase 3 is
   therefore **not integrated**, and steps 3 and 5 of my brief have no subject.
2. **The live-checkout cleanliness check — mandatory, run by me, now — is non-empty.**
   That is by itself a NEEDS_FIXES finding. It is also the *same* blocker the gating
   reviewer raised, still unfixed, and no task in the graph is currently assigned to fix it.

---

## 1. The precondition — verified independently, not read off the report

The declared artefact `docs/plan/artifacts/os-usable-for-work/phase3/gate-verdict.md`
**does not exist** at any tip. I recovered the verdict the same way the integration task
did, from `runs.thread` in `content_forge`, run `b1d355d2-80ea-4200-8e6a-4dbfa9e52b62`
(`status=completed`, 124 entries), final assistant message:

```
VERDICT: NEEDS_FIXES
```

I diffed the integration report's §1.2 transcription against the database text: **all four
findings are quoted verbatim and accurately.** The report did not soften or paraphrase the
verdict it was blocked by. Credit where due — that is the honest failure mode.

## 2. Conflict honesty — nothing to resolve, and nothing was resolved

| | |
|---|---|
| Integration tip | `8ae6c7a` |
| `surfaces` tip | `0361c4a` |
| Merge base | `3f98e67` |
| `git log --merges project/7851068b` | no merge commit from this task |
| Commits `surfaces` ahead / behind | 6 / 1 |

No merge commit exists. The one commit the task added (`8ae6c7a`) carries a single file,
the report. Verified by `git log --name-only 3f98e67..project/7851068b`.

## 3. Nothing was clobbered — and I checked it harder than the report did

`git diff project/7851068b-surfaces..project/7851068b -- DesktopApp.tsx nav-items.ts`
returns the whole of phase 3 as *removed*, which is simply the unmerged state, not damage.

The report's §3.1 argued sole ownership from the fact that the integration branch carries
no commits. That is the weaker form of the claim. I checked **every lane**:

```
lane          commits touching DesktopApp.tsx / nav-items.ts (main..lane)
surfaces      08a5ce6  feat(...): four screens that say they were never written
vault         (none)
connections   (none)
business      (none)
perf          (none)
```

**Sole ownership holds across all five lanes. No finding.** Every sibling honoured the
instruction to leave both files alone.

## 4. The tree is green — re-run by me at `8ae6c7a`, not trusted from the report

Both installs printed **`+ typescript`** (devDependencies present under `NODE_ENV`):

```
forge-control      + tsx 4.22.4   + typescript 5.9.3
forge-control-web  + typescript 5.7.2
```

| check | result |
|---|---|
| `forge-control` `npx tsc --noEmit` | EXIT=0 |
| `forge-control-web` `npx tsc --noEmit` | EXIT=0 |
| `forge-control` `pnpm test` | **1293/1293 pass**, 0 fail, EXIT=0 |
| `scripts/checks/no-raw-colours.cjs` | PASS — 222 literals, 0 unlisted, EXIT=0 |
| `scripts/checks/check-r1873-fixes.ts` | ALL PASS, EXIT=0 |
| `scripts/checks/check-phase3-placeholders.ts` | **cannot run — file absent at HEAD** (it is phase-3 work, unmerged) |

### 4.1 `gates-808.sh --strict` — 25 gates, 23 executed, 2 skipped-by-design, 1 RED

Run at `8ae6c7a` with `timeout 600000`. Compared **by gate name** against the fallback
baseline `phase3/gates-phase3.txt` (RED 0), phase 1's `gates-baseline.txt` having not
landed on the integration branch. Every gate name is present in both; every exit code
matches **except gate 18**.

```
 18 1      check-usage-fold.ts — hourly token fold, against a real Postgres
 RED: 1
GATES_EXIT=1
```

**Adjudication — gate 18 is an instrument defect, not a code regression.** The failure is a
Postgres **deadlock**, not an assertion:

```
ERROR:  deadlock detected
DETAIL:  Process 759483 waits for AccessExclusiveLock ...; blocked by process 759484.
Error: psql failed
  sql: TRUNCATE runs, spend_log, usage_hourly
```

Cause: `scripts/checks/check-usage-fold.ts:106` fixes the scratch database name —
`const SCRATCH_DB = process.env.USAGE_FOLD_DB ?? "r1354_sampler"` — and
`scripts/checks/gates-808.sh:195-196` invokes it **without setting `USAGE_FOLD_DB`**. Two
concurrent gate runs therefore `TRUNCATE` the *same* scratch database and deadlock. This
project runs five lanes concurrently by design, so the collision is structural, not bad
luck. The two PIDs in the error are the two runs.

Proof it is environmental: I re-ran gate 18 alone at the same tip —

```
ALL PASS — usage fold (scratch db: r1354_sampler)
ISOLATED_EXIT=0
```

Live data is **not** at risk: lines 109-128 guard that `DATABASE_URL`'s database is not the
scratch name, and the check creates and operates only on `r1354_sampler`. The blast radius
is a false red, nothing worse. **No new red versus baseline is attributable to this tree.**

## 5. Step 5 could not be executed, and I will not fake it

My brief asks for a browser check that "the feature survived the merge" — GOALS showing
'not built' above the fold, the nav marker on exactly four entries — reusing
`verify-phase3.cjs`, with a committed `post-merge-goals.png`.

**There is no merged tree, so there is no post-merge screenshot to take.** Both instruments
the step names are themselves phase-3 work and are absent at HEAD: the entire
`docs/plan/artifacts/os-usable-for-work/phase3/` directory at `8ae6c7a` contains exactly
one file, `integration-report.md`. `verify-phase3.cjs` and
`check-phase3-placeholders.ts` do not exist here to be run.

Measured at source level instead, which settles it without a browser:

```
                                     HEAD (8ae6c7a)   surfaces (0361c4a)
DesktopApp.tsx  "not built"                     0                    10
nav-items.ts    unbuilt marker                  0                     9
```

and on the lane the marker sits on exactly the four unbuilt entries — LIBRARY, GOALS,
JOURNAL, MAP (`nav-items.ts:104,113,114,115`), read off the model by `unbuiltNavKeys()`
rather than listed twice. The feature is intact **on the lane** and wholly **absent from
the integration branch**. That is the unmerged state, correctly.

`post-merge-goals.png` is therefore **not committed**. An image of GOALS at this tip would
show the old empty surface and would be captioned "post-merge" — a lie about the tree.

## 6. Write-set audit — clean

Task `6e20693f-1eac-4813-8378-712ca1f1a6d7` declares 26 paths. Its commits touched exactly
one file:

```
8ae6c7a  docs/plan/artifacts/os-usable-for-work/phase3/integration-report.md
```

That path **is** in the declared `write_set`. **No undeclared write.**

## 7. Findings

### F1 — BLOCKER. The live checkout is dirty (mandatory check, re-run at verdict time)

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx
```

`+85/−1`, the chat-windowing fix cited in the project brief under E1 as "already fixed by
windowing (`AssistantThread.tsx`, 2026-08-18)". It was applied straight into live at
`/opt/forge-ai-os` (branch `main`, `22967d6`) — never through a worktree, never reviewed,
and it is not in either stash. Carried forward unchanged from the gating reviewer's
finding 1; still live, not stale.

**Fix:** revert it in `/opt/forge-ai-os` and redo it on a branch in a worktree, or commit
it there deliberately with a named owner. Barred to every build-phase task by the
worktree-only policy — it needs Konrad or an explicitly-briefed task.

### F2 — BLOCKER (process). No task in the graph is assigned to clear F1

`e282aed9` ("Fix cycle 1 · surfaces", `status=running`) declares a `write_set` of exactly
the five artefacts the gating reviewer failed to write — `gate-verdict.md`,
`gate-goals.png`, `gate-library.png`, `gate-nav-390.png`, `gates-phase3.txt`. It addresses
the *missing evidence*, not the blocker. Nothing in the 47-task graph targets
`/opt/forge-ai-os`. The fix cycle will therefore complete, `da6385eb` will re-review, and
**the same blocker will still be there** — a loop that cannot converge.

**Fix:** seed one task with explicit permission to write to `/opt/forge-ai-os`, or get
Konrad's ruling on the hunk. Until then phase 3 cannot integrate no matter what the
surfaces lane does.

### F3 — The gate-verdict artefact is unwritten and the fallback is undocumented

Four of the gating reviewer's five declared paths do not exist. The verdict survives only
in `runs.thread`. A missing PASS fails safe; a missing **NEEDS_FIXES** reads identically,
and here the recovered verdict happened to agree with the safe default. That is luck.
I concur with the integration report's §5.1 recommendation and restate it as a finding:
either the reviewer role must write the artefact before its task can be `done`, or the
corpus must name `runs.thread` as authoritative. Today it is neither.

### F4 — `gates-808.sh` gate 18 is not concurrency-safe

`check-usage-fold.ts:106` + `gates-808.sh:195-196`, as adjudicated in §4.1. Under the
concurrent-lane execution this project mandates, gate 18 produces a red that has nothing to
do with the code. A flaky red trains readers to discount the suite.

**Fix:** have `gates-808.sh` pass a per-run scratch name, e.g.
`USAGE_FOLD_DB=r1354_sampler_$$`, and drop it afterwards. One line, no widening.

### F5 — The integration report's §6 claims "Did not: Push", but the branch reached origin

```
$ git ls-remote origin | grep 7851068b
8ae6c7a...  refs/heads/project/7851068b
$ git reflog show refs/remotes/origin/project/7851068b
8ae6c7a ...@{0}: update by push
```

`refs/remotes/origin/project/7851068b` is at the integration commit, and the reflog records
an "update by push" from this worktree. There is no engine-level auto-push — `git push` /
`git-sync-branch.sh` appear in `forge-control/src/lib/project-tick.ts` only as *prompt
text*. So either the integration task pushed and misreported, or a sibling did.

Low severity: it is a plain, non-force push of a docs-only commit, which is harmless and
arguably desirable. But the report states a falsifiable "did not" that the tree
contradicts, and in this fleet the evidence record is load-bearing.

**Fix:** determine which agent pushed and correct §6, or state the push explicitly.

### F6 — Fold-ins 2-4 from the gating reviewer are still unapplied

Correctly *not* applied by the integration task (its NEEDS_FIXES path is terminal, and
there is no API that writes `write_set` — `forge-control/src/routes/tasks.ts` exposes no
`router.patch`/`put`/`post` for it). Recorded so they are not lost:

- B3b task row `43395201-0507-4d69-aeec-f6b191cc0af4`: `after-phone-sheet.png` committed in
  `08a5ce6` undeclared. Needs a `write_set` row correction.
- `verify-phase3.cjs:331-332`: swap the two lines so `assertPastTheWall` precedes
  `waitForSelector`, or the `/signin` diagnostic never prints.
- `DesktopApp.tsx:182`: "over 423 files" hardcoded in the present tense; now 488. Date it
  or drop it.

## 8. What passed

- Merge conduct: correct, honest, and correctly terminal.
- Sole ownership of `DesktopApp.tsx` / `nav-items.ts`: intact across all five lanes.
- Write-set audit: clean.
- Verdict transcription: verbatim and accurate.
- Tree at `8ae6c7a`: both typechecks EXIT=0, 1293/1293 tests, `no-raw-colours` PASS,
  `check-r1873-fixes` ALL PASS, gates-808 24/25 green with the one red adjudicated
  environmental and reproduced green in isolation.

Nothing here is a defect in the surfaces lane's code. Phase 3 is blocked on a dirty live
checkout that no lane can reach.
