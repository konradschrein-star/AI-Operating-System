# Phase 2, fix cycle 2 — round 205's finding, and the retraction it produced

Round 206, fix builder. Worktree
`/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4`, branch
`project/8c591d6c`, parent commit **`27737a9`**.

Round 205 returned NEEDS_FIXES with exactly one finding, and called it
documentation: `evidence/phase2-replay.md` §7's R20 census read 85 hits / 92
case-insensitive against a file that had grown to 99 / 108, with the
`(module preamble)` row reading 2 against an actual 6, three new symbols
unattributed, and §3's `sha256` table naming bytes that three of four files no
longer had. *"Documentation only — R20's conclusion is intact and the engine
needs no change."*

**No engine file is written by this cycle.** The finding was right about that,
and it is checkable rather than promised — see §5.

**Nothing was deployed.** No live endpoint, no live database, no `pm2` command,
no write to `/opt/forge-ai-os`.

---

## 1. Build identity of everything reported here

```
worktree     /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
git HEAD     27737a9   (parent of this commit)
sha256 forge-control/src/db/projects.ts                    e1b14c1f7a4dc8db…
sha256 forge-control/src/lib/task-graph.ts                 5bf1e91d35a965bc…
sha256 forge-control/src/lib/task-graph-replay.test.ts     f29b7488cfb1ce7f…
sha256 forge-control/src/lib/fixtures/replay-…-.json       e0cb69a5c5d05bdf…
sha256 scripts/checks/check-r20-census.py (new, this cycle) 779d383f8b5fad34…
mutation clone  /tmp/r206/shadow, its own git repo, files COPIED by
                `git clone --no-hardlinks`, verified regular files with sha256
                equal to the worktree's before each mutation — never symlinks
                into the worktree.
```

The first four are the identity the round-205 finding asked to be settled; they
are now recorded in `phase2-replay.md` §3's freeze notice as well, which is where
a reader looking at the stale table will land.

**CORRECTED ROUND 208, and the correction matters more than the digit.** The
census line above read `ede10d5fa7c32cfa…` when this document was committed at
`cf75f83`. The shipped file's sha256 is `779d383f8b5fad34…`; the value written
here matched **no committed state** — `git log --oneline` over that path returns
`cf75f83` and nothing else, so the file has exactly one committed version, whose
sha256 is the value now above — and `ede10d5f…` appeared nowhere else in the
corpus, nor in any blob in history. So the
identity of the instrument that actually shipped was recorded nowhere, which is
*"a sha naming the worktree rather than the build"* in a new costume, the third
time this project has caught that defect class. Round 207 blocked on it.

**Which bytes each §3 transcript was produced against.** This cycle's commit
message states the script was edited after mutation 5 was found, so
`ede10d5f…` named a working draft that predates the fix. That draft was **never
committed and its bytes are gone**, so which of §3's transcripts predate the fix
cannot be established from the record, and this line does not pretend otherwise:

