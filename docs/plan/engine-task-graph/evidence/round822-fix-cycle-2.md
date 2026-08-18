# Round 822 — fix cycle 2 on round 821's re-review

**Built on `5fde1383f0603bd047c6df0896bffb5c76166eee`** (`git rev-parse HEAD`,
read at the start of this round; the worktree is
`/opt/ai-os/workspace/projects/8c591d6c-…`, branch `project/8c591d6c`, which
shares `/opt/forge-ai-os/.git` — it is a git worktree of the live repo, not a
separate clone).

Round 821's verdict was `NEEDS_FIXES` on **three** findings, and it said so
plainly: "what blocks the PASS is not the fix cycle's work — it is that three
findings remain open, two of them by design." All three are things a build task
cannot simply execute:

| # | round 821's finding | what round 822 owns |
|---|---|---|
| 1 | the fix chain `c527a985` (962) / `9bea2102` (963) is open, and 962 must be told its `GRAPH_GUIDE` budget first — "headroom **25 characters**" | **the budget.** Measured, found unsatisfiable by 22×, and amended where it is enforced |
| 2 | `/opt/forge-ai-os` dirty — ` M …/AssistantThread.tsx`, fourth consecutive round, needs Konrad's word | **re-measured. It is CLOSED** — the work was committed, by someone else, at `1e0330b` |
| 3 | DoD-6 failed; the corrected clause is committed but undeployed | **the premise, verified read-only**, and the procedure written down for the deploy task |

Nothing in this round changes engine behaviour. `GRAPH_GUIDE` is not edited,
`project-tick.ts`'s executable text is not edited, no test is modified, and the
maximal planner prompt measures **12246 before and after** — the same number
round 821 reviewed.

---

## 1. Finding 1 — the budget round 962 was to be handed, MEASURED

### 1.1 What round 962 has to write

Round 961's verdict left six findings. Round 820 discharged two of them
(finding 1, the dirty checkout — see §2 below; and finding 2, the inert cap
assertion). Its finding 6 is a seeding defect, not text. The **three that are
prose in `GRAPH_GUIDE`** are 961/3, 961/4 and 961/5, and each is a NEW RULE, not
a word swap:

- **961/3** — the cap counts the `"main"` every project is born in
  (`db/projects.ts`'s architect insert names no `workstream`, so the schema
  default applies, and `presentWorkstreams` counts every row regardless of
  status), so the openable count is `cap - 1`; and the identical unqualified
  ceiling reaches the goal-mode architect *and* every planner it seeds, each
  reading it as if it owned the whole budget.
- **961/4** — a task does **not** inherit its creator's workstream. It comes
  only from the POST body and `createTask()` writes `input.workstream ?? "main"`.
  So `FAN-OUT` — the paragraph a planner actually uses — teaches a fan-out that
  lands in one lane and runs one at a time, while calling research fan-out "the
  cheapest parallelism there is".
- **961/5** — `depends_on` is immutable at insert (N7), so a lane opened **for**
  a planner can never be integrated by whoever opened it: the planner's future
  children cannot be named at insert (`400 … dependency id(s) that do not
  exist`) and cannot be added later.

### 1.2 The instrument, before the number

Every round since 239 that touched `GRAPH_GUIDE` re-derived NF7's arithmetic by
hand — in a commit message, a doc-comment, or a reviewer's prose. Round 821 did
it again in order to hand 962 a budget. `measure-prompt-baseline.sh` measures
**committed refs**; nothing measured a **candidate**. So the question a round
actually asks — *does the text my brief requires fit?* — could only be answered
after writing the text, running `pnpm test`, and reading the ledger's failure
message backwards.

**New: `scripts/checks/measure-graph-guide-budget.ts`.** Given a file holding a
candidate `GRAPH_GUIDE`, it prints the net delta, the LEDGER row that candidate
would have to declare, and whether the result clears the cap — exit 1 if not.

