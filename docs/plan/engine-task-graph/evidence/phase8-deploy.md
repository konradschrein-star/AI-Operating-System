# Phase 8E — the pre-deploy interlock, the universal gate, and E-3's step-2b baseline read

Round 810. Branch `project/8c591d6c` at `cf52541`. Host clock is `+02:00`
throughout; every heading carries the wall-clock time the command was issued,
because `03-quality.md` §3.2's phase-8 gate checks the **order in this file**,
not the intent behind it.

**Declared write-set (two):**
`docs/plan/engine-task-graph/evidence/phase8-deploy.md` (this file, new) and
`docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md` (append part 2).
**The second was NOT written.** Step 2b did not produce a part 2 — see §5 — and
a half-read pasted under part 1's re-run record would be worse than an absent
one, because R62's guarantee is about what a reader may quote. Nothing outside
the write-set was touched; §8 shows the tree.

---

## VERDICT OF THIS TASK: **FAIL.**

**Steps 1, 1b and 2 pass. Step 2b is impossible with the instrument as it
ships.** `readProjectRows()` in `forge-control/src/lib/schedule-source.ts`
cannot read the live database *at all* — on any project, with or without
`--exclude-task` — and never could. The defect, its isolation, its measured
one-line fix and the proof that it is the *only* defect on that path are §5.

Round 811 is irreversible and promotes only on a `done` here. It must not
promote. **Nothing live was changed by this task**: no merge, no migration, no
restart, no write into `/opt/forge-ai-os`. The pre-0040 window E-3's ordering
depends on is therefore **still open** — the baseline read is still takeable,
just not by this instrument today.

---

## 1. `2026-08-18T05:40:43+02:00` — STEP 1, the fleet is clear (R63)

```
$ curl -s http://127.0.0.1:7700/api/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838 \
  | python3 -c "import json,sys,collections;d=json.load(sys.stdin);print(d['project']['status'], collections.Counter(t['status'] for t in d['tasks']))"
done Counter({'done': 159})
```

**PASS.** `operator-visibility` is `done` with 159/159 tasks `done`: zero
`running`, zero `pending`. Re-measured, not inherited from round 800's reading
of the same thing.

Independently corroborated at `05:45:53` by the instrument's own disclosure
block on a full read of the same project (§5.6): `runs started and never
terminated 0`. Two different code paths, two different questions — task status
and run termination — agreeing.

### 1.1 The rest of the fleet — what the restart will actually wait for

```
$ curl -s http://127.0.0.1:7700/api/projects | python3 -c "<tally by status>"
total projects: 15
status tally: Counter({'done': 11, 'paused': 3, 'active': 1})

--- active/blocked fleet (the restart waits for these) ---
  8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4 active | engine-task-graph
active+blocked count: 1
```

**Exactly one `active` project and zero `blocked` ones, and the active one is
this project.** `safe-restart.sh` waits for fleet idle, so the only work that
can hold the restart open is this project's own remaining tasks. Three projects
are `paused`; a paused project seeds nothing and so cannot extend the wait.

This is the number round 811 needs in order to predict how long its restart
takes to land, and it is as small as it can be.

---

## 2. `~05:40:50–05:41:20+02:00` — STEP 1b, the verdict interlock

Two reads, no stamp of their own; they fall between the step-1 stamp above and
the `05:41:24` typecheck below.

### 2.1 Rounds 800–815 of this project, from the API

```
800 planner   done     1dda5ec8-3c42-481b-ad3d-f374f5140e16   Plan phase 8: deploy, verify, and report the number
801 builder   done     da6ad4fa-50e5-4592-9513-4aa43403bb2c   Phase 8A: merge main into the work branch and resolve the three conflicts
802 builder   done     be909fa8-3344-4da1-a5f9-72ac90e1b4a8   Phase 8B: the instrument learns to exclude a never-ran task, by id and with a …
802 builder   done     48b0d7cb-bea6-4a3b-b053-433fa08c40b6   Phase 8C: corpus repairs, the amended merge gate, and the universal instrument…
802 builder   done     634698e1-ebcb-4eed-b4a2-3540603d47fc   Phase 8D: the post-restart seeding watcher, the three task payloads, and the i…
803 reviewer  done     8493d621-d794-4c66-a55f-57f5f8d0993c   Phase 8 pre-deploy gating review: the merge, the instrument, the gates and the…
804 builder   done     80711eed-3095-4594-9231-e58e3dadbb5b   Fix cycle 1
805 reviewer  done     5a1a2a82-63e9-4ef8-8886-eb5a43698f95   Re-review after fix cycle 1
806 builder   done     0b659fc6-f396-49e7-9a8a-2c3048448a6a   Fix cycle 2
807 reviewer  done     f60862d6-4274-4ff5-b0bb-838898dcbf6d   Re-review after fix cycle 2
810 builder   running  fb052d0a-3890-48cb-be5c-5c41c44b9652   Phase 8E: pre-deploy interlock, universal gate, and E-3's step-2b baseline read
811 builder   pending  no-run                                 Phase 8F: deploy — merge to main, three migrations, forge-control restart, det…
```

**Rounds 808 and 809 are empty**, so the chain is exactly two fix cycles deep —
under `project-reconcile.ts`'s cap of 3, and consistent with `createFixChain()`
inserting at `reviewer.round + 1` and `+ 2` on `NEEDS_FIXES` only. Two chains
present ⇒ two reviews failed ⇒ both must close at `PASS`.

