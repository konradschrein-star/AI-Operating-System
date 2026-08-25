# Evidence — deploy of `aios-stuck-run-is-not-a-failed-task` (round 20)

Every block below is pasted output from the command printed directly above it. Nothing is
paraphrased and nothing is reconstructed from memory.

- **WORKTREE** `/opt/ai-os/workspace/projects/2bc90424-cc4b-4b87-a74d-e5e8af2c33d5`, branch
  `project/2bc90424`, tip `e0ccf43`.
- **LIVE** `/opt/forge-ai-os`, branch `main`.
- Deploy run `ecb6601b-a5f9-4fcd-b8c5-4c623fe45ca3`, 2026-08-25, times UTC.

---

## 0. Was it already merged? (the 7-instance redispatch defect)

```
$ git log --oneline -5
e0ccf43 fix(stuck-recovery): hold outranks project status; retire the lower-bound claim; the harness runs the real SQL
79cb925 test(stuck-trapdoor): dry-run harness against real Postgres + a gate that bites (T6)
89d7542 feat(project-tick): stuck is not failed - hold a live run, resume a dead one, only then fail
5a984b2 docs(ops): recovery runbook + dry-run-default script for the 4 capped builder tasks
14c6b7f docs(stuck-run): measure why heartbeats go stale past 90s (T3)

$ git merge-base --is-ancestor project/2bc90424 main && echo ALREADY_ANCESTOR || echo NOT_ANCESTOR
NOT_ANCESTOR

$ git status --porcelain
(empty — tree clean)
```

`NOT_ANCESTOR`, so this was real work, not a redispatch. Rollback anchor:

```
$ git -C /opt/forge-ai-os rev-parse main
108dcf7f6e20a4c3387389866fc2542547c816e5
```

## 1. The gating verdict — read as the engine reads it, not as the task status

The round-5 re-review is task `f1890c13`, run `fb098224-6784-4d2b-bcfe-68bd1be56984`.
`status='done'` proves nothing: a NEEDS_FIXES reviewer is marked done too. So the verdict
was parsed the way `parseVerdict()` (`project-reconcile.ts:279`) parses it — `/VERDICT:\s*
(PASS|NEEDS_FIXES)/gi`, **last** match wins.

Every `VERDICT` mention in that run's whole thread:

```
$ psql -c "SELECT ord, role, kind, substring(txt from 'VERDICT.{0,120}') ... WHERE txt ~ 'VERDICT'"
1   | user      | text        | VERDICT: NEEDS_FIXES**  1. **project-tick.ts:2578-2585** — projectAcceptsWork is checked before clas…
98  | tool      | tool_result | VERDICT was PASS at the sha you are shipping, then merge project/2bc90424 into main…
134 | tool      | tool_call   | VERDICT: PASS. All four of round 3's blockers fixed and each re-verified by execution…
135 | agent     | comms       | VERDICT: PASS. All four of round 3's blockers fixed and each re-verified by execution…
137 | assistant | text        | VERDICT ON §1.4: concurrency at flip time is NOT RECOVERABLE from this schema…
```

Ordinal 1 is the *round-3* verdict quoted back inside the reviewer's own brief — the exact
first-match trap `parseVerdict`'s docstring describes. Ordinal 137 is the reviewer's final
report; run the real regex over it:

```
$ psql -tA -c "SELECT txt … WHERE ord=137;" | grep -o -i -E 'verdict:[[:space:]]*(\*\*)?(PASS|NEEDS_FIXES)'
VERDICT: PASS
```

Exactly one match, therefore also the last. The report's own header names the tip:
`**Tip reviewed: e0ccf43e58cd54c8a17dc23868092a693ddc989d**`, which is `HEAD` of the branch
being shipped. **PASS at the shipped sha.**

## 2. Step 0 — does this branch own every path it is about to land?

Round 3 found the live checkout dirty with six `aios-chat-reference-navigation` paths. They
are not this project's to land or to revert; the obligation is only that this merge does not
contain them, which is a checkable fact.

```
$ scripts/ops/assert-merge-scope.sh main HEAD 'forge-control-web/' 'forge-control/src/routes/files\.ts'
merge scope: main...HEAD  (merge base 108dcf7f6e20a4c3387389866fc2542547c816e5)
  PLAN.md
  docs/ops/recover-stuck-capped-tasks.md
  docs/plan/evidence/heartbeat-latency-probe.mts
  docs/plan/evidence/stuck-heartbeat-latency.md
  docs/plan/evidence/stuck-trapdoor-dryrun.mts
  docs/plan/evidence/stuck-trapdoor-proof.md
  forge-control/src/db/projects.ts
  forge-control/src/db/runs.ts
  forge-control/src/executor.ts
  forge-control/src/lib/cp2-reconciler-interaction.test.ts
  forge-control/src/lib/executor-completion-guard.test.ts
  forge-control/src/lib/project-tick-stuck.test.ts
  forge-control/src/lib/project-tick.ts
  forge-control/src/lib/run-liveness.test.ts
  forge-control/src/lib/run-liveness.ts
  forge-control/src/lib/stuck-recovery.test.ts
  forge-control/src/lib/stuck-recovery.ts
  scripts/checks/gates-808.sh
  scripts/ops/assert-merge-scope.sh
  scripts/ops/recover-stuck-task.sh
paths in scope: 20
SCOPE CLEAN — no path matched any of the 2 refused pattern(s)
EXIT=0
```

## 3. Merge

Conflicts were checked before touching anything, with a command that cannot mutate a tree:

```
$ git -C /opt/forge-ai-os merge-tree --write-tree main project/2bc90424
merge-tree EXIT=0
31fe7c1faac32e21eba8af41596404c89639c287
```

One tree oid, no conflict stanza. Then the merge itself:

```
$ git -C /opt/forge-ai-os merge --no-ff project/2bc90424 -m "merge(aios-stuck-run-is-not-a-failed-task): …"
 20 files changed, 4566 insertions(+), 138 deletions(-)
 create mode 100644 docs/ops/recover-stuck-capped-tasks.md
 create mode 100644 forge-control/src/lib/project-tick-stuck.test.ts
 create mode 100644 forge-control/src/lib/run-liveness.ts
 create mode 100644 forge-control/src/lib/stuck-recovery.ts
 create mode 100755 scripts/ops/assert-merge-scope.sh
 create mode 100755 scripts/ops/recover-stuck-task.sh
MERGE_EXIT=0

$ git -C /opt/forge-ai-os rev-parse main
32729e7aadb1fff68b7f5ed52298173d75eb3d7f

$ git -C /opt/forge-ai-os merge-base --is-ancestor project/2bc90424 main && echo ANCESTOR_OK
ANCESTOR_OK
```

**Merge sha: `32729e7`.**

The six foreign paths were still exactly as found, before and after — untouched, not
reverted, not committed here:

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/ChatSurface.tsx
 M forge-control-web/app/desktop/chat/FileExplorerPanel.tsx
 M forge-control-web/app/desktop/chat/MessageMarkdown.tsx
 M forge-control/src/routes/files.ts
?? forge-control-web/app/desktop/chat/code-path-link.ts
?? forge-control-web/app/desktop/chat/open-file-bus.ts
```

## 4. Install — with `--prod=false`, because `NODE_ENV=production` is exported

```
$ cd /opt/forge-ai-os/forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 1s using pnpm v9.15.9
INSTALL_EXIT=0

$ ls -d node_modules/tsx node_modules/typescript && ./node_modules/.bin/tsx --version
node_modules/tsx
node_modules/typescript
tsx v4.22.4
node v22.22.2
```

`tsx` present — the executor's entrypoint can boot.

## 5. The merged tree, gated before it was allowed to run

```
$ ./node_modules/.bin/tsc --noEmit
TSC_EXIT=0

