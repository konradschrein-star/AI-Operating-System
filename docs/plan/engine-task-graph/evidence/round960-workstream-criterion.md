# Round 960 — GRAPH_GUIDE: a workstream per concurrent lane, not per file conflict

*One sentence of prompt text was the whole gap between a 1-wide fleet and a
6-wide one. This is what it was, what it is now, what the replacement cost in
NF7's budget, and the five faults injected to prove the new gate can go red.*

Task: round 960, `engine-task-graph`, branch `project/8c591d6c`.
**Nothing was deployed.** Worktree only; `/opt/forge-ai-os` was never touched,
no live endpoint was called, no `pm2` verb was issued. The one thing this round
could not do from a worktree is stated in §7.

---

## 0. Build identity, before any number

| | |
|---|---|
| worktree | `/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4` |
| git HEAD at start | `6d08316` — *docs(engine-task-graph/round-815, phase 8G): the two live observations…* |
| `project-tick.ts` sha256 at `6d08316` | `d3665eb18b2589e5…` (the baseline harness's own pin, §1) |
| `project-tick.ts` sha256 after this round's edit | `ed206ab9af093fbb…` |
| `task-graph.ts` sha256 (unchanged this round) | `750f963c85bbc901…` |
| `workspace.ts` sha256 after this round's edit | `622e8d414f99115b…` |
| node | v22.22.2 · tsc 5.7.2 · pnpm 9.15.9 |

Every sha above is the first 16 hex characters of `sha256sum` on the file in
this worktree, printed by the instruments themselves (§1, §3) rather than typed
from memory.

---

## 1. The measurement, before and after

`scripts/checks/measure-prompt-baseline.sh` (round 950) is the instrument, run
first at `6d08316` over the three refs on record plus HEAD. It exports each ref
with `git archive`, symlinks only `node_modules`, refuses to report a number
unless the exported source's `GRAPH_GUIDE` declaration and the loaded module's
binding agree, and cross-checks the round-242 ledger.

```text
--- HEAD (6d08316) -------------------------------------------------
    sha256(project-tick.ts) : d3665eb18b2589e5
    exports GRAPH_GUIDE     : yes (static and runtime agree — shadow-tree control passed)
    policy blocks present   : WORKTREE_POLICY,ESCALATION_POLICY,MANAGER_COMMS,GITHUB_PUSH_GUIDE
    policy blocks ABSENT    : -
    id occurrences in prompt: 1
    MEASURED length         : 12227

--- census --------------------------------------------------------------------
  controls passed : 17
  failures        : 0

PASS — every tree measured under both controls, and every ledger row reproduced.
```

The three ledger refs reproduced exactly — `d9858b9` 9221, `05f2842` 11619,
`fe14a7e` 12095 — so the harness was measuring this tree and not another.

**BASELINE 9221 + BUDGET 3050 = cap 12271. At `6d08316` the maximal planner
prompt is 12227. Headroom: 44 characters.** That is the whole allowance this
task had, and it is why the brief called the change a REPLACEMENT.

### 1.1 What was removed and what replaced it, measured as strings

| | text | chars |
|---|---|---|
| removed | `` — so open a second only when two teams truly need one file concurrently.`` | **73** |
| added | `` — so open ONE PER LANE you want running at once, up to that cap, not one per file conflict.`` | **92** |
| net | | **+19** |

Measured through the maximal planner path, not off the literal:

```text
before (6d08316)                12227     headroom 44
after  (this round)             12246     headroom 25
12246 − 12227 = 19 = 92 − 73
```

The second equality is the positive control round 900 used and it is not
decoration: a swap inside a string already interpolated into the prompt cannot
cost anything else, so the built prompt moving by exactly the difference of the
two clauses is the proof that nothing but the clause moved. It is asserted, not
narrated — `project-tick.test.ts`'s NF7 block carries round 960 as its own
ledger row and the suite fails with the arithmetic in the message otherwise
(§4, M6).

### 1.1a The after-figure, re-derived at the COMMITTED sha

§1.1's 12246 comes from the NF7 block's own arithmetic against the working tree.
Re-derived after the commit by the same harness, over an exported
`git archive` of it — so the number belongs to bytes that exist in history and
not to an editor buffer:

```text
--- HEAD (5d0e0c0) -------------------------------------------------
    sha256(project-tick.ts) : ed206ab9af093fbb
    exports GRAPH_GUIDE     : yes (static and runtime agree — shadow-tree control passed)
    policy blocks present   : WORKTREE_POLICY,ESCALATION_POLICY,MANAGER_COMMS,GITHUB_PUSH_GUIDE
    policy blocks ABSENT    : -
    id occurrences in prompt: 1
    MEASURED length         : 12246
  ok    HEAD: shadow-tree control (static == runtime GRAPH_GUIDE)
  ok    HEAD: maximal path (all four policy blocks present)
  controls passed : 2   failures : 0
```

`ed206ab9af093fbb` is the same digest §0 records for the edited file and §3's
check prints for the module it imported: one file, measured three ways.

And the manifest guard, re-run after the commit so it is no longer vacuous —
before the commit it reported *"this branch touched no scripts/checks/\*.ts"*,
because it derives its list from `main..HEAD`:

```text
MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested
  touched by this branch:
    scripts/checks/check-workstream-claim.ts
  ok: every touched instrument is manifested
CENSUS
  entries declared 8   entries compiled 8   failures 0   unmanifested 0
```

### 1.2 Why this wording, and what was rejected

The brief's instruction was explicit: do not trim the clause into something that
passes `.includes()` while teaching a planner the wrong criterion. Five
candidates were measured before one was written:

| candidate | chars | net | verdict |
|---|---|---|---|
| `…open ONE PER LANE you want running at once, up to the cap; two tasks in one workstream never run together, however disjoint their write_sets.` | 147 | +74 | **over budget by 30** |
| `…open ONE PER CONCURRENT LANE you want, up to the cap: two tasks of one workstream never run together, whatever their write_sets say.` | 138 | +65 | over budget by 21 |
| `…open ONE PER LANE you want running at once, up to that cap: file contention is NOT the test.` | 98 | +25 | fits; the negation is vaguer than "not one per file conflict" |
| `…open ONE PER GROUP OF TASKS you want running at once, up to that cap, not one per file conflict.` | 102 | +29 | fits; 10 characters for a synonym |
| **`…open ONE PER LANE you want running at once, up to that cap, not one per file conflict.`** | **92** | **+19** | **shipped** |

The shipped clause carries three things and drops nothing: the **positive
criterion** (one workstream per lane a planner wants running concurrently), the
**bound** (up to the cap the sentence in front of it already names and 400s on),
and the **explicit negation of the retired test** (not one per file conflict).
The first two teach what to do; the third is what stops a planner re-deriving
the criterion that produced round 815's serial fleet. The two over-budget
candidates spend their extra characters restating "tasks of one workstream never
run together", which the same bullet already says as *"one git worktree whose
tasks run one at a time"* — paying for a fact twice while the criterion was the
thing that was wrong.

**No wording was trimmed to fit.** The clause fits with 25 characters of NF7
headroom to spare, and the surrounding prose was deliberately NOT shortened to
buy room: rewriting the cap sentence to reclaim characters would have widened
the diff a reviewer must read and muddied the ledger's attribution, for an
allowance this round did not need.

### 1.3 What was kept, because the criterion was one clause of six

The bullet's other claims were measured true and are unchanged — asserted
individually so that a rewrite cannot take them out alongside the criterion
(`project-tick.test.ts`, "R48 (round 960) — a workstream per concurrent lane"):
the name regex `/^[a-z0-9][a-z0-9-]{0,39}$/`, the `main` default, "one git
worktree whose tasks run one at a time", "isolated directories that may write
the SAME file", "at most PROJECT_MAX_WORKSTREAMS distinct ones", and "refused
with a 400 naming the count". **R38's integration/no-auto-merge paragraph was
not touched at all** — and it is what keeps the extra lanes honest: a lane costs
an integration task and its reviewer, so "open one per lane" is not free advice.

---

## 2. Why the sentence was wrong — the cause, cited by symbol

Round 815 measured the first project the new prompt planned: 7 of 10 tasks with
a non-empty `depends_on`, including a true join, and **max concurrency 1** over
224 samples. Two planners with disjoint write-sets were both `ready` from
07:16:56Z; the second waited 32 minutes (`evidence/phase8-verify.md` §7c).

The cause is not the scheduler and not the graph. `spawnTaskRuns()`'s deferred
branch — built from `busyWorkstreams()` and `partitionByWorkstream()`, whose
comment names its provenance, *"The operator's ruling of round 222, enforced"* —
defers **every** eligible task of a busy workstream and consults no write-set at
that belt. `selectClaimable()` would run two disjoint tasks of one workstream
together; the belt holds the second anyway.

So **the unit of parallelism is the workstream**, and the retired criterion
asked a same-file question of a belt that asks none. The two halves of the
bullet contradicted each other, and the round-815 architect followed the closing
half — six phases, disjoint files, nothing opened, a correct DAG that ran
1-wide.

**The belt was not touched and must not be.** It is what makes one worktree per
workstream safe; two builders in one directory is the silent clobbering this
whole project exists to remove. §3 case 2.2 is the negative control that keeps
that property visible in the same table that proves the criterion.

---

## 3. The new gate: the prompt's claim, executed

`scripts/checks/check-workstream-claim.ts` (new) is the second member of the
class `check-screenshot-render-shapes.ts` opened at round 902: a check that runs
a prompt's promise against the code that must keep it.

**Why a check and not only a unit assertion.** `project-tick.test.ts` asserts
the STRING and should — a clause that vanishes must fail loudly. But a substring
gate cannot tell a true clause from a false one, and **the retired criterion
passed every substring gate in this repo for eight rounds.** The truth of the
clause is a property of three exported functions in two modules.

```text
check-workstream-claim.ts — round 960, GRAPH_GUIDE's workstream bullet, executed

PROVENANCE
  this check      : …/scripts/checks/check-workstream-claim.ts
  this check sha  : 622a2d410c587ca586d95c735cb0b0816d5548b5e0fc63600142683fc04a5f39
  imported        : …/forge-control/src/lib/project-tick.ts
     sha256       : ed206ab9af093fbb57e69d17a570d504275a6197309ee83f386a672d552e0dd2
  imported        : …/forge-control/src/lib/task-graph.ts
     sha256       : 750f963c85bbc90139477c2f6b01b8e28edb7113451b516bbb7adf199793c42c
  imported        : …/forge-control/src/lib/workspace.ts
     sha256       : 622e8d414f99115b62a2b72ed51c93465827e3149df6db07149aeaa8fdf40f4f
  node            : v22.22.2

── 1. one workstream: "tasks run one at a time" ──────────────
PASS  1.1 two disjoint tasks in ONE workstream spawn ONE — the round-815 stall, reproduced
PASS  1.2 and it is the first-ordered one that goes, not an arbitrary one
PASS  1.3 the CONTENTION GATE would have run both — so the belt is what serialises, which is
          why a disjoint write_set buys a planner nothing inside one workstream
PASS  1.4 a workstream with a task already RUNNING is busy, so its ready sibling defers

── 2. two workstreams: the same file, at the same time ───────
PASS  2.1 the SAME file in two workstreams spawns BOTH
PASS  2.2 NEGATIVE CONTROL — the same two tasks in ONE workstream spawn one
PASS  2.3 a workstream is NOT held busy by another workstream's running task

── 3. width is the number of workstreams, not of files ───────
PASS  3.1 1 workstream(s) over 6 independent tasks → width 1  [what round 815 shipped]
PASS  3.2 2 workstream(s) over 6 independent tasks → width 2
PASS  3.3 3 workstream(s) over 6 independent tasks → width 3
PASS  3.6 6 workstream(s) over 6 independent tasks → width 6  [the cap]

── 4. R33 the workstream branch is the hyphen form ───────────
PASS  4.1 a workstream branch is project/<id8>-<ws>
PASS  4.2 and never the slash form git refuses
PASS  4.3 main is a PASSTHROUGH — no live project changes branch

── 5. GRAPH_GUIDE matches the executed result ────────────────
PASS  5.x GRAPH_GUIDE states §1's fact / §2's property / §3's criterion / the cap
PASS  5.5 the retired same-file criterion is GONE

ALL PASS — 19 checks
EXIT=0
```

§3 is the criterion itself as arithmetic: six independent tasks — no
dependencies, no shared files, the cheapest parallelism there is — split across
k workstreams reach width k. The retired criterion asked about files; none of
the six shares one, so it answered "one workstream", and the fleet ran at row
3.1 instead of row 3.6.

It needs no database, no git repository and no browser, so a build task may run
it. It typechecks under `--strict` as manifest entry 8 of
`check-instrument-typecheck.sh` (§5).

---

## 4. Five injected faults — the gate seen going red

A gate that has never been observed to fail is a claim, not a gate. Each fault
below reproduces a real way this could break; each was applied to the worktree,
run, and **restored by sha256 comparison against a byte copy taken before the
mutation** — not by re-editing, which is how a "restored" file quietly keeps a
mutation.

```text
PRE   tick=ed206ab9af093fbb  graph=750f963c85bbc901  ws=622e8d414f99115b
POST  tick=ed206ab9af093fbb  graph=750f963c85bbc901  ws=622e8d414f99115b
```

| # | fault injected | result |
|---|---|---|
| **M1** | `GRAPH_GUIDE`'s retired criterion put back | `FAIL 5.x §3's criterion`, `FAIL 5.5 retired criterion is GONE` — 2 failures, exit 1 |
| **M2** | the round-222 belt defers nothing (`if (false)` in `partitionByWorkstream`) | `FAIL 1.1`, `FAIL 1.4`, `FAIL 3.1`, `FAIL 3.2`, `FAIL 3.3` — 5 failures, exit 1 |
| **M3** | `selectClaimable()` stops testing the workstream, so contention crosses worktrees | `FAIL 2.1` — 1 failure, exit 1 |
| **M4** | `workstreamBranch()` ships the slash form | `FAIL 4.1`, `FAIL 4.2` — 2 failures, exit 1 |
| **M5** | §4 stops executing (one case deleted) | `FAIL 18 checks ran, 19 expected — a section stopped executing` — exit 1 |
| **M6** | NF7's ledger misstates round 960's spend as 20 | `not ok 2 — … measures 12246, but the 5A tip (11619) plus every ledgered spend (240:476 + 242:26 + 900:106 + 960:20 = 628) comes to 12247 — -1 characters are unaccounted for` |

Two of these are worth reading rather than counting.

**M2 did NOT fail case 2.2, and that is correct.** With the belt disabled, two
same-file tasks in one workstream are still held apart — by `selectClaimable()`,
not by the belt. A mutation table where every fault reddens every case would
mean the cases were not measuring different things.

**M6 is the instrument's own arithmetic printing the live number.** The message
quotes `measures 12246` independently of anything typed into this document, which
is why §1's after-figure is not a claim.

*(M1–M5 are `check-workstream-claim.ts`; M6 is the NF7 block of
`project-tick.test.ts`.)*

---

## 5. The corpus sweep — and two stale "verbatim" quotes found while doing it

**The retired sentence, everywhere it survives.** Four of the nine hits are the
new gate asserting its absence; the rest are records, annotated in this commit
rather than rewritten, because a record edited to match today's code is the same
rot one level worse:

```text
scripts/checks/check-workstream-claim.ts:18,315   the gate (header + assertion)
forge-control/src/lib/project-tick.test.ts:2077,2564,2687  the gate clause + NF7 row
docs/plan/engine-task-graph/01-requirements.md:1139         R48's amendment, quoting what it retires
docs/plan/engine-task-graph/evidence/phase8-verify.md:784,951  round 815's finding — annotated "CLOSED AT ROUND 960"
docs/plan/engine-task-graph/evidence/phase5-prompts.md:100     phase 5A's snapshot — annotated as superseded
```

`GRAPH_GUIDE` itself no longer contains it, asserted in both files above.

**The slash branch form.** Round 815 reported it as a finding and named round 817
as the owner. Three sites carried it; one was a **live brief**:

| site | disposition |
|---|---|
| `scripts/deploy/payload-verify.json` item 7b | **CORRECTED.** It predicted `project/<NEW_ID>/<workstream>` as an expected live observation — a branch git refuses while `project/<id8>` exists — so the item could never have been satisfied. Now names the hyphen form, says why, and says that a slash is itself the finding. Amended where it is enforced, per round 820's precedent for the same file. |
| `evidence/phase8-tooling.md` §7 | **CORRECTED**, because §7 claims to quote that brief verbatim. |
| `02-architecture.md` §4.1, `evidence/phase8-verify.md` §7b | **LEFT.** Both cite the slash form in order to refute or report it. |

**And while proving that quote byte-identical, two of the three §7 quotes turned
out to have been stale since round 820.** The claim "these are their `brief`
fields verbatim" was false and no check enforced it:

```text
payload-verify.json: payload 12845 chars dd532466fd389aa2 | quote 12372 574bec923b9132f1 | DIFFERENT
payload-report.json: payload  9088 chars 8880591021c1     | quote  6705 810cbedf9a2e     | DIFFERENT
payload-review.json: payload  6586 chars e6e34d3919a0     | quote  6586 e6e34d3919a0     | IDENTICAL
```

Round 820 amended both payloads and neither amendment reached the document. The
verify quote was short by the 473-character SPOT OBSERVATION passage; **the
report quote was short by 2383 characters — the entire item 1b**, which is the
one instruction that stops round 817's after-measurement being taken with the
wrong sampling convention and reported as DoD-6's number. A reader of §7 would
have read a brief that no longer existed, with nothing to notice.

Both quotes were regenerated from the payloads themselves rather than retyped,
and all three now agree to the byte:

```text
payload-verify.json: payload dd532466fd389aa2 (12845) | quote dd532466fd389aa2 (12845) | IDENTICAL
payload-report.json: payload 8880591021c1227b ( 9088) | quote 8880591021c1227b ( 9088) | IDENTICAL
payload-review.json: payload e6e34d3919a0…    ( 6586) | quote e6e34d3919a0…    ( 6586) | IDENTICAL
```

`bash scripts/checks/check-await-seed.sh` — **PASSED, 7/7 cases, 56/56
assertions** — so the amended payload is still well-formed JSON with the six
keys the watcher requires, and it still touches nothing real.

This is the §7 hazard of the design spec in miniature — *a write-set models
contention over bytes, not over truth* — except here the moving fact was a
brief and the documents quoting it belonged to a round that had already ended.
It is recorded rather than smoothed over, and it is **an undeclared write this
round chose to make**: see `04-phases.md` §10.

---

## 6. Everything that was run, and its verdict

| command | verdict |
|---|---|
| `scripts/checks/measure-prompt-baseline.sh` (3 ledger refs + HEAD) | PASS — 17 controls, 0 failures; HEAD 12227 |
| `pnpm test` (forge-control) | **1294/1294 pass**, 0 fail, 239 suites |
| `tsx --test src/lib/project-tick.test.ts` | 152/152 pass — includes R48's new clause gate and NF7's round-960 row |
| `tsx ../scripts/checks/check-workstream-claim.ts` | ALL PASS — 19 checks, exit 0 |
| `bash scripts/checks/check-instrument-typecheck.sh` | PASSED — 8/8 entries compiled clean, manifest complete |
| `bash scripts/checks/check-await-seed.sh` | PASSED — 7/7 cases, 56/56 assertions |
| M1–M6 (§4) | every one red, every file restored by sha |

---

## 7. What this round could NOT do, and who owns it

**Nothing was deployed, and the criterion's real proof is a future measurement.**
This round changes what planners are told; whether a planner then opens lanes is
observable only on a live project planned by the deployed prompt. That is
round 817's read (`payload-report.json`) and the deploy task's, not this one's.
Stated plainly so the next round does not mistake a green gate for a wide fleet:

- **Proved here:** the engine's width equals its workstream count for
  independent tasks (§3, cases 3.1–3.6); the guide now says so; the guide's
  other five claims survived; the branch form is the hyphen.
- **NOT proved here:** that a planner reading the new clause opens more than one.
  The DoD-6 after-measurement must report `count(DISTINCT workstream)` beside S1,
  or it measures the advice rather than the engine — `evidence/phase8-verify.md`
  §7c already says so and it remains true with the new wording.

One consequence worth handing forward: **a project whose planner opens k lanes
buys k concurrency and k integration tasks.** The guide states the cost in its
INTEGRATION paragraph, untouched here. If a later measurement shows lanes being
opened and immediately merged, that is a decomposition question for the planner
prompt, not another criterion for this bullet.