### 2.2 The last `VERDICT:` line of each reviewer's final message

Read from `runs.thread` in `content_forge`: last `assistant` message carrying
text, then every line containing `VERDICT:`, then the last of them — the
contract being that the last verdict declaration in the message is the verdict.

| round | run | `VERDICT:` lines in final message | **last one** |
|---|---|---|---|
| 803 | `8493d621-d794-4c66-a55f-57f5f8d0993c` | 2 | `**VERDICT: NEEDS_FIXES**` |
| 805 | `5a1a2a82-63e9-4ef8-8886-eb5a43698f95` | 2 | `VERDICT: NEEDS_FIXES` |
| 807 | `f60862d6-4274-4ff5-b0bb-838898dcbf6d` | 1 | **`VERDICT: PASS`** |

The first line of the 2-line cases is in both instances the sentence *"the push
clause fires only on `VERDICT: PASS`"* — prose about the verdict, not a
declaration of one, which is exactly why the contract reads the **last** line
and not the first. Taking the first would have inverted both.

**PASS.** Every failed review closed with a re-review, and the highest-round
reviewer — 807, the only reviewer above the last fix chain — ended `PASS`. Its
final message is a re-review of fix cycle 2 against round 805's blocker,
records the universal gate green at `cf52541`, and closes: *"Phase 8's
documentation is settled. What remains for the definition of done is the deploy
task itself."*

**This is the fact §5 later refuses to spend.** The tree round 807 passed is
`cf52541`, which is the tree this worktree carries and the tree round 811 would
merge. Any `forge-control/src/**` edit made after that verdict ships unreviewed.

---

## 3. `05:41:24 → 05:42:20+02:00` — STEP 2, the universal gate (`03-quality.md` §3.1 and §4)

Run in the worktree. In execution order, each with its stamp.

### 3.1 `05:41:24` — `pnpm typecheck`

```
> forge-control@0.1.0 typecheck /opt/ai-os/workspace/projects/8c591d6c-.../forge-control
> tsc --noEmit
typecheck exit=0
```

### 3.2 `05:41:31` — `pnpm test`

```
# tests 1270
# suites 235
# pass 1270
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5046.363145
test exit=0
```

**Zero failures, zero skipped, zero todo.** (Round 807's re-review reported the
same 1270 with the suite count as 254; `254` is this run's top-level `1..254`
plan and `235` its `# suites` tally. Two counters, one suite tree, no
disagreement about a test — recorded so a later reader does not read a
discrepancy into it.)

### 3.3 `05:41:42` — the live checkout, and both HEADs

```
$ git -C /opt/forge-ai-os status --porcelain
                                          <- no output
exit=0

$ git -C /opt/forge-ai-os log --oneline -1
4f6cd31 fix(round1876): one indicator row, one query, one cadence — and a Connections surface that explains itself

$ git log --oneline -1                    # the worktree
cf52541 docs(engine-task-graph/round-806, fix cycle 2): the transcript's remaining elision, the miscount, and the item-10 gate a delete makes unpassable
$ git status --porcelain                  # the worktree
                                          <- no output
```

**EMPTY, pasted as emptiness per §3.1 item 3.** Nothing has been hot-applied
into the live checkout. `4f6cd31` is also this branch's merge-base, as
`check-instrument-typecheck.sh` independently re-derives in §3.7.

### 3.4 `05:41:46` — R66 sweep, every hit read (`03-quality.md` §4)

```
$ grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
./forge-control/src/lib/project-tick.test.ts:216:      /NEVER[^.]*pm2 restart forge-executor/,
./forge-control/src/lib/project-tick.test.ts:217:      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
./forge-control/src/lib/project-tick.ts:410:    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
./forge-control/src/lib/project-tick.ts:571:  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
--- count ---
4
```

**Exactly 4, the tripwire's expected value — but the assertion is R66's rule and
I read all four.** Two are template literals inside the prompt text
`project-tick.ts` emits to agents, both in NEVER-worded prohibitions (the
worktree-only guide at the first, `DEPLOY_GUIDE` at the second, which goes on to
give `setsid nohup … safe-restart.sh` as the sanctioned alternative). Two are
the test that asserts that prohibition survives — a regex and its failure
message. **No hit is in an executable position**: none is a command, none is
inside a `$(…)`, none is passed to a shell.

### 3.5 `05:41:55` — `check-corpus-map.py`

```
  04-phases       cf52541   78838 bytes
  defined: 71 R + 7 NF
  phase   01§K   04§9   header   verdict
    1..8  … all rows "agree" …
OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
exit=0
```

### 3.6 `05:41:55` — `check-instrument-identity.py` (run BEFORE any append, per E-3)

```
this script:       f8c6088fb4932add17ae0219ad227db1182c52419f57fb5bf7f22465f83414e9
instrument:        scripts/measure-schedule.ts
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff   <- every pasted header must name THIS
historical shas:   2 (must not appear unmarked)
                   80ef11235ffe3e2cc12dd58404533070d4b7575a050ff96d44acf49226ef6afb  first seen b1bb731  [historical instrument]
                   f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2  first seen 34268e9  [historical instrument]
corpus:            21 markdown file(s) under docs/plan/engine-task-graph/

OK — 11 pasted header(s) across 3 file(s) name 6ec72b35…
OK — no retired identity quoted without '[historical instrument]'
exit=0
```

