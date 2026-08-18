# Phase 8E RE-RUN — the pre-deploy interlock, with an instrument that can read

Round 816. Branch `project/8c591d6c` at `ff85fad`, worktree clean before and
after every measurement below. Host clock is `+02:00` throughout; every heading
carries the wall-clock time the command was issued, because `03-quality.md`
§3.2's phase-8 gate checks the **order in the file**, not the intent behind it.

**Declared write-set (four), all four written:**
`docs/plan/engine-task-graph/evidence/phase8-deploy-rerun.md` (this file, new),
`docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md` (APPEND part 2),
`docs/plan/engine-task-graph/evidence/baseline-8ea0cc08-part2-raw.txt` (new — the
complete 18,058-line stdout of the read, so the 17,910 per-minute samples are
relocated rather than elided), and one row in `docs/plan/engine-task-graph/04-phases.md`
§10 declaring exactly this set. Nothing under `forge-control/src/**`, no
migration, no merge, no restart; §7 shows the tree.

---

## VERDICT OF THIS TASK: **PASS.**

**Steps 1, 1b, 2 and 2b all pass, and step 2b produced a COMPLETE read.** Part 2
of `evidence/baseline-8ea0cc08.md` is therefore appended — the append E-3 and
R62 have owed since round 213, and the first one ever taken. Every one of the
six predictions the operator handed this round matched digit for digit (§5), and
every headline number was independently re-derived from SQL by a path that
shares no code with the instrument (part 2 §10).

The pre-0040 window was still open when the read was taken and is still open
now: `information_schema` had **0** of the four graph columns on
`project_tasks` at `07:02:13`, `/opt/forge-ai-os` is porcelain-clean at
`4f6cd31`, and nothing was migrated, merged or restarted.

**Round 810's §9 recommendation 5 — "re-run round 810 verbatim" — is discharged
by this document.** Round 820 may promote on the evidence here; the deploy
itself is still its own briefed task and this round did none of it.

---

## 0. Why the WHOLE interlock, and what had moved since round 810

Round 810 passed steps 1, 1b and 2 and blew the fuse on 2b: `readProjectRows()`
could not query at all. Rounds 811–814 fixed and reviewed that. A re-run of the
failed step alone would have certified a tree nobody measured, because the tree
moved underneath every other step as well:

| | round 810 (`cf52541`) | round 816 (`ff85fad`) |
|---|---|---|
| `pnpm test` | 1270 pass / 235 suites | **1281 pass / 237 suites**, 0 fail / 0 skipped / 0 todo |
| universal gate items | 1–10 | **1–11** — item 11 (`scripts/check-schedule-sql.sh`, "the SQL is executed") was added by round 813 and did not exist at round 810 |
| shell lint file list | 7 derived | **8 derived** (round 811's `scripts/check-schedule-sql.sh` joined it) |
| the highest-round reviewer | 807 | **814** |
| `instrument-sha256` | one file, `6ec72b35…` `[historical instrument]` | the two-file composite `fb5a6434…`, **re-derived here from the disk** |
| the live read | impossible — `operator does not exist: uuid = text` | **exit 0** |

This re-run is therefore strictly wider than the original, not a repetition of
it.

---

## 1. `2026-08-18T06:59:36+02:00` — STEP 1, the fleet is clear (R63)

```
$ curl -s http://127.0.0.1:7700/api/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838 \
  | python3 -c "import json,sys,collections;d=json.load(sys.stdin);print(d['project']['status'], collections.Counter(t['status'] for t in d['tasks']))"
done Counter({'done': 159})
exit=0
```

**PASS.** `operator-visibility` is `done` with 159/159 tasks `done`: zero
`running`, zero `pending`. Re-measured, not inherited from round 810's reading of
the same thing. Corroborated at `07:02:39` by the instrument's own disclosure
block on the full read (§4.5): `runs started and never terminated 0`, and again
at `07:02:09` by SQL (`0 pending, 0 running`). Three code paths, three
questions — task status, run termination, row census — agreeing.

### 1.1 `06:59:39` — the rest of the fleet, which is what the restart waits for

```
total projects: 15
status tally: Counter({'done': 11, 'paused': 3, 'active': 1})

--- active/blocked fleet (the restart waits for these) ---
  8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4 active | engine-task-graph
active+blocked count: 1
```

**Exactly one `active` project, zero `blocked`, and the active one is this
project.** Unchanged from round 810. `safe-restart.sh` waits for fleet idle, so
the only work that can hold round 820's restart open is this project's own
remaining tasks; the three `paused` projects seed nothing and cannot extend the
wait.

---

## 2. `06:59:47 → 07:00:10+02:00` — STEP 1b, the verdict interlock

### 2.1 `06:59:47` — rounds 800–825, from the API

```
 800 planner   done     1dda5ec8-…  Plan phase 8: deploy, verify, and report the number
 801 builder   done     da6ad4fa-…  Phase 8A: merge main into the work branch and resolve the three conflicts
 802 builder   done     be909fa8-…  Phase 8B: the instrument learns to exclude a never-ran task …
 802 builder   done     48b0d7cb-…  Phase 8C: corpus repairs, the amended merge gate, and the universal instru…
 802 builder   done     634698e1-…  Phase 8D: the post-restart seeding watcher, the three task payloads …
 803 reviewer  done     8493d621-…  Phase 8 pre-deploy gating review …
 804 builder   done     80711eed-…  Fix cycle 1
 805 reviewer  done     5a1a2a82-…  Re-review after fix cycle 1
 806 builder   done     0b659fc6-…  Fix cycle 2
 807 reviewer  done     f60862d6-…  Re-review after fix cycle 2
 810 builder   done     fb052d0a-…  Phase 8E: pre-deploy interlock, universal gate, and E-3's step-2b baseline read
 811 builder   done     7330c6e0-…  Phase 8G: cast the uuid arm, regression-test the SQL, and make instrument-sha …
 812 reviewer  done     940f6b9f-…  Phase 8G gating review: the cast, its red-mutated test, and the sha amendment
 813 builder   done     b2bc0cae-…  Fix cycle 1
 814 reviewer  done     450c9c29-…  Re-review after fix cycle 1
 816 builder   running  a953ddf7-…  Phase 8E RE-RUN: the pre-deploy interlock, verbatim, with a working instrument
 820 builder   pending  no-run      Phase 8F: deploy — merge to main, three migrations, forge-control restart …
```

Three fix chains, each at `reviewer.round + 1` and `+ 2`: 803→804/805,
805→806/807, 812→813/814. Rounds 808, 809, 815 and 817–819 are empty, so no
chain is deeper than two cycles and each is under `project-reconcile.ts`'s cap
of 3.

**Round 810 reads `done` although it reported FAIL — its own §7.1 finding,
re-observed.** There is no mechanism for an agent to fail its own task: the
settle path in `project-tick.ts` marks a non-verdict task `done` whenever
`task.run_status === "completed"`. Round 810 held the interlock by pausing the
project for 22 seconds instead, and recorded why. **This round needed no such
lever**, because nothing failed; the row above is left exactly as the engine
wrote it.

### 2.2 `06:59:57` — the last `VERDICT:` line of every reviewer's final message

Read from `runs.thread` in `content_forge`: last `assistant` message carrying
text, then every line containing `VERDICT:`, then the last of them — the
contract being that the last verdict declaration in the message is the verdict.

| round | run | `VERDICT:` lines in final message | **last one** |
|---|---|---|---|
| 803 | `8493d621-d794-4c66-a55f-57f5f8d0993c` | 2 | `**VERDICT: NEEDS_FIXES**` |
| 805 | `5a1a2a82-63e9-4ef8-8886-eb5a43698f95` | 2 | `VERDICT: NEEDS_FIXES` |
| 807 | `f60862d6-4274-4ff5-b0bb-838898dcbf6d` | 1 | **`VERDICT: PASS`** |
| 812 | `940f6b9f-8535-43a9-859e-7d8723d2e044` | 1 | `**VERDICT: NEEDS_FIXES**` |
| 814 | `450c9c29-d728-49ad-966b-1b0e1845e861` | 1 | **`VERDICT: PASS`** |

The first line of each 2-line case is the sentence *"the push clause fires only
on `VERDICT: PASS`"* — prose about a verdict, not a declaration of one, which is
exactly why the contract reads the **last** line. Taking the first would invert
both.

**PASS.** Every failed review closed with a re-review, and the highest-round
reviewer — 814, the only reviewer above the last fix chain — ended `PASS`.

### 2.3 `07:00:10` — the tree the reviewer passed IS the tree in this worktree

This is the load-bearing half of step 1b, and round 810 stated it as an
invariant: *the tree about to ship is the tree a reviewer passed.* Round 811
edited `forge-control/src/**`, so the invariant now has to be re-established
against round 814 rather than 807.

```
$ git log -6 --pretty='%h  %cI  %s'
ff85fad  2026-08-18T06:45:48+02:00  docs(engine-task-graph/round-813, fix cycle 1): item 11 re-run on the committed tree …
823a131  2026-08-18T06:45:22+02:00  fix(engine-task-graph/round-813, fix cycle 1): the SQL gate nobody had to run …
c442de8  2026-08-18T06:24:13+02:00  fix(engine-task-graph/round-811, phase 8G): the uuid cast, a SQL test that has seen the bug …

$ psql -c "select id, started_at, completed_at from runs where id in (…)"   -- times are UTC
 7330c6e0 (round 811 builder)   2026-08-18 03:56:17+00 → 04:25:10+00
 940f6b9f (round 812 reviewer)  2026-08-18 04:25:24+00 → 04:33:30+00
 b2bc0cae (round 813 builder)   2026-08-18 04:33:46+00 → 04:47:47+00
 450c9c29 (round 814 reviewer)  2026-08-18 04:47:59+00 → 04:57:44+00
```

Round 813's two commits land at `06:45:22` and `06:45:48 +02:00` = `04:45:22`
and `04:45:48 UTC`, **inside** its own run window and **before** round 814
started at `04:47:59 UTC`. So round 814 reviewed `ff85fad`, which is this
worktree's HEAD, and the worktree is porcelain-clean at it (§3.3). **No
`forge-control/src/**` byte on this branch is unreviewed.** This round's own
commits are markdown and one `.txt` artifact under `docs/plan/`, so they do not
move the shipping source tree.

---

## 3. `07:00:16 → 07:01:50+02:00` — STEP 2, the universal gate (`03-quality.md` §3.1 items 1–11, and §4)

In execution order, each with its stamp.

### 3.1 `07:00:16` — item 1, `pnpm typecheck`

```
> forge-control@0.1.0 typecheck /opt/ai-os/workspace/projects/8c591d6c-…/forge-control
> tsc --noEmit
typecheck exit=0
```

### 3.2 `07:00:26` — item 2, `pnpm test`

```
1..256
# tests 1281
# suites 237
# pass 1281
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5885.466467
test exit=0
```

**Zero failures, zero skipped, zero todo.** 1270→**1281** and 235→**237** since
round 810: rounds 811 and 813 added the `schedule-source.test.ts` SQL suites
(§4.1's parameter-ordering assertions and §4.2's executed regression). The
increment is accounted for, which is the only reason a moved test count is not
itself a finding.

### 3.3 `07:00:37` — item 3, the live checkout, and both HEADs

```
$ git -C /opt/forge-ai-os status --porcelain
                                          <- no output
exit=0

$ git -C /opt/forge-ai-os log --oneline -1
4f6cd31 fix(round1876): one indicator row, one query, one cadence — and a Connections surface that explains itself

$ git log --oneline -1                    # the worktree
ff85fad docs(engine-task-graph/round-813, fix cycle 1): item 11 re-run on the committed tree, and the manifest line this evidence now owes the next digest move
$ git status --porcelain                  # the worktree
                                          <- no output
$ git merge-base main HEAD
4f6cd3178f1f515a50a70a16628468e77c6a55f7
```

**EMPTY, pasted as emptiness per §3.1 item 3.** Nothing has been hot-applied
into the live checkout, and `4f6cd31` is still this branch's merge-base.

### 3.4 `07:00:41` — item 3's companion, the R66 sweep, every hit read (`03-quality.md` §4)

```
$ grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
./forge-control/src/lib/project-tick.test.ts:216:      /NEVER[^.]*pm2 restart forge-executor/,
./forge-control/src/lib/project-tick.test.ts:217:      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
./forge-control/src/lib/project-tick.ts:410:    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
./forge-control/src/lib/project-tick.ts:571:  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
--- count ---
4
```

**Exactly 4 — but the assertion is R66's rule and all four were read.** Two are
template literals inside prompt text `project-tick.ts` emits to agents, both
NEVER-worded prohibitions (the worktree-only guide at the first, `DEPLOY_GUIDE`
at the second, which goes on to offer `setsid nohup … safe-restart.sh` as the
sanctioned alternative). Two are the test that asserts the prohibition survives —
a regex and its failure message. **No hit is in an executable position**: none is
a command, none is inside a `$(…)`, none is passed to a shell.

### 3.5 `07:00:45` — `check-corpus-map.py`

```
  self            863bc25
  01-requirements c442de8   95455 bytes
  04-phases       823a131   82125 bytes
  defined: 71 R + 7 NF
  phase   01§K   04§9   header   verdict
    1..8  … all eight rows "agree" …
OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
exit=0
```

### 3.6 `07:00:49` — item 7, `check-instrument-identity.py`, run BEFORE any append (E-3)

```
this script:       4ee7789135556f423e95b916cef1322a33e8a528d4e8bcea6ea4e26d54b03dee
instrument-sha256: fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b   <- every pasted header must name THIS
instrument-files:  39dee069b52c53ab75098b663dec01e1a92b8491e088644ff6cda61605ac1d03  scripts/measure-schedule.ts
                   c00fd096e0b8ddc57bad52d4bb6ef27dd17793aeda542603570ce3f454e861e5  forge-control/src/lib/schedule-source.ts
historical shas:   8 (must not appear unmarked)
corpus:            23 markdown file(s) under docs/plan/engine-task-graph/

OK — 11 pasted header(s) across 3 file(s) name fb5a6434…
OK — 27 pasted manifest line(s) name the current digest of their half
OK — no retired identity quoted without '[historical instrument]'
exit=0
```

**The identity was RE-DERIVED, not pasted — which is the one instruction this
round was given twice.** Independently, from the disk, by the command the
checker itself prints:

```
$ sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts
39dee069b52c53ab75098b663dec01e1a92b8491e088644ff6cda61605ac1d03  scripts/measure-schedule.ts
c00fd096e0b8ddc57bad52d4bb6ef27dd17793aeda542603570ce3f454e861e5  forge-control/src/lib/schedule-source.ts
$ sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum
fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b  -
```

**It did not move since round 811, and the reason is a fact rather than an
assumption.** The operator's warning was explicit — *if the fix round touches
`schedule-source.ts`, that value changes, and a pasted-but-stale identity is
precisely what R62 exists to catch.* So the question was asked of git at
`07:00:58`:

```
$ git show --stat --oneline 823a131            # round 813, fix cycle 1
 docs/plan/engine-task-graph/03-quality.md          |  81 ++++++++
 docs/plan/engine-task-graph/04-phases.md           |  20 ++
 .../engine-task-graph/check-instrument-identity.py |  31 ++-
 .../engine-task-graph/evidence/phase8-uuid-cast.md | 212 +++++++++++++++++++++
 forge-control/src/lib/schedule-source.test.ts      |  89 +++++++++
$ git show --stat --oneline ff85fad
 .../engine-task-graph/evidence/phase8-uuid-cast.md | 34 ++++++++++
```

Round 813 touched `schedule-source.**test**.ts`, not `schedule-source.ts` — and
said so in its commit message, deliberately, because one comment byte would have
retired `fb5a6434…` under eleven live headers that are transcripts of runs.
**The composite legitimately did not move; the value in every header in this
document and in part 2 was produced by the instrument at run time and confirmed
against the disk twice.**

### 3.7 `07:01:10` — item 8, `check-r20-census.py` and its `--self-check`

```
check-r20-census: SOURCE  forge-control/src/db/projects.ts
check-r20-census: HEAD    ff85fad
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

129 hits, the same value round 810 measured and round 242 recorded — a
re-measurement, not a rot. The `projects.ts` sha `79a62da9…` recurs verbatim in
§3.11's scheduler transcript, which is how two independent instruments are shown
to have read the same bytes.

### 3.8 `07:01:13` — item 9, `check-instrument-typecheck.sh`

```
  git HEAD         : ff85fad63f0721ca544f0bd77ca4c44683432027
  manifest sha256  : 96c57c1365c7257c8b493087c8389cfbe49a0f399e620e89cef4cd15cd068d32
  manifest entries : 6
  PASS scripts/checks/check-close-gate.ts        exit 0, 0 errors
  PASS scripts/checks/check-fix-chain-graph.ts   exit 0, 0 errors
  PASS scripts/checks/check-plan-api.ts          exit 0, 0 errors
  PASS scripts/checks/check-plan-store.ts        exit 0, 0 errors
  PASS scripts/checks/check-project-metadata.ts  exit 0, 0 errors
  PASS scripts/checks/check-task-api.ts          exit 0, 0 errors
MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested
  merge-base       : 4f6cd3178f1f515a50a70a16628468e77c6a55f7
  ok: every touched instrument is manifested
CENSUS
  entries declared 6   entries compiled 6   failures 0   unmanifested 0
check-instrument-typecheck.sh PASSED — 6/6 entries compiled clean, manifest complete.
exit=0
```

### 3.9 `07:01:32` — R31's interlock, and item 10's shell lint

```
$ grep -c "write_set" forge-control/src/lib/project-tick.ts
21
```

**21, and the gate is `> 0`.** R31 makes a `builder`/`tester` task with no
`write_set` a 400 for goal-mode projects, and the prompts that satisfy it ride
the same merge. Today's *shipped* prompt mentions it zero times; this tree's
mentions it 21, so no window opens between R31 going live and R47–R53 landing.

```
$ shellcheck --version   ->  0.9.0 at /usr/bin/shellcheck
$ SH_ALL=$(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
derived: 8 file(s)
scripts/checks/check-await-seed.sh
scripts/checks/check-instrument-typecheck.sh
scripts/checks/check-migration-0040.sh
scripts/checks/check-r69-straddle.sh
scripts/checks/check-scheduler-sql.sh
scripts/checks/check-workstream-e2e.sh
scripts/check-schedule-sql.sh
scripts/deploy/await-and-seed.sh
$ for f in $SH_ALL; do [ -f "$f" ] || echo "deleted on this branch, not linted: $f"; done
                                          <- no output; all eight present
$ shellcheck -S error <the eight>
shellcheck exit=0
```

**Eight derived, eight on disk, no skip note, exit 0.** Seven at round 810;
round 811's `scripts/check-schedule-sql.sh` is the eighth, and it entered the
derived list without anyone typing it — which is the property the derived form
exists for. A non-empty sweep, so it is not certifying itself.

### 3.10 `07:01:39` — **item 11, the gate that did not exist at round 810**

`bash scripts/check-schedule-sql.sh` — round 813 made this universal gate item
11 after round 812 measured what its absence cost: transpose `RUNS_SQL`'s two
`OR` arms keeping `$1::uuid` verbatim, and every other gate in this document
passes while a real Postgres answers `operator does not exist: text = uuid`,
SQLSTATE `42883`.

```
  ok 3 - NEGATIVE CONTROL: transposing the OR arms breaks the statement even WITH the cast
  ok 4 - the shipped RUNS_SQL prepares and executes with the same binding
  ok 5 - a malformed project id fails loudly at the cast rather than matching nothing
  ok 6 - the tasks statement and the schema probe execute, before and after 0040
1..5
# tests 40
# suites 5
# pass 40
# fail 0
# skipped 0
# todo 0
scratch cluster left at /tmp/schedule-sql-check.1863084 (server stopped; remove it when you like)
exit=0
```

**40/40.** It provisions its own throwaway cluster on a unix socket with
`listen_addresses=''`, so it reads no live data and touches no configured
database — which is why it is runnable at every phase and not only at the
deploy. Its subtest 4 is the direct answer to round 810's death: the shipped
statement now prepares and executes.

### 3.11 `07:01:46 → 07:01:50` — R14 is in the tree about to ship

**By symbol first** (standing rule 1 — symbol, not line). `retryTask()` in
`forge-control/src/db/projects.ts`:

```ts
export async function retryTask(
  id: string,
  opts: { force?: boolean } = {},
): Promise<RetryOutcome> {
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
```

**`force` cannot override it, structurally rather than by promise.** Inside
`retryTask()` the identifier `force` occurs on exactly two lines — the parameter
declaration and the attempt-cap test — and the corruption refusal returns
*before* either is read. `/opt/ai-os/scripts/fleet-watchdog.sh` drives
`POST /api/projects/:id/unwedge` every ten minutes unattended, `unwedgeProject()`
reaches `retryTask()`, and `retryTaskHandler` answers the corrupt case `409`.

**Then by measurement**, the way round 203 did it — the *shipped* functions, a
scratch database, `retryTask()` → `claimReadyTasks()`:

```
$ set -a; source /opt/ai-os/.secrets/forge-control.env; set +a
$ export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"   # DSN never printed
$ bash scripts/checks/check-scheduler-sql.sh
  git HEAD           : ff85fad
  uncommitted (subj) : 0 file(s) of {projects.ts, task-graph.ts, this script} modified
  sha256(subject)    : 79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28
  sha256(pure)       : 6ac3be6a88bdd6a8fd3716df8027e545c498ca8c2872d1fa6aeadabacc7004c8
  scratch database   : forge_tg_scratch (local; DSN never printed)
  driven by          : tsx, importing the SHIPPED promoteReadyTasks/claimReadyTasks
  expected assertions: 93

  ok   case 8: the corrupt row was swept to blocked             = blocked
  ok   case 8: retryTask REFUSED the corrupt row                = RETRY_OK=false
  ok   case 8: … with reason dependencies_corrupt               = RETRY_REASON=dependencies_corrupt
  ok   case 8: the refusal names the missing id                 contains: …18ff
  ok   case 8: the attempt counter was not spent on a refusal   = 0
  ok   case 8: claimReadyTasks() did NOT claim it               = no
  ok   case 8: it never reached running                         = blocked
  ok   case 8 MIRROR: graphReady() throws GraphIntegrityError on the same row
  ok   case 8b: the sweep reached a READY row (decision 2, widened) = blocked
  ok   case 8b: the notification says which state it was swept from contains: (ready)
  ok   case 9: the duplicate-bearing row was NOT promoted       = no
  ok   case 9: the notification names the DUPLICATE shape       contains: duplicated ids
  ok   case 10: naming a foreign DONE row did NOT promote       = no
  ok   case 10: the notification names the CROSS-PROJECT shape  contains: ANOTHER project
  ok   case 10: the FOREIGN project was not blocked             = paused
  assertions executed: 93   declared: 93
PASS — … no route into 'running' survives a corrupt depends_on — not promote,
       not retryTask, not an out-of-band 'ready' write …
       git ff85fad · sha256(projects.ts)=79a62da9… · db=forge_tg_scratch · schema=tg_check_sched
exit=0
```

*(The block above is the four gate-named cases and the footer, selected from a
93-assertion run by grep; the complete run is reproducible with the two commands
shown and exits 0.)*

**R14 is present in the tree about to ship. The watchdog does not need
disabling** — recorded explicitly because the gate requires the confirmation to
be stated either way.

---

## 4. `07:02:09 → 07:02:39+02:00` — STEP 2b, the baseline read

The read itself, its census and its numbers are **part 2 of
`evidence/baseline-8ea0cc08.md`**, appended in this same commit, with the
instrument's stdout pasted verbatim and its per-minute samples committed beside
it. This section records the interlock's view of it: the preconditions, the
controls, and the order.

### 4.1 `07:02:09` — the never-ran set, from the database

```
                  id                  | round |  role   | status | no_run |  title
--------------------------------------+-------+---------+--------+--------+-------------------------------------
 420f1be6-fb92-4bcb-a444-8a42fa58c72b |   101 | builder | done   | t      | [VOID] duplicate of 3943ac51 …
 701075e2-eb4a-4a37-b68f-ac1578ba171d |  1350 | builder | done   | t      | Instrument repair: honest hover …
 9f5462c7-c529-4369-9773-4d9d731443f4 |  1500 | planner | done   | t      | Plan phase 5: deploy to production …
(3 rows)

 total | run_id_null | run_id_null_and_not_pending | pending | running
-------+-------------+-----------------------------+---------+---------
   159 |           3 |                           3 |       0 |       0
```

**Exactly three, matched by round, role and title** — not by trusting the
brief's ids. **No finding**: the set has not changed since the operator verified
it, and it is the set round 810 found, re-derived rather than carried over.

### 4.2 `07:02:13` — the load-bearing precondition: migration 0040 has NOT run

```
$ psql -c "select column_name from information_schema.columns
            where table_name='project_tasks'
              and column_name in ('depends_on','workstream','write_set','graph_frozen');"
 column_name
-------------
(0 rows)

$ git -C /opt/forge-ai-os status --porcelain      <- empty, immediately before the read
```

**Zero of the four graph columns exist on the live `project_tasks`.** Asked of
`information_schema` rather than inferred, and asked *before* the read rather
than asserted after it. Every 8ea0cc08 row still carries the pre-0040 legacy
sentinel because there is no column for it to carry anything else in.

### 4.3 `07:02:20` and `07:02:26` — both refusal arms, fired BEFORE the measurement

```
$ tsx ../scripts/measure-schedule.ts full --project 8ea0cc08-… --exclude-task 4a896cc1-…
MEASUREMENT FAILED: excluded-task-has-run
  - task 4a896cc1-d461-42f8-a6b9-3a0c26e4c5c6 (status done, round 0) names run 3853c154-e07b-4378-9313-2b34f4a33342,
    so it RAN — --exclude-task drops rows that never ran, and a lost run is a finding rather than an exclusion
exit=1

$ tsx ../scripts/measure-schedule.ts full --project 8ea0cc08-… --exclude-task 00000000-0000-4000-8000-000000000000
MEASUREMENT FAILED: excluded-task-unknown
  - task 00000000-0000-4000-8000-000000000000 was named by --exclude-task but is not one of the 159 tasks in the measured set
exit=1
```

Both fire, and the first one is also the moment this re-run earned its name:
**at round 810 this exact command died with `operator does not exist: uuid =
text` instead of refusing.** The instrument now reaches the database, resolves
the id, finds its run and declines for the right reason.

### 4.4 `07:02:30` — D6 with no exclusions: the refusal names the same three ids unprompted

```
census:            tasks=159 runs=164 top-level=164 sub-agent=0 archived=0 tasks-without-run=3
                   legacy-rows=159 graph-rows=0 closure-shaped-rows=0
excluded-tasks:    none (--exclude-task not given)

MEASUREMENT FAILED: unresolvable-run
  - task 420f1be6-fb92-4bcb-a444-8a42fa58c72b (status done, round 101) has no run_id, and only a 'pending' task may have none
  - task 701075e2-eb4a-4a37-b68f-ac1578ba171d (status done, round 1350) has no run_id, and only a 'pending' task may have none
  - task 9f5462c7-c529-4369-9773-4d9d731443f4 (status done, round 1500) has no run_id, and only a 'pending' task may have none
exit=1
```

§4.1's SQL predicate and the instrument's D6 arm were written by different
rounds and agree on the set exactly.

### 4.5 `07:02:39` — the read: **exit 0**, and the shape the gate demands

```
census:            tasks=156 runs=164 top-level=164 sub-agent=0 archived=0 tasks-without-run=0
                   legacy-rows=156 graph-rows=0 closure-shaped-rows=0
  S1 mean concurrency                   0.29 (peak 6, over 17910 per-minute samples)
  S2 parallelism ratio                  3.4 (wall clock ÷ summed run time; lower is more parallel)
  S3 max numbering stall (min)          NOT COMPUTABLE (156 legacy rows, 0 closure-shaped rows)
  runs measured (top-level, in scope)   164
  mean run duration (min)               32.12
  summed run time (min)                 5267.84
  wall clock (min)                      17908.55
  runs started and never terminated     0
  never-ran tasks, EXCLUDED by id (D8)  3
exit=0
```

`closure-shaped-rows=0` with `legacy-rows=156` is the pre-migration signature
the phase-8 gate reads off the header, and `S3 NOT COMPUTABLE` on that pair is
the **PASS**, not a defect. The full output, the round table, the disclosures
and the independent SQL corroboration of every number are part 2 §§9–10.

---

## 5. The operator's six predictions, checked

Handed to this round as *predictions to check, not values to reproduce* — the
difference would have been the finding. There is no difference.

| prediction | measured | |
|---|---|---|
| census `tasks=156 runs=164 tasks-without-run=0`, `legacy-rows=156`, `graph-rows=0`, `closure-shaped-rows=0` | identical | ✅ |
| S1 mean concurrency 0.29 (peak 6) | 0.29, peak 6, over 17910 samples | ✅ |
| S2 3.4 | 3.4 | ✅ |
| S3 **NOT COMPUTABLE** (156 legacy rows, 0 closure-shaped rows) — the correct pre-deploy answer | identical, and read as a PASS | ✅ |
| exactly three never-ran ids: `420f1be6`, `701075e2`, `9f5462c7` | the same three, from SQL and from D6 independently | ✅ |
| both `--exclude-task` refusals fire | `excluded-task-has-run` and `excluded-task-unknown`, both exit 1 | ✅ |

**Why this is worth more than "the numbers matched".** Round 810 produced those
numbers from a *patched scratch copy* at `cc646b1` — real files, byte-copied,
patched with the six-character cast, run against the live database. This round
produced them from the **shipped, committed, reviewed** tree at `ff85fad` with
no patch anywhere. The dry run's central claim — *the cast is the only defect on
this path* — is now confirmed by the shipping instrument, which is the only way
that claim could ever have been settled.

---

## 6. What would have made THIS instrument report a pass wrongly

**(a) A pasted identity.** The operator predicted the composite might move and
warned that pasting round 811's value is exactly the failure R62 exists to
catch. It was re-derived from disk (§3.6), it did not move, and the reason it did
not move was established from `git show --stat` on both of round 813's commits
rather than assumed. Had it moved and been pasted, `check-instrument-identity.py`
check 1b would have named which half disagreed — the mechanism round 811 built
after round 810 found the hole in the field.

**(b) A partial re-run.** Re-running only the failed step would have certified
`ff85fad` on the strength of measurements taken at `cf52541`. Between them the
test count moved by 11, the shell-lint list gained a file, a whole gate item was
added, and the highest-round reviewer changed. §0 tabulates what would have been
carried over silently.

**(c) A read taken after the migration**, printing a plausible `S3 … 0` with a
header that no longer says the rows were legacy. Disproved ahead of the read
(`information_schema`, 0 rows) and inside it (`depends_on: absent`,
`legacy-rows=156 · graph-rows=0 · closure-shaped-rows=0`). The failing pair the
gate warns about — `legacy-rows=0` with N closure-shaped rows — is the exact
inverse of what printed.

**(d) An `--exclude-task` that silently accepted an id with a run**, shrinking
the 159-task denominator invisibly. Disproved by firing both arms first, at
`07:02:20` and `07:02:26`.

**(e) An instrument certifying its own arithmetic.** Every headline number was
re-derived from `content_forge` by SQL that shares no code with the instrument
(part 2 §10): 164 runs, 0 sub-agent, 0 archived, 0 never-started, 0
unterminated, 5267.84, 32.12, 17908.55, 156 tasks, 100 rounds, 1.56, and S1
0.29 with peak 6 over 17910 samples. Nine totals, nine exact matches. The
mirror also surfaced a disclosure worth keeping: under the *other* obvious
sampling convention the same rows give **0.30, peak 7**, so the after-measurement
DoD-6 compares against must use this same instrument or the comparison
manufactures a difference (part 2 §10.1).

---

## 7. What this task did NOT do

No merge, in either direction. No migration. No restart, detached or otherwise.
No write, edit or patch anywhere under `/opt/forge-ai-os` — porcelain-clean at
`4f6cd31` before the read (§3.3), before the instrument ran (§4.2) and after
everything (§8). No change to any file under `forge-control/src/**`, so the
shipping source tree is still exactly the tree round 814 passed. **No project
status was changed**: round 810 paused this project for 22 seconds to hold the
interlock because a task cannot fail itself, and nothing here failed, so no
lever was pulled.

The only mutations outside this worktree are the two throwaway databases the
gate scripts own by name: `forge_tg_scratch` (existing; `check-scheduler-sql.sh`
drops and recreates only its own schema `tg_check_sched` inside it) and the
cluster `check-schedule-sql.sh` provisions under `/tmp` and stops. Neither
issues a statement against `content_forge`. Every read of `content_forge` was a
`SELECT`, authorised by this brief.

---

## 8. The tree after, and every gate re-run over this document

A document is part of the corpus it describes, so the corpus checkers were run
again **after** this file and part 2 existed.

`07:10:39+02:00`:

```
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
corpus:            24 markdown file(s) under docs/plan/engine-task-graph/
OK — 12 pasted header(s) across 3 file(s) name fb5a6434…
OK — 33 pasted manifest line(s) name the current digest of their half
OK — no retired identity quoted without '[historical instrument]'
exit=0

$ python3 docs/plan/engine-task-graph/check-corpus-map.py
OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
exit=0

$ python3 scripts/checks/check-r20-census.py
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  …/evidence/phase2-replay.md matches the measurement  PASS
exit=0

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh PASSED — 6/6 entries compiled clean, manifest complete.
exit=0

$ git -C /opt/forge-ai-os status --porcelain      <- empty, exit=0

$ git status --porcelain                          # the worktree, before this round's commit
 M docs/plan/engine-task-graph/04-phases.md
 M docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md
?? docs/plan/engine-task-graph/evidence/baseline-8ea0cc08-part2-raw.txt
?? docs/plan/engine-task-graph/evidence/phase8-deploy-rerun.md
```

**23 markdown files became 24, 11 live headers became 12, 27 manifest lines
became 33** — this round's additions, and every one of them names the instrument
that is on the disk right now. The corpus is 24 files because part 2 went into an
existing file and the raw stdout is a `.txt`, not markdown.

**Part 1 of `baseline-8ea0cc08.md` was not rewritten, and that was measured
rather than promised**: the first 1,108 lines of the file after the append are
byte-identical to `git show HEAD:…/baseline-8ea0cc08.md`, checked with `diff -q`
immediately after appending. 363 lines were added below them.

The four files above are exactly the declared write-set (`04-phases.md` §10, the
round-816 row added in this same commit). Nothing else in the worktree moved,
and `/opt/forge-ai-os` is unchanged at `4f6cd31`.

---

## 9. What round 820 inherits

1. **A green interlock, re-measured on the tree it will merge**, not on
   `cf52541`. Steps 1, 1b, 2 (items 1–11) and 2b all pass at `ff85fad`.
2. **The baseline is complete.** R62's "one instrument, before and after" is now
   half-satisfied by an actual before-measurement: S1 0.29, S2 3.4, 164 runs,
   mean 32.12 min, wall clock 17,908.55 min, S3 refused for cause. DoD-6's
   after-measurement must be taken with the same instrument, and part 2 §10.1
   says why in numbers.
3. **The pre-0040 window has closed correctly rather than been lost.** The read
   that had to happen before migration 0040 has happened; 0040 may now run. The
   ordering `03-quality.md` §3.2 checks is satisfied by this file and part 2, in
   the order the stamps show.
4. **Nothing about the deploy itself is settled here.** Merge 2, the three named
   migrations each applied twice, and the detached `safe-restart.sh` pattern are
   round 820's, unchanged and unrelaxed. Step 1's fleet reading is fresh as of
   `06:59:36` and must be re-taken by 820 — one `active` project, this one, is
   what the restart will wait for.

---

## 10. `07:11:52+02:00` — the same gates, re-run on the COMMITTED tree

§8 ran over a dirty worktree, which is the state a reader can no longer inspect.
Round 813's habit, adopted here: re-run on the tree that actually exists in git,
at `cc821f7`.

```
$ git status --porcelain                          <- empty, exit=0
$ git -C /opt/forge-ai-os status --porcelain      <- empty, exit=0
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
OK — 12 pasted header(s) across 3 file(s) name fb5a6434…
OK — 33 pasted manifest line(s) name the current digest of their half
OK — no retired identity quoted without '[historical instrument]'
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
$ python3 scripts/checks/check-r20-census.py
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  …/evidence/phase2-replay.md matches the measurement  PASS
$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh PASSED — 6/6 entries compiled clean, manifest complete.
```

**The artifact was verified from the committed blob, not from the file on
disk** — the two can differ, and the digest part 2 §9 offers a reader is only
worth what the repository holds:

```
$ git show HEAD:docs/plan/engine-task-graph/evidence/baseline-8ea0cc08-part2-raw.txt | sha256sum
e6239ef1d27bd6f7c0da49af81bb6937082c877cf090683afc5e5e7fa40d976d  -
$ git show HEAD:… | wc -l
18058
$ git show HEAD:…/baseline-8ea0cc08.md | head -1108 | diff -q <part 1 at HEAD~1> -
IDENTICAL
```

Same sha256, same 18,058 lines, and part 1 of the baseline byte-identical to its
pre-append state inside the commit itself. The four numbers this document offers
a reader — the artifact digest, its line count, the sample-row count and part 1's
length — are all now true of the repository and not only of a working directory.
