# Round 820 — fix cycle 1 on round 819's gating review

Task `3610b0fc-a2f3-4b01-a8ca-e1d7b5f0a621`, `fix_cycle = 1`, `chain_key =
fix:819:1`, workstream `main`, **`write_set = []`** — see §6, which is about why
that is not a lapse and cannot be fixed by a brief.

**Tree.** Worktree
`/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`, branch
`project/8c591d6c`. Parent tip **`dc94603`** (round 819's reviewed tip),
merge-base with `main` **`9b960ef`**, `main` at **`22967d6`**.

**Round 819 raised eight findings. Round 820 closes four of them, amends two
gates it found unsatisfiable, and closes none of the remaining four — each of
which is named in §7 with the reason and the owner.** Nothing below is disclosed
and proceeded past; the four open ones are open because they belong to a deploy
task, to another live task, or to a decision that is not mine.

| # | round 819's finding | round 820 |
|---|---|---|
| 1 | an open fix cycle (task 962) blocks the project | **not closed — §7.1.** 962 is another task's row. Its six findings are read and §7.1 says which of them round 820 already discharged. |
| 2 | `check-workstream-claim.ts` asserts a cap it never executes | **CLOSED — §2.** Both mutations re-run and killed. |
| 3 | DoD-6 FAILED, the fix committed but undeployed | **not closed — §7.2.** Deploy-only; a build task may not run it. |
| 4 | `/opt/forge-ai-os` dirty (`AssistantThread.tsx`) | **not closed — §7.3, and deliberately so.** It is a destructive op on someone else's uncommitted work, in the live checkout, from a build task. |
| 5 | item 9 ran at 8 of 43 subjects | **CLOSED — §1.** `main` merged; 43/43. |
| 6 | `write_set = []` on three builder rows | **gate amended where it is enforced — §6.** The seeding site *cannot* comply; the gate said it could. |
| 7 | two bare `file:NN` pins with no SHA | **CLOSED — §4.** |
| 8 | §3.2's S3 clause names a stale `131` | **gate amended where it is enforced — §5.** |

---

## 1. Finding 5 — the merge, and item 9 at directory coverage

Round 819 measured item 9 running **8 of 43** subjects and named the cause: this
branch had never merged `main`, so its copy of
`scripts/checks/check-instrument-typecheck.sh` was the **pre-round-500
manifest-scoped** version and `tsconfig.checks-instruments.json` did not exist
here. Confirmed before acting, not inherited:

```
$ git rev-parse HEAD                    dc9460390afdbc23969daa577f01bdac7b8cd198
$ git rev-parse main                    22967d66b284113fb0b629edc16f6cc99eb91e64
$ git merge-base main HEAD              9b960ef51e690bba061a42e7110640cbfb6dea05
$ find scripts/checks -name '*.ts' -o -name '*.tsx' | wc -l          43
$ ls tsconfig.checks-instruments.json   <absent>
```

**The merge.** `git merge main --no-commit --no-ff`. Two-sided overlap was three
files; two auto-merged (`03-quality.md`, `evidence/phase8-tooling.md`) and one
conflicted.

**`scripts/checks/instrument-manifest.txt` — resolved by reasoning, never by a
strategy flag.** `-X ours`/`-X theirs` were not used, per round 819's
instruction. The conflict is not textual, it is **semantic**: on this branch the
file is an *inclusion list* (the gate compiled the paths named in it); on `main`,
after that project's round-500 rewrite, it is a **waiver ledger** whose entries
*excuse a named failure* and can never obtain coverage. Carrying our seven
inclusion lines across would have written seven malformed waivers — each missing
all four required fields, each excusing a failure that does not exist — and the
gate fails such an entry by name. The correct resolution is `main`'s file with
**zero ledger entries**, which is that project's stated target state:

```
$ git show main:scripts/checks/instrument-manifest.txt > scripts/checks/instrument-manifest.txt
$ grep -vE '^\s*#|^\s*$' scripts/checks/instrument-manifest.txt | wc -l          0
```

**Item 9 after the merge** (`bash scripts/checks/check-instrument-typecheck.sh`,
run from the repo root, both dependency trees installed with
`--frozen-lockfile --prod=false` first):

```
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time
  scanned …: 43 file(s); enumerated as subjects: 43
  subjects found   : 43

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

WAIVERS — every exclusion is printed here, on every run (R14)
  ok: 0 waivers — the ledger is empty

CENSUS
  subjects found 43   subjects compiled 43   type failures 0   fidelity violations 0
  missing 0   uncovered 0   suppressions 0
check-instrument-typecheck.sh PASSED — 43/43 subjects compiled clean.
ITEM9_EXIT=0
```

**8 → 43, zero waivers, zero suppressions.** Re-run a second time after §2's
edit to `check-workstream-claim.ts` (a subject of this gate): 43/43, exit 0
again.

**§3.1 item 9's prose needed no edit from me, and that is worth stating rather
than silently skipping.** Round 819 asked for the prose to be amended in the
same commit because it "still describes the manifest as an inclusion list and
the retired manifest guard as live". It does not, after the merge: `main`'s
`03-quality.md` already carries the corrected item 9 — glob enumeration, the
manifest demoted to a waiver ledger, the guard named as retired, both dependency
trees, the `--prod=false` trap — and the merge brought that text in. Verified by
reading the merged file, not by assuming the merge did it.

---

## 2. Finding 2 — the instrument that named a cap it never executed

This is the finding two reviewers raised (round 961's finding 2, round 819's
finding 2) and it is the one that matters, because it is an **instrument lying
before the code did**. `check-workstream-claim.ts` §3 asserted a six-lane
fan-out labelled *"PROJECT_MAX_WORKSTREAMS=6 — the cap, and the widest lawful
fan-out"*, and §5 asserted `GRAPH_GUIDE` mentions *"at most
PROJECT_MAX_WORKSTREAMS distinct ones"* as *"the cap §3.6 exercises"* — while
importing neither the constant nor R39's guard. `grep -n PROJECT_MAX_WORKSTREAMS`
on that file returned two hits, both string literals.

### 2.1 What had to change in the engine, and how little

R39's decision lived inline in the `POST /:id/tasks` handler, downstream of a
database read. The only instrument that could reach it was `check-task-api.ts`
case 13, which needs `$SCRATCH_DATABASE_URL` — so the one instrument a build
task can afford to run could not reach the guard at all.

`forge-control/src/routes/projects.ts` now exports the decision as a pure
function the handler calls:

```ts
export function workstreamCapRefusal(
  presentWorkstreams: readonly string[],
  requestedWorkstream: string,
): string | null
```

`null` is the 201 path; a string is the exact `error` body of the 400. **The
route, the status code and the message bytes are unchanged** — the handler is
now five lines calling it.

**The control is EXECUTED, not argued from the fact that the file is
unmodified.** "I did not edit the test" proves nothing about a refactor of the
code it tests, so `check-task-api.ts` was run in full against a scratch
Postgres (`forge_tg_scratch`, created against the `postgres` maintenance
database exactly as that instrument's header authorises; never a statement
against `content_forge`):

```
--- case 13: project would exceed the workstream cap → 400 (R39)
    13 seventh workstream on a capped project
      req  {"role":"builder","title":"c13",…,"workstream":"zeta"}
      res  400 {"error":"project already has 6 workstream(s) (limit PROJECT_MAX_WORKSTREAMS=6): alpha, beta, delta, epsilon, gamma, main; refusing to create a task in new workstream \"zeta\""}
      ok   13 status — = 400
      ok   13 message names the limit — body names "limit PROJECT_MAX_WORKSTREAMS=6"
      ok   13 message lists the workstreams sorted — body names "alpha, beta, delta, epsilon, gamma, main"
      ok   13 message names the refused workstream — body names "new workstream \"zeta\""

--- census -------------------------------------------------------------------
  cases planned              : 20      cases that ran an assertion: 20
  assertions declared        : 111     assertions executed        : 111
  assertions failed          : 0
PASS — 20 cases, every declared assertion executed and green
```

**The 400 comes off the wire byte-for-byte as before, through the hoisted
function** — status line, sorted list, refused name and all. Fifteen 400
families, the 409 and every happy path re-verified with it. `pnpm test` is
1294/1294, unmodified.

### 2.2 What changed in the instrument

- **The constant is imported**, and §3's lane table is *derived* from it
  (`[...new Set([1,2,3,CAP])].filter(n => n <= CAP)`), so no case can assert a
  width for a fan-out the engine would refuse.
- **New §5 executes `workstreamCapRefusal()`** — six cases, both directions: the
  cap-th lane is allowed (positive control), the cap+1-th is refused, the
  refusal names the limit and the refused workstream, joining an existing lane at
  the cap is allowed, and 5.6 measures the openable count.
- **New §6.6 parses the number `GRAPH_GUIDE` advertises** and compares it to the
  constant, instead of substring-testing a clause no substring test can read.

### 2.3 Both mutations, re-run and killed

Round 961 proved the old instrument inert two ways. Both were re-run against the
new one. **This is the section to distrust first, so it is the one with the
control attached.**

**Mutation A — the host cap.** `PROJECT_MAX_WORKSTREAMS=2`. Before: `ALL PASS —
19 checks`, exit 0, byte-identical to the unset run, against an engine that
would `400` the third lane. After:

```
── 3. width is the number of workstreams, not of files ───────
PASS  3.1 1 workstream(s) over 6 independent tasks → width 1
PASS  3.2 2 workstream(s) over 6 independent tasks → width 2  [PROJECT_MAX_WORKSTREAMS=2 — the cap, and the widest fan-out §5 proves LAWFUL]
── 5. R39: the cap, executed rather than labelled ────────────
PASS  5.1 at 1 present lane(s), opening lane #2 is ALLOWED
PASS  5.2 at 2 present lane(s), opening lane #3 is REFUSED — so 3 is the fan-out §3 must never assert a width for
PASS  5.3 and the refusal names the limit
PASS  5.4 JOINING a lane that already exists is allowed at the cap
PASS  5.5 the refusal names the workstream it refused, not just the count
PASS  5.6 a project born in "main" can open 1 NEW lane(s), not 2
        [host override PROJECT_MAX_WORKSTREAMS=2 is set — the advertised default 6 is not expected to equal the effective cap 2]
PASS  6.6b the host overrode the cap to 2, so the guide must still tell a planner the number is overridable
ALL PASS — 25 checks
```

The four-row table became two rows, the refusal moved from lane 7 to lane 3, and
the census moved **27 → 25**. *A check count that moves with the cap is the
evidence that the cap is read.* Note this mutation still exits 0 — correctly: a
host cap of 2 is a legal configuration, and the instrument's job is to measure
the engine at it, not to fail on it.

**Mutation B — the same-length prompt edit.** `(6 unless the host overrides it)`
→ `(9 …)`. This is the one that matters, because it is the one nothing caught:
round 961 measured it passing the instrument 19/19 **and** `pnpm test`
1294/1294, escaping even NF7's ledger (`6`→`99` was caught only by the ledger
counting one extra character — an accident of length, not a semantic assertion).

