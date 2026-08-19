# phase6/integration-perf.md — MERGE 1 of 3: the perf lane

Integrator: workstream `main`, worktree
`/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`, branch `project/7851068b`.
This is the **first** of three merges carried out in one session (perf → business → connections).
The gate suite is re-run after each merge so that a red is attributable to one merge rather than
to an accumulated three-way mess.

**Outcome: MERGED CLEAN.** Merge commit **`3330996`**.

---

## 0. HEADLINE

| | |
|---|---|
| Lane branch | `project/7851068b-perf`, tip `a080a19` |
| Target | `project/7851068b`, tip before merge `5c8b3e3` |
| Merge base | `3f98e671` |
| Conflicts | **none** — `git diff --name-only --diff-filter=U` was empty |
| Merge commit | **`3330996`** |
| forge-control tsc | exit 0 |
| forge-control tests | **1347 pass / 0 fail** (1293 before the merge — the three new suites really ran) |
| forge-control-web tsc | exit 0 |
| `gates-808.sh --strict` | **EXIT=1, RED: 1 — gate 6 only, and it is the by-design red the phase-6 gate already adjudicated and ACCEPTED** (§5) |

---

## 1. THE PRECONDITION — the gating verdict, taken from the run thread, not from a filename

The perf lane's gate artefact is `phase6/gate-review.md` and it states **`VERDICT: PASS`** twice —
in §0 HEADLINE and restated alone on the last line of the file. The lane tip `a080a19` *is* that
gate's own commit.

Because a gate artefact can be absent or stale, the verdict was independently re-read from the runs
database (the LAST assistant message of the reviewer's run, so that the reviewer's own brief — which
quotes both verdict strings — cannot be mistaken for the answer):

```
task 98cbb26e-ce88-4588-810c-b22dfa27db62  (perf / reviewer / "Phase 6 GATE")
run  created 2026-08-18 21:56:01Z .. updated 2026-08-18 22:10:18Z, status completed
last assistant VERDICT line ->  VERDICT: PASS
```

Cleared to merge.

## 2. THE MERGE

```
$ git status --short
?? docs/plan/artifacts/os-usable-for-work/phase6/     # the pre-merge gate baseline I had just written

$ git log --oneline -1 project/7851068b-perf
a080a19 gate(os-usable-for-work/phase 6, round 3): PASS — the probe fired, the frozen set held, gate 6 adjudicated

$ git merge --no-commit --no-ff project/7851068b-perf
Automatic merge went well; stopped before committing as requested
merge exit=0

$ git diff --name-only --diff-filter=U
                                                       # EMPTY — no conflicts

$ git commit -m "merge(os-usable-for-work/phase 6): perf lane — projects lag fix and reminder retention"
3330996
```

**33 paths** came in: 20 `phase6/` artefacts and 13 source files —

```
forge-control-web/app/MobileApp.tsx
forge-control-web/app/api-perf.ts
forge-control-web/app/api-reminders.ts
forge-control-web/app/desktop/ProjectsSurface.tsx
forge-control/src/db/projects.ts
forge-control/src/db/reminders.ts
forge-control/src/lib/projects-board-limit.test.ts
forge-control/src/lib/projects-board-limit.ts
forge-control/src/lib/reminder-dedup.test.ts
forge-control/src/lib/reminder-retention.test.ts
forge-control/src/lib/reminder-retention.ts
forge-control/src/routes/projects.ts
forge-control/src/routes/reminders.ts
```

Every one of the 13 is on this task's declared write-set.

## 3. WHY THERE WAS NOTHING TO CONFLICT — measured before the merge, not hoped for

Before merging anything I ran the read-only conflict probe for all three lanes
(`git merge-tree --write-tree --name-only`, git 2.43.0, exit 1 == conflict) and listed each lane's
source footprint. The three lanes are **disjoint at file level**:

- perf owns `MobileApp.tsx`, `api-perf.ts`, `api-reminders.ts`, `ProjectsSurface.tsx`, `db/projects.ts`,
  `db/reminders.ts`, `routes/projects.ts`, `routes/reminders.ts` and three new `lib/` modules;
- business owns the Businesses/Pipeline/Money surfaces and `db/pipeline.ts`, `lib/pipeline-health*`,
  `lib/redis-probe*`, `routes/pipeline.ts`;
- connections owns the settings panel, `lib/account-health*`, `lib/connection-status*`,
  `routes/accounts.ts`, `routes/integrations.ts`.

Not one path appears in two lanes. That is a fact about this integration, not a general licence — the
probe is re-run before merges 2 and 3, because each merge moves the tip the next probe must be taken
against.

## 4. THE UNIVERSAL BLOCK, AFTER THE MERGE

`NODE_ENV=production` is exported in this runtime, so every install is `--prod=false`. The tell that
this mattered is that `typescript` was neither added nor removed and `node_modules/.bin/tsc` still
resolves — a bare `--frozen-lockfile` would have printed `- typescript`, exited 0, and made the
typecheck die with `tsc: not found` while looking clean.

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 766ms using pnpm v9.15.9

$ npx tsc --noEmit
exit=0

$ pnpm test
# tests 1347
# suites 253
# pass 1347
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
Already up to date
Done in 864ms using pnpm v9.15.9

$ npx tsc --noEmit
exit=0
```

**The test count is evidence, not decoration.** At the pre-merge tip `5c8b3e3` the same command
reported `# tests 1293 / # suites 239`. After the merge: `1347 / 253`. The **+54 tests / +14 suites**
are perf's `projects-board-limit`, `reminder-dedup` and `reminder-retention` suites. A merge that
carried the files but silently failed to run their tests would have shown 1293 again.

