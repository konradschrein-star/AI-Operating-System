# Round 217 — fix cycle 2: round 216's three findings, closed

Round 216 re-reviewed fix cycle 1 (`34268e9`) and returned `NEEDS_FIXES` with
three findings: one MEDIUM regression that the fix cycle itself introduced, one
LOW prose defect in the document phase 8 executes literally, and one advisory.
All three are addressed below, with what was run beside each.

**Base commit:** `34268e9`. **Live checkout `/opt/forge-ai-os`:** never touched;
`git -C /opt/forge-ai-os status --porcelain` empty, exit 0, before and after.
**Databases:** none. Every run in this document is fixture-mode or a pure unit
test — `measure-schedule.ts` opens no database without `--project`, and none of
these invocations passes it.

---

## Finding 1 — the instrument's identity moved and five places still named the old one

**MEDIUM, and a regression fix cycle 1 introduced.** SEVERITY accepted as stated.

### The measurement, re-derived independently before fixing anything

*Transcript, unannotated by design — it names the retired
`[historical instrument]` identity because that is what the command printed.*

```
$ for c in b1bb731 f2dd780 99cb121 34268e9; do
    printf "%s " $c; git show $c:scripts/measure-schedule.ts | sha256sum; done
b1bb731 80ef11235ffe3e2cc12dd58404533070d4b7575a050ff96d44acf49226ef6afb  -
f2dd780 80ef11235ffe3e2cc12dd58404533070d4b7575a050ff96d44acf49226ef6afb  -
99cb121 80ef11235ffe3e2cc12dd58404533070d4b7575a050ff96d44acf49226ef6afb  -
34268e9 f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2  -
```

Round 215's edits to `renderCensus()` and `printFull()` moved the identity at
`34268e9`. Thirteen places in the corpus still named the retired value, and one
of them — `evidence/baseline-8ea0cc08.md` §5(3) — presents a `sha256sum` of it as
an **independent re-derivation**, i.e. the document's own proof that it does not
quote dead identities had itself become one.

### The ruling: option (a), and why

Round 216 offered (a) re-run part 1 under the current instrument, or (b) keep the
transcripts as history and amend. **Round 217 took (a), and folded (b)'s
disclosure into it.** The reason (a) was affordable is that all seven of part 1's
commands are `--fixture` runs: no database, no live read, deterministic, and
runnable from a build task under the worktree-only policy. Taking (a) alone would
have left the drift invisible; taking (b) alone would have left a document whose
central command still disagrees with the disk. So: the transcripts were re-run
**and** the move is recorded, in a new "Re-run record" section in §1 of that file.

### What was re-run, and what moved

All seven commands of §1's table, verbatim, from the worktree at `34268e9`:

```
A exit=0   B exit=0   C exit=1   D exit=0   E exit=0   F exit=0   G exit=0
```

Exit codes unchanged (0 ×6, **1** for C). Every round/task table and run C's
refusal text reproduce **byte for byte**. Verified by string containment against
the pasted blocks — first against the document as `34268e9` left it, and again
after all edits:

```
run A: header verbatim=True  body verbatim=True
run B: header verbatim=True  body verbatim=True
run C: header verbatim=True  body verbatim=True
run D: header verbatim=True  body verbatim=True
run E: header verbatim=True  body verbatim=True
run F: header verbatim=True  body verbatim=True
run G: header verbatim=True  body verbatim=True
ALL SEVEN PARTS VERBATIM: True
```

Exactly three header fields changed, all three identity rather than measurement:
`instrument-sha256` (`80ef1123…` `[historical instrument]` → `f6828a68…`),
`git-head` (`b1bb731…` →
`34268e9…`), and the census line gaining `closure-shaped-rows=0`. **No number in
that document moved.** The per-run census task counts — 131 / 23 / 131 / 123 / 8
/ 29 / 108 — are identical to the pasted ones.

### The durable half: a gate, because four repairs by memory have now failed

