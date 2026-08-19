# Round 970 — the fix cycle inherits the previous builder's report and write-set

*Builder transcript. Branch `project/8c591d6c`, parent `3ae45ed`. Worktree only:
nothing was deployed, `/opt/forge-ai-os` was neither read nor written.*

---

## 1. What was broken, in two halves

`mergeFeedback()` has always carried every dissenting verdict into the fix
builder's brief, **full and untruncated**, headed by role and task. Its own
comment is right: *"the builder needs the actual reasoning, not a summary of
it."* The inspector's punch-list survived. Two things did not.

**Half one — the first carpenter's knowledge.** The fix builder received the
critique with no trace of what the ORIGINAL builder did, tried, rejected or
learned, so it re-derived the same map. Measured over **3,899 Bash calls** by
this fleet's builders: search **25.5%** + read-via-shell **24.1%** — half of a
builder's shell work is that re-derivation. Konrad: *"using a second worker who
doesn't know what the first worker knew is quite unreasonable — as if for each
leg of a table you spawn a new carpenter."*

**Half two — the write-set, reported independently by two builders.** A fix
builder was created from the verdict group and inherited the **reviewer's**
declared `write_set` — typically one report file — while its job is to change the
source the reviewer criticised. Measured 2026-08-18: `connections` fix cycle 1
wrote **20 source files, all undeclared by construction**; `vault` fix cycle 1
had the same shape and tabled it honestly rather than hiding it. The consequence
is worse than untidiness: **every fix cycle looked like a write-set violation to
its own re-checker**, which trains reviewers to wave the violation through, after
which a genuinely undeclared write is indistinguishable from the normal case.
`metadata.strict_write_sets` makes it a hard 400 for a hand-seeded task while the
engine's own chain rows sailed past.

---

## 2. THE FINDING AGAINST THE BRIEF — "round R" is off by at least one

The brief said to carry *"the final report of each **BUILDER** task at round R"*
and to inherit *"the write_sets of … the builders of the round that produced the
NEEDS_FIXES"*. Both phrasings are round-literal, and under the graph this project
builds they are wrong:

- `GRAPH_GUIDE` (project-tick.ts) instructs planners: *"REVIEWERS are a genuine
  join: one reviewer depending on EVERY builder of its group."*
- `computeRound()` (task-graph.ts) gives that reviewer `1 + max(dep.round)`.

So the builders whose work a round-R verdict judges sit at **R-1**, and at **R-2
as well** whenever they chain among themselves — builders at 4 and 5, reviewer at
6. A `round - 1` lookup returns the round-5 builder and silently misses the
round-4 one, and a `round` lookup returns nothing at all. Either reads as
complete.

**Implemented against the dependency EDGES instead.** `priorBuilderWork()` takes
the union of the gating tasks' `depends_on`, narrowed to `role = 'builder'`. That
is the graph's own answer to *whose work is this*, it is the thing this project
exists to make authoritative, and it is robust to how the rounds happened to fall.

It also **bounds the fix-cycle depth for free**, which is constraint 2 of the
brief: a cycle-2 re-checker's `depends_on` is `[cycle-1 fix builder]` and nothing
else, so cycle 2 inherits exactly one report — cycle 1's — and cycle 3 inherits
cycle 2's. **No cycle ever inherits its ancestors in full.** The bound is the
graph's, not a counter's.

Recorded as a finding rather than reinterpreted quietly (standing rule 1), and
carried into `04-phases.md` §10 and into the report to the manager chat.

---

## 3. What was built

### 3.1 `forge-control/src/lib/project-reconcile.ts` — the pure half

