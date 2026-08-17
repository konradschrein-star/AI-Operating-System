# Baseline — `operator-visibility` (8ea0cc08), phase 7

**Requirement R62.** The before-measurement of the project engine, produced by the
committed instrument so that the before and the after are read off one gauge.
Written by round 213 of `engine-task-graph`, phase 7 builder 3.

**What this file is.** Every number below was printed by
`scripts/measure-schedule.ts` and inlined here by redirecting its stdout to a
file and pasting that file. Nothing was transcribed by hand — least of all the
instrument's identity, which the script computes from its own bytes at startup
and which three separate identity failures on this project's record say must
never be quoted from anywhere else.

**What this file is not.** It is **half** a baseline. S1, S2 and S3 are **NOT
COMPUTED** here, for a cause recorded in §3, and phase 8 completes them by
appending to this same file with this same instrument. See erratum **E-3** in
`04-phases.md` §12 and the amended R62 in `01-requirements.md` §H.

### Re-run record — round 217, and why this document has one at all

**Round 215 moved the instrument. Round 217 re-ran part 1 under the moved
instrument rather than leaving the old identity pasted here.** Round 215's
phase-7 repairs edited `renderCensus()` and `printFull()` in
`scripts/measure-schedule.ts`, so the script's self-computed `instrument-sha256`
changed from `80ef1123…` to `f6828a68…`. `[historical instrument]` Nothing was
wrong with the numbers — but every header below still named bytes that had
stopped existing, and §5(3) below presented a `sha256sum` of the old value as an
*independent re-derivation*, which stopped reproducing on the commit that moved
it. Round 216's re-review caught it as finding 1 and called it what it is: the
instrument-identity class this project has now been bitten by four times.

**What was re-run, and what moved.** All seven commands of §1's table, verbatim,
from the worktree at `34268e9`. Exit codes unchanged (0 ×6, **1** for C). Every
round/task table in §2 and the refusal text in §3 reproduce **byte for byte** —
verified by string containment against the pasted blocks before they were
touched, and independently by round 216's reviewer for run A. **No measurement in
this document moved.** Exactly three header fields changed, and all three are
identity rather than measurement:

| field | was | is | why |
|---|---|---|---|
| `instrument-sha256` | `80ef1123…` `[historical instrument]` | `f6828a68…` | round 215 edited the script |
| `git-head` | `b1bb731…` | `34268e9…` | the tree the re-run happened in |
| `census:` | no such field | `closure-shaped-rows=0` | round 215 added D7's second arm to the census |

`closure-shaped-rows=0` is not a new number so much as a newly-printed one, and
on this fixture it is the value that says the rows are the pre-migration legacy
rows they claim to be.

**What "one instrument" means now, since it can no longer mean "the bytes never
change".** R62 requires the before and the after to be read off one gauge. A
project that keeps improving its own instrument cannot promise the bytes are
frozen; it can promise that **every number in this file was produced by the bytes
this file names.** That is the invariant, and it is now MACHINE-CHECKED rather
than remembered — `check-instrument-identity.py` (this directory) fails if any
pasted header here disagrees with `sha256sum scripts/measure-schedule.ts`, and
fails if a retired identity is quoted anywhere in the corpus without the literal
marker `[historical instrument]` on the line. It is in `03-quality.md` §3.1's
universal gate. **The obligation this creates for phase 8 is stated plainly:** if
the instrument moves again before part 2 is appended, part 1 is re-run in the
same commit that appends part 2, exactly as this section records. Appending a
part 2 under a newer instrument than part 1 is a finding, and the checker will
say so before a reviewer has to.

---

## 1. Provenance — every run's identity header, before any number

Seven invocations. Three are the commands phase 7's brief names; four more
resolve the discrepancy of §4 and are listed with them so no table below rests
on a command a reader cannot see.

| run | command (from `forge-control/`, `M=../scripts/measure-schedule.ts`, `F=src/lib/fixtures/replay-operator-visibility.json`) | exit |
|---|---|---|
| A | `tsx $M rounds --fixture $F` | 0 |
| B | `tsx $M rounds --fixture $F --from 2026-08-16T20:51:00Z --to 2026-08-17T01:04:00Z` | 0 |
| C | `tsx $M full --fixture $F` | **1** |
| D | `tsx $M rounds --fixture $F --to 2026-08-17T03:04:00Z` | 0 |
| E | `tsx $M rounds --fixture $F --from 2026-08-17T03:04:00Z` | 0 |
| F | `tsx $M rounds --fixture $F --from 2026-08-16T22:51:00Z --to 2026-08-17T03:04:00Z` | 0 |
| G | `tsx $M rounds --fixture $F --to 2026-08-17T01:04:00Z` | 0 |