| Transcript | Bytes it was produced against |
|---|---|
| §3 mutations 1–4, and the inert blank-line mutation | An uncommitted pre-fix draft, identity unrecoverable. **Re-run against the shipped `779d383f…` in §3.1 — mutations 1–3 still red; mutation 4, split into 4a and 4b by round 210 (§3.1's own conjunction did not survive its own re-run), is mixed: 4a leaves the main entry green, 4b still red.** |
| §3 mutation 5, *first* transcript (`at git 27737a9` → `25ae132`) | The pre-fix draft **by construction**: it is that draft's defect being exhibited, since the shipped `render()` cannot emit a commit stamp at all. |
| §3 mutation 5, *second* transcript (exit 0 across the commit) | The post-fix bytes, i.e. `779d383f…`. Re-confirmed in §3.1's control run, which is green *after* `cf75f83` landed. |

Rather than reconstruct an attribution from a draft that no longer exists, round
208 re-ran every mutation against the bytes that shipped. §3.1 is that record.

---

## 2. What round 205 asked for, and what was done

| Asked | Done |
|---|---|
| Re-measure §7's headline pair (85/92 → 99/108) | **Generated**, not re-typed. §7.4 is now a region emitted by `scripts/checks/check-r20-census.py`. |
| Fix the 41/44 split and the "sum to 85" arithmetic | Generated: **44 code / 55 comment**, summing to 99 by construction. |
| Fix the `(module preamble)` row's count (2 → 6) | Generated: **6**. |
| Add rows for the symbols with no row | Generated: every symbol carrying `round` gets a row, and one *without* a written attribution now **fails the check** (§3, mutation 3). |
| Resolve §3's `sha256` table — freeze or re-measure | **Frozen** at `27d300f`, with a forward pointer to `phase2-fix-cycle-1.md` §1 and the one hash that pointer omits. Reasoning in §4. |
| Change no engine code | None changed (§5). |

The reason for generating rather than re-counting is in the finding itself:
eleven of the nineteen `round`-bearing lines fix cycle 1 added are the literal
citation *"round 204"*, a string that recurs every cycle. A hand-maintained
census was a gate no fix cycle could leave satisfied — so it was amended where
it is enforced (`03-quality.md` §3.2, `01-requirements.md` R20), in this commit,
standing rules 2 and 4.

The script also does something the grep never did. R20's clause is *"no
promotion or claim predicate reads `round` outside the labelled legacy
surface"*, and **counting hits is not that assertion**: a census admits a fresh
predicate the moment somebody adds a row for it. Every non-comment `round` line
inside `promoteReadyTasks`, `claimReadyTasks` and `sweepDanglingDependencies`
must now appear in `ALLOWED_SCHEDULING_LINES` with a justification, and a new
one fails **by name** (§3, mutation 2).

---

## 3. The gate can fail — four mutations, each observed red

A gate never seen failing is not a gate — and a gate never tried under the
conditions it will actually run in is not one either, which is what mutation 5
is about. Run in the copied clone described in §1; each mutation asserts its
pattern occurs exactly once and aborts otherwise; the control run at the
shadow's own HEAD is green on both entry points (`check exit=0`,
`self-check exit=0`).

> **READ §3.1 FIRST.** The transcripts below were produced against an
> uncommitted draft of the script whose bytes no longer exist — §1 records why.
> **§3.1 re-runs these against the bytes that shipped (`779d383f…`).** Mutations
> 1–3 still turn red. Mutation 4 as stated below — one run producing both a
> byte-identical banner and a 36-row `--write` — does not reproduce as written:
> round 210 found the two claims belong to two different edits, split them into
> **4a** (the default parameter alone: green, byte-identical, nothing to write)
> and **4b** (the body: red, 36 rows move), and re-ran both separately. §3.1
> carries the split and the corrected numbers; this section also notes the one
> incidental number that differs and why. Treat the numbers below as attributed
> to that lost draft; treat §3.1's as attributed to the build.

**Mutation 1 — the census region goes stale.** Round 205's finding, mechanised:
edit the generated headline back to the numbers the document used to carry.

```
$ sed -i 's/\*\*99 lines match `round`; 108 match/**85 lines match `round`; 92 match/' …/phase2-replay.md
$ scripts/checks/check-r20-census.py                                   → exit 1
FAIL: …/phase2-replay.md's R20 census is STALE — the file has changed since it
      was generated. Run `scripts/checks/check-r20-census.py --write`.
```

The check prints a unified diff of measured-vs-committed, so the failure names
the wrong number rather than merely reporting disagreement.

**Mutation 2 — a genuinely new scheduling predicate.** The one the old census
could not have caught.

```
$ # add `AND pt.round <= 5` to promoteReadyTasks' statement
$ scripts/checks/check-r20-census.py                                   → exit 1
FAIL: R20 — a scheduling predicate reads `round` outside the legacy surface:
  - forge-control/src/db/projects.ts:855 in promoteReadyTasks(): unjustified
    `round` in a scheduling symbol — 'AND pt.round <= 5'. If this is legitimate,
    add it to ALLOWED_SCHEDULING_LINES with its justification; if it is a new
    predicate, R20 forbids it.
```

