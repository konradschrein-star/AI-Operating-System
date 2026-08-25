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
