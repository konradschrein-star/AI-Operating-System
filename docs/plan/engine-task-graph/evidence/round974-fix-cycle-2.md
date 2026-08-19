# Round 974 — fix cycle 2: the gate R72 broke, the migration number that collided twice, and a third instrument nobody ran

Repo `ai-os`, branch `project/8c591d6c`, HEAD at start `84aac00`. Everything below
was run in the project worktree
(`/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`). Nothing was
run against `/opt/forge-ai-os`, `content_forge`, or any live service. The scratch
database for this round is **`forge_tg_r974`**, created while connected to the
`postgres` maintenance database and named per-run because
`check-scheduler-sql.sh` uses a FIXED schema name (`tg_check_sched`) and two
concurrent runs in one database would collide.

Round 973's verdict raised three items. All three are addressed; a fourth defect
was found while discharging the third and is fixed here rather than reported for
a later round, because the gate it breaks is one this project's own
`03-quality.md` §4 requires to exit 0.

---

## 1. Finding 1 — `check-scheduler-sql.sh` case 1 (R11) vs R72's lane cap

### 1.1 Reproduced first, from a clean tree

The reviewer's claim was reproduced before anything was edited, at `84aac00`,
with `git status --porcelain` empty:

```
--- 5. case 1 — R11: a graph row promotes with its round UNDRAINED ------------
  ok   R11 premise: a lower-round P1 row is not done            = pending
  FAIL R11: candidate promoted despite the undrained round      expected [yes] got [no]

check-scheduler-sql.sh FAILED after 5 assertions
```

### 1.2 THE DAMAGE IS WIDER THAN THE FIRST FAILURE — this is the finding under the finding

The script aborts on its first failure, so the reviewer saw case 1 and stopped.
Six cases were broken, not one, and each for the same reason: they were written
against a world in which any number of rows of workstream `main` may go `ready`
in one tick, and R72 ends that.

| case | subject | what the cap did to it |
|---|---|---|
| 1 | R11 — a graph row promotes with its round undrained | candidate and the undrained row shared `main`; the cap held the candidate. **FAILED.** |
| 2 | R12 — a legacy row waits for its lower round | the lower row is `running`, so the cap held the candidate on tick 1 **as well as** R12 did. Would have passed **with R12's branch deleted**. |
| 5 | R69 — the legacy-row term holds a frozen closure | the legacy row promotes on tick 1 and takes the lane. Same collapse. |
| 5b | E4 — `graph_frozen` holds a derived closure, releases a declared one | its CONTROL requires two candidates to receive **different** verdicts in one tick, and the lower-round row was taking the lane from both. |
| 6 | R13 — the active gate is a filter, not a state change | asserts **two** rows promote when the project resumes; one lane promotes one. |
| 7 | R16/R17 — the claim-time contention belt | needs three rows of lane `main` ready at once; the promote path can no longer produce that state at all. |

Cases 2 and 5 are the instructive ones: they would have gone on printing `ok`
while measuring the wrong rule. That is now failure mode **(g)** in the script's
own header — *two rules in one lane, so a case passes for the wrong reason* —
beside the six modes already listed there.

### 1.3 What was changed, and why this and not the alternative

The reviewer offered two routes: restate R11 across two workstreams, or narrow
the cap. **The cap stands.** It is a correctness fix (a fix builder writing the
tree a reviewer is gating produces a verdict about a tree that moved under it),
its reasoning is recorded at length in `promoteReadyTasks()`, and it was measured
live. What was wrong was the fixtures, and the missing requirement.

* Every case whose subject is the READY RULE now puts the row under test in a
  lane of its own (`alpha`, `c2-cand`, `c5-cand`, `c5b-frozen`, `c5b-declared`,
  `c6-legacy`), so the only thing that can hold it is the rule the case names.
* Case 1 gained an assertion **that the two rows are in different lanes**, so a
  later edit that puts them back cannot quietly restore the collapse.