`docs/plan/engine-task-graph/check-instrument-identity.py` — new, and wired into
`03-quality.md` §3.1 as **item 7 of the universal gate** rather than into a
phase-7 gate, because round 215 moved the instrument *from a phase-3 fix cycle*.
It asserts two things and refuses to certify itself:

1. Every `instrument-sha256:` header pasted anywhere in the corpus equals
   `sha256sum scripts/measure-schedule.ts` **on disk**.
2. No sha the script's bytes have *had* and no longer have appears anywhere in
   the corpus without the literal marker `[historical instrument]` on that line.
   Both the full 64-character form and the `80ef1123…` `[historical instrument]`
   prefix form are matched — that clause is its own example. A pasted
   transcript, which cannot carry an inline marker without ceasing to be a
   transcript, is exempted by a marked prose line within three lines above its
   opening fence. The historical set is derived from
   `git log -- scripts/measure-schedule.ts`, not from a hardcoded list.

**Positive controls, checked before the verdict** (`00-vision.md` §7 rule 2): it
fails if it found fewer than 8 pasted headers, if it read none from
`evidence/baseline-8ea0cc08.md`, or if it swept fewer than 5 markdown files. A
regex that stops matching because the header format changed is a FAILURE here,
not a clean run.

**Watched failing three ways.** First, against the corpus exactly as `34268e9`
left it — it reproduces round 216's finding 1 independently, all thirteen sites.
*Transcript, unannotated by design; the `[historical instrument]` value below is
what the gate printed.*

```
FAILED — 13 disagreement(s):
  evidence/baseline-8ea0cc08.md:45: pasted header names 80ef1123… but scripts/measure-schedule.ts on disk is f6828a68…
  … (7 more headers) …
  00-vision.md:76: names the retired identity 80ef1123… without the marker '[historical instrument]'
  00-vision.md:83: …
  evidence/baseline-8ea0cc08.md:793: …
  evidence/baseline-8ea0cc08.md:797: …
  evidence/baseline-8ea0cc08.md:871: …
EXIT=1
```

Second, on its own author: it failed the fixed corpus at `04-phases.md:846`
because a marker had wrapped onto the following line and the check is
line-based. That was a real defect in my prose, found by the gate and not by me.

Third, and this is the one that matters — **the instrument was moved and the
gate caught the future occurrence of exactly this finding**:

```
$ printf '\n// round 217 mutation probe\n' >> scripts/measure-schedule.ts
mutated sha: b24a0e31e0ea0127…
  evidence/baseline-8ea0cc08.md:91:  pasted header names f6828a68… but … on disk is b24a0e31…   [historical instrument]
  … all 8 headers …
  00-vision.md:76:       names the retired identity f6828a68… without the marker   [historical instrument]
  01-requirements.md:876: …
  evidence/baseline-8ea0cc08.md:849, :853, :937: …
MUTATED_EXIT=1
```

Restored immediately; `sha256sum` back to `f6828a68…` and `git status` clean.   [historical instrument]

Had this gate existed in round 215, the finding would have surfaced in the commit
that caused it instead of two rounds later.

### The escape hatch, and the probe that bounds it

Check 2's fence exemption is the one place this gate can be *turned off*, so its
scope was measured rather than asserted. **A marked fence exempts prose mentions
inside it and nothing else — check 1 still reads every pasted header in it.**
Probed by appending a marked fence containing a stale
`instrument-sha256: 80ef1123…` `[historical instrument]` header to this very
file. *Transcript, unannotated by design:*

```
FAILED — 1 disagreement(s):
  evidence/fix-cycle-2.md:301: pasted header names 80ef1123… but … on disk is f6828a68…
PROBE_EXIT=1
```

The probe was removed and the gate returned to exit 0. So the escape hatch buys
an honest transcript and cannot buy a stale baseline — which is the only thing
this checker exists to prevent.

### Documents amended, all in this commit