*Where its numbers come from — not from itself.* `BASELINE`, `BUDGET`,
`FIVE_A_TIP` and every ledger `spent` are **parsed out of
`forge-control/src/lib/project-tick.test.ts`**, which is where NF7 is enforced.
A cap copied into an instrument is a pin that rots the first time the gate moves
(00-vision.md §7 rule 1), so this file reads the gate rather than remembering
it.

*What would have made it report a pass wrongly*, and how each is closed — the
header states all five; these three were **executed**, not asserted:

**(c) substitution arithmetic on a constant that appears twice.** The delta
`candidate.length - GRAPH_GUIDE.length` is the *prompt's* delta only at exactly
one occurrence. Rounds 900 and 960 both leaned on that silently. §1 counts the
occurrences and refuses at anything but 1; §4 then performs the substitution for
real and asserts it equals the arithmetic. It does, at every measurement below
(`projected 12810 (substitution: 12810)`).

**(b) a parse that silently found nothing.** Caught in this instrument's own
first run, and it is worth recording because it is the failure class the
standing rules put first. The obvious one-pass regex — `round: (\d+)` … lazily …
`spent: (\d+)` — reads the whole file, and `project-tick.test.ts` is full of
task fixtures carrying `round: 1`. It reported:

```
  ledger row 1                  +476        <- WRONG. That row is round 240.
  ...
  ledgered total                 627        <- right
```

The **sum was correct and one label was a fiction**: an instrument reporting a
plausible wrong number, which is worse than one that fails. Fixed by cutting the
`const LEDGER = [ … ] as const;` block out by its own delimiters, asserting it is
found exactly once, and parsing only inside it.