A, B and C are the brief's three commands verbatim. B carries the brief's own
window flags, and §4.2 rules those flags **wrong** and says why — B is kept on
the record rather than quietly replaced.

### Run A header — whole project

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              rounds
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            full project (no --from/--to given)
census:            tasks=131 legacy-rows=131 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.
```

### Run B header — the brief's window (`20:51Z .. 01:04Z`)

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              rounds
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            2026-08-16T20:51:00Z .. 2026-08-17T01:04:00Z (inclusive, on project_tasks.created_at)
census:            tasks=23 legacy-rows=23 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.
```

### Run C header — `full` mode, which refused

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              full
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            full project (no --from/--to given)
census:            tasks=131 legacy-rows=131 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
```

### Run D header — cut at `03:04:00Z`, the measurement instant as §4.2 reads it

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              rounds
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            (open) .. 2026-08-17T03:04:00Z (inclusive, on project_tasks.created_at)
census:            tasks=123 legacy-rows=123 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.
```

### Run E header — the complement of D

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              rounds
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            2026-08-17T03:04:00Z .. (open) (inclusive, on project_tasks.created_at)
census:            tasks=8 legacy-rows=8 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.
```

### Run F header — the corrected two-sided window (`22:51Z .. 03:04Z`)

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              rounds
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            2026-08-16T22:51:00Z .. 2026-08-17T03:04:00Z (inclusive, on project_tasks.created_at)
census:            tasks=29 legacy-rows=29 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.
```

### Run G header — cut at `01:04:00Z`, the measurement instant as the brief reads it

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              rounds
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            (open) .. 2026-08-17T01:04:00Z (inclusive, on project_tasks.created_at)
census:            tasks=108 legacy-rows=108 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read
disclaimer:        S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no concurrency result.
```

Two identity fields, both self-computed by the running process:
`instrument-sha256` names the bytes that executed; `git-head` names the working
tree they executed in. The header says in its own words which to believe. Both
are identical across all seven runs, which is what one would expect of seven
invocations of one file inside one commit — and it is a claim a reader can now
check rather than take, because `check-instrument-identity.py` reads these eight
pasted blocks and compares them to the file on disk.

**Read the re-run record above before comparing this section to an older copy of
it.** These headers were produced by round 217; the ones round 213 pasted named
`80ef1123…` `[historical instrument]`, the identity round 215's edits retired.
The tables under them are unchanged.

---

## 2. The round/task tables

### 2.1 Whole project — run A

```
-- round / task table (00-vision.md §2) --
  round   tasks
      0       1
    100       1
    101       2
    102       1
    103       1
    200       1
    201       1
    202       1
    203       1
    250       1
    299       1
    300       1
    301       1
    302       1
    303       4
    304       1
    305       1
    306       1
    307       1
    308       1
    309       1
    400       1
    401       2
    402       1
    403       1
    405       1
    500       1
    501       2
    502       1
    503       1
    504       1
    505       1
    506       1
    507       1
    599       1
    600       1
    601       2
    602       1
    603       1
    604       1
    605       1
    606       1
    607       1
    700       1
    701       2
    702       2
    703       1
    704       1
    705       1
    706       1
    800       1
    801       3
    802       1
    803       1
    804       1
    806       1
    807       1
    808       6
    809       1
    900       1
    901       1
    902       1
    903       1
    904       1
    905       1
    906       1
    950       1
   1250       1
   1290       1
   1291       3
   1292       2
   1293       1
   1300       1
   1301       2
   1302       3
   1303       1
   1304       2
   1305       1
   1306       1
   1350      20
   1352       2
   1353       2
   1354       1
   1355       1
   1500       1
   1860       1
   1870       1
  87 rounds, 131 tasks, 1.51 tasks per round
```

### 2.2 The brief's window — run B

```
-- round / task table (00-vision.md §2) --
  round   tasks
    901       1
    902       1
    903       1
    904       1
    905       1
    906       1
   1290       1
   1291       3
   1292       2
   1293       1
   1301       2
   1302       3
   1303       1
   1304       2
   1350       1
   1860       1
  16 rounds, 23 tasks, 1.44 tasks per round
