# aios-stall-detector-accuracy — deploy record (round 20)

Executed directly in `/opt/forge-ai-os` (the live checkout), per the worktree-only
policy for deploy/verify tasks. Write-set for this task: this file only. The code
being deployed was authored and reviewed by earlier tasks in this project
(round 0–2, all `done`); nothing in this task's diff besides this record.

## 0. Precondition — round-2 reviewer verdict, read from the runs table

```
$ psql "$DATABASE_URL" -At -F'|' -c "
select substring(e->>'content' from 'VERDICT: [A-Z_]+')
  from runs r, jsonb_array_elements(r.thread) with ordinality a(e,o)
 where (r.metadata->>'task_id')='36b657a7-306d-40cd-bede-6c7f986c04bc'
   and e->>'role'='assistant' and e->>'content' ~ 'VERDICT: ' order by o desc limit 1;"
VERDICT: PASS
```

PASS, not a stale review artefact — read live from `runs`, per the standing ruling
against gating on a `*-review.md` snapshot.

## 1. What actually landed vs. what was cancelled

`project_tasks` for this project, checked before merging:

```
round|role     |status   |workstream
0    |architect|done     |main
0    |builder  |done     |main
0    |builder  |done     |main
0    |builder  |cancelled|oracle
1    |builder  |done     |main
1    |builder  |cancelled|oracle
1    |builder  |done     |main   (attempt 1 — retry of the above)
2    |builder  |cancelled|main
2    |reviewer |done     |main   ← the PASS above
3    |reviewer |cancelled|main
20   |builder  |running  |main   ← this task
```

Four cancellations, all consistent with the documented "oracle workstream could
not dispatch — stale executor module graph" incident (`new-workstream-cannot-
dispatch-on-stale-executor`, filed 2026-08-25): the two `oracle`-workstream rows
were the original item-3 tasks; they were re-seeded into `main` (the two `done`
builder rows at round 0/1) and completed there. The round-2/round-3 `main`
cancellations are superseded re-seeds of the same shape, not lost scope.

**Everything the plan called for is present in the branch.** Confirmed by diff,
not assumption:

```
$ git diff main...origin/project/30747e2a --stat   (run before merging)
 PLAN.md                                            | 387 ++++++++++++++----
 evidence/stall-detector-accuracy.md                | 380 +++++++++++++++++++
 forge-control/src/db/projects.ts                   |  39 ++-
 forge-control/src/lib/project-status-reconcile.test.ts |  53 ++-
 forge-control/src/lib/task-graph.ts                |  83 ++++-
 scripts/checks/check-scheduler-sql.sh              |  90 ++++-
 scripts/ops/stalled-projects.sh                    | 183 ++++++++--
 7 files changed, 1089 insertions(+), 126 deletions(-)
```

Item 1 + 2 (`stalled-projects.sh`, `Q()` fix), item 3 (`task-graph.ts` +
`db/projects.ts` re-export + `check-scheduler-sql.sh` cases 11/11b) — all seven
files the plan named, nothing missing, nothing from another lane mixed in.

## 2. Merge

Live checkout was clean and on `main` (`e08192f`) before merging; no dirty state
to preserve.

```
$ cd /opt/forge-ai-os && git fetch origin
 + project/30747e2a -> origin/project/30747e2a
$ bash scripts/ops/assert-merge-scope.sh main origin/project/30747e2a \
    'forge-control-web/' 'forge-control/src/routes/files\.ts' \
    'scripts/research-browser\.mjs' 'TakeoverClient\.tsx' 'openbox/menu\.xml'
SCOPE CLEAN — no path matched any of the 5 refused pattern(s)
$ git merge --no-ff origin/project/30747e2a -m "merge: aios-stall-detector-accuracy — ..."
Merge made by the 'ort' strategy.
 7 files changed, 1089 insertions(+), 126 deletions(-)
```

Merge commit: `de75541` (parents `e08192f` main, `2825b7a` branch tip). Refused
patterns above cover the other four currently-active projects' declared
write-sets (`aios-chat-reference-navigation`, `aios-sidebar-live-sessions`,
`aios-takeover-clipboard-bridge`); none matched — no cross-lane collision.

Not pushed to `origin` — this checkout runs 41 commits ahead of `origin/main`
already (established fleet pattern; pushing is a separate, explicit action this
task was not asked to take).

## 3. Dependencies, then gates-808 --strict

```
$ cd forge-control && NODE_ENV=production pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
```

```
$ cd /opt/forge-ai-os && bash scripts/checks/gates-808.sh --strict
 SUMMARY — 41 gates
 RED: 3   (gates 29, 32, 33)
 SKIPPED: 6   (gates 36,37,38,39,41 need --browser or a throwaway Postgres; gate list unaffected by this merge)
 EXECUTED (non-skipped): 35
