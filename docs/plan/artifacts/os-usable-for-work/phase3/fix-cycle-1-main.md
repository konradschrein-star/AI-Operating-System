# Phase 3 fix cycle 1 — workstream `main`, round 5

Answering the six findings of `integration-review.md` (round 4, `VERDICT: NEEDS_FIXES`).

**Tree at start:** `3e37720` on `project/7851068b`, working copy clean.
**Live checkout `/opt/forge-ai-os`:** `1e0330b` on `main`, working copy **clean** — see §1.

> **§1–§9 below were written at round 5 and then stranded uncommitted for 21 hours.** They were
> recovered and committed by **fix cycle 2 · `main` (round 7)**, whose own record is **§10**. If you
> are reading this to adjudicate round 7, start at §10.

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
policy question — *should a build-phase graph ever contain such a task?* — went to the manager chat
rather than being decided here.

### 2.1 Konrad ruled, and the ruling reframes the failure

Ruled 2026-08-18, recorded in the vault at `AI OS/Operator Decisions.md`
§ "When the live checkout goes dirty". It takes the middle option and **explicitly rejects** the
standing commit-in-place rule I offered as the third:

> Do not make commit-in-place a standing rule. The operator's commit at `1e0330b` was defensible
> because the provenance was known — the operator wrote it. An agent finding unattributed dirt does
> not know whether it is a live fix, an abandoned experiment, or a mistake, and "commit whatever you
> find" launders all three into `main` identically.

A one-shot task **may** be seeded with permission to commit in place — never to revert — with a named
owner, a declared policy bypass and the review debt booked. The dangerous verb is **DISCARD, not
COMMIT**: committing preserves the work, `git checkout --` annihilates the only copy of something that
may be serving traffic.

**The correction I did not see, and should have.** I framed the four-round spin as *nobody could act*.
The ruling names it differently: *nobody was told*.

> This is the step that was missing: the loop did not spin because nobody could act, it spun because
> nobody was told for four rounds.

That is the sharper reading. Round 3 found the dirt and correctly refused to touch it; round 4 raised
it as a blocker to its reviewer. Neither escalated it to Konrad, who could have cleared it in a minute
— and did, nine minutes after finally hearing about it. The mandatory protocol is now four steps:
check whether the change exists anywhere else (`git log --all -S`), preserve it as a git-apply-able
patch in the phase artefacts, **escalate immediately in the report** naming whether it is the sole
copy, and never revert, discard or `git stash` it.

Measured against that protocol, the surfaces lane got step 2 right on its own initiative — the
`live-checkout-dirt-AssistantThread.patch` it committed is exactly the preservation the ruling now
requires. Step 3 is the one that was missing everywhere.

**Folded into the corpus so this project inherits it:** `01-requirements.md` **N4** now cites the
ruling by heading rather than restating it, per Konrad's own brief-size rule. N4 previously said *do
not touch the live checkout* and was silent on what to do when you find it already dirty — which is
the exact gap that cost four rounds.

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

### 9.1 Gate 17's stale prediction, corrected in the corpus (folded in, not seeded)

`03-quality.md` §3.1 asserted "**Gate 17 is a known pre-existing red**". It is not, and has not been
for the life of this project. Measured `EXIT=0` in **three independent full runs**: both captures
inside the surfaces lane's `phase3/gates-phase3.txt` (one of which has gate 18 red, so the file is not
a single run copied twice) and my run at `3e37720`.

The claim is not merely stale, it is the dangerous direction. A reviewer briefed with "17 is expected
red" would wave through a genuine failure. Gate 17 pins `docs/plan/notification-gap.md` through
`LINE_RULES` (`verify-notification-gap-pins.mjs:248,802-808`) whose context regexes must each match
**exactly one line** of that document — so it goes red when someone reflows or rewords that doc's
prose, which is a true finding against *that edit*, not a standing condition.

Corrected in place, struck rather than deleted, so a reviewer holding the old briefing can see it was
retired deliberately. Folded into this task rather than seeded as a round: it is two sentences of
corpus, and a fix cycle costs a full agent.

---

# 10. Round 7 — fix cycle 2 · `main`: the three round-6 blockers, recovered by hand

Round 6's re-review returned **`VERDICT: NEEDS_FIXES`**. It discharged all six of round 4's findings
and blocked on three conditions that arose *after* them. Everything below answers those three.

**Where the verdict lives.** No `gate-verdict.md` was written for it either; per `03-quality.md` §3.6
the authoritative fallback is `runs.thread`, quoted with its run id. The verdict is message 85 of run
**`09cf3abc-5228-47bd-b61d-537a5a4ea813`** (`completed`, 2026-08-18 23:04:08 → 23:11:44 UTC), reviewing
tip **`f283d5b`**. Read in full before this task started.