```

### 2.3 Cut at the measurement instant — run D

```
-- round / task table (00-vision.md §2) --
  round   tasks
      0       1
    100       1
    101       2
    102       1
    103       1
    200       1
    201       1
    202       1
    203       1
    250       1
    299       1
    300       1
    301       1
    302       1
    303       4
    304       1
    305       1
    306       1
    307       1
    308       1
    309       1
    400       1
    401       2
    402       1
    403       1
    405       1
    500       1
    501       2
    502       1
    503       1
    504       1
    505       1
    506       1
    507       1
    599       1
    600       1
    601       2
    602       1
    603       1
    604       1
    605       1
    606       1
    607       1
    700       1
    701       2
    702       2
    703       1
    704       1
    705       1
    706       1
    800       1
    801       3
    802       1
    803       1
    804       1
    806       1
    807       1
    808       6
    809       1
    900       1
    901       1
    902       1
    903       1
    904       1
    905       1
    906       1
    950       1
   1250       1
   1290       1
   1291       3
   1292       2
   1293       1
   1300       1
   1301       2
   1302       3
   1303       1
   1304       2
   1305       1
   1306       1
   1350      16
   1352       1
   1353       1
   1500       1
   1860       1
   1870       1
  85 rounds, 123 tasks, 1.45 tasks per round
```

### 2.4 Created after the measurement instant — run E

```
-- round / task table (00-vision.md §2) --
  round   tasks
   1350       4
   1352       1
   1353       1
   1354       1
   1355       1
  5 rounds, 8 tasks, 1.6 tasks per round
```

### 2.5 The corrected two-sided window — run F

```
-- round / task table (00-vision.md §2) --
  round   tasks
   1291       3
   1292       2
   1293       1
   1301       2
   1302       3
   1303       1
   1304       2
   1305       1
   1306       1
   1350      11
   1352       1
   1353       1
  12 rounds, 29 tasks, 2.42 tasks per round
```

### 2.6 Cut at `01:04:00Z` — run G

```
-- round / task table (00-vision.md §2) --
  round   tasks
      0       1
    100       1
    101       2
    102       1
    103       1
    200       1
    201       1
    202       1
    203       1
    250       1
    299       1
    300       1
    301       1
    302       1
    303       4
    304       1
    305       1
    306       1
    307       1
    308       1
    309       1
    400       1
    401       2
    402       1
    403       1
    405       1
    500       1
    501       2
    502       1
    503       1
    504       1
    505       1
    506       1
    507       1
    599       1
    600       1
    601       2
    602       1
    603       1
    604       1
    605       1
    606       1
    607       1
    700       1
    701       2
    702       2
    703       1
    704       1
    705       1
    706       1
    800       1
    801       3
    802       1
    803       1
    804       1
    806       1
    807       1
    808       6
    809       1
    900       1
    901       1
    902       1
    903       1
    904       1
    905       1
    906       1
    950       1
   1250       1
   1290       1
   1291       3
   1292       2
   1293       1
   1300       1
   1301       2
   1302       3
   1303       1
   1304       2
   1350       5
   1500       1
   1860       1
   1870       1
  81 rounds, 108 tasks, 1.33 tasks per round
```

---

## 3. S1, S2 and S3: **NOT COMPUTED**, and the exit code that proves it

The third command the brief names is `full`. It exits **non-zero**. Its complete
output, header and refusal:

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2
                   sha256 of scripts/measure-schedule.ts, hashed from disk at startup — THIS names the bytes that ran.
git-head:          34268e904ed943a858873f538c74ee8bd7f10bbe
                   names the working TREE at run time, NOT the bytes that ran; committing this file moves
                   git-head and leaves instrument-sha256 unchanged. Where they disagree, believe the sha256.
mode:              full
source:            fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7
project:           (none — a bare-array fixture declares no project_id)
depends_on:        absent (0/131 fixture rows carry a depends_on key)
window:            full project (no --from/--to given)
census:            tasks=131 legacy-rows=131 graph-rows=0 closure-shaped-rows=0 runs=not-read top-level=not-read sub-agent=not-read archived=not-read tasks-without-run=not-read

MEASUREMENT FAILED: fixture-has-no-runs
  - fixture:src/lib/fixtures/replay-operator-visibility.json sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7 declares no 'runs' key, so it is a task-only fixture
  - full mode needs run rows for the run count, mean duration, wall clock, S1 and S2, and it does not print a smaller table instead (R61). Ask for the round table by name: 'rounds --fixture <path>'.
  - For the 8ea0cc08 baseline this is the finding, not a defect: the phase-1 capture carries six keys per row and no run_id, so S1, S2, mean duration and wall clock are not computable from this worktree. Completing that baseline needs a live read, which belongs to phase 8.
exit=1
```

