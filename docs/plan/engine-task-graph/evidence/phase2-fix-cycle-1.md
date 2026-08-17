# Phase 2, fix cycle 1 — the record — `engine-task-graph`

Round 204. Two reviews came in on round 203's work — a gating review and a red
team — with **nine findings** between them and one place where they told me to do
opposite things. This document is what I changed, what I measured, and what I
deliberately did not do.

**Commit:** `863bc25` (code + corpus), this file appended after the mutation runs
it reports. Base: `27d300f`, the commit both reviews read.

**Nothing was deployed.** No live endpoint, no live database, no `pm2` command,
no write to `/opt/forge-ai-os` (`git -C /opt/forge-ai-os status --porcelain` →
empty, before and after). Every measurement below is against the worktree and a
scratch database I created for this round, `forge_r204_fix`.

---

## 1. Build identity of everything reported here

```
worktree            /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
git HEAD            863bc25   (dirty: 0 files)
sha256 projects.ts             e1b14c1f7a4dc8db…
sha256 task-graph.ts           5bf1e91d35a965bc…
sha256 task-graph.test.ts      9c2996f9e583bdb6…
sha256 check-scheduler-sql.sh  b0074dd7c6ec69d5…
mutation clone      /tmp/r204/clone, its own git repo at HEAD 863bc25, files
                    COPIED by `git clone --no-hardlinks` and verified regular
                    files with sha256 equal to the worktree's before each
                    mutation — never symlinks into the worktree (that failure is
                    on this project's record twice).
```

## 2. The universal gate (`03-quality.md` §3.1)

```
$ cd forge-control && pnpm typecheck      → tsc --noEmit, exit 0, no diagnostics
$ pnpm test                               → # tests 892  # suites 167  # pass 892
                                            # fail 0  # skipped 0  # todo 0
                                            # duration_ms 4763   (Postgres not needed)
$ git -C /opt/forge-ai-os status --porcelain   → empty
$ git status --porcelain (worktree)            → empty
$ grep -rn "pm2 restart forge-executor" --include='*.ts' --include='*.sh' .
    4 hits, ALL of them NEVER-worded prohibitions in project-tick.ts and its test.
$ git diff 27d300f..HEAD | grep -c '^+.*pm2 restart forge-executor'   → 0   (R66)
$ git diff --stat main...HEAD -- lib/project-tick.ts lib/project-reconcile.ts
    → empty. Untouched, so R21 and R43 hold structurally rather than by promise.
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
    → OK, R1..R69 + NF1..NF7, all three statements of the map agree, exit 0
$ SCRATCH_DATABASE_URL=…/forge_r204_fix scripts/checks/check-scheduler-sql.sh
    → PASS, 82 assertions executed / 82 declared / 82 assertion calls in the file
```

888 → 892 tests: four new cases on `graphReady`'s duplicate semantics. No test
deleted, none skipped. 40 → 82 assertions in the SQL check: cases 8, 8b, 9 and 10
plus the per-shape notification census.

`grep -rn "TODO(R12-retire)" forge-control/src` → **11 sites, was 10**. The new
one is on the rewritten module preamble's LEGACY-rule paragraph (finding 3), which
is a legacy-surface site and retires with the rest. Deliverable 6's "and nowhere
else" is intact; the count moved because the surface gained a sentence, not
because something else acquired the marker.

---

## 3. What changed, finding by finding

### Gating 1 / red-team 1 — R14 was defeated by the recovery path it invited

`retryTask()` moved a `blocked` row to `ready` without looking at the graph. The
sweep was scoped to `pending`, so it never saw the row again;
`claimReadyTasks()` re-checks contention but never dependency integrity. The row
got a run with its ghost dependency intact.

**The two reviews prescribed opposite mechanisms.** The gating review asked for
the sweep to be widened to `pt.status IN ('pending','ready') AND pt.run_id IS
NULL`. The red team said explicitly *"Do not widen the sweep to `ready` rows — the
sweep's decision 2 correctly refuses to strand live runs"*, and asked instead for
a guard in `retryTask()` **or** a term in `claimReadyTasks()`'s candidate `SELECT`.

What shipped, and why it is not a compromise between them:

1. **`retryTask()` refuses.** New `RetryOutcome` variant
   `{ok:false, reason:"dependencies_corrupt", corruption}` carrying the ids.
   Checked BEFORE the attempt cap and **not** overridable by `force` — `force`
   overrides a budget, not a fact, and offering "re-send with force" for a graph
   that cannot drain is an instrument inviting a nonsense. `unwedgeProject()`
   carries the reason out through a new additive `skipped_reasons`, and both
   routes (`POST /api/tasks/:id/retry`, `POST /api/projects/:id/unwedge`) now say
   which of the two reasons refused each row.
2. **The sweep was widened after all** — to `pending` rows plus `ready` rows with
   **no `run_id`**. The red team's *reason* is honoured exactly: `run_id IS NULL`
   is the precise form of "not started", it is the same term `claimReadyTasks()`
   uses to decide a row is unclaimed, and a `running` row or a `ready` row with a
   run attached is still never touched. Their objection was to a widening that
   could strand a live run; this one cannot. Without it, a corrupt row written
   straight to `ready` by an operator `psql`, an import, or a future writer is
   invisible to R14 forever — measured in §4, mutation B, where the row reached
   `running`.
3. **No claim-side filter, deliberately** (decision 4 on the sweep). A candidate
   `SELECT` that quietly skipped a corrupt `ready` row would leave it `ready`
   forever with nobody told — trading a silent promotion for a silent stall,
   which is the same disease in a new costume. The sweep runs first in
   `promoteReadyTasks()`, and `projectTick()` calls that before `spawnTaskRuns()`,
   so the row is blocked and notified before any claim can see it, on the same
   tick.

Three routes into `running`, each closed loudly. R14's text now says so.

### Gating 2 — R17's proof base was inflated in four places

Struck, in all four: `conflicts()`'s doc-comment, `claimReadyTasks()`'s
doc-comment, `01-requirements.md` R17, `evidence/phase2-replay.md` §9. The R18
replay does not execute the rule — it imports neither `conflicts` nor
`selectClaimable`, and `simulate()` moves rows `pending → running` with no claim
step. I reproduced the reviewer's control myself (§4, mutation E): inverting the
empty-set rule to `return true` leaves the replay **35/35 green** while
`task-graph.test.ts` goes red on two suites. R17's real proof is named instead —
the table cases plus case 7 of `check-scheduler-sql.sh`, which drives the shipped
`claimReadyTasks()`.

I chose the reviewer's first option (strike the claim) over the second (make
`simulate()` drive `selectClaimable()`), and not to save work: adding a claim step
would change what the replica proof compares, and R18's whole value is that it
compares promotion order against today's engine, which has no contention belt at
all. The replay's header now carries a **WHAT THIS PROOF DOES NOT COVER**
paragraph, so the next reader does not have to re-derive the boundary from an
import list.

### Gating 3 — the module preamble still described the rule the phase removed

`db/projects.ts`'s header said, in the present tense, *"nothing in round N+1
becomes 'ready' until every task in round < N+1 for that project is 'done'"*. It
is the first thing any reader or agent sees. Rewritten to state the two-branch
rule, the NULL sentinel, which branch survives only for rows the old engine wrote,
and what `round` is still for. `phase2-replay.md` §7.4's attribution of those two
grep hits — *"what rounds were. Prose."* — is corrected in the same commit, as a
correction and not a re-wording.

### Gating 4 — undeclared writes

`cp3-linkage.test.ts` and `project-tick.test.ts` are added to Phase 2's declared
file list as a retroactive amendment with its reason, along with this cycle's own
writes. The finding's second half mattered more than the bookkeeping, and it is
now a requirement: **R47 gains a companion-files clause** — a declared `write_set`
must include the test factories and call sites a shared-type change forces, and
`04-phases.md` Phase 5 carries it as deliverable 8. Phase 2 lived the failure
(widening `ProjectTask` forced two factory edits); under workstreams the same
omission is not a finding but the input that schedules two workstreams in parallel
over one file.

### Gating 5 — a deliverable phase 2 could not complete

`computeRound` struck from Phase 2's deliverable 5 (R23 gives it to phase 3, and
`check-corpus-map.py` agrees), with `03-quality.md` §2.1's round-computation block
relabelled **phase 3** in the same commit. While there, the other two phase-3
groups in that list — *Cycles* and *Validators* — got their phase labels too, and
the list gained a sentence saying why: an unlabelled case list read as one phase's
checklist is exactly how this finding happened.

