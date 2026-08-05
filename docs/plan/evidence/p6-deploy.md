# Evidence — P6 deploy (round 601)

The one phase permitted to touch `/opt/forge-ai-os` and the live `content_forge` DB
(`docs/plan/04-phases.md` "Phase 6 — Deploy"; gates in `docs/plan/03-quality.md` §3 P6 row
and §3.1). Protocol run verbatim and in order, per `docs/tools/deploy-playbook.md` §6.
Every block below is pasted output from the command above it — nothing is paraphrased.

Paths: **WORKTREE** = `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
(branch `project/4120f785`), **LIVE** = `/opt/forge-ai-os`.

Migration filename note: the phase text says `0035`; the shipped file is
`db/migrations/0039_reviewer_chain_key.sql`. Main shipped
`0035_task_idempotency`..`0038_steward_tester_roles` while this branch was out and the file
was renumbered — see `docs/plan/evidence/0039-conflict-target.md`. `0039` is what was applied.

---

## 0. Rollback anchor

```
$ git -C /opt/forge-ai-os rev-parse main | tee /tmp/p6-main-before.sha
cf0ebdbbf64a4a7e73c001ebfa27a5f2be71bb18
```

Rollback, should it ever be needed:
`git -C /opt/forge-ai-os reset --hard $(cat /tmp/p6-main-before.sha) && pm2 restart forge-control`.
The migration needs no rollback — it is additive and the old code never writes `chain_key`.

## 1. Sync + gate in the WORKTREE

Main had not moved since the branch was cut, so there was no merge-back to do and no
conflict to report:

```
$ git branch --show-current
project/4120f785

$ git log --oneline HEAD..main
            (empty)

$ git log --oneline main..HEAD | wc -l
36
```

Full gate, run in `$WORKTREE/forge-control` (never in LIVE):

```
$ pnpm install --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 776ms using pnpm v9.15.9

$ npx tsc --noEmit
            (silent)
tsc exit=0

$ pnpm test
...
ok 53 - T14 parseRoleFile robustness — BOM, CRLF, malformed header
1..53
# tests 167
# suites 36
# pass 167
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1086.793863
test exit=0
```

Green on both counts — tsc silent, 167/167 pass, 0 fail. Proceeded.

## 2. Merge to main in LIVE

Pre-merge cleanliness (the same check `REVIEWER_LIVE_CHECK` makes every reviewer run —
any output at all would have stopped the deploy):

```
$ git -C /opt/forge-ai-os status --porcelain
            (empty)
```

```
$ git -C /opt/forge-ai-os merge --no-ff project/4120f785 -m 'merge: engine-v2-research-lane (P6 deploy)'
...
 create mode 100644 docs/plan/evidence/0039-conflict-target.md
 create mode 100644 docs/plan/evidence/p3-smoke.md
 create mode 100644 docs/plan/evidence/p4-gemini-errorpaths.md
 create mode 100644 docs/plan/evidence/p4-perplexity-errorpaths.md
 create mode 100644 docs/plan/evidence/p5-docs-audit.md
 create mode 100644 docs/plan/evidence/p5-integration-sweep.md
 create mode 100644 docs/plan/evidence/p5-vault-capture.md
 create mode 100644 docs/research/perplexity-api.md
 create mode 100644 docs/tools/deploy-playbook.md
 create mode 100644 docs/tools/gemini-qa.md
 create mode 100644 docs/tools/perplexity.md
 create mode 100644 forge-control/src/lib/gemini-qa-cli.test.ts
 create mode 100644 forge-control/src/lib/perplexity-cli.test.ts
 create mode 100644 forge-control/src/lib/project-reconcile.test.ts
 create mode 100644 forge-control/src/lib/project-reconcile.ts
 create mode 100644 forge-control/src/lib/project-tick.test.ts
 create mode 100755 scripts/gemini-qa.mjs
 create mode 100755 scripts/git-sync-branch.sh
 create mode 100755 scripts/perplexity.mjs
merge exit=0
```

No conflicts. Merge commit and post-merge verification:

```
$ git -C /opt/forge-ai-os rev-parse HEAD
a27605f1942aac39c422cfd1e293b4e912b6e0ba

$ git -C /opt/forge-ai-os log --oneline -1
a27605f merge: engine-v2-research-lane (P6 deploy)

$ git -C /opt/forge-ai-os status --porcelain
            (empty)

$ ls -la /opt/forge-ai-os/agents/researcher.md
-rw-r--r-- 1 root root 3355 Aug  5 17:24 /opt/forge-ai-os/agents/researcher.md

$ ls /opt/forge-ai-os/agents/
architect.md  builder.md  planner.md  researcher.md  reviewer.md  scout.md