**Negative controls, all three run, and the test file restored by sha256 after
each mutation** (`1f05e9390f9f2c7c…`, verified equal both times; the worktree
was left carrying only this round's own files):

| mutation | expected | observed |
|---|---|---|
| `const LEDGER` renamed | the block is unfindable, and nothing is inferred from the whole file | 3 FAILs — "found 0 … blocks", "parsed 0 round label(s)", and the re-executed `assert.equal` at `11619 + 0 = 11619` vs 12246 |
| one `spent: 106` → `107` | the re-executed ledger equality fires | `FAIL … says 11619 + 628 = 12247, and the live maximal prompt measures 12246 — -1 characters are unaccounted for` |
| candidate at `+25` / `+26` | the cap boundary is exact | `+25` → headroom 0, FITS, exit 0; `+26` → headroom −1, FAIL, **exit 1**, and it names `BUDGET 3050 -> 3051` as the minimum |

An identity candidate (byte-equal to the live constant) measures `+0` and
reports the live headroom unchanged — the positive control that the substitution
path is not silently altering the text.

### 1.3 The number

The reference wording is built by **transforming the live constant**, edit by
edit, with each edit asserted to apply exactly once — so all **23 gate-frozen
needles** (R38's eight, R48's ten, R47's, round 900's write_set sentence) survive
**by construction**, and the retired same-file criterion is asserted absent. It
is kept as `evidence/round822-graph-guide-sizing.txt`, which is a **sizing input
and explicitly not the deliverable**: round 962 owns that text and may beat it.

```
  live GRAPH_GUIDE                     1951 chars
  reference wording                    2515 chars
  net delta vs the live guide          +564
  projected maximal prompt            12810   (substitution control: 12810)
  cap before this commit              12271
  projected headroom                   -539
```

**Round 962's gate could not be passed, by a factor of twenty-two: +564 needed
against 25 available.**

That the reference wording is not provably *minimal* is exactly why the
reservation below carries margin. It is, however, a floor with the compression
already applied: it retires "the cheapest parallelism there is" (33 characters)
because finding 4 shows that clause is false while every researcher lands in
`"main"`.

### 1.4 The amendment, and it is a WIDENING

Standing rule 2 says amend an unsatisfiable gate **where it is enforced**, in
the same commit, with the reasoning inline — rather than let a fourth
consecutive round disclose-and-proceed. The three ways out, weighed in the NF7
block itself:

- **Shrink.** Nothing left pays. Round 960 spent the one retirable clause; this
  round's wording retires a second; everything else is held by an R38/R47/R48
  needle.
- **Write text that fits.** The option NF7's own round-239 amendment already
  refused, in these words: *"the only text that fits is text that satisfies
  `.includes()` and misleads a planner, which 03-quality.md §3.2 calls a passing
  gate on a broken deliverable."* Findings 3 and 4 exist **because** the guide
  states a rule too tersely to be followed.
- **Amend.** Taken.

```
  BUDGET                            3050 -> 3700   (+650)
  cap = BASELINE + BUDGET          12271 -> 12921
  measured at this commit                  12246   (unmoved)
  headroom                            25 ->   675
    RESERVED for round 962                  650    = 564 measured + 86 margin
    unreserved slack, as before               25
```

**Stated plainly, because round 242 wrote this sentence backwards and round 244
had to fix it: this is a WIDENING.** Not a re-derivation, not a frame change,
not a tightening wearing a rising cap. 650 characters that could not have been
spent before this commit can be spent after it. It is licensed exactly the way
round 239's `1500 → 3050` was: the requirement is unmeetable as written, the
arithmetic is inline, the requirement text moves in the **same commit**
(standing rule 4), and the divergence is **reported to the manager chat for a
ruling** rather than taken silently.

Amended at both enforcement sites, in this one commit:

- `forge-control/src/lib/project-tick.test.ts` — `const BUDGET = 3700`, under a
  block carrying this arithmetic, the three findings it buys, and the
  reservation.
- `docs/plan/engine-task-graph/01-requirements.md` §J NF7 — the requirement text
  `3050 → 3700`, with the same measurement. The two must never disagree again;
  they did at round 239 and "the measured number wins" is the ruling that
  settled it.

**No LEDGER row is added by round 822.** The ledger is an `assert.equal` against
a *live* measurement, so a row for text that has not been written yet would fail
immediately with its own reservation as the discrepancy. Round 962 adds
`{ round: 962, spent: <its measured net>, reserved: 650 }` in the commit that
spends it — the same separation round 239 used when it reserved 652 for builder
5B and 5B added the row at round 240. If 962 comes in **under** 650 the surplus
stays headroom and BUDGET is not trimmed; if it needs **more**, that is a second
amendment with its own arithmetic, not a quiet spend of the 25.

### 1.5 The handoff to round 962, in one block

Round 962 (`c527a985`, `ready`) is not this task's to run. What it needs to know:

1. **Its budget is 650 characters net**, not 25. Size the edit before writing the
   commit:
   ```
   cd forge-control && ./node_modules/.bin/tsx \
     ../scripts/checks/measure-graph-guide-budget.ts \
     --candidate ../docs/plan/engine-task-graph/evidence/round822-graph-guide-sizing.txt
   ```
   That file is a **reference wording, not the deliverable** — it measures +564
   and leaves 111 under the cap. Beat it if you can; do not copy it without
   reading it.
2. **Add the LEDGER row** in the same commit as the text:
   `{ round: 962, spent: <measured>, reserved: 650 }`. The instrument prints the
   row for you.
3. Two of round 961's six findings are **already discharged** and must not be
   re-done: finding 1 (the dirty checkout — closed, see §2) and finding 2 (the
   inert cap assertion — closed at round 820, both mutations killed).
4. Round 961's finding 6 (`write_set = []` on the task row) is the **seeding
   site**, not the builder: `fixChainGraphFields()` unions the *gating* tasks'
   write-sets, and gating tasks are reviewers, who declare none by R31's design.
   `03-quality.md` §3.1 item 4 already carries the amended audit for fix-cycle
   rows. Disclose in `04-phases.md` §10; do not attempt to satisfy the original
   wording.
5. Round 961's operator note — the natural experiment (`b7ab4c57` 1 workstream /
   35 tasks / concurrency **1** vs `7851068b` 6 workstreams / 45 tasks /
   concurrency **5**, same engine code) — is the strongest evidence in this
   project and costs nothing to cite. Do **not** rewrite round 815's measurement
   to match it.