### Red-team 2 — the pure side and the SQL disagreed on a duplicated id

R14 is written as `cardinality(depends_on)` against the number of rows named;
`graphReady()` tested membership. On `['a','a']` with `a` done, the SQL blocked the
task **and its project** while the pure function called it ready — under a
doc-comment declaring the pure side authoritative, which made the shipped
statement the bug by the corpus's own doctrine.

**Decided: a duplicate is corruption**, and R14 now says so with the reasoning.
Nothing in this engine writes one — the R6 backfill aggregates over distinct rows
of one project, R28 normalises before storage — so a duplicate in the column means
an unvalidated writer whose intent is unknown, and `blocked` plus a notification is
what that is for. `graphReady()` throws on it, naming every offender of every
shape in one message. `taskDepth()` stays benign, and its doc-comment now says why
in the same breath as its dangling-id rule: it is display code, and refusing to
draw a board is an outage where the promotion path's refusal is a repair.

### Red-team 3 — the dependency subqueries were not project-scoped

Fixed here rather than deferred to phase 3, which is a deviation from the finding's
own instruction and is stated as one. `AND d.project_id = pt.project_id` now
appears in the promote branch's two subqueries and in the sweep's predicate, all
three from one shared constant so the retry probe and the sweep cannot drift apart.
The reason for not waiting: the hole is a silent promotion and a permanent silent
stall, reachable by any writer that is not the API, and leaving a measured
correctness hole open across a phase boundary for bookkeeping is the
disclose-and-proceed habit this project is under orders not to repeat. R27 records
that its SQL half landed early and that phase 3 still owes the `400`.

The sweep now reports **three shapes** — `missing`, `foreign_ids`, `duplicated` —
because a notification that said *"names 1 dependency that no longer exists"* about
a row that exists in another project would be an instrument lying about what it
found. If a mismatch is explained by none of the three, the notification says
exactly that instead of composing a sentence that names no ids.

### Red-team 4 — the hand-renumber chain-key hazard

Not repaired: `project-reconcile.ts` is phase 4's file, and changing `chainKeys()`
would touch `chain_key` idempotency (migration 0039) from a phase whose brief
forbids it. Recorded so it cannot be lost: **R41** carries the mechanism, the
measurement (operator-only — `grep -n "SET round"` is empty), and phase 4's
obligation to either rebase the identity onto something immutable (the gating task
ids, by R29) or add a guard, **and to record the choice in R41**. `04-phases.md`
Phase 4 carries it as deliverable 11 with an acceptance criterion.

---

## 4. The negative controls — every new assertion observed failing

Six mutations, each in the `/tmp/r204/clone` repo, never in the worktree. Every
mutation was applied by a script that **asserts the pattern occurs exactly once**
and aborts otherwise, so a pattern that matched nothing could not produce a green
run that "proved" the opposite. After each, `git checkout -- .` and
`git status --porcelain` → empty.

### Mutation A — `retryTask()`'s integrity check deleted (the gating-1 finding)

```
MUTATION A applied to forge-control/src/db/projects.ts (1 site)
  git HEAD           : 863bc25
  uncommitted (subj) : 1 file(s) modified
  FAIL case 8: retryTask REFUSED the corrupt row   expected [RETRY_OK=false] got [RETRY_OK=true]
check-scheduler-sql.sh FAILED after 47 assertions      exit=1
```

Then the rest of the finding, driven manually against the state that run left
behind, because the script stops at its first failure:

```
task 00000000-…-00000000180c → status=ready  run_id=NULL  depends_on={…180a, …18ff}
CLAIMED_THE_CORRUPT_ROW=true
STATUS_AFTER_CLAIM=running depends_on=["…00000000180a","…0000000018ff"]
```

A run spawned for a task whose dependency does not exist — both reviews' finding
1, reproduced end to end.

### Mutation B — the sweep's status predicate reverted to `pending` only

```
MUTATION B applied to forge-control/src/db/projects.ts (1 site)
  FAIL case 8b: the sweep reached a READY row (decision 2, widened)
                expected [blocked] got [running]
check-scheduler-sql.sh FAILED after 57 assertions      exit=1
```

`running`, not merely `ready`: case 8's claim step picked the corrupt out-of-band
row up on its way past. This is the measurement that decides the disagreement
between the two reviews — a `pending`-only sweep does not merely fail to notify,
it lets the row run.

