# Phase 2 evidence record — the replica proof — `engine-task-graph`

Round 202, builder C. Written from the worktree
`/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`, branch
`project/8c591d6c`. Every command below was **re-run by this task, now**. The
parent commit is **`c54f860`** (phase 2B); this document and the harness change
it reports are the commit it sits in.

**The headline: the graph schedules exactly what the round numbers schedule
today.** All six R18 cases pass, all five of round 103's independent
predictions hold to the tick, and the three implementations of the R6 closure
rule agree with each other on all three pairs, membership *and* order.

This document's job is to say NO if something fails. §8 states what would have
made it lie and why each way is closed off, modelled on
`phase1-migration.md` §12.

---

## 1. `pnpm typecheck`

```
$ cd forge-control && pnpm typecheck ; echo "TYPECHECK_EXIT=$?"
> forge-control@0.1.0 typecheck /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control
> tsc --noEmit

TYPECHECK_EXIT=0
```

Clean — `tsc --noEmit` produced no diagnostics (NF4).

---

## 2. `pnpm test` — 888 pass, 0 fail, 0 skipped, **0 todo**

```
$ cd forge-control && pnpm test
# tests 888
# suites 167
# pass 888
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4975.818537
TEST_EXIT=0
```

`# todo` went **6 → 0**: the six R18 comparison cases are the only `todo` this
project ever had and this commit is what retires them. `# tests` went 885 → 888, a NET +3: the
round-103 prediction block of §4 adds eight, and five stub-discipline clauses
retire (§11).

The whole `task-graph-replay.test.ts` file, TAP, six suites:

```
ok 1 - R9 — the fixture is what the requirement says it is                (4 tests)
ok 2 - R18 — the harness itself runs over the real fixture                (6 tests)
ok 3 - F13 — a row inserted after 0040 is named by no frozen closure      (5 tests)
ok 4 - stub discipline — every export not yet implemented throws          (6 tests)
ok 5 - R18 — the graph is an exact replica of today's rounds              (6 tests)
ok 6 - R18 — the schedules match the round-103 prediction, on both sides  (8 tests)
1..6
# tests 35   # pass 35   # fail 0   # skipped 0   # todo 0
```

The six cases, in full, with no `todo` marker on any of them:

```
    # Subtest: R18 — the graph is an exact replica of today's rounds
    ok 1 - (a) the base fixture, straight through
    ok 2 - (b) an early round retried to ready after a later round drained
    ok 3 - (c) a task inserted into an already-drained round
    ok 4 - (d) a project paused mid-run and resumed
    ok 5 - (e) a permanently failed task — both schedulers wedge identically
    ok 6 - (f) a fix chain inserted by the OLD engine AFTER 0040 was applied
    1..6
ok 5 - R18 — the graph is an exact replica of today's rounds
```

---

## 3. The replay banner — what the instrument says about itself

Printed at import, before the first assertion, by the harness itself:

```
task-graph-replay: FIXTURE  forge-control/src/lib/fixtures/replay-operator-visibility.json
task-graph-replay: ROWS     131
task-graph-replay: SHA256   e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
task-graph-replay: RECORD   sha matches capture record
task-graph-replay: STATUS   done=120 pending=8 running=3
task-graph-replay: HEAD     c54f860
task-graph-replay: DIRTY    M forge-control/src/lib/task-graph-replay.test.ts
```

**The `DIRTY` line is disclosed, not smoothed.** It reads `M` for exactly one
file: the harness, which is the file this commit changes. It cannot read
`(none)` in a run made *before* the commit that introduces the change being
reported — that is a fixed point no ordering of commands escapes, and phase 1
escaped it only because its write-set was the evidence file alone.

So the identity claim here is bound to **bytes, not to a commit**, which is
strictly stronger. `sha256sum` at the moment of every run in this document:

| File | sha256 |
|---|---|
| `forge-control/src/lib/task-graph.ts` | `3495d9fca6c7b8bf3585b7be5e8940a0738ecbdf7d49fcc507334d3fdb7029e6` |
| `forge-control/src/lib/task-graph-replay.test.ts` | `2fa42609895a6b831c30461c584bde8f6e515d4b32a3044f9de7893d01948911` |
| `forge-control/src/lib/fixtures/replay-operator-visibility.json` | `e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7` |
| `forge-control/src/db/projects.ts` | `63b6055e54432568a8ee97a40e9ee25033e2f2c0343ca016045a87d4648ad1b8` |

Those four hashes are the bytes every number below was produced from. The
fixture's is unchanged since capture and matches its sibling capture record,
which the harness re-checks on every run (`RECORD sha matches capture record`).
`task-graph.ts`'s hash is identical to the pristine copy taken before §5's
mutations and restored after them — see §5.4.