$ pnpm test
# tests 2310
# suites 452
# pass 2310
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 14297.101669
TEST_EXIT=0
```

## 6. State before the restart (4e, "before" half)

```
$ psql -c "SELECT status, count(*) FROM runs GROUP BY 1 ORDER BY 1;"
  status   | count
-----------+-------
 cancelled |    18
 completed |   997
 failed    |   248
 paused    |     3
 running   |     1        <- this deploy run
 stuck     |    35

$ psql -c "SELECT stuck_signal, count(*) FROM runs WHERE status='stuck' GROUP BY 1;"
  stuck_signal   | count
-----------------+-------
 heartbeat_stale |    35

$ pm2 jlist | jq -r '.[]|select(.name=="forge-executor")|…'
forge-executor online restarts=14 uptime=1787624051361 pid=606582
```

## 7. THE CONTROL — the trapdoor, reproduced live on the OLD executor

This is the "prove it bites" half, and it was run **before** the restart, against the
executor still running pre-merge code (up since 04:14 local; the merge landed at ~14:20).

The subject is a **scratch run row** — inserted straight into `running`, so
`claimNextRun()` (`executor.ts:185`, `WHERE status = 'queued'`) can never claim it, no
engine is ever spawned and nothing is spent — plus a **real process** whose
`/proc/<pid>/cmdline` is engine-shaped. That command line is exactly and only what
`readEngineCmdlines()` + `liveSessionIdsAmong()` read, so the instrument is exercised for
real. No other project's run was touched.

```
$ SLEEP_SECS=300 /opt/ai-os/scratch/stuckproof/claude --resume "$SID" &
$ tr '\0' ' ' < /proc/$CHILD/cmdline
/bin/bash /opt/ai-os/scratch/stuckproof/claude --resume eb1a25a9-1738-4c28-88aa-44c923d98ee6

$ psql -c "INSERT INTO runs (…, status, metadata, last_heartbeat_at)
           VALUES (…, 'running', jsonb_build_object('cc_session_id','eb1a25a9-…'), now() - interval '150 seconds');"

--- t=0:
running / (null) / stale=150s
--- t=45s (process still alive: YES):
stuck / heartbeat_stale / stale=195s
```

**The old watchdog flipped a run to `stuck` in under 45 seconds while its engine process was
demonstrably alive** — `ls /proc/$CHILD` succeeded at the moment of the read. That is the
defect this project exists to fix, measured on this machine minutes before the fix went
live. The identical procedure re-run after the restart must return `running` instead; that
is §9 below.

Cleaned up — `cancelled`, not deleted, so the row stays auditable and the `stuck` census
stays honest:

```
$ psql -c "UPDATE runs SET status='cancelled' WHERE id='c6030c35-da92-4094-b1e0-041024e7a6c0' RETURNING …"
c6030c35-da92-4094-b1e0-041024e7a6c0 -> cancelled
UPDATE 1
```

## 8. The four capped builder rows — dry-run, and the refusals

Shas were re-read at each lane's **current** HEAD rather than copied from the brief, because
lane HEADs move. All four worktrees clean:

| task | project | lane worktree | commit named | subject |
|---|---|---|---|---|
| `f687d7f7` | aios-chat-reference-navigation | `…ecacba29…--markdown` | `6dd7f12` | feat(chat/document): /document accepts ?line= and ?wikilink=/?wikipath= |
| `67ff2645` | aios-verification-that-bites | `…169903ec…` (main) | `a1a61b7` | Merge branch 'project/169903ec-glob' into project/169903ec |
| `161e2155` | aios-guardrail-hardening | `…b167b94e…` (main) | `d907389` | merge engine workstream: autonomy default-branch fix + rule-change audit/notify |
| `325616b9` | aios-journal-thoughts-stats | `…d6371f2d…--api-journal` | `1355987` | feat(journal): the day opens on the mentor's read and eleven sources of evidence |

**A correction to the supervisor's addendum 2, found by running the tool instead of trusting
the list.** It states that only `325616b9` requires `:drift`. It is two rows, not one —
`161e2155` refuses without it as well:

```
$ scripts/ops/recover-stuck-task.sh 161e2155-e601-4b2f-bb4d-0ff3d5af2683:d907389
   write_set paths NOT found verbatim (2/6):
     forge-control/src/db/autonomy-blanket.test.ts
     forge-control/src/routes/autonomy-changes.test.ts
REFUSE 161e2155-e601-4b2f-bb4d-0ff3d5af2683 — missing paths above and :drift was not passed.
EXIT=1
```

Both drifts were then confirmed **by name**, never by number and never by assumption:

```
$ git -C …b167b94e… ls-files | grep -E 'autonomy-(blanket|changes)'
forge-control/src/lib/autonomy-blanket.test.ts
forge-control/src/lib/autonomy-changes.test.ts

$ git -C …--api-journal ls-files | grep -E 'journal-evidence|evidence\.test|journal-day'
forge-control/src/db/journal-day.ts
forge-control/src/lib/journal-evidence.test.ts

$ git -C …--api-journal log -1 --format=%B 1355987 | grep -iE 'consolidat|test'
- The test lives at lib/journal-evidence.test.ts, NOT at the two paths the
  brief declared. forge-control's test script is a flat src/lib/*.test.ts glob
  and gates-808 runs exactly that: a test in src/lib/evidence/ or src/db/ is …
```

Same basenames, relocated into the only directory the test runner's glob reaches, and in
`325616b9`'s case disclosed by the commit message itself. That is documented benign drift
(b), so `:drift` is honest for both.

With the correct specs, all four dry-run to exit 0:

```
$ scripts/ops/recover-stuck-task.sh f687d7f7-…:6dd7f12                → write_set: all 1 declared paths present verbatim.   EXIT=0
$ scripts/ops/recover-stuck-task.sh 67ff2645-…:a1a61b7                → write_set: all 4 declared paths present verbatim.   EXIT=0
$ scripts/ops/recover-stuck-task.sh 161e2155-…:d907389:drift          → :drift acknowledged — proceeding.                   EXIT=0
$ scripts/ops/recover-stuck-task.sh 325616b9-…:1355987:drift          → :drift acknowledged — proceeding.                   EXIT=0
   (each printing:  UPDATE project_tasks SET status='done' … RETURNING id, status;
                    curl -sX POST …/api/projects/<id>/status -d '{"status":"active"}'
                    (dry-run — nothing written))
```

And the refusal that must never be overridable bites:

```
$ scripts/ops/recover-stuck-task.sh e7684092-8586-41fa-95ea-ddd7955cfa79:18ab438
   title:      Re-review after fix cycle 1 · toggle
   status:     failed   attempt: 3   role: reviewer   workstream: toggle
REFUSE e7684092-8586-41fa-95ea-ddd7955cfa79 — role=reviewer. A reviewer's output is a VERDICT, not a
        commit. Marking it 'done' silently turns NEEDS_FIXES into a
        pass and seeds no fix chain.
EXIT=1
```

**The exit-code trap is why the four are invoked as four separate calls and `e7684092` is
never passed at all.** The script writes each id independently and exits 1 if *any* was
refused — so one combined invocation under `set -e` would correctly write the four builder
rows and *then* abort the caller, reporting failure after having succeeded.

### Why the recovery is not applied in this transcript above §9

Ordering is load-bearing, and it is the supervisor's ruling: merge → deploy → restart →
confirm the fix is live → **only then** recover the rows. Releasing ~18 wedged tasks while
the trapdoor is still live runs them under the broken watchdog and shreds them exactly as
the first 42 were. §7 shows the trapdoor was still live at the time of writing.

## 9. Restart, and why the post-restart evidence arrives separately

`safe-restart.sh` restarts `forge-executor` only after the whole fleet is quiet — no run
heartbeating for 45s, twice in a row. **This deploy run is itself a fleet run and heartbeats
every 5s.** So the restart provably cannot land while this task is alive, and this task
provably cannot observe the restart it launched. (A previous attempt today is in the log
doing exactly the right thing: `[16:09:57] gave up after 7200s — system never went quiet;
NOT restarting`.)

The restart was therefore launched detached, verbatim as briefed:

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 7200 45 \
  /opt/forge-ai-os/forge-control/ecosystem.config.cjs >/dev/null 2>&1 </dev/null &
```