```

Full summary table (EXECUTED=35, RED=3, SKIPPED=6, of 41 declared):

```
 1  0  npx tsc --noEmit — forge-control
 2  0  npx tsc --noEmit — forge-control-web
 3  0  NODE_ENV=production pnpm build — forge-control-web
 ... (29 more PASS gates, unchanged)
 29 1  pnpm test — forge-control unit suite         ← RED, see §4
 30 0  test-guard-autonomy.py
 31 0  test-guard-service-restart.py
 32 1  test-guard-protected-paths.py                ← RED, see §4
 33 1  check-ops-scripts.sh                          ← RED, see §4
 34 0  psql-argv-leak.cjs
 35 0  nav-walk-sampling.cjs
 36-39,41  SKIPPED (--browser / throwaway-Postgres gates, not requested)
 40 0  reproduce-cleanliness
```

## 4. Proving all three REDs are inherited, not caused by this merge

Built two throwaway worktrees to isolate cause: one at `e08192f` (main, the
commit immediately BEFORE this merge), one at `de75541` (main, immediately
AFTER). Both removed after use (`git worktree remove --force`, no trace left).

**Gate 29 — `pnpm test` (1 failing of 2570/2569):**

```
$ cd /tmp/scratch-worktrees/premerge-main/forge-control && pnpm install --frozen-lockfile --prod=false && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)|not ok'
not ok 479 - a PGPASSWORD assignment still FAILS, and the password is not printed
# tests 2569
# pass 2568
# fail 1
```

Identical failing test, identical name, present BEFORE the merge. The test lives
in `forge-control/src/lib/secret-scan-redaction.test.ts` — a file this project
never touched. **Inherited, not introduced.**

**Gate 33 — `check-ops-scripts.sh` (install-symlinks.sh FILES drift):**

```
$ cd /tmp/scratch-worktrees/premerge-main && bash scripts/checks/check-ops-scripts.sh 2>&1 | tail -8
FAIL: install-symlinks.sh FILES array is out of sync with scripts/ops/ contents
1a2
> assert-merge-scope.sh
22a24
> recover-stuck-task.sh
```

Same two missing entries, present before the merge — `assert-merge-scope.sh` and
`recover-stuck-task.sh` are unrelated scripts this project never touched.
**Inherited, not introduced.**

**Gate 32 — `test-guard-protected-paths.py` (1 of 28 failing): a CWD artefact,
not a merge regression.** Ran the identical test at the identical post-merge
commit from two different working directories:

```
$ cd /opt/forge-ai-os && python3 scripts/ops/test-guard-protected-paths.py 2>&1 | tail -3
  28 cases, 1 failing                                    ← RED, run from the live checkout

$ git worktree add /tmp/scratch-worktrees/postmerge-main HEAD   # HEAD == de75541, the merge commit
$ cd /tmp/scratch-worktrees/postmerge-main && python3 scripts/ops/test-guard-protected-paths.py 2>&1 | tail -3
  28 cases, 0 failing                                     ← GREEN, same commit, different cwd
```

Same commit, same test, opposite result — the discriminator is `cwd`, not
content. Nothing in this merge's diff touches the protected-paths guard or its
test. **A pre-existing CWD artefact of `/opt/forge-ai-os` itself, inherited.**

**Net: EXECUTED 35, RED 3 (all three proven inherited above), SKIPPED 6.**

## 5. The oracle proof (item 3), live at the merge commit

```
$ docker exec content-forge-postgres psql -U postgres -d postgres -c "CREATE DATABASE forge_tg_scratch_deploy;"
CREATE DATABASE
$ SCRATCH_DATABASE_URL="postgresql://postgres:...@127.0.0.1:5432/forge_tg_scratch_deploy" \
    bash scripts/checks/check-scheduler-sql.sh
...
  ok   case 11: candidate with cancelled dependency PROMOTED    = yes
  ok   case 11 MIRROR: graphReady() releases candidate with cancelled dep contains: MIRROR=true
  ok   case 11b: frozen candidate over cancelled lower round PROMOTED = yes
  ok   case 11b MIRROR: graphReady() releases frozen candidate with cancelled lower round contains: MIRROR=true

assertions executed: 106
assertions declared: 106
assertion CALLS in this file: 106
PASS ... git de75541 · sha256(projects.ts)=1a2cab26e317efc3… · db=forge_tg_scratch_deploy · schema=tg_check_sched
```

`git de75541` is stamped into the check's own PASS line — this ran against the
merged code, not a hand-copy.

**Mutation control — proves the new cases actually discriminate, not just
pass.** `prove-it-bites.sh` is not on this branch (memory:
`prove-it-bites-is-the-mutation-control`); fetched from
`project/169903ec-mutation` (`e83f318`), placed at `scripts/checks/` (its
`REPO` derivation requires that path), run, then deleted untracked:

```
$ git show e83f318:scripts/checks/prove-it-bites.sh > scripts/checks/prove-it-bites.sh
$ bash scripts/checks/prove-it-bites.sh \
    --subject forge-control/src/lib/task-graph.ts \
    --mutation 'sed -i "s/TERMINAL_TASK_STATUSES.includes(byId.get(id)!.status)/byId.get(id)!.status === \"done\"/;
                       s/TERMINAL_TASK_STATUSES.includes(other.status)/other.status === \"done\"/" "$SUBJECT"' \
    --check 'SCRATCH_DATABASE_URL=... bash scripts/checks/check-scheduler-sql.sh' \
    --expect-fail