### Mutation C — `graphReady()`'s duplicate arm deleted

```
MUTATION C applied to forge-control/src/lib/task-graph.ts (1 site)
  FAIL case 9 MIRROR: graphReady() no longer calls a duplicate READY
                expected [MIRROR=threw:GraphIntegrityError] got [MIRROR=true]
check-scheduler-sql.sh FAILED after 65 assertions      exit=1

$ pnpm test  (same mutant)  → # tests 892  # pass 889  # fail 3
   not ok 170 - graphReady — the graph branch (R11, R14, R69)
```

`MIRROR=true` is the divergence itself: the pure side calling ready the row the
SQL blocked the project over.

### Mutation D — `AND d.project_id = pt.project_id` removed from all three sites

```
MUTATION D applied to projects.ts (3 sites, each unique)
  FAIL case 10: naming a foreign DONE row did NOT promote   expected [no] got [yes]
check-scheduler-sql.sh FAILED after 67 assertions      exit=1
```

### Mutation E — R17's empty-set rule inverted (the gating-2 control)

```
MUTATION E applied to forge-control/src/lib/task-graph.ts (1 site)
$ tsx --test src/lib/task-graph-replay.test.ts → # tests 35  # pass 35  # fail 0
$ pnpm test                                    → # tests 892 # pass 890 # fail 2
   not ok 174 - conflicts — exact-path intersection (R16, R17)
   not ok 175 - selectClaimable — the contention belt (R16)
```

The replay is **silent** about R17, measured rather than reasoned. Its four
credits are struck.

### Mutation F — the repeated status/run_id terms on `blocked_tasks` deleted

The one claim in this diff that rested on argument alone: that repeating the
status and `run_id` terms on the sweep's UPDATE (not only in its CTE) stops it
clobbering a row a concurrent claim has just taken, because an UPDATE re-checks
its own WHERE against the row version it locks. Measured with two sessions — one
holding `SELECT … FOR UPDATE` + `UPDATE … 'running'` open for six seconds, exactly
as `claimReadyTasks()` does, while the sweep runs in the other:

```
SHIPPED (the guard present)
  before: task=ready   project=active
  sweep returned after 5s (it waited on the claimer's lock)
  after : task=running project=blocked      ← the live claim survived
  notified: 1

MUTANT (the two terms deleted)
  before: task=ready   project=active
  sweep returned after 5s (it waited on the claimer's lock)
  after : task=blocked project=blocked      ← the run is stranded
  notified: 2
```

Recorded honestly: the project is blocked and the operator notified in **both**
cases, because `blocked_projects` carries no such guard and the CTE's snapshot is
what notifies. That is the intended shape — loud, and without taking a run's
output away. `projectTick()` is called from one serialized loop in a single
fork-mode process, so this race is not reachable in the shipped deployment today;
the guard is what makes the statement correct rather than the deployment.

---

## 5. Corpus amendments made by this cycle

Every one is a clause amended **where it is enforced**, in the same commit as the
code (standing rules 2 and 4).

| Amendment | Where | Why |
|---|---|---|
| **R14 restated** — three shapes, the duplicate semantics settled, every route into `running`, `taskDepth()`'s exception explicit | `01-requirements.md` R14; enforced in `sweepDanglingDependencies()`, `retryTask()`, `graphReady()`, `check-scheduler-sql.sh` cases 3/4/8/8b/9/10 | It was a guarantee with three holes in it, and its text was silent about two of the three shapes and about the retry route entirely. |
| **R17's proof base corrected** | `01-requirements.md` R17 (body + *How proved*), `conflicts()`, `claimReadyTasks()`, `phase2-replay.md` §9, `task-graph-replay.test.ts`'s header | The replay does not execute the rule. Four places said it did. |
| **`computeRound` struck from Phase 2** | `04-phases.md` deliverable 5; `03-quality.md` §2.1 relabelled (Round computation, Cycles, Validators → phase 3) | The clause made phase 2 close with a deliverable its own plan said it had not completed — a gate unsatisfiable inside the phase's scope. |
| **Phase 2's file list amended** | `04-phases.md` Phase 2 | Two forced writes in `c54f860` were undeclared (§3.1 item 4), plus this cycle's own writes, declared before the fact. |
| **R47 gains the companion-files clause** | `01-requirements.md` R47; `04-phases.md` Phase 5 deliverable 8 | A write-set that omits the test factories a shared-type change forces is how two workstreams clobber once contention is computed from it. |
| **R27 records its SQL half** | `01-requirements.md` R27 | The SQL correlation landed in phase 2 rather than phase 3; phase 3 still owes the `400`, and the two are not the same thing. |
| **R41 records the hand-renumber hazard** | `01-requirements.md` R41; `04-phases.md` Phase 4 deliverable 11 + acceptance criterion | Phase 4's `groupKey` keeps `round`, so the hazard survives phase 4 by default unless phase 4 decides otherwise on purpose. |
| **`check-corpus-map.py` prints DIRTY** | the script's `sha()` | It printed a commit sha while reading an edited working copy. "A sha naming the worktree rather than the build" is on this project's record. |
| **The assertion census checks its own constant** | `check-scheduler-sql.sh` §8 | `EXPECTED_ASSERTIONS` is maintained by hand; the remaining failure mode was an author editing it to match a run. Two independent numbers, both printed. |