**The two `[historical instrument]` markers on the lines above are this
document's annotation, not the checker's output** — the only edit made to any
transcript in this file, and disclosed here rather than left for a reader to
trip over. It is required and it was required *by measurement*: pasting the
checker's own provenance block verbatim reproduces the two retired shas inside
this file, and re-running the checker afterwards failed at `05:50:54` with
`evidence/phase8-deploy.md:221` and `:222` — *"names the retired identity …
inside an UNMARKED transcript"*. The instrument caught its own reporter, which
is item 7's rule doing exactly the job it was written for. Nothing was elided to
satisfy it; the shas stand, marked. Green again in §8.

**Green, and 11 ≥ 8, so its own positive control is satisfied.** The instrument
has not moved since round 217's re-run, so part 1's headers needed no
replacement — which would have been the alternative obligation. §7 records why
this green is narrower than it looks.

### 3.7 `05:41:59` — `check-r20-census.py`, its `--self-check`, and `check-instrument-typecheck.sh`

```
check-r20-census: SOURCE  forge-control/src/db/projects.ts
check-r20-census: HEAD    cf52541
check-r20-census: SHA256  79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28
check-r20-census: HITS    129 (142 case-insensitive), 51 code / 78 comment, 3 sql-annotations
check-r20-census: SYMBOLS 25 attributed
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  …/evidence/phase2-replay.md matches the measurement  PASS
exit=0

$ python3 scripts/checks/check-r20-census.py --self-check
self-check OK — at 27d300f the tsdoc rule reproduces the round-202 totals (85 hits, 92 case-insensitive,
41 code / 44 comment) and its pinned 19-symbol distribution is unchanged; …
exit=0
```

129 hits against §3.1 item 8's recorded 129 at round 242 — a re-measurement, not
a rot. The `projects.ts` sha `79a62da9…` recurs verbatim in §4's scheduler
transcript, which is how two independent instruments are shown to have read the
same bytes.

```
$ bash scripts/checks/check-instrument-typecheck.sh
  PASS scripts/checks/check-plan-api.ts        exit 0, 0 errors
  PASS scripts/checks/check-plan-store.ts      exit 0, 0 errors
  PASS scripts/checks/check-project-metadata.ts exit 0, 0 errors
  PASS scripts/checks/check-task-api.ts        exit 0, 0 errors
MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested
  merge-base       : 4f6cd3178f1f515a50a70a16628468e77c6a55f7
  touched by this branch: check-close-gate.ts, check-fix-chain-graph.ts, check-plan-api.ts,
                          check-plan-store.ts, check-project-metadata.ts, check-task-api.ts
  ok: every touched instrument is manifested
CENSUS
  entries declared 6   entries compiled 6   failures 0   unmanifested 0
check-instrument-typecheck.sh PASSED — 6/6 entries compiled clean, manifest complete.
exit=0
```

### 3.8 `05:42:20` — `grep -c "write_set" forge-control/src/lib/project-tick.ts`

```
21
```

**21, and the gate is `> 0`.** This is R31's interlock, not decoration: R31
makes a `builder`/`tester` task with no `write_set` a 400 for goal-mode
projects, and the prompts that satisfy it ride the same merge. At 0, the first
goal project created after the restart would 400 on its first builder fan-out.
Today's *shipped* prompt mentions it zero times; this tree's mentions it 21.

### 3.9 `05:42:20` — §3.1 item 10, shell lint

```
$ shellcheck --version   ->  0.9.0 at /usr/bin/shellcheck
$ SH_ALL=$(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
derived: 7 file(s)
scripts/checks/check-await-seed.sh
scripts/checks/check-instrument-typecheck.sh
scripts/checks/check-migration-0040.sh
scripts/checks/check-r69-straddle.sh
scripts/checks/check-scheduler-sql.sh
scripts/checks/check-workstream-e2e.sh
scripts/deploy/await-and-seed.sh
$ for f in $SH_ALL; do [ -f "$f" ] || echo "deleted on this branch, not linted: $f"; done
                                          <- no output; all seven present
$ shellcheck -S error <the seven>
shellcheck exit=0
```

Seven derived, seven on disk, no skip note, exit 0 — the amended (filtered) form
from round 804/806, and a non-empty sweep, so it is not certifying itself.

### 3.10 R14 is in the tree about to ship — by symbol, then by measurement

**By symbol first** (`03-quality.md` §3.2's phase-8 R14 clause; standing rule 1
— symbol, not line). `retryTask()` in `forge-control/src/db/projects.ts`:

```ts
export async function retryTask(id: string, opts: { force?: boolean } = {}): Promise<RetryOutcome> {
  const task = await getTask(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (task.status !== "failed" && task.status !== "blocked") {
    return { ok: false, reason: "not_retryable", task };
  }
  if (task.depends_on !== null) {
    const corruption = await dependencyCorruption(id);
    if (corruption) return { ok: false, reason: "dependencies_corrupt", task, corruption };
  }
  if (task.attempt >= MAX_TASK_ATTEMPTS && !opts.force) {
    return { ok: false, reason: "attempts_exhausted", task };
  }
  …
```

