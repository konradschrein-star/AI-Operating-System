# Deploy record — aios-r70-transitive-and-idle-fleet-alarm

Round 20, executed 2026-08-26 03:20–03:45Z on VPS1 by the deploy/verify task.
Every number below was executed in this task, not carried forward from a lane
report. Where a claim rests on a prior round's measurement it says so.

**Precondition.** Round 7's verdict was **PASS** at lane tip `257ab64`,
acknowledged by the fleet supervisor in the manager chat
(`f97efebb-ce0d-47e9-8e20-0d0c4ec4f888`, "round 7 PASS acknowledged"). No
NEEDS_FIXES was outstanding, so the deploy proceeded.

---

## 1. Merge

| | |
|---|---|
| merge commit | **`5b4a750602f69c7d5856ab71c36b3e863ed08984`** |
| into | `main`, live checkout `/opt/forge-ai-os` |
| from | `project/0a0806d3` @ `257ab64` |
| merge base | `48c34d775a506228e0783730ca440087bbf7d80e` |
| pre-merge main | `b3c23ce` |

Already-merged check first, as briefed — `git rev-list --left-right --count
main...project/0a0806d3` was **`10  12`** before the merge (main held 10 the
lane lacked, the lane held 12 main lacked), so the work was genuinely
unshipped. After the merge the same command reads **`11  0`**.

### Conflicts — two files, resolved as round 7 measured

**`scripts/checks/gates-808.sh`, three regions:**

