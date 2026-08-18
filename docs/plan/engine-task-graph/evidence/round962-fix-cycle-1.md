# Round 962 — fix cycle 1, against round 961's review

The six findings of round 961, the two operator items attached to them, and the
one-sentence blocker that had this project sitting at `max_cycles`.

This round is the one round 822 provisioned: it spends the 650 characters that
round reserved, and it spends them on the three ENGINE FACTS findings 3, 4 and 5
name. Findings 2 (the instrument that never executed its cap) and the NF7 budget
were closed by fix cycles 1–3 at rounds 820, 822 and 824; this round closes what
those left, and does not re-open them.

---

## 0. Provenance

| | |
|---|---|
| Branch | `project/8c591d6c` |
| Parent commit | `7444f8c` (round 824, fix cycle 3) |
| Reviewed tip in round 961 | `99b0d6a` |
| Live checkout (untouched) | `/opt/forge-ai-os` @ `91f6b28` |
| Node | v22.22.2 |

Everything below was run in this worktree. `/opt/forge-ai-os` was read (`git
status`, `git log`, `git show`) and never written; the one live-database access
is a read-only `SELECT`, invited by name in the operator's own note, and is
marked as such in §5.

---

## 1. What each finding got

| # | Finding | Disposition |
|---|---|---|
| 1 | `/opt/forge-ai-os` dirty | **Resolved, not by the prescribed command** — see §6 |
| 2 | `check-workstream-claim.ts` asserts a cap it never executes | Closed at round 820; §4 adds the round-962 rules to the same instrument |
| 3 | `"up to that cap"` teaches a 400 | **Closed** — §2, §3, §4 |
| 4 | FAN-OUT teaches parallelism the engine does not deliver | **Closed** — §2, §3, §4 |
| 5 | A lane holding a planner cannot get a correct integration task | **Closed** — §2, §3 |
| 6 | `write_set = []` on the task row | **Disclosed, not silently absorbed** — §7 |
| op | Cite the natural experiment | §5, re-counted independently |
| op | NF7 3700 confirmed, last routine widening | §2 — **no widening; the candidate was trimmed to fit** |
| op | Round 825's blocker (`executor.ts` INERT vs UNUSED) | **Closed** — §8 |

---

## 2. The budget: measured before the edit was written, and trimmed rather than raised

Round 822 built `measure-graph-guide-budget.ts` precisely so a round could size a
`GRAPH_GUIDE` change **before** committing to it. Used as intended:

```
$ cd forge-control && ./node_modules/.bin/tsx \
    ../scripts/checks/measure-graph-guide-budget.ts \
    --candidate ../docs/plan/engine-task-graph/evidence/round962-candidate-graph-guide.txt
```

| candidate | GRAPH_GUIDE | net delta | projected prompt | vs cap 12921 | vs 650 reserved |
|---|---|---|---|---|---|
| first draft | 2618 | **+667** | 12913 | fits, 8 left | **OVER by 17** |
| shipped | 2588 | **+637** | 12883 | fits, 38 left | **under, 13 left** |

**The first draft fit the cap and still was not good enough.** It overran round
822's 650-character reservation by 17. The operator's round-961 ruling made
BUDGET 3700 *"the LAST widening that gets to be routine"*, and answering a
17-character overrun by moving the ceiling is exactly the reflex that ruling
forbids. So the draft was **trimmed**, three edits, none of them to a rule:

| trim | before | after | saved |
|---|---|---|---|
| 1 | `so cap-1 are left to open` | `so cap-1 remain` | 10 |
| 2 | `say in each brief how many lanes it may open and leave that many unopened` | `…, and leave those unopened` | ~4 |
| 3 | `grouped into as many lanes as you want building at once` | `in as many lanes as you want building at once` | 9 |
| 4 | `creates the lane's integration task` | `creates its integration task` | 7 |

**NF7's LEDGER therefore gains `{ round: 962, spent: 637, reserved: 650 }`, and
`BUDGET` is untouched at 3700.** The condition the operator attached — that any
future increase must state what was retired first and why it did not pay — did
not have to be met, because there was no increase.

### 2.1 The measured text IS the shipped text

The failure this project keeps finding is an instrument that measured something
other than what shipped (*"a sha naming the worktree rather than the build"*).
So the candidate file and the committed constant were compared byte for byte
after the edit, not assumed equal:

```
written  len 2588 57762f7296f71ca5
candidate len 2588 57762f7296f71ca5
IDENTICAL — the measured text is the shipped text
```

`evidence/round962-candidate-graph-guide.txt` is kept for that reason: it is the
artefact the +637 was measured off, and it is checkable against the constant at
any later date.

### 2.2 One deliberate divergence from round 822's reference wording

`01-requirements.md` §J predicted this round would retire
`"the cheapest parallelism there is"` (33 characters), on finding 4's reasoning
that the phrase is false while every researcher lands in `"main"`.

**It was kept, and the reason is in §4.** The phrase was never false about
*research*; it was false about research **planned without a workstream**. Once
the guide says a task does not inherit its creator's workstream and tells the
planner to give each researcher a lane, the sentence describes something the
engine really delivers — which `6.8a`/`6.8b` now measure in both directions (1
wide without the field, 4 wide with it). Retiring the phrase would have removed
the true claim and left the reader without the reason the field matters.

Round 822 said explicitly that its reference wording was *a sizing input and not
the deliverable*, and that round 962 owned the text. This is that ownership
exercised, and it is recorded rather than left for a reviewer to notice.

---

## 3. The three rules, and why each is a fact rather than advice

Each was reachable only by reading a different file, and a planner who has not
read it plans a 400 or a 1-wide project.

### Finding 3 — the cap counts `main`

`createProject()` inserts the architect row with **no `workstream` column**
(`db/projects.ts`, the `INSERT INTO project_tasks … VALUES ($1, 0, 'architect', …)`
statement), so the schema default `'main'` applies and every project is *born*
occupying one workstream. `workstreamCapRefusal()` counts all distinct
workstreams of the project **regardless of status**. The openable count is
`cap - 1` = 5, so `"up to that cap"` over-promised by exactly one and taught the
400 it existed to prevent.

The **allocation rule** beside it exists because this one constant is
interpolated into the goal-mode architect *and* into every planner that
architect seeds. An unqualified project-wide ceiling read from two seats is read
twice as a whole budget. The guide now says the budget is the project's, and
tells the architect to state each planner's share in its brief.

### Finding 4 — a task does not inherit its creator's workstream

`workstream` arrives only from the POST body, and `createTask()` writes
`input.workstream ?? "main"`. There is no creator inheritance anywhere in the
engine. The rule belongs in **FAN-OUT**, where the fan-out decision is actually
made — the bullet three paragraphs earlier defines the field, but a planner
reading *"RESEARCH wide and early … the cheapest parallelism there is"* and
omitting the field gets N researchers in `main` running **one at a time**.

### Finding 5 — a lane opened for a task-creating task belongs to that task

R38 wants an integration task *"depending on every task of that workstream"*;
R29 fixes `depends_on` at insert; the route refuses dependency ids that do not
exist. An architect that opens a lane for a **planner** therefore can never
integrate it — the planner's children do not exist at the moment the only edge
that node will ever have must be named.

Round 961 offered two repairs: forbid opening such a lane, or make the planner
that owns the lane create its integration task. **The second was taken.** The
first would cost the concurrency the criterion exists to buy: round 961's own
answer to the brief's question 4 is that a compliant architect opens ~3 lanes on
the DoD-6 shape — *phase 2 ∥ phase 3 ∥ scout* — and two of those three are
planners. Forbidding planner lanes would put that back at 1 wide.

---

## 4. The instrument: `check-workstream-claim.ts`, §6B

Seven new checks, **19 → 34** at the default cap.

```
── 6B. round 962's rules (961 findings 3, 4, 5) ──────────────
PASS  6.7a from the state a project is BORN in (one row, "main"), 5 NEW lane(s) open before the 400 — walked against the guard, not read off a literal
PASS  6.7b GRAPH_GUIDE states that the cap COUNTS the "main" a project is born in …
PASS  6.7c GRAPH_GUIDE gives the project-wide budget an ALLOCATION RULE …
PASS  6.8a 4 researchers with depends_on [] and the workstream field OMITTED (so "main") spawn 1 this tick …
PASS  6.8b the same 4 with a lane each spawn all 4 — the difference between the two rows is the field, and nothing else
PASS  6.8c GRAPH_GUIDE states the non-inheritance in FAN-OUT …
PASS  6.9 GRAPH_GUIDE states that a lane opened for a task-creating task belongs to that task (clause only — …)

ALL PASS — 34 checks
```

