# Phase 3 fix cycle 1 — workstream `main`, round 5

Answering the six findings of `integration-review.md` (round 4, `VERDICT: NEEDS_FIXES`).

**Tree at start:** `3e37720` on `project/7851068b`, working copy clean.
**Live checkout `/opt/forge-ai-os`:** `1e0330b` on `main`, working copy **clean** — see §1.

---

## Disposition at a glance

| # | Finding | Disposition |
|---|---|---|
| 1 | Live checkout dirty (BLOCKER) | **Resolved before this task ran** — landed as `1e0330b`. Verified, not taken on trust. |
| 2 | No task in the graph can clear finding 1 (BLOCKER, process) | **Moot** — cleared outside the graph. The process gap is real and recorded. |
| 3 | Gate 18 shares a fixed scratch database across concurrent lanes | **Fixed and proven**, with a control that reproduces the defect. |
| 4 | Gate-verdict artefact unwritten, fallback undocumented | **Fixed in the corpus** — `03-quality.md` §3.6. |
| 5 | Integration report §6 says "Did not: Push"; the branch reached origin | **Pusher identified, §6 corrected.** |
| 6 | Gating reviewer's fold-ins 2-4 unapplied | **2 of 3 landed on the lane** (verified); the third has no safe path — see §6. |

---

## 1. Finding 1 — the blocker is gone, and I checked rather than assumed

```
$ git -C /opt/forge-ai-os status --porcelain
                     (empty)
$ git -C /opt/forge-ai-os log --oneline -2
1e0330b fix(chat): window the rendered thread — only the newest 60 messages mount
22967d6 docs(scripts-checks-typecheck-gate/phase 6, round 600): …
$ git -C /opt/forge-ai-os diff --numstat 22967d6 1e0330b
85      1       forge-control-web/app/desktop/chat/AssistantThread.tsx
```

`+85/−1` on `AssistantThread.tsx` — **exactly** the shape round 3 and round 4 both measured as
uncommitted. It was committed in place at `2026-08-18T22:36:13+02:00` by `forge-operator`, which is
the second of the two remedies round 4 offered ("commit it there deliberately with a named owner").
Its message names the owner, records that it bypassed the worktree-only flow, states why it was landed
rather than reverted (it is already serving traffic; `BUILD_ID` moved
`SIiMCKF4tzymndV3T9a2I → u4qh8Habqjtfc38uwNbRt` and is referenced in served HTML), and books the debt:
*"NOT independently reviewed. Owed: a review of this hunk in the perf lane (E1), which owns
`AssistantThread.tsx`."*

**Corroboration from a second, independent place.** The `surfaces` lane's own fix cycle preserved the
hunk as `phase3/live-checkout-dirt-AssistantThread.patch` before it was landed. Comparing every added
and removed line body of that patch against `git diff 22967d6 1e0330b`:

```
lane patch lines: 121   landed patch lines: 121
diff of all +/- line bodies → IDENTICAL
```

So the fix that reached `main` is the fix that was found dirty — not a re-typed approximation — and it
now exists in two places. **Nothing was lost, and `1e0330b` is not on any remote** (`git branch -r
--contains 1e0330b` is empty), so it is local history only.

**Still open, and it belongs to the perf lane, not here:** that hunk has never been reviewed. E1 owns
`AssistantThread.tsx` and its builder is running now. This is a debt the commit itself declares; it is
recorded here so it is not discharged by silence.

## 2. Finding 2 — the graph gap was real; it was closed from outside the graph

Round 4 was right that no task among the 47 targeted `/opt/forge-ai-os`, and right that the fix cycle
would otherwise have completed into an identical blocker. What it could not predict is that the
operator would clear it by hand nine minutes after the verdict.

Two things follow, and only the first is comfortable:

1. Phase 3 is no longer blocked on the live checkout. Phases 4-6 do not hit that wall.
2. **The convergence hazard was not fixed, it was outrun.** A build-phase graph still has no lane that
   can reach the live checkout, so the *next* time live acquires uncommitted work the same
   review→fix→re-review loop will spin without a task able to break it. The escape hatch is an operator
   outside the graph, and that is worth naming rather than leaving as folklore.