1. the gate-6 waiver comment blocks — **kept BOTH** (main's
   `project/51ddfb27` waiver, then the lane's `project/0a0806d3` waiver).
   Additive; nothing dropped.
2. the gate-6 branch clauses — **kept ALL FOUR**: `project/860c948e`
   (outside the conflict), `operator/agy-fix`, `project/51ddfb27`,
   `project/0a0806d3`. Verified afterwards by grep — four `abbrev-ref HEAD`
   clauses present.
3. the gate-7 body (exported surface) — **took the LANE's side whole**. Main
   carried the `b3c23ce` one-liner that greps declaration lines; the lane
   replaces it with `scripts/checks/exported-names.sh` set comparison.

Post-merge one-command checks, both from the briefing, both executed:

```
$ grep -c 'exported-names.sh' scripts/checks/gates-808.sh
4                                     # non-zero — the gate can run
$ grep -n "export (async function|function|const|type|interface|class)" scripts/checks/gates-808.sh
292 [first-char=#]      grep -oE '^export (async function|…'
                                      # the only surviving copy is inside a comment
$ bash -n scripts/checks/gates-808.sh
gates-808.sh SYNTAX OK
```

**`PLAN.md`** — both sides were whole, unrelated plans (main:
`aios-ops-inventory-red`; lane: this project). Git split them into three
interleaved hunks; resolving hunk-by-hunk would have spliced two documents into
an unreadable file. **Both were kept whole, in merge order**, separated by an
HTML comment recording why. Nothing was dropped.

### The live checkout was dirty, and it stayed that way

`git -C /opt/forge-ai-os status --porcelain` showed, before and after:

```
 M docs/plan/artifacts/phase300/backfill.log
```

One line appended by the *running* engine (`chat-linkage.ts:404`). Per the
fleet-supervisor ruling of 2026-08-26 this is known, benign and backlogged to
project `5b9b85e7`. It was **not reverted, not committed, not stashed.**
Measured that it could not block the merge:
`git diff --name-only main...project/0a0806d3 | grep -c backfill.log` → **0**.

`git stash` was not used at any point. The stack is shared across every
worktree on this repo and held 3 entries belonging to other work.

---

## 2. Dependencies, then gates

```
cd /opt/forge-ai-os/forge-control     && pnpm install --frozen-lockfile --prod=false   # rc 0
cd /opt/forge-ai-os/forge-control-web && pnpm install --frozen-lockfile --prod=false   # rc 0
```

Both packages, deliberately: a checkout missing `forge-control-web/node_modules`
invents eight red gates out of nothing. `tsx`, `tsc` and the web `node_modules`
were all confirmed present before a single gate ran.

### `bash scripts/checks/gates-808.sh --strict` at `5b4a750`

| | |
|---|---|
| gates declared | **42** |
| executed | **37** |
| skipped | **5** (37–40 browser harness, 42 watchdog dry-run — all skipped by design without `--browser`) |
| **RED** | **1** |
| exit | 1 |

**The single red — gate 33, `test-guard-protected-paths.py` — is INHERITED, and
the classification was proven by execution, not asserted.**

```
  FAIL  exit=2 want=0  THE WORKTREE COPY of the guard -- the file agents are sent to
  28 cases, 1 failing
```

Two independent proofs:

1. **The merge does not touch the gate's inputs.**
   `git diff --name-only b3c23ce 5b4a750 -- scripts/ops/test-guard-protected-paths.py
   scripts/ops/guard-autonomy.py` → **0 files**. Both are byte-identical to
   pre-merge main.

2. **Same commit, opposite verdicts, by location alone.** A throwaway worktree
   was created at the *merge commit itself* and the identical test run in both
   places:

   ```
   $ cd /tmp/g33probe   && python3 scripts/ops/test-guard-protected-paths.py   # worktree of 5b4a750
     28 cases, 0 failing
   $ cd /opt/forge-ai-os && python3 scripts/ops/test-guard-protected-paths.py   # live checkout, same 5b4a750
     28 cases, 1 failing
   ```

   The test builds its ALLOW fixture from `os.path.dirname(__file__)` and labels
   it "THE WORKTREE COPY of the guard". Run inside `/opt/forge-ai-os` that path
   resolves to the live checkout, which `guard-autonomy.py` protects *by
   design* — so the fixture that expects ALLOW correctly gets BLOCK. This is a
   location-dependent assertion, previously recorded as
   `gate30-protected-paths-test-cwd-artifact` (the gate has since been
   renumbered 30 → 33). It will falsely red **every** deploy-phase gate run,
   on any commit, until the test derives that fixture path from a real worktree
   instead of its own location. That fix belongs to the owner of
   `scripts/ops/test-guard-protected-paths.py`; it is not this lane's.

**Gates 30 (`pnpm test`) and 34 (`check-ops-scripts.sh`) both ran GREEN**, as
expected — the lane reds recorded at round 7 (then numbered 30 and 34, the
PGPASSWORD label and the `install-symlinks.sh` FILES array) were fixed on main
at `c5d0b3b` and `592f18a`, which the merge made ancestors.

**Effective RED attributable to this lane: 0.**

---

## 3. The red-to-green proof, against live rows

### (a) Read-only, before anything shipped

Both predicates run as bare `SELECT`s against `content_forge`, over the same
candidate set (`status='active'`, ≥1 done row, no still-open row):

```
### CANDIDATES
+--------------------------------+
| aios-chat-reference-navigation |
| aios-sidebar-live-sessions     |
| os-usable-for-work             |
+--------------------------------+
(3 rows)

### OLD PREDICATE  (R70 as direct array membership: m.id = ANY(i.depends_on)) -> WOULD CLOSE
+------+
| name |
+------+
(0 rows)

### NEW PREDICATE  (R70 as TRANSITIVE reachability over depends_on) -> WOULD CLOSE
+--------------------------------+
| aios-chat-reference-navigation |
+--------------------------------+
(1 row)
```

**Old closes 0 of 3. New closes 1 of 3.**

### (b) Then the shipped code did it

`closeFinishedProjects()` was imported from the **merged live checkout** and
called against the live database. It performs its own
`UPDATE … RETURNING` — the same statement the executor's tick runs. Its output,
verbatim:

```
closed (1):
    aios-chat-reference-navigation ecacba29-2664-4d8c-89e3-52cae0747941
held (2):
    os-usable-for-work             7851068b-32d7-469b-b42f-f5e3c1d9e83a
    aios-sidebar-live-sessions     fb3b5fb2-26cb-463b-9830-ba0b27b6a145
```

Confirmed in the table afterwards:

```
aios-chat-reference-navigation|done  |2026-08-26 03:33:01.860411+00
aios-sidebar-live-sessions    |active|2026-08-25 16:03:10.080356+00
os-usable-for-work            |active|2026-08-19 21:28:30.100401+00
```

**ONE OF THREE IS THE CORRECT RESULT, AND A READER WHO SEES A REGRESSION HERE
IS READING A RETIRED SPEC.** The brief's headline "must close all three" was
measured false at round 0, escalated, and **retired by fleet-supervisor ruling
on 2026-08-26**. The live acceptance is: *`closeFinishedProjects()` closes
exactly `aios-chat-reference-navigation`; the other two stay held.* The other
two fail R70 for a different cause than tree-vs-chain — tasks whose own titles
read `[FOLDED into …]` / `[RETIRED as duplicate of …]` that nothing anywhere
lists in `depends_on`, plus workstream `toggle`, which was never given an
integrator at all. Holding them is the negative the brief demanded be
preserved. Rule B (union-of-integrators) was checked task-by-task at round 0
and rescues neither.

### (c) Nothing was closed by hand

No `UPDATE` on `projects.status` was issued by this task. No psql edit of any
kind was made to `content_forge`; every statement run against it was a `SELECT`.
The single write to that database came from `closeFinishedProjects()` itself.

### (d) `check-close-gate.ts` against a scratch database

Preamble per the script's own header; `CREATE DATABASE forge_tg_scratch` issued
against the `postgres` maintenance database (it already existed), and
`$SCRATCH_DATABASE_URL` was the only connection string the script consumed.

```
=== summary ==================================================================
  assertions run    : 57 (expected 57)
  assertions failed : 0
  PASS
```

exit 0. Of note, the negatives that keep the rule from collapsing into a
tautology all held: `(11) negativeUnreachable`, `(12) disconnectedBranch` and
`(13) mutualCover` each report `false` for "would close", and §5b proves the
pure `unintegratedWorkstreams()` and the SQL agree case-by-case on all twelve.

---

## 4. The detector, both directions

`scripts/ops/stalled-projects.sh`, run against live. `zz-tierpin-verify` and
`smoke-test` are documented permanent noise and are subtracted below; the
`aios-takeover-usable` ZOMBIE row belongs to another lane and is present in both
transcripts unchanged.

### BEFORE (03:26Z, before anything closed)

```
== FINISHED BUT STILL ACTIVE — every row terminal, the project still open ==
aios-chat-reference-navigation|22|0|11h since last change
aios-sidebar-live-sessions|16|1|7h since last change
os-usable-for-work|88|0|148h since last change

== FLEET-WIDE OPEN WORK: 6 open rows across all active projects ==
none

STALLED — see above.
EXIT=1
```

All three named. Exit 1. **This is the transcript the section exists to produce
and it could not have been taken after the close** — it is why the order was
BEFORE-then-close-then-AFTER.

### AFTER (03:34Z, after `closeFinishedProjects()` ran)

```
== FINISHED BUT STILL ACTIVE — every row terminal, the project still open ==
aios-sidebar-live-sessions|16|1|7h since last change
os-usable-for-work|88|0|148h since last change

== FLEET-WIDE OPEN WORK: 5 open rows across all active projects ==
none

STALLED — see above.
EXIT=1
```

`aios-chat-reference-navigation` **dropped out of the section the moment the
code closed it** — that transition, not the section going empty, is the
before/after evidence.

**DID NOT GO AS BRIEFED, AND IT IS NOT A DEFECT.** The brief predicted this
section would print nothing after workstream 1 shipped. It prints two rows,
because those two projects are genuinely unintegrated and R70 is genuinely
right to hold them — the same fact as §3(b). The consequence is operational and
worth naming: **the detector will now report STALLED on every run, forever,
until `os-usable-for-work` and `aios-sidebar-live-sessions` are either given
integration tasks that reach their orphaned rows, or are retired by an
operator.** A detector that is permanently red trains people to read exit 1 as
weather, which is the failure mode recorded in
`shared-suite-gate-that-cannot-pass`. This is reported to the manager chat as a
finding, not fixed here — fixing it means touching two other projects' task
graphs, which is nobody's business in a deploy task.

### `prove-idle-alarm-bites.sh` against a scratch database

`$SCRATCH_DATABASE_URL` → `forge_idle_alarm_scratch`, created against the
`postgres` maintenance database.

```
=== summary =====================================================================
  assertions run    : 10 (expected 10)
  assertions failed : 0
  BITES — both sections fire on the RED state and go quiet on the GREEN one.
```

exit 0. Its own cleanup removed the fixture rows.

---

## 5. Restart

Both `forge-control` and `forge-executor` run from `src` via `tsx`, so both need
a restart to pick this merge up.

**`forge-control` — RESTARTED AND VERIFIED.** Launched detached; the caller
exclusion in `safe-restart.sh` applies to every service *except*
`forge-executor`, so it acted in ~20 seconds.

```
[2026-08-26T05:32:32+02:00] waiting for idle to restart 'forge-control' (max 600s, idle window 45s)
[2026-08-26T05:32:52+02:00] restarted forge-control — status=online

$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7700/api/today
200
```

`online` was **not** taken as proof — the API was curled and answered 200.

**`forge-executor` — QUEUED, DETACHED, AND IT CANNOT COMPLETE UNTIL THIS TASK
ENDS.** That service hosts this turn, so `safe-restart.sh` deliberately counts
the caller's own heartbeat there and will only act once the fleet is quiet. It
was launched as the last action of the task:

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 7200 45 \
  /opt/forge-ai-os/forge-control/ecosystem.config.cjs >/dev/null 2>&1 </dev/null &
```

A bare `pm2 restart` was never run — it kills every live run including this one.

**Consequence, stated plainly:** the acceptance in §3(b) was proven by calling
the shipped function directly out of the merged checkout, because the executor
that will run it on a timer cannot be restarted while the task proving it is
alive. That is the same code and the same statement, but it is not the same
observation, and the next supervisor pass should confirm from
`/var/log/forge-safe-restart.log` that the executor restart actually landed.
A previous attempt at 04:49 local **gave up after 7200s — "system never went
quiet"**, so this is a real failure mode, not a theoretical one.

---

## 6. Things that did not go as planned

1. **Gate 33 red.** Expected RED 0; got RED 1. Proven inherited and
   location-dependent (§2). Not a lane defect, but the expectation in the
   briefing was wrong and the next deploy will hit it again.
2. **The detector does not go quiet after this deploy** (§4). Two projects stay
   named, legitimately.
3. **`guard.sh` and `gates-808.sh` have re-diverged on the forbidden-file
   waiver list, exactly as the lane's own comment predicted.** After the merge:

   ```
   gates-808.sh : project/860c948e, operator/agy-fix, project/51ddfb27, project/0a0806d3
   guard.sh     : project/860c948e,                                     project/0a0806d3
   ```

   `operator/agy-fix` (commit `e0c388f`) and `project/51ddfb27` are waived in
   the gate suite but **not** in the PreToolUse guard. **This was left
   unreconciled on purpose.** Reconciling it means *widening a guard* for two
   branches this task holds no charter over, and "a builder widening a gate" is
   the precise move every waiver comment in that file warns against. The
   divergence also fails safe — the guard is stricter than the suite, so it
   blocks rather than admits. It is reported to the manager as a finding for
   whoever owns those two lanes.
4. **The deploy record is committed to the lane branch and cherry-picked onto
   `main`**, rather than written directly on `main`, so that the reviewer's
   write-set comparison sees it on the branch it was declared against.

## Declared write-set

`deploy/aios-r70-transitive-and-idle-fleet-alarm.md` — and that is the only
file this task wrote. The merge commit `5b4a750` carries the lane's 17 files,
none of them authored here; its two conflict resolutions (`PLAN.md`,
`scripts/checks/gates-808.sh`) are merge resolutions of other tasks' work, made
under the recipe round 7 measured, not edits of this task's own.