`check-corpus-map.py` after all of them:

```
  defined: 69 R + 7 NF
  phase   01§K   04§9   header   verdict
    1..8   all agree
OK — R1..R69 and NF1..NF7 complete, all three statements of the map agree.  exit=0
```

---

## 6. What would have made THIS record report a pass wrongly

1. **A shadow tree silently testing HEAD.** `git clone --no-hardlinks` into
   `/tmp/r204/clone`; `ls -la` shows regular files; `sha256sum` matched the
   worktree's bytes before each mutation; the clone's own banner prints its own
   HEAD; and every mutation **turned red**, which a tree reading unmutated code
   could not do.
2. **A mutation that never applied.** Every one went through a script asserting
   `count(pattern) == 1`, and mutation D's three sites were asserted
   independently. A pattern that matched nothing aborts instead of running.
3. **A probe that certifies an empty database.** `SEED_EXPECTED_ROWS = 26` is
   asserted, every case names its rows by literal uuid, and the promoted SET is
   diffed from full status snapshots rather than read off a rowcount.
4. **A notification counted from someone else's run.** The schema is dropped and
   recreated per run, and the census asserts one notification **per corrupt row**
   as well as the total — a total alone would pass if one row notified twice and
   another not at all.
5. **A new case quietly moving an old case's number.** Cases 8–10 are seeded
   `paused` and activated only after case 4's single-notification census has been
   taken, so every pre-existing assertion still measures the world it was written
   for. `git diff 27d300f..HEAD -- scripts/checks/check-scheduler-sql.sh` shows no
   expected value of cases 1–7 changed except the R14 complement query, which was
   rescoped to match the widened sweep and is named in the diff.
6. **A mirror assertion that could only agree.** The `mirror` step is taken
   **before** the sweep, because `graphReady()`'s first term is `pending` and a
   swept row answers `false` for a reason that has nothing to do with its
   dependencies. Asking after the sweep would have reported agreement the pure
   side never expressed — and did, on the first draft: case 8 read
   `MIRROR=false` until the probe was moved. Case 8b has no mirror assertion at
   all, for the same reason, stated in the script rather than omitted.

## 7. Unsatisfiable gates found

**One, and it is finding 5's:** Phase 2 deliverable 5 required `computeRound`,
which R23 assigns to phase 3 — a clause phase 2 could satisfy only by writing
another phase's function. Amended where it is enforced, with `03-quality.md`
§2.1's matching block, in the same commit.

Nothing else. `EXPECTED_ASSERTIONS` was satisfiable and is now checked twice.
R14's front half remains observable only as the complement of the sweep, and the
script asserts that complement mechanically rather than demanding an isolation
that the shipped call order makes impossible.

## 8. What is left for the re-check

- Re-run §2's five commands. Everything here is reproducible from `863bc25` plus a
  scratch database.
- Repeat any of §4's six mutations; `/tmp/r204/mutate.py` and the two runners are
  gone with the clone, and the patterns are quoted above in full.
- Scratch database `forge_r204_fix` is left in place, schema `tg_check_sched`,
  holding the last clean run's state plus the `epq-probe` project from mutation F.
- **Still open, by design:** R27's `400` (phase 3), R41's chain-key decision
  (phase 4), R17's warn clause (phase 4). None is phase 2's, and each is recorded
  where its phase will read it.
