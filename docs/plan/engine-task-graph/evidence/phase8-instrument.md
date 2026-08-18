# Phase 8B — the instrument learns to exclude a never-ran task, by id and with a reason

Round 802, builder 8B. Everything below happened in the project worktree
`/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`, on branch
`project/8c591d6c`. **No live endpoint, no live database, no `content_forge`, no
`--project` run, and `/opt/forge-ai-os` was neither read from nor written to** —
`git -C /opt/forge-ai-os status --porcelain` is empty and is pasted in §7.2. Step
2b's live read belongs to round 810 and is untouched here; every claim below is
proved against a fixture.

---

## §0 — the cross-phase write, declared before anything else

Three of my six files are **phase 7's** under `04-phases.md` §10:

```
scripts/measure-schedule.ts
forge-control/src/lib/schedule-metrics.ts
forge-control/src/lib/schedule-metrics.test.ts
```

This is a **declared cross-phase write, not a smuggled one.** Builder 8C records
it in §10's table in this same round, by the precedent that table already sets
for rounds 213, 215, 222, 231 and 239. It is unavoidable rather than convenient:
E-3's step 2b is a phase-8 obligation that cannot be discharged without changing
the phase-7 instrument it runs, because the instrument refuses on rows phase 7
never anticipated. My other three files —
`evidence/baseline-8ea0cc08.md`, `00-vision.md` and this transcript — are already
phase 8's by E-3.

I wrote **no other file.** In particular I did not touch `01-requirements.md`,
`03-quality.md` or `04-phases.md`, which builder 8C owns in this round, nor
`scripts/deploy/`, which builder 8D owns. §9 lists exactly what I staged.

---

## §1 — the blocker, reproduced rather than quoted

`assertRunsResolvable()` in `forge-control/src/lib/schedule-metrics.ts` — D6,
refusal string `unresolvable-run` — refuses any task that is not `pending` and
carries no `run_id`. `operator-visibility` (8ea0cc08) is `done` with 159/159
tasks, zero unterminated runs, and exactly **three** such rows, none of them
corruption and each explicable (round 800's measurement; the operator's own
confirmation). Step 2b therefore could not run at all.

I reproduce the refusal on a fixture rather than restating it. The fixture is
five rows that really ran plus one row a human closed — the shape of all three
8ea0cc08 rows. It is built in `/tmp` and NOT committed, because a new file under
`forge-control/src/lib/fixtures/` would be a write outside my declared set; the
generator is pasted in §3.0 so a reviewer reproduces it in one command.

```
$ cd forge-control && ./node_modules/.bin/tsx ../scripts/measure-schedule.ts full --fixture /tmp/d8-demo.json
== measure-schedule — instrument identity (R60) ==
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          e54be104ff35a12c9a6e080d9654d1ba1ab7d299 -dirty
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              full
source:            fixture:/tmp/d8-demo.json sha256=0eb6bc18266b6e4977762380ccf88bcde8a11a186464d7bebc4c64e128f62633
project:           00000000-0000-4000-8000-0000000d8000
depends_on:        present (6/6 fixture rows carry a depends_on key)
window:            full project (no --from/--to given)
census:            tasks=6 runs=5 top-level=5 sub-agent=0 archived=0 tasks-without-run=1 legacy-rows=0 graph-rows=6 closure-shaped-rows=2
excluded-tasks:    none (--exclude-task not given)

MEASUREMENT FAILED: unresolvable-run
  - task 00000000-0000-4000-8000-00000000cfff (status done, round 1350) has no run_id, and only a 'pending' task may have none
exit=1
```

That is the blocker, executed. Note `tasks-without-run=1` in the census: the
header already disclosed the row before the refusal named it, which is R60 and
R61 working together and is why the fix is an exclusion rather than a repair.

**On `git-head` disagreeing between sections.** The demo runs of §1 and §3 print
`e54be104…`; §5's baseline re-runs print `3dd39b4…`. Builders 8C and 8D committed
between the two, and `git-head` names the TREE at run time, so it moved and
`instrument-sha256` did not. That is the header's documented behaviour observed
in the wild rather than a discrepancy — and it is the reason R62's guarantee is
keyed to the self-hash and not to a commit id.

---

## §2 — D8, and why it is not a blanket flag

**The operator's ruling is the specification and I implemented it literally.**
Exclude by id, print the reason, disclose the count in the same shape as
`excluded.unterminatedRunIds`, refuse anything that could swallow a genuinely
lost run.

D8 is recorded as the eighth semantic decision in `schedule-metrics.ts`'s header
list — the list read "THE SEVEN SEMANTIC DECISIONS" and now reads EIGHT, changed
in the same commit that adds the decision. Nothing outside that file names the
count; verified by `grep -rn "SEVEN SEMANTIC\|seven decisions" --include='*.md'
--include='*.ts' --include='*.py'`, which returns nothing else.

### 2.1 The gap in the schema, which is not a defect in D6