**Mutation 3 — a new symbol carrying `round`, with no attribution.**

```
$ # append `export function roundHelperAddedLater(round: number)` with a doc-comment
$ scripts/checks/check-r20-census.py                                   → exit 1
FAIL: symbols carrying `round` with no attribution — R20's gate is 'a
      justification for every surviving occurrence', so an unattributed symbol
      is the gate failing, not a formatting nit:
  - roundHelperAddedLater (3 hits)
```

**Mutation 4 — the attribution rule itself is altered.** This is the one the
first draft of the instrument did **not** catch, and finding that is the reason
the self-check has two halves. Make the default `tsdoc` rule behave like
`trailing`:

```
$ scripts/checks/check-r20-census.py --self-check                      → exit 1
SELF-CHECK FAILED at 27d300f (distribution): the attribution rule no longer
places rows where it did. The totals cannot see this, and `--write` would
launder it into the evidence document as a fresh measurement. Differences:
  - VerdictRoundRow: pinned (0, 3), measured None
  - bumpFixCycle:    pinned None,   measured (0, 3)
  - claimReadyTasks: pinned (1, 2), measured (1, 0)
  …
```

*"The totals cannot see this"* is measured, not asserted. Under mutation 4 the
banner still reads **`HITS 99 (108 case-insensitive), 44 code / 55 comment`** —
byte-identical to the clean run — while **36 rows** of the generated table move.
A self-check comparing only the four totals passed this mutation; that is why
the 19-symbol distribution is pinned as well. The red run was never the hazard,
since the stale-region check would catch the divergence anyway. The hazard was
`--write`: regenerate under a quietly altered rule and the document acquires a
fresh, wrong measurement with a green gate behind it.

**Mutation 5 — committing the gate.** Not a mutation of the code but of the
situation, and it caught a defect in the gate itself **before it shipped**. The
first draft of `render()` stamped the generated region with `git rev-parse
--short HEAD`. Committing the region moves HEAD, so a fresh render disagrees
immediately — the gate would have been red **on the very commit that created
it**, and on every commit after. Simulated by committing the candidate files in
the shadow clone:

```
$ git commit -qm "simulate committing the census region"    (HEAD → 25ae132)
$ scripts/checks/check-r20-census.py                                   → exit 1
FAIL: …/phase2-replay.md's R20 census is STALE …
-*Generated … at git `27737a9`, sha256 `e1b14c1f7a4dc8db…`.*
+*Generated … at git `25ae132`, sha256 `e1b14c1f7a4dc8db…`.*
```

The sha256 is identical on both sides: nothing about the measurement changed,
only the name of the tree. This is an **unsatisfiable gate** of exactly the kind
this project's standing rules forbid writing — the kind that teaches reviewers
to disclose and proceed. Fixed at the source rather than tolerated: the region
now names the **bytes** (`sha256`) and not the commit, which is invariant under
committing and is the identity that actually determines the census. `HEAD` and
the dirty flag are still printed on stdout, where they describe the run rather
than being frozen into a document as though they described the measurement. Re-
simulated after the fix, on a second clone:

```
$ git commit -qm "simulate the real commit"                 (HEAD → 9c2ab8f)
$ scripts/checks/check-r20-census.py                                   → exit 0
check-r20-census: REGION  …/phase2-replay.md matches the measurement  PASS
```

"A sha naming the worktree rather than the build" is already on this project's
record as a way an instrument lied. This was the same error in a new costume,
and the only reason it was caught is that the gate was tried under the
conditions it would actually run in, rather than only under the conditions that
would make it pass.

**One mutation that proved inert, reported because a mutation that cannot fail
proves nothing.** Removing the blank-line bond between a doc-comment and the
declaration under it changed *nothing* — no count, no row, exit 0. No
`round`-bearing comment block in this file is separated from its declaration by
a blank line, so the clause is currently unexercised. It is kept because the
next edit to the file may exercise it, but it is **not** evidence, and mutation
4 replaced it.