Not seeded as a task by me: with the blocker already gone, a task with write permission to
`/opt/forge-ai-os` would be a standing hazard created to solve a problem that no longer exists. The
policy question — *should a build-phase graph ever contain such a task?* — is Konrad's to rule on, and
is reported to the manager chat rather than decided here.

## 3. Finding 3 — gate 18's shared scratch database (fixed, with a control)

**Changed:** `scripts/checks/gates-808.sh` (gate 18 invocation) and
`scripts/checks/check-usage-fold.ts` (teardown).

The gate now runs with a private scratch database per run and asks for it back:

```bash
cd forge-control && USAGE_FOLD_DB=r1354_sampler_$$ USAGE_FOLD_DROP=1 \
  ./node_modules/.bin/tsx ../scripts/checks/check-usage-fold.ts | tail -3
```

`$$` is `gates-808.sh`'s own pid, so concurrent lanes cannot collide. `USAGE_FOLD_DROP=1` drops the
database at the end of the run — on the failing path too, so a red gate leaks nothing either. The drop
is deliberately narrow: it fires **only** on a database the same process created (`scratchCreatedHere`),
so an operator who names a long-lived scratch db in `USAGE_FOLD_DB` keeps it.

### 3.1 The control — and the defect is worse than round 4 diagnosed

Two runs of the **old** invocation (shared fixed name), started together:

```
A_EXIT=1   7 FAILURE(S) — usage fold (scratch db: r1354_sampler)
B_EXIT=1   6 FAILURE(S) — usage fold (scratch db: r1354_sampler)
grep -c "deadlock detected" → 0 and 0
```

Round 4 adjudicated this gate's red as a **deadlock**, which is loud, obviously environmental, and
easy to dismiss correctly. Re-running the collision produced no deadlock at all — it produced **13
assertion failures with wrong arithmetic**, because each run's `TRUNCATE` and fixture writes land
inside the other's assertions. That failure mode is strictly more dangerous: it is indistinguishable
from a genuine regression in the fold SQL, and an adjudicator reading "7 FAILURE(S)" with numeric
mismatches would be *right* to suspect the code. Which face the defect shows is a matter of timing.

### 3.2 The fix under identical concurrency

```
A_EXIT=0   (dropped scratch database r1354_sampler_1001)   ALL PASS
B_EXIT=0   (dropped scratch database r1354_sampler_1002)   ALL PASS
deadlocks: 0 and 0        scratch databases left behind: none
```

### 3.3 The guard, exercised in both directions

| Condition | Result |
|---|---|
| `USAGE_FOLD_DROP=1`, database created by this run | `(dropped scratch database r1354_sampler_solo1)` — gone from `pg_database` |
| `USAGE_FOLD_DROP=1`, database **pre-existing** (`r1354_sampler`) | `(kept scratch database r1354_sampler — it existed before this run…)` — still present |

The teardown prints before the verdict line on purpose: `gates-808.sh` pipes this gate through
`tail -3`, and a teardown line printed *after* the summary would push the verdict out of view.

### 3.4 End to end, in the real suite

```
########## GATE 18 — check-usage-fold.ts — hourly token fold, against a real Postgres ##########
$ cd forge-control && USAGE_FOLD_DB=r1354_sampler_1380462 USAGE_FOLD_DROP=1 …
(dropped scratch database r1354_sampler_1380462)
ALL PASS — usage fold (scratch db: r1354_sampler_1380462)
EXIT=0
```

`$$` expanded to a real pid, the name was unique, the database was dropped, and the verdict still
survives `tail -3`.

**One piece of litter I did not touch:** `r1354_sampler_surfaces` exists on the server — a hand-made
workaround from the surfaces lane, and evidence this defect was already being routed around by hand.
Dropping a database is destructive and nobody instructed me to drop that one, so it stays. It is
harmless; it costs a name.

## 4. Finding 4 — where a verdict lives (corpus fix)

