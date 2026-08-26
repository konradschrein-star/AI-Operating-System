# Deploy record — aios-ops-inventory-red

Project: `aios-ops-inventory-red` (9da25ef0-63fe-4990-9828-d70e21da5b31)
Deploy performed: 2026-08-26 ~03:46-03:48 CEST (2026-08-26 ~01:46-01:48 UTC), from live checkout `/opt/forge-ai-os`.

## 1. Merge to main

Round-1 reviewer verdict on branch `project/9da25ef0` was PASS. At the start of this
deploy task `main` at `/opt/forge-ai-os` was still at `c5d0b3b` — the branch had **not**
yet been merged (confirmed via `git reflog show main`, no `merge project/9da25ef0` entry;
confirmed via `git log main --oneline` not containing `592f18a`). The project's task graph
has no separate integration task ("small graph: one builder, one reviewer, one deploy"),
so the merge was performed as step 1 of this deploy task, directly on the live checkout:

```
$ git -C /opt/forge-ai-os merge --no-ff project/9da25ef0 -m "merge: aios-ops-inventory-red — register assert-merge-scope.sh and recover-stuck-task.sh in install-symlinks FILES array (round1 review PASS)"
Merge made by the 'ort' strategy.
 PLAN.md                         | 130 +++++++++++++++++++++-------------------
 scripts/ops/install-symlinks.sh |   2 +
 2 files changed, 71 insertions(+), 61 deletions(-)
```

**Merge commit SHA on main:** `20fb287e96117c26f70319970ad433698568e873`

No conflicts — the branch diff against `main` (`git diff main...project/9da25ef0 --stat`)
touched only `PLAN.md` and `scripts/ops/install-symlinks.sh`.

## 2. Symlink installer

```
$ bash scripts/ops/install-symlinks.sh
...
ok (already linked): /opt/ai-os/scripts/rebuild-web.sh
linked: /opt/ai-os/scripts/assert-merge-scope.sh -> /opt/forge-ai-os/scripts/ops/assert-merge-scope.sh
linked: /opt/ai-os/scripts/recover-stuck-task.sh -> /opt/forge-ai-os/scripts/ops/recover-stuck-task.sh
ok (already linked): /opt/ai-os/scripts/goal-engine-v2.json
...
```

All 29 managed files reported `ok (already linked)` except the two new entries, which
reported `linked:` — first-time installation, as expected.

## 3. Live symlink verification

```
$ ls -la /opt/ai-os/scripts/assert-merge-scope.sh /opt/ai-os/scripts/recover-stuck-task.sh
lrwxrwxrwx 1 root root 50 Aug 26 03:46 /opt/ai-os/scripts/assert-merge-scope.sh -> /opt/forge-ai-os/scripts/ops/assert-merge-scope.sh
lrwxrwxrwx 1 root root 50 Aug 26 03:46 /opt/ai-os/scripts/recover-stuck-task.sh -> /opt/forge-ai-os/scripts/ops/recover-stuck-task.sh

$ readlink -f /opt/ai-os/scripts/assert-merge-scope.sh
/opt/forge-ai-os/scripts/ops/assert-merge-scope.sh
$ readlink -f /opt/ai-os/scripts/recover-stuck-task.sh
/opt/forge-ai-os/scripts/ops/recover-stuck-task.sh
```

Both resolve. Target permissions (the mode that matters — a symlink's own mode is
always `777`/`rwxrwxrwx` and irrelevant):

```
$ stat -c '%a %n' /opt/forge-ai-os/scripts/ops/assert-merge-scope.sh /opt/forge-ai-os/scripts/ops/recover-stuck-task.sh /opt/forge-ai-os/scripts/ops/stalled-projects.sh
755 /opt/forge-ai-os/scripts/ops/assert-merge-scope.sh
755 /opt/forge-ai-os/scripts/ops/recover-stuck-task.sh
755 /opt/forge-ai-os/scripts/ops/stalled-projects.sh
```

755, matching the existing pattern (`stalled-projects.sh`) and confirming the builder's
mode analysis (neither script needed `RESTRICTED_MODE_FILES` or `EXEC_MODE_FILES`).

## 4. Live gate status

```
$ bash scripts/checks/check-ops-scripts.sh ; echo exit=$?
-- presence + permissions
-- shell syntax
-- python syntax
-- install-symlinks.sh FILES list matches what's on disk
-- safe-restart.sh guard logic
-- hooks.settings.json is the canonical registration and matches the hooks on disk
PASS: scripts/ops/ is complete, modes are correct, syntax is clean, installer is in sync, safe-restart.sh guards are present, hook registration matches disk
exit=0
```

Live `main` gate is green. This clears the ~11h red on `gates-808.sh:381`
(`check-ops-scripts.sh`) that every lane's gate run was inheriting.

## Operational observations

- `install-symlinks.sh` correctly refused nothing and did not need its worktree-refusal
  guard touched — it ran because it was invoked from `/opt/forge-ai-os`, a real checkout,
  not a project worktree.