**Why this is a hand recovery and not a seeded round.** The re-review run completed while the operator
had the project **paused**. `projectAcceptsWork()` refuses a non-active project, so the fix chain the
verdict implies was never seeded, and the task row sat `running` for **21 hours** with nobody looking.
That is a graph-level failure mode worth naming: *a NEEDS_FIXES verdict delivered into a paused project
produces no work and no alarm* — the same shape as a NEEDS_FIXES that seeds no fix cycle, one layer up.
This task is that chain, seeded by hand as `57f8fdaf-c2c9-4931-8100-eb0392e38d14`.

## 10.1 Blocker 1 — three files stranded uncommitted in the `main` worktree. **FIXED.**

They are this document's own §§2.1/9.1, the N4 rewrite and the gate-17 correction — round 5's answers,
written and never committed:

| File | What it carries | mtime (UTC) |
|---|---|---|
| `docs/plan/os-usable-for-work/01-requirements.md` | **N4 rewritten** — finding 2's answer | 2026-08-18 21:10:51 |
| `docs/plan/os-usable-for-work/03-quality.md` | §3.1 **gate-17 correction** — blocker 2 | 2026-08-18 20:54:40 |
| `docs/plan/artifacts/…/phase3/fix-cycle-1-main.md` | evidence **§2.1** and **§9.1** | 2026-08-18 21:11 * |

\* this file's mtime now reads 2026-08-19 because round 7 is appending §10 to it; the 21:11 figure is
the round-6 reviewer's measurement, quoted rather than re-derived.

**Why it mattered.** `01-requirements.md` **N4** said *do not touch the live checkout* and was silent on
what to do when you find it **already dirty**. That silence is the exact gap that cost this project
four rounds in phase 3 and a fifth in phase 4. Had the integrator merged `project/7851068b` without
these three files, none of the repair would have travelled and N4 would still be silent. The N4 diff
is one line and it cites Konrad's ruling by heading rather than restating it, per his brief-size rule:

> **If you FIND the live checkout dirty**, N4 tells you not to touch it but not what to do — follow the
> standing ruling `AI OS/Operator Decisions.md` § "When the live checkout goes dirty": check whether the
> change exists anywhere else, preserve it as a patch in your phase artefacts, escalate it in your report
> as a blocker naming whether it is the sole copy, and never revert, discard or stash it.

Committed here, on `project/7851068b`, with the write-set position disclosed in §10.5.

## 10.2 Blocker 2 — `03-quality.md:274` "Gate 17 is a known pre-existing red". **FIXED, and re-measured.**

False, and false in the dangerous direction: a reviewer briefed with it waves through a real failure.
The correction was already written into the stranded copy (§9.1), so it lands with blocker 1 and needed
no separate work.

**I did not take the briefing's word for it either.** The brief said four independent measurements show
`EXIT=0`; asserting a gate's status from a briefing is the failure this correction exists to end. Round
7's own full-suite run is the **fifth** independent measurement, and it is recorded verbatim in §10.4.

## 10.3 Blocker 3 — the `goals` ownership question. **SETTLED, recorded, not re-opened.**

Round 6 blocked because `/opt/forge-ai-os` was dirty again with ~180 KB of unbranched Goals/daily work
and gave two acceptable exits: *a one-shot task commits it in place with a named owner*, **or** *the
surfaces lane's `goals` determination is reseeded*. **The first has already happened.** Verified here
against the live checkout, read-only, per N4:

| Fact | Measurement |
|---|---|
| Author of the dirt | Konrad, in chat run **`765e56ad-6c68-4d23-854d-5ea539b39d0c`** — *"Okay I want to structure my days a little bit better. In the Goals tab I want…"* |
| Run window vs. write window | run alive 2026-08-18 **22:08:15 → 23:53:15 UTC**; the reviewer measured the files written 00:17–00:43 +0200 = **22:17–22:43 UTC** — inside it |
| Where it landed | **`553fa38`** *"feat(daily): Goals/Tasks daily surface — commit the work that was already live"*, author `VPS Cat`, 2026-08-19 01:16:03 +0200 |
| Branch | on **`main`** (`git branch --contains 553fa38` → `main`, `operator/cheaper-verification`, `project/8c591d6c`) |
| Size | 26 files, +7938/−11 — `routes/daily.ts`, `db/daily.ts`, `GoalsSurface.tsx`, `0042_daily_goals.sql`, `day-score.ts` + its test, and the `goals/` component tree |
| Live checkout now | `git -C /opt/forge-ai-os status --porcelain` → **empty**, HEAD `9c3f63a` |

So the dirt was never debris: it was **Konrad's own feature, already serving traffic**, and the
non-destructive move — commit, never revert — preserved it. The ownership question is **closed** and
this section is the citation. It is not re-opened here.