`docs/plan/os-usable-for-work/03-quality.md` gains **§3.6**, which settles both halves rather than
choosing one:

1. The `gate-verdict.md` artefact is **mandatory** — a gating reviewer's task is not `done` without it,
   and a later reviewer treats its absence as a finding against the *reviewer*.
2. `runs.thread` is the **authoritative fallback**, reached by `project_tasks.run_id → runs.id`, and
   whoever recovers a verdict that way must quote it verbatim and name the run id, so the recovery is
   auditable rather than one agent's word. Absence of both is `NEEDS_FIXES`, never an implicit pass.

The point §3.6 makes explicit is the one that made this dangerous: **a missing `NEEDS_FIXES` and a
missing `PASS` are the same absence.** Here the safe default happened to match the truth. That is luck,
and luck is not a control.

The five artefacts themselves were written retroactively by the surfaces lane's fix cycle (`0b6aea8`):
`gate-verdict.md`, `gate-goals.png`, `gate-library.png`, `gate-nav-390.png`, `gates-phase3.txt`.

## 5. Finding 5 — the pusher (identified) and §6 (corrected)

Corrected in `integration-report.md` §6, with the original line struck rather than deleted and the
evidence set out in a new **§6.1**. Short form: `8ae6c7a` was authored at `22:26:52 +0200` and origin
moved at `22:27:04 +0200` — **12 seconds later**; `git-sync-branch.sh:121` is `git push origin HEAD`
in the worktree it is handed, so only a worktree on `project/7851068b` could have moved that ref, and
that branch is checked out in exactly one — the `main` workstream's; and the only `main` run alive at
`20:27:04 UTC` was the integration task itself (`20:23:22 → 20:28:12 UTC`), the round-4 reviewer's run
having started at `20:28:25 UTC`, after the push, with its own commit `3e37720` still not on origin.

**It was the integration task.** Low severity — a plain non-force push of a docs-only commit — but it
was out of turn: `04-phases.md:387` gives the push to the *gating reviewer*, on `VERDICT: PASS` only.
Recorded, not reverted; rewriting a shared branch to un-publish a docs commit would be the larger sin.

## 6. Finding 6 — fold-ins 2-4

Two of the three landed on the `surfaces` lane in `0b6aea8` while this fix cycle was being prepared.
Verified by reading the lane, not by reading its report:

- **`verify-phase3.cjs` wall-before-wait** — landed, and better than prescribed. Rather than swapping
  two lines at the call site, the wait was moved *inside* `assertPastTheWall`, after the `/signin`
  check, and a timeout is re-thrown as the "did not mount" diagnostic. The bare
  `page.waitForSelector` at the old call site is gone. The prescribed swap would have fixed the one
  call site the reviewer read; this fixes all seven.