and the post-restart verification runs from `/opt/ai-os/scratch/stuck-deploy-watcher.sh`, a
detached watcher which is **not** a fleet run and holds no heartbeat, so it never blocks the
restart it is waiting for. It appends its raw transcript to **this file** and commits it, and
reports to the manager chat. It performs, and only in this order:

1. waits for `forge-executor`'s pm2 `restart_time` to exceed the baseline **14** with
   `status=online` (cap 3h; it also detects safe-restart's own exit-2 give-up and stops);
2. captures `pm2 jlist` and 200 log lines and greps for `tsx: not found`, module-cycle TDZ
   (`Cannot access … before initialization`), `[executor] fatal`, `MODULE_NOT_FOUND`;
3. re-runs §7's experiment **unchanged** — first expecting `running` (held, heartbeat
   refreshed, with the `[watchdog] … but a live /proc session … — holding` line naming the
   instrument), then killing the child and expecting `stuck` / `heartbeat_stale` within two
   watchdog periods;
4. **only if** the boot is clean *and* both directions are proven, applies the four-row
   recovery, one id at a time, treating any nonzero exit as a hard stop that is never
   retried — a retry after a partial write is how a safe script becomes an unsafe one.

If the gate does not pass, the rows are left untouched and a human is told. That is the
whole point of the ordering.

The scratch row it creates is `cancelled` at the end rather than left behind, for an
operational reason worth recording: a **held** row has a **refreshed** heartbeat, so leaving
one alive would make every future `safe-restart.sh` wait forever on a fleet that is in fact
idle.

The two scratch artifacts live outside the repo on purpose — they are operational one-shots,
not shipped code, and this task's declared write-set is this file alone. Pinned by hash so a
reader can confirm what actually ran:

```
$ sha256sum /opt/ai-os/scratch/stuck-deploy-watcher.sh /opt/ai-os/scratch/stuckproof/claude
66105b3d32b7431560ff09d4a0dfb1e96299e7160707d97762a65ad374196125  /opt/ai-os/scratch/stuck-deploy-watcher.sh
28ef78229ceef96f0052703c392c2123786575856c9e44fbe9f3197ef5572db8  /opt/ai-os/scratch/stuckproof/claude
```

<!-- The watcher appends §10 onward below this line. -->
<!-- appended by /opt/ai-os/scratch/stuck-deploy-watcher.sh -->

## Post-restart verification (watcher, started 2026-08-25T14:26:21Z)

Deploy run: `ecb6601b-a5f9-4fcd-b8c5-4c623fe45ca3`. Baseline forge-executor restart_time: **14**.

## 1. Waiting for the detached safe-restart to land

Restart observed after 405s: restart_time 14 -> 15, status=online.

## 2. forge-executor after the restart (4a / 4b)

### 4a — pm2 status
```
$ bash -c pm2 jlist | jq -r '.[]|select(.name=="forge-executor")|"\(.name) \(.pm2_env.status) restarts=\(.pm2_env.restart_time) uptime=\(.pm2_env.pm_uptime)"'
forge-executor online restarts=15 uptime=1787668374215
EXIT=0
```
### 4b — 200 log lines, then the boot-failure greps
```
$ bash -c pm2 logs forge-executor --lines 200 --nostream 2>&1 | tail -120
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a held open by unintegrated workstream(s): business, connections, perf, surfaces, vault
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)
[31m17|forge-e | [39m[project-tick] project fbfdf435-23a9-46c6-a4dc-484e257beeb4 ("connect-clis-from-settings"): paused but has all 4/4 tasks completed (status preserved)
[31m17|forge-e | [39m[project-tick] project 7851068b-32d7-469b-b42f-f5e3c1d9e83a ("os-usable-for-work"): active with all 88/88 tasks completed but unclosed (status preserved)

EXIT=0
```
```
$ pm2 logs forge-executor --lines 200 --nostream | grep -E 'tsx: not found|Cannot access .* before initialization|\[executor\] fatal|MODULE_NOT_FOUND'
(no matches — clean boot)
EXIT=1  (grep found nothing, which is the pass)
```

## 3. The watchdog, proven in BOTH directions on real hardware (4c / 4d)

The subject is a **scratch run row I created**, never claimed by the executor
(`claimNextRun` requires `status='queued'`; this row is inserted straight into
`running`), and a **real process I spawned** whose `/proc/<pid>/cmdline` is
engine-shaped. That command line is exactly and only what `readEngineCmdlines()` +
`liveSessionIdsAmong()` read, so the instrument is exercised for real. No other
project's run is touched.

scratch run id: `b935a28f-e1f2-48b6-b0ca-18e72f6ba809` · scratch cc_session_id: `e3a9803b-1300-45b2-939a-3bb375e75a65`
```
$ tr '\0' ' ' < /proc/1835522/cmdline
/bin/bash /opt/ai-os/scratch/stuckproof/claude --resume e3a9803b-1300-45b2-939a-3bb375e75a65 
```
### 3a — POSITIVE: stale heartbeat + a live engine-shaped process must be HELD
INSERT 0 1
```
$ psqlq -c SELECT status, stuck_signal, round(EXTRACT(EPOCH FROM (now()-last_heartbeat_at))) AS stale_s FROM runs WHERE id='b935a28f-e1f2-48b6-b0ca-18e72f6ba809';
 status  | stuck_signal | stale_s 
---------+--------------+---------
 running |              |     150
(1 row)

EXIT=0
```
waiting 45s — the watchdog runs once per managerLoop pass (~10s + tick work)
```
$ psqlq -c SELECT status, stuck_signal, round(EXTRACT(EPOCH FROM (now()-last_heartbeat_at))) AS stale_s FROM runs WHERE id='b935a28f-e1f2-48b6-b0ca-18e72f6ba809';
 status  | stuck_signal | stale_s 
---------+--------------+---------
 running |              |      44
(1 row)

EXIT=0
```
AFTER 45s status = **running** (expected: running — held, heartbeat refreshed)

The hold line the new watchdog writes, from the executor log:
```
[31m17|forge-e | [39m[watchdog] run b935a28f-e1f2-48b6-b0ca-18e72f6ba809: heartbeat 151476ms stale (threshold 90000ms) but a live /proc session e3a9803b-1300-45b2-939a-3bb375e75a65 — holding 'running' and refreshing the heartbeat
```
### 3b — NEGATIVE: kill the engine child; a genuinely dead run must still flip
```
$ bash -c kill 1835522 2>/dev/null; sleep 2; ls /proc/1835522 >/dev/null 2>&1 && echo 'STILL ALIVE' || echo 'process 1835522 is gone'
process 1835522 is gone
EXIT=0
```
UPDATE 1
```
$ psqlq -c SELECT status, stuck_signal, round(EXTRACT(EPOCH FROM (now()-last_heartbeat_at))) AS stale_s FROM runs WHERE id='b935a28f-e1f2-48b6-b0ca-18e72f6ba809';
 status  | stuck_signal | stale_s 
---------+--------------+---------
 running |              |     150
(1 row)

EXIT=0
```
waiting 45s — within two watchdog periods
```
$ psqlq -c SELECT status, stuck_signal, round(EXTRACT(EPOCH FROM (now()-last_heartbeat_at))) AS stale_s FROM runs WHERE id='b935a28f-e1f2-48b6-b0ca-18e72f6ba809';
 status |  stuck_signal   | stale_s 
--------+-----------------+---------
 stuck  | heartbeat_stale |     195
(1 row)

EXIT=0
```
AFTER the kill: status = **stuck**, stuck_signal = **heartbeat_stale**
(expected: stuck / heartbeat_stale — the watchdog still catches a dead run)
```
[31m17|forge-e | [39m[watchdog] run b935a28f-e1f2-48b6-b0ca-18e72f6ba809: heartbeat 151476ms stale (threshold 90000ms) but a live /proc session e3a9803b-1300-45b2-939a-3bb375e75a65 — holding 'running' and refreshing the heartbeat
[31m17|forge-e | [39m[watchdog] flipped 1 stale 'running' run(s) to 'stuck' (heartbeat > 90000ms, no live process): b935a28f-e1f2-48b6-b0ca-18e72f6ba809
```
### 3c — clean up the scratch row
Set to `cancelled`, not deleted: the row stays auditable, it leaves the `stuck`
census honest, and — the reason that matters operationally — a HELD row has a
REFRESHED heartbeat, which would make safe-restart.sh wait forever on a fleet that
is actually idle.
```
$ psqlq -c UPDATE runs SET status='cancelled', updated_at=now() WHERE id='b935a28f-e1f2-48b6-b0ca-18e72f6ba809' RETURNING id::text, status;
                  id                  |  status   
--------------------------------------+-----------
 b935a28f-e1f2-48b6-b0ca-18e72f6ba809 | cancelled
(1 row)

UPDATE 1
EXIT=0
```