**The reviewer's check, one line**, which prints `DIRTY (none — all three match
HEAD)` at the committed SHA and reproduces every case number in §4:

```bash
cd forge-control && npx tsx --test src/lib/task-graph-replay.test.ts
```

---

## 4. Per case (a)–(f): both sides, against round 103's prediction

Round 103 ran an independent throwaway model — Python, same fixture, no
database, deliberately not committed, **no shared code with this harness** — and
predicted ticks 14/16/15/15/4 and promotion totals 8/9/9/8/1 for cases (a)–(e),
with case (e) wedging 7 tasks on both sides. That prediction is worth exactly as
much as its being checked, so it is now **pinned in the harness** rather than
quoted in a document, and the table below is printed by the harness from the
runs the six cases actually asserted on:

```
task-graph-replay: CASE     R18-a base fixture                           legacy 14t/8p/0w  graph 14t/8p/0w  [round-103 prediction]
task-graph-replay: CASE     R18-b retry under a drained later round      legacy 16t/9p/0w  graph 16t/9p/0w  [round-103 prediction]
task-graph-replay: CASE     R18-c insertion into a drained round         legacy 15t/9p/0w  graph 15t/9p/0w  [round-103 prediction]
task-graph-replay: CASE     R18-d pause and resume                       legacy 15t/8p/0w  graph 15t/8p/0w  [round-103 prediction]
task-graph-replay: CASE     R18-e permanent failure                      legacy  4t/1p/7w  graph  4t/1p/7w  [round-103 prediction]
task-graph-replay: CASE     R18-f fix chain inserted after the migration legacy 17t/10p/0w graph 17t/10p/0w [baseline set this round]
```

(`t` = ticks to quiescence, `p` = tasks promoted in total, `w` = rows not `done`
when the loop returned.)

| Case | Predicted (r103) | Legacy measured | Graph measured | Verdict |
|---|---|---|---|---|
| (a) base fixture | 14 ticks, 8 promoted | 14 / 8 | 14 / 8 | **exact** |
| (b) retry under a drained later round | 16 ticks, 9 promoted | 16 / 9 | 16 / 9 | **exact** |
| (c) insertion into a drained round | 15 ticks, 9 promoted | 15 / 9 | 15 / 9 | **exact** |
| (d) pause and resume | 15 ticks, 8 promoted | 15 / 8 | 15 / 8 | **exact** |
| (e) permanent failure | 4 ticks, 1 promoted, 7 wedged | 4 / 1 / 7 | 4 / 1 / 7 | **exact** |
| (f) fix chain inserted after the migration | *(agrees — no number given)* | 17 / 10 | 17 / 10 | agrees; **17/10 is a baseline set this round** |

**Zero deviations to explain.** Every one of round 103's five predictions holds
to the tick, on **both** sides, and the two sides are equal in every case — which
is R18 itself.

Three things about that table are worth stating rather than leaving to be
noticed:

- **Case (f) carried no predicted number.** Round 106 established only that the
  two sides *agree* once R69's term is present, not what they agree on. 17
  ticks / 10 promoted is therefore a baseline this round measured and pinned,
  and it is labelled as such in the harness output so the next reader knows
  which five of the six numbers are predictions that held. My own first guess
  at it was 18 and the pin failed loudly against the measurement; the pin was
  corrected to the measured 17, not the measurement to the guess.
- **Case (d)'s 15, not 16.** Pausing ticks 3 and 4 costs one tick, not two,
  because the pause suppresses promotion only — rows already in flight settle
  through a paused tick, so the second paused tick overlaps work the schedule
  was going to spend anyway. Round 103 predicted 15 and 15 is what came out.
- **Case (e)'s wedge is 7, on both sides, and both stop at 4 ticks.** The failed
  lowest-round row is terminal, its same-round sibling still promotes, and
  everything above it wedges — identically under both rules.

The base schedule's tick count is separately pinned inside case-independent
assertions (`assert.equal(result.ticks, 14, "the tick cadence changed …")`), so
there are now two independent alarms on the tick semantics. §5.3 shows both
firing.

---

## 5. THE THREE-WAY CLOSURE DIFF (R6)

The R6 backfill rule has **three** implementations, and two agreeing prove
nothing if the third is the one the engine runs:

| | Implementation | What it is for |
|---|---|---|
| **SQL** | the backfill `UPDATE` in `db/migrations/0040_task_graph.sql` | what the deploy actually executes |
| **PY** | `expected` in `scripts/checks/check-migration-0040.sh` §5 | what verifies the deploy against a database |
| **TS** | `backfillClosure()` in `task-graph-replay.test.ts` | what the replica proof computes the graph side from |

### 5.1 How the diff was made honest

Every side is the **real** one, not a re-typed one:

- **SQL** is read from the rows Postgres wrote: `check-migration-0040.sh` seeds
  the 131-row fixture into a throwaway schema of a throwaway database, applies
  the migration, and dumps `id, depends_on` to `actual-deps.txt`.
- **PY** is executed by **extracting the heredoc out of the committed shell
  script with a regex** and piping it to `python3` — one line is appended to
  make it dump what it computed, and nothing above that line is altered. A
  retyped Python would have compared a scratch script against the SQL rather
  than the committed verifier against the SQL, which is the exact mistake
  `backfillClosure()`'s own doc-comment warns about.
- **TS** is the exported symbol, imported from the harness. It is `export`ed in
  this commit *for this diff and for nothing else*, and the doc-comment says so.

The diff runner is throwaway (`/tmp/closure-3way.mts`, not committed). It exits
non-zero on any disagreement **and** on a run in which fewer than three of the
three pairwise comparisons executed — a sweep whose probes miss must fail, never
certify itself.

### 5.2 The result

```
$ npx tsx /tmp/closure-3way.mts /tmp/check-0040-GgqXag/actual-deps.txt
  SQL vs TS: IDENTICAL — 131 rows compared, 0 membership difference(s), 0 ordering-only difference(s)
  PY vs SQL: IDENTICAL — 131 rows compared, 0 membership difference(s), 0 ordering-only difference(s)
  PY vs TS: IDENTICAL — 131 rows compared, 0 membership difference(s), 0 ordering-only difference(s)
  total edges  : SQL=8284 PY=8284 TS=8284
  widest row   : SQL=130 PY=130 TS=130
  root rows {} : SQL=1 PY=1 TS=1
  RESULT       : all three implementations agree on all three pairs, membership AND order
