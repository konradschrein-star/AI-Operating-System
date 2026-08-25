# Recovering tasks stuck at the attempt cap whose work already landed

This is the operator runbook for `scripts/ops/recover-stuck-task.sh`. It marks
a `project_tasks` row `done` **without re-running it**, for the narrow case
where the row is stuck at `MAX_TASK_ATTEMPTS` and its work is already
committed and verifiable on disk.

## Why this exists, and why `retry` is the wrong tool

`aios-stuck-run-is-not-a-failed-task` fixes the trapdoor that produces these
rows: a run gets flipped `stuck` by the heartbeat watchdog while its process
is still alive and working, finishes anyway, and `completeRun()` discards the
result because the run is no longer `running`. `project-tick.ts`'s settle path
then reads `run_status !== 'completed'` and fails the task. Measured
2026-08-25: 46 watchdog flips, 42 discarded completions, floor cost ≥ $83.01.

The work is **not lost** — it is sitting committed in the task's worktree,
because the underlying `claude` child process finished the job before the
discard happened. The five tasks below hit `MAX_TASK_ATTEMPTS = 2`
(`forge-control/src/db/projects.ts:1828`) this way and their projects are
`blocked`.

**The API cannot fix this.** `POST /api/tasks/:id/retry` and
`POST /api/projects/:id/unwedge` both only move `failed`/`blocked` → `ready` —
i.e. they **re-run the work**. There is no route that marks a task `done`.
Retrying one of these rows would redo work that already happened and re-spend
the money that already bought it. This fleet has **7 recorded instances** of
exactly this "already done" redispatch defect (see the fleet memory index,
`merge-task-already-landed-verify-dont-remerge` and its four prior notes) —
retry is not a safe default here, verification is.

So the runbook is SQL, gated by re-verification, never run blind:

```sql
UPDATE project_tasks SET status='done', updated_at=now()
WHERE id='<task id>' AND status='failed'
RETURNING id, status;
```

followed by unblocking the project:

```bash
curl -sX POST http://127.0.0.1:7700/api/projects/<project id>/status \
  -H 'content-type: application/json' -d '{"status":"active"}'
```

**VERIFY, THEN WRITE — never the reverse.** Every step below is read-only
until step 4. `scripts/ops/recover-stuck-task.sh` implements exactly this
order and is **dry-run by default**.

## Ordering — do not run this before the fix is deployed and live

Releasing the ~18 wedged tasks behind these five projects re-activates the
whole dependent graph. If the watchdog trapdoor this project fixes is still
live when that happens, the newly-spawned runs get shredded by the same bug
that produced the five rows below, in front of everyone downstream of them.
**Sequence: merge → deploy → restart forge-executor → confirm the fix is live
→ only then run this runbook.** This is the deploy task's job, not a build
task's.

## The five rows, and why only four are in scope

| task id | project | role | recover? |
|---|---|---|---|
| `f687d7f7-f1c6-46fc-a6cb-a966b50f71aa` | aios-chat-reference-navigation | builder | **yes** |
| `161e2155-e601-4b2f-bb4d-0ff3d5af2683` | aios-guardrail-hardening | builder | **yes** |
| `325616b9-ae35-41f4-ba7d-fea7819b6399` | aios-journal-thoughts-stats | builder | **yes** |
| `67ff2645-6dc3-44eb-8bb7-19949004152f` | aios-verification-that-bites | builder | **yes** |
| `e7684092-8586-41fa-95ea-ddd7955cfa79` | aios-sidebar-live-sessions | **reviewer** | **NO** |

A builder's output is commits — marking it `done` after independently
confirming those commits exist asserts something true. A reviewer's output is
a **verdict**, and `e7684092`'s last verdict (taking the *last* `VERDICT:`
line in the run thread, not the first — the reviewer's own brief also
contains the string `VERDICT: PASS`, so a naive grep matches the brief
instead of the answer) is `NEEDS_FIXES`, confirmed across all four attempts.
Marking a verdict-role row `done` silently converts `NEEDS_FIXES` into a pass
and seeds no fix chain — this fleet has already measured that exact failure
mode (`paused-project-swallows-fix-chain`): the verdict produces no work and
no alarm. **This runbook and its script never mark a `reviewer` row done —
the script refuses it unconditionally, with no override flag.**