**`6.8` is the one that executes rather than reads.** It drives the same
`spawnedThisTick()` — `selectClaimable()` then the round-222 belt — over a
controlled pair: same four tasks, same empty write-sets, same tick, the *only*
variable being the workstream field. Without it, 1. With it, 4. That is round
961's finding 4 as a measurement instead of an argument, and the pair is also
what stops either half being satisfied by a degenerate implementation returning a
constant.

**`6.7a` derives, it does not assert.** It walks `workstreamCapRefusal()` from
the one-row birth state and counts how many lanes open before the 400. Under
host overrides it follows the cap — `CAP=2 → 1`, `CAP=6 → 5`, `CAP=9 → 8` — so
it is not the hard-coded literal that made §3's top row inert at round 961.

**`6.9` is labelled a clause check because it is one.** Its premises — R29's
immutability and the unknown-id 400 — need a database and a server
(`check-task-api.ts`, `$SCRATCH_DATABASE_URL`). Saying so is the point: round
961's finding 2 was an instrument asserting a claim it never executed while
reading as though it had.

### 4.1 Mutation controls — four, each restored by hash

The new clause checks were attacked the way round 961 attacked their
predecessor. Each mutation was applied to `project-tick.ts`, the sweep re-run,
and the file restored and re-hashed against
`f04211421f2f5f41ea734e4e0431add71576dcebaf9859a1be4dac293e23eab7`.

| mutation | result |
|---|---|
| finding 3's cap-counts-main clause deleted | `FAIL 6.7b`, exit 1, restored OK |
| finding 4's non-inheritance clause deleted from FAN-OUT | `FAIL 6.8c`, exit 1, restored OK |
| finding 5's lane-ownership clause deleted | `FAIL 6.9`, exit 1, restored OK |
| finding 3's allocation rule deleted | `FAIL 6.7c`, exit 1, restored OK |

Each mutation was caught by **exactly one** check — its own — so the four are
independent rather than one assertion firing four times.

### 4.2 An unsatisfiable gate, found by running the sweep under a lawful override

Running `PROJECT_MAX_WORKSTREAMS=9` to test 6.7a surfaced a **pre-existing** red:

```
FAIL  3.9 9 workstream(s) over 6 independent tasks → width 9
1 FAILURE(S) out of 27 checks
```

Round 820 derived the lane count from the imported `CAP` (its own finding,
correctly fixed) but left the fixture at the literal **6** tasks it had always
had. The two disagree the moment a host raises the cap past 6: `i % 9` over six
rows can only produce six distinct workstreams, so the case asserted a width the
fixture could not express, and the sweep exited 1 on a host that had done
nothing wrong.

**Confirmed pre-existing, not introduced here:** the same command against `HEAD`'s
version of both files gives the identical failure at 27 checks.

This is the *"gate demanding ≥8 rows on a 7-row rail"* the standing rules name,
so it is **amended where it is enforced, in this commit**: the fixture is
`Math.max(6, c.lanes)` tasks, and the case label prints the count it measured.

| cap | verdict before | verdict after |
|---|---|---|
| unset (6) | ALL PASS 27 | **ALL PASS 34**, `3.6 … over 6 independent tasks → width 6` |
| 2 | ALL PASS | **ALL PASS 32** |
| 3 | ALL PASS | **ALL PASS 33** |
| 9 | **1 FAILURE of 27** | **ALL PASS 34**, `3.9 … over 9 independent tasks → width 9` |
| 12 | (unreached) | **ALL PASS 34**, `3.12 … over 12 independent tasks → width 12` |

The default path is byte-identical to what it measured before — six tasks, width
6 — which is the control that widening the rail changed nothing anyone was
relying on.

---

## 5. The natural experiment, re-counted rather than quoted

The operator's note supplies a controlled comparison: two live projects, the
same engine code, differing in whether their architect opened lanes. Re-counted
from `content_forge` with a **read-only `SELECT`** (invited by name in that
note; no write, no schema change, no service touched):