exit=0
```

**Result: the three implementations agree.** All three pairs, all 131 rows,
8284 edges each, identical in membership *and* in order — order matters because
the SQL's `ORDER BY e.round, e.created_at, e.id` is what makes two applications
of the migration byte-comparable, and an ordering-only drift would leave the
scheduler correct while breaking that property silently.

**There is no finding here.** Had they disagreed it would have outranked
everything else in this report.

### 5.3 The diff can fail — negative control

An assertion never observed failing is not evidence. The SQL dump was corrupted
in the subtlest way available — **two adjacent dependency ids transposed on one
row**, membership untouched — and the diff was re-run:

```
$ npx tsx /tmp/closure-3way.mts /tmp/corrupt-deps.txt
  SQL vs TS: DISAGREE — 131 rows compared, 0 membership difference(s), 1 ordering-only difference(s) — first: 04498cdd-2c34-4055-afe5-85e2a3ce8178
  PY vs SQL: DISAGREE — 131 rows compared, 0 membership difference(s), 1 ordering-only difference(s) — first: 04498cdd-2c34-4055-afe5-85e2a3ce8178
  PY vs TS: IDENTICAL — 131 rows compared, 0 membership difference(s), 0 ordering-only difference(s)
THREE-WAY CLOSURE DIFF FAILED: 2 disagreeing pair(s)
exit=1
```

It catches a one-position transposition, classifies it as ordering-only rather
than as a membership change, names the offending row, **and isolates which of
the three sides moved** — the two pairs involving SQL disagree, the pair that
does not involve SQL still agrees. That last property is what makes the
instrument diagnostic rather than merely alarming.

### 5.4 `check-migration-0040.sh`, re-run

Re-run because §5's SQL side reads its artifacts. Unchanged verdict:

```
--- 5. independent closure verification (R6) ----------------------------------
  | ROWS=131
  | MISMATCHES=0
  | MAXLEN=130
  | ROOTS=1
  ok   closure compared every seeded row                    = 131
  ok   closure: 0 rows differ from the independently computed one = 0
  ok   closure: at least one row carries a large array      130 >= 100
  ok   closure: at least one root row carries {}            1 >= 1
...
--- 8. assertion census -------------------------------------------------------
  assertions executed: 36
  assertions defined : 36

PASS — 0040 is re-runnable (R2), its backfill is the closure (R6), both indexes exist (R7).
       git c54f860 · sha256(0040)=75492c9bd63d9c0f… · db=forge_tg_scratch · schema=tg_check_0040
exit=0
```

`MAXLEN=130` and `ROOTS=1` are the same numbers §5.2 reports for all three
sides, arrived at through a different code path — a fourth, incidental
agreement.

### 5.5 `check-scheduler-sql.sh`, re-run

Phase 2B's behavioural proof that the **SQL** the engine runs matches the pure
functions the replay proves. Re-run here because a replica proof over
`lib/task-graph.ts` is only worth what the SQL mirror is worth:

```
  ok   R12: legacy candidate promotes once its round drains     = yes
  ok   R69: candidate promotes once the legacy row is done      = yes
  ok   R13: resumed project promotes its graph row              = yes
  ok   R14: the blocked project promoted nothing on tick 2 either = blocked
  ok   R14: still exactly one notification — the sweep is idempotent = 1
  ok   R16: a (first writer of src/x.ts in main) was claimed    = yes
  ok   R16: b (same path, same workstream) was DEFERRED         = no
  ok   R16: b stays ready — deferred, never failed            = ready
  ok   R16: c (same path, DIFFERENT workstream) was claimed     = yes
  ok   R17: d (empty write_set) was claimed                     = yes

--- 8. assertion census -------------------------------------------------------
  assertions executed: 40
  assertions defined : 40

PASS — … git c54f860 · sha256(projects.ts)=63b6055e54432568… · db=forge_tg_scratch
exit=0
```

Both scratch runs targeted `forge_tg_scratch`, a throwaway database. Neither
script will run without `$SCRATCH_DATABASE_URL`, and both refuse
`content_forge` and every database named by a DSN in the fleet's own config
before issuing a single statement. **No live database, service or endpoint was
touched by this task.**

---

## 6. THE MUTATION TRANSCRIPTS — three guards, each observed failing

An assertion that has never been observed failing is not evidence. Three guards
were broken deliberately and the red was recorded. `task-graph.ts` was copied
to `/tmp/task-graph.PRISTINE.ts` and the harness to
`/tmp/task-graph-replay.PRISTINE.ts` before the first mutation; both were
restored from those copies and their sha256 re-verified afterwards (§6.4).

### 6.1 Mutation A — R69's legacy-row term deleted (the round-106 reproduction)

The four-line loop implementing R69's term was removed from `graphReady()`,
leaving a **closure-only** graph branch. The mutation was applied by exact
string replacement with an `assert count == 1` guard, so it could not silently
match nothing and produce a green run that proved the opposite of what it
claims:

```
MUTATION A applied: R69 legacy-row term removed from graphReady()
 forge-control/src/lib/task-graph.ts | 8 +-------
 1 file changed, 1 insertion(+), 7 deletions(-)