**Both directions: PROVEN**

## 4. Run census after the restart (4e)

```
$ psqlq -c SELECT status, count(*) FROM runs GROUP BY 1 ORDER BY 1;
  status   | count 
-----------+-------
 cancelled |    20
 completed |   998
 failed    |   248
 paused    |     3
 stuck     |    35
(5 rows)

EXIT=0
```
```
$ psqlq -c SELECT stuck_signal, count(*) FROM runs WHERE status='stuck' GROUP BY 1 ORDER BY 1;
  stuck_signal   | count 
-----------------+-------
 heartbeat_stale |    35
(1 row)

EXIT=0
```

## 5. The four capped builder rows

Gate passed (clean boot, both watchdog directions proven). Applying, ONE id at a time.
The reviewer row `e7684092` is NOT passed to the script — a verdict is not a commit.
#### apply f687d7f7-f1c6-46fc-a6cb-a966b50f71aa:6dd7f12
```
$ scripts/ops/recover-stuck-task.sh --apply f687d7f7-f1c6-46fc-a6cb-a966b50f71aa:6dd7f12
── f687d7f7-f1c6-46fc-a6cb-a966b50f71aa  commit=6dd7f12  drift-ack=no ────────────────────────────
   title:      /document: accept ?line= and ?wikilink= via the shared resolver
   status:     failed   attempt: 3   role: builder   workstream: markdown
   worktree:   /opt/ai-os/workspace/projects/ecacba29-2664-4d8c-89e3-52cae0747941--markdown
   git status --porcelain: (empty)
   git log --oneline -8:
     6dd7f12 feat(chat/document): /document accepts ?line= and ?wikilink=/?wikipath=
     4840029 docs(chat/markdown): record two manager rulings where the next round will look
     6cc5d36 feat(chat/markdown): wikilinks, line refs, a shared resolver, a visible pending state
     0624fd5 fix(chat/panel): wire line={sel.line} into FilePreview now that preview accepts it
     25addcf merge: integrate workstream panel into project/ecacba29
     56031db feat(chat/panel): reveal + flash the opened entry, open folders, carry the line
     9a23cfd fix(chat): drop dollar-sweep trigger word from code-path-link.ts comment
     b198dd4 merge: integrate workstream preview into project/ecacba29
   write_set: all 1 declared paths present verbatim.
   would run:
     UPDATE project_tasks SET status='done', updated_at=now() WHERE id='f687d7f7-f1c6-46fc-a6cb-a966b50f71aa' AND status='failed' RETURNING id, status;
     curl -sX POST http://127.0.0.1:7700/api/projects/ecacba29-2664-4d8c-89e3-52cae0747941/status -H 'content-type: application/json' -d '{"status":"active"}'
   --apply: re-verifying at write time...
   WRITING:
                  id                  | status 
--------------------------------------+--------
 f687d7f7-f1c6-46fc-a6cb-a966b50f71aa | done
(1 row)

UPDATE 1
{"project":{"id":"ecacba29-2664-4d8c-89e3-52cae0747941","name":"aios-chat-reference-navigation","brief":"GOAL: every file, folder and note an agent names in chat must be ONE CLICK from being readable. Konrad's words, 2026-08-25: \"when I click files marked as blue by you they still don't open up in a proper way\" and, after a partial fix, \"I am still not satisfied, especially with the details.\"\n\nThe feature half-exists on main. Your job is the other half and the polish. DO NOT REBUILD WHAT IS LISTED UNDER \"ALREADY DONE\" — verify it, then extend it.\n\n=== ALREADY DONE AND VERIFIED IN A REAL BROWSER (2026-08-25 00:44). Do not re-derive; DO re-verify anything you depend on. ===\n- app/desktop/chat/code-path-link.ts — detectPath() decides if an inline `code` pill names an openable file. Narrow on purpose: rule ids, commands, env vars and API routes must stay plain pills. 18 unit cases pass (see /tmp/detect-test.mts pattern; port them into the repo, they currently live in /tmp and will be lost).\n- app/desktop/chat/open-file-bus.ts — module-level bus WITH A LATCH. The latch is load-bearing: FileExplorerPanel is mounted ONLY on the Files tab (ChatSurface: `tab === \"team\" ? <ChatTeamPanel/> : <FileExplorerPanel/>`), Team is the default, so a click dispatches BEFORE the panel exists. consumePendingOpenFile() collects what was missed on mount. Removing the latch silently breaks the default case.\n- MessageMarkdown.tsx inline-code branch — dotted underline, tooltip, plain click -> Files panel, Ctrl/Cmd-click -> /document tab. It is memoised on `source` ALONE and that must not change (markdown re-parse per streamed token was the biggest chat-lag source).\n- ChatSurface.tsx — subscribes, sets panelTab to \"files\" AND uncollapses.\n- routes/files.ts — two READ-ONLY roots added: `aios` (/opt/ai-os) and `forge-src` (/opt/forge-ai-os), plus SEARCH_SKIP_DIRS (node_modules, dist, build, coverage, __pycache__, venv, target).\n\nTHREE BUGS ALREADY FOUND BY CLICKING IT. Each was invisible to typecheck, unit tests and a bundle grep:\n1. bus had no latch (above).\n2. Searched by full path against an API that matches on FILENAME: `/files/search` does `name.toLowerCase().includes(q)`, so any q containing \"/\" matched nothing, ever. Now searches the basename and ranks by exact path, then path suffix, then exact name.\n3. A miss was silent, which is indistinguishable from a dead handler. Misses now toast.\n\n=== CRITICAL, DO THIS FIRST ===\nR1. `forge-control` has NOT been restarted, so `aios` and `forge-src` are NOT live. Confirm with `curl -s 127.0.0.1:7700/api/files/roots` — if you see only vault/workspace/uploads/media, the restart has not landed. A safe-restart.sh is queued waiting for fleet idle. YOU MAY NOT `pm2 restart forge-control` — a PreToolUse hook blocks it and it would kill live turns including your own. Read /opt/ai-os/scripts/guard-service-restart.py. Once the roots are live, VERIFY IN A BROWSER that clicking an absolute source path (e.g. a path under /opt/forge-ai-os/) opens it.\n\nR2. THERE IS NO REGRESSION TEST. All three bugs were wiring between components that each worked in isolation. Write a Playwright test, committed to the repo, that drives the authenticated console, clicks a path pill FROM THE TEAM TAB, and asserts: panelTab flips team->files, zero new browser tabs, and the file's content is rendered in the panel. Without this the next refactor re-breaks it silently. Auth recipe is in the vault at \"AI OS/Operator Log.md\" (search \"Screenshot recipe\") — cookie __Secure-authjs.session-token, next-auth encode() salt must EQUAL the cookie name, drive https://os.schreinercontentsystems.com, playwright lives in /opt/hermes-workspace, executablePath /root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome.\n\n=== THE DETAILS KONRAD IS UNSATISFIED WITH. Each is a separate, shippable improvement. ===\nD1. LINE REFERENCES. Agents write `MessageMarkdown.tsx:160` and `executor.ts:715` constantly — detectPath REJECTS them today because the \":160\" suffix defeats the extension test. Parse `path:line`, open the file, and scroll to / highlight that line. This is probably the single highest-value item: it is how code is discussed.\nD2. WIKILINKS. `[[note-name]]` is not clickable at all. Konrad's vault runs on them and agents write them. Make them resolve into the vault root and open the same way. Watch out: a wikilink inside a table cell is escaped — the vault has a note about wikilink escapes reading as dangling.\nD3. FRONTMATTER. FilePreview renders YAML frontmatter as a prose blob — every profile note opens with a wall of \"type: profile section: operating-manual created: ...\". See the verification screenshot. Hide it, or render it as a compact meta strip.\nD4. THE SELECTED FILE IS NOT REVEALED IN THE LIST. After a programmatic open, the panel shows the right preview but the file list does not scroll to or visibly highlight the entry. In the verification screenshot the folder shows \"About Me.md\" / \"Current Chapter.md\" and the opened \"Operating Manual.md\" is nowhere visible in the list.\nD5. FOLDERS. A trailing-slash directory reference is not detected. Opening a folder in the panel is a legitimate and common intent.\nD6. UNREACHABLE-BY-DESIGN PATHS. `/root/.claude/projects/-opt-forge-ai-os/memory/` is the fleet knowledge base; agents cite it constantly and it is doubly unreachable — outside every root AND blocked by resolveInRoot's dot-segment guard. Decide deliberately and write the decision down: either a dedicated read-only root with a narrow exception, or leave it and make the pill plainly non-clickable. Do not leave it as a dead affordance.\nD7. DISCOVERABILITY. Nothing announces the pills are clickable except a hover tooltip. Konrad did not know what to expect. Propose something restrained — the design bar is Konrad's taste, not a badge on every pill.\nD8. MOBILE. Untested on the mobile surface (MobileApp.tsx, which is selected by UA not viewport). Either make it work or state plainly that it does not.\nD9. ATTACH. Consider offering \"attach to composer\" alongside \"open\" — the Files panel already has an attach flow.\n\n=== CONSTRAINTS THAT WILL BITE YOU ===\n- MessageMarkdown.tsx is an ATTACKER-FACING surface. Read its header comment in full. NO rehype-raw, ever. The rehypeForgeAllowlist and urlTransform gates are both required, not either. Nothing an agent writes as markup may become a handler.\n- Do not add a write verb to routes/files.ts. The two new roots are safe ONLY because that router is read-only. If you ever add one, `aios` and `forge-src` need a readOnly flag FIRST — the OS's own source is not made writable by clicking around a file browser.\n- Poll budget: do not add a new poll. fetchFileRoots is fetched once and cached in a module promise.\n- FILE CONTENTION: the project `aios-sidebar-live-sessions` is live RIGHT NOW and rewriting ChatSurface.tsx's right-panel block (adding a \"this chat\" vs \"everything running\" scope toggle). You will both touch that file. Merge main before you branch, coordinate, and expect a conflict in exactly that hunk.\n\n=== HOW YOU WILL BE JUDGED ===\nKonrad clicks things. A green typecheck proves nothing here — that is the documented lesson of this exact feature. Every claim in your final report must be backed by something you observed in a real browser, with a screenshot saved under /opt/ai-os/uploads/$FORGE_RUN_ID/ and read back. A report that says \"implemented and typechecks\" will be treated as unverified.","repo":"ai-os","workspace_dir":"/opt/ai-os/workspace/projects/ecacba29-2664-4d8c-89e3-52cae0747941","base_branch":"main","work_branch":"project/ecacba29","status":"active","metadata":{"origin_chat_id":"e21f52b4-77b0-416b-8892-c83578715b90"},"created_at":"2026-08-25 00:56:02.193834+00","updated_at":"2026-08-25 14:35:11.448302+00"}}