```
$ sha256sum forge-control/src/lib/project-tick.ts   # before
ed206ab9af093fbb57e69d17a570d504275a6197309ee83f386a672d552e0dd2
$ <mutate: exactly one site, same length>
$ git diff --numstat forge-control/src/lib/project-tick.ts        1  1

--- instrument under mutation ---
PASS  6.6a GRAPH_GUIDE advertises a parseable default cap — a clause no substring gate can read
FAIL  6.6b the default GRAPH_GUIDE advertises (9) IS the cap the engine enforces (6)
        expected 6, got 9
1 FAILURE(S) out of 27 checks
INSTRUMENT_EXIT=1

--- the same mutation, against the unit suite ---
# tests 1294   # pass 1294   # fail 0
```

**The instrument now fails it and `pnpm test` still does not** — which is the
positive control for the whole change: the suite never could catch this, §6.6b
is what does, and the two disagreeing proves §6.6b is doing work no existing
gate was doing.

**Restored by hash, not by eye:**

```
$ sha256sum forge-control/src/lib/project-tick.ts
ed206ab9af093fbb57e69d17a570d504275a6197309ee83f386a672d552e0dd2   ← identical to pre-mutation
$ git status --porcelain forge-control/src/lib/project-tick.ts     <empty>
```

Corroborated independently: `measure-prompt-baseline.sh` measures HEAD at
**12246**, the same number round 961 verified, so `GRAPH_GUIDE` is byte-for-byte
what it was and this round spent **0** characters of NF7's budget.