`e7684092` is left **untouched** by this runbook. The correct recovery is to
consume the verdict — seed the fix chain the engine would have seeded via
`createFixChain()` (`forge-control/src/db/projects.ts`), which claims
`reviewer.round + 1` and `+2` itself; hand-placing a row at those rounds risks
colliding with it. That is out of scope for this runbook and is a decision
for the deploy task / Konrad, not something to bundle in quietly here.

## Verify-then-write, per task

### 1. Read the row

```bash
DB=$(pm2 jlist | python3 -c "
import sys,json
for a in json.load(sys.stdin):
    if a['name']=='forge-control': print(a['pm2_env']['DATABASE_URL'])")
psql "$DB" -tAF'|' -c "select id, project_id, title, status, attempt, role, workstream, write_set, run_id
                        from project_tasks where id='<task id>'"
psql "$DB" -tAF'|' -c "select status, stuck_signal from runs where id='<run_id>'"
```

Confirmed live on 2026-08-25 (re-query before acting — this table changes):

```
f687d7f7-f1c6-46fc-a6cb-a966b50f71aa|ecacba29-2664-4d8c-89e3-52cae0747941|/document: accept ?line= and ?wikilink= via the shared resolver|failed|3|builder|markdown|822eba27-3bae-46c3-b4d6-ddbca84c54a2
67ff2645-6dc3-44eb-8bb7-19949004152f|169903ec-4dd0-4041-a737-eeba3d178d36|Integrate workstream glob into main|failed|3|builder|main|fa50bf41-c573-43c6-a6a6-f12f8f1143bc
325616b9-ae35-41f4-ba7d-fea7819b6399|d6371f2d-a4e8-4e50-95c9-781ca9da3a2e|Journal day endpoint: mentor read, evidence of the day, reply|failed|3|builder|api-journal|f19db286-9639-4d92-a9f1-54eb24c03bf7
161e2155-e601-4b2f-bb4d-0ff3d5af2683|b167b94e-b335-4767-a3d1-1b43fd72a3dc|integrate engine workstream into main: merge, gates, stop on conflict|failed|3|builder|main|2272b742-b420-43bb-9257-69587d41fbdd
```

All five runs: `status=stuck`, `stuck_signal=heartbeat_stale` — the watchdog
signature this project's fix targets, not a timeout.

### 2. Find the RIGHT worktree, then check it's clean and the commit matches

**Gotcha found while writing this runbook, load-bearing for the script:** a
task's worktree is **not always** `projects.workspace_dir`.
`project-tick.ts`'s `resolveTaskWorkspace()` / `provisionWorkstream()` forks a
**separate** worktree for any workstream other than `main`, at
`"<workspace_dir>--<workstream>"`, the first time that lane dispatches.
`projects.workspace_dir` only ever tracks the `main` branch's own checkout.

Measured live: task `325616b9` has `workstream=api-journal`. Checking
`projects.workspace_dir` directly (`.../d6371f2d-a4e8-4e50-95c9-781ca9da3a2e`)
showed a clean tree and *12 of its 13 declared write_set paths missing* — that
reads exactly like incomplete work. The correct tree is
`.../d6371f2d-a4e8-4e50-95c9-781ca9da3a2e--api-journal`, on branch
`project/d6371f2d-api-journal`: clean, commit `1355987` at HEAD, all 13 paths
present (11 verbatim, 2 as the named test-consolidation drift below). Always
resolve the worktree by workstream before reading anything else:

```bash
workstream=api-journal   # from step 1
workspace_dir=/opt/ai-os/workspace/projects/d6371f2d-a4e8-4e50-95c9-781ca9da3a2e
worktree="$workspace_dir"; [ "$workstream" != main ] && worktree="${workspace_dir}--${workstream}"
git -C "$worktree" status --porcelain     # must be EMPTY
git -C "$worktree" log --oneline -8       # must carry a commit matching the task title
```

Results, all four, worktree resolved correctly:

