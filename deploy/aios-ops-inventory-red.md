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
