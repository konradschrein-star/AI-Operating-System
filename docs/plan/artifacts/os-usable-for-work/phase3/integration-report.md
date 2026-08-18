# Phase 3 integration report — workstream `surfaces`

**Outcome: NOT MERGED.** The phase-3 gating reviewer issued `VERDICT: NEEDS_FIXES`.
Nothing reaches the integration branch without a gating reviewer's PASS (N9), so this
task merged nothing, pushed nothing, and ends here.

Written by the phase-3 integration task, workstream `main`, round 3, 2026-08-18.

---

## 1. Precondition — the gate verdict

Gating reviewer task `3755a6e9-3531-4498-ad99-1f4f458cd84a` (`status=done`,
`workstream=surfaces`, `round=2`), run `b1d355d2-80ea-4200-8e6a-4dbfa9e52b62`
(`status=completed`, 124 thread entries).

### 1.1 The declared artefact does not exist — I had to go to the run transcript

My brief instructs me to read the verdict from
`docs/plan/artifacts/os-usable-for-work/phase3/gate-verdict.md`. **That file was never
written.** It is declared in the reviewer's `write_set` but is absent from the lane tree
and from every worktree on this machine:

```
$ git ls-tree -r --name-only project/7851068b-surfaces -- docs/plan/artifacts/os-usable-for-work/phase3/
  ... 18 files, gate-verdict.md NOT among them ...

$ find /opt/ai-os/workspace -name 'gate-verdict.md' -path '*phase3*'
  (no output)

$ git -C <surfaces worktree> status --short
  (clean — not uncommitted either)
```

The reviewer's own commit `0361c4a` carries exactly one file, `gates-phase3.txt`
(`1 file changed, 367 insertions(+)`). Of its five declared paths, one was written.
`GET /api/tasks/<id>` returns the row with **no `report` field at all** (keys are:
`id, project_id, round, role, title, brief, status, run_id, fix_cycle, tier, attempt,
chain_key, depends_on, workstream, write_set, graph_frozen, created_at, updated_at`).

The verdict was recovered from the run's `thread` column in the runs database
(`postgresql://…@127.0.0.1:5432/content_forge`, table `runs`), the final assistant
message. **This is a finding in its own right — see §5.1.** An integration task whose
precondition is "read the artefact" cannot check its precondition when the reviewer
does not write the artefact, and the fallback is undocumented.

### 1.2 The verdict, verbatim

```
VERDICT: NEEDS_FIXES

1. **`/opt/forge-ai-os/forge-control-web/app/desktop/chat/AssistantThread.tsx`** — uncommitted work hot-applied into the live checkout (`git -C /opt/forge-ai-os status --porcelain` → ` M forge-control-web/app/desktop/chat/AssistantThread.tsx`; +85/−1, the chat-windowing fix). Live checkout must be clean. **Fix:** revert it in `/opt/forge-ai-os` and redo it on a branch in a worktree, or commit it there deliberately with a named owner. Not caused by this phase's diff, and it blocks the merge regardless.
2. **task row `43395201-0507-4d69-aeec-f6b191cc0af4` (B3b), `write_set`** — `docs/plan/artifacts/os-usable-for-work/phase3/after-phone-sheet.png` was committed in `08a5ce6` without being declared. **Fix:** add that path to the row's `write_set`. No fix cycle; fold into the integration task.
3. **`docs/plan/artifacts/os-usable-for-work/phase3/verify-phase3.cjs:331-332`** — `waitForSelector` precedes `assertPastTheWall`, so a `/signin` landing fails with a generic 30 s selector timeout and the salt diagnostic never prints. **Fix:** swap the two lines so the wall assertion runs first.
4. **`forge-control-web/app/desktop/DesktopApp.tsx:182`** — LIBRARY copy hardcodes "over 423 files" in the present tense; the real count is now 488. **Fix:** date the figure or remove it.
```

The reviewer's own summary of the split: *"Findings 2–4 are all fold-ins; **finding 1 is
the blocker.** The phase-3 work itself — B3a's determinations and B3b's placeholders —
meets every one of R37–R43 and I would have passed it on its own merits."*