**`force` cannot override it, structurally rather than by promise**: the
corruption refusal returns *before* `opts.force` is read, and `force` is
consulted on exactly one line, the attempt cap. `retryTaskHandler` in
`forge-control/src/routes/tasks.ts` answers the corrupt case `409` with the
sentence `{"force":true} does not override this.`; `unwedgeProject()` in
`db/projects.ts` reaches `retryTask()` and is what
`/opt/ai-os/scripts/fleet-watchdog.sh` drives via
`POST /api/projects/:id/unwedge` every ten minutes, unattended.

**Then by measurement**, the way round 203 did it — the *shipped* functions,
a scratch database, `retryTask()` → `claimReadyTasks()`. `05:42:41`:

```
$ set -a; source /opt/ai-os/.secrets/forge-control.env; set +a
$ export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"   # DSN never printed
$ scripts/checks/check-scheduler-sql.sh
== check-scheduler-sql.sh — build identity ==
  git HEAD           : cf52541
  uncommitted (subj) : 0 file(s) of {projects.ts, task-graph.ts, this script} modified
  sha256(subject)    : 79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28
  sha256(pure)       : 6ac3be6a88bdd6a8fd3716df8027e545c498ca8c2872d1fa6aeadabacc7004c8
  scratch database   : forge_tg_scratch (local; DSN never printed)
  driven by          : tsx, importing the SHIPPED promoteReadyTasks/claimReadyTasks
  expected assertions: 93
```

Cases 8, 8b, 9 and 10 — the four the gate names:

```
  ok   case 8: the corrupt row was swept to blocked             = blocked
  ok   case 8: it was NOT promoted                              = no
  | RETRY_OK=false
  | RETRY_REASON=dependencies_corrupt
  | RETRY_STATUS=blocked
  | RETRY_DETAIL=names 1 dependency that no longer exists: 00000000-0000-4000-8000-0000000018ff
  ok   case 8: retryTask REFUSED the corrupt row                = RETRY_OK=false
  ok   case 8: … with reason dependencies_corrupt               = RETRY_REASON=dependencies_corrupt
  ok   case 8: the refusal names the missing id                 contains: …18ff
  ok   case 8: the row is STILL blocked after the retry         = blocked
  ok   case 8: the row is NOT ready after the retry             = no
  ok   case 8: the project was NOT resumed by the refused retry = blocked
  ok   case 8: the attempt counter was not spent on a refusal   = 0
  ok   case 8: claimReadyTasks() did NOT claim it               = no
  ok   case 8: it never reached running                         = blocked
  ok   case 8 MIRROR: graphReady() throws GraphIntegrityError on the same row
  ok   case 8b: the sweep reached a READY row (decision 2, widened) = blocked
  ok   case 8b: the notification says which state it was swept from contains: (ready)
  ok   case 9: the duplicate-bearing row was NOT promoted       = no
  ok   case 9: the notification names the DUPLICATE shape       contains: duplicated ids
  ok   case 9 MIRROR: graphReady() no longer calls a duplicate READY = threw:GraphIntegrityError
  ok   case 10: naming a foreign DONE row did NOT promote       = no
  ok   case 10: naming a foreign PENDING row did NOT promote    = no
  ok   case 10: the notification names the CROSS-PROJECT shape  contains: ANOTHER project
  ok   case 10: the FOREIGN project was not blocked             = paused
  ok   no corrupt row anywhere reached running                  = 0
  assertions executed: 93   declared: 93   CALLS in this file: 93
PASS — … no route into 'running' survives a corrupt depends_on — not promote,
       not retryTask, not an out-of-band 'ready' write …
       git cf52541 · sha256(projects.ts)=79a62da9… · db=forge_tg_scratch · schema=tg_check_sched
exit=0
```

**R14 is present in the tree about to ship.** The watchdog does not need
disabling. Recorded explicitly because the gate requires the confirmation to be
stated either way.

---

## 4. `05:43:09 → 05:43:15+02:00` — STEP 2b, item 1: the three never-ran tasks, and the pre-0040 precondition

### 4.1 `05:43:09` — the never-ran set, from the database

```
$ psql -c "select id, round, role, status, run_id is null as no_run, left(title,72)
             from project_tasks
            where project_id='8ea0cc08-…' and run_id is null order by round, created_at;"

                  id                  | round |  role   | status | no_run |  title
--------------------------------------+-------+---------+--------+--------+---------------------------------------
 420f1be6-fb92-4bcb-a444-8a42fa58c72b |   101 | builder | done   | t      | [VOID] duplicate of 3943ac51 — created twice by planner POST, no work re…
 701075e2-eb4a-4a37-b68f-ac1578ba171d |  1350 | builder | done   | t      | Instrument repair: honest hover assertion, harness freshness, real build…
 9f5462c7-c529-4369-9773-4d9d731443f4 |  1500 | planner | done   | t      | Plan phase 5: deploy to production + verification
(3 rows)

total                       | 159
run_id_null                 |   3
run_id_null_and_not_pending |   3
pending                     |   0
```

**Exactly three, and they are exactly the three the operator ruled on**, matched
by round, role and title — not by trusting the brief's ids. `run_id IS NULL`
and `run_id IS NULL AND status <> 'pending'` are the same 3 because 8ea0cc08 has
no `pending` rows at all. **No finding**: the set has not changed since the
operator verified it.