* Case 7's four rows are seeded `ready` instead of promoted, with the reason
  inline: the state it measures is now reached only through `retryTask()`'s
  group unwedge (deliberately uncapped) or an out-of-band write, and what is
  under test is `claimReadyTasks()`, reached identically either way.
* **Case 1b is new** and asserts the retired behaviour directly: two graph roots
  in one lane, exactly one promotes, the other is held `pending` (not blocked,
  not failed), a different workstream of the *same project* promotes in the same
  tick, and the held row promotes on the next tick once its lane frees.

### 1.4 R72 did not exist as a requirement, and that is why the gate broke silently

`grep -rn "R72" docs/plan/engine-task-graph/*.md` at `84aac00` returned three
hits, all of them prose *about* round 972's commits in `03-quality.md` and
`04-phases.md`. **No R72 was ever defined in `01-requirements.md`**, so
`check-corpus-map.py` saw a contiguous R1–R71 and reported nothing, and standing
rule 4 — retire a requirement and its gate clause together — had no requirement
to attach to. It is defined now, mapped in `01 §K`, `04 §9` and the phase-2
header, and `check-corpus-map.py` agrees three ways:

```
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
  defined: 72 R + 7 NF
    2      16     16     16     agree
OK — R1..R72 and NF1..NF7 complete, all three statements of the map agree.
```

### 1.5 THE MUTATION CONTROL — case 1b is not self-satisfying

A new case that passes against the shipped code proves nothing until it is seen
to fail without it. `db/projects.ts` was hash-swapped back to `9c3f63a`
(pre-R72), the script re-run, and the file restored and verified by digest:

```
HEAD sha256:    6a279e1f663e952b5b92119babd498d24ba30ade22c6d6a0829548496c24631c
pre-cap sha256: 79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28

--- 5. case 1b — R72: one live task per lane, and the lane frees -------------
  ok   R72 premise: all three P1b roots were pending before the tick = pending|pending|pending
  ok   R72: the lane head promoted                              = yes
  FAIL R72: its same-lane sibling did NOT                       expected [no] got [yes]

check-scheduler-sql.sh FAILED after 12 assertions

restored sha256: 6a279e1f663e952b5b92119babd498d24ba30ade22c6d6a0829548496c24631c
RESTORE VERIFIED (sha256 identical)
```

Case 1 passed in **both** directions — 12 assertions ran before case 1b's third,
which is all of section 2, the seed, and case 1's six — which is the point:
R11's claim never depended on the cap, and now nothing about its fixture does
either.

### 1.6 What would have made this instrument report a pass wrongly

* **A case that asserts `pending` for a reason it cannot see.** Failure mode (g),
  above; excluded by construction and re-checked case by case in §1.2's table.
* **A case 1b that passes with the cap deleted.** Excluded by §1.5, watched red.
* **A lane cap that admitted one row per PROJECT** rather than per lane, which
  would satisfy every other assertion in case 1b. Excluded by the assertion that
  a different workstream of the same project promotes in the same tick.
* **A cap that leaked into the pure rule**, silently changing every consumer of
  `graphReady()` including the R18 replay proof. Excluded by case 1b's MIRROR
  assertion, which requires the pure side to answer `MIRROR=true` for the row the
  statement declined — the *opposite* agreement to case 5b's, and taken from the
  same pre-tick capture for the same timing reason.
* **A census that certifies itself.** `EXPECTED_ASSERTIONS` moved 93 → 104 and is
  checked against both the number of `assert_*` calls in the file and the number
  that actually ran; all three print, and disagreement exits non-zero.

### 1.7 A latent defect found in the same file

The driver heredoc (`cat > "$WORK/drive.mts" <<DRIVER`) is **unquoted** — it must
be, `$REPO_ROOT` is substituted into it — and a comment inside it quoted a word
in backticks. Bash therefore ran that word as a command while writing the file:

```
scripts/checks/check-scheduler-sql.sh: line 505: undefined: command not found
```

The substitution's empty result was written into the generated comment, so the
file on disk had the word silently deleted. Harmless with that identifier and one
identifier away from executing something real. Fixed, with the hazard named
inline so the next editor of that heredoc does not reintroduce it.