D6's second clause is correct as written: a non-`pending` row with no `run_id`
either lost its run or is a project caught mid-flight, and R61 says refuse rather
than measure an unfinished thing. What it cannot see is a third case the schema
does not record: **a task can reach `done` without ever running, because a human
closed it.** The operator's middle row is exactly that — a task he created on
2026-08-17 and closed as superseded before it promoted, to stop two agents
editing the same instrument files in one worktree.

So the operator names the rows and the instrument checks his claim. That is the
whole design, and it is one sentence longer than the blanket flag it replaces.

### 2.2 The three refusals, and which one is the point

| reason | fires when | why it is not optional |
|---|---|---|
| `excluded-task-has-run` | the named task has a `run_id` | **THE GUARD.** A genuinely lost run cannot be laundered out of the denominator by the flag that exists for rows a human closed. Keys on `run_id`, *not* on `status` — a `done` row is precisely what is being excluded, so refusing on status would refuse all three of the operator's rows. |
| `excluded-task-unknown` | the id names no task in the measured set | a typo must not silently exclude nothing and leave the operator reading a census three rows larger than he believes he asked for |
| `excluded-task-duplicate` | the same id twice | `neverRan.length` is the number a reader subtracts from the census; a repeat would inflate it past the rows actually dropped |

All three are decided **before any row is dropped**, the same no-partial-result
property `computeSchedule()` already has for its own refusals.

### 2.3 Order of operations, and the floor

`computeSchedule()` now runs: **D8's exclusion → `too-few-tasks` on what remains
→ D6's `unresolvable-run` on what remains → everything else.**

`too-few-tasks` moved *after* the exclusion deliberately. Evaluated before it, a
five-row project could shed three rows and report an S1 over two — the flag
smuggling a project under R61's floor. Evaluated after, five minus three is a
two-row measurement and R61 says there is no schedule in two rows. The refusal
detail states both numbers so a reader is not left to infer which set was
counted:

```
project <id> has 4 tasks, fewer than the 5 R61 requires
5 rows were handed in and 1 were excluded by id (<id>); the floor is evaluated on what remains, never on what arrived
```

### 2.4 One definition, two call sites — the brief's named hazard, structurally

> *An `--exclude-task` that drops the row from the ROUND TABLE but not from D6's
> check, or vice versa, passes a happy-path test and refuses on the live read at
> round 810, mid-deploy.*

The answer is structural rather than careful. `excludeNeverRanTasks()` is
**exported** from `schedule-metrics.ts` and is the only implementation.
`scripts/measure-schedule.ts` calls it once for its census, header and round
table — including in `rounds` mode, where `computeSchedule()` is never called at
all — and then hands `computeSchedule()` the **full** task set plus the same ids,
so D6's exclusion is the same function over the same input.

Three consequences a reviewer should check rather than take:

1. The wrapper passes `input.tasks`, **not** `exclusion.kept`. Passing `kept`
   with the ids would make every id `excluded-task-unknown`; passing `kept`
   without them would leave `excluded.neverRan` empty and the exclusion
   undisclosed in `full` mode.
2. Because it is called twice on the same array, the function **must not
   mutate** it. It does not, and that is asserted with a mutation watched
   failing (M12, §4.2) rather than left to review.
3. `assertExclusionAgrees()` in the wrapper compares the two reported id lists
   and throws `exclusion-disagreement` if they differ. Unreachable as written —
   the same sense in which `assertIdentifiedProject()` beside it is unreachable —
   and asserted anyway, because "by construction" is a claim about today's code.
   **It covers one of the three ways the coupling can break, and §3.4 says which
   and names what covers the other two.** It compares the ids each side says it
   dropped; it cannot see a break that changes both sides identically.

### 2.5 The declared-refusal list, now gated rather than remembered

Round 214's phase-7 review found `unterminated-run` thrown and not declared in
`MeasurementError`'s doc-block: *"a list of refusals that is itself incomplete is
the same defect one level up"*. My three reasons are in that list, and the list
is now **checked in both directions** by
`describe("the declared-refusal list is complete in BOTH directions")`, which
reads the module's own text and compares:

- every `new MeasurementError("…")` literal in the file, against
- every quoted name declared in the doc-block,

and fails if either set has a member the other lacks. The mirror defect matters
as much as the original: a *declared* reason the module can no longer throw reads
as authoritative and is wrong. Both directions are watched failing (M7, M8).

The suite also refuses to certify itself: `test("the probes are not vacuous")`
fails if either regex finds fewer than ten reasons, so a pattern that stopped
matching cannot report a clean pass by leaving both sets equally empty
(`00-vision.md` §7 rule 2). M7 tripped it, visibly, in §4.2.

---

## §3 — the flag, executed

### 3.0 The fixture, reproducible in one command

Five rows that ran (rounds 100, 100, 101, 101, 102) and one `done` row at round
1350 with `run_id: null`. Not committed — a fixture file under
`forge-control/src/lib/fixtures/` would be a write outside my declared set, and
the brief prefers object factories for exactly this reason.