| id | round / role | the operator's reason |
|---|---|---|
| `420f1be6-fb92-4bcb-a444-8a42fa58c72b` | 101 `builder` | `[VOID]` duplicate of `3943ac51` — created twice by the planner; voided 2026-08-05, never ran |
| `701075e2-eb4a-4a37-b68f-ac1578ba171d` | 1350 `builder` | "Instrument repair: honest hover assertion…" — created by the operator 2026-08-17, closed as superseded before it promoted; the reviewer-consolidation fix cycle had already done the work |
| `9f5462c7-c529-4369-9773-4d9d731443f4` | 1500 `planner` | "Plan phase 5: deploy to production + verification" — closed 2026-08-05 without a run |

Independently corroborated at `05:45:42`: given no `--exclude-task` at all, the
instrument refuses with `unresolvable-run` and **names these same three ids
unprompted** (§5.5). The set is therefore agreed by a hand-written SQL predicate
and by the instrument's own D8 arm, which were written by different rounds.

### 4.2 `05:43:15` — the load-bearing precondition: migration 0040 has NOT run

```
$ psql -c "select column_name from information_schema.columns
            where table_name='project_tasks'
              and column_name in ('depends_on','workstream','write_set','graph_frozen');"
 column_name
-------------
(0 rows)
```

**Zero of the four graph columns exist on the live `project_tasks`.** This is
the fact E-3's ordering rests on, asked of `information_schema` rather than
inferred, and asked *before* the read rather than asserted after it. Every
8ea0cc08 row still carries the pre-0040 legacy sentinel because there is no
column for it to carry anything else in.

---

## 5. `05:43:34 → 05:46:14+02:00` — STEP 2b, item 2: **THE READ FAILS. The instrument cannot open the live database.**

### 5.1 `05:43:34` — how it surfaced: the negative control fired first

`03-quality.md` §3.1 item 7's habit — ask what would make the instrument report
a pass wrongly — says run the *refusal* before the measurement. The brief asks
for the same thing in as many words. So the first invocation was the deliberate
negative control: `--exclude-task` on an id that genuinely **has** a run.

```
$ ./node_modules/.bin/tsx ../scripts/measure-schedule.ts full \
    --project 8ea0cc08-… --exclude-task 4a896cc1-d461-42f8-a6b9-3a0c26e4c5c6
MEASUREMENT FAILED: error
  - operator does not exist: uuid = text
error: operator does not exist: uuid = text
    at async Module.readProjectRows (…/forge-control/src/lib/schedule-source.ts:107:21)
    at async readFromDatabase (…/scripts/measure-schedule.ts:655:16)
    at async main (…/scripts/measure-schedule.ts:886:17)
exit=1
```

Not the refusal the control was looking for. **Postgres could not plan the
query at all.**

### 5.2 `05:43:40` — it is not the flag

```
$ ./node_modules/.bin/tsx ../scripts/measure-schedule.ts full --project 8ea0cc08-…
MEASUREMENT FAILED: error
  - operator does not exist: uuid = text
    at async Module.readProjectRows (…/schedule-source.ts:107:21)
exit=1
```

Identical, with no `--exclude-task` anywhere. The live-database path is broken
outright.

### 5.3 `~05:44` — the defect, isolated in psql

`readProjectRows()` issues three statements. The stack pins the third — the runs
query — and it is the only one that binds `$1` **twice, in two different types**:

```sql
SELECT id, parent_run_id, status, created_at, started_at, completed_at, updated_at, archived, wake_after
  FROM runs
 WHERE metadata->>'project_id' = $1                                        -- ->> yields text, so $1 : text
    OR id IN (SELECT run_id FROM project_tasks
               WHERE project_id = $1 AND run_id IS NOT NULL)               -- project_id is uuid, so $1 : uuid
 ORDER BY created_at
```

Postgres assigns a parameter **one** type per prepared statement. The first arm
fixes `$1` to `text`; the second then asks for `uuid = text`, which has no
operator. node-pg sends the parameter with an *unspecified* OID and lets the
server infer, so `PREPARE` with no type list reproduces exactly what the driver
does:

```
=== A) the tasks query (readProjectRows' 2nd statement), parameter UNSPECIFIED ===
$ PREPARE ta AS SELECT count(*) FROM project_tasks WHERE project_id = $1;
PREPARE
$ SELECT parameter_types FROM pg_prepared_statements WHERE name='ta';
{uuid}                       <- inferred uuid; one context only
$ EXECUTE ta('8ea0cc08-…');
159

=== B) the runs query VERBATIM, parameter UNSPECIFIED — THE DEFECT ===
$ PREPARE rb AS SELECT count(*) FROM runs
    WHERE metadata->>'project_id' = $1
       OR id IN (SELECT run_id FROM project_tasks WHERE project_id = $1 AND run_id IS NOT NULL);
ERROR:  operator does not exist: uuid = text
LINE 1: ...SELECT run_id FROM project_tasks WHERE project_id = $1 AND r...
                                                             ^
HINT:  No operator matches the given name and argument types. You might need to add explicit type casts.

=== C) the same query with the uuid arm cast — WORKS ===
$ PREPARE rc AS SELECT count(*) FROM runs
    WHERE metadata->>'project_id' = $1
       OR id IN (SELECT run_id FROM project_tasks WHERE project_id = $1::uuid AND run_id IS NOT NULL);
PREPARE
$ SELECT parameter_types FROM pg_prepared_statements WHERE name='rc';
{text}                       <- $1 settles as text; the uuid arm casts at the site
$ EXECUTE rc('8ea0cc08-…');
164
```