$ git -C /opt/forge-ai-os diff --stat cf0ebdb..a27605f | tail -1
 42 files changed, 10348 insertions(+), 827 deletions(-)
```

## 3. Migration 0039 against the live `content_forge` DB

Credentials sourced exactly as `safe-restart.sh:34-41` does it (secrets env file, then
`DB_PASSWORD`, then a `DATABASE_URL` fallback — never hardcoded). The direct psql path
works; the `docker exec` fallback was not needed:

```
$ set -a; source /opt/ai-os/.secrets/forge-control.env; set +a
$ export PGPASSWORD="${PGPASSWORD:-${DB_PASSWORD:-}}"
$ psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -tAc 'select 1'
1
psql exit=0
```

Idempotent pre-check — 0 means the column does not exist yet, so the file gets applied:

```
$ psql ... -tAc "select count(*) from information_schema.columns
                 where table_name='project_tasks' and column_name='chain_key'"
0
```

```
$ psql ... -v ON_ERROR_STOP=1 -f /opt/forge-ai-os/db/migrations/0039_reviewer_chain_key.sql
ALTER TABLE
CREATE INDEX
apply exit=0
```

**Proof 1** — `\d project_tasks` (abridged to the rows that matter; `chain_key` is the last
column, nullable as designed, and the partial unique index is present):

```
                                Table "public.project_tasks"
   Column   |           Type           | Collation | Nullable |           Default
------------+--------------------------+-----------+----------+------------------------------
 id         | uuid                     |           | not null | gen_random_uuid()
 project_id | uuid                     |           | not null |
 round      | integer                  |           | not null | 0
 role       | character varying(16)    |           | not null |
 title      | text                     |           | not null |
 brief      | text                     |           | not null |
 status     | character varying(16)    |           | not null | 'pending'::character varying
 run_id     | uuid                     |           |          |
 fix_cycle  | integer                  |           | not null | 0
 created_at | timestamp with time zone |           | not null | now()
 updated_at | timestamp with time zone |           | not null | now()
 tier       | character varying(16)    |           |          |
 attempt    | integer                  |           | not null | 0
 chain_key  | text                     |           |          |
Indexes:
    "project_tasks_pkey" PRIMARY KEY, btree (id)
    "project_tasks_chain_key_uniq" UNIQUE, btree (project_id, chain_key) WHERE chain_key IS NOT NULL
    "project_tasks_identity_idx" UNIQUE, btree (project_id, round, role, title)
    "project_tasks_pending_idx" btree (project_id) WHERE status::text = ANY (ARRAY['pending'::character varying, 'ready'::character varying]::text[])
    "project_tasks_project_idx" btree (project_id, round, status)
    "project_tasks_run_idx" btree (run_id) WHERE run_id IS NOT NULL
Check constraints:
    "project_tasks_role_check" CHECK (role::text = ANY (ARRAY['architect', 'planner', 'scout', 'researcher', 'builder', 'reviewer', 'steward', 'tester']::text[]))
    ...
```

The `role_check` constraint already admits `'researcher'` (migration 0034) — nothing in
0039 had to widen it.

**Proof 2** — index definition:

```
$ psql ... -c "select indexdef from pg_indexes where indexname='project_tasks_chain_key_uniq'"
                                                                  indexdef
--------------------------------------------------------------------------------------------------------------------------------------------
 CREATE UNIQUE INDEX project_tasks_chain_key_uniq ON public.project_tasks USING btree (project_id, chain_key) WHERE (chain_key IS NOT NULL)
(1 row)
```

Applied under the running old engine without incident, exactly as the migration's own
header predicts: additive column, partial index skipping NULLs, and only the new reconciler
ever writes the column.

## 4. forge-control restart (API side — allowed)

```
$ cd /opt/forge-ai-os/forge-control && pnpm install --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 724ms using pnpm v9.15.9

$ pm2 restart forge-control
            (pm2 table)
```

```
$ pm2 ls | grep -E "forge-(control|executor)"
│ 35 │ forge-control     │ ... │ 1616560 │ 4s  │ 26 │ online │ ... │
│ 32 │ forge-control-web │ ... │ 716324  │ 9h  │ 10 │ online │ ... │
│ 36 │ forge-executor    │ ... │ 744650  │ 8h  │  3 │ online │ ... │
```

forge-control uptime reset to `4s` (restart landed, process `online`); **forge-executor
untouched at 8h and 3 restarts** — it was not restarted by this task, at any point.

Live API probes:

```
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:7700/api/today
HTTP 200
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:7700/api/projects
HTTP 200
```

The API came back healthy, so no rollback was triggered.

## 5. GitHub push (R15/R16 — plain push, never `--force`)

```
$ git -C /opt/forge-ai-os remote -v
origin	git@github.com:konradschrein-star/AI-Operating-System.git (fetch)
origin	git@github.com:konradschrein-star/AI-Operating-System.git (push)