### 3.1 Round 208 — the same mutations, against the bytes that shipped; mutation 4 split by round 210

Added by fix cycle 3 to close §1's defect at the level it actually mattered: not
by correcting a digit, but by making every transcript in §3 answer to bytes that
exist. Clone `/tmp/r208/shadow`, `git clone --no-hardlinks`, `stat -c %h` = **1**
on all three probed files, regular files not symlinks, and the instrument's
sha256 asserted equal to the shipped `779d383f8b5fad34…` **before every
mutation** — printed each time, not assumed. Each mutation also asserts it
**LANDED** in the file afterwards (see the disclosure below for why that
post-condition is not decoration). Control at the shadow's own HEAD is green on
both entry points, `check exit=0` and `self-check exit=0`, and green **again**
after the last mutation was reverted.

| Mutation | Result against `779d383f…` | §3's claim |
|---|---|---|
| 1 — headline reverted to 85/92 | `exit 1`, `census is STALE`, unified diff naming `-**85` against `+**99` | holds |
| 2 — `AND pt.round <= 5` in `promoteReadyTasks` | `exit 1`, `FAIL: R20 … in promoteReadyTasks(): unjustified round` — **by name** | holds |
| 3 — `roundHelperAddedLater`, unattributed | `exit 1`, `symbols carrying round with no attribution — roundHelperAddedLater (3 hits)` | holds, count included |
| 4a — `census()`'s default `rule` parameter flipped, `"tsdoc"` → `"trailing"`, nothing else touched | `check exit=0`, stdout byte-for-byte identical to the control capture; `--write` finds nothing to change, **0 rows** move | split from §3's single mutation 4 — this half holds |
| 4b — the body: the `if rule == "trailing":` guard around the flush removed, so `tsdoc` takes that flush unconditionally | `check exit=1` — 2 newly-unattributed symbols (`DepsCorruption`, `RetryOutcome`) plus a stale-region failure; the region diff moves **36** rows, all of them table rows | split from §3's single mutation 4 — this half holds |

**§3's single "mutation 4" reported one run producing both halves at once. It
does not: check and `--write` derive the same render from the same census, so a
byte-identical banner requires the `REGION … PASS` line, which requires
render == committed region — which is exactly the condition under which
`--write` has nothing to move. Round 210 re-ran the two edits separately, in a
fresh `git clone --no-hardlinks` (`/tmp/r210/shadow`) against the same shipped
`779d383f8b5fad34…`, at that clone's HEAD `9b7f1b0`:**

- **4a, the default parameter alone.** Every call site that matters passes
  `rule` explicitly — `main()` via `args.rule`, whose own argparse default is
  `"tsdoc"`, independent of the function's — so flipping the function's default
  changes nothing `check-r20-census.py` can observe: stdout hashes identical to
  the control run, exit 0, `--write` is a no-op. (`--self-check`'s first
  `census()` call does *not* pass `rule` explicitly and so does pick up the new
  default, failing on the pinned 19-symbol distribution with the same
  mismatches 4b produces below — a real, separate finding about the two entry
  points' asymmetry, and no part of §3's claim, which was about `check` and
  `--write`.)
- **4b, the body.** This is the edit that actually changes attribution.
  `check-r20-census.py` goes red, and the region diff shows **36** changed
  table rows — reproducing §3's *"36 rows of the generated table move"* exactly,
  to the row. Total stdout is 60 lines against the control's 7: **53** lines
  longer. (§3, working from the lost draft, said 54; this re-run, against the
  bytes that shipped, measured 53 — disclosed rather than reconciled, per §1.)

Each number is real on its own, attributed to the mutation that actually
produces it; the conjunction — one run, both claims — was never true of either.

