# Phase 5, fix cycle 1 — the record, written late

**Round 242 did the work; round 244 is writing the record.** That gap is the
subject of §4 and is not glossed over: three rounds of reviewers read a corpus
that still quoted constants round 242 had moved, and one sentence that stated
the direction of its own change backwards.

Round 242's phase-5 task: commit
**`f135de41362d85b7f3b682b42535eb542c2a8ebe`**, on reviewed tip
`fe14a7ebf0a48b46bc46fe1797f96f07d1ff5504` (phase 5B, round 240). Its declared
write-set was `forge-control/src/lib/project-tick.ts` and
`forge-control/src/lib/project-tick.test.ts` — **two code files and no
document**, which is exactly why the corpus was left behind. Round 244's
corrections are §3 and §5.

---

## 1. Round 241's three findings, and where each was answered

| # | Finding | Answered in |
|---|---|---|
| 1 | The **non-goal** architect branch of `buildPrompt()` still told an architect to put the reviewer "in the round right after your last builder round" — a sentence R53 falsified — and never interpolated `GRAPH_GUIDE`, so it handed three unexplained fields and one dead instruction | `project-tick.ts`, both architect branches; asserted in `project-tick.test.ts` under *"round 242 finding 1"* |
| 2 | `maximalPlannerPrompt()` measured NF7 at `id: "p1"`, a shape no real project has, under a comment calling it *"the only measurement NF7's budget is meaningful against"* | The NF7 block, re-derived; `MAXIMAL_PROJECT_ID` + a fifth maximality control |
| 3 | `GRAPH_GUIDE`'s FAN-OUT sentence named no research role literal, so the cheapest parallelism the guide sells required inventing a role string and recovering from the `400` that enumerates `ROLES` | `GRAPH_GUIDE`; gate asserts both literals are real `ROLES` entries |

Finding 1's blast radius is worth restating because it is the one that would
have shipped: `mode` is **optional** on `POST /api/projects`, so the non-goal
branch is every project not created with `"mode":"goal"`. An architect
resolving that contradiction by dropping `depends_on` gets the legacy `NULL`
sentinel, a round computing to 0, and a reviewer promoting in the same tick as
the builders it exists to join — the join silently stops being a join.

---

## 2. The three declared in-place exceptions

`project-tick.test.ts` is append-only by convention. Round 242 amended three
things in place, all inside the NF7 block, none a deletion and none a weakening:

1. **`BASELINE` 9187 → 9221** — §3.
2. **`maximalPlannerPrompt()` gains `id: MAXIMAL_PROJECT_ID`** and a control
   that fails if the fixture id ever stops being uuid-shaped. Without it,
   shortening the id would silently loosen the cap by exactly the characters
   removed.
3. **The 5B headroom case → THE ROUND LEDGER.** The old shape compared a *live*
   headroom against a pin at 5A, so `consumed` was every character added since
   5A **by anyone**. Round 242's own 26 would have been charged to 5B's
   reservation and passed at `502 <= 600`, reporting a 5B underspend that never
   happened. Replaced by an exact attribution — `5A tip + every ledgered spend`
   must **equal** the live measurement. Strictly stronger: the old case bounded
   a sum, this one admits no unledgered character at all.

---

## 3. The NF7 re-derivation, and which way it actually moved the gate

`taskCurl()` renders the project id **verbatim and exactly once**. A uuid is 36
characters, `"p1"` is 2, so every NF7 measurement taken at the old fixture
understated the real maximal path by a flat **34**.

Re-derived over three trees exported with `git archive` — node_modules
symlinked, **no source symlinked** — each measured by a harness printing its own
`sha256(project-tick.ts)` and refusing to report unless the module's
`GRAPH_GUIDE` export matches what that sha must have:

| sha | sha256 | exports `GRAPH_GUIDE` | id `"p1"` | id uuid |
|---|---|---|---|---|
| `d9858b9` | `b10ddc0190bd280e` | **false** ← control | 9187 | **9221** |
| `05f2842` | `00bcdeae5cfbd555` | true | 11585 | **11619** |
| `fe14a7e` | `c4141f17fde418ef` | true | 12061 | **12095** |