## 5. THE GATE SUITE — RED: 1, AND IT IS NOT NEW

### 5.1 The baseline, taken at the pre-merge tip BEFORE anything was merged

```
$ git rev-parse --short HEAD          # 5c8b3e3
$ bash scripts/checks/gates-808.sh --strict
EXIT=0
 SUMMARY — 25 gates ... RED: 0
```

25 gates, **23 EXECUTED, 2 SKIPPED by design** (gate 23 `network-700.cjs`, gate 24 `nav-walk.cjs` —
both need `--browser`), **RED: 0**. Transcript: `phase6/gates-baseline-premerge.txt`.

This baseline is the whole reason a red after the merge is readable. **Note in particular that gate
17 `verify-notification-gap-pins.mjs` was GREEN here** — see §6.

### 5.2 After the merge

```
$ bash scripts/checks/gates-808.sh --strict
EXIT=1
 ... 6  1      forbidden-file diff — three-dot main...HEAD
 ... 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 RED: 1
```

23 EXECUTED, 2 SKIPPED, **RED: 1 — gate 6 alone**. Transcript:
`phase6/gates-after-merge-perf.txt`.

### 5.3 Gate 6 — what fired, and my own attribution

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
forge-control/src/db/projects.ts
>>> FORBIDDEN FILE DIFFERS
EXIT=1
```

I re-derived the attribution at **my** tip rather than inheriting the lane's, because a three-dot diff
against a moving `main` can implicate a lane that never touched the file:

```
$ git log --format='%h %ci %s' main...HEAD -- forge-control/src/db/projects.ts
27faa28 2026-08-18 23:14:56 +0200 fix(os-usable-for-work/phase 6, round 1): the board poll's payload — column-project the query, do not window the board

$ git diff --name-only main...3f98e671 | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
(empty)
```

One file, one commit, the perf lane's own, and the merge base was clean for the same predicate. An
empty `git log` over the other five forbidden paths is positive proof no sibling lane contributes a
hit — which a diff alone cannot give.

### 5.4 It was already adjudicated, and the adjudication is quoted rather than re-litigated

This red is **not new at merge time**. The phase-6 gating reviewer hit exactly this, wrote it up in
`phase6/gate-review.md §5.1–§5.5`, and **ACCEPTED** it before issuing PASS. Its §5.5, verbatim:

> **ACCEPTED.** The risk is confined to one read-only query behind one UI endpoint with one caller;
> the change is declared on the task's `write_set`; it was disclosed in advance in the commit message
> ("db/projects.ts IS on gates-808.sh:143's forbidden-file list and that gate will go red by design")
> and in `projects-lag-after.md §5`; and the alternative that would have kept the gate green is a
> weaker fix. Silently accepting this and silently failing it are both review failures — this is the
> written adjudication the brief requires, and the decision is to accept.

I did not re-open that decision; the integrator's job is to confirm the red is the adjudicated one and
nothing else, which §5.3 does. **The gate will stay at `RED: 1` for merges 2 and 3.** From here on
"green" means *RED: 1, gate 6 only* — anything else is new and belongs to whichever merge produced it.
Saying "the suite is green" after this point would be false, and saying "the suite is red" without
this paragraph would be equally useless.

## 6. THE PREDICTED GATE-17 RED DID NOT HAPPEN — recorded because it was expected in writing

The connections brief warned at length that gate 17 would go red on merge: `ALL PASS 92/92` on the
lane, **20 FAILURES** after main merges in, because main's `6a9406d` and `1e0330b` shift every line
the verifier pins. Measured here: gate 17 is **0 (green)** both at the pre-merge baseline `5c8b3e3`
and after merging perf. Reported as measured. Whether it survives merges 2 and 3 is re-measured
there rather than assumed in either direction.

## 7. BOUNDARIES OBSERVED

- Merged into `project/7851068b` only. **Not** into the repo's `main` — that is phase 7's, with its
  own deploy procedure.
- No push, no PR, no deploy, no `pm2 restart` of anything.
- `/opt/forge-ai-os` not touched. Its state is reported in §8.
- Nothing was patched to make a check pass. The one red is quoted and attributed, not fixed.

## 8. THE LIVE CHECKOUT — the operator ruling in brief 1/3 IS ALREADY DISCHARGED

Brief 1/3 carried an operator ruling instructing me to commit an uncommitted
`AssistantThread.tsx` windowing fix (+85/−1) in place, on `main`, in `/opt/forge-ai-os`. **There is
nothing there to commit.** Measured at the start of this run:

```
$ git -C /opt/forge-ai-os status --porcelain
                                          # EMPTY — the live checkout is CLEAN
$ git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
main
$ git -C /opt/forge-ai-os log --oneline -3
9c3f63a merge: cheaper verification — review only what can break, Sonnet by default
de7b603 feat(prompt): review only what can break, and stop defaulting every task to Opus
553fa38 feat(daily): Goals/Tasks daily surface — commit the work that was already live
```

The ruling described the tree as dirty and my task header described it as "clean at `1e0330b`".
Neither is current: live `main` has moved on to **`9c3f63a`**, three commits past `1e0330b`, and the
work has been landed by an earlier round. The ruling's four sub-requests (compare tree against the
saved patch, re-derive tsc/tests at the committed tree, word the commit message as a disclosed
bypass, then sweep for other dirt) are **moot for the first three** — the commit exists and I must not
rewrite published history to re-word it. The fourth is answered: the sweep found **nothing dirty**.

I did not touch the live checkout in any way; the commands above are read-only.