| file | what |
|---|---|
| `evidence/baseline-8ea0cc08.md` | 8 headers re-run; new §1 "Re-run record"; §1 closing note; §5(3) rewritten around the current value and the fourth identity failure named as this document; §7 ledger rows for `f6828a68…`, `34268e9…` and the marked `80ef1123…` `[historical instrument]` |
| `00-vision.md` §2.2 | heading and body now name `f6828a68…`, with a parenthetical recording the move and that every number below reproduced |   [historical instrument]
| `04-phases.md` §12 (E-3) | the *"the two headers name the same `instrument-sha256`"* sentence retired and replaced with a statement a living instrument can keep, plus phase 8's concrete pre-append obligation |
| `01-requirements.md` R62 | *How proved* replaced — the old wording was satisfiable by a file naming a SHA the script no longer had, and for two rounds it was |
| `03-quality.md` §3.1 item 7, §3.2 phase-8 gate, §4 block | where the checker is enforced |

R62's *How proved* is **replaced, not supplemented**, and standing rule 4 is
discharged in this commit: it is retired together with the checker that takes
over its job and the §3.1 clause that runs it.

---

## Finding 2 — step 2b implies S3 is a readable number before the migration

**LOW.** Confirmed exactly as reported, and confirmed in code rather than by
reading the prose back.

**The mechanism.** At step 2b migration 0040 has not run, so `project_tasks` has
no `depends_on` column. `readProjectRows()` queries `information_schema`, sets
`hasDependsOnColumn = false`; `taskRow()` then leaves the key **absent** rather
than null; every row reaches `isLegacyRow()` as `undefined`, which is D7's first
sentinel; the first arm refuses. Step 2b prints
`S3 … NOT COMPUTABLE (131 legacy rows, 0 closure-shaped rows)`, never a number.

**The ordering survives, on the correct ground.** What 2b buys is not a number,
it is (i) the **honest reason** — before the migration the refusal names the
legacy sentinel, which is true and permanent; after it, `legacy-rows` reads 0 and
the only remaining ground is `isClosureShaped()`, which this corpus itself calls
a *signature, not a proof* — and (ii) S1, S2, run count, mean duration and wall
clock, which are the numbers R62's part 2 actually owes and which the migration
does not touch.

**Pinned in code, not in prose.** New section 7c of
`forge-control/src/lib/schedule-metrics.test.ts`,
`describe("D7 — the pre-0040 read at step 2b refuses on the legacy sentinel")`.
It feeds 7b's literal motivating case — one 32-minute reviewer, seven builders
numbered above it — through the **real** `taskRow()` with
`hasDependsOnColumn = false`, so the pre-migration shape is produced by the
function phase 8's live read runs through rather than hand-asserted. Five tests:
the key is absent (not null); S3 refuses; the refusal is the **first** arm
(`legacyRows` 8, `closureRows` 0, reason matches `/never recorded/` and **not**
`/strictly lower round/`); the census discloses the same; and the same project
after a hand-applied backfill refuses for the weaker reason with `legacyRows` 0.

**Watched red, twice, both restored:**

```
# mutation 1 — isLegacyRow() stops treating `undefined` (absent column) as the sentinel
    not ok 3 - an absent depends_on column (pre-0040 schema) refuses identically
    not ok 3 - the refusal is D7's FIRST arm — the sentinel, not the closure signature
    not ok 4 - the census header phase 8 pastes discloses the same thing
# tests 44  # pass 41  # fail 3

# mutation 2 — taskRow() fabricates `depends_on: []` for a pre-0040 row
    not ok 1 - taskRow leaves the key ABSENT, not null — the two say different things
    not ok 3 - the refusal is D7's FIRST arm — …
    not ok 4 - the census header phase 8 pastes discloses the same thing
    not ok 2 - on a pre-0040 schema `depends_on` is ABSENT, not null — E2's distinction
# tests 67  # pass 63  # fail 4
```

**One test stayed green under both, deliberately, and it says so in the file.**
`"S3 is NOT COMPUTABLE at step 2b — a refusal, never a number"` survives both
mutations because each only downgrades the refusal to "no edge to measure". That
robustness *is* the finding — no reachable defect turns step 2b into a number —
and the comment above the test records it so a later reviewer does not file it as
a vacuous assertion.

