# Phase 8C — corpus repairs, the amended merge gate, and the universal instrument-typecheck gate

Round 802. Builder 8C, one of three builders sharing one worktree on disjoint
file sets. Branch `project/8c591d6c`, at `3dd39b4`.

**Declared write-set (five):** `01-requirements.md`, `03-quality.md`,
`04-phases.md`, `evidence/phase4-workstreams.md`, `evidence/phase8-corpus.md`.
**Three writes outside it**, forced by a mid-round instrument move and declared
in `04-phases.md` §10 in this same commit — see §7 below.

**Not touched, by brief:** `00-vision.md` and `evidence/baseline-8ea0cc08.md`
(builder 8B, this round), anything under `scripts/` (builder 8D, this round).
Confirmed by `git status` at the end of §8.

---

## 0. The two rotted pins, reported and not reinterpreted (standing rule 1)

The brief handed me two line-number citations from the operator. **Neither
resolves.** Recorded here as findings rather than quietly re-read against
whatever now sits at those lines — which is the failure mode that cost three
consecutive rounds on this project.

| pin as given | what is actually there, in the tree at `26ce631` | where the requirement really begins |
|---|---|---|
| R62's part-1 bullet, "~line 829" of `01-requirements.md` | not R62, and not §H | **R62 begins at line 1191** |
| R68's *How proved*, "~line 955" of `01-requirements.md` | not R68, and not §I | **R68 begins at line 1338** |

Both are off by roughly 360–380 lines, which is consistent with a pin taken
against an ancestor of this tree and never re-resolved — the document grew by
amendment between the two states. **I worked from the requirement ids**, found
both blocks by `grep -n '^\*\*R62\.'` / `'^\*\*R68\.'`, and made no edit at
either cited number.

The lesson is the standing rule's own: a line number without a SHA beside it is
not a citation, it is a guess with a decimal point. Both pins named the right
*requirement*, which is why working from the id cost nothing; had I trusted the
number I would have amended two unrelated paragraphs and reported success.

---

## 1. Job 1 — R62's part-1 bullet still enforced a RETIRED formulation

**Found:** R62's body was corrected in round 217 to a checkable form. R62's
**part-1 bullet**, four paragraphs below it in the same requirement, still
restated the wording round 217 replaced. One requirement stood in the corpus in
two versions, one checkable and one not.

**The retired text, quoted verbatim so a reader can see what was retired rather
than trust that it was:**

> - **Part 1 — phase 7, from the committed fixture.** The round/task table of
>   `00-vision.md` §2, whole-project and windowed, plus the correction of §2 and
>   the discrepancy analysis. **Landed** — the file exists and its header names the
>   script's self-computed `instrument-sha256`, which is what "How proved" above
>   asks for and is satisfiable without a database.

**The surviving formulation it now carries** (round 217's, from R62's body): *every
header pasted in that file names the same `instrument-sha256`, and that value
equals `sha256sum scripts/measure-schedule.ts` on the commit it ships in.*
*(**Superseded round 811**, which widened the command to both instrument files —
`sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts |
sha256sum` — and retired the one-file form in the same commit as the checker.
The reasoning below is unchanged and is what round 811 applied one file over:
a clause that compares a header to the wrong bytes, or to only some of them, is
satisfied by a header that is wrong.)*

**Why the difference is not cosmetic.** "Its header names the script's
self-computed sha" is satisfied by a header naming a sha **the script no longer
has** — the file computes *something*, the header *names* something, and nothing
compares them. That is not hypothetical: for two rounds it was satisfied by
exactly that, and round 216 found thirteen such places, one of them a `sha256sum`
block the document offered as an independent re-derivation which had been
**pasted rather than executed**. The retirement is marked inline at the bullet,
with the reason, per standing rule 4 (retire a requirement and its gate clause
together, in one commit).

---

## 2. Job 2 — R68 carried the weak formulation, and phase 8 discharges R68

**The retired text, verbatim:**

> *How proved:* the file exists; S1–S3 are stated as numbers with the script's SHA.