```sql
select p.id, p.name, count(distinct t.workstream), count(*)
from projects p join project_tasks t on t.project_id = p.id
where p.id::text like 'b7ab4c57%' or p.id::text like '7851068b%'
group by p.id, p.name;
```

| project | workstreams | tasks | runs measured | **peak concurrency** |
|---|---|---|---|---|
| `b7ab4c57` scripts-checks-typecheck-gate (DoD-6) | **1** | 35 | 38 | **1** |
| `7851068b` os-usable-for-work | **6** | 69 | 46 | **6** |

**Peak concurrency is derived, not eyeballed:** a sweep line over each run's
`(started_at, +1) / (completed_at, −1)` events, maximum of the running sum.

**Two honest corrections to the figures in the note, both upward, neither
changing its conclusion:**

- `os-usable-for-work` now holds **69** tasks, not 45 — it is live and has grown
  since the note was written. `b7ab4c57`'s 35 is unchanged.
- Its peak concurrency measures **6**, not 5. Guarded against the obvious
  artefact: runs still in flight would borrow `now()` as their end and could
  manufacture a peak, so the sweep was re-run over **completed runs only** — 44
  runs, no open intervals — and the peak is still **6**. Two runs are currently
  open; neither is load-bearing for the number.

**What this establishes, and what it does not.** Nothing about the scheduler
differs between the two rows — same deployed engine, round-222 belt in force for
both. The only difference is that the second project's brief carried a sentence
telling its architect to open a lane per concurrent lane, and its architect
opened six. So the constraint was **the criterion, not the engine**, and the
round-222 belt is retired as a suspected bottleneck.

Round 815's measurement is **not** rewritten to match. It measured what it
measured, honestly, at 1-wide; this is a second, independent observation that
agrees with its diagnosis, and two statements agreeing is worth more than one
restated.

---

## 6. Finding 1 — the live checkout, and why the prescribed command was not run

Round 961 found ` M forge-control-web/app/desktop/chat/AssistantThread.tsx` and
prescribed `git -C /opt/forge-ai-os checkout -- <that file>`.