### 10.3.1 The consequence that is NOT closed, and belongs to phase 7

Settling ownership does not settle the *content collision* the same blocker named, and it would be
dishonest to let §10.3 read as if it did. At the two tips, on the same file:

```
main:                        DesktopApp.tsx:468   {surface === "goals" && <GoalsSurface />}
project/7851068b-surfaces:   DesktopApp.tsx:137   headline: "GOALS is not built yet."
                             DesktopApp.tsx:143   "…a GoalsSurface — none of the four exists."
                             check-phase3-placeholders.ts:70
                                 EXPECTED_UNBUILT = ["goals","journal","library","map"]
```

`GoalsSurface` **exists**, on `main`, committed. The surfaces lane's phase-3 determination that `goals`
is unbuilt was true when it was measured and is false now. **Failure scenario:** phase 7 merges the
surfaces lane and Konrad clicks GOALS to read *"GOALS is not built yet"* over a surface he used the night
before — or the merge silently reverts `553fa38`'s two lines in `DesktopApp.tsx` and `nav-items.ts`.

This is a **finding for the phase-7 integrator**, recorded rather than fixed: the fix is a one-line
change to `EXPECTED_UNBUILT` plus the placeholder branch, both of which live in the **surfaces** lane's
write-set, not in `main`'s. Writing them from here would be an undeclared cross-lane write to solve a
problem that has an owner. Reported to the manager chat with the same wording.

## 10.4 Verification — the universal block at this tip

`03-quality.md` §3.1, all four steps, `timeout 600000` on the Bash call. Tree: `f283d5b` plus the three
files of §10.1 — i.e. byte-identical to the commit this task produces. Verbatim:

```
=== TIP: f283d5b25babfb146137c869874ff857bb421e48 ===
=== 1. DEPENDENCIES (--prod=false) ===
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 695ms using pnpm v9.15.9          <- forge-control
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 866ms using pnpm v9.15.9          <- forge-control-web
=== 2. TYPECHECK forge-control ===
TSC_FC_EXIT=0
=== 2b. TYPECHECK forge-control-web ===
TSC_FCW_EXIT=0
=== 3. UNIT TESTS forge-control ===
# tests 1293
# suites 239
# pass 1293
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5498.123708
TEST_EXIT=0
=== 4. GATE SUITE ===
================================================================================
 SUMMARY — 25 gates
================================================================================
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)
 13 0      check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does
 14 0      check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces
 15 0      check-team-rows.ts — flatten, hiddenRows, frozen time
 16 0      check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard
 22 0      nav-walk-sampling.cjs — round 807 finding 4, the arithmetic
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 0
GATES_EXIT=0
```

**25 gates · 23 EXECUTED · 2 SKIPPED-by-design (23, 24 — browser harness, needs `--browser`) · RED: 0.**
Both typechecks `EXIT=0`, `1293/1293` tests pass over 239 suites, `GATES_EXIT=0`.

**Gate 17: `0`.** That is the measurement §10.2 owes. Five independent full runs now agree — the two
captures inside the surfaces lane's `phase3/gates-phase3.txt`, the round-5 run at `3e37720`, the round-6
reviewer's run at `f283d5b`, and this one. The stale "known pre-existing red" claim is retired on
measurement, not on authority.

Gate 25 is worth noting on a docs-only commit: it re-runs two evidence protocols and asserts the
working tree's `git status --porcelain` md5 is unchanged (`2abef0eb…` before and after). The three
files of §10.1 were present in the tree during that check and did not perturb it.

## 10.5 Write-set — clean, and here is the arithmetic

Task `57f8fdaf-c2c9-4931-8100-eb0392e38d14` declares exactly:

```
docs/plan/os-usable-for-work/01-requirements.md
docs/plan/os-usable-for-work/03-quality.md
docs/plan/artifacts/os-usable-for-work/phase3/fix-cycle-1-main.md
```

Round 7's commit touches **exactly those three and nothing else. There are no undeclared writes**, and
so — unlike `d2856cf`, whose five paths all fell outside an inherited write-set (§8) — no disclosure
block is required in the commit message and no `§10 Write-set ownership` amendment is owed. (This
project's `04-phases.md` carries no such section; the requirement in the fleet note applies to corpora
that do.) The row was seeded from the *work*, not inherited from a reviewer, which is precisely the
shape `03-quality.md` §3.5 asks for and the reason this audit is one line instead of a page.

Two things I deliberately did **not** write, both of which would have been undeclared:

- **`check-phase3-placeholders.ts` / `DesktopApp.tsx`** — the §10.3.1 collision. Owned by the surfaces
  lane; see above.
- **`integration-review.md`** — still another agent's testimony under a verdict, still untouched.