```
f687d7f7  worktree .../ecacba29-2664-4d8c-89e3-52cae0747941--markdown
  clean; HEAD 0624fd5, 6dd7f12 "feat(chat/document): /document accepts
  ?line= and ?wikilink=/?wikipath=" in history — matches the title.

67ff2645  worktree .../169903ec-4dd0-4041-a737-eeba3d178d36  (workstream=main)
  clean; HEAD cb2c0a7, a1a61b7 "Merge branch 'project/169903ec-glob' into
  project/169903ec" in history — matches "Integrate workstream glob into main".

325616b9  worktree .../d6371f2d-a4e8-4e50-95c9-781ca9da3a2e--api-journal
  clean; HEAD 1355987 "feat(journal): the day opens on the mentor's read and
  eleven sources of evidence" — matches the title verbatim in spirit.

161e2155  worktree .../b167b94e-b335-4767-a3d1-1b43fd72a3dc  (workstream=main)
  clean; HEAD d907389 "merge engine workstream: autonomy default-branch fix +
  rule-change audit/notify (P1-1)" — matches the title.
```

### 3. Every write_set path must exist BY NAME

Two **known benign drifts** — name them explicitly so they don't read as a
miss:

- **(a) Migrations renumbered.** `0043_gemini_tier` took the `0043` slot
  first, so later lanes' `0043_*` migrations landed as `0044_`/`0045_`.
  Check migrations by NAME, never by number. (Not hit by these four — no
  migration path in their write_sets collided — `161e2155`'s
  `0047_guardrail_rule_changes.sql` exists verbatim.)
- **(b) Tests consolidated into `forge-control/src/lib/*.test.ts`.** The test
  runner glob (`gates-808.sh` / `pnpm test`) only reaches `src/lib`, flat, so
  a lane that declared a test under `src/db/` or `src/routes/` correctly
  relocated it. Measured on two of the four:

  - `325616b9` declared `forge-control/src/lib/evidence/evidence.test.ts` and
    `forge-control/src/db/journal-day.test.ts`; the actual commit (`1355987`)
    put **one consolidated file** at
    `forge-control/src/lib/journal-evidence.test.ts` (316 lines, 25 tests) —
    the commit message discloses this by name. Benign.
  - `161e2155` declared `forge-control/src/db/autonomy-blanket.test.ts` and
    a route-scoped changes test; the merge commit (`d907389`) put them at
    `forge-control/src/lib/autonomy-blanket.test.ts` and
    `forge-control/src/lib/autonomy-changes.test.ts` — same basenames, moved
    directory. Benign.

  `f687d7f7` and `67ff2645` had all declared paths present verbatim, no drift.

### 4. Write — one id at a time, guarded, `RETURNING` so a no-op is visible

```sql
UPDATE project_tasks SET status='done', updated_at=now()
WHERE id='f687d7f7-f1c6-46fc-a6cb-a966b50f71aa' AND status='failed'
RETURNING id, status;
```

Repeat per id. The `AND status='failed'` guard means a row that moved under
you (already retried, already recovered by someone else) returns **zero
rows** instead of clobbering whatever it became — check the row count, not
just the exit code.

### 5. Unblock the project

```bash
curl -sX POST http://127.0.0.1:7700/api/projects/<project id>/status \
  -H 'content-type: application/json' -d '{"status":"active"}'
```

Use `"active"`, never `"paused"`. `deferForUsageWall` (R860, `project-tick.ts`)
refuses to park a run when `projectAcceptsWork()` is false — on a `paused` or
`blocked` project it falls through to the **plain failure path**, i.e.
pausing to be cautious here reproduces the exact hard-failure behaviour this
whole project exists to stop. `blocked` is also unsafe to leave alone:
`/opt/ai-os/scripts/fleet-watchdog.sh` polls every 10 minutes and unwedges
`blocked` projects itself, which would call `unwedgeProject()` → retry → redo
the work you just proved was already done.

### 6. What happens next, and how to watch it

`projectTick()` calls `promoteReadyTasks()` every tick; it promotes
`pending → ready` for any task in an `active` project whose dependencies are
satisfied — no manual promotion needed once the project is `active` again.
The next tasks actually **spawn** (create a run, spend money) via
`spawnTaskRuns()`, which logs one line per spawn:

```bash
pm2 logs forge-executor --lines 200 --nostream | grep '\[project-tick\] spawned'
```

Format: `[project-tick] spawned <role> run <runId> for task <id> (round R,
tier T, workstream=W, deps=N) — <project name> · <title>`. Or query directly:

```sql
select id, status, updated_at from project_tasks
where project_id='<project id>' and status in ('ready','running')
order by round;
```

**If a project does not resume:** re-check `projects.status` (something else
may have flipped it), and check for a `pending` task whose `depends_on` still
points at a non-`done` row — `promoteReadyTasks()`'s dependency clause only
promotes when every dependency is `done`/terminal-cancelled; a sibling row
stuck in some other bad state will still wedge it.

## Rollback

Step 4's write is trivially reversible if applied to the wrong row:

```sql
UPDATE project_tasks SET status='failed', updated_at=now()
WHERE id='<task id>' AND status='done'
RETURNING id, status;
```

This is safe **only** if `spawnTaskRuns()` has not already promoted and
spawned a dependent task in the few seconds since — check
`select status from project_tasks where depends_on @> array['<task id>']::uuid[]`
first; if a dependent is already `running`, don't flip the parent back, deal
with the dependent instead (pause the project, see
`task-cannot-fail-itself` in the fleet memory).

The project status flip (step 5) is freely reversible in either direction —
`POST /api/projects/:id/status {"status":"blocked"}` or `{"paused"}` — with
no side effect beyond what `promoteReadyTasks()` does on the next tick.

## When NOT to use this runbook

If, for the task you're looking at:

- `git status --porcelain` on its **correctly-resolved** worktree (§2 — check
  the workstream, not just `workspace_dir`) is **not empty**, or
- no commit in its history has a subject matching the task title, or
- a declared `write_set` path is genuinely absent — not explained by either
  named drift above —

then the work is **not** complete. This runbook does not apply. The correct
tool is:

```bash
curl -sX POST http://127.0.0.1:7700/api/tasks/<task id>/retry \
  -H 'content-type: application/json' -d '{"force":true}'
```

`{"force":true}` is required once `attempt >= MAX_TASK_ATTEMPTS` — see
`forge-control/src/routes/tasks.ts`.

## The script: `scripts/ops/recover-stuck-task.sh`

Implements exactly steps 1–5 above as one command, **dry-run by default**.

```
recover-stuck-task.sh [--apply] TASK_ID:COMMIT_SHA[:drift] ...
```

- `TASK_ID` — the only rows an invocation may touch are the ids named on the
  command line. No "all" mode, no wildcard.
- `COMMIT_SHA` — the commit *you* have already read and confirmed matches the
  task's title (§2). The script does not judge English; it only checks that
  the sha is an ancestor of the task's own worktree HEAD.
- `:drift` — pass only after manually confirming every write_set path missing
  verbatim is one of the two named benign drifts (§3). Without it, any
  missing path refuses the row. The script never auto-detects drift.
- Refuses any `role=reviewer` row unconditionally — no flag overrides this.
- Never `DELETE`s or `TRUNCATE`s anything; never touches pm2 or the executor.
- `--apply` re-runs status/role/dirty-tree checks immediately before each
  write and refuses that id, and only that id, if a check fails at write
  time (a row can move between the dry-run read and the write).

### Proof the default mode is really dry

Run against all five ids, `--apply` omitted:

```
$ ./scripts/ops/recover-stuck-task.sh \
    f687d7f7-f1c6-46fc-a6cb-a966b50f71aa:6dd7f12 \
    67ff2645-6dc3-44eb-8bb7-19949004152f:a1a61b7 \
    325616b9-ae35-41f4-ba7d-fea7819b6399:1355987:drift \
    161e2155-e601-4b2f-bb4d-0ff3d5af2683:d907389:drift \
    e7684092-8586-41fa-95ea-ddd7955cfa79:497be3d5

── f687d7f7-f1c6-46fc-a6cb-a966b50f71aa  commit=6dd7f12  drift-ack=no ──
   title:      /document: accept ?line= and ?wikilink= via the shared resolver
   status:     failed   attempt: 3   role: builder   workstream: markdown
   worktree:   /opt/ai-os/workspace/projects/ecacba29-2664-4d8c-89e3-52cae0747941--markdown
   git status --porcelain: (empty)
   write_set: all 1 declared paths present verbatim.
   would run:
     UPDATE project_tasks SET status='done', updated_at=now() WHERE id='f687d7f7-f1c6-46fc-a6cb-a966b50f71aa' AND status='failed' RETURNING id, status;
     curl -sX POST http://127.0.0.1:7700/api/projects/ecacba29-2664-4d8c-89e3-52cae0747941/status -H 'content-type: application/json' -d '{"status":"active"}'
   (dry-run — nothing written)
[...same shape for 67ff2645, 325616b9, 161e2155, both with :drift acknowledged
   and showing the exact 2 missing paths named in §3 above...]

── e7684092-8586-41fa-95ea-ddd7955cfa79  commit=497be3d5  drift-ack=no ──
   title:      Re-review after fix cycle 1 · toggle
   status:     failed   attempt: 3   role: reviewer   workstream: toggle
REFUSE e7684092-8586-41fa-95ea-ddd7955cfa79 — role=reviewer. A reviewer's
        output is a VERDICT, not a commit. [...]

$ echo $?
1   # nonzero because of the reviewer refusal — the four builder rows all
    # verified clean and printed what they would run; none wrote anything.
```

