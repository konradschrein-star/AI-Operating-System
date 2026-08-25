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
the 108 comparable samples…" reads as a derivation, and 70/108 is 64.8%, not 68.4%. 68.4% is
the *overall* stale rate over those 108 samples; 70/108 is its largest subset.

| File | Finding | Why |
|---|---|---|
| `forge-control-web/app/desktop/team/LiveSessionsStrip.tsx` | 2 | the comment named in the finding — em dash replaced, both figures given with their bases |
| `evidence/aios-sidebar-live-sessions/activity-truth.md` | 2 | §6, the same conflation, same fix |
| `forge-control-web/app/desktop/team/liveSessions.ts` | 2 (extension) | **not named by the reviewer.** It carried a third, milder form of the same error — "stale on 68.4% of polls", right base missing. Corrected to "68.4% of the 108 comparable poll samples" so the three citation sites agree. |
| `evidence/aios-sidebar-live-sessions/write-set-ledger.md` | — | this section |

Round-6 finding 1 (`/opt/forge-ai-os` dirty, two sole copies) is **not closed here and cannot
be**: it lives outside the worktree, and the worktree-only policy plus
`live-checkout-dirty-protocol` both forbid a build task from touching the live checkout. It
was escalated again rather than silently carried. See the round-7 report.