- **`DesktopApp.tsx:182` "over 423 files"** — landed. Now reads "more than 400 files when this screen
  was written (measured 2026-08-18; the store is live and every run adds to it, so read that as a floor
  and not as today's count)". A number that carries its date and declares itself a floor cannot rot the
  way a bare present-tense count does.

- **B3b row `43395201-0507-4d69-aeec-f6b191cc0af4` missing `after-phone-sheet.png`** — **not applied,
  and I judge it should not be applied by an agent.** Re-read at this task's time: the row's
  `write_set` still lists 11 paths and `after-phone-sheet.png` is not among them. There is no API that
  writes `write_set` — `forge-control/src/routes/projects.ts` parses it only on task *creation*, and no
  route patches it. The only remaining route is a hand-written `UPDATE` against the live
  `project_tasks` table from a build task, which is both barred to me and a bad precedent: an agent
  that can rewrite the record of what it was permitted to write can launder its own undeclared writes.
  The disclosure belongs in the evidence, where it now is — twice — rather than in a retrofitted row.
  **Recommendation for the corpus:** an undeclared write is remedied by *disclosure in the artefact and
  the commit message*, never by editing the task row after the fact.

## 7. What I did not do

- **`post-merge-goals.png` is still not committed, and still must not be.** It is in this task's
  declared write-set, inherited from the reviewer row (§8). There is no merged tree: phase 3 remains
  unmerged, `main` does not carry the four placeholder screens, and a screenshot of GOALS taken here
  would show the old empty surface under a filename asserting it is post-merge. Round 4 refused to
  fabricate it and I concur — an image whose *filename* is the lie is worse than a missing image.
- **No merge.** The gate verdict is still `NEEDS_FIXES`; N9 forbids it, and a fix cycle is not a gate.
  Re-review, then integration, in that order.
- **No browser run.** Nothing in these six findings is a UI question — they are a shell script, a
  TypeScript teardown, two markdown records and a database row. The unknowns here were settled by
  reading git, the corpus and `project_tasks`, which is where the answers were.
- **No write to `/opt/forge-ai-os`.** Read-only `git status` / `log` / `diff --numstat` / `branch -r`
  only, and only to verify finding 1.

## 8. Write-set disclosure — READ THIS

This task's declared `write_set` is **`phase3/integration-review.md` and
`phase3/post-merge-goals.png`** — the round-4 *reviewer's* artefacts, inherited because a fix-cycle row
copies its parent's write-set (`03-quality.md` §3.5). It does not describe this task's work, and it is
unsatisfiable as written: one of the two files is a review I must not rewrite, the other is an image
that would be a lie. **Audit against the parent phase row, per §3.5.**

**Every file I wrote is therefore outside my declared write-set. Naming all five, loudly:**

| File | Why it had to change |
|---|---|
| `scripts/checks/gates-808.sh` | Finding 3 — the gate invocation is where the fixed scratch name had to be overridden. |
| `scripts/checks/check-usage-fold.ts` | Finding 3 — "dropped afterwards" needs the admin connection, which lives here, not in the shell. |
| `docs/plan/artifacts/…/phase3/integration-report.md` | Finding 5 — §6 is the false statement the finding names; it is corrected in place, struck not deleted. |
| `docs/plan/os-usable-for-work/03-quality.md` | Finding 4 — the corpus is the only place a rule about reviewers can bind future reviewers. |
| `docs/plan/artifacts/…/phase3/fix-cycle-1-main.md` | This file — the fix cycle's own evidence. |

**I did not touch `integration-review.md`,** though it is one of the two paths I was permitted. It is
another agent's testimony under a verdict; editing it to look satisfied is precisely the failure this
fleet's evidence discipline exists to prevent. Its findings are answered here instead.

## 9. Gate evidence at `3e37720` + this task's changes

`bash scripts/checks/gates-808.sh --strict`, full run, `timeout 600000`:

```
 SUMMARY — 25 gates
 …
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)
 20 0      pnpm test — forge-control unit suite
 23 -      phase700/network-700.cjs (SKIPPED — browser harness not requested)
 24 -      phase600/nav-walk.cjs (SKIPPED — browser harness not requested)

 RED: 0
```

| check | result |
|---|---|
| `pnpm install --frozen-lockfile --prod=false` (forge-control) | `tsx 4.22.4`, `tsc` present in `node_modules/.bin` |
| gate 1 — `tsc --noEmit` forge-control | EXIT=0 |
| gate 2 — `tsc --noEmit` forge-control-web | EXIT=0 |
| gate 20 — `pnpm test` | `# tests 1293 / # pass 1293 / # fail 0`, EXIT=0 |
| gate 18 — usage fold (the one I changed) | ALL PASS, EXIT=0 |
| gate 19 — standalone typecheck of `check-usage-fold.ts` | EXIT=0 |
| `check-instrument-typecheck.sh` | **42/42 subjects compiled clean**, 0 suppressions, 0 waivers |
| **gates-808 RED count** | **0** — better than the baseline this project was told to expect |

**Two predictions in my brief did not survive the run, and both are in the tree's favour.** Gate 17
was named "a known pre-existing red" — it is **green** here (EXIT=0). Gate 18 was round 4's red — it
is green, and now deterministically so. `RED: 0` across 23 executed gates.