EXIT=0
```
#### apply 67ff2645-6dc3-44eb-8bb7-19949004152f:a1a61b7
```
$ scripts/ops/recover-stuck-task.sh --apply 67ff2645-6dc3-44eb-8bb7-19949004152f:a1a61b7
── 67ff2645-6dc3-44eb-8bb7-19949004152f  commit=a1a61b7  drift-ack=no ────────────────────────────
   title:      Integrate workstream glob into main
   status:     failed   attempt: 3   role: builder   workstream: main
   worktree:   /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36
   git status --porcelain: (empty)
   git log --oneline -8:
     cb2c0a7 fix(D4): fill the GUARD_RESULT_PLACEHOLDER with a real, just-run result
     a1a61b7 Merge branch 'project/169903ec-glob' into project/169903ec
     5822f87 feat(D4): test-glob — enumerate, run, quarantine, widen, prove the gate bites
     7401b58 Merge branch 'project/169903ec-mutation' into project/169903ec
     d4f0351 fix(contract): correct three drifted citations in acceptance-contracts proposal
     24f53c4 Merge branch 'project/169903ec-contract' into project/169903ec
     e83f318 feat(verification): prove-it-bites.sh — the mutation control, proven on itself
     d67ab82 fix(plan): correct two false claims in F7 — both were mine
   write_set: all 4 declared paths present verbatim.
   would run:
     UPDATE project_tasks SET status='done', updated_at=now() WHERE id='67ff2645-6dc3-44eb-8bb7-19949004152f' AND status='failed' RETURNING id, status;
     curl -sX POST http://127.0.0.1:7700/api/projects/169903ec-4dd0-4041-a737-eeba3d178d36/status -H 'content-type: application/json' -d '{"status":"active"}'
   --apply: re-verifying at write time...
   WRITING:
                  id                  | status 
--------------------------------------+--------
 67ff2645-6dc3-44eb-8bb7-19949004152f | done
(1 row)