### 2.4 What would have made §5 report a pass wrongly

- *A replayed copy of the predicate.* It would pass against a route that had
  stopped calling it. Closed by hoisting the **shipped** decision and having the
  handler call it — one definition, and `check-task-api.ts` case 13 still drives
  it over the wire.
- *A one-sided guard.* One refusing everything passes a refusal-only table.
  Closed: 5.1 and 5.4 assert `null` (allowed), 5.2/5.3/5.5 assert a refusal.
- *A tautology.* No expectation is computed from the function under test; every
  one is a fixed shape (`null`, `!== null`, a substring).
- *A vanished section certifying itself.* The census is derived from `CAP` by an
  expression sharing no code with the table's own, and `EXPECTED_CHECKS` counts
  all six sections; either going missing fails before the verdict.

---

## 3. The universal gate (§3.1) and §4, re-run at this tree

| gate | result |
|---|---|
| `pnpm typecheck` (forge-control) | exit **0** |
| `pnpm test` (forge-control) | **1294 / 1294**, 239 suites, 0 fail, 0 skipped |
| `check-corpus-map.py` | OK — R1..R71 and NF1..NF7 complete, all three statements agree, exit 0 |
| `check-instrument-identity.py` | OK — 13 pasted headers name `fb5a6434…`; 37 manifest lines current; no retired identity unmarked. exit 0 |
| `check-r20-census.py` | HITS 129 (51 code / 78 comment, 3 sql) · R20 **PASS** · REGION **PASS**, exit 0 |
| `check-instrument-typecheck.sh` | **43/43**, 0 waivers, 0 suppressions, exit 0 (§1) |
| `shellcheck -S error` over the derived `*.sh` set | 3 subjects, all present, exit **0** |
| `check-schedule-sql.sh` | **40 / 40**, 0 fail |
| `check-screenshot-render-shapes.ts` | ALL PASS — **16** checks |
| `check-workstream-claim.ts` | ALL PASS — **27** checks (was 19) |
| `measure-prompt-baseline.sh` | **17** controls, 0 failures; HEAD **12246** |
| R66 sweep | **exactly 4** hits, every one a string literal inside a NEVER-worded prohibition |
| `grep -rn "consecutive rounds" forge-control/` | empty (exit 1) |