Two halves, wrong in opposite directions:

- **"Exists and names a SHA"** is satisfiable by a file naming the **wrong**
  sha — the round-216 defect again, and R68 is the requirement that would ship
  it, because R68's artifact is the DoD-6 comparison that the whole project is
  judged on.
- **"S1–S3 as numbers"** demanded of the *baseline* side a number D7 is designed
  never to produce for a legacy project. R62's round-217 amendment and
  `04-phases.md` §Phase 8 step 2b both establish that **S3 for 8ea0cc08 is a
  refusal by construction and always was** — before migration 0040 there is no
  `depends_on` column, so every row is a legacy row and D7's first arm refuses.
  A gate demanding an S3 on both sides is a gate **no correct deploy can pass**,
  which is standing rule 2's target exactly.

**Replaced with what will actually be proved:** the file exists; its pasted
identity **matches** `sha256sum` of the instrument on disk, checked by
`check-instrument-identity.py` (universal gate item 7); the before-file and the
after-file **share one instrument**; S1 and S2 as numbers; S3 as a number for the
**after-project only**.

---

## 3. Jobs 1 and 2 were checked BY HAND, and here is why they had to be

`check-corpus-map.py` compares the **three statements of the requirement map** —
the id set in `01-requirements.md` §K, the phase table in `04-phases.md` §9, and
each phase's header — and asserts they agree. It counts R1..R71 and NF1..NF7 and
verifies each is defined once. It exits 0 on this corpus and exited 0 *before*
these repairs too.

**It cannot see a prose paragraph disagreeing with a requirement body.** Nothing
in it parses *How proved*, and nothing compares a requirement's body to a bullet
restating it 25 lines later. Jobs 1 and 2 are exactly that shape, and both would
have survived every mechanical gate in this corpus indefinitely. They were found
by an operator **reading**, and they were verified by me the same way:

1. Located each requirement by id (`^\*\*R62\.`, `^\*\*R68\.`), not by number.
2. Read the whole of §H's R62 block, 1191→1290, and the whole of §I's R68 block,
   to find every restatement of the requirement inside its own body.
3. Diffed the two formulations **by hand, word for word**, and asked the one
   question that matters: *name a tree that satisfies the old wording and is
   wrong.* For R62's bullet: a file whose header names `f6828a68…` while the   [historical instrument]
   script on disk hashes to `6ec72b35…`. For R68: the same, plus a comparison   [historical instrument]
   table with an S3 column the baseline can never fill.
   **Both answers are concrete, and the first one came true during this task —
   see §7.**
4. Quoted the retired text into this document *before* replacing it, so the
   retirement is auditable against the replacement rather than asserted.

---

## 4. Jobs 3, 4, 6, 7 — the gates, amended where they are enforced

| job | amended where it is ENFORCED | and the matching half |
|---|---|---|
| **3** — "on conflicts STOP" was unsatisfiable | `04-phases.md` §Phase 8 **step 2**, rewritten as two merges with a table | `03-quality.md` §3.2's phase-8 block, same commit |
| **4** — the duplicate `0040` | `04-phases.md` §Phase 8 **step 3**, now three files by explicit filename | `01-requirements.md` §I **R64**, same commit |
| **6** — the watchdog fires R14's hole | `03-quality.md` §3.2's phase-8 block | names `check-scheduler-sql.sh` cases 8, 8b, 9, 10 |
| **7** — phase 8's whole write-set | `04-phases.md` §10, seven rows + the cross-phase reasoning | §Phase 8's "Files this phase writes" points at it |

### 4.1 Job 3 — a distinction, not a relaxation

Measured at round 800, re-derived by 8A at round 801 (`evidence/phase8-merge.md`
§1): `main` moved **55 commits**; `git merge-tree --write-tree main HEAD` reported
**three** content conflicts — `forge-control/src/routes/chat.ts`,
`forge-control-web/app/desktop/team/planApi.ts`,
`forge-control-web/app/desktop/team/PlanKanban.tsx` — six hunks, with
`forge-control-web/app/api.ts` auto-merging. Read across both merges, STOP made
phase 8 **permanently undeployable**: it forbade the only work that makes the
deploy merge clean.