---

## 2. Finding 2 — `/opt/forge-ai-os` is CLEAN, and the work was not lost

Four consecutive rounds reported ` M forge-control-web/app/desktop/chat/AssistantThread.tsx`
(85 insertions / 1 deletion, `WINDOW_STEP = 60`) and three of them proposed a
fix. Round 820 refused to `git checkout --` it, offered `git stash push`
instead, and escalated. **Re-measured at this round, read-only:**

```
$ git -C /opt/forge-ai-os status --porcelain
                                                  <- empty
$ git -C /opt/forge-ai-os log --oneline -1
1e0330b fix(chat): window the rendered thread — only the newest 60 messages mount
$ git -C /opt/forge-ai-os show --stat 1e0330b
  author forge-operator, Tue Aug 18 22:36:13 2026 +0200
  .../app/desktop/chat/AssistantThread.tsx | 86 ++++++++++++++++-
  1 file changed, 85 insertions(+), 1 deletion(-)
$ git -C /opt/forge-ai-os show 1e0330b -- …/AssistantThread.tsx | grep WINDOW_STEP
  +const WINDOW_STEP = 60;
```

Same file, same 85/1, same constant. **The hot-applied work was committed to
`main`, not discarded**, and the gate `git -C /opt/forge-ai-os status
--porcelain` — "empty output is the only pass" — now passes. Round 820's refusal
to destroy it is retrospectively the correct call: a `git checkout --` at any
point in those four rounds would have deleted work that has since landed.

**Two consequences the next task must know.** First, `main` has moved: it is now
`1e0330b`, **one commit past this branch's merge-base `22967d6`**. Nothing on
this branch touches `AssistantThread.tsx`, so it conflicts with nothing, and no
gate here needs it — item 9 is 44/44 without it. This round does **not** merge
it; the deploy task will. Second, the tree is a live checkout that changed under
four rounds of observation, so **this measurement carries its timestamp and must
be re-taken, not quoted** — that is what §3.1's gate asks for on every run.

---

## 3. Finding 3 — DoD-6's premise, verified read-only

Round 821: "the corrected `GRAPH_GUIDE` clause landed at `5d0e0c0`;
`/opt/forge-ai-os` still runs the pre-960 text." **Measured here, read-only, no
service touched:**

> **CORRECTED AT ROUND 824 — round 823's finding 2. The second grep in the
> block below was INERT: it returns `0` against the WORKTREE too, where the
> clause demonstrably is present.** The original text is kept because it is what
> round 822 really ran, and the correction is stated rather than substituted.
> Superseded by §3.1 immediately after it; read that block, not this one.

```
$ grep -c "truly need one file concurrently" \
    /opt/forge-ai-os/forge-control/src/lib/project-tick.ts
1                                              <- the RETIRED criterion, live
$ grep -c "so open ONE PER LANE you want running at once" \   <- INERT, see §3.1
    /opt/forge-ai-os/forge-control/src/lib/project-tick.ts
0                                              <- the corrected clause, absent
```

### 3.1 The correction — which half discriminates, and which half never could

Measured at round 824, read-only, no service touched, both trees:

```
                                                          worktree   live
grep -c "truly need one file concurrently"                       0      1
grep -c "ONE PER LANE"                                           1      0
grep -c "so open ONE PER LANE you want running at once"          0      0   <- INERT
```

**Why the third line is inert, and why it looked authoritative.** `GRAPH_GUIDE`
is built from concatenated template literals, and the phrase straddles a join:
the source spells it `… so open ONE PER LANE ` + `you want running at once, …`,
so the sentence never appears contiguously in any source file and no `grep` for
it can return anything but `0`. The *evaluated* constant does contain it —
`GRAPH_GUIDE.includes("so open ONE PER LANE you want running at once")` is
`true` in the worktree at exactly one occurrence, which is the check the source
grep was standing in for and could not perform.