```python
python3 - <<'PY'
import json
P="00000000-0000-4000-8000-0000000d8000"
tasks=[]; runs=[]
for i,(rd,fro,to) in enumerate([(100,"10:00","10:12"),(100,"10:02","10:20"),(101,"10:21","10:35"),(101,"10:22","10:30"),(102,"10:36","10:44")],start=1):
    tid=f"00000000-0000-4000-8000-00000000a{i:03d}"
    rid=f"00000000-0000-4000-8000-00000000b{i:03d}"
    tasks.append({"id":tid,"project_id":P,"round":rd,"role":"builder","title":f"ran {i}","status":"done","created_at":f"2026-08-16T{fro}:00.000Z","run_id":rid,"depends_on":[]})
    runs.append({"id":rid,"parent_run_id":None,"status":"completed","created_at":f"2026-08-16T{fro}:00.000Z","started_at":f"2026-08-16T{fro}:00.000Z","completed_at":f"2026-08-16T{to}:00.000Z","updated_at":f"2026-08-16T{to}:00.000Z","archived":False,"wake_after":None})
tasks.append({"id":"00000000-0000-4000-8000-00000000cfff","project_id":P,"round":1350,"role":"builder","title":"[VOID] closed by the operator, never ran","status":"done","created_at":"2026-08-16T10:40:00.000Z","run_id":None,"depends_on":[]})
json.dump({"project_id":P,"tasks":tasks,"runs":runs},open("/tmp/d8-demo.json","w"),indent=1)
PY
```

It hashes to `sha256=0eb6bc18266b6e4977762380ccf88bcde8a11a186464d7bebc4c64e128f62633`,
which every run below prints in its own header.

### 3.1 `full` with the exclusion — the blocker cleared

```
$ cd forge-control && ./node_modules/.bin/tsx ../scripts/measure-schedule.ts full \
    --fixture /tmp/d8-demo.json --exclude-task 00000000-0000-4000-8000-00000000cfff
== measure-schedule — instrument identity (R60) ==
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          e54be104ff35a12c9a6e080d9654d1ba1ab7d299 -dirty
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              full
source:            fixture:/tmp/d8-demo.json sha256=0eb6bc18266b6e4977762380ccf88bcde8a11a186464d7bebc4c64e128f62633
project:           00000000-0000-4000-8000-0000000d8000
depends_on:        present (6/6 fixture rows carry a depends_on key)
window:            full project (no --from/--to given)
census:            tasks=5 runs=5 top-level=5 sub-agent=0 archived=0 tasks-without-run=0 legacy-rows=0 graph-rows=5 closure-shaped-rows=2
excluded-tasks:    1 never-ran task(s) removed by --exclude-task, and absent from every count above: 00000000-0000-4000-8000-00000000cfff

-- round / task table (00-vision.md §2) --
  round   tasks
    100       2
    101       2
    102       1
  3 rounds, 5 tasks, 1.67 tasks per round
  1 never-ran task(s) excluded by id and NOT counted above:
    00000000-0000-4000-8000-00000000cfff

-- run and wall-clock totals --
  runs measured (top-level, in scope)   5
  mean run duration (min)               12
  summed run time (min)                 60
  wall clock (min)                      44

-- S1 / S2 / S3 (00-vision.md §4) --
  S1 mean concurrency                   1.36 (peak 2, over 44 per-minute samples)
  S2 parallelism ratio                  0.73 (wall clock ÷ summed run time; lower is more parallel)
  S3 max numbering stall (min)          NOT COMPUTABLE (0 legacy rows, 2 closure-shaped rows)
     reason: no task in this project has both a non-empty depends_on and a run that was claimed, so there is no edge to measure a stall across. Reporting 0 here would read as 'no numbering stall' when the truth is 'no measurement'.

-- disclosures (schedule-metrics.ts D1, D2, D4, D5, D8) --
  sub-agent runs, EXCLUDED              0
  archived top-level runs, INCLUDED     0
  runs never started (no started_at)    0
  runs started and never terminated     0
  never-ran tasks, EXCLUDED by id (D8)  1
    00000000-0000-4000-8000-00000000cfff
…
exit=0
```

Three places state the exclusion — the header, under the round table, and among
the disclosures — and the census moved from `tasks=6` to `tasks=5` and
`tasks-without-run=1` to `0`. The operator's requirement that "the exclusion must
be visible where the numbers are read" is satisfied at every place numbers are
read, not at one of them.

### 3.2 The three refusals, executed

```
$ … full --fixture /tmp/d8-demo.json --exclude-task 00000000-0000-4000-8000-00000000a001
MEASUREMENT FAILED: excluded-task-has-run
  - task 00000000-0000-4000-8000-00000000a001 (status done, round 100) names run 00000000-0000-4000-8000-00000000b001, so it RAN — --exclude-task drops rows that never ran, and a lost run is a finding rather than an exclusion
exit=1

$ … full --fixture /tmp/d8-demo.json --exclude-task 00000000-0000-4000-8000-00000000cffe
MEASUREMENT FAILED: excluded-task-unknown
  - task 00000000-0000-4000-8000-00000000cffe was named by --exclude-task but is not one of the 6 tasks in the measured set
exit=1

$ … full --fixture /tmp/d8-demo.json --exclude-task 00000000-0000-4000-8000-00000000cfff --exclude-task 00000000-0000-4000-8000-00000000cfff
MEASUREMENT FAILED: excluded-task-duplicate
  - task 00000000-0000-4000-8000-00000000cfff was named more than once by --exclude-task
exit=1
```