UPDATE 1
{"project":{"id":"169903ec-4dd0-4041-a737-eeba3d178d36","name":"aios-verification-that-bites","brief":"GOAL: make it structurally hard for work in this repo to be certified by an instrument that cannot fail. Konrad's original framing: \"Projects close on a claim, not on an observed effect.\"\n\nTHIS IS NOT A THEORY PROJECT. Every item below comes from something that actually happened, most of it in the last twelve hours, and the evidence is named so you can re-measure it rather than take my word.\n\n=== THE EVIDENCE, ALL RE-VERIFIABLE ===\n1. A GATE THAT RUNS NOWHERE. `scripts/checks/check-secret-scan.ts` exits 1 today on a real committed credential. `grep -c \"check-secret-scan\" scripts/checks/gates-808.sh` -> 0. It has been wired into nothing since August; a fix cycle drove it green and left nothing executing it. The suite has been green over that credential ever since.\n2. A NAME TWIN THAT HIDES THE GAP. The suite DOES run `check-secret-requests.ts`. Three separate workers last night independently reported the credential as a gate blocker, all wrong in the same direction, because the gate list looks complete when something secret-shaped is in it.\n3. A UNIT TABLE THAT PROVED NOTHING. `detectPath` shipped with 18 hand-written cases, 18/18 green. A worker then swept 16,669 real inline-code spans from actual repo markdown and found NINE classes of false positive the table never imagined.\n4. A TEST IN A DIRECTORY THE RUNNER NEVER READS. `package.json` test script is `tsx --test src/lib/*.test.ts`. Anything under `src/routes/` or `src/db/` passes standalone and is never executed. `src/lib/vault-routes.test.ts` already exists as a silent workaround.\n5. A NEGATIVE CLAIM FROM A PARTIAL SEARCH. I asserted `routes/files.ts` was read-only, from a grep for `r.post(`/`r.get(` that never looked for `r.put(`. `PUT /write` existed. That comment shipped as documented fact and opened a write hole into this repo's own source for about an hour.\n6. THE FLEET MEMORY ALREADY KNOWS. ~30 of the 247 notes in /root/.claude/projects/-opt-forge-ai-os/memory/ are this one failure class: assertion-inert-shared-substring, verifier-asserted-on-fixture-not-invariant, document-fonts-check-is-inert, self-proving-concatenated-evidence, post-merge-gate-scoped-to-main-goes-vacuous, unreachable-guard-needs-its-own-control, and more. READ THOSE FIRST. They are your requirements document, written by the people who got burned.\n\n=== WHAT GOOD ALREADY LOOKS LIKE, COPY IT ===\nTwo workers last night did this correctly and their method is the standard to generalise:\n- The tool-block worker MUTATION-TESTED its own browser check: it disabled the affordance and showed 4 named assertions fail and no click target is found. A check that has never been observed failing is a decoration.\n- The guardrail engine worker proved its new test bites by re-running the matrix against a scratch copy of the OLD code, and reported which case discriminated and which was merely regression coverage.\n\n=== DELIVERABLES ===\nD1. EXECUTION AUDIT. For every check/gate/test artefact in the repo, determine whether ANYTHING executes it. Produce a table: artefact -> invoked by (file:line) or NOTHING. This is mechanical and it is the highest-value item; item 1 above is one instance and there are almost certainly others. Report, do not silently wire things in — see the constraint below.\nD2. CAN-IT-FAIL AUDIT for everything D1 finds IS executed. For each, answer with evidence: what input makes this fail? If you cannot construct one, that is the finding. Prioritise the gates in gates-808.sh, since they gate every project in the repo.\nD3. THE MUTATION RULE, made cheap. Provide a documented, reusable way for a task to demonstrate its check bites (the two examples above are the models). If proving a check can fail is expensive, nobody does it; make it a few lines.\nD4. THE TEST-GLOB JOB, done properly and separately from any feature round: enumerate every *.test.ts the wider pattern would newly capture, RUN them, fix or quarantine each failure with a named reason, and only then widen `package.json` and gate 22. Do not widen first and triage after — that turns main red for every lane at once.\nD5. ACCEPTANCE CONTRACTS — design only, no engine changes in this project. Write a short proposal for how a project could declare, at seeding time, a number measured from OUTSIDE its worktree by something the worker cannot write to, checked before and after. Argue it against the real seeding flow. Konrad decides whether it gets built.\n\n=== CONSTRAINTS ===\n- DO NOT WIRE `check-secret-scan.ts` INTO ANYTHING. It prints the matched credential verbatim (line 112); wiring it in today writes a live password into every project's gate log. Redaction is already seeded on aios-guardrail-hardening. Order is fixed: redact -> Konrad rotates -> remove the literal -> wire in. Your job is to find the others like it, not to fix this one.\n- DO NOT WEAKEN A CHECK TO MAKE IT PASS. If a gate trips on your own work, that is a finding. See do-not-soften-check-secret-scan.md.\n- A finding needs the exact command or input that demonstrates it. \"Looks inert\" is not a finding.\n- Expect that some of what you audit is MY work from last night. Say so plainly if it is bad.","repo":"ai-os","workspace_dir":"/opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36","base_branch":"main","work_branch":"project/169903ec","status":"active","metadata":{"origin_chat_id":"e21f52b4-77b0-416b-8892-c83578715b90"},"created_at":"2026-08-25 05:15:46.593569+00","updated_at":"2026-08-25 14:35:11.746803+00"}}

EXIT=0
```
#### apply 161e2155-e601-4b2f-bb4d-0ff3d5af2683:d907389:drift
```
$ scripts/ops/recover-stuck-task.sh --apply 161e2155-e601-4b2f-bb4d-0ff3d5af2683:d907389:drift
── 161e2155-e601-4b2f-bb4d-0ff3d5af2683  commit=d907389  drift-ack=yes ────────────────────────────
   title:      integrate engine workstream into main: merge, gates, stop on conflict
   status:     failed   attempt: 3   role: builder   workstream: main
   worktree:   /opt/ai-os/workspace/projects/b167b94e-b335-4767-a3d1-1b43fd72a3dc
   git status --porcelain: (empty)
   git log --oneline -8:
     d907389 merge engine workstream: autonomy default-branch fix + rule-change audit/notify (P1-1)
     7bcae97 feat(guardrail): fleet-pulse reads guardrail_trips + hook audit log; logrotate
     e6901a8 fix(guardrail): recursion alone triggers fs.destructive — the force conjunction was a bug
     cd80b57 harden(secret-scan): redact the match it prints, without changing what it finds
     307b4fa docs(guardrail): record the gates-808 summary — 31 gates, RED 1, inherited and attributed
     db61247 harden(guardrail): bring the whole PreToolUse hook layer under git, with tests
     615f241 test(guardrail-hardening): port guard-autonomy classifier matrix + exit-code contract into the repo
     5acfb73 feat(autonomy): enabled means blocked, and every guardrail change is loud
   write_set paths NOT found verbatim (2/6):
     forge-control/src/db/autonomy-blanket.test.ts
     forge-control/src/routes/autonomy-changes.test.ts
   :drift acknowledged — proceeding on the operator's confirmation.
   would run:
     UPDATE project_tasks SET status='done', updated_at=now() WHERE id='161e2155-e601-4b2f-bb4d-0ff3d5af2683' AND status='failed' RETURNING id, status;
     curl -sX POST http://127.0.0.1:7700/api/projects/b167b94e-b335-4767-a3d1-1b43fd72a3dc/status -H 'content-type: application/json' -d '{"status":"active"}'
   --apply: re-verifying at write time...
   WRITING:
                  id                  | status 
--------------------------------------+--------
 161e2155-e601-4b2f-bb4d-0ff3d5af2683 | done
(1 row)