---

## 2. Finding 2 — `0042_daily_goals.sql` vs `0042_task_graph.sql`

### 2.1 The collision, and which file moved

`main`'s `553fa38` added `0042_daily_goals.sql`; round 972's merge (`37cc974`)
brought it alongside this project's `0042_task_graph.sql`. Git raised no
conflict — for the third time in this project's life — because the filenames
differ. **This file moved, to `0043_task_graph.sql`, on two measured grounds:**

1. Nothing named `0042` has ever been applied to `content_forge`. This migration
   is applied there under its ORIGINAL name `0040_task_graph.sql` (round 811,
   re-run round 910); `0042_daily_goals.sql` is `main`'s and was applied under
   its own name. Renaming the applied one would falsify the record of what ran.
2. `main` still carries this migration at `0040`:

   ```
   $ git ls-tree --name-only main db/migrations/ | tail -4
   db/migrations/0040_task_graph.sql
   db/migrations/0040_usage_hourly.sql
   db/migrations/0041_ui_dismissals.sql
   db/migrations/0042_daily_goals.sql
   ```

   The round-950 renumber has not reached `main`, so the number this lane picks
   must be free **on `main`** at merge time, not merely free here. `0043` is.

The move was a pure `git mv`:

```
$ sha256sum db/migrations/0042_task_graph.sql
497fdae6cc31d672dbecd2dca772306a5d9aa33935a86f3c1aca29f0075c9ac1
$ git mv db/migrations/0042_task_graph.sql db/migrations/0043_task_graph.sql
$ sha256sum db/migrations/0043_task_graph.sql
497fdae6cc31d672dbecd2dca772306a5d9aa33935a86f3c1aca29f0075c9ac1
```

The same commit then edited the file's own provenance paragraph and the
`COMMENT ON COLUMN project_tasks.graph_frozen` sentence, so a reader running
`sha256sum` on the committed file gets a **different** digest — stated here for
the same reason round 950 stated it, because otherwise the document reads as a
lie. No DDL and no backfill statement was touched, proved by execution in §4.

### 2.2 Citations propagated, and the two that deliberately were not

31 references across 13 live files were rewritten to the new path. Two classes
were left alone or restored by hand:

* **Phase-evidence files** (`evidence/round950-renumber.md` and its siblings)
  record what was executed under the name of the day. Rewriting a transcript to
  match a later rename falsifies it. Untouched.
* **Two live sentences that NARRATE the round-950 move** were caught by the bulk
  substitution and put back: `01-requirements.md`'s quoted
  `git mv … 0040_task_graph.sql 0042_task_graph.sql` command, and
  `04-phases.md`'s "Round 950 executed it with the tree quiet: `git mv` to …".
  A transcript is a quotation. Both now carry the round-974 sequel beside them.

`04-phases.md`'s phase-8 narrative also said *"`migrations.test.ts` sorts
filenames without asserting unique numbering"* — true when written, and the
reason the collision recurred. Corrected in the same commit as the assertion that
makes it false.

### 2.3 The guard existed and was in the wrong place

`db/projects.test.ts`'s `migrationFiles()` already refused a duplicate prefix —
that refusal is what the reviewer hit, so the guard worked. But it needs a
scratch Postgres, so it runs when someone remembers to run it, days after the
merge that breaks it. A hermetic copy now runs on every commit:

```
$ tsx --test src/lib/migrations.test.ts
ok 26 - no two migrations share a numeric prefix (R70)
ok 27 - 0043_task_graph.sql adds four guarded columns, two named indexes, and a no-op-on-replay backfill
# tests 27   # pass 27   # fail 0
```

**Watched go red**, because a guard never seen to fail is a claim. A canary
`db/migrations/0043_canary_duplicate.sql` was created, the suite re-run, and the
canary deleted:

```
not ok 26 - no two migrations share a numeric prefix (R70)
  error: two or more migrations share a number: 0043 → 0043_canary_duplicate.sql + 0043_task_graph.sql.
         There is no ledger table and no runner in this repo, so sort order would silently
         decide which applies first (R70). …

$ git status --porcelain db/migrations/
RM db/migrations/0042_task_graph.sql -> db/migrations/0043_task_graph.sql
```

The test also asserts that the number of distinct prefixes equals the number of
files and that the corpus is non-trivial, so a `FILES` that came back empty
reports "no collisions" and still fails.

---

## 3. A THIRD instrument round 972 broke — `check-r20-census.py`

Found while discharging finding 3. `03-quality.md` §4's phase-2 block requires
this script to exit 0. At `84aac00` it does not exit at all — it dies:

```
$ python3 scripts/checks/check-r20-census.py
check-r20-census: SYMBOLS 26 attributed
Traceback (most recent call last):
  …
  File ".../check-r20-census.py", line 401, in render
    f"| `{c['owner'][i]}` | `{text}` | {ALLOWED_SCHEDULING_LINES[text]} |"
KeyError: 'SELECT pt.id, pt.project_id, pt.workstream, pt.round, pt.created_at'
```

Bisected by the script's own `--at`: green at `9c3f63a`, dead at `af3cba6` and at
`84aac00`. Three separate causes, all fixed here:

1. **R72's two new `round`-bearing lines were unjustified.** Both are entered in
   `ALLOWED_SCHEDULING_LINES` as PROJECTIONS FEEDING AN ORDERING — the case §7.2
   already recognises for `ORDER BY pt.round ASC`. Neither can gate a promotion:
   `eligible` is computed by the ready predicate and the cap is applied strictly
   after it, so the two lines decide which row of a lane goes first, never
   whether any row may go at all.
2. **`af3cba6` re-indented an R27 annotation** from five spaces to three while
   moving the statement. The allow list is keyed on the line's stripped text, so
   a justified line became an unjustified one, invisibly, in a diff that reads as
   a re-indent. Re-keyed, with a note explaining why the matcher is NOT being
   taught to ignore whitespace.
3. **`render()` looked the justification up with `[]`**, so an unjustified line
   replaced the R20 verdict with a traceback. Now `.get` with a visible
   `**UNJUSTIFIED — see the R20 FAIL above**` marker: the check has already
   failed by then, and a gate must print its finding.

`listTaskReports`, carrying four comment-only `round` hits since round 970 and
unattributed since, is attributed. The generated region in
`evidence/phase2-replay.md` — stale since round 970 — was regenerated with
`--write`, as its own header instructs; the diff is 7 lines, all inside the
region.

```
$ python3 scripts/checks/check-r20-census.py
check-r20-census: HITS    139 (156 case-insensitive), 53 code / 86 comment, 3 sql-annotations
check-r20-census: SYMBOLS 26 attributed
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  …/evidence/phase2-replay.md matches the measurement  PASS

$ python3 scripts/checks/check-r20-census.py --self-check
self-check OK — at 27d300f the tsdoc rule reproduces the round-202 totals (85 hits,
92 case-insensitive, 41 code / 44 comment) and its pinned 19-symbol distribution is
unchanged; the trailing rule reproduces all 10 rows of the round-202 hand table
```

**Three instruments, one round.** `check-scheduler-sql.sh`, `db/projects.test.ts`
and `check-r20-census.py` were all left broken by round 972 and its fix cycle,
which cited only `gates-808.sh`, `pnpm test` and `tsc` — none of which runs any
of the three. That is why `03-quality.md` §4 now names this file's gate on any
change to `promoteReadyTasks()`, and why the clause says to quote the assertion
census rather than the word PASS.

---

## 4. Finding 3 — fresh output, every gate

Run in the worktree, after all of the above. `git status --porcelain` on
`/opt/forge-ai-os` was not consulted and not touched; this round deploys nothing.