**The cause, stated plainly.** The committed fixture carries exactly six keys per
row — `{id, round, role, title, status, created_at}` — asserted as **A3** of
`forge-control/src/lib/fixtures/replay-operator-visibility.md` §3 and confirmed
by the header line `depends_on: absent (0/131 fixture rows carry a depends_on
key)` on every run above. There is **no `run_id`, no `started_at`, no
`completed_at`** in it. Therefore:

| metric | needs | derivable from this worktree? |
|---|---|---|
| run count | run rows | **no** |
| mean run duration | `started_at`, `completed_at` | **no** |
| wall clock | earliest start, latest finish | **no** |
| S1 — mean concurrent live runs | per-minute samples over run intervals | **no** |
| S2 — parallelism ratio | wall clock ÷ summed run durations | **no** |
| S3 — longest numbering stall | `depends_on` + run timestamps | **no** |
| round/task table | `round` | **yes** — §2 above |

Reading the live database would produce them. **That is not authorised in this
phase**: `03-quality.md` §2.3 gives live reads to the explicitly-briefed
deploy/verify task alone, and `measure-schedule.ts`'s `--project` branch is
written, typechecked and deliberately left unrun. No duration was estimated, no
run was inferred, and no smaller table was printed in place of the numbers —
`full` refused before printing anything but its header, which is R61 working
rather than R61 being disclosed around.

**This is a deferral with a named cause, not a gap.** Phase 8 completes it
(E-3), appending to this file, with this instrument.

---

## 4. Comparison against `00-vision.md` §2, and the discrepancy ruled on

### 4.1 What §2 records

`00-vision.md` §2 states the measurement of record, taken at 03:04 on
2026-08-17: **12 rounds, 21 tasks, average 1.75 tasks per round**, over rounds
1290, 1291, 1292, 1293, 1300, 1301, 1302, 1303, 1304, 1305, 1306 and 1350. Those
are quotations from a document, not results of the instrument, and are labelled
as such wherever they appear below.

### 4.2 FINDING — the window flags this brief supplied are wrong, and the fixture says so

The brief instructs `--from 2026-08-16T20:51:00Z --to 2026-08-17T01:04:00Z`,
reasoning that 22:51 and 03:04 are CEST wall clock and the fixture's `created_at`
is UTC. The **premise is sound**: the capture record §1 fixes the capture at
`2026-08-17T05:57:21+02:00` and §3 gives the fixture's newest `created_at` as
`2026-08-17T03:51:57.328756+00:00` — minutes earlier on one clock, which is what
a live project still creating tasks looks like. The **conversion arithmetic is
also sound**: 22:51 CEST is 20:51Z and 03:04 CEST is 01:04Z.

The **result is still wrong**, because §2's table is not reproduced by that cut
and is reproduced by reading Konrad's quoted times on the fixture's own clock,
unshifted. Three pieces of evidence, all from the tables in §2 above:

1. **Run G (cut at 01:04Z) has no round 1305 and no round 1306.** §2 lists
   `1305: 1` and `1306: 1`. Rows that did not exist cannot have been counted.
   Run D (cut at 03:04:00Z) has both, at 1 each.
2. **Run D reproduces §2's rounds 1290 through 1306 cell for cell** —
   `1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1`. Eleven independent per-round counts
   agreeing exactly is not something a wrong cut produces by luck.
3. **Run B, the brief's two-sided window, sweeps in rounds 901 through 906** —
   an earlier phase §2 does not mention at all — and still misses 1305 and 1306.

Since run G lacks both rounds and run D carries both, the two rows were created
inside `(01:04:00Z, 03:04:00Z]`. Under the shifted reading they would postdate
not only the measurement but the design spec `00-vision.md` line 6 dates at
~03:10, and Konrad would have had to add them retrospectively to a table he
labels as the 03:04 measurement. Under the unshifted reading they simply predate
it. The unshifted reading is the one the artifact supports.