**An unsatisfiable gate found and amended where it is enforced.** `03-quality.md`
§3.2's phase-8 clause said a `NOT COMPUTABLE` S3 meant the detector had caught a
late read — *"a finding and a redo, not a pass"*. Under finding 2's mechanism
that clause **fails a correct deploy**, since the correct pre-migration read is
also NOT COMPUTABLE. It is amended in this commit to judge the refusal by its
counts: `(131 legacy, 0 closure-shaped)` passes; `(0 legacy, N closure-shaped)`
is the redo; and **any S3 number at all for 8ea0cc08** is the worst outcome,
because the only shape that produces one is the backfilled closure computing
tautologically to 0. Standing rule 2 satisfied — amended where enforced, in the
same commit, with the reasoning inline.

---

## Finding 3 — the NUL survives in git history

**Advisory, no action required.** Recorded at `evidence/phase3-fix-1.md` §2b, and
re-measured rather than repeated:

| command | NUL bytes | note |
|---|---|---|
| `git show 34268e9` | 1 | offset 113463 — the *removed* line, as reported |
| `git log -p main..HEAD` | 2 | the same line added and then removed |
| `git diff main...HEAD` | **0** | the form `03-quality.md` §3.1 and §4 use |
| working tree | **0** | `source-hygiene.test.ts`'s two arms |

**An instrument lied while measuring this, and it is worth recording.** The first
attempt used `grep -c $'\x00'`, which reported 2351 / 27644 / 22653 — thousands
of "hits" in a clean diff. Bash strips the NUL from `$'\x00'`, leaving an
**empty pattern that matches every line**. The table above counts bytes in Python
instead. This is the round's own small instance of `00-vision.md` §7 rule 2, and
the correct command is written into `phase3-fix-1.md` §2b so the next reviewer
does not repeat it.

---

## Gate run, at HEAD of this commit

Every instrument identity in the block below is retired: `[historical instrument]`
(round 802 and then round 811 each moved it; this is the value that ran here.)

```
$ cd forge-control && npx tsc --noEmit                     → exit 0, no diagnostics
$ npx tsx --test src/lib/*.test.ts
    # tests 1009  # suites 184  # pass 1009
    # fail 0  # cancelled 0  # skipped 0  # todo 0         → exit 0   (was 1004/183)
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
    R1..R69 and NF1..NF7 complete, all three statements agree; phases 1–8 "agree"
                                                            → exit 0
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
    instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
    OK — 8 pasted header(s) name f6828a68…   [historical instrument]
    OK — no retired identity quoted without '[historical instrument]'
                                                            → exit 0
$ git -C /opt/forge-ai-os status --porcelain                → EMPTY, exit 0
```

`project-reconcile.test.ts` passes **unmodified** — this round changed no
consolidation code and no consolidation test. The +5 tests are section 7c.

---

## What would have made *my* instruments report a pass wrongly

1. **Re-running the seven commands and matching only the numbers** — the exact
   trap round 216 named. Closed by checking the pasted blocks with string
   containment rather than by eye, in both directions (the old document before
   editing, the new one after), and by re-deriving the SHA from git for four
   commits rather than trusting the review's quotation of it.
2. **The new gate passing because it checked nothing.** A `rglob` that matches
   nothing, or a header regex that silently stops matching, would report `OK` on
   an empty sweep. Closed structurally by the positive controls, and behaviourally
   by the three watched failures — including one against the *unfixed* corpus,
   where it independently reproduced all thirteen sites of finding 1.
3. **Trusting `grep` to count a NUL.** It did not; see finding 3. Caught because
   a clean `git diff` reporting 22653 hits is not a number one accepts.

The one thing I could not close from a build task: **nothing here was run against
the live database or the live executor**, by policy. Step 2b's actual output
against 8ea0cc08 is phase 8's to observe. What is proved here is what the modules
do when handed the pre-0040 shape, produced by the real narrowing function.