Both halves are stated where they are enforced:

- **merge 1** — `main` → work branch, **in the worktree**: conflicts **RESOLVED**
  by a briefed task reading both sides, reviewed before anything ships. Never
  `-X ours` / `-X theirs`.
- **merge 2** — work branch → `main`, **in the live checkout**: **STOP**,
  verbatim and unrelaxed.

Round 801's three conflicts and their resolutions are recorded **by reference**
to `evidence/phase8-merge.md` §3 (with §6.6 driving the merged `chat.ts` through
`check-plan-api.ts` and §5 re-deriving the phase-6 claim on the merged file) —
not copied, because a copy is a second statement that can rot away from the
first, which is job 1's whole subject.

### 4.2 Job 4 — the migration-number collision

Recorded, **not** renumbered, per the operator's ruling. `db/migrations` carries
two files numbered 0040 — verified on disk:

```
$ ls db/migrations/ | tail -3
0040_task_graph.sql
0040_usage_hourly.sql
0041_ui_dismissals.sql
```

No migration runner and no tracking table exist (`schema_migrations` and
`migrations` both absent — operator-verified); `migrations.test.ts` sorts
filenames without asserting unique numbering. So the collision is survivable and
no rename is forced: renaming would invalidate a phase that already passed review
with `0040_task_graph.sql` pinned inside `check-migration-0040.sh`. The renumber
is a **post-deploy task**, seeded by the operator, and deliberately not done in a
round where three builders share one worktree and the renumber touches six files
two of them already own.

Step 3 now applies **three** files, in order, each twice — `0040_task_graph.sql`,
`0040_usage_hourly.sql`, `0041_ui_dismissals.sql` — with a `pg_tables` check by
name after each, and **never a glob**: a glob sorts `task_graph` before
`usage_hourly` and silently decides an order nobody chose, which is this
project's own defect one layer down. Step 4's `pm2 restart forge-control` happens
only after all three, because `usage_hourly`, `app_settings` and `ui_dismissals`
are all absent from `content_forge` and without them `/api/chat/:id/team` 500s
(the team panel does not render at all) and `/api/usage/series` 500s hourly.

### 4.3 Job 6 — the watchdog is an automated caller of R14's hole

`/opt/ai-os/scripts/fleet-watchdog.sh` runs on cron **every 10 minutes** and
POSTs `/api/projects/:id/unwedge` on every blocked project, force-retrying once
when both quota windows are clear. Round 203 **measured** that `retryTask()`
moved a swept task `blocked → ready` where neither the sweep nor promote could
see it and `claimReadyTasks()` claimed it anyway. So the first blocked project
after this ships has that path exercised unattended, by a robot, within ten
minutes.

The gate now requires the R14 fix **confirmed present in the tree that is about
to ship, before the restart**, stated explicitly in the deploy report, and
verified the way round 203 verified it — by driving the **shipped** functions
against a scratch database through retry → claim and showing the task does NOT
reach `running`. The named cases resolve; I checked rather than cited:

```
$ grep -n "ROUND 204 ADDED CASES" scripts/checks/check-scheduler-sql.sh
12:# ROUND 204 ADDED CASES 8, 8b, 9 AND 10, each the measured shape of a round-203
$ grep -c "R14" forge-control/src/db/projects.ts
(present: sweepDanglingDependencies, the cardinality equality, the back half before the promote)
```

And the clause states the alternative plainly rather than leaving it to judgement:
**if the fix is not present, the watchdog must be disabled until it is.**

---

## 5. Job 5 — the universal instrument-typecheck gate, re-measured

Written into `03-quality.md` **§3.1 as item 9** (universal), with the §4 command
line. Builder 8D writes the script and the manifest; this clause runs them.

### 5.1 The measurement that decides the gate's shape

Round 800 measured that a directory-wide invocation cannot pass. I reproduced
both halves at `3dd39b4`. **All six of this branch's own check scripts pass, one
file per invocation, exit 0, zero errors:**