**What is claimed and what is not.** I do not claim to know which clock Konrad
read, nor that the database and his wrist agree. I claim only this: §2's table is
reconstructed by cutting the fixture at `created_at <= 2026-08-17T03:04:00Z` and
is contradicted by cutting at `01:04:00Z`. Every table in §4 therefore uses run D.

### 4.3 The divergence, located

Numbers in the "§2" column are quoted from `00-vision.md` §2; the other two
columns are cells of the tables pasted in §2.3 and §2.1.

| round | §2 (doc, 03:04) | run D (`<= 03:04:00Z`) | run A (whole project) |
|---|---|---|---|
| 1290 | 1 | 1 | 1 |
| 1291 | 3 | 3 | 3 |
| 1292 | 2 | 2 | 2 |
| 1293 | 1 | 1 | 1 |
| 1300 | 1 | 1 | 1 |
| 1301 | 2 | 2 | 2 |
| 1302 | 3 | 3 | 3 |
| 1303 | 1 | 1 | 1 |
| 1304 | 2 | 2 | 2 |
| 1305 | 1 | 1 | 1 |
| 1306 | 1 | 1 | 1 |
| **1350** | **3** | **16** | **20** |

**Eleven of twelve rounds diverge by zero.** The entire discrepancy between the
vision document and the fixture is round 1350.

That fact is itself evidence about §2: a table that reproduces exactly on eleven
rounds was an accurate snapshot, not an approximation. The one cell that moved,
moved for a reason outside the measurement.

### 4.4 Attribution — 13 renumbered, 4 new, and the planner's arithmetic inverted

Round 1350's 20 rows partition by existence at the measurement instant:

- **run E** — `1350: 4`. Four rows created at or after `03:04:00Z`.
- **run D** — `1350: 16`. Sixteen rows created at or before it.
- 16 + 4 = 20, which is run A's cell. The partition is exact.

The divergence to explain is 20 − 3 = **17 rows**.

- **At most 4** are work created after the measurement window closed. No cut can
  make that number larger; run E is the whole of the post-instant corpus.
- **13** existed at the measurement instant and did **not** read round 1350 then
  — 16 present, 3 counted.

**The split is 13 / 4, not 4 / 13.** The brief's provisional arithmetic states
that "of the extra tasks at round 1350, only a small number existed before 03:04
and the large majority were CREATED AFTER the measurement window closed". That
is exactly what run G says — `1350: 5` at the 01:04Z cut, so 15 of 20 arrive
after it — and run G is the cut the wrong conversion of §4.2 produces. Correct
the cut and the conclusion reverses. **I report the planner's arithmetic as a
finding, not as a footnote:** it was right that the renumber is not the whole
explanation, and inverted on which cause dominates.

### 4.5 What the 13 are — and what this artifact cannot tell you

`project_tasks` keeps **no history of `round`**. `created_at` is immutable;
`round` is not. The fixture therefore records, for every row, the round it held
**at capture** and never the round it held at 03:04. Two mechanisms put a row
among the 13:

1. **The operator UPDATE**, confirmed on the record in `02-architecture.md`
   §2.3.3: roughly a dozen `pending` tasks promoted by hand into the live round
   after grepping their briefs for write-sets.
2. **Rows seeded above the band.** §2's table stops at 1350; the fixture still
   carries rounds 1352 and 1353 (run A, run D). A row sitting at 1351 or above at
   03:04 was outside the table Konrad wrote, and reads 1350 at capture.

From §2's point of view these are the same phenomenon — the `round` column moved
under a stationary set of rows — and neither is new work. Independently: 13 is,
to the row, "roughly a dozen". The operator's confirmation and this arithmetic
agree without having been fitted to one another.

**What I cannot do from this worktree** is separate mechanism 1 from mechanism 2,
or name which 13 rows moved. No artifact here carries a round history, and the
live database is phase 8's authority (`03-quality.md` §2.3). The bound is stated;
the attribution is not invented.

### 4.6 The ruling

**The renumber is ruled IN as the dominant cause and OUT as the whole
explanation.**

- **IN** — at least 13 of the 17 divergent rows at round 1350 existed at the
  measurement instant under a different number.
- **OUT** — 4 of the 17 did not exist at all at that instant. No renumber
  accounts for a row that had not been created.