`…cffe` is `…cfff` with one character changed — the typo case, refused by name.

### 3.3 `rounds` mode states it too

```
$ … rounds --fixture /tmp/d8-demo.json --exclude-task 00000000-0000-4000-8000-00000000cfff
census:            tasks=5 runs=5 top-level=5 sub-agent=0 archived=0 tasks-without-run=0 legacy-rows=0 graph-rows=5 closure-shaped-rows=2
excluded-tasks:    1 never-ran task(s) removed by --exclude-task, and absent from every count above: 00000000-0000-4000-8000-00000000cfff
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.

-- round / task table (00-vision.md §2) --
  round   tasks
    100       2
    101       2
    102       1
  3 rounds, 5 tasks, 1.67 tasks per round
  1 never-ran task(s) excluded by id and NOT counted above:
    00000000-0000-4000-8000-00000000cfff
exit=0
```

### 3.4 The coupling, attacked from three directions

`assertExclusionAgrees()` is unreachable in the shipped file, so it was proved by
breaking the coupling it guards — three ways, each applied to a clean tree, run
against the fixture, and restored by the harness's `finally`. `sha256sum
scripts/measure-schedule.ts` reads `6ec72b35…` after all three, and §5.4's
checker run is the independent confirmation.

**W1 — the wrapper stops passing the ids to `computeSchedule()`.** The round
table excludes; D6 does not. This is the brief's named hazard, verbatim.

```
$ (mutated) … full --fixture /tmp/d8-demo.json --exclude-task …cfff
MEASUREMENT FAILED: unresolvable-run
  - task 00000000-0000-4000-8000-00000000cfff (status done, round 1350) has no run_id, and only a 'pending' task may have none
exit=1
```

It never reaches `assertExclusionAgrees()`: **D6 fires first**, one step earlier,
with the refusal the divergence was supposed to have prevented. Caught, but not
by the line I built for it — recorded that way rather than credited to the guard.

**W2 — `excludeNeverRanTasks()` stops reporting what it excluded.** Exit **0**,
no stderr, and **the guard does not fire.** That is the design's own shape read
back: both call sites go through the one function, so breaking the function
breaks them *symmetrically* and they still agree. The unit suite is what catches
this one — it is M6 in §4.2, watched failing. Reported because a guard that
cannot see a whole class of break should be described as what it is.

**W3 — the OPPOSITE divergence: `computeSchedule()` excludes and the round table
does not.** The one direction no earlier refusal catches, because D6 is happy and
the round table quietly keeps the row:

```
$ (mutated) … full --fixture /tmp/d8-demo.json --exclude-task …cfff
MEASUREMENT FAILED: exclusion-disagreement
  - this wrapper excluded [] from the census and the round table
  - computeSchedule() reported excluded.neverRan = [00000000-0000-4000-8000-00000000cfff]
  - the round table and D6's resolvability check must be computed over one task set; they were not
exit=1
      stdout| excluded-tasks:    none (--exclude-task not given)