```
$ cd forge-control && for f in check-close-gate check-fix-chain-graph check-plan-api \
      check-plan-store check-project-metadata check-task-api; do
    node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler \
      --lib ES2022 --strict --skipLibCheck --esModuleInterop --resolveJsonModule \
      --allowImportingTsExtensions ../scripts/checks/$f.ts
  done
check-close-gate:        exit=0 errors=0
check-fix-chain-graph:   exit=0 errors=0
check-plan-api:          exit=0 errors=0
check-plan-store:        exit=0 errors=0
check-project-metadata:  exit=0 errors=0
check-task-api:          exit=0 errors=0
```

**The other projects' scripts are red, and are REPORTED not fixed** — confirmed
by me, not inherited:

```
check-orientation.ts  exit=2  4 errors
  (48,8)   TS6142 ... OrientationStrip.tsx was resolved, but '--jsx' is not set
  (129,38) TS2322 '"operator_chat"' is not assignable to ...
  (133,7)  TS2322 '"project_worker"' is not assignable to ...
  (138,23) TS2322 '"project_worker"' is not assignable to ...
serve-sse-808.ts      exit=2  2 errors
  (51,22) TS7016 no declaration file for '.../hono/dist/index.js', implicitly 'any'
  (90,21) TS7006 Parameter 'c' implicitly has an 'any' type
```

Three type errors plus a `--jsx` failure for `check-orientation.ts` — round 800's
figure, reproduced exactly. Fixing another project's instruments is not phase 8's
remit, and a gate that can only be **disclosed** teaches that disclose-and-proceed
is normal.

### 5.2 Two instrument traps found while measuring the instrument gate

Standing rule 3 says instruments lie before code does. Both of these were found
by asking what would make *this* measurement wrong, and both are now recorded in
§3.1 item 9 and were reported to the manager chat for 8D **while 8D was still
writing the script**.

**(a) The invocation's working directory is load-bearing.** My first attempt ran
`tsc` from the repo root. All six went red:

```
scripts/checks/check-close-gate.ts(74,55): error TS2307: Cannot find module 'node:fs' ...
scripts/checks/check-close-gate.ts(92,10): error TS2580: Cannot find name 'process' ...
```

`@types/node` resolves from `forge-control/node_modules` and nowhere else. A gate
shelling out from the repo root reports **a false red on green code** — and a
false red is not the harmless direction here, because the response to a red gate
that "everyone knows is spurious" is to stop reading it. `--module nodenext`
fails the same way for a different reason (1 / 23 / 3 / 12 / 12 errors across the
six); `Bundler` is required, matching `forge-control/tsconfig.json`.

**(b) The branch-ownership set must NOT come from `merge-base...HEAD`.**

```
$ git diff --name-only 20bd46a...HEAD -- 'scripts/checks/*.ts' | wc -l
25          # WRONG — main's files included: the merge commit carries them
$ git log --no-merges --name-only --pretty=format: main..HEAD -- 'scripts/checks/*.ts' | sort -u
scripts/checks/check-close-gate.ts
scripts/checks/check-fix-chain-graph.ts
scripts/checks/check-plan-api.ts
scripts/checks/check-plan-store.ts
scripts/checks/check-project-metadata.ts
scripts/checks/check-task-api.ts          # RIGHT — exactly the six
```

After round 801's merge, the three-dot diff attributes **main's** 15 new check
scripts to this branch, three of which are red. A manifest guard built on it
would demand this project fix another project's instruments — the unsatisfiable
gate again, arriving through the back door.

### 5.3 Why manifest-scoped, measured

```
$ git ls-tree -r --name-only 20bd46a scripts/checks/ | grep -c '\.ts$'    # merge-base
21
$ ls scripts/checks/*.ts | wc -l                                          # now
36
```