| symbol | what it is |
|---|---|
| `PriorWorkReport` | one task whose work is being fixed: `taskId`, `title`, `createdAt`, `writeSet`, `report`. **`report` is the final assistant message and never the thread** — a builder's thread runs to ~189 entries and cost per unit of work rises 2.2x with session length. |
| `PRIOR_WORK_BUDGET = 24_000` | characters of **carried report text**, shared across every report in one brief. Headings, write-set lines and truncation notices sit OUTSIDE it, so the number means one thing and the arithmetic has no overhead term to get wrong. |
| `orderPriorWork()` | sorts by `(createdAt, taskId)` ascending — both immutable columns. `<`, not `localeCompare`. |
| `allocateReportBudget()` | fair share, shortest first, surplus redistributed. Pure function of (ordered lengths, budget). |
| `fixBuilderBrief()` | `mergedBrief` + the accounts, headed CONTEXT NOT INSTRUCTION and explicitly subordinate to the findings. |
| `inheritedWriteSet()` | the deduped, sorted union — **one implementation**, read by both the row and the brief. |
| `fixChainGraphFields()` | `members` split into `gating` (ids → `depends_on`) and `fixing` (write-sets → the union). |

`mergeFeedback()` is **byte-untouched**: `git diff` on that function is empty.
Its output is still `RoundDecision.mergedBrief`, and that is still what the
re-checkers receive.

### 3.2 Why the re-checkers do NOT get the accounts

`recheckBrief(c.role, decision.mergedBrief)` is unchanged. A re-check decides
whether each ORIGINAL concern is now answered; handing it the builder's own
account of its work is handing the defence to the judge. It also keeps every
re-check brief byte-identical to the one it replaced. A test pins both the
positive and the negative form of this.

### 3.3 Where the budget is spent, and where it is not

`fixBuilderBrief` is composed at the CALL SITE in the `fix` branch of
`consolidateVerdictGroup`, not inside `consolidateVerdictRound`. Consolidation
runs every 10s per gating group and answers `wait` or `pass` almost every time; a
query issued above the `switch` would be paid on every one of those ticks to
serve the one branch that uses it. `RoundDecision`'s shape is unchanged, which is
also why every existing case in `project-reconcile.test.ts` that calls
`consolidateVerdictRound` passes **unmodified**.

### 3.4 The empty union is empty, and says why

There is **no fallback** to the gating rows' write-sets. A legacy group whose
verdict tasks carry the `depends_on` sentinel reaches no builder, and the row
then declares `write_set = []` — honest, and visible to the re-checker as empty.
Three things say so rather than one:

1. `fixBuilderBrief` emits a `NOTHING COULD BE CARRIED` section stating that the
   empty set is *"not because it writes nothing"*.
2. `consolidateVerdictGroup` logs a `console.warn` naming the group and cycle.
3. `emptyWriteSetWarning()` (R17) already fires on the spawn path for any builder
   with an empty `write_set`.

---

## 4. Idempotency — what it rests on, stated

`mergeFeedback` feeds `createFixChain`, whose safety rests on the merged brief
being a pure function of its inputs. The additions preserve that:

| possible nondeterminism | why it is absent |
|---|---|
| a clock | nothing calls `Date`/`now()`. `createdAt` is the row's immutable `created_at`, used **as a sort key only** and never printed. |
| ordering | `orderPriorWork` sorts by `(createdAt, taskId)` **inside this module**, not by trusting the caller's `ORDER BY` — proved by a test that reverses the input and asserts byte-identical output. |
| a counter or a task id in the text | task ids appear only inside a truncation notice, and a task id cannot be renumbered (R29). |
| the truncation arithmetic | every number in the notice is a pure function of the inputs. |