**Which half did the work.** The FIRST grep — the retired criterion, `1` live
and `0` in the worktree — is a valid discriminator and carries §3's conclusion
by itself. The second added nothing and could not have: a control that returns
the same value on both sides of the comparison it is asked to make is not
evidence, it is decoration that reads as evidence.

**The replacement, for anyone re-running this.** `grep -c "ONE PER LANE"` is
contiguous in the source, and separates the trees `1` to `0`. Where the
evaluated constant is what matters, ask the constant rather than its source:
`cd forge-control && ./node_modules/.bin/tsx -e 'import { GRAPH_GUIDE } from
"./src/lib/project-tick.ts"; console.log(GRAPH_GUIDE.includes("<clause>"))'`.

**The failure this closes** is not in §3's conclusion, which was and is correct.
It is in the deploy: that task was to re-run these greps after `safe-restart.sh`
to confirm the new prompt shipped. Run as written it would have read `0`,
concluded the deploy had failed, and been wrong about a deploy that worked.

**Premise confirmed.** Every project the fleet has planned since round 960
committed was planned under the criterion round 960 retired. DoD-6 cannot be
claimed on a measurement taken against the prompt it replaced, and re-running
`measure-schedule.ts full` today would re-measure the old clause.

This round does not deploy and must not: the project brief forbids it while
`8ea0cc08` runs, and the worktree-only policy forbids a build task touching the
live checkout at all. Recorded for the explicitly-briefed deploy task, in order:

1. Confirm `8ea0cc08` has **no running or pending tasks** (and note that this
   project's own 962/963 chain must be closed first — a deploy mid-chain ships
   half of round 961's fixes).
2. Merge `main` (now at `1e0330b`) into `project/8c591d6c`, then `project/8c591d6c`
   into `main`. The extra commit is web-only and conflicts with nothing here.
3. Launch the detached pattern and **end the task**:
   `setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &`
4. **Only then** plan one project under the deployed clause and re-run
   `measure-schedule.ts full` for the twelve-round measurement shape DoD-6 asks
   for. Round 961's natural experiment (§1.5 point 5) is a second, independent
   observation and does not substitute for it.

---

## 4. Gates re-run at this tree

Every command from `03-quality.md` §4, executed by this round, at the tree this
commit produces. Node v22.22.2, tsc 5.9.3.

| gate | result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **1294/1294**, 239 suites, 0 fail — the same count as round 821, and no test file is modified |
| `check-instrument-typecheck.sh` (item 9) | **44 found / 44 compiled / 0 failures / 0 waivers / 0 suppressions / 0 fidelity violations**, exit 0, 176s — 43 → 44 is this round's new instrument, picked up by the glob with nothing to declare |
| `check-workstream-claim.ts` | ALL PASS — **27 checks**, exit 0 |
| `check-schedule-sql.sh` | **40/40**, exit 0 |
| `check-screenshot-render-shapes.ts` | ALL PASS — 16 checks |
| `measure-prompt-baseline.sh` | **17 controls, 0 failures** — and it reproduces every ledger row, which is the independent confirmation that widening `BUDGET` left the ledger itself untouched |
| `check-corpus-map.py` | R1..R71 + NF1..NF7, all three statements agree, exit 0 |
| `check-instrument-identity.py` | 13 headers / 37 manifest lines, exit 0 |
| `check-r20-census.py` | R20 PASS, REGION PASS, exit 0 |
| `shellcheck -S error` (derived `*.sh`) | exit 0 |
| R66 sweep | **exactly 4 hits**, unchanged — all string literals inside NEVER-worded prohibitions |
| `grep -rn "consecutive rounds" forge-control/` | empty |
| `git -C /opt/forge-ai-os status --porcelain` | **empty** — see §2 |
| `measure-graph-guide-budget.ts` (new) | exit 0 at HEAD; exit 1 on the candidate before the amendment, exit 0 after |

`gates-808.sh --strict` — see the run recorded alongside this file. Gate 6
(`forbidden-file diff, main...HEAD`) names `db/projects.ts`, `project-tick.ts`
and `project-tick.test.ts`: round 808's UI-lane ban on the exact files this
project's mandate is to change. Structural and pre-existing; this round adds
**comment-only** changes to two of them and no new file to that set.

### 4.1 The control that this round changed no prompt

`project-tick.ts` is edited — a doc-comment on `GRAPH_GUIDE` annotating a cap
that is no longer live (standing rule 1: a pin left alone stops reading as stale
and starts reading as authoritative and wrong) and pointing at the sizing
command. **The maximal planner prompt measures 12246 before the edit and 12246
after it**, which is the positive control for this project's standing claim that
reasoning lives in doc-comments because they cost the prompt nothing — a claim
round 244 measured once and this round measures again.

---

## 5. What round 822 does NOT close

1. **The fix chain is still open.** `c527a985` (962) is `ready`, `9bea2102`
   (963) is `pending`, project `active`. Running another task's row is not this
   builder's to do — round 820 refused the same thing and round 821 endorsed the
   refusal. What this round could give it, it gave: a passable gate and §1.5's
   handoff.
2. **DoD-6.** §3. A build task may not deploy.
3. **The NF7 widening wants an operator ruling.** Taken by default and reported;
   see §6. If Konrad rules the other way, the remedy is to shrink round 962's
   text — which §1.3 measures as producing a prompt that satisfies `.includes()`
   and misleads a planner.

---

## 6. Escalation and reporting

Reported to manager chat `bfd1283a-b71b-4f35-b577-7d09aad803f2` (`from`:
`worker`, `sender_run_id` this run's own id): the NF7 widening with its
arithmetic and the default taken, that finding 2 is closed by `1e0330b` and needs
no decision from Konrad after four rounds of asking, and that the fix chain
plus DoD-6 remain open and are owned by other rows.

---

## 7. Files this round writes

| file | why round 822 writes it |
|---|---|
| `scripts/checks/measure-graph-guide-budget.ts` | **New.** Sizes a candidate `GRAPH_GUIDE` against NF7 *before* it is written, parsing the gate rather than copying it, and re-executing the ledger's own equality first. It is what makes §1.3's number a measurement instead of an estimate, and it is the tool round 962 runs. |
| `forge-control/src/lib/project-tick.test.ts` | The amendment, **where it is enforced**: `BUDGET 3050 → 3700` under a block carrying the arithmetic, the three findings it buys, the reservation, and the reason no LEDGER row is added here. No test body is modified; 1294/1294 is unchanged. |
| `docs/plan/engine-task-graph/01-requirements.md` | NF7's requirement text `3050 → 3700`, in the **same commit** as the assertion (standing rule 4). The two disagreed once before, at round 239, and "the measured number wins" is the ruling that settled it. |
| `forge-control/src/lib/project-tick.ts` | **Comment only.** `GRAPH_GUIDE`'s doc-comment annotates the superseded cap rather than rewriting round 960's measurement, records that 650 of the new headroom is reserved, and names the sizing command. The prompt is byte-identical: 12246 → 12246. |
| `docs/plan/engine-task-graph/evidence/round822-graph-guide-sizing.txt` | **New.** The reference wording §1.3 measures — a sizing input, explicitly not the deliverable. Generated by transforming the live constant, so all 23 gate-frozen needles survive by construction. |
| `docs/plan/engine-task-graph/evidence/round822-fix-cycle-2.md` | **New.** This file. |
| `docs/plan/engine-task-graph/03-quality.md` | §4's reviewer block gains the new instrument — as a no-argument **gate**, not only as a tool. An instrument nobody is obliged to run rots, and this one asserts the single-occurrence property (control (c)) that no other check in the repo asserts. Added in the same commit as the instrument itself. |
| `docs/plan/engine-task-graph/04-phases.md` | §10's round-822 ownership table. No other section is touched. |