```

```
    ok 1 - (a) the base fixture, straight through
    ok 2 - (b) an early round retried to ready after a later round drained
    ok 3 - (c) a task inserted into an already-drained round
    ok 4 - (d) a project paused mid-run and resumed
    ok 5 - (e) a permanently failed task — both schedulers wedge identically
not ok 6 - (f) a fix chain inserted by the OLD engine AFTER 0040 was applied
      R18-f fix chain inserted after the migration: promotion order diverged —
      first divergence on tick 2: legacy promoted [], graph promoted
      [511070c9-eab0-4a51-9b1b-3583b8e4007d, 608dbecb-f59d-4745-99b3-1d5636febd1f];
      only-legacy []; only-graph [511070c9-…, 608dbecb-…]

# tests 35   # pass 33   # fail 2   # skipped 0   # todo 0
```

**Round 106's prediction reproduced exactly**: five green, one red, diverging on
**tick 2**, on **the same two round-1352 ids** (`511070c9-…`, `608dbecb-…`) that
`phase1-migration.md` §13.4 named before `graphReady()` existed. The second
failure is the §4 pin — case (f)'s 17/10 baseline also refuses the mutation,
which is the two-independent-alarms property working.

This is what proves R69's term is **load-bearing rather than decorative**, and
what proves case (f) **can fail at all**. Case (f) was not made to pass by
widening `graphInput()`'s migration-time snapshot: the snapshot is unchanged in
this commit (`git diff` over the harness shows no edit inside `graphInput()`),
and if it had been widened, deleting the term would not have turned case (f)
red — it would have stayed green and this transcript would not exist.

### 6.2 Mutation B1 — the graph side made to read the round rule

`GRAPH_RULE` was replaced with `legacyRoundReady(t, ctx.all)`, i.e. a graph side
that applies the round rule. This is the attack guard 3 of the harness header
exists for, and `ROUND_WITHHELD` is the trap: every pure-graph row carries
`round = −1`, so no row has a strictly lower round and everything promotes at
once.

```
not ok 1 - (a) the base fixture, straight through
      R18-a base fixture: promotion order diverged — first divergence on tick 1:
      legacy promoted [], graph promoted [09582f74-…, 1d2a2db8-…, 338d5c27-…,
      511070c9-…, 52703dc0-…, 608dbecb-…, 6e210bfa-…, 9d23f158-…];
      only-legacy []; only-graph [all eight]

not ok 2 - (b)   not ok 3 - (c)   not ok 4 - (d)   not ok 5 - (e)
    ok 6 - (f) a fix chain inserted by the OLD engine AFTER 0040 was applied

# tests 35   # pass 25   # fail 10
```

Case (a) fails **on tick 1**, promoting all eight pending rows at once, exactly
as the guard predicts.

**And case (f) stays green — which is the guard's amended shape, measured.**
Round 106 relocated the withholding rule (a mixed input must carry real rounds,
or R69's term would be unevaluable) and stated the trade in the harness header:
*"the guard now lives in five pure-graph cases instead of six."* That sentence
was an argument. This run is the measurement: five of the six catch it, case (f)
— the one mixed input — does not, because on a mixed input applying the legacy
rule to real rounds genuinely reproduces the legacy side. The amendment cost
exactly what it said it would cost and no more.

### 6.3 Mutation B2 — `simulate()` made to settle before it promotes

The tick was inverted: in-flight rows settle to `done` first, and promotion is
then evaluated against a state in which they have already settled.

```
    ok 1 - (a) the base fixture, straight through
not ok 2 - (b) an early round retried to ready after a later round drained
      error: "the inserted 1292 task promoted on tick 1 while a 1290 task was
               still ready — today's rule does not do that"
    ok 3 - (c)   ok 4 - (d)   ok 5 - (e)   ok 6 - (f)

    (also red, independently)
      "the tick cadence changed — read simulate()'s doc-comment before editing this"

# tests 35   # pass 24   # fail 11
```

Case (b) goes red **with its own message**, not with a generic divergence: the
retried `ready` row settles before it is ever seen blocking anything, the
inserted 1292 task promotes on tick 1, and the case that distinguishes the
closure backfill from a previous-round-only one catches it. The pinned tick
count fires separately and by name. Both alarms in one run.

### 6.4 The committed tree carries none of the three

```
$ sha256sum forge-control/src/lib/task-graph.ts /tmp/task-graph.PRISTINE.ts
3495d9fca6c7b8bf3585b7be5e8940a0738ecbdf7d49fcc507334d3fdb7029e6  forge-control/src/lib/task-graph.ts
3495d9fca6c7b8bf3585b7be5e8940a0738ecbdf7d49fcc507334d3fdb7029e6  /tmp/task-graph.PRISTINE.ts

