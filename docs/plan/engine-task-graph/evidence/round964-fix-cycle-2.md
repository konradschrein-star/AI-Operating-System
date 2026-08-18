# Round 964 — fix cycle 2, against round 963's re-review

Parent tip reviewed by round 963: `4fcaa1c55f3774e6200013400ec1d51cf0867a35`.
This round starts there, worktree clean, branch `project/8c591d6c`.

Round 963's verdict was NEEDS_FIXES on four items: two blockers (1, 2) and two
non-blocking (3, 4). All four are addressed. Findings 3 and 4 were *weighed*
rather than reflexively implemented — both were taken, and the reasoning for
taking them is recorded here and at the enforcement site.

---

## 1. Blocker 1 — the live checkout's untracked half is an unarchived sole copy

Round 963 measured 26 dirty paths in `/opt/forge-ai-os`, 21 of them untracked,
and found that the two archived preservation patches carry **5 `+++ ` headers
each** — the tracked files only. It named the false confirmation precisely:
`grep day-score` on the older patch returns one hit, and that hit is *the import
line inside another file's diff*, not the file.

### What was done, and why it is not a revert

The operator ruling of 2026-08-18 (`AI OS/Operator Decisions.md`, *"When the
live checkout goes dirty"*) makes **discard the forbidden verb**; round 962
refused round 961's prescribed `git checkout --` on exactly that ground and
round 963 upheld the refusal. Preservation is therefore the whole of the task.
Round 963's prescribed shape was followed and then strengthened:

```
git status --porcelain -uall > <ts>-live-checkout-status.txt   # freeze ONE read
awk '$1=="??"{print $2}' <that file> > <ts>-untracked-manifest.txt
tar czf <ts>-forge-ai-os-untracked.tgz -T <ts>-untracked-manifest.txt
git diff > <ts>-forge-ai-os-dirty-tracked.patch                # the tracked half, fresh
git rev-parse HEAD > <ts>-live-checkout-head.txt
```

The manifest is derived from the **frozen status file**, not from a second `git
status`. Round 963 measured the set changing between two reads twenty minutes
apart, so a manifest read separately from the archive would describe a different
tree than the one archived. One read, two consumers.

### Artefacts

All under `/opt/ai-os/uploads/5947aa3345f8/`, stamp `20260818T230634Z`:

| file | what it is |
|---|---|
| `20260818T230634Z-forge-ai-os-untracked.tgz` | the 21 untracked files, 21 members |
| `20260818T230634Z-forge-ai-os-dirty-tracked.patch` | the 5 tracked files, re-taken at this round's clock |
| `20260818T230634Z-untracked-manifest.txt` | the 21 paths, from the frozen status read |
| `20260818T230634Z-live-checkout-status.txt` | that frozen read, verbatim |
| `20260818T230634Z-live-checkout-head.txt` | `91f6b285fa0844fb308c37c5829f1e9298f20d0b` |

### Verification — extract and byte-compare ALL of it, not a sample

Round 963 asked for a sample. A sample is what produced the false confirmation
it was blocking on, so every file was compared:

```
members(files)=21  manifest=21
byte-identical=21  failures=0
```

And the specific file whose absence was the finding, confirmed as a **tar
member** rather than as a grep hit:

```
-rw-r--r-- root/root  9965 2026-08-19 00:15 forge-control/src/lib/day-score.ts
43bbede0c778f2391171f06c0a01c20c96899dcc0ce8a2bc987bc17d94d8d8e8  /opt/forge-ai-os/forge-control/src/lib/day-score.ts
43bbede0c778f2391171f06c0a01c20c96899dcc0ce8a2bc987bc17d94d8d8e8  <extracted copy>
```

### The sole-copy status, re-derived rather than inherited

```
sole-copy=21  already-committed-somewhere=0
```

— i.e. `git log --all --oneline -- <path>` is empty for **all 21**, not just for
`day-score.ts`. The two prior patches were re-counted independently and both
still show 5 `+++ ` headers, confirming round 963's arithmetic.

### The tree moved under the measurement, and that sharpens the blocker

`HEAD` went `91f6b28` → `6ee76c2` during this round (`feat(prompt): point every
worker at the shared memory the last one wrote`, plus its merge — another
project's work, landing normally). Re-measured at the new tip:

* `git status --porcelain -uall` is **byte-identical** across the move;
* all 21 paths are **still in no commit on any branch**.

So the tree has an active committer who is committing other work and not this
work. That makes blocker 1 a standing risk, not a snapshot: the next agent to
run a `git checkout --`, a `git clean`, or a reboot of a tmpfs-backed anything
destroys the only copy that has ever existed of ~21 files.

### Escalated, because a tarball is a backup and not history

Reported to the manager chat run `bfd1283a` (HTTP 202) naming the sole-copy
status, the artefact paths, and the verification method. **This needs a branch
and a commit from whoever owns that work, which is Konrad's call and not a
task's** — round 963 said the same and its escalation is `bfd1283a` too. Nothing
in `/opt/forge-ai-os` was created, modified or removed by this round; every
command issued against it was `git status`, `git log`, `tar`, `cmp` or
`sha256sum`.

---

## 2. Blocker 2 — a docstring declaring a closed finding open

`forge-control/src/routes/projects.ts`, `workstreamCapRefusal()`'s doc comment,
ended:

> `GRAPH_GUIDE`'s "up to that cap" not saying so is the separate open finding.

Round 962 is the commit that made that sentence false — it put the clause into
`GRAPH_GUIDE` — and the *same commit* explicitly retired the twin `OPEN, task
962` label in `check-workstream-claim.ts` §5.6, calling leaving it "a document
mislabelling a closed finding as live". The identical sentence in the other file
was missed. Round 963 is right that this is round 825's blocker reintroduced by
the commit that closed it, and right that the guard is the worst possible place
for it: a round grepping for open findings reads it as authoritative *because*
it sits where the fact lives.

**Fixed as prescribed.** The arithmetic — every project is born with its
architect row in `main`, this counts all rows regardless of status, so `CAP - 1`
new lanes are openable — is unchanged, word for word. The two closing clauses
are replaced by the closure: round 962 put the clause in `GRAPH_GUIDE`, `6.7b`
asserts it is there, `6.7a` derives the openable count by walking this very
function from the birth state, the twin label was retired then and this one is
retired now (standing rule 4), and the paragraph says *why* it changed so the
next round does not have to reconstruct it.

`routes/projects.ts` matches **no** gate-6 ban pattern, so this costs the allow
list nothing — measured in §6 below, in both directions. Declared in
`04-phases.md` §10.

---

## 3. Finding 3 (non-blocking) — gate 18's shared scratch database

`check-usage-fold.ts` reads `USAGE_FOLD_DB` and falls back to the **fixed** name
`r1354_sampler`:

```
const SCRATCH_DB = process.env.USAGE_FOLD_DB ?? "r1354_sampler";
```

The per-process fix `f283d5b` lives on `project/7851068b` and is not an ancestor
of `main` or `HEAD`, so on this branch the name must be supplied by whoever runs
the suite. Round 963 hit this as a `3 FAILURE(S)` on green code and had to
diagnose it before it could review anything.

### Measured, not asserted — and the failure has two faces

A throwaway cluster was `initdb`'d on port 5601 (nothing live was touched; the
check refuses outright if `DATABASE_URL` names the same database as
`USAGE_FOLD_DB`). Four runs, one variable:

| run | `USAGE_FOLD_DB` | result |
|---|---|---|
| A, alone | unset | `ALL PASS — usage fold (scratch db: r1354_sampler)` |
| B, alone | `usage_fold_r964` | `ALL PASS — usage fold (scratch db: usage_fold_r964)` |
| C+D, **concurrent** | unset for both | **both exit 1** |
| E+F, **concurrent** | `usage_fold_c1` / `usage_fold_c2` | **both exit 0, ALL PASS** |

Runs A and B are the control that the environment variable is actually honoured
and reaches the verdict line. Runs C–F are the finding, and the interesting part
is that the two concurrent runs failed **differently**:

```
C:  FAIL  hour 10 still reports the run as billed
    1 FAILURE(S) — usage fold (scratch db: r1354_sampler)
D:  ERROR:  deadlock detected
    Error: psql failed
```

The deadlock is the lucky face — it is obviously an infrastructure error. The
**wrong-arithmetic** face is the dangerous one: it names a real assertion about
a real behaviour, on green code, so a reviewer either blocks a correct branch or
learns that a red gate can be waved through. That habit is the one the standing
rules single out.

### Amended where it is enforced

`03-quality.md` §4's item-12 block now exports `USAGE_FOLD_DB="usage_fold_$$"`
beside the existing `GATES_ENGINE_ALLOW` export, with the measurement, the
reason, the unmerged location of `f283d5b`, and the honest caveat that the check
does **not** drop what it creates — so either accept one leftover database per
run and say so, or point `DATABASE_URL` at a throwaway cluster, as this round
did. Merging `f283d5b` was the alternative round 963 offered; it is another
project's branch and outside this round's business, and the export closes the
hazard for every reader of this document today.

---

## 4. Finding 4 (non-blocking observation) — weighed, and taken

Round 963 offered this "so the next round can weigh it rather than as a demand":
FAN-OUT told a planner to give researchers *"a lane each"* and builders *"as
many lanes as you want building at once"*, while only `cap-1` = 5 lanes are
openable.

**Taken, for the reason round 963 itself gives.** The mitigation is real — cap,
400 and allocation rule are all in the workstream bullet, and that constant
reaches every seat — but the shape is identical to finding 4's own winning
argument at round 961: *a rule stated in the bullet is not stated where the
decision is made*. That shape has now produced a blocker at 961 and an
observation at 963. A planner with six independent research questions meets the
400 at the one moment it is not reading the workstream bullet.

**Taken at zero cost, which is what made it an easy call.** Headroom was 38
characters, so a net-positive edit would have left the next round almost
nothing. Sized *before* it was written, with round 822's instrument and its own
documented command:

```
"a lane each. "                                  -> "a lane each while lanes remain. "   (+19)
"in as many lanes as you want building at once. " -> "in as many lanes as remain. "       (-19)
GRAPH_GUIDE 2588 -> 2588   net +0
```

and through the maximal planner path:

```
  candidate GRAPH_GUIDE          2588 chars
  net delta vs the live guide    +0
  projected headroom             38
  VERDICT: FITS — 38 characters would remain under the cap.
```

Both swap anchors were asserted **unique** before substitution — a candidate
built from a non-unique anchor is not the edit it claims to be — and the shipped
constant was then proved byte-identical to the measured candidate
(`GRAPH_GUIDE === readFileSync(candidate)` → `true`, 2588 chars), which is the
control round 962 established.

**Deliberately not the words "up to the cap".** That is the exact phrasing round
961's finding 3 condemned for over-promising by one; repeating it in FAN-OUT
would re-teach in one paragraph what round 962 fixed in another. Both edits use
the workstream bullet's own corrected vocabulary — *"so cap-1 remain"*.

**Ledgered at `{ round: 964, spent: 0, reserved: 0 }`.** A zero-delta edit is
the one kind NF7's exactness assertion *cannot* catch, since the arithmetic is
invisible. The row is therefore documentation rather than accounting, and it
says so. `BUDGET` is untouched at 3700; headroom is unmoved at 38.

### The clause has a needle, and the needle was mutation-proved

`check-workstream-claim.ts` gains `6.10` — **two** needles, one per FAN-OUT
instruction, because a bound stated for researchers and dropped for builders is
exactly the half-fix being closed. It is labelled a clause check, honestly: the
engine behaviour is already executed twice over (§5's refusal, `6.7a`'s walk of
the guard), so the sentence was the whole of the gap.

Mutation control — the builders clause reverted to round 962's wording, nothing
else changed, script re-run:

```
FAIL  6.10 FAN-OUT bounds its builders instruction by the lanes that REMAIN …
1 FAILURE(S) out of 36 checks
```

Tree restored and the restoration **proved by blob hash**, not by eye:
`git hash-object forge-control/src/lib/project-tick.ts` =
`2ea1d26935f1b03095efb05185ec87f02ec6cbdf` before the mutation and after the
restore.

*A note against my own work, since standing rule 3 is about instruments:* the
first restore was `git checkout -- <file>`, which reverts to `HEAD` — it wiped
the uncommitted round-964 edit rather than the mutation. The blob-hash check is
what caught it (`restored=NO`); the edit was re-applied and the hash then
matched. Had I confirmed by reading the file, the sweep would have gone green
against round 962's text while the evidence file claimed round 964's.

### The census still tracks the cap

Round 963 re-ran round 961's mutation A and got 32 / 33 / 34 / 34. With `6.10`'s
two needles the same sweep gives, at `PROJECT_MAX_WORKSTREAMS` = 2 / 3 / 9 / 12:

```
ALL PASS — 34 checks
ALL PASS — 35 checks
ALL PASS — 36 checks
ALL PASS — 36 checks
```

— the same shape, shifted by exactly the two checks added. `EXPECTED_CHECKS`
moves with it and its comment names where the `+2` comes from.

---

## 5. What was NOT done, and why

* **`f283d5b` was not merged.** It is another project's branch; §4's export
  closes the hazard for this document's readers without reaching into it.
* **Nothing was reverted in `/opt/forge-ai-os`.** Operator ruling of
  2026-08-18; upheld at round 963.
* **The scratch cluster was stopped, not deleted.** `/tmp/r964pg` remains, as
  round 963 left `/tmp/r963pg`. All four scratch databases created by §3 live
  inside it, so nothing accumulated on the shared server.
* **No deploy, no live endpoint, no `pm2`.** `8ea0cc08` is live and this diff
  touches executor-loaded code; the brief reserves verification against live
  services to the explicit deploy/verify task.

---

## 6. Gate 6, both directions

The allow list is unchanged from round 962 —
`forge-control/src/db/projects.ts`, `forge-control/src/lib/project-tick.ts`,
`forge-control/src/lib/project-tick.test.ts`. Round 964 writes two of those
three and does **not** widen it. `routes/projects.ts` matches no ban pattern,
which is why blocker 2 could be fixed at the guard without touching the export;
that is measured in §8's control read, not assumed.

---

## 7. Write-set — every path of it undeclared

This round's task row carries `write_set = []` (round 963's footnote traced this
to `strict_write_sets` being goal-mode only, which this project is not), so the
declared set is empty and **every file below is an undeclared write, disclosed
here, in `04-phases.md` §10, and in the commit message** — three independent
statements to cross-check against `git show --stat`.