```

**So the honest account of the guard is:** it catches the direction nothing else
does (W3, observed), it is pre-empted by D6 in the other direction (W1,
observed), and it is blind to a symmetric break of the shared function (W2,
observed) — which the unit suite catches instead. Three mechanisms, none of them
sufficient alone, and the map of which covers what is above rather than assumed.

---

## §4 — the tests, and each new assertion watched failing

### 4.1 What was added

`forge-control/src/lib/schedule-metrics.test.ts`, in the file's existing style:
type-only `db/*` through the module under test, rows hand-built by `mt()`/`mr()`,
refusals asserted through `expectMeasurementError()` on the error VALUE.
**NF3 holds: no test opens a database.** Section 11 reads one file from disk —
the module's own source — because a doc-comment is not reachable any other way,
and there is ample precedent (`cp2-reconciler-interaction.test.ts`,
`cp3-linkage.test.ts`, `executor-completion-guard.test.ts`, `source-hygiene.test.ts`).

```
$ cd forge-control && ./node_modules/.bin/tsx --test src/lib/schedule-metrics.test.ts
ok 1 - roundTable / roundSummary — the §2 table shape
ok 2 - concurrency sampling and S2 (the parallelism ratio)
ok 3 - D1 — sub-agent runs are excluded from every number
ok 4 - D4 — a parked run contributes 0 because it was never claimed
ok 5 - R61 / D6 — the exit conditions
ok 6 - D7 — the numbering stall
ok 7 - D7 — a project carrying migration 0040's backfilled closure
ok 8 - D7 — the pre-0040 read at step 2b refuses on the legacy sentinel
ok 9 - D7 — the stall clamps at 0 and never goes negative
ok 10 - R60 — inputCensus
ok 11 - D8 — --exclude-task drops a never-ran row, and only a never-ran row
ok 12 - the declared-refusal list is complete in BOTH directions
# tests 58
# suites 12
# pass 58
# fail 0
# skipped 0
# todo 0
```

The section-11 base is deliberate: sections 10 and 11 are built on five rows that
are *proved to compute cleanly* by the very first assertion of section 10, so no
refusal below can be caused by a malformed base rather than by the one row under
test. That is guard 3 of the file's own doc-comment, applied to new work.

### 4.2 The mutation ledger — thirteen mutations, each reverted

**A test that has only ever been observed passing is the defect this project
keeps catching.** Every new assertion below was watched failing first. Each
mutation was applied to a clean tree, `tsx --test src/lib/schedule-metrics.test.ts`
was run, and the file was restored from the pre-mutation bytes by the harness's
`finally` — so a mutation cannot survive a crash.

| # | the mutation | what failed |
|---|---|---|
| **M1** | `assertRunsResolvable(measured, …)` → `(input, …)` — **the brief's named hazard**: the exclusion reaches the round table, not D6 | `excluding it changes the round table — and NOTHING else`; `excluded.neverRan is populated…`; `too-few-tasks is evaluated AFTER the exclusion…` (3 fail) |
| **M2** | the `excluded-task-has-run` push deleted — the guard removed | `excluding a task that HAS a run_id refuses, naming the id and its run` |
| **M3** | an unknown id silently excludes nothing | `excluding an unknown id refuses — a typo must not exclude nothing quietly` |
| **M4** | a duplicate id silently de-duplicated | `a duplicate id refuses — neverRan.length is a count a reader subtracts` |
| **M5** | `if (kept.length < 5)` → `if (input.tasks.length < 5)` — the floor on what ARRIVED | `too-few-tasks is evaluated AFTER the exclusion, never before` |
| **M6** | `neverRan` reported as `[]` — the rows leave, the count does not say so | `excluded.neverRan is populated, in the order the ids were given` |
| **M7** | `"excluded-task-duplicate"` renamed in the declared list | `every reason the module throws is declared`; `D8's three reasons are in the list by name`; **and `the probes are not vacuous`**, which is the positive control noticing the list shrank to 9 |
| **M8** | a `"never-thrown"` reason ADDED to the declared list — the mirror defect | `every declared reason is one the module can actually throw` |
| **M9** | D6's second clause deleted — a never-ran task stops being refused at all | `the D6 refusal still fires for a never-ran task that was NOT excluded`; and the pre-existing `a non-pending task with no run_id at all throws unresolvable-run` |
| **M10** | `kept: tasks.filter(…)` → `kept: tasks` — the exclusion not applied at all | 5 assertions across both suites |
| **M11** | `neverRan: [...ids]` → `[...ids].sort()` — the disclosure re-derived instead of echoed | `excluded.neverRan is populated, in the order the ids were given` |
| **M12** | an **in-place** `splice` — the caller's array mutated under the second call | `it does not mutate the caller's array — the exclusion runs TWICE on it`, plus `excluding a task that HAS a run_id refuses` and `excluding an unknown id refuses`, which is the live-read failure of §2.4(2) reproduced exactly |
| **M13** | the empty request returns a copy instead of the same array | `excludeNeverRanTasks is the one definition, and it preserves input order` |

Two of these deserve a sentence rather than a row.

**M7 is the one that proves the gate is not decorative.** Renaming a declared
reason made *three* assertions fail, and the third was the positive control —
`the probes are not vacuous` — noticing that the declared set had fallen below
ten. A regex that silently stopped matching would have taken the same path and
been caught the same way, which is the whole reason that control exists.

**M12 is the live-read failure, reproduced in the worktree.** An in-place filter
passes a single-call test and then fails on the *second* call, so the wrapper's
census sees the row gone and `computeSchedule()` reports every id
`excluded-task-unknown`. That is precisely "passes a happy-path test and refuses
on the live read at round 810, mid-deploy", and it now costs one `tsx --test`.

Verbatim output of the two mutation sweeps (exit code, the failing test names,
and the pass/fail census of each run) is reproducible with the harness in
`/tmp/mutate.py`; the summary above is a faithful transcription of it and every
row was observed, not predicted.

### 4.3 The whole suite, after

```
$ cd forge-control && pnpm typecheck
> tsc --noEmit
exit 0

$ cd forge-control && pnpm test
1..254
# tests 1270
# suites 235
# pass 1270
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5048.838609
exit 0
```

**1256 → 1270: +14 tests, +2 suites, zero failures, zero skipped.** Round 801
measured 1256 after its merge; the delta is exactly the twelve D8 assertions and
the four refusal-list ones, less the one section-10 test that replaced nothing.

---

## §5 — E-3's consequence: the instrument moved, so part 1 was re-run

Editing `scripts/measure-schedule.ts` moved its self-computed identity from
`f6828a68…` `[historical instrument]` to `6ec72b35…`, which puts
`check-instrument-identity.py` — universal gate item 7, `03-quality.md` §3.1 —
RED across eight pasted headers in `evidence/baseline-8ea0cc08.md` and §2.2's
heading in `00-vision.md`. E-3 states the obligation: re-run part 1's seven
commands and replace their headers **in the same commit**. Part 2 is round 810's
job; this commit is where the re-run happens, so **no commit between them leaves
the gate red — because there is no commit between them.**

### 5.1 The containment check, run TWICE — and the first run is the one that matters

The brief's second named instrument-lie:

> *A re-run of part 1 that pipes stdout into the document without comparing it to
> what was there would replace a moved number with a straight face.*

So the comparison was made **before a line of the instrument was edited**, under
the OLD bytes, against the blocks as round 217 pasted them:

```
$ python3 /tmp/containment.py /tmp/pre      # instrument on disk: f6828a68… [historical instrument]
§2.1 run-A: pasted round table (90 lines) REPRODUCES byte for byte
§2.2 run-B: pasted round table (19 lines) REPRODUCES byte for byte
§2.3 run-D: pasted round table (88 lines) REPRODUCES byte for byte
§2.4 run-E: pasted round table (8 lines) REPRODUCES byte for byte
§2.5 run-F: pasted round table (15 lines) REPRODUCES byte for byte
§2.6 run-G: pasted round table (84 lines) REPRODUCES byte for byte
§3  run-C: pasted refusal text (5 lines, incl. exit=1) REPRODUCES byte for byte

0 disagreement(s)
exit=0
```

…and again after the edit, under the new bytes, still before the headers were
touched. Identical output, `0 disagreements`, exit 0. **A containment check run
only afterwards cannot distinguish "reproduced" from "regenerated"**, which is
why there are two.

The checker itself carries positive controls in the shape `00-vision.md` §7 rule
2 requires: it locates each block by its document heading and **fails loudly if a
heading yields anything other than exactly one fenced block**, or if §3's block
carries no `MEASUREMENT FAILED:` line. A probe that found nothing exits non-zero
rather than reporting seven silent passes.

### 5.2 What moved: three fields, on all seven runs, and nothing else

`diff` of the pre-edit capture against the post-edit capture, per run — identical
on all seven:

```
2c2
< instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2   [historical instrument]
---
> instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff
4c4
< git-head:          3dd39b4939cfbefec76f2ef184a601676b796d76
---
> git-head:          3dd39b4939cfbefec76f2ef184a601676b796d76 -dirty
12a13
> excluded-tasks:    none (--exclude-task not given)
```

Exit codes unchanged: **0, 0, 1, 0, 0, 0, 0** — run C still refuses, and R61's
"never a smaller, prettier table" is still the reason. **No number in the
document moved, so there was no finding to report to the manager chat on that
count.** Had one moved it would have been reported rather than replaced.

`-dirty` is honest. Round 802 runs three builders in one shared worktree; the
tree cannot be clean at the instant any of them measures anything. The header
says in its own words that `git-head` names the TREE and `instrument-sha256`
names the bytes, and only the second is a claim about what ran. Suppressing the
marker to make the paste look tidier is the instrument lie this file catalogues.

### 5.3 What was written into the document

- **All eight pasted header blocks replaced** — seven in §1, one in §3 — by a
  script that locates each block by its opening `== measure-schedule` line and
  splices in the captured stdout, so no character was hand-typed. It asserts it
  replaced exactly eight and would have died on seven or nine.
- **A re-run record added at the top of §1**, naming the old sha (marked
  `[historical instrument]`), the new sha, why it moved, and that no measurement
  moved — the row E-3 requires.
- §1's closing paragraph, which said "these headers were produced by round 217",
  now says round 802 and names both retired identities with their markers.
- **§5(3)'s `sha256sum` block re-EXECUTED, not re-typed.** Round 216 found that
  exact block naming bytes the disk no longer had, and thirteen further places
  where a `sha256sum` had been pasted rather than run. It was executed from the
  repo root after the final edit to the instrument:

```
$ sha256sum scripts/measure-schedule.ts forge-control/src/lib/fixtures/replay-operator-visibility.json
6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff  scripts/measure-schedule.ts
e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7  forge-control/src/lib/fixtures/replay-operator-visibility.json
```

  The fixture hash is **unchanged** — `e0cb69a5…`, the value the capture record
  recorded before this instrument existed — which is the independent statement
  that the tables reproduce because the input did not move.
- **§7's digit ledger** gains a row for `6ec72b35…`/`3dd39b4…` and demotes the
  `f6828a68…`/`34268e9…` row to a marked historical one. `[historical instrument]`
- **`00-vision.md` §2.2's heading and its parenthetical** name `6ec72b35…`, with
  both retired identities marked. **§2.2's table of numbers was not touched** —
  it is not mine, and nothing in it moved.

### 5.4 The gate, green

The checker prints both retired identities in its own `historical shas:` block,
so pasting its stdout verbatim quotes two dead identities. Annotating them inside
the block would falsify the transcript, so the exemption the checker itself
declares is used instead — round 217's precedent, applied unchanged, with the
marker on the prose line immediately below rather than inside the paste.

Both values quoted in the next block are retired: `[historical instrument]`

```
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
== check-instrument-identity — provenance ==
this script:       f8c6088fb4932add17ae0219ad227db1182c52419f57fb5bf7f22465f83414e9
instrument:        scripts/measure-schedule.ts
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff   <- every pasted header must name THIS
historical shas:   2 (must not appear unmarked)
                   80ef11235ffe3e2cc12dd58404533070d4b7575a050ff96d44acf49226ef6afb  first seen b1bb731
                   f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2  first seen 34268e9
corpus:            21 markdown file(s) under docs/plan/engine-task-graph/

OK — 11 pasted header(s) across 3 file(s) name 6ec72b35…
OK — no retired identity quoted without '[historical instrument]'
exit=0
```

**Eleven, not eight, and one of the eleven is not mine.** Eight are §1's re-run,
two are the transcripts pasted in §1 and §3.1 of this file, and one is builder
8C's own paste in `evidence/phase8-corpus.md` in this same round. That is why the
checker's `MIN_HEADERS = 8` is pinned low rather than at the exact count: the
comment beside it says a gate that must be edited to stay true is a gate that
gets disclosed around, and this is that design working on its first real test.
The corpus count moves for the same reason — other builders are adding evidence
files while I run it — so a reader re-running this command tomorrow should expect
both counts to have grown and both `OK` lines to be unchanged.

**The checker found my own violations before any reviewer did** — two in
`00-vision.md` §2.2 and three in this file, including one inside the very
transcript block above. That is five failures I caused and five the gate caught,
which is the argument for it being universal rather than phase-7's.

### 5.5 FINDING, and the reason this file's instrument sha is what it is

**I moved the instrument twice and reverted the second move, deliberately.**
After the re-run above, I added a doc-comment to `assertExclusionAgrees()`
recording §3.4's coverage map. That edit moved `instrument-sha256` a second time
— and **broke a header builder 8C had already pasted** in
`evidence/phase8-corpus.md`, along with four prose references in their file and
one in `04-phases.md`. Their paste was correct when they made it; my second edit
retired it under them, mid-round, in files I do not own and cannot fix.

I reverted the second edit rather than hand builder 8C a red universal gate they
did not cause. The comment's content lives in §3.4 of this file instead, where it
is longer and better evidenced. `sha256sum scripts/measure-schedule.ts` reads
`6ec72b35…` — the value 8C's paste, 8C's prose, `04-phases.md` §12.6 and my eight
re-run headers all name.

**The general lesson, for round 803 and for the manager:** in a shared worktree,
the instrument's identity is a value OTHER builders paste, so moving it twice in
one round breaks their work retroactively. It should move **once per round, as
early as possible**, and then be frozen — which is what happened here, but by
correction rather than by design. `04-phases.md` §12.6 and 8C's evidence both
name `6ec72b35…`; they remain correct.

---

## §6 — the phase-7 typecheck gate, which the universal one does not reach

`forge-control/tsconfig.json` reads `"include": ["src/**/*.ts"]`, and
`scripts/measure-schedule.ts` lives at the repo root, so `pnpm typecheck` never
compiles my principal deliverable (`03-quality.md` §3.2, phase 7, "Added round
212"). Run and pasted:

```
$ cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
    --module ESNext --moduleResolution bundler --allowImportingTsExtensions \
    --resolveJsonModule ../scripts/measure-schedule.ts
(no output — clean)
exit=0
```

Confirmed **not vacuous** by re-running with `--listFiles`: 188 files in the
program, and both of the ones the gate names are in it —

```
$ … --listFiles ../scripts/measure-schedule.ts | grep -n "schedule-source.ts\|@types/pg"
174:…/node_modules/.pnpm/@types+pg@8.20.0/node_modules/@types/pg/lib/type-overrides.d.ts
175:…/node_modules/.pnpm/@types+pg@8.20.0/node_modules/@types/pg/index.d.ts
176:…/node_modules/.pnpm/@types+pg@8.20.0/node_modules/@types/pg/index.d.mts
184:…/forge-control/src/lib/schedule-source.ts
```

`schedule-source.ts` is reached only through a dynamic `await import()` on the
`--project` branch, and `@types/pg` only through it — a compile that resolved
neither would be clean for the same reason an unread file is clean.

---

## §7 — what would have made MY instrument report a pass wrongly

Standing rule 3, answered rather than acknowledged. The brief named three; there
are five.

### 7.1 The three the brief named

**(1) An `--exclude-task` that drops the row from the round table but not from
D6's check, or vice versa.** It would pass every happy-path test here and refuse
at round 810, mid-deploy. *Disproved structurally and then mechanically:* one
exported `excludeNeverRanTasks()` is the only implementation and both call sites
use it (§2.4); `assertExclusionAgrees()` compares the two results; and **M1**
implements the divergence and is watched failing three assertions. **M12**
implements the subtler form — an in-place filter that breaks only the *second*
call — and is watched failing the live-read symptom exactly.

**(2) A re-run of part 1 that pipes stdout into the document without comparing
it.** *Disproved by running the containment check twice, once under the OLD
bytes before any edit* (§5.1). The second run alone would have proved nothing.
The checker fails on a probe that misses rather than reporting a pass.

**(3) A `sha256sum` block pasted rather than executed** — round 216's defect in
thirteen places. *Disproved:* executed from the repo root after the last edit,
§5.3, and the value it printed is the one nine pasted headers and
`check-instrument-identity.py` independently agree on.

### 7.2 Two more, found by asking the question of my own work

**(4) A test suite that reads its own source and certifies a list it cannot
parse.** Section 11 is two regexes over one file. If either stopped matching —
the doc-comment reformatted, `new MeasurementError` wrapped differently — both
sets would come back empty and *equal*, and three of the four assertions would
pass. *Disproved:* `test("the probes are not vacuous")` fails below ten reasons
per set, and M7 was observed tripping it. A fourth test names D8's three reasons
individually, so a pattern that matched only the older entries cannot pass either.

**(5) A green run of everything, in a worktree three builders are writing to.**
`pnpm test`, the corpus checkers and `git status` all read a tree that contains
8C's and the third builder's uncommitted work. A pass here is a pass *of the
tree*, not of my diff alone. Stated rather than papered over: the universal-gate
runs below are honest about what they measured, and my commit stages only the six
paths in §8 — verified by `git diff --cached --name-only` after staging.

```
$ git -C /opt/forge-ai-os status --porcelain
(no output — the live checkout was neither read from nor written to)

$ python3 docs/plan/engine-task-graph/check-corpus-map.py
OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
exit=0

$ python3 scripts/checks/check-r20-census.py
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  docs/plan/engine-task-graph/evidence/phase2-replay.md matches the measurement  PASS
exit=0
```

`check-corpus-map.py` prints `01-requirements … + UNCOMMITTED EDITS` and
`04-phases … + UNCOMMITTED EDITS`, which is builder 8C mid-round and is the
checker being honest about the bytes it read. Recorded rather than trimmed.

---

## §8 — FINDING: the ruling's rationale, and what the exclusion actually moves

**Reported to the manager chat, and recorded here because it changes how a reader
of part 2 should read the numbers.**

The operator's ruling states:

> *three tasks absent from a 159-task denominator changes S1 and S2, so the
> exclusion must be visible where the numbers are read.*

**The conclusion is right and the arithmetic behind it is not, and the two should
not be conflated.** S1 is a mean of per-minute concurrency samples over run
intervals and S2 is wall clock ÷ summed run time; neither reads
`project_tasks.round` and neither counts tasks at all. Refusal 1 guarantees every
excluded row has **no `run_id`**, therefore names no run, therefore contributes
no interval — so excluding the three rows moves S1 and S2 by exactly zero. It is
visible in §3.1: the census falls from 6 to 5 while `runs=5` and every duration
is untouched.

What the exclusion *does* move: the census, every per-round count the rows sat
in, `tasks-without-run`, and what R61's five-row floor is evaluated against.

And what it does for S1 and S2 is **categorical rather than arithmetic**: without
it, D6 refuses and there are no S1 and S2 at all. That, I take it, is what the
ruling meant, and it is a stronger reason for the disclosure than the one stated
— a reader of part 2 must know that three rows left the denominator *and* that
the concurrency numbers would not exist without the flag that removed them.

**No action is required of round 810 beyond reading this**, and the ruling's
instruction is implemented exactly as written. Recorded under the rule that a pin
one cannot resolve is a finding rather than a footnote quietly reinterpreted —
the same applies to a rationale.

---

## §9 — write-set disclosure (for the round-803 audit, `03-quality.md` §3.1 item 4)

```
scripts/measure-schedule.ts                                      (phase 7's — declared, §0)
forge-control/src/lib/schedule-metrics.ts                        (phase 7's — declared, §0)
forge-control/src/lib/schedule-metrics.test.ts                   (phase 7's — declared, §0)
docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md        (phase 8's by E-3)
docs/plan/engine-task-graph/00-vision.md                         (§2.2 heading + parenthetical only)
docs/plan/engine-task-graph/evidence/phase8-instrument.md        (new — this file)
```

Six files, no others. The worktree also carries uncommitted edits by builders 8C
(`01-requirements.md`, `03-quality.md`, `04-phases.md`, `evidence/phase8-corpus.md`)
and the third builder (`scripts/deploy/`, several evidence files); **none of them
is staged by me**, and `git diff --cached --name-only` on my commit lists exactly
the six paths above.

### 9.1 Silent-fallback audit (NF1, `03-quality.md` §3.1 item 6)

Everything I added, enumerated:

| construct | where | why it is not a swallowed error |
|---|---|---|
| `options.excludeTaskIds === undefined ? [] : options.excludeTaskIds` | `computeSchedule()` | written out rather than `??`, matching `runIdOf()` beside it. Absent means "no ids requested", which is a state, not a failure. |
| `if (excludeTaskIds.length === 0) return { kept: tasks, … }` | `excludeNeverRanTasks()` | an early return on the identity case, returning the caller's own array so the no-flag path cannot differ from pre-D8 behaviour even by a copy. Asserted (M13). |
| `try/catch` | none added | the module still contains zero `catch`, zero `??` and zero `||` value fallbacks. The test file's one `catch` is the pre-existing `expectMeasurementError`. |
| `continue` after each refusal push | `excludeNeverRanTasks()` | collects EVERY offending id before throwing, so an operator with three bad ids learns all three at once. It is the shape `assertRunsResolvable()` already uses. |