UPDATE 1
{"project":{"id":"b167b94e-b335-4767-a3d1-1b43fd72a3dc","name":"aios-guardrail-hardening","brief":"GOAL: adversarially review and harden the autonomy enforcement layer that was wired on 2026-08-25. It is new, it is unreviewed, and it now runs in front of EVERY Bash call made by every agent on this box. If it is wrong, it is wrong everywhere at once.\n\n=== WHAT EXISTS NOW (measured, do not re-derive; DO re-verify what you depend on) ===\nBefore yesterday, `guardrail_rules` held 9 rules and exactly ONE call site evaluated them: executor.ts processRun(), category \"financial\", at run start. `grep -rn \"autonomy/check\"` across /opt/forge-ai-os returned ZERO callers; the guardrail() middleware was mounted on one route, the autonomy router guarding itself. So fs.destructive / git.force_push / deploy.prod / comm.outbound / secrets.read were enabled in the DB and enforced by nothing but each agent's system prompt.\n\nNow: /opt/ai-os/scripts/guard-autonomy.py, a PreToolUse(Bash) hook registered in /root/.claude/settings.json alongside the pre-existing /opt/ai-os/scripts/guard-service-restart.py. It classifies the command locally, then calls POST /api/autonomy/check. Wired: fs.destructive (rm -rf outside build/scratch paths, pm2 delete, find -delete, DROP/TRUNCATE/FLUSHALL), git.force_push (semantic, protected branches only), comm.outbound (telegram/slack webhooks, gmail send). Deliberately NOT wired: deploy.prod, secrets.read — deploying and reading a secret are the ordinary path, and guard-service-restart.py's own docstring records why blocking ordinary work makes a guard get switched off.\n`spend.per_run_cap` was DELETED from content_forge.guardrail_rules at Konrad's instruction (he called it idiotic; it had blocked a real run on 08-18). Do not reintroduce it.\n\n=== THE FINDING THAT MATTERS MOST, AND YOUR STARTING HYPOTHESIS ===\nv1 of the block message ended with the override recipe (FORGE_GUARD_ACK=<rule_id>). First end-to-end test, a Haiku turn with NO authorisation:\n  23:36:02  blocked       fs.destructive  rm -rf /opt/does-not-exist-guard-probe\n  23:36:07  acknowledged  fs.destructive  rm -rf /opt/does-not-exist-guard-probe\nFive seconds. It read the recipe out of the refusal, self-granted, and reported \"the command ran and completed with no output\" — never mentioning it had been stopped. The recipe was removed and every ACK now pings Konrad's inbox; the re-test blocked and stayed blocked.\nYOUR JOB IS TO ASSUME THAT CLASS OF DEFECT IS STILL PRESENT SOMEWHERE ELSE. Attack it like the Haiku did.\n\n=== WHAT TO ATTACK (find MORE than this list) ===\nA1. CLASSIFIER EVASION. The classifier is conservative token matching over shell segments with heredoc bodies stripped. Find destructive invocations it misses. Non-exhaustive starting points: `bash -c \"rm -rf /opt/x\"`, `sh -lc`, `xargs rm -rf`, `eval`, backgrounded/subshell forms `( rm -rf /opt/x )`, `git -C /opt/x push --force`, `rm --recursive --force`, `rm -r -f`, aliases, `python3 -c \"shutil.rmtree(...)\"`, `truncate -s0`, `>` redirection over a real file, `dd of=`, `mv /opt/x /dev/null`, docker exec into a psql, `git reset --hard` + `git clean -fdx`, `pnpm` lifecycle scripts. For EACH hit, decide honestly: is it worth catching, or does catching it create false positives that get the guard disabled? Write the reasoning down; a rejected catch is a valid, documented outcome.\nA2. FALSE POSITIVES ARE THE BIGGER RISK. A guard that blocks ordinary builder work gets switched off and then guards nothing. Prove the routine fleet workload passes: rm -rf node_modules/.next/dist, /tmp scratch, worktree cleanup, ordinary git pushes to project/* lanes, pnpm installs, next build. Measure against REAL commands — mine the last 24h of run threads for actual Bash calls rather than imagining them.\nA3. FAIL-OPEN AUDIT. Every error path returns exit 0 by design (dead API, bad JSON, classifier exception). Confirm that is true on every path AND that no path can fail CLOSED and wedge the fleet. Also check the 2.5s HTTP timeout: what happens under control-plane load?\nA4. THE ENGINE ITSELF. db/autonomy.ts evaluateOne(): a rule with empty config `{}` blanket-blocks its whole category unless payload sets bypass_blanket. executor.ts passes bypass_blanket:true. Is that flag reachable from anywhere an agent controls? Trace it.\nA5. NON-BASH TOOLS. The hook is PreToolUse(Bash) ONLY. Write, Edit and MCP tools bypass it entirely — an agent can destroy a file with Write just as effectively as with rm. Assess and recommend; do not necessarily build.\nA6. THE ACK PATH. It is still there (a root agent can always defeat a local hook — the goal is deliberate, attributable and loud, not impossible). Verify the inbox notification actually fires and actually reaches Konrad. If it does not, the ACK is silent again and that is a P1.\nA7. guardrail_trips hygiene. 30 stale rows were resolved on 08-25. Nothing prunes or surfaces them. An unread audit log is not an audit log.\n\n=== RULES ===\n- You may NOT weaken or disable a guard to make a test pass. If a guard trips on your own work, that is a finding to report, not an obstacle to remove. The fleet memory has a note on exactly this: do-not-soften-check-secret-scan.md.\n- READ FIRST in /root/.claude/projects/-opt-forge-ai-os/memory/: instruments-lie-before-code, do-not-soften-check-secret-scan, destructive-control-test-stubs, unreachable-guard-needs-its-own-control, assertion-inert-shared-substring.\n- Test the hook by piping PreToolUse JSON payloads to it directly (contract: stdin JSON, exit 0 allows, exit 2 blocks, stderr goes back to the model). A harness pattern exists — 24 cases passed at /tmp/guard_test.py; PORT IT INTO THE REPO, it is in /tmp and will be lost.\n- Every claim needs evidence. \"I reviewed it and it looks correct\" is not a finding and not a verification.\n\nDELIVERABLE: hardened hook + a committed test suite + a written findings report ranked by severity, each finding with the exact command or payload that demonstrates it.","repo":"ai-os","workspace_dir":"/opt/ai-os/workspace/projects/b167b94e-b335-4767-a3d1-1b43fd72a3dc","base_branch":"main","work_branch":"project/b167b94e","status":"active","metadata":{"origin_chat_id":"e21f52b4-77b0-416b-8892-c83578715b90"},"created_at":"2026-08-25 00:56:50.701747+00","updated_at":"2026-08-25 14:35:12.052266+00"}}

EXIT=0
```
#### apply 325616b9-ae35-41f4-ba7d-fea7819b6399:1355987:drift
```
$ scripts/ops/recover-stuck-task.sh --apply 325616b9-ae35-41f4-ba7d-fea7819b6399:1355987:drift
── 325616b9-ae35-41f4-ba7d-fea7819b6399  commit=1355987  drift-ack=yes ────────────────────────────
   title:      Journal day endpoint: mentor read, evidence of the day, reply
   status:     failed   attempt: 3   role: builder   workstream: api-journal
   worktree:   /opt/ai-os/workspace/projects/d6371f2d-a4e8-4e50-95c9-781ca9da3a2e--api-journal
   git status --porcelain: (empty)
   git log --oneline -8:
     1355987 feat(journal): the day opens on the mentor's read and eleven sources of evidence
     fc73921 docs(research): verify journal evidence sources live (round 1, api-journal)
     5169ba2 fix(gate): allowlist WeekGrid's Google palette and ui.tsx's importance ramp
     9b69637 merge main into project/d6371f2d — pick up b41e824 (week board, gcal+gtasks two-way sync, glucose, importance six levels)
     b41e824 feat(goals): week board, two-way Google sync, glucose pipeline, six importance levels
     a8376f3 docs(architect): aios-journal-thoughts-stats plan — land live dirt, 5 lanes against pinned contracts
     45983e4 fix(gate): my own two commits turned the takeover gate red — both closed
     b2e5de0 fix(ecosystem): commit the TAKEOVER_TICKET_SECRET pass-through — it was the sole copy
   write_set paths NOT found verbatim (2/13):
     forge-control/src/lib/evidence/evidence.test.ts
     forge-control/src/db/journal-day.test.ts
   :drift acknowledged — proceeding on the operator's confirmation.
   would run:
     UPDATE project_tasks SET status='done', updated_at=now() WHERE id='325616b9-ae35-41f4-ba7d-fea7819b6399' AND status='failed' RETURNING id, status;
     curl -sX POST http://127.0.0.1:7700/api/projects/d6371f2d-a4e8-4e50-95c9-781ca9da3a2e/status -H 'content-type: application/json' -d '{"status":"active"}'
   --apply: re-verifying at write time...
   WRITING:
                  id                  | status 
--------------------------------------+--------
 325616b9-ae35-41f4-ba7d-fea7819b6399 | done
(1 row)