- `recover-stuck-task.sh` — a recovery tool builders/operators reach for when a task is
  stuck — is now actually reachable at `/opt/ai-os/scripts/recover-stuck-task.sh`, closing
  the "real defect" half of the brief, not just the gate-noise half.
- Pre-existing, unrelated dirt on the live checkout: `docs/plan/artifacts/phase300/backfill.log`
  had one uncommitted line appended (an automation-written artifact log). It does not
  intersect this change's write-set and was left untouched.
- No sibling-contention gate reruns were needed for this deploy — only
  `check-ops-scripts.sh` was in scope per the brief, and it passed clean on the first run.

## Write-set

This deploy task's declared write-set is `deploy/aios-ops-inventory-red.md`. The merge
in step 1 also updated `main`'s tip via the pre-existing branch commit `592f18a`
(`scripts/ops/install-symlinks.sh`, already reviewed and merged in step 1) plus the merge
commit itself — no new source file was authored by this deploy task beyond this record.

---

# Round 2 — what the next deploy must do and verify

Round 2 answers the round-1 review's findings 2 and 3. The lane cannot verify
the install half (`install-symlinks.sh` refuses to run from a worktree, by
design), so that half is listed here for the deploy task.

## What changed

| commit | file | why |
|---|---|---|
| `e3f9eb8` | `scripts/checks/check-ops-scripts.sh` | finding 2: `EXPECTED_EXEC` gains the 5 unasserted scripts; finding 3: reverse-direction inventory assertion |
| `e3f9eb8` | `scripts/ops/install-symlinks.sh` | `FILES` gains the 3 migrated scripts; `EXEC_MODE_FILES` gains the 2 cron-driven ones |
| `e3f9eb8` | `scripts/ops/{next-build-drift-watchdog,usage-ceiling-throttle,verify-gemini-dispatch}.sh` | migrated from `/opt/ai-os/scripts`, byte-identical |
| `e3f9eb8` | `scripts/ops/README.md` | Layout table gains the 5 previously undocumented entries |
| `b1f88c0` | `scripts/checks/prove-ops-inventory-bites.sh` | the mutation control, 5 verdicts |
| `8926c41` | `scripts/checks/check-ops-scripts.sh` | an unlistable `TARGET_DIR` must SKIP, not silently PASS |

## Deploy steps

1. Merge, then from `/opt/forge-ai-os` (NOT a worktree):

       bash scripts/ops/install-symlinks.sh

   Expect three `backing up real file before symlinking:` lines — for
   `next-build-drift-watchdog.sh`, `usage-ceiling-throttle.sh` and
   `verify-gemini-dispatch.sh`. Those are the real files being replaced by
   symlinks; the originals land in `/opt/ai-os/backups/scripts/<f>.<stamp>-preinstall`.
   Every other entry should say `ok (already linked)`.

2. Verify all three now resolve into the repo:

       ls -la /opt/ai-os/scripts/ | grep -E 'next-build|usage-ceiling|verify-gemini'

   Each must be a symlink into `/opt/forge-ai-os/scripts/ops/`.

3. Confirm the two cron jobs still resolve through the symlink — the crontab
   lines are unchanged (`*/3` and `*/2` against `/opt/ai-os/scripts/...`) and end
   in `>/dev/null 2>&1`, so a broken path would be **silent**. Do not skip this:

       bash -n /opt/ai-os/scripts/next-build-drift-watchdog.sh && echo ok
       bash -n /opt/ai-os/scripts/usage-ceiling-throttle.sh && echo ok
       test -x /opt/ai-os/scripts/usage-ceiling-throttle.sh && echo executable

   `usage-ceiling-throttle.sh` touches `/var/tmp/usage-throttle.stamp` on every
   run, so `stat -c %y` on it a few minutes after the install is the liveness
   proof that the cron still fires through the new symlink.

4. `bash scripts/checks/check-ops-scripts.sh` → `PASS`, exit 0, and the line
   `-- nothing unmanaged is living in /opt/ai-os/scripts (reverse direction)`
   present with no `FAIL:` after it.

## One race worth naming

Between `rm -f "$dst"` and `ln -s` in `install-symlinks.sh` the cron path does
not exist for a few milliseconds. If cron fires in that window, that one
invocation is skipped — `*/2` and `*/3` schedules recover on the next tick, and
neither watchdog carries state that a skipped run corrupts. Not worth a lock;
worth knowing if the install log looks odd.

## Still not fixed, and not this project's to fix

`/opt/forge-ai-os` remains dirty on `docs/plan/artifacts/phase300/backfill.log`
(round-1 finding 1). `forge-control`'s `chat-linkage.ts:405` appends to that
git-tracked path at runtime, so every chat-originated project re-dirties it.
Escalated as reminders `d246123a` (round 1) and `d663bcc5` (round 2); both
unanswered. Do not revert the line — `plan-300.md`'s rollback command consumes
it. The deploy task should expect this path in `git status` and attribute it.