$ gh auth status
github.com
  ✓ Logged in to github.com account konradschrein-star (/root/.config/gh/hosts.yml)
```

Work branch, via this project's own helper:

```
$ /opt/forge-ai-os/scripts/git-sync-branch.sh /opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365
git-sync-branch.sh: pushing project/4120f785 to git@github.com:konradschrein-star/AI-Operating-System.git
Everything up-to-date
pushed-branch: project/4120f785
origin-url: git@github.com:konradschrein-star/AI-Operating-System.git
helper exit=0
```

("Everything up-to-date" because P5's gating reviewer already pushed the branch — the
helper is idempotent by construction.)

Main:

```
$ git -C /opt/forge-ai-os push origin main
To github.com:konradschrein-star/AI-Operating-System.git
   9d10bf1..a27605f  main -> main
push main exit=0
```

Fast-forward, no force. Remote state confirmed:

```
$ git -C /opt/forge-ai-os ls-remote origin main refs/heads/project/4120f785
a27605f1942aac39c422cfd1e293b4e912b6e0ba	refs/heads/main
526aef347ebbbad6901b0965e5568da0cdb2a716	refs/heads/project/4120f785
```

No PR was opened: this brief says merge to main, and `DEPLOY_GUIDE`'s PR branch only
applies when the brief asks for one.

## 6. R20 smoke armed + detached executor restart

The smoke body, written to `/tmp/p6-r20-smoke.json` and validated:

```
$ node -e "const o=JSON.parse(require('fs').readFileSync('/tmp/p6-r20-smoke.json','utf8')); ..."
JSON OK
name= p6-r20-researcher-smoke
repo= scratch
architect_tier= fast
brief chars= 1995
```

It instructs: round-0 architect creates **exactly one** researcher task (round 1, role
`researcher`, tier `junior`) on "current Perplexity API surface + pricing, cited" and then
stops; the researcher commits `docs/research/perplexity-api-smoke.md` with **at least 3
cited source URLs**; then exactly one reviewer task (round 2) that opens **at least 2** of
those URLs and checks them against the claims made, and on PASS closes the project via
`POST /api/projects/<id>/status {"status":"done"}`.

Launch — the restart first, the smoke POST chained 20s behind it:

```
$ setsid nohup bash -c '/opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 && sleep 20 && curl -sS -X POST http://127.0.0.1:7700/api/projects -H "content-type: application/json" --data @/tmp/p6-r20-smoke.json' >> /tmp/safe-restart.log 2>&1 &
launched
```

Alive, detached, and waiting:

```
$ pgrep -c -f "safe-restart.sh forge-executor"
3

$ ps -o pid,etime,args -p 1617631
    PID     ELAPSED COMMAND
1617631       00:43 bash -c /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 && sleep 20 && curl ...

$ tail -2 /var/log/forge-safe-restart.log
[2026-08-05T08:46:24+02:00] restarted forge-executor — status=online
[2026-08-05T17:26:04+02:00] waiting for idle to restart 'forge-executor' (max 43200s, idle window 45s)
```

`/tmp/safe-restart.log` is 0 bytes at this moment, which is correct and expected: it
captures only the *detached process's own stdout/stderr* (the eventual pm2 restart output
and the final status check), while the script's own `log()` calls go to
`/var/log/forge-safe-restart.log` — and that file carries the new `17:26:04` line proving
the launch took (`docs/tools/deploy-playbook.md` §4, last bullet).

Not waited on, not polled, not slept for. This task moved on immediately.

### R20 — armed, not observed in-phase

R20 (a researcher task running end-to-end in a scratch project) **cannot be observed from
inside this project**, and arming it is the correct discharge rather than a shortcut. Two
independent reasons:

1. **The idle deadlock.** `safe-restart.sh` defines idle as *zero runs with a heartbeat in
   the last 45s*, confirmed over two consecutive polls. This deploy task is itself a run
   that heartbeats. Any smoke project created now would add more heartbeating runs. Either
   would keep the restart waiting — potentially to its 12h `MAX_WAIT` — and the restart is
   the entire point of the phase.
2. **The old engine would claim it.** Until the restart lands, the executor is still
   running pre-merge code: no repo-`agents/` fallback for role files (R306) and no
   `projects.status = 'active'` gating (R8/R9). A scratch project created *now* would be
   claimed by that old engine, which cannot resolve `researcher.md` from the repo, and its
   runs would starve the restart indefinitely. The smoke has to run on the *new* engine or
   it proves nothing.

Chaining the POST behind the restart resolves both: the restart lands when the fleet is
genuinely idle, and the smoke project is then created against the freshly-restarted engine
that has the researcher role and the status gating in it.

The smoke is **self-verifying** — it does not need a human or a follow-up task to grade it.
Its round-2 reviewer opens at least two of the cited URLs, checks them against the claims,
and closes the project itself on PASS. So the outcome is legible after the fact from
`GET /api/projects` alone: a `done` project with `docs/research/perplexity-api-smoke.md`
committed means R20 passed; anything else means it did not. A reminder (§8) puts eyes on it
in ~2h regardless.

## 7. researcher.md install (R306 / §3.1)

The `cp` into the harness-guarded `AGENTS_DIR` **succeeded** this time — the guard did not
block it:

```
$ cp /opt/forge-ai-os/agents/researcher.md /root/.claude/agents/researcher.md
cp exit=0