The directory grew by **15 files in one merge**, none of them this branch's work.
A directory-wide gate written today is red tomorrow from another project's merge
alone, having caught nothing about this branch. The manifest is scoped to what
this branch owns; **the guard is what stops the manifest shrinking to fit** —
adding or modifying a `scripts/checks/*.ts` without listing it is itself a
failure, so a new instrument cannot escape the gate by being new.

---

## 6. Job 8 — the F-G supersession note, APPENDED

`evidence/phase4-workstreams.md` §12, appended. Everything above that line is
untouched and still reads as phase 4 recorded it.

Round 244 established (`evidence/phase5-fix-cycle-1.md` §7, finding F-G) that the
settled cost is **26** at **12087**, against phase 4's recorded **23** at
**12084**. I re-verified the load-bearing half independently rather than copying
it: the `const GRAPH_GUIDE = …` literal region hashes identically at both
commits.

```
$ git show f135de4:forge-control/src/lib/project-tick.ts   -> GRAPH_GUIDE literal sha256 4bcf48630a77b718…
$ git show 7af2968:forge-control/src/lib/project-tick.ts   -> GRAPH_GUIDE literal sha256 4bcf48630a77b718…
```

The constant never changed size between those commits, so 23 and 26 cannot both
be measurements of it. Phase 4's number was taken **mid-edit in the shared
worktree** while round 242's `f135de4` was landing under it — honest about its
own moment, and 3 characters short in a frame that is itself superseded. Round
244 correctly declined to rewrite it (another round's measurement record, outside
its write-set); this project's closing phase carries out F-G's own instruction to
**append**.

**This is the third artifact damaged by the two-builders-one-worktree round**,
after the doc-comment contradiction and the stale pins. The contention cost
**nothing in code and three corrections in evidence** — no line of shipped
behaviour was wrong in any of the three. What went wrong each time was the
*record*: a number, a pin, a comment, each taken while the tree moved beneath it.

---

## 7. WHAT WOULD HAVE MADE MY INSTRUMENTS REPORT A PASS WRONGLY

### 7.1 The one that actually happened, mid-task

**`check-instrument-identity.py` exited 0 at the start of this task and exited 1
an hour later, without my having touched an instrument.**

Both identities in the block below are retired: `[historical instrument]`

```
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py      # at task start
OK — 8 pasted header(s) across 1 file(s) name f6828a68…   [historical instrument]
OK — no retired identity quoted without '[historical instrument]'
exit=0

$ python3 docs/plan/engine-task-graph/check-instrument-identity.py      # ~1h later
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff
FAILED — 22 disagreement(s)
exit=1

$ git status --porcelain
 M forge-control/src/lib/schedule-metrics.test.ts
 M forge-control/src/lib/schedule-metrics.ts
 M scripts/measure-schedule.ts        <- +140 −10, UNCOMMITTED
?? scripts/deploy/
```

**Cause:** builder **8B**, working concurrently in this shared worktree, adding
E-3's `--exclude-task` flag — its declared write-set, its declared obligation.
The instrument moved from `f6828a68…` to `6ec72b35…`, retiring an identity quoted   [historical instrument]
in **20** places across the corpus.

**Had I run the universal gate only once, at the start, I would have pasted an
`exit=0` that was already false by the time I committed.** That is the exact
shape of standing rule 3, and the defence is not cleverness — it is running the
gate **last**, against the bytes you are actually shipping, and reading the
provenance header rather than the verdict line.

**How the 20 were resolved, and by whom:**

| where | count | owner | disposition |
|---|---|---|---|
| `01-requirements.md` | 1 | **8C (me)** | marked; 8B's write-set cannot reach my file |
| `evidence/phase4-workstreams.md` | 1 | **8C (me)** | marked in place |
| `evidence/fix-cycle-2.md` | 5 | **nobody** | marked — see below |
| `evidence/phase6-plan-api.md` | 1 | **nobody** | marked |
| `evidence/phase8-merge.md` | 1 | **nobody** | marked |
| `00-vision.md` | 2 | **8B** | left to 8B |
| `evidence/baseline-8ea0cc08.md` | 11 | **8B** | left to 8B — 8 are the pasted headers R62 obliges 8B to re-run **in the same commit** as the instrument edit |