| file | why |
|---|---|
| `forge-control/src/routes/projects.ts` | blocker 2 — the docstring closure |
| `docs/plan/engine-task-graph/03-quality.md` | finding 3 — `USAGE_FOLD_DB` in §4, where the suite is invoked |
| `forge-control/src/lib/project-tick.ts` | finding 4 — FAN-OUT's two bounded clauses |
| `forge-control/src/lib/project-tick.test.ts` | NF7's LEDGER row 964 |
| `scripts/checks/check-workstream-claim.ts` | `6.10` + the census |
| `docs/plan/engine-task-graph/04-phases.md` | the §10 disclosure |
| `docs/plan/engine-task-graph/evidence/round964-fix-cycle-2.md` | **new** — this file |

---

## 8. Verification run at this round's tip

`03-quality.md` §4's commands, run from the worktree. Everything below was run
**twice**: once against the working tree before the commit, and once at the
committed tip, because standing rule 3 is about instruments naming the wrong
build — `check-migration-0040.sh` prints its own `git <sha>` identity line, and
that line names `HEAD`, not the tree it just measured. The numbers below are the
committed-tip run.

| check | result |
|---|---|
| `pnpm typecheck` (forge-control) | exit 0 |
| `pnpm test` (forge-control) | **1294 / 1294**, 0 fail |
| `gates-808.sh --strict` | **25 gates, 23 executed, 2 SKIPPED-by-design (23, 24 — browser harness), RED: 0**, suite exit 0 |
| gate 18 specifically | `0` — with `USAGE_FOLD_DB` per §3's amendment; the whole point of that amendment |
| gate 6 control read (`GATES_ENGINE_ALLOW=`) | exit **1**, naming exactly `db/projects.ts`, `project-tick.ts`, `project-tick.test.ts` — the same three the §4 export lists, both in §10. **No widening**, and `routes/projects.ts` does not appear, which is blocker 2's cost measured rather than asserted |
| `check-forbidden-file-diff.sh` | **14 / 14**, 0 failures |
| `check-workstream-claim.ts` | **36 / 36** (34 at round 963; `+2` is `6.10`) |
| — its cap sweep | **34 / 35 / 36 / 36** at `PROJECT_MAX_WORKSTREAMS` = 2 / 3 / 9 / 12 |
| — its mutation control | reverting the builders clause **FAILS 6.10**; tree restored, blob hash `2ea1d269…` identical before and after |
| `measure-graph-guide-budget.ts` | exit 0 — `12883` against cap `12921`, **38 headroom**, `BUDGET` untouched at 3700, ledger row 964 `+0` |
| `check-instrument-typecheck.sh` | **44 / 44** compiled clean, 0 type failures, 0 fidelity violations, 0 suppressions, 176s |
| `check-workstream-e2e.sh` | **61 / 61** |
| `check-await-seed.sh` | **7 / 7** cases, **56 / 56** assertions |
| `check-screenshot-render-shapes.ts` | **16 / 16** |
| `check-schedule-sql.sh` | exit 0 — 40 pass, 0 fail |
| `check-migration-0040.sh` | **PASS** — 0042 re-runnable (R2), backfill is the closure (R6), both indexes exist (R7). Needs `$SCRATCH_DATABASE_URL`; run against the same throwaway cluster as §3 |
| `measure-prompt-baseline.sh` | **17 controls, 0 failures** |
| `check-corpus-map.py` | OK — R1..R71 and NF1..NF7 complete, all three statements agree |
| `check-instrument-identity.py` | OK — 37 pasted manifest lines name the current digest; no retired identity quoted |
| `check-r20-census.py` | **PASS** (R20 and REGION) |
| `shellcheck -S error` over the 6 derived `*.sh` | exit 0 |
| R66 sweep (`*.ts` + `*.sh`) | **exactly 4 hits**, unmoved — all string literals inside NEVER-worded prohibitions |
| `grep -rn "consecutive rounds" forge-control/` | empty |

### Artefacts left behind, named rather than dropped silently

* `/tmp/r964pg` — the throwaway Postgres cluster (port 5601), **stopped**. All
  scratch databases created by §3 and by `check-migration-0040.sh` live inside
  it, so nothing was added to the shared server.
* `/tmp/schedule-sql-check.*` — left by `check-schedule-sql.sh` itself, which
  says so in its own output.
* The five archive files under `/opt/ai-os/uploads/5947aa3345f8/` — §1. These
  are the ones that must **not** be dropped.