**One incidental delta, disclosed rather than smoothed over.** §3's mutation 2
transcript reads `projects.ts:855`; this re-run printed `:843`. Nothing moved in
`projects.ts` — the file is byte-identical at `27737a9` and `cf75f83`
(`e1b14c1f7a4dc8db…` at both). The number names **where the mutation was
inserted** inside `promoteReadyTasks`'s statement, and round 208 inserted the
predicate above `= cardinality(pt.depends_on)` where round 206 put it lower. Both
land inside the symbol, both are caught by name, and the line number is a
property of the mutation rather than of the tree — which is exactly why §6's
answer 3 pins it *to the mutated shadow* and not to a commit.

**A disclosure about this round's own instrument, because it nearly certified a
false finding.** The first attempt at mutation 4b (the body edit) used `sed`
with a 12-space indent against an anchor indented **8**. The substitution
silently matched nothing, the run came back green with the region unchanged,
and the natural reading of that green — *"§3's 36-row claim does not
reproduce; the gate misses mutation 4b"* — was a finding about to be written
up. What caught it was the `grep -n "MUTATION 4"` post-condition printing
**empty**: the mutation had never landed, so the green run was measuring
unmutated code. The guard that failed was
real but mis-aimed — it asserted the target substring **occurred once**, which it
did, while `sed` required an exact indented match, which it did not; assert-the-
target and assert-the-mutation-landed are different assertions and only the
second one closes this hole. Every mutation above therefore carries a landed
post-condition. This is the same shape as the round-207 census retraction: a
disagreement was checked for a benign explanation before being filed as a defect,
and standing rule 3 earned its keep against a three-hour-old instrument again.

---

## 4. §3 — why frozen rather than re-measured

Round 205 offered both and required consistency. Freezing is right for a reason
worth stating: **§3 is a transcript of a run, not a claim about the tree.** Its
banner reads `HEAD c54f860` because that is the commit the run happened at.
Re-measuring the four hashes while leaving the banner would manufacture a
transcript no run ever printed — the *"sha naming the worktree rather than the
build"* failure already on this project's record.

What was actually wrong was the **tense**, not the numbers. The section
presented a historical transcript as a live claim and instructed a reviewer to
run a check that *"prints `DIRTY (none — all three match HEAD)`"*. So:

- a freeze header names `27d300f`, says which three of the four hashes are
  superseded, and forwards to `phase2-fix-cycle-1.md` §1;
- that forward pointer omits `task-graph-replay.test.ts`, so the freeze header
  carries all four hashes measured at `27737a9`;
- the reviewer-check sentence is corrected.

**A correction to the finding's own reasoning, on that last point.** Round 205
implied the `DIRTY` promise was falsified by the stale hashes. It is not — the
harness still prints `DIRTY (none — all three match HEAD)` at `27737a9`, and
always will on a clean checkout, because `DIRTY` reports *uncommitted
modifications* and says nothing about whether the files match §3's table. The
two are independent. That independence is the real trap, and it is now stated
where the line is quoted: it is what let three stale hashes sit under a green
banner for two commits. The finding's remedy was right; its mechanism was not.

---

## 5. No engine change — structural, not promised

```
$ git diff --stat 27737a9..HEAD -- forge-control/src/db/projects.ts \
      forge-control/src/lib/task-graph.ts forge-control/src/lib/task-graph.test.ts \
      forge-control/src/lib/task-graph-replay.test.ts forge-control/src/lib/project-tick.ts \
      forge-control/src/lib/project-reconcile.ts forge-control/src/lib/project-reconcile.test.ts \
      forge-control/src/lib/cp2-reconciler-interaction.test.ts
                                                            ← EMPTY
```

R21 and R43 hold structurally. `check-scheduler-sql.sh` is untouched, so fix
cycle 1's ten cases stand as that document reports them.

---

## 6. §4's three questions

**1. What would have made my instruments report a pass wrongly?**

(a) *A shadow tree silently testing HEAD.* The clone is `--no-hardlinks`,
`ls -la` shows regular files, `sha256sum` matched the worktree's bytes before
each mutation, the control run was green on both entry points, and every
mutation **turned red** — which a tree reading unmutated code cannot do. Each
mutation asserted `count(pattern) == 1` and aborted otherwise.