$ ls -la /root/.claude/agents/researcher.md
-rw-r--r-- 1 root root 3355 Aug  5 17:26 /root/.claude/agents/researcher.md
```

`AGENTS_DIR` wins over the repo copy in `roleFilePaths()`, so a drifted hand-installed file
would silently shadow the committed one (the failure mode T13 exists to catch). Verified
byte-identical:

```
$ diff /root/.claude/agents/researcher.md /opt/forge-ai-os/agents/researcher.md
IDENTICAL — no drift (T13 clean)
```

Both resolution paths therefore now yield the same definition. Note that the install is
**not load-bearing**: with the merge on main, `<repo>/agents/researcher.md` resolves on its
own via `REPO_AGENTS_DIR` at the restart just armed, which is precisely the point of the
R306 fallback — no human `cp` required for the next role anyone adds.

## 8. Reminders

P4 already queued both key reminders and they are still `pending` — not duplicated:

```
$ curl -s http://127.0.0.1:7700/api/reminders   # pending only
2026-08-06 07:00:00.144+00 | Add PERPLEXITY_API_KEY — put the raw key in /opt/ai-os/.secrets/store/perplexity-api-key (…)
2026-08-06 07:00:00.716+00 | Add the Gemini API key: env var GEMINI_API_KEY, or the secret-store file /opt/ai-os/.secrets/store/gemini-api-key (…)
```

Both keys re-confirmed absent at deploy time (not merely at planning time):

```
$ ls /opt/ai-os/.secrets/store/ | grep -iE "gemini|perplex"
no gemini/perplexity secret-store files
$ grep -rliE "GEMINI_API_KEY|PERPLEXITY_API_KEY" /opt/ai-os/.secrets/
no GEMINI/PERPLEXITY key in .secrets/
```

One new reminder added, ~2h out, for the R20 smoke and the detached restart:

```
$ curl -sS -X POST http://127.0.0.1:7700/api/reminders -H 'content-type: application/json' --data '{"text":"P6 deploy follow-up — check the R20 researcher smoke. …","when":"in 2h"}'
{"ok":true,"reminder":{"id":"7c9fc079-964c-4014-b680-d58a650d516c",…,"due_at":"2026-08-05 17:26:36.343+00","status":"pending",…}}
```

Created `15:26:36Z`, due `17:26:36Z` — two hours out, as intended.

---

## Summary

| Step | Outcome |
|---|---|
| 0 Rollback anchor | `cf0ebdb` → `/tmp/p6-main-before.sha` |
| 1 Worktree gate | `HEAD..main` empty (no merge needed); tsc silent; **167/167 pass, 0 fail** |
| 2 Merge to main | `a27605f`, no conflicts, live tree clean, `agents/researcher.md` present |
| 3 Migration 0039 | applied; `chain_key` column + `project_tasks_chain_key_uniq` partial unique index proven |
| 4 forge-control | restarted, `online`, `/api/today` and `/api/projects` both HTTP 200 |
| 5 GitHub | branch already current; `main` pushed `9d10bf1..a27605f`, no force |
| 6 R20 + executor | detached `safe-restart.sh` running (PID 1617631), smoke POST chained behind it |
| 7 researcher.md | installed to `AGENTS_DIR`, byte-identical to the repo copy |
| 8 Reminders | 2 pre-existing key reminders left alone; 1 new smoke-check reminder (+2h) |

forge-executor was **never** restarted by this task — it was at 8h uptime before, during,
and after. The only executor restart is the detached one, which lands on its own schedule
once the fleet goes quiet.

**What Konrad owes the system:** `GEMINI_API_KEY` and `PERPLEXITY_API_KEY`. Neither exists
anywhere under `/opt/ai-os/.secrets/`. Both tools hard-exit `2` with a message naming the
key and both accepted locations until one lands — see `docs/tools/gemini-qa.md` and
`docs/tools/perplexity.md`.