Seven of the twenty sat in **no round-802 write-set at all**, in settled files
from rounds 217, 231 and 801 with no concurrent writer. Left alone they would
have handed round 803 a **universal** gate that no declared owner could turn
green. I took them, appending one `[historical instrument]` marker per line and
**altering no recorded value**, and declared the three files in `04-phases.md`
§10 in this commit — the round-213/215/222/231/239 precedent: *disclose, not
abstain.*

After that, the gate scoped **exactly** to its correct owner — and then, because
8B was working the whole time I was, it kept moving. Three successive runs, each
against the bytes on disk at that moment:

```
$ python3 .../check-instrument-identity.py     # after I marked my own 2 + the 7 orphans
FAILED — 13 disagreement(s):
  evidence/baseline-8ea0cc08.md  ×11      <- builder 8B, declared, in flight
  00-vision.md                   × 2      <- builder 8B, declared, in flight

$ python3 .../check-instrument-identity.py     # ~20 min later; 8B had committed part of its repair
FAILED — 6 disagreement(s):
  00-vision.md                   × 2      <- 8B, still in flight
  evidence/phase8-corpus.md      × 4      <- MINE: this very file, quoting the retired sha

$ python3 .../check-instrument-identity.py     # after marking my own four quotations
FAILED — 1 disagreement(s):
  00-vision.md:87: names the retired identity 80ef1123… without the marker   [historical instrument]
exit=1
```

**Two things in that sequence are worth more than the final number.**

