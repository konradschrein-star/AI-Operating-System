# write-set ledger — aios-sidebar-live-sessions

Every file this project's tasks wrote that their `write_set` did not declare, and every
file a task declared and did not write. Written in round 5 (fix cycle 1) against round-4
review finding 2.

**Nothing here amends a `done` task row, and nothing here should.** `write_set` records
what a task *declared*; the commit records what it *wrote*, and the gap between them is
the only signal that a collision happened — collapsing the two deletes the evidence
(operator ruling, `AI OS/Operator Decisions.md`, *"A ledger you may edit after the fact
stops being evidence"*). The rule is **disclose, not abstain, and never retro-edit**.
This file is that disclosure.

---

## Round 4 / T4 (client) — commit `2b4b3eb`

Declared: the six `forge-control-web/app/desktop/team/*` files. Wrote those, plus:

| File | Why it had to change | Correct? |
|---|---|---|
| `scripts/checks/gates-808.sh` (+7) | Registers the new `check-live-sessions.ts` as gate 18. Leaving it unregistered would have shipped a checker that **proves it compiles and nothing else** — the exact failure the fleet has written down twice (`checks-dir-is-compiled-not-executed.md`: 41 of 74 artefacts invoked by nothing). | Yes |
| `scripts/checks/check-dismiss-peek.tsx` (+20/−2) | **A regression this project caused in another project's gate.** The slicer anchored on the first *mention* of `data-team-restore-all`, which occurs earlier inside a `closest()` selector string; adding one self-closing JSX tag above the footer moved the scan 5.3 kB short and turned two assertions red with nothing wrong in the code they measure. The fix anchors on the JSX-attribute shape (`\s<name>(?=[=\s>])`). | Yes |

`gates-808.sh` **governs every project in this repo**, so this is a cross-project write and
is flagged as such rather than filed as routine. Both edits reviewed clean in round 4.

## Round 4 / T2 (before-evidence) — commit `0e930af`

Declared `evidence/aios-sidebar-live-sessions/before.md`; also wrote
`docs/research/round-0-e4e503ab.md`. That path is the research harness's own pointer
convention — structural rather than drift — but it is still undeclared, and is recorded
here so the next reader does not have to re-derive that.

## Round 0 (activity measurement) — a declared write that never landed

Task *"Measure the activity-column blank rate on live runs"* finished `done` declaring
`evidence/aios-sidebar-live-sessions/activity-truth.md`. **The file existed in no commit
on any branch.** Its measurement was the entire justification for the `run-rollup.ts`
change in `3e63a45`, quoted in three source files.

`done` does not verify a declared write-set (`done-never-verifies-the-declared-write-set.md`),
so nothing caught it. Round 5 landed the document — **re-derived from scratch, not quoted
from the missing one** — and corrected all three citations. See `activity-truth.md`.

## Round 5 (this task, fix cycle 1) — the row is unsatisfiable as written

The fix-cycle row was seeded carrying the **reviewer's** `write_set`,
`evidence/aios-sidebar-live-sessions/review.md` — the reviewer's own verdict file, which a
builder must not touch, and the only path the row declares. **Every write below is
therefore undeclared by construction.** A fix-cycle row inherits its parent's declaration;
the honest move is to disclose loudly rather than to bend the work to fit the ledger.

| File | Finding | Why |
|---|---|---|
| `forge-control/src/lib/run-rollup.test.ts` | 5 | new — the coverage the finding demands, 9 tests |
| `forge-control/src/lib/run-rollup.ts` | 5, 3 | `_snapshotForTests` (`pendingTools` is otherwise observable only through a Postgres flush) + the corrected 60.8% citation |
| `forge-control/scripts/replay-activity.mts` | 3 | new — the read-only instrument behind `activity-truth.md`, so the number can be re-run |
| `evidence/aios-sidebar-live-sessions/activity-truth.md` | 3 | new — the artefact round 0 declared and never wrote |
| `forge-control-web/app/desktop/team/liveSessions.ts` | 3 | citation corrected to a source that exists |
| `forge-control-web/app/desktop/team/LiveSessionsStrip.tsx` | 3 | ditto, for the 68.4% staleness figure |
| `evidence/aios-sidebar-live-sessions/after.md` | 4 | ten broken screenshot citations corrected |
| `evidence/aios-sidebar-live-sessions/live-checkout-dirt-2026-08-25.patch` | 1 | new — the preservation backup of the live checkout's sole copies |
| `evidence/aios-sidebar-live-sessions/write-set-ledger.md` | 2 | new — this file, which discloses itself |

`review.md`, the one declared path, is **deliberately untouched**.

## Round 7 (fix cycle 2) — the row declares NOTHING at all

The round-7 fix-cycle row was seeded with an **empty** `write_set`. Not a wrong
declaration this time — no declaration. So, as in round 5, **every file below is undeclared
by construction**, and the same rule applies: disclose loudly, never retro-edit the row.

Round-6 review finding 2 was a wording defect in a comment: "stale on 68.4% of polls — 70 of
the 108 comparable samples…" reads as a derivation, and 70/108 is 64.8%, not 68.4%.

**This round did not close that finding — it propagated a second, worse form of it, and the
round-8 review caught it.** Round 6's diagnosis named 108 as the comparable base, this round
implemented that diagnosis faithfully, and the result is arithmetically impossible: no
integer over 108 rounds to 68.4% (73/108 = 67.6%, 74/108 = 68.5%). The base is **158**;
**108 is the stale count**. Worse, `liveSessions.ts` had previously carried the vaguer
"68.4% of polls" with *no* base at all, so the edit below **introduced** a false denominator
where none had existed. Read the table below as what was written, not as a clean close;
round 9 is the correction.

| File | Finding | Why |
|---|---|---|
| `forge-control-web/app/desktop/team/LiveSessionsStrip.tsx` | 2 | the comment named in the finding — em dash replaced, both figures given with their bases. **The bases given were wrong;** see round 9. |
| `evidence/aios-sidebar-live-sessions/activity-truth.md` | 2 | §6, the same conflation, same fix. **Same wrong base;** see round 9. |
| `forge-control-web/app/desktop/team/liveSessions.ts` | 2 (extension) | **not named by the reviewer.** It carried a third, milder form of the same error — "stale on 68.4% of polls", base missing. Rewritten to "68.4% of the 108 comparable poll samples" so the three citation sites agree. **They agreed on a false denominator, and this site is where round 7 actively made things worse:** it had named no base before, and this edit invented one. See round 9. |
| `evidence/aios-sidebar-live-sessions/write-set-ledger.md` | — | this section |

Round-6 finding 1 (`/opt/forge-ai-os` dirty, two sole copies) is **not closed here and cannot
be**: it lives outside the worktree, and the worktree-only policy plus
`live-checkout-dirty-protocol` both forbid a build task from touching the live checkout. It
was escalated again rather than silently carried. See the round-7 report.

## Round 9 (fix cycle 3) — the row declares NOTHING at all, again

The round-9 fix-cycle row was seeded with an **empty** `write_set`, the same fix-chain defect
as round 7 (fleet note `fix-chain-builder-inherits-empty-write-set`). **Every file below is
undeclared by construction.** Disclosed here and in the round-9 report; the row is **not**
retro-amended, per `ledger-gap-is-the-finding`.

Round-8's review found the round-7 fix had re-broken the figure and spread it to a fourth
site. Before touching anything, this round recovered the instrument's **raw output** rather
than any summary of it — one query against the originating run:

```
$ psql … -c "select substring(thread::text from position('DB served a STALE activity' \
    in thread::text) - 900 for 1800) from runs where id = '18ec3069-…-d215e281b5f9'"

compared 158 poll samples against the thread's own event log

  DB matched the true in-memory state : 50 (31.6%)
  DB served a STALE activity          : 108 (68.4%)

      70  served "tool_call"  while truly "tool_result"
      17  served "assistant_text"  while truly "tool_call"
      13  served "assistant_text"  while truly "tool_result"
       6  served "tool_call"  while truly "assistant_text"
       2  served "tool_result"  while truly "assistant_text"
```

It is internally checkable: 70 + 17 + 13 + 6 + 2 = 108, and 50 + 108 = 158. **158 is the
comparable base; 108 is the stale count.** The correct sentence, now identical at all three
citation sites, is: *stale on 108 of 158 comparable poll samples (68.4%); 70 of those 108
stale samples (64.8% of the staleness) were a `tool_call` served while the true state was
`tool_result`.*

| File | Finding | Why |
|---|---|---|
| `forge-control-web/app/desktop/team/LiveSessionsStrip.tsx` | 1 | the comment named in the finding — correct bases, and it now says outright which number is the base and which is the count |
| `forge-control-web/app/desktop/team/liveSessions.ts` | 2 | the regression round 7 introduced: false denominator removed, correct one put in its place |
| `evidence/aios-sidebar-live-sessions/activity-truth.md` | 3 | §6 rewritten — 379 polls → 158 comparable → 108 stale → 70 of that shape, each step with its own denominator, plus the impossibility check that catches the wrong reading |
| `evidence/aios-sidebar-live-sessions/write-set-ledger.md` | 4 | §Round 7's quoted text corrected, and that section now records that round 7 **propagated** round 6's mis-diagnosis instead of closing it; this section |

All four writes are comments and prose. **No executable line changed** — see the round-9
report for the compiled-output proof.