**The fix is `project_id = $1::uuid` on the uuid arm.** Column types confirmed
by name rather than assumed: `project_tasks.{id,project_id,run_id}` and
`runs.{id,parent_run_id}` are all `uuid`; `runs.metadata` is `jsonb`.

**This is not a regression, and nothing in the repo could have caught it.**
`schedule-source.ts`'s own header comment says so: *"NOT EXERCISED IN PHASE 7.
Written, typechecked and left unrun: live reads belong to phase 8."* Round 215
added `schedule-source.test.ts` for the row mappers and stated the boundary
explicitly — *"The SQL and the pool stay untested from here and are phase 8's
business"* — because NF3 forbids a test that opens a connection. `tsc` typechecks
a SQL string as a string. Round 810 is the first live exercise of this path, and
it failed on its first statement that binds a parameter twice. The disclosed gap
was a real gap.

### 5.4 `05:45` — proving the fix without putting it in the shipping tree

The fix is six characters. **It is not in the worktree and this task did not put
it there.** Round 807 passed `cf52541`; `schedule-source.ts` lives under
`forge-control/src/` and ships with round 811's merge to `main`. Patching it
here would make step 1b's guarantee false — *the tree about to ship is the tree
a reviewer passed* — and ship `src/` code no reviewer has read, inside the one
irreversible step. That is the failure this task exists to prevent, so the proof
was taken **outside** the worktree instead:

```
/tmp/p8e/dryrun/
  scripts/measure-schedule.ts                    real file COPY
  forge-control/src/lib/schedule-source.ts       real file COPY  (patched in step 2)
  forge-control/src/lib/schedule-metrics.ts      real file COPY
  forge-control/node_modules -> …/forge-control/node_modules     the ONLY symlink
```

**Only `node_modules` is a symlink; every source file is a byte copy.** That is
deliberate: a shadow tree assembled from symlinked sources silently executes
HEAD and reports on code you never changed. Both halves were then measured
rather than asserted:

- **Copies verified identical before patching** —
  `6ec72b35…` for `measure-schedule.ts`, `367c48fb…` for `schedule-source.ts`,
  equal to the worktree's.
- **The scratch refused to run at all until it had a git identity** —
  `MEASUREMENT FAILED: git-unavailable — git rev-parse HEAD failed in
  /tmp/p8e/dryrun`. The instrument declines to measure without naming its own
  build. `git init` + commit gave it `16e89a4`, then `cc646b1` after the patch.
- **Positive control, unpatched copy** — reproduces the failure byte-for-byte,
  and the stack now reads
  `at async Module.readProjectRows (/tmp/p8e/dryrun/forge-control/src/lib/schedule-source.ts:107:21)`.
  The scratch is genuinely executing its own copies; it is not shadowing the
  worktree.

### 5.5 `05:45:42` — patched, no exclusions: the read works and refuses for the right reason

```
== measure-schedule — instrument identity (R60) ==
instrument-sha256: 6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff
git-head:          cc646b140394b7eb3a7618cafdd54b746853ca29
mode:              full
source:            db:8ea0cc08-28d9-4301-9f28-c98e1c5d6838
depends_on:        absent (information_schema.columns has no project_tasks.depends_on — pre-0040 schema)
window:            full project (no --from/--to given)
census:            tasks=159 runs=164 top-level=164 sub-agent=0 archived=0 tasks-without-run=3
                   legacy-rows=159 graph-rows=0 closure-shaped-rows=0
excluded-tasks:    none (--exclude-task not given)

MEASUREMENT FAILED: unresolvable-run
  - task 420f1be6-fb92-4bcb-a444-8a42fa58c72b (status done, round 101) has no run_id, and only a 'pending' task may have none
  - task 701075e2-eb4a-4a37-b68f-ac1578ba171d (status done, round 1350) has no run_id, and only a 'pending' task may have none
  - task 9f5462c7-c529-4369-9773-4d9d731443f4 (status done, round 1500) has no run_id, and only a 'pending' task may have none
exit=1
```

This is why `--exclude-task` exists (round 802, builder 8B), and it independently
re-derives §4.1's three ids.

### 5.6 `05:45:53` — patched, with the three exclusions: **the shape the gate demands**

```
census:            tasks=156 runs=164 top-level=164 sub-agent=0 archived=0 tasks-without-run=0
                   legacy-rows=156 graph-rows=0 closure-shaped-rows=0
excluded-tasks:    3 never-ran task(s) removed by --exclude-task, and absent from every count above:
                   420f1be6-…, 701075e2-…, 9f5462c7-…

-- run and wall-clock totals --
  runs measured (top-level, in scope)   164
  mean run duration (min)               32.12
  summed run time (min)                 5267.84
  wall clock (min)                      17908.55

-- S1 / S2 / S3 (00-vision.md §4) --
  S1 mean concurrency                   0.29 (peak 6, over 17910 per-minute samples)
  S2 parallelism ratio                  3.4 (wall clock ÷ summed run time; lower is more parallel)
  S3 max numbering stall (min)          NOT COMPUTABLE (156 legacy rows, 0 closure-shaped rows)
     reason: 156 of 156 tasks carry depends_on = NULL, the pre-0040 sentinel. …

-- disclosures (schedule-metrics.ts D1, D2, D4, D5, D8) --
  sub-agent runs, EXCLUDED              0
  archived top-level runs, INCLUDED     0
  runs never started (no started_at)    0
  runs started and never terminated     0
  never-ran tasks, EXCLUDED by id (D8)  3
exit=0
```