Three distinct digests, and the pre-5A tree provably not `HEAD` because it
**fails** the export control — the shadow-tree trap excluded rather than
asserted away. The `"p1"` column reproduces round 240's three numbers exactly,
which is that baseline confirmed independently a second time.

### The live pins

| | |
|---|---|
| `BASELINE` (at `d9858b9`, maximal path, uuid fixture) | **9221** |
| `BUDGET` (the operator's ruling, untouched) | **3050** |
| cap | **12271** |
| measured after round 242 | **12121** |
| headroom | **150** |

### The direction — corrected at round 244

Round 242 wrote, in its commit message and twice in `project-tick.test.ts`,
that the correction **"TIGHTENS the cap by 34"**. That is backwards twice over,
and the commit message cannot be amended, so the correction lives here and in
the code:

- **The cap RISES**, 12237 → 12271. `cap = BASELINE + BUDGET`, and the baseline
  went up.
- **A rising cap read alone is a WIDENING** — the one direction
  `00-vision.md` §7 rule 2 does not license. It does not get to pass as a
  tightening by assertion; it needs the argument below.
- **The gate's tightness did not change at all.** The same +34 lands on the
  baseline *and* on every measurement taken at that fixture. Headroom is
  identical at every pin: **652** at 5A, **176** after 5B, **150** live.
  `BUDGET` — the whole of what this gate permits — is untouched at 3050. Not one
  character of allowance was bought. What moved is the **frame**, from a fixture
  no real project has to one shaped like every real project.

Contrast, so the word is not carried across by a future reader: **round 240's
correction genuinely tightened.** Its measurement stood still while the cap fell
12329 → 12237, so the headroom *shrank* by 92 and fewer characters are permitted
after it than before. Same block, opposite direction, and the two were being
described with the same verb.

### Re-measured at round 244

Both frames, at the tree this record is committed in, by a harness that prints
its own build identity and refuses to report a number unless the module exports
`GRAPH_GUIDE`:

```
sha256(project-tick.ts) = 01d79c140baf3500      (before round 244's edits)
measured at id "p1"   (2 chars)  = 12087
measured at id uuid   (36 chars) = 12121
delta                            = 34
occurrences of the id in the prompt = 1
round 240 frame (p1):   baseline 9187  cap 12237  measured 12087  headroom 150
round 242 frame (uuid): baseline 9221  cap 12271  measured 12121  headroom 150

sha256(project-tick.ts) = 7622e1fc0c07e342      (after round 244's doc-comment edit)
... all four numbers identical ...
```

Two things fall out that are worth more than the direction fix:

1. **The `occurrences = 1` line is what makes the flat +34 an explanation
   rather than a coincidence.** 36 − 2, once. Round 242 asserted the flatness
   across three shas but never showed *why* it was flat.
2. **Running it at two digests is the positive control for this block's oldest
   unmeasured claim** — that reasoning lives in doc-comments *because they cost
   the prompt nothing*. Round 244 rewrote a doc-comment in `project-tick.ts`,
   the digest moved, and all four numbers held. That claim had been asserted
   since phase 5A and never once measured.

It also fixes the honest limit of a sha pin: this digest names the module a
number came off, and it **moves whenever a comment moves**. A reader whose tree
does not match should re-derive, not distrust the number.

---

## 4. Why the corpus was left behind — the actual mechanism

Round 242's write-set was two code files. `01-requirements.md` §J and
`evidence/phase5-prompts.md` §4.3 quote the same constants and were owned by
nobody in that round. Neither document is *wrong about what its own round
measured*; both had simply stopped describing the enforced gate.

That is the rot class standing rule 1 names — **a pin that no longer reads as
stale but as authoritative** — and it survived three consecutive reviews,
because a stale number in a document looks exactly like a fresh one. Round 243's
reviewer caught it and it took two fix cycles to close, which is the price of a
write-set that covers the code but not the sentences quoting it.

**Treatment: supersede, never rewrite.** An evidence record states what a round
measured, at the moment it measured it. §4.3 and §4.4 of `phase5-prompts.md`
keep round 240's numbers exactly as round 240 wrote them, under a banner naming
the frame and pointing here. §4.4's *"tightens"* is **left standing** — it is
correct for round 240 — with a note forbidding its transfer to round 242's
change.

---

## 5. What round 244 changed

| File | Change |
|---|---|
| `forge-control/src/lib/project-tick.test.ts` | NF7 block: *"the cap tightens by 34"* → *"the cap **RISES** by 34"*, plus the argument for why tightness is unchanged, the round-240 contrast, and the two-digest measurement. Exceptions list: *"TIGHTENS the cap by 34"* → *"RAISES the cap by 34 and changes the gate's tightness by NOTHING"*, naming the error it replaces |
| `forge-control/src/lib/project-tick.ts` | `GRAPH_GUIDE`'s cost restated in the frame the ledger and cap are written in: `12061 -> 12087` → `12095 -> 12121`. **The 26 is unchanged** — only the units are. Both numbers were the `"p1"` frame |
| `docs/plan/engine-task-graph/01-requirements.md` | §J NF7: live uuid-frame pins added above the round-240 ones (kept as history); the budget trail now carries round 242's 26, `176 → 150`; the direction stated correctly |
| `docs/plan/engine-task-graph/evidence/phase5-prompts.md` | §4.3 superseded-frame banner + column relabel; §4.4 frame note fencing *"tightens"* to round 240; §4.7 pointer to §J's new pins |
| `docs/plan/engine-task-graph/evidence/phase5-fix-cycle-1.md` | This record |
| `docs/plan/engine-task-graph/04-phases.md` | Phase 5's "Files this phase writes" block gains round 242's and round 244's write-sets, per the convention phase 2 sets for both of its fix cycles — including this record and that list itself |

The last row is the finding applied to itself. Phase 5's file block had never
been amended, so **neither round 242's record nor this one was reachable from
the corpus** — an evidence record nobody points to is the same defect as a
constant nobody updates. Phase 2 registers both of its fix cycles this way;
phase 5 now does too, and 04-phases.md carries the rule in one sentence where
the next planner writing a write-set will read it.

**No test was deleted, weakened, or modified.** Round 244 changed comments,
documents, and one restated measurement frame — no assertion, constant, or
prompt string moved. The prompt is byte-identical: the measurement is 12121
before and after, which is §3's second control saying so.

---

## 6. Verification, run at the tip this record is committed in

```
$ cd forge-control && npx tsc --noEmit          ; echo $?
0

$ npx tsx --test src/lib/*.test.ts
# tests 1175   # suites 217   # pass 1175   # fail 0   # cancelled 0   # skipped 0

$ npx tsx /tmp/nf7-direction-probe.ts           # §3, both frames, build identity printed
```

The NF7 cases that would catch a mistake here are `G5` (measured ≤ cap), *"every
character spent since the 5A tip is attributed to a round that declared it"*
(exact equality against the ledger), and *"no round spent more of the prompt
budget than its brief reserved"*. All three pass, and the ledger case is the one
that would have gone red had round 244's comment edits touched the prompt — it
admits no unledgered character, so a doc-comment that accidentally landed inside
a template literal fails with its own size in the message.

---

## 7. Findings

**F-G — `phase4-workstreams.md` records the same spend as 23 characters, not
26, against a measurement of 12084.** Reported, not edited. That section states
its number as a live worktree measurement taken while round 242's commit was
landing in the **shared** worktree, and correctly attributes the difference to
`f135de4`; it is honest about its own moment. But `GRAPH_GUIDE`'s source is
**byte-identical at `f135de4` and `7af2968`** (1976 characters both, verified by
`git show`), and the settled cost is **26** at a final `"p1"`-frame measurement
of **12087** — so 12084/23 was taken mid-edit and is now 3 characters short in a
frame that is itself superseded. Rewriting another round's measurement record is
the one thing supersession exists to avoid, and it is outside this task's
write-set. **The next task touching phase 4's record should append a supersession
note**; the authoritative ledger is NF7's, which is enforced by an equality
assertion rather than by prose.

**No unresolvable citation.** Every pin this task was given resolved:
`project-tick.test.ts:2354` and `:2943` (both inverted sentences, found where
named), `01-requirements.md:1395` and `:1400-1401` (the budget trail and the
superseded pins), `phase5-prompts.md` §4.3, and the missing round-242 record —
this file. The one pin the *corpus* carried that did not resolve cleanly is F-G
above, reported rather than quietly reinterpreted.