- **AND** — the divergence is confined to a single round. §2 was a true snapshot
  of a window that then kept moving.

### 4.7 What was corrected in `00-vision.md`, in this commit

§2 now carries **both** tables: Konrad's original, labelled as the 03:04
measurement of record and untouched, and the recomputed one beside it with the
instrument's `instrument-sha256`, plus the discrepancy and its two causes in
prose. The original numbers are not deleted — §4's thresholds are derived from
them.

**§4's "Note on S2's denominator" was left alone, deliberately.** Its figures
(255 min wall clock, 21 runs, 17 min mean, 357 min of run time, ratio 0.71) are
computed from **run durations**, and §3 above shows that no run duration is
derivable from any artifact in this worktree. Nothing measured here contradicts
it, because nothing measured here touches it. Correcting a paragraph I cannot
measure would be the instrument-lies failure wearing the costume of diligence.
The note already says the script's number wins if it disagrees; phase 8 is where
the script gets a number to disagree with.

---

## 5. What would have made this baseline lie

Six mechanisms, each named and each disproved. Standing rule 3 — and a document
quoting an instrument is where instruments lie most easily.

**(1) A number in the prose that no command in this document produced.** The
classic: an arithmetic result typed from memory, or a figure carried over from an
earlier draft, sitting in a paragraph beside genuine measurements and inheriting
their authority. *Disproved:* §7 is a ledger of every number in this document,
each mapped to the run that printed it or to the document it is quoted from.
Numbers derived by arithmetic are shown with their operands and both operands are
pasted cells. There are exactly three sources of digits here — the seven pasted
run outputs, `00-vision.md` §2 and the capture record — and §7 accounts for the
document against all three.

**(2) The round table computed over a different set of rows than the header's
counts describe.** The instrument prints a census in the header and a table
below it; if the window narrowed one and not the other, every run would look
internally coherent and be describing two different corpora. *Disproved
mechanically,* not by inspection. For each run: the header's `census: tasks=N`,
the footer's `N tasks`, the number of table rows and the sum of the table's task
cells must all agree. Re-runnable by any reviewer against the same stdout:

```bash
python3 - <<'PY'
import re, sys, pathlib
bad = 0
for tag in "ABCDEFG":
    text = pathlib.Path(f"/tmp/run-{tag}.txt").read_text()
    census = int(re.search(r"census:\s+tasks=(\d+)", text).group(1))
    foot = re.search(r"^\s*(\d+) rounds, (\d+) tasks,", text, re.M)
    if foot is None:
        print(f"run-{tag}: census tasks={census}  table=NONE PRINTED  -> n/a (mode refused before any table)")
        continue
    rows = re.findall(r"^\s+(\d+)\s+(\d+)$", text, re.M)
    cells = sum(int(c) for _, c in rows)
    ok = (census == int(foot.group(2)) == cells) and len(rows) == int(foot.group(1))
    bad += 0 if ok else 1
    print(f"run-{tag}: census tasks={census}  footer rounds={foot.group(1)} tasks={foot.group(2)}  "
          f"table rows={len(rows)} cell-sum={cells}  -> {'AGREE' if ok else 'DISAGREE'}")
print(f"\n{bad} disagreements")
sys.exit(1 if bad else 0)
PY
```

Output, verbatim:

```
run-A: census tasks=131  footer rounds=87 tasks=131  table rows=87 cell-sum=131  -> AGREE
run-B: census tasks=23  footer rounds=16 tasks=23  table rows=16 cell-sum=23  -> AGREE
run-C: census tasks=131  table=NONE PRINTED  -> n/a (mode refused before any table)
run-D: census tasks=123  footer rounds=85 tasks=123  table rows=85 cell-sum=123  -> AGREE
run-E: census tasks=8  footer rounds=5 tasks=8  table rows=5 cell-sum=8  -> AGREE
run-F: census tasks=29  footer rounds=12 tasks=29  table rows=12 cell-sum=29  -> AGREE
run-G: census tasks=108  footer rounds=81 tasks=108  table rows=81 cell-sum=108  -> AGREE

0 disagreements
```

It exits non-zero on any disagreement, and it prints `n/a` for run C only because
run C printed **no table at all** — which is §3's refusal, observed from the
outside.