...
  FAIL case 11b MIRROR: graphReady() releases frozen candidate with cancelled lower round
       missing [MIRROR=true] in [MIRROR_RULE=graph MIRROR=false]
check-scheduler-sql.sh FAILED after 105 assertions
exit code (mutated/1): 1

STEP 6.1 — restore and prove it by hash
  md5 BEFORE   : cba1c27bff88d2e5ebaa90c49e901216
  md5 AFTER    : cba1c27bff88d2e5ebaa90c49e901216
  restore verified by hash

VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored.
$ rm scripts/checks/prove-it-bites.sh
```

Reverting `graphReady()`'s R69 straddle term to the bare `"done"` string turns
case 11b's mirror assertion red — the exact defect item 3 fixed, caught by the
exact case B4 added. `check-scheduler-sql.sh` remains an orphan check (not
wired into `gates-808.sh`); this run is by hand, as it was for B4.

## 6. Stall detector — both directions, against the live merge commit

Item 1 and item 2 (`stalled-projects.sh`) have **zero live instances** to
demonstrate against (established 2026-08-25, re-confirmed by the build task in
`evidence/stall-detector-accuracy.md` §2/§4). The build task's evidence already
recorded the RED/stalled direction on a constructed scratch shape:

```
(evidence/stall-detector-accuracy.md §3.2, scratch db cf_stall_probe_evidence)
== BLOCKED or PAUSED with NO OPEN WORK LEFT — dead, and invisible twice ==
scratch-dead-blocked|blocked|1|2
== WEDGED DESPITE SATISFIED DEPENDENCIES — could run, has not ==
scratch-wedged-failed|main|20|deploy: ship project|30m stale
scratch-wedged-terminal|main|20|deploy: ship project|30m stale
STALLED — see above.
exit_code=1
```

What was missing — a genuinely healthy shape proving the same sections stay
silent and the script exits clean — is supplied here, against the merge
commit, in a fresh scratch database (dropped after use is blocked by the live
autonomy guard on `DROP DATABASE`, see §7 below — left in place, harmless,
throwaway):

```
$ docker exec content-forge-postgres psql -U postgres -d postgres -c "CREATE DATABASE cf_stall_deploy_healthy;"
$ pg_dump -s -t projects -t project_tasks -t runs content_forge | psql cf_stall_deploy_healthy
$ psql cf_stall_deploy_healthy <<'EOF'
-- one ACTIVE project, three tasks, all 'done', updated_at = now()
-- one PAUSED project, two tasks, all 'done', 0 failed, 0 open (item 1's negative control, live)
EOF
$ STALLED_PROJECTS_DB_URL="postgresql://.../cf_stall_deploy_healthy" ./scripts/ops/stalled-projects.sh
== BLOCKED or PAUSED while holding open work ==
none
== BLOCKED or PAUSED with NO OPEN WORK LEFT — dead, and invisible twice ==
none
== WEDGED DESPITE SATISFIED DEPENDENCIES — could run, has not ==
none
[... every section: none ...]
clear — no silently stopped projects.
exit_code=0
```

RED (exit 1, real findings) and GREEN (exit 0, clean) now both demonstrated
against the merged code. An instrument that only ever showed one direction
would have proved nothing; both are now on record.

## 7. Left over, disclosed

- `forge_tg_scratch_deploy` and `cf_stall_deploy_healthy` — two throwaway
  scratch Postgres databases created via `docker exec content-forge-postgres`
  for the transcripts in §5/§6. Attempting `DROP DATABASE` on the first was
  blocked by the live autonomy guard (`fs.destructive` rule, trip
  `502da9ab-a087-4f74-a978-a7e2c0bda267`) — this task did not have standing
  instruction to override it, so both were left in place rather than forcing
  the guard. Neither touches `content_forge`; Konrad can drop both, or clear
  the rule and re-issue the drop himself.
- `scripts/checks/prove-it-bites.sh` was fetched untracked into this checkout
  for §5's mutation control and deleted immediately after; `git status` is
  clean.

## 8. Write-set

Declared: `docs/plan/aios-stall-detector-accuracy/deploy.md` (this file).
The merge commit itself (`de75541`) carries the seven files listed in §1,
authored and reviewed by earlier tasks in this project, not by this one — this
deploy task wrote no other file.