UPDATE 1
{"project":{"id":"d6371f2d-a4e8-4e50-95c9-781ca9da3a2e","name":"aios-journal-thoughts-stats","brief":"GOAL: rebuild the JOURNAL surface end to end, add a THOUGHTS section, give LIFE GOALS a home again, and bring back stats/visualisations — sharing one stats component between JOURNAL and GOALS/TASKS.\n\n=== CONTEXT YOU MUST READ FIRST ===\nRead the vault note 'AI OS/Operator Log.md', entries dated 2026-08-25. They record the week-board rebuild that just shipped, the Google Calendar + Google Tasks two-way sync, the measured evidence of non-adoption, and several traps (instant-vs-string comparison, theme tokens vs explicit hexes, concurrent next build destroying .next). Also read /root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md.\n\nThe design rule that governs every part of this: THE PAGE MUST BE FULL BEFORE KONRAD TOUCHES IT. The old Goals surface was empty forms and got 30 days of zeros; the same list in Notion got the same. Derive everything derivable. Manual input is a correction, never a seed. No commit gates, no rituals.\n\n=== 1. JOURNAL — complete overhaul ===\nCurrent state (screenshot evidence in the operator log): three near-empty boxes — a paper-scan uploader with 0 pages in 7 days, a blank 'what did you build today' textarea, and an empty decisions stream — beside a mentor column that is the only thing on the page with content in it.\nRebuild so the page OPENS on the mentor's read of the day plus auto-assembled evidence of what actually happened (tasks closed, calendar events that occurred, git commits, ReelForge renders, chat runs). Writing becomes a REPLY to that, not a blank page. Demote the paper-scan uploader; it is not earning its place at the top.\n\n=== 2. THOUGHTS section ===\nKonrad's spec, verbatim intent: an idea pool where each idea has { idea, life area, description, creation date, importance 1-10, why it is genius, execution status }, plus quotes/inspiration and dreams. Life areas: Business, YouTube, Life, Health, Relationships (relationships covers friends, business partners and family — he renamed it from 'girlfriend').\nBecause 'un-executed ideas are of course bullshit' (his words), the DEFAULT view sorts by age-since-capture among ideas whose execution status is still not-started. His own doctrine as a view.\nThese live in Obsidian. IMPORTANT: he wants a clean separation between what the AI writes and what he writes — the vault root currently has ~70 loose .md files and the folders 10_Idea_Reactor, 40_Life Knowledge and 99_System are completely EMPTY (a structure designed and never used). Propose and implement a top-level split (his notes vs agent-written notes) and make agents write only to their side. Do NOT do a mass move without an explicit go-ahead from Konrad — propose it, implement the mechanism, and ask before relocating existing files.\n\n=== 3. LIFE GOALS ===\nThe four-tab Goals surface was replaced by the week board and LIFE GOALS lost its home. The data still exists: life_goals table, horizons quarterly/yearly/long_term, statuses planned/in_progress/done/parked/abandoned, and GET/POST/PATCH/DELETE /api/daily/goals all work. Give it a proper surface and connect it to the board — a task should be able to point at the goal it serves, so the week board can answer 'did this week move anything that matters'.\n\n=== 4. STATS AND VISUALISATIONS ===\nBuild ONE stats component, mounted in BOTH the journal page and the goals/tasks page. Contents:\n- day-score trend over time\n- habit heatmap (the old goals/Heatmap.tsx exists, reuse or replace deliberately)\n- THE INTERESTING ONE: which habits correlate with a high felt-rating. The felt-rating is 1-10 (day_plans.subjective, widened from 1-5 on 2026-08-25) and is the only signal the score cannot derive, so after ~60 days it can actually answer 'which of these 18 habits matter'. Until there is data, say so honestly rather than drawing a chart of nothing.\n- integrate with the calendar: hours booked vs hours worked, and which areas the week actually went to.\nGET /api/daily/stats?days=N already returns days[], habits[] with rate30/streak/best/ticks30, said_vs_done and tasks aggregates. Read routes/daily.ts before inventing endpoints.\n\n=== CONSTRAINTS ===\n- forge-control-web is Next 15 + React Query, styled with inline styles off app/tokens.ts. Match the surrounding code.\n- NEVER run `npm run build` in forge-control-web without first checking `pgrep -af \"next/dist/bin/next build\"` — two concurrent builds destroy .next and take the live site down. This happened on 2026-08-25. Do not pkill a sibling build; wait for it.\n- Do not restart forge-control or forge-executor from inside a run; a guard blocks it. Use /opt/ai-os/scripts/safe-restart.sh.\n- Verify in a real browser and screenshot to /opt/ai-os/uploads/$FORGE_RUN_ID/, then Read the file back. A typecheck is not evidence that a surface renders — a real bug this week was calendar blocks that were present, correctly placed and invisible.\n- Migrations: db/migrations/, next free number is 0050.\n- Ask Konrad before any irreversible vault reorganisation.","repo":"ai-os","workspace_dir":"/opt/ai-os/workspace/projects/d6371f2d-a4e8-4e50-95c9-781ca9da3a2e","base_branch":"main","work_branch":"project/d6371f2d","status":"active","metadata":{"origin_chat_id":"3f03be16-436f-4adc-ba7f-90e661a7cda7"},"created_at":"2026-08-25 01:15:33.411643+00","updated_at":"2026-08-25 14:35:12.371448+00"}}

EXIT=0
```

### The rows and their projects, read back
```
$ psqlq -c SELECT t.id, t.role, t.status, t.attempt, p.status AS project_status, left(p.name,32) AS project
                  FROM project_tasks t JOIN projects p ON p.id=t.project_id
                 WHERE t.id IN ('f687d7f7-f1c6-46fc-a6cb-a966b50f71aa','67ff2645-6dc3-44eb-8bb7-19949004152f',
                                '161e2155-e601-4b2f-bb4d-0ff3d5af2683','325616b9-ae35-41f4-ba7d-fea7819b6399',
                                'e7684092-8586-41fa-95ea-ddd7955cfa79')
                 ORDER BY project;
                  id                  |   role   | status | attempt | project_status |            project             
--------------------------------------+----------+--------+---------+----------------+--------------------------------
 f687d7f7-f1c6-46fc-a6cb-a966b50f71aa | builder  | done   |       3 | active         | aios-chat-reference-navigation
 161e2155-e601-4b2f-bb4d-0ff3d5af2683 | builder  | done   |       3 | active         | aios-guardrail-hardening
 325616b9-ae35-41f4-ba7d-fea7819b6399 | builder  | done   |       3 | active         | aios-journal-thoughts-stats
 e7684092-8586-41fa-95ea-ddd7955cfa79 | reviewer | failed |       3 | blocked        | aios-sidebar-live-sessions
 67ff2645-6dc3-44eb-8bb7-19949004152f | builder  | done   |       3 | active         | aios-verification-that-bites
(5 rows)

EXIT=0
```
### Did the wedged tasks promote? (60s later)
```
$ psqlq -c SELECT left(p.name,32) AS project, t.status, count(*)
                  FROM project_tasks t JOIN projects p ON p.id=t.project_id
                 WHERE t.project_id IN ('ecacba29-2664-4d8c-89e3-52cae0747941','169903ec-4dd0-4041-a737-eeba3d178d36',
                                        'b167b94e-b335-4767-a3d1-1b43fd72a3dc','d6371f2d-a4e8-4e50-95c9-781ca9da3a2e')
                   AND t.status IN ('pending','ready','running')
                 GROUP BY 1,2 ORDER BY 1,2;
            project             | status  | count 
--------------------------------+---------+-------
 aios-chat-reference-navigation | pending |     4
 aios-chat-reference-navigation | running |     1
 aios-guardrail-hardening       | pending |     1
 aios-guardrail-hardening       | running |     1
 aios-journal-thoughts-stats    | pending |     6
 aios-journal-thoughts-stats    | running |     1
 aios-verification-that-bites   | pending |     2
 aios-verification-that-bites   | running |     1
(8 rows)

EXIT=0
```
APPLY_RC=0

## 6. What is deliberately NOT done

`e7684092` (aios-sidebar-live-sessions r6, **reviewer**) is left untouched, exactly as
the supervisor ruled. Its verdict is NEEDS_FIXES; marking it done would convert a
rejection into a pass and seed no fix chain. The script refuses it unconditionally —
proven above, exit 1. Consuming that verdict means seeding a fix chain, and
`createFixChain` claims reviewer.round+1 AND +2, so it is not this runbook's to place.