**That file is clean now.** The `WINDOW_STEP = 60` chat-windowing fix was
committed as `1e0330b` (*"fix(chat): window the rendered thread — only the newest
60 messages mount"*, 2026-08-18 22:36 +0200) on `main`, and `1e0330b` is an
ancestor of live `HEAD` `91f6b28`. The work was not lost; it was landed. The
revert has no subject.

**What is dirty today is different work, and reverting it would have destroyed
it.** The live checkout now carries an unrelated in-progress feature — a
daily-goals / daily-surface build: five modified tracked files (`app/api.ts`,
`desktop/DesktopApp.tsx`, `desktop/nav-items.ts`, `db/cron.ts`, `index.ts`) and
twelve untracked paths including two `0042_*` migrations, `routes/daily.ts`,
`db/daily.ts`, `lib/day-score.ts` and its test, `GoalsSurface.tsx`,
`GoalsStats.tsx`, `desktop/goals/`, and four `docs/` specs.

Running round 961's command against today's tree would have discarded live work
belonging to someone else. A remediation prescribed against a tree that has since
moved is a **finding to re-report, not an instruction to execute blind** — and
discard is the dangerous verb here, not the safe one. Destructive operations also
require an explicit instruction naming *what is actually there*, which this one
does not.

**Preserved instead, read-only, live tree untouched:**

```
/opt/ai-os/uploads/<run>/20260818T223150Z-forge-ai-os-dirty-tracked.patch   (767 lines)
/opt/ai-os/uploads/<run>/20260818T223150Z-forge-ai-os-status.txt            (status + HEAD)
```

Escalated to manager chat `bfd1283a` (HTTP 202): that work is uncommitted on the
live checkout and **will collide at the next engine deploy**; it needs committing
to a branch by whoever owns it. That is a call for Konrad, not for this task.

---

## 7. Finding 6 — the write-set, disclosed

**This task was seeded with an empty `write_set`**, which is the defect round 961
located at the seeding site rather than in the builder. Every path below is
therefore an **undeclared write**, disclosed here, in `04-phases.md` §10, and in
the commit message — the three places the rule requires, in the one commit.

| file | why it had to change |
|---|---|
| `forge-control/src/lib/project-tick.ts` | the deliverable: findings 3, 4, 5 as three rules in `GRAPH_GUIDE`, plus the doc comment recording the measurement |
| `forge-control/src/lib/project-tick.test.ts` | NF7's LEDGER row `{962, 637, 650}` and a delivery control per finding — the gate is enforced here, so the row goes here |
| `scripts/checks/check-workstream-claim.ts` | §6B's seven checks; §5.6's `OPEN` label retired with the finding it names; §3's unsatisfiable-at-override fixture; the census |
| `docs/plan/engine-task-graph/03-quality.md` | round 825's blocker — `executor.ts` is banned, not inert |
| `docs/plan/engine-task-graph/04-phases.md` | §10, this disclosure, and round 962's row |
| `docs/plan/engine-task-graph/01-requirements.md` | §J closes the reservation it opened |
| `docs/plan/engine-task-graph/evidence/round962-fix-cycle-1.md` | this file |
| `docs/plan/engine-task-graph/evidence/round962-candidate-graph-guide.txt` | the artefact the +637 was measured off |

Nothing outside `docs/plan/engine-task-graph/`, `scripts/checks/` and the two
`forge-control` engine files was written. `/opt/forge-ai-os` was not written at
all.

---

## 8. Round 825's blocker — closed, and why it blocked

The engine had this project at **`max_cycles`** (cycles 1/2/3 at rounds 820, 822,
824; 825's re-review would have been a fourth). The operator unblocked it with
the instruction to fix the blocker here rather than seed a fourth cycle. **This
section is that fix, and it is why no fourth cycle was seeded.**

`03-quality.md` item 12 read:

> workspace.ts and executor.ts are in the mandate but match no ban pattern;
> listing them would be an INERT entry and the gate says so by name.

True of `workspace.ts`. **False of `executor.ts`**, which is in gate 6's ban
pattern verbatim. Verified against **the script's own output**, not the regex by
eye:

```
ban pattern: project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files

$ echo forge-control/src/lib/workspace.ts | GATES_ENGINE_ALLOW= bash scripts/checks/forbidden-file-diff.sh
PATHS MATCHING THE BAN (0) … clean                                        exit 0

$ echo forge-control/src/lib/executor.ts  | GATES_ENGINE_ALLOW= bash scripts/checks/forbidden-file-diff.sh
PATHS MATCHING THE BAN (1)
  FORBIDDEN  forge-control/src/lib/executor.ts                            exit 1
```

And listed, the gate names the two cases apart in its own words:

```
INERT   forge-control/src/lib/workspace.ts  (the ban never matches this path; this entry permits nothing)
UNUSED  forge-control/src/lib/executor.ts  (declared, but does not differ from main on this branch)
```

`INERT` = the ban never matches, the entry permits nothing. `UNUSED` = the ban
**does** match and the entry **would** permit it; it simply does not differ from
`main` today. Only the first is safe to add casually.

**Why this was a blocker and not a nit:** a future reader adding `executor.ts` to
`GATES_ENGINE_ALLOW` on the strength of that sentence would believe it a harmless
no-op while granting a real exemption for a file whose declared write-set in
`04-phases.md` §10 is *none*, and gate 6 is the only automated guard on it. A
document that mislabels a live waiver as inert is worse than no document.

---

## 9. Verification

| what | result |
|---|---|
| `pnpm typecheck` (forge-control) | **0** |
| `pnpm test` | **1294/1294**, 0 fail |
| `measure-graph-guide-budget.ts` | 12883 against cap 12921, **38 headroom**; ledger sums exactly |
| shipped constant vs measured candidate | **byte-identical**, sha256 `57762f7296f71ca5` |
| `check-workstream-claim.ts` | **ALL PASS — 34 checks**, exit 0 |
| …at `PROJECT_MAX_WORKSTREAMS` 2 / 3 / 9 / 12 | ALL PASS 32 / 33 / 34 / 34, exit 0 |
| mutation controls | 4 of 4 caught, each by its own check, each restored by hash |
| `gates-808.sh --strict` | §9.1 |

The NF7 ledger is an exact sum, not a bound: `11619 + 476 + 26 + 106 + 19 + 637
= 12883`, which is the live measurement. An unledgered edit anywhere else in the
planner prompt would fail with its own size in the message.