### 1.3 Blocker 1 re-verified by me, independently, at integration time

Read-only. I did not touch `/opt/forge-ai-os`.

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx

$ git -C /opt/forge-ai-os rev-parse --short HEAD ; git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
22967d6
main

$ git -C /opt/forge-ai-os diff --stat
 .../app/desktop/chat/AssistantThread.tsx           | 86 +++++++++++++++++++++-
 1 file changed, 85 insertions(+), 1 deletion(-)
```

Still dirty, same single file, same +85/−1. The blocker is live, not stale.

---

## 2. Branch state at integration time

| | |
|---|---|
| Integration branch tip `project/7851068b` | `3f98e67114a8a1fd12fced068e2238b51c766462` |
| Lane branch tip `project/7851068b-surfaces` | `0361c4ab1c0efcb499eaeef601ffba14ccd72912` |
| Merge base | `3f98e67114a8a1fd12fced068e2238b51c766462` |
| Merge commit | **none — no merge was attempted** |
| My worktree HEAD (workstream `main`) | `3f98e67` |

```
$ git rev-list --count project/7851068b..project/7851068b-surfaces   → 6
$ git rev-list --count project/7851068b-surfaces..project/7851068b   → 0
```

**The merge base equals the integration tip.** The integration branch has not moved since
the lane branched, so step 2 of the procedure (merge the integration branch into the lane
first) was a no-op and was not needed. The five sibling lanes — `vault`, `connections`,
`business`, `perf` — have **not** merged into `project/7851068b` either; it still sits at
`3f98e67`.

---

## 3. Conflict outcome: NONE — and the merge would have been a fast-forward

Checked without merging, using `git merge-tree --write-tree` (writes a tree object, does
not touch HEAD, the index, or the working tree):

```
$ git merge-tree --write-tree project/7851068b project/7851068b-surfaces
a085d9206402220f5a920a8fbcb681c617677fc7
merge-tree exit=0
$ grep -i conflict <output>
(none)
```

Exit 0 with a bare tree OID and no `CONFLICT` section: **zero conflicting files.** Because
the merge base is the integration tip, this would have been a pure fast-forward — a
conflict was structurally impossible, not merely absent.

### 3.1 `DesktopApp.tsx` — sole ownership holds

My brief flags `forge-control-web/app/desktop/DesktopApp.tsx` (2,867 lines) as the file
most likely to conflict, and says a conflict there is itself a finding naming the other
side's commit. **There is no conflict there and no other side.**

```
$ git log --oneline project/7851068b..project/7851068b-surfaces -- forge-control-web/app/desktop/DesktopApp.tsx
08a5ce6 feat(os-usable-for-work/phase 3): four screens that say they were never written
```

Exactly one commit, and it is the `surfaces` lane's own. No commit on the integration
branch has touched the file — the integration branch carries no commits at all beyond the
merge base. Every other lane honoured the instruction to leave it alone. **No finding.**

---

## 4. Step 3 and step 4 were not run, and that is correct

Step 3 (`pnpm install --frozen-lockfile --prod=false` in both packages) and step 4 (the
typecheck / test / checks block in the merged tree) are both specified to run **after** the
merge. No merge happened, so there is no merged tree to run them against. Running them
against the unmerged integration tip would prove nothing about a merge that does not exist,
and would have produced evidence that reads as if it did.

For the record, the `+ typescript` versus `- typescript` tell my brief asks me to record is
therefore **not applicable — no install was run by this task.** The gating reviewer ran the
same block on the lane side and recorded that neither install printed `+ typescript` **or**
`- typescript` (nothing moved), verifying positively that `forge-control/node_modules/.bin/{tsc,tsx}`
were present under `NODE_ENV=production`.

The "green on each side, red in the middle" failure mode that step 4 exists to catch
**cannot arise for this merge**: a fast-forward produces a tree byte-identical to the lane
tip, which the reviewer already typechecked and tested (`npx tsc --noEmit` EXIT=0 both
packages; `pnpm test` 1293/1293; `gates-808.sh --strict` 25 gates, 23 executed EXIT=0,
2 skipped-by-design, RED 0). That guarantee lapses the moment any sibling lane lands on
`project/7851068b`, at which point this merge stops being a fast-forward and step 4 becomes
load-bearing again.

---

## 5. Findings from this task

### 5.1 The gate verdict artefact was never written, and the fallback is undocumented

`gate-verdict.md` is declared in the reviewer's `write_set` and does not exist (§1.1).
Four of the reviewer's five declared paths are unwritten: `gate-verdict.md`,
`gate-goals.png`, `gate-library.png`, `gate-nav-390.png`. The verdict survives **only** in
the `runs.thread` column of the `content_forge` database. Nothing in the corpus tells an
integration task to look there.

This is the exact failure this fleet keeps re-learning: the instrument, not the code. An
integration task told to gate on an artefact will find the artefact missing and must either
guess, escalate, or know an undocumented database query. A missing PASS artefact is
correctly read as "no PASS" and so fails safe — but a missing **NEEDS_FIXES** artefact
would have been read the same way, and here the recovered verdict happened to agree with
the safe default. That is luck, not design.

**Recommendation:** either the reviewer role must write the verdict artefact before its
task can be marked `done`, or the corpus must name `runs.thread` as the authoritative
verdict store and the artefact as a convenience copy. Pick one; today it is neither.

### 5.2 Finding 2 was assigned to me and I did not execute it — deliberately

The reviewer routes finding 2 (the undeclared `after-phone-sheet.png` on B3b's task row)
to "the integration task" as a fold-in under N8. I did **not** apply it, for two reasons:

1. My brief's NEEDS_FIXES path is terminal and unambiguous: *"Report the blocker verbatim,
   merge nothing, and end."* The fold-in was premised on an integration that is not
   happening; applying it now would edit the record the next fix-cycle reviewer audits,
   while the commit it describes is still unmerged.
2. There is no API for it. `forge-control/src/routes/tasks.ts` exposes no `router.patch`,
   `router.put` or `router.post` handler that writes `write_set`
   (`grep -nE 'router\.(patch|put|post)\(' → no matches`). The only path is a direct
   `UPDATE` against the `tasks` row, which is not a fold-in — it is an out-of-band database
   mutation on another task's record, and it is outside my declared write-set.

It is recorded here so it is not lost. It needs either a fix-cycle row or an explicit
instruction.

### 5.3 Blocker 1 is not this phase's fault, and no phase-3 fix cycle can clear it

The blocker is a dirty file in `/opt/forge-ai-os`, the live checkout — a hot-applied
chat-windowing fix, the same one the project brief cites under E1 as *"already fixed by
windowing (`AssistantThread.tsx`, 2026-08-18)"*. That is where it was applied: straight
into live, never through a worktree, never reviewed.

Phase 3's diff is entirely innocent of it. Consequently **no amount of work inside the
`surfaces` lane can turn this NEEDS_FIXES into a PASS.** The fix is a decision about the
live checkout — revert and redo on a branch, or commit it there with a named owner — and
it is barred to every build-phase task by the worktree-only policy, including this one.
It needs Konrad or an explicitly-briefed task with permission to write to
`/opt/forge-ai-os`.

Until that happens the `surfaces` lane is complete, reviewed, green on its own merits, and
parked at `0361c4a`.

---

## 6. What this task did and did not do

Did:
- Checked the precondition, recovered the verdict from the run transcript.
- Re-verified blocker 1 independently, read-only.
- Recorded both tips, the merge base, and a read-only conflict dry-run.
- Wrote this report.

Did not:
- Merge. No `git merge` was invoked; no merge commit exists.
- Push. `scripts/git-sync-branch.sh` was not run — the push is gated on PASS.
- Deploy, restart anything, or run `pm2 restart forge-executor`.
- Write to `/opt/forge-ai-os` (read-only `git status` / `diff --stat` / `rev-parse` only).
- Resolve, or attempt to resolve, anything — there was nothing to resolve.