And the before/after pair that proves it — same query, run immediately
before and after the dry-run above, unchanged:

```
$ psql "$DB" -tAF'|' -c "select id, status, attempt from project_tasks
    where id in ('f687d7f7-f1c6-46fc-a6cb-a966b50f71aa',
                  '161e2155-e601-4b2f-bb4d-0ff3d5af2683',
                  '325616b9-ae35-41f4-ba7d-fea7819b6399',
                  '67ff2645-6dc3-44eb-8bb7-19949004152f',
                  'e7684092-8586-41fa-95ea-ddd7955cfa79') order by id"
161e2155-e601-4b2f-bb4d-0ff3d5af2683|failed|3
325616b9-ae35-41f4-ba7d-fea7819b6399|failed|3
67ff2645-6dc3-44eb-8bb7-19949004152f|failed|3
e7684092-8586-41fa-95ea-ddd7955cfa79|failed|3
f687d7f7-f1c6-46fc-a6cb-a966b50f71aa|failed|3
```

Identical before and after — the default mode wrote nothing. Same for
`projects.status`: all four stayed `blocked`.

### Proof the refusal gates actually bite (not a gate that can't fail)

```
$ ./scripts/ops/recover-stuck-task.sh 161e2155-e601-4b2f-bb4d-0ff3d5af2683:d907389
   write_set paths NOT found verbatim (2/6):
     forge-control/src/db/autonomy-blanket.test.ts
     forge-control/src/routes/autonomy-changes.test.ts
REFUSE 161e2155-e601-4b2f-bb4d-0ff3d5af2683 — missing paths above and :drift
        was not passed. [...]

$ ./scripts/ops/recover-stuck-task.sh f687d7f7-f1c6-46fc-a6cb-a966b50f71aa:deadbeef
REFUSE f687d7f7-f1c6-46fc-a6cb-a966b50f71aa — deadbeef is not an ancestor of
        .../ecacba29-2664-4d8c-89e3-52cae0747941--markdown's HEAD

$ ./scripts/ops/recover-stuck-task.sh not-a-uuid:6dd7f12; echo $?
REFUSE not-a-uuid:6dd7f12 — 'not-a-uuid' is not a task uuid
1

$ ./scripts/ops/recover-stuck-task.sh 00000000-0000-0000-0000-000000000000:6dd7f12; echo $?
REFUSE 00000000-0000-0000-0000-000000000000 — no project_tasks row with that id
1
```

Four independent ways to refuse, each proven live: omit `:drift` with real
missing paths, a sha that isn't an ancestor, a malformed id, an id that
doesn't exist.

### `--apply` was NOT run against these five rows in this task

Per this project's own worktree-only policy: writing to the live database
happens only inside an explicitly-briefed deploy/verify task, and applying
this recovery is sequenced strictly *after* the fix is deployed and live
(see "Ordering" above). Whether the deploy task runs `--apply` against these
four, or only re-confirms the dry-run and hands the four commands to Konrad,
is that task's call.

`bash -n scripts/ops/recover-stuck-task.sh` passes; `shellcheck` reports only
the same `SC1091` info-level note (can't statically follow the sourced
secrets file) that `scripts/ops/safe-restart.sh` also carries — no new
findings.