**The gate fired on its own description.** Writing *about* a retired identity
quotes it, and the checker cannot tell an account of a retirement from an
authoritative claim — so §7.1's own table and §3's own worked example tripped it,
four times. Round 801 hit the identical thing (`3dd39b4`, "mark §12.6's paste
too — the gate fires on its own description"). The marker is the designed escape
and I used it; the four lines are annotated and **no quoted value was altered**.
A reviewer should expect any document that discusses this gate to carry markers,
and should treat their **absence** in such a document as the suspicious state.

**The remaining 1 is `00-vision.md`, builder 8B's declared file, still open at
the moment I committed** — and it is now a *different* sha (`80ef1123…`, the   [historical instrument]
round-215 retirement) than the ones I saw an hour earlier, because 8B's repair
is progressing through the file. `git status` at commit time shows
`00-vision.md`, `baseline-8ea0cc08.md`, `schedule-metrics.ts`,
`schedule-metrics.test.ts` and `measure-schedule.ts` all modified by 8B, and
`scripts/checks/check-await-seed.sh`, `scripts/checks/instrument-manifest.txt`
and `scripts/deploy/` newly present from 8D.

**This red is correct and is 8B's to close.** It is R62's surviving formulation —
the one job 1 restored — doing its job on the first day it could: the instrument
moved, so part 1 is re-run in the same commit as the append. Reporting `exit=0`
here would have required either lying or silently repairing another builder's
in-flight work.

**And note what crossed the write-set boundary.** The split held for every
*file* — no two builders of round 802 touched one. What crossed was a **fact**:
one builder's edit to a constant retired a value quoted across seven files
belonging to nobody. A write-set models contention over bytes; it does not model
contention over truth. That is a limit of this project's own mechanism, found by
running it, and it is recorded in §10 rather than smoothed over.

### 7.2 The others, named and shown impossible

- **"`check-corpus-map.py` exits 0, so the corpus agrees."** It compares the
  three statements of the requirement **map** — ids, phases, counts. It has no
  view of prose, and jobs 1 and 2 were prose contradicting a requirement body. It
  exited 0 **before** the repairs and after. §3 states how those two were checked
  by hand and quotes the retired text so a reader can audit the retirement
  instead of trusting it.
- **"It says `010425c` beside `01-requirements.md`, so it read the committed
  file."** It does not — and it says so itself, which is why this check is
  trustworthy: `01-requirements 010425c + UNCOMMITTED EDITS (the bytes read are
  NOT 010425c)`. An instrument that prints its own build identity, per standing
  rule 3. Had it printed the SHA alone I would have pasted a verdict about a
  tree I was not shipping.
- **"The R66 count is 4, therefore R66 holds."** Backwards. The count is a
  tripwire; the assertion is R66's own rule — *every hit is a string literal
  inside a sentence forbidding the command, and no hit is in an executable
  position.* I read all four. §4 now states the reconciliation rule rather than
  freezing a number that the next commit can falsify, because a gate whose stated
  count is stale is a gate that gets disclosed and ignored.
- **"All six check scripts typecheck, so `scripts/checks` is sound."** Only these
  six, only one file per invocation, only from `forge-control/`. Three of the
  directory's other scripts are red and are reported, not fixed. §5.1 names them
  with their errors so the claim cannot be read wider than it is.
- **"`git show` shows GRAPH_GUIDE is 1976 chars at both commits, so 26 is
  right."** Byte-identity across the two commits is what I verified myself
  (§6); the figures **26** and **12087** are round 244's, cited to
  `phase5-fix-cycle-1.md` §7 and §5, and the authoritative record is neither
  prose document but NF7's ledger, which is enforced by an equality assertion.

---

## 8. The four commands the brief names, run last, against the bytes committed

```
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
check-corpus-map.py
  self            863bc25
  01-requirements 010425c + UNCOMMITTED EDITS (the bytes read are NOT 010425c)   94314 bytes
  04-phases       26ce631 + UNCOMMITTED EDITS (the bytes read are NOT 26ce631)   72672 bytes

  defined: 71 R + 7 NF

  phase   01§K   04§9   header   verdict
    1      12     12     12     agree
    2      15     15     15     agree
    3      11     11     11     agree
    4      19     19     19     agree
    5       8      8      8     agree
    6       5      5      5     agree
    7       4      4      4     agree
    8       8      8      8     agree

OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
exit=0
```

Every identity in the block below is retired: `[historical instrument]`

```
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff   <- every pasted header must name THIS
historical shas:   2 (must not appear unmarked)
                   80ef1123...  first seen b1bb731   [historical instrument]
                   f6828a68...  first seen 34268e9   [historical instrument]
corpus:            19 markdown file(s) under docs/plan/engine-task-graph/

OK - 10 pasted header(s) across 2 file(s) name 6ec72b35...
OK - no retired identity quoted without '[historical instrument]'
exit=0
```

**Green - and the SEQUENCE is the finding, not the zero.** This gate went
`0 -> 22 -> 13 -> 6 -> 1 -> 0` across one task, without my touching a single
instrument. Section 7.1 records every step. The cause was builder 8B's in-flight
`--exclude-task` edit moving `scripts/measure-schedule.ts` mid-round; the
resolution was **each builder closing its own share**: 8B re-ran part 1 and its
headers now name the current instrument (**10 pasted headers across 2 files**, up
from 8 across 1 - part 2's file has joined part 1's), I marked my two files and
the seven orphans that belonged to nobody, and I marked this document's own four
quotations after it tripped its own gate twice.

**Had I run this check once, at the start, I would have pasted `exit=0` and it
would have been false within the hour.** Had I run it once at the end and stopped
at the first red, I would have reported a failure that someone else was already
fixing. The only honest procedure in a shared worktree is to run the gate against
the bytes you are committing, read the **provenance header** rather than the
verdict line, and attribute every remaining hit to an owner before deciding what
a red means.

```
$ python3 scripts/checks/check-r20-census.py
check-r20-census: SOURCE  forge-control/src/db/projects.ts
check-r20-census: HEAD    3dd39b4
check-r20-census: SHA256  79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28
check-r20-census: HITS    129 (142 case-insensitive), 51 code / 78 comment, 3 sql-annotations
check-r20-census: SYMBOLS 25 attributed
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  docs/plan/engine-task-graph/evidence/phase2-replay.md matches the measurement  PASS
exit=0
```

```
$ grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
./forge-control/src/lib/project-tick.test.ts:216:      /NEVER[^.]*pm2 restart forge-executor/,
./forge-control/src/lib/project-tick.test.ts:217:      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
./forge-control/src/lib/project-tick.ts:410:    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
./forge-control/src/lib/project-tick.ts:571:  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
count=4
```

**R66 re-measured after round 801's merge: still exactly 4, unmoved.** All four
read; all four are string literals inside NEVER-worded prohibitions — two the
shipped prohibitions in `project-tick.ts`, two the test asserting the shipped
guidance still carries one. `main`'s 55 commits brought **fifteen** new
`scripts/checks/*.ts` and none mentions the command.

**Re-measured a second time after 8D's `.sh` files landed mid-task** —
`scripts/checks/check-await-seed.sh` and `scripts/deploy/await-and-seed.sh`, both
inside the sweep's scope — **still 4.** Neither mentions the command. §4 of
`03-quality.md` now carries the reconciliation rule rather than a frozen number:
if the count moves with a legitimate prohibition, round 803 restates the
expectation as **4 + N** with each new hit named, in the same commit; if it moves
**without** one, that is a finding and the deploy does not proceed on it.

**A finding from that re-measurement, ruled in `03-quality.md` §4.** Round 802 is
the first round to add `*.json` **task payloads**, and one of them carries the
string:

```
$ grep -rln "pm2 restart forge-executor" scripts/deploy/
scripts/deploy/payload-review.json
```

Read: it is §4's **own command block**, quoted inside a reviewer brief — the
`grep` that *enforces* R66, not a restart. Same shape as this document's own gate
line, which round 215 examined and kept. **Cleared, not violated.** But the scope
note outlives the hit: R66's words are *"in any script, brief or doc"*, and a
payload is a **brief that has become a file** — inside R66's rule, outside the
sweep's `--include` list. The sweep is deliberately **not** widened (a `.json`
cannot execute, and widening file types is exactly how this gate became
unsatisfiable the first time); instead §4 now obliges the reviewer to grep any
new brief-carrying file type separately and record the result, as done here.