**(3) An identity hand-copied, or naming bytes other than the ones that ran.**
**FOUR** instances are on this project's record, and the fourth is this document:
a SHA naming the worktree rather than the build; a region stamped with `git HEAD`
so that committing it made the stamp wrong on the very commit that created it; a
transcript attributing results to a sha256 naming bytes in no commit at all; and
— round 216's finding 1 — **this section, quoting an identity round 215 had
retired, in the one block the document offers as proof that it doesn't do that.**
*Disproved two ways, both of which now have to survive the fourth instance:*
every header block above is stdout, redirected to `/tmp/run-<tag>.txt` and
inlined into this file by a generator, so no human hand touched the characters;
and the header's `instrument-sha256` is independently re-derivable —

```
$ sha256sum scripts/measure-schedule.ts forge-control/src/lib/fixtures/replay-operator-visibility.json
f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2  scripts/measure-schedule.ts
e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7  forge-control/src/lib/fixtures/replay-operator-visibility.json
```

`f6828a68…` is the value all seven headers printed, computed by the running
process from `import.meta.url`, and `sha256sum` over the committed path agrees.
Note also that `git-head` reads `34268e9…`, the round-215 commit — this commit
will move it and leave `instrument-sha256` unchanged, which is the property that
made a self-hash the right identity to trust.

**Why this re-derivation is worth more than it was when round 213 wrote it.** As
written it was a command a reader had to think to run. It went stale on the very
next commit that touched the script and stayed stale for two rounds, read by two
reviewers, because agreeing with a document is not the same as agreeing with the
disk and nobody was made to check which. It is now the second half of a gate:
`check-instrument-identity.py` performs exactly this comparison over all eight
pasted headers, refuses to report a pass if it found fewer than eight or never
reached this file, and runs in `03-quality.md` §3.1's universal gate on every
phase. A drift that took a reviewer's forensics to catch now costs one command.

**(4) A stale or different fixture.** The failure where the tables are real
measurements of the wrong bytes. *Disproved:* every header prints
`source: fixture:… sha256=e0cb69a5c5d05bdf96aab8a8a61409fede7337b609831f2404d0cf04e26f19b7`,
which equals the `sha256(.json)` recorded in the capture record §1 — written by
round 102, before this instrument existed and with no knowledge of it — and
equals `sha256sum` over the committed path in the block above. Three independent
statements of one identity.

**(5) A window that silently dropped rows.** `--from`/`--to` filter on
`created_at`, and a boundary that excluded rows at both ends would shrink every
table consistently and look like data rather than like a bug. *Disproved by
partition:* run D (`<= 03:04:00Z`) reports 123 tasks and run E (`>= 03:04:00Z`)
reports 8; 123 + 8 = 131, which is run A's whole-project count. The two windows
are inclusive at the same instant, so an overlap would have made the sum exceed
131 and a gap would have made it fall short. It does neither. The same holds at
round 1350: 16 + 4 = 20.

**(6) The instrument printing a smaller, prettier table instead of failing.**
R61's named failure, and the reason `full` and `rounds` are separate subcommands.
*Disproved:* run C exits 1, its refusal names `fixture-has-no-runs`, and the
audit of mechanism 2 independently confirms run C emitted no table — the header,
then the refusal, then nothing. Had `full` degraded to `rounds`, this document
would have carried a round table under a `full` heading and claimed S1 and S2 by
omission.

---

## 6. Phase 7's S1/S2 claim: still true, still unverified here

`04-phases.md` Phase 7 accepts that "the headline metrics S1 and S2 are computed
from run timestamps and wall clock, not from the round distribution, so they are
**unaffected** by the renumbering", and requires this document to say so
explicitly.

**It says so, and it says the other half too.**

- **The argument holds.** S1 is a mean of per-minute concurrency samples over run
  intervals, and S2 is wall clock over summed run duration. Neither reads
  `project_tasks.round`. A `UPDATE project_tasks SET round = …` cannot move
  either, and §4's finding — that at least 13 rows changed round between 03:04
  and capture — therefore has no bearing on them. A reader who watches the round
  table move from 3 to 20 in a single cell should **not** conclude that the whole
  measurement is soft.
- **The measurement does not exist yet.** S1 and S2 for 8ea0cc08 are **NOT
  COMPUTED** (§3). "Unaffected by the renumber" is a statement about what could
  perturb a number, not a statement of the number. Nothing in this document
  licenses quoting an S1 or an S2 for the baseline.