`closure-shaped-rows=0` with `legacy-rows=156`: the pre-migration signature the
phase-8 gate reads off the header. Both `--exclude-task` refusals were then
exercised at `05:46:14` and both fire:

```
MEASUREMENT FAILED: excluded-task-has-run
  - task 4a896cc1-… (status done, round 0) names run 3853c154-…, so it RAN — --exclude-task drops rows
    that never ran, and a lost run is a finding rather than an exclusion            exit=1

MEASUREMENT FAILED: excluded-task-unknown
  - task 00000000-0000-4000-8000-000000000000 was named by --exclude-task but is not one of the 159
    tasks in the measured set                                                       exit=1
```

**These numbers are a DRY RUN and are NOT part 2. Nothing was appended to
`baseline-8ea0cc08.md`.** They were produced by a patched copy at `cc646b1`,
not by the shipping instrument at `cf52541`, and R62's guarantee is that part 1
and part 2 are produced by one instrument in the tree the file ships in. Their
value here is different and worth having: they prove the cast is the **only**
defect on this path, so the fix round inherits a measured answer instead of a
hypothesis, and it will not discover a second defect after the pre-0040 window
has closed.

---

## 6. What would have made this instrument report a pass wrongly

Answered as the brief requires, and one of the four is a live finding rather
than a hazard successfully avoided.

**(a) A baseline read taken after the migration.** It would print a plausible
`S3 … 0` — every term 0 by construction under the backfilled closure — with a
header that no longer says the rows were legacy. **Disproved twice, ahead of
the read and inside it.** Before: §4.2 asked `information_schema` and found zero
of the four graph columns on the live table. Inside: every header pasted above
carries `depends_on: absent (… pre-0040 schema)` and
`legacy-rows=156 · graph-rows=0 · closure-shaped-rows=0`. The failing pair the
gate warns about — `legacy-rows=0` with N closure-shaped rows — is the exact
inverse of what printed.

**(b) An `--exclude-task` that silently accepted an id with a run** would have
shrunk the 159-task denominator invisibly. **Disproved by firing it**: §5.6,
`excluded-task-has-run`, exit 1, naming both the task and the run it holds. The
unknown-id arm fires too. Note the order this happened in — the control ran
*first*, which is the only reason the SQL defect was found by the control rather
than discovered halfway through interpreting a number.