The one hazard that is **inherent and pre-existing**: if a previous builder's run
is resumed between two consolidations of the same group, its last assistant
message changes and so does the brief. That is exactly the hazard the verdict
text already carries (`verdictMemberSettled`'s accepted trade-off), and it does
not touch `chain_key`, which is still a pure function of `(round, cycle,
workstream)`.

---

## 5. Evidence

### 5.1 Unit suite — `pnpm test`

```
baseline (3ae45ed):  # tests 1294  # pass 1294  # fail 0
after round 970:     # tests 1315  # pass 1315  # fail 0
```

21 new cases: **T30** (7 — both reports and the verdict, authority order, the
`(createdAt, taskId)` order imposed here, the id tiebreak, byte-identity, the
empty list, the null report), **T30b** (6 — the cut, the named omission, the
shared budget, the fair share, the invariants, the boundary both sides),
**T30c** (5 — the union, the reviewer's paths absent, the empty union, row and
brief agreeing, order-freedom). T23 and T29 updated for the parameter split;
T27 amended and extended by 3 cases.

### 5.2 Typecheck

```
$ ./node_modules/.bin/tsc --noEmit                      # forge-control      → exit 0
$ ... --strict ... ../scripts/checks/check-fix-chain-graph.ts                → exit 0
```

### 5.3 `gates-808.sh --strict` — 25 gates, **RED: 0**

```
$ export GATES_ENGINE_ALLOW='forge-control/src/db/projects.ts,forge-control/src/lib/project-tick.ts,forge-control/src/lib/project-tick.test.ts'
$ bash scripts/checks/gates-808.sh --strict
 ... RED: 0        (gates 23/24 SKIPPED — browser harness not requested)
```

The control read was taken FIRST, with the variable unset, exactly as
`03-quality.md` §3.1 item 12 requires: exit **1**, naming
`db/projects.ts`, `project-tick.ts`, `project-tick.test.ts` and nothing else —
the three the allow list buys, all three in §10. **No widening**: the list is the
one already written in the quality doc, unchanged by this round.

### 5.4 `check-instrument-typecheck.sh` — universal gate item 9

```
subjects found 44   subjects compiled 44   type failures 0   fidelity violations 0
missing 0   uncovered 0   suppressions 0        wall clock 173s
check-instrument-typecheck.sh PASSED — 44/44 subjects compiled clean.
```

### 5.5 `check-fix-chain-graph.ts` §6b — the SQL, against real rows

`listTaskReports` is the only part of this round that is SQL rather than a pure
function, so it is proved against rows. `EXPECTED_ASSERTIONS` 33 → **40**.

```
--- 6b. ROUND 970: listTaskReports — the fixed work, by edge ------------------
      ok   only BUILDERS come back — the planner dependency is filtered out
      ok   …and in created_at order, NOT the order the ids were passed in
      ok   the LAST assistant message by thread timestamp, not the first and not the last array slot
      ok   a task with NO run yields last_text null rather than vanishing from the result
      ok   the declared write-sets ride along — this is what the fix builder inherits
      ok   an empty id list returns [] without a query
      ok   an id from ANOTHER project is refused by the project_id term
  assertions run    : 40 (expected 40)
  assertions failed : 0
  PASS
```

Scratch database **`forge_r970_fixchain`**, named per run rather than shared —
two concurrent runs on one scratch name deadlock or return wrong arithmetic, and
the deadlock is the lucky face. Schema `tg_check_fixchain`, dropped by the
script's own teardown and asserted gone.

Two details of that fixture are deliberate, because a lazier one would have
passed wrongly:

- **Each run's thread carries MORE THAN ONE assistant message**, so "the last
  one" is a real choice rather than the only one available.
- **`RUN_LATE`'s entries are stored out of timestamp order** — the later `ts` at
  array index 0. The projection orders by thread timestamp, and a fixture seeded
  in order could not tell that apart from "take the last array slot".

**The instrument caught its own bug before it caught anything else.** The first
run aborted: my seed ids `fc31`–`fc34` collided with §6's `T_OTHER` (`fc31`), and
the script refused rather than silently reusing a row. Moved to `fc41`–`fc44`.

---

## 6. WHAT WOULD HAVE MADE THESE INSTRUMENTS REPORT A PASS WRONGLY

Six mutations, applied one at a time to the worktree, each reverted from a
byte-checked backup (`sha256sum -c` after every restore — `git checkout --` was
NOT used, it would have reverted to `HEAD` and destroyed the uncommitted work).

| # | mutation | expected | observed |
|---|---|---|---|
| A | `inheritedWriteSet()` returns `[]` always | the union tests fail | **4 red** — incl. `the builder row inherits the builders' union`, `the row and the brief report the SAME union` |
| B | `orderPriorWork()` returns the input unsorted | the ordering tests fail | **2 red** — `the order is (createdAt, taskId) and is imposed HERE, not by the caller`, `the id tiebreak decides…` |
| C | truncation disabled (allowance = full length) | the budget tests fail | **4 red** — incl. `the omission is NAMED, with the numbers it was measured in` |
| D | `fixBuilderBrief()` returns `mergedBrief` (today's behaviour) | most of T30 fails | **11 red** |
| E | `project-tick` feeds the GATING rows' write-sets again (**the defect**) | the wiring pin fails | **1 red** — `project-tick builds the chain's graph fields with fixChainGraphFields` |
| F | re-checkers handed `fixBuilderBrief(...)` | the negative pin fails | **1 red** — `project-tick carries the previous builders' reports into the fix brief, and only there` |

After the sixth restore: `# tests 1315  # pass 1315  # fail 0`, and both subject
files byte-identical to the pre-mutation sha256.

Four further traps closed in the tests themselves:

1. *"Both reports are present" passing on text the HEADER also contains.* Every
   fixture body carries a token that appears nowhere else — `KNOWLEDGE-ALPHA`,
   `KNOWLEDGE-BETA` — and the header is asserted separately.
2. *"Byte-identical twice" passing trivially* — a pure function called twice on
   the same array is identical by construction. The falsifiable assertion is that
   a **reversed** input yields the same bytes.
3. *"The write-set is the union" passing because the reviewer declared the same
   paths.* The reviewer's fixture write-set is **disjoint** from the builders',
   and its path is asserted **absent**.
4. *A shared-budget count contaminated by prose.* Counting `x` characters
   over-counted by exactly **5** — measured, not guessed: `fix`, `fixing` and
   `excuses` in the section header, plus `excerpt` in each of the two truncation
   notices. The filler is now `█`, which appears nowhere in the module's prose.

---

## 7. Write-set — declared, and what was written outside it

**DECLARED:** `forge-control/src/lib/project-reconcile.ts`,
`forge-control/src/lib/project-reconcile.test.ts`,
`forge-control/src/lib/project-tick.ts`.

**WRITTEN OUTSIDE IT — four paths, disclosed here, in `04-phases.md` §10, and in
the commit message:**

| path | why it had to change |
|---|---|
| `forge-control/src/db/projects.ts` | `listTaskReports()`. The reports must be fetched **by id**, and no existing function returns a task's last assistant message by id. Putting the query in `project-tick.ts` to stay inside the declared set would have broken the module layering this repo keeps — all SQL in `db/*` — which is a worse defect than a disclosed write. It is declared at the PROJECT level (§10, phases 2/3/4) and is already in `GATES_ENGINE_ALLOW`. |
| `scripts/checks/check-fix-chain-graph.ts` | **forced by the API change** — it calls `fixChainGraphFields` and would not compile otherwise (gate 9 compiles every file under `scripts/checks/`). It also gains §6b, because the new SQL had nowhere else to be proved. |
| `docs/plan/engine-task-graph/04-phases.md` | §10 disclosure and the round-970 section, per the round-213/215/962/964 precedent: **disclose, not abstain**. |
| `docs/plan/engine-task-graph/evidence/round970-builder-report-inheritance.md` | this file. |

Nothing else. No migration, no route, no schema change, no deploy, no
`pm2 restart`, no GitHub push, and **no command of any kind issued against
`/opt/forge-ai-os`**.

---

## 8. What is left for the reviewer

1. **The finding in §2 is a design call I made, not one the brief made.** If the
   reviewer disagrees that the edges beat `round - 1`, the change is one function
   (`priorBuilderWork`) and one test.
2. **`PRIOR_WORK_BUDGET = 24_000` is chosen, not derived.** The reasoning is on
   the constant. Argue with it there; it is a single number with a single reader.
3. **The truncation cut is a hard character slice**, mid-word if it lands there.
   Deliberate: a line-boundary cut is more arithmetic to keep byte-identical, and
   the notice makes the cut visible either way.
4. `check-fix-chain-graph.ts` needs `SCRATCH_DATABASE_URL` and is **not** part of
   `pnpm test` (NF3 — the unit suite is hermetic). Re-run it with a scratch name
   of your own, not `forge_r970_fixchain`.