$ sha256sum forge-control/src/lib/task-graph-replay.test.ts /tmp/task-graph-replay.PRISTINE.ts
2fa42609895a6b831c30461c584bde8f6e515d4b32a3044f9de7893d01948911  forge-control/src/lib/task-graph-replay.test.ts
2fa42609895a6b831c30461c584bde8f6e515d4b32a3044f9de7893d01948911  /tmp/task-graph-replay.PRISTINE.ts

$ git diff --stat -- forge-control/src/lib/task-graph.ts
(empty)

$ git status --porcelain
 M forge-control/src/lib/task-graph-replay.test.ts

$ grep -c "MUTATION" forge-control/src/lib/task-graph.ts forge-control/src/lib/task-graph-replay.test.ts
forge-control/src/lib/task-graph.ts:0
forge-control/src/lib/task-graph-replay.test.ts:0

$ grep -c "legacy.depends_on !== null" forge-control/src/lib/task-graph.ts
1
```

`git diff` over `task-graph.ts` — the engine file mutations A touched — is
**empty**: it is byte-identical to `c54f860`, so nothing this task did to it
survives. `git status` names one modified file, the harness, and its diff is
this commit's declared change. The last grep shows R69's term back in place.
The two `/tmp` pristine copies are the restore source and their hashes match
the tree, so the restore is proved rather than asserted.

---

## 7. R20 — `grep -n "round" forge-control/src/db/projects.ts`, justified

```
$ grep -c "round" forge-control/src/db/projects.ts
85
```

85 lines match `round`; 92 match case-insensitively. The seven extra are
identifier spellings — `listVerdictRound`, `VerdictRoundRow`,
`legacyRoundReady`, and one prose `ROUND` — and are covered by the same
attributions below. Attribution is **by symbol**, not by line range, so it
survives the next edit to this file (standing rule 1).

### 7.1 The only two occurrences R20 is actually about

R20's clause is that **no promotion or claim predicate reads `round`** outside
the labelled legacy surface. There are exactly **two** such occurrences, both
inside `promoteReadyTasks()`'s single statement, both carrying
`TODO(R12-retire)` within two lines:

| Symbol | The line | Attribution |
|---|---|---|
| `promoteReadyTasks` | `AND l.round < pt.round` (R69's `NOT EXISTS` on `l`, guarded by `l.depends_on IS NULL`) | **R69's legacy-row term.** Reads `round` only *about legacy rows*, and only while any exist. On a project with no NULL row the sentinel test short-circuits and `round` is never consulted. |
| `promoteReadyTasks` | `AND earlier.round < pt.round` (inside the `pt.depends_on IS NULL` branch) | **R12's legacy branch.** Today's rule, verbatim, for rows that were never graph-scheduled. |

The **graph branch reads no `round` at all** — its three terms are the
deps-done `NOT EXISTS`, R14's cardinality equality, and R69's legacy-row term.
That is the requirement discharged.

`grep -n "TODO(R12-retire)"` covers both, as `03-quality.md` §3.2 Phase 2
demands: `projects.ts` lines carrying it are the legacy-branch prose, the R69
prose, the R69 SQL term, and the `-- LEGACY BRANCH` label; `task-graph.ts`
carries five more, on `DepsField`, `legacyRoundReady`, `graphReady`'s R69
paragraph, the R69 loop and `readyRule`. The two surfaces retire in one commit.

### 7.2 The one occurrence in a claim path, and why it is not a predicate

| Symbol | The line | Attribution |
|---|---|---|
| `claimReadyTasks` | `ORDER BY pt.round ASC, pt.created_at ASC` | **Not a predicate — an ordering.** R15 keeps the transaction shape and `02-architecture.md` §3.4 keeps this clause byte-identical. Its *meaning* changed without its text changing: `round` is now an engine-computed depth, so the clause genuinely means "shallower first". Inventing a new ORDER BY would have been an unrecorded change of claim order across the migration — precisely what R18 exists to forbid. It cannot gate promotion: every row it sorts is already `ready`. |

### 7.3 `sweepDanglingDependencies` — seven hits, **all of them comments**

R14's sweep contains **no code line** mentioning `round`. Its seven hits are all
in the doc-comment, explaining the two branches and the legacy surface. A
mechanical check: intersecting "lines containing `round`" with "lines that are
not comments" yields zero rows in this symbol.

### 7.4 Everything else — not the scheduler at all

Grouped by enclosing symbol. Of the 85 lines, 41 are code and 44 are doc-comment
prose inside the same symbols, explaining the same things; the counts below are
over all 85 and sum to 85 together with §§7.1–7.3's twelve:

| Symbol(s) | Hits | Attribution — none of these is a scheduling predicate |
|---|---|---|
| `(module preamble)` | 2 | **CORRECTED ROUND 204 — this attribution did not hold.** The header described the round rule in the PRESENT TENSE (*"nothing in round N+1 becomes 'ready' until…"*), which after this phase is false for every graph row, and it is the first thing any reader or agent sees. Calling it "what rounds *were*" was a reinterpretation the text did not support. The preamble now states the two-branch rule and the NULL sentinel, and says which of the two survives only for rows the old engine wrote. |
| `ProjectTask`, `TASK_COLS`, `TASK_COLS_PT`, `toGraphTask` | 7 | **The column exists and must be selected.** E1 rules that `round` stays a stored, engine-computed integer for Kanban grouping and human conversation (R19/R20). Selecting a stored column is not reading it to schedule. `toGraphTask` maps it into `GraphTask`, whose `round` field R69's term and `taskDepth()`'s legacy seed both need. |
| `createProject`, `createTask`, `insertChainRow`, `createFixChain` | 26 | **Task creation and identity.** `(project_id, round, role, title)` is the identity index (migration 0035) and the `ON CONFLICT` target that makes creation idempotent; `createFixChain` places its rows at `round + 1` / `round + 2`. Creation, not scheduling — and R42 gives phase 4 the job of writing `depends_on` on those chain rows. |
| `listTasksForProject`, `getProject`, `getTask` | 3 | **Display ordering and projection.** `ORDER BY round ASC, created_at ASC` on a read used by the Kanban and the plan endpoint. |
| `setTaskStatus`, `markVerdictTaskDone` | 8 | **Comments only**, describing the verdict race a *round* view creates. No code line reads `round`. |
| `retryTask`, `unwedgeProject` | 10 | **Operator recovery.** `unwedgeProject` retries the earliest round holding a failed task. This is the operator's re-entry point, not the tick's; R46 moves it to the earliest failed *group* in phase 4. |
| `roundIsComplete`, `bumpFixCycle` | 7 | **Consolidation bookkeeping**, called when a task settles. R40/R43 move the group key to `(project_id, round, workstream)` in phase 4; the group decision is preserved and only its definition is restated. |
| `listVerdictRound`, `VerdictRoundRow`, `listSettledRunningTasks`, `ChainRowOutcome` | 10 | **The consolidation group.** Reads the verdict-bearing tasks of one project+round. Not a promotion or claim predicate; phase 4 owns its redefinition. |

**Every surviving occurrence is attributed**: two to the legacy surface (R12's
branch and R69's term), one to a claim *ordering* that R15 and §3.4 both
preserve deliberately, and the rest to task creation, display, operator
recovery, or consolidation — none of which is the scheduler.

---

## 8. WHAT COULD HAVE MADE THIS RECORD WRONG

Named per standing rule 3, and what closes each off. `03-quality.md` §3.2
Phase 2 requires the reviewer to name at least two; here are six, each shown
impossible **empirically** rather than by argument, so the reviewer can check
the transcripts instead of reproducing them.

**1. A case that passes whether or not R69 exists.** This is the one that would
have made the whole phase worthless, and it is the reason case (f) is in R18 at
all. Closed by §6.1: deleting the term turns case (f) red on tick 2, on the two
ids round 106 named before `graphReady()` was written. A case that cannot fail
is not a test, and this one has now been observed failing.

**2. Case (f) made green by widening the migration-time snapshot instead of by
the term.** The one way to satisfy the gate while leaving F13 wide open, and
`03-quality.md` §3.2 makes the reviewer check for exactly it. Closed three ways:
`graphInput()` is untouched in this commit's diff; the five non-`todo` F13 tests
— which run *without* `graphReady()` — still assert that the two appended chain
rows are legacy, that **no** frozen row names them, and that the snapshot is
refused when it names a row that is not there; and §6.1 shows that with the
snapshot as it is, removing the term is still sufficient to turn the case red.
A widened snapshot would have made §6.1's run green.

**3. A false red "fixed" by loosening the harness.** A false red is worse than a
false green, because the weakened assertion then misses the divergence it was
built to catch. There was no red to explain away — the six cases passed on the
first run after the `todo` options were deleted, before any other edit — so no
expected value was moved, no assertion relaxed and no snapshot widened. The six
case bodies are byte-identical to the text phase 1 committed apart from the
removal of the `{ todo: … }` argument; `git diff` over the block shows exactly
that and nothing else.

**4. Two agreeing closure implementations while the third — the one the engine
runs — differs.** Closed by §5, which diffs all three pairwise over the
committed fixture and finds them identical in membership and order, and by §5.3,
which shows the diff detecting a single two-element transposition and naming
which side moved. The Python side is the committed script's own heredoc,
extracted rather than retyped; the TS side is the exported symbol itself. Had
the diff compared retyped copies it would have proved only that this task can
type.

**5. A harness reporting on a different build than this document.** The
`DIRTY` line is disclosed as `M` in §3, with the fixed point that makes it
unavoidable stated rather than hidden, and the identity claim is bound to four
**sha256 hashes** rather than to a commit — bytes cannot be stale. The fixture's
hash is additionally cross-checked by the harness against its sibling capture
record on every run, and `task-graph.ts`'s hash is shown identical before and
after §6's mutations. A sha naming the worktree rather than the build was one of
the previous project's instrument defects; four content hashes are the answer.

**6. Numbers re-derived in a scratch script beside the test rather than by
it.** A per-case table computed in a throwaway is a number nobody can check.
Closed by construction: `assertReplica()` records the results it asserted on
into `MEASURED`, and §4's table is printed from that map — the same runs, the
same process, the same input. The pins are asserted against those recordings, so
a table that disagreed with the assertions could not be printed at all. The
first version of the case-(f) pin was wrong (18 vs the measured 17) and the
harness said so; the pin was corrected to the measurement, which is the
direction that ordering of hypotheses requires.

**And one that is not closed, stated plainly.** The replay proves the *pure
functions* replicate today's rule. It does not, by itself, prove the SQL in
`db/projects.ts` matches those functions — that is `check-scheduler-sql.sh`'s
job, re-run in §5.5 with 40/40 assertions against a scratch database. Two
instruments, two claims; neither substitutes for the other, and the doc-comment
on `promoteReadyTasks()` states which side is authoritative if they ever
disagree ("the pure side is right and this statement is the bug").

---

## 9. Requirement → artefact

Every requirement phase 2 owns, and the **symbol or test** that proves it.

| Req | Artefact — symbol or test | Status |
|---|---|---|
| **R10** | `forge-control/src/lib/task-graph.ts`; `grep "^import" task-graph.ts` → a single `import type` from `../db/`. NF3 holds: `pnpm test` runs with no pg Pool. | done (2A) |
| **R11** | `graphReady()`; `task-graph.test.ts` → *"empty deps → ready"*, *"one done dep → ready"*, *"one pending dep → not ready"*. SQL: `check-scheduler-sql.sh` R11 assertions. | done |
| **R12** | `readyRule()` — the only interpreter of the sentinel; `task-graph.test.ts` → the three `readyRule` cases; `promoteReadyTasks()`'s `-- LEGACY BRANCH`. Replay: every case exercises it as the legacy side. | done |
| **R13** | Structural — `GraphTask` carries no project field, so `p.status = 'active'` cannot be smuggled into a per-task predicate. `check-scheduler-sql.sh` → *"R13: paused project promoted nothing"* / *"resumed project promotes"*. | done |
| **R14** | `GraphIntegrityError` from `graphReady()`; `task-graph.test.ts` → *"a dep id absent from the map throws"*, *"names EVERY missing id"*, *"dangling is checked BEFORE the deps-done term"*. SQL: `sweepDanglingDependencies()` + `check-scheduler-sql.sh` → `blocked`, one notification, idempotent. **INCOMPLETE AS SHIPPED HERE — round 203 found three routes past it** (the retry path, a row written straight to `ready`, and a duplicated or cross-project id), all closed in the fix cycle with four new `check` cases and two new unit cases. R14's text is restated in `01-requirements.md`; the measurements are in `evidence/phase2-fix-cycle-1.md`. | **done — see the fix cycle** |
| **R15** | `claimReadyTasks()` — `FOR UPDATE OF pt SKIP LOCKED`, the `active` join, `LIMIT 32`, `ORDER BY pt.round ASC, pt.created_at ASC` all unchanged; §7.2 above. | done (2B) |
| **R16** | `conflicts()`, `selectClaimable()`; `task-graph.test.ts` → the fifteen `conflicts`/`selectClaimable` cases incl. *"same path, DIFFERENT workstream → both claimed"* and the a↔b↔c non-transitivity case. SQL: `check-scheduler-sql.sh` case 7. | done |
| **R17** — contention half | `conflicts()`'s empty-set early exit; `task-graph.test.ts` → *"an EMPTY write-set intersects nothing (R17)"*, *"empty write-sets are always claimable"*; `check-scheduler-sql.sh` case 7, which drives the shipped `claimReadyTasks()`. **THE REPLAY IS STRUCK FROM THIS ROW (round 204).** It was credited here and in three other places; it never executes the rule — no `conflicts`/`selectClaimable` import, no claim step in `simulate()`. Measured: inverting the empty-set rule leaves all 35 replay tests green. | done |
| **R17** — warn half | **RELOCATED TO PHASE 4.** Amended in `01-requirements.md` R17 (*"TWO CLAUSES, TWO PHASES"*) and added as `04-phases.md` **Phase 4 deliverable 10**; R17 now appears in the phase 4 row of `01-requirements.md` §K and `04-phases.md` §9. Reason: the clause lives in the spawn path in `project-tick.ts`, which §10 assigns to phases 4 and 5 — unsatisfiable inside phase 2's file ownership. | **not done — phase 4** |
| **R18** | `task-graph-replay.test.ts` — six cases (a)–(f), all green (§2), plus the round-103 pins (§4) and the mutation transcripts (§6). | **done — this task** |
| **R19** | `taskDepth()`; `task-graph.test.ts` → chain, diamond, wide fan-out, disjoint roots, NULL/array mixture, absent dep, duplicate dep, empty collection, cycle-throws, determinism. | done (2A) |
| **R20** | The audit in §7: two occurrences in a promotion predicate, both legacy surface, both `TODO(R12-retire)`; one claim *ordering*; the rest not the scheduler. | **done — this task** |
| **R21** | Non-change. `spawnTaskRuns()`'s belt in `project-tick.ts` is untouched by phase 2 — that file is not in phase 2's write set, which is the proof rather than a promise. | done |
| **R69** | `graphReady()`'s fourth term + `promoteReadyTasks()`'s `NOT EXISTS (… l.depends_on IS NULL AND l.round < pt.round …)`; `task-graph.test.ts` → the seven R69 cases; **R18 case (f)**; and §6.1's mutation, which is what makes it load-bearing rather than decorative. | **done — proved this task** |
| **NF1** | No silent fallback added. This commit adds no `catch`, no `?? default`, no `\|\| fallback`. The harness throws with a diagnostic where it cannot proceed: `gitShort()`, `recordedSha256()`, `graphInput()`'s two refusals, `simulate()`'s tick cap, and the new *"no measurement recorded for …"* guard. | done |
| **NF6** | The legacy surface is labelled and retires as a unit: ten `TODO(R12-retire)` sites across `task-graph.ts`, `projects.ts` and the harness, covering R12's branch, R69's term and R18 case (f). | done |

---

## 10. Corpus amendments made by this task

Both are relocations found while planning this phase. Each is a gate clause
amended **where it is enforced** (standing rule 2), in this commit, with the
reasoning inline in the corpus rather than only here.

**(a) R17 split across two phases.** As written R17 was unsatisfiable inside
phase 2's declared file ownership: its warn clause lives in the spawn path in
`project-tick.ts`, which `04-phases.md` §10 gives to phases 4 and 5. Rather than
disclose-and-proceed — the habit that let a self-certifying probe survive on the
previous project — R17 now names its two clauses and their two phases,
`04-phases.md` Phase 4 carries the warn clause as **numbered deliverable 10**
with its one-line reason, and R17 appears in the phase-4 row of both coverage
tables. `04-phases.md` §9's "three entries appear in two rows" became **four**,
with R17's split spelled out beside R18's.

**(b) R18's prose named the wrong file.** It said `task-graph.test.ts`; the
replay lives in `task-graph-replay.test.ts`, as `03-quality.md` §2.1 and
`04-phases.md` Phase 1 both said all along. Round 103 recorded the discrepancy
rather than resolving it, which was right then. It is not right now: phase 2
created `task-graph.test.ts` as a real, separate file for the pure-function
cases, so the stale prose stopped being merely wrong and became **actively
misleading** — a pin that resolves, to the wrong file. Corrected, with the
correction named in R18 so it reads as a decision rather than a silent edit.

`check-corpus-map.py` re-run after both:

```
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
  defined: 69 R + 7 NF

  phase   01§K   04§9   header   verdict
    1      11     11     11     agree
    2      15     15     15     agree
    3      11     11     11     agree
    4      18     18     18     agree      ← 17 → 18: R17's warn clause
    5       8      8      8     agree
    6       5      5      5     agree
    7       4      4      4     agree
    8       8      8      8     agree