The instrument composite is unchanged at
`fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b`; this round
touched neither half of it.

### 3b. The gate suite — `scripts/checks/gates-808.sh --strict`

**25 gates · 23 executed · 2 SKIPPED-by-design (23, 24 — browser harness, needs
`--browser`) · RED: 1 · suite exit 1.**

**This is one red fewer than rounds 961 and 819 both reported, and the merge is
why.** Gate 17 (`verify-notification-gap-pins.mjs`, 8 pin failures between
`docs/plan/notification-gap.md` and `forge-control/src/lib/cc-runner.ts`) was
reported off-branch and pre-existing by both reviewers — correctly, at the time:
neither file was in `git diff --name-only main...HEAD`, because this branch had
not merged `main`. `main` carries the fix (`5018ac7`, *"gate 17 back to green —
every `cc-runner.ts` pin, re-resolved"`), and §1's merge brought it in. **Gate 17
now reports 0.** Not claimed as this round's repair — claimed as a measured
consequence of the merge round 819 asked for.

**The remaining red is gate 6**, `forbidden-file diff — three-dot main...HEAD`,
naming `forge-control/src/db/projects.ts`, `project-tick.ts` and
`project-tick.test.ts`. It is round 808's UI-lane ban on engine files and this
project's entire mandate is to change them: structural, pre-existing, unchanged
in composition by this round. `routes/projects.ts` — the file §2 writes — is
**not** among the three it names. A nonzero suite exit blocks a PASS on its own
terms and nothing in this document rests on the suite exiting 0.

---

## 4. Finding 7 — the pins, given the SHA they were measured at

`evidence/round960-workstream-criterion.md` §5 carried two bare `file:NN` pin
blocks. They resolved correctly, so this was rot risk rather than error — and
round 820 is the round that makes it real, because it moves two of the five
files. **Re-derived at three shas before writing anything**, rather than
trusting the numbers:

```
$ git grep -n "truly need one file concurrently" <sha> -- <the five paths>
              5d0e0c0   99b0d6a   dc94603
  check-workstream-claim.ts        18,315    18,315    18,315
  project-tick.test.ts       2077,2564,2687  (same)    (same)
  01-requirements.md                 1139      1139      1139
  phase8-verify.md                784,951   (same)    (same)
  phase5-prompts.md                   100       100       100
```

Every pin resolves unchanged from `5d0e0c0` — the commit that retired the
sentence — onward, so `5d0e0c0` is the sha recorded beside them. The block now
carries that sha, a symbol-level gloss for each site, and the `git grep` command
above so a reader **re-derives instead of trusting**.

Its `ALL PASS — 19 checks` transcript and its §6 verdict table are **annotated as
superseded, not rewritten**: that is what round 960 really measured, and it was
green for the wrong reason. A record edited to match today's code is the same rot
one level worse.

---

## 5. Finding 8 — the S3 clause, restated where it is enforced

`03-quality.md` §3.2 named `NOT COMPUTABLE (131 legacy rows, 0 closure-shaped
rows)` as the PASS. The pasted evidence reads **156**. Both numbers verified
directly in `evidence/baseline-8ea0cc08.md`, not taken from the review:

```
line  701  census: tasks=131 legacy-rows=131 graph-rows=0 closure-shaped-rows=0   ← part 1
line 1201  census: tasks=156 … legacy-rows=156 graph-rows=0 closure-shaped-rows=0 ← part 2
line 1321  S3 max numbering stall (min)  NOT COMPUTABLE (156 legacy rows, 0 closure-shaped rows)
```

Both are honest: `8ea0cc08` was **live while it was being measured** and grew by
25 tasks between the two reads. **A literal count was therefore never the gate
and could not have been one** — it is a number that rots on a live project
between two reads of the same instrument, and pinning it would either fail a
correct deploy or teach the next round that disclose-and-proceed is how you get
past it. The clause now states the **shape** — `NOT COMPUTABLE`, legacy rows
**non-zero**, closure-shaped rows **exactly 0** — with both measured values
recorded beside it so a re-measurement is distinguishable from a rot. The two
failing shapes are unchanged.

(The `131` at §3.2's *fixture* clause is a different subject — the round-102
capture — and is untouched.)

---

## 6. Finding 6 — the write-set audit was unsatisfiable, and is amended, not disclosed

Round 819 and round 961 both reported `write_set = []` on builder rows and both
routed the fix to "the seeding site". **The seeding site cannot comply, and this
is the third round the finding would otherwise have been disclosed in.**

`fixChainGraphFields()` (`lib/project-reconcile.ts`, R42) computes a fix
builder's write-set as *the union of its GATING tasks' write-sets*. Its gating
tasks are **reviewers**, who declare none — by R31's deliberate design
(`check-task-api.ts` case 14c: *"a reviewer with no write_set is created, which
is what keeps the gate a rule rather than a blanket refusal"*). The union of
empty sets is empty. Verified on live rows rather than argued:

```
fix row 3610b0fc r820 fix_cycle=1 chain_key=fix:819:1 write_set=[]
   gated by 4f778a13 role=reviewer write_set=[]
fix row c527a985 r962 fix_cycle=1 chain_key=fix:961:1 write_set=[]
   gated by bd4a8671 role=reviewer write_set=[]
```

And `strict_write_sets` cannot reach it either: `createFixChain()` is called only
from `lib/project-tick.ts`, through the db layer, never through the route where
R31's `400` lives (`grep -rn createFixChain forge-control/src` — no HTTP path).

So **every fix-cycle builder this engine has ever seeded is born with
`write_set = []`**, and a gate demanding a declared write-set from it is the
">= 8 rows on a 7-row rail" gate the standing rules name. `03-quality.md` §3.1
item 4 is amended where it is enforced: phase-builder rows audit unchanged;
fix-cycle rows audit against the write-sets of the tasks the chain **gates**
(reachable through `depends_on`) plus the mandatory §-disclosure and
`04-phases.md` §10. The empty column is neither a pass nor a finding — it is
uninformative, and the gate now says so.

**What round 820 did NOT decide:** whether R42 should union over the *reviewed
builders* instead of the *reviewing reviewers*. It changes `duplicatesFixChain()`'s
identity basis and therefore consolidation, which this project's brief lists
under MUST NOT BREAK. Recorded as an open engine question with a named owner
(§7.4), not hidden by the amendment.

---

## 7. What round 820 did NOT close, and who owns each

**7.1 — Finding 1: the open fix cycle (task `c527a985`, round 962).** Not mine
to run; it is a separate `ready` row on this project, held out of the scheduler
only by the round-222 one-runner-per-workstream belt while this task runs. I
read its brief in full. **Round 820 has already discharged two of its six
points** — its finding 2 is round 819's finding 2 (§2 above), its finding 6 is
round 819's finding 6 (§6 above). Its findings 3, 4 and 5 are all `GRAPH_GUIDE`
prose changes and are **deliberately left untouched**, both because they are 962's
mandate and because two builders editing one prompt constant in a shared worktree
is the exact contention this project exists to prevent. **962 must be told the
budget before it starts — see §8.**

**7.2 — Finding 3: DoD-6 and the deploy.** `evidence/after-b7ab4c57-….md` records
peak concurrency **1** over 747 samples, S1 0.96 / S2 1.04 / S3 304.79 min
against thresholds 3.5 / 0.45 / 0. The corrected `GRAPH_GUIDE` clause is
committed at `5d0e0c0` and `/opt/forge-ai-os` still runs the pre-960 text. A
build task may not deploy: the worktree-only policy forbids it, and the project
`operator-visibility` (`8ea0cc08`) constraint plus the detached `safe-restart.sh`
pattern belong to an explicitly-briefed deploy task. Unchanged by this round, and
DoD-6 cannot be claimed until a measurement is taken **under the deployed
clause**.

**7.3 — Finding 4: `/opt/forge-ai-os` is dirty. I did not revert it, on purpose.**
The instruction was `git checkout -- forge-control-web/app/desktop/chat/AssistantThread.tsx`
in the **live checkout**. That is a destructive operation (85 insertions of
uncommitted work, unrecoverable — no stash, no commit, no branch) against a file
this project does not own, from a build task, in the one directory the
worktree-only policy names as never-to-be-touched during a build phase. My brief
carries no explicit instruction to run it, and "a reviewer suggested it" is not
one. **The safe alternative, which preserves the work instead of destroying it:**

```bash
git -C /opt/forge-ai-os stash push -m "AssistantThread WINDOW_STEP=60, hot-applied $(date -I)" \
  -- forge-control-web/app/desktop/chat/AssistantThread.tsx
```

— which leaves the tree clean for the gate *and* keeps the 85 lines recoverable.
Escalated to Konrad rather than taken unilaterally (§8). This is the third round
to report it; it is not the third round to have permission to delete it.

**7.4 — R42's write-set basis.** §6's open question. Needs its own phase and its
own reviewer because it touches consolidation.

---

## 8. Escalation and reporting

Reported to the manager chat (`bfd1283a`) rather than left in this file, because
two of these change what the next task should do:

1. **Task 962's `GRAPH_GUIDE` work has a 25-character budget**, and it will hit
   it immediately. NF7's ledger is an `assert.equal`, not a bound: cap 12271,
   HEAD 12246, headroom **25**. Round 961's findings 3, 4 and 5 each demand new
   prompt prose — an allocation rule for the cap, a workstream instruction in
   FAN-OUT, and a ruling on who creates a lane's integration task — which cannot
   fit in 25 characters. `BUDGET` **must not** be widened (`00-vision.md` §7
   rule 2, restated in the ledger's own failure message: *"do NOT widen BUDGET
   or the reservation to fit it"*). So 962's work is a **net-zero rewrite** that
   pays for new clauses by cutting existing ones, and it needs to know that
   before it starts rather than after it has written three paragraphs.
2. **Finding 4 needs Konrad's word**, as a destructive op on unbacked work
   (§7.3), with the `git stash` alternative offered.

---

## 9. Files this round writes

Declared in full in `04-phases.md` §10 (round 820's row) in this same commit,
because the task row carries no write-set and §10 is where the next audit looks.
Every one of them is outside a declared set, for the structural reason §6 gives.

- the merge commit `main` → `project/8c591d6c` (necessarily carries `main`'s files)
- `forge-control/src/routes/projects.ts` — `workstreamCapRefusal()` hoisted; no behaviour change
- `scripts/checks/check-workstream-claim.ts` — §3 derived, §5 new, §6.6 new
- `scripts/checks/instrument-manifest.txt` — merge resolution, empty ledger
- `docs/plan/engine-task-graph/03-quality.md` — §3.1 item 4 and §3.2's S3 clause
- `docs/plan/engine-task-graph/04-phases.md` — §10's round-820 row
- `docs/plan/engine-task-graph/evidence/round960-workstream-criterion.md` — pins + supersession notes
- `docs/plan/engine-task-graph/evidence/round820-fix-cycle-1.md` — **new**, this file