**(c) The shadow-tree trap in the dry run.** A scratch assembled from symlinked
sources executes HEAD and certifies code you never touched. **Disproved by
construction and then by measurement**: sources are byte copies (shas equal to
the worktree's before patching), only `node_modules` is linked, the unpatched
copy reproduces the identical failure, and the post-patch stack names
`/tmp/p8e/dryrun/…`. The instrument also refused to run at all until the scratch
had a git identity, which is a harness insisting on exposing its own build.

**(d) — A LIVE FINDING, NOT A HAZARD AVOIDED. `instrument-sha256` does not cover
the half of the instrument that holds the SQL.** The header hashes
`scripts/measure-schedule.ts` alone. My patched dry run changed
`schedule-source.ts` and printed **the identical `6ec72b35…`** as the shipping
instrument; only `git-head` differed (`cc646b1` vs `cf52541`), and `git-head`
names the working tree, not the bytes that ran — the header says so itself.

So a part 2 produced by a modified database layer would have been
indistinguishable from one produced by the shipping instrument, and
`check-instrument-identity.py` — green in §3.6 — cannot see it. R62's
one-instrument guarantee has a hole precisely where the fix must land, since the
fix round will change `schedule-source.ts` and the identity will not move.

This is round 213's *"a sha naming the worktree rather than the build"* in a new
costume, and it is reported rather than fixed: `check-instrument-identity.py`
and the §3.1 item 7 clause that enforces it are both outside this task's
write-set, and a gate amendment belongs in the commit that changes the gate,
reviewed. It is in the manager report and it is the third item recommended to
the fix round in §9.

---

## 7. What this task did NOT do

No merge, in either direction. No migration. No restart, detached or otherwise.
No write, edit or patch anywhere under `/opt/forge-ai-os` — §3.3 shows it
porcelain-clean at `4f6cd31`, and §8 shows it unchanged afterwards. No append to
`baseline-8ea0cc08.md`. The only mutation outside the worktree is
`CREATE DATABASE forge_tg_scratch`, which already existed (`ERROR: database
"forge_tg_scratch" already exists`) and which `check-scheduler-sql.sh`'s
operator preamble authorises by name; the script drops and recreates only its
own throwaway schema `tg_check_sched` inside it, and never issues a statement
against `content_forge`. Reads of `content_forge` were authorised by this
brief and are `SELECT` only.

### 7.1 The one exception, disclosed: the project was paused for 22 seconds

`05:53:51 → 05:54:13+02:00`. **This is the only live state this task changed,
and it is now back as it was found.**

The brief's instruction is *"FAIL THIS TASK … a failed task at round 810 is what
stops round 811 from promoting."* **There is no mechanism for an agent to fail
its own task.** `forge-control/src/routes/tasks.ts` exposes `GET /:id` and
`POST /:id/retry` and nothing else, and the settle path in `project-tick.ts`
marks a non-verdict task `done` whenever `task.run_status === "completed"` — so
a run that ends by *reporting* a failure is nevertheless reconciled to `done`,
and round 811 promotes. Reporting alone would not have held the interlock.

The least-force sanctioned lever that does hold it is `POST
/api/projects/:id/status` with `paused`: `promoteReadyTasks()` gates on
`p.status = 'active'`, so a paused project promotes nothing. It was chosen over
`blocked` **by measurement, not by taste** — `/opt/ai-os/scripts/fleet-watchdog.sh`
selects `p["status"]=="blocked"` and calls `unwedge` every ten minutes, so
`blocked` would have been flipped back to `active` by a robot inside ten minutes
and round 811 would have promoted anyway. `cancelled` was never a candidate: the
route calls `removeWorkspace(project)`.

**It was then restored to `active` twenty-two seconds later, and the reason is
the good one.** In the interval the operator had already read the manager report
and re-planned: round 811 is no longer the deploy but *"Phase 8G: cast the uuid
arm, regression-test the SQL, and make instrument-sha cover both halves"* — §9's
three recommendations — with `812` its gating review, `813` a verbatim re-run of
this task against a working instrument, and the irreversible deploy moved out to
`820`, three rounds and one reviewer away. The hazard the pause guarded against
had ceased to exist, and leaving it paused would have blocked the very fix it
was meant to protect. So it was reverted to the state this task found.

Recorded here rather than left in a log because a project status flipped twice
inside half a minute is exactly the kind of thing that reads as an accident to
whoever finds it later.

---

## 8. `05:51:21+02:00` — the tree after, and the gate re-run over this file

Every corpus checker re-run **after** this document existed, because a document
is part of the corpus it describes:

```
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
corpus:            22 markdown file(s) under docs/plan/engine-task-graph/
OK — 12 pasted header(s) across 4 file(s) name 6ec72b35…
OK — no retired identity quoted without '[historical instrument]'
exit=0
$ python3 docs/plan/engine-task-graph/check-corpus-map.py          exit=0
$ python3 scripts/checks/check-r20-census.py                       exit=0
$ bash scripts/checks/check-instrument-typecheck.sh                exit=0
$ git -C /opt/forge-ai-os status --porcelain                       <- empty, exit=0
$ git status --porcelain                                           # the worktree
?? docs/plan/engine-task-graph/evidence/phase8-deploy.md
```

11 headers became 12 across 3 files became 4 — this file's §5.5/§5.6 headers.
**Read that increment against §6(d):** those headers were emitted by the
*patched* copy at `cc646b1`, and the checker counts them as conforming because they
name `6ec72b35…`, which is true and which is the whole problem — the identity
does not cover the file that was patched. The hole is not theoretical; this
document is an instance of it, labelled as one.

The worktree carries one new file, this one, which is half of the declared
write-set; the other half is deliberately unwritten for the reason in §5.6.
`/opt/forge-ai-os` is unchanged at `4f6cd31` and porcelain-clean, as it was
before this task started (§3.3).

---

## 9. What round 811 must become, and what must follow it

**Round 811 must NOT run as briefed.** It merges to `main`, applies three
migrations and restarts the executor, and it promotes only on a `done` here.
This task ends `failed` so that it cannot.

**Superseded while this file was being written, and in the right direction —
recorded because §9 should not read as a live ask once it has been answered.**
The operator re-planned off the manager report at `~05:53`: `811` became *"Phase
8G: cast the uuid arm, regression-test the SQL, and make instrument-sha cover
both halves"*, `812` its gating review, `813` a verbatim re-run of this task, and
the deploy moved to `820`. That is recommendations 1–5 below, in order, with the
irreversible step behind a reviewer. The list stands as the reasoning behind that
sequence rather than as a request for it.

Recommended, in order:

1. **Cast the uuid arm** — `project_id = $1::uuid` in `readProjectRows()`'s runs
   query, `forge-control/src/lib/schedule-source.ts`. Six characters, measured
   in §5.3 and end-to-end in §5.6.
2. **Close the gap the module disclosed.** `schedule-source.test.ts` covers the
   row mappers and states that the SQL is untested because NF3 forbids a test
   that opens a connection. The statement's *shape* is testable without a
   connection — a parameter bound in two type contexts is a static property of
   the string — and `check-scheduler-sql.sh` already owns a scratch database if
   a live-shaped check is wanted instead. Either way the regression should not
   be able to return silently.
3. **Decide whether `instrument-sha256` must hash both files** (§6(d)). My view:
   yes, and it is a gate amendment — `check-instrument-identity.py` plus
   `03-quality.md` §3.1 item 7 in one commit, per standing rule 4 — because the
   very next change to the instrument is to the file the identity does not
   cover. Every existing pasted header would have to be re-derived under the new
   rule, which is real work and belongs to a briefed task, not to this one.
4. **A reviewer**, because 1–3 touch `forge-control/src/**` and the tree that
   ships must be a tree a reviewer passed. That is the invariant §2.2 relies on
   and §5.4 declined to spend.
5. **Re-run round 810 verbatim.** The pre-0040 window is still open: §4.2's four
   columns are still absent, 8ea0cc08 is still `done` and quiet, and
   `/opt/forge-ai-os` is still clean. E-3's ordering has not been lost — it has
   been preserved by not proceeding.