OK — R1..R69 and NF1..NF7 complete, all three statements of the map agree.
exit=0
```

**(c) THREE MORE AMENDMENTS LANDED IN THE ROUND-204 FIX CYCLE**, and are recorded
in `evidence/phase2-fix-cycle-1.md` §5 rather than duplicated here: R14 restated
(three shapes of corruption, every route into `running`), R17's proof base
corrected in all four places that inflated it, `computeRound` struck from Phase
2's deliverable 5 with `03-quality.md` §2.1's round-computation block relabelled
phase 3, and two undeclared writes added to Phase 2's file list. Two findings were
recorded as obligations on later phases rather than fixed here — R41's
hand-renumber hazard (phase 4) and R27's `400` (phase 3, whose SQL half landed in
the fix cycle).

---

## 11. Gate clauses retired by this commit

Standing rule 4: a requirement and its gate clause retire together, in one
commit, explicitly.

- **The six `{ todo: … }` options** on R18's comparison cases. Their gate — the
  phase-1 clause *"the harness must RUN and report at this phase, not that it
  must pass"* (`03-quality.md` §3.2, Phase 1) — is discharged by the harness now
  passing. The header paragraph that stated the `todo` contract is rewritten to
  state that the contract was honoured, not deleted, so the next reader can
  check the claim.
- **Five clauses of the stub-discipline list**: `graphReady`, `readyRule`,
  `taskDepth`, `conflicts`, `selectClaimable`. They asserted that these throw;
  phase 2A implemented them, so the assertions asserted that phase 2 never
  happened. Retired with the phase that discharged them.
- **NOT retired, deliberately**: `computeRound` (R23), `findCycle` (R25, R26),
  `normaliseWritePath` and `validateWorkstream` (R28), `groupKey` (R40). They
  land in phases 3 and 4 **by requirement id**, and their throwing is not a
  defect. The block comment now says so, by id, so the list cannot be emptied by
  someone who reads "stub discipline" as a phase-1 artefact.

---

## 12. What is left for phase 2's reviewer

- Re-run the one-liner in §3 and compare the banner, the six cases and the
  per-case table against §4. Everything in this document is reproducible from
  the committed tree plus a scratch database.
- Check §6.1 by repeating it: delete `graphReady()`'s R69 loop, run, see case
  (f) diverge on tick 2, restore. It takes a minute and it is the check
  `03-quality.md` §3.2 Phase 2 asks for by name.
- Verify §5's three-way diff by re-running `check-migration-0040.sh` and the
  throwaway runner, or by re-deriving the closure a fourth way. Three agreeing
  implementations is the claim; a fourth would only strengthen it.
- R17's warn half is **not done** and must not be ticked off phase 2's list. §9
  marks it RELOCATED with the amendment's two locations.
