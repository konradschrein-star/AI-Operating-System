# Round 824 — fix cycle 3, on round 823's re-review

Task `642fbcb9-ae9d-4986-a60a-fcd8a4ab4f56`, `write_set = []` (structural — see
`04-phases.md` §10's round-824 row and `03-quality.md` §3.1 item 4). Worked at
tip `efb9e17d567286e2bcdb5b1c014ace5928c21d4c`, branch `project/8c591d6c`,
worktree `/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`.

`git -C /opt/forge-ai-os status --porcelain` → **empty**, checked at the start of
this round and again before the commit. Nothing here writes to the live
checkout; the two `grep -c` reads in §2 are reads of a file, not of a service.

Round 823 left **three blockers and two non-blocking notes**. All five are
closed below. Each section states what would have made its measurement report a
pass wrongly, because on this project that is where the defects have been.

---

## 1. Finding 1 — gate 6 was unsatisfiable, and it now has a control

### 1.1 The premise, re-measured rather than inherited

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
forge-control/src/db/projects.ts
forge-control/src/lib/project-tick.test.ts
forge-control/src/lib/project-tick.ts
```

Three hits, all three the project's own mandate. Under the old one-line gate
that is `exit 1` at every sha this branch can ever hold, and under the reviewer
rule *a nonzero exit blocks the PASS* no PASS was reachable — including the
deploy task's. Rounds 819, 820, 821 and 822 each labelled it "structural,
pre-existing" and proceeded.

`workspace.ts` and `executor.ts` are named in the project brief but match **no**
ban pattern, so they were never the problem. That matters for the allow list:
listing them would be an entry that permits nothing, and the gate now says so by
name rather than letting it read as protection.

### 1.2 The shape is the operator's, not this round's

Put to the manager chat by round 823's reviewer; ruled the same evening and
recorded in the vault at `AI OS/Operator Decisions.md` § *"A gate that forbids
touching a file cannot govern a project whose mandate is that file"*:

> **Bind such a ban to the DECLARED WRITE-SET, never to a project name.** An
> allow list supplied by the caller (`GATES_ENGINE_ALLOW=...`), defaulting to
> empty so every other project is unaffected: *an engine file may differ only if
> it was declared.* A name-based waiver rots the moment the project ends and
> nothing removes it; a write-set-bound gate is self-retiring, and the reviewer's
> job becomes checking the allow list matches the declared write-sets — a real
> check rather than a rubber stamp.

The ruling also records a larger finding — that `gates-808.sh` is *another
project's* gate suite promoted to universal without being generalised, its base
sha `7b961b5` and its waiver both belonging to round 808 of `operator-visibility`
— and explicitly says **record it, do not fix it here**. This round does not.

### 1.3 What was built

- `scripts/checks/forbidden-file-diff.sh` — **new**, the decision, reading paths
  on stdin. The ban pattern is unchanged, character for character. No project is
  named anywhere in it.
- `scripts/checks/gates-808.sh` — gate 6 becomes
  `git diff --name-only main...HEAD | bash scripts/checks/forbidden-file-diff.sh`.
  The waiver comment's closing clause **"…as do all engine files"** is retired by
  name in the same commit (standing rule 4), with the ruling quoted inline.
- `scripts/checks/check-forbidden-file-diff.sh` — **new**, the control.

### 1.4 The gate, both directions, on the live branch

```
$ git diff --name-only main...HEAD | bash scripts/checks/forbidden-file-diff.sh
paths read on stdin: 32
ban pattern:         project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files

ALLOW LIST — GATES_ENGINE_ALLOW, supplied by the caller, default empty (0 entries)
  (none — every path matching the ban is forbidden, which is this gate's
   behaviour for every branch that does not set the variable)

PATHS MATCHING THE BAN (3)
  FORBIDDEN  forge-control/src/db/projects.ts
  FORBIDDEN  forge-control/src/lib/project-tick.test.ts
  FORBIDDEN  forge-control/src/lib/project-tick.ts

>>> FORBIDDEN FILE DIFFERS — 3 path(s) match the ban and are not in
>>> GATES_ENGINE_ALLOW. …
EXIT=1

$ GATES_ENGINE_ALLOW='forge-control/src/db/projects.ts,forge-control/src/lib/project-tick.ts,forge-control/src/lib/project-tick.test.ts' \
    bash -c 'git diff --name-only main...HEAD | bash scripts/checks/forbidden-file-diff.sh'
…
ALLOW LIST — GATES_ENGINE_ALLOW, supplied by the caller, default empty (3 entries)
  IN USE  forge-control/src/db/projects.ts
  IN USE  forge-control/src/lib/project-tick.ts
  IN USE  forge-control/src/lib/project-tick.test.ts

PATHS MATCHING THE BAN (3)
  declared   forge-control/src/db/projects.ts
  declared   forge-control/src/lib/project-tick.test.ts
  declared   forge-control/src/lib/project-tick.ts

clean — 3 banned path(s) differ and every one was declared
EXIT=0
```

The **first** of those two is the important one. It is the unchanged default —
what every other branch in this repo gets — and it names, path by path, exactly
what the allow list buys. `03-quality.md` §3.1 item 12 obliges the reviewer to
run it that way and to check the three names against `04-phases.md` §10.

### 1.5 THE CONTROL FOUND A DEFECT IN ITS OWN SUBJECT ON ITS FIRST RUN

Eight of thirteen cases red. Not a fixture problem — a real hole:

```
  FAIL  case 5 — VaultFileList is still refused under this project's allow list (rc=1, wanted 1)
        | paths read on stdin: 1        <- TWO paths were fed in
```

`while IFS= read -r line` returns non-zero for a final line carrying no trailing
newline, so **the last path was never read**. A producer emitting an unterminated
list would have had its last path silently dropped and the gate would have
reported *clean* on a forbidden file. `git diff --name-only` terminates its last
line — which is exactly why this would never have surfaced in production and why
feeding the instrument only well-formed input is not a test.

Fixed with `|| [ -n "$line" ]` on both read loops, and pinned as **case 14**,
which drives the unterminated form on purpose.

This is the round's answer to *what would have made my instrument report a pass
wrongly*: it did, in the first minute, and the control is what said so.

### 1.6 The control, complete

```
$ bash scripts/checks/check-forbidden-file-diff.sh
  subject sha256  : b13ec06e52260aa83c7d4fc4a5f4bc10d0bc621057a40ecadc12b7e44f509351
  control sha256  : 477f07fd95903a4361ac8b5a45a26270e0570ef05d3c58efa705fec16852e1b6
  HEAD            : efb9e17d567286e2bcdb5b1c014ace5928c21d4c

  PASS  case 1  — no banned path in the list, empty allow -> clean
  PASS  case 2  — an engine file differs, empty allow -> REFUSED and named
  PASS  case 3  — the three declared engine files, declared -> clean
  PASS  case 4  — an allow list naming a DIFFERENT engine file does not blanket
  PASS  case 5  — VaultFileList is still refused under this project's allow list
  PASS  case 6  — routes/files is still refused
  PASS  case 7  — cc-runner is still refused
  PASS  case 8  — an entry the ban never matches is reported INERT and grants nothing
  PASS  case 9  — a NEWLINE-separated allow list parses like a comma-separated one
  PASS  case 10 — leading/trailing blanks around entries are stripped
  PASS  case 11 — matching is EXACT — a declared path does not permit its .test.ts neighbour
  PASS  case 12 — a failing producer is caught by the call site's pipefail, not by a clean verdict
  PASS  case 14 — an unterminated final path is read, not silently dropped
  PASS  case 13 — the live diff is clean under the declared list, and refused with
                  'forge-control/src/db/projects.ts' removed

SUMMARY
  cases executed : 14
  cases skipped  : 0
  failures       : 0
ALL PASS — 14 checks
EXIT=0
```

Cases 2 and 5-7 are the ones worth reading. **Case 2** is the assertion that this
amendment changed nothing for any other project — the ruling's central
requirement, executed rather than promised. **Cases 5-7** assert that this
project's own allow list still refuses `VaultFileList`, `routes/files` and
`cc-runner`, which is the property the round-808 waiver protects. **Case 13** is
the mutation: remove one entry and the same live diff is refused, so the list is
load-bearing rather than decorative. **Case 12** executes the composed pipeline
under `set -o pipefail` with a failing producer, because the honest answer to
"what if `git diff` fails" is a control, not a sentence.

If a case stops executing, `CASES + SKIPPED != EXPECTED_CASES` and the run exits
1 rather than reporting a smaller clean sweep.

### 1.7 The suite

```
$ GATES_ENGINE_ALLOW='forge-control/src/db/projects.ts,forge-control/src/lib/project-tick.ts,forge-control/src/lib/project-tick.test.ts' \
    bash scripts/checks/gates-808.sh --strict
…
 6  0      forbidden-file diff — three-dot main...HEAD, checked against GATES_ENGINE_ALLOW
…
 RED: 0
EXIT=0
```

**25 gates: 23 executed, 0 red, 2 SKIPPED-by-design (23, 24 — browser harness),
exit 0.** This is the first time `gates-808.sh --strict` has been able to exit 0
on this branch at any sha.

---

## 2. Finding 2 — the inert control in round 822's evidence

Round 823: the block at `evidence/round822-fix-cycle-2.md` §3 cites
`grep -c "so open ONE PER LANE you want running at once"` returning `0` as
evidence the live checkout lacks the corrected clause — but that grep returns `0`
against the **worktree** too. Verified here rather than accepted:

```
                                                          worktree   live
grep -c "truly need one file concurrently"                       0      1
grep -c "ONE PER LANE"                                           1      0
grep -c "so open ONE PER LANE you want running at once"          0      0   <- INERT

$ (cd forge-control && tsx -e 'import {GRAPH_GUIDE} from "./src/lib/project-tick.ts";
     console.log(GRAPH_GUIDE.includes("so open ONE PER LANE you want running at once"))')
true                      <- present in the EVALUATED constant, at 1 occurrence
$ grep -n "ONE PER LANE" forge-control/src/lib/project-tick.ts
455:  `… — so open ONE PER LANE ` +      <- the phrase straddles a template-literal join
```

Confirmed exactly as reported. The clause is real; the grep for it can only ever
return `0`, in any tree, because the sentence appears contiguously in no source
file.

**Which half discriminated:** the first grep — the retired criterion, `1` live
and `0` in the worktree — and it carried §3's conclusion by itself. §3's
conclusion is therefore unaffected and remains correct.

**The failure this closes is the deploy's.** That task was briefed to re-run
these greps after `safe-restart.sh` to confirm the new prompt shipped. Run as
written it reads `0`, concludes the deploy failed, and is wrong about a deploy
that worked.

Repaired in `evidence/round822-fix-cycle-2.md`: round 822's block is **kept and
marked**, not rewritten — it is the record of what that round really ran — and a
new **§3.1** states the measurement above, names which half does the work, and
supplies both a contiguous source-level replacement (`"ONE PER LANE"`) and the
constant-level check for cases where the evaluated text is what matters.

---

## 3. Finding 3 — the NF7 ruling, and its condition, are now in the corpus

`01-requirements.md` §J closed with *"Reported to manager chat `bfd1283a` for a
ruling rather than taken silently"* — true when round 822 wrote it. The ruling
has since come back **CONFIRMED with a condition**, and it lived only in a chat
thread and in task 962's brief, where a round 964 reading §J would never find it.

Retrieved from the manager chat run's own thread and recorded verbatim in §J:
the operator's three reasons for confirming 3700 against their own standing rule
(*it trimmed first*; *unsatisfiable by 22× is not "binding", it is impossible*;
*the three rules are engine facts a planner cannot work without*), and the
condition:

> **Any future NF7 increase must state, in its own commit, WHAT WAS RETIRED FIRST
> AND WHY IT DID NOT PAY, with the measurement.** A budget whose every breach is
> answered by raising it has stopped measuring anything.

§J now also spells out the sequence a fourth widening owes: name the clause
retired, measure what the retirement bought with
`measure-graph-guide-budget.ts --candidate`, and show the shortfall that
survives — in the commit, not in a report.

---

## 4. Non-blocking note 1 — the NaN verdict, reproduced and killed

`measure-graph-guide-budget.ts` printed
`VERDICT: FITS — NaN characters would remain under the cap` when a scalar failed
to parse: `scalar()` correctly returns `NaN` and fails, but `NaN < 0` is false,
so control flow fell into the affirmative branch. The run exited 1 and §5 voided
every number — rule 3's letter — but a verdict line is read alone far more often
than in sequence, and the affirmative string is the one a grep lifts.

Guarded on `Number.isFinite`, with a refusal that names the cause. **The
mutation, run and restored by hash:**

```
$ sha256sum forge-control/src/lib/project-tick.test.ts
105ce69f5e3d28040df6d92f29440e2e419081ba82ee94dcf3932e84217e4f21   <- before

$ sed -i 's/const BASELINE = /const BASELINE_RENAMED = /' forge-control/src/lib/project-tick.test.ts
$ (cd forge-control && tsx ../scripts/checks/measure-graph-guide-budget.ts --candidate …)
  projected headroom             NaN
FAIL  NO VERDICT IS AVAILABLE: the projected headroom is NaN (cap NaN, projected 12810).
      A scalar above failed to parse out of project-tick.test.ts, so there is no cap to
      judge this candidate against — and a candidate cannot be called fitting against a
      number that was never read.
2 FAILURE(S) — no number above may be quoted
true EXIT under mutation = 1
occurrences of "VERDICT: FITS" in the mutated run = 0        <- was 1 before this change

$ sha256sum forge-control/src/lib/project-tick.test.ts
105ce69f5e3d28040df6d92f29440e2e419081ba82ee94dcf3932e84217e4f21   <- restored, identical
```

Unmutated, both modes still behave: gate mode
`OK — measured 12246 against cap 12921, 675 of headroom`, exit 0; candidate mode
`VERDICT: FITS — 111 characters would remain under the cap`, `+564`, projected
`12810`, substitution control `12810`, exit 0. Every number round 822 committed
reproduces.

---

## 5. Non-blocking note 2 — the reservation-audit message

`project-tick.test.ts`'s reservation audit read *"do NOT widen BUDGET … the one
direction 00-vision.md §7 rule 2 does not license"*, two hundred lines beneath a
block in which round 822 widened BUDGET. The narrow reading was coherent; the
sentence read against its own file.

**This is the one test body this round modifies, and it is a message string
only** — no expression, no fixture, no count, no new or deleted test. It now
separates the two cases it was conflating: raising a cap AFTER the fact to cover
text already written (forbidden — a gate edited to match the tree) from amending
a gate measured unsatisfiable BEFORE the work (required by rule 2). A doc-comment
above the test states the distinction and points at §J for the operator ruling.

`pnpm test`: **1294 tests, 239 suites, 1294 pass, 0 fail, 0 skipped**, unchanged
from round 823's reading. NF7's measurement is unmoved at **12246** — no prompt
constant was touched.

---

## 6. Every gate re-run at this tip

| gate | result |
|---|---|
| `gates-808.sh --strict` (with the §3.1 item 12 allow list) | **25 gates, 23 executed, RED 0, 2 SKIPPED-by-design, exit 0** |
| `gates-808.sh --strict` (bare, no allow list) | gate 6 red, exit 1 — **the unchanged default, and the control read** |
| `check-forbidden-file-diff.sh` | ALL PASS — 14 checks, exit 0 |
| `pnpm test` — forge-control | 1294/1294, 239 suites, 0 fail, exit 0 |
| `npx tsc --noEmit` — forge-control | exit 0 |
| `check-instrument-typecheck.sh` | 44 found / 44 compiled / 0 type failures / 0 fidelity / 0 missing / 0 uncovered / 0 suppressions, exit 0 |
| `measure-graph-guide-budget.ts` (gate mode) | exit 0 — 12246 against cap 12921, 675 headroom |
| `check-workstream-claim.ts` | ALL PASS — 27 checks, exit 0 |
| `measure-prompt-baseline.sh` | PASS — every tree measured under both controls, every ledger row reproduced |
| `check-corpus-map.py` | exit 0 — R1..R71 + NF1..NF7 agree |
| `check-instrument-identity.py` | exit 0 |
| `check-r20-census.py` | R20 PASS, REGION PASS |
| `shellcheck -S error` over this branch's `*.sh` | exit 0, new scripts included |
| R66 sweep (`*.ts`, `*.sh`) | **4 hits, unmoved** — all four string literals inside NEVER-worded prohibitions |
| `grep -rn "consecutive rounds" forge-control/` | empty |
| `git -C /opt/forge-ai-os status --porcelain` | **empty** |

---

## 7. The three questions §4 requires before a verdict

**1. What would have made my instruments report a pass wrongly?**

- *It did.* `forbidden-file-diff.sh` dropped an unterminated final path, so a
  forbidden file could have been read as clean. Found by the control's first
  run, fixed, pinned as case 14 (§1.5).
- *An allow list that quietly bought more than it declared.* The gate could have
  matched by prefix or glob, in which case
  `forge-control/src/db/projects.ts` would also have permitted
  `db/projects.test.ts`. Matching is exact and case 11 asserts it.
- *An allow list that read as protection while permitting nothing.* An entry the
  ban never matches is a no-op that looks like a decision; it is printed INERT by
  name, and case 8 asserts it grants nothing.
- *The suite certifying an empty sweep.* If `git diff` fails the subject reads
  zero paths and prints clean; `gate_sh` runs under `set -o pipefail` so the gate
  is still nonzero, and case 12 executes that composed pipeline rather than
  asserting it in prose.
- *The NaN verdict.* §4. Reproduced and killed.

**2. Which gate did I find unsatisfiable, and did I amend it where it is
enforced in the same commit?** `gates-808.sh` gate 6. Amended in
`gates-808.sh` itself, with the retired clause named, the reasoning inline, the
operator ruling quoted, and `03-quality.md` §3.1 item 12 + §4 landing in the same
commit. The ban pattern is unchanged and no project is named — the amendment is
a binding to declared write-sets, not a widening.

**3. Every citation by symbol or requirement id?** Yes. This document pins one
line number, `project-tick.ts:455`, and it is quoted from a `grep -n` executed at
the recorded tip `efb9e17` with the matched text shown beside it, which is the
form standing rule 1 permits. Everything else cites a symbol (`GRAPH_GUIDE`,
`scalar()`, `fixChainGraphFields()`), a requirement id (R31, NF7), a gate item
(`03-quality.md` §3.1 items 4, 10, 12), a case number, or a sha256.