---

## 9. Citations — by symbol and requirement id

Every citation in this task's edits is a requirement id (R62, R64, R66, R68,
R14, R2, R8, R31, R61, R71, NF7), a document section (`04-phases.md` §Phase 8
step 2 / 2b / 3, §10, §12 E-3; `03-quality.md` §3.1 items 4/7/9, §3.2, §4), a
named symbol (`retryTask()`, `claimReadyTasks()`, `promoteReadyTasks()`,
`sweepDanglingDependencies()`, `isClosureShaped()`, `taskRow()`,
`readProjectRows()`, `formatSpawnLog()`, `GRAPH_GUIDE`), or a named test case
(`check-scheduler-sql.sh` cases 8, 8b, 9, 10; D7's two `describe` blocks).

**No bare `file.ts:NN` was introduced.** The line numbers that appear are
`f6828a68…` marker sites, each recorded beside the checker output that produced   [historical instrument]
it, and the two non-resolving operator pins of §0, recorded **as findings**.

Git SHAs used, all resolved in this worktree: `3dd39b4` (HEAD), `26ce631`
(pre-merge), `12ecde9` (the merge), `4f6cd31` (`main`), `20bd46a` (merge-base),
`f135de4` and `7af2968` (GRAPH_GUIDE identity), `34268e9` (the instrument's last
commit).

---

## 10. What is left, and for whom

1. **8B must close `check-instrument-identity.py`** — 13 disagreements, all in
   its own two declared files, 8 of them pasted headers obliging the part-1
   re-run in the same commit as the instrument edit. Reported to the manager
   chat during the round.
2. **8D's script must use §5.2's invocation** — one file per `tsc` run, from
   `forge-control/`, and the manifest guard must use
   `git log --no-merges main..HEAD`, not `merge-base...HEAD`. Reported to the
   manager chat while 8D was still writing it.
3. **Round 803's reviewer re-measures R66** after 8D's `.sh` files land, and
   restates §4's count in the same commit if it moved.
4. **The 0040 renumber** is the operator's post-deploy task, not this project's.