**Do not let the argument stand in for the measurement.** Phase 8 measures them,
against the live database, with this instrument, appended to this file. Until
that append lands, the honest reading of this baseline is: the round half is
measured; the concurrency half is owed.

---

## 7. Digit ledger — every number in this document, accounted for

Standing rule 3, applied to the document rather than to the code. Three sources
of digits, and nothing else: the seven pasted run outputs; `00-vision.md` §2; the
capture record `replay-operator-visibility.md`. Four classes of digit are
identities or labels rather than measurements, and are not ledgered: requirement
and erratum ids (`R61`, `E-3`); document section and line references (`§4.2`,
`§3.1 item 4`, `line 6`); round numbers used as labels (`round 213`, `round 102`,
`1290`, `1350`); and the literal characters of a sha256 or a commit short-SHA
where it is quoted whole. Everything else is below.

| number(s) | where it appears | source |
|---|---|---|
| `f6828a68…`, `34268e9…` | §1, §5(3) | printed by every run's header; re-derived by `sha256sum` in §5(3); machine-compared to the disk by `check-instrument-identity.py` |
| `80ef1123…` `[historical instrument]` | §1 re-run record, §1 closing, §5(3) | the identity round 213's runs printed, retired by round 215's edits to the script; quoted only to record the drift, and every such line carries the marker the checker keys on |
| `e0cb69a5…` | §1 headers, §5(4) | printed by every run's header; capture record §1; `sha256sum` in §5(3) |
| 131 / 87 rounds / 1.51 | §2.1, §3 table, §5(5) | run A footer and census |
| 23 / 16 rounds / 1.44 | §2.2 | run B footer and census |
| 123 / 85 rounds / 1.45 | §2.3, §5(5) | run D footer and census |
| 8 / 5 rounds / 1.6 | §2.4, §5(5) | run E footer and census |
| 29 / 12 rounds / 2.42 | §2.5 | run F footer and census |
| 108 / 81 rounds / 1.33 | §2.6 | run G footer and census |
| exit 0 ×6, exit **1** for C | §1 table, §3, §5(6) | the `echo "exit=$?"` appended to each captured run |
| `0/131 fixture rows carry a depends_on key` | §3 | run headers, all seven |
| 6 keys per row, assertion A3 | §3 | capture record §3 |
| §2's `12 rounds, 21 tasks, 1.75` | §4.1 | quoted from `00-vision.md` §2 |
| §2's per-round cells `1,3,2,1,1,2,3,1,2,1,1` and `3` | §4.2(2), §4.3 | quoted from `00-vision.md` §2 |
| run D's cells for 1290–1306 and `1350: 16` | §4.2(2), §4.3, §4.4 | run D table |
| run A's `1350: 20` | §4.3, §4.4 | run A table |
| run E's `1350: 4` | §4.4 | run E table |
| run G's `1350: 5`; absence of 1305/1306 in G | §4.2(1), §4.4 | run G table |
| run B's rounds 901–906 | §4.2(3) | run B table |
| 16 + 4 = 20 | §4.4, §5(5) | run D cell + run E cell = run A cell |
| 123 + 8 = 131 | §5(5) | run D footer + run E footer = run A footer |
| 20 − 3 = 17 | §4.4 | run A cell − `00-vision.md` §2 cell |
| 16 − 3 = 13 | §4.4, §4.5, §4.6 | run D cell − `00-vision.md` §2 cell |
| 15 of 20 | §4.4 | run A cell − run G cell = 20 − 5 |
| "eleven of twelve rounds" | §4.3 | count of matching rows in the §4.3 table |
| 255 min, 21 runs, 17 min, 357 min, 0.71 | §4.7, quoted only to say they were **not** touched | `00-vision.md` §4's note |
| `2026-08-17T05:57:21+02:00`, `2026-08-17T03:51:57.328756+00:00` | §4.2 | capture record §1 and §3 |
| `~03:10` (the design spec's timestamp) | §4.2 | quoted from `00-vision.md` line 6 |
| `34268e9…` named as the round-215 commit | §5(3) | the `git-head` field of every run header |
| `b1bb731…` named as the round-212 commit | §1 re-run record | the `git-head` the retired round-213 headers carried; a tree identity, not an instrument one, so it needs no marker |
| "roughly a dozen" | §4.5 | `02-architecture.md` §2.3.3 |
| 0 disagreements | §5(2) | the audit's own output |

No number appears in this document's prose that is not in this table.