```
$ pnpm typecheck                                        clean (tsc --noEmit)
$ pnpm test                                             1379/1379 pass, 0 fail   (was 1378; +1 is R70's new case)

$ scripts/checks/check-scheduler-sql.sh                 exit 0
    seeded rows        : 33 across 12 projects
    assertions executed: 104
    assertions declared: 104
    assertion CALLS in this file: 104
    git 84aac00 · sha256(projects.ts)=6a279e1f663e952b… · db=forge_tg_r974 · schema=tg_check_sched

$ tsx --test forge-control/src/db/projects.test.ts      exit 0
    projects.test.ts PASSED — 33/33 assertions
    ok   no lane the promote statement touched holds more than one live row
    (it ABORTED at 84aac00: "REFUSING TO RUN: migrations 0042_daily_goals.sql
     and 0042_task_graph.sql share the number 0042" — finding 2 is what made
     this file runnable again)

$ scripts/checks/check-migration-0040.sh                 exit 0
    PASS — 0043 is re-runnable (R2), its backfill is the closure (R6), both indexes exist (R7).
    44/44 assertions · sha256(0043)=fbb4e56ed8c5dc07… · db=forge_tg_r974 · schema=tg_check_0040
    (applied twice against a scratch schema — the proof that the renumber touched
     no DDL and no backfill, by execution rather than by assertion)

$ scripts/checks/check-r69-straddle.sh                   exit 0
$ scripts/checks/check-fix-chain-graph.ts                exit 0 — 40/40 assertions
$ scripts/checks/check-workstream-claim.ts               ALL PASS — 36 checks
$ scripts/checks/check-instrument-typecheck.sh           PASSED — 44/44 subjects, 0 suppressions
$ docs/plan/…/check-corpus-map.py                        OK — R1..R72, NF1..NF7
$ docs/plan/…/check-instrument-identity.py               OK — 13 headers, 37 manifest lines
$ scripts/checks/check-r20-census.py                     PASS + REGION PASS (§3)
$ scripts/checks/check-r20-census.py --self-check        OK

$ GATES_ENGINE_ALLOW='forge-control/src/db/projects.ts,forge-control/src/lib/project-tick.ts,forge-control/src/lib/project-tick.test.ts,forge-control/src/db/projects.test.ts' \
    scripts/checks/gates-808.sh --strict                 exit 0 — 25 gates, RED: 0, 2 skipped by design
$ git diff --name-only main...HEAD | GATES_ENGINE_ALLOW= scripts/checks/forbidden-file-diff.sh
                                                         exit 1, naming the same four — the control read
$ scripts/checks/check-forbidden-file-diff.sh            ALL PASS — 14 checks
```

The scratch database `forge_tg_r974` was created while connected to the
`postgres` maintenance database. **No statement of any kind was issued against
`content_forge`.**

---

## 5. Reported, not fixed: R31 of the `scripts-checks-typecheck-gate` corpus

`docs/plan/scripts-checks-typecheck-gate/01-requirements.md` R31 verifies by
identity: `git log --format=%H -1 -- docs/plan/engine-task-graph/03-quality.md`
must EQUAL the commit that last changed
`scripts/checks/check-instrument-typecheck.sh`.

**That clause is already false at `84aac00`, before this round:**

```
$ git log -1 --format=%H -- docs/plan/engine-task-graph/03-quality.md
84aac0019788ebe46779452c82c3917a41c0a592
$ git log -1 --format=%H -- scripts/checks/check-instrument-typecheck.sh
6c3dc9f012052791dab63af7327594467af018a7
```

Round 972's fix cycle edited the quality document for an unrelated reason and
broke it; this round does the same, for standing rule 2, and cannot avoid it —
the doc is where this project's gates are stated. The clause is **unsatisfiable
in one direction by construction**: it makes any independent edit to a shared
quality document falsify a closed project's passed acceptance criterion. The
coupling it wants (touch the gate script ⇒ amend the doc) is real and worth
keeping; the biconditional it wrote is not.

Not amended here. That corpus belongs to another, closed project, and rewriting
another project's passed criterion is not this round's to do — it is reported so
it is a finding on the record rather than a footnote someone later reinterprets.
Recommended repair, for whoever owns it: state the implication in one direction,
or pin it to the gate script's commit alone.