(b) *An attribution rule tuned until it agreed with the numbers it was asked to
produce.* Closed three ways, and the third was found by attacking the first two:
calibration at `27d300f` against a hand count the rule was not shown; **whole-
table reproduction** under `--rule trailing`, which is the stronger check
because the totals are *invariant* under the attribution rule and agreeing on
them proves less than it appears to; and the pinned distribution of mutation 4.

(c) *A generated region that agrees because it was generated.* This is the
honest residual risk of the whole approach, and it is why the check asserts
**R20 itself** (mutation 2) rather than only regenerating a census. A census
that merely counts cannot fail for the reason the requirement exists.

**2. Which gate did I find unsatisfiable?** The R20 gate itself, and it is
amended in this commit where it is enforced — `03-quality.md` §3.2 Phase 2 and
`01-requirements.md` R20's *How proved* — rather than disclosed and worked
around. A gate discharged by a hand-written census, in a file where every fix
cycle adds `round`-bearing citations, is one no cycle can leave satisfied; round
205 caught it stale, and it had been stale through round 204 as well. Standing
rules 2 and 4: the old clause is struck and quoted in the replacement, not left
beside it.

**3. Every citation** is by symbol or requirement id. The four `sha256` values
and the mutation line number `projects.ts:855` are pinned to `27737a9` and to
the mutated shadow respectively, both named beside the number.

---

## 7. The retraction — this cycle nearly filed a false finding

Recorded at length because it is the most useful thing in this document.

Re-measuring §7 under the new script made it appear that the round-202
per-symbol table had never been a measurement at all.
`sweepDanglingDependencies` was credited with *"seven hits, all of them
comments"*; the script measured **zero**, at HEAD and at `27d300f` alike. Four
further groups were off by 2 to 4, while the rows summed to the correct
headline — the signature of numbers reconciled to a total rather than counted.
The conclusion *"§7's distribution was never a measurement at any commit"* was
drafted into `phase2-replay.md` §7 and into §7.3, in those words.

**It was wrong.** The round-202 author was attributing a free-standing comment
block to the declaration **above** it; the script attributes it to the
declaration **below**, the TSDoc convention. Implementing the author's
convention as `--rule trailing` reproduces their table **exactly** — all eight
§7.4 groups, §7.2's ORDER BY, and the sweep's seven:

```
$ scripts/checks/check-r20-census.py --self-check
self-check OK — at 27d300f the tsdoc rule reproduces the round-202 totals
(85 hits, 92 case-insensitive, 41 code / 44 comment) and its pinned 19-symbol
distribution is unchanged; the trailing rule reproduces all 10 rows of the
round-202 hand table — that table was a measurement under a different
convention, not an invention
```

The seven lines are `promoteReadyTasks`'s doc-comment, the block between the
sweep and that declaration — booked to the sweep by the trailing rule, to
`promoteReadyTasks` by TSDoc. It is also why round-202 §7.1 counted promote as
**2**: its two predicate lines, its doc-comment's seven booked one symbol
earlier. Entirely self-consistent.

Three things follow, and they are the point:

1. **The accusation is retracted in the document that carried it.**
   `phase2-replay.md` §7's correction notice states what was drafted and why it
   was wrong; §7.3 is *restated*, not corrected, and says the seven are right
   under the convention that author used.
2. **The reproduction is an assertion, not a paragraph.** `ROUND202_TABLE` in
   the script pins all ten rows. A future round cannot repeat this accusation
   without the self-check contradicting it first.
3. **The convention change is declared as a change of presentation.** R20's
   conclusion is invariant under it — no scheduling predicate reads `round`
   either way — so §7 says so explicitly rather than letting a renumbered table
   imply a finding.

The standing rule says instruments lie before code does. Here the instrument
was a fresh one, three hours old, and it was about to put a false accusation of
fabrication into the corpus against a previous round's author. What caught it
was checking whether a *disagreement* had a benign explanation before writing
it up as a defect — which is the same discipline as asking what would make a
pass report wrongly, pointed at a failure instead.
